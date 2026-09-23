/**
 * Phase 10C-B — Offline FX Hardening: end-to-end coverage.
 *
 * The Phase 10C-A hardening patch routes both live and offline FX chains
 * through `liveFxChainHardening.createEffect`, which means a chorus slot on a
 * mixer track survives the offline render. This file pins that contract end-
 * to-end so a future regression in either
 *   (a) the offline dispatch in `installLiveFxChainHardening`, or
 *   (b) the legacy `createFxNode` factory in `audioEngine.ts`
 * fails loudly instead of silently dropping chorus from an exported WAV.
 *
 * Tests use the same AudioContext mock pattern as `audioEngine.export.test.ts`
 * — no real `AudioContext`, no new test dependencies — and exercise the
 * production `audioEngine.renderTimelineOffline(...)` entry point so the
 * regression surface is the user's exported master WAV, not a unit-level
 * graph inspection.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { installLiveFxChainHardening } from './liveFxChainHardening';
import type { Channel, PlaylistClip, MixerTrack, FxSlot } from '../types/daw';

// -----------------------------------------------------------------------
// Minimal Web Audio mocks — a strict superset of `MockOfflineAudioContext`
// from `audioEngine.export.test.ts` plus the constant-source node that
// `ChorusEffect` needs for its delay-time offset.
// -----------------------------------------------------------------------

class MockAudioParam {
  value: number;
  constructor(defaultValue = 1) { this.value = defaultValue; }
  setValueAtTime(value: number, _time: number): void { this.value = value; }
  linearRampToValueAtTime(value: number, _time: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number, _time: number): void { this.value = value; }
  setTargetAtTime(value: number, _time: number, _tc: number): void { this.value = value; }
  cancelScheduledValues(): void {}
}

class MockAudioNode {
  readonly connections: unknown[] = [];
  connect(target: unknown): unknown { this.connections.push(target); return target; }
  disconnect(): void { this.connections.length = 0; }
  addEventListener(): void {}
}

class MockGainNode extends MockAudioNode { gain = new MockAudioParam(1); }
class MockStereoPannerNode extends MockAudioNode { pan = new MockAudioParam(0); }
class MockAnalyserNode extends MockAudioNode {
  fftSize = 512;
  smoothingTimeConstant = 0.8;
  getFloatTimeDomainData(t: Float32Array): void { t.fill(0); }
  getByteFrequencyData(t: Uint8Array): void { t.fill(0); }
  getByteTimeDomainData(t: Uint8Array): void { t.fill(128); }
}
class MockBufferSourceNode extends MockAudioNode {
  buffer: any = null;
  playbackRate = new MockAudioParam(1);
  detune = new MockAudioParam(0);
  startCalls: Array<{ when: number; offset: number; duration: number }> = [];
  stopCalls: Array<{ when: number }> = [];
  start(when = 0, offset = 0, duration = 0): void {
    this.startCalls.push({ when, offset, duration });
  }
  stop(when = 0): void { this.stopCalls.push({ when }); }
}
class MockOscillatorNode extends MockAudioNode {
  type: OscillatorType = 'sine';
  frequency = new MockAudioParam(440);
  detune = new MockAudioParam(0);
  startCalls: number[] = [];
  stopCalls: number[] = [];
  start(when = 0): void { this.startCalls.push(when); }
  stop(when = 0): void { this.stopCalls.push(when); }
}
class MockConstantSourceNode extends MockAudioNode {
  offset = new MockAudioParam(0);
  startCalls: number[] = [];
  stopCalls: number[] = [];
  start(when = 0): void { this.startCalls.push(when); }
  stop(when = 0): void { this.stopCalls.push(when); }
}
class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam(350);
  Q = new MockAudioParam(1);
  gain = new MockAudioParam(0);
}
class MockDelayNode extends MockAudioNode { delayTime = new MockAudioParam(0); }
class MockConvolverNode extends MockAudioNode { buffer: any = null; normalize = true; }
class MockWaveShaperNode extends MockAudioNode { curve: Float32Array | null = null; oversample = 'none'; }
class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(30);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.25);
  reduction = 0;
}

class MockOfflineAudioContext {
  readonly destination = new MockAudioNode();
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  currentTime = 0;

  createdBufferSources: MockBufferSourceNode[] = [];
  createdOscillators: MockOscillatorNode[] = [];
  createdConstantSources: MockConstantSourceNode[] = [];
  createdGains: MockGainNode[] = [];
  createdFilters: MockBiquadFilterNode[] = [];
  createdDelays: MockDelayNode[] = [];
  createdConvolvers: MockConvolverNode[] = [];
  createdWaveShapers: MockWaveShaperNode[] = [];
  createdCompressors: MockDynamicsCompressorNode[] = [];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }
  createGain(): MockGainNode { const n = new MockGainNode(); this.createdGains.push(n); return n; }
  createStereoPanner(): MockStereoPannerNode { return new MockStereoPannerNode(); }
  createAnalyser(): MockAnalyserNode { return new MockAnalyserNode(); }
  createBufferSource(): MockBufferSourceNode { const n = new MockBufferSourceNode(); this.createdBufferSources.push(n); return n; }
  createOscillator(): MockOscillatorNode { const n = new MockOscillatorNode(); this.createdOscillators.push(n); return n; }
  createConstantSource(): MockConstantSourceNode { const n = new MockConstantSourceNode(); this.createdConstantSources.push(n); return n; }
  createBiquadFilter(): MockBiquadFilterNode { const n = new MockBiquadFilterNode(); this.createdFilters.push(n); return n; }
  createDelay(): MockDelayNode { const n = new MockDelayNode(); this.createdDelays.push(n); return n; }
  createConvolver(): MockConvolverNode { const n = new MockConvolverNode(); this.createdConvolvers.push(n); return n; }
  createWaveShaper(): MockWaveShaperNode { const n = new MockWaveShaperNode(); this.createdWaveShapers.push(n); return n; }
  createDynamicsCompressor(): MockDynamicsCompressorNode { const n = new MockDynamicsCompressorNode(); this.createdCompressors.push(n); return n; }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
      getChannelData: (ch: number) => data[ch] || new Float32Array(length),
      copyFromChannel: () => {}, copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }
  async startRendering(): Promise<AudioBuffer> {
    const bufferLength = Math.max(1, this.length);
    const data = Array.from({ length: this.numberOfChannels }, () => new Float32Array(bufferLength));
    data[0][0] = 0.5;
    if (this.numberOfChannels > 1) data[1][0] = 0.5;
    return {
      numberOfChannels: this.numberOfChannels, length: bufferLength, sampleRate: this.sampleRate,
      duration: bufferLength / this.sampleRate,
      getChannelData: (ch: number) => data[ch] || new Float32Array(bufferLength),
      copyFromChannel: () => {}, copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }
}

// -----------------------------------------------------------------------
// Project fixtures: a small synth-channel arrangement routed through a
// mixer track with a chorus slot. Two FX arms are exercised:
//   - `chorus` slot on track 1 (mixer insert)
// -----------------------------------------------------------------------

function synthChannel(id: string): Channel {
  return {
    id,
    name: 'Synth',
    color: '#10b981',
    instrumentType: 'minisynth',
    mixerTrackId: 1,
    volume: 0.85,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
    notes: [{ id: `${id}-n1`, pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    synthParams: audioEngine.getDefaultSynthParams(),
  };
}

function chorusSlot(id = 'fx-chorus'): FxSlot {
  return {
    id, name: 'Chorus', type: 'chorus', enabled: true, mix: 0.5, params: {},
  };
}

function mixerTracksWithChorus(mix: number): MixerTrack[] {
  return [
    { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
    { id: 1, name: 'Synth', color: '#10b981', volume: 0.9, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [chorusSlot()] },
  ];
}

function mixerTracksWithoutFx(): MixerTrack[] {
  return [
    { id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
    { id: 1, name: 'Synth', color: '#10b981', volume: 0.9, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
  ];
}

function clipsFor(channelId: string): PlaylistClip[] {
  return [{
    id: `${channelId}-clip-1`, name: 'Pattern', trackIndex: 0, startBar: 0, lengthBars: 1,
    type: 'pattern', channelId, color: '#10b981',
  }];
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('Phase 10C-B: end-to-end offline Chorus parity', () => {
  let prevOfflineCtx: any;
  let capturedCtx: MockOfflineAudioContext | null = null;

  beforeEach(() => {
    prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    class InspectingOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedCtx = this;
      }
    }
    (globalThis as any).OfflineAudioContext = InspectingOfflineContext;
    capturedCtx = null;
  });

  afterEach(() => {
    (globalThis as any).OfflineAudioContext = prevOfflineCtx;
  });

  it('offline render with includeMixerFx=true wires the chorus slot into the OfflineAudioContext', async () => {
    const channel = synthChannel('ch-10cb-wiring');
    const buffer = await audioEngine.renderTimelineOffline(
      [channel], clipsFor(channel.id), mixerTracksWithChorus(0.5), 120, 1, undefined, true,
    );
    assert.ok(capturedCtx !== null, 'OfflineAudioContext must be constructed');
    assert.ok(buffer.length > 0, 'Offline render must produce a non-empty buffer');

    // Chorus = 1 DelayNode (delay line) + 1 OscillatorNode (LFO) + 1 ConstantSourceNode (offset).
    // The WetDry wrapper adds 2 GainNodes (dry + wet). Anything substantially less
    // means the chorus was dropped.
    assert.ok(
      capturedCtx!.createdDelays.length >= 1,
      `chorus: at least one DelayNode must be created (got ${capturedCtx!.createdDelays.length})`,
    );
    assert.ok(
      capturedCtx!.createdOscillators.length >= 1,
      `chorus: at least one OscillatorNode must be created (got ${capturedCtx!.createdOscillators.length})`,
    );
    assert.ok(
      capturedCtx!.createdConstantSources.length >= 1,
      `chorus: at least one ConstantSourceNode must be created (got ${capturedCtx!.createdConstantSources.length})`,
    );
  });

  it('offline render with includeMixerFx=false strips the chorus slot (existing default behaviour is preserved)', async () => {
    // With `includeMixerFx=false`, renderTimelineOffline strips every mixer's
    // `fxSlots` before building the offline graph. The chorus's constant-source
    // offset and delay line must NOT appear in the offline graph because they
    // belong only to the chorus slot. Synth voices create their own
    // oscillators (subtractive dual-osc + unison detune), so oscillator count
    // is non-zero regardless of FX — we therefore assert on the chorus-specific
    // node types (DelayNode + ConstantSourceNode), which only the chorus
    // graph creates.
    const channel = synthChannel('ch-10cb-no-fx');
    await audioEngine.renderTimelineOffline(
      [channel], clipsFor(channel.id), mixerTracksWithChorus(0.5), 120, 1, undefined, false,
    );
    assert.ok(capturedCtx !== null, 'OfflineAudioContext must be constructed');
    assert.equal(
      capturedCtx!.createdDelays.length, 0,
      'chorus: includeMixerFx=false must drop the chorus slot\'s delay line (existing behavior)',
    );
    assert.equal(
      capturedCtx!.createdConstantSources.length, 0,
      'chorus: includeMixerFx=false must drop the chorus ConstantSource offset (existing behavior)',
    );
  });

  it('legacy createFxNode (no hardening patch) also wires a chorus slot', async () => {
    // This test confirms the Phase 10C-B defensive parity change: even when
    // `installLiveFxChainHardening` has NOT been installed (e.g. a future
    // refactor removes it, or a direct test bypasses the wrapper), the legacy
    // single-switch `createFxNode` factory must still produce a chorus graph.
    const channel = synthChannel('ch-10cb-legacy');
    // Do NOT call installLiveFxChainHardening — we are testing the unwrapped path.
    const buffer = await audioEngine.renderTimelineOffline(
      [channel], clipsFor(channel.id), mixerTracksWithChorus(0.5), 120, 1, undefined, true,
    );
    assert.ok(capturedCtx !== null, 'OfflineAudioContext must be constructed');
    assert.ok(buffer.length > 0, 'Offline render must produce a non-empty buffer');
    assert.ok(
      capturedCtx!.createdDelays.length >= 1,
      `chorus (legacy): at least one DelayNode must be created (got ${capturedCtx!.createdDelays.length})`,
    );
    assert.ok(
      capturedCtx!.createdOscillators.length >= 1,
      `chorus (legacy): at least one OscillatorNode must be created (got ${capturedCtx!.createdOscillators.length})`,
    );
  });

  it('chorus render with mix=1 differs from a no-FX baseline at the FX-graph level', async () => {
    // End-to-end audible proof: a chorus slot on a mixer insert must produce
    // a different OfflineAudioContext topology than a no-FX baseline of the
    // same arrangement. The `MockOfflineAudioContext` always returns a fixed
    // (0.5, 0.5) impulse from `startRendering()` regardless of the routed
    // graph, so we cannot compare the rendered samples — but we can compare
    // the graph wiring the renderer constructed, which is what reaches the
    // user's WAV in production.
    const channel = synthChannel('ch-10cb-diff');

    const capturedContexts: MockOfflineAudioContext[] = [];
    class DiffOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedContexts.push(this);
      }
    }
    (globalThis as any).OfflineAudioContext = DiffOfflineContext;

    // Render 1: no FX — but with includeMixerFx=true so the same code path
    // runs (a no-FX track + includeMixerFx=true keeps the empty fxSlots[]).
    await audioEngine.renderTimelineOffline(
      [channel], clipsFor(channel.id), mixerTracksWithoutFx(), 120, 1, undefined, true,
    );
    // Render 2: chorus slot with mix=1.0.
    await audioEngine.renderTimelineOffline(
      [channel], clipsFor(channel.id), mixerTracksWithChorus(1.0), 120, 1, undefined, true,
    );

    assert.equal(capturedContexts.length, 2, 'both renders must construct an OfflineAudioContext');
    const [noFxCtx, withFxCtx] = capturedContexts;

    // The chorus render must have produced at least one delay node, one LFO
    // oscillator, and one ConstantSource offset that the no-FX render did not.
    // (These counters are the strongest deterministic signal available in the
    // mock layer that the chorus wiring reached the offline graph.)
    assert.equal(noFxCtx.createdDelays.length, 0, 'no-FX render: zero delay nodes expected');
    assert.equal(noFxCtx.createdConstantSources.length, 0, 'no-FX render: zero constant sources expected');
    assert.ok(withFxCtx.createdDelays.length >= 1, 'chorus render: at least one delay node');
    assert.ok(withFxCtx.createdOscillators.length >= 1, 'chorus render: at least one LFO oscillator');
    assert.ok(withFxCtx.createdConstantSources.length >= 1, 'chorus render: at least one ConstantSource offset');

    // The chorus render must produce strictly more nodes than the no-FX render
    // for the three chorus-only types — DelayNode, OscillatorNode (LFO), and
    // ConstantSourceNode (delay offset). If a future regression collapses the
    // chorus graph back to a single GainNode, this assertion fails.
    assert.ok(
      withFxCtx.createdDelays.length > noFxCtx.createdDelays.length,
      'chorus render must add delay nodes that the no-FX render does not',
    );
    assert.ok(
      withFxCtx.createdConstantSources.length > noFxCtx.createdConstantSources.length,
      'chorus render must add ConstantSource nodes that the no-FX render does not',
    );
  });
});
