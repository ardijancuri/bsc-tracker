import type { PoolClient } from 'pg';
import type { KolTokenBalanceProof } from '../shared/kolTokenTrades.js';
import { journalDecimalDivide, journalDecimalMultiply, type JournalLedgerCoverage, type JournalLedgerEvent } from './journalLedger.js';
import { journalNodeFees } from './journalNodeFees.js';
import { blockHex, chainRpc } from './rpc.js';
import { hasRecognizedSwap } from './swap.js';
import { walletTransactionContext } from './smartAccountTrades.js';
type Database = Pick<PoolClient, 'query'>;
type Pair = { wallet: string; token: string; decimals: number | null; trades?: unknown[] };
export interface JournalNodeEvidence {
  source: 'node'; events: JournalLedgerEvent[]; coverage: JournalLedgerCoverage;
  proof: KolTokenBalanceProof; reason?: string;
}
const units = (raw: bigint, decimals: number) => {
  const absolute = raw < 0n ? -raw : raw, divisor = 10n ** BigInt(decimals), fraction = (absolute % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw < 0n ? '-' : ''}${absolute / divisor}${fraction ? `.${fraction}` : ''}`;
};
function rawQuantity(value: string, decimals: number) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length || 0) > decimals) return null;
  return BigInt(match[1] + (match[2] || '').padEnd(decimals, '0'));
}
const iso = (value: string | Date) => new Date(value).toISOString();

/** Read permanently captured node evidence. A positive opening balance needs
 * historical acquisition evidence and therefore falls back to recovery. Empty
 * openings can be proved by the registration call, or derived from a complete
 * receipt transfer range and a confirmed ending balance after node pruning. */
export async function tryLoadJournalNodeEvidence(database: Database, pair: Pair,
  options: { balance: KolTokenBalanceProof; now?: number }): Promise<JournalNodeEvidence | null> {
  const { wallet, token, decimals } = pair, now = options.now ?? Date.now();
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const state = (await database.query(`SELECT c.*,c.registration_block::text AS registration,c.collected_from_block::text AS first,
    c.collected_through_block::text AS last,c.repair_from_block::text AS repair,
    (SELECT (value->>'blockNumber')::text FROM worker_state WHERE key='node') AS confirmed,
    (SELECT value->>'blockHash' FROM worker_state WHERE key='node') AS confirmed_hash
    FROM journal_wallet_coverage c WHERE c.wallet_address=$1`, [wallet])).rows[0];
  if (!state || !/^\d+$/.test(state.registration || '') || !/^\d+$/.test(state.last || '') || !/^\d+$/.test(state.first || '') || !/^\d+$/.test(state.confirmed || '')) return null;
  const registration = BigInt(state.registration), last = BigInt(state.last), confirmed = BigInt(state.confirmed);
  if (BigInt(state.first) > registration + 1n || state.repair != null && BigInt(state.repair) <= (last < confirmed ? last : confirmed)) return null;
  // A zero opening balance may follow an earlier closed cycle. Known historical
  // proceeds/capital must survive rather than silently becoming a new zero P&L.
  const prior = (await database.query(`SELECT EXISTS(SELECT 1 FROM trades WHERE wallet_address=$1 AND token_address=$2
      AND block_number IS NOT NULL AND block_number<=$3 AND side IN('buy','sell'))
    OR EXISTS(SELECT 1 FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND block_number<=$3)
    OR EXISTS(SELECT 1 FROM journal_provider_movements WHERE wallet_address=$1 AND token_address=$2 AND timestamp<$4::timestamptz) AS older`,
  [wallet, token, registration.toString(), state.registered_at ?? new Date(0).toISOString()])).rows[0]?.older;
  if (prior) return null;
  let proof = options.balance;
  if (proof.walletAddress !== wallet || proof.tokenAddress !== token || proof.chain !== 'bsc' || !/^\d+$/.test(proof.blockNumber)) return null;
  const through = last < confirmed ? last : confirmed;
  if (through < registration) return null;
  if (BigInt(proof.blockNumber) > through) {
    try {
      const [block, raw] = await Promise.all([
        chainRpc<{ number: string; hash: string; timestamp: string }>('eth_getBlockByNumber', [blockHex(through.toString()), false]),
        chainRpc<string>('eth_call', [{ to: token, data: `0x70a08231${wallet.slice(2).padStart(64, '0')}` }, blockHex(through.toString())]),
      ]);
      if (BigInt(block.number) !== through || !/^0x[0-9a-f]{64}$/i.test(block.hash) || !/^0x[0-9a-f]{64}$/i.test(raw)) return null;
      proof = { ...proof, blockNumber: through.toString(), blockHash: block.hash.toLowerCase(), blockTimestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), balance: units(BigInt(raw), decimals), checkedAt: new Date(now).toISOString() };
    } catch { return null; }
  }
  const ending = rawQuantity(proof.balance, decimals);
  if (ending == null || BigInt(proof.blockNumber) < registration) return null;
  const [trades, transfers, evidenceRows] = await Promise.all([
    database.query(`SELECT t.id,t.tx_hash,t.side,t.token_amount::text,t.amount_usd::text,t.price_usd::text,t.quote_amount::text,t.quote_symbol,
      t.block_number::text,t.block_hash,t.transaction_index,t.timestamp,
      EXISTS(SELECT 1 FROM trades other JOIN tokens asset ON asset.address=other.token_address
        WHERE other.wallet_address=t.wallet_address AND other.tx_hash=t.tx_hash AND other.side=t.side
          AND other.token_address<>t.token_address AND other.block_number IS NOT NULL
          AND other.quote_symbol=t.quote_symbol AND other.quote_amount=t.quote_amount AND other.amount_usd=t.amount_usd
          AND COALESCE(asset.symbol,'') !~* 'dividend[_ ]?tracker') AS "sharedQuote"
      FROM trades t WHERE t.wallet_address=$1 AND t.token_address=$2
      AND t.block_number>$3 AND t.block_number<=$4 AND t.side IN('buy','sell') ORDER BY t.block_number,t.transaction_index,t.id`, [wallet, token, registration.toString(), proof.blockNumber]),
    database.query(`SELECT id,tx_hash,log_index,delta_raw::text,kind,block_number::text,block_hash,timestamp,counterparty_address
      FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,log_index,id`, [wallet, token, registration.toString(), proof.blockNumber]),
    database.query(`SELECT e.* FROM journal_node_evidence e WHERE e.block_number>$3 AND e.block_number<=$4 AND
      (EXISTS(SELECT 1 FROM trades t WHERE t.tx_hash=e.tx_hash AND t.wallet_address=$1 AND t.token_address=$2)
       OR EXISTS(SELECT 1 FROM wallet_transfers m WHERE m.tx_hash=e.tx_hash AND m.wallet_address=$1 AND m.token_address=$2))`, [wallet, token, registration.toString(), proof.blockNumber]),
  ]);
  let delta = 0n;
  try { for (const row of transfers.rows) delta += BigInt(row.delta_raw); } catch { return null; }
  let opening: bigint | null = null, openingHash: string | null = state.registration_hash;
  const cached = (await database.query(`SELECT balance_raw::text,block_hash,decimals FROM journal_opening_balances WHERE wallet_address=$1 AND token_address=$2 AND block_number=$3`, [wallet, token, registration.toString()])).rows[0];
  if (cached && Number(cached.decimals) === decimals && cached.block_hash === state.registration_hash) opening = BigInt(cached.balance_raw);
  if (opening == null) {
    try {
      const [block, raw] = await Promise.all([
        chainRpc<{ number: string; hash: string }>('eth_getBlockByNumber', [blockHex(registration.toString()), false]),
        chainRpc<string>('eth_call', [{ to: token, data: `0x70a08231${wallet.slice(2).padStart(64, '0')}` }, blockHex(registration.toString())]),
      ]);
      if (BigInt(block.number) !== registration || state.registration_hash && block.hash.toLowerCase() !== state.registration_hash.toLowerCase() || !/^0x[0-9a-f]{64}$/i.test(raw)) return null;
      opening = BigInt(raw); openingHash = block.hash.toLowerCase();
    } catch {
      // This derives a boundary from complete permanent logs; it does not scan
      // pruned RPC history or treat a missing log range as an empty one.
      opening = ending - delta;
    }
    if (opening < 0n || !openingHash) return null;
    await database.query(`INSERT INTO journal_opening_balances(wallet_address,token_address,block_number,block_hash,balance_raw,decimals)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(wallet_address,token_address,block_number) DO NOTHING`, [wallet, token, registration.toString(), openingHash, opening.toString(), decimals]);
  }
  if (opening !== 0n || opening + delta !== ending) return null;
  const evidence = new Map<string, any>(evidenceRows.rows.map(row => [row.tx_hash, row])), reasons = new Set<string>();
  const proofTime = Date.parse(proof.blockTimestamp);
  if (!Number.isFinite(proofTime) || proofTime > now + 1000 || now - proofTime > 180_000) reasons.add('indexing_lag');
  if (proof.blockNumber === confirmed.toString() && state.confirmed_hash && state.confirmed_hash.toLowerCase() !== proof.blockHash.toLowerCase()) reasons.add('chain_reorganization');
  const feeByTx = new Map<string, string | null>();
  const fee = (txHash: string) => {
    if (feeByTx.has(txHash)) return feeByTx.get(txHash)!;
    const row = evidence.get(txHash);
    if (!row) { reasons.add('receipt_evidence_unavailable'); feeByTx.set(txHash, null); return null; }
    const decoded = journalNodeFees(row.transaction, row.receipt, wallet);
    if (!decoded.complete) {
      // A pure incoming token transfer does not charge the recipient the
      // unrelated sender's gas. Unknown smart-wallet execution remains unknown.
      const ownOut = transfers.rows.some(movement => movement.tx_hash === txHash && BigInt(movement.delta_raw) < 0n);
      if (decoded.reason === 'wallet_fee_payer_unknown' && row.transaction.from?.toLowerCase() !== wallet && !ownOut) { feeByTx.set(txHash, '0'); return '0'; }
      reasons.add(decoded.reason || 'fees_incomplete'); feeByTx.set(txHash, null); return null;
    }
    const raw = decoded.fees.reduce((value, item) => value + BigInt(item.nativeWei), 0n);
    let usd: string | null = raw === 0n ? '0' : null;
    if (usd == null) {
      const quoted = trades.rows.find(trade => trade.tx_hash === txHash && ['BNB', 'WBNB'].includes(trade.quote_symbol?.toUpperCase()) && trade.amount_usd && trade.quote_amount);
      const fx = row.bnb_price_usd != null ? String(row.bnb_price_usd) : quoted ? journalDecimalDivide(quoted.amount_usd, quoted.quote_amount) : null;
      usd = fx ? journalDecimalMultiply(units(raw, 18), fx) : null;
    }
    if (usd == null) reasons.add('fee_valuation_unavailable');
    feeByTx.set(txHash, usd); return usd;
  };
  const events: JournalLedgerEvent[] = [];
  for (const row of trades.rows) {
    if (evidence.get(row.tx_hash)?.block_hash !== row.block_hash) reasons.add('receipt_block_unreconciled');
    if (row.sharedQuote) reasons.add('shared_quote_unallocated');
    const amount = rawQuantity(row.token_amount, decimals), movements = transfers.rows.filter(movement => movement.tx_hash === row.tx_hash && movement.kind !== 'transfer');
    const net = movements.reduce((value, movement) => value + BigInt(movement.delta_raw), 0n);
    if (amount == null || amount !== (row.side === 'buy' ? net : -net)) reasons.add('swap_movement_unreconciled');
    events.push({ id: row.id, kind: row.side, walletAddress: wallet, tokenAddress: token, tokenAmount: row.token_amount,
      amountUsd: row.sharedQuote ? null : row.amount_usd, feeUsd: fee(row.tx_hash), feeId: row.tx_hash, txHash: row.tx_hash, timestamp: iso(row.timestamp),
      blockNumber: row.block_number, transactionIndex: row.transaction_index, logIndex: null });
  }
  const prices = new Map<string, string | null>();
  for (const row of transfers.rows.filter(row => row.kind === 'transfer')) {
    if (evidence.get(row.tx_hash)?.block_hash !== row.block_hash) reasons.add('receipt_block_unreconciled');
    const receipt = evidence.get(row.tx_hash), initiates = receipt && walletTransactionContext(receipt.transaction, receipt.receipt, wallet);
    if (receipt && hasRecognizedSwap(receipt.receipt.logs) && (initiates || journalNodeFees(receipt.transaction, receipt.receipt, wallet).fees.some(item => item.kind === 'user_operation'))) reasons.add('decoding_incomplete');
    let price = prices.get(row.block_number);
    if (price === undefined) {
      const observed = (await database.query(`SELECT price_usd::text FROM trades WHERE token_address=$1 AND block_number=$2 AND block_hash=$3
        AND side IN('buy','sell') AND amount_usd IS NOT NULL AND price_usd>0 AND source IN('node','node+gmgn')
        ORDER BY ABS(COALESCE(transaction_index,0)-$4),id LIMIT 1`, [token, row.block_number, row.block_hash, receipt?.transaction.transactionIndex ? Number(BigInt(receipt.transaction.transactionIndex)) : 0])).rows[0];
      price = observed?.price_usd == null ? null : String(observed.price_usd); prices.set(row.block_number, price);
    }
    const raw = BigInt(row.delta_raw), quantity = units(raw < 0n ? -raw : raw, decimals);
    events.push({ id: row.id, walletAddress: wallet, tokenAddress: token, kind: raw < 0n ? 'transfer_out' : 'transfer_in', tokenAmount: quantity,
      amountUsd: price ? journalDecimalMultiply(quantity, price) : null, feeUsd: fee(row.tx_hash), feeId: row.tx_hash, txHash: row.tx_hash,
      timestamp: iso(row.timestamp), blockNumber: row.block_number, transactionIndex: receipt?.transaction.transactionIndex != null ? Number(BigInt(receipt.transaction.transactionIndex)) : null,
      logIndex: row.log_index, counterparty: row.counterparty_address ?? null, transferId: `${row.tx_hash}:${token}:${row.log_index}` });
  }
  const reason = [...reasons].sort()[0];
  return { source: 'node', events, proof, coverage: { walletAddress: wallet, tokenAddress: token, complete: reasons.size === 0, ...(reason ? { reason } : {}) }, ...(reason ? { reason } : {}) };
}
