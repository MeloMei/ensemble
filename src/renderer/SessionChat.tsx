import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber, renderDisplayText } from '../shared/i18n';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, Archive, ArrowDown, ArrowUp, ArrowUpLeft, Check, ChevronDown,
  CircleAlert, CircleStop, Clock3, Copy, CornerDownLeft, FileText, FolderOpen,
  GitFork, Image, ListChecks, LoaderCircle, MessageCircle, PanelsTopLeft,
  Paperclip, Search, Settings2, ShieldCheck, TerminalSquare, Users, X,
} from 'lucide-react';
import type {
  Approval, Message, ProcessEvent, PromptAttachment, PromptInput, ProviderInfo, Session, SkillInfo, UsageRecord,
} from '../shared/types';
import { searchableMessageText } from '../shared/message-text';
import { IconButton, Modal, Status, modelName, pathName, type Perform } from './ui';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';
import { useClaudeScrollPinning } from './vendor/open-claude-ui/useClaudeScrollPinning';
import './SessionChat.css';

interface SessionChatProps {
  session: Session;
  provider?: ProviderInfo;
  perform: Perform;
  pending: Set<string>;
  draft: PromptInput;
  draftError?: string;
  onDraftChange: (value: PromptInput) => void;
  workspaceId: string;
  sessions?: Session[];
  openSession: (id: string) => void;
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
    [...(selected[question.id] ?? []), ...(free[question.id]?.trim() ? [free[question.id].trim()] : [])],
  ]));
  const valid = questions.every(question => answers[question.id].length > 0);
  const busy = pending.has(`approval-${approval.id}`);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    void perform(`approval-${approval.id}`, () => window.workbench.answerQuestions(approval.id, answers));
  };

  return <form className="approval-card question-approval" onSubmit={submit}>
    <ApprovalHeading title={renderDisplayText(approval.title || t('approval.answerTitle'), approval.titleI18n)} caption={t('approval.answerCaption')} busy={busy} />
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
      <input aria-label={t('approval.otherAnswer', { question: renderDisplayText(question.header || question.question, question.headerI18n) })} value={free[question.id] ?? ''}
        disabled={busy} placeholder={question.multiSelect ? t('approval.otherPlaceholder') : t('approval.answerPlaceholder')}
        onChange={event => {
          setFree(current => ({ ...current, [question.id]: event.target.value }));
          if (!question.multiSelect) setSelected(current => ({ ...current, [question.id]: [] }));
        }} />
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
        onClick={() => void perform(`approval-${approval.id}`, () => window.workbench.decideApproval(approval.id, choice.id))}>
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

