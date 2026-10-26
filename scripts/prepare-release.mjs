import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macReleaseAssets, verifyReleaseAssets } from './mac-release-assets.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const stableVersion = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sourceMarker = source => `<!-- ensemble-release-source: ${source} -->`;

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
    throw new Error('The latest main Build run for this exact source SHA must complete successfully before preparing a release.');
  }
  return latest;
}

function isCompleteDraft(release) {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return false;
  const names = [...macReleaseAssets(release.tag_name.slice(1), 'arm64'), 'SHA256SUMS'];
  return names.every(name => release.assets?.some(asset => asset.name === name && asset.state === 'uploaded'
    && Number.isSafeInteger(asset.size) && asset.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest)));
}

function sourceDraft(releases, source) {
  return releases.find(release => release.draft && (release.body?.includes(sourceMarker(source)) || release.target_commitish === source));
}

export function releasePlan({ source, hasChanges, releases, tags, packageVersion, workflowRuns }) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Release source must be a full commit SHA.');
  versionParts(packageVersion);
  const existing = sourceDraft(releases, source);
  if (existing) {
    if (!isCompleteDraft(existing)) throw new Error(`This source has an incomplete Release draft. It was not changed: ${existing.html_url}. Inspect the unpublished draft and its reserved tag; remove the incomplete draft and its unused tag before retrying.`);
    return { ready: false, reason: 'This source already has a complete Release draft. Review that draft instead of replacing it.', draftUrl: existing.html_url };
  }
  if (!hasChanges) return { ready: false, reason: 'No changes since the latest stable release.' };
  const ci = successfulBuildRun(source, workflowRuns);
  const reservedVersions = [...tags, ...releases.map(release => release.tag_name)].filter(value => stableVersion.test(value));
  if (!reservedVersions.length) throw new Error('A stable release tag is required before scheduling subsequent releases.');
  const highest = reservedVersions.sort(compareVersions).at(-1);
  const [major, minor, patch] = versionParts(highest);
  if (!Number.isSafeInteger(patch + 1)) throw new Error('Cannot increment the release version.');
  const next = `${major}.${minor}.${patch + 1}`;
  const version = compareVersions(packageVersion, next) > 0 ? packageVersion : next;
  return { ready: true, source, version, tag: `v${version}`, title: `Ensemble v${version}`, ciRunId: ci.id };
}

export function githubClient(repository, { token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.');
  if (!token) throw new Error('GH_TOKEN is required.');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ensemble-release-drafts' };
  const request = async (path, { method = 'GET', json, bytes, url } = {}) => {
    const target = url ?? `https://api.github.com/repos/${repository}/${path}`;
    const response = await fetchImpl(target, {
      method, headers: { ...headers, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}) },
      body: json ? JSON.stringify(json) : bytes, signal: AbortSignal.timeout(120_000),
    });
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
  if (!/^[a-f0-9]{40}$/.test(source) || git('rev-parse', 'HEAD') !== source) throw new Error('Checkout HEAD does not match the fixed release source SHA.');
  execFileSync('git', ['merge-base', '--is-ancestor', source, 'refs/remotes/origin/main'], { cwd: projectRoot });
}

async function passedWorkflowRuns(client, source) {
  const result = await client.request(`actions/workflows/ci.yml/runs?head_sha=${source}&branch=main&per_page=100`);
  if (!Array.isArray(result.workflow_runs)) throw new Error('GitHub returned invalid Build runs.');
  return result.workflow_runs;
}

export function releaseNotes(generated, source) {
  const notes = generated.replace(/^## What's Changed$/gm, '## 本版更新').replace(/^## New Contributors$/gm, '## 新贡献者').replace(/\*\*Full Changelog\*\*/g, '**完整变更**');
  return `${notes.trim()}\n\n## 安装与更新\n\n下载 macOS arm64 安装包。DMG 打开后将 Ensemble.app 拖入“应用程序”；ZIP 解压后将应用移到 /Applications。已有版本请先完成正在执行的任务。模型服务和 Agent 运行时需要单独安装、认证并承担相应费用。\n\n## 发布范围\n\n- 本版面向 Apple Silicon Mac，未提供 Intel 安装包。\n- 应用采用 ad-hoc 签名，未做 Developer ID 签名或 Apple 公证，首次打开可能被 macOS 拦截。请核对下载来源和 SHA256SUMS，并参考 [Apple 官方说明](https://support.apple.com/102445) 处理系统提示。\n\n${sourceMarker(source)}\n`;
}

async function plan(client, source, output) {
  assertSource(source);
  const latest = await client.request('releases/latest');
  if (latest.draft || latest.prerelease || !/^v\d+\.\d+\.\d+$/.test(latest.tag_name)) throw new Error('Latest must point to a stable Ensemble release.');
  const previous = git('rev-parse', `${latest.tag_name}^{commit}`);
  execFileSync('git', ['merge-base', '--is-ancestor', previous, source], { cwd: projectRoot });
  const hasChanges = git('diff', '--name-only', previous, source).length > 0;
  const releases = await client.pages('releases');
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const result = releasePlan({ source, hasChanges, releases, tags: git('tag', '--list').split('\n'), packageVersion: pkg.version,
    workflowRuns: hasChanges && !sourceDraft(releases, source) ? await passedWorkflowRuns(client, source) : [] });
  if (result.ready) {
    const generated = await client.request('releases/generate-notes', { method: 'POST', json: { tag_name: result.tag, target_commitish: source, previous_tag_name: latest.tag_name } });
    if (typeof generated.body !== 'string' || !generated.body.trim()) throw new Error('GitHub did not return release notes.');
    const body = releaseNotes(generated.body, source);
    Object.assign(result, { repository: client.repository, previousTag: latest.tag_name, body, notesSha256: createHash('sha256').update(body).digest('hex') });
  }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `ready=${result.ready}\nversion=${result.version ?? ''}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.ready
    ? `## Release draft planned\n\nSource: \`${source}\`\n\nVersion: ${result.version}\n\nBuild run: ${result.ciRunId}\n\nThe workflow reserves a public version tag, then creates an unpublished draft. Review its packages and complete notes, publish it manually, and mark it Latest so installed apps can discover it.\n`
    : `${result.reason}${result.draftUrl ? `\n\n${result.draftUrl}` : ''}\n`);
  return result;
}

