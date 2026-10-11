import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReplaySession } from './tradeReplaySession';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const video = () => new File(['recorded replay'], 'trade-replay.mp4', { type: 'video/mp4' });
afterEach(() => { vi.unstubAllGlobals(); });

describe('automatic trade replay generation session', () => {
  it('prepares the renderer before recording exactly once and leaves saving/sharing for a new click', async () => {
    const preparation = deferred<void>();
    const recording = deferred<File>();
    const order: string[] = [];
    const share = vi.fn();
    vi.stubGlobal('navigator', { share });
    const onProgress = vi.fn();
    const onFile = vi.fn();
    const onError = vi.fn();
    const onFinish = vi.fn();
    let reportProgress!: (value: number) => void;
    const record = vi.fn((_signal: AbortSignal, report: (value: number) => void) => {
      order.push('record'); reportProgress = report;
      return recording.promise;
    });
    const session = startReplaySession({
      prepare: vi.fn(async signal => { await preparation.promise; expect(signal).toBe(session.signal); order.push('prepared'); }),
      record, onReady: () => order.push('ready'), onProgress, onFile, onError, onFinish,
    });
    expect(record).not.toHaveBeenCalled();
    preparation.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['prepared', 'ready', 'record']);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toBe(session.signal);
    reportProgress(.4);
    expect(onProgress).toHaveBeenCalledWith(.4);
    const file = video(); recording.resolve(file);
    await session.completed;
    expect(onFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(share).not.toHaveBeenCalled();
    reportProgress(.1);
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it('ignores stale preparation after StrictMode cleanup and records only the replacement renderer', async () => {
    const firstPreparation = deferred<void>();
    const secondPreparation = deferred<void>();
    const oldCallbacks = { onReady: vi.fn(), onFile: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };
    const oldRecord = vi.fn(async () => video());
    const oldSession = startReplaySession({ prepare: () => firstPreparation.promise, record: oldRecord, ...oldCallbacks });
    oldSession.dispose();
    const freshFile = video();
    const freshRecord = vi.fn(async () => freshFile);
    const freshOnFile = vi.fn();
    const freshSession = startReplaySession({ prepare: () => secondPreparation.promise, record: freshRecord, onFile: freshOnFile });
    expect(oldSession.signal.aborted).toBe(true);
    expect(freshSession.signal.aborted).toBe(false);
    firstPreparation.resolve(); secondPreparation.resolve();
    await Promise.all([oldSession.completed, freshSession.completed]);
    expect(oldRecord).not.toHaveBeenCalled();
    for (const callback of Object.values(oldCallbacks)) expect(callback).not.toHaveBeenCalled();
    expect(freshRecord).toHaveBeenCalledOnce();
    expect(freshOnFile).toHaveBeenCalledExactlyOnceWith(freshFile);
  });

  it('aborts in-flight capture on close and suppresses its late progress, output, and finish callbacks', async () => {
    const recording = deferred<File>();
    const callbacks = { onProgress: vi.fn(), onFile: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };
    let reportProgress!: (value: number) => void;
    let recordSignal!: AbortSignal;
    const session = startReplaySession({
      prepare: async () => {},
      record: (signal, report) => { recordSignal = signal; reportProgress = report; return recording.promise; },
      ...callbacks,
    });
    await Promise.resolve();
    const aborted = vi.fn(); recordSignal.addEventListener('abort', aborted);
    session.dispose(); session.dispose();
    reportProgress(.9); recording.resolve(video());
    await session.completed;
    expect(aborted).toHaveBeenCalledOnce();
    expect(recordSignal.aborted).toBe(true);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it('never starts recording when the ready callback closes the modal', async () => {
    const preparation = deferred<void>();
    const record = vi.fn(async () => video());
    const onFinish = vi.fn();
    const session = startReplaySession({ prepare: () => preparation.promise, record, onReady: () => session.dispose(), onFinish });
    preparation.resolve(); await session.completed;
    expect(record).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('keeps preview readiness when recording is unsupported and reports the actionable failure', async () => {
    const unavailable = new Error('Video recording is unavailable in this browser.');
    const onReady = vi.fn(), onError = vi.fn(), onFinish = vi.fn(), onFile = vi.fn();
    const session = startReplaySession({
      prepare: async () => {}, record: async () => { throw unavailable; }, onReady, onError, onFinish, onFile,
    });
    await session.completed;
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(unavailable);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFile).not.toHaveBeenCalled();
  });

  it('reports preparation failures without starting the recorder', async () => {
    const problem = new Error('Artwork could not be prepared');
    const record = vi.fn(async () => video());
    const onReady = vi.fn(), onError = vi.fn(), onFinish = vi.fn();
    const session = startReplaySession({ prepare: async () => { throw problem; }, record, onReady, onError, onFinish });
    await session.completed;
    expect(record).not.toHaveBeenCalled(); expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(problem);
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('does not show cancellation as an export failure', async () => {
    const onError = vi.fn(), onFinish = vi.fn();
    const session = startReplaySession({
      prepare: async () => {}, record: async () => { throw new DOMException('Cancelled', 'AbortError'); }, onError, onFinish,
    });
    await session.completed;
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
  });
});
