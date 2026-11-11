import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { BackendClient, connectBackend } from './backend-client';
import { startBackend } from './backend-server';
import { MacNotificationHelper, type BackgroundNotice } from './mac-notification-helper';
import { DesktopPreferences } from './preferences';
import { parseNotificationLink } from './notification-link';

async function until<T>(check: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('Notification handoff did not reach the expected state.');
}

test('opted-in notifications survive desktop reconnect and honor foreground and persisted settings', {
  timeout: 12_000, skip: process.platform === 'win32',
}, async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-background-notifications-')));
  const tracePath = join(dataPath, 'notifications.jsonl');
  const helperStarted = join(dataPath, 'helper-started.json');
  const releaseHelper = join(dataPath, 'helper-release');
  const helperPath = join(dataPath, 'fixture-helper.cjs');
  const helper = new MacNotificationHelper(helperPath);
  const preferences = new DesktopPreferences(dataPath);
  await writeFile(helperPath, `#!${process.execPath}
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.argv[2] !== '--stdio' || request.operation !== 'deliver') process.exit(3);
const deliver = () => {
  fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(request.notice) + '\\n');
  process.stdout.write(JSON.stringify({authorization:'authorized'}));
};
if (!fs.existsSync(${JSON.stringify(helperStarted)})) {
  fs.writeFileSync(${JSON.stringify(helperStarted)}, JSON.stringify(request.notice));
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releaseHelper)})) return;
    clearInterval(timer);
    deliver();
  }, 10);
} else deliver();
`, { mode: 0o700 });
  const trace = async (): Promise<(Omit<BackgroundNotice, 'target'> & { link: string })[]> => (await readFile(tracePath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).split('\n').filter(Boolean).map(line => JSON.parse(line));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  let desktop: ChildProcess | undefined;
  const passive = new AbortController();
  const reconnect = new AbortController();
  let observing: Promise<void> | undefined;
  let reconnected: Promise<void> | undefined;
  try {
    backend = await startBackend({
      dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), backgroundNotifications: helper,
      providers: [{
        info: { id: 'fixture', name: 'Fixture', source: 'plugin', available: true, detail: '', capabilities: { resume: false, approvals: true } },
        async run(context) {
          if (context.prompt.startsWith('fail')) throw new Error('Fixture failure');
          if (context.prompt.startsWith('ask')) await context.approve({ title: 'Approval', detail: '', choices: [{ id: 'allow', label: 'Allow' }] });
          context.emit({ type: 'text', itemId: 'reply', text: 'Fixture output' });
        },
      }],
    });
    const { endpoint, service } = backend;
    const client = await connectBackend(dataPath);
    assert.equal(client.backgroundNotifications, true);
    const waitForDesktopDisconnect = (subscriptionId: string) => until(async () => {
      const response = await fetch(`${endpoint.url}/watch`, { method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId, sessionIds: [] }) });
      await response.body?.cancel();
      return response.status === 400;
    });
    const id = await service.engine.createSession({ cwd: dataPath, title: 'Fixture chat', providerId: 'fixture' });
    const run = async (text: string) => {
      await client.call('workbench:send-prompt', id, { text });
      await service.engine.waitSession(id);
    };
    await preferences.setLanguagePreference('en');
    await run('Before opt-in');
    assert.deepEqual(await trace(), []);
    desktop = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
