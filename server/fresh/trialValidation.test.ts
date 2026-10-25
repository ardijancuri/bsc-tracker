import { describe, expect, it } from 'vitest';
import { FRESH_TRIAL_TARGET_SECONDS, FRESH_TRIAL_POLICY, FRESH_FORWARD_TRIAL_POLICY, FRESH_TRIAL_REPORT_VERSION, freshTrialAcceptance, validateFreshTrialEvidence, type FreshTrialPosition, type FreshTrialValidationInput } from './trialValidation.js';
const now = Date.parse('2026-10-21T21:00:00Z'), hash = `0x${'a'.repeat(64)}`;
function position(): FreshTrialPosition { return { quantity_q: '10', unknown_cost: false, has_trades: true, balance_status: 'matched', balance_quantity: '10', balance_block: '100', balance_hash: hash,
  balance_canonical: true, last_event_block: '90', last_event_canonical: true, price_usd: '2', valuation_status: 'ready', observed_at: new Date(now - 10_000), observed_block: '100', observed_hash: hash, quote_canonical: true }; }
function input(): FreshTrialValidationInput {
  const checkpoints: FreshTrialValidationInput['checkpoints'] = { capture: { block_number: '100' }, decode: { block_number: '100' } };
  for (const role of ['api', 'worker']) checkpoints[`runtime:${role}`] = { value: { sourceDigest: 'frozen' } };
  for (const role of ['capture', 'decode', 'prices', 'balances', 'maintenance', 'registration']) checkpoints[`health:${role}`] = { value: { ok: true }, updated_at: new Date(now) };
  return { now, confirmedHeadBlock: 100, sourceDigest: 'frozen', currentSourceDigest: 'frozen', checkpoints, positions: [position()],
    counts: { registration_jobs: 0, durable_wallet_gaps: 0, repair_evidence: 0, outdated_evidence: 0, outdated_financial_events: 0, pending_evidence: 0, oldest_pending_age_seconds: null, first_pending_block: null } };
}
describe('representative live trial credit', () => {
  it('requires eight verified hours, representative live trades and no remaining failure', () => {
    expect(FRESH_TRIAL_TARGET_SECONDS).toBe(28_800);
    expect(FRESH_TRIAL_REPORT_VERSION).toBe(4); expect(FRESH_TRIAL_POLICY).toBe('traded_positions_v1');
    expect(freshTrialAcceptance(28_799, true, []).complete).toBe(false);
    expect(freshTrialAcceptance(28_800, true, [])).toEqual({durationComplete:true,complete:true});
    expect(freshTrialAcceptance(28_800, false, []).complete).toBe(false);
    expect(freshTrialAcceptance(28_800, true, ['decode_repair_pending']).complete).toBe(false);
    expect(freshTrialAcceptance(Number.NaN, true, []).complete).toBe(false);
  });
  it('requires current canonical position proofs in addition to healthy loops', () => {
    expect(validateFreshTrialEvidence(input()).problems).toEqual([]);
    const mismatch = input(); mismatch.positions[0].balance_status = 'mismatch';
    expect(validateFreshTrialEvidence(mismatch).problems).toContain('required_position_balance_mismatch');
    const orphan = input(); orphan.positions[0].balance_canonical = false;
    expect(validateFreshTrialEvidence(orphan).problems).toContain('required_position_balance_noncanonical');
    const contradictory = input(); contradictory.positions[0].balance_quantity = '9';
    expect(validateFreshTrialEvidence(contradictory).problems).toContain('required_position_balance_mismatch');
  });
  it('does not credit repair, durable gaps or an overdue decode backlog despite successful loop health', () => {
    const broken = input(); broken.counts.repair_evidence = 1; broken.counts.durable_wallet_gaps = 1; broken.counts.pending_evidence = 1; broken.counts.first_pending_block = 20; broken.counts.oldest_pending_age_seconds = 60;
    expect(validateFreshTrialEvidence(broken).problems).toEqual(expect.arrayContaining(['decode_repair_pending', 'durable_wallet_evidence_gap', 'decode_backlog']));
    const behind = input(); behind.checkpoints.decode!.block_number = 60;
    expect(validateFreshTrialEvidence(behind).problems).toContain('decode_lag');
  });
  it('allows only the bounded current decoding interval and requires decoder upgrades to finish', () => {
    const current = input(); current.counts.pending_evidence = 1; current.counts.first_pending_block = 95; current.counts.oldest_pending_age_seconds = 1; current.checkpoints.decode!.block_number = 95;
    expect(validateFreshTrialEvidence(current).problems).toEqual([]);
    current.counts.outdated_evidence = 1; expect(validateFreshTrialEvidence(current).problems).toContain('decoder_upgrade_pending');
    current.counts.outdated_evidence = 0; current.counts.outdated_financial_events = 1; expect(validateFreshTrialEvidence(current).problems).toContain('decoder_upgrade_pending');
  });
  it('requires a fresh quote only for open positions and never treats unknown costs as zero', () => {
    const stale = input(); stale.positions[0].observed_at = new Date(now - 121_000); expect(validateFreshTrialEvidence(stale).problems).toContain('required_position_quote_stale');
    stale.positions[0].quantity_q = '0'; stale.positions[0].balance_quantity = '0'; expect(validateFreshTrialEvidence(stale).problems).toEqual([]);
    const unknown = input(); unknown.positions[0].unknown_cost = true;
    const result = validateFreshTrialEvidence(unknown); expect(result.problems).toEqual([]); expect(result.positionValidation.unknownCostPositions).toBe(1); expect(unknown.positions[0].unknown_cost).toBe(true);
  });
  it('discloses untraded unknown-cost airdrops without requiring an invented quote or changing their cost', () => {
    const airdrop = input(), row = airdrop.positions[0]; row.has_trades = false; row.unknown_cost = true;
    row.price_usd = null; row.valuation_status = 'quote_unavailable'; row.observed_at = null; row.observed_block = null; row.observed_hash = null; row.quote_canonical = false;
    const result = validateFreshTrialEvidence(airdrop);
    expect(result.problems).toEqual([]);
    expect(result.positionValidation).toMatchObject({ unknownCostPositions: 1, untradedPositions: 1, untradedUnknownCostPositions: 1, requiredQuotePositions: 0 });
    expect(row.unknown_cost).toBe(true); expect(row.price_usd).toBeNull();
    row.has_trades = true;
    expect(validateFreshTrialEvidence(airdrop).problems).toContain('required_position_quote_unavailable');
    expect(validateFreshTrialEvidence(airdrop).positionValidation.requiredQuotePositions).toBe(1);
  });
  it('keeps untraded balances, quantities, coverage and genuine decoder failures strict', () => {
    for (const status of ['pending', 'mismatch']) {
      const data = input(); data.positions[0].has_trades = false; data.positions[0].balance_status = status;
      expect(validateFreshTrialEvidence(data).problems).toContain(status === 'mismatch' ? 'required_position_balance_mismatch' : 'required_position_balance_pending');
    }
    const orphan = input(); orphan.positions[0].has_trades = false; orphan.positions[0].balance_canonical = false;
    expect(validateFreshTrialEvidence(orphan).problems).toContain('required_position_balance_noncanonical');
    const contradictory = input(); contradictory.positions[0].has_trades = false; contradictory.positions[0].balance_quantity = '9';
    expect(validateFreshTrialEvidence(contradictory).problems).toContain('required_position_balance_mismatch');
    const invalid = input(); invalid.positions[0].has_trades = false; invalid.positions[0].quantity_q = 'bad';
    expect(validateFreshTrialEvidence(invalid).problems).toContain('invalid_current_position_quantity');
    const repair = input(); repair.positions[0].has_trades = false; repair.counts.repair_evidence = 1; repair.counts.durable_wallet_gaps = 1;
    expect(validateFreshTrialEvidence(repair).problems).toEqual(expect.arrayContaining(['decode_repair_pending', 'durable_wallet_evidence_gap']));
  });
  it('fails closed on an absent trade-participation flag and keeps unknown traded costs visible', () => {
    const data = input(); data.positions[0].has_trades = undefined as unknown as boolean; data.positions[0].price_usd = null;
    expect(validateFreshTrialEvidence(data).problems).toContain('required_position_quote_unavailable');
    data.positions[0] = position(); data.positions[0].unknown_cost = true;
    expect(validateFreshTrialEvidence(data).positionValidation).toMatchObject({ unknownCostPositions: 1, untradedUnknownCostPositions: 0, requiredQuotePositions: 1 });
  });
  it('rejects missing/stale/noncanonical valuation and source changes', () => {
    const missing = input(); missing.positions[0].price_usd = null; missing.positions[0].valuation_status = 'quote_unavailable'; expect(validateFreshTrialEvidence(missing).problems).toContain('required_position_quote_unavailable');
    const changed = input(); changed.currentSourceDigest = 'edited'; expect(validateFreshTrialEvidence(changed).problems).toContain('trial_source_changed');
    const unhealthy = input(); unhealthy.checkpoints['health:decode']!.updated_at = new Date(now - 91_000); expect(validateFreshTrialEvidence(unhealthy).problems).toContain('decode_unhealthy');
  });
});

