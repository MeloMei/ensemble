import { discoveryHealth } from '../provider-health';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { ApprovalInput, ProviderModel } from '../../shared/types';
import type { DisplayText } from '../../shared/display-text';
import { createNdjsonDecoder } from './ndjson';
import { signalProcessTree } from './process-tree';
import type { ProviderAdapter, TurnContext } from './types';
import { attachmentText, emitProcess, processStatus, processText } from './provider-events';
import { claudeMcpConfiguration, WORKBENCH_MCP_TOOLS } from './mcp-configuration';
import { isIssuedWorkbenchMcpServer } from '../collaboration-server';
import { normalizeNativeChatTaskList } from '../vendor/orca/task-list';

const execute = promisify(execFile);
const TURN_TIMEOUT_MS = 60 * 60 * 1_000;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const;
type ObjectValue = Record<string, unknown>;
type PendingControl = { resolve(value: ObjectValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type StreamBlock = { type: string; text: string };
type StreamMessage = { blocks: Map<number, StreamBlock>; text: string; finalized: boolean };

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude 返回了无效的结构化消息');
  return value as ObjectValue;
}

function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function cancelled(): Error { const error = new Error('任务已取消'); error.name = 'AbortError'; return error; }

export async function configuredClaudeModels(settingsPath = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')): Promise<ProviderModel[]> {
  try {
    const settings = object(JSON.parse(await readFile(settingsPath, 'utf8')));
    const environment = object(settings.env);
    return MODEL_ALIASES.flatMap(alias => {
      const mapped = environment[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
      if (typeof mapped !== 'string' || !mapped.trim() || mapped.length > 200 || /[\r\n\0]/.test(mapped)) return [];
      return [{ id: alias, name: `${alias[0].toUpperCase()}${alias.slice(1)} → ${mapped}`, free: false, efforts: EFFORTS }];
    });
  } catch { return []; }
}

export async function resolveClaudeBinary(): Promise<string | null> {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  let nvmVersions: string[] = [];
  try { nvmVersions = (await readdir(nvmRoot)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
  catch { /* nvm is optional. */ }
  const candidates = [
    process.env.CLAUDE_BINARY,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, executable)),
    join(homedir(), '.local', 'bin', executable),
    join('/opt/homebrew/bin', executable), join('/usr/local/bin', executable),
    ...nvmVersions.map(version => join(nvmRoot, version, 'bin', executable)),
  ];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Continue through known installation locations. */ }
  }
  return null;
}

export async function createClaudeProvider(): Promise<ProviderAdapter> {
  const binary = await resolveClaudeBinary();
  let version = '';
  let detail = '没有找到 Claude Code。安装后点击刷新，或设置 CLAUDE_BINARY。';
  let detailI18n: DisplayText | undefined = { key: 'runtime:detection.claudeMissing' };
  if (binary) {
    try {
      version = (await execute(binary, ['--version'], { timeout: 5_000, maxBuffer: 16_384 })).stdout.trim();
      detail = `${version} · ${binary}`;
      detailI18n = undefined;
    } catch (error) { detail = `Claude Code 无法运行：${errorOf(error).message}`; detailI18n = { key: 'runtime:detection.cannotRun', values: { provider: 'Claude Code', reason: errorOf(error).message } }; }
  }
  const models = await configuredClaudeModels();
  return {
    info: {
      id: 'claude', name: 'Claude Code', source: 'builtin', available: Boolean(binary && version), detail, detailI18n,
      capabilities: { resume: true, approvals: true, images: true, rewind: false, permissions: true, effort: true },
      efforts: EFFORTS,
      models: models.length ? models : undefined,
      health: discoveryHealth({ binary: Boolean(binary), catalog: models.length ? true : undefined, source: 'claude-local-configuration' }),
    },
    async run(context) {
      if (!binary || !version) throw new Error(detail);
      await runClaude(binary, context);
    },
  };
}

