import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayMarketRequestResult } from './replayPreparationRequest';
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
      await expect(prepareReplayForShare({} as TradeReplayData, new AbortController().signal, { prepare })).rejects.toMatchObject({
        retryAfterMs: status === 'pending' ? 300_000 : 0, retryable: status === 'pending',
      });
      expect(prepare).toHaveBeenCalledOnce();
    }
  });

  it('keeps joining recovery beyond thirty polls while the total deadline permits it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const pending = result('pending', 2000), ready = result('ready');
    const prepare = vi.fn().mockResolvedValue(pending);
    for (let index = 0; index < 35; index++) prepare.mockResolvedValueOnce(pending);
    prepare.mockResolvedValueOnce(ready);
    const promise = prepareReplayForShare({} as TradeReplayData, new AbortController().signal, { prepare });
    await vi.advanceTimersByTimeAsync(69_999);
    expect(prepare).toHaveBeenCalledTimes(35);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBe(ready); expect(prepare).toHaveBeenCalledTimes(36);
    expect(vi.getTimerCount()).toBe(0);
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
    await vi.advanceTimersByTimeAsync(172_000); await rejected;
    expect(prepare).toHaveBeenCalledTimes(173); expect(vi.getTimerCount()).toBe(0);
  });

  it('automatically resumes a timed-out request before enabling the encoder', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const pending = { ...result('pending', 2000), blockingReason: 'preparation_pending' as const };
    const ready = result('ready');
    const prepare = vi.fn().mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(pending), 8000)))
      .mockResolvedValueOnce(ready);
    const record = vi.fn().mockResolvedValue({} as File), onError = vi.fn(), onWait = vi.fn();
    const session = startReplaySession({
      prepare: signal => prepareReplayForShare({} as TradeReplayData, signal, { prepare, onWait }), record, onError,
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(prepare).toHaveBeenCalledOnce(); expect(record).not.toHaveBeenCalled();
    expect(onWait).toHaveBeenLastCalledWith(10_000); expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await session.completed;
    expect(prepare.mock.calls[1][0]).toBe(pending.data);
    expect(record).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated eight-second transport deadlines with a readable retryable error', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const pending = { ...result('pending', 2000), blockingReason: 'preparation_pending' as const };
    const prepare = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(pending), 8000)));
    const promise = prepareReplayForShare({} as TradeReplayData, new AbortController().signal, { prepare });
    const rejected = expect(promise).rejects.toMatchObject({
      name: 'ReplayPreparationError', retryable: true, retryAfterMs: 2000,
      message: 'Replay preparation is taking longer than usual. Retry shortly.',
    });
    await vi.advanceTimersByTimeAsync(178_000); await rejected;
    expect(prepare).toHaveBeenCalledTimes(18); expect(vi.getTimerCount()).toBe(0);
  });

  it('stops as soon as completed historical recovery reports a terminal chart gap', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const unavailable = { ...result('unavailable', 2000), blockingReason: 'chart_unavailable' as const };
    const prepare = vi.fn().mockResolvedValueOnce(result('pending', 45_000)).mockResolvedValue(unavailable);
    const onWait = vi.fn(), onResult = vi.fn();
    const promise = prepareReplayForShare({} as TradeReplayData, new AbortController().signal, { prepare, onWait, onResult });
    const rejected = expect(promise).rejects.toMatchObject({ retryable: false, retryAfterMs: 0, message: expect.stringContaining('No further history') });
    await vi.advanceTimersByTimeAsync(45_000); await rejected;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(prepare).toHaveBeenCalledTimes(2); expect(onResult).toHaveBeenLastCalledWith(unavailable);
    expect(onWait).toHaveBeenLastCalledWith(0); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('complete replay export gate', () => {
  it.each([
    ['preparation_pending','longer than usual'],
    ['preparation_timeout','timed out'],
    ['preparation_capacity','memory limit'],
    ['accounting_pending','transactions are still being processed'],['accounting_mismatch','confirmed wallet balance'],
    ['unknown_costs','wallet-paid fees are unavailable'],['chart_coverage','full replay window'],['chart_unavailable','No further history'],
    ['stale_quote','confirmed market price is unavailable'],['provider_cooldown','historical import'],
  ] as const)('explains the %s preparation stage',(blockingReason,message)=>{
    const error=new ReplayPreparationError({...result('pending',60_000),blockingReason});
    expect(error.message).toContain(message);expect(error.retryAfterMs).toBe(60_000);
  });
  it.each(['pending', 'unavailable'] as const)('never starts the encoder or enables saving for %s data', async status => {
    const record = vi.fn(), onReady = vi.fn(), onFile = vi.fn(), onError = vi.fn(), onFinish = vi.fn();
    const session = startReplaySession({ prepare: async () => requirePreparedReplay(result(status, 60_000)),
      record, onReady, onFile, onError, onFinish });
    await session.completed;
    expect(record).not.toHaveBeenCalled(); expect(onReady).not.toHaveBeenCalled(); expect(onFile).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(ReplayPreparationError));
    expect(onError.mock.calls[0][0].retryAfterMs).toBe(status === 'pending' ? 60_000 : 0);
    expect(onError.mock.calls[0][0].retryable).toBe(status === 'pending');
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
