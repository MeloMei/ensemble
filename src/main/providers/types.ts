import type { ApprovalInput, ProviderInfo, Session, PromptAttachment, ProcessEvent, UsageRecord, McpServerConfig } from '../../shared/types';

export type ProviderEvent =
  | { type: 'text'; itemId: string; text: string; replace?: boolean }
  | { type: 'activity'; text: string }
  | { type: 'external-id'; id: string }
  | { type: 'native-turn'; turnId: string }
  | { type: 'structured'; event: ProcessEvent }
  | { type: 'usage'; usage: UsageRecord };

export interface LoadedPromptAttachment extends PromptAttachment { data: Buffer; text?: string }

export interface TurnContext {
  session: Session;
  prompt: string;
  userMessageId?: string;
  attachments?: LoadedPromptAttachment[];
  mcpServers?: McpServerConfig[];
  signal: AbortSignal;
  emit(event: ProviderEvent): void;
  approve(input: ApprovalInput, signal?: AbortSignal): Promise<string>;
}

export interface ProviderAdapter {
  info: ProviderInfo;
  run(context: TurnContext): Promise<void>;
  rewind?(session: Session, nativeTurnId: string): Promise<void>;
  dispose?(): Promise<void>;
}
