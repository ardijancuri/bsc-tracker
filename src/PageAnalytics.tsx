/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { analyticsDay, analyticsPublicPath } from '../shared/analytics';
import { t } from './i18n';
import './pageAnalytics.css';

const choiceKey = 'kollens-analytics-choice';
const visitorKey = 'kollens-analytics-visitor';
type Choice = 'allow' | 'decline' | null;

function readChoice(): Choice {
  try {
    const choice = localStorage.getItem(choiceKey);
    return choice === 'allow' || choice === 'decline' ? choice : null;
  } catch {
    return null;
  }
}

async function readVisitor(): Promise<string | null> {
  const readOrCreate = () => {
    if (readChoice() !== 'allow' || privacySignal()) return null;
    const day = analyticsDay();
    const stored = localStorage.getItem(visitorKey);
    if (stored?.startsWith(day + ':')) return stored.slice(day.length + 1);
    const visitor = crypto.randomUUID();
    localStorage.setItem(visitorKey, day + ':' + visitor);
    return visitor;
  };
  try {
    // Tabs share the lock while replacing the daily ID at midnight.
    return navigator.locks ? await navigator.locks.request(visitorKey, readOrCreate) : readOrCreate();
  } catch {
    return null;
  }
}

function privacySignal(): boolean {
  const browser = navigator as Navigator & { globalPrivacyControl?: boolean };
  return browser.globalPrivacyControl === true || ['1', 'yes'].includes(browser.doNotTrack ?? '');
}

export function useAnalyticsPreferences() {
  const enabled = (import.meta.env.DEV && import.meta.env.VITE_KOLLENS_ANALYTICS_ENABLED === 'true')
    || Boolean(document.head.querySelector('meta[name="kollens-analytics"][content="enabled"]'));
  const [choice, setChoice] = useState(readChoice);
  const signal = privacySignal();

  useEffect(() => {
    const updateChoice = (event: StorageEvent) => {
      if (event.key === choiceKey || event.key === null) setChoice(readChoice());
    };
    window.addEventListener('storage', updateChoice);
    return () => window.removeEventListener('storage', updateChoice);
  }, []);

  function choose(next: Exclude<Choice, null>) {
    try {
      localStorage.setItem(choiceKey, next);
      if (next === 'decline') localStorage.removeItem(visitorKey);
    } catch { /* The visitor can still dismiss the prompt for this visit. */ }
    setChoice(next);
  }

  return { enabled, signal, choice, choose, allowed: enabled && !signal && choice === 'allow' };
}

export type AnalyticsPreferences = ReturnType<typeof useAnalyticsPreferences>;

export function usePageView(allowed: boolean, pathname: string | null) {
  const path = pathname === null ? null : analyticsPublicPath(pathname);
  const view = useRef({ path, sent: false });
  useEffect(() => {
    if (view.current.path !== path) view.current = { path, sent: false };
    if (!allowed || !path) return;

    let active = true;
    let preparing = false;
    const report = async () => {
      if (view.current.sent || document.visibilityState !== 'visible' || readChoice() !== 'allow' || privacySignal()) return;
      if (preparing) return;
      preparing = true;
      const visitor = await readVisitor();
      preparing = false;
      if (!active || !visitor || readChoice() !== 'allow' || privacySignal()) return;
      view.current.sent = true;
      void fetch('/api/analytics/page-view', {
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: crypto.randomUUID(), visitor, path }),
      }).catch(() => { /* A missing analytics report never interrupts browsing. */ });
    };

    void report();
    document.addEventListener('visibilitychange', report);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', report);
    };
  }, [allowed, path]);
}

export function AnalyticsNotice({ preferences }: { preferences: AnalyticsPreferences }) {
  if (!preferences.enabled || preferences.signal || preferences.choice !== null) return null;
  return <aside className="analytics-notice" aria-label={t('Website analytics')}>
    <strong>{t('Website analytics')}</strong>
    <p>{t('Help us measure visits and page views. Analytics is optional.')} <Link to="/privacy-policy#website-analytics">{t('Privacy Policy')}</Link></p>
    <div className="analytics-actions">
      <button type="button" onClick={() => preferences.choose('decline')}>{t('Decline')}</button>
      <button type="button" onClick={() => preferences.choose('allow')}>{t('Allow analytics')}</button>
    </div>
  </aside>;
}

export function AnalyticsPreferenceControl({ preferences }: { preferences: AnalyticsPreferences }) {
  if (!preferences.enabled) return null;
  if (preferences.signal) return <p>{t('Your browser’s privacy setting keeps analytics off.')}</p>;

  const allowed = preferences.choice === 'allow';
  return <div className="analytics-actions analytics-preferences">
    <span role="status">{t(allowed ? 'Analytics is on in this browser.' : 'Analytics is off in this browser.')}</span>
    <button type="button" onClick={() => preferences.choose(allowed ? 'decline' : 'allow')}>
      {t(allowed ? 'Turn off analytics' : 'Allow analytics')}
    </button>
  </div>;
}
