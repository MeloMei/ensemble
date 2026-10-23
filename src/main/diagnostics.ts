import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DiagnosticEntry, Session } from '../shared/types';
import type { ProviderAdapter } from './providers/types';
import { createNdjsonDecoder } from './providers/ndjson';

type Context = Pick<DiagnosticEntry, 'providerId' | 'sessionId' | 'attemptId' | 'turnId'>;
type Input = Omit<DiagnosticEntry, 'seq' | 'at'>;
const scope = new AsyncLocalStorage<{ journal: DiagnosticJournal; context: Context }>();
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 1000;
type Shape = 'opaque' | 'id' | { enums: ReadonlySet<string> } | { fields: Readonly<Record<string, Shape>> } | { items: Shape };
const fields = (value: Record<string, Shape>): Shape => ({ fields: value });
const items = (value: Shape): Shape => ({ items: value });
const enums = (...values: string[]): Shape => ({ enums: new Set(values) });
const statuses = new Set(['idle', 'pending', 'queued', 'running', 'inProgress', 'waiting_approval', 'waiting_children', 'completed', 'failed', 'cancelled', 'interrupted', 'accepted', 'rejected', 'unknown']);
const status: Shape = { enums: statuses };
const errorShape = fields({ code: 'opaque', message: 'opaque', data: 'opaque' });
const itemShape = fields({
  id: 'id', clientId: 'id', nativeId: 'id', parentId: 'id', status,
  type: enums('userMessage', 'agentMessage', 'functionCallOutput', 'plan', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration', 'contextCompaction'),
  role: enums('user', 'assistant', 'system', 'tool'), kind: enums('tool', 'plan', 'task', 'subagent'), phase: enums('analysis', 'commentary', 'final'),
  text: 'opaque', content: 'opaque', title: 'opaque', command: 'opaque', arguments: 'opaque', input: 'opaque', output: 'opaque', aggregatedOutput: 'opaque', result: 'opaque', error: errorShape,
  exitCode: 'opaque', durationMs: 'opaque', changes: 'opaque',
});
const turnShape = fields({ id: 'id', rootTurnId: 'id', parentTurnId: 'id', status, itemsView: enums('notLoaded', 'summary', 'full'),
  items: items(itemShape), error: errorShape, startedAt: 'opaque', completedAt: 'opaque', durationMs: 'opaque' });
const threadShape = fields({ id: 'id', sessionId: 'id', parentThreadId: 'id', forkedFromId: 'id', turns: items(turnShape),
  status: fields({ type: enums('notLoaded', 'idle', 'systemError', 'active'), activeFlags: 'opaque' }), historyMode: enums('legacy', 'paginated'),
  ephemeral: 'opaque', preview: 'opaque', name: 'opaque', model: 'opaque', modelProvider: 'opaque', cwd: 'opaque', createdAt: 'opaque', updatedAt: 'opaque' });
const protocolShapes = new Map<string, { params: Shape; result: Shape }>();
function protocol(methods: string[], params: Shape, result: Shape = 'opaque'): void {
  for (const method of methods) protocolShapes.set(method, { params, result });
}
protocol(['initialize'], fields({ clientInfo: 'opaque', capabilities: 'opaque' }));
protocol(['initialized'], fields({}));
protocol(['thread/start', 'thread/resume', 'thread/fork'], fields({ threadId: 'id', cwd: 'opaque', model: 'opaque',
  approvalPolicy: 'opaque', approvalsReviewer: 'opaque', sandbox: 'opaque', config: 'opaque', excludeTurns: 'opaque' }), fields({ thread: threadShape }));
protocol(['thread/read'], fields({ threadId: 'id', includeTurns: 'opaque' }), fields({ thread: threadShape }));
protocol(['thread/revert'], fields({ threadId: 'id', turnId: 'id', numTurns: 'opaque' }), fields({ thread: threadShape }));
protocol(['thread/turns/list', 'thread/items/list'], fields({ threadId: 'id', turnId: 'id', cursor: 'id', limit: 'opaque',
  sortDirection: enums('asc', 'desc'), itemsView: enums('notLoaded', 'summary', 'full') }), fields({ data: 'opaque', nextCursor: 'id', backwardsCursor: 'id' }));
protocol(['turn/start', 'turn/steer'], fields({ threadId: 'id', expectedTurnId: 'id', clientUserMessageId: 'id', input: 'opaque', toolOutput: 'opaque',
  cwd: 'opaque', model: 'opaque', effort: enums('none', 'minimal', 'low', 'medium', 'high', 'xhigh'), approvalPolicy: 'opaque', sandboxPolicy: 'opaque' }), fields({ turn: turnShape }));
protocol(['turn/interrupt'], fields({ threadId: 'id', turnId: 'id' }), fields({}));
protocol(['turn/started', 'turn/completed'], fields({ threadId: 'id', turn: turnShape }));
protocol(['thread/started'], fields({ thread: threadShape }));
protocol(['item/started', 'item/completed'], fields({ threadId: 'id', turnId: 'id', item: itemShape }));
protocol(['turn/plan/updated'], fields({ threadId: 'id', turnId: 'id', explanation: 'opaque',
  plan: items(fields({ step: 'opaque', status })) }));
protocol(['thread/tokenUsage/updated'], fields({ threadId: 'id', turnId: 'id', tokenUsage: 'opaque' }));
protocol(['item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'],
  fields({ threadId: 'id', turnId: 'id', itemId: 'id', questions: 'opaque', command: 'opaque', reason: 'opaque', requestedSchema: 'opaque', permissions: 'opaque', availableDecisions: 'opaque' }),
  fields({ answers: 'opaque', decision: enums('accept', 'decline', 'cancel'), permissions: 'opaque', scope: enums('turn', 'session') }));
protocol(['model/list'], fields({ cursor: 'id', limit: 'opaque', includeHidden: 'opaque' }), fields({ data: 'opaque', nextCursor: 'id' }));
protocol(['account/read'], fields({ refreshToken: 'opaque' }), fields({ account: 'opaque', requiresOpenaiAuth: 'opaque' }));
protocol(['session/new', 'session/prompt', 'session/update'], fields({ sessionId: 'id', cwd: 'opaque', prompt: 'opaque', update: 'opaque' }));
protocol(['error'], fields({ threadId: 'id', turnId: 'id', error: errorShape, willRetry: 'opaque' }));
const methods = new Set(protocolShapes.keys());
const metadataEnums = {
  kind: new Set(['rpc.send', 'rpc.receive', 'decode.failed', 'request.timeout', 'rpc.failed', 'dispatch.started', 'dispatch.settled', 'normalized', 'connected', 'disconnected']),
  method: methods,
  eventType: new Set(['text', 'activity', 'external-id', 'native-turn', 'delivery', 'structured', 'usage']),
  status: statuses,
  errorCode: new Set(['authentication', 'timeout', 'runtime-failure', 'protocol', 'cancelled', 'unavailable']),
};

export class DiagnosticJournal {
  private entries: DiagnosticEntry[] = [];
  private encoded: string[] = [];
  private bytes = 0;
  private sequence = 0;
  private secret = randomBytes(32);
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private tracing = false;
  private last = new Map<string, string>();
  private requestMethods = new Map<string, string>();

  constructor(private path: string) {}

  async load(): Promise<void> {
    let source: string;
    try { source = await readFile(this.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (Buffer.byteLength(source) > MAX_BYTES) return;
    for (const line of source.split('\n').filter(Boolean).slice(-MAX_ENTRIES)) {
      try {
        const entry = JSON.parse(line) as DiagnosticEntry;
        if (!Number.isSafeInteger(entry.seq) || typeof entry.at !== 'string' || !['provider', 'engine', 'command', 'transport'].includes(entry.layer) || typeof entry.kind !== 'string') continue;
        const clean = this.clean(entry);
        this.sequence = Math.max(this.sequence, entry.seq);
        this.append({ ...clean, seq: entry.seq, at: entry.at });
      } catch {}
    }
  }

  setTracing(enabled: boolean): void { this.tracing = enabled; }
  isTracing(): boolean { return this.tracing; }
  snapshot(): DiagnosticEntry[] { return structuredClone(this.entries); }
  run<T>(context: Context, action: () => T): T { return scope.run({ journal: this, context }, action); }

  record(input: Input): void {
    if (input.layer === 'engine' && input.kind === 'normalized') {
      const key = `${input.sessionId}:${input.attemptId}:${input.requestId}`;
      const value = `${input.eventType}:${input.status}`;
      if (this.last.get(key) === value) return;
      this.last.set(key, value);
      if (this.last.size > MAX_ENTRIES) this.last.delete(this.last.keys().next().value!);
    }
    this.append({ ...this.clean(input), seq: ++this.sequence, at: new Date().toISOString() });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 150);
  }

  native(context: Context, direction: 'send' | 'receive', runtimeId: string, record: unknown): void {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const value = record as Record<string, unknown>;
    let method = typeof value.method === 'string' ? value.method : undefined;
    if (method && /delta|chunk/i.test(method)) return;
    if (typeof value.id === 'string' || typeof value.id === 'number') {
      const request = `${runtimeId}:${typeof value.id}:${String(value.id)}`;
      if (method !== undefined) {
        const key = `${direction}:${request}`;
        if (methods.has(method)) this.requestMethods.set(key, method); else this.requestMethods.delete(key);
        if (this.requestMethods.size > MAX_ENTRIES) this.requestMethods.delete(this.requestMethods.keys().next().value!);
      } else if (!Object.hasOwn(value, 'method')) method = this.requestMethods.get(`${direction === 'send' ? 'receive' : 'send'}:${request}`);
    }
    this.record({ ...context, layer: 'provider', kind: `rpc.${direction}`, runtimeId,
      ...(method ? { method } : {}), ...(typeof value.id === 'string' || typeof value.id === 'number' ? { requestId: String(value.id) } : {}),
      ...(this.tracing ? { protocol: record } : {}) });
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const source = this.encoded.join('');
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, source, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writes = write;
    await write;
  }

  async export(directory: string): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `ensemble-diagnostics-${Date.now()}.json`);
    await writeFile(file, JSON.stringify({ version: 1, scope: 'Lifecycle metadata; optional protocol values are redacted', entries: this.entries }, null, 2), { mode: 0o600 });
    return file;
  }

  private clean(input: Partial<DiagnosticEntry> & Pick<DiagnosticEntry, 'layer' | 'kind'>): Input {
    const result: Input = { layer: input.layer, kind: metadataEnums.kind.has(input.kind) ? input.kind : this.anonymous(input.kind) };
    for (const key of ['providerId', 'sessionId', 'attemptId', 'turnId', 'runtimeId'] as const) {
      const value = input[key];
      if (typeof value === 'string') result[key] = value.slice(0, 160);
    }
    if (typeof input.requestId === 'string') result.requestId = this.anonymous(input.requestId);
    for (const key of ['method', 'eventType', 'status', 'errorCode'] as const) {
      const value = input[key];
      if (typeof value === 'string') result[key] = metadataEnums[key].has(value) ? value : this.anonymous(value);
    }
    if (input.protocol !== undefined) {
      const schema = input.method ? protocolShapes.get(input.method) : undefined;
      result.protocol = this.redact(input.protocol, fields({ jsonrpc: enums('2.0'), id: 'id', method: { enums: methods },
        params: schema?.params ?? 'opaque', result: schema?.result ?? 'opaque', error: errorShape }));
    }
    return result;
  }

  private anonymous(value: string): string { return `redacted:${createHmac('sha256', this.secret).update(value).digest('hex').slice(0, 16)}`; }

  private redact(value: unknown, shape: Shape = 'opaque', depth = 0): unknown {
    if (depth > 6) return '[depth limit]';
    if (typeof value === 'string') return typeof shape === 'object' && 'enums' in shape && shape.enums.has(value) ? value : this.anonymous(value);
    if (value === null) return null;
    if (typeof value === 'number') return shape === 'id' ? this.anonymous(String(value)) : 0;
    if (typeof value === 'boolean') return false;
    if (Array.isArray(value)) return value.slice(0, 20).map(item => this.redact(item, typeof shape === 'object' && 'items' in shape ? shape.items : 'opaque', depth + 1));
    if (value && typeof value === 'object') {
      const allowed = typeof shape === 'object' && 'fields' in shape ? shape.fields : undefined;
      return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => {
        const rule = allowed && Object.hasOwn(allowed, key) ? allowed[key] : undefined;
        return [rule ? key : this.anonymous(`field:${key}`), this.redact(item, rule ?? 'opaque', depth + 1)];
      }));
    }
    return '[omitted]';
  }

  private append(entry: DiagnosticEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line) > 32 * 1024) delete entry.protocol;
    const encoded = `${JSON.stringify(entry)}\n`;
    this.entries.push(entry); this.encoded.push(encoded); this.bytes += Buffer.byteLength(encoded);
    while (this.entries.length > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      this.entries.shift(); this.bytes -= Buffer.byteLength(this.encoded.shift()!);
    }
  }
}

