import { describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/closed-replay-position.json' with { type: 'json' };
import type { ReplayMarketChart } from '../../shared/replayChart.js';
import { createFreshReplay, type FreshReplayActivity, type FreshReplayManifest } from './replay.js';
import { FreshChartError } from './charts.js';

const frozen = Date.parse(fixture.capturedAt), secret = 'a-local-test-secret-with-at-least-32-bytes';
function activity() {
  const value = structuredClone(fixture.activity) as FreshReplayActivity;
  value.__freshRevision = { scopeId: 'public-book', correctionEpoch: '2' };
  return value;
}
function chart(input: FreshReplayActivity): ReplayMarketChart {
  const events = input.replayAccounting!.history?.events ?? input.replayAccounting!.events;
  const from = Math.min(...events.map(event => Date.parse(event.timestamp)));
  const to = Math.max(...events.map(event => Date.parse(event.timestamp)));
  return { address: input.token.address, period: 'replay', candles: [], points: [
    { timestamp: new Date(from - 60_000).toISOString(), priceUsd: '0.00002' },
    { timestamp: new Date(to + 60_000).toISOString(), priceUsd: '0.00003' }],
    source: 'gmgn', resolution: '1m', pending: false, stale: false, updatedAt: new Date(frozen).toISOString() };
}

describe('fresh frozen replay preparation', () => {
  it('issues an explicitly estimated lease without promoting unknown original costs or ROI',async()=>{
    const value=activity(),id=value.accountingSnapshot!,a=value.replayAccounting!,final=a.final!;
    id.complete=false;id.reasons=['unknown_costs'];id.estimate={version:1,policy:'omit_unknown_costs_v1',basis:'recorded_facts',snapshotId:id.snapshotId,historyFingerprint:id.historyFingerprint,asOf:id.asOf,reasons:['unknown_costs'],realizedProfitUsd:final.reportedProfitUsd!,totalProfitUsd:final.reportedProfitUsd,knownCapitalUsd:final.feeInclusiveCostUsd!,knownRemainingCostUsd:'0',missingCostCount:null,missingFeeCount:null,missingProceedsCount:null};
    a.status='estimated';a.coverage.exactFinal=false;a.coverage.estimatedFinal=true;final.reportedRoi=null;
    const service=createFreshReplay({charts:{replayChart:async()=>chart(value)},secret,validateRevision:async()=>true,now:()=>frozen});
    const ready=await service.prepare(value);expect(ready.status).toBe('ready');expect(ready.activity!.accountingSnapshot!.complete).toBe(false);expect(ready.activity!.replayAccounting!.final!.reportedRoi).toBeNull();
    expect(JSON.parse(Buffer.from(ready.manifest!.split('.')[0],'base64url').toString())).toMatchObject({accountingQuality:'estimated',estimatePolicy:'omit_unknown_costs_v1'});expect((await service.validate(ready.manifest!)).valid).toBe(true);
    const bad=structuredClone(value);bad.replayAccounting!.coverage.balanceMatched=false;expect((await service.prepare(bad,{scope:'other'})).status).not.toBe('ready');
  });
  it('signs the exact historical permission and rechecks it for issued and remembered financial objects',async()=>{
    const value=activity(),digest='c'.repeat(64);value.__freshRevision!.historyPermissionDigest=digest;let active=digest;
    const service=createFreshReplay({charts:{replayChart:async()=>chart(value)},secret,validateRevision:async claims=>claims.historyPermissionDigest===active,now:()=>frozen});
    const ready=await service.prepare(value),claims=JSON.parse(Buffer.from(ready.manifest!.split('.')[0],'base64url').toString())as FreshReplayManifest;
    expect(ready.status).toBe('ready');expect(claims.historyPermissionDigest).toBe(digest);expect(await service.authorizedSaved(ready.snapshotId!)).not.toBeNull();
    active='d'.repeat(64);expect(await service.validate(ready.manifest!)).toMatchObject({valid:false,reason:'accounting_changed'});expect(await service.authorizedSaved(ready.snapshotId!)).toBeNull();
  });
  it.each(['historical_precision_unavailable','historical_settlement_unavailable','wallet_decode_gap'])('stops retrying for %s while retaining the recorded trades', async reason => {
    const value=activity(),replayChart=vi.fn(async()=>chart(value));
    value.accountingSnapshot!.complete=false;value.accountingSnapshot!.reasons=[reason];
    const service=createFreshReplay({charts:{replayChart},secret,validateRevision:async()=>true,now:()=>frozen});
    const result=await service.prepare(value);
    expect(result).toMatchObject({status:'unavailable',reason:'historical_evidence_unavailable',stages:{accounting:'unavailable'}});
    expect(result.activity!.trades).toEqual(value.trades);expect(result.retryAfterMs).toBeUndefined();expect(result.manifest).toBeUndefined();
    expect(replayChart).not.toHaveBeenCalled();
  });
  it('freezes one accounting object for modal/export and shares selected preparation', async () => {
    const value = activity(), replayChart = vi.fn(async () => chart(value)), validateRevision = vi.fn(async () => true);
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision, now: () => frozen });
    const [first, second] = await Promise.all([service.prepare(value), service.prepare(value)]);
    expect(first.status).toBe('ready'); expect(second).toEqual(first); expect(replayChart).toHaveBeenCalledOnce();
    expect(first.activity!.replayAccounting!.final).toEqual(value.replayAccounting!.final);
    expect(first.chart!.snapshotId).toBe(first.snapshotId); expect(first.chart!.windowId).toBe(first.window!.id);
    value.replayAccounting!.final!.reportedProfitUsd = '999';
    expect(service.saved(first.snapshotId!)!.replayAccounting!.final!.reportedProfitUsd).toBe(fixture.activity.replayAccounting.final.reportedProfitUsd);
    const unbound = service.prepare;
    const again = await unbound(value); expect(again).toEqual(first); expect(replayChart).toHaveBeenCalledOnce();
  });
  it('allows a dated frozen lease for 15 minutes and rejects signature, expiry and scope changes', async () => {
    let now = frozen; const value = activity();
    const service = createFreshReplay({ charts: { replayChart: async () => chart(value) }, secret, validateRevision: async () => true, now: () => now });
    const ready = await service.prepare(value), token = ready.manifest!;
    expect(await service.validate(token)).toMatchObject({ valid: true });
    now += 10 * 60_000;
    expect(await service.validate(token)).toMatchObject({ valid: true });
    expect(await service.validate(token + 'tampered')).toMatchObject({ valid: false, reason: 'invalid_manifest' });
    expect(await service.validate(token, 'account:other')).toMatchObject({ valid: false });
    now = frozen + 15 * 60_000;
    expect(await service.validate(token)).toMatchObject({ valid: false, reason: 'expired_manifest' });
    expect(service.saved(ready.snapshotId!)).toBeNull();
  });
  it('issues an exact 15-minute lease when the clock advances between reads', async () => {
    let clock = frozen;
    const value = activity(), replayChart = vi.fn(async () => chart(value));
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision: async () => true, now: () => clock++ });
    const ready = await service.prepare(value);
    expect(ready.status).toBe('ready');
    const claims = JSON.parse(Buffer.from(ready.manifest!.split('.')[0], 'base64url').toString('utf8')) as FreshReplayManifest;
    expect(claims.expiresAt - claims.issuedAt).toBe(15 * 60_000);
    expect(await service.validate(ready.manifest!)).toEqual({ valid: true, expiresAt: ready.expiresAt });
    expect(await service.prepare(value)).toEqual(ready);
    expect(replayChart).toHaveBeenCalledOnce();
  });
  it('checks corrections/membership on each approval without invalidating merely newer prices/trades', async () => {
    let epoch = '2'; const value = activity();
    const validateRevision = async (claims: FreshReplayManifest) => claims.correctionEpoch === epoch;
    const service = createFreshReplay({ charts: { replayChart: async () => chart(value) }, secret, validateRevision, now: () => frozen });
    const ready = await service.prepare(value);
    expect(await service.validate(ready.manifest!)).toMatchObject({ valid: true });
    epoch = '3'; expect(await service.validate(ready.manifest!)).toMatchObject({ valid: false, reason: 'accounting_changed' });
  });
  it('isolates subscriber cancellation while another modal still needs the work', async () => {
    const value = activity(); let finish!: (value: ReplayMarketChart) => void, signal!: AbortSignal;
    const replayChart = vi.fn((_token, options) => { signal = options.signal!; return new Promise<ReplayMarketChart>(resolve => { finish = resolve; }); });
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision: async () => true, now: () => frozen });
    const controller = new AbortController(), first = service.prepare(value, { signal: controller.signal });
    const rejected = expect(first).rejects.toThrow('Closed');
    const second = service.prepare(value); controller.abort(Error('Closed')); await rejected;
    expect(signal.aborted).toBe(false); finish(chart(value)); expect((await second).status).toBe('ready');
  });
  it('cancels queued chart work when its last subscriber leaves', async () => {
    const value = activity(); let signal!: AbortSignal;
    const replayChart = vi.fn((_token, options) => { signal = options.signal!; return new Promise<ReplayMarketChart>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); });
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision: async () => true, now: () => frozen });
    const controller = new AbortController(), first = service.prepare(value, { signal: controller.signal });
    const rejected = expect(first).rejects.toThrow('Closed'); controller.abort(Error('Closed')); await rejected;
    expect(signal.aborted).toBe(true); await vi.waitFor(() => expect(service.diagnostics().activeJobs).toBe(0));
  });
  it('gives unknown cost, missing coverage and cooldown distinct stage results', async () => {
    const value = activity(); value.accountingSnapshot!.complete = false; value.accountingSnapshot!.reasons = ['opening_cost_unknown']; value.replayAccounting!.status = 'unavailable';
    const replayChart = vi.fn(async () => chart(value));
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision: async () => true, now: () => frozen });
    expect(await service.prepare(value)).toMatchObject({ status: 'unavailable', reason: 'unknown_costs' }); expect(replayChart).not.toHaveBeenCalled();
    const cooldown = createFreshReplay({ charts: { replayChart: async () => { throw new FreshChartError('provider_cooldown', 60_000); } }, secret, validateRevision: async () => true, now: () => frozen });
    expect(await cooldown.prepare(activity())).toMatchObject({ status: 'pending', reason: 'provider_cooldown', retryAfterMs: 60_000, stages: { accounting: 'ready', chart: 'pending' } });
    const missing = createFreshReplay({ charts: { replayChart: async () => { throw new FreshChartError('chart_unavailable'); } }, secret, validateRevision: async () => true, now: () => frozen });
    expect(await missing.prepare(activity())).toMatchObject({ status: 'unavailable', reason: 'chart_unavailable' });
    const waiting = activity(); waiting.accountingSnapshot!.complete = false; waiting.accountingSnapshot!.reasons = ['balance_pending']; waiting.replayAccounting!.status = 'unavailable';
    expect(await service.prepare(waiting)).toMatchObject({ status: 'pending', reason: 'accounting_pending' });
    const quote = activity(); quote.replayAccounting!.status = 'pending'; quote.replayAccounting!.coverage.reason = 'quote_unavailable';
    expect(await service.prepare(quote)).toMatchObject({ status: 'pending', reason: 'stale_quote', stages: { accounting: 'ready', valuation: 'pending' } });
  });
  it('bounds immutable objects and separates private caches by account scope', async () => {
    const value = activity(), service = createFreshReplay({ charts: { replayChart: async () => chart(value) }, secret, validateRevision: async () => true, maxEntries: 2, now: () => frozen });
    service.remember(value, 'account:1'); expect(service.saved(value.accountingSnapshot!.snapshotId, 'account:2')).toBeNull();
    for (let index = 0; index < 4; index++) { const next = activity(); next.accountingSnapshot!.snapshotId += index; service.remember(next); }
    expect(service.diagnostics().preparedEntries).toBe(2); expect(service.diagnostics().preparedBytes).toBeLessThanOrEqual(service.diagnostics().maxBytes);
  });
  it('rejects oversized input before cloning or requesting candles', async () => {
    const value = activity(), replayChart = vi.fn(async () => chart(value));
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision: async () => true, now: () => frozen, maxBytes: 1000 });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const result = await service.prepare(value);
      expect(result).toMatchObject({ status: 'unavailable', reason: 'preparation_capacity' });
      expect(result.manifest).toBeUndefined(); expect(result.activity).toBeUndefined();
      expect(clone).not.toHaveBeenCalled(); expect(replayChart).not.toHaveBeenCalled();
      expect(service.diagnostics()).toMatchObject({ activeJobs: 0, preparedEntries: 0 });
    } finally { clone.mockRestore(); }
  });
  it('never returns a ready lease when the complete prepared object cannot be retained', async () => {
    const value = activity(), maxBytes = Buffer.byteLength(JSON.stringify(value)) + 100;
    const service = createFreshReplay({ charts: { replayChart: async () => chart(value) }, secret, validateRevision: async () => true, now: () => frozen, maxBytes });
    const result = await service.prepare(value);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'preparation_capacity' });
    expect(result.manifest).toBeUndefined(); expect(result.expiresAt).toBeUndefined();
    expect(service.diagnostics()).toMatchObject({ preparedEntries: 0, preparedBytes: 0 });
    expect(service.saved(value.accountingSnapshot!.snapshotId)).toBeNull();
  });
  it('computes a large event window without spreading timestamps as function arguments', async () => {
    const value = activity(), preparedChart = chart(value);
    const events = value.replayAccounting!.history?.events ?? value.replayAccounting!.events;
    const first = events[0].timestamp, last = events.at(-1)!.timestamp;
    const many = Array.from({ length: 150_000 }, (_, index) => ({ timestamp: index ? last : first }));
    const accounting = value.replayAccounting!, history = accounting.history;
    if (history) history.events = many as typeof history.events;
    else accounting.events = many as typeof accounting.events;
    const service = createFreshReplay({ charts: { replayChart: async () => preparedChart }, secret, validateRevision: async () => true, now: () => frozen });
    const result = await service.prepare(value);
    expect(result.status).toBe('ready'); expect(result.window).toMatchObject({ from: first, to: last });
    expect(service.diagnostics().preparedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
  it('bounds HTTP waiting while the same owner completes preparation for the next poll', async () => {
    const value=activity();let finish!:(value:ReplayMarketChart)=>void;
    const replayChart=vi.fn(()=>new Promise<ReplayMarketChart>(resolve=>{finish=resolve;}));
    const service=createFreshReplay({charts:{replayChart},secret,validateRevision:async()=>true,now:()=>frozen});
    expect(await service.poll(value,{waitMs:5})).toMatchObject({status:'pending',reason:'preparation_pending',retryAfterMs:2000});
    expect(service.diagnostics()).toMatchObject({activeJobs:1,deferredReads:1});
    finish(chart(value));const ready=await service.poll(value,{waitMs:50});expect(ready.status).toBe('ready');expect(replayChart).toHaveBeenCalledOnce();
  });
  it('observes late owner failure after an HTTP deadline without an unhandled rejection',async()=>{
    const value=activity();let fail!:(error:Error)=>void;
    const replayChart=vi.fn(()=>new Promise<ReplayMarketChart>((_resolve,reject)=>{fail=reject;}));
    const service=createFreshReplay({charts:{replayChart},secret,validateRevision:async()=>true,now:()=>frozen});
    await service.poll(value,{waitMs:5});fail(new Error('controlled late failure'));
    await vi.waitFor(()=>expect(service.diagnostics()).toMatchObject({activeJobs:0,backgroundFailures:1}));
  });
  it('ends the aggregate owner deadline even when chart or disk work never resolves', async () => {
    const value = activity(); let signal!: AbortSignal;
    const replayChart = vi.fn((_token, options) => { signal = options.signal!; return new Promise<ReplayMarketChart>(() => {}); });
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision: async () => true, now: () => frozen, ownerDeadlineMs: 20 });
    const [first, joined] = await Promise.all([service.prepare(value), service.prepare(value)]);
    expect(first).toMatchObject({ status: 'pending', reason: 'preparation_timeout', retryAfterMs: 5000 });
    expect(joined).toEqual(first); expect(replayChart).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(true);
    expect(service.diagnostics()).toMatchObject({ activeJobs: 0, ownerTimeouts: 1, preparedEntries: 0 });
  });
  it('never lets a timed-out late chart replace a subsequent ready owner', async () => {
    const value = activity(); let finish!: (value: ReplayMarketChart) => void;
    const replayChart = vi.fn().mockImplementationOnce(() => new Promise<ReplayMarketChart>(resolve => { finish = resolve; }))
      .mockImplementation(async () => chart(value));
    const service = createFreshReplay({ charts: { replayChart }, secret, validateRevision: async () => true, now: () => frozen, ownerDeadlineMs: 20 });
    expect((await service.prepare(value)).reason).toBe('preparation_timeout');
    const ready = await service.prepare(value); expect(ready.status).toBe('ready');
    const old = chart(value); old.points[0].priceUsd = '999'; finish(old);
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(await service.prepare(value)).toEqual(ready); expect(service.diagnostics()).toMatchObject({ activeJobs: 0, ownerTimeouts: 1, preparedEntries: 1 });
  });
  it('includes database approval in the deadline and refuses its late lease issuance', async () => {
    const value = activity(); let approve!: (value: boolean) => void;
    const validateRevision = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { approve = resolve; })).mockResolvedValue(true);
    const service = createFreshReplay({ charts: { replayChart: async () => chart(value) }, secret, validateRevision, now: () => frozen, ownerDeadlineMs: 20 });
    expect((await service.prepare(value)).reason).toBe('preparation_timeout');
    expect(service.diagnostics()).toMatchObject({ activeJobs: 0, preparedEntries: 0 });
    approve(true); await new Promise(resolve => setTimeout(resolve, 1));
    expect(service.diagnostics()).toMatchObject({ activeJobs: 0, preparedEntries: 0 });
    expect((await service.prepare(value)).status).toBe('ready');
  });
});
