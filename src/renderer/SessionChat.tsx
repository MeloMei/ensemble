import { AgentIcon } from './AgentIcon';
import { useTranslation } from 'react-i18next';
import { hasConversationText } from '../shared/message-text';
import { formatDate, formatNumber, renderDisplayText } from '../shared/i18n';
import { sessionComposerActivity } from '../shared/session-composer-activity';
import { validQuestionAnswers } from '../shared/question-answers';
import { ATTACHMENT_LIMITS, attachmentLimitIssue, supportsPromptAttachment } from '../shared/prompt-attachments';
import { draftPromptText, EVIDENCE_EXCERPT_LIMIT, hasPromptInput } from '../shared/draft-evidence';
import { PROMPT_TEXT_LIMIT } from '../shared/types';
import { Fragment, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AppSelect } from './AppSelect';
import { ComposerModelPicker } from './ComposerModelPicker';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, Archive, ArrowDown, ArrowUp, ArrowUpLeft, Check, ChevronDown,
  CircleAlert, CircleStop, Clock3, Copy, CornerDownLeft, FileText, FolderOpen,
  GitCompareArrows, GitFork, Image, ListChecks, LoaderCircle, MessageCircle, PanelsTopLeft,
  Paperclip, Pause, Play, Search, ShieldCheck, TerminalSquare, Users, X, ArrowRightLeft,
} from 'lucide-react';
import type {
  Approval, DraftEvidence, DraftEvidenceSource, Message, ProcessEvent, PromptAttachment, PromptInput, ProviderInfo, Session, SessionQueueItem, SessionSkillAssignmentReceipt, SkillInfo, UsageRecord,
} from '../shared/types';
import { BusyIcon, IconButton, Modal, ModelField, ProviderSelect, Status, defaultModelId, modelName, pathName, validModelSelection, type Perform } from './ui';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';
import { useClaudeScrollPinning } from './vendor/open-claude-ui/useClaudeScrollPinning';
import { useSessionHistory, type IndexedMessages } from './useSessionHistory';
import { promptCommandInput, runSessionCommand, runSessionStopCommand, SessionCommandRejectedError } from './session-command';
import { sessionAttentionMessage, sessionIsUnread, type SessionAttentionOpen } from './session-attention';
import { Tooltip } from './Tooltip';
import { DetailCard } from './ui-kit/DetailCard';
import { RollingText } from './ui-kit/RollingText';
import { expandConversation, type TraceEntry } from './conversation-index';
import { measureConversationRow, useReadingAnchor, useSessionReadingPosition } from './useSessionReadingPosition';
import { WorkspaceFileNavigation, workspaceFileReference } from './workspace-file-reference';
import { diffLines } from './review-notes';
import { questionExcerpt } from '../shared/side-question';
import { SideQuestion, SideQuestionAction, useAnswerQuestionSelection, type SideQuestionOrigin } from './SideQuestion';
import { DraftEvidenceCards } from './DraftEvidence';
import { useWorkspaceFileMention, WorkspaceFileMention } from './WorkspaceFileMention';
import './SessionChat.css';

interface SessionChatProps {
  session: Session;
  provider?: ProviderInfo;
  providers?: ProviderInfo[];
  perform: Perform;
  pending: Set<string>;
  draft: PromptInput;
  draftError?: string;
  onDraftChange: (value: PromptInput, expected?: PromptInput) => void;
  readOnly?: boolean;
  sessions?: Session[];
  openSession: (id: string) => void;
  connected?: boolean;
  attentionOpen?: SessionAttentionOpen;
  onAttentionOpened?: (request: SessionAttentionOpen) => void;
  messageOpen?: { sessionId: string; messageId: string };
  onMessageOpened?: (request: NonNullable<SessionChatProps['messageOpen']>) => void;
  onOpenForkSource?: (sessionId: string, messageId?: string) => void;
  workspaceId?: string;
  onChooseEvidence?: (reference: DraftEvidence) => void;
  onOpenEvidence?: (source: DraftEvidenceSource) => void;
}

type ApprovalProps = Pick<SessionChatProps, 'pending' | 'perform'> & { approval: Approval };

const activeStatuses = new Set<Session['status']>(['running', 'waiting_approval', 'waiting_children', 'queued']);
const clipboardImageExtensions: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

function QuestionApproval({ approval, pending, perform }: ApprovalProps) {
  const { t } = useTranslation('workspace');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const questions = approval.questions ?? [];
  const answers = Object.fromEntries(questions.map(question => [
    question.id,
    [...(selected[question.id] ?? []), ...(question.allowCustomAnswer !== false && free[question.id]?.trim() ? [free[question.id].trim()] : [])],
  ]));
  const valid = validQuestionAnswers(questions, answers);
  const busy = pending.has(`approval-${approval.id}`);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    void perform(`approval-${approval.id}`, () => runSessionCommand(`approval:${approval.id}`, answers,
      commandId => window.workbench.answerQuestions(approval.id, answers, commandId)));
  };

  return <form className="approval-card question-approval" onSubmit={submit}>
    <ApprovalHeading title={renderDisplayText(approval.title || t('approval.answerTitle'), approval.titleI18n)} caption={t('approval.answerCaption')} busy={busy} />
    {approval.detail && <p className="approval-detail">{approval.detail}</p>}
    {questions.map(question => <fieldset key={question.id}>
      <legend>{question.header && <span>{renderDisplayText(question.header, question.headerI18n)}</span>}{question.question}</legend>
      {question.multiSelect && <p className="question-hint">{t('approval.multiple')}</p>}
      <div className="question-options">
        {question.options.map(option => {
          const checked = (selected[question.id] ?? []).includes(option.label);
          return <button type="button" className={checked ? 'selected' : ''} key={option.label}
            aria-pressed={checked} disabled={busy} onClick={() => {
              setSelected(current => ({
                ...current,
                [question.id]: question.multiSelect
                  ? checked
                    ? (current[question.id] ?? []).filter(value => value !== option.label)
                    : [...(current[question.id] ?? []), option.label]
                  : checked ? [] : [option.label],
              }));
              if (!question.multiSelect) setFree(current => ({ ...current, [question.id]: '' }));
            }}>
            <span className={`choice-indicator ${question.multiSelect ? 'multi' : ''}`} aria-hidden="true">
              {checked && <Check size={12} />}
            </span>
            <span><strong>{renderDisplayText(option.label, option.labelI18n)}</strong>{option.description && <small>{option.description}</small>}</span>
          </button>;
        })}
      </div>
      {question.allowCustomAnswer !== false && <input aria-label={t('approval.otherAnswer', { question: renderDisplayText(question.header || question.question, question.headerI18n) })} value={free[question.id] ?? ''}
        disabled={busy} placeholder={question.multiSelect ? t('approval.otherPlaceholder') : t('approval.answerPlaceholder')}
        onChange={event => {
          setFree(current => ({ ...current, [question.id]: event.target.value }));
          if (!question.multiSelect) setSelected(current => ({ ...current, [question.id]: [] }));
        }} />}
    </fieldset>)}
    <div className="question-submit">
      <button className="button primary small" disabled={!valid || busy}>
        {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t('approval.submit')}</button>
    </div>
  </form>;
}

function ApprovalHeading({ title, caption, busy }: { title: string; caption: string; busy: boolean }) {
  return <div className="approval-title">
    <span className="approval-symbol">{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}</span>
    <div><span>{caption}</span><strong>{title}</strong></div>
  </div>;
}

function ApprovalCard({ approval, pending, perform }: ApprovalProps) {
  const { t } = useTranslation('workspace');
  if (approval.questions?.length) return <QuestionApproval approval={approval} pending={pending} perform={perform} />;
  const busy = pending.has(`approval-${approval.id}`);
  return <section className="approval-card" aria-busy={busy}>
    <ApprovalHeading title={renderDisplayText(approval.title, approval.titleI18n)} caption={t('approval.confirmCaption')} busy={busy} />
    <p>{approval.detail}</p>
    <div className="approval-actions">
      {approval.choices.map(choice => <button key={choice.id} className="button small" disabled={busy}
        onClick={() => void perform(`approval-${approval.id}`, () => runSessionCommand(`approval:${approval.id}`, choice.id,
          commandId => window.workbench.decideApproval(approval.id, choice.id, commandId)))}>
        {renderDisplayText(choice.label, choice.labelI18n)}
      </button>)}
    </div>
  </section>;
}

function CollapsibleRegion({ expanded, id, className = '', regionRef, onClose, children }: {
  expanded: boolean;
  id?: string;
  className?: string;
  regionRef?: Ref<HTMLDivElement>;
  onClose?: () => void;
  children: ReactNode;
}) {
  return <div ref={regionRef} id={id} className={`chat-collapse ${className}`} data-expanded={expanded}
    aria-hidden={!expanded} inert={!expanded} onKeyDown={event => {
      if (event.key === 'Escape' && expanded && onClose) { event.stopPropagation(); onClose(); }
    }}>
    <div className="chat-collapse-inner">{children}</div>
  </div>;
}

type SkillAssignmentChange = {
  skillId: string;
  enabled: boolean;
  phase: 'saving' | 'saved' | 'failed';
};

