import { describe, expect, it, vi } from 'vitest';
import { createNodeReplayPreparation, databaseChart } from '../server/nodeReplayPreparation.js';
import { nodeReplayFixture } from '../src/nodeReplay.fixture.js';
import { applyReplayMarketChart, prepareTradeReplayData } from '../src/tradeReplayData.js';
import type { NodeMarketChart, NodeMarketQuote, NodeMarketReplaySamples } from '../shared/nodeMarket.js';

function setup(now = Date.parse('2026-10-19T01:15:30Z')) {
  const fixture = nodeReplayFixture(now), token = fixture.activity.token.address;
  const quote: NodeMarketQuote = { tokenAddress: token, priceUsd: '999', marketCapUsd: '9990000', supply: '10000',
    timestamp: new Date(now).toISOString(), blockNumber: '1000', blockHash: '0x' + 'f'.repeat(64), source: 'node',
    marketId: 'test-market', stale: false, supplyEstimated: false, reason: null };
  const chart = vi.fn(async (_token: string, input: { from: string; to: string; intervalSeconds?: number }): Promise<NodeMarketChart> => {
    const step = input.intervalSeconds ?? 60, first = Date.parse(input.from), last = Date.parse(input.to);
    const bars = [];
    for (let time = first; time <= last; time += step * 1000) {
      const timestamp = new Date(time).toISOString(), end = new Date(Math.min(time + step * 1000 - 1, last)).toISOString();
      bars.push({ timestamp, firstObservationAt: timestamp, lastObservationAt: end, open: '1', high: '4', low: '1', close: '4',
        volumeUsd: '10', intervalSeconds: step, source: 'node' as const, supply: '10000', supplyEstimated: false });
    }
    return { tokenAddress: token, from: input.from, to: input.to, intervalSeconds: step, bars,
      source: 'node', sparse: false, complete: true, coverage: [{ from: input.from, to: input.to, source: 'node' }], reason: null };
  });
  const market = { chart, quote: vi.fn(async () => quote), requestRefresh: vi.fn(async () => {}),
    requestHistoryWindow: vi.fn(async (..._args: unknown[]) => ({ windowId: 'queued' })) };
  return { ...fixture, quote, market, service: createNodeReplayPreparation({ market, now: () => now }) };
}

