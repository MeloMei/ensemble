import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Snapshot, UnsavedFileSummary, WorkbenchAPI } from '../shared/types';
import { DraftWriter } from '../shared/draft-writer';
import { TerminalInputWriter } from '../shared/terminal-input-writer';
import type { LanguageState } from '../shared/i18n';
import type { BackendConnectionState, TerminalOutputEvent } from '../shared/backend';
import type { AppUpdateState } from '../shared/application-updates';

const drafts = new DraftWriter((id, input) => ipcRenderer.invoke('workbench:save-session-draft', id, input));
const terminalInputs = new TerminalInputWriter((id, data) => ipcRenderer.invoke('workbench:write-terminal', id, data));
const terminalObservers = new Map<string, number>();
const unsavedSources = new Map<string, UnsavedFileSummary>();
const unsavedFiles = (): UnsavedFileSummary => ({
  count: [...unsavedSources.values()].reduce((count, summary) => count + summary.count, 0),
  names: [...unsavedSources.values()].flatMap(summary => summary.names).slice(0, 8),
});
window.addEventListener('beforeunload', event => {
  if (unsavedFiles().count || drafts.hasPending || terminalInputs.hasPending) {
    event.preventDefault(); event.returnValue = '';
  }
});
let closeFocus: HTMLElement | undefined;
ipcRenderer.on('workbench:release-close-lock', () => {
  document.documentElement.inert = false;
  if (closeFocus?.isConnected) closeFocus.focus();
  closeFocus = undefined;
});
ipcRenderer.on('workbench:prepare-close', (_event, requestId: string, intent?: 'update') => {
  if (intent === 'update') {
    closeFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    document.documentElement.inert = true;
  }
  void Promise.allSettled([drafts.flush(), terminalInputs.flush()]).then(results => {
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    ipcRenderer.send('workbench:close-ready', { requestId, error: errors.length ? errors.join('\n') : null, unsavedFiles: unsavedFiles() });
  });
});