function SessionSkillAssignments({ session, workspaceId, visible, perform }: {
  session: Session;
  workspaceId: string;
  visible: boolean;
  perform: Perform;
}) {
  const { t } = useTranslation('workspace');
  const id = useId();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [change, setChange] = useState<SkillAssignmentChange>();
  const [receipt, setReceipt] = useState<SessionSkillAssignmentReceipt>();
  const latestSession = useRef(session);
  if (session.updatedAt >= latestSession.current.updatedAt) latestSession.current = session;
  const inFlight = useRef<SkillAssignmentChange | undefined>(undefined);
  const mounted = useRef(false);
  const authority = latestSession.current;
  const active = activeStatuses.has(session.status);
  const skillIds = receipt && receipt.updatedAt >= authority.updatedAt ? receipt.skillIds : authority.settings?.skillIds ?? [];
  const busy = change?.phase === 'saving';
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; inFlight.current = undefined; };
  }, []);
  useEffect(() => {
    let current = true;
    if (visible) void perform(`session-skills-${session.id}`, async () => {
      const next = await window.workbench.listSkills(workspaceId);
      if (current) setSkills(next.filter(skill => !skill.issue));
    });
    return () => { current = false; };
  }, [workspaceId, session.id, visible, perform]);

  const assign = (skillId: string, enabled: boolean) => {
    if (inFlight.current || active) return;
    const operation: SkillAssignmentChange = { skillId, enabled, phase: 'saving' };
    inFlight.current = operation;
    setChange(operation);
    void perform(`session-skill-${session.id}`, async () => {
      try {
        const saved = await window.workbench.updateSession(session.id, { skillAssignment: { skillId, enabled } });
        if (mounted.current && inFlight.current === operation) {
          setReceipt(saved);
          inFlight.current = undefined;
          setChange({ ...operation, phase: 'saved' });
        }
      } catch (error) {
        if (mounted.current && inFlight.current === operation) {
          inFlight.current = undefined;
          setChange({ ...operation, phase: 'failed' });
        }
        throw error;
      }
    });
  };

  if (!skills.length) return null;
  return <section className="session-skills" aria-labelledby={`${id}-heading`} aria-busy={busy}>
    <span id={`${id}-heading`}>{t('chat.skills')}</span>
    <div className="skills-select">
      {skills.map((skill, index) => {
        const enabled = skillIds.includes(skill.id);
        const current = change?.skillId === skill.id && !(change.phase === 'saved' && change.enabled !== enabled) ? change : undefined;
        const status = current?.phase === 'saving'
          ? t(current.enabled ? 'chat.skillEnabling' : 'chat.skillRemoving')
          : current?.phase === 'failed'
            ? t(current.enabled ? 'chat.skillEnableFailed' : 'chat.skillRemoveFailed')
            : current?.phase === 'saved'
              ? t(current.enabled ? 'chat.skillEnabledSaved' : 'chat.skillRemovedSaved')
              : t(enabled ? 'chat.skillEnabled' : 'chat.skillNotEnabled');
        const statusId = `${id}-${index}-status`;
        return <div className="session-skill-assignment" key={skill.id} data-skill-id={skill.id}
          data-state={current?.phase ?? (enabled ? 'enabled' : 'disabled')} data-enabled={enabled}>
          <label title={skill.description}>
            <input type="checkbox" disabled={active || busy} checked={enabled} aria-describedby={statusId}
              onChange={event => assign(skill.id, event.target.checked)} />
            <span className="session-skill-agent" aria-hidden="true">
              <AgentIcon providerId={session.providerId} size={16} />
              <span className="session-skill-badge">
                {current?.phase === 'saving' ? <LoaderCircle size={10} />
                  : current?.phase === 'failed' ? <CircleAlert size={10} />
                    : enabled ? <Check size={10} /> : <X size={10} />}
              </span>
            </span>
            <strong>{skill.name}</strong>
          </label>
          <span className="session-skill-status" id={statusId} role="status" aria-live="polite" aria-atomic="true">
            {status}
          </span>
          {current?.phase === 'failed' && <button type="button" className="session-skill-retry" disabled={active || busy}
            aria-label={t(current.enabled ? 'chat.skillRetryEnable' : 'chat.skillRetryRemove', { name: skill.name })}
            onClick={() => assign(skill.id, current.enabled)}>{t('chat.skillRetry')}</button>}
        </div>;
      })}
    </div>
  </section>;
}

export function SessionSettingsPanel({ session, workspaceId, visible, perform, openSession }: {
  session: Session;
  workspaceId: string;
  visible: boolean;
  perform: Perform;
  openSession: (id: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const active = activeStatuses.has(session.status);
  return <div className="session-settings">
    <SessionSkillAssignments key={`${workspaceId}:${session.id}`} session={session} workspaceId={workspaceId} visible={visible} perform={perform} />
    <div className="session-settings-footer">
      {active && <span>{t('chat.settingsAfterTask')}</span>}
      <button disabled={active} onClick={() => void perform('archive-session',
        () => window.workbench.updateSession(session.id, { archived: !session.archived }))}>
        <Archive size={13} />{session.archived ? t('chat.unarchive') : t('chat.archive')}
      </button>
      <button disabled={active} onClick={() => void perform('fork-session',
        async () => openSession(await window.workbench.forkSession(session.id)))}>
        <GitFork size={13} />{t('chat.forkCurrent')}</button>
    </div>
  </div>;
}

function SessionContinuation({ session, providers, connected, perform }: {
  session: Session;
  providers: ProviderInfo[];
  connected: boolean;
  perform: Perform;
}) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<{ providerId: string; modelId?: string }>({ providerId: '' });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alternatives = providers.filter(provider => provider.id !== session.providerId);
  const hasText = session.messages.some(hasConversationText) || Boolean(session.historyCursor);
  const unavailable = !alternatives.some(provider => provider.available);
  const disabled = !connected || session.historyLoaded === false || activeStatuses.has(session.status) || !hasText || unavailable;
  const provider = alternatives.find(item => item.id === selection.providerId);
  const title = t('chat.continueWithAgent');
  const hint = activeStatuses.has(session.status) ? t('chat.continueAfterTask')
    : !hasText ? t('chat.continueNoText') : unavailable ? t('chat.continueNoAgent') : title;
  const close = () => { setOpen(false); setSelection({ providerId: '' }); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || inFlight.current || !validModelSelection(provider, selection.modelId)) return;
    inFlight.current = true;
    setBusy(true);
    void perform(`continue-session-${session.id}`, async () => {
      try {
        await window.workbench.continueSession(session.id, selection);
        close();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    });
  };
  return <>
    <IconButton label={title} title={hint} disabled={disabled || busy} onClick={() => setOpen(true)}>
      <ArrowRightLeft size={15} />
    </IconButton>
    {open && <Modal title={title} subtitle={t('chat.continueDraftNote')} busy={busy} onClose={close}>
      <form onSubmit={submit}>
        <label>{t('shell:common.agent')}
          <ProviderSelect providers={alternatives} value={selection.providerId} disabled={disabled || busy}
            onChange={providerId => setSelection({ providerId, modelId: defaultModelId(alternatives.find(item => item.id === providerId)) })} />
        </label>
        <ModelField provider={provider} value={selection.modelId} disabled={disabled || busy}
          onChange={modelId => setSelection(current => ({ ...current, modelId: modelId || undefined }))} />
        <div className="modal-actions">
          <button type="button" className="button subtle" disabled={busy} onClick={close}>{t('shell:common.cancel')}</button>
          <button className="button primary" disabled={disabled || busy || !validModelSelection(provider, selection.modelId)}>
            <BusyIcon busy={busy}><ArrowRightLeft size={14} /></BusyIcon>{t('chat.continueCreateDraft')}
          </button>
        </div>
      </form>
    </Modal>}
  </>;
}


function ComposerSettings({ session, provider, disabled, saving, perform }: {
  session: Session;
  provider?: ProviderInfo;
  disabled: boolean;
  saving: boolean;
  perform: Perform;
}) {
  const { t } = useTranslation('workspace');
  const hint = saving ? t('chat.savingSettings') : t('chat.settingsAfterTask');
  const change = async (patch: Parameters<typeof window.workbench.updateSession>[1]) => {
    let accepted = false;
    await perform(`session-settings-${session.id}`, async () => {
      await window.workbench.updateSession(session.id, patch);
      accepted = true;
    });
    return accepted;
  };
  return <>
    <ComposerModelPicker session={session} provider={provider} disabled={disabled} saving={saving} hint={hint} onChange={change} />
    {provider?.capabilities.permissions && <AppSelect compact side="top" menuClassName="composer-select-menu" label={t('chat.permissions')} icon={<ShieldCheck size={13} />}
      value={session.settings?.permission ?? 'review'} display={session.settings?.permission === 'read-only' ? t('common.readOnly') : t('chat.reviewPermissionShort')}
      disabled={disabled || saving} hint={hint} onChange={value => void change({ settings: { permission: value as 'review' | 'read-only' } })}
      options={[{ value: 'review', label: t('chat.reviewPermission') }, { value: 'read-only', label: t('common.readOnly') }]} />}
    {saving && <span className="composer-settings-saving" role="status" aria-label={t('chat.savingSettings')}><LoaderCircle size={13} className="spin" /></span>}
  </>;
}

function AttachmentChips({ attachments, onRemove }: {
  attachments: PromptAttachment[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const [preview, setPreview] = useState<PromptAttachment>();
  if (!attachments.length) return null;
  return <><div className="attachments-strip">
    {attachments.map(item => <span className="attachment-chip" key={item.id} title={`${item.name} · ${Math.ceil(item.size / 1024)} KB`}>
      {item.kind === 'image' ? <button className="attachment-preview-trigger" type="button" aria-label={t('evidence.previewAttachment', { name: item.name })}
        onClick={() => setPreview(item)}><Image size={14} /><span>{item.name}</span></button> : <><FileText size={14} /><span>{item.name}</span></>}
      <small>{Math.ceil(item.size / 1024)} KB</small>
      {onRemove && <Tooltip label={t('chat.removeAttachment', { name: item.name })}><button className="attachment-remove" type="button" aria-label={t('chat.removeAttachment', { name: item.name })} onClick={() => onRemove(item.id)}><X size={12} /></button></Tooltip>}
    </span>)}
  </div>{preview && <ImageAttachmentPreview key={preview.id} attachment={preview} onClose={() => setPreview(undefined)} />}</>;
}

function ImageAttachmentPreview({ attachment, onClose }: { attachment: PromptAttachment; onClose: () => void }) {
  const { t } = useTranslation('workspace');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.workbench.readImageAttachment(attachment).then(source => { if (active) setImage(source); }, failure => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { active = false; };
  }, [attachment]);
  return <Modal title={t('evidence.previewAttachment', { name: attachment.name })} size="wide" onClose={onClose}>
    <div className="draft-attachment-preview">{error ? <p className="field-error" role="alert">{error}</p>
      : image ? <img alt={attachment.name} src={image} /> : <LoaderCircle className="spin" size={16} />}</div>
  </Modal>;
}

function CopyAnswer({ message, perform }: { message: Message; perform: Perform }) {
  const { t } = useTranslation('workspace');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <IconButton label={copied ? t('chat.copied') : t('chat.copyAnswer')} onClick={() => void perform(`copy-${message.id}`, async () => {
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
  })}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>;
}

function AttachmentLimitNotice({ issue }: { issue: ReturnType<typeof attachmentLimitIssue> }) {
  const { t } = useTranslation('workspace');
  if (!issue) return null;
  return <p className="composer-note" role="alert"><CircleAlert size={13} />{issue === 'count'
    ? t('chat.attachmentCountExceeded', { count: ATTACHMENT_LIMITS.count })
    : t('chat.attachmentBytesExceeded', { size: ATTACHMENT_LIMITS.totalBytes / 1024 / 1024 })}</p>;
}

const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
  a: function AnswerLink({ node: _node, children, ...props }) {
    const navigation = useContext(WorkspaceFileNavigation);
    const reference = navigation && props.href && workspaceFileReference(props.href, navigation.cwd, true);
    const label = <WorkspaceFileNavigation.Provider value={null}>{children}</WorkspaceFileNavigation.Provider>;
    return reference
      ? <button type="button" className="markdown-file-link" onClick={() => navigation.open(reference)}>{label}</button>
      : <a {...props} target="_blank" rel="noreferrer">{label}</a>;
  },
  code: function AnswerCode({ node: _node, children, ...props }) {
    const navigation = useContext(WorkspaceFileNavigation);
    const reference = navigation && typeof children === 'string' && workspaceFileReference(children, navigation.cwd);
    const code = <code {...props}>{children}</code>;
    return reference
      ? <button type="button" className="markdown-file-link" onClick={() => navigation.open(reference)}>{code}</button>
      : code;
  },
};
const MarkdownAnswer = memo(function MarkdownAnswer({ text }: { text: string }) {
  const navigation = useContext(WorkspaceFileNavigation);
  return <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents} urlTransform={(url, key, node) =>
    key === 'href' && node.tagName === 'a' && navigation && workspaceFileReference(url, navigation.cwd, true) ? url : defaultUrlTransform(url)}>
    {text}
  </ReactMarkdown>;
});

