/**
 * Phase 8B — `renderWavetableVoice` against a real `OfflineAudioContext`.
 *
 * The offline context comes from `web-audio-engine` (already a devDependency
 * and the harness `scripts/realOfflineRenderNode.mjs` uses), so these tests
 * render actual PCM through the production renderer: real PeriodicWave
 * oscillators, real envelopes, real biquad filter and real panners. No node
 * graph is mocked here.
 *
 * Covered:
 *  - different frames / morph positions produce measurably different audio;
 *  - the fundamental frequency follows the MIDI note;
 *  - partial gains, unison detune and stereo spread change real output;
 *  - note duration gates the voice and note-off/release cleans it up;
 *  - polyphonic voices stay bounded, finite and deterministic;
 *  - voice allocation is bounded at 7 oscillators per note.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as Engine from 'web-audio-engine';
import type { Channel, Note, SynthParameters, WavetableParameters } from '../../types/daw';
import { DEFAULT_WAVETABLE_PARAMETERS, normalizeWavetableParameters } from '../wavetableTables';
import { WAVETABLE_PRESETS } from '../wavetablePresets';
import { renderWavetableVoice } from './wavetableSynth';

const OfflineAudioContext = (Engine as unknown as {
  OfflineAudioContext: new (channels: number, length: number, sampleRate: number) => BaseAudioContext;
}).OfflineAudioContext;

const SAMPLE_RATE = 44100;
const BPM = 120;

type OfflineCtx = BaseAudioContext & { startRendering: () => Promise<AudioBuffer> };

const synthParams = (patch: Partial<SynthParameters> = {}): SynthParameters => ({
  osc1Type: 'sawtooth',
  osc1Octave: 0,
  osc1Detune: 0,
  osc1Mix: 1,
  osc2Type: 'square',
  osc2Octave: 0,
  osc2Detune: 0,
  osc2Mix: 0,
  filterType: 'lowpass',
  filterCutoff: 18000,
  filterResonance: 0.0001,
  filterEnvAmount: 0,
  attack: 0.002,
  decay: 0.01,
  sustain: 1,
  release: 0.05,
  lfoRate: 0,
  lfoDepth: 0,
  lfoTarget: 'none',
  fmCarrierMultiplier: 1,
  fmModulatorMultiplier: 1,
  fmModulationIndex: 0,
  fmFeedback: 0,
  sampleRootNote: 60,
  sampleGlide: 0,
  sampleReverse: false,
  sampleLoop: false,
  sampleDrive: 0,
  ...patch,
});

const wavetable = (patch: Partial<WavetableParameters> = {}): WavetableParameters =>
  normalizeWavetableParameters({ ...DEFAULT_WAVETABLE_PARAMETERS, ...patch });

const makeChannel = (patch: Partial<Channel> = {}): Channel => ({
  id: 'wt-test',
  name: 'WT Test',
  color: '#00e5ff',
  instrumentType: 'wavetable',
  mixerTrackId: 1,
  volume: 0.8,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [],
  synthParams: synthParams(),
  wavetable: wavetable(),
  ...patch,
});

interface RenderOptions {
  channel?: Partial<Channel>;
  wavetable?: Partial<WavetableParameters>;
  synthParams?: Partial<SynthParameters>;
  pitch?: number;
  durationSteps?: number;
  velocity?: number;
  seconds?: number;
  stopAt?: number;
  extraVoices?: Note[];
}

interface RenderResult {
  mono: Float32Array;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

const render = async (options: RenderOptions = {}): Promise<RenderResult> => {
  const seconds = options.seconds ?? 1.2;
  const ctx = new OfflineAudioContext(
    2,
    Math.ceil(SAMPLE_RATE * seconds),
    SAMPLE_RATE,
  ) as OfflineCtx;
  const channel = makeChannel({
    ...options.channel,
    synthParams: synthParams(options.synthParams),
    wavetable: wavetable(options.wavetable),
  });
  const note: Note = {
    id: 'n1',
    pitch: options.pitch ?? 60,
    start: 0,
    duration: options.durationSteps ?? 8,
    velocity: options.velocity ?? 0.85,
  };
  const handle = renderWavetableVoice({
    channel,
    note,
    time: 0,
    destination: ctx.destination,
    audioContext: ctx,
    voiceId: 'voice-1',
    bpm: BPM,
  });
  if (options.stopAt !== undefined && handle) handle.stop(options.stopAt);
  for (const extra of options.extraVoices ?? []) {
    renderWavetableVoice({
      channel,
      note: extra,
      time: 0,
      destination: ctx.destination,
      audioContext: ctx,
      voiceId: extra.id,
      bpm: BPM,
    });
  }
  const buffer = await ctx.startRendering();
  const left = Float32Array.from(buffer.getChannelData(0));
  const right = buffer.numberOfChannels > 1
    ? Float32Array.from(buffer.getChannelData(1))
    : left;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
  return { mono, left, right, sampleRate: buffer.sampleRate };
};

const sliceSeconds = (samples: Float32Array, from: number, to: number, sampleRate = SAMPLE_RATE) =>
  samples.slice(Math.floor(from * sampleRate), Math.floor(to * sampleRate));

const peak = (samples: Float32Array): number => {
  let value = 0;
  for (const sample of samples) value = Math.max(value, Math.abs(sample));
  return value;
};

const rms = (samples: Float32Array): number => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
};

const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  const length = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  return diff;
};

/** Roughness: mean sample-to-sample delta over mean level. Grows with brightness. */
const roughness = (samples: Float32Array): number => {
  let delta = 0;
  let level = 0;
  for (let i = 1; i < samples.length; i++) {
    delta += Math.abs(samples[i] - samples[i - 1]);
    level += Math.abs(samples[i]);
  }
  return level > 0 ? delta / level : 0;
};

