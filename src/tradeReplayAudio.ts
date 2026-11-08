export interface ReplayAudioCue {
  progress: number;
  side: 'buy' | 'sell';
}

export const TRADE_REPLAY_AUDIO_SAMPLE_RATE = 48_000;
export const TRADE_REPLAY_AUDIO_CHANNELS = 2;

const tau = 2 * Math.PI;
const beatSeconds = 0.625;
const barSeconds = 4 * beatSeconds;
const cueSpacing = 0.09;
const bedVoicings = [
  [38, 53, 57, 60, 64],
  [34, 53, 57, 60, 62],
  [31, 53, 58, 62, 69],
  [33, 55, 58, 62, 64],
];
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

function feltKey(note: number, length: number) {
  const angle = tau * hz(note);
  return (time: number) => {
    const phase = angle * time;
    const body = Math.sin(phase) + 0.22 * Math.sin(phase * 1.003 + 0.65);
    const hammer = (0.34 * Math.sin(phase * 2.002) + 0.14 * Math.sin(phase * 3.008)) * Math.exp(-time / 0.085);
    return (body + hammer) * attack(time, 0.012) * Math.exp(-time / 0.34) * attack(length - time, 0.14);
  };
}

function musicBed(mix: Mix, duration: number) {
  const brush = filteredNoise(320, 2500, 40279);
  const pulse = (time: number) => {
    const phase = tau * (53 * time + 26 * 0.036 * (1 - Math.exp(-time / 0.036)));
    return attack(time, 0.013) * Math.exp(-time / 0.064) * Math.sin(phase);
  };
  for (let bar = 0; bar * barSeconds < duration; bar++) {
    const start = bar * barSeconds;
    const [bass, lower, middle, upper, color] = bedVoicings[bar % bedVoicings.length];
    mix(start, 0.32, 0.064, 0, pulse);
    mix(start + 2.5 * beatSeconds, 0.32, 0.038, 0, pulse);
    mix(start + beatSeconds, 0.15, 0.075, 0.22, time =>
      brush() * attack(time, 0.018) * Math.exp(-time / 0.037));
    mix(start + 3 * beatSeconds, 0.15, 0.062, -0.22, time =>
      brush() * attack(time, 0.018) * Math.exp(-time / 0.037));

    mix(start + 0.024, 1.9, 0.06, 0, feltKey(bass, 1.9));
    const notes = [
      { note: lower, beat: 0.07, pan: -0.22, gain: 0.036 },
      { note: middle, beat: 0.13, pan: 0.02, gain: 0.031 },
      { note: upper, beat: 0.21, pan: 0.24, gain: 0.028 },
      { note: color, beat: 1.53, pan: -0.16, gain: 0.045 },
      { note: middle, beat: 2.86, pan: 0.17, gain: 0.031 },
    ];
    for (const { note, beat, pan, gain } of notes) {
      mix(start + beat * beatSeconds, 1.35, gain, pan, feltKey(note, 1.35));
    }
  }
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
export function createTradeReplayAudio(durationSeconds: number, cues: readonly ReplayAudioCue[]): AudioBuffer {
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
    const leftGain = gain * Math.sqrt((1 - pan) / 2);
    const rightGain = gain * Math.sqrt((1 + pan) / 2);
    for (let i = first; i < end; i++) {
      const value = sample((i - first) / sampleRate);
      left[i] += value * leftGain;
      right[i] += value * rightGain;
    }
  };
  musicBed(mix, duration);

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
      duck[i] = Math.max(duck[i], 0.64 * envelope);
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
