# Runtimes

English · [简体中文](runtimes.zh-CN.md)

Ensemble launches local agent runtimes for the project directory selected in each session. You install and authenticate those runtimes yourself. Ensemble does not bundle their CLIs, including OpenCode and DeepSeek Harness.

The current desktop workflow targets macOS. These adapters use native runtime protocols; availability and supported features depend on the installed version. A detected executable or model catalog does not prove successful authentication, available quota, or model access.

## Install and configure

Use the official guides for the current installation and sign-in steps. The same links are available under **接入与插件**, and from **接入与登录帮助** while setting up a collaboration.

| Runtime | Installation | Authentication and configuration |
| --- | --- | --- |
| Codex | [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | [Authentication](https://learn.chatgpt.com/docs/auth) |
| Claude Code | [Quickstart](https://code.claude.com/docs/en/quickstart) | [Authentication](https://code.claude.com/docs/en/authentication) |
| OpenCode V2 | [OpenCode 2](https://opencode.ai/v2/docs/) | [V2 providers](https://opencode.ai/v2/docs/providers/) |
| DeepSeek Harness | [Official application and source](https://www.deepseek.com/en/harness/) | [Configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers) |

Follow the OpenCode **V2** guide: V1 uses the same executable name and can replace a V2 installation. Ensemble uses its own free-model profile; the provider guide is supplementary and does not mean you need a paid OpenCode provider.

DeepSeek Harness must provide a locally discoverable `dsh` CLI. Ensemble uses its [official ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md). It cannot act as the read-only reviewer in the implement-and-review template.

After setup, return to Ensemble and choose **刷新检测**. A discovered entry still requires a real task to confirm authentication and model access.

## Discovery

Open **接入与插件 → 刷新检测** after installing a runtime. The following environment variables override the usual discovery order when they point to a usable executable:

| Runtime | Override | Other locations checked |
| --- | --- | --- |
| Codex | `CODEX_BINARY` | `PATH`, standard macOS Codex/ChatGPT application locations, `~/.local/bin`, `~/.cargo/bin` |
| Claude Code | `CLAUDE_BINARY` | `PATH`, `~/.local/bin`, Homebrew locations, installed nvm versions |
| OpenCode V2 | `OPENCODE_BINARY` | Standard macOS OpenCode application locations, `PATH`, `~/.opencode/bin`, `~/.local/bin` |
| DeepSeek Harness | `DSH_BINARY` | `PATH`, standard macOS DeepSeek Harness application locations, `~/.local/bin` |

Set overrides in the environment that starts the backend. If it is already running, quit the desktop application, run `bin/workbench stop`, and restart with the new environment. Refreshing detection does not replace the environment of an existing backend.

## Codex

The adapter starts `codex app-server --listen stdio://` and uses the local Codex configuration and sign-in. Its model list and reasoning options come from the runtime's native catalog. The catalog is not an account quota report.

Codex supports native session continuation, images when the selected model declares image input, tool and plan events, approvals, and supported question forms. Unsupported native requests stop the turn rather than receiving an invented answer.

Read-only sessions use Codex's native read-only sandbox. Network access remains enabled. Ensemble denies command, file-write, and permission escalation requests in that mode. Project MCP services and collaboration authorization remain separate capabilities; review them as well as the file permission setting.

Conversation rewind requires native paginated history. Ensemble changes its local history only after the native revert succeeds. Rewind does not restore project files. If the runtime reports a session lock or cannot resume the original session, the error is retained instead of silently replacing the native session ID.

The **Codex App** button is a separate handoff to the official application. It pre-fills a new conversation using `codex://threads/new`; you send the task there, and its output does not return to Ensemble.

## Claude Code

The adapter uses the official CLI's bidirectional `stream-json` interface. Authentication and service endpoints come from the existing CLI configuration and environment. Ensemble does not replace them. Configured `haiku`, `sonnet`, and `opus` mappings are read from Claude settings; without a selected model, the CLI keeps its current default.

The integration handles images, text, tools, plans, native subagents, task events, questions, approvals, and native session continuation. A process exit is not enough to declare success while native tasks or approvals remain unfinished.

Read-only uses native `plan` mode together with an adapter allowlist. Tools outside the verified read-only set are denied, including shell commands, file editing, and unverified MCP tools. Authenticated Ensemble collaboration tools use their separately issued authorization. This is tool permission enforcement, not an operating system file sandbox.

Per-turn MCP configuration is passed through a temporary file with mode `0600` and removed afterward. The adapter does not provide native conversation rewind; use a context fork to prepare a new session.

## OpenCode V2

Install OpenCode V2 separately. Ensemble starts its `acp` command using ACP, the Agent Client Protocol used to exchange sessions, prompts, tool events, and permission requests.

During detection, Ensemble reads the official model catalog at `https://models.opencode.ai/api.json`. It accepts only non-deprecated models with zero declared prices, text input/output, and tool calling. The default is `opencode/big-pickle`. If Big Pickle is not confirmed free, the catalog cannot be read, or the selected free model is missing from the native ACP options, the adapter stops. It does not switch to a paid model.

OpenCode runs in a separate profile under the Ensemble data directory. The adapter disables project configuration and restricts model use to the public `https://opencode.ai/inference/openai/v1` endpoint. It does not reuse the user's personal OpenCode provider credentials or model configuration.

Read-only uses the native `plan` mode with a default-deny tool policy. It allows read, glob, grep, Skill, question, and authenticated Ensemble collaboration tools. Shell commands, file editing, Code Mode execution, and unknown MCP tools remain denied. Reads of `.env` files require approval, except `.env.example`. This policy is not an operating system file sandbox. The native runtime must confirm the requested permission mode before a prompt is sent.

For managed collaboration, a temporary plugin waits for native registration of Ensemble MCP tools before the first prompt. If the tools are not ready within 30 seconds, the task is not sent. The plugin is removed when the process closes.

The public gateway can reject a request or its restricted tool configuration. Ensemble preserves the error and stops the turn. It does not relax read-only permissions to work around a gateway rejection.

## DeepSeek Harness

Install the DeepSeek Harness CLI separately, either through its application or as a command-line installation. Ensemble starts `dsh --profile acp` with a temporary configuration overlay.

The adapter selects only the native `deepseek-official` Flash route and uses `https://api.deepseek.com/anthropic`. The overlay sets reasoning to `off` and limits each model request to 4096 output tokens. When a native reasoning selector is available, the default preference is `off`, then `low`; an explicitly selected effort must be offered and confirmed by the runtime. A turn can contain multiple model requests, so the output limit is not a total token or cost cap.

Native credential resolution is retained. If the backend environment has no non-empty `DEEPSEEK_API_KEY`, Ensemble may read a token or key from the default Claude settings only when their endpoint matches `https://api.deepseek.com/anthropic` after removing trailing slashes. It passes that value to the child process in memory. It does not change the settings file or store the borrowed credential in the session. If that optional source is unavailable, Harness can still use its native credential store.

Native read-only mode has not been verified. Ensemble rejects read-only requests before sending the prompt. Review-mode sessions launch with `DSH_PERMISSION_MODE=workspace-write`; do not use this provider when you require read-only execution.

The temporary overlay is removed when the process closes. A missing or unconfirmed Flash route stops the turn.

## Shared boundaries

- OpenCode and DeepSeek Harness run in a new ACP process for each turn. Continuation uses the original native session ID only if the runtime advertises resume or load support; a failure does not create a replacement session automatically.
- ACP model, reasoning, and permission choices must be offered and confirmed by the runtime. Unsupported choices stop the task. Permission prompts expose only the native single-use allow/reject choices.
- Image transport support does not mean every selected model can interpret images. ACP context usage, runtime token usage, and official account balances are separate records.
- DeepSeek balance lookup is user-initiated. Each returned currency is retained separately, without adding or converting balances. Usage counters are not an invoice or proof of zero cost.
- Claude Code, OpenCode, and DeepSeek Harness do not currently offer native conversation rewind in Ensemble. A context fork creates an editable draft; it starts a new task only when sent.
- Read-only file access and collaboration permissions are separate. Role names grant no permissions. External agents keep their own native permission settings; Ensemble records only the tasks, messages, and artifacts they exchange through its MCP interface.
- A runtime error stops that execution attempt. Collaboration can retry according to the run's configured limits, but a failed attempt is retained. A backend restart interrupts unfinished work and requires explicit recovery.

See [Getting started](getting-started.md) for setup and backend lifecycle, or [Provider plugins](provider-plugins.md) to add a custom local runtime adapter.
