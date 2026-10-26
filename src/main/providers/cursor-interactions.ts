import { z } from 'zod';
import type { ApprovalInput } from '../../shared/types';
import type { AcpRuntimeDescriptor } from './acp-types';
import { abortError } from './json-rpc';
import { emitProcess } from './provider-events';
import type { TurnContext } from './types';

const id = z.string().min(1).max(256);
const text = z.string().max(200_000);
const requestBase = { toolCallId: id, sessionId: id.optional() };
const questionSchema = z.object({
  ...requestBase, title: z.string().max(300).optional(),
  questions: z.array(z.object({ id, prompt: z.string().min(1).max(10_000),
    options: z.array(z.object({ id, label: z.string().min(1).max(500) }).passthrough()).min(1).max(50),
    allowMultiple: z.boolean().optional() }).passthrough()).min(1).max(20),
}).passthrough();
const todoSchema = z.object({ id, content: z.string().max(10_000), status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']) }).passthrough();
const planSchema = z.object({
  ...requestBase, name: z.string().max(300).optional(), overview: text.optional(), plan: z.string().min(1).max(200_000),
  todos: z.array(todoSchema).max(200).optional(), isProject: z.boolean().optional(),
}).passthrough();
const todosSchema = z.object({ ...requestBase, todos: z.array(todoSchema).max(200), merge: z.boolean().optional() }).passthrough();
const taskSchema = z.object({ ...requestBase, description: text.optional(), prompt: text.optional(), model: id.optional(), agentId: id.optional(),
  durationMs: z.number().finite().nonnegative().optional(), subagentType: z.union([z.string(), z.object({ custom: z.string() })]).optional() }).passthrough();
const imageSchema = z.object({ ...requestBase, description: text.optional(), filePath: z.string().max(4096).optional(),
  referenceImagePaths: z.array(z.string().max(4096)).max(20).optional() }).passthrough();

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Cursor ${label}包含重复 ID。`);
}

function questionOptions(options: { id: string; label: string }[]) {
  unique(options.map(option => option.id), '问题选项');
  const reserved = new Set(options.map(option => option.label));
  const used = new Set<string>();
  return options.map(option => {
    let label = option.label;
    if (used.has(label)) {
      let suffix = 1;
      do { label = `${option.label} (${suffix++})`; } while (used.has(label) || reserved.has(label));
    }
    used.add(label);
    return { ...option, label };
  });
}

export async function answerCursorQuestions(value: unknown, context: TurnContext, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted || context.signal.aborted) return { outcome: { outcome: 'cancelled' } };
  const input = questionSchema.parse(value);
  unique(input.questions.map(question => question.id), '问题');
  const questions = input.questions.map(question => ({ ...question, options: questionOptions(question.options) }));
  const approval: ApprovalInput = { title: input.title || 'Cursor 需要你的回答', detail: '', choices: [], questions: questions.map(question => ({
    id: question.id, header: 'Cursor', question: question.prompt, multiSelect: question.allowMultiple ?? false,
    options: question.options.map(option => ({ label: option.label })), allowCustomAnswer: false,
  })) };
  const raw = await context.approve(approval, signal);
  if (signal.aborted || context.signal.aborted) return { outcome: { outcome: 'cancelled' } };
  if (raw === 'cancel' || raw === 'decline') return { outcome: { outcome: 'cancelled' } };
  const answers = z.record(z.array(z.string().min(1).max(500)).min(1).max(50)).parse(JSON.parse(raw));
  if (Object.keys(answers).some(key => !questions.some(question => question.id === key))) throw new Error('Cursor 问题回答包含未知问题。');
  const nativeAnswers = questions.map(question => {
    const labels = answers[question.id];
    if (!labels || (!question.allowMultiple && labels.length !== 1)) throw new Error('Cursor 问题回答数量无效。');
    unique(labels, '问题回答');
    return { questionId: question.id, selectedOptionIds: labels.map(label => {
      const option = question.options.find(option => option.label === label);
      if (!option) throw new Error('Cursor 问题回答不属于提供的选项。');
      return option.id;
    }) };
  });
  return { outcome: { outcome: 'answered', answers: nativeAnswers } };
}

export async function approveCursorPlan(value: unknown, context: TurnContext, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted || context.signal.aborted) return { outcome: { outcome: 'cancelled' } };
  try {
    const plan = planSchema.parse(value);
    const readonly = context.session.settings?.permission === 'read-only';
    const choice = await context.approve({ title: plan.name || 'Cursor 请求确认计划',
      detail: [plan.overview, plan.plan, readonly ? '只读回合仅展示计划，不创建 Cursor 计划文件。'
        : '批准后 Cursor 会将原生计划保存到 ~/.cursor/plans/。后续文件修改仍需单独批准。'].filter(Boolean).join('\n\n'),
      choices: readonly ? [{ id: 'read', label: '已阅读' }, { id: 'close', label: '关闭' }]
        : [{ id: 'accept', label: '批准并保存计划' }, { id: 'reject', label: '拒绝计划' }] }, signal);
    if (signal.aborted || context.signal.aborted || choice === 'cancel') return { outcome: { outcome: 'cancelled' } };
    if (readonly) return { outcome: { outcome: 'rejected', reason: '只读回合仅展示计划，不创建 Cursor 计划文件。' } };
    if (choice === 'accept') return { outcome: { outcome: 'accepted' } };
    if (choice === 'reject') return { outcome: { outcome: 'rejected', reason: '用户拒绝该计划。' } };
    throw new Error('Cursor 计划审批结果无效。');
  } catch {
    return signal.aborted || context.signal.aborted ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'rejected', reason: 'Cursor 计划请求或审批结果无效。' } };
  }
}

export function cursorNotifications(): NonNullable<AcpRuntimeDescriptor['clientNotifications']> {
  const plansByTurn = new WeakMap<TurnContext, Map<string, z.infer<typeof todoSchema>>>();
  return {
    'cursor/update_todos'(value, context) {
      const update = todosSchema.parse(value);
      let plans = plansByTurn.get(context);
      if (!plans) { plans = new Map(); plansByTurn.set(context, plans); }
      if (!update.merge) plans.clear();
      for (const todo of update.todos) plans.set(todo.id, todo);
      const entries = [...plans.values()];
      const terminal = entries.length > 0 && entries.every(entry => entry.status === 'completed' || entry.status === 'cancelled');
      emitProcess(context, { kind: 'plan', nativeId: 'cursor-todos', title: 'Cursor 任务计划',
        status: terminal ? entries.some(entry => entry.status === 'cancelled') ? 'cancelled' : 'completed' : 'running',
        entries: entries.map(entry => ({ text: entry.content, status: entry.status === 'in_progress' ? 'running' : entry.status })) });
    },
    'cursor/task'(value, context) {
      const task = taskSchema.parse(value);
      context.emit({ type: 'activity', text: ['Cursor 子任务报告', task.description, task.agentId && `Agent: ${task.agentId}`,
        task.model && `模型：${task.model}`, task.durationMs !== undefined && `耗时：${task.durationMs} ms`].filter(Boolean).join('\n') });
    },
    'cursor/generate_image'(value, context) {
      const generated = imageSchema.parse(value);
      context.emit({ type: 'activity', text: [generated.description || 'Cursor 图片结果', generated.filePath].filter(Boolean).join('\n') });
    },
  };
}

export function cursorInteractions(): Pick<AcpRuntimeDescriptor, 'clientRequests' | 'clientNotifications' | 'clientRequestCancellation'> {
  const notifications = cursorNotifications();
  return { clientNotifications: notifications,
    clientRequestCancellation: { 'cursor/ask_question': { outcome: { outcome: 'cancelled' } }, 'cursor/create_plan': { outcome: { outcome: 'cancelled' } } },
    clientRequests: {
    'cursor/ask_question': answerCursorQuestions,
    'cursor/create_plan': approveCursorPlan,
    ...Object.fromEntries(Object.entries(notifications).map(([method, handle]) => [method, async (value: unknown, context: TurnContext, signal: AbortSignal) => {
      if (signal.aborted || context.signal.aborted) throw abortError();
      handle(value, context); return {};
    }])),
  } };
}
