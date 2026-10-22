import type { PromptInput } from './types';

interface DraftWrite {
  value: PromptInput;
  revision: number;
  savedRevision: number;
  pending?: Promise<void>;
  wake?: () => void;
}

export class DraftWriter {
  private drafts = new Map<string, DraftWrite>();

  constructor(private write: (id: string, input: PromptInput) => Promise<void>) {}

  save(id: string, value: PromptInput): Promise<void> {
    let draft = this.drafts.get(id);
    if (!draft) {
      draft = { value, revision: 0, savedRevision: 0 };
      this.drafts.set(id, draft);
    }
    draft.value = value;
    draft.revision += 1;
    return this.schedule(id, draft);
  }

  async flush(id?: string): Promise<void> {
    while (true) {
      const entries = [...this.drafts].filter(([key]) => id === undefined || key === id);
      if (!entries.length) return;
      await Promise.all(entries.map(([key, draft]) => {
        const pending = this.schedule(key, draft);
        draft.wake?.();
        return pending;
      }));
    }
  }

  private schedule(id: string, draft: DraftWrite): Promise<void> {
    draft.pending ??= this.persist(id, draft).finally(() => {
      draft.pending = undefined;
      draft.wake = undefined;
      if (draft.savedRevision === draft.revision) this.drafts.delete(id);
    });
    return draft.pending;
  }

  private async persist(id: string, draft: DraftWrite): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 200);
      draft.wake = () => { clearTimeout(timer); resolve(); };
    });
    while (draft.savedRevision !== draft.revision) {
      const revision = draft.revision;
      await this.write(id, draft.value);
      draft.savedRevision = revision;
    }
  }
}
