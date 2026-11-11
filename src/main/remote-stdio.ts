import { connectBackend, type BackendClient } from './backend-client';
import { REMOTE_REPLY_BYTES, REMOTE_REQUEST_BYTES, remoteRequest, type RemoteDeviceSnapshot, type RemoteReply, type RemoteRequest, type RemoteSessionSummary } from '../shared/remote-devices';
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
    case 'snapshot': {
      const query = request.sessionId ? `?session=${encodeURIComponent(request.sessionId)}` : '';
      const snapshot = await backend.request<Snapshot>(`/snapshot${query}`);
      const recent = snapshot.sessions.filter(session => !session.archived)
        .sort((left, right) => Number(Boolean(right.approvals.length)) - Number(Boolean(left.approvals.length)) || right.updatedAt.localeCompare(left.updatedAt));
      const selected = recent.find(session => session.id === request.sessionId);
      return { sessions: recent.slice(0, 200).map(summarize), limited: recent.length > 200,
        ...(selected ? { selected: {
          session: summarize(selected), approvals: selected.approvals,
          messages: selected.messages.filter(message => message.role !== 'activity').slice(-40).map(({ id, role, text, createdAt }) =>
            ({ id, role, text: text.length > 12000 ? text.slice(0, 11999) + '…' : text, createdAt })),
        } } : {}) };
    }
  }
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
