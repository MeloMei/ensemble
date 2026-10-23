import type { ServerResponse } from 'node:http';
import type { BackendStreamError } from '../shared/backend';

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 5000;

export class BoundedEventStream {
  private blocked = false;
  private dirty = false;
  private disposed = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(private readonly response: ServerResponse, private readonly catchUp: () => void, private readonly released: () => void) {
    response.on('drain', this.drained);
    response.once('close', this.dispose);
    this.heartbeat = setInterval(() => {
      if (!this.blocked && !this.disposed) this.write(': heartbeat\n\n');
    }, 15000);
  }

  get paused(): boolean {
    if (this.blocked) this.dirty = true;
    return this.blocked || this.disposed;
  }

  send(event: string, value: unknown): void {
    if (this.paused) return;
    const data = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    if (Buffer.byteLength(data) > MAX_BUFFERED_BYTES) { this.frameTooLarge(); return; }
    this.write(data);
  }

  private frameTooLarge(): void {
    const error: BackendStreamError = { code: 'FRAME_TOO_LARGE', limitBytes: MAX_BUFFERED_BYTES };
    const data = `event: stream-error\ndata: ${JSON.stringify(error)}\n\n`;
    if (this.blocked || this.response.writableLength + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) { this.close(); return; }
    this.dispose();
    this.response.end(data);
  }

  private write(data: string): void {
    if (this.response.writableLength + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) { this.close(); return; }
    if (!this.response.write(data)) {
      this.blocked = true;
      this.drainTimer = setTimeout(() => this.close(), DRAIN_TIMEOUT_MS);
      this.drainTimer.unref();
    }
  }

  private readonly drained = (): void => {
    if (this.disposed) return;
    this.blocked = false; clearTimeout(this.drainTimer); this.drainTimer = undefined;
    if (this.dirty) { this.dirty = false; this.catchUp(); }
  };

  private readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.drainTimer); clearInterval(this.heartbeat);
    this.response.off('drain', this.drained);
    this.response.off('close', this.dispose);
    this.released();
  };

  close(): void { this.dispose(); this.response.destroy(); }
}
