import type { PromptInput, Session } from '../shared/types';

interface CommandIntent { fingerprint: string; commandId: string }
const intents = new Map<string, CommandIntent>();
const storagePrefix = 'ensemble:command:';
interface CommandExecution {
  key: string; intent: CommandIntent; operation: (commandId: string) => Promise<unknown>; promise: Promise<unknown>;
  resolve: (result: unknown) => void; reject: (error: unknown) => void;
  failed: boolean; error?: unknown; completed: boolean; waiting: boolean; blocked: boolean; recovery?: Promise<void>;
}
const executions = new Map<string, CommandExecution>();
const orphanRecoveries = new Map<string, Promise<void>>();

async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function storedIntent(key: string): CommandIntent | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<CommandIntent> | null;
    return value && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
      && typeof value.commandId === 'string' && value.commandId.length > 0 && value.commandId.length <= 200 ? value as CommandIntent : undefined;
  } catch { return undefined; }
}

function currentIntent(key: string): CommandIntent | undefined { return intents.get(key) ?? storedIntent(key); }

function retire(key: string, commandId: string): void {
  if (intents.get(key)?.commandId === commandId) intents.delete(key);
  try { if (storedIntent(key)?.commandId === commandId) localStorage.removeItem(key); }
  catch { /* In-memory completion must survive unavailable storage. */ }
}

function succeed(execution: CommandExecution, result: unknown): void {
  if (execution.completed) return;
  execution.completed = true; execution.waiting = false; executions.delete(execution.intent.commandId);
  retire(execution.key, execution.intent.commandId); execution.resolve(result);
}

function rejectAttempt(execution: CommandExecution, error: unknown): void {
  if (!execution.waiting) return;
  execution.waiting = false; execution.reject(error);
}

function unconfirmed(execution: CommandExecution): Error {
  return new Error('上次操作是否被接收尚未确认。再次点击将核对并重试同一命令。', { cause: execution.error });
}

function recoverExecution(execution: CommandExecution, manual = false): Promise<void> {
  if (execution.completed || !execution.failed || execution.blocked && !manual) return Promise.resolve();
  if (execution.recovery) return execution.recovery;
  const recovery = (async () => {
    let receipt;
    try { receipt = await window.workbench.commandReceipt(execution.intent.commandId); }
    catch { /* A user retry still uses the original durable command ID. */ }
    if (execution.completed) return;
    if (!receipt && !manual) { rejectAttempt(execution, unconfirmed(execution)); return; }
    try { succeed(execution, await execution.operation(execution.intent.commandId)); }
    catch (error) {
      execution.error = error; execution.blocked = Boolean(receipt);
      rejectAttempt(execution, receipt ? error : unconfirmed(execution));
    }
  })();
  execution.recovery = recovery;
  void recovery.finally(() => { if (execution.recovery === recovery) execution.recovery = undefined; });
  return recovery;
}

function recoverOrphan(key: string, intent: CommandIntent): Promise<void> {
  const pending = orphanRecoveries.get(intent.commandId);
  if (pending) return pending;
  const recovery = (async () => {
    try { if (await window.workbench.commandReceipt(intent.commandId)) retire(key, intent.commandId); }
    catch { /* An unconfirmed intent remains retryable after reconnect. */ }
  })();
  orphanRecoveries.set(intent.commandId, recovery);
  void recovery.finally(() => { if (orphanRecoveries.get(intent.commandId) === recovery) orphanRecoveries.delete(intent.commandId); });
  return recovery;
}

export async function recoverSessionCommands(): Promise<void> {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(storagePrefix) || intents.has(key)) continue;
      const intent = storedIntent(key); if (intent) intents.set(key, intent);
    }
  } catch { /* Active calls can recover without storage access. */ }
  await Promise.all([...executions.values()].map(execution => recoverExecution(execution)).concat(
    [...intents].filter(([, intent]) => !executions.has(intent.commandId)).map(([key, intent]) => recoverOrphan(key, intent))));
}

export async function runSessionCommand<T>(scope: string, input: unknown, operation: (commandId: string) => Promise<T>): Promise<T> {
  const key = `${storagePrefix}${scope}`, signature = await fingerprint(input);
  let current = currentIntent(key);
  if (current?.fingerprint === signature && !executions.has(current.commandId)) {
    await recoverOrphan(key, current);
    current = currentIntent(key);
  }
  const intent = current?.fingerprint === signature ? current : { fingerprint: signature, commandId: crypto.randomUUID() };
  const active = executions.get(intent.commandId);
  if (active) {
    if (!active.waiting) {
      active.operation = operation;
      active.promise = new Promise<unknown>((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
      active.waiting = true; void recoverExecution(active, true);
    }
    return active.promise as Promise<T>;
  }
  let resolve!: (result: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail; });
  const execution: CommandExecution = { key, intent, operation, promise, resolve, reject, failed: false, completed: false, waiting: true, blocked: false };
  intents.set(key, intent); executions.set(intent.commandId, execution);
  try { localStorage.setItem(key, JSON.stringify(intent)); } catch { /* The in-memory intent survives storage limits. */ }
  void Promise.resolve().then(() => operation(intent.commandId)).then(result => succeed(execution, result), error => {
    if (execution.completed) return;
    execution.failed = true; execution.error = error; void recoverExecution(execution);
  });
  return promise as Promise<T>;
}

export function promptCommandInput(input: PromptInput): PromptInput {
  return { text: input.text.trim(), ...(input.attachments?.length ? { attachments: input.attachments } : {}) };
}

export function runSessionStopCommand<T>(session: Pick<Session, 'id' | 'attempts'>, operation: (commandId: string, expectedAttemptId?: string) => Promise<T>): Promise<T> {
  const attemptId = session.attempts?.at(-1)?.id;
  if (!attemptId) return operation(crypto.randomUUID());
  return runSessionCommand(`cancel:${session.id}:${attemptId}`, { sessionId: session.id, attemptId }, commandId => operation(commandId, attemptId));
}
