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
