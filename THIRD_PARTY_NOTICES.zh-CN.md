# 第三方许可说明

[English](THIRD_PARTY_NOTICES.md) | 简体中文

根目录的 [MIT 许可证](LICENSE) 适用于 Ensemble 自有代码。以下组件及改写部分继续保留各自的版权与许可证。`licenses/` 保留上游许可原文，中文说明不替代这些原文。

## 界面组件与交互

采用 [Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui) 提交 `4045ce76afdcb7dccef1b7e6417b04c4c6046e9c` 中的部分代码，适用 MIT。版权为 Copyright (c) 2026 Caho1，完整许可见 [licenses/Open-Claude-UI-MIT.txt](licenses/Open-Claude-UI-MIT.txt)。

| Ensemble 文件 | 上游文件 | 修改情况 |
| --- | --- | --- |
| `src/renderer/vendor/open-claude-ui/CdsButton.tsx` | `code-examples/CdsButton.tsx` | 保留独立绘景层、加载态与原生属性，改用 Ensemble 的 CSS 和语义配色。 |
| `src/renderer/vendor/open-claude-ui/ClaudeMotionPresets.ts` | `code-examples/ClaudeMotionPresets.ts` | 共用动画变体采用短时过渡、无弹跳和较小位移。 |
| `src/renderer/vendor/open-claude-ui/cds-foundations.css` | `code-examples/cds-theme.css` | 摘取几何与缓动令牌，按控件、区域和浮层统一尺寸。 |
| `src/renderer/vendor/open-claude-ui/useClaudeScrollPinning.ts` | `code-examples/useClaudeScrollPinning.ts` | 采用底部吸附容差、用户滚动冷却和跳至最新行为，适配本地类型与手动滚动。 |

采用范围限于上表的界面代码与交互。消息、审批、工具结果和任务完成状态来自 Ensemble 的运行记录。

## MIT 辅助模块

