import { useCallback, useRef, useState } from 'react';

type Operation = () => Promise<unknown>;
export type Perform = (key: string, action: Operation, options?: { retry?: Operation }) => Promise<void>;

export interface OperationNotice {
  id: number;
  message: string;
  retry?: { key: string; action: Operation; origin?: WeakRef<HTMLElement> };
}

export function operationError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useOperationFeedback() {
  const [notices, setNotices] = useState<OperationNotice[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const nextId = useRef(0);
  const running = useRef(new Map<string, number>());

  const report = useCallback((error: unknown, retry?: OperationNotice['retry']) => {
    const notice = { id: ++nextId.current, message: operationError(error), retry };
    setNotices(current => [...current, notice]);
  }, []);

  const track = useCallback(async (key: string, action: Operation) => {
    const count = running.current.get(key) ?? 0;
    running.current.set(key, count + 1);
    if (count === 0) setPending(current => new Set(current).add(key));
    try { await action(); }
    finally {
      const remaining = (running.current.get(key) ?? 1) - 1;
      if (remaining > 0) running.current.set(key, remaining);
      else {
        running.current.delete(key);
        setPending(current => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }, []);

  const perform = useCallback<Perform>(async (key, action, options) => {
    const active = document.activeElement;
    const retry = options?.retry ? {
      key, action: options.retry,
      origin: active instanceof HTMLElement && active !== document.body ? new WeakRef(active) : undefined,
    } : undefined;
    try { await track(key, action); }
    catch (error) { report(error, retry); }
  }, [report, track]);

  const retry = async (notice: OperationNotice) => {
    const operation = notice.retry;
    if (!operation || running.current.has(operation.key)) return false;
    try { await track(operation.key, operation.action); return true; }
    catch (error) {
      setNotices(current => current.map(item => item.id === notice.id ? { ...item, message: operationError(error) } : item));
      return false;
    }
  };
  const dismiss = (id: number) => setNotices(current => current.filter(item => item.id !== id));
  return { notices, pending, perform, report, retry, dismiss };
}
