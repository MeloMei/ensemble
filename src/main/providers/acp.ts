import { discoveryHealth } from '../provider-health';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import acpSchema from '@agentclientprotocol/sdk/schema/schema.json' with { type: 'json' };
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { ProviderAdapter, ProviderEvent, TurnContext } from './types';
import type { AcpConfigChoice, AcpLaunchSpec, AcpRuntimeDescriptor } from './acp-types';
import { abortError, asError } from './json-rpc';
import { signalProcessTree, watchOutputDrain } from './process-tree';
import { attachmentText, emitProcess, processStatus, processText } from './provider-events';
import { normalizeRuntimeCommands } from './runtime-commands';
import { answerFormElicitation } from './form-elicitation';
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from '../../shared/app-identity';
import { SESSION_PERMISSION_TIERS } from '../../shared/session-permissions';
import type { ApprovalInput, ProviderInfo, ProviderModel, RuntimeCommand, RuntimeModelConfiguration } from '../../shared/types';

type Options = acp.SessionConfigOption[];
type SelectOption = Extract<acp.SessionConfigOption, { type: 'select' }>;
const thoughtLevel: acp.SessionConfigOptionCategory = 'thought_level';

function selectOption(options: Options, category: acp.SessionConfigOptionCategory, legacyId = category): SelectOption | undefined {
  const selectors = options.filter(option => option.type === 'select');
  return selectors.find(option => option.category === category) ?? selectors.find(option => option.id === category)
    ?? selectors.find(option => option.id === legacyId);
}
type SessionConfiguration = {
  configOptions?: Options | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] } | null;
  modes?: acp.SessionModeState | null;
};

class UnsupportedAcpVersion extends Error {
  constructor() { super('运行时返回了不受支持的 ACP 协议版本。'); }
}

function permissionTiers(descriptor: AcpRuntimeDescriptor) {
  return descriptor.permissionTiers ?? SESSION_PERMISSION_TIERS.filter(tier => descriptor.sessionModes?.[tier] !== undefined);
}

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

let validateSessionUpdate: ReturnType<AjvJsonSchemaValidator['getValidator']> | undefined;

function privateAcpStream(stream: acp.Stream): acp.Stream {
  const outgoing = stream.writable.getWriter();
  const pending = new Set<acp.JsonRpcId>();
  return {
    writable: new WritableStream({
      write(message: acp.AnyMessage) {
        if ('method' in message && 'id' in message) pending.add(message.id);
        if ('method' in message && message.method === acp.PROTOCOL_METHODS.cancel_request && message.params && typeof message.params === 'object') {
          pending.delete(Reflect.get(message.params, 'requestId'));
        }
        return outgoing.write(message);
      },
      close: () => outgoing.close(),
      abort: reason => outgoing.abort(reason),
    }),
    readable: stream.readable.pipeThrough(new TransformStream({
      transform(message, controller) {
        // The SDK prints invalid frames and unknown reply IDs verbatim.
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') return;
        if ('method' in message) {
          if (typeof message.method !== 'string') return;
          if (!('id' in message) && message.method === acp.methods.client.session.update) {
            validateSessionUpdate ??= new AjvJsonSchemaValidator().getValidator({
              $defs: JSON.parse(JSON.stringify(acpSchema.$defs, (key, value) => key === 'format' ? undefined : value)),
              $ref: '#/$defs/SessionNotification',
            });
            if (!validateSessionUpdate(message.params).valid) return;
          }
        } else if (!('id' in message) || !pending.delete(message.id)) return;
        controller.enqueue(message);
      },
    })),
  };
}

function openAcp(app: ReturnType<typeof acp.client>, launch: AcpLaunchSpec, cwd: string, maxMessageBytes: number, privateOutput = false) {
  const child = spawn(launch.command, launch.args, {
    cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    detached: process.platform !== 'win32', windowsHide: true,
  });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, { maxMessageBytes },
  );
  const connection = app.connect(privateOutput ? privateAcpStream(stream) : stream);
  child.on('error', error => connection.close(error));
  watchOutputDrain(child, () => connection.close(new Error('ACP 进程已退出，但子进程仍占用输出连接')));
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', error => connection.close(error));
  child.stderr.resume();
  return { child, exited, connection };
}

