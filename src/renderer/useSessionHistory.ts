import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, ProcessEvent, Session } from '../shared/types';
import type { SessionHistoryWindow } from '../shared/backend';

interface MessagePage {
  messages: Message[]; chat: Message[]; activity: Message[];
  chatPositions: Map<string, number>; activityPositions: Map<string, number>; spill?: boolean;
  nativeEvents: Map<string, ProcessEvent[]>;
}
function messagePage(messages: Message[], spill = false): MessagePage {
  const chat = messages.filter(message => message.role !== 'activity' || message.event);
  const activity = messages.filter(message => message.role === 'activity' && !message.event);
  const nativeEvents = new Map<string, ProcessEvent[]>();
  for (const { event } of messages) if (event) {
    for (const id of new Set([event.nativeId, event.parentId])) if (id) nativeEvents.set(id, [...(nativeEvents.get(id) ?? []), event]);
  }
  return {
    messages, chat, activity, spill, nativeEvents,
    chatPositions: new Map(chat.map((message, index) => [message.id, index])),
    activityPositions: new Map(activity.map((message, index) => [message.id, index])),
  };
}

export interface IndexedMessages {
  length: number; structure: string;
  at(index: number): Message | undefined;
  indexOf(id: string): number;
}
function indexPages(pages: MessagePage[], kind: 'chat' | 'activity', structure: string): IndexedMessages {
  const offsets: number[] = [];
  let length = 0;
  for (const page of pages) { offsets.push(length); length += page[kind].length; }
  return {
    length, structure,
    at(index) {
      if (index < 0) index += length;
      if (index < 0 || index >= length) return;
      let low = 0, high = pages.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (offsets[middle] <= index) low = middle; else high = middle - 1;
      }
      return pages[low][kind][index - offsets[low]];
    },
    indexOf(id) {
      for (let index = 0; index < pages.length; index++) {
        const position = (kind === 'chat' ? pages[index].chatPositions : pages[index].activityPositions).get(id);
        if (position !== undefined) return offsets[index] + position;
      }
      return -1;
    },
  };
}

interface HistoryWindow {
  pages: MessagePage[]; beforeCursor?: string; hasMore: boolean; afterCursor?: string; hasAfter: boolean; version: number;
}
interface LiveWindow { older: MessagePage[]; tail: MessagePage; beforeCursor?: string; hasMore: boolean; version: number }
const tailWindow = (session: Session): LiveWindow => ({
  older: [], tail: messagePage(session.messages), beforeCursor: session.historyCursor,
  hasMore: Boolean(session.historyCursor), version: 0,
});

function tailOverlap(previous: LiveWindow, session: Session): number {
  const firstId = session.messages[0]?.id;
  return previous.tail.messages.findIndex(message => message.id === firstId);
}

function replaceTail(previous: LiveWindow, session: Session, reset: boolean): LiveWindow {
  const incoming = messagePage(session.messages);
  if (reset || !previous.tail.messages.length) return { ...tailWindow(session), version: previous.version + 1 };
  const overlap = tailOverlap(previous, session);
  if (overlap < 0) return { ...tailWindow(session), version: previous.version + 1 };
  if (overlap === 0) return { ...previous, tail: incoming };
  const removed = previous.tail.messages.slice(0, overlap);
  const last = previous.older.at(-1);
  const older = last?.spill && last.messages.length + removed.length <= 200
    ? [...previous.older.slice(0, -1), messagePage([...last.messages, ...removed], true)]
    : [...previous.older, messagePage(removed, true)];
  return { ...previous, older, tail: incoming, version: previous.version + 1 };
}

