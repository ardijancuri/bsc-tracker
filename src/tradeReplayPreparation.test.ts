import { describe, expect, it, vi } from 'vitest';
import type { ReplayMarketRequestResult } from './tradeReplayMarketRequest';
import type { TradeReplayData } from './tradeReplayData';
import { ReplayPreparationError, requirePreparedReplay } from './tradeReplayPreparation';
import { startReplaySession } from './tradeReplaySession';

const result = (preparationStatus: ReplayMarketRequestResult['preparationStatus'], retryAfterMs?: number): ReplayMarketRequestResult =>
  ({ data: {} as TradeReplayData, notice: null, preparationStatus, retryAfterMs });

describe('complete replay export gate', () => {
  it.each(['pending', 'unavailable'] as const)('never starts the encoder or enables saving for %s data', async status => {
    const record = vi.fn(), onReady = vi.fn(), onFile = vi.fn(), onError = vi.fn(), onFinish = vi.fn();
    const session = startReplaySession({ prepare: async () => requirePreparedReplay(result(status, 60_000)),
      record, onReady, onFile, onError, onFinish });
    await session.completed;
    expect(record).not.toHaveBeenCalled(); expect(onReady).not.toHaveBeenCalled(); expect(onFile).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(ReplayPreparationError));
    expect(onError.mock.calls[0][0].retryAfterMs).toBe(60_000);
  });

  it('starts recording only after verified preparation finishes', async () => {
    let finish!: (value: ReplayMarketRequestResult) => void;
    const preparation = new Promise<ReplayMarketRequestResult>(resolve => { finish = resolve; });
    const file = {} as File, record = vi.fn().mockResolvedValue(file), onFile = vi.fn();
    const session = startReplaySession({ prepare: async () => requirePreparedReplay(await preparation), record, onFile });
    expect(record).not.toHaveBeenCalled();
    finish(result('ready')); await session.completed;
    expect(record).toHaveBeenCalledOnce(); expect(onFile).toHaveBeenCalledWith(file);
  });

  it('closing during preparation never produces a file or a late error', async () => {
    let finish!: (value: ReplayMarketRequestResult) => void;
    const preparation = new Promise<ReplayMarketRequestResult>(resolve => { finish = resolve; });
    const record = vi.fn(), onError = vi.fn(), onFinish = vi.fn();
    const session = startReplaySession({ prepare: async () => requirePreparedReplay(await preparation), record, onError, onFinish });
    session.dispose(); finish(result('pending')); await session.completed;
    expect(record).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled(); expect(onFinish).not.toHaveBeenCalled();
  });

  it('caps provider cooldowns and rejects missing readiness instead of saving a legacy fallback', () => {
    expect(new ReplayPreparationError(result('pending', Infinity)).retryAfterMs).toBe(0);
    expect(new ReplayPreparationError(result('pending', 900_000)).retryAfterMs).toBe(600_000);
    expect(() => requirePreparedReplay({ data: {} as TradeReplayData, notice: null } as ReplayMarketRequestResult)).toThrow(ReplayPreparationError);
  });
});
