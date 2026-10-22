import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeI18n, renderDisplayText, resolveLanguage, resources, setLanguage, translate } from './i18n';
import { createImplementationReviewDraft } from '../renderer/collaboration-template';

test('language preference resolves system language and preserves explicit selection', () => {
  assert.equal(resolveLanguage('system', ['zh-Hans-CN', 'en-US']), 'zh-CN');
  assert.equal(resolveLanguage('system', ['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLanguage('system', ['ja-JP']), 'en');
  assert.equal(resolveLanguage('system', []), 'en');
  assert.equal(resolveLanguage('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLanguage('en', ['zh-CN']), 'en');
});

test('every interface catalog has matching keys and interpolation values in both languages', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map(match => match[1]).sort();
  for (const name of Object.keys(resources.en) as (keyof typeof resources.en)[]) {
    const english: Record<string, string> = resources.en[name];
    const chinese: Record<string, string> = resources['zh-CN'][name];
    assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort(), name);
    for (const [key, value] of Object.entries(english)) {
      assert.ok(value.trim(), `${name}:${key} must have an English value`);
      assert.ok(chinese[key].trim(), `${name}:${key} must have a Chinese value`);
      assert.deepEqual(placeholders(value), placeholders(chinese[key]), `${name}:${key}`);
    }
  }
});

test('switching language translates live labels and new templates without changing existing work', async () => {
  try {
    await initializeI18n('en');
    assert.equal(translate('shell:provider.detectedCount', { count: 1 }), '1 runtime entry found');
    assert.equal(translate('shell:provider.detectedCount', { count: 2 }), '2 runtime entries found');
    const draft = createImplementationReviewDraft({ cwd: '/example', goal: 'Keep this task 原文' });
    const before = structuredClone(draft);
    assert.equal(draft.participants[0].name, 'Implementer');
    await setLanguage('zh-CN');
    assert.equal(translate('shell:status.waiting_approval'), '等待审批');
    assert.deepEqual(draft, before);
    assert.equal(createImplementationReviewDraft({ cwd: '/example' }).participants[0].name, '实现者');
    assert.equal(renderDisplayText('外部工具原文'), '外部工具原文');
    assert.equal(renderDisplayText('unknown', { key: 'runtime:missing' }), 'unknown');
  } finally { await setLanguage('zh-CN'); }
});
