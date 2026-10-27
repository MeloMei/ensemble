import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSha256, macReleaseAssets, verifyReleaseAssets } from './mac-release-assets.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const stableVersion = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sourceMarker = source => `<!-- ensemble-release-source: ${source} -->`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceSha = value => /^[a-f0-9]{40}$/.test(value);
const automation = 'ensemble-daily-v2';
const updateFeedName = 'ensemble-update.json';
const automationAssets = new Map([
  ['ensemble-daily-v1', []],
  [automation, [updateFeedName]],
]);

function versionParts(version) {
  const match = stableVersion.exec(version);
  if (!match) throw new Error(`Invalid stable release version: ${version}`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Release version is outside the supported range.');
  return parts;
}

function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function successfulBuildRun(source, runs) {
  const latest = runs.filter(run => run.head_sha === source && run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event))
    .sort((left, right) => right.id - left.id)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error('The latest main Build run for this exact source SHA must complete successfully before publishing a release.');
  }
  return latest;
}

function matchesSource(release, source, tagSources) {
  return tagSources[release.tag_name] === source || release.body?.includes(sourceMarker(source)) || release.target_commitish === source;
}

function automationRecord(release) {
  const matches = [...String(release.body ?? '').matchAll(/\n<!-- ensemble-release-plan: (\{[^\n]*\}) -->\n?$/g)];
  if (matches.length !== 1) throw new Error('The release has no recognized daily automation record.');
  let record;
  try { record = JSON.parse(matches[0][1]); }
  catch { throw new Error('The daily automation record is invalid.'); }
  const body = release.body.slice(0, matches[0].index);
  const additions = automationAssets.get(record.automation);
  if (!additions || !sourceSha(record.source) || !/^\d+\.\d+\.\d+$/.test(record.version)
    || record.notesSha256 !== sha256(body) || !body.includes(sourceMarker(record.source))) {
    throw new Error('The draft notes or daily automation identity do not match their recorded source.');
  }
  const names = [...macReleaseAssets(record.version, 'arm64'), 'SHA256SUMS', ...additions];
  if (!Array.isArray(record.assets) || record.assets.length !== names.length
    || new Set(record.assets.map(asset => asset.name)).size !== names.length
    || !names.every(name => record.assets.some(asset => asset.name === name && Number.isSafeInteger(asset.size)
      && asset.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest)))) {
    throw new Error('The daily automation record does not contain all expected assets.');
  }
  return { body, record };
}

