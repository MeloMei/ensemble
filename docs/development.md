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

The packaging script writes `Ensemble-<version>-macOS-<arch>.zip`, a DMG with the same name, and `SHA256SUMS` to `release/<version>/`. It builds one application in a temporary directory, applies an ad hoc signature, verifies it with `codesign`, and produces the ZIP, a DMG with an Applications link, and SHA-256 checksums. Move the unzipped `Ensemble.app` to `/Applications`, or drag it to Applications from the DMG. These packages do not have Developer ID signing or notarization. The script rejects non-macOS hosts.

The package includes only the built application, CLI entry point, production dependencies, package metadata, and license records. Source files, documentation, and previous `release/` outputs are excluded. Add any new top-level runtime resource to the packaging input list.

GitHub Actions runs the type check and build when source or build configuration changes, or when started manually. It does not run agent tasks or call model services.

Use build or packaging commands when the change affects their output. They are not required acceptance steps for every edit.

## Prepare a Release

After it is merged into `main`, `Prepare Weekly Release Draft` runs every Friday at 18:15 in `Asia/Shanghai`, and can also be started manually in GitHub Actions. Scheduled runs can be delayed by GitHub; they do not depend on a developer's computer being awake.

The workflow fixes the source to the selected `main` commit. It skips sources with no content changes since the latest stable Release. The latest `Build` run for that exact main commit must succeed first; checks from other commits or PRs cannot substitute for it. If that commit did not trigger Build, run Build manually on `main` before preparing the draft.

The version advances beyond versions already used or reserved, while respecting a higher version in the source package. The version is changed only in the temporary CI checkout; the workflow never commits or pushes to `main`. An Apple Silicon runner checks its actual architecture, produces the ZIP, DMG, and `SHA256SUMS`, and uses GitHub to generate reviewable notes from changes since the previous Release without calling a model service.

After building and verifying the assets, the workflow first creates a public version tag pointing to the fixed source, then an unpublished **Release draft**, without publishing the Release or changing Latest. A maintainer reviews the packages and complete notes, then publishes in GitHub and marks it **Latest**. Installed apps discover versions through GitHub's `/releases/latest`; publishing without marking Latest may leave them receiving the previous version. An existing complete draft for the same source is not duplicated; a new source receives a separate version and draft without changing an earlier draft under review. A version conflict, checksum failure, or upload error stops the workflow instead of silently overwriting attachments.

A tag reserved before a failure remains in place. Later runs report an incomplete draft as an error rather than a successful preparation. After inspecting the unpublished draft and its tag, a maintainer can delete the incomplete draft and the tag reserved solely for it, then run the workflow manually. Do not delete a published version's tag. The workflow never deletes or repairs a draft under review; if only a tag was created, later runs also avoid reusing that reserved version.

The focused release-rule check is `node --test scripts/prepare-release.test.mjs`. The workflow runs it before accessing release information. It uses temporary files and GitHub substitutes, without model calls or real drafts.

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

Tests use Node's test runner through `tsx`. The existing `*.test.ts` files are beside the source they exercise, under `src/main/`, `src/main/providers/`, `src/shared/`, and `src/renderer/`.

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
