import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApplicationUpdates, latestApplicationRelease, validateStagedApplication, type ApplicationUpdatesOptions } from './application-updates';
import { ApplicationUpdateGuard } from './application-update-guard';
import { createWorkbenchService } from './workbench-service';
import type { Snapshot } from '../shared/types';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../../bin/apply-app-update.sh', import.meta.url));
const api = 'https://api.github.com/repos/MeloMei/ensemble/releases/latest';
const base = 'https://github.com/MeloMei/ensemble/releases';
const feed = `${base}/latest/download/ensemble-update.json`;
function release(bytes: Buffer) {
  return { tag_name: 'v0.8.2', name: 'Ensemble v0.8.2', body: 'Save drafts before updating.', html_url: `${base}/tag/v0.8.2`,
    published_at: '2026-10-26T00:00:00Z', draft: false, prerelease: false,
    assets: [{ name: 'Ensemble-0.8.2-macOS-arm64.zip', size: bytes.length,
      browser_download_url: `${base}/download/v0.8.2/Ensemble-0.8.2-macOS-arm64.zip`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-update-')));
  const app = join(root, 'Ensemble.app'); const data = join(root, 'profile');
  await mkdir(join(app, 'Contents'), { recursive: true }); await mkdir(data);
  await writeFile(join(app, 'Contents', 'marker'), 'old'); await writeFile(join(data, 'state.json'), 'preserve user data');
  const options: ApplicationUpdatesOptions = { currentVersion: '0.8.1', appPath: app, dataPath: data, arch: 'arm64', helperPath: helper,
    getAutoCheck: () => true, async setAutoCheck() {}, publish() {}, async prepareInstall() { throw new Error('Not expected'); }, async cancelInstall() {}, requestQuit() {} };
  return { root, app, data, options };
}

test('updates accept only matching stable GitHub assets, with a checked checksum fallback', async () => {
  const bytes = Buffer.from('archive'); const source = release(bytes);
  const fetcher = async (url: string | URL | Request) => {
    assert.equal(String(url), feed);
    return Response.json(source);
  };
  const result = await latestApplicationRelease('arm64', fetcher as typeof fetch);
  assert.equal(result.version, '0.8.2'); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(latestApplicationRelease('x64', fetcher as typeof fetch), /当前 Mac/);
  await assert.rejects(latestApplicationRelease('arm64', (async () => Response.json({ ...source, prerelease: true })) as typeof fetch));
  const wrong = structuredClone(source); wrong.assets[0].browser_download_url = 'https://github.com/another/repository/releases/download/v0.8.2/update.zip';
  await assert.rejects(latestApplicationRelease('arm64', (async () => Response.json(wrong)) as typeof fetch), /安装包/);
  const fallback = { ...source, assets: [{ ...source.assets[0], digest: undefined }, { name: 'SHA256SUMS', size: 100,
    browser_download_url: `${base}/download/v0.8.2/SHA256SUMS`, digest: undefined }] };
  const recovered = await latestApplicationRelease('arm64', (async (url: string | URL | Request) => String(url) === feed ? Response.json(fallback)
    : new Response(`${result.sha256}  ${source.assets[0].name}\n`)) as typeof fetch);
  assert.equal(recovered.sha256, result.sha256);
});

test('automatic checks use the daily cache and manual checks share a persisted five-minute cooldown', { skip: process.platform !== 'darwin' }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(); let requests = 0; let updates: ApplicationUpdates | undefined;
  try {
    const options = { ...f.options, fetch: (async () => { requests++; await new Promise(resolveFetch => setTimeout(resolveFetch, 5)); return Response.json(release(Buffer.from('archive'))); }) as typeof fetch };
    updates = new ApplicationUpdates(options); await updates.load();
    await Promise.all([updates.check(), updates.check()]); assert.equal(requests, 1);
    await updates.dispose();
    updates = new ApplicationUpdates(options); await updates.load();
    await updates.check(false); assert.equal(requests, 1);
    await updates.check(); assert.equal(requests, 1);
    t.mock.timers.tick(5 * 60_000);
    await updates.check(); assert.equal(requests, 2);
  } finally { await updates?.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('release discovery falls back to the API only when the static feed is missing', async () => {
  const requests: string[] = [];
  const result = await latestApplicationRelease('arm64', (async (url: string | URL | Request) => {
    requests.push(String(url));
    return String(url) === feed ? new Response('Not Found', { status: 404 }) : Response.json(release(Buffer.from('archive')));
  }) as typeof fetch);
  assert.equal(result.version, '0.8.2'); assert.deepEqual(requests, [feed, api]);
  for (const status of [403, 429, 502]) {
    requests.length = 0;
    await assert.rejects(latestApplicationRelease('arm64', (async (url: string | URL | Request) => {
      requests.push(String(url)); return new Response('', { status });
    }) as typeof fetch));
    assert.deepEqual(requests, [feed]);
  }
});

test('rate limits persist their reset time across restart and preserve a known release', { skip: process.platform !== 'darwin' }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(); let requests = 0; let limited = false; let updates: ApplicationUpdates | undefined;
  let reset = 0;
  const options = { ...f.options, fetch: (async () => {
    requests++;
    return limited ? Response.json({ message: 'API rate limit exceeded' }, { status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset / 1000) } }) : Response.json(release(Buffer.from('archive')));
  }) as typeof fetch };
  try {
    updates = new ApplicationUpdates(options); await updates.load(); await updates.check();
    t.mock.timers.tick(5 * 60_000); limited = true; reset = Math.ceil((Date.now() + 10 * 60_000) / 1000) * 1000;
    const state = await updates.check();
    assert.equal(state.phase, 'error'); assert.equal(state.errorCode, 'rate-limited');
    assert.equal(state.retryAt, new Date(reset + 1000).toISOString()); assert.equal(state.checkAfter, state.retryAt);
    assert.equal(state.release?.version, '0.8.2'); assert.equal(requests, 2);
    await updates.dispose(); updates = new ApplicationUpdates(options); await updates.load();
    assert.equal(updates.snapshot.errorCode, 'rate-limited'); assert.equal(updates.snapshot.retryAt, state.retryAt);
    await updates.check(); await updates.check(false); assert.equal(requests, 2);
    t.mock.timers.tick(reset + 1000 - Date.now()); limited = false;
    const recovered = await updates.check(false);
    assert.equal(requests, 3); assert.equal(recovered.phase, 'available');
    assert.equal(recovered.errorCode, undefined); assert.equal(recovered.retryAt, undefined); assert.equal(recovered.error, undefined);
  } finally { await updates?.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('secondary limits honor retry headers and back off without treating every 403 as a rate limit', { skip: process.platform !== 'darwin' }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(); let requests = 0; let updates: ApplicationUpdates | undefined;
  const responses = [
    Response.json({ message: 'secondary rate limit' }, { status: 403, headers: { 'retry-after': '120' } }),
    new Response('', { status: 429, headers: { 'retry-after': new Date(Date.now() + 10 * 60_000).toUTCString() } }),
    new Response('', { status: 429, headers: { 'retry-after': 'invalid', 'x-ratelimit-reset': 'invalid' } }),
    new Response('', { status: 403 }),
  ];
  try {
    updates = new ApplicationUpdates({ ...f.options, fetch: (async () => responses[requests++]) as typeof fetch }); await updates.load();
    let state = await updates.check(); assert.equal(state.errorCode, 'rate-limited');
    assert.equal(Date.parse(state.retryAt!) - Date.now(), 121_000);
    await updates.check(); assert.equal(requests, 1);
    t.mock.timers.tick(Date.parse(state.checkAfter!) - Date.now());
    state = await updates.check(); assert.equal(state.errorCode, 'rate-limited');
    assert.ok(Date.parse(state.retryAt!) >= Date.parse(responses[1].headers.get('retry-after')!));
    t.mock.timers.tick(Date.parse(state.checkAfter!) - Date.now());
    state = await updates.check(); assert.equal(state.errorCode, 'rate-limited');
    assert.equal(Date.parse(state.retryAt!) - Date.now(), 4 * 60_000);
    t.mock.timers.tick(Date.parse(state.checkAfter!) - Date.now());
    state = await updates.check(); assert.equal(state.errorCode, 'forbidden'); assert.equal(state.retryAt, undefined);
    assert.match(state.error!, /403/); assert.equal(requests, 4);
  } finally { await updates?.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('manual checks reschedule automatic retries using the new cooldown', { skip: process.platform !== 'darwin' }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await fixture(); let requests = 0;
  const updates = new ApplicationUpdates({ ...f.options, fetch: (async () => ++requests === 2
    ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : Response.json(release(Buffer.from('archive')))) as typeof fetch });
  try {
    await updates.load(); await updates.check();
    t.mock.timers.tick(5 * 60_000);
    const failed = await updates.check(); assert.equal(requests, 2); assert.equal(failed.errorCode, 'rate-limited');
    t.mock.timers.tick(Date.parse(failed.checkAfter!) - Date.now() - 1); assert.equal(requests, 2);
    t.mock.timers.tick(1); assert.equal(Number(requests), 3);
    assert.equal((await updates.check(false)).phase, 'available');
  } finally { await updates.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('a corrupted download leaves the live bundle and user data intact and removes its owned stage', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const updates = new ApplicationUpdates({ ...f.options, fetch: (async (url: string | URL | Request) => {
    if (String(url) === feed) return Response.json(release(Buffer.from('correct')));
    const cached = JSON.parse(await readFile(join(f.data, 'updates', 'state.json'), 'utf8'));
    assert.ok(Date.parse(cached.checkAfter) > Date.now()); assert.equal(cached.failedChecks, 0);
    assert.ok(cached.stageRoot);
    return new Response('corrupt');
  }) as typeof fetch });
  try {
    await updates.load(); await updates.check(); const state = await updates.download();
    assert.equal(state.phase, 'error'); assert.match(state.error!, /校验失败/);
    assert.equal(await readFile(join(f.app, 'Contents', 'marker'), 'utf8'), 'old');
    assert.equal(await readFile(join(f.data, 'state.json'), 'utf8'), 'preserve user data');
    assert.equal((await readdir(f.root)).some(name => name.startsWith('.ensemble-update-')), false);
    assert.equal(JSON.parse(await readFile(join(f.data, 'updates', 'state.json'), 'utf8')).stageRoot, undefined);
  } finally { await updates.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('archive links cannot write outside the staged app even when the archive checksum is valid', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const source = join(f.root, 'source');
  await mkdir(join(source, 'Ensemble.app', 'Contents'), { recursive: true });
  await symlink('../../../outside', join(source, 'Ensemble.app', 'Contents', 'escape'));
  await run('/usr/bin/zip', ['-r', '-y', join(f.root, 'update.zip'), 'Ensemble.app'], { cwd: source });
  const archive = await readFile(join(f.root, 'update.zip'));
  const updates = new ApplicationUpdates({ ...f.options, fetch: (async (url: string | URL | Request) => String(url) === feed
    ? Response.json(release(archive)) : new Response(archive)) as typeof fetch });
  try {
    await updates.load(); await updates.check(); const state = await updates.download();
    assert.equal(state.phase, 'error'); assert.match(state.error!, /越界符号链接/);
    assert.equal((await readdir(f.root)).includes('outside'), false);
    assert.equal(await readFile(join(f.app, 'Contents', 'marker'), 'utf8'), 'old');
  } finally { await updates.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('one update lease rejects in-flight work and protects desktop and external MCP calls until cancelled', async () => {
  const state: Snapshot = { version: 1, sessions: [], workflows: [], workspaces: [], terminals: [], providers: [], dataPath: '', pluginPath: '', pluginErrors: [] };
  const guard = new ApplicationUpdateGuard(() => state); const token = randomUUID(); let finish!: () => void;
  const running = guard.run(() => new Promise<void>(resolveWork => { finish = resolveWork; }));
  assert.throws(() => guard.begin(token), /先完成/); finish(); await running;
  guard.begin(token); await assert.rejects(guard.run(() => 1), /正在安装更新/); guard.cancel(token);
  assert.equal(await guard.run(() => 1), 1);
  const f = await fixture(); const service = await createWorkbenchService({ dataPath: join(f.root, 'backend-profile'), command: process.execPath, bridgePath: join(f.root, 'bridge.cjs'), publish() {}, providers: [] });
  try {
    await service.call('workbench:begin-application-update', [token]);
    await assert.rejects(service.call('workbench:create-workspace', [{ name: 'blocked', cwd: f.root }]), /正在安装更新/);
    await assert.rejects(service.externalCall('not-a-token', 'create_run', {}), /正在安装更新/);
    await service.call('workbench:cancel-application-update', [token]);
    assert.equal((await service.call('workbench:snapshot', []) as Snapshot).sessions.length, 0);
  } finally { await service.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

test('renderer readiness keeps the backend frozen until the matching installed receipt commits', async () => {
  const f = await fixture(); const token = randomUUID(); const cancellations: string[] = [];
  const updates = new ApplicationUpdates({ ...f.options, async cancelInstall(value) { cancellations.push(value); } });
  try {
    await mkdir(join(f.data, 'updates'));
    await writeFile(join(f.data, 'updates', 'result.json'), JSON.stringify({ status: 'error', token: randomUUID(), version: f.options.currentVersion }));
    await writeFile(join(f.data, 'updates', 'pending.json'), JSON.stringify({ token, version: f.options.currentVersion }));
    await updates.load();
    assert.equal(updates.snapshot.phase, 'installing'); assert.equal(updates.snapshot.error, undefined);
    let commandsReleased = false;
    const commands = updates.waitForStartupConfirmation().then(() => { commandsReleased = true; });
    const ready = updates.acknowledgeReady();
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readdir(join(f.data, 'updates'))).includes(`ready-${token}`)) break;
      await new Promise(resolveReady => setTimeout(resolveReady, 5));
    }
    assert.deepEqual(cancellations, []);
    assert.equal(commandsReleased, false);
    await writeFile(join(f.data, 'updates', 'result.json'), JSON.stringify({ status: 'installed', token: randomUUID(), version: f.options.currentVersion }));
    await new Promise(resolveReady => setTimeout(resolveReady, 120)); assert.deepEqual(cancellations, []); assert.equal(commandsReleased, false);
    await writeFile(join(f.data, 'updates', 'result.json'), JSON.stringify({ status: 'installed', token, version: f.options.currentVersion }));
    await ready; await commands; assert.deepEqual(cancellations, [token]);
    assert.equal(commandsReleased, true); assert.equal(updates.snapshot.phase, 'current'); assert.equal(updates.snapshot.error, undefined);
  } finally { await updates.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('failed startup confirmation rejects queued renderer commands and reports the error', async () => {
  const f = await fixture(); const updates = new ApplicationUpdates(f.options);
  try {
    await mkdir(join(f.data, 'updates'));
    await writeFile(join(f.data, 'updates', 'pending.json'), JSON.stringify({ token: randomUUID(), version: f.options.currentVersion }));
    await updates.load();
    const blocked = assert.rejects(updates.waitForStartupConfirmation(), /安装记录已丢失/);
    await rm(join(f.data, 'updates', 'pending.json'));
    await assert.rejects(updates.acknowledgeReady(), /安装记录已丢失/);
    await blocked;
    assert.equal(updates.snapshot.phase, 'error'); assert.match(updates.snapshot.error!, /安装记录已丢失/);
  } finally { await updates.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('a backend started by another CLI also holds the pending update lease until the installed receipt commits', async () => {
  const f = await fixture(); const profile = join(f.root, 'backend-profile'); const token = randomUUID();
  const metadata = JSON.parse(await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
  await mkdir(join(profile, 'updates'), { recursive: true });
  await writeFile(join(profile, 'updates', 'pending.json'), JSON.stringify({ token, version: metadata.version }));
  const options = { dataPath: profile, command: process.execPath, bridgePath: join(f.root, 'bridge.cjs'), publish() {}, providers: [] };
  let service = await createWorkbenchService(options);
  try {
    await assert.rejects(service.call('workbench:create-workspace', [{ name: 'blocked', cwd: f.root }]), /正在安装更新/);
    await service.shutdown();
    await writeFile(join(profile, 'updates', 'result.json'), JSON.stringify({ token, version: metadata.version, status: 'installed' }));
    service = await createWorkbenchService(options);
    assert.equal(typeof await service.call('workbench:create-workspace', [{ name: 'allowed', cwd: f.root }]), 'string');
  } finally { await service.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

test('unknown or different target data formats require manual migration before installing', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const resources = join(f.app, 'Contents', 'Resources', 'app');
  await mkdir(resources, { recursive: true });
  await writeFile(join(f.app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.agent-workbench.desktop</string><key>CFBundleShortVersionString</key><string>0.8.2</string></dict></plist>');
  try {
    for (const ensemble of [undefined, { dataSchemaVersion: 2 }]) {
      await writeFile(join(resources, 'package.json'), JSON.stringify({ name: 'ensemble', version: '0.8.2', ensemble }));
      await assert.rejects(validateStagedApplication(f.app, '0.8.2', 'arm64'), /数据格式需要迁移/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('the detached helper commits a healthy bundle and rolls back a failed new launch without changing profile data', { skip: process.platform !== 'darwin' }, async () => {
  for (const healthy of [true, false]) {
    const f = await fixture(); const stage = await mkdtemp(join(f.root, '.ensemble-update-')); const staged = join(stage, 'unpacked', 'Ensemble.app');
    const token = randomUUID(); const updatesPath = join(f.data, 'updates');
    await mkdir(updatesPath);
    const fakeApp = async (path: string, marker: string, success: boolean) => {
      await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
      await writeFile(join(path, 'Contents', 'marker'), marker);
      const script = success ? '#!/bin/sh\nprintf "%s" "$$" > "$WORKBENCH_DATA_DIR/started.pid"\nif [ -n "${WORKBENCH_UPDATE_TOKEN:-}" ]; then printf "%s" "$$" > "$WORKBENCH_DATA_DIR/updates/ready-$WORKBENCH_UPDATE_TOKEN"; fi\nexec /bin/sleep 10\n' : '#!/bin/sh\nexit 1\n';
      await writeFile(join(path, 'Contents', 'MacOS', 'Ensemble'), script, { mode: 0o755 });
    };
    await fakeApp(f.app, 'old', true); await fakeApp(staged, 'new', healthy);
    const departed = spawn('/usr/bin/true'); await new Promise(resolveExit => departed.once('exit', resolveExit));
    let processId: number | undefined;
    try {
      const child = spawn('/bin/sh', [helper, f.app, staged, join(stage, 'previous.app'), String(departed.pid), String(departed.pid), f.data, token, '0.8.2'], { stdio: 'pipe' });
      let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
      const code = await new Promise<number | null>(resolveExit => child.once('exit', resolveExit));
      assert.equal(code, healthy ? 0 : 1, errors);
      assert.equal(await readFile(join(f.app, 'Contents', 'marker'), 'utf8'), healthy ? 'new' : 'old');
      const result = JSON.parse(await readFile(join(updatesPath, 'result.json'), 'utf8'));
      assert.equal(result.status, healthy ? 'installed' : 'error');
      assert.equal(result.token, token);
      assert.equal(result.phase, healthy ? 'commit' : 'wait-new-ready');
      assert.equal(result.exitCode, healthy ? 0 : 1);
      assert.equal(await readFile(join(f.data, 'state.json'), 'utf8'), 'preserve user data');
      assert.equal((await readdir(f.root)).some(name => name.startsWith('.ensemble-update-')), false);
      for (let attempt = 0; attempt < 100; attempt++) {
        try { processId = Number(await readFile(join(f.data, 'started.pid'), 'utf8')); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await new Promise(resolveStarted => setTimeout(resolveStarted, 10));
      }
      assert.ok(processId);
    } finally {
      processId ??= Number(await readFile(join(f.data, 'started.pid'), 'utf8').catch(() => '0'));
      if (processId) {
        try { process.kill(processId, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        for (let attempt = 0; attempt < 50; attempt++) {
          const state = await run('/bin/ps', ['-p', String(processId), '-o', 'stat=']).then(result => result.stdout.trim(), () => '');
          if (!state || state.startsWith('Z')) break;
          await new Promise(resolveStopped => setTimeout(resolveStopped, 10));
        }
      }
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
