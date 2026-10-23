import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { BackendConnectionTracker } from './backend-client';

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('desktop stream lifecycle did not settle');
}

test('main frame reload and renderer loss release view subscriptions without touching subframes', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) });
  const app = Object.assign(new EventEmitter(), {
    setName: () => {}, setPath: () => {}, getPath: () => '/tmp/ensemble-desktop-stream',
    requestSingleInstanceLock: () => true, quit: () => {}, whenReady: async () => {}, getPreferredSystemLanguages: () => ['en'],
  });
  let window: MockWindow | undefined;
  class MockWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      id: 1, send: () => {}, isDestroyed: () => false, setWindowOpenHandler: () => {},
    });
    constructor() { super(); window = this; }
    async loadFile() {}
    isDestroyed() { return false; }
  }
  const watches: string[][] = [];
  const terminalStreams: { signal: AbortSignal; id: string }[] = [];
  const client = {
    endpoint: { instanceId: 'backend' }, assertSnapshotStreaming: () => {}, request: async () => [],
    watchSessions: async (ids: string[]) => { watches.push([...ids]); },
    subscribe: async (_listener: unknown, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
    subscribeTerminal: async (id: string, _listener: unknown, signal: AbortSignal) => {
      terminalStreams.push({ id, signal });
      return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
  const require = createRequire(import.meta.url);
  const mocks: Record<string, unknown> = {
    electron: { app, BrowserWindow: MockWindow, ipcMain, dialog: {}, shell: {} },
    './backend-client': { BackendConnectionTracker, connectBackend: async () => client },
    './codex-link': { buildCodexLink: () => '' },
    './notifications': { WorkbenchNotifications: class { observe() {} dispose() {} } },
    './preferences': { DesktopPreferences: class { languagePreference = 'system'; async load() {} } },
    '../shared/app-identity': { DATA_DIRECTORY_NAME: 'ensemble', PRODUCT_NAME: 'Ensemble' },
    '../shared/i18n': { initializeI18n: async () => {}, resolveLanguage: () => 'en', setLanguage: async () => {}, translate: (key: string) => key },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: Object.keys(mocks), define: { 'import.meta.url': JSON.stringify(new URL('./index.ts', import.meta.url).href) },
  });
  vm.runInNewContext(bundle.outputFiles[0].text, {
    require: (name: string) => mocks[name] ?? require(name), process,
    setTimeout, clearTimeout, AbortController, console,
  });
  const sender = { sender: { id: 1 } };
  try {
    await until(() => !!window && handlers.has('workbench:watch-sessions'));
    await handlers.get('workbench:watch-sessions')!(sender, ['active-session']);
    ipcMain.emit('workbench:watch-terminal', sender, 'terminal-one');
    await until(() => terminalStreams.length === 1);
    window!.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    window!.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    assert.equal(terminalStreams[0].signal.aborted, false);
    assert.deepEqual(watches.at(-1), ['active-session']);
    window!.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await until(() => terminalStreams[0].signal.aborted);
    assert.deepEqual(watches.at(-1), []);
    ipcMain.emit('workbench:watch-terminal', sender, 'terminal-two');
    await until(() => terminalStreams.length === 2);
    await handlers.get('workbench:watch-sessions')!(sender, ['restored-session']);
    window!.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await until(() => terminalStreams[1].signal.aborted);
    assert.deepEqual(watches.at(-1), []);
    assert.equal(terminalStreams.length, 2);
  } finally { app.emit('will-quit'); }
});
