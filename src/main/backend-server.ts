import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendEndpoint } from '../shared/backend';
import type { Snapshot } from '../shared/types';
import { createWorkbenchService, type WorkbenchService } from './workbench-service';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWorkbenchMcpServer } from './mcp-server';

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
  const streams = new Set<ServerResponse>();
  const token = randomBytes(32).toString('hex');
  let service: WorkbenchService | undefined;
  let closed = false;
  const publish = (snapshot: Snapshot) => {
    const data = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const stream of streams) {
      if (stream.writableLength > 16 * 1024 * 1024) { stream.destroy(); streams.delete(stream); }
      else stream.write(data);
    }
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
      if (request.method === 'GET' && request.url === '/health') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ instanceId, ready: !!service })); return;
      }
      if (!service || closed) throw new Error('后台尚未就绪。');
      if (request.method === 'GET' && request.url === '/commands') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ result: service.commands })); return;
      }
      if (request.method === 'GET' && request.url === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        streams.add(response);
        response.write(`event: snapshot\ndata: ${JSON.stringify(service.snapshot())}\n\n`);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
        request.on('close', () => { clearInterval(heartbeat); streams.delete(response); }); return;
      }
      if (request.method !== 'POST' || request.url !== '/command') { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error('后台请求超过大小限制。');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command: unknown; args: unknown };
      if (typeof body.command !== 'string' || !Array.isArray(body.args) || body.args.length > 8) throw new Error('后台命令格式无效。');
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
    service = await createWorkbenchService({ ...options, publish });
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
        for (const stream of streams) stream.end(); streams.clear();
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
