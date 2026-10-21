import type { RunStatus, SessionStatus, StepStatus } from '../shared/types';

const sessionTransitions: Record<SessionStatus, SessionStatus[]> = {
  idle: ['queued', 'running'],
  queued: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['queued', 'waiting_approval', 'waiting_children', 'completed', 'failed', 'cancelled', 'interrupted'],
  waiting_approval: ['running', 'failed', 'cancelled', 'interrupted'],
  waiting_children: ['queued', 'completed', 'failed', 'cancelled', 'interrupted'],
  completed: ['idle', 'queued', 'running'], failed: ['idle', 'queued', 'running'],
  cancelled: ['idle', 'queued', 'running'], interrupted: ['idle', 'queued', 'running'],
};
const workflowTransitions: Record<RunStatus, RunStatus[]> = {
  draft: ['running'], running: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [], failed: ['running'], cancelled: ['running'], interrupted: ['running'],
};
const stepTransitions: Record<StepStatus, StepStatus[]> = {
  pending: ['running', 'blocked', 'cancelled'], running: ['completed', 'failed', 'cancelled'],
  completed: [], failed: ['pending'], blocked: ['pending'], cancelled: ['pending'],
};

function transition<T extends string>(entity: { status: T }, next: T, allowed: Record<T, T[]>): void {
  if (entity.status === next) return;
  if (!allowed[entity.status].includes(next)) throw new Error(`无效的状态变更：${entity.status} → ${next}`);
  entity.status = next;
}

export const moveSession = (entity: { status: SessionStatus }, next: SessionStatus) => transition(entity, next, sessionTransitions);
export const moveWorkflow = (entity: { status: RunStatus }, next: RunStatus) => transition(entity, next, workflowTransitions);
export const moveStep = (entity: { status: StepStatus }, next: StepStatus) => transition(entity, next, stepTransitions);
