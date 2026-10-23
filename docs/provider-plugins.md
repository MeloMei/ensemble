# Provider plugins

English | [简体中文](provider-plugins.zh-CN.md)

Place each local plugin in its own subdirectory of the plugin directory, with a `manifest.json`, then refresh Providers in the app. Plugins run with the permissions of the current local user, so only load code you trust. Each turn starts one child process without a shell. The built-in IDs `codex`, `claude`, `opencode`, `deepseek-harness`, and `cursor` are reserved. Plugins using a reserved ID are rejected; if multiple plugins use the same ID, all of them are rejected.

## Manifest

`manifest.json` must contain exactly these fields. All fields are required, including both capability flags; extra fields are rejected in both the manifest and `capabilities`.

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

| Field | Constraint |
| --- | --- |
| `apiVersion` | Must be `1`. |
| `id` | Length 1–64; starts with a lowercase letter and contains only lowercase letters, digits, and `-`. |
| `name` | Length 1–80. |
| `command` | Nonblank string, maximum length 8,192, with no NUL character. |
| `args` | At most 128 strings; each has a maximum length of 8,192 and must not contain NUL. |
| `capabilities.resume` | Boolean. |
| `capabilities.approvals` | Boolean. |

String length limits use JavaScript string length. The manifest file is limited to 64 KiB.

`command` must be an absolute executable path or a path relative to the directory containing the manifest. It is never looked up in `PATH`. Scripts need a shebang and executable permissions; alternatively, use an absolute interpreter path as `command` and an absolute script path in `args`. The process working directory is the project directory selected for the session. Arguments are passed unchanged, without variable or wildcard expansion. If the executable is missing, is not a file, or lacks the required executable permission, the provider is listed as unavailable.

## Turn input

The app writes one UTF-8 JSONL message to stdin to start the turn:

```json
{"type":"turn","sessionId":"local-session-id","externalId":"optional-provider-session-id","cwd":"/absolute/project","prompt":"User task"}
```

`externalId` is included only when resuming an existing provider session. A plugin declaring `resume: true` is responsible for passing this ID to its runtime and emitting `external-id` for a newly created provider session. A plugin without resume support cannot emit `external-id` or resume a session that already has an `externalId`.

Protocol `apiVersion: 1` accepts text prompts only. File and image attachments are not supported. The app rejects a turn containing attachments before starting the plugin process; it never drops them from a successful turn. Remove the attachments or select a built-in provider that supports them.

## Output and approvals

Use stdout only for protocol events, with one JSON object per line. Write diagnostic logs to stderr.

```jsonl
{"type":"external-id","id":"provider-session-id"}
{"type":"activity","text":"Reading the project"}
{"type":"text","itemId":"answer-1","text":"Answer fragment"}
{"type":"text","itemId":"answer-1","text":"Complete answer","replace":true}
{"type":"approval","id":"approval-1","title":"Allow this command?","detail":"npm run build","choices":[{"id":"allow","label":"Allow"},{"id":"deny","label":"Deny"}]}
```

`text` appends to the message with the same `itemId` by default; `replace: true` replaces that message. `itemId` must be nonempty and have a maximum length of 256. An `external-id` ID must be nonempty and have a maximum length of 1,024.

Approval requests require `approvals: true`. Each approval ID can be used only once within a process. Approval IDs and choice IDs must be nonempty and have a maximum length of 256. Each approval needs a nonempty `title`, a string `detail`, and 1–20 choices. Each choice needs a unique `id` within that approval and a nonempty `label`.

After the user selects a choice, the app writes this response to stdin:

```json
{"type":"approval-result","id":"approval-1","choiceId":"allow"}
```

All fields shown for each stdout event are required except `text.replace` and `result.error`. Extra fields, including fields inside approval choices, and unknown event types cause a protocol error and terminate the process.

## Completion and process exit

Emit exactly one `result` when the turn ends, then exit. The app closes stdin after receiving the result, and the process must exit within 3 seconds. Success requires both `status: "completed"` and exit code `0`. A missing result, a nonzero exit code, a duplicate result, or any event after the result prevents successful completion. A plugin cannot emit `completed` while any approval is unanswered.

```jsonl
{"type":"result","status":"completed"}
```

Use `{"type":"result","status":"failed","error":"Specific reason"}` for failure and `{"type":"result","status":"cancelled"}` for cancellation. `error` is an optional string. A `cancelled` result is reported as cancellation.

The process must also close its output streams. If output remains open for 1 second after the process exits, the turn fails.

## Payload limits and cleanup

Each stdout line is limited to 1 MiB of UTF-8 bytes before the LF delimiter. A CR in CRLF counts toward that limit. UTF-8 characters split across chunks and CRLF line endings are supported. Invalid UTF-8 or malformed JSON causes a protocol error. The app retains only the last 8 KiB of stderr for failure diagnostics.

Cancellation and protocol errors terminate the process group. On macOS/Linux, the app sends `SIGTERM`, followed by `SIGKILL` after 500 ms if processes remain. On Windows, it uses `taskkill /T /F`. The app also cleans up remaining processes in the group when the turn settles. Plugins should keep their child processes in that group and must not detach long-running processes from it.
