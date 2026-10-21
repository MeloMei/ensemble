# Ensemble

在同一个本地项目里，与多个 AI Agent 一起工作的桌面工作台。

[English](README.md) | 简体中文

把对话、协作、文件、终端和本地预览放在一起。Ensemble 在本机管理 Agent 进程和任务记录，运行时、模型、项目目录和权限由你选择。

## 界面

支持浅色、深色和跟随系统。导航紧凑，对话保留阅读空间，短时动效遵循系统的“减少动态效果”设置。当前界面使用简体中文。

![Ensemble 浅色界面](docs/images/ensemble-light.png)

<details>
<summary>深色界面</summary>

![Ensemble 深色界面](docs/images/ensemble-dark.png)

</details>

截图使用隔离的本地示例数据。

## 可以做什么

- 运行 Codex、Claude Code、OpenCode V2 或 DeepSeek Harness 会话，能力以各运行时实际支持为准。
- 为参与者分配职责，安排任务依赖，交换消息，查看产物版本和执行记录。
- 查看文件与差异，保留编辑器撤销记录，添加行批注，在对话旁使用真实终端和本地预览。
- 通过 MCP 连接外部 Agent，或按插件协议接入其他本机运行时。

## 从源码运行

当前支持的桌面目标是 macOS。需要 Node.js 22.22 或更新版本，以及至少一个支持的 Agent 运行时。各运行时的 CLI 和认证需要单独配置，Ensemble 不随应用捆绑这些 CLI。

```sh
git clone https://github.com/MeloMei/ensemble.git
cd ensemble
npm ci
npm run dev
```

新建工作区并选择本地项目，然后用 **＋** 添加 Agent、终端或本地预览。接入状态表示找到了本机运行入口；认证和模型权限以实际请求为准。

运行生产构建：

```sh
npm run build
npm start
```

安装步骤见[入门指南](docs/getting-started.zh-CN.md)，各 Agent 的能力和限制见[运行时支持](docs/runtimes.zh-CN.md)。

## 本地执行

桌面、命令行和 MCP 连接共用一个本机后台。关闭窗口后，后台继续运行。需要停止时，先退出桌面应用，再运行 `bin/workbench stop`。

Agent 任务可以按配置的权限修改文件、运行命令和使用远端模型服务。项目授权与运行时权限分别控制不同操作，只读行为取决于所选运行时。文件编辑器和终端可以独立操作本机，Agent 的只读设置不会限制它们。模型权限和费用由所选服务及你的账户决定。

## 文档

| 内容 | 简体中文 | English |
| --- | --- | --- |
| 安装与第一次运行 | [入门指南](docs/getting-started.zh-CN.md) | [Getting started](docs/getting-started.md) |
| 各运行时的能力与限制 | [运行时支持](docs/runtimes.zh-CN.md) | [Runtime support](docs/runtimes.md) |
| 开发与打包 | [开发指南](docs/development.zh-CN.md) | [Development](docs/development.md) |
| 模块职责与任务执行过程 | [架构说明](docs/architecture.zh-CN.md) | [Architecture](docs/architecture.md) |
| 本机插件接入协议 | [Provider 插件](docs/provider-plugins.zh-CN.md) | [Provider plugins](docs/provider-plugins.md) |
| 提交改动 | [参与开发](CONTRIBUTING.zh-CN.md) | [Contributing](CONTRIBUTING.md) |

## 许可证

Ensemble 自有代码使用 [MIT 许可证](LICENSE)，另有[中文参考译文](LICENSE.zh-CN.md)。第三方组件继续保留各自的许可证与版权告知，见[第三方许可说明](THIRD_PARTY_NOTICES.zh-CN.md)。
