import { FRESH_TRIAL_POLICY, FRESH_TRIAL_TARGET_SECONDS } from './trialValidation.js';

export const FRESH_TRIAL_PROGRESS_POLICY = 'segmented_v1';
export const FRESH_TRIAL_DOMAINS = ['capture', 'decoding', 'accounting', 'valuation', 'replay', 'privacy_notifications', 'trial_monitor'] as const;
export type FreshTrialDomain = typeof FRESH_TRIAL_DOMAINS[number];
export type FreshTrialInterval = [number, number];
export interface FreshTrialReview {
  id: string; reviewedAt: number; reason: string; evidence: string[];
  changedDomains: FreshTrialDomain[];
  checks: { domain: FreshTrialDomain; status: 'passed' | 'pending' | 'failed'; evidence: string[] }[];
}
export interface FreshTrialCreditReview { id: string; reviewedAt: number; reason: string; evidence: string[] }
export interface FreshTrialCreditImport extends FreshTrialCreditReview {
  intervals: FreshTrialInterval[]; collectionIntervals: FreshTrialInterval[]; representativeAt?: number;
}
export interface FreshTrialSegment {
  id: string; sourceDigest: string; startedAt: number; reviews: FreshTrialReview[];
  intervals: FreshTrialInterval[]; collectionIntervals: FreshTrialInterval[]; representativeTimes: number[];
  imports: FreshTrialCreditImport[];
  lastSample: { at: number; healthy: boolean; collectionHealthy: boolean; problems: string[] } | null;
}
export interface FreshTrialProgress {
  version: 4; validationPolicy: typeof FRESH_TRIAL_POLICY; progressPolicy: typeof FRESH_TRIAL_PROGRESS_POLICY;
  campaignId: string; startedAt: number; targetSeconds: number; segments: FreshTrialSegment[];
  revocations: { id: string; segmentId: string; start: number; end: number; reason: string; evidence: string[] }[];
}
const MAX_SAMPLE_GAP = 90_000;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function requireEvidence(evidence: string[]) {
  if (!Array.isArray(evidence) || !evidence.length || !evidence.every(text)) throw Error('Trial review requires evidence references');
}
function requireCreditReview(review: FreshTrialCreditReview) {
  if (!text(review.id) || !time(review.reviewedAt) || !text(review.reason)) throw Error('Invalid trial review');
  requireEvidence(review.evidence);
}
function requireReview(review: FreshTrialReview) {
  requireCreditReview(review);
  if (!Array.isArray(review.changedDomains) || !review.changedDomains.length
    || new Set(review.changedDomains).size !== review.changedDomains.length
    || !review.changedDomains.every(domain => FRESH_TRIAL_DOMAINS.includes(domain))) throw Error('Invalid affected trial domains');
  if (!Array.isArray(review.checks) || new Set(review.checks.map(check => check.domain)).size !== review.checks.length) throw Error('Duplicate trial checks');
  for (const check of review.checks) {
    if (!review.changedDomains.includes(check.domain) || !['passed', 'pending', 'failed'].includes(check.status)) throw Error('Invalid trial regression check');
    if (check.status === 'passed') requireEvidence(check.evidence);
  }
}
function segmentOf(state: FreshTrialProgress, id: string) {
  const segment = state.segments.find(value => value.id === id);
  if (!segment) throw Error('Unreviewed trial segment');
  return segment;
}
function requireInterval(interval: FreshTrialInterval, startedAt: number) {
  if (!Array.isArray(interval) || interval.length !== 2 || !interval.every(time)
    || interval[0] < startedAt || interval[1] <= interval[0]) throw Error('Invalid trial credit interval');
}
function union(intervals: readonly FreshTrialInterval[]): FreshTrialInterval[] {
  const result: FreshTrialInterval[] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
function without(intervals: readonly FreshTrialInterval[], exclusions: readonly FreshTrialInterval[]) {
  let remaining = union(intervals);
  for (const [start, end] of union(exclusions)) remaining = remaining.flatMap(([a, b]): FreshTrialInterval[] => {
    if (end <= a || start >= b) return [[a, b]];
    return [...(a < start ? [[a, start] as FreshTrialInterval] : []), ...(end < b ? [[end, b] as FreshTrialInterval] : [])];
  });
  return remaining;
}
const seconds = (intervals: readonly FreshTrialInterval[]) => intervals.reduce((sum, [start, end]) => sum + end - start, 0) / 1000;
function reviewProblems(segments: readonly FreshTrialSegment[]) {
  // Outstanding gates belong to the campaign, even when the affected build
  // earned no time. A later build must explicitly pass the affected domain;
  // a monitor-only change cannot waive an earlier accounting regression.
  // Build order prevents a subsequent review of older code from overriding a
  // newer build's failed check. Stable ties preserve explicit adoption order.
  const latest = new Map<FreshTrialDomain, { segmentId: string; check: FreshTrialReview['checks'][number] }>();
  for (const segment of [...segments].sort((a, b) => a.startedAt - b.startedAt)) {
    for (const review of segment.reviews) for (const domain of review.changedDomains) latest.set(domain, { segmentId: segment.id,
      check: review.checks.find(check => check.domain === domain) ?? { domain, status: 'pending', evidence: [] } });
  }
  return [...latest].flatMap(([domain, { segmentId, check }]) => check.status === 'passed' ? [] : [`${segmentId}:${domain}:${check.status}`]);
}

export function createFreshTrialProgress(input: { campaignId: string; startedAt: number; targetSeconds?: number }): FreshTrialProgress {
  const targetSeconds = input.targetSeconds ?? FRESH_TRIAL_TARGET_SECONDS;
  if (!text(input.campaignId) || !time(input.startedAt) || !Number.isFinite(targetSeconds) || targetSeconds <= 0) throw Error('Invalid trial campaign');
  return { version: 4, validationPolicy: FRESH_TRIAL_POLICY, progressPolicy: FRESH_TRIAL_PROGRESS_POLICY,
    campaignId: input.campaignId, startedAt: input.startedAt, targetSeconds, segments: [], revocations: [] };
}

/** Register a reviewed immutable build, or append a targeted regression review.
 * This never adopts a previous report's total or resets earned intervals. */
export function reviewFreshTrialSegment(state: FreshTrialProgress, input: { id: string; sourceDigest: string; startedAt: number; review: FreshTrialReview }): FreshTrialProgress {
  requireReview(input.review);
  if (!text(input.id) || !/^[a-f\d]{64}$/.test(input.sourceDigest) || !time(input.startedAt) || input.startedAt < state.startedAt
    || input.review.reviewedAt < input.startedAt) throw Error('Invalid reviewed trial segment');
  const next = structuredClone(state), existing = next.segments.find(segment => segment.id === input.id);
  if (existing && (existing.sourceDigest !== input.sourceDigest || existing.startedAt !== input.startedAt)) throw Error('Trial segment source and boundary are immutable');
  const segment = existing ?? { id: input.id, sourceDigest: input.sourceDigest, startedAt: input.startedAt,
    reviews: [], intervals: [], collectionIntervals: [], representativeTimes: [], imports: [], lastSample: null };
  const duplicate = segment.reviews.find(review => review.id === input.review.id);
  if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(input.review)) throw Error('Trial review identity reused');
  if (!duplicate) {
    if (segment.reviews.at(-1) && input.review.reviewedAt < segment.reviews.at(-1)!.reviewedAt) throw Error('Trial review time moved backwards');
    segment.reviews.push(structuredClone(input.review));
    // The preceding observation predates this review. A pending/failed gate
    // followed by a quick approval must not bridge that unvalidated interval.
    // An identical replayed review does not break an existing live endpoint.
    for (const saved of next.segments) saved.lastSample = null;
    segment.lastSample = null;
  }
  if (!existing) next.segments.push(segment);
  return next;
}

