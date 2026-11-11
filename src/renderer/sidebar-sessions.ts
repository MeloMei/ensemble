import { useEffect, useMemo, useReducer } from 'react';
import { z } from 'zod';
import type { Session, Snapshot } from '../shared/types';

const storageKey = 'ensemble.sidebar-sessions';
export const sectionNameLimit = 80;
const sectionNameSchema = z.string().trim().min(1).max(sectionNameLimit);
const sectionSchema = z.object({ id: z.string().min(1), name: sectionNameSchema });
const placementSchema = z.object({ pinned: z.literal(true).optional(), sectionId: z.string().optional() });
const preferencesSchema = z.object({
  version: z.literal(1),
  sections: z.array(sectionSchema).refine(sections => new Set(sections.map(section => section.id)).size === sections.length),
  placements: z.record(placementSchema),
  sort: z.enum(['activity', 'created']),
  density: z.enum(['comfortable', 'compact']),
});
type Preferences = z.infer<typeof preferencesSchema>;
export type SidebarSessionSection = z.infer<typeof sectionSchema>;
type Placement = z.infer<typeof placementSchema>;
export type SidebarSessionAction =
  | { type: 'saveSection'; section: SidebarSessionSection }
  | { type: 'removeSection'; id: string }
  | { type: 'placeSession'; id: string; placement: Placement }
  | { type: 'sort'; sort: Preferences['sort'] }
  | { type: 'density'; density: Preferences['density'] }
  | { type: 'prune'; ids: ReadonlySet<string> };

const defaults: Preferences = { version: 1, sections: [], placements: {}, sort: 'activity', density: 'comfortable' };

function readPreferences(): Preferences {
  try {
    const stored = preferencesSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
    return stored.success ? stored.data : defaults;
  } catch { return defaults; }
}

export function sectionNameAvailable(sections: readonly SidebarSessionSection[], section: SidebarSessionSection) {
  const name = section.name.trim().toLocaleLowerCase();
  return !sections.some(item => item.id !== section.id && item.name.toLocaleLowerCase() === name);
}

export function sessionPlacement(prefs: Preferences, id: string): Placement {
  if (!Object.hasOwn(prefs.placements, id)) return {};
  const { pinned, sectionId } = prefs.placements[id];
  return { pinned, sectionId: prefs.sections.some(section => section.id === sectionId) ? sectionId : undefined };
}

function reducePreferences(prefs: Preferences, action: SidebarSessionAction): Preferences {
  switch (action.type) {
    case 'sort': return prefs.sort === action.sort ? prefs : { ...prefs, sort: action.sort };
    case 'density': return prefs.density === action.density ? prefs : { ...prefs, density: action.density };
    case 'saveSection': {
      const section = sectionSchema.safeParse(action.section);
      if (!section.success || !sectionNameAvailable(prefs.sections, section.data)) return prefs;
      const sections = prefs.sections.some(item => item.id === section.data.id)
        ? prefs.sections.map(item => item.id === section.data.id ? section.data : item)
        : [...prefs.sections, section.data];
      return { ...prefs, sections };
    }
    case 'removeSection': {
      const sections = prefs.sections.filter(section => section.id !== action.id);
      if (sections.length === prefs.sections.length) return prefs;
      const placements = Object.fromEntries(Object.entries(prefs.placements).flatMap<[string, Placement]>(([id, placement]) => {
        if (placement.sectionId !== action.id) return [[id, placement]];
        return placement.pinned ? [[id, { pinned: true }]] : [];
      }));
      return { ...prefs, sections, placements };
    }
    case 'placeSession': {
      const { id, placement } = action;
      if (placement.sectionId && !prefs.sections.some(section => section.id === placement.sectionId)) return prefs;
      const placements = { ...prefs.placements };
      if (placement.pinned || placement.sectionId) placements[id] = placement;
      else delete placements[id];
      return { ...prefs, placements };
    }
    case 'prune': {
      const entries = Object.entries(prefs.placements);
      const valid = entries.filter(([id]) => action.ids.has(id));
      return valid.length === entries.length ? prefs : { ...prefs, placements: Object.fromEntries(valid) };
    }
  }
}

function groupSessions(snapshot: Snapshot | null, prefs: Preferences) {
  const projectByPath = new Map<string, string>();
  for (const project of snapshot?.workspaces ?? []) {
    if (!project.archived && !projectByPath.has(project.cwd)) projectByPath.set(project.cwd, project.id);
  }
  const projectBySession = new Map<string, string>();
  const projects = new Map<string, Session[]>();
  const sections = new Map(prefs.sections.map(section => [section.id, [] as Session[]]));
  const pinned: Session[] = [];
  for (const session of snapshot?.sessions ?? []) {
    const project = projectByPath.get(session.cwd);
    if (!project || session.archived || projectBySession.has(session.id)) continue;
    projectBySession.set(session.id, project);
    const placement = sessionPlacement(prefs, session.id);
    if (placement.pinned) pinned.push(session);
    else if (placement.sectionId) sections.get(placement.sectionId)?.push(session);
    else {
      const rows = projects.get(project);
      if (rows) rows.push(session);
      else projects.set(project, [session]);
    }
  }
  const newestCreated = (a: Session, b: Session) => b.createdAt.localeCompare(a.createdAt);
  const compare = prefs.sort === 'created' ? newestCreated
    : (a: Session, b: Session) => b.updatedAt.localeCompare(a.updatedAt) || newestCreated(a, b);
  for (const rows of projects.values()) rows.sort(newestCreated);
  for (const rows of sections.values()) rows.sort(compare);
  pinned.sort(compare);
  return { projectBySession, projects, sections, pinned };
}

export function useSidebarSessions(snapshot: Snapshot | null, connected: boolean) {
  const [prefs, dispatch] = useReducer(reducePreferences, undefined, readPreferences);
  const groups = useMemo(() => groupSessions(snapshot, prefs), [snapshot, prefs]);
  useEffect(() => {
    if (snapshot && connected) dispatch({ type: 'prune', ids: new Set(groups.projectBySession.keys()) });
  }, [snapshot, connected, groups.projectBySession]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(prefs)); }
    catch { /* The current window still retains its preferences. */ }
  }, [prefs]);
  return { prefs, groups, dispatch };
}
