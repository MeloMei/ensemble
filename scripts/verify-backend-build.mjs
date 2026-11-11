import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dataPath = await mkdtemp(join(tmpdir(), 'ensemble-built-backend-'));
const entry = fileURLToPath(new URL('../dist/main/backend-entry.js', import.meta.url));
const backend = spawn(process.execPath, [entry, '--data-dir', dataPath], { stdio: ['ignore', 'inherit', 'inherit'] });
let ended = false;
const done = new Promise(resolve => {
  backend.once('close', (code, signal) => { ended = true; resolve(code ?? signal); });
});
backend.on('error', error => process.stderr.write(`${error.message}\n`));

try {
  const deadline = Date.now() + 10000;
  let healthy = false;
  let backgroundNotifications;
  while (!ended && Date.now() < deadline) {
    try {
      const endpoint = JSON.parse(await readFile(join(dataPath, 'backend.json'), 'utf8'));
      const response = await fetch(`${endpoint.url}/health`, {
        headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(1000),
      });
      const health = await response.json();
      if (response.ok && health.ready && health.instanceId === endpoint.instanceId) {
        backgroundNotifications = health.backgroundNotifications;
        healthy = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!healthy) throw new Error('The built backend did not become healthy.');
  if (backgroundNotifications !== false) throw new Error('A source backend unexpectedly advertised the macOS notification helper.');
  process.stdout.write('The built backend started and answered an authenticated health check.\n');
} finally {
  if (!ended) backend.kill('SIGTERM');
  const forceStop = setTimeout(() => { if (!ended) backend.kill('SIGKILL'); }, 5000);
  try { await done; }
  finally { clearTimeout(forceStop); await rm(dataPath, { recursive: true, force: true }); }
}
