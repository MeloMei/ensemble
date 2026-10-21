# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Keep changes focused on a concrete problem. Explain the current behavior and the result you intend to change before making a large redesign.

## Local development

The current development and packaging path is macOS with Node.js 22.22 or later:

```sh
npm ci
npm run dev
```

The renderer supports hot reload. Restart after changing main or preload code. Backend changes also require stopping the independent backend after quitting the desktop application. See [development](docs/development.md) for build commands, data directories, and backend shutdown, and [architecture](docs/architecture.md) for source ownership.

## Verification

Verify the changed behavior and its direct effects. Choose the relevant existing `*.test.ts` files beside the source and run them with `npx tsx --test <file>`. For example, backend lifetime changes use `src/main/backend.test.ts`. Use a type check, build, packaging, or manual application check only when it answers a question raised by the change.

Do not run every test or add tests to meet a count. Add a regression test when existing coverage misses a necessary behavior. Reuse passing results when the code, environment, and scope have not changed. State clearly whether validation used fixtures or a live runtime.

## Pull requests

Describe the problem, the resulting behavior, and the validation performed. Include the exact focused command or manual steps and any remaining limitation. Keep local results, live provider checks, CI, merge, and release status distinct.

Update relevant documentation when behavior changes. Keep English and `.zh-CN.md` counterparts consistent. Do not include credentials, issued MCP configuration, local state, or private project content. When adding dependencies or adapting third-party code, check the applicable license and update attribution where required.

License terms and attribution are defined by [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