async function runClaude(binary: string, context: TurnContext): Promise<void> {
  if (context.signal.aborted) throw cancelled();
  if (context.session.settings?.effort && !EFFORTS.includes(context.session.settings.effort)) throw new Error('Claude Code 不支持所选思考档。');
  const sessionId = context.session.externalId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Claude 会话 ID 无效，无法恢复');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--forward-subagent-text', '--permission-prompt-tool', 'stdio', '--permission-mode', context.session.settings?.permission === 'read-only' ? 'plan' : 'manual',
    context.session.externalId ? `--resume=${sessionId}` : `--session-id=${sessionId}`];
  if (context.session.modelId) args.push('--model', context.session.modelId);
  if (context.session.settings?.effort) args.push('--effort', context.session.settings.effort);
  const mcpDirectory = context.mcpServers?.length ? await mkdtemp(join(tmpdir(), 'workbench-claude-mcp-')) : undefined;
  try {
    if (mcpDirectory) {
      const file = join(mcpDirectory, 'mcp.json');
      await writeFile(file, JSON.stringify(claudeMcpConfiguration(context.mcpServers!)), { flag: 'wx', mode: 0o600 });
      args.push('--mcp-config', file);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' };
    // A desktop-owned child is independent of any terminal Claude session that launched the app.
    delete env.CLAUDECODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { cwd: context.session.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true, shell: false });
      const controls = new Map<string, PendingControl>();
      const approvals = new Map<string, AbortController>();
      const messageByChannel = new Map<string, string>();
      const messages = new Map<string, StreamMessage>();
      const seenFrames = new Set<string>();
      const tools = new Set<string>();
      const toolStates = new Map<string, ObjectValue>();
      const toolChannels = new Map<string, string>();
      const toolBlocks = new Map<string, { id: string; json: string }>();
      const childTexts = new Map<string, Map<string, string>>();
      const childStates = new Map<string, { title: string; status: 'pending' | 'running' | 'completed' | 'failed' }>();
      const taskToolIds = new Map<string, string>();
      const backgroundTasks = new Set<string>();
      let initialized = false;
      let promptSent = false;
      let hasExternalId = false;
      let mainTextSeen = false;
      let result: ObjectValue | undefined;
      let sessionState: string | undefined;
      let failure: Error | undefined;
      let settled = false;
      let endingInput = false;
      let cancelling = false;
      let stderr = '';
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      let resultTimer: ReturnType<typeof setTimeout> | undefined;
      const turnTimer = setTimeout(() => stop(new Error('Claude 任务超过一小时，已停止运行')), TURN_TIMEOUT_MS);
      const decoder = createNdjsonDecoder(onFrame, 16 * 1024 * 1024);

      function write(message: unknown): void {
        if (settled || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('Claude 输入连接已关闭');
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }

      function requestControl(request: ObjectValue, timeoutMs = 30_000): Promise<ObjectValue> {
        const requestId = randomUUID();
        return new Promise((resolveRequest, rejectRequest) => {
          const timer = setTimeout(() => {
            controls.delete(requestId);
            rejectRequest(new Error(`Claude 控制请求超时：${String(request.subtype)}`));
          }, timeoutMs);
          controls.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
          try { write({ type: 'control_request', request_id: requestId, request }); }
          catch (error) { clearTimeout(timer); controls.delete(requestId); rejectRequest(errorOf(error)); }
        });
      }

      function cancelApprovals(): void {
        for (const controller of approvals.values()) controller.abort();
        approvals.clear();
      }

      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(turnTimer); clearTimeout(stopTimer); clearTimeout(forceTimer); clearTimeout(exitTimer); clearTimeout(resultTimer);
        context.signal.removeEventListener('abort', onAbort);
        cancelApprovals();
        for (const control of controls.values()) { clearTimeout(control.timer); control.reject(error ?? new Error('Claude 连接已结束')); }
        controls.clear();
        try { signalProcessTree(child, 'SIGKILL'); }
        catch (cause) { error ??= new Error(`Claude 子进程清理失败：${errorOf(cause).message}`); }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        for (const [channel, messages] of childTexts) emitProcess(context, { kind: 'subagent', nativeId: channel, parentId: sessionId, title: childStates.get(channel)?.title ?? 'Claude 子 Agent', status: error || childStates.get(channel)?.status === 'failed' ? 'failed' : 'completed', output: processText([...messages.values()].join('\n')) });
        error ? reject(error) : resolve();
      }

      function stop(error: Error): void {
        if (settled) return;
        failure ??= error;
        cancelApprovals();
        if (stopTimer) return;
        try { signalProcessTree(child, 'SIGTERM'); }
        catch (cause) { failure = new Error(`${failure.message}；停止 Claude 失败：${errorOf(cause).message}`); child.kill('SIGTERM'); }
        forceTimer = setTimeout(() => {
          try { signalProcessTree(child, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, 1_000);
        stopTimer = setTimeout(() => finish(failure ?? new Error('Claude 未能退出')), 2_000);
      }

      function onAbort(): void {
        if (settled || cancelling) return;
        cancelling = true;
        failure ??= cancelled();
        cancelApprovals();
        if (initialized && promptSent && !endingInput) {
          void requestControl({ subtype: 'interrupt' }, 1_000).catch(() => {}).finally(() => stop(failure!));
        } else stop(failure);
      }

      function endIfIdle(): void {
        if (!result || settled || failure || endingInput || approvals.size || backgroundTasks.size) return;
        if (sessionState && sessionState !== 'idle') return;
        endingInput = true;
        child.stdin.end();
        resultTimer = setTimeout(() => stop(new Error('Claude 返回结果后未正常退出')), 5_000);
      }

      function checkSession(frame: ObjectValue): void {
        if (typeof frame.session_id !== 'string' || !frame.session_id) return;
        if (frame.session_id !== sessionId) throw new Error('Claude 返回了其他会话的消息，当前任务已停止');
        if (!hasExternalId) { hasExternalId = true; context.emit({ type: 'external-id', id: sessionId }); }
      }

      function displayId(channel: string, messageId: string): string {
        return `${sessionId}:${channel}:${messageId}`;
      }

      function messageState(id: string): StreamMessage {
        let message = messages.get(id);
        if (!message) {
          message = { blocks: new Map(), text: '', finalized: false };
          messages.set(id, message);
        }
        return message;
      }

      function setText(id: string, text: string, channel: string): void {
        const message = messageState(id);
        const previous = message.text;
        message.text = text;
        if (previous === text) return;
        if (channel === 'main' && text) mainTextSeen = true;
        if (channel === 'main') context.emit({ type: 'text', itemId: id, text, replace: true });
        else {
          let values = childTexts.get(channel);
          if (!values) { values = new Map(); childTexts.set(channel, values); }
          values.set(id, text);
          emitProcess(context, { kind: 'subagent', nativeId: channel, parentId: sessionId, title: childStates.get(channel)?.title ?? 'Claude 子 Agent', status: childStates.get(channel)?.status ?? 'running', output: processText([...values.values()].join('\n')) });
        }
      }

      function projectMessageText(id: string, channel: string): void {
        const text = [...messageState(id).blocks.entries()].sort(([left], [right]) => left - right)
          .filter(([, block]) => block.type === 'text').map(([, block]) => block.text).join('');
        setText(id, text, channel);
      }

      function showTool(block: ObjectValue, channel = 'main'): void {
        if (typeof block.id !== 'string') return;
        const item = { ...toolStates.get(block.id), ...block };
        toolStates.set(block.id, item);
        toolChannels.set(block.id, channel);
        const status = processStatus(item.status ?? 'running');
        emitProcess(context, { kind: 'tool', nativeId: block.id, ...(channel === 'main' ? {} : { parentId: channel }), title: String(item.name ?? 'Claude 工具'), status, input: processText(item.input), output: processText(item.output) });
        const plan = normalizeNativeChatTaskList(String(item.name ?? ''), item.input);
        if (plan) emitProcess(context, { kind: 'plan', nativeId: `${block.id}:plan`, ...(channel === 'main' ? {} : { parentId: channel }), title: 'Claude 任务清单', status, entries: plan.tasks.map(task => ({ text: task.content, status: task.status === 'in_progress' ? 'running' : task.status })), output: plan.explanation });
        if (!tools.has(block.id)) { tools.add(block.id); context.emit({ type: 'activity', text: `Claude 调用工具：${String(item.name ?? 'unknown')}` }); }
      }

      function onPartial(frame: ObjectValue, channel: string): void {
        const event = object(frame.event);
        if (event.type === 'message_start') {
          const message = object(event.message);
          if (typeof message.id !== 'string') throw new Error('Claude 流式消息缺少 message id');
          messageByChannel.set(channel, message.id);
          if (channel === 'main') result = undefined;
          return;
        }
        if (!['content_block_start', 'content_block_delta', 'content_block_stop'].includes(String(event.type))) return;
        const messageId = messageByChannel.get(channel);
        if (!messageId || !Number.isSafeInteger(event.index) || Number(event.index) < 0) throw new Error('Claude 流式 block 缺少所属消息或有效下标');
        const id = displayId(channel, messageId);
        const message = messageState(id);
        if (message.finalized) return;
        const index = Number(event.index);
        const blockKey = `${id}:${index}`;
        if (event.type === 'content_block_stop') {
          const tool = toolBlocks.get(blockKey);
          if (tool?.json) {
            const input: unknown = JSON.parse(tool.json);
            showTool({ ...toolStates.get(tool.id), id: tool.id, input }, channel);
          }
          return;
        }
        if (event.type === 'content_block_start') {
          const block = object(event.content_block);
          message.blocks.set(index, { type: String(block.type), text: block.type === 'text' && typeof block.text === 'string' ? block.text : '' });
          projectMessageText(id, channel);
          if (block.type === 'tool_use') { showTool(block, channel); if (typeof block.id === 'string') toolBlocks.set(blockKey, { id: block.id, json: '' }); }
          return;
        }
        const delta = object(event.delta);
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const tool = toolBlocks.get(blockKey);
          if (tool) { if (tool.json.length + delta.partial_json.length > 1024 * 1024) throw new Error('Claude 工具输入超过 1 MiB。'); tool.json += delta.partial_json; }
          return;
        }
        if (delta.type === 'text_delta') {
          const block = message.blocks.get(index);
          if (block?.type !== 'text' || typeof delta.text !== 'string') throw new Error('Claude 文本增量与 block 类型不匹配');
          block.text += delta.text;
          projectMessageText(id, channel);
        }
      }

      function onAssistant(frame: ObjectValue, channel: string): void {
        const message = object(frame.message);
        if (typeof message.id !== 'string' || !Array.isArray(message.content)) throw new Error('Claude 完整消息缺少 id 或 content');
        const id = displayId(channel, message.id);
        const snapshot = new Map<number, StreamBlock>();
        for (const [index, raw] of message.content.entries()) {
          const block = object(raw);
          if (block.type === 'text') {
            if (typeof block.text !== 'string') throw new Error('Claude 完整消息的文本 block 无效');
            snapshot.set(index, { type: 'text', text: block.text });
          }
          else if (block.type === 'tool_use') showTool(block, channel);
        }
        const state = messageState(id);
        state.blocks = snapshot;
        state.finalized = true;
        projectMessageText(id, channel);
        if (frame.error) stop(new Error(`Claude 消息失败：${String(frame.error)}`));
      }

      async function onHostRequest(frame: ObjectValue): Promise<void> {
        const id = frame.request_id;
        if (typeof id !== 'string' || approvals.has(id)) { stop(new Error('Claude 控制请求 id 无效或重复')); return; }
        const controller = new AbortController();
        approvals.set(id, controller);
        try {
          const request = object(frame.request);
          if (request.subtype !== 'can_use_tool') throw new Error(`尚不支持 Claude 控制请求：${String(request.subtype)}`);
          const response = await decideTool(request, context, controller.signal);
          if (controller.signal.aborted || settled) return;
          write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
          if (response.interrupt === true) onAbort();
        } catch (cause) {
          if (controller.signal.aborted || settled) return;
          const error = errorOf(cause);
          try { write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: error.message } }); } catch { /* The transport may already be gone. */ }
          stop(error);
        } finally {
          approvals.delete(id);
          endIfIdle();
        }
      }

      function onFrame(raw: unknown): void {
        if (settled) return;
        const frame = object(raw);
        if (typeof frame.type !== 'string') throw new Error('Claude 消息缺少 type');
        if (frame.type === 'control_response') {
          const response = object(frame.response);
          if (typeof response.request_id !== 'string') throw new Error('Claude 控制响应缺少 request id');
          const pending = controls.get(response.request_id);
          if (!pending) return;
          controls.delete(response.request_id); clearTimeout(pending.timer);
          if (response.subtype === 'success') pending.resolve(response.response == null ? {} : object(response.response));
          else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'Claude 控制请求失败'));
          return;
        }
        if (frame.type === 'control_cancel_request') {
          if (typeof frame.request_id !== 'string') throw new Error('Claude 审批撤回缺少 request id');
          approvals.get(frame.request_id)?.abort(); approvals.delete(frame.request_id);
          endIfIdle(); return;
        }
        if (cancelling || failure) return;
        if (frame.type === 'control_request') {
          if (endingInput) throw new Error('Claude 在任务结束后仍请求交互');
          void onHostRequest(frame); return;
        }
        checkSession(frame);
        if (typeof frame.uuid === 'string') { if (seenFrames.has(frame.uuid)) return; seenFrames.add(frame.uuid); }
        const channel = typeof frame.parent_tool_use_id === 'string' ? frame.parent_tool_use_id : 'main';
        if (frame.type === 'user' && typeof frame.message === 'object') {
          const message = object(frame.message);
          for (const raw of Array.isArray(message.content) ? message.content : []) {
            const block = object(raw);
            if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
            showTool({ ...toolStates.get(block.tool_use_id), id: block.tool_use_id, output: block.content, status: block.is_error === true ? 'failed' : 'completed' }, toolChannels.get(block.tool_use_id) ?? channel);
          }
          return;
        }
        if (frame.type === 'stream_event') { onPartial(frame, channel); return; }
        if (frame.type === 'assistant') { onAssistant(frame, channel); return; }
        if (frame.type === 'system') {
          if (frame.subtype === 'init' && typeof frame.model === 'string') context.emit({ type: 'activity', text: `Claude 原生模型：${frame.model}` });
          if (frame.subtype === 'session_state_changed') {
            if (typeof frame.state !== 'string') throw new Error('Claude 会话状态无效');
            sessionState = frame.state;
            endIfIdle();
          }
          if (typeof frame.task_id === 'string') {
            if (frame.subtype === 'task_started') backgroundTasks.add(frame.task_id);
            const status = frame.subtype === 'task_updated' ? object(frame.patch ?? {}).status : frame.status;
            if (frame.skip_transcript !== true) {
              if (typeof frame.tool_use_id === 'string') taskToolIds.set(frame.task_id, frame.tool_use_id);
              const nativeId = taskToolIds.get(frame.task_id) ?? frame.task_id;
              const child = childStates.has(nativeId) || frame.task_type === 'local_agent' || frame.task_type === 'local_workflow' || (frame.task_type === undefined && typeof frame.subagent_type === 'string');
              const itemStatus = processStatus(status ?? (frame.subtype === 'task_started' ? 'running' : 'pending'));
              const title = typeof frame.description === 'string' ? frame.description : typeof frame.subagent_type === 'string' ? frame.subagent_type : 'Claude 后台任务';
              if (child) childStates.set(nativeId, { title, status: itemStatus });
              emitProcess(context, { kind: child ? 'subagent' : 'task', nativeId, parentId: child ? sessionId : channel === 'main' ? undefined : channel, title, status: itemStatus, input: processText(frame.prompt), output: processText(frame.summary ?? frame.output) });
            }
            if (['completed', 'failed', 'stopped', 'killed'].includes(String(status))) backgroundTasks.delete(frame.task_id);
            endIfIdle();
          }
          return;
        }
        if (frame.type === 'result' && channel === 'main') {
          if (typeof frame.terminal_reason === 'string' && frame.terminal_reason.startsWith('aborted_')) { stop(cancelled()); return; }
          if (frame.is_error !== false || frame.subtype !== 'success') {
            const errors = Array.isArray(frame.errors) ? frame.errors.join('\n') : frame.result;
            stop(new Error(`Claude 任务失败（${String(frame.subtype)}）${typeof errors === 'string' ? `：${errors}` : ''}`)); return;
          }
          result = frame;
          const usage = frame.usage && typeof frame.usage === 'object' ? object(frame.usage) : {};
          const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
          context.emit({ type: 'usage', usage: { id: `${context.userMessageId ?? sessionId}:claude`, source: 'Claude Code runtime', scope: 'turn', inputTokens: numeric(usage.input_tokens), outputTokens: numeric(usage.output_tokens), cachedTokens: numeric(usage.cache_read_input_tokens), createdAt: new Date().toISOString() } });
          cancelApprovals();
          if (!mainTextSeen && typeof frame.result === 'string' && frame.result) setText(`${sessionId}:result`, frame.result, 'main');
          if (Array.isArray(frame.permission_denials) && frame.permission_denials.length) context.emit({ type: 'activity', text: `Claude 有 ${frame.permission_denials.length} 项工具操作未获批准。` });
          endIfIdle();
        }
      }

      child.stdout.on('data', (chunk: Buffer) => { if (!settled) { try { decoder.feed(chunk); } catch (cause) { stop(errorOf(cause)); } } });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
      child.on('error', cause => stop(cause));
      child.stdin.on('error', cause => { if (!endingInput && !cancelling) stop(cause); });
      child.stdout.on('error', cause => stop(cause));
      child.stderr.on('error', cause => stop(cause));
      child.on('exit', () => { exitTimer = setTimeout(() => stop(new Error('Claude 已退出，但子进程仍占用输出连接')), 1_000); });
      child.on('close', (code, signal) => {
        if (settled) return;
        try { decoder.end(); } catch (cause) { failure ??= errorOf(cause); }
        if (failure) { finish(failure); return; }
        if (code !== 0 || !result || !endingInput || backgroundTasks.size || approvals.size || (sessionState && sessionState !== 'idle')) {
          finish(new Error(`Claude 未成功完成任务（退出 ${code ?? signal ?? 'unknown'}）${stderr.trim() ? `：${stderr.trim().slice(-2_000)}` : ''}`)); return;
        }
        finish();
      });
      context.signal.addEventListener('abort', onAbort, { once: true });
      if (context.signal.aborted) { onAbort(); return; }
      void requestControl({ subtype: 'initialize', hooks: null }).then(() => {
        if (settled || cancelling) return;
        initialized = true;
        const content: ObjectValue[] = [{ type: 'text', text: context.prompt }];
        for (const attachment of context.attachments ?? []) content.push(attachment.kind === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data.toString('base64') } }
          : { type: 'text', text: attachmentText(attachment.name, attachment.text ?? attachment.data.toString('utf8')) });
        write({ type: 'user', session_id: sessionId, ...(context.userMessageId ? { uuid: context.userMessageId } : {}), message: { role: 'user', content: context.attachments?.length ? content : context.prompt }, parent_tool_use_id: null });
        promptSent = true;
      }).catch(cause => stop(errorOf(cause)));
    });
  } finally { if (mcpDirectory) await rm(mcpDirectory, { recursive: true, force: true }); }
}

