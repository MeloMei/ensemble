import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

await Promise.all([
  build({ entryPoints: ['src/main/cli.ts'], outfile: 'dist/main/cli.js', bundle: true, platform: 'node', format: 'esm', sourcemap: true }),
  build({ entryPoints: ['src/main/backend-entry.ts'], outfile: 'dist/main/backend-entry.js', bundle: true, platform: 'node', format: 'esm', external: ['@lydell/node-pty', '@modelcontextprotocol/sdk'], sourcemap: true }),
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', bundle: true, platform: 'node', format: 'esm', external: ['electron', '@lydell/node-pty', '@modelcontextprotocol/sdk', 'semver', 'extract-zip', 'yauzl'], sourcemap: true }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/main/mcp-stdio.ts'], outfile: 'dist/main/mcp-stdio.cjs', bundle: true, platform: 'node', format: 'cjs', sourcemap: true }),
  viteBuild(),
]);
