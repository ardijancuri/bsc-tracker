import type { TelegramMessageButton, TelegramMessageEntity } from './telegramBot.js';

export type TelegramMessageTrade = {
  id: string; txHash: string; walletAddress: string; tokenAddress: string; kolName: string | null; tokenSymbol: string | null;
  side: 'buy' | 'sell'; tokenAmount: string | null; quoteAmount: string | null; quoteSymbol: string | null; amountUsd: string | null; timestamp: string;
};
export type TelegramFormattedMessage = { text: string; buttons: TelegramMessageButton[][]; entities?: TelegramMessageEntity[] };
type Language = 'en' | 'zh-CN';
const clean = (value: string | null | undefined, max = 60) => Array.from((value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
const address = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : '';
const transaction = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : '';
const shortAddress = (value: string) => address(value) ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';

/** Formats provider decimal strings without floating-point overflow or changing the recorded quantity. */
function decimal(value: string | null, places: number): string | null {
  if (!value || value.length > 160 || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [integer, fraction = ''] = value.split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  if (whole.length > 27) return null;
  const clipped = fraction.slice(0, places).replace(/0+$/, '');
  if (whole === '0' && fraction && !clipped && /[1-9]/.test(fraction)) return `<0.${'0'.repeat(places - 1)}1`;
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (clipped ? `.${clipped}` : '');
}

function sourceTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC` : '—';
}

function safeOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.origin;
  } catch { /* Safe production default for unusable internal configuration. */ }
  return 'https://kollens.com';
}

export function formatTelegramTradeMessage(trades: TelegramMessageTrade[], language: Language, origin: string): TelegramFormattedMessage {
  const zh = language === 'zh-CN';
  const first = trades[0];
  const base = safeOrigin(origin);
  if (!first) return { text: zh ? 'Kollens · 暂无新交易' : 'Kollens · No new trades', buttons: [[{ text: zh ? '查看关注列表' : 'Open watchlist', url: `${base}/watchlist` }]] };
  const kol = clean(first.kolName) || shortAddress(first.walletAddress);
  const buys = trades.filter(trade => trade.side === 'buy').length;
  const sells = trades.length - buys;
  const wallet = address(first.walletAddress), token = address(first.tokenAddress), tx = transaction(first.txHash);
  let text = '';
  const entities: TelegramMessageEntity[] = [];
  // Telegram entity offsets use UTF-16 units, matching JavaScript string lengths.
  const add = (value: string, bold = false, url?: string) => {
    const offset = text.length; text += value;
    if (bold) entities.push({ type: 'bold', offset, length: value.length });
    if (url) entities.push({ type: 'text_link', offset, length: value.length, url });
  };
  add('🔔 '); add(kol, true, wallet ? `${base}/kol/${wallet}` : undefined); add(' · Kollens\n');
  if (trades.length > 1) add(zh ? `🟢 买入 ${buys} · 🔴 卖出 ${sells}\n` : `🟢 ${buys} buys · 🔴 ${sells} sells\n`);
  let visible = 0;
  // Keep buys and sells separate, preserving time order within each side.
  const ordered = trades.length > 1 ? [...trades.filter(trade => trade.side === 'buy'), ...trades.filter(trade => trade.side === 'sell')] : trades;
  let previousSide: TelegramMessageTrade['side'] | undefined;
  for (const trade of ordered) {
    if (visible >= 12) break;
    const token = clean(trade.tokenSymbol, 40) || shortAddress(trade.tokenAddress);
    const side = trade.side === 'buy' ? (zh ? '买入' : 'BUY') : (zh ? '卖出' : 'SELL');
    const usd = decimal(trade.amountUsd, 2);
    const quote = decimal(trade.quoteAmount, 6);
    const quoteSymbol = clean(trade.quoteSymbol, 16);
    const tokenAmount = decimal(trade.tokenAmount, 6);
    const tokenAddress = address(trade.tokenAddress), hash = transaction(trade.txHash);
    // Append whole rows; keep every formatting entity inside the message bound.
    const estimatedLength = token.length * 2 + (usd?.length ?? 0) + (quote?.length ?? 0) + quoteSymbol.length + (tokenAmount?.length ?? 0) + 140;
    if (text.length + estimatedLength > 3200) break;
    add('\n');
    if (trades.length > 1 && previousSide !== trade.side) add(trade.side === 'buy' ? (zh ? '🟢 买入\n' : '🟢 BUYS\n') : (zh ? '🔴 卖出\n' : '🔴 SELLS\n'), true);
    if (trades.length === 1) add(`${trade.side === 'buy' ? '🟢' : '🔴'} ${side} `, true);
    add(token, true, tokenAddress ? `${base}/token/${tokenAddress}` : undefined); add('\n');
    if (usd !== null) { add(`$${usd}`, true); if (quote !== null && quoteSymbol) add(` · ${quote} ${quoteSymbol}`); add('\n'); }
    else if (quote !== null && quoteSymbol) { add(`${quote} ${quoteSymbol}`, true); add('\n'); }
    if (tokenAmount !== null) { add(zh ? '代币数量：' : 'Tokens: '); add(`${tokenAmount} ${token}`); add('\n'); }
    add(`🕒 ${sourceTime(trade.timestamp)}`, false, hash ? `https://bscscan.com/tx/${hash}` : undefined); add('\n');
    previousSide = trade.side; visible++;
  }
  if (visible < trades.length) add(zh ? `\n另有 ${trades.length - visible} 笔交易；请在 Kollens 查看。` : `\n${trades.length - visible} more trades; view them on Kollens.`);
  const buttons: TelegramMessageButton[] = [{ text: zh ? '查看 KOL' : 'KOL profile', url: wallet ? `${base}/kol/${wallet}` : `${base}/watchlist?tab=kols` }];
  if (token && trades.every(trade => address(trade.tokenAddress) === token)) buttons.push({ text: zh ? '代币图表' : 'Token chart', url: `${base}/token/${token}` });
  const rows = [buttons];
  if (tx) rows.push([{ text: trades.length === 1 ? (zh ? '查看交易 ↗ BscScan' : 'View transaction ↗ BscScan') : (zh ? '首笔交易 ↗ BscScan' : 'First transaction ↗ BscScan'), url: `https://bscscan.com/tx/${tx}` }]);
  return { text, buttons: rows, entities };
}

export function formatActivationMessage(language: Language, origin: string): TelegramFormattedMessage {
  const zh = language === 'zh-CN';
  return { text: zh ? 'Kollens Telegram 提醒已开启。你将收到关注 KOL 的新交易提醒。发送 /stop 可暂停提醒。' : 'Kollens Telegram alerts are active. You will receive new trades from your favorite KOLs. Send /stop to pause alerts.', buttons: [[{ text: zh ? '提醒设置' : 'Alert settings', url: `${safeOrigin(origin)}/watchlist?tab=kols` }]] };
}

export function formatCorrectionMessage(language: Language, origin: string): TelegramFormattedMessage {
  const zh = language === 'zh-CN';
  return { text: zh ? 'Kollens · 链重组更正：先前的交易提醒已不在确认链上。请查看最新交易。' : 'Kollens · Chain correction: the earlier trade alert is no longer on the confirmed chain. Check the latest activity.', buttons: [[{ text: zh ? '查看关注列表' : 'Open watchlist', url: `${safeOrigin(origin)}/watchlist` }]] };
}