function sampledSetup(imported=true) {
  const fixture=setup(),{activity,market,now}=fixture,normal=market.chart.getMockImplementation()!,join=now-300_000;
  const first=Date.parse(activity.replayAccounting!.history!.events[0].timestamp);
  market.chart.mockImplementation(async(token,input)=>{
    const result=await normal(token,input);
    return {...result,source:imported?'imported':'node',complete:false,sparse:true,
      coverage:imported?[{from:input.from,to:new Date(join).toISOString(),source:'imported'}]:[],
      bars:imported?result.bars.filter(bar=>Date.parse(bar.lastObservationAt!)<=join).map(bar=>({...bar,source:'imported' as const})):[]};
  });
  const observations:NodeMarketReplaySamples['observations']=[];
  for(let time=(imported?join:first)-30_000;time<=now;time+=30_000)observations.push({timestamp:new Date(time).toISOString(),priceUsd:'3.25',
    supply:'10000',supplyEstimated:false,blockNumber:String(1000+observations.length),blockHash:`0x${'f'.repeat(64)}`,marketId:'authentic-market',kind:'state'});
  const replaySamples=vi.fn(async(token:string,input:{from:string;to:string}):Promise<NodeMarketReplaySamples>=>({tokenAddress:token,...input,
    observations:observations.filter(row=>Date.parse(row.timestamp)<=Date.parse(input.to)),truncated:false,
    coverage:[{from:input.from,to:input.to,source:'node'}]}));
  const sampledMarket={...market,replaySamples};
  return {...fixture,market:sampledMarket,observations,join,first,service:createNodeReplayPreparation({market:sampledMarket,now:()=>now})};
}
describe('database-only replay preparation', () => {
  it('waits for native payment evidence before treating temporary unknown costs as an export failure', async () => {
    const {service,activity,market}=setup();
    activity.accountingSnapshot!.complete=false;
    activity.accountingSnapshot!.reasons=['purchase_cost_unknown','native_trace_required'];
    activity.replayAccounting!.status='unavailable';
    const result=await service.prepare(activity);
    expect(result.status).toBe('pending'); expect(result.reason).toBe('accounting_pending');
    expect(result.stages.accounting).toBe('pending'); expect(market.chart).not.toHaveBeenCalled();
  });
  it('retains historical supply changes instead of scaling every point by current supply', async () => {
    const { activity, market, quote } = setup();
    const history = await market.chart(activity.token.address, { from: activity.replayAccounting!.history!.events[0].timestamp,
      to: activity.generatedAt, intervalSeconds: 60 });
    history.bars[0].supply = '20000';
    const chart = databaseChart(history, quote, '24h');
    expect(chart.points[0].marketCapUsd).toBe('20000');
    expect(chart.marketCapSupply).toBe('10000'); expect(chart.marketCapEstimated).toBe(false);
    history.bars[0].supply = null;
    expect(databaseChart(history, quote, '24h').marketCapEstimated).toBe(true);
  });
  it('coalesces selected work, freezes the original valuation and binds its window', async () => {
    const { service, activity, market } = setup();
    const [a, b] = await Promise.all([service.prepare(activity), service.prepare(structuredClone(activity))]);
    expect(a).toBe(b); expect(a.status).toBe('ready'); expect(market.chart).toHaveBeenCalledOnce();
    expect(a.chart?.currentQuote?.priceUsd).toBe('4'); expect(a.chart?.snapshotId).toBe(activity.accountingSnapshot!.snapshotId);
    expect(a.chart?.windowId).toBe(a.window?.id);
    expect(market.chart.mock.calls[0][1].from).toBe(activity.replayAccounting!.history!.events[0].timestamp);
    expect(market.requestHistoryWindow).not.toHaveBeenCalled();
  });
  it('uses daily history and a genuine minute tail for long open positions', async () => {
    const { service, activity, market } = setup();
    activity.replayAccounting!.history!.events[0].timestamp = '2026-04-15T00:00:30Z';
    const result = await service.prepare(activity);
    expect(result.status).toBe('ready'); expect(result.window?.from).toBe('2026-04-15T00:00:30.000Z');
    expect(market.chart.mock.calls.map(call => call[1].intervalSeconds)).toEqual([14400, 60]);
    expect(result.chart?.recentResolution).toBe('1m');
  });
  it('bridges only the current fractional minute with its genuine frozen quote', async () => {
    const { service, activity, market } = setup();
    const normal = market.chart.getMockImplementation()!;
    market.chart.mockImplementation(async (token, input) => {
      const result = await normal(token, input);
      result.complete = Date.parse(input.to) % 60_000 === 0;
      return result;
    });
    const result = await service.prepare(activity);
    expect(result.status).toBe('ready');
    expect(result.chart?.currentQuote).toEqual({ timestamp: activity.replayAccounting!.final!.timestamp, priceUsd: '4' });
    expect(market.chart.mock.calls.at(-1)![1].to).toBe('2026-10-19T01:15:00.000Z');
    expect(result.chart?.points.at(-1)?.timestamp).toBe('2026-10-19T01:15:00.000Z');
    expect(result.window?.to).toBe(activity.replayAccounting!.final!.timestamp);
  });
  it('renders a closed intraminute ending even when no current quote exists', async () => {
    const { service, activity, market, now } = setup();
    const raw = activity.replayAccounting!, last = raw.history!.events.at(-1)!;
    last.remainingTokenAmount = '0'; last.remainingCostBasisUsd = '0'; last.tokenAmount = '60';
    activity.realizedAccounting!.position!.status = 'closed'; raw.history!.balanceProof.balance = '0';
    Object.assign(raw.final!, { remainingTokenAmount: '0', remainingCostBasisUsd: '0', reportedProfitUsd: '26.5', reportedRoi: String(26.5 / 101), priceUsd: null });
    market.quote.mockResolvedValue({ ...await market.quote(), priceUsd: null, timestamp: null, stale: true, reason: 'missing_quote' });
    const result = await service.prepare(activity);
    expect(result.status).toBe('ready'); expect(result.chart?.stale).toBe(false);
    const rendered = applyReplayMarketChart(prepareTradeReplayData(result.activity!, null, undefined, now)!, result.chart!, now);
    expect(rendered.chart.points.length).toBeGreaterThan(1);
    expect(rendered.chart.points.at(-1)?.timestamp).toBe(last.timestamp);
  });
  it.each(['balance_unreconciled', 'purchase_cost_unknown', 'unsupported_decoder'])('does not mask %s behind generic loading', async reason => {
    const { service, activity } = setup();
    activity.accountingSnapshot!.complete = false; activity.accountingSnapshot!.reasons = [reason]; activity.replayAccounting!.status = 'pending';
    const result = await service.prepare(activity);
    expect(result.reason).toBe(reason === 'balance_unreconciled' ? 'accounting_mismatch' : reason === 'purchase_cost_unknown' ? 'unknown_costs' : 'unsupported_decoder');
  });
  it('reports a resumable historical import cooldown with its retry time', async () => {
    const { service, activity } = setup();
    activity.accountingSnapshot!.complete = false; activity.accountingSnapshot!.reasons = ['historical_baseline_required', 'historical_import_cooldown'];
    activity.replayAccounting!.status = 'pending'; activity.replayAccounting!.retryAfterMs = 45_000;
    expect(await service.prepare(activity)).toMatchObject({ status: 'pending', reason: 'provider_cooldown', retryAfterMs: 45_000 });
  });
  it('keeps a closed transfer pending when the genuine price series ends before it', async () => {
    const { service, activity, market } = setup();
    const raw = activity.replayAccounting!, last = raw.history!.events.at(-1)!;
    last.remainingTokenAmount = '0'; last.remainingCostBasisUsd = '0';
    activity.realizedAccounting!.position!.status = 'closed'; raw.history!.balanceProof.balance = '0';
    Object.assign(raw.final!, { remainingTokenAmount: '0', remainingCostBasisUsd: '0', priceUsd: null });
    const end = Date.parse(last.timestamp) - 20_000;
    market.chart.mockImplementation(async (_token, input) => ({ tokenAddress: activity.token.address, from: input.from, to: input.to,
      intervalSeconds: 60, source: 'node', sparse: true, complete: true, coverage: [], reason: null,
      bars: [{ timestamp: input.from, firstObservationAt: input.from, lastObservationAt: new Date(end).toISOString(),
        open: '1', high: '4', low: '1', close: '4', volumeUsd: '10', intervalSeconds: 60, source: 'node', supply: '10000', supplyEstimated: false }] }));
    const [result, joined] = await Promise.all([service.prepare(activity), service.prepare(structuredClone(activity))]);
    expect(result.status).toBe('pending'); expect(result.reason).toBe('chart_coverage');
    expect(joined).toBe(result);
    expect(market.requestHistoryWindow).toHaveBeenCalledOnce();
    expect(market.requestHistoryWindow).toHaveBeenCalledWith(activity.token.address, result.window!.from, last.timestamp, {
      snapshotId: activity.accountingSnapshot!.snapshotId, windowId: result.window!.id, priority: 10,
    });
  });
  it('prioritizes the selected quote when its frozen open-position mark is stale', async () => {
    const { service, activity, market, now } = setup();
    for (const event of activity.replayAccounting!.history!.events) event.timestamp = new Date(Date.parse(event.timestamp) - 300_000).toISOString();
    activity.replayAccounting!.final!.timestamp = new Date(now - 180_001).toISOString();
    const result = await service.prepare(activity);
    expect(result).toMatchObject({ status: 'pending', reason: 'stale_quote' });
    expect(market.requestRefresh).toHaveBeenCalledWith(activity.token.address, { priority: 10 });
    expect(market.requestHistoryWindow).not.toHaveBeenCalled();
  });
  it('refreshes a recent frozen quote that precedes a later included sale instead of reporting contradictory accounting',async()=>{
    const {service,activity,market}=setup();
    const last=activity.replayAccounting!.history!.events.at(-1)!;
    activity.replayAccounting!.final!.timestamp=new Date(Date.parse(last.timestamp)-1000).toISOString();
    const result=await service.prepare(activity);
    expect(result).toMatchObject({status:'pending',reason:'stale_quote',stages:{accounting:'ready',valuation:'pending'}});
    expect(market.requestRefresh).toHaveBeenCalledWith(activity.token.address,{priority:10});
    expect(market.chart).not.toHaveBeenCalled();
  });
  it('identifies a valuation-only pending snapshot without weakening cost or quantity checks',async()=>{
    const {service,activity,market}=setup();
    activity.accountingSnapshot!.complete=false;activity.accountingSnapshot!.reasons=['quote_unavailable'];
    activity.replayAccounting!.status='pending';activity.replayAccounting!.final=null;
    activity.replayAccounting!.coverage.reason='quote_unavailable';
    expect(await service.prepare(activity)).toMatchObject({status:'pending',reason:'stale_quote',stages:{accounting:'ready',valuation:'pending'}});
    expect(market.requestRefresh).toHaveBeenCalledWith(activity.token.address,{priority:10});
    activity.accountingSnapshot!.reasons.push('purchase_cost_unknown');
    expect(await service.prepare(activity)).toMatchObject({status:'pending',reason:'unknown_costs'});
  });
  it('does not authorize a long flat ending with an old bar and a daily interval', async () => {
    const { activity, market, now } = setup();
    activity.replayAccounting!.history!.events[0].timestamp = '2026-04-15T00:00:00Z';
    const normal = market.chart.getMockImplementation()!;
    market.chart.mockImplementation(async (token, input) => { const result = await normal(token, input);
      if (input.intervalSeconds === 60) result.bars = result.bars.filter(bar => Date.parse(bar.timestamp) < now - 3600_000);
      return result; });
    const result = await createNodeReplayPreparation({ market, now: () => now }).prepare(activity);
    expect(result.status).toBe('pending'); expect(result.reason).toBe('chart_coverage');
  });
  it('joins a covered imported prefix to genuine sampled node prices without manufacturing candles',async()=>{
    const {service,activity,market}=sampledSetup();
    const original=await market.chart(activity.token.address,{from:activity.replayAccounting!.history!.events[0].timestamp,to:activity.generatedAt,intervalSeconds:60});
    const result=await service.prepare(activity);
    expect(result).toMatchObject({status:'ready',chart:{source:'mixed',sparseHistory:true,partialHistory:false,recentSource:'node'}});
    expect(result.chart!.points.at(-1)!.priceUsd).toBe('3.25');
    expect(result.chart!.candles).toHaveLength(original.bars.length);
    expect(result.chart!.candles.every(candle=>candle.volume===10)).toBe(true);
    expect(databaseChart(original,await market.quote(),'24h').partialHistory,'normal candle completeness remains unchanged').toBe(true);
    expect(market.requestHistoryWindow).not.toHaveBeenCalled();
  });
  it('uses independently sampled node prices with full raw coverage even when there are no OHLC candles',async()=>{
    const {service,activity}=sampledSetup(false),result=await service.prepare(activity);
    expect(result).toMatchObject({status:'ready',chart:{source:'node',sparseHistory:true,partialHistory:false}});
    expect(result.chart!.candles).toEqual([]);expect(result.chart!.points.length).toBeGreaterThan(2);
  });
  it.each(['truncated','raw_gap','imported_only','price_gap','wrong_token'])('keeps %s sampled evidence pending',async(reason)=>{
    const {activity,service,market,join}=sampledSetup(),normal=market.replaySamples.getMockImplementation()!;
    market.replaySamples.mockImplementation(async(token,input)=>{
      const result=await normal(token,input);
      if(reason==='truncated')result.truncated=true;
      if(reason==='raw_gap')result.coverage=[{from:input.from,to:new Date(join+30000).toISOString(),source:'node'},
        {from:new Date(join+34000).toISOString(),to:input.to,source:'node'}];
      if(reason==='imported_only')result.coverage=result.coverage.map(range=>({...range,source:'imported'}));
      if(reason==='price_gap')result.observations=result.observations.filter(row=>Date.parse(row.timestamp)<=join||Date.parse(row.timestamp)>=join+181000);
      if(reason==='wrong_token')result.tokenAddress=`0x${'9'.repeat(40)}`;
      return result;
    });
    expect(await service.prepare(activity)).toMatchObject({status:'pending',reason:'chart_coverage'});
  });
  it('rejects a 490-second unobserved interval despite complete raw capture and a genuine closed ending price',async()=>{
    const {activity,service,market,first,now}=sampledSetup(false),raw=activity.replayAccounting!,last=raw.history!.events.at(-1)!;
    activity.realizedAccounting!.position!.status='closed';
    last.remainingTokenAmount='0';raw.history!.balanceProof.balance='0';
    Object.assign(raw.final!,{remainingTokenAmount:'0',remainingCostBasisUsd:'0',priceUsd:null});
    const normal=market.replaySamples.getMockImplementation()!;
    market.replaySamples.mockImplementation(async(token,input)=>{
      const result=await normal(token,input),base=result.observations[0];
      result.observations=[first,first+490000,now-180000].map(time=>({...base,timestamp:new Date(time).toISOString()}));return result;
    });
    expect(await service.prepare(activity)).toMatchObject({status:'pending',reason:'chart_coverage'});
  });
  it('requires a genuine price at a closed ending rather than extending the most recent sample',async()=>{
    const {activity,service,market}=sampledSetup(false),raw=activity.replayAccounting!,last=raw.history!.events.at(-1)!;
    activity.realizedAccounting!.position!.status='closed';last.remainingTokenAmount='0';raw.history!.balanceProof.balance='0';
    Object.assign(raw.final!,{remainingTokenAmount:'0',remainingCostBasisUsd:'0',priceUsd:null});
    const normal=market.replaySamples.getMockImplementation()!;
    market.replaySamples.mockImplementation(async(token,input)=>{
      const result=await normal(token,input);result.observations=result.observations.filter(row=>Date.parse(row.timestamp)<Date.parse(input.to));return result;
    });
    expect(await service.prepare(activity)).toMatchObject({status:'pending',reason:'chart_coverage'});
  });
  it.each(['covered','starts_late','ends_early','unfinished'])('validates the complete %s imported island around a sparse price gap',async(variant)=>{
    const {activity,service,market,join}=sampledSetup(),normalSamples=market.replaySamples.getMockImplementation()!,normalChart=market.chart.getMockImplementation()!;
    const left=join+30000,right=join+270000;
    market.replaySamples.mockImplementation(async(token,input)=>{
      const result=await normalSamples(token,input);
      result.observations=result.observations.filter(row=>Date.parse(row.timestamp)<=left||Date.parse(row.timestamp)>=right);return result;
    });
    market.chart.mockImplementation(async(token,input)=>{
      const result=await normalChart(token,input);
      // The service returns completed retrievals only. An unfinished provider
      // page therefore contributes no range to this proof.
      if(variant!=='unfinished')result.coverage.push({from:new Date(left+(variant==='starts_late'?1:0)).toISOString(),
        to:new Date(right-(variant==='ends_early'?1:0)).toISOString(),source:'imported'});
      return result;
    });
    const result=await service.prepare(activity);
    if(variant==='covered') {
      expect(result).toMatchObject({status:'ready',chart:{source:'mixed',recentSource:'mixed',sparseHistory:true}});
      const points=result.chart!.points.map(point=>Date.parse(point.timestamp));
      expect(points.some((time,index)=>index>0&&time-points[index-1]===240000),'the sparse interval keeps its real endpoints').toBe(true);
    } else expect(result).toMatchObject({status:'pending',reason:'chart_coverage'});
  });
  it.each([true,false])('uses a genuine interior minute candle only inside verified imported coverage: %s',async(covered)=>{
    const {activity,service,market,join}=sampledSetup(),normalSamples=market.replaySamples.getMockImplementation()!,normalChart=market.chart.getMockImplementation()!;
    market.replaySamples.mockImplementation(async(token,input)=>{
      const result=await normalSamples(token,input);result.observations=result.observations.filter(row=>Date.parse(row.timestamp)<=join+30000||Date.parse(row.timestamp)>=join+270000);return result;
    });
    market.chart.mockImplementation(async(token,input)=>{
      const result=await normalChart(token,input),timestamp=new Date(join+120000).toISOString();
      result.bars.push({timestamp,firstObservationAt:timestamp,lastObservationAt:new Date(join+180000).toISOString(),
        open:'2.1',high:'2.2',low:'2.1',close:'2.2',intervalSeconds:60,source:'imported',volumeUsd:'12',supply:null,supplyEstimated:true});
      if(covered)result.coverage.push({from:new Date(join+60000).toISOString(),to:new Date(join+240000).toISOString(),source:'imported'});return result;
    });
    const result=await service.prepare(activity);
    expect(result.status).toBe(covered?'ready':'pending');
    if(covered)expect(result.chart!.points.find(point=>point.timestamp===new Date(join+120000).toISOString())?.priceUsd).toBe('2.1');
    else expect(result.reason).toBe('chart_coverage');
  });
  it('keeps a closed ending unavailable when a covered imported island has no actual ending price',async()=>{
    const {activity,service,market,join}=sampledSetup(),raw=activity.replayAccounting!,normalSamples=market.replaySamples.getMockImplementation()!,normalChart=market.chart.getMockImplementation()!;
    activity.realizedAccounting!.position!.status='closed';raw.history!.events.at(-1)!.remainingTokenAmount='0';raw.history!.balanceProof.balance='0';
    Object.assign(raw.final!,{remainingTokenAmount:'0',remainingCostBasisUsd:'0',priceUsd:null});
    market.replaySamples.mockImplementation(async(token,input)=>{
      const result=await normalSamples(token,input);result.observations=result.observations.filter(row=>Date.parse(row.timestamp)<=join+30000);return result;
    });
    market.chart.mockImplementation(async(token,input)=>{
      const result=await normalChart(token,input);result.coverage.push({from:new Date(join+30000).toISOString(),to:input.to,source:'imported'});return result;
    });
    expect(await service.prepare(activity)).toMatchObject({status:'pending',reason:'chart_coverage'});
  });
});
