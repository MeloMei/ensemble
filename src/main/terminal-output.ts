import type { TerminalOutputEvent } from '../shared/backend';

export const TERMINAL_OUTPUT_LIMIT = 256 * 1024;

export function terminalOutputTail(output: string): string {
  let bytes = 0;
  let start = output.length;
  while (start > 0) {
    const code = output.charCodeAt(start - 1);
    const pair = code >= 0xdc00 && code <= 0xdfff && start > 1
      && output.charCodeAt(start - 2) >= 0xd800 && output.charCodeAt(start - 2) <= 0xdbff;
    const width = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes + width > TERMINAL_OUTPUT_LIMIT) break;
    bytes += width; start -= pair ? 2 : 1;
  }
  return output.slice(start);
}

export class TerminalOutputBuffer {
  private chunks: { text: string; bytes: number }[] = [];
  private bytes = 0;
  private length = 0;
  private end = 0;

  append(data: string): void {
    if (!data) return;
    this.end += data.length;
    const bytes = Buffer.byteLength(data);
    if (bytes >= TERMINAL_OUTPUT_LIMIT) {
      const text = terminalOutputTail(data);
      this.bytes = Buffer.byteLength(text); this.length = text.length;
      this.chunks = [{ text, bytes: this.bytes }];
      return;
    }
    const last = this.chunks.at(-1);
    if (last && last.bytes + bytes <= 4096) { last.text += data; last.bytes += bytes; }
    else this.chunks.push({ text: data, bytes });
    this.bytes += bytes; this.length += data.length;
    while (this.bytes > TERMINAL_OUTPUT_LIMIT) {
      const first = this.chunks[0];
      const excess = this.bytes - TERMINAL_OUTPUT_LIMIT;
      if (first.bytes <= excess) {
        this.chunks.shift(); this.bytes -= first.bytes; this.length -= first.text.length;
        continue;
      }
      let start = 0, removedBytes = 0;
      while (removedBytes < excess) {
        const code = first.text.codePointAt(start)!;
        removedBytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        start += code < 0x10000 ? 1 : 2;
      }
      first.text = first.text.slice(start); first.bytes -= removedBytes;
      this.bytes -= removedBytes; this.length -= start;
    }
  }

  snapshot(): { output: string; outputOffset: number } {
    return { output: this.chunks.map(chunk => chunk.text).join(''), outputOffset: this.end - this.length };
  }
}

export class TerminalOutputCoalescer {
  private timer?: ReturnType<typeof setTimeout>;
  private pending = '';
  private offset = 0;
  private surrogate = '';
  private end = 0;
  private disposed = false;

  constructor(readonly terminalId: string, private readonly emit: (event: TerminalOutputEvent) => void,
    private readonly receive: (data: string) => void) {}

  append(value: string): void {
    if (this.disposed) return;
    let data = this.surrogate + value; this.surrogate = '';
    const last = data.charCodeAt(data.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) { this.surrogate = data.at(-1)!; data = data.slice(0, -1); }
    if (!data) return;
    this.receive(data);
    if (!this.timer) {
      this.emit({ type: 'append', terminalId: this.terminalId, data, offset: this.end });
      this.end += data.length;
      this.timer = setTimeout(() => this.flush(), 16);
      return;
    }
    if (!this.pending) this.offset = this.end;
    this.pending += data; this.end += data.length;
    if (Buffer.byteLength(this.pending) >= 64 * 1024) this.flush();
  }

  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.pending) return;
    const data = this.pending; this.pending = '';
    this.emit({ type: 'append', terminalId: this.terminalId, data, offset: this.offset });
  }

  dispose(): void { this.flush(); this.disposed = true; this.surrogate = ''; }
}
