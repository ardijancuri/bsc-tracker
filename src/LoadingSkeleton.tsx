import type { ReactNode } from 'react';
import { t } from './i18n';
import './loadingSkeleton.css';

export function SkeletonBlock({ width, height, className = '' }: { width?: number | string; height?: number | string; className?: string }) {
  return <span className={`skeleton-block ${className}`} style={{ width, height }} aria-hidden="true" />;
}

export function LoadingStatus({ label = 'Loading…' }: { label?: string }) {
  return <span className="skeleton-status" role="status">{t(label)}</span>;
}

export function LoadingSkeleton({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return <><LoadingStatus label={label} /><div className={className} aria-hidden="true">{children}</div></>;
}

export function IdentitySkeleton({ token = false, subtitle = false, width = 94 }: { token?: boolean; subtitle?: boolean; width?: number }) {
  return <span className="identity skeleton-identity" aria-hidden="true">
    <SkeletonBlock className={token ? 'token-avatar' : 'avatar'} />
    <span className="identity-copy"><SkeletonBlock width={width} height={13} />{subtitle && <SkeletonBlock width={62} height={9} />}</span>
  </span>;
}

export function TradeRowsSkeleton({ count = 5, showSide = true }: { count?: number; showSide?: boolean }) {
  return <LoadingSkeleton label="Loading trades…">{Array.from({ length: count }, (_, index) => <div className="trade-row skeleton-row" key={index}>
    <div className="trade-kol"><IdentitySkeleton width={index % 2 ? 72 : 98} /></div>
    <div className="trade-activity">{showSide && <SkeletonBlock className="side-pill" width={32} height={9} />}<IdentitySkeleton token width={index % 2 ? 52 : 68} /></div>
    <div className="trade-value"><SkeletonBlock width={65} height={12} /><SkeletonBlock className="trade-amount" width={38} height={9} /></div>
    <div className="trade-time"><SkeletonBlock width={42} height={10} /></div>
  </div>)}</LoadingSkeleton>;
}

export function LeaderboardSkeleton() {
  return <LoadingSkeleton>{Array.from({ length: 6 }, (_, index) => <div className="leaderboard-entry" key={index}>
    <div className="leaderboard-row skeleton-row">
      <span className="rank-number"><SkeletonBlock width={16} height={12} /></span>
      <span className="leader-identity"><IdentitySkeleton width={index % 2 ? 86 : 120} /><span className="leader-handle"><SkeletonBlock width={66} height={9} /></span></span>
      <span className="leader-activity"><SkeletonBlock width={75} height={12} /><span className="leader-sides"><SkeletonBlock width={90} height={9} /></span></span>
      <span className="pnl"><SkeletonBlock width={72} height={14} /><span className="pnl-status"><SkeletonBlock width={100} height={9} /></span></span>
    </div>
  </div>)}</LoadingSkeleton>;
}

export function TokenCardsSkeleton({ className, recentTrades = false, count = 3 }: { className: string; recentTrades?: boolean; count?: number }) {
  return <LoadingSkeleton label="Loading tokens…" className={className}>{Array.from({ length: count }, (_, index) => <div className="token-card skeleton-row" key={index}>
    <div className="token-card-main">
      <div className="token-card-top"><IdentitySkeleton token subtitle width={index % 2 ? 84 : 112} /></div>
      <div className="token-card-stats">{[52, 70, 45].map(width => <div key={width}><SkeletonBlock width={width} height={9} /><SkeletonBlock width={width - 8} height={13} /></div>)}</div>
    </div>
    {recentTrades && <div className="token-card-trades">{Array.from({ length: 2 }, (_, row) => <div className="token-card-trade" key={row}>
      <IdentitySkeleton width={68} /><SkeletonBlock width={18} height={8} /><SkeletonBlock width={46} height={9} /><SkeletonBlock width={28} height={8} />
    </div>)}</div>}
  </div>)}</LoadingSkeleton>;
}

export function WatchRowsSkeleton({ token = false, holder = false }: { token?: boolean; holder?: boolean }) {
  return <LoadingSkeleton className={holder ? 'skeleton-holder-list' : undefined}>{Array.from({ length: 4 }, (_, index) => <div className={holder ? 'kol-holder-row skeleton-row skeleton-holder' : 'watch-row skeleton-row'} key={index}>
    <IdentitySkeleton token={token} subtitle width={index % 2 ? 85 : 105} /><SkeletonBlock width={45} height={11} />
  </div>)}</LoadingSkeleton>;
}
