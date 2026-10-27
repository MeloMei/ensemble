# Provider 插件

[English](provider-plugins.md) | 简体中文

把每个本地插件放在插件目录的独立子目录里，提供 `manifest.json`，再在 App 中刷新 Providers。插件以本机当前用户权限运行，只加载自己信任的代码。每个 turn 启动一个子进程，不使用 shell。内置 ID `codex`、`claude`、`pi`、`gemini`、`cursor`、`qoder`、`opencode`、`deepseek-harness` 保留，使用这些 ID 的插件会被拒绝加载。如果多个插件使用同一 ID，这些插件全部拒绝加载。

## 协议版本

版本 1 继续支持原有严格的纯文本契约。下文未单独说明的章节描述版本 1。

版本 2 在发送任务数据前增加能力握手。Manifest 保留同一组字段，把 `apiVersion` 改为 `2`，只声明已实现能力。`resume`、`approvals` 仍为必填布尔值。可选布尔值有 `images`、`textAttachments`、`structured`、`usage`、`questions`、`effort`、`permissions`。当前插件协议没有实现原生 `rewind` 和 `steer` 操作，不能将这两项声明为 true。

宿主先发送：

```json
{"type":"initialize","apiVersion":2,"host":"Ensemble","capabilities":{"resume":true,"approvals":true,"images":true,"structured":true}}
```

插件必须在五秒内回复：

```json
{"type":"ready","apiVersion":2,"capabilities":{"resume":true,"approvals":true,"images":true,"structured":true}}
```

实际能力可以是 Manifest 声明的子集。增加未声明能力、在 `ready` 前发送输出、重复发送 `ready`，都会使进程失败。如果实际能力不能处理本次附件或设置，平台在发送任务正文前拒绝该回合。

版本 2 的 `turn` 增加 `apiVersion`、稳定的 `clientUserMessageId`、`settings`、可选 `modelId` 和 `attachments`。附件包含 `id`、`name`、`kind`、`mimeType`、`size`、`sha256`、`encoding: "base64"`、`data`，不发送平台保存文件的本地路径。图片需要 `images`，UTF-8 文本文件需要 `textAttachments`。思考档和权限设置也分别要求声明并协商相应能力。Skill 内容继续经过现有提示词准备流程。

可选输出帧使用与内置适配器相同的规范化事件：

```jsonl
{"type":"native-turn","turnId":"turn-1"}
{"type":"structured","event":{"id":"tool-1","kind":"tool","title":"读取文件","status":"completed"}}
{"type":"usage","usage":{"id":"turn-1","source":"my-agent","scope":"turn","inputTokens":100,"outputTokens":20,"createdAt":"2026-10-23T00:00:00.000Z"}}
```

`structured`、`usage` 分别要求声明并协商对应能力。Usage 是插件报告的值，不是平台计费保证。结构化事件还接受可选 `nativeId`、`parentId`、`input`、`output` 和计划 `entries`；字符串和数组有运行时 schema 上限。

版本 2 的审批可以带 `questions`，字段为 `id`、`question`、`header`、`options`（label 和可选 description）、`multiSelect`、可选 `allowCustomAnswer`。问题 ID 必须唯一，并要求协商 `questions` 能力。只有问题时，`choices` 可以为空。回答帧为 `{"type":"approval-result","id":"request-id","answers":{"question-id":["选项 label"]}}`；普通审批仍接收 `choiceId`。

原有 result、退出、帧大小、取消和进程树清理规则同时适用于两个版本。版本 2 不授予界面扩展能力，也不构成操作系统沙箱。

## 版本 1 Manifest

`manifest.json` 必须精确包含以下字段。所有字段都必填，包括两个能力开关；manifest 和 `capabilities` 都不接受额外字段。

```json
{
  "apiVersion": 1,
  "id": "my-agent",
  "name": "My Agent",
  "command": "./agent",
  "args": [],
  "capabilities": { "resume": true, "approvals": true }
}
```

| 字段 | 限制 |
| --- | --- |
| `apiVersion` | 必须为 `1`。 |
| `id` | 长度 1–64；以小写字母开头，只含小写字母、数字和 `-`。 |
| `name` | 长度 1–80。 |
| `command` | 不能是空白字符串，长度最多 8,192，不能包含 NUL 字符。 |
| `args` | 最多 128 个字符串；每个字符串长度最多 8,192，不能包含 NUL。 |
| `capabilities.resume` | 布尔值。 |
| `capabilities.approvals` | 布尔值。 |

