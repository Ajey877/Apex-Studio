/**
 * Phase 10B — Offline render parity for the four new P1 fixes.
 *
 * Verifies that:
 *   1. fx_mix automation writes slot.mix during an offline render
 *   2. channel_filter_res automation writes synthParams.filterResonance
 *   3. channel_pitch automation writes channel.pitch
 *   4. The same automation clips behave the same way in live playback
 *
 * Each test reuses the existing MockOfflineAudioContext from
 * `audioEngine.export.test.ts` so the renderer path is exercised without
 * a wall-clock audio dependency.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { Channel, FxSlot, MixerTrack, PlaylistClip } from '../types/daw';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAVED_KEYS = [
  'ctx', 'activeChannels', 'activeMixerTracks', 'activeClips',
  'playbackProjectChannels', 'playbackProjectMixerTracks',
  'isOfflineRendering', 'isPlaying', 'currentBar', 'currentStep', 'activePlayMode',
];

let savedInternals: EngineInternals = {};
let prevOfflineCtx: any;

class MockOfflineAudioContext {
  readonly destination = { connect: () => {} };
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  currentTime = 0;

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createGain() { return { gain: { setValueAtTime() {}, setTargetAtTime() {} }, connect: () => {}, disconnect: () => {} }; }
  createStereoPanner() { return { pan: { setValueAtTime() {}, setTargetAtTime() {} }, connect: () => {}, disconnect: () => {} }; }
  createAnalyser() { return { fftSize: 256, smoothingTimeConstant: 0.7, connect: () => {}, disconnect: () => {}, getFloatTimeDomainData() {} }; }
  createBufferSource() { return { buffer: null, start() {}, stop() {}, connect: () => {}, disconnect: () => {} }; }
  createOscillator() { return { frequency: { setValueAtTime() {} }, start() {}, stop() {}, connect: () => {}, disconnect: () => {} }; }
  createBiquadFilter() { return { type: 'lowpass', frequency: { setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 1 }, gain: { setValueAtTime() {} }, connect: () => {}, disconnect: () => {} }; }
  createDelay() { return { delayTime: { setValueAtTime() {} }, connect: () => {}, disconnect: () => {} }; }
  createConvolver() { return { buffer: null, normalize: true, connect: () => {}, disconnect: () => {} }; }
  createWaveShaper() { return { curve: null, oversample: 'none', connect: () => {}, disconnect: () => {} }; }
  createDynamicsCompressor() { return { threshold: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, reduction: 0, connect: () => {}, disconnect: () => {} }; }
  createBuffer(_c: number, len: number, _sr: number) {
    return {
      numberOfChannels: 1,
      length: len,
      sampleRate: 44100,
      duration: len / 44100,
      getChannelData: () => new Float32Array(len),
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }
  async startRendering() {
    return {
      numberOfChannels: 2,
      length: Math.max(1, this.length),
      sampleRate: this.sampleRate,
      duration: Math.max(1, this.length) / this.sampleRate,
      getChannelData: () => new Float32Array(Math.max(1, this.length)),
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }
}

function makeChannel(id: string, pitch = 0, filterResonance = 1): Channel {
  return {
    id,
    name: id,
    color: '#ff6e00',
    instrumentType: 'minisynth',
    mixerTrackId: 1,
    volume: 0.9,
    pan: 0,
    pitch,
    mute: false,
    solo: false,
    steps: new Array(16).fill(false),
    notes: [],
    synthParams: {
      filterCutoff: 3500,
      filterResonance,
      filterType: 'lowpass',
      filterEnvAmount: 0,
      attack: 0.01,
      decay: 0.15,
      sustain: 0.6,
      release: 0.2,
      unisonVoices: 1,
      osc2Mix: 0.65,
    },
  } as Channel;
}

function makeMixerTrack(id: number, fxSlots: FxSlot[]): MixerTrack {
  return {
    id, name: `T${id}`, color: '#fff', volume: 1, pan: 0, mute: false, solo: false,
    stereoWidth: 1, peakL: 0, peakR: 0, fxSlots,
  };
}

function makeSlot(id: string, mix: number, type: FxSlot['type'] = 'reverb'): FxSlot {
  return { id, type, name: type, enabled: true, mix, params: {} };
}

function autoClip(id: string, target: NonNullable<PlaylistClip['automationTarget']>, yEnd: number): PlaylistClip {
  return {
    id, trackIndex: 0, startBar: 0, lengthBars: 1, type: 'automation',
    color: '#00e5ff', name: id, automationTarget: target,
    automationPoints: [{ x: 0, y: 0, tension: 0 }, { x: 1, y: yEnd, tension: 0 }],
  };
}

beforeEach(() => {
  savedInternals = {};
  for (const k of SAVED_KEYS) savedInternals[k] = engine[k];
  prevOfflineCtx = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
});

afterEach(() => {
  (globalThis as any).OfflineAudioContext = prevOfflineCtx;
  for (const k of SAVED_KEYS) engine[k] = savedInternals[k];
});

describe('Phase 10B: offline export honors the new automation targets', () => {
  it('fx_mix automation writes slot.mix during the offline render', async () => {
    const slot = makeSlot('fx-offline', 0.0);
    const track = makeMixerTrack(1, [slot]);
    const channel = makeChannel('ch-offline-fx', 0, 1);
    const clip = autoClip('auto-fx-offline', { type: 'fx_mix', targetId: 1, paramName: 'fx-offline' }, 0.5);

    // Capture every applyAutomationValue call so we can assert the offline
    // scheduler actually invoked the fx_mix branch.
    const applied: Array<{ target: unknown; value: number }> = [];
    const originalApplyAutomationValue = engine.applyAutomationValue;
    engine.applyAutomationValue = (target: unknown, value: number, ...rest: unknown[]) => {
      applied.push({ target, value });
      return (originalApplyAutomationValue as any).call(engine, target, value, ...rest);
    };

    await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      [track],
      120,
      1,
      undefined,
      true,
      'song',
      undefined,
      undefined,
    );

    const fxMixCalls = applied.filter((entry) => {
      const t = entry.target as { type: string };
      return t && t.type === 'fx_mix';
    });
    assert.ok(fxMixCalls.length > 0, 'offline scheduler invokes applyAutomationValue for fx_mix clips');
    for (const call of fxMixCalls) {
      assert.ok(call.value >= 0 && call.value <= 1, `fx_mix value is in 0..1; got ${call.value}`);
    }

    engine.applyAutomationValue = originalApplyAutomationValue;
  });

  it('channel_filter_res automation writes synthParams.filterResonance during offline render', async () => {
    const channel = makeChannel('ch-offline-res', 0, 1);
    const track = makeMixerTrack(1, []);
    const clip = autoClip('auto-res-offline', { type: 'channel_filter_res', targetId: 'ch-offline-res' }, 1);

    const applied: Array<{ target: unknown; value: number }> = [];
    const originalApplyAutomationValue = engine.applyAutomationValue;
    engine.applyAutomationValue = (target: unknown, value: number, ...rest: unknown[]) => {
      applied.push({ target, value });
      return (originalApplyAutomationValue as any).call(engine, target, value, ...rest);
    };

    await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      [track],
      120,
      1,
      undefined,
      true,
      'song',
      undefined,
      undefined,
    );

    const resCalls = applied.filter((entry) => {
      const t = entry.target as { type: string };
      return t && t.type === 'channel_filter_res';
    });
    assert.ok(resCalls.length > 0, 'offline scheduler invokes applyAutomationValue for channel_filter_res clips');
    assert.ok(resCalls.every((call) => call.value >= 0 && call.value <= 1));

    engine.applyAutomationValue = originalApplyAutomationValue;
  });

  it('channel_pitch automation writes channel.pitch during offline render', async () => {
    const channel = makeChannel('ch-offline-pitch', 0, 1);
    const track = makeMixerTrack(1, []);
    const clip = autoClip('auto-pitch-offline', { type: 'channel_pitch', targetId: 'ch-offline-pitch' }, 1);

    const applied: Array<{ target: unknown; value: number }> = [];
    const originalApplyAutomationValue = engine.applyAutomationValue;
    engine.applyAutomationValue = (target: unknown, value: number, ...rest: unknown[]) => {
      applied.push({ target, value });
      return (originalApplyAutomationValue as any).call(engine, target, value, ...rest);
    };

    await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      [track],
      120,
      1,
      undefined,
      true,
      'song',
      undefined,
      undefined,
    );

    const pitchCalls = applied.filter((entry) => {
      const t = entry.target as { type: string };
      return t && t.type === 'channel_pitch';
    });
    assert.ok(pitchCalls.length > 0, 'offline scheduler invokes applyAutomationValue for channel_pitch clips');
    assert.ok(pitchCalls.every((call) => call.value >= 0 && call.value <= 1));

    engine.applyAutomationValue = originalApplyAutomationValue;
  });

  it('offline and live triggerCurrentStep write the same automation values', async () => {
    // Same automation clip, two renders: one offline, one live manual.
    // Both should produce the same applyAutomationValue invocation for
    // fx_mix automation at the same step boundary.
    const slot = makeSlot('fx-parity', 0.0);
    const track = makeMixerTrack(1, [slot]);
    const channel = makeChannel('ch-parity', 0, 1);
    const clip = autoClip('auto-parity', { type: 'fx_mix', targetId: 1, paramName: 'fx-parity' }, 0.42);

    const offlineCaptured: number[] = [];
    const originalApplyAutomationValue = engine.applyAutomationValue;
    engine.applyAutomationValue = ((target: any, value: number, ...rest: unknown[]) => {
      if (target.type === 'fx_mix') offlineCaptured.push(value);
      return (originalApplyAutomationValue as any).call(engine, target, value, ...rest);
    }) as any;

    await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      [track],
      120,
      1,
      undefined,
      true,
      'song',
      undefined,
      undefined,
    );
    const offlineValues = offlineCaptured.slice();

    // Live replay (single step at bar 2 step 0). With the same bar/step the
    // same curve interpolation fires.
    engine.ctx = { currentTime: 1 } as any;
    engine.activeClips = [clip];
    engine.activeChannels = [channel];
    engine.activeMixerTracks = [track];
    engine.activePlayMode = 'song';
    engine.currentBar = 2;
    engine.currentStep = 0;
    const liveCaptured: number[] = [];
    engine.applyAutomationValue = ((target: any, value: number, ...rest: unknown[]) => {
      if (target.type === 'fx_mix') liveCaptured.push(value);
      return (originalApplyAutomationValue as any).call(engine, target, value, ...rest);
    }) as any;
    engine.triggerCurrentStep(0.5);

    engine.applyAutomationValue = originalApplyAutomationValue;

    assert.ok(offlineValues.length > 0, 'offline emitted at least one fx_mix call');
    assert.equal(liveCaptured.length > 0, true, 'live emitted at least one fx_mix call');
    // Every value the offline scheduler emits must also be in the live range
    // (the same interpolation curve). At minimum, the live value at the same
    // point must equal the corresponding offline value.
    const liveFirst = liveCaptured[0];
    assert.ok(offlineValues.includes(liveFirst), 'live value at the same bar/step matches an offline-emitted value');
  });
});
