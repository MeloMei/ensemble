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

打包输出位于 `release/<version>/`，包含 `Ensemble-<version>-macOS-<arch>.zip`、同名 DMG 和 `SHA256SUMS`。脚本在临时目录中生成同一份应用，执行 ad hoc 签名并用 `codesign` 验证，再生成 ZIP、带“应用程序”入口的 DMG 和 SHA-256 校验清单。解压 ZIP 后可将 `Ensemble.app` 移到 `/Applications`；DMG 打开后可将应用拖入“应用程序”。产物没有 Developer ID 签名和公证。脚本会拒绝非 macOS 主机。

包内仅包含构建后的应用、CLI 入口、生产依赖、包信息和许可记录。源码、文档及历史 `release/` 产物不会进入安装包。新增顶层运行时资源时，需要同步更新打包输入清单。

源码或构建配置变化时，GitHub Actions 执行类型检查和构建，也支持手动触发。CI 不执行 Agent 任务，也不调用模型服务。

改动影响构建或打包产物时，再使用对应命令验收。不要求每次编辑都构建或打包。

## 准备 Release

`Prepare Weekly Release Draft` 工作流在合并到 `main` 后生效，每周五北京时间 18:15 运行，也可以从 GitHub Actions 手动启动。GitHub 的定时任务可能延迟；它不依赖开发者电脑开机。

工作流固定本次 `main` 的提交。与最后一个稳定 Release 没有内容变化时跳过；有变化时，必须先有该提交对应的、最新一次 `Build` 工作流成功结果。其他提交或 PR 的检查结果不能替代。若该提交没有触发 Build，可先在 `main` 手动运行 Build，再准备草稿。

版本号在最后已使用或预留的版本之后递增，也尊重源码中更高的版本号。版本修改仅发生在 CI 临时工作区，不会向 `main` 提交或推送。工作流使用 Apple Silicon runner，检查实际运行架构，生成 ZIP、DMG 和 `SHA256SUMS`，再用 GitHub 根据上次发版以来的变更生成可审核的说明，不调用模型服务。

构建与校验完成后，工作流先创建指向固定源码的公开版本 tag，再新建 **Release 草稿**，不会公开发布 Release，也不会改变 Latest。审核安装包和完整说明后，由维护者在 GitHub 发布，并将它设为 **Latest**。应用通过 GitHub 的 `/releases/latest` 发现新版；如果发布时没有设为 Latest，客户端仍可能收到旧版本。相同源码已有完整草稿时不会重复创建；新源码使用独立的新版本草稿，不修改正在审核的旧草稿。打包或上传过程中出现版本冲突、校验失败或其他错误时，工作流停止，不静默覆盖附件。

如果创建 tag 后失败，已预留的 tag 会保留；如果草稿上传不完整，后续运行会明确报错，不会将它当作准备成功。维护者核对尚未发布的草稿和 tag 后，可删除未完成草稿及仅为它预留的 tag，再手动运行流程。不要删除已发布版本的 tag。工作流不会自动删除或修补正在审核的稿件；仅留下 tag 而未创建草稿时，后续运行也会避开这个已预留的版本。

发版规则的局部检查为 `node --test scripts/prepare-release.test.mjs`。工作流在访问发布信息前执行它；该检查仅使用临时文件和 GitHub 替身，不调用模型或创建真实草稿。

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

测试通过 `tsx` 调用 Node test runner。现有 `*.test.ts` 与源码放在一起，分布在 `src/main/`、`src/main/providers/`、`src/shared/` 和 `src/renderer/`。

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
