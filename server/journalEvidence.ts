import type { JournalLedgerEvent } from './journalLedger.js';
import { journalDecimal, sumJournalDecimals } from './journalHistory.js';

function close(left: string, right: string) {
  const a = journalDecimal(left), b = journalDecimal(right); if (a === null || b === null) return false;
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const integer = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(scale, '0')); };
  const x = integer(a), y = integer(b), delta = x > y ? x - y : y - x;
  return delta * 1_000_000_000_000n <= (x > y ? x : y);
}
function withinUsdEvidence(left: string, right: string, fees: string) {
  const values = [left, right, fees, '0.01'], scale = Math.max(...values.map(value => value.split('.')[1]?.length ?? 0));
  const integer = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(scale, '0')); };
  const a = integer(left), b = integer(right), delta = a > b ? a - b : b - a;
  return delta <= integer(fees) + integer('0.01');
}
export interface JournalCanonicalTrade {
  id: string; txHash: string; side: string; tokenAmount: string | null; amountUsd: string | null;
  quoteAmount?: string | null; quoteSymbol?: string | null; timestamp: string | Date;
  blockNumber: string; transactionIndex: number | null;
  sharedQuote?: boolean;
}
export interface JournalStoredMovement {
  id: string; kind: JournalLedgerEvent['kind']; txHash: string; timestamp: string | Date;
  tokenAmount: string; amountUsd: string | null; feeUsd: string | null; counterparty: string | null;
  quoteAmount?: string | null; quoteSymbol?: string | null;
}
/** Preserve provider execution identities while checking the total overlapping
 * transaction quantity. A provider row is never promoted to a canonical trade. */
export function mergeJournalEvidence(wallet: string, token: string, recovered: JournalStoredMovement[], canonical: JournalCanonicalTrade[], complete: boolean) {
  const events: JournalLedgerEvent[] = recovered.map(row => ({ ...row, amountUsd: row.amountUsd === '0' && ['buy', 'transfer_in', 'transfer_out'].includes(row.kind) ? null : row.amountUsd, id: row.id, timestamp: new Date(row.timestamp).toISOString(), walletAddress: wallet, tokenAddress: token,
    // Equal quantities do not identify a transfer execution. Provider pairing
    // requires reciprocal counterparties; only receipt logs carry strong IDs.
    feeId: row.txHash, transferId: null }));
  const reasons = new Set<string>();
  const groups = new Map<string, typeof recovered>();
  for (const row of recovered) { const key = `${row.txHash}:${row.kind}`, rows = groups.get(key) ?? []; rows.push(row); groups.set(key, rows); }
  const canonicalGroups = new Map<string, JournalCanonicalTrade[]>();
  for (const row of canonical) { const key = `${row.txHash}:${row.side}`, rows = canonicalGroups.get(key) ?? []; rows.push(row); canonicalGroups.set(key, rows); }
  for (const [key, rows] of canonicalGroups) {
    if (rows.some(row => row.sharedQuote)) reasons.add('shared_quote_unallocated');
    const provider = groups.get(key);
    if (provider) {
      if (rows.some(row => row.tokenAmount === null) || !close(sumJournalDecimals(provider.map(row => row.tokenAmount)), sumJournalDecimals(rows.map(row => row.tokenAmount ?? '0')))) reasons.add('indexed_history_mismatch');
      const providersQuote = provider.every(row => row.quoteAmount !== null && row.quoteAmount !== undefined);
      const indexedQuote = rows.every(row => row.quoteAmount !== null && row.quoteAmount !== undefined);
      const symbols = new Set([...provider, ...rows].map(row => row.quoteSymbol).filter(Boolean));
      const quoteComparable = providersQuote && indexedQuote && symbols.size === 1;
      if (quoteComparable && !close(sumJournalDecimals(provider.map(row => row.quoteAmount!)), sumJournalDecimals(rows.map(row => row.quoteAmount!)))) reasons.add('indexed_value_mismatch');
      if (!quoteComparable) {
        // Different historical FX marks are permitted only within disclosed
        // transaction fees and cent rounding. An absent quote/cost is not a pass.
        if (provider.every(row => row.amountUsd !== null && row.feeUsd !== null) && rows.every(row => row.amountUsd !== null)) {
          if (!withinUsdEvidence(sumJournalDecimals(provider.map(row => row.amountUsd!)), sumJournalDecimals(rows.map(row => row.amountUsd!)), sumJournalDecimals(provider.map(row => row.feeUsd!)))) reasons.add('indexed_value_mismatch');
        } else reasons.add('overlap_value_unverified');
      }
      for (const row of provider) {
        if (!rows.some(indexed => Math.abs(Date.parse(new Date(indexed.timestamp).toISOString()) - Date.parse(new Date(row.timestamp).toISOString())) <= 1000)) reasons.add('indexed_history_mismatch');
        // A single aggregate row cannot establish the order of several smart
        // operations. Only one-to-one overlap carries the canonical ordinal.
        if (rows.length === 1 && provider.length === 1) {
          const event = events.find(event => event.id === row.id)!;
          event.blockNumber = rows[0].blockNumber; event.transactionIndex = rows[0].transactionIndex;
        }
      }
    } else {
      for (const row of rows) {
        if (!['buy', 'sell'].includes(row.side) || row.tokenAmount === null) { reasons.add('indexed_history_mismatch'); continue; }
        events.push({ ...row, amountUsd: row.sharedQuote || row.side === 'buy' && row.amountUsd === '0' ? null : row.amountUsd, kind: row.side as 'buy' | 'sell', tokenAmount: row.tokenAmount,
          timestamp: new Date(row.timestamp).toISOString(), walletAddress: wallet, tokenAddress: token, feeUsd: null, feeId: row.txHash });
      }
      if (complete) reasons.add('indexed_history_mismatch');
    }
  }
  // Transfer rows from a known swap are not an additional wallet movement.
  const swaps = new Set([...canonical, ...recovered.filter(row => row.kind === 'buy' || row.kind === 'sell')].map(row => row.txHash));
  return { events: events.filter(row => !row.kind.startsWith('transfer_') || !swaps.has(row.txHash)), reasons: [...reasons] };
}
