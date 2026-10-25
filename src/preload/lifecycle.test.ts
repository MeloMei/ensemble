import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { WorkbenchAPI } from '../shared/types';

async function loadPreload() {
  const calls: unknown[][] = [];
  const sent: unknown[][] = [];
  const browserEvents = new Map<string, (event: { preventDefault: () => void; returnValue: string }) => void>();
  const ipcRenderer = Object.assign(new EventEmitter(), {
    invoke: async (...args: unknown[]) => { calls.push(args); },
    send: (...args: unknown[]) => { sent.push(args); },
  });
  let api: WorkbenchAPI | undefined;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
  });
  vm.runInNewContext(bundle.outputFiles[0].text, {
    require: (name: string) => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (_key: string, value: WorkbenchAPI) => { api = value; } } };
    },
    window: { addEventListener: (name: string, listener: (event: { preventDefault: () => void; returnValue: string }) => void) => { browserEvents.set(name, listener); } }, structuredClone, setTimeout, clearTimeout,
  });
  assert.ok(api);
  return { api, calls, sent, ipcRenderer, browserEvents };
}

test('preload aggregates file and tool drafts for native close and blocks worktree removal until all edits are resolved', async () => {
  const { api, calls, sent, ipcRenderer, browserEvents } = await loadPreload();
  api.setUnsavedFiles({ count: 1, names: ['pending.ts'] });
  api.setUnsavedFiles({ count: 2, names: ['Project · Skill review', 'Project · MCP'] }, 'workspace-tools:project');
  let prevented = false;
  browserEvents.get('beforeunload')!({ preventDefault: () => { prevented = true; }, returnValue: '' });
  assert.equal(prevented, true);
  ipcRenderer.emit('workbench:prepare-close', {}, 'close-request');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['workbench:close-ready', {
    requestId: 'close-request', error: null, unsavedFiles: { count: 3, names: ['pending.ts', 'Project · Skill review', 'Project · MCP'] },
  }]]);
  await assert.rejects(api.removeWorktree('managed'), /WORKBENCH_UNSAVED_FILES/);
  assert.deepEqual(calls, []);
  api.setUnsavedFiles({ count: 0, names: [] });
  await assert.rejects(api.removeWorktree('managed'), /WORKBENCH_UNSAVED_FILES/);
  assert.deepEqual(calls, []);
  api.setUnsavedFiles({ count: 0, names: [] }, 'workspace-tools:project');
  prevented = false;
  browserEvents.get('beforeunload')!({ preventDefault: () => { prevented = true; }, returnValue: '' });
  assert.equal(prevented, false);
  await api.removeWorktree('managed');
  assert.deepEqual(calls, [['workbench:remove-worktree', 'managed']]);
});

test('preload preserves the observed attempt when forwarding Stop', async () => {
  const { api, calls } = await loadPreload();
  await api.cancelSession('session', 'stop-command', 'observed-attempt');
  assert.deepEqual(calls, [['workbench:cancel-session', 'session', 'stop-command', 'observed-attempt']]);
});
