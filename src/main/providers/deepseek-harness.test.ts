import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Session } from '../../shared/types';
import { createDeepSeekHarnessDescriptor, deepSeekChildEnvironment } from './deepseek-harness';

test('DeepSeek child credentials only reuse an official DeepSeek Claude API configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-dsh-credentials-'));
  const settingsPath = join(directory, 'settings.json');
  const environment = { PATH: '/fixture/bin', DSH_HOME: '/fixture/home' };
  const writeSettings = (env: Record<string, unknown>) => writeFile(settingsPath, JSON.stringify({ env }));
  try {
    assert.deepEqual(await deepSeekChildEnvironment(environment, settingsPath), environment);
    await writeFile(settingsPath, '{invalid-secret-fixture');
    assert.deepEqual(await deepSeekChildEnvironment(environment, settingsPath), environment);
    for (const endpoint of [
      'https://api.anthropic.com', 'https://api.deepseek.com.evil.test/anthropic',
      'http://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic?proxy=1',
    ]) {
      await writeSettings({ ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: 'unrelated-fixture-key' });
      assert.deepEqual(await deepSeekChildEnvironment(environment, settingsPath), environment);
    }
    await writeSettings({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic/',
      ANTHROPIC_AUTH_TOKEN: 'fixture-deepseek-key', ANTHROPIC_API_KEY: 'fixture-secondary-key',
      UNRELATED_SETTING: 'do-not-copy',
    });
    assert.deepEqual(await deepSeekChildEnvironment(environment, settingsPath), {
      ...environment, DEEPSEEK_API_KEY: 'fixture-deepseek-key',
    });
    assert.deepEqual(environment, { PATH: '/fixture/bin', DSH_HOME: '/fixture/home' });
    const inherited = { ...environment, DEEPSEEK_API_KEY: 'fixture-existing-key' };
    assert.deepEqual(await deepSeekChildEnvironment(inherited, settingsPath), inherited);
    await writeSettings({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_API_KEY: 'fixture-secondary-key' });
    assert.equal((await deepSeekChildEnvironment(environment, settingsPath)).DEEPSEEK_API_KEY, 'fixture-secondary-key');
    await writeSettings({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: { secret: 'invalid' } });
    assert.deepEqual(await deepSeekChildEnvironment(environment, settingsPath), environment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('DeepSeek descriptor caps isolated runtime output and selects only an advertised Flash choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-dsh-descriptor-'));
  const binary = join(directory, 'dsh.mjs');
  await writeFile(binary, `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(8);\nconsole.log('0.2.1-rc.2');\n`, { mode: 0o700 });
  const saved = {
    DSH_BINARY: process.env.DSH_BINARY,
    DSH_HOME: process.env.DSH_HOME,
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  };
  Object.assign(process.env, {
    DSH_BINARY: binary, DSH_HOME: '/fixture-existing-harness-home', DSH_PERMISSION_MODE: 'danger-full-access',
    DEEPSEEK_API_KEY: 'fixture-existing-key',
    DEEPSEEK_BASE_URL: 'https://unrelated-proxy.invalid/anthropic',
  });
  const session: Session = {
    id: 'fixture', title: 'Fixture', providerId: 'deepseek-harness', cwd: directory,
    status: 'idle', messages: [], approvals: [], createdAt: '', updatedAt: '',
  };
  try {
    await assert.rejects(createDeepSeekHarnessDescriptor({ dataPath: directory, maxOutputTokens: 0 }), /输出上限/);
    const descriptor = await createDeepSeekHarnessDescriptor({ dataPath: directory, maxOutputTokens: 256 });
    assert.equal(descriptor.version, '0.2.1-rc.2');
    assert.deepEqual(descriptor.models, [{ id: 'flash', name: 'DeepSeek Flash', free: false }]);
    const flash = { value: JSON.stringify(['deepseek-official', 'deepseek-flash']), name: 'DeepSeek-V4.1-Flash' };
    const legacy = { value: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']), name: 'DeepSeek-V4-Flash' };
    assert.equal(descriptor.selectModel([{ value: 'other-id', name: 'DeepSeek Pro' }, flash], 'flash'), flash);
    assert.equal(descriptor.selectModel([legacy, flash], 'flash'), flash);
    assert.equal(descriptor.selectModel([legacy], 'flash'), legacy);
    assert.throws(() => descriptor.selectModel([{ value: 'other-id', name: 'DeepSeek Pro' }], 'flash'), /未提供/);
    assert.throws(() => descriptor.selectModel([
      { value: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']), name: 'DeepSeek Flash' },
      { value: JSON.stringify(['deepseek-account', 'deepseek-flash']), name: 'DeepSeek Flash' },
      { value: JSON.stringify(['custom-provider', 'deepseek-flash']), name: 'DeepSeek Flash' },
      { value: JSON.stringify(['deepseek-official', 'deepseek-flash', 'extra']), name: 'DeepSeek Flash' },
      { value: 'not-json', name: 'DeepSeek Flash' },
    ], 'flash'), /未提供/);
    assert.throws(() => descriptor.selectModel([flash], 'pro'), /仅支持 Flash/);
    const first = await descriptor.launch(session);
    const second = await descriptor.launch({ ...session, id: 'other-session' });
    assert.equal(first.command, binary);
    assert.deepEqual(first.args.slice(0, 3), ['--profile', 'acp', '--patch']);
    assert.notEqual(first.args[3], second.args[3]);
    const overlay = await readFile(first.args[3], 'utf8');
    assert.match(overlay, /- id: llm-deepseek\n  config:\n    baseURL: https:\/\/api.deepseek.com\/anthropic\n    maxTokens: 256\n    reasoningEffort: off/);
    assert.equal(overlay.includes('unrelated-proxy'), false);
    assert.equal(overlay.includes('fixture-existing-key'), false);
    if (process.platform !== 'win32') {
      assert.equal((await stat(first.args[3])).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(first.args[3]))).mode & 0o777, 0o700);
    }
    assert.equal(first.env.DSH_HOME, '/fixture-existing-harness-home');
    assert.equal(first.env.DSH_PERMISSION_MODE, 'workspace-write');
    assert.equal(first.env.DEEPSEEK_API_KEY, 'fixture-existing-key');
    assert.equal(process.env.DSH_PERMISSION_MODE, 'danger-full-access');
    await first.cleanup?.();
    await first.cleanup?.();
    await assert.rejects(stat(first.args[3]), { code: 'ENOENT' });
    assert.equal((await stat(second.args[3])).isFile(), true);
    await second.cleanup?.();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
