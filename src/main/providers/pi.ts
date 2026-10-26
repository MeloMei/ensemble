import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProviderModel } from '../../shared/types';
import { discoveryHealth } from '../provider-health';
import { abortError } from './json-rpc';
import { createPiExtension } from './pi-extension';
import { PiCommandError, PiRpcProcess, type PiRecord } from './pi-rpc';
import { attachmentText, emitProcess, processText } from './provider-events';
import type { ProviderAdapter, TurnContext } from './types';

const execute = promisify(execFile);
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CONTROLLED_ARGS = ['--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve'];
const object = (value: unknown): PiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as PiRecord : {};
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function modelEfforts(model: PiRecord): string[] {
  if (!model.reasoning) return ['off'];
  const mapping = object(model.thinkingLevelMap);
  return EFFORTS.filter(level => mapping[level] !== null && (!['xhigh', 'max'].includes(level) || mapping[level] !== undefined));
}

export async function resolvePiBinary(): Promise<string | undefined> {
  const executable = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  const versions = await readdir(nvmRoot).catch(() => [] as string[]);
  const candidates = [process.env.PI_BINARY, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, executable)),
    join(homedir(), '.local', 'bin', executable), join('/opt/homebrew/bin', executable), join('/usr/local/bin', executable),
    ...versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => join(nvmRoot, version, 'bin', executable))];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return resolve(candidate); } catch { /* Try the next installed CLI. */ }
  }
  return undefined;
}

async function piSdkEntry(binary: string): Promise<string> {
  let directory = dirname(await realpath(binary));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version));
        if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 3)) throw new Error('Ensemble 需要官方 Pi 1.3.0 或更新版本。');
        const entry = join(directory, 'dist', 'index.js');
        await access(entry, constants.R_OK);
        return entry;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  throw new Error('未找到官方 Pi SDK。请通过 npm 安装 @earendil-works/pi-coding-agent，并将 PI_BINARY 指向其 pi CLI。');
}

