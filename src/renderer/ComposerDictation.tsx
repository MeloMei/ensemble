import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { CircleAlert, LoaderCircle, Mic, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DictationError, DictationStatus } from '../shared/dictation';
import { PROMPT_TEXT_LIMIT, type PromptInput } from '../shared/types';
import { IconButton } from './ui';

type Phase = 'starting' | 'recording' | 'awaitingInsert' | 'stopping';
type ComposerDictationError = DictationError | 'draftChanged' | 'promptTooLong';
type StoppedDraft = { text: string; caret: number };
type Recording = { id: string; stopped?: StoppedDraft };
type ChangeDraft = (value: PromptInput, expected?: PromptInput) => boolean | void;

export function useComposerDictation({ active, canEdit, sessionId, composer, composing, draft, onDraftChange }: {
  active: boolean;
  canEdit: boolean;
  sessionId: string;
  composer: RefObject<HTMLTextAreaElement | null>;
  composing: RefObject<boolean>;
  draft: PromptInput;
  onDraftChange: ChangeDraft;
}) {
  const { t } = useTranslation('workspace');
  const feedbackId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const current = useRef<Recording>(undefined);
  const inserted = useRef<StoppedDraft>(undefined);
  const latest = useRef({ draft, onDraftChange });
  latest.current = { draft, onDraftChange };
  const [status, setStatus] = useState<DictationStatus>();
  const [phase, setPhase] = useState<Phase>();
  const [error, setError] = useState<ComposerDictationError>();
  const enabled = active && canEdit;

  function finish(recording: Recording, reason?: ComposerDictationError) {
    if (current.current !== recording) return;
    current.current = undefined;
    setPhase(undefined);
    setError(reason);
  }

  useLayoutEffect(() => {
    setPhase(undefined);
    setError(undefined);
    if (!enabled) return;
    let mounted = true;
    const api = window.workbench;
    if (typeof api.dictationStatus !== 'function') {
      setStatus({ language: 'system', unavailable: 'helperMissing' });
      return;
    }
    void api.dictationStatus().then(value => { if (mounted) setStatus(value); })
      .catch(() => { if (mounted) setStatus({ language: 'system', unavailable: 'helperMissing' }); });
    const unsubscribe = api.onDictationEvent(event => {
      const recording = current.current;
      if (!recording || event.id !== recording.id) return;
      switch (event.type) {
        case 'recording':
        case 'awaitingInsert':
          if (!recording.stopped) setPhase(event.type);
          break;
        case 'cancelled':
          finish(recording);
          break;
        case 'error':
          finish(recording, event.reason);
          break;
        case 'final': {
          const field = composer.current;
          const { draft: currentDraft, onDraftChange: changeDraft } = latest.current;
          if (!recording.stopped || !field || composing.current || field.value !== currentDraft.text) {
            finish(recording, 'draftChanged');
            return;
          }
          const caret = recording.stopped.text === currentDraft.text ? recording.stopped.caret : field.selectionEnd;
          const before = currentDraft.text.slice(0, caret);
          const after = currentDraft.text.slice(caret);
          const prefix = /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(event.text) ? ' ' : '';
          const suffix = /[A-Za-z0-9.!?]$/.test(event.text) && /^[A-Za-z0-9]/.test(after) ? ' ' : '';
          const text = before + prefix + event.text + suffix + after;
          if (text.length > PROMPT_TEXT_LIMIT) { finish(recording, 'promptTooLong'); return; }
          if (changeDraft({ ...currentDraft, text }, currentDraft) === false) {
            finish(recording, 'draftChanged');
            return;
          }
          inserted.current = { text, caret: caret + prefix.length + event.text.length };
          finish(recording);
          break;
        }
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
      inserted.current = undefined;
      const recording = current.current;
      current.current = undefined;
      if (recording) void api.cancelDictation(recording.id).catch(() => {});
    };
  }, [enabled, sessionId, composer, composing]);

  useLayoutEffect(() => {
    const result = inserted.current;
    const field = composer.current;
    if (!result || !field || result.text !== draft.text) return;
    inserted.current = undefined;
    if (document.activeElement === button.current) field.focus({ preventScroll: true });
    field.setSelectionRange(result.caret, result.caret);
  }, [composer, draft.text]);

  function toggle() {
    if (!enabled || !status || status.unavailable) return;
    const recording = current.current;
    if (recording) {
      const field = composer.current;
      if (!field || composing.current || (phase !== 'recording' && phase !== 'awaitingInsert')) return;
      recording.stopped = { text: field.value, caret: field.selectionEnd };
      setPhase('stopping');
      void window.workbench.stopDictation(recording.id).catch(() => {
        void window.workbench.cancelDictation(recording.id).catch(() => {});
        finish(recording, 'failed');
      });
      return;
    }
    const next = { id: crypto.randomUUID() };
    current.current = next;
    setError(undefined);
    setPhase('starting');
    void window.workbench.startDictation(next.id, sessionId).then(reason => { if (reason) finish(next, reason); })
      .catch(() => {
        void window.workbench.cancelDictation(next.id).catch(() => {});
        finish(next, 'failed');
      });
  }

  function cancel() {
    const recording = current.current;
    if (!recording) return;
    finish(recording);
    button.current?.focus({ preventScroll: true });
    void window.workbench.cancelDictation(recording.id).catch(() => {});
  }

  const label = phase === 'recording' ? t('dictation.stop') : phase === 'awaitingInsert' ? t('dictation.insert') : t('dictation.start');
  const blocked = !enabled || !status || Boolean(status.unavailable) || phase === 'starting' || phase === 'stopping';
  const unavailable = status?.unavailable && t(`dictation.error.${status.unavailable}`);
  const feedback = error ? t(`dictation.error.${error}`) : phase ? t(`dictation.status.${phase}`) : undefined;
  return {
    controls: active && <>
      <IconButton ref={button} label={label} title={unavailable ?? label} aria-disabled={blocked}
        aria-describedby={feedback || unavailable ? feedbackId : undefined} onClick={toggle}>
        {phase === 'starting' || phase === 'stopping' ? <LoaderCircle className="spin" size={16} /> : phase ? <Square size={15} /> : <Mic size={16} />}
      </IconButton>
      {phase && <IconButton label={t('dictation.cancel')} onClick={cancel}><X size={16} /></IconButton>}
    </>,
    feedback: active && feedback && <p className="composer-note" id={feedbackId} role={error ? 'alert' : 'status'}>
      {error && <CircleAlert size={13} aria-hidden="true" />}{feedback}
    </p> || active && unavailable && <span id={feedbackId} hidden>{unavailable}</span>,
  };
}
