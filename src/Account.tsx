import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, UserRound, X } from 'lucide-react';
import type { AuthState, AuthUser } from '../shared/auth';
import { t } from './i18n';
import './account.css';

export const accountCheckEvent = 'kollens:account-check';
export const watchlistSyncKey = 'kollens-watchlist-sync';
const accountSyncKey = 'kollens-account-sync';
const signedOut: AuthState = { enabled: false, user: null };
function notifyTabs(key: string) {
  try { window.localStorage.setItem(key, `${Date.now()}:${Math.random()}`); } catch { /* Focus refresh also works when storage is unavailable. */ }
}
export function notifyWatchlistTabs() { notifyTabs(watchlistSyncKey); }
type AccountContextValue = {
  state: AuthState; loaded: boolean; checking: boolean; busy: boolean; unavailable: boolean; revision: number;
  refresh: () => Promise<void>; login: () => Promise<void>; logout: () => Promise<void>;
};
const AccountContext = createContext<AccountContextValue | null>(null);
const callbackErrors: Record<string, string> = {
  cancelled: 'Telegram login was cancelled. Your favorites are unchanged.',
  failed: 'Could not log in with Telegram. Try again.',
  merge_limit: 'Your browser and account favorites exceed the limit. Remove some favorites and try again.',
};

export function AccountProvider({ children }: { children: ReactNode }) {
  const location = useLocation(), navigate = useNavigate();
  const [state, setState] = useState<AuthState>(signedOut);
  const [loaded, setLoaded] = useState(false), [checking, setChecking] = useState(true), [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false), [error, setError] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const identity = useRef<string | null>(null), request = useRef(0), operation = useRef(false), mounted = useRef(true);
  const refresh = useCallback(async () => {
    const number = ++request.current;
    window.dispatchEvent(new Event(accountCheckEvent)); setChecking(true);
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error('Account unavailable');
      const value = await response.json() as AuthState;
      if (!mounted.current || request.current !== number) return;
      const nextIdentity = value.user?.id || 'guest';
      if (identity.current !== nextIdentity) { identity.current = nextIdentity; setRevision(value => value + 1); notifyTabs(accountSyncKey); }
      setState(value); setUnavailable(false); setLoaded(true);
    } catch {
      if (mounted.current && request.current === number) { setUnavailable(true); setLoaded(true); }
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current && request.current === number) setChecking(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const focus = () => void refresh();
    const storage = (event: StorageEvent) => { if (event.key === accountSyncKey || event.key === null) void refresh(); };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => { mounted.current = false; request.current++; window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); };
  }, [refresh]);
  useEffect(() => {
    const params = new URLSearchParams(location.search), code = params.get('authError');
    if (!code) return;
    setError(callbackErrors[code] || callbackErrors.failed);
    params.delete('authError');
    navigate({ pathname: location.pathname, search: params.size ? `?${params}` : '', hash: location.hash }, { replace: true });
  }, [location, navigate]);
  const login = async () => {
    if (operation.current || checking || !state.enabled || unavailable) return;
    operation.current = true; setBusy(true); setError(null);
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch('/api/auth/telegram/start', { method: 'POST', signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo: `${location.pathname}${location.search}${location.hash}` }) });
      if (!response.ok) throw new Error('Could not log in with Telegram. Try again.');
      const result = await response.json() as { url: string };
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.hostname !== 'oauth.telegram.org') throw new Error('Could not log in with Telegram. Try again.');
      window.location.assign(url.href);
    } catch { if (mounted.current) setError('Could not log in with Telegram. Try again.'); }
    finally { window.clearTimeout(timeout); operation.current = false; if (mounted.current) setBusy(false); }
  };
  const logout = async () => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); window.dispatchEvent(new Event(accountCheckEvent));
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Could not log out. Try again.');
      request.current++;
      if (!mounted.current) return;
      identity.current = 'guest'; setState(current => ({ ...current, user: null })); setRevision(value => value + 1); setUnavailable(false); setChecking(false);
      notifyTabs(accountSyncKey);
    } catch { if (mounted.current) { setError('Could not log out. Try again.'); await refresh(); } }
    finally { window.clearTimeout(timeout); operation.current = false; if (mounted.current) setBusy(false); }
  };
  return <AccountContext.Provider value={{ state, loaded, checking, busy, unavailable, revision, refresh, login, logout }}>
    {children}
    {error && <div className="account-feedback" role="alert"><span>{t(error)}</span><button type="button" onClick={() => setError(null)} aria-label={t('Dismiss')}><X size={16} /></button></div>}
  </AccountContext.Provider>;
}
export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('Account provider missing');
  return value;
}
function AccountAvatar({ user }: { user: AuthUser }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [user.id, user.avatarUrl]);
  return <span className="account-avatar" aria-hidden="true">{user.avatarUrl && !failed
    ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : Array.from(user.name.trim())[0]?.toUpperCase() || '?'}</span>;
}
export function AccountButton() {
  const account = useAccount();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  if (account.unavailable) return <button type="button" className="account-login" onClick={() => void account.refresh()} disabled={account.checking}>{t('Retry login')}</button>;
  if (!account.state.user) return <button type="button" className="account-login" onClick={() => void account.login()} disabled={!account.loaded || account.checking || account.busy || !account.state.enabled} aria-label={t('Log in with Telegram')} title={!account.state.enabled && account.loaded ? t('Telegram login is temporarily unavailable') : t('Log in with Telegram')}><span>{t(account.busy ? 'Opening Telegram…' : 'Login')}</span><UserRound className="account-login-user-icon" size={18} aria-hidden="true" /></button>;
  const user = account.state.user;
  return <details ref={menu} className="account-menu"><summary title={user.name} aria-label={`${t('Account menu')}: ${user.name} · ${t('Logged in with Telegram')}`}><AccountAvatar key={user.id} user={user} /><span className="account-identity"><span className="account-name">{user.name}</span><span className="account-provider">{t('Telegram')}</span></span></summary>
    <div className="account-menu-content"><div className="account-menu-identity"><AccountAvatar key={user.id} user={user} /><div><strong>{user.name}</strong>{user.username && <small>@{user.username}</small>}<small>{t('Logged in with Telegram')}</small></div></div><Link to="/watchlist" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); }}>{t('Watchlist')}</Link><button type="button" disabled={account.busy} onClick={() => void account.logout()}><LogOut size={14} aria-hidden="true" />{t('Log out')}</button></div>
  </details>;
}
export function AccountWatchlistNotice() {
  const account = useAccount();
  if (account.state.user) return <span className="account-watchlist-status">{t('Favorites synced to your account')}</span>;
  return <div className="account-watchlist-prompt"><span>{t('Save favorites across devices')}</span><AccountButton /></div>;
}
