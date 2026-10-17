import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, BellOff, RefreshCw, X } from 'lucide-react';
import type { TelegramNotificationPreferences, TelegramNotificationState } from '../shared/telegramNotifications';
import { accountCheckEvent, useAccount } from './Account';
import { getLanguage, t } from './i18n';
import './telegramNotifications.css';

class TelegramNotificationRequestError extends Error {
  constructor(readonly status: number) { super('Telegram alerts unavailable'); }
}
export function notificationIdentityChanged(reason: unknown) {
  return reason instanceof TelegramNotificationRequestError && (reason.status === 401 || reason.status === 409);
}
export async function requestTelegramNotifications<T>(url: string, owner: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      headers: { Accept: 'application/json', 'X-Watchlist-Owner': owner, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new TelegramNotificationRequestError(response.status);
    return await response.json() as T;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export function telegramConsentUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'oauth.telegram.org' || url.username || url.password) throw new Error('Invalid Telegram consent URL');
  return url.href;
}

type NotificationsContextValue = {
  state: TelegramNotificationState | null; loading: boolean; busy: boolean; error: string | null;
  refresh(): Promise<void>; enable(): Promise<void>; preferences(value: TelegramNotificationPreferences): Promise<void>; mute(address: string, muted: boolean): Promise<void>;
};
const NotificationsContext = createContext<NotificationsContextValue | null>(null);
export function useTelegramNotifications() {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('Telegram notifications provider missing');
  return value;
}
const callbackErrors: Record<string, string> = {
  cancelled: 'Telegram messaging permission was cancelled.',
  denied: 'Telegram messaging permission was cancelled.',
  identity_mismatch: 'Use the same Telegram account to enable alerts.',
  failed: 'Could not connect Telegram alerts. Try again.',
};
export function TelegramNotificationsProvider({ children }: { children: ReactNode }) {
  const account = useAccount(), location = useLocation(), navigate = useNavigate();
  const [value, setValue] = useState<{ owner: string; state: TelegramNotificationState } | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const auth = useRef(account); auth.current = account;
  const version = useRef(0), locked = useRef(false), active = useRef<AbortController | null>(null), mounted = useRef(true);
  const eligible = () => Boolean(auth.current.loaded && auth.current.state.user && !auth.current.checking && !auth.current.busy && !auth.current.unavailable);
  const perform = useCallback(async <T,>(url: string, method: string, body: unknown, accept: (result: T) => void) => {
    if (locked.current || !eligible()) return;
    const owner = auth.current.state.user!.id, number = version.current;
    locked.current = true; const controller = new AbortController(); active.current = controller;
    if (method === 'GET') setLoading(true); else { setBusy(true); setError(null); setFeedback(null); }
    try {
      const result = await requestTelegramNotifications<T>(url, owner, method, body, controller.signal);
      if (mounted.current && number === version.current && auth.current.state.user?.id === owner) { accept(result); setError(null); }
    } catch (reason) {
      if (!mounted.current || number !== version.current || controller.signal.aborted) return;
      if (notificationIdentityChanged(reason)) { await auth.current.refresh(); return; }
      setError(method === 'GET' ? 'Telegram alerts unavailable. Retry to check your connection.' : 'Could not update Telegram alerts. Try again.');
    } finally {
      if (number === version.current) { locked.current = false; active.current = null; if (mounted.current) { setLoading(false); setBusy(false); } }
    }
  }, []);
  const accept = (state: TelegramNotificationState) => setValue({ owner: auth.current.state.user!.id, state });
  const refresh = useCallback(() => perform<TelegramNotificationState>('/api/notifications/telegram', 'GET', undefined, accept), [perform]);
  const preferences = (body: TelegramNotificationPreferences) => perform<TelegramNotificationState>('/api/notifications/telegram', 'PATCH', body, accept);
  const mute = (address: string, muted: boolean) => perform<TelegramNotificationState>(`/api/notifications/telegram/kols/${encodeURIComponent(address.toLowerCase())}`, 'PUT', { muted }, accept);
  const enable = () => perform<{ url: string }>('/api/notifications/telegram/enable', 'POST', {
    returnTo: `${location.pathname}${location.search}${location.hash}`, language: getLanguage(),
  }, result => window.location.assign(telegramConsentUrl(result.url)));
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => { version.current++; active.current?.abort(); active.current = null; locked.current = false; setBusy(false); setLoading(false); };
    window.addEventListener(accountCheckEvent, invalidate);
    return () => { mounted.current = false; version.current++; active.current?.abort(); window.removeEventListener(accountCheckEvent, invalidate); };
  }, []);
  useEffect(() => {
    version.current++; active.current?.abort(); active.current = null; locked.current = false; setValue(null); setError(null); setBusy(false); setLoading(false);
  }, [account.revision]);
  const connection = value && value.owner === account.state.user?.id ? value.state.connection : undefined;
  useEffect(() => {
    if (!eligible()) return;
    const visibleRefresh = () => { if (!document.hidden) void refresh(); };
    visibleRefresh();
    const timer = window.setInterval(visibleRefresh, connection === 'pending' ? 2000 : 30_000);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [account.loaded, account.checking, account.busy, account.unavailable, account.revision, connection, refresh]);
  useEffect(() => {
    const params = new URLSearchParams(location.search), code = params.get('telegramAlerts');
    if (!code) return;
    if (code !== 'pending') setFeedback(callbackErrors[code] || callbackErrors.failed);
    params.delete('telegramAlerts'); void refresh();
    navigate({ pathname: location.pathname, search: params.size ? `?${params}` : '', hash: location.hash }, { replace: true });
  }, [location, navigate, refresh]);
  const state = value && value.owner === account.state.user?.id ? value.state : null;
  return <NotificationsContext.Provider value={{ state, loading, busy: busy || account.checking || account.busy || account.unavailable, error, refresh, preferences, mute, enable }}>
    {children}{(feedback || error) && <div className="telegram-alert-feedback" role="alert"><span>{t(feedback || error!)}</span><button type="button" onClick={() => { setFeedback(null); setError(null); }} aria-label={t('Dismiss')}><X size={16} /></button></div>}
  </NotificationsContext.Provider>;
}

