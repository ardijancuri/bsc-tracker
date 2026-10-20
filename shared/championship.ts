export type ChampionshipPeriod = 'daily' | 'overall';

export interface ChampionshipTrader {
  rank: number;
  id: string;
  xHandle: string;
  name: string;
  avatarUrl: string | null;
  verified: boolean;
  liveUrl: string | null;
  isLive: boolean;
  pnlUsd: string | null;
  /** GMGN supplies a ratio: 1.25 means 125%. */
  roi: string | null;
}

export interface ChampionshipSnapshot {
  period: ChampionshipPeriod;
  date: string | null;
  items: ChampionshipTrader[];
  updatedAt: string;
  fetchedAt: string;
}

export interface ChampionshipBoard extends ChampionshipSnapshot {
  freshness: 'live' | 'saved';
  upstreamBlocked: boolean;
  sourceUrl: string;
}

// Verified against GMGN's public global_championship/list response.
export const championship = {
  id: 'ggc-s1',
  startsAt: '2026-10-17T00:00:00.000Z',
  endsAt: '2026-10-27T00:00:00.000Z',
  sourceUrl: 'https://gmgn.ai/ggc?ch=webmenu&chain=bsc',
} as const;

export const championshipLimit = 20;
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const championshipLastDay = (now = Date.now()) => utcDay(Math.min(now, Date.parse(championship.endsAt) - 1));
export const championshipFirstDay = championship.startsAt.slice(0, 10);

export function validChampionshipDate(value: string, now = Date.now()) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && utcDay(Date.parse(value)) === value && value >= championshipFirstDay && value <= championshipLastDay(now);
}

export function championshipApiUrl(period: ChampionshipPeriod, date: string | null) {
  const url = new URL(`/pf/api/v1/global_championship/${period === 'daily' ? 'daily_leaderboard' : 'leaderboard'}`, 'https://gmgn.ai');
  url.searchParams.set('championship_id', championship.id);
  if (period === 'daily' && date) url.searchParams.set('date', date.replaceAll('-', ''));
  return url.href;
}
