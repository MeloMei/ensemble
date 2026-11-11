import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import type { AcpRegistryEntry } from '../shared/types';
import { createWorkbenchService } from './workbench-service';

function agent(version: number) {
  return `#!${process.execPath}\n` + String.raw`
const readline = require('node:readline');
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') write({ id, result: { protocolVersion: VERSION } });
  if (method === 'session/new') write({ id, result: { sessionId: 'registry-fixture' } });
  if (method === 'session/prompt') {
    write({ method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Registry Agent received prompt' } } } });
    write({ id, result: { stopReason: 'end_turn' } });
  }
});`.replace('VERSION', String(version));
}

async function archive(mode: 'safe' | 'escape' | 'link' | 'invalid-agent') {
  const tar = pack();
  if (mode === 'link') tar.entry({ name: 'runtime', type: 'symlink', linkname: '/outside' });
  else tar.entry({ name: mode === 'escape' ? '../outside' : './runtime', mode: 0o700 }, agent(mode === 'invalid-agent' ? 2 : 1));
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) {
    assert(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  return gzipSync(Buffer.concat(chunks));
}

test('ACP Registry stages binary and package installs, preserves a previous version on failed updates, and protects active work', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-acp-registry-')));
  const project = join(root, 'project');
  const tools = join(root, 'bin');
  await mkdir(project); await mkdir(tools);
  const oldPath = process.env.PATH;
  process.env.PATH = `${tools}${delimiter}${oldPath ?? ''}`;
  const managerTrace = join(root, 'manager-trace');
  const fakeNpm = `#!${process.execPath}\n` + `
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
if (!args.includes('--ignore-scripts') || !args.includes('--registry=https://registry.npmjs.org/') || args.at(-1) !== 'fixture-acp@1.0.0') process.exit(4);
const target = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', 'fixture-acp');
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'fixture-acp', version: '1.0.0', bin: 'agent.cjs' }));
fs.writeFileSync(path.join(target, 'agent.cjs'), ${JSON.stringify(agent(1))});
fs.appendFileSync(${JSON.stringify(managerTrace)}, 'npm\\n');`;
  const fakeUv = `#!${process.execPath}\n` + `
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
if (!args.includes('--no-build') || !args.includes('https://pypi.org/simple') || args.at(-1) !== 'fixture-uv==1.0.0') process.exit(5);
fs.writeFileSync(path.join(process.env.UV_TOOL_BIN_DIR, 'fixture-uv'), ${JSON.stringify(agent(1))}, { mode: 0o700 });
fs.appendFileSync(${JSON.stringify(managerTrace)}, 'uv\\n');`;
  await writeFile(join(tools, 'npm'), fakeNpm, { mode: 0o700 });
  await writeFile(join(tools, 'uv'), fakeUv, { mode: 0o700 });
  await writeFile(join(tools, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const binary = 'https://releases.example.test/agent.tar.gz';
  const download = 'https://downloads.example.test/agent.tar.gz';
  const platform = `${process.platform}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  let bytes = await archive('safe');
  let hash = createHash('sha256').update(bytes).digest('hex');
  let version = '1.0.0';
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/registry.json')) return Response.json({ version: '1.0.0', agents: [
      { id: 'test-binary', name: 'Binary ACP', version, description: 'Binary fixture', repository: 'https://example.test/project',
        distribution: { binary: { [platform]: { archive: binary, cmd: './runtime', sha256: hash } } } },
      { id: 'test-npm', name: 'npm ACP', version: '1.0.0', description: 'npm fixture', distribution: { npx: { package: 'fixture-acp@1.0.0' } } },
      { id: 'test-uv', name: 'uv ACP', version: '1.0.0', description: 'uv fixture', distribution: { uvx: { package: 'fixture-uv==1.0.0' } } },
      { id: 'unsupported', name: 'Unsupported', version: '1.0.0', description: 'Unsupported archive',
        distribution: { binary: { [platform]: { archive: 'https://example.test/agent.tar.bz2', cmd: 'agent' } } } },
    ] });
    if (url === binary) return Response.redirect(download);
    if (url === download) return new Response(new Uint8Array(bytes));
    throw new Error('Unexpected fixture request');
  });
  const dataPath = join(root, 'data');
  const options = { dataPath, command: process.execPath, bridgePath: join(root, 'bridge.cjs'), publish() {}, providers: [] };
  let service: Awaited<ReturnType<typeof createWorkbenchService>> | undefined;
  try {
    service = await createWorkbenchService(options);
    const refresh = () => service!.call('workbench:refresh-acp-registry', []) as Promise<AcpRegistryEntry[]>;
    const install = (id: string, requestedVersion = '1.0.0') => service!.call('workbench:install-acp-registry', [id, requestedVersion]);
    const assets = join(dataPath, 'acp-runtimes', 'registry-assets');
    const binaryProvider = 'acp-registry:test-binary';
    const observedVersion = () => service!.snapshot().providers.find(provider => provider.id === binaryProvider)?.acpRegistry?.version;
    assert.equal(requests.length, 0);
    const entries = await refresh();
    assert.deepEqual(entries.map(entry => entry.distribution?.kind), ['binary', 'npx', 'uvx', undefined]);
    assert.equal(entries[3].unavailable, 'format');
    await assert.rejects(install('unsupported'), /不可用/);
    assert.equal(requests.length, 1);
    assert.equal(await readFile(managerTrace, 'utf8').catch(() => ''), '');
    await install('test-binary');
    const originalAssets = await readdir(assets);
    assert.equal(observedVersion(), '1.0.0');
    const session = await service.engine.createSession({ title: 'Registry test', cwd: project, providerId: binaryProvider });
    await service.call('workbench:send-prompt', [session, { text: 'Send to registry runtime' }]);
    await service.engine.waitSession(session);
    assert(service.engine.getSession(session).messages.some(message => message.text === 'Registry Agent received prompt'));

    version = '2.0.0';
    hash = '0'.repeat(64);
    await refresh();
    await assert.rejects(install('test-binary', version), /SHA-256/);
    for (const mode of ['escape', 'link', 'invalid-agent'] as const) {
      bytes = await archive(mode); hash = createHash('sha256').update(bytes).digest('hex');
      await refresh();
      await assert.rejects(install('test-binary', version), /不安全路径|链接|协议版本/);
      assert.equal(observedVersion(), '1.0.0');
      assert.deepEqual(await readdir(assets), originalAssets);
    }
    bytes = await archive('safe'); hash = createHash('sha256').update(bytes).digest('hex');
    await refresh();
    await install('test-binary', version);
    assert.equal(observedVersion(), '2.0.0');
    assert.equal((await readdir(assets)).length, 1);
    await install('test-npm'); await install('test-uv');
    assert.equal(await readFile(managerTrace, 'utf8'), 'npm\nuv\n');
    assert.equal(service.snapshot().providers.filter(provider => provider.available).length, 3);

    await service.shutdown();
    const previousRequests = requests.length;
    service = await createWorkbenchService(options);
    assert.equal(observedVersion(), '2.0.0');
    assert.equal(requests.length, previousRequests);
    await service.call('workbench:set-session-queue-paused', [session, true]);
    await service.call('workbench:send-prompt', [session, { text: 'Hold this work' }]);
    version = '3.0.0';
    await refresh();
    const requestsBeforeUpdate = requests.length;
    await assert.rejects(install('test-binary', version), /清空队列/);
    assert.equal(requests.length, requestsBeforeUpdate);
    await assert.rejects(service.call('workbench:remove-custom-acp', [binaryProvider]), /清空队列/);
    const item = service.engine.getSession(session).queue![0];
    await service.call('workbench:remove-queued-prompt', [session, item.id, 0]);
    await service.call('workbench:remove-custom-acp', [binaryProvider]);
    assert.equal(observedVersion(), undefined);
    assert(service.engine.getSession(session).messages.some(message => message.text === 'Registry Agent received prompt'));
  } finally {
    await service?.shutdown();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
