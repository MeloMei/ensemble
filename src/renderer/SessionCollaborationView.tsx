import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Link2, MessageSquare, X } from 'lucide-react';
import type { SessionCollaboration, SessionCollaborationMessage, SessionCollaborationParticipant } from '../shared/collaboration';
import { formatDate, formatNumber } from '../shared/i18n';
import type { ProviderInfo, Session } from '../shared/types';
import { edgeFor, ExecutionGraph, graphNode, type GraphSelection } from './ExecutionGraph';
import { IconButton, pathName, relativeTime, Status, statusLabel } from './ui';

export function sessionCollaborationTitle(link: SessionCollaboration) {
  return link.participants.map(participant => participant.title).join(' · ');
}

export function SessionCollaborationView({ link, providers, sessions, openSession }: {
  link: SessionCollaboration; providers: ProviderInfo[]; sessions: Session[]; openSession: (id: string) => void;
}) {
  const { t } = useTranslation('collaboration');
  const [selection, setSelection] = useState<GraphSelection>();
  const [first, second] = link.participants;
  const participantFor = (id: string) => link.participants.find(participant => participant.sessionId === id);
  const providerName = (participant: SessionCollaborationParticipant) => providers.find(provider => provider.id === participant.providerId)?.name ?? participant.providerId;
  const directionLabel = ({ fromSessionId, toSessionId }: SessionCollaboration['grants'][number]) =>
    `${participantFor(fromSessionId)?.title ?? fromSessionId} → ${participantFor(toSessionId)?.title ?? toSessionId}`;
  const latest = link.messages[0];
  const participant = selection?.kind === 'participant' ? participantFor(selection.id) : undefined;
  const message = selection?.kind === 'message' ? link.messages.find(item => item.id === selection.id) : undefined;
  const showRoute = selection?.kind === 'relationship';
  const detailsOpen = Boolean(participant || message || showRoute);
  const route = edgeFor('message-route', first.sessionId, second.sessionId,
    latest ? t('session.latestMessage', { status: statusLabel(latest.status) }) : t('session.messageRoute'),
    latest ? { kind: 'message', id: latest.id } : { kind: 'relationship', id: link.id }, !link.grants.length);
  const arrow = route.markerEnd;
  route.markerEnd = link.grants.some(grant => grant.fromSessionId === first.sessionId) ? arrow : undefined;
  route.markerStart = link.grants.some(grant => grant.fromSessionId === second.sessionId) ? arrow : undefined;
  const graph = {
    nodes: link.participants.map(item => graphNode(item.sessionId, { kind: 'participant', title: item.title, subtitle: providerName(item), detail: pathName(item.cwd), recipientProviderId: item.providerId })),
    edges: [route],
  };
  const sessionLink = (item: SessionCollaborationParticipant) => {
    const available = sessions.some(session => session.id === item.sessionId);
    return <button key={item.sessionId} className="collaboration-detail-link" disabled={!available} onClick={() => openSession(item.sessionId)}>
      <MessageSquare size={13} />{t(available ? 'session.openNamed' : 'session.unavailableNamed', { title: item.title })}<ArrowUpRight size={13} />
    </button>;
  };
  const directions = link.grants.length ? link.grants.map(grant => <span key={grant.fromSessionId}>{directionLabel(grant)}</span>) : <span>{t('session.revoked')}</span>;
  const title = sessionCollaborationTitle(link);
  return <section className="collaboration-run-view session-collaboration-view">
    <header className="collaboration-run-heading"><div>
      <div className="collaboration-heading-kicker"><Link2 size={13} />{t('session.title')}</div>
      <h1 title={title}>{title}</h1>
      <p className="session-collaboration-routes"><strong>{t('session.permissions')}</strong>{directions}</p>
    </div></header>
    <div className="collaboration-graph-body">
      <ExecutionGraph graph={graph} view="session" ariaLabel={t('session.graph')} storageKey={`collaboration:session:${link.id}`} selection={selection} onSelect={setSelection} onPaneClick={() => setSelection(undefined)} />
      <aside className="collaboration-selection" aria-label={t('detail.label')} data-open={detailsOpen} aria-hidden={!detailsOpen} inert={!detailsOpen}>
        <header><strong>{participant?.title ?? t(message ? 'detail.message' : 'session.messageRoute')}</strong><IconButton label={t('detail.close')} onClick={() => setSelection(undefined)}><X size={15} /></IconButton></header>
        <div className="collaboration-selection-scroll">
          {participant && <><Details>
            <Field label={t('field.runtime')}>{providerName(participant)}</Field>
            <Field label={t('field.projectDirectory')}>{participant.cwd}</Field>
          </Details>{sessionLink(participant)}</>}
          {message && <SessionMessageDetails key={message.id} message={message} direction={directionLabel(message)}>
            {[participantFor(message.fromSessionId), participantFor(message.toSessionId)].map(item => item && sessionLink(item))}
          </SessionMessageDetails>}
          {showRoute && <><Details><Field label={t('session.permissions')}><div className="collaboration-permission-summary">{directions}</div></Field></Details>{link.participants.map(sessionLink)}</>}
        </div>
      </aside>
    </div>
    <section className="collaboration-timeline" aria-label={t('session.messages')}>
      <div className="collaboration-timeline-heading"><MessageSquare size={13} /><strong>{t('session.messages')}</strong><span>{formatNumber(link.messages.length)}</span></div>
      <div className="collaboration-timeline-events">
        {link.messages.length ? <div className="collaboration-timeline-list session-collaboration-messages">
          {link.messages.map(item => <button type="button" key={item.id} aria-current={message?.id === item.id ? true : undefined} className={message?.id === item.id ? 'selected' : undefined} onClick={() => setSelection({ kind: 'message', id: item.id })}>
            <strong className="event-participants" title={directionLabel(item)}>{directionLabel(item)}</strong><span className="session-message-preview">{item.text}</span><Status value={item.status} /><time dateTime={item.createdAt} title={formatDate(item.createdAt)}>{relativeTime(item.createdAt)}</time>
          </button>)}
        </div> : <p>{t(link.grants.length ? 'session.waitingForMessage' : 'session.noMessages')}</p>}
      </div>
    </section>
  </section>;
}

