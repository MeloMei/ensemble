import type { CollaborationEvent, CollaborationState, CollaborationIdentity } from './collaboration';
import type { LanguagePreference, LanguageState } from './i18n';
import type { DisplayText } from './display-text';

export type SessionStatus = 'idle' | 'queued' | 'running' | 'waiting_approval' | 'waiting_children' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type RunStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export const BUILTIN_PROVIDER_IDS = ['codex', 'claude', 'opencode', 'deepseek-harness', 'cursor'] as const;
export interface ProviderModel { id: string; name: string; free: boolean; efforts?: string[] }

export interface ProviderInfo {
  id: string;
  name: string;
  source: 'builtin' | 'plugin';
  available: boolean;
  detail: string;
  detailI18n?: DisplayText;
  capabilities: { resume: boolean; approvals: boolean; images?: boolean; rewind?: boolean; effort?: boolean; permissions?: boolean };
  models?: ProviderModel[];
  defaultModelId?: string;
  efforts?: string[];
}

export type WorkspaceTab =
  | { id: string; kind: 'agent'; sessionId: string }
  | { id: string; kind: 'terminal'; terminalId: string }
  | { id: string; kind: 'preview'; url: string };

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  pinned: boolean;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  secondaryTabId?: string;
  splitDirection?: 'horizontal' | 'vertical';
  splitRatio?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalInfo {
  id: string;
  workspaceId: string;
  title: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  output: string;
  outputOffset: number;
}

export interface FileEntry { path: string; name: string; kind: 'file' | 'directory'; size: number }
export interface FileContent { path: string; content: string; size: number; language: string; revision: string }
export interface GitChange { path: string; status: string; staged: boolean; additions: number; deletions: number }
export interface GitState { available: boolean; branch: string; changes: GitChange[]; error?: string }
export interface FileDiff { path: string; patch: string; binary: boolean; truncated: boolean; revision?: string }

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'activity';
  text: string;
  createdAt: string;
  attachments?: PromptAttachment[];
  nativeTurnId?: string;
  event?: ProcessEvent;
}

export interface ApprovalInput {
  title: string;
  titleI18n?: DisplayText;
  detail: string;
  choices: { id: string; label: string; labelI18n?: DisplayText }[];
  questions?: {
    id: string;
    question: string;
    header: string;
    headerI18n?: DisplayText;
    options: { label: string; description?: string; labelI18n?: DisplayText }[];
    multiSelect: boolean;
  }[];
}

export interface Approval extends ApprovalInput {
  id: string;
  sessionId: string;
}