function SessionProgress({ status }: { status: Session['status'] }) {
  const { t } = useTranslation('workspace');
  const states = {
    running: { icon: <Activity size={14} />, text: t('chat.progress.running') },
    waiting_approval: { icon: <ShieldCheck size={14} />, text: t('chat.progress.waitingApproval') },
    waiting_children: { icon: <Users size={14} />, text: t('chat.progress.waitingChildren') },
    queued: { icon: <Clock3 size={14} />, text: t('chat.progress.queued') },
    completed: { icon: <Check size={14} />, text: t('chat.progress.completed') },
    failed: { icon: <CircleAlert size={14} />, text: t('chat.progress.failed') },
    cancelled: { icon: <CircleStop size={14} />, text: t('chat.progress.cancelled') },
    interrupted: { icon: <CircleAlert size={14} />, text: t('chat.progress.interrupted') },
  };
  const state = states[status as keyof typeof states];
  if (!state) return null;
  return <div className={`running-indicator is-${status}`} role="status">{state.icon}<span>{state.text}</span></div>;
}

function UsageBadge({ records = [] }: { records?: UsageRecord[] }) {
  const { t } = useTranslation('workspace');
  let usage = records.at(-1);
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.scope === 'context' && (record.contextUsed !== undefined || (record.contextSize ?? 0) > 0)) {
      usage = record;
      break;
    }
  }
  if (!usage) return null;
  if (usage.scope === 'context') {
    const { contextUsed, contextSize } = usage;
    const capacity = contextSize !== undefined && contextSize > 0 ? contextSize : undefined;
    const ratio = contextUsed !== undefined && capacity !== undefined ? contextUsed / capacity : undefined;
    const values = [
      contextUsed === undefined ? undefined : { label: t('usage.contextUsedLabel'), value: formatNumber(contextUsed) },
      capacity === undefined ? undefined : { label: t('usage.contextLimit'), value: formatNumber(capacity) },
      ratio === undefined ? undefined : { label: t('usage.contextShare'), value: formatNumber(ratio, { style: 'percent', maximumFractionDigits: 1 }) },
    ].filter(row => row !== undefined);
    if (!values.length) return null;
    const tone = ratio !== undefined && ratio >= .9 ? 'danger' : ratio !== undefined && ratio >= .75 ? 'warning' : 'normal';
    return <DetailCard side="top" title={t('usage.contextHeading')}
      description={values.map(row => `${row.label} ${row.value}`).join(' · ')}
      details={values.map(row => <Fragment key={row.label}><dt>{row.label}</dt><dd className="context-usage-value"><RollingText value={row.value} /></dd></Fragment>)}>
      <span className={`session-usage context-usage-trigger is-${tone}`} tabIndex={0} aria-label={t('usage.contextHeading')}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="context-usage-track" cx="7" cy="7" r="5.25" />
          {ratio !== undefined && <circle className="context-usage-fill" cx="7" cy="7" r="5.25" pathLength="100"
            strokeDasharray={`${Math.min(100, Math.max(0, ratio * 100))} 100`} transform="rotate(-90 7 7)" />}
        </svg>
        {t('usage.contextLabel')}
      </span>
    </DetailCard>;
  }
  return <span className="session-usage">{t('usage.outputTokens', { tokens: usage.outputTokens === undefined ? '—' : formatNumber(usage.outputTokens) })}</span>;
}

function DeliveryState({ message, sessionId, pending, perform, connected, readOnly }: {
  message: Message; sessionId: string; pending: Set<string>; perform: Perform; connected: boolean; readOnly: boolean;
}) {
  const { t } = useTranslation('workspace');
  const delivery = message.delivery;
  if (!delivery) return null;
  return <div className={`message-delivery delivery-${delivery.status}`}>
    <span title={delivery.reason}>{t(`chat.delivery.${delivery.status}`)}</span>
    {!readOnly && (delivery.status === 'unknown' || delivery.status === 'pending') && <button
      disabled={!connected || pending.has(`reconcile-${sessionId}`)}
      onClick={() => void perform(`reconcile-${sessionId}`, () => window.workbench.reconcileSessionDelivery(sessionId))}>
      {t('chat.checkDelivery')}
    </button>}
    {delivery.status === 'rejected' && delivery.reason && <span>{delivery.reason}</span>}
  </div>;
}

type QueueProps = Pick<SessionChatProps, 'session' | 'provider' | 'pending' | 'perform'> & { connected: boolean };
const queueEditorWindowId = crypto.randomUUID();
const queueDraftFlushes = new Map<string, Promise<void>>();

function PromptQueue({ session, provider, pending, perform, connected }: QueueProps) {
  const { t } = useTranslation('workspace');
  const queue = session.queue ?? [];
  if (!queue.length) return null;
  const pauseKey = `queue-pause-${session.id}`;
  return <section className="prompt-queue" aria-label={t('chat.queueTitle')}>
    <header>
      <button disabled={!connected || pending.has(pauseKey)} onClick={() => void perform(pauseKey,
        () => window.workbench.setSessionQueuePaused(session.id, !session.queuePaused))}>
        {session.queuePaused ? <Play size={12} /> : <Pause size={12} />}{session.queuePaused ? t('chat.resumeQueue') : t('chat.pauseQueue')}
      </button>
    </header>
    {session.queuePaused && <p className="queue-paused"><Pause size={12} />{t('chat.queuePaused')}{session.queueHoldReason && <span>{session.queueHoldReason}</span>}</p>}
    {!session.queuePaused && !queue[0].edit && session.waitingForProject && <p className="queue-paused" role="status"><Clock3 size={12} />{t('chat.sideQuestion.waiting')}</p>}
    <ol>{queue.map(item => <QueuedPromptRow key={item.id} item={item} sessionId={session.id} provider={provider}
      connected={connected} pending={pending} perform={perform} />)}</ol>
  </section>;
}

function QueuedPromptRow({ sessionId, item, provider, connected, pending, perform }:
  Omit<QueueProps, 'session'> & { sessionId: string; item: SessionQueueItem }) {
  const { t } = useTranslation('workspace');
  const [acquired, setAcquired] = useState<{ id: string; revision: number; input: PromptInput }>();
  const key = `queue-item-${item.id}`;
  const revision = item.revision ?? 0;
  const disabled = !connected || pending.has(key);
  const edit = acquired && (revision < acquired.revision || item.edit?.id === acquired.id) ? acquired : undefined;
  const editingElsewhere = acquired && !edit && item.edit;
  const begin = () => void perform(key, async () => {
    await queueDraftFlushes.get(item.id);
    const id = crypto.randomUUID();
    const input = await window.workbench.beginQueuedPromptEdit(sessionId, item.id, revision, id, queueEditorWindowId);
    setAcquired({ id, revision: revision + 1, input });
  });
  const remove = () => runSessionCommand(`queue-remove:${sessionId}:${item.id}`, { revision: edit?.revision ?? revision, editId: edit?.id },
    commandId => window.workbench.removeQueuedPrompt(sessionId, item.id, edit?.revision ?? revision, commandId, edit?.id));
  return <li data-queue-id={item.id}>
    {(item.edit || edit) && <p className="queue-edit-hold" role="status">{t('chat.queueEditHeld')}</p>}
    {editingElsewhere && <p className="queue-edit-hold" role="alert">{t('chat.queueEditMoved')}</p>}
    {(edit || editingElsewhere) && acquired && <QueuedPromptEditor key={acquired.id} sessionId={sessionId} itemId={item.id}
      editId={acquired.id} initial={acquired.input} current={Boolean(edit)} connected={connected} disabled={disabled} perform={action => void perform(key, async () => {
        await action();
        setAcquired(current => current?.id === acquired.id ? undefined : current);
      })} remove={remove} />}
    {!edit && <>
      {!editingElsewhere && <div className="queue-item-content"><p>{item.input.text || t('chat.queuedAttachments')}</p>
        <small>{item.modelId ? modelName(provider, item.modelId) : t('chat.runtimeDefault')}{item.settings?.effort ? ` · ${item.settings.effort}` : ''}</small>
        <AttachmentChips attachments={item.input.attachments ?? []} />
      </div>}
      <div className="queue-item-actions"><button disabled={disabled} onClick={begin}>
        {t(item.edit ? 'chat.resumeQueuedEdit' : 'chat.editQueued')}
      </button>
        {!item.edit && <button disabled={disabled} onClick={() => void perform(key, remove)}>{t('chat.removeQueued')}</button>}
      </div>
    </>}
  </li>;
}

