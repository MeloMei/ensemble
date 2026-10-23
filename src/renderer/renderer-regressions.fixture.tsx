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

interface Result { name: string; error?: string }
interface FixtureWindow extends Window { runRendererRegressions(): Promise<Result[]>; IS_REACT_ACT_ENVIRONMENT: boolean }
const fixture = window as unknown as FixtureWindow;
fixture.IS_REACT_ACT_ENVIRONMENT = true;
const workspace: Workspace = { id: 'workspace', name: 'Workspace', cwd: '/fixture', pinned: false, tabs: [], activeTabId: null, createdAt: '2026-10-23', updatedAt: '2026-10-23' };
const session: Session = { id: 'session', title: 'Session', providerId: 'codex', cwd: workspace.cwd, status: 'idle', messages: [], approvals: [], settings: { permission: 'review', effort: 'low' }, createdAt: '2026-10-23', updatedAt: '2026-10-23' };
const provider: ProviderInfo = { id: 'codex', name: 'Codex', source: 'builtin', available: true, detail: '', capabilities: { resume: true, approvals: true, permissions: true, effort: true }, efforts: ['low', 'high'] };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
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
  'UI-05: consecutive settings controls send only their changed keys': async () => {
    const writes: Record<string, unknown>[] = [];
    window.workbench = {
      listSkills: async () => [{ id: 'skill', name: 'Skill', path: '/skill', description: '', scope: 'project', editable: true }],
      updateSession: async (_id: string, patch: Record<string, unknown>) => { writes.push(structuredClone(patch)); },
    } as unknown as Window['workbench'];
    await render(chat()); await click('workspace:chat.settings');
    const selects = () => [...document.querySelectorAll<HTMLSelectElement>('.session-settings select')];
    await change(selects().find(item => item.value === 'review')!, 'read-only');
    await change(selects().find(item => item.value === 'low')!, 'high');
    await change(input('.session-skills input'), true);
    await change(selects().find(item => item.value === 'low')!, '');
    assert(JSON.stringify(writes) === JSON.stringify([{ settings: { permission: 'read-only' } }, { settings: { effort: 'high' } }, { settings: { skillIds: ['skill'] } }, { settings: { effort: null } }]), `A stale setting was sent: ${JSON.stringify(writes)}`);
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
fixture.runRendererRegressions = async () => {
  await i18n.changeLanguage('en');
  const results: Result[] = [];
  for (const [name, check] of Object.entries(cases)) {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host); errors.length = 0; operations = [];
    try { await check(); results.push({ name }); }
    catch (error) { results.push({ name, error: error instanceof Error ? error.stack : String(error) }); }
    finally { await act(async () => root.unmount()); host.remove(); }
  }
  return results;
};
