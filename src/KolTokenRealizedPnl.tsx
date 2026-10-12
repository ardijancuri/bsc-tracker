import { useEffect, useState } from 'react';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { getLocale, t } from './i18n';

export function KolTokenRealizedPnl({ walletAddress, tokenAddress, lastTradeAt }: {
  walletAddress: string; tokenAddress: string; lastTradeAt: string | null;
}) {
  const wallet = walletAddress.toLowerCase(), token = tokenAddress.toLowerCase();
  const pair = `${wallet}:${token}`;
  const [result, setResult] = useState<{ pair: string; activity: KolTokenActivity | null } | null>(null);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    setResult(null);
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 20_000);
      try {
        const response = await fetch(`/api/kols/${encodeURIComponent(wallet)}/tokens/${encodeURIComponent(token)}/activity`, { signal: request.signal });
        if (!response.ok) throw new Error('Token P&L unavailable');
        const activity: KolTokenActivity = await response.json();
        if (activity.kol.address.toLowerCase() !== wallet || activity.token.address.toLowerCase() !== token) throw new Error('Token P&L mismatch');
        if (active && controller === request) setResult({ pair, activity });
      } catch {
        if (active && controller === request) setResult({ pair, activity: null });
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); };
  }, [wallet, token, pair, lastTradeAt]);

  const current = result?.pair === pair ? result : null;
  const activity = current?.activity;
  const value = activity?.coverage.complete ? activity.summary.realizedProfitUsd : null;
  const amount = value == null ? NaN : Number(value);
  const valid = Number.isFinite(amount);
  const color = valid ? amount > 0 ? 'positive' : amount < 0 ? 'negative' : '' : '';
  const formatted = valid ? new Intl.NumberFormat(getLocale(), {
    style: 'currency', currency: 'USD', notation: Math.abs(amount) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 2, signDisplay: 'exceptZero',
  }).format(amount) : current ? '—' : '…';
  const title = valid ? t('Realized P&L from indexed trades in this token. Gas fees are excluded.')
    : current ? t('Profit is unavailable where trade prices or purchase costs are missing.') : t('Loading trade details…');

  return <span className="token-card-profit" title={title} aria-busy={!current}>
    <span>{t('Realized P&L')}</span><strong className={color}>{formatted}</strong>
  </span>;
}
