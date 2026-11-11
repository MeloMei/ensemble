import type { ProviderInfo, RuntimeModelConfiguration } from './types';

export function modelEffortChoices(provider?: ProviderInfo, modelId?: string, runtimeModel?: RuntimeModelConfiguration): readonly string[] {
  if (!provider?.capabilities.effort) return [];
  if (runtimeModel) return runtimeModel.efforts;
  const selected = modelId ?? provider.defaultModelId ?? provider.nativeDefaultModelId;
  if (selected !== undefined) return provider.models?.find(model => model.id === selected)?.efforts ?? [];
  return provider.efforts ?? [];
}
