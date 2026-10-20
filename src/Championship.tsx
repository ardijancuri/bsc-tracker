import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BadgeCheck, CalendarDays, Radio, RefreshCw, Trophy } from 'lucide-react';
import { championship, championshipFirstDay, championshipLastDay, championshipLimit, utcDay, validChampionshipDate,
  type ChampionshipBoard, type ChampionshipPeriod, type ChampionshipTrader } from '../shared/championship';
import { api } from './lib';
import { getLocale, t } from './i18n';
import './championship.css';

export function championshipMoney(value: string | null) {
  if (value === null || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(Math.trunc(number));
}

export function championshipRoi(value: string | null) {
  if (value === null || !Number.isFinite(Number(value))) return '—';
  const ratio = Math.trunc(Number(value) * 1000) / 1000;
  const large = Math.abs(ratio) >= 10;
  return new Intl.NumberFormat(getLocale(), { style: 'percent', notation: large ? 'compact' : 'standard', maximumFractionDigits: large ? 2 : 1, signDisplay: 'exceptZero' }).format(ratio);
}

function valueClass(value: string | null) { return value === null ? '' : Number(value) < 0 ? 'ggc-loss' : 'ggc-gain'; }
function updatedTime(value: string) {
  return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }).format(new Date(value));
}

function TraderCard({ trader, period, live }: { trader: ChampionshipTrader; period: ChampionshipPeriod; live: boolean }) {
  const tier = ['gold', 'silver', 'bronze'][trader.rank - 1];
  const profileUrl = `https://x.com/${trader.xHandle}`;
  return <article className={`ggc-trader${tier ? ` ggc-trader-${tier}` : ''}`} style={{ '--ggc-order': trader.rank } as CSSProperties} aria-label={t('Rank {rank}: {name}', { rank: trader.rank, name: trader.name })}>
    {tier && <><img className="ggc-medal-edge" src={`/championship/edge-${tier}.svg`} alt="" aria-hidden="true" /><img className="ggc-medal" src={`/championship/mascot-${tier}.png`} alt="" aria-hidden="true" /></>}
    <div className="ggc-card-top"><span className="ggc-rank">#{trader.rank}</span>{trader.liveUrl && <a className={`ggc-stream${live && trader.isLive ? ' is-live' : ''}`} href={trader.liveUrl} target="_blank" rel="noopener noreferrer" aria-label={t('Watch {name} stream', { name: trader.name })} title={t(live && trader.isLive ? 'Live now' : 'Watch stream')}><Radio size={15} />{live && trader.isLive && <span>{t('Live')}</span>}</a>}</div>
    <div className="ggc-identity">
      <a className="ggc-avatar" href={profileUrl} target="_blank" rel="noopener noreferrer" aria-label={t('View {name} on X', { name: trader.name })}><span aria-hidden="true">{Array.from(trader.name)[0]?.toUpperCase()}</span>{trader.avatarUrl && <img src={trader.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}</a>
      <div className="ggc-identity-copy"><a className="ggc-trader-name" href={profileUrl} target="_blank" rel="noopener noreferrer" title={trader.name}><span>{trader.name}</span>{trader.verified && <BadgeCheck size={13} fill="#46cbf0" color="#0d303a" aria-label={t('GMGN verified trader')} />}</a><a className="ggc-handle" href={profileUrl} target="_blank" rel="noopener noreferrer">@{trader.xHandle}</a></div>
    </div>
    <dl className="ggc-stats"><div><dt>{t(period === 'daily' ? 'Daily PnL' : 'Total PnL')}</dt><dd className={valueClass(trader.pnlUsd)} title={trader.pnlUsd === null ? t('Unavailable') : `${trader.pnlUsd} USD`}>{championshipMoney(trader.pnlUsd)}</dd></div><div><dt>{t('ROI')}</dt><dd className={valueClass(trader.roi)}>{championshipRoi(trader.roi)}</dd></div></dl>
  </article>;
}

function ChampionshipClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const startsAt = Date.parse(championship.startsAt), endsAt = Date.parse(championship.endsAt);
  const remaining = Math.max(0, Math.floor(((now < startsAt ? startsAt : endsAt) - now) / 1000));
  const parts = [Math.floor(remaining / 86400), Math.floor(remaining / 3600) % 24, Math.floor(remaining / 60) % 60];
  return <div className="ggc-clock"><span>{t(now >= endsAt ? 'Qualifiers ended' : now < startsAt ? 'Qualifiers start in' : 'Qualifiers end in')}</span>{now < endsAt && <div aria-label={t('{days} days, {hours} hours, {minutes} minutes', { days: parts[0], hours: parts[1], minutes: parts[2] })}>{parts.map((value, index) => <span key={index}><strong>{String(value).padStart(2, '0')}</strong><small>{t(['Days', 'Hours', 'Minutes'][index])}</small></span>)}</div>}<small>{t('Oct 17–26, 2026 · UTC')}</small></div>;
}

