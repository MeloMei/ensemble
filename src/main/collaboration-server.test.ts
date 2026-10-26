import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CollaborationServer, isIssuedWorkbenchMcpServer, waitForWorkbenchMcpReady } from './collaboration-server';

test('real MCP stdio bridge binds caller identity and revokes it after the turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-mcp-'));
  const entry = join(directory, 'bridge.cjs');
  await build({ entryPoints: [resolve('src/main/mcp-stdio.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const calls: unknown[] = [];
  const service = new CollaborationServer(async (caller, tool, input) => { calls.push({ caller, tool, input }); return { accepted: true, sessionId: 'child' }; }, process.execPath, entry);
  await service.start();
  const issued = service.issue({ sessionId: 'parent', attemptId: 'attempt-one' });
  assert.equal(issued.config.type, 'stdio');
  if (issued.config.type !== 'stdio') throw new Error('Missing stdio config');
  const client = new Client({ name: 'fixture-runtime', version: '1' });
  const transport = new StdioClientTransport({ command: issued.config.command, args: issued.config.args, env: issued.config.env, stderr: 'ignore' });
  try {
    const controller = new AbortController();
    const ready = waitForWorkbenchMcpReady(issued.config, controller.signal, 5_000);
    await client.connect(transport, { timeout: 5_000 });
    await ready;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(calls.length, 0);
    await waitForWorkbenchMcpReady(issued.config, controller.signal);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'create_worker'));
    const input = { requestId: 'one', title: 'worker', providerId: 'opencode', prompt: 'return one' };
    const result = await client.callTool({ name: 'create_worker', arguments: input });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls, [{ caller: { sessionId: 'parent', attemptId: 'attempt-one' }, tool: 'create_worker', input }]);
    await issued.cleanup();
    await assert.rejects(waitForWorkbenchMcpReady(issued.config, controller.signal), /初始化身份/);
    const revoked = await client.callTool({ name: 'create_worker', arguments: input });
    assert.equal(revoked.isError, true);
    assert.equal(calls.length, 1);
  } finally {
    await client.close(); await transport.close(); await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP initialization waits reject absent, copied, timed out, cancelled and revoked capabilities', async () => {
  const service = new CollaborationServer(async () => ({}), process.execPath, '/not-started/bridge.cjs');
  await service.start();
  const issued = service.issue({ sessionId: 'parent', attemptId: 'attempt-ready' });
  assert.equal(issued.config.type, 'stdio');
  if (issued.config.type !== 'stdio') throw new Error('Missing stdio config');
  try {
    const controller = new AbortController();
    assert.equal(isIssuedWorkbenchMcpServer(issued.config), true);
    await assert.rejects(waitForWorkbenchMcpReady({ ...issued.config }, controller.signal), /初始化身份/);
    await assert.rejects(waitForWorkbenchMcpReady({ name: 'workbench', type: 'stdio', command: '/absent', args: [] }, controller.signal), /初始化身份/);
    const endpoint = issued.config.env!.WORKBENCH_TOOL_READY_ENDPOINT;
    const unauthorized = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer invalid' } });
    assert.equal(unauthorized.status, 403);
    await unauthorized.body?.cancel();
    await assert.rejects(waitForWorkbenchMcpReady(issued.config, controller.signal, 20), /初始化握手/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const cancelled = waitForWorkbenchMcpReady(issued.config, controller.signal);
    const rejection = assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
    controller.abort();
    await rejection;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const pending = waitForWorkbenchMcpReady(issued.config, new AbortController().signal);
    const revoked = assert.rejects(pending, /撤销/);
    await issued.cleanup();
    await revoked;
    const afterRevocation = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${issued.config.env!.WORKBENCH_TOOL_CAPABILITY}` } });
    assert.equal(afterRevocation.status, 403);
    await afterRevocation.body?.cancel();
    const closing = service.issue({ sessionId: 'parent', attemptId: 'attempt-closing' });
    const waitClosing = assert.rejects(waitForWorkbenchMcpReady(closing.config, new AbortController().signal), /撤销/);
    await service.close();
    await waitClosing;
  } finally { await issued.cleanup(); await service.close(); }
});
