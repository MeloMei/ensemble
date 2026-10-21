import { TextDecoder } from 'node:util';

export const MAX_NDJSON_FRAME_BYTES = 1024 * 1024;

export function createNdjsonDecoder(
  onRecord: (record: unknown) => void,
  maxLineBytes = MAX_NDJSON_FRAME_BYTES,
): { feed(chunk: Buffer | string): void; end(): void } {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new Error('NDJSON frame limit must be a positive integer');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let segments: Buffer[] = [];
  let length = 0;
  let ended = false;

  function append(segment: Buffer): void {
    if (length + segment.length > maxLineBytes) {
      throw new Error(`NDJSON frame exceeds ${maxLineBytes} bytes`);
    }
    if (segment.length) {
      segments.push(segment);
      length += segment.length;
    }
  }

  function emit(): void {
    const bytes = segments.length === 1 ? segments[0] : Buffer.concat(segments, length);
    segments = [];
    length = 0;
    const line = decoder.decode(bytes).trim();
    if (line) onRecord(JSON.parse(line));
  }

  return {
    feed(chunk) {
      if (ended) throw new Error('NDJSON decoder is closed');
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      let start = 0;
      for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, start)) {
        append(bytes.subarray(start, index));
        start = index + 1;
        emit();
      }
      append(bytes.subarray(start));
    },
    end() {
      if (ended) return;
      ended = true;
      if (length) emit();
    },
  };
}
