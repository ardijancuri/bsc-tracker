import { useEffect, useState } from 'react';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { getLocale, t } from './i18n';
import { gmgnRealizedPnlDescription, kolTokenPnlKey, requestKolTokenPnl, tokenPnlMovementsMatch, tokenRealizedPnlUnavailableNotice, verifiedTokenRealizedPnl, type KolTokenPnlResult } from './kolTokenPnlRequest';

export function KolTokenRealizedPnl({ walletAddress, tokenAddress, lastTradeAt }: {
  walletAddress: string; tokenAddress: string; lastTradeAt: string | null;
}) {
  const wallet = walletAddress.toLowerCase(), token = tokenAddress.toLowerCase();
  const pair = kolTokenPnlKey({ walletAddress: wallet, tokenAddress: token, lastTradeAt });
  const [result, setResult] = useState<{ pair: string; activity: KolTokenActivity | null; busy: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult(current => current?.pair === pair ? { ...current, busy: true } : { pair, activity: null, busy: true });
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setResult(current => current?.pair === pair ? { ...current, busy: true } : { pair, activity: null, busy: true });
      try {
        const loaded = await requestKolTokenPnl({ walletAddress: wallet, tokenAddress: token, lastTradeAt }, request.signal);
        if (active && controller === request) {
          setResult(current => tokenPnlStateAfterLoad(current, pair, loaded));
          timer = setTimeout(() => void refresh(), loaded.status === 'pending' ? Math.max(3000, loaded.retryAfterMs ?? 3000) : 60_000);
        }
      } catch {
        if (active && controller === request) {
          setResult(current => tokenPnlStateAfterLoad(current, pair, { activity: null, status: 'pending' }));
          timer = setTimeout(() => void refresh(), 5000);
        }
      }
    };
    void refresh();
    return () => { active = false; controller?.abort(); if (timer) clearTimeout(timer); };
  }, [wallet, token, pair, lastTradeAt]);

  const current = result?.pair === pair ? result : null;
  return <KolTokenRealizedPnlValue activity={current?.activity ?? null} busy={!current || current.busy} />;
}

export function KolTokenRealizedPnlValue({ activity, busy }: { activity: KolTokenActivity | null; busy: boolean }) {
  const amount = verifiedTokenRealizedPnl(activity) ?? NaN;
  const valid = Number.isFinite(amount);
  const color = valid ? amount > 0 ? 'positive' : amount < 0 ? 'negative' : '' : '';
  const formatted = valid ? new Intl.NumberFormat(getLocale(), {
    style: 'currency', currency: 'USD', notation: Math.abs(amount) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 2, signDisplay: 'exceptZero',
  }).format(amount) : busy ? '…' : '—';
  const title = valid ? t(gmgnRealizedPnlDescription(activity))
    : busy ? t('Loading GMGN realized P&L…') : t(tokenRealizedPnlUnavailableNotice(activity));

  return <span className="token-card-profit" title={title} aria-busy={busy}>
    <span>{t('Realized P&L')}</span><strong className={color}>{formatted}</strong>
  </span>;
}

export function tokenPnlStateAfterLoad(current: { pair: string; activity: KolTokenActivity | null; busy: boolean } | null,
  pair: string, loaded: KolTokenPnlResult) {
  const changedTrade = loaded.activity && current?.activity && Date.parse(loaded.activity.summary.lastTradeAt ?? '') !== Date.parse(current.activity.summary.lastTradeAt ?? '');
  const unchangedMovements = !loaded.activity || current?.activity && tokenPnlMovementsMatch(current.activity, loaded.activity);
  const retained = loaded.status === 'pending' && !changedTrade && unchangedMovements && current?.pair === pair
    && verifiedTokenRealizedPnl(current.activity) !== null ? current.activity : null;
  return { pair, activity: loaded.status === 'pending' ? retained ?? loaded.activity : loaded.activity, busy: loaded.status === 'pending' };
}
