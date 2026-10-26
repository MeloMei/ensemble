import { discoveryHealth } from '../provider-health';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type { ProviderAdapter, TurnContext } from './types';
import type { AcpConfigChoice, AcpLaunchSpec, AcpRuntimeDescriptor } from './acp-types';
import { abortError, asError } from './json-rpc';
import { signalProcessTree } from './process-tree';
import { attachmentText, emitProcess, processStatus, processText } from './provider-events';
import { answerFormElicitation } from './form-elicitation';
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from '../../shared/app-identity';
import type { ProviderModel } from '../../shared/types';

type Options = acp.SessionConfigOption[];
type SessionConfiguration = {
  configOptions?: Options | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] } | null;
  modes?: acp.SessionModeState | null;
};

export function mergeAcpTool(previous: acp.ToolCallUpdate | undefined, update: acp.ToolCallUpdate): acp.ToolCallUpdate {
  return { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)), toolCallId: update.toolCallId };
}

export function configChoices(options: unknown): AcpConfigChoice[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    if (typeof item.value === 'string' && typeof item.name === 'string') return [{ value: item.value, name: item.name }];
    return configChoices(item.options);
  });
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

class AcpSession {
  private child!: ChildProcessWithoutNullStreams;
  private connection!: acp.ClientConnection;
  private exited!: Promise<void>;
  private closing?: Promise<void>;
  private preparing?: Promise<AcpLaunchSpec>;
  private launch?: AcpLaunchSpec;
  private capabilities?: acp.AgentCapabilities;
  private current?: TurnContext;
  private permissions = new Set<AbortController>();
  private tools = new Map<string, acp.ToolCallUpdate>();
  private segments = 0;
  private text = new Map<string, string>();
  private usage?: acp.UsageUpdate;
  private fatal?: Error;
  private nativeId?: string;
  private prompting = false;
  closed = false;

  constructor(private readonly descriptor: AcpRuntimeDescriptor, private readonly original: TurnContext['session'],
    private readonly onModels?: (models: ProviderModel[]) => void) {}

  private async request<Method extends acp.AgentRequestMethod>(method: Method, params: acp.AgentRequestParamsByMethod[Method]) {
    return bounded(this.connection.agent.request(method, params), 30_000, `${this.descriptor.name} 请求超时：${method}`);
  }

