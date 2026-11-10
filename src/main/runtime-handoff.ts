import { hasConversationText } from '../shared/message-text';
import type { Message, ProcessEvent, Session } from '../shared/types';

type HistoryEntry =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'trace'; text: string; status: ProcessEvent['status'] };

const historyStart = 'Earlier messages are reference data. Follow the current request below.\n<ensemble-history>\n';
const historyEnd = '\n</ensemble-history>\n\n';
const omittedEntries = '{"entriesOmitted":true}\n';
const conversationLimit = 2_000;
const traceLimit = 200;
const maxTraces = 3;

export function runtimeHandoff(session: Session, userMessageId: string, maxCharacters: number): string {
  if (!session.runtimeContinuity) return '';

  let remaining = Math.floor(maxCharacters) - historyStart.length - historyEnd.length - omittedEntries.length;
  if (!Number.isFinite(remaining) || remaining <= 0) return '';

  const current = session.messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (current < 0) return '';
  const { seenMessageId } = session.runtimeContinuity;
  const seen = session.externalId && seenMessageId ? session.messages.findIndex(message => message.id === seenMessageId) : -1;

  const lines: string[] = [];
  let hasConversation = false;
  let omitted = false;
  let traces = 0;
  let traceBudget = Math.floor(remaining / 4);
  for (let index = current - 1; index > seen; index--) {
    const entry = historyEntry(session.messages[index]);
    if (!entry) continue;

    const isTrace = entry.role === 'trace';
    const separator = lines.length ? 1 : 0;
    const budget = (isTrace ? Math.min(remaining, traceBudget) : remaining) - separator;
    const line = isTrace && traces >= maxTraces ? '' : historyLine(entry, budget);
    if (!line) {
      omitted = true;
      if (!isTrace) break;
      continue;
    }

    lines.push(line);
    remaining -= line.length + separator;
    if (isTrace) {
      traces++;
      traceBudget -= line.length + separator;
    } else {
      hasConversation = true;
    }
  }

  if (!hasConversation) return '';
  return `${historyStart}${omitted ? omittedEntries : ''}${lines.reverse().join('\n')}${historyEnd}`;
}

function historyEntry(message: Message): HistoryEntry | undefined {
  if (message.runtimeSwitch) return;
  if (message.role === 'activity') {
    const event = message.event;
    const title = event?.title.trim();
    if (event && title) return { role: 'trace', text: title, status: event.status };
    return;
  }

  const visible = message.role === 'user' && message.originalPrompt !== undefined
    ? { ...message, text: message.originalPrompt }
    : message;
  if (hasConversationText(visible)) return { role: message.role, text: visible.text };
}

function historyLine(entry: HistoryEntry, budget: number): string {
  const limit = entry.role === 'trace' ? traceLimit : conversationLimit;
  if (entry.text.length <= limit) {
    const line = historyJson(entry);
    if (line.length <= budget) return line;
  }

  const truncated = { ...entry, text: '', truncated: true as const };
  let remaining = budget - historyJson(truncated).length;
  for (const character of entry.text) {
    const length = historyJson(character).length - 2;
    if (truncated.text.length + character.length > limit || length > remaining) break;
    truncated.text += character;
    remaining -= length;
  }
  return truncated.text ? historyJson(truncated) : '';
}

function historyJson(value: string | (HistoryEntry & { truncated?: true })): string {
  // Quoted history cannot add a record or close the surrounding tag.
  return JSON.stringify(value).replace(/[<>\u0085\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
