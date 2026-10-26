import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { McpServerConfig, Session } from '../../shared/types';
import type { TurnContext } from './types';
import { abortError } from './json-rpc';
import { processText } from './provider-events';

type Decision = 'allow' | 'deny' | 'ask';
type Policy = (tool: ToolCallUpdate, session: Session, servers: McpServerConfig[]) => Decision;
const MAX_BYTES = 256_000;
type HookPhase = 'preToolUse' | 'beforeMCPExecution';
const kinds: Record<string, NonNullable<ToolCallUpdate['kind']>> = { Read: 'read', Grep: 'search', Glob: 'search', List: 'search',
  SemanticSearch: 'search', WebSearch: 'search', WebFetch: 'fetch', Fetch: 'fetch', ReadLints: 'read', ReadTodos: 'read', Shell: 'execute',
  Write: 'edit', Edit: 'edit', Delete: 'delete', SwitchMode: 'switch_mode', Task: 'other', WriteShellStdin: 'execute',
  AskQuestion: 'other', CreatePlan: 'other', UpdateTodos: 'other', GenerateImage: 'edit', GenerateVideo: 'edit' };
const interactions: Record<string, string> = { AskQuestion: 'askQuestion', CreatePlan: 'createPlan', UpdateTodos: 'updateTodos' };
const inputSchema = z.object({ tool_name: z.string().min(1).max(256), tool_use_id: z.string().min(1).max(256),
  tool_input: z.union([z.record(z.unknown()), z.string()]), conversation_id: z.string().max(256).optional(),
  mcp_server_name: z.string().min(1).max(256).optional() }).passthrough();
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function cursorHookTool(value: unknown, phase: HookPhase = 'preToolUse'): ToolCallUpdate {
  const input = inputSchema.parse(value);
  const parameters = z.record(z.unknown()).parse(typeof input.tool_input === 'string' ? JSON.parse(input.tool_input) : input.tool_input);
  if (phase === 'beforeMCPExecution') {
    if (!input.mcp_server_name) throw new Error('Cursor MCP 工具没有提供服务器身份。');
    return { toolCallId: input.tool_use_id, name: `MCP:${input.tool_name}`, title: `${input.mcp_server_name}: ${input.tool_name}`, kind: 'other',
      rawInput: { providerIdentifier: input.mcp_server_name, toolName: input.tool_name, args: parameters } };
  }
  return { toolCallId: input.tool_use_id, name: input.tool_name, title: input.tool_name, kind: kinds[input.tool_name] ?? 'other',
    rawInput: { ...parameters, ...(interactions[input.tool_name] ? { _toolName: interactions[input.tool_name] } : {}) } };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function approvalKey(tool: ToolCallUpdate): string {
  const input = tool.rawInput as Record<string, unknown> | undefined;
  const identity = input && typeof input.providerIdentifier === 'string' && typeof input.toolName === 'string'
    ? ['mcp', input.providerIdentifier, input.toolName, input.args] : [tool.toolCallId, tool.kind, input];
  return createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
}

async function userConfiguration(name: string): Promise<Record<string, unknown> | undefined> {
  const directory = process.env.CURSOR_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'cursor') : join(homedir(), '.cursor'));
  const file = join(directory, name);
  try {
    if ((await stat(file)).size > MAX_BYTES) throw new Error('Cursor CLI 配置超过大小限制。');
    const content = await readFile(file, 'utf8');
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Cursor CLI 配置超过大小限制。');
    return z.record(z.unknown()).parse(JSON.parse(content));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}

async function userSettings(): Promise<Record<string, unknown>> {
  const value = await userConfiguration('cli-config.json') ?? {};
  const preserved = Object.fromEntries(['model', 'maxMode', 'hasChangedDefaultModel', 'modelParameters', 'parameterizedModel', 'bedrock', 'privacyCache', 'authInfo', 'network', 'sandbox']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const permissions = value.permissions && typeof value.permissions === 'object' ? value.permissions as Record<string, unknown> : {};
  return { ...preserved, version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: z.array(z.string()).parse(permissions.deny ?? []) },
    approvalMode: 'allowlist', autoAcceptWebSearch: false };
}

