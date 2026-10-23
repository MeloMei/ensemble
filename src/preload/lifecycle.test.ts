import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { WorkbenchAPI } from '../shared/types';

async function loadPreload() {
  const calls: unknown[][] = [];
  const ipcRenderer = Object.assign(new EventEmitter(), {
    invoke: async (...args: unknown[]) => { calls.push(args); },
    send: () => {},
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
    window: { addEventListener: () => {} }, structuredClone, setTimeout, clearTimeout,
  });
  assert.ok(api);
  return { api, calls };
}

test('preload blocks worktree removal until file edits are saved or discarded', async () => {
  const { api, calls } = await loadPreload();
  api.setUnsavedFiles({ count: 1, names: ['pending.ts'] });
  await assert.rejects(api.removeWorktree('managed'), /WORKBENCH_UNSAVED_FILES/);
  assert.deepEqual(calls, []);
  api.setUnsavedFiles({ count: 0, names: [] });
  await api.removeWorktree('managed');
  assert.deepEqual(calls, [['workbench:remove-worktree', 'managed']]);
});

test('preload preserves the observed attempt when forwarding Stop', async () => {
  const { api, calls } = await loadPreload();
  await api.cancelSession('session', 'stop-command', 'observed-attempt');
  assert.deepEqual(calls, [['workbench:cancel-session', 'session', 'stop-command', 'observed-attempt']]);
});
