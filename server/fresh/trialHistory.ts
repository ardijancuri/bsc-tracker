import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { FRESH_TRIAL_POLICY, FRESH_TRIAL_TARGET_SECONDS } from './trialValidation.js';

type Interval = [number, number];
type ObjectValue = Record<string, any>;
export interface ReviewedFreshTrialHistory {
  startedAt: number; totalSeconds: number;
  segments: { id: string; sourceDigest: string; startedAt: number; intervals: Interval[]; representativeAt?: number; evidence: string[] }[];
}
const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid trial history object');
  return value as ObjectValue;
};
function timestamp(value: unknown, now: number): number {
  if (typeof value !== 'string') throw Error('Invalid trial history timestamp');
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || at < 0 || new Date(at).toISOString() !== value || at > now) throw Error('Invalid or future trial history timestamp');
  return at;
}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('Invalid trial history counter');
  return value;
}
function equalSeconds(actual: number, declared: unknown) {
  if (Math.abs(actual - counter(declared)) > 0.001) throw Error('Trial history counter mismatch');
}
const seconds = (intervals: Interval[]) => intervals.reduce((total, [start, end]) => total + end - start, 0) / 1000;
function append(intervals: Interval[], start: number, end: number) {
  const last = intervals.at(-1);
  if (last?.[1] === start) last[1] = end;
  else intervals.push([start, end]);
}

/** Read only hash-bound observation snapshots. The CLI supplies the separate
 * human review; arbitrary legacy totals cannot become cumulative credit. */