export interface Session {
  id: string;
  title: string;
  providerId: string;
  modelId?: string;
  cwd: string;
  status: SessionStatus;
  settings?: SessionSettings;
  archived?: boolean;
  parentSessionId?: string;
  parentAttemptId?: string;
  attempts?: SessionAttempt[];
  usage?: UsageRecord[];
  draft?: PromptInput;
  externalId?: string;
  error?: string;
  messages: Message[];
  approvals: Approval[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepInput {
  id: string;
  title: string;
  providerId: string;
  modelId?: string;
  prompt: string;
  dependsOn: string[];
}

export interface WorkflowStep extends WorkflowStepInput {
  attempts?: StepAttempt[];
  status: StepStatus;
  sessionId?: string;
  error?: string;
}

export interface WorkflowInput {
  name: string;
  cwd: string;
  steps: WorkflowStepInput[];
}

export interface Workflow extends WorkflowInput {
  id: string;
  status: RunStatus;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export type PublicCollaborationState = Pick<CollaborationState, 'definitions' | 'runs' | 'tasks' | 'messages' | 'artifacts' | 'grants'> & {
  identities: Pick<CollaborationIdentity, 'id' | 'name' | 'createdAt' | 'revokedAt' | 'policy'>[];
};

export interface Snapshot {
  version: 1;
  sessions: Session[];
  workflows: Workflow[];
  providers: ProviderInfo[];
  dataPath: string;
  pluginPath: string;
  pluginErrors: string[];
  workspaces: Workspace[];
  terminals: TerminalInfo[];
  mails?: AgentMail[];
  collaboration?: PublicCollaborationState;
  collaborationEventSeq?: number;
}

export interface WorkbenchAPI {
  getLanguage(): Promise<LanguageState>;
  setLanguage(preference: LanguagePreference): Promise<LanguageState>;
  onLanguageChanged(listener: (state: LanguageState) => void): () => void;
  collaborationCall(operation: string, input: unknown): Promise<unknown>;
  queryCollaborationEvents(runId: string, afterSeq?: number, limit?: number): Promise<CollaborationEvent[]>;
  snapshot(): Promise<Snapshot>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  refreshProviders(): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  createSession(input: { title: string; providerId: string; cwd: string; modelId?: string }): Promise<string>;
  sendMessage(sessionId: string, prompt: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  decideApproval(approvalId: string, choiceId: string): Promise<void>;
  answerQuestions(approvalId: string, answers: Record<string, string[]>): Promise<void>;
  createWorkflow(input: WorkflowInput): Promise<string>;
  startWorkflow(workflowId: string): Promise<void>;
  cancelWorkflow(workflowId: string): Promise<void>;
  launchCodex(input: { cwd: string; prompt: string }): Promise<string>;
  openPluginDirectory(): Promise<void>;
  createWorkspace(input: { name: string; cwd: string }): Promise<string>;
  updateWorkspace(id: string, input: { name?: string; pinned?: boolean }): Promise<void>;
  activateTab(workspaceId: string, tabId: string): Promise<void>;
  closeTab(workspaceId: string, tabId: string): Promise<void>;
  openSessionTab(workspaceId: string, sessionId: string): Promise<void>;
  createTerminal(workspaceId: string): Promise<string>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, columns: number, rows: number): Promise<void>;
  stopTerminal(terminalId: string): Promise<void>;
  createPreview(workspaceId: string, url: string): Promise<void>;
  listFiles(workspaceId: string, relativePath?: string): Promise<FileEntry[]>;
  readFile(workspaceId: string, relativePath: string): Promise<FileContent>;
  gitState(workspaceId: string): Promise<GitState>;
  fileDiff(workspaceId: string, relativePath: string): Promise<FileDiff>;
  chooseAttachments(): Promise<PromptAttachment[]>;
  sendPrompt(sessionId: string, input: PromptInput): Promise<void>;
  saveSessionDraft(sessionId: string, input: PromptInput): Promise<void>;
  updateSession(sessionId: string, input: { title?: string; archived?: boolean; settings?: SessionSettings; modelId?: string | null }): Promise<void>;
  forkSession(sessionId: string, beforeMessageId?: string): Promise<string>;
  rewindSession(sessionId: string, userMessageId: string): Promise<PromptInput>;
  retryWorkflowStep(workflowId: string, stepId: string): Promise<void>;
  cloneWorkflow(workflowId: string): Promise<string>;
  resumeWorkflow(workflowId: string): Promise<void>;
  splitWorkspace(workspaceId: string, input: { tabId?: string; direction?: 'horizontal' | 'vertical'; ratio?: number }): Promise<void>;
  writeFile(workspaceId: string, input: { path: string; content: string; revision: string }): Promise<FileContent>;
  gitMutate(workspaceId: string, input: GitMutation): Promise<GitState>;
  gitCommitPreview(workspaceId: string): Promise<GitCommitPreview>;
  gitCommit(workspaceId: string, input: { message: string; revision: string }): Promise<string>;
  reviewPullRequest(workspaceId: string): Promise<PullRequestReview>;
  listSkills(workspaceId: string): Promise<SkillInfo[]>;
  readSkill(workspaceId: string, skillId: string): Promise<{ content: string; revision: string }>;
  saveSkill(workspaceId: string, input: { name: string; content: string; revision?: string }): Promise<void>;
  mcpSettings(workspaceId: string): Promise<McpSettingsView>;
  saveMcpSettings(workspaceId: string, input: { content: string; revision: string }): Promise<void>;
  testMcpServer(workspaceId: string, name: string): Promise<{ status: string; tools: string[]; error?: string }>;
  deepSeekBalance(): Promise<DeepSeekBalance>;
  notificationStatus(): Promise<NotificationStatus>;
  onFocusSession(listener: (sessionId: string) => void): () => void;
}

export interface PromptAttachment {
  id: string; name: string; kind: 'image' | 'text'; mimeType: string;
  size: number; sha256: string; ownedPath: string;
}
export interface PromptInput { text: string; attachments?: PromptAttachment[] }
export interface CurrencyBalance { currency: string; total: string; granted: string; toppedUp: string }
export interface DeepSeekBalance extends CurrencyBalance { balances: CurrencyBalance[]; checkedAt: string }
export interface SessionSettings { effort?: string; permission?: 'review' | 'read-only'; skillIds?: string[] }
export interface ProcessEvent {
  id: string; kind: 'tool' | 'plan' | 'task' | 'subagent'; title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  nativeId?: string; parentId?: string; input?: string; output?: string; sessionId?: string;
  entries?: { text: string; status: 'pending' | 'running' | 'completed' }[];
}
export interface UsageRecord {
  id: string; source: string; scope: 'turn' | 'cumulative' | 'context';
  inputTokens?: number; outputTokens?: number; cachedTokens?: number;
  contextUsed?: number; contextSize?: number; cost?: number; currency?: string; createdAt: string;
}
export interface SessionAttempt {
  id: string; status: SessionStatus; prompt: string; userMessageId: string;
  retryOf?: string; startedAt: string; endedAt?: string; error?: string;
}
export interface StepAttempt {
  id: string; sessionId: string; status: StepStatus; retryOf?: string;
  startedAt: string; endedAt?: string; error?: string;
}
export interface AgentMail {
  id: string; fromSessionId: string; toSessionId: string; attemptId: string;
  toAttemptId?: string;
  kind: 'message' | 'question' | 'result'; text: string; createdAt: string; delivered?: boolean;
}
export interface MutationReceipt { key: string; hash: string; result: unknown }
export interface CollaborationCaller { sessionId: string; attemptId: string }
export type McpServerConfig = { name: string; type: 'stdio'; command: string; args: string[]; env?: Record<string,string> }
  | { name: string; type: 'http' | 'sse'; url: string; headers?: Record<string,string> };
export interface SkillInfo { id: string; name: string; description: string; path: string; scope: 'project' | 'user'; editable: boolean; issue?: string }
export interface McpSettingsView { content: string; revision: string; servers: { name: string; transport: string; status: string; source: string; issue?: string }[] }
export type GitMutation = { action: 'stage' | 'unstage' | 'discard'; path: string; revision?: string };
export interface GitCommitPreview { revision: string; patch: string; paths: string[]; truncated: boolean }
export interface PullRequestReview { status: 'ready' | 'unavailable' | 'error'; url?: string; number?: number; title?: string; state?: string; headSha?: string; checkedAt?: string; reviewDecision?: string; checks?: { name: string; status: string; conclusion?: string; url?: string }[]; error?: string }
export interface NotificationStatus { supported: boolean; state: 'idle' | 'requested' | 'shown' | 'failed'; error?: string }

declare global {
  interface Window { workbench: WorkbenchAPI }
}