  private async start(context: TurnContext): Promise<SessionConfiguration> {
    this.preparing = this.descriptor.launch(this.original, context.mcpServers ?? [], context);
    this.launch = await this.preparing;
    if (context.signal.aborted || this.closing) throw abortError();
    this.child = spawn(this.launch.command, this.launch.args, {
      cwd: this.original.cwd, env: this.launch.env, stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, detached: process.platform !== 'win32', windowsHide: true,
    });
    this.exited = new Promise(resolve => this.child.once('close', () => { this.closed = true; resolve(); }));
    this.child.on('error', error => { this.fatal = error; this.connection?.close(error); });
    this.child.stderr.resume();
    const app = acp.client({ name: PRODUCT_ID })
      .onNotification(acp.methods.client.session.update, event => this.update(event.params))
      .onRequest(acp.methods.client.session.requestPermission, event => this.permission(event.params, event.signal))
      .onRequest(acp.methods.client.elicitation.create, event => this.elicitation(event.params, event.signal));
    for (const [method, handler] of Object.entries(this.descriptor.clientRequests ?? {})) {
      app.onRequest(method, value => value, event => this.clientRequest(method, event.params, event.signal, handler));
    }
    for (const [method, handler] of Object.entries(this.descriptor.clientNotifications ?? {})) {
      app.onNotification(method, value => value, event => {
        const value = event.params;
        if (value && typeof value === 'object' && 'sessionId' in value && value.sessionId !== this.nativeId) return;
        if (this.current && this.prompting && !this.current.signal.aborted) handler(value, this.current);
      });
    }
    this.connection = app.connect(acp.ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
      { maxMessageBytes: 16 * 1024 * 1024 },
    ));
    this.child.stdout.on('error', error => this.connection.close(error));
    this.child.stdin.on('error', error => this.connection.close(error));
    this.child.stderr.on('error', error => this.connection.close(error));
    const initialized = await this.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: PRODUCT_ID, title: PRODUCT_NAME, version: PRODUCT_VERSION },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
    });
    if (initialized.protocolVersion !== 1) throw new Error(`不支持 ${this.descriptor.name} 的 ACP 版本 ${initialized.protocolVersion}`);
    this.capabilities = initialized.agentCapabilities;
    const mcpServers: acp.McpServer[] = (this.launch.mcpServers ?? context.mcpServers ?? []).map(server => {
      if (server.type === 'stdio') return { name: server.name, command: server.command, args: server.args, env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) };
      if (!this.capabilities?.mcpCapabilities?.[server.type]) throw new Error(`${this.descriptor.name} 未声明 ${server.type} MCP 能力。`);
      return { name: server.name, type: server.type, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) };
    });
    const input = { cwd: this.original.cwd, mcpServers };
    if (this.original.externalId) {
      const sessionId = this.original.externalId;
      let options: SessionConfiguration;
      if (this.capabilities?.sessionCapabilities?.resume) {
        options = await this.request(acp.methods.agent.session.resume, { ...input, sessionId });
      } else if (this.capabilities?.loadSession) {
        options = await this.request(acp.methods.agent.session.load, { ...input, sessionId });
      } else throw new Error(`${this.descriptor.name} 未声明恢复会话能力，已保留原会话 id。`);
      this.nativeId = sessionId;
      return options;
    }
    const session = await this.request(acp.methods.agent.session.new, input);
    this.nativeId = session.sessionId;
    return session;
  }

  private async configure(configuration: SessionConfiguration, requestedModelId?: string): Promise<void> {
    const options = configuration.configOptions ?? [];
    const model = options.find(option => option.id === 'model' || option.category === 'model');
    const choices = model?.type === 'select' ? configChoices(model.options)
      : configuration.models?.availableModels?.map(item => ({ value: item.modelId, name: item.name })) ?? [];
    const currentModel = model?.type === 'select' ? model.currentValue : configuration.models?.currentModelId;
    if (!choices.length || !currentModel) throw new Error(`${this.descriptor.name} 没有返回可验证的模型选项。`);
    const selected = this.descriptor.selectModel(choices, requestedModelId ?? currentModel);
    let configured = options;
    if (model?.type === 'select') {
      const response = await this.request(acp.methods.agent.session.setConfigOption, { sessionId: this.nativeId!, configId: model.id, value: selected.value });
      const actual = response.configOptions.find(option => option.id === model.id);
      if (actual?.type !== 'select' || actual.currentValue !== selected.value) throw new Error(`${this.descriptor.name} 未确认所选模型，任务未发送。`);
      configured = response.configOptions;
    } else {
      await bounded(this.connection.agent.request('session/set_model', { sessionId: this.nativeId!, modelId: selected.value }), 30_000, `${this.descriptor.name} 模型设置超时。`);
    }
    this.onModels?.(choices.map(choice => ({ id: choice.value, name: choice.name, free: false })));
    const requestedEffort = this.current?.session.settings?.effort;
    const reasoning = configured.find(option => option.id === 'reasoning_effort');
    if (requestedEffort && reasoning?.type !== 'select') throw new Error(`${this.descriptor.name} 没有声明思考档选项，任务未发送。`);
    if (reasoning?.type === 'select' && (requestedEffort || this.descriptor.reasoningPreference?.length)) {
      const choices = configChoices(reasoning.options);
      const preference = requestedEffort ?? this.descriptor.reasoningPreference?.find(value => choices.some(choice => choice.value === value));
      if (preference && !choices.some(choice => choice.value === preference)) throw new Error(`${this.descriptor.name} 未提供所选思考档，任务未发送。`);
      if (!preference) throw new Error(`${this.descriptor.name} 未提供省额推理选项，任务未发送。`);
      const result = await this.request(acp.methods.agent.session.setConfigOption, { sessionId: this.nativeId!, configId: reasoning.id, value: preference });
      if (!result.configOptions.some(option => option.id === reasoning.id && option.type === 'select' && option.currentValue === preference)) throw new Error('运行时没有确认推理设置，任务未发送。');
    }
    const permission = this.current?.session.settings?.permission ?? 'review';
    if (permission === 'read-only' && !this.descriptor.sessionModes) throw new Error(`${this.descriptor.name} 尚未验证原生只读模式，任务未发送。`);
    if (this.descriptor.sessionModes) {
      const mode = configured.find(option => option.id === 'mode' || option.category === 'mode');
      const value = this.descriptor.sessionModes[permission];
      if (mode?.type === 'select') {
        if (!configChoices(mode.options).some(choice => choice.value === value)) throw new Error(`${this.descriptor.name} 未提供所选权限模式。`);
        const result = await this.request(acp.methods.agent.session.setConfigOption, { sessionId: this.nativeId!, configId: mode.id, value });
        if (!result.configOptions.some(option => option.id === mode.id && option.type === 'select' && option.currentValue === value)) throw new Error('运行时没有确认权限设置，任务未发送。');
      } else {
        if (!configuration.modes?.availableModes.some(mode => mode.id === value)) throw new Error(`${this.descriptor.name} 未提供所选权限模式。`);
        await this.request(acp.methods.agent.session.setMode, { sessionId: this.nativeId!, modeId: value });
      }
    }
    this.current?.emit({ type: 'activity', text: `ACP 模型：${selected.name}；${this.descriptor.name} ${this.descriptor.version}` });
  }

  private update(event: acp.SessionNotification): void {
    const current = this.current;
    if (!current || !this.prompting || current.signal.aborted || event.sessionId !== this.nativeId) return;
    if (event.update.sessionUpdate === 'current_mode_update' && current.session.settings?.permission === 'read-only'
      && this.descriptor.sessionModes && event.update.currentModeId !== this.descriptor.sessionModes['read-only']) {
      this.fatal = new Error(`${this.descriptor.name} 改变了只读权限模式，任务已停止。`);
      void this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.nativeId! }).catch(() => {});
      return;
    }
    if (this.descriptor.tracksDelivery && ['agent_message_chunk', 'tool_call', 'tool_call_update'].includes(event.update.sessionUpdate)) {
      current.emit({ type: 'delivery', status: 'accepted', nativeThreadId: this.nativeId });
    }
    const update = event.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const id = update.messageId || `message-${this.segments}`;
      const text = (this.text.get(id) ?? '') + update.content.text;
      this.text.set(id, text);
      current.emit({ type: 'text', itemId: id, text, replace: true });
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const previous = this.tools.get(update.toolCallId);
      const tool = mergeAcpTool(previous, update);
      this.tools.set(update.toolCallId, tool);
      emitProcess(current, { kind: 'tool', nativeId: tool.toolCallId, title: tool.title || tool.name || tool.toolCallId, status: processStatus(tool.status), input: processText(tool.rawInput), output: processText(tool.rawOutput ?? tool.content) });
      if (!previous) { this.segments++; current.emit({ type: 'activity', text: `工具：${update.title || update.toolCallId}` }); }
    } else if (update.sessionUpdate === 'plan') {
      emitProcess(current, { kind: 'plan', nativeId: 'plan', title: `${this.descriptor.name} 任务计划`, status: update.entries.every(entry => entry.status === 'completed') ? 'completed' : 'running', entries: update.entries.map(entry => ({ text: entry.content, status: entry.status === 'in_progress' ? 'running' : entry.status })) });
    } else if (update.sessionUpdate === 'subagent_update') {
      emitProcess(current, { kind: 'subagent', nativeId: update.sessionId, parentId: this.nativeId, title: update.title || 'ACP 子 Agent', status: processStatus(update.state?.state), input: processText(update.description), output: processText(update.state) });
    } else if (update.sessionUpdate === 'usage_update') this.usage = update;
  }

  private async permission(request: acp.RequestPermissionRequest, requestSignal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const current = this.current;
    if (!current || current.signal.aborted || request.sessionId !== this.nativeId) return { outcome: { outcome: 'cancelled' } };
    const controller = new AbortController();
    this.permissions.add(controller);
    try {
      const tool = mergeAcpTool(this.tools.get(request.toolCall.toolCallId), request.toolCall);
      const choices = request.options.filter(option => ['allow_once', 'reject_once'].includes(option.kind));
      if (!choices.length) throw new Error('运行时没有提供单次审批选项。');
      const decision = this.descriptor.permissionDecision?.(tool, current.session, this.launch?.mcpServers ?? current.mcpServers ?? []) ?? 'ask';
      if (decision !== 'ask') {
        const option = choices.find(option => option.kind === (decision === 'allow' ? 'allow_once' : 'reject_once'));
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
      }
      const detail = [tool.title, tool.rawInput === undefined ? '' : JSON.stringify(tool.rawInput, null, 2)].filter(Boolean).join('\n');
      const selected = await current.approve({ title: `${this.descriptor.name} 请求操作`, titleI18n: { key: 'runtime:approval.requestAction', values: { provider: this.descriptor.name } }, detail: detail || tool.toolCallId,
        choices: choices.map(option => ({ id: option.optionId, label: option.kind === 'allow_once' ? '允许本次' : '拒绝本次', labelI18n: { key: option.kind === 'allow_once' ? 'runtime:approval.allowOnce' : 'runtime:approval.denyOnce' } })) },
      AbortSignal.any([requestSignal, controller.signal]));
      if (!choices.some(option => option.optionId === selected)) throw new Error('审批结果不属于运行时提供的选项。');
      return { outcome: { outcome: 'selected', optionId: selected } };
    } catch (error) {
      if (current.signal.aborted || requestSignal.aborted || controller.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      this.fatal = asError(error);
      void this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.nativeId! }).catch(() => {});
      return { outcome: { outcome: 'cancelled' } };
    } finally { this.permissions.delete(controller); }
  }

  private cancelClientRequest(method: string, error: unknown): unknown {
    if (Object.hasOwn(this.descriptor.clientRequestCancellation ?? {}, method)) return structuredClone(this.descriptor.clientRequestCancellation![method]);
    throw error;
  }

  private async clientRequest(method: string, params: unknown, signal: AbortSignal,
    handler: (params: unknown, context: TurnContext, signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const context = this.current;
    if (!context || !this.prompting || context.signal.aborted || signal.aborted) return this.cancelClientRequest(method, abortError());
    if (params && typeof params === 'object' && 'sessionId' in params && params.sessionId !== this.nativeId) return this.cancelClientRequest(method, new Error('ACP 扩展请求的会话身份不符。'));
    const controller = new AbortController();
    this.permissions.add(controller);
    try { return await handler(params, context, AbortSignal.any([signal, context.signal, controller.signal])); }
    catch (error) {
      if (!context.signal.aborted && !signal.aborted && !controller.signal.aborted) {
        this.fatal = asError(error);
        void this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.nativeId! }).catch(() => {});
      }
      return this.cancelClientRequest(method, error);
    } finally { this.permissions.delete(controller); }
  }

  private async elicitation(request: acp.CreateElicitationRequest, requestSignal: AbortSignal): Promise<acp.CreateElicitationResponse> {
    const current = this.current;
    if (!current || current.signal.aborted || requestSignal.aborted || !('sessionId' in request) || request.sessionId !== this.nativeId) return { action: 'cancel' };
    if (request.mode !== 'form') return { action: 'decline' };
    const controller = new AbortController();
    this.permissions.add(controller);
    try {
      return await answerFormElicitation(request.requestedSchema, `${this.descriptor.name} 需要你的回答`, request.message, current, AbortSignal.any([requestSignal, controller.signal, current.signal]), { key: 'runtime:approval.needsAnswer', values: { provider: this.descriptor.name } });
    } catch (error) {
      if (current.signal.aborted || requestSignal.aborted || controller.signal.aborted) return { action: 'cancel' };
      this.fatal = asError(error);
      void this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.nativeId! }).catch(() => {});
      return { action: 'cancel' };
    } finally { this.permissions.delete(controller); }
  }

  private emitUsage(context: TurnContext, usage?: acp.Usage | null): void {
    if (this.usage) context.emit({ type: 'usage', usage: { id: `${context.userMessageId ?? context.session.id}:acp:context`, source: `${this.descriptor.name} ACP`, scope: 'context', contextUsed: this.usage.used, contextSize: this.usage.size, createdAt: new Date().toISOString() } });
    if (usage && [usage.inputTokens, usage.outputTokens].every(value => Number.isFinite(value) && value >= 0)) {
      const scope = this.descriptor.usageScope ?? 'cumulative';
      const id = scope === 'turn' ? `${context.userMessageId ?? context.session.id}:acp:tokens` : `${this.nativeId}:acp:tokens`;
      context.emit({ type: 'usage', usage: { id, source: `${this.descriptor.name} ACP`, scope,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        ...(typeof usage.cachedReadTokens === 'number' && Number.isFinite(usage.cachedReadTokens) && usage.cachedReadTokens >= 0 ? { cachedTokens: usage.cachedReadTokens } : {}),
        createdAt: new Date().toISOString() } });
    }
  }

  async run(context: TurnContext): Promise<void> {
    if (this.current) throw new Error('此 ACP 会话已有任务运行。');
    let dispatched = false;
    const abort = () => {
      for (const permission of this.permissions) permission.abort();
      if (this.nativeId && this.connection) void this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.nativeId }).catch(() => {});
    };
    context.signal.addEventListener('abort', abort, { once: true });
    let force: ReturnType<typeof setTimeout> | undefined;
    const forceStop = () => { force = setTimeout(() => { void this.close(); }, 2000); };
    context.signal.addEventListener('abort', forceStop, { once: true });
    try {
      if (context.signal.aborted) throw abortError();
      const options = await this.start(context);
      if (context.signal.aborted || this.closing) throw abortError();
      context.emit({ type: 'external-id', id: this.nativeId! });
      await this.launch?.waitUntilReady?.(context.signal);
      this.current = context;
      this.text.clear(); this.tools.clear(); this.segments = 0; this.usage = undefined; this.fatal = undefined;
      await this.configure(options, context.session.modelId ?? this.descriptor.defaultModelId);
      if (context.signal.aborted || this.closing) throw abortError();
      const prompt: acp.ContentBlock[] = [{ type: 'text', text: context.prompt }];
      for (const attachment of context.attachments ?? []) {
        if (attachment.kind === 'image') {
          if (!this.capabilities?.promptCapabilities?.image) throw new Error(`${this.descriptor.name} 未声明图片输入能力。`);
          prompt.push({ type: 'image', data: attachment.data.toString('base64'), mimeType: attachment.mimeType });
        } else if (this.capabilities?.promptCapabilities?.embeddedContext) {
          prompt.push({ type: 'resource', resource: { uri: pathToFileURL(attachment.ownedPath).href, mimeType: attachment.mimeType, text: attachment.text ?? attachment.data.toString('utf8') } });
        } else prompt.push({ type: 'text', text: attachmentText(attachment.name, attachment.text ?? attachment.data.toString('utf8')) });
      }
      this.prompting = true;
      dispatched = true;
      const result = await bounded(this.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.nativeId!, prompt,
      }, { cancellationSignal: context.signal }), 60 * 60 * 1000, `${this.descriptor.name} 任务超过一小时。`);
      if (this.descriptor.tracksDelivery) context.emit({ type: 'delivery', status: 'accepted', nativeThreadId: this.nativeId });
      if (context.signal.aborted) throw abortError();
      if (this.fatal) throw this.fatal;
      if (result.stopReason === 'cancelled') throw abortError();
      if (result.stopReason !== 'end_turn') throw new Error(`${this.descriptor.name} 未正常完成：${result.stopReason}`);
      if (![...this.text.values()].some(text => text.trim())) throw new Error(`${this.descriptor.name} 没有返回可交接的助手输出。`);
      if (this.permissions.size) throw new Error('运行时在审批结束前返回完成。');
      this.emitUsage(context, result.usage);
    } catch (error) {
      if (this.descriptor.tracksDelivery && !dispatched) context.emit({ type: 'delivery', status: 'rejected' });
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abort);
      context.signal.removeEventListener('abort', forceStop);
      clearTimeout(force);
      this.current = undefined;
      this.prompting = false;
      await this.close();
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      for (const permission of this.permissions) permission.abort();
      try {
        if (this.preparing) this.launch = await this.preparing.catch(() => undefined);
        if (this.child && !this.closed) {
          if (this.nativeId && this.capabilities?.sessionCapabilities?.close) {
            try { await bounded(this.connection.agent.request(acp.methods.agent.session.close, { sessionId: this.nativeId }), 1500, 'ACP close timeout'); } catch {}
          }
          this.child.stdin.end();
          // Native MCP transports may need several seconds to reclaim detached children.
          try { await bounded(this.exited, 4000, 'ACP EOF timeout'); }
          catch {
            signalProcessTree(this.child, 'SIGTERM');
            try { await bounded(this.exited, 4000, 'ACP terminate timeout'); }
            catch { signalProcessTree(this.child, 'SIGKILL'); await bounded(this.exited, 1500, 'ACP runtime did not exit'); }
          }
        }
      } finally {
        this.connection?.close();
        try { if (this.child) signalProcessTree(this.child, 'SIGKILL'); }
        finally {
          try { await this.launch?.cleanup?.(); }
          finally { this.closed = true; }
        }
      }
    })();
  }
}