async function initializeAcp(connection: acp.ClientConnection, forms: boolean, signal?: AbortSignal) {
  const initialized = await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: PRODUCT_ID, title: PRODUCT_NAME, version: PRODUCT_VERSION },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(forms ? { elicitation: { form: {} } } : {}) },
  }, { cancellationSignal: signal });
  if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new UnsupportedAcpVersion();
  return initialized;
}

export async function probeAcp(launch: AcpLaunchSpec, cwd: string, signal: AbortSignal): Promise<acp.AgentCapabilities> {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(8000);
  const stopped = AbortSignal.any([signal, deadline]);
  const { child, connection, exited } = openAcp(acp.client({ name: PRODUCT_ID }), launch, cwd, 64 * 1024, true);
  let killRequested = false;
  const kill = () => {
    if (killRequested) return;
    killRequested = true;
    signalProcessTree(child, 'SIGKILL');
  };
  stopped.addEventListener('abort', kill, { once: true });
  try {
    const reply = await initializeAcp(connection, false, stopped);
    stopped.throwIfAborted();
    return reply.agentCapabilities ?? {};
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (deadline.aborted) throw new Error('ACP 握手超时。');
    if (error instanceof UnsupportedAcpVersion) throw error;
    throw new Error('ACP 初始化失败。请检查可执行文件、参数和环境配置。');
  } finally {
    stopped.removeEventListener('abort', kill);
    connection.close();
    kill();
    await bounded(exited, 1500, 'ACP 探测进程未退出。');
  }
}

