import { z } from 'zod';
import { DRAFT_EVIDENCE_LIMIT, EVIDENCE_EXCERPT_LIMIT, localPreviewUrl } from '../shared/draft-evidence';

const id = z.string().min(1).max(200);
export const previewEvidenceSourceSchema = z.object({
  kind: z.literal('preview'), tabId: id, url: z.string().max(4096).refine(value => Boolean(localPreviewUrl(value))),
  selector: z.string().min(1).max(4096), number: z.number().int().positive(), annotationId: z.string().uuid(),
}).strict();
export const draftEvidenceSchema = z.object({
  id: z.string().uuid(), label: z.string().min(1).max(300), excerpt: z.string().min(1).max(EVIDENCE_EXCERPT_LIMIT),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('message'), sessionId: id, messageId: id }).strict(),
    z.object({ kind: z.literal('artifact'), runId: id, artifactId: id }).strict(),
    previewEvidenceSourceSchema,
  ]),
}).strict();
export const draftEvidenceListSchema = z.array(draftEvidenceSchema).max(DRAFT_EVIDENCE_LIMIT);
