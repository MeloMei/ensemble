import assert from 'node:assert/strict';
import test from 'node:test';
import { openCodeReadinessPlugin } from './opencode-readiness';

function host() {
  let observe!: (editor: { list(): { id: string }[] }) => void;
  let prompt!: () => Promise<void>;
  let expire!: () => void;
  let cleared = 0;
  const definition = new Function('setTimeout', 'clearTimeout', openCodeReadinessPlugin(['workbench_ask_parent', 'workbench_wait_workers']).replace('export default', 'return'))(
    (callback: () => void) => { expire = callback; return 1; }, () => { cleared++; },
  ) as { setup(context: unknown): Promise<() => void> };
  const initialized = definition.setup({
    tool: { async transform(callback: typeof observe) { observe = callback; } },
    session: { async hook(method: string, callback: typeof prompt) { assert.equal(method, 'prompt'); prompt = callback; } },
  });
  return { initialized, async send() { await initialized; return prompt(); },
    async registered(ids: string[]) { await initialized; observe({ list: () => ids.map(id => ({ id })) }); },
    timeout() { expire(); }, cleared: () => cleared };
}

test('OpenCode native readiness waits for every exact platform id without changing the tool registry', async () => {
  const f = host(); let sent = false;
  const sending = f.send().then(() => { sent = true; });
  await f.registered(['ask_parent', 'workbench_wait_workers']); await Promise.resolve();
  assert.equal(sent, false);
  await f.registered(['workbench_ask_parent', 'workbench_wait_workers']); await sending;
  assert.equal(sent, true); assert.equal(f.cleared(), 1);
  (await f.initialized)();
});

test('OpenCode native readiness rejects bounded startup and disposal before admitting the prompt', async () => {
  const timeout = host(); const sending = timeout.send(); await timeout.initialized; await Promise.resolve();
  timeout.timeout(); await assert.rejects(sending, /30秒.*任务未发送/); assert.equal(timeout.cleared(), 1);
  const disposed = host(); const pending = disposed.send(); (await disposed.initialized)();
  await assert.rejects(pending, /连接已关闭.*任务未发送/); assert.equal(disposed.cleared(), 1);
});
