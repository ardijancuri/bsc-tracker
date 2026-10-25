import { describe, expect, it } from 'vitest';
import { breakFreshTrialSampleContinuity, createFreshTrialProgress, freshTrialProgressSummary, importReviewedFreshTrialCredit,
  recordFreshTrialSample, reviewFreshTrialSegment, revokeFreshTrialCredit, type FreshTrialProgress, type FreshTrialReview } from './trialProgress.js';

const start = Date.parse('2026-10-23T00:00:00Z');
function review(id = 'initial', overrides: Partial<FreshTrialReview> = {}): FreshTrialReview {
  return { id, reviewedAt: start, reason: 'Reviewed trial clock policy; economic evidence gates unchanged', evidence: ['source.patch#sha256:abc'],
    changedDomains: ['trial_monitor'], checks: [{ domain: 'trial_monitor', status: 'passed', evidence: ['trialProgress.test.ts#passed'] }], ...overrides };
}
function build(state = createFreshTrialProgress({ campaignId: 'fresh-eight-hour', startedAt: start }), id = 'build-a', offset = 0) {
  return reviewFreshTrialSegment(state, { id, sourceDigest: (id === 'build-a' ? 'a' : 'b').repeat(64), startedAt: start + offset,
    review: review(`${id}-review`, { reviewedAt: start + offset }) });
}
function sample(state: FreshTrialProgress, offset: number, overrides: Partial<Parameters<typeof recordFreshTrialSample>[1]> = {}) {
  return recordFreshTrialSample(state, { segmentId: 'build-a', at: start + offset, healthy: true, collectionHealthy: true,
    representative: true, ...overrides });
}
function summary(state: FreshTrialProgress, offset: number, id = 'build-a', currentProblems: string[] = []) {
  return freshTrialProgressSummary(state, { currentSegmentId: id, now: start + offset, currentProblems });
}
function importCredit(state: FreshTrialProgress, intervals: [number, number][], overrides: Partial<Parameters<typeof importReviewedFreshTrialCredit>[1]> = {}) {
  return importReviewedFreshTrialCredit(state, { segmentId: 'build-a', intervals: intervals.map(([a, b]) => [start + a, start + b]),
    representativeAt: start + intervals[0][1], review: { id: 'legacy-log-audit', reviewedAt: start + 30_000_000,
      reason: 'Audited successful adjacent observations; no legacy counter adoption', evidence: ['old/observations.jsonl#sha256:123', 'targeted-checks.json#sha256:456'] }, ...overrides });
}

