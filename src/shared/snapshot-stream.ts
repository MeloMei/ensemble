import type { SnapshotFrame } from './backend';
import type { Message, Snapshot } from './types';

export class SnapshotGapError extends Error {
  constructor() { super('后台状态游标已失效，需要重新同步。'); }
}

export class SnapshotReplica {
  private value?: Snapshot;
  private instanceId?: string;
  private revision = -1;

  apply(frame: SnapshotFrame): Snapshot | undefined {
    if (frame.type === 'reset') {
      this.value = frame.snapshot;
      this.instanceId = frame.instanceId;
      this.revision = frame.revision;
      return this.value;
    }
    if (frame.instanceId !== this.instanceId || !this.value || frame.baseRevision !== this.revision) throw new SnapshotGapError();
    if (frame.revision <= this.revision) throw new SnapshotGapError();
    const sessions = new Map(this.value.sessions.map(session => [session.id, session]));
    for (const id of frame.removedSessionIds) sessions.delete(id);
    for (const patch of frame.sessions) {
      const previous = sessions.get(patch.id);
      let messages = previous?.messages ?? [];
      if (patch.messages) {
        const byId = new Map<string, Message>(messages.map(message => [message.id, message]));
        for (const id of patch.messages.removed) byId.delete(id);
        for (const message of patch.messages.upserts) byId.set(message.id, message);
        messages = patch.messages.order ? patch.messages.order.map(id => {
          const message = byId.get(id);
          if (!message) throw new SnapshotGapError();
          return message;
        }) : [...byId.values()];
      }
      if (!patch.summary && !previous) throw new SnapshotGapError();
      sessions.set(patch.id, { ...(patch.summary ?? previous!), messages });
    }
    const order = frame.sessionOrder ?? this.value.sessions.map(session => session.id).filter(id => sessions.has(id));
    this.value = { ...this.value, ...frame.fields, sessions: order.map(id => {
      const session = sessions.get(id);
      if (!session) throw new SnapshotGapError();
      return session;
    }) };
    this.revision = frame.revision;
    return this.value;
  }
}
