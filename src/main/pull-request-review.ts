import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { PullRequestReview } from '../shared/types';

const checkSchema = z.object({
  name: z.string().optional(), context: z.string().optional(), status: z.string().optional(),
  state: z.string().optional(), conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(), targetUrl: z.string().nullable().optional(),
});
const reviewSchema = z.object({
  url: z.string().url(), number: z.number().int().positive(), title: z.string(), state: z.string(),
  headRefOid: z.string(), reviewDecision: z.string().nullable().optional(),
  statusCheckRollup: z.array(checkSchema).nullable().optional(),
});

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, {
    cwd, shell: false, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
  }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const failure = new Error((stderr.trim() || error.message).replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@'));
    Object.assign(failure, { code: error.code });
    reject(failure);
  }));
}

export function parsePullRequestReview(raw: unknown): PullRequestReview {
  const result = reviewSchema.parse(raw);
  const review = {
    status: 'ready' as const, url: result.url, number: result.number, title: result.title, state: result.state,
    headSha: result.headRefOid, checkedAt: new Date().toISOString(), reviewDecision: result.reviewDecision ?? undefined,
    checks: (result.statusCheckRollup ?? []).map(check => ({
      name: check.name ?? check.context ?? 'Unnamed check', status: check.status ?? check.state ?? 'UNKNOWN',
      conclusion: check.conclusion ?? undefined, url: check.detailsUrl ?? check.targetUrl ?? undefined,
    })),
  };
  return review;
}

export async function reviewPullRequest(cwd: string): Promise<PullRequestReview> {
  try {
    try { await run('git', ['rev-parse', '--show-toplevel'], cwd); }
    catch { return { status: 'unavailable', error: '当前目录不是 Git 仓库。' }; }
    if (!(await run('git', ['remote'], cwd)).trim()) return { status: 'unavailable', error: '当前仓库没有远程地址。' };
    const output = await run('gh', ['pr', 'view', '--json',
      'url,number,title,state,headRefOid,reviewDecision,statusCheckRollup'], cwd);
    return parsePullRequestReview(JSON.parse(output));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unavailable', error: '未安装 GitHub CLI（gh）。' };
    if (/gh auth login|not logged|authentication|GH_TOKEN/i.test(message)) return { status: 'unavailable', error: 'GitHub CLI 尚未登录或当前账号无权读取。' };
    if (/no pull requests? found|no pull request associated/i.test(message)) return { status: 'unavailable', error: '当前分支没有关联的 PR。' };
    return { status: 'error', error: message };
  }
}
