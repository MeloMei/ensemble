# Getting started

English · [简体中文](getting-started.zh-CN.md)

Ensemble is a macOS desktop workspace for local agent runtimes. It keeps agent sessions, terminals, project files, and collaboration in one application. Model requests are handled by the runtime you select and its configured service.

## Requirements

- macOS for the current desktop and packaging workflow.
- Node.js 22.22 or newer and npm for development from source.
- At least one supported local runtime to execute agent tasks: Codex, Claude Code, OpenCode V2, or DeepSeek Harness.
- The authentication and network access required by that runtime.

Use the [official installation and configuration guides](runtimes.md#install-and-configure) for your runtime. Ensemble does not bundle the Codex, Claude Code, OpenCode, or DeepSeek Harness CLIs. It can discover CLIs included in separately installed applications as well as command-line installations. Installation, authentication, and model access are separate checks.

## Run from source

Run these commands in the repository root:

```sh
npm ci
npm run dev
```

The renderer reloads during development. Restart the desktop process after changing main or preload code. The backend is a separate process; stop and restart it after changing backend code.

To build and run the production files locally:

```sh
npm run build
npm start
```

To create a macOS application:

```sh
npm run package:mac
```

The packaging script builds for the host architecture and writes to `release/<version>/`. It applies an ad hoc signature and verifies it. It does not perform Developer ID signing or notarization.

## Start your first collaboration

The current interface uses Simplified Chinese labels.

1. Choose **新建工作区** and select your project directory.
2. Open **协作** and choose **实现与审阅**. Enter a concrete goal in **任务目标**.
3. Select a runtime and model for the implementer and reviewer. The same runtime can fill both roles. The reviewer must support read-only execution.
4. If a required runtime is missing, open **接入与登录帮助**, follow its official guide, and choose **刷新检测**. Close the help dialog to continue with your configuration.
5. Choose **检查分工**. Review the two tasks, their dependency, the directory, and file permissions. The implementer can modify the project; the reviewer waits for implementation and reads the result.
6. Choose **保存并查看协作**. The configuration is saved without starting tasks. Select **开始协作** when you are ready to use the configured model accounts.

For a copyable example with a focused completion check, follow [First collaboration](first-collaboration.md). Choose **自定义协作** when you want to define participants, permissions, and tasks yourself.

Within a collaboration, tasks in the same project run in order. Independent, non-overlapping directories can execute concurrently. A separate individual session cannot start while another owner is executing in its project.

## Open an individual session

1. Open **接入与插件** and choose **刷新检测**. **已发现入口** means the local runtime was detected; it does not prove authentication, account quota, or a successful model request. Each built-in runtime links to its official installation and configuration help.
2. Choose **新建工作区** and select a local project, such as `/absolute/project`.
3. Use **＋ → 新建 Agent 会话**. Choose an available runtime and a model when offered.
4. Review the session's permission setting before sending a task. Read-only support differs by runtime; DeepSeek Harness currently rejects it.
5. Send a task, such as “Summarize this project's structure.” Respond to approvals or questions in the session.

The **＋** menu also opens a real local terminal or adds an HTTP/HTTPS preview at `localhost`, `127.0.0.1`, or `[::1]`. Start your project's service before adding its preview. Terminal sessions are not restored after a backend restart.

The **文件 (Files)** panel edits real project files. **改动 (Changes)** supports local Git operations. **PR / CI** displays remote pull request and check information through a read-only interface. The terminal and file editor have their own access to the machine; an agent's read-only setting does not restrict them.

## Session drafts

Unsent text and selected attachments are saved with their session. Closing the window waits for pending draft saves. If saving fails or cannot be confirmed, keep the window open and retry after resolving the error; choosing **仍然退出** can discard the unsaved changes.

Sending an accepted task clears its submitted draft. This draft behavior applies to the session composer, not to unsaved file-editor content or terminal processes.

## Background process and data

The desktop application, CLI, and MCP connections share one local backend for the selected data directory. Closing or quitting the desktop application leaves that backend and its tasks running. Ending an MCP stdio bridge only disconnects that client.

After building the project, the repository provides these commands:

```sh
bin/workbench status
bin/workbench stop
```

These commands connect to the backend and start it if necessary, including `status`. To stop an existing backend, quit the desktop application first, then run `bin/workbench stop`. An open desktop application reconnects and can restart it.

After a backend restart, unfinished work is marked interrupted and requires an explicit resume or retry. Inspect the existing output and file changes before resuming. Completed tasks are retained.

On macOS, the default data directory is `~/Library/Application Support/Agent Workbench`. The historical directory name is retained so existing data remains available. It contains `state.sqlite`, the backend discovery file `backend.json`, and `backend.log`. The backend owns the database. An existing `state.json` is imported on first load and retained; later state updates go to SQLite.

Set `WORKBENCH_DATA_DIR` before starting the desktop application or CLI to use a separate data directory. CLI commands also accept `--data-dir`. Use the same directory for clients that should share a backend. The `workbench` command, MCP service name, and `WORKBENCH_*` environment variables retain their existing names.

`backend.json` contains a local management credential and is written with mode `0600`. Keep the data directory and issued connection configurations private. The backend listens only on `127.0.0.1`; a local address does not remove the need for authentication.

## Connect an external agent

Open **协作 → Agent MCP 接入**, give the agent a name, and authorize its project directories and platform runtimes. Copy the generated configuration into the original client. The credential is shown only when issued and can be revoked independently.

The source checkout also supports issuing an identity without opening the desktop window:

```sh
bin/workbench connect --name "Local agent" --cwd /absolute/project
```

The output contains private connection credentials. After loading the configuration, the agent calls `get_context` before starting or joining collaboration. A submitted task ID means the task was saved; its execution record determines whether it completed. Automatic wakeup of the original client depends on that client's capabilities.

See [Runtimes](runtimes.md) for execution boundaries and [Provider plugins](provider-plugins.md) for custom local adapters.