function protectAcpContext(context: TurnContext, redact: (value: string) => string): TurnContext {
  const visible = (value?: string) => value === undefined ? undefined : redact(value);
  const emit = (event: ProviderEvent) => {
    if (event.type === 'text') event = { ...event, itemId: redact(event.itemId), text: redact(event.text) };
    if (event.type === 'activity') event = { ...event, text: redact(event.text) };
    if (event.type === 'structured') {
      const item = event.event;
      event = { ...event, event: { ...item, id: redact(item.id), title: redact(item.title), input: visible(item.input), output: visible(item.output),
        nativeId: visible(item.nativeId), parentId: visible(item.parentId), entries: item.entries?.map(entry => ({ ...entry, text: redact(entry.text) })) } };
    }
    context.emit(event);
  };
  const approve = (input: ApprovalInput, signal?: AbortSignal) =>
    context.approve({ ...input, title: redact(input.title), detail: redact(input.detail) }, signal);
  return { ...context, emit, approve };
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
  private pendingCommands = new Map<string, RuntimeCommand[]>();
  private prompting = false;
  closed = false;

  constructor(private readonly descriptor: AcpRuntimeDescriptor, private readonly original: TurnContext['session'],
    private readonly onModels: (models: ProviderModel[], active?: RuntimeModelConfiguration) => void) {}

  private async request<Method extends acp.AgentRequestMethod>(method: Method, params: acp.AgentRequestParamsByMethod[Method]) {
    return bounded(this.connection.agent.request(method, params), 30_000, `${this.descriptor.name} 请求超时：${method}`);
  }

  private async start(context: TurnContext): Promise<SessionConfiguration> {
    this.preparing = this.descriptor.launch(this.original, context.mcpServers ?? [], context);
    this.launch = await this.preparing;
    if (context.signal.aborted || this.closing) throw abortError();
    const app = acp.client({ name: PRODUCT_ID })
      .onNotification(acp.methods.client.session.update, event => {
        try {
          const { sessionId, update } = event.params;
          if (update.sessionUpdate === 'available_commands_update') this.updateCommands(sessionId, update);
          else this.update(event.params);
        }
        catch (error) {
          if (!this.descriptor.redact) throw error;
          this.connection.close(new Error('ACP 运行时返回了无效的会话更新。'));
        }
      })
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
    const transport = openAcp(app, this.launch, this.original.cwd, 16 * 1024 * 1024, Boolean(this.descriptor.redact));
    this.child = transport.child;
    this.connection = transport.connection;
    this.exited = transport.exited.then(() => { this.closed = true; });
    const initialized = await bounded(initializeAcp(this.connection, this.descriptor.allowFormElicitation !== false), 30_000, `${this.descriptor.name} 请求超时：initialize`);
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
    if (this.descriptor.redact && this.descriptor.redact(session.sessionId) !== session.sessionId) throw new Error('运行时返回了包含私密配置的会话 ID。');
    this.nativeId = session.sessionId;
    return session;
  }

  private async configure(configuration: SessionConfiguration, requestedModelId?: string): Promise<void> {
    const options = configuration.configOptions ?? [];
    const model = selectOption(options, 'model');
    const choices = model ? configChoices(model.options)
      : configuration.models?.availableModels?.map(item => ({ value: item.modelId, name: item.name })) ?? [];
    const currentModel = model?.currentValue ?? configuration.models?.currentModelId;
    const useDefault = this.descriptor.useAgentModelDefault && !requestedModelId;
    if (!useDefault && (!choices.length || !currentModel)) throw new Error(`${this.descriptor.name} 没有返回可验证的模型选项。`);
    const selected = useDefault ? choices.find(choice => choice.value === currentModel) : this.descriptor.selectModel(choices, requestedModelId ?? currentModel!);
    let configured = options;
    let configurationMatchesModel = true;
    if (!useDefault && selected && model) {
      const response = await this.request(acp.methods.agent.session.setConfigOption, { sessionId: this.nativeId!, configId: model.id, value: selected.value });
      const actual = response.configOptions.find(option => option.id === model.id);
      if (actual?.type !== 'select' || actual.currentValue !== selected.value) throw new Error(`${this.descriptor.name} 未确认所选模型，任务未发送。`);
      configured = response.configOptions;
    } else if (!useDefault && selected) {
      await bounded(this.connection.agent.request('session/set_model', { sessionId: this.nativeId!, modelId: selected.value }), 30_000, `${this.descriptor.name} 模型设置超时。`);
      configurationMatchesModel = selected.value === currentModel;
    }
    const requestedEffort = this.current?.session.settings?.effort;
    const reasoning = configurationMatchesModel ? selectOption(configured, thoughtLevel, 'reasoning_effort') : undefined;
    const reasoningChoices = reasoning ? configChoices(reasoning.options) : [];
    const preference = requestedEffort ?? this.descriptor.reasoningPreference?.find(value => reasoningChoices.some(choice => choice.value === value));
    if (requestedEffort && !reasoning) throw new Error(`${this.descriptor.name} 没有声明思考档选项，任务未发送。`);
    if (reasoning && (requestedEffort || this.descriptor.reasoningPreference?.length)) {
      if (!preference) throw new Error(`${this.descriptor.name} 未提供省额推理选项，任务未发送。`);
      if (!reasoningChoices.some(choice => choice.value === preference)) throw new Error(`${this.descriptor.name} 未提供所选思考档，任务未发送。`);
      const result = await this.request(acp.methods.agent.session.setConfigOption, { sessionId: this.nativeId!, configId: reasoning.id, value: preference });
      configured = result.configOptions;
    }
    if (this.descriptor.sessionModes) {
      const permission = this.original.settings?.permission ?? 'review';
      const mode = configured.find(option => option.id === 'mode' || option.category === 'mode');
      const value = this.descriptor.sessionModes[permission];
      if (!value) throw new Error(`${this.descriptor.name} 未提供所选权限模式。`);
      if (mode?.type === 'select') {
        if (!configChoices(mode.options).some(choice => choice.value === value)) throw new Error(`${this.descriptor.name} 未提供所选权限模式。`);
        const result = await this.request(acp.methods.agent.session.setConfigOption, { sessionId: this.nativeId!, configId: mode.id, value });
        if (!result.configOptions.some(option => option.id === mode.id && option.type === 'select' && option.currentValue === value)) throw new Error('运行时没有确认权限设置，任务未发送。');
        configured = result.configOptions;
        configurationMatchesModel = true;
      } else {
        if (!configuration.modes?.availableModes.some(mode => mode.id === value)) throw new Error(`${this.descriptor.name} 未提供所选权限模式。`);
        await this.request(acp.methods.agent.session.setMode, { sessionId: this.nativeId!, modeId: value });
      }
    }
    const nativeModelId = selected?.value ?? currentModel;
    const finalModel = selectOption(configured, 'model');
    if ((model || finalModel) && finalModel?.currentValue !== nativeModelId) throw new Error('运行时没有确认最终模型，任务未发送。');
    const finalReasoning = configurationMatchesModel ? selectOption(configured, thoughtLevel, 'reasoning_effort') : undefined;
    if (preference && (finalReasoning?.id !== reasoning?.id || finalReasoning?.currentValue !== preference)) {
      throw new Error('运行时没有确认推理设置，任务未发送。');
    }
    const redact = this.descriptor.redact;
    const visible = (value: string) => !redact || redact(value) === value;
    const models = (finalModel ? configChoices(finalModel.options) : choices).filter(choice => visible(choice.value))
      .map(choice => ({ id: choice.value, name: redact?.(choice.name) ?? choice.name, free: false }));
    const modelId = requestedModelId ?? nativeModelId;
    const efforts = finalReasoning ? [...new Set(configChoices(finalReasoning.options).map(choice => choice.value)
      .filter(value => value.length > 0 && value.length <= 100 && visible(value)))] : [];
    const effort = finalReasoning && efforts.includes(finalReasoning.currentValue) ? finalReasoning.currentValue : undefined;
    const active = configurationMatchesModel && nativeModelId && modelId && visible(nativeModelId) && visible(modelId) ? { modelId, efforts, effort } : undefined;
    this.onModels(models, active);
    if (active) this.current?.emit({ type: 'runtime-model', model: active });
    if (selected) this.current?.emit({ type: 'activity', text: `ACP 模型：${selected.name}；${this.descriptor.name} ${this.descriptor.version}` });
  }

  private updateCommands(sessionId: string, update: acp.AvailableCommandsUpdate): void {
    if (this.nativeId && sessionId !== this.nativeId) return;
    if (!this.current && !this.pendingCommands.has(sessionId) && this.pendingCommands.size >= 8) return;
    const commands = normalizeRuntimeCommands(update.availableCommands.map(command => ({
      name: command.name, description: command.description, inputHint: command.input?.hint,
    })), this.descriptor.redact);
    if (this.current) {
      if (!this.current.signal.aborted) this.current.emit({ type: 'runtime-commands', commands });
    } else this.pendingCommands.set(sessionId, commands);
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
    if (!current || !this.prompting || this.closing || current.signal.aborted || requestSignal.aborted || request.sessionId !== this.nativeId) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const controller = new AbortController();
    this.permissions.add(controller);
    try {
      const tool = mergeAcpTool(this.tools.get(request.toolCall.toolCallId), request.toolCall);
      const ids = new Set(request.options.map(option => option.optionId));
      if (ids.size !== request.options.length || ids.has('')) throw new Error('运行时提供了无效的审批选项。');
      const choices = request.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once');
      if (!choices.length) throw new Error('运行时没有提供单次审批选项。');
      const policy = this.descriptor.permissionDecision?.(tool, current.session, this.launch?.mcpServers ?? current.mcpServers ?? []) ?? 'ask';
      const decision = policy === 'ask' && current.session.settings?.permission === 'full-access' ? 'allow' : policy;
      if (decision !== 'ask') {
        const option = choices.find(option => option.kind === (decision === 'allow' ? 'allow_once' : 'reject_once'));
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
      }
      const detail = [tool.title, tool.rawInput === undefined ? '' : JSON.stringify(tool.rawInput, null, 2)].filter(Boolean).join('\n');
      const signal = AbortSignal.any([requestSignal, current.signal, controller.signal]);
      const publicChoices = choices.map((option, index) => ({ id: this.descriptor.redact ? String(index) : option.optionId,
        label: option.kind === 'allow_once' ? '允许本次' : '拒绝本次', labelI18n: { key: option.kind === 'allow_once' ? 'runtime:approval.allowOnce' : 'runtime:approval.denyOnce' } }));
      const selected = await current.approve({ title: `${this.descriptor.name} 请求操作`, titleI18n: { key: 'runtime:approval.requestAction', values: { provider: this.descriptor.name } }, detail: detail || tool.toolCallId,
        choices: publicChoices },
      signal);
      if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
      const choice = choices[publicChoices.findIndex(option => option.id === selected)];
      if (!choice) throw new Error('审批结果不属于运行时提供的选项。');
      return { outcome: { outcome: 'selected', optionId: choice.optionId } };
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
    if (this.descriptor.allowFormElicitation === false) return { action: 'decline' };
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
      const permission = context.session.settings?.permission ?? 'review';
      if (permission !== 'review' && !permissionTiers(this.descriptor).includes(permission)) {
        throw new Error(`${this.descriptor.name} 不支持所选权限档位，任务未发送。`);
      }
      const options = await this.start(context);
      if (context.signal.aborted || this.closing) throw abortError();
      await this.launch?.waitUntilReady?.(context.signal, this.nativeId!);
      if (context.signal.aborted || this.closing) throw abortError();
      context.emit({ type: 'external-id', id: this.nativeId! });
      this.current = context;
      const commands = this.pendingCommands.get(this.nativeId!);
      this.pendingCommands.clear();
      if (commands) context.emit({ type: 'runtime-commands', commands });
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

export async function createAcpProvider(id: string, name: string, discover: () => Promise<AcpRuntimeDescriptor>, source: ProviderInfo['source'] = 'builtin'): Promise<AcpProvider> {
  let descriptor: AcpRuntimeDescriptor | undefined;
  let nativeModels: ProviderModel[] | undefined;
  let disposed = false;
  const observed = new Map<string, string[]>();
  const sessions = new Set<AcpSession>();
  const catalog = (runtime: AcpRuntimeDescriptor) => (runtime.models ?? nativeModels)?.map(model =>
    ({ ...model, efforts: observed.get(model.id) }));
  const hasEffort = () => [...observed.values()].some(efforts => efforts.length > 0);
  const provider: AcpProvider = {
    get tracksDelivery() { return descriptor?.tracksDelivery; },
    info: { id, name, available: false, source, detail: '尚未检测', detailI18n: { key: 'runtime:detection.notChecked' }, capabilities: { resume: source === 'builtin', approvals: true } },
    async refreshInfo() {
      try {
        const detected = await discover();
        if (detected.id !== id) throw new Error('ACP provider 身份不符');
        if (detected.version !== descriptor?.version || detected.detail !== descriptor.detail) {
          nativeModels = undefined;
          observed.clear();
        }
        descriptor = detected;
        const tiers = permissionTiers(descriptor);
        const advertised = descriptor.agentCapabilities;
        const models = catalog(descriptor);
        provider.info = { ...provider.info, available: true, detail: descriptor.detail, detailI18n: descriptor.detailI18n, models, defaultModelId: descriptor.defaultModelId,
          health: discoveryHealth({ binary: true, protocol: advertised || nativeModels ? true : undefined, catalog: models?.length ? true : undefined, source: nativeModels ? 'acp-native-session' : advertised ? 'acp-initialize' : 'acp-runtime-discovery' }),
          capabilities: { resume: !advertised || Boolean(advertised.loadSession || advertised.sessionCapabilities?.resume), approvals: true,
            images: !advertised || Boolean(advertised.promptCapabilities?.image), textAttachments: true, structured: true, usage: descriptor.reportsUsage !== false, questions: Boolean(descriptor.clientRequests), rewind: false, effort: hasEffort(), permissions: tiers.length > 0, permissionTiers: tiers.length ? tiers : undefined } };
      } catch (error) { descriptor = undefined; provider.info = { ...provider.info, available: false, detail: asError(error).message, detailI18n: { key: 'runtime:detection.failed', values: { provider: name, reason: asError(error).message } }, models: undefined, defaultModelId: undefined,
        health: discoveryHealth({ binary: undefined, source: 'acp-discovery-error' }) }; }
    },
    async run(context) {
      if (disposed || !descriptor) throw new Error(provider.info.detail);
      const runtime = descriptor;
      const session = new AcpSession(runtime, context.session, (reported, active) => {
        if (!descriptor || descriptor.version !== runtime.version || descriptor.detail !== runtime.detail) return;
        if (reported.length) nativeModels = reported;
        if (active) observed.set(active.modelId, active.efforts);
        const models = catalog(descriptor);
        provider.info = { ...provider.info, models, capabilities: { ...provider.info.capabilities, effort: hasEffort() },
          health: discoveryHealth({ binary: true, protocol: true, catalog: Boolean(models?.length), source: 'acp-native-session' }) };
      });
      sessions.add(session);
      const redact = runtime.redact;
      try { await session.run(redact ? protectAcpContext(context, redact) : context); }
      catch (error) { if (redact) throw new Error(redact(asError(error).message)); throw error; }
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