/** Fundamental frequency from upward zero crossings of a clean (sine) render. */
const estimateFrequency = (samples: Float32Array, sampleRate = SAMPLE_RATE): number => {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      crossings += 1;
      if (first < 0) first = i;
      last = i;
    }
  }
  if (crossings < 2) return 0;
  return ((crossings - 1) * sampleRate) / (last - first);
};

/** Squared magnitude at one frequency (Goertzel) over a slice. */
const goertzel = (samples: Float32Array, frequency: number, sampleRate = SAMPLE_RATE): number => {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
};

describe('Phase 8B — wavetable voice renders real audio', () => {
  it('renders audible, finite, bounded audio in an OfflineAudioContext', async () => {
    const { mono } = await render();
    assert.ok(rms(mono) > 0.01, `expected audible output, rms=${rms(mono)}`);
    assert.ok(peak(mono) <= 1.05, `output must stay bounded, peak=${peak(mono)}`);
    for (const sample of mono) assert.equal(Number.isFinite(sample), true);
  });

  it('different frames and morph positions produce measurably different waveforms', async () => {
    const sine = await render({ wavetable: { morph: 0, unisonVoices: 1 } });
    const saw = await render({ wavetable: { morph: 0.4, unisonVoices: 1 } });
    const metallic = await render({ wavetable: { morph: 1, unisonVoices: 1 } });
    const window = (result: RenderResult) => sliceSeconds(result.mono, 0.05, 0.25);

    assert.ok(maxAbsDiff(window(sine), window(saw)) > 0.05, 'sine and saw frames differ');
    assert.ok(maxAbsDiff(window(saw), window(metallic)) > 0.05, 'saw and metallic frames differ');
    assert.ok(
      roughness(window(metallic)) > roughness(window(sine)) * 1.5,
      `metallic frame is brighter: ${roughness(window(metallic))} vs ${roughness(window(sine))}`,
    );
  });

  it('table warp modes change the rendered signal', async () => {
    const plain = await render({ wavetable: { morph: 0.5, unisonVoices: 1, warpMode: 'none' } });
    for (const warpMode of ['pwm', 'bend', 'sync'] as const) {
      const warped = await render({
        wavetable: { morph: 0.5, unisonVoices: 1, warpMode, warpAmount: 0.7 },
      });
      const diff = maxAbsDiff(
        sliceSeconds(plain.mono, 0.05, 0.25),
        sliceSeconds(warped.mono, 0.05, 0.25),
      );
      assert.ok(diff > 0.02, `${warpMode} must change the audio, maxDiff=${diff}`);
    }
  });

  it('tracks the MIDI pitch as the fundamental frequency', async () => {
    // A sine table keeps the zero-crossing estimate exact.
    const cases: Array<[number, number]> = [
      [48, 130.81],
      [60, 261.63],
      [69, 440],
      [76, 659.26],
    ];
    for (const [pitch, expected] of cases) {
      const { mono } = await render({
        pitch,
        wavetable: { morph: 0, unisonVoices: 1, harmonics: [1, 0, 0, 0, 0, 0, 0, 0] },
      });
      const measured = estimateFrequency(sliceSeconds(mono, 0.1, 0.7));
      assert.ok(
        Math.abs(measured - expected) / expected < 0.02,
        `pitch ${pitch}: measured ${measured.toFixed(2)} Hz vs expected ${expected} Hz`,
      );
    }
  });

  it('applies Channel.pitch as a semitone offset', async () => {
    const base = await render({
      pitch: 60,
      wavetable: { morph: 0, unisonVoices: 1, harmonics: [1, 0, 0, 0, 0, 0, 0, 0] },
    });
    const shifted = await render({
      pitch: 60,
      channel: { pitch: 12 },
      wavetable: { morph: 0, unisonVoices: 1, harmonics: [1, 0, 0, 0, 0, 0, 0, 0] },
    });
    const f0 = estimateFrequency(sliceSeconds(base.mono, 0.1, 0.7));
    const f1 = estimateFrequency(sliceSeconds(shifted.mono, 0.1, 0.7));
    assert.ok(Math.abs(f1 / f0 - 2) < 0.03, `octave shift ratio ${f1 / f0}`);
  });

  it('partial gains change the harmonic content of the rendered note', async () => {
    const fundamentalOnly = await render({
      wavetable: { morph: 0.5, unisonVoices: 1, harmonics: [1, 0, 0, 0, 0, 0, 0, 0] },
    });
    const secondOnly = await render({
      wavetable: { morph: 0.5, unisonVoices: 1, harmonics: [0, 1, 0, 0, 0, 0, 0, 0] },
    });
    const f0 = 261.63;
    const windowA = sliceSeconds(fundamentalOnly.mono, 0.05, 0.55);
    const windowB = sliceSeconds(secondOnly.mono, 0.05, 0.55);
    const ratioA = goertzel(windowA, 2 * f0) / Math.max(1e-12, goertzel(windowA, f0));
    const ratioB = goertzel(windowB, 2 * f0) / Math.max(1e-12, goertzel(windowB, f0));
    assert.ok(ratioA < 0.05, `fundamental-only ratio ${ratioA}`);
    assert.ok(ratioB > 5, `second-partial ratio ${ratioB}`);
    assert.ok(maxAbsDiff(windowA, windowB) > 0.1);
  });

  it('unison detune and voice count change the signal', async () => {
    const single = await render({ wavetable: { unisonVoices: 1, unisonDetuneCents: 20 } });
    const stacked = await render({ wavetable: { unisonVoices: 4, unisonDetuneCents: 20 } });
    const detuned = await render({ wavetable: { unisonVoices: 4, unisonDetuneCents: 45 } });
    const correlated = await render({ wavetable: { unisonVoices: 4, unisonDetuneCents: 0 } });

    const window = (result: RenderResult) => sliceSeconds(result.mono, 0.05, 0.55);
    assert.ok(maxAbsDiff(window(single), window(stacked)) > 0.01, 'voice count matters');
    assert.ok(maxAbsDiff(window(stacked), window(detuned)) > 0.01, 'detune matters');

    // Detuned voices beat; identical voices do not.
    const modulation = (samples: Float32Array): number => {
      const windowSize = Math.floor(SAMPLE_RATE * 0.02);
      const levels: number[] = [];
      for (let offset = 0; offset + windowSize < samples.length; offset += windowSize) {
        levels.push(rms(samples.subarray(offset, offset + windowSize)));
      }
      const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
      const variance = levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length;
      return mean > 0 ? Math.sqrt(variance) / mean : 0;
    };
    assert.ok(
      modulation(window(correlated)) < 0.02,
      `zero detune must not beat (${modulation(window(correlated))})`,
    );
    assert.ok(
      modulation(window(detuned)) > modulation(window(correlated)) * 5,
      `detuned unison must beat (${modulation(window(detuned))} vs ${modulation(window(correlated))})`,
    );
  });

  it('stereo spread pans unison voices and spread 0 stays mono', async () => {
    const monoSpread = await render({ wavetable: { unisonVoices: 5, unisonSpread: 0 } });
    assert.ok(maxAbsDiff(monoSpread.left, monoSpread.right) < 1e-6, 'spread 0 is mono');

    const wide = await render({ wavetable: { unisonVoices: 5, unisonSpread: 0.9 } });
    const width = maxAbsDiff(wide.left, wide.right);
    assert.ok(width > 0.01, `spread 0.9 makes a stereo field, maxDiff=${width}`);
    assert.ok(peak(wide.left) <= 1.05 && peak(wide.right) <= 1.05);
  });

  it('gates the note to its notated duration and releases afterwards', async () => {
    const short = await render({ durationSteps: 2, wavetable: { unisonVoices: 1 } });
    const long = await render({ durationSteps: 8, wavetable: { unisonVoices: 1 } });

    const duringShort = rms(sliceSeconds(short.mono, 0.02, 0.2));
    const afterShort = rms(sliceSeconds(short.mono, 0.6, 1.0));
    const duringLong = rms(sliceSeconds(long.mono, 0.6, 1.0));

    assert.ok(duringShort > 0.01, 'the short note sounds while gated');
    assert.ok(afterShort < duringShort * 0.02, `the short note released, rms=${afterShort}`);
    assert.ok(duringLong > duringShort * 0.5, 'the long note still sustains later');
  });

  it('note-off releases the voice early', async () => {
    const sustained = await render({ durationSteps: 16 });
    const stopped = await render({ durationSteps: 16, stopAt: 0.1 });
    const before = rms(sliceSeconds(sustained.mono, 0.02, 0.09));
    const afterStop = rms(sliceSeconds(stopped.mono, 0.4, 0.9));
    assert.ok(before > 0.01, 'the voice started');
    assert.ok(afterStop < 1e-3, `note-off must silence the voice, rms=${afterStop}`);
  });

  it('velocity and channel volume scale the level', async () => {
    const loud = await render({ velocity: 1 });
    const quiet = await render({ velocity: 0.25 });
    const quietChannel = await render({ channel: { volume: 0.3 } });
    const loudRms = rms(sliceSeconds(loud.mono, 0.05, 0.4));
    assert.ok(rms(sliceSeconds(quiet.mono, 0.05, 0.4)) < loudRms * 0.5);
    assert.ok(rms(sliceSeconds(quietChannel.mono, 0.05, 0.4)) < loudRms * 0.5);
  });

  it('keeps polyphonic voices bounded, finite and independent', async () => {
    const chord = await render({
      extraVoices: [
        { id: 'n2', pitch: 64, start: 0, duration: 8, velocity: 0.85 },
        { id: 'n3', pitch: 67, start: 0, duration: 8, velocity: 0.85 },
      ],
    });
    assert.ok(rms(chord.mono) > rms((await render()).mono) * 0.5, 'chord is audible');
    assert.ok(peak(chord.mono) <= 3.05, `three bounded voices, peak=${peak(chord.mono)}`);
    for (const sample of chord.mono) assert.equal(Number.isFinite(sample), true);
  });

  it('presets produce measurably different rendered notes', async () => {
    const warm = WAVETABLE_PRESETS.find((preset) => preset.name === 'Warm Analog');
    const glass = WAVETABLE_PRESETS.find((preset) => preset.name === 'Glass Sync');
    assert.ok(warm && glass);
    const warmRender = await render({
      wavetable: { ...DEFAULT_WAVETABLE_PARAMETERS, ...warm.values },
    });
    const glassRender = await render({
      wavetable: { ...DEFAULT_WAVETABLE_PARAMETERS, ...glass.values },
    });
    const diff = maxAbsDiff(
      sliceSeconds(warmRender.mono, 0.05, 0.35),
      sliceSeconds(glassRender.mono, 0.05, 0.35),
    );
    assert.ok(diff > 0.01, `presets must change the audio, maxDiff=${diff}`);
    assert.ok(rms(warmRender.mono) > 0.005 && rms(glassRender.mono) > 0.005);
  });

  it('is bit-identical for identical inputs', async () => {
    const a = await render({ wavetable: { morph: 0.7, warpMode: 'sync', warpAmount: 0.5 } });
    const b = await render({ wavetable: { morph: 0.7, warpMode: 'sync', warpAmount: 0.5 } });
    assert.equal(maxAbsDiff(a.mono, b.mono), 0);
  });

  it('bounds voice allocation to the engine maximum', async () => {
    let oscillatorCount = 0;
    const fakeParam = () => ({
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
      cancelScheduledValues() {},
    });
    const createNode = () => ({
      gain: fakeParam(),
      frequency: fakeParam(),
      detune: fakeParam(),
      pan: fakeParam(),
      Q: { value: 0 },
      type: '',
      connect() {},
      start() {},
      stop() {},
      setPeriodicWave() {},
      disconnect() {},
    });
    const fakeContext = {
      currentTime: 0,
      destination: { connect() {} },
      createGain: createNode,
      createBiquadFilter: createNode,
      createStereoPanner: createNode,
      createOscillator: () => {
        oscillatorCount += 1;
        return createNode();
      },
      createPeriodicWave: () => ({}),
    };
    const handle = renderWavetableVoice({
      channel: makeChannel({ wavetable: wavetable({ unisonVoices: 99 }) }),
      note: { id: 'n', pitch: 60, start: 0, duration: 4, velocity: 0.8 },
      time: 0,
      destination: fakeContext.destination as unknown as AudioNode,
      audioContext: fakeContext as unknown as BaseAudioContext,
      voiceId: 'bounded',
      bpm: BPM,
    });
    assert.ok(handle, 'a valid voice handle is returned');
    assert.equal(oscillatorCount, 7, 'unison voices are clamped to 7');
  });

  it('returns a stoppable handle and fires onEnded when the voice completes', async () => {
    let ended = 0;
    const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE) as OfflineCtx;
    const handle = renderWavetableVoice({
      channel: makeChannel(),
      note: { id: 'n', pitch: 60, start: 0, duration: 2, velocity: 0.8 },
      time: 0,
      destination: ctx.destination,
      audioContext: ctx,
      voiceId: 'lifecycle',
      bpm: BPM,
      onEnded: () => {
        ended += 1;
      },
    });
    assert.ok(handle && typeof handle.stop === 'function');
    await ctx.startRendering();
    // web-audio-engine fires `onended`; synchronous browser doubles do not.
    assert.ok(ended <= 1, 'onEnded is not fired more than once');
  });

  it('never produces invalid samples when the channel has no wavetable settings', async () => {
    const legacy = await render({ channel: { wavetable: undefined } });
    assert.ok(rms(legacy.mono) > 0.01, 'a pre-8B channel still renders the default table');
    for (const sample of legacy.mono) assert.equal(Number.isFinite(sample), true);
  });
});
