import { contextBridge, ipcRenderer } from 'electron';
import type { Snapshot, UnsavedFileSummary, WorkbenchAPI } from '../shared/types';
import { DraftWriter } from '../shared/draft-writer';
import { TerminalInputWriter } from '../shared/terminal-input-writer';
import type { LanguageState } from '../shared/i18n';
import type { BackendConnectionState, TerminalOutputEvent } from '../shared/backend';

const drafts = new DraftWriter((id, input) => ipcRenderer.invoke('workbench:save-session-draft', id, input));
const terminalInputs = new TerminalInputWriter((id, data) => ipcRenderer.invoke('workbench:write-terminal', id, data));
const terminalObservers = new Map<string, number>();
let unsavedFiles: UnsavedFileSummary = { count: 0, names: [] };
window.addEventListener('beforeunload', event => {
  if (unsavedFiles.count || drafts.hasPending || terminalInputs.hasPending) {
    event.preventDefault(); event.returnValue = '';
  }
});
ipcRenderer.on('workbench:prepare-close', (_event, requestId: string) => {
  void Promise.allSettled([drafts.flush(), terminalInputs.flush()]).then(results => {
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    ipcRenderer.send('workbench:close-ready', { requestId, error: errors.length ? errors.join('\n') : null, unsavedFiles });
  });
});

const api: WorkbenchAPI = {
  getConnection: () => ipcRenderer.invoke('workbench:get-connection'),
  onConnectionChanged: listener => {
    const receive = (_event: Electron.IpcRendererEvent, state: BackendConnectionState) => listener(state);
    ipcRenderer.on('workbench:connection-changed', receive);
    return () => ipcRenderer.removeListener('workbench:connection-changed', receive);
  },
  watchSessions: ids => ipcRenderer.invoke('workbench:watch-sessions', ids),
  sessionHistory: (id, before, limit) => ipcRenderer.invoke('workbench:session-history', id, before, limit),
  sessionHistoryAround: (id, messageId, limit) => ipcRenderer.invoke('workbench:session-history-around', id, messageId, limit),
  sessionHistoryAfter: (id, after, limit) => ipcRenderer.invoke('workbench:session-history-after', id, after, limit),
  sessionSearch: (id, query, limit) => ipcRenderer.invoke('workbench:session-search', id, query, limit),
  searchSessions: (query, includeArchived) => ipcRenderer.invoke('workbench:search-sessions', query, includeArchived),
  onTerminalOutput: (id, listener) => {
    const receive = (_event: Electron.IpcRendererEvent, event: TerminalOutputEvent) => {
      if (event.terminalId === id) listener(event);
    };
    ipcRenderer.on('workbench:terminal-output', receive);
    const observers = terminalObservers.get(id) ?? 0;
    terminalObservers.set(id, observers + 1);
    ipcRenderer.send('workbench:watch-terminal', id);
    let released = false;
    return () => {
      if (released) return; released = true;
      ipcRenderer.removeListener('workbench:terminal-output', receive);
      const remaining = (terminalObservers.get(id) ?? 1) - 1;
      if (remaining) terminalObservers.set(id, remaining);
      else { terminalObservers.delete(id); ipcRenderer.send('workbench:unwatch-terminal', id); }
    };
  },
  markSessionSeen: (id, revision) => ipcRenderer.invoke('workbench:mark-session-seen', id, revision),
  commandReceipt: id => ipcRenderer.invoke('workbench:command-receipt', id),
  updateQueuedPrompt: (id, itemId, input) => ipcRenderer.invoke('workbench:update-queued-prompt', id, itemId, input),
  removeQueuedPrompt: (id, itemId) => ipcRenderer.invoke('workbench:remove-queued-prompt', id, itemId),
  setSessionQueuePaused: (id, paused) => ipcRenderer.invoke('workbench:set-session-queue-paused', id, paused),
  reconcileSessionDelivery: id => ipcRenderer.invoke('workbench:reconcile-session-delivery', id),
  setUnsavedFiles: summary => { unsavedFiles = structuredClone(summary); },
  getLanguage: () => ipcRenderer.invoke('workbench:get-language'),
  setLanguage: preference => ipcRenderer.invoke('workbench:set-language', preference),
  onLanguageChanged: listener => {
    const receive = (_event: Electron.IpcRendererEvent, state: LanguageState) => listener(state);
    ipcRenderer.on('workbench:language-changed', receive);
    return () => ipcRenderer.removeListener('workbench:language-changed', receive);
  },
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
  sendMessage: (id, prompt, commandId) => ipcRenderer.invoke('workbench:send-message', id, prompt, commandId),
  cancelSession: (id, commandId, expectedAttemptId) => ipcRenderer.invoke('workbench:cancel-session', id, commandId, expectedAttemptId),
  decideApproval: (id, choice, commandId) => ipcRenderer.invoke('workbench:decide-approval', id, choice, commandId),
  answerQuestions: (id, answers, commandId) => ipcRenderer.invoke('workbench:answer-questions', id, answers, commandId),
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
  writeTerminal: (id, data) => terminalInputs.write(id, data),
  resizeTerminal: (id, columns, rows) => ipcRenderer.invoke('workbench:resize-terminal', id, columns, rows),
  stopTerminal: id => ipcRenderer.invoke('workbench:stop-terminal', id),
  createPreview: (workspaceId, url) => ipcRenderer.invoke('workbench:create-preview', workspaceId, url),
  listFiles: (workspaceId, path) => ipcRenderer.invoke('workbench:list-files', workspaceId, path),
  readFile: (workspaceId, path) => ipcRenderer.invoke('workbench:read-file', workspaceId, path),
  gitState: workspaceId => ipcRenderer.invoke('workbench:git-state', workspaceId),
  fileDiff: (workspaceId, path) => ipcRenderer.invoke('workbench:file-diff', workspaceId, path),
  chooseAttachments: () => ipcRenderer.invoke('workbench:choose-attachments'),
  sendPrompt: async (id, input, commandId) => { await drafts.flush(id); await ipcRenderer.invoke('workbench:send-prompt', id, input, commandId); },
  saveSessionDraft: (id, input) => drafts.save(id, input),
  updateSession: (id, input) => ipcRenderer.invoke('workbench:update-session', id, input),
  forkSession: (id, before) => ipcRenderer.invoke('workbench:fork-session', id, before),
  rewindSession: async (id, messageId) => { await drafts.flush(id); return ipcRenderer.invoke('workbench:rewind-session', id, messageId); },
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