function QueuedPromptEditor({ sessionId, itemId, editId, initial, current, connected, disabled, perform, remove }: {
  sessionId: string; itemId: string; editId: string; initial: PromptInput; current: boolean; connected: boolean; disabled: boolean;
  perform: (action: () => Promise<unknown>) => void; remove: () => Promise<void>;
}) {
  const { t } = useTranslation('workspace');
  const [input, setInput] = useState(initial);
  const [draftError, setDraftError] = useState(false);
  const [leaseError, setLeaseError] = useState(false);
  const draft = useRef({ input: initial, revision: 0 });
  const savedRevision = useRef(0);
  const resolving = useRef(false);
  const issue = attachmentLimitIssue(input.attachments ?? []);
  const canSave = !disabled && !issue && hasPromptInput(input);
  const persist = useCallback(async () => {
    const current = draft.current;
    if (resolving.current || current.revision <= savedRevision.current) return;
    try {
      await window.workbench.saveQueuedPromptDraft(sessionId, itemId, editId, current.revision, current.input);
      savedRevision.current = Math.max(savedRevision.current, current.revision);
      if (current === draft.current) setDraftError(false);
    } catch {
      if (current === draft.current && savedRevision.current < current.revision) setDraftError(true);
    }
  }, [sessionId, itemId, editId]);
  useEffect(() => {
    if (!connected || !current) return;
    const timer = window.setTimeout(() => { void persist(); }, 250);
    return () => window.clearTimeout(timer);
  }, [input, connected, current, persist]);
  useEffect(() => {
    if (!connected || !current) return;
    return () => {
      const flush = persist();
      queueDraftFlushes.set(itemId, flush);
      void flush.finally(() => { if (queueDraftFlushes.get(itemId) === flush) queueDraftFlushes.delete(itemId); });
    };
  }, [connected, current, itemId, persist]);
  useEffect(() => {
    if (!connected || !current) return;
    let mounted = true;
    const renew = () => {
      if (resolving.current) return;
      void window.workbench.renewQueuedPromptEdit(sessionId, itemId, editId).then(
        () => { if (mounted) setLeaseError(false); },
        () => { if (mounted) setLeaseError(true); },
      );
    };
    renew();
    const timer = window.setInterval(renew, 10_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [connected, current, sessionId, itemId, editId]);
  const change = (next: PromptInput) => {
    draft.current = { input: next, revision: draft.current.revision + 1 };
    setInput(next);
  };
  const resolve = (action: () => Promise<unknown>) => {
    if (!current || disabled || resolving.current) return;
    resolving.current = true;
    perform(async () => {
      try { await action(); }
      catch (error) {
        resolving.current = false;
        void persist();
        throw error;
      }
    });
  };
  const finish = (value?: PromptInput) => resolve(() => window.workbench.finishQueuedPromptEdit(sessionId, itemId, editId, value));
  return <form onSubmit={event => {
    event.preventDefault();
    if (canSave) finish(promptCommandInput(input));
  }}>
    <textarea aria-label={t('chat.editQueued')} value={input.text} readOnly={!current || leaseError} disabled={current && disabled} rows={2} maxLength={PROMPT_TEXT_LIMIT}
      onChange={event => change({ ...input, text: event.target.value })} />
    <AttachmentChips attachments={input.attachments ?? []} onRemove={!current || disabled || leaseError ? undefined : id =>
      change({ ...input, attachments: input.attachments?.filter(attachment => attachment.id !== id) })} />
    <DraftEvidenceCards evidence={input.evidence} onRemove={disabled ? undefined : id =>
      change({ ...input, evidence: input.evidence?.filter(reference => reference.id !== id) })} />
    <AttachmentLimitNotice issue={issue} />
    {current && draftError && <p className="queue-edit-hold" role="alert">{t('chat.queueDraftUnsaved')}</p>}
    {current && leaseError && <p className="queue-edit-hold" role="alert">{t('chat.queueEditLeaseLost')}</p>}
    {current && <div className="queue-item-actions">
      <button type="submit" disabled={!canSave}>{t('chat.saveQueued')}</button>
      <button type="button" disabled={disabled} onClick={() => finish()}>{t('chat.cancelQueuedEdit')}</button>
      <button type="button" disabled={disabled} onClick={() => resolve(remove)}>{t('chat.removeQueued')}</button>
    </div>}
  </form>;
}

type DockSection = 'queue' | 'agents' | 'plan';

function ComposerDock({ session, provider, pending, perform, connected, active, children, openSession, openNativeAgent }: Pick<SessionChatProps, 'session' | 'provider' | 'pending' | 'perform' | 'openSession'> & {
  connected: boolean;
  active: boolean;
  children: Session[];
  openNativeAgent: (id: string, messageId: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const id = useId();
  const [selection, setSelection] = useState<DockSection | null>();
  const { plan, agents } = useMemo(() => session.composerActivity ?? sessionComposerActivity(session.messages), [session.composerActivity, session.messages]);
  const runningChildren = active ? children.filter(child => activeStatuses.has(child.status)) : [];
  const runningNative = active ? agents : [];
  const completedSteps = plan.filter(step => step.status === 'completed').length;
  const queueCount = session.queue?.length ?? 0;
  const agentCount = runningChildren.length + runningNative.length;
  const sections = [
    { id: 'queue', label: t('chat.queueTitle'), count: queueCount ? formatNumber(queueCount) : '', icon: <Clock3 size={14} /> },
    { id: 'agents', label: t('chat.dockAgents'), count: agentCount ? formatNumber(agentCount) : '', icon: <Users size={14} /> },
    { id: 'plan', label: t('chat.dockPlan'), count: plan.length ? `${formatNumber(completedSteps)}/${formatNumber(plan.length)}` : '', icon: <ListChecks size={14} /> },
  ] as const;
  const available = sections.filter(section => section.count);
  if (!available.length) return null;
  const initialSection = queueCount ? 'queue' : active && completedSteps < plan.length ? 'plan' : null;
  const selected = selection === null || available.some(section => section.id === selection) ? selection : initialSection;
  const content: Record<DockSection, ReactNode> = {
    queue: <PromptQueue session={session} provider={provider} pending={pending} perform={perform} connected={connected} />,
    agents: <ul className="composer-dock-list">
      {runningChildren.map(child => <li key={child.id}><button onClick={() => openSession(child.id)}><span>{child.title}</span><ArrowUpLeft size={12} /></button><Status value={child.status} /></li>)}
      {runningNative.map(({ id, nativeId, messageId, title, status }) => <li key={id}>
        {nativeId ? <button disabled={!connected} onClick={() => openNativeAgent(nativeId, messageId)}><span>{title}</span><ArrowUpLeft size={12} /></button> : <span>{title}</span>}
        <Status value={status} />
      </li>)}
    </ul>,
    plan: <ol className="composer-dock-list">
      {plan.map((step, index) => <li key={index}><Status value={step.status} /><span>{step.text}</span></li>)}
    </ol>,
  };
  return <section className="composer-dock" aria-label={t('chat.dockTitle')}>
    <div className="composer-dock-controls">{available.map(section => <button key={section.id} type="button"
      id={`${id}-${section.id}-trigger`} aria-expanded={selected === section.id} aria-controls={`${id}-${section.id}`}
      onClick={() => setSelection(selected === section.id ? null : section.id)}>
      {section.icon}<span>{section.label}</span><RollingText className="composer-dock-count" value={section.count} animate={connected} />
    </button>)}</div>
    {available.map(section => <CollapsibleRegion key={section.id} expanded={selected === section.id} id={`${id}-${section.id}`} onClose={() => {
      setSelection(null);
      document.getElementById(`${id}-${section.id}-trigger`)?.focus();
    }}>{content[section.id]}</CollapsibleRegion>)}
  </section>;
}

function ActivityEntries({ messages }: { messages: IndexedMessages }) {
  const { t } = useTranslation('workspace');
  const scroll = useRef<HTMLDivElement>(null);
  const source = useRef(messages);
  source.current = messages;
  const getItemKey = useCallback((index: number) => source.current.at(index)!.id, [messages.structure]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length, getScrollElement: () => scroll.current, getItemKey, estimateSize: () => 56, overscan: 3,
  });
  return <div className="activity-entries" ref={scroll}>
    {messages.length ? <div className="virtual-conversation" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(item => {
        const message = messages.at(item.index)!;
        return <div className="virtual-conversation-row" key={item.key} data-index={item.index} ref={virtualizer.measureElement}
          style={{ transform: `translateY(${item.start}px)` }}>
          <div className="activity-entry"><span className="activity-dot" /><p>{message.text}</p>
            <time dateTime={message.createdAt}>{formatDate(message.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          </div>
        </div>;
      })}
    </div> : <p className="pane-note">{t('chat.activityEmpty')}</p>}
  </div>;
}

interface TraceChoice { expanded: boolean; tailAnchor?: string }
interface TraceChoices {
  groups: ReadonlyMap<string, TraceChoice>;
  events: ReadonlySet<string>;
}
const traceChoicesBySession = new Map<string, TraceChoices>();

export function SessionChat({
  session, provider, providers, perform, pending, draft, draftError, onDraftChange, sessions = [], openSession, connected = true, readOnly = false,
  attentionOpen, onAttentionOpened, messageOpen, onMessageOpened, onOpenForkSource, workspaceId, onChooseEvidence, onOpenEvidence,
}: SessionChatProps) {
  const { t } = useTranslation('workspace');
  const [showActivity, setShowActivity] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchResult, setSearchResult] = useState<{ sessionId: string; query: string; messages: Message[]; truncated: boolean }>();
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ id: string; attention?: boolean }>();
  const [inspectedMessageId, setInspectedMessageId] = useState<string>();
  const [sideQuestion, setSideQuestion] = useState<SideQuestionOrigin>();
  const [sideQuestionJump, setSideQuestionJump] = useState<string>();
  const [attentionNotice, setAttentionNotice] = useState<'approval' | 'message'>();
  const attentionLookup = useRef<SessionAttentionOpen>(undefined);
  const latestAttention = useRef(attentionOpen);
  latestAttention.current = attentionOpen;
  const handledAttention = useRef<SessionAttentionOpen>(undefined);
  const [sendError, setSendError] = useState<{ message: string; rejected: boolean }>();
  const [readingAnchor, setReadingAnchor] = useReadingAnchor(session.id);
  const [restoredTrace, setRestoredTrace] = useState(readingAnchor?.kind === 'event' ? readingAnchor : undefined);
  const finishReadingRestore = useCallback(() => setReadingAnchor(undefined), [setReadingAnchor]);
  const [traceChoices, setTraceChoices] = useState<TraceChoices>(() => traceChoicesBySession.get(session.id) ?? {
    groups: new Map(), events: new Set(),
  });
  const [revealedMatch, setRevealedMatch] = useState<{ id: string; detail: boolean }>();
  const saveTraceChoices = useCallback((choices: TraceChoices) => {
    traceChoicesBySession.set(session.id, choices);
    setTraceChoices(choices);
  }, [session.id]);
  const attachments = draft.attachments ?? [];
  const attachmentIssue = attachmentLimitIssue(attachments);
  const promptLengthIssue = Boolean(draft.evidence?.length && draftPromptText(draft).length > PROMPT_TEXT_LIMIT);
  const [attachmentError, setAttachmentError] = useState('');
  const [importingAttachments, setImportingAttachments] = useState(false);
  const supportsAttachment = (kind: PromptAttachment['kind']) => supportsPromptAttachment(provider, kind);
  const attachmentsSupported = supportsAttachment('image') || supportsAttachment('text');
  const unsupportedAttachments = attachments.some(attachment => !supportsAttachment(attachment.kind));
  const [rewindMessage, setRewindMessage] = useState<string>();
  const [nativeAgentId, setNativeAgentId] = useState<string>();
  const [loadedNativeEvents, setLoadedNativeEvents] = useState<{ id: string; events: ProcessEvent[] }>();
  const composing = useRef(false);
  const sendLock = useRef(false);
  const attachmentLock = useRef(false);
  const currentDraft = useRef(draft);
  const composer = useRef<HTMLTextAreaElement>(null);
  const changeComposerText = (value: string) => onDraftChange({ ...currentDraft.current, text: value });
  const fileMention = useWorkspaceFileMention(workspaceId, changeComposerText);
  const reducedMotion = useReducedMotion();
  const activityId = useId();
  const activityRegion = useRef<HTMLDivElement>(null);
  const nativeScrollPositions = useRef(new Map<string, Map<string, { top: number; left: number }>>());
  const nativeDetails = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = nativeDetails.current;
    if (!element || !nativeAgentId) return;
    const positions = nativeScrollPositions.current.get(nativeAgentId);
    const elements = [element, ...element.querySelectorAll<HTMLElement>('[data-scroll-key]')];
    for (const target of elements) {
      const position = positions?.get(target.dataset.scrollKey ?? 'list');
      if (position) { target.scrollTop = position.top; target.scrollLeft = position.left; }
    }
  }, [nativeAgentId]);
  const transition = reducedMotion ? { duration: 0 } : SPRING_SNAPPY;
  currentDraft.current = draft;

  const active = activeStatuses.has(session.status);
  const historyReady = session.historyLoaded !== false;
  const queuesNextTurn = active || session.queuePaused || Boolean(session.queue?.length);
  const canAskSideQuestion = !readOnly && !session.archived && connected && historyReady && Boolean(provider?.available);
  const busy = pending.has(`send-${session.id}`);
  const settingsBusy = pending.has(`session-settings-${session.id}`);
  const history = useSessionHistory(session);
  const messages = history.messages;
  const activity = history.activities;
  const conversation = history.conversation;
  const observedInsertions = useRef(history.addedEvents);
  const addedEvents = observedInsertions.current === history.addedEvents ? undefined : history.addedEvents;
  useLayoutEffect(() => { observedInsertions.current = history.addedEvents; }, [history.addedEvents]);
  const tail = conversation.at(conversation.length - 1);
  const liveTrace = tail?.kind === 'trace' && connected && session.status !== 'queued' && active && historyReady && !history.showingHistory ? tail : undefined;
  const liveTraceRow = liveTrace ? conversation.length - 1 : -1;
  let addedToLiveTrace = 0;
  for (let index = messages.length - 1; liveTrace && index >= liveTrace.start && addedEvents?.has(messages.at(index)!.id); index--) addedToLiveTrace++;
  const searchQuery = find?.trim() ?? '';
  const matches = searchQuery && searchResult?.sessionId === session.id && searchResult.query === searchQuery ? searchResult.messages : [];
  const selectedMatch = matches[matchIndex % Math.max(matches.length, 1)];
  const revealedMatchId = selectedMatch?.id === revealedMatch?.id ? revealedMatch?.id : undefined;
  const restoredTraceId = restoredTrace?.id;
  const traceChoiceIndex = useCallback((anchor: string, choice: TraceChoice) => {
    const index = messages.indexOf(anchor);
    return index < 0 && choice.tailAnchor ? messages.indexOf(choice.tailAnchor) : index;
  }, [messages]);
  const { chatRows, carriedChoice } = useMemo(() => {
    const open = new Set<number>();
    let carriedChoice: { anchor: string; choice: TraceChoice } | undefined;
    const liveTailStart = history.liveTailStart;
    if (liveTraceRow >= 0) open.add(liveTraceRow);
    for (const [anchor, choice] of traceChoices.groups) {
      const row = conversation.rowOfMessage(traceChoiceIndex(anchor, choice));
      const trace = conversation.at(row);
      if (trace?.kind !== 'trace') continue;
      if (choice.expanded) open.add(row); else open.delete(row);
      const end = trace.start + trace.length - 1;
      // Keep a known id in the bounded live tail when the original anchor spills into older pages.
      if (trace.start < liveTailStart && end >= liveTailStart && messages.indexOf(choice.tailAnchor ?? anchor) < liveTailStart) {
        carriedChoice = { anchor, choice: { ...choice, tailAnchor: messages.at(end)!.id } };
      }
    }
    for (const id of [revealedMatchId, restoredTraceId]) {
      if (!id) continue;
      const row = conversation.rowOfMessage(messages.indexOf(id));
      if (conversation.at(row)?.kind === 'trace') open.add(row);
    }
    return { chatRows: expandConversation(conversation, open, index => messages.at(index)!.id), carriedChoice };
  }, [conversation, messages, history.liveTailStart, liveTraceRow, traceChoices.groups, traceChoiceIndex, revealedMatchId, restoredTraceId]);

  useLayoutEffect(() => {
    if (!carriedChoice) return;
    const groups = new Map(traceChoices.groups);
    groups.set(carriedChoice.anchor, carriedChoice.choice);
    saveTraceChoices({ ...traceChoices, groups });
  }, [carriedChoice, saveTraceChoices, traceChoices]);

  const chooseTrace = (trace: TraceEntry, expanded: boolean, events = traceChoices.events) => {
    cancelReadingRestore();
    const groups = new Map(traceChoices.groups);
    for (const [anchor, choice] of groups) {
      const index = traceChoiceIndex(anchor, choice);
      if (index >= trace.start && index < trace.start + trace.length) groups.delete(anchor);
    }
    const anchor = trace.key.slice('trace:'.length);
    groups.set(anchor, { expanded, tailAnchor: messages.at(trace.start + trace.length - 1)?.id });
    if (!expanded && revealedMatchId) {
      const index = messages.indexOf(revealedMatchId);
      if (index >= trace.start && index < trace.start + trace.length) setRevealedMatch(undefined);
    }
    if (!expanded && restoredTraceId) {
      const index = messages.indexOf(restoredTraceId);
      if (index >= trace.start && index < trace.start + trace.length) setRestoredTrace(undefined);
    }
    saveTraceChoices({ groups, events });
  };
  const chooseEvent = (trace: TraceEntry, id: string, expanded: boolean) => {
    cancelReadingRestore();
    pauseForNavigation();
    const events = new Set(traceChoices.events);
    if (expanded) {
      events.add(id);
      chooseTrace(trace, true, events);
      return;
    }
    events.delete(id);
    if (revealedMatchId === id) setRevealedMatch({ id, detail: false });
    if (restoredTrace?.id === id && restoredTrace.detailsOpen) setRestoredTrace({ ...restoredTrace, detailsOpen: false });
    saveTraceChoices({ ...traceChoices, events });
  };
  const children = sessions.filter(item => item.parentSessionId === session.id);
  const parent = sessions.find(item => item.id === session.parentSessionId);
  const currentNativeEvents = nativeAgentId ? history.eventsFor(nativeAgentId) : [];
  const nativeEvents = currentNativeEvents.some(event => event.kind === 'subagent' && event.nativeId === nativeAgentId)
    ? currentNativeEvents : loadedNativeEvents?.id === nativeAgentId ? loadedNativeEvents?.events ?? [] : [];
  const nativeAgent = nativeEvents.find(event => event.kind === 'subagent' && event.nativeId === nativeAgentId);
  const openDockAgent = (id: string, messageId: string) => {
    setNativeAgentId(id);
    if (history.eventsFor(id).some(event => event.kind === 'subagent' && event.nativeId === id)) return;
    void perform(`dock-agent-${id}`, async () => {
      const { messages } = await window.workbench.sessionHistoryAround(session.id, messageId, 100);
      const events = messages.flatMap(({ event }) => event && (event.nativeId === id || event.parentId === id) ? [event] : []);
      if (!events.some(event => event.kind === 'subagent' && event.nativeId === id)) throw new Error(t('chat.dockAgentMissing'));
      setLoadedNativeEvents({ id, events });
    });
  };
  const virtualScroll = useRef<{ scrollToEnd(options: { behavior: 'smooth' | 'auto' }): void } | null>(null);
  const { containerRef: scroll, isPinned, isFollowingOutput, showJumpControl, markUserInput, pauseForNavigation, handleScroll, scrollToBottom } =
    useClaudeScrollPinning([session.id, history.showingHistory ? null : history.messages,
      history.showingHistory ? null : session.approvals, history.showingHistory ? null : session.status,
      history.showingHistory ? null : session.error], smooth => virtualScroll.current?.scrollToEnd({ behavior: smooth ? 'smooth' : 'auto' }), !readingAnchor);
  const inspectMessage = (id: string, attention = false) => {
    setRestoredTrace(undefined);
    pauseForNavigation();
    const trace = conversation.at(conversation.rowOfMessage(messages.indexOf(id)));
    if (trace?.kind === 'trace') chooseTrace(trace, true);
    setInspectedMessageId(id);
    setScrollTarget({ id, attention });
  };
  const answerReference = useAnswerQuestionSelection(scroll, canAskSideQuestion || Boolean(onChooseEvidence));
  const quoteMessage = (message: Message, label: string, excerpt: string) => onChooseEvidence?.({
    id: crypto.randomUUID(), label: label.slice(0, 300), excerpt: excerpt.slice(0, EVIDENCE_EXCERPT_LIMIT),
    source: { kind: 'message', sessionId: session.id, messageId: message.id },
  });
  const openSideQuestion = (origin: SideQuestionOrigin) => setSideQuestion(current => current ?? origin);
  const closeSideQuestion = () => {
    setSideQuestion(undefined);
    const original = sideQuestion?.trigger;
    const current = sideQuestion && scroll.current?.querySelector<HTMLButtonElement>(
      `[data-message-id="${CSS.escape(sideQuestion.reference.messageId)}"] .side-question-trigger`);
    (original?.isConnected ? original : current ?? scroll.current)?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!sideQuestionJump || messages.indexOf(sideQuestionJump) < 0) return;
    inspectMessage(sideQuestionJump);
    setSideQuestionJump(undefined);
  }, [messages, sideQuestionJump]);
  const rowCount = chatRows.length + 1;
  const rowSource = useRef(chatRows);
  rowSource.current = chatRows;
  const getItemKey = useCallback((index: number) => rowSource.current.at(index)?.key
    ?? 'conversation-notices', [messages.structure, chatRows.expansionKey]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    getScrollElement: () => scroll.current,
    getItemKey,
    measureElement: measureConversationRow,
    estimateSize: index => {
      const row = chatRows.at(index);
      if (!row) return 80 + session.approvals.length * 240;
      if (row.kind === 'trace') return 42;
      if (row.kind === 'event') return 35;
      return Math.min(1000, 100 + Math.ceil(messages.at(row.start)!.text.length / 100) * 22);
    },
    overscan: 5,
    paddingStart: 20,
    rangeExtractor: range => {
      const indices = defaultRangeExtractor(range);
      if (!indices.includes(rowCount - 1)) indices.push(rowCount - 1);
      return indices;
    },
    anchorTo: 'end',
    followOnAppend: false,
    // When detail navigation pauses following, row expansion should leave the viewport in place.
    scrollEndThreshold: isPinned ? 40 : -1,
  });
  virtualScroll.current = virtualizer;
  const followLatestAfterMissingAnchor = useCallback(() => {
    setRestoredTrace(undefined);
    scrollToBottom();
  }, [scrollToBottom]);
  const { cancelRestore: cancelReadingRestore, capture: captureReadingPosition } = useSessionReadingPosition({
    sessionId: session.id, virtualizer, anchor: readingAnchor, finish: finishReadingRestore,
    index: readingAnchor ? chatRows.rowOfMessage(messages.indexOf(readingAnchor.id), readingAnchor.kind === 'trace') : -1,
    ready: history.tailReady, connected, showingHistory: history.showingHistory, isFollowingOutput,
    identifyRow(index) {
      const row = chatRows.at(index);
      const message = row && messages.at(row.start);
      if (row && message) return { id: message.id, kind: row.kind };
    },
    locate: history.locateMessage, cancelLookup: history.cancelJump, followLatest: followLatestAfterMissingAnchor,
  });
  const markReadingInput = () => { cancelReadingRestore(); markUserInput(); };
  const closeFind = () => { history.cancelJump(); setScrollTarget(undefined); setRevealedMatch(undefined); setFind(null); };
  const locateSideQuestionSource = async (id: string) => {
    closeFind();
    cancelReadingRestore();
    if (!await history.locateMessage(id, false)) return false;
    setSideQuestionJump(id);
    return true;
  };
  useEffect(() => {
    if (!messageOpen || !connected || !history.tailReady) return;
    let active = true;
    closeFind();
    cancelReadingRestore();
    void history.locateMessage(messageOpen.messageId, false).then(found => {
      if (!active) return;
      if (found) {
        setSideQuestionJump(messageOpen.messageId);
        scroll.current?.focus({ preventScroll: true });
      } else void perform('open-source-message', async () => { throw new Error(t('chat.sourceMessageMissing')); });
      onMessageOpened?.(messageOpen);
    });
    return () => { active = false; };
  }, [messageOpen, connected, history.tailReady]);
  const showLatestOutput = (smooth = false) => {
    cancelReadingRestore();
    setRestoredTrace(undefined);
    setInspectedMessageId(undefined);
    closeFind();
    history.showLatest();
    scrollToBottom(smooth);
  };
  const moveMatch = (direction: number) => {
    if (!matches.length) return;
    history.cancelJump();
    setScrollTarget(undefined);
    setMatchIndex(value => (value + direction + matches.length) % matches.length);
  };

  useEffect(() => {
    if (!searchQuery) { setSearching(false); setSearchError(''); return; }
    let active = true;
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(() => {
      void window.workbench.sessionSearch(session.id, searchQuery, 200).then(result => {
        if (active) setSearchResult({ sessionId: session.id, query: searchQuery, ...result });
      }, error => { if (active) setSearchError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (active) setSearching(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [session.id, searchQuery]);

  useEffect(() => {
    if (!selectedMatch) return;
    let active = true;
    cancelReadingRestore();
    setRestoredTrace(undefined);
    pauseForNavigation();
    void history.locateMessage(selectedMatch.id).then(found => {
      if (active && found) {
        setRevealedMatch({ id: selectedMatch.id, detail: true });
        setInspectedMessageId(undefined);
        setScrollTarget({ id: selectedMatch.id });
      }
    });
    return () => { active = false; history.cancelJump(); };
  }, [session.id, selectedMatch?.id, history.cancelJump, cancelReadingRestore, pauseForNavigation]);

  useLayoutEffect(() => {
    if (!attentionOpen || attentionOpen === handledAttention.current) return;
    cancelReadingRestore();
    if (!history.tailReady) return;

    const finish = () => {
      handledAttention.current = attentionOpen;
      onAttentionOpened?.(attentionOpen);
    };
    if (attentionOpen.reason !== 'approval' && attentionOpen.messageId) {
      const id = attentionOpen.messageId;
      if (messages.indexOf(id) >= 0) {
        setAttentionNotice(undefined);
        inspectMessage(id, true);
        finish();
      } else if (attentionLookup.current !== attentionOpen) {
        attentionLookup.current = attentionOpen;
        closeFind();
        void history.locateMessage(id, false).then(found => {
          if (!found && latestAttention.current === attentionOpen) {
            setAttentionNotice('message');
            finish();
          }
        });
      }
      return;
    }
    if (history.showingHistory) { closeFind(); history.showLatest(); return; }
    if (attentionOpen.reason === 'approval') {
      const approval = attentionOpen.approvalId
        ? session.approvals.find(item => item.id === attentionOpen.approvalId)
        : session.approvals.at(-1);
      if (approval) {
        const viewport = scroll.current;
        const card = viewport?.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(approval.id)}"]`);
        if (!viewport || !card) return;
        pauseForNavigation();
        markUserInput();
        virtualizer.scrollToOffset(viewport.scrollTop + card.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12);
        card.focus({ preventScroll: true });
        setAttentionNotice(undefined);
        handleScroll();
        finish();
        return;
      }
    } else if (session.attention?.revision === attentionOpen.revision) {
      const target = sessionAttentionMessage(session, attentionOpen.reason);
      if (target && messages.indexOf(target.id) >= 0) {
        inspectMessage(target.id, true);
        finish();
        return;
      }
    }
    if (attentionOpen.reason === 'approval' && attentionOpen.approvalId) setAttentionNotice('approval');
    showLatestOutput();
    finish();
  });

  useLayoutEffect(() => {
    if (!scrollTarget) return;
    const index = chatRows.rowOfMessage(messages.indexOf(scrollTarget.id));
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' });
    const frame = requestAnimationFrame(() => {
      if (scrollTarget.attention) markUserInput();
      handleScroll();
      setScrollTarget(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget, chatRows, messages]);

  const seenInFlight = useRef<number | undefined>(undefined);
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  useEffect(() => {
    const update = () => setVisibilityRevision(value => value + 1);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    const revision = session.attention?.revision;
    if (attentionOpen || !revision || !sessionIsUnread(session) || !connected || !isPinned || history.showingHistory || history.waitingForTail || seenInFlight.current === revision) return;
    const frame = requestAnimationFrame(() => {
      const element = scroll.current;
      if (!element || document.visibilityState !== 'visible' || !document.hasFocus() || element.clientHeight <= 0
        || element.scrollHeight - element.scrollTop - element.clientHeight > 40) return;
      seenInFlight.current = revision;
      void window.workbench.markSessionSeen(session.id, revision).catch(() => { seenInFlight.current = undefined; });
    });
    return () => cancelAnimationFrame(frame);
  }, [attentionOpen, session.attention?.revision, session.attention?.seenRevision, connected, isPinned, history.showingHistory, history.waitingForTail, visibilityRevision, messages, virtualizer.getTotalSize()]);

  useEffect(() => {
    if (!showActivity) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest('button')?.getAttribute('aria-controls');
      if (showActivity && control !== activityId && !activityRegion.current?.contains(event.target)) setShowActivity(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [showActivity, activityId]);

  const send = () => {
    if (readOnly || !hasPromptInput(draft) || unsupportedAttachments || attachmentIssue || promptLengthIssue
      || !connected || !historyReady || busy || settingsBusy || sendLock.current || attachmentLock.current || !provider?.available) return;
    sendLock.current = true;
    setSendError(undefined);
    void perform(`send-${session.id}`, async () => {
      try {
        const input = promptCommandInput(draft);
        await runSessionCommand(`send:${session.id}`, input, async commandId => {
          const result = await window.workbench.sendPrompt(session.id, input, commandId);
          if (result?.rejected === 'workspace-unavailable') {
            const error = new SessionCommandRejectedError(t('chat.workspaceUnavailable'));
            setSendError({ message: error.message, rejected: true });
            throw error;
          }
          if (currentDraft.current === draft) { setSendError(undefined); onDraftChange({ text: '' }, draft); }
          cancelReadingRestore();
          setRestoredTrace(undefined);
          history.showLatest();
          scrollToBottom();
        });
      } catch (error) {
        setSendError({ message: error instanceof Error ? error.message : String(error), rejected: error instanceof SessionCommandRejectedError });
        throw error;
      } finally {
        sendLock.current = false;
      }
    });
  };

  const importAttachments = (load: () => Promise<PromptAttachment[]>, source: 'picker' | 'clipboard') => {
    if (attachmentLock.current || sendLock.current) return;
    attachmentLock.current = true;
    setImportingAttachments(true);
    setAttachmentError('');
    void (async () => {
      try {
        const selected = await load();
        if (!selected.length) return;
        const current = currentDraft.current;
        const next = [...(current.attachments ?? []), ...selected];
        if (source === 'clipboard' && attachmentLimitIssue(next)) throw new Error(t('evidence.pasteLimit'));
        onDraftChange({ ...current, attachments: next }, current);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : String(error));
      } finally {
        attachmentLock.current = false;
        setImportingAttachments(false);
      }
    })();
  };

  return <section data-chat-session-id={session.id} className={`chat-pane${readOnly ? ' chat-pane-readonly' : ''}`} aria-label={session.title}>
    <header className="chat-toolbar">
      <div className="chat-toolbar-heading">
        <MessageCircle size={14} /><h2 title={session.title}>{session.title}</h2>
      </div>
      <Status value={session.status} />
      <div className="chat-toolbar-actions">
        {session.forkedFrom && onOpenForkSource && <IconButton label={t('chat.forkSource')} disabled={!connected}
          onClick={() => onOpenForkSource(session.forkedFrom!.sessionId, session.forkedFrom!.messageId)}><GitFork size={14} /></IconButton>}
        {!readOnly && providers && <SessionContinuation session={session} providers={providers} connected={connected} perform={perform} />}
        <IconButton label={find === null ? t('chat.find') : t('chat.closeFind')} aria-pressed={find !== null}
          onClick={() => {
            if (find === null) { cancelReadingRestore(); setFind(''); }
            else closeFind();
          }}><Search size={15} /></IconButton>
        <Tooltip label={t('chat.activity')}><button className={`text-button chat-activity-button ${showActivity ? 'selected' : ''}`} aria-label={t('chat.activity')}
          aria-expanded={showActivity} aria-controls={activityId} onClick={() => setShowActivity(value => !value)}>
          <Activity size={14} /><span className="chat-activity-label">{t('chat.activity')}</span>{activity.length > 0 && <RollingText className="chat-count" value={formatNumber(activity.length)} animate={active && !history.showingHistory} />}
        </button></Tooltip>
        {!readOnly && active && <button className="text-button stop-action" disabled={!connected || pending.has(`cancel-${session.id}`)}
          onClick={() => void perform(`cancel-${session.id}`, () => runSessionStopCommand(session,
            (commandId, expectedAttemptId) => window.workbench.cancelSession(session.id, commandId, expectedAttemptId)))}>
          <CircleStop size={14} />{t('common.stop')}</button>}
      </div>
    </header>

    <AnimatePresence initial={false}>
      {find !== null && <motion.div className="chat-reveal" key="find" initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={transition}>
        <div className="conversation-find">
          <Search size={15} />
          <input aria-label={t('chat.find')} value={find} autoFocus placeholder={t('chat.findPlaceholder')}
            onChange={event => { history.cancelJump(); setScrollTarget(undefined); setFind(event.target.value); setMatchIndex(0); }}
            onKeyDown={event => {
              if (event.key === 'Escape') closeFind();
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229 && matches.length) {
                moveMatch(event.shiftKey ? -1 : 1);
              }
            }} />
          <small aria-live="polite">{searching ? <LoaderCircle className="spin" size={12} /> : matches.length ? `${matchIndex % matches.length + 1} / ${matches.length}${searchResult?.query === searchQuery && searchResult.truncated ? '+' : ''}` : '0'}</small>
          <IconButton label={t('chat.previousMatch')} disabled={!matches.length}
            onClick={() => moveMatch(-1)}><ArrowUp size={14} /></IconButton>
          <IconButton label={t('chat.nextMatch')} disabled={!matches.length}
            onClick={() => moveMatch(1)}><ArrowDown size={14} /></IconButton>
          <IconButton label={t('chat.closeFind')} onClick={closeFind}><X size={14} /></IconButton>
        </div>
        {searchError && <p className="chat-history-error" role="alert">{searchError}</p>}
      </motion.div>}
    </AnimatePresence>

    {attentionNotice && <p className="pane-note" role="status">
      {t(attentionNotice === 'approval' ? 'chat.attentionApprovalEnded' : 'chat.attentionMessageMissing')}
    </p>}
    {(parent || children.length > 0) && <nav className="session-children" aria-label={t('chat.relatedSessions')}>
      {parent && <button onClick={() => openSession(parent.id)}><ArrowUpLeft size={13} />{t('chat.coordinator', { title: parent.title })}</button>}
      {children.map(child => <button key={child.id} onClick={() => openSession(child.id)}>
        <GitFork size={13} /><span>{child.title}</span><small>{child.providerId}</small><Status value={child.status} />
      </button>)}
    </nav>}
    {(!historyReady || history.hasMore || history.showingHistory || history.loading || history.error) && <div className="conversation-history-controls">
      {!historyReady && <span role="status">{t('chat.loadingHistory')}</span>}
      {history.hasMore && <button disabled={history.loading || !connected} onClick={() => { markReadingInput(); void history.loadOlder(); }}>
        {history.loading ? <LoaderCircle className="spin" size={12} /> : <ArrowUp size={12} />}{t('chat.loadEarlier')}
      </button>}
      {history.showingHistory && <><span>{t('chat.historyWindow')}</span>
        {history.hasAfter && <button disabled={history.loading || !connected} onClick={() => { cancelReadingRestore(); void history.loadNewer(); }}><ArrowDown size={12} />{t('chat.loadLater')}</button>}
        <button onClick={() => showLatestOutput()}><ArrowDown size={12} />{t('chat.returnLatest')}</button></>}
      {history.error && <span className="chat-history-error" role="alert">{history.error}</span>}
    </div>}
    <div className="message-scroll" ref={scroll} tabIndex={0} aria-label={t('chat.conversation')}
      onScroll={event => { handleScroll(); captureReadingPosition(event.currentTarget); }} onWheel={markReadingInput} onTouchStart={markReadingInput}
      onPointerDown={event => { if (event.target === event.currentTarget) markReadingInput(); }}
      onKeyDown={event => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          && event.target instanceof HTMLElement && !event.target.closest('input, textarea, select, [contenteditable="true"]')) markReadingInput();
      }}>
      <div className="virtual-conversation" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const row = chatRows.at(item.index);
          const message = row?.kind === 'message' || row?.kind === 'event' ? messages.at(row.start) : undefined;
          return <div className="virtual-conversation-row" data-index={item.index} key={item.key} ref={virtualizer.measureElement}
            style={{ transform: `translateY(${item.start}px)` }}>
          {row?.kind === 'trace' ? <TraceHeading trace={row} live={row.key === liveTrace?.key}
            addedEvents={addedToLiveTrace} expanded={chatRows.at(item.index + 1)?.kind === 'event'}
            onToggle={expanded => chooseTrace(row, expanded)} onInspect={inspectMessage} />
        : row?.kind === 'event' && message?.event ? <TraceEventRow message={message} event={message.event}
            end={row.start === row.trace.start + row.trace.length - 1}
            entering={row.trace.key === liveTrace?.key && Boolean(addedEvents?.has(message.id))}
            matched={selectedMatch?.id === message.id || inspectedMessageId === message.id}
            expanded={traceChoices.events.has(message.id) || (revealedMatchId === message.id && Boolean(revealedMatch?.detail))
              || (restoredTraceId === message.id && Boolean(restoredTrace?.detailsOpen)) || inspectedMessageId === message.id}
            onExpandedChange={expanded => {
              if (!expanded && inspectedMessageId === message.id) setInspectedMessageId(undefined);
              chooseEvent(row.trace, message.id, expanded);
            }} openSession={openSession} openNativeAgent={setNativeAgentId}
            onAsk={canAskSideQuestion && message.event.title.trim() ? trigger => openSideQuestion({
              reference: { kind: 'trace', messageId: message.id }, excerpt: questionExcerpt(message.event!.title), trigger,
            }) : undefined}
            onQuote={onChooseEvidence && message.event.status === 'failed' && message.event.output?.trim() ? () =>
              quoteMessage(message, `${session.title} · ${message.event!.title}`, message.event!.output!.trim()) : undefined} />
        : message ? <div className="messages"><article data-message-id={message.id}
              className={`message message-${message.role}${selectedMatch?.id === message.id || inspectedMessageId === message.id ? ' conversation-match' : ''}`}>
              {message.role === 'user'
                  ? <>
                    <div className="user-message">{message.originalPrompt ?? message.text}
                      {message.attachments && <AttachmentChips attachments={message.attachments} />}
                      <DraftEvidenceCards evidence={message.evidence} onOpen={onOpenEvidence} />
                    </div>
                    <DeliveryState message={message} sessionId={session.id} connected={connected} readOnly={readOnly} pending={pending} perform={perform} />
                    {!readOnly && !active && provider?.capabilities.rewind && message.nativeTurnId && <div className="message-tools">
                      <button onClick={() => setRewindMessage(message.id)}><ArrowUpLeft size={12} />{t('chat.rewindBefore')}</button>
                    </div>}
                  </>
                  : <>
                    <div className="assistant-heading">
                      <span className="assistant-symbol"><PanelsTopLeft size={13} /></span>
                      <strong>{provider?.name ?? session.providerId}</strong>
                      <time dateTime={message.createdAt}>{formatDate(message.createdAt, { hour: '2-digit', minute: '2-digit' })}</time>
                    </div>
                    <div className="markdown-message">
                      <MarkdownAnswer text={message.text} />
                      {!message.text && active && <span className="stream-cursor" />}
                    </div>
                    <div className="message-tools">
                      <CopyAnswer message={message} perform={perform} />
                      {answerReference?.messageId === message.id && <>
                        {canAskSideQuestion && <SideQuestionAction onClick={trigger => openSideQuestion({ reference: answerReference, excerpt: answerReference.excerpt, trigger })} />}
                        {onChooseEvidence && <button type="button" onMouseDown={event => event.preventDefault()}
                          onClick={() => quoteMessage(message, t('evidence.replySource', { title: session.title }), answerReference.excerpt)}>
                          <FileText size={12} />{t('evidence.quoteReply')}
                        </button>}
                      </>}
                      {!readOnly && message.text.trim() && <button title={t('chat.forkHereHint')} disabled={!connected || pending.has(`fork-${session.id}`)}
                        onClick={() => void perform(`fork-${session.id}`, () => window.workbench.forkSession(session.id, message.id, true))}>
                        <GitFork size={12} />{t('chat.forkHere')}</button>}
                    </div>
                  </>}
            </article></div>
        : <div className="conversation-notices">
        {!history.showingHistory && <SessionProgress status={session.status} />}
        {!history.showingHistory && session.error && <div className="inline-error" role="alert"><CircleAlert size={15} /><span>{session.error}</span></div>}
        {history.showingHistory && session.approvals.length > 0 && <p className="pane-note">{t('chat.currentApprovals')}</p>}
        <AnimatePresence initial={false}>
          {session.approvals.map(approval => <motion.div key={approval.id}
            tabIndex={-1} data-approval-id={approval.id} role="group"
            aria-label={renderDisplayText(approval.title || t('approval.answerTitle'), approval.titleI18n)}
            initial={reducedMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }} transition={transition}>
            <fieldset className="approval-availability" disabled={readOnly || !connected}><ApprovalCard approval={approval} pending={pending} perform={perform} /></fieldset>
          </motion.div>)}
        </AnimatePresence>
        </div>}
          </div>;
        })}
      </div>
    </div>

    <div className="chat-bottom">
      <AnimatePresence initial={false}>
        {showJumpControl && <motion.div className="jump-to-bottom-anchor" key="jump" initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={transition}>
          <button className="jump-to-bottom" onClick={() => showLatestOutput(!reducedMotion)}><ArrowDown size={14} />{t('chat.latestOutput')}</button>
        </motion.div>}
      </AnimatePresence>
      <CollapsibleRegion expanded={showActivity} id={activityId} className="chat-activity-region"
        regionRef={activityRegion} onClose={() => setShowActivity(false)}>
        <section className="activity-drawer">
          <header><span><Activity size={14} />{t('chat.activityLog')}<small>{activity.length}</small></span>
            <IconButton label={t('chat.closeActivity')} onClick={() => setShowActivity(false)}><ChevronDown size={15} /></IconButton>
          </header>
          {showActivity && <ActivityEntries messages={activity} />}
        </section>
      </CollapsibleRegion>
      {!readOnly && <div className="composer-area">
        <WorkspaceFileMention mention={fileMention} onPick={file => { if (composer.current) fileMention.insert(composer.current, file); }} />
        <div className="composer-frame">
          {historyReady && <ComposerDock session={session} provider={provider} pending={pending} perform={perform}
            connected={connected} active={active} children={children} openSession={openSession} openNativeAgent={openDockAgent} />}
        <div className={`composer${active ? ' composer-task-active' : ''}`}>
          <DraftEvidenceCards evidence={draft.evidence} onOpen={onOpenEvidence}
            onRemove={busy || !historyReady ? undefined : id => {
              const current = currentDraft.current;
              onDraftChange({ ...current, evidence: current.evidence?.filter(item => item.id !== id) });
            }} />
          <AttachmentChips attachments={attachments}
            onRemove={busy || !historyReady ? undefined : id => onDraftChange({ ...currentDraft.current, attachments: attachments.filter(attachment => attachment.id !== id) })} />
          <textarea ref={composer} aria-label={t('chat.taskContent')} value={draft.text} rows={3} maxLength={PROMPT_TEXT_LIMIT} disabled={busy || !historyReady}
            aria-autocomplete={workspaceId ? 'list' : undefined} aria-controls={fileMention.open ? fileMention.id : undefined}
            aria-activedescendant={fileMention.open && fileMention.matches.length ? `${fileMention.id}-${fileMention.selected}` : undefined}
            onChange={event => { changeComposerText(event.target.value); if (!composing.current) fileMention.update(event.currentTarget); }}
            placeholder={active ? t('chat.nextPromptPlaceholder') : t('chat.promptPlaceholder')}
            onSelect={event => { if (!composing.current) fileMention.update(event.currentTarget); }}
            onBlur={event => fileMention.close(event.currentTarget)}
            onCompositionStart={event => { composing.current = true; fileMention.close(event.currentTarget); }}
            onCompositionEnd={event => { composing.current = false; fileMention.update(event.currentTarget); }}
            onPaste={event => {
              const file = [...event.clipboardData.files].find(item => clipboardImageExtensions[item.type]);
              if (!file) return;
              event.preventDefault();
              if (!supportsAttachment('image')) { setAttachmentError(t('evidence.pasteUnsupported')); return; }
              if (file.size > ATTACHMENT_LIMITS.imageBytes || attachmentLimitIssue([...attachments, file])) {
                setAttachmentError(t('evidence.pasteLimit')); return;
              }
              if (!busy && historyReady) importAttachments(async () => [await window.workbench.importPastedImage(
                `Screenshot.${clipboardImageExtensions[file.type]}`, new Uint8Array(await file.arrayBuffer()))], 'clipboard');
            }}
            onKeyDown={event => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || fileMention.keyDown(event)) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }} />
          <div className="composer-bottom">
            <div className="composer-controls">
              <IconButton label={attachmentsSupported ? t('chat.attach') : t('chat.pluginAttachmentsUnsupported')} disabled={!historyReady || !attachmentsSupported || busy || attachments.length >= ATTACHMENT_LIMITS.count || importingAttachments}
                onClick={() => importAttachments(() => window.workbench.chooseAttachments(), 'picker')}>
                {importingAttachments ? <LoaderCircle className="spin" size={16} /> : <Paperclip size={16} />}
              </IconButton>
              <span className="composer-divider" />
              <ComposerSettings session={session} provider={provider} disabled={!historyReady || !connected || active || busy}
                saving={settingsBusy} perform={perform} />
            </div>
            <Tooltip label={queuesNextTurn ? t('chat.queueNextTurn') : t('chat.sendTask')}><motion.button className="send-button" aria-label={t('chat.sendTask')}
              title={queuesNextTurn ? t('chat.queueNextTurn') : t('chat.sendTask')}
              disabled={!hasPromptInput(draft) || unsupportedAttachments || Boolean(attachmentIssue) || promptLengthIssue || !historyReady || !connected || busy || settingsBusy || importingAttachments || !provider?.available}
              whileTap={reducedMotion ? undefined : { scale: 0.98 }} transition={transition} onClick={send}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
            </motion.button></Tooltip>
          </div>
        </div>
        </div>
        <div className="composer-caption">
          <span className="composer-project" title={session.cwd}><FolderOpen size={12} />{pathName(session.cwd)}</span>
          <UsageBadge records={session.usage} />
          <span className="composer-shortcut"><CornerDownLeft size={11} />{queuesNextTurn ? t('chat.queueNextTurn') : t('chat.send')}<span>·</span>{t('chat.newLine')}</span>
        </div>
        {!connected && <p className="composer-note" role="status"><CircleAlert size={13} />{t('chat.connectionUnavailable')}</p>}
        {sendError && <p className="composer-note" role="alert"><CircleAlert size={13} />{sendError.rejected ? sendError.message : t('chat.sendUnconfirmed', { error: sendError.message })}</p>}
        {draftError && <p className="composer-note" role="alert"><CircleAlert size={13} />{t('chat.draftError', { error: draftError })}<button className="text-button" onClick={() => onDraftChange(draft)}>{t('chat.retrySave')}</button></p>}
        {unsupportedAttachments && <p className="composer-note" role="alert"><CircleAlert size={13} />{t(attachmentsSupported ? 'chat.pluginAttachmentKindsRemove' : 'chat.pluginAttachmentsRemove')}</p>}
        <AttachmentLimitNotice issue={attachmentIssue} />
        {attachmentError && <p className="composer-note" role="alert"><CircleAlert size={13} />{attachmentError}</p>}
        {promptLengthIssue && <p className="composer-note" role="alert"><CircleAlert size={13} />{t('evidence.promptTooLong')}</p>}
        {!provider?.available && <p className="composer-note"><CircleAlert size={13} />{t('chat.providerUnavailable')}</p>}
      </div>}
    </div>

    {!readOnly && sideQuestion && <SideQuestion sessionId={session.id} origin={sideQuestion} enabled={canAskSideQuestion}
      onClose={closeSideQuestion} locateSource={locateSideQuestionSource} openSession={openSession}
      canOpenSession={id => connected && sessions.some(item => item.id === id)} />}
    {!readOnly && rewindMessage && <Modal title={t('chat.rewindTitle')} subtitle={t('chat.rewindDescription')}
      onClose={() => setRewindMessage(undefined)}>
      <div className="modal-actions">
        <button className="button" onClick={() => setRewindMessage(undefined)}>{t('common.cancel')}</button>
        <button className="button primary" onClick={() => void perform('rewind', async () => {
          const restored = await window.workbench.rewindSession(session.id, rewindMessage);
          onDraftChange(restored);
          setRewindMessage(undefined);
        })}>{t('chat.confirmRewind')}</button>
      </div>
    </Modal>}
    {nativeAgent && <Modal title={nativeAgent.title} subtitle={t('chat.nativeAgent', { id: nativeAgent.nativeId })}
      onClose={() => setNativeAgentId(undefined)}>
      <div className="native-agent-events" ref={nativeDetails} onScrollCapture={event => {
        if (!nativeAgentId || !(event.target instanceof HTMLElement)) return;
        const positions = nativeScrollPositions.current.get(nativeAgentId) ?? new Map();
        positions.set(event.target.dataset.scrollKey ?? 'list', { top: event.target.scrollTop, left: event.target.scrollLeft });
        nativeScrollPositions.current.set(nativeAgentId, positions);
      }}>
        <p className="pane-note">{t('chat.nativeDescription')}</p>
        {nativeEvents.map((event, index) => <section className="process-card" key={`${event.kind}-${event.nativeId}-${index}`}>
          <div className="process-heading"><strong>{event.title}</strong><Status value={event.status} /></div>
          <ProcessBody event={event} />
        </section>)}
      </div>
    </Modal>}
  </section>;
}

