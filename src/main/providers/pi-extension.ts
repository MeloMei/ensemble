import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIssuedWorkbenchMcpServer } from '../collaboration-server';
import { WORKBENCH_MCP_TOOLS } from './mcp-configuration';
import type { TurnContext } from './types';

export const PI_MCP_READY_TIMEOUT_MS = 30_000;

function literalConfigValue(value: string): string {
  const escaped = value.replace(/\$/g, () => '$$');
  return escaped.startsWith('!') ? `$!${escaped.slice(1)}` : escaped;
}

function literalValues(values: Record<string, string> | undefined): Record<string, string> | undefined {
  return values && Object.fromEntries(Object.entries(values).map(([name, value]) => [name, literalConfigValue(value)]));
}

export async function createPiExtension(context: TurnContext, sdkEntry: string): Promise<{
  path: string; command: string; readyMarker: string; cleanup(): Promise<void>;
}> {
  const names = new Set<string>();
  const expected: string[] = [];
  const servers = (context.mcpServers ?? []).map(server => {
    if (server.type === 'sse') throw new Error(`Pi 不支持 SSE MCP：${server.name}。请选择 stdio 或 HTTP。`);
    const namespace = server.name.replace(/[^A-Za-z0-9_]/g, '_');
    if (names.has(namespace)) throw new Error(`Pi MCP 服务名称冲突：${server.name}。`);
    names.add(namespace);
    const issued = isIssuedWorkbenchMcpServer(server);
    if (issued) expected.push(...WORKBENCH_MCP_TOOLS.map(tool => `mcp__workbench__${tool}`));
    const transport = server.type === 'stdio'
      ? { type: 'stdio', command: server.command, args: server.args, ...(server.env ? { env: literalValues(server.env) } : {}) }
      : { type: 'http', url: server.url, ...(server.headers ? { headers: literalValues(server.headers) } : {}) };
    return { name: server.name, config: { ...transport, exposure: issued ? 'hidden' : 'direct', ...(issued ? {
      toolExposure: Object.fromEntries(WORKBENCH_MCP_TOOLS.map(tool => [tool, 'direct'])),
    } : {}) } };
  });
  const command = `ensemble-ready-${randomUUID()}`;
  const readyMarker = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-pi-'));
  const configPath = join(directory, 'config.json');
  const extensionPath = join(directory, 'extension.mjs');
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(configPath, JSON.stringify({ command, readyMarker, servers, expected,
      readOnly: context.session.settings?.permission === 'read-only', timeoutMs: PI_MCP_READY_TIMEOUT_MS }), { flag: 'wx', mode: 0o600 });
    await writeFile(extensionPath, `import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createMcpExtension} from ${JSON.stringify(pathToFileURL(sdkEntry).href)};

export default async function ensemble(pi) {
  const config = JSON.parse(await readFile(${JSON.stringify(configPath)}, 'utf8'));
  const expected = new Set(config.expected);
  const readable = new Set(['read', 'grep', 'find', 'ls']);
  let ready = false;
  const toolsPresent = () => {
    const tools = new Set(pi.getActiveTools());
    return [...expected].every(name => tools.has(name));
  };
  const report = (ctx, result) => ctx.ui.notify(JSON.stringify({marker: config.readyMarker, ...result}), result.ready ? 'info' : 'error');
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (!ready || !toolsPresent()) return {block: true, terminate: true, reason: 'Ensemble Pi 工具守卫尚未就绪。'};
      if (readable.has(event.toolName) || expected.has(event.toolName)) return;
      if (config.readOnly) return {block: true, terminate: true, reason: 'Ensemble 只读模式拒绝该工具：' + event.toolName};
      const allowed = await ctx.ui.confirm('允许 Pi 执行工具？', event.toolName + '\\n' + JSON.stringify(event.input).slice(0, 16000));
      if (!allowed) return {block: true, terminate: true, reason: '用户拒绝该工具调用。'};
    } catch {
      return {block: true, terminate: true, reason: 'Ensemble 无法确认工具权限，已停止该工具。'};
    }
  });
  pi.on('input', (_event, ctx) => {
    if (!ready || !toolsPresent()) {
      ready = false;
      report(ctx, {ready: false, error: 'Ensemble Pi MCP 或工具守卫尚未就绪，任务未发送。'});
      return {action: 'handled'};
    }
    return {action: 'continue'};
  });
  await createMcpExtension({loadConfig: () => ({servers: [], errors: [], autoEnableCodemode: false})})(pi);
  for (const server of config.servers) pi.registerMcpServer(server.name, server.config);
  pi.registerCommand(config.command, {description: 'Check Ensemble tool permissions and collaboration readiness', handler: async (_args, ctx) => {
    const deadline = Date.now() + config.timeoutMs;
    while (!toolsPresent() && Date.now() < deadline) await delay(25);
    ready = toolsPresent();
    report(ctx, ready ? {ready: true, guard: true} : {ready: false, error: 'Ensemble MCP 工具未在30秒内完成原生注册，任务未发送。'});
  }});
}
`, { flag: 'wx', mode: 0o600 });
    return { path: extensionPath, command, readyMarker, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
