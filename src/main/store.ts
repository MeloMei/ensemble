import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AgentMail, MutationReceipt, Session, Workflow, Workspace } from '../shared/types';
import { moveSession, moveStep, moveWorkflow } from './lifecycle';
import {
  collaborationEventInputSchema, collaborationReceiptSchema, collaborationStateSchema, emptyCollaborationState,
  type CollaborationEvent, type CollaborationEventInput, type CollaborationReceipt, type CollaborationState,
} from '../shared/collaboration';

export interface SavedState {
  version: 1; sessions: Session[]; workflows: Workflow[]; workspaces: Workspace[];
  mails: AgentMail[]; receipts: MutationReceipt[];
  collaboration: CollaborationState;
}

const record = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const sessionStatus = z.enum(['idle', 'queued', 'running', 'waiting_approval', 'waiting_children', 'completed', 'failed', 'cancelled', 'interrupted']);
const stepStatus = z.enum(['pending', 'running', 'completed', 'failed', 'blocked', 'cancelled']);
const attachmentSchema = record({ id: z.string(), name: z.string(), kind: z.enum(['image', 'text']), mimeType: z.string(), size: z.number(), sha256: z.string(), ownedPath: z.string() });
const eventSchema = record({
  id: z.string(), kind: z.enum(['tool', 'plan', 'task', 'subagent']), title: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']), nativeId: z.string().optional(),
  parentId: z.string().optional(), input: z.string().optional(), output: z.string().optional(), sessionId: z.string().optional(),
  entries: z.array(record({ text: z.string(), status: z.enum(['pending', 'running', 'completed']) })).optional(),
});
const messageSchema = record({
  id: z.string(), role: z.enum(['user', 'assistant', 'activity']), text: z.string(), createdAt: z.string(),
  attachments: z.array(attachmentSchema).optional(), nativeTurnId: z.string().optional(), event: eventSchema.optional(),
});
const savedSchema = record({
  version: z.literal(1),
  collaboration: collaborationStateSchema.default(emptyCollaborationState),
  sessions: z.array(record({
    id: z.string(), title: z.string(), providerId: z.string(), modelId: z.string().optional(), cwd: z.string(), status: sessionStatus,
    settings: record({ effort: z.string().optional(), permission: z.enum(['review', 'read-only']).optional(), skillIds: z.array(z.string()).optional() }).optional(),
    archived: z.boolean().optional(), parentSessionId: z.string().optional(), parentAttemptId: z.string().optional(),
    draft: record({ text: z.string(), attachments: z.array(attachmentSchema).optional() }).optional(),
    attempts: z.array(record({ id: z.string(), status: sessionStatus, prompt: z.string(), userMessageId: z.string(), retryOf: z.string().optional(), startedAt: z.string(), endedAt: z.string().optional(), error: z.string().optional() })).optional(),
    usage: z.array(record({ id: z.string(), source: z.string(), scope: z.enum(['turn', 'cumulative', 'context']), inputTokens: z.number().optional(), outputTokens: z.number().optional(), cachedTokens: z.number().optional(), contextUsed: z.number().optional(), contextSize: z.number().optional(), cost: z.number().optional(), currency: z.string().optional(), createdAt: z.string() })).optional(),
    externalId: z.string().optional(), error: z.string().optional(), messages: z.array(messageSchema),
    approvals: z.array(record({ id: z.string(), sessionId: z.string(), title: z.string(), detail: z.string(), choices: z.array(record({ id: z.string(), label: z.string() })), questions: z.array(record({ id: z.string(), question: z.string(), header: z.string(), options: z.array(record({ label: z.string(), description: z.string().optional() })), multiSelect: z.boolean() })).optional() })),
    createdAt: z.string(), updatedAt: z.string(),
  })),
  workflows: z.array(record({
    id: z.string(), name: z.string(), cwd: z.string(), status: z.enum(['draft', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
    steps: z.array(record({
      id: z.string(), title: z.string(), providerId: z.string(), modelId: z.string().optional(), prompt: z.string(), dependsOn: z.array(z.string()),
      status: stepStatus, sessionId: z.string().optional(), error: z.string().optional(),
      attempts: z.array(record({ id: z.string(), sessionId: z.string(), status: stepStatus, retryOf: z.string().optional(), startedAt: z.string(), endedAt: z.string().optional(), error: z.string().optional() })).optional(),
    })), createdAt: z.string(), updatedAt: z.string(),
  })),
  workspaces: z.array(record({
    id: z.string(), name: z.string(), cwd: z.string(), pinned: z.boolean(),
    tabs: z.array(z.discriminatedUnion('kind', [
      record({ id: z.string(), kind: z.literal('agent'), sessionId: z.string() }),
      record({ id: z.string(), kind: z.literal('terminal'), terminalId: z.string() }),
      record({ id: z.string(), kind: z.literal('preview'), url: z.string() }),
    ])), activeTabId: z.string().nullable(), secondaryTabId: z.string().optional(),
    splitDirection: z.enum(['horizontal', 'vertical']).optional(), splitRatio: z.number().optional(),
    createdAt: z.string(), updatedAt: z.string(),
  })).default([]),
  mails: z.array(record({ id: z.string(), fromSessionId: z.string(), toSessionId: z.string(), attemptId: z.string(), toAttemptId: z.string().optional(), kind: z.enum(['message', 'question', 'result']), text: z.string(), createdAt: z.string(), delivered: z.boolean().optional() })).default([]),
  receipts: z.array(record({ key: z.string(), hash: z.string(), result: z.unknown().refine(value => value !== undefined, '派工收据缺少结果') })).default([]),
});
const unfinished = new Set(['queued', 'running', 'waiting_approval', 'waiting_children']);

export interface StoreTransaction {
  appendEvent(input: CollaborationEventInput): CollaborationEvent;
  putReceipt(receipt: CollaborationReceipt): void;
  receipt(key: string): CollaborationReceipt | undefined;
}

export class StateStore {
  state: SavedState = { version: 1, sessions: [], workflows: [], workspaces: [], mails: [], receipts: [], collaboration: emptyCollaborationState() };
  readonly databasePath: string;
  private timer?: ReturnType<typeof setTimeout>;
  private database?: DatabaseSync;
  private loaded = false;
  private closed = false;
  private inTransaction = false;
  private revision = 0;
  private persistedSource?: string;
  private writeError?: Error;

  constructor(readonly path: string) { this.databasePath = join(dirname(path), 'state.sqlite'); }

  async load(): Promise<void> {
    if (this.loaded) return;
    const database = this.connect();
    const before = this.state;
    database.exec('BEGIN IMMEDIATE');
    try {
      const row = database.prepare('SELECT payload, revision FROM state_snapshot WHERE id = 1').get();
      let source: string | undefined;
      if (row) {
        source = String(row.payload);
        this.revision = Number(row.revision);
        this.persistedSource = source;
      } else {
        try { source = readFileSync(this.path, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const rawState = source ? JSON.parse(source) : this.state;
      const parsed = savedSchema.parse(rawState);
      this.state = { ...parsed, receipts: parsed.receipts.map(receipt => ({ ...receipt, result: receipt.result })) };
      const recoveryEvents = this.recover(rawState.workspaces === undefined);
      this.writeState(database);
      for (const event of recoveryEvents) this.appendEvent(database, event);
      database.exec('COMMIT');
      this.loaded = true;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      this.state = before;
      this.revision = 0;
      this.persistedSource = undefined;
      throw error;
    }
  }

  private recover(migratingWorkspaces: boolean): CollaborationEventInput[] {
    const now = new Date().toISOString();
    for (const item of [...this.state.sessions, ...this.state.workflows]) {
      if (!this.state.workspaces.some(workspace => workspace.cwd === item.cwd)) {
        this.state.workspaces.push({ id: randomUUID(), name: item.cwd.split('/').filter(Boolean).pop() || item.cwd,
          cwd: item.cwd, pinned: false, tabs: [], activeTabId: null, createdAt: item.createdAt, updatedAt: item.updatedAt });
      }
    }
    for (const session of this.state.sessions) {
      const workspace = this.state.workspaces.find(item => item.cwd === session.cwd)!;
      if (migratingWorkspaces && !workspace.tabs.some(tab => tab.kind === 'agent' && tab.sessionId === session.id)) {
        const tab = { id: randomUUID(), kind: 'agent' as const, sessionId: session.id };
        workspace.tabs.push(tab);
        workspace.activeTabId ??= tab.id;
      }
      if (unfinished.has(session.status)) {
        moveSession(session, 'interrupted');
        session.error = '应用退出时任务尚未结束。确认后可继续，平台不会自动重跑。';
      }
      for (const attempt of session.attempts ?? []) {
        if (unfinished.has(attempt.status)) {
          moveSession(attempt, 'interrupted'); attempt.endedAt = now; attempt.error = session.error;
        }
      }
      session.approvals = [];
    }
    for (const workspace of this.state.workspaces) {
      workspace.tabs = workspace.tabs.filter(tab => tab.kind !== 'terminal');
      if (!workspace.tabs.some(tab => tab.id === workspace.activeTabId)) workspace.activeTabId = workspace.tabs[0]?.id ?? null;
      if (!workspace.tabs.some(tab => tab.id === workspace.secondaryTabId) || workspace.secondaryTabId === workspace.activeTabId) delete workspace.secondaryTabId;
    }
    for (const workflow of this.state.workflows) {
      if (workflow.status === 'running') moveWorkflow(workflow, 'interrupted');
      for (const step of workflow.steps) {
        if (step.status === 'running') moveStep(step, 'failed');
        for (const attempt of step.attempts ?? []) {
          if (attempt.status === 'running') { moveStep(attempt, 'failed'); attempt.endedAt = now; attempt.error = '应用退出时尝试尚未结束。'; }
        }
      }
    }
    const events: CollaborationEventInput[] = [];
    for (const run of this.state.collaboration.runs) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted'; run.updatedAt = now;
      run.error = '后台退出时协作尚未结束。确认后可继续，平台不会自动重跑。';
      events.push({ id: randomUUID(), runId: run.id, type: 'run.interrupted', source: 'platform', data: { reason: run.error }, createdAt: now });
    }
    const unfinishedTasks = new Set(['queued', 'running', 'waiting']);
    for (const task of this.state.collaboration.tasks) {
      if (unfinishedTasks.has(task.status)) {
        task.status = 'interrupted'; task.updatedAt = now;
        task.error = '后台退出时任务尚未结束。确认后可继续，平台不会自动重跑。';
        events.push({ id: randomUUID(), runId: task.runId, type: 'task.interrupted', source: 'platform', participantId: task.participantId,
          taskId: task.id, attemptId: task.attemptId, data: { reason: task.error }, createdAt: now });
      }
      for (const attempt of task.attempts) {
        if (!unfinishedTasks.has(attempt.status)) continue;
        attempt.status = 'interrupted'; attempt.endedAt = now; attempt.error = task.error ?? '后台退出时尝试尚未结束。';
      }
    }
    return events;
  }

  scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.persist(); }
      catch (error) { this.writeError = error instanceof Error ? error : new Error(String(error)); }
    }, 200);
  }

  atomic<T>(operation: (state: SavedState, transaction: StoreTransaction) => T): T {
    this.ensureWritable();
    if (this.inTransaction) throw new Error('不能嵌套状态事务');
    const database = this.connect();
    const before = structuredClone(this.state);
    const revision = this.revision;
    const persistedSource = this.persistedSource;
    database.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    let active = true;
    const requireActive = () => { if (!active) throw new Error('状态事务已经结束'); };
    try {
      const result = operation(this.state, {
        appendEvent: event => { requireActive(); return this.appendEvent(database, event); },
        putReceipt: receipt => { requireActive(); this.putReceipt(database, receipt); },
        receipt: key => { requireActive(); return this.receipt(key); },
      });
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('状态事务回调必须同步执行');
      this.writeState(database);
      database.exec('COMMIT');
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.writeError = undefined;
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      this.state = before;
      this.revision = revision;
      this.persistedSource = persistedSource;
      throw error;
    } finally {
      active = false;
      this.inTransaction = false;
    }
  }

  events(runId: string, afterSeq = 0, limit = 200): CollaborationEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('事件查询范围无效');
    return this.connect().prepare('SELECT seq, payload FROM collaboration_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, limit).map(row => ({ ...collaborationEventInputSchema.parse(JSON.parse(String(row.payload))), seq: Number(row.seq) }));
  }

  latestEventSeq(): number {
    return Number(this.connect().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM collaboration_events').get()?.seq ?? 0);
  }

  receipt(key: string): CollaborationReceipt | undefined {
    const row = this.connect().prepare('SELECT payload FROM collaboration_receipts WHERE key = ?').get(key);
    if (!row) return undefined;
    const parsed = collaborationReceiptSchema.parse(JSON.parse(String(row.payload)));
    return { ...parsed, result: parsed.result };
  }

  private appendEvent(database: DatabaseSync, input: CollaborationEventInput): CollaborationEvent {
    const event = collaborationEventInputSchema.parse(input);
    const result = database.prepare('INSERT INTO collaboration_events (id, run_id, payload) VALUES (?, ?, ?)')
      .run(event.id, event.runId, JSON.stringify(event));
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  private putReceipt(database: DatabaseSync, input: CollaborationReceipt): void {
    const receipt = collaborationReceiptSchema.parse(input);
    const previous = this.receipt(receipt.key);
    if (previous) {
      if (previous.hash !== receipt.hash || previous.runId !== receipt.runId || previous.identityId !== receipt.identityId
        || JSON.stringify(previous.result) !== JSON.stringify(receipt.result)) throw new Error('协作请求已有收据，不能覆盖');
      return;
    }
    database.prepare('INSERT INTO collaboration_receipts (key, payload) VALUES (?, ?)').run(receipt.key, JSON.stringify(receipt));
  }

  private connect(): DatabaseSync {
    if (this.closed) throw new Error('状态存储已经关闭');
    if (this.database) return this.database;
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.databasePath);
    try {
      chmodSync(this.databasePath, 0o600);
      if (Number(database.prepare('PRAGMA user_version').get()?.user_version) > 1) throw new Error('数据由更新版本创建，请使用兼容版本打开');
      database.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS state_snapshot (
          id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collaboration_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS collaboration_events_run_seq ON collaboration_events (run_id, seq);
        CREATE TABLE IF NOT EXISTS collaboration_receipts (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
        PRAGMA user_version = 1;
        BEGIN IMMEDIATE;
        COMMIT;
      `);
      this.database = database;
      return database;
    } catch (error) {
      database.close();
      if ((error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6) {
        throw new Error('该数据目录已有后台持有，不能启动第二个写入者', { cause: error });
      }
      throw error;
    }
  }

  private ensureWritable(): void {
    if (this.loaded) return;
    const existing = this.connect().prepare('SELECT id FROM state_snapshot WHERE id = 1').get();
    if (existing || existsSync(this.path)) throw new Error('写入已有数据前必须先加载状态');
    this.loaded = true;
  }

  private writeState(database: DatabaseSync): void {
    const source = JSON.stringify(this.state);
    if (source === this.persistedSource) return;
    if (this.revision === 0) database.prepare('INSERT INTO state_snapshot (id, payload, revision) VALUES (1, ?, 1)').run(source);
    else {
      const result = database.prepare('UPDATE state_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').run(source, this.revision);
      if (Number(result.changes) !== 1) throw new Error('数据已被其他后台修改，必须重新加载');
    }
    this.revision += 1;
    this.persistedSource = source;
  }

  private persist(): void {
    this.atomic(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.persist();
    if (this.writeError) throw this.writeError;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { if (this.loaded) await this.flush(); }
    finally {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.database?.close();
      this.database = undefined;
      this.closed = true;
    }
  }
}
