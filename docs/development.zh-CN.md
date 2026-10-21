# 开发

[English](development.md) | 简体中文

Ensemble 使用 Electron 和 React，后台在独立的本机进程中运行。进程分工和源码位置见[架构说明](architecture.zh-CN.md)。

## 环境要求

- macOS。当前开发和打包路径面向 macOS，尚未确立 Windows、Linux 支持。
- Node.js 22.22 或更新版本，以及 npm。
- 所用 Provider 对应的原生 Agent 运行时和认证。Provider 是否可用取决于本机安装和账户配置。

运行时查找会检查已知的应用位置和 `PATH`。也可以通过 `CODEX_BINARY`、`CLAUDE_BINARY`、`OPENCODE_BINARY` 或 `DSH_BINARY` 指定可执行文件。

## 安装和启动

在仓库根目录执行：

```sh
npm ci
npm run dev
```

开发脚本先构建主进程、preload、后台、CLI 和 MCP 桥接入口，再启动 Vite 和 Electron。renderer 使用 `http://127.0.0.1:5186`，支持热更新。main 和 preload 只在命令启动时构建，修改后需要重启应用。

后台独立于窗口运行。要加载后台改动，先退出桌面应用，再停止后台，然后重新启动开发：

```sh
bin/workbench stop
npm run dev
```

停止后台前要先关闭桌面应用。桌面客户端保持打开时会重新连接，也可能再次启动后台。

## 构建和打包

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按 `package-lock.json` 安装依赖。 |
| `npm run dev` | 构建 Node 入口，并启动 Vite 和 Electron。 |
| `npm run typecheck` | 检查 TypeScript，不生成构建文件。 |
| `npm run build` | 先检查类型，再将应用构建到 `dist/`。 |
| `npm start` | 通过 Electron 打开已有构建，需要先构建。 |
| `npm run package:mac` | 构建应用，并按当前机器的架构生成 macOS App。 |

打包输出位于 `release/<version>/Ensemble-darwin-<arch>/`。脚本执行 ad hoc 签名，再用 `codesign` 验证签名。产物是本机包，没有 Developer ID 签名和公证。脚本会拒绝非 macOS 主机。

源码或构建配置变化时，GitHub Actions 执行类型检查和构建，也支持手动触发。CI 不执行 Agent 任务，也不调用模型服务。

改动影响构建或打包产物时，再使用对应命令验收。不要求每次编辑都构建或打包。

## 本机数据和 CLI

macOS 默认数据目录保留为 `~/Library/Application Support/Agent Workbench`，用于兼容已有安装。目录内包含 `state.sqlite`、后台发现信息、附件、插件和运行时设置。SQLite 尚无已保存状态时，会导入已有的 `state.json`，并保留原文件。

开发时可以用 `WORKBENCH_DATA_DIR` 指定独立目录：

```sh
WORKBENCH_DATA_DIR="/absolute/path/ensemble-dev-data" npm run dev
```

CLI 要连接同一个后台时，也要使用相同目录：

```sh
bin/workbench status --data-dir /absolute/path/ensemble-dev-data
bin/workbench stop --data-dir /absolute/path/ensemble-dev-data
```

CLI 依赖 `dist/main/` 内的构建文件。桌面应用和 CLI 都会连接已有后台，必要时启动后台。`bin/workbench connect` 用来签发外部 MCP 身份，`bin/workbench revoke <identityId>` 用来撤销身份。客户端配置见 [README](../README.zh-CN.md)。

`backend.json` 包含本机管理凭据，签发的 MCP 配置包含身份凭据。提交贡献时，不要包含这些文件、本机状态、认证信息和私有项目内容。

## 验证改动

测试通过 `tsx` 调用 Node test runner。现有 `*.test.ts` 与源码放在一起，分布在 `src/main/`、`src/main/providers/` 和 `src/renderer/`。

按改动行为选择已有测试文件。例如，修改后台生命周期时可以运行：

```sh
npx tsx --test src/main/backend.test.ts
```

其他常用入口：

| 改动行为 | 已有测试文件 |
| --- | --- |
| 协作权限、派工或任务状态 | `src/main/collaboration-core.test.ts` |
| 会话执行和项目串行调度 | `src/main/engine.test.ts` |
| SQLite 迁移和恢复 | `src/main/store-migration.test.ts` |
| 文件保存、暂存、丢弃或本地提交 | `src/main/workspace-file-mutations.test.ts` |
| 运行时设置和 MCP 配置编辑 | `src/main/runtime-settings.test.ts` |
| Provider 协议处理 | `src/main/providers/*.test.ts` 中对应的文件 |
| Diff 批注格式 | `src/renderer/review-notes.test.ts` |

`npm run test:core` 只运行 engine、插件和 Codex 测试，没有覆盖全部测试文件。只有改动涉及这些范围时，才使用这个组合命令。

验证仅覆盖本次改动及其直接影响。代码、环境和范围未变时，复用已有通过结果。只有现有测试缺少必要行为或实际回归覆盖时，才新增测试，不要求测试数量。视觉改动在应用中查看受影响的交互。使用替身的测试不能证明本机 Provider、账户或模型可真实运行。

## 源码与许可

源码分工见[架构说明](architecture.zh-CN.md)，贡献要求见 [CONTRIBUTING](../CONTRIBUTING.zh-CN.md)。许可条款见根目录的 [LICENSE](../LICENSE)，第三方许可与归属见 [THIRD_PARTY_NOTICES.zh-CN.md](../THIRD_PARTY_NOTICES.zh-CN.md)。
