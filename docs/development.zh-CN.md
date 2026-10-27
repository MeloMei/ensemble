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

## 自动发布 Release

`.github/workflows/release.yml` 中的 `Publish Release` 在本仓库 `main` 的 `Build` 成功后检查发版，也在每天北京时间 18:15 至 23:15 每小时补查一次。自动发布从 18:15 开始，当天已有正式版就跳过，本工作流的所有入口合计每天最多发布一版。GitHub Actions 手动入口可以提前发布当天首版，但同样受每日上限限制。GitHub 定时任务可能延迟或丢弃，发版不再仅依赖每天的一次定时触发，也不依赖开发者电脑开机。

CI 触发只接受本仓库 `main` 上由 `push` 或手动启动且成功的 `Build`，固定其实际检查的 `head_sha`；定时或手动触发时，固定本次选中的 main 提交。它不会把旧 CI 的成功结果用于随后前进的 main。发布只接受该源码 SHA 最新且成功的 main Build 结果，PR、其他仓库以及未完成或失败的检查不能发版。

所有入口进入同一个串行队列，最多保留 100 个等待运行，避免晚到的旧 CI 事件挤掉正在等待的新事件。源码已发布或已被 Latest 包含时直接跳过；CI 乱序完成不会使版本回退。即使最终文件树相同，新增的合并或回退提交仍算新提交。

每日上限按 GitHub 实际 `published_at` 换算为北京时间，统计当天所有已公开的正式稳定版本，而不只统计 Latest 或自动发版。规划时、预留版本前和正式公开前都检查发布窗口与每日上限；校验或上传失败的草稿不占当天名额。

版本号避开已发布版本、草稿和已预留 tag，并尊重源码中更高的版本号。版本修改仅发生在 CI 临时工作区，不会向 `main` 提交或推送。工作流使用 Apple Silicon runner，检查实际运行架构，生成 ZIP、DMG 和 `SHA256SUMS`，再由 GitHub 根据上次发版以来的变更生成说明，不调用模型服务。

构建与本地校验完成后，工作流先创建指向固定源码的公开版本 tag，再使用未公开草稿暂存附件。它上传三个附件，再读取 GitHub 返回的附件元数据，核对大小、SHA-256、源码、版本和说明后，才将草稿发布为正式 Release 并设为 **Latest**。随后再次核对 Latest 和实际 tag 所指源码。不会先公开空 Release 再上传附件，也不会因重试而重复发布同一份源码。

同一源码已留有完整的每日自动化草稿时，流程验证其中记录的源码、版本、说明哈希、附件哈希和实际 tag 后，可直接恢复发布，不重新构建或覆盖附件。与当前源码关联的手工草稿、旧周更草稿、记录被修改或附件不完整的草稿会明确报错并保留供检查，不会自动公开或修补。仅留下 tag 而未创建草稿时，后续运行会避开已预留的版本。

上传或校验失败时不会发送公开发布请求。如果公开发布请求发出后发生网络或最终读回错误，Release 可能已经发布，需先核对远端 Release 和 Latest 状态再重试；流程保留 Release 和 tag。对确认尚未发布且无法恢复的草稿，可删除它及仅为它预留的 tag 后重试；不要删除已发布版本的 tag。

Ensemble 通过 GitHub 的 `/releases/latest` 发现正式版本。自动发版不会替用户自动下载安装，下载和安装仍需用户确认。不含更新入口的旧安装，需要先手动安装一次含该入口的新版本。

发版规则的局部检查为 `node --test scripts/prepare-release.test.mjs`。工作流在访问发布信息前执行它；该检查仅使用临时文件和 GitHub 替身，不调用模型或创建真实发版。

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
