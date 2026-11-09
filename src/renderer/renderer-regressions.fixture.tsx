import { CollaborationViews } from './CollaborationViews';
import { readGraphView, writeGraphView } from './graph-view-state';
import type { CollaborationRun, CollaborationEvent, CollaborationParticipant, CollaborationTask } from '../shared/collaboration';
import React, { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { MotionConfig } from 'framer-motion';
import { EditorView } from '@codemirror/view';
import { i18n, translate } from '../shared/i18n';
import type { DiagnosticEntry, FileContent, McpSettingsView, Message, PromptInput, ProviderInfo, Session, Snapshot, UnsavedFileSummary, Workflow, WorkflowInput, Workspace, WorkspaceManagement } from '../shared/types';
import type { BackendConnectionState, SessionHistoryWindow } from '../shared/backend';
import { SettingsDialog } from './SettingsDialog';
import { LanguageProvider } from './language';
import { OverlayProvider } from './overlays';
import { TooltipProvider } from './Tooltip';
import { IconButton } from './ui';
import { ProvidersContent, WorkflowEditor, WorkflowView } from './WorkflowViews';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ManagedWorktreePanel } from './ManagedWorktreePanel';
import { FileReviewPanel } from './FileReviewPanel';
import { SessionChat, SessionSettingsPanel } from './SessionChat';
import { App } from './App';
import { FirstTask } from './FirstTask';
import { WorkspaceToolsPanel } from './WorkspaceTools';
import { ApplicationUpdateNotice, ApplicationUpdateSettings, useApplicationUpdates } from './ApplicationUpdates';
import type { AppUpdateState } from '../shared/application-updates';
import { TerminalPane } from './TerminalPane';
import { Terminal } from '@xterm/xterm';
import { AppearanceProvider } from './appearance';
import { RollingText } from './ui-kit/RollingText';
import type { Perform } from './ui';
import './vendor/open-claude-ui/cds-foundations.css';
import './styles.css';

interface Result { name: string; error?: string }
interface FixtureWindow extends Window { rendererRegressionNames: string[]; runRendererRegressions(selected?: string[] | null): Promise<Result[]>; IS_REACT_ACT_ENVIRONMENT: boolean }
const fixture = window as unknown as FixtureWindow;
fixture.IS_REACT_ACT_ENVIRONMENT = true;
const workspace: Workspace = { id: 'workspace', name: 'Workspace', cwd: '/fixture', pinned: false, tabs: [], activeTabId: null, createdAt: '2026-10-23', updatedAt: '2026-10-23' };
const session: Session = { id: 'session', title: 'Session', providerId: 'codex', cwd: workspace.cwd, status: 'idle', messages: [], approvals: [], settings: { permission: 'review', effort: 'low' }, createdAt: '2026-10-23', updatedAt: '2026-10-23' };
const provider: ProviderInfo = { id: 'codex', name: 'Codex', source: 'builtin', available: true, detail: '', capabilities: { resume: true, approvals: true, permissions: true, effort: true }, efforts: ['low', 'high'] };
const installedUpdateState: AppUpdateState = { currentVersion: '0.8.1', supported: true, autoCheck: true, phase: 'idle' };
const applicationUpdateApi = { getApplicationUpdate: async () => installedUpdateState, onApplicationUpdateChanged: () => () => {}, confirmApplicationUpdateReady: async () => {} };
const idleUpdates: ReturnType<typeof useApplicationUpdates> = { state: installedUpdateState, error: '', pending: false, run: async operation => { await operation(); } };
function ProjectSettings({ workspace, sessions, perform, onClose }: { workspace: Workspace; sessions: Session[]; perform: Perform; onClose: () => void }) {
  return <SettingsDialog snapshot={null} workspace={workspace} sessions={sessions} perform={perform} pending={new Set()} updates={idleUpdates}
    initialSection="project" openSession={() => {}} onClose={onClose} />;
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function frames(count = 3) {
  for (let index = 0; index < count; index++) await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
}
async function waitFor(check: () => boolean, message: string | (() => string), attempts = 60) {
  for (let index = 0; index < attempts; index++) {
    if (check()) return;
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 10)); });
  }
  assert(check(), typeof message === 'function' ? message() : message);
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function button(key: string): HTMLButtonElement {
  const text = translate(key);
  const element = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text || item.getAttribute('aria-label') === text);
  assert(element, `Missing button ${key}`); return element;
}
function input(selector: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
  assert(element, `Missing input ${selector}`); return element;
}
async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string | boolean) {
  await act(async () => {
    if (typeof value === 'boolean') element.click();
    else {
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    }
    await tick();
  });
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
let root: Root;
const errors: string[] = [];
let operations: Promise<void>[] = [];
const perform: Perform = (_key, action) => { const operation = action().then(() => {}, error => { errors.push(String(error)); }); operations.push(operation); return operation; };
async function render(element: ReactElement, reducedMotion: 'always' | 'user' = 'always') { await act(async () => { root.render(<I18nextProvider i18n={i18n}><AppearanceProvider><OverlayProvider><TooltipProvider><MotionConfig reducedMotion={reducedMotion}>{element}</MotionConfig></TooltipProvider></OverlayProvider></AppearanceProvider></I18nextProvider>); await tick(); }); }
async function click(key: string) { await act(async () => { button(key).click(); await tick(); }); }
async function settle() { await act(async () => { await Promise.all(operations); await tick(); }); }
function rendererInput(event: Record<string, string | number>) {
  const host = window as unknown as {
    dispatchRendererInput: (event: string) => void;
    completeRendererInput: (error?: string) => void;
  };
  return new Promise<void>((resolve, reject) => {
    host.completeRendererInput = error => { if (error) reject(new Error(error)); else resolve(); };
    host.dispatchRendererInput(JSON.stringify(event));
  });
}
async function openSelect(control: HTMLButtonElement) {
  await act(async () => { control.focus(); control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); });
  await waitFor(() => Boolean(document.querySelector('[role=listbox][data-state=open]')), 'The application select menu did not open');
  return document.querySelector<HTMLElement>('[role=listbox][data-state=open]')!;
}
async function chooseOption(control: HTMLButtonElement, value: string) {
  const menu = await openSelect(control);
  const option = [...menu.querySelectorAll<HTMLElement>('[role=option]')].find(item => item.dataset.value === value);
  assert(option && !option.hasAttribute('data-disabled'), `Missing selectable option ${value}`);
  await act(async () => { option.click(); await tick(); });
  await waitFor(() => !document.querySelector('[role=listbox][data-state=open]'), 'The application select menu did not close');
}
const chat = (overrides: Partial<Parameters<typeof SessionChat>[0]> = {}) => <SessionChat session={session} provider={provider} perform={perform} pending={new Set()} draft={{ text: '' }} onDraftChange={() => {}} openSession={() => {}} {...overrides} />;
const messageRange = (start: number, end: number): Message[] => Array.from({ length: end - start }, (_, offset) => {
  const index = start + offset;
  return { id: `message-${index}`, role: index % 2 ? 'user' : 'assistant', text: `Message ${index}\n\n${'Variable markdown height. '.repeat(index % 7 + 1)}`, createdAt: '2026-10-23T02:00:00Z' };
});

function collaborationRun(id: string, updatedAt: string): CollaborationRun {
  const definition = { id: `${id}-definition`, version: 1, name: id, cwd: workspace.cwd, participants: [], relationships: [], steps: [], limits: {}, createdAt: updatedAt, updatedAt };
  return { id, definitionId: definition.id, definitionVersion: 1, definitionSnapshot: definition, status: 'running', createdBy: 'user', createdAt: updatedAt, updatedAt };
}
function collaborationSnapshot(runs: CollaborationRun[], revision = 1): Snapshot {
  return { version: 1, sessions: [], workspaces: [], providers: [], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data', collaborationEventSeq: revision,
    collaboration: { definitions: runs.map(run => run.definitionSnapshot), runs, tasks: [], messages: [], artifacts: [], identities: [], grants: [] } };
}

function labeledInput(key: string, scope: ParentNode = document): HTMLInputElement | HTMLTextAreaElement {
  const label = [...scope.querySelectorAll('label')].find(item => item.firstChild?.textContent?.trim() === translate(key));
  const control = label?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  assert(control, `Missing labeled input ${key}`); return control;
}
async function graphClick(kind: 'node' | 'edge', id: string) {
  const selector = `.react-flow__${kind}[data-id="${CSS.escape(id)}"]`;
  await waitFor(() => Boolean(document.querySelector(selector)), `Missing graph ${kind} ${id}`, 200);
  await act(async () => { document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await tick(); });
}
async function graphReady(count: number) {
  await waitFor(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')];
    return nodes.length === count && nodes.every(node => node.getBoundingClientRect().width > 0 && node.style.transform !== 'translate(0px, 0px)');
  }, `The ${count} graph nodes did not complete layout`, 250);
  await frames();
}

