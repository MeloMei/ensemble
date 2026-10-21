import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { StateStore } from './store';
import { validateWorkspace } from './engine';
import { collaborationIdentitySchema } from '../shared/collaboration';
import type { CollaborationIdentity } from '../shared/collaboration';

export class IdentityService {
  constructor(private store: StateStore, private command: string, private bridgePath: string) {}

  async issue(input: unknown, baseUrl: string) {
    const parsed = z.object({
      name: z.string().trim().min(1).max(200),
      policy: z.object({ createRuns: z.boolean(), workspaceRoots: z.array(z.string().min(1).max(4096)).min(1).max(50), providerIds: z.array(z.string().min(1).max(200)).max(100).optional() }).strict(),
    }).strict().parse(input);
    const roots = await Promise.all(parsed.policy.workspaceRoots.map(validateWorkspace));
    const token = randomBytes(32).toString('hex');
    const identity: CollaborationIdentity = collaborationIdentitySchema.parse({
      id: randomUUID(), name: parsed.name, tokenHash: createHash('sha256').update(token).digest('hex'),
      policy: { ...parsed.policy, workspaceRoots: [...new Set(roots)] }, createdAt: new Date().toISOString(),
    });
    this.store.atomic(state => { state.collaboration.identities.push(identity); });
    const { tokenHash: _, ...publicIdentity } = identity;
    return {
      identity: publicIdentity,
      configuration: { name: 'workbench', type: 'stdio' as const, command: this.command, args: [this.bridgePath, '--data-dir', dirname(this.store.path)],
        env: { ELECTRON_RUN_AS_NODE: '1', WORKBENCH_IDENTITY_TOKEN: token } },
      http: { url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    };
  }

  authenticate(token: string): CollaborationIdentity {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('协作连接身份无效。');
    const hash = createHash('sha256').update(token).digest();
    const identity = this.store.state.collaboration.identities.find(item => !item.revokedAt && item.tokenHash.length === 64 && timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), hash));
    if (!identity) throw new Error('协作连接身份无效或已经撤销。');
    return identity;
  }

  revoke(input: unknown): void {
    const { identityId } = z.object({ identityId: z.string().min(1).max(200) }).strict().parse(input);
    this.store.atomic((state, tx) => {
      const identity = state.collaboration.identities.find(item => item.id === identityId);
      if (!identity) throw new Error('协作连接不存在。');
      if (identity.revokedAt) return;
      identity.revokedAt = new Date().toISOString();
      for (const grant of state.collaboration.grants.filter(item => item.identityId === identityId && !item.revokedAt)) {
        grant.revokedAt = identity.revokedAt;
        tx.appendEvent({ id: randomUUID(), runId: grant.runId, type: 'connection.revoked', source: 'platform', participantId: grant.participantId, data: { identityId }, createdAt: identity.revokedAt });
      }
    });
  }
}
