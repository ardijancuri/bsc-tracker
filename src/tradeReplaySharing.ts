import type { TradeReplayData } from './tradeReplayData';

const unavailableMessage = 'File sharing is unavailable. Download the video and attach it on X.';

function replayName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/gu, ' ').trim() || fallback;
  return Array.from(normalized).slice(0, 50).join('');
}

function replayNames(data: TradeReplayData) {
  return {
    kol: replayName(data.kol.name, 'KOL'),
    token: replayName(data.token.symbol || data.token.name, 'Token'),
  };
}

/** Opens an editable draft only. X web intents cannot attach the local replay file. */
export function tradeReplayXIntent(data: TradeReplayData): string {
  const names = replayNames(data);
  const wallet = data.kol.address.trim().toLowerCase();
  const page = data.requestContext ? 'https://kollens.com/journal' : /^0x[0-9a-f]{40}$/.test(wallet) ? `https://kollens.com/kol/${wallet}` : 'https://kollens.com/';
  const query = new URLSearchParams({
    text: `${names.kol}'s ${names.token} trade replay, tracked with kollens.`,
    url: page,
  });
  return `https://x.com/intent/post?${query.toString()}`;
}

export function shareableTradeReplay(file: File): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Call directly from a fresh user click after recording has completed. */
export async function shareTradeReplayFile(file: File, data: TradeReplayData): Promise<void> {
  if (!shareableTradeReplay(file)) throw new Error(unavailableMessage);
  const names = replayNames(data);
  await navigator.share({
    files: [file],
    title: `${names.kol} · ${names.token} | kollens`,
    text: `${names.kol}'s ${names.token} trade replay, tracked with kollens.`,
  });
}
