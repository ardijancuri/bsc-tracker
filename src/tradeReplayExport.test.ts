import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayCanvas } from './tradeReplayCanvas';
import { recordTradeReplay, supportedReplayFormat } from './tradeReplayExport';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function browserRecorder(supported: string) {
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
