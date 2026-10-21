import assert from 'node:assert/strict';
import test from 'node:test';
import { CollaborationServer, isIssuedWorkbenchMcpServer } from '../collaboration-server';
import { codexMcpConfiguration, WORKBENCH_MCP_TOOLS } from './mcp-configuration';
import { prepareOpenCodeMcp } from './opencode';
import { openCodeAgentConfiguration, openCodeReadOnlyPermissions } from './opencode-policy';

test('Codex preapproval is limited to the shared catalog on an unchanged currently issued platform configuration', async () => {
  const server = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await server.start();
  try {
    const issued = server.issue({ sessionId: 'owned', attemptId: 'attempt' });
    assert(isIssuedWorkbenchMcpServer(issued.config));
    const platform = codexMcpConfiguration([issued.config]).workbench as Record<string, unknown>;
    assert.equal(platform.default_tools_approval_mode, 'prompt');
    assert.deepEqual(platform.enabled_tools, [...WORKBENCH_MCP_TOOLS]);
    assert.deepEqual(Object.keys(platform.tools as object).sort(), [...WORKBENCH_MCP_TOOLS].sort());
    assert(Object.values(platform.tools as Record<string, { approval_mode: string }>).every(tool => tool.approval_mode === 'approve'));
    const cloned = { ...issued.config };
    assert.equal(isIssuedWorkbenchMcpServer(cloned), false);
    const impostor = codexMcpConfiguration([cloned]).workbench as Record<string, unknown>;
    assert.equal(impostor.default_tools_approval_mode, 'prompt'); assert.equal(impostor.tools, undefined);
    if (issued.config.type !== 'stdio') throw new Error('Unexpected transport');
    issued.config.args = ['/different/bridge.cjs'];
    assert.equal(isIssuedWorkbenchMcpServer(issued.config), false);
    await issued.cleanup();
    const next = server.issue({ sessionId: 'owned', attemptId: 'next' });
    assert(isIssuedWorkbenchMcpServer(next.config)); await next.cleanup(); assert.equal(isIssuedWorkbenchMcpServer(next.config), false);
    const last = server.issue({ sessionId: 'owned', attemptId: 'last' });
    await server.close(); assert.equal(isIssuedWorkbenchMcpServer(last.config), false);
  } finally { await server.close(); }
});

test('OpenCode registers only issued platform MCP natively as direct tools and preserves user ACP servers', async () => {
  const server = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await server.start();
  try {
    const issued = server.issue({ sessionId: 'owned', attemptId: 'direct-tools' });
    const user = { name: 'user-tools', type: 'stdio' as const, command: 'native-user-server', args: [], env: { USER_SETTING: 'preserved' } };
    const prepared = prepareOpenCodeMcp([user, issued.config]);
    assert.deepEqual(prepared.mcpServers, [user]);
    const native = prepared.nativeServers.workbench;
    assert.equal(native.codemode, false); assert.equal(native.type, 'local');
    if (issued.config.type !== 'stdio') throw new Error('Unexpected transport');
    assert.deepEqual(native.command, [issued.config.command, ...issued.config.args]);
    assert.equal(native.environment, issued.config.env);
    const permissions = openCodeReadOnlyPermissions([user, issued.config]);
    assert.deepEqual(permissions[0], { action: '*', resource: '*', effect: 'deny' });
    assert.deepEqual(permissions.filter(rule => rule.action.startsWith('workbench_')).map(rule => rule.action).sort(), WORKBENCH_MCP_TOOLS.map(tool => `workbench_${tool}`).sort());
    assert(!permissions.some(rule => rule.action.startsWith('user-tools_')));
    assert(!permissions.some(rule => ['execute', 'shell', 'edit', 'subagent'].includes(rule.action) && rule.effect === 'allow'));
    assert.deepEqual(openCodeAgentConfiguration({ settings: { permission: 'review' } } as never, [user, issued.config]), {});
    const clone = { ...issued.config };
    assert.deepEqual(prepareOpenCodeMcp([clone]), { mcpServers: [clone], nativeServers: {} });
    assert(!openCodeReadOnlyPermissions([clone]).some(rule => rule.action.startsWith('workbench_')));
    await issued.cleanup();
    assert.deepEqual(prepareOpenCodeMcp([issued.config]), { mcpServers: [issued.config], nativeServers: {} });
  } finally { await server.close(); }
});