function forwardInput(): FreshTrialValidationInput {
  const data = input();
  data.forwardScope = { scope: { version: 1, policy: FRESH_FORWARD_TRIAL_POLICY, blockNumber: 80, blockHash: hash,
    occurredAt: new Date(now - 60_000).toISOString(), activatedAt: new Date(now - 50_000).toISOString(), captureRevision: '1' }, boundaryCanonical: true };
  data.counts.forward_projection_missing = 0; data.counts.forward_dependency_pending = 0;
  Object.assign(data.positions[0], { unknown_fee: false, unknown_purchase_value: false, unknown_sale_value: false,
    unknown_incoming_value: false, unknown_outgoing_value: false, application_ready: true });
  return data;
}

describe('forward activity window with unchanged per-position evidence rules', () => {
  it('keeps report/evidence policy and the eight-hour target unchanged', () => {
    expect(FRESH_TRIAL_REPORT_VERSION).toBe(4); expect(FRESH_TRIAL_POLICY).toBe('traded_positions_v1');
    expect(FRESH_FORWARD_TRIAL_POLICY).toBe('forward_activity_v1'); expect(FRESH_TRIAL_TARGET_SECONDS).toBe(28_800);
    expect(validateFreshTrialEvidence(forwardInput()).problems).toEqual([]);
  });
  it('requires a genuine canonical validation boundary without altering the financial boundary', () => {
    const data = forwardInput(); data.forwardScope!.boundaryCanonical = false;
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_scope_noncanonical');
    data.forwardScope!.boundaryCanonical = true; data.checkpoints.capture!.block_number = 79; data.confirmedHeadBlock = 79;
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_scope_ahead');
    expect(data.forwardScope!.scope.blockNumber).toBe(80);
  });
  it.each([
    ['version', 2], ['policy', 'all_history'], ['blockNumber', -1], ['blockNumber', 80.5], ['blockHash', '0xbad'],
    ['occurredAt', 'not-a-date'], ['activatedAt', 'not-a-date'], ['captureRevision', '0'], ['captureRevision', '-1'],
    ['captureRevision', '1.5'], ['captureRevision', '9223372036854775808'], ['captureRevision', 1],
  ])('rejects an invalid scope %s=%s', (field, value) => {
    const data = forwardInput(); (data.forwardScope!.scope as unknown as Record<string, unknown>)[field] = value;
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_scope_invalid');
  });
  it('rejects future activation and reversed observation/activation times', () => {
    const data = forwardInput(); data.forwardScope!.scope.activatedAt = new Date(now + 6_000).toISOString();
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_scope_invalid');
    data.forwardScope!.scope.activatedAt = new Date(now - 70_000).toISOString();
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_scope_invalid');
  });
  it('ignores the old global decode checkpoint and separate historical diagnostic counters', () => {
    const data = forwardInput(); data.checkpoints.decode!.block_number = 0;
    data.counts.historical_repair_evidence = 300; data.counts.historical_outdated_evidence = 10;
    const result = validateFreshTrialEvidence(data);
    expect(result.decodeLagBlocks).toBe(0); expect(result.problems).toEqual([]);
    expect(validateFreshTrialEvidence({ ...data, forwardScope: undefined }).problems).toContain('decode_lag');
  });
  it('uses the first scoped pending block minus one and keeps the 32-block lag limit', () => {
    const data = forwardInput(); data.counts.pending_evidence = 1; data.counts.oldest_pending_age_seconds = 1;
    data.counts.first_pending_block = 95; data.checkpoints.decode!.block_number = 0;
    expect(validateFreshTrialEvidence(data)).toMatchObject({ decodeLagBlocks: 6, problems: [] });
    data.checkpoints.capture!.block_number = 120; data.confirmedHeadBlock = 120; data.counts.first_pending_block = 88;
    expect(validateFreshTrialEvidence(data).decodeLagBlocks).toBe(33);
    expect(validateFreshTrialEvidence(data).problems).toContain('decode_lag');
  });
  it.each([null, 80, 101, 95.5])('rejects missing/outside-window pending coordinates %s', first => {
    const data = forwardInput(); data.counts.pending_evidence = 1; data.counts.oldest_pending_age_seconds = 1; data.counts.first_pending_block = first;
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_counts_invalid');
  });
  it.each(['registration_jobs', 'durable_wallet_gaps', 'repair_evidence', 'outdated_evidence', 'outdated_financial_events',
    'pending_evidence', 'forward_projection_missing', 'forward_dependency_pending'])('requires complete nonnegative scoped count %s', key => {
    const data = forwardInput(); delete data.counts[key];
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_counts_invalid');
    data.counts[key] = -1; expect(validateFreshTrialEvidence(data).problems).toContain('forward_counts_invalid');
    data.counts[key] = 0.5; expect(validateFreshTrialEvidence(data).problems).toContain('forward_counts_invalid');
  });
  it('blocks missing projections and older dependencies of a newly affected scope', () => {
    const data = forwardInput(); data.counts.forward_projection_missing = 1; data.counts.forward_dependency_pending = 1;
    expect(validateFreshTrialEvidence(data).problems).toEqual(expect.arrayContaining(['forward_projection_missing', 'forward_dependency_pending']));
  });
  it('retains all scoped repair, registration, coverage and outdated decoder gates', () => {
    const data = forwardInput(); data.counts.repair_evidence = 1; data.counts.registration_jobs = 1;
    data.counts.durable_wallet_gaps = 1; data.counts.outdated_evidence = 1;
    expect(validateFreshTrialEvidence(data).problems).toEqual(expect.arrayContaining([
      'decode_repair_pending', 'registration_pending', 'durable_wallet_evidence_gap', 'decoder_upgrade_pending',
    ]));
  });
  it('can bind the untouched application build while requiring the current monitor build', () => {
    const data = forwardInput(); data.runtimeSourceDigest = 'financial-runtime';
    for (const role of ['api', 'worker']) data.checkpoints[`runtime:${role}`]!.value!.sourceDigest = 'financial-runtime';
    expect(validateFreshTrialEvidence(data).problems).toEqual([]);
    data.currentSourceDigest = 'unreviewed-monitor';
    expect(validateFreshTrialEvidence(data).problems).toContain('trial_source_changed');
    data.currentSourceDigest = data.sourceDigest; data.checkpoints['runtime:worker']!.value!.sourceDigest = 'unexpected-runtime';
    expect(validateFreshTrialEvidence(data).problems).toContain('stale_worker_source');
    data.runtimeSourceDigest = undefined;
    expect(validateFreshTrialEvidence(data).problems).toContain('stale_api_source');
  });
  it.each(['unknown_cost', 'unknown_fee', 'unknown_purchase_value', 'unknown_sale_value', 'unknown_incoming_value', 'unknown_outgoing_value'] as const)(
    'rejects new trading with unknown or missing %s even after closure', field => {
      const data = forwardInput(); data.positions[0].quantity_q = '0'; data.positions[0].balance_quantity = '0';
      data.positions[0][field] = true;
      expect(validateFreshTrialEvidence(data).problems).toContain('required_position_accounting_unknown');
      data.positions[0][field] = undefined as unknown as boolean;
      expect(validateFreshTrialEvidence(data).problems).toContain('required_position_accounting_unknown');
    });
  it('requires real application readiness and scope participation rather than just canonical balances', () => {
    const data = forwardInput(); data.positions[0].application_ready = false;
    expect(validateFreshTrialEvidence(data).problems).toContain('required_position_application_pending');
    delete data.positions[0].application_ready;
    expect(validateFreshTrialEvidence(data).problems).toContain('required_position_application_pending');
    data.positions[0].application_ready = true; data.positions[0].has_trades = undefined as unknown as boolean;
    expect(validateFreshTrialEvidence(data).problems).toContain('required_position_participation_unknown');
  });
  it('permits explicit untraded airdrop costs while retaining strict balance and new dependency gates', () => {
    const data = forwardInput(), p = data.positions[0]; p.has_trades = false; p.unknown_cost = true;
    p.price_usd = null; p.valuation_status = 'quote_unavailable'; p.quote_canonical = false; p.application_ready = false;
    const result = validateFreshTrialEvidence(data);
    expect(result.problems).toEqual([]); expect(result.positionValidation.untradedUnknownCostPositions).toBe(1);
    expect(p.unknown_cost).toBe(true); expect(p.price_usd).toBeNull();
    p.balance_status = 'pending'; expect(validateFreshTrialEvidence(data).problems).toContain('required_position_balance_pending');
    p.balance_status = 'matched'; data.counts.forward_dependency_pending = 1;
    expect(validateFreshTrialEvidence(data).problems).toContain('forward_dependency_pending');
  });
  it('requires a fresh canonical current quote for every own-scope open traded position', () => {
    const data = forwardInput(), p = data.positions[0]; p.observed_at = new Date(now - 120_001);
    expect(validateFreshTrialEvidence(data).problems).toContain('required_position_quote_stale');
    p.observed_at = new Date(now - 1_000); p.quote_canonical = false;
    expect(validateFreshTrialEvidence(data).problems).toContain('required_position_quote_unavailable');
    p.quote_canonical = true; p.price_usd = null;
    expect(validateFreshTrialEvidence(data).problems).toContain('required_position_quote_unavailable');
  });
  it('never treats stale loop health or elapsed wall time as healthy forward evidence', () => {
    const data = forwardInput(); data.checkpoints['health:capture']!.updated_at = new Date(now - 91_000);
    const result = validateFreshTrialEvidence(data);
    expect(result.problems).toContain('capture_unhealthy');
    expect(freshTrialAcceptance(28_800, true, result.problems).complete).toBe(false);
    expect(freshTrialAcceptance(4160.051, true, []).complete).toBe(false);
  });
});
