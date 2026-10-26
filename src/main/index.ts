import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BackendConnectionTracker, connectBackend, type BackendClient } from './backend-client';
import { buildCodexLink } from './codex-link';
import { WorkbenchNotifications } from './notifications';
import { DesktopPreferences } from './preferences';
import { DATA_DIRECTORY_NAME, PRODUCT_NAME } from '../shared/app-identity';
import { initializeI18n, resolveLanguage, setLanguage, translate, type LanguagePreference, type LanguageState } from '../shared/i18n';
import type { Snapshot, UnsavedFileSummary } from '../shared/types';
import type { AppUpdateState } from '../shared/application-updates';
import { ApplicationUpdates } from './application-updates';

app.setName(PRODUCT_NAME);
app.setPath('userData', process.env.WORKBENCH_DATA_DIR ?? join(app.getPath('appData'), DATA_DIRECTORY_NAME));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
const root = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let backend: BackendClient;
let updates: ApplicationUpdates;
let requestUpdateClose: (() => Promise<AppUpdateState>) | undefined;
let rendererReady = false;
let rendererConfirmed = false;
let updateReadyAcknowledged = false;
let quitting = false;
let updatesDisposed = false;
let notifications: WorkbenchNotifications;
const preferences = new DesktopPreferences(app.getPath('userData'));
let languageState: LanguageState;
let languageUpdates: Promise<void> = Promise.resolve();
interface CloseRequest {
  id: string;
  window: BrowserWindow;
  phase: 'saving' | 'confirming';
  intent: 'close' | 'update';
  complete?: (state: AppUpdateState) => void;
  timer?: ReturnType<typeof setTimeout>;
}
let closeRequest: CloseRequest | undefined;
let allowWindowClose = false;
let discardPendingWork = false;
const subscription = new AbortController();
let latestSnapshot: Snapshot | undefined;
let watchedSessions: string[] = [];
const terminalWatches = new Map<string, { controller: AbortController; client: BackendClient }>();
const connection = new BackendConnectionTracker(state => window?.webContents.send('workbench:connection-changed', state));
const cwdSchema = z.string().min(1).max(4096);
const closeReplySchema = z.object({ requestId: z.string().uuid(), error: z.string().nullable(),
  unsavedFiles: z.object({ count: z.number().int().nonnegative(), names: z.array(z.string().max(4400)).max(8) }).strict(),
}).strict();

function synchronizeLanguage(preference?: LanguagePreference): Promise<LanguageState> {
  const update = languageUpdates.then(async () => {
    if (preference !== undefined) await preferences.setLanguagePreference(preference);
    const next: LanguageState = {
      preference: preferences.languagePreference,
      language: resolveLanguage(preferences.languagePreference, app.getPreferredSystemLanguages()),
    };
    if (next.preference !== languageState.preference || next.language !== languageState.language) {
      await setLanguage(next.language);
      languageState = next;
      if (window && !window.isDestroyed()) window.webContents.send('workbench:language-changed', next);
    }
    return { ...languageState };
  });
  languageUpdates = update.then(() => {}, () => {});
  return update;
}

function finishCloseRequest(request: CloseRequest, error: string | null, files?: UnsavedFileSummary): void {
  if (closeRequest !== request || request.phase !== 'saving' || request.window.isDestroyed()) return;
  if (request.timer) clearTimeout(request.timer);
  request.timer = undefined;
  request.phase = 'confirming';
  const decide = (close: boolean, discard = false) => {
    if (closeRequest !== request || request.window.isDestroyed()) return;
    const release = () => {
      if (closeRequest === request) closeRequest = undefined;
      if (!request.window.isDestroyed()) request.window.webContents.send('workbench:release-close-lock');
    };
    if (!close) { release(); request.complete?.(updates.snapshot); return; }
    discardPendingWork = discard;
    if (request.intent === 'update') {
      void updates.install().then(state => { release(); request.complete?.(state); });
    } else { closeRequest = undefined; allowWindowClose = true; request.window.close(); }
  };
  if (error === null && !files?.count) { decide(true); return; }
  const fileWarning = files?.count ? translate('native:close.fileList', { count: files.count, names: files.names.join('\n') })
    + (files.count > files.names.length ? `\n${translate('native:close.moreFiles', { count: files.count - files.names.length })}` : '') : '';
  void dialog.showMessageBox(request.window, {
    type: 'warning', title: translate('native:close.title', { product: PRODUCT_NAME }), message: translate(error !== null ? 'native:close.unsaved' : 'native:close.fileEdits'),
    detail: translate('native:close.detail', { error: [error, fileWarning].filter(Boolean).join('\n\n') }),
    buttons: [translate('native:close.keepWindow'), translate('native:close.quitAnyway')], defaultId: 0, cancelId: 0, noLink: true,
  }).then(result => decide(result.response === 1, result.response === 1), () => decide(false));
}

