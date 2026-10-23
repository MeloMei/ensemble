import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkbenchEngine } from './engine';
import { StateStore } from './store';
import { createCodexProvider } from './providers/codex';
import { createClaudeProvider } from './providers/claude';
import { createAcpProvider, type AcpProvider } from './providers/acp';
import { createOpenCodeDescriptor } from './providers/opencode';
import { createDeepSeekHarnessDescriptor } from './providers/deepseek-harness';
import { loadPluginProviders } from './providers/plugins';
import { TerminalManager } from './terminal-manager';
import { WorkspaceFiles } from './workspace-files';
import type { ProviderInfo, Snapshot } from '../shared/types';
import { AttachmentService } from './attachment-service';
import { RuntimeSettings, readDeepSeekBalance } from './runtime-settings';
import { CollaborationServer } from './collaboration-server';
import { reviewPullRequest } from './pull-request-review';
import { CollaborationCore } from './collaboration-core';
import { IdentityService } from './identity-service';

const idSchema = z.string().min(1).max(200);
const cwdSchema = z.string().min(1).max(4096);
const promptSchema = z.string().trim().min(1).max(200_000);
const modelIdSchema = z.string().min(1).max(1000).optional();
const settingsSchema = z.object({ effort: z.string().min(1).max(100).nullable().optional(), permission: z.enum(['review', 'read-only']).nullable().optional(), skillIds: z.array(idSchema).max(8).nullable().optional() }).strict();
const attachmentSchema = z.object({ id: idSchema, name: z.string().min(1).max(300), kind: z.enum(['image', 'text']), mimeType: z.string().min(1).max(100), size: z.number().int().min(0).max(20_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), ownedPath: cwdSchema }).strict();
const promptInputSchema = z.object({ text: z.string().max(200_000), attachments: z.array(attachmentSchema).max(8).optional() }).strict();
const commandIdSchema = z.string().min(1).max(200).optional();
const sessionInputSchema = z.object({ title: z.string().max(200), providerId: idSchema, cwd: cwdSchema, modelId: modelIdSchema, commandId: commandIdSchema }).strict();
const workflowSchema = z.object({
  name: z.string().trim().min(1).max(200), cwd: cwdSchema,
  steps: z.array(z.object({ id: idSchema, title: z.string().trim().min(1).max(200), providerId: idSchema, modelId: modelIdSchema, prompt: promptSchema, dependsOn: z.array(idSchema).max(50) }).strict()).min(1).max(50),
}).strict();

const unavailable: ProviderInfo[] = [
  { id: 'cursor', name: 'Cursor', source: 'builtin', available: false, detail: '接入适配器待实现。本机尚未检测到 Cursor Agent。', capabilities: { resume: false, approvals: false } },
];

