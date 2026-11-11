import type { FileContent, UnsavedFileSummary, Workspace } from '../shared/types';

interface FileDraft {
  original: FileContent;
  text: string;
  workspaceId: string;
  workspaceName: string;
  editVersion: number;
  autoSaveBlock?: 'discard' | { error: string };
  diskStatus?: 'changed' | 'missing' | 'unreadable';
}
type DiskObservation = FileContent | 'missing' | 'unreadable';
type WriteFile = (input: { path: string; content: string; revision: string }) => Promise<FileContent>;
interface AutoSaveOptions { delay: number; write: (workspaceId: string, input: Parameters<WriteFile>[0]) => Promise<FileContent> }

export class FileDraftStore {
  private entries = new Map<string, FileDraft>();
  private saves = new Map<string, Promise<FileContent>>();
  private autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autoSaveEnabled = false;
  private listeners = new Set<() => void>();
  private autoSavedListeners = new Set<(workspaceId: string) => void>();
  private revision = 0;
  private editVersion = 0;

  constructor(private changed: (summary: UnsavedFileSummary) => void, private autoSave?: AutoSaveOptions) {}

  get(workspaceId: string, path: string): FileDraft | undefined { return this.entries.get(this.key(workspaceId, path)); }
  getSnapshot = (): number => this.revision;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  subscribeAutoSaved(listener: (workspaceId: string) => void): () => void {
    this.autoSavedListeners.add(listener);
    return () => { this.autoSavedListeners.delete(listener); };
  }
  isSaving(workspaceId: string, path: string): boolean { return this.saves.has(this.key(workspaceId, path)); }
  hasUnsettledEdits(): boolean {
    return this.saves.size > 0 || [...this.entries.values()].some(draft => draft.text !== draft.original.content);
  }

  setAutoSave(enabled: boolean): void {
    if (this.autoSaveEnabled === enabled) return;
    this.autoSaveEnabled = enabled;
    for (const [key, entry] of this.entries) this.scheduleAutoSave(key, entry);
  }

  suspendAutoSaveForDiscard(workspaceId: string, path: string): void {
    const key = this.key(workspaceId, path);
    const current = this.entries.get(key);
    if (!current || current.autoSaveBlock || current.text === current.original.content) return;
    this.cancelAutoSave(key);
    this.entries.set(key, { ...current, autoSaveBlock: 'discard' });
    this.publish();
  }

  open(workspace: Pick<Workspace, 'id' | 'name'>, original: FileContent, expected: FileDraft | undefined, discard = false): FileDraft {
    const key = this.key(workspace.id, original.path);
    const current = this.entries.get(key);
    if (current && (current !== expected || this.saves.has(key) || (!discard && current.text !== current.original.content))) return current;
    const entry = { original, text: original.content, workspaceId: workspace.id, workspaceName: workspace.name, editVersion: ++this.editVersion };
    this.cancelAutoSave(key);
    this.entries.set(key, entry);
    this.publish();
    return entry;
  }

  observeDisk(workspaceId: string, expected: FileContent, observation: DiskObservation): void {
    const key = this.key(workspaceId, expected.path);
    const current = this.entries.get(key);
    if (!current || current.original !== expected || this.saves.has(key)) return;

    let diskStatus: FileDraft['diskStatus'];
    if (typeof observation === 'string') {
      diskStatus = observation;
    } else if (observation.path !== expected.path) {
      return;
    } else if (observation.revision !== expected.revision) {
      if (current.text === expected.content) {
        this.open({ id: workspaceId, name: current.workspaceName }, observation, current);
        return;
      }
      diskStatus = 'changed';
    }

    if (current.diskStatus === diskStatus) return;
    const entry = { ...current, diskStatus };
    this.entries.set(key, entry);
    this.scheduleAutoSave(key, entry);
    this.publish();
  }

  edit(workspaceId: string, path: string, text: string): void {
    const key = this.key(workspaceId, path);
    const current = this.require(workspaceId, path);
    const entry = { ...current, text, editVersion: ++this.editVersion,
      autoSaveBlock: current.autoSaveBlock === 'discard' ? undefined : current.autoSaveBlock };
    this.entries.set(key, entry);
    this.scheduleAutoSave(key, entry);
    this.publish();
  }

  discard(workspaceId: string, path: string, expected: FileDraft): boolean {
    const key = this.key(workspaceId, path);
    if (this.entries.get(key) !== expected || this.saves.has(key)) return false;
    this.cancelAutoSave(key);
    this.entries.delete(key);
    this.publish();
    return true;
  }

  save(workspaceId: string, path: string, write: WriteFile): Promise<FileContent> {
    const key = this.key(workspaceId, path);
    const submitted = this.require(workspaceId, path);
    this.cancelAutoSave(key);
    const operation = (this.saves.get(key) ?? Promise.resolve()).then(async () => {
      const baseline = this.require(workspaceId, path).original;
      let written: FileContent;
      try { written = await write({ path, content: submitted.text, revision: baseline.revision }); }
      catch (failure) {
        const latest = this.require(workspaceId, path);
        this.entries.set(key, { ...latest, autoSaveBlock: { error: failure instanceof Error ? failure.message : String(failure) } });
        this.publish();
        throw failure;
      }
      const latest = this.require(workspaceId, path);
      this.entries.set(key, { ...latest, original: written, autoSaveBlock: undefined, diskStatus: undefined,
        text: latest.editVersion === submitted.editVersion ? written.content : latest.text });
      this.publish();
      return written;
    });
    this.saves.set(key, operation);
    this.publish();
    const settled = () => {
      if (this.saves.get(key) !== operation) return;
      this.saves.delete(key);
      this.scheduleAutoSave(key, this.require(workspaceId, path));
      this.publish();
    };
    void operation.then(settled, settled);
    return operation;
  }

  private scheduleAutoSave(key: string, entry: FileDraft): void {
    this.cancelAutoSave(key);
    const options = this.autoSave;
    if (!options || !this.autoSaveEnabled || entry.autoSaveBlock || entry.diskStatus
      || entry.text === entry.original.content || this.saves.has(key)) return;
    const { workspaceId, original: { path } } = entry;
    this.autoSaveTimers.set(key, setTimeout(() => {
      void this.save(workspaceId, path, input => options.write(workspaceId, input)).then(() => {
        for (const listener of this.autoSavedListeners) listener(workspaceId);
      }, () => {});
    }, options.delay));
  }

  private cancelAutoSave(key: string): void {
    clearTimeout(this.autoSaveTimers.get(key));
    this.autoSaveTimers.delete(key);
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
