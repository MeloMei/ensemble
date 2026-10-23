import { createHash, randomUUID } from 'node:crypto';
import type { SessionCommandReceipt } from '../shared/types';
import type { StateStore } from './store';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

function key(commandId: string): string {
  if (!commandId || commandId.length > 200) throw new Error('commandId 必须是 1 到 200 字符。');
  return `command:${commandId}`;
}

export function sessionCommandReceipt(store: StateStore, commandId: string): SessionCommandReceipt | undefined {
  return structuredClone(store.receipt(key(commandId))?.result) as SessionCommandReceipt | undefined;
}

export function previousSessionCommand<T>(store: StateStore, kind: string, commandId: string | undefined, input: unknown): { result: T; replayed: true } | undefined {
  if (!commandId) return undefined;
  const receipt = store.receipt(key(commandId));
  if (!receipt) return undefined;
  if (receipt.hash !== commandHash(kind, input)) throw new Error('commandId 已用于不同输入。');
  return { result: structuredClone((receipt.result as SessionCommandReceipt).result) as T, replayed: true };
}

export function commandHash(kind: string, input: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical({ kind, input }))).digest('hex');
}

export function runSessionCommand<T>(store: StateStore, kind: string, requestedId: string | undefined, input: unknown, operation: (commandId: string) => T): { result: T; replayed: boolean } {
  const commandId = requestedId ?? randomUUID();
  const receiptKey = key(commandId);
  const hash = commandHash(kind, input);
  return store.atomic((_state, transaction) => {
    const previous = transaction.receipt(receiptKey);
    if (previous) {
      if (previous.hash !== hash) throw new Error('commandId 已用于不同输入。');
      return { result: structuredClone((previous.result as SessionCommandReceipt).result) as T, replayed: true };
    }
    const result = operation(commandId);
    const receipt: SessionCommandReceipt = { commandId, kind, result: result ?? null, createdAt: new Date().toISOString() };
    transaction.putReceipt({ key: receiptKey, hash, result: structuredClone(receipt), createdAt: receipt.createdAt });
    return { result, replayed: false };
  });
}
