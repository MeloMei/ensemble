import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettings, readDeepSeekBalance } from './runtime-settings';

test('DeepSeek keeps each currency and selects CNY independently of response order', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousFetch = globalThis.fetch;
  const cny = { currency: 'CNY', total_balance: '3.95', granted_balance: '0.00', topped_up_balance: '3.95' };
  const usd = { currency: 'USD', total_balance: '0.54', granted_balance: '0.00', topped_up_balance: '0.54' };
  process.env.DEEPSEEK_API_KEY = 'fixture-key';
  try {
    for (const balance_infos of [[cny, usd], [usd, cny], [usd]]) {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://api.deepseek.com/user/balance');
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-key');
        return Response.json({ is_available: true, balance_infos });
      };
      const result = await readDeepSeekBalance();
      assert.equal(result.currency, balance_infos.length === 2 ? 'CNY' : 'USD');
      assert.equal(result.total, balance_infos.length === 2 ? '3.95' : '0.54');
      assert.deepEqual(result.balances, balance_infos.map(value => ({ currency: value.currency, total: value.total_balance, granted: value.granted_balance, toppedUp: value.topped_up_balance })));
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('MCP edits compare revisions, preserve native files and distinguish config from connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-settings-'));
  const cwd = join(directory, 'project'); await mkdir(cwd);
  const native = JSON.stringify({ mcpServers: { native: { command: 'missing-local-fixture', env: { API_KEY: 'fixture-secret' } } } });
  await writeFile(join(cwd, '.mcp.json'), native);
  const settings = new RuntimeSettings(join(directory, 'settings'));
  try {
    const before = await settings.mcpSettings(cwd);
    assert.equal(before.servers[0].status, 'enabled');
    assert.ok(!JSON.stringify(before).includes('fixture-secret'));
    const content = JSON.stringify({ mcpServers: { native: { command: 'new-local-fixture' } } });
    await settings.saveMcpSettings(cwd, { content, revision: before.revision });
    assert.equal((await settings.servers(cwd))[0].type, 'stdio');
    await assert.rejects(settings.saveMcpSettings(cwd, { content, revision: before.revision }), /发生变化/);
    assert.equal(await readFile(join(cwd, '.mcp.json'), 'utf8'), native);
    assert.equal((await settings.testServer(cwd, 'native')).status, 'failed');
    const current = await settings.mcpSettings(cwd);
    const updates = await Promise.allSettled([
      settings.saveMcpSettings(cwd, { content: '{"mcpServers":{"one":{"command":"one"}}}', revision: current.revision }),
      settings.saveMcpSettings(cwd, { content: '{"mcpServers":{"two":{"command":"two"}}}', revision: current.revision }),
    ]);
    assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('project skill editing cannot follow a directory outside the workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-skills-'));
  const cwd = join(directory, 'project'); const outside = join(directory, 'outside');
  await mkdir(cwd); await mkdir(outside); await symlink(outside, join(cwd, '.agents'));
  const settings = new RuntimeSettings(join(directory, 'settings'));
  try {
    await assert.rejects(settings.saveSkill(cwd, { name: 'sample', content: '# Sample' }), /超出项目/);
    await assert.rejects(readFile(join(outside, 'skills/sample/SKILL.md')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
