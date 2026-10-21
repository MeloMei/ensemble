import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { DeepSeekBalance, McpServerConfig, McpSettingsView, Session, SkillInfo } from '../shared/types';
import { MCP_CONFIG_CANDIDATES, inspectMcpConfigContent } from './vendor/orca/mcp-config';
import { summarizeSkillMarkdown } from './vendor/orca/skill-metadata';
import { deepSeekChildEnvironment } from './providers/deepseek-harness';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const record = z.record(z.string().max(64_000));
const serverSchema = z.union([
  z.object({ type: z.literal('stdio').optional(), command: z.string().min(1).max(4096), args: z.array(z.string().max(16_000)).max(100).default([]), env: record.optional(), enabled: z.boolean().optional(), disabled: z.boolean().optional() }),
  z.object({ type: z.enum(['http', 'sse']).optional(), url: z.string().url().max(4096), headers: record.optional(), enabled: z.boolean().optional(), disabled: z.boolean().optional() }),
]);
const configSchema = z.object({ mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), serverSchema) }).strict();
const EMPTY = '{\n  "mcpServers": {}\n}\n';

async function boundedText(file: string, limit = 256_000): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('文件不是受限大小的普通文本文件。');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('文件超过大小限制。');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}
async function optionalText(file: string): Promise<string | null> {
  try { return await boundedText(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class RuntimeSettings {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private configPath(cwd: string): string { return path.join(this.directory, `${hash(cwd)}.json`); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.catch(() => {}).then(operation);
    this.writes = pending; return pending;
  }
  private async saveText(file: string, content: string, revision?: string, fallback?: string): Promise<void> {
    const current = await optionalText(file) ?? fallback;
    if (current === undefined ? revision !== undefined : hash(current) !== revision) throw new Error('文件已存在或发生变化，请重新读取。');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      if ((await optionalText(file) ?? fallback) !== current) throw new Error('文件已发生变化，请重新读取。');
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }

  async mcpSettings(cwd: string): Promise<McpSettingsView> {
    const content = await optionalText(this.configPath(cwd)) ?? EMPTY;
    const sources = [{ candidate: MCP_CONFIG_CANDIDATES[0], content, source: 'Ensemble' }];
    for (const candidate of MCP_CONFIG_CANDIDATES) {
      try { sources.push({ candidate, content: await optionalText(path.join(cwd, candidate.relativePath)) ?? '', source: candidate.relativePath }); }
      catch { sources.push({ candidate, content: '<unreadable>', source: candidate.relativePath }); }
    }
    return { content, revision: hash(content), servers: sources.flatMap(source => {
      if (!source.content) return [];
      const result = inspectMcpConfigContent(source.candidate, source.content);
      return result.status === 'invalid' ? [{ name: source.source, transport: 'unknown', status: 'invalid', source: source.source, issue: result.error }] :
        result.servers.map(server => ({ name: server.name, transport: server.transport, status: server.status, source: source.source, issue: server.issue }));
    }) };
  }

  async saveMcpSettings(cwd: string, input: { content: string; revision: string }): Promise<void> {
    return this.serialize(async () => {
    if (Buffer.byteLength(input.content) > 256_000) throw new Error('MCP配置超过256KB。');
    const parsed = configSchema.parse(JSON.parse(input.content));
    if (Object.keys(parsed.mcpServers).length > 32 || Object.hasOwn(parsed.mcpServers, 'workbench')) throw new Error('最多32个服务，workbench名称保留给平台。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.saveText(this.configPath(cwd), input.content, input.revision, EMPTY);
    });
  }

  async servers(cwd: string): Promise<McpServerConfig[]> {
    const result = new Map<string, McpServerConfig>();
    const paths = [...MCP_CONFIG_CANDIDATES.map(candidate => path.join(cwd, candidate.relativePath)), this.configPath(cwd)];
    for (const file of paths) {
      const content = await optionalText(file);
      if (!content) continue;
      const raw: unknown = JSON.parse(content);
      if (raw && typeof raw === 'object' && !Object.hasOwn(raw, 'mcpServers') && file !== this.configPath(cwd)) continue;
      const parsed = configSchema.safeParse(raw && typeof raw === 'object' && 'mcpServers' in raw ? { mcpServers: raw.mcpServers } : raw);
      if (!parsed.success) throw new Error(`MCP配置无效：${path.basename(file)}`);
      for (const [name, config] of Object.entries(parsed.data.mcpServers)) {
        if (name === 'workbench') throw new Error('MCP名称workbench由平台保留，请重命名用户配置。');
        if (config.enabled === false || config.disabled === true) { result.delete(name); continue; }
        result.set(name, 'command' in config ? { name, type: 'stdio', command: config.command, args: config.args, env: config.env } :
          { name, type: config.type ?? 'http', url: config.url, headers: config.headers });
      }
    }
    return [...result.values()];
  }

  async testServer(cwd: string, name: string): Promise<{ status: string; tools: string[]; error?: string }> {
    const config = (await this.servers(cwd)).find(server => server.name === name);
    if (!config) throw new Error('没有找到已启用的MCP服务。');
    const client = new Client({ name: 'workbench-inspector', version: '0.4.0' });
    const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const transport = config.type === 'stdio' ? new StdioClientTransport({ command: config.command, args: config.args, env: { ...environment, ...config.env }, cwd, stderr: 'ignore' }) :
      config.type === 'sse' ? new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }) :
        new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    try {
      await client.connect(transport, { timeout: 5_000 });
      const response = await client.listTools(undefined, { timeout: 5_000 });
      return { status: 'connected', tools: response.tools.slice(0, 256).map(tool => tool.name) };
    } catch (error) { return { status: 'failed', tools: [], error: error instanceof Error ? error.message : String(error) }; }
    finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }

  async listSkills(cwd: string): Promise<SkillInfo[]> {
    const roots = [
      ...['.agents/skills', '.claude/skills', '.codex/skills'].map(relative => ({ path: path.join(cwd, relative), scope: 'project' as const })),
      ...['.agents/skills', '.claude/skills', '.codex/skills'].map(relative => ({ path: path.join(homedir(), relative), scope: 'user' as const })),
    ];
    const result = new Map<string, SkillInfo>();
    for (const root of roots) {
      let entries;
      try { entries = await readdir(root.path, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const entry of entries.slice(0, 500)) {
        if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
        const file = path.join(root.path, entry.name, 'SKILL.md');
        try {
          const canonical = await realpath(file);
          if (result.has(canonical)) continue;
          const content = await boundedText(canonical, 64_000);
          const summary = summarizeSkillMarkdown(content);
          result.set(canonical, { id: hash(canonical), name: summary.name ?? entry.name, description: summary.description ?? '', path: canonical,
            scope: root.scope, editable: root.scope === 'project' && contained(path.join(cwd, '.agents/skills'), canonical) });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.set(file, { id: hash(file), name: entry.name, description: '', path: file, scope: root.scope, editable: false, issue: '无法读取受限SKILL.md' }); }
      }
    }
    return [...result.values()];
  }

  async readSkill(cwd: string, id: string): Promise<{ content: string; revision: string }> {
    const skill = (await this.listSkills(cwd)).find(item => item.id === id && !item.issue);
    if (!skill) throw new Error('Skill不存在或无法读取。');
    const content = await boundedText(skill.path, 64_000);
    return { content, revision: hash(content) };
  }

  async saveSkill(cwd: string, input: { name: string; content: string; revision?: string }): Promise<void> {
    return this.serialize(async () => {
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(input.name) || Buffer.byteLength(input.content) > 64_000) throw new Error('Skill名称或大小无效。');
    const directory = path.join(cwd, '.agents/skills', input.name);
    let existing = directory;
    for (;;) {
      try {
        if (!contained(await realpath(cwd), await realpath(existing))) throw new Error('Skill目录超出项目。');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existing = path.dirname(existing);
      }
    }
    await mkdir(directory, { recursive: true });
    if (!contained(await realpath(cwd), await realpath(directory))) throw new Error('Skill目录超出项目。');
    const file = path.join(directory, 'SKILL.md');
    await this.saveText(file, input.content, input.revision);
    });
  }

  async enrich(session: Session, prompt: string): Promise<{ prompt: string; mcpServers: McpServerConfig[] }> {
    const skillIds = session.settings?.skillIds ?? [];
    const skills = await this.listSkills(session.cwd);
    const selected = [];
    for (const id of skillIds) {
      const skill = skills.find(item => item.id === id && !item.issue);
      if (!skill) throw new Error('选中的Skill已移动或无法读取，请重新选择。');
      const { content } = await this.readSkill(session.cwd, id);
      selected.push(`<selected_skill name=${JSON.stringify(skill.name)} source=${JSON.stringify(skill.path)}>\n${content}\n</selected_skill>`);
    }
    return { prompt: selected.length ? `${prompt}\n\n${selected.join('\n\n')}` : prompt, mcpServers: await this.servers(session.cwd) };
  }
}

export async function readDeepSeekBalance(): Promise<DeepSeekBalance> {
  const environment = await deepSeekChildEnvironment(process.env);
  const key = environment.DEEPSEEK_API_KEY;
  if (!key) throw new Error('未找到现有DeepSeek凭据。');
  const response = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`DeepSeek余额查询失败（${response.status}）。`);
  const amount = z.string().regex(/^-?\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value)));
  const values = z.object({ balance_infos: z.array(z.object({ currency: z.string().regex(/^[A-Z]{3}$/), total_balance: amount, granted_balance: amount, topped_up_balance: amount })).min(1) }).parse(await response.json()).balance_infos;
  if (new Set(values.map(value => value.currency)).size !== values.length) throw new Error('DeepSeek返回了重复币种余额。');
  const balances = values.map(value => ({ currency: value.currency, total: value.total_balance, granted: value.granted_balance, toppedUp: value.topped_up_balance }));
  const selected = balances.find(value => value.currency === 'CNY') ?? balances[0];
  return { ...selected, balances, checkedAt: new Date().toISOString() };
}
