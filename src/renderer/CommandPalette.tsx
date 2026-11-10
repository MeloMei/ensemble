import { useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { File, Folder, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderInfo, Session, Workspace } from '../shared/types';
import { AgentIcon } from './AgentIcon';
import { OverlayContext } from './overlays';
import { Modal } from './ui';
import { SearchPicker, type SearchPickerSection } from './ui-kit';
import { useWorkspaceFileMatches } from './workspace-file-search';
import './CommandPalette.css';

export interface CommandEntry {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  actions: CommandEntry[];
  settings?: CommandEntry[];
  fileWorkspaceId?: string;
  onOpenFile?: (path: string) => void;
  projects: Workspace[];
  sessions: Session[];
  providers: ProviderInfo[];
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
}

const isMac = navigator.platform.startsWith('Mac');

export function CommandPalette(props: CommandPaletteProps) {
  const { t } = useTranslation('shell');
  const { top } = useContext(OverlayContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      if (top && !top.contains(search.current)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) setOpen(current => !current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [top]);

  return <>
    <button type="button" className="command-palette-trigger" ref={trigger} aria-label={t('commandPalette.trigger')} aria-haspopup="dialog" aria-expanded={open}
      aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
      onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}>
      <Search size={15} aria-hidden="true" />
      <span>{t('commandPalette.trigger')}</span>
      <kbd aria-hidden="true">{isMac ? '⌘K' : 'Ctrl+K'}</kbd>
    </button>
    {open && <PaletteDialog {...props} search={search} trigger={trigger} onClose={() => setOpen(false)} />}
  </>;
}

function PaletteDialog({ actions, settings = [], fileWorkspaceId, onOpenFile, projects, sessions, providers, onSelectProject, onSelectSession, search, trigger, onClose }: CommandPaletteProps & {
  search: RefObject<HTMLInputElement | null>;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation('shell');
  const [query, setQuery] = useState('');
  const projectNames = new Map(projects.map(project => [project.cwd, project.name]));
  const providerNames = new Map(providers.map(provider => [provider.id, provider.name]));
  const { matches: files, loading: filesLoading, error: filesError } = useWorkspaceFileMatches(fileWorkspaceId, query.trim() || null);
  const sections = [
    { id: 'actions', label: t('commandPalette.actions'), items: actions, initialLimit: 8 },
    { id: 'settings', label: t('preferences.title'), items: settings, initialLimit: 0 },
    { id: 'files', label: t('commandPalette.files'), prefiltered: true, items: files.map(file => ({
      id: `file:${file.path}`, label: file.name, detail: file.path,
      icon: <File size={16} aria-hidden="true" />, run: () => onOpenFile?.(file.path),
    })) },
    { id: 'projects', label: t('commandPalette.projects'), initialLimit: 8, items: projects.map(project => ({
      id: `project:${project.id}`, label: project.name, detail: project.cwd,
      icon: <Folder size={16} aria-hidden="true" />, run: () => onSelectProject(project.id),
    })) },
    { id: 'sessions', label: t('commandPalette.sessions'), initialLimit: 8, items: sessions.map(session => ({
      id: `session:${session.id}`, label: session.title, keywords: session.cwd,
      detail: [providerNames.get(session.providerId) ?? session.providerId, projectNames.get(session.cwd) ?? session.cwd,
        session.archived ? t('commandPalette.archived') : undefined].filter(Boolean).join(' · '),
      icon: <AgentIcon providerId={session.providerId} size={16} />, run: () => onSelectSession(session.id),
    })) },
  ] satisfies (SearchPickerSection & { items: CommandEntry[] })[];
  const actionsById = new Map(sections.flatMap(section => section.items.map(item => [item.id, item.run] as const)));

  return <Modal title={t('commandPalette.title')} className="command-palette" initialFocus={search} fallbackFocus={trigger} onClose={onClose}>
    <SearchPicker sections={sections} inputRef={search} query={query} onQueryChange={setQuery}
      inputLabel={t('commandPalette.search')} placeholder={t('commandPalette.search')} resultsLabel={t('commandPalette.results')}
      emptyText={filesError || t('commandPalette.empty')} loading={filesLoading} loadingText={t('commandPalette.searchingFiles')}
      onSelect={id => { onClose(); actionsById.get(id)?.(); }} />
    <div className="command-palette-hints">
      <span><kbd>↑</kbd><kbd>↓</kbd>{t('commandPalette.navigate')}</span>
      <span><kbd>↵</kbd>{t('commandPalette.activate')}</span>
      <span><kbd>Esc</kbd>{t('common.close')}</span>
    </div>
  </Modal>;
}