function SessionMessageDetails({ message, direction, children }: { message: SessionCollaborationMessage; direction: string; children: ReactNode }) {
  const { t } = useTranslation('collaboration');
  const { id } = message;
  const version = JSON.stringify([message.status, message.delivery, message.continuation, message.reply, message.error]);
  const [loaded, setLoaded] = useState<{ version: string; message?: SessionCollaborationMessage }>();
  useEffect(() => {
    let active = true;
    void (window.workbench.collaborationCall('get_session_handoff', { id }) as Promise<SessionCollaborationMessage>).then(
      value => { if (active) setLoaded({ version, message: value }); },
      () => { if (active) setLoaded({ version }); },
    );
    return () => { active = false; };
  }, [id, version]);
  const result = loaded?.version === version ? loaded : undefined;
  const { text, reply, error } = result?.message ?? message;
  return <>
    <Details>
      <Field label={t('message.direction')}>{direction}</Field>
      <Field label={t('session.messageStatus')}><Status value={message.status} /></Field>
      {message.delivery && <Field label={t('message.delivery')}>{t(`session.delivery.${message.delivery}`)}</Field>}
      <Field label={t('session.sentAt')}><time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time></Field>
      <Field label={t('message.content')}><pre>{text}</pre></Field>
      {reply !== undefined && <Field label={t('session.reply')}><pre>{reply}</pre></Field>}
      {message.continuation && <Field label={t('session.continuation')}><Status value={message.continuation} /></Field>}
      {error && <Field label={t('session.error')}><pre>{error}</pre></Field>}
    </Details>
    {!result?.message && <p className="collaboration-observation-note">{t(result ? 'session.detailUnavailable' : 'session.loadingDetail')}</p>}
    {children}
  </>;
}

function Details({ children }: { children: ReactNode }) { return <dl className="session-collaboration-details">{children}</dl>; }

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="collaboration-detail-field"><dt>{label}</dt><dd>{children}</dd></div>;
}