const cases: Record<string, () => Promise<void>> = {
  'FILE-REF-01: links from chat reveal the exact file and preserve unsaved edits': async () => {
    const tab = { kind: 'agent' as const, id: 'file-reference-tab', sessionId: session.id };
    const answer: Message = { ...messageRange(0, 1)[0], text: [
      'See `src/view.ts:40:3`, [these lines](file:///fixture/src/view.ts#L42-L45), or [other file](./src/other.ts:8).',
      '[External](https://example.com/docs#L12) · [outside](file:///fixture-sibling/out.ts#L12) · `../other.ts:8`.',
      '```\nsrc/view.ts:56\n```',
    ].join('\n\n') };
    const fileText = Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join('\n');
    const snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [{ ...session, messages: [answer] }],
      providers: [provider], workspaces: [{ ...workspace, tabs: [tab], activeTabId: tab.id }] };
    const reads: string[] = [];
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: () => () => {},
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {},
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      readFile: async (_id: string, path: string) => {
        reads.push(path);
        return { path, content: fileText, size: fileText.length, language: 'TypeScript', revision: 'file-reference-r1' };
      },
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><div style={{ width: 1180 }}><App /></div></LanguageProvider>);
    await waitFor(() => document.querySelectorAll('.markdown-file-link').length === 3, 'The answer did not expose exactly the in-project file references');
    assert(document.querySelector('.markdown-message a[href="https://example.com/docs#L12"]') && !document.querySelector('.markdown-message pre button'),
      'External links or code examples were changed');
    const openReference = async (label: string) => {
      const link = [...document.querySelectorAll<HTMLButtonElement>('.markdown-file-link')].find(item => item.textContent === label);
      assert(link, `Missing workspace reference ${label}`);
      await act(async () => { link.click(); await tick(); });
    };
    await click('app.hideFiles');
    await openReference('src/view.ts:40:3');
    assert(document.querySelector('.file-panel-transition')?.getAttribute('aria-hidden') === 'false', 'The reference did not reopen the file pane');
    const editor = () => {
      const element = document.querySelector<HTMLElement>('.review-editor .cm-editor');
      return element && EditorView.findFromDOM(element);
    };
    await waitFor(() => editor()?.state.doc.lineAt(editor()!.state.selection.main.head).number === 40, 'The editor did not jump to line 40');
    const view = editor()!;
    assert(view.state.selection.main.head === view.state.doc.line(40).from + 2
      && view.dom.querySelector('.cm-activeLine')?.textContent === 'Line 40' && reads.join() === 'src/view.ts',
    'The target column or active line was incorrect');
    await act(async () => { view.dispatch({ changes: { from: 0, insert: 'Draft: ' } }); await tick(); });
    await openReference('these lines');
    const selection = view.state.selection.main;
    assert(editor() === view && reads.length === 1 && view.state.doc.toString().startsWith('Draft: ')
      && selection.from === view.state.doc.line(42).from && selection.to === view.state.doc.line(45).to,
    'Jumping to a range in the open file did not preserve its draft or select the range');
    await openReference('other file');
    await waitFor(() => document.body.textContent?.includes(translate('workspace:files.saveBeforeOpen')) === true, 'A dirty editor did not block opening a different file');
    assert(editor() === view && reads.length === 1 && document.querySelector('.tab-select[aria-current="page"]')?.textContent?.includes(session.title),
      'File navigation discarded the draft, read an unrelated file, or switched the conversation');
    await act(async () => { view.dispatch({ changes: { from: 0, to: 'Draft: '.length } }); await tick(); });
  },
  'RUNTIME-CONTINUATION: a different Agent receives an editable draft only after explicit creation': async () => {
    const target: ProviderInfo = { ...provider, id: 'claude', name: 'Claude Code', defaultModelId: 'default', models: [
      { id: 'default', name: 'Default model', free: true }, { id: 'selected', name: 'Selected model', free: true },
    ] };
    const unavailable = { ...provider, id: 'pi', name: 'Pi', available: false };
    const source = { ...session, messages: messageRange(0, 2), status: 'completed' as const };
    const sourceTab = { kind: 'agent' as const, id: 'source-tab', sessionId: source.id };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [{ ...source, status: 'running' }],
      providers: [provider, target, unavailable], workspaces: [{ ...workspace, tabs: [sourceTab], activeTabId: sourceTab.id }] };
    let publish = (_value: Snapshot) => {};
    const commands: Parameters<Window['workbench']['continueSession']>[] = [];
    let sends = 0;
    const draft = { text: 'Review this continuation' };
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }),
      setUnsavedFiles: () => {}, saveSessionDraft: async () => {},
      sendPrompt: async () => { sends++; }, sendMessage: async () => { sends++; },
      continueSession: async (...args: Parameters<Window['workbench']['continueSession']>) => {
        commands.push(args);
        const [, selection] = args;
        const continued = { ...session, id: 'continued', title: 'Claude Code ↪ Session', ...selection, messages: [], draft };
        const tab = { kind: 'agent' as const, id: 'continued-tab', sessionId: continued.id };
        snapshot = { ...snapshot, sessions: [source, continued], workspaces: [{ ...workspace, tabs: [sourceTab, tab], activeTabId: tab.id }] };
        publish(snapshot);
        return continued.id;
      },
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>);
    await waitFor(() => Boolean(document.querySelector('.composer textarea')), 'The source session did not load');
    const action = 'workspace:chat.continueWithAgent';
    assert(button(action).disabled, 'A running session could be handed off');
    snapshot = { ...snapshot, sessions: [{ ...source, messages: [] }] };
    await act(async () => { publish(snapshot); await tick(); });
    assert(button(action).disabled, 'An empty conversation could create a handoff');
    snapshot = { ...snapshot, sessions: [source] };
    await act(async () => { publish(snapshot); await tick(); });

    const trigger = button(action);
    trigger.focus();
    await click(action);
    assert(button('workspace:chat.continueCreateDraft').disabled, 'The source Agent was implicitly selected');
    await click('shell:common.cancel');
    assert(document.activeElement === trigger && Number(commands.length) === 0, 'Cancel lost focus or created a session');
    await click(action);
    const modalControl = (key: string) => {
      const control = document.querySelector<HTMLButtonElement>(`dialog[open] [role="combobox"][aria-label="${CSS.escape(translate(key))}"]`);
      assert(control, `Missing continuation selector ${key}`);
      return control;
    };
    const menu = await openSelect(modalControl('shell:common.agent'));
    assert(!menu.querySelector('[data-value="codex"]') && menu.querySelector('[data-value="pi"]')?.hasAttribute('data-disabled'), 'The source Agent was offered or an unavailable Agent could be selected');
    await act(async () => { menu.querySelector<HTMLElement>('[data-value="claude"]')!.click(); await tick(); });
    await chooseOption(modalControl('shell:provider.model'), 'selected');
    assert(Number(commands.length) === 0 && sends === 0, 'Selecting a target created or sent a draft');
    await click('workspace:chat.continueCreateDraft');
    await waitFor(() => input('.composer textarea').value === draft.text, 'The new tab did not show the continuation draft');
    assert(Number(commands.length) === 1 && JSON.stringify(commands[0]) === JSON.stringify([source.id, { providerId: target.id, modelId: 'selected' }]), 'The selected Runtime and model were not used');
    assert(!input('.composer textarea').disabled && !document.querySelector('dialog[open]') && sends === 0, 'Creating a draft sent a prompt or left the draft locked');
  },
  'FIRST-RUN: missing runtimes show official guides and refresh preserves a cancelled directory choice and draft': async () => {
    let providers: ProviderInfo[] = [];
    let refreshes = 0;
    const show = () => render(<FirstTask providers={providers} connected perform={perform} pending={new Set()} />);
    window.workbench = {
      chooseDirectory: async () => null,
      providerHealth: async () => providers,
      refreshProviders: async () => { refreshes++; providers = [provider]; await show(); },
    } as unknown as Window['workbench'];
    await show();
    assert(document.querySelector('.first-task-setup a[href="https://learn.chatgpt.com/docs/codex/cli"]') && document.querySelector('.first-task-setup a[href="https://learn.chatgpt.com/docs/auth"]'), 'Missing official install and sign-in guides');
    assert(button('shell:firstTask.open').disabled && document.querySelector('.first-task-runtime-note')?.textContent === translate('shell:firstTask.detectionNote'), 'No-runtime state allowed creating a session or implied sign-in');
    await change(input('.first-task textarea'), 'Keep this first task');
    await click('shell:common.choose'); await settle();
    assert(input('.first-task .directory-field input').value === '', 'Cancelling directory selection changed the field');
    await change(input('.first-task .directory-field input'), '/first-project');
    await click('shell:common.choose'); await settle();
    assert(input('.first-task .directory-field input').value === '/first-project', 'Cancelling directory selection discarded the existing directory');
    await click('shell:provider.refresh'); await settle();
    assert(refreshes === 1 && !document.querySelector('.first-task-setup') && !button('shell:firstTask.open').disabled, 'Refresh did not make the detected runtime selectable');
    assert(input('.first-task textarea').value === 'Keep this first task', 'Runtime refresh discarded the task draft');
    assert(document.querySelector('.runtime-health-check[data-stage="authentication"]')?.getAttribute('data-status') === 'unknown', 'Missing authentication evidence was shown as ready');
  },
  'FIRST-RUN: invalid models block creation and failed double-clicked commands retry without losing the form': async () => {
    const commands: Parameters<Window['workbench']['createSession']>[0][] = [];
    const gate = deferred<string>();
    const modelProvider = { ...provider, models: [{ id: 'first-model', name: 'First model', free: true }], defaultModelId: 'first-model' };
    let providers: ProviderInfo[] = [modelProvider];
    const show = () => render(<FirstTask providers={providers} connected perform={perform} pending={new Set()} />);
    window.workbench = {
      providerHealth: async () => providers,
      createSession: async (value: typeof commands[number]) => { commands.push(value); if (commands.length === 1) return gate.promise; return 'first-created'; },
      commandReceipt: async () => undefined,
    } as unknown as Window['workbench'];
    await show(); await change(input('.first-task .directory-field input'), '/first-project'); await change(input('.first-task textarea'), '  Keep this draft\n');
    providers = [{ ...modelProvider, models: [{ id: 'second-model', name: 'Second model', free: true }] }];
    await show();
    assert(button('shell:firstTask.open').disabled, 'A removed model stayed valid');
    const modelSelect = [...document.querySelectorAll<HTMLButtonElement>('.first-task [role=combobox]')].find(item => item.getAttribute('aria-label') === translate('shell:provider.model'))!;
    await chooseOption(modelSelect, 'second-model');
    await act(async () => { button('shell:firstTask.open').click(); button('shell:firstTask.open').click(); await tick(); });
    await waitFor(() => commands.length === 1, 'Double click did not issue a single creation');
    gate.reject(new Error('creation response lost'));
    await waitFor(() => !button('shell:firstTask.open').disabled && Boolean(document.querySelector('.first-task-error')), 'Failure did not preserve a retryable form');
    assert(input('.first-task textarea').value === '  Keep this draft\n' && input('.first-task .directory-field input').value === '/first-project', 'Creation failure discarded form contents');
    await click('shell:firstTask.open'); await waitFor(() => commands.length === 2 && button('shell:firstTask.open').disabled, 'Retry did not wait for the new workspace snapshot');
    assert(commands[0].commandId === commands[1].commandId && commands[1].initialDraft === '  Keep this draft\n' && commands[1].modelId === 'second-model', 'Retry changed the command or lost its exact draft/model');
  },
  'FIRST-RUN: loading does not flash onboarding and existing workspaces retain the normal layout': async () => {
    const loading = deferred<Snapshot>();
    let publish!: (value: Snapshot) => void;
    const existing: Snapshot = { version: 1, sessions: [], workspaces: [workspace], providers: [provider], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => loading.promise,
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {}, watchSessions: async () => {},
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    await render(<App />);
    assert(document.querySelector('.loading-view') && !document.querySelector('.first-task'), 'Unloaded snapshot flashed onboarding');
    await act(async () => { loading.resolve(existing); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.workspace-columns')), 'An existing workspace did not load');
    assert(!document.querySelector('.first-task') && document.querySelector('.sidebar-navigation')?.textContent?.includes(translate('shell:app.history')), 'Existing users lost the normal workspace or navigation');
    await act(async () => { publish({ ...existing, workspaces: [], providers: [] }); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.first-task')), 'A loaded empty snapshot did not show onboarding');
  },
  'FIRST-RUN: opening the first conversation lands on its saved draft without sending it': async () => {
    let snapshot: Snapshot = { version: 1, sessions: [], workspaces: [], providers: [provider], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    const initialSnapshot = snapshot;
    let snapshotReads = 0, publish!: (value: Snapshot) => void;
    const commands: Parameters<Window['workbench']['createSession']>[0][] = [];
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => { snapshotReads++; return initialSnapshot; }, subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {}, watchSessions: async () => {},
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {}, providerHealth: async () => [provider],
      createWorkspace: async () => { throw new Error('First-task creation must use createSession alone'); },
      sendPrompt: async () => { throw new Error('Opening a conversation must not send a prompt'); },
      createSession: async (value: typeof commands[number]) => {
        commands.push(value);
        const created = { ...session, id: 'first-task-session', title: value.title, cwd: value.cwd, historyLoaded: true, draft: { text: value.initialDraft ?? '' } };
        snapshot = { ...snapshot, sessions: [created], workspaces: [{ ...workspace, id: 'first-task-workspace', name: value.title, cwd: value.cwd,
          tabs: [{ kind: 'agent', id: 'first-task-tab', sessionId: created.id }], activeTabId: 'first-task-tab' }] };
        return created.id;
      },
    } as unknown as Window['workbench'];
    await render(<App />); await waitFor(() => Boolean(document.querySelector('.first-task')), 'Empty app did not show first-task form');
    await change(input('.first-task .directory-field input'), '/first-project'); await change(input('.first-task textarea'), '  Review this project\n');
    await click('shell:firstTask.open'); await waitFor(() => commands.length === 1, 'First conversation was not created');
    assert(document.querySelector('.first-task') && button('shell:firstTask.open').disabled && snapshotReads === 1, 'A delayed subscription caused another snapshot read or unlocked duplicate creation');
    await click('shell:firstTask.open'); assert(commands.length === 1, 'A successful command created a duplicate before its snapshot arrived');
    await act(async () => { publish(snapshot); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.composer textarea')), 'Subscribed conversation did not open');
    assert(commands.length === 1 && commands[0].initialDraft === '  Review this project\n' && input('.composer textarea').value === '  Review this project\n', 'First conversation lost the persisted draft');
    assert(snapshot.sessions[0].status === 'idle' && snapshot.sessions[0].messages.length === 0 && !document.querySelector('.first-task') && snapshotReads === 1, 'Opening started a task, retained onboarding, or fetched a second snapshot');
    await waitFor(() => Boolean(document.querySelector('.message-scroll .conversation-notices')), 'The conversation did not finish rendering');
    assert(document.querySelector('.message-scroll')?.textContent?.trim() === '', 'A new conversation should leave its transcript blank');
  },
  'FIRST-RUN: delayed creation responses and subscriptions preserve navigation to history': async () => {
    const initial: Snapshot = { version: 1, sessions: [], workspaces: [], providers: [provider], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    for (const order of ['response-first', 'subscription-first']) {
      const gate = deferred<string>();
      let publish!: (value: Snapshot) => void, created!: Snapshot;
      let snapshotReads = 0;
      const commands: Parameters<Window['workbench']['createSession']>[0][] = [];
      window.workbench = {
        ...applicationUpdateApi, snapshot: async () => { snapshotReads++; return initial; }, subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
        getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {}, watchSessions: async () => {},
        providerHealth: async () => [provider],
        createSession: async (value: typeof commands[number]) => {
          commands.push(value);
          const saved = { ...session, id: `first-history-${order}`, cwd: value.cwd, draft: { text: value.initialDraft ?? '' } };
          created = { ...initial, sessions: [saved], workspaces: [{ ...workspace, cwd: value.cwd, tabs: [{ kind: 'agent', id: 'first-history-tab', sessionId: saved.id }], activeTabId: 'first-history-tab' }] };
          return gate.promise;
        },
      } as unknown as Window['workbench'];
      await render(<App key={order} />); await waitFor(() => Boolean(document.querySelector('.first-task')), 'First-task form did not load');
      await change(input('.first-task .directory-field input'), '/first-history'); await change(input('.first-task textarea'), 'Do this later');
      await click('shell:firstTask.open'); await waitFor(() => commands.length === 1, 'Creation did not start'); await click('shell:app.history');
      const assertHistory = () => assert(document.querySelector('.sidebar-navigation button[aria-current="page"]')?.textContent?.includes(translate('shell:app.history')) && !document.querySelector('.first-task') && !document.querySelector('.workspace-columns'), 'A delayed creation completion took the user away from history');
      assertHistory();
      if (order === 'response-first') {
        await act(async () => { gate.resolve(created.sessions[0].id); await tick(); }); assertHistory();
        await act(async () => { publish(created); await tick(); });
      } else {
        await act(async () => { publish(created); await tick(); }); assertHistory();
        await act(async () => { gate.resolve(created.sessions[0].id); await tick(); });
      }
      assertHistory(); assert(snapshotReads === 1 && commands.length === 1, 'Completing creation fetched stale state or repeated the command');
    }
  },
  'MOTION-ROLLING-TEXT: only changed digits roll and history replacements stay still': async () => {
    await render(<RollingText value="56/100" />);
    assert(!document.querySelector('.ui-rolling-text-change'), 'The initial value animated');
    await render(<RollingText value="57/100" />);
    const change = document.querySelector('.ui-rolling-text-change');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      assert(!change && document.querySelector('.ui-rolling-text-visual')?.textContent === '57/100', 'Reduced motion did not replace the value directly');
    } else {
      assert(change?.previousSibling?.textContent === '5' && change.nextSibling?.textContent === '/100', 'Unchanged characters moved into the animation');
      assert(change.querySelector('.ui-rolling-text-leaving')?.textContent === '6'
        && change.querySelector('.ui-rolling-text-entering')?.textContent === '7', 'The changed digit pair was lost');
    }
    assert(document.querySelector('.ui-rolling-text-accessible')?.textContent === '57/100', 'The accessible value lagged behind the visual change');
    await render(<RollingText value="99/100" animate={false} />);
    assert(!document.querySelector('.ui-rolling-text-change') && document.querySelector('.ui-rolling-text-visual')?.textContent === '99/100', 'A historical value animated');
  },
  'MOTION-SKILL-ASSIGNMENT: recipient feedback follows the saved session selection': async () => {
    const skillList = ['review', 'build', 'docs'].map(id => ({ id, name: id, description: id, path: '/' + id, scope: 'project', editable: true }));
    const writes: { skillId: string; enabled: boolean }[] = [];
    let gate = deferred<{ skillIds: string[]; updatedAt: string }>();
    window.workbench = {
      listSkills: async () => skillList,
      updateSession: async (_id: string, patch: { skillAssignment: typeof writes[number] }) => { writes.push(patch.skillAssignment); return gate.promise; },
    } as unknown as Window['workbench'];
    const show = (current: Session) => render(<SessionSettingsPanel session={current} workspaceId={workspace.id} visible perform={perform} openSession={() => {}} />, 'user');
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-skill-id="${id}"]`)!;
    const toggle = (id: string) => row(id).querySelector<HTMLInputElement>('input')!;
    await show(session);
    await act(async () => { toggle('review').click(); toggle('build').click(); await tick(); });
    assert(writes.length === 1 && row('review').dataset.state === 'saving' && row('review').querySelector('.session-skill-agent .session-skill-badge'), 'A pending assignment did not lock or mark the receiving Agent');
    gate.reject(new Error('Cannot save selection')); await settle();
    assert(row('review').dataset.state === 'failed' && !toggle('review').checked && !toggle('build').disabled, 'Failed assignment did not retain the selection and unlock retry');
    gate = deferred();
    await act(async () => { row('review').querySelector('button')!.click(); await tick(); });
    await show({ ...session, title: 'Changed title', updatedAt: '2026-11-04T00:00:01Z' });
    gate.resolve({ skillIds: ['review'], updatedAt: '2026-11-04T00:00:02Z' }); await settle();
    assert(toggle('review').checked && row('review').dataset.state === 'saved', 'Retried assignment did not show the saved selection');
    gate = deferred();
    await change(toggle('build'), true);
    assert(writes.at(-1)?.skillId === 'build' && writes.at(-1)?.enabled === true, 'The second assignment must send only the selected Skill');
    const synced = { ...session, updatedAt: '2026-11-04T01:00:00Z', settings: { ...session.settings, skillIds: ['review', 'docs'] } };
    await show(synced); gate.resolve({ skillIds: ['review', 'build'], updatedAt: '2026-11-04T00:00:03Z' }); await settle();
    assert(toggle('docs').checked && !toggle('build').checked && !toggle('build').disabled, 'An old acknowledgement overwrote a newer selection');
    gate = deferred();
    await change(toggle('review'), false);
    assert(writes.at(-1)?.skillId === 'review' && writes.at(-1)?.enabled === false, 'Removal must send only the removed Skill');
    gate.resolve({ skillIds: ['docs'], updatedAt: '2026-11-04T01:00:01Z' }); await settle();
    assert(!toggle('review').checked && toggle('docs').checked && row('review').dataset.state === 'saved' && row('review').querySelector('.session-skill-badge .lucide-x'), 'The removed Skill still appeared enabled');
    gate = deferred(); await change(toggle('build'), true);
    await show({ ...session, id: 'other-recipient', status: 'running' }); gate.resolve({ skillIds: ['docs', 'build'], updatedAt: '2026-11-04T01:00:02Z' }); await settle();
    assert(!toggle('build').checked && toggle('build').disabled && row('build').dataset.state === 'disabled', 'A previous Agent response was applied to another active session');
  },
  'MOTION-RESOURCES: feedback follows actual operations and preserves editors and tab scroll': async () => {
    const project = { ...workspace, id: 'motion-resources' };
    const skills = Array.from({ length: 20 }, (_, index) => ({ id: `motion-skill-${index}`, path: `/fixture/.agents/skills/skill-${index}/SKILL.md`, name: `skill-${index}`, description: 'Resource for this project', scope: 'project' as const, editable: true }));
    let saved = { content: 'Original skill', revision: 'skill-0' };
    let saveGate = deferred<void>();
    let connectionGate = deferred<{ status: 'connected' | 'failed'; tools: []; error?: string }>();
    let connections = 0;
    window.workbench = {
      setUnsavedFiles: () => {}, listSkills: async () => skills, readSkill: async () => saved,
      saveSkill: async (_id: string, value: { content: string }) => { await saveGate.promise; saved = { content: value.content, revision: 'skill-1' }; },
      mcpSettings: async () => ({ content: '{}', revision: 'mcp-0', servers: [{ name: 'fixture-tools', source: 'project', transport: 'stdio', status: 'enabled' }] }),
      notificationStatus: async () => ({ supported: true, state: 'idle' }),
      testMcpServer: async () => { connections++; return connectionGate.promise; },
    } as unknown as Window['workbench'];
    await render(<ProjectSettings workspace={project} sessions={[]} perform={perform} onClose={() => {}} />, 'user');
    await act(async () => { document.querySelector<HTMLButtonElement>('.tools-list-item')!.click(); await tick(); });
    const editor = input('.tools-editor textarea') as HTMLTextAreaElement;
    await change(editor, 'Saved request');
    await click('workspace:tools.saveSkill');
    assert(button('workspace:tools.saveSkill').getAttribute('aria-busy') === 'true' && document.querySelector('.tools-operation-feedback[data-state="pending"]'), 'An outstanding save has no pending feedback');
    await change(editor, 'Newer unsaved text');
    saveGate.resolve(); await settle();
    assert(editor.value === 'Newer unsaved text' && !document.querySelector('.tools-operation-feedback[data-state="saved"]'), 'A save claimed success for newer unsaved content');
    saveGate = deferred<void>(); await click('workspace:tools.saveSkill'); saveGate.reject(new Error('Controlled save failure')); await settle();
    assert(document.querySelector('.tools-operation-feedback[data-state="failed"]') && !button('workspace:tools.saveSkill').disabled, 'Failed save stayed pending or claimed success');
    saveGate = deferred<void>(); await click('workspace:tools.saveSkill');
    editor.focus({ preventScroll: true }); editor.setSelectionRange(3, 7);
    saveGate.resolve(); await settle();
    assert(document.querySelector('.tools-operation-feedback[data-state="saved"]') && input('.tools-editor textarea') === editor && document.activeElement === editor && editor.selectionStart === 3 && editor.selectionEnd === 7, 'Confirmed save replaced the editor or lost the selection');
    const skillPanel = document.querySelector<HTMLElement>('[data-tool-panel="skills"]')!;
    skillPanel.scrollTop = 130;
    await click('MCP');
    assert(skillPanel.hidden && skillPanel.inert, 'Hidden resource controls remain interactive');
    const testButton = button('workspace:tools.testConnection');
    await act(async () => { testButton.click(); testButton.click(); await tick(); });
    assert(connections === 1 && testButton.disabled && testButton.getAttribute('aria-busy') === 'true', 'Repeated connection clicks duplicated the pending operation');
    connectionGate.reject(new Error('Controlled connection failure')); await settle();
    assert(!testButton.disabled && document.querySelector('.tools-connection-result [data-state="failed"]'), 'Thrown connection failure stayed pending');
    connectionGate = deferred(); await click('workspace:tools.testConnection'); connectionGate.resolve({ status: 'failed', tools: [], error: 'Not connected' }); await settle();
    assert(!testButton.disabled && document.querySelector('.tools-connection-result [data-state="failed"]'), 'A rejected connection result showed success');
    connectionGate = deferred(); await click('workspace:tools.testConnection'); connectionGate.resolve({ status: 'connected', tools: [] }); await settle();
    assert(document.querySelector('.tools-connection-result [data-state="saved"]'), 'A successful connection was not shown');
    await click('Skills');
    assert(skillPanel.scrollTop === 130 && input('.tools-editor textarea') === editor, 'Changing resource tabs lost scroll or recreated the editor');
    await change(editor, 'Another edit');
    assert(!skillPanel.querySelector('[data-state="saved"]'), 'Editing retained a saved label on unsaved content');
    await render(<WorkspaceToolsPanel workspace={project} sessions={[]} perform={perform} />, 'user');
    await click('MCP'); connectionGate = deferred(); await click('workspace:tools.testConnection');
    await render(<WorkspaceToolsPanel workspace={{ ...project, id: 'motion-resources-other' }} sessions={[]} perform={perform} />, 'user');
    await click('MCP'); connectionGate.resolve({ status: 'connected', tools: [] }); await settle();
    assert(!document.querySelector('.tools-connection-result') && !button('workspace:tools.testConnection').disabled, 'An old project connection result leaked into the new project');
  },
  'GRAPH-STUDIO-1: the first collaboration opens as an editable graph and saves a draft with its layout': async () => {
    type Draft = CollaborationRun['definitionSnapshot'] & { start: boolean };
    let saved: Draft | undefined;
    window.workbench = {
      chooseDirectory: async () => workspace.cwd,
      collaborationCall: async (operation: string, value: Draft) => {
        if (operation === 'create_run') { saved = value; return { runId: 'studio-saved' }; }
        return { tasks: [] };
      },
    } as unknown as Window['workbench'];
    const snapshot = { ...collaborationSnapshot([]), providers: [provider] };
    await render(<CollaborationViews snapshot={snapshot} initialCwd={workspace.cwd} perform={perform} pending={new Set()} openSession={() => {}} />);
    await graphReady(2);
    assert(document.querySelector('.collaboration-studio') && document.querySelector('.react-flow__edge[data-id="configured-implementation-review"]'), 'First entry did not display the two-Agent template and its relationship');
    const implementer = document.querySelector<HTMLElement>('.react-flow__node[data-id="implementer"]')!;
    const reviewer = document.querySelector<HTMLElement>('.react-flow__node[data-id="reviewer"]')!;
    assert(implementer.getBoundingClientRect().bottom < reviewer.getBoundingClientRect().top, 'The implementer was not above the reviewer');
    assert([implementer, reviewer].every(node => node.querySelector('.react-flow__handle.target.react-flow__handle-top') && node.querySelector('.react-flow__handle.source.react-flow__handle-bottom')), 'Graph handles did not follow the top-to-bottom direction');
    await change(labeledInput('collaboration:setup.goal'), 'Deliver a visual editor');
    await graphClick('node', 'implementer');
    await change(labeledInput('collaboration:field.displayName'), 'Builder');
    await change(labeledInput('collaboration:field.roles'), 'implementation, validation');
    await change(labeledInput('collaboration:field.instructions'), 'Own the complete implementation');
    await act(async () => { document.querySelector<HTMLButtonElement>('.execution-edge-label')!.click(); await tick(); });
    assert(document.querySelector('.collaboration-studio-relation'), 'Clicking the visible relationship label did not open its inspector');
    await click('collaboration:studio.reverseDirection');
    await change(labeledInput('collaboration:studio.relationshipLabel'), 'Review findings');
    const before = Object.fromEntries([...document.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => [node.dataset.id!, node.style.transform]));
    await click('collaboration:studio.saveDraft'); await settle();
    assert(saved?.start === false && saved.participants.length === 2 && saved.steps?.length === 2, 'Saving the visual template must create a draft without starting providers');
    const builder = saved.participants.find(item => item.id === 'implementer')!;
    assert(builder.name === 'Builder' && builder.roles.join('|') === 'implementation|validation' && builder.instructions === 'Own the complete implementation', 'The Agent inspector edits did not reach the saved definition');
    assert(saved.relationships[0].from === 'reviewer' && saved.relationships[0].to === 'implementer' && saved.relationships[0].label === 'Review findings', 'The selected relationship edits were lost in the payload');
    assert(saved.steps?.every(step => step.prompt.includes('Deliver a visual editor')), 'The saved preset tasks lost the goal');
    const layout = readGraphView('collaboration:studio-saved:relationships');
    assert(Object.keys(layout.positions).length === 2 && Object.entries(layout.positions).every(([id, point]) => before[id] === `translate(${point.x}px, ${point.y}px)`), 'Saving the draft did not preserve the visible graph positions');
  },
  'GRAPH-STUDIO-2: removing an Agent cleans relationships, dependent tasks and permission targets': async () => {
    const run = collaborationRun('Studio cleanup', '2026-11-05T00:00:00Z');
    const participant = (id: string): CollaborationParticipant => ({ id, name: id, mode: 'managed', providerId: provider.id, roles: [], permissions: { submitTasks: false, sendMessages: false, publishArtifacts: false, configureRun: false, allowedTargets: ['remove'], workspace: { cwd: workspace.cwd, access: 'read-only' } } });
    run.definitionSnapshot.participants = ['keep', 'remove'].map(participant);
    run.definitionSnapshot.relationships = [{ id: 'cleanup', from: 'keep', to: 'remove', kind: 'reports-to' }];
    run.definitionSnapshot.steps = [
      { id: 'removed-task', title: 'Removed task', participantId: 'remove', prompt: 'Remove me', dependsOn: [], artifactIds: [] },
      { id: 'remaining-task', title: 'Remaining task', participantId: 'keep', prompt: 'Keep me', dependsOn: ['removed-task'], artifactIds: [] },
    ];
    let saved: Partial<CollaborationRun['definitionSnapshot']> | undefined;
    window.workbench = { queryCollaborationEvents: async () => [], collaborationCall: async (operation: string, value: typeof saved) => { if (operation === 'update_run') { saved = value; return { runId: run.id }; } return { tasks: [] }; } } as unknown as Window['workbench'];
    await render(<CollaborationViews snapshot={{ ...collaborationSnapshot([run]), providers: [provider] }} perform={perform} pending={new Set()} openSession={() => {}} />);
    await click('collaboration:run.editSetup'); await graphReady(2);
    await click('collaboration:studio.addAgent'); await graphReady(3);
    const added = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(node => !['keep', 'remove'].includes(node.dataset.id!))!;
    assert(added.querySelector('strong')?.textContent === 'Agent 3', 'Adding an Agent did not put it directly on the canvas');
    await graphClick('node', 'remove');
    await click(translate('collaboration:participant.delete', { name: 'remove' }));
    await graphReady(2);
    assert(!document.querySelector('.react-flow__edge[data-id="configured-cleanup"]'), 'The removed Agent left a dangling relationship');
    await click('collaboration:action.saveVersion'); await settle();
    assert(saved?.participants?.length === 2 && !saved.participants.some(item => item.id === 'remove') && saved.participants.every(item => !item.permissions.allowedTargets?.includes('remove')), 'Removing an Agent left invalid permission targets');
    assert(saved.relationships?.length === 0 && saved.steps?.length === 1 && saved.steps[0].id === 'remaining-task' && saved.steps[0].dependsOn.length === 0, 'Removing an Agent left its task or a dangling dependency');
  },
  'GRAPH-STUDIO-3: workflow graph connections reject invalid edges and save the edited dependency direction': async () => {
    let saved: WorkflowInput | undefined;
    window.workbench = { chooseDirectory: async () => workspace.cwd, createWorkflow: async (value: WorkflowInput) => { saved = value; return 'workflow-studio-saved'; } } as unknown as Window['workbench'];
    await render(<WorkflowEditor providers={[provider]} perform={perform} pending={new Set()} onClose={() => {}} onCreated={() => {}} />);
    await graphReady(1);
    await change(labeledInput('shell:workflow.name'), 'Visual workflow');
    await click('shell:common.choose'); await settle();
    await change(labeledInput('shell:common.title'), 'Build'); await change(labeledInput('shell:common.task'), 'Implement');
    const a = document.querySelector<HTMLElement>('.react-flow__node')!.dataset.id!;
    await click('shell:workflow.addStep'); await graphReady(2);
    await change(labeledInput('shell:common.title'), 'Review'); await change(labeledInput('shell:common.task'), 'Inspect the output');
    const added = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(node => node.dataset.id !== a)!;
    const b = added.dataset.id!;
    const initial = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(a)}"]`)!;
    assert(initial.getBoundingClientRect().bottom < added.getBoundingClientRect().top, 'The added task overlaps the existing task');
    await waitFor(() => {
      const canvas = document.querySelector('.execution-graph')!.getBoundingClientRect();
      const bounds = added.getBoundingClientRect();
      return bounds.left >= canvas.left && bounds.right <= canvas.right && bounds.top >= canvas.top && bounds.bottom <= canvas.bottom;
    }, () => `The newly added selected task was not revealed inside the visible canvas: ${JSON.stringify({ node: added.getBoundingClientRect().toJSON(), canvas: document.querySelector('.execution-graph')!.getBoundingClientRect().toJSON() })}`, 200);
    const connect = async (source: string, target: string) => { await click('shell:workflow.connectSteps'); await graphClick('node', source); await graphClick('node', target); };
    await connect(a, b);
    const original = JSON.stringify([a.slice(5), b.slice(5)]);
    await act(async () => { document.querySelector<HTMLButtonElement>('.execution-edge-label')!.click(); await tick(); });
    assert(document.querySelector('.workflow-inspector')?.textContent?.includes(translate('shell:workflow.dependency')), 'Selecting the visible edge did not open its dependency inspector');
    await connect(a, b);
    assert(document.querySelector('[role=alert]')?.textContent === translate('shell:workflow.dependencyError.duplicate') && document.querySelectorAll('.react-flow__edge').length === 1, 'Duplicate dependency was accepted');
    await click('shell:common.cancel'); await connect(a, a);
    assert(document.querySelector('[role=alert]')?.textContent === translate('shell:workflow.dependencyError.self'), 'A task was allowed to depend on itself');
    await click('shell:common.cancel'); await connect(b, a);
    assert(document.querySelector('[role=alert]')?.textContent === translate('shell:workflow.dependencyError.cycle'), 'A dependency cycle was accepted');
    await click('shell:common.cancel'); await graphClick('edge', original); await click('shell:workflow.reverseDependency');
    const reversed = JSON.stringify([b.slice(5), a.slice(5)]);
    await graphClick('edge', reversed); await click('shell:workflow.deleteDependency');
    assert(document.querySelectorAll('.react-flow__edge').length === 0, 'Deleting the selected edge left its dependency on the canvas');
    await connect(b, a);
    await click('collaboration:graph.relayout');
    await waitFor(() => added.getBoundingClientRect().bottom < initial.getBoundingClientRect().top, 'Rearranging did not place the dependency source above its target', 200);
    await click('shell:workflow.save'); await settle();
    assert(saved?.steps.find(step => step.id === a.slice(5))?.dependsOn.join() === b.slice(5) && saved.steps.find(step => step.id === b.slice(5))?.dependsOn.length === 0, 'Saved workflow dependencies did not match the edited direction');
    assert(Object.keys(readGraphView('workflow:workflow-studio-saved').positions).length === 2, 'Workflow draft layout did not carry over on save');
  },
  'GRAPH-STUDIO-4: workflow runtime graph shows actual approval state and keeps recovery confirmation scoped': async () => {
    const running: Workflow = { id: 'studio-runtime', name: 'Runtime graph', cwd: workspace.cwd, status: 'running', createdAt: '2026-11-05', updatedAt: 'v1', steps: [
      { id: 'build', title: 'Build', providerId: provider.id, prompt: 'Build', dependsOn: [], status: 'completed' },
      { id: 'review', title: 'Review', providerId: provider.id, prompt: 'Review', dependsOn: ['build'], status: 'running', sessionId: session.id },
    ] };
    let resumes = 0;
    window.workbench = { resumeWorkflow: async () => { resumes++; } } as unknown as Window['workbench'];
    const show = (value: Workflow) => render(<WorkflowView workflow={value} providers={[provider]} sessions={[{ ...session, status: 'waiting_approval' }]} perform={perform} pending={new Set()} openSession={() => {}} />);
    const cachedViewport = { x: -2500, y: -800, zoom: 0.7 };
    writeGraphView('workflow:' + running.id, { positions: { 'task-build': { x: 90, y: 100 }, 'task-review': { x: 450, y: 100 } }, viewport: cachedViewport });
    await show(running); await graphReady(2); await frames(12);
    assert(JSON.stringify(readGraphView('workflow:' + running.id).viewport) === JSON.stringify(cachedViewport), 'Opening the workflow moved its restored viewport to the default first-step selection');
    await graphClick('node', 'task-review');
    await waitFor(() => {
      const canvas = document.querySelector('.execution-graph')!.getBoundingClientRect();
      const bounds = document.querySelector('.react-flow__node[data-id="task-review"]')!.getBoundingClientRect();
      return bounds.left >= canvas.left && bounds.right <= canvas.right && bounds.top >= canvas.top && bounds.bottom <= canvas.bottom;
    }, 'An explicit task selection after restoring the graph did not move the selected node into the visible canvas', 200);
    assert(document.querySelector('.react-flow__node[data-id="task-review"] [data-status="waiting_approval"]'), 'The graph hid the current session approval state');
    assert(!document.querySelector('.react-flow__handle.connectable') && !document.querySelector('.workflow-inspector input, .workflow-inspector textarea'), 'The running workflow graph exposed draft editing controls');
    await graphClick('edge', JSON.stringify(['build', 'review']));
    assert(document.querySelector('.workflow-dependency-summary')?.textContent === 'BuildReview', 'Runtime dependency selection did not show the real source and target');
    const failed: Workflow = { ...running, status: 'failed', updatedAt: 'v2', steps: running.steps.map(step => step.id === 'review' ? { ...step, status: 'failed' } : step) };
    await show(failed);
    assert(button('shell:workflow.resume').disabled, 'Recovery was enabled without explicit confirmation');
    await change(input('.workflow-recovery input[type=checkbox]'), true);
    assert(!button('shell:workflow.resume').disabled, 'Recovery confirmation did not enable resume');
    await show({ ...failed, updatedAt: 'v3' });
    assert(button('shell:workflow.resume').disabled, 'A newer recovery snapshot retained the old confirmation');
    await change(input('.workflow-recovery input[type=checkbox]'), true); await click('shell:workflow.resume'); await settle();
    assert(resumes === 1 && button('shell:workflow.resume').disabled, 'Confirmed recovery did not resume exactly once and reset the confirmation');
  },
  'GRAPH-STUDIO-6: workflow motion follows only new executing attempts and ignores old session status': async () => {
    const oldAttempt = { id: 'attempt-old', sessionId: 'active-session', status: 'running' as const, startedAt: '2026-11-05T00:00:00Z' };
    const workflow: Workflow = { id: 'studio-attempt-motion', name: 'Attempt motion', cwd: workspace.cwd, status: 'running', createdAt: oldAttempt.startedAt, updatedAt: 'v1', steps: [
      { id: 'source', title: 'Completed source', providerId: provider.id, prompt: 'Build', dependsOn: [], status: 'completed' },
      { id: 'target', title: 'Executing target', providerId: provider.id, prompt: 'Review', dependsOn: ['source'], status: 'running', sessionId: oldAttempt.sessionId, attempts: [oldAttempt] },
      { id: 'stale', title: 'Task with old session', providerId: provider.id, prompt: 'Wait', dependsOn: [], status: 'running', sessionId: 'old-completed-session' },
    ] };
    const show = (value: Workflow, status: Session['status']) => render(<WorkflowView workflow={value} providers={[provider]} sessions={[{ ...session, id: oldAttempt.sessionId, status }, { ...session, id: 'old-completed-session', status: 'completed' }]} perform={perform} pending={new Set()} openSession={() => {}} />, 'user');
    const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="task-${id}"] .collaboration-node`)!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    await show(workflow, 'waiting_approval'); await graphReady(3);
    assert(node('target').dataset.status === 'waiting_approval' && node('target').dataset.executing === 'false' && !document.querySelector('.collaboration-edge-handoff, .collaboration-node-status-feedback'), 'Opening an existing approval wait played historical execution activity');
    await show(workflow, 'running');
    assert(node('target').dataset.executing === 'true' && !document.querySelector('.collaboration-edge-handoff, .collaboration-node-status-feedback'), 'An existing attempt first opened during approval replayed a handoff or pulse when it resumed');
    assert(node('stale').dataset.status === 'running' && node('stale').dataset.executing === 'false', 'A running step inherited completed status or execution glow from an old completed session');
    await show(workflow, 'waiting_approval');
    assert(node('target').dataset.status === 'waiting_approval' && node('target').dataset.executing === 'false', 'Waiting for approval retained execution glow');
    await show(workflow, 'running');
    assert(node('target').dataset.executing === 'true' && !document.querySelector('.collaboration-edge-handoff, .collaboration-node-status-feedback'), 'Returning to the same running attempt replayed its handoff or pulse');
    const retry: Workflow = { ...workflow, updatedAt: 'v2', steps: workflow.steps.map(step => step.id === 'target' ? { ...step, attempts: [...step.attempts!, { ...oldAttempt, id: 'attempt-new' }] } : step) };
    await show(retry, 'queued');
    assert(node('target').dataset.executing === 'false' && !document.querySelector('.collaboration-edge-handoff, .collaboration-node-status-feedback'), 'A newly queued attempt played execution activity before the provider ran');
    await show(retry, 'running');
    assert(node('target').dataset.executing === 'true', 'The genuinely running new attempt did not expose execution state');
    assert(reduced ? !document.querySelector('.collaboration-edge-handoff, .collaboration-node-status-feedback') : node('target').querySelector('.collaboration-node-status-feedback') && document.querySelector('.collaboration-edge-handoff'), 'A new running attempt did not follow the motion preference for handoff and node pulse');
    await waitFor(() => !document.querySelector('.collaboration-edge-handoff, .collaboration-node-status-feedback'), 'New execution feedback did not finish', 150);
    await show(retry, 'running');
    assert(!document.querySelector('.collaboration-edge-handoff, .collaboration-node-status-feedback'), 'An unchanged new attempt replayed finished execution feedback');
  },
  'GRAPH-STUDIO-5: blank collaboration and legacy empty workflows remain usable with reduced motion': async () => {
    window.workbench = { chooseDirectory: async () => workspace.cwd } as unknown as Window['workbench'];
    await render(<CollaborationViews snapshot={{ ...collaborationSnapshot([]), providers: [provider] }} initialCwd={workspace.cwd} perform={perform} pending={new Set()} openSession={() => {}} />);
    await click('collaboration:studio.blank');
    assert(document.querySelector('.collaboration-studio-empty') && document.querySelectorAll('.react-flow__node').length === 0 && button('collaboration:studio.saveDraft').disabled, 'A blank draft did not expose an empty canvas with guarded save');
    await click('collaboration:studio.addAgent'); await graphReady(1);
    assert(document.querySelector('.collaboration-studio-inspector') && !document.querySelector('.collaboration-node-status-feedback, .collaboration-edge-handoff'), 'Adding an Agent to a blank reduced-motion draft failed or showed runtime activity');
    await render(<WorkflowView workflow={{ id: 'legacy-empty', name: 'Legacy workflow', cwd: workspace.cwd, status: 'draft', steps: [], createdAt: '2026-11-05', updatedAt: 'v1' }} providers={[provider]} sessions={[]} perform={perform} pending={new Set()} openSession={() => {}} />);
    assert(document.querySelector('.collaboration-canvas-empty') && document.querySelector('.workflow-inspector') && !document.querySelector('[role=alert]'), 'An old empty workflow crashed or failed to show a usable empty graph');
  },

  'MOTION-COLLABORATION: only new deliveries animate and details retain focus and scroll': async () => {
    const a: CollaborationParticipant = { id: 'worker', name: 'Worker', mode: 'managed', providerId: 'codex', roles: ['implementation'], permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false } };
    const b: CollaborationParticipant = { ...a, id: 'reviewer', name: 'Reviewer', roles: ['review'] };
    const run = collaborationRun('Motion run', '2026-11-03T00:00:00Z');
    run.definitionSnapshot.participants = [a, b];
    run.definitionSnapshot.steps = [{ id: 'review', title: 'Review', participantId: b.id, prompt: 'Review the output', dependsOn: [], artifactIds: ['report'] }];
    const task: CollaborationTask = { id: 'review', runId: run.id, participantId: b.id, createdBy: 'user', title: 'Review', prompt: 'Keep this reading position.\n'.repeat(40), definitionVersion: 1, participantSnapshot: b, dependsOn: [], artifactIds: ['report'], status: 'queued', attempts: [], createdAt: run.createdAt, updatedAt: run.updatedAt };
    const attempt = { id: 'review-attempt', status: 'running' as const, startedAt: run.createdAt, physicalTurns: 1, inputArtifactIds: ['report'], outputArtifactIds: [] };
    let snapshot = collaborationSnapshot([run], 1000);
    snapshot.sessions = [{ ...session, status: 'running' }];
    snapshot.collaboration!.tasks = [{ ...task, status: 'pending', sessionId: session.id }];
    snapshot.collaboration!.artifacts = [{ id: 'report', artifactId: 'report', runId: run.id, version: 1, participantId: a.id, name: 'Review material', kind: 'document', content: 'The saved output', sha256: 'a'.repeat(64), createdAt: run.createdAt }];
    const event = (seq: number): CollaborationEvent => ({ id: `delivery-${seq}`, seq, runId: run.id, type: 'artifact.injected', source: 'managed', participantId: a.id, targetParticipantId: b.id, taskId: task.id, attemptId: attempt.id, artifactVersionId: 'report', createdAt: run.createdAt, data: {} });
    const records: CollaborationEvent[] = Array.from({ length: 501 }, (_, index) => ({ ...event(index + 1), type: 'runtime.usage' }));
    let readGate: ReturnType<typeof deferred<void>> | undefined;
    window.workbench = { queryCollaborationEvents: async (_id: string, after: number) => {
      await readGate?.promise;
      return records.filter(item => item.seq > after).slice(0, 500);
    } } as unknown as Window['workbench'];
    const show = () => render(<CollaborationViews snapshot={snapshot} perform={perform} pending={new Set()} openSession={() => {}} />, 'user');
    const taskNode = () => document.querySelector<HTMLElement>('.react-flow__node[data-id="task-review"]')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    await show();
    await click('collaboration:run.dataFlow');
    await waitFor(() => document.querySelectorAll('.react-flow__edge').length > 0, 'The actual graph did not render its artifact edge', 150);
    assert(!document.querySelector('.collaboration-edge-handoff'), 'Initial history played as a live delivery');
    snapshot = { ...snapshot, collaboration: { ...snapshot.collaboration!, tasks: [{ ...task, sessionId: session.id }] } }; await show();
    assert(taskNode().querySelector('[data-status="queued"]') && !taskNode().querySelector('.collaboration-node-status-feedback'), 'Queuing a task in a busy session showed execution activity');
    assert(taskNode().querySelector('[data-resource-delivery="queued"]'), 'The task did not show its pending material');
    await act(async () => { taskNode().click(); await tick(); });
    const selection = document.querySelector<HTMLElement>('.collaboration-selection')!;
    const detail = selection.querySelector<HTMLElement>('.collaboration-selection-scroll')!;
    const opening = selection.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'width');
    assert(reduced ? !opening : opening, 'Opening the detail for the first time did not follow the motion preference');
    detail.scrollTop = 140;
    records.push(event(1001));
    snapshot = { ...snapshot, collaborationEventSeq: 1001, collaboration: { ...snapshot.collaboration!, tasks: [{ ...task, status: 'running', sessionId: session.id, attemptId: attempt.id, attempts: [attempt] }] } }; await show();
    assert(document.querySelector('.collaboration-timeline-list')?.textContent?.includes('#1001'), 'Unloaded history delayed a new delivery');
    assert(reduced ? !document.querySelector('.collaboration-edge-handoff') : document.querySelector('.collaboration-edge-handoff[data-event-seq="1001"]'), 'A real delivery did not follow the current motion preference');
    assert(taskNode().querySelector('[data-resource-delivery="injected"]'), 'A delivered material did not reach the recipient indicator');
    assert(detail.scrollTop === 140, 'Live delivery reset the detail reading position');
    const statusFeedback = taskNode().querySelector<HTMLElement>('.collaboration-node-status-feedback');
    if (reduced) assert(!statusFeedback, 'Reduced motion still flashed a status transition');
    else {
      assert(statusFeedback && getComputedStyle(statusFeedback).animationName === 'collaboration-status-feedback', 'Task status feedback did not start its animation');
      statusFeedback.style.animation = 'none';
      assert(getComputedStyle(statusFeedback).opacity === '0', 'Disabled animation left an opaque layer over the task text');
      statusFeedback.style.removeProperty('animation');
    }
    await waitFor(() => !document.querySelector('.collaboration-edge-handoff'), 'The first delivery feedback never ended', 100);
    snapshot = { ...snapshot, sessions: [{ ...session, status: 'waiting_approval' }] }; await show();
    snapshot = { ...snapshot, sessions: [{ ...session, status: 'running' }] }; await show();
    assert(!taskNode().querySelector('.collaboration-node-status-feedback'), 'An approval in the same attempt replayed execution start');
    await click('collaboration:timeline.loadMore'); await settle();
    assert(!document.querySelector('.collaboration-edge-handoff'), 'Loading older events replayed a delivery');
    readGate = deferred();
    records.push(event(1002)); snapshot = { ...snapshot, collaborationEventSeq: 1002 }; await show();
    await click('collaboration:run.relationships');
    const recipient = document.querySelector('.react-flow__node[data-id="reviewer"]');
    assert(recipient?.querySelector('[data-resource-delivery="injected"]'), 'The recipient Agent did not show the delivered task input');
    await click('collaboration:run.dataFlow');
    await act(async () => { readGate!.resolve(); await tick(); });
    assert(document.querySelector('.collaboration-timeline-list')?.textContent?.includes('#1002') && !document.querySelector('.collaboration-edge-handoff'), 'Leaving and reopening a view replayed a delayed receipt');
    const close = document.querySelector<HTMLButtonElement>('.collaboration-selection header button')!;
    close.focus({ preventScroll: true });
    await act(async () => { close.click(); await tick(); });
    const panel = document.querySelector<HTMLElement>('.collaboration-selection')!;
    assert(panel.inert && panel.getAttribute('aria-hidden') === 'true' && !panel.contains(document.activeElement), 'Collapsed detail retained keyboard interaction');
    await click('collaboration:detail.expand'); await frames();
    assert(document.querySelector('.collaboration-selection-scroll') === detail && detail.scrollTop === 140, 'Reopening details recreated or reset the scroller');
    records.push(event(1003)); snapshot = { ...snapshot, collaborationEventSeq: 1003 }; await show();
    await waitFor(() => !document.querySelector('.collaboration-edge-handoff'), 'A delivery animation never finished', 100);
    await show();
    assert(!document.querySelector('.collaboration-edge-handoff'), 'An unchanged snapshot replayed a finished delivery');
  },
  'MOTION-SIDEBAR: state and pin moves preserve the project row, focus and reading position': async () => {
    const projects = Array.from({ length: 24 }, (_, index) => ({ ...workspace, id: `motion-${index}`, name: `Project ${index}`, cwd: `/motion-${index}` }));
    const values = projects.map((project, index) => ({ ...session, id: `motion-session-${index}`, cwd: project.cwd, status: 'running' as const }));
    let snapshot: Snapshot = { version: 1, sessions: values, providers: [provider], workspaces: projects, workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    let publish!: (value: Snapshot) => void;
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: (listener: (value: Snapshot) => void) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    await render(<App />, 'user'); await frames();
    const scroller = document.querySelector<HTMLElement>('.workspace-sidebar-scroll')!;
    const row = document.querySelector<HTMLButtonElement>('[data-workspace-id="motion-8"]')!;
    scroller.scrollTop = 240;
    row.focus({ preventScroll: true });
    const top = scroller.scrollTop;
    const entry = row.closest<HTMLElement>('.workspace-row-entry')!;
    let movedBetweenGroups = false;
    const movement = new MutationObserver(() => {
      const transform = getComputedStyle(entry).transform;
      if (transform !== 'none' && Math.abs(new DOMMatrix(transform).m42) > 1) movedBetweenGroups = true;
    });
    movement.observe(entry, { attributes: true, attributeFilter: ['style'] });
    snapshot = { ...snapshot, sessions: snapshot.sessions.map(value => value.id === 'motion-session-8' ? { ...value, status: 'completed', attention: { revision: 1, seenRevision: 0, reason: 'result', updatedAt: value.updatedAt } } : value) };
    await act(async () => { publish(snapshot); await tick(); }); await frames();
    assert(document.querySelector('[data-workspace-id="motion-8"]') === row && row.classList.contains('group-review'), 'Finishing a task replaced its project row or lost its review state');
    movement.disconnect();
    assert(movedBetweenGroups !== matchMedia('(prefers-reduced-motion: reduce)').matches, 'The project row transition did not follow the motion preference');
    assert(document.activeElement === row, 'Moving a project to review lost keyboard focus');
    assert(scroller.scrollTop === top, 'A background status change moved the sidebar reading position');
    snapshot = { ...snapshot, workspaces: projects.map(project => project.id === 'motion-8' ? { ...project, pinned: true } : project) };
    await act(async () => { publish(snapshot); await tick(); }); await frames();
    assert(document.querySelector('[data-workspace-id="motion-8"]') === row && row.classList.contains('group-pinned') && document.activeElement === row, 'Pinning replaced the row or lost focus');
    assert(scroller.scrollTop === top, 'Pinning scrolled away from the reading position');
    const search = button('shell:app.searchWorkspaces'); search.focus();
    snapshot = { ...snapshot, workspaces: projects };
    await act(async () => { publish(snapshot); await tick(); }); await frames();
    assert(document.activeElement === search, 'A project move stole focus from another control');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) assert(!entry.style.transform || entry.style.transform === 'none', 'Reduced motion still moved a project row');
  },
  'UI-SETTINGS: one settings entry preserves the active workspace and unsaved project edits': async () => {
    const draft = { text: 'Keep this unfinished task', attachments: [{ id: 'settings-note', name: 'settings-note.txt', kind: 'text' as const,
      ownedPath: '/settings-note.txt', mimeType: 'text/plain', size: 4, sha256: 'b'.repeat(64) }] };
    const currentSession: Session = { ...session, id: 'settings-session', historyLoaded: true, draft };
    const currentWorkspace: Workspace = { ...workspace, id: 'settings-workspace', tabs: [{ kind: 'agent', id: 'settings-tab', sessionId: currentSession.id }], activeTabId: 'settings-tab' };
    const otherWorkspace = { ...workspace, id: 'settings-other-project', name: 'Other project', cwd: '/other-project' };
    const snapshot: Snapshot = { version: 1, sessions: [currentSession], workspaces: [currentWorkspace, otherWorkspace], providers: [provider], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    const watched: string[][] = [];
    let subscriptions = 0, unsubscribed = 0;
    const skillScopes: string[] = [];
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: () => { subscriptions++; return () => { unsubscribed++; }; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, setLanguage: async (preference: 'en') => ({ preference, language: 'en' }),
      watchSessions: async (ids: string[]) => { watched.push(ids); },
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {}, saveSessionDraft: async () => {},
      providerHealth: async () => [provider], listSkills: async (id: string) => { skillScopes.push(id); return []; },
      mcpSettings: async () => ({ content: '{}', revision: 'settings-mcp-0', servers: [] }), notificationStatus: async () => ({ supported: true, state: 'idle' }),
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>);
    await waitFor(() => Boolean(document.querySelector('.composer textarea')) && Boolean(watched.at(-1)?.includes(currentSession.id)), 'The initial workspace did not load its active session');
    const textarea = input('.composer textarea');
    const watchCount = watched.length;
    const assertWorkspace = () => assert(input('.composer textarea') === textarea && textarea.value === draft.text
      && document.querySelector('.composer .attachments-strip')?.textContent?.includes('settings-note.txt')
      && watched.length === watchCount && subscriptions === 1 && unsubscribed === 0,
    'Settings replaced the workspace, draft, attachments, or session subscriptions');
    assert(document.querySelectorAll(`.sidebar-footer button[aria-label="${translate('shell:preferences.open')}"]`).length === 1
      && !document.querySelector(`.workspace-header-actions button[aria-label="${translate('shell:app.projectTools')}"]`)
      && !document.querySelector(`.chat-toolbar button[aria-label="${translate('workspace:chat.settings')}"]`),
    'The application retains multiple settings entry buttons');
    await click('shell:preferences.open');
    assert(document.querySelector('.settings-nav') && document.querySelector('.language-settings [role=combobox]')
      && document.querySelector('.appearance-options') && document.querySelector('.application-update-settings'), 'General settings omit a former preferences section');
    assertWorkspace();
    const settingsModal = document.querySelector<HTMLElement>('.modal:has(.settings-layout)')!;
    const settingsWidth = settingsModal.offsetWidth;
    const backdrop = settingsModal.parentElement!;
    const backdropStyle = getComputedStyle(backdrop);
    const availableWidth = backdrop.clientWidth - parseFloat(backdropStyle.paddingLeft) - parseFloat(backdropStyle.paddingRight);
    assert(Math.abs(settingsWidth - Math.min(980, availableWidth)) <= 1, `Settings width ${settingsWidth} does not fit available width ${availableWidth}`);
    for (const section of ['shell:app.providers', 'shell:settings.project', 'shell:settings.general']) {
      await click(section);
      assert(settingsModal.offsetWidth === settingsWidth, `Settings width changed from ${settingsWidth} to ${settingsModal.offsetWidth} after opening ${section}`);
    }
    await click('shell:settings.project');
    const projectScope = () => button('shell:settings.projectScope');
    await chooseOption(projectScope(), otherWorkspace.id);
    await waitFor(() => skillScopes.at(-1) === otherWorkspace.id, 'Project settings did not switch tool scope');
    assertWorkspace();
    assert(!document.querySelector('.settings-panel .project-management-name'), 'Project lifecycle actions are still rendered in settings');
    await chooseOption(projectScope(), currentWorkspace.id);
    await waitFor(() => skillScopes.at(-1) === currentWorkspace.id, 'Project settings could not return to the current scope');
    await click('workspace:tools.newSkill');
    await change(input('.tools-editor input'), 'settings-draft');
    await change(input('.tools-editor textarea'), 'Project edits survive settings navigation');
    const skillEditor = input('.tools-editor textarea');
    await chooseOption(projectScope(), otherWorkspace.id);
    await click('workspace:tools.keepEditing');
    assert(input('.tools-editor textarea') === skillEditor && skillScopes.at(-1) === currentWorkspace.id, 'Switching the settings scope discarded the current edit');
    await click('shell:settings.general');
    assert(skillEditor.isConnected && skillEditor.value === 'Project edits survive settings navigation', 'Leaving Project settings discarded its editor state');
    await click('shell:app.providers');
    const directory = document.querySelector<HTMLButtonElement>('.runtime-directory [role=combobox]')!;
    assert(directory, 'The unified settings dialog omits runtime configuration');
    const selectMenu = await openSelect(directory);
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
    assert(dialog.contains(selectMenu), 'The runtime menu was portaled behind the native settings dialog');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); });
    await waitFor(() => !document.querySelector('[role=listbox][data-state=open]'), 'Escape did not close the runtime menu');
    assert(dialog.open, 'Canceling a select also closed settings');
    await click('shell:settings.session');
    assert(document.querySelector('.session-settings'), 'Current-session actions are missing from the unified settings dialog');
    await click('shell:common.close');
    const confirmation = () => document.querySelector<HTMLDialogElement>(`dialog[aria-label="${translate('workspace:tools.unsavedTitle')}"]`);
    const visibleConfirmation = () => {
      const element = confirmation();
      assert(element?.open && element.checkVisibility() && element.getClientRects().length > 0, 'The unsaved-project confirmation is hidden by the inactive Project section');
      return element;
    };
    await act(async () => { visibleConfirmation().dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })); await tick(); });
    assert(!confirmation() && dialog.open && skillEditor.isConnected, 'Escape in the confirmation also closed settings or discarded project edits');
    await click('shell:common.close');
    visibleConfirmation();
    await click('workspace:tools.keepEditing');
    assert(dialog.open && skillEditor.isConnected, 'Keeping project edits closed the unified settings dialog');
    await click('shell:settings.project');
    assert(input('.tools-editor textarea') === skillEditor && skillEditor.value === 'Project edits survive settings navigation', 'Returning to Project recreated or reset its editor');
    await click('MCP'); await change(input('.config-editor'), 'Unsaved MCP settings');
    await click('shell:settings.general'); await click('shell:settings.project');
    assert(input('.config-editor').value === 'Unsaved MCP settings', 'Settings navigation reset unsaved MCP content');
    assertWorkspace();
    await click('shell:settings.general'); await click('shell:common.close');
    visibleConfirmation(); await click('workspace:tools.discardChanges');
    await waitFor(() => !document.querySelector('.settings-layout'), 'Confirmed discard did not close settings');
    assertWorkspace();
  },
  'UI-PROJECT-MANAGEMENT: sidebar actions target the chosen project and recover a missing folder': async () => {
    const current = { ...workspace, id: 'kept-project', name: 'Current project' };
    const target = { ...workspace, id: 'moved-project', name: 'Moved project', cwd: '/old-project' };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), workspaces: [current, target], providers: [provider] };
    let publish: (snapshot: Snapshot) => void = () => {};
    let listingError = true;
    let unsaved = true;
    const changes: { id: string; action: WorkspaceManagement['action'] | 'rename' }[] = [];
    const update = (id: string, apply: (project: Workspace) => Workspace | undefined) => {
      snapshot = { ...snapshot, workspaces: snapshot.workspaces.flatMap(project => {
        const next = project.id === id ? apply(project) : project;
        return next ? [next] : [];
      }) };
      publish(snapshot);
    };
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => snapshot,
      subscribe: (listener: (value: Snapshot) => void) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {}, providerHealth: async () => [provider], setUnsavedFiles: () => {},
      listFiles: async (id: string) => {
        if (id !== target.id) return [];
        if (listingError) throw new Error('EACCES fixture');
        return snapshot.workspaces.find(project => project.id === id)?.cwd === target.cwd ? null : [{ path: 'new.txt', name: 'new.txt', kind: 'file', size: 1 }];
      },
      gitState: async () => ({ available: false }),
      chooseDirectory: async () => '/new-project',
      updateWorkspace: async (id: string, value: { name: string }) => {
        changes.push({ id, action: 'rename' }); update(id, project => ({ ...project, name: value.name }));
      },
      manageWorkspace: async (id: string, value: WorkspaceManagement) => {
        if (unsaved && value.action === 'relocate') throw new Error('WORKBENCH_UNSAVED_FILES');
        changes.push({ id, action: value.action });
        switch (value.action) {
          case 'relocate': update(id, project => ({ ...project, cwd: value.cwd })); break;
          case 'archive': update(id, project => ({ ...project, archived: true })); break;
          case 'restore': update(id, project => ({ ...project, archived: false })); break;
          case 'remove': update(id, () => undefined); break;
        }
      },
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>);
    const row = (id: string, archived = false) => document.querySelector<HTMLElement>('[data-' + (archived ? 'archived-' : '') + 'workspace-id="' + id + '"]');
    const activate = async (id: string) => {
      const item = row(id); assert(item, 'Missing project ' + id);
      await act(async () => { item.click(); await tick(); });
    };
    const projectTrigger = (id = target.id, archived = false) => {
      const trigger = row(id, archived)?.closest('.workspace-row-entry')?.querySelector<HTMLButtonElement>('button[aria-haspopup=menu]');
      assert(trigger && !trigger.disabled, 'The chosen project has no enabled actions menu');
      return trigger;
    };
    const projectAction = async (key: string, id = target.id, archived = false) => {
      const trigger = projectTrigger(id, archived);
      await act(async () => { trigger.click(); await tick(); });
      await waitFor(() => Boolean(document.querySelector('[role=menu]:popover-open')), 'The project menu did not open');
      const menu = document.querySelector<HTMLElement>('[role=menu]:popover-open')!;
      const item = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')].find(button => button.textContent?.trim() === translate(key));
      assert(item, 'Missing project action ' + key);
      await act(async () => { item.click(); await tick(); });
    };
    const activeProject = () => document.querySelector('.workspace-heading h1')?.textContent;
    const trigger = projectTrigger();
    await act(async () => {
      trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await tick();
    });
    await waitFor(() => trigger.getAttribute('aria-expanded') === 'true' && document.activeElement === document.querySelector('[role=menu]:popover-open [role=menuitem]'), 'Keyboard opening did not focus the first project action');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); });
    assert(!document.querySelector('[role=menu]:popover-open') && document.activeElement === trigger, 'Escape did not close the project menu and restore focus');
    await projectAction('shell:projectManagement.edit');
    assert(activeProject() === current.name, 'Opening actions switched to the target project');
    await change(input('dialog[open] input[name=project-name]'), 'Recovered project');
    await click('shell:projectManagement.rename');
    await waitFor(() => Boolean(row(target.id)?.textContent?.includes('Recovered project')), 'Renaming did not update the chosen row');
    assert(activeProject() === current.name && changes[0]?.id === target.id, 'Rename switched or updated the active project');
    await click('shell:common.close');
    await activate(target.id);
    const missing = () => document.querySelector('.file-review-panel')?.textContent?.includes(translate('workspace:files.projectDirectoryMissing'));
    await waitFor(() => document.querySelector('.file-review-panel [role=alert]')?.textContent === 'EACCES fixture', 'Permission error was not shown');
    assert(!missing(), 'Permission error was treated as a missing folder');
    listingError = false;
    await click('workspace:files.refresh');
    await waitFor(() => Boolean(missing()), 'Missing folder did not offer recovery');
    const recover = [...document.querySelectorAll<HTMLButtonElement>('.file-review-panel button')].find(item => item.textContent?.trim() === translate('workspace:files.editProject'));
    assert(recover, 'The file panel has no project editor entry');
    await act(async () => { recover.click(); await tick(); });
    assert(document.querySelector('dialog[open] input[name=project-name]') && !document.querySelector('.settings-layout'), 'Recovery did not open the same project editor');
    await click('shell:projectManagement.relocate');
    assert(changes.length === 1, 'Folder selection changed the binding before confirmation');
    await click('shell:projectManagement.confirmRelocate');
    assert([...document.querySelectorAll('dialog [role=alert]')].some(element => element.textContent === translate('shell:projectManagement.unsaved')), 'The unsaved-file guard had no readable error');
    unsaved = false;
    await click('shell:projectManagement.confirmRelocate');
    await waitFor(() => snapshot.workspaces.some(project => project.id === target.id && project.cwd === '/new-project'), 'Relocation was not committed to the chosen project');
    await click('shell:common.close');
    await waitFor(() => Boolean(document.querySelector('.file-tree button[title="new.txt"]')), 'The file panel did not load the new folder');
    assert(!missing(), 'The old missing-folder warning survived relocation');
    await activate(current.id);
    await projectAction('shell:projectManagement.archive');
    assert(!row(target.id) && activeProject() === current.name, 'Archive kept the project in the active list or switched projects');
    await act(async () => { document.querySelector<HTMLButtonElement>('.workspace-archive-toggle')!.click(); await tick(); });
    assert(row(target.id, true)?.textContent?.includes('Recovered project'), 'The archive is missing from the sidebar');
    await projectAction('shell:projectManagement.restore', target.id, true);
    assert(row(target.id) && !row(target.id, true) && activeProject() === current.name, 'Restore did not return the project without switching');
    await projectAction('shell:projectManagement.archive', current.id);
    assert(activeProject() === 'Recovered project', 'Archiving the current project did not select an available project');
    await projectAction('shell:projectManagement.restore', current.id, true);
    assert(activeProject() === 'Recovered project', 'Restoring the previously selected project stole the active workspace');
    await activate(current.id);
    await projectAction('shell:projectManagement.remove'); await click('shell:common.cancel');
    assert(row(target.id), 'Cancel removed the project');
    await projectAction('shell:projectManagement.remove'); await click('shell:projectManagement.confirmRemove');
    assert(!row(target.id) && activeProject() === current.name
      && changes.filter(change => change.id === target.id).map(change => change.action).join(',') === 'rename,relocate,archive,restore,remove'
      && changes.filter(change => change.id === current.id).map(change => change.action).join(',') === 'archive,restore', 'Project operations targeted the wrong row or removed the active project');
  },
  'UI-TOOLTIPS: icon-only controls explain hover and focus without changing disabled actions': async () => {
    let presses = 0;
    await render(<><IconButton label="Explain action" onClick={() => { presses++; }}><span aria-hidden="true">+</span></IconButton>
      <IconButton label="Unavailable action" disabled onClick={() => { presses++; }}><span aria-hidden="true">−</span></IconButton>
      <button type="button">Outside tooltip</button></>);
    const enabled = button('Explain action'), disabled = button('Unavailable action');
    const tooltip = () => document.querySelector<HTMLElement>('[role=tooltip]');
    const hover = async (element: HTMLElement) => act(async () => {
      element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 10, clientY: 10 })); await tick();
    });
    assert(!enabled.hasAttribute('title') && !disabled.hasAttribute('title'), 'Icon buttons still use native title bubbles alongside application tooltips');
    await hover(enabled);
    await waitFor(() => tooltip()?.textContent === 'Explain action', 'Hovering an icon button did not display its explanation');
    await act(async () => { enabled.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); });
    await waitFor(() => !tooltip(), 'Escape did not dismiss the tooltip');
    // Hidden Electron windows update activeElement without dispatching focus events.
    await act(async () => { enabled.focus(); enabled.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await tick(); });
    await waitFor(() => document.activeElement === enabled && tooltip()?.textContent === 'Explain action', 'Keyboard focus did not display the icon explanation');
    await act(async () => { const outside = button('Outside tooltip'); outside.focus(); enabled.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside })); await tick(); });
    await waitFor(() => !tooltip(), 'Leaving an icon button kept its tooltip open');
    await hover(disabled);
    await waitFor(() => tooltip()?.textContent === 'Unavailable action', 'A disabled icon button hides its explanation');
    await act(async () => { disabled.click(); await tick(); });
    assert(disabled.disabled && presses === 0, 'The tooltip enabled a disabled action');
  },
  'UPDATES-UI: discovery, download and installation remain separate user actions': async () => {
    const release = { version: '0.8.2', title: 'Ensemble 0.8.2', notes: '## Changes\n\n- Keep your work when updating.', publishedAt: '2026-10-26T03:00:00Z', url: 'https://github.com/MeloMei/ensemble/releases/tag/v0.8.2', downloadUrl: 'https://github.com/MeloMei/ensemble/releases/download/v0.8.2/Ensemble-0.8.2-macOS-arm64.zip', sha256: 'a'.repeat(64), size: 1024 * 1024 };
    let state: AppUpdateState = installedUpdateState;
    let publish!: (value: AppUpdateState) => void;
    let checks = 0, downloads = 0, installs = 0, unsubscribed = 0, notices = 0;
    const download = deferred<AppUpdateState>();
    window.workbench = {
      getApplicationUpdate: async () => state,
      onApplicationUpdateChanged: (listener: typeof publish) => { publish = listener; return () => { unsubscribed++; }; },
      checkApplicationUpdate: async () => { checks++; state = { ...state, phase: 'available', release }; return state; },
      downloadApplicationUpdate: async () => { downloads++; return download.promise; },
      installApplicationUpdate: async () => { installs++; return state; },
      setApplicationUpdateAutoCheck: async (autoCheck: boolean) => { state = { ...state, autoCheck }; return state; },
    } as unknown as Window['workbench'];
    function UpdateSettings() {
      const updates = useApplicationUpdates();
      return <div style={{ width: 600 }}><ApplicationUpdateNotice state={updates.state} onOpen={() => { notices++; }} /><ApplicationUpdateSettings {...updates} /></div>;
    }
    await render(<UpdateSettings />);
    assert(checks === 0 && downloads === 0 && installs === 0, 'Opening settings started an update operation');
    await click('shell:updates.check');
    assert(Number(checks) === 1 && downloads === 0 && installs === 0, 'Checking for a release downloaded or installed it');
    assert(document.querySelector('.application-update-release-notes li')?.textContent === 'Keep your work when updating.', 'The new release notes are missing');
    await click('shell:updates.view');
    assert(notices === 1 && downloads === 0, 'Opening a release notice started its download');
    await change(input('.application-update-auto input'), false);
    assert(!state.autoCheck && downloads === 0, 'Changing automatic checks started a download');
    const downloadButton = document.querySelector<HTMLButtonElement>('.application-update-actions button')!;
    await act(async () => { downloadButton.click(); downloadButton.click(); await tick(); });
    assert(Number(downloads) === 1 && downloadButton.disabled && installs === 0, 'Repeated download clicks started concurrent operations or installed the app');
    state = { ...state, phase: 'downloading', downloadedBytes: 25, totalBytes: 100 };
    await act(async () => { publish(state); await tick(); });
    assert(document.querySelector('progress')?.value === 25, 'Download progress is not shown');
    state = { ...state, phase: 'ready' };
    await act(async () => { download.resolve(state); await tick(); });
    assert(installs === 0 && !button('shell:updates.install').disabled, 'A completed download installed without confirmation');
    await click('shell:updates.install');
    assert(Number(installs) === 1, 'The explicit restart and install action was not sent');
    state = { ...state, phase: 'available', installFailure: { version: release.version, status: 'error' } };
    await act(async () => { publish(state); await tick(); });
    assert(document.querySelector('.application-update-notice')?.textContent?.includes(translate('shell:updates.noticeInstallFailed', { version: release.version })), 'The update banner hid the failed installation');
    assert(document.querySelector('.application-update-settings [role=alert]')?.textContent?.includes(translate('shell:updates.installFailure.error', { version: release.version })), 'Settings did not explain the rollback or manual upgrade option');
    await render(<div />);
    assert(unsubscribed === 1, 'Update notifications remain subscribed after unmount');
  },
  'UPDATES-UI-RETRY: service limits explain retry times without blocking manual or prepared updates': async () => {
    const release: NonNullable<AppUpdateState['release']> = { version: '0.8.2', title: 'Ensemble 0.8.2', notes: '',
      publishedAt: '2026-10-26T03:00:00Z', url: 'https://github.com/MeloMei/ensemble/releases/tag/v0.8.2',
      downloadUrl: 'https://github.com/MeloMei/ensemble/releases/download/v0.8.2/Ensemble-0.8.2-macOS-arm64.zip', sha256: 'a'.repeat(64), size: 1024 };
    let checks = 0;
    window.workbench = { checkApplicationUpdate: async () => { checks++; return installedUpdateState; } } as unknown as Window['workbench'];
    const show = (state: AppUpdateState | null) => render(<ApplicationUpdateSettings state={state} error="" pending={false} run={async operation => { await operation(); }} />);
    const manual = () => document.querySelector<HTMLAnchorElement>('.application-update-manual a');
    const assertManual = () => assert(manual()?.getAttribute('href') === 'https://github.com/MeloMei/ensemble/releases/latest'
      && manual()?.target === '_blank', 'The official manual download entry is missing or uses an untrusted destination');
    const originalLanguage = i18n.language;
    try {
      await show(null);
      assertManual();
      const retryAt = new Date(Date.now() + 250).toISOString();
      await show({ ...installedUpdateState, phase: 'error', error: 'HTTP 429 raw response', errorCode: 'rate-limited', retryAt, checkAfter: retryAt });
      assertManual();
      assert(button('shell:updates.check').disabled && document.querySelector('[role=alert]')?.textContent?.includes('temporarily limited')
        && !document.querySelector('[role=alert]')?.textContent?.includes('HTTP 429')
        && document.querySelector<HTMLTimeElement>('[role=alert] time')?.dateTime === retryAt,
      'A rate limit omits the localized reason or retry time, or leaves checks enabled');
      await click('shell:updates.check');
      assert(checks === 0, 'A disabled update check reached the backend');
      await waitFor(() => !button('shell:updates.check').disabled, 'The update check stayed disabled after its cooldown elapsed', 150);
      await click('shell:updates.check');
      assert(Number(checks) === 1, 'The check action did not become usable without reopening settings');
      const checkAfter = new Date(Date.now() + 300_000).toISOString();
      await show({ ...installedUpdateState, phase: 'error', error: 'HTTP 429', errorCode: 'rate-limited', checkAfter, retryAt: checkAfter, release });
      assert(button('shell:updates.check').disabled && !document.querySelector<HTMLButtonElement>('.application-update-actions button')?.disabled,
        'An update-check cooldown blocks downloading an already discovered release');
      await act(async () => { await i18n.changeLanguage('zh-CN'); await tick(); });
      await show({ ...installedUpdateState, phase: 'ready', error: 'HTTP 403 raw response', errorCode: 'forbidden', checkAfter, release });
      assertManual();
      assert(document.querySelector('[role=alert]')?.textContent?.includes('GitHub 拒绝') && !button('shell:updates.install').disabled,
        'A forbidden check omits its localized reason or blocks installing an already prepared update');
      await show({ ...installedUpdateState, phase: 'current', checkAfter, errorCode: 'rate-limited' });
      assert(button('shell:updates.check').disabled && document.querySelector('.application-update-cooldown') && !document.querySelector('[role=alert]'),
        'A cached successful check lacks its next check time or shows a cleared error');
    } finally {
      await act(async () => { await i18n.changeLanguage(originalLanguage); await tick(); });
    }
  },
  'UI-01: question approvals display the complete request disclosure': async () => {
    const detail = 'Send the address to https://shop.example for a paid purchase.\nConfirm the recipient and purpose first.';
    await render(chat({ session: { ...session, approvals: [{ id: 'approval', sessionId: session.id, title: 'Shipping request', detail, choices: [], questions: [{ id: 'address', question: 'Address', header: 'Address', options: [], multiSelect: false, allowCustomAnswer: true }] }] } }));
    assert(document.querySelector('.question-approval .approval-detail')?.textContent === detail, 'Question form omitted or changed the request disclosure');
  },
  'UI-02: saves retain later edits, independent tabs and the next save revision': async () => {
    let config: McpSettingsView = { content: 'initial MCP', revision: 'mcp-0', servers: [] };
    let skillFile: { content: string; revision: string } | undefined;
    let skillGate = deferred<void>(), mcpGate = deferred<void>();
    const skillWrites: unknown[] = [], mcpWrites: unknown[] = [];
    window.workbench = {
      setUnsavedFiles: () => {},
      listSkills: async () => skillFile ? [{ id: 'saved-skill', path: '/fixture/.agents/skills/demo/SKILL.md', name: 'demo', description: '', scope: 'project', editable: true }] : [],
      mcpSettings: async () => config, notificationStatus: async () => ({ supported: true, state: 'idle' }),
      readSkill: async () => skillFile!,
      saveSkill: async (_id: string, value: { content: string; revision?: string }) => { skillWrites.push(value); await skillGate.promise; skillFile = { content: value.content, revision: `skill-${skillWrites.length}` }; },
      saveMcpSettings: async (_id: string, value: { content: string; revision: string }) => { mcpWrites.push(value); await mcpGate.promise; config = { ...config, content: value.content, revision: `mcp-${mcpWrites.length}` }; },
    } as unknown as Window['workbench'];
    await render(<ProjectSettings workspace={workspace} sessions={[]} perform={perform} onClose={() => {}} />);
    await click('workspace:tools.newSkill');
    await change(input('.tools-editor input'), 'demo');
    await change(input('.tools-editor textarea'), 'skill A');
    await click('workspace:tools.saveSkill');
    await change(input('.tools-editor textarea'), 'skill B');
    await click('MCP');
    await change(input('.config-editor'), 'MCP B');
    skillGate.resolve(); await settle();
    assert(input('.config-editor').value === 'MCP B', 'Skill refresh overwrote the other tab draft');
    await click('Skills');
    assert(input('.tools-editor textarea').value === 'skill B', 'Skill save erased newer input');
    assert(input('.tools-editor input').disabled, 'Saved new skill did not acquire its stable identity');
    skillGate = deferred<void>();
    await click('workspace:tools.saveSkill'); skillGate.resolve(); await settle();
    assert((skillWrites[1] as { revision: string }).revision === 'skill-1', 'Next skill save used an obsolete revision');
    await click('MCP'); await click('workspace:tools.saveConfig');
    await change(input('.config-editor'), 'MCP C');
    await click('Skills');
    await change(input('.tools-editor textarea'), 'skill C');
    mcpGate.resolve(); await settle();
    assert(input('.tools-editor textarea').value === 'skill C', 'MCP refresh changed a skill draft');
    await click('MCP'); assert(input('.config-editor').value === 'MCP C', 'MCP save overwrote newer input');
    mcpGate = deferred<void>(); await click('workspace:tools.saveConfig'); mcpGate.resolve(); await settle();
    assert((mcpWrites[1] as { revision: string }).revision === 'mcp-1', 'Next MCP save used an obsolete revision');
    skillGate = deferred<void>(); await click('Skills'); await click('workspace:tools.saveSkill');
    await click('workspace:tools.newSkill'); await click('workspace:tools.discardChanges'); await change(input('.tools-editor input'), 'different'); await change(input('.tools-editor textarea'), 'other draft');
    skillGate.resolve(); await settle();
    assert(input('.tools-editor input').value === 'different' && input('.tools-editor textarea').value === 'other draft', 'An old save replaced a different editor');
    await click('shell:common.close'); await click('workspace:tools.discardChanges');
    assert(errors.length === 0, errors.join('\n'));
  },
  'UX-W1: workspace tool navigation and close protect unsaved Skill and MCP edits': async () => {
    const contents = new Map([['first', { content: 'first saved', revision: 'first-0' }], ['second', { content: 'second saved', revision: 'second-0' }]]);
    let config: McpSettingsView = { content: 'MCP saved', revision: 'mcp-0', servers: [] };
    let closed = 0;
    let pendingRead: ReturnType<typeof deferred<void>> | undefined;
    window.workbench = {
      setUnsavedFiles: () => {},
      listSkills: async () => [...contents.keys()].map(id => ({ id, path: `/fixture/.agents/skills/${id}/SKILL.md`, name: id, description: '', scope: 'project', editable: true })),
      readSkill: async (_id: string, id: string) => { if (id === 'second') await pendingRead?.promise; return contents.get(id)!; },
      saveSkill: async (_id: string, value: { name: string; content: string }) => { contents.set(value.name, { content: value.content, revision: `${value.name}-saved` }); },
      mcpSettings: async () => config, notificationStatus: async () => ({ supported: true, state: 'idle' }),
      saveMcpSettings: async (_id: string, value: { content: string }) => { config = { ...config, content: value.content, revision: 'mcp-1' }; },
    } as unknown as Window['workbench'];
    const selectSkill = async (index: number) => act(async () => { document.querySelectorAll<HTMLButtonElement>('.tools-list-item')[index].click(); await tick(); });
    await render(<ProjectSettings workspace={workspace} sessions={[]} perform={perform} onClose={() => { closed++; }} />);
    await selectSkill(0);
    pendingRead = deferred<void>(); await selectSkill(1);
    await change(input('.tools-editor textarea'), 'typed while loading');
    pendingRead.resolve(); await settle(); pendingRead = undefined;
    assert(input('.tools-editor textarea').value === 'typed while loading', 'A delayed Skill read replaced newer editing');
    await click('workspace:tools.keepEditing');
    await change(input('.tools-editor textarea'), 'first draft');
    await selectSkill(1);
    assert(input('.tools-editor textarea').value === 'first draft', 'Switching Skills discarded the unsaved content before a decision');
    await click('workspace:tools.keepEditing');
    assert(input('.tools-editor textarea').value === 'first draft', 'Keeping the draft replaced its content');
    await selectSkill(1); await click('workspace:tools.discardChanges'); await settle();
    assert(input('.tools-editor textarea').value === 'second saved', 'Confirmed discard did not open the requested Skill');
    await change(input('.tools-editor textarea'), 'second draft'); await click('workspace:tools.newSkill');
    assert(input('.tools-editor textarea').value === 'second draft', 'New Skill discarded the current editor without a decision');
    await click('workspace:tools.keepEditing'); await click('workspace:tools.saveSkill'); await settle();
    await click('workspace:tools.newSkill');
    assert(!document.querySelector('dialog[aria-label="Unsaved changes"]') && input('.tools-editor input').value === '', 'A successfully saved Skill still blocked navigation');
    await click('MCP'); await change(input('.config-editor'), 'MCP draft');
    await click('shell:common.close');
    assert(closed === 0 && input('.config-editor').value === 'MCP draft', 'Closing tools discarded unsaved MCP settings');
    await click('workspace:tools.keepEditing'); await click('workspace:tools.saveConfig'); await settle();
    await click('shell:common.close');
    assert(Number(closed) === 1 && !document.querySelector('dialog[aria-label="Unsaved changes"]'), 'Saved settings still blocked closing');
    await render(<div />);
    await render(<ProjectSettings workspace={workspace} sessions={[]} perform={perform} onClose={() => { closed++; }} />);
    await click('Skills'); await selectSkill(0);
    pendingRead = deferred<void>(); await selectSkill(1); await change(input('.tools-editor textarea'), 'late close draft');
    await click('shell:common.close'); pendingRead.resolve(); await settle(); pendingRead = undefined;
    await click('workspace:tools.discardChanges');
    assert(Number(closed) === 2, 'A late Skill read replaced the pending close decision');
    assert(errors.length === 0, errors.join('\n'));
  },
  'UX-W2: tool drafts survive navigation and in-flight saves without replacing their original revision': async () => {
    const first = { ...workspace, id: 'tool-first', name: 'First project' }, other = { ...workspace, id: 'tool-other', name: 'Other project' };
    const registered = new Map<string, UnsavedFileSummary>();
    let config: McpSettingsView = { content: 'MCP original', revision: 'mcp-0', servers: [] };
    let initialLoad: ReturnType<typeof deferred<void>> | undefined = deferred<void>();
    let saving: ReturnType<typeof deferred<void>> | undefined;
    let savedSkill: { content: string; revision: string } | undefined;
    const writes: { content: string; revision?: string }[] = [], mcpWrites: string[] = [];
    window.workbench = {
      setUnsavedFiles: (summary: UnsavedFileSummary, source = 'files') => { if (summary.count) registered.set(source, summary); else registered.delete(source); },
      listSkills: async () => savedSkill ? [{ id: 'retained', path: '/fixture/.agents/skills/retained/SKILL.md', name: 'retained', description: '', scope: 'project', editable: true }] : [],
      readSkill: async () => savedSkill!, notificationStatus: async () => ({ supported: true, state: 'idle' }),
      mcpSettings: async () => { await initialLoad?.promise; return config; },
      saveSkill: async (_id: string, value: { content: string; revision?: string }) => { writes.push(value); await saving?.promise; savedSkill = { content: value.content, revision: 'saved-1' }; },
      saveMcpSettings: async (_id: string, value: { revision: string }) => { mcpWrites.push(value.revision); if (value.revision !== config.revision) throw new Error('MCP revision changed'); },
    } as unknown as Window['workbench'];
    const show = (value: Workspace) => render(<React.StrictMode><ProjectSettings key={value.id} workspace={value} sessions={[]} perform={perform} onClose={() => {}} /></React.StrictMode>);
    await show(first); await click('workspace:tools.newSkill'); await change(input('.tools-editor input'), 'retained'); await change(input('.tools-editor textarea'), 'Skill before navigation');
    await click('MCP'); await change(input('.config-editor'), 'MCP before initial load'); await render(<div />);
    assert(registered.get('workspace-tools:tool-first')?.count === 2, 'Unmounting dropped the native close and removal guard');
    initialLoad.resolve(); await settle(); initialLoad = undefined;
    await show(first); await click('MCP');
    assert(input('.config-editor').value === 'MCP before initial load', 'Reopening overwrote edits made before the initial MCP read');
    await click('Skills'); assert(input('.tools-editor textarea').value === 'Skill before navigation', 'Navigation lost the Skill draft');
    saving = deferred<void>(); await click('workspace:tools.saveSkill'); await change(input('.tools-editor textarea'), 'Skill typed during save');
    await render(<div />); await show(other); await click('MCP'); await change(input('.config-editor'), 'Other project draft');
    await render(<div />); await show(first);
    assert(button('workspace:tools.saveSkill').disabled && button('shell:common.close').disabled, 'Reopening forgot an in-flight save');
    saving.reject(new Error('controlled write failed')); await settle(); saving = undefined;
    assert(input('.tools-editor textarea').value === 'Skill typed during save' && !button('workspace:tools.saveSkill').disabled, 'A failed save lost later input or left the editor blocked');
    assert(registered.get('workspace-tools:tool-first')?.count === 2 && registered.get('workspace-tools:tool-other')?.count === 1, 'One workspace overwrote another workspace guard');
    saving = deferred<void>(); await click('workspace:tools.saveSkill'); await render(<div />); await show(first);
    saving.resolve(); await settle(); saving = undefined;
    assert(savedSkill?.content === 'Skill typed during save' && registered.get('workspace-tools:tool-first')?.count === 1, 'Saving after navigation failed to resolve only the written draft');
    assert(document.querySelector('.tools-list-item')?.textContent?.includes('retained'), 'A save that began before remount did not refresh the current Skill list');
    await render(<div />);
    config = { ...config, content: 'MCP changed elsewhere', revision: 'mcp-1' };
    await show(first); await click('MCP'); await click('workspace:tools.saveConfig'); await settle();
    assert(mcpWrites[0] === 'mcp-0' && input('.config-editor').value === 'MCP before initial load', 'Reopening adopted a newer revision and silently overwrote external settings');
    await click('shell:common.close'); await click('workspace:tools.discardChanges'); await render(<div />);
    assert(!registered.has('workspace-tools:tool-first') && registered.has('workspace-tools:tool-other'), 'Discard did not clear exactly its own workspace');
    await show(first); await click('MCP');
    assert(input('.config-editor').value === config.content, 'A resolved draft retained a stale MCP read cache');
    await click('Skills'); assert(!document.querySelector('.tools-editor'), 'A resolved Skill editor was retained as a stale cache');
    await render(<div />); await show(other); await click('MCP');
    assert(input('.config-editor').value === 'Other project draft', 'Switching projects discarded the other draft');
    await click('shell:common.close'); await click('workspace:tools.discardChanges');
    assert(registered.size === 0 && writes.length === 2 && errors.length === 2, `Unexpected remaining drafts, writes or errors: ${registered.size}, ${writes.length}, ${errors.join('; ')}`);
  },
  'UX-W3: delayed initial MCP reads cannot roll back a save completed after reopening': async () => {
    const target = { ...workspace, id: 'tool-refresh', name: 'Refresh project' };
    const server = (name: string) => ({ name, source: 'project', transport: 'stdio', status: 'disabled' });
    let config: McpSettingsView = { content: 'MCP A', revision: 'mcp-0', servers: [server('server-A')] };
    const saveGate = deferred<void>();
    let notificationGate: ReturnType<typeof deferred<void>> | undefined;
    const writes: { content: string; revision: string }[] = [];
    window.workbench = {
      setUnsavedFiles: () => {}, listSkills: async () => [],
      mcpSettings: async () => config,
      notificationStatus: async () => { await notificationGate?.promise; return { supported: true, state: 'idle' }; },
      saveMcpSettings: async (_id: string, value: { content: string; revision: string }) => {
        writes.push(value); assert(value.revision === config.revision, 'The next save used a baseline rolled back by an older read');
        await saveGate.promise; config = { content: value.content, revision: `mcp-${writes.length}`, servers: [server('server-B')] };
      },
    } as unknown as Window['workbench'];
    const show = () => render(<ProjectSettings workspace={target} sessions={[]} perform={perform} onClose={() => {}} />);
    await show(); await click('MCP'); await change(input('.config-editor'), 'MCP B'); await click('workspace:tools.saveConfig');
    await render(<div />); notificationGate = deferred<void>(); await show(); await click('MCP');
    assert(button('workspace:tools.saveConfig').disabled, 'The reopened editor forgot the pending save');
    saveGate.resolve();
    await waitFor(() => !button('workspace:tools.saveConfig').disabled && Boolean(document.querySelector('.tools-item strong')?.textContent?.includes('server-B')), 'The completed save did not update the reopened editor');
    notificationGate.resolve(); await settle(); notificationGate = undefined;
    assert(input('.config-editor').value === 'MCP B' && document.querySelector('.tools-item strong')?.textContent === 'server-B', 'An older initial read replaced the saved MCP content or server list');
    await change(input('.config-editor'), 'MCP C'); await click('workspace:tools.saveConfig'); await settle();
    assert(writes[1]?.revision === 'mcp-1' && errors.length === 0, `The saved revision was not retained: ${errors.join('; ')}`);
    await click('shell:common.close');
  },
  'WORKSPACE-FILE-TREE: folders load in place and keep their ancestors, selection and scope': async () => {
    const path = (value: string, kind: 'file' | 'directory') => ({ path: value, name: value.split('/').at(-1)!, kind, size: 0 });
    const target = 'src/lib/target.ts';
    const listings = new Map([
      ['', [path('src', 'directory'), path('docs', 'directory'), path('README.md', 'file')]],
      ['src', [path('src/lib', 'directory'), path('src/guide.md', 'file')]],
      ['src/lib', [...Array.from({ length: 30 }, (_, i) => path(`src/lib/entry-${i}.ts`, 'file')), path(target, 'file')]],
      ['docs', [path('docs/unloaded.md', 'file')]],
    ]);
    const directories: [string, string][] = [];
    const opened: string[] = [];
    const secondary = { ...workspace, id: 'tree-secondary', cwd: '/tree-secondary' };
    window.workbench = {
      listFiles: async (workspaceId: string, directory: string) => { directories.push([workspaceId, directory]); return listings.get(directory) ?? []; },
      gitState: async () => ({ available: false }),
      readFile: async (_id: string, file: string) => { opened.push(file); return { path: file, content: 'example', revision: 'r0', language: 'text', size: 7 }; },
      setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    const show = (current: Workspace) => render(<FileReviewPanel key={current.id} workspace={current} refreshKey="tree" perform={perform} />, 'user');
    const row = (file: string) => document.querySelector<HTMLButtonElement>(`.workspace-tree-scroll button[title="${CSS.escape(file)}"]`);
    const clickRow = async (file: string) => {
      const target = row(file);
      assert(target, `Missing file row ${file}`);
      await act(async () => { target.click(); await tick(); });
    };
    const open = (file: string) => row(file)?.getAttribute('aria-expanded') === 'true';
    await show(workspace);
    await waitFor(() => Boolean(row('src')), 'Root directory did not load');
    assert(JSON.stringify(directories) === JSON.stringify([[workspace.id, '']]), 'Opening Files scanned unopened folders');
    await clickRow('src');
    await waitFor(() => Boolean(row('src/lib')), 'Expanding src did not show its children in place');
    assert(row('docs') && row('README.md') && !row(target), 'Expanding src replaced its siblings or scanned deeper folders');
    await clickRow('src/lib');
    await waitFor(() => Boolean(row(target)), 'Expanding the nested folder did not load its files');
    const scroller = document.querySelector<HTMLElement>('.workspace-tree-scroll')!;
    const region = row('src')!.nextElementSibling!;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      assert(getComputedStyle(region).transitionDuration === '0s', 'Reduced motion left a tree animation enabled');
    } else {
      assert(getComputedStyle(region).transitionProperty.includes('grid-template-rows'), 'Folder rows have no expand or collapse transition');
    }
    await waitFor(() => scroller.scrollHeight - scroller.clientHeight >= 220, 'The expanded rows did not fill the scroll area');
    await act(async () => { scroller.scrollTop = 220; await tick(); });
    await waitFor(() => {
      const viewport = scroller.getBoundingClientRect();
      const first = row('src')!.getBoundingClientRect();
      const second = row('src/lib')!.getBoundingClientRect();
      return scroller.scrollTop > 100 && Math.abs(first.top - viewport.top) < 2 && Math.abs(second.top - first.bottom) < 2;
    }, 'Scrolled-out ancestor folders did not stick above the nested files');
    await waitFor(() => {
      const nested = row('src/lib')!.getBoundingClientRect();
      return document.elementFromPoint(nested.left + 20, nested.top + 12)?.closest('button') === row('src/lib');
    }, 'A pinned folder could not be clicked after the expand animation');
    await act(async () => { scroller.style.flex = '0 0 75px'; await tick(); });
    assert(getComputedStyle(row('src')!).position === 'sticky' && getComputedStyle(row('src/lib')!).position === 'static', 'Pinned ancestors filled the whole tree in a short file inspector');
    await act(async () => { scroller.style.removeProperty('flex'); await tick(); });
    await clickRow('src/lib');
    assert(!open('src/lib'), 'Clicking a pinned ancestor did not collapse its contents');

    const search = input('.workspace-tree-filter input');
    const readsBeforeSearch = directories.length;
    await change(search, 'target');
    assert(open('src') && open('src/lib') && row(target) && !row('README.md'), 'Searching a loaded file lost its ancestors or kept unrelated rows');
    assert(document.querySelector('.workspace-tree-scope')?.textContent === translate('workspace:files.filterScope')
      && directories.length === readsBeforeSearch, 'The search expanded its read scope beyond loaded folders');
    await clickRow(target);
    await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-test-editor]')?.value === 'example', 'Opening a search result did not load the file');
    const editor = input('[data-test-editor]');
    await change(search, '');
    assert(open('src') && !open('src/lib'), 'Clearing search overwrote the folder expansion choices');
    await clickRow('src/lib');
    assert(row(target)?.classList.contains('selected'), 'Opening the folder again lost the selected file');
    await click('workspace:files.changes');
    await click('workspace:files.files');
    assert(open('src/lib') && input('[data-test-editor]') === editor, 'Changing views reset the tree or editor');
    const beforeRefresh = directories.length;
    await click('workspace:files.refresh');
    await waitFor(() => directories.length >= beforeRefresh + 3, 'Refreshing did not reread expanded folders');
    assert(JSON.stringify(directories.slice(beforeRefresh).map(([, directory]) => directory)) === JSON.stringify(['', 'src', 'src/lib'])
      && row(target)?.classList.contains('selected') && opened.length === 1, 'Refreshing scanned closed folders or reopened the selected file');
    await show(secondary);
    await waitFor(() => Boolean(row('src')), 'The second workspace did not load');
    assert(!open('src'), 'Expansion choices leaked into another workspace');
    await show(workspace);
    await waitFor(() => open('src/lib') && Boolean(row(target)), 'Returning to the workspace lost its expanded paths');
    assert(opened.length === 1, 'Restoring the tree reopened a file without a click');
  },
  'BRANCH-COMPARE: Changes opens a read-only comparison with explicit refs and preserves the working diff': async () => {
    const local = 'refs/heads/review';
    const remote = 'refs/remotes/origin/review';
    const currentProject = { ...workspace, id: 'branch-compare-project' };
    const calls: string[][] = [];
    const staged = 'Staged changes\ndiff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-before\n+staged';
    const targetSha = 'a'.repeat(40), mergeBase = 'b'.repeat(40), headSha = 'c'.repeat(40);
    let targetUnavailable = false;
    window.workbench = {
      listFiles: async () => [], setUnsavedFiles: () => {},
      gitState: async () => ({ available: true, branch: 'main', changes: [{ path: 'file.txt', status: 'M ', staged: true, additions: 1, deletions: 1 }] }),
      fileDiff: async () => ({ path: 'file.txt', patch: staged, binary: false, truncated: false, revision: 'staged-1' }),
      gitBranchRefs: async (id: string) => { calls.push([id]); return [local, remote]; },
      gitBranchComparison: async (id: string, targetRef: string) => {
        calls.push([id, targetRef]);
        if (targetUnavailable) throw new Error('The selected branch reference is unavailable');
        return { targetRef, targetSha, mergeBase, headSha, patch: targetRef === local ? '+committed content' : '', truncated: targetRef === local };
      },
    } as unknown as Window['workbench'];
    await render(<FileReviewPanel workspace={currentProject} refreshKey="branch" perform={perform} />);
    await settle();
    assert(calls.length === 0 && !document.querySelector('.branch-comparison'), 'Opening Files read branch refs before user intent');
    await act(async () => { document.querySelector<HTMLButtonElement>('.file-view-tabs button:nth-child(2)')!.click(); await tick(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('.review-change-row .tree-row')!.click(); await tick(); });
    await settle();
    const workingDiff = document.querySelector('.review-inspector .review-diff');
    assert(workingDiff?.textContent?.includes('+staged'), 'The existing staged diff was not available');
    await click('workspace:files.branchCompare');
    const compare = async (ref: string) => {
      await chooseOption(button('workspace:files.branchCompareTarget'), ref);
      await click('workspace:files.branchCompareRun');
    };
    await compare(remote);
    const dialog = document.querySelector('.branch-comparison')!;
    assert(dialog.textContent?.includes(translate('workspace:files.branchCompareEmpty')), 'The empty comparison state was missing');
    const revisions = [...dialog.querySelectorAll('dd code')].map(item => item.textContent);
    assert(revisions.join(',') === [remote, targetSha, mergeBase, headSha].join(','), 'The selected ref or exact commit range was missing');
    await compare(local);
    assert(dialog.querySelector('pre')?.textContent === '+committed content'
      && dialog.textContent?.includes(translate('workspace:files.branchCompareTruncated')), 'A truncated committed patch looked complete');
    targetUnavailable = true;
    await compare(remote);
    assert(dialog.querySelector('[role=alert]')?.textContent?.includes('reference is unavailable') && !dialog.querySelector('pre'),
      'A stale patch was presented as the result of a failed comparison');
    await act(async () => { document.querySelector<HTMLButtonElement>('dialog .modal-heading button')!.click(); await tick(); });
    assert(document.querySelector('.review-inspector .review-diff') === workingDiff
      && !document.querySelector('.branch-comparison'), 'Opening or closing comparison replaced the staged diff');
    assert(JSON.stringify(calls) === JSON.stringify([[currentProject.id], [currentProject.id, remote], [currentProject.id, local], [currentProject.id, remote]]),
      'Branch comparison used a different workspace or did not send the full selected ref');
  },
  'UX2-FILES-PR: refreshing the PR view rereads its checks without background GitHub requests': async () => {
    let reviewReads = 0, fileReads = 0;
    window.workbench = {
      listFiles: async () => { fileReads++; return []; }, gitState: async () => ({ available: false }),
      reviewPullRequest: async () => {
        reviewReads++;
        return { status: 'ready', number: 42, title: 'Current pull request', url: 'https://github.com/example/project/pull/42', state: 'OPEN',
          checks: [{ name: 'build', status: reviewReads === 1 ? 'IN_PROGRESS' : 'COMPLETED', conclusion: reviewReads === 1 ? undefined : 'SUCCESS' }] };
      },
    } as unknown as Window['workbench'];
    const show = (refreshKey: string) => render(<FileReviewPanel workspace={workspace} refreshKey={refreshKey} perform={perform} />);
    await show('r0'); await settle();
    assert(Number(reviewReads) === 0, 'Opening files made a background GitHub request');
    await click('PR / CI'); await settle();
    assert(Number(reviewReads) === 1 && document.querySelector('.review-checks')?.textContent?.includes('IN_PROGRESS'), 'The initial PR check was not shown');
    await click('workspace:files.refresh'); await settle();
    assert(Number(reviewReads) === 2 && document.querySelector('.review-checks')?.textContent?.includes('SUCCESS'), 'Refresh left the current PR checks stale');
    await show('r1'); await settle();
    assert(Number(reviewReads) === 2, 'A workspace revision polled GitHub without user intent');
    await click('workspace:files.files');
    const previousFiles = fileReads;
    await click('workspace:files.refresh'); await settle();
    assert(fileReads === previousFiles + 1 && Number(reviewReads) === 2, 'File refresh used the wrong data source');
  },
  'UI-03: recovery confirmation belongs to one workflow and one recovery version': async () => {
    let failResume = true;
    window.workbench = { resumeWorkflow: async () => { if (failResume) throw new Error('fixture resume failed'); } } as unknown as Window['workbench'];
    const workflow = (id: string, status: Workflow['status'] = 'failed', updatedAt = 'v1'): Workflow => ({ id, name: id, cwd: workspace.cwd, status, steps: [], createdAt: '2026-10-23', updatedAt });
    const show = (value: Workflow) => render(<WorkflowView workflow={value} providers={[]} sessions={[]} perform={perform} pending={new Set()} openSession={() => {}} />);
    await show(workflow('A')); await change(input('input[type=checkbox]'), true);
    assert(!button('shell:workflow.resume').disabled, 'A was not confirmed');
    await show(workflow('B'));
    assert(!(input('input[type=checkbox]') as HTMLInputElement).checked && button('shell:workflow.resume').disabled, 'B inherited A confirmation');
    await change(input('input[type=checkbox]'), true); await click('shell:workflow.resume'); await settle();
    await show(workflow('A', 'running')); await show(workflow('B'));
    assert(button('shell:workflow.resume').disabled, 'Confirmation survived a failed resume and another workflow');
    await change(input('input[type=checkbox]'), true); await show(workflow('B', 'failed', 'v2'));
    assert(button('shell:workflow.resume').disabled, 'Updated recovery candidates retained old confirmation');
    failResume = false;
  },
  'COMMAND-01: the command palette searches and routes without moving focus or its viewport': async () => {
    const other = { ...workspace, id: 'other-project', name: 'Design project', cwd: '/projects/design-system' };
    const runtimeSession = { ...session, title: 'Trace runtime', cwd: workspace.cwd };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [runtimeSession], providers: [provider], workspaces: [workspace, other] };
    let publish = (_value: Snapshot) => {};
    const opened: string[][] = [];
    const terminals: string[] = [];
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {}, markSessionSeen: async () => {},
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      createTerminal: async (id: string) => { terminals.push(id); },
      openSessionTab: async (workspaceId: string, sessionId: string) => {
        opened.push([workspaceId, sessionId]);
        const tab = { kind: 'agent' as const, id: 'command-session-tab', sessionId };
        snapshot = { ...snapshot, workspaces: [{ ...workspace, tabs: [tab], activeTabId: tab.id }, other] };
        publish(snapshot);
      },
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>, 'user');
    const host = document.querySelector<HTMLElement>('.workbench')!.parentElement!;
    await act(async () => { host.style.width = '1380px'; await tick(); });
    const trigger = button('shell:commandPalette.trigger');
    const modal = () => document.querySelector<HTMLElement>('dialog[open] .command-palette');
    const search = () => input('.command-palette input[role=combobox]');
    const active = () => document.getElementById(search().getAttribute('aria-activedescendant') ?? '');
    const key = async (name: string, code: string, windowsVirtualKeyCode: number, modifiers = 0) => {
      await act(async () => {
        for (const type of ['rawKeyDown', 'keyUp']) await rendererInput({ type, key: name, code, windowsVirtualKeyCode, modifiers });
      });
    };
    const shortcut = () => key('k', 'KeyK', 75, navigator.platform.startsWith('Mac') ? 4 : 2);
    const escape = () => key('Escape', 'Escape', 27);
    const enter = () => key('Enter', 'Enter', 13);
    const run = async (query: string) => {
      await click('shell:commandPalette.trigger');
      await change(search(), query);
      assert(active(), `The palette did not find ${query}`);
      await enter();
      assert(!modal(), `The palette remained open after ${query}`);
    };
    const source = button('shell:app.history');
    await act(async () => { source.focus(); });
    await shortcut();
    const panel = modal();
    assert(panel && document.activeElement === search(), 'The global shortcut did not open and focus the palette');
    const initialSearch = search();
    const initialRow = active();
    const bounds = [panel.offsetTop, panel.offsetHeight];
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      assert(getComputedStyle(panel).transform === 'none', 'The palette entered with motion when reduced motion was enabled');
    }
    await key('ArrowDown', 'ArrowDown', 40);
    assert(active() !== initialRow && document.activeElement === initialSearch, 'ArrowDown did not move the active row with focus in search');
    await key('ArrowUp', 'ArrowUp', 38);
    assert(active() === initialRow, 'Moving selection recreated the first row');
    await change(initialSearch, 'no matching thing');
    assert(modal() === panel && search() === initialSearch && document.activeElement === initialSearch && !active()
      && panel.offsetTop === bounds[0] && panel.offsetHeight === bounds[1], 'Filtering changed the dialog, focus, or bounds');
    assert(panel.querySelector('[role=status]')?.textContent === translate('shell:commandPalette.empty'), 'Empty search results were not announced');
    await escape();
    assert(!modal() && document.activeElement === source, 'Escape did not close and restore the shortcut source');

    await run('design-system');
    assert(document.querySelector('.workspace-heading h1')?.textContent === other.name && document.activeElement === trigger, 'A project result did not select the existing project or restore focus');
    await run('codex trace runtime');
    await waitFor(() => document.querySelector('.chat-toolbar h2')?.textContent === runtimeSession.title, 'The session result did not open the existing session tab');
    assert(JSON.stringify(opened) === JSON.stringify([[workspace.id, runtimeSession.id]]), 'The session result used the wrong project or opened twice');

    await click('shell:app.hideFiles');
    assert(document.querySelector('.file-panel-transition')?.getAttribute('aria-hidden') === 'true', 'The file panel did not start hidden');
    await run('open files');
    assert(document.querySelector('.file-panel-transition')?.getAttribute('aria-hidden') === 'false', 'Open files did not show the existing file panel');
    await run('open local terminal');
    assert(JSON.stringify(terminals) === JSON.stringify([workspace.id]), 'The terminal command was not routed to the current project');

    for (const [query, title] of [['new project', 'shell:app.newWorkspace'], ['new agent', 'shell:app.newAgentSession'], ['settings', 'shell:preferences.title']]) {
      await run(query);
      assert(document.querySelector('dialog[open]')?.getAttribute('aria-label') === translate(title), `The palette did not route ${query} to its existing dialog`);
      await shortcut();
      assert(!modal(), 'The shortcut opened a second dialog over a current modal');
      await escape();
    }
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      await click('shell:commandPalette.trigger');
      await change(search(), '打开文件');
      assert(active()?.textContent?.includes('打开文件'), 'The localized action was not searchable');
      await escape();
    } finally { await act(async () => { await i18n.changeLanguage('en'); }); }
  },
  'UI-04: explicit discard handles deleted files while preserving other I/O failures': async () => {
    let readState: 'present' | 'missing' | 'denied' = 'present';
    let summary: UnsavedFileSummary = { count: 0, names: [] };
    const file: FileContent = { path: 'a.txt', content: 'original', revision: 'r0', size: 8, language: 'text' };
    window.workbench = {
      listFiles: async () => ['a.txt', 'b.txt'].map(path => ({ path, name: path, kind: 'file', size: 8 })), gitState: async () => ({ available: false }),
      readFile: async (_id: string, path: string) => { if (path === 'a.txt') { if (readState === 'missing') return null; if (readState === 'denied') throw new Error('EACCES fixture'); } return { ...file, path }; },
      setUnsavedFiles: (value: UnsavedFileSummary) => { summary = value; },
    } as unknown as Window['workbench'];
    await render(<FileReviewPanel workspace={workspace} refreshKey="r0" perform={perform} />);
    await click('a.txt'); await change(input('[data-test-editor]'), 'unsaved edit');
    readState = 'denied'; await click('workspace:files.reloadDiscard'); await settle();
    assert(summary.count === 1 && input('[data-test-editor]').value === 'unsaved edit', 'Permission failure discarded the draft');
    assert(errors.some(error => error.includes('EACCES fixture')), 'Permission failure was hidden');
    readState = 'missing'; await click('workspace:files.reloadDiscard'); await settle();
    assert(Number(summary.count) === 0 && !document.querySelector('[data-test-editor]'), 'Confirmed missing file retained its dirty inspector');
    await click('b.txt'); assert(input('[data-test-editor]').value === 'original', 'Discard still blocked browsing another file');
  },
  'HOVER-01: session previews preserve selection and context usage updates in place': async () => {
    const sourceTab = { kind: 'agent' as const, id: 'source-tab', sessionId: session.id };
    const otherTab = { kind: 'agent' as const, id: 'other-tab', sessionId: 'other-session' };
    const sideProject = { ...workspace, id: 'side-project', name: 'Other project', cwd: '/other', pinned: true };
    const source = { ...session, usage: [
      { id: 'context', scope: 'context' as const, source: 'fixture', contextUsed: 56, contextSize: 100, createdAt: 'now' },
      { id: 'turn', scope: 'turn' as const, source: 'fixture', outputTokens: 16, createdAt: 'now' },
    ] };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [
      source, { ...session, id: otherTab.sessionId, title: 'Other session' },
      { ...session, id: 'outside', title: 'Outside session', cwd: sideProject.cwd, status: 'waiting_approval', historyLoaded: false,
        approvals: [{ id: 'approval', sessionId: 'outside', title: 'Approve', detail: 'detail', choices: [] }],
        latestTrace: { title: 'npm run build', status: 'running' } },
    ], providers: [provider], workspaces: [{ ...workspace, pinned: true, tabs: [sourceTab, otherTab], activeTabId: sourceTab.id }, sideProject] };
    let publish = (_value: Snapshot) => {};
    const activations: string[] = [];
    const watches: string[][] = [];
    const seen: string[] = [];
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async (ids: string[]) => { watches.push(ids); },
      markSessionSeen: async (id: string) => { seen.push(id); },
      activateTab: async (_id: string, tabId: string) => { activations.push(tabId); },
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>, 'user');
    await waitFor(() => Boolean(document.querySelector('.context-usage-trigger')), 'The current context usage was missing');
    const card = () => document.querySelector<HTMLElement>('.ui-detail-card:not([data-state=closed])');
    const move = async (target: Element, vertical = .5) => {
      const { x, y, width, height } = target.getBoundingClientRect();
      await act(async () => {
        await rendererInput({ type: 'mouseMoved', x: Math.floor(x + width / 2), y: Math.floor(y + height * vertical) });
        await tick();
      });
    };
    const rows = [sideProject, workspace].map(project => document.querySelector<HTMLElement>(`[data-workspace-id="${project.id}"]`)!);
    await move(rows[0]);
    assert(!card(), 'The first hover skipped its dwell time');
    await waitFor(() => card()?.textContent?.includes('npm run build') === true, 'The unwatched session did not show its Trace summary', 120);
    assert(card()?.dataset.state === 'delayed-open' && card()?.textContent?.includes('Pending approvals'), 'The delayed card omitted the approval');
    assert(card()!.getBoundingClientRect().left >= rows[0].getBoundingClientRect().right, 'The project card covered its trigger');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    assert((getComputedStyle(card()!).animationName === 'none') === reduced, 'The detail card ignored reduced motion');
    const heading = document.querySelector('.new-workspace-button')!;
    await move(heading);
    await move(document.querySelector('.sidebar-titlebar')!);
    await waitFor(() => !card(), 'The pointer did not leave the first project preview');
    await move(rows[1]);
    await waitFor(() => card()?.querySelector('.ui-detail-card-title')?.textContent === source.title,
      'The adjacent project did not open a new card', 22);
    assert(card()?.dataset.state === 'instant-open', 'The adjacent project waited through the full delay');
    assert(!watches.flat().includes('outside') && !seen.includes('outside') && activations.length === 0, 'Hover activated or marked another session as seen');

    const tab = [...document.querySelectorAll<HTMLButtonElement>('.tab-select')].find(item => item.textContent === 'Other session')!;
    await act(async () => { tab.focus(); await tick(); });
    await waitFor(() => card()?.querySelector('.ui-detail-card-title')?.textContent === 'Other session', 'Keyboard focus did not show the tab preview');
    assert(tab.getAttribute('aria-describedby') && document.activeElement === tab, 'The card did not describe the focused tab');
    await act(async () => {
      for (const type of ['keyDown', 'keyUp']) await rendererInput({ type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    });
    assert(!card() && document.activeElement === tab, 'Escape did not dismiss the preview in place');
    await act(async () => { tab.click(); await tick(); });
    assert(activations.join() === otherTab.id, 'The Session tab lost its click action');

    const badge = document.querySelector<HTMLElement>('.context-usage-trigger')!;
    await act(async () => { badge.focus(); await tick(); });
    await waitFor(() => card()?.textContent?.includes('56%') === true, 'The context card omitted the used fraction');
    const usageCard = card()!;
    const updateUsage = async (contextUsed: number, contextSize?: number) => {
      const updated = { ...source, usage: [{ ...source.usage[0], contextUsed, contextSize }, source.usage[1]] };
      snapshot = { ...snapshot, sessions: [updated, ...snapshot.sessions.slice(1)] };
      await act(async () => { publish(snapshot); await tick(); });
    };
    await updateUsage(57, 100);
    assert(card() === usageCard && usageCard.textContent?.includes('57%'), 'A new value replaced or closed the context card');
    const visual = usageCard.querySelector('.ui-rolling-text-visual');
    assert(Boolean(visual?.querySelector('.ui-rolling-text-change')) !== reduced, 'The context value did not follow the rolling motion preference');
    if (!reduced) assert(visual?.firstChild?.textContent === '5' && visual?.querySelector('.ui-rolling-text-entering')?.textContent === '7', 'The unchanged digit rolled with the changed digit');
    await updateUsage(57);
    assert(card() === usageCard && usageCard.querySelectorAll('dt').length === 1 && !usageCard.textContent?.includes('%'), 'The card invented a percentage without a reported limit');
  },
  'UI-05: inline session controls preserve drafts, capabilities and partial settings updates': async () => {
    const writes: Record<string, unknown>[] = [];
    let sends = 0;
    let draftChanges = 0;
    const configuredProvider: ProviderInfo = { ...provider, models: [
      { id: 'model-a', name: 'Model A', free: false },
      { id: 'model-b', name: 'Alternate', free: false, efforts: ['low'] },
      { id: 'model-c', name: 'Fast model', free: true, efforts: [] },
    ] };
    const configuredSession: Session = { ...session, modelId: 'model-a' };
    const draft = { text: 'Keep this unfinished task', attachments: [{ id: 'attachment', name: 'note.txt', kind: 'text' as const, ownedPath: '/note.txt', mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }] };
    let settingsVisible = false;
    let receiveSession: React.Dispatch<React.SetStateAction<Session>>;
    let holdWrite: ReturnType<typeof deferred<void>> | undefined;
    let delaySnapshot = false;
    let deliverSnapshot: (() => void) | undefined;
    let failWrite = false;
    function ComposerFixture({ overrides }: { overrides: Partial<Parameters<typeof SessionChat>[0]> }) {
      const [current, setCurrent] = React.useState(configuredSession);
      receiveSession = setCurrent;
      const displayed = overrides.session ?? current;
      return <>{chat({ session: displayed, provider: configuredProvider, draft, onDraftChange: () => { draftChanges++; }, ...overrides })}
        {settingsVisible && <SessionSettingsPanel session={displayed} workspaceId={workspace.id} visible perform={perform} openSession={() => {}} />}
      </>;
    }
    const show = (overrides: Partial<Parameters<typeof SessionChat>[0]> = {}) => render(<ComposerFixture overrides={overrides} />, 'user');
    const trigger = () => document.querySelector<HTMLButtonElement>('.composer-select-model')!;
    const permission = () => document.querySelector<HTMLButtonElement>(`.composer-controls button[role=combobox][aria-label="${translate('workspace:chat.permissions')}"]`)!;
    const picker = () => document.querySelector<HTMLElement>('.composer-model-picker[data-state=open]');
    const disclosure = () => picker()!.querySelector<HTMLButtonElement>('.composer-model-disclosure')!;
    const slider = () => picker()?.querySelector<HTMLInputElement>('input[type=range]');
    const modelOption = (label: string) => [...picker()!.querySelectorAll<HTMLButtonElement>('.composer-model-option')].find(item => item.textContent?.startsWith(label));
    const open = async () => {
      await act(async () => { trigger().focus(); trigger().click(); await tick(); });
      await waitFor(() => Boolean(picker()), 'The model control did not open');
      return picker()!;
    };
    const expand = async () => {
      await act(async () => { disclosure().click(); await tick(); });
      const search = input('.composer-model-search input');
      assert(disclosure().getAttribute('aria-expanded') === 'true' && document.activeElement === search, 'Opening the model list did not focus search');
      return search;
    };
    const choose = async (label: string) => {
      const option = modelOption(label);
      assert(option && !option.disabled, `Missing selectable model ${label}`);
      await act(async () => { option.click(); await tick(); });
    };
    const key = async (name: string, windowsVirtualKeyCode: number) => {
      await act(async () => {
        for (const type of ['keyDown', 'keyUp']) await rendererInput({ type, key: name, code: name, windowsVirtualKeyCode });
      });
    };
    window.workbench = {
      listSkills: async () => [{ id: 'skill', name: 'Skill', path: '/skill', description: '', scope: 'project', editable: true }],
      sendPrompt: async () => { sends++; },
      updateSession: async (_id: string, patch: { modelId?: string | null; settings?: { effort?: string | null; permission?: 'review' | 'read-only' }; skillAssignment?: unknown }) => {
        writes.push(structuredClone(patch));
        if (patch.skillAssignment) return { skillIds: ['skill'], updatedAt: '2026-11-04T01:00:00Z' };
        if (holdWrite) await holdWrite.promise;
        if (failWrite) throw new Error('fixture rejected the session settings');
        const deliver = () => receiveSession(current => ({
          ...current,
          modelId: patch.modelId === undefined ? current.modelId : patch.modelId ?? undefined,
          settings: {
            ...current.settings,
            permission: patch.settings?.permission ?? current.settings?.permission,
            effort: patch.settings?.effort === undefined ? current.settings?.effort : patch.settings.effort ?? undefined,
          },
        }));
        if (delaySnapshot) deliverSnapshot = deliver;
        else deliver();
      },
    } as unknown as Window['workbench'];
    await show();
    const textarea = input('textarea');
    const assertDraft = () => assert(input('textarea') === textarea && textarea.value === draft.text && document.querySelector('.attachments-strip')?.textContent?.includes('note.txt') && draftChanges === 0, 'Session controls replaced or erased the unfinished draft');
    assert(!document.querySelector(`.chat-toolbar button[aria-label="${translate('workspace:chat.settings')}"]`) && !trigger().disabled && !permission().disabled, 'Session controls require opening settings or retain a duplicate settings entry');

    const panel = await open();
    const title = panel.querySelector('h2');
    const originalSlider = slider()!;
    assert(originalSlider && document.activeElement === originalSlider && disclosure().getAttribute('aria-expanded') === 'false', 'The model picker did not start with the current value and effort');
    await expand();
    assert(modelOption('Model A')?.getAttribute('aria-pressed') === 'true', 'The model list does not identify its current selection');
    await key('Escape', 27);
    assert(picker() === panel && document.activeElement === disclosure(), 'Escape from search did not fold the model list');
    await key('Escape', 27);
    await waitFor(() => !picker() && document.activeElement === trigger(), 'Escape did not close the picker and restore trigger focus');
    assert(writes.length === 0, 'Canceling the picker changed a setting');
    await chooseOption(permission(), 'read-only');
    await waitFor(() => !document.querySelector('.composer-select-menu') && document.activeElement === permission(), 'The permissions menu did not restore focus');

    const persistentPanel = await open();
    const persistentTitle = persistentPanel.querySelector('h2');
    const persistentSlider = slider()!;
    const assertStable = (phase: string) => assert(picker() === persistentPanel && picker()?.querySelector('h2') === persistentTitle && slider() === persistentSlider,
      `The ${phase} replaced the open picker (${picker() === persistentPanel}), title (${picker()?.querySelector('h2') === persistentTitle}), or slider (${slider() === persistentSlider})`);
    const track = persistentPanel.querySelector<HTMLElement>('.discrete-slider-track')!;
    const rail = persistentPanel.querySelector<HTMLElement>('.discrete-slider-control')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    assert((getComputedStyle(persistentPanel).animationName === 'none') === reduced, 'Picker motion ignored the system preference');
    const drag = async (type: string, fraction: number) => {
      const bounds = track.getBoundingClientRect();
      await act(async () => {
        await rendererInput({ type, x: bounds.left + bounds.width * fraction, y: bounds.top + bounds.height / 2,
          button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, ...(type === 'mouseMoved' ? { force: .5 } : { clickCount: 1 }) });
      });
    };
    await waitFor(() => !persistentPanel.getAnimations().some(animation => animation.playState === 'running'), 'The picker did not finish opening');
    await drag('mousePressed', .5);
    await waitFor(() => rail.hasAttribute('data-dragging'), 'The slider did not capture the pointer');
    await drag('mouseMoved', .82);
    const percent = () => parseFloat(rail.style.getPropertyValue('--slider-position'));
    await waitFor(() => rail.hasAttribute('data-dragging') && percent() > 79 && percent() < 85,
      () => `The slider did not track the pointer at 82% during drag (position ${percent()}%)`, 10);
    assert(Number(writes.length) === 1, 'The slider saved during a pointer drag');
    assert(getComputedStyle(rail.querySelector('.discrete-slider-thumb')!).transitionDuration === '0s', 'The thumb was eased during a pointer drag');
    holdWrite = deferred<void>();
    await drag('mouseReleased', .82);
    assertStable('pointer release');
    assert(percent() === 100 && !rail.hasAttribute('data-dragging') && Number(writes.length) === 2, 'Pointer release did not snap and commit once');
    await show({ pending: new Set([`session-settings-${session.id}`]) });
    assertStable('pending settings write');
    assert(button('workspace:chat.sendTask').disabled, 'A settings write leaves Send available');
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); });
    assert(sends === 0, 'Enter bypassed the pending settings guard');
    holdWrite.resolve();
    holdWrite = undefined;
    await settle(); await show();
    assert(persistentSlider.getAttribute('aria-valuetext') === translate('workspace:chat.effort.high'), 'The stored effort did not match the slider');

    const search = await expand();
    const catalog = persistentPanel.querySelector('.composer-model-catalog-content')!;
    await frames(2);
    await waitFor(() => [catalog, persistentPanel].every(element => !element.getAnimations().some(animation => animation.playState === 'running')), 'The model picker did not finish expanding');
    const expandedBounds = persistentPanel.getBoundingClientRect();
    await change(search, 'no matching model');
    assert(picker()?.querySelector('.composer-model-empty')?.textContent === translate('workspace:chat.noMatchingModels'), 'The model search did not report no results');
    const filteredBounds = persistentPanel.getBoundingClientRect();
    assert(Math.abs(filteredBounds.height - expandedBounds.height) < 1 && Math.abs(filteredBounds.top - expandedBounds.top) < 1, 'Searching moved or resized the expanded picker');
    await change(search, 'MODEL-B');
    assert(!modelOption('Model A') && modelOption('Alternate'), 'Model search did not filter by model ID');
    holdWrite = deferred<void>();
    delaySnapshot = true;
    await choose('Alternate');
    assertStable('model choice');
    assert(disclosure().getAttribute('aria-expanded') === 'false' && persistentTitle?.textContent?.includes('Alternate'), 'Model selection did not update the title and fold the list');
    const roll = persistentTitle?.querySelector('.ui-rolling-text-entering');
    assert(reduced ? !roll : Boolean(roll), 'The model label did not follow the motion preference');
    holdWrite.resolve();
    holdWrite = undefined;
    await settle();
    assertStable('write acknowledgement before the snapshot');
    assert(persistentTitle?.textContent?.includes('Alternate') && persistentSlider.value === '0' && persistentPanel.getAttribute('aria-busy') === 'true', 'The picker reverted to the previous selection while awaiting the snapshot');
    assert(deliverSnapshot, 'The successful write did not stage a session snapshot');
    const receive = deliverSnapshot;
    delaySnapshot = false;
    await act(async () => { receive(); await tick(); });
    assertStable('model write completion');
    assert(persistentSlider.value === '0' && !persistentPanel.hasAttribute('aria-busy'), 'The snapshot did not settle the picker or clear the incompatible effort');
    await act(async () => { persistentSlider.focus(); });
    await key('ArrowRight', 39); await settle();
    assert(persistentSlider.getAttribute('aria-valuetext') === translate('workspace:chat.effort.low'), 'ArrowRight did not select the next effort');
    await expand(); await choose(translate('workspace:chat.cliDefault')); await settle();
    assertStable('CLI default selection');
    assert(persistentSlider.getAttribute('aria-valuetext') === translate('workspace:chat.effort.low'), 'The CLI default lost a compatible effort');
    await act(async () => { persistentSlider.focus(); });
    await key('Home', 36); await settle();
    assert(persistentSlider.value === '0', 'Home did not restore the runtime default effort');
    await expand(); await choose('Fast model'); await settle();
    assert(picker() === persistentPanel && !slider() && !trigger().querySelector('.composer-model-effort'), 'A model without reasoning support displayed the effort control');
    await expand(); await choose('Fast model'); await settle();
    assert(JSON.stringify(writes) === JSON.stringify([
      { settings: { permission: 'read-only' } }, { settings: { effort: 'high' } },
      { modelId: 'model-b', settings: { effort: null } }, { settings: { effort: 'low' } },
      { modelId: null }, { settings: { effort: null } }, { modelId: 'model-c' },
    ]), `A stale or duplicate setting was sent: ${JSON.stringify(writes)}`);
    await expand();
    holdWrite = deferred<void>();
    failWrite = true;
    await choose('Model A');
    assert(persistentTitle?.textContent?.includes('Model A') && slider(), 'The proposed model was not shown while saving');
    holdWrite.resolve();
    holdWrite = undefined;
    await settle();
    failWrite = false;
    assert(picker() === persistentPanel && persistentTitle?.textContent?.includes('Fast model') && !slider() && !persistentPanel.hasAttribute('aria-busy'), 'The picker retained a rejected model choice');
    assert(errors.pop()?.includes('fixture rejected the session settings'), 'The rejected model change was not reported');
    await key('Escape', 27);
    assertDraft();

    settingsVisible = true; await show();
    assert(!document.querySelector('.session-settings [role=combobox]'), 'Advanced settings duplicate the inline session controls');
    await change(input('.session-skills input'), true); await settle();
    assert(JSON.stringify(writes.at(-1)) === JSON.stringify({ skillAssignment: { skillId: 'skill', enabled: true } }), 'Inline settings changed the separate skill write');
    settingsVisible = false; await show();
    await open();
    await show({ session: { ...configuredSession, status: 'running' } });
    assert(!picker(), 'An open picker remained available after its session started running');
    for (const status of ['running', 'waiting_approval', 'waiting_children', 'queued'] as const) {
      await show({ session: { ...configuredSession, status } });
      assert(trigger().disabled && permission().disabled, `Session controls remain editable during ${status}`);
    }
    for (const pending of [`send-${session.id}`, `session-settings-${session.id}`]) {
      await show({ pending: new Set([pending]) });
      assert(trigger().disabled && permission().disabled, `Session controls remain editable during ${pending}`);
    }
    await show({ pending: new Set(['session-settings-other-session']) });
    assert(!trigger().disabled && !permission().disabled, 'Another session settings write blocks this composer');
    await show({ provider: { ...configuredProvider, capabilities: { ...configuredProvider.capabilities, effort: false, permissions: false } } });
    await open();
    assert(!slider() && !permission() && !trigger().disabled, 'Unsupported runtime controls remain visible');
    await key('Escape', 27);

    await show({ session: { ...configuredSession, modelId: 'legacy-model' } });
    await open(); await expand();
    const legacy = modelOption('legacy-model');
    assert(legacy?.disabled && legacy.getAttribute('aria-pressed') === 'true' && legacy.textContent?.includes(translate('workspace:chat.modelUnavailable')), 'An unavailable legacy model can be selected or lost its label');
    await key('Escape', 27); await key('Escape', 27);
    await show({ session: configuredSession, provider: { ...configuredProvider, models: [], efforts: [] } });
    assert(trigger().disabled && trigger().textContent?.includes(configuredSession.modelId!) && !trigger().querySelector('.composer-model-effort'), 'Missing model catalog hides or enables changing the current model');
    await show({ session: { ...session, settings: undefined }, provider: { ...configuredProvider, models: [], efforts: [] } });
    assert(trigger().disabled && trigger().textContent?.includes(translate('workspace:chat.modelDefault', { provider: configuredProvider.name })), 'Missing model catalog does not preserve the runtime default');
    assertDraft();
    assert(errors.length === 0, errors.join('\n'));
  },
  'UX2-CHAT1: attachment selections keep oversized drafts editable and block invalid sends': async () => {
    const attachment = (index: number, size = 4) => ({ id: `limit-${index}`, name: `file-${index}.txt`, kind: 'text' as const, ownedPath: `/file-${index}.txt`, mimeType: 'text/plain', size, sha256: 'a'.repeat(64) });
    const sends: unknown[] = [];
    let selected: NonNullable<PromptInput['attachments']> = [attachment(3), attachment(4)];
    window.workbench = {
      chooseAttachments: async () => selected,
      sendPrompt: async (_id: string, value: unknown) => { sends.push(value); },
    } as unknown as Window['workbench'];
    const firstDraft = { text: 'Use these files', attachments: [attachment(0), attachment(1), attachment(2)] };
    function EditableChat({ initial = firstDraft }: { initial?: PromptInput }) {
      const [draft, setDraft] = React.useState(initial);
      return chat({ draft, onDraftChange: setDraft });
    }
    await render(<EditableChat />);
    await click('workspace:chat.attach'); await settle();
    assert(document.querySelectorAll('.composer .attachment-chip').length === 5, 'Adding files silently discarded a selected attachment');
    assert(button('workspace:chat.sendTask').disabled, 'Five attached files can still be sent although the runtime accepts only four');
    assert(document.querySelector('.composer-note[role=alert]')?.textContent?.includes('4'), 'The attachment count limit is not explained');
    await act(async () => { input('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); });
    assert(sends.length === 0, 'Enter bypassed the attachment count limit');
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer .attachment-chip button')!.click(); await tick(); });
    assert(!button('workspace:chat.sendTask').disabled && button('workspace:chat.attach').disabled, 'Exactly four attachments do not share the runtime boundary');
    await click('workspace:chat.sendTask'); await settle();
    assert((sends[0] as { attachments: unknown[] }).attachments.length === 4, 'A valid four-file draft changed before sending');
    await render(<div />);
    const image = (index: number) => ({ ...attachment(index, 3 * 1024 * 1024), name: `image-${index}.png`, kind: 'image' as const, mimeType: 'image/png' });
    selected = [image(7)];
    await render(<EditableChat initial={{ text: 'Use larger files', attachments: [image(5), image(6)] }} />);
    await click('workspace:chat.attach'); await settle();
    assert(button('workspace:chat.sendTask').disabled && document.querySelectorAll('.composer .attachment-chip').length === 3, 'Combined attachment bytes are allowed to exceed the runtime limit');
    assert(document.querySelector('.composer-note[role=alert]')?.textContent?.includes('8 MiB'), 'The total byte limit is not explained');
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer .attachment-chip button')!.click(); await tick(); });
    assert(!button('workspace:chat.sendTask').disabled, 'Removing an oversized attachment did not restore sending');
    assert(errors.length === 0, errors.join('\n'));
  },
  'UX2-CHAT2: editing an oversized queued draft requires removing excess files before saving': async () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({ id: `queued-limit-${index}`, name: `file-${index}.txt`, kind: 'text' as const, ownedPath: `/file-${index}.txt`, mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }));
    const writes: unknown[] = [];
    window.workbench = { updateQueuedPrompt: async (_id: string, _itemId: string, value: unknown) => { writes.push(value); } } as unknown as Window['workbench'];
    await render(chat({ session: { ...session, queue: [{ id: 'oversized-queued', commandId: 'queued', input: { text: 'Queued files', attachments }, createdAt: session.createdAt, updatedAt: session.updatedAt }] } }));
    await click('workspace:chat.editQueued');
    assert(button('workspace:chat.saveQueued').disabled, 'Queue edits still submit more attachments than the runtime accepts');
    assert(document.querySelector('.prompt-queue [role=alert]')?.textContent?.includes('4'), 'Queue attachment limit is not explained');
    await act(async () => { document.querySelector<HTMLButtonElement>('.prompt-queue .attachment-chip button')!.click(); await tick(); });
    assert(!button('workspace:chat.saveQueued').disabled, 'A corrected queue draft is still blocked');
    await click('workspace:chat.saveQueued'); await settle();
    assert((writes[0] as { attachments: unknown[] }).attachments.length === 4, 'Saving the corrected queue draft lost an attachment');
  },
  'READ-01: remounting a session preserves the visible message and width reflow keeps it steady': async () => {
    const messages = messageRange(0, 100).map(message => ({ ...message, text: message.text + ' Wide output that wraps at different widths.'.repeat(18) }));
    let current: Session = { ...session, id: 'reading-message', status: 'running', historyLoaded: true, messages, messageCount: 100 };
    window.workbench = {} as Window['workbench'];
    const show = (value = current, width = 740) => render(<React.StrictMode><div style={{ display: 'flex', width, height: 560 }}>
      {React.cloneElement(chat({ session: value }), { key: value.id })}
    </div></React.StrictMode>);
    const scroller = () => document.querySelector<HTMLElement>('.message-scroll')!;
    const visible = () => [...scroller().querySelectorAll<HTMLElement>('.virtual-conversation-row')].find(row =>
      row.getBoundingClientRect().bottom > scroller().getBoundingClientRect().top && row.querySelector('[data-message-id]'));
    const readOffset = (row: Element) => row.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
    const readAt = async (top: number) => { await act(async () => {
      scroller().dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      scroller().scrollTop = top;
      scroller().dispatchEvent(new Event('scroll'));
      await tick();
    }); await frames(4); };
    await show(); await frames();
    await readAt(scroller().scrollHeight / 2);
    await readAt(scroller().scrollTop - 90);
    const anchor = visible();
    assert(anchor, 'No message was visible before switching');
    const id = anchor.querySelector<HTMLElement>('[data-message-id]')!.dataset.messageId;
    const offset = readOffset(anchor);
    const target = () => document.querySelector(`[data-message-id="${id}"]`)?.closest('.virtual-conversation-row');
    const nearAnchor = () => Boolean(target() && Math.abs(readOffset(target()!) - offset) < 4);
    await show({ ...session, id: 'reading-other' });
    await show({ ...current, messages: [], historyLoaded: false }, 680);
    await show(current, 680);
    await waitFor(nearAnchor, () => `Returning to the session moved ${id} (${offset} → ${target() && readOffset(target()!)})`);
    await frames(4);
    await readAt(scroller().scrollTop + 15);
    await readAt(scroller().scrollTop - 15);
    const priorHeight = target()!.getBoundingClientRect().height;
    await show(current, 550); await frames(6);
    assert(nearAnchor() && target()!.getBoundingClientRect().height > priorHeight, `Width reflow moved ${id} (${offset} → ${target() && readOffset(target()!)}) or did not rewrap it`);
    current = { ...current, messages: [...current.messages, ...messageRange(100, 102)], messageCount: 102 };
    await show(current, 550); await frames(5);
    assert(nearAnchor(), 'Appended output moved an unpinned reader');
    await readAt(scroller().scrollHeight);
    assert(scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 40, 'The session was not at the bottom before switching');
    await show({ ...session, id: 'reading-other' });
    current = { ...current, messages: [...current.messages, ...messageRange(102, 103)], messageCount: 103 };
    await show(current, 550);
    await waitFor(() => scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 40
      && Boolean(document.querySelector('[data-message-id="message-102"]')), 'A session left at the bottom did not follow new output on return');
  },
  'READ-02: an unloaded Trace event and its offset are restored through one history window': async () => {
    const events: Message[] = Array.from({ length: 100 }, (_, index) => ({
      id: `reading-tool-${index}`, role: 'activity', text: `Tool ${index}`, createdAt: session.createdAt,
      event: { id: `reading-tool-${index}`, kind: 'tool', title: `Tool ${index}`, status: 'completed', output: 'Original tool output' },
    }));
    let current: Session = { ...session, id: 'reading-trace', status: 'running', historyLoaded: true, messages: events, messageCount: 100 };
    const around: { id: string; limit: number }[] = [];
    window.workbench = {
      sessionHistoryAround: async (_sessionId: string, id: string, limit: number) => {
        around.push({ id, limit });
        return { messages: events, hasMore: false, hasAfter: true, afterCursor: events.at(-1)!.id };
      },
    } as unknown as Window['workbench'];
    const show = (value = current) => render(<React.StrictMode><div style={{ display: 'flex', width: 700, height: 560 }}>
      {React.cloneElement(chat({ session: value }), { key: value.id })}
    </div></React.StrictMode>);
    const scroller = () => document.querySelector<HTMLElement>('.message-scroll')!;
    const relativeTop = (row: Element) => row.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
    await show(); await frames();
    await act(async () => {
      scroller().dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      scroller().scrollTop = 1265;
      scroller().dispatchEvent(new Event('scroll'));
      await tick();
    });
    await frames(5);
    const anchor = [...scroller().querySelectorAll<HTMLElement>('.virtual-conversation-row')].find(row =>
      row.getBoundingClientRect().bottom > scroller().getBoundingClientRect().top && row.querySelector('.message-process'));
    assert(anchor, 'No Trace event was visible before switching');
    const id = anchor.querySelector<HTMLElement>('[data-message-id]')!.dataset.messageId;
    const offset = relativeTop(anchor);
    await show({ ...session, id: 'reading-trace-other' });
    current = { ...current, status: 'completed', messages: messageRange(100, 200), messageCount: 200, historyCursor: 'message-100' };
    await show();
    const target = () => document.querySelector(`[data-message-id="${id}"]`)?.closest('.virtual-conversation-row');
    await waitFor(() => Boolean(target() && Math.abs(relativeTop(target()!) - offset) < 4), () => `The old Trace event ${id} did not return to its prior offset (${offset} → ${target() && relativeTop(target()!)})`);
    assert(around.length === 1 && around[0].id === id && around[0].limit === 100, 'Restoring a Trace did not use one bounded lookup');
    assert(document.querySelector('.conversation-history-controls')?.textContent?.includes(translate('workspace:chat.historyWindow')), 'Restoring an unloaded event did not enter the historical window');
    await frames(3);
    await show({ ...session, id: 'reading-trace-other' });
    await show();
    await waitFor(() => Boolean(target() && Math.abs(relativeTop(target()!) - offset) < 4), 'Switching away from a historical window discarded its anchor');
    assert(Number(around.length) === 2 && around[1].id === id, 'A second remount did not reuse the historical event');
    await click('workspace:chat.returnLatest');
    await waitFor(() => Boolean(document.querySelector('[data-message-id="message-199"]')), 'Returning to latest did not leave the restored historical window');
  },
  'TURN-DIFF-01: a folded Trace opens the runtime patch for its own turn': async () => {
    const output = 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after';
    const show = (patch: string) => render(chat({ session: { ...session, id: 'turn-diff-session', status: 'completed',
      messages: [{ id: 'turn-diff-event', text: 'Turn diff', role: 'activity', createdAt: session.createdAt,
        event: { id: 'native-diff', kind: 'diff', title: 'Turn diff', status: 'completed', output: patch } }],
    } }));
    await show(output);
    await waitFor(() => Boolean(document.querySelector('.trace-diff')), 'The collapsed Trace did not expose its diff action');
    assert(!document.querySelector('[data-message-id="turn-diff-event"]'), 'The completed Trace did not start folded');
    await click('workspace:chat.trace.turnDiff');
    const row = () => document.querySelector('[data-message-id="turn-diff-event"] .process-reveal[data-expanded=true]');
    await waitFor(() => Boolean(row()?.querySelector('.turn-diff-patch')), 'The turn patch did not open inside its Trace');
    assert(row()?.querySelector('.removed')?.textContent?.trim() === '-before'
      && row()?.querySelector('.added')?.textContent?.trim() === '+after', 'The patch did not distinguish deleted and added lines');
    await show('');
    assert(row()?.textContent?.includes(translate('workspace:chat.trace.turnDiffEmpty')), 'An empty native update left a stale patch visible');
  },
  'TRACE-01: live events enter once, update in place and keep manual choices': async () => {
    const tool = (id: string, title: string, status: NonNullable<Message['event']>['status'], input?: string, output?: string): Message => ({
      id, role: 'activity', text: title, createdAt: session.createdAt, event: { id, kind: 'tool', title, status, input, output },
    });
    const archived = tool('trace-old', 'Archived call', 'completed');
    const ongoing = tool('trace-stable', 'Existing command', 'running', 'cat file');
    const incoming = tool('trace-new', 'New command', 'failed', 'read config', 'Permission denied');
    let current: Session = { ...session, id: 'trace-live-session', status: 'running', messages: [archived, ...messageRange(0, 1), ongoing] };
    const show = () => render(chat({ session: current }), 'user');
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    const controls = () => [...document.querySelectorAll<HTMLButtonElement>('.trace-toggle')];
    const toggle = async (element: HTMLButtonElement) => { await act(async () => { element.click(); await tick(); }); };
    window.workbench = {} as Window['workbench'];
    await show(); await frames();
    assert(controls().map(item => item.getAttribute('aria-expanded')).join(',') === 'false,true', 'Text did not separate folded history and the active trace');
    assert(!row(archived.id) && !row(ongoing.id)?.querySelector('.trace-event-enter'), 'History mounted folded events or replayed their arrival');
    const stableRow = row(ongoing.id);
    await toggle(stableRow!.querySelector('button')!);
    assert(stableRow?.querySelector('.process-reveal[data-expanded="true"] pre')?.textContent === 'cat file', 'The tool input was not available in place');
    current = { ...current, messages: [archived, current.messages[1], tool(ongoing.id, ongoing.text, 'completed', 'cat file', 'file contents'), incoming] };
    await show();
    assert(row(ongoing.id) === stableRow && !stableRow.querySelector('.trace-event-enter') &&
      stableRow.querySelector('.process-output:last-child pre')?.textContent === 'file contents', 'An event update replaced its row, replayed arrival, or hid the output');
    const arrival = row(incoming.id)?.querySelector<HTMLElement>('.trace-event-enter');
    assert(arrival, 'A new live event did not enter');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    assert(getComputedStyle(arrival).animationName === (reduce ? 'none' : 'trace-event-enter'), 'Event arrival did not honor reduced motion');
    assert(Boolean(document.querySelector('.trace-count .ui-rolling-text-change')) === !reduce, 'The live count did not honor motion preference');
    current = { ...current, status: 'completed' };
    await show(); await frames();
    assert(controls().every(item => item.getAttribute('aria-expanded') === 'false') && !row(incoming.id), 'Completed traces did not fold');
    await toggle(document.querySelector<HTMLButtonElement>('.trace-failure')!);
    await waitFor(() => Boolean(row(incoming.id)?.classList.contains('conversation-match')), 'The failure summary did not locate its event');
    assert(row(incoming.id)?.querySelector('.process-reveal[data-expanded="true"] pre:last-child')?.parentElement?.parentElement?.textContent?.includes('Permission denied'), 'The failed event did not expose the provider output');
    await render(<div />); await show(); await frames();
    assert(controls().at(-1)?.getAttribute('aria-expanded') === 'true' && !row(incoming.id)?.querySelector('.trace-event-enter'), 'Returning to the session lost the manual choice or replayed history');
    await toggle(controls().at(-1)!);
    current = { ...current, status: 'running' };
    await show();
    assert(controls().at(-1)?.getAttribute('aria-expanded') === 'false', 'The live default overrode a manual fold');
    const firstNew = tool('trace-late-1', 'More work', 'running');
    const secondNew = tool('trace-late-2', 'More work', 'running');
    current = { ...current, messages: [incoming, firstNew, secondNew] };
    await show();
    current = { ...current, messages: [firstNew, secondNew, tool('trace-late-3', 'More work', 'running')] };
    await show();
    await render(<div />); await show(); await frames();
    assert(controls().at(-1)?.getAttribute('aria-expanded') === 'false', 'The choice was lost after its original event left the live window');
    await toggle(controls().at(-1)!);
    const appended = Array.from({ length: 90 }, (_, index) => tool(`trace-batch-${index}`, `Step ${index}`, 'completed'));
    current = { ...current, messages: [...current.messages, ...appended] };
    await show();
    const scroll = document.querySelector<HTMLElement>('.message-scroll')!;
    await waitFor(() => Boolean(row(appended.at(-1)!.id)) && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 40,
      'An expanded live trace lost bottom pinning when events were appended');
    assert(document.querySelectorAll('.message-process').length < 50, 'The active trace mounted events outside the virtual range');
  },
  'TRACE-02: search reveals the exact paged event and keeps a long trace virtualized': async () => {
    const events: Message[] = Array.from({ length: 150 }, (_, index) => ({
      id: `paged-event-${index}`, role: 'activity', text: `Call ${index}`, createdAt: session.createdAt,
      event: { id: `call-${index}`, kind: 'tool', title: `Call ${index}`, status: 'completed', output: index === 70 ? 'A searchable result' : undefined },
    }));
    const match = events[70];
    const selector = `[data-message-id="${match.id}"]`;
    const latest: Session = { ...session, id: 'trace-search-session', status: 'completed', historyLoaded: true,
      messages: messageRange(300, 301), historyCursor: 'latest', messageCount: 151 };
    window.workbench = {
      sessionSearch: async () => ({ messages: [{ id: match.id, role: match.role, createdAt: match.createdAt, text: match.event!.output }], truncated: false }),
      sessionHistoryAround: async () => ({ messages: events.slice(50), beforeCursor: 'paged-event-50', hasMore: true, hasAfter: false }),
      sessionHistory: async () => ({ messages: events.slice(0, 50), hasMore: false }),
    } as unknown as Window['workbench'];
    await render(chat({ session: latest }));
    await click('workspace:chat.find');
    await change(input('.conversation-find input'), 'searchable result');
    await waitFor(() => Boolean(document.querySelector(`${selector}.conversation-match .process-reveal[data-expanded="true"]`)), 'Search did not reveal the exact historical event');
    await frames(5);
    const scroll = document.querySelector<HTMLElement>('.message-scroll')!;
    const event = document.querySelector<HTMLElement>(selector)!;
    const before = event.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    assert(before >= 0 && before < scroll.clientHeight && event.textContent?.includes('A searchable result'), 'The search match was outside the viewport or its output was hidden');
    await click('workspace:chat.loadEarlier'); await frames(5);
    const after = event.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    assert(document.querySelector(selector) === event && Math.abs(before - after) < 4, `Prepending a trace fragment moved the search target (${before} → ${after})`);
    assert(document.querySelectorAll('.message-process').length < 50, 'Expanding a long trace mounted every event');
    await act(async () => { scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll')); await tick(); });
    await frames();
    assert(document.querySelectorAll('.trace-heading').length === 1 && document.querySelector('.trace-count')?.textContent?.includes('150'),
      'A process group was split at a history page boundary');
    assert(!document.querySelector('.trace-event-enter, .trace-count .ui-rolling-text-change'), 'Loading historical events replayed live motion');
  },
  'CHAT-01: latest output leaves a search history window and resumes the live tail': async () => {
    const match = { ...messageRange(300, 301)[0], text: 'Needle in historical output' };
    const liveMatch = { ...messageRange(950, 951)[0], text: 'Live output [Details](https://example.com/details)' };
    window.workbench = {
      sessionSearch: async (_id: string, query: string) => ({ messages: [query === 'Needle' ? match : liveMatch], truncated: false }),
      sessionHistoryAround: async () => {
        await new Promise(resolve => window.setTimeout(resolve, 250));
        const scroll = document.querySelector<HTMLDivElement>('.message-scroll')!;
        scroll.scrollTop = scroll.scrollHeight;
        scroll.dispatchEvent(new Event('scroll'));
        return { messages: messageRange(250, 350).map(message => message.id === match.id ? match : message),
          beforeCursor: '250', hasMore: true, afterCursor: '350', hasAfter: true };
      },
    } as unknown as Window['workbench'];
    let current: Session = { ...session, messages: messageRange(900, 1000).map(message => message.id === liveMatch.id ? liveMatch : message), messageCount: 1000, historyCursor: '900', historyLoaded: true };
    await render(chat({ session: current })); await frames(); await click('workspace:chat.find');
    await change(input('.conversation-find input'), 'Needle');
    await waitFor(() => Boolean(document.querySelector('[data-message-id="message-300"].conversation-match')), 'Search did not enter the historical window');
    await frames(5);
    await click('workspace:chat.latestOutput');
    await waitFor(() => Boolean(document.querySelector('[data-message-id="message-999"]')), 'Latest output remained in the historical search window');
    await waitFor(() => !document.querySelector('.conversation-find') && !document.querySelector('.conversation-history-controls')?.textContent?.includes(translate('workspace:chat.historyWindow')), 'Returning to live output retained the historical search state');
    for (const [index, intent] of ['pointer', 'keyboard'].entries()) {
      await click('workspace:chat.find'); await change(input('.conversation-find input'), 'Live');
      await waitFor(() => Boolean(document.querySelector('[data-message-id="message-950"].conversation-match')), 'The live search match was not positioned');
      await frames();
      const scroll = document.querySelector<HTMLDivElement>('.message-scroll')!;
      await act(async () => {
        if (intent === 'pointer') scroll.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
        else {
          const link = document.querySelector<HTMLAnchorElement>('[data-message-id="message-950"] a')!;
          link.focus(); link.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        }
        scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event('scroll')); await tick();
      });
      await frames(10);
      await act(async () => { scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event('scroll')); await tick(); });
      await click('workspace:chat.closeFind');
      current = { ...current, messages: [...current.messages, ...messageRange(1000 + index, 1001 + index)], messageCount: 1001 + index };
      await render(chat({ session: current }));
      await waitFor(() => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 40
        && Boolean(document.querySelector(`[data-message-id="message-${1000 + index}"]`)), () => `${intent} scrolling to the bottom did not restore live following: ${JSON.stringify({ top: scroll.scrollTop, height: scroll.scrollHeight, client: scroll.clientHeight, tail: Boolean(document.querySelector(`[data-message-id="message-${1000 + index}"]`)), history: document.querySelector('.conversation-history-controls')?.textContent })}`);
    }
  },
  'CHAT-02: draft edits and streaming keep formatted output and focused links mounted': async () => {
    window.workbench = {} as Window['workbench'];
    let current: Session = { ...session, status: 'running', messages: [{ id: 'formatted-answer', role: 'assistant',
      text: '# A plan\n\n[Project documentation](https://example.com/docs)\n\n| Step | State |\n| --- | --- |\n| Design | Complete |\n\n- [x] Approved\n- [ ] Build\n\n```ts\nconst value = 1;\n```', createdAt: session.createdAt }] };
    await render(chat({ session: current })); await frames();
    const link = document.querySelector<HTMLAnchorElement>('.markdown-message a')!;
    const code = document.querySelector('.markdown-message pre')!;
    assert(link && code && document.querySelector('.markdown-message table'), 'The formatted reply was not rendered');
    await render(chat({ session: current, draft: { text: 'A new question' } }));
    assert(document.querySelector('.markdown-message a') === link && document.querySelector('.markdown-message pre') === code, 'Typing in the composer remounted the existing formatted reply');
    link.focus();
    current = { ...current, messages: current.messages.map(message => ({ ...message, text: `${message.text}\n\nStreaming continuation.` })) };
    await render(chat({ session: current, draft: { text: 'A new question' } })); await frames();
    assert(document.querySelector('.markdown-message a') === link && document.activeElement === link, 'Streaming replaced the focused link');
    assert(document.querySelector('.markdown-message')?.textContent?.includes('Streaming continuation.'), 'Memoized output dropped a streamed update');
  },
  'UI-06: paged variable-height messages preserve the reading anchor and concurrent live output': async () => {
    const gate = deferred<{ messages: Message[]; beforeCursor?: string; hasMore: boolean }>();
    let requests = 0;
    window.workbench = { sessionHistory: async (_id: string, before: string, limit: number) => {
      assert(limit === 100, 'History exceeded the bounded page size');
      requests++;
      if (requests === 1) return gate.promise;
      const end = Number(before), start = Math.max(0, end - limit);
      return { messages: messageRange(start, end), beforeCursor: start ? String(start) : undefined, hasMore: start > 0 };
    } } as unknown as Window['workbench'];
    let current: Session = { ...session, messages: messageRange(900, 1000), messageCount: 1000, historyCursor: '900', historyLoaded: true };
    const show = () => render(chat({ session: current }));
    await show(); await frames();
    const scroll = document.querySelector<HTMLDivElement>('.message-scroll')!;
    await act(async () => { scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll')); await tick(); });
    await frames();
    const anchor = [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find(element => element.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top)!;
    assert(anchor, 'The initial history viewport was empty');
    const anchorId = anchor.dataset.messageId!, anchorTop = anchor.getBoundingClientRect().top;
    await click('workspace:chat.loadEarlier');
    current = { ...current, messages: messageRange(901, 1001), messageCount: 1001, historyCursor: '901' };
    await show();
    await act(async () => { gate.resolve({ messages: messageRange(800, 900), beforeCursor: '800', hasMore: true }); await tick(); });
    await frames(5);
    const restored = document.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
    assert(restored && Math.abs(restored.getBoundingClientRect().top - anchorTop) < 4, `Prepending history moved the reading anchor (${anchorTop} → ${restored?.getBoundingClientRect().top})`);
    for (let index = 0; index < 8; index++) { await click('workspace:chat.loadEarlier'); await frames(2); }
    assert(document.querySelectorAll('[data-message-id]').length < 50, 'Loaded history mounted every message instead of virtualizing');
    await click('workspace:chat.latestOutput');
    await waitFor(() => Boolean(document.querySelector('[data-message-id="message-1000"]')), () => `Jump to latest did not reach the virtual tail: ${JSON.stringify({ top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.clientHeight, mounted: [...document.querySelectorAll<HTMLElement>('[data-message-id]')].map(element => element.dataset.messageId) })}`, 180);
    await frames(5);
    assert(document.querySelector('[data-message-id="message-1000"]'), 'A history response dropped concurrent live output');
    current = { ...current, messages: current.messages.map(message => message.id === 'message-1000' ? { ...message, text: `${message.text}\n\n${'Streamed text. '.repeat(100)}` } : message) };
    await show(); await frames(5);
    assert(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 41, 'Streaming variable-height output lost bottom pinning');
    assert(errors.length === 0, errors.join('\n'));
  },
  'UI-07: search locates an unloaded message without fetching intervening history': async () => {
    let around = 0, earlier = 0, later = 0;
    const match = { ...messageRange(300, 301)[0], text: 'Needle in an old conversation' };
    window.workbench = {
      sessionSearch: async () => ({ messages: [match], truncated: false }),
      sessionHistoryAround: async (_id: string, id: string, limit: number) => {
        around++; assert(id === match.id && limit === 100, 'Search requested the wrong window');
        return { messages: messageRange(250, 350).map(message => message.id === match.id ? match : message), beforeCursor: '250', hasMore: true, afterCursor: '350', hasAfter: true };
      },
      sessionHistory: async () => { earlier++; return { messages: [], hasMore: false }; },
      sessionHistoryAfter: async () => { later++; return { messages: messageRange(350, 450), hasMore: true, afterCursor: '450', hasAfter: true }; },
    } as unknown as Window['workbench'];
    let current: Session = { ...session, messages: messageRange(900, 1000), messageCount: 1000, historyCursor: '900', historyLoaded: true };
    const show = () => render(chat({ session: current }));
    await show(); await frames(); await click('workspace:chat.find');
    await change(input('.conversation-find input'), 'Needle');
    await waitFor(() => Boolean(document.querySelector('[data-message-id="message-300"].conversation-match')), 'The unloaded search result was not mounted');
    await frames(5);
    const scroll = document.querySelector('.message-scroll')!.getBoundingClientRect();
    const target = document.querySelector('[data-message-id="message-300"]')!.getBoundingClientRect();
    assert(target.bottom > scroll.top && target.top < scroll.bottom, 'Search did not scroll the virtual list to its result');
    assert(around === 1 && earlier === 0, 'Search downloaded all intervening pages');
    await click('workspace:chat.loadLater'); await frames();
    assert(later === 1, 'The historical window cannot page forward');
    current = { ...current, messages: messageRange(901, 1001), messageCount: 1001, historyCursor: '901' };
    await show(); await frames();
    assert(document.querySelector('[data-message-id="message-300"]') && !document.querySelector('[data-message-id="message-1000"]'), 'Live output pulled the reader out of history');
    await click('workspace:chat.returnLatest'); await frames(5);
    assert(document.querySelector('[data-message-id="message-1000"]'), 'Returning to latest lost the live tail');
  },
  'UI-08: queued sends reuse an uncertain command and preserve composition and later drafts': async () => {
    const gate = deferred<void>(), laterGate = deferred<void>();
    const sends: { id?: string; input: unknown }[] = [], edits: unknown[] = [], removals: string[] = [], pauses: boolean[] = [];
    const draft = { text: 'Next task' };
    let cleared = 0;
    window.workbench = {
      sendPrompt: async (_id: string, input: unknown, id?: string) => { sends.push({ id, input }); if (sends.length === 1) await gate.promise; if (sends.length === 3) await laterGate.promise; },
      updateQueuedPrompt: async (_id: string, item: string, input: unknown) => { edits.push({ item, input }); },
      removeQueuedPrompt: async (_id: string, item: string) => { removals.push(item); },
      setSessionQueuePaused: async (_id: string, paused: boolean) => { pauses.push(paused); },
    } as unknown as Window['workbench'];
    const queued: Session = { ...session, status: 'running', queue: [{ id: 'queued-a', commandId: 'first', input: { text: 'Queued before' }, createdAt: session.createdAt, updatedAt: session.updatedAt }] };
    const show = (value = queued, currentDraft = draft) => render(chat({ session: value, draft: currentDraft, onDraftChange: value => { if (!value.text) cleared++; } }));
    await show();
    assert(!button('workspace:chat.sendTask').disabled && document.querySelector('.composer-caption')?.textContent?.includes('Queue for next turn'), 'A running session does not expose a truthful next-turn send');
    await act(async () => {
      input('.composer textarea').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
      input('.composer textarea').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await tick();
    });
    assert(sends.length === 0, 'IME confirmation submitted a task');
    await click('workspace:chat.sendTask'); await waitFor(() => sends.length === 1, 'The queued send did not start');
    await act(async () => { gate.reject(new Error('response lost')); await tick(); }); await settle();
    assert(cleared === 0 && input('.composer textarea').value === draft.text, 'An uncertain send erased the draft');
    await click('workspace:chat.sendTask'); await settle();
    assert(sends[0].id && sends[0].id === sends[1].id && Number(cleared) === 1, 'Retry did not reuse the original command identity');
    await show(); await click('workspace:chat.sendTask'); await waitFor(() => sends.length === 3, 'A new send did not start');
    await show(queued, { text: 'A later draft while awaiting the send' });
    await act(async () => { laterGate.resolve(); await tick(); }); await settle();
    assert(Number(cleared) === 1 && input('.composer textarea').value === 'A later draft while awaiting the send', 'An older send response cleared a later draft');
    assert(sends[2].id !== sends[1].id, 'A new intentional send reused the completed command');
    await click('workspace:chat.editQueued'); await change(input('.prompt-queue textarea'), 'Edited next task'); await click('workspace:chat.saveQueued'); await settle();
    assert(JSON.stringify(edits) === JSON.stringify([{ item: 'queued-a', input: { text: 'Edited next task' } }]), 'Editing a queue item sent the wrong input');
    await click('workspace:chat.pauseQueue'); await settle();
    await show({ ...queued, queuePaused: true, queueHoldReason: 'Task stopped' }); await click('workspace:chat.resumeQueue'); await settle();
    await click('workspace:chat.removeQueued'); await settle();
    assert(JSON.stringify(pauses) === '[true,false]' && removals[0] === 'queued-a', 'Queue pause, resume or removal did not use its persisted item identity');
    await show({ ...queued, historyLoaded: false });
    assert(input('.composer textarea').disabled && button('workspace:chat.sendTask').disabled, 'A summary-only session can overwrite the unloaded server draft');
    assert(document.querySelector('.conversation-history-controls [role=status]')?.textContent === translate('workspace:chat.loadingHistory'), 'The disabled composer is missing its history loading status');
    await show(queued, { text: 'A newer draft' });
    assert(input('.composer textarea').value === 'A newer draft', 'Queue updates replaced the composer draft');
    await show({ ...queued, messages: [
      { id: 'plan', role: 'activity', text: 'Plan', createdAt: session.createdAt,
        event: { id: 'plan', kind: 'plan', title: 'Plan', status: 'running', entries: [{ text: 'Review output', status: 'running' }] } },
      { id: 'agent', role: 'activity', text: 'Reviewer', createdAt: session.createdAt,
        event: { id: 'agent', kind: 'subagent', nativeId: 'reviewer', title: 'Reviewer', status: 'running' } },
    ] });
    const composerInput = input('.composer textarea');
    await click('workspace:chat.editQueued');
    const queueInput = input('.prompt-queue textarea');
    await change(queueInput, 'A queue edit in progress');
    const openDockSection = async (section: string) => {
      const toggle = document.querySelector<HTMLButtonElement>(`.composer-dock button[aria-controls$="-${section}"]`);
      assert(toggle, `Missing composer dock section ${section}`);
      await act(async () => { toggle.click(); await tick(); });
      const region = document.getElementById(toggle.getAttribute('aria-controls')!);
      assert(region && !region.inert, `Composer dock section ${section} did not expand`);
      return region;
    };
    assert((await openDockSection('plan')).textContent?.includes('Review output'), 'The current plan is missing from the composer');
    assert((await openDockSection('agents')).textContent?.includes('Reviewer'), 'A running native agent is missing from the composer');
    await openDockSection('queue');
    assert(input('.composer textarea') === composerInput && input('.prompt-queue textarea') === queueInput
      && queueInput.value === 'A queue edit in progress', 'Switching the dock moved the composer or discarded a queue edit');
    const agent = { id: 'outside-tail', kind: 'subagent', nativeId: 'outside-native', title: 'Agent outside the tail', status: 'running' } as const;
    window.workbench.sessionHistoryAround = async (sessionId, messageId) => {
      assert(sessionId === queued.id && messageId === 'old-agent', 'Opening an older agent used the wrong history anchor');
      return { messages: [{ id: messageId, role: 'activity', createdAt: session.createdAt, text: agent.title, event: agent }], hasMore: true, hasAfter: true };
    };
    await show({ ...queued, composerActivity: { plan: [], agents: [{ ...agent, messageId: 'old-agent' }] } });
    const oldAgentButton = (await openDockSection('agents')).querySelector('button');
    assert(oldAgentButton, 'An agent outside the tail has no detail entry');
    await act(async () => { oldAgentButton.click(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.native-agent-events')), 'An agent outside the tail could not open its details');
    await show({ ...session, queue: [] });
    assert(!document.querySelector('.composer-dock'), 'An empty session displays a composer dock');
  },
  'FILE-PANE-WIDTH: the divider follows the pointer and restores the preferred width and selected file': async () => {
    const snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [session], providers: [provider],
      workspaces: [{ ...workspace, tabs: [{ kind: 'agent', id: 'file-pane-tab', sessionId: session.id }], activeTabId: 'file-pane-tab' }] };
    const file = { path: 'pane.txt', name: 'pane.txt', kind: 'file', size: 7 };
    let reads = 0;
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: () => () => {},
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [file], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      readFile: async () => { reads++; return { ...file, content: 'fixture', revision: 'r0', language: 'text' }; },
    } as unknown as Window['workbench'];
    const storageKey = 'ensemble.file-pane-width';
    const previous = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    try {
      await render(<App />, 'user');
      const host = document.querySelector<HTMLElement>('.workbench')!.parentElement!;
      const resizeWindow = async (width: number) => {
        await act(async () => { host.style.width = `${width}px`; await tick(); });
      };
      await resizeWindow(1440);
      await click(file.name);
      await waitFor(() => Boolean(document.querySelector('[data-test-editor]')), 'The file did not open');
      const editor = input('[data-test-editor]');
      const pane = document.querySelector<HTMLDivElement>('.file-panel-transition')!;
      const content = pane.querySelector<HTMLElement>('.file-pane-content')!;
      const divider = pane.querySelector<HTMLDivElement>('[role=separator]')!;
      const width = () => pane.getBoundingClientRect().width;
      const centerWidth = () => document.querySelector('.workspace-center')!.getBoundingClientRect().width;
      const columnsWidth = () => document.querySelector('.workspace-columns')!.getBoundingClientRect().width;
      await waitFor(() => Number(divider.getAttribute('aria-valuemax')) === 640 && width() > 0, 'The resized fixture did not settle');
      const x = Math.round(pane.getBoundingClientRect().left);
      const initialWidth = width();
      let captured = 0;
      divider.setPointerCapture = pointerId => { captured = pointerId; };
      const pointer = (type: string, clientX: number) => act(async () => {
        divider.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 3, pointerType: 'mouse', button: 0, clientX }));
        await tick();
      });
      await pointer('pointerdown', x);
      await pointer('pointermove', x - 80);
      assert(captured === 3 && width() === initialWidth + 80 && centerWidth() === columnsWidth() - width(), 'Dragging did not lay out both panes at the pointer width');
      await pointer('pointermove', x - 1500);
      assert(width() === Number(divider.getAttribute('aria-valuemax')) && centerWidth() >= 560, 'Dragging squeezed the workspace past its minimum');
      assert(localStorage.getItem(storageKey) === null, 'A pointer move wrote the preference');
      await pointer('pointercancel', x - 1500);
      assert(width() === initialWidth && localStorage.getItem(storageKey) === null, 'Cancel retained an unfinished drag');
      await pointer('pointerdown', x);
      await pointer('pointermove', x - 140);
      await pointer('pointerup', x - 140);
      const draggedWidth = initialWidth + 140;
      assert(width() === draggedWidth && localStorage.getItem(storageKey) === String(draggedWidth), 'Releasing the divider did not remember its position');

      await act(async () => { divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); await tick(); });
      const savedWidth = draggedWidth + 24;
      assert(width() === savedWidth && localStorage.getItem(storageKey) === String(savedWidth), 'The keyboard did not resize and save the panel');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        assert(getComputedStyle(content).transitionDuration === '0s', 'Reduced motion left a panel animation enabled');
      } else {
        assert(getComputedStyle(content).transitionProperty === 'opacity', 'The panel animates properties that can change layout');
      }
      await click('shell:app.hideFiles');
      assert(width() === 0 && centerWidth() === columnsWidth() && pane.inert, 'Closing the panel did not immediately release its layout width');
      assert(content.getBoundingClientRect().width === savedWidth && input('[data-test-editor]') === editor, 'Closing reflowed or replaced the file editor');
      await click('shell:app.showFiles');
      assert(width() === savedWidth && centerWidth() === columnsWidth() - savedWidth, 'Opening did not immediately restore the target layout');
      await resizeWindow(1150);
      await waitFor(() => width() > 0 && width() < savedWidth, 'The panel did not clamp to the available workspace width');
      await act(async () => { editor.focus(); await tick(); });
      await resizeWindow(1040);
      await waitFor(() => pane.inert && width() === 0, 'A window with insufficient width left the panel visible');
      assert(document.querySelector('.file-pane-space-note')?.textContent === translate('shell:app.filesNeedSpace')
        && document.activeElement === button('shell:app.hideFiles'), 'The collapsed panel lost its reason or keyboard focus');
      assert(localStorage.getItem(storageKey) === String(savedWidth), 'Narrowing the window overwrote the preferred width');
      await resizeWindow(1440);
      await waitFor(() => width() === savedWidth, 'Expanding the window did not restore the preferred width');
      assert(!pane.inert && input('[data-test-editor]') === editor && document.querySelector('.tree-row.selected')?.textContent?.includes(file.name)
        && reads === 1, 'Auto-hiding replaced the selected file or read it again');
      await click('shell:app.hideFiles');
      await resizeWindow(1040);
      await resizeWindow(1440);
      await frames();
      assert(width() === 0 && pane.inert, 'Resizing opened a panel the user had closed');

      await render(<div />);
      await render(<App />, 'user');
      await waitFor(() => document.querySelector('.file-panel-transition')?.getBoundingClientRect().width === savedWidth, 'Reopening Ensemble did not read the width preference');
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  },
  'UX2-SHELL: add-tab menus remain inside the workspace at both ends of the tab strip': async () => {
    const values = Array.from({ length: 12 }, (_, index) => ({ ...session, id: `menu-${index}`, title: `Independent task ${index}` }));
    const tabs = values.map(value => ({ id: `tab-${value.id}`, kind: 'agent' as const, sessionId: value.id }));
    let snapshot: Snapshot = { version: 1, sessions: values, providers: [provider], workspaces: [{ ...workspace, tabs, activeTabId: tabs[0].id }], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    let publish!: (value: Snapshot) => void;
    window.workbench = {
      snapshot: async () => snapshot, subscribe: (listener: (value: Snapshot) => void) => { publish = listener; return () => {}; },
      ...applicationUpdateApi,
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    await render(<App />);
    await frames(); await click('shell:app.hideFiles');
    document.querySelector<HTMLElement>('.workbench')!.parentElement!.style.width = `${window.innerWidth}px`;
    await waitFor(() => document.querySelector('.file-panel-transition')!.getBoundingClientRect().width < 1, 'The file panel did not finish closing');
    const checkMenu = async () => {
      await click('shell:app.addTab'); await frames();
      const menu = document.querySelector<HTMLElement>('.tab-menu')!.getBoundingClientRect();
      const bounds = document.querySelector<HTMLElement>('.main-workspace')!.getBoundingClientRect();
      assert(menu.left >= bounds.left && menu.right <= bounds.right, `Add-tab menu is clipped (${menu.left}..${menu.right}, workspace ${bounds.left}..${bounds.right})`);
      assert(document.activeElement?.getAttribute('role') === 'menuitem', 'Opening the menu lost its keyboard focus');
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); });
      assert(document.activeElement === button('shell:app.addTab'), 'Closing the menu did not restore trigger focus');
    };
    await checkMenu();
    snapshot = { ...snapshot, workspaces: [{ ...snapshot.workspaces[0], tabs: tabs.slice(0, 1) }] };
    await act(async () => { publish(snapshot); await tick(); }); await frames();
    await checkMenu();
  },
  'UX-N1: named session tabs reveal the active tab without stealing focus': async () => {
    const sessions = Array.from({ length: 10 }, (_, index) => ({ ...session, id: `navigation-${index}`, title: `Independent task ${index}`, messages: [] }));
    const tabs = sessions.map(value => ({ id: `tab-${value.id}`, kind: 'agent' as const, sessionId: value.id }));
    let snapshot: Snapshot = { version: 1, sessions, providers: [provider], workspaces: [{ ...workspace, tabs, activeTabId: tabs[0].id }],
      workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    let publish!: (value: Snapshot) => void;
    window.workbench = {
      snapshot: async () => snapshot, subscribe: (listener: (value: Snapshot) => void) => { publish = listener; return () => {}; },
      ...applicationUpdateApi,
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    await render(<App />); await frames();
    const strip = document.querySelector<HTMLElement>('.workspace-tabs')!;
    const names = [...strip.querySelectorAll('.tab-select')].map(element => element.textContent);
    assert(sessions.every((value, index) => names[index] === value.title), 'Same-provider sessions have indistinguishable labels');
    assert(strip.scrollWidth > strip.clientWidth, 'The fixture does not overflow the tab strip');
    const focus = button('shell:app.searchWorkspaces'); focus.focus();
    const visible = () => {
      const selected = strip.querySelector<HTMLElement>('.workspace-tab.active')!.getBoundingClientRect(), viewport = strip.getBoundingClientRect();
      return selected.left >= viewport.left - 1 && selected.right <= viewport.right + 1;
    };
    snapshot = { ...snapshot, workspaces: [{ ...snapshot.workspaces[0], activeTabId: tabs.at(-1)!.id }] };
    await act(async () => { publish(snapshot); await tick(); }); await frames();
    assert(visible() && strip.scrollLeft > 0, 'A newly active session remains outside the visible tabs');
    assert(document.activeElement === focus, 'Revealing a session tab stole keyboard focus');
    const previousWidth = strip.clientWidth;
    strip.style.maxWidth = `${Math.max(240, previousWidth - 100)}px`; await frames();
    assert(visible(), 'Resizing hid the active tab');
    snapshot = { ...snapshot, workspaces: [{ ...snapshot.workspaces[0], activeTabId: tabs[0].id }] };
    await act(async () => { publish(snapshot); await tick(); }); await frames();
    assert(visible() && strip.scrollLeft === 0, 'Returning to the first session did not reveal it');
    assert(document.querySelector('.workspace-header-actions button[aria-label="' + translate('shell:app.collaboration') + '"]'), 'Compact collaboration action has no accessible name');
  },
  'INBOX-01: cross-project attention opens the matching approval, failure, or result without marking the list read': async () => {
    const approvalProject = { ...workspace, id: 'approval-project', name: 'Approval project', cwd: '/approval-project' };
    const resultProject = { ...workspace, id: 'result-project', name: 'Archived result project', cwd: '/result-project', archived: true };
    const at = (hour: string) => `2026-10-23T${hour}:00Z`;
    const message = (id: string, role: Message['role'], text: string, time: string): Message => ({ id, role, text, createdAt: at(time) });
    const failedEvent = (id: string, time: string): Message => ({
      ...message(id, 'activity', id, time), event: { id, kind: 'tool', title: id, status: 'failed', output: 'Provider failure output' },
    });
    const approval = (id: string) => ({ id, sessionId: 'inbox-approval', title: id, detail: 'Approval detail', choices: [{ id: 'yes', label: 'Allow' }] });
    const attention = (reason: 'approval' | 'failure' | 'result', time: string, seenRevision = 0) => ({
      reason, updatedAt: at(time), revision: 1, seenRevision, sourceId: `attempt:${reason}:composite-id`,
    });
    const waiting: Session = { ...session, id: 'inbox-approval', title: 'Approval session', cwd: approvalProject.cwd, status: 'waiting_approval',
      approvals: [approval('Older approval'), approval('Latest approval')], attention: attention('approval', '02:01', 1) };
    const failure: Session = { ...session, id: 'inbox-failure', title: 'Failure with Trace', status: 'running', attention: attention('failure', '02:06'),
      attempts: [
        { id: 'failed-attempt', status: 'failed', userMessageId: 'failed-prompt', prompt: '', startedAt: at('02:00'), endedAt: at('02:05') },
        { id: 'retry-attempt', status: 'running', userMessageId: 'retry-prompt', prompt: '', startedAt: at('04:00') },
      ],
      messages: [message('old-prompt', 'user', 'Old prompt', '01:00'), failedEvent('older-failed-event', '01:01'),
        message('failed-prompt', 'user', 'Failed prompt', '02:00'), failedEvent('matching-failed-event', '02:02'),
        message('retry-prompt', 'user', 'Retry prompt', '04:00'), failedEvent('retry-event', '04:01'),
        ...messageRange(1, 30).map(item => ({ ...item, createdAt: at('04:02') }))] };
    const fallback: Session = { ...session, id: 'inbox-fallback', title: 'Failure without Trace', status: 'failed', error: 'Provider stopped before output',
      updatedAt: at('06:00'), attention: attention('failure', '01:20'), messages: [message('fallback-prompt', 'user', 'Fallback prompt', '01:00')] };
    const result: Session = { ...session, id: 'inbox-result', title: 'Completed session', cwd: resultProject.cwd, status: 'completed',
      attention: attention('result', '04:00'), messages: [message('inbox-result-prompt', 'user', 'Result prompt', '03:00'),
        message('inbox-old-output', 'assistant', 'Earlier output', '03:01'), message('inbox-final-output', 'assistant', 'Final result', '03:02')] };
    const sourceSessions = [fallback, result, waiting, failure, { ...result, id: 'already-read', attention: attention('result', '05:00', 1) }];
    let snapshot: Snapshot = { version: 1, sessions: sourceSessions.map(value => ({ ...value, messages: [], historyLoaded: false })),
      workspaces: [workspace, approvalProject, resultProject], providers: [provider], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    let publish!: (snapshot: Snapshot) => void;
    const seen: string[] = [], opens: { workspaceId: string; sessionId: string }[] = [];
    window.workbench = {
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; }, snapshot: async () => snapshot,
      ...applicationUpdateApi, getConnection: async () => ({ status: 'connected', synced: true }),
      onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      watchSessions: async (ids: string[]) => {
        snapshot = { ...snapshot, sessions: sourceSessions.map(value => ids.includes(value.id) ? { ...value, historyLoaded: true }
          : { ...value, messages: [], historyLoaded: false }) };
        publish(snapshot);
      },
      openSessionTab: async (workspaceId: string, sessionId: string) => {
        opens.push({ workspaceId, sessionId });
        snapshot = { ...snapshot, workspaces: snapshot.workspaces.map(project => project.id === workspaceId
          ? { ...project, tabs: [{ kind: 'agent', id: sessionId, sessionId }], activeTabId: sessionId } : project) };
        publish(snapshot);
      },
      markSessionSeen: async (id: string) => { seen.push(id); },
      sessionHistoryAround: async () => { throw new Error('The attention source key is not a history cursor'); },
    } as unknown as Window['workbench'];

    const visitInbox = async () => { await click('shell:attention.inboxTitle'); await frames(3); };
    const select = async (id: string) => await act(async () => {
      const row = document.querySelector<HTMLButtonElement>(`.attention-inbox-row[data-session-id="${id}"]`);
      assert(row, `Missing attention entry ${id}`);
      row.click(); await tick();
    });
    const isVisible = (selector: string) => {
      const bounds = document.querySelector(selector)?.getBoundingClientRect();
      const viewport = document.querySelector('.message-scroll')?.getBoundingClientRect();
      return Boolean(bounds && viewport && bounds.top < viewport.bottom && bounds.bottom > viewport.top);
    };
    const originalFocus = document.hasFocus;
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    document.hasFocus = () => true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    try {
      await render(<App />); await visitInbox();
      const groups = [...document.querySelectorAll<HTMLElement>('.attention-inbox-group')];
      assert(groups.map(group => group.dataset.attentionReason).join(',') === 'approval,failure,result', 'The inbox ignored attention priority');
      assert([...groups[1].querySelectorAll<HTMLElement>('.attention-inbox-row')].map(row => row.dataset.sessionId).join(',') === 'inbox-failure,inbox-fallback', 'Two failures in one project were collapsed or sorted by an unrelated update');
      assert(groups[0].textContent?.includes(approvalProject.name) && groups[2].textContent?.includes(resultProject.name)
        && groups[2].querySelector('time')?.dateTime === result.attention!.updatedAt, 'The inbox lost project or timestamp context');
      assert(seen.length === 0 && !document.querySelector('[data-session-id="already-read"]'), 'Browsing marked items read or kept an already-read result');
      await select(waiting.id);
      await waitFor(() => (document.activeElement as HTMLElement)?.dataset.approvalId === 'Latest approval', 'Opening the approval did not focus its card');
      assert(opens[0]?.workspaceId === approvalProject.id, 'The approval opened the wrong project');
      await visitInbox(); await select(failure.id);
      await waitFor(() => isVisible('[data-message-id="matching-failed-event"].conversation-match') &&
        Boolean(document.querySelector('[data-message-id="matching-failed-event"] .process-reveal[data-expanded=true]')), 'Opening a failure selected an unrelated attempt or did not reveal its Trace');
      assert(opens[1]?.sessionId === failure.id && !seen.includes(failure.id), 'Opening an earlier failure targeted the wrong session or marked unseen tail output');
      await visitInbox(); await select(fallback.id);
      await waitFor(() => document.querySelector('.inline-error')?.textContent?.includes(fallback.error!) === true, 'A failure without a Trace lost its existing error state');
      await visitInbox(); await select(result.id);
      await waitFor(() => isVisible('.chat-pane-readonly [data-message-id="inbox-final-output"].conversation-match'), 'The latest result did not open at the output in the retained project');
      await waitFor(() => seen.includes(result.id), 'Viewing the latest result did not preserve the existing read acknowledgment');
    } finally {
      document.hasFocus = originalFocus;
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility); else Reflect.deleteProperty(document, 'visibilityState');
    }
  },
  'UI-09: cached snapshots cannot mask disconnects or clear unread failures before reading': async () => {
    const originalFocus = document.hasFocus;
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let focused = false;
    document.hasFocus = () => focused;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    try {
      const failed: Session = { ...session, id: 'older-failure', status: 'failed', error: 'Original failure', messages: messageRange(0, 100), messageCount: 100, historyLoaded: true, draft: { text: 'Retained draft' }, attention: { revision: 5, seenRevision: 4, reason: 'failure', updatedAt: session.updatedAt } };
      const latest: Session = { ...session, id: 'latest-result', status: 'completed', updatedAt: '2026-10-23T03:00:00Z', attention: { revision: 7, seenRevision: 7, reason: 'result', updatedAt: session.updatedAt }, historyLoaded: true };
      const splitWorkspace: Workspace = { ...workspace, tabs: [{ kind: 'agent', id: 'left', sessionId: failed.id }, { kind: 'agent', id: 'right', sessionId: latest.id }], activeTabId: 'left', secondaryTabId: 'right', splitDirection: 'horizontal' };
      let snapshot: Snapshot = { version: 1, sessions: [failed, latest], workspaces: [splitWorkspace], providers: [provider], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
      let publish!: (snapshot: Snapshot) => void, connectionChanged!: (state: BackendConnectionState) => void;
      const watched: string[][] = [], seen: { id: string; revision: number }[] = [];
      window.workbench = {
        subscribe: (listener: (snapshot: Snapshot) => void) => { publish = listener; return () => {}; }, snapshot: async () => snapshot,
        ...applicationUpdateApi,
        getConnection: async () => ({ status: 'connected', synced: true }),
        onConnectionChanged: (listener: (state: BackendConnectionState) => void) => { connectionChanged = listener; return () => {}; },
        onFocusSession: () => () => {}, watchSessions: async (ids: string[]) => { watched.push(ids); },
        listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
        markSessionSeen: async (id: string, revision: number) => {
          seen.push({ id, revision });
          snapshot = { ...snapshot, sessions: snapshot.sessions.map(value => value.id === id ? { ...value, attention: { ...value.attention!, seenRevision: revision } } : value) };
          publish(snapshot);
        },
      } as unknown as Window['workbench'];
      await render(<App />); await frames(5);
      assert(watched.some(ids => ids.length === 2 && ids.includes(failed.id) && ids.includes(latest.id)), 'Split view did not subscribe to both session tails');
      assert(document.querySelector('.workspace-row.group-attention .attention-failure') && document.querySelector('.workspace-unread')?.textContent === '1', 'A newer result hid an older unread failure');
      await act(async () => { connectionChanged({ status: 'reconnecting', synced: false, lastReceivedAt: '2026-10-23T02:00:00Z' }); await tick(); });
      assert(document.querySelector('.sidebar-connection')?.textContent?.includes('Reconnecting') && document.querySelector('.connection-banner'), 'A cached snapshot still claimed the backend was connected');
      assert(button('workspace:chat.sendTask').disabled && document.querySelector('.workspace-row'), 'Disconnect discarded cached workspaces or allowed sending');
      const scroll = document.querySelector<HTMLDivElement>('.message-scroll')!;
      await act(async () => { scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll')); focused = true; connectionChanged({ status: 'connected', synced: true }); window.dispatchEvent(new Event('focus')); await tick(); });
      await frames(5);
      assert(seen.length === 0, 'Opening a session cleared unread output while the reader was above it');
      await act(async () => { scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event('scroll')); await tick(); }); await frames(5);
      assert(seen.some(value => value.id === failed.id && value.revision === 5), 'Reading the latest output did not persist its exact attention revision');
      assert(!document.querySelector('.workspace-unread') && document.querySelector('.tab-state-failed') && document.body.textContent?.includes('Original failure'), 'Marking output read changed the actual failure state');
    } finally {
      document.hasFocus = originalFocus;
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility); else Reflect.deleteProperty(document, 'visibilityState');
    }
  },
  'UI-10: workspace creation exposes directory isolation and retries one creation intent': async () => {
    const creations: Record<string, unknown>[] = [];
    window.workbench = {
      subscribe: () => () => {}, snapshot: async () => ({ version: 1, sessions: [], workspaces: [], providers: [], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' }),
      ...applicationUpdateApi,
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {}, watchSessions: async () => {},
      providerHealth: async () => [],
      createWorkspace: async (input: Record<string, unknown>) => { creations.push(input); if (creations.length === 1) throw new Error('creation response lost'); return 'created-workspace'; },
    } as unknown as Window['workbench'];
    await render(<App />); await click('shell:app.addProject');
    const mode = document.querySelector<HTMLButtonElement>('dialog [role=combobox]')!;
    assert(mode.textContent?.includes(translate('shell:app.currentDirectory')), 'Creating a workspace silently defaults to a new worktree');
    await change(input('dialog .directory-field input'), '/fixture'); await chooseOption(mode, 'worktree');
    await change(input(`input[placeholder="${translate('shell:app.worktreeBranchDefault')}"]`), 'codex/isolated');
    await click('shell:app.createWorkspace');
    await waitFor(() => creations.length === 1 && !button('shell:app.createWorkspace').disabled, 'Failed creation did not leave the editable dialog');
    await click('shell:app.createWorkspace'); await waitFor(() => creations.length === 2, 'Creation retry did not start');
    await waitFor(() => !document.querySelector('dialog'), 'Successful workspace creation did not close the dialog');
    assert(creations[0].commandId && creations[0].commandId === creations[1].commandId && creations[1].mode === 'worktree' && creations[1].branch === 'codex/isolated' && creations[1].cwd === '/fixture', 'Workspace retry changed its intent or lost the isolation choice');
    await click('shell:app.addProject'); await change(input('dialog .directory-field input'), '/fixture'); await click('shell:app.createWorkspace');
    await waitFor(() => creations.length === 3, 'The next creation did not start');
    assert(creations[2].mode === 'directory' && creations[2].commandId !== creations[1].commandId, 'An independent creation reused the completed intent');
  },
  'UX2-FILES-TERMINAL: replacement tails and gap recovery stay ordered behind pending terminal writes': async () => {
    const originalOpen = Terminal.prototype.open;
    let terminal: Terminal | undefined, listener!: Parameters<Window['workbench']['onTerminalOutput']>[1];
    Terminal.prototype.open = function(element) { terminal = this; originalOpen.call(this, element); };
    try {
      window.workbench = {
        onTerminalOutput: (_id: string, value: typeof listener) => { listener = value; return () => {}; },
        resizeTerminal: async () => {}, writeTerminal: async () => {},
      } as unknown as Window['workbench'];
      const info = { id: 'pending-terminal', workspaceId: workspace.id, title: 'Terminal', status: 'running' as const, exitCode: null, output: '', outputOffset: 0 };
      await render(<TerminalPane info={info} cwd={workspace.cwd} perform={perform} />);
      const contents = () => Array.from({ length: terminal?.buffer.active.length ?? 0 }, (_, index) => terminal?.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n').trimEnd();
      await act(async () => {
        listener({ type: 'tail', terminalId: info.id, outputOffset: 0, output: 'old tail\r\n' });
        listener({ type: 'append', terminalId: info.id, offset: 10, data: 'pending old append\r\n' });
        listener({ type: 'tail', terminalId: info.id, outputOffset: 100, output: 'reconnected\r\n' });
        listener({ type: 'append', terminalId: info.id, offset: 113, data: 'after reconnect\r\n' });
        await tick();
      });
      await waitFor(() => contents().includes('after reconnect'), 'The append after reconnection was not rendered');
      assert(contents() === 'reconnected\nafter reconnect', `A reconnect tail retained queued stale output: ${contents()}`);
      await act(async () => {
        listener({ type: 'append', terminalId: info.id, offset: 130, data: 'pending before gap\r\n' });
        listener({ type: 'append', terminalId: info.id, offset: 500, data: 'gap recovery\r\n' });
        listener({ type: 'append', terminalId: info.id, offset: 514, data: 'after gap\r\n' });
        await tick();
      });
      await waitFor(() => contents().includes('after gap'), 'The append after gap recovery was not rendered');
      assert(contents() === 'gap recovery\nafter gap', `Gap recovery retained queued stale output: ${contents()}`);
    } finally { Terminal.prototype.open = originalOpen; }
  },
  'UI-11: terminal subscriptions consume bounded tails and overlapping appends exactly once': async () => {
    const originalOpen = Terminal.prototype.open;
    let terminal: Terminal | undefined, listener!: Parameters<Window['workbench']['onTerminalOutput']>[1], unsubscribed = 0;
    Terminal.prototype.open = function(element) { terminal = this; originalOpen.call(this, element); };
    try {
      window.workbench = {
        onTerminalOutput: (_id: string, value: typeof listener) => { listener = value; value({ type: 'tail', terminalId: 'terminal', outputOffset: 10, output: 'first\r\n' }); return () => { unsubscribed++; }; },
        resizeTerminal: async () => {}, writeTerminal: async () => {},
      } as unknown as Window['workbench'];
      const info = { id: 'terminal', workspaceId: workspace.id, title: 'Terminal', status: 'running' as const, exitCode: null, output: '', outputOffset: 0 };
      await render(<TerminalPane info={info} cwd={workspace.cwd} perform={perform} />);
      const contents = () => Array.from({ length: terminal?.buffer.active.length ?? 0 }, (_, index) => terminal?.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n');
      await waitFor(() => contents().startsWith('first\n'), 'Initial subscription tail was not written');
      await act(async () => { listener({ type: 'append', terminalId: info.id, offset: 10, data: 'first\r\nsecond\r\n' }); await tick(); });
      await waitFor(() => contents().startsWith('first\nsecond\n'), 'An overlapping append duplicated or lost terminal output');
      await act(async () => { listener({ type: 'append', terminalId: info.id, offset: 17, data: 'second\r\n' }); await tick(); });
      assert(contents().split('second').length === 2, 'A duplicate terminal append was rendered twice');
      await act(async () => { listener({ type: 'tail', terminalId: info.id, outputOffset: 100, output: 'reconnected\r\n' }); await tick(); });
      await waitFor(() => contents().startsWith('reconnected\n') && !contents().includes('first'), 'Reconnection tail did not replace stale terminal output');
      await render(<TerminalPane info={{ ...info, status: 'exited', exitCode: 0 }} cwd={workspace.cwd} perform={perform} />);
      assert(terminal?.options.disableStdin, 'An exited terminal still accepts input');
      await render(<div />);
      assert(unsubscribed === 1, 'Closing the terminal did not release its output subscription');
    } finally { Terminal.prototype.open = originalOpen; }
  },
  'PROVIDER-3 UI: plugin v2 gates each attachment kind without dropping files': async () => {
    const sends: unknown[] = [];
    window.workbench = { sendPrompt: async (_id: string, input: unknown) => { sends.push(input); } } as unknown as Window['workbench'];
    const text = { id: 'text', name: 'note.txt', kind: 'text' as const, ownedPath: '/note.txt', mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) };
    const image = { ...text, id: 'image', name: 'image.png', kind: 'image' as const, mimeType: 'image/png' };
    const plugin: ProviderInfo = { ...provider, id: 'plugin-v2', source: 'plugin', protocolVersion: 2, capabilities: { resume: false, approvals: false }, declaredCapabilities: { resume: false, approvals: false, textAttachments: true, images: false } };
    const show = (attachments: typeof text[] | typeof image[] | (typeof text | typeof image)[], configured = plugin) => render(chat({ provider: configured, draft: { text: 'Use the files', attachments } }));
    await show([text, image]);
    assert(!button('workspace:chat.attach').disabled && button('workspace:chat.sendTask').disabled && document.querySelectorAll('.composer .attachment-chip').length === 2, 'A mixed draft was dropped or an unsupported image was allowed');
    assert(document.querySelector('[role=alert]')?.textContent?.includes('some of the attached file types'), 'The v2 attachment kind restriction was not explained');
    await show([text]); await click('workspace:chat.sendTask'); await settle();
    assert(JSON.stringify(sends[0]) === JSON.stringify({ text: 'Use the files', attachments: [text] }), 'An allowed text file was blocked or silently dropped before the v2 handshake');
    await show([image], { ...plugin, declaredCapabilities: { resume: false, approvals: false, images: true, textAttachments: false } });
    await click('workspace:chat.sendTask'); await settle();
    assert(JSON.stringify(sends[1]) === JSON.stringify({ text: 'Use the files', attachments: [image] }), 'Image support did not honor its separately declared capability');
    await show([text], { ...plugin, protocolVersion: 1 });
    assert(button('workspace:chat.sendTask').disabled && button('workspace:chat.pluginAttachmentsUnsupported').disabled, 'A v1 plugin acquired v2 attachment support');
  },
  'PROVIDER-2 UI: plugins retain attachment drafts and block unsupported sends': async () => {
    let sends = 0, changes = 0;
    window.workbench = { sendPrompt: async () => { sends++; } } as unknown as Window['workbench'];
    const draft = { text: 'Use the file', attachments: [{ id: 'attachment', name: 'note.txt', kind: 'text' as const, ownedPath: '/note.txt', mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }] };
    await render(chat({ provider: { ...provider, id: 'plugin', source: 'plugin' }, draft, onDraftChange: () => { changes++; } }));
    assert(button('workspace:chat.pluginAttachmentsUnsupported').disabled, 'Plugin attachment picker remained enabled');
    assert(button('workspace:chat.sendTask').disabled && document.querySelector('.attachments-strip')?.textContent?.includes('note.txt'), 'Plugin draft was removed or allowed to send');
    await act(async () => { input('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); });
    assert(sends === 0 && changes === 0, 'Enter submitted or erased an unsupported draft');
    assert(document.querySelector('[role=alert]')?.textContent?.includes('does not support attachments'), 'Attachment restriction was not explained');
    const remove = document.querySelector<HTMLButtonElement>('.attachment-chip button'); assert(remove && !remove.disabled, 'User cannot remove the unsupported attachment');
  },
  'UI-TAIL-RESET: live resynchronization invalidates an older page without cancelling its replacement': async () => {
    const oldPage = deferred<SessionHistoryWindow>(), newPage = deferred<SessionHistoryWindow>();
    const requests: string[] = [];
    window.workbench = {
      sessionHistory: async (_id: string, before: string) => {
        requests.push(before);
        if (requests.length === 1) return oldPage.promise;
        if (requests.length === 2) return newPage.promise;
        return { messages: messageRange(900, 1000), beforeCursor: 'message-900', hasMore: true, hasAfter: false };
      },
    } as unknown as Window['workbench'];
    let current: Session = { ...session, messages: messageRange(900, 1000), messageCount: 1000,
      historyCursor: 'message-900', historyLoaded: true };
    await render(chat({ session: current })); await frames();
    await click('workspace:chat.loadEarlier');
    assert(requests[0] === 'message-900', 'The original page used the wrong cursor');
    current = { ...current, messages: messageRange(1100, 1200), messageCount: 1200, historyCursor: 'message-1100' };
    await render(chat({ session: current })); await frames();
    assert(!button('workspace:chat.loadEarlier').disabled, 'A discarded tail kept its stale page in flight');
    await click('workspace:chat.loadEarlier');
    assert(requests[1] === 'message-1100', 'The replacement page did not start at the new tail');
    await act(async () => { oldPage.resolve({ messages: messageRange(800, 900), beforeCursor: 'message-800', hasMore: true, hasAfter: false }); await tick(); });
    assert(button('workspace:chat.loadEarlier').disabled, 'The stale page completion cancelled the replacement loader');
    await act(async () => { newPage.resolve({ messages: messageRange(1000, 1100), beforeCursor: 'message-1000', hasMore: true, hasAfter: false }); await tick(); });
    await click('workspace:chat.loadEarlier');
    assert(requests[2] === 'message-1000', 'The stale page replaced the new cursor and left an unreadable history gap');
    assert(errors.length === 0, errors.join('\n'));
  },
  'UI-JUMP: replaced, closed and switched search jumps cannot overwrite the current window or cancel paging': async () => {
    const pageGate = deferred<SessionHistoryWindow>();
    const pageRequests: string[] = [];
    const aroundRequests: { sessionId: string; id: string; gate: ReturnType<typeof deferred<SessionHistoryWindow>> }[] = [];
    const oldMatch = { ...messageRange(300, 301)[0], text: 'Needle in old history' };
    const liveMatch = { ...messageRange(950, 951)[0], text: 'Needle already loaded' };
    const first: Session = { ...session, id: 'jump-first', messages: messageRange(900, 1000).map(message => message.id === liveMatch.id ? liveMatch : message),
      messageCount: 1000, historyCursor: 'message-900', historyLoaded: true };
    const second: Session = { ...session, id: 'jump-second', title: 'Second session', messages: messageRange(2000, 2100),
      messageCount: 2100, historyCursor: 'message-2000', historyLoaded: true };
    window.workbench = {
      sessionSearch: async (id: string) => ({ messages: id === first.id ? [oldMatch, liveMatch] : [], truncated: false }),
      sessionHistory: async (_id: string, before: string) => {
        pageRequests.push(before);
        if (pageRequests.length === 1) return pageGate.promise;
        return { messages: messageRange(700, 800), beforeCursor: 'message-700', hasMore: true, hasAfter: false };
      },
      sessionHistoryAround: async (sessionId: string, id: string) => {
        const gate = deferred<SessionHistoryWindow>(); aroundRequests.push({ sessionId, id, gate }); return gate.promise;
      },
    } as unknown as Window['workbench'];
    const oldWindow: SessionHistoryWindow = { messages: messageRange(250, 350).map(message => message.id === oldMatch.id ? oldMatch : message),
      beforeCursor: 'message-250', hasMore: true, afterCursor: 'message-349', hasAfter: true };
    const showsOldWindow = () => Boolean(document.querySelector('[data-message-id="message-300"]'))
      || Boolean(document.querySelector('.conversation-history-controls')?.textContent?.includes(translate('workspace:chat.historyWindow')));
    await render(chat({ session: first })); await frames();
    await click('workspace:chat.loadEarlier');
    await click('workspace:chat.find'); await change(input('.conversation-find input'), 'Needle');
    await waitFor(() => aroundRequests.length === 1, 'The first unloaded match did not request its window');
    await click('workspace:chat.nextMatch'); await frames();
    assert(document.querySelector('[data-message-id="message-950"].conversation-match'), 'The loaded match did not become the current search target');
    assert(button('workspace:chat.loadEarlier').disabled, 'Replacing a jump prematurely cleared the independent paging operation');
    await act(async () => { aroundRequests[0].gate.resolve(oldWindow); await tick(); }); await frames();
    assert(!showsOldWindow() && document.querySelector('[data-message-id="message-950"].conversation-match'), 'A late unloaded match overwrote the newer loaded target');
    assert(button('workspace:chat.loadEarlier').disabled, 'A stale jump completion cleared the pending page loader');
    await act(async () => { pageGate.resolve({ messages: messageRange(800, 900), beforeCursor: 'message-800', hasMore: true, hasAfter: false }); await tick(); });
    await waitFor(() => !button('workspace:chat.loadEarlier').disabled, 'The valid pending page could not complete after jump cancellation');
    await click('workspace:chat.loadEarlier'); await frames();
    assert(pageRequests[1] === 'message-800', 'Cancelling a jump invalidated the completed page or its next cursor');

    await click('workspace:chat.previousMatch');
    await waitFor(() => aroundRequests.length === 2, 'The next unloaded jump did not start');
    await click('workspace:chat.closeFind');
    await act(async () => { aroundRequests[1].gate.resolve(oldWindow); await tick(); }); await frames();
    assert(!showsOldWindow(), 'Closing search still allowed its old Around response to switch history');
    await waitFor(() => !document.querySelector('.conversation-find'), 'Search did not close');
    await click('workspace:chat.find'); await change(input('.conversation-find input'), 'Needle');
    await waitFor(() => aroundRequests.length === 3, 'The session-switch jump did not start');
    await render(chat({ session: second }));
    await act(async () => { aroundRequests[2].gate.resolve(oldWindow); await tick(); }); await frames();
    assert(!showsOldWindow() && document.querySelector('.chat-toolbar h2')?.textContent === second.title, 'A response from the prior session replaced the new session window');
    assert([...document.querySelectorAll<HTMLElement>('[data-message-id]')].every(element => Number(element.dataset.messageId?.slice('message-'.length)) >= 2000), 'The prior session retained mounted history after switching');
    assert(errors.length === 0, errors.join('\n'));
  },
  'UI-READONLY: retained sessions without a workspace remain readable without recreating their deleted directory': async () => {
    const parent: Session = { ...session, id: 'retained-parent', title: 'Retained parent history', cwd: '/deleted/managed-worktree', archived: true,
      status: 'completed', messages: [], messageCount: 300, historyLoaded: false, historyCursor: 'message-200' };
    const child: Session = { ...parent, id: 'retained-child', title: 'Retained child history', parentSessionId: parent.id, messageCount: 1100, historyCursor: 'message-1000' };
    const parentTail = messageRange(200, 300).map(message => ({ ...message, nativeTurnId: `turn-${message.id}` }));
    const childTail = messageRange(1000, 1100);
    let snapshot: Snapshot = { version: 1, sessions: [parent, child], workspaces: [], providers: [{ ...provider, capabilities: { ...provider.capabilities, rewind: true } }],
      workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    let publish: ((value: Snapshot) => void) | undefined;
    let creations = 0, sends = 0, openedTabs = 0, around = 0;
    const watched: string[][] = [];
    const oldMatch = { ...messageRange(50, 51)[0], text: 'Ancient retained result from the removed checkout' };
    window.workbench = {
      snapshot: async () => snapshot, subscribe: (listener: (value: Snapshot) => void) => { publish = listener; return () => {}; },
      ...applicationUpdateApi,
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async (ids: string[]) => {
        watched.push(ids);
        snapshot = { ...snapshot, sessions: [parent, child].map(value => ({ ...value, historyLoaded: ids.includes(value.id),
          messages: ids.includes(value.id) ? value.id === parent.id ? parentTail : childTail : [] })) };
        publish?.(snapshot);
      },
      createWorkspace: async () => { creations++; throw new Error('Deleted directory must not be recreated'); },
      openSessionTab: async () => { openedTabs++; }, sendPrompt: async () => { sends++; },
      sessionSearch: async () => ({ messages: [oldMatch], truncated: false }),
      sessionHistoryAround: async (_id: string, id: string) => {
        around++; assert(id === oldMatch.id, 'Read-only search requested the wrong message');
        const messages = messageRange(0, 100).map(message => message.id === oldMatch.id ? oldMatch : message);
        messages[51] = { id: 'retained-activity', role: 'activity', text: 'Retained activity from the old checkout', createdAt: oldMatch.createdAt };
        return { messages, hasMore: false, afterCursor: 'message-99', hasAfter: true };
      },
    } as unknown as Window['workbench'];
    await render(<App />); await click('shell:app.history');
    await change(input('.history-archive input'), true);
    const row = [...document.querySelectorAll<HTMLButtonElement>('.history-open')].find(element => element.querySelector('strong')?.textContent?.includes(parent.title));
    assert(row, 'The retained archived session was missing from History');
    await act(async () => { row.click(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.chat-pane-readonly [data-message-id="message-299"]')), 'The retained session tail did not load in the existing chat viewer');
    assert(watched.some(ids => ids.length === 1 && ids[0] === parent.id), 'Read-only history did not subscribe to its session');
    assert(!document.querySelector('.chat-pane-readonly .composer') && !document.querySelector('.chat-pane-readonly .session-settings')
      && ![...document.querySelectorAll('.chat-pane-readonly button')].some(element => element.getAttribute('aria-label') === translate('workspace:chat.settings')
        || element.textContent?.includes(translate('workspace:chat.rewindBefore')) || element.textContent?.includes(translate('workspace:chat.forkHere'))),
    'Read-only history exposed a directory-dependent mutation');
    await click('workspace:chat.find'); await change(input('.conversation-find input'), 'Ancient');
    await waitFor(() => Boolean(document.querySelector('[data-message-id="message-50"].conversation-match')), 'Read-only search could not load older original content');
    assert(around === 1 && document.body.textContent?.includes(oldMatch.text), 'Read-only search did not retrieve the original Around body');
    await act(async () => { document.querySelector<HTMLButtonElement>('.chat-activity-button')!.click(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.activity-entry')?.textContent?.includes('Retained activity')), 'Read-only history lost the activity drawer');
    const related = [...document.querySelectorAll<HTMLButtonElement>('.session-children button')].find(element => element.textContent?.includes(child.title));
    assert(related, 'The retained related session was not navigable');
    await act(async () => { related.click(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.chat-pane-readonly [data-message-id="message-1099"]')), 'Related retained history could not open read-only');
    await click('shell:history.closeSession');
    await waitFor(() => Boolean(watched.length && watched.at(-1)?.length === 0), 'Closing retained history did not unsubscribe its session');
    assert(!document.querySelector('.chat-pane-readonly') && creations === 0 && openedTabs === 0 && sends === 0, 'Reading retained history created a workspace/tab or sent a prompt');
  },
  'UI-12: health evidence stays scoped to the selected directory and entry detection is not sign-in': async () => {
    const first = deferred<ProviderInfo[]>(), second = deferred<ProviderInfo[]>();
    const other: Workspace = { ...workspace, id: 'other', name: 'Other', cwd: '/other' };
    const checked = (status: 'ready' | 'unknown' | 'error', source: string): ProviderInfo => ({ ...provider, health: { checks: {
      binary: { status: 'ready', source: 'runtime-discovery', observedAt: '2026-10-23T00:00:00Z' },
      protocol: { status: 'unknown', source: 'runtime-discovery', observedAt: '2026-10-23T00:00:00Z' },
      catalog: { status: 'unknown', source: 'runtime-discovery', observedAt: '2026-10-23T00:00:00Z' },
      authentication: { status, source, observedAt: '2026-10-23T00:00:00Z' },
      quota: { status: 'unknown', source: 'no-quota-source', observedAt: '2026-10-23T00:00:00Z' },
    } } });
    let refreshes = 0, sends = 0;
    const requests: (string | undefined)[] = [];
    window.workbench = {
      providerHealth: (cwd?: string) => { requests.push(cwd); return cwd === workspace.cwd ? first.promise : second.promise; },
      refreshProviders: async () => { refreshes++; }, sendPrompt: async () => { sends++; },
    } as unknown as Window['workbench'];
    const snapshot: Snapshot = { version: 1, sessions: [], workspaces: [workspace, other], providers: [checked('unknown', 'no-authentication-evidence')], workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    await render(<ProvidersContent snapshot={snapshot} perform={perform} pending={new Set()} />);
    const authentication = () => document.querySelector<HTMLElement>('[data-stage="authentication"]')!;
    assert(authentication().dataset.status === 'unknown' && document.querySelector('.availability.available'), 'A detected CLI was treated as authenticated');
    const directory = () => document.querySelector<HTMLButtonElement>('.runtime-directory [role=combobox]')!;
    await chooseOption(directory(), workspace.cwd);
    await chooseOption(directory(), other.cwd);
    assert(authentication().dataset.status === 'unknown', 'Changing directories displayed another project authentication');
    await act(async () => { second.resolve([checked('ready', 'completed-turn')]); await tick(); });
    await waitFor(() => authentication().dataset.status === 'ready', 'Selected directory evidence did not load');
    await act(async () => { first.resolve([checked('error', 'runtime-authentication-error')]); await tick(); });
    assert(authentication().dataset.status === 'ready' && authentication().textContent?.includes('A task completed in this directory')
      && directory().textContent?.includes(other.name) && document.querySelector('.runtime-directory code')?.textContent === other.cwd, 'A late response replaced the newly selected directory');
    await click('shell:provider.refresh'); await settle();
    assert(refreshes === 1 && sends === 0 && requests.every(cwd => cwd === workspace.cwd || cwd === other.cwd), 'Health refresh sent a model task or lost directory scope');
    assert(document.querySelector('[data-stage="quota"]')?.getAttribute('data-status') === 'unknown' && authentication().querySelector('time')?.dateTime, 'Quota unknown or evidence time was omitted');
  },
  'UI-13: diagnostic collection requires a user toggle and exports a local path without rendering protocol content': async () => {
    let tracing = false;
    const changes: boolean[] = [];
    const records: DiagnosticEntry[] = [{ seq: 1, at: '2026-10-23T00:00:00Z', layer: 'provider', kind: 'rpc.receive', sessionId: session.id,
      attemptId: 'attempt-1', turnId: 'turn-1', method: 'turn/completed', status: 'completed', protocol: { raw: 'DO_NOT_RENDER_PROTOCOL_CONTENT' } }];
    window.workbench = {
      diagnostics: async () => records, diagnosticTracing: async () => tracing,
      setDiagnosticTracing: async (enabled: boolean) => { changes.push(enabled); tracing = enabled; },
      exportDiagnostics: async () => '/local/diagnostics/export.json',
    } as unknown as Window['workbench'];
    await render(<DiagnosticsPanel sessions={[session]} />);
    await waitFor(() => !(input('.diagnostics-tracing input') as HTMLInputElement).disabled, 'Tracing state did not load');
    assert(changes.length === 0 && !(input('.diagnostics-tracing input') as HTMLInputElement).checked, 'Mounting diagnostics enabled protocol collection');
    assert(!document.body.textContent?.includes('DO_NOT_RENDER_PROTOCOL_CONTENT') && document.body.textContent?.includes(session.title), 'Diagnostics exposed protocol content or lost the session label');
    await change(input('.diagnostics-tracing input'), true);
    await waitFor(() => tracing && !input('.diagnostics-tracing input').disabled, 'Explicit tracing selection was not saved');
    await click('runtime:diagnostics.export');
    await waitFor(() => document.querySelector('.diagnostics-export code')?.textContent === '/local/diagnostics/export.json', 'Diagnostic export did not display its local path');
    await render(<div />);
    assert(tracing && Number(changes.length) === 1, 'Leaving diagnostics changed the user recording choice');
    await render(<DiagnosticsPanel sessions={[session]} />);
    await waitFor(() => !(input('.diagnostics-tracing input') as HTMLInputElement).disabled, 'Tracing state did not reload');
    assert((input('.diagnostics-tracing input') as HTMLInputElement).checked && Number(changes.length) === 1, 'Reopening diagnostics hid the backend recording state');
    await change(input('.diagnostics-tracing input'), false);
    await waitFor(() => !tracing && changes.length === 2, 'Explicit tracing stop was not saved');
  },
  'UI-14: worktree removal requires a current directory and branch confirmation and retains rejected work': async () => {
    const removals: string[] = []; let closed = 0;
    window.workbench = { removeWorktree: async (id: string) => { removals.push(id); if (removals.length === 1) throw new Error('Worktree has uncommitted files'); } } as unknown as Window['workbench'];
    const managed: Workspace = { ...workspace, worktree: { repoRoot: '/source/repository', path: '/managed/task-one', branch: 'codex/task-one', baseSha: '0123456789abcdef', createdAt: '2026-10-23T00:00:00Z', ownership: 'created' } };
    const show = (value: Workspace) => render(<ManagedWorktreePanel workspace={value} onRemoved={() => { closed++; }} />);
    await show(managed);
    assert(document.body.textContent?.includes(managed.worktree!.repoRoot) && document.body.textContent?.includes(managed.worktree!.baseSha), 'Worktree source and starting commit were not shown');
    await click('runtime:worktree.reviewRemoval');
    assert(removals.length === 0 && document.querySelector('.worktree-removal-confirm')?.textContent?.includes(managed.worktree!.path)
      && document.querySelector('.worktree-removal-confirm')?.textContent?.includes(managed.worktree!.branch), 'Reviewing removal deleted work or omitted its target');
    const changed: Workspace = { ...managed, worktree: { ...managed.worktree!, path: '/managed/task-two', branch: 'codex/task-two' } };
    await show(changed);
    assert(!document.querySelector('.worktree-removal-confirm') && removals.length === 0, 'A changed removal target reused an old confirmation');
    await click('runtime:worktree.reviewRemoval'); await click('runtime:worktree.cancel');
    assert(removals.length === 0, 'Keeping the worktree still issued removal');
    await click('runtime:worktree.reviewRemoval'); await click('runtime:worktree.confirmRemove');
    await waitFor(() => document.querySelector('[role=alert]')?.textContent?.includes('uncommitted files') === true, 'A refused removal was hidden');
    assert(Number(removals.length) === 1 && closed === 0 && document.body.textContent?.includes(changed.worktree!.path), 'Rejected worktree removal closed the panel or lost its target');
    await click('runtime:worktree.reviewRemoval'); await click('runtime:worktree.confirmRemove');
    await waitFor(() => closed === 1, 'Confirmed successful removal did not close the workspace tools');
    assert(Number(removals.length) === 2 && removals.every(id => id === workspace.id), 'Removal was duplicated or used the wrong workspace');
  },
  'UX-C2: background collaboration updates preserve the run the user is viewing': async () => {
    window.workbench = { queryCollaborationEvents: async () => [] } as unknown as Window['workbench'];
    const first = collaborationRun('Run A', '2026-10-25T02:00:00Z');
    const other = collaborationRun('Run B', '2026-10-25T01:00:00Z');
    const show = (runs: CollaborationRun[]) => render(<CollaborationViews snapshot={collaborationSnapshot(runs)} perform={perform} pending={new Set()} openSession={() => {}} />);
    await show([first, other]);
    assert(document.querySelector('.collaboration-run-heading h1')?.textContent === 'Run A', 'The initial run did not open');
    await show([first, { ...other, updatedAt: '2026-10-25T03:00:00Z' }]);
    assert(document.querySelector('.collaboration-run-heading h1')?.textContent === 'Run A', 'Another run update switched the current collaboration');
    await act(async () => { document.querySelectorAll<HTMLButtonElement>('.collaboration-run-item')[0].click(); await tick(); });
    assert(document.querySelector('.collaboration-run-heading h1')?.textContent === 'Run B', 'Explicit run selection did not work');
    await show([first]);
    assert(document.querySelector('.collaboration-run-heading h1')?.textContent === 'Run A', 'Removing the selected run did not select the remaining run');
  },
  'UX-C1: collaboration event reads survive frequent state updates without duplicate requests': async () => {
    const requests: { runId: string; cursor: number; gate: ReturnType<typeof deferred<CollaborationEvent[]>> }[] = [];
    window.workbench = { queryCollaborationEvents: (runId: string, cursor = 0) => { const gate = deferred<CollaborationEvent[]>(); requests.push({ runId, cursor, gate }); return gate.promise; } } as unknown as Window['workbench'];
    const run = collaborationRun('Run A', '2026-10-25T00:00:00Z');
    const show = (revision: number) => render(<CollaborationViews snapshot={collaborationSnapshot([run], revision)} perform={perform} pending={new Set()} openSession={() => {}} />);
    await show(1);
    for (let revision = 2; revision <= 8; revision++) await show(revision);
    const event: CollaborationEvent = { id: 'event-1', seq: 1, runId: run.id, type: 'run.started', source: 'platform', data: {}, createdAt: '2026-10-25T00:00:00Z' };
    await act(async () => { requests[0].gate.resolve([event]); await tick(); });
    assert(document.querySelector('.collaboration-timeline-list')?.textContent?.includes('#1'), 'The accepted event response was dropped during live updates');
    assert(requests.length === 2 && requests[1].cursor === 1, `Expected one in-flight read followed by one catch-up read; got ${requests.length} requests at ${requests.map(item => item.cursor).join(', ')}`);
    await act(async () => { requests[1].gate.resolve([{ ...event, id: 'event-2', seq: 2 }]); await tick(); });
    assert(document.querySelectorAll('.collaboration-timeline-list > button').length === 2, 'Catch-up events did not render exactly once');
    await show(9);
    await render(<div />);
    await act(async () => { requests[2].gate.resolve([{ ...event, id: 'event-3', seq: 3 }]); await tick(); });
    assert(Number(requests.length) === 3, 'Unmounted collaboration continued reading events');
  },
};
fixture.rendererRegressionNames = Object.keys(cases);
fixture.runRendererRegressions = async selected => {
  await i18n.changeLanguage('en');
  const results: Result[] = [];
  for (const [name, check] of Object.entries(cases)) {
    if (selected?.length && !selected.some(prefix => name.startsWith(prefix))) continue;
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host); errors.length = 0; operations = [];
    host.style.cssText = 'display:flex;width:1100px;height:740px;min-height:0';
    try { await check(); results.push({ name }); }
    catch (error) { results.push({ name, error: error instanceof Error ? error.stack : String(error) }); }
    finally {
      await act(async () => root.unmount());
      host.remove();
      window.scrollTo(0, 0);
    }
  }
  return results;
};
