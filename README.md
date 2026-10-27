<h1 align="center"><img src="docs/brand/ensemble-avatar.png" width="40" height="40" alt=""> Ensemble</h1>

<p align="center">
  <strong>Your agents. In concert.</strong><br>
  A local workspace for Codex, Claude Code, and your other coding agents.
</p>

<p align="center">
  <a href="https://github.com/MeloMei/ensemble/releases/download/v0.8.1/Ensemble-0.8.1-macOS-arm64.dmg">Download for macOS</a> ·
  <a href="docs/media/ensemble-overview-en.mp4">Watch in English · 30s</a> ·
  <a href="docs/first-collaboration.md">First collaboration</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">macOS · Apple Silicon · Open source · Bring your own runtimes</p>

## Get started

1. **[Download Ensemble for macOS (Apple Silicon)](https://github.com/MeloMei/ensemble/releases/download/v0.8.1/Ensemble-0.8.1-macOS-arm64.dmg).** Open the DMG and drag `Ensemble.app` into Applications. A [ZIP download and release notes](https://github.com/MeloMei/ensemble/releases/latest) are also available.
2. **Connect your agent runtime.** [Install and authenticate Codex, Claude Code, or another supported runtime](docs/runtimes.md#install-and-configure), then open Ensemble and choose **Runtimes & plugins → Refresh detection**. The desktop app does not require a separate Node.js installation; your chosen runtime may have its own requirements.
3. **[Try your first collaboration](docs/first-collaboration.md).** Create a workspace for your project and choose **Collaboration → Implement and review**. Review and save the setup, then start when ready. One Codex or Claude Code installation can fill both roles.

The current release is not notarized by Apple, so macOS may block the first launch. See the [release notes](https://github.com/MeloMei/ensemble/releases/latest) and [Apple's instructions](https://support.apple.com/102445) before opening it.

## Watch Ensemble in 30 seconds

[English video](docs/media/ensemble-overview-en.mp4) · [中文视频](docs/media/ensemble-overview-zh-CN.mp4)

The videos show the real interface: task handoffs, agent conversations, file changes, and results. Follow the [first collaboration tutorial](docs/first-collaboration.md) to try the workflow yourself.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/workspace-en-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/workspace-en-light.png">
  <img src="docs/images/workspace-en-light.png" alt="Ensemble workspace with an agent review conversation and file changes">
</picture>

<p align="center"><sub>Review conversations and file changes in one workspace.</sub></p>

## From a task to a reviewed change

- **Give each agent a role.** Start with an implement-and-review template, or define participants, permissions, and task dependencies yourself.
- **Follow the handoff.** See what is running, waiting for approval, waiting for another task, or finished. Open any task's conversation and execution record.
- **Review the result.** Inspect actual file changes, edit with undo history, and keep terminals and local previews beside your conversations.

Within a collaboration, tasks in the same project run in order. Independent, non-overlapping project directories can run concurrently.

## Run from source

For development from source, you need **macOS**, **Node.js 22.22+**, and npm, in addition to your configured agent runtime.

```sh
git clone https://github.com/MeloMei/ensemble.git
cd ensemble
npm ci
npm run dev
```

For individual sessions, language settings, local builds, and packaging, see [Getting started](docs/getting-started.md).

## Runtime support

**Codex · Claude Code · Pi · Gemini CLI · Cursor Agent · Qoder · OpenCode V2 · DeepSeek Harness**

Pi requires the official npm CLI version 1.3.0 or newer. OpenCode V2 uses an isolated profile limited to models declared free. DeepSeek Harness cannot fill a read-only role. Runtime detection does not confirm authentication or model access; verify them with an actual task.

See [Runtime support](docs/runtimes.md) for model selection, permissions, and continuation, or [Provider plugins](docs/provider-plugins.md) to add a local adapter.

## Local data & control

Ensemble stores task records on your Mac and manages local agent processes. Model requests may go to remote services through your runtime and provider account.

The desktop app, CLI, and MCP connections share a local backend. Closing the window leaves it and its tasks running. From a source checkout, quit the desktop app and run `bin/workbench stop` to stop the backend.

Agent execution and collaboration have separate permissions. The file editor and terminal have their own access to your machine; an agent's read-only setting does not restrict them.

## Documentation

| English | 简体中文 |
| --- | --- |
| [Getting started](docs/getting-started.md) | [入门指南](docs/getting-started.zh-CN.md) |
| [First collaboration](docs/first-collaboration.md) | [第一次协作](docs/first-collaboration.zh-CN.md) |
| [Runtime support](docs/runtimes.md) | [运行时支持](docs/runtimes.zh-CN.md) |
| [Development](docs/development.md) | [开发指南](docs/development.zh-CN.md) |
| [Architecture](docs/architecture.md) | [架构说明](docs/architecture.zh-CN.md) |
| [Provider plugins](docs/provider-plugins.md) | [Provider 插件](docs/provider-plugins.zh-CN.md) |
| [Contributing](CONTRIBUTING.md) | [参与开发](CONTRIBUTING.zh-CN.md) |

## License

Original Ensemble code is licensed under the [MIT License](LICENSE). Third-party components retain their respective licenses and copyright notices. See [Third-party notices](THIRD_PARTY_NOTICES.md).

The overview videos use “Cat Walk” by Arulo from [Mixkit](https://mixkit.co/free-stock-music/edm/), under the [Mixkit Stock Music Free License](https://mixkit.co/license/#musicFree). The music is not covered by Ensemble's MIT license.
