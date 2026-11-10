import { useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronRight, File, FileText, Folder, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderInfo, Session, Workspace } from '../shared/types';
import { AgentIcon } from './AgentIcon';
import { OverlayContext } from './overlays';
import { Modal } from './ui';
import { SearchPicker, type SearchPickerSection } from './ui-kit';
import type { FileReference } from './workspace-file-reference';
import { useWorkspaceFileMatches, useWorkspaceTextMatches } from './workspace-file-search';
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
  onOpenFile?: (reference: FileReference) => void;
  projects: Workspace[];
  sessions: Session[];
  providers: ProviderInfo[];
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
}

const isMac = navigator.platform.startsWith('Mac');
const shortcutModifier = isMac ? 'Meta' : 'Control';
const shortcutBadge = isMac ? '⌘' : 'Ctrl+';
const scopes = ['all', 'sessions', 'commands', 'files', 'settings'] as const;
type Scope = typeof scopes[number];

function hasShortcutModifier(event: KeyboardEvent) {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && !event.altKey && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented;
}

export function CommandPalette(props: CommandPaletteProps) {
  const { t } = useTranslation('shell');
  const { top } = useContext(OverlayContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!hasShortcutModifier(event) || event.key.toLowerCase() !== 'k') return;
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
      aria-keyshortcuts={`${shortcutModifier}+K`}
      onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}>
      <Search size={15} aria-hidden="true" />
      <span>{t('commandPalette.trigger')}</span>
      <kbd aria-hidden="true">{shortcutBadge}K</kbd>
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
  const { top } = useContext(OverlayContext);
  const id = useId();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const focusSearch = () => search.current?.focus({ preventScroll: true });
  const selectScope = (value: Scope) => { setScope(value); focusSearch(); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!hasShortcutModifier(event) || !/^[1-5]$/.test(event.key) || !top?.contains(search.current)
        || !(event.target instanceof Node) || !top.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        setScope(scopes[Number(event.key) - 1]);
        search.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [search, top]);

  const projectNames = new Map(projects.map(project => [project.cwd, project.name]));
  const providerNames = new Map(providers.map(provider => [provider.id, provider.name]));
  const fileQuery = scope === 'all' || scope === 'files' ? query.trim() : '';
  const files = useWorkspaceFileMatches(fileWorkspaceId, fileQuery || null);
  const contents = useWorkspaceTextMatches(fileWorkspaceId, fileQuery.length >= 2 ? fileQuery : null);
  const groups: (SearchPickerSection & { scope: Exclude<Scope, 'all'>; label: string; items: CommandEntry[] })[] = [
    { id: 'actions', scope: 'commands', label: t('commandPalette.commands'), items: actions },
    { id: 'projects', scope: 'commands', label: t('commandPalette.projects'), items: projects.map(project => ({
      id: `project:${project.id}`, label: project.name, detail: project.cwd,
      icon: <Folder size={16} aria-hidden="true" />, run: () => onSelectProject(project.id),
    })) },
    { id: 'sessions', scope: 'sessions', label: t('commandPalette.sessions'), items: sessions.map(session => ({
      id: `session:${session.id}`, label: session.title, keywords: session.cwd,
      detail: [providerNames.get(session.providerId) ?? session.providerId, projectNames.get(session.cwd) ?? session.cwd,
        session.archived ? t('commandPalette.archived') : undefined].filter(Boolean).join(' · '),
      icon: <AgentIcon providerId={session.providerId} size={16} />, run: () => onSelectSession(session.id),
    })) },
    { id: 'settings', scope: 'settings', label: t('preferences.title'), items: settings },
    { id: 'files', scope: 'files', label: t('commandPalette.fileNames'), prefiltered: true, items: files.matches.map(file => ({
      id: `file:${file.path}`, label: file.name, detail: file.path,
      icon: <File size={16} aria-hidden="true" />, run: () => onOpenFile?.({ path: file.path }),
    })) },
    { id: 'contents', scope: 'files', label: t('commandPalette.fileContents'), prefiltered: true,
      items: (contents.result?.matches ?? []).map(({ path, line, column, preview }) => ({
        id: `content:${path}:${line}:${column}`, label: preview, detail: `${path}:${line}:${column}`,
        icon: <FileText size={16} aria-hidden="true" />, run: () => onOpenFile?.({ path, line, column }),
      })) },
  ];
  const sections = groups.filter(group => scope === 'all' || group.scope === scope).map(group => ({
    ...group,
    initialLimit: scope === 'all' && group.scope === 'settings' ? 0 : undefined,
    overflow: scope === 'all' ? { limit: 5, item: {
      id: `more:${group.id}`, label: t('commandPalette.more', { section: group.label }), icon: <ChevronRight size={16} aria-hidden="true" />,
    } } : undefined,
  }));

  const panelId = `${id}-results`;
  const tabId = (value: Scope) => `${id}-${value}`;
  const error = files.error || contents.error;
  const fileStatus = error ? t('commandPalette.fileSearchError') : contents.result?.limited ? t('commandPalette.fileSearchLimited') : '';
  const emptyText = scope === 'files' && !fileWorkspaceId ? t('commandPalette.filesNeedWorkspace')
    : scope === 'files' && !fileQuery ? t('commandPalette.fileSearchPrompt') : t('commandPalette.empty');

  return <Modal title={t('commandPalette.title')} className="command-palette" initialFocus={search} fallbackFocus={trigger} onClose={onClose}
    onCancel={() => {
      if (query) { setQuery(''); focusSearch(); }
      else if (scope !== 'all') selectScope('all');
      else onClose();
    }}>
    <SearchPicker sections={sections} inputRef={search} query={query} onQueryChange={setQuery}
      inputLabel={t('commandPalette.search')} placeholder={t('commandPalette.search')} resultsLabel={t('commandPalette.results')}
      emptyText={emptyText} loading={files.loading || contents.loading} loadingText={t('commandPalette.searchingFiles')}
      filters={{ panelId, labelId: tabId(scope), controls: <div className="command-palette-scopes" role="tablist" aria-label={t('commandPalette.scopes')}
        onKeyDown={event => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const index = scopes.indexOf(scope);
          const next = event.key === 'ArrowLeft' ? (index + scopes.length - 1) % scopes.length
            : event.key === 'ArrowRight' ? (index + 1) % scopes.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? scopes.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          setScope(scopes[next]);
          event.currentTarget.querySelectorAll('button')[next]?.focus({ preventScroll: true });
        }}>
        {scopes.map((value, index) => <button key={value} id={tabId(value)} type="button" role="tab" aria-selected={scope === value}
          aria-controls={panelId} aria-keyshortcuts={`${shortcutModifier}+${index + 1}`} tabIndex={scope === value ? 0 : -1}
          onClick={event => { setScope(value); if (event.detail) focusSearch(); }}>
          {t(`commandPalette.${value}`)}<kbd aria-hidden="true">{shortcutBadge}{index + 1}</kbd>
        </button>)}
      </div> }}
      onSelect={id => {
        const more = sections.find(section => section.overflow?.item.id === id);
        if (more) { selectScope(more.scope); return; }
        const item = sections.flatMap(section => section.items).find(item => item.id === id);
        if (item) { onClose(); item.run(); }
      }} />
    <div className="command-palette-hints">
      <span><kbd>↑</kbd><kbd>↓</kbd>{t('commandPalette.navigate')}</span>
      <span><kbd>↵</kbd>{t('commandPalette.activate')}</span>
      <span><kbd>Esc</kbd>{t(query ? 'commandPalette.clearQuery' : scope !== 'all' ? 'commandPalette.backToAll' : 'common.close')}</span>
      <span role="status" className="command-palette-file-status" title={error || undefined}>{fileStatus}</span>
    </div>
  </Modal>;
}
