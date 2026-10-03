import { last24hStart } from './dayWindow.js';

export type ValuedTrade = {
  walletAddress: string;
  tokenAddress: string;
  side: string;
  tokenAmount: string | null;
  amountUsd: string | null;
  timestamp: string | Date;
  blockNumber?: string | number | null;
  transactionIndex?: number | null;
  txHash?: string;
  tokenSymbol?: string | null;
  quoteSymbol?: string | null;
  quoteAmount?: string | null;
};

type Lot = { quantity: number; costPerToken: number | null };
type Stat = { walletAddress: string; period: string; realizedProfitUsd: number | null; buyCount: number; sellCount: number; winRate: number | null };

export function calculateLeaderboard(trades: ValuedTrade[], wallets: string[], now = Date.now()): Stat[] {
  const periods = [{ name: '1d', days: 1 }, { name: '7d', days: 7 }, { name: '30d', days: 30 }];
  const results = new Map<string, Stat>();
  for (const wallet of wallets) for (const period of periods) results.set(`${wallet}:${period.name}`, {
    walletAddress: wallet, period: period.name, realizedProfitUsd: null, buyCount: 0, sellCount: 0, winRate: null,
  });
  const lots = new Map<string, Lot[]>();
  const incomplete = new Set<string>();
  for (const trade of trades) {
    const time = new Date(trade.timestamp).getTime();
    const quantity = Number(trade.tokenAmount);
    if (!Number.isFinite(time) || !(quantity > 0) || !Number.isFinite(quantity) || !['buy', 'sell'].includes(trade.side)) continue;
    const amountUsd = trade.amountUsd == null ? null : Number(trade.amountUsd);
    const valued = amountUsd != null && Number.isFinite(amountUsd) && amountUsd >= 0;
    const key = `${trade.walletAddress}:${trade.tokenAddress}`;
    const queue = lots.get(key) || [];
    lots.set(key, queue);
    for (const period of periods) {
      if (time < now - period.days * 86400_000) continue;
      const stat = results.get(`${trade.walletAddress}:${period.name}`);
      if (stat) trade.side === 'buy' ? stat.buyCount++ : stat.sellCount++;
    }
    if (trade.side === 'buy') {
      queue.push({ quantity, costPerToken: valued ? amountUsd! / quantity : null });
      continue;
    }
    let remaining = quantity;
    let realized = 0;
    let fullyValued = valued;
    while (remaining > 1e-12 && queue.length) {
      const lot = queue[0];
      const used = Math.min(remaining, lot.quantity);
      if (valued && lot.costPerToken != null) {
        realized += (amountUsd! / quantity - lot.costPerToken) * used;
      } else fullyValued = false;
      remaining -= used;
      lot.quantity -= used;
      if (lot.quantity <= 1e-12) queue.shift();
    }
    if (remaining > 1e-12) fullyValued = false;
    for (const period of periods) {
      if (time < now - period.days * 86400_000) continue;
      const statKey = `${trade.walletAddress}:${period.name}`;
      const stat = results.get(statKey);
      if (!stat) continue;
      if (fullyValued) stat.realizedProfitUsd = (stat.realizedProfitUsd || 0) + realized;
      else incomplete.add(statKey);
    }
  }
  for (const [key, stat] of results) {
    if (stat.sellCount === 0) stat.realizedProfitUsd = 0;
    else if (incomplete.has(key)) stat.realizedProfitUsd = null;
  }
  return [...results.values()];
}

export function calculateTodayLeaderboard(trades: ValuedTrade[], wallets: string[], windowStart: string, now = Date.now()) {
  return calculateWindowLeaderboard(trades, wallets, windowStart, now, 'today');
}

export function calculate24hLeaderboard(trades: ValuedTrade[], wallets: string[], now = Date.now()) {
  return calculateWindowLeaderboard(trades, wallets, last24hStart(now), now, '1d');
}

function calculateWindowLeaderboard(trades: ValuedTrade[], wallets: string[], windowStart: string, now: number, period: string) {
  const start = Date.parse(windowStart);
  const stats = new Map(wallets.map(walletAddress => [walletAddress, {
    walletAddress, period, windowStart, realizedProfitUsd: 0 as number | null,
    unrealizedProfitUsd: null, buyCount: 0, sellCount: 0, valuedSellCount: 0, excludedSellCount: 0,
  }]));
  const lots = new Map<string, Lot[]>();
  const ordered = trades.filter(trade => {
    const time = new Date(trade.timestamp).getTime();
    return time >= start && time <= now && !/dividend[_ ]?tracker/i.test(trade.tokenSymbol || '');
  }).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() ||
    Number(a.blockNumber || 0) - Number(b.blockNumber || 0) || (a.transactionIndex || 0) - (b.transactionIndex || 0));
  // A shared quote budget cannot be charged in full to multiple assets in one transaction.
  const budgets = new Map<string, Set<string>>();
  const budgetKey = (trade: ValuedTrade) => trade.txHash && trade.quoteAmount && trade.quoteSymbol && trade.amountUsd != null
    ? `${trade.txHash}:${trade.walletAddress}:${trade.side}:${trade.quoteSymbol}:${Number(trade.quoteAmount)}:${Number(trade.amountUsd)}` : null;
  for (const trade of ordered) {
    const key = budgetKey(trade);
    if (key) { const assets = budgets.get(key) || new Set<string>(); assets.add(trade.tokenAddress); budgets.set(key, assets); }
  }
  for (const trade of ordered) {
    const stat = stats.get(trade.walletAddress);
    if (!stat || !['buy', 'sell'].includes(trade.side)) continue;
    const quantity = Number(trade.tokenAmount);
    const value = trade.amountUsd == null ? NaN : Number(trade.amountUsd);
    const budget = budgetKey(trade);
    const priced = Number.isFinite(value) && value >= 0 && (!budget || budgets.get(budget)!.size === 1);
    if (trade.side === 'buy') stat.buyCount++; else stat.sellCount++;
    if (!(quantity > 0) || !Number.isFinite(quantity)) {
      if (trade.side === 'sell') stat.excludedSellCount++;
      continue;
    }
    const key = `${trade.walletAddress}:${trade.tokenAddress}`;
    const queue = lots.get(key) || [];
    lots.set(key, queue);
    if (trade.side === 'buy') {
      queue.push({ quantity, costPerToken: priced ? value / quantity : null });
      continue;
    }
    let remaining = quantity;
    let profit = 0;
    let complete = priced;
    const tolerance = Math.max(1e-12, quantity * 1e-12);
    while (remaining > tolerance && queue.length) {
      const lot = queue[0];
      const used = Math.min(remaining, lot.quantity);
      if (priced && lot.costPerToken != null) profit += used * (value / quantity - lot.costPerToken);
      else complete = false;
      remaining -= used;
      lot.quantity -= used;
      if (lot.quantity <= tolerance) queue.shift();
    }
    if (remaining > tolerance) complete = false;
    if (complete) { stat.realizedProfitUsd = (stat.realizedProfitUsd || 0) + profit; stat.valuedSellCount++; }
    else stat.excludedSellCount++;
  }
  for (const stat of stats.values()) if (stat.sellCount > 0 && stat.valuedSellCount === 0) stat.realizedProfitUsd = null;
  return [...stats.values()];
}
