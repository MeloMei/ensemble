# Architecture

English | [简体中文](architecture.zh-CN.md)

Ensemble presents local agent sessions, files, terminals, and collaboration in an Electron window. A separate backend owns execution and persisted state. The desktop application, CLI, and MCP clients reach that same backend rather than starting separate schedulers or databases.

## Source layout

| Location | Responsibility |
| --- | --- |
| `src/renderer/` | React interface, chat, collaboration views, CodeMirror editor, xterm terminal, and appearance. |
| `src/preload/index.ts` | Typed `window.workbench` API exposed through Electron's isolated context bridge. |
| `src/main/index.ts` | Electron lifecycle, window, IPC forwarding, native dialogs, external links, and notifications. |
| `src/main/backend-entry.ts` | Entry point for the independent backend process. |
| `src/main/backend-client.ts` | Backend discovery, startup, authenticated commands, and snapshot subscription. |
| `src/main/backend-server.ts` | Loopback HTTP server for management commands, snapshots, and external MCP. |
| `src/main/workbench-service.ts` | Creates the shared services and registers application commands. |
| `src/main/collaboration-core.ts` | Collaboration definitions, runs, permissions, task dispatch, messages, artifacts, and events. |
| `src/main/engine.ts` | Provider sessions, execution attempts, approvals, project execution guards, and provider events. |
| `src/main/store.ts` | SQLite persistence, transactions, migration, and restart recovery. |
| `src/main/providers/` | Native provider adapters, protocol handling, and plugin loading. |
| `src/main/cli.ts` | Local management CLI. |
| `src/main/mcp-server.ts`, `mcp-tool-catalog.ts`, `mcp-stdio.ts`, `collaboration-server.ts` | MCP tool definitions and the external or managed-session transports. |
| `src/shared/` | Types, collaboration schemas, backend contracts, and application identity shared across processes. |

Backend modules are files directly under `src/main/`; there is no separate backend source directory. Tests are colocated with the code they exercise.

## Desktop request path

1. A React component calls `window.workbench`, defined by the shared `WorkbenchAPI` type.
2. The preload bridge invokes a named Electron IPC command. The renderer has no Node integration; the window uses context isolation and Electron sandboxing.
3. The Electron main process checks the sender and forwards service commands through `BackendClient`. Native window operations, dialogs, links, and notifications remain in the Electron process.
4. The backend authenticates the command and calls the handler registered by `createWorkbenchService`.
5. The handler reaches the engine, collaboration core, or a service such as workspace files or runtime settings. State changes feed scoped projections without cloning all conversation history.
6. The backend sends versioned resets and deltas over `/events`. Electron reconstructs the subscribed view and forwards it through IPC. Connection state is separate from cached content; terminals have their own tail/append stream.

The preload bridge exposes the application API rather than arbitrary filesystem or process access. Input validation and execution permissions are enforced in the backend services and provider adapters.

## One backend for desktop, CLI, and MCP

`connectBackend` reads `backend.json`, checks the backend instance through its authenticated health endpoint, and launches a detached process if needed. The desktop application and CLI use this same discovery mechanism and data directory.

`bin/workbench` runs the built CLI using Electron in Node mode. The CLI provides `status`, `connect`, `revoke`, and `stop`. Issuing an MCP identity goes through the same workbench service used by the desktop interface.

External MCP clients use a revocable identity at the backend's `/mcp` endpoint. The stdio bridge forwards calls to that endpoint. The backend authenticates the identity and passes the call to `CollaborationCore`, which checks the identity's policy, run grant, participant permissions, and requested operation.

Managed provider turns receive temporary MCP configuration from `CollaborationServer`. These calls carry a session and attempt identity and reach the same collaboration core. The temporary connection ends with the turn. It does not create another task store or scheduler.

The backend listens on `127.0.0.1`. Management commands use a local management token; external MCP calls use their issued identity tokens. `backend.json` is written with mode `0600`. A loopback address does not grant an MCP participant permission to operate on every run or directory.

## Scheduling and provider execution

`CollaborationCore` stores versioned definitions and a snapshot for each run. Participants have explicit permissions; a role name does not grant authority. Tasks retain their configured participant, inputs, attempts, and result records. The core checks dependencies and configured limits before dispatching managed tasks through `WorkbenchEngine`. The older workflow interface also delegates execution to this collaboration core.

The engine manages native provider sessions and their execution attempts. It normalizes streamed text, tool events, approvals, usage, and native session IDs through the provider adapter contract. The built-in adapters use Codex app-server, Claude Code stream-json, and ACP for OpenCode and DeepSeek Harness. Availability, authentication, resume, and permission behavior depend on the adapter and native runtime. Cursor remains an unavailable placeholder.

