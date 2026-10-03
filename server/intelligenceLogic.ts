import { createHash } from 'node:crypto';
import type { AlertPreferences, PositionStatus, SignalKind } from '../shared/intelligence.js';

export interface ObservedTrade {
  id: string; txHash: string; walletAddress: string; tokenAddress: string; kolName: string | null;
  side: string; timestamp: string; blockNumber: string; blockHash: string; transactionIndex: number | null;
  observedLive?: boolean;
}
export interface SignalCandidate { id: string; kind: SignalKind; entity: string; wallets: string[]; evidence: ObservedTrade[]; timestamp: string }
export const profileKey = (preferences: Pick<AlertPreferences, 'windowMinutes' | 'minBuyers'>) => `${preferences.windowMinutes}:${preferences.minBuyers}`;
export const signalId = (kind: SignalKind, entity: string, trigger: string, profile = '10:3') => createHash('sha256').update(`${profile}:${kind}:${entity}:${trigger}`).digest('hex');
export function compareTrades(a: ObservedTrade, b: ObservedTrade) {
  const height = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  return height < 0n ? -1 : height > 0n ? 1 : (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || a.id.localeCompare(b.id);
}
export function detectSignals(trigger: ObservedTrade, history: ObservedTrade[], preferences: AlertPreferences): SignalCandidate[] {
  const time = Date.parse(trigger.timestamp);
  const previous = [...new Map(history.filter(row => row.tokenAddress === trigger.tokenAddress && compareTrades(row, trigger) <= 0).map(row => [`${row.txHash}:${row.walletAddress}`, row])).values()].sort(compareTrades);
  const recent = previous.filter(row => row.side === 'buy' && Date.parse(row.timestamp) >= time - preferences.windowMinutes * 60_000 && Date.parse(row.timestamp) <= time);
  const result: SignalCandidate[] = [];
  const add = (kind: SignalKind, entity: string, evidence: ObservedTrade[]) => {
    result.push({ id: signalId(kind, entity, `${trigger.id}:${trigger.blockHash}`, profileKey(preferences)), kind, entity,
      wallets: [...new Set(evidence.map(row => row.walletAddress))], evidence, timestamp: trigger.timestamp });
  };
  if (trigger.side === 'buy') {
    if (new Set(recent.map(row => row.walletAddress)).size >= preferences.minBuyers) add('clustered_buys', trigger.tokenAddress, recent);
    const own = recent.filter(row => row.walletAddress === trigger.walletAddress);
    if (new Set(own.map(row => row.txHash)).size >= 2) add('repeat_buy', `${trigger.tokenAddress}:${trigger.walletAddress}`, own);
  }
  if (trigger.side === 'sell') {
    const buy = previous.filter(row => row.side === 'buy' && row.walletAddress === trigger.walletAddress && compareTrades(row, trigger) < 0 && Date.parse(row.timestamp) >= time - 86400_000).at(-1);
    if (buy) add('buyer_selling', `${trigger.tokenAddress}:${trigger.walletAddress}`, [buy, trigger]);
  }
  return result;
}
export function cooldownAllows(previousAt: string | null, nextAt: string) {
  return !previousAt || Date.parse(nextAt) - Date.parse(previousAt) >= 600_000;
}
export function decimalUnits(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid token decimals');
  const divisor = 10n ** BigInt(decimals);
  const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw / divisor}${fraction ? `.${fraction}` : ''}`;
}
export interface PositionMovement { kind: 'buy' | 'sell' | 'transfer'; delta: bigint }
export function classifyPosition(previous: bigint | null, balance: bigint, movements: PositionMovement[], unchangedStatus: PositionStatus = 'Holding'): PositionStatus {
  if (previous == null) return balance > 0n ? 'Holding' : 'Unknown';
  const delta = balance - previous;
  const observed = movements.reduce((sum, movement) => sum + movement.delta, 0n);
  if (delta === 0n && !movements.length) return unchangedStatus;
  if (delta !== observed || !movements.length) return 'Unknown';
  const kinds = new Set(movements.filter(movement => movement.delta !== 0n).map(movement => movement.kind));
  if (kinds.size !== 1) return 'Unknown';
  if (kinds.has('transfer')) return 'Transferred';
  if (kinds.has('buy') && delta > 0n) return previous > 0n ? 'Added' : 'Holding';
  if (kinds.has('sell') && delta < 0n) return balance === 0n ? 'Exited' : 'Reduced';
  return 'Unknown';
}
export function positionIsFresh(checkedAt: string | null, now = Date.now()) {
  return Boolean(checkedAt && now - Date.parse(checkedAt) <= 300_000 && Date.parse(checkedAt) <= now + 30_000);
}