export async function createWorkbenchService(options: {
  dataPath: string; command: string; bridgePath: string; publish(snapshot: Snapshot): void;
  providers?: import('./providers/types').ProviderAdapter[];
}) {
  const store = new StateStore(join(options.dataPath, 'state.json'));
  const cleanup: (() => Promise<unknown>)[] = [() => store.close()];
  try {
    await store.load();
    const pluginPath = join(options.dataPath, 'plugins');
    await mkdir(pluginPath, { recursive: true });
    const publicSnapshot = (snapshot: Snapshot): Snapshot => ({ version: 1, sessions: snapshot.sessions, workflows: snapshot.workflows,
      providers: snapshot.providers, dataPath: snapshot.dataPath,
      pluginPath: snapshot.pluginPath, pluginErrors: snapshot.pluginErrors, terminals: snapshot.terminals, mails: snapshot.mails,
      workspaces: snapshot.workspaces,
      collaborationEventSeq: store.latestEventSeq(), collaboration: {
      ...store.state.collaboration,
      identities: store.state.collaboration.identities.map(({ tokenHash: _, ...identity }) => identity),
    } });
    const publish = (snapshot: Snapshot) => options.publish(publicSnapshot(snapshot));
    const engine = new WorkbenchEngine(store, pluginPath, publish);
    cleanup.push(() => engine.shutdown());
    await engine.prepareExecutionKeys();
    const attachments = new AttachmentService(join(options.dataPath, 'attachments'));
    const core = new CollaborationCore(store, engine, { attachments, publish: () => publish(engine.liveSnapshot()) });
    cleanup.push(() => core.close());
    const identities = new IdentityService(store, options.command, options.bridgePath);
    let publicEndpoint = '';
    const runtimeSettings = new RuntimeSettings(join(options.dataPath, 'mcp-settings'));
    const workspaceFiles = new WorkspaceFiles();
    const collaboration = new CollaborationServer((caller, tool, input) => core.call(core.managedCaller(caller.sessionId, caller.attemptId)
      ?? { kind: 'session', ...caller }, tool, input), options.command, options.bridgePath);
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
    const terminalManager = new TerminalManager(() => engine.setTerminals(terminalManager.snapshot()));
    cleanup.push(() => terminalManager.shutdown());
    let codexProvider: Awaited<ReturnType<typeof createCodexProvider>> | undefined;
    let openCodeProvider: AcpProvider | undefined;
    let deepSeekProvider: AcpProvider | undefined;
    async function refreshProviders(): Promise<void> {
      if (codexProvider) await codexProvider.refreshInfo();
      else codexProvider = await createCodexProvider();
      const dataPath = dirname(engine.store.path);
      const [claude, plugins] = await Promise.all([
        createClaudeProvider(), loadPluginProviders(engine.pluginPath),
        openCodeProvider ? openCodeProvider.refreshInfo() : createAcpProvider('opencode', 'OpenCode', () => createOpenCodeDescriptor({ dataPath })).then(provider => { openCodeProvider = provider; }),
        deepSeekProvider ? deepSeekProvider.refreshInfo() : createAcpProvider('deepseek-harness', 'DeepSeek Harness', () => createDeepSeekHarnessDescriptor({ dataPath })).then(provider => { deepSeekProvider = provider; }),
      ]);
      const codex = codexProvider;
      engine.setProviders([codex, claude, openCodeProvider!, deepSeekProvider!, ...plugins.adapters], unavailable, plugins.errors);
    }


    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const handle = (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); };
    handle('workbench:snapshot', () => publicSnapshot(engine.snapshot()));
    const session = (value: unknown) => {
      const id = idSchema.parse(value);
      const result = store.state.sessions.find(item => item.id === id);
      if (!result) throw new Error('会话不存在。');
      return result;
    };
    handle('workbench:mark-session-seen', (_event, id, revision) => {
      const item = session(id); const value = z.number().int().nonnegative().parse(revision);
      if (!item.attention) return;
      if (value > item.attention.revision) throw new Error('不能确认尚未收到的结果版本。');
      store.atomic(() => { item.attention!.seenRevision = Math.max(item.attention!.seenRevision, value); });
      engine.publishState();
    });
    handle('workbench:command-receipt', (_event, id) => engine.commandReceipt(idSchema.parse(id)));
    handle('workbench:update-queued-prompt', (_event, id, itemId, input) => engine.updateQueuedPrompt(idSchema.parse(id), idSchema.parse(itemId), promptInputSchema.parse(input)));
    handle('workbench:remove-queued-prompt', (_event, id, itemId) => engine.removeQueuedPrompt(idSchema.parse(id), idSchema.parse(itemId)));
    handle('workbench:set-session-queue-paused', (_event, id, paused) => engine.setSessionQueuePaused(idSchema.parse(id), z.boolean().parse(paused)));
    handle('workbench:reconcile-session-delivery', (_event, id) => engine.reconcileSessionDelivery(idSchema.parse(id)));
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
    handle('workbench:create-session', (_event, input: unknown) => engine.createSession(sessionInputSchema.parse(input)));
    handle('workbench:send-message', (_event, id, prompt, commandId) => engine.sendMessage(idSchema.parse(id), promptSchema.parse(prompt), commandIdSchema.parse(commandId)));
    handle('workbench:cancel-session', (_event, id, commandId, expectedAttemptId) => engine.cancelSession(idSchema.parse(id), commandIdSchema.parse(commandId), idSchema.optional().parse(expectedAttemptId)));
    handle('workbench:decide-approval', (_event, id, choice, commandId) => engine.decideApproval(idSchema.parse(id), idSchema.parse(choice), commandIdSchema.parse(commandId)));
    handle('workbench:answer-questions', (_event, id, answers, commandId) => engine.answerQuestions(idSchema.parse(id), z.record(z.array(z.string().min(1).max(10_000)).min(1).max(50)).parse(answers), commandIdSchema.parse(commandId)));
    handle('workbench:create-workflow', (_event, input: unknown) => engine.createWorkflow(workflowSchema.parse(input)));
    handle('workbench:start-workflow', (_event, id: unknown) => engine.startWorkflow(idSchema.parse(id)));
    handle('workbench:cancel-workflow', (_event, id: unknown) => engine.cancelWorkflow(idSchema.parse(id)));
    handle('workbench:create-workspace', (_event, input: unknown) => engine.createWorkspace(z.object({ name: z.string().max(200), cwd: cwdSchema }).strict().parse(input)));
    handle('workbench:update-workspace', (_event, id: unknown, input: unknown) => engine.updateWorkspace(idSchema.parse(id), z.object({ name: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional() }).strict().parse(input)));
    handle('workbench:activate-tab', (_event, workspaceId: unknown, tabId: unknown) => engine.activateTab(idSchema.parse(workspaceId), idSchema.parse(tabId)));
    handle('workbench:close-tab', (_event, workspaceId: unknown, tabId: unknown) => {
      const workspace = engine.workspace(idSchema.parse(workspaceId));
      const tab = workspace.tabs.find(item => item.id === idSchema.parse(tabId));
      if (tab?.kind === 'terminal') terminalManager.stop(tab.terminalId);
      engine.closeTab(workspace.id, idSchema.parse(tabId));
    });
    handle('workbench:open-session-tab', (_event, workspaceId: unknown, sessionId: unknown) => engine.openSessionTab(idSchema.parse(workspaceId), idSchema.parse(sessionId)));
    handle('workbench:create-terminal', (_event, workspaceId: unknown) => {
      const workspace = engine.workspace(idSchema.parse(workspaceId));
      const terminal = terminalManager.create(workspace.id, workspace.cwd);
      engine.setTerminals(terminalManager.snapshot());
      engine.addTab(workspace.id, { id: randomUUID(), kind: 'terminal', terminalId: terminal.id });
      return terminal.id;
    });
    handle('workbench:write-terminal', (_event, id: unknown, data: unknown) => terminalManager.write(idSchema.parse(id), z.string().max(65_536).parse(data)));
    handle('workbench:resize-terminal', (_event, id: unknown, columns: unknown, rows: unknown) => terminalManager.resize(idSchema.parse(id), z.number().int().min(2).max(1000).parse(columns), z.number().int().min(1).max(1000).parse(rows)));
    handle('workbench:stop-terminal', (_event, id: unknown) => terminalManager.stop(idSchema.parse(id)));
    handle('workbench:create-preview', (_event, workspaceId: unknown, input: unknown) => {
      const id = idSchema.parse(workspaceId);
      const url = new URL(z.string().url().max(4096).parse(input));
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('预览仅支持本机 localhost 页面。');
      engine.addTab(id, { id: randomUUID(), kind: 'preview', url: url.toString() });
    });
    handle('workbench:list-files', (_event, workspaceId: unknown, path: unknown) => workspaceFiles.list(engine.workspace(idSchema.parse(workspaceId)).cwd, z.string().max(4096).optional().parse(path)));
    handle('workbench:read-file', async (_event, workspaceId: unknown, path: unknown) => {
      try { return await workspaceFiles.read(engine.workspace(idSchema.parse(workspaceId)).cwd, z.string().min(1).max(4096).parse(path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    });
    handle('workbench:git-state', (_event, workspaceId: unknown) => workspaceFiles.gitState(engine.workspace(idSchema.parse(workspaceId)).cwd));
    handle('workbench:file-diff', (_event, workspaceId: unknown, path: unknown) => workspaceFiles.diff(engine.workspace(idSchema.parse(workspaceId)).cwd, z.string().min(1).max(4096).parse(path)));
    handle('workbench:send-prompt', (_event, id, input, commandId) => engine.sendPrompt(idSchema.parse(id), promptInputSchema.parse(input), commandIdSchema.parse(commandId)));
    handle('workbench:save-session-draft', (_event, id, input) => engine.saveSessionDraft(idSchema.parse(id), promptInputSchema.parse(input)));
    handle('workbench:update-session', (_event, id, input) => engine.updateSession(idSchema.parse(id), z.object({ title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional(), modelId: modelIdSchema.nullable(), settings: settingsSchema.optional() }).strict().parse(input)));
    handle('workbench:fork-session', (_event, id, before) => engine.forkSession(idSchema.parse(id), idSchema.optional().parse(before)));
    handle('workbench:rewind-session', (_event, id, messageId) => engine.rewindSession(idSchema.parse(id), idSchema.parse(messageId)));
    handle('workbench:retry-step', (_event, id, stepId) => engine.retryWorkflowStep(idSchema.parse(id), idSchema.parse(stepId)));
    handle('workbench:clone-workflow', (_event, id) => engine.cloneWorkflow(idSchema.parse(id)));
    handle('workbench:resume-workflow', (_event, id) => engine.resumeWorkflow(idSchema.parse(id)));
    handle('workbench:split-workspace', (_event, id, input) => engine.splitWorkspace(idSchema.parse(id), z.object({ tabId: idSchema.optional(), direction: z.enum(['horizontal', 'vertical']).optional(), ratio: z.number().min(0.2).max(0.8).optional() }).strict().parse(input)));
    const workspaceCwd = (id: unknown) => engine.workspace(idSchema.parse(id)).cwd;
    handle('workbench:write-file', (_event, id, input) => workspaceFiles.write(workspaceCwd(id), z.object({ path: cwdSchema, content: z.string().max(1_048_576), revision: idSchema }).strict().parse(input)));
    handle('workbench:git-mutate', (_event, id, input) => {
      const cwd = workspaceCwd(id);
      const mutation = z.object({ action: z.enum(['stage', 'unstage', 'discard']), path: cwdSchema, revision: idSchema.optional() }).strict().parse(input);
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

    handle('workbench:import-attachments', (_event, paths) => attachments.importFiles(z.array(cwdSchema).max(8).parse(paths)));

    if (options.providers) engine.setProviders(options.providers, [], []);
    else await refreshProviders();
    return {
      engine, store, attachments, runtimeSettings, collaboration, core,
      setPublicEndpoint: (url: string) => { publicEndpoint = url; },
      authenticate: (token: string) => identities.authenticate(token),
      externalCall: (token: string, operation: string, input: unknown) => core.call({ kind: 'external', identityId: identities.authenticate(token).id }, operation, input),
      commands: [...handlers.keys()],
      async call(channel: string, args: unknown[]): Promise<unknown> {
        const handler = handlers.get(channel);
        if (!handler) throw new Error('未知的后台命令。');
        return handler(null, ...args);
      },
      snapshot: () => publicSnapshot(engine.snapshot()),
      async shutdown(): Promise<void> {
        const results = await Promise.allSettled([core.close(), terminalManager.shutdown(), engine.shutdown(), collaboration.close()]);
        results.push(...await Promise.allSettled([store.close()]));
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