字符串长度按 JavaScript 的字符串长度计算。manifest 文件上限为 64 KiB。

`command` 必须是可执行文件的绝对路径，或相对 manifest 所在目录的路径。它不会从 `PATH` 查找。脚本需要 shebang 和执行权限，也可以把解释器的绝对路径作为 `command`，脚本的绝对路径放进 `args`。进程的工作目录是会话选择的项目目录。`args` 原样传给进程，不展开变量或通配符。如果可执行文件不存在、不是文件或缺少所需的执行权限，Provider 会列为不可用。

## Turn 输入

App 向 stdin 写入一条 UTF-8 JSONL 消息，启动本次 turn：

```json
{"type":"turn","sessionId":"local-session-id","externalId":"optional-provider-session-id","cwd":"/absolute/project","prompt":"用户任务"}
```

`externalId` 只在续接已有 Provider 会话时出现。声明 `resume: true` 的插件负责把这个 ID 交给自己的运行时，并为新建的 Provider 会话输出 `external-id`。不支持 resume 的插件不能输出 `external-id`，也不能续接已有 `externalId` 的会话。

`apiVersion: 1` 只接收文字任务，不支持文件或图片附件。带附件的任务会在插件进程启动前明确拒绝，不会丢掉附件后报告成功。请移除附件，或选择支持附件的内置运行时。

## 输出与审批

stdout 只用于协议事件，每行一个 JSON 对象。诊断日志写 stderr。

```jsonl
{"type":"external-id","id":"provider-session-id"}
{"type":"activity","text":"正在读取项目"}
{"type":"text","itemId":"answer-1","text":"回答片段"}
{"type":"text","itemId":"answer-1","text":"完整回答","replace":true}
{"type":"approval","id":"approval-1","title":"允许执行命令？","detail":"npm run build","choices":[{"id":"allow","label":"允许"},{"id":"deny","label":"拒绝"}]}
```

`text` 默认追加到相同 `itemId` 的消息，`replace: true` 替换该条消息。`itemId` 不能为空，长度最多 256。`external-id` 的 ID 不能为空，长度最多 1,024。

请求审批需要声明 `approvals: true`。每个审批 ID 在一个进程中只能使用一次。审批 ID 和选项 ID 都不能为空，长度最多 256。每次审批必须提供非空 `title`、字符串 `detail` 和 1–20 个选项。同一次审批的选项 `id` 不能重复，每个选项的 `label` 不能为空。

用户选择后，App 向 stdin 写回：

```json
{"type":"approval-result","id":"approval-1","choiceId":"allow"}
```

每种 stdout 事件展示的字段都必填，只有 `text.replace` 和 `result.error` 可省略。额外字段（包括审批选项内的额外字段）或未知事件类型会触发协议错误，并终止进程。

## 完成与进程退出

turn 结束时输出且只输出一条 `result`，然后退出。App 收到 result 后关闭 stdin，进程必须在 3 秒内退出。只有 `status: "completed"` 加退出码 `0` 才算成功。无 result、非零退出码、重复 result 或 result 后继续发送事件，都不能成功完成。还有未回答的审批时，不能输出 `completed`。

```jsonl
{"type":"result","status":"completed"}
```

失败使用 `{"type":"result","status":"failed","error":"具体原因"}`，取消使用 `{"type":"result","status":"cancelled"}`。`error` 是可选字符串。`cancelled` 结果按取消处理。

进程还必须关闭输出流。如果进程退出 1 秒后输出仍未关闭，本次 turn 会失败。

## 数据大小限制与清理

每条 stdout 行在 LF 分隔符之前最多 1 MiB，按 UTF-8 字节计算。CRLF 中的 CR 计入上限。支持跨 chunk 的 UTF-8 字符和 CRLF 换行。无效 UTF-8 或格式错误的 JSON 会触发协议错误。App 只保留 stderr 最后 8 KiB，用于失败诊断。

取消或协议错误会终止进程组。macOS/Linux 先发送 `SIGTERM`，500 ms 后仍有进程则发送 `SIGKILL`；Windows 使用 `taskkill /T /F`。本次 turn 结束时，App 也会清理组内剩余进程。插件应让自己的子进程留在该进程组中，不能脱离进程组后长期运行。
