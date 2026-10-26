import { discoveryHealth } from '../provider-health';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { abortError, asError, JsonRpcProcess, RpcError, type RpcExit, type RpcNotification, type RpcRequest } from './json-rpc';
import type { DeliveryReconciliation, ProviderAdapter, TurnContext } from './types';
import type { MessageDelivery, ProviderModel, Session } from '../../shared/types';
import type { DisplayText } from '../../shared/display-text';
import { attachmentText, emitProcess, processStatus, processText } from './provider-events';
import { codexMcpConfiguration } from './mcp-configuration';
import { answerCodexElicitation } from './codex-elicitation';
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from '../../shared/app-identity';

const execute = promisify(execFile);
const CLIENT_INFO = { name: PRODUCT_ID, title: PRODUCT_NAME, version: PRODUCT_VERSION };
const TURN_TIMEOUT_MS = 60 * 60 * 1_000;
type JsonObject = Record<string, unknown>;
interface CodexTurn { id: string; status: string; error?: { message?: string } | null; items?: JsonObject[]; itemsView?: string }
interface CodexThreadResult { thread: { id: string; status?: { type: string } } }

export function codexApprovalPolicy(session: Session): 'on-request' | { granular: { sandbox_approval: false; rules: false; mcp_elicitations: true; request_permissions: false; skill_approval: false } } {
  return session.settings?.permission === 'read-only'
    ? { granular: { sandbox_approval: false, rules: false, mcp_elicitations: true, request_permissions: false, skill_approval: false } }
    : 'on-request';
}

interface TurnHandlers {
  notification(message: RpcNotification): void;
  request(message: RpcRequest): Promise<unknown>;
  fail(error: Error): void;
  exit(result: RpcExit): void;
}

class CodexSessionConnection {
  readonly rpc: JsonRpcProcess;
  threadId?: string;
  handlers?: TurnHandlers;
  pendingRequests = 0;
  closed = false;
  private initialization?: Promise<void>;
  configuration?: string;

  constructor(binary: string, readonly cwd: string) {
    this.rpc = new JsonRpcProcess({
      command: binary, args: ['app-server', '--listen', 'stdio://'], cwd,
      onNotification: message => this.handlers?.notification(message),
      onRequest: async message => {
        const handlers = this.handlers;
        if (!handlers) throw new RpcError(-32000, '当前会话没有运行中的任务');
        this.pendingRequests++;
        try { return await handlers.request(message); }
        catch (error) { handlers.fail(asError(error)); throw error; }
        finally { this.pendingRequests--; }
      },
    });
    void this.rpc.closed.then(result => {
      this.closed = true;
      this.handlers?.exit(result);
    });
  }

  initialize(signal: AbortSignal): Promise<void> {
    return this.initialization ??= initialize(this.rpc, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.rpc.close();
  }
}

export async function resolveCodexBinary(): Promise<string | null> {
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [
    process.env.CODEX_BINARY,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, executable)),
    ...['/Applications', join(homedir(), 'Applications')].flatMap(directory => [
      join(directory, 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
      join(directory, 'Codex.app/Contents/Resources/codex'),
    ]),
    join(homedir(), '.local', 'bin', executable),
    join(homedir(), '.cargo', 'bin', executable),
  ];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Continue to another installed CLI location. */ }
  }
  return null;
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

async function initialize(rpc: JsonRpcProcess, signal?: AbortSignal): Promise<void> {
  await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, { signal });
  rpc.notify('initialized');
}

