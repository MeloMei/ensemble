import { CollaborationViews } from './CollaborationViews';
import type { CollaborationRun, CollaborationEvent } from '../shared/collaboration';
import React, { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { MotionConfig } from 'framer-motion';
import { i18n, translate } from '../shared/i18n';
import type { DiagnosticEntry, FileContent, McpSettingsView, Message, PromptInput, ProviderInfo, Session, Snapshot, UnsavedFileSummary, Workflow, Workspace } from '../shared/types';
import type { BackendConnectionState, SessionHistoryWindow } from '../shared/backend';
import { WorkspaceTools } from './WorkspaceTools';
import { ProvidersView, WorkflowView } from './WorkflowViews';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ManagedWorktreePanel } from './ManagedWorktreePanel';
import { FileReviewPanel } from './FileReviewPanel';
import { SessionChat } from './SessionChat';
import { App } from './App';
import { TerminalPane } from './TerminalPane';
import { Terminal } from '@xterm/xterm';
import { AppearanceProvider } from './appearance';
import type { Perform } from './ui';
import './styles.css';

interface Result { name: string; error?: string }
interface FixtureWindow extends Window { runRendererRegressions(selected?: string[] | null): Promise<Result[]>; IS_REACT_ACT_ENVIRONMENT: boolean }
const fixture = window as unknown as FixtureWindow;
fixture.IS_REACT_ACT_ENVIRONMENT = true;
const workspace: Workspace = { id: 'workspace', name: 'Workspace', cwd: '/fixture', pinned: false, tabs: [], activeTabId: null, createdAt: '2026-10-23', updatedAt: '2026-10-23' };
const session: Session = { id: 'session', title: 'Session', providerId: 'codex', cwd: workspace.cwd, status: 'idle', messages: [], approvals: [], settings: { permission: 'review', effort: 'low' }, createdAt: '2026-10-23', updatedAt: '2026-10-23' };
const provider: ProviderInfo = { id: 'codex', name: 'Codex', source: 'builtin', available: true, detail: '', capabilities: { resume: true, approvals: true, permissions: true, effort: true }, efforts: ['low', 'high'] };
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
async function render(element: ReactElement) { await act(async () => { root.render(<I18nextProvider i18n={i18n}><AppearanceProvider><MotionConfig reducedMotion="always">{element}</MotionConfig></AppearanceProvider></I18nextProvider>); await tick(); }); }
async function click(key: string) { await act(async () => { button(key).click(); await tick(); }); }
async function settle() { await act(async () => { await Promise.all(operations); await tick(); }); }
const chat = (overrides: Partial<Parameters<typeof SessionChat>[0]> = {}) => <SessionChat session={session} provider={provider} perform={perform} pending={new Set()} draft={{ text: '' }} onDraftChange={() => {}} workspaceId={workspace.id} openSession={() => {}} {...overrides} />;
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

