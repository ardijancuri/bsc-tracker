import { FreshRational } from './accounting.js';

export const FRESH_TRIAL_TARGET_SECONDS = 8 * 60 * 60;
export const FRESH_TRIAL_POLICY = 'traded_positions_v1';
export const FRESH_FORWARD_TRIAL_POLICY = 'forward_activity_v1';
export const FRESH_TRIAL_REPORT_VERSION = 4;
/** A separate validation window. It never replaces the financial boundary. */
export interface FreshForwardTrialScope {
  version: 1; policy: typeof FRESH_FORWARD_TRIAL_POLICY;
  blockNumber: number; blockHash: string; occurredAt: string; activatedAt: string; captureRevision: string;
}
export type FreshTrialForwardScope = FreshForwardTrialScope;
export function freshTrialAcceptance(verifiedSeconds: number, representative: boolean, problems: readonly string[]) {
  const durationComplete = Number.isFinite(verifiedSeconds) && verifiedSeconds >= FRESH_TRIAL_TARGET_SECONDS;
  return { durationComplete, complete: durationComplete && representative && problems.length === 0 };
}

type Checkpoint = { block_number?: string | number | null; value?: Record<string, any>; updated_at?: string | Date };
export interface FreshTrialPosition {
  quantity_q: string; unknown_cost: boolean; has_trades: boolean; balance_status: string; balance_quantity: string | null;
  unknown_fee?: boolean | null; unknown_purchase_value?: boolean | null; unknown_sale_value?: boolean | null;
  unknown_incoming_value?: boolean | null; unknown_outgoing_value?: boolean | null; application_ready?: boolean | null;
  balance_block: string | number | null; balance_hash: string | null; balance_canonical: boolean;
  last_event_block: string | number | null; last_event_canonical: boolean | null;
  price_usd: string | null; valuation_status: string; observed_at: string | Date | null;
  observed_block: string | number | null; observed_hash: string | null; quote_canonical: boolean;
}
export interface FreshTrialValidationInput {
  now: number; confirmedHeadBlock: number; sourceDigest: string; currentSourceDigest: string;
  runtimeSourceDigest?: string;
  forwardScope?: { scope: FreshForwardTrialScope; boundaryCanonical: boolean };
  checkpoints: Record<string, Checkpoint | undefined>;
  counts: Record<string, string | number | null>;
  positions: FreshTrialPosition[];
}
const hash = (value: unknown) => typeof value === 'string' && /^0x[\da-f]{64}$/.test(value);
const number = (value: unknown) => value == null ? NaN : Number(value);
const at = (value: string | Date | null | undefined) => value == null ? NaN : new Date(value).getTime();

/** A running loop is not proof of complete accounting. Accept only bounded
 * live decoding plus canonical current balances/quotes required by positions.
 * Unknown historical costs are reported without being changed into zero. */
