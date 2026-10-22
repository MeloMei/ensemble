import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectBackend, type BackendClient } from './backend-client';
import { buildCodexLink } from './codex-link';
import { WorkbenchNotifications } from './notifications';
import { DATA_DIRECTORY_NAME, PRODUCT_NAME } from '../shared/app-identity';

app.setName(PRODUCT_NAME);
app.setPath('userData', process.env.WORKBENCH_DATA_DIR ?? join(app.getPath('appData'), DATA_DIRECTORY_NAME));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
const root = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let backend: BackendClient;
let notifications: WorkbenchNotifications;
interface CloseRequest {
  id: string;
  window: BrowserWindow;
  phase: 'saving' | 'confirming';
  timer?: ReturnType<typeof setTimeout>;
}
let closeRequest: CloseRequest | undefined;
let allowWindowClose = false;
const subscription = new AbortController();
const cwdSchema = z.string().min(1).max(4096);
const closeReplySchema = z.object({ requestId: z.string().uuid(), error: z.string().nullable() }).strict();

function finishCloseRequest(request: CloseRequest, error: string | null): void {
  if (closeRequest !== request || request.phase !== 'saving' || request.window.isDestroyed()) return;
  if (request.timer) clearTimeout(request.timer);
  request.timer = undefined;
  request.phase = 'confirming';
  const decide = (close: boolean) => {
    if (closeRequest !== request || request.window.isDestroyed()) return;
    closeRequest = undefined;
    if (close) { allowWindowClose = true; request.window.close(); }
  };
  if (error === null) { decide(true); return; }
  void dialog.showMessageBox(request.window, {
    type: 'warning', title: `关闭 ${PRODUCT_NAME}`, message: '草稿尚未确认保存',
    detail: `${error}\n\n选择“仍然退出”可能丢失尚未保存的文字和附件。保留窗口后可以再次尝试关闭。`,
    buttons: ['保留窗口', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true,
  }).then(result => decide(result.response === 1), () => decide(false));
}

function registerIPC(commands: string[]): void {
  ipcMain.on('workbench:close-ready', (event, input: unknown) => {
    const reply = closeReplySchema.safeParse(input);
    const request = closeRequest;
    if (!reply.success || !request || window !== request.window
      || event.sender.id !== request.window.webContents.id || reply.data.requestId !== request.id) return;
    finishCloseRequest(request, reply.data.error);
  });
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender.id !== window.webContents.id) throw new Error('请求不属于当前工作台窗口。');
      return handler(...args);
    });
  };
  for (const command of commands) handle(command, (...args) => backend.call(command, ...args));
  handle('workbench:choose-directory', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择项目目录', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('workbench:choose-attachments', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '添加图片或文本文件', properties: ['openFile', 'multiSelections'] });
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
  allowWindowClose = false;
  currentWindow.on('close', event => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (closeRequest) return;
    const request: CloseRequest = { id: randomUUID(), window: currentWindow, phase: 'saving' };
    closeRequest = request;
    if (rendererFailure || currentWindow.webContents.isDestroyed()) {
      finishCloseRequest(request, rendererFailure ?? '界面已停止，无法确认草稿是否保存。');
      return;
    }
    request.timer = setTimeout(() => finishCloseRequest(request, '等待草稿保存超过 10 秒，尚未收到确认。'), 10_000);
    try { currentWindow.webContents.send('workbench:prepare-close', request.id); }
    catch (error) { finishCloseRequest(request, error instanceof Error ? error.message : String(error)); }
  });
  currentWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererFailure = `界面进程已停止（${details.reason}），无法确认草稿是否保存。`;
    if (closeRequest?.window === currentWindow) finishCloseRequest(closeRequest, rendererFailure);
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
  dialog.showErrorBox(`${PRODUCT_NAME} 启动失败`, error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
app.on('activate', () => { if (backend && !window) void createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { subscription.abort(); notifications?.dispose(); });
