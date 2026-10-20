import type { NodeAccountingSnapshotIdentity } from '../shared/nodeAccounting';
import { t } from './i18n';

export function isCapturedPosition(snapshot: NodeAccountingSnapshotIdentity | null | undefined) {
  return snapshot?.historyBoundary === 'verified_zero_position';
}

/** This result covers the reconciled position, not unknown earlier closed cycles. */
export function capturedPositionDescription(snapshot: NodeAccountingSnapshotIdentity | null | undefined) {
  if (!isCapturedPosition(snapshot)) return null;
  const from = Date.parse(snapshot?.historyFrom ?? '');
  return Number.isFinite(from)
    ? t('Profit since the verified zero balance on {time} UTC. Includes transfers and wallet-paid fees; earlier closed trades are excluded.', {
      time: new Date(from).toISOString().replace('T', ' ').slice(0, 19),
    })
    : t('Profit covers the captured position, including transfers and wallet-paid fees. Earlier closed trades are excluded.');
}
