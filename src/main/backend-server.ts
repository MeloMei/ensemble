import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendEndpoint, TerminalOutputEvent } from '../shared/backend';
import { BACKEND_STREAM_VERSION } from '../shared/backend';
import type { Snapshot } from '../shared/types';
import { createWorkbenchService, type WorkbenchService } from './workbench-service';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWorkbenchMcpServer } from './mcp-server';
import { SnapshotProjection } from './snapshot-projection';
import { BoundedEventStream } from './bounded-event-stream';

function sessionIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 8 || input.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('会话订阅格式无效。');
  return [...new Set(input)] as string[];
}

async function readBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2_000_000) throw new Error('后台请求超过大小限制。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function saveEndpoint(path: string, endpoint: BackendEndpoint): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(endpoint)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { server.off('error', failed); server.off('listening', ready); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const ready = () => { cleanup(); resolve(); };
    server.once('error', failed); server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}

export async function startBackend(options: {
  dataPath: string; command: string; bridgePath: string;
  providers?: Parameters<typeof createWorkbenchService>[0]['providers'];
}) {
  await mkdir(options.dataPath, { recursive: true, mode: 0o700 });
  const instanceId = randomUUID();
  const endpointPath = join(options.dataPath, 'backend.json');
  let port = 0;
  try {
    const previous = JSON.parse(await readFile(endpointPath, 'utf8')) as Partial<BackendEndpoint> | null;
    if (previous?.version === 1 && typeof previous.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(previous.url)) {
      const candidate = Number(previous.url.slice(previous.url.lastIndexOf(':') + 1));
      if (candidate > 0 && candidate <= 65535) port = candidate;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const streams = new Map<string, { writer: BoundedEventStream; projection: SnapshotProjection }>();
  const terminalStreams = new Set<{ terminalId: string; writer: BoundedEventStream }>();
  const token = randomBytes(32).toString('hex');
  let service: WorkbenchService | undefined;
  let closed = false;
  let revision = 0;
  const publish = (snapshot: Snapshot) => {
    revision++;
    for (const { writer, projection } of streams.values()) {
      if (writer.paused) continue;
      const frame = projection.frame(snapshot, revision);
      if (frame) writer.send('snapshot', frame);
    }
  };
  const publishTerminal = (event: TerminalOutputEvent) => {
    for (const stream of terminalStreams) if (stream.terminalId === event.terminalId) stream.writer.send('terminal', { ...event, instanceId });
  };
  const server = createServer(async (request, response) => {
    if (request.headers.origin) {
      response.writeHead(403).end(); return;
    }
    try {
      if (request.url === '/mcp') {
        const credential = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
        try { service?.authenticate(credential); if (!service || closed) throw new Error('后台尚未就绪。'); }
        catch { response.writeHead(403).end(); return; }
        const mcp = createWorkbenchMcpServer((tool, input) => service!.externalCall(credential, tool, input));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        response.once('close', () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && request.url === '/health') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ instanceId, ready: !!service, streamVersion: BACKEND_STREAM_VERSION })); return;
      }
      if (!service || closed) throw new Error('后台尚未就绪。');
      if (request.method === 'GET' && request.url === '/commands') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ result: service.commands })); return;
      }
      if (request.method === 'GET' && url.pathname === '/snapshot') {
        const ids = sessionIds(url.searchParams.getAll('session'));
        const projection = new SnapshotProjection(instanceId, '', new Set(ids));
        const frame = projection.frame(service.streamSnapshot(), revision)!;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ result: frame.type === 'reset' ? frame.snapshot : null })); return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        const ids = sessionIds(url.searchParams.getAll('session'));
        const id = randomUUID();
        const projection = new SnapshotProjection(instanceId, id, new Set(ids));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const writer = new BoundedEventStream(response, () => {
          projection.reset();
          const frame = projection.frame(service!.streamSnapshot(), revision);
          if (frame) writer.send('snapshot', frame);
        }, () => streams.delete(id));
        const entry = { writer, projection };
        streams.set(id, entry);
        writer.send('snapshot', projection.frame(service.streamSnapshot(), revision));
        return;
      }
      if (request.method === 'POST' && request.url === '/watch') {
        const body = await readBody(request) as { subscriptionId?: unknown; sessionIds?: unknown };
        const stream = typeof body?.subscriptionId === 'string' ? streams.get(body.subscriptionId) : undefined;
        if (!stream) throw new Error('后台订阅已结束。');
        const ids = sessionIds(body.sessionIds);
        stream.projection.watch(ids);
        if (!stream.writer.paused) stream.writer.send('snapshot', stream.projection.frame(service.streamSnapshot(), revision));
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ result: null })); return;
      }
      if (request.method === 'GET' && url.pathname === '/terminal-events') {
        const terminalId = url.searchParams.get('id');
        if (!terminalId || terminalId.length > 200) throw new Error('终端订阅格式无效。');
        const tail = () => {
          const terminal = service!.terminalSnapshot(terminalId);
          writer.send('terminal', { type: 'tail', terminalId, output: terminal.output, outputOffset: terminal.outputOffset, instanceId });
        };
        service.terminalSnapshot(terminalId);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const writer = new BoundedEventStream(response, tail, () => terminalStreams.delete(entry));
        const entry = { terminalId, writer }; terminalStreams.add(entry); tail(); return;
      }
      if (request.method !== 'POST' || request.url !== '/command') { response.writeHead(404).end(); return; }
      const body = await readBody(request) as { command: unknown; args: unknown; undefinedArgs?: unknown };
      if (typeof body.command !== 'string' || !Array.isArray(body.args) || body.args.length > 8) throw new Error('后台命令格式无效。');
      if (body.undefinedArgs !== undefined) {
        if (!Array.isArray(body.undefinedArgs) || body.undefinedArgs.length > body.args.length
          || body.undefinedArgs.some(index => !Number.isInteger(index) || index < 0 || index >= (body.args as unknown[]).length || (body.args as unknown[])[index] !== null)) throw new Error('后台命令可选参数无效。');
        for (const index of body.undefinedArgs) body.args[index] = undefined;
      }
      const result = await service.call(body.command, body.args);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ result: result ?? null }));
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : '后台命令失败。' }));
    }
  });
  try {
    service = await createWorkbenchService({ ...options, publish, publishTerminal });
    try { await listen(server, port); }
    catch (error) {
      if (!port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await listen(server, 0);
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('后台地址无效。');
    const endpoint: BackendEndpoint = { version: 1, url: `http://127.0.0.1:${address.port}`, token, pid: process.pid, instanceId, startedAt: new Date().toISOString() };
    service.setPublicEndpoint(endpoint.url);
    await saveEndpoint(endpointPath, endpoint);
    return {
      endpoint, service,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        for (const stream of streams.values()) stream.writer.close(); streams.clear();
        for (const stream of terminalStreams) stream.writer.close(); terminalStreams.clear();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        const results = await Promise.allSettled([saveEndpoint(endpointPath, { ...endpoint, stoppedAt: new Date().toISOString() })]);
        results.push(...await Promise.allSettled([service!.shutdown()]));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), '后台关闭失败');
      },
    };
  } catch (error) {
    server.close();
    await service?.shutdown().catch(() => {});
    throw error;
  }
}
