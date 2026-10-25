import { useTranslation } from 'react-i18next';
import { formatDate, renderDisplayText } from '../shared/i18n';
import type { DisplayText } from '../shared/display-text';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, FileCode2, Files, Folder, GitBranch, GitCompareArrows, GitPullRequest, LoaderCircle, Maximize2, MessageSquare, Minimize2, PanelRight, RefreshCw, Save, X } from 'lucide-react';
import { z } from 'zod';
import type { FileContent, FileDiff, FileEntry, GitCommitPreview, GitMutation, GitState, PullRequestReview, Session, Workspace } from '../shared/types';
import { CodeEditor } from './CodeEditor';
import { FileDraftStore } from './file-drafts';
import { diffLines, reviewFeedback, reviewNoteSchema, type DiffLine, type ReviewNote } from './review-notes';
import { IconButton, Modal, type Perform } from './ui';
import './FileReviewPanel.css';

const notesSchema = z.array(reviewNoteSchema).max(200);
type FileNotice = string | DisplayText;
const fileDrafts = new FileDraftStore(summary => window.workbench.setUnsavedFiles(summary));
function persistedNotes(workspaceId: string): ReviewNote[] {
  try { return notesSchema.parse(JSON.parse(localStorage.getItem(`workbench:review:${workspaceId}`) ?? '[]')); }
  catch { return []; }
}