function verifyRelease(release, expected, draft) {
  const { body, record } = automationRecord(release);
  if (release.draft !== draft || release.prerelease !== false || release.tag_name !== expected.tag
    || release.name !== expected.title || release.target_commitish !== expected.source
    || record.source !== expected.source || record.version !== expected.version || body !== expected.body
    || expected.releaseId !== undefined && release.id !== expected.releaseId
    || !Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('The release source, version, notes, or publication state do not match the plan.');
  if (!Array.isArray(release.assets) || release.assets.length !== record.assets.length
    || !record.assets.every(expectedAsset => release.assets.some(asset => asset.name === expectedAsset.name && asset.state === 'uploaded'
      && asset.size === expectedAsset.size && asset.digest === expectedAsset.digest))) {
    throw new Error('The release has incomplete or changed assets.');
  }
  if (expected.publication && JSON.stringify(record) !== JSON.stringify(expected.publication)) throw new Error('The staged release record changed after planning.');
  return record;
}

export function releasePlan({ source, previousSource, latestVersion, releases, tags, tagSources, packageVersion, workflowRuns }) {
  if (!sourceSha(source) || !sourceSha(previousSource)) throw new Error('Release sources must be full commit SHAs.');
  versionParts(packageVersion); versionParts(latestVersion);
  const published = releases.find(release => !release.draft && !release.prerelease && matchesSource(release, source, tagSources));
  if (published) return { ready: false, reason: 'This main source has already been published.', releaseUrl: published.html_url };
  // Merge and revert commits count even when their final trees are identical.
  if (source === previousSource) return { ready: false, reason: 'No new main commits since the latest stable release.' };
  const ci = successfulBuildRun(source, workflowRuns);
  const drafts = releases.filter(release => release.draft && (matchesSource(release, source, tagSources) || release.target_commitish === 'main'));
  if (drafts.length > 1) throw new Error('Multiple drafts may refer to this source. Inspect them before retrying; none was changed.');
  if (drafts.length) {
    const existing = drafts[0];
    const { body, record } = automationRecord(existing);
    const planned = { ready: true, action: 'resume', source, version: record.version, tag: `v${record.version}`,
      title: `Ensemble v${record.version}`, ciRunId: ci.id, releaseId: existing.id, body, notesSha256: record.notesSha256, publication: record };
    verifyRelease(existing, planned, true);
    if (tagSources[planned.tag] !== source || compareVersions(planned.version, latestVersion) <= 0) throw new Error('The resumable draft tag does not point to this newer main release.');
    return planned;
  }
  const reservedVersions = [...tags, ...releases.map(release => release.tag_name)].filter(value => stableVersion.test(value));
  if (!reservedVersions.length) throw new Error('A stable release tag is required before scheduling subsequent releases.');
  const [major, minor, patch] = versionParts(reservedVersions.sort(compareVersions).at(-1));
  if (!Number.isSafeInteger(patch + 1)) throw new Error('Cannot increment the release version.');
  const next = `${major}.${minor}.${patch + 1}`;
  const version = compareVersions(packageVersion, next) > 0 ? packageVersion : next;
  return { ready: true, action: 'create', source, version, tag: `v${version}`, title: `Ensemble v${version}`, ciRunId: ci.id };
}

export function githubClient(repository, { token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.');
  if (!token) throw new Error('GH_TOKEN is required.');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ensemble-releases' };
  const request = async (path, { method = 'GET', json, bytes, url, allowMissing = false } = {}) => {
    const response = await fetchImpl(url ?? `https://api.github.com/repos/${repository}/${path}`, {
      method, headers: { ...headers, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}) },
      body: json ? JSON.stringify(json) : bytes, signal: AbortSignal.timeout(120_000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path || 'asset upload'} failed (${response.status}).`);
    return response.json();
  };
  const pages = async path => {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid list.');
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  };
  return { repository, request, pages };
}

function git(...args) { return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim(); }

function assertSource(source) {
  if (!sourceSha(source) || git('rev-parse', 'HEAD') !== source) throw new Error('Checkout HEAD does not match the fixed release source SHA.');
  execFileSync('git', ['merge-base', '--is-ancestor', source, 'refs/remotes/origin/main'], { cwd: projectRoot });
}

async function passedWorkflowRuns(client, source) {
  const result = await client.request(`actions/workflows/ci.yml/runs?head_sha=${source}&branch=main&per_page=100`);
  if (!Array.isArray(result.workflow_runs)) throw new Error('GitHub returned invalid Build runs.');
  return result.workflow_runs;
}

async function tagSource(client, tag, allowMissing = false) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Cannot resolve an invalid release tag.');
  const reference = await client.request(`git/ref/tags/${tag}`, { allowMissing });
  if (!reference) return undefined;
  let object = reference.object;
  for (let depth = 0; depth < 5; depth++) {
    if (!sourceSha(object?.sha)) throw new Error('GitHub returned an invalid tag target.');
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') throw new Error('The release tag does not resolve to a commit.');
    object = (await client.request(`git/tags/${object.sha}`)).object;
  }
  throw new Error('The release tag contains too many annotated tag references.');
}

async function remoteTagSources(client, releases) {
  const result = {};
  for (const release of releases) if (/^v\d+\.\d+\.\d+$/.test(release.tag_name)) result[release.tag_name] = await tagSource(client, release.tag_name, release.draft);
  return result;
}

export function releaseNotes(generated, source) {
  const notes = generated.replace(/^## What's Changed$/gm, '## 本版更新').replace(/^## New Contributors$/gm, '## 新贡献者').replace(/\*\*Full Changelog\*\*/g, '**完整变更**');
  return `${notes.trim()}\n\n## 安装与更新\n\n下载 macOS arm64 安装包。DMG 打开后将 Ensemble.app 拖入“应用程序”；ZIP 解压后将应用移到 /Applications。已有版本请先完成正在执行的任务。模型服务和 Agent 运行时需要单独安装、认证并承担相应费用。\n\n## 发布范围\n\n- 本版面向 Apple Silicon Mac，未提供 Intel 安装包。\n- 应用采用 ad-hoc 签名，未做 Developer ID 签名或 Apple 公证，首次打开可能被 macOS 拦截。请核对下载来源和 SHA256SUMS，并参考 [Apple 官方说明](https://support.apple.com/102445) 处理系统提示。\n\n${sourceMarker(source)}\n`;
}

async function plan(client, source, output) {
  assertSource(source);
  const latest = await client.request('releases/latest');
  if (latest.draft || latest.prerelease || !/^v\d+\.\d+\.\d+$/.test(latest.tag_name)) throw new Error('Latest must point to a stable Ensemble release.');
  const previousSource = git('rev-parse', `${latest.tag_name}^{commit}`);
  execFileSync('git', ['merge-base', '--is-ancestor', previousSource, source], { cwd: projectRoot });
  const tags = git('tag', '--list').split('\n').filter(tag => stableVersion.test(tag));
  const tagSources = Object.fromEntries(tags.map(tag => [tag, git('rev-parse', `${tag}^{commit}`)]));
  const releases = await client.pages('releases');
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const result = releasePlan({ source, previousSource, latestVersion: latest.tag_name, releases, tags, tagSources, packageVersion: pkg.version,
    workflowRuns: source !== previousSource ? await passedWorkflowRuns(client, source) : [] });
  if (result.ready) {
    if (result.action === 'create') {
      const generated = await client.request('releases/generate-notes', { method: 'POST', json: { tag_name: result.tag, target_commitish: source, previous_tag_name: latest.tag_name } });
      if (typeof generated.body !== 'string' || !generated.body.trim()) throw new Error('GitHub did not return release notes.');
      result.body = releaseNotes(generated.body, source); result.notesSha256 = sha256(result.body);
    }
    Object.assign(result, { repository: client.repository, previousTag: latest.tag_name });
  }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `ready=${result.ready}\nbuild=${result.action === 'create'}\nversion=${result.version ?? ''}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.ready
    ? `## Daily release planned\n\nSource: \`${source}\`\n\nVersion: ${result.version}\n\nBuild run: ${result.ciRunId}\n\nThe workflow will ${result.action === 'resume' ? 'verify and resume its complete staged draft' : 'build and stage all assets in a draft'}, then publish and mark Latest only after verification.\n`
    : `${result.reason}${result.releaseUrl ? `\n\n${result.releaseUrl}` : ''}\n`);
  return result;
}

async function canPublishLatest(client, planned) {
  const latest = await client.request('releases/latest');
  if (latest.draft || latest.prerelease || !/^v\d+\.\d+\.\d+$/.test(latest.tag_name)) throw new Error('Latest is not a stable release.');
  const latestSource = await tagSource(client, latest.tag_name);
  if (latestSource === planned.source) return latest;
  if (compareVersions(planned.version, latest.tag_name) <= 0) throw new Error('A newer release now exists; this draft was not published.');
  const comparison = await client.request(`compare/${latestSource}...${planned.source}`);
  if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== latestSource) throw new Error('This source does not advance the latest published main commit; the draft was not published.');
  return undefined;
}

export async function publishRelease(client, planned, directory, { source, packageVersion, workflowRuns }) {
  if (!planned.ready || !['create', 'resume'].includes(planned.action) || planned.repository !== client.repository || planned.source !== source
    || !sourceSha(source) || planned.tag !== `v${planned.version}` || planned.title !== `Ensemble v${planned.version}`
    || !planned.body?.includes(sourceMarker(source)) || sha256(planned.body) !== planned.notesSha256
    || planned.action === 'create' && planned.version !== packageVersion) throw new Error('The release plan, package version, notes, and source do not match.');
  successfulBuildRun(source, workflowRuns);
  const releases = await client.pages('releases');
  const tagSources = await remoteTagSources(client, releases);
  const published = releases.find(release => !release.draft && !release.prerelease && matchesSource(release, source, tagSources));
  if (published) return { published: false, skipped: true, reason: 'This source has already been published.', releaseUrl: published.html_url };
  const matching = releases.filter(release => matchesSource(release, source, tagSources) || release.tag_name === planned.tag || release.draft && release.target_commitish === 'main');
  let staged; let tagReserved = false; let publicationRequested = false;
  try {
    if (planned.action === 'resume') {
      if (matching.length !== 1 || matching[0].id !== planned.releaseId) throw new Error('The staged draft changed after planning; none was modified.');
      staged = await client.request(`releases/${planned.releaseId}`);
      verifyRelease(staged, planned, true);
    } else {
      if (matching.length) throw new Error('A release now reserves this version or source. Rerun planning; it was not changed.');
      const names = await verifyReleaseAssets(directory, planned.version, 'arm64');
      const assets = await Promise.all(names.map(async name => ({ name, size: (await stat(join(directory, name))).size, digest: `sha256:${await fileSha256(join(directory, name))}` })));
      const releaseUrl = `https://github.com/${client.repository}/releases/tag/${planned.tag}`;
      const downloadUrl = `https://github.com/${client.repository}/releases/download/${planned.tag}`;
      const packageNames = new Set(macReleaseAssets(planned.version, 'arm64'));
      const feed = {
        tag_name: planned.tag, name: planned.title, body: planned.body, html_url: releaseUrl,
        published_at: new Date().toISOString(), draft: false, prerelease: false,
        assets: assets.filter(asset => packageNames.has(asset.name)).map(asset => ({
          ...asset, browser_download_url: `${downloadUrl}/${asset.name}`,
        })),
      };
      await writeFile(join(directory, updateFeedName), `${JSON.stringify(feed, null, 2)}\n`);
      assets.push({ name: updateFeedName, size: (await stat(join(directory, updateFeedName))).size, digest: `sha256:${await fileSha256(join(directory, updateFeedName))}` });
      planned = { ...planned, publication: { automation, source, version: planned.version, notesSha256: planned.notesSha256, assets } };
      const body = `${planned.body}\n<!-- ensemble-release-plan: ${JSON.stringify(planned.publication)} -->\n`;
      const reference = await client.request('git/refs', { method: 'POST', json: { ref: `refs/tags/${planned.tag}`, sha: source } });
      tagReserved = true;
      if (reference.ref !== `refs/tags/${planned.tag}` || reference.object?.sha !== source) throw new Error('GitHub did not reserve the expected source tag.');
      staged = await client.request('releases', { method: 'POST', json: { tag_name: planned.tag, target_commitish: source, name: planned.title, body, draft: true, prerelease: false, make_latest: 'false' } });
      if (!staged.draft || staged.tag_name !== planned.tag || !Number.isSafeInteger(staged.id)) throw new Error('GitHub did not create the expected staging draft.');
      planned = { ...planned, releaseId: staged.id };
      const uploadUrl = new URL(staged.upload_url.replace(/\{.*$/, ''));
      if (uploadUrl.origin !== 'https://uploads.github.com' || uploadUrl.pathname !== `/repos/${client.repository}/releases/${staged.id}/assets`) throw new Error('GitHub returned an unexpected asset upload URL.');
      for (const expected of assets) {
        uploadUrl.searchParams.set('name', expected.name);
        const bytes = await readFile(join(directory, expected.name));
        if (bytes.length !== expected.size || `sha256:${sha256(bytes)}` !== expected.digest) throw new Error('The package changed after asset verification.');
        const asset = await client.request('', { method: 'POST', url: uploadUrl.href, bytes });
        if (asset.name !== expected.name || asset.state !== 'uploaded' || asset.size !== expected.size || asset.digest !== expected.digest) throw new Error(`The staged asset ${expected.name} was not uploaded intact.`);
      }
      staged = await client.request(`releases/${staged.id}`);
      verifyRelease(staged, planned, true);
    }
    if (await tagSource(client, planned.tag) !== source) throw new Error('The actual release tag no longer points to the fixed source.');
    const alreadyPublished = await canPublishLatest(client, planned);
    if (alreadyPublished) return { published: false, skipped: true, reason: 'This source was published while preparing the draft.', releaseUrl: alreadyPublished.html_url };
    publicationRequested = true;
    const release = await client.request(`releases/${staged.id}`, { method: 'PATCH', json: { draft: false, prerelease: false, make_latest: 'true' } });
    verifyRelease(release, planned, false);
    const latest = await client.request('releases/latest');
    verifyRelease(latest, planned, false);
    if (latest.id !== staged.id || await tagSource(client, latest.tag_name) !== source) throw new Error('The published Latest release does not match the fixed source and assets.');
    return { published: true, releaseUrl: latest.html_url, version: planned.version, source, assets: planned.publication.assets.map(asset => asset.name), latest: true };
  } catch (error) {
    const recovery = publicationRequested
      ? 'A publish request was sent; inspect the Release and Latest state before retrying. No release or tag was deleted.'
      : `No publish request was sent. ${tagReserved ? `Version tag ${planned.tag} remains reserved. ` : ''}Any staged draft is left untouched; inspect an incomplete or unrecognized draft before retrying.`;
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${recovery}`, { cause: error });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const repository = value('--repository');
  if (!repository) throw new Error('--repository is required.');
  const client = githubClient(repository);
  let result;
  if (command === 'plan') {
    const source = value('--source'); const output = value('--output');
    if (!source || !output) throw new Error('plan requires --source and --output.');
    result = await plan(client, source, output);
  } else if (command === 'publish') {
    const input = value('--plan');
    if (!input) throw new Error('publish requires --plan.');
    const planned = JSON.parse(await readFile(input, 'utf8'));
    assertSource(planned.source);
    const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    result = await publishRelease(client, planned, join(projectRoot, 'release', planned.version), {
      source: planned.source, packageVersion: pkg.version, workflowRuns: await passedWorkflowRuns(client, planned.source),
    });
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.published
      ? `## Release published and marked Latest\n\n${result.releaseUrl}\n\nSource: \`${result.source}\`\n\nAll recorded release assets were verified before publication. Installed apps can discover this release.\n`
      : `${result.reason}\n\n${result.releaseUrl}\n`);
  } else throw new Error('Use plan or publish.');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
