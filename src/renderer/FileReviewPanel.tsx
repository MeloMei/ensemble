import { useTranslation } from 'react-i18next';
import { formatDate, renderDisplayText } from '../shared/i18n';
import type { DisplayText } from '../shared/display-text';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FileCode2, Files, GitBranch, GitCompareArrows, GitPullRequest, Maximize2, MessageSquare, Minimize2, PanelRight, RefreshCw, Save, Search, Timer, WrapText, X } from 'lucide-react';
import { z } from 'zod';
import type { FileContent, FileDiff, FileEntry, FileImage, GitCommitPreview, GitMutation, GitState, PullRequestReview, Session, Workspace, WorkspaceFilePath } from '../shared/types';
import { rasterImageMimeFromPath } from '../shared/raster-image';
import { matchesWorkspaceFile, workspaceFileParent, type WorkspaceFileMutation } from '../shared/workspace-file-mutations';
import { BranchComparison } from './BranchComparison';
import { CodeEditor, type CodeEditorHandle, type CodeEditorPosition } from './CodeEditor';
import { FileEditorTabs } from './FileEditorTabs';
import { ImageFilePreview, MarkdownFilePreview } from './FilePreview';
import { DiffReview } from './DiffReview';
import { GitHistory } from './GitHistory';
import { GitBranchControl } from './GitBranchControl';
import { GitSyncControl } from './GitSyncControl';
import { WorkspaceFileTree, type FileTreeAction, type FileTreeChange } from './WorkspaceFileTree';
import { FileDraftStore } from './file-drafts';
import { diffRangeLines, reviewFeedback, reviewNoteSchema, type DiffNoteDraft, type ReviewNote } from './review-notes';
import { IconButton, Modal, type Perform } from './ui';
import { OperationFeedback } from './ui-kit/OperationFeedback';
import { operationError } from './ui-kit/useOperationFeedback';
import { useFileDiskCheck } from './useFileDiskCheck';
import { WorkspaceFileNavigation, type FileReference } from './workspace-file-reference';
import './FileReviewPanel.css';

const notesSchema = z.array(reviewNoteSchema).max(200);
type FileRefresh = 'files' | 'pullRequest';
type FileNotice = { message: string | DisplayText; state?: 'status'; refresh?: FileRefresh };
const emptyEntries: FileEntry[] = [];
const writeFile = (workspaceId: string, input: Parameters<Window['workbench']['writeFile']>[1]) => window.workbench.writeFile(workspaceId, input);
const fileDrafts = new FileDraftStore(summary => window.workbench.setUnsavedFiles(summary), { delay: 1000, write: writeFile });
const editorPreferencesKey = 'ensemble.file-editor';
type EditorPreferences = { wrapLines: boolean; autoSave: boolean };
type EditorTab = { kind: 'text'; path: string; position: CodeEditorPosition; preview: boolean }
  | { kind: 'image'; path: string; image: FileImage };
type FileDraft = NonNullable<ReturnType<FileDraftStore['get']>>;
const isDirty = (draft: FileDraft | undefined) => Boolean(draft && draft.text !== draft.original.content);
const joinFilePath = (parent: string, name: string) => parent ? `${parent.replace(/\/$/, '')}/${name}` : name;

function readEditorPreferences(): EditorPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(editorPreferencesKey) ?? 'null') as Partial<EditorPreferences> | null;
    return { wrapLines: saved?.wrapLines === true, autoSave: saved?.autoSave === true };
  } catch { return { wrapLines: false, autoSave: false }; }
}

function persistedNotes(workspaceId: string): ReviewNote[] {
  try { return notesSchema.parse(JSON.parse(localStorage.getItem(`workbench:review:${workspaceId}`) ?? '[]')); }
  catch { return []; }
}
function matchesReviewRevision(diff: FileDiff, revision: string): boolean {
  return !diff.binary && !diff.truncated && diff.revision === revision;
}

function revealSelectedDiff(layout: HTMLDivElement, inline: boolean) {
  const inspector = layout.querySelector<HTMLElement>('.review-inspector');
  const list = layout.querySelector<HTMLElement>('.review-tree');
  const row = list?.querySelector('.tree-row.selected')?.closest<HTMLElement>('.review-change-row');
  const scroller = inline ? layout : list;
  const anchor = row ?? (inline ? inspector : null);
  if (!inspector || !scroller || !anchor) return;

  const viewport = scroller.getBoundingClientRect();
  const bounds = anchor.getBoundingClientRect();
  const diffBounds = inspector.getBoundingClientRect();
  const bottom = inline ? Math.min(diffBounds.bottom, diffBounds.top + Math.min(140, viewport.height / 2)) : bounds.bottom;
  if (bounds.top < viewport.top || bottom > viewport.bottom) {
    scroller.scrollTop += bounds.top - viewport.top - (inline ? 6 : 0);
  }
}

