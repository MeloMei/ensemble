import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const electronPath = createRequire(import.meta.url)('electron') as string;
const selectedCases = process.env.ENSEMBLE_RENDERER_CASES?.split(',').filter(Boolean);

interface Result { name: string; error?: string }

test('actual renderer components preserve approval, draft, recovery and settings boundaries', { timeout: 30_000 }, async context => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ensemble-renderer-'));
  try {
    await build({
      entryPoints: [path.resolve('src/renderer/renderer-regressions.fixture.tsx')], outfile: path.join(directory, 'fixture.js'),
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'file', '.svg': 'file' },
      plugins: [{ name: 'controlled-editor', setup(builder) {
        builder.onLoad({ filter: /[/\\]CodeEditor\.tsx$/ }, () => ({ contents: 'export function CodeEditor({value, onChange, readOnly}) { return <textarea data-test-editor value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />; }', loader: 'tsx' }));
      } }],
    });
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><script src="fixture.js"></script>');
    await writeFile(path.join(directory, 'main.cjs'), `
      const {app, BrowserWindow} = require('electron');
      app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
      app.whenReady().then(async () => {
        const window = new BrowserWindow({show: false, webPreferences: {contextIsolation: true, sandbox: true}});
        await window.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
        const results = await window.webContents.executeJavaScript(${JSON.stringify(`window.runRendererRegressions(${JSON.stringify(selectedCases ?? null)})`)});
        console.log('RENDERER_RESULTS=' + JSON.stringify(results));
        window.destroy(); app.quit();
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electronPath, [path.join(directory, 'main.cjs')], { env: environment, timeout: 25_000 });
    const line = stdout.split('\n').find(value => value.startsWith('RENDERER_RESULTS='));
    assert.ok(line, 'Electron did not return the component assertions');
    const results = JSON.parse(line.slice('RENDERER_RESULTS='.length)) as Result[];
    assert.ok(results.length > 0, 'No renderer cases matched');
    if (selectedCases) for (const selected of selectedCases) assert.ok(results.some(result => result.name.startsWith(selected)), `Missing renderer case ${selected}`);
    for (const result of results) await context.test(result.name, () => assert.equal(result.error, undefined, result.error));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
