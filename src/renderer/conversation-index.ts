import type { Message } from '../shared/types';

interface TraceCounts {
  length: number;
  failures: number;
  lastFailure?: { id: string; title: string };
  lastDiff?: { id: string; path?: string };
}
export interface TraceEntry extends TraceCounts {
  kind: 'trace'; key: string; start: number;
}
export type ConversationEntry = { kind: 'message'; key: string; start: number } | TraceEntry;
type RuntimeBoundary = NonNullable<Message['runtimeSwitch']> & { index: number };
export interface ConversationPage {
  messageCount: number;
  spans: ConversationEntry[];
  messageSpans: number[];
  runtimeBoundaries: RuntimeBoundary[];
}

function firstDiffPath(patch?: string): string | undefined {
  const header = patch?.match(/^diff --git a\/(.+) b\/\1\r?$|^rename to (.+)\r?$/m);
  return (header?.[1] ?? header?.[2])?.trim() || undefined;
}

export function conversationPage(messages: Message[], nextTraceKey?: string): ConversationPage {
  const spans: ConversationEntry[] = [];
  const messageSpans: number[] = [];
  const runtimeBoundaries: RuntimeBoundary[] = [];
  for (const [index, message] of messages.entries()) {
    const previous = spans.at(-1);
    if (message.event && !message.runtimeSwitch) {
      const trace: TraceEntry = previous?.kind === 'trace' ? previous : {
        kind: 'trace', key: `trace:${message.id}`, start: index, length: 0, failures: 0,
      };
      if (trace !== previous) spans.push(trace);
      trace.length++;
      if (message.event.kind === 'diff') trace.lastDiff = { id: message.id, path: firstDiffPath(message.event.output) };
      if (message.event.status === 'failed') {
        trace.failures++;
        trace.lastFailure = { id: message.id, title: message.event.title.trim() };
      }
    } else {
      if (message.runtimeSwitch) runtimeBoundaries.push({ ...message.runtimeSwitch, index });
      spans.push({ kind: 'message', key: message.id, start: index });
    }
    messageSpans.push(spans.length - 1);
  }
  const tail = spans.at(-1);
  if (nextTraceKey && tail?.kind === 'trace') tail.key = nextTraceKey;
  return { messageCount: messages.length, spans, messageSpans, runtimeBoundaries };
}

interface IndexedPage {
  page: ConversationPage;
  messageStart: number;
  rowStart: number;
  continuedRow?: number;
}

function lastBefore<T>(items: T[], position: number, offset: (item: T) => number): T | undefined {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offset(items[middle]) <= position) low = middle + 1; else high = middle;
  }
  return items[low - 1];
}

export function indexConversation(pages: ConversationPage[]) {
  const messagePages: IndexedPage[] = [];
  const rowPages: IndexedPage[] = [];
  const mergedTraces = new Map<number, TraceCounts>();
  const runtimeBoundaries: RuntimeBoundary[] = [];
  let messageCount = 0, length = 0;
  let tail: { row: number; trace: TraceEntry } | undefined;
  for (const page of pages) {
    if (!page.messageCount) continue;
    const head = page.spans[0];
    const last = page.spans.at(-1)!;
    const continuation = head.kind === 'trace' ? tail : undefined;
    const skipped = Number(Boolean(continuation));
    const indexed = { page, messageStart: messageCount, rowStart: length, continuedRow: continuation?.row };
    for (const boundary of page.runtimeBoundaries) {
      runtimeBoundaries.push({ ...boundary, index: messageCount + boundary.index });
    }
    if (continuation && head.kind === 'trace') {
      const earlier = mergedTraces.get(continuation.row) ?? continuation.trace;
      mergedTraces.set(continuation.row, {
        length: earlier.length + head.length, failures: earlier.failures + head.failures,
        lastFailure: head.lastFailure ?? earlier.lastFailure,
        lastDiff: head.lastDiff ?? earlier.lastDiff,
      });
    }
    if (page.spans.length > skipped) {
      rowPages.push(indexed);
      tail = last.kind === 'trace' ? { row: length + page.spans.length - skipped - 1, trace: last } : undefined;
    }
    messagePages.push(indexed);
    messageCount += page.messageCount;
    length += page.spans.length - skipped;
  }

  return {
    length,
    runtimeAt(messageIndex: number): string | undefined {
      return lastBefore(runtimeBoundaries, messageIndex, boundary => boundary.index)?.toProviderId
        ?? runtimeBoundaries[0]?.fromProviderId;
    },
    at(index: number): ConversationEntry | undefined {
      if (index < 0 || index >= length) return;
      const indexed = lastBefore(rowPages, index, entry => entry.rowStart)!;
      const span = indexed.page.spans[index - indexed.rowStart + Number(indexed.continuedRow !== undefined)];
      return { ...span, ...mergedTraces.get(index), start: indexed.messageStart + span.start };
    },
    rowOfMessage(messageIndex: number) {
      if (messageIndex < 0 || messageIndex >= messageCount) return -1;
      const indexed = lastBefore(messagePages, messageIndex, entry => entry.messageStart)!;
      const spanIndex = indexed.page.messageSpans[messageIndex - indexed.messageStart];
      if (spanIndex === 0 && indexed.continuedRow !== undefined) return indexed.continuedRow;
      return indexed.rowStart + spanIndex - Number(indexed.continuedRow !== undefined);
    },
  };
}

type ConversationIndex = ReturnType<typeof indexConversation>;
type ConversationRow = ConversationEntry | {
  kind: 'event'; key: string; start: number; trace: TraceEntry;
};

export function expandConversation(conversation: ConversationIndex, expanded: ReadonlySet<number>, eventKey: (index: number) => string) {
  // Folded rows are page-indexed. Only expanded traces add offsets to the virtual list.
  let added = 0;
  const insertions = [...expanded].sort((a, b) => a - b).flatMap(index => {
    const trace = conversation.at(index);
    if (trace?.kind !== 'trace') return [];
    const start = index + added;
    added += trace.length;
    return [{ index, start, end: index + added, trace }];
  });
  const byBaseRow = new Map(insertions.map(item => [item.index, item]));

  return {
    length: conversation.length + added,
    expansionKey: insertions.map(item => item.trace.key).join(','),
    at(index: number): ConversationRow | undefined {
      const insertion = lastBefore(insertions, index, item => item.start);
      if (insertion && index > insertion.start && index <= insertion.end) {
        const start = insertion.trace.start + index - insertion.start - 1;
        return { kind: 'event', key: eventKey(start), start, trace: insertion.trace };
      }
      const offset = insertion ? (index === insertion.start ? insertion.start : insertion.end) - insertion.index : 0;
      return conversation.at(index - offset);
    },
    rowOfMessage(messageIndex: number, traceHeader = false) {
      const baseRow = conversation.rowOfMessage(messageIndex);
      if (baseRow < 0) return -1;
      const opened = byBaseRow.get(baseRow);
      if (opened) return traceHeader ? opened.start : opened.start + 1 + messageIndex - opened.trace.start;
      const earlier = lastBefore(insertions, baseRow, item => item.index);
      return baseRow + (earlier ? earlier.end - earlier.index : 0);
    },
  };
}
