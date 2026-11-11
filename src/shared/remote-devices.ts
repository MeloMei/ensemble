import { z } from 'zod';

const id = z.string().min(1).max(200);
const absolutePath = (max: number) => z.string().startsWith('/').max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const sshPath = absolutePath(2048);
const projectPath = absolutePath(4096);

export const remoteCreationInput = z.object({
  cwd: projectPath,
  providerId: id,
  title: z.string().trim().max(200).optional(),
}).strict();

export const remoteDeviceInput = z.object({
  name: z.string().trim().min(1).max(80),
  destination: z.string().trim().max(255).regex(/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/),
  cliPath: sshPath,
  nodePath: sshPath.optional(),
  dataPath: sshPath.optional(),
}).strict();

export type RemoteDeviceInput = z.infer<typeof remoteDeviceInput>;
export type RemoteDevice = RemoteDeviceInput & { id: string };

export const remoteRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), sessionId: id.optional() }).strict(),
  remoteCreationInput.extend({ action: z.literal('create'), commandId: z.string().uuid() }),
  z.object({ action: z.literal('send'), sessionId: id, providerId: id, text: z.string().trim().min(1).max(40000), commandId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('approve'), approvalId: id, choiceId: id, commandId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('answer'), approvalId: id, answers: z.record(z.array(z.string().min(1).max(2000)).min(1).max(50)), commandId: z.string().uuid() }).strict(),
]);

export type RemoteRequest = z.infer<typeof remoteRequest>;
const status = z.enum(['idle', 'queued', 'running', 'waiting_approval', 'waiting_children', 'completed', 'failed', 'cancelled', 'interrupted']);
const sessionSummary = z.object({ id, title: z.string(), providerId: id, status, updatedAt: z.string(), pendingApprovals: z.number().int().nonnegative() });
const message = z.object({ id, role: z.enum(['user', 'assistant', 'activity']), text: z.string(), createdAt: z.string() });
const label = z.object({ key: z.string(), values: z.record(z.union([z.string(), z.number()])).optional() });
const option = z.object({ label: z.string(), description: z.string().optional(), labelI18n: label.optional() });
const approval = z.object({
  id, sessionId: id, title: z.string(), titleI18n: label.optional(), detail: z.string(),
  choices: z.array(z.object({ id, label: z.string(), labelI18n: label.optional() })),
  questions: z.array(z.object({
    id, question: z.string(), header: z.string(), headerI18n: label.optional(),
    options: z.array(option), multiSelect: z.boolean(), allowCustomAnswer: z.boolean().optional(),
  })).optional(),
});
const project = z.object({ cwd: projectPath, name: z.string().max(200) });
const runtime = z.object({ id, name: z.string().max(200) });
const snapshot = z.object({
  creation: z.object({ projects: z.array(project).max(200), runtimes: z.array(runtime).max(200) }).optional(),
  sessions: z.array(sessionSummary).max(200), limited: z.boolean(),
  selected: z.object({ session: sessionSummary, messages: z.array(message).max(40), approvals: z.array(approval) }).optional(),
});
export const remoteReply = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), ok: z.literal(true), snapshot: snapshot.optional() }),
  z.object({ version: z.literal(1), ok: z.literal(false), error: z.string().max(300) }),
]);
export type RemoteSessionSummary = z.infer<typeof sessionSummary>;
export type RemoteDeviceSnapshot = z.infer<typeof snapshot>;
export type RemoteReply = z.infer<typeof remoteReply>;

export const REMOTE_REQUEST_BYTES = 256 * 1024;
export const REMOTE_REPLY_BYTES = 2 * 1024 * 1024;
