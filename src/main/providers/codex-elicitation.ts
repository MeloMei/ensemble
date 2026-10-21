import type { TurnContext } from './types';
import { answerFormElicitation } from './form-elicitation';
import { abortError } from './json-rpc';

export async function answerCodexElicitation(params: Record<string, unknown>, context: TurnContext): Promise<{ action: 'accept' | 'decline' | 'cancel'; content: unknown }> {
  const title = `MCP ${String(params.serverName ?? '')} 请求确认`;
  const detail = typeof params.message === 'string' ? params.message : '';
  if (params.mode === 'url') {
    const selected = await context.approve({ title, detail: `${detail}\n${String(params.url ?? '')}`, choices: [{ id: 'accept', label: '我已完成外部验证' }, { id: 'decline', label: '拒绝本次' }, { id: 'cancel', label: '取消请求' }] });
    if (context.signal.aborted) throw abortError();
    if (!['accept', 'decline', 'cancel'].includes(selected)) throw new Error('MCP 请求返回了无效选项。');
    return { action: selected as 'accept' | 'decline' | 'cancel', content: null };
  }
  if (!['form', 'openai/form', 'openaiForm'].includes(String(params.mode))) {
    context.emit({ type: 'activity', text: '此 MCP 请求需要尚未支持的设备验证，已拒绝本次请求。' });
    return { action: 'decline', content: null };
  }
  const response = await answerFormElicitation(params.requestedSchema, title, detail, context);
  return { ...response, content: response.action === 'accept' ? response.content : null };
}
