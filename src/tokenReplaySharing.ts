import type { Token } from './types';
import type { WatchPeriod } from '../shared/intelligence';
import { shareableTradeReplay } from './tradeReplaySharing';

export function tokenReplaySharing(token: Pick<Token, 'address' | 'symbol' | 'name'>, period: WatchPeriod) {
  const name = Array.from((token.symbol || token.name || 'Token').replace(/\s+/gu, ' ').trim()).slice(0, 50).join('');
  const address = token.address.trim().toLowerCase();
  const url = /^0x[0-9a-f]{40}$/.test(address) ? `https://kollens.com/token/${address}` : 'https://kollens.com/';
  const caption = `${name} · ${period} market-cap replay, tracked with kollens.`;
  return { name, url, caption, xIntent: `https://x.com/intent/post?${new URLSearchParams({ text: caption, url })}` };
}
export async function shareTokenReplayFile(file: File, token: Token, period: WatchPeriod) {
  if (!shareableTradeReplay(file)) throw new Error('File sharing is unavailable. Download the video and attach it on X.');
  const details = tokenReplaySharing(token, period);
  await navigator.share({ files: [file], title: `${details.name} | kollens`, text: details.caption });
}
