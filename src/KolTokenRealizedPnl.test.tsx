import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { KolTokenRealizedPnlValue, tokenPnlStateAfterLoad } from './KolTokenRealizedPnl';

const activity = (value: string | null, lastTradeAt = '2026-10-14T12:00:00Z') => ({ coverage: { complete: true },
  summary: { realizedProfitUsd: value, lastTradeAt } }) as KolTokenActivity;
describe('KOL token realized profit display', () => {
  it('shows pending verification as loading rather than falsely diagnosing missing purchase costs', () => {
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity(null)} busy />);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('Loading trade details'); expect(html).toContain('…');
    expect(html).not.toContain('purchase costs are missing');
    const missing = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity(null)} busy={false} />);
    expect(missing).toContain('aria-busy="false"'); expect(missing).toContain('purchase costs are missing'); expect(missing).toContain('—');
  });
  it('preserves a verified value only for the same selection through a transient refresh', () => {
    const previous = { pair: 'wallet:token:last-trade', activity: activity('30'), busy: false };
    const pending = tokenPnlStateAfterLoad(previous, previous.pair, { activity: null, status: 'pending' });
    expect(pending.activity).toBe(previous.activity); expect(pending.busy).toBe(true);
    const html = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={pending.activity} busy={pending.busy} />);
    expect(html).toContain('+$30'); expect(html).toContain('positive');
    expect(tokenPnlStateAfterLoad(previous, 'wallet:token:new-last-trade', { activity: null, status: 'pending' }).activity).toBeNull();
    expect(tokenPnlStateAfterLoad(previous, previous.pair, { activity: null, status: 'unavailable' }).activity).toBeNull();
    expect(tokenPnlStateAfterLoad(previous, previous.pair, { activity: activity(null, '2026-10-14T12:01:00Z'), status: 'pending' }).activity).toBeNull();
  });
  it('keeps zero and losses visible instead of treating them as missing profit', () => {
    const zero = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity('0')} busy={false} />);
    expect(zero).toContain('$0'); expect(zero).not.toContain('—');
    const loss = renderToStaticMarkup(<KolTokenRealizedPnlValue activity={activity('-81.5')} busy={false} />);
    expect(loss).toContain('-$81.50'); expect(loss).toContain('negative');
  });
});
