export interface ReplayAudioCue {
  progress: number;
  side: 'buy' | 'sell';
}

export const TRADE_REPLAY_AUDIO_SAMPLE_RATE = 48_000;
export const TRADE_REPLAY_AUDIO_CHANNELS = 2;

type ReplayMusicTrack = { id: string; title: string; url: string; startSeconds: number };

export const replayMusicTracks = [
  { id: 'evil-empire', title: 'Evil Empire · Arthur Morgan', url: new URL('./assets/replay-music/evil-empire.mp3', import.meta.url).href, startSeconds: 3.2 },
  { id: 'track-02', title: 'ssstik.io_1794665957297.mp3', url: new URL('./assets/replay-music/track-02.mp3', import.meta.url).href, startSeconds: 1.3 },
  { id: 'track-03', title: 'ssstik.io_1794666003965.mp3', url: new URL('./assets/replay-music/track-03.mp3', import.meta.url).href, startSeconds: 0 },
  { id: 'track-04', title: 'ssstik.io_1794665833242.mp3', url: new URL('./assets/replay-music/track-04.mp3', import.meta.url).href, startSeconds: 0 },
  { id: 'track-05', title: 'ssstik.io_1794665897037.mp3', url: new URL('./assets/replay-music/track-05.mp3', import.meta.url).href, startSeconds: 0 },
] as const satisfies readonly ReplayMusicTrack[];

export type ReplayMusic = typeof replayMusicTracks[number];
export const defaultReplayMusic = replayMusicTracks[0];

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

function mixRecordedMusic(music: AudioBuffer, startSeconds: number, left: Float32Array, right: Float32Array) {
  const sourceLeft = music.getChannelData(0);
  const sourceRight = music.numberOfChannels > 1 ? music.getChannelData(1) : sourceLeft;
  const outset = Math.min(music.length - 1, Math.round(startSeconds * TRADE_REPLAY_AUDIO_SAMPLE_RATE));
  const musicLength = music.length - outset;
  const sampleCount = Math.min(left.length, musicLength);
  let squareSum = 0;
  let peak = 0;
  for (let i = outset; i < outset + sampleCount; i++) {
    squareSum += (sourceLeft[i] ** 2 + sourceRight[i] ** 2) / 2;
    peak = Math.max(peak, Math.abs(sourceLeft[i]), Math.abs(sourceRight[i]));
  }
  const rms = Math.sqrt(squareSum / sampleCount);
  const gain = Math.min(1.5, 0.20 / (rms || 1), 0.64 / (peak || 1));
  const edge = Math.max(1, Math.min(Math.round(0.025 * TRADE_REPLAY_AUDIO_SAMPLE_RATE), Math.floor(musicLength / 2)));
  for (let i = 0; i < left.length; i++) {
    const index = i % musicLength;
    const level = gain * Math.min(1, index / edge, (musicLength - 1 - index) / edge);
    left[i] = sourceLeft[outset + index] * level;
    right[i] = sourceRight[outset + index] * level;
  }
}

const tau = 2 * Math.PI;
const cueSpacing = 0.09;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

type Mix = (start: number, length: number, gain: number, pan: number, sample: (time: number) => number) => void;

function attack(time: number, seconds: number) {
  return Math.min(1, time / seconds);
}

function filteredNoise(lowHz: number, highHz: number, seed: number) {
  const lowStep = 1 - Math.exp(-tau * lowHz / TRADE_REPLAY_AUDIO_SAMPLE_RATE);
  const highStep = 1 - Math.exp(-tau * highHz / TRADE_REPLAY_AUDIO_SAMPLE_RATE);
  let low = 0, high = 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = seed / 2 ** 31 - 1;
    low += (value - low) * lowStep;
    high += (value - high) * highStep;
    return high - low;
  };
}

function orderTone(note: number, length: number, decay: number, brightness: number) {
  const angle = tau * hz(note);
  return (time: number) => {
    const phase = angle * time;
    const fundamental = Math.sin(phase);
    const edge = (Math.sin(2 * phase) + 0.38 * Math.sin(3 * phase)) * Math.exp(-time / 0.024);
    return (fundamental + brightness * edge) * attack(time, 0.003) *
      Math.exp(-time / decay) * attack(length - time, 0.02);
  };
}