export function telegramConnectionLabel(state: TelegramNotificationState) {
  if (!state.available) return 'Telegram alerts are temporarily unavailable';
  if (state.connection === 'pending') return 'Waiting for Telegram confirmation…';
  if (state.connection === 'blocked') return 'Bot blocked. Reconnect to receive alerts.';
  if (state.connection === 'error') return 'Telegram connection needs attention';
  if (state.connection !== 'connected') return 'Connect Telegram to receive live trades';
  return state.enabled ? 'Alerts active' : 'Alerts paused';
}
export function TelegramAlertsControls({ state, disabled, onEnable, onPreferences }: {
  state: TelegramNotificationState; disabled: boolean; onEnable(): void; onPreferences(value: TelegramNotificationPreferences): void;
}) {
  const connected = state.connection === 'connected', pending = state.connection === 'pending';
  return <><div className={`telegram-alert-status${state.enabled && connected ? ' active' : ''}`} role="status">{t(telegramConnectionLabel(state))}</div>
    <div className="telegram-alert-options"><label><input type="checkbox" checked={state.buys} disabled={disabled || !state.available || (!state.sells && state.buys)} onChange={event => onPreferences({ buys: event.target.checked })} />{t('Buys')}</label>
      <label><input type="checkbox" checked={state.sells} disabled={disabled || !state.available || (!state.buys && state.sells)} onChange={event => onPreferences({ sells: event.target.checked })} />{t('Sells')}</label>
      <button type="button" className="feature-button" disabled={disabled || (!state.available && !pending && !(connected && state.enabled))} onClick={() => pending ? onPreferences({ enabled: false }) : connected ? onPreferences({ enabled: !state.enabled }) : onEnable()}>
        {t(pending ? 'Cancel connection' : connected ? state.enabled ? 'Pause alerts' : 'Resume alerts' : state.connection === 'blocked' || state.connection === 'error' ? 'Reconnect Telegram' : 'Enable Telegram alerts')}
      </button></div></>;
}
export function TelegramAlertsSettings() {
  const account = useAccount(), alerts = useTelegramNotifications();
  return <section className="telegram-alert-settings" aria-labelledby="telegram-alert-heading"><div className="telegram-alert-heading"><Bell size={17} aria-hidden="true" /><h2 id="telegram-alert-heading">{t('Telegram alerts')}</h2></div>
    {!account.state.user ? <div className="telegram-alert-options"><span>{t('Log in to receive favorite KOL trades in Telegram.')}</span><button type="button" className="feature-button" onClick={() => void account.login()} disabled={!account.loaded || account.checking || account.busy || !account.state.enabled || account.unavailable}>{t('Log in with Telegram')}</button></div>
      : alerts.state ? <TelegramAlertsControls state={alerts.state} disabled={alerts.busy || alerts.loading} onEnable={() => void alerts.enable()} onPreferences={value => void alerts.preferences(value)} />
        : <div className="telegram-alert-options"><span role="status">{t(alerts.loading ? 'Loading Telegram alerts…' : 'Telegram alerts unavailable')}</span><button type="button" className="feature-button" disabled={alerts.busy || alerts.loading} onClick={() => void alerts.refresh()}><RefreshCw size={13} aria-hidden="true" />{t('Retry')}</button></div>}
  </section>;
}
export function TelegramKolBell({ address, label }: { address: string; label: string }) {
  const account = useAccount(), alerts = useTelegramNotifications();
  if (!account.state.user || !alerts.state?.available) return null;
  const muted = alerts.state.mutedKols.includes(address.toLowerCase());
  const title = t(muted ? 'Unmute Telegram alerts for {name}' : 'Mute Telegram alerts for {name}', { name: label });
  return <button type="button" className={`telegram-kol-bell${muted ? ' muted' : ''}`} disabled={alerts.busy || alerts.loading} title={title} aria-label={title} aria-pressed={!muted} onClick={event => { event.preventDefault(); event.stopPropagation(); void alerts.mute(address, !muted); }}>{muted ? <BellOff size={17} /> : <Bell size={17} />}</button>;
}
