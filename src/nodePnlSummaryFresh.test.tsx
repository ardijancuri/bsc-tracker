import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeAccountingSummary } from '../shared/nodeAccounting';
import { nodeSummaryDisplay } from './nodePnlSummaryRequest';
import { KolTokenRealizedPnl, nodeSummaryRefreshDelay, nodeSummaryUnavailableLabel } from './KolTokenRealizedPnl';
const now = Date.parse('2026-10-22T12:00:00Z'), wallet = `0x${'1'.repeat(40)}`, token = `0x${'7'.repeat(40)}`;
function summary(open = false): NodeAccountingSummary {
  return { tokenAddress: token, walletAddress: wallet, tracking: { version: 1, source: 'fresh', fromBlock: '100', utcDay: '2026-10-22' },
    snapshot: { version: 2, snapshotId: 'a'.repeat(64), source: 'node', scope: 'public', asOf: '2026-10-21T11:00:00Z', historyFingerprint: 'b'.repeat(64), historyFrom: '2026-10-20T00:00:00Z', coveredThroughBlock: '200', valuationBlock: open ? '200' : null, valuationHash: open ? `0x${'c'.repeat(64)}` : null, complete: true, reasons: [] },
    status: 'ready', realizedStatus: 'ready', position: open ? 'open' : 'closed', realizedProfitUsd: '38', estimatedProfitUsd: open ? '78' : '38', roi: '0.38', remainingTokenAmount: open ? '10' : '0', valueUsd: open ? '100' : '0', quotedAt: open ? new Date(now).toISOString() : null };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('server-approved compact fresh card summaries', () => {
  it('shows verified imported-and-node totals without bypassing completeness or scope checks', () => {
    const value=summary();value.snapshot!.source='mixed';
    expect(nodeSummaryDisplay(value,wallet,token,now,{realizedOnly:true})).toEqual({value:38,kind:'realized'});
    value.snapshot!.complete=false;expect(nodeSummaryDisplay(value,wallet,token,now).value).toBeNull();
    value.snapshot!.complete=true;value.snapshot!.scope='portfolio';expect(nodeSummaryDisplay(value,wallet,token,now).value).toBeNull();
  });
  it('shows dated closed profit immediately and uses ordinary bounded refresh instead of an old-quote rescan', () => {
    const value = summary(); expect(nodeSummaryDisplay(value, wallet, token)).toEqual({ value: 38, kind: 'realized' }); expect(nodeSummaryRefreshDelay(value)).toBe(60_000);
    const html = renderToStaticMarkup(<KolTokenRealizedPnl walletAddress={wallet} tokenAddress={token} lastTradeAt={value.snapshot!.asOf} initialSummary={value} />);
    expect(html).toContain('+$38'); expect(html).toContain('Realized P&amp;L');
    vi.advanceTimersByTime(5 * 86_400_000); expect(nodeSummaryDisplay(value, wallet, token).value).toBe(38);
  });
  it('uses quote time for open estimates and retains approved realized cash under its own label when the quote expires', () => {
    const value = summary(true); expect(nodeSummaryDisplay(value, wallet, token)).toEqual({ value: 78, kind: 'estimated' });
    vi.advanceTimersByTime(120_001); expect(nodeSummaryDisplay(value, wallet, token)).toEqual({ value: 38, kind: 'realized' });
    const html = renderToStaticMarkup(<KolTokenRealizedPnl walletAddress={wallet} tokenAddress={token} lastTradeAt={value.snapshot!.asOf} initialSummary={value} />);
    expect(html).toContain('+$38'); expect(html).toContain('Realized P&amp;L'); expect(html).not.toContain('Est. profit');
    value.status = 'pending'; value.estimatedProfitUsd = null; value.snapshot!.refreshStatus = 'pending'; expect(nodeSummaryDisplay(value, wallet, token).value).toBe(38);
  });
  it('shows stored realized profit on a fresh token card even while a different open-position estimate is available', () => {
    const value = summary(true);
    const html = renderToStaticMarkup(<KolTokenRealizedPnl walletAddress={wallet} tokenAddress={token} lastTradeAt={value.snapshot!.asOf} initialSummary={value} />);
    expect(html).toContain('+$38'); expect(html).not.toContain('+$78'); expect(html).toContain('Realized P&amp;L'); expect(html).not.toContain('Est. profit');
    value.status = 'pending'; value.quotedAt = null; value.estimatedProfitUsd = null;
    expect(nodeSummaryDisplay(value, wallet, token, now, { realizedOnly: true })).toEqual({ value: 38, kind: 'realized' });
  });
  it.each([['unknown_costs', 'Cost unknown'], ['unknown_fees', 'Fee unknown'], ['wallet_decode_gap', 'History incomplete'], ['balance_mismatch', 'Balance mismatch'], ['decoding_pending', 'Evidence needed']])('explains %s without an endless generic pending label', (reason, label) => {
    const value = summary(); value.realizedStatus = 'pending'; value.realizedProfitUsd = null; value.status = 'pending'; value.reason = reason; value.snapshot!.reasons = [reason]; value.snapshot!.complete = false;
    expect(nodeSummaryUnavailableLabel(value)).toBe(label);
    const html = renderToStaticMarkup(<KolTokenRealizedPnl walletAddress={wallet} tokenAddress={token} lastTradeAt={null} initialSummary={value} />);
    expect(html).toContain(label); expect(html).not.toContain('aria-busy="true"'); expect(html).not.toContain('+$38');
  });
  it.each(['balance_pending', 'wallet', 'token', 'private', 'undated', 'version', 'zero_unknown', 'coverage', 'inconsistent_ready', 'contradictory_cost', 'contradictory_balance', 'top_level_fee', 'unknown_sale_value'] as const)('does not paint an unapproved %s amount', variant => {
    const value = summary();
    if (variant === 'balance_pending') { value.status = 'pending'; value.realizedStatus = 'pending'; value.snapshot!.complete = false; }
    if (variant === 'wallet') value.walletAddress = token;
    if (variant === 'token') value.tokenAddress = wallet;
    if (variant === 'private') value.snapshot!.scope = 'portfolio';
    if (variant === 'undated') value.snapshot!.asOf = '';
    if (variant === 'version') (value.tracking as any).version = 2;
    if (variant === 'zero_unknown') { value.realizedProfitUsd = '0'; value.realizedStatus = 'unavailable'; value.status = 'unavailable'; }
    if (variant === 'coverage') value.snapshot!.coveredThroughBlock = '99';
    if (variant === 'inconsistent_ready') value.snapshot!.complete = false;
    if (variant === 'contradictory_cost') value.snapshot!.reasons = ['unknown_costs'];
    if (variant === 'contradictory_balance') value.snapshot!.reasons = ['balance_mismatch'];
    if (variant === 'top_level_fee') value.reason = 'unknown_fees';
    if (variant === 'unknown_sale_value') value.reason = 'unknown_sale_value';
    expect(nodeSummaryDisplay(value, wallet, token).value).toBeNull();
    expect(renderToStaticMarkup(<KolTokenRealizedPnl walletAddress={wallet} tokenAddress={token} lastTradeAt={null} initialSummary={value} />)).not.toMatch(/\+\$38|\$0/);
  });
  it('rejects an entire cross-wallet/public-private batch before caching or resolving any card', async () => {
    vi.resetModules(); const { requestNodePnlSummary } = await import('./nodePnlSummaryRequest');
    const body = summary(); body.snapshot!.scope = 'portfolio'; const fetcher = vi.fn(async () => Response.json({ summaries: { [token]: body } })); vi.stubGlobal('fetch', fetcher);
    await expect(requestNodePnlSummary(wallet, token, new AbortController().signal)).rejects.toThrow('identity');
    body.snapshot!.scope = 'public'; const next = await requestNodePnlSummary(wallet, token, new AbortController().signal); expect(next.tokenAddress).toBe(token); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
