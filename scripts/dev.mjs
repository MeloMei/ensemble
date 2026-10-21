import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

await Promise.all([
  build({ entryPoints: ['src/main/cli.ts'], outfile: 'dist/main/cli.js', bundle: true, platform: 'node', format: 'esm', sourcemap: true }),
  build({ entryPoints: ['src/main/backend-entry.ts'], outfile: 'dist/main/backend-entry.js', bundle: true, platform: 'node', format: 'esm', external: ['@lydell/node-pty', '@modelcontextprotocol/sdk'], sourcemap: true }),
  build({ entryPoints: ['src/main/mcp-stdio.ts'], outfile: 'dist/main/mcp-stdio.cjs', bundle: true, platform: 'node', format: 'cjs', sourcemap: true }),
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', bundle: true, platform: 'node', format: 'esm', external: ['electron', '@lydell/node-pty'], sourcemap: true }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
]);
const server = await createServer();
await server.listen();
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, WORKBENCH_DEV_URL: 'http://127.0.0.1:5186' } });
const shutdown = async () => { child.kill(); await server.close(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', async code => { await server.close(); process.exitCode = code ?? 0; });