import { BackendClient } from ${JSON.stringify(new URL('./backend-client.ts', import.meta.url).href)};
import { createInterface } from 'node:readline';
const client = new BackendClient(JSON.parse(process.argv[1]));
let ready = false;
createInterface({ input: process.stdin }).on('line', async line => {
  await client.setDesktopForeground(line === 'focus');
  process.stdout.write('foreground:' + (line === 'focus') + '\\n');
});
await client.subscribe((_snapshot, frame) => {
  if (!ready) { ready = true; process.stdout.write(frame.subscriptionId + '\\n'); }
}, new AbortController().signal, { desktopForeground: true });
`, JSON.stringify(endpoint)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const desktopProcess = desktop;
    let desktopOutput = '';
    desktopProcess.stdout!.on('data', bytes => { desktopOutput += String(bytes); });
    const subscriptionId = await until(() => /^([0-9a-f-]{36})\n/u.exec(desktopOutput)?.[1]);
    await preferences.setNotificationPreferences({ afterQuit: true, backgroundOnly: true, sound: true });
    let passiveReady = false;
    observing = client.subscribe(() => { passiveReady = true; }, passive.signal).catch(error => {
      if (!passive.signal.aborted) throw error;
    });
    await until(() => passiveReady);
    await run('Focused desktop suppresses results');
    await client.call('workbench:send-prompt', id, { text: 'ask while desktop is focused' });
    const existing = await until(() => service.engine.getSession(id).approvals[0]);
    desktopProcess.stdin!.write('blur\n');
    await until(() => desktopOutput.includes('foreground:false\n'));
    await client.call('workbench:decide-approval', existing.id, 'allow');
    await service.engine.waitSession(id);
    const finishingMessage = service.engine.getSession(id).attention?.messageId;
    const started = await until(() => readFile(helperStarted, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }));
    assert.equal(parseNotificationLink(JSON.parse(started).link)?.messageId, finishingMessage);
    const exited = once(desktopProcess, 'exit');
    desktopProcess.kill();
    await exited;
    await waitForDesktopDisconnect(subscriptionId);
    assert.deepEqual(await trace(), [], 'The helper is waiting for the delivery gate.');
    const desktopClient = new BackendClient(endpoint);
    let resets = 0;
    let reconnectedId = '';
    reconnected = desktopClient.subscribe((_snapshot, frame) => {
      if (frame.type === 'reset') { resets++; reconnectedId = frame.subscriptionId; }
    }, reconnect.signal, { desktopForeground: true })
      .catch(error => { if (!reconnect.signal.aborted) throw error; });
    await until(() => resets === 1);
    await writeFile(releaseHelper, '');
    await until(async () => (await trace()).length === 1);
    await run('Reconnected and focused suppresses results');
    await desktopClient.setDesktopForeground(false);
    await client.call('workbench:send-prompt', id, { text: 'ask with the desktop unfocused' });
    const approval = await until(() => service.engine.getSession(id).approvals[0]);
    await until(async () => (await trace()).length === 2);
    service.engine.publishState(); service.engine.publishState();
    await client.call('workbench:decide-approval', approval.id, 'allow');
    await service.engine.waitSession(id);
    await until(async () => (await trace()).length === 3);
    await desktopClient.setDesktopForeground(true);
    await preferences.setNotificationPreferences({ backgroundOnly: false });
    await run('Opted-in desktop uses the backend in the foreground');
    await until(async () => (await trace()).length === 4);
    await preferences.setNotificationPreferences({ backgroundOnly: true });
    assert.equal(resets, 1, 'Focus updates should not reset watched history.');
    reconnect.abort();
    await reconnected;
    await waitForDesktopDisconnect(reconnectedId);
    await preferences.setNotificationPreferences({ results: false, sound: false });
    await preferences.setLanguagePreference('zh-CN');
    await run('Suppressed completed result');
    await run('fail after changing settings');
    await until(async () => (await trace()).length === 5);
    const notices = await trace();
    assert.deepEqual(notices.map(notice => [notice.title, notice.silent]), [
      ['Agent finished', false], ['Agent needs approval', false], ['Agent finished', false], ['Agent finished', false], ['Agent 运行失败', true],
    ]);
    assert(notices.every(notice => notice.body === 'Fixture chat · fixture' && /^[a-f0-9]{64}$/.test(notice.id) && notice.dataPath === dataPath));
    assert.equal(new Set(notices.map(notice => notice.id)).size, 5);
    const targets = notices.map(notice => parseNotificationLink(notice.link));
    assert.deepEqual(targets.map(target => [target?.sessionId, target?.reason]), [[id, 'result'], [id, 'approval'], [id, 'result'], [id, 'result'], [id, 'failure']]);
    assert.equal(targets[1]?.approvalId, approval.id);
    assert(targets[0]?.messageId && targets[0].revision);
    await preferences.setNotificationPreferences({ afterQuit: false });
    await run('fail after opt-out');
    passive.abort();
    await observing;
    await backend.close(); backend = undefined;
    assert.deepEqual(await trace(), notices);
  } finally {
    if (desktop && desktop.exitCode === null && desktop.signalCode === null) {
      const exited = once(desktop, 'exit');
      desktop.kill();
      await exited;
    }
    passive.abort();
    reconnect.abort();
    await observing?.catch(() => {});
    await reconnected?.catch(() => {});
    await backend?.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});
