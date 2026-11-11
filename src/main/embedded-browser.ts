import { WebContentsView, session, type BrowserWindow, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { browserFindShortcut, browserUrl, type BrowserBounds, type BrowserCommand, type BrowserState } from '../shared/embedded-browser';
import { localPreviewUrl } from '../shared/draft-evidence';
import type { Workspace } from '../shared/types';

export const browserBoundsSchema = z.object({
  x: z.number().int().min(0).max(100_000), y: z.number().int().min(0).max(100_000),
  width: z.number().int().min(1).max(100_000), height: z.number().int().min(1).max(100_000),
}).strict().nullable();

export const browserCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('back') }).strict(),
  z.object({ action: z.literal('forward') }).strict(),
  z.object({ action: z.literal('reload') }).strict(),
  z.object({ action: z.literal('stop-find') }).strict(),
  z.object({ action: z.literal('find'), text: z.string().min(1).max(256), forward: z.boolean() }).strict(),
  z.object({ action: z.literal('zoom'), change: z.enum(['in', 'out', 'reset']) }).strict(),
]);

interface BrowserTab {
  view: WebContentsView;
  bounds: BrowserBounds | null;
  attached: boolean;
  state: BrowserState;
  query?: string;
  findId?: number;
}

export class EmbeddedBrowsers {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly visibleIds = new Set<string>();
  private browserSession?: Session;
  private paused = 0;

  constructor(private readonly host: BrowserWindow) {
    const refresh = () => this.refresh();
    host.on('blur', refresh).on('focus', refresh).on('show', refresh).on('hide', refresh)
      .on('minimize', refresh).on('restore', refresh).on('resize', refresh);
    host.on('closed', () => {
      this.reset();
      const isolated = this.browserSession;
      isolated?.webRequest.onBeforeRequest((_request, reply) => reply({ cancel: true }));
      void isolated?.clearStorageData().catch(() => {});
    });
  }

  updateTabs(workspaces: Workspace[]): void {
    const existing = new Set<string>();
    this.visibleIds.clear();
    for (const workspace of workspaces) {
      if (workspace.archived) continue;
      for (const tab of workspace.tabs) {
        if (tab.kind !== 'browser') continue;
        existing.add(tab.id);
        if (tab.id === workspace.activeTabId || tab.id === workspace.secondaryTabId) this.visibleIds.add(tab.id);
      }
    }
    for (const [id, tab] of this.tabs) {
      if (!existing.has(id)) this.close(id, tab);
      else if (!this.visibleIds.has(id) && tab.bounds) this.hide(tab);
    }
  }

  layout(id: string, bounds: BrowserBounds | null): BrowserState | undefined {
    if (!bounds || !this.visibleIds.has(id)) {
      const tab = this.tabs.get(id);
      if (tab?.bounds) this.hide(tab);
      return;
    }
    const tab = this.tabs.get(id) ?? this.create(id);
    tab.bounds = bounds;
    this.place(tab);
    return { ...tab.state };
  }

  command(id: string, command: BrowserCommand): boolean {
    const tab = this.tabs.get(id);
    if (!tab || !tab.bounds || !this.visibleIds.has(id)) return false;
    const contents = tab.view.webContents;
    const history = contents.navigationHistory;
    switch (command.action) {
      case 'navigate': {
        const url = this.allowedUrl(command.url);
        if (!url) return false;
        this.stopFind(tab);
        tab.state.url = url.href;
        tab.state.failed = false;
        this.publish(id, tab);
        void contents.loadURL(url.href).catch(() => {});
        break;
      }
      case 'back': if (history.canGoBack()) history.goBack(); break;
      case 'forward': if (history.canGoForward()) history.goForward(); break;
      case 'reload':
        if (tab.state.failed && this.allowedUrl(tab.state.url)) void contents.loadURL(tab.state.url).catch(() => {});
        else if (this.allowedUrl(contents.getURL())) contents.reload();
        break;
      case 'find':
        tab.findId = contents.findInPage(command.text, { forward: command.forward, findNext: tab.query !== command.text });
        tab.query = command.text;
        break;
      case 'stop-find':
        this.stopFind(tab);
        this.publish(id, tab);
        break;
      case 'zoom': {
        const next = command.change === 'reset' ? 100 : tab.state.zoom + (command.change === 'in' ? 10 : -10);
        tab.state.zoom = Math.max(50, Math.min(200, next));
        contents.setZoomFactor(tab.state.zoom / 100);
        this.publish(id, tab);
        break;
      }
    }
    return true;
  }

  async withoutViews<T>(action: () => Promise<T>): Promise<T> {
    this.paused += 1;
    this.refresh();
    try { return await action(); }
    finally { this.paused -= 1; this.refresh(); }
  }

  reset(): void {
    this.visibleIds.clear();
    for (const [id, tab] of this.tabs) this.close(id, tab);
  }

  private allowedUrl(value: string): URL | undefined {
    const url = browserUrl(value);
    if (url && !this.host.isDestroyed() && url.origin !== URL.parse(this.host.webContents.getURL())?.origin) return url;
  }

