import { z } from 'zod';

const legacyPermissionTiers = ['review', 'read-only'] as const;
export const SESSION_PERMISSION_TIERS = [...legacyPermissionTiers, 'full-access'] as const;
export const sessionPermissionSchema = z.enum(SESSION_PERMISSION_TIERS);
export type SessionPermission = z.infer<typeof sessionPermissionSchema>;

export function permissionTiersFor(capabilities?: { permissions?: boolean; permissionTiers?: readonly SessionPermission[] }): readonly SessionPermission[] {
  if (capabilities?.permissions === false) return [];
  return capabilities?.permissionTiers ?? (capabilities?.permissions ? legacyPermissionTiers : []);
}
