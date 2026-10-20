import {describe,expect,it,vi} from 'vitest';
import position from '../server/fixtures/closed-replay-position.json';
import evidence from '../server/fixtures/closed-replay-market.json';
import {createNodeReplayPreparation} from '../server/nodeReplayPreparation';
import {applyReplayMarketChart,prepareTradeReplayData,validReplayAccountingFinal} from './tradeReplayData';
import type {KolTokenActivity} from '../shared/kolTokenTrades';
import type {NodeMarketChart,NodeMarketReplaySamples,NodeMarketQuote} from '../shared/nodeMarket';

describe('captured Rell closed-position replay regression',()=>{
  it('renders all thirteen movements using genuine prices around the final sale with no provider request',async()=>{
    const activity=structuredClone(position.activity) as KolTokenActivity,now=Date.parse(position.frozenAt);
    const quote:NodeMarketQuote={tokenAddress:position.token,priceUsd:null,marketCapUsd:null,supply:activity.token.marketCapSupply,
      timestamp:null,blockNumber:null,blockHash:null,source:'node',marketId:null,stale:true,supplyEstimated:true,reason:'missing_quote'};
    const market={chart:vi.fn(async()=>structuredClone(evidence.chart) as NodeMarketChart),quote:vi.fn(async()=>quote),
      replaySamples:vi.fn(async()=>structuredClone(evidence.samples) as NodeMarketReplaySamples),requestHistoryWindow:vi.fn(async()=>({windowId:'unused'}))};
    const recovery={requestChart:vi.fn(async()=>({pending:true}))};
    const result=await createNodeReplayPreparation({market,recovery,now:()=>now}).prepare(activity);
    expect(result.status).toBe('ready');expect(result.window).toMatchObject({from:evidence.from,to:evidence.to});
    expect(result.chart).toMatchObject({source:'node',partialHistory:false,sparseHistory:true});
    expect(market.requestHistoryWindow).not.toHaveBeenCalled();expect(recovery.requestChart).not.toHaveBeenCalled();
    expect(result.chart!.candles).toHaveLength(3);
    expect(result.chart!.points.at(-1)?.timestamp).toBe('2026-10-20T12:20:24.000Z');
    expect(activity.replayAccounting!.history!.events).toHaveLength(13);
    const base=prepareTradeReplayData(activity,null,undefined,now);
    expect(base).not.toBeNull();
    const replay=applyReplayMarketChart(base!,result.chart!,now),final=validReplayAccountingFinal(replay,now);
    expect(replay.chart.points.at(-1)?.timestamp).toBe(evidence.to);
    expect(final?.reportedProfitUsd).toBe(Number(activity.realizedAccounting!.position!.estimatedProfitUsd));
    expect(final?.reportedRoi).toBe(Number(activity.replayAccounting!.final!.reportedRoi));
    expect(final?.reportedProfitUsd).toBeCloseTo(-121.34692221021792,8);
    expect(replay.inventory!.events).toHaveLength(13);
  });
});