export function FileReviewPanel({ workspace, refreshKey, perform, sessions = [], onFeedback }: {
  workspace: Workspace; refreshKey: string; perform: Perform; sessions?: Session[]; onFeedback?(text: string): void;
}) {
  const { t } = useTranslation('workspace');
  const [view, setView] = useState<'files' | 'changes' | 'pr'>('files');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [git, setGit] = useState<GitState | null>(null);
  const [selected, setSelected] = useState<{ path: string; mode: 'content' | 'diff' } | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  useSyncExternalStore(fileDrafts.subscribe, fileDrafts.getSnapshot);
  const buffer = loadedPath === null ? undefined : fileDrafts.get(workspace.id, loadedPath);
  const file = buffer?.original ?? null;
  const draft = buffer?.text ?? '';
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<FileNotice>('');
  const [operationBusy, setBusy] = useState(false);
  const busy = operationBusy || (loadedPath !== null && fileDrafts.isSaving(workspace.id, loadedPath));
  const [preview, setPreview] = useState<GitCommitPreview | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [discard, setDiscard] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [review, setReview] = useState<PullRequestReview | null>(null);
  const [noteLine, setNoteLine] = useState<DiffLine | null>(null);
  const [noteBody, setNoteBody] = useState('');
  const [notes, setNotes] = useState({ workspaceId: workspace.id, items: persistedNotes(workspace.id) });
  const directoryGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const operations = useRef(0);
  const dirty = !!file && draft !== file.content;
  const currentNotes = notes.workspaceId === workspace.id ? notes.items : [];

  const run = (key: string, action: () => Promise<unknown>) => {
    setError(''); operations.current++; setBusy(true);
    void perform(`review-${workspace.id}-${key}`, async () => {
      try { return await action(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); throw failure; }
      finally { operations.current--; if (!operations.current) setBusy(false); }
    });
  };
  const refresh = async (nextDirectory = directory) => {
    const token = ++directoryGeneration.current;
    const [listing, status] = await Promise.all([window.workbench.listFiles(workspace.id, nextDirectory), window.workbench.gitState(workspace.id)]);
    if (token !== directoryGeneration.current) return;
    setEntries(listing); setGit(status); setDirectory(nextDirectory);
  };
  const refreshPullRequest = async () => {
    setReview(await window.workbench.reviewPullRequest(workspace.id));
  };
  const load = async (filePath: string, mode: 'content' | 'diff', force = false) => {
    if (dirty && !force) throw new Error(t('files.saveBeforeOpen'));
    const token = ++fileGeneration.current;
    if (mode === 'content') {
      const cached = fileDrafts.get(workspace.id, filePath);
      let contents: FileContent;
      try {
        const read = await window.workbench.readFile(workspace.id, filePath);
        if (read === null) {
          if (token !== fileGeneration.current) return;
          if (!force) throw new Error(t('files.missing'));
          if (cached && !fileDrafts.discard(workspace.id, filePath, cached)) throw new Error(t('files.changedDraft'));
          setSelected(null); setLoadedPath(null); setDiff(null); setExpanded(false);
          return;
        }
        contents = read;
      }
      catch (failure) {
        const retained = fileDrafts.get(workspace.id, filePath);
        if (force || !retained || (retained.text === retained.original.content && !fileDrafts.isSaving(workspace.id, filePath))) throw failure;
        contents = retained.original;
        setError({ key: 'workspace:files.unreadableDraft' });
      }
      if (token !== fileGeneration.current) return;
      const current = fileDrafts.open(workspace, contents, cached, force);
      setLoadedPath(filePath); setDiff(null);
      if (current === cached && current.original.revision !== contents.revision) setError({ key: 'workspace:files.changedDraft' });
    } else {
      const patch = await window.workbench.fileDiff(workspace.id, filePath);
      if (token !== fileGeneration.current) return;
      setDiff(patch);
      if (file?.path !== filePath) setLoadedPath(null);
    }
    setSelected({ path: filePath, mode }); setNoteLine(null); setNoteBody(''); setDiscard(null);
  };

  useEffect(() => {
    setDirectory(''); setEntries([]); setGit(null); setSelected(null); setLoadedPath(null); setDiff(null);
    setPreview(null); setReview(null); setNotes({ workspaceId: workspace.id, items: persistedNotes(workspace.id) });
    return () => { directoryGeneration.current++; fileGeneration.current++; };
  }, [workspace.id]);
  useEffect(() => { run('refresh', () => refresh()); }, [workspace.id, refreshKey]);
  useEffect(() => {
    if (notes.workspaceId !== workspace.id) return;
    try { localStorage.setItem(`workbench:review:${workspace.id}`, JSON.stringify(notes.items)); }
    catch { setError({ key: 'workspace:files.notesSaveFailed' }); }
  }, [notes, workspace.id]);
  const save = () => file && run('save', async () => {
    await fileDrafts.save(workspace.id, file.path, input => window.workbench.writeFile(workspace.id, input));
    await refresh();
  });
  const mutate = (action: GitMutation['action'], filePath: string, revision?: string) => run(action, async () => {
    const updated = await window.workbench.gitMutate(workspace.id, { action, path: filePath, revision });
    setGit(updated); setDiscard(null); setPreview(null);
    if (selected?.path === filePath) await load(filePath, 'diff');
  });
  const addNote = () => {
    if (!selected || !diff?.revision || !noteLine || !noteBody.trim()) return;
    if (currentNotes.length >= 200) { setError({ key: 'workspace:files.notesLimit' }); return; }
    const lineNumber = noteLine.kind === 'removed' ? noteLine.oldLine : noteLine.newLine;
    if (!lineNumber) return;
    const note: ReviewNote = { id: crypto.randomUUID(), filePath: selected.path, lineNumber, body: noteBody.trim(),
      side: noteLine.kind === 'removed' ? 'original' : 'modified', scope: noteLine.scope,
      revision: diff.revision, createdAt: new Date().toISOString() };
    setNotes({ workspaceId: workspace.id, items: [...currentNotes, note] }); setNoteLine(null); setNoteBody('');
  };
  const sendNotes = () => run('feedback', async () => {
    for (const filePath of new Set(currentNotes.map(note => note.filePath))) {
      const current = await window.workbench.fileDiff(workspace.id, filePath);
      if (current.truncated || currentNotes.some(note => note.filePath === filePath && note.revision !== current.revision)) {
        throw new Error(t('files.notesOutdated', { path: filePath }));
      }
    }
    onFeedback?.(reviewFeedback(currentNotes));
  });

  return <aside className={`file-panel file-review-panel ${expanded ? 'review-expanded' : ''}`} aria-label={t('files.title')}>
    <header className="file-panel-header">
      <span className="file-panel-title"><PanelRight size={15} />{t('files.title')}</span>
      <IconButton label={t('files.refresh')} disabled={!!busy} onClick={() => run('refresh', () => view === 'pr' ? refreshPullRequest() : refresh())}><RefreshCw size={14} /></IconButton>
    </header>
    <div className="file-view-tabs" data-view={view} role="group" aria-label={t('files.views')}>
      <button className={view === 'files' ? 'active' : ''} aria-pressed={view === 'files'} onClick={() => setView('files')}><Files size={13} />{t('files.files')}</button>
      <button className={view === 'changes' ? 'active' : ''} aria-pressed={view === 'changes'} onClick={() => setView('changes')}><GitCompareArrows size={13} />{t('files.changes')}{git?.available && <span>{git.changes.length}</span>}</button>
      <button className={view === 'pr' ? 'active' : ''} aria-pressed={view === 'pr'} onClick={() => { setView('pr'); run('pr', refreshPullRequest); }}><GitPullRequest size={13} />PR / CI</button>
    </div>
    <div className="file-branch"><GitBranch size={13} /><span>{git?.available ? git.branch : t('files.notGitLabel')}</span>
      {git?.available && <button className="review-text-button" disabled={!!busy || dirty} onClick={() => run('preview', async () => setPreview(await window.workbench.gitCommitPreview(workspace.id)))}>{t('files.commitPreview')}</button>}
    </div>
    {error && <div className="pane-note error-text" role="alert">{typeof error === 'string' ? error : renderDisplayText('', error)}</div>}
    {busy && <div className="review-busy" role="status"><LoaderCircle className="spin" size={12} />{t('files.processing')}</div>}
    {view === 'pr' ? <section className="pr-review-body">
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
    </section> : <div className="file-tree review-tree">
      {view === 'files' ? <>
        {directory && <button className="tree-row" onClick={() => run('directory', () => refresh(directory.split('/').slice(0, -1).join('/')))}><ChevronLeft size={14} />{directory}</button>}
        {entries.map(entry => <button key={entry.path} className={`tree-row ${entry.kind} ${selected?.path === entry.path ? 'selected' : ''}`} title={entry.path}
          onClick={() => run('open', () => entry.kind === 'directory' ? refresh(entry.path) : load(entry.path, 'content'))}>
          {entry.kind === 'directory' ? <Folder size={14} /> : <FileCode2 size={14} />}<span className="tree-name">{entry.name}</span>
        </button>)}{!entries.length && <div className="pane-note">{t('files.emptyDirectory')}</div>}
      </> : !git?.available ? <div className="pane-note">{git?.error || t('files.notGit')}</div> : !git.changes.length ? <div className="pane-note">{t('files.clean')}</div> : git.changes.map(change => <div className="review-change-row" key={change.path}>
        <button className={`tree-row ${selected?.path === change.path ? 'selected' : ''}`} onClick={() => run('open', () => load(change.path, 'diff'))} title={change.path}>
          <GitCompareArrows size={13} /><span className="tree-name">{change.path}</span><code>{change.status}</code>
        </button><div className="review-row-actions">
          {change.status[1] !== ' ' && <button disabled={!!busy || dirty} onClick={() => mutate('stage', change.path)}>{t('files.stage')}</button>}
          {change.staged && <button disabled={!!busy || dirty} onClick={() => mutate('unstage', change.path)}>{t('files.unstage')}</button>}
        </div>
      </div>)}
    </div>}
    {selected && <section className="file-inspector review-inspector" hidden={view === 'pr'}>
      <div className="inspector-title"><FileCode2 size={14} /><span title={selected.path}>{selected.path}</span>{dirty && <span className="review-unsaved" title={t('files.unsavedTitle')}>{t('files.unsaved')}</span>}
        <IconButton label={expanded ? t('files.restorePanel') : t('files.expandPanel')} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</IconButton>
        <IconButton label={t('files.close')} disabled={dirty || !!busy} onClick={() => { fileGeneration.current++; setSelected(null); setLoadedPath(null); setDiff(null); setExpanded(false); }}><X size={13} /></IconButton>
      </div>
      <div className="inspector-tabs">
        <button className={selected.mode === 'content' ? 'active' : ''} disabled={!!busy || dirty} onClick={() => run('open', () => load(selected.path, 'content'))}>{t('files.edit')}</button>
        <button className={selected.mode === 'diff' ? 'active' : ''} disabled={!!busy || dirty} onClick={() => run('open', () => load(selected.path, 'diff'))}>Diff</button>
        {file && selected.mode === 'content' && <button className="review-save" disabled={!dirty || !!busy} onClick={save}><Save size={12} />{t('common.save')}</button>}
        <button disabled={!!busy} onClick={() => run('reload', () => load(selected.path, selected.mode, true))}>{dirty ? t('files.reloadDiscard') : t('files.reload')}</button>
      </div>
      {file && <div className="review-editor" hidden={selected.mode !== 'content'} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (dirty && !busy) save(); } }}>
        <CodeEditor key={`${workspace.id}:${file.path}`} value={draft} onChange={text => {
          fileDrafts.edit(workspace.id, file.path, text);
        }} language={file.language} readOnly={!!busy} />
      </div>}
      {diff && <>
        {diff.binary ? <div className="pane-note">{t('files.binaryDiff')}</div> : <div className="review-diff" aria-label={t('files.annotatedDiff')}>
          {diffLines(diff.patch).map((line, index) => <div key={index} className={`review-diff-line ${line.kind}`}>
            <button aria-label={line.kind === 'header' ? t('files.diffHeader', { scope: t(`files.scope.${line.scope}`) }) : t('files.annotateLine', { scope: t(`files.scope.${line.scope}`), side: t(line.kind === 'removed' ? 'files.side.original' : 'files.side.modified'), line: line.kind === 'removed' ? line.oldLine : line.newLine })}
              disabled={(!line.oldLine && !line.newLine) || !diff.revision || diff.truncated}
              onClick={() => { setNoteLine(line); setNoteBody(''); }}><span>{line.oldLine}</span><span>{line.newLine}</span></button>
            <code>{line.text || ' '}</code>
          </div>)}
        </div>}
        {diff.truncated && <p className="pane-note">{t('files.truncatedDiff')}</p>}
        {diff.patch && diff.revision && !diff.truncated && git?.changes.some(change => change.path === selected.path && change.status[1] !== ' ' && change.status[1] !== '?') && <div className="review-discard">
          {discard === selected.path ? <><span>{t('files.discardQuestion')}</span><button className="danger" disabled={!!busy} onClick={() => mutate('discard', selected.path, diff.revision)}>{t('files.confirmDiscard')}</button><button onClick={() => setDiscard(null)}>{t('common.cancel')}</button></> : <button onClick={() => setDiscard(selected.path)}>{t('files.discard')}</button>}
        </div>}
        {noteLine && <div className="review-note-editor"><label>{t(`files.scope.${noteLine.scope}`)} · {noteLine.kind === 'removed' ? t('files.originalLine', { line: noteLine.oldLine }) : t('files.modifiedLine', { line: noteLine.newLine })}
          <textarea aria-label={t('files.lineNote')} value={noteBody} onChange={event => setNoteBody(event.target.value)} maxLength={10_000} /></label>
          <button disabled={!noteBody.trim()} onClick={addNote}>{t('files.saveNote')}</button><button onClick={() => setNoteLine(null)}>{t('common.cancel')}</button>
        </div>}
      </>}
    </section>}
    {!!currentNotes.length && <section className="review-notes"><strong><MessageSquare size={12} />{t('files.localNotes', { count: currentNotes.length })}</strong>
      {currentNotes.map(note => <div key={note.id}><small>{note.filePath}:{note.lineNumber} · {t(`files.scope.${note.scope}`)} · {t(`files.side.${note.side}`)}</small><p>{note.body}</p><button onClick={() => setNotes({ workspaceId: workspace.id, items: currentNotes.filter(item => item.id !== note.id) })}>{t('common.delete')}</button></div>)}
      <button disabled={!onFeedback || !sessions.length || !!busy} onClick={sendNotes}>{t('files.notesToDraft')}</button>
    </section>}
    {preview && <Modal title={t('files.commitTitle')} subtitle={t('files.commitDescription')} busy={busy} onClose={() => setPreview(null)}><div className="review-commit-content">
      <ul>{preview.paths.map(filePath => <li key={filePath}>{filePath}</li>)}</ul><pre>{preview.patch || t('files.noStagedChanges')}</pre>
      <textarea aria-label={t('files.commitMessage')} placeholder={t('files.commitMessage')} value={commitMessage} onChange={event => setCommitMessage(event.target.value)} />
      <div className="review-commit-actions"><p className="pane-note">{t('files.localCommitOnly')}</p><button className="button primary" disabled={!preview.paths.length || preview.truncated || !commitMessage.trim() || !!busy} onClick={() => run('commit', async () => {
        const sha = await window.workbench.gitCommit(workspace.id, { message: commitMessage, revision: preview.revision });
        setPreview(null); setCommitMessage(''); await refresh(); setError({ key: 'workspace:files.commitComplete', values: { sha: sha.slice(0, 12) } });
      })}>{t('files.confirmCommit')}</button></div>
    </div></Modal>}
  </aside>;
}