export function ChampionshipPage() {
  const [params, setParams] = useSearchParams();
  const period: ChampionshipPeriod = params.get('tab') === 'overall' ? 'overall' : 'daily';
  const selectedDate = params.get('date');
  const date = selectedDate && validChampionshipDate(selectedDate) ? selectedDate : championshipLastDay();
  const dateKey = period === 'daily' ? date : null;
  const requestKey = `${period}:${dateKey}`;
  const [state, setState] = useState<{ key: string; data: ChampionshipBoard | null; loading: boolean; error: boolean }>({ key: '', data: null, loading: true, error: false });
  const [refreshIndex, setRefreshIndex] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = state.key === requestKey ? state : { key: requestKey, data: null, loading: true, error: false };
  const board = current.data;

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const refresh = async (fresh = false) => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      setState(previous => ({ key: requestKey, data: previous.key === requestKey ? previous.data : null, loading: true, error: false }));
      try {
        const query = new URLSearchParams({ period });
        if (dateKey) query.set('date', dateKey);
        if (fresh) query.set('refresh', '1');
        const data = await api<ChampionshipBoard>(`/api/championship?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ key: requestKey, data, loading: false, error: false });
      } catch {
        if (!controller.signal.aborted) setState(previous => ({ key: requestKey, data: previous.key === requestKey ? previous.data : null, loading: false, error: true }));
      } finally { busy = false; }
    };
    void refresh(true);
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [period, dateKey, requestKey, refreshIndex]);

  const choosePeriod = (value: ChampionshipPeriod) => setParams(previous => { const next = new URLSearchParams(previous); next.set('tab', value); return next; });
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 1 - index : null;
    if (next === null) return;
    event.preventDefault(); choosePeriod(next === 0 ? 'daily' : 'overall'); tabs.current[next]?.focus();
  };
  const isLive = board?.freshness === 'live' && !current.error;

  return <div className="ggc-page">
    <div className="ggc-hero">
    <div className="ggc-hero-scene" aria-hidden="true" />
    <header className="ggc-inner ggc-masthead">
      <div className="ggc-heading"><div className="ggc-kicker"><Trophy size={13} /><span>{t('GMGN GLOBAL CHAMPIONSHIP')}</span><span className="ggc-season">{t('Season 01')}</span></div><div className="ggc-title-line"><img className="ggc-wordmark" src="/championship/ggc-logo.svg" alt="GGC" /><h1>{t('Global')}<br /><span>{t('Championship')}</span></h1></div><p>{t('The competition’s top 20 traders. Daily and overall standings.')}</p><a className="ggc-official-link" href={championship.sourceUrl} target="_blank" rel="noopener noreferrer">{t('View competition on GMGN')}<ArrowUpRight size={15} /></a></div>
      <figure className="ggc-prize"><div className="ggc-prize-image"><img src="/championship/aston-martin-vantage.webp" width="1536" height="1024" alt={t('Aston Martin Vantage, the GMGN Global Championship grand prize')} fetchPriority="high" /></div><figcaption><span>{t('Grand Prize')}</span><strong>Aston Martin Vantage</strong><small>{t('GGC Edition')}</small></figcaption></figure>
      <ChampionshipClock />
    </header>
    </div>

    <div className="ggc-inner ggc-rankings-wrap">
    <section className="ggc-board" aria-label={t('Championship rankings')}>
      <div className="ggc-board-toolbar"><div className="ggc-tabs" role="tablist" aria-label={t('Championship period')}>{(['daily', 'overall'] as const).map((value, index) => <button key={value} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`championship-tab-${value}`} aria-controls="championship-panel" aria-selected={period === value} tabIndex={period === value ? 0 : -1} onClick={() => choosePeriod(value)} onKeyDown={event => onTabKey(event, index)}>{t(value === 'daily' ? 'Daily' : 'Overall')}</button>)}</div><span className="ggc-top-label">{t('TOP 20')}</span></div>
      {period === 'daily' && <p className="ggc-ranking-rule">{t('Ranked by the day’s realized PnL (UTC+0).')}</p>}
      <div className="ggc-board-meta"><div>{period === 'daily' ? <label className="ggc-date"><CalendarDays size={14} /><span>{t('Daily date')}</span><input type="date" aria-label={t('Daily date (UTC)')} min={championshipFirstDay} max={championshipLastDay()} value={date} onChange={event => { const value = event.target.value; if (validChampionshipDate(value)) setParams(previous => { const next = new URLSearchParams(previous); next.set('date', value); return next; }); }} /><span className="ggc-utc">UTC</span></label> : <span className="ggc-overall-dates"><CalendarDays size={14} />{t('All competition days')}</span>}</div><div className="ggc-update"><span className={isLive ? 'ggc-status is-live' : 'ggc-status'}><i />{t(isLive ? 'Live' : board ? 'Saved rankings' : 'GMGN rankings')}</span><button type="button" onClick={() => setRefreshIndex(value => value + 1)} disabled={current.loading} aria-label={t('Refresh championship rankings')} title={t('Refresh championship rankings')}><RefreshCw size={14} className={current.loading ? 'ggc-refreshing' : ''} /></button></div></div>

      <div id="championship-panel" role="tabpanel" aria-labelledby={`championship-tab-${period}`} aria-busy={current.loading} tabIndex={0}>
        {current.loading && !board ? <div className="ggc-grid ggc-skeleton-grid" role="status" aria-label={t('Loading championship rankings…')}>{Array.from({ length: championshipLimit }, (_, index) => <div className="ggc-skeleton" key={index}><i /><i /><i /></div>)}</div>
          : !board ? <div className="ggc-empty" role="status"><Trophy size={30} /><h2>{t('Rankings are unavailable')}</h2><p>{t('GMGN has not returned rankings for this date. Please try again shortly.')}</p>{date !== '2026-10-20' && period === 'daily' && <button type="button" onClick={() => setParams({ tab: 'daily', date: '2026-10-20' })}>{t('View saved October 20 rankings')}</button>}<a href={championship.sourceUrl} target="_blank" rel="noopener noreferrer">{t('View competition on GMGN')}<ArrowUpRight size={14} /></a></div>
          : !board.items.length ? <div className="ggc-empty" role="status"><Trophy size={30} /><h2>{t('No ranked traders yet')}</h2><p>{t('Rankings will appear when GMGN publishes results for this date.')}</p></div>
          : <div className="ggc-grid" key={requestKey}>{board.items.slice(0, championshipLimit).map(trader => <TraderCard key={trader.id} trader={trader} period={period} live={isLive} />)}</div>}
      </div>
      <div className="ggc-board-footer"><span>{t('Source: GMGN Global Championship · All competition chains')}</span>{board && <span>{t('Updated {time} UTC', { time: updatedTime(board.updatedAt) })}</span>}</div>
      {period === 'daily' && date !== utcDay() && <p className="ggc-history-note">{t('Historical daily standings · {date} UTC', { date })}</p>}
    </section>
  </div></div>;
}
