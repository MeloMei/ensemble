import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
const subscription = new AbortController();
const cwdSchema = z.string().min(1).max(4096);

function registerIPC(commands: string[]): void {
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
  window.once('ready-to-show', () => window?.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const link = new URL(url);
      if (['https:', 'http:'].includes(link.protocol) && !link.username && !link.password) void shell.openExternal(link.toString());
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => { window = null; });
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
app.on('before-quit', () => { subscription.abort(); notifications?.dispose(); });
