import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import * as pty from '@lydell/node-pty';
import { discoverTerminalServices, parseTerminalListeners } from './terminal-services';

test('listener records require an owned PID and map only loopback and wildcard bindings', () => {
  const output = ['p40', '\nf5', 'tIPv4', 'n*:3000', '\nf6', 'tIPv6', 'n*:3001',
    '\nf7', 'tIPv4', 'n10.0.0.3:3002', '\nf8', 'tIPv4', 'n127.0.0.1:3000',
    '\nf9', 'tIPv6', 'n[::1]:3003', '\nf10', 'tIPv4', 'n127.0.0.1:65536',
    '\np99', '\nf6', 'tIPv4', 'n127.0.0.1:3333'].join('\0');
  assert.deepEqual(parseTerminalListeners(output, new Set([40])), [
    { host: '127.0.0.1', port: 3000 }, { host: '::1', port: 3001 }, { host: '::1', port: 3003 },
  ]);
});

test('Darwin discovery finds a real PTY shell descendant and excludes an unrelated listener', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-terminal-listener-'));
  const unrelated = createServer();
  let shell: pty.IPty | undefined;
  let exited: Promise<void> | undefined;
  try {
    const script = join(directory, 'listener.cjs');
    const address = join(directory, 'listener.port');
    await writeFile(script, `const server = require('node:net').createServer();
      server.listen(0, '127.0.0.1', () => require('node:fs').writeFileSync(process.argv[2], String(server.address().port)));`);
    await new Promise<void>((resolve, reject) => { unrelated.once('error', reject); unrelated.listen(0, '127.0.0.1', resolve); });
    shell = pty.spawn('/bin/sh', ['-c', '"$1" "$2" "$3" & wait', 'fixture', process.execPath, script, address], {
      cwd: directory, name: 'xterm-256color', cols: 80, rows: 24,
    });
    exited = new Promise<void>(resolve => shell!.onExit(() => resolve()));
    let port = 0;
    for (let attempt = 0; !port && attempt < 80; attempt++) {
      port = Number(await readFile(address, 'utf8').catch(() => ''));
      if (!port) await delay(20);
    }
    assert.ok(port, 'PTY child did not start its loopback listener');
    const signal = AbortSignal.timeout(3000);
    const actual = await discoverTerminalServices(shell.pid, process.pid, signal);
    assert.deepEqual(actual, [{ host: '127.0.0.1', port }]);
    assert.deepEqual(await discoverTerminalServices(shell.pid, process.ppid, AbortSignal.timeout(1000)), []);
    assert.deepEqual(await discoverTerminalServices(shell.pid, process.pid, AbortSignal.abort()), []);
  } finally {
    if (shell) {
      try { process.kill(-shell.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await Promise.race([exited, delay(1500, undefined, { ref: false })]);
    }
    if (unrelated.listening) await new Promise<void>(resolve => unrelated.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
