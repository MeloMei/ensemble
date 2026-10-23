export interface BackendEndpoint {
  version: 1;
  url: string;
  token: string;
  pid: number;
  instanceId: string;
  startedAt: string;
  stoppedAt?: string;
}

export interface BackendReply<T = unknown> { result?: T; error?: string }
import type { Message, Session, Snapshot } from './types';

export const BACKEND_STREAM_VERSION = 2;

export interface BackendStreamError { code: 'FRAME_TOO_LARGE'; limitBytes: number }

export interface BackendConnectionState {
  status: 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'failed';
  synced: boolean;
  instanceId?: string;
  lastReceivedAt?: string;
  revision?: number;
  error?: string;
}

export interface SessionHistoryPage { messages: Message[]; beforeCursor?: string; hasMore: boolean }
export interface SessionHistoryWindow extends SessionHistoryPage { afterCursor?: string; hasAfter: boolean }
export type TerminalOutputEvent =
  | { type: 'tail'; terminalId: string; output: string; outputOffset: number }
  | { type: 'append'; terminalId: string; data: string; offset: number };

export interface SessionStreamPatch {
  id: string;
  summary?: Omit<Session, 'messages'>;
  messages?: { upserts: Message[]; removed: string[]; order?: string[] };
}
export interface SnapshotResetFrame {
  type: 'reset'; instanceId: string; revision: number; subscriptionId: string; snapshot: Snapshot;
}
export interface SnapshotDeltaFrame {
  type: 'delta'; instanceId: string; revision: number; baseRevision: number;
  fields?: Partial<Omit<Snapshot, 'sessions'>>;
  sessions: SessionStreamPatch[];
  removedSessionIds: string[];
  sessionOrder?: string[];
}
export type SnapshotFrame = SnapshotResetFrame | SnapshotDeltaFrame;
