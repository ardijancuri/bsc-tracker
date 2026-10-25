import { describe, expect, it } from 'vitest';
import { nodeReplayFixture } from './nodeReplay.fixture';
import { prepareNodeReplay } from './nodeReplay';
import { applyReplayMarketChart, prepareTradeReplayData, validReplayAccountingFinal } from './tradeReplayData';
import ReplayCanvas from './tradeReplayCanvas';

function fixture(privateScope = false) {
  const value = nodeReplayFixture(Date.now(), privateScope), { activity } = value, raw = activity.replayAccounting!, history = raw.history!;
  const proof = history.balanceProof;
  activity.inventory = { version: 1, events: history.events.map(event => ({ ...event, blockNumber: event.blockNumber!,
    tokenAmount: event.tokenAmount, remainingTokenAmount: event.remainingTokenAmount, remainingCostBasisUsd: event.remainingCostBasisUsd,
    cumulativeRealizedProfitUsd: event.cumulativeRealizedProfitUsd, investedUsd: event.investedUsd, soldUsd: event.soldUsd })),
    coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: proof.blockNumber, blockHash: proof.blockHash,
      checkedAt: proof.checkedAt, balance: proof.balance } };
  raw.events = history.events.map(event => ({ ...event, blockNumber: event.blockNumber! })); delete raw.history;
  return value;
}
describe('fresh compact node replay browser adapter', () => {
  it('includes zero-quantity gas fees in the frozen ending without a buy/sell marker', async () => {
    const { activity, now, chartPoints } = fixture(), raw = activity.replayAccounting!, inventory = activity.inventory!;
    const timestamp = new Date(Date.parse(raw.events.at(-1)!.timestamp) + 60_000).toISOString();
    const fee = { ...raw.events.at(-1)!, id: 'proven-fee', txHash: '0x' + 'e'.repeat(64), blockNumber: '900', timestamp,
      kind: 'fee' as const, tradeId: undefined, cumulativeRealizedProfitUsd: '65.9', feesUsd: '4.5', feeInclusiveCostUsd: '102' };
    raw.events.push(fee); inventory.events.push({ ...inventory.events.at(-1)!, ...fee, tokenAmount: '0' });
    Object.assign(raw.final!, { cumulativeRealizedProfitUsd: '65.9', feesUsd: '4.5', feeInclusiveCostUsd: '102', reportedProfitUsd: '185.5', reportedRoi: String(185.5 / 102) });
    const data = prepareTradeReplayData(activity, null, undefined, now)!;
    expect(data.inventory!.events.at(-1)).toMatchObject({ kind: 'fee', tokenAmount: 0 });
    expect(data.trades).toHaveLength(2);
    const prepared = applyReplayMarketChart(data, { address: activity.token.address, period: 'replay', source: 'node', resolution: '1m',
      points: chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), candles: [], marketCapSupply: '10000',
      pending: false, stale: false, updatedAt: activity.generatedAt, currentQuote: { timestamp: activity.generatedAt, priceUsd: '4' } }, now);
    const context = new Proxy({}, { get: (_target, key) => key === 'measureText' ? (text: string) => ({ width: text.length * 12 })
      : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {} });
    const renderer = new ReplayCanvas({ getContext: () => context } as unknown as HTMLCanvasElement); await renderer.setData(prepared);
    expect(renderer.snapshot(1).totalPnl).toBe(185.5); expect(renderer.snapshot(1).totalRoi).toBeCloseTo(185.5 / 102);
    expect(renderer.markerPosition(2, 1)).toBeNull();
    inventory.events.at(-1)!.tokenAmount = '1'; expect(prepareNodeReplay(activity, now)).toBeUndefined();
  });
  it.each([false, true])('uses compact canonical events without pretending they are provider history, private=%s', privateScope => {
    const { activity, now, context } = fixture(privateScope), result = prepareNodeReplay(activity, now, context)!;
    expect(result.accounting.source).toBe('node'); expect(result.inventory.events).toHaveLength(3);
    expect(result.accounting.history).toBeUndefined(); expect(result.accounting.final!.reportedProfitUsd).toBe(186.5);
  });
  it('retains a nonzero raw unit with verified77-decimal token precision',()=>{
    const{activity,now}=fixture(),tiny=`0.${'0'.repeat(76)}1`;
    activity.inventory!.events[0].tokenAmount=tiny;
    const result=prepareNodeReplay(activity,now)!;
    expect(result.inventory.events[0].tokenAmount).toBe(1e-77);expect(result.inventory.events[0].tokenAmount).toBeGreaterThan(0);
  });
  it.each(['pair', 'hash', 'version', 'account'] as const)('rejects a changed contract identity: %s', change => {
    const { activity, now, context } = fixture(change === 'account');
    if (change === 'pair') activity.replayAccounting!.walletAddress = activity.token.address;
    if (change === 'hash') activity.inventory!.coverage.blockHash = '0x' + '0'.repeat(64);
    if (change === 'version') activity.inventory!.version = 2 as 1;
    expect(prepareNodeReplay(activity, now, change === 'account' ? { ...context!, accountId: 'other' } : context)).toBeUndefined();
  });
  it('retains dated unchanged proof only through server approval and stops using it after lease expiry', () => {
    const { activity, now } = fixture();
    // A stable position need not have its original balance observation rewritten
    // on every block. A signed preparation approves that dated exact object.
    activity.replayAccounting!.checkedAt = new Date(now - 20 * 60_000).toISOString();
    activity.inventory!.coverage.checkedAt = activity.replayAccounting!.checkedAt;
    const approval = { manifest: 'server-signed-and-validated', expiresAt: new Date(now + 15 * 60_000).toISOString(), preparedAt: new Date(now).toISOString(), validatedAt: new Date(now).toISOString() };
    const data = prepareTradeReplayData(activity, null, undefined, now, undefined, approval)!;
    expect(data.position.status).toBe('open'); expect(validReplayAccountingFinal(data, now + 10 * 60_000)!.reportedProfitUsd).toBe(186.5);
    expect(validReplayAccountingFinal(data, now + 15 * 60_000)).toBeNull();
    delete data.replayLease; expect(validReplayAccountingFinal(data, now)).toBeNull();
  });
});
