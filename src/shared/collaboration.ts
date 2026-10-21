import { z } from 'zod';

const record = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const timestamp = z.string();
const identifier = z.string().min(1);

export const collaborationRunStatusSchema = z.enum(['draft', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']);
export const collaborationTaskStatusSchema = z.enum(['pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']);
export type CollaborationRunStatus = z.infer<typeof collaborationRunStatusSchema>;
export type CollaborationTaskStatus = z.infer<typeof collaborationTaskStatusSchema>;

export const collaborationPermissionsSchema = record({
  submitTasks: z.boolean(), sendMessages: z.boolean(), configureRun: z.boolean(), publishArtifacts: z.boolean(),
  allowedTargets: z.array(identifier).optional(),
  workspace: record({ cwd: z.string(), access: z.enum(['read-only', 'read-write']) }).optional(),
  allowedTools: z.array(z.string()).optional(),
});
export type CollaborationPermissions = z.infer<typeof collaborationPermissionsSchema>;

export const collaborationParticipantSchema = record({
  id: identifier, name: z.string(), mode: z.enum(['managed', 'external']), roles: z.array(z.string()),
  instructions: z.string().optional(), providerId: z.string().optional(), modelId: z.string().optional(), cwd: z.string().optional(),
  binding: record({ identityId: z.string().optional(), sessionId: z.string().optional(), nativeId: z.string().optional() }).optional(),
  settings: record({ effort: z.string().optional(), permission: z.enum(['review', 'read-only']).optional(), skillIds: z.array(z.string()).optional() }).optional(),
  permissions: collaborationPermissionsSchema,
});
export type CollaborationParticipant = z.infer<typeof collaborationParticipantSchema>;

export const collaborationLimitsSchema = record({
  maxConcurrentTasks: z.number().int().positive().optional(), maxTasks: z.number().int().positive().optional(),
  maxAttemptsPerTask: z.number().int().positive().optional(), maxTaskTurns: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().nonnegative().optional(), maxOutputTokens: z.number().int().nonnegative().optional(),
  maxEstimatedCost: z.number().nonnegative().optional(), currency: z.string().optional(), deadlineAt: timestamp.optional(),
});
export type CollaborationLimits = z.infer<typeof collaborationLimitsSchema>;

export const collaborationTaskTemplateSchema = record({
  id: identifier, title: z.string(), participantId: identifier, prompt: z.string(),
  dependsOn: z.array(identifier), artifactIds: z.array(identifier),
});
export type CollaborationTaskTemplate = z.infer<typeof collaborationTaskTemplateSchema>;

export const collaborationDefinitionSchema = record({
  id: identifier, version: z.number().int().positive(), name: z.string(), cwd: z.string(),
  participants: z.array(collaborationParticipantSchema),
  relationships: z.array(record({ id: identifier, from: identifier, to: identifier, kind: z.string(), label: z.string().optional() })),
  steps: z.array(collaborationTaskTemplateSchema).optional(), limits: collaborationLimitsSchema,
  completion: z.enum(['manual', 'all-tasks']).optional(),
  createdAt: timestamp, updatedAt: timestamp,
});
export type CollaborationDefinition = z.infer<typeof collaborationDefinitionSchema>;

export const collaborationRunSchema = record({
  id: identifier, definitionId: identifier, definitionVersion: z.number().int().positive(),
  definitionSnapshot: collaborationDefinitionSchema, status: collaborationRunStatusSchema,
  createdBy: identifier, createdAt: timestamp, updatedAt: timestamp, endedAt: timestamp.optional(), error: z.string().optional(),
});
export type CollaborationRun = z.infer<typeof collaborationRunSchema>;

export const collaborationAttemptSchema = record({
  id: identifier, status: collaborationTaskStatusSchema, sessionId: identifier.optional(), nativeId: identifier.optional(),
  engineAttemptId: identifier.optional(),
  definitionVersion: z.number().int().positive().optional(), participantSnapshot: collaborationParticipantSchema.optional(),
  retryOf: identifier.optional(), continuationOf: identifier.optional(), physicalTurns: z.number().int().nonnegative().optional(),
  startedAt: timestamp, endedAt: timestamp.optional(), error: z.string().optional(),
  inputArtifactIds: z.array(identifier), outputArtifactIds: z.array(identifier),
});
export type CollaborationAttempt = z.infer<typeof collaborationAttemptSchema>;

export const collaborationTaskSchema = record({
  id: identifier, runId: identifier, participantId: identifier, createdBy: identifier, title: z.string(), prompt: z.string(),
  definitionVersion: z.number().int().positive(), participantSnapshot: collaborationParticipantSchema,
  dependsOn: z.array(identifier), artifactIds: z.array(identifier), status: collaborationTaskStatusSchema,
  parentTaskId: identifier.optional(), waitingForTaskIds: z.array(identifier).optional(),
  attempts: z.array(collaborationAttemptSchema), sessionId: identifier.optional(), attemptId: identifier.optional(),
  error: z.string().optional(), result: z.string().optional(), createdAt: timestamp, updatedAt: timestamp,
});
export type CollaborationTask = z.infer<typeof collaborationTaskSchema>;

export const collaborationMessageSchema = record({
  id: identifier, runId: identifier, fromParticipantId: identifier, toParticipantId: identifier,
  taskId: identifier.optional(), attemptId: identifier.optional(),
  targetTaskId: identifier.optional(), targetAttemptId: identifier.optional(),
  kind: z.enum(['message', 'question', 'result']), text: z.string(), artifactIds: z.array(identifier),
  delivery: z.enum(['accepted', 'queued', 'injected', 'reported', 'failed']),
  source: z.enum(['platform', 'managed', 'external']), createdAt: timestamp, deliveredAt: timestamp.optional(), error: z.string().optional(),
});
export type CollaborationMessage = z.infer<typeof collaborationMessageSchema>;

export const collaborationArtifactVersionSchema = record({
  id: identifier, artifactId: identifier, runId: identifier, version: z.number().int().positive(),
  participantId: identifier, taskId: identifier.optional(), attemptId: identifier.optional(), name: z.string(), kind: z.string(),
  content: z.string().optional(), path: z.string().optional(), mimeType: z.string().optional(),
  sha256: z.string(), revision: z.string().optional(), createdAt: timestamp,
});
export type CollaborationArtifactVersion = z.infer<typeof collaborationArtifactVersionSchema>;

export const collaborationIdentitySchema = record({
  id: identifier, name: z.string(), tokenHash: z.string(), createdAt: timestamp, revokedAt: timestamp.optional(),
  policy: record({ createRuns: z.boolean(), workspaceRoots: z.array(z.string()), providerIds: z.array(z.string()).optional() }).optional(),
});
export type CollaborationIdentity = z.infer<typeof collaborationIdentitySchema>;

export const collaborationGrantSchema = record({
  id: identifier, identityId: identifier, runId: identifier, participantId: identifier,
  scopes: z.array(z.string()), createdAt: timestamp, revokedAt: timestamp.optional(),
});
export type CollaborationGrant = z.infer<typeof collaborationGrantSchema>;

export const collaborationEventInputSchema = record({
  id: identifier, runId: identifier, type: z.string(), source: z.enum(['platform', 'managed', 'external']),
  cause: identifier.optional(), participantId: identifier.optional(), targetParticipantId: identifier.optional(),
  taskId: identifier.optional(), attemptId: identifier.optional(), messageId: identifier.optional(), artifactVersionId: identifier.optional(),
  data: z.record(z.unknown()), createdAt: timestamp,
});
export type CollaborationEventInput = z.infer<typeof collaborationEventInputSchema>;
export interface CollaborationEvent extends CollaborationEventInput { seq: number }

export const collaborationReceiptSchema = record({
  key: identifier, hash: z.string(), runId: identifier.optional(), identityId: identifier.optional(),
  result: z.unknown().refine(value => value !== undefined, '协作请求收据缺少结果'), createdAt: timestamp,
});
export type CollaborationReceipt = z.infer<typeof collaborationReceiptSchema> & { result: unknown };

export const collaborationStateSchema = record({
  definitions: z.array(collaborationDefinitionSchema), runs: z.array(collaborationRunSchema),
  tasks: z.array(collaborationTaskSchema), messages: z.array(collaborationMessageSchema),
  artifacts: z.array(collaborationArtifactVersionSchema), identities: z.array(collaborationIdentitySchema), grants: z.array(collaborationGrantSchema),
});
export type CollaborationState = z.infer<typeof collaborationStateSchema>;

export function emptyCollaborationState(): CollaborationState {
  return { definitions: [], runs: [], tasks: [], messages: [], artifacts: [], identities: [], grants: [] };
}
