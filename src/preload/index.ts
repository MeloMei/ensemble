import { contextBridge, ipcRenderer } from 'electron';
import type { Snapshot, WorkbenchAPI } from '../shared/types';

const api: WorkbenchAPI = {
  collaborationCall: (operation, input) => ipcRenderer.invoke('workbench:collaboration-call', operation, input),
  queryCollaborationEvents: (runId, afterSeq, limit) => ipcRenderer.invoke('workbench:collaboration-events', runId, afterSeq, limit),
  snapshot: () => ipcRenderer.invoke('workbench:snapshot'),
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on('workbench:changed', receive);
    return () => { ipcRenderer.removeListener('workbench:changed', receive); };
  },
  refreshProviders: () => ipcRenderer.invoke('workbench:refresh-providers'),
  chooseDirectory: () => ipcRenderer.invoke('workbench:choose-directory'),
  createSession: input => ipcRenderer.invoke('workbench:create-session', input),
  sendMessage: (id, prompt) => ipcRenderer.invoke('workbench:send-message', id, prompt),
  cancelSession: id => ipcRenderer.invoke('workbench:cancel-session', id),
  decideApproval: (id, choice) => ipcRenderer.invoke('workbench:decide-approval', id, choice),
  answerQuestions: (id, answers) => ipcRenderer.invoke('workbench:answer-questions', id, answers),
  createWorkflow: input => ipcRenderer.invoke('workbench:create-workflow', input),
  startWorkflow: id => ipcRenderer.invoke('workbench:start-workflow', id),
  cancelWorkflow: id => ipcRenderer.invoke('workbench:cancel-workflow', id),
  launchCodex: input => ipcRenderer.invoke('workbench:launch-codex', input),
  openPluginDirectory: () => ipcRenderer.invoke('workbench:open-plugin-directory'),
  createWorkspace: input => ipcRenderer.invoke('workbench:create-workspace', input),
  updateWorkspace: (id, input) => ipcRenderer.invoke('workbench:update-workspace', id, input),
  activateTab: (workspaceId, tabId) => ipcRenderer.invoke('workbench:activate-tab', workspaceId, tabId),
  closeTab: (workspaceId, tabId) => ipcRenderer.invoke('workbench:close-tab', workspaceId, tabId),
  openSessionTab: (workspaceId, sessionId) => ipcRenderer.invoke('workbench:open-session-tab', workspaceId, sessionId),
  createTerminal: workspaceId => ipcRenderer.invoke('workbench:create-terminal', workspaceId),
  writeTerminal: (id, data) => ipcRenderer.invoke('workbench:write-terminal', id, data),
  resizeTerminal: (id, columns, rows) => ipcRenderer.invoke('workbench:resize-terminal', id, columns, rows),
  stopTerminal: id => ipcRenderer.invoke('workbench:stop-terminal', id),
  createPreview: (workspaceId, url) => ipcRenderer.invoke('workbench:create-preview', workspaceId, url),
  listFiles: (workspaceId, path) => ipcRenderer.invoke('workbench:list-files', workspaceId, path),
  readFile: (workspaceId, path) => ipcRenderer.invoke('workbench:read-file', workspaceId, path),
  gitState: workspaceId => ipcRenderer.invoke('workbench:git-state', workspaceId),
  fileDiff: (workspaceId, path) => ipcRenderer.invoke('workbench:file-diff', workspaceId, path),
  chooseAttachments: () => ipcRenderer.invoke('workbench:choose-attachments'),
  sendPrompt: (id, input) => ipcRenderer.invoke('workbench:send-prompt', id, input),
  updateSession: (id, input) => ipcRenderer.invoke('workbench:update-session', id, input),
  forkSession: (id, before) => ipcRenderer.invoke('workbench:fork-session', id, before),
  rewindSession: (id, messageId) => ipcRenderer.invoke('workbench:rewind-session', id, messageId),
  retryWorkflowStep: (id, stepId) => ipcRenderer.invoke('workbench:retry-step', id, stepId),
  cloneWorkflow: id => ipcRenderer.invoke('workbench:clone-workflow', id),
  resumeWorkflow: id => ipcRenderer.invoke('workbench:resume-workflow', id),
  splitWorkspace: (id, input) => ipcRenderer.invoke('workbench:split-workspace', id, input),
  writeFile: (id, input) => ipcRenderer.invoke('workbench:write-file', id, input),
  gitMutate: (id, input) => ipcRenderer.invoke('workbench:git-mutate', id, input),
  gitCommitPreview: id => ipcRenderer.invoke('workbench:git-commit-preview', id),
  gitCommit: (id, input) => ipcRenderer.invoke('workbench:git-commit', id, input),
  reviewPullRequest: id => ipcRenderer.invoke('workbench:review-pull-request', id),
  listSkills: id => ipcRenderer.invoke('workbench:list-skills', id),
  readSkill: (id, skillId) => ipcRenderer.invoke('workbench:read-skill', id, skillId),
  saveSkill: (id, input) => ipcRenderer.invoke('workbench:save-skill', id, input),
  mcpSettings: id => ipcRenderer.invoke('workbench:mcp-settings', id),
  saveMcpSettings: (id, input) => ipcRenderer.invoke('workbench:save-mcp-settings', id, input),
  testMcpServer: (id, name) => ipcRenderer.invoke('workbench:test-mcp-server', id, name),
  deepSeekBalance: () => ipcRenderer.invoke('workbench:deepseek-balance'),
  notificationStatus: () => ipcRenderer.invoke('workbench:notification-status'),
  onFocusSession: listener => {
    const receive = (_event: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId);
    ipcRenderer.on('workbench:focus-session', receive);
    return () => ipcRenderer.removeListener('workbench:focus-session', receive);
  },
};

contextBridge.exposeInMainWorld('workbench', api);
