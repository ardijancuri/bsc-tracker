export const TRADE_REPLAY_AUDIO_SAMPLE_RATE = 48_000;
export const TRADE_REPLAY_AUDIO_CHANNELS = 2;

const replayMusic = [
  new URL('./assets/replay-music/evil-empire.mp3', import.meta.url).href,
  new URL('./assets/replay-music/track-02.mp3', import.meta.url).href,
  new URL('./assets/replay-music/track-03.mp3', import.meta.url).href,
  new URL('./assets/replay-music/track-04.mp3', import.meta.url).href,
  new URL('./assets/replay-music/track-05.mp3', import.meta.url).href,
];

export function selectTradeReplayMusic() {
  return replayMusic[Math.floor(Math.random() * replayMusic.length)];
}

export async function loadTradeReplayMusic(url: string, signal: AbortSignal): Promise<AudioBuffer> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  try {
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok) throw new Error('Soundtrack request failed');
    const bytes = await response.arrayBuffer();
    requestSignal.throwIfAborted();
    // Decode at the encoder's sample rate without opening an audible context.
    const decoder = new OfflineAudioContext(TRADE_REPLAY_AUDIO_CHANNELS, 1, TRADE_REPLAY_AUDIO_SAMPLE_RATE);
    const music = await decoder.decodeAudioData(bytes);
    requestSignal.throwIfAborted();
    if (!music.length) throw new Error('Empty soundtrack');
    return music;
  } catch {
    signal.throwIfAborted();
    throw new Error('Replay music could not be loaded. Try again.');
  }
}

/** Fit the selected music to the video duration independently of trade timing. */
export function createTradeReplayAudio(durationSeconds: number, music: AudioBuffer): AudioBuffer {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new RangeError('Replay audio needs a positive duration.');
  const sampleRate = TRADE_REPLAY_AUDIO_SAMPLE_RATE;
  const length = Math.max(1, Math.round(durationSeconds * sampleRate));
  const buffer = new AudioBuffer({ length, sampleRate, numberOfChannels: TRADE_REPLAY_AUDIO_CHANNELS });
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const sourceLeft = music.getChannelData(0);
  const sourceRight = music.numberOfChannels > 1 ? music.getChannelData(1) : sourceLeft;
  const sampleCount = Math.min(length, music.length);
  let squareSum = 0;
  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    squareSum += (sourceLeft[i] ** 2 + sourceRight[i] ** 2) / 2;
    peak = Math.max(peak, Math.abs(sourceLeft[i]), Math.abs(sourceRight[i]));
  }
  const rms = Math.sqrt(squareSum / sampleCount);
  const gain = 1.4 * Math.min(1, 0.13 / (rms || 1), 0.40 / (peak || 1));
  const edge = Math.max(1, Math.min(Math.round(0.025 * sampleRate), Math.floor(music.length / 2)));
  const endFade = 0.78 * sampleRate;
  for (let i = 0; i < length; i++) {
    const index = i % music.length;
    const level = gain * Math.min(1, index / edge, (music.length - 1 - index) / edge)
      * Math.min(1, (length - 1 - i) / endFade);
    left[i] = sourceLeft[index] * level;
    right[i] = sourceRight[index] * level;
  }
  return buffer;
}
