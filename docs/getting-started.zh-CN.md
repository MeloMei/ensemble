# 开始使用

[English](getting-started.md) · 简体中文

Ensemble 是一个 macOS 桌面工作台，把本机 Agent 会话、终端、项目文件和协作放在一起。模型请求由你选择的运行时及其配置的服务处理。

## 使用条件

- 当前桌面和打包流程需要 macOS。
- 从源码开发需要 Node.js 22.22 或更新版本，以及 npm。
- 执行 Agent 任务时，本机至少安装一个受支持的运行时：Codex、Claude Code、OpenCode V2 或 DeepSeek Harness。
- 已具备对应运行时需要的认证和网络连接。

运行时需要你自行安装。Ensemble 不自带 Codex、Claude Code、OpenCode 或 DeepSeek Harness CLI。它可以查找独立安装的命令行程序，也可以查找其他应用内附带的 CLI。安装位置、认证和限制见[运行时](runtimes.zh-CN.md)。

## 从源码启动

在仓库根目录执行：

```sh
npm ci
npm run dev
```

renderer 支持热更新。修改 main 或 preload 后，需要重启桌面进程。后台是独立进程，修改后台代码后，需要先停止后台，再重新启动。

构建并运行本地生产文件：

```sh
npm run build
npm start
```

生成 macOS 应用：

```sh
npm run package:mac
```

打包脚本按本机架构构建，输出到 `release/<version>/`。脚本会做 ad hoc 签名并校验签名，不做 Developer ID 签名或公证。

## 创建第一个会话

1. 打开 **接入与插件**，点击 **刷新检测**。“可用”表示检测到了本机运行入口，不表示认证、账户额度或模型请求已成功。
2. 点击 **新建工作区**，选择本地项目，例如 `/absolute/project`。
3. 点击 **＋ → 新建 Agent 会话**，选择可用运行时，并按界面提供的选项选择模型。
4. 发送任务前检查会话权限。各运行时的只读支持不同；DeepSeek Harness 当前拒绝只读设置。
5. 发送任务，例如“梳理这个项目的目录结构”。需要审批或回答问题时，在会话内处理。

**＋** 菜单还可以打开真实的本机终端，或添加 `localhost`、`127.0.0.1`、`[::1]` 上的 HTTP/HTTPS 预览。添加预览前，先启动项目服务。后台重启后，终端会话不会恢复。

**文件** 面板会修改真实项目文件。**改动** 支持本地 Git 操作。**PR / CI** 通过只读界面展示远端 PR 和检查信息。终端和文件编辑器各自拥有本机访问权限，不受 Agent 会话的只读设置限制。

## 后台和数据

桌面、CLI 和 MCP 连接共用所选数据目录对应的本机后台。关闭窗口或退出桌面应用后，后台和任务继续运行。MCP stdio 桥接进程退出时，只断开该客户端。

构建项目后，可以使用仓库内的命令：

```sh
bin/workbench status
bin/workbench stop
```

这些命令会连接后台；后台未运行时会先启动它，`status` 也是如此。需要停止已有后台时，先退出桌面应用，再执行 `bin/workbench stop`。桌面应用保持打开时，会重新连接并可能启动后台。

后台重启后，未完成的工作会标记为中断，需要明确恢复或重试。恢复前先检查已有输出和文件改动。已完成任务会保留。

macOS 默认数据目录为 `~/Library/Application Support/Agent Workbench`。保留旧目录名是为了继续使用已有数据。目录内包含 `state.sqlite`、后台发现文件 `backend.json` 和 `backend.log`。数据库由后台独占。首次加载时会导入已有 `state.json` 并保留原文件，后续状态更新写入 SQLite。

启动桌面或 CLI 前，设置 `WORKBENCH_DATA_DIR` 可以使用独立数据目录。CLI 也支持 `--data-dir`。需要共用后台的客户端应使用同一目录。`workbench` 命令、MCP 服务名和 `WORKBENCH_*` 环境变量继续保留原名。

`backend.json` 包含本机管理凭据，文件权限为 `0600`。请妥善保存数据目录和签发的连接配置。后台仅监听 `127.0.0.1`，本机地址仍需认证。

## 接入外部 Agent

打开 **协作 → Agent MCP 接入**，填写 Agent 名称，授权项目目录和平台运行时，再把生成的配置加载到原客户端。凭据只在签发时展示，可以单独撤销。

源码目录也提供命令入口，无需打开桌面窗口：

```sh
bin/workbench connect --name "Local agent" --cwd /absolute/project
```

命令输出包含私有连接凭据。加载配置后，Agent 先调用 `get_context`，再发起或加入协作。派工返回任务 ID 只表示任务已保存，完成状态以执行记录为准。原客户端能否自动唤醒自己的会话，取决于它自身的能力。

执行边界见[运行时](runtimes.zh-CN.md)。自定义本地适配器见 [Provider 插件](provider-plugins.zh-CN.md)。
