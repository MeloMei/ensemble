import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderInfo, Session } from '../shared/types';
import { DetailCard } from './ui-kit/DetailCard';
import { Status, relativeTime, statusLabel } from './ui';

export function SessionDetailCard({ session, provider, side, children }: {
  session: Session;
  provider?: ProviderInfo;
  side: 'right' | 'bottom';
  children: ReactElement;
}) {
  const { t } = useTranslation('shell');
  const runtime = provider?.name ?? session.providerId;
  const approvalCount = session.approvals.length;
  const trace = session.latestTrace;
  const updated = relativeTime(session.updatedAt);
  const description = [
    session.title,
    runtime,
    statusLabel(session.status),
    approvalCount ? `${t('sessionPreview.approvals')} ${approvalCount}` : undefined,
    trace && `${t('sessionPreview.trace')} · ${trace.title} · ${statusLabel(trace.status)}`,
    `${t('sessionPreview.updated')} · ${updated}`,
  ].filter(Boolean).join(' · ');
  return <DetailCard side={side} title={session.title || runtime} description={description} details={<>
    <dt>{t('sessionPreview.runtime')}</dt><dd>{runtime}</dd>
    <dt>{t('sessionPreview.status')}</dt><dd><Status value={session.status} /></dd>
    {approvalCount > 0 && <><dt>{t('sessionPreview.approvals')}</dt><dd>{approvalCount}</dd></>}
    {trace && <><dt>{t('sessionPreview.trace')}</dt><dd>{trace.title} <Status value={trace.status} /></dd></>}
    <dt>{t('sessionPreview.updated')}</dt><dd>{updated}</dd>
  </>}>{children}</DetailCard>;
}
