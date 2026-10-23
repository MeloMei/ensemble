<h1 align="center"><img src="docs/brand/ensemble-avatar.png" width="40" height="40" alt=""> Ensemble</h1>

<p align="center">
  <strong>让你的 Agent 一起完成工作。</strong><br>
  在同一个本地工作区使用 Codex、Claude Code 和其他编程 Agent。
</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="docs/first-collaboration.zh-CN.md">第一次协作</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">macOS · 开源 · 接入你自己的运行时</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/workspace-zh-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/workspace-zh-light.png">
  <img src="docs/images/workspace-zh-light.png" alt="Ensemble 工作区中的 Agent 审阅对话与文件改动">
</picture>

<p align="center"><sub>在同一个工作区查看审阅对话与文件改动。</sub></p>

## 从一个任务，到一份经过审阅的改动

- **安排分工。** 从“实现与审阅”模板开始，也可以自己定义参与者、权限和任务依赖。
- **跟踪交接。** 看清哪些任务正在执行、等待审批、等待其他任务或已经结束，随时打开对应对话和执行记录。
- **审阅结果。** 查看实际文件差异，编辑文件并保留撤销记录，在对话旁使用终端和本地预览。

同一协作、同一项目中的任务顺序执行。不重叠的独立项目目录可以并发。

## 开始使用

准备 **macOS**、**Node.js 22.22 或更新版本**，以及至少一个受支持的本地 Agent 运行时。启动前，先[单独安装运行时并完成认证](docs/runtimes.zh-CN.md#安装与配置)。

```sh
git clone https://github.com/MeloMei/ensemble.git
cd ensemble
npm ci
npm run dev
```

为项目创建工作区，选择 **协作 → 实现与审阅**。检查并保存配置，准备好后再开始协作。同一套 Codex 或 Claude Code 安装就可以分别承担两个角色。

[动手完成第一次协作](docs/first-collaboration.zh-CN.md) · [操作演示（v0.7，中文）](docs/media/ensemble-demo.mp4)

单 Agent 会话、语言设置、本地构建和打包见[入门指南](docs/getting-started.zh-CN.md)。

## 运行时支持

**Codex · Claude Code · OpenCode V2 · DeepSeek Harness**

OpenCode V2 使用独立配置，仅接入目录声明免费的模型。DeepSeek Harness 不能担任只读角色。运行时检测只确认本机程序入口，认证和模型访问由实际任务确认。

模型选择、权限与续聊能力见[运行时支持](docs/runtimes.zh-CN.md)。新增本地适配器见 [Provider 插件](docs/provider-plugins.zh-CN.md)。

## 本地数据与操作权限

Ensemble 在 Mac 上保存任务记录并管理本地 Agent 进程。模型请求可能通过你配置的运行时和服务商账户发送到远端服务。

桌面应用、CLI 和 MCP 连接共用一个本地后台。关闭窗口后，后台和任务会继续运行。需要停止时，先退出桌面应用，再执行 `bin/workbench stop`。

Agent 执行权限与协作权限分别控制不同操作。文件编辑器和终端拥有各自的本机访问能力，Agent 的只读设置不会限制它们。

## 文档

| English | 简体中文 |
| --- | --- |
| [Getting started](docs/getting-started.md) | [入门指南](docs/getting-started.zh-CN.md) |
| [First collaboration](docs/first-collaboration.md) | [第一次协作](docs/first-collaboration.zh-CN.md) |
| [Runtime support](docs/runtimes.md) | [运行时支持](docs/runtimes.zh-CN.md) |
| [Development](docs/development.md) | [开发指南](docs/development.zh-CN.md) |
| [Architecture](docs/architecture.md) | [架构说明](docs/architecture.zh-CN.md) |
| [Provider plugins](docs/provider-plugins.md) | [Provider 插件](docs/provider-plugins.zh-CN.md) |
| [Contributing](CONTRIBUTING.md) | [参与开发](CONTRIBUTING.zh-CN.md) |

## 许可证

Ensemble 自有代码采用 [MIT 许可证](LICENSE)。第三方组件继续保留各自的许可证和版权声明，详见[第三方告知](THIRD_PARTY_NOTICES.zh-CN.md)。
