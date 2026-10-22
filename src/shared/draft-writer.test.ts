import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftWriter } from './draft-writer';
import type { PromptInput } from './types';

test('draft flush waits for the latest edit across sessions and an in-flight save', async () => {
  const written: { id: string; input: PromptInput }[] = [];
  let started!: () => void, release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = new DraftWriter(async (id, input) => {
    if (!written.length) { started(); await gate; }
    written.push({ id, input });
  });
  const first = writer.save('one', { text: 'first' });
  assert.equal(writer.hasPending, true);
  const closing = writer.flush();
  await running;
  const latest = writer.save('one', { text: 'last keystroke' });
  const other = writer.save('two', { text: 'another tab' });
  release();
  await closing;
  await Promise.all([first, latest, other]);
  assert.equal(writer.hasPending, false);
  assert.deepEqual(written.filter(row => row.id === 'one').map(row => row.input.text), ['first', 'last keystroke']);
  assert.deepEqual(written.filter(row => row.id === 'two').map(row => row.input.text), ['another tab']);
});

test('draft flush reports a failed save and retries the retained value', async () => {
  let attempts = 0;
  let stored: PromptInput | undefined;
  const writer = new DraftWriter(async (_id, value) => {
    if (++attempts === 1) throw new Error('offline');
    stored = value;
  });
  const pending = assert.rejects(writer.save('one', { text: 'keep this' }), /offline/);
  await assert.rejects(writer.flush(), /offline/);
  await pending;
  assert.equal(writer.hasPending, true);
  await writer.flush();
  assert.equal(writer.hasPending, false);
  assert.deepEqual(stored, { text: 'keep this' });
  assert.equal(attempts, 2);
});
