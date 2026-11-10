import { z } from 'zod';
import { SESSION_PERMISSION_TIERS, sessionPermissionSchema } from './session-permissions';

export const providerCapabilitiesSchema = z.object({
  resume: z.boolean(), approvals: z.boolean(),
  images: z.boolean().optional(), textAttachments: z.boolean().optional(), rewind: z.boolean().optional(),
  effort: z.boolean().optional(), permissions: z.boolean().optional(),
  permissionTiers: z.array(sessionPermissionSchema).min(1).max(SESSION_PERMISSION_TIERS.length)
    .refine(tiers => new Set(tiers).size === tiers.length, 'Permission tiers must be unique').readonly().optional(),
  structured: z.boolean().optional(), usage: z.boolean().optional(), questions: z.boolean().optional(),
  steer: z.boolean().optional(),
}).strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
