import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { KolTokenActivity } from '../../shared/kolTokenTrades.js';
import type { ReplayPreparation, ReplayPreparationReason } from '../../shared/replayPreparation.js';
import type { ReplayMarketChart } from '../../shared/replayChart.js';
import { FreshChartError, type FreshCharts } from './charts.js';
import{validNodeCostEstimate}from'../../shared/nodeCostEstimate.js';

const LEASE_MS = 15 * 60_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type FreshReplayRevision = { scopeId: string; correctionEpoch: string | number; membershipRevision?: string | number;historyPermissionDigest?:string };
export type FreshReplayActivity = KolTokenActivity & { __freshRevision?: FreshReplayRevision };
export interface FreshReplayManifest {
  version: 1; audience: 'kollens-replay-fresh-v1'; wallet: string; token: string; scope: string;
  snapshotId: string; windowId: string; historyFingerprint: string; cutoffBlock: string | null; cutoffHash: string | null;
  correctionEpoch: string; membershipRevision: string | null; scopeId: string;
  valuationAt: string; from: string; to: string; issuedAt: number; expiresAt: number;
  historyPermissionDigest?:string;
  accountingQuality?:'estimated';estimatePolicy?:'omit_unknown_costs_v1';
}
export type FreshReplayPreparation = ReplayPreparation & { manifest?: string; expiresAt?: string };
export function createFreshReplay({ charts, secret, validateRevision, now = Date.now, maxBytes = 32 * 1024 * 1024, maxEntries = 64, ownerDeadlineMs = 65_000 }:
  { charts: Pick<FreshCharts, 'replayChart'>; secret: string | Buffer;
    validateRevision: (claims: FreshReplayManifest) => Promise<boolean>; now?: () => number; maxBytes?: number; maxEntries?: number; ownerDeadlineMs?: number }) {
  if (Buffer.byteLength(secret) < 32) throw new Error('Replay signing secret requires at least 32 bytes');
  if (!Number.isFinite(ownerDeadlineMs) || ownerDeadlineMs <= 0 || ownerDeadlineMs > 65_000) throw new Error('Replay owner deadline must be between 1 and 65000 milliseconds');
  type Stored = { activity: FreshReplayActivity; prepared?: FreshReplayPreparation; expiresAt: number; bytes: number };
  type Job = { promise: Promise<FreshReplayPreparation>; controller: AbortController; subscribers: number };
  const stored = new Map<string, Stored>(), jobs = new Map<string, Job>();
  let deferredReads = 0, backgroundFailures = 0, ownerTimeouts = 0;
  const cacheKey = (snapshot: string, scope: string) => JSON.stringify([scope, snapshot]);
  const signature = (encoded: string) => createHmac('sha256', secret).update(encoded).digest('base64url');
  function sign(claims: FreshReplayManifest) { const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url'); return encoded + '.' + signature(encoded); }
  function trim() {
    for (const [key, value] of stored) if (value.expiresAt <= now()) stored.delete(key);
    let bytes = [...stored.values()].reduce((sum, value) => sum + value.bytes, 0);
    for (const [key, value] of stored) {
      if (stored.size <= maxEntries && bytes <= maxBytes) break;
      stored.delete(key); bytes -= value.bytes;
    }
  }
  function save(activity: FreshReplayActivity, scope: string, prepared?: FreshReplayPreparation): boolean {
    const snapshotId = activity.accountingSnapshot?.snapshotId;
    if (!snapshotId) return false;
    const key = cacheKey(snapshotId, scope), prior = stored.get(key);
    // Never replace an issued snapshot with newer mutable input under one ID.
    if (prior?.prepared?.status === 'ready') return true;
    // Reject before cloning both financial copies and the candle payload.
    const bytes = Buffer.byteLength(JSON.stringify([activity, prepared]));
    if (bytes > maxBytes) return false;
    const entry = { activity: structuredClone(activity), prepared: prepared && structuredClone(prepared),
      expiresAt: prepared?.expiresAt ? Date.parse(prepared.expiresAt) : now() + LEASE_MS, bytes };
    stored.delete(key); stored.set(key, entry); trim();
    return stored.get(key) === entry;
  }
  function read(snapshotId: string, scope: string) {
    trim(); const key = cacheKey(snapshotId, scope), entry = stored.get(key);
    if (entry) { stored.delete(key); stored.set(key, entry); }
    return entry;
  }
  function base(activity: FreshReplayActivity, includeActivity = true): FreshReplayPreparation {
    return { version: 2, status: 'pending', snapshotId: activity.accountingSnapshot?.snapshotId ?? null, window: null,
      stages: { accounting: 'pending', chart: 'pending', valuation: 'pending' }, asOf: activity.accountingSnapshot?.asOf ?? activity.generatedAt,
      ...(includeActivity ? { activity: structuredClone(activity) } : {}) };
  }
  function capacity(activity: FreshReplayActivity): FreshReplayPreparation {
    return { ...base(activity, false), status: 'unavailable', reason: 'preparation_capacity',
      stages: { accounting: 'unavailable', chart: 'unavailable', valuation: 'unavailable' } };
  }
  async function build(activity: FreshReplayActivity, scope: string, signal: AbortSignal): Promise<FreshReplayPreparation> {
    const result = base(activity), identity = activity.accountingSnapshot, accounting = activity.replayAccounting;
    const estimate=validNodeCostEstimate(identity),estimated=!!estimate&&accounting?.status==='estimated'&&accounting.coverage.estimatedFinal===true
      &&accounting.final?.reportedProfitUsd===estimate.totalProfitUsd&&accounting.final?.cumulativeRealizedProfitUsd===estimate.realizedProfitUsd
      &&accounting.final?.feeInclusiveCostUsd===estimate.knownCapitalUsd&&accounting.final?.reportedRoi===null;
    const fail = (reason: ReplayPreparationReason, pending: boolean, retryAfterMs = 2000): FreshReplayPreparation => ({ ...result,
      status: pending ? 'pending' : 'unavailable', reason, ...(pending ? { retryAfterMs } : {}) });
    const reasons = [...(identity?.reasons ?? []), accounting?.coverage.reason ?? ''];
    if (reasons.includes('historical_precision_unavailable') || reasons.includes('historical_settlement_unavailable')) {
      result.stages.accounting = 'unavailable'; return fail('historical_evidence_unavailable', false);
    }
    if (reasons.some(reason => /mismatch|unreconciled|contradict|negative_balance/.test(reason))) {
      result.stages.accounting = 'unavailable'; return fail('accounting_mismatch', false);
    }
    if (reasons.some(reason => /unsupported|decoder/.test(reason))) {
      result.stages.accounting = 'unavailable'; return fail('unsupported_decoder', false);
    }
    if (identity && accounting && reasons.includes('quote_unavailable') && identity.complete
      && accounting.coverage.transactionsComplete && accounting.coverage.balanceMatched) {
      result.stages.accounting = 'ready'; result.stages.valuation = 'pending'; return fail('stale_quote', true);
    }
    if (!identity || !accounting || accounting.status === 'pending') return fail('accounting_pending', true);
    if ((!identity.complete&&!estimated) || !accounting.coverage.transactionsComplete || !accounting.coverage.balanceMatched || !accounting.final) {
      const unknown = reasons.some(reason => /cost|fee|opening/.test(reason));
      const pending = !unknown;
      result.stages.accounting = pending ? 'pending' : 'unavailable';
      return fail(unknown ? 'unknown_costs' : 'accounting_pending', pending);
    }
    const events = accounting.history?.events ?? accounting.events;
    let from = Infinity, last = -Infinity, validTimes = true;
    for (const event of events) {
      const time = Date.parse(event.timestamp);
      if (!Number.isFinite(time)) { validTimes = false; break; }
      if (time < from) from = time; if (time > last) last = time;
    }
    if (!events.length || !validTimes || accounting.final.reportedProfitUsd === null
      || accounting.final.feeInclusiveCostUsd === null) {
      result.stages.accounting = 'unavailable'; return fail('unknown_costs', false);
    }
    result.stages.accounting = 'ready';
    const open = activity.realizedAccounting?.position?.status === 'open' || Number(accounting.final.remainingTokenAmount) > 0;
    const to = open ? Date.parse(accounting.final.timestamp) : last;
    if (!Number.isFinite(to) || to < last || to > now() + 1000) return fail('stale_quote', true);
    if (open && (!accounting.final.priceUsd || Number(accounting.final.priceUsd) <= 0 || now() - to > 120_000)) return fail('stale_quote', true);
    if (!activity.token.marketCapSupply || !Number.isFinite(Number(activity.token.marketCapSupply)) || Number(activity.token.marketCapSupply) <= 0) return fail('stale_quote', true);
    result.stages.valuation = 'ready';
    result.window = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), id: hash([identity.snapshotId, from, to]) };
    let chart: ReplayMarketChart;
    try {
      chart = await charts.replayChart(activity.token.address, { from, to, open, supply: activity.token.marketCapSupply, signal,
        ...(open && accounting.final.priceUsd ? { ending: { timestamp: accounting.final.timestamp, priceUsd: accounting.final.priceUsd } } : {}) });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof FreshChartError) {
        result.stages.chart = error.reason === 'chart_unavailable' ? 'unavailable' : 'pending';
        if (error.reason === 'stale_quote') result.stages.valuation = 'pending';
        return fail(error.reason, error.reason !== 'chart_unavailable', error.retryAfterMs || 2000);
      }
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return fail('chart_coverage', true, 3000);
      throw error;
    }
    signal.throwIfAborted();
    // Provider work can outlive an initially fresh node mark. New leases must
    // still meet the two-minute rule at issue time; cached chart pages survive.
    if (open && now() - to > 120_000) { result.stages.valuation = 'pending'; return fail('stale_quote', true); }
    const revision = activity.__freshRevision, issuedAt = now();
    const claims: FreshReplayManifest = { version: 1, audience: 'kollens-replay-fresh-v1', wallet: activity.kol.address.toLowerCase(), token: activity.token.address.toLowerCase(),
      scope, scopeId: revision?.scopeId ?? 'public', correctionEpoch: String(revision?.correctionEpoch ?? '0'), membershipRevision: revision?.membershipRevision === undefined ? null : String(revision.membershipRevision),...(revision?.historyPermissionDigest?{historyPermissionDigest:revision.historyPermissionDigest}:{}),
      snapshotId: identity.snapshotId, windowId: result.window.id, historyFingerprint: identity.historyFingerprint,
      cutoffBlock: accounting.inventoryBlockNumber ?? identity.coveredThroughBlock, cutoffHash: accounting.inventoryBlockHash ?? identity.valuationHash,
      valuationAt: accounting.final.timestamp, from: result.window.from, to: result.window.to, issuedAt, expiresAt: issuedAt + LEASE_MS };
    if(estimated)Object.assign(claims,{accountingQuality:'estimated',estimatePolicy:'omit_unknown_costs_v1'});
    const revisionValid = await validateRevision(claims);
    // An expired owner may finish a slow database check later. It can never
    // issue a lease or overwrite the next owner's immutable ready object.
    signal.throwIfAborted();
    if (!revisionValid) { result.stages.accounting = 'pending'; return fail('accounting_pending', true); }
    chart = { ...chart, snapshotId: identity.snapshotId, windowId: result.window.id, marketCapSupply: activity.token.marketCapSupply,
      updatedAt: accounting.final.timestamp, stale: false };
    const ready: FreshReplayPreparation = { ...result, status: 'ready', stages: { accounting: 'ready', chart: 'ready', valuation: 'ready' }, chart,
      manifest: sign(claims), expiresAt: new Date(claims.expiresAt).toISOString() };
    return save(activity, scope, ready) ? ready : capacity(activity);
  }
  const service = {
    remember(activity: FreshReplayActivity, scope = 'public') { save(activity, scope); },
    saved(snapshotId: string, scope = 'public') { const entry = read(snapshotId, scope); return entry ? structuredClone(entry.activity) : null; },
    async authorizedSaved(snapshotId: string, scope = 'public') {
      const entry = read(snapshotId, scope); if (!entry) return null;
      const activity = entry.activity, identity = activity.accountingSnapshot!, revision = activity.__freshRevision;
      const claims: FreshReplayManifest = { version: 1, audience: 'kollens-replay-fresh-v1', wallet: activity.kol.address.toLowerCase(), token: activity.token.address.toLowerCase(),
        scope, scopeId: revision?.scopeId ?? 'public', correctionEpoch: String(revision?.correctionEpoch ?? '0'), membershipRevision: revision?.membershipRevision === undefined ? null : String(revision.membershipRevision),...(revision?.historyPermissionDigest?{historyPermissionDigest:revision.historyPermissionDigest}:{}),
        snapshotId: identity.snapshotId, windowId: entry.prepared?.window?.id ?? '', historyFingerprint: identity.historyFingerprint,
        cutoffBlock: activity.replayAccounting?.inventoryBlockNumber ?? identity.coveredThroughBlock, cutoffHash: activity.replayAccounting?.inventoryBlockHash ?? null,
        valuationAt: activity.replayAccounting?.final?.timestamp ?? identity.asOf, from: entry.prepared?.window?.from ?? identity.asOf,
        to: entry.prepared?.window?.to ?? identity.asOf, issuedAt: entry.expiresAt - LEASE_MS, expiresAt: entry.expiresAt };
      if (!await validateRevision(claims)) { stored.delete(cacheKey(snapshotId, scope)); return null; }
      return structuredClone(activity);
    },
    async prepare(activity: FreshReplayActivity, options: { scope?: string; signal?: AbortSignal } = {}): Promise<FreshReplayPreparation> {
      if (Buffer.byteLength(JSON.stringify(activity)) > maxBytes) return capacity(activity);
      const scope = options.scope ?? 'public', key = cacheKey(activity.accountingSnapshot?.snapshotId ?? hash(activity), scope);
      const ready = activity.accountingSnapshot && read(activity.accountingSnapshot.snapshotId, scope)?.prepared;
      if (ready) {
        const approval = await service.validate(ready.manifest!, scope);
        if (approval.valid) return structuredClone(ready);
        stored.delete(key);
      }
      options.signal?.throwIfAborted();
      let job = jobs.get(key);
      if (!job) {
        if (jobs.size >= 32) return { ...base(activity), reason: 'preparation_pending', retryAfterMs: 2000 };
        const controller = new AbortController();
        job = { controller, subscribers: 0, promise: Promise.resolve(undefined as never) };
        const selected = job;
        job.promise = new Promise<FreshReplayPreparation>((resolve, reject) => {
          let ended = false;
          const timer = setTimeout(() => {
            if (ended) return; ended = true; ownerTimeouts++;
            // Resolve before aborting subscribers so the deadline always has
            // a readable stage result even if abort handlers reject inline.
            resolve({ ...base(activity), status: 'pending', reason: 'preparation_timeout', retryAfterMs: 5000 });
            controller.abort(new DOMException('Replay owner deadline exceeded', 'TimeoutError'));
          }, ownerDeadlineMs);
          build(structuredClone(activity), scope, controller.signal).then(value => {
            if (ended) return; ended = true; clearTimeout(timer); resolve(value);
          }, error => {
            if (ended) return; ended = true; clearTimeout(timer); reject(error);
          });
        }).finally(() => { if (jobs.get(key) === selected) jobs.delete(key); });
        jobs.set(key, job);
      }
      const shared = job; shared.subscribers++;
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = () => {
          if (settled) return false; settled = true; options.signal?.removeEventListener('abort', abort); shared.subscribers--; return true;
        };
        const abort = () => { if (!done()) return; reject(options.signal?.reason); if (!shared.subscribers) shared.controller.abort(options.signal?.reason); };
        options.signal?.addEventListener('abort', abort, { once: true });
        shared.promise.then(value => { if (done()) resolve(structuredClone(value)); }, error => { if (done()) reject(error); });
        if (options.signal?.aborted) abort();
      });
    },
    /** HTTP polls have a shorter budget than resumable provider work. The
     * bounded owner keeps completed pages/job progress for the next poll. */
    async poll(activity: FreshReplayActivity, options: { scope?: string; waitMs?: number } = {}): Promise<FreshReplayPreparation> {
      const work = service.prepare(activity, { scope: options.scope });
      const waitMs = Math.min(6000, Math.max(1, options.waitMs ?? 6000));
      let settled = false;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settled = true; deferredReads++;
          resolve({ ...base(activity), status: 'pending', reason: 'preparation_pending', retryAfterMs: 2000 });
        }, waitMs);
        work.then(value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); }, error => {
          if (settled) { backgroundFailures++; return; } settled = true; clearTimeout(timer); reject(error);
        });
      });
    },
    async validate(manifest: string, scope = 'public'): Promise<{ valid: boolean; reason?: string; expiresAt?: string }> {
      if (typeof manifest !== 'string' || manifest.length > 8192) return { valid: false, reason: 'invalid_manifest' };
      const parts = manifest.split('.');
      if (parts.length !== 2 || !parts.every(part => /^[a-zA-Z0-9_-]+$/.test(part))) return { valid: false, reason: 'invalid_manifest' };
      const actual = Buffer.from(parts[1], 'base64url'), expected = Buffer.from(signature(parts[0]), 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { valid: false, reason: 'invalid_manifest' };
      let claims: FreshReplayManifest;
      try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as FreshReplayManifest; }
      catch { return { valid: false, reason: 'invalid_manifest' }; }
      if (claims.version !== 1 || claims.audience !== 'kollens-replay-fresh-v1' || claims.scope !== scope
        || (claims.accountingQuality!==undefined||claims.estimatePolicy!==undefined)&&(claims.accountingQuality!=='estimated'||claims.estimatePolicy!=='omit_unknown_costs_v1')
        || !/^0x[0-9a-f]{40}$/.test(claims.wallet) || !/^0x[0-9a-f]{40}$/.test(claims.token)
        || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
        || claims.issuedAt > now() + 1000 || claims.expiresAt - claims.issuedAt > LEASE_MS || claims.expiresAt <= claims.issuedAt) return { valid: false, reason: 'invalid_manifest' };
      if (claims.expiresAt <= now()) return { valid: false, reason: 'expired_manifest' };
      if (!await validateRevision(claims)) return { valid: false, reason: 'accounting_changed' };
      return { valid: true, expiresAt: new Date(claims.expiresAt).toISOString() };
    },
    diagnostics() { trim(); return { preparedEntries: stored.size, preparedBytes: [...stored.values()].reduce((sum, value) => sum + value.bytes, 0), activeJobs: jobs.size, deferredReads, backgroundFailures, ownerTimeouts, ownerDeadlineMs, maxBytes, maxEntries }; },
  };
  return service;
}
export type FreshReplay = ReturnType<typeof createFreshReplay>;
