import { AgentIcon } from './AgentIcon';
import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber, renderDisplayText } from '../shared/i18n';
import { validQuestionAnswers } from '../shared/question-answers';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, Archive, ArrowDown, ArrowUp, ArrowUpLeft, Brain, Check, ChevronDown,
  CircleAlert, CircleStop, Clock3, Copy, CornerDownLeft, FileText, FolderOpen,
  GitFork, Image, ListChecks, LoaderCircle, MessageCircle, PanelsTopLeft,
  Paperclip, Pause, Play, Search, Settings2, ShieldCheck, TerminalSquare, Users, X,
} from 'lucide-react';
import type {
  Approval, Message, ProcessEvent, PromptAttachment, PromptInput, ProviderInfo, Session, SkillInfo, UsageRecord,
} from '../shared/types';
import { IconButton, Modal, Status, modelName, pathName, type Perform } from './ui';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';
import { useClaudeScrollPinning } from './vendor/open-claude-ui/useClaudeScrollPinning';
import { useSessionHistory, type IndexedMessages } from './useSessionHistory';
import { promptCommandInput, runSessionCommand, runSessionStopCommand } from './session-command';
import { sessionIsUnread } from './session-attention';
import './SessionChat.css';

interface SessionChatProps {
  session: Session;
  provider?: ProviderInfo;
  perform: Perform;
  pending: Set<string>;
  draft: PromptInput;
  draftError?: string;
  onDraftChange: (value: PromptInput, expected?: PromptInput) => void;
  workspaceId?: string;
  readOnly?: boolean;
  sessions?: Session[];
  openSession: (id: string) => void;
  connected?: boolean;
}

type ApprovalProps = Pick<SessionChatProps, 'pending' | 'perform'> & { approval: Approval };

const activeStatuses = new Set<Session['status']>(['running', 'waiting_approval', 'waiting_children', 'queued']);

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

