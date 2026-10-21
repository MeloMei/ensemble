# Ensemble

A local desktop workbench for working with multiple AI agents in the same project.

English | [简体中文](README.zh-CN.md)

Keep conversations, collaboration, files, terminals, and local previews together. Ensemble manages agent processes and task records on your machine. You choose the runtime, model, project directory, and permissions.

## Interface

Light and dark themes, compact navigation, readable conversations, and short transitions that respect reduced-motion preferences. The current interface uses Simplified Chinese labels.

![Ensemble in light mode](docs/images/ensemble-light.png)

<details>
<summary>Dark mode</summary>

![Ensemble in dark mode](docs/images/ensemble-dark.png)

</details>

Screenshots use isolated local sample data.

## What you can do

- Run Codex, Claude Code, OpenCode V2, or DeepSeek Harness sessions, with the capabilities supported by each runtime.
- Assign participants, define task dependencies, exchange messages, and inspect versioned artifacts and execution records.
- Review files and diffs, edit with undo history, add line comments, and use a real terminal or a local preview beside the conversation.
- Connect external agents through MCP or add a local provider through the plugin protocol.

## Run from source

The current supported desktop target is macOS. Install Node.js 22.22 or newer and at least one supported agent runtime. Runtime CLIs and their authentication are configured separately; they are not bundled with Ensemble.

```sh
git clone https://github.com/MeloMei/ensemble.git
cd ensemble
npm ci
npm run dev
```

Create a workspace for a local project, then use **＋** to add an agent, terminal, or local preview. Provider availability reports the local runtime entry point; authentication and model access are confirmed by the actual request.

For a production build:

```sh
npm run build
npm start
```

See [Getting started](docs/getting-started.md) for setup and [Runtime support](docs/runtimes.md) for provider-specific behavior and limits.

## Local execution

The desktop app, command line, and MCP connections share one local backend. Closing the window leaves that backend running. After quitting the desktop app, use `bin/workbench stop` to stop it explicitly.

Agent tasks may edit files, run commands, and use remote model services under their configured permissions. Project authorization and runtime permissions control different operations. Read-only behavior depends on the runtime. The file editor and terminal have their own access to the machine; an agent read-only setting does not restrict them. Model access and charges follow the selected provider and your account.

## Documentation

| Topic | English | 简体中文 |
| --- | --- | --- |
| Setup and first session | [Getting started](docs/getting-started.md) | [入门指南](docs/getting-started.zh-CN.md) |
| Runtime behavior and limits | [Runtime support](docs/runtimes.md) | [运行时支持](docs/runtimes.zh-CN.md) |
| Development and packaging | [Development](docs/development.md) | [开发指南](docs/development.zh-CN.md) |
| Components and execution flow | [Architecture](docs/architecture.md) | [架构说明](docs/architecture.zh-CN.md) |
| Local provider protocol | [Provider plugins](docs/provider-plugins.md) | [Provider 插件](docs/provider-plugins.zh-CN.md) |
| Contributing changes | [Contributing](CONTRIBUTING.md) | [参与开发](CONTRIBUTING.zh-CN.md) |

## License

Original Ensemble code is licensed under the [MIT License](LICENSE). Third-party components retain their respective licenses and copyright notices. See [Third-party notices](THIRD_PARTY_NOTICES.md).
