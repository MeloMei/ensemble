# Third-party notices

English | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

The root [MIT License](LICENSE) covers original Ensemble code. The components and adaptations below retain their own copyright notices and licenses. Files under `licenses/` preserve the upstream license texts; translated documentation does not replace those texts.

## UI components and interactions

Selected code comes from [Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui) at commit `4045ce76afdcb7dccef1b7e6417b04c4c6046e9c`, under MIT. Copyright (c) 2026 Caho1. The full license is in [licenses/Open-Claude-UI-MIT.txt](licenses/Open-Claude-UI-MIT.txt).

| Ensemble file | Upstream file | Adaptation |
| --- | --- | --- |
| `src/renderer/vendor/open-claude-ui/CdsButton.tsx` | `code-examples/CdsButton.tsx` | Retains separate paint/content layers, loading state, and native attributes; uses Ensemble CSS and semantic colors. |
| `src/renderer/vendor/open-claude-ui/ClaudeMotionPresets.ts` | `code-examples/ClaudeMotionPresets.ts` | Shared variants use short transitions, no bounce, and smaller offsets. |
| `src/renderer/vendor/open-claude-ui/cds-foundations.css` | `code-examples/cds-theme.css` | Selected geometry and easing tokens, adjusted to the shared control, panel, and overlay sizes. |
| `src/renderer/vendor/open-claude-ui/useClaudeScrollPinning.ts` | `code-examples/useClaudeScrollPinning.ts` | Scroll pinning tolerance, user-scroll cooldown, and jump-to-latest behavior, adapted to local types and manual scrolling. |

Only UI code and interaction patterns listed above are included. Agent messages, approvals, tool results, and task completion come from Ensemble runtime records.

## MIT helper modules

The following modules come from [stablyai/orca](https://github.com/stablyai/orca), under MIT. Copyright (c) 2026 Lovecast Inc. The full license is in [licenses/Orca-MIT.txt](licenses/Orca-MIT.txt). Source headers preserve the attribution and modification notes.

`src/main/vendor/orca/porcelain-v1-records.ts` comes from commit `6fcc183ab951fb751cf02ccb9e2af3cf129a4316`, `src/main/git/porcelain-v1-records.ts`. It retains rename/copy origins for path-scoped diffs.

The remaining modules come from commit `36913fd4f556c44495ed6da5cd6a81910c3cde21`:

| Ensemble file | Upstream file | Adaptation |
| --- | --- | --- |
| `src/main/vendor/orca/attachment-name.ts` | `src/shared/agent-session-attachments.ts:57–110` | Extracts attachment naming, with local types, a bounded UTF-8 truncation, and ES2022-compatible lookup. |
| `src/main/vendor/orca/task-list.ts` | `src/shared/native-chat-task-list.ts:1–70` | Extracts task-list types and parsing. |
| `src/renderer/vendor/orca/diff-comments-format.ts` | `src/shared/diff-comments-format.ts` | Uses the local review-note type; preserves deterministic formatting and escaping. |
| `src/main/vendor/orca/notification-burst-cooldown.ts` | `src/shared/notification-burst-cooldown.ts` | Reuses cooldown and bounded deduplication with local naming and formatting. |
| `src/main/vendor/orca/mcp-config.ts` | `src/shared/mcp-config.ts` | Unmodified function bodies with a source header. |
| `src/main/vendor/orca/mcp-server-inspection.ts` | `src/shared/mcp-server-inspection.ts` | Unmodified function bodies with a source header. |
| `src/main/vendor/orca/mcp-config-inspection-limits.ts` | `src/shared/mcp-config-inspection-limits.ts` | Unmodified function bodies with a source header. |
| `src/main/vendor/orca/utf8-byte-limits.ts` | `src/shared/utf8-byte-limits.ts` | Extracts UTF-8 measurement, code-point reading, and the required return types. |
| `src/main/vendor/orca/skill-metadata.ts` | `src/shared/skill-metadata.ts` | Preserves metadata parsing with a local summary type. |

## Atomic file-save adaptation

The atomic save flow in `src/main/workspace-files.ts` is adapted from [getpaseo/paseo](https://github.com/getpaseo/paseo), commit `05920a236cb6ba8eeae128ee7bb6677cc226cd3a`, `packages/server/src/server/file-explorer/service.ts:433–531`.

Copyright (c) 2025-present Mohamed Boudra. The adapted material is licensed under Apache-2.0; its full upstream copyright and license text are retained in [licenses/Paseo-Apache-2.0.txt](licenses/Paseo-Apache-2.0.txt). The pinned upstream archive did not contain a root NOTICE file.

The adaptation uses an exclusive temporary file in the same directory, write-and-sync, a second version check, rename, and final cleanup. Ensemble adds its own path boundaries, content/file identity revisions, shared mutation queue, and error handling. The source header marks these changes. This material retains its Apache-2.0 terms despite the root MIT license for original Ensemble code.

## Protocol and UI dependencies

- `@agentclientprotocol/sdk@1.9.0`: Apache-2.0.
- `@modelcontextprotocol/sdk@1.32.1`: MIT; Copyright (c) 2024 Anthropic, PBC.
- CodeMirror packages: MIT; their license files credit Copyright (C) 2018-2021 by Marijn Haverbeke and others.
- `@xyflow/react@12.12.0`: MIT; Copyright (c) 2019-2025 webkid GmbH. See [licenses/React-Flow-MIT.txt](licenses/React-Flow-MIT.txt).
- `elkjs@0.12.0`: EPL-2.0, used without modification. See [licenses/ELK-EPL-2.0.md](licenses/ELK-EPL-2.0.md). Corresponding source is available from [kieler/elkjs at 0.12.0](https://github.com/kieler/elkjs/tree/v0.12.0).
- `framer-motion@11.18.2`: MIT.

Additional direct and transitive dependencies retain their respective licenses. Exact versions are recorded in `package-lock.json`; dependency packages carry their own license files. The application package retains production dependencies and the repository `licenses/` directory. This notice is an attribution record and does not replace any applicable license.
