import { useMemo, useState } from 'react';
import type { WatchPeriod } from '../shared/intelligence';
import type { Token } from './types';
import ReplayShare, { type ReplayShareDefinition } from './ReplayShare';
import TokenReplayCanvas from './TokenReplayCanvas';
import { loadTokenReplay, tokenReplayPeriods } from './tokenReplayData';
import { shareTokenReplayFile, tokenReplaySharing } from './tokenReplaySharing';
import { t, useLanguage } from './i18n';

export default function TokenReplayShare({ token }: { token: Token }) {
  useLanguage();
  const [period, setPeriod] = useState<WatchPeriod>('24h');
  const definition = useMemo<ReplayShareDefinition>(() => {
    const details = tokenReplaySharing(token, period);
    return {
      kind: 'token', title: 'Share token replay', subtitle: `${details.name} · ${period} · BNB Chain`,
      previewLabel: 'Animated token replay preview', preparingLabel: 'Preparing token replay…', playbackLabel: 'Replay token',
      linkLabel: 'Token link', fileName: `${details.name}-${period}`, url: details.url, caption: details.caption, xIntent: details.xIntent,
      controls: <div className="token-replay-periods" role="group" aria-label={t('Replay period')}>
        {tokenReplayPeriods.map(value => <button type="button" key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value}</button>)}
      </div>,
      shareFile: file => shareTokenReplayFile(file, token, period),
      prepare: async (signal, onWait) => {
        const data = await loadTokenReplay(token, period, signal, { onWait });
        if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
        const renderer = new TokenReplayCanvas(document.createElement('canvas'), data);
        await renderer.loadImages(signal);
        return renderer;
      },
    };
  }, [token, period]);
  return <ReplayShare definition={definition} />;
}
