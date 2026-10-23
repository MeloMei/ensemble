import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileContent, UnsavedFileSummary } from '../shared/types';
import { FileDraftStore } from './file-drafts';

const file: FileContent = { path: 'notes.txt', content: 'original', size: 8, language: 'text', revision: 'initial' };

test('file draft close warnings cover every workspace and clear only when its edits are resolved', () => {
  let summary: UnsavedFileSummary = { count: 0, names: [] };
  const drafts = new FileDraftStore(value => { summary = value; });
  drafts.open({ id: 'first', name: 'First project' }, file, undefined);
  drafts.edit('first', file.path, 'unsaved first');
  drafts.open({ id: 'second', name: 'Second project' }, file, undefined);
  drafts.edit('second', file.path, 'unsaved second');
  assert.deepEqual(summary, { count: 2, names: ['First project · notes.txt', 'Second project · notes.txt'] });
  assert.equal(drafts.get('first', 'notes.txt')?.text, 'unsaved first');
  drafts.edit('first', file.path, file.content);
  assert.deepEqual(summary, { count: 1, names: ['Second project · notes.txt'] });
  assert.equal(drafts.get('second', 'notes.txt')?.text, 'unsaved second');
  drafts.open({ id: 'second', name: 'Second project' }, file, drafts.get('second', file.path), true);
  assert.deepEqual(summary, { count: 0, names: [] });
});

test('file draft close warnings bound the displayed list without losing the total unsaved count', () => {
  let summary: UnsavedFileSummary = { count: 0, names: [] };
  const drafts = new FileDraftStore(value => { summary = value; });
  for (let index = 0; index < 9; index++) {
    const path = `file-${index}.txt`;
    drafts.open({ id: 'project', name: 'Project' }, { ...file, path }, undefined);
    drafts.edit('project', path, 'edited');
  }
  assert.equal(summary.count, 9);
  assert.equal(summary.names.length, 8);
  assert.equal(drafts.get('project', 'file-8.txt')?.text, 'edited');
});

test('an in-flight save preserves later edits, including a return to the old baseline, and advances the next save revision', async () => {
  for (const newer of ['newer B', file.content]) {
    let summary: UnsavedFileSummary = { count: 0, names: [] };
    const drafts = new FileDraftStore(value => { summary = value; });
    const workspace = { id: 'project', name: 'Project' };
    drafts.open(workspace, file, undefined);
    drafts.edit(workspace.id, file.path, 'submitted A');
    let resolve!: (written: FileContent) => void;
    let started!: () => void;
    const writing = new Promise<void>(accept => { started = accept; });
    const first = drafts.save(workspace.id, file.path, input => {
      assert.deepEqual(input, { path: file.path, content: 'submitted A', revision: 'initial' });
      started();
      return new Promise(accept => { resolve = accept; });
    });
    await writing;
    const beforeRead = drafts.get(workspace.id, file.path);
    drafts.edit(workspace.id, file.path, newer);
    assert.equal(summary.count, 1);
    assert.equal(drafts.isSaving(workspace.id, file.path), true);
    resolve({ ...file, content: 'submitted A', revision: 'saved-A' });
    await first;
    assert.equal(summary.count, 1);
    assert.equal(drafts.get(workspace.id, file.path)?.text, newer);
    assert.equal(drafts.get(workspace.id, file.path)?.original.revision, 'saved-A');
    assert.equal(drafts.open(workspace, file, beforeRead).original.revision, 'saved-A');
    await drafts.save(workspace.id, file.path, async input => {
      assert.deepEqual(input, { path: file.path, content: newer, revision: 'saved-A' });
      return { ...file, content: newer, revision: 'saved-newer' };
    });
    assert.equal(drafts.get(workspace.id, file.path)?.original.revision, 'saved-newer');
    assert.equal(drafts.get(workspace.id, file.path)?.text, newer);
    assert.equal(drafts.isSaving(workspace.id, file.path), false);
    assert.equal(summary.count, 0);
    assert.equal(drafts.open(workspace, file, undefined).original.revision, 'saved-newer');
  }
});

test('discard removes only the confirmed draft and never a newer edit or an in-flight save', async () => {
  let summary: UnsavedFileSummary = { count: 0, names: [] };
  const drafts = new FileDraftStore(value => { summary = value; });
  const workspace = { id: 'first', name: 'First project' };
  drafts.open(workspace, file, undefined);
  drafts.edit(workspace.id, file.path, 'first draft');
  const confirmed = drafts.get(workspace.id, file.path)!;
  drafts.open({ id: 'second', name: 'Second project' }, file, undefined);
  drafts.edit('second', file.path, 'other project');
  drafts.edit(workspace.id, file.path, 'newer draft');
  assert.equal(drafts.discard(workspace.id, file.path, confirmed), false);
  assert.equal(drafts.get(workspace.id, file.path)?.text, 'newer draft');
  const latest = drafts.get(workspace.id, file.path)!;
  let finish!: (value: FileContent) => void;
  const saving = drafts.save(workspace.id, file.path, async () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  assert.equal(drafts.discard(workspace.id, file.path, latest), false);
  finish({ ...file, content: 'newer draft', revision: 'saved' });
  await saving;
  assert.equal(drafts.discard(workspace.id, file.path, drafts.get(workspace.id, file.path)!), true);
  assert.equal(drafts.get(workspace.id, file.path), undefined);
  assert.equal(drafts.get('second', file.path)?.text, 'other project');
  assert.deepEqual(summary, { count: 1, names: ['Second project · notes.txt'] });
});
