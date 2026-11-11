import type { SessionQueueItem } from './types';

export function canMoveQueuedPrompt(queue: readonly SessionQueueItem[], from: number, to: number): boolean {
  if (from === to || !queue[from] || !queue[to]) return false;
  return queue.slice(Math.min(from, to), Math.max(from, to) + 1).every(item => !item.agentSource && !item.edit && !item.steeringUnconfirmed);
}

export function canSteerQueuedPrompt(item: SessionQueueItem): boolean {
  return !item.agentSource && !item.edit && !item.steeringUnconfirmed && Boolean(item.input.text.trim())
    && !item.input.attachments?.length && !item.input.evidence?.length && !item.input.skills?.length;
}
