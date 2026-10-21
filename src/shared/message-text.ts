import type { Message } from './types';

export function searchableMessageText(message: Message): string {
  const event = message.event;
  return [message.text, ...(message.attachments ?? []).map(attachment => attachment.name),
    event?.title, event?.input, event?.output, event?.nativeId, event?.parentId,
    ...(event?.entries ?? []).map(entry => entry.text)].filter(Boolean).join('\n');
}
