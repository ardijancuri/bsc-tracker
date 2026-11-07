import { useEffect, useState } from 'react';
import { browserApi, requestBackground } from './platform';
import { xTrendingOrigins, xTrendingSiteAllowed } from './xTrendingAccess';

export function XTrendingSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => { void xTrendingSiteAllowed().then(setEnabled).catch(() => setEnabled(false)); };
    refresh();
    browserApi.permissions.onAdded.addListener(refresh);
    browserApi.permissions.onRemoved.addListener(refresh);
    return () => {
      browserApi.permissions.onAdded.removeListener(refresh);
      browserApi.permissions.onRemoved.removeListener(refresh);
    };
  }, []);

  async function change(wanted: boolean) {
    setBusy(true);
    setError('');
    try {
      if (wanted) {
        if (!await browserApi.permissions.request({ origins: xTrendingOrigins })) return;
      } else {
        await browserApi.permissions.remove({ origins: xTrendingOrigins });
      }
      await requestBackground({ kind: 'x-trending/permission' });
    } catch {
      setError('Could not update X site access. Try again.');
    } finally {
      setEnabled(await xTrendingSiteAllowed().catch(() => false));
      setBusy(false);
    }
  }

  return <section className="settings-group">
    <h2>On X</h2>
    <label><input type="checkbox" checked={enabled === true} disabled={busy || enabled == null}
      onChange={event => void change(event.target.checked)} /> Show trending BNB tokens</label>
    {error && <p role="status">{error}</p>}
  </section>;
}
