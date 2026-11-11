import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';

const electron = createRequire(import.meta.url)('electron') as string;

test('browser pane navigates, finds, zooms and hides its isolated native view', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-browser-'));
  try {
    await Promise.all([
      build({
        stdin: { resolveDir: resolve('src/renderer'), loader: 'tsx', contents: `
          import { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { BrowserPane } from './BrowserPane';
          import { OverlayProvider } from './overlays';
          import { Modal } from './ui';
          import { TooltipProvider } from './Tooltip';
          import { AppearanceProvider } from './appearance';
          import { I18nextProvider } from 'react-i18next';
          import { i18n } from '../shared/i18n';
          function App() {
            const [tab, setTab] = useState('one');
            const [modal, setModal] = useState(false);
            return <OverlayProvider>
              <button id="modal" onClick={() => setModal(true)}>Modal</button>
              <button id="tab" onClick={() => setTab(tab === 'one' ? 'two' : 'one')}>Switch</button>
              <div style={{display:'flex',width:420,height:350,marginLeft:60}} data-workspace-pane={tab}>
                <BrowserPane key={tab} id={tab} obscured={false} />
              </div>
              {modal && <Modal title="Fixture modal" onClose={() => setModal(false)}><button id="close" onClick={() => setModal(false)}>Close</button></Modal>}
            </OverlayProvider>;
          }
          void i18n.changeLanguage('en').then(() => {
            createRoot(document.getElementById('root')).render(<I18nextProvider i18n={i18n}><AppearanceProvider><TooltipProvider><App /></TooltipProvider></AppearanceProvider></I18nextProvider>);
          });
        ` },
        bundle: true, jsx: 'automatic', platform: 'browser', outfile: join(directory, 'renderer.js'),
      }),
      build({
        entryPoints: [resolve('src/preload/index.ts')], bundle: true, platform: 'node', external: ['electron'],
        outfile: join(directory, 'preload.cjs'),
      }),
      build({
        stdin: { resolveDir: resolve('src/main'), contents: `
          const assert = require('node:assert/strict');
          const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
          const { once } = require('node:events');
          const { createServer } = require('node:http');
          const { setTimeout: delay } = require('node:timers/promises');
          const { EmbeddedBrowsers, browserBoundsSchema, browserCommandSchema } = require('./embedded-browser');
          app.on('window-all-closed', () => {});
          app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
          async function until(check, description) {
            for (let index = 0; index < 160; index++) {
              if (await check()) return;
              await delay(30);
            }
            throw new Error('Timed out: ' + description);
          }
          app.whenReady().then(async () => {
            let secondLoads = 0;
            const server = createServer((request, response) => {
              response.setHeader('content-type', 'text/html');
              if (request.url === '/two') {
                secondLoads++;
                response.end('<title>Second page</title><p>needle</p><p>needle</p>');
              } else {
                response.end('<title>First page</title><a id="next" href="/two">Next</a><a id="popup" href="/two" target="_blank">Popup</a>');
              }
            }).listen(0, '127.0.0.1');
            await once(server, 'listening');
            const address = 'http://127.0.0.1:' + server.address().port;
            const host = new BrowserWindow({ width: 760, height: 520, webPreferences: { sandbox: true, contextIsolation: true,
              preload: ${JSON.stringify(join(directory, 'preload.cjs'))} } });
            const browser = new EmbeddedBrowsers(host);
            const workspaces = ['one', 'two'].map(id => ({ id, tabs: [{id, kind:'browser'}], activeTabId:id }));
            browser.updateTabs(workspaces);
            ipcMain.handle('workbench:browser-layout', (_event, id, bounds) => browser.layout(id, browserBoundsSchema.parse(bounds)));
            ipcMain.handle('workbench:browser-command', (_event, id, command) => browser.command(id, browserCommandSchema.parse(command)));
            host.webContents.on('console-message', event => {
              if (event.level === 'error') console.error(event.message);
            });
            await host.loadFile(${JSON.stringify(join(directory, 'index.html'))});
            host.focus();
            const ui = source => host.webContents.executeJavaScript(source);
            const views = () => host.contentView.children.filter(view => view instanceof WebContentsView);
            await until(() => views().length === 1, 'initial browser view');
            const [view] = views();
            const guest = view.webContents;
            const bounds = await ui('JSON.stringify(document.querySelector(".browser-stage").getBoundingClientRect())').then(JSON.parse);
            const actual = view.getBounds();
            assert.equal(actual.x, Math.ceil(bounds.left));
            assert.equal(actual.y, Math.ceil(bounds.top));
            assert.equal(actual.width, Math.floor(bounds.right) - actual.x);
            assert.equal(actual.height, Math.floor(bounds.bottom) - actual.y);
            assert.notEqual(guest.session, session.defaultSession);
            assert.equal(guest.session.getStoragePath(), null);
            assert.equal(browser.command('one', {action:'navigate', url:'http://example.com'}), false);
            assert.equal(browser.command('one', {action:'navigate', url:'https://user:pass@example.com'}), false);
            assert.equal(browser.command('one', {action:'navigate', url:'file:///private/example'}), false);
            const inputValue = (selector, value) => ui('(() => { const input = document.querySelector(' + JSON.stringify(selector) + ');'
              + 'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,' + JSON.stringify(value) + ');'
              + 'input.dispatchEvent(new Event("input",{bubbles:true})); })()');
            await inputValue('input[inputmode=url]', address + '/one');
            await ui('document.querySelector("input[inputmode=url]").form.requestSubmit()');
            await until(() => guest.getTitle() === 'First page', 'address navigation');
            assert.equal(await guest.executeJavaScript('[typeof window.workbench, typeof window.require].join("/")'), 'undefined/undefined');
            assert.equal(await guest.executeJavaScript('navigator.permissions.query({name:"geolocation"}).then(result => result.state)'), 'denied');
            await guest.executeJavaScript('document.querySelector("#popup").click(); undefined', true);
            assert.equal(BrowserWindow.getAllWindows().length, 1);
            assert.equal(guest.getURL(), address + '/one');
            await guest.executeJavaScript('document.querySelector("#next").click(); undefined', true);
            await until(() => guest.getTitle() === 'Second page', 'page link');
            const click = async label => {
              const element = 'document.querySelector(' + JSON.stringify('button[aria-label="' + label + '"]') + ')';
              await until(() => ui('Boolean(' + element + ' && !' + element + '.disabled)'), 'enabled ' + label);
              await ui(element + '.click()');
            };
            assert.equal(guest.navigationHistory.canGoBack(), true, JSON.stringify(guest.navigationHistory.getAllEntries()));
            await click('Go back');
            await until(() => guest.getTitle() === 'First page', 'back');
            await click('Go forward');
            await until(() => guest.getTitle() === 'Second page', 'forward');
            const beforeReload = secondLoads;
            await click('Reload');
            await until(() => secondLoads > beforeReload && !guest.isLoading(), 'reload');
            guest.focus();
            guest.sendInputEvent({type:'keyDown', keyCode:'F', modifiers:[process.platform === 'darwin' ? 'meta' : 'control']});
            await until(() => ui('document.activeElement?.type === "search"'), 'native find shortcut');
            const find = 'input[type=search]';
            await inputValue(find, 'needle');
            const matches = () => ui('document.querySelector(".browser-matches")?.textContent');
            await until(async () => await matches() === '1 of 2', 'initial match');
            await click('Next match');
            await until(async () => await matches() === '2 of 2', 'next match');
            await click('Previous match');
            await until(async () => await matches() === '1 of 2', 'previous match');
            await ui('document.querySelector(' + JSON.stringify(find) + ').dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
            await until(() => ui('!document.querySelector("input[type=search]")'), 'close find');
            await click('Zoom in');
            await until(() => Math.abs(guest.getZoomFactor() - 1.1) < 0.001, 'zoom in');
            await ui('document.querySelector("#modal").click()');
            await until(() => views().length === 0, 'modal detaches view');
            await ui('document.querySelector("#close").click()');
            await until(() => views().includes(view), 'dismissal restores view');
            await ui('document.querySelector("#tab").click()');
            await until(() => views().length === 1 && views()[0] !== view, 'switch browser tabs');
            const secondGuest = views()[0].webContents;
            await inputValue('input[inputmode=url]', address + '/one');
            await ui('document.querySelector("input[inputmode=url]").form.requestSubmit()');
            await until(() => secondGuest.getTitle() === 'First page', 'second browser tab uses the same origin');
            assert.equal(secondGuest.getZoomFactor(), 1);
            await ui('document.querySelector("#tab").click()');
            await until(() => views().includes(view), 'return to original tab');
            assert.equal(guest.getURL(), address + '/two');
            assert.ok(Math.abs(guest.getZoomFactor() - 1.1) < 0.001);
            await click('Reset zoom (110%)');
            await until(() => guest.getZoomFactor() === 1, 'zoom reset');
            await browser.withoutViews(async () => assert.equal(views().length, 0));
            assert.deepEqual(views(), [view]);
            host.hide();
            await until(() => views().length === 0, 'hidden window detaches view');
            browser.updateTabs([workspaces[1]]);
            await until(() => guest.isDestroyed(), 'tab closure destroys the page');
            server.close();
            host.destroy();
            await until(() => secondGuest.isDestroyed(), 'window closure destroys remaining pages');
            console.log('BROWSER_OK');
            app.quit();
          }).catch(error => { console.error(error); app.exit(1); });
        ` },
        bundle: true, platform: 'node', external: ['electron'], outfile: join(directory, 'main.cjs'),
      }),
      writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>'),
    ]);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [join(directory, 'main.cjs')], { env: environment, timeout: 30_000 });
    assert.match(stdout, /BROWSER_OK/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
