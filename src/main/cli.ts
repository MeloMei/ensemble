import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { connectBackend } from './backend-client';
import { DATA_DIRECTORY_NAME } from '../shared/app-identity';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'data-dir': { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' },
  output: { type: 'string' }, providers: { type: 'string' },
} });
const dataPath = values['data-dir'] ?? process.env.WORKBENCH_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', DATA_DIRECTORY_NAME);
const backend = await connectBackend(dataPath, { command: process.execPath, entryPath: join(dirname(process.argv[1]), 'backend-entry.js') });
const action = positionals[0] ?? 'status';
let result: unknown;
if (action === 'connect') {
  if (!values.name || !values.cwd) throw new Error('connect 需要 --name 和 --cwd。');
  result = await backend.call('workbench:collaboration-call', 'issue_identity', {
    name: values.name, policy: { createRuns: true, workspaceRoots: [values.cwd], ...(values.providers ? { providerIds: values.providers.split(',').filter(Boolean) } : {}) },
  });
} else if (action === 'revoke') {
  if (!positionals[1]) throw new Error('revoke 需要连接 ID。');
  await backend.call('workbench:collaboration-call', 'revoke_identity', { identityId: positionals[1] }); result = { revoked: positionals[1] };
} else if (action === 'stop') {
  process.kill(backend.endpoint.pid, 'SIGTERM'); result = { stopping: true };
} else if (action === 'status') {
  result = { pid: backend.endpoint.pid, startedAt: backend.endpoint.startedAt, url: backend.endpoint.url };
} else throw new Error('支持 status、connect、revoke、stop。');
const content = JSON.stringify(result, null, 2) + '\n';
if (values.output) await writeFile(values.output, content, { mode: 0o600, flag: 'wx' });
else process.stdout.write(content);
