import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { RuntimeAccounts } from './runtime-account';

test('Codex account operations use native requests and clear login challenges after cancel or completion', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-account-'));
  const command = join(root, 'codex-fixture');
  const account = join(root, 'account');
  const approval = join(root, 'approve');
  const log = join(root, 'requests');
  const accounts = new RuntimeAccounts(async () => command);
  try {
    await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const account = ${JSON.stringify(account)}, approval = ${JSON.stringify(approval)}, log = ${JSON.stringify(log)};
const loginId = '6a2a657d-be47-4453-b864-4fe80efea777';
const reply = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message}) + '\\n');
let pending;
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (request.id === undefined) return;
 fs.appendFileSync(log, request.method + '\\n');
 let result = {};
 if (request.method === 'account/read') result = { account: fs.existsSync(account) ? { type: 'chatgpt', email: 'fixture@example.invalid' } : null, requiresOpenaiAuth: true };
 if (request.method === 'account/login/start') {
  const type = request.params.type;
  result = type === 'chatgptDeviceCode' ? { type, loginId, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }
    : { type, loginId, authUrl: 'https://chatgpt.com/auth/login' };
  pending = setInterval(() => {
   if (!fs.existsSync(approval)) return;
   clearInterval(pending); fs.writeFileSync(account, 'signed in');
   reply({ method: 'account/login/completed', params: { loginId, success: true } });
  }, 10);
 }
 if (request.method === 'account/login/cancel') { if (request.params.loginId !== loginId) process.exit(1); clearInterval(pending); }
 if (request.method === 'account/logout') fs.rmSync(account, {force: true});
 reply({id: request.id, result});
});
`, { mode: 0o755 });
    assert.deepEqual(await accounts.state('codex', true), { status: 'signed-out' });
    const untilWaiting = async () => {
      for (let n = 0; n < 200; n++) {
        const state = await accounts.state('codex', false);
        if (state.phase === 'waiting') return state;
        await wait(10);
      }
      assert.fail('The login request did not reach the waiting state');
    };
    const device = accounts.signIn('codex', 'device');
    assert.deepEqual((await untilWaiting()).challenge, { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' });
    accounts.cancel('codex');
    await device;
    const cancelled = await accounts.state('codex', false);
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.challenge, undefined);
    assert.match(await readFile(log, 'utf8'), /^account\/login\/cancel$/m);

    const browser = accounts.signIn('codex', 'browser');
    assert.deepEqual((await untilWaiting()).challenge, { url: 'https://chatgpt.com/auth/login' });
    await writeFile(approval, 'approved');
    await browser;
    assert.deepEqual(await accounts.state('codex', false), { status: 'signed-in', label: 'fixture@example.invalid' });
    await accounts.signOut('codex');
    assert.deepEqual(await accounts.state('codex', false), { status: 'signed-out' });
  } finally {
    await accounts.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
