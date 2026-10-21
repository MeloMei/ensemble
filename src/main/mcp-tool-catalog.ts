import { z } from 'zod';
import { collaborationParticipantSchema, collaborationPermissionsSchema, collaborationLimitsSchema, collaborationTaskTemplateSchema } from '../shared/collaboration';

const id = z.string().min(1).max(200);
const text = z.string().max(200_000);
const requestId = id.describe('Required stable identifier for this exact mutation. Reuse it only when reconnecting or retrying the same unchanged request; never invent a replacement mutation after an uncertain response.');
const runId = id;
const permissions = collaborationPermissionsSchema.strict().extend({ workspace: z.object({ cwd: z.string(), access: z.enum(['read-only', 'read-write']) }).strict().optional() });
const participant = collaborationParticipantSchema.strict().extend({ permissions,
  binding: z.object({ identityId: z.string().optional(), sessionId: z.string().optional(), nativeId: z.string().optional() }).strict().optional(),
  settings: z.object({ effort: z.string().optional(), permission: z.enum(['review', 'read-only']).optional(), skillIds: z.array(z.string()).optional() }).strict().optional(),
});
const limits = collaborationLimitsSchema.strict();
const step = collaborationTaskTemplateSchema.strict();
const relationships = z.array(z.object({ id, from: id, to: id, kind: z.string().min(1), label: z.string().optional() }).strict()).max(500);
export const definitionInputSchema = z.object({
  name: z.string().trim().min(1).max(200), cwd: z.string().min(1).max(4096),
  participants: z.array(participant).min(1).max(100), relationships: relationships.default([]),
  steps: z.array(step).max(500).optional(), limits: limits.default({}),
  completion: z.enum(['manual', 'all-tasks']).optional(),
}).strict();

export interface McpToolDefinition { name: string; description: string; schema: z.ZodRawShape }
export const COLLABORATION_MCP_TOOLS: McpToolDefinition[] = [
  { name: 'get_context', description: 'Read your authenticated identity, permitted workspaces, runs, participants and runtime capabilities. Roles describe user-assigned responsibilities and never grant authority.', schema: { runId: id.optional() } },
  { name: 'create_run', description: 'Create a user-configured collaboration. Participants and roles are arbitrary. Managed agents run in Ensemble; external agents claim tasks using their own MCP client. A callerParticipantId binds this caller to an explicitly chosen participant. Set start=true to start; otherwise a draft is created.', schema: { requestId, ...definitionInputSchema.shape, start: z.boolean().optional(), callerParticipantId: id.optional() } },
  { name: 'update_run', description: 'Create a configuration version for future tasks. Existing tasks retain their participant and permission snapshot. Requires configure permission and expectedVersion.', schema: { requestId, runId, expectedVersion: z.number().int().positive(), name: z.string().min(1).max(200).optional(), participants: z.array(participant).min(1).max(100).optional(), relationships: relationships.optional(), steps: z.array(step).max(500).optional(), limits: limits.optional(), completion: z.enum(['manual', 'all-tasks']).optional() } },
  { name: 'get_run', description: 'Read the actual run, task attempts, messages and artifact version metadata. This is recorded execution evidence, not inferred model understanding.', schema: { runId } },
  { name: 'submit_task', description: 'Submit a task to a participant with versioned inputs and dependencies. Returns a persisted task ID before dispatch. Use stable requestId. Same-workspace managed callers must finish their physical turn before another writer executes.', schema: { requestId, runId, participantId: id, title: z.string().trim().min(1).max(200), prompt: text, dependsOn: z.array(id).max(500).optional(), artifactIds: z.array(id).max(100).optional(), parentTaskId: id.optional() } },
  { name: 'claim_task', description: 'Claim one ready task assigned to your external participant. The returned attemptId must accompany submit_result; stale, cancelled or duplicate claims cannot overwrite a later attempt.', schema: { requestId, runId, taskId: id } },
  { name: 'send_message', description: 'Send information or a question to an authorized participant. Accepted, queued, input-injected and externally-reported delivery are separate facts. This cannot approve user permission requests. toSessionId is retained for older owned conversations.', schema: { requestId, runId: id.optional(), toParticipantId: id.optional(), toSessionId: id.optional(), text, kind: z.enum(['message', 'question', 'result']).optional(), artifactIds: z.array(id).max(100).optional(), targetTaskId: id.optional() } },
  { name: 'submit_result', description: 'Submit the result of an external task attempt you own. Ensemble records the source as externally reported. Requires the exact current attemptId.', schema: { requestId, runId, taskId: id, attemptId: id, status: z.enum(['completed', 'failed']), text, artifactIds: z.array(id).max(100).optional() } },
  { name: 'publish_artifact', description: 'Publish an immutable version of task input or output using a required stable requestId. Supply exactly one of content or a permitted local regular file path. File bytes are copied and hashed before the version is recorded. artifactId adds a version to an existing artifact.', schema: { requestId, runId, participantId: id.optional(), taskId: id.optional(), name: z.string().min(1).max(300), kind: z.string().min(1).max(100).optional(), content: text.optional(), path: z.string().min(1).max(4096).optional(), artifactId: id.optional() } },
  { name: 'get_artifact', description: 'Read one exact artifact version, including its immutable content and provenance.', schema: { runId, artifactVersionId: id } },
  { name: 'wait_events', description: 'Wait at most 30 seconds for recorded events, optionally for specific task results. Save afterSeq across reconnects. If disposition=turn_must_finish, end this managed turn; Ensemble resumes the same native conversation after awaited tasks settle. Do not poll in that turn.', schema: { runId, afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional(), timeoutMs: z.number().int().min(0).max(30_000).optional(), taskIds: z.array(id).max(500).optional() } },
  { name: 'control_run', description: 'Start, pause, resume, cancel or explicitly finish a run, subject to granted configure permission. Resume preserves successful work and creates new attempts only for interrupted work. Finish requires all tasks settled.', schema: { requestId, runId, action: z.enum(['start', 'pause', 'resume', 'cancel', 'finish']) } },
  { name: 'control_task', description: 'Cancel a task or explicitly retry a failed, cancelled or interrupted task. Existing attempts and results remain recorded.', schema: { requestId, runId, taskId: id, action: z.enum(['cancel', 'retry']) } },
];

export const LEGACY_MCP_TOOLS: McpToolDefinition[] = [
  { name: 'create_worker', description: 'Compatibility entry for older Workbench conversations. In a collaboration, use submit_task with a configured participant. Older owned sessions retain their original directory-safe delegation behavior.', schema: { requestId: id, title: id, providerId: id, modelId: id.optional(), prompt: text, cwd: z.string().max(4096).optional() } },
  { name: 'get_worker', description: 'Inspect an older owned worker. For collaborations use get_run.', schema: { sessionId: id } },
  { name: 'wait_workers', description: 'Wait for older owned workers. Same-directory work requires finishing this physical turn. For collaborations use wait_events.', schema: { sessionIds: z.array(id).min(1).max(500), timeoutMs: z.number().int().min(0).max(30_000).optional() } },
  { name: 'ask_parent', description: 'Ask the creator of this task a question. This is a compatibility alias for send_message; it does not grant user approval.', schema: { requestId: id, text } },
];
export const WORKBENCH_MCP_TOOLS = [...COLLABORATION_MCP_TOOLS, ...LEGACY_MCP_TOOLS];
export const WORKBENCH_MCP_TOOL_NAMES = WORKBENCH_MCP_TOOLS.map(tool => tool.name);
export const collaborationOperationSchemas = new Map(COLLABORATION_MCP_TOOLS.map(tool => [tool.name, z.object(tool.schema).strict()]));
