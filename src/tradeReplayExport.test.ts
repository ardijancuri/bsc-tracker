import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayCanvas } from './tradeReplayCanvas';
import { recordTradeReplay, supportedReplayFormat } from './tradeReplayExport';

const indexed = vi.hoisted(() => ({
  codec: vi.fn(), add: vi.fn(), start: vi.fn(), finalize: vi.fn(), cancel: vi.fn(), close: vi.fn(),
  videoOptions: vi.fn(), trackOptions: vi.fn(), quality: vi.fn(),
}));

vi.mock('mediabunny', () => {
  class BufferTarget { buffer: ArrayBuffer | null = null; }
  class Output {
    state = 'pending';
    target: BufferTarget;
    constructor(options: { target: BufferTarget }) { this.target = options.target; }
    addVideoTrack(_source: unknown, options: unknown) { indexed.trackOptions(options); }
    async start() { await indexed.start(); this.state = 'started'; }
    async finalize() { this.state = 'finalizing'; await indexed.finalize(); this.target.buffer = new Uint8Array([1, 2, 3]).buffer; this.state = 'finalized'; }
    async cancel() { this.state = 'canceled'; await indexed.cancel(); }
  }
  class CanvasSource {
    constructor(canvas: unknown, options: unknown) { indexed.videoOptions(canvas, options); }
    add(...args: unknown[]) { return indexed.add(...args); }
    close() { indexed.close(); }
  }
  return {
    BufferTarget, CanvasSource, Output,
    Quality: class { constructor(options: unknown) { indexed.quality(options); } },
    Mp4OutputFormat: class { mimeType = 'video/mp4'; },
    WebMOutputFormat: class { mimeType = 'video/webm'; },
    getFirstEncodableVideoCodec: indexed.codec,
  };
});

beforeEach(() => {
  Object.values(indexed).forEach(mock => mock.mockReset());
  indexed.codec.mockResolvedValue('avc');
  indexed.add.mockResolvedValue(undefined); indexed.start.mockResolvedValue(undefined);
  indexed.finalize.mockResolvedValue(undefined); indexed.cancel.mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function browserRecorder(supported: string) {
  vi.stubGlobal('VideoEncoder', undefined); vi.stubGlobal('VideoFrame', undefined);
  vi.useFakeTimers(); vi.setSystemTime(0);
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] };
  class Canvas { captureStream() { return stream; } }
  class Recorder {
    static isTypeSupported(type: string) { return type === supported; }
    mimeType: string; state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_stream: unknown, options: { mimeType: string }) { this.mimeType = options.mimeType; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['video frames'], { type: this.mimeType }) }); this.onstop?.(); }
  }
  vi.stubGlobal('HTMLCanvasElement', Canvas); vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  const render = vi.fn();
  const player = { canvas: new Canvas(), getDuration: () => .02, render } as unknown as ReplayCanvas;
  return { player, stopTrack, render };
}

function indexedPlayer(duration = 15.5) {
  vi.stubGlobal('VideoEncoder', class {}); vi.stubGlobal('VideoFrame', class {});
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  const render = vi.fn();
  const canvas = { width: 1080, height: 1350, captureStream: vi.fn() };
  return { player: { canvas, getDuration: () => duration, render } as unknown as ReplayCanvas, render, canvas };
}