以下模块来自 [stablyai/orca](https://github.com/stablyai/orca)，适用 MIT。版权为 Copyright (c) 2026 Lovecast Inc.，完整许可见 [licenses/Orca-MIT.txt](licenses/Orca-MIT.txt)。源码头保留来源与修改说明。

`src/main/vendor/orca/porcelain-v1-records.ts` 来自提交 `6fcc183ab951fb751cf02ccb9e2af3cf129a4316` 的 `src/main/git/porcelain-v1-records.ts`，保留 rename/copy 原路径，供按路径读取差异使用。

其余模块固定于提交 `36913fd4f556c44495ed6da5cd6a81910c3cde21`：

| Ensemble 文件 | 上游文件 | 修改情况 |
| --- | --- | --- |
| `src/main/vendor/orca/attachment-name.ts` | `src/shared/agent-session-attachments.ts:57–110` | 摘取附件命名，适配本地类型、受限 UTF-8 截断和 ES2022 查找。 |
| `src/main/vendor/orca/task-list.ts` | `src/shared/native-chat-task-list.ts:1–70` | 摘取任务列表类型与解析。 |
| `src/renderer/vendor/orca/diff-comments-format.ts` | `src/shared/diff-comments-format.ts` | 使用本地批注类型，保留确定格式与转义。 |
| `src/main/vendor/orca/notification-burst-cooldown.ts` | `src/shared/notification-burst-cooldown.ts` | 采用冷却与有界去重，调整本地命名与格式。 |
| `src/main/vendor/orca/mcp-config.ts` | `src/shared/mcp-config.ts` | 函数体未改，补来源头。 |
| `src/main/vendor/orca/mcp-server-inspection.ts` | `src/shared/mcp-server-inspection.ts` | 函数体未改，补来源头。 |
| `src/main/vendor/orca/mcp-config-inspection-limits.ts` | `src/shared/mcp-config-inspection-limits.ts` | 函数体未改，补来源头。 |
| `src/main/vendor/orca/utf8-byte-limits.ts` | `src/shared/utf8-byte-limits.ts` | 仅摘取 UTF-8 测量、码点读取和所需返回类型。 |
| `src/main/vendor/orca/skill-metadata.ts` | `src/shared/skill-metadata.ts` | 保留元数据解析，使用本地摘要类型。 |

## 原子保存流程改写

`src/main/workspace-files.ts` 中的原子保存流程改写自 [getpaseo/paseo](https://github.com/getpaseo/paseo) 提交 `05920a236cb6ba8eeae128ee7bb6677cc226cd3a` 的 `packages/server/src/server/file-explorer/service.ts:433–531`。

版权为 Copyright (c) 2025-present Mohamed Boudra。改写部分适用 Apache-2.0，完整上游版权与许可原文保留在 [licenses/Paseo-Apache-2.0.txt](licenses/Paseo-Apache-2.0.txt)。固定版本的上游归档没有根 NOTICE 文件。

采用的流程包括同目录独占临时文件、写入并同步、再次比较版本、重命名和最终清理。Ensemble 使用自己的路径边界、内容与文件身份版本、共用写操作队列和错误处理。源码头注明这些修改。该部分继续遵循 Apache-2.0，根目录对自有代码的 MIT 授权不替代其条款。

## 协议与界面依赖

`src/main/application-updates.ts` 与 `bin/apply-app-update.sh` 的更新检查、受限 SHA-256 下载、同目录暂存和整目录回滚流程，改写自 [zszz3/AgentRecall](https://github.com/zszz3/AgentRecall) 提交 `e130f72a1a34a87e4065d9f85f7733bdf632f1b6` 的 `apps/main-1.0/bin/update-client.cjs` 和 `apps/main-1.0/bin/apply-update.cjs`。版权为 Copyright (c) 2026 AgentRecall contributors，MIT 原文保留在 [licenses/AgentRecall-MIT.txt](licenses/AgentRecall-MIT.txt)。Ensemble 改为替换完整 macOS App，增加独立后台停机守卫、压缩包与应用校验，以及新版界面就绪确认；不复用 npm 安装器，也不改动 macOS 安全策略。

- `@agentclientprotocol/sdk@1.9.0`：Apache-2.0。
- `@modelcontextprotocol/sdk@1.32.1`：MIT；Copyright (c) 2024 Anthropic, PBC。
- CodeMirror 相关包：MIT；许可注明 Copyright (C) 2018-2021 by Marijn Haverbeke and others。
- `@xyflow/react@12.12.0`：MIT；Copyright (c) 2019-2025 webkid GmbH。见 [licenses/React-Flow-MIT.txt](licenses/React-Flow-MIT.txt)。
- `elkjs@0.12.0`：EPL-2.0，未修改使用。见 [licenses/ELK-EPL-2.0.md](licenses/ELK-EPL-2.0.md)，对应源码位于 [kieler/elkjs 0.12.0](https://github.com/kieler/elkjs/tree/v0.12.0)。
- `framer-motion@11.18.2`：MIT。
- `@tanstack/react-virtual@3.14.22` 与 `@tanstack/virtual-core`：MIT；Copyright (c) 2021-present Tanner Linsley。用于可变高度的对话虚拟列表。

其余直接依赖与传递依赖保留各自许可。精确版本以 `package-lock.json` 为准，各依赖包保留其许可文件。应用打包保留生产依赖和本仓库的 `licenses/` 目录。本文件记录来源，不替代适用的许可证。

## 运行时品牌素材

`src/renderer/assets/providers/` 下的 Logo 用于标识受支持的运行时。相关商标及图形归 OpenAI 和 Anthropic 所有，不属于 Ensemble 的 MIT 授权范围。展示这些标识不代表官方背书。

- `codex-light.png` 与 `codex-dark.png`：原样取自 OpenAI 官方 macOS 应用 `26.1016.61520`（构建 `21421`，标识 `com.openai.codex`）中的 `icon-codex-light.png` 和 `icon-codex-dark-color.png`。参见 [Codex](https://openai.com/codex/) 与 [OpenAI 品牌规范](https://openai.com/brand/)。
- `claude.svg`：原样取自 [Anthropic 官方媒体素材包](https://www.anthropic.com/press-kit)中的 `Claude Spark - Clay.svg`，获取日期为 2026 年 10 月 23 日。[原始压缩包](https://www-cdn.anthropic.com/ae59ca4ca194dac9c9dc3bc78c5829468cb0e8af.zip)。
