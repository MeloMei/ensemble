import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sessionPermissionSchema } from '../shared/session-permissions';
import { WorkbenchEngine } from './engine';
import { projectSessionCollaborations } from './session-collaboration';
import { StateStore } from './store';
import { createCodexProvider } from './providers/codex';
import { createClaudeProvider } from './providers/claude';
import { createPiProvider } from './providers/pi';
import { createAcpProvider, type AcpProvider } from './providers/acp';
import { InstalledAcpRuntimes } from './providers/installed-acp';
import type { ProviderAdapter } from './providers/types';
import { createOpenCodeDescriptor } from './providers/opencode';
import { createDeepSeekHarnessDescriptor } from './providers/deepseek-harness';
import { createGeminiDescriptor } from './providers/gemini';
import { createCursorDescriptor } from './providers/cursor';
import { createQoderDescriptor } from './providers/qoder';
import { loadPluginProviders } from './providers/plugins';
import { TerminalManager } from './terminal-manager';
import { MissingWorkspaceDirectoryError, WorkspaceFiles } from './workspace-files';
import { RuntimeInstaller } from './runtime-install';
import type { Snapshot } from '../shared/types';
import { PROMPT_TEXT_LIMIT, SIDE_QUESTION_LIMIT, SIDE_QUESTION_REFERENCE_LIMIT } from '../shared/types';
import type { TerminalOutputEvent } from '../shared/backend';
import { AttachmentService, attachmentMetadataSchema } from './attachment-service';
import { RuntimeSettings, readDeepSeekBalance } from './runtime-settings';
import { CollaborationServer } from './collaboration-server';
import { reviewPullRequest } from './pull-request-review';
import { CollaborationCore } from './collaboration-core';
import { IdentityService } from './identity-service';
import { ManagedWorktrees } from './managed-worktrees';
import { ProviderHealthRegistry } from './provider-health';
import { DiagnosticJournal, withProviderDiagnostics } from './diagnostics';
import { sessionHistory, searchMessages } from './session-history';
import { searchableMessageText } from '../shared/message-text';
import { ATTACHMENT_LIMITS, attachmentLimitIssue } from '../shared/prompt-attachments';
import { ApplicationUpdateGuard } from './application-update-guard';
import { draftPromptText, localPreviewUrl } from '../shared/draft-evidence';
import { draftEvidenceListSchema, draftEvidenceSchema } from './draft-evidence-schema';
import type { DraftEvidence } from '../shared/types';

const idSchema = z.string().min(1).max(200);
const cwdSchema = z.string().min(1).max(4096);
const promptSchema = z.string().trim().min(1).max(PROMPT_TEXT_LIMIT);
const modelIdSchema = z.string().min(1).max(1000).optional();
const settingsSchema = z.object({ effort: z.string().min(1).max(100).nullable().optional(), permission: sessionPermissionSchema.nullable().optional(), skillIds: z.array(idSchema).max(8).nullable().optional() }).strict();
const sessionUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional(),
  modelId: modelIdSchema.nullable(), settings: settingsSchema.optional(),
  skillAssignment: z.object({ skillId: idSchema, enabled: z.boolean() }).strict().optional(),
  messageTarget: z.object({ sessionId: idSchema, enabled: z.boolean() }).strict().optional(),
}).strict();
// Older oversized drafts stay editable until the user removes the excess files.
const draftInputSchema = z.object({ text: z.string().max(PROMPT_TEXT_LIMIT), attachments: z.array(attachmentMetadataSchema).max(8).optional(), evidence: draftEvidenceListSchema.optional() }).strict();
const promptInputSchema = draftInputSchema.refine(input => !attachmentLimitIssue(input.attachments ?? []), {
  path: ['attachments'], message: `每轮最多 ${ATTACHMENT_LIMITS.count} 个附件，总大小最多 ${ATTACHMENT_LIMITS.totalBytes / 1024 / 1024} MiB。`,
}).refine(input => draftPromptText(input).length <= PROMPT_TEXT_LIMIT, { path: ['text'], message: '任务和引用合计超过文本长度限制。' });
const commandIdSchema = z.string().min(1).max(200).optional();
const queueRevisionSchema = z.number().int().nonnegative();
const queueEditIdSchema = z.string().uuid();
const pageLimitSchema = z.number().int().min(1).max(200).optional();
const messageCursorSchema = z.string().min(1).max(4096);
const branchNameSchema = z.string().min(1).max(4096);
const sessionLocationSchema = z.object({ workspaceId: idSchema, choice: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current'), branch: branchNameSchema.nullable() }).strict(),
  z.object({ kind: z.literal('registered'), cwd: cwdSchema, branch: branchNameSchema.nullable() }).strict(),
  z.object({ kind: z.literal('managed'), planId: z.string().uuid(), cwd: cwdSchema, branch: branchNameSchema,
    fromRef: branchNameSchema.regex(/^refs\/heads\/[^\0\r\n]+$/u) }).strict(),
]) }).strict();
const sessionInputSchema = z.object({ title: z.string().max(200), providerId: idSchema, cwd: cwdSchema, modelId: modelIdSchema,
  commandId: commandIdSchema, initialDraft: draftInputSchema.shape.text.optional(), location: sessionLocationSchema.optional() }).strict();
