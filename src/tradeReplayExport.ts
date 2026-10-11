import type { ReplayCanvas } from './tradeReplayCanvas';

const formats = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function supportedReplayFormat(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  return formats.find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function replayFileName(name: string, mime: string) {
  const clean = name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90).toLowerCase() || 'bscan';
  return `${clean}-trade-replay.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
}

/** Record the same deterministic canvas used by preview. The caller owns cancellation. */
export async function recordTradeReplay(player: ReplayCanvas, name: string, signal: AbortSignal, onProgress?: (progress: number) => void): Promise<File> {
  const mime = supportedReplayFormat();
  if (!mime) throw new Error('Video recording is unavailable in this browser. Try Chrome, Edge, or Safari.');
  if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
  if (document.visibilityState === 'hidden') throw new Error('Keep this tab visible while exporting the video.');
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let frame = 0, finishTimer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  try {
    player.render(0);
    stream = player.canvas.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const activeRecorder = recorder;
    const chunks: Blob[] = [];
    const blob = await new Promise<Blob>((resolve, reject) => {
      let failed = false;
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        cancelAnimationFrame(frame);
        clearTimeout(finishTimer);
        if (activeRecorder.state !== 'inactive') { try { activeRecorder.stop(); } catch { /* Cleanup below still stops the tracks. */ } }
        reject(error);
      };
      abortListener = () => fail(new DOMException('Video export cancelled.', 'AbortError'));
      visibilityListener = () => { if (document.visibilityState === 'hidden') fail(new Error('Video export stopped because the tab became hidden. Keep this tab visible and try again.')); };
      signal.addEventListener('abort', abortListener, { once: true });
      document.addEventListener('visibilitychange', visibilityListener);
      activeRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      activeRecorder.onerror = () => fail(new Error('Video recording failed. Try another supported browser.'));
      activeRecorder.onstop = () => { if (!failed) resolve(new Blob(chunks, { type: activeRecorder.mimeType.split(';')[0] || mime.split(';')[0] })); };
      activeRecorder.start(500);
      const started = performance.now();
      const duration = player.getDuration() * 1000;
      watchdog = setTimeout(() => fail(new Error('Video recording timed out. Keep this tab visible and try again.')), duration + 10_000);
      const draw = (now: number) => {
        if (failed) return;
        const progress = Math.min(1, (now - started) / duration);
        try { player.render(progress); onProgress?.(progress); }
        catch { fail(new Error('The replay could not be rendered for export.')); return; }
        if (progress < 1) frame = requestAnimationFrame(draw);
        else finishTimer = setTimeout(() => { if (!failed && activeRecorder.state !== 'inactive') activeRecorder.stop(); }, 180);
      };
      frame = requestAnimationFrame(draw);
    });
    if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
    if (!blob.size) throw new Error('The video file was empty. Try exporting again.');
    return new File([blob], replayFileName(name, blob.type), { type: blob.type });
  } finally {
    cancelAnimationFrame(frame);
    clearTimeout(finishTimer);
    clearTimeout(watchdog);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Track cleanup is independent of recorder state. */ } }
    stream?.getTracks().forEach(track => track.stop());
  }
}

export function downloadTradeReplay(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Let the browser finish reading the object URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