function tradeAccent(mix: Mix, time: number, side: ReplayAudioCue['side']) {
  if (side === 'buy') {
    // Two short, rising confirmation ticks.
    const click = filteredNoise(1500, 6300, 68353);
    mix(time, 0.022, 0.17, 0, elapsed => click() * attack(elapsed, 0.001) * Math.exp(-elapsed / 0.004));
    mix(time, 0.048, 0.27, -0.08, orderTone(74, 0.048, 0.017, 0.48));
    mix(time + 0.041, 0.1, 0.36, 0.08, orderTone(81, 0.1, 0.032, 0.32));
    return;
  }

  // A dry strike followed by a lower, heavier confirmation.
  const strike = filteredNoise(450, 3300, 22531);
  mix(time, 0.033, 0.33, 0, elapsed => strike() * attack(elapsed, 0.001) * Math.exp(-elapsed / 0.006));
  mix(time, 0.044, 0.26, 0.07, orderTone(69, 0.044, 0.015, 0.34));
  mix(time + 0.037, 0.125, 0.43, -0.07, orderTone(62, 0.125, 0.038, 0.52));
  mix(time + 0.037, 0.095, 0.16, 0, orderTone(50, 0.095, 0.029, 0.12));
}

/** Render the soundtrack offline so its timing does not depend on playback, browser tabs or encoding speed. */
export function createTradeReplayAudio(durationSeconds: number, cues: readonly ReplayAudioCue[], music: AudioBuffer, startSeconds: number): AudioBuffer {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new RangeError('Replay audio needs a positive duration.');
  const sampleRate = TRADE_REPLAY_AUDIO_SAMPLE_RATE;
  const length = Math.max(1, Math.round(durationSeconds * sampleRate));
  const duration = length / sampleRate;
  const buffer = new AudioBuffer({ length, sampleRate, numberOfChannels: TRADE_REPLAY_AUDIO_CHANNELS });
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const mix: Mix = (start, seconds, gain, pan, sample) => {
    const first = Math.round(start * sampleRate);
    const end = Math.min(length, first + Math.round(seconds * sampleRate));
    const accentGain = gain * 0.60;
    const leftGain = accentGain * Math.sqrt((1 - pan) / 2);
    const rightGain = accentGain * Math.sqrt((1 + pan) / 2);
    for (let i = first; i < end; i++) {
      const value = sample((i - first) / sampleRate);
      left[i] += value * leftGain;
      right[i] += value * rightGain;
    }
  };
  mixRecordedMusic(music, startSeconds, left, right);

  const last = { buy: -Infinity, sell: -Infinity };
  const accents = cues.filter(cue => Number.isFinite(cue.progress) && cue.progress >= 0 && cue.progress < 1)
    .sort((a, b) => a.progress - b.progress)
    .flatMap(({ progress, side }) => {
      const time = progress * duration;
      // A burst of fills on the same side shares one accent. The first onset stays pinned to its frame.
      if (time < last[side] + cueSpacing) return [];
      last[side] = time;
      return [{ time, side }];
    });

  // Duck the bed at each audible cue. Overlapping accents share one attenuation envelope.
  const duck = new Float32Array(length);
  const leadSamples = Math.round(0.014 * sampleRate);
  const holdSamples = Math.round(0.08 * sampleRate);
  const releaseSamples = Math.round(0.18 * sampleRate);
  for (const { time } of accents) {
    const onset = Math.round(time * sampleRate);
    const holdEnd = onset + holdSamples;
    for (let i = Math.max(0, onset - leadSamples); i < Math.min(length, holdEnd + releaseSamples); i++) {
      const envelope = i < onset ? 1 - (onset - i) / leadSamples : 1 - Math.max(0, i - holdEnd) / releaseSamples;
      duck[i] = Math.max(duck[i], 0.28 * envelope);
    }
  }
  const musicFade = 0.78 * sampleRate;
  for (let i = 0; i < length; i++) {
    const gain = (1 - duck[i]) * Math.min(1, (length - 1 - i) / musicFade);
    left[i] *= gain;
    right[i] *= gain;
  }
  for (const { time, side } of accents) tradeAccent(mix, time, side);

  let peak = 0;
  const release = 0.025 * sampleRate;
  for (let i = 0; i < length; i++) {
    const gain = 1.4 * Math.min(1, (length - 1 - i) / release);
    left[i] *= gain;
    right[i] *= gain;
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peak > 0.88) {
    const gain = 0.88 / peak;
    for (let i = 0; i < length; i++) {
      left[i] *= gain;
      right[i] *= gain;
    }
  }
  return buffer;
}
