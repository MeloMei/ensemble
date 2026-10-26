import type { McpServerConfig, ProviderModel, Session } from '../../shared/types';
import type { DisplayText } from '../../shared/display-text';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TurnContext } from './types';

export interface AcpConfigChoice { value: string; name: string }

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mcpServers?: McpServerConfig[];
  waitUntilReady?(signal: AbortSignal): Promise<void>;
  cleanup?(): Promise<void>;
}

export interface AcpRuntimeDescriptor {
  id: string;
  name: string;
  version: string;
  detail: string;
  detailI18n?: DisplayText;
  models?: ProviderModel[];
  defaultModelId?: string;
  tracksDelivery?: boolean;
  usageScope?: 'turn' | 'cumulative';
  reportsUsage?: boolean;
  launch(session: Session, mcpServers?: McpServerConfig[], context?: TurnContext): Promise<AcpLaunchSpec>;
  selectModel(choices: AcpConfigChoice[], modelId: string): AcpConfigChoice;
  reasoningPreference?: string[];
  efforts?: string[];
  sessionModes?: { review: string; 'read-only': string };
  permissionDecision?(tool: ToolCallUpdate, session: Session, servers: McpServerConfig[]): 'allow' | 'deny' | 'ask';
  clientRequests?: Record<string, (params: unknown, context: TurnContext, signal: AbortSignal) => Promise<unknown>>;
  clientRequestCancellation?: Record<string, unknown>;
  clientNotifications?: Record<string, (params: unknown, context: TurnContext) => void>;
}
