import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { ApprovalInput } from '../../shared/types';
import type { DisplayText } from '../../shared/display-text';
import type { TurnContext } from './types';
import { abortError } from './json-rpc';

type ObjectValue = Record<string, unknown>;
type Content = Record<string, string | number | boolean | string[]>;
type Response = { action: 'accept'; content: Content } | { action: 'decline' | 'cancel' };
type Option = { value: string; label: string; labelI18n?: DisplayText; description?: string };
const OMIT = '（不提供）';
const CONFIRM = [{ id: 'accept', label: '允许本次', labelI18n: { key: 'runtime:approval.allowOnce' } }, { id: 'decline', label: '拒绝本次', labelI18n: { key: 'runtime:approval.denyOnce' } }, { id: 'cancel', label: '取消请求', labelI18n: { key: 'runtime:approval.cancelRequest' } }];
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }

function options(schema: ObjectValue): Option[] | undefined {
  if (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === 'string')) {
    return schema.enum.map((value, index) => ({ value, label: Array.isArray(schema.enumNames) && typeof schema.enumNames[index] === 'string' ? schema.enumNames[index] as string : value }));
  }
  const choices = schema.oneOf ?? schema.anyOf;
  if (choices === undefined) return undefined;
  if (!Array.isArray(choices)) throw new Error('表单选项格式无效。');
  return choices.map(value => {
    const option = object(value);
    if (typeof option.const !== 'string') throw new Error('表单选项需要字符串值。');
    return { value: option.const, label: typeof option.title === 'string' ? option.title : option.const, ...(typeof option.description === 'string' ? { description: option.description } : {}) };
  });
}

export async function answerFormElicitation(schemaValue: unknown, title: string, detail: string, context: TurnContext, signal = context.signal, titleI18n?: DisplayText): Promise<Response> {
  const schema = object(schemaValue);
  const properties = Object.entries(object(schema.properties));
  if ((schema.type !== undefined && schema.type !== 'object') || properties.length > 20) {
    context.emit({ type: 'activity', text: '当前界面不支持此表单，已拒绝本次请求。' });
    return { action: 'decline' };
  }
  let fields: { name: string; field: ObjectValue; options?: Option[]; id: string; optional: boolean; multiple: boolean }[];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  try {
    fields = properties.map(([name, value], index) => {
      const field = object(value);
      if (!['string', 'number', 'integer', 'boolean', 'array'].includes(String(field.type))) throw new Error('不支持的字段类型。');
      const multiple = field.type === 'array';
      let choices = options(multiple ? object(field.items) : field);
      if (field.type === 'boolean') choices = [{ value: 'true', label: '是', labelI18n: { key: 'runtime:question.yes' } }, { value: 'false', label: '否', labelI18n: { key: 'runtime:question.no' } }];
      if (multiple && !choices) throw new Error('多选字段缺少选项。');
      if (choices) {
        const counts = new Map<string, number>();
        for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
        choices = choices.map((choice, optionIndex) => ({ ...choice, label: (counts.get(choice.label) ?? 0) > 1 || choice.label === OMIT ? `${choice.label} (${optionIndex + 1})` : choice.label }));
      }
      return { name, field, options: choices, id: `mcp-${index}`, optional: !required.has(name), multiple };
    });
  } catch {
    context.emit({ type: 'activity', text: '当前界面不支持此表单字段，已拒绝本次请求。' });
    return { action: 'decline' };
  }
  const validator = new AjvJsonSchemaValidator().getValidator<Content>({ ...schema, type: 'object' });
  if (!fields.length) {
    const selected = await context.approve({ title, titleI18n, detail, choices: CONFIRM }, signal);
    if (signal.aborted || context.signal.aborted) throw abortError();
    if (selected === 'decline' || selected === 'cancel') return { action: selected };
    if (selected !== 'accept' || !validator({}).valid) throw new Error('表单确认结果无效。');
    return { action: 'accept', content: {} };
  }
  const questions: NonNullable<ApprovalInput['questions']> = fields.map(({ name, field, options, id, optional, multiple }) => ({
    id, header: typeof field.title === 'string' ? field.title : name,
    question: [typeof field.title === 'string' ? field.title : name, typeof field.description === 'string' ? field.description : ''].filter(Boolean).join('：'),
    multiSelect: multiple,
    options: [...(options ?? []).map(({ label, labelI18n, description }) => ({ label, ...(labelI18n ? { labelI18n } : {}), ...(description ? { description } : {}) })), ...(optional ? [{ label: OMIT, labelI18n: { key: 'runtime:question.omit' } }] : [])],
  }));
  const raw = await context.approve({ title, titleI18n, detail, choices: [], questions }, signal);
  if (signal.aborted || context.signal.aborted) throw abortError();
  if (raw === 'cancel' || raw === 'decline') return { action: raw };
  const answers = object(JSON.parse(raw));
  const content: Content = {};
  for (const { name, field, options, id, optional, multiple } of fields) {
    const answer = answers[id];
    if (!Array.isArray(answer) || answer.some(value => typeof value !== 'string') || (!multiple && answer.length !== 1)) throw new Error('表单答案格式无效。');
    if (optional && answer.length === 1 && answer[0] === OMIT) continue;
    if (answer.includes(OMIT) && optional) throw new Error('不能同时省略字段和提供答案。');
    const values = options ? answer.map(label => {
      const selected = options.find(option => option.label === label);
      if (!selected) throw new Error('表单答案不在允许选项内。');
      return selected.value;
    }) : answer as string[];
    if (multiple) content[name] = values;
    else if (field.type === 'boolean') content[name] = values[0] === 'true';
    else if (field.type === 'integer' || field.type === 'number') {
      if (!values[0].trim()) throw new Error('数值答案不能为空。');
      content[name] = Number(values[0]);
    } else content[name] = values[0];
  }
  if (!validator(content).valid) throw new Error('表单答案不符合运行时字段约束。');
  return { action: 'accept', content };
}
