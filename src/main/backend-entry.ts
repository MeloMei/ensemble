import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend } from './backend-server';

const index = process.argv.indexOf('--data-dir');
const dataPath = index >= 0 ? process.argv[index + 1] : process.env.WORKBENCH_DATA_DIR;
if (!dataPath) throw new Error('后台需要数据目录。');
const root = dirname(fileURLToPath(import.meta.url));
const backend = await startBackend({ dataPath, command: process.execPath, bridgePath: join(root, 'mcp-stdio.cjs') }).catch(error => {
  process.stderr.write(`${String(error)}\n`);
  const code = (error as { cause?: { errcode?: number }; errcode?: number }).cause?.errcode ?? error.errcode;
  process.exit(code === 5 || code === 6 ? 75 : 1);
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void backend.close().then(() => process.exit(0), error => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
