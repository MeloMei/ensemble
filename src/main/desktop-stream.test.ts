import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { BackendConnectionTracker } from './backend-client';
import type { SnapshotFrame } from '../shared/backend';
import type { Snapshot } from '../shared/types';

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
  const quitCancellations: boolean[] = [];
  let quitCompleted = false;
  let updateDisposals = 0;
  let finishUpdateDisposal!: () => void;
  const updateDisposal = new Promise<void>(resolve => { finishUpdateDisposal = resolve; });
  const startupLink = 'ensemble-notification://session?sessionId=first&reason=approval&revision=12&approvalId=approval-1';
  let lockData: unknown;
  const app = Object.assign(new EventEmitter(), {
    setName: () => {}, setPath: () => {}, getPath: () => '/tmp/ensemble-desktop-stream',
    getVersion: () => '1.0.0', isPackaged: false,
    requestSingleInstanceLock: (data: unknown) => { lockData = data; return true; }, whenReady: async () => {}, getPreferredSystemLanguages: () => ['en'],
    quit: (): void => {
      let cancelled = false;
      app.emit('will-quit', { preventDefault: () => { cancelled = true; } });
      quitCancellations.push(cancelled);
      if (!cancelled) { quitCompleted = true; app.emit('quit'); }
    },
  });
  let window: MockWindow | undefined;
  const focusTargets: unknown[] = [];
  class MockWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      id: 1, send: (channel: string, target: unknown) => { if (channel === 'workbench:focus-session') focusTargets.push(target); },
      isDestroyed: () => false, setWindowOpenHandler: () => {},
    });
    constructor() { super(); window = this; }
    async loadFile() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isVisible() { return true; }
    isFocused() { return true; }
    show() {}
    focus() {}
  }
  const watches: string[][] = [];
  const terminalStreams: { signal: AbortSignal; id: string }[] = [];
  let activeSubscriptions = 0;
  let desktopForeground: boolean | undefined;
  const foregroundUpdates: boolean[] = [];
  const baselines: boolean[] = [];
  let publishSnapshot!: () => void;
  let authorizationRequests = 0;
  let backgroundPreference = false;
  const subscribeUntilAborted = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    activeSubscriptions++;
    try { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
    finally { activeSubscriptions--; }
  };
  const client = {
    endpoint: { instanceId: 'backend' }, backgroundNotifications: true, assertSnapshotStreaming: () => {}, request: async () => [],
    watchSessions: async (ids: string[]) => { watches.push([...ids]); },
    setDesktopForeground: async (foreground: boolean) => { foregroundUpdates.push(foreground); },
    subscribe: async (listener: (snapshot: Snapshot, frame: SnapshotFrame) => void, signal: AbortSignal, options?: { desktopForeground: boolean }) => {
      desktopForeground = options?.desktopForeground;
      const sessions = ['first', 'second'].map(id => ({ id, title: id, providerId: 'fixture', cwd: '/fixture', status: 'idle' as const,
        messages: [], approvals: [], createdAt: '', updatedAt: '' }));
      const snapshot: Snapshot = { version: 1, sessions, providers: [], workspaces: [], workflows: [], terminals: [],
        dataPath: '/fixture', pluginPath: '/fixture/plugins', pluginErrors: [] };
      let revision = 0;
      publishSnapshot = () => listener(snapshot, { type: 'reset', instanceId: 'backend', revision: revision++, subscriptionId: 'desktop', snapshot });
      publishSnapshot();
      return subscribeUntilAborted(signal);
    },
    subscribeTerminal: async (id: string, _listener: unknown, signal: AbortSignal) => {
      terminalStreams.push({ id, signal });
      return subscribeUntilAborted(signal);
    },
  };
  const require = createRequire(import.meta.url);
  const mocks: Record<string, unknown> = {
    electron: { app, BrowserWindow: MockWindow, ipcMain, dialog: {}, globalShortcut: { unregister: () => {} }, shell: {} },
    './backend-client': { BackendConnectionTracker, connectBackend: async () => client },
    './codex-link': { buildCodexLink: () => '' },
    './notifications': { WorkbenchNotifications: class {
      observe(_snapshot: Snapshot, baseline: boolean) { baselines.push(baseline); }
      dispose() {}
    } },
    './mac-notification-helper': { bundledMacNotificationHelper: () => ({
      async status() { return authorizationRequests ? 'authorized' : 'not-determined'; },
      async authorize() { authorizationRequests++; return 'authorized'; },
    }) },
    './preferences': { DesktopPreferences: class {
      languagePreference = 'system';
      async load() {}
      async setLanguagePreference() {}
      get notificationPreferences() { return { enabled: true, afterQuit: backgroundPreference }; }
      async setNotificationPreferences(patch: { afterQuit: boolean }) { backgroundPreference = patch.afterQuit; }
    } },
    './application-updates': { ApplicationUpdates: class {
      async load() {}
      async acknowledgeReady() {}
      schedule() {}
      dispose() { updateDisposals++; return updateDisposal; }
    } },
    '../shared/app-identity': { DATA_DIRECTORY_NAME: 'ensemble', PRODUCT_NAME: 'Ensemble' },
    '../shared/i18n': { initializeI18n: async () => {}, resolveLanguage: () => 'en', setLanguage: async () => {}, translate: (key: string) => key },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: Object.keys(mocks), define: { 'import.meta.url': JSON.stringify(new URL('./index.ts', import.meta.url).href) },
  });
  const sender = { sender: { id: 1 }, senderFrame: { parent: null } };
  const openURL = (value: string) => {
    let prevented = false;
    app.emit('open-url', { preventDefault: () => { prevented = true; } }, value);
    assert.equal(prevented, true);
  };
  try {
    const fixtureProcess = Object.create(process);
    Object.defineProperty(fixtureProcess, 'argv', { value: [process.execPath, `--ensemble-notification=${startupLink}`] });
    vm.runInNewContext(bundle.outputFiles[0].text, {
      require: (name: string) => mocks[name] ?? require(name), process: fixtureProcess,
      setTimeout, clearTimeout, AbortController, console,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(lockData)), { notificationLink: startupLink });
    await until(() => !!window && handlers.has('workbench:watch-sessions'));
    await until(() => desktopForeground === true);
    window!.emit('ready-to-show');
    assert.deepEqual(focusTargets, [], 'A cold-start link was sent before the renderer subscribed.');
    await handlers.get('workbench:application-update-ready')!(sender);
    assert.deepEqual(JSON.parse(JSON.stringify(focusTargets)), [
      { sessionId: 'first', reason: 'approval', revision: 12, approvalId: 'approval-1' },
    ]);
    for (const malformed of [
      'ensemble-notification://session?sessionId=first&reason=approval&revision=12&approvalId=approval-1&command=approve',
      'ensemble-notification://session?sessionId=first&sessionId=second&reason=failure',
      'ensemble-notification://session?sessionId=first&reason=failure&revision=9007199254740993',
      'ensemble-notification://session?sessionId=first&reason=result&messageId=%ff',
      'ensemble-notification://session?sessionId=first&reason=result&approvalId=approval-1',
      'ensemble-notification://session?sessionId=other-profile&reason=result',
    ]) openURL(malformed);
    assert.equal(focusTargets.length, 1);
    const secondLink = 'ensemble-notification://session?sessionId=second&reason=result&messageId=turn%3Amsg%2B1';
    app.emit('second-instance', {}, ['path', '--other-argument'], '/fixture', { notificationLink: secondLink });
    assert.deepEqual(JSON.parse(JSON.stringify(focusTargets[1])), { sessionId: 'second', reason: 'result', messageId: 'turn:msg+1' });
    app.emit('second-instance', {}, ['path', `--ensemble-notification=${startupLink}`], '/fixture');
    assert.equal(focusTargets.length, 3);
    window!.emit('blur'); window!.emit('hide'); window!.emit('focus');
    assert.deepEqual(foregroundUpdates.slice(-3), [false, false, true]);
    const backgroundStatus = handlers.get('workbench:background-notification-status')!;
    const configureBackground = handlers.get('workbench:set-background-notifications')!;
    assert.throws(() => configureBackground({ ...sender, senderFrame: { parent: {} } }, true), /windowMismatch/);
    assert.throws(() => configureBackground({ ...sender, sender: { id: 2 } }, true), /windowMismatch/);
    client.backgroundNotifications = false;
    assert.equal(await backgroundStatus(sender), 'backend-unsupported');
    await configureBackground(sender, true);
    assert.equal(authorizationRequests, 0);
    assert.equal(backgroundPreference, false);
    client.backgroundNotifications = true;
    assert.equal(await backgroundStatus(sender), 'not-determined');
    assert.equal(authorizationRequests, 0);
    assert.equal(backgroundPreference, false);
    await configureBackground(sender, true);
    assert.equal(backgroundPreference, true);
    assert.equal(authorizationRequests, 1);
    publishSnapshot();
    assert.equal(baselines.at(-1), true, 'When the backend sends notifications, the desktop should only refresh its baseline.');
    await configureBackground(sender, false);
    assert.equal(backgroundPreference, false);
    assert.equal(authorizationRequests, 1);
    publishSnapshot();
    assert.equal(baselines.at(-1), false, 'Opting out should resume Electron notifications.');
    const dictationStatus = handlers.get('workbench:dictation-status')!;
    assert.throws(() => dictationStatus({ ...sender, senderFrame: { parent: {} } }), /windowMismatch/);
    assert.equal((dictationStatus(sender) as { unavailable: string }).unavailable, process.platform === 'darwin' ? 'helperMissing' : 'platform');
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
    openURL(secondLink);
    assert.equal(focusTargets.length, 3);
    publishSnapshot();
    assert.equal(focusTargets.length, 3);
    await handlers.get('workbench:application-update-ready')!(sender);
    assert.equal(focusTargets.length, 4, 'open-url should wait for the new renderer after a reload.');
    ipcMain.emit('workbench:watch-terminal', sender, 'terminal-two');
    await until(() => terminalStreams.length === 2);
    await handlers.get('workbench:watch-sessions')!(sender, ['restored-session']);
    window!.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await until(() => terminalStreams[1].signal.aborted);
    assert.deepEqual(watches.at(-1), []);
    assert.equal(terminalStreams.length, 2);
  } finally {
    app.quit();
    finishUpdateDisposal();
    await until(() => quitCompleted && activeSubscriptions === 0);
  }
  assert.equal(updateDisposals, 1);
  assert.deepEqual(quitCancellations, [true, false]);
});
