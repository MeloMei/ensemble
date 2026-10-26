import type { ApprovalInput, ProviderInfo, Session, PromptAttachment, ProcessEvent, UsageRecord, McpServerConfig, MessageDelivery } from '../../shared/types';

export interface ProviderDeliveryUpdate {
  status: MessageDelivery['status']; nativeThreadId?: string; nativeTurnId?: string; nativeItemId?: string; reason?: string;
}
export interface DeliveryReconciliation extends ProviderDeliveryUpdate { clientUserMessageId: string }

export type ProviderEvent =
  | { type: 'text'; itemId: string; text: string; replace?: boolean }
  | { type: 'activity'; text: string }
  | { type: 'external-id'; id: string }
  | { type: 'native-turn'; turnId: string }
  | ({ type: 'delivery' } & ProviderDeliveryUpdate)
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
  tracksDelivery?: boolean;
  run(context: TurnContext): Promise<void>;
  rewind?(session: Session, nativeTurnId: string): Promise<void>;
  reconcileDelivery?(session: Session, deliveries: MessageDelivery[]): Promise<DeliveryReconciliation[]>;
  dispose?(): Promise<void>;
}
