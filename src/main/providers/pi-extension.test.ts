import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { CollaborationServer } from '../collaboration-server';
import { WORKBENCH_MCP_TOOLS } from './mcp-configuration';
import { createPiExtension } from './pi-extension';
import type { TurnContext } from './types';

const context = (readOnly = false): TurnContext => ({
  session: { id: 'session', providerId: 'pi', title: 'Pi', cwd: '/project', status: 'running', messages: [], approvals: [],
    createdAt: '', updatedAt: '', settings: { permission: readOnly ? 'read-only' : 'review' } },
  prompt: 'Inspect the project', signal: new AbortController().signal, emit() {}, async approve() { return 'deny'; },
});

async function extensionHarness(input: TurnContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-pi-extension-test-'));
  const sdk = join(directory, 'sdk.mjs');
  await writeFile(sdk, 'export const createMcpExtension = options => pi => { pi.mcpOptions = options; };');
  const extension = await createPiExtension(input, sdk);
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
  const servers: { name: string; config: Record<string, any> }[] = [];
  let tools = ['read', 'grep', 'find', 'ls'];
  let activeTools: string[] | undefined;
  let approved = false;
  let approvalError = false;
  const decisions: { title: string; message: string }[] = [];
  const notices: { message: string; type: string }[] = [];
  const pi = {
    mcpOptions: undefined as { loadConfig(): unknown } | undefined,
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    registerCommand(name: string, command: { handler(args: string, ctx: any): Promise<void> }) { commands.set(name, command); },
    registerMcpServer(name: string, config: Record<string, any>) { servers.push({ name, config }); },
    getAllTools() { return tools.map(name => ({ name })); },
    getActiveTools() { return activeTools ?? tools; },
  };
  const ctx = { ui: {
    notify(message: string, type: string) { notices.push({ message, type }); },
    async confirm(title: string, message: string) {
      decisions.push({ title, message });
      if (approvalError) throw new Error('Approval channel closed');
      return approved;
    },
  } };
  const module = await import(pathToFileURL(extension.path).href);
  await module.default(pi);
  return { extension, pi, servers, decisions, notices,
    setTools(names: string[]) { tools = names; },
    setActiveTools(names: string[]) { activeTools = names; },
    setApproval(value: boolean) { approved = value; },
    failApproval() { approvalError = true; },
    input() { return handlers.get('input')!({ type: 'input', source: 'rpc' }, ctx); },
    tool(name: string) { return handlers.get('tool_call')!({ type: 'tool_call', toolName: name, input: { path: 'file.txt' } }, ctx); },
    ready() { return commands.get(extension.command)!.handler('', ctx); },
    async close() { await extension.cleanup(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('Pi guards input until readiness and blocks writes and unknown tools in read-only mode', async () => {
  const h = await extensionHarness(context(true));
  try {
    assert.deepEqual(h.pi.mcpOptions!.loadConfig(), { servers: [], errors: [], autoEnableCodemode: false });
    assert.equal(h.input().action, 'handled');
    assert.equal((await h.tool('read')).block, true);
    await h.ready();
    assert.deepEqual(JSON.parse(h.notices.at(-1)!.message), { marker: h.extension.readyMarker, ready: true, guard: true });
    assert.equal(h.input().action, 'continue');
    for (const name of ['read', 'grep', 'find', 'ls']) assert.equal(await h.tool(name), undefined);
    for (const name of ['bash', 'powershell', 'write', 'edit', 'codemode', 'mcp__user__read']) {
      assert.equal((await h.tool(name)).block, true);
    }
    assert.equal(h.decisions.length, 0);
  } finally { await h.close(); }
});

test('Pi review permissions require single-call approval and fail closed when approval is unavailable', async () => {
  const h = await extensionHarness(context());
  try {
    await h.ready();
    assert.equal((await h.tool('write')).block, true);
    h.setApproval(true);
    assert.equal(await h.tool('write'), undefined);
    assert.equal(h.decisions.length, 2);
    assert.match(h.decisions[0].message, /write\n/);
    h.failApproval();
    assert.equal((await h.tool('bash')).block, true);
  } finally { await h.close(); }
});

test('Pi only preapproves issued collaboration tools and keeps private configuration temporary', async () => {
  const server = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await server.start();
  const issued = server.issue({ sessionId: 'session', attemptId: 'attempt' });
  const input = context(true); input.mcpServers = [issued.config];
  const h = await extensionHarness(input);
  try {
    const expected = WORKBENCH_MCP_TOOLS.map(name => `mcp__workbench__${name}`);
    h.setTools(expected);
    await h.ready();
    for (const name of expected) assert.equal(await h.tool(name), undefined);
    assert.equal((await h.tool('mcp__workbench__unlisted')).block, true);
    h.setActiveTools(expected.slice(1));
    assert.equal(h.pi.getAllTools().length, expected.length);
    assert.equal((await h.tool(expected[1])).block, true);
    assert.equal(h.input().action, 'handled');
    assert.equal(h.servers[0].config.exposure, 'hidden');
    assert.deepEqual(Object.keys(h.servers[0].config.toolExposure).sort(), [...WORKBENCH_MCP_TOOLS].sort());
    assert.equal((await stat(h.extension.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dirname(h.extension.path), 'config.json'))).mode & 0o777, 0o600);
    await h.extension.cleanup();
    await assert.rejects(stat(dirname(h.extension.path)), { code: 'ENOENT' });
  } finally { await h.close(); await issued.cleanup(); await server.close(); }

  const clone = context(true); clone.mcpServers = [{ ...issued.config }];
  const untrusted = await extensionHarness(clone);
  try {
    await untrusted.ready();
    assert.equal((await untrusted.tool('mcp__workbench__get_context')).block, true);
    assert.equal(untrusted.servers[0].config.exposure, 'direct');
  } finally { await untrusted.close(); }
});

test('Pi preserves literal MCP environment and header values without native command expansion', async () => {
  const input = context(); input.mcpServers = [
    { name: 'stdio', type: 'stdio', command: '/tool', args: [], env: { LITERAL: '!printf injected', DOLLARS: '${TOKEN}/$HOME/$$', EMPTY: '' } },
    { name: 'http', type: 'http', url: 'https://example.test/mcp', headers: { Authorization: '!literal ${TOKEN}' } },
  ];
  const h = await extensionHarness(input);
  try {
    assert.deepEqual(h.servers[0].config.env, { LITERAL: '$!printf injected', DOLLARS: '$${TOKEN}/$$HOME/$$$$', EMPTY: '' });
    assert.deepEqual(h.servers[1].config.headers, { Authorization: '$!literal $${TOKEN}' });
    const source = await readFile(h.extension.path, 'utf8');
    assert(!source.includes('printf injected'));
    const unsupported = context(); unsupported.mcpServers = [{ name: 'legacy', type: 'sse', url: 'https://example.test/sse' }];
    await assert.rejects(createPiExtension(unsupported, '/sdk.mjs'), /不支持 SSE/);
    const conflicting = context(); conflicting.mcpServers = [
      { name: 'foo-bar', type: 'stdio', command: '/tool', args: [] },
      { name: 'foo_bar', type: 'stdio', command: '/tool', args: [] },
    ];
    await assert.rejects(createPiExtension(conflicting, '/sdk.mjs'), /名称冲突/);
  } finally { await h.close(); }
});
