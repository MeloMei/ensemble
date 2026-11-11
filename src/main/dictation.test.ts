import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DictationEvent } from '../shared/dictation';
import { Dictation } from './dictation';

test('dictation serializes helpers, inserts only after stop, and rejects oversized output', {
  skip: process.platform !== 'darwin', timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-dictation-test-'));
  const helper = join(directory, 'mock-helper');
  const dictation = new Dictation(helper);
  const events: DictationEvent[] = [];
  const publish = (event: DictationEvent) => { events.push(event); };
  const delay = () => new Promise(resolve => setTimeout(resolve, 10));
  const until = async (check: () => boolean, failure: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await delay();
    }
    assert.fail(failure);
  };
  const awaitEvent = (id: string, type: DictationEvent['type']) => until(
    () => events.some(event => event.id === id && event.type === type), `Missing ${type} event for ${id}`,
  );
  try {
    assert.equal(dictation.unavailable(), 'helperMissing');
    await writeFile(helper, `#!${process.execPath}
const locale = process.argv[2];
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
if (locale.endsWith('-CA')) {
  send({ type: 'error', reason: 'speechPermission' });
} else {
  send({ type: 'ready' });
  if (locale.endsWith('-GB')) send({ type: 'final', text: '本机听写' });
  else if (locale.endsWith('-AU')) process.stdout.write('x'.repeat(65537));
  else process.stdin.on('data', input => {
    if (input.toString() !== 'stop\\n') process.exit(2);
    process.stdout.write(JSON.stringify({ type: 'final', text: 'Local speech' }) + '\\n', () => process.exit(0));
  });
}
`, { mode: 0o700 });

    assert.equal(dictation.start('first', 'en-US', publish), undefined);
    assert.equal(dictation.start('second', 'en-US', publish), 'busy');
    await awaitEvent('first', 'recording');
    dictation.stop('second');
    assert.deepEqual(events, [{ id: 'first', type: 'recording' }]);
    dictation.stop('first');
    await awaitEvent('first', 'final');
    assert.deepEqual(events.at(-1), { id: 'first', type: 'final', text: 'Local speech' });

    assert.equal(dictation.start('natural', 'en-GB', publish), undefined);
    await awaitEvent('natural', 'awaitingInsert');
    assert.ok(!events.some(event => event.id === 'natural' && event.type === 'final'));
    dictation.cancel('natural');
    assert.deepEqual(events.at(-1), { id: 'natural', type: 'cancelled' });
    dictation.stop('natural');
    assert.ok(!events.some(event => event.id === 'natural' && event.type === 'final'));

    assert.equal(dictation.start('cancel', 'en-US', publish), undefined);
    await awaitEvent('cancel', 'recording');
    dictation.cancel();
    await until(() => dictation.start('denied', 'en-CA', publish) === undefined, 'Cancelled helper did not exit');
    assert.ok(!events.some(event => event.id === 'cancel' && event.type === 'final'));
    await awaitEvent('denied', 'error');
    assert.deepEqual(events.at(-1), { id: 'denied', type: 'error', reason: 'speechPermission' });

    assert.equal(dictation.start('large', 'en-AU', publish), undefined);
    await awaitEvent('large', 'error');
    assert.deepEqual(events.at(-1), { id: 'large', type: 'error', reason: 'failed' });
  } finally {
    dictation.cancel();
    await rm(directory, { force: true, recursive: true });
  }
});
