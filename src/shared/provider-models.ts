import type { ProviderInfo } from './types';

export function providerForDirectory(provider: ProviderInfo | undefined, cwd?: string): ProviderInfo | undefined {
  const catalog = provider?.modelCatalogs?.find(entry => entry.cwd === cwd);
  if (!provider || !catalog) return provider;
  const cliDefault = catalog.models.find(model => model.id === 'default');
  return {
    ...provider,
    models: catalog.models.filter(model => model !== cliDefault),
    efforts: cliDefault?.efforts,
  };
}
