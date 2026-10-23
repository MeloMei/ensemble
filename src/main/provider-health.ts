import type { ProviderHealth, ProviderHealthCheck, ProviderHealthStage, ProviderInfo, Session } from '../shared/types';
import type { ExecutionObservation } from './engine';

const unknown = (source: string, at: string): ProviderHealthCheck => ({ status: 'unknown', source, observedAt: at });
export function discoveryHealth(input: { binary: boolean | undefined; protocol?: boolean; catalog?: boolean; source: string }): ProviderHealth {
  const at = new Date().toISOString();
  const check = (value: boolean | undefined, stage: ProviderHealthStage): ProviderHealthCheck => value === undefined ? unknown(input.source, at)
    : { status: value ? 'ready' : stage === 'binary' ? 'missing' : 'error', source: input.source, observedAt: at };
  return { checks: { binary: check(input.binary, 'binary'), protocol: check(input.protocol, 'protocol'), catalog: check(input.catalog, 'catalog'),
    authentication: unknown('no-authentication-evidence', at), quota: unknown('no-quota-source', at) } };
}

export class ProviderHealthRegistry {
  private observations = new Map<string, Partial<Record<ProviderHealthStage, ProviderHealthCheck>>>();
  private discoveries = new WeakMap<ProviderInfo, ProviderHealth>();
  private executions = new Map<string, Pick<ProviderInfo, 'id' | 'detail'>>();

  private key(info: Pick<ProviderInfo, 'id' | 'detail'>, cwd?: string): string { return `${info.id}\0${cwd ?? ''}\0${info.detail}`; }

  describe(info: ProviderInfo, cwd?: string): ProviderInfo {
    let base = info.health ?? this.discoveries.get(info);
    if (!base) { base = discoveryHealth({ binary: info.available ? true : undefined, catalog: info.models?.length ? true : undefined, source: 'runtime-discovery' }); this.discoveries.set(info, base); }
    const observed = this.observations.get(this.key(info, cwd));
    return { ...info, health: { ...(cwd ? { cwd } : {}), checks: { ...base.checks, ...observed } } };
  }

  observe(observation: ExecutionObservation, session: Session): void {
    const execution = `${session.id}:${observation.attemptId}`;
    if (observation.type === 'input') { this.executions.set(execution, { ...observation.providerIdentity }); return; }
    if (observation.type !== 'settled') return;
    const info = this.executions.get(execution);
    this.executions.delete(execution);
    if (!info) return;
    const key = this.key(info, session.cwd);
    const checks = { ...this.observations.get(key) };
    const at = new Date().toISOString();
    if (observation.status === 'completed') {
      checks.protocol = { status: 'ready', source: 'completed-turn', observedAt: at };
      checks.authentication = { status: 'ready', source: 'completed-turn', observedAt: at };
    } else if (/unauthori[sz]ed|not logged in|authentication|invalid api key|no api key|\b401\b/i.test(observation.error ?? '')) {
      checks.authentication = { status: 'error', source: 'runtime-authentication-error', observedAt: at };
    }
    this.observations.set(key, checks);
    if (this.observations.size > 200) this.observations.delete(this.observations.keys().next().value!);
  }

}
