import { freshDecimal, FreshRational } from './accounting.js';
import { freshPositionReceiptRawRelevantSql, freshPositionReceiptOpaqueSql,freshPendingTradeInScopeSql } from './positionDependencies.js';

type Row = Record<string, any>;

/** A public pending badge cannot expose earlier private-only wallet activity. */
export function freshPublicTokenDiscoveryPendingSql() {
  return `EXISTS(SELECT 1 FROM fresh.recent_evidence discovery_receipt
    JOIN fresh.recent_blocks discovery_block ON discovery_block.block_number=discovery_receipt.block_number AND discovery_block.block_hash=discovery_receipt.block_hash
    JOIN fresh.accounting_scopes discovery_scope ON discovery_scope.id='kol:'||k.wallet_address
      AND discovery_scope.kind='kol' AND discovery_scope.account_id IS NULL AND discovery_scope.active
      AND discovery_scope.wallet_addresses=ARRAY[k.wallet_address]::text[]
    WHERE k.is_tracked AND w.active AND discovery_receipt.wallet_addresses@>ARRAY[k.wallet_address]::text[]
      AND discovery_receipt.decoder_status<>'done' AND discovery_receipt.last_error LIKE '%token_discovery_pending%'
      AND discovery_receipt.block_number>=discovery_scope.starts_block AND discovery_block.occurred_at>=discovery_scope.starts_at
      AND discovery_receipt.block_number>=w.monitoring_from_block
      AND(w.monitoring_to_block IS NULL OR discovery_receipt.block_number<=w.monitoring_to_block)
      AND discovery_block.occurred_at >= $1::timestamptz AND discovery_block.occurred_at <= $2::timestamptz)`;
}

/** Old unrelated repairs cannot change today's stored totals. Opaque evidence,
 * missing canonical time, every current-day receipt, and any earlier movement
 * touching a token used today still prevent a complete daily rank. */
export function freshDailyLeaderboardPendingSql() {
  return `(EXISTS(SELECT 1 FROM fresh.recent_evidence e
    LEFT JOIN fresh.recent_blocks h ON h.block_number=e.block_number AND h.block_hash=e.block_hash
    WHERE e.wallet_addresses@>ARRAY[w.address]::text[] AND e.decoder_status<>'done' AND (
      h.block_number IS NULL OR h.occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
      OR ${freshPositionReceiptOpaqueSql('e')}
      OR EXISTS(SELECT 1 FROM fresh.scope_event_results daily
        WHERE daily.scope_id='kol:'||w.address
        AND daily.occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
        AND daily.occurred_at < (($1::date+1)::timestamp AT TIME ZONE 'UTC')
        AND ${freshPositionReceiptRawRelevantSql('e', 'daily.token_address')})
    )) OR EXISTS(SELECT 1 FROM fresh.accounting_scopes pending_scope JOIN fresh.pending_trades pending ON pending.wallet_address=w.address
     WHERE pending_scope.id='kol:'||w.address AND ${freshPendingTradeInScopeSql('pending','pending_scope')} AND(
      pending.occurred_at>=($1::date::timestamp AT TIME ZONE 'UTC') AND pending.occurred_at<(($1::date+1)::timestamp AT TIME ZONE 'UTC')
      OR pending.occurred_at<($1::date::timestamp AT TIME ZONE 'UTC') AND EXISTS(SELECT 1 FROM fresh.scope_event_results active
       WHERE active.scope_id=pending_scope.id AND active.token_address=pending.token_address
        AND active.occurred_at>=($1::date::timestamp AT TIME ZONE 'UTC') AND active.occurred_at<(($1::date+1)::timestamp AT TIME ZONE 'UTC')))))`;
}

/** A receipt inside the rolling window may contain an unrecorded realization.
 * Earlier receipts matter only when opaque or touching a token used in this
 * window: its purchase cost may predate the displayed profit period. */
export function freshRollingLeaderboardPendingSql() {
  return `(EXISTS(SELECT 1 FROM fresh.recent_evidence e
    LEFT JOIN fresh.recent_blocks h ON h.block_number=e.block_number AND h.block_hash=e.block_hash
    WHERE e.wallet_addresses@>ARRAY[w.address]::text[] AND e.decoder_status<>'done' AND (
      h.block_number IS NULL OR h.occurred_at > $1::timestamptz AND h.occurred_at <= $2::timestamptz
      OR h.occurred_at <= $1::timestamptz AND (
        ${freshPositionReceiptOpaqueSql('e')}
        OR EXISTS(SELECT 1 FROM fresh.scope_event_results active
          WHERE active.scope_id='kol:'||w.address AND active.occurred_at > $1::timestamptz AND active.occurred_at <= $2::timestamptz
          AND ${freshPositionReceiptRawRelevantSql('e','active.token_address')})
      )
    )) OR EXISTS(SELECT 1 FROM fresh.accounting_scopes pending_scope JOIN fresh.pending_trades pending ON pending.wallet_address=w.address
     WHERE pending_scope.id='kol:'||w.address AND ${freshPendingTradeInScopeSql('pending','pending_scope')} AND(
      pending.occurred_at>$1::timestamptz AND pending.occurred_at<=$2::timestamptz
      OR pending.occurred_at<=$1::timestamptz AND EXISTS(SELECT 1 FROM fresh.scope_event_results active
       WHERE active.scope_id=pending_scope.id AND active.token_address=pending.token_address
        AND active.occurred_at>$1::timestamptz AND active.occurred_at<=$2::timestamptz))))`;
}

