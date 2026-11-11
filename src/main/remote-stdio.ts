import { connectBackend, type BackendClient } from './backend-client';
import { REMOTE_REPLY_BYTES, REMOTE_REQUEST_BYTES, remoteCreationInput, remoteRequest, type RemoteDeviceSnapshot, type RemoteReply, type RemoteRequest, type RemoteSessionSummary } from '../shared/remote-devices';
import type { Session, Snapshot } from '../shared/types';

function summarize(session: Session): RemoteSessionSummary {
  const { id, title, providerId, status, updatedAt, approvals } = session;
  return { id, title, providerId, status, updatedAt, pendingApprovals: approvals.length };
}

export async function callRemote(backend: BackendClient, request: RemoteRequest): Promise<RemoteDeviceSnapshot | undefined> {
  switch (request.action) {
    case 'send':
      await backend.call('workbench:send-prompt', request.sessionId, { text: request.text }, request.commandId, request.providerId);
      return;
    case 'approve':
      await backend.call('workbench:decide-approval', request.approvalId, request.choiceId, request.commandId);
      return;
    case 'answer':
      await backend.call('workbench:answer-questions', request.approvalId, request.answers, request.commandId);
      return;
    case 'create': {
      const sessionId = await backend.call<string>('workbench:create-session', {
        title: request.title ?? '', cwd: request.cwd, providerId: request.providerId, commandId: request.commandId,
      });
      return remoteSnapshot(backend, sessionId);
    }
    case 'snapshot': return remoteSnapshot(backend, request.sessionId);
  }
}

async function remoteSnapshot(backend: BackendClient, sessionId?: string): Promise<RemoteDeviceSnapshot> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const snapshot = await backend.request<Snapshot>(`/snapshot${query}`);
  const recent = snapshot.sessions.filter(session => !session.archived)
    .sort((left, right) => Number(Boolean(right.approvals.length)) - Number(Boolean(left.approvals.length)) || right.updatedAt.localeCompare(left.updatedAt));
  const selected = recent.find(session => session.id === sessionId);
  const projects = new Map<string, string>();
  for (const { archived, cwd, name } of snapshot.workspaces) {
    if (projects.size >= 200) break;
    if (!archived && !projects.has(cwd) && remoteCreationInput.shape.cwd.safeParse(cwd).success) projects.set(cwd, name.slice(0, 200));
  }
  return {
    sessions: recent.slice(0, 200).map(summarize), limited: recent.length > 200,
    creation: {
      projects: [...projects].map(([cwd, name]) => ({ name, cwd })),
      runtimes: snapshot.providers.filter(provider => provider.available).slice(0, 200)
        .map(({ id, name }) => ({ id, name: name.slice(0, 200) })),
    },
    ...(selected ? { selected: {
      session: summarize(selected), approvals: selected.approvals,
      messages: selected.messages.filter(message => message.role !== 'activity').slice(-40).map(({ id, role, text, createdAt }) =>
        ({ id, role, text: text.length > 12000 ? text.slice(0, 11999) + '…' : text, createdAt })),
    } } : {}),
  };
}

export async function serveRemoteStdio(dataPath: string): Promise<void> {
  let response: RemoteReply;
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > REMOTE_REQUEST_BYTES) throw new Error('远程请求超过大小限制。');
      chunks.push(chunk);
    }
    const request = remoteRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!request.success) throw new Error('远程请求格式无效。');
    const backend = await connectBackend(dataPath);
    const snapshot = await callRemote(backend, request.data);
    response = { version: 1, ok: true, snapshot };
  } catch (error) {
    response = { version: 1, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
  const body = JSON.stringify(response);
  const output = Buffer.byteLength(body) <= REMOTE_REPLY_BYTES ? body
    : JSON.stringify({ version: 1, ok: false, error: '远程会话超过读取上限。' } satisfies RemoteReply);
  process.stdout.write(output + '\n');
}
