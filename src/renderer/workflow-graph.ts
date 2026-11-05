import type { WorkflowStepInput } from '../shared/types';

export interface WorkflowDependency { id: string; source: string; target: string }
export type WorkflowDependencyError = 'self' | 'duplicate' | 'cycle' | 'missing';

export const workflowDependencyId = (source: string, target: string) => JSON.stringify([source, target]);

export function workflowDependencies(steps: WorkflowStepInput[]): WorkflowDependency[] {
  return steps.flatMap(step => step.dependsOn.map(source => ({ id: workflowDependencyId(source, step.id), source, target: step.id })));
}

export function validateWorkflowDependency(steps: Pick<WorkflowStepInput, 'id' | 'dependsOn'>[], source: string, target: string): WorkflowDependencyError | undefined {
  if (source === target) return 'self';
  if (!steps.some(step => step.id === source) || !steps.some(step => step.id === target)) return 'missing';
  if (steps.find(step => step.id === target)?.dependsOn.includes(source)) return 'duplicate';
  const visited = new Set<string>();
  const pending = [source];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return 'cycle';
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(steps.find(step => step.id === id)?.dependsOn ?? []));
  }
  return undefined;
}

export function setWorkflowDependency(steps: WorkflowStepInput[], source: string, target: string, previous?: WorkflowDependency): { steps: WorkflowStepInput[]; error?: WorkflowDependencyError } {
  const base = previous ? removeWorkflowDependency(steps, previous) : steps;
  const error = validateWorkflowDependency(base, source, target);
  if (error) return { steps, error };
  return { steps: base.map(step => step.id === target ? { ...step, dependsOn: [...step.dependsOn, source] } : step) };
}

export function removeWorkflowDependency(steps: WorkflowStepInput[], dependency: WorkflowDependency): WorkflowStepInput[] {
  return steps.map(step => step.id === dependency.target ? { ...step, dependsOn: step.dependsOn.filter(id => id !== dependency.source) } : step);
}

export function removeWorkflowStep(steps: WorkflowStepInput[], id: string): WorkflowStepInput[] {
  return steps.filter(step => step.id !== id).map(step => ({ ...step, dependsOn: step.dependsOn.filter(source => source !== id) }));
}