const cases: Record<string, () => Promise<void>> = {
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
    await render(<WorkspaceTools workspace={workspace} sessions={[]} perform={perform} onClose={() => {}} />);
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
    await render(<WorkspaceTools workspace={workspace} sessions={[]} perform={perform} onClose={() => { closed++; }} />);
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
    await render(<WorkspaceTools workspace={workspace} sessions={[]} perform={perform} onClose={() => { closed++; }} />);
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
    const show = (value: Workspace) => render(<React.StrictMode><WorkspaceTools key={value.id} workspace={value} sessions={[]} perform={perform} onClose={() => {}} /></React.StrictMode>);
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
    const show = () => render(<WorkspaceTools workspace={target} sessions={[]} perform={perform} onClose={() => {}} />);
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
  'UI-05: inline session controls preserve drafts, capabilities and partial settings updates': async () => {
    const writes: Record<string, unknown>[] = [];
    let draftChanges = 0;
    const configuredProvider: ProviderInfo = { ...provider, models: [{ id: 'model-a', name: 'Model A', free: false }, { id: 'model-b', name: 'Model B', free: false }] };
    const configuredSession: Session = { ...session, modelId: 'model-a' };
    const draft = { text: 'Keep this unfinished task', attachments: [{ id: 'attachment', name: 'note.txt', kind: 'text' as const, ownedPath: '/note.txt', mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) }] };
    const show = (overrides: Partial<Parameters<typeof SessionChat>[0]> = {}) => render(chat({ session: configuredSession, provider: configuredProvider, draft, onDraftChange: () => { draftChanges++; }, ...overrides }));
    const selector = (key: string) => `.composer-controls select[aria-label="${translate(`workspace:chat.${key}`)}"]`;
    const control = (key: string) => input(selector(key)) as HTMLSelectElement;
    const controls = () => ['model', 'effort', 'permissions'].map(control);
    window.workbench = {
      listSkills: async () => [{ id: 'skill', name: 'Skill', path: '/skill', description: '', scope: 'project', editable: true }],
      updateSession: async (_id: string, patch: Record<string, unknown>) => { writes.push(structuredClone(patch)); },
    } as unknown as Window['workbench'];
    await show();
    const textarea = input('textarea');
    const assertDraft = () => assert(input('textarea') === textarea && textarea.value === draft.text && document.querySelector('.attachments-strip')?.textContent?.includes('note.txt') && draftChanges === 0, 'Session controls replaced or erased the unfinished draft');
    assert(button('workspace:chat.settings').getAttribute('aria-expanded') === 'false' && controls().every(item => !item.disabled), 'Session controls require opening settings or are unavailable while idle');
    await change(control('permissions'), 'read-only');
    await change(control('effort'), 'high');
    await change(control('model'), 'model-b');
    await click('workspace:chat.settings');
    assert(!document.querySelector('.session-settings select'), 'Advanced settings duplicate the inline session controls');
    await change(input('.session-skills input'), true);
    await change(control('effort'), '');
    await change(control('model'), '');
    assert(JSON.stringify(writes) === JSON.stringify([{ settings: { permission: 'read-only' } }, { settings: { effort: 'high' } }, { modelId: 'model-b' }, { settings: { skillIds: ['skill'] } }, { settings: { effort: null } }, { modelId: null }]), `A stale setting was sent: ${JSON.stringify(writes)}`);
    assertDraft();
    await click('workspace:chat.settings');
    for (const status of ['running', 'waiting_approval', 'waiting_children', 'queued'] as const) {
      await show({ session: { ...configuredSession, status } });
      assert(controls().every(item => item.disabled), `Session controls remain editable during ${status}`);
    }
    for (const key of [`send-${session.id}`, `session-settings-${session.id}`]) {
      await show({ pending: new Set([key]) });
      assert(controls().every(item => item.disabled), `Session controls remain editable during ${key}`);
    }
    await show({ pending: new Set(['session-settings-other-session']) });
    assert(controls().every(item => !item.disabled), 'Another session settings write blocks this composer');
    await show({ provider: { ...configuredProvider, capabilities: { ...configuredProvider.capabilities, effort: false, permissions: false } } });
    assert(!document.querySelector(selector('effort')) && !document.querySelector(selector('permissions')) && !control('model').disabled, 'Unsupported runtime controls remain visible');
    await show({ provider: { ...configuredProvider, efforts: [] } });
    assert(!document.querySelector(selector('effort')), 'Empty reasoning options still expose a reasoning control');
    await show({ provider: { ...configuredProvider, models: [] } });
    assert(control('model').disabled && control('model').value === configuredSession.modelId, 'Missing model catalog hides or enables changing the current model');
    await show({ session, provider: { ...configuredProvider, models: [] } });
    assert(control('model').disabled && control('model').value === '', 'Missing model catalog does not preserve the runtime default');
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
    await show(queued, { text: 'A newer draft' });
    assert(input('.composer textarea').value === 'A newer draft', 'Queue updates replaced the composer draft');
  },
  'UX-N1: named session tabs reveal the active tab without stealing focus': async () => {
    const sessions = Array.from({ length: 10 }, (_, index) => ({ ...session, id: `navigation-${index}`, title: `Independent task ${index}`, messages: [] }));
    const tabs = sessions.map(value => ({ id: `tab-${value.id}`, kind: 'agent' as const, sessionId: value.id }));
    let snapshot: Snapshot = { version: 1, sessions, providers: [provider], workspaces: [{ ...workspace, tabs, activeTabId: tabs[0].id }],
      workflows: [], terminals: [], pluginErrors: [], pluginPath: '/plugins', dataPath: '/data' };
    let publish!: (value: Snapshot) => void;
    window.workbench = {
      snapshot: async () => snapshot, subscribe: (listener: (value: Snapshot) => void) => { publish = listener; return () => {}; },
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
      assert(document.querySelector('.group-attention .workspace-row .attention-failure') && document.querySelector('.workspace-unread')?.textContent === '1', 'A newer result hid an older unread failure');
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
      getConnection: async () => ({ status: 'connected', synced: true }), onConnectionChanged: () => () => {}, onFocusSession: () => () => {}, watchSessions: async () => {},
      createWorkspace: async (input: Record<string, unknown>) => { creations.push(input); if (creations.length === 1) throw new Error('creation response lost'); return 'created-workspace'; },
    } as unknown as Window['workbench'];
    await render(<App />); await click('shell:app.addProject');
    const mode = input('dialog select') as HTMLSelectElement;
    assert(mode.value === 'directory', 'Creating a workspace silently defaults to a new worktree');
    await change(input('.directory-field input'), '/fixture'); await change(mode, 'worktree');
    await change(input(`input[placeholder="${translate('shell:app.worktreeBranchDefault')}"]`), 'codex/isolated');
    await click('shell:app.createWorkspace');
    await waitFor(() => creations.length === 1 && !button('shell:app.createWorkspace').disabled, 'Failed creation did not leave the editable dialog');
    await click('shell:app.createWorkspace'); await waitFor(() => creations.length === 2, 'Creation retry did not start');
    await waitFor(() => !document.querySelector('dialog'), 'Successful workspace creation did not close the dialog');
    assert(creations[0].commandId && creations[0].commandId === creations[1].commandId && creations[1].mode === 'worktree' && creations[1].branch === 'codex/isolated' && creations[1].cwd === '/fixture', 'Workspace retry changed its intent or lost the isolation choice');
    await click('shell:app.addProject'); await change(input('.directory-field input'), '/fixture'); await click('shell:app.createWorkspace');
    await waitFor(() => creations.length === 3, 'The next creation did not start');
    assert(creations[2].mode === 'directory' && creations[2].commandId !== creations[1].commandId, 'An independent creation reused the completed intent');
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
    await render(<ProvidersView snapshot={snapshot} perform={perform} pending={new Set()} />);
    const authentication = () => document.querySelector<HTMLElement>('[data-stage="authentication"]')!;
    assert(authentication().dataset.status === 'unknown' && document.querySelector('.availability.available'), 'A detected CLI was treated as authenticated');
    await change(input('.runtime-directory select'), workspace.cwd);
    await change(input('.runtime-directory select'), other.cwd);
    assert(authentication().dataset.status === 'unknown', 'Changing directories displayed another project authentication');
    await act(async () => { second.resolve([checked('ready', 'completed-turn')]); await tick(); });
    await waitFor(() => authentication().dataset.status === 'ready', 'Selected directory evidence did not load');
    await act(async () => { first.resolve([checked('error', 'runtime-authentication-error')]); await tick(); });
    assert(authentication().dataset.status === 'ready' && authentication().textContent?.includes('A task completed in this directory')
      && (input('.runtime-directory select') as HTMLSelectElement).value === other.cwd, 'A late response replaced the newly selected directory');
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
fixture.runRendererRegressions = async selected => {
  await i18n.changeLanguage('en');
  const results: Result[] = [];
  for (const [name, check] of Object.entries(cases)) {
    if (selected?.length && !selected.some(prefix => name.startsWith(prefix))) continue;
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host); errors.length = 0; operations = [];
    host.style.cssText = 'display:flex;width:1100px;height:740px;min-height:0';
    try { await check(); results.push({ name }); }
    catch (error) { results.push({ name, error: error instanceof Error ? error.stack : String(error) }); }
    finally { await act(async () => root.unmount()); host.remove(); }
  }
  return results;
};