  private isolatedSession(): Session {
    if (this.browserSession) return this.browserSession;
    const isolated = session.fromPartition(`ensemble-browser-${randomUUID()}`, { cache: false });
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    isolated.setDisplayMediaRequestHandler((_request, reply) => reply({}));
    isolated.on('will-download', event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((request, reply) => {
      const url = URL.parse(request.url);
      const resource = request.resourceType !== 'mainFrame' && request.resourceType !== 'subFrame';
      if (resource && url && (url.protocol === 'blob:' || url.protocol === 'data:')) {
        reply({ cancel: false });
        return;
      }
      if (resource && url && (url.protocol === 'ws:' || url.protocol === 'wss:')) {
        url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
      }
      const destination = url && this.allowedUrl(url.href);
      const initiator = request.initiatorOrigin ?? request.frame?.origin;
      const crossesIntoLoopback = destination && localPreviewUrl(destination.href) && initiator && !localPreviewUrl(initiator);
      reply({ cancel: !destination || Boolean(request.resourceType !== 'mainFrame' && crossesIntoLoopback) });
    });
    this.browserSession = isolated;
    return isolated;
  }

  private create(id: string): BrowserTab {
    const view = new WebContentsView({ webPreferences: {
      session: this.isolatedSession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, disableDialogs: true,
      disableHtmlFullscreenWindowResize: true, zoomMode: 'isolated',
    } });
    const tab: BrowserTab = {
      view, bounds: null, attached: false,
      state: { url: '', loading: false, canGoBack: false, canGoForward: false, zoom: 100, failed: false },
    };
    this.tabs.set(id, tab);
    const contents = view.webContents;
    const blockNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
      if (this.allowedUrl(event.url)) return;
      if (!event.isMainFrame && event.url === 'about:blank') return;
      event.preventDefault();
    };
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-frame-navigate', blockNavigation);
    contents.on('will-redirect', blockNavigation);
    contents.on('will-prevent-unload', event => event.preventDefault());
    contents.on('login', (event, _details, _authInfo, reply) => { event.preventDefault(); reply(); });
    contents.on('before-input-event', (event, input) => {
      if (!tab.attached || input.type !== 'keyDown' || input.isComposing) return;
      if (browserFindShortcut(input.key, input.control, input.meta, input.alt, input.shift)) {
        event.preventDefault();
        this.host.webContents.focus();
        this.host.webContents.send('workbench:browser-find-shortcut', id);
      }
    });
    const publish = () => this.publish(id, tab);
    const syncNavigation = () => {
      const url = this.allowedUrl(contents.getURL());
      if (url) tab.state.url = url.href;
      publish();
    };
    contents.on('did-start-navigation', event => {
      if (!event.isMainFrame || event.isSameDocument) return;
      this.stopFind(tab);
      tab.state.failed = false;
      publish();
    });
    contents.on('did-start-loading', publish);
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', syncNavigation);
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) syncNavigation(); });
    contents.on('did-finish-load', () => {
      contents.setZoomMode('isolated');
      contents.setZoomFactor(tab.state.zoom / 100);
    });
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      if (this.allowedUrl(url)) tab.state.url = url;
      tab.state.failed = true;
      publish();
    });
    contents.on('found-in-page', (_event, result) => {
      if (result.requestId !== tab.findId || !result.finalUpdate) return;
      tab.state.match = { current: result.activeMatchOrdinal, total: result.matches };
      publish();
    });
    contents.on('render-process-gone', () => {
      this.stopFind(tab);
      tab.state.failed = true;
      publish();
    });
    return tab;
  }

  private stopFind(tab: BrowserTab): void {
    if (tab.findId !== undefined) tab.view.webContents.stopFindInPage('clearSelection');
    tab.findId = undefined;
    tab.query = undefined;
    tab.state.match = undefined;
  }

  private publish(id: string, tab: BrowserTab): void {
    const contents = tab.view.webContents;
    if (this.host.isDestroyed() || this.host.webContents.isDestroyed() || contents.isDestroyed()) return;
    tab.state.loading = contents.isLoadingMainFrame();
    tab.state.canGoBack = contents.navigationHistory.canGoBack();
    tab.state.canGoForward = contents.navigationHistory.canGoForward();
    this.host.webContents.send('workbench:browser-state', id, tab.state);
  }

  private refresh(): void { for (const tab of this.tabs.values()) this.place(tab); }

  private place(tab: BrowserTab): void {
    if (this.host.isDestroyed()) return;
    const bounds = tab.bounds;
    if (bounds && !this.paused && this.host.isVisible() && this.host.isFocused() && !this.host.isMinimized()) {
      const { width, height } = this.host.getContentBounds();
      const scale = this.host.webContents.getZoomFactor();
      const x = Math.ceil(bounds.x * scale);
      const y = Math.ceil(bounds.y * scale);
      const right = Math.min(Math.floor((bounds.x + bounds.width) * scale), width);
      const bottom = Math.min(Math.floor((bounds.y + bounds.height) * scale), height);
      const clipped = { x, y, width: right - x, height: bottom - y };
      if (clipped.width > 0 && clipped.height > 0) {
        tab.view.setBounds(clipped);
        if (!tab.attached) this.host.contentView.addChildView(tab.view);
        tab.attached = true;
        return;
      }
    }
    if (tab.attached) this.host.contentView.removeChildView(tab.view);
    tab.attached = false;
  }

  private hide(tab: BrowserTab): void {
    tab.bounds = null;
    this.place(tab);
    this.stopFind(tab);
  }

  private close(id: string, tab: BrowserTab): void {
    this.tabs.delete(id);
    tab.bounds = null;
    this.place(tab);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }
}
