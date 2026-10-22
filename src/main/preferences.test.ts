import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopPreferences } from './preferences';

test('language preferences serialize changes, survive restart and retain unrelated settings', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'ensemble-language-'));
  try {
    await writeFile(join(dataPath, 'preferences.json'), JSON.stringify({ theme: 'dark', custom: { compact: true } }));
    const preferences = new DesktopPreferences(dataPath);
    await preferences.load();
    assert.equal(preferences.languagePreference, 'system');
    await Promise.all([preferences.setLanguagePreference('en'), preferences.setLanguagePreference('zh-CN')]);
    assert.equal(preferences.languagePreference, 'zh-CN');
    assert.deepEqual(JSON.parse(await readFile(join(dataPath, 'preferences.json'), 'utf8')), {
      theme: 'dark', custom: { compact: true }, languagePreference: 'zh-CN',
    });
    const reopened = new DesktopPreferences(dataPath);
    await reopened.load();
    assert.equal(reopened.languagePreference, 'zh-CN');
  } finally { await rm(dataPath, { recursive: true, force: true }); }
});

test('invalid stored language preferences fall back to system without deleting other fields', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'ensemble-language-'));
  try {
    await writeFile(join(dataPath, 'preferences.json'), JSON.stringify({ languagePreference: 'invalid', theme: 'light' }));
    const preferences = new DesktopPreferences(dataPath);
    await preferences.load();
    assert.equal(preferences.languagePreference, 'system');
    await preferences.setLanguagePreference('en');
    assert.deepEqual(JSON.parse(await readFile(join(dataPath, 'preferences.json'), 'utf8')), { languagePreference: 'en', theme: 'light' });
    await writeFile(join(dataPath, 'preferences.json'), '{broken');
    await preferences.load();
    assert.equal(preferences.languagePreference, 'system');
  } finally { await rm(dataPath, { recursive: true, force: true }); }
});

test('a failed language preference write retains the active choice and allows a later retry', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'ensemble-language-'));
  const moved = `${dataPath}-moved`;
  try {
    const preferences = new DesktopPreferences(dataPath);
    await preferences.load();
    await preferences.setLanguagePreference('zh-CN');
    await rename(dataPath, moved);
    await writeFile(dataPath, 'not a directory');
    await assert.rejects(preferences.setLanguagePreference('en'));
    assert.equal(preferences.languagePreference, 'zh-CN');
    await rm(dataPath);
    await rename(moved, dataPath);
    await preferences.setLanguagePreference('en');
    assert.equal(preferences.languagePreference, 'en');
  } finally {
    await rm(dataPath, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});
