import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readReviewedFreshTrialHistory } from './trialHistory.js';

const start = Date.parse('2026-10-23T00:00:00.000Z'), now = start + 600_000;
const iso = (offset: number) => new Date(start + offset).toISOString();
const digest = 'a'.repeat(64), temporary: string[] = [];
const hash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'fresh-history-test-')); temporary.push(directory);
  const workspace = path.join(directory, 'workspace'); await mkdir(workspace);
  const observations = [0, 60_000, 120_000, 180_000, 240_000].map(offset => ({ at: iso(offset),
    problems: offset === 120_000 ? ['trial_source_changed'] : [], counts: { public_buys: '1', public_sells: '1', tokens: '2' } }));
  const state = { version: 3, validationPolicy: 'traded_positions_v1', targetSeconds: 28_800,
    startedAt: iso(0), sourceDigest: digest, verifiedSeconds: 120, latest: observations.at(-1) };
  const entry = { id: digest + '@' + iso(0), sourceDigest: digest, startedAt: iso(0), observationCutoffAt: iso(240_000),
    creditedSeconds: 120, stateVerifiedSeconds: 120, representativeAt: iso(60_000),
    intervals: [{ startAt: iso(0), endAt: iso(60_000), seconds: 60 }, { startAt: iso(180_000), endAt: iso(240_000), seconds: 60 }],
    statePath: 'state.snapshot.json', observationsPath: 'observations.snapshot.jsonl', stateSha256: '', observationsSha256: '' };
  const audit = { version: 1, generatedAt: iso(300_000), policy: 'traded_positions_v1', targetSeconds: 28_800,
    creditType: 'retrospective_candidate_under_new_user_approval', retrospectiveAdoptionRequiresReview: true, creditedSeconds: 120, segments: [entry] };
  async function save() {
    const stateBody = JSON.stringify(state), observationBody = observations.map(row => JSON.stringify(row)).join('\n') + '\n';
    entry.stateSha256 = hash(stateBody); entry.observationsSha256 = hash(observationBody);
    await writeFile(path.join(workspace, 'state.snapshot.json'), stateBody);
    await writeFile(path.join(workspace, 'observations.snapshot.jsonl'), observationBody);
    await writeFile(path.join(workspace, 'audit.json'), JSON.stringify(audit));
  }
  await save();
  return { directory, workspace, state, observations, entry, audit, save,
    read: () => readReviewedFreshTrialHistory('audit.json', now, workspace) };
}

