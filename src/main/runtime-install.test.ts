import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { RuntimeInstaller } from './runtime-install';

test('Runtime installation cancels a running installer, retries, and verifies the managed executable', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-install-'));
  const bin = join(root, 'bin');
  const oldPath = process.env.PATH;
  const detected: string[] = [];
  const installer: RuntimeInstaller = new RuntimeInstaller(root, async providerId => {
    detected.push(providerId);
    return Boolean(await installer.managedBinary(providerId));
  });
  try {
    await mkdir(bin);
    await symlink(process.execPath, join(bin, 'node'));
    const script = join(bin, 'npm');
    const state = join(root, 'argv.json');
    process.env.PATH = [bin, oldPath].filter(Boolean).join(delimiter);
    const program = (body: string) => writeFile(script, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(args));\n${body}`, { mode: 0o755 });
    await program('setInterval(() => {}, 100);');
    const current = async () => (await installer.list()).find(entry => entry.providerId === 'codex');
    assert.equal((await current())?.prerequisiteMet, true);
    const first = installer.install('codex');
    for (let attempt = 0; attempt < 100 && !await readFile(state, 'utf8').catch(() => ''); attempt++) await wait(10);
    const args = JSON.parse(await readFile(state, 'utf8')) as string[];
    assert.ok(args.includes('@openai/codex') && args.includes('--ignore-scripts'));
    assert.equal((await current())?.phase, 'installing');
    await assert.rejects(installer.install('pi'), /current runtime installation/);
    installer.cancel('codex');
    await first;
    assert.equal((await current())?.phase, 'cancelled');
    assert.deepEqual(detected, []);

    await program('process.exit(3);');
    await installer.install('codex');
    assert.equal((await current())?.problem, 'install');

    await program(`const bin = require('node:path').join(args[args.indexOf('--prefix') + 1], 'bin');
fs.mkdirSync(bin); fs.writeFileSync(require('node:path').join(bin, 'codex'), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });`);
    await installer.install('codex');
    assert.equal((await current())?.phase, 'complete');
    assert.deepEqual(detected, ['codex']);
    assert.equal(await installer.managedBinary('codex'), join(root, 'installed-runtimes', 'codex', 'bin', 'codex'));
  } finally {
    await installer.shutdown();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
