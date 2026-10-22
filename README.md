# Ensemble

**Your agents. In concert.**

Assign tasks, follow progress, and review changes in one local workspace.

[See it in action](#see-it-in-action) · [Get started](#get-started) · [First collaboration](docs/first-collaboration.md) · [简体中文](README.zh-CN.md)

macOS desktop · Light and dark themes · Bring your own agent runtimes

![Ensemble in light mode](docs/images/ensemble-light.png)

<details>
<summary>Dark appearance</summary>

![Ensemble in dark mode](docs/images/ensemble-dark.png)

</details>

## From a task to a reviewed change

- **Arrange the work.** Start with an implement-and-review template, or define your own participants, permissions, and dependencies.
- **Follow each step.** See which task is running, waiting for approval, waiting for another task, or finished. Open its session and execution record for details.
- **Inspect the result.** Read the review, compare the actual file changes, edit with undo history, and keep a terminal or local preview beside the conversation.

One runtime can fill both roles. Within a collaboration, tasks in the same project run in order; independent, non-overlapping project directories can execute concurrently. Custom collaboration also supports messages, versioned artifacts, and external agents connected through MCP.

## See it in action

[![Implementation, read-only review, and file changes in Ensemble](docs/images/ensemble-demo.gif)](docs/media/ensemble-demo.mp4)

[Open the video](docs/media/ensemble-demo.mp4) · [Try the same search example](docs/first-collaboration.md)

The walkthrough combines captured views from two independent Codex sessions in the actual Ensemble app. The implementer changes one line in a local search example and passes the focused checks; a read-only reviewer then inspects the diff and test file, using the recorded result without rerunning the checks or modifying files. The video is edited, so its length does not represent actual execution time.

The screenshots and video show the Simplified Chinese interface recorded in Ensemble 0.7.0.

## Get started

You need macOS, Node.js 22.22 or newer, and at least one supported local agent runtime. Install and authenticate the runtime separately using the [official setup links](docs/runtimes.md#install-and-configure). One Codex or Claude Code installation can serve both roles in the first-collaboration tutorial.

```sh
git clone https://github.com/MeloMei/ensemble.git
cd ensemble
npm ci
npm run dev
```

In **Preferences** (偏好设置), choose **Follow system**, **简体中文**, or **English**. The first launch follows your system language, and your choice is saved on this Mac. Existing tasks, conversations, code, and runtime diagnostics stay in their original language.

1. Open **Runtimes & plugins** and choose **Refresh detection** to find installed runtimes.
2. Create a workspace for your project, then open **Collaboration → Implement and review**.
3. Describe the goal, choose the runtimes, and select **Review the setup**.
4. Review the tasks and permissions, choose **Save and view collaboration**, then **Start collaboration** when ready.

Detected means the local entry point was found. Authentication and model access are confirmed by the actual task. Model usage follows your runtime configuration and provider account.

For a production build:

```sh
npm run build
npm start
```

See [Getting started](docs/getting-started.md) for individual sessions, local packaging, and backend controls.

## Runtime support

| Runtime | Model selection in Ensemble | Read-only execution | Native continuation |
| --- | --- | --- | --- |
| Codex | Native model catalog and CLI configuration | Native read-only sandbox | Supported |
| Claude Code | CLI defaults and configured model mappings | Plan mode with restricted tools | Supported |
| OpenCode V2 | Declared-free models in an isolated profile | Plan mode with restricted tools | Depends on native ACP support |
| DeepSeek Harness | DeepSeek Flash route | Not supported | Depends on native ACP support |

OpenCode V2 uses an independent configuration rather than your personal provider setup. DeepSeek Harness cannot fill the read-only reviewer role. Native capabilities and model availability depend on the installed runtime. See [Runtime support](docs/runtimes.md) for exact behavior and limits, or [Provider plugins](docs/provider-plugins.md) to add a local adapter.

## Your project, your controls

Ensemble keeps task records and manages agent processes on your machine. The selected runtime may send requests to remote model services. You choose the project directory, model, and permissions before execution.

Unsent session text and attachments are saved as drafts. Closing the window waits for pending draft saves; if saving cannot be confirmed, the app offers to keep the window open.

The desktop app, CLI, and MCP connections share one local backend. Closing the window leaves that backend and its tasks running. After quitting the desktop app, use `bin/workbench stop` to stop it explicitly.

Runtime permissions and collaboration permissions govern different operations. The file editor and terminal have their own access to the machine; an agent read-only setting does not restrict them.

## Documentation

| Topic | English | 简体中文 |
| --- | --- | --- |
| Setup and first session | [Getting started](docs/getting-started.md) | [入门指南](docs/getting-started.zh-CN.md) |
| Implement, review, inspect | [First collaboration](docs/first-collaboration.md) | [第一次协作](docs/first-collaboration.zh-CN.md) |
| Runtime behavior and limits | [Runtime support](docs/runtimes.md) | [运行时支持](docs/runtimes.zh-CN.md) |
| Development and packaging | [Development](docs/development.md) | [开发指南](docs/development.zh-CN.md) |
| Components and execution flow | [Architecture](docs/architecture.md) | [架构说明](docs/architecture.zh-CN.md) |
| Local provider protocol | [Provider plugins](docs/provider-plugins.md) | [Provider 插件](docs/provider-plugins.zh-CN.md) |
| Contributing changes | [Contributing](CONTRIBUTING.md) | [参与开发](CONTRIBUTING.zh-CN.md) |

## License

Original Ensemble code is licensed under the [MIT License](LICENSE). Third-party components retain their respective licenses and copyright notices. See [Third-party notices](THIRD_PARTY_NOTICES.md).