export async function createCursorGuard(dataPath: string, session: Session, servers: McpServerConfig[], context: TurnContext, policy: Policy): Promise<{
  configDirectory: string; pluginDirectory: string;
  permissionDecision(tool: ToolCallUpdate): Decision;
  cleanup(): Promise<void>;
}> {
  if (context.signal.aborted) throw abortError();
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-cursor-guard-'));
  const configDirectory = join(directory, 'config');
  const pluginDirectory = join(directory, 'plugin');
  const controllers = new Set<AbortController>();
  const approved = new Map<string, number>();
  const token = randomBytes(32).toString('hex');
  let closing = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (closing || context.signal.aborted || request.method !== 'POST' || request.url !== '/tool' || request.headers.origin !== undefined
      || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end('{"permission":"deny"}'); return; }
    const phase = request.headers['x-ensemble-hook'];
    if (phase !== 'preToolUse' && phase !== 'beforeMCPExecution') { response.writeHead(400).end('{"permission":"deny"}'); return; }
    const controller = new AbortController(); controllers.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnected);
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_BYTES) throw new Error('Cursor 工具请求超过大小限制。'); chunks.push(chunk); }
      const input = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const tool = cursorHookTool(input, phase);
      if (session.externalId && input.conversation_id && input.conversation_id !== session.externalId) throw new Error('Cursor 工具请求不属于当前会话。');
      // Native MCP executes its identity-bearing beforeMCPExecution hook before the tool executor.
      const decision = phase === 'preToolUse' && input.tool_name.startsWith('MCP:') ? 'allow'
        : phase === 'preToolUse' && !Object.hasOwn(kinds, input.tool_name) ? 'deny' : policy(tool, session, servers);
      let allowed = decision === 'allow';
      let grant: string | undefined;
      if (decision === 'ask') {
        const choice = await context.approve({ title: '允许 Cursor 执行工具？', detail: `${tool.title}\n${processText(input.tool_input, MAX_BYTES) ?? ''}`,
          choices: [{ id: 'allow', label: '允许一次' }, { id: 'deny', label: '拒绝' }] }, AbortSignal.any([context.signal, controller.signal, AbortSignal.timeout(3_600_000)]));
        allowed = choice === 'allow';
        if (allowed) grant = approvalKey(tool);
      }
      if (closing || controller.signal.aborted || context.signal.aborted) allowed = false;
      if (allowed && grant) response.once('finish', () => {
        if (closing || controller.signal.aborted || context.signal.aborted) return;
        if (approved.size >= 1024) approved.delete(approved.keys().next().value!);
        approved.set(grant!, (approved.get(grant!) ?? 0) + 1);
      });
      response.end(JSON.stringify({ permission: allowed ? 'allow' : 'deny', ...(!allowed ? { user_message: 'Ensemble 已拒绝该工具操作。', agent_message: 'The requested tool was denied by Ensemble permissions.' } : {}) }));
    } catch { if (!response.writableEnded) response.end('{"permission":"deny","agent_message":"Ensemble could not confirm tool permission."}'); }
    finally { response.off('close', disconnected); controllers.delete(controller); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  const abort = () => { approved.clear(); for (const controller of controllers) controller.abort(); };
  context.signal.addEventListener('abort', abort, { once: true });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    closing = true; approved.clear(); context.signal.removeEventListener('abort', abort); abort();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  })();
  try {
    await Promise.all([mkdir(configDirectory, { mode: 0o700 }), mkdir(join(pluginDirectory, '.cursor-plugin'), { recursive: true, mode: 0o700 })]);
    const sessions = join(dataPath, 'runtimes', 'cursor', 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await symlink(sessions, join(configDirectory, 'acp-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(configDirectory, 'cli-config.json'), JSON.stringify(await userSettings()), { mode: 0o600, flag: 'wx' });
    const acp = await userConfiguration('acp-config.json');
    if (typeof acp?.selectedModelVariantId === 'string') await writeFile(join(configDirectory, 'acp-config.json'),
      JSON.stringify({ selectedModelVariantId: acp.selectedModelVariantId }), { mode: 0o600, flag: 'wx' });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Cursor 工具守卫未就绪。');
    const connection = { endpoint: `http://127.0.0.1:${address.port}/tool`, token };
    const connectionPath = join(directory, 'connection.json');
    const scriptPath = join(directory, 'guard.mjs');
    await writeFile(connectionPath, JSON.stringify(connection), { mode: 0o600, flag: 'wx' });
    await writeFile(scriptPath, `import {readFile} from 'node:fs/promises';
let bytes=0;const chunks=[];
try {
  for await (const chunk of process.stdin) { bytes+=chunk.length; if(bytes>${MAX_BYTES})throw Error('Request too large');chunks.push(chunk); }
  const config=JSON.parse(await readFile(${JSON.stringify(connectionPath)},'utf8'));
  const result=await fetch(config.endpoint,{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json','X-Ensemble-Hook':process.argv[2]},body:Buffer.concat(chunks),signal:AbortSignal.timeout(3600000)});
  if(!result.ok)throw Error('Permission channel unavailable');
  const decision=await result.json();if(!['allow','deny'].includes(decision.permission))throw Error('Invalid permission');
  process.stdout.write(JSON.stringify(decision));
} catch { process.stdout.write(JSON.stringify({permission:'deny',agent_message:'Ensemble tool guard unavailable; the tool is denied.'})); }
`, { mode: 0o600, flag: 'wx' });
    const command = `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
    await writeFile(join(pluginDirectory, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'ensemble-tool-permissions', version: '1.0.0',
      hooks: { version: 1, hooks: Object.fromEntries(['preToolUse', 'beforeMCPExecution'].map(phase => [phase,
        [{ command: `${command} ${phase}`, failClosed: true, timeout: 3600 }]])) } }), { mode: 0o600, flag: 'wx' });
    if (context.signal.aborted) throw abortError();
    return { configDirectory, pluginDirectory, permissionDecision(tool) {
      const decision = policy(tool, session, servers);
      if (decision === 'deny') return 'deny';
      const key = approvalKey(tool); const count = approved.get(key) ?? 0;
      if (count) { if (count === 1) approved.delete(key); else approved.set(key, count - 1); return 'allow'; }
      return decision;
    }, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
