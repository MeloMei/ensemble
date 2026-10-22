import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectBackend, type BackendClient } from './backend-client';
import { buildCodexLink } from './codex-link';
import { WorkbenchNotifications } from './notifications';
import { DesktopPreferences } from './preferences';
import { DATA_DIRECTORY_NAME, PRODUCT_NAME } from '../shared/app-identity';
import { initializeI18n, resolveLanguage, setLanguage, translate, type LanguagePreference, type LanguageState } from '../shared/i18n';
import type { UnsavedFileSummary } from '../shared/types';

app.setName(PRODUCT_NAME);
app.setPath('userData', process.env.WORKBENCH_DATA_DIR ?? join(app.getPath('appData'), DATA_DIRECTORY_NAME));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
const root = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let backend: BackendClient;
let notifications: WorkbenchNotifications;
const preferences = new DesktopPreferences(app.getPath('userData'));
let languageState: LanguageState;
let languageUpdates: Promise<void> = Promise.resolve();
interface CloseRequest {
  id: string;
  window: BrowserWindow;
  phase: 'saving' | 'confirming';
  timer?: ReturnType<typeof setTimeout>;
}
let closeRequest: CloseRequest | undefined;
let allowWindowClose = false;
let discardPendingWork = false;
const subscription = new AbortController();
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
    closeRequest = undefined;
    if (close) { allowWindowClose = true; discardPendingWork = discard; request.window.close(); }
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
  for (const command of commands) handle(command, (...args) => backend.call(command, ...args));
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
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    title: PRODUCT_NAME, width: 1380, height: 900, minWidth: 1040, minHeight: 680,
    backgroundColor: '#faf9f7', show: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { preload: join(root, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const currentWindow = window;
  let rendererFailure: string | undefined;
  currentWindow.on('focus', () => {
    void synchronizeLanguage().catch(error => process.stderr.write(`Language preference refresh failed: ${String(error)}\n`));
  });
  allowWindowClose = false;
  discardPendingWork = false;
  currentWindow.on('close', event => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (closeRequest) return;
    const request: CloseRequest = { id: randomUUID(), window: currentWindow, phase: 'saving' };
    closeRequest = request;
    if (rendererFailure || currentWindow.webContents.isDestroyed()) {
      finishCloseRequest(request, rendererFailure ? translate('native:close.rendererStopped', { reason: rendererFailure }) : translate('native:close.rendererUnavailable'));
      return;
    }
    request.timer = setTimeout(() => finishCloseRequest(request, translate('native:close.saveTimeout')), 10_000);
    try { currentWindow.webContents.send('workbench:prepare-close', request.id); }
    catch (error) { finishCloseRequest(request, error instanceof Error ? error.message : String(error)); }
  });
  currentWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererFailure = details.reason;
    if (closeRequest?.window === currentWindow) finishCloseRequest(closeRequest, translate('native:close.rendererStopped', { reason: rendererFailure }));
  });
  currentWindow.webContents.on('will-prevent-unload', event => {
    if (allowWindowClose && discardPendingWork) event.preventDefault();
    else allowWindowClose = false;
  });
  currentWindow.webContents.on('did-finish-load', () => { rendererFailure = undefined; });
  currentWindow.once('ready-to-show', () => currentWindow.show());
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
  notifications = new WorkbenchNotifications(sessionId => {
    window?.show(); window?.focus(); window?.webContents.send('workbench:focus-session', sessionId);
  });
  registerIPC(await backend.request<string[]>('/commands'));
  await createWindow();
  void (async () => {
    while (!subscription.signal.aborted) {
      try {
        await backend.subscribe(snapshot => {
          notifications.observe(snapshot); window?.webContents.send('workbench:changed', snapshot);
        }, subscription.signal);
      } catch (error) {
        if (subscription.signal.aborted) return;
        process.stderr.write(`后台订阅中断：${String(error)}\n`);
      }
      if (subscription.signal.aborted) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
      try { backend = await connectBackend(dataPath, launch); } catch {}
    }
  })();
}).catch(error => {
  dialog.showErrorBox(translate('native:startup.failed', { product: PRODUCT_NAME }), error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
app.on('activate', () => { if (backend && !window) void createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { subscription.abort(); notifications?.dispose(); });
