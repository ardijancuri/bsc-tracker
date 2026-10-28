import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard';
import { leaderboardPresentation } from './leaderboardPresentation';
import { RealizedEstimateLabel, realizedEstimateDescription } from './RealizedEstimateLabel';
import { localDate, setLanguage } from './i18n';

const row = () => {
  const asOf = '2026-10-28T16:00:00.000Z', windowStart = '2026-10-27T16:00:00.000Z';
  const accounting: NodeLeaderboardSnapshot = { version: 1, policy: 'kollens_fifo_v1', realizedPolicy: 'sales_fifo_fees_v2',
    source: 'node', walletAddress: `0x${'1'.repeat(40)}`, snapshotId: 'a'.repeat(64), period: '24h', asOf, windowStart, windowEnd: asOf,
    coveredThroughBlock: '130000000', coveredThroughHash: `0x${'b'.repeat(64)}`, complete: false, reasons: ['unknown_costs'],
    realizedProfitUsd: null, knownRealizedProfitUsd: '12', estimatedRealizedProfitUsd: '44.25', valuedSellCount: 2, excludedSellCount: 1,
    valuedTransferOutCount: 0, excludedTransferOutCount: 0, estimate: { version: 1, policy: 'omit_unknown_costs_v1', basis: 'recorded_facts',
      asOf, windowStart, windowEnd: asOf, reasons: ['unknown_costs'], affectedSellCount: 1, missingCostCount: null,
      missingProceedsCount: null, missingFeeCount: null, unvaluedFeeOnlyCount: 0 } };
  return { accounting, tradeCount24h: 3, pnlQuality: 'estimated' as const, rankingProfitUsd: '44.25', estimatedRealizedProfitUsd: '44.25' };
};
afterEach(() => setLanguage('en'));

describe('realized estimate label on board and profile', () => {
  it('shows one short label with the same hover and accessible omission details', () => {
    const value = row(), profit = leaderboardPresentation(value), detail = realizedEstimateDescription(profit)!;
    const html = renderToStaticMarkup(<RealizedEstimateLabel profit={profit} />);
    expect(html).toContain('role="note"');
    expect(html).toContain('title="Missing costs excluded. Unknown proceeds and fees are excluded.');
    expect(html).toContain('aria-label="Estimated. Missing costs excluded.');
    expect(html.match(/>Estimated</g)).toHaveLength(1);
    expect(detail).toContain('Recorded sales affected: 1');
    expect(detail).toContain('Missing costs: Unavailable; proceeds: Unavailable; fees: Unavailable');
    expect(detail).toContain(localDate(value.accounting.windowStart));
    expect(detail).toContain(localDate(value.accounting.windowEnd));
    expect(detail).toContain(`As of ${localDate(value.accounting.asOf)}`);
    expect(html).not.toContain('P&amp;L pending');
    expect(html).not.toContain('ROI');
  });
  it('uses one shared label and period metadata for board and profile envelopes', () => {
    const value = row(), board = leaderboardPresentation(value), profile = leaderboardPresentation({ ...value, tradeCount24h: 3 });
    expect(board.value).toBe('44.25');
    expect(profile.value).toBe(board.value);
    expect(renderToStaticMarkup(<RealizedEstimateLabel profit={board} />)).toBe(renderToStaticMarkup(<RealizedEstimateLabel profit={profile} />));
    expect(value.accounting.realizedProfitUsd).toBeNull();
  });
  it('retains explicitly supplied omission counts and never substitutes unavailable counts with zero', () => {
    const value = row(); Object.assign(value.accounting.estimate!, { missingCostCount: 2, missingProceedsCount: 1, missingFeeCount: 3, unvaluedFeeOnlyCount: 4 });
    const text = realizedEstimateDescription(leaderboardPresentation(value));
    expect(text).toContain('Missing costs: 2; proceeds: 1; fees: 3');
    expect(text).toContain('Unvalued fee-only entries: 4');
  });
  it('translates the label, explanation and unavailable counts without changing the value', () => {
    setLanguage('zh-CN');
    const profit = leaderboardPresentation(row()), html = renderToStaticMarkup(<RealizedEstimateLabel profit={profit} />);
    expect(profit.value).toBe('44.25');
    expect(html).toContain('>估算</span>');
    expect(html).toContain('未扣除缺失的成本');
    expect(html).toContain('统计时段：');
    expect(html).toContain('截至');
    expect(html).not.toContain('Missing costs');
  });
  it('renders no estimate label for complete accounting or an unapproved partial subtotal', () => {
    const exact = row(); exact.accounting.complete = true; exact.accounting.realizedProfitUsd = '12';
    expect(renderToStaticMarkup(<RealizedEstimateLabel profit={leaderboardPresentation(exact)} />)).toBe('');
    expect(renderToStaticMarkup(<RealizedEstimateLabel profit={leaderboardPresentation({ ...row(), pnlQuality: 'unavailable' })} />)).toBe('');
  });
});
