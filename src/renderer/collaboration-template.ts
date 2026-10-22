import { translate } from '../shared/i18n';
import type { CollaborationDefinition, CollaborationParticipant, CollaborationTaskTemplate } from '../shared/collaboration';
import type { ProviderInfo } from '../shared/types';

export type CollaborationDraft = Pick<CollaborationDefinition, 'name' | 'cwd' | 'participants' | 'relationships' | 'limits' | 'completion'> & {
  steps: CollaborationTaskTemplate[];
};

export function participantPermissionIssue(participant: CollaborationParticipant, provider?: ProviderInfo): string | undefined {
  if (participant.mode === 'external' || !provider) return;
  if ((participant.permissions.workspace?.access === 'read-only' || participant.settings?.permission === 'read-only') && !provider.capabilities.permissions) {
    return translate('collaboration:permission.unsupported', { name: provider.name });
  }
}

export function withCollaborationGoal(definition: CollaborationDraft, goal: string): CollaborationDraft {
  if (!goal.trim()) return definition;
  return { ...definition, steps: definition.steps.map(step => ({ ...step, prompt: translate('collaboration:template.goalPrefix', { goal: goal.trim(), prompt: step.prompt }) })) };
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
      id: 'implementer', name: translate('collaboration:template.implementer'), mode: 'managed', roles: [translate('collaboration:template.implementationRole')],
      providerId: input.implementer?.id, modelId: input.implementerModelId,
      instructions: translate('collaboration:template.implementationInstructions'),
      settings: input.implementer?.capabilities.permissions ? { permission: 'review' } : {},
      permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false, workspace: { cwd: input.cwd, access: 'read-write' } },
    },
    {
      id: 'reviewer', name: translate('collaboration:template.reviewer'), mode: 'managed', roles: [translate('collaboration:template.reviewRole')],
      providerId: input.reviewer?.id, modelId: input.reviewerModelId,
      instructions: translate('collaboration:template.reviewInstructions'),
      settings: { permission: 'read-only' },
      permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false, workspace: { cwd: input.cwd, access: 'read-only' } },
    },
  ];
  return withCollaborationGoal({
    name: translate('collaboration:template.name'), cwd: input.cwd, participants,
    relationships: [{ id: 'implementation-review', from: 'implementer', to: 'reviewer', kind: translate('collaboration:template.relationshipKind'), label: translate('collaboration:template.relationshipLabel') }],
    steps: [
      { id: 'implement', title: translate('collaboration:template.implementationTitle'), participantId: 'implementer', prompt: translate('collaboration:template.implementationPrompt'), dependsOn: [], artifactIds: [] },
      { id: 'review', title: translate('collaboration:template.reviewTitle'), participantId: 'reviewer', prompt: translate('collaboration:template.reviewPrompt'), dependsOn: ['implement'], artifactIds: [] },
    ],
    limits: { maxConcurrentTasks: 1 }, completion: 'all-tasks',
  }, input.goal ?? '');
}