function SessionSettings({ session, provider, workspaceId, active, visible, perform, openSession, onClose }: {
  session: Session;
  provider?: ProviderInfo;
  workspaceId: string;
  active: boolean;
  visible: boolean;
  perform: Perform;
  openSession: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('workspace');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const efforts = provider?.models?.find(item => item.id === session.modelId)?.efforts ?? provider?.efforts ?? [];
  const availableSkills = skills.filter(skill => !skill.issue);
  useEffect(() => {
    if (visible) void perform('session-skills', async () => setSkills(await window.workbench.listSkills(workspaceId)));
  }, [workspaceId, visible, perform]);

  return <div className="session-settings">
    <div className="session-settings-heading">
      <span><Settings2 size={14} />{t('chat.settings')}</span>
      <IconButton label={t('chat.closeSettings')} onClick={onClose}><X size={14} /></IconButton>
    </div>
    <div className="session-settings-fields">
      <label>{t('chat.model')}<select disabled={active || !provider?.models?.length} value={session.modelId ?? ''}
          onChange={event => void perform('session-model', () => window.workbench.updateSession(session.id, { modelId: event.target.value || null }))}>
          <option value="">{t('chat.cliDefault')}</option>
          {session.modelId && !provider?.models?.some(model => model.id === session.modelId)
            && <option value={session.modelId} disabled>{session.modelId} {t('chat.modelUnavailable')}</option>}
          {provider?.models?.map(model => <option key={model.id} value={model.id}>
            {model.name}{model.free ? t('chat.modelFree') : session.providerId === 'codex' ? t('chat.modelAccount') : t('chat.modelMetered')}
          </option>)}
        </select>
      </label>
      {efforts.length > 0 && <label>{t('chat.effort')}<select disabled={active} value={session.settings?.effort ?? ''}
          onChange={event => void perform('session-effort', () => window.workbench.updateSession(session.id, {
            settings: { ...session.settings, effort: event.target.value || undefined },
          }))}>
          <option value="">{t('chat.runtimeDefault')}</option>
          {efforts.map(effort => <option key={effort}>{effort}</option>)}
        </select>
      </label>}
      {provider?.capabilities.permissions && <label>{t('chat.permissions')}<select disabled={active} value={session.settings?.permission ?? 'review'}
          onChange={event => void perform('session-permission', () => window.workbench.updateSession(session.id, {
            settings: { ...session.settings, permission: event.target.value as 'review' | 'read-only' },
          }))}>
          <option value="review">{t('chat.reviewPermission')}</option>
          <option value="read-only">{t('common.readOnly')}</option>
        </select>
      </label>}
    </div>
    {availableSkills.length > 0 && <div className="session-skills">
      <span>{t('chat.skills')}</span>
      <div className="skills-select">
        {availableSkills.map(skill => <label key={skill.id} title={skill.description}>
          <input type="checkbox" disabled={active} checked={session.settings?.skillIds?.includes(skill.id) ?? false}
            onChange={event => void perform('session-skill', () => window.workbench.updateSession(session.id, {
              settings: {
                ...session.settings,
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

export function SessionChat({
  session, provider, perform, pending, draft, draftError, onDraftChange, workspaceId, sessions = [], openSession,
}: SessionChatProps) {
  const { t } = useTranslation('workspace');
  const [showActivity, setShowActivity] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const attachments = draft.attachments ?? [];
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
  const busy = pending.has(`send-${session.id}`);
  const messages = session.messages.filter(message => message.role !== 'activity' || message.event);
  const activity = session.messages.filter(message => message.role === 'activity' && !message.event);
  const matches = find?.trim()
    ? messages.filter(message => searchableMessageText(message).toLocaleLowerCase().includes(find.toLocaleLowerCase()))
    : [];
  const selectedMatch = matches[matchIndex % Math.max(matches.length, 1)];
  const children = sessions.filter(item => item.parentSessionId === session.id);
  const parent = sessions.find(item => item.id === session.parentSessionId);
  const nativeAgent = nativeAgentId
    ? messages.find(message => message.event?.kind === 'subagent' && message.event.nativeId === nativeAgentId)?.event
    : undefined;
  const nativeEvents = nativeAgentId
    ? messages.flatMap(message => message.event && (message.event.nativeId === nativeAgentId || message.event.parentId === nativeAgentId) ? [message.event] : [])
    : [];
  const outputRevision = useMemo(() => JSON.stringify({
    messages: session.messages,
    approvals: session.approvals,
    status: session.status,
    error: session.error,
  }), [session.messages, session.approvals, session.status, session.error]);
  const { containerRef: scroll, showJumpControl, markUserInput, handleScroll, scrollToBottom } =
    useClaudeScrollPinning([session.id, outputRevision]);

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

  useEffect(() => {
    if (!selectedMatch) return;
    markUserInput();
    scroll.current?.querySelector(`[data-message-id="${CSS.escape(selectedMatch.id)}"]`)?.scrollIntoView({
      block: 'center', behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [find, matchIndex]);

  const send = () => {
    const prompt = draft.text.trim();
    if ((!prompt && !attachments.length) || active || busy || sendLock.current || !provider?.available) return;
    sendLock.current = true;
    void perform(`send-${session.id}`, async () => {
      try {
        await window.workbench.sendPrompt(session.id, { text: prompt, attachments });
        if (currentDraft.current === draft) onDraftChange({ text: '' });
        scrollToBottom();
      } finally {
        sendLock.current = false;
      }
    });
  };

  return <section className="chat-pane" aria-label={session.title}>
    <header className="chat-toolbar">
      <div className="chat-toolbar-heading">
        <MessageCircle size={14} /><h2 title={session.title}>{session.title}</h2>
      </div>
      <Status value={session.status} />
      <div className="chat-toolbar-actions">
        <IconButton label={find === null ? t('chat.find') : t('chat.closeFind')} aria-pressed={find !== null}
          onClick={() => setFind(find === null ? '' : null)}><Search size={15} /></IconButton>
        <IconButton label={t('chat.settings')} aria-expanded={showSettings} aria-controls={settingsId}
          onClick={() => setShowSettings(value => !value)}><Settings2 size={15} /></IconButton>
        <button className={`text-button chat-activity-button ${showActivity ? 'selected' : ''}`}
          aria-expanded={showActivity} aria-controls={activityId} onClick={() => setShowActivity(value => !value)}>
          <Activity size={14} /><span className="chat-activity-label">{t('chat.activity')}</span>{activity.length > 0 && <span className="chat-count">{activity.length}</span>}
        </button>
        {active && <button className="text-button stop-action" disabled={pending.has(`cancel-${session.id}`)}
          onClick={() => void perform(`cancel-${session.id}`, () => window.workbench.cancelSession(session.id))}>
          <CircleStop size={14} />{t('common.stop')}</button>}
      </div>
    </header>

    <AnimatePresence initial={false}>
      {find !== null && <motion.div className="chat-reveal" key="find" initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={transition}>
        <div className="conversation-find">
          <Search size={15} />
          <input aria-label={t('chat.find')} value={find} autoFocus placeholder={t('chat.findPlaceholder')}
            onChange={event => { setFind(event.target.value); setMatchIndex(0); }}
            onKeyDown={event => {
              if (event.key === 'Escape') setFind(null);
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229 && matches.length) {
                setMatchIndex(value => event.shiftKey ? (value + matches.length - 1) % matches.length : value + 1);
              }
            }} />
          <small aria-live="polite">{matches.length ? `${matchIndex % matches.length + 1} / ${matches.length}` : '0'}</small>
          <IconButton label={t('chat.previousMatch')} disabled={!matches.length}
            onClick={() => setMatchIndex(value => (value + matches.length - 1) % matches.length)}><ArrowUp size={14} /></IconButton>
          <IconButton label={t('chat.nextMatch')} disabled={!matches.length}
            onClick={() => setMatchIndex(value => value + 1)}><ArrowDown size={14} /></IconButton>
          <IconButton label={t('chat.closeFind')} onClick={() => setFind(null)}><X size={14} /></IconButton>
        </div>
      </motion.div>}
    </AnimatePresence>
    <CollapsibleRegion expanded={showSettings} id={settingsId} className="chat-settings-region"
      regionRef={settingsRegion} onClose={() => setShowSettings(false)}>
      <SessionSettings session={session} provider={provider} workspaceId={workspaceId} active={active} visible={showSettings}
        perform={perform} openSession={openSession} onClose={() => setShowSettings(false)} />
    </CollapsibleRegion>

    <div className="message-scroll" ref={scroll} tabIndex={0} aria-label={t('chat.conversation')}
      onScroll={handleScroll} onWheel={markUserInput} onTouchStart={markUserInput}
      onKeyDown={event => {
        if (event.target === event.currentTarget && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markUserInput();
      }}>
      {(parent || children.length > 0) && <nav className="session-children" aria-label={t('chat.relatedSessions')}>
        {parent && <button onClick={() => openSession(parent.id)}><ArrowUpLeft size={13} />{t('chat.coordinator', { title: parent.title })}</button>}
        {children.map(child => <button key={child.id} onClick={() => openSession(child.id)}>
          <GitFork size={13} /><span>{child.title}</span><small>{child.providerId}</small><Status value={child.status} />
        </button>)}
      </nav>}
      {messages.length === 0
        ? <div className="conversation-empty">
          <div className="agent-mark"><PanelsTopLeft size={27} strokeWidth={1.5} /></div>
          <span className="conversation-empty-caption">{provider?.name ?? session.providerId} · {provider?.available ? t('chat.ready') : t('chat.notReady')}</span>
          <h2>{session.title}</h2>
          <p>{t('chat.describeTask', { provider: provider?.name ?? session.providerId })}</p>
          <div className="conversation-project"><FolderOpen size={14} /><code>{session.cwd}</code></div>
        </div>
        : <div className="messages">
          <AnimatePresence initial={false}>
            {messages.map((message, index) => <motion.article data-message-id={message.id} key={message.id}
              className={`message message-${message.role}${message.event ? ` message-process${messages[index - 1]?.event ? '' : ' process-start'}${messages[index + 1]?.event ? '' : ' process-end'}` : ''}${selectedMatch?.id === message.id ? ' conversation-match' : ''}`}
              initial={reducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }} transition={transition}>
              {message.event
                ? <ProcessCard event={message.event} openSession={openSession} openNativeAgent={setNativeAgentId} />
                : message.role === 'user'
                  ? <>
                    <div className="user-message">{message.text}
                      {message.attachments && <AttachmentChips attachments={message.attachments} />}
                    </div>
                    {!active && provider?.capabilities.rewind && message.nativeTurnId && <div className="message-tools">
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
                      }}>{message.text}</ReactMarkdown>
                      {!message.text && active && <span className="stream-cursor" />}
                    </div>
                    <div className="message-tools">
                      <CopyAnswer message={message} perform={perform} />
                      {!active && <button onClick={() => void perform('fork-session',
                        async () => openSession(await window.workbench.forkSession(session.id, message.id)))}>
                        <GitFork size={12} />{t('chat.forkHere')}</button>}
                    </div>
                  </>}
            </motion.article>)}
          </AnimatePresence>
        </div>}
      <div className="conversation-notices">
        <SessionProgress status={session.status} />
        {session.error && <div className="inline-error" role="alert"><CircleAlert size={15} /><span>{session.error}</span></div>}
        <AnimatePresence initial={false}>
          {session.approvals.map(approval => <motion.div key={approval.id}
            initial={reducedMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }} transition={transition}>
            <ApprovalCard approval={approval} pending={pending} perform={perform} />
          </motion.div>)}
        </AnimatePresence>
      </div>
    </div>

    <div className="chat-bottom">
      <AnimatePresence initial={false}>
        {showJumpControl && <motion.div className="jump-to-bottom-anchor" key="jump" initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={transition}>
          <button className="jump-to-bottom" onClick={() => scrollToBottom(!reducedMotion)}><ArrowDown size={14} />{t('chat.latestOutput')}</button>
        </motion.div>}
      </AnimatePresence>
      <CollapsibleRegion expanded={showActivity} id={activityId} className="chat-activity-region"
        regionRef={activityRegion} onClose={() => setShowActivity(false)}>
        <section className="activity-drawer">
          <header><span><Activity size={14} />{t('chat.activityLog')}<small>{activity.length}</small></span>
            <IconButton label={t('chat.closeActivity')} onClick={() => setShowActivity(false)}><ChevronDown size={15} /></IconButton>
          </header>
          <div className="activity-entries">
            {activity.length ? activity.map(message => <div className="activity-entry" key={message.id}>
              <span className="activity-dot" /><p>{message.text}</p>
              <time dateTime={message.createdAt}>{formatDate(message.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            </div>) : <p className="pane-note">{t('chat.activityEmpty')}</p>}
          </div>
        </section>
      </CollapsibleRegion>
      <div className="composer-area">
        <div className={`composer${active ? ' composer-task-active' : ''}`}>
          <AttachmentChips attachments={attachments}
            onRemove={busy ? undefined : id => onDraftChange({ ...currentDraft.current, attachments: attachments.filter(attachment => attachment.id !== id) })} />
          <textarea aria-label={t('chat.taskContent')} value={draft.text} rows={3} maxLength={200_000} disabled={busy}
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
              <IconButton label={t('chat.attach')} disabled={active || busy || attachments.length >= 8 || pending.has('attachments')}
                onClick={() => void perform('attachments', async () => {
                  const selected = await window.workbench.chooseAttachments();
                  onDraftChange({ ...currentDraft.current, attachments: [...(currentDraft.current.attachments ?? []), ...selected].slice(0, 8) });
                })}><Paperclip size={16} /></IconButton>
              <span className="composer-divider" />
              <button className="composer-model-button" title={t('chat.settings')} aria-expanded={showSettings} aria-controls={settingsId}
                onClick={() => setShowSettings(value => !value)}>
                <TerminalSquare size={14} />
                <span>{session.modelId ? modelName(provider, session.modelId) : provider?.name ?? session.providerId}</span>
                <ChevronDown size={12} />
              </button>
              {session.settings?.permission === 'read-only' && <span className="composer-permission"><ShieldCheck size={12} />{t('common.readOnly')}</span>}
            </div>
            <motion.button className="send-button" aria-label={t('chat.sendTask')}
              disabled={(!draft.text.trim() && !attachments.length) || active || busy || !provider?.available}
              whileTap={reducedMotion ? undefined : { scale: 0.98 }} transition={transition} onClick={send}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
            </motion.button>
          </div>
        </div>
        <div className="composer-caption">
          <span className="composer-project" title={session.cwd}><FolderOpen size={12} />{pathName(session.cwd)}</span>
          <UsageBadge usage={session.usage?.at(-1)} />
          <span className="composer-shortcut"><CornerDownLeft size={11} />{t('chat.send')}<span>·</span>{t('chat.newLine')}</span>
        </div>
        {draftError && <p className="composer-note" role="alert"><CircleAlert size={13} />{t('chat.draftError', { error: draftError })}<button className="text-button" onClick={() => onDraftChange(draft)}>{t('chat.retrySave')}</button></p>}
        {!provider?.available && <p className="composer-note"><CircleAlert size={13} />{t('chat.providerUnavailable')}</p>}
      </div>
    </div>

    {rewindMessage && <Modal title={t('chat.rewindTitle')} subtitle={t('chat.rewindDescription')}
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

function ProcessCard({ event, openSession, openNativeAgent }: {
  event: ProcessEvent;
  openSession: (id: string) => void;
  openNativeAgent: (id: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const icon = event.kind === 'plan' ? <ListChecks size={15} />
    : event.kind === 'subagent' || event.kind === 'task' ? <Users size={15} />
      : <TerminalSquare size={15} />;

  return <section className={`process-card process-${event.status}${expanded ? ' is-expanded' : ''}`}>
    <div className="process-heading">
      <span className="process-node" aria-hidden="true">
        {event.status === 'completed' ? <Check size={11} /> : event.status === 'failed' ? <CircleAlert size={13} /> : <span />}
      </span>
      <button className="process-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}>
        <span className="process-symbol">{icon}</span><strong>{event.title}</strong>
        <Status value={event.status} /><ChevronDown className="process-chevron" size={14} />
      </button>
      {(event.sessionId || (event.kind === 'subagent' && event.nativeId)) && <div className="process-links">
        {event.sessionId && <button onClick={() => openSession(event.sessionId!)}>{t('chat.openChild')}<ArrowUpLeft size={12} /></button>}
        {event.kind === 'subagent' && event.nativeId && <button onClick={() => openNativeAgent(event.nativeId!)}>{t('chat.openNative')}<ArrowUpLeft size={12} /></button>}
      </div>}
    </div>
    <CollapsibleRegion expanded={expanded} id={bodyId} className="process-reveal" onClose={() => setExpanded(false)}>
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