export function validateFreshTrialEvidence(input: FreshTrialValidationInput) {
  const { checkpoints, counts, positions, now } = input, problems = new Set<string>();
  const capture = number(checkpoints.capture?.block_number), decoded = number(checkpoints.decode?.block_number);
  const forward = input.forwardScope, firstPending = number(counts.first_pending_block);
  // The old decoder checkpoint may still point at a retained historical repair.
  // Only the separately scoped pending work determines this window's lag.
  const decodeLag = forward ? counts.first_pending_block == null ? 0 : capture - firstPending + 1 : capture - decoded;
  const captureLag = input.confirmedHeadBlock - capture;
  if (forward) {
    const scope = forward.scope, occurred = at(scope?.occurredAt), activated = at(scope?.activatedAt);
    if (!scope || scope.version !== 1 || scope.policy !== FRESH_FORWARD_TRIAL_POLICY
      || !Number.isSafeInteger(scope.blockNumber) || scope.blockNumber < 0 || !hash(scope.blockHash)
      || typeof scope.occurredAt !== 'string' || typeof scope.activatedAt !== 'string'
      || !Number.isFinite(occurred) || !Number.isFinite(activated) || occurred > activated || activated > now + 5_000
      || typeof scope.captureRevision !== 'string' || !/^[1-9]\d{0,18}$/.test(scope.captureRevision)
      || BigInt(scope.captureRevision) > 9_223_372_036_854_775_807n) problems.add('forward_scope_invalid');
    if (forward.boundaryCanonical !== true) problems.add('forward_scope_noncanonical');
    if (!Number.isSafeInteger(capture) || !scope || capture < scope.blockNumber) problems.add('forward_scope_ahead');
    const requiredCounts = ['registration_jobs', 'durable_wallet_gaps', 'repair_evidence', 'outdated_evidence',
      'outdated_financial_events', 'pending_evidence', 'forward_projection_missing', 'forward_dependency_pending'];
    if (requiredCounts.some(key => !Number.isSafeInteger(number(counts[key])) || number(counts[key]) < 0)) problems.add('forward_counts_invalid');
    if (counts.first_pending_block != null && (!Number.isSafeInteger(firstPending) || !scope || firstPending <= scope.blockNumber || firstPending > capture)
      || number(counts.pending_evidence) > 0 && counts.first_pending_block == null) problems.add('forward_counts_invalid');
    if (number(counts.forward_projection_missing) > 0) problems.add('forward_projection_missing');
    if (number(counts.forward_dependency_pending) > 0) problems.add('forward_dependency_pending');
  }
  if (!Number.isSafeInteger(captureLag) || captureLag < 0 || captureLag > 128) problems.add('capture_lag');
  if (!Number.isSafeInteger(decodeLag) || decodeLag < 0 || decodeLag > 32) problems.add('decode_lag');
  if (input.currentSourceDigest !== input.sourceDigest) problems.add('trial_source_changed');
  for (const role of ['api', 'worker']) if (checkpoints[`runtime:${role}`]?.value?.sourceDigest !== (input.runtimeSourceDigest ?? input.sourceDigest)) problems.add(`stale_${role}_source`);
  for (const role of ['capture', 'decode', 'prices', 'balances', 'maintenance', 'registration']) {
    const saved = checkpoints[`health:${role}`], age = now - at(saved?.updated_at);
    if (saved?.value?.ok !== true || !Number.isFinite(age) || age < -5_000 || age > 90_000) problems.add(`${role}_unhealthy`);
  }
  if (number(counts.registration_jobs) > 0) problems.add('registration_pending');
  if (number(counts.durable_wallet_gaps) > 0) problems.add('durable_wallet_evidence_gap');
  if (number(counts.repair_evidence) > 0) problems.add('decode_repair_pending');
  if (number(counts.outdated_evidence) > 0 || number(counts.outdated_financial_events) > 0) problems.add('decoder_upgrade_pending');
  if (number(counts.pending_evidence) > 0) {
    const oldest = number(counts.oldest_pending_age_seconds), first = number(counts.first_pending_block);
    if (!Number.isFinite(oldest) || oldest < 0 || oldest > 30 || !Number.isSafeInteger(first) || capture - first > 32) problems.add('decode_backlog');
  }
  const state = { positions: positions.length, openPositions: 0, unknownCostPositions: 0,
    untradedPositions: 0, untradedUnknownCostPositions: 0, requiredQuotePositions: 0, balanceFailures: 0, quoteFailures: 0,
    accountingFailures: 0, applicationFailures: 0 };
  for (const position of positions) {
    if (position.unknown_cost) state.unknownCostPositions++;
    // Participation belongs to this accounting scope, never to a token's global counters.
    // An absent/invalid flag fails closed and still requires the quote.
    const untraded = position.has_trades === false;
    if (untraded) { state.untradedPositions++; if (position.unknown_cost) state.untradedUnknownCostPositions++; }
    if (forward) {
      if (position.has_trades !== true && position.has_trades !== false) problems.add('required_position_participation_unknown');
      if (!untraded) {
        if ([position.unknown_cost, position.unknown_fee, position.unknown_purchase_value, position.unknown_sale_value,
          position.unknown_incoming_value, position.unknown_outgoing_value].some(value => value !== false)) {
          problems.add('required_position_accounting_unknown'); state.accountingFailures++;
        }
        if (position.application_ready !== true) { problems.add('required_position_application_pending'); state.applicationFailures++; }
      }
    }
    if (position.balance_status !== 'matched' || position.balance_quantity == null || position.balance_block == null || !hash(position.balance_hash)) {
      problems.add(position.balance_status === 'mismatch' ? 'required_position_balance_mismatch' : 'required_position_balance_pending'); state.balanceFailures++;
    } else if (!position.balance_canonical || position.last_event_canonical !== true || !Number.isSafeInteger(number(position.last_event_block))
      || number(position.last_event_block) > number(position.balance_block) || number(position.balance_block) > capture) {
      problems.add('required_position_balance_noncanonical'); state.balanceFailures++;
    }
    let open: boolean;
    try {
      const quantity = FreshRational.fromStored(position.quantity_q);
      open = quantity.n > 0n;
      if (position.balance_status === 'matched' && position.balance_quantity != null
        && quantity.compare(FreshRational.fromStored(position.balance_quantity)) !== 0) {
        problems.add('required_position_balance_mismatch'); state.balanceFailures++;
      }
    }
    catch { problems.add('invalid_current_position_quantity'); continue; }
    if (!open) continue;
    state.openPositions++;
    // A distribution before any market can be decoded while its original cost stays
    // unknown. It cannot authorize P&L, but it does not need a chart/quote to validate
    // unrelated real trading. Balance, coverage and decoder checks still apply above.
    if (untraded) continue;
    state.requiredQuotePositions++;
    let quoted = false;
    try { quoted = position.price_usd !== null && FreshRational.fromStored(position.price_usd).n > 0n; } catch { /* Invalid is unavailable. */ }
    if (!quoted || position.valuation_status !== 'ready' || !hash(position.observed_hash) || !position.quote_canonical
      || !Number.isSafeInteger(number(position.observed_block)) || number(position.observed_block) > capture) {
      problems.add('required_position_quote_unavailable'); state.quoteFailures++;
    } else {
      const age = now - at(position.observed_at);
      if (!Number.isFinite(age) || age < -5_000 || age > 120_000) { problems.add('required_position_quote_stale'); state.quoteFailures++; }
    }
  }
  return { problems: [...problems], captureLagBlocks: captureLag, decodeLagBlocks: decodeLag, positionValidation: state };
}
