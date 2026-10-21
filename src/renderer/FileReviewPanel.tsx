import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, FileCode2, Files, Folder, GitBranch, GitCompareArrows, GitPullRequest, LoaderCircle, Maximize2, MessageSquare, Minimize2, PanelRight, RefreshCw, Save, X } from 'lucide-react';
import { z } from 'zod';
import type { FileContent, FileDiff, FileEntry, GitCommitPreview, GitMutation, GitState, PullRequestReview, Session, Workspace } from '../shared/types';
import { CodeEditor } from './CodeEditor';
import { diffLines, reviewFeedback, reviewNoteSchema, type DiffLine, type ReviewNote } from './review-notes';
import { IconButton, Modal, type Perform } from './ui';
import './FileReviewPanel.css';

const notesSchema = z.array(reviewNoteSchema).max(200);
const fileDrafts = new Map<string, { original: FileContent; text: string }>();
function persistedNotes(workspaceId: string): ReviewNote[] {
  try { return notesSchema.parse(JSON.parse(localStorage.getItem(`workbench:review:${workspaceId}`) ?? '[]')); }
  catch { return []; }
}

export function FileReviewPanel({ workspace, refreshKey, perform, sessions = [], onFeedback }: {
  workspace: Workspace; refreshKey: string; perform: Perform; sessions?: Session[]; onFeedback?(text: string): void;
}) {
  const [view, setView] = useState<'files' | 'changes' | 'pr'>('files');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [git, setGit] = useState<GitState | null>(null);
  const [selected, setSelected] = useState<{ path: string; mode: 'content' | 'diff' } | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState('');
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  const load = async (filePath: string, mode: 'content' | 'diff', force = false) => {
    if (dirty && !force) throw new Error('请先保存当前草稿，或点“重新载入”放弃草稿。');
    const token = ++fileGeneration.current;
    if (mode === 'content') {
      const draftKey = `${workspace.id}:${filePath}`;
      if (force) fileDrafts.delete(draftKey);
      const cached = fileDrafts.get(draftKey);
      let contents: FileContent;
      try { contents = await window.workbench.readFile(workspace.id, filePath); }
      catch (failure) {
        if (!cached) throw failure;
        contents = cached.original;
        setError('磁盘文件暂时无法读取；仍保留窗口中的草稿。请复制草稿后再重新载入。');
      }
      if (token !== fileGeneration.current) return;
      setFile(cached?.original ?? contents); setDraft(cached?.text ?? contents.content); setDiff(null);
      if (cached && cached.original.revision !== contents.revision) setError('磁盘文件已变化；保留原草稿，保存会拒绝旧版本。请先复制草稿再重新载入。');
    } else {
      const patch = await window.workbench.fileDiff(workspace.id, filePath);
      if (token !== fileGeneration.current) return;
      setDiff(patch);
      if (file?.path !== filePath) { setFile(null); setDraft(''); }
    }
    setSelected({ path: filePath, mode }); setNoteLine(null); setNoteBody(''); setDiscard(null);
  };

  useEffect(() => {
    setDirectory(''); setEntries([]); setGit(null); setSelected(null); setFile(null); setDraft(''); setDiff(null);
    setPreview(null); setReview(null); setNotes({ workspaceId: workspace.id, items: persistedNotes(workspace.id) });
    return () => { directoryGeneration.current++; fileGeneration.current++; };
  }, [workspace.id]);
  useEffect(() => { run('refresh', () => refresh()); }, [workspace.id, refreshKey]);
  useEffect(() => {
    if (notes.workspaceId !== workspace.id) return;
    try { localStorage.setItem(`workbench:review:${workspace.id}`, JSON.stringify(notes.items)); }
    catch { setError('批注暂时保留在窗口中，未能保存到本机存储。'); }
  }, [notes, workspace.id]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const save = () => file && run('save', async () => {
    const written = await window.workbench.writeFile(workspace.id, { path: file.path, content: draft, revision: file.revision });
    fileDrafts.delete(`${workspace.id}:${file.path}`);
    setFile(written); setDraft(written.content); await refresh();
  });
  const mutate = (action: GitMutation['action'], filePath: string, revision?: string) => run(action, async () => {
    const updated = await window.workbench.gitMutate(workspace.id, { action, path: filePath, revision });
    setGit(updated); setDiscard(null); setPreview(null);
    if (selected?.path === filePath) await load(filePath, 'diff');
  });
  const addNote = () => {
    if (!selected || !diff?.revision || !noteLine || !noteBody.trim()) return;
    if (currentNotes.length >= 200) { setError('最多保留200条本地批注，请先删除已处理的批注。'); return; }
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
        throw new Error(`${filePath} 已变化，请删除过期批注并重新选择行。`);
      }
    }
    onFeedback?.(reviewFeedback(currentNotes));
  });

  return <aside className={`file-panel file-review-panel ${expanded ? 'review-expanded' : ''}`} aria-label="文件与改动">
    <header className="file-panel-header">
      <span className="file-panel-title"><PanelRight size={15} />文件与改动</span>
      <IconButton label="刷新文件与改动" disabled={!!busy} onClick={() => run('refresh', () => refresh())}><RefreshCw size={14} /></IconButton>
    </header>
    <div className="file-view-tabs" data-view={view} role="group" aria-label="成果视图">
      <button className={view === 'files' ? 'active' : ''} aria-pressed={view === 'files'} onClick={() => setView('files')}><Files size={13} />文件</button>
      <button className={view === 'changes' ? 'active' : ''} aria-pressed={view === 'changes'} onClick={() => setView('changes')}><GitCompareArrows size={13} />改动 {git?.available && <span>{git.changes.length}</span>}</button>
      <button className={view === 'pr' ? 'active' : ''} aria-pressed={view === 'pr'} onClick={() => { setView('pr'); run('pr', async () => setReview(await window.workbench.reviewPullRequest(workspace.id))); }}><GitPullRequest size={13} />PR / CI</button>
    </div>
    <div className="file-branch"><GitBranch size={13} /><span>{git?.available ? git.branch : '非 Git 目录'}</span>
      {git?.available && <button className="review-text-button" disabled={!!busy || dirty} onClick={() => run('preview', async () => setPreview(await window.workbench.gitCommitPreview(workspace.id)))}>提交预览</button>}
    </div>
    {error && <div className="pane-note error-text" role="alert">{error}</div>}
    {busy && <div className="review-busy" role="status"><LoaderCircle className="spin" size={12} />处理中</div>}
    {view === 'pr' ? <section className="pr-review-body">
      {!review ? <p className="pane-note">读取当前分支关联的 PR。</p> : review.status !== 'ready' ? <p className="pane-note">{review.error}</p> : <>
        <div className="pr-review-summary"><span className="pr-review-icon"><GitPullRequest size={18} /></span>
          <a href={review.url} target="_blank" rel="noreferrer">#{review.number} {review.title}</a>
          <p>{review.state} · {review.reviewDecision || '暂无审查结论'}</p>
          <code>HEAD {review.headSha?.slice(0, 12)}</code>
          <small>{review.checkedAt ? `读取于 ${new Date(review.checkedAt).toLocaleString()}` : ''}</small>
        </div>
        <div className="review-checks">{review.checks?.length ? review.checks.map((check, index) => <div key={index}>
          {check.url ? <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : <span>{check.name}</span>}
          <code>{check.status}{check.conclusion ? ` · ${check.conclusion}` : ''}</code>
        </div>) : <p>当前提交没有检查记录。</p>}</div>
        <p className="pane-note">这里只读取 PR、审查结论和 CI。外部写入需先审阅固定稿件并通过 prepare / publish。</p>
      </>}
    </section> : <div className="file-tree review-tree">
      {view === 'files' ? <>
        {directory && <button className="tree-row" onClick={() => run('directory', () => refresh(directory.split('/').slice(0, -1).join('/')))}><ChevronLeft size={14} />{directory}</button>}
        {entries.map(entry => <button key={entry.path} className={`tree-row ${entry.kind} ${selected?.path === entry.path ? 'selected' : ''}`} title={entry.path}
          onClick={() => run('open', () => entry.kind === 'directory' ? refresh(entry.path) : load(entry.path, 'content'))}>
          {entry.kind === 'directory' ? <Folder size={14} /> : <FileCode2 size={14} />}<span className="tree-name">{entry.name}</span>
        </button>)}{!entries.length && <div className="pane-note">这个目录没有文件。</div>}
      </> : !git?.available ? <div className="pane-note">{git?.error || '当前目录不是 Git 仓库。'}</div> : !git.changes.length ? <div className="pane-note">工作区没有未提交的改动。</div> : git.changes.map(change => <div className="review-change-row" key={change.path}>
        <button className={`tree-row ${selected?.path === change.path ? 'selected' : ''}`} onClick={() => run('open', () => load(change.path, 'diff'))} title={change.path}>
          <GitCompareArrows size={13} /><span className="tree-name">{change.path}</span><code>{change.status}</code>
        </button><div className="review-row-actions">
          {change.status[1] !== ' ' && <button disabled={!!busy || dirty} onClick={() => mutate('stage', change.path)}>暂存</button>}
          {change.staged && <button disabled={!!busy || dirty} onClick={() => mutate('unstage', change.path)}>取消暂存</button>}
        </div>
      </div>)}
    </div>}
    {selected && <section className="file-inspector review-inspector" hidden={view === 'pr'}>
      <div className="inspector-title"><FileCode2 size={14} /><span title={selected.path}>{selected.path}</span>{dirty && <span className="review-unsaved" title="文件有未保存的草稿">未保存</span>}
        <IconButton label={expanded ? '还原编辑面板' : '展开编辑面板'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</IconButton>
        <IconButton label="关闭文件" disabled={dirty} onClick={() => { fileGeneration.current++; setSelected(null); setFile(null); setDiff(null); setExpanded(false); }}><X size={13} /></IconButton>
      </div>
      <div className="inspector-tabs">
        <button className={selected.mode === 'content' ? 'active' : ''} disabled={!!busy || dirty} onClick={() => run('open', () => load(selected.path, 'content'))}>编辑</button>
        <button className={selected.mode === 'diff' ? 'active' : ''} disabled={!!busy || dirty} onClick={() => run('open', () => load(selected.path, 'diff'))}>Diff</button>
        {file && selected.mode === 'content' && <button className="review-save" disabled={!dirty || !!busy} onClick={save}><Save size={12} />保存</button>}
        <button disabled={!!busy} onClick={() => run('reload', () => load(selected.path, selected.mode, true))}>{dirty ? '重新载入（放弃草稿）' : '重新载入'}</button>
      </div>
      {file && <div className="review-editor" hidden={selected.mode !== 'content'} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (dirty && !busy) save(); } }}>
        <CodeEditor key={`${workspace.id}:${file.path}`} value={draft} onChange={text => {
          setDraft(text);
          if (text === file.content) fileDrafts.delete(`${workspace.id}:${file.path}`);
          else fileDrafts.set(`${workspace.id}:${file.path}`, { original: file, text });
        }} language={file.language} readOnly={!!busy} />
      </div>}
      {diff && <>
        {diff.binary ? <div className="pane-note">二进制差异，仅显示 Git 状态。</div> : <div className="review-diff" aria-label="可批注的差异">
          {diffLines(diff.patch).map((line, index) => <div key={index} className={`review-diff-line ${line.kind}`}>
            <button aria-label={line.kind === 'header' ? `${line.scope} 差异说明，不可批注` : `批注 ${line.scope} ${line.kind === 'removed' ? '原侧' : '新侧'}第 ${line.kind === 'removed' ? line.oldLine : line.newLine} 行`}
              disabled={(!line.oldLine && !line.newLine) || !diff.revision || diff.truncated}
              onClick={() => { setNoteLine(line); setNoteBody(''); }}><span>{line.oldLine}</span><span>{line.newLine}</span></button>
            <code>{line.text || ' '}</code>
          </div>)}
        </div>}
        {diff.truncated && <p className="pane-note">差异过大，仅显示部分内容；不能据此丢弃或批注。</p>}
        {diff.patch && diff.revision && !diff.truncated && git?.changes.some(change => change.path === selected.path && change.status[1] !== ' ' && change.status[1] !== '?') && <div className="review-discard">
          {discard === selected.path ? <><span>丢弃上述工作副本改动，保留 index？</span><button className="danger" disabled={!!busy} onClick={() => mutate('discard', selected.path, diff.revision)}>确认丢弃工作副本</button><button onClick={() => setDiscard(null)}>取消</button></> : <button onClick={() => setDiscard(selected.path)}>丢弃工作副本改动…</button>}
        </div>}
        {noteLine && <div className="review-note-editor"><label>{noteLine.scope} · {noteLine.kind === 'removed' ? `原侧第 ${noteLine.oldLine} 行` : `新侧第 ${noteLine.newLine} 行`}
          <textarea aria-label="行批注" value={noteBody} onChange={event => setNoteBody(event.target.value)} maxLength={10_000} /></label>
          <button disabled={!noteBody.trim()} onClick={addNote}>保存批注</button><button onClick={() => setNoteLine(null)}>取消</button>
        </div>}
      </>}
    </section>}
    {!!currentNotes.length && <section className="review-notes"><strong><MessageSquare size={12} />本地批注 ({currentNotes.length})</strong>
      {currentNotes.map(note => <div key={note.id}><small>{note.filePath}:{note.lineNumber} · {note.scope} · {note.side}</small><p>{note.body}</p><button onClick={() => setNotes({ workspaceId: workspace.id, items: currentNotes.filter(item => item.id !== note.id) })}>删除</button></div>)}
      <button disabled={!onFeedback || !sessions.length || !!busy} onClick={sendNotes}>放入当前 Agent 草稿</button>
    </section>}
    {preview && <Modal title="提交整个仓库 index" subtitle="只提交以下已暂存内容。工作副本中的其他改动不会自动加入。" busy={busy} onClose={() => setPreview(null)}><div className="review-commit-content">
      <ul>{preview.paths.map(filePath => <li key={filePath}>{filePath}</li>)}</ul><pre>{preview.patch || '暂无暂存改动'}</pre>
      <textarea aria-label="提交说明" placeholder="提交说明" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} />
      <div className="review-commit-actions"><p className="pane-note">此操作只创建本地 commit。</p><button className="button primary" disabled={!preview.paths.length || preview.truncated || !commitMessage.trim() || !!busy} onClick={() => run('commit', async () => {
        const sha = await window.workbench.gitCommit(workspace.id, { message: commitMessage, revision: preview.revision });
        setPreview(null); setCommitMessage(''); await refresh(); setError(`本地提交完成：${sha.slice(0, 12)}`);
      })}>确认本地提交</button></div>
    </div></Modal>}
  </aside>;
}
