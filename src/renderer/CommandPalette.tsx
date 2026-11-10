import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { File, Folder, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderInfo, Session, Workspace } from '../shared/types';
import { AgentIcon } from './AgentIcon';
import { OverlayContext } from './overlays';
import { Modal } from './ui';
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

interface CommandSection {
  id: string;
  label: string;
  entries: CommandEntry[];
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
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const projectNames = new Map(projects.map(project => [project.cwd, project.name]));
  const providerNames = new Map(providers.map(provider => [provider.id, provider.name]));
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const { matches: files, loading: filesLoading, error: filesError } = useWorkspaceFileMatches(fileWorkspaceId, query.trim() || null);
  const sections: CommandSection[] = [
    { id: 'actions', label: t('commandPalette.actions'), entries: actions },
    { id: 'settings', label: t('preferences.title'), entries: tokens.length ? settings : [] },
    { id: 'files', label: t('commandPalette.files'), entries: files.map(file => ({
      id: `file:${file.path}`, label: file.name, detail: file.path,
      icon: <File size={16} aria-hidden="true" />, run: () => onOpenFile?.(file.path),
    })) },
    { id: 'projects', label: t('commandPalette.projects'), entries: projects.map(project => ({
      id: `project:${project.id}`, label: project.name, detail: project.cwd,
      icon: <Folder size={16} aria-hidden="true" />, run: () => onSelectProject(project.id),
    })) },
    { id: 'sessions', label: t('commandPalette.sessions'), entries: sessions.map(session => ({
      id: `session:${session.id}`, label: session.title, keywords: session.cwd,
      detail: [providerNames.get(session.providerId) ?? session.providerId, projectNames.get(session.cwd) ?? session.cwd,
        session.archived ? t('commandPalette.archived') : undefined].filter(Boolean).join(' · '),
      icon: <AgentIcon providerId={session.providerId} size={16} />, run: () => onSelectSession(session.id),
    })) },
  ];
  const results = sections.map(section => ({
    ...section,
    entries: section.id === 'files' ? section.entries : tokens.length ? section.entries.filter(entry => {
      const searchable = [entry.label, entry.detail, entry.keywords].filter(Boolean).join(' ').toLocaleLowerCase();
      return tokens.every(token => searchable.includes(token));
    }) : section.entries.slice(0, 8),
  })).filter(section => section.entries.length > 0);
  const entries = results.flatMap(section => section.entries);
  const selected = entries.find(entry => entry.id === selectedId) ?? entries[0];
  const rowId = (entry: CommandEntry) => `${listId}-${entry.id}`;

  useLayoutEffect(() => {
    const viewport = list.current;
    const row = activeRow.current;
    if (!viewport || !row) return;
    const bounds = viewport.getBoundingClientRect();
    const option = row.getBoundingClientRect();
    if (option.top < bounds.top) viewport.scrollTop += option.top - bounds.top;
    else if (option.bottom > bounds.bottom) viewport.scrollTop += option.bottom - bounds.bottom;
  }, [selected?.id, query]);

  function run(entry: CommandEntry) {
    onClose();
    entry.run();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !selected) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) run(selected);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = entries.indexOf(selected);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelectedId(entries[(index + step + entries.length) % entries.length].id);
    }
  }

  return <Modal title={t('commandPalette.title')} className="command-palette" initialFocus={search} fallbackFocus={trigger} onClose={onClose}>
    <div className="command-palette-search">
      <Search size={17} aria-hidden="true" />
      <input ref={search} role="combobox" aria-label={t('commandPalette.search')} aria-autocomplete="list"
        aria-expanded="true" aria-controls={listId} aria-activedescendant={selected && rowId(selected)} autoComplete="off" spellCheck={false}
        placeholder={t('commandPalette.search')} value={query} onKeyDown={onKeyDown}
        onChange={event => setQuery(event.target.value)} />
    </div>
    <div className="command-palette-results">
      <div id={listId} role="listbox" aria-label={t('commandPalette.results')} ref={list} className="command-palette-list">
        {results.map(section => <div key={section.id} role="group" aria-label={section.label}>
          <div className="command-palette-section" aria-hidden="true">{section.label}</div>
          {section.entries.map(entry => <div key={entry.id} ref={entry === selected ? activeRow : undefined}
            id={rowId(entry)} role="option" aria-selected={entry === selected} className="command-palette-option"
            onMouseDown={event => event.preventDefault()} onClick={() => run(entry)}>
            <span className="command-palette-icon">{entry.icon}</span>
            <div className="command-palette-copy"><span>{entry.label}</span>{entry.detail && <small>{entry.detail}</small>}</div>
          </div>)}
        </div>)}
      </div>
      {!selected && <p role="status" className="command-palette-empty">
        {filesLoading ? t('commandPalette.searchingFiles') : filesError || t('commandPalette.empty')}
      </p>}
    </div>
    <div className="command-palette-hints">
      <span><kbd>↑</kbd><kbd>↓</kbd>{t('commandPalette.navigate')}</span>
      <span><kbd>↵</kbd>{t('commandPalette.activate')}</span>
      <span><kbd>Esc</kbd>{t('common.close')}</span>
    </div>
  </Modal>;
}