export async function createReleaseDraft(client, planned, directory, { source, packageVersion, workflowRuns }) {
  if (!planned.ready || planned.repository !== client.repository || planned.source !== source || planned.version !== packageVersion
    || planned.tag !== `v${packageVersion}` || planned.title !== `Ensemble v${packageVersion}`
    || !planned.body?.includes(sourceMarker(source)) || createHash('sha256').update(planned.body).digest('hex') !== planned.notesSha256) {
    throw new Error('The release plan, package version, notes, and source do not match.');
  }
  successfulBuildRun(source, workflowRuns);
  const names = await verifyReleaseAssets(directory, planned.version, 'arm64');
  const releases = await client.pages('releases');
  const duplicate = releases.find(release => release.body?.includes(sourceMarker(source)) || release.target_commitish === source || release.tag_name === planned.tag);
  if (duplicate) throw new Error(`A release already reserves this version or source. It was not changed: ${duplicate.html_url}`);
  const reference = await client.request('git/refs', { method: 'POST', json: { ref: `refs/tags/${planned.tag}`, sha: source } });
  try {
    if (reference.ref !== `refs/tags/${planned.tag}` || reference.object?.sha !== source) throw new Error('GitHub did not reserve the expected source tag.');
    const release = await client.request('releases', { method: 'POST', json: {
      tag_name: planned.tag, target_commitish: source, name: planned.title, body: planned.body,
      draft: true, prerelease: false, make_latest: 'false',
    } });
    if (release.draft !== true || release.tag_name !== planned.tag) throw new Error('GitHub did not create the expected draft.');
    const uploadUrl = new URL(release.upload_url.replace(/\{.*$/, ''));
    if (uploadUrl.origin !== 'https://uploads.github.com' || uploadUrl.pathname !== `/repos/${client.repository}/releases/${release.id}/assets`) throw new Error('GitHub returned an unexpected asset upload URL.');
    const uploaded = [];
    for (const name of names) {
      uploadUrl.searchParams.set('name', name);
      const bytes = await readFile(join(directory, name));
      const asset = await client.request('', { method: 'POST', url: uploadUrl.href, bytes });
      if (asset.name !== name || asset.size !== bytes.length || asset.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) {
        throw new Error(`The draft asset ${name} was not uploaded intact. The draft remains unpublished for inspection.`);
      }
      uploaded.push({ name, size: asset.size, digest: asset.digest });
    }
    const readback = await client.request(`releases/${release.id}`);
    if (!readback.draft || !isCompleteDraft(readback) || readback.tag_name !== planned.tag || readback.body !== planned.body
      || !uploaded.every(expected => readback.assets?.some(asset => asset.name === expected.name && asset.size === expected.size && asset.digest === expected.digest))) throw new Error('Draft readback did not match the plan.');
    return { draftUrl: readback.html_url, version: planned.version, source, assets: names };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Version tag ${planned.tag} remains reserved and any created draft is left untouched. Inspect that unpublished draft and tag before removing them and retrying.`, { cause: error });
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
  } else if (command === 'draft') {
    const input = value('--plan');
    if (!input) throw new Error('draft requires --plan.');
    const planned = JSON.parse(await readFile(input, 'utf8'));
    assertSource(planned.source);
    const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    result = await createReleaseDraft(client, planned, join(projectRoot, 'release', planned.version), {
      source: planned.source, packageVersion: pkg.version, workflowRuns: await passedWorkflowRuns(client, planned.source),
    });
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Draft ready for review\n\n${result.draftUrl}\n\nThe version tag is public, but the Release has not been published or marked Latest. Review the packages and complete notes, then publish the draft and mark it Latest. Installed apps check GitHub's latest Release and will otherwise keep receiving the previous one.\n`);
  } else throw new Error('Use plan or draft.');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
