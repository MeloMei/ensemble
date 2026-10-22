export class TerminalInputWriter {
  private pending = new Map<string, Promise<void>>();
  private drains = new Set<{ failed: boolean; error?: unknown }>();

  constructor(private send: (id: string, data: string) => Promise<void>) {}

  get hasPending(): boolean { return this.pending.size > 0; }

  write(id: string, data: string): Promise<void> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const operation = previous.then(() => this.send(id, data));
    this.pending.set(id, operation);
    const settled = () => { if (this.pending.get(id) === operation) this.pending.delete(id); };
    void operation.then(settled, error => {
      for (const drain of this.drains) if (!drain.failed) { drain.failed = true; drain.error = error; }
      settled();
    });
    return operation;
  }

  async flush(): Promise<void> {
    const drain: { failed: boolean; error?: unknown } = { failed: false };
    this.drains.add(drain);
    try {
      while (this.pending.size) await Promise.allSettled(this.pending.values());
      if (drain.failed) throw drain.error;
    } finally { this.drains.delete(drain); }
  }
}
