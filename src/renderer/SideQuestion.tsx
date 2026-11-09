import { ArrowUpLeft, MessageCircle, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { SIDE_QUESTION_LIMIT, type SideQuestionReference, type SideQuestionReceipt } from '../shared/types';
import { questionExcerpt } from '../shared/side-question';
import { runSessionCommand } from './session-command';
import { BusyIcon, IconButton } from './ui';
import './SideQuestion.css';

type AnswerReference = Extract<SideQuestionReference, { kind: 'answer' }>;
export interface SideQuestionOrigin {
  reference: SideQuestionReference;
  excerpt: string;
  trigger: HTMLButtonElement;
}

function answerElement(node: Node): Element | null {
  return (node instanceof Element ? node : node.parentElement)?.closest('.markdown-message') ?? null;
}

export function useAnswerQuestionSelection(scroll: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [answer, setAnswer] = useState<AnswerReference>();
  useEffect(() => {
    if (!enabled) { setAnswer(undefined); return; }
    const update = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { setAnswer(undefined); return; }
      const range = selection.getRangeAt(0);
      const answer = answerElement(range.startContainer);
      const message = answer?.closest<HTMLElement>('.message-assistant[data-message-id]');
      const messageId = message?.dataset.messageId;
      if (!answer || !messageId || !scroll.current?.contains(answer) || answerElement(range.endContainer) !== answer) {
        setAnswer(undefined);
        return;
      }
      const excerpt = questionExcerpt(range.toString());
      setAnswer(current => !excerpt ? undefined : current?.messageId === messageId && current.excerpt === excerpt
        ? current : { kind: 'answer', messageId, excerpt });
    };
    document.addEventListener('selectionchange', update);
    update();
    return () => document.removeEventListener('selectionchange', update);
  }, [enabled, scroll]);
  return enabled ? answer : undefined;
}

export function SideQuestionAction({ onClick }: { onClick: (trigger: HTMLButtonElement) => void }) {
  const { t } = useTranslation('workspace');
  return <button className="side-question-trigger" type="button" onMouseDown={event => event.preventDefault()}
    onClick={event => onClick(event.currentTarget)}><MessageCircle size={13} aria-hidden="true" />{t('chat.sideQuestion.action')}</button>;
}

export function SideQuestion({ sessionId, origin, enabled, onClose, locateSource, openSession, canOpenSession }: {
  sessionId: string;
  origin: SideQuestionOrigin;
  enabled: boolean;
  onClose: () => void;
  locateSource: (messageId: string) => Promise<boolean>;
  openSession: (id: string) => void;
  canOpenSession: (id: string) => boolean;
}) {
  const { t } = useTranslation('workspace');
  const titleId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<SideQuestionReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState(false);
  const inFlight = useRef(false);
  const submitted = useRef<string | undefined>(undefined);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);

  async function send() {
    const text = submitted.current ?? question.trim();
    if (!enabled || inFlight.current || !text || result) return;
    submitted.current = text;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const input = { question: text, reference: origin.reference };
      const receipt = await runSessionCommand(`side-question:${sessionId}:${origin.reference.messageId}`, input,
        commandId => window.workbench.askSideQuestion(sessionId, input, commandId));
      if (receipt.inSplit) onClose();
      else setResult(receipt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function locate() {
    setSourceError(false);
    try { if (await locateSource(origin.reference.messageId)) return; } catch { /* The original row may no longer be available. */ }
    setSourceError(true);
  }

  return <aside className="side-question" aria-labelledby={titleId} onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    event.preventDefault();
    if (!inFlight.current) onClose();
  }}>
    <header>
      <h3 id={titleId}><MessageCircle size={15} aria-hidden="true" />{t('chat.sideQuestion.title')}</h3>
      <IconButton label={t('chat.sideQuestion.close')} disabled={busy} onClick={onClose}><X size={15} /></IconButton>
    </header>
    <blockquote>{origin.excerpt}</blockquote>
    <button type="button" className="side-question-locate" onClick={() => void locate()}>
      <ArrowUpLeft size={13} aria-hidden="true" />{t('chat.sideQuestion.locate')}
    </button>
    {sourceError && <p className="field-error" role="alert">{t('chat.sideQuestion.sourceMissing')}</p>}
    {result ? <>
      <p role="status">{t(result.waitingForProject ? 'chat.sideQuestion.queuedTab' : 'chat.sideQuestion.sentTab')}</p>
      <button className="button" type="button" disabled={!canOpenSession(result.sessionId)}
        onClick={() => { onClose(); openSession(result.sessionId); }}>{t('chat.sideQuestion.openTab')}</button>
    </> : <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea ref={input} aria-label={t('chat.sideQuestion.input')} rows={3} maxLength={SIDE_QUESTION_LIMIT}
        placeholder={t('chat.sideQuestion.input')} readOnly={submitted.current !== undefined}
        value={question} onChange={event => setQuestion(event.target.value)} />
      {!enabled && <p role="status">{t('chat.sideQuestion.unavailable')}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="button primary" disabled={busy || !enabled || !question.trim()}>
        <BusyIcon busy={busy}><MessageCircle size={14} aria-hidden="true" /></BusyIcon>
        {t(error ? 'chat.sideQuestion.retry' : 'chat.sideQuestion.send')}
      </button>
    </form>}
  </aside>;
}
