import type { FileContent, UnsavedFileSummary, Workspace } from '../shared/types';

interface FileDraft { original: FileContent; text: string; workspaceName: string; editVersion: number }
type WriteFile = (input: { path: string; content: string; revision: string }) => Promise<FileContent>;

export class FileDraftStore {
  private entries = new Map<string, FileDraft>();
  private saves = new Map<string, Promise<FileContent>>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private editVersion = 0;

  constructor(private changed: (summary: UnsavedFileSummary) => void) {}

  get(workspaceId: string, path: string): FileDraft | undefined { return this.entries.get(this.key(workspaceId, path)); }
  getSnapshot = (): number => this.revision;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  isSaving(workspaceId: string, path: string): boolean { return this.saves.has(this.key(workspaceId, path)); }

  open(workspace: Pick<Workspace, 'id' | 'name'>, original: FileContent, expected: FileDraft | undefined, discard = false): FileDraft {
    const key = this.key(workspace.id, original.path);
    const current = this.entries.get(key);
    if (current && (current !== expected || this.saves.has(key) || (!discard && current.text !== current.original.content))) return current;
    const entry = { original, text: original.content, workspaceName: workspace.name, editVersion: ++this.editVersion };
    this.entries.set(key, entry);
    this.publish();
    return entry;
  }

  edit(workspaceId: string, path: string, text: string): void {
    const current = this.require(workspaceId, path);
    this.entries.set(this.key(workspaceId, path), { ...current, text, editVersion: ++this.editVersion });
    this.publish();
  }

  save(workspaceId: string, path: string, write: WriteFile): Promise<FileContent> {
    const key = this.key(workspaceId, path);
    const submitted = this.require(workspaceId, path);
    const operation = (this.saves.get(key) ?? Promise.resolve()).then(async () => {
      const baseline = this.require(workspaceId, path).original;
      const written = await write({ path, content: submitted.text, revision: baseline.revision });
      const latest = this.require(workspaceId, path);
      this.entries.set(key, { ...latest, original: written, text: latest.editVersion === submitted.editVersion ? written.content : latest.text });
      this.publish();
      return written;
    });
    this.saves.set(key, operation);
    this.publish();
    const settled = () => {
      if (this.saves.get(key) === operation) { this.saves.delete(key); this.publish(); }
    };
    void operation.then(settled, settled);
    return operation;
  }

  private require(workspaceId: string, path: string): FileDraft {
    const entry = this.get(workspaceId, path);
    if (!entry) throw new Error('File buffer is not open.');
    return entry;
  }

  private key(workspaceId: string, path: string): string { return JSON.stringify([workspaceId, path]); }
  private publish(): void {
    const unsettled = [...this.entries].filter(([key, entry]) => this.saves.has(key) || entry.text !== entry.original.content).map(([, entry]) => entry);
    this.changed({ count: unsettled.length, names: unsettled.slice(0, 8).map(draft => `${draft.workspaceName} · ${draft.original.path}`) });
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
