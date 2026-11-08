import { createTradeReplayAudio, TRADE_REPLAY_AUDIO_CHANNELS, TRADE_REPLAY_AUDIO_SAMPLE_RATE, type ReplayAudioCue } from './tradeReplayAudio';

export interface ReplayRecordingCanvas {
  canvas: HTMLCanvasElement;
  getDuration(): number;
  render(progress: number): void;
  getAudioCues?(): readonly ReplayAudioCue[];
}

const formats = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
const audioFormats = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
const frameRate = 30;
const bitrate = 8_000_000;
const audioBitrate = 128_000;

function hasIndexedEncoder() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function recorderFormat(withAudio = false): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  return (withAudio ? audioFormats : formats).find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}

class ReplayCodecUnavailable extends Error {
  constructor() { super('This browser cannot encode the replay. Try Chrome, Edge, or Safari.'); }
}

export function supportedReplayFormat(): string | null {
  // The encoder's actual codec is selected asynchronously at export time.
  if (hasIndexedEncoder()) return 'video/mp4';
  return recorderFormat();
}

export function replayFileName(name: string, mime: string, kind: 'trade' | 'token' = 'trade') {
  const clean = name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90).toLowerCase() || 'kollens';
  return `${clean}-${kind}-replay.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
}

function cancelled() { return new DOMException('Video export cancelled.', 'AbortError'); }

/** Encode every canvas frame at the handoff generator's fixed timestamps. */
export async function recordTradeReplay(player: ReplayRecordingCanvas, name: string, signal: AbortSignal, onProgress?: (progress: number) => void, kind: 'trade' | 'token' = 'trade'): Promise<File> {
  if (signal.aborted) throw cancelled();
  const cues = kind === 'trade' ? player.getAudioCues?.() : undefined;
  if (hasIndexedEncoder()) {
    try { return await encodeIndexedReplay(player, name, signal, onProgress, kind, cues); }
    catch (problem) {
      // Some browsers expose WebCodecs but have no usable codec for this canvas.
      // Compatibility capture is safe only before encoding has begun; failures
      // after frames have been submitted must never produce a truncated replay.
      if (!(problem instanceof ReplayCodecUnavailable) || signal.aborted
        || typeof document === 'undefined' || document.visibilityState === 'hidden' || !recorderFormat(!!cues)) throw problem;
    }
  }
  return recordLiveReplay(player, name, signal, onProgress, kind, cues);
}

async function encodeIndexedReplay(player: ReplayRecordingCanvas, name: string, signal: AbortSignal, onProgress: ((progress: number) => void) | undefined, kind: 'trade' | 'token', cues: readonly ReplayAudioCue[] | undefined): Promise<File> {
  type Bunny = typeof import('mediabunny');
  let output: InstanceType<Bunny['Output']> | undefined;
  let video: InstanceType<Bunny['CanvasSource']> | undefined;
  let audio: InstanceType<Bunny['AudioBufferSource']> | undefined;
  let cancelOutput: Promise<void> | undefined;
  const lifecycle = new AbortController();
  const abort = () => lifecycle.abort(cancelled());
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => lifecycle.abort(new Error('Video encoding timed out. Try sharing the trade again.')), 120_000);
  // Race each encoder operation, including capability checks and finalization,
  // so cancellation still responds if a browser encoder stops resolving work.
  const wait = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const stop = () => reject(lifecycle.signal.reason);
    if (lifecycle.signal.aborted) { operation.catch(() => {}); stop(); return; }
    lifecycle.signal.addEventListener('abort', stop, { once: true });
    operation.then(value => { lifecycle.signal.removeEventListener('abort', stop); resolve(value); }, error => {
      lifecycle.signal.removeEventListener('abort', stop); reject(error);
    });
  });
  const dispose = () => {
    if (output && output.state !== 'finalized' && output.state !== 'canceled' && !cancelOutput) {
      cancelOutput = output.cancel().catch(() => {});
    }
  };
  lifecycle.signal.addEventListener('abort', dispose, { once: true });
  try {
    if (signal.aborted) abort();
    const media = await wait(import('mediabunny'));
    const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality,
      WebMOutputFormat, getFirstEncodableVideoCodec } = media;
    const quality = new Quality({ bitrate });
    const options = { width: player.canvas.width, height: player.canvas.height, frameRate, quality };
    const audioOptions = { numberOfChannels: TRADE_REPLAY_AUDIO_CHANNELS, sampleRate: TRADE_REPLAY_AUDIO_SAMPLE_RATE, bitrate: audioBitrate };
    let codec = await wait(getFirstEncodableVideoCodec(['avc'], options));
    let audioCodec = codec && cues ? await wait(media.getFirstEncodableAudioCodec(['aac'], audioOptions)) : null;
    let format;
    if (codec && (!cues || audioCodec)) format = new Mp4OutputFormat();
    else {
      codec = await wait(getFirstEncodableVideoCodec(['vp9', 'vp8'], options));
      if (!codec) throw new ReplayCodecUnavailable();
      audioCodec = cues ? await wait(media.getFirstEncodableAudioCodec(['opus'], audioOptions)) : null;
      if (cues && !audioCodec) throw new ReplayCodecUnavailable();
      format = new WebMOutputFormat();
    }
    const target = new BufferTarget();
    output = new Output({ format, target });
    video = new CanvasSource(player.canvas, { codec, quality });
    output.addVideoTrack(video, { frameRate });
    const frameCount = Math.max(2, Math.round(player.getDuration() * frameRate));
    if (audioCodec) {
      audio = new media.AudioBufferSource({ codec: audioCodec, quality: new Quality({ bitrate: audioBitrate }) });
      output.addAudioTrack(audio);
    }
    await wait(output.start());
    if (audio && cues) {
      // The last visual frame is held until the end of its frame interval.
      const audioCues = cues.map(cue => ({ ...cue, progress: Math.ceil(cue.progress * (frameCount - 1) - 1e-9) / frameCount }));
      await wait(audio.add(createTradeReplayAudio(frameCount / frameRate, audioCues)));
      audio.close();
    }
    for (let index = 0; index < frameCount; index += 1) {
      if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
      const progress = index / (frameCount - 1);
      player.render(progress);
      await wait(video.add(index / frameRate, 1 / frameRate, index % (frameRate * 2) === 0 ? { keyFrame: true } : undefined));
      onProgress?.(progress);
    }
    video.close();
    await wait(output.finalize());
    if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
    if (!target.buffer?.byteLength) throw new Error('The video file was empty. Try sharing the trade again.');
    const blob = new Blob([target.buffer], { type: format.mimeType });
    return new File([blob], replayFileName(name, blob.type, kind), { type: blob.type });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    lifecycle.signal.removeEventListener('abort', dispose);
    dispose();
    try { video?.close(); } catch { /* A source that never started is disposed by output.cancel(). */ }
    try { audio?.close(); } catch { /* A source that never started is disposed by output.cancel(). */ }
  }
}

/** Compatibility path for browsers without WebCodecs. */
async function recordLiveReplay(player: ReplayRecordingCanvas, name: string, signal: AbortSignal, onProgress: ((progress: number) => void) | undefined, kind: 'trade' | 'token', cues: readonly ReplayAudioCue[] | undefined): Promise<File> {
  const mime = recorderFormat(!!cues);
  if (!mime) throw new Error('Video recording is unavailable in this browser. Try Chrome, Edge, or Safari.');
  if (signal.aborted) throw cancelled();
  const tabHidden = () => document.visibilityState === 'hidden';
  if (tabHidden()) throw new Error('Keep this tab visible while exporting the video.');
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let audioContext: AudioContext | undefined;
  let soundtrack: AudioBufferSourceNode | undefined;
  let frame = 0, finishTimer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  try {
    player.render(0);
    stream = player.canvas.captureStream(frameRate);
    if (cues) {
      if (typeof AudioContext === 'undefined') throw new ReplayCodecUnavailable();
      const context = audioContext = new AudioContext({ sampleRate: TRADE_REPLAY_AUDIO_SAMPLE_RATE });
      soundtrack = context.createBufferSource();
      soundtrack.buffer = createTradeReplayAudio(player.getDuration(), cues);
      const destination = context.createMediaStreamDestination();
      soundtrack.connect(destination);
      destination.stream.getAudioTracks().forEach(track => stream!.addTrack(track));
      // Connect only to the recorder. Automatic export must stay silent in the modal.
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(cancelled());
        const timer = setTimeout(() => finish(new Error('Click Retry replay to enable audio and prepare the video.')), 3000);
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        context.resume().then(() => finish(), finish);
      });
    }
    if (signal.aborted) throw cancelled();
    if (tabHidden()) throw new Error('Keep this tab visible while exporting the video.');
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
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
      soundtrack?.start();
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
    return new File([blob], replayFileName(name, blob.type, kind), { type: blob.type });
  } finally {
    cancelAnimationFrame(frame);
    clearTimeout(finishTimer);
    clearTimeout(watchdog);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Track cleanup is independent of recorder state. */ } }
    stream?.getTracks().forEach(track => track.stop());
    soundtrack?.disconnect();
    if (audioContext) void audioContext.close().catch(() => {});
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
