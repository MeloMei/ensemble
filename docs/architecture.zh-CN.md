# 架构

[English](architecture.md) | 简体中文

Ensemble 在 Electron 窗口中展示本机 Agent 会话、文件、终端和协作。执行与持久化状态由独立后台管理。桌面应用、CLI 和 MCP 客户端连接同一个后台，共用调度器和数据库。

## 源码位置

| 位置 | 职责 |
| --- | --- |
| `src/renderer/` | React 界面、聊天、协作视图、CodeMirror 编辑器、xterm 终端和外观。 |
| `src/preload/index.ts` | 通过 Electron 隔离桥接暴露带类型的 `window.workbench` API。 |
| `src/main/index.ts` | Electron 生命周期、窗口、IPC 转发、原生对话框、外部链接和通知。 |
| `src/main/backend-entry.ts` | 独立后台进程的启动入口。 |
| `src/main/backend-client.ts` | 后台发现、启动、带认证的命令调用和状态订阅。 |
| `src/main/backend-server.ts` | 本机 loopback HTTP 服务，提供管理命令、状态快照和外部 MCP。 |
| `src/main/workbench-service.ts` | 创建共享服务，注册应用命令。 |
| `src/main/collaboration-core.ts` | 协作定义、运行、权限、任务派发、消息、产物和事件。 |
| `src/main/engine.ts` | Provider 会话、执行尝试、审批、项目执行守卫和 Provider 事件。 |
| `src/main/store.ts` | SQLite 持久化、事务、迁移和重启恢复。 |
| `src/main/providers/` | 原生 Provider 适配器、协议处理和插件加载。 |
| `src/main/cli.ts` | 本机管理 CLI。 |
| `src/main/mcp-server.ts`、`mcp-tool-catalog.ts`、`mcp-stdio.ts`、`collaboration-server.ts` | MCP 工具定义，以及外部或托管会话使用的传输方式。 |
| `src/shared/` | 跨进程共用的类型、协作 schema、后台接口和应用标识。 |

后台模块直接放在 `src/main/` 下，没有独立的后台源码目录。测试与被测源码放在一起。

## 桌面请求如何执行

1. React 组件调用 `window.workbench`，接口类型由共享的 `WorkbenchAPI` 定义。
2. preload 桥接调用指定的 Electron IPC 命令。renderer 没有 Node 集成，窗口启用了上下文隔离和 Electron sandbox。
3. Electron 主进程检查请求来源，再通过 `BackendClient` 转发服务命令。原生窗口操作、对话框、链接和通知留在 Electron 进程。
4. 后台认证请求，调用 `createWorkbenchService` 注册的处理函数。
5. 处理函数调用 engine、协作核心、工作区文件或运行时设置等服务。状态变化交给按订阅范围组织的投影，不复制所有会话历史。
6. 后台通过 `/events` 发送有版本的 reset 和 delta，Electron 重建订阅视图后通过 IPC 转给 renderer。连接状态与缓存内容分开，终端使用独立的 tail/append 流。

preload 只暴露应用 API。参数校验和执行权限由后台服务、Provider 适配器负责。

## 桌面、CLI 和 MCP 共用后台

`connectBackend` 读取 `backend.json`，通过带认证的健康检查核对后台实例，必要时启动独立进程。桌面应用和 CLI 使用相同的发现方式和数据目录。

`bin/workbench` 使用 Electron 的 Node 模式运行已构建的 CLI，提供 `status`、`connect`、`revoke` 和 `stop`。CLI 签发 MCP 身份时，也调用桌面界面使用的 workbench service。

外部 MCP 客户端使用可撤销的身份连接后台 `/mcp`。stdio 桥接把调用转发到这个接口。后台认证身份后，将调用交给 `CollaborationCore`。协作核心检查身份策略、运行授权、参与者权限和所请求的操作。

托管 Provider 的每个回合通过 `CollaborationServer` 获得临时 MCP 配置。调用携带会话和执行尝试身份，最终仍由同一个协作核心处理。临时连接随回合结束，不另建任务存储或调度器。

后台监听 `127.0.0.1`。管理命令使用本机管理 token，外部 MCP 使用已签发的身份 token。`backend.json` 以 `0600` 权限写入。连接本机地址本身不会授予 MCP 参与者访问所有运行或目录的权限。

## 调度和 Provider 执行

`CollaborationCore` 保存有版本的协作定义，并为每次运行保留快照。参与者的权限需要明确配置，角色名称不会授予权限。任务保留当时的参与者配置、输入、执行尝试和结果。协作核心检查依赖和配置上限后，通过 `WorkbenchEngine` 派发托管任务。旧版工作流界面也将执行委托给这个协作核心。

engine 管理原生 Provider 会话及执行尝试，通过统一的适配器接口处理流式文本、工具事件、审批、用量和原生会话 ID。内置适配器分别使用 Codex app-server、Claude Code stream-json，以及 OpenCode、DeepSeek Harness 的 ACP。可用性、认证、续聊和权限行为取决于适配器及原生运行时。Cursor 目前仍是不可用的占位项。

