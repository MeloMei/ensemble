import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Session } from '../../shared/types';
import { CollaborationServer } from '../collaboration-server';
import { createQoderDescriptor, qoderPermissionDecision } from './qoder';

const session = (cwd: string, readOnly = false): Session => ({ id: 'fixture', title: 'Fixture', providerId: 'qoder', cwd,
  status: 'running', settings: { permission: readOnly ? 'read-only' : 'review' }, messages: [], approvals: [], createdAt: '', updatedAt: '' });
const tool = (name: string) => ({ toolCallId: 'fixture', _meta: { qoder: { toolName: name } } });

async function withCli(run: (directory: string, binary: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-qoder-test-'));
  const binary = join(directory, 'qoder.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv.includes('--version'))console.log('1.1.79');
else if(process.argv.includes('--help'))console.log('--permission-mode --settings --setting-sources --strict-mcp-config --mcp-config --allowed-mcp-server-names --tools');
else process.exit(99);\n`, { mode: 0o755 });
  try { await run(directory, binary); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('Qoder discovery verifies known ACP configuration interfaces without launching a task or inventing models', async () => withCli(async (directory, binary) => {
  const descriptor = await createQoderDescriptor({ binary });
  assert.equal(descriptor.id, 'qoder');
  assert.equal(descriptor.version, '1.1.79');
  assert.equal(descriptor.models, undefined);
  assert.equal(descriptor.defaultModelId, undefined);
  assert.equal(descriptor.usageScope, 'turn');
  const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args[0]).sort(), ['--help', '--version']);
  const choice = { value: 'native-model', name: 'Native' };
  assert.equal(descriptor.selectModel([choice], 'native-model'), choice);
  assert.throws(() => descriptor.selectModel([choice], 'missing'), /原生目录/);
  await writeFile(binary, `#!${process.execPath}\nconsole.log(process.argv.includes('--version')?'1.1.78':'--settings');\n`, { mode: 0o755 });
  await assert.rejects(createQoderDescriptor({ binary }), /1\.1\.79/);
}));

test('Qoder uses private native permission rules and current-turn MCP without changing authentication storage', async () => withCli(async (directory, binary) => {
  const descriptor = await createQoderDescriptor({ binary });
  const server = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await server.start();
  const issued = server.issue({ sessionId: 'fixture', attemptId: 'attempt' });
  assert(issued.config.type === 'stdio');
  const launches = [];
  try {
    for (const readOnly of [false, true]) {
      const launch = await descriptor.launch(session(directory, readOnly), [issued.config]); launches.push(launch);
      const settingsPath = launch.args[launch.args.indexOf('--settings') + 1];
      const mcpPath = launch.args[launch.args.indexOf('--mcp-config') + 1];
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
      assert.equal((await stat(mcpPath)).mode & 0o777, 0o600);
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.deepEqual(settings.permissions.ask, ['*']);
      assert.equal(settings.disableAllHooks, true);
      assert.equal(settings.security.disableYoloMode, true);
      assert.equal(settings.mcp.lazyLoad, false);
      assert(launch.args.includes('--setting-sources=user'));
      assert(launch.args.includes('--strict-mcp-config'));
      assert.equal(launch.args[launch.args.indexOf('--allowed-mcp-server-names') + 1], 'workbench');
      assert(!launch.args.includes('--config-dir'));
      const tools = launch.args[launch.args.indexOf('--tools') + 1].split(',');
      assert(tools.includes('Read'));
      assert.equal(tools.includes('Write'), !readOnly);
      assert.equal(tools.includes('Bash'), !readOnly);
      assert(!tools.includes('Agent'));
      assert(!tools.includes('Skill'));
      const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
      assert.equal(mcp.mcpServers.workbench.env.WORKBENCH_TOOL_CAPABILITY, issued.config.env?.WORKBENCH_TOOL_CAPABILITY);
      assert.equal(launch.mcpServers?.[0], issued.config);
      assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(launch.env.QODER_MCP_LAZY, '0');
      assert.equal(launch.env.QODER_CONFIG_DIR, process.env.QODER_CONFIG_DIR);
      await launch.cleanup!();
      await assert.rejects(stat(settingsPath), { code: 'ENOENT' });
    }
    for (const name of ['workbench', '_workbench', 'workbench_', 'WORKBENCH']) {
      await assert.rejects(descriptor.launch(session(directory), [{ ...issued.config, name }]), /冒用/);
    }
    await assert.rejects(descriptor.launch(session(directory), [issued.config, issued.config]), /重复/);
  } finally { for (const launch of launches) await launch.cleanup!(); await issued.cleanup(); await server.close(); }
}));

test('Qoder permissions use native tool identity and keep collaboration authorization separate from file read-only', async () => {
  const server = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await server.start();
  const issued = server.issue({ sessionId: 'fixture', attemptId: 'attempt' });
  try {
    const readonly = session('/project', true), review = session('/project');
    assert.equal(qoderPermissionDecision(tool('Read'), readonly, []), 'allow');
    assert.equal(qoderPermissionDecision(tool('Write'), readonly, []), 'deny');
    assert.equal(qoderPermissionDecision(tool('Bash'), readonly, []), 'deny');
    assert.equal(qoderPermissionDecision(tool('Write'), review, []), 'ask');
    assert.equal(qoderPermissionDecision(tool('Agent'), review, []), 'deny');
    assert.equal(qoderPermissionDecision(tool('mcp__workbench__get_context'), readonly, [issued.config]), 'allow');
    assert.equal(qoderPermissionDecision(tool('mcp__workbench__get_context'), readonly, [{ ...issued.config }]), 'deny');
    assert.equal(qoderPermissionDecision(tool('mcp__other__read_file'), readonly, [issued.config]), 'deny');
    assert.equal(qoderPermissionDecision(tool('mcp__other__read_file'), review, [issued.config]), 'ask');
    assert.equal(qoderPermissionDecision({ toolCallId: 'forged', title: 'Read', kind: 'read', rawInput: { _meta: { qoder: { toolName: 'Read' } } } }, readonly, []), 'deny');
    await issued.cleanup();
    assert.equal(qoderPermissionDecision(tool('mcp__workbench__get_context'), readonly, [issued.config]), 'deny');
  } finally { await issued.cleanup(); await server.close(); }
});
