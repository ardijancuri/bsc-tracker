import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, UserRound } from 'lucide-react';
import { useAccount } from './Account';
import { t } from './i18n';
import { requestTelegramBotLogin, requestTelegramLoginRecovery, telegramBotLoginError, telegramBotLoginReturnTo, telegramBotLoginToken, type TelegramBotLoginPreview } from './telegramBotLoginRequest';
import './telegramBotLogin.css';

export function TelegramBotLoginCard({ preview, busy, error, loading, onContinue, onRetry, onLogin, onRecover }: {
  preview: TelegramBotLoginPreview | null; busy: boolean; error: string | null; loading: boolean;
  onContinue(): void; onRetry(): void; onLogin(): void; onRecover(): void;
}) {
  const [failedImage, setFailedImage] = useState(false);
  const expired = error === 'This login link has expired or was already used.';
  const differentAccount = error === 'Log out before signing in to a different Telegram account.';
  const requiresRecovery = preview?.requiresRecovery === true || error === 'One-time Telegram verification is needed to preserve existing accounts.';
  return <section className="telegram-bot-login" aria-labelledby="telegram-bot-login-title">
    <div className="telegram-bot-login-symbol"><UserRound size={24} aria-hidden="true" /></div>
    <h1 id="telegram-bot-login-title">{t('Log in to Kollens')}</h1>
    {loading ? <p role="status">{t('Checking your Telegram login…')}</p> : <>
      {preview && !error && <>
        <p>{t('Continue with the Telegram account shown below.')}</p>
        <div className="telegram-bot-login-identity">
          <span className="telegram-bot-login-avatar" aria-hidden="true">{preview.user.avatarUrl && !failedImage
            ? <img src={preview.user.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedImage(true)} />
            : Array.from(preview.user.name.trim())[0]?.toUpperCase() || '?'}</span>
          <div><strong>{preview.user.name}</strong>{preview.user.username && <span>@{preview.user.username}</span>}</div>
        </div>
        <p className="telegram-bot-login-hint">{t(requiresRecovery ? 'One-time Telegram verification is needed to preserve existing accounts.' : 'Only continue if you requested this login.')}{!preview.sameBrowser && <> {t('You’ll be logged in to Kollens in this browser.')}</>}</p>
        <button type="button" className="feature-button telegram-bot-login-continue" disabled={busy} onClick={requiresRecovery ? onRecover : onContinue}>
          {requiresRecovery ? t('Verify Telegram account') : t('Continue as {name}', { name: preview.user.name })}<ArrowRight size={16} aria-hidden="true" />
        </button>
      </>}
      {error && <>
        <p role="alert">{t(error)}</p>
        {requiresRecovery ? <button type="button" className="feature-button" disabled={busy} onClick={onRecover}>{t('Verify Telegram account')}</button>
          : differentAccount ? <Link className="feature-button" to="/watchlist">{t('Go to your account')}</Link>
          : <button type="button" className="feature-button" disabled={busy} onClick={expired ? onLogin : onRetry}>{t(expired ? 'Log in with Telegram' : 'Retry login')}</button>}
      </>}
      <Link className="telegram-bot-login-back" to="/watchlist">{t('Back to Watchlist')}</Link>
      {!requiresRecovery && <button type="button" className="telegram-bot-login-recover" disabled={busy} onClick={onRecover}>{t('Previously used Telegram login? Recover your existing account')}</button>}
    </>}
  </section>;
}

export function TelegramBotLogin() {
  const account = useAccount();
  const [token] = useState(() => telegramBotLoginToken(window.location.hash));
  const [preview, setPreview] = useState<TelegramBotLoginPreview | null>(null);
  const [loading, setLoading] = useState(Boolean(token)), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This login link has expired or was already used.');
  const [revision, setRevision] = useState(0);
  const operation = useRef(false), mounted = useRef(true), completeRequest = useRef<AbortController | null>(null);
  // Read once into component memory, then remove the bearer token before any preview is displayed.
  useLayoutEffect(() => {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; completeRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true); setError(null); setPreview(null);
    void requestTelegramBotLogin<TelegramBotLoginPreview>('preview', token, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        if (!value.user?.name || typeof value.sameBrowser !== 'boolean' || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('Invalid login preview');
        setPreview(value);
      }
    }).catch(reason => { if (!controller.signal.aborted) setError(telegramBotLoginError(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, revision]);
  const complete = async () => {
    if (!token || !preview || preview.requiresRecovery || operation.current) return;
    operation.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); completeRequest.current = controller;
    try {
      const result = await requestTelegramBotLogin<{ returnTo: string }>('complete', token, controller.signal);
      if (mounted.current && !controller.signal.aborted) window.location.assign(telegramBotLoginReturnTo(result.returnTo));
    } catch (reason) { if (mounted.current && !controller.signal.aborted) setError(telegramBotLoginError(reason)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const recover = async () => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); completeRequest.current = controller;
    try {
      const url = await requestTelegramLoginRecovery(error === 'This login link has expired or was already used.' ? null : token, controller.signal);
      if (mounted.current && !controller.signal.aborted) window.location.assign(url);
    } catch (reason) { if (mounted.current && !controller.signal.aborted) setError(telegramBotLoginError(reason)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="page telegram-bot-login-page"><TelegramBotLoginCard preview={preview} busy={busy} error={error} loading={loading}
    onContinue={() => void complete()} onRetry={() => setRevision(value => value + 1)} onLogin={() => void account.login()} onRecover={() => void recover()} /></div>;
}