interface CatalogModel { id: string; model?: string; displayName?: string; isDefault: boolean; inputModalities?: string[]; supportedReasoningEfforts?: { reasoningEffort: string }[] }
async function modelCatalog(rpc: JsonRpcProcess): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [];
  let cursor: string | null | undefined;
  const cursors = new Set<string>();
  do {
    const page = await rpc.request<{ data: CatalogModel[]; nextCursor: string | null }>('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('Codex 模型目录无效。');
    models.push(...page.data.filter(model => typeof model.id === 'string' && model.id));
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Codex 模型列表返回了重复分页游标');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}

export interface CodexConnectionProbe {
  binary: string;
  signedIn: boolean;
  accountType: string | null;
  requiresOpenaiAuth: boolean;
  models: { id: string; isDefault: boolean }[];
}

export async function probeCodexConnection(binary?: string): Promise<CodexConnectionProbe> {
  const resolved = binary ?? await resolveCodexBinary();
  if (!resolved) throw new Error('没有找到 Codex CLI，请安装 Codex 或设置 CODEX_BINARY');
  const rpc = new JsonRpcProcess({ command: resolved, args: ['app-server', '--listen', 'stdio://'] });
  try {
    await initialize(rpc);
    const account = await rpc.request<{ account: { type?: string } | null; requiresOpenaiAuth: boolean }>(
      'account/read', { refreshToken: false });
    const models = (await modelCatalog(rpc)).map(model => ({ id: model.id, isDefault: model.isDefault }));
    return {
      binary: resolved,
      signedIn: account.account !== null,
      accountType: account.account?.type ?? null,
      requiresOpenaiAuth: account.requiresOpenaiAuth,
      models,
    };
  } finally { await rpc.close(); }
}

export interface CodexProvider extends ProviderAdapter {
  refreshInfo(): Promise<void>;
}

export async function createCodexProvider(): Promise<CodexProvider> {
  let binary: string | null = null;
  let version = '';
  let detail = '没有找到 Codex CLI。安装后点击刷新，或设置 CODEX_BINARY。';
  let detailI18n: DisplayText | undefined = { key: 'runtime:detection.codexMissing' };
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let catalog: CatalogModel[] = [];
  const sessions = new Map<string, CodexSessionConnection>();
  const provider: CodexProvider = {
    tracksDelivery: true,
    info: {
      id: 'codex', name: 'Codex', source: 'builtin', available: false, detail, detailI18n,
      capabilities: { resume: true, approvals: true, images: true, rewind: true, permissions: true, effort: true },
    },
    async refreshInfo() {
      let protocolReady: boolean | undefined;
      let catalogReady: boolean | undefined;
      binary = await resolveCodexBinary();
      version = '';
      catalog = [];
      detail = '没有找到 Codex CLI。安装后点击刷新，或设置 CODEX_BINARY。';
      detailI18n = { key: 'runtime:detection.codexMissing' };
      if (binary) {
        try {
          const result = await execute(binary, ['--version'], { timeout: 5_000, maxBuffer: 16_384 });
          version = result.stdout.trim();
          detail = `${version} · ${binary}`;
          detailI18n = undefined;
          const rpc = new JsonRpcProcess({ command: binary, args: ['app-server', '--listen', 'stdio://'] });
          try { protocolReady = false; await initialize(rpc); protocolReady = true; catalogReady = false; catalog = await modelCatalog(rpc); catalogReady = true; }
          finally { await rpc.close(); }
        } catch (error) { detail = `Codex CLI 无法运行：${asError(error).message}`; detailI18n = { key: 'runtime:detection.cannotRun', values: { provider: 'Codex CLI', reason: asError(error).message } }; }
      }
      const models: ProviderModel[] = catalog.map(model => ({ id: model.id, name: model.displayName || model.id, free: false,
        efforts: model.supportedReasoningEfforts?.map(effort => effort.reasoningEffort).filter(Boolean) }));
      provider.info = { ...provider.info, available: Boolean(binary && version), detail, detailI18n, models: models.length ? models : undefined,
        health: discoveryHealth({ binary: Boolean(binary), protocol: protocolReady, catalog: catalogReady, source: 'codex-app-server' }),
        efforts: models.find(model => catalog.find(native => native.id === model.id)?.isDefault)?.efforts };
    },
    async run(context) {
      let prepared = false;
      try {
        if (disposed) throw new Error('Codex 运行时已经关闭');
        if (context.signal.aborted) throw abortError();
        const selected = context.session.modelId ? catalog.find(model => model.id === context.session.modelId) : catalog.find(model => model.isDefault);
        if (context.session.modelId && !selected) throw new Error('Codex 模型不在本次原生目录中。');
        if (context.session.settings?.effort && !selected?.supportedReasoningEfforts?.some(option => option.reasoningEffort === context.session.settings!.effort)) throw new Error('所选 Codex 模型没有声明该思考档，任务未发送。');
        if (context.attachments?.some(attachment => attachment.kind === 'image') && selected?.inputModalities && !selected.inputModalities.includes('image')) throw new Error('所选 Codex 模型不支持图片输入。');
        const configuration = JSON.stringify({ mcpServers: context.mcpServers ?? [], permission: context.session.settings?.permission });
        let connection = sessions.get(context.session.id);
        if (connection && connection.configuration !== configuration && !connection.handlers) { await connection.close(); connection = undefined; }
        if (!connection || connection.closed) {
          if (!binary || !version) throw new Error(detail);
          connection = new CodexSessionConnection(binary, context.session.cwd);
          connection.configuration = configuration;
          sessions.set(context.session.id, connection);
        }
        if (connection.handlers) throw new Error('此 Codex 会话已有运行中的任务');
        if (connection.cwd !== context.session.cwd) throw new Error('Codex 会话的工作目录发生了变化');
        if (connection.threadId && context.session.externalId && connection.threadId !== context.session.externalId) {
          throw new Error('Codex 会话 id 与当前运行时不一致');
        }
        prepared = true;
        await runCodex(connection, context);
      } catch (error) {
        if (!prepared) context.emit({ type: 'delivery', status: 'rejected', reason: `消息尚未发送：${asError(error).message}` });
        throw error;
      }
    },
    async reconcileDelivery(session, deliveries) {
      if (disposed || !binary || !version || !session.externalId) return deliveries.map(delivery => ({ clientUserMessageId: delivery.clientUserMessageId,
        status: 'unknown', reason: '缺少可用的 Codex 原生会话，无法核对。' }));
      const rpc = new JsonRpcProcess({ command: binary, args: ['app-server', '--listen', 'stdio://'], cwd: session.cwd });
      try {
        await initialize(rpc);
        return await reconcileCodexDelivery(rpc, session.externalId, deliveries);
      } catch (error) {
        return deliveries.map(delivery => ({ clientUserMessageId: delivery.clientUserMessageId, status: 'unknown',
          reason: `原生历史核对未完成：${asError(error).message}` }));
      } finally { await rpc.close(); }
    },
    async rewind(session: Session, nativeTurnId: string) {
      if (disposed || !binary || !version || !session.externalId) throw new Error('Codex 原生会话尚未就绪。');
      let connection = sessions.get(session.id);
      if (connection?.handlers) throw new Error('Codex 正在运行，不能回退。');
      if (!connection || connection.closed) {
        connection = new CodexSessionConnection(binary, session.cwd);
        sessions.set(session.id, connection);
        await connection.initialize(new AbortController().signal);
        const resumed = await connection.rpc.request<CodexThreadResult>('thread/resume', { threadId: session.externalId, cwd: session.cwd, excludeTurns: true });
        if (resumed.thread?.id !== session.externalId) throw new Error('Codex 恢复了不同的原生会话，已停止回退。');
        connection.threadId = resumed.thread.id;
      }
      if (connection.threadId !== session.externalId) throw new Error('Codex 会话归属不一致，不能回退。');
      const state = await connection.rpc.request<{ thread: { historyMode?: string } }>('thread/read', { threadId: session.externalId, includeTurns: false });
      if (state.thread?.historyMode !== 'paginated') throw new Error('此 Codex 会话没有分页历史，原生回退不可用；可使用上下文分叉。');
      const result = await connection.rpc.request<CodexThreadResult>('thread/revert', { threadId: session.externalId, beforeTurnId: nativeTurnId });
      if (result.thread?.id !== session.externalId) throw new Error('Codex 未确认原线程回退，保留本地历史。');
    },
    dispose() {
      disposed = true;
      return disposal ??= (async () => {
        const results = await Promise.allSettled([...sessions.values()].map(session => session.close()));
        sessions.clear();
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), '部分 Codex 运行时未能关闭');
      })();
    },
  };
  await provider.refreshInfo();
  return provider;
}

