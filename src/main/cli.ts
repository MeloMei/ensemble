import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { connectBackend } from './backend-client';
import { daemonCommand } from './backend-daemon';
import { DATA_DIRECTORY_NAME } from '../shared/app-identity';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'data-dir': { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' },
  output: { type: 'string' }, providers: { type: 'string' },
} });
const stateHome = process.env.XDG_STATE_HOME;
const defaultDataPath = process.platform === 'linux'
  ? join(stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), '.local', 'state'), 'ensemble')
  : join(homedir(), 'Library', 'Application Support', DATA_DIRECTORY_NAME);
const dataPath = values['data-dir'] ?? process.env.WORKBENCH_DATA_DIR ?? defaultDataPath;
const launch = { command: process.execPath, entryPath: join(dirname(process.argv[1]), 'backend-entry.js') };

async function run(action: string): Promise<unknown> {
  if (action === 'daemon') return daemonCommand(positionals[1] ?? 'status', dataPath, launch);
  if (!['connect', 'revoke', 'stop', 'status'].includes(action)) throw new Error('支持 status、connect、revoke、stop、daemon。');
  const backend = await connectBackend(dataPath, action === 'stop' ? undefined : launch);
  if (action === 'connect') {
    if (!values.name || !values.cwd) throw new Error('connect 需要 --name 和 --cwd。');
    return backend.call('workbench:collaboration-call', 'issue_identity', {
      name: values.name, policy: { createRuns: true, workspaceRoots: [values.cwd], ...(values.providers ? { providerIds: values.providers.split(',').filter(Boolean) } : {}) },
    });
  }
  if (action === 'revoke') {
    if (!positionals[1]) throw new Error('revoke 需要连接 ID。');
    await backend.call('workbench:collaboration-call', 'revoke_identity', { identityId: positionals[1] });
    return { revoked: positionals[1] };
  }
  if (action === 'stop') {
    if (backend.endpoint.managedService) throw new Error('后台由服务管理。请运行 workbench daemon stop。');
    process.kill(backend.endpoint.pid, 'SIGTERM');
    return { stopping: true };
  }
  return { pid: backend.endpoint.pid, startedAt: backend.endpoint.startedAt, url: backend.endpoint.url };
}

try {
  const content = JSON.stringify(await run(positionals[0] ?? 'status'), null, 2) + '\n';
  if (values.output) await writeFile(values.output, content, { mode: 0o600, flag: 'wx' });
  else process.stdout.write(content);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