export function FileReviewPanel({ workspace, refreshKey, perform, visible = true, sessions = [], onFeedback, onEditProject }: {
  workspace: Workspace; refreshKey: string; perform: Perform; visible?: boolean; sessions?: Session[];
  onFeedback?(text: string): void; onEditProject?(): void;
}) {
  const { t } = useTranslation('workspace');
  const navigation = useContext(WorkspaceFileNavigation);
  const workspaceKey = JSON.stringify([workspace.id, workspace.cwd]);
  const [view, setView] = useState<'files' | 'changes' | 'pr'>('files');
  const [rootListing, setRootListing] = useState<{ workspaceKey: string; entries: FileEntry[]; revision: number }>();
  const tree = rootListing?.workspaceKey === workspaceKey ? rootListing : undefined;
  const [missingDirectory, setMissingDirectory] = useState(false);
  const [git, setGit] = useState<GitState | null>(null);
  const [checkedChanges, setCheckedChanges] = useState<ReadonlySet<string>>(() => new Set());
  const [tabs, setTabs] = useState<{ open: EditorTab[]; active: string | null }>({ open: [], active: null });
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [location, setLocation] = useState<FileReference>();
  const [closingTab, setClosingTab] = useState<{ path: string; draft: FileDraft }>();
  const [treeAction, setTreeAction] = useState<FileTreeAction>();
  const [treeChange, setTreeChange] = useState<FileTreeChange>();
  const [treeName, setTreeName] = useState('');
  const [editorPreferences, setEditorPreferences] = useState(readEditorPreferences);
  const tabId = useId();
  const activeTabButton = useRef<HTMLButtonElement>(null);
  const focusAfterClose = useRef(false);
  const editor = useRef<CodeEditorHandle>(null);
  useSyncExternalStore(fileDrafts.subscribe, fileDrafts.getSnapshot);
  const activeTab = tabs.open.find(tab => tab.path === tabs.active);
  const selected = diff ? { path: diff.path, mode: 'diff' as const } : activeTab ? { path: activeTab.path, mode: 'content' as const } : null;
  const currentLocation = location?.path === selected?.path ? location : undefined;
  const contentTab = selected?.mode === 'content' ? activeTab : undefined;
  const image = contentTab?.kind === 'image' ? contentTab.image : undefined;
  const buffer = contentTab?.kind === 'text' ? fileDrafts.get(workspace.id, contentTab.path) : undefined;
  const file = buffer?.original ?? null;
  const draft = buffer?.text ?? '';
  const markdown = file?.language === 'markdown';
  const markdownPreview = markdown && contentTab?.kind === 'text' && contentTab.preview;
  const [operationNotice, setOperationNotice] = useState<FileNotice>();
  const [operationBusy, setBusy] = useState(false);
  const busy = operationBusy || (file !== null && fileDrafts.isSaving(workspace.id, file.path));
  const [preview, setPreview] = useState<GitCommitPreview | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [discard, setDiscard] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [review, setReview] = useState<PullRequestReview | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<ReadonlyMap<string, DiffNoteDraft>>(() => new Map());
  const [notes, setNotes] = useState({ workspaceId: workspace.id, items: persistedNotes(workspace.id) });
  const directoryGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const operations = useRef(0);
  const diskCheckBlocked = useCallback(() => operations.current > 0 || (editor.current?.isComposing() ?? false), []);
  const reviewLayout = useRef<HTMLDivElement>(null);
  const panelHeader = useRef<HTMLElement>(null);
  const retryFocus = useRef<HTMLButtonElement>(null);
  const responsiveDiff = view === 'changes' && selected?.mode === 'diff' && !expanded;
  const selectedChangeIndex = responsiveDiff ? git?.changes.findIndex(change => change.path === selected.path) ?? -1 : -1;
  const dirty = isDirty(buffer);
  const tabItems = tabs.open.map(tab => ({
    path: tab.path, dirty: tab.kind === 'text' && isDirty(fileDrafts.get(workspace.id, tab.path)),
    saving: tab.kind === 'text' && fileDrafts.isSaving(workspace.id, tab.path),
  }));
  const hasUnsavedFiles = tabItems.some(tab => tab.dirty || tab.saving);
  const closingBusy = closingTab !== undefined && (operationBusy || fileDrafts.isSaving(workspace.id, closingTab.path));
  const editorOpen = view !== 'pr' && selected?.mode === 'content' && selected.path === file?.path;
  const diskStatus = editorOpen ? buffer?.diskStatus : undefined;
  const diskNotice = diskStatus === 'changed' ? 'workspace:files.changedDraft'
    : diskStatus === 'missing' ? (dirty ? 'workspace:files.missingDraft' : 'workspace:files.missing')
    : diskStatus === 'unreadable' ? (dirty ? 'workspace:files.unreadableDraft' : 'workspace:files.unreadable') : undefined;
  const saveError = !diskStatus && dirty && typeof buffer?.autoSaveBlock === 'object' ? buffer.autoSaveBlock.error : undefined;
  const notice = operationNotice ?? (saveError ? {
    message: editorPreferences.autoSave ? { key: 'workspace:editor.autoSavePaused', values: { error: saveError } } : saveError,
  } : undefined);
  const retryTarget = notice?.refresh;
  const currentNotes = notes.workspaceId === workspace.id ? notes.items : [];
  const changes = git?.changes ?? [];
  const checked = changes.filter(change => checkedChanges.has(change.path));
  const allChecked = checked.length > 0 && checked.length === changes.length;
  const stageable = checked.filter(change => change.status[1] !== ' ').map(change => change.path);
  const unstageable = checked.filter(change => change.staged).map(change => change.path);

  useLayoutEffect(() => { fileDrafts.setAutoSave(editorPreferences.autoSave); }, [editorPreferences.autoSave]);
  useLayoutEffect(() => {
    const button = retryFocus.current;
    if (busy || !button) return;
    retryFocus.current = null;
    if (!button.isConnected && document.activeElement === document.body) panelHeader.current?.querySelector('button')?.focus();
  }, [busy, notice]);
  useFileDiskCheck(fileDrafts, workspace.id, visible && editorOpen && !operationBusy ? file?.path : undefined, diskCheckBlocked);
  useLayoutEffect(() => {
    if (!focusAfterClose.current) return;
    focusAfterClose.current = false;
    activeTabButton.current?.focus({ preventScroll: true });
  }, [tabs]);

  const toggleEditorPreference = (preference: keyof EditorPreferences) => {
    const next = { ...editorPreferences, [preference]: !editorPreferences[preference] };
    setEditorPreferences(next);
    try { localStorage.setItem(editorPreferencesKey, JSON.stringify(next)); }
    catch { /* The current editor still retains the preference. */ }
  };

  useLayoutEffect(() => {
    const layout = reviewLayout.current;
    if (!responsiveDiff || !layout) return;
    let inline: boolean | undefined;
    const reveal = () => {
      const next = getComputedStyle(layout).flexDirection === 'column';
      if (next === inline) return;
      inline = next;
      revealSelectedDiff(layout, next);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(layout.closest('.file-review-panel') ?? layout);
    return () => observer.disconnect();
  }, [responsiveDiff, selected?.path, selectedChangeIndex]);

  const run = (key: string, action: () => Promise<unknown>, target?: FileRefresh, retry?: { notice: FileNotice; button: HTMLButtonElement }) => {
    if (retry && operations.current) return;
    if (!retry) setOperationNotice(undefined);
    operations.current++; setBusy(true);
    void perform(`review-${workspace.id}-${key}`, async () => {
      try {
        await action();
        if (retry) {
          if (document.activeElement === retry.button) retryFocus.current = retry.button;
          setOperationNotice(current => current === retry.notice ? undefined : current);
        }
      } catch (failure) { setOperationNotice({ message: operationError(failure), refresh: target }); }
      finally { operations.current--; if (!operations.current) setBusy(false); }
    });
  };
  const refresh = async () => {
    const token = ++directoryGeneration.current;
    let listing: FileEntry[] | null;
    try { listing = await window.workbench.listFiles(workspace.id, ''); }
    catch (failure) {
      if (token !== directoryGeneration.current) return;
      setMissingDirectory(false);
      throw failure;
    }
    if (token !== directoryGeneration.current) return;
    setMissingDirectory(listing === null);
    setRootListing(previous => ({ workspaceKey, entries: listing ?? emptyEntries, revision: (previous?.revision ?? 0) + 1 }));
    if (listing === null) { setGit(null); setView('files'); return; }
    try {
      const status = await window.workbench.gitState(workspace.id);
      if (token !== directoryGeneration.current) return;
      setGit(status);
      if (status.error && !/not a git repository/i.test(status.error)) throw new Error(status.error);
    } catch (failure) { if (token === directoryGeneration.current) throw failure; }
  };
  const refreshPullRequest = async () => {
    setReview(await window.workbench.reviewPullRequest(workspace.id));
  };
  const refreshPanel = (target: FileRefresh, retry?: { notice: FileNotice; button: HTMLButtonElement }) =>
    run('refresh', target === 'files' ? refresh : refreshPullRequest, target, retry);
  const showFile = (path: string, reference?: FileReference, image?: FileImage) => {
    setTabs(current => {
      const existing = current.open.find(tab => tab.path === path);
      const tab: EditorTab = image ? { kind: 'image', path, image } : existing ?? { kind: 'text', path, position: {}, preview: false };
      const next = tab.kind === 'text' && tab.preview && reference?.line !== undefined ? { ...tab, preview: false } : tab;
      const open = existing ? current.open.map(item => item === existing ? next : item) : [...current.open, next];
      return { open, active: path };
    });
    setDiff(null);
    setDiscard(null);
    setLocation(current => reference ?? (current?.path === path ? current : undefined));
    if (reference) setView('files');
  };
  const setMarkdownPreview = (preview: boolean) => {
    setTabs(current => ({
      ...current,
      open: current.open.map(tab => tab.path === current.active && tab.kind === 'text' ? { ...tab, preview } : tab),
    }));
  };
  const closeFile = (path: string, expected?: FileDraft) => {
    const current = fileDrafts.get(workspace.id, path);
    if (current && ((expected ? current !== expected : isDirty(current)) || !fileDrafts.discard(workspace.id, path, current))) {
      throw new Error(t('files.closeChanged'));
    }
    if (path === tabs.active && !diff) {
      fileGeneration.current++;
      setLocation(undefined);
      if (tabs.open.length === 1) setExpanded(false);
    }
    setTabs(current => {
      const index = current.open.findIndex(tab => tab.path === path);
      if (index < 0) return current;
      const open = current.open.filter(tab => tab.path !== path);
      const active = current.active === path ? open[Math.min(index, open.length - 1)]?.path ?? null : current.active;
      return { open, active };
    });
    setClosingTab(current => current?.path === path ? undefined : current);
    focusAfterClose.current = true;
  };
  const load = async (filePath: string, mode: 'content' | 'diff', force = false, reference?: FileReference) => {
    const token = ++fileGeneration.current;
    if (mode === 'content') {
      const imageMime = rasterImageMimeFromPath(filePath);
      if (force && !imageMime) fileDrafts.suspendAutoSaveForDiscard(workspace.id, filePath);
      const cached = imageMime ? undefined : fileDrafts.get(workspace.id, filePath);
      let contents: FileContent | FileImage | null | undefined;
      let failure: unknown;
      try {
        contents = await (imageMime ? window.workbench.readFileImage(workspace.id, filePath) : window.workbench.readFile(workspace.id, filePath));
      }
      catch (error) { failure = error; }
      if (token !== fileGeneration.current) return;

      if (contents === null && force) {
        closeFile(filePath, cached);
        return;
      }
      if (contents) {
        if ('mimeType' in contents) {
          showFile(filePath, reference, contents);
          return;
        }
        const current = fileDrafts.open(workspace, contents, cached, force);
        if (force && current.original !== contents) throw new Error(t('files.changedDraft'));
        if (!force && cached && current.original === cached.original) fileDrafts.observeDisk(workspace.id, cached.original, contents);
      } else {
        if (imageMime) throw contents === null ? new Error(t('files.missing')) : failure;
        const retained = fileDrafts.get(workspace.id, filePath);
        if (force || !retained || (retained.text === retained.original.content && !fileDrafts.isSaving(workspace.id, filePath))) {
          throw contents === null ? new Error(t('files.missing')) : failure;
        }
        if (cached) fileDrafts.observeDisk(workspace.id, cached.original, contents === null ? 'missing' : 'unreadable');
      }
      showFile(filePath, reference);
      return;
    }
    let patch: FileDiff;
    try { patch = await window.workbench.fileDiff(workspace.id, filePath); }
    catch (failure) {
      if (token !== fileGeneration.current) return;
      throw failure;
    }
    if (token !== fileGeneration.current) return;
    setDiff(patch);
    setDiscard(null);
    setLocation(current => current?.path === filePath ? current : undefined);
  };
  const openFile = (path: string, reference?: FileReference) => {
    if (!tabs.open.some(tab => tab.path === path)) {
      run('open', () => load(path, 'content', false, reference));
      return;
    }
    fileGeneration.current++;
    setOperationNotice(undefined);
    showFile(path, reference);
  };
  const requestCloseFile = (path: string) => {
    const current = fileDrafts.get(workspace.id, path);
    if (fileDrafts.isSaving(workspace.id, path)) return;
    setOperationNotice(undefined);
    if (current && isDirty(current)) setClosingTab({ path, draft: current });
    else closeFile(path);
  };
  const closeDiff = () => {
    fileGeneration.current++;
    setDiff(null);
    setDiscard(null);
    setLocation(current => current?.path === tabs.active ? current : undefined);
    if (!tabs.active) setExpanded(false);
  };
  const beginTreeAction = (action: FileTreeAction) => {
    setOperationNotice(undefined);
    setTreeName(action.action === 'rename' ? action.entry.name : '');
    setTreeAction(action);
  };
  const cancelTreeAction = () => { setTreeAction(undefined); setOperationNotice(undefined); };
  const submitTreeAction = () => {
    if (!treeAction || operations.current) return;
    const source = treeAction.action === 'create' ? undefined : treeAction.entry;
    const directory = treeAction.action === 'create' ? treeAction.directory?.path ?? '' : workspaceFileParent(treeAction.entry.path);
    const workspaceRoot = workspace.cwd.replaceAll('\\', '/');
    const realDirectory = treeAction.action === 'create'
      ? treeAction.directory?.realPath ?? joinFilePath(workspaceRoot, directory)
      : treeAction.entry.realPath ? workspaceFileParent(treeAction.entry.realPath) : joinFilePath(workspaceRoot, directory);
    const target: WorkspaceFilePath = { path: joinFilePath(directory, treeName), realPath: joinFilePath(realDirectory, treeName) };
    const mutation: WorkspaceFileMutation = treeAction.action === 'create'
      ? { action: 'create', directory, name: treeName, kind: treeAction.kind }
      : treeAction.action === 'rename' ? { action: 'rename', path: treeAction.entry.path, kind: treeAction.entry.kind, name: treeName }
      : { action: 'delete', path: treeAction.entry.path, kind: treeAction.entry.kind };

    run('file-tree-mutation', async () => {
      if ((source && fileDrafts.hasUnsettledAt(workspace.id, source))
        || (mutation.action !== 'delete' && fileDrafts.hasUnsettledAt(workspace.id, target))) {
        throw new Error(t('files.treeDraftBlocked'));
      }
      fileGeneration.current++;
      try { await window.workbench.mutateWorkspaceFile(workspace.id, mutation); }
      catch (failure) { void refresh().catch(() => {}); throw failure; }
      if (source) {
        for (const tab of tabs.open) {
          const draft = fileDrafts.get(workspace.id, tab.path);
          const identity = tab.kind === 'image' ? tab.image : draft?.original ?? tab;
          if (matchesWorkspaceFile(source, identity, true) && !isDirty(draft) && !fileDrafts.isSaving(workspace.id, tab.path)) closeFile(tab.path);
        }
        if (diff && matchesWorkspaceFile(source, diff, true)) closeDiff();
        setTreeChange({ oldPath: source.path, newPath: mutation.action === 'rename' ? target.path : undefined });
      } else setTreeChange({ revealDirectory: directory });
      setTreeAction(undefined);
      await refresh();
    });
  };

  const request = navigation?.request;
  useEffect(() => {
    if (!request || request.workspaceId !== workspace.id) return;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      navigation?.consume(request);
      openFile(request.path, request);
    });
    return () => { current = false; };
  }, [request, workspace.id]);

  useEffect(() => {
    setMissingDirectory(false); setGit(null); setTabs({ open: [], active: null }); setDiff(null); setLocation(undefined); setClosingTab(undefined);
    setTreeAction(undefined); setTreeChange(undefined);
    setPreview(null); setReview(null); setNotes({ workspaceId: workspace.id, items: persistedNotes(workspace.id) });
    setNoteDrafts(new Map());
    return () => { directoryGeneration.current++; fileGeneration.current++; };
  }, [workspace.id]);
  useEffect(() => { refreshPanel('files'); }, [workspaceKey, refreshKey]);
  useEffect(() => {
    let active = true;
    const unsubscribe = fileDrafts.subscribeAutoSaved(id => {
      if (id !== workspace.id) return;
      void refresh().catch(failure => {
        if (active) setOperationNotice({ message: operationError(failure), refresh: 'files' });
      });
    });
    return () => { active = false; unsubscribe(); };
  }, [workspaceKey]);
  useEffect(() => {
    if (notes.workspaceId !== workspace.id) return;
    try { localStorage.setItem(`workbench:review:${workspace.id}`, JSON.stringify(notes.items)); }
    catch { setOperationNotice({ message: { key: 'workspace:files.notesSaveFailed' } }); }
  }, [notes, workspace.id]);
  const save = (path: string, close = false) => {
    if (fileDrafts.isSaving(workspace.id, path)) return;
    run('save', async () => {
      if (isDirty(fileDrafts.get(workspace.id, path))) {
        await fileDrafts.save(workspace.id, path, input => writeFile(workspace.id, input));
      }
      if (close) closeFile(path);
      await refresh();
    });
  };
  const mutate = (input: GitMutation) => run(input.action, async () => {
    const selectionToken = fileGeneration.current;
    const paths = new Set('paths' in input ? input.paths : [input.path]);
    const updated = await window.workbench.gitMutate(workspace.id, input);
    setGit(updated); setDiscard(null); setPreview(null);
    setCheckedChanges(current => new Set([...current].filter(path => !paths.has(path))));
    if (selected && selectionToken === fileGeneration.current && paths.has(selected.path)) await load(selected.path, 'diff');
  });
  const updateNoteDraft = (path: string, update: (current: DiffNoteDraft | undefined) => DiffNoteDraft | undefined) => {
    setNoteDrafts(current => {
      const previous = current.get(path);
      const draft = update(previous);
      if (draft === previous) return current;
      const next = new Map(current);
      if (draft) next.set(path, draft); else next.delete(path);
      return next;
    });
  };
  const addNote = (draft: DiffNoteDraft) => {
    if (!selected || !diff || !matchesReviewRevision(diff, draft.revision) || !draft.body.trim() || busy || operations.current) return;
    if (currentNotes.length >= 200) { setOperationNotice({ message: { key: 'workspace:files.notesLimit' } }); return; }
    const filePath = selected.path;
    run('save-note', async () => {
      const latest = await window.workbench.fileDiff(workspace.id, filePath);
      if (!matchesReviewRevision(latest, draft.revision)) {
        setDiff(current => current === diff ? latest : current);
        throw new Error(t('files.notesOutdated', { path: filePath }));
      }
      const { side, scope } = draft.range.anchor;
      const note: ReviewNote = { id: crypto.randomUUID(), filePath, ...diffRangeLines(draft.range), body: draft.body.trim(),
        side, scope, revision: draft.revision, createdAt: new Date().toISOString() };
      setNotes(current => current.workspaceId === workspace.id ? { ...current, items: [...current.items, note] } : current);
      updateNoteDraft(filePath, current => current === draft ? undefined : current);
    });
  };
  const sendNotes = () => run('feedback', async () => {
    for (const filePath of new Set(currentNotes.map(note => note.filePath))) {
      const current = await window.workbench.fileDiff(workspace.id, filePath);
      if (currentNotes.some(note => note.filePath === filePath && !matchesReviewRevision(current, note.revision))) {
        throw new Error(t('files.notesOutdated', { path: filePath }));
      }
    }
    onFeedback?.(reviewFeedback(currentNotes));
  });
  const noticeFeedback = notice && <OperationFeedback className={notice.state === 'status' ? 'pane-note' : 'pane-note error-text'}
    state={notice.state ?? 'error'} retry={retryTarget && !closingTab && !preview ? {
      pending: busy, run: button => refreshPanel(retryTarget, { notice, button }),
    } : undefined}>
    {typeof notice.message === 'string' ? notice.message : renderDisplayText('', notice.message)}
  </OperationFeedback>;

  return <aside className={`file-panel file-review-panel ${expanded ? 'review-expanded' : ''}`} aria-label={t('files.title')}>
    <header ref={panelHeader} className="file-panel-header">
      <span className="file-panel-title"><PanelRight size={15} />{t('files.title')}</span>
      <IconButton label={t('files.refresh')} disabled={!!busy} onClick={() => refreshPanel(view === 'pr' ? 'pullRequest' : 'files')}><RefreshCw size={14} /></IconButton>
    </header>
    {missingDirectory && <div className="pane-note" role="status">
      <p>{t('files.projectDirectoryMissing')}</p>
      {onEditProject && <button className="button small" onClick={onEditProject}>{t('files.editProject')}</button>}
    </div>}
    <div className="file-view-tabs" data-view={view} role="group" aria-label={t('files.views')}>
      <button className={view === 'files' ? 'active' : ''} aria-pressed={view === 'files'} onClick={() => setView('files')}><Files size={13} />{t('files.files')}</button>
      <button disabled={missingDirectory} className={view === 'changes' ? 'active' : ''} aria-pressed={view === 'changes'} onClick={() => setView('changes')}><GitCompareArrows size={13} />{t('files.changes')}{git?.available && <span>{git.changes.length}</span>}</button>
      <button disabled={missingDirectory} className={view === 'pr' ? 'active' : ''} aria-pressed={view === 'pr'} onClick={() => { setView('pr'); refreshPanel('pullRequest'); }}><GitPullRequest size={13} />PR / CI</button>
    </div>
    {!missingDirectory && <div className="file-branch"><GitBranch size={13} />{git?.available
      ? <GitBranchControl workspaceId={workspace.id} branch={git.branch}
          blocked={workspace.worktree || workspace.managedWorktreeAlias ? t('files.gitBranchManaged')
            : fileDrafts.hasUnsettledEdits() ? t('files.gitBranchSaveFirst') : git.changes.length ? t('files.gitBranchCleanFirst') : undefined}
          onChanged={state => {
            setGit(state); setCheckedChanges(new Set()); setPreview(null);
            run('refresh', async () => {
              await refresh();
              if (selected) await load(selected.path, selected.mode, true);
            });
          }} />
      : <span>{t('files.notGitLabel')}</span>}
      {view === 'changes' && <BranchComparison workspaceId={workspace.id} />}
      {view === 'changes' && git?.available && <GitHistory workspaceId={workspace.id} />}
      {view === 'changes' && git?.available && <GitSyncControl workspaceId={workspace.id} pullBlocked={fileDrafts.hasUnsettledEdits() || !!git.changes.length}
        onPull={() => run('refresh', async () => { await refresh(); if (selected) await load(selected.path, selected.mode, true); })} />}
      {git?.available && <button className="review-text-button" disabled={!!busy || hasUnsavedFiles} onClick={() => run('preview', async () => setPreview(await window.workbench.gitCommitPreview(workspace.id)))}>{t('files.commitPreview')}</button>}
    </div>}
    {!closingTab && !preview && !treeAction && noticeFeedback}
    {diskNotice && <OperationFeedback className="pane-note error-text" data-file-disk-status={diskStatus}>{renderDisplayText('', { key: diskNotice })}</OperationFeedback>}
    {busy && <OperationFeedback className="review-busy" state="progress">{t('files.processing')}</OperationFeedback>}
    <WorkspaceFileTree key={workspaceKey} workspaceId={workspace.id}
      workspaceKey={workspaceKey} entries={tree?.entries ?? emptyEntries} revision={tree?.revision ?? 0}
      hidden={view !== 'files' || missingDirectory} selectedPath={selected?.path}
      change={treeChange} actionsDisabled={!visible || operationBusy || !tree} onOpen={openFile} onAction={beginTreeAction} />
    {view === 'pr' && <section className="pr-review-body">
      {!review ? <p className="pane-note">{t('files.readPullRequest')}</p> : review.status !== 'ready' ? <p className="pane-note">{review.error}</p> : <>
        <div className="pr-review-summary"><span className="pr-review-icon"><GitPullRequest size={18} /></span>
          <a href={review.url} target="_blank" rel="noreferrer">#{review.number} {review.title}</a>
          <p>{t(`files.prState.${review.state}`, { defaultValue: review.state })} · {review.reviewDecision ? t(`files.reviewDecision.${review.reviewDecision}`, { defaultValue: review.reviewDecision }) : t('files.noReviewDecision')}</p>
          <code>HEAD {review.headSha?.slice(0, 12)}</code>
          <small>{review.checkedAt ? t('files.checkedAt', { date: formatDate(review.checkedAt) }) : ''}</small>
        </div>
        <div className="review-checks">{review.checks?.length ? review.checks.map((check, index) => <div key={index}>
          {check.url ? <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : <span>{check.name}</span>}
          <code>{check.status}{check.conclusion ? ` · ${check.conclusion}` : ''}</code>
        </div>) : <p>{t('files.noChecks')}</p>}</div>
        <p className="pane-note">{t('files.prReadOnly')}</p>
      </>}
    </section>}
    {view === 'changes' && changes.length > 0 && <div className="review-batch-actions">
      <label><input type="checkbox" checked={allChecked} disabled={!!busy || hasUnsavedFiles}
        ref={element => { if (element) element.indeterminate = checked.length > 0 && !allChecked; }}
        onChange={event => setCheckedChanges(new Set(event.target.checked ? changes.map(change => change.path) : []))} />{t('files.selectAllChanges')}</label>
      <button className="review-text-button" disabled={!!busy || hasUnsavedFiles || !stageable.length}
        onClick={() => mutate({ action: 'stage', paths: stageable })}>{t('files.stageSelected', { count: stageable.length })}</button>
      <button className="review-text-button" disabled={!!busy || hasUnsavedFiles || !unstageable.length}
        onClick={() => mutate({ action: 'unstage', paths: unstageable })}>{t('files.unstageSelected', { count: unstageable.length })}</button>
    </div>}
    <div className="review-layout" ref={reviewLayout} data-responsive-diff={responsiveDiff || undefined}>
    {view === 'changes' && <div className="file-tree review-tree">
      {!git?.available ? <div className="pane-note">{git?.error || t('files.notGit')}</div> : !git.changes.length ? <div className="pane-note">{t('files.clean')}</div> : git.changes.map((change, index) => <div className="review-change-row" key={change.path}
        data-after-selected={selectedChangeIndex >= 0 && index > selectedChangeIndex || undefined}>
        <div className="review-change-selection">
          <input type="checkbox" aria-label={t('files.selectChange', { path: change.path })} checked={checkedChanges.has(change.path)} disabled={!!busy || hasUnsavedFiles}
            onChange={event => {
              const include = event.target.checked;
              setCheckedChanges(current => {
                const next = new Set(current);
                if (include) next.add(change.path); else next.delete(change.path);
                return next;
              });
            }} />
          <button className={`tree-row ${selected?.path === change.path ? 'selected' : ''}`} onClick={() => run('open', () => load(change.path, 'diff'))} title={change.path}>
            <GitCompareArrows size={13} /><span className="tree-name">{change.path}</span><code>{change.status}</code>
          </button>
        </div><div className="review-row-actions">
          {change.status[1] !== ' ' && <button disabled={!!busy || hasUnsavedFiles} onClick={() => mutate({ action: 'stage', path: change.path })}>{t('files.stage')}</button>}
          {change.staged && <button disabled={!!busy || hasUnsavedFiles} onClick={() => mutate({ action: 'unstage', path: change.path })}>{t('files.unstage')}</button>}
        </div>
      </div>)}
    </div>}
    {selected && <section className="file-inspector review-inspector" hidden={view === 'pr'}>
      {diff && <div className="inspector-title"><FileCode2 size={14} /><span title={selected.path}>{selected.path}</span>
        <IconButton label={expanded ? t('files.restorePanel') : t('files.expandPanel')} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</IconButton>
        <IconButton label={t('files.close')} onClick={closeDiff}><X size={13} /></IconButton>
      </div>}
      {tabs.open.length > 0 && <div className="inspector-title file-editor-tabs-header">
        <FileEditorTabs tabs={tabItems} activePath={contentTab?.path} focusPath={tabs.active} id={tabId} activeButton={activeTabButton}
          onActivate={openFile} onClose={requestCloseFile} />
        {!diff && <IconButton label={expanded ? t('files.restorePanel') : t('files.expandPanel')} onClick={() => setExpanded(value => !value)}>
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </IconButton>}
      </div>}
      <div className="inspector-tabs">
        {!image && <button className={selected.mode === 'content' && !markdownPreview ? 'active' : ''}
          onClick={() => markdown ? setMarkdownPreview(false) : openFile(selected.path)}>
          {t(markdown ? 'files.source' : rasterImageMimeFromPath(selected.path) ? 'files.preview' : 'files.edit')}
        </button>}
        {markdown && <button className={markdownPreview ? 'active' : ''} onClick={() => setMarkdownPreview(true)}>{t('files.preview')}</button>}
        <button className={selected.mode === 'diff' ? 'active' : ''} disabled={!!busy} onClick={() => run('open', () => load(selected.path, 'diff'))}>Diff</button>
        {file && <button className="review-save" disabled={!dirty || !!busy} onClick={() => save(file.path)}><Save size={12} />{t('common.save')}</button>}
        <button disabled={!!busy} onClick={() => run('reload', () => load(selected.path, selected.mode, true))}>{dirty ? t('files.reloadDiscard') : t('files.reload')}</button>
        {file && !markdownPreview && <>
          <IconButton label={t('editor.find')} onClick={() => editor.current?.find()}><Search size={13} /></IconButton>
          <IconButton label={t('editor.wrapLines')} aria-pressed={editorPreferences.wrapLines} onClick={() => toggleEditorPreference('wrapLines')}><WrapText size={13} /></IconButton>
          <IconButton label={t('editor.autoSave')} aria-pressed={editorPreferences.autoSave} onClick={() => toggleEditorPreference('autoSave')}><Timer size={13} /></IconButton>
        </>}
      </div>
      {contentTab && <div className="review-editor" id={`${tabId}-panel`} role="tabpanel"
        aria-labelledby={`${tabId}-${tabs.open.indexOf(contentTab)}`} onKeyDown={event => {
        if (!file) return;
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey
          || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
        event.preventDefault();
        if (dirty && !busy && !event.repeat) save(file.path);
      }}>
        {contentTab.kind === 'image' ? <ImageFilePreview key={JSON.stringify([contentTab.path, contentTab.image.revision])} image={contentTab.image} />
          : markdownPreview ? <MarkdownFilePreview text={draft} />
          : file && <CodeEditor ref={editor} key={`${workspace.id}:${file.path}`} value={draft} onChange={text => {
            fileDrafts.edit(workspace.id, file.path, text);
          }} language={file.language} readOnly={operationBusy} wrapLines={editorPreferences.wrapLines} location={currentLocation} position={contentTab.position} />}
      </div>}
      {diff && <>
        <DiffReview key={JSON.stringify([selected.path, diff.revision])} diff={diff} location={currentLocation} busy={busy} draft={noteDrafts.get(selected.path)}
          onDraftChange={draft => updateNoteDraft(selected.path, () => draft)} onSave={addNote} />
        {diff.patch && diff.revision && !diff.truncated && git?.changes.some(change => change.path === selected.path && change.status[1] !== ' ' && change.status[1] !== '?') && <div className="review-discard">
          {discard === selected.path ? <><span>{t('files.discardQuestion')}</span><button className="danger" disabled={!!busy || hasUnsavedFiles} onClick={() => mutate({ action: 'discard', path: selected.path, revision: diff.revision })}>{t('files.confirmDiscard')}</button><button onClick={() => setDiscard(null)}>{t('common.cancel')}</button></> : <button disabled={hasUnsavedFiles} onClick={() => setDiscard(selected.path)}>{t('files.discard')}</button>}
        </div>}
      </>}
    </section>}
    </div>
    {treeAction && <Modal title={t(treeAction.action === 'create' ? (treeAction.kind === 'file' ? 'files.newFile' : 'files.newFolder')
      : treeAction.action === 'rename' ? 'files.renameItem' : treeAction.entry.kind === 'file' ? 'files.deleteFile' : 'files.deleteFolder')}
      subtitle={treeAction.action === 'create' ? treeAction.directory?.path ?? workspace.name : treeAction.entry.path}
      className="workspace-tree-action-dialog" busy={operationBusy} onClose={cancelTreeAction}>
      <form onSubmit={event => { event.preventDefault(); submitTreeAction(); }}>
        {treeAction.action === 'delete'
          ? <p>{t(treeAction.entry.kind === 'directory' ? 'files.deleteFolderPrompt' : 'files.deleteFilePrompt')}</p>
          : <label className="workspace-tree-action-name">{t('files.itemName')}
            <input autoFocus required maxLength={255} value={treeName} readOnly={operationBusy} onChange={event => setTreeName(event.target.value)} />
          </label>}
        {operationNotice && noticeFeedback}
        <div className="modal-actions">
          <button className="button" type="button" autoFocus={treeAction.action === 'delete'} disabled={operationBusy} onClick={cancelTreeAction}>{t('common.cancel')}</button>
          <button className={`button ${treeAction.action === 'delete' ? 'danger' : 'primary'}`} type="submit"
            disabled={operationBusy || (treeAction.action !== 'delete' && (!treeName.trim() || (treeAction.action === 'rename' && treeName === treeAction.entry.name)))}>
            {t(treeAction.action === 'delete' ? 'files.deleteItem' : treeAction.action === 'rename' ? 'files.renameItem' : 'files.createItem')}
          </button>
        </div>
      </form>
    </Modal>}
    {closingTab && <Modal title={t('files.unsavedTitle')} subtitle={closingTab.path} busy={closingBusy}
      fallbackFocus={activeTabButton} onClose={() => { setOperationNotice(undefined); setClosingTab(undefined); }}>
      {!preview && noticeFeedback}
      <div className="modal-actions">
        <button className="button" autoFocus disabled={closingBusy} onClick={() => { setOperationNotice(undefined); setClosingTab(undefined); }}>{t('common.cancel')}</button>
        <button className="button danger" disabled={closingBusy} onClick={() => {
          const current = fileDrafts.get(workspace.id, closingTab.path);
          if (isDirty(current) && (current?.editVersion !== closingTab.draft.editVersion || current?.original !== closingTab.draft.original)) {
            setOperationNotice({ message: { key: 'workspace:files.closeChanged' } });
            return;
          }
          closeFile(closingTab.path, current);
        }}>{t('files.discardAndClose')}</button>
        <button className="button primary" disabled={closingBusy} onClick={() => save(closingTab.path, true)}>{t('files.saveAndClose')}</button>
      </div>
    </Modal>}
    {!!currentNotes.length && <section className="review-notes"><strong><MessageSquare size={12} />{t('files.localNotes', { count: currentNotes.length })}</strong>
      {currentNotes.map(note => <div key={note.id}><small>{note.filePath}:{note.startLine !== undefined && note.startLine !== note.lineNumber ? `${note.startLine}–` : ''}{note.lineNumber} · {t(`files.scope.${note.scope}`)} · {t(`files.side.${note.side}`)}</small><p>{note.body}</p><button onClick={() => setNotes({ workspaceId: workspace.id, items: currentNotes.filter(item => item.id !== note.id) })}>{t('common.delete')}</button></div>)}
      <button disabled={!onFeedback || !sessions.length || !!busy} onClick={sendNotes}>{t('files.notesToDraft')}</button>
    </section>}
    {preview && <Modal title={t('files.commitTitle')} subtitle={t('files.commitDescription')} busy={busy} onClose={() => setPreview(null)}><div className="review-commit-content">
      {noticeFeedback}
      <ul>{preview.paths.map(filePath => <li key={filePath}>{filePath}</li>)}</ul><pre>{preview.patch || t('files.noStagedChanges')}</pre>
      <textarea aria-label={t('files.commitMessage')} placeholder={t('files.commitMessage')} value={commitMessage} onChange={event => setCommitMessage(event.target.value)} />
      <div className="review-commit-actions"><p className="pane-note">{t('files.localCommitOnly')}</p><button className="button primary" disabled={!preview.paths.length || preview.truncated || !commitMessage.trim() || !!busy} onClick={() => run('commit', async () => {
        const sha = await window.workbench.gitCommit(workspace.id, { message: commitMessage, revision: preview.revision });
        setPreview(null); setCommitMessage(''); await refresh();
        setOperationNotice({ message: { key: 'workspace:files.commitComplete', values: { sha: sha.slice(0, 12) } }, state: 'status' });
      })}>{t('files.confirmCommit')}</button></div>
    </div></Modal>}
  </aside>;
}
