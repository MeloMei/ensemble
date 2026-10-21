import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CollaborationServer } from './collaboration-server';

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
    await client.connect(transport, { timeout: 5_000 });
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'create_worker'));
    const input = { requestId: 'one', title: 'worker', providerId: 'opencode', prompt: 'return one' };
    const result = await client.callTool({ name: 'create_worker', arguments: input });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls, [{ caller: { sessionId: 'parent', attemptId: 'attempt-one' }, tool: 'create_worker', input }]);
    await issued.cleanup();
    const revoked = await client.callTool({ name: 'create_worker', arguments: input });
    assert.equal(revoked.isError, true);
    assert.equal(calls.length, 1);
  } finally {
    await client.close(); await transport.close(); await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