/** Current rows remain valid between events and scheduled expirations. A read
 * never refreshes an aggregate or substitutes a known partial subtotal. */
export function freshStoredKolRollingMetrics(row:Row, at:number) {
  const initialized=row.rolling_as_of!=null&&Number.isFinite(new Date(row.rolling_as_of).getTime());
  const next=row.rolling_next_expiry_at==null?null:new Date(row.rolling_next_expiry_at).getTime();
  const stale=!initialized||new Date(row.rolling_as_of).getTime()>at||next!==null&&(!Number.isFinite(next)||next<=at);
  const reasons=[
    ...(stale?['rolling_totals_pending']:[]),
    ...(Number(row.rolling_unknown_count??0)?['unknown_costs']:[]),
    ...(row.decode_gap_from_block!=null?['wallet_decode_gap']:[]),
    ...(row.decoding_pending?['decoding_pending']:[]),
    ...(row.token_discovery_pending?['token_discovery_pending']:[]),
    ...(initialized&&row.rolling_realized_q==null?['stored_total_unavailable']:[]),
  ];
  const complete=reasons.length===0;
  return {complete,reasons,current:initialized,realizedProfitUsd:complete?freshDecimal(row.rolling_realized_q):null,
    knownRealizedProfitUsd:initialized?freshDecimal(row.rolling_known_realized_q??'0')!:'0',
    tradeCount:initialized?Number(row.rolling_trade_count??0):0,
    valuedSellCount:Number(row.rolling_valued_sell_count??0),excludedSellCount:Number(row.rolling_unknown_sell_count??0),
    valuedTransferCount:Number(row.rolling_valued_transfer_count??0),excludedTransferCount:Number(row.rolling_unknown_transfer_count??0),
    valuedFeeCount:Number(row.rolling_valued_fee_count??0),excludedFeeCount:Number(row.rolling_unknown_fee_count??0),
    updatedAt:row.rolling_metrics_updated_at==null?null:new Date(row.rolling_metrics_updated_at).toISOString()};
}

/** Project the incrementally maintained KOL row. Never replay events on a page read. */
export function freshStoredKolDailyMetrics(row: Row, day: string) {
  const current = row.utc_date === day;
  const unknownCount = current ? Number(row.today_unknown_count ?? 0) : 0;
  const reasons = [
    ...(unknownCount ? ['unknown_costs'] : []),
    ...(row.decode_gap_from_block != null ? ['wallet_decode_gap'] : []),
    ...(row.decoding_pending ? ['decoding_pending'] : []),
    ...(row.token_discovery_pending ? ['token_discovery_pending'] : []),
    ...(current && row.today_realized_q == null ? ['stored_total_unavailable'] : []),
  ];
  const complete = reasons.length === 0;
  return {
    complete, reasons, current,
    realizedProfitUsd: complete ? current ? freshDecimal(row.today_realized_q) : '0' : null,
    knownRealizedProfitUsd: current ? freshDecimal(row.today_known_realized_q ?? '0')! : '0',
    tradeCount: current ? Number(row.today_trade_count ?? 0) : 0,
    valuedSellCount: current ? Number(row.today_valued_sell_count ?? 0) : 0,
    excludedSellCount: current ? Number(row.today_unknown_sell_count ?? 0) : 0,
    valuedTransferCount: current ? Number(row.today_valued_transfer_count ?? 0) : 0,
    excludedTransferCount: current ? Number(row.today_unknown_transfer_count ?? 0) : 0,
    valuedFeeCount: current ? Number(row.today_valued_fee_count ?? 0) : 0,
    excludedFeeCount: current ? Number(row.today_unknown_fee_count ?? 0) : 0,
    updatedAt: row.metrics_updated_at == null ? null : new Date(row.metrics_updated_at).toISOString(),
  };
}

type Rankable = {
  address: string; tradeCount24h: number; realizedProfitUsd: string | null;
  accounting: { complete: boolean; valuedSellCount: number; valuedTransferOutCount: number; valuedFeeCount?: number };
};

export function freshCompleteLeaderboardValue(item: Rankable) {
  const hasActivity = item.tradeCount24h > 0
    || item.accounting.valuedSellCount + item.accounting.valuedTransferOutCount + (item.accounting.valuedFeeCount ?? 0) > 0;
  return item.accounting.complete && hasActivity ? item.realizedProfitUsd : null;
}

/** Unknown/partial totals are retained as unranked rows; they never outrank a known loss. */
export function rankFreshStoredLeaderboard<T extends Rankable>(items: T[]): (T & { rank: number | null })[] {
  const sorted = [...items].sort((a, b) => {
    const av = freshCompleteLeaderboardValue(a), bv = freshCompleteLeaderboardValue(b);
    if (av === null) return bv === null ? b.tradeCount24h - a.tradeCount24h || a.address.localeCompare(b.address) : 1;
    if (bv === null) return -1;
    return -FreshRational.parse(av).compare(FreshRational.parse(bv))
      || b.tradeCount24h - a.tradeCount24h || a.address.localeCompare(b.address);
  });
  let rank = 0;
  return sorted.map(item => ({ ...item, rank: freshCompleteLeaderboardValue(item) === null ? null : ++rank }));
}
