import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayMarketRequestResult } from './tradeReplayMarketRequest';
import type { TradeReplayData } from './tradeReplayData';
import { ReplayPreparationError, prepareReplayForShare, requirePreparedReplay } from './tradeReplayPreparation';
import { startReplaySession } from './tradeReplaySession';

const result = (preparationStatus: ReplayMarketRequestResult['preparationStatus'], retryAfterMs?: number): ReplayMarketRequestResult =>
  ({ data: {} as TradeReplayData, notice: null, preparationStatus, retryAfterMs });

afterEach(() => vi.useRealTimers());

describe('automatic replay preparation continuation', () => {
  it('waits for provider cooldown, retains the observed chart, and resumes without manual retry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const initial = {} as TradeReplayData;
    const pending = result('pending', 60_000), ready = result('ready');
    const prepare = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(ready);
    const onWait = vi.fn(), onResult = vi.fn();
    const promise = prepareReplayForShare(initial, new AbortController().signal, { prepare, onWait, onResult });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(prepare).toHaveBeenCalledOnce(); expect(onWait).toHaveBeenLastCalledWith(60_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBe(ready);
    expect(prepare.mock.calls[1][0]).toBe(pending.data);
    expect(onWait).toHaveBeenLastCalledWith(0); expect(onResult.mock.calls.map(call => call[0])).toEqual([pending, ready]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry terminal unavailable data or shorten a cooldown beyond the bounded wait', async () => {
    for (const status of ['unavailable', 'pending'] as const) {
      const prepare = vi.fn().mockResolvedValue(result(status, 300_000));
      await expect(prepareReplayForShare({} as TradeReplayData, new AbortController().signal, { prepare })).rejects.toMatchObject({ retryAfterMs: 300_000 });
      expect(prepare).toHaveBeenCalledOnce();
    }
  });

  it('cancels the automatic cooldown without another request or late progress', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), prepare = vi.fn().mockResolvedValue(result('pending', 60_000)), onWait = vi.fn();
    const promise = prepareReplayForShare({} as TradeReplayData, controller.signal, { prepare, onWait });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1); controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prepare).toHaveBeenCalledOnce(); expect(onWait).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated short pending results and reserves a whole request budget before resuming', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const prepare = vi.fn().mockResolvedValue(result('pending', 1000));
    const promise = prepareReplayForShare({} as TradeReplayData, new AbortController().signal, { prepare });
    const rejected = expect(promise).rejects.toBeInstanceOf(ReplayPreparationError);
    await vi.advanceTimersByTimeAsync(8000); await rejected;
    expect(prepare).toHaveBeenCalledTimes(8); expect(vi.getTimerCount()).toBe(0);
  });
});

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
