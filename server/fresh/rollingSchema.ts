/** Additive current-row projection only. No financial fact or response copy is added. */
export const freshRollingSchemaSql = `
  ALTER TABLE fresh.kols ADD COLUMN IF NOT EXISTS rolling_as_of timestamptz,
    ADD COLUMN IF NOT EXISTS rolling_next_expiry_at timestamptz,
    ADD COLUMN IF NOT EXISTS rolling_metrics_updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS rolling_realized_q text DEFAULT '0',
    ADD COLUMN IF NOT EXISTS rolling_known_realized_q text NOT NULL DEFAULT '0',
    ADD COLUMN IF NOT EXISTS rolling_capital_q text NOT NULL DEFAULT '0',
    ADD COLUMN IF NOT EXISTS rolling_volume_q text NOT NULL DEFAULT '0',
    ADD COLUMN IF NOT EXISTS rolling_trade_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_token_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_unknown_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_buy_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_sell_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_valued_sell_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_unknown_sell_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_valued_transfer_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_unknown_transfer_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_valued_fee_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_unknown_fee_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_fee_only_q text NOT NULL DEFAULT '0',
    ADD COLUMN IF NOT EXISTS rolling_unallocated_fee_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_unallocated_fee_q text NOT NULL DEFAULT '0',
    ADD COLUMN IF NOT EXISTS rolling_unallocated_fee_unknown_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rolling_unattributed_fee_count integer NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS kols_rolling_due_idx ON fresh.kols(rolling_next_expiry_at,wallet_address)
    WHERE rolling_next_expiry_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS kols_rolling_uninitialized_idx ON fresh.kols(wallet_address)
    WHERE rolling_as_of IS NULL;
  CREATE INDEX IF NOT EXISTS scope_event_results_token_time_idx
    ON fresh.scope_event_results(scope_id,token_address,occurred_at) WHERE tokens_trade;
`;
