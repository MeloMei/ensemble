import React, { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { MotionConfig } from 'framer-motion';
import { i18n, translate } from '../shared/i18n';
import type { FileContent, McpSettingsView, ProviderInfo, Session, UnsavedFileSummary, Workflow, Workspace } from '../shared/types';
import { WorkspaceTools } from './WorkspaceTools';
import { WorkflowView } from './WorkflowViews';
import { FileReviewPanel } from './FileReviewPanel';
import { SessionChat } from './SessionChat';
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
    await click('workspace:tools.newSkill'); await change(input('.tools-editor input'), 'different'); await change(input('.tools-editor textarea'), 'other draft');
    skillGate.resolve(); await settle();
    assert(input('.tools-editor input').value === 'different' && input('.tools-editor textarea').value === 'other draft', 'An old save replaced a different editor');
    assert(errors.length === 0, errors.join('\n'));
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
    await show(queued, { text: 'A newer draft' });
    assert(input('.composer textarea').value === 'A newer draft', 'Queue updates replaced the composer draft');
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
