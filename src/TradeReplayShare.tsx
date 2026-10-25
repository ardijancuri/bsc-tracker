import { useMemo } from 'react';
import ReplayShare, { type ReplayShareDefinition } from './ReplayShare';
import ReplayCanvas from './tradeReplayCanvas';
import type { TradeReplayData } from './tradeReplayData';
import { prepareReplayForShare } from './tradeReplayPreparation';
import { shareTradeReplayFile, tradeReplayXIntent } from './tradeReplaySharing';
import { tradeActivityBase, tradeRequestHeaders } from './tradeRequestContext';
import { validatePreparedTradeReplay } from './replayPreparationRequest';
export { prepareTradeReplayData } from './tradeReplayData';

export default function TradeReplayShare({ data }: { data: TradeReplayData }) {
  const definition = useMemo<ReplayShareDefinition>(() => {
    const kol = data.kol.name ?? 'KOL', token = data.token.symbol ?? 'Token';
    const wallet = data.kol.address.trim().toLowerCase();
    let prepared: TradeReplayData | null = null;
    return {
      kind: 'trade', title: 'Share trade', subtitle: `${kol} · ${token}`, previewLabel: 'Animated trade recap preview',
      preparingLabel: 'Preparing trade…', playbackLabel: 'Replay trade', linkLabel: 'Trade link', fileName: `${kol}-${token}`,
      url: data.requestContext ? 'https://kollens.com/portfolio' : /^0x[0-9a-f]{40}$/.test(wallet) ? `https://kollens.com/kol/${wallet}` : 'https://kollens.com/',
      caption: `${kol}'s ${token} trade replay, tracked with kollens.`, xIntent: tradeReplayXIntent(data),
      shareFile: file => shareTradeReplayFile(file, data),
      validateAccess: async () => {
        if (prepared?.replayLease) { await validatePreparedTradeReplay(prepared); return; }
        if (!data.requestContext) return;
        const response = await fetch(`${tradeActivityBase(data.kol.address, data.token.address, data.requestContext)}/activity?replay=true${data.requestContext?.snapshotId ? `&snapshot=${data.requestContext.snapshotId}` : ''}`,
          { cache: 'no-store', headers: tradeRequestHeaders(data.requestContext), signal: AbortSignal.timeout(8000) });
        if (!response.ok || response.status === 202) throw new Error('Portfolio access changed. Close this replay and try again.');
      },
      prepare: async (signal, onWait) => {
        prepared = null;
        const market = await prepareReplayForShare(data, signal, { onWait });
        if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
        await validatePreparedTradeReplay(market.data, signal);
        prepared = market.data;
        const renderer = new ReplayCanvas(document.createElement('canvas'));
        await renderer.setData(market.data);
        return renderer;
      },
    };
  }, [data]);
  return <ReplayShare definition={definition} />;
}
