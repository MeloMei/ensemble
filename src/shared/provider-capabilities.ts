import { z } from 'zod';

export const providerCapabilitiesSchema = z.object({
  resume: z.boolean(), approvals: z.boolean(),
  images: z.boolean().optional(), textAttachments: z.boolean().optional(), rewind: z.boolean().optional(),
  effort: z.boolean().optional(), permissions: z.boolean().optional(),
  structured: z.boolean().optional(), usage: z.boolean().optional(), questions: z.boolean().optional(),
  steer: z.boolean().optional(),
}).strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
