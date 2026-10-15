import { useEffect, useRef, useState, type Ref } from 'react';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { getLocale, t } from './i18n';
import { displayedTokenPnl, kolTokenPnlKey, requestKolTokenPnl, terminalTokenInventoryFailure, tokenPnlExpiresAt, tokenPnlMayRetainDuringProviderRetry, tokenPnlMovementsMatch, tokenPnlRefreshDelay, tokenPositionPnlDelayedNotice, tokenPositionPnlDescription, tokenPositionPnlLabel, tokenPositionPnlLoadingNotice, tokenPositionPnlPriceTime, tokenPositionPnlUnavailableNotice, type KolTokenPnlResult } from './kolTokenPnlRequest';

interface TokenPnlState { pair: string; activity: KolTokenActivity | null; busy: boolean; delayed?: boolean }

export function KolTokenRealizedPnl({ walletAddress, tokenAddress, lastTradeAt, eager = false }: {
  walletAddress: string; tokenAddress: string; lastTradeAt: string | null; eager?: boolean;
}) {
  const wallet = walletAddress.toLowerCase(), token = tokenAddress.toLowerCase();
  const pair = kolTokenPnlKey({ walletAddress: wallet, tokenAddress: token, lastTradeAt });
  const [result, setResult] = useState<TokenPnlState | null>(null);
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(eager || typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (eager || typeof IntersectionObserver === 'undefined' || !element.current) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '160px 0px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutivePending = 0;
    setResult(current => current?.pair === pair ? { ...current, busy: true } : { pair, activity: null, busy: true });
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setResult(current => current?.pair === pair ? { ...current, busy: !current.delayed } : { pair, activity: null, busy: true });
      try {
        const loaded = await requestKolTokenPnl({ walletAddress: wallet, tokenAddress: token, lastTradeAt }, request.signal,
          { onActivity: activity => { if (active && controller === request) setResult(current => tokenPnlStateAfterLoad(current, pair, { activity, status: 'pending' })); } });
        if (active && controller === request) {
          setResult(current => tokenPnlStateAfterLoad(current, pair, loaded, true));
          consecutivePending = loaded.status === 'pending' ? consecutivePending + 1 : 0;
          timer = setTimeout(() => void refresh(), tokenPnlRefreshDelay(loaded, consecutivePending));
        }
      } catch {
        if (active && controller === request) {
          const pending: KolTokenPnlResult = { activity: null, status: 'pending' };
          setResult(current => tokenPnlStateAfterLoad(current, pair, pending, true));
          timer = setTimeout(() => void refresh(), tokenPnlRefreshDelay(pending, ++consecutivePending));
        }
      }
    };
    void refresh();
    return () => { active = false; controller?.abort(); if (timer) clearTimeout(timer); };
  }, [wallet, token, pair, lastTradeAt, visible]);

  const current = result?.pair === pair ? result : null;
  const expiresAt = tokenPnlExpiresAt(current?.activity ?? null);
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => setResult(value => value?.pair === pair ? { ...value } : value), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pair, expiresAt]);
  return <KolTokenRealizedPnlValue elementRef={element} activity={current?.activity ?? null} busy={!current || current.busy} delayed={current?.delayed} />;
}

export function KolTokenRealizedPnlValue({ activity, busy, delayed = false, elementRef }: { activity: KolTokenActivity | null; busy: boolean; delayed?: boolean; elementRef?: Ref<HTMLSpanElement> }) {
  const amount = displayedTokenPnl(activity) ?? NaN;
  const valid = Number.isFinite(amount);
  const color = valid ? amount > 0 ? 'positive' : amount < 0 ? 'negative' : '' : '';
  const formatted = valid ? new Intl.NumberFormat(getLocale(), {
    style: 'currency', currency: 'USD', notation: Math.abs(amount) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 2, signDisplay: 'exceptZero',
  }).format(amount) : delayed ? t('Pending') : busy ? '…' : '—';
  const priceTime = tokenPositionPnlPriceTime(activity);
  const title = valid ? t(tokenPositionPnlDescription(activity)) + (priceTime ? ' ' + t('Price as of {time} UTC.', { time: priceTime }) : '')
    : delayed ? t(tokenPositionPnlDelayedNotice) : busy ? t(tokenPositionPnlLoadingNotice(activity)) : t(tokenPositionPnlUnavailableNotice(activity));

  return <span ref={elementRef} className="token-card-profit" title={title} aria-busy={busy}>
    <span>{t(tokenPositionPnlLabel(activity))}</span><strong className={color}>{formatted}</strong>
  </span>;
}

export function tokenPnlStateAfterLoad(current: TokenPnlState | null,
  pair: string, loaded: KolTokenPnlResult, completed = false): TokenPnlState {
  const delayed = loaded.status === 'pending' && (completed || current?.pair === pair && !!current.delayed);
  const busy = loaded.status === 'pending' && !delayed;
  if (terminalTokenInventoryFailure(loaded.activity)) return { pair, activity: loaded.activity, busy: false };
  // A fresh realized-only response also renews canonical proof. Keeping the
  // older object here would let its proof expire during a prolonged quote
  // outage even though the server keeps returning verified historical gains.
  if (displayedTokenPnl(loaded.activity) !== null) return { pair, activity: loaded.activity, busy, delayed };
  const changedTrade = loaded.activity && current?.activity && Date.parse(loaded.activity.summary.lastTradeAt ?? '') !== Date.parse(current.activity.summary.lastTradeAt ?? '');
  const unchangedMovements = !loaded.activity || current?.activity && (tokenPnlMovementsMatch(current.activity, loaded.activity)
    || tokenPnlMayRetainDuringProviderRetry(current.activity, loaded.activity));
  const retained = loaded.status === 'pending' && !changedTrade && unchangedMovements && current?.pair === pair
    && displayedTokenPnl(current.activity) !== null ? current.activity : null;
  return { pair, activity: loaded.status === 'pending' ? retained ?? loaded.activity : loaded.activity, busy, delayed };
}
