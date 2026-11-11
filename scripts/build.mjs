import { build } from 'esbuild';

const backendBuilds = [
  build({ entryPoints: ['src/main/cli.ts'], outfile: 'dist/main/cli.js', bundle: true, platform: 'node', format: 'esm', sourcemap: true }),
  build({ entryPoints: ['src/main/backend-entry.ts'], outfile: 'dist/main/backend-entry.js', bundle: true, platform: 'node', format: 'esm', packages: 'external', sourcemap: true }),
  build({ entryPoints: ['src/main/mcp-stdio.ts'], outfile: 'dist/main/mcp-stdio.cjs', bundle: true, platform: 'node', format: 'cjs', sourcemap: true }),
];

await Promise.all(process.argv.includes('--headless') ? backendBuilds : [...backendBuilds,
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', bundle: true, platform: 'node', format: 'esm', packages: 'external', sourcemap: true }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  import('vite').then(vite => vite.build()),
]);