async function reconcileCodexDelivery(rpc: JsonRpcProcess, threadId: string, deliveries: MessageDelivery[]): Promise<DeliveryReconciliation[]> {
  const metadata = await rpc.request<{ thread: { id: string; historyMode?: string } }>('thread/read', { threadId, includeTurns: false });
  if (metadata.thread?.id !== threadId) throw new Error('原生历史返回了不同会话。');
  if (metadata.thread.historyMode !== 'paginated') throw new Error('该原生会话没有可核对的完整分页历史。');
  const matches = new Map<string, Map<string, { turnId: string; itemId: string }>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let complete = false;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await rpc.request<{ data: CodexTurn[]; nextCursor: string | null }>('thread/turns/list', {
      threadId, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.data) || page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new Error('原生历史分页无效。');
    for (const turn of page.data) {
      if (typeof turn.id !== 'string' || turn.itemsView !== 'full' || !Array.isArray(turn.items)) throw new Error('原生历史未返回完整消息。');
      for (const item of turn.items) {
        if (item.type !== 'userMessage' || typeof item.id !== 'string' || typeof item.clientId !== 'string') continue;
        const matching = deliveries.find(delivery => delivery.clientUserMessageId === item.clientId && (!delivery.nativeThreadId || delivery.nativeThreadId === threadId));
        if (!matching) continue;
        const found = matches.get(matching.clientUserMessageId) ?? new Map();
        found.set(`${turn.id}:${item.id}`, { turnId: turn.id, itemId: item.id });
        matches.set(matching.clientUserMessageId, found);
      }
    }
    if (!page.nextCursor) { complete = true; break; }
    if (cursors.has(page.nextCursor)) throw new Error('原生历史返回了重复分页游标。');
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  if (!complete) throw new Error('原生历史超过本次核对范围，投递仍未确认。');
  return deliveries.map(delivery => {
    const found = matches.get(delivery.clientUserMessageId);
    if (found?.size !== 1) return { clientUserMessageId: delivery.clientUserMessageId, status: 'unknown',
      reason: found?.size ? '原生历史有多条相同客户端 ID，无法唯一确认。' : '已核原生历史未发现该客户端 ID；这不能证明消息未发送。' };
    const item = [...found.values()][0];
    return { clientUserMessageId: delivery.clientUserMessageId, status: 'accepted', nativeThreadId: threadId,
      nativeTurnId: item.turnId, nativeItemId: item.itemId, reason: '已通过原生历史中的客户端消息 ID 确认投递。' };
  });
}

async function runCodex(connection: CodexSessionConnection, context: TurnContext): Promise<void> {
  let threadId = connection.threadId;
  let turnId: string | undefined;
  let terminalCompletion = false;
  let submissionAttempted = false;
  let submissionAccepted = false;
  const earlyNotifications: RpcNotification[] = [];
  let releaseTurn!: () => void;
  const turnReady = new Promise<void>(resolve => { releaseTurn = resolve; });
  let settled = false;
  let resolveCompletion!: (error?: Error) => void;
  const completion = new Promise<Error | undefined>(resolve => { resolveCompletion = resolve; });
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    resolveCompletion(error);
  };
  const text = new Map<string, string>();
  const activities = new Set<string>();
  const items = new Map<string, JsonObject>();
  const showItem = (item: JsonObject, completed = true) => {
    if (typeof item.id !== 'string') return;
    const itemId = item.id;
    const previous = items.get(itemId);
    item = { ...previous, ...item };
    items.set(item.id as string, item);
    if (item.type === 'collabAgentToolCall') {
      for (const receiver of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
        if (typeof receiver !== 'string') continue;
        const state = object(object(item.agentsStates)[receiver]);
        emitProcess(context, { kind: 'subagent', nativeId: receiver, parentId: String(item.id), title: `Codex ${String(item.tool ?? '子 Agent')}`,
          status: processStatus(state.status ?? item.status ?? (completed ? 'completed' : 'running')), input: processText(item.prompt), output: processText(state.message ?? state) });
      }
      return;
    }
    if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(String(item.type))) {
      emitProcess(context, { kind: 'tool', nativeId: String(item.id), title: item.type === 'commandExecution' ? String(item.command ?? '执行命令') : item.type === 'mcpToolCall' ? `${String(item.server ?? '')}/${String(item.tool ?? '')}` : String(item.type),
        status: processStatus(item.status ?? (completed ? 'completed' : 'running')), input: processText(item.command ?? item.arguments ?? item.changes ?? item.query),
        output: processText(item.aggregatedOutput ?? item.result ?? item.error ?? (item.exitCode === undefined ? undefined : { exitCode: item.exitCode })) });
      return;
    }
    if (item.type !== 'agentMessage' || typeof item.text !== 'string') return;
    if (text.get(itemId) === item.text || !item.text) return;
    text.set(itemId, item.text);
    context.emit({ type: 'text', itemId, text: item.text, replace: true });
  };
  const completeTurn = (turn: CodexTurn, final = false) => {
    for (const item of turn.items ?? []) showItem(item);
    if (['completed', 'interrupted', 'failed'].includes(turn.status)) terminalCompletion = true;
    if (turn.status === 'completed') finish();
    else if (turn.status === 'interrupted') finish(abortError());
    else if (turn.status === 'failed') finish(new Error(turn.error?.message || 'Codex 任务失败'));
    else if (final || turn.status !== 'inProgress') finish(new Error(`Codex 返回了无效的任务状态：${turn.status}`));
  };
  const onNotification = (message: RpcNotification) => {
    if (settled) return;
    const params = object(message.params);
    if (!threadId || params.threadId !== threadId) return;
    if (!turnId) { earlyNotifications.push(message); return; }
    const eventTurn = object(params.turn);
    const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : eventTurn.id;
    if (turnId && notificationTurnId && notificationTurnId !== turnId) return;
    if (message.method === 'turn/completed') { completeTurn(eventTurn as unknown as CodexTurn, true); return; }
    if (message.method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      emitProcess(context, { kind: 'plan', nativeId: `${turnId}:plan`, title: 'Codex 任务计划', status: params.plan.every(raw => object(raw).status === 'completed') ? 'completed' : 'running',
        output: processText(params.explanation), entries: params.plan.map(raw => { const entry = object(raw); return { text: String(entry.step ?? ''), status: entry.status === 'completed' ? 'completed' as const : ['inProgress', 'in_progress'].includes(String(entry.status)) ? 'running' as const : 'pending' as const }; }) });
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = object(params.tokenUsage);
      const last = object(usage.last);
      const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
      context.emit({ type: 'usage', usage: { id: `${turnId}:codex:last`, source: 'Codex app-server', scope: 'turn', inputTokens: numeric(last.inputTokens), outputTokens: numeric(last.outputTokens), cachedTokens: numeric(last.cachedInputTokens), createdAt: new Date().toISOString() } });
      if (numeric(usage.modelContextWindow)) context.emit({ type: 'usage', usage: { id: `${turnId}:codex:context`, source: 'Codex app-server', scope: 'context', contextUsed: numeric(last.totalTokens), contextSize: numeric(usage.modelContextWindow), createdAt: new Date().toISOString() } });
      return;
    }
    if (message.method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      text.set(params.itemId, (text.get(params.itemId) ?? '') + params.delta);
      context.emit({ type: 'text', itemId: params.itemId, text: params.delta });
      return;
    }
    if (message.method === 'item/completed') showItem(object(params.item));
    if (message.method === 'item/commandExecution/outputDelta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const item = items.get(params.itemId);
      if (item) showItem({ ...item, aggregatedOutput: `${String(item.aggregatedOutput ?? '')}${params.delta}`.slice(-16_000) }, false);
    }
    if (message.method === 'item/fileChange/patchUpdated' && typeof params.itemId === 'string' && Array.isArray(params.changes)) {
      items.set(params.itemId, { ...items.get(params.itemId), changes: params.changes });
    }
    if (message.method === 'item/started') {
      const item = object(params.item);
      if (typeof item.id !== 'string' || activities.has(item.id)) return;
      items.set(item.id, item);
      showItem(item, false);
      activities.add(item.id);
      if (item.type === 'commandExecution') context.emit({ type: 'activity', text: `执行命令：${String(item.command ?? '')}` });
      else if (item.type === 'fileChange') context.emit({ type: 'activity', text: '正在修改文件' });
      else if (item.type === 'mcpToolCall') context.emit({ type: 'activity', text: `调用工具：${String(item.server ?? '')}/${String(item.tool ?? '')}` });
    }
    if (message.method === 'error') {
      const error = object(params.error);
      const detail = typeof error.message === 'string' ? error.message : 'Codex 运行失败';
      if (params.willRetry === true) context.emit({ type: 'activity', text: `Codex 正在重试：${detail}` });
      else finish(new Error(detail));
    }
  };
  const rpc = connection.rpc;
  connection.handlers = {
    notification: onNotification,
    request: async request => {
      if (!submissionAttempted) throw new RpcError(-32000, '当前任务尚未发送');
      await turnReady;
      const params = object(request.params);
      if (params.threadId !== threadId || (params.turnId && params.turnId !== turnId)) {
        throw new RpcError(-32602, '审批请求不属于当前任务');
      }
      if (!turnId || context.signal.aborted || settled) throw new RpcError(-32000, '任务已经结束');
      return handleApproval(request, context, items.get(String(params.itemId)));
    },
    fail: error => finish(error),
    exit: exit => {
      if (!settled) finish(exit.error ?? new Error(`Codex 在任务完成前退出（${exit.code ?? exit.signal ?? 'unknown'}）${exit.stderr.trim() ? `：${exit.stderr.trim().slice(-2_000)}` : ''}`));
    },
  };
  const onAbort = () => {
    if (settled) return;
    if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 1_000 }).catch(() => {});
    finish(abortError());
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => finish(new Error('Codex 任务超过一小时，连接已关闭')), TURN_TIMEOUT_MS);
  try {
    if (context.signal.aborted) throw abortError();
    await connection.initialize(context.signal);
    if (!threadId) {
      const method = context.session.externalId ? 'thread/resume' : 'thread/start';
      let response: CodexThreadResult;
      try {
        response = await rpc.request<CodexThreadResult>(method, {
          ...(context.session.externalId ? { threadId: context.session.externalId, excludeTurns: true } : {}),
          cwd: context.session.cwd,
          approvalPolicy: codexApprovalPolicy(context.session), approvalsReviewer: 'user', sandbox: context.session.settings?.permission === 'read-only' ? 'read-only' : 'workspace-write',
          ...(context.session.modelId ? { model: context.session.modelId } : {}),
          ...(context.mcpServers?.length ? { config: { mcp_servers: codexMcpConfiguration(context.mcpServers) } } : {}),
        }, { signal: context.signal });
      } catch (error) {
        if (asError(error).message.includes('already has an active writer')) {
          throw new Error('此 Codex 会话正由其他 Codex 运行时持有。请在原应用释放该会话后重试；工作台已保留原会话 id。', { cause: error });
        }
        throw error;
      }
      if (!response.thread?.id) throw new Error('Codex 未返回会话 id');
      if (response.thread.status?.type === 'active') throw new Error('原生 Codex 会话仍有运行中的回合，请先在原会话确认或停止。');
      threadId = connection.threadId = response.thread.id;
    }
    context.emit({ type: 'external-id', id: threadId });
    context.emit({ type: 'delivery', status: 'pending', nativeThreadId: threadId });
    if (context.signal.aborted) throw abortError();
    submissionAttempted = true;
    const started = await rpc.request<{ turn: CodexTurn }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: context.prompt, text_elements: [] }, ...(context.attachments ?? []).map(attachment => attachment.kind === 'image'
        ? { type: 'localImage', path: attachment.ownedPath }
        : { type: 'text', text: attachmentText(attachment.name, attachment.text ?? attachment.data.toString('utf8')), text_elements: [] })],
      ...(context.userMessageId ? { clientUserMessageId: context.userMessageId } : {}),
      ...(context.session.modelId ? { model: context.session.modelId } : {}),
      ...(context.session.settings?.effort ? { effort: context.session.settings.effort } : {}),
      ...(context.session.settings?.permission === 'read-only' ? { approvalPolicy: codexApprovalPolicy(context.session), sandboxPolicy: { type: 'readOnly', networkAccess: true } } : {}),
    }, { signal: context.signal });
    if (!started.turn?.id) throw new Error('Codex 未返回任务 id');
    turnId = started.turn.id;
    submissionAccepted = true;
    context.emit({ type: 'delivery', status: 'accepted', nativeThreadId: threadId, nativeTurnId: turnId });
    context.emit({ type: 'native-turn', turnId });
    completeTurn(started.turn);
    for (const message of earlyNotifications) onNotification(message);
    earlyNotifications.length = 0;
    releaseTurn();
    const error = await completion;
    if (error) throw error;
  } catch (error) {
    if (!submissionAccepted) {
      const rejected = !submissionAttempted || error instanceof RpcError && [-32700, -32600, -32601, -32602].includes(error.code);
      context.emit({ type: 'delivery', status: rejected ? 'rejected' : 'unknown', ...(threadId ? { nativeThreadId: threadId } : {}),
        reason: rejected ? `消息未被原生运行时接收：${asError(error).message}` : `发送后未收到原生确认：${asError(error).message}。请核对历史，平台不会自动重发。` });
    }
    throw error;
  } finally {
    settled = true;
    releaseTurn();
    clearTimeout(timer);
    context.signal.removeEventListener('abort', onAbort);
    try {
      if (!terminalCompletion || context.signal.aborted || connection.pendingRequests || context.mcpServers?.length) await connection.close();
    } finally { connection.handlers = undefined; }
  }
}

