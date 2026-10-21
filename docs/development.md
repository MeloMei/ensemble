# Development

English | [简体中文](development.zh-CN.md)

Ensemble is an Electron application with a React renderer and a separate local backend. Start with the [architecture guide](architecture.md) for the process boundaries and source map.

## Requirements

- macOS. The current development and packaging path is for macOS; Windows and Linux support is not established.
- Node.js 22.22 or later and npm.
- The native agent runtimes and authentication needed for the providers you use. Provider availability depends on the local installation and account configuration.

Runtime discovery checks known application locations and `PATH`. You can override a runtime executable with `CODEX_BINARY`, `CLAUDE_BINARY`, `OPENCODE_BINARY`, or `DSH_BINARY`.

## Install and run

Run these commands from the repository root:

```sh
npm ci
npm run dev
```

The development script builds the main process, preload, backend, CLI, and MCP bridge, then starts Vite and Electron. The renderer is served at `http://127.0.0.1:5186` and supports hot reload. Main and preload code is built once when the command starts, so restart the application after changing it.

The backend runs independently of the window. To load backend changes, quit the desktop application, stop the backend, and start development again:

```sh
bin/workbench stop
npm run dev
```

Stop the backend after closing the desktop application. An open desktop client reconnects and can start the backend again.

## Build and package

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the dependencies recorded in `package-lock.json`. |
| `npm run dev` | Build the Node entry points and start Vite with Electron. |
| `npm run typecheck` | Check TypeScript without generating output. |
| `npm run build` | Run the type check and build the application into `dist/`. |
| `npm start` | Open the already built application with Electron. Run a build first. |
| `npm run package:mac` | Build and package a macOS application for the current machine's architecture. |

The packaging script writes to `release/<version>/Ensemble-darwin-<arch>/`. It applies an ad hoc signature and verifies that signature with `codesign`. This is a local package, without Developer ID signing or notarization. The script rejects non-macOS hosts.

GitHub Actions runs the type check and build when source or build configuration changes, or when started manually. It does not run agent tasks or call model services.

Use build or packaging commands when the change affects their output. They are not required acceptance steps for every edit.

## Local data and the CLI

The default macOS data directory remains `~/Library/Application Support/Agent Workbench` for compatibility with existing installations. It contains `state.sqlite`, backend discovery information, attachments, plugins, and runtime settings. An existing `state.json` is imported when SQLite has no saved state; the original file is retained.

Set `WORKBENCH_DATA_DIR` to use a separate directory during development:

```sh
WORKBENCH_DATA_DIR="/absolute/path/ensemble-dev-data" npm run dev
```

Use the same directory for CLI commands that should reach that backend:

```sh
bin/workbench status --data-dir /absolute/path/ensemble-dev-data
bin/workbench stop --data-dir /absolute/path/ensemble-dev-data
```

The CLI requires the built files in `dist/main/`. Both the desktop application and CLI connect to the existing backend or start one when needed. `bin/workbench connect` issues an external MCP identity, and `bin/workbench revoke <identityId>` revokes one. See the [README](../README.md) for client setup.

`backend.json` contains a local management credential, and issued MCP configuration contains an identity credential. Keep these files, local state, authentication, and private project content out of contributions.

## Verify the changed behavior

Tests use Node's test runner through `tsx`. The existing `*.test.ts` files are beside the source they exercise, under `src/main/`, `src/main/providers/`, and `src/renderer/`.

Choose the existing test file that covers the behavior you changed. For example, a backend lifetime change can use:

```sh
npx tsx --test src/main/backend.test.ts
```

Other useful entry points include:

| Changed behavior | Existing test file |
| --- | --- |
| Collaboration permissions, dispatch, or task state | `src/main/collaboration-core.test.ts` |
| Session execution and project serialization | `src/main/engine.test.ts` |
| SQLite migration and recovery | `src/main/store-migration.test.ts` |
| File saves, staging, discard, or local commits | `src/main/workspace-file-mutations.test.ts` |
| Runtime settings and MCP configuration editing | `src/main/runtime-settings.test.ts` |
| Provider protocol handling | The matching file in `src/main/providers/*.test.ts` |
| Diff comment formatting | `src/renderer/review-notes.test.ts` |

`npm run test:core` is a convenience command for the engine, plugin, and Codex tests. It does not run all test files. Use it only when those areas are relevant to the change.

Keep verification limited to the change and its direct effects. Reuse an existing passing result when the code, environment, and scope have not changed. Add a regression test only when it covers a necessary behavior that existing tests miss; there is no test-count requirement. For visual changes, inspect the affected interaction in the application. Fixture tests do not prove that an installed provider, account, or model works live.

## Source and licensing

See [architecture](architecture.md) for the source layout and [CONTRIBUTING](../CONTRIBUTING.md) for contribution expectations. License terms and attribution are defined by the root [LICENSE](../LICENSE) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