/** Only adjacent successful observations earn time. Failed observations, host
 * sleep, duplicate timestamps and process restarts cannot bridge intervals. */
export function recordFreshTrialSample(state: FreshTrialProgress, input: { segmentId: string; at: number; healthy: boolean; collectionHealthy: boolean; representative: boolean; problems?: string[] }): FreshTrialProgress {
  const next = structuredClone(state), segment = segmentOf(next, input.segmentId);
  if (!time(input.at) || input.at < segment.startedAt || typeof input.healthy !== 'boolean' || typeof input.collectionHealthy !== 'boolean'
    || typeof input.representative !== 'boolean') throw Error('Invalid trial sample');
  const problems = input.problems ?? [], previous = segment.lastSample;
  if (!Array.isArray(problems) || !problems.every(text)) throw Error('Invalid trial sample problems');
  if (previous && input.at < previous.at) throw Error('Trial sample time moved backwards');
  if (previous && input.at === previous.at) return next;
  const healthy = input.healthy && problems.length === 0 && reviewProblems(next.segments).length === 0;
  const collectionHealthy = input.collectionHealthy;
  if (previous && input.at - previous.at <= MAX_SAMPLE_GAP) {
    if (healthy && previous.healthy) segment.intervals = union([...segment.intervals, [previous.at, input.at]]);
    if (collectionHealthy && previous.collectionHealthy) segment.collectionIntervals = union([...segment.collectionIntervals, [previous.at, input.at]]);
  }
  if (healthy && input.representative && !segment.representativeTimes.includes(input.at)) segment.representativeTimes.push(input.at);
  segment.lastSample = { at: input.at, healthy, collectionHealthy, problems: [...problems] };
  return next;
}

export function breakFreshTrialSampleContinuity(state: FreshTrialProgress, segmentId: string): FreshTrialProgress {
  const next = structuredClone(state); segmentOf(next, segmentId).lastSample = null; return next;
}