async function handleApproval(request: RpcRequest, context: TurnContext, item?: JsonObject): Promise<unknown> {
  if (request.method === 'mcpServer/elicitation/request') return answerCodexElicitation(object(request.params), context);
  if (request.method === 'item/permissions/requestApproval') {
    const params = object(request.params);
    if (context.session.settings?.permission === 'read-only') {
      context.emit({ type: 'activity', text: '只读会话已拒绝原生权限升级。' });
      return { permissions: {}, scope: 'turn' };
    }
    const selected = await context.approve({ title: '允许 Codex 扩展本轮权限？', titleI18n: { key: 'runtime:approval.extendPermissions', values: { provider: 'Codex' } }, detail: [params.reason, processText(params.permissions)].filter(Boolean).join('\n'), choices: [{ id: 'accept', label: '允许本轮', labelI18n: { key: 'runtime:approval.allowTurn' } }, { id: 'decline', label: '拒绝', labelI18n: { key: 'runtime:approval.deny' } }] });
    if (context.signal.aborted) throw abortError();
    if (!['accept', 'decline'].includes(selected)) throw new Error('权限审批结果无效。');
    return { permissions: selected === 'accept' ? object(params.permissions) : {}, scope: 'turn' };
  }
  if (request.method === 'item/tool/requestUserInput') {
    const params = object(request.params);
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 20) throw new Error('Codex 结构化问答列表无效。');
    const questions = params.questions.map(raw => {
      const value = object(raw);
      if (typeof value.id !== 'string' || typeof value.question !== 'string' || !value.question.trim()) throw new Error('Codex 结构化问答内容无效。');
      return { id: value.id, question: value.question, header: typeof value.header === 'string' ? value.header : '问题', ...(typeof value.header === 'string' ? {} : { headerI18n: { key: 'runtime:question.header' } }), multiSelect: false,
        options: (Array.isArray(value.options) ? value.options : []).map(rawOption => { const option = object(rawOption); if (typeof option.label !== 'string') throw new Error('Codex 问题选项无效。'); return { label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }; }) };
    });
    const raw = await context.approve({ title: 'Codex 需要你的回答', titleI18n: { key: 'runtime:approval.needsAnswer', values: { provider: 'Codex' } }, detail: '', choices: [], questions });
    if (context.signal.aborted) throw abortError();
    const parsed = object(JSON.parse(raw));
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const values = parsed[question.id];
      if (!Array.isArray(values) || values.length !== 1 || values.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Codex 问题答案无效。');
      answers[question.id] = { answers: values as string[] };
    }
    return { answers };
  }
  if (request.method !== 'item/commandExecution/requestApproval' && request.method !== 'item/fileChange/requestApproval') {
    const message = request.method === 'item/tool/requestUserInput'
      ? 'Codex 请求结构化问答，当前界面尚不支持回答；本次任务已停止。'
      : `当前客户端不支持 Codex 请求：${request.method}`;
    throw new RpcError(-32601, message);
  }
  const params = object(request.params);
  if (context.session.settings?.permission === 'read-only') {
    context.emit({ type: 'activity', text: '只读会话已拒绝命令或文件写入的权限升级。' });
    return { decision: Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('decline') ? 'cancel' : 'decline' };
  }
  const labels: Record<string, { label: string; labelI18n: DisplayText }> = {
    accept: { label: '允许本次', labelI18n: { key: 'runtime:approval.allowOnce' } },
    decline: { label: '拒绝本次', labelI18n: { key: 'runtime:approval.denyOnce' } },
    cancel: { label: '取消任务', labelI18n: { key: 'runtime:approval.cancelTask' } },
  };
  const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'decline', 'cancel'];
  const ids = [...new Set(available.filter((choice): choice is string => typeof choice === 'string' && Object.hasOwn(labels, choice)))];
  if (!ids.length) throw new RpcError(-32602, 'Codex 没有提供当前客户端支持的审批选项');
  const fileChange = request.method === 'item/fileChange/requestApproval';
  const network = object(params.networkApprovalContext);
  const detail = [
    typeof params.command === 'string' ? params.command : undefined,
    typeof params.cwd === 'string' ? `目录：${params.cwd}` : undefined,
    typeof params.grantRoot === 'string' ? `写入目录：${params.grantRoot}` : undefined,
    typeof network.host === 'string' ? `网络目标：${network.host}` : undefined,
    typeof params.reason === 'string' ? params.reason : undefined,
    ...(fileChange && Array.isArray(item?.changes) ? item.changes.map(change => {
      const file = object(change);
      return [typeof file.path === 'string' ? file.path : '', typeof file.diff === 'string' ? file.diff : ''].filter(Boolean).join('\n');
    }) : []),
  ].filter(Boolean).join('\n') || (fileChange ? 'Codex 请求修改工作目录外的文件。' : 'Codex 请求运行需要批准的操作。');
  const decision = await context.approve({
    title: fileChange ? '允许 Codex 修改文件？' : '允许 Codex 执行操作？',
    titleI18n: { key: fileChange ? 'runtime:approval.modifyFiles' : 'runtime:approval.performAction', values: { provider: 'Codex' } },
    detail,
    choices: ids.map(id => ({ id, ...labels[id] })),
  });
  if (context.signal.aborted) throw abortError();
  if (!ids.includes(decision)) throw new RpcError(-32602, '审批返回了不在当前请求中的选项');
  return { decision };
}
