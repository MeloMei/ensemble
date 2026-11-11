import type { PromptAttachment, ProviderInfo } from './types';

export const ATTACHMENT_LIMITS = { count: 4, imageBytes: 4 * 1024 * 1024, textBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 } as const;

export function supportsPromptAttachment(provider: ProviderInfo | undefined, kind: PromptAttachment['kind']): boolean {
  const capabilities = provider?.declaredCapabilities ?? provider?.capabilities;
  if (provider?.source === 'acp') return capabilities?.[kind === 'image' ? 'images' : 'textAttachments'] === true;
  return provider?.source !== 'plugin' || (provider.protocolVersion === 2
    && capabilities?.[kind === 'image' ? 'images' : 'textAttachments'] === true);
}

export function attachmentLimitIssue(attachments: Pick<PromptAttachment, 'size'>[]): 'count' | 'totalBytes' | undefined {
  if (attachments.length > ATTACHMENT_LIMITS.count) return 'count';
  if (attachments.reduce((total, attachment) => total + attachment.size, 0) > ATTACHMENT_LIMITS.totalBytes) return 'totalBytes';
}
