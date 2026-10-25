import type { McpSettingsView, SkillInfo, UnsavedFileSummary, Workspace } from '../shared/types';

export interface SkillDraft {
  token: object; id?: string; name: string; content: string; revision?: string; editable: boolean;
  saved: { name: string; content: string };
}
export interface WorkspaceToolDrafts {
  skills: SkillInfo[];
  servers: McpSettingsView['servers'];
  skill?: SkillDraft;
  mcp?: Pick<McpSettingsView, 'content' | 'revision'>;
  mcpDraft: { content: string };
  savingSkill?: SkillDraft;
  savingMcp: boolean;
}
interface Entry { name: string; value: WorkspaceToolDrafts; listeners: Set<() => void> }
type DraftWorkspace = Pick<Workspace, 'id' | 'name'>;
const empty = (): WorkspaceToolDrafts => ({ skills: [], servers: [], mcpDraft: { content: '' }, savingMcp: false });
export const hasSkillEdits = (draft?: SkillDraft) => Boolean(draft?.editable && (draft.name !== draft.saved.name || draft.content !== draft.saved.content));
export const hasMcpEdits = (drafts: WorkspaceToolDrafts) => drafts.mcpDraft.content !== (drafts.mcp?.content ?? '');

export class WorkspaceToolDraftStore {
  private entries = new Map<string, Entry>();
  constructor(private changed: (summary: UnsavedFileSummary, sourceId: string) => void) {}

  get(workspace: DraftWorkspace): WorkspaceToolDrafts { return this.entry(workspace).value; }
  subscribe(workspace: DraftWorkspace, listener: () => void): () => void {
    const entry = this.entry(workspace);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); this.prune(workspace.id, entry); };
  }
  update(workspace: DraftWorkspace, update: (current: WorkspaceToolDrafts) => WorkspaceToolDrafts): void {
    const entry = this.entry(workspace);
    entry.value = update(entry.value);
    this.changed(this.summary(entry), `workspace-tools:${workspace.id}`);
    for (const listener of entry.listeners) listener();
    this.prune(workspace.id, entry);
  }
  discard(workspace: DraftWorkspace): boolean {
    const current = this.get(workspace);
    if (current.savingSkill || current.savingMcp) return false;
    this.update(workspace, empty);
    return true;
  }
  private entry(workspace: DraftWorkspace): Entry {
    let entry = this.entries.get(workspace.id);
    if (!entry) { entry = { name: workspace.name, value: empty(), listeners: new Set() }; this.entries.set(workspace.id, entry); }
    entry.name = workspace.name;
    return entry;
  }
  private summary(entry: Entry): UnsavedFileSummary {
    const value = entry.value;
    const skills = [value.savingSkill, hasSkillEdits(value.skill) ? value.skill : undefined]
      .filter((skill): skill is SkillDraft => Boolean(skill))
      .filter((skill, index, values) => values.findIndex(item => item.token === skill.token) === index);
    const names = skills.map(skill => `${entry.name} · Skill ${skill.name || 'SKILL.md'}`);
    if (value.savingMcp || hasMcpEdits(value)) names.push(`${entry.name} · MCP`);
    return { count: names.length, names };
  }
  private prune(id: string, entry: Entry): void {
    if (entry.listeners.size) return;
    if (!this.summary(entry).count) { this.entries.delete(id); return; }
    const value = entry.value;
    entry.value = {
      ...value, skills: [], servers: [],
      skill: hasSkillEdits(value.skill) || value.savingSkill?.token === value.skill?.token ? value.skill : undefined,
      ...(!value.savingMcp && !hasMcpEdits(value) ? { mcp: undefined, mcpDraft: { content: '' } } : {}),
    };
  }
}

export const workspaceToolDrafts = new WorkspaceToolDraftStore((summary, sourceId) => window.workbench.setUnsavedFiles(summary, sourceId));
