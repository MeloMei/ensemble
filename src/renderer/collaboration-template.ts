import type { CollaborationDefinition, CollaborationParticipant, CollaborationTaskTemplate } from '../shared/collaboration';
import type { ProviderInfo } from '../shared/types';

export type CollaborationDraft = Pick<CollaborationDefinition, 'name' | 'cwd' | 'participants' | 'relationships' | 'limits' | 'completion'> & {
  steps: CollaborationTaskTemplate[];
};

export function participantPermissionIssue(participant: CollaborationParticipant, provider?: ProviderInfo): string | undefined {
  if (participant.mode === 'external' || !provider) return;
  if ((participant.permissions.workspace?.access === 'read-only' || participant.settings?.permission === 'read-only') && !provider.capabilities.permissions) {
    return `${provider.name} 不支持可验证的只读权限。请选择支持只读的运行时，或明确改为可读写。`;
  }
}

export function withCollaborationGoal(definition: CollaborationDraft, goal: string): CollaborationDraft {
  if (!goal.trim()) return definition;
  return { ...definition, steps: definition.steps.map(step => ({ ...step, prompt: `用户目标：\n${goal.trim()}\n\n${step.prompt}` })) };
}

export function createImplementationReviewDraft(input: {
  cwd: string;
  implementer?: ProviderInfo;
  reviewer?: ProviderInfo;
  implementerModelId?: string;
  reviewerModelId?: string;
  goal?: string;
}): CollaborationDraft {
  const participants: CollaborationParticipant[] = [
    {
      id: 'implementer', name: '实现者', mode: 'managed', roles: ['实现'],
      providerId: input.implementer?.id, modelId: input.implementerModelId,
      instructions: '完成用户指定的修改，保留已有功能。只验证改动及直接影响的行为。结束时说明修改内容、验证结果和仍待确认的事项。',
      settings: input.implementer?.capabilities.permissions ? { permission: 'review' } : {},
      permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false, workspace: { cwd: input.cwd, access: 'read-write' } },
    },
    {
      id: 'reviewer', name: '审阅者', mode: 'managed', roles: ['审阅'],
      providerId: input.reviewer?.id, modelId: input.reviewerModelId,
      instructions: '以只读方式审阅实际文件变化和前序任务输出。优先指出与用户目标有关的缺陷、遗漏及验证缺口；没有发现问题时明确说明检查范围。',
      settings: { permission: 'read-only' },
      permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false, workspace: { cwd: input.cwd, access: 'read-only' } },
    },
  ];
  return withCollaborationGoal({
    name: '实现与审阅', cwd: input.cwd, participants,
    relationships: [{ id: 'implementation-review', from: 'implementer', to: 'reviewer', kind: '交付审阅', label: '实现后审阅' }],
    steps: [
      { id: 'implement', title: '实现目标', participantId: 'implementer', prompt: '根据用户目标检查项目并完成修改。交付修改说明、必要验证结果和未解决事项，供下一位参与者审阅。', dependsOn: [], artifactIds: [] },
      { id: 'review', title: '审阅改动', participantId: 'reviewer', prompt: '对照用户目标、前序实现输出和实际文件变化进行只读审阅。给出具体文件位置、发现的问题和验证缺口；不要修改文件或扩大检查范围。', dependsOn: ['implement'], artifactIds: [] },
    ],
    limits: { maxConcurrentTasks: 1 }, completion: 'all-tasks',
  }, input.goal ?? '');
}