async function decideTool(request: ObjectValue, context: TurnContext, signal: AbortSignal): Promise<ObjectValue> {
  if (typeof request.tool_name !== 'string') throw new Error('Claude 权限请求缺少工具名');
  const input = object(request.input);
  const platformTool = WORKBENCH_MCP_TOOLS.find(name => request.tool_name === `mcp__workbench__${name}`);
  if (platformTool && context.mcpServers?.some(isIssuedWorkbenchMcpServer)) return { behavior: 'allow', updatedInput: input };
  if (context.session.settings?.permission === 'read-only' && !['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'TodoWrite', 'TaskList', 'TaskGet'].includes(request.tool_name)) return { behavior: 'deny', message: '当前会话为只读模式，此工具没有经过只读能力验证。' };
  if (request.tool_name === 'AskUserQuestion') {
    if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 20) throw new Error('Claude 问题列表无效');
    const texts = new Set<string>();
    const questions: NonNullable<ApprovalInput['questions']> = input.questions.map((raw, index) => {
      const question = object(raw);
      if (typeof question.question !== 'string' || !question.question.trim() || texts.has(question.question) || !Array.isArray(question.options)) throw new Error('Claude 问题内容无效或重复');
      texts.add(question.question);
      return {
        id: `q${index}`, question: question.question,
        header: typeof question.header === 'string' ? question.header : `问题 ${index + 1}`,
        ...(typeof question.header === 'string' ? {} : { headerI18n: { key: 'runtime:question.numberedHeader', values: { number: index + 1 } } }),
        multiSelect: question.multiSelect === true,
        options: question.options.map(rawOption => {
          const option = object(rawOption);
          if (typeof option.label !== 'string' || !option.label.trim()) throw new Error('Claude 问题选项无效');
          return { label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) };
        }),
      };
    });
    const rawAnswers = await context.approve({ title: 'Claude 需要你的回答', titleI18n: { key: 'runtime:approval.needsAnswer', values: { provider: 'Claude' } }, detail: '', choices: [], questions }, signal);
    if (signal.aborted || context.signal.aborted) throw cancelled();
    if (rawAnswers === 'cancel') return { behavior: 'deny', message: '用户取消回答', interrupt: true };
    let parsed: ObjectValue;
    try { parsed = object(JSON.parse(rawAnswers)); } catch { throw new Error('问题答案不是有效的 JSON 对象'); }
    const answers: Record<string, string | string[]> = {};
    for (const question of questions) {
      const values = parsed[question.id];
      if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim()) || (!question.multiSelect && values.length !== 1)) throw new Error('问题答案不完整或选项数量无效');
      answers[question.question] = question.multiSelect ? values as string[] : values[0] as string;
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }
  const detail = [
    typeof request.description === 'string' ? request.description : undefined,
    typeof request.decision_reason === 'string' ? request.decision_reason : undefined,
    typeof request.blocked_path === 'string' ? `目标路径：${request.blocked_path}` : undefined,
    JSON.stringify(input, null, 2),
  ].filter(Boolean).join('\n');
  const choice = await context.approve({
    title: `允许 Claude 使用 ${request.tool_name}？`, titleI18n: { key: 'runtime:approval.useTool', values: { provider: 'Claude', tool: request.tool_name } }, detail,
    choices: [{ id: 'accept', label: '允许本次', labelI18n: { key: 'runtime:approval.allowOnce' } }, { id: 'decline', label: '拒绝本次', labelI18n: { key: 'runtime:approval.denyOnce' } }, { id: 'cancel', label: '取消任务', labelI18n: { key: 'runtime:approval.cancelTask' } }],
  }, signal);
  if (signal.aborted || context.signal.aborted) throw cancelled();
  if (choice === 'accept') return { behavior: 'allow', updatedInput: input };
  if (choice === 'decline') return { behavior: 'deny', message: '用户拒绝此工具操作' };
  if (choice === 'cancel') return { behavior: 'deny', message: '用户取消当前任务', interrupt: true };
  throw new Error('Claude 审批返回了无效选项');
}
