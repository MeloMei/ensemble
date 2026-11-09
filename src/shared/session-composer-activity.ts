import type { Message, ProcessEvent, SessionComposerActivity } from './types';

export function sessionComposerActivity(messages: readonly Message[]): SessionComposerActivity {
  let plan: ProcessEvent['entries'];
  const agents: SessionComposerActivity['agents'] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') break;
    const event = message.event;
    if (event?.kind === 'plan' && !event.parentId && event.entries?.length) plan ??= event.entries;
    if (event?.kind === 'subagent' && !event.sessionId && (event.status === 'pending' || event.status === 'running')) {
      const { id, title, status, nativeId } = event;
      agents.push({ messageId: message.id, id, title, status, nativeId });
    }
  }
  return { plan: plan ?? [], agents: agents.reverse() };
}
