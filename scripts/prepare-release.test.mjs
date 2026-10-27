import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { macReleaseAssets, releaseChecksums } from './mac-release-assets.mjs';
import { publishRelease, releaseNotes, releasePlan } from './prepare-release.mjs';

const source = 'a'.repeat(40);
const previousSource = 'b'.repeat(40);
const successfulRun = { id: 42, head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
const previousRelease = { id: 1, tag_name: 'v0.8.1', draft: false, prerelease: false, target_commitish: previousSource, html_url: 'https://github.com/MeloMei/ensemble/releases/tag/v0.8.1' };
const input = () => ({ source, previousSource, latestVersion: 'v0.8.1', releases: [previousRelease], tags: ['v0.8.1'], tagSources: { 'v0.8.1': previousSource }, packageVersion: '0.8.1', workflowRuns: [successfulRun] });

test('new main commit SHAs prepare a release, while unchanged and published sources skip', () => {
  assert.equal(releasePlan(input()).action, 'create');
  assert.equal(releasePlan({ ...input(), previousSource: source, workflowRuns: [] }).ready, false);
  const published = { ...previousRelease, tag_name: 'v0.8.2', target_commitish: source };
  assert.equal(releasePlan({ ...input(), releases: [previousRelease, published], workflowRuns: [] }).ready, false);
});

test('only the latest successful main Build for the exact source authorizes publication', () => {
  for (const run of [
    { ...successfulRun, head_sha: 'c'.repeat(40) }, { ...successfulRun, head_branch: 'feature' },
    { ...successfulRun, event: 'pull_request' }, { ...successfulRun, status: 'in_progress', conclusion: null },
    { ...successfulRun, conclusion: 'failure' },
  ]) assert.throws(() => releasePlan({ ...input(), workflowRuns: [run] }), /exact source SHA/);
  assert.throws(() => releasePlan({ ...input(), workflowRuns: [successfulRun, { ...successfulRun, id: 43, conclusion: 'failure' }] }), /exact source SHA/);
  assert.equal(releasePlan({ ...input(), workflowRuns: [{ ...successfulRun, event: 'workflow_dispatch' }] }).ciRunId, 42);
});

test('versions avoid published, draft, and reserved tag versions', () => {
  const planned = releasePlan({ ...input(), releases: [previousRelease, { tag_name: 'v0.8.2', draft: true, target_commitish: 'c'.repeat(40) }], tags: ['v0.8.1', 'v0.8.3'] });
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
  const state = { releases: [structuredClone(previousRelease)], tags: { 'v0.8.1': previousSource }, latest: structuredClone(previousRelease), calls: [], release: undefined };
  const client = { repository: planned.repository, pages: async () => structuredClone(state.releases), request: async (path, options = {}) => {
    const method = options.method ?? 'GET';
    state.calls.push({ path, method, json: structuredClone(options.json) });
    if (path.startsWith('git/ref/tags/')) {
      const sha = state.tags[path.slice('git/ref/tags/'.length)];
      if (!sha && options.allowMissing) return null;
      assert.ok(sha, `Unknown tag: ${path}`);
      return { object: { type: 'commit', sha } };
    }
    if (path === 'git/refs') {
      const tag = options.json.ref.slice('refs/tags/'.length);
      if (state.tags[tag]) throw new Error('Tag already exists (422).');
      state.tags[tag] = options.json.sha;
      return { ref: options.json.ref, object: { type: 'commit', sha: options.json.sha } };
    }
    if (path === 'releases') {
      state.release = { ...options.json, id: 99, name: options.json.name, assets: [], html_url: `https://github.com/MeloMei/ensemble/releases/tag/${planned.tag}`, upload_url: 'https://uploads.github.com/repos/MeloMei/ensemble/releases/99/assets{?name,label}' };
      state.releases.push(state.release);
      return structuredClone(state.release);
    }
    if (path === '') {
      const asset = { name: new URL(options.url).searchParams.get('name'), state: 'uploaded', size: options.bytes.length, digest: `sha256:${createHash('sha256').update(options.bytes).digest('hex')}` };
      state.release.assets.push(asset);
      return structuredClone(asset);
    }
    if (path === 'releases/99') {
      if (method === 'PATCH') {
        Object.assign(state.release, { draft: options.json.draft, prerelease: options.json.prerelease });
        if (options.json.make_latest === 'true') state.latest = state.release;
      }
      return structuredClone(state.release);
    }
    if (path === 'releases/latest') return structuredClone(state.latest);
    assert.equal(path, `compare/${previousSource}...${source}`);
    return { status: 'ahead', merge_base_commit: { sha: previousSource } };
  } };
  const context = { source, packageVersion: planned.version, workflowRuns: [successfulRun] };
  return { directory, planned, client, context, state };
}

test('all assets are staged and read back before publication, then the exact release is Latest', async t => {
  const f = await fixture(t);
  const result = await publishRelease(f.client, f.planned, f.directory, f.context);
  const created = f.state.calls.find(call => call.path === 'releases');
  assert.deepEqual({ draft: created.json.draft, prerelease: created.json.prerelease, latest: created.json.make_latest }, { draft: true, prerelease: false, latest: 'false' });
  const patchIndex = f.state.calls.findIndex(call => call.method === 'PATCH');
  assert.deepEqual(f.state.calls[patchIndex].json, { draft: false, prerelease: false, make_latest: 'true' });
  assert.equal(f.state.calls.slice(0, patchIndex).filter(call => call.path === '').length, 4);
  assert.ok(f.state.calls.slice(0, patchIndex).some(call => call.path === 'releases/99' && call.method === 'GET'));
  assert.equal(result.published, true); assert.equal(result.latest, true);
  assert.deepEqual(result.assets, [...macReleaseAssets('0.8.2', 'arm64'), 'SHA256SUMS', 'ensemble-update.json']);
  assert.equal(f.state.latest.id, 99); assert.equal(f.state.tags['v0.8.2'], source);
  const feed = JSON.parse(await readFile(join(f.directory, 'ensemble-update.json'), 'utf8'));
  assert.deepEqual(feed, {
    tag_name: f.planned.tag, name: f.planned.title, body: f.planned.body,
    html_url: `https://github.com/${f.client.repository}/releases/tag/${f.planned.tag}`,
    published_at: feed.published_at, draft: false, prerelease: false,
    assets: f.state.release.assets.slice(0, 2).map(({ name, size, digest }) => ({
      name, size, digest,
      browser_download_url: `https://github.com/${f.client.repository}/releases/download/${f.planned.tag}/${name}`,
    })),
  });
  assert.equal(new Date(feed.published_at).toISOString(), feed.published_at);
  assert.ok(!feed.body.includes('ensemble-release-plan'));
  const before = f.state.calls.filter(call => call.method !== 'GET').length;
  assert.equal((await publishRelease(f.client, f.planned, f.directory, f.context)).skipped, true);
  assert.equal(f.state.calls.filter(call => call.method !== 'GET').length, before);
});

test('changed inputs, failed CI, and concurrent reservations never publish', async t => {
  const f = await fixture(t);
  await assert.rejects(publishRelease(f.client, { ...f.planned, body: f.planned.body + 'changed' }, f.directory, f.context), /do not match/);
  await assert.rejects(publishRelease(f.client, f.planned, f.directory, { ...f.context, workflowRuns: [{ ...successfulRun, conclusion: 'failure' }] }), /exact source SHA/);
  await writeFile(join(f.directory, macReleaseAssets('0.8.2', 'arm64')[0]), 'changed package');
  await assert.rejects(publishRelease(f.client, f.planned, f.directory, f.context), /checksums do not match/);
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
  const fresh = await fixture(t); fresh.state.tags['v0.8.2'] = 'c'.repeat(40);
  await assert.rejects(publishRelease(fresh.client, fresh.planned, fresh.directory, fresh.context), /Tag already exists/);
  assert.ok(fresh.state.calls.every(call => call.method !== 'PATCH' && call.path !== 'releases'));
});

test('upload, readback, or actual tag failures leave the staged release unpublished', async t => {
  for (const failure of ['upload', 'feed-upload', 'readback', 'tag']) {
    const f = await fixture(t);
    const client = { ...f.client, request: async (path, options = {}) => {
      const result = await f.client.request(path, options);
      if (failure === 'upload' && path === '') result.digest = 'sha256:' + '0'.repeat(64);
      if (failure === 'feed-upload' && path === '' && result.name === 'ensemble-update.json') result.digest = 'sha256:' + '0'.repeat(64);
      if (failure === 'readback' && path === 'releases/99') result.assets.pop();
      if (failure === 'tag' && path === 'git/ref/tags/v0.8.2') result.object.sha = 'c'.repeat(40);
      return result;
    } };
    await assert.rejects(publishRelease(client, f.planned, f.directory, f.context), /No publish request was sent/);
    assert.equal(f.state.release.draft, true);
    assert.ok(f.state.calls.every(call => call.method !== 'PATCH'));
  }
});

test('only a complete unchanged daily draft can resume without rebuilding or overwriting', async t => {
  const f = await fixture(t);
  const interrupted = { ...f.client, request: (path, options = {}) => options.method === 'PATCH' ? Promise.reject(new Error('Connection lost.')) : f.client.request(path, options) };
  await assert.rejects(publishRelease(interrupted, f.planned, f.directory, f.context), /A publish request was sent/);
  const planned = { ...releasePlan({ ...input(), releases: structuredClone(f.state.releases), tags: Object.keys(f.state.tags), tagSources: f.state.tags }), repository: f.client.repository };
  assert.equal(planned.action, 'resume'); assert.equal(planned.version, '0.8.2');
  assert.equal(planned.publication.automation, 'ensemble-daily-v2');
  assert.equal(planned.publication.assets.at(-1).name, 'ensemble-update.json');
  f.state.calls.length = 0;
  const result = await publishRelease(f.client, planned, join(f.directory, 'no-local-package'), { ...f.context, packageVersion: '0.8.1' });
  assert.equal(result.published, true);
  assert.ok(f.state.calls.every(call => call.method !== 'POST'));
  assert.equal(f.state.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('legacy three-asset daily drafts resume without requiring or adding an update feed', async t => {
  const f = await fixture(t);
  const interrupted = { ...f.client, request: (path, options = {}) => options.method === 'PATCH' ? Promise.reject(new Error('Connection lost.')) : f.client.request(path, options) };
  await assert.rejects(publishRelease(interrupted, f.planned, f.directory, f.context), /A publish request was sent/);
  const record = JSON.parse(f.state.release.body.match(/<!-- ensemble-release-plan: (\{[^\n]*\}) -->/)[1]);
  record.automation = 'ensemble-daily-v1';
  record.assets = record.assets.filter(asset => asset.name !== 'ensemble-update.json');
  f.state.release.assets = f.state.release.assets.filter(asset => asset.name !== 'ensemble-update.json');
  f.state.release.body = `${f.planned.body}\n<!-- ensemble-release-plan: ${JSON.stringify(record)} -->\n`;
  const planned = { ...releasePlan({ ...input(), releases: f.state.releases, tagSources: f.state.tags }), repository: f.client.repository };
  assert.equal(planned.action, 'resume');
  assert.equal(planned.publication.automation, 'ensemble-daily-v1');
  f.state.calls.length = 0;
  const result = await publishRelease(f.client, planned, join(f.directory, 'no-local-package'), { ...f.context, packageVersion: '0.8.1' });
  assert.equal(result.published, true);
  assert.deepEqual(result.assets, [...macReleaseAssets('0.8.2', 'arm64'), 'SHA256SUMS']);
  assert.ok(f.state.calls.every(call => call.method !== 'POST'));
  assert.equal(f.state.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('unknown, incomplete, edited, or moved drafts cannot be automatically published', async t => {
  const f = await fixture(t);
  const interrupted = { ...f.client, request: (path, options = {}) => options.method === 'PATCH' ? Promise.reject(new Error('Connection lost.')) : f.client.request(path, options) };
  await assert.rejects(publishRelease(interrupted, f.planned, f.directory, f.context));
  const complete = structuredClone(f.state.release);
  for (const changed of [
    { ...complete, body: 'A manually reviewed or old weekly draft.' },
    { ...complete, assets: complete.assets.slice(1) },
    { ...complete, body: complete.body.replace('用户可以', '用户现在可以') },
    { ...complete, body: complete.body.replace('ensemble-daily-v2', 'ensemble-daily-v1') },
  ]) assert.throws(() => releasePlan({ ...input(), releases: [previousRelease, changed], tags: Object.keys(f.state.tags), tagSources: f.state.tags }), /automation|assets|notes/);
  assert.throws(() => releasePlan({ ...input(), releases: f.state.releases, tagSources: { ...f.state.tags, 'v0.8.2': 'c'.repeat(40) } }), /tag does not point/);
  const planned = { ...releasePlan({ ...input(), releases: f.state.releases, tagSources: f.state.tags }), repository: f.client.repository };
  f.state.release.assets.pop(); f.state.calls.length = 0;
  await assert.rejects(publishRelease(f.client, planned, '', f.context), /incomplete or changed assets/);
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
});

test('a failed final Latest readback reports possible publication instead of claiming a draft', async t => {
  const f = await fixture(t);
  const client = { ...f.client, request: async (path, options = {}) => {
    const result = await f.client.request(path, options);
    return path === 'releases/latest' && f.state.release?.draft === false ? previousRelease : result;
  } };
  await assert.rejects(publishRelease(client, f.planned, f.directory, f.context), /A publish request was sent; inspect the Release and Latest/);
  assert.equal(f.state.release.draft, false);
  assert.ok(f.state.calls.every(call => call.method !== 'DELETE'));
});
