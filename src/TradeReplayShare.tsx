import { useMemo } from 'react';
import ReplayShare, { type ReplayShareDefinition } from './ReplayShare';
import ReplayCanvas from './tradeReplayCanvas';
import type { TradeReplayData } from './tradeReplayData';
import { prepareReplayForShare } from './tradeReplayPreparation';
import { shareTradeReplayFile, tradeReplayXIntent } from './tradeReplaySharing';
export { prepareTradeReplayData } from './tradeReplayData';

export default function TradeReplayShare({ data }: { data: TradeReplayData }) {
  const definition = useMemo<ReplayShareDefinition>(() => {
    const kol = data.kol.name ?? 'KOL', token = data.token.symbol ?? 'Token';
    const wallet = data.kol.address.trim().toLowerCase();
    return {
      kind: 'trade', title: 'Share trade', subtitle: `${kol} · ${token}`, previewLabel: 'Animated trade recap preview',
      preparingLabel: 'Preparing trade…', playbackLabel: 'Replay trade', linkLabel: 'Trade link', fileName: `${kol}-${token}`,
      url: /^0x[0-9a-f]{40}$/.test(wallet) ? `https://kollens.com/kol/${wallet}` : 'https://kollens.com/',
      caption: `${kol}'s ${token} trade replay, tracked with kollens.`, xIntent: tradeReplayXIntent(data),
      shareFile: file => shareTradeReplayFile(file, data),
      prepare: async (signal, onWait) => {
        const market = await prepareReplayForShare(data, signal, { onWait });
        if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
        const renderer = new ReplayCanvas(document.createElement('canvas'));
        await renderer.setData(market.data);
        return renderer;
      },
    };
  }, [data]);
  return <ReplayShare definition={definition} />;
}