项目执行守卫协调同一工作树内的写入。同一工作树的执行排队，不重叠的独立目录可以并行，重叠目录不能声明为独立执行。托管回合等待同目录任务时，会结束当前活动回合；依赖任务完成后，平台继续已保存的原生会话。

外部执行者领取任务后，使用记录中的执行尝试 ID 提交结果。平台能展示经它交换的消息、产物和事件，无法推断外部客户端内部的动作，也不能保证普通 MCP 客户端会自动唤醒原会话。

## 存储和生命周期

后台持有 `StateStore`，客户端不直接打开数据库。`state.sqlite` 保存状态快照、协作事件和写操作回执。协作状态、事件序号和幂等回执在同一个事务中提交。客户端使用稳定的 `requestId` 重试写操作，可以避免重复执行同一操作。

macOS 数据目录保留兼容名称 `Agent Workbench`。SQLite 尚无状态快照时，会导入已有的 `state.json`，并保留原文件。所有入口都可以通过 `WORKBENCH_DATA_DIR` 选择其他数据目录。

关闭桌面窗口只断开该客户端，后台继续运行。stdio 桥接退出也只关闭连接。要停止后台，先退出桌面应用，再执行 `bin/workbench stop`。保持打开的桌面客户端会尝试重连并重新启动后台。

后台重启时，未完成的执行会标记为中断，需要显式继续。成功任务不会自动重派。终端进程不会在重启后恢复。附件和协作产物作为文件保存在数据库旁，由对应服务校验。

普通会话创建、发送、取消和问答共用 SQLite 事务收据。运行中的补充消息保存在下一轮队列，保留当时模型、设置和附件；停止、失败或后台重启后暂停。Codex 依据 clientUserMessageId 核对原生历史，失去确认时保留 unknown，不因文本相同去重或自动重发。attention 与 seen revision 单独持久化，阅读不会改变任务结果。

桌面 Stop 请求携带点击时的 attempt ID，后台在同一事务内核对后才取消任务或暂停队列。尚未进入物理执行的 Codex pending 消息，在取消或排队状态恢复后标为 rejected；执行开始后中断的消息仍保持 unknown。普通、托管和协作执行共用投递守卫。并行新增的每一条审批都会推进 attention revision。

选中会话取得有界最近历史，旧消息和搜索窗口按需读取；未订阅会话省略草稿与排队消息正文。运行时状态分别记录入口、协议、模型目录、认证证据和额度，缺乏来源就显示未知。DeepSeek API 余额不能自动等同于 Harness 账户余额。

订阅尾部按消息条数限制，单条正文保持完整。帧超过 8 MiB 时会明确说明大小限制并断开该订阅，保留旧内容；切换到较小会话后可以恢复同步。已回收工作区的历史会话仍可临时只读查看，不会重新创建目录。

watch 更新失败会中止它所属的订阅，再按期望会话重连；renderer 重载或退出会释放视图订阅。实时尾部重置会使基于旧尾部的分页请求失效。认证结果归到派发时捕获的实际适配器身份，旧运行时不能替刷新后的运行时确认认证。

受管 worktree 使用持久创建意图记录仓库、分支、起始 SHA 和归属，同一命令可恢复创建。回收要求无运行或排队任务、活跃终端、进行中的文件或配置操作、未提交文件、尚未合入来源仓库的提交。桌面端有任何未保存文件时也会阻止回收。根目录和子目录别名共用回收守卫。删除 Git 目录前先持久保存 removing 状态及分支提交，操作中断后可以继续回收；已回收记录可防止旧会话在重启后重新创建工作区。平台不会强制删除用户目录，也不自动执行项目 setup 脚本。

创建记录和 checkout 前，来源子目录必须已保存在起始提交中。原生运行、投递历史核对和回退调用共用按会话归因的诊断。

诊断默认只记录有界生命周期元数据，最多保留 512 KiB、1000 条。用户明确开启后才记录脱敏协议形状：仅保留已知结构字段和枚举，正文、未知字段名和原生标识匿名化，数字和布尔值使用类型占位。平台会话、尝试和运行时 ID 保留，用于关联记录。离线回放复用现有 NDJSON 解码器检查结构和顺序，不能恢复原始内容或保证复现所有语义。后台重启默认关闭协议形状采集。

桌面状态订阅要求 stream version 2。不兼容的旧后台保留其任务继续运行；管理 CLI 仍可连接旧实例，用户可在合适时间停止旧后台再启动新版。

## 构建和许可

Vite 构建 renderer。esbuild 将 Electron 主进程、preload、独立后台、CLI 和 stdio 桥接构建到 `dist/`。当前打包脚本面向 macOS，使用主机架构，执行并验证 ad hoc 签名。脚本没有提供 Developer ID 签名、公证或 Windows/Linux 打包路径。

开发命令和局部验证见[开发说明](development.zh-CN.md)。许可条款见根目录的 [LICENSE](../LICENSE)，第三方许可与归属见 [THIRD_PARTY_NOTICES.zh-CN.md](../THIRD_PARTY_NOTICES.zh-CN.md)。