/** Adoption is deliberate: callers reconstruct successful intervals from an
 * archived observation log and attach its reviewed proof paths/hashes. Never
 * pass an unaudited legacy verifiedSeconds counter here. */
export function importReviewedFreshTrialCredit(state: FreshTrialProgress, input: { segmentId: string; intervals: FreshTrialInterval[]; collectionIntervals?: FreshTrialInterval[]; representativeAt?: number; review: FreshTrialCreditReview }): FreshTrialProgress {
  requireCreditReview(input.review);
  const next = structuredClone(state), segment = segmentOf(next, input.segmentId);
  const collections = input.collectionIntervals ?? [];
  if (!Array.isArray(input.intervals) || !Array.isArray(collections)) throw Error('Invalid imported trial intervals');
  for (const interval of [...input.intervals, ...collections]) {
    requireInterval(interval, segment.startedAt);
    if (interval[1] > input.review.reviewedAt) throw Error('Imported trial credit extends beyond its review');
  }
  const imported: FreshTrialCreditImport = { ...structuredClone(input.review), intervals: union(input.intervals), collectionIntervals: union(collections),
    ...(input.representativeAt === undefined ? {} : { representativeAt: input.representativeAt }) };
  const duplicate = segment.imports.find(review => review.id === input.review.id);
  if (duplicate) {
    if (JSON.stringify(duplicate) !== JSON.stringify(imported)) throw Error('Trial import review identity reused');
  } else segment.imports.push(imported);
  segment.intervals = union([...segment.intervals, ...input.intervals]);
  segment.collectionIntervals = union([...segment.collectionIntervals, ...collections]);
  if (input.representativeAt !== undefined) {
    if (!time(input.representativeAt) || !input.intervals.some(([start, end]) => input.representativeAt! >= start && input.representativeAt! <= end)) throw Error('Representative activity lacks reviewed healthy interval');
    if (!segment.representativeTimes.includes(input.representativeAt)) segment.representativeTimes.push(input.representativeAt);
  }
  return next;
}

/** Corrections can revoke proved-invalid time explicitly without deleting its
 * original audit history or unrelated healthy intervals. */
export function revokeFreshTrialCredit(state: FreshTrialProgress, input: FreshTrialProgress['revocations'][number]): FreshTrialProgress {
  const next = structuredClone(state), segment = segmentOf(next, input.segmentId);
  if (!text(input.id) || !text(input.reason)) throw Error('Trial revocation requires a reason');
  requireEvidence(input.evidence); requireInterval([input.start, input.end], segment.startedAt);
  const duplicate = next.revocations.find(revocation => revocation.id === input.id);
  if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(input)) throw Error('Trial revocation identity reused');
  if (!duplicate) next.revocations.push(structuredClone(input));
  return next;
}

export function freshTrialProgressSummary(state: FreshTrialProgress, input: { currentSegmentId: string; now: number; currentProblems?: string[] }) {
  if (state.version !== 4 || state.validationPolicy !== FRESH_TRIAL_POLICY || state.progressPolicy !== FRESH_TRIAL_PROGRESS_POLICY) throw Error('Unreviewed trial progress policy');
  const current = segmentOf(state, input.currentSegmentId);
  if (!time(input.now)) throw Error('Invalid trial summary time');
  const segments = state.segments.map(segment => {
    const exclusions: FreshTrialInterval[] = state.revocations.filter(row => row.segmentId === segment.id).map(row => [row.start, row.end]);
    const intervals = without(segment.intervals, exclusions), collectionIntervals = without(segment.collectionIntervals, exclusions);
    return { id: segment.id, sourceDigest: segment.sourceDigest, verifiedSeconds: seconds(intervals), collectionSeconds: seconds(collectionIntervals),
      intervals, collectionIntervals, representative: segment.representativeTimes.some(at =>
        !exclusions.some(([start, end]) => at >= start && at <= end)
        && intervals.some(([start, end]) => at >= start && at <= end)),
      regressionProblems: reviewProblems([segment]) };
  });
  const verifiedSeconds = seconds(union(segments.flatMap(segment => segment.intervals)));
  const collectionSeconds = seconds(union(segments.flatMap(segment => segment.collectionIntervals)));
  const representative = segments.some(segment => segment.representative);
  const regressionProblems = reviewProblems(state.segments);
  const currentProblems = [...(input.currentProblems ?? [])];
  if (!current.lastSample?.healthy || input.now < current.lastSample.at || input.now - current.lastSample.at > MAX_SAMPLE_GAP) currentProblems.push('current_trial_observation_unhealthy_or_stale');
  const durationComplete = verifiedSeconds >= state.targetSeconds;
  return { verifiedSeconds, collectionSeconds, representative, durationComplete, regressionProblems, currentProblems,
    complete: durationComplete && representative && !regressionProblems.length && !currentProblems.length, segments };
}
