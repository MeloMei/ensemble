import { CollaborationViews } from './CollaborationViews';
import { readGraphView, writeGraphView } from './graph-view-state';
import type { CollaborationRun, CollaborationEvent, CollaborationParticipant, CollaborationTask, SessionCollaboration, SessionCollaborationMessage } from '../shared/collaboration';
import React, { act, useContext, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { MotionConfig, MotionConfigContext } from 'framer-motion';
import { EditorView } from '@codemirror/view';
import { i18n, translate } from '../shared/i18n';
import type { DiagnosticEntry, FileContent, FileEntry, FileImage, McpSettingsView, Message, PromptInput, ProviderInfo, Session, Snapshot, UnsavedFileSummary, Workflow, WorkflowInput, Workspace, WorkspaceManagement } from '../shared/types';
import { pathContainsFile, workspaceFileParent, type WorkspaceFileMutation } from '../shared/workspace-file-mutations';
import type { BackendConnectionState, SessionHistoryWindow } from '../shared/backend';
import { SESSION_PERMISSION_TIERS, type SessionPermission } from '../shared/session-permissions';
import { SettingsDialog } from './SettingsDialog';
import { LanguageProvider } from './language';
import { OverlayProvider } from './overlays';
import { TooltipProvider } from './Tooltip';
import { IconButton, Modal, ModelField } from './ui';
import { ProvidersContent, WorkflowEditor, WorkflowView } from './WorkflowViews';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ManagedWorktreePanel } from './ManagedWorktreePanel';
import { FileReviewPanel } from './FileReviewPanel';
import { WorkspaceFileNavigation } from './workspace-file-reference';
import { SessionChat, SessionSettingsPanel } from './SessionChat';
import { App } from './App';
import { FirstTask } from './FirstTask';
import { EvidenceTargetDialog } from './DraftEvidence';
import { WorkspaceToolsPanel } from './WorkspaceTools';
import { ApplicationUpdateNotice, ApplicationUpdateSettings, useApplicationUpdates } from './ApplicationUpdates';
import type { DictationEvent, DictationLanguage, DictationUnavailable } from '../shared/dictation';
import type { AppUpdateState } from '../shared/application-updates';
import { TerminalPane } from './TerminalPane';
import { Terminal } from '@xterm/xterm';
import { AppearanceProvider, initializeAppearance } from './appearance';
import { ShortcutProvider } from './app-shortcuts';
import { CodeEditor } from './CodeEditor';
import { CodeBlock } from './ui-kit/CodeBlock';
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
async function render(element: ReactElement, reducedMotion: 'always' | 'user' = 'always') {
  const content = reducedMotion === 'always' ? <MotionConfig reducedMotion="always">{element}</MotionConfig> : element;
  await act(async () => { root.render(<I18nextProvider i18n={i18n}><AppearanceProvider><ShortcutProvider><OverlayProvider><TooltipProvider>{content}</TooltipProvider></OverlayProvider></ShortcutProvider></AppearanceProvider></I18nextProvider>); await tick(); });
}
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
  'DICTATION: explicit start, permission denial, draft insertion and session cancellation': async () => {
    const alternate = { ...session, id: 'alternate-dictation' };
    const attachment = { id: 'dictation-attachment', name: 'dictation.txt', kind: 'text' as const, ownedPath: '/dictation.txt',
      mimeType: 'text/plain', size: 4, sha256: 'b'.repeat(64) };
    const drafts = new Map<string, PromptInput>([[session.id, { text: 'First last', attachments: [attachment] }], [alternate.id, { text: 'Other draft' }]]);
    const starts: { id: string; sessionId: string }[] = [];
    const stops: string[] = [];
    const cancelled: string[] = [];
    let sent = 0;
    let listener: ((event: DictationEvent) => void) | undefined;
    let unavailable: DictationUnavailable | undefined = 'helperMissing';
    let language: DictationLanguage = 'system';
    window.workbench = {
      dictationStatus: async () => ({ language, unavailable }),
      startDictation: async (id: string, sessionId: string) => { starts.push({ id, sessionId }); },
      stopDictation: async (id: string) => { stops.push(id); },
      cancelDictation: async (id: string) => { cancelled.push(id); },
      onDictationEvent: (receive: typeof listener) => { listener = receive; return () => { listener = undefined; }; },
      setDictationLanguage: async (value: DictationLanguage) => { language = value; },
      sendPrompt: async () => { sent++; },
      onLanguageChanged: () => () => {},
      ...applicationUpdateApi,
    } as unknown as Window['workbench'];

    function Composer({ item, enabled }: { item: Session; enabled: boolean }) {
      const [draft, setDraft] = React.useState(drafts.get(item.id)!);
      return chat({ session: item, dictationActive: enabled, draft, onDraftChange: (next, expected) => {
        if (expected && expected !== drafts.get(item.id)) return false;
        drafts.set(item.id, next);
        setDraft(next);
        return true;
      } });
    }
    const show = (item = session, enabled = true) => render(<Composer key={item.id} item={item} enabled={enabled} />);
    const start = () => button('workspace:dictation.start');
    const sendEvent = async (event: DictationEvent) => act(async () => { listener?.(event); await tick(); });
    await show();
    assert(start().getAttribute('aria-disabled') === 'true'
      && document.getElementById(start().getAttribute('aria-describedby') ?? '')?.textContent === translate('workspace:dictation.error.helperMissing'),
      'An installation without the native helper did not explain why dictation is unavailable');
    await click('workspace:dictation.start');
    assert(starts.length === 0, 'The unavailable control tried to start a helper');

    unavailable = undefined;
    await render(<LanguageProvider initial={{ preference: 'system', language: 'zh-CN' }}><SettingsDialog
      snapshot={null} sessions={[session]} perform={perform} pending={new Set()} updates={idleUpdates} initialSection="general"
      openSession={() => {}} onClose={() => {}} /></LanguageProvider>);
    const select = document.querySelector<HTMLButtonElement>('[data-setting-anchor="dictation-language"] .app-select');
    assert(select && !select.disabled, 'Available dictation did not expose a language setting');
    await chooseOption(select, 'zh-CN');
    assert(language === ('zh-CN' as DictationLanguage), 'The selected language was not sent to desktop preferences');
    await show();
    assert(starts.length === 0, 'Rendering or setting a language requested dictation');
    await click('workspace:dictation.start');
    const denied = starts.at(-1);
    assert(denied?.sessionId === session.id, 'The recording was not bound to the open conversation');
    await sendEvent({ id: denied.id, type: 'error', reason: 'microphonePermission' });
    assert(document.querySelector('.composer-area [role=alert]')?.textContent?.includes(translate('workspace:dictation.error.microphonePermission')),
      'Microphone denial was not shown in the composer');
    assert(drafts.get(session.id)?.text === 'First last', 'Permission denial changed the draft');

    const composer = input('.composer textarea') as HTMLTextAreaElement;
    composer.focus();
    composer.setSelectionRange(0, 5);
    await click('workspace:dictation.start');
    const recording = starts.at(-1)!;
    await sendEvent({ id: recording.id, type: 'recording' });
    const stop = button('workspace:dictation.stop');
    stop.focus();
    await click('workspace:dictation.stop');
    assert(stops.at(-1) === recording.id, 'Stopping did not request a final result from the active helper');
    await sendEvent({ id: recording.id, type: 'final', text: 'spoken' });
    assert(drafts.get(session.id)?.text === 'First spoken last' && drafts.get(session.id)?.attachments?.[0] === attachment,
      'Insertion overwrote selected text or dropped the existing attachment');
    assert(document.activeElement === composer && composer.selectionStart === 'First spoken'.length && composer.selectionEnd === composer.selectionStart,
      'Insertion did not return focus and the caret to the composer');
    assert(sent === 0, 'Dictation automatically sent the draft');

    await click('workspace:dictation.start');
    const abandoned = starts.at(-1)!;
    await sendEvent({ id: abandoned.id, type: 'recording' });
    await click('workspace:dictation.stop');
    await show(session, false);
    assert(cancelled.includes(abandoned.id), 'Deactivating a still-mounted pane did not cancel the recording');
    await show(alternate);
    await sendEvent({ id: abandoned.id, type: 'final', text: 'late transcript' });
    assert(drafts.get(session.id)?.text === 'First spoken last' && drafts.get(alternate.id)?.text === 'Other draft',
      'A late result edited the previous or newly opened conversation');

    await click('workspace:dictation.start');
    const dismissed = starts.at(-1)!;
    button('workspace:dictation.cancel').focus();
    await click('workspace:dictation.cancel');
    assert(cancelled.includes(dismissed.id) && document.activeElement === start(), 'Cancel did not release the helper and restore focus');
  },
  'APPEARANCE: text, code typography and motion update live and survive a renderer restart': async () => {
    const storageKey = 'ensemble.appearance';
    const saved = localStorage.getItem(storageKey);
    const rootElement = document.documentElement;
    const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const appearance = (anchor: string) => document.querySelector<HTMLButtonElement>(`[data-setting-anchor="${anchor}"] .app-select`)!;
    const motionSwitch = () => document.querySelector<HTMLInputElement>('[data-setting-anchor="reduce-motion"] input')!;
    const computed = (selector: string) => {
      const element = document.querySelector(selector);
      assert(element, `Missing appearance surface ${selector}`);
      return getComputedStyle(element);
    };
    function MotionProbe({ value }: { value: string }) {
      const { reducedMotion } = useContext(MotionConfigContext);
      return <div data-motion-config={reducedMotion}><span className="spin" /><RollingText value={value} /></div>;
    }
    const show = (value: string) => render(<>
      <nav className="sidebar-navigation"><button>Interface text</button></nav>
      <CodeBlock text="const code = 1;" language="ts" copyLabels={{ copy: 'Copy', copied: 'Copied', failed: 'Failed' }} />
      <div className="review-diff"><code>Code diff</code></div>
      <CodeEditor value="const code = 1;" location={{ path: 'index.ts', line: 1 }} onChange={() => {}} />
      <MotionProbe value={value} />
      <LanguageProvider initial={{ preference: 'en', language: 'en' }}>
        <SettingsDialog snapshot={null} sessions={[]} perform={perform} pending={new Set()} updates={idleUpdates}
          initialSection="general" openSession={() => {}} onClose={() => {}} />
      </LanguageProvider>
    </>, 'user');
    const assertMotion = (reduced: boolean) => {
      assert(rootElement.hasAttribute('data-reduced-motion') === reduced, 'The document motion preference was incorrect');
      assert(computed('[data-motion-config] .spin').animationName === (reduced ? 'none' : 'spin'), 'CSS motion diverged from the appearance preference');
      assert(document.querySelector('[data-motion-config]')?.getAttribute('data-motion-config') === (reduced ? 'always' : 'never'),
        'Framer Motion diverged from the appearance preference');
    };
    const assertCode = (size: string, family: string) => {
      for (const selector of ['.ui-code-block code', '.review-diff code', '.cm-scroller']) {
        const style = computed(selector);
        assert(style.fontSize === size && style.fontFamily.includes(family), `Unexpected code typography for ${selector}: ${style.fontSize} ${style.fontFamily}`);
      }
    };
    try {
      window.workbench = { ...applicationUpdateApi, onLanguageChanged: () => () => {} } as unknown as Window['workbench'];
      localStorage.setItem(storageKey, 'dark');
      initializeAppearance();
      assert(rootElement.dataset.theme === 'dark' && getComputedStyle(rootElement).fontSize === '13px', 'Legacy dark preference did not initialize with default text size');
      await show('56/100');
      assert(computed('.sidebar-navigation button').fontSize === '12px', 'Default interface size changed');
      assertCode('12px', 'SFMono-Regular');
      assertMotion(systemReduced);

      await chooseOption(appearance('text-size'), 'large');
      assert(getComputedStyle(rootElement).fontSize === '15px' && parseFloat(computed('.sidebar-navigation button').fontSize) > 12,
        'Changing interface size did not scale the interface');
      assertCode('12px', 'SFMono-Regular');
      const editor = document.querySelector('.cm-editor');
      await chooseOption(appearance('code-font'), 'courier');
      await chooseOption(appearance('code-size'), 'large');
      assertCode('14px', 'Courier New');
      assert(document.querySelector('.cm-editor') === editor && getComputedStyle(rootElement).fontSize === '15px',
        'Code typography changed the interface size or recreated the open editor');
      await click('shell:preferences.system');
      assert(String(rootElement.dataset.theme) === (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        'System theme did not follow the color scheme');

      await change(motionSwitch(), true);
      await show('57/100');
      assertMotion(true);
      assert(!document.querySelector('.ui-rolling-text-change'), 'Manually reducing motion still animated rolling text');
      await act(async () => { root.render(null); await tick(); });
      initializeAppearance();
      assert(rootElement.hasAttribute('data-reduced-motion') && getComputedStyle(rootElement).fontSize === '15px',
        'Saved appearance did not apply before the renderer mounted');
      await show('57/100');
      assertMotion(true);
      assert(motionSwitch().checked && appearance('text-size').textContent === 'Large' && appearance('code-font').textContent === 'Courier New'
        && appearance('code-size').textContent === 'Large' && button('shell:preferences.system').getAttribute('aria-pressed') === 'true',
        'Appearance choices did not survive a renderer restart');
      assertCode('14px', 'Courier New');

      await change(motionSwitch(), false);
      assertMotion(systemReduced);
      await show('58/100');
      assert(Boolean(document.querySelector('.ui-rolling-text-change')) !== systemReduced, 'Disabling the manual switch did not restore the system motion preference');
    } finally {
      await act(async () => { root.render(null); await tick(); });
      if (saved === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, saved);
      initializeAppearance();
    }
  },
  'OPERATION-FEEDBACK: errors queue, retries stay explicit and removing notices preserves focus': async () => {
    const terminal = deferred<void>(), pin = deferred<void>(), retryRuntime = deferred<void>(), retryFiles = deferred<FileEntry[]>(), move = deferred<'queue-changed'>();
    const queued: Session = { ...session, id: 'feedback-session', historyLoaded: true, queue: ['one', 'two'].map(id => ({
      id, commandId: `feedback-${id}`, input: { text: id }, createdAt: session.createdAt, updatedAt: session.updatedAt,
    })) };
    const tab = { kind: 'agent' as const, id: 'feedback-tab', sessionId: queued.id };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), workspaces: [workspace], providers: [provider] };
    let publish = (_value: Snapshot) => {};
    let refreshes = 0, fileReads = 0, moves = 0;
    let fileMode: 'ok' | 'fail' | 'retry' = 'ok';
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => snapshot,
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {}, gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      listFiles: async () => {
        fileReads++;
        if (fileMode === 'fail') throw new Error('File refresh refused');
        return fileMode === 'retry' ? retryFiles.promise : [];
      },
      updateWorkspace: async () => pin.promise, createTerminal: async () => terminal.promise,
      refreshProviders: async () => {
        refreshes++;
        if (refreshes === 1) throw new Error('Runtime refresh refused');
        if (refreshes === 2) await retryRuntime.promise;
      },
      moveQueuedPrompt: async () => { moves++; return move.promise; },
      commandReceipt: async () => undefined,
    } as unknown as Window['workbench'];
    const notices = () => [...document.querySelectorAll<HTMLElement>('.notification-queue [data-notification-id]')];
    const noticeText = (notice: Element) => notice.querySelector('[role=alert]')?.textContent;
    const dismiss = (notice: Element) => notice.querySelector<HTMLButtonElement>('[data-notification-dismiss]')!;
    const retry = (container: Element) => container.querySelector<HTMLButtonElement>('.operation-feedback-retry')!;
    const filePanel = () => document.querySelector('.file-review-panel')!;
    const activate = (control: HTMLElement) => act(async () => { control.focus(); control.click(); await tick(); });
    const escape = (control: HTMLElement) => act(async () => {
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
    });

    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>);
    await waitFor(() => Boolean(filePanel()) && !button('workspace:files.refresh').disabled, 'The initial file panel did not settle');
    await activate(button('shell:app.openTerminal'));
    await activate(button('shell:app.pin'));
    const origin = document.querySelector<HTMLElement>('.workspace-heading h1')!;
    origin.focus();
    await act(async () => { terminal.reject(new Error('Terminal creation refused')); pin.reject(new Error('Workspace pin refused')); await tick(); });
    assert(notices().map(noticeText).join(',') === 'Terminal creation refused,Workspace pin refused' && document.activeElement === origin,
      'Concurrent application errors replaced each other or stole focus');
    const first = notices()[0], second = notices()[1];
    assert(!retry(first) && !retry(second) && document.getElementById(dismiss(first).getAttribute('aria-describedby') ?? '')?.textContent === noticeText(first),
      'The dismiss control did not identify its error or an unsafe action was offered retry');
    await activate(dismiss(first));
    assert(notices().length === 1 && notices()[0] === second && document.activeElement === dismiss(second),
      'Dismissing a notice removed a different notice or lost keyboard focus');
    await escape(dismiss(second));
    assert(!notices().length && document.activeElement === origin, 'Closing the last notice did not return focus');

    await click('shell:preferences.open'); await click('shell:app.providers');
    const refreshRuntime = button('shell:provider.refresh');
    await activate(refreshRuntime);
    assert(document.activeElement === refreshRuntime,
      `Runtime refresh displaced focus before the notification was selected (${document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 40)})`);
    const runtimeNotice = notices()[0];
    assert(notices().length === 1 && noticeText(runtimeNotice) === 'Runtime refresh refused'
      && runtimeNotice.closest('dialog[open]') && retry(runtimeNotice), 'A runtime refresh failure did not offer one retry in its dialog');
    const runtimeRetry = retry(runtimeNotice);
    await activate(runtimeRetry);
    assert(refreshes === 2 && runtimeRetry.getAttribute('aria-busy') === 'true' && document.activeElement === runtimeRetry,
      'Retry did not expose progress and keep its focus');
    await activate(runtimeRetry);
    assert(refreshes === 2, 'Activating an in-progress retry replayed the request');
    await act(async () => { retryRuntime.reject(new Error('Runtime refresh still unavailable')); await tick(); });
    assert(notices().length === 1 && notices()[0] === runtimeNotice && noticeText(runtimeNotice) === 'Runtime refresh still unavailable'
      && document.activeElement === runtimeRetry, 'A failed retry duplicated the notice or displaced focus');
    await activate(runtimeRetry);
    await waitFor(() => !notices().length && Number(refreshes) === 3 && document.activeElement === refreshRuntime,
      () => `A successful retry did not clear only its notice and return focus (notices=${notices().length}, calls=${refreshes}, focus=${document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 60)})`);
    await click('shell:common.close');

    fileMode = 'fail';
    const refreshFiles = button('workspace:files.refresh');
    await activate(refreshFiles);
    const fileRetry = retry(filePanel());
    assert(filePanel().querySelector('[role=alert]')?.textContent === 'File refresh refused' && !notices().length && fileRetry,
      'File refresh failed without a single inline error and explicit retry');
    const reads = fileReads;
    fileMode = 'retry';
    await activate(fileRetry);
    assert(fileReads === reads + 1 && fileRetry.getAttribute('aria-busy') === 'true' && document.activeElement === fileRetry
      && filePanel().querySelector('.operation-feedback[data-state=progress] [role=status]'), 'File retry did not preserve focus or show progress');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const spinner = filePanel().querySelector('.operation-feedback[data-state=progress] .spin');
      assert(spinner && getComputedStyle(spinner).animationName === 'none', 'Progress ignored reduced motion');
    }
    await act(async () => { retryFiles.resolve([]); await tick(); });
    assert(!filePanel().querySelector('[role=alert]') && document.activeElement === refreshFiles && !notices().length,
      'A successful file retry left an error or lost focus');

    fileMode = 'ok';
    snapshot = { ...snapshot, sessions: [queued], workspaces: [{ ...workspace, tabs: [tab], activeTabId: tab.id }] };
    await act(async () => { publish(snapshot); await tick(); });
    const moveButton = document.querySelector<HTMLButtonElement>(`.prompt-queue button[aria-label="${translate('workspace:chat.queueMoveDown', { position: '1' })}"]`)!;
    await activate(moveButton);
    assert(moves === 1 && document.activeElement === moveButton
      && document.querySelector('.prompt-queue .operation-feedback[data-state=progress]')?.textContent === translate('workspace:chat.queueUpdating'),
      'Queue reordering lost focus or did not announce progress');
    await act(async () => { move.resolve('queue-changed'); await tick(); });
    assert(moves === 1 && notices().length === 1 && noticeText(notices()[0]) === translate('workspace:chat.queueOrderChanged')
      && !retry(notices()[0]) && document.activeElement === moveButton, 'The stale reorder was replayed, offered retry, or lost its keyboard focus');
  },
  'APP-SHORTCUTS: recording, conflicts, restore and dispatch honor the current focus context': async () => {
    const tab = { kind: 'agent' as const, id: 'shortcut-tab', sessionId: session.id };
    const home = { ...workspace, tabs: [tab], activeTabId: tab.id };
    const other = { ...workspace, id: 'shortcut-other', name: 'Shortcut destination', cwd: '/shortcut-other' };
    const snapshot = { ...collaborationSnapshot([]), workspaces: [home, other], sessions: [session], providers: [provider] };
    const storageKey = 'ensemble.shortcuts';
    const saved = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    const isMac = navigator.platform.startsWith('Mac');
    const modifier = isMac ? { metaKey: true } : { ctrlKey: true };
    const primary = isMac ? 'Meta' : 'Control';
    const shifted = (key: string) => isMac ? `Shift+Meta+${key}` : `Control+Shift+${key}`;
    const settings = () => document.querySelector('dialog[open] .settings-layout');
    const palette = () => document.querySelector('dialog[open] .command-palette');
    const heading = () => document.querySelector<HTMLElement>('.workspace-heading h1')!;
    const row = (action: string) => document.querySelector<HTMLElement>(`[data-setting-anchor="shortcut-${action}"]`)!;
    const recorder = (action: string) => row(action).querySelector<HTMLButtonElement>('.shortcut-recorder')!;
    const aria = (key: string) => button(key).getAttribute('aria-keyshortcuts');
    const performClick = (element: HTMLElement) => act(async () => { element.focus(); element.click(); await tick(); });
    const press = async (key: string, target: EventTarget, options: KeyboardEventInit = {}, modifiers = modifier) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers, ...options });
      await act(async () => { target.dispatchEvent(event); await tick(); });
      return event.defaultPrevented;
    };
    const start = async (action: string) => {
      const control = recorder(action);
      if (control.getAttribute('aria-pressed') !== 'true') await performClick(control);
      assert(document.activeElement === control && control.getAttribute('aria-pressed') === 'true', 'Shortcut recording did not focus its control');
      return control;
    };
    const record = async (action: string, key: string, options?: KeyboardEventInit) => press(key, await start(action), options);
    const restore = (action: string) => performClick(row(action).querySelector<HTMLButtonElement>('.icon-button')!);
    const closeDialog = () => performClick(document.querySelector<HTMLButtonElement>('dialog[open] .modal-heading button')!);
    const launch = () => render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}>
      <App />
      <div style={{ position: 'absolute', width: 200, height: 180 }}>
        <CodeEditor value="editor shortcut" location={{ path: 'shortcut.ts', line: 1 }} onChange={() => {}} />
        <div className="terminal-pane" tabIndex={0} data-shortcut-terminal />
      </div>
    </LanguageProvider>);
    try {
      window.workbench = {
        ...applicationUpdateApi, snapshot: async () => snapshot, subscribe: () => () => {},
        getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
        onLanguageChanged: () => () => {}, watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }),
        setUnsavedFiles: () => {}, saveSessionDraft: async () => {},
      } as unknown as Window['workbench'];
      await launch();
      assert(await press(',', heading()) && settings(), 'The platform settings shortcut did not open Settings');
      const search = input('.settings-search input');
      await change(search, isMac ? 'Cmd+K' : 'Ctrl+K');
      await press('Enter', search, { ctrlKey: false, metaKey: false });
      assert(row('commandPalette').classList.contains('setting-search-highlight'), 'Settings search could not find the current shortcut');
      const control = await start('commandPalette');
      assert(!await press('k', control, { isComposing: true, shiftKey: true }) && control.getAttribute('aria-pressed') === 'true',
        'The recorder handled an IME composition event');
      await press(',', control);
      assert(row('commandPalette').querySelector('[role=alert]')?.textContent?.includes('Settings')
        && aria('shell:commandPalette.trigger') === `${primary}+K`, 'A conflict did not name the occupied action or preserved an invalid mapping');
      await press('j', control);
      assert(row('commandPalette').querySelector('[role=alert]')?.textContent?.includes(translate('shell:app.openSessionTerminal')),
        'A fixed application shortcut did not identify its action');
      await press('f', control);
      assert(aria('shell:commandPalette.trigger') === `${primary}+F` && document.activeElement === control,
        'Settings search intercepted a combination while the recorder was active');
      await record('commandPalette', 'k', { shiftKey: true });
      const cancelled = await start('commandPalette');
      await press('Escape', cancelled);
      assert(settings() && cancelled.getAttribute('aria-pressed') === 'false' && aria('shell:commandPalette.trigger') === shifted('K'),
        'Esc closed Settings or changed the saved shortcut');
      await record('visitBack', 'ArrowLeft', { shiftKey: true });
      await record('visitForward', 'ArrowRight', { shiftKey: true });
      await record('settings', 'k');
      await record('toggleSidebar', 'b', { shiftKey: true });
      await record('toggleFiles', 'e', { shiftKey: true });
      await closeDialog();

      assert(aria('shell:commandPalette.trigger') === shifted('K') && aria('shell:preferences.open') === `${primary}+K`
        && aria('shell:app.visitBack') === shifted('ArrowLeft')
        && button('shell:commandPalette.trigger').querySelector('kbd')?.textContent === (isMac ? '⇧⌘K' : 'Ctrl+Shift+K'),
        'Visible shortcut hints did not follow the registered keys');
      for (const selector of ['.composer textarea', '[data-shortcut-terminal]']) {
        const field = document.querySelector<HTMLElement>(selector)!;
        field.focus();
        assert(!await press('k', field, { shiftKey: true }) && !palette(), `App dispatch intercepted ${selector}`);
      }
      const editor = EditorView.findFromDOM(document.querySelector('.cm-editor')!)!;
      editor.focus();
      assert(await press('k', editor.contentDOM, { shiftKey: true }) && editor.state.doc.length === 0 && !palette(),
        'The app shortcut replaced the editor’s local Delete Line command');
      assert(!await press('k', heading(), { isComposing: true, shiftKey: true }) && !palette(), 'App dispatch intercepted IME input');
      await performClick(document.querySelector<HTMLButtonElement>(`[data-workspace-id="${home.id}"]`)!.parentElement!.querySelector<HTMLButtonElement>('.row-actions-trigger')!);
      const menu = document.querySelector<HTMLElement>('[role=menu]:popover-open')!;
      assert(menu && !await press('k', menu, { shiftKey: true }) && !palette(), 'App dispatch intercepted an open project menu');
      await press('Escape', menu);
      assert(await press('k', heading(), { shiftKey: true }) && palette(), 'The remapped palette did not open');
      assert(!await press('k', input('.command-palette input')) && !settings(), 'Another app shortcut interrupted the palette dialog');
      await closeDialog();
      await performClick(document.querySelector<HTMLButtonElement>(`[data-workspace-id="${other.id}"]`)!);
      const back = button('shell:app.visitBack');
      await act(async () => {
        back.focus();
        back.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
        await tick();
      });
      await waitFor(() => [...document.querySelectorAll('.ensemble-tooltip')].some(item => item.textContent?.includes('←')),
        () => `The back button tooltip did not display the remapped key (disabled=${back.disabled}, focused=${document.activeElement === back})`);
      assert(heading().textContent === other.name && await press('ArrowLeft', heading(), { shiftKey: true }) && heading().textContent === home.name,
        'Remapped Back did not restore the previous project');
      assert(await press('ArrowRight', heading(), { shiftKey: true }) && heading().textContent === other.name,
        'Remapped Forward did not restore the next project');
      assert(await press('b', heading(), { shiftKey: true }) && document.querySelector<HTMLElement>('.workspace-sidebar')?.hidden,
        'The recorded sidebar action did not toggle the sidebar');
      await press('b', heading(), { shiftKey: true });
      const files = button('shell:app.hideFiles');
      assert(await press('e', heading(), { shiftKey: true }) && files.getAttribute('aria-pressed') === 'false', 'The recorded file action did not toggle the file panel');

      await act(async () => { root.render(null); await tick(); });
      await launch();
      assert(await press('k', heading()) && settings() && aria('shell:commandPalette.trigger') === shifted('K'), 'Custom shortcuts did not survive a renderer restart');
      await click('shell:shortcuts.title');
      await restore('visitBack');
      assert(aria('shell:app.visitBack') === `${primary}+[` && aria('shell:app.visitForward') === shifted('ArrowRight'),
        'Restoring one shortcut changed another shortcut or did not restore the platform default');
      await restore('commandPalette');
      assert(row('commandPalette').querySelector('[role=alert]')?.textContent?.includes('Settings')
        && aria('shell:commandPalette.trigger') === shifted('K'), 'Restoring a conflicting default overwrote another action');
      await click('shell:shortcuts.restoreAll');
      assert(aria('shell:commandPalette.trigger') === `${primary}+K` && aria('shell:preferences.open') === `${primary}+,`
        && aria('shell:app.visitForward') === `${primary}+]` && !aria('shell:app.hideSidebar'), 'Restore all did not atomically reset the registry');
    } finally {
      await act(async () => { root.render(null); await tick(); });
      if (saved === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, saved);
    }
  },
  'VISIT-HISTORY: cross-project traversal returns to the active split and conversation reading position': async () => {
    const source: Session = { ...session, id: 'visits-source', title: 'Original session',
      draft: { text: 'Preserved draft' }, messages: messageRange(0, 100) };
    const sibling: Session = { ...session, id: 'visits-sibling', title: 'Second session', status: 'running' };
    const extra = (['waiting_approval', 'waiting_children', 'queued'] as const).map(status => ({ ...session, id: `visits-${status}`, status }));
    const elsewhere: Session = { ...session, id: 'visits-elsewhere', title: 'Elsewhere', cwd: '/visits-other' };
    const sourceTab = { kind: 'agent' as const, id: 'visits-source-tab', sessionId: source.id };
    const siblingTab = { kind: 'agent' as const, id: 'visits-sibling-tab', sessionId: sibling.id };
    const otherTab = { kind: 'agent' as const, id: 'visits-other-tab', sessionId: elsewhere.id };
    const original: Workspace = { ...workspace, tabs: [sourceTab, siblingTab], activeTabId: sourceTab.id,
      secondaryTabId: siblingTab.id, splitRatio: 0.6 };
    const other: Workspace = { ...workspace, id: 'visits-other', name: 'Other project', cwd: elsewhere.cwd, tabs: [otherTab], activeTabId: otherTab.id };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [source, sibling, ...extra, elsewhere],
      workspaces: [original, other], providers: [provider] };
    let publish = (_value: Snapshot) => {};
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => snapshot,
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      activateTab: async (id: string, tabId: string) => {
        snapshot = { ...snapshot, workspaces: snapshot.workspaces.map(project => project.id !== id ? project : { ...project,
          activeTabId: tabId, secondaryTabId: project.activeTabId!, secondaryPlacement: project.secondaryPlacement === 'before' ? 'after' : 'before' }) };
        publish(snapshot);
      },
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>);
    const activeTab = () => document.querySelector('.tab-select[aria-current=page]')?.textContent;
    const viewport = (id: string) => document.querySelector<HTMLDivElement>(`[data-chat-session-id="${id}"] .message-scroll`)!;
    const at = (id: string) => viewport(id)?.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
    const panes = () => [...document.querySelectorAll<HTMLElement>('[data-workspace-pane]')].map(pane => pane.dataset.workspacePane).join(',');
    await waitFor(() => Boolean(viewport(source.id)), 'The original split did not load');
    await frames(5);
    const initial = viewport(source.id);
    await act(async () => {
      initial.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      initial.scrollTop = 350;
      initial.dispatchEvent(new Event('scroll'));
      await tick();
    });
    await frames(4);
    const visible = [...initial.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > initial.getBoundingClientRect().top);
    assert(visible?.dataset.messageId, 'The reading point was outside the virtual viewport');
    const anchorId = visible.dataset.messageId;
    const anchorOffset = visible.getBoundingClientRect().top - initial.getBoundingClientRect().top;
    const row = document.querySelector<HTMLElement>(`[data-workspace-id="${workspace.id}"]`)!;
    for (const status of ['running', 'waiting_approval', 'waiting_children', 'queued']) {
      assert(row.textContent?.includes(`1 · ${translate(`shell:status.${status}`)}`), `Missing ${status} project count`);
    }
    const toggle = row.parentElement!.querySelector<HTMLButtonElement>('.workspace-session-toggle')!;
    await act(async () => { toggle.focus(); toggle.click(); await tick(); });
    assert(toggle === document.activeElement && toggle.getAttribute('aria-expanded') === 'true' && activeTab() === source.title,
      'Expanding sessions moved focus or activated a session');
    await act(async () => {
      document.querySelector<HTMLButtonElement>(`[data-workspace-pane="${siblingTab.id}"]`)?.focus();
      [...document.querySelectorAll<HTMLButtonElement>('.tab-select')].find(item => item.textContent?.startsWith(sibling.title))!.click();
      await tick();
    });
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-workspace-id="${other.id}"]`)!.click(); await tick(); });
    await click('shell:app.history');
    const key = (value: string) => act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: value, ...(navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true }), cancelable: true }));
      await tick();
    });
    await key('[');
    assert(activeTab() === elsewhere.title && document.activeElement === viewport(elsewhere.id), 'Back did not focus the other project conversation');
    await click('shell:app.visitBack');
    assert(activeTab() === sibling.title && panes() === `${sourceTab.id},${siblingTab.id}`, 'Back did not restore the selected split tab');
    await key('[');
    assert(activeTab() === source.title && panes() === `${sourceTab.id},${siblingTab.id}`, 'Back moved or merged the original split');
    await waitFor(() => {
      const restored = at(source.id);
      return Boolean(restored && Math.abs(restored.getBoundingClientRect().top - viewport(source.id).getBoundingClientRect().top - anchorOffset) < 5);
    }, 'Back did not restore the original message and viewport offset');
    assert(document.activeElement === viewport(source.id) && input('[data-chat-session-id="visits-source"] .composer textarea').value === 'Preserved draft',
      'Back lost conversation focus or changed the draft');
    await click('shell:app.visitForward');
    assert(activeTab() === sibling.title, 'Forward missed the sibling tab');
    await key(']');
    assert(activeTab() === elsewhere.title, 'Forward missed the other project');
  },
  'SESSION-LOCATION: new session keeps the drafted task while selecting a working directory and branch': async () => {
    const origin = { ...workspace, id: 'session-location-origin', name: 'Origin', cwd: '/location-source' };
    const busySession = { ...session, id: 'session-location-busy', cwd: origin.cwd, status: 'running' as const };
    const registered = { cwd: '/location-registered', branch: 'existing' };
    const managed = { planId: '46dd6ee4-3b35-4a1b-98ca-600596c0b248', cwd: '/managed/location', branch: 'ensemble/location' };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [busySession], workspaces: [origin], providers: [provider] };
    let publish = (_value: Snapshot) => {};
    const commands: Parameters<Window['workbench']['createSession']>[0][] = [];
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => snapshot,
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      sessionLocations: async () => ({ current: { cwd: origin.cwd, branch: 'main' }, repository: true, worktrees: [registered],
        branches: ['refs/heads/main', 'refs/heads/review'], managed }),
      createSession: async (command: typeof commands[number]) => {
        commands.push(command);
        const created = { ...session, cwd: managed.cwd, title: command.title, id: 'created-at-location', draft: { text: command.initialDraft! } };
        const tab = { kind: 'agent' as const, id: 'created-location-tab', sessionId: created.id };
        snapshot = { ...snapshot, sessions: [busySession, created], workspaces: [origin, { ...workspace, id: 'target-location',
          name: 'Managed worktree', cwd: managed.cwd, tabs: [tab], activeTabId: tab.id }] };
        publish(snapshot);
        return created.id;
      },
      sendPrompt: async () => { throw new Error('Creating the draft must not send it'); },
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>);
    const shortcut = (isComposing = false) => act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ...(navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true }), isComposing, cancelable: true }));
      await tick();
    });
    const modal = () => document.querySelector<HTMLDialogElement>('dialog[open]');
    await shortcut(true);
    assert(!modal(), 'The shortcut opened a dialog during IME composition');
    await shortcut();
    await waitFor(() => Boolean(modal()?.textContent?.includes(origin.cwd)), 'The new session dialog did not confirm the current directory');
    assert(modal()?.textContent?.includes('Choose a separate worktree'), 'The busy directory did not explain worktree alternatives');
    await change(input('dialog[open] textarea'), 'Review the implementation');
    const select = (key: string) => modal()?.querySelector<HTMLButtonElement>(`[role=combobox][aria-label="${translate(key)}"]`)!;
    const directoryChoice = select('shell:app.sessionDirectory');
    await chooseOption(directoryChoice, 'registered');
    assert(modal()?.textContent?.includes(registered.cwd) && modal()?.textContent?.includes(registered.branch), 'The registered worktree path and branch were not visible');
    await chooseOption(directoryChoice, 'managed');
    await chooseOption(select('shell:app.sessionBaseBranch'), 'refs/heads/review');
    assert(modal()?.textContent?.includes(managed.cwd) && modal()?.textContent?.includes(managed.branch), 'The new checkout path and branch were not visible');
    assert(input('dialog[open] textarea').value === 'Review the implementation', 'Selecting a worktree changed the draft');
    await click('shell:app.createSession');
    await waitFor(() => Boolean(document.querySelector('[data-chat-session-id="created-at-location"] .composer textarea')), 'The created session did not open in its worktree');
    const choice = commands[0]?.location?.choice;
    assert(commands.length === 1 && commands[0].commandId && commands[0].initialDraft === 'Review the implementation'
      && choice?.kind === 'managed' && choice.fromRef === 'refs/heads/review' && choice.cwd === managed.cwd,
    'The create command lost the draft, location, or selected branch');
    assert(input('[data-chat-session-id="created-at-location"] .composer textarea').value === 'Review the implementation', 'The task was missing from the new composer');
  },
  'TERMINAL-CLOSE-01: collapsing a running terminal preserves its process and reopen uses the same output': async () => {
    const info = { id: 'terminal-close-fixture', workspaceId: workspace.id, title: 'zsh', status: 'running' as const, exitCode: null, output: '', outputOffset: 0 };
    const tab = { id: 'terminal-close-tab', kind: 'terminal' as const, terminalId: info.id };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), terminals: [info], workspaces: [{ ...workspace, tabs: [tab], activeTabId: tab.id }] };
    let publish = (_snapshot: Snapshot) => {};
    const closed: [string, string, boolean | undefined][] = [];
    const subscriptions: string[] = [];
    const stops: string[] = [];
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => snapshot,
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      resizeTerminal: async () => {},
      onTerminalOutput: (id: string) => { subscriptions.push(id); return () => {}; },
      stopTerminal: async (id: string) => { stops.push(id); },
      closeTab: async (id: string, tabId: string, confirmStop?: boolean) => {
        closed.push([id, tabId, confirmStop]);
        snapshot = { ...snapshot, workspaces: [{ ...workspace, tabs: [], activeTabId: null }] };
        publish(snapshot);
      },
    } as unknown as Window['workbench'];
    await render(<App />);
    await waitFor(() => subscriptions.length === 1, 'The running terminal did not open');
    const clickClose = () => act(async () => { document.querySelector<HTMLButtonElement>('.tab-close')!.click(); await tick(); });
    await clickClose();
    assert(document.querySelector('dialog[open]') && !closed.length, 'Closing a running tab bypassed the confirmation');
    await act(async () => {
      const hide = [...document.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(item => item.textContent === translate('app.hideTerminal'));
      assert(hide, 'The dialog did not offer collapsing the terminal');
      hide.click(); await tick();
    });
    assert(!closed.length && !stops.length && !document.querySelector('.terminal-surface') && document.querySelector('.tab-select'), 'Collapsing ended the process or removed its tab');
    await click('app.showTerminal');
    await waitFor(() => subscriptions.length === 2, 'Reopening did not restore the terminal subscription');
    assert(subscriptions.every(id => id === info.id), 'Reopening started a different terminal');
    await click('workspace:common.stop');
    await click('common.cancel');
    assert(!stops.length, 'Cancelling still stopped the process');
    await clickClose();
    await click('app.stopAndCloseTerminal');
    assert(JSON.stringify(closed) === JSON.stringify([[workspace.id, tab.id, true]]) && !document.querySelector('.tab-close'), 'The confirmed close did not end the matching terminal tab');
  },
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
    const feedback: PromptInput[] = [];
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: () => () => {},
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {},
      listFiles: async () => [], gitState: async () => ({ available: false, branch: '', changes: [] }), setUnsavedFiles: () => {},
      searchWorkspaceText: async (_id: string, query: string) => ({
        matches: query === 'Line 40' ? [{ path: 'src/view.ts', line: 40, column: 3, preview: 'Line 40' }] : [],
        limited: false,
      }),
      fileDiff: async (_id: string, path: string) => ({
        path, patch: 'Staged changes\n@@ -40 +40 @@\n-before staged\n+Staged line\nWorking tree changes\n@@ -40 +40 @@\n-before working\n+Line 40',
        revision: 'reference-diff-r1', binary: false, truncated: false,
      }),
      saveSessionDraft: async (_id: string, value: PromptInput) => { feedback.push(value); },
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
    await waitFor(() => editor()?.state.doc.lineAt(editor()!.state.selection.main.head).number === 8, 'The other reference did not open in a new tab');
    assert(editor() !== view && reads.join() === 'src/view.ts,src/other.ts' && document.querySelector('.tab-select[aria-current="page"]')?.textContent?.includes(session.title),
      'File navigation read an unrelated file or switched the conversation');
    await click('shell:commandPalette.trigger');
    await change(input('.command-palette input[role=combobox]'), 'Line 40');
    const hit = () => [...document.querySelectorAll<HTMLElement>('.command-palette [role=option]')]
      .find(item => item.textContent?.includes('src/view.ts:40:3'));
    await waitFor(() => !!hit(), 'The text result did not show the exact reference');
    await act(async () => { hit()?.click(); await tick(); });
    await waitFor(() => editor()?.state.selection.main.head === editor()!.state.doc.line(40).from + 2, 'The search hit did not restore the line and column');
    assert(editor()!.state.doc.toString().startsWith('Draft: ') && Number(reads.length) === 2, 'Returning to the first file lost or reread its draft');
    await act(async () => { editor()!.dispatch({ changes: { from: 0, to: 'Draft: '.length } }); await tick(); });
    await click('Diff');
    await waitFor(() => !!document.querySelector('.review-diff-line[data-reference]'), 'Diff did not reveal the search result line');
    const diffLine = document.querySelector('.review-diff-line[data-reference]');
    assert(diffLine?.querySelector('code')?.textContent === '+Line 40', 'Diff jumped to the staged line instead of the working tree match');
    await act(async () => { diffLine?.querySelector<HTMLButtonElement>('button[data-side="modified"]')?.click(); await tick(); });
    await change(input('.review-note-editor textarea'), 'Please check the matched line');
    await click('workspace:files.saveNote');
    await click('workspace:files.notesToDraft');
    await waitFor(() => feedback.some(value => value.text.includes('Please check the matched line') &&
      value.text.includes('src/view.ts') && value.text.includes('Diff: working')), 'The anchored note did not reach the active session draft');
  },
  'FILE-EDITOR: find, line wrapping and opt-in autosave use the current draft': async () => {
    const storageKey = 'ensemble.file-editor';
    const previous = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    const project = { ...workspace, id: 'editor-controls' };
    const path = 'editor-controls.txt';
    const original = `needle first\nneedle second\n${'long text '.repeat(100)}`;
    let disk: FileContent = { path, content: original, size: original.length, language: 'text', revision: 'r0' };
    let summary: UnsavedFileSummary = { count: 0, names: [] };
    const writes: Array<{ path: string; content: string; revision: string }> = [];
    const firstWrite = deferred<void>();
    const delayedReload = deferred<void>();
    let reading: Promise<void> | undefined;
    window.workbench = {
      listFiles: async () => [{ path, name: path, kind: 'file', size: disk.size }],
      gitState: async () => ({ available: false }),
      readFile: async () => { await reading; return disk; },
      writeFile: async (_id: string, input: typeof writes[number]) => {
        writes.push(input);
        if (writes.length === 1) await firstWrite.promise;
        if (disk.revision !== input.revision) throw new Error('File changed on disk; reload before saving');
        disk = { ...disk, content: input.content, size: input.content.length, revision: `r${writes.length}` };
        return disk;
      },
      setUnsavedFiles: (value: UnsavedFileSummary) => { summary = value; },
    } as unknown as Window['workbench'];
    const show = (key: string) => render(<WorkspaceFileNavigation.Provider value={{
      cwd: project.cwd, open: () => {}, consume: () => {}, request: { workspaceId: project.id, path, line: 1 },
    }}><FileReviewPanel key={key} workspace={project} refreshKey="r0" perform={perform} /></WorkspaceFileNavigation.Provider>);
    const view = () => {
      const dom = document.querySelector<HTMLElement>('.review-editor .cm-editor');
      assert(dom, 'The actual CodeMirror editor was not mounted');
      return EditorView.findFromDOM(dom)!;
    };
    const key = (name: string, init: KeyboardEventInit = {}) => act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
      await tick();
    });
    const edit = (value: string) => act(async () => {
      const editor = view();
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: value } });
      await tick();
    });
    const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
    const find = 'workspace:editor.find', wrap = 'workspace:editor.wrapLines', autoSave = 'workspace:editor.autoSave';
    const wraps = () => getComputedStyle(view().contentDOM).whiteSpace === 'break-spaces';
    try {
      await show('initial');
      const editor = view();
      const shortcut = navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true };
      button('workspace:files.refresh').focus();
      await key('f', shortcut);
      assert(!document.querySelector('.cm-file-find'), 'Find opened when focus was outside the editor');
      editor.focus();
      await key('f', shortcut);
      const field = input('.cm-file-find input');
      assert(document.activeElement === field, 'Find did not focus the query field');
      await change(field, 'needle');
      await key('Enter', { isComposing: true });
      assert(editor.state.selection.main.empty, 'Find navigated while an input method was composing');
      await key('Enter');
      assert(editor.state.selection.main.from === 0 && !editor.state.selection.main.empty, 'Find did not select the first match');
      await key('Enter');
      assert(editor.state.selection.main.from === original.indexOf('needle second'), 'Enter did not select the next match');
      await key('Enter', { shiftKey: true });
      assert(editor.state.selection.main.from === 0, 'Shift+Enter did not select the previous match');
      await key('Escape');
      assert(!document.querySelector('.cm-file-find') && document.activeElement === editor.contentDOM, 'Escape did not return focus to the file');
      await click(find);
      assert(document.activeElement === input('.cm-file-find input'), 'The toolbar did not open find');
      await key('Escape');
      assert(!wraps(), 'Long lines wrapped before the preference was enabled');
      await click(wrap);
      assert(view() === editor && wraps() && editor.state.doc.toString() === original,
        'Wrap changed the file or remounted CodeMirror');
      assert(button(autoSave).getAttribute('aria-pressed') === 'false', 'Auto Save was not opt-in');
      await edit('\nmanual draft');
      await wait(1100);
      assert(writes.length === 0 && summary.count === 1, 'Auto Save wrote before consent');
      await click(autoSave);
      await wait(450);
      await edit(' more');
      await wait(650);
      assert(writes.length === 0, 'Typing did not restart the idle delay');
      await waitFor(() => writes.length === 1, 'The editor did not save after the idle delay');
      assert(writes[0].revision === 'r0' && writes[0].content === `${original}\nmanual draft more` && !editor.state.readOnly,
        'Auto Save omitted the latest text or revision, or locked editing during the write');
      await edit(' and newer');
      await act(async () => { firstWrite.resolve(); await tick(); });
      assert(disk.revision === 'r1' && editor.state.doc.toString().endsWith(' more and newer') && summary.count === 1,
        'Completing the first save discarded a newer edit');
      disk = { ...disk, content: 'External edit', size: 'External edit'.length, revision: 'external' };
      await waitFor(() => Number(writes.length) === 2 && !!document.querySelector('.file-review-panel [role=alert]'),
        'A revision conflict was not shown', 130);
      assert(writes[1].revision === 'r1' && disk.content === 'External edit' && editor.state.doc.toString().endsWith(' more and newer'),
        'The next save skipped revision validation, overwrote the external edit, or lost the draft');
      await edit(' after conflict');
      await wait(1100);
      assert(Number(writes.length) === 2 && summary.count === 1, 'Auto Save retried a conflicted file');
      await click('workspace:files.reloadDiscard');
      assert(view().state.doc.toString() === 'External edit' && Number(summary.count) === 0, 'Reload did not resolve the paused draft');
      await show('reopened');
      assert(wraps() && button(autoSave).getAttribute('aria-pressed') === 'true', 'Editor preferences did not persist after reopening');
      await edit(' discard me');
      reading = delayedReload.promise;
      await click('workspace:files.reloadDiscard');
      await wait(1100);
      assert(Number(writes.length) === 2 && disk.content === 'External edit', 'Auto Save wrote a draft while Reload was discarding it');
      delayedReload.resolve();
      await settle();
      assert(view().state.doc.toString() === 'External edit' && Number(summary.count) === 0, 'A slow Reload did not discard the draft');
      await edit(' pending');
      await click(autoSave);
      await wait(1100);
      assert(Number(writes.length) === 2 && summary.count === 1, 'Turning off Auto Save left a delayed write scheduled');
      await click('workspace:files.reloadDiscard');
    } finally {
      firstWrite.resolve();
      delayedReload.resolve();
      if (document.querySelector(`button[aria-label="${translate(autoSave)}"][aria-pressed="true"]`)) await click(autoSave);
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  },
  'FILE-DISK: the visible file adopts disk changes or keeps its conflicting draft': async () => {
    const key = 'ensemble.file-editor';
    const preferences = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify({ autoSave: true }));
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const focus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    let visible = false;
    let focused = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
    const setVisibility = (next: boolean) => { visible = next; document.dispatchEvent(new Event('visibilitychange')); };
    const checkNow = () => act(async () => { setVisibility(false); setVisibility(true); await tick(); });
    const path = 'watched-file.txt', other = 'other-watched-file.txt';
    const original = Array.from({ length: 120 }, (_, index) => `File line ${index + 1}`).join('\n');
    const file = (path: string, revision: string, content: string): FileContent => ({ path, revision, content, language: 'text', size: content.length });
    const project = { ...workspace, id: 'file-disk' };
    let disk: FileContent | null = file(path, 'r0', original);
    let denied = false;
    const delayed = deferred<FileContent>();
    let holdRead = false;
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string; revision: string }> = [];
    window.workbench = {
      listFiles: async () => [path, other].map(path => ({ path, name: path, kind: 'file', size: 0 })),
      gitState: async () => ({ available: false }),
      readFile: async (_id: string, selected: string) => {
        reads.push(selected);
        if (selected === other) return file(other, 'other', 'Other file');
        if (holdRead) return delayed.promise;
        if (denied) throw new Error('EACCES fixture');
        return disk;
      },
      writeFile: async (_id: string, input: typeof writes[number]) => {
        writes.push(input);
        throw new Error('File changed on disk; reload before saving');
      },
      setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    const show = (path: string, panelVisible = true) => render(<div style={{ display: 'flex', width: 360, height: 520 }}>
      <WorkspaceFileNavigation.Provider value={{ cwd: project.cwd, open: () => {}, consume: () => {}, request: { workspaceId: project.id, path, line: 1 } }}>
        <FileReviewPanel workspace={project} refreshKey="disk" perform={perform} visible={panelVisible} />
      </WorkspaceFileNavigation.Provider>
    </div>);
    const view = () => {
      const dom = document.querySelector<HTMLElement>('.review-editor .cm-editor');
      return dom ? EditorView.findFromDOM(dom) : null;
    };
    const notice = () => document.querySelector('.file-review-panel [data-file-disk-status]');
    try {
      await show(path);
      const editor = view();
      assert(editor, 'CodeMirror did not open the watched file');
      await act(async () => {
        const anchor = editor.state.doc.line(50).from + 5;
        editor.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'start' }) });
        await tick();
      });
      await waitFor(() => editor.scrollDOM.scrollTop > 300, 'The fixture did not scroll to the selected line');
      const anchorText = () => editor.state.doc.lineAt(editor.lineBlockAtHeight(editor.scrollDOM.scrollTop).from).text;
      const previousTop = anchorText();
      await checkNow();
      disk = file(path, 'r1', `Inserted above\r\n${original.replaceAll('\n', '\r\n')}`);
      await wait(3100);
      await waitFor(() => editor.state.sliceDoc() === disk?.content, 'The clean file did not load the external edit on a scheduled check');
      const selection = editor.state.selection.main.head;
      assert(view() === editor && selection === editor.state.doc.line(51).from + 5 && editor.state.lineBreak === '\r\n',
        'Updating a clean file lost the editor, cursor or disk line endings');
      await waitFor(() => anchorText() === previousTop, 'Updating a clean file moved the viewport away from the same text');

      await act(async () => { editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' local draft' } }); await tick(); });
      const draft = editor.state.sliceDoc();
      disk = file(path, 'r2', 'External draft conflict');
      await checkNow();
      assert(notice()?.textContent === translate('workspace:files.changedDraft') && editor.state.sliceDoc() === draft,
        'A changed file replaced the draft or omitted the conflict notice');
      await wait(1100);
      assert(writes.length === 0, 'Auto Save attempted to write a known conflict');
      await click('workspace:common.save');
      assert(writes[0]?.revision === 'r1' && writes[0]?.content === draft && editor.state.sliceDoc() === draft,
        'Manual Save did not use the retained original revision');
      await click('workspace:files.reloadDiscard');
      assert(editor.state.sliceDoc() === 'External draft conflict' && !notice(), 'Reload did not adopt the disk version');

      await act(async () => { editor.dispatch({ changes: { from: 0, insert: 'Unwritten ' } }); await tick(); });
      disk = null;
      await checkNow();
      const missing = notice();
      assert(missing?.textContent === translate('workspace:files.missingDraft') && editor.state.sliceDoc() === 'Unwritten External draft conflict',
        'A missing file cleared the dirty buffer or hid the deletion');
      await checkNow();
      assert(notice() === missing, 'Repeated deletion checks replaced the notice');
      denied = true;
      await checkNow();
      assert(notice()?.textContent === translate('workspace:files.unreadableDraft'), 'An unreadable file was reported as deleted');
      denied = false;
      disk = file(path, 'r3', 'Restored file');
      await click('workspace:files.reloadDiscard');

      holdRead = true;
      await checkNow();
      await show(other);
      assert(view()?.state.sliceDoc() === 'Other file', 'An old disk check blocked switching files');
      const readsBefore = reads.length;
      await checkNow();
      assert(reads.length === readsBefore, 'A second disk check started while the old request was pending');
      await act(async () => { delayed.resolve(file(path, 'old-result', 'Old check result')); await tick(); });
      assert(view()?.state.sliceDoc() === 'Other file' && !notice(), 'A stale disk response updated the current editor');
      await show(other, false);
      const hiddenReads = reads.length;
      await checkNow();
      assert(reads.length === hiddenReads, 'A hidden editor triggered a disk check');
      await show(other);
      focused = false;
      window.dispatchEvent(new Event('blur'));
      await wait(3100);
      assert(reads.length === hiddenReads, 'An inactive window kept checking the disk');
      focused = true;
      window.dispatchEvent(new Event('focus'));
      await waitFor(() => reads.length === hiddenReads + 1, 'The disk check did not resume when the window regained focus');
    } finally {
      delayed.resolve(file(path, 'cleanup', original));
      setVisibility(false);
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility); else Reflect.deleteProperty(document, 'visibilityState');
      if (focus) Object.defineProperty(document, 'hasFocus', focus); else Reflect.deleteProperty(document, 'hasFocus');
      if (preferences === null) localStorage.removeItem(key); else localStorage.setItem(key, preferences);
    }
  },
  'FILE-TABS: independent drafts survive switches and guarded closes': async () => {
    const key = 'ensemble.file-editor';
    const preferences = localStorage.getItem(key);
    localStorage.removeItem(key);
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const focus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    let visible = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const project = { ...workspace, id: 'file-tabs' };
    const first = 'first.txt', second = 'second.txt', delayedPath = 'delayed.txt';
    const delayed = deferred<FileContent>();
    const createFile = (path: string, content: string, revision = path): FileContent => ({ path, content, revision, language: 'text', size: content.length });
    const firstText = Array.from({ length: 120 }, (_, index) => `First line ${index + 1}`).join('\n');
    const disk = new Map([[first, createFile(first, firstText)], [second, createFile(second, 'Second only')]]);
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string; revision: string }> = [];
    let summary: UnsavedFileSummary = { count: 0, names: [] };
    window.workbench = {
      listFiles: async () => [first, second, delayedPath].map(path => ({ path, name: path, kind: 'file', size: 0 })),
      gitState: async () => ({ available: false }),
      readFile: async (_id: string, path: string) => {
        reads.push(path);
        return path === delayedPath ? delayed.promise : disk.get(path) ?? null;
      },
      writeFile: async (_id: string, input: typeof writes[number]) => {
        writes.push(input);
        if (disk.get(input.path)?.revision !== input.revision) throw new Error('File changed on disk; reload before saving');
        const written = createFile(input.path, input.content, `saved-${writes.length}`);
        disk.set(input.path, written);
        return written;
      },
      setUnsavedFiles: (value: UnsavedFileSummary) => { summary = value; },
    } as unknown as Window['workbench'];
    const view = () => {
      const dom = document.querySelector<HTMLElement>('.review-editor .cm-editor');
      assert(dom, 'The actual CodeMirror editor was not mounted');
      return EditorView.findFromDOM(dom)!;
    };
    const tab = (path: string) => document.querySelector<HTMLButtonElement>(`.file-editor-tabs [role=tab][title="${path}"]`);
    const activePath = () => document.querySelector('.file-editor-tabs [aria-selected=true]')?.getAttribute('title');
    const open = (path: string) => act(async () => {
      const row = [...document.querySelectorAll<HTMLButtonElement>('.tree-row')].find(row => row.title === path);
      assert(row, `Missing file tree row for ${path}`);
      row.click();
      await tick();
    });
    const select = (path: string) => act(async () => { tab(path)?.click(); await tick(); });
    const close = (path: string) => click(`Close ${path}`);
    const edit = (suffix: string) => act(async () => {
      const editor = view();
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: suffix } });
      await tick();
    });
    const setVisibility = (next: boolean) => { visible = next; document.dispatchEvent(new Event('visibilitychange')); };
    const checkNow = () => act(async () => { setVisibility(false); setVisibility(true); await tick(); });
    const topLine = () => view().state.doc.lineAt(view().lineBlockAtHeight(view().scrollDOM.scrollTop).from).number;
    try {
      await render(<div data-test-actual-editor style={{ display: 'flex', width: 380, height: 540 }}><FileReviewPanel workspace={project} refreshKey="tabs" perform={perform} /></div>);
      await open(first);
      await edit('\nFirst draft');
      const selection = { anchor: view().state.doc.line(54).from + 1, head: view().state.doc.line(54).from + 6 };
      await act(async () => { view().dispatch({ selection, effects: EditorView.scrollIntoView(selection.head, { y: 'start' }) }); await tick(); });
      await waitFor(() => view().scrollDOM.scrollTop > 300, 'The first tab could not be scrolled');
      const scrolledLine = topLine();
      const scrollTop = view().scrollDOM.scrollTop;
      await open(second);
      await edit('\nSecond draft');
      assert(activePath() === second && document.querySelectorAll('.file-editor-tab[data-dirty=true]').length === 2 && summary.count === 2,
        'Opening the second tab did not preserve two independent drafts');
      await act(async () => {
        tab(second)?.focus();
        tab(second)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        await tick();
      });
      assert(activePath() === first && view().state.sliceDoc().endsWith('First draft')
        && view().state.selection.main.anchor === selection.anchor && view().state.selection.main.head === selection.head,
      'Keyboard switching lost the first draft or selection');
      await waitFor(() => topLine() === scrolledLine, () => `Returning to the first tab moved line ${scrolledLine} at ${scrollTop}px to line ${topLine()} at ${view().scrollDOM.scrollTop}px`);
      await click('workspace:editor.find');
      assert(document.activeElement === input('.cm-file-find input'), 'Find did not open in the active tab');
      await change(input('.cm-file-find input'), 'First draft');
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await tick();
      });
      assert(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to) === 'First draft',
        'Find did not search the active draft');

      await open(delayedPath);
      await select(second);
      await act(async () => { delayed.resolve(createFile(delayedPath, 'Late read')); await tick(); });
      assert(activePath() === second && !tab(delayedPath) && view().state.sliceDoc().endsWith('Second draft'),
        'An old file read changed the active tab or replaced the second draft');
      disk.set(first, createFile(first, 'External first edit', 'external'));
      await checkNow();
      assert(reads.at(-1) === second && !document.querySelector('[data-file-disk-status]'), 'The background check read an inactive tab');
      await select(first);
      await checkNow();
      assert(document.querySelector('[data-file-disk-status="changed"]') && view().state.sliceDoc().endsWith('First draft'),
        'The first tab lost its draft after a disk conflict');

      await close(first);
      await click('workspace:common.cancel');
      assert(tab(first) && tab(second) && summary.count === 2, 'Cancel changed an open draft');
      await close(first);
      await click('workspace:files.saveAndClose');
      assert(tab(first) && document.querySelector('dialog[open] [role=alert]') && writes[0]?.revision === first,
        'A failed save closed the conflicted tab or used a newer revision');
      await click('workspace:files.discardAndClose');
      assert(!tab(first) && activePath() === second && view().state.sliceDoc().endsWith('Second draft') && Number(summary.count) === 1,
        'Discarding the first tab changed the second draft');
      await close(second);
      await click('workspace:files.saveAndClose');
      assert(!tab(second) && disk.get(second)?.content.endsWith('Second draft') && Number(summary.count) === 0,
        'Save and close did not write and close the second tab');

      await open(first);
      await open(second);
      await select(first);
      await click('workspace:editor.autoSave');
      await edit('\nBackground save');
      await select(second);
      await waitFor(() => disk.get(first)?.content.endsWith('Background save') === true, 'Switching away cancelled an already scheduled Auto Save', 130);
      assert(activePath() === second && !tab(first)?.closest('[data-dirty=true]') && Number(summary.count) === 0,
        'Saving an inactive tab changed the selected file or left it dirty');
    } finally {
      delayed.resolve(createFile(delayedPath, 'Cleanup'));
      setVisibility(false);
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility); else Reflect.deleteProperty(document, 'visibilityState');
      if (focus) Object.defineProperty(document, 'hasFocus', focus); else Reflect.deleteProperty(document, 'hasFocus');
      if (preferences === null) localStorage.removeItem(key); else localStorage.setItem(key, preferences);
    }
  },
  'FILE-PREVIEWS: Markdown follows the draft and raster tabs stay read-only': async () => {
    const key = 'ensemble.file-editor';
    const preferences = localStorage.getItem(key);
    localStorage.removeItem(key);
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const focus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    let visible = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const project = { ...workspace, id: 'file-previews' };
    const note = 'note.md', picture = 'picture.PNG', binary = 'unknown.bin';
    const markdown = [
      '# Original heading', '**Draft body**',
      '![Remote image description](https://example.invalid/asset.png)',
      '<img src="https://example.invalid/raw.png" onerror="alert(1)">',
      '<script>window.renderedMarkdownScript = true</script>',
      '[Read more](https://example.invalid/guide) [Unsafe link](javascript:alert%281%29)',
    ].join('\n\n');
    let contents: FileContent = { path: note, content: markdown, language: 'markdown', size: markdown.length, revision: 'markdown-r0' };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
    const reads: string[] = [];
    const imageReads: string[] = [];
    let summary: UnsavedFileSummary = { count: 0, names: [] };
    window.workbench = {
      listFiles: async () => [note, picture, binary].map(path => ({ path, name: path, kind: 'file', size: 0 })),
      gitState: async () => ({ available: false }),
      readFile: async (_id: string, path: string) => {
        reads.push(path);
        if (path === binary) throw new Error('Binary files cannot be opened as text');
        return contents;
      },
      readFileImage: async (_id: string, path: string): Promise<FileImage> => {
        imageReads.push(path);
        return { path, base64: png, mimeType: 'image/png', size: 68, revision: `image-${imageReads.length}` };
      },
      setUnsavedFiles: (value: UnsavedFileSummary) => { summary = value; },
    } as unknown as Window['workbench'];
    const open = (path: string) => act(async () => {
      document.querySelector<HTMLButtonElement>(`.tree-row[title="${path}"]`)?.click();
      await tick();
    });
    const tab = (path: string) => document.querySelector<HTMLButtonElement>(`.file-editor-tabs [role=tab][title="${path}"]`);
    const select = (path: string) => act(async () => { tab(path)?.click(); await tick(); });
    const editor = () => {
      const dom = document.querySelector<HTMLElement>('.review-editor .cm-editor');
      assert(dom, 'The Markdown source editor was not present');
      return EditorView.findFromDOM(dom)!;
    };
    const preview = () => document.querySelector('.file-markdown-preview');
    const replaceHeading = (heading: string) => act(async () => {
      const view = editor();
      view.dispatch({ changes: { from: 2, to: view.state.doc.line(1).to, insert: heading }, selection: { anchor: 2, head: 7 } });
      await tick();
    });
    try {
      await render(<div data-test-actual-editor style={{ display: 'flex', width: 380, height: 540 }}><FileReviewPanel workspace={project} refreshKey="previews" perform={perform} /></div>);
      await open(note);
      await replaceHeading('First draft heading');
      await click('workspace:files.preview');
      assert(preview()?.querySelector('h1')?.textContent === 'First draft heading' && preview()?.querySelector('strong')?.textContent === 'Draft body',
        'Markdown rendered the disk version or lost its formatting');
      assert(!preview()?.querySelector('script, img, iframe, svg, [src], a[href]')
        && preview()?.textContent?.includes('Remote image description')
        && preview()?.querySelectorAll('.file-markdown-link').length === 1,
      'Markdown allowed embedded resources, raw HTML or an unsafe link');
      await click('workspace:files.source');
      assert(editor().state.selection.main.from === 2 && editor().state.selection.main.to === 7, 'Returning to source lost the selection');
      await replaceHeading('Updated draft heading');
      await click('workspace:files.preview');
      assert(preview()?.querySelector('h1')?.textContent === 'Updated draft heading' && summary.count === 1, 'Preview did not update with the draft');
      contents = { ...contents, content: '# External update', revision: 'markdown-r1' };
      await act(async () => { visible = true; document.dispatchEvent(new Event('visibilitychange')); await tick(); });
      assert(document.querySelector('[data-file-disk-status="changed"]') && preview()?.querySelector('h1')?.textContent === 'Updated draft heading',
        'Markdown preview stopped disk checking or replaced the draft');

      await open(picture);
      const img = () => document.querySelector<HTMLImageElement>('.file-image-preview img');
      await waitFor(() => img()?.naturalWidth === 1, 'The raster preview did not decode in Electron');
      assert(img()?.src.startsWith('data:image/png;base64,') && !document.querySelector('.review-save, .review-editor .cm-editor')
        && !tab(picture)?.closest('[data-dirty=true]') && summary.count === 1 && !reads.includes(picture),
      'An image opened as editable text or changed the draft summary');
      await click('workspace:files.reload');
      assert(imageReads.join() === `${picture},${picture}`, 'Reload did not use the image reader');
      await select(note);
      assert(preview()?.querySelector('h1')?.textContent === 'Updated draft heading', 'Switching tabs lost the Markdown preview or draft');
      await click(`Close ${picture}`);
      assert(!tab(picture) && !document.querySelector('dialog[open]'), 'A read-only image required a draft confirmation');
      await open(binary);
      assert(document.querySelector('.file-review-panel [role=alert]')?.textContent === 'Binary files cannot be opened as text'
        && !tab(binary) && !!preview(), 'Unsupported binary content replaced the selected preview');
      await click(`Close ${note}`);
      await click('workspace:files.discardAndClose');
    } finally {
      visible = false;
      document.dispatchEvent(new Event('visibilitychange'));
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility); else Reflect.deleteProperty(document, 'visibilityState');
      if (focus) Object.defineProperty(document, 'hasFocus', focus); else Reflect.deleteProperty(document, 'hasFocus');
      if (preferences === null) localStorage.removeItem(key); else localStorage.setItem(key, preferences);
    }
  },
  'SIDE-QUESTION: selected answers and Trace titles support a reliable independent follow-up': async () => {
    const response: Message = { id: 'side-answer', role: 'assistant', text: 'An earlier sentence. Quote just this. An extra sentence.', createdAt: session.createdAt };
    const event: Message = { id: 'side-trace', role: 'activity', text: 'Trace title', createdAt: session.createdAt,
      event: { id: 'trace', kind: 'tool', title: 'Trace title', status: 'running', input: 'Hidden input', output: 'Hidden output' } };
    const source: Session = { ...session, id: 'source-side-question', status: 'running', messages: [response, event] };
    const sent: Parameters<Window['workbench']['askSideQuestion']>[] = [];
    const opened: string[] = [];
    window.workbench = {
      commandReceipt: async () => undefined,
      askSideQuestion: async (...args: Parameters<Window['workbench']['askSideQuestion']>) => {
        sent.push(args);
        if (sent.length === 1) throw new Error('fixture response lost');
        return { sessionId: 'child-side-question', inSplit: false, waitingForProject: true };
      },
    } as unknown as Window['workbench'];
    const show = (overrides: Partial<Parameters<typeof SessionChat>[0]> = {}) => render(chat({
      session: source, draft: { text: 'Keep the main draft' }, openSession: id => { opened.push(id); }, ...overrides,
    }));
    await show();
    await waitFor(() => Boolean(document.querySelector('[data-message-id="side-trace"] .side-question-trigger')), 'The current Trace had no explicit follow-up action');
    const main = input('.composer textarea');
    const panel = () => document.querySelector<HTMLElement>('.side-question');
    const question = () => input('.side-question textarea');
    const chosen = document.querySelector('[data-message-id="side-answer"] .markdown-message p')!.firstChild!;
    await act(async () => {
      const range = document.createRange();
      const start = chosen.textContent!.indexOf('Quote');
      range.setStart(chosen, start);
      range.setEnd(chosen, start + 'Quote just this.'.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await tick();
    });
    const answerAction = document.querySelector<HTMLButtonElement>('[data-message-id="side-answer"] .side-question-trigger');
    assert(answerAction, 'Selecting rendered answer text did not offer a follow-up');
    await act(async () => { answerAction.click(); await tick(); });
    assert(panel()?.querySelector('blockquote')?.textContent === 'Quote just this.' && document.activeElement === question(), 'The selected quote or input focus was lost');
    await click('workspace:chat.sideQuestion.locate');
    await waitFor(() => Boolean(document.querySelector('[data-message-id="side-answer"].conversation-match')), 'The reference did not locate the original answer');
    await act(async () => { question().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); });
    assert(!panel() && (document.activeElement === answerAction || document.activeElement === document.querySelector('.message-scroll')), 'Escape did not close and restore focus to the conversation');
    assert(sent.length === 0 && main.value === 'Keep the main draft' && input('.composer textarea') === main, 'Opening or closing the side question created work or replaced the main composer');

    const traceAction = document.querySelector<HTMLButtonElement>('[data-message-id="side-trace"] .side-question-trigger')!;
    await act(async () => { traceAction.click(); await tick(); });
    assert(panel()?.querySelector('blockquote')?.textContent === event.event!.title && !panel()?.textContent?.includes('Hidden'), 'The Trace quotation exposed details outside the title');
    await change(question(), 'Why was this step needed?');
    await show({ connected: false });
    assert(button('workspace:chat.sideQuestion.send').disabled && question().value === 'Why was this step needed?', 'A disconnect enabled sending or erased the question');
    await show();
    await click('workspace:chat.sideQuestion.send');
    await waitFor(() => Boolean(panel()?.querySelector('[role=alert]')), 'A failed send did not retain a retry');
    assert(Number(sent.length) === 1 && question().value === 'Why was this step needed?' && (question() as HTMLTextAreaElement).readOnly,
      'A failed send lost the accepted command payload');
    await click('workspace:chat.sideQuestion.retry');
    await waitFor(() => Boolean(panel()?.querySelector('[role=status]')), 'Retry did not reveal the queued new tab');
    assert(Number(sent.length) === 2 && sent[0][2] === sent[1][2] && JSON.stringify(sent[1][1]) === JSON.stringify({
      question: 'Why was this step needed?', reference: { kind: 'trace', messageId: event.id },
    }), 'Retry changed the durable command or copied hidden output');
    assert(button('workspace:chat.sideQuestion.openTab').disabled, 'The tab was offered before its session snapshot arrived');
    await show({ sessions: [source, { ...session, id: 'child-side-question' }] });
    await click('workspace:chat.sideQuestion.openTab');
    assert(JSON.stringify(opened) === JSON.stringify(['child-side-question']) && !panel(), 'Opening the child tab did not use the existing session route');
    assert(document.activeElement === document.querySelector('[data-message-id="side-trace"] .side-question-trigger'), 'Closing after reconnect did not restore focus to the recreated Trace action');
    await show({ readOnly: true });
    assert(!document.querySelector('.side-question-trigger'), 'Read-only history exposed the follow-up action');
    await show({ provider: { ...provider, available: false } });
    assert(!document.querySelector('.side-question-trigger'), 'An unavailable runtime exposed the follow-up action');
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
  'AGENT-MESSAGE: grants require confirmation and the receiver sees the message origin': async () => {
    const source: Session = { ...session, status: 'running' };
    const target: Session = { ...session, id: 'message-target', title: 'Runtime review', providerId: 'claude', cwd: '/other-project' };
    const archived: Session = { ...target, id: 'archived-target', title: 'Archived review', archived: true };
    const writes: { sourceId: string; sessionId: string; enabled: boolean }[] = [];
    const grant = deferred<void>();
    let opened: string | undefined;
    let openedLink: [string, string] | undefined;
    let removed: string | undefined;
    window.workbench = {
      listSkills: async () => [],
      updateSession: async (sourceId: string, { messageTarget }: { messageTarget: { sessionId: string; enabled: boolean } }) => {
        writes.push({ sourceId, ...messageTarget });
        if (messageTarget.enabled) await grant.promise;
      },
      removeQueuedPrompt: async (_id: string, itemId: string) => { removed = itemId; },
    } as unknown as Window['workbench'];
    const show = (current: Session) => render(<SettingsDialog snapshot={null} workspace={workspace} session={current}
      sessions={[current, target, archived]} perform={perform} pending={new Set()} updates={idleUpdates}
      initialSection="session" openSession={() => {}} openSessionLink={(from, to) => { openedLink = [from, to]; }} onClose={() => {}} />);
    await show(source);
    await click('workspace:chat.addMessageTarget');
    const search = input('.session-message-target-picker [role=combobox]');
    const options = document.querySelectorAll<HTMLElement>('.session-message-target-picker [role=option]');
    assert(options.length === 1 && options[0].textContent?.includes(target.title), 'The picker included the current or archived session');
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await tick();
    });
    assert(!writes.at(0) && button('workspace:chat.confirmMessageTarget').disabled, 'Highlighting a conversation enabled or sent a grant');
    await act(async () => { options[0].click(); await tick(); });
    assert(!writes.at(0), 'Selecting a conversation granted access without confirmation');
    const confirm = button(translate('workspace:chat.confirmNamedMessageTarget', { title: target.title }));
    await act(async () => { confirm.click(); confirm.click(); await tick(); });
    assert(writes[0]?.sourceId === source.id && writes[0].sessionId === target.id && writes[0].enabled
      && !writes.at(1) && confirm.disabled, 'Confirmation failed to send exactly one grant to the selected session');
    grant.resolve();
    await settle();
    await show({ ...source, messageTargetIds: [target.id] });
    const granted = document.querySelector('.session-message-target-list li');
    assert(granted?.querySelector('.agent-icon') && granted.textContent?.includes(target.title), 'The confirmed grant did not show the target title and Agent');
    const viewLink = granted?.querySelector<HTMLButtonElement>(`[aria-label="${translate('workspace:chat.openNamedSessionLink', { title: target.title })}"]`);
    await act(async () => { viewLink?.click(); await tick(); });
    assert(openedLink?.[0] === source.id && openedLink?.[1] === target.id, 'View collaboration did not open the authorized pair');
    await click(translate('workspace:chat.revokeNamedMessageTarget', { title: target.title }));
    await settle();
    assert(writes[1]?.sourceId === source.id && writes[1].sessionId === target.id && !writes[1].enabled, 'Revocation did not target the granted session');

    const known = { sessionId: source.id, title: 'Old sender title', providerId: 'claude' };
    const missing = { sessionId: 'unknown-source', title: 'Saved sender title', providerId: 'claude' };
    await render(chat({ sessions: [source], openSession: id => { opened = id; }, session: {
      ...target, messages: [{ id: 'agent-delivered', role: 'user', text: 'Delivered message', createdAt: target.createdAt, agentSource: known }],
      queue: [{ id: 'agent-queued', commandId: 'agent-command', input: { text: 'Queued message' }, createdAt: target.createdAt, updatedAt: target.updatedAt, agentSource: missing }],
    } }));
    const attribution = document.querySelector<HTMLButtonElement>('[data-message-id="agent-delivered"] > button.agent-message-source');
    assert(attribution?.textContent === translate('workspace:chat.agentMessageFrom', { title: source.title })
      && attribution.querySelector('.agent-icon')?.getAttribute('src')?.includes('codex'), 'The delivered message did not use the current sender title and Agent');
    await act(async () => { attribution.click(); await tick(); });
    assert(opened === source.id, 'The sender label did not open the source session');
    const queued = document.querySelector('[data-queue-id="agent-queued"]');
    assert(queued?.querySelector('span.agent-message-source')?.textContent === translate('workspace:chat.agentMessageFrom', { title: missing.title })
      && !queued.querySelector('button.agent-message-source'), 'An unavailable sender did not retain its snapshot label as plain text');
    assert(![...queued.querySelectorAll('button')].some(item => item.textContent === translate('workspace:chat.editQueued')), 'A queued Agent message offered a text edit');
    await click('workspace:chat.removeQueued');
    await settle();
    assert(removed === 'agent-queued', 'A queued Agent message could not be removed');
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
    const settingsSearch = input('.settings-search input');
    await act(async () => {
      (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
      await tick();
    });
    assert(document.activeElement === settingsSearch, 'Search settings did not take keyboard focus');
    await change(settingsSearch, 'only while in the background');
    await act(async () => { settingsSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick(); });
    assert(document.querySelector('[data-setting-anchor="notification-backgroundOnly"].setting-search-highlight')
      && settingsSearch.value === 'only while in the background' && document.activeElement === settingsSearch,
    'Setting search did not land on the exact preference or retain its query and focus');
    await change(settingsSearch, '');
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
    const region = row('src')!.parentElement!.nextElementSibling!;
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
    assert(getComputedStyle(row('src')!.parentElement!).position === 'sticky' && getComputedStyle(row('src/lib')!.parentElement!).position === 'static', 'Pinned ancestors filled the whole tree in a short file inspector');
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
  'FILE-TREE-ACTIONS: menus change only the confirmed path and preserve independent tabs': async () => {
    const project = { ...workspace, id: 'file-tree-actions', cwd: '/fixture-tree-actions' };
    const src = 'source', child = 'source/child.txt', alias = 'alias.txt', keep = 'keep.txt';
    const make = (path: string, kind: FileEntry['kind'], realPath = path): FileEntry =>
      ({ path, kind, name: path.split('/').at(-1)!, size: 0, realPath: `${project.cwd}/${realPath}` });
    const files = new Map([
      [src, make(src, 'directory')], [child, make(child, 'file')], [alias, make(alias, 'file', child)], [keep, make(keep, 'file')],
    ]);
    let failDelete = true;
    const mutations: WorkspaceFileMutation[] = [];
    const reads: string[] = [];
    window.workbench = {
      listFiles: async (_id: string, directory: string) => {
        reads.push(directory);
        return [...files.values()].filter(entry => workspaceFileParent(entry.path) === directory);
      },
      gitState: async () => ({ available: false }),
      readFile: async (_id: string, path: string) => {
        const entry = files.get(path);
        return entry ? { path, realPath: entry.realPath, content: 'disk content', language: 'text', size: 12, revision: path } : null;
      },
      mutateWorkspaceFile: async (_id: string, mutation: WorkspaceFileMutation) => {
        mutations.push(mutation);
        if (mutation.action === 'create') {
          const path = mutation.directory ? `${mutation.directory}/${mutation.name}` : mutation.name;
          files.set(path, make(path, mutation.kind));
          return;
        }
        if (mutation.action === 'delete' && failDelete) { failDelete = false; throw new Error('EACCES fixture'); }
        const parent = workspaceFileParent(mutation.path);
        const target = mutation.action === 'rename' ? (parent ? `${parent}/${mutation.name}` : mutation.name) : undefined;
        if (target && files.has(target)) throw new Error('An item with that name already exists');
        for (const [path, entry] of [...files]) if (pathContainsFile(mutation.path, path)) {
          files.delete(path);
          if (target) {
            const renamed = target + path.slice(mutation.path.length);
            files.set(renamed, make(renamed, entry.kind));
          }
        }
        files.delete(alias);
      },
      setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    const row = (path: string) => document.querySelector<HTMLButtonElement>(`.workspace-tree-scroll .tree-row[title="${path}"]`);
    const tab = (path: string) => document.querySelector<HTMLButtonElement>(`.file-editor-tabs [role=tab][title="${path}"]`);
    const open = (path: string) => act(async () => { row(path)?.click(); await tick(); });
    const action = async (id: string, path?: string) => {
      await click(path ? `Actions for ${path}` : 'workspace:files.rootActions');
      const menu = document.querySelector<HTMLButtonElement>(`.row-actions-menu:popover-open [data-action="${id}"]`);
      assert(menu, `The open file menu has no ${id} action`);
      await act(async () => { menu.click(); await tick(); });
    };
    const dialog = () => document.querySelector('dialog[open]');
    const submit = () => act(async () => { dialog()?.querySelector<HTMLButtonElement>('button[type=submit]')?.click(); await tick(); });
    const name = (value: string) => change(input('dialog input'), value);
    const cancel = () => click('workspace:common.cancel');

    await render(<div style={{ display: 'flex', width: 380, height: 540 }}><FileReviewPanel workspace={project} refreshKey="tree-actions" perform={perform} /></div>);
    await action('create-directory');
    await name('assets'); await submit();
    await waitFor(() => !!row('assets'), 'The root folder was not created');
    await action('create-file', 'assets');
    await name('picture.txt'); await submit();
    await waitFor(() => row('assets')?.getAttribute('aria-expanded') === 'true' && !!row('assets/picture.txt'), 'Creating a file did not reveal it in the target folder');

    await open(src);
    await waitFor(() => !!row(child), 'The source directory did not expand');
    await open(keep);
    await open(child);
    await open(alias);
    await change(input('[data-test-editor]'), 'unsaved through alias');
    const beforeBlocked = mutations.length;
    await action('rename', src);
    await name('renamed'); await submit();
    assert(mutations.length === beforeBlocked && dialog()?.querySelector('[role=alert]')?.textContent === translate('workspace:files.treeDraftBlocked')
      && input('[data-test-editor]').value === 'unsaved through alias', 'A folder rename ignored an unsaved draft that resolves inside it');
    await cancel();
    await change(input('[data-test-editor]'), 'disk content');

    await action('rename', src);
    await name('assets'); await submit();
    assert(dialog()?.querySelector('[role=alert]')?.textContent === 'An item with that name already exists' && tab(child) && tab(alias),
      'A failed rename closed tabs or left no way to retry');
    await name('renamed'); await submit();
    await waitFor(() => !!row('renamed/child.txt'), 'Renaming a folder lost its expansion');
    assert(!tab(child) && !tab(alias) && tab(keep)?.getAttribute('aria-selected') === 'true'
      && row('assets')?.getAttribute('aria-expanded') === 'true' && reads.includes('assets'),
    'Renaming did not close the affected clean tabs or preserve unrelated selection');

    await action('remove', 'renamed');
    assert(dialog()?.getAttribute('aria-label') === translate('workspace:files.deleteFolder') && dialog()?.textContent?.includes('renamed'),
      'Delete confirmation omitted the exact folder');
    const beforeCancel = mutations.length;
    await cancel();
    assert(mutations.length === beforeCancel && row('renamed'), 'Cancelling delete still changed the folder');
    await action('remove', 'renamed');
    await submit();
    assert(dialog()?.querySelector('[role=alert]')?.textContent === 'EACCES fixture' && row('renamed'), 'A filesystem error lost the deletion dialog or hid the folder');
    await submit();
    await waitFor(() => !row('renamed') && !dialog(), 'Retrying the confirmed deletion did not remove the folder');
    assert(tab(keep)?.getAttribute('aria-selected') === 'true' && row('assets/picture.txt'), 'Deleting a folder changed unrelated tabs or expansion');
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
  'GIT-SYNC: publish targets the selected remote and displays the configured upstream': async () => {
    const operations: { action: string; remote: string; expectedBranch: string }[] = [];
    window.workbench = {
      listFiles: async () => [], setUnsavedFiles: () => {},
      gitState: async () => ({ available: true, branch: 'topic', changes: [] }),
      gitSyncState: async () => ({ branch: 'topic', remotes: ['origin', 'review'] }),
      syncGit: async (_id: string, request: typeof operations[number]) => {
        operations.push(request);
        return { branch: 'topic', remotes: ['origin', 'review'], upstream: { remote: request.remote, ref: 'refs/heads/topic', ahead: 0, behind: 0 } };
      },
    } as unknown as Window['workbench'];
    await render(<FileReviewPanel workspace={{ ...workspace, id: 'git-sync' }} refreshKey="git-sync" perform={perform} />);
    await settle();
    await act(async () => { document.querySelector<HTMLButtonElement>('.file-view-tabs button:nth-child(2)')!.click(); await tick(); });
    await click('workspace:files.gitSync');
    assert(button('workspace:files.gitSyncPull').disabled, 'Pull was offered before configuring upstream');
    await chooseOption(button('workspace:files.gitSyncRemote'), 'review');
    await click('workspace:files.gitSyncPublish');
    await waitFor(() => document.querySelector('.git-sync-dialog')?.textContent?.includes('topic → review / topic') === true, 'The chosen remote was not displayed');
    assert(!button('workspace:files.gitSyncPull').disabled && JSON.stringify(operations) === JSON.stringify([{ action: 'push', remote: 'review', expectedBranch: 'topic' }]), 'Publishing used the wrong remote or did not configure upstream');
  },
  'GIT-BRANCH-CONTROL: create and switch update the current branch after Git reports success': async () => {
    let branch = 'main';
    const operations: string[] = [];
    window.workbench = {
      listFiles: async () => [], setUnsavedFiles: () => {},
      gitState: async () => ({ available: true, branch, changes: [] }),
      gitBranchRefs: async () => ['refs/heads/main', 'refs/heads/review', 'refs/remotes/origin/remote'],
      changeGitBranch: async (_workspaceId: string, change: { action: string; name: string; expectedBranch: string }) => {
        operations.push([change.action, change.name, change.expectedBranch].join(':'));
        branch = change.name;
        return { available: true, branch, changes: [] };
      },
    } as unknown as Window['workbench'];
    await render(<FileReviewPanel workspace={{ ...workspace, id: 'git-branch-control' }} refreshKey="git-branch" perform={perform} />);
    await settle();
    const open = () => act(async () => { document.querySelector<HTMLButtonElement>('.git-branch-control')!.click(); await tick(); });
    await open();
    await chooseOption(button('workspace:files.gitBranchSelect'), 'review');
    await click('workspace:files.gitBranchSwitch');
    await waitFor(() => document.querySelector('.git-branch-control span')?.textContent === 'review', 'The selected local branch was not shown');
    await open();
    await change(input('.git-branch-dialog input'), 'feature/new');
    await click('workspace:files.gitBranchCreate');
    await waitFor(() => document.querySelector('.git-branch-control span')?.textContent === 'feature/new', 'The created branch was not shown');
    assert(operations.join(',') === 'switch:review:main,create:feature/new:review', 'The branch operation used the wrong checkout or action');
  },
  'GIT-HISTORY: search and branch scope lead to the selected committed file': async () => {
    const main = { sha: 'a'.repeat(40), parents: [], subject: 'Main history', author: 'Fixture', authoredAt: '2026-10-01T00:00:00Z', refs: 'main' };
    const topic = { ...main, sha: 'b'.repeat(40), parents: [main.sha], subject: 'Topic change', refs: 'topic' };
    const paths: string[][] = [];
    window.workbench = {
      listFiles: async () => [], setUnsavedFiles: () => {},
      gitState: async () => ({ available: true, branch: 'main', changes: [] }),
      gitHistory: async (_id: string, query: string, all: boolean) => ({ commits: (all ? [topic, main] : [main]).filter(commit => commit.subject.includes(query)), limited: false }),
      gitCommitFiles: async (_id: string, sha: string) => { paths.push([sha]); return ['topic.txt']; },
      gitCommitDiff: async (_id: string, sha: string, path: string) => { paths.push([sha, path]); return { path, patch: '+committed text', binary: false, truncated: false }; },
    } as unknown as Window['workbench'];
    await render(<FileReviewPanel workspace={workspace} refreshKey="git-history" perform={perform} />);
    await settle();
    await act(async () => { document.querySelector<HTMLButtonElement>('.file-view-tabs button:nth-child(2)')!.click(); await tick(); });
    await click('workspace:files.gitHistory');
    await waitFor(() => Boolean(document.querySelector('.git-history-commit')), 'History did not load');
    assert(document.querySelectorAll('.git-history-commit').length === 1, 'Current branch included other branches');
    await act(async () => { input('.git-history-search input[type=checkbox]').click(); await tick(); });
    await waitFor(() => document.querySelectorAll('.git-history-commit svg').length === 2, 'All branches did not display both graph rows');
    await change(input('.git-history-search input[type=search]'), 'Topic');
    await click('workspace:files.historySearch');
    await waitFor(() => document.querySelectorAll('.git-history-commit').length === 1, 'The submitted search did not narrow the list');
    await act(async () => { document.querySelector<HTMLButtonElement>('.git-history-commit')!.click(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.git-history-files button')), 'Commit files did not load');
    await act(async () => { document.querySelector<HTMLButtonElement>('.git-history-files button')!.click(); await tick(); });
    await waitFor(() => document.querySelector('.git-history-details pre')?.textContent === '+committed text', 'The committed patch did not render');
    assert(JSON.stringify(paths) === JSON.stringify([[topic.sha], [topic.sha, 'topic.txt']]), 'The file patch used a different commit');
  },
  'DIFF-NOTES: pointer and keyboard select a range and preserve its text when the diff changes': async () => {
    const filePath = 'range.ts';
    const legacyPath = 'legacy.ts';
    const storageKey = `workbench:review:${workspace.id}`;
    const previous = localStorage.getItem(storageKey);
    const legacy = { id: 'old', filePath: legacyPath, lineNumber: 7, body: 'Original single-line note',
      side: 'original', scope: 'staged', revision: 'legacy', createdAt: 'now' };
    localStorage.setItem(storageKey, JSON.stringify([legacy]));
    const patch = ['Working tree changes', 'diff --git a/range.ts b/range.ts', '@@ -4,3 +8,3 @@', ' first', '-old', '+new', ' last',
      '@@ -20 +30 @@', '-later', '+different'].join('\n');
    let diff = { path: filePath, patch, binary: false, truncated: false, revision: 'r1' };
    const git = { available: true, branch: 'fixture', changes: [{ path: filePath, status: 'MM', staged: true }] };
    const feedback: string[] = [];
    window.workbench = {
      listFiles: async () => [], gitState: async () => git,
      fileDiff: async (_id: string, path: string) => path === legacyPath ? { ...diff, path, revision: 'legacy' } : diff,
      gitMutate: async () => { diff = { ...diff, revision: 'r2' }; return git; },
    } as unknown as Window['workbench'];
    const number = (side: 'original' | 'modified', line: number) => {
      const control = Array.from(document.querySelectorAll<HTMLButtonElement>(`.review-diff-gutter button[data-side="${side}"]`))
        .find(button => button.textContent === String(line));
      assert(control, `Missing ${side} line ${line}`);
      return control;
    };
    const mouse = (type: string, control: HTMLButtonElement) => {
      const bounds = control.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      assert(document.elementFromPoint(x, y)?.closest('button') === control, `Line ${control.textContent} is outside the fixture viewport`);
      return act(async () => {
        await rendererInput({ type, x, y,
          button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
          ...(type === 'mouseMoved' ? { force: .5 } : { clickCount: 1 }) });
      });
    };
    const editor = () => input('.review-note-editor textarea');
    const highlight = () => Array.from(document.querySelectorAll('.review-diff-gutter button[aria-pressed="true"]'))
      .map(row => row.textContent).join(',');
    const persisted = () => JSON.parse(localStorage.getItem(storageKey) ?? '[]') as Array<{ filePath: string; startLine?: number; lineNumber: number; side: string; scope: string; revision: string }>;
    const extend = async (line: number) => {
      const control = number('modified', line);
      await act(async () => {
        control.focus();
        control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }));
        await tick();
      });
    };
    try {
      await render(<FileReviewPanel workspace={workspace} refreshKey="diff" perform={perform} sessions={[session]} onFeedback={value => feedback.push(value)} />);
      await settle();
      await act(async () => { document.querySelector<HTMLButtonElement>('.file-view-tabs button:nth-child(2)')!.click(); await tick(); });
      await act(async () => { document.querySelector<HTMLButtonElement>(`.review-change-row .tree-row[title="${filePath}"]`)!.click(); await tick(); });
      await settle();
      assert(document.querySelector('.review-notes')?.textContent?.includes(`${legacyPath}:7`), 'The saved single-line note did not load');
      await mouse('mousePressed', number('original', 4));
      await mouse('mouseReleased', number('original', 4));
      await waitFor(() => highlight() === '4' && Boolean(document.querySelector('.review-diff .review-note-editor')), 'A click did not open a single-line note');
      await click('workspace:common.cancel');
      await act(async () => { number('original', 6).scrollIntoView({ block: 'nearest' }); await tick(); });
      await mouse('mousePressed', number('original', 4));
      await mouse('mouseMoved', number('original', 6));
      await waitFor(() => highlight() === '4,5,6', () => `Dragging highlighted ${highlight()} instead of the original-side range`);
      await mouse('mouseReleased', number('original', 6));
      const draft = 'Keep this text while I select lines';
      assert(editor().closest('form')?.previousElementSibling === number('original', 6).closest('[data-diff-row]'), 'The note editor did not open directly below the selected range');
      await change(editor(), draft);
      await extend(8);
      assert(highlight() === '8,9' && document.activeElement === number('modified', 9) && editor().value === draft, 'Keyboard range selection lost its side, focus, or draft text');
      await click('workspace:files.stage'); await settle();
      assert(editor().value === draft && button('workspace:files.saveNote').disabled && highlight() === '', 'A Git mutation attached the draft to a newer diff without reselection');
      await extend(8);
      diff = { ...diff, revision: 'r3' };
      await click('workspace:files.saveNote'); await settle();
      assert(persisted().length === 1 && editor().value === draft && button('workspace:files.saveNote').disabled,
        'Saving against a changed revision wrote a note or erased the draft');
      await extend(8);
      await click('workspace:files.saveNote'); await settle();
      const saved = persisted().find(note => note.filePath === filePath);
      assert(saved?.startLine === 8 && saved.lineNumber === 9 && saved.side === 'modified' && saved.scope === 'working' && saved.revision === 'r3',
        'The saved range lost its file, side, scope, revision, or endpoints');
      await click('workspace:files.notesToDraft'); await settle();
      assert(feedback.length === 1 && feedback[0].includes('File: legacy.ts\nLine: 7') && feedback[0].includes('File: range.ts\nLines: 8-9')
        && feedback[0].includes('Diff: working; side: modified; revision: r3'), 'Feedback did not retain both exact single-line and range references');
      diff = { ...diff, truncated: true, revision: 'r4' };
      await click('workspace:files.reload'); await settle();
      assert(!document.querySelector('.review-diff-gutter button'), 'Truncated diff still offers note selection');
      await click('workspace:files.notesToDraft'); await settle();
      assert(feedback.length === 1, 'An outdated note was added to the agent draft');
      diff = { ...diff, truncated: false, binary: true, revision: 'r5' };
      await click('workspace:files.reload'); await settle();
      assert(!document.querySelector('.review-diff-gutter button') && !document.querySelector('.review-note-editor'), 'Binary diff still offers notes');
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
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
    const fileSearch = deferred<{ path: string; name: string }[]>();
    const filePath = 'src/remote result.ts';
    const contentPath = 'src/content match.ts';
    const content = 'header\nsecond line\n  searchphrase();';
    const textSearch = deferred<Awaited<ReturnType<Window['workbench']['searchWorkspaceText']>>>();
    const oldTextSearch = deferred<Awaited<ReturnType<Window['workbench']['searchWorkspaceText']>>>();
    const textQueries: string[][] = [];
    const fileReads: string[][] = [];
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {}, markSessionSeen: async () => {},
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      readFile: async (id: string, path: string) => {
        fileReads.push([id, path]);
        const text = path === contentPath ? content : '';
        return { path, content: text, revision: 'r1', size: text.length, language: 'typescript' };
      },
      sessionLocations: async (id: string) => ({
        current: { cwd: (snapshot.workspaces.find(project => project.id === id) ?? workspace).cwd },
        worktrees: [], branches: [],
      }),
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
    const modifier = navigator.platform.startsWith('Mac') ? 4 : 2;
    const shortcut = () => key('k', 'KeyK', 75, modifier);
    const scopeShortcut = (index: number) => key(String(index), `Digit${index}`, 48 + index, modifier);
    const scope = () => modal()?.querySelector('[role=tab][aria-selected=true]');
    const escape = () => key('Escape', 'Escape', 27);
    const enter = () => key('Enter', 'Enter', 13);
    const closeDialog = () => act(async () => { document.querySelector<HTMLButtonElement>('dialog[open] .modal-heading button')?.click(); });
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
    await key('ArrowUp', 'ArrowUp', 38);
    assert(active() !== initialRow && (panel.querySelector('[role=listbox]')?.scrollTop ?? 0) > 0 && panel.scrollTop === 0,
      'Wrapping to the last result did not scroll just the result list');
    await change(initialSearch, 'no matching thing');
    assert(modal() === panel && search() === initialSearch && document.activeElement === initialSearch && !active()
      && panel.offsetTop === bounds[0] && panel.offsetHeight === bounds[1], 'Filtering changed the dialog, focus, or bounds');
    assert(panel.querySelector('[role=status]')?.textContent === translate('shell:commandPalette.empty'), 'Empty search results were not announced');
    await escape();
    assert(modal() === panel && !search().value && scope()?.textContent?.startsWith('All'), 'Escape did not clear search first');
    await key('Tab', 'Tab', 9);
    assert(document.activeElement === scope(), 'Tab did not reach the selected search scope');
    await key('ArrowRight', 'ArrowRight', 39);
    assert(document.activeElement === scope() && scope()?.textContent?.startsWith('Sessions')
      && panel.querySelectorAll('[role=group]').length === 1, 'ArrowRight did not narrow results to sessions');
    await escape();
    assert(document.activeElement === search() && scope()?.textContent?.startsWith('All'), 'Escape did not return to All from an empty scope');
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

    window.workbench.findWorkspaceFiles = async (id, query) => id === workspace.id && query === 'oracle' ? fileSearch.promise : [];
    await click('shell:commandPalette.trigger');
    await change(search(), 'oracle');
    assert(modal()?.querySelector('[role=status]')?.textContent === translate('shell:commandPalette.searchingFiles'), 'File search did not announce loading');
    await act(async () => { fileSearch.resolve([{ path: filePath, name: 'remote result.ts' }]); });
    await waitFor(() => active()?.textContent?.includes(filePath) === true, 'The workspace match was filtered again or lost its path');
    await enter();
    await waitFor(() => fileReads.some(([id, path]) => id === workspace.id && path === filePath), 'File selection did not open the returned path');

    window.workbench.searchWorkspaceText = async (id, query) => {
      textQueries.push([id, query]);
      return query === 'obsolete' ? oldTextSearch.promise : textSearch.promise;
    };
    await click('shell:commandPalette.trigger');
    await change(search(), 'obsolete');
    await waitFor(() => textQueries.length === 1, 'Content search did not start in All');
    await scopeShortcut(3);
    assert(scope()?.textContent?.startsWith('Commands') && document.activeElement === search(), 'The scope shortcut did not keep focus in search');
    await change(search(), 'searchphrase');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    assert(JSON.stringify(textQueries) === JSON.stringify([[workspace.id, 'obsolete']]), 'A hidden Files scope issued a content search');
    await scopeShortcut(1);
    await waitFor(() => textQueries.length === 2, 'Returning to All did not search the new text');
    assert(JSON.stringify(textQueries) === JSON.stringify([[workspace.id, 'obsolete'], [workspace.id, 'searchphrase']]), 'Content search used the wrong workspace or query');
    await act(async () => {
      textSearch.resolve({ matches: Array.from({ length: 7 }, (_, index) => ({ path: contentPath, line: index + 3, column: 3, preview: 'searchphrase();' })), limited: true });
      oldTextSearch.resolve({ matches: [{ path: 'obsolete.ts', line: 1, column: 1, preview: 'obsolete' }], limited: false });
    });
    const contentGroup = () => [...modal()!.querySelectorAll('[role=group]')]
      .find(group => group.getAttribute('aria-label') === translate('shell:commandPalette.fileContents'));
    assert(contentGroup()?.querySelectorAll('[role=option]').length === 6 && !modal()?.textContent?.includes('obsolete.ts'), 'All did not cap content results or retained a superseded response');
    assert(active()?.textContent?.includes(`${contentPath}:3:3`), 'A content match did not show its path, line, and column');
    await key('ArrowUp', 'ArrowUp', 38);
    assert(active()?.textContent?.startsWith('Show more'), 'The content group did not offer more results to the keyboard');
    await enter();
    assert(scope()?.textContent?.startsWith('Files') && search().value === 'searchphrase' && document.activeElement === search()
      && contentGroup()?.querySelectorAll('[role=option]').length === 7 && textQueries.length === 2, 'Show more did not reuse and expose the complete Files result set');
    assert(modal()?.querySelector('.command-palette-file-status')?.textContent === translate('shell:commandPalette.fileSearchLimited'), 'The limited content search was not announced');
    await act(async () => { search().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await enter();
    assert(modal(), 'Enter selected a match during text composition');
    await act(async () => { search().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await enter();
    await waitFor(() => {
      const editor = document.querySelector<HTMLElement>('.review-editor .cm-editor');
      const view = editor && EditorView.findFromDOM(editor);
      return view?.state.selection.main.head === content.indexOf('searchphrase');
    }, 'Opening a content result did not move the editor to the matching line and column');

    for (const [query, title] of [['new project', 'shell:app.newWorkspace'], ['new agent', 'shell:app.newAgentSession'], ['settings', 'shell:preferences.title']]) {
      await run(query);
      assert(document.querySelector('dialog[open]')?.getAttribute('aria-label') === translate(title), `The palette did not route ${query} to its existing dialog`);
      await shortcut();
      assert(!modal(), 'The shortcut opened a second dialog over a current modal');
      await closeDialog();
    }
    await click('shell:commandPalette.trigger');
    await scopeShortcut(5);
    assert(scope()?.textContent?.startsWith('Settings'), 'The Settings shortcut did not select its scope');
    await change(search(), 'language');
    assert(active()?.textContent?.includes(translate('shell:preferences.language')), 'The Settings scope did not find the interface language preference');
    await enter();
    assert(document.querySelector('dialog[open] [data-setting-anchor="language"].setting-search-highlight'), 'The scoped setting result did not reach its existing setting');
    await closeDialog();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      await click('shell:commandPalette.trigger');
      await change(search(), '打开文件');
      assert(active()?.textContent?.includes('打开文件'), 'The localized action was not searchable');
      await escape();
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
    assert(document.querySelector('.file-review-panel [role=alert]')?.textContent === 'EACCES fixture' && !errors.length,
      'Permission failure did not appear once in the file panel');
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
      await act(async () => { target.scrollIntoView({ block: 'nearest' }); await tick(); });
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
  'UI-05: quota tooltip works in a modal select': async () => {
    let closed = false;
    const configured: ProviderInfo = { ...provider, models: [
      { id: 'a', name: 'Model A', free: false }, { id: 'b', name: 'Model B', free: false },
    ] };
    function Fixture() {
      const [value, setValue] = React.useState('a');
      return <Modal title="Models" onClose={() => { closed = true; }}><ModelField provider={configured} value={value} onChange={setValue} /></Modal>;
    }
    await render(<Fixture />);
    const control = document.querySelector<HTMLButtonElement>('dialog [role=combobox]')!;
    assert(control.textContent?.trim() === 'Model A', 'The selected model retains an account quota suffix');
    const menu = await openSelect(control);
    const option = menu.querySelector<HTMLElement>('[data-value="b"]')!;
    assert(option.textContent?.trim() === 'Model B', 'The model option retains an account quota suffix');
    const bounds = option.getBoundingClientRect();
    await act(async () => { await rendererInput({ type: 'mouseMoved', x: Math.floor(bounds.left + bounds.width / 2), y: Math.floor(bounds.top + bounds.height / 2) }); });
    await waitFor(() => Boolean(document.querySelector('dialog .ensemble-tooltip')?.textContent?.includes(translate('shell:provider.accountQuota'))), 'Hover did not show the quota tooltip in the modal');
    await act(async () => { await rendererInput({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await rendererInput({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); });
    assert(!closed, 'Escape closed the modal while the select was open');
    if (document.querySelector('[role=listbox][data-state=open]')) {
      await act(async () => { await rendererInput({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await rendererInput({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); });
    }
    const reopened = await openSelect(control);
    const target = reopened.querySelector<HTMLElement>('[data-value="b"]')!;
    const targetBounds = target.getBoundingClientRect();
    const x = Math.floor(targetBounds.left + targetBounds.width / 2), y = Math.floor(targetBounds.top + targetBounds.height / 2);
    await act(async () => {
      await rendererInput({ type: 'mouseMoved', x, y });
      await rendererInput({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await rendererInput({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    });
    await waitFor(() => !document.querySelector('[role=listbox][data-state=open]'), 'Mouse selection did not close the model list');
    assert(control.textContent?.trim() === 'Model B' && !closed, 'Mouse selection did not update the model');
    await render(<div />);
    await render(<Fixture />);
    const keyboardControl = document.querySelector<HTMLButtonElement>('dialog [role=combobox]')!;
    await openSelect(keyboardControl);
    await waitFor(() => document.activeElement?.getAttribute('data-value') === 'a', 'The selected model did not receive focus');
    await act(async () => {
      await rendererInput({ type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await rendererInput({ type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    });
    await waitFor(() => document.activeElement?.getAttribute('data-value') === 'b' && Boolean(document.activeElement?.getAttribute('aria-describedby')), () => `Keyboard focus did not expose the quota tooltip: ${document.activeElement?.outerHTML}`);
    await act(async () => {
      await rendererInput({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await rendererInput({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    });
    assert(keyboardControl.textContent?.trim() === 'Model B' && !closed, 'Keyboard selection did not update the model');
  },
  'UI-05: inline session controls preserve drafts, capabilities and partial settings updates': async () => {
    const writes: Record<string, unknown>[] = [];
    let sends = 0;
    let draftChanges = 0;
    const configuredProvider: ProviderInfo = { ...provider, capabilities: { ...provider.capabilities, permissionTiers: SESSION_PERMISSION_TIERS }, models: [
      { id: 'model-a', name: 'Model A', free: false, efforts: ['low', 'high'] },
      { id: 'model-b', name: 'Alternate', free: false, efforts: ['low'] },
      { id: 'model-c', name: 'Fast model', free: true, efforts: [] },
    ] };
    const configuredSession: Session = { ...session, modelId: 'model-a' };
    let savedSession = configuredSession;
    const modelEfforts = new Map<string | undefined, string>([['model-a', 'low']]);
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
      updateSession: async (_id: string, patch: { modelId?: string | null; settings?: { effort?: string | null; permission?: SessionPermission }; skillAssignment?: unknown }) => {
        writes.push(structuredClone(patch));
        if (patch.skillAssignment) return { skillIds: ['skill'], updatedAt: '2026-11-04T01:00:00Z' };
        if (holdWrite) await holdWrite.promise;
        if (failWrite) throw new Error('fixture rejected the session settings');
        const modelId = patch.modelId === undefined ? savedSession.modelId : patch.modelId ?? undefined;
        if (patch.settings?.effort === null) modelEfforts.delete(modelId);
        else if (patch.settings?.effort !== undefined) modelEfforts.set(modelId, patch.settings.effort);
        const effort = modelEfforts.get(modelId);
        const updatedAt = new Date(Date.parse(savedSession.updatedAt) + 1).toISOString();
        const saved = {
          ...savedSession,
          modelId, updatedAt,
          settings: {
            ...savedSession.settings,
            permission: patch.settings?.permission ?? savedSession.settings?.permission,
            effort,
          },
        };
        savedSession = saved;
        const deliver = () => receiveSession(saved);
        if (delaySnapshot) deliverSnapshot = deliver;
        else deliver();
        return { modelId, effort, updatedAt };
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
    assert(modelOption('Model A')?.getAttribute('aria-pressed') === 'true' && modelOption('Model A')?.textContent?.trim() === 'Model A', 'The model list does not identify its current selection without a quota suffix');
    await key('Escape', 27);
    assert(picker() === panel && document.activeElement === disclosure(), 'Escape from search did not fold the model list');
    await key('Escape', 27);
    await waitFor(() => !picker() && document.activeElement === trigger(), 'Escape did not close the picker and restore trigger focus');
    assert(writes.length === 0, 'Canceling the picker changed a setting');
    await chooseOption(permission(), 'full-access');
    await waitFor(() => permission().textContent?.includes(translate('workspace:chat.fullAccessPermission')) === true, 'Full access did not persist in the permissions menu');
    await chooseOption(permission(), 'read-only');
    await waitFor(() => !document.querySelector('.composer-select-menu') && document.activeElement === permission(), 'The permissions menu did not restore focus');
    const permissionWrites = writes.length;

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
    assert(writes.length === permissionWrites, 'The slider saved during a pointer drag');
    assert(getComputedStyle(rail.querySelector('.discrete-slider-thumb')!).transitionDuration === '0s', 'The thumb was eased during a pointer drag');
    holdWrite = deferred<void>();
    await drag('mouseReleased', .82);
    assertStable('pointer release');
    assert(percent() === 100 && !rail.hasAttribute('data-dragging') && writes.length === permissionWrites + 1, 'Pointer release did not snap and commit once');
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
    assert(persistentSlider.getAttribute('aria-valuetext') === translate('workspace:chat.runtimeDefault'), 'The first visit to the CLI default copied another model’s effort');
    await expand(); await choose('Model A'); await settle();
    assert(persistentSlider.getAttribute('aria-valuetext') === translate('workspace:chat.effort.high'), 'The model change ignored the authoritative saved effort');
    await act(async () => { persistentSlider.focus(); });
    await key('Home', 36); await settle();
    assert(persistentSlider.value === '0', 'Home did not restore the runtime default effort');
    await expand(); await choose('Fast model'); await settle();
    assert(picker() === persistentPanel && !slider() && !trigger().querySelector('.composer-model-effort'), 'A model without reasoning support displayed the effort control');
    await expand(); await choose('Fast model'); await settle();
    assert(JSON.stringify(writes) === JSON.stringify([
      { settings: { permission: 'full-access' } }, { settings: { permission: 'read-only' } }, { settings: { effort: 'high' }, expectedProviderId: 'codex' },
      { modelId: 'model-b', expectedProviderId: 'codex' }, { settings: { effort: 'low' }, expectedProviderId: 'codex' },
      { modelId: null, expectedProviderId: 'codex' }, { modelId: 'model-a', expectedProviderId: 'codex' },
      { settings: { effort: null }, expectedProviderId: 'codex' }, { modelId: 'model-c', expectedProviderId: 'codex' },
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
  'REMOTE-DEVICES: creation, approvals and connection status follow the selected SSH device': async () => {
    type Request = import('../shared/remote-devices').RemoteRequest;
    type Summary = import('../shared/remote-devices').RemoteSessionSummary;
    const devices = ['laptop', 'desktop'].map(id => ({ id, name: id, destination: `me@${id}`, cliPath: '/fixture/bin/workbench' }));
    const requests: { device: string; input: Request }[] = [];
    const created = new Map<string, Map<string, Summary>>();
    const firstCheck = deferred<void>();
    let desktopUnavailable = true;
    let loseCreateReply = true;
    let approved = false;
    Object.assign(window, { workbench: {
      listRemoteDevices: async () => devices,
      remoteDeviceRequest: async (device: string, input: Request) => {
        requests.push({ device, input });
        if (device === 'desktop' && desktopUnavailable) throw new Error('Desktop offline');
        if (input.action === 'create') {
          const receipts = created.get(device) ?? new Map<string, Summary>();
          created.set(device, receipts);
          if (!receipts.has(input.commandId)) receipts.set(input.commandId, {
            id: 'created-' + input.commandId, title: input.title || 'New conversation', providerId: input.providerId, status: 'idle',
            updatedAt: session.updatedAt, pendingApprovals: 0,
          });
          if (loseCreateReply) { loseCreateReply = false; throw new Error('Reply lost'); }
          return snapshot(device, receipts.get(input.commandId)!.id);
        }
        if (input.action !== 'snapshot') { approved ||= input.action === 'approve'; return; }
        if (device === 'laptop') await firstCheck.promise;
        return snapshot(device, input.sessionId);
      },
    } });
    function snapshot(device: string, selectedId?: string) {
      const existing: Summary = { id: 'shared-session-id', title: `${device} conversation`, providerId: 'codex', status: 'running',
        pendingApprovals: Number(!approved), updatedAt: session.updatedAt };
      const sessions = [existing, ...(created.get(device)?.values() ?? [])];
      const selected = sessions.find(item => item.id === selectedId);
      return { sessions, limited: false, creation: {
        projects: device === 'laptop' ? [{ name: 'Laptop project', cwd: '/remote/laptop' }] : [],
        runtimes: [{ id: 'codex', name: 'Codex' }],
      }, ...(selected ? { selected: {
        session: selected, messages: selected === existing
          ? [{ id: 'message', role: 'assistant', text: `Result on ${device}`, createdAt: session.createdAt }] : [],
        approvals: approved || selected !== existing ? [] : [{ id: `${device}-approval`, sessionId: existing.id, title: 'Allow command', detail: 'Explicit approval',
          choices: [{ id: 'accept', label: 'Allow fixture command' }] }],
      } } : {}) };
    }
    const panel = () => <SettingsDialog snapshot={null} sessions={[]} perform={perform} pending={new Set()} updates={idleUpdates}
      initialSection="remote" openSession={() => {}} onClose={() => {}} />;
    const status = () => document.querySelector('.remote-device-status')?.textContent;
    await render(panel());
    await waitFor(() => status() === translate('shell:remote.status.unchecked'), 'An unchecked device did not show its state');
    assert(!requests.some(request => request.device === 'desktop'), 'The unselected device was checked automatically');
    firstCheck.resolve();
    await waitFor(() => status() === translate('shell:remote.status.connected'), 'Connected status did not appear');
    await click('shell:remote.newSession');
    await chooseOption(button('shell:remote.project'), '/remote/laptop');
    assert(!document.querySelector('input[name=remote-directory]'), 'Choosing a registered project still requires entering its path');
    await chooseOption(button('shell:remote.session'), 'shared-session-id');
    await waitFor(() => document.body.textContent?.includes('Result on laptop') === true, 'Laptop transcript did not appear');

    await chooseOption(button('shell:remote.device'), 'desktop');
    await waitFor(() => status() === translate('shell:remote.status.unavailable'), 'An unavailable device did not show its state');
    assert(!document.body.textContent?.includes('Result on laptop'), 'Laptop transcript remained after switching devices');
    desktopUnavailable = false;
    await click('shell:common.reload');
    await waitFor(() => status() === translate('shell:remote.status.connected'), 'Desktop did not recover after refresh');
    await chooseOption(button('shell:remote.session'), 'shared-session-id');
    await waitFor(() => document.body.textContent?.includes('Result on desktop') === true, 'Desktop transcript did not appear');
    const approve = [...document.querySelectorAll('button')].find(item => item.textContent === 'Allow fixture command');
    assert(approve, 'Remote approval was missing');
    await act(async () => { approve.click(); await tick(); });
    await settle();
    await waitFor(() => !document.body.textContent?.includes('Allow fixture command'), 'Approval did not clear');
    assert(requests.some(({ device, input }) => device === 'desktop' && input.action === 'approve' && input.approvalId === 'desktop-approval'), 'Approval was routed to the wrong device');
    assert(!requests.some(({ device, input }) => device === 'laptop' && input.action === 'approve'), 'Laptop received a desktop approval');

    const fillCreation = async () => {
      await click('shell:remote.newSession');
      await chooseOption(button('shell:remote.runtime'), 'codex');
      await change(input('input[name=remote-directory]'), 'relative/path');
      assert(button('shell:remote.create').disabled, 'A relative path could be submitted');
      await change(input('input[name=remote-directory]'), '/remote/desktop-new');
      await change(input('input[name=remote-title]'), 'Created on desktop');
    };
    await fillCreation();
    await click('shell:remote.create');
    await settle();
    assert(errors.pop() === 'Error: Reply lost', 'A lost reply did not leave a retryable creation');
    const stored = Object.keys(localStorage).find(key => key.startsWith('ensemble:remote-command:desktop:'));
    assert(stored && localStorage.getItem(stored)?.includes([...created.get('desktop')!.keys()][0]), 'The creation command ID was not persisted');
    await render(<div />);
    await render(panel());
    await waitFor(() => status() === translate('shell:remote.status.connected'), 'Laptop did not reconnect after reopening settings');
    assert(!document.body.textContent?.includes('Created on desktop'), 'Desktop conversation appeared on laptop');
    await chooseOption(button('shell:remote.device'), 'desktop');
    await waitFor(() => status() === translate('shell:remote.status.connected'), 'Desktop did not reconnect');
    await fillCreation();
    await click('shell:remote.create');
    await settle();
    await waitFor(() => document.querySelector('.remote-session h4')?.textContent === 'Created on desktop', 'Created conversation did not open');
    const creates = requests.filter(({ input }) => input.action === 'create');
    assert(creates.length === 2 && creates.every(({ device, input }) => device === 'desktop' && input.action === 'create'
      && input.cwd === '/remote/desktop-new' && input.providerId === 'codex'), 'Creation did not stay on the selected device and directory');
    assert(creates[0].input.action === 'create' && creates[1].input.action === 'create'
      && creates[0].input.commandId === creates[1].input.commandId && created.get('desktop')?.size === 1,
    'Retry after reopening settings created a duplicate conversation');
    assert(!localStorage.getItem(stored), 'A confirmed creation kept a stale pending command');
  },
  'DRAFT-SLASH: native commands and one-turn Skills complete at the cursor without sending': async () => {
    let sent: PromptInput | undefined;
    let settingsOpened = 0;
    const skill = { id: 'workspace-skill', name: 'review', description: 'Review output', path: '/workspace/.agents/skills/review/SKILL.md', scope: 'project', editable: true };
    window.workbench = {
      listSkills: async (id: string) => {
        assert(id === 'slash-workspace', 'Skill discovery used another workspace');
        return [skill];
      },
      sendPrompt: async (_sessionId: string, prompt: PromptInput) => { sent = prompt; },
    } as unknown as Window['workbench'];
    function EditableChat() {
      const [draft, setDraft] = React.useState<PromptInput>({ text: '' });
      return chat({
        workspaceId: 'slash-workspace', draft, onDraftChange: setDraft, onOpenSkillSettings: () => { settingsOpened++; },
        session: { ...session, runtimeCommands: [{ name: 'reset' }, { name: 'resume', inputHint: 'Thread' }] },
      });
    }
    await render(<EditableChat />);
    const textarea = input('.composer textarea') as HTMLTextAreaElement;
    await act(async () => { textarea.focus(); await tick(); });
    const list = () => document.querySelector('.slash-completion [role=listbox]');
    const key = async (value: string, isComposing = false) => {
      await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true, cancelable: true })); await tick(); });
    };
    await change(textarea, '/reold the existing argument');
    await act(async () => {
      textarea.setSelectionRange(4, 4);
      for (const type of ['keyDown', 'keyUp']) await rendererInput({ type, key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    });
    await waitFor(() => list()?.querySelectorAll('[role=option]').length === 3, 'Native commands and a Skill were not offered at the cursor');
    await key('ArrowDown');
    const selected = textarea.getAttribute('aria-activedescendant');
    assert(selected && document.getElementById(selected)?.textContent?.includes('/resume'), 'ArrowDown did not announce the next runtime command');
    await key('Enter', true);
    assert(String(textarea.value) === '/reold the existing argument' && !sent, 'IME confirmation picked an item or sent the prompt');
    await key('Enter');
    assert(String(textarea.value) === '/resume the existing argument' && !sent, 'Runtime completion changed the argument or sent immediately');
    await change(textarea, '/review');
    await waitFor(() => Boolean(list()?.textContent?.includes('review')), 'Skill results did not reopen');
    await key('Escape');
    assert(!list() && String(textarea.value) === '/review' && !sent, 'Escape changed the draft or sent it');
    await change(textarea, '/rev');
    await waitFor(() => Boolean(list()?.textContent?.includes('review')), 'Skill did not return for the edited query');
    await key('Enter');
    const removeSkill = () => document.querySelector<HTMLButtonElement>('.composer [aria-label="Remove Skill review"]');
    assert(String(textarea.value) === '' && removeSkill() && !sent && button('workspace:chat.sendTask').disabled, 'Skill-only selection did not stay as a draft chip');
    await act(async () => { removeSkill()!.click(); await tick(); });
    assert(!removeSkill() && !sent, 'Removing a Skill sent the message');
    await change(textarea, '/manage-s');
    await waitFor(() => Boolean(list()?.textContent?.includes('/manage-skills')), 'The local Skill settings command is missing');
    await key('Enter');
    assert(settingsOpened === 1 && String(textarea.value) === '' && !sent, 'The local command did not only open Skill settings');
    await change(textarea, '/rev');
    await waitFor(() => Boolean(list()?.textContent?.includes('review')), 'Skill results did not reopen for sending');
    await key('Enter');
    await change(textarea, 'Review this change');
    await key('Enter');
    assert(JSON.stringify(sent) === JSON.stringify({ text: 'Review this change', skills: [{ id: skill.id, name: skill.name }] }),
      'Explicit send dropped the Skill or sent unexpected text');
    assert(errors.length === 0, errors.join('\n'));
  },
  'DRAFT-INPUT: file selection and screenshot paste change only the current draft': async () => {
    const queries: string[][] = [];
    let sends = 0;
    const image = { id: 'pasted-image', name: 'Screenshot.png', kind: 'image' as const, mimeType: 'image/png', size: 4, sha256: 'a'.repeat(64), ownedPath: '/owned/Screenshot.png' };
    const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
    window.workbench = {
      findWorkspaceFiles: async (id: string, query: string) => {
        queries.push([id, query]);
        return [{ name: 'shared.ts', path: 'src/shared.ts' }, { name: 'shared.ts', path: 'test/shared.ts' }];
      },
      importPastedImage: async (name: string, bytes: Uint8Array) => {
        assert(name === image.name && bytes.byteLength === 4, 'Clipboard image bytes did not reach the attachment importer');
        return image;
      },
      readImageAttachment: async () => imageUrl,
      sendPrompt: async () => { sends++; },
    } as unknown as Window['workbench'];
    function EditableChat() {
      const [draft, setDraft] = React.useState<PromptInput>({ text: '' });
      return chat({ workspaceId: 'actual-worktree', draft, onDraftChange: setDraft });
    }
    await render(<EditableChat />);
    const textarea = input('.composer textarea') as HTMLTextAreaElement;
    textarea.focus();
    const key = async (value: string, isComposing = false) => {
      await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true, cancelable: true })); await tick(); });
    };
    await change(textarea, 'Inspect @sha');
    await waitFor(() => document.querySelectorAll('.workspace-file-mention [role=option]').length === 2, 'File suggestions did not load');
    assert(queries.some(([id, query]) => id === 'actual-worktree' && query === 'sha'), 'The composer searched a different workspace');
    const option = document.querySelector<HTMLElement>('.workspace-file-mention [role=option]')!;
    const rect = option.getBoundingClientRect();
    assert(document.elementFromPoint(rect.x + 12, rect.y + 12)?.closest('[role=option]') === option, 'The composer clipped the suggestion menu');
    assert(document.querySelector('.workspace-file-mention')?.textContent?.includes('test/shared.ts'), 'Same-named files lack a relative path');
    await key('ArrowDown'); await key('Enter', true);
    assert(String(textarea.value) === 'Inspect @sha' && sends === 0, 'IME Enter inserted a file or sent the draft');
    await key('Enter');
    assert(String(textarea.value) === 'Inspect @test/shared.ts ' && sends === 0, 'Keyboard confirmation did not insert only the selected reference');
    await change(textarea, 'Inspect @s');
    await waitFor(() => Boolean(document.querySelector('.workspace-file-mention')), 'File suggestions did not reopen');
    await key('Escape');
    assert(!document.querySelector('.workspace-file-mention') && String(textarea.value) === 'Inspect @s' && sends === 0,
      `Escape left the file menu open or changed the draft: menu=${Boolean(document.querySelector('.workspace-file-mention'))}, value=${JSON.stringify(textarea.value)}, sends=${sends}`);
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'clipboard.png', { type: 'image/png' }));
    await act(async () => { textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.composer .attachment-preview-trigger')), 'The screenshot was not added to the draft');
    await act(async () => { document.querySelector<HTMLButtonElement>('.attachment-preview-trigger')!.click(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('dialog img[src^="data:image/png"]')), 'The screenshot could not be reviewed');
    await click('shell:common.close');
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer .attachment-remove')!.click(); await tick(); });
    assert(!document.querySelector('.composer .attachment-chip') && sends === 0, 'Review or removal sent the screenshot');
  },
  'DRAFT-EVIDENCE: the searchable target requires explicit confirmation and can retry': async () => {
    const project = { ...workspace, name: 'Release Engineering' };
    const first = { ...session, title: 'Check release', id: 'matching-prefix-first' };
    const second = { ...first, id: 'matching-prefix-second' };
    const archived = { ...session, title: 'Previous release', id: 'archived', archived: true };
    const reference = { id: 'quote', label: 'Selected text', excerpt: 'Needs review', source: { kind: 'message' as const, sessionId: first.id, messageId: 'reply' } };
    const failure = deferred<void>();
    const additions: string[] = [];
    function QuoteFixture() {
      const [open, setOpen] = React.useState(false);
      return <><button onClick={() => setOpen(true)}>Open quote</button>{open && <EvidenceTargetDialog reference={reference}
        sessions={[first, second, archived]} workspaces={[project]} onClose={() => setOpen(false)} onAdd={async (id, value) => {
          assert(value === reference, 'The evidence payload changed while selecting its target');
          additions.push(id);
          if (additions.length === 1) await failure.promise;
        }} />}</>;
    }
    await render(<QuoteFixture />);
    const opener = button('Open quote');
    opener.focus();
    await click('Open quote');
    const search = input('dialog input[role=combobox]') as HTMLInputElement;
    const add = button('workspace:evidence.addToDraft');
    const options = () => [...document.querySelectorAll<HTMLElement>('dialog [role=option]')];
    const active = () => document.getElementById(search.getAttribute('aria-activedescendant') ?? '');
    const key = async (value: string, isComposing = false) => act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true, cancelable: true }));
    });
    assert(document.activeElement === search && add.disabled, 'The target search was not focused or had a preselected destination');
    await change(search, 'previous release');
    assert(!options().length && document.querySelector('dialog [role=status]')?.textContent === translate('workspace:evidence.noMatchingSessions'), 'Archived conversations appeared or empty results were not announced');
    await change(search, 'check engineering /fixture');
    assert(options().length === 2 && options()[0].textContent?.includes(first.id) && options()[1].textContent?.includes(second.id),
      'Search by title, project and path did not distinguish the same-named conversations');
    await key('ArrowDown'); await key('Enter', true);
    assert(add.disabled && !additions.length, 'IME Enter selected a conversation or added evidence');
    await key('Enter');
    assert(!add.disabled && options()[1].getAttribute('aria-selected') === 'true' && !additions.length, 'Enter did not select exactly one target for review');
    await key('ArrowUp');
    assert(active() === options()[0] && options()[1].getAttribute('aria-selected') === 'true', 'The keyboard highlight changed the confirmed target');
    await click('workspace:evidence.addToDraft');
    assert(add.disabled && search.readOnly && document.activeElement === search && additions.join() === second.id, 'Confirmation did not lock focus and save to the chosen target');
    await act(async () => { failure.reject(new Error('Unable to save draft')); });
    assert(document.querySelector('dialog [role=alert]')?.textContent === 'Unable to save draft' && !add.disabled && !search.readOnly
      && document.activeElement === search, 'A failed save did not keep the selected target available for retry');
    await click('workspace:evidence.addToDraft');
    assert(additions.join() === [second.id, second.id].join() && !document.querySelector('dialog[open]') && document.activeElement === opener,
      'Retry did not save to the chosen target and restore focus');
  },
  'DRAFT-CAPTURE: a window capture can be reviewed and added to an eligible draft': async () => {
    const attachment = { id: 'capture', name: 'Captured window.png', kind: 'image' as const, mimeType: 'image/png', size: 4, sha256: 'a'.repeat(64), ownedPath: '/owned/capture.png' };
    const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
    const noImages = { ...provider, id: 'text-only', source: 'plugin' as const };
    const activeSession = { ...session, title: 'Review window' };
    const excluded = { ...session, id: 'text-only-session', title: 'Review window without images', providerId: noImages.id };
    const tab = { kind: 'agent' as const, id: 'capture-tab', sessionId: activeSession.id };
    const project = { ...workspace, name: 'Window QA', tabs: [tab], activeTabId: tab.id };
    const snapshot: Snapshot = { ...collaborationSnapshot([]), sessions: [activeSession, excluded], providers: [provider, noImages], workspaces: [project] };
    let captured = (_attachment: typeof attachment) => {};
    const saves: [string, typeof attachment][] = [];
    let sends = 0;
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: () => () => {},
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      onLanguageChanged: () => () => {}, watchSessions: async () => {}, markSessionSeen: async () => {},
      listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      onWindowCaptured: (listener: typeof captured) => { captured = listener; return () => {}; },
      readImageAttachment: async () => imageUrl,
      addSessionAttachment: async (id: string, value: typeof attachment) => { saves.push([id, value]); return { text: '', attachments: [value] }; },
      sendPrompt: async () => { sends++; },
    } as unknown as Window['workbench'];
    await render(<LanguageProvider initial={{ preference: 'en', language: 'en' }}><App /></LanguageProvider>);
    await act(async () => { captured(attachment); });
    await waitFor(() => document.querySelector('dialog .window-capture-preview')?.getAttribute('src') === imageUrl, 'Window capture preview did not load');
    const search = input('dialog input[role=combobox]');
    await change(search, 'review window qa');
    const options = document.querySelectorAll('dialog [role=option]');
    assert(options.length === 1 && options[0].textContent?.includes(activeSession.title), 'Image-ineligible destinations were offered or project search did not work');
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { options[0].dispatchEvent(mouseDown); (options[0] as HTMLElement).click(); });
    assert(mouseDown.defaultPrevented && document.activeElement === search && !saves.length && document.querySelector('dialog[open]'),
      'Selecting the capture target moved focus or added the capture before confirmation');
    await click('workspace:evidence.addToDraft');
    assert(saves.length === 1 && saves[0][0] === activeSession.id && saves[0][1] === attachment && sends === 0
      && !document.querySelector('dialog[open]'), 'The confirmed capture changed the wrong draft or sent a prompt');
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
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer .attachment-remove')!.click(); await tick(); });
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
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer .attachment-remove')!.click(); await tick(); });
    assert(!button('workspace:chat.sendTask').disabled, 'Removing an oversized attachment did not restore sending');
    assert(errors.length === 0, errors.join('\n'));
  },
  'QUEUE-DISPATCH: next, current-turn send and explicit interrupt use the intended item': async () => {
    const requests: string[][] = [];
    Object.assign(window, { workbench: {
      commandReceipt: async () => undefined,
      moveQueuedPrompt: async (_id: string, itemId: string, targetId: string) => {
        requests.push(['next', itemId, targetId]); return 'moved';
      },
      steerQueuedPrompt: async (_id: string, itemId: string, _revision: number, attemptId: string) => {
        requests.push(['steer', itemId, attemptId]); return 'sent';
      },
      interruptForQueuedPrompt: async (_id: string, itemId: string, order: string[], attemptId: string) => {
        requests.push(['interrupt', itemId, ...order, attemptId]); return 'moved';
      },
    } });
    const queued: Session = { ...session, status: 'running', attempts: [
      { id: 'active-attempt', status: 'running', prompt: 'active', userMessageId: 'active-message', startedAt: session.createdAt },
    ], queue: ['one', 'two'].map(id => ({ id, commandId: id, input: { text: id }, createdAt: session.createdAt, updatedAt: session.updatedAt })) };
    await render(chat({ session: queued, provider: { ...provider, capabilities: { ...provider.capabilities, steer: true } } }));
    const action = (container: ParentNode, key: string) => {
      const control = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === translate(`workspace:chat.${key}`));
      assert(control, `Missing queue action ${key}`);
      return act(async () => { control.click(); await tick(); });
    };
    const row = document.querySelector('[data-queue-id="two"]')!;
    await action(row, 'queueNext'); await settle();
    await action(row, 'queueSteer'); await settle();
    await action(row, 'queueInterrupt');
    assert(requests.map(request => request.join(':')).join(',') === 'next:two:one,steer:two:active-attempt',
      'Priority or steering was misrouted, or interrupt ran without confirmation');
    const modal = document.querySelector('dialog[open]');
    assert(modal, 'Interrupt did not ask for confirmation');
    await action(modal, 'queueInterrupt'); await settle();
    assert(requests.at(-1)?.join(':') === 'interrupt:two:one:two:active-attempt', 'Interrupt did not carry the selected attempt and order');
  },
  'UX2-CHAT2: editing an oversized queued draft requires removing excess files before saving': async () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({ id: `queued-limit-${index}`, name: `file-${index}.txt`, kind: 'text' as const, ownedPath: `/file-${index}.txt`, mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }));
    const writes: unknown[] = [];
    window.workbench = {
      beginQueuedPromptEdit: async () => ({ text: 'Queued files', attachments }),
      renewQueuedPromptEdit: async () => {},
      saveQueuedPromptDraft: async () => {},
      finishQueuedPromptEdit: async (_id: string, _itemId: string, _editId: string, value: unknown) => { writes.push(value); },
    } as unknown as Window['workbench'];
    await render(chat({ session: { ...session, queue: [{ id: 'oversized-queued', commandId: 'queued', input: { text: 'Queued files', attachments }, createdAt: session.createdAt, updatedAt: session.updatedAt }] } }));
    await click('workspace:chat.editQueued');
    assert(button('workspace:chat.saveQueued').disabled, 'Queue edits still submit more attachments than the runtime accepts');
    assert(document.querySelector('.prompt-queue [role=alert]')?.textContent?.includes('4'), 'Queue attachment limit is not explained');
    await act(async () => { document.querySelector<HTMLButtonElement>('.prompt-queue .attachment-remove')!.click(); await tick(); });
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
    const show = (patch?: string) => render(chat({ session: { ...session, id: 'turn-diff-session', status: 'completed',
      messages: [{ id: 'turn-diff-event', text: 'Turn diff', role: 'activity', createdAt: session.createdAt,
        event: { id: 'native-diff', kind: 'diff', title: 'Turn diff', status: 'completed', output: patch } }],
    } }));
    await show(output);
    await waitFor(() => Boolean(document.querySelector('.trace-diff')), 'The collapsed Trace did not expose its diff action');
    assert(!document.querySelector('[data-message-id="turn-diff-event"]'), 'The completed Trace did not start folded');
    const summary = document.querySelector<HTMLButtonElement>('.trace-diff')!;
    assert(summary.textContent?.includes('example.txt'), 'The folded Trace did not name the changed file');
    await act(async () => { summary.click(); await tick(); });
    const row = () => document.querySelector('[data-message-id="turn-diff-event"] .process-reveal[data-expanded=true]');
    await waitFor(() => Boolean(row()?.querySelector('.turn-diff-patch')), 'The turn patch did not open inside its Trace');
    assert(row()?.querySelector('.removed')?.textContent?.trim() === '-before'
      && row()?.querySelector('.added')?.textContent?.trim() === '+after', 'The patch did not distinguish deleted and added lines');
    await show('');
    assert(row()?.textContent?.includes(translate('workspace:chat.trace.turnDiffEmpty')), 'An empty native update left a stale patch visible');
    await show();
    assert(row()?.textContent?.includes(translate('workspace:chat.trace.turnDiffUnavailable')), 'A missing patch was reported as zero changes');
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
    assert(controls().map(item => item.getAttribute('aria-expanded')).join(',') === 'false,true'
      && stableRow?.querySelector('.process-reveal[data-expanded="true"]'), 'Completing the turn closed manually opened details');
    assert(document.querySelector('.trace-failure')?.textContent?.includes('New command'), 'The failure summary did not identify its event');
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

    const detail = tool('trace-inline-detail', 'Inspect settings', 'running', 'Inspect settings\n'.repeat(40));
    await render(<div style={{ display: 'flex', width: 700, height: 320 }}>
      {React.cloneElement(chat({ session: { ...current, id: 'trace-inline-position', messages: [...messageRange(0, 6), detail] } }), { key: 'inline-position' })}
    </div>, 'user');
    const viewport = document.querySelector<HTMLElement>('.message-scroll')!;
    await waitFor(() => Boolean(row(detail.id)) && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 40,
      'The Trace detail fixture did not start at the live tail');
    await frames(4);
    const detailTop = row(detail.id)!.getBoundingClientRect().top;
    const previousHeight = viewport.scrollHeight;
    await toggle(row(detail.id)!.querySelector('button')!);
    await waitFor(() => viewport.scrollHeight > previousHeight + 80, 'The expanded detail did not increase the content height');
    assert(Math.abs(row(detail.id)!.getBoundingClientRect().top - detailTop) < 4, 'Opening details displaced the reading position');
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
  'CHAT-READ: folded prompts reveal search matches and a code block copies only its own source': async () => {
    const short: Message = { id: 'reading-short', role: 'user', text: 'Short prompt', createdAt: session.createdAt };
    const long: Message = { ...short, id: 'reading-long', text: 'hidden runtime metadata',
      originalPrompt: Array.from({ length: 10 }, (_, index) => index === 9 ? 'hidden search needle' : `Prompt line ${index + 1}`).join('\n'),
      evidence: [{ id: 'reading-evidence', label: 'Evidence stays available', excerpt: 'Related answer',
        source: { kind: 'message', sessionId: 'reading-fixture', messageId: 'reading-answer' } }],
    };
    const wrapped: Message = { ...short, id: 'reading-wrapped', text: 'singlelongword'.repeat(52) };
    const source = 'if true:\n    print("visible")\n';
    const answer: Message = { ...short, id: 'reading-answer', role: 'assistant', text: [
      'Before the code.',
      '```python\n' + source + '```',
      '> ```\n> src/workspace.ts:42\n> ```',
      'Indented example\n\n    echo test',
    ].join('\n\n') };
    const reading = { ...session, id: 'reading-fixture', status: 'completed' as const, messages: [short, wrapped, long, answer] };
    window.workbench = { sessionSearch: async () => ({ messages: [long], truncated: false }) } as unknown as Window['workbench'];
    const show = () => render(<div style={{ width: 880, height: 640 }}>{chat({ session: reading })}</div>);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    const viewport = (id: string) => row(id)?.querySelector<HTMLElement>('.ui-foldable-text-viewport');
    const toggle = (id: string) => row(id)?.querySelector<HTMLButtonElement>('.ui-foldable-text-toggle');
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writes: string[] = [];
    let fail = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      if (fail) throw new Error('clipboard refused');
      writes.push(text);
    } } });
    try {
      await show();
      await waitFor(() => Boolean(toggle(long.id) && toggle(wrapped.id)), 'Long prompts did not fold by rendered lines');
      assert(!toggle(short.id) && viewport(long.id)?.hasAttribute('data-collapsed')
        && viewport(long.id)?.textContent?.includes('hidden search needle'), 'The fold did not retain the full original prompt');
      assert(row(long.id)?.textContent?.includes('Evidence stays available'), 'Evidence was clipped with the prompt');
      const expand = toggle(long.id)!;
      await act(async () => { expand.focus(); expand.click(); await tick(); });
      assert(document.activeElement === expand && expand.getAttribute('aria-expanded') === 'true'
        && !viewport(long.id)?.hasAttribute('data-collapsed'), 'Expanding remounted the button or left the text clipped');
      await render(<div />);
      await show();
      await waitFor(() => toggle(long.id)?.getAttribute('aria-expanded') === 'true', 'The fold choice was lost when the conversation reopened');
      await act(async () => { toggle(long.id)?.click(); await tick(); });
      await click('workspace:chat.find');
      await change(input('.conversation-find input'), 'hidden search needle');
      await waitFor(() => toggle(long.id)?.getAttribute('aria-expanded') === 'true'
        && row(long.id)?.classList.contains('conversation-match') === true, 'Find left the matching prompt folded');
      await click('workspace:chat.closeFind');
      const blocks = [...(row(answer.id)?.querySelectorAll<HTMLElement>('.ui-code-block') ?? [])];
      assert(blocks.length === 3 && blocks[0].querySelector('.ui-code-block-language')?.textContent === 'python'
        && !blocks[1].querySelector('.ui-code-block-language') && !blocks[1].querySelector('.markdown-file-link'),
      'Fenced, nested, or indented code did not stay a plain code block');
      const copy = blocks[0].querySelector<HTMLButtonElement>('button')!;
      await act(async () => { copy.focus(); copy.click(); await tick(); });
      assert(writes.join('') === source && document.activeElement === copy
        && blocks[0].querySelector('[role=status]')?.textContent === translate('workspace:chat.copied')
        && !blocks[1].querySelector('[role=status]')?.textContent, 'Code copy changed whitespace, focus, or another block’s status');
      fail = true;
      await act(async () => { blocks[1].querySelector('button')?.click(); await tick(); });
      assert(writes.length === 1 && blocks[1].querySelector('[role=status]')?.textContent === translate('workspace:chat.copyFailed'),
        'Clipboard failure did not stay on the attempted block');
      fail = false;
      await click('workspace:chat.copyAnswer');
      assert(writes[1] === answer.text, 'Whole-answer copy did not preserve the original Markdown');
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
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
  'RUNTIME-SWITCH: the next runtime waits for the old turn and preserves the same conversation and draft': async () => {
    const target: ProviderInfo = { ...provider, id: 'claude', name: 'Claude Code', capabilities: { ...provider.capabilities, rewind: true } };
    const source: ProviderInfo = { ...provider, available: false, capabilities: { ...provider.capabilities, rewind: true } };
    const unavailable: ProviderInfo = { ...provider, id: 'unavailable', name: 'Unavailable', available: false };
    const attachment = { id: 'runtime-attachment', name: 'runtime-note.txt', kind: 'text' as const, ownedPath: '/runtime-note.txt',
      mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) };
    const previousPrompt: Message = { id: 'runtime-previous-prompt', role: 'user', text: 'An earlier prompt', createdAt: session.createdAt, nativeTurnId: 'old-turn' };
    const tool = (id: string): Message => ({ id, role: 'activity', text: id, createdAt: session.createdAt,
      event: { id, kind: 'tool', title: id, status: 'completed' } });
    const outgoingTool = tool('old-runtime-tool'), incomingTool = tool('new-runtime-tool');
    const previousMessages = [...messageRange(0, 32), previousPrompt, outgoingTool];
    const queue = [{ id: 'runtime-queue-item', commandId: 'queued', input: { text: 'Keep in Codex' },
      createdAt: session.createdAt, updatedAt: session.updatedAt }];
    const approval = { id: 'runtime-approval', sessionId: session.id, title: 'Approve Codex work', detail: '', choices: [{ id: 'allow', label: 'Allow' }] };
    const request = deferred<void>();
    const switches: string[][] = [];
    const sends: { value: PromptInput; providerId?: string }[] = [];
    let draft: PromptInput = { text: 'Keep this draft', attachments: [attachment] };
    let current: Session = { ...session, status: 'running', queue, messages: previousMessages };
    let sourceProvider = source;
    let rejectSend = false;
    window.workbench = {
      switchSessionRuntime: async (...args: string[]) => {
        switches.push(args);
        if (switches.length === 1) return request.promise;
        throw new Error('Runtime is no longer available');
      },
      sendPrompt: async (_id: string, value: PromptInput, _commandId?: string, providerId?: string) => {
        sends.push({ value, providerId });
        return rejectSend ? { rejected: 'runtime-changed' } : undefined;
      },
    } as unknown as Window['workbench'];
    function EditableSession() {
      const [value, setValue] = React.useState(draft);
      return chat({ session: current, provider: current.providerId === source.id ? sourceProvider : target, providers: [sourceProvider, target, unavailable], draft: value,
        onDraftChange: next => { draft = next; setValue(next); } });
    }
    const show = () => render(<React.StrictMode><div style={{ display: 'flex', width: 760, height: 570 }}><EditableSession /></div></React.StrictMode>);
    const runtime = () => button('workspace:chat.runtime');
    const send = () => button('workspace:chat.sendTask');
    const runtimeNote = () => document.querySelector('.composer-area [role=status][id]')?.textContent;
    const key = async (name: string, windowsVirtualKeyCode: number) => {
      await act(async () => {
        for (const type of ['keyDown', 'keyUp']) await rendererInput({ type, key: name, code: name, windowsVirtualKeyCode });
      });
    };
    const chooseRuntime = async (direction: 'ArrowDown' | 'ArrowUp', inspect?: (menu: HTMLElement) => void) => {
      runtime().focus();
      await key('Enter', 13);
      const menu = () => document.querySelector<HTMLElement>('[role=listbox][data-state=open]');
      await waitFor(() => Boolean(menu()), 'The Runtime picker did not open from the keyboard');
      inspect?.(menu()!);
      await key(direction, direction === 'ArrowDown' ? 40 : 38);
      await key('Enter', 13);
      await waitFor(() => !menu() && document.activeElement === runtime(), 'The Runtime picker did not close and return keyboard focus');
    };
    await show();
    const composer = input('.composer textarea');
    const chip = document.querySelector('.composer .attachment-chip');
    assert(runtime().textContent?.includes(source.name), 'The unready current runtime disappeared from the composer');
    await chooseRuntime('ArrowDown', menu => assert(
      [...menu.querySelectorAll<HTMLElement>('[role=option]')].map(option => option.dataset.value).join() === 'codex,claude'
      && menu.textContent?.includes(translate('workspace:chat.runtimeCurrentUnavailable')), 'The Runtime picker listed an unready alternative or hid the current runtime'));
    sourceProvider = { ...source, available: true };
    await show();
    assert(runtimeNote()?.includes(target.name) && runtime().textContent?.includes(source.name) && !button('workspace:common.stop').disabled
      && send().disabled && !composer.disabled && document.querySelector('.queue-item-content')?.textContent?.includes('Keep in Codex')
      && switches.length === 0, 'Selecting the next runtime changed the active runtime, hid queue controls, locked editing or sent a request');
    composer.focus();
    await change(composer, 'Edited while waiting');
    await key('Enter', 13);
    assert(sends.length === 0, 'Enter sent a new task while the runtime was waiting');
    await chooseRuntime('ArrowUp');
    assert(!runtimeNote() && !send().disabled && switches.length === 0, 'Selecting the current runtime did not cancel the pending switch');
    await chooseRuntime('ArrowDown');
    current = { ...current, status: 'completed' };
    await show();
    assert(switches.length === 0, 'The completed turn released a switch while an old task was still queued');
    current = { ...current, queue: [], approvals: [approval] };
    await show();
    assert(switches.length === 0 && !button('Allow').disabled, 'The switch ignored an outstanding approval or hid its action');
    const unknown: Message = { ...previousPrompt, delivery: { id: 'old-delivery', clientUserMessageId: previousPrompt.id,
      status: 'unknown', createdAt: session.createdAt, updatedAt: session.updatedAt } };
    current = { ...current, approvals: [], messages: [...previousMessages.slice(0, -2), unknown, outgoingTool] };
    await show();
    assert(switches.length === 0 && runtimeNote()?.includes('receipt'), 'An unresolved message delivery did not keep the switch waiting');
    current = { ...current, messages: previousMessages };
    await show();
    await waitFor(() => switches.length === 1, 'The deferred switch did not start once the old runtime was idle');
    assert(switches[0].join() === `${session.id},claude,codex` && send().disabled, 'The switch used the wrong session or runtime guard');
    await act(async () => { request.resolve(); await tick(); });
    await settle();
    assert(send().disabled && runtime().textContent?.includes(source.name), 'The RPC response enabled sending before the new runtime snapshot');

    const viewport = document.querySelector<HTMLElement>('.message-scroll')!;
    const readAt = async (top: number) => {
      await act(async () => {
        viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        viewport.scrollTop = top;
        viewport.dispatchEvent(new Event('scroll'));
        await tick();
      });
      await frames(4);
    };
    await readAt(viewport.scrollHeight / 2);
    const offset = viewport.scrollTop;
    const marker: Message = { id: 'runtime-switch-marker', role: 'activity', text: '', createdAt: session.createdAt,
      runtimeSwitch: { fromProviderId: source.id, toProviderId: target.id, permissionResetToReview: true } };
    current = { ...current, providerId: target.id, runtimeContinuity: { parked: [{ providerId: source.id }] },
      messages: [...previousMessages, marker, incomingTool, { id: 'new-runtime-answer', role: 'assistant', text: 'New answer', createdAt: session.createdAt }] };
    await show(); await frames(4);
    assert(input('.composer textarea') === composer && composer.value === 'Edited while waiting' && document.querySelector('.composer .attachment-chip') === chip
      && document.querySelector('.message-scroll') === viewport && Math.abs(viewport.scrollTop - offset) < 5 && document.activeElement === runtime()
      && runtime().textContent?.includes(target.name) && !send().disabled && Number(switches.length) === 1, 'The switch moved the reader, replaced the draft, lost focus or sent twice');
    assert([...document.querySelectorAll('.assistant-heading strong')].every(node => node.textContent === source.name), 'Earlier replies were relabeled with the new runtime');
    await readAt(viewport.scrollHeight);
    assert(document.querySelector('.runtime-switch-marker')?.textContent === translate('workspace:chat.runtimeSwitchedWithReview', { from: source.name, to: target.name })
      && document.querySelectorAll('.trace-heading').length === 2 && document.querySelector('[data-message-id="new-runtime-answer"] .assistant-heading strong')?.textContent === target.name
      && document.querySelector('[data-message-id="runtime-previous-prompt"]') && !document.querySelector('.message-user .message-tools'),
      'The timeline omitted the marker, grouped traces across it, misattributed the reply or exposed native rewind');
    composer.focus();
    await key('Enter', 13);
    await settle();
    assert(Number(sends.length) === 1 && sends[0].value.text === 'Edited while waiting' && sends[0].value.attachments?.[0].id === attachment.id
      && sends[0].providerId === target.id, 'After switching, keyboard send lost the draft, attachment or runtime guard');
    await change(composer, 'Keep this after a rejection');
    await chooseRuntime('ArrowDown');
    await settle();
    assert(Number(switches.length) === 2 && errors.some(error => error.includes('Runtime is no longer available'))
      && String(composer.value) === 'Keep this after a rejection' && !send().disabled && !runtimeNote(),
      'A rejected switch did not report the error and restore normal sending');
    rejectSend = true;
    await click('workspace:chat.sendTask'); await settle();
    assert(document.querySelector('.composer-area [role=alert]')?.textContent === translate('workspace:chat.runtimeChangedBeforeSend')
      && String(composer.value) === 'Keep this after a rejection', 'A stale send did not explain the runtime change or retain the draft');
  },
  'UI-08: queued sends reuse an uncertain command and preserve composition and later drafts': async () => {
    const gate = deferred<void>(), laterGate = deferred<void>();
    const sends: { id?: string; input: unknown }[] = [], edits: unknown[] = [], removals: string[] = [], pauses: boolean[] = [];
    const draft = { text: 'Next task' };
    let cleared = 0, receiptLookups = 0, projectUnavailable = false;
    window.workbench = {
      sendPrompt: async (_id: string, input: unknown, id?: string) => {
        sends.push({ id, input });
        if (projectUnavailable) return { rejected: 'workspace-unavailable' };
        if (sends.length === 1) await gate.promise;
        if (sends.length === 3) await laterGate.promise;
      },
      commandReceipt: async () => { receiptLookups++; return undefined; },
      beginQueuedPromptEdit: async () => ({ text: 'Queued before' }),
      renewQueuedPromptEdit: async () => {},
      saveQueuedPromptDraft: async () => {},
      finishQueuedPromptEdit: async (_id: string, item: string, _editId: string, input: unknown) => { edits.push({ item, input }); },
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
    projectUnavailable = true;
    const priorLookups = receiptLookups;
    await click('workspace:chat.sendTask'); await settle();
    assert(document.querySelector('.composer-area [role=alert]')?.textContent === translate('workspace:chat.workspaceUnavailable'),
      'A confirmed directory rejection did not show its specific reason');
    assert(receiptLookups === priorLookups && Number(cleared) === 1
      && input('.composer textarea').value === 'A later draft while awaiting the send', 'A confirmed directory rejection looked up a receipt or erased the draft');
    await click('workspace:chat.editQueued'); await change(input('.prompt-queue textarea'), 'Edited next task'); await click('workspace:chat.saveQueued'); await settle();
    assert(JSON.stringify(edits) === JSON.stringify([{ item: 'queued-a', input: { text: 'Edited next task' } }]), 'Editing a queue item sent the wrong input');
    await click('workspace:chat.pauseQueue'); await settle();
    await show({ ...queued, queuePaused: true, queueHoldReason: 'Task stopped' }); await click('workspace:chat.resumeQueue'); await settle();
    await click('workspace:chat.removeQueued'); await settle();
    assert(JSON.stringify(pauses) === '[true,false]' && removals[0] === 'queued-a', 'Queue pause, resume or removal did not use its persisted item identity');
    await show({ ...queued, status: 'completed', queue: queued.queue?.map(item => ({ ...item, revision: 1, edit: { id: 'held' } })) });
    assert(document.querySelector('.composer-caption')?.textContent?.includes(translate('workspace:chat.queueNextTurn'))
      && !button('workspace:chat.resumeQueuedEdit').disabled, 'An edit-held queue hid the recovery action or labeled the next message as immediate');
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
    await show({ ...queued, queue: queued.queue?.map(item => ({ ...item, revision: 2, edit: { id: 'other-window' } })) });
    assert(input('.prompt-queue textarea') === queueInput && queueInput instanceof HTMLTextAreaElement && queueInput.readOnly && queueInput.value === 'A queue edit in progress',
      'An expired edit lost the text before the old window could copy it');
    assert(document.querySelector('.prompt-queue [role=alert]')?.textContent === translate('workspace:chat.queueEditMoved'),
      'An expired edit did not explain that another window resumed it');
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
  'CHAT-FILE-DROP: imports target the split under the pointer and reject unsupported files': async () => {
    const left = { ...session, id: 'drop-left', draft: { text: 'Left draft' } };
    const right = { ...session, id: 'drop-right', draft: { text: 'Right draft' } };
    const project: Workspace = { ...workspace, activeTabId: 'left-tab', secondaryTabId: 'right-tab', tabs: [
      { kind: 'agent', id: 'left-tab', sessionId: left.id }, { kind: 'agent', id: 'right-tab', sessionId: right.id },
    ] };
    const attachment = (name: string) => ({ id: name, name, kind: 'text' as const, size: 4, mimeType: 'text/plain', sha256: 'a'.repeat(64), ownedPath: `/owned/${name}` });
    const uploads = deferred<NonNullable<PromptInput['attachments']>>();
    const writes: [string, PromptInput][] = [];
    const workspaceImports: [string, string[]][] = [];
    let sends = 0;
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => ({ ...collaborationSnapshot([]), providers: [provider], sessions: [left, right], workspaces: [project] }),
      subscribe: () => () => {}, getConnection: async () => ({ status: 'connected', synced: true }),
      onConnectionChanged: () => () => {}, onFocusSession: () => () => {}, watchSessions: async () => {}, setUnsavedFiles: () => {},
      listFiles: async () => [{ path: 'project.md', name: 'project.md', kind: 'file', size: 4 }],
      gitState: async () => ({ available: false }),
      importDroppedAttachments: async (files: File[]) => {
        if (files.some(file => file.name === 'unsupported.pdf')) throw new Error('PDF is not a supported attachment.');
        assert(files.map(file => file.name).join('|') === 'one.txt|two.txt', 'Multi-file drop did not reach the importer in order');
        return uploads.promise;
      },
      importWorkspaceAttachments: async (id: string, paths: string[]) => {
        workspaceImports.push([id, paths]);
        return paths.map(attachment);
      },
      saveSessionDraft: async (id: string, draft: PromptInput) => { writes.push([id, draft]); },
      sendPrompt: async () => { sends++; },
    } as unknown as Window['workbench'];
    await render(<App />);
    const chatPane = (id: string) => document.querySelector<HTMLElement>(`[data-chat-session-id="${id}"]`)!;
    await waitFor(() => Boolean(chatPane(right.id) && document.querySelector('.workspace-file-tree .tree-row.file')), 'Both chats and the project tree must be visible');
    const fire = async (target: Element, type: string, transfer: DataTransfer) => {
      await act(async () => {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        await tick();
      });
    };
    const files = new DataTransfer();
    for (const name of ['one.txt', 'two.txt']) files.items.add(new File(['note'], name));
    const rightTarget = chatPane(right.id).querySelector('.message-scroll')!;
    await fire(rightTarget, 'dragover', files);
    assert(chatPane(right.id).querySelector('.chat-file-drop-target') && !chatPane(left.id).querySelector('.chat-file-drop-target'), 'Hover highlighted the wrong pane');
    await fire(rightTarget, 'drop', files);
    await change(chatPane(right.id).querySelector('textarea')!, 'Edited while importing');
    await act(async () => { uploads.resolve([attachment('one.txt'), attachment('two.txt')]); await tick(); });
    await waitFor(() => chatPane(right.id).querySelectorAll('.attachment-chip').length === 2, 'The right pane did not receive both attachments');
    assert(writes.at(-1)?.[0] === right.id && writes.at(-1)?.[1].text === 'Edited while importing' && !chatPane(left.id).querySelector('.attachment-chip'),
      'The drop wrote to the wrong draft or replaced newer text');

    const projectFile = new DataTransfer();
    await fire(document.querySelector('.workspace-file-tree .tree-row.file')!, 'dragstart', projectFile);
    await fire(chatPane(left.id).querySelector('.chat-toolbar')!, 'drop', projectFile);
    await waitFor(() => Boolean(chatPane(left.id).querySelector('.attachment-chip')), 'The file tree drop did not add an attachment to the left chat');
    assert(JSON.stringify(workspaceImports) === JSON.stringify([[project.id, ['project.md']]]) && writes.at(-1)?.[0] === left.id, 'The tree drop used the wrong project or chat');

    const rejected = new DataTransfer();
    rejected.items.add(new File(['%PDF'], 'unsupported.pdf'));
    await fire(rightTarget, 'drop', rejected);
    await waitFor(() => [...chatPane(right.id).querySelectorAll('[role=alert]')].some(item => item.textContent?.includes('PDF is not a supported attachment.')), 'The rejection did not appear in the target chat');
    assert(sends === 0 && writes.length === 3 && chatPane(right.id).querySelectorAll('.attachment-chip').length === 2, 'A rejected drop changed a draft or sent a message');
  },
  'SPLIT-DROP: session tabs preview four edges and preserve physical panes on focus changes': async () => {
    const primarySession = { ...session, title: 'Primary split session' };
    const otherSession = { ...session, id: 'other-split-session', title: 'Other split session' };
    const primary = { kind: 'agent' as const, id: 'primary-split-tab', sessionId: primarySession.id };
    const other = { kind: 'agent' as const, id: 'other-split-tab', sessionId: otherSession.id };
    const sideProject = { ...workspace, id: 'side-split-project', name: 'Side project', cwd: '/side-split' };
    let current: Workspace = { ...workspace, tabs: [primary, other], activeTabId: primary.id, splitRatio: 0.6 };
    let snapshot: Snapshot = { ...collaborationSnapshot([]), providers: [provider], sessions: [primarySession, otherSession], workspaces: [current, sideProject] };
    let publish = (_value: Snapshot) => {};
    const writes: Parameters<Window['workbench']['splitWorkspace']>[] = [];
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      splitWorkspace: async (...args: Parameters<Window['workbench']['splitWorkspace']>) => { writes.push(args); },
      activateTab: async (id: string, tabId: string) => {
        assert(id === workspace.id && tabId === other.id, 'Focus used the wrong tab');
        await showWorkspace({ activeTabId: other.id, secondaryTabId: primary.id, secondaryPlacement: 'after' });
      },
    } as unknown as Window['workbench'];
    async function showWorkspace(patch: Partial<Workspace>) {
      current = { ...current, ...patch };
      snapshot = { ...snapshot, workspaces: [current, sideProject] };
      publish(snapshot);
      await tick();
    }
    await render(<App />);
    await waitFor(() => document.querySelectorAll('.workspace-tabs .tab-select').length === 2, 'Split tabs did not load');
    const tab = (title: string) => [...document.querySelectorAll<HTMLButtonElement>('.workspace-tabs .tab-select')].find(item => item.textContent?.startsWith(title))!;
    const source = tab(otherSession.title);
    const active = tab(primarySession.title);
    const close = source.parentElement!.querySelector('.tab-close')!;
    const target = () => document.querySelector<HTMLElement>('.workspace-split-drop');
    const preview = () => target()?.querySelector<HTMLElement>('.workspace-split-preview');
    const panes = () => [...document.querySelectorAll<HTMLElement>('.workspace-dual > .tab-content')];
    const paneTitles = () => panes().map(item => item.querySelector('.chat-toolbar h2')?.textContent).join('|');
    await act(async () => { await showWorkspace({ secondaryTabId: other.id }); });
    assert(paneTitles() === `${primarySession.title}|${otherSession.title}`, 'A saved split without placement did not restore the original order');
    await act(async () => { await showWorkspace({ secondaryTabId: undefined }); });
    const fire = async (element: Element, type: string, transfer: DataTransfer, x = .5, y = .5) => {
      const rect = element.getBoundingClientRect();
      await act(async () => {
        element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer,
          clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y }));
        await tick();
      });
    };
    assert(source.draggable && !active.draggable && !(close as HTMLElement).draggable, 'The drag source includes an active or close button');
    await fire(active, 'dragstart', new DataTransfer());
    await fire(close, 'dragstart', new DataTransfer());
    assert(!target(), 'A non-draggable control enabled split drop');
    const file = new DataTransfer();
    file.items.add(new File(['fixture'], 'file.txt'));
    await fire(document.querySelector('.workspace-dual')!, 'dragover', file, .03, .5);
    assert(!target() && writes.length === 0, 'A file drag was claimed by the split target');

    const canceled = new DataTransfer();
    await fire(source, 'dragstart', canceled);
    const paneOverlay = document.createElement('div');
    Object.assign(paneOverlay.style, { position: 'absolute', inset: '0', zIndex: '12' });
    panes()[0].append(paneOverlay);
    const targetBounds = target()!.getBoundingClientRect();
    assert(document.elementFromPoint(targetBounds.left + targetBounds.width / 2, targetBounds.top + targetBounds.height / 2) === target(), 'Pane overlay blocked the split drop target');
    paneOverlay.remove();
    await fire(target()!, 'dragover', canceled, .03, .5);
    assert(preview()?.dataset.edge === 'left' && writes.length === 0, 'Hover changed the workspace before release');
    await fire(source, 'dragend', canceled);
    assert(!target() && writes.length === 0, 'Ending the drag without a drop changed the workspace');

    const stale = new DataTransfer();
    await fire(source, 'dragstart', stale);
    await act(async () => { await showWorkspace({ secondaryTabId: other.id }); });
    await fire(target()!, 'drop', stale, .03, .5);
    assert(JSON.stringify(writes.at(-1)?.[1].expectedLayout) === JSON.stringify({ activeTabId: primary.id, secondaryTabId: null }), 'Drop did not retain the layout from drag start');
    writes.length = 0;
    await act(async () => { await showWorkspace({ secondaryTabId: undefined }); });

    const centered = new DataTransfer();
    await fire(source, 'dragstart', centered);
    await fire(target()!, 'dragover', centered);
    assert(!preview(), 'The center accepted a split preview');
    await fire(target()!, 'drop', centered);
    await fire(source, 'dragend', centered);
    assert(writes.length === 0, 'Dropping in the center changed the workspace');

    for (const [edge, x, y, direction, placement] of [
      ['right', .97, .5, 'horizontal', 'after'], ['bottom', .5, .97, 'vertical', 'after'],
      ['top', .5, .03, 'vertical', 'before'], ['left', .03, .5, 'horizontal', 'before'],
    ] as const) {
      const transfer = new DataTransfer();
      const count: number = writes.length;
      const expectedLayout = { activeTabId: current.activeTabId, secondaryTabId: current.secondaryTabId ?? null };
      await fire(source, 'dragstart', transfer);
      await fire(target()!, 'dragover', transfer, x, y);
      assert(preview()?.dataset.edge === edge && writes.length === count, `The ${edge} preview saved before release`);
      assert(preview()?.style.getPropertyValue('--split-preview-size') === (placement === 'before' ? '60%' : '40%'), 'Preview did not use the saved physical ratio');
      await fire(target()!, 'drop', transfer, x, y);
      assert(!target() && writes.length === count + 1 && JSON.stringify(writes.at(-1)) === JSON.stringify([workspace.id, { tabId: other.id, direction, placement, expectedLayout }]), `The ${edge} drop requested the wrong split`);
      await act(async () => { await showWorkspace({ secondaryTabId: other.id, secondaryPlacement: placement, splitDirection: direction }); });
      assert(paneTitles() === (placement === 'before' ? `${otherSession.title}|${primarySession.title}` : `${primarySession.title}|${otherSession.title}`), `The ${edge} drop rendered the wrong physical order`);
      const [first, second] = panes().map(pane => pane.getBoundingClientRect());
      assert(direction === 'horizontal' ? first.right <= second.left : first.bottom <= second.top, `The ${edge} drop used the wrong axis`);
    }

    const unchanged = new DataTransfer();
    await fire(source, 'dragstart', unchanged);
    await fire(target()!, 'dragover', unchanged, .03, .5);
    assert(!preview(), 'The same tab and edge offered a duplicate split');
    await fire(target()!, 'drop', unchanged, .03, .5);
    await fire(source, 'dragend', unchanged);
    assert(Number(writes.length) === 4, 'Dropping the already placed tab wrote a duplicate split');

    const firstPane = panes()[0];
    const secondPane = panes()[1];
    await act(async () => { source.click(); await tick(); });
    assert(panes()[0] === firstPane && panes()[1] === secondPane
      && paneTitles() === `${otherSession.title}|${primarySession.title}`
      && source.getAttribute('aria-current') === 'page', 'Focusing the split tab mirrored or remounted the panes');
    const divider = panes()[0].parentElement!.querySelector('[role=separator].split-handle')!;
    assert(divider.getAttribute('aria-valuenow') === '60', 'Focus changed the physical pane ratio');
    await act(async () => { divider.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })); await tick(); });
    assert(writes.at(-1)?.[1].tabId === primary.id && writes.at(-1)?.[1].ratio === 0.65, 'The divider shortcut stopped updating the same physical ratio');

    for (const id of [sideProject.id, workspace.id]) {
      await act(async () => { document.querySelector<HTMLButtonElement>(`button[data-workspace-id="${id}"]`)!.click(); await tick(); });
    }
    assert(paneTitles() === `${otherSession.title}|${primarySession.title}`
      && source.getAttribute('aria-current') === 'page', 'Returning to the project changed the saved physical order or focus');
  },
  'RESPONSIVE-DIFF: Changes rearranges the same inspector at the panel width and keeps the reading position': async () => {
    const currentProject = { ...workspace, id: 'responsive-diff-project' };
    const change = (path: string) => ({ path, status: ' M', staged: false, additions: 1, deletions: 1 });
    const paths = Array.from({ length: 24 }, (_, index) => `file-${String(index).padStart(2, '0')}.ts`);
    const target = paths[14];
    let changes = paths.map(change), statusReads = 0, diffReads = 0;
    const patch = ['Working tree changes', `diff --git a/${target} b/${target}`, '@@ -1,160 +1,160 @@',
      ...Array.from({ length: 160 }, (_, index) => ` line ${index} ${'long code segment '.repeat(12)}`)].join('\n');
    window.workbench = {
      listFiles: async () => [], setUnsavedFiles: () => {},
      gitState: async () => { statusReads++; return { available: true, branch: 'main', changes }; },
      fileDiff: async (_id: string, file: string) => {
        diffReads++; return { path: file, patch, binary: false, truncated: false, revision: 'unchanged-diff' };
      },
    } as unknown as Window['workbench'];
    const show = (width: number) => render(<div style={{ '--file-width': `${width}px`, display: 'flex', height: 610 } as React.CSSProperties}>
      <FileReviewPanel workspace={currentProject} refreshKey="responsive-diff" perform={perform} />
    </div>, 'user');
    await show(340); await settle();
    await act(async () => { document.querySelector<HTMLButtonElement>('.file-view-tabs button:nth-child(2)')!.click(); await tick(); });
    const selected = document.querySelector<HTMLButtonElement>(`.review-change-row button[title="${target}"]`)!;
    const next = document.querySelector<HTMLButtonElement>(`.review-change-row button[title="${paths[15]}"]`)!;
    await act(async () => { selected.scrollIntoView({ block: 'nearest' }); selected.click(); await tick(); });
    await settle(); await frames();
    const inspector = document.querySelector<HTMLElement>('.review-inspector')!;
    const diff = inspector.querySelector<HTMLElement>('.review-diff')!;
    const line = diff.querySelectorAll('.review-diff-line')[25];
    const layout = document.querySelector<HTMLElement>('.review-layout')!;
    const list = layout.querySelector<HTMLElement>('.review-tree')!;
    const rowBounds = () => selected.closest('.review-change-row')!.getBoundingClientRect();
    const inline = () => inspector.getBoundingClientRect().top >= rowBounds().bottom - 1
      && next.getBoundingClientRect().top >= inspector.getBoundingClientRect().bottom - 1;
    const split = () => inspector.getBoundingClientRect().left >= list.getBoundingClientRect().right - 1
      && Math.abs(inspector.getBoundingClientRect().top - list.getBoundingClientRect().top) < 2;
    assert(inline() && getComputedStyle(layout).getPropertyValue('reading-flow') === 'flex-visual',
      'The narrow inspector did not follow its selected row in the visual reading flow');
    assert(inspector.getBoundingClientRect().top < layout.getBoundingClientRect().bottom - 80, 'The selected diff opened outside the narrow viewport');
    diff.scrollTop = 435;
    diff.scrollLeft = 83;
    const top = diff.scrollTop, left = diff.scrollLeft;
    assert(top > 0 && left > 0, 'The fixture did not exercise both diff scroll axes');
    const sameReadingPosition = () => document.querySelector('.review-inspector') === inspector
      && inspector.querySelector('.review-diff') === diff && diff.querySelectorAll('.review-diff-line')[25] === line
      && diff.scrollTop === top && diff.scrollLeft === left;
    await show(600); await frames();
    assert(split() && sameReadingPosition(), 'The wide layout changed the inspector or its reading position');
    const wideInspectorTop = inspector.getBoundingClientRect().top;
    list.scrollTop = 0;
    assert(inspector.getBoundingClientRect().top === wideInspectorTop && diff.scrollTop === top, 'Scrolling the wide change list moved the diff');
    await show(340); await frames();
    assert(inline() && sameReadingPosition() && inspector.getBoundingClientRect().top < layout.getBoundingClientRect().bottom - 80,
      'Returning to narrow layout lost the selected file or its reading position');
    changes = [change('added-on-refresh.ts'), ...changes];
    await click('workspace:files.refresh'); await settle(); await frames();
    assert(statusReads === 2 && diffReads === 1 && selected.classList.contains('selected') && inline() && sameReadingPosition(),
      'Refreshing Git status rebuilt the current diff or selected row');
    await click('workspace:files.expandPanel'); await frames();
    assert(document.querySelector('.review-expanded') && !layout.hasAttribute('data-responsive-diff') && sameReadingPosition(),
      'The existing full-width view was replaced');
    await click('workspace:files.restorePanel'); await frames();
    assert(inline() && sameReadingPosition(), 'Leaving full-width view lost the selected diff');
  },
  'SIDEBAR-SESSIONS: session placement, section editing, sort and density persist without stale rows': async () => {
    const home = { ...workspace, pinned: true };
    const other = { ...workspace, id: 'organize-other', name: 'Other project', cwd: '/organize-other' };
    const first = { ...session, id: 'organize-first', title: 'First conversation',
      createdAt: '2026-11-01', updatedAt: '2026-11-05',
      attention: { reason: 'result' as const, revision: 1, seenRevision: 0, updatedAt: '2026-11-05' } };
    const second = { ...session, id: 'organize-second', title: 'Second conversation', cwd: other.cwd,
      createdAt: '2026-11-02', updatedAt: '2026-11-04' };
    const third = { ...session, id: 'organize-third', title: 'Third conversation' };
    let snapshot = { ...collaborationSnapshot([]), workspaces: [home, other], sessions: [first, second, third], providers: [provider] };
    let publish = (_value: Snapshot) => {};
    const opened: Array<[string, string]> = [];
    window.workbench = {
      ...applicationUpdateApi, snapshot: async () => snapshot,
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; },
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
      openSessionTab: async (projectId: string, sessionId: string) => {
        opened.push([projectId, sessionId]);
        const tab = { kind: 'agent' as const, id: sessionId, sessionId };
        snapshot = { ...snapshot, workspaces: snapshot.workspaces.map(project => project.id === projectId
          ? { ...project, tabs: [tab], activeTabId: tab.id } : project) };
        publish(snapshot);
      },
    } as unknown as Window['workbench'];
    const key = 'ensemble.sidebar-sessions';
    const previous = localStorage.getItem(key);
    localStorage.removeItem(key);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-session-id="${id}"]`);
    const trigger = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[aria-haspopup=menu]')!;
    const section = (name: string) => [...document.querySelectorAll<HTMLElement>('[data-sidebar-section]')]
      .find(element => element.querySelector('h3')?.textContent === name);
    const listed = (name: string) => [...section(name)?.querySelectorAll<HTMLElement>('[data-sidebar-session-id]') ?? []]
      .map(element => element.dataset.sidebarSessionId).join(',');
    const unique = (id: string) => document.querySelectorAll(`[data-sidebar-session-id="${id}"]`).length === 1;
    const compact = () => document.querySelector('.workspace-sidebar-scroll')?.getAttribute('data-density') === 'compact';
    const performClick = (element: HTMLElement) => act(async () => { element.click(); await tick(); });
    const keyPress = (element: HTMLElement, key: string) => act(async () => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await tick();
    });
    const openMenu = () => document.querySelector<HTMLElement>('[role=menu]:popover-open');
    const action = async (menuTrigger: HTMLButtonElement, label: string) => {
      assert(menuTrigger, `Missing menu for ${label}`);
      await performClick(menuTrigger);
      await waitFor(() => Boolean(openMenu()), `Menu did not open for ${label}`);
      const item = [...openMenu()!.querySelectorAll<HTMLButtonElement>('[role^=menuitem]')].find(button => button.textContent?.trim() === label);
      assert(item, `Missing action ${label}`);
      await performClick(item);
    };
    const organization = () => button('shell:sidebarSessions.options');
    const nameSection = async (name: string) => {
      const nameInput = labeledInput('shell:sidebarSessions.sectionName', document.querySelector('dialog[open]')!);
      assert(document.activeElement === nameInput, 'Section name input did not receive focus');
      await change(nameInput, name); await click('shell:sidebarSessions.saveSection');
    };
    const expand = async (project: Workspace) => {
      const toggle = document.querySelector<HTMLButtonElement>(`[aria-controls="workspace-sessions-${project.id}"]`);
      assert(toggle, 'Project session toggle disappeared');
      if (toggle.getAttribute('aria-expanded') === 'false') await performClick(toggle);
    };
    const replace = (next: typeof snapshot) => act(async () => { snapshot = next; publish(next); await tick(); });

    try {
      await render(<App />);
      await expand(home); await expand(other);
      const initial = trigger(first.id);
      initial.focus();
      await keyPress(initial, 'ArrowDown');
      await waitFor(() => document.activeElement === openMenu()?.querySelector('[role=menuitem]'), 'ArrowDown did not focus the first session action');
      await keyPress(document.activeElement as HTMLElement, 'Escape');
      assert(document.activeElement === initial && !openMenu(), 'Escape did not restore the session menu trigger');
      await action(initial, 'Pin session');
      await action(trigger(second.id), 'Pin session');
      assert(listed('Pinned sessions') === [first.id, second.id].join(',') && unique(first.id) && unique(second.id),
        'Pinned sessions did not follow activity order or appeared in their project as well');
      assert(document.querySelector(`[data-workspace-id="${home.id}"]`)?.classList.contains('group-pinned'), 'Pinning a session changed the project pin');
      await action(organization(), 'Sort by creation time');
      assert(listed('Pinned sessions') === [second.id, first.id].join(','), 'Creation sort did not reorder pinned sessions');
      await action(organization(), 'Sort by recent activity');

      await action(organization(), 'New section'); await nameSection(' Research ');
      await action(trigger(first.id), 'Move to Research');
      await action(trigger(second.id), 'Move to Research');
      assert(listed('Research') === [first.id, second.id].join(',') && !section('Pinned sessions') && unique(first.id)
        && row(first.id)?.querySelector('.session-attention.is-unread'), 'Moving a pinned session lost attention or duplicated its row');
      await action(organization(), 'Sort by creation time');
      assert(listed('Research') === [second.id, first.id].join(','), 'Creation sort did not reorder the section');
      const comfortableHeight = row(first.id)!.getBoundingClientRect().height;
      await action(organization(), 'Compact sidebar');
      assert(compact() && row(first.id)!.getBoundingClientRect().height < comfortableHeight, 'Compact density did not reduce row height');
      await action(section('Research')!.querySelector('[aria-haspopup=menu]')!, 'Rename section'); await nameSection('Delivery');
      assert(!section('Research') && listed('Delivery') === [second.id, first.id].join(','), 'Renaming did not keep section membership and order');
      await action(trigger(first.id), 'Pin session');
      assert(listed('Pinned sessions') === first.id && unique(first.id), 'Pinning an organized session duplicated it');
      await action(trigger(first.id), 'Unpin session');
      assert(listed('Delivery') === [second.id, first.id].join(',') && unique(first.id), 'Unpinning did not restore the existing section');
      await action(trigger(second.id), 'Move back to project');
      assert(row(second.id)?.closest(`#workspace-sessions-${other.id}`) && document.activeElement === trigger(second.id), 'Returning to a project did not reveal and focus the session');
      await action(trigger(second.id), 'Move to Delivery');
      await action(trigger(third.id), 'Pin session');

      await render(<div />); await render(<App />);
      assert(compact() && listed('Delivery') === [second.id, first.id].join(',') && listed('Pinned sessions') === third.id,
        'Session pin, section membership, order or density did not survive reopening');
      await performClick(row(second.id)!.querySelector<HTMLButtonElement>('.sidebar-session-open')!);
      await settle();
      assert(opened.at(-1)?.join(',') === [other.id, second.id].join(',') && row(second.id)?.querySelector('[aria-current=true]'),
        'Opening a grouped session did not select its original project and session');
      await action(trigger(third.id), 'Move to Delivery');
      await replace({ ...snapshot, sessions: [{ ...first, archived: true }, third] });
      assert(!row(first.id) && !row(second.id) && listed('Delivery') === third.id, 'An archived or deleted session remained in the sidebar');
      await replace({ ...snapshot, sessions: [first, second, third] });
      assert(listed('Delivery') === third.id, 'A stale placement returned when a session reappeared');
      await expand(home);
      await action(section('Delivery')!.querySelector('[aria-haspopup=menu]')!, 'Remove section');
      assert(!section('Delivery') && row(third.id)?.closest(`#workspace-sessions-${home.id}`)
        && document.activeElement === organization(), 'Removing a section did not return sessions to their projects or restore focus');
    } finally {
      await render(<div />);
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  },
  'SIDEBAR-LAYOUT: drag, keyboard and collapse preserve the sidebar preference and workspace': async () => {
    const snapshot: Snapshot = { ...collaborationSnapshot([]), workspaces: [workspace], sessions: [session], providers: [provider] };
    window.workbench = {
      ...applicationUpdateApi,
      snapshot: async () => snapshot, subscribe: () => () => {},
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {},
      watchSessions: async () => {}, listFiles: async () => [], gitState: async () => ({ available: false }), setUnsavedFiles: () => {},
    } as unknown as Window['workbench'];
    const key = 'ensemble.sidebar-layout';
    const previous = localStorage.getItem(key);
    localStorage.removeItem(key);
    try {
      await render(<App />);
      const sidebar = () => document.querySelector<HTMLElement>('.workspace-sidebar')!;
      const width = () => sidebar().getBoundingClientRect().width;
      const host = sidebar().parentElement!.parentElement!;
      host.style.width = '1440px';
      await frames();
      const handle = sidebar().querySelector<HTMLElement>('[role=separator]')!;
      const start = width();
      handle.setPointerCapture = () => {};
      const pointer = (type: string, clientX: number) => act(async () => {
        handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 3, button: 0, clientX }));
        await tick();
      });
      await pointer('pointerdown', start);
      await pointer('pointermove', start + 140);
      assert(width() === start + 140 && localStorage.getItem(key) === null, 'Dragging did not update the left pane before saving');
      await pointer('pointerup', start + 140);
      await act(async () => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await tick(); });
      const saved = start + 164;
      assert(width() === saved && JSON.parse(localStorage.getItem(key)!).width === saved, 'Keyboard resizing did not update the preferred width');
      host.style.width = '1040px';
      await waitFor(() => width() < saved, 'Narrow workspace did not limit the width');
      host.style.width = '1440px';
      await waitFor(() => width() === saved, 'Wider workspace did not restore the preferred width');
      const main = document.querySelector('main');
      await click('shell:app.hideSidebar');
      assert(sidebar().hidden && width() === 0 && document.querySelector('main') === main, 'Collapsing the sidebar replaced the workspace or left it visible');
      await render(<div />);
      await render(<App />);
      assert(sidebar().hidden, 'The sidebar did not remember that it was collapsed');
      await click('shell:app.showSidebar');
      await waitFor(() => width() === saved, 'Showing the sidebar lost the preferred width');
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
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
    let openNotification!: Parameters<Window['workbench']['onFocusSession']>[0];
    window.workbench = {
      subscribe: (listener: typeof publish) => { publish = listener; return () => {}; }, snapshot: async () => snapshot,
      ...applicationUpdateApi, getConnection: async () => ({ status: 'connected', synced: true }),
      onConnectionChanged: () => () => {}, onFocusSession: (listener: typeof openNotification) => { openNotification = listener; return () => {}; },
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
      await act(async () => { openNotification({ sessionId: waiting.id, reason: 'approval', approvalId: 'Older approval' }); await tick(); });
      await waitFor(() => (document.activeElement as HTMLElement)?.dataset.approvalId === 'Older approval',
        'A native notification opened the latest approval instead of the approval clicked');
      await visitInbox(); await select(failure.id);
      await waitFor(() => isVisible('[data-message-id="matching-failed-event"].conversation-match') &&
        Boolean(document.querySelector('[data-message-id="matching-failed-event"] .process-reveal[data-expanded=true]')), 'Opening a failure selected an unrelated attempt or did not reveal its Trace');
      assert(opens.at(-1)?.sessionId === failure.id && !seen.includes(failure.id), 'Opening an earlier failure targeted the wrong session or marked unseen tail output');
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
  'TERMINAL-SERVICES: confirmed local listeners open HTTP previews only on click': async () => {
    if (!navigator.platform.startsWith('Mac')) return;
    const info = { id: 'service-terminal', workspaceId: workspace.id, title: 'Terminal', status: 'running' as const, exitCode: null, output: '', outputOffset: 0 };
    const listener = { host: '127.0.0.1' as const, port: 49321 };
    const previews: [string, string][] = [];
    let observed = true;
    let scans = 0;
    let hold = false;
    const pendingScan = deferred<typeof listener[]>();
    window.workbench = {
      onTerminalOutput: () => () => {}, resizeTerminal: async () => {},
      listTerminalServices: async (id: string) => {
        assert(id === info.id, 'Service discovery used a different terminal');
        scans++;
        return hold ? pendingScan.promise : observed ? [listener] : [];
      },
      createPreview: async (id: string, url: string) => { previews.push([id, url]); },
    } as unknown as Window['workbench'];
    const preview = () => document.querySelector<HTMLButtonElement>('.terminal-service-previews button');
    const clickPreview = async () => act(async () => { preview()!.click(); await tick(); });
    await render(<TerminalPane info={info} cwd={workspace.cwd} perform={perform} />);
    await waitFor(() => scans === 1, 'The visible terminal did not request listeners');
    assert(!preview() && !previews.length, 'One observation showed or opened a preview');
    await waitFor(() => Boolean(preview()), 'A listener present in two reads did not appear', 250);
    assert(!previews.length && preview()?.textContent === '127.0.0.1:49321', 'Discovering a listener opened a preview or showed a different address');
    observed = false;
    await clickPreview(); await settle();
    assert(!previews.length && errors.some(error => error.includes(translate('workspace:terminal.listenerUnavailable'))),
      'A listener that disappeared before the click still opened a preview');
    observed = true;
    await clickPreview(); await settle();
    assert(JSON.stringify(previews) === JSON.stringify([[workspace.id, 'http://127.0.0.1:49321']]), 'Clicking a confirmed listener did not open the loopback HTTP URL');
    observed = false;
    await waitFor(() => Boolean(document.querySelector('.terminal-service-closed')), 'A closed listener did not briefly remain visible', 450);
    assert(!preview(), 'A closed listener still offers a preview');

    const beforePending = scans;
    hold = true;
    await waitFor(() => scans > beforePending, 'The next scheduled read did not start', 250);
    const atUnmount = scans;
    await render(<div />);
    await act(async () => { pendingScan.resolve([listener]); await tick(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
    assert(scans === atUnmount && previews.length === 1, 'An old terminal view continued discovery or opened a preview');
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
    const remove = document.querySelector<HTMLButtonElement>('.attachment-remove'); assert(remove && !remove.disabled, 'User cannot remove the unsupported attachment');
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
  'RUNTIME-ACCOUNT: native sign-in and sign-out surface their own status': async () => {
    const codex = { ...provider, id: 'codex', available: true };
    const requests: string[] = [];
    let done = deferred<void>();
    let native: import('../shared/types').NativeRuntimeAccount = { status: 'signed-out' };
    window.workbench = {
      providerHealth: async () => [codex], runtimeAccount: async () => native,
      signInRuntime: async (id: string, method: string) => {
        requests.push(`${id}:${method}`);
        native = { status: 'signed-out', phase: 'waiting', challenge: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' } };
        await done.promise;
      },
      cancelRuntimeSignIn: async () => { native = { status: 'signed-out', phase: 'cancelled' }; done.resolve(); },
      signOutRuntime: async () => { requests.push('sign-out'); native = { status: 'signed-out' }; },
    } as unknown as Window['workbench'];
    const snapshot: Snapshot = { ...collaborationSnapshot([]), providers: [codex] };
    await render(<ProvidersContent snapshot={snapshot} perform={perform} pending={new Set()} />);
    await click('shell:provider.accountDevice');
    await waitFor(() => document.querySelector<HTMLAnchorElement>('.provider-account-actions a')?.href === 'https://auth.openai.com/codex/device', 'Device verification link did not appear');
    assert(document.querySelector('.provider-account-actions code')?.textContent === 'ABCD-1234', 'Device code was omitted');
    await click('shell:common.cancel');
    await waitFor(() => document.querySelector('.provider-account [role=status]')?.textContent === translate('shell:provider.accountCancelled'), 'Cancellation status was overwritten');
    assert(!document.querySelector('.provider-account-actions code'), 'The cancelled device code remained visible');
    done = deferred<void>();
    await click('shell:provider.accountDevice');
    await act(async () => { native = { status: 'signed-in', label: 'fixture@example.invalid' }; done.resolve(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.provider-account')?.textContent?.includes('fixture@example.invalid')), 'Native account status did not update');
    await click('shell:provider.accountSignOut');
    assert(Boolean(document.querySelector('dialog[open]')) && !requests.includes('sign-out'), 'Opening confirmation signed out immediately');
    await act(async () => { document.querySelector<HTMLButtonElement>('dialog[open] .modal-actions .danger')!.click(); await tick(); });
    await waitFor(() => Boolean(document.querySelector('.provider-account')?.textContent?.includes(translate('shell:provider.accountStatus.signed-out'))), 'Sign-out did not update account status');
  },
  'RUNTIME-INSTALL: missing runtime can install, cancel, retry and show detection': async () => {
    const missing = { ...provider, id: 'codex', available: false };
    const requests: string[] = [];
    let done = deferred<void>();
    let phase = 'idle';
    window.workbench = {
      providerHealth: async () => [missing],
      runtimeInstalls: async () => [{ providerId: missing.id, packageName: '@openai/codex', manager: 'npm', prerequisiteMet: true, phase }],
      installRuntime: async (id: string) => { requests.push(`install:${id}`); phase = 'installing'; await done.promise; },
      cancelRuntimeInstall: async (id: string) => { requests.push(`cancel:${id}`); phase = 'cancelled'; done.resolve(); },
    } as unknown as Window['workbench'];
    const snapshot: Snapshot = { ...collaborationSnapshot([]), providers: [missing] };
    await render(<ProvidersContent snapshot={snapshot} perform={perform} pending={new Set()} />);
    const status = () => document.querySelector('.provider-install-action [role=status]')?.textContent;
    await waitFor(() => Boolean(document.querySelector('.provider-install-action button')), 'The installer action did not load');
    const install = button('shell:provider.installNow');
    await act(async () => { install.focus(); install.click(); await tick(); });
    await waitFor(() => status() === translate('shell:provider.installPhase.installing'), 'The installation did not display progress');
    assert(button('shell:provider.installCancel') === install && document.activeElement === install, 'Installation progress replaced the focused action');
    await click('shell:provider.installCancel');
    await waitFor(() => status() === translate('shell:provider.installPhase.cancelled'), 'Cancellation did not update the UI');
    done = deferred<void>();
    await click('shell:provider.installNow');
    await waitFor(() => status() === translate('shell:provider.installPhase.installing'), 'The cancelled installation could not retry');
    await act(async () => { phase = 'failed'; done.resolve(); await tick(); });
    await waitFor(() => document.querySelector('.provider-install-action [role=alert]')?.textContent === translate('shell:provider.installProblem.install'),
      'The installer did not present its failure once in the runtime panel');
    assert(errors.length === 0, 'A reported installation phase also raised a global error');
    done = deferred<void>();
    await click('shell:provider.installRetry');
    await waitFor(() => status() === translate('shell:provider.installPhase.installing'), 'Retry did not start a fresh installation');
    await act(async () => { phase = 'complete'; done.resolve(); await tick(); });
    await waitFor(() => status() === translate('shell:provider.installPhase.complete'), 'Successful detection was not shown');
    assert(requests.join(',') === 'install:codex,cancel:codex,install:codex,install:codex', 'An operation ran for the wrong runtime or twice');
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
  'SESSION-COLLABORATION: a live grant opens a stable canvas and message details follow the receipt': async () => {
    const source = { ...session, id: 'live-source', title: 'Implementation' };
    const target = { ...session, id: 'live-target', title: 'Review' };
    const run = collaborationRun('Saved run', '2026-11-10T08:00:00Z');
    const grant = { fromSessionId: source.id, toSessionId: target.id };
    const participant = ({ id, title, providerId, cwd }: Session) => ({ sessionId: id, title, providerId, cwd });
    let link: SessionCollaboration = { id: 'live-source-target', grants: [grant], messages: [], updatedAt: '2026-11-10T08:01:00Z',
      participants: [participant(source), participant(target)] };
    let detail: SessionCollaborationMessage;
    let sessionLinkJump: { id: string } | undefined;
    const requests: string[] = [];
    const opened: string[] = [];
    window.workbench = { queryCollaborationEvents: async () => [], collaborationCall: async (operation: string, input: { id: string }) => {
      assert(operation === 'get_session_handoff', 'An observed relationship attempted a management call');
      requests.push(input.id);
      return detail;
    } } as unknown as Window['workbench'];
    const show = (links: SessionCollaboration[], runs: CollaborationRun[] = [run]) => {
      const snapshot = collaborationSnapshot(runs);
      snapshot.collaboration!.sessionLinks = links;
      return render(<CollaborationViews snapshot={{ ...snapshot, sessions: [source, target], providers: [provider] }} initialCwd={workspace.cwd} perform={perform} pending={new Set()} openSession={id => opened.push(id)} sessionLinkJump={sessionLinkJump} />);
    };
    const press = async (element: Element) => act(async () => { (element as HTMLElement).click(); await tick(); });
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.collaboration-run-item')];
    const edge = () => document.querySelector('.react-flow__edge-path');
    const edgeLabel = () => document.querySelector<HTMLButtonElement>('.execution-edge-label')!;
    const positions = () => [...document.querySelectorAll<HTMLElement>('.react-flow__node, .react-flow__viewport')].map(node => node.style.transform).join('|');

    await show([], []);
    const draft = labeledInput('collaboration:setup.goal');
    await change(draft, 'Unfinished draft');
    await show([link]);
    assert(rows().length === 2 && rows()[0].textContent?.includes('Implementation · Review'), 'The live grant did not appear immediately alongside the saved run');
    assert(labeledInput('collaboration:setup.goal') === draft && draft.value === 'Unfinished draft', 'A background grant discarded the current draft');

    await press(rows()[0]); await graphReady(2); await frames(12);
    assert(document.querySelector('.session-collaboration-view h1')?.textContent === 'Implementation · Review', 'Selecting the live grant did not open its canvas');
    assert(document.querySelector('.collaboration-timeline')?.textContent?.includes(translate('collaboration:session.waitingForMessage')), 'A grant without a handoff did not explain the empty history');
    assert(edge()?.hasAttribute('marker-end') && !edge()?.hasAttribute('marker-start'), 'The canvas did not show the granted direction');
    await graphClick('node', target.id);
    const openTarget = translate('collaboration:session.openNamed', { title: target.title });
    await press([...document.querySelectorAll('button')].find(item => item.textContent?.trim() === openTarget)!);
    assert(opened.join() === target.id, 'The session node did not link to the actual session');

    detail = { ...grant, id: 'handoff', createdAt: link.updatedAt, text: 'Read the full implementation notes.\nCheck the direct impact.', status: 'queued' };
    const preview = { ...detail, text: 'Read the full implementation notes…' };
    link = { ...link, messages: [preview] };
    await show([link]);
    assert(edgeLabel().textContent === translate('collaboration:session.latestMessage', { status: translate('shell:status.queued') }), 'The route did not update when a message was queued');
    await press(edgeLabel()); await frames(12);
    const panel = document.querySelector('.collaboration-selection-scroll')!;
    assert(panel.querySelector('pre')?.textContent === detail.text && requests.join() === detail.id, 'The selected message did not load its complete text');
    const canvas = positions();

    detail = { ...detail, status: 'completed', delivery: 'accepted', reply: 'Verified the direct impact.\nOne issue remains.', continuation: 'waiting' };
    link = { ...link, messages: [{ ...detail, text: preview.text, reply: 'Verified the direct impact…' }], updatedAt: '2026-11-10T08:02:00Z' };
    await show([link], [{ ...run, updatedAt: '2026-11-10T08:03:00Z' }]); await frames(4);
    assert(rows()[1].getAttribute('aria-current') === 'page' && positions() === canvas, 'A receipt update or sidebar reorder moved the current canvas');
    assert(document.querySelector('.collaboration-selection-scroll') === panel && panel.querySelector('.status-completed') && panel.querySelectorAll('pre')[1]?.textContent === detail.reply, 'Completion did not refresh the open message and its full reply');
    assert(requests.length === 2 && requests[1] === detail.id, 'The open message was not refreshed on its receipt transition');

    await show([{ ...link, grants: [] }]);
    assert(!edge()?.hasAttribute('marker-end') && document.querySelector('.session-collaboration-routes')?.textContent?.includes(translate('collaboration:session.revoked')) && document.querySelector('.session-collaboration-messages .status-completed'), 'Revoking the grant did not preserve message history without a permission arrow');

    sessionLinkJump = { id: link.id };
    await show([]);
    assert(document.querySelector('.collaboration-run-view h1')?.textContent === run.definitionSnapshot.name, 'An unresolved session jump replaced the current collaboration');
    await show([link]);
    assert(document.querySelector('.session-collaboration-view h1'), 'The pending jump did not open the relationship when it arrived');
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