function TraceHeading({ trace, live, addedEvents, expanded, onToggle, onInspect }: {
  trace: TraceEntry; live: boolean; addedEvents: number; expanded: boolean;
  onToggle: (expanded: boolean) => void; onInspect: (id: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const previousCount = useRef(trace.length);
  const { lastDiff, lastFailure } = trace;
  const animate = live && (trace.length === previousCount.current || trace.length - previousCount.current === addedEvents);
  useLayoutEffect(() => { previousCount.current = trace.length; }, [trace.length]);
  return <div className={`messages trace-heading${expanded ? ' is-expanded' : ''}`}>
    <div className="trace-summary">
      <button className="trace-toggle" aria-expanded={expanded} onClick={() => onToggle(!expanded)}>
        <Activity className="trace-symbol" size={15} aria-hidden="true" />
        <strong title={t('chat.trace.title')}>{t('chat.trace.title')}</strong>
        <span className="trace-count">
          <RollingText value={formatNumber(trace.length)} animate={animate} /> {t('chat.trace.events', { count: trace.length })}
        </span>
        {live && <span className="trace-live">{t('chat.trace.live')}</span>}
        <ChevronDown className="trace-chevron" size={14} aria-hidden="true" />
      </button>
      {lastDiff && <button className="trace-diff" title={lastDiff.path} onClick={() => onInspect(lastDiff.id)}>
        <GitCompareArrows size={13} aria-hidden="true" />
        <span>{lastDiff.path ? t('chat.trace.turnDiffPath', { path: lastDiff.path }) : t('chat.trace.turnDiff')}</span>
      </button>}
      {lastFailure && <button className="trace-failure" title={lastFailure.title || t('chat.trace.locateFailure')} onClick={() => onInspect(lastFailure.id)}>
        <CircleAlert size={13} aria-hidden="true" />
        <span>{lastFailure.title
          ? t('chat.trace.failedTitle', { total: formatNumber(trace.failures), title: lastFailure.title })
          : t('chat.trace.failed', { count: trace.failures, total: formatNumber(trace.failures) })}</span>
      </button>}
    </div>
  </div>;
}

function TraceEventRow({ message, end, entering, matched, ...card }: Parameters<typeof ProcessCard>[0] & {
  message: Message; end: boolean; entering: boolean; matched: boolean;
}) {
  const [animateOnMount] = useState(entering);
  return <div className="messages">
    <article data-message-id={message.id}
      className={`message-process${end ? ' process-end' : ''}${matched ? ' conversation-match' : ''}`}>
      <div className={animateOnMount ? 'trace-event-enter' : undefined}><ProcessCard {...card} /></div>
    </article>
  </div>;
}

function ProcessCard({ event, openSession, openNativeAgent, expanded, onExpandedChange, onAsk, onQuote }: {
  event: ProcessEvent;
  openSession: (id: string) => void;
  openNativeAgent: (id: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onAsk?: (trigger: HTMLButtonElement) => void;
  onQuote?: () => void;
}) {
  const { t } = useTranslation('workspace');
  const bodyId = useId();
  const title = event.kind === 'diff' ? t('chat.trace.turnDiff') : event.title;
  const icon = event.kind === 'diff' ? <GitCompareArrows size={15} />
    : event.kind === 'plan' ? <ListChecks size={15} />
    : event.kind === 'subagent' || event.kind === 'task' ? <Users size={15} />
      : <TerminalSquare size={15} />;

  return <section className={`process-card process-${event.status}${expanded ? ' is-expanded' : ''}`}>
    <div className="process-heading">
      <span className="process-node" aria-hidden="true">
        {event.status === 'completed' ? <Check size={11} /> : event.status === 'failed' ? <CircleAlert size={13} /> : <span />}
      </span>
      <button className="process-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => onExpandedChange(!expanded)}>
        <span className="process-symbol" aria-hidden="true">{icon}</span><strong title={title}>{title}</strong>
        <Status value={event.status} /><ChevronDown className="process-chevron" size={14} />
      </button>
      {(onAsk || onQuote || event.sessionId || (event.kind === 'subagent' && event.nativeId)) && <div className="process-links">
        {onAsk && <SideQuestionAction onClick={onAsk} />}
        {onQuote && <button type="button" onClick={onQuote}><FileText size={12} />{t('evidence.quoteFailure')}</button>}
        {event.sessionId && <button onClick={() => openSession(event.sessionId!)}>{t('chat.openChild')}<ArrowUpLeft size={12} /></button>}
        {event.kind === 'subagent' && event.nativeId && <button onClick={() => openNativeAgent(event.nativeId!)}>{t('chat.openNative')}<ArrowUpLeft size={12} /></button>}
      </div>}
    </div>
    <CollapsibleRegion expanded={expanded} id={bodyId} className="process-reveal" onClose={() => onExpandedChange(false)}>
      <ProcessBody event={event} />
    </CollapsibleRegion>
  </section>;
}

function ProcessBody({ event }: { event: ProcessEvent }) {
  const { t } = useTranslation('workspace');
  if (event.kind === 'diff') return <div className="process-body">
    {event.output ? <div className="process-output">
      <span>{t('chat.trace.turnDiffSource')}</span>
      <pre className="turn-diff-patch" data-scroll-key={`${event.id}:output`}>{diffLines(event.output).map((line, index) =>
        <span className={line.kind} key={index}>{line.text}{'\n'}</span>)}</pre>
    </div> : <p className="process-empty">{t(event.output === '' ? 'chat.trace.turnDiffEmpty' : 'chat.trace.turnDiffUnavailable')}</p>}
  </div>;
  return <div className="process-body">
    {event.input && <div className="process-output"><span>{t('common.input')}</span><pre data-scroll-key={`${event.id}:input`}>{event.input}</pre></div>}
    {event.entries?.length ? <ol className="process-checklist">
      {event.entries.map((entry, index) => <li key={index}><Status value={entry.status} /><span>{entry.text}</span></li>)}
    </ol> : null}
    {event.output && <div className="process-output"><span>{t('common.output')}</span><pre data-scroll-key={`${event.id}:output`}>{event.output}</pre></div>}
    {(event.nativeId || event.parentId) && <div className="process-identifiers">
      {event.nativeId && <small>{t('chat.nativeId')}<code>{event.nativeId}</code></small>}
      {event.parentId && <small>{t('chat.parentCall')}<code>{event.parentId}</code></small>}
    </div>}
    {!event.input && !event.entries?.length && !event.output && !event.nativeId && !event.parentId
      && <p className="process-empty">{event.status === 'running' ? t('chat.waitingDetails') : t('chat.noDetails')}</p>}
  </div>;
}
