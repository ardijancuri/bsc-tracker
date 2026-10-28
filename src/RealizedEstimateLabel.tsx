import { localDate, t } from './i18n';
import type { leaderboardPresentation } from './leaderboardPresentation';

type Profit = ReturnType<typeof leaderboardPresentation>;

export function realizedEstimateDescription(profit: Profit) {
  const estimate = profit.estimate;
  if (!estimate) return null;
  const count = (value: number | null) => value === null ? t('Unavailable') : value;
  return [
    t('Missing costs excluded. Unknown proceeds and fees are excluded.'),
    t('Recorded sales affected: {count} · Unvalued fee-only entries: {fees}', { count: estimate.affectedSellCount, fees: estimate.unvaluedFeeOnlyCount }),
    t('Missing costs: {costs}; proceeds: {proceeds}; fees: {fees}', { costs: count(estimate.missingCostCount), proceeds: count(estimate.missingProceedsCount), fees: count(estimate.missingFeeCount) }),
    t('Window: {start} — {end}', { start: localDate(estimate.windowStart), end: localDate(estimate.windowEnd) }),
    t('As of {time}', { time: localDate(estimate.asOf) }),
  ].join(' · ');
}

/** The visible label is shared by the board and profile; assistive technology
 * receives the same explanation as the native hover tooltip. */
export function RealizedEstimateLabel({ profit }: { profit: Profit }) {
  const description = realizedEstimateDescription(profit);
  if (!description) return null;
  return <span role="note" title={description} aria-label={`${t('Estimated')}. ${description}`}>{t('Estimated')}</span>;
}
