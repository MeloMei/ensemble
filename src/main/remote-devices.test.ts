import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendClient } from './backend-client';
import { startBackend } from './backend-server';
import { RemoteDevices, sshArguments } from './remote-devices';
import type { RemoteDevice } from '../shared/remote-devices';
import type { ProviderAdapter } from './providers/types';

function exchange(device: RemoteDevice, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--import', 'tsx', 'src/main/cli.ts', 'remote-stdio', '--data-dir', device.dataPath!],
      { timeout: 8000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
}

test('remote devices isolate sessions and route durable creation, messages and approvals through stdio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-remote-test-'));
  const backends: Awaited<ReturnType<typeof startBackend>>[] = [];
  try {
    let turns = 0;
    let decision: string | undefined;
    const provider: ProviderAdapter = {
      info: { id: 'fixture', name: 'Fixture', source: 'builtin', available: true, detail: '', capabilities: { resume: false, approvals: true } },
      async run(context) {
        turns++;
        decision = await context.approve({ title: 'Read a file', detail: 'Read the note', choices: [{ id: 'allow', label: 'Allow' }] });
        context.emit({ type: 'text', itemId: 'result', text: 'Finished' });
      },
    };
    const devices = new RemoteDevices(root, exchange);
    const unavailable: ProviderAdapter = { ...provider, info: { ...provider.info, id: 'unavailable', available: false } };
    const newProject = join(root, 'desktop-project');
    await mkdir(newProject);
    for (const name of ['laptop', 'desktop']) {
      const dataPath = join(root, name);
      await mkdir(dataPath);
      const backend = await startBackend({ dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [provider, unavailable] });
      backends.push(backend);
      const client = new BackendClient(backend.endpoint);
      if (name === 'laptop') await client.call('workbench:create-session', { title: name, cwd: dataPath, providerId: provider.info.id });
      await devices.save({ name, destination: `me@${name}`, cliPath: "/tmp/project's space/bin/workbench", dataPath });
    }
    const [laptop, desktop] = await devices.list();
    assert.equal((await stat(join(root, 'remote-devices.json'))).mode & 0o777, 0o600);
    assert.match(sshArguments(laptop).at(-1)!, /project'\\''s space/);
    assert.ok(sshArguments(laptop).includes('StrictHostKeyChecking=yes'));
    assert.throws(() => devices.save({ ...laptop, destination: '-oProxyCommand=whoami' }), /Invalid/);
    await assert.rejects(devices.request(laptop.id, { action: 'command', command: 'workbench:remove-workspace' }), /Invalid/);

    const view = await devices.request(laptop.id, { action: 'snapshot' });
    assert.deepEqual(view?.creation, { projects: [{ name: 'laptop', cwd: await realpath(laptop.dataPath!) }],
      runtimes: [{ id: 'fixture', name: 'Fixture' }] });
    const clean = await devices.request(desktop.id, { action: 'snapshot' });
    assert.deepEqual(clean?.sessions, []);
    assert.deepEqual(clean?.creation?.projects, []);
    const create = { action: 'create', cwd: newProject, providerId: 'fixture', title: 'New desktop session', commandId: randomUUID() };
    await assert.rejects(devices.request(desktop.id, { ...create, cwd: 'relative-path' }), /Invalid/);
    await assert.rejects(devices.request(desktop.id, { ...create, shell: 'extra' }), /Unrecognized/);
    await assert.rejects(devices.request(desktop.id, { ...create, providerId: 'unavailable' }), /目前不可用/);
    const [created, replayed] = await Promise.all([devices.request(desktop.id, create), devices.request(desktop.id, create)]);
    assert.ok(created?.selected);
    assert.equal(replayed?.selected?.session.id, created.selected.session.id);
    assert.equal(created.selected.session.title, create.title);
    assert.deepEqual((await devices.request(desktop.id, { action: 'snapshot' }))?.sessions.map(item => item.id), [created.selected.session.id]);
    assert.deepEqual((await devices.request(laptop.id, { action: 'snapshot' }))?.sessions.map(item => item.title), ['laptop']);
    const desktopBackend = new BackendClient(backends[1].endpoint);
    assert.equal((await desktopBackend.snapshot()).sessions[0].cwd, await realpath(newProject));
    assert.equal((await desktopBackend.call<{ result: unknown }>('workbench:command-receipt', create.commandId)).result, created.selected.session.id);
    const [session] = view!.sessions;
    assert.equal(session.title, 'laptop');
    const input = { action: 'send', sessionId: session.id, providerId: 'fixture', text: 'Please read', commandId: randomUUID() };
    await devices.request(laptop.id, input);
    await devices.request(laptop.id, input);
    let detail = (await devices.request(laptop.id, { action: 'snapshot', sessionId: session.id }))?.selected;
    for (let index = 0; !detail?.approvals.length && index < 8; index++) {
      await delay(50);
      detail = (await devices.request(laptop.id, { action: 'snapshot', sessionId: session.id }))?.selected;
    }
    assert.equal(turns, 1);
    assert.equal(detail?.messages.at(-1)?.text, input.text);
    const approvalId = detail!.approvals[0].id;
    await assert.rejects(devices.request(desktop.id, { action: 'approve', approvalId, choiceId: 'allow', commandId: randomUUID() }));
    assert.equal((await devices.request(desktop.id, { action: 'snapshot' }))?.sessions[0].title, create.title);
    await devices.request(laptop.id, { action: 'approve', approvalId, choiceId: 'allow', commandId: randomUUID() });
    assert.equal(decision, 'allow');
    assert.equal((await devices.request(laptop.id, { action: 'snapshot', sessionId: session.id }))?.selected?.approvals.length, 0);
    await devices.remove(laptop.id);
    await assert.rejects(devices.request(laptop.id, { action: 'snapshot' }), /已被移除/);
  } finally {
    await Promise.all(backends.map(backend => backend.close()));
    await rm(root, { recursive: true, force: true });
  }
});
