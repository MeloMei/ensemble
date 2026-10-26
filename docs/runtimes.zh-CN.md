# 运行时

[English](runtimes.md) · 简体中文

Ensemble 在会话选定的项目目录中启动本机 Agent 运行时。运行时需要你自行安装并完成认证。Ensemble 不自带这些 CLI，包括 OpenCode 和 DeepSeek Harness。

当前桌面流程面向 macOS。适配器使用运行时的原生协议，可用性和功能取决于已安装版本。检测到程序或模型目录，不表示认证、账户额度或模型访问已成功。

## 安装与配置

安装和认证步骤以官方指南为准。**接入与插件** 页面提供相同入口，填写协作时也可以打开 **接入与登录帮助**。

| 运行时 | 安装 | 认证与配置 |
| --- | --- | --- |
| Codex | [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | [认证说明](https://learn.chatgpt.com/docs/auth) |
| Claude Code | [快速开始](https://code.claude.com/docs/en/quickstart) | [认证说明](https://code.claude.com/docs/en/authentication) |
| Pi | [Pi 官网](https://pi.dev/) · [快速开始](https://pi.dev/docs/latest/quickstart) | [认证与模型](https://pi.dev/docs/latest/models) |
| OpenCode V2 | [OpenCode 2](https://opencode.ai/v2/docs/) | [V2 模型提供商](https://opencode.ai/v2/docs/providers/) |
| DeepSeek Harness | [官方应用与源码](https://www.deepseek.com/en/harness/) | [配置模型](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers) |

OpenCode 请使用 **V2** 指南：V1 使用相同的程序名，可能替换已有 V2 安装。Ensemble 使用独立的免费模型配置，提供商指南属于补充资料，不代表需要购买付费 OpenCode Provider。

DeepSeek Harness 需要提供本机可发现的 `dsh` CLI，Ensemble 使用其[官方 ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md)。它不能担任“实现与审阅”模板中的只读审阅者。

完成安装或配置后，回到 Ensemble 点击 **刷新检测**。发现入口后，仍需通过实际任务确认认证和模型访问。

## 查找运行时

安装运行时后，打开 **接入与插件 → 刷新检测**。以下环境变量指向可用程序时，会优先于常规位置使用：

| 运行时 | 环境变量 | 其他查找位置 |
| --- | --- | --- |
| Codex | `CODEX_BINARY` | `PATH`、macOS 标准 Codex/ChatGPT 应用位置、`~/.local/bin`、`~/.cargo/bin` |
| Claude Code | `CLAUDE_BINARY` | `PATH`、`~/.local/bin`、Homebrew 位置、已安装的 nvm 版本 |
| Pi | `PI_BINARY` | `PATH`、`~/.local/bin`、Homebrew 位置、已安装的 nvm 版本 |
| OpenCode V2 | `OPENCODE_BINARY` | macOS 标准 OpenCode 应用位置、`PATH`、`~/.opencode/bin`、`~/.local/bin` |
| DeepSeek Harness | `DSH_BINARY` | `PATH`、macOS 标准 DeepSeek Harness 应用位置、`~/.local/bin` |

环境变量需要传给启动后台的进程。后台已经运行时，先退出桌面应用，执行 `bin/workbench stop`，再带新环境重新启动。刷新检测不会替换已有后台的环境变量。

## Codex

适配器启动 `codex app-server --listen stdio://`，使用本机 Codex 配置和登录状态。模型列表和推理选项来自原生目录，目录不代表账户额度。

Codex 支持原生续聊、工具和计划事件、审批及已接入的问答形式。所选模型声明支持图片时，可以发送图片。遇到不支持的原生请求时，本轮会停止，不会代造答案。

只读会话使用 Codex 原生只读沙箱，网络访问仍然开启。Ensemble 在该模式下拒绝命令、文件写入和权限升级请求。项目 MCP 服务与协作授权是独立能力，需要同时检查。

对话回退需要原生分页历史。只有原生回退成功后，Ensemble 才改变本地历史。回退不会恢复项目文件。运行时报会话锁或无法恢复原会话时，会保留错误，不会悄悄替换原生会话 ID。

**Codex App** 按钮是单独的官方应用入口。它通过 `codex://threads/new` 预填新会话，由你在官方应用内发送任务，输出不会回传 Ensemble。

## Claude Code

适配器使用官方 CLI 的双向 `stream-json` 接口。认证和服务地址沿用现有 CLI 配置及环境变量，Ensemble 不会替换。界面读取 Claude 设置中已配置的 `haiku`、`sonnet`、`opus` 映射；未选择模型时，CLI 继续使用当前默认配置。

接入支持图片、文本、工具、计划、原生子 Agent、任务事件、问答、审批和原生续聊。原生任务或审批尚未结束时，不能仅凭进程退出判定成功。

只读使用原生 `plan` 模式，并在适配器内限制工具。未经过只读验证的工具会被拒绝，包括 shell 命令、文件编辑和未知 MCP 工具。已认证的 Ensemble 协作工具使用另行签发的授权。这是工具权限控制，不是操作系统文件沙箱。

每轮 MCP 配置通过权限为 `0600` 的临时文件传入，结束后清理。当前不支持原生对话回退，可以用上下文分叉准备新会话。

## Pi

请通过 npm 安装官方包 `@earendil-works/pi-coding-agent`，版本需为 **1.3.0 或更新版本**。适配器需要官方包提供的 SDK、RPC 接口和原生 MCP。包或协议能力不兼容时，检测或本轮任务会停止，不会自动改用其他运行时。自动查找不到时，可以用 `PI_BINARY` 指向该包的 `pi` 程序。

先按[官方模型指南](https://pi.dev/docs/latest/models)在 Pi CLI 中完成认证并选择默认模型。Ensemble 沿用全局 Pi 认证、模型配置和环境变量。模型列表来自 Pi 原生目录。显式选择的模型和思考档必须由运行时提供并确认，才会发送提示。图片附件要求所选模型声明支持图片输入。

每轮启动独立的 RPC 进程。原生对话文件保存在 Ensemble 数据目录的 `pi/sessions` 下，续聊时复用。原文件无法恢复时，本轮失败，不会另建对话代替。接入支持流式文本、文本和图片附件、工具事件及运行时报告的 token 用量。Ensemble 当前未接入 Pi 原生回退和执行中的实时引导。

任务可能已被接收、但确认响应丢失时，投递状态会保留为未知，并阻止直接重发。当前未接入 Pi 历史投递核对；需要继续时，可以先用上下文分叉准备新草稿。

Ensemble 加载临时受控扩展，不加载用户自定义扩展和项目 Pi 配置。全局认证与模型设置仍可使用，依赖自定义扩展的工具和模型提供商不会加载。扩展允许标准 read、grep、find 和 ls 工具。普通审批模式下，命令执行、文件写入及其他工具每次调用都需要审批；只读模式拒绝这些工具。这是工具权限控制，不是操作系统沙箱。

受控扩展把已配置的 stdio 和 HTTP 服务交给 Pi 原生 MCP，不支持 SSE。已认证的 Ensemble 协作工具使用另行签发的授权，文件只读模式不会取消协作权限。工具守卫和 Ensemble MCP 工具就绪后，才会发送提示。进程关闭后会清理临时扩展及配置。

## OpenCode V2

请单独安装 OpenCode V2。Ensemble 通过其 `acp` 命令接入。ACP 是 Agent Client Protocol，用于交换会话、提示、工具事件和权限请求。

检测时，Ensemble 从 `https://models.opencode.ai/api.json` 读取官方模型目录。只接入未废弃、声明价格均为零、支持文本输入输出及工具调用的模型，默认使用 `opencode/big-pickle`。Big Pickle 未被确认为免费、目录读取失败，或原生 ACP 未提供所选免费模型时，适配器会停止，不会切换到收费模型。

OpenCode 使用 Ensemble 数据目录下的独立 profile。适配器禁用项目配置，只允许使用公开端点 `https://opencode.ai/inference/openai/v1`，不沿用用户个人 OpenCode 的 provider 凭据或模型配置。

只读使用原生 `plan` 模式，工具默认拒绝。仅开放读取、glob、grep、Skill、问答和已认证的 Ensemble 协作工具。shell 命令、文件编辑、Code Mode 执行和未知 MCP 工具继续拒绝。读取 `.env` 文件需要审批，`.env.example` 除外。这不是操作系统文件沙箱。发送提示前，原生运行时必须确认所选权限模式。

托管协作会使用临时插件，在首次提示前等待 Ensemble MCP 工具完成原生注册。30 秒内未就绪时，不发送任务。进程关闭后清理插件。

公开网关可能拒绝请求或受限工具配置。Ensemble 会保留错误并停止本轮，不会放宽只读权限来绕过网关拒绝。

## DeepSeek Harness

请单独安装 DeepSeek Harness CLI，可以通过其应用或命令行安装。Ensemble 启动 `dsh --profile acp`，并传入临时配置覆盖文件。

适配器只选择原生 `deepseek-official` 下的 Flash，使用 `https://api.deepseek.com/anthropic`。覆盖配置将推理设为 `off`，每次模型请求最多输出 4096 tokens。原生提供推理选项时，默认依次选择 `off`、`low`；用户明确选择的档位必须由原生提供并确认。一轮可能包含多次模型请求，因此这个输出限制不代表整轮 token 或费用上限。

原生凭据解析方式继续保留。后台环境没有非空 `DEEPSEEK_API_KEY` 时，Ensemble 只在默认 Claude 设置中的 endpoint 去除末尾斜杠后等于 `https://api.deepseek.com/anthropic` 时，尝试读取其 token 或 key。凭据仅在内存中传给子进程，不修改设置文件，也不存入会话。这个可选来源不可用时，Harness 仍可使用原生凭据存储。

原生只读模式尚未验证。选择只读时，Ensemble 会在发送提示前拒绝。普通审批模式会以 `DSH_PERMISSION_MODE=workspace-write` 启动；需要只读执行时，不要选这个运行时。

进程关闭后会清理临时覆盖文件。Flash 路由缺失或未获原生确认时，本轮停止。

## 共同边界

- OpenCode 和 DeepSeek Harness 每轮启动新的 ACP 进程。原生声明支持 resume 或 load 时，才按原会话 ID 续接；恢复失败不会自动新建替代会话。
- ACP 的模型、推理和权限选项必须由原生提供并确认。不支持的选项会停止任务。审批仅展示原生提供的单次允许或拒绝选项。
- 图片传输协议可用，不代表所有模型都能理解图片。ACP 上下文占用、运行时 token 和官方账户余额分别记录。
- DeepSeek 余额由用户主动查询。各币种分别保留，不相加、不换算。用量计数不等于账单，也不能证明没有费用。
- Claude Code、Pi、OpenCode 和 DeepSeek Harness 当前不支持 Ensemble 内的原生对话回退。上下文分叉会生成可编辑草稿，发送后才开始新任务。
- 文件只读和协作权限分别配置。角色名称不会授予权限。外部 Agent 沿用自身原生权限；Ensemble 只记录它通过 MCP 交换的任务、消息和产物。
- 运行时出错会停止本次执行尝试。协作可以按运行配置的上限重试，失败记录会保留。后台重启后，未完成工作会中断，需要明确恢复。

安装和后台生命周期见[开始使用](getting-started.zh-CN.md)。自定义本地运行时见 [Provider 插件](provider-plugins.zh-CN.md)。
