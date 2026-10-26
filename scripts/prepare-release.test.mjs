import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { macReleaseAssets, releaseChecksums } from './mac-release-assets.mjs';
import { createReleaseDraft, releaseNotes, releasePlan } from './prepare-release.mjs';

const source = 'a'.repeat(40);
const successfulRun = { id: 42, head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
const input = () => ({ source, hasChanges: true, releases: [{ tag_name: 'v0.8.1', draft: false }], tags: ['v0.8.1'], packageVersion: '0.8.1', workflowRuns: [successfulRun] });

test('unchanged sources and sources with an existing draft do not reserve another version', () => {
  assert.equal(releasePlan({ ...input(), hasChanges: false, workflowRuns: [] }).ready, false);
  const assets = [...macReleaseAssets('0.8.2', 'arm64'), 'SHA256SUMS'].map(name => ({ name, state: 'uploaded', size: 100, digest: 'sha256:' + 'b'.repeat(64) }));
  const existing = { tag_name: 'v0.8.2', draft: true, body: `<!-- ensemble-release-source: ${source} -->`, html_url: 'https://github.com/MeloMei/ensemble/releases/99', assets };
  const planned = releasePlan({ ...input(), releases: [...input().releases, existing], workflowRuns: [] });
  assert.equal(planned.ready, false);
  assert.equal(planned.draftUrl, existing.html_url);
});

test('an incomplete draft is reported as a recoverable failure instead of a completed preparation', () => {
  const existing = { tag_name: 'v0.8.2', draft: true, target_commitish: source, body: 'Notes edited by the reviewer.', assets: [], html_url: 'https://github.com/MeloMei/ensemble/releases/99' };
  assert.throws(() => releasePlan({ ...input(), releases: [...input().releases, existing], workflowRuns: [] }), /incomplete Release draft.*remove the incomplete draft and its unused tag/);
});

test('only the latest main Build run for the exact source can authorize preparation', () => {
  for (const run of [
    { ...successfulRun, head_sha: 'b'.repeat(40) },
    { ...successfulRun, head_branch: 'feature' },
    { ...successfulRun, event: 'pull_request' },
    { ...successfulRun, status: 'in_progress', conclusion: null },
    { ...successfulRun, conclusion: 'failure' },
  ]) assert.throws(() => releasePlan({ ...input(), workflowRuns: [run] }), /exact source SHA/);
  assert.throws(() => releasePlan({ ...input(), workflowRuns: [successfulRun, { ...successfulRun, id: 43, conclusion: 'failure' }] }), /exact source SHA/);
  assert.equal(releasePlan({ ...input(), workflowRuns: [{ ...successfulRun, event: 'workflow_dispatch' }] }).ciRunId, 42);
});

test('published versions, existing drafts, and reserved tags cannot be reused', () => {
  const planned = releasePlan({ ...input(), releases: [...input().releases, { tag_name: 'v0.8.2', draft: true, body: 'An earlier draft under review.' }], tags: ['v0.8.1', 'v0.8.3'] });
  assert.equal(planned.version, '0.8.4');
  assert.equal(releasePlan({ ...input(), packageVersion: '0.9.0' }).version, '0.9.0');
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-release-rules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = releaseNotes('## What\'s Changed\n\n* 用户可以直接检查新版。', source);
  const planned = { ...releasePlan(input()), repository: 'MeloMei/ensemble', body, notesSha256: createHash('sha256').update(body).digest('hex') };
  const names = macReleaseAssets(planned.version, 'arm64');
  for (const name of names) await writeFile(join(directory, name), `${name} fixture bytes`);
  await writeFile(join(directory, 'SHA256SUMS'), await releaseChecksums(directory, names));
  const calls = []; const assets = [];
  const client = { repository: planned.repository, pages: async () => [], request: async (path, options) => {
    calls.push({ path, options });
    if (path === 'git/refs') return { ref: options.json.ref, object: { sha: options.json.sha } };
    if (path === 'releases') return { id: 99, draft: true, tag_name: planned.tag, upload_url: 'https://uploads.github.com/repos/MeloMei/ensemble/releases/99/assets{?name,label}' };
    if (path === '') {
      const asset = { name: new URL(options.url).searchParams.get('name'), state: 'uploaded', size: options.bytes.length, digest: `sha256:${createHash('sha256').update(options.bytes).digest('hex')}` };
      assets.push(asset); return asset;
    }
    assert.equal(path, 'releases/99');
    return { draft: true, tag_name: planned.tag, body: planned.body, assets, html_url: 'https://github.com/MeloMei/ensemble/releases/99' };
  } };
  const context = { source, packageVersion: planned.version, workflowRuns: [successfulRun] };
  return { directory, planned, client, context, calls };
}

test('a prepared release stays draft-only and all uploaded assets are verified', async t => {
  const f = await fixture(t);
  const result = await createReleaseDraft(f.client, f.planned, f.directory, f.context);
  assert.deepEqual(f.calls[0], { path: 'git/refs', options: { method: 'POST', json: { ref: 'refs/tags/v0.8.2', sha: source } } });
  const payload = f.calls.find(call => call.path === 'releases').options.json;
  assert.deepEqual({ draft: payload.draft, prerelease: payload.prerelease, latest: payload.make_latest, target: payload.target_commitish }, { draft: true, prerelease: false, latest: 'false', target: source });
  assert.deepEqual(result.assets, [...macReleaseAssets('0.8.2', 'arm64'), 'SHA256SUMS']);
  assert.equal(f.calls.filter(call => call.path === 'releases').length, 1);
  assert.ok(f.calls.every(call => call.options?.method !== 'PATCH'));
});

test('changed notes, package bytes, or source state are rejected before creating a draft', async t => {
  const f = await fixture(t);
  await assert.rejects(createReleaseDraft(f.client, { ...f.planned, body: f.planned.body + 'changed' }, f.directory, f.context), /do not match/);
  await assert.rejects(createReleaseDraft(f.client, f.planned, f.directory, { ...f.context, workflowRuns: [{ ...successfulRun, conclusion: 'failure' }] }), /exact source SHA/);
  await writeFile(join(f.directory, macReleaseAssets('0.8.2', 'arm64')[0]), 'changed after checksums were generated');
  await assert.rejects(createReleaseDraft(f.client, f.planned, f.directory, f.context), /checksums do not match/);
  assert.equal(f.calls.length, 0);
});

test('a version or source reserved while packaging is never overwritten', async t => {
  const f = await fixture(t);
  for (const release of [{ tag_name: f.planned.tag }, { tag_name: 'v0.8.3', body: f.planned.body }]) {
    const client = { ...f.client, pages: async () => [{ ...release, html_url: 'https://github.com/MeloMei/ensemble/releases/100' }] };
    await assert.rejects(createReleaseDraft(client, f.planned, f.directory, f.context), /was not changed/);
  }
  assert.equal(f.calls.length, 0);
  const client = { ...f.client, request: async (path, options) => {
    assert.equal(path, 'git/refs');
    assert.equal(options.json.sha, source);
    throw new Error('Tag already exists (422).');
  } };
  await assert.rejects(createReleaseDraft(client, f.planned, f.directory, f.context), /Tag already exists/);
  assert.equal(f.calls.length, 0);
});

test('an interrupted or corrupted upload leaves the draft unpublished for inspection', async t => {
  const f = await fixture(t);
  const client = { ...f.client, request: async (path, options) => {
    const result = await f.client.request(path, options);
    return path === '' ? { ...result, digest: 'sha256:' + '0'.repeat(64) } : result;
  } };
  await assert.rejects(createReleaseDraft(client, f.planned, f.directory, f.context), /remains unpublished/);
  assert.equal(f.calls.filter(call => call.path === '').length, 1);
  assert.ok(f.calls.every(call => call.options?.method !== 'PATCH' && call.options?.method !== 'DELETE'));
});

test('failure after reserving a tag identifies the unused reservation without deleting it', async t => {
  const f = await fixture(t);
  const client = { ...f.client, request: async (path, options) => {
    if (path === 'releases') throw new Error('GitHub is unavailable.');
    return f.client.request(path, options);
  } };
  await assert.rejects(createReleaseDraft(client, f.planned, f.directory, f.context), /Version tag v0.8.2 remains reserved/);
  assert.deepEqual(f.calls.map(call => call.path), ['git/refs']);
});
