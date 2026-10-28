import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeReplayFixture } from './nodeReplay.fixture';
import { prepareTradeReplayData, validReplayAccountingFinal } from './tradeReplayData';
import { replayMarketData, validatePreparedTradeReplay } from './replayPreparationRequest';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup(privateScope = false) {
  const fixture = nodeReplayFixture(Date.now(), privateScope), { activity, now, chartPoints, context } = fixture;
  const chart = { address: activity.token.address, period: 'replay', source: 'gmgn', resolution: '1m', marketCapSupply: '10000',
    points: chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), candles: [], pending: false, stale: false,
    snapshotId: activity.accountingSnapshot!.snapshotId, windowId: 'e'.repeat(64), currentQuote: { timestamp: activity.generatedAt, priceUsd: '4' } };
  const expiresAt = new Date(now + 15 * 60_000).toISOString();
  const ready = { version: 2, status: 'ready', activity, snapshotId: chart.snapshotId,
    window: { id: chart.windowId, from: chartPoints[0].timestamp, to: activity.generatedAt }, chart, manifest: 'signed.manifest', expiresAt };
  return { ...fixture, data: prepareTradeReplayData(activity, null, undefined, now, context)!, ready, expiresAt };
}

describe('fresh server-approved GMGN replay contract', () => {
  it('accepts only an explicitly estimated signed cost-fallback snapshot through the full share request',async()=>{
    const{ready,expiresAt,now}=setup(),a=ready.activity,raw=a.replayAccounting!,h=raw.history!,proof=h.balanceProof,id=a.accountingSnapshot!,final=raw.final!;
    raw.events=h.events.map(e=>({...e,blockNumber:e.blockNumber!}));a.inventory={version:1,events:h.events.map(e=>({...e,blockNumber:e.blockNumber!})),coverage:{complete:true,reconciled:true,fromBlock:'100',toBlock:proof.blockNumber,blockHash:proof.blockHash,checkedAt:proof.checkedAt,balance:proof.balance}};delete raw.history;
    id.complete=false;id.reasons=['unknown_costs'];id.estimate={version:1,policy:'omit_unknown_costs_v1',basis:'recorded_facts',snapshotId:id.snapshotId,historyFingerprint:id.historyFingerprint,asOf:id.asOf,reasons:['unknown_costs'],realizedProfitUsd:final.cumulativeRealizedProfitUsd!,totalProfitUsd:final.reportedProfitUsd,knownCapitalUsd:final.feeInclusiveCostUsd!,knownRemainingCostUsd:final.remainingCostBasisUsd!,missingCostCount:null,missingFeeCount:null,missingProceedsCount:null};raw.status='estimated';raw.coverage.exactFinal=false;raw.coverage.estimatedFinal=true;final.reportedRoi=null;
    vi.useFakeTimers();vi.setSystemTime(now);const fetcher=vi.fn().mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(Response.json({valid:true,expiresAt}));vi.stubGlobal('fetch',fetcher);
    const data=prepareTradeReplayData(a,null,undefined,now)!,result=await replayMarketData(data,new AbortController().signal);
    expect(result.preparationStatus).toBe('ready');expect(result.data.accountingSnapshot!.complete).toBe(false);expect(result.data.replayAccounting!.coverage.exactFinal).toBe(false);expect(result.data.replayAccounting!.final!.reportedRoi).toBeNull();expect(result.accountingNotice).toContain('missing costs excluded');expect(validReplayAccountingFinal(result.data,now)).not.toBeNull();
  });
  it('accepts GMGN candles only with server-approved manifest and binds the frozen financial object', async () => {
    const { data, ready, expiresAt, now } = setup(); vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(Response.json({ valid: true, expiresAt }));
    vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(data, new AbortController().signal);
    expect(result.preparationStatus).toBe('ready'); expect(result.data.chart.source).toBe('GMGN historical samples');
    expect(result.data.replayLease).toMatchObject({ manifest: ready.manifest, expiresAt });
    expect(validReplayAccountingFinal(result.data, now)!.reportedProfitUsd).toBe(186.5);
    const [url, options] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/replays/validate'); expect(JSON.parse(options.body as string)).toEqual({ manifest: ready.manifest });
  });
  it('rejects missing, invalid and expired leases without enabling the encoder', async () => {
    const { data, ready, expiresAt, now } = setup(); vi.useFakeTimers(); vi.setSystemTime(now);
    for (const failure of ['missing', 'denied', 'expired'] as const) {
      const response = structuredClone(ready);
      if (failure === 'missing') { delete (response as Partial<typeof response>).manifest; delete (response as Partial<typeof response>).expiresAt; }
      if (failure === 'expired') response.expiresAt = new Date(now - 1).toISOString();
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(Response.json({ valid: false, expiresAt }));
      vi.stubGlobal('fetch', fetcher);
      await expect(replayMarketData(data, new AbortController().signal), failure).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(failure === 'denied' ? 2 : 1);
    }
  });
  it('keeps the same dated ending for a valid 15-minute lease without repricing it', async () => {
    const { data, ready, expiresAt, now } = setup(); vi.useFakeTimers(); vi.setSystemTime(now + 10 * 60_000);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(Response.json({ valid: true, expiresAt })); vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(data, new AbortController().signal);
    expect(validReplayAccountingFinal(result.data, Date.now())!.reportedProfitUsd).toBe(186.5);
    expect(result.data.replayAccounting!.final!.timestamp).toBe(ready.activity.replayAccounting!.final!.timestamp);
    vi.setSystemTime(now + 15 * 60_000);
    await expect(validatePreparedTradeReplay(result.data)).rejects.toThrow('expired');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reauthorizes the private account on each export check and rejects corrected accounting', async () => {
    const { data, ready, expiresAt, now, context } = setup(true); vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(Response.json({ valid: true, expiresAt }))
      .mockResolvedValueOnce(Response.json({ valid: false, reason: 'accounting_changed' })); vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(data, new AbortController().signal);
    await expect(validatePreparedTradeReplay(result.data)).rejects.toThrow('changed');
    const options = fetcher.mock.calls[2][1] as RequestInit;
    expect(options.headers).toMatchObject({ 'X-Watchlist-Owner': context!.accountId });
    expect(options.body).not.toContain(context!.accountId);
  });
  it('rebinds a stale frozen quote instead of repeatedly polling the same outdated valuation',async()=>{
    const {data,ready,now}=setup();vi.useFakeTimers();vi.setSystemTime(now);
    const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({...ready,status:'pending',reason:'stale_quote',manifest:undefined,expiresAt:undefined,chart:undefined,retryAfterMs:2000}));vi.stubGlobal('fetch',fetcher);
    const result=await replayMarketData(data,new AbortController().signal);
    expect(result.data.accountingSnapshot).toBeUndefined();expect(result.data.replayAccounting?.final).toBeNull();
    await replayMarketData(result.data,new AbortController().signal);
    expect(fetcher.mock.calls[1][0]).toMatch(/\/replay-preparation$/);
  });
});