describe('reviewed trial history evidence I/O', () => {
  it('reconstructs clean adjacent intervals from hash-bound snapshots, excluding blocked time', async () => {
    const f = await fixture(), result = await f.read();
    expect(result).toMatchObject({ startedAt: start, totalSeconds: 120, segments: [{ id: f.entry.id,
      intervals: [[start, start + 60_000], [start + 180_000, start + 240_000]], representativeAt: start + 60_000 }] });
    expect(result.segments[0].evidence).toHaveLength(3);
    expect(result.segments[0].evidence.every(value => /#sha256:[a-f\d]{64}$/.test(value))).toBe(true);
  });

  it('rejects changed evidence bytes even when its declared totals still match', async () => {
    const f = await fixture(); await writeFile(path.join(f.workspace, f.entry.statePath), JSON.stringify({ ...f.state, arbitrary: true }));
    await expect(f.read()).rejects.toThrow('SHA-256');
  });

  it('requires both state and observation hashes rather than accepting missing verification', async () => {
    for (const key of ['stateSha256', 'observationsSha256'] as const) {
      const f = await fixture(); delete (f.entry as any)[key];
      await writeFile(path.join(f.workspace, 'audit.json'), JSON.stringify(f.audit));
      await expect(f.read()).rejects.toThrow('SHA-256');
    }
  });

  it('rejects legacy policy, wrong duration and nonexplicit retrospective audits', async () => {
    for (const mutation of [(f: Awaited<ReturnType<typeof fixture>>) => { f.state.version = 2; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.state.validationPolicy = 'all_positions'; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.state.targetSeconds = 86_400; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.audit.retrospectiveAdoptionRequiresReview = false; }]) {
      const f = await fixture(); mutation(f); await f.save(); await expect(f.read()).rejects.toThrow(/policy/);
    }
  });

  it('rejects state/source identity mismatches and reused segment identities', async () => {
    const f = await fixture(); f.state.sourceDigest = 'b'.repeat(64); await f.save(); await expect(f.read()).rejects.toThrow('source');
    f.state.sourceDigest = digest; f.audit.segments.push(structuredClone(f.entry)); await f.save();
    await expect(f.read()).rejects.toThrow('identity');
  });

  it('reconciles counters and intervals independently rather than trusting numeric credit', async () => {
    for (const mutation of [(f: Awaited<ReturnType<typeof fixture>>) => { f.state.verifiedSeconds = 121; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.creditedSeconds = 121; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.audit.creditedSeconds = 121; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.intervals[0].seconds = 61; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.intervals[0].endAt = iso(61_000); }]) {
      const f = await fixture(); mutation(f); await f.save(); await expect(f.read()).rejects.toThrow(/counter|interval/);
    }
  });

  it('never bridges a healthy host-sleep gap above ninety seconds', async () => {
    const f = await fixture(); f.observations[1].at = iso(91_000); await f.save();
    await expect(f.read()).rejects.toThrow('intervals');
  });

  it('rejects duplicate, reversed and malformed observation timestamps', async () => {
    for (const changed of [iso(0), iso(1), 'not-a-time']) {
      const f = await fixture(); f.observations[2].at = changed; await f.save();
      await expect(f.read()).rejects.toThrow(/timestamp|Nonmonotonic/);
    }
  });

  it('rejects all future review/observation time and unbounded invented intervals', async () => {
    const f = await fixture(); f.audit.generatedAt = iso(700_000); await f.save(); await expect(f.read()).rejects.toThrow('future');
    f.audit.generatedAt = iso(300_000); f.observations[4].at = iso(700_000); await f.save(); await expect(f.read()).rejects.toThrow('future');
  });

  it('requires representative activity at a real healthy credited observation', async () => {
    const f = await fixture(); f.entry.representativeAt = iso(120_000); await f.save(); await expect(f.read()).rejects.toThrow('representative');
    f.entry.representativeAt = iso(60_000); f.observations[1].counts.public_sells = '0'; await f.save();
    await expect(f.read()).rejects.toThrow('representative');
  });

  it('ignores blocked final representative labels when no representativeAt was adopted', async () => {
    const f = await fixture(); (f.entry as any).representativeAt = null; (f.entry as any).representative = true;
    await f.save(); expect((await f.read()).segments[0].representativeAt).toBeUndefined();
  });

  it('rejects evidence outside the workspace and symlinks resolving outside it', async () => {
    const f = await fixture(), outside = path.join(f.directory, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'state.json'), await readFile(path.join(f.workspace, f.entry.statePath)));
    f.entry.statePath = '../outside/state.json'; await f.save(); await expect(f.read()).rejects.toThrow('escapes');
    await symlink(outside, path.join(f.workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    f.entry.statePath = 'outside-link/state.json'; await f.save(); await expect(f.read()).rejects.toThrow('escapes');
  });

  it('rejects current mutable monitor evidence even if its checksum matches', async () => {
    const f = await fixture(); await mkdir(path.join(f.workspace, '.cache/fresh/trial'), { recursive: true });
    await writeFile(path.join(f.workspace, '.cache/fresh/trial/state.json'), JSON.stringify(f.state));
    f.entry.statePath = '.cache/fresh/trial/state.json'; await f.save(); await expect(f.read()).rejects.toThrow('immutable');
  });

  it('rejects overlapping wall-clock credit from distinct otherwise valid source segments', async () => {
    const f = await fixture(), otherDigest = 'b'.repeat(64), otherState = JSON.stringify({ ...f.state, sourceDigest: otherDigest });
    const otherEntry = { ...structuredClone(f.entry), sourceDigest: otherDigest, id: otherDigest + '@' + iso(0),
      statePath: 'other-state.snapshot.json', stateSha256: hash(otherState) };
    await writeFile(path.join(f.workspace, otherEntry.statePath), otherState);
    f.audit.segments.push(otherEntry); f.audit.creditedSeconds = 240;
    await writeFile(path.join(f.workspace, 'audit.json'), JSON.stringify(f.audit));
    await expect(f.read()).rejects.toThrow('overlap');
  });
});