describe('reviewed segmented healthy trial progress', () => {
  it('preserves strict evidence policy and requires explicit version-four campaign creation', () => {
    const state = build();
    expect(state).toMatchObject({ version: 4, validationPolicy: 'traded_positions_v1', progressPolicy: 'segmented_v1', targetSeconds: 28_800 });
    expect(() => summary({ ...state, version: 3 } as unknown as FreshTrialProgress, 0)).toThrow('policy');
    expect(() => recordFreshTrialSample(createFreshTrialProgress({ campaignId: 'empty', startedAt: start }),
      { segmentId: 'unknown', at: start, healthy: true, collectionHealthy: true, representative: true })).toThrow('Unreviewed');
  });

  it('credits only adjacent healthy observations and leaves its input immutable', () => {
    const initial = build(), once = sample(initial, 0), twice = sample(once, 60_000);
    expect(summary(twice, 60_000)).toMatchObject({ verifiedSeconds: 60, collectionSeconds: 60, representative: true, complete: false });
    expect(initial.segments[0].intervals).toEqual([]);
    expect(once.segments[0].intervals).toEqual([]);
    expect(JSON.parse(JSON.stringify(twice))).toEqual(twice);
  });

  it('pauses on a failure, counts later healthy time and never erases prior intervals', () => {
    let state = sample(sample(build(), 0), 60_000);
    state = sample(state, 120_000, { healthy: false, problems: ['required_position_balance_mismatch'] });
    state = sample(state, 180_000);
    state = sample(state, 240_000);
    expect(summary(state, 240_000)).toMatchObject({ verifiedSeconds: 120, collectionSeconds: 240 });
    expect(state.segments[0].intervals).toEqual([[start, start + 60_000], [start + 180_000, start + 240_000]]);
  });

  it('does not trust healthy=true when explicit problems exist', () => {
    const state = sample(sample(build(), 0), 60_000, { problems: ['trial_source_changed'] });
    expect(summary(state, 60_000)).toMatchObject({ verifiedSeconds: 0, complete: false });
    expect(state.segments[0].lastSample?.healthy).toBe(false);
  });

  it('gives sleep and long sampling gaps zero credit', () => {
    let state = sample(sample(build(), 0), 91_000);
    expect(summary(state, 91_000).verifiedSeconds).toBe(0);
    state = sample(state, 151_000);
    expect(summary(state, 151_000).verifiedSeconds).toBe(60);
  });

  it('breaks observation continuity on monitor process restart while preserving credit', () => {
    let state = sample(sample(build(), 0), 60_000);
    state = breakFreshTrialSampleContinuity(state, 'build-a');
    state = sample(state, 120_000);
    expect(summary(state, 120_000).verifiedSeconds).toBe(60);
    state = sample(state, 180_000);
    expect(summary(state, 180_000).verifiedSeconds).toBe(120);
  });

  it('makes duplicate sample timestamps harmless and rejects clock reversal', () => {
    const state = sample(sample(build(), 0), 60_000);
    expect(sample(state, 60_000)).toEqual(state);
    expect(() => sample(state, 30_000)).toThrow('backwards');
    expect(() => sample(state, Number.NaN)).toThrow('Invalid');
  });

  it('credits a reviewed later build without resetting old healthy time or representative activity', () => {
    let state = sample(sample(build(), 0), 60_000);
    state = build(state, 'build-b', 120_000);
    state = sample(state, 120_000, { segmentId: 'build-b', representative: false });
    state = sample(state, 180_000, { segmentId: 'build-b', representative: false });
    expect(summary(state, 180_000, 'build-b')).toMatchObject({ verifiedSeconds: 120, representative: true });
    expect(state.segments).toHaveLength(2);
  });

  it('does not permit one segment identity to hide another source or boundary', () => {
    const state = build();
    expect(() => reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'b'.repeat(64), startedAt: start, review: review() })).toThrow('immutable');
    expect(() => reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start + 1, review: review('new', { reviewedAt: start + 1 }) })).toThrow('immutable');
  });

  it('requires explicit reviewed regression evidence, with no silent affected-domain waiver', () => {
    expect(() => reviewFreshTrialSegment(build(), { id: 'build-b', sourceDigest: 'b'.repeat(64), startedAt: start,
      review: review('bad', { evidence: [] }) })).toThrow('evidence');
    expect(() => reviewFreshTrialSegment(build(), { id: 'build-b', sourceDigest: 'b'.repeat(64), startedAt: start,
      review: review('bad', { checks: [{ domain: 'trial_monitor', status: 'passed', evidence: [] }] }) })).toThrow('evidence');
    let state = reviewFreshTrialSegment(build(), { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('accounting-pending', { changedDomains: ['accounting'], checks: [] }) });
    state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('only-monitor') });
    expect(summary(state, 0).regressionProblems).toContain('build-a:accounting:pending');
  });

  it('does not accumulate healthy time until targeted affected-domain checks pass', () => {
    let state = reviewFreshTrialSegment(build(), { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('pending', { changedDomains: ['decoding'], checks: [{ domain: 'decoding', status: 'pending', evidence: [] }] }) });
    state = sample(sample(state, 0), 60_000);
    expect(summary(state, 60_000).verifiedSeconds).toBe(0);
    state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('passed', { reviewedAt: start + 60_000, changedDomains: ['decoding'],
        checks: [{ domain: 'decoding', status: 'passed', evidence: ['classification.test.ts#passed'] }] }) });
    state = sample(sample(state, 120_000), 180_000);
    expect(summary(state, 180_000)).toMatchObject({ verifiedSeconds: 60, regressionProblems: [] });
  });

  it('breaks continuity when a new review is appended even if a failed gate clears between samples', () => {
    for (const status of ['pending', 'failed'] as const) {
      let state = sample(sample(build(), 0), 60_000);
      const failed = review('brief-failure', { reviewedAt: start + 70_000, changedDomains: ['accounting'],
        checks: [{ domain: 'accounting', status, evidence: [`targeted-check#${status}`] }] });
      state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start, review: failed });
      expect(state.segments[0].lastSample).toBeNull();
      state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
        review: review('brief-fixed', { reviewedAt: start + 80_000, changedDomains: ['accounting'],
          checks: [{ domain: 'accounting', status: 'passed', evidence: ['targeted-check#passed'] }] }) });
      state = sample(state, 120_000);
      expect(summary(state, 120_000).verifiedSeconds).toBe(60);
      state = sample(state, 180_000);
      expect(summary(state, 180_000).verifiedSeconds).toBe(120);
    }
  });

  it('does not break observation continuity for an identical already-recorded review', () => {
    let state = sample(sample(build(), 0), 60_000);
    state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('build-a-review') });
    state = sample(state, 120_000);
    expect(summary(state, 120_000).verifiedSeconds).toBe(120);
  });

  it('retains old credit but blocks completion when a later regression review fails', () => {
    let state = importCredit(build(), [[0, 28_800_000]]);
    state = sample(state, 28_800_000);
    expect(summary(state, 28_800_000).complete).toBe(true);
    state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('failed', { reviewedAt: start + 28_800_000, changedDomains: ['replay'],
        checks: [{ domain: 'replay', status: 'failed', evidence: ['replay-check.json#failed'] }] }) });
    expect(summary(state, 28_800_000)).toMatchObject({ verifiedSeconds: 28_800, complete: false,
      regressionProblems: ['build-a:replay:failed'] });
  });

  it('carries pending and failed domains from a zero-credit build until a later targeted pass', () => {
    for (const status of ['pending', 'failed'] as const) {
      let state = reviewFreshTrialSegment(build(), { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
        review: review('accounting-blocked', { changedDomains: ['accounting'],
          checks: [{ domain: 'accounting', status, evidence: [`accounting-check#${status}`] }] }) });
      state = build(state, 'build-b', 120_000);
      state = sample(sample(state, 120_000, { segmentId: 'build-b' }), 180_000, { segmentId: 'build-b' });
      expect(summary(state, 180_000, 'build-b')).toMatchObject({ verifiedSeconds: 0,
        regressionProblems: [`build-a:accounting:${status}`] });
      state = reviewFreshTrialSegment(state, { id: 'build-b', sourceDigest: 'b'.repeat(64), startedAt: start + 120_000,
        review: review('accounting-passed', { reviewedAt: start + 200_000, changedDomains: ['accounting'],
          checks: [{ domain: 'accounting', status: 'passed', evidence: ['accounting-check#passed-on-build-b'] }] }) });
      state = sample(sample(state, 240_000, { segmentId: 'build-b' }), 300_000, { segmentId: 'build-b' });
      expect(summary(state, 300_000, 'build-b')).toMatchObject({ verifiedSeconds: 60, regressionProblems: [] });
      expect(state.segments[1].reviews.at(-1)?.changedDomains).toEqual(['accounting']);
    }
  });

  it('lets a reviewed current-build pass resolve a credited historical regression without erasing time', () => {
    let state = importCredit(build(), [[0, 60_000]]);
    state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('old-replay-pending', { reviewedAt: start + 70_000, changedDomains: ['replay'], checks: [] }) });
    state = build(state, 'build-b', 120_000);
    expect(summary(state, 120_000, 'build-b').regressionProblems).toEqual(['build-a:replay:pending']);
    state = reviewFreshTrialSegment(state, { id: 'build-b', sourceDigest: 'b'.repeat(64), startedAt: start + 120_000,
      review: review('replay-passed-current', { reviewedAt: start + 180_000, changedDomains: ['replay'],
        checks: [{ domain: 'replay', status: 'passed', evidence: ['actual-current-mp4-inspection.json'] }] }) });
    state = sample(sample(state, 240_000, { segmentId: 'build-b', representative: false }), 300_000, { segmentId: 'build-b', representative: false });
    expect(summary(state, 300_000, 'build-b')).toMatchObject({ verifiedSeconds: 120, representative: true, regressionProblems: [] });
    expect(state.segments[0].intervals).toEqual([[start, start + 60_000]]);
    expect(summary(state, 300_000, 'build-b').segments[0].regressionProblems).toEqual(['build-a:replay:pending']);
  });

  it('does not let a later review of an older build clear a newer build regression', () => {
    let state = build(build(), 'build-b', 120_000);
    state = reviewFreshTrialSegment(state, { id: 'build-b', sourceDigest: 'b'.repeat(64), startedAt: start + 120_000,
      review: review('new-accounting-failed', { reviewedAt: start + 180_000, changedDomains: ['accounting'],
        checks: [{ domain: 'accounting', status: 'failed', evidence: ['new-build-check#failed'] }] }) });
    state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('old-accounting-passed', { reviewedAt: start + 240_000, changedDomains: ['accounting'],
        checks: [{ domain: 'accounting', status: 'passed', evidence: ['old-build-check#passed'] }] }) });
    expect(summary(state, 240_000, 'build-b').regressionProblems).toEqual(['build-b:accounting:failed']);
  });

  it('breaks the current build endpoint when a campaign review changes another build', () => {
    let state = build(build(), 'build-b', 120_000);
    state = sample(sample(state, 120_000, { segmentId: 'build-b' }), 180_000, { segmentId: 'build-b' });
    state = reviewFreshTrialSegment(state, { id: 'build-a', sourceDigest: 'a'.repeat(64), startedAt: start,
      review: review('old-gate', { reviewedAt: start + 190_000, changedDomains: ['accounting'], checks: [] }) });
    expect(state.segments[1].lastSample).toBeNull();
    state = reviewFreshTrialSegment(state, { id: 'build-b', sourceDigest: 'b'.repeat(64), startedAt: start + 120_000,
      review: review('new-pass', { reviewedAt: start + 200_000, changedDomains: ['accounting'],
        checks: [{ domain: 'accounting', status: 'passed', evidence: ['new-build-check#passed'] }] }) });
    state = sample(state, 240_000, { segmentId: 'build-b' });
    expect(summary(state, 240_000, 'build-b').verifiedSeconds).toBe(60);
  });

  it('imports only explicitly reviewed bounded intervals and deduplicates overlap/repeated adoption', () => {
    let state = importCredit(build(), [[0, 60_000], [30_000, 120_000]]);
    state = importCredit(state, [[0, 60_000], [30_000, 120_000]]);
    state = sample(sample(state, 60_000), 120_000);
    expect(summary(state, 120_000).verifiedSeconds).toBe(120);
    expect(state.segments[0].imports).toHaveLength(1);
    expect(() => importCredit(state, [[0, 180_000]])).toThrow('identity reused');
    expect(() => importCredit(state, [[0, 60_000]], { review: { id: 'no-proof', reviewedAt: start + 60_000, reason: 'Legacy total', evidence: [] } })).toThrow('evidence');
    expect(() => importCredit(state, [[0, 60_000]], { review: { id: 'future', reviewedAt: start + 30_000, reason: 'Review', evidence: ['proof'] } })).toThrow('beyond');
    expect(() => importCredit(state, [[-1, 60_000]])).toThrow('interval');
  });

  it('does not double-count concurrent segment wall-clock intervals', () => {
    let state = importCredit(build(), [[0, 120_000]]);
    state = build(state, 'build-b', 60_000);
    state = importCredit(state, [[60_000, 180_000]], { segmentId: 'build-b' });
    state = sample(state, 180_000, { segmentId: 'build-b' });
    expect(summary(state, 180_000, 'build-b').verifiedSeconds).toBe(180);
  });

  it('revokes only explicitly invalidated intervals without deleting original audit evidence', () => {
    const original = importCredit(build(), [[0, 180_000]]);
    const revocation = { id: 'bad-middle', segmentId: 'build-a', start: start + 60_000, end: start + 120_000,
      reason: 'Later evidence proved this earlier balance interval contradictory', evidence: ['balance-repair.json#sha256:987'] };
    const state = revokeFreshTrialCredit(original, revocation);
    expect(summary(state, 180_000).verifiedSeconds).toBe(120);
    expect(state.segments[0].intervals).toEqual([[start, start + 180_000]]);
    expect(state.revocations).toEqual([revocation]);
    expect(revokeFreshTrialCredit(state, revocation)).toEqual(state);
    expect(() => revokeFreshTrialCredit(state, { ...revocation, reason: '' })).toThrow('reason');
    expect(() => revokeFreshTrialCredit(state, { ...revocation, evidence: [] })).toThrow('evidence');
    expect(() => revokeFreshTrialCredit(state, { ...revocation, end: start + 130_000 })).toThrow('reused');
  });

  it('removes representative evidence only if its reviewed healthy interval is explicitly revoked', () => {
    let state = importCredit(build(), [[0, 60_000]]);
    expect(summary(state, 60_000).representative).toBe(true);
    state = revokeFreshTrialCredit(state, { id: 'invalid-all', segmentId: 'build-a', start, end: start + 60_001,
      reason: 'Imported interval invalidated', evidence: ['audit.json'] });
    expect(summary(state, 60_000)).toMatchObject({ verifiedSeconds: 0, representative: false });
    expect(() => importCredit(build(), [[0, 60_000]], { representativeAt: start + 70_000 })).toThrow('Representative');
  });

  it('discards representative activity at either inclusive revocation boundary', () => {
    for (const representativeAt of [start + 60_000, start + 120_000]) {
      let state = importCredit(build(), [[0, 180_000]], { representativeAt });
      state = revokeFreshTrialCredit(state, { id: 'bad-boundary', segmentId: 'build-a', start: start + 60_000, end: start + 120_000,
        reason: 'Representative evidence invalidated at repair boundary', evidence: ['canonical-repair.json'] });
      expect(summary(state, 180_000)).toMatchObject({ verifiedSeconds: 120, representative: false });
    }
  });

  it('keeps collection time separate from financial-feature health', () => {
    let state = sample(sample(build(), 0, { healthy: false }), 60_000, { healthy: false });
    expect(summary(state, 60_000)).toMatchObject({ verifiedSeconds: 0, collectionSeconds: 60 });
    state = sample(state, 120_000, { healthy: false, collectionHealthy: false });
    expect(summary(state, 120_000).collectionSeconds).toBe(60);
  });

  it('requires eight cumulative hours, campaign representatives and current fresh health', () => {
    let state = importCredit(build(), [[0, 28_799_000]]);
    state = sample(state, 28_799_000);
    expect(summary(state, 28_799_000)).toMatchObject({ durationComplete: false, complete: false });
    state = sample(state, 28_800_000);
    expect(summary(state, 28_800_000)).toMatchObject({ durationComplete: true, complete: true });
    expect(summary(state, 28_800_000, 'build-a', ['required_position_quote_unavailable']).complete).toBe(false);
    expect(summary(state, 28_891_000).complete).toBe(false);
    state.segments[0].representativeTimes = [];
    expect(summary(state, 28_800_000).complete).toBe(false);
  });
});