function registerIPC(commands: string[]): void {
  ipcMain.on('workbench:close-ready', (event, input: unknown) => {
    const reply = closeReplySchema.safeParse(input);
    const request = closeRequest;
    if (!reply.success || !request || window !== request.window
      || event.sender.id !== request.window.webContents.id || reply.data.requestId !== request.id) return;
    finishCloseRequest(request, reply.data.error, reply.data.unsavedFiles);
  });
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender.id !== window.webContents.id) throw new Error(translate('native:error.windowMismatch'));
      return handler(...args);
    });
  };
  for (const command of commands) if (command !== 'workbench:snapshot') handle(command, (...args) => backend.call(command, ...args));
  handle('workbench:snapshot', () => latestSnapshot ?? backend.snapshot());
  handle('workbench:get-connection', () => connection.current);
  handle('workbench:watch-sessions', async input => {
    watchedSessions = z.array(z.string().min(1).max(200)).max(8).parse(input);
    await backend.watchSessions(watchedSessions);
  });
  ipcMain.on('workbench:watch-terminal', (event, input: unknown) => {
    if (!window || event.sender.id !== window.webContents.id) return;
    const id = z.string().min(1).max(200).safeParse(input);
    if (id.success) {
      terminalWatches.get(id.data)?.controller.abort(); terminalWatches.delete(id.data);
      watchTerminal(id.data);
    }
  });
  ipcMain.on('workbench:unwatch-terminal', (event, input: unknown) => {
    if (!window || event.sender.id !== window.webContents.id || typeof input !== 'string') return;
    terminalWatches.get(input)?.controller.abort(); terminalWatches.delete(input);
  });
  handle('workbench:get-language', () => synchronizeLanguage());
  handle('workbench:set-language', input => synchronizeLanguage(z.enum(['system', 'zh-CN', 'en']).parse(input)));
  handle('workbench:choose-directory', async () => {
    const result = await dialog.showOpenDialog(window!, { title: translate('native:dialog.chooseDirectory'), buttonLabel: translate('native:dialog.chooseDirectoryButton'), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('workbench:choose-attachments', async () => {
    const result = await dialog.showOpenDialog(window!, { title: translate('native:dialog.chooseAttachments'), buttonLabel: translate('native:dialog.chooseAttachmentsButton'), properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : backend.call('workbench:import-attachments', result.filePaths);
  });
  handle('workbench:launch-codex', async input => {
    const parsed = z.object({ cwd: cwdSchema, prompt: z.string().max(200_000) }).strict().parse(input);
    const link = buildCodexLink(parsed);
    await shell.openExternal(link); return link;
  });
  handle('workbench:open-plugin-directory', async () => {
    const path = join(app.getPath('userData'), 'plugins');
    await mkdir(path, { recursive: true });
    const error = await shell.openPath(path); if (error) throw new Error(error);
  });
  handle('workbench:notification-status', () => notifications.status());
  handle('workbench:application-update', () => updates.snapshot);
  handle('workbench:check-application-update', () => updates.check());
  handle('workbench:download-application-update', () => updates.download());
  handle('workbench:install-application-update', () => requestUpdateClose?.() ?? updates.snapshot);
  handle('workbench:set-application-update-auto-check', value => updates.setAutoCheck(z.boolean().parse(value)));
  handle('workbench:application-update-ready', () => { rendererConfirmed = true; acknowledgeUpdateReady(); });
}

function acknowledgeUpdateReady(): void {
  if (updateReadyAcknowledged || !rendererReady || !rendererConfirmed || !connection.current.synced) return;
  updateReadyAcknowledged = true;
  void updates.acknowledgeReady().catch(error => process.stderr.write(`更新启动确认失败：${String(error)}\n`));
}

function watchTerminal(id: string): void {
  const controller = new AbortController();
  const watched = { controller, client: backend };
  terminalWatches.set(id, watched);
  void (async () => {
    while (!controller.signal.aborted && !subscription.signal.aborted) {
      watched.client = backend;
      const client = watched.client;
      try {
        await client.subscribeTerminal(id, event => {
          if (!controller.signal.aborted && terminalWatches.get(id) === watched && client === backend) window?.webContents.send('workbench:terminal-output', event);
        }, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) process.stderr.write(`终端订阅中断：${String(error)}\n`);
      }
      if (!controller.signal.aborted && !subscription.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  })();
}

function restoreTerminalWatches(): void {
  for (const [id, watched] of terminalWatches) {
    if (watched.client === backend) continue;
    watched.controller.abort(); terminalWatches.delete(id); watchTerminal(id);
  }
}

function releaseViewSubscriptions(): void {
  watchedSessions = [];
  latestSnapshot = undefined;
  for (const watched of terminalWatches.values()) watched.controller.abort();
  terminalWatches.clear();
  void backend.watchSessions([]).catch(error => process.stderr.write(`会话退订失败：${String(error)}\n`));
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    title: PRODUCT_NAME, width: 1380, height: 900, minWidth: 1040, minHeight: 680,
    backgroundColor: '#faf9f7', show: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { preload: join(root, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const currentWindow = window;
  let rendererFailure: string | undefined;
  rendererReady = false;
  rendererConfirmed = false;
  const prepareClose = (intent: CloseRequest['intent'], complete?: CloseRequest['complete']) => {
    if (closeRequest) { complete?.(updates.snapshot); return; }
    const request: CloseRequest = { id: randomUUID(), window: currentWindow, phase: 'saving', intent, complete };
    closeRequest = request;
    if (rendererFailure || currentWindow.webContents.isDestroyed()) {
      finishCloseRequest(request, rendererFailure ? translate('native:close.rendererStopped', { reason: rendererFailure }) : translate('native:close.rendererUnavailable'));
      return;
    }
    request.timer = setTimeout(() => finishCloseRequest(request, translate('native:close.saveTimeout')), 10_000);
    try { currentWindow.webContents.send('workbench:prepare-close', request.id, intent === 'update' ? 'update' : undefined); }
    catch (error) { finishCloseRequest(request, error instanceof Error ? error.message : String(error)); }
  };
  requestUpdateClose = () => new Promise(resolveClose => {
    if (updates.snapshot.phase !== 'ready') { resolveClose(updates.snapshot); return; }
    prepareClose('update', resolveClose);
  });
  currentWindow.on('focus', () => {
    void synchronizeLanguage().catch(error => process.stderr.write(`Language preference refresh failed: ${String(error)}\n`));
  });
  allowWindowClose = false;
  discardPendingWork = false;
  currentWindow.on('close', event => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (updates.snapshot.phase !== 'installing') prepareClose('close');
  });
  currentWindow.webContents.on('render-process-gone', (_event, details) => {
    releaseViewSubscriptions();
    rendererFailure = details.reason;
    if (closeRequest?.window === currentWindow) finishCloseRequest(closeRequest, translate('native:close.rendererStopped', { reason: rendererFailure }));
  });
  currentWindow.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) releaseViewSubscriptions();
  });
  currentWindow.webContents.on('will-prevent-unload', event => {
    if (allowWindowClose && discardPendingWork) event.preventDefault();
    else allowWindowClose = false;
  });
  currentWindow.webContents.on('did-finish-load', () => { rendererFailure = undefined; });
  currentWindow.once('ready-to-show', () => { rendererReady = true; currentWindow.show(); acknowledgeUpdateReady(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const link = new URL(url);
      if (['https:', 'http:'].includes(link.protocol) && !link.username && !link.password) void shell.openExternal(link.toString());
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  currentWindow.on('closed', () => {
    if (closeRequest?.window === currentWindow) {
      if (closeRequest.timer) clearTimeout(closeRequest.timer);
      closeRequest = undefined;
    }
    if (window === currentWindow) window = null;
    requestUpdateClose = undefined;
    releaseViewSubscriptions();
  });
  if (process.env.WORKBENCH_DEV_URL) await window.loadURL(process.env.WORKBENCH_DEV_URL);
  else await window.loadFile(join(root, '../renderer/index.html'));
}

if (gotLock) void app.whenReady().then(async () => {
  const dataPath = app.getPath('userData');
  await preferences.load();
  languageState = { preference: preferences.languagePreference, language: resolveLanguage(preferences.languagePreference, app.getPreferredSystemLanguages()) };
  await initializeI18n(languageState.language);
  const launch = { command: process.execPath, entryPath: join(root, 'backend-entry.js') };
  backend = await connectBackend(dataPath, launch);
  delete process.env.WORKBENCH_UPDATE_TOKEN;
  backend.assertSnapshotStreaming();
  updates = new ApplicationUpdates({
    currentVersion: app.getVersion(), appPath: app.isPackaged && process.platform === 'darwin' ? await realpath(resolve(process.execPath, '../../..')) : undefined,
    dataPath, arch: process.arch, helperPath: join(root, '../../bin/apply-app-update.sh'),
    getAutoCheck: () => preferences.autoCheckUpdates,
    setAutoCheck: enabled => preferences.setAutoCheckUpdates(enabled),
    publish: state => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('workbench:application-update-changed', state); },
    prepareInstall: async token => { await backend.call('workbench:begin-application-update', token); return backend.endpoint.pid; },
    cancelInstall: token => backend.call<void>('workbench:cancel-application-update', token),
    requestQuit: () => { allowWindowClose = true; window?.close(); },
  });
  await updates.load();
  notifications = new WorkbenchNotifications(sessionId => {
    window?.show(); window?.focus(); window?.webContents.send('workbench:focus-session', sessionId);
  });
  registerIPC(await backend.request<string[]>('/commands'));
  await createWindow();
  updates.schedule();
  void (async () => {
    while (!subscription.signal.aborted) {
      const client = backend;
      const generation = connection.begin(client.endpoint.instanceId);
      try {
        await client.watchSessions(watchedSessions);
        await client.subscribe((snapshot, frame) => {
          if (subscription.signal.aborted || client !== backend || !connection.received(generation, frame)) return;
          latestSnapshot = snapshot;
          acknowledgeUpdateReady();
          notifications.observe(snapshot); window?.webContents.send('workbench:changed', snapshot);
        }, subscription.signal);
        connection.disconnected(generation);
      } catch (error) {
        if (subscription.signal.aborted) return;
        connection.disconnected(generation, error);
        process.stderr.write(`后台订阅中断：${String(error)}\n`);
      }
      if (subscription.signal.aborted) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const next = await connectBackend(dataPath, launch); next.assertSnapshotStreaming();
        backend = next; restoreTerminalWatches();
      } catch {}
    }
  })();
}).catch(error => {
  dialog.showErrorBox(translate('native:startup.failed', { product: PRODUCT_NAME }), error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
app.on('activate', () => { if (!quitting && backend && !window) void createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', event => {
  if (updates && !updatesDisposed) {
    event.preventDefault();
    if (!quitting) {
      quitting = true;
      void updates.dispose().finally(() => { updatesDisposed = true; app.quit(); });
    }
    return;
  }
  subscription.abort(); connection.stop(); notifications?.dispose();
  for (const watched of terminalWatches.values()) watched.controller.abort();
  terminalWatches.clear();
});
