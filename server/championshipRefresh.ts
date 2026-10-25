import { championshipLastDay, type ChampionshipBoard, type ChampionshipPeriod } from '../shared/championship.js';

type RefreshService = {
  get(period: ChampionshipPeriod, date: string | null, options: { refresh: true }): Promise<ChampionshipBoard>;
};
type BoardOutcome = 'idle' | 'live' | 'saved' | 'blocked' | 'unavailable';
type CycleOutcome = 'disabled' | 'idle' | 'success' | 'saved' | 'blocked' | 'failed';
export interface ChampionshipRefreshBoardStatus {
  date: string | null;
  outcome: BoardOutcome;
  providerUpdatedAt: string | null;
  fetchedAt: string | null;
}
export interface ChampionshipRefreshStatus {
  enabled: boolean;
  intervalHours: number | null;
  running: boolean;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastOutcome: CycleOutcome;
  boards: Record<ChampionshipPeriod, ChampionshipRefreshBoardStatus>;
}

/** Unset means disabled; a mistyped production schedule must fail startup. */
export function championshipAutoRefreshHours(value: string | undefined) {
  if (value === undefined || value.trim() === '') return null;
  const hours = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(hours) || hours < 1 || hours > 24) {
    throw new Error('CHAMPIONSHIP_AUTO_REFRESH_HOURS must be a whole number from 1 to 24');
  }
  return hours;
}

/** One API-owned cycle at a time, independent of page traffic or desktop tasks. */
export function createChampionshipRefresh({ service, intervalHours, now = Date.now, onCycle }:
  { service: RefreshService; intervalHours: number | null; now?: () => number;
    onCycle?: (status: ChampionshipRefreshStatus) => void }) {
  if (intervalHours !== null && (!Number.isSafeInteger(intervalHours) || intervalHours < 1 || intervalHours > 24)) {
    throw new Error('Invalid championship refresh interval');
  }
  let active = false, stopped = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let lastAttemptAt: string | null = null, lastCompletedAt: string | null = null;
  let lastSuccessAt: string | null = null, nextAttemptAt: string | null = null;
  let lastOutcome: CycleOutcome = intervalHours === null ? 'disabled' : 'idle';
  const emptyBoard = (date: string | null): ChampionshipRefreshBoardStatus =>
    ({ date, outcome: 'idle', providerUpdatedAt: null, fetchedAt: null });
  const boards: Record<ChampionshipPeriod, ChampionshipRefreshBoardStatus> = {
    daily: emptyBoard(championshipLastDay(now())), overall: emptyBoard(null),
  };
  const status = (): ChampionshipRefreshStatus => ({ enabled: intervalHours !== null, intervalHours, running,
    lastAttemptAt, lastCompletedAt, lastSuccessAt, nextAttemptAt, lastOutcome,
    boards: { daily: { ...boards.daily }, overall: { ...boards.overall } } });

  async function refreshBoard(period: ChampionshipPeriod, date: string | null) {
    try {
      const board = await service.get(period, date, { refresh: true });
      boards[period] = { date, outcome: board.upstreamBlocked ? 'blocked' : board.freshness === 'live' ? 'live' : 'saved',
        providerUpdatedAt: board.updatedAt, fetchedAt: board.fetchedAt };
    } catch {
      // Preserve the prior timestamp only for this exact board; never attach yesterday's data to today.
      const previous = boards[period];
      boards[period] = { ...(previous.date === date ? previous : emptyBoard(date)), outcome: 'unavailable' };
    }
  }

  async function run() {
    running = true;
    lastAttemptAt = new Date(now()).toISOString();
    nextAttemptAt = null;
    const date = championshipLastDay(now());
    try {
      await Promise.all([refreshBoard('daily', date), refreshBoard('overall', null)]);
      const outcomes = [boards.daily.outcome, boards.overall.outcome];
      lastOutcome = outcomes.includes('unavailable') ? 'failed' : outcomes.includes('blocked') ? 'blocked'
        : outcomes.includes('saved') ? 'saved' : 'success';
      if (lastOutcome === 'success') lastSuccessAt = new Date(now()).toISOString();
    } finally {
      lastCompletedAt = new Date(now()).toISOString();
      running = false;
      inFlight = undefined;
      if (active && intervalHours !== null) {
        const completedAt = now();
        const current = new Date(completedAt);
        const midnight = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1);
        // A cycle spanning midnight needs the new Daily board immediately after it finishes.
        const delay = championshipLastDay(completedAt) !== date ? 0
          : Math.min(intervalHours * 3_600_000, midnight - completedAt);
        nextAttemptAt = new Date(completedAt + delay).toISOString();
        timer = setTimeout(() => { timer = undefined; launch(); }, delay);
        timer.unref();
      }
      try { onCycle?.(status()); } catch { /* Logging must not stop future refreshes. */ }
    }
  }
  function launch() {
    if (!active || running) return;
    inFlight = run();
  }
  return {
    status,
    start() {
      if (intervalHours === null || active || stopped) return;
      active = true;
      launch();
    },
    async stop() {
      active = false;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      nextAttemptAt = null;
      await inFlight;
    },
  };
}