function childEnvironment(binary: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}` };
}

export async function createPiProvider(options: { dataPath: string; binary?: string }): Promise<ProviderAdapter> {
  const binary = options.binary ?? await resolvePiBinary();
  let sdkEntry: string | undefined;
  let detail = '没有找到 Pi。请安装官方 Pi CLI 后刷新，或设置 PI_BINARY。';
  let models: ProviderModel[] | undefined;
  let defaultModelId: string | undefined;
  let protocol = false;
  if (binary) {
    try {
      sdkEntry = await piSdkEntry(binary);
      const version = (await execute(binary, ['--version'], { timeout: 5_000, maxBuffer: 16_384, env: childEnvironment(binary) })).stdout.trim();
      if (!version) throw new Error('Pi 未返回版本号。');
      detail = `${version} · ${binary}`;
      const rpc = new PiRpcProcess(binary, [...CONTROLLED_ARGS, '--no-mcp', '--no-session'], { cwd: process.cwd(), env: childEnvironment(binary) });
      try {
        const catalog = await rpc.request('get_available_models', {}, 10_000);
        const state = await rpc.request('get_state', {}, 5_000);
        protocol = true;
        models = (Array.isArray(catalog.models) ? catalog.models : []).map(object).flatMap(model =>
          typeof model.provider === 'string' && typeof model.id === 'string' ? [{ id: `${model.provider}/${model.id}`, name: typeof model.name === 'string' ? `${model.name} · ${model.provider}` : `${model.provider}/${model.id}`,
            free: false, efforts: modelEfforts(model) }] : []);
        const native = object(state.model);
        const selected = `${native.provider}/${native.id}`;
        defaultModelId = models.find(model => model.id === selected)?.id;
      } finally { await rpc.close(); }
    } catch (error) { sdkEntry = undefined; detail = `Pi 无法接入：${error instanceof Error ? error.message : String(error)}`; }
  }
  return {
    tracksDelivery: true,
    info: { id: 'pi', name: 'Pi', source: 'builtin', available: Boolean(binary && sdkEntry), detail,
      capabilities: { resume: true, approvals: true, images: true, textAttachments: true, permissions: true, effort: true, structured: true, usage: true, rewind: false, steer: false },
      models, defaultModelId, efforts: models?.find(model => model.id === defaultModelId)?.efforts,
      health: discoveryHealth({ binary: Boolean(binary), protocol: binary ? protocol : undefined, catalog: models?.length ? true : undefined, source: 'pi-native-rpc' }) },
    async run(context) {
      if (!binary || !sdkEntry) throw new Error(detail);
      await runPi(binary, sdkEntry, options.dataPath, context);
    },
  };
}

async function runPi(binary: string, sdkEntry: string, dataPath: string, context: TurnContext): Promise<void> {
  let dispatched = false;
  try { await executePi(binary, sdkEntry, dataPath, context, () => { dispatched = true; }); }
  catch (error) {
    if (!dispatched || error instanceof PiCommandError && error.command === 'prompt') context.emit({ type: 'delivery', status: 'rejected' });
    throw error;
  }
}

async function executePi(binary: string, sdkEntry: string, dataPath: string, context: TurnContext, onDispatch: () => void): Promise<void> {
  if (context.signal.aborted) throw abortError();
  const sessionDirectory = join(dataPath, 'pi', 'sessions');
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionFile = context.session.externalId ?? join(sessionDirectory, `${context.session.id}.jsonl`);
  if (context.session.externalId && (!((await stat(sessionFile).catch(() => null))?.isFile()) || !sessionFile.endsWith('.jsonl'))) throw new Error('Pi 原生会话文件不存在，无法续接。');
  const extension = await createPiExtension(context, sdkEntry);
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const settled = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Startup can fail before the model run is awaited.
  void settled.catch(() => {});
  let handshake: PiRecord | undefined;
  let started = false;
  let finalMessage = false;
  let finalError: string | undefined;
  let messageIndex = 0;
  let itemId = '';
  const approvals = new Set<Promise<void>>();
  const toolNames = new Map<string, string>();
  const handleUi = async (event: PiRecord): Promise<void> => {
    const id = String(event.id ?? '');
    if (event.method === 'notify') {
      const message = String(event.message ?? '');
      try { const record = object(JSON.parse(message)); if (record.marker === extension.readyMarker) { handshake = record; return; } } catch { /* Native notifications are normally plain text. */ }
      if (event.notifyType === 'error' || event.notifyType === 'warning') throw new Error(`Pi：${message}`);
      if (message) context.emit({ type: 'activity', text: message });
      return;
    }
    if (event.method === 'confirm') {
      const choice = await context.approve({ title: String(event.title ?? 'Pi 请求批准'), detail: String(event.message ?? ''), choices: [{ id: 'allow', label: '允许一次' }, { id: 'deny', label: '拒绝' }] }, context.signal);
      if (!context.signal.aborted) rpc.send({ type: 'extension_ui_response', id, confirmed: choice === 'allow' });
      return;
    }
    if (['setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'setWorkingMessage'].includes(String(event.method))) return;
    rpc.send({ type: 'extension_ui_response', id, cancelled: true });
    throw new Error(`Pi 请求了尚未支持的交互：${String(event.method)}`);
  };
  const rpc = new PiRpcProcess(binary, [...CONTROLLED_ARGS, '--extension', extension.path, '--session', sessionFile,
    '--tools', 'read,grep,find,ls,bash,edit,write,mcp__*'], { cwd: context.session.cwd, env: childEnvironment(binary), signal: context.signal,
    onFailure: fail,
    onEvent(event) {
      if (event.type === 'extension_ui_request') {
        const pending = handleUi(event).catch(error => { fail(error); void rpc.close(); }).finally(() => approvals.delete(pending));
        approvals.add(pending); return;
      }
      if (event.type === 'extension_error') { fail(new Error(`Pi 扩展失败：${String(event.error)}`)); void rpc.close(); return; }
      if (!started) return;
      const message = object(event.message);
      if (event.type === 'message_start' && message.role === 'assistant') { messageIndex++; itemId = `${context.userMessageId ?? context.session.id}:pi:${messageIndex}`; }
      if (event.type === 'message_update') {
        const delta = object(event.assistantMessageEvent);
        if (delta.type === 'text_delta' && typeof delta.delta === 'string') context.emit({ type: 'text', itemId: itemId || `${context.session.id}:pi:1`, text: delta.delta });
      }
      if (event.type === 'message_end' && message.role === 'assistant') {
        finalMessage = true;
        finalError = ['error', 'aborted'].includes(String(message.stopReason)) ? String(message.errorMessage ?? `Pi：${message.stopReason}`) : undefined;
        const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
        const text = blocks.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('');
        if (text) context.emit({ type: 'text', itemId: itemId || `${context.session.id}:pi:1`, text, replace: true });
        const usage = object(message.usage);
        if (Object.keys(usage).length) context.emit({ type: 'usage', usage: { id: itemId, source: 'pi', scope: 'turn',
          inputTokens: finite(usage.input), outputTokens: finite(usage.output), cachedTokens: finite(usage.cacheRead),
          cost: finite(object(usage.cost).total), ...(finite(object(usage.cost).total) !== undefined ? { currency: 'USD' } : {}), createdAt: new Date().toISOString() } });
      }
      if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(String(event.type))) {
        const id = String(event.toolCallId ?? '');
        if (typeof event.toolName === 'string') toolNames.set(id, event.toolName);
        emitProcess(context, { kind: 'tool', nativeId: id, title: toolNames.get(id) ?? 'Pi tool',
          status: event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : 'running', input: processText(event.args), output: processText(event.result ?? event.partialResult) });
      }
      if (event.type === 'agent_settled') {
        if (event.aborted) fail(abortError());
        else if (finalError) fail(new Error(finalError));
        else if (!finalMessage) fail(new Error('Pi 结束运行，但没有最终助手消息。'));
        else finish();
      }
    } });
  const timeout = setTimeout(() => { fail(new Error('Pi 任务超时。')); void rpc.close(); }, 60 * 60 * 1_000);
  try {
    const state = await rpc.request('get_state');
    if (typeof state.sessionFile !== 'string' || resolve(state.sessionFile) !== resolve(sessionFile)) throw new Error('Pi 未恢复指定的原生会话，已停止发送任务。');
    const mcp = await rpc.request('prompt', { message: '/mcp' }, 35_000);
    if (mcp.disposition !== 'handled') throw new Error('Pi 原生 MCP 初始化命令不可用。');
    const checked = await rpc.request('prompt', { message: `/${extension.command}` }, 35_000);
    if (checked.disposition !== 'handled' || handshake?.ready !== true || handshake.guard !== true) throw new Error(String(handshake?.error ?? 'Pi 扩展或协作工具未就绪。'));
    const catalog = await rpc.request('get_available_models');
    const models = (Array.isArray(catalog.models) ? catalog.models : []).map(object);
    let selected = object(state.model);
    if (context.session.modelId) {
      const requested = models.find(model => `${model.provider}/${model.id}` === context.session.modelId);
      if (!requested) throw new Error('Pi 原生目录未提供所选模型。');
      selected = await rpc.request('set_model', { provider: requested.provider, modelId: requested.id });
      if (selected.provider !== requested.provider || selected.id !== requested.id) throw new Error('Pi 未确认所选模型。');
    }
    if (typeof selected.id !== 'string' || typeof selected.provider !== 'string') throw new Error('Pi 未配置可用模型。请先在 Pi CLI 中完成认证和模型选择。');
    if (context.session.settings?.effort) {
      const effort = context.session.settings.effort;
      const available = await rpc.request('get_available_thinking_levels');
      if (!Array.isArray(available.levels) || !available.levels.includes(effort)) throw new Error('Pi 原生模型不支持所选思考档。');
      await rpc.request('set_thinking_level', { level: effort });
      if ((await rpc.request('get_state')).thinkingLevel !== effort) throw new Error('Pi 未确认所选思考档。');
    }
    const attachments = context.attachments ?? [];
    if (attachments.some(item => item.kind === 'image') && (!Array.isArray(selected.input) || !selected.input.includes('image'))) throw new Error('所选 Pi 模型不支持图片。');
    const message = [context.prompt, ...attachments.filter(item => item.kind === 'text').map(item => attachmentText(item.name, item.text ?? new TextDecoder('utf-8', { fatal: true }).decode(item.data)))].join('\n\n');
    await rpc.request('set_auto_retry', { enabled: false });
    started = true;
    onDispatch();
    const accepted = await rpc.request('prompt', { message, images: attachments.filter(item => item.kind === 'image').map(item => ({ type: 'image', data: item.data.toString('base64'), mimeType: item.mimeType })) });
    if (accepted.disposition === 'handled') throw new PiCommandError('prompt', 'Pi 将输入作为本地命令处理，未开始模型任务。');
    if (accepted.disposition !== 'started') throw new Error(`Pi 未开始执行本次任务：${String(accepted.disposition)}`);
    context.emit({ type: 'delivery', status: 'accepted', nativeThreadId: String(state.sessionId) });
    await settled;
    await Promise.all(approvals);
  } finally {
    clearTimeout(timeout);
    try { await rpc.close(); }
    finally {
      if ((await stat(sessionFile).catch(() => null))?.isFile()) context.emit({ type: 'external-id', id: sessionFile });
      await extension.cleanup();
    }
  }
}
