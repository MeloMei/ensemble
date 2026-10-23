import type { SessionStreamPatch, SnapshotFrame } from '../shared/backend';
import type { Message, Session, Snapshot } from '../shared/types';

export const SESSION_TAIL_LIMIT = 100;
type SnapshotFields = Omit<Snapshot, 'sessions'>;
interface SessionFingerprint { summary: string; messages: Map<string, string>; order: string[] }

export class SnapshotProjection {
  private revision = -1;
  private fields = new Map<keyof SnapshotFields, string>();
  private sessions = new Map<string, SessionFingerprint>();
  private order: string[] = [];

  constructor(readonly instanceId: string, readonly subscriptionId: string, private watched: Set<string>) {}

  watch(ids: string[]): void { this.watched = new Set(ids); this.revision = -1; }
  reset(): void { this.revision = -1; }

  frame(source: Snapshot, revision: number): SnapshotFrame | undefined {
    const reset = this.revision < 0;
    const { sessions: _sessions, ...metadata } = source;
    const fields: SnapshotFields = { ...metadata,
      mails: (source.mails ?? []).filter(mail => this.watched.has(mail.toSessionId) || this.watched.has(mail.fromSessionId)),
      terminals: source.terminals.map(terminal => ({ ...terminal, output: '', outputOffset: 0 })) };
    const changedFields: Partial<SnapshotFields> = {};
    for (const key of Object.keys(fields) as (keyof SnapshotFields)[]) {
      const fingerprint = JSON.stringify(fields[key]);
      if (this.fields.get(key) !== fingerprint) Object.assign(changedFields, { [key]: fields[key] });
      this.fields.set(key, fingerprint);
    }
    const patches: SessionStreamPatch[] = [];
    const projected: Session[] = [];
    const nextSessions = new Map<string, SessionFingerprint>();
    for (const session of source.sessions) {
      const watched = this.watched.has(session.id);
      const messages: Message[] = watched ? session.messages.slice(-SESSION_TAIL_LIMIT) : [];
      const { messages: _messages, ...metadata } = session;
      const summary = { ...metadata, messageCount: session.messages.length,
        attempts: session.attempts?.slice(-32).map(attempt => ({ ...attempt, prompt: '' })),
        draft: watched ? session.draft : undefined,
        queue: watched ? session.queue : session.queue?.map(item => ({ ...item, input: { text: '' } })),
        historyLoaded: watched,
        historyCursor: messages.length && messages.length < session.messages.length ? messages[0].id : undefined };
      const summaryFingerprint = JSON.stringify(summary);
      const previous = this.sessions.get(session.id);
      const nextMessages = new Map(messages.map(message => [message.id, JSON.stringify(message)]));
      const order = messages.map(message => message.id);
      const changedOrder = JSON.stringify(previous?.order) !== JSON.stringify(order);
      const upserts = messages.filter(message => previous?.messages.get(message.id) !== nextMessages.get(message.id));
      const removed = [...(previous?.messages.keys() ?? [])].filter(id => !nextMessages.has(id));
      const patch: SessionStreamPatch = { id: session.id };
      if (!previous || previous.summary !== summaryFingerprint) patch.summary = summary;
      if (upserts.length || removed.length || changedOrder) patch.messages = { upserts, removed, ...(changedOrder ? { order } : {}) };
      if (patch.summary || patch.messages) patches.push(patch);
      nextSessions.set(session.id, { summary: summaryFingerprint, messages: nextMessages, order });
      if (reset) projected.push({ ...summary, messages });
    }
    const order = source.sessions.map(session => session.id);
    const changedOrder = JSON.stringify(order) !== JSON.stringify(this.order);
    const removedSessionIds = [...this.sessions.keys()].filter(id => !nextSessions.has(id));
    this.sessions = nextSessions; this.order = order;
    if (!reset && !patches.length && !removedSessionIds.length && !changedOrder && !Object.keys(changedFields).length) return undefined;
    const baseRevision = this.revision; this.revision = revision;
    return reset ? { type: 'reset', instanceId: this.instanceId, subscriptionId: this.subscriptionId, revision,
      snapshot: { ...fields, sessions: projected } } : { type: 'delta', instanceId: this.instanceId, revision, baseRevision,
      fields: changedFields, sessions: patches, removedSessionIds, ...(changedOrder ? { sessionOrder: order } : {}) };
  }
}
