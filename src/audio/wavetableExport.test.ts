/**
 * Phase 8B — the wavetable instrument through the real timeline export path.
 *
 * `renderTimelineOffline` is the production WAV-export renderer; it schedules
 * every note through `AudioEngine.playNote` → `InstrumentRegistry` → the
 * instrument renderer. These tests run that path against a real
 * `OfflineAudioContext` (web-audio-engine, as `scripts/realOfflineRenderNode.mjs`
 * does), so they prove the `wavetable` registration produces actual PCM in an
 * export — not just that a factory was wired into a mocked graph.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as Engine from 'web-audio-engine';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';
import { DEFAULT_WAVETABLE_PARAMETERS, normalizeWavetableParameters } from './wavetableTables';

const engineModule = Engine as unknown as {
  OfflineAudioContext: new (channels: number, length: number, sampleRate: number) => BaseAudioContext;
  WebAudioContext?: typeof AudioContext;
  RenderingAudioContext?: typeof AudioContext;
  StreamAudioContext?: typeof AudioContext;
};

// audioEngine resolves the AudioContext globals at call time, exactly like the
// existing Node fallback harness; install them before importing the engine.
const globals = globalThis as Record<string, unknown>;
globals.OfflineAudioContext = engineModule.OfflineAudioContext;
globals.AudioContext =
  engineModule.WebAudioContext ?? engineModule.RenderingAudioContext ?? engineModule.StreamAudioContext;
if (!globals.window) globals.window = globals;
const windowLike = globals.window as Record<string, unknown>;
windowLike.OfflineAudioContext = engineModule.OfflineAudioContext;
windowLike.AudioContext = globals.AudioContext;
windowLike.webkitAudioContext = globals.AudioContext;
windowLike.webkitOfflineAudioContext = engineModule.OfflineAudioContext;
if (!globals.document) {
  globals.document = { createElement: () => ({}) };
}
if (!globals.navigator) {
  Object.defineProperty(globals, 'navigator', {
    value: { userAgent: 'node' },
    writable: true,
    configurable: true,
  });
}

const { audioEngine } = await import('./audioEngine');

const SAMPLE_RATE = 44100;
const BPM = 120;

const mixerTracks = (): MixerTrack[] => [
  {
    id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false,
    peakL: 0, peakR: 0, fxSlots: [],
  },
  {
    id: 1, name: 'WT Insert', color: '#10b981', volume: 1, pan: 0, mute: false, solo: false,
    peakL: 0, peakR: 0, fxSlots: [],
  },
];

const makeChannel = (instrumentType: Channel['instrumentType'], patch: Partial<Channel> = {}): Channel => ({
  id: `ch-${instrumentType}`,
  name: `Ch ${instrumentType}`,
  color: '#10b981',
  instrumentType,
  mixerTrackId: 1,
  volume: 0.85,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: Array(16).fill(false),
  notes: [
    { id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
    { id: 'n2', pitch: 67, start: 4, duration: 4, velocity: 0.8 },
  ],
  synthParams: audioEngine.getDefaultSynthParams(),
  wavetable: normalizeWavetableParameters(DEFAULT_WAVETABLE_PARAMETERS),
  ...patch,
});

const clipFor = (channel: Channel): PlaylistClip => ({
  id: `clip-${channel.id}`,
  trackIndex: 0,
  startBar: 0,
  lengthBars: 1,
  type: 'pattern',
  channelId: channel.id,
  color: channel.color,
  name: 'Wavetable clip',
});

interface Stats {
  peak: number;
  rms: number;
  finite: boolean;
  length: number;
}

const stats = (buffer: AudioBuffer): Stats => {
  const data = buffer.getChannelData(0);
  let peak = 0;
  let sum = 0;
  let finite = true;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (!Number.isFinite(value)) finite = false;
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  return { peak, rms: Math.sqrt(sum / data.length), finite, length: data.length };
};

const maxAbsDiff = (a: AudioBuffer, b: AudioBuffer): number => {
  const left = a.getChannelData(0);
  const right = b.getChannelData(0);
  let diff = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    diff = Math.max(diff, Math.abs(left[i] - right[i]));
  }
  return diff;
};

const renderChannel = async (channel: Channel): Promise<AudioBuffer> =>
  audioEngine.renderTimelineOffline(
    [channel],
    [clipFor(channel)],
    mixerTracks(),
    BPM,
    1,
    SAMPLE_RATE,
    false,
    'song',
    undefined,
    4,
  );

before(() => {
  audioEngine.setTimeSignature([4, 4]);
});

describe('Phase 8B — wavetable export path', () => {
  it('renders the wavetable instrument audibly through renderTimelineOffline', async () => {
    const rendered = await renderChannel(makeChannel('wavetable'));
    const result = stats(rendered);
    assert.ok(result.finite, 'export contains no NaN/Infinity samples');
    assert.ok(result.rms > 1e-3, `export should be audible, rms=${result.rms}`);
    assert.ok(result.peak <= 2, `export must stay bounded, peak=${result.peak}`);
  });

  it('uses the wavetable renderer, not the subtractive one', async () => {
    // Same channel, same notes, same synth/filter/envelope settings: only the
    // registered instrument renderer differs.
    const wavetable = await renderChannel(makeChannel('wavetable'));
    const subtractive = await renderChannel(makeChannel('minisynth'));
    const diff = maxAbsDiff(wavetable, subtractive);
    assert.ok(diff > 0.005, `wavetable and minisynth exports must differ, maxDiff=${diff}`);
    assert.ok(stats(subtractive).rms > 1e-3, 'the control render is audible');
  });

  it('exported sound follows the saved morph, warp and partial settings', async () => {
    const sine = await renderChannel(
      makeChannel('wavetable', {
        wavetable: normalizeWavetableParameters({
          ...DEFAULT_WAVETABLE_PARAMETERS,
          morph: 0,
          unisonVoices: 1,
          harmonics: [1, 0, 0, 0, 0, 0, 0, 0],
        }),
      }),
    );
    const metallic = await renderChannel(
      makeChannel('wavetable', {
        wavetable: normalizeWavetableParameters({
          ...DEFAULT_WAVETABLE_PARAMETERS,
          morph: 1,
          unisonVoices: 1,
          harmonics: [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
        }),
      }),
    );
    const warped = await renderChannel(
      makeChannel('wavetable', {
        wavetable: normalizeWavetableParameters({
          ...DEFAULT_WAVETABLE_PARAMETERS,
          morph: 0.5,
          warpMode: 'sync',
          warpAmount: 0.8,
          unisonVoices: 1,
        }),
      }),
    );
    const plain = await renderChannel(
      makeChannel('wavetable', {
        wavetable: normalizeWavetableParameters({
          ...DEFAULT_WAVETABLE_PARAMETERS,
          morph: 0.5,
          unisonVoices: 1,
        }),
      }),
    );

    assert.ok(maxAbsDiff(sine, metallic) > 0.01, 'morph changes the exported signal');
    assert.ok(maxAbsDiff(plain, warped) > 0.01, 'warp changes the exported signal');
    assert.ok(stats(sine).rms > 1e-3 && stats(metallic).rms > 1e-3 && stats(warped).rms > 1e-3);
  });

  it('keeps exported note durations and gaps from the pattern', async () => {
    const gapped = makeChannel('wavetable', {
      notes: [
        { id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.9 },
        { id: 'n2', pitch: 60, start: 12, duration: 1, velocity: 0.9 },
      ],
    });
    const sustained = makeChannel('wavetable', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 16, velocity: 0.9 }],
    });
    const gappedBuffer = await renderChannel(gapped);
    const sustainedBuffer = await renderChannel(sustained);
    const windowRms = (buffer: AudioBuffer, fromSeconds: number, toSeconds: number): number => {
      const data = buffer.getChannelData(0);
      const from = Math.floor(fromSeconds * buffer.sampleRate);
      const to = Math.min(data.length, Math.floor(toSeconds * buffer.sampleRate));
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    // Between the two short notes (bar 1, 4/4 at 120 BPM → 2 s) the gapped
    // render is silent after the first note's release, while the sustained
    // note is still sounding.
    assert.ok(windowRms(gappedBuffer, 0.6, 1.3) < 1e-3, 'gap between short notes is silent');
    assert.ok(
      windowRms(sustainedBuffer, 0.6, 1.3) > windowRms(gappedBuffer, 0.6, 1.3) * 10,
      'a longer note is still sounding in the same window',
    );
  });

  it('is deterministic across repeated exports', async () => {
    const channel = makeChannel('wavetable', {
      wavetable: normalizeWavetableParameters({
        ...DEFAULT_WAVETABLE_PARAMETERS,
        morph: 0.63,
        warpMode: 'bend',
        warpAmount: 0.4,
        unisonVoices: 5,
        unisonDetuneCents: 18,
        unisonSpread: 0.4,
      }),
    });
    const first = await renderChannel(channel);
    const second = await renderChannel(channel);
    assert.equal(maxAbsDiff(first, second), 0, 'two exports must be bit-identical');
  });

  it('leaves the other instruments on their own renderers', async () => {
    for (const instrumentType of ['minisynth', 'fmsynth', 'supersaw_lead'] as const) {
      const rendered = await renderChannel(makeChannel(instrumentType));
      const result = stats(rendered);
      assert.ok(result.finite, `${instrumentType} export stays finite`);
      assert.ok(result.rms > 1e-4, `${instrumentType} export is audible`);
    }
  });
});
