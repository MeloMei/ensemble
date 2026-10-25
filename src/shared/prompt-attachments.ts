import type { PromptAttachment } from './types';

export const ATTACHMENT_LIMITS = { count: 4, imageBytes: 4 * 1024 * 1024, textBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 } as const;

export function attachmentLimitIssue(attachments: Pick<PromptAttachment, 'size'>[]): 'count' | 'totalBytes' | undefined {
  if (attachments.length > ATTACHMENT_LIMITS.count) return 'count';
  if (attachments.reduce((total, attachment) => total + attachment.size, 0) > ATTACHMENT_LIMITS.totalBytes) return 'totalBytes';
}
