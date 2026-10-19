import type { PoolClient } from 'pg';
import type { NodeMarketQuote } from '../shared/nodeMarket.js';
import type { NodeExecution, NodeReceipt, NodeTransaction } from './nodeExecution.js';
import type { NodeProjectionTokenMetadata } from './nodeProjectionMetadata.js';
import { journalDecimalDivide, journalDecimalMultiply } from './nodeAccountingLedger.js';
import { TRUSTED_QUOTE_FEEDS } from './nodeMarketProtocols.js';
import { nodeNativeTradeValue, type NodeCallTrace } from './nodeTrace.js';
import { walletTransactionContext } from './smartAccountTrades.js';
import { hasRecognizedSwap, walletSwapFlows } from './swap.js';

export interface PreparedNodeTradeProjection {
  metadata: ReadonlyMap<string, NodeProjectionTokenMetadata>;
  oracle: { price: number | string; updatedAt: number } | null;
  conversions: ReadonlyMap<string, NodeMarketQuote>;
  trace?: NodeCallTrace | null;
}
export interface NodeTradeProjectionInput {
  transaction: NodeTransaction; receipt: NodeReceipt;
  block: { number: string; hash: string; timestamp: string };
  wallet: string; live?: boolean; onlyToken?: string; execution?: NodeExecution;
}
const units = (value: bigint, decimals: number) => {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / divisor}${fraction ? `.${fraction}` : ''}`;
};

/** All reads, node calls and metadata preparation must finish before acquiring
 * the caller's transaction. This writer can only use that supplied connection. */
export async function writeNodeTradeProjection(database: Pick<PoolClient, 'query'>, input: NodeTradeProjectionInput, prepared: PreparedNodeTradeProjection) {
  const { transaction: tx, receipt, block, wallet, live = false, onlyToken, execution } = input;
  const context = execution ? { logs: execution.logs, nativeValue: BigInt(execution.nativeValueRaw), router: tx.to } : walletTransactionContext(tx, receipt, wallet);
  if (!context) return;
  const { logs, nativeValue, router } = context;
  const entries = [...walletSwapFlows(wallet, nativeValue, logs).entries()];
  if (!entries.length) return;
  const nativeIn = nativeValue > 0n, oracle = prepared.oracle;
  const flows = entries.map(([address, raw]) => {
    const meta = prepared.metadata.get(address);
    if (!meta) throw new Error('node_projection_metadata_not_prepared');
    return { address, raw, amount: meta.decimals == null ? null : units(raw < 0n ? -raw : raw, meta.decimals), symbol: meta.symbol };
  });
  const quote = (direction: bigint) => flows.find(flow => flow.raw * direction > 0n && Object.hasOwn(TRUSTED_QUOTE_FEEDS, flow.address));
  const directional = hasRecognizedSwap(logs) || nativeIn;
  for (const flow of flows) {
    if (onlyToken && flow.address !== onlyToken) continue;
    const opposing = quote(flow.raw > 0n ? -1n : 1n) || flows.find(other => other.address !== flow.address && other.raw * flow.raw < 0n);
    const isQuote = Object.hasOwn(TRUSTED_QUOTE_FEEDS, flow.address);
    if (isQuote && flows.some(other => other.address !== flow.address && other.raw * flow.raw < 0n)) continue;
    const nativeAmount = !opposing && flows.length === 1 && (!execution || execution.kind === 'transaction')
      && tx.from.toLowerCase() === wallet && (flow.raw < 0n || nativeIn)
      ? nodeNativeTradeValue({ wallet, side: flow.raw > 0n ? 'buy' : 'sell', token: flow.address,
        tokenAmountRaw: flow.raw < 0n ? -flow.raw : flow.raw, logs, transactionTo: router, trace: prepared.trace }).amount : null;
    const quoteSymbol = opposing ? opposing.symbol : nativeAmount !== null ? 'BNB' : null;
    const quoteAmount = opposing ? opposing.amount : nativeAmount !== null ? units(nativeAmount, 18) : null;
    const conversion = opposing && Object.hasOwn(TRUSTED_QUOTE_FEEDS, opposing.address) ? prepared.conversions.get(opposing.address) : null;
    const nativeQuote = !opposing && quoteAmount && oracle;
    const amountUsd = quoteAmount && conversion?.priceUsd && !conversion.stale ? journalDecimalMultiply(quoteAmount, conversion.priceUsd)
      : nativeQuote ? journalDecimalMultiply(quoteAmount!, String(oracle!.price)) : null;
    const priceUsd = amountUsd && flow.amount != null && Number(flow.amount) > 0 ? journalDecimalDivide(amountUsd, flow.amount) : null;
    const side = directional ? (flow.raw > 0n ? 'buy' : 'sell') : 'unknown';
    const identity = execution ? `${execution.id}:${flow.address}` : `${tx.hash.toLowerCase()}:${wallet}:${flow.address}`;
    const conflict = execution ? '(execution_id,token_address) WHERE execution_id IS NOT NULL' : '(tx_hash,wallet_address,token_address) WHERE execution_id IS NULL';
    await database.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,quote_token_address,quote_symbol,quote_amount,amount_usd,price_usd,block_number,block_hash,timestamp,source,verification_attempted_at,transaction_index,execution_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14),'node',now(),$15,$16)
      ON CONFLICT${conflict} DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,transaction_index=EXCLUDED.transaction_index,side=CASE WHEN EXCLUDED.side='unknown' THEN trades.side ELSE EXCLUDED.side END,token_amount=COALESCE(EXCLUDED.token_amount,trades.token_amount),quote_token_address=COALESCE(trades.quote_token_address,EXCLUDED.quote_token_address),quote_symbol=COALESCE(trades.quote_symbol,EXCLUDED.quote_symbol),quote_amount=COALESCE(EXCLUDED.quote_amount,trades.quote_amount),amount_usd=COALESCE(EXCLUDED.amount_usd,trades.amount_usd),price_usd=COALESCE(EXCLUDED.price_usd,trades.price_usd),source=CASE WHEN trades.source='gmgn' THEN 'node+gmgn' ELSE trades.source END,verification_attempted_at=now()`,
      [identity, tx.hash.toLowerCase(), wallet, flow.address, side, flow.amount, opposing?.address || null, quoteSymbol, quoteAmount, amountUsd, priceUsd, Number(BigInt(block.number)), block.hash, Number(BigInt(block.timestamp)), tx.transactionIndex == null ? null : Number(BigInt(tx.transactionIndex)), execution?.id ?? null]);
    if (live) await database.query('UPDATE trades SET observed_live=true WHERE id=$1', [identity]);
  }
  await database.query('UPDATE kols SET last_seen_at=GREATEST(last_seen_at,to_timestamp($2)) WHERE address=$1', [wallet, Number(BigInt(block.timestamp))]);
}
