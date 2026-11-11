import type { SessionAttentionOpen } from '../shared/types';

const prefix = 'ensemble-notification://session?';
const targetKeys = ['sessionId', 'reason', 'revision', 'approvalId', 'messageId'] as const;
const recordId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/u;
const argumentPrefix = '--ensemble-notification=';

export function notificationLinkFromArguments(argv: readonly string[]): string | undefined {
  const matches = argv.filter(argument => argument.startsWith(argumentPrefix));
  if (matches.length !== 1) return;
  const link = matches[0].slice(argumentPrefix.length);
  if (parseNotificationLink(link)) return link;
}

export function parseNotificationLink(input: string): SessionAttentionOpen | undefined {
  if (!input.startsWith(prefix) || input.length > 4096 || /[\p{C}\s#]|%(?![\da-f]{2})/iu.test(input)) return;
  const fields = new Map<string, string>();
  try {
    for (const pair of input.slice(prefix.length).split('&')) {
      const delimiter = pair.indexOf('=');
      if (delimiter < 1) return;
      const name = pair.slice(0, delimiter);
      if (!targetKeys.some(key => key === name) || fields.has(name)) return;
      fields.set(name, decodeURIComponent(pair.slice(delimiter + 1)));
    }
  } catch { return; }
  const sessionId = fields.get('sessionId');
  const reason = fields.get('reason');
  const approvalId = fields.get('approvalId');
  const messageId = fields.get('messageId');
  const rawRevision = fields.get('revision');
  if (!sessionId || !recordId.test(sessionId) || (reason !== 'approval' && reason !== 'result' && reason !== 'failure')) return;
  const revision = rawRevision === undefined ? undefined : Number(rawRevision);
  if (rawRevision !== undefined && (!/^[1-9]\d*$/u.test(rawRevision) || !Number.isSafeInteger(revision))) return;
  if (reason === 'approval') {
    if (!approvalId || !recordId.test(approvalId) || messageId !== undefined) return;
  } else if (approvalId !== undefined || (messageId !== undefined && (!messageId.length || messageId.length > 1024 || /\p{Cc}/u.test(messageId)))) return;
  return { sessionId, reason, ...(revision !== undefined ? { revision } : {}),
    ...(approvalId !== undefined ? { approvalId } : {}), ...(messageId !== undefined ? { messageId } : {}) };
}

export function notificationLink(target: SessionAttentionOpen): string {
  const encode = (includeMessage: boolean) => prefix + targetKeys.flatMap(key => {
    const value = target[key];
    return value === undefined || (!includeMessage && key === 'messageId') ? [] : [`${key}=${encodeURIComponent(String(value))}`];
  }).join('&');
  const link = encode(true);
  return parseNotificationLink(link) ? link : encode(false);
}