export function useSessionHistory(session: Session) {
  const [live, setLive] = useState(() => tailWindow(session));
  const [history, setHistory] = useState<HistoryWindow>();
  const [paging, setPaging] = useState(false);
  const [jumping, setJumping] = useState(false);
  const [pageError, setPageError] = useState('');
  const [jumpError, setJumpError] = useState('');
  const current = useRef({ live, history });
  current.current = { live, history };
  const pageGeneration = useRef(0);
  const jumpGeneration = useRef(0);
  const pageInFlight = useRef(false);
  const previousCount = useRef(session.messageCount);
  const previousSession = useRef(session.id);
  const invalidatePages = useCallback(() => {
    pageGeneration.current++;
    pageInFlight.current = false;
    setPaging(false);
    setPageError('');
  }, []);
  const cancelJump = useCallback(() => {
    jumpGeneration.current++;
    setJumping(false);
    setJumpError('');
  }, []);

  useEffect(() => {
    const changedSession = previousSession.current !== session.id;
    const shortened = !changedSession && session.messageCount !== undefined && previousCount.current !== undefined && session.messageCount < previousCount.current;
    previousSession.current = session.id;
    previousCount.current = session.messageCount;
    if (changedSession || shortened) {
      invalidatePages();
      cancelJump();
      setHistory(undefined);
    } else if (session.historyLoaded !== false && !current.current.history && tailOverlap(current.current.live, session) < 0) {
      invalidatePages();
    }
    if (session.historyLoaded === false) {
      if (changedSession || shortened) setLive(previous => ({ ...tailWindow(session), version: previous.version + 1 }));
      return;
    }
    setLive(previous => replaceTail(previous, session, changedSession || shortened));
  }, [session.id, session.messages, session.messageCount, session.historyCursor, session.historyLoaded, invalidatePages, cancelJump]);

  useEffect(() => () => { pageGeneration.current++; jumpGeneration.current++; }, []);

  const loadPage = useCallback(async (direction: 'before' | 'after') => {
    if (pageInFlight.current) return;
    const browsing = current.current.history;
    const page = browsing ?? current.current.live;
    const cursor = direction === 'before' ? page.beforeCursor : browsing?.afterCursor;
    if (!cursor || (direction === 'before' ? !page.hasMore : !browsing?.hasAfter)) return;
    const token = pageGeneration.current;
    pageInFlight.current = true;
    setPaging(true);
    setPageError('');
    try {
      const next: Partial<SessionHistoryWindow> & Pick<SessionHistoryWindow, 'messages' | 'hasMore'> = direction === 'before'
        ? await window.workbench.sessionHistory(session.id, cursor, 100)
        : await window.workbench.sessionHistoryAfter(session.id, cursor, 100);
      if (token !== pageGeneration.current) return;
      if (browsing) setHistory(value => value && {
        ...value, version: value.version + 1,
        pages: direction === 'before' ? [messagePage(next.messages), ...value.pages] : [...value.pages, messagePage(next.messages)],
        ...(direction === 'before' ? { beforeCursor: next.beforeCursor, hasMore: next.hasMore } : { afterCursor: next.afterCursor, hasAfter: next.hasAfter ?? false }),
      });
      else setLive(value => value.beforeCursor === cursor ? {
        ...value, older: [messagePage(next.messages), ...value.older], beforeCursor: next.beforeCursor,
        hasMore: next.hasMore, version: value.version + 1,
      } : value);
    } catch (failure) {
      if (token === pageGeneration.current) setPageError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === pageGeneration.current) { pageInFlight.current = false; setPaging(false); }
    }
  }, [session.id]);

  const pages = useMemo(() => history?.pages ?? [...live.older, live.tail], [history, live.older, live.tail]);
  const structure = history ? `history:${history.version}` : `live:${live.version}:${live.tail.messages.map(message => message.id).join(',')}`;
  const messages = useMemo(() => indexPages(pages, 'chat', structure), [pages, structure]);
  const activities = useMemo(() => indexPages(pages, 'activity', structure), [pages, structure]);
  const locateMessage = useCallback(async (id: string) => {
    const token = ++jumpGeneration.current;
    setJumping(false);
    setJumpError('');
    const value = current.current.history;
    const pages = value?.pages ?? [...current.current.live.older, current.current.live.tail];
    if (pages.some(page => page.chatPositions.has(id))) return true;
    setJumping(true);
    try {
      const page = await window.workbench.sessionHistoryAround(session.id, id, 100);
      if (token !== jumpGeneration.current) return false;
      invalidatePages();
      setHistory({ ...page, pages: [messagePage(page.messages)], version: token });
      return page.messages.some(message => message.id === id);
    } catch (failure) {
      if (token === jumpGeneration.current) setJumpError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (token === jumpGeneration.current) setJumping(false);
    }
  }, [session.id, invalidatePages]);

  const showLatest = useCallback(() => {
    cancelJump();
    invalidatePages();
    setHistory(undefined);
  }, [cancelJump, invalidatePages]);
  return {
    messages, activities, beforeCursor: (history ?? live).beforeCursor, hasMore: (history ?? live).hasMore,
    hasAfter: history?.hasAfter ?? false, loading: paging || jumping, error: jumpError || pageError, showingHistory: Boolean(history),
    waitingForTail: session.historyLoaded === false && !live.tail.messages.length,
    eventsFor: (nativeId: string) => pages.flatMap(page => page.nativeEvents.get(nativeId) ?? []),
    loadOlder: () => loadPage('before'), loadNewer: () => loadPage('after'), locateMessage, cancelJump, showLatest,
  };
}
