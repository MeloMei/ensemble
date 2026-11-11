import type { DraftEvidence, PromptInput } from './types';

export const DRAFT_EVIDENCE_LIMIT = 16;
export const EVIDENCE_EXCERPT_LIMIT = 4000;

export function addDraftEvidence(draft: PromptInput, reference: DraftEvidence): PromptInput {
  const evidence = draft.evidence ?? [];
  if (evidence.some(item => item.id === reference.id)) return draft;
  if (evidence.length >= DRAFT_EVIDENCE_LIMIT) throw new Error(`每份草稿最多添加 ${DRAFT_EVIDENCE_LIMIT} 条引用。`);
  return { ...draft, evidence: [...evidence, reference] };
}

export function draftPromptText(input: PromptInput): string {
  if (!input.evidence?.length) return input.text;
  const evidence = input.evidence.map(({ label, excerpt, source }) => {
    let location: string;
    switch (source.kind) {
      case 'message': location = `session ${source.sessionId}, message ${source.messageId}`; break;
      case 'artifact': location = `collaboration ${source.runId}, artifact ${source.artifactId}`; break;
      case 'preview': location = `annotation #${source.number}, ${source.url}, selector ${source.selector}`; break;
    }
    return `[${label}] (${location})\n${excerpt.split('\n').map(line => `> ${line}`).join('\n')}`;
  });
  return [input.text.trim(), ...evidence].filter(Boolean).join('\n\n');
}

export function hasPromptInput(input: PromptInput): boolean {
  return Boolean(input.text.trim() || input.attachments?.length || input.evidence?.length);
}

export function samePromptDraft(draft: PromptInput | undefined, input: PromptInput): boolean {
  return draft?.text.trim() === input.text.trim()
    && JSON.stringify(draft.attachments ?? []) === JSON.stringify(input.attachments ?? [])
    && JSON.stringify(draft.evidence ?? []) === JSON.stringify(input.evidence ?? [])
    && JSON.stringify(draft.skills ?? []) === JSON.stringify(input.skills ?? []);
}

export function localPreviewUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password) return url;
  } catch { /* The preview requires an absolute loopback URL. */ }
}

export function previewFrameName(tabId: string): string { return `ensemble-preview-${tabId}`; }
