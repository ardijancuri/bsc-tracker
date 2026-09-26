export type ValuedTrade = {
  walletAddress: string;
  tokenAddress: string;
  side: string;
  tokenAmount: string | null;
  amountUsd: string | null;
  timestamp: string | Date;
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
