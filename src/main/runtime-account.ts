import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { NativeAccountProvider, NativeRuntimeAccount } from '../shared/types';
import { initializeCodex } from './providers/codex';
import { JsonRpcProcess, type RpcNotification } from './providers/json-rpc';

const execute = promisify(execFile);
const unknown: NativeRuntimeAccount = { status: 'unknown' };
const accountSchema = z.object({ account: z.object({ type: z.string().max(100), email: z.string().max(320).nullable().optional() }).nullable(), requiresOpenaiAuth: z.boolean() });
const claudeStatus = z.object({ loggedIn: z.boolean(), email: z.string().max(320).nullable().optional() });
const challengeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chatgpt'), loginId: z.string().uuid(), authUrl: z.string().max(8192) }),
  z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string().uuid(), verificationUrl: z.string().max(8192), userCode: z.string().regex(/^[A-Za-z0-9-]{3,32}$/) }),
]);
const completionSchema = z.object({ loginId: z.string().uuid(), success: z.boolean() });

function loginUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) {
    throw new Error('The runtime returned an unexpected sign-in address');
  }
  return url.toString();
}

async function codexRead(rpc: JsonRpcProcess): Promise<NativeRuntimeAccount> {
  const { account, requiresOpenaiAuth } = accountSchema.parse(await rpc.request('account/read', { refreshToken: false }, { timeoutMs: 5000 }));
  if (account) return { status: 'signed-in', label: account.email ?? account.type };
  return { status: requiresOpenaiAuth ? 'signed-out' : 'not-required' };
}

function codexConnection(command: string, onNotification?: (event: RpcNotification) => void) {
  return new JsonRpcProcess({ command, args: ['app-server', '--listen', 'stdio://'], onNotification });
}

async function codexLogin(command: string, method: 'browser' | 'device', signal: AbortSignal,
  ready: (challenge: NativeRuntimeAccount['challenge']) => void): Promise<NativeRuntimeAccount> {
  let complete!: (value: boolean) => void;
  const completion = new Promise<boolean>(resolve => { complete = resolve; });
  let loginId: string | undefined;
  let received: z.infer<typeof completionSchema> | undefined;
  const rpc = codexConnection(command, event => {
    if (event.method !== 'account/login/completed') return;
    const result = completionSchema.safeParse(event.params);
    if (!result.success) return;
    received = result.data;
    if (received.loginId === loginId) complete(received.success);
  });
  const abort = () => complete(false);
  signal.addEventListener('abort', abort, { once: true });
  try {
    await initializeCodex(rpc, signal);
    const challenge = challengeSchema.parse(await rpc.request('account/login/start', { type: method === 'browser' ? 'chatgpt' : 'chatgptDeviceCode' }, { signal, timeoutMs: 25_000 }));
    loginId = challenge.loginId;
    if (received?.loginId === loginId) complete(received.success);
    if (signal.aborted) complete(false);
    else ready(challenge.type === 'chatgpt' ? { url: loginUrl(challenge.authUrl) }
      : { url: loginUrl(challenge.verificationUrl), code: challenge.userCode });
    if (!await Promise.race([completion, rpc.closed.then(() => false)])) throw new Error('Sign-in did not complete');
    return await codexRead(rpc);
  } finally {
    signal.removeEventListener('abort', abort);
    if (loginId && signal.aborted) await rpc.request('account/login/cancel', { loginId }, { timeoutMs: 1200 }).catch(() => {});
    await rpc.close();
  }
}

async function claudeRead(command: string): Promise<NativeRuntimeAccount> {
  const stdout = await execute(command, ['auth', 'status'], { timeout: 5000, maxBuffer: 16_384 })
    .then(result => result.stdout, error => typeof error.stdout === 'string' ? error.stdout : '');
  const result = claudeStatus.parse(JSON.parse(stdout));
  return result.loggedIn ? { status: 'signed-in', ...(result.email ? { label: result.email } : {}) } : { status: 'signed-out' };
}

async function readAccount(id: NativeAccountProvider, command: string): Promise<NativeRuntimeAccount> {
  if (id === 'claude') return claudeRead(command);
  const rpc = codexConnection(command);
  try { await initializeCodex(rpc); return await codexRead(rpc); }
  finally { await rpc.close(); }
}

interface AccountAction { controller: AbortController; done: Promise<void>; cancellable: boolean }

export class RuntimeAccounts {
  private readonly states = new Map<NativeAccountProvider, NativeRuntimeAccount>();
  private readonly active = new Map<NativeAccountProvider, AccountAction>();

  constructor(private readonly resolveBinary: (id: NativeAccountProvider) => Promise<string | null | undefined>) {}

  async state(id: NativeAccountProvider, refresh: boolean): Promise<NativeRuntimeAccount> {
    if (refresh && !this.active.has(id)) {
      const command = await this.resolveBinary(id);
      const value = command ? await readAccount(id, command).catch(() => unknown) : unknown;
      if (!this.active.has(id)) this.states.set(id, value);
    }
    return this.states.get(id) ?? unknown;
  }

  async signIn(id: NativeAccountProvider, method: 'browser' | 'device'): Promise<void> {
    if (method === 'device' && id !== 'codex') throw new Error('This runtime does not support device-code sign-in');
    return this.run(id, true, async (command, signal, previous) => {
      const waiting = (challenge?: NativeRuntimeAccount['challenge']) => this.states.set(id, { ...previous, phase: 'waiting', challenge });
      if (id === 'codex') return codexLogin(command, method, signal, waiting);
      waiting();
      await execute(command, ['auth', 'login'], { timeout: 10 * 60_000, maxBuffer: 16_384, signal });
      return claudeRead(command);
    });
  }

  async signOut(id: NativeAccountProvider): Promise<void> {
    return this.run(id, false, async command => {
      if (id === 'claude') {
        await execute(command, ['auth', 'logout'], { timeout: 5000, maxBuffer: 16_384 });
        return claudeRead(command);
      }
      const rpc = codexConnection(command);
      try {
        await initializeCodex(rpc);
        await rpc.request('account/logout', undefined, { timeoutMs: 5000 });
        return await codexRead(rpc);
      } finally { await rpc.close(); }
    });
  }

  private async run(id: NativeAccountProvider, cancellable: boolean,
    action: (command: string, signal: AbortSignal, previous: NativeRuntimeAccount) => Promise<NativeRuntimeAccount>) {
    if (this.active.has(id)) throw new Error('An account operation is already running');
    const { status, label } = this.states.get(id) ?? unknown;
    const previous = { status, label };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
    this.states.set(id, { ...previous, phase: cancellable ? 'starting' : 'signing-out' });
    const done = (async () => {
      try {
        const command = await this.resolveBinary(id);
        if (!command) throw new Error('The runtime executable is unavailable');
        const account = await action(command, signal, previous);
        this.states.set(id, account);
      } catch {
        this.states.set(id, { ...previous, phase: controller.signal.aborted ? 'cancelled' : 'failed' });
      }
    })();
    this.active.set(id, { controller, done, cancellable });
    try { await done; }
    finally { this.active.delete(id); }
  }

  cancel(id: NativeAccountProvider) {
    const action = this.active.get(id);
    if (action?.cancellable) action.controller.abort();
  }

  async shutdown() {
    const actions = [...this.active.entries()];
    for (const [id] of actions) this.cancel(id);
    await Promise.all(actions.map(([, action]) => action.done));
  }
}