Project execution guards coordinate writes within the same worktree. Same-worktree execution is queued, independent non-overlapping directories can run concurrently, and overlapping directories cannot be declared independent. When a managed turn waits for work in the same directory, it releases the active turn; the platform continues the saved native session after the dependent work finishes.

External executors claim tasks and submit results using the recorded attempt ID. The platform can show the messages, artifacts, and events exchanged through it. It cannot infer an external client's internal actions or guarantee that an ordinary MCP client will wake its original conversation automatically.

## Persistence and lifecycle

The backend owns `StateStore`; clients do not open the database. The store keeps the state snapshot, collaboration events, and mutation receipts in `state.sqlite`. Collaboration mutations commit their state, event sequence, and idempotency receipt in one transaction. Stable `requestId` values let clients retry a write without creating a duplicate operation.

The macOS data directory retains the compatibility name `Agent Workbench`. When SQLite has no saved snapshot, the store imports an existing `state.json` and leaves the original file in place. `WORKBENCH_DATA_DIR` selects another data directory for all entry points.

Closing the desktop window disconnects that client while the backend continues running. A stdio bridge exit also closes only its connection. To stop the backend, quit the desktop application before using `bin/workbench stop`; an open desktop client attempts to reconnect and restart it.

On backend restart, unfinished executions are marked interrupted and require explicit continuation. Completed tasks are not automatically redispatched. Terminal processes are not restored after restart. Attachments and collaboration artifacts are stored as files alongside the database and checked by their owning services.

Ordinary create/send/cancel/answer commands share SQLite transaction receipts. Follow-ups retain their selected model, settings and attachments in a durable next-turn queue. Stop, failure and restart pause the queue. Codex reconciles clientUserMessageId against native history; lost confirmation stays unknown and never triggers an automatic resend. Attention and seen revisions persist separately from task status.

Desktop Stop requests carry the observed attempt ID; the backend compares it atomically before cancelling or pausing a queue. Pending Codex input that never reached physical execution is rejected on cancellation or queued-state recovery; input interrupted after execution began remains unknown. The same delivery guard applies to ordinary, managed and collaboration dispatch. Each new concurrent approval advances the attention revision.

Watched sessions receive bounded recent history; older pages and search windows load on demand. Unwatched sessions omit draft and queued-message bodies. Runtime health separates binary, protocol, catalog, authentication evidence and quota. Missing evidence remains unknown; DeepSeek API balance does not establish a Harness account balance.

The watched tail is bounded by message count. Individual message bodies remain intact. Frames above 8 MiB end the subscription with an explicit size-limit reason while retaining cached content; selecting a smaller session can restore synchronization. Historical sessions whose workspace was removed remain readable in a temporary read-only view without recreating the directory.

Failed watch updates invalidate only their owning subscription and reconnect using the desired session IDs. Renderer reload or loss releases its view subscriptions. A live-tail reset invalidates pages fetched against an obsolete tail. Authentication evidence is attributed to the adapter identity captured at dispatch, so an older runtime cannot authenticate its replacement.

Managed worktrees have durable creation intents with repository, branch, base SHA and ownership. Retrying the command can recover creation. Cleanup requires no active or queued work, active terminal, in-flight file/configuration operation, uncommitted files or commits missing from the source checkout. The desktop also blocks cleanup while any editor has unsaved files. Root and subdirectory aliases share the same lifecycle guard. A durable removing state records the exact branch head before Git deletion, so interrupted cleanup can continue; removed records prevent historical sessions from recreating the workspace on restart. Cleanup never force-deletes a user directory or runs repository setup scripts.

A requested source subdirectory must exist as a directory in the starting commit before an intent or checkout is created. Native run, history reconciliation and rewind calls share session-scoped diagnostics.

Diagnostics default to lifecycle metadata with a 512 KiB/1000-entry retention cap. Explicit tracing stores redacted protocol shapes: only known structural fields and enums remain readable; content, unknown keys and native identifiers are anonymized, while numbers and booleans become type placeholders. Platform session, attempt and runtime IDs remain available for correlation. Offline replay uses the existing NDJSON decoder to inspect structure and ordering; it cannot recover original content or guarantee every semantic failure is reproducible. Backend restart defaults tracing to off.

Desktop subscriptions require stream version 2. An older backend is left running with its tasks; management CLI connections remain usable so the user can stop it when appropriate before starting the new desktop client.

## Build boundaries and licensing

Vite builds the renderer. esbuild builds the Electron main process, preload, independent backend, CLI, and stdio bridge into `dist/`. The current packaging script targets macOS and the host architecture, applies an ad hoc signature, and verifies it. It does not provide Developer ID signing, notarization, or a Windows/Linux packaging path.

See [development](development.md) for commands and focused verification. License terms and attribution are defined by the root [LICENSE](../LICENSE) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