const continuationTargetSchema = sessionInputSchema.pick({ providerId: true, modelId: true });
const sideQuestionSchema = z.object({
  question: z.string().trim().min(1).max(SIDE_QUESTION_LIMIT),
  reference: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('answer'), messageId: idSchema, excerpt: z.string().trim().min(1).max(SIDE_QUESTION_REFERENCE_LIMIT) }).strict(),
    z.object({ kind: z.literal('trace'), messageId: idSchema }).strict(),
  ]),
}).strict();
const workflowSchema = z.object({
  name: z.string().trim().min(1).max(200), cwd: cwdSchema,
  steps: z.array(z.object({ id: idSchema, title: z.string().trim().min(1).max(200), providerId: idSchema, modelId: modelIdSchema, prompt: promptSchema, dependsOn: z.array(idSchema).max(50) }).strict()).min(1).max(50),
}).strict();

export async function createWorkbenchService(options: {
  dataPath: string; command: string; bridgePath: string; publish(snapshot: Snapshot): void;
  publishTerminal?(event: TerminalOutputEvent): void;
  providers?: import('./providers/types').ProviderAdapter[];
}) {
  const store = new StateStore(join(options.dataPath, 'state.json'));
  const cleanup: (() => Promise<unknown>)[] = [() => store.close()];
  try {
    await store.load();
    const health = new ProviderHealthRegistry();
    const diagnostics = new DiagnosticJournal(join(options.dataPath, 'diagnostics', 'lifecycle.ndjson'));
    await diagnostics.load().catch(() => {});
    cleanup.push(() => diagnostics.flush());
    let managedWorktrees: ManagedWorktrees | undefined;
    const pluginPath = join(options.dataPath, 'plugins');
    await mkdir(pluginPath, { recursive: true });
    const publicSnapshot = (snapshot: Snapshot): Snapshot => {
      const { sessionHandoffs, identities, ...collaboration } = store.state.collaboration;
      return {
        version: 1, sessions: snapshot.sessions, workflows: snapshot.workflows,
        providers: snapshot.providers.map(provider => health.describe(provider)), dataPath: snapshot.dataPath,
        pluginPath: snapshot.pluginPath, pluginErrors: snapshot.pluginErrors, terminals: snapshot.terminals, mails: snapshot.mails,
        workspaces: snapshot.workspaces.map(workspace => {
          const worktree = managedWorktrees?.metadata(workspace.id);
          return { ...workspace, ...(worktree ? { worktree } : managedWorktrees?.isManaged(workspace.id) ? { managedWorktreeAlias: true as const } : {}) };
        }),
        collaborationEventSeq: store.latestEventSeq(), collaboration: {
          ...collaboration,
          identities: identities.map(({ tokenHash: _, ...identity }) => identity),
          sessionLinks: projectSessionCollaborations(snapshot.sessions, sessionHandoffs ?? []),
        },
      };
    };
    const publish = (snapshot: Snapshot) => options.publish(publicSnapshot(snapshot));
    const engine = new WorkbenchEngine(store, pluginPath, publish);
    const updateGuard = new ApplicationUpdateGuard(() => publicSnapshot(engine.liveSnapshot()));
    cleanup.push(() => engine.shutdown());
    const installedAcp = new InstalledAcpRuntimes(join(options.dataPath, 'acp-runtimes'));
    cleanup.push(() => installedAcp.close());
    await installedAcp.load();
    await engine.prepareExecutionKeys();
    const attachments = new AttachmentService(join(options.dataPath, 'attachments'));
    const core = new CollaborationCore(store, engine, { attachments, publish: () => publish(engine.liveSnapshot()) });
    cleanup.push(() => core.close());
    const identities = new IdentityService(store, options.command, options.bridgePath);
    let publicEndpoint = '';
    const runtimeSettings = new RuntimeSettings(join(options.dataPath, 'mcp-settings'));
    const workspaceFiles = new WorkspaceFiles();
    const collaboration = new CollaborationServer((caller, tool, input) => updateGuard.run(() => core.call(core.managedCaller(caller.sessionId, caller.attemptId)
      ?? { kind: 'session', ...caller }, tool, input)), options.command, options.bridgePath);
    cleanup.push(() => collaboration.close());
    await collaboration.start();
    engine.setTurnEnricher(async (session, prompt, userMessageId) => {
      const attemptId = session.attempts?.at(-1)?.id;
      if (!attemptId) throw new Error('缺少当前任务身份。');
      const prepared = await runtimeSettings.enrich(session, prompt);
      const loaded = await attachments.load(session.messages.find(message => message.id === userMessageId)?.attachments ?? []);
      const issued = collaboration.issue({ sessionId: session.id, attemptId });
      return { ...prepared, attachments: loaded, mcpServers: [...prepared.mcpServers, issued.config], cleanup: issued.cleanup };
    });
    const terminalManager = new TerminalManager(() => engine.setTerminals(terminalManager.metadata()), options.publishTerminal);
    cleanup.push(() => terminalManager.shutdown());
    managedWorktrees = new ManagedWorktrees(store, engine, join(options.dataPath, 'worktrees'), workspaceId => {
      const affected = new Set(managedWorktrees!.workspaceIds(workspaceId));
      if (terminalManager.metadata().some(terminal => affected.has(terminal.workspaceId) && terminal.status === 'running')) throw new Error('请先停止该工作区的终端，再回收目录。');
    });
    const stopDiagnostics = engine.subscribeExecution(observation => {
      const session = store.state.sessions.find(item => item.id === observation.sessionId);
      if (!session) return;
      const context = { providerId: session.providerId, sessionId: session.id, attemptId: observation.attemptId,
        ...('turnId' in observation ? { turnId: observation.turnId } : {}) };
      if (observation.type === 'input') {
        health.observe(observation, session);
        diagnostics.record({ ...context, layer: 'engine', kind: 'dispatch.started' });
      }
      else if (observation.type === 'settled') {
        health.observe(observation, session);
        diagnostics.record({ ...context, layer: 'engine', kind: 'dispatch.settled', status: observation.status,
          ...(observation.error ? { errorCode: /auth|401|api.?key|logged in/i.test(observation.error) ? 'authentication' : /timeout|超时/i.test(observation.error) ? 'timeout' : 'runtime-failure' } : {}) });
        engine.publishState();
      } else if (observation.event.type !== 'text' && observation.event.type !== 'activity') {
        const event = observation.event;
        diagnostics.record({ ...context, layer: 'engine', kind: 'normalized', eventType: event.type,
          ...(event.type === 'structured' ? { requestId: event.event.id, status: event.event.status } : event.type === 'delivery' ? { status: event.status } : {}) });
      }
    });
    cleanup.push(async () => stopDiagnostics());
    const wrapped = new WeakMap<import('./providers/types').ProviderAdapter, import('./providers/types').ProviderAdapter>();
    const instrument = (adapter: import('./providers/types').ProviderAdapter) => {
      let result = wrapped.get(adapter);
      if (!result) { result = withProviderDiagnostics(adapter, diagnostics); wrapped.set(adapter, result); }
      return result;
    };
    let codexProvider: Awaited<ReturnType<typeof createCodexProvider>> | undefined;
    let openCodeProvider: AcpProvider | undefined;
    let deepSeekProvider: AcpProvider | undefined;
    let geminiProvider: AcpProvider | undefined;
    let cursorProvider: AcpProvider | undefined;
    let qoderProvider: AcpProvider | undefined;
    let baseProviders: ProviderAdapter[] = options.providers ?? [];
    let pluginErrors: string[] = [];
    const publishProviders = () => engine.setProviders([...baseProviders, ...installedAcp.adapters()].map(instrument), [], pluginErrors);
    const installer = new RuntimeInstaller(options.dataPath, async id => {
      await refreshProviders();
      return engine.liveSnapshot().providers.some(provider => provider.id === id && provider.available);
    });
    cleanup.push(() => installer.shutdown());
    let providerRefresh: Promise<void> | undefined;
    function refreshProviders(): Promise<void> {
      if (providerRefresh) return providerRefresh;
      providerRefresh = discoverProviders().finally(() => { providerRefresh = undefined; });
      return providerRefresh;
    }
    async function discoverProviders(): Promise<void> {
      if (codexProvider) await codexProvider.refreshInfo();
      else codexProvider = await createCodexProvider(() => installer.managedBinary('codex'));
      const dataPath = dirname(engine.store.path);
      const [claude, pi, plugins] = await Promise.all([
        createClaudeProvider(), installer.managedBinary('pi').then(managedBinary => createPiProvider({ dataPath, managedBinary })), loadPluginProviders(engine.pluginPath),
        openCodeProvider ? openCodeProvider.refreshInfo() : createAcpProvider('opencode', 'OpenCode', () => createOpenCodeDescriptor({ dataPath })).then(provider => { openCodeProvider = provider; }),
        deepSeekProvider ? deepSeekProvider.refreshInfo() : createAcpProvider('deepseek-harness', 'DeepSeek Harness', () => createDeepSeekHarnessDescriptor({ dataPath })).then(provider => { deepSeekProvider = provider; }),
        geminiProvider ? geminiProvider.refreshInfo() : createAcpProvider('gemini', 'Gemini CLI', async () => createGeminiDescriptor({ dataPath, managedBinary: await installer.managedBinary('gemini') })).then(provider => { geminiProvider = provider; }),
        cursorProvider ? cursorProvider.refreshInfo() : createAcpProvider('cursor', 'Cursor Agent', () => createCursorDescriptor({ dataPath })).then(provider => { cursorProvider = provider; }),
        qoderProvider ? qoderProvider.refreshInfo() : createAcpProvider('qoder', 'Qoder CLI', () => createQoderDescriptor()).then(provider => { qoderProvider = provider; }),
        installedAcp.refresh(),
      ]);
      baseProviders = [codexProvider, claude, pi, geminiProvider!, cursorProvider!, qoderProvider!, openCodeProvider!, deepSeekProvider!, ...plugins.adapters];
      pluginErrors = plugins.errors;
      publishProviders();
    }


    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const workspaceMutations = new Set(['workbench:create-terminal', 'workbench:write-file', 'workbench:git-mutate', 'workbench:git-commit',
      'workbench:save-skill', 'workbench:save-mcp-settings', 'workbench:test-mcp-server']);
    const handle = (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, (event, ...args) => workspaceMutations.has(channel)
        ? managedWorktrees!.access(idSchema.parse(args[0]), () => handler(event, ...args)) : handler(event, ...args));
    };
    handle('workbench:snapshot', () => publicSnapshot(engine.snapshot()));
    const session = (value: unknown) => {
      const id = idSchema.parse(value);
      const result = store.state.sessions.find(item => item.id === id);
      if (!result) throw new Error('会话不存在。');
      return result;
    };
    handle('workbench:session-history', (_event, id, before, limit) => sessionHistory(session(id), { before: messageCursorSchema.optional().parse(before), limit: pageLimitSchema.parse(limit) }));
    handle('workbench:session-history-around', (_event, id, messageId, limit) => sessionHistory(session(id), { around: messageCursorSchema.parse(messageId), limit: pageLimitSchema.parse(limit) }));
    handle('workbench:session-history-after', (_event, id, after, limit) => sessionHistory(session(id), { after: messageCursorSchema.parse(after), limit: pageLimitSchema.parse(limit) }));
    handle('workbench:session-search', (_event, id, query, limit) => searchMessages(session(id), z.string().trim().min(1).max(2000).parse(query), pageLimitSchema.parse(limit)));
    handle('workbench:search-sessions', (_event, query, includeArchived) => {
      const needle = z.string().trim().min(1).max(2000).parse(query).toLocaleLowerCase();
      const archived = z.boolean().optional().parse(includeArchived) ?? false;
      return { sessionIds: store.state.sessions.filter(item => (archived || !item.archived)
        && (item.title.toLocaleLowerCase().includes(needle) || item.cwd.toLocaleLowerCase().includes(needle)
          || item.providerId.toLocaleLowerCase().includes(needle) || item.messages.some(message => searchableMessageText(message).toLocaleLowerCase().includes(needle)))).map(item => item.id) };
    });
    handle('workbench:mark-session-seen', (_event, id, revision) => {
      const item = session(id); const value = z.number().int().nonnegative().parse(revision);
      if (!item.attention) return;
      if (value > item.attention.revision) throw new Error('不能确认尚未收到的结果版本。');
      store.atomic(() => { item.attention!.seenRevision = Math.max(item.attention!.seenRevision, value); });
      engine.publishState();
    });
    handle('workbench:command-receipt', (_event, id) => engine.commandReceipt(idSchema.parse(id)));
    handle('workbench:begin-queued-prompt-edit', (_event, id, itemId, revision, editId, ownerId) =>
      engine.beginQueuedPromptEdit(idSchema.parse(id), idSchema.parse(itemId), queueRevisionSchema.parse(revision), queueEditIdSchema.parse(editId), queueEditIdSchema.parse(ownerId)));
    handle('workbench:renew-queued-prompt-edit', (_event, id, itemId, editId) =>
      engine.renewQueuedPromptEdit(idSchema.parse(id), idSchema.parse(itemId), queueEditIdSchema.parse(editId)));
    handle('workbench:save-queued-prompt-draft', (_event, id, itemId, editId, revision, input) =>
      engine.saveQueuedPromptDraft(idSchema.parse(id), idSchema.parse(itemId), queueEditIdSchema.parse(editId), queueRevisionSchema.positive().parse(revision), draftInputSchema.parse(input)));
    handle('workbench:finish-queued-prompt-edit', (_event, id, itemId, editId, input) =>
      engine.finishQueuedPromptEdit(idSchema.parse(id), idSchema.parse(itemId), queueEditIdSchema.parse(editId), promptInputSchema.optional().parse(input)));
    handle('workbench:remove-queued-prompt', (_event, id, itemId, revision, commandId, editId) =>
      engine.removeQueuedPrompt(idSchema.parse(id), idSchema.parse(itemId), queueRevisionSchema.parse(revision), commandIdSchema.parse(commandId), queueEditIdSchema.optional().parse(editId)));
    handle('workbench:move-queued-prompt', (_event, id, itemId, targetId, expectedOrder, commandId) =>
      engine.moveQueuedPrompt(idSchema.parse(id), idSchema.parse(itemId), idSchema.parse(targetId), idSchema.array().parse(expectedOrder), commandIdSchema.parse(commandId)));
    handle('workbench:set-session-queue-paused', (_event, id, paused) => engine.setSessionQueuePaused(idSchema.parse(id), z.boolean().parse(paused)));
    handle('workbench:reconcile-session-delivery', (_event, id) => engine.reconcileSessionDelivery(idSchema.parse(id)));
    handle('workbench:provider-health', (_event, cwd) => engine.liveSnapshot().providers.map(provider => health.describe(provider, cwdSchema.optional().parse(cwd))));
    handle('workbench:diagnostics', () => diagnostics.snapshot());
    handle('workbench:export-diagnostics', () => diagnostics.export(join(options.dataPath, 'diagnostics', 'exports')));
    handle('workbench:set-diagnostic-tracing', (_event, enabled) => diagnostics.setTracing(z.boolean().parse(enabled)));
    handle('workbench:diagnostic-tracing', () => diagnostics.isTracing());
    handle('workbench:remove-worktree', (_event, id) => managedWorktrees!.remove(idSchema.parse(id)));
    handle('workbench:collaboration-call', async (_event, operation, input) => {
      const name = idSchema.parse(operation);
      if (name === 'issue_identity') {
        const result = await identities.issue(input, publicEndpoint); publish(engine.snapshot()); return result;
      }
      if (name === 'revoke_identity') { identities.revoke(input); publish(engine.snapshot()); return null; }
      return core.call({ kind: 'user' }, name, input);
    });
    handle('workbench:collaboration-events', (_event, runId, afterSeq, limit) => core.queryEvents({ kind: 'user' }, {
      runId: idSchema.parse(runId), afterSeq: z.number().int().nonnegative().optional().parse(afterSeq), limit: z.number().int().min(1).max(1000).optional().parse(limit),
    }));
    handle('workbench:refresh-providers', () => refreshProviders());
    handle('workbench:runtime-installs', () => installer.list());
    handle('workbench:install-runtime', (_event, input) => {
      const id = idSchema.parse(input);
      if (!engine.liveSnapshot().providers.some(provider => provider.id === id && provider.source === 'builtin' && !provider.available)) {
        throw new Error('Runtime installation is only available for missing built-in runtimes');
      }
      return installer.install(id);
    });
    handle('workbench:cancel-runtime-install', (_event, id) => installer.cancel(idSchema.parse(id)));
    handle('workbench:add-custom-acp', async (_event, requestId, input) => {
      await installedAcp.add(z.string().uuid().parse(requestId), input);
      publishProviders();
    });
    handle('workbench:cancel-custom-acp', (_event, requestId) => installedAcp.cancel(z.string().uuid().parse(requestId)));
    handle('workbench:remove-custom-acp', async (_event, providerId) => {
      const id = idSchema.parse(providerId);
      engine.assertProviderIdle(id);
      const removed = installedAcp.remove(id);
      publishProviders();
      await engine.disposeRemovedProvider(instrument(removed));
    });
    handle('workbench:session-locations', (_event, id) => managedWorktrees!.sessionLocations(idSchema.parse(id)));
    handle('workbench:create-session', (_event, input: unknown) => {
      const parsed = sessionInputSchema.parse(input);
      const location = parsed.location;
      return engine.createSession(parsed, location
        ? () => managedWorktrees!.resolveSessionLocation(location.workspaceId, parsed.cwd, parsed.title, location.choice) : undefined);
    });
    handle('workbench:send-message', (_event, id, prompt, commandId) => engine.sendMessage(idSchema.parse(id), promptSchema.parse(prompt), commandIdSchema.parse(commandId)));
    handle('workbench:cancel-session', (_event, id, commandId, expectedAttemptId) => engine.cancelSession(idSchema.parse(id), commandIdSchema.parse(commandId), idSchema.optional().parse(expectedAttemptId)));
    handle('workbench:decide-approval', (_event, id, choice, commandId) => engine.decideApproval(idSchema.parse(id), idSchema.parse(choice), commandIdSchema.parse(commandId)));
    handle('workbench:answer-questions', (_event, id, answers, commandId) => engine.answerQuestions(idSchema.parse(id), z.record(z.array(z.string().min(1).max(10_000)).min(1).max(50)).parse(answers), commandIdSchema.parse(commandId)));
    handle('workbench:create-workflow', (_event, input: unknown) => engine.createWorkflow(workflowSchema.parse(input)));
    handle('workbench:start-workflow', (_event, id: unknown) => engine.startWorkflow(idSchema.parse(id)));
    handle('workbench:cancel-workflow', (_event, id: unknown) => engine.cancelWorkflow(idSchema.parse(id)));
    handle('workbench:create-workspace', (_event, input: unknown) => {
      const parsed = z.object({ name: z.string().max(200), cwd: cwdSchema, mode: z.enum(['directory', 'worktree']).optional(), branch: z.string().trim().min(1).max(200).optional(), commandId: commandIdSchema }).strict().parse(input);
      return parsed.mode === 'worktree' ? managedWorktrees!.create(parsed) : engine.createWorkspace(parsed);
    });
    handle('workbench:update-workspace', (_event, id: unknown, input: unknown) => engine.updateWorkspace(idSchema.parse(id), z.object({ name: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional() }).strict().parse(input)));
    handle('workbench:manage-workspace', (_event, id, input) => {
      const workspaceId = idSchema.parse(id);
      const change = z.union([
        z.object({ action: z.literal('relocate'), cwd: cwdSchema }).strict(),
        z.object({ action: z.enum(['archive', 'restore', 'remove']) }).strict(),
      ]).parse(input);
      return engine.manageWorkspace(workspaceId, change, destination => {
        managedWorktrees!.assertOrdinaryProjectChange(workspaceId, destination);
        if (change.action !== 'restore' && terminalManager.metadata().some(terminal => terminal.workspaceId === workspaceId && terminal.status === 'running')) {
          throw new Error('请先停止该项目的终端。');
        }
      });
    });
    handle('workbench:activate-tab', (_event, workspaceId: unknown, tabId: unknown) => engine.activateTab(idSchema.parse(workspaceId), idSchema.parse(tabId)));
    handle('workbench:close-tab', (_event, workspaceId: unknown, tabId: unknown, confirmStop: unknown) => {
      const workspace = engine.workspace(idSchema.parse(workspaceId));
      const id = idSchema.parse(tabId);
      const tab = workspace.tabs.find(item => item.id === id);
      const confirmed = z.boolean().optional().parse(confirmStop);
      if (tab?.kind === 'terminal' && terminalManager.metadata().some(info => info.id === tab.terminalId && info.status === 'running')) {
        if (!confirmed) throw new Error('请先确认停止运行中的终端。');
        terminalManager.stop(tab.terminalId);
      }
      engine.closeTab(workspace.id, id);
    });
    handle('workbench:open-session-tab', (_event, workspaceId: unknown, sessionId: unknown, besideSessionId?: unknown) =>
      engine.openSessionTab(idSchema.parse(workspaceId), idSchema.parse(sessionId), idSchema.optional().parse(besideSessionId)));
    handle('workbench:create-terminal', (_event, workspaceId: unknown, besideSessionId?: unknown) => {
      const workspace = engine.workspace(idSchema.parse(workspaceId));
      managedWorktrees!.assertWorkspaceAvailable(workspace.id);
      const beside = idSchema.optional().parse(besideSessionId);
      if (beside) {
        const primary = workspace.tabs.find(tab => tab.id === workspace.activeTabId);
        if (primary?.kind !== 'agent' || primary.sessionId !== beside) throw new Error('会话已经切换，请从当前会话打开终端。');
        const secondary = workspace.tabs.find(tab => tab.id === workspace.secondaryTabId);
        if (secondary?.kind === 'terminal' && terminalManager.metadata().some(terminal =>
          terminal.id === secondary.terminalId && terminal.status === 'running')) return secondary.terminalId;
      }
      const terminal = terminalManager.create(workspace.id, workspace.cwd);
      engine.setTerminals(terminalManager.metadata());
      engine.addTab(workspace.id, { id: randomUUID(), kind: 'terminal', terminalId: terminal.id }, beside ? 'secondary' : 'active');
      return terminal.id;
    });
    handle('workbench:write-terminal', (_event, id: unknown, data: unknown) => terminalManager.write(idSchema.parse(id), z.string().max(65_536).parse(data)));
    handle('workbench:resize-terminal', (_event, id: unknown, columns: unknown, rows: unknown) => terminalManager.resize(idSchema.parse(id), z.number().int().min(2).max(1000).parse(columns), z.number().int().min(1).max(1000).parse(rows)));
    handle('workbench:stop-terminal', (_event, id: unknown) => terminalManager.stop(idSchema.parse(id)));
    handle('workbench:list-terminal-services', (_event, id: unknown) => terminalManager.listServices(idSchema.parse(id)));
    handle('workbench:create-preview', (_event, workspaceId: unknown, input: unknown) => {
      const id = idSchema.parse(workspaceId);
      const url = localPreviewUrl(z.string().max(4096).parse(input));
      if (!url) throw new Error('预览仅支持本机 localhost 页面。');
      engine.addTab(id, { id: randomUUID(), kind: 'preview', url: url.toString() });
    });
    handle('workbench:preview-draft-evidence', (_event, input) => {
      const tabId = idSchema.parse(input);
      const entries: Array<[string, DraftEvidence[]]> = [];
      for (const item of store.state.sessions) {
        const matches = item.draft?.evidence?.filter(({ source }) => source.kind === 'preview' && source.tabId === tabId);
        if (matches?.length) entries.push([item.id, matches]);
      }
      return Object.fromEntries(entries);
    });
    handle('workbench:list-files', async (_event, workspaceId, path) => {
      const cwd = engine.workspace(idSchema.parse(workspaceId)).cwd;
      try { return await workspaceFiles.list(cwd, z.string().max(4096).optional().parse(path)); }
      catch (error) { if (error instanceof MissingWorkspaceDirectoryError) return null; throw error; }
    });
    handle('workbench:find-workspace-files', (_event, workspaceId, query) =>
      workspaceFiles.find(engine.workspace(idSchema.parse(workspaceId)).cwd, z.string().max(4096).parse(query)));
    handle('workbench:search-workspace-text', (_event, workspaceId, query) =>
      workspaceFiles.searchText(engine.workspace(idSchema.parse(workspaceId)).cwd, z.string().max(4096).parse(query)));
    handle('workbench:read-file', async (_event, workspaceId: unknown, path: unknown) => {
      try { return await workspaceFiles.read(engine.workspace(idSchema.parse(workspaceId)).cwd, z.string().min(1).max(4096).parse(path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    });
    handle('workbench:git-state', (_event, workspaceId: unknown) => workspaceFiles.gitState(engine.workspace(idSchema.parse(workspaceId)).cwd));
    handle('workbench:file-diff', (_event, workspaceId: unknown, path: unknown) => workspaceFiles.diff(engine.workspace(idSchema.parse(workspaceId)).cwd, z.string().min(1).max(4096).parse(path)));
    handle('workbench:send-prompt', (_event, id, input, commandId, expectedProviderId) =>
      engine.sendPrompt(idSchema.parse(id), promptInputSchema.parse(input), commandIdSchema.parse(commandId), idSchema.optional().parse(expectedProviderId)));
    handle('workbench:save-session-draft', (_event, id, input) => engine.saveSessionDraft(idSchema.parse(id), draftInputSchema.parse(input)));
    handle('workbench:switch-session-runtime', (_event, id, targetProviderId, expectedProviderId) =>
      engine.switchSessionRuntime(idSchema.parse(id), idSchema.parse(targetProviderId), idSchema.parse(expectedProviderId)));
    handle('workbench:add-session-attachment', async (_event, id, input) => {
      const sessionId = idSchema.parse(id);
      const attachment = attachmentMetadataSchema.parse(input);
      await attachments.load([attachment]);
      return engine.addSessionAttachment(sessionId, attachment);
    });
    handle('workbench:add-session-evidence', (_event, id, evidence) => engine.addSessionEvidence(idSchema.parse(id), draftEvidenceSchema.parse(evidence)));
    handle('workbench:update-session', (_event, id, input) => engine.updateSession(idSchema.parse(id), sessionUpdateSchema.parse(input)));
    handle('workbench:fork-session', (_event, id, before, beside) => engine.forkSession(
      idSchema.parse(id), idSchema.optional().parse(before), undefined, z.boolean().optional().parse(beside)));
    handle('workbench:continue-session', (_event, id, target) => engine.forkSession(idSchema.parse(id), undefined, continuationTargetSchema.parse(target)));
    handle('workbench:ask-side-question', (_event, id, input, commandId) => engine.askSideQuestion(idSchema.parse(id), sideQuestionSchema.parse(input), commandIdSchema.parse(commandId)));
    handle('workbench:rewind-session', (_event, id, messageId) => engine.rewindSession(idSchema.parse(id), idSchema.parse(messageId)));
    handle('workbench:retry-step', (_event, id, stepId) => engine.retryWorkflowStep(idSchema.parse(id), idSchema.parse(stepId)));
    handle('workbench:clone-workflow', (_event, id) => engine.cloneWorkflow(idSchema.parse(id)));
    handle('workbench:resume-workflow', (_event, id) => engine.resumeWorkflow(idSchema.parse(id)));
    handle('workbench:split-workspace', (_event, id, input) => engine.splitWorkspace(idSchema.parse(id), z.object({
      tabId: idSchema.optional(),
      direction: z.enum(['horizontal', 'vertical']).optional(),
      ratio: z.number().min(0.2).max(0.8).optional(),
      placement: z.enum(['before', 'after']).optional(),
      expectedLayout: z.object({ activeTabId: idSchema.nullable(), secondaryTabId: idSchema.nullable() }).strict().optional(),
    }).strict().parse(input)));
    const workspaceCwd = (id: unknown) => engine.workspace(idSchema.parse(id)).cwd;
    handle('workbench:git-branch-refs', (_event, id) => workspaceFiles.gitBranchRefs(workspaceCwd(id)));
    handle('workbench:git-branch-comparison', (_event, id, targetRef) =>
      workspaceFiles.gitBranchComparison(workspaceCwd(id), z.string().min(1).max(4096).parse(targetRef)));
    handle('workbench:git-history', (_event, id, query, allBranches, limit) =>
      workspaceFiles.gitHistory(workspaceCwd(id), z.string().trim().max(256).parse(query), z.boolean().parse(allBranches), z.number().int().min(1).max(500).parse(limit)));
    handle('workbench:git-commit-files', (_event, id, sha) => workspaceFiles.gitCommitFiles(workspaceCwd(id), idSchema.parse(sha)));
    handle('workbench:git-commit-diff', (_event, id, sha, path) => workspaceFiles.gitCommitDiff(workspaceCwd(id), idSchema.parse(sha), cwdSchema.parse(path)));
    handle('workbench:write-file', (_event, id, input) => workspaceFiles.write(workspaceCwd(id), z.object({ path: cwdSchema, content: z.string().max(1_048_576), revision: idSchema }).strict().parse(input)));
    handle('workbench:git-mutate', (_event, id, input) => {
      const cwd = workspaceCwd(id);
      const mutation = z.union([
        z.object({ action: z.enum(['stage', 'unstage', 'discard']), path: cwdSchema, revision: idSchema.optional() }).strict(),
        z.object({ action: z.enum(['stage', 'unstage']), paths: z.array(cwdSchema).min(1).max(2000) }).strict(),
      ]).parse(input);
      return engine.withProjectMutation(cwd, () => workspaceFiles.mutate(cwd, mutation));
    });
    handle('workbench:git-commit-preview', (_event, id) => workspaceFiles.commitPreview(workspaceCwd(id)));
    handle('workbench:git-commit', (_event, id, input) => {
      const cwd = workspaceCwd(id);
      const commit = z.object({ message: z.string().trim().min(1).max(10_000), revision: idSchema }).strict().parse(input);
      return engine.withProjectMutation(cwd, () => workspaceFiles.commit(cwd, commit));
    });
    handle('workbench:review-pull-request', (_event, id) => reviewPullRequest(workspaceCwd(id)));
    handle('workbench:list-skills', (_event, id) => runtimeSettings.listSkills(workspaceCwd(id)));
    handle('workbench:read-skill', (_event, id, skillId) => runtimeSettings.readSkill(workspaceCwd(id), idSchema.parse(skillId)));
    handle('workbench:save-skill', (_event, id, input) => runtimeSettings.saveSkill(workspaceCwd(id), z.object({ name: idSchema, content: z.string().max(64_000), revision: idSchema.optional() }).strict().parse(input)));
    handle('workbench:mcp-settings', (_event, id) => runtimeSettings.mcpSettings(workspaceCwd(id)));
    handle('workbench:save-mcp-settings', (_event, id, input) => runtimeSettings.saveMcpSettings(workspaceCwd(id), z.object({ content: z.string().max(256_000), revision: idSchema }).strict().parse(input)));
    handle('workbench:test-mcp-server', (_event, id, name) => runtimeSettings.testServer(workspaceCwd(id), idSchema.parse(name)));
    handle('workbench:deepseek-balance', () => readDeepSeekBalance());

    handle('workbench:import-attachments', (_event, paths) => attachments.importFiles(z.array(cwdSchema).max(ATTACHMENT_LIMITS.count).parse(paths)));
    handle('workbench:import-workspace-attachments', async (_event, id, paths) => {
      const files = await workspaceFiles.resolveFilePaths(workspaceCwd(id), cwdSchema.array().min(1).max(ATTACHMENT_LIMITS.count).parse(paths));
      return attachments.importFiles(files);
    });

    if (options.providers) publishProviders();
    else await refreshProviders();
    const readUpdateRecord = async (name: string): Promise<unknown> => {
      try { return JSON.parse(await readFile(join(options.dataPath, 'updates', name), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const pendingUpdate = z.object({ token: z.string().uuid(), version: z.string() }).optional().parse(await readUpdateRecord('pending.json'));
    const metadata = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'));
    if (pendingUpdate && pendingUpdate.version === metadata.version) {
      if (process.env.WORKBENCH_UPDATE_TOKEN && process.env.WORKBENCH_UPDATE_TOKEN !== pendingUpdate.token) throw new Error('更新启动凭据与当前安装包不匹配。');
      const result = z.object({ token: z.string(), version: z.string(), status: z.string() }).optional().parse(await readUpdateRecord('result.json'));
      if (result?.status !== 'installed' || result.token !== pendingUpdate.token || result.version !== metadata.version) updateGuard.begin(pendingUpdate.token);
    } else if (process.env.WORKBENCH_UPDATE_TOKEN) {
      throw new Error('更新启动凭据与当前安装包不匹配。');
    }
    delete process.env.WORKBENCH_UPDATE_TOKEN;
    return {
      engine, store, attachments, runtimeSettings, collaboration, core,
      setPublicEndpoint: (url: string) => { publicEndpoint = url; },
      authenticate: (token: string) => identities.authenticate(token),
      externalCall: (token: string, operation: string, input: unknown) => updateGuard.run(() => core.call({ kind: 'external', identityId: identities.authenticate(token).id }, operation, input)),
      commands: [...handlers.keys(), 'workbench:begin-application-update', 'workbench:cancel-application-update'],
      async call(channel: string, args: unknown[]): Promise<unknown> {
        if (channel === 'workbench:begin-application-update') { updateGuard.begin(z.string().uuid().parse(args[0])); return null; }
        if (channel === 'workbench:cancel-application-update') { updateGuard.cancel(z.string().uuid().parse(args[0])); return null; }
        const handler = handlers.get(channel);
        if (!handler) throw new Error('未知的后台命令。');
        return updateGuard.run(() => handler(null, ...args));
      },
      snapshot: () => publicSnapshot(engine.snapshot()),
      streamSnapshot: () => publicSnapshot(engine.liveSnapshot()),
      terminalSnapshot: (id: string) => terminalManager.get(id),
      async shutdown(): Promise<void> {
        stopDiagnostics();
        await installer.shutdown();
        const results = await Promise.allSettled([core.close(), terminalManager.shutdown(), engine.shutdown(), collaboration.close(), installedAcp.close()]);
        results.push(...await Promise.allSettled([store.close(), diagnostics.flush()]));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), '后台退出未完成');
      },
    };
  } catch (error) {
    for (const dispose of cleanup.reverse()) await dispose().catch(() => {});
    throw error;
  }
}
export type WorkbenchService = Awaited<ReturnType<typeof createWorkbenchService>>;
