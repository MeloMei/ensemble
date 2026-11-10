import { Crosshair, Globe, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EVIDENCE_EXCERPT_LIMIT, localPreviewUrl, previewFrameName } from '../shared/draft-evidence';
import type { DraftEvidence, PreviewEvidenceSource, PromptInput, WorkspaceTab } from '../shared/types';
import './PreviewPane.css';

interface Point { x: number; y: number }
const center = { x: 0.5, y: 0.5 };

export function PreviewPane({ tab, onChooseEvidence, annotationJump, drafts, keyboardShortcut }: {
  tab: Extract<WorkspaceTab, { kind: 'preview' }>; onChooseEvidence?: (reference: DraftEvidence) => void;
  annotationJump?: { tabId: string; id: string; annotation?: PreviewEvidenceSource }; drafts: Record<string, PromptInput>;
  keyboardShortcut?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const { t: shell } = useTranslation('shell');
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [requestedUrl, setRequestedUrl] = useState(tab.url);
  const [stored, setStored] = useState<Record<string, DraftEvidence[]>>();
  const [picking, setPicking] = useState(false);
  const [point, setPoint] = useState(center);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pickOverlay = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const displayed = useRef<{ signature: string; jump?: typeof annotationJump }>(undefined);
  const revealed = useRef<typeof annotationJump>(undefined);
  const reloaded = useRef<typeof annotationJump>(undefined);
  const draftJump = useRef<typeof annotationJump>(undefined);
  const sources = useMemo(() => {
    const bySession = { ...stored };
    for (const [id, draft] of Object.entries(drafts)) bySession[id] = draft.evidence ?? [];
    const markers = new Map<string, PreviewEvidenceSource>();
    for (const evidence of Object.values(bySession).flat()) {
      const { source } = evidence;
      if (source.kind === 'preview' && source.tabId === tab.id) markers.set(source.annotationId, source);
    }
    return [...markers.values()].sort((left, right) => left.number - right.number);
  }, [drafts, stored, tab.id]);
  const url = localPreviewUrl(requestedUrl);
  const allowed = url && url.origin !== window.location.origin;

  useEffect(() => {
    let active = true;
    void window.workbench.previewDraftEvidence(tab.id).then(result => { if (active) setStored(result); }, failure => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { active = false; request.current++; };
  }, [tab.id]);
  useEffect(() => {
    if (!allowed || !loaded) return;
    const jump = annotationJump?.tabId === tab.id ? annotationJump : undefined;
    const fromDraft = jump && sources.find(item => item.annotationId === jump.id);
    if (fromDraft) draftJump.current = jump;
    const temporary = jump && draftJump.current !== jump ? jump.annotation : undefined;
    const target = fromDraft ?? temporary;
    const visible = temporary ? [...sources, temporary] : sources;
    const signature = JSON.stringify([loaded, requestedUrl, visible]);
    if (displayed.current?.signature === signature && displayed.current.jump === annotationJump) return;
    const paint = { signature, jump: annotationJump };
    displayed.current = paint;
    const revealId = revealed.current !== jump ? target?.annotationId : undefined;
    const annotations = visible.filter(item => item.annotationId !== revealId).slice(-255);
    if (revealId && target) annotations.push(target);
    void window.workbench.displayPreviewAnnotations(tab.id, annotations, revealId).then(result => {
      if (displayed.current !== paint || !revealId || !target) return;
      if (result === 'shown') { revealed.current = jump; setError(''); }
      else if (result === 'wrong-page' && reloaded.current !== jump) {
        reloaded.current = jump;
        displayed.current = undefined;
        setLoaded(0);
        setRequestedUrl(target.url);
        setRevision(value => value + 1);
      } else if (result !== 'unavailable') setError(t('evidence.annotationSourceMissing'));
    }).catch(failure => {
      if (displayed.current === paint) setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [allowed, annotationJump, loaded, requestedUrl, sources, t, tab.id]);
  useEffect(() => { if (picking) pickOverlay.current?.focus({ preventScroll: true }); }, [picking]);
  useEffect(() => {
    if (!keyboardShortcut || !onChooseEvidence) return;
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.isComposing || event.repeat
        || event.key.toLowerCase() !== 'i' || document.querySelector('dialog[open]') || toggle.current?.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      toggle.current?.click();
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [keyboardShortcut, onChooseEvidence]);

  const exit = () => {
    request.current++;
    setPicking(false);
    setBusy(false);
    toggle.current?.focus({ preventScroll: true });
  };
  const pick = async ({ x, y }: Point) => {
    if (busy || !onChooseEvidence) return;
    const id = ++request.current;
    setBusy(true);
    setError('');
    try {
      const result = await window.workbench.capturePreviewElement(tab.id, { x, y });
      if (request.current !== id) return;
      if (!result) { setError(t('evidence.annotationMissing')); return; }
      const annotationId = crypto.randomUUID();
      const number = (sources.at(-1)?.number ?? 0) + 1;
      exit();
      onChooseEvidence({ id: annotationId, label: t('evidence.annotationLabel', { number, host: new URL(result.url).host }),
        excerpt: (result.excerpt || result.selector).slice(0, EVIDENCE_EXCERPT_LIMIT),
        source: { kind: 'preview', tabId: tab.id, url: result.url, selector: result.selector, number, annotationId } });
    } catch (failure) {
      if (request.current === id) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === id) setBusy(false);
    }
  };

  if (!allowed) return <div className="pane-note error-text">{shell('app.previewBlocked')}</div>;
  return <section className="preview-pane">
    <div className="preview-toolbar"><Globe size={13} /><span>{requestedUrl}</span>
      {onChooseEvidence && <button ref={toggle} type="button" className="text-button preview-annotate-button" aria-pressed={picking}
        aria-keyshortcuts={keyboardShortcut ? (navigator.platform.startsWith('Mac') ? 'Meta+Shift+I' : 'Control+Shift+I') : undefined}
        disabled={!loaded || !stored} onClick={() => {
          setError('');
          if (picking) exit(); else { setPoint(center); setPicking(true); }
        }}><Crosshair size={13} />{t(picking ? 'evidence.exitAnnotation' : 'evidence.annotate')}</button>}
      <button className="text-button" onClick={() => { exit(); setError(''); setLoaded(0); displayed.current = undefined; setRevision(value => value + 1); }}>{shell('common.reload')}</button>
    </div>
    {(picking || error) && <div className="preview-annotation-hint" role={error ? 'alert' : 'status'}>{busy && <LoaderCircle className="spin" size={13} />}{error || t('evidence.annotationHint')}</div>}
    <div className="preview-annotation-stage">
      <iframe name={previewFrameName(tab.id)} title={shell('app.namedPreview', { url: requestedUrl })} key={revision} src={requestedUrl}
        onLoad={() => setLoaded(value => value + 1)} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" />
      {picking && <div className="preview-annotation-target" ref={pickOverlay} tabIndex={0} aria-label={t('evidence.annotationHint')}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          void pick({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        }} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Number(event.key === 'ArrowRight') - Number(event.key === 'ArrowLeft');
          const y = Number(event.key === 'ArrowDown') - Number(event.key === 'ArrowUp');
          if (!(x || y || ['Escape', 'Enter'].includes(event.key))) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') exit();
          else if (event.key === 'Enter') void pick({ x: point.x * rect.width, y: point.y * rect.height });
          else {
            const step = event.shiftKey ? 32 : 8;
            const limit = (value: number) => Math.min(0.999, Math.max(0, value));
            setPoint(current => ({ x: limit(current.x + x * step / rect.width), y: limit(current.y + y * step / rect.height) }));
          }
        }}><Crosshair className="preview-annotation-crosshair" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} size={20} aria-hidden="true" /></div>}
    </div>
  </section>;
}