export function diagnosticScope(): { journal: DiagnosticJournal; context: Context } | undefined { return scope.getStore(); }
export function withProviderDiagnostics(adapter: ProviderAdapter, journal: DiagnosticJournal): ProviderAdapter {
  const sessionContext = (session: Session): Context => ({ providerId: adapter.info.id, sessionId: session.id });
  return { get info() { return adapter.info; },
    run: context => journal.run({ ...sessionContext(context.session), attemptId: context.session.attempts?.at(-1)?.id }, () => adapter.run(context)),
    ...(adapter.rewind ? { rewind: (session: Session, nativeTurnId: string) => journal.run(sessionContext(session), () => adapter.rewind!(session, nativeTurnId)) } : {}),
    ...(adapter.dispose ? { dispose: adapter.dispose.bind(adapter) } : {}),
    ...(adapter.reconcileDelivery ? { reconcileDelivery: (session: Session, deliveries: Parameters<NonNullable<ProviderAdapter['reconcileDelivery']>>[1]) =>
      journal.run(sessionContext(session), () => adapter.reconcileDelivery!(session, deliveries)) } : {}),
  };
}

export function replayProtocol(entries: DiagnosticEntry[], consume: (record: unknown, entry: DiagnosticEntry) => void): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.layer !== 'provider' || entry.kind !== 'rpc.receive' || entry.protocol === undefined) continue;
    const decoder = createNdjsonDecoder(record => { consume(record, entry); count += 1; });
    decoder.feed(`${JSON.stringify(entry.protocol)}\n`); decoder.end();
  }
  return count;
}