function SessionSettings({ session, workspaceId, active, visible, perform, openSession, onClose }: {
  session: Session;
  workspaceId: string;
  active: boolean;
  visible: boolean;
  perform: Perform;
  openSession: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('workspace');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const availableSkills = skills.filter(skill => !skill.issue);
  useEffect(() => {
    if (visible) void perform('session-skills', async () => setSkills(await window.workbench.listSkills(workspaceId)));
  }, [workspaceId, visible, perform]);

  return <div className="session-settings">
    <div className="session-settings-heading">
      <span><Settings2 size={14} />{t('chat.settings')}</span>
      <IconButton label={t('chat.closeSettings')} onClick={onClose}><X size={14} /></IconButton>
    </div>
    {availableSkills.length > 0 && <div className="session-skills">
      <span>{t('chat.skills')}</span>
      <div className="skills-select">
        {availableSkills.map(skill => <label key={skill.id} title={skill.description}>
          <input type="checkbox" disabled={active} checked={session.settings?.skillIds?.includes(skill.id) ?? false}
            onChange={event => void perform('session-skill', () => window.workbench.updateSession(session.id, {
              settings: {
                skillIds: event.target.checked
                  ? [...(session.settings?.skillIds ?? []), skill.id]
                  : session.settings?.skillIds?.filter(id => id !== skill.id),
              },
            }))} />
          {skill.name}
        </label>)}
      </div>
    </div>}
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


function ComposerSelect({ label, icon, value, display, disabled, hint, onChange, children, className = '' }: {
  label: string;
  icon: ReactNode;
  value: string;
  display: string;
  disabled: boolean;
  hint: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return <label className={`composer-select ${className}`} title={disabled ? hint : `${label}: ${display}`}>
    {icon}<span className="composer-select-value" aria-hidden="true">{display}</span><ChevronDown size={11} aria-hidden="true" />
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{children}</select>
  </label>;
}

function ComposerSettings({ session, provider, disabled, saving, perform }: {
  session: Session;
  provider?: ProviderInfo;
  disabled: boolean;
  saving: boolean;
  perform: Perform;
}) {
  const { t } = useTranslation('workspace');
  const efforts = provider?.models?.find(item => item.id === session.modelId)?.efforts ?? provider?.efforts ?? [];
  const hint = saving ? t('chat.savingSettings') : t('chat.settingsAfterTask');
  const change = (patch: Parameters<typeof window.workbench.updateSession>[1]) =>
    void perform(`session-settings-${session.id}`, () => window.workbench.updateSession(session.id, patch));
  const modelLabel = session.modelId ? modelName(provider, session.modelId) : t('chat.modelDefault', { provider: provider?.name ?? session.providerId });
  const effortLabel = (effort: string) => t(`chat.effort.${effort}`, { defaultValue: effort });
  return <>
    <ComposerSelect className="composer-select-model" label={t('chat.model')} icon={<AgentIcon providerId={session.providerId} size={14} />}
      value={session.modelId ?? ''} display={modelLabel} disabled={disabled || !provider?.models?.length}
      hint={disabled ? hint : t('chat.cliDefault')} onChange={value => change({ modelId: value || null })}>
      <option value="">{provider?.defaultModelId ? t('chat.defaultModelName', { model: modelName(provider, provider.defaultModelId) }) : t('chat.cliDefault')}</option>
      {session.modelId && !provider?.models?.some(model => model.id === session.modelId)
        && <option value={session.modelId} disabled>{session.modelId}{t('chat.modelUnavailable')}</option>}
      {provider?.models?.map(model => <option key={model.id} value={model.id}>
        {model.name}{model.free ? t('chat.modelFree') : session.providerId === 'codex' ? t('chat.modelAccount') : t('chat.modelMetered')}
      </option>)}
    </ComposerSelect>
    {provider?.capabilities.effort && efforts.length > 0 && <ComposerSelect label={t('chat.effort')} icon={<Brain size={13} />}
      value={session.settings?.effort ?? ''} display={session.settings?.effort ? effortLabel(session.settings.effort) : t('chat.defaultEffort')}
      disabled={disabled} hint={hint} onChange={value => change({ settings: { effort: value || null } })}>
      <option value="">{t('chat.runtimeDefault')}</option>
      {efforts.map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
    </ComposerSelect>}
    {provider?.capabilities.permissions && <ComposerSelect label={t('chat.permissions')} icon={<ShieldCheck size={13} />}
      value={session.settings?.permission ?? 'review'} display={session.settings?.permission === 'read-only' ? t('common.readOnly') : t('chat.reviewPermissionShort')}
      disabled={disabled} hint={hint} onChange={value => change({ settings: { permission: value as 'review' | 'read-only' } })}>
      <option value="review">{t('chat.reviewPermission')}</option>
      <option value="read-only">{t('common.readOnly')}</option>
    </ComposerSelect>}
    {saving && <span className="composer-settings-saving" role="status" aria-label={t('chat.savingSettings')}><LoaderCircle size={13} className="spin" /></span>}
  </>;
}

function AttachmentChips({ attachments, onRemove }: {
  attachments: PromptAttachment[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation('workspace');
  if (!attachments.length) return null;
  return <div className="attachments-strip">
    {attachments.map(item => <span className="attachment-chip" key={item.id} title={`${item.name} · ${Math.ceil(item.size / 1024)} KB`}>
      {item.kind === 'image' ? <Image size={14} /> : <FileText size={14} />}
      <span>{item.name}</span>
      <small>{Math.ceil(item.size / 1024)} KB</small>
      {onRemove && <button type="button" aria-label={t('chat.removeAttachment', { name: item.name })} onClick={() => onRemove(item.id)}><X size={12} /></button>}
    </span>)}
  </div>;
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

const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};
const MarkdownAnswer = memo(function MarkdownAnswer({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>{text}</ReactMarkdown>;
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

function UsageBadge({ usage }: { usage?: UsageRecord }) {
  const { t } = useTranslation('workspace');
  if (!usage) return null;
  if (usage.scope === 'context') {
    const known = usage.contextUsed !== undefined && usage.contextSize !== undefined && usage.contextSize > 0;
    return <span className="session-usage" title={known
      ? t('usage.contextCapacity', { used: formatNumber(usage.contextUsed!), size: formatNumber(usage.contextSize!) })
      : t('usage.contextTokens', { used: usage.contextUsed === undefined ? '—' : formatNumber(usage.contextUsed) })}>
      {known && <span className="context-meter" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.max(0, usage.contextUsed! / usage.contextSize! * 100))}%` }} />
      </span>}
      {t('usage.contextUsed', { used: usage.contextUsed === undefined ? '—' : formatNumber(usage.contextUsed) })}
    </span>;
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

function PromptQueue({ session, provider, pending, perform, connected }: Pick<SessionChatProps, 'session' | 'provider' | 'pending' | 'perform'> & { connected: boolean }) {
  const { t } = useTranslation('workspace');
  const [editing, setEditing] = useState<{ id: string; input: PromptInput }>();
  const queue = session.queue ?? [];
  if (!queue.length) return null;
  const pauseKey = `queue-pause-${session.id}`;
  return <section className="prompt-queue" aria-label={t('chat.queueTitle')}>
    <header><strong><ListChecks size={14} />{t('chat.queueCount', { count: queue.length })}</strong>
      <button disabled={!connected || pending.has(pauseKey)} onClick={() => void perform(pauseKey,
        () => window.workbench.setSessionQueuePaused(session.id, !session.queuePaused))}>
        {session.queuePaused ? <Play size={12} /> : <Pause size={12} />}{session.queuePaused ? t('chat.resumeQueue') : t('chat.pauseQueue')}
      </button>
    </header>
    {session.queuePaused && <p className="queue-paused"><Pause size={12} />{t('chat.queuePaused')}{session.queueHoldReason && <span>{session.queueHoldReason}</span>}</p>}
    <ol>{queue.map(item => {
      const changing = pending.has(`queue-item-${item.id}`);
      return <li key={item.id} data-queue-id={item.id}>
        {editing?.id === item.id ? <form onSubmit={event => {
          event.preventDefault();
          if (changing || !connected || (!editing.input.text.trim() && !editing.input.attachments?.length)) return;
          const input = promptCommandInput(editing.input);
          void perform(`queue-item-${item.id}`, async () => {
            await window.workbench.updateQueuedPrompt(session.id, item.id, input);
            setEditing(current => current?.id === item.id ? undefined : current);
          });
        }}>
          <textarea aria-label={t('chat.editQueued')} value={editing.input.text} disabled={changing} rows={2}
            onChange={event => setEditing(current => current && ({ ...current, input: { ...current.input, text: event.target.value } }))} />
          <AttachmentChips attachments={editing.input.attachments ?? []} onRemove={changing ? undefined : id =>
            setEditing(current => current && ({ ...current, input: { ...current.input, attachments: current.input.attachments?.filter(attachment => attachment.id !== id) } }))} />
          <div className="queue-item-actions"><button type="submit" disabled={changing || !connected || (!editing.input.text.trim() && !editing.input.attachments?.length)}>{t('chat.saveQueued')}</button>
            <button type="button" onClick={() => setEditing(undefined)}>{t('common.cancel')}</button></div>
        </form> : <>
          <div className="queue-item-content"><p>{item.input.text || t('chat.queuedAttachments')}</p>
            <small>{item.modelId ? modelName(provider, item.modelId) : t('chat.runtimeDefault')}{item.settings?.effort ? ` · ${item.settings.effort}` : ''}</small>
            <AttachmentChips attachments={item.input.attachments ?? []} />
          </div>
          <div className="queue-item-actions"><button disabled={changing || !connected} onClick={() => setEditing({ id: item.id, input: item.input })}>{t('chat.editQueued')}</button>
            <button disabled={changing || !connected} onClick={() => void perform(`queue-item-${item.id}`,
              () => window.workbench.removeQueuedPrompt(session.id, item.id))}>{t('chat.removeQueued')}</button></div>
        </>}
      </li>;
    })}</ol>
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

export function SessionChat({
  session, provider, perform, pending, draft, draftError, onDraftChange, workspaceId, sessions = [], openSession, connected = true, readOnly = false,
}: SessionChatProps) {
  const { t } = useTranslation('workspace');
  const [showActivity, setShowActivity] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchResult, setSearchResult] = useState<{ sessionId: string; query: string; messages: Message[]; truncated: boolean }>();
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<string>();
  const [sendError, setSendError] = useState('');
  const [expandedProcesses, setExpandedProcesses] = useState<Set<string>>(new Set());
  const attachments = draft.attachments ?? [];
  const attachmentCapabilities = provider?.declaredCapabilities ?? provider?.capabilities;
  const supportsAttachment = (kind: PromptAttachment['kind']) => provider?.source !== 'plugin'
    || (provider.protocolVersion === 2 && attachmentCapabilities?.[kind === 'image' ? 'images' : 'textAttachments'] === true);
  const attachmentsSupported = supportsAttachment('image') || supportsAttachment('text');
  const unsupportedAttachments = attachments.some(attachment => !supportsAttachment(attachment.kind));
  const [rewindMessage, setRewindMessage] = useState<string>();
  const [nativeAgentId, setNativeAgentId] = useState<string>();
  const composing = useRef(false);
  const sendLock = useRef(false);
  const currentDraft = useRef(draft);
  const reducedMotion = useReducedMotion();
  const settingsId = useId();
  const activityId = useId();
  const settingsRegion = useRef<HTMLDivElement>(null);
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
  const busy = pending.has(`send-${session.id}`);
  const settingsBusy = pending.has(`session-settings-${session.id}`);
  const history = useSessionHistory(session);
  const messages = history.messages;
  const activity = history.activities;
  const searchQuery = find?.trim() ?? '';
  const matches = searchQuery && searchResult?.sessionId === session.id && searchResult.query === searchQuery ? searchResult.messages : [];
  const selectedMatch = matches[matchIndex % Math.max(matches.length, 1)];
  const children = sessions.filter(item => item.parentSessionId === session.id);
  const parent = sessions.find(item => item.id === session.parentSessionId);
  const nativeEvents = nativeAgentId ? history.eventsFor(nativeAgentId) : [];
  const nativeAgent = nativeEvents.find(event => event.kind === 'subagent' && event.nativeId === nativeAgentId);
  const virtualScroll = useRef<{ scrollToEnd(options: { behavior: 'smooth' | 'auto' }): void } | null>(null);
  const { containerRef: scroll, isPinned, showJumpControl, markUserInput, pauseForNavigation, handleScroll, scrollToBottom } =
    useClaudeScrollPinning([session.id, history.showingHistory ? null : history.messages,
      history.showingHistory ? null : session.approvals, history.showingHistory ? null : session.status,
      history.showingHistory ? null : session.error], smooth => virtualScroll.current?.scrollToEnd({ behavior: smooth ? 'smooth' : 'auto' }));
  type ChatRow = { kind: 'message'; key: string; message: Message; index: number } | { kind: 'notices'; key: string } | { kind: 'empty'; key: string };
  const rowCount = Math.max(messages.length, 1) + 1;
  const rowAt = (index: number): ChatRow => {
    const message = messages.at(index);
    if (message) return { kind: 'message', key: message.id, message, index };
    return index === 0 ? { kind: 'empty', key: 'conversation-empty' } : { kind: 'notices', key: 'conversation-notices' };
  };
  const messageSource = useRef(messages);
  messageSource.current = messages;
  const getItemKey = useCallback((index: number) => messageSource.current.at(index)?.id ?? (index === 0 ? 'conversation-empty' : 'conversation-notices'), [messages.structure]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    getScrollElement: () => scroll.current,
    getItemKey,
    estimateSize: index => {
      const row = rowAt(index);
      if (row.kind === 'empty') return 360;
      if (row.kind === 'notices') return 80 + session.approvals.length * 240;
      return row.message.event ? 45 : Math.min(1000, 100 + Math.ceil(row.message.text.length / 100) * 22);
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
    scrollEndThreshold: 40,
  });
  virtualScroll.current = virtualizer;
  const closeFind = () => { history.cancelJump(); setScrollTarget(undefined); setFind(null); };
  const showLatestOutput = (smooth = false) => {
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
    pauseForNavigation();
    void history.locateMessage(selectedMatch.id).then(found => { if (active && found) setScrollTarget(selectedMatch.id); });
    return () => { active = false; history.cancelJump(); };
  }, [session.id, selectedMatch?.id, history.cancelJump, pauseForNavigation]);

  useLayoutEffect(() => {
    if (!scrollTarget) return;
    const index = messages.indexOf(scrollTarget);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' });
    const frame = requestAnimationFrame(() => { handleScroll(); setScrollTarget(undefined); });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget, messages]);

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
    if (!revision || !sessionIsUnread(session) || !connected || !isPinned || history.showingHistory || history.waitingForTail || seenInFlight.current === revision) return;
    const frame = requestAnimationFrame(() => {
      const element = scroll.current;
      if (!element || document.visibilityState !== 'visible' || !document.hasFocus() || element.clientHeight <= 0
        || element.scrollHeight - element.scrollTop - element.clientHeight > 40) return;
      seenInFlight.current = revision;
      void window.workbench.markSessionSeen(session.id, revision).catch(() => { seenInFlight.current = undefined; });
    });
    return () => cancelAnimationFrame(frame);
  }, [session.attention?.revision, session.attention?.seenRevision, connected, isPinned, history.showingHistory, history.waitingForTail, visibilityRevision, messages, virtualizer.getTotalSize()]);

  useEffect(() => {
    if (!showSettings && !showActivity) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest('button')?.getAttribute('aria-controls');
      if (showSettings && control !== settingsId && !settingsRegion.current?.contains(event.target)) setShowSettings(false);
      if (showActivity && control !== activityId && !activityRegion.current?.contains(event.target)) setShowActivity(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [showSettings, showActivity, settingsId, activityId]);

  const send = () => {
    const prompt = draft.text.trim();
    if (readOnly || (!prompt && !attachments.length) || unsupportedAttachments || !connected || !historyReady || busy || settingsBusy || sendLock.current || !provider?.available) return;
    sendLock.current = true;
    setSendError('');
    void perform(`send-${session.id}`, async () => {
      try {
        const input = promptCommandInput(draft);
        await runSessionCommand(`send:${session.id}`, input, async commandId => {
          await window.workbench.sendPrompt(session.id, input, commandId);
          if (currentDraft.current === draft) { setSendError(''); onDraftChange({ text: '' }, draft); }
          history.showLatest();
          scrollToBottom();
        });
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        sendLock.current = false;
      }
    });
  };

  return <section className={`chat-pane${readOnly ? ' chat-pane-readonly' : ''}`} aria-label={session.title}>
    <header className="chat-toolbar">
      <div className="chat-toolbar-heading">
        <MessageCircle size={14} /><h2 title={session.title}>{session.title}</h2>
      </div>
      <Status value={session.status} />
      <div className="chat-toolbar-actions">
        <IconButton label={find === null ? t('chat.find') : t('chat.closeFind')} aria-pressed={find !== null}
          onClick={() => find === null ? setFind('') : closeFind()}><Search size={15} /></IconButton>
        {!readOnly && <IconButton label={t('chat.settings')} aria-expanded={showSettings} aria-controls={settingsId}
          onClick={() => setShowSettings(value => !value)}><Settings2 size={15} /></IconButton>}
        <button className={`text-button chat-activity-button ${showActivity ? 'selected' : ''}`}
          aria-expanded={showActivity} aria-controls={activityId} onClick={() => setShowActivity(value => !value)}>
          <Activity size={14} /><span className="chat-activity-label">{t('chat.activity')}</span>{activity.length > 0 && <span className="chat-count">{activity.length}</span>}
        </button>
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
    {!readOnly && workspaceId && <CollapsibleRegion expanded={showSettings} id={settingsId} className="chat-settings-region"
      regionRef={settingsRegion} onClose={() => setShowSettings(false)}>
      <SessionSettings session={session} workspaceId={workspaceId} active={active} visible={showSettings}
        perform={perform} openSession={openSession} onClose={() => setShowSettings(false)} />
    </CollapsibleRegion>}

    {(parent || children.length > 0) && <nav className="session-children" aria-label={t('chat.relatedSessions')}>
      {parent && <button onClick={() => openSession(parent.id)}><ArrowUpLeft size={13} />{t('chat.coordinator', { title: parent.title })}</button>}
      {children.map(child => <button key={child.id} onClick={() => openSession(child.id)}>
        <GitFork size={13} /><span>{child.title}</span><small>{child.providerId}</small><Status value={child.status} />
      </button>)}
    </nav>}
    {(history.hasMore || history.showingHistory || history.loading || history.error) && <div className="conversation-history-controls">
      {history.hasMore && <button disabled={history.loading || !connected} onClick={() => { markUserInput(); void history.loadOlder(); }}>
        {history.loading ? <LoaderCircle className="spin" size={12} /> : <ArrowUp size={12} />}{t('chat.loadEarlier')}
      </button>}
      {history.showingHistory && <><span>{t('chat.historyWindow')}</span>
        {history.hasAfter && <button disabled={history.loading || !connected} onClick={() => void history.loadNewer()}><ArrowDown size={12} />{t('chat.loadLater')}</button>}
        <button onClick={() => showLatestOutput()}><ArrowDown size={12} />{t('chat.returnLatest')}</button></>}
      {history.error && <span className="chat-history-error" role="alert">{history.error}</span>}
    </div>}
    <div className="message-scroll" ref={scroll} tabIndex={0} aria-label={t('chat.conversation')}
      onScroll={handleScroll} onWheel={markUserInput} onTouchStart={markUserInput}
      onPointerDown={event => { if (event.target === event.currentTarget) markUserInput(); }}
      onKeyDown={event => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          && event.target instanceof HTMLElement && !event.target.closest('input, textarea, select, [contenteditable="true"]')) markUserInput();
      }}>
      <div className="virtual-conversation" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const row = rowAt(item.index);
          const message = row.kind === 'message' ? row.message : undefined;
          const index = item.index;
          return <div className="virtual-conversation-row" data-index={item.index} key={item.key} ref={virtualizer.measureElement}
            style={{ transform: `translateY(${item.start}px)` }}>
          {row.kind === 'empty' ? <div className="conversation-empty">
          <div className="agent-mark"><PanelsTopLeft size={27} strokeWidth={1.5} /></div>
          <span className="conversation-empty-caption">{provider?.name ?? session.providerId} · {provider?.available ? t('chat.ready') : t('chat.notReady')}</span>
          <h2>{session.title}</h2>
          <p>{history.waitingForTail ? t('chat.loadingHistory') : t('chat.describeTask', { provider: provider?.name ?? session.providerId })}</p>
          <div className="conversation-project"><FolderOpen size={14} /><code>{session.cwd}</code></div>
        </div>
        : message ? <div className="messages"><article data-message-id={message.id}
              className={`message message-${message.role}${message.event ? ` message-process${index > 0 && messages.at(index - 1)?.event ? '' : ' process-start'}${messages.at(index + 1)?.event ? '' : ' process-end'}` : ''}${selectedMatch?.id === message.id ? ' conversation-match' : ''}`}>
              {message.event
                ? <ProcessCard event={message.event} openSession={openSession} openNativeAgent={setNativeAgentId}
                  expanded={expandedProcesses.has(message.id)} onExpandedChange={expanded => setExpandedProcesses(current => {
                    const next = new Set(current); if (expanded) next.add(message.id); else next.delete(message.id); return next;
                  })} />
                : message.role === 'user'
                  ? <>
                    <div className="user-message">{message.text}
                      {message.attachments && <AttachmentChips attachments={message.attachments} />}
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
                      {!readOnly && !active && <button onClick={() => void perform('fork-session',
                        async () => openSession(await window.workbench.forkSession(session.id, message.id)))}>
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
        {historyReady && <PromptQueue session={session} provider={provider} pending={pending} perform={perform} connected={connected} />}
        <div className={`composer${active ? ' composer-task-active' : ''}`}>
          <AttachmentChips attachments={attachments}
            onRemove={busy || !historyReady ? undefined : id => onDraftChange({ ...currentDraft.current, attachments: attachments.filter(attachment => attachment.id !== id) })} />
          <textarea aria-label={t('chat.taskContent')} value={draft.text} rows={3} maxLength={200_000} disabled={busy || !historyReady}
            onChange={event => onDraftChange({ ...currentDraft.current, text: event.target.value })}
            placeholder={active ? t('chat.nextPromptPlaceholder') : t('chat.promptPlaceholder')}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                send();
              }
            }} />
          <div className="composer-bottom">
            <div className="composer-controls">
              <IconButton label={attachmentsSupported ? t('chat.attach') : t('chat.pluginAttachmentsUnsupported')} disabled={!historyReady || !attachmentsSupported || busy || attachments.length >= 8 || pending.has('attachments')}
                onClick={() => void perform('attachments', async () => {
                  const selected = await window.workbench.chooseAttachments();
                  onDraftChange({ ...currentDraft.current, attachments: [...(currentDraft.current.attachments ?? []), ...selected].slice(0, 8) });
                })}><Paperclip size={16} /></IconButton>
              <span className="composer-divider" />
              <ComposerSettings session={session} provider={provider} disabled={!historyReady || !connected || active || busy || settingsBusy}
                saving={settingsBusy} perform={perform} />
            </div>
            <motion.button className="send-button" aria-label={t('chat.sendTask')}
              title={active || session.queuePaused ? t('chat.queueNextTurn') : t('chat.sendTask')}
              disabled={(!draft.text.trim() && !attachments.length) || unsupportedAttachments || !historyReady || !connected || busy || settingsBusy || !provider?.available}
              whileTap={reducedMotion ? undefined : { scale: 0.98 }} transition={transition} onClick={send}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
            </motion.button>
          </div>
        </div>
        <div className="composer-caption">
          <span className="composer-project" title={session.cwd}><FolderOpen size={12} />{pathName(session.cwd)}</span>
          <UsageBadge usage={session.usage?.at(-1)} />
          <span className="composer-shortcut"><CornerDownLeft size={11} />{active || session.queuePaused ? t('chat.queueNextTurn') : t('chat.send')}<span>·</span>{t('chat.newLine')}</span>
        </div>
        {!connected && <p className="composer-note" role="status"><CircleAlert size={13} />{t('chat.connectionUnavailable')}</p>}
        {!historyReady && <p className="composer-note" role="status"><LoaderCircle className="spin" size={13} />{t('chat.loadingHistory')}</p>}
        {sendError && <p className="composer-note" role="alert"><CircleAlert size={13} />{t('chat.sendUnconfirmed', { error: sendError })}</p>}
        {draftError && <p className="composer-note" role="alert"><CircleAlert size={13} />{t('chat.draftError', { error: draftError })}<button className="text-button" onClick={() => onDraftChange(draft)}>{t('chat.retrySave')}</button></p>}
        {unsupportedAttachments && <p className="composer-note" role="alert"><CircleAlert size={13} />{t(attachmentsSupported ? 'chat.pluginAttachmentKindsRemove' : 'chat.pluginAttachmentsRemove')}</p>}
        {!provider?.available && <p className="composer-note"><CircleAlert size={13} />{t('chat.providerUnavailable')}</p>}
      </div>}
    </div>

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

function ProcessCard({ event, openSession, openNativeAgent, expanded, onExpandedChange }: {
  event: ProcessEvent;
  openSession: (id: string) => void;
  openNativeAgent: (id: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useTranslation('workspace');
  const bodyId = useId();
  const icon = event.kind === 'plan' ? <ListChecks size={15} />
    : event.kind === 'subagent' || event.kind === 'task' ? <Users size={15} />
      : <TerminalSquare size={15} />;

  return <section className={`process-card process-${event.status}${expanded ? ' is-expanded' : ''}`}>
    <div className="process-heading">
      <span className="process-node" aria-hidden="true">
        {event.status === 'completed' ? <Check size={11} /> : event.status === 'failed' ? <CircleAlert size={13} /> : <span />}
      </span>
      <button className="process-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => onExpandedChange(!expanded)}>
        <span className="process-symbol">{icon}</span><strong>{event.title}</strong>
        <Status value={event.status} /><ChevronDown className="process-chevron" size={14} />
      </button>
      {(event.sessionId || (event.kind === 'subagent' && event.nativeId)) && <div className="process-links">
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
