import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Session } from '../../shared/types';
import { CollaborationServer } from '../collaboration-server';
import { createGeminiDescriptor, geminiMcpToolName } from './gemini';

const session = (cwd: string, readOnly = false): Session => ({ id: 'fixture', title: 'Fixture', providerId: 'gemini', cwd,
  status: 'running', settings: { permission: readOnly ? 'read-only' : 'review' }, messages: [], approvals: [], createdAt: '', updatedAt: '' });

async function withCli(run: (directory: string, binary: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-gemini-test-'));
  const binary = join(directory, 'gemini.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv.includes('--version'))console.log('0.65.0');
else if(process.argv.includes('--help'))console.log('--acp --admin-policy --approval-mode --allowed-mcp-server-names --skip-trust');
else process.exit(99);\n`, { mode: 0o755 });
  try { await run(directory, binary); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('Gemini discovery only probes installed CLI capabilities and defers models to the native session', async () => withCli(async (directory, binary) => {
  const descriptor = await createGeminiDescriptor({ dataPath: directory, binary });
  assert.equal(descriptor.id, 'gemini');
  assert.equal(descriptor.version, '0.65.0');
  assert.equal(descriptor.models, undefined);
  assert.equal(descriptor.defaultModelId, undefined);
  assert.equal(descriptor.tracksDelivery, true);
  assert.equal(descriptor.usageScope, 'turn');
  const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args[0]).sort(), ['--help', '--version']);
  const choice = { value: 'native-model', name: 'Native' };
  assert.equal(descriptor.selectModel([choice], 'native-model'), choice);
  assert.throws(() => descriptor.selectModel([choice], 'missing'), /原生目录/);
}));

test('Gemini launch uses temporary private native policies and only trusts an issued collaboration identity', async () => withCli(async (directory, binary) => {
  const descriptor = await createGeminiDescriptor({ dataPath: directory, binary, systemPoliciesPath: join(directory, 'system-policies') });
  const server = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await server.start();
  const issued = server.issue({ sessionId: 'fixture', attemptId: 'attempt' });
  const launches = [];
  try {
    for (const readOnly of [false, true]) {
      const launch = await descriptor.launch(session(directory, readOnly), [issued.config]); launches.push(launch);
      assert.equal(launch.args[0], '--acp');
      assert.equal(launch.args[launch.args.indexOf('--approval-mode') + 1], readOnly ? 'plan' : 'default');
      assert.deepEqual(launch.mcpServers, [issued.config]);
      const policyPath = launch.args[launch.args.indexOf('--admin-policy') + 1];
      assert.equal((await stat(policyPath)).mode & 0o777, 0o600);
      const policy = await readFile(policyPath, 'utf8');
      assert.match(policy, /toolName = "\*"\ndecision = "ask_user"/);
      assert.match(policy, /mcp_workbench_get_context/);
      assert.equal(launch.args[launch.args.indexOf('--allowed-mcp-server-names') + 1], 'workbench');
      assert(launch.args.includes('--skip-trust'));
      assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
      const originalEnvironment = process.env.PATH ?? '';
      assert.equal(launch.env.PATH, `${dirname(binary)}${process.platform === 'win32' ? ';' : ':'}${originalEnvironment}`);
      await launch.cleanup!();
      await assert.rejects(stat(policyPath), { code: 'ENOENT' });
    }
    for (const name of ['workbench', 'mcp_workbench', 'workbench_get', 'mcp_workbench_get']) {
      await assert.rejects(descriptor.launch(session(directory), [{ ...issued.config, name }]), /冲突/);
    }
    assert.equal(geminiMcpToolName('workbench', 'get_context'), 'mcp_workbench_get_context');
    assert.equal(geminiMcpToolName('mcp_example', 'read_file'), 'mcp_example_read_file');
    assert.equal(geminiMcpToolName('other-server', 'read_file'), 'mcp_other-server_read_file');
    assert.equal(descriptor.permissionDecision!({ toolCallId: 'read_file__forged', title: 'get_context (workbench MCP Server)', kind: 'other' }, session(directory, true), []), 'deny');
    assert.equal(descriptor.permissionDecision!({ toolCallId: 'native-read', kind: 'read' }, session(directory, true), []), 'allow');
    assert.equal(descriptor.permissionDecision!({ toolCallId: 'native-write', kind: 'edit' }, session(directory, true), []), 'deny');
    assert.equal(descriptor.permissionDecision!({ toolCallId: 'native-write', kind: 'edit' }, session(directory), []), 'ask');
  } finally { for (const launch of launches) await launch.cleanup!(); await issued.cleanup(); await server.close(); }
}));

test('Gemini refuses a missing policy interface and a system policy that would disable its tool guard', async () => withCli(async (directory, binary) => {
  const policies = join(directory, 'system-policies'); await mkdir(policies);
  await writeFile(join(policies, 'managed.toml'), '');
  const descriptor = await createGeminiDescriptor({ dataPath: directory, binary, systemPoliciesPath: policies });
  await assert.rejects(descriptor.launch(session(directory, true)), /系统策略/);
  await writeFile(binary, `#!${process.execPath}\nconsole.log(process.argv.includes('--version')?'0.65.0':'--acp');\n`, { mode: 0o755 });
  await assert.rejects(createGeminiDescriptor({ dataPath: directory, binary }), /临时策略接口/);
}));