const api: WorkbenchAPI = {
  getApplicationUpdate: () => ipcRenderer.invoke('workbench:application-update'),
  checkApplicationUpdate: () => ipcRenderer.invoke('workbench:check-application-update'),
  downloadApplicationUpdate: () => ipcRenderer.invoke('workbench:download-application-update'),
  installApplicationUpdate: () => ipcRenderer.invoke('workbench:install-application-update'),
  setApplicationUpdateAutoCheck: enabled => ipcRenderer.invoke('workbench:set-application-update-auto-check', enabled),
  onApplicationUpdateChanged: listener => {
    const receive = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => listener(state);
    ipcRenderer.on('workbench:application-update-changed', receive);
    return () => ipcRenderer.removeListener('workbench:application-update-changed', receive);
  },
  confirmApplicationUpdateReady: () => ipcRenderer.invoke('workbench:application-update-ready'),
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
  beginQueuedPromptEdit: (id, itemId, revision, editId, ownerId) => ipcRenderer.invoke('workbench:begin-queued-prompt-edit', id, itemId, revision, editId, ownerId),
  renewQueuedPromptEdit: (id, itemId, editId) => ipcRenderer.invoke('workbench:renew-queued-prompt-edit', id, itemId, editId),
  saveQueuedPromptDraft: (id, itemId, editId, revision, input) => ipcRenderer.invoke('workbench:save-queued-prompt-draft', id, itemId, editId, revision, input),
  finishQueuedPromptEdit: (id, itemId, editId, input) => ipcRenderer.invoke('workbench:finish-queued-prompt-edit', id, itemId, editId, input),
  removeQueuedPrompt: (id, itemId, revision, commandId, editId) => ipcRenderer.invoke('workbench:remove-queued-prompt', id, itemId, revision, commandId, editId),
  moveQueuedPrompt: (id, itemId, targetId, expectedOrder, commandId) => ipcRenderer.invoke('workbench:move-queued-prompt', id, itemId, targetId, expectedOrder, commandId),
  setSessionQueuePaused: (id, paused) => ipcRenderer.invoke('workbench:set-session-queue-paused', id, paused),
  reconcileSessionDelivery: id => ipcRenderer.invoke('workbench:reconcile-session-delivery', id),
  providerHealth: cwd => ipcRenderer.invoke('workbench:provider-health', cwd),
  diagnostics: () => ipcRenderer.invoke('workbench:diagnostics'),
  diagnosticTracing: () => ipcRenderer.invoke('workbench:diagnostic-tracing'),
  exportDiagnostics: () => ipcRenderer.invoke('workbench:export-diagnostics'),
  setDiagnosticTracing: enabled => ipcRenderer.invoke('workbench:set-diagnostic-tracing', enabled),
  setUnsavedFiles: (summary, sourceId = 'files') => {
    if (summary.count) unsavedSources.set(sourceId, structuredClone(summary));
    else unsavedSources.delete(sourceId);
  },
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
  runtimeInstalls: () => ipcRenderer.invoke('workbench:runtime-installs'),
  installRuntime: id => ipcRenderer.invoke('workbench:install-runtime', id),
  cancelRuntimeInstall: id => ipcRenderer.invoke('workbench:cancel-runtime-install', id),
  chooseAcpExecutable: () => ipcRenderer.invoke('workbench:choose-acp-executable'),
  addCustomAcp: (requestId, input) => ipcRenderer.invoke('workbench:add-custom-acp', requestId, input),
  cancelCustomAcp: requestId => ipcRenderer.invoke('workbench:cancel-custom-acp', requestId),
  removeCustomAcp: providerId => ipcRenderer.invoke('workbench:remove-custom-acp', providerId),
  runtimeAccount: (id, refresh) => ipcRenderer.invoke('workbench:runtime-account', id, refresh),
  signInRuntime: (id, method) => ipcRenderer.invoke('workbench:sign-in-runtime', id, method),
  cancelRuntimeSignIn: id => ipcRenderer.invoke('workbench:cancel-runtime-sign-in', id),
  signOutRuntime: id => ipcRenderer.invoke('workbench:sign-out-runtime', id),
  chooseDirectory: () => ipcRenderer.invoke('workbench:choose-directory'),
  createSession: input => ipcRenderer.invoke('workbench:create-session', input),
  sessionLocations: workspaceId => ipcRenderer.invoke('workbench:session-locations', workspaceId),
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
  removeWorktree: async id => {
    if (unsavedFiles().count) throw new Error('WORKBENCH_UNSAVED_FILES');
    return ipcRenderer.invoke('workbench:remove-worktree', id);
  },
  manageWorkspace: async (id, input) => {
    if (input.action !== 'restore' && unsavedFiles().count) throw new Error('WORKBENCH_UNSAVED_FILES');
    return ipcRenderer.invoke('workbench:manage-workspace', id, input);
  },
  updateWorkspace: (id, input) => ipcRenderer.invoke('workbench:update-workspace', id, input),
  activateTab: (workspaceId, tabId) => ipcRenderer.invoke('workbench:activate-tab', workspaceId, tabId),
  closeTab: (workspaceId, tabId, confirmStop = false) => ipcRenderer.invoke('workbench:close-tab', workspaceId, tabId, confirmStop),
  openSessionTab: (workspaceId, sessionId, besideSessionId) => ipcRenderer.invoke('workbench:open-session-tab', workspaceId, sessionId, besideSessionId),
  createTerminal: (workspaceId, besideSessionId) => ipcRenderer.invoke('workbench:create-terminal', workspaceId, besideSessionId),
  writeTerminal: (id, data) => terminalInputs.write(id, data),
  resizeTerminal: (id, columns, rows) => ipcRenderer.invoke('workbench:resize-terminal', id, columns, rows),
  stopTerminal: id => ipcRenderer.invoke('workbench:stop-terminal', id),
  listTerminalServices: id => ipcRenderer.invoke('workbench:list-terminal-services', id),
  createPreview: (workspaceId, url) => ipcRenderer.invoke('workbench:create-preview', workspaceId, url),
  capturePreviewElement: (tabId, point) => ipcRenderer.invoke('workbench:capture-preview-element', tabId, point),
  displayPreviewAnnotations: (tabId, annotations, revealId) => ipcRenderer.invoke('workbench:display-preview-annotations', tabId, annotations, revealId),
  previewDraftEvidence: tabId => ipcRenderer.invoke('workbench:preview-draft-evidence', tabId),
  listFiles: (workspaceId, path) => ipcRenderer.invoke('workbench:list-files', workspaceId, path),
  findWorkspaceFiles: (workspaceId, query) => ipcRenderer.invoke('workbench:find-workspace-files', workspaceId, query),
  searchWorkspaceText: (workspaceId, query) => ipcRenderer.invoke('workbench:search-workspace-text', workspaceId, query),
  readFile: (workspaceId, path) => ipcRenderer.invoke('workbench:read-file', workspaceId, path),
  gitState: workspaceId => ipcRenderer.invoke('workbench:git-state', workspaceId),
  gitBranchRefs: workspaceId => ipcRenderer.invoke('workbench:git-branch-refs', workspaceId),
  gitBranchComparison: (workspaceId, targetRef) => ipcRenderer.invoke('workbench:git-branch-comparison', workspaceId, targetRef),
  changeGitBranch: (workspaceId, change) => ipcRenderer.invoke('workbench:change-git-branch', workspaceId, change),
  gitSyncState: id => ipcRenderer.invoke('workbench:git-sync-state', id),
  syncGit: (id, request) => ipcRenderer.invoke('workbench:sync-git', id, request),
  gitHistory: (id, query, allBranches, limit) => ipcRenderer.invoke('workbench:git-history', id, query, allBranches, limit),
  gitCommitFiles: (id, sha) => ipcRenderer.invoke('workbench:git-commit-files', id, sha),
  gitCommitDiff: (id, sha, path) => ipcRenderer.invoke('workbench:git-commit-diff', id, sha, path),
  fileDiff: (workspaceId, path) => ipcRenderer.invoke('workbench:file-diff', workspaceId, path),
  chooseAttachments: () => ipcRenderer.invoke('workbench:choose-attachments'),
  importDroppedAttachments: async files => {
    const paths = files.map(file => webUtils.getPathForFile(file));
    return paths.length && paths.every(Boolean) ? ipcRenderer.invoke('workbench:import-attachments', paths) : null;
  },
  importWorkspaceAttachments: (id, paths) => ipcRenderer.invoke('workbench:import-workspace-attachments', id, paths),
  importPastedImage: (name, bytes) => ipcRenderer.invoke('workbench:import-pasted-image', name, bytes),
  readImageAttachment: attachment => ipcRenderer.invoke('workbench:read-image-attachment', attachment),
  sendPrompt: async (id, input, commandId, expectedProviderId) => {
    await drafts.flush(id);
    return ipcRenderer.invoke('workbench:send-prompt', id, input, commandId, expectedProviderId);
  },
  saveSessionDraft: (id, input) => drafts.save(id, input),
  switchSessionRuntime: (id, targetProviderId, expectedProviderId) =>
    ipcRenderer.invoke('workbench:switch-session-runtime', id, targetProviderId, expectedProviderId),
  addSessionEvidence: async (id, reference) => { await drafts.flush(id); return ipcRenderer.invoke('workbench:add-session-evidence', id, reference); },
  updateSession: (id, input) => ipcRenderer.invoke('workbench:update-session', id, input),
  forkSession: (id, before, beside) => ipcRenderer.invoke('workbench:fork-session', id, before, beside),
  continueSession: (id, target) => ipcRenderer.invoke('workbench:continue-session', id, target),
  askSideQuestion: (id, input, commandId) => ipcRenderer.invoke('workbench:ask-side-question', id, input, commandId),
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
  notificationPreferences: () => ipcRenderer.invoke('workbench:notification-preferences'),
  setNotificationPreferences: patch => ipcRenderer.invoke('workbench:set-notification-preferences', patch),
  captureWindow: () => ipcRenderer.invoke('workbench:capture-window'),
  cancelWindowCapture: () => ipcRenderer.invoke('workbench:cancel-window-capture'),
  windowCaptureShortcut: () => ipcRenderer.invoke('workbench:window-capture-shortcut'),
  setWindowCaptureShortcut: enabled => ipcRenderer.invoke('workbench:set-window-capture-shortcut', enabled),
  addSessionAttachment: async (id, attachment) => {
    await drafts.flush(id);
    return ipcRenderer.invoke('workbench:add-session-attachment', id, attachment);
  },
  onWindowCaptured: listener => {
    const receive = (_event: Electron.IpcRendererEvent, attachment: Parameters<typeof listener>[0]) => listener(attachment);
    ipcRenderer.on('workbench:window-captured', receive);
    return () => ipcRenderer.removeListener('workbench:window-captured', receive);
  },
  onFocusSession: listener => {
    const receive = (_event: Electron.IpcRendererEvent, target: Parameters<typeof listener>[0]) => listener(target);
    ipcRenderer.on('workbench:focus-session', receive);
    return () => ipcRenderer.removeListener('workbench:focus-session', receive);
  },
};

contextBridge.exposeInMainWorld('workbench', api);
