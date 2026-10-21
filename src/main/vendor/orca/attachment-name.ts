// Adapted from Orca src/shared/agent-session-attachments.ts:57-110 at 36913fd4f556c44495ed6da5cd6a81910c3cde21.
// Copyright (c) 2026 Lovecast Inc. MIT; see licenses/Orca-MIT.txt.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
const NAME_MAX_BYTES = 200;
function byteLength(text: string): number { return new TextEncoder().encode(text).byteLength; }
function truncateUtf8(text: string, maxBytes: number): string {
  let kept = '';
  let bytes = 0;
  for (const character of text) {
    bytes += byteLength(character);
    if (bytes > maxBytes) break;
    kept += character;
  }
  return kept;
}
export function sanitizeAttachmentName(name: string): string {
  const leaf = name.split(/[\\/]/).reverse().find(part => part.length > 0) ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  let visible = cleaned.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!visible.length) return 'attachment';
  const firstDot = visible.indexOf('.');
  if (WINDOWS_DEVICE_NAME.test(firstDot > 0 ? visible.slice(0, firstDot) : visible)) visible = `_${visible}`;
  if (byteLength(visible) <= NAME_MAX_BYTES) return visible;
  const extensionAt = visible.lastIndexOf('.');
  const extension = extensionAt > 0 && byteLength(visible.slice(extensionAt)) <= 16 ? visible.slice(extensionAt) : '';
  const stem = visible.slice(0, visible.length - extension.length);
  return (truncateUtf8(stem, NAME_MAX_BYTES - byteLength(extension)) + extension).replace(/[. ]+$/, '') || 'attachment';
}
