import type { McpServerConfig, ProviderModel, Session } from '../../shared/types';
import type { DisplayText } from '../../shared/display-text';

export interface AcpConfigChoice { value: string; name: string }

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mcpServers?: McpServerConfig[];
  cleanup?(): Promise<void>;
}

export interface AcpRuntimeDescriptor {
  id: string;
  name: string;
  version: string;
  detail: string;
  detailI18n?: DisplayText;
  models: ProviderModel[];
  defaultModelId: string;
  launch(session: Session, mcpServers?: McpServerConfig[]): Promise<AcpLaunchSpec>;
  selectModel(choices: AcpConfigChoice[], modelId: string): AcpConfigChoice;
  reasoningPreference?: string[];
  efforts?: string[];
  sessionModes?: { review: string; 'read-only': string };
}