describe('indexed replay video encoding', () => {
  it('encodes all 465 frames at exact 30fps timestamps through the final replay state', async () => {
    const { player, render, canvas } = indexedPlayer();
    const progress = vi.fn();
    const file = await recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal, progress);
    expect(file.type).toBe('video/mp4'); expect(file.name).toBe('trader-token-trade-replay.mp4');
    expect(indexed.codec).toHaveBeenCalledWith(['avc'], expect.objectContaining({ width: 1080, height: 1350, frameRate: 30 }));
    expect(indexed.quality).toHaveBeenCalledWith({ bitrate: 8_000_000 });
    expect(indexed.trackOptions).toHaveBeenCalledWith({ frameRate: 30 });
    expect(indexed.add).toHaveBeenCalledTimes(465); expect(render).toHaveBeenCalledTimes(465);
    expect(canvas.captureStream).not.toHaveBeenCalled();
    for (let index = 0; index < 465; index += 1) {
      expect(render.mock.calls[index]).toEqual([index / 464]);
      expect(indexed.add.mock.calls[index]).toEqual([index / 30, 1 / 30, index % 60 === 0 ? { keyFrame: true } : undefined]);
    }
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(indexed.finalize).toHaveBeenCalledOnce(); expect(indexed.close).toHaveBeenCalled();
    expect(indexed.cancel).not.toHaveBeenCalled();
  });

  it('keeps encoded timing fixed when drawing and encoding take longer than playback', async () => {
    vi.useFakeTimers();
    const { player, render } = indexedPlayer(.1);
    indexed.add.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1000)));
    const promise = recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3500);
    await promise;
    expect(render.mock.calls).toEqual([[0], [.5], [1]]);
    expect(indexed.add.mock.calls.map(call => call.slice(0, 2))).toEqual([[0, 1 / 30], [1 / 30, 1 / 30], [2 / 30, 1 / 30]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses indexed WebM when AVC is unavailable and preserves its real MIME type', async () => {
    const { player } = indexedPlayer(.1);
    indexed.codec.mockResolvedValueOnce(null).mockResolvedValueOnce('vp9');
    const file = await recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal);
    expect(indexed.codec.mock.calls.map(call => call[0])).toEqual([['avc'], ['vp9', 'vp8']]);
    expect(file.type).toBe('video/webm'); expect(file.name).toBe('trader-token-trade-replay.webm');
  });

  it('does not change to real-time capture when WebCodecs has no usable codec', async () => {
    const { player, canvas } = indexedPlayer(.1);
    indexed.codec.mockResolvedValue(null);
    await expect(recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal)).rejects.toThrow('cannot encode');
    expect(canvas.captureStream).not.toHaveBeenCalled(); expect(indexed.start).not.toHaveBeenCalled();
  });

  it('rejects cancellation while a frame is pending and disposes the encoder without finalizing', async () => {
    vi.useFakeTimers();
    const { player, canvas } = indexedPlayer(.1);
    indexed.add.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const promise = recordTradeReplay(player, 'Trader TOKEN', controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(indexed.add).toHaveBeenCalledOnce();
    controller.abort(); await rejected;
    expect(indexed.cancel).toHaveBeenCalledOnce(); expect(indexed.close).toHaveBeenCalled();
    expect(indexed.finalize).not.toHaveBeenCalled(); expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled finalization and releases resources without falling back to recording', async () => {
    vi.useFakeTimers();
    const { player, canvas } = indexedPlayer(.1);
    indexed.finalize.mockImplementation(() => new Promise(() => {}));
    const promise = recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120_001); await rejected;
    expect(indexed.cancel).toHaveBeenCalledOnce(); expect(indexed.close).toHaveBeenCalled();
    expect(canvas.captureStream).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('returns encoder errors and cancels the partial output instead of silently dropping frames', async () => {
    const { player } = indexedPlayer(.1);
    indexed.add.mockRejectedValue(new Error('Encoder failed'));
    await expect(recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal)).rejects.toThrow('Encoder failed');
    expect(indexed.cancel).toHaveBeenCalledOnce(); expect(indexed.close).toHaveBeenCalled();
    expect(indexed.finalize).not.toHaveBeenCalled();
  });

  it('does not start an encoder for a previously cancelled share', async () => {
    const { player } = indexedPlayer(.1);
    const controller = new AbortController(); controller.abort();
    await expect(recordTradeReplay(player, 'Trader TOKEN', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(indexed.codec).not.toHaveBeenCalled(); expect(indexed.start).not.toHaveBeenCalled();
  });
});

describe('replay video export lifecycle', () => {
  it('exports real recorder output as MP4 and releases stream tracks', async () => {
    const { player, stopTrack, render } = browserRecorder('video/mp4');
    expect(supportedReplayFormat()).toBe('video/mp4');
    const promise = recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(250);
    const file = await promise;
    expect(file.type).toBe('video/mp4'); expect(file.name).toBe('trader-token-trade-replay.mp4'); expect(file.size).toBeGreaterThan(0);
    expect(render).toHaveBeenLastCalledWith(1); expect(stopTrack).toHaveBeenCalledOnce();
  });
  it('uses an honest WebM fallback when MP4 is unsupported', async () => {
    const { player } = browserRecorder('video/webm;codecs=vp8');
    expect(supportedReplayFormat()).toBe('video/webm;codecs=vp8');
    const promise = recordTradeReplay(player, 'Trader TOKEN', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(250);
    expect((await promise).name.endsWith('.webm')).toBe(true);
  });
  it('rejects cancelled exports and stops recording and tracks', async () => {
    const { player, stopTrack } = browserRecorder('video/webm');
    const controller = new AbortController();
    const promise = recordTradeReplay(player, 'Trader TOKEN', controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
