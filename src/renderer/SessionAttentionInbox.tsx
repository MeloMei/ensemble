import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../shared/i18n';
import type { Session, Workspace } from '../shared/types';
import { AgentIcon } from './AgentIcon';
import { sessionAttentionReason } from './session-attention';
import { EmptyState, pathName, Status } from './ui';
import './SessionAttentionInbox.css';

const reasons = ['approval', 'failure', 'result'] as const;

export function SessionAttentionInbox({ sessions, workspaces, pending, openSession }: {
  sessions: Session[];
  workspaces: Workspace[];
  pending: Set<string>;
  openSession: (id: string) => void;
}) {
  const { t } = useTranslation('shell');
  const projects = new Map<string, Workspace>();
  for (const workspace of workspaces) {
    if (!projects.has(workspace.cwd) || !workspace.archived) projects.set(workspace.cwd, workspace);
  }
  const entries = sessions.flatMap(session => {
    const reason = sessionAttentionReason(session);
    if (!reason) return [];
    const updatedAt = session.attention?.reason === reason ? session.attention.updatedAt : session.updatedAt;
    return [{ session, reason, updatedAt }];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.session.id.localeCompare(b.session.id));

  if (!entries.length) return <EmptyState icon={<Inbox size={25} />} title={t('attention.inboxEmpty')}>{t('attention.inboxEmptyNote')}</EmptyState>;

  return <div className="history-page attention-inbox">
    {reasons.map(reason => {
      const group = entries.filter(entry => entry.reason === reason);
      if (!group.length) return null;
      return <section className="attention-inbox-group" key={reason} data-attention-reason={reason}>
        <h2>{t(`attention.inbox.${reason}`)} <small>{group.length}</small></h2>
        <ul className="history-list">
          {group.map(({ session, updatedAt }) => <li key={session.id}>
            <button className="history-open attention-inbox-row" data-session-id={session.id}
              disabled={pending.has(`open-session-${session.id}`)} onClick={() => openSession(session.id)}>
              <span className="history-icon"><AgentIcon providerId={session.providerId} size={16} /></span>
              <span className="history-row-title">
                <strong title={session.title}>{session.title}</strong>
                <small title={session.cwd}>{projects.get(session.cwd)?.name ?? pathName(session.cwd)}</small>
              </span>
              <Status value={session.status} />
              <time dateTime={updatedAt}>{Number.isFinite(Date.parse(updatedAt)) ? formatDate(updatedAt) : '—'}</time>
            </button>
          </li>)}
        </ul>
      </section>;
    })}
  </div>;
}