export async function readReviewedFreshTrialHistory(auditPath: string, now = Date.now(), workspace = process.cwd()): Promise<ReviewedFreshTrialHistory> {
  if (!Number.isSafeInteger(now) || now < 0) throw Error('Invalid trial history review time');
  const root = await realpath(workspace);
  async function readContained(filename: unknown, limit: number, expectedHash?: unknown) {
    if (typeof filename !== 'string' || !filename.length) throw Error('Missing trial history evidence path');
    const resolved = await realpath(path.resolve(root, filename));
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Trial history evidence escapes workspace');
    if (/^\.cache[\\/]fresh[\\/]trial[\\/](state\.json|observations\.jsonl)$/i.test(relative)) throw Error('Trial history requires immutable evidence snapshots');
    const info = await stat(resolved);
    if (!info.isFile() || info.size > limit) throw Error('Trial history evidence is not a bounded file');
    const bytes = await readFile(resolved);
    if (bytes.length > limit) throw Error('Trial history evidence is not a bounded file');
    if (expectedHash !== undefined && (typeof expectedHash !== 'string' || !/^[a-f\d]{64}$/.test(expectedHash) || sha256(bytes) !== expectedHash)) throw Error('Trial history evidence SHA-256 mismatch');
    return { bytes, evidence: `${relative.replaceAll('\\', '/')}#sha256:${sha256(bytes)}` };
  }
  const auditFile = await readContained(auditPath, 4 * 1024 * 1024);
  const audit = object(JSON.parse(auditFile.bytes.toString('utf8')));
  if (audit.version !== 1 || audit.policy !== FRESH_TRIAL_POLICY || audit.targetSeconds !== FRESH_TRIAL_TARGET_SECONDS
    || audit.creditType !== 'retrospective_candidate_under_new_user_approval' || audit.retrospectiveAdoptionRequiresReview !== true
    || !Array.isArray(audit.segments) || !audit.segments.length) throw Error('Unreviewed trial history audit policy');
  const generatedAt = timestamp(audit.generatedAt, now);
  const result: ReviewedFreshTrialHistory = { startedAt: now, totalSeconds: 0, segments: [] };
  const ids = new Set<string>(), allIntervals: Interval[] = [];
  for (const untyped of audit.segments) {
    const entry = object(untyped), startedAt = timestamp(entry.startedAt, now), cutoff = timestamp(entry.observationCutoffAt, now);
    if (typeof entry.sourceDigest !== 'string' || !/^[a-f\d]{64}$/.test(entry.sourceDigest)
      || entry.id !== `${entry.sourceDigest}@${entry.startedAt}` || ids.has(entry.id) || cutoff < startedAt || cutoff > generatedAt) throw Error('Invalid trial history segment identity');
    ids.add(entry.id);
    if (typeof entry.stateSha256 !== 'string' || !/^[a-f\d]{64}$/.test(entry.stateSha256)
      || typeof entry.observationsSha256 !== 'string' || !/^[a-f\d]{64}$/.test(entry.observationsSha256)) throw Error('Trial history evidence SHA-256 missing or invalid');
    const stateFile = await readContained(entry.statePath, 4 * 1024 * 1024, entry.stateSha256);
    const observationsFile = await readContained(entry.observationsPath, 32 * 1024 * 1024, entry.observationsSha256);
    const state = object(JSON.parse(stateFile.bytes.toString('utf8')));
    if (state.version !== 3 || state.validationPolicy !== FRESH_TRIAL_POLICY || state.targetSeconds !== FRESH_TRIAL_TARGET_SECONDS
      || state.sourceDigest !== entry.sourceDigest || timestamp(state.startedAt, now) !== startedAt
      || timestamp(object(state.latest).at, now) !== cutoff) throw Error('Trial history source or policy mismatch');
    const observations: { at: number; healthy: boolean; counts: ObjectValue }[] = [];
    let previousAt = -1;
    for (const line of observationsFile.bytes.toString('utf8').split(/\r?\n/).filter(value => value.trim().length)) {
      const row = object(JSON.parse(line)), at = timestamp(row.at, now);
      if (at < startedAt || at <= previousAt || !Array.isArray(row.problems) || !row.problems.every((problem: unknown) => typeof problem === 'string' && problem.length)) throw Error('Nonmonotonic or invalid trial observations');
      previousAt = at;
      if (at <= cutoff) observations.push({ at, healthy: row.problems.length === 0, counts: object(row.counts) });
    }
    if (!observations.length) throw Error('Trial history has no observations');
    const intervals: Interval[] = [];
    for (let i = 1; i < observations.length; i++) {
      const before = observations[i - 1], after = observations[i];
      if (before.healthy && after.healthy && after.at - before.at <= 90_000) append(intervals, before.at, after.at);
    }
    if (!Array.isArray(entry.intervals) || entry.intervals.length !== intervals.length) throw Error('Trial history intervals differ from observations');
    for (let i = 0; i < intervals.length; i++) {
      const declared = object(entry.intervals[i]), [start, end] = intervals[i];
      if (timestamp(declared.startAt, now) !== start || timestamp(declared.endAt, now) !== end) throw Error('Trial history intervals differ from observations');
      equalSeconds((end - start) / 1000, declared.seconds);
    }
    const earned = seconds(intervals);
    equalSeconds(earned, state.verifiedSeconds); equalSeconds(earned, entry.creditedSeconds); equalSeconds(earned, entry.stateVerifiedSeconds);
    let representativeAt: number | undefined;
    if (entry.representativeAt !== null && entry.representativeAt !== undefined) {
      representativeAt = timestamp(entry.representativeAt, now);
      const row = observations.find(value => value.at === representativeAt);
      const count = (value: unknown) => (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)) && Number(value) >= 1;
      if (!row?.healthy || !count(row.counts.public_buys) || !count(row.counts.public_sells) || !count(row.counts.tokens)
        || !intervals.some(([start, end]) => representativeAt! >= start && representativeAt! <= end)) throw Error('Trial history representative activity lacks healthy observations');
    }
    result.segments.push({ id: entry.id, sourceDigest: entry.sourceDigest, startedAt, intervals,
      ...(representativeAt === undefined ? {} : { representativeAt }), evidence: [auditFile.evidence, stateFile.evidence, observationsFile.evidence] });
    result.startedAt = Math.min(result.startedAt, startedAt);
    allIntervals.push(...intervals);
  }
  allIntervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < allIntervals.length; i++) if (allIntervals[i][0] < allIntervals[i - 1][1]) throw Error('Trial history credit intervals overlap');
  result.totalSeconds = seconds(allIntervals); equalSeconds(result.totalSeconds, audit.creditedSeconds);
  return result;
}