export interface AcpProvider extends ProviderAdapter { refreshInfo(): Promise<void> }

export async function createAcpProvider(id: string, name: string, discover: () => Promise<AcpRuntimeDescriptor>): Promise<AcpProvider> {
  let descriptor: AcpRuntimeDescriptor | undefined;
  let disposed = false;
  const sessions = new Set<AcpSession>();
  const provider: AcpProvider = {
    get tracksDelivery() { return descriptor?.tracksDelivery; },
    info: { id, name, available: false, source: 'builtin', detail: '尚未检测', detailI18n: { key: 'runtime:detection.notChecked' }, capabilities: { resume: true, approvals: true } },
    async refreshInfo() {
      try {
        descriptor = await discover();
        if (descriptor.id !== id) throw new Error('ACP provider 身份不符');
        provider.info = { ...provider.info, available: true, detail: descriptor.detail, detailI18n: descriptor.detailI18n, models: descriptor.models, defaultModelId: descriptor.defaultModelId,
          health: discoveryHealth({ binary: true, catalog: descriptor.models?.length ? true : undefined, source: 'acp-runtime-discovery' }),
          efforts: descriptor.efforts,
          capabilities: { resume: true, approvals: true, images: true, textAttachments: true, structured: true, usage: descriptor.reportsUsage !== false, questions: Boolean(descriptor.clientRequests), rewind: false, effort: Boolean(descriptor.efforts?.length), permissions: Boolean(descriptor.sessionModes) } };
      } catch (error) { descriptor = undefined; provider.info = { ...provider.info, available: false, detail: asError(error).message, detailI18n: { key: 'runtime:detection.failed', values: { provider: name, reason: asError(error).message } }, models: undefined, defaultModelId: undefined,
        health: discoveryHealth({ binary: undefined, source: 'acp-discovery-error' }) }; }
    },
    async run(context) {
      if (disposed || !descriptor) throw new Error(provider.info.detail);
      const session = new AcpSession(descriptor, context.session, models => {
        if (descriptor?.models !== undefined) return;
        provider.info = { ...provider.info, models,
          health: discoveryHealth({ binary: true, protocol: true, catalog: true, source: 'acp-native-session' }) };
      });
      sessions.add(session);
      try { await session.run(context); }
      finally { sessions.delete(session); }
    },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...sessions].map(session => session.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'ACP 运行时关闭失败');
    },
  };
  await provider.refreshInfo();
  return provider;
}
