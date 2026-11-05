import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const electronPath = createRequire(import.meta.url)('electron') as string;
const selectedCases = process.env.ENSEMBLE_RENDERER_CASES?.split(',').filter(Boolean);

interface Result { name: string; error?: string }

test('actual renderer components preserve approval, draft, recovery and settings boundaries', { timeout: 120_000 }, async context => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ensemble-renderer-'));
  try {
    await build({
      entryPoints: [path.resolve('src/renderer/renderer-regressions.fixture.tsx')], outfile: path.join(directory, 'fixture.js'),
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'file', '.svg': 'file' },
      plugins: [{ name: 'layout-worker', setup(builder) {
        builder.onResolve({ filter: /elk-worker\.min\.js\?worker$/ }, () => ({ path: path.resolve('node_modules/elkjs/lib/elk-worker.min.js'), namespace: 'layout-worker' }));
        builder.onLoad({ filter: /.*/, namespace: 'layout-worker' }, async args => {
          await build({ entryPoints: [args.path], outfile: path.join(directory, 'layout-worker.js'), bundle: true, platform: 'browser' });
          return { contents: 'export default class extends Worker { constructor() { super(new URL("layout-worker.js", window.location.href)); } }', loader: 'js' };
        });
      } }, { name: 'controlled-editor', setup(builder) {
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
        if (${JSON.stringify(process.env.ENSEMBLE_REDUCED_MOTION === '1')}) {
          window.webContents.debugger.attach('1.3');
          await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
        }
        const prefixes = ${JSON.stringify(selectedCases ?? null)};
        const names = await window.webContents.executeJavaScript('window.rendererRegressionNames');
        const results = [];
        for (const name of names) {
          if (prefixes && !prefixes.some(prefix => name.startsWith(prefix))) continue;
          console.log('RENDERER_CASE=' + name);
          const result = await window.webContents.executeJavaScript('window.runRendererRegressions(' + JSON.stringify([name]) + ')');
          if (result.length !== 1 || result[0].name !== name) throw new Error('Unexpected renderer result for ' + name);
          results.push(result[0]);
        }
        console.log('RENDERER_RESULTS=' + JSON.stringify(results));
        window.destroy(); app.quit();
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.signal]);
    let phase = 'Electron startup';
    let timeoutError: Error | undefined;
    const expire = () => {
      timeoutError = new Error(`Renderer timed out during ${phase}`);
      controller.abort();
    };
    let timer = setTimeout(expire, 25_000);
    const execution = promisify(execFile)(electronPath, [path.join(directory, 'main.cjs')], { env: environment, signal });
    const closed = new Promise<void>(resolve => execution.child.once('close', () => resolve()));
    const lines = createInterface({ input: execution.child.stdout! });
    lines.on('line', line => {
      if (!line.startsWith('RENDERER_CASE=')) return;
      phase = line.slice('RENDERER_CASE='.length);
      clearTimeout(timer);
      timer = setTimeout(expire, 15_000);
    });
    let stdout: string;
    try { ({ stdout } = await execution); }
    catch (error) { throw timeoutError ?? error; }
    finally {
      clearTimeout(timer); lines.close();
      const forceStop = signal.aborted ? setTimeout(() => execution.child.kill('SIGKILL'), 2000) : undefined;
      await closed;
      clearTimeout(forceStop);
    }
    if (timeoutError) throw timeoutError;
    const line = stdout.split('\n').find(value => value.startsWith('RENDERER_RESULTS='));
    assert.ok(line, 'Electron did not return the component assertions');
    const results = JSON.parse(line.slice('RENDERER_RESULTS='.length)) as Result[];
    assert.ok(results.length > 0, 'No renderer cases matched');
    if (selectedCases) for (const selected of selectedCases) assert.ok(results.some(result => result.name.startsWith(selected)), `Missing renderer case ${selected}`);
    for (const result of results) await context.test(result.name, () => assert.equal(result.error, undefined, result.error));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
