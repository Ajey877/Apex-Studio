/**
 * Phase 64 — F2: Mixer insert-strip metering.
 *
 * `getOrCreateMixerChannel` taps the post-fader signal into a per-strip
 * `AnalyserNode`, and `Mixer.tsx` reads it through `audioEngine.getMixerTrackPeak`.
 * `MixerRoutingAdapter.rebuildLiveGraph()` disconnects every non-master
 * `output` with a no-argument `disconnect()` — which removes *all* outgoing
 * edges, including the meter tap — and then reconnects only the routes. The
 * insert strips therefore measured digital silence for the rest of the session
 * (the master never goes through the rebuild, which is why only MST worked).
 *
 * The harness models an `AnalyserNode` faithfully: a tap with no signal path
 * from a started source measures silence. The reading is taken through the same
 * production call `Mixer.tsx` uses.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { Channel, MixerTrack } from '../types/daw';

const SAMPLE_RATE = 8000;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

class SimParam {
  value: number;
  constructor(initial: number) {
    this.value = initial;
  }
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void {}
}

class SimNode {
  readonly connections: SimNode[] = [];
  readonly incoming: SimNode[] = [];
  readonly gain = new SimParam(1);
  readonly pan = new SimParam(0);
  readonly frequency = new SimParam(440);
  readonly detune = new SimParam(0);
  readonly Q = new SimParam(1);
  private startedSources = 0;

  constructor(readonly kind: string) {}

  connect(target: SimNode): SimNode {
    if (target instanceof SimNode && !this.connections.includes(target)) {
      this.connections.push(target);
      target.incoming.push(this);
    }
    return target;
  }

  disconnect(target?: SimNode): void {
    if (!target) {
      for (const downstream of this.connections) {
        const index = downstream.incoming.indexOf(this);
        if (index >= 0) downstream.incoming.splice(index, 1);
      }
      this.connections.length = 0;
      return;
    }
    const index = this.connections.indexOf(target);
    if (index >= 0) {
      this.connections.splice(index, 1);
      const upstream = target.incoming.indexOf(this);
      if (upstream >= 0) target.incoming.splice(upstream, 1);
    }
  }

  start(): void { this.startedSources += 1; }
  stop(): void {}
  setPeriodicWave(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}

  /**
   * True when audio from a started source can reach this node — the graph-level
   * definition of "this tap is measuring something".
   */
  carriesSignal(seen: Set<SimNode> = new Set()): boolean {
    if (seen.has(this)) return false;
    seen.add(this);
    if (this.kind === 'oscillator' || this.kind === 'bufferSource') return this.startedSources > 0;
    return this.incoming.some(node => node.carriesSignal(seen));
  }

  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(this.carriesSignal() ? 200 : 128);
  }
}

class SimAudioContext {
  readonly sampleRate = SAMPLE_RATE;
  readonly length = SAMPLE_RATE;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new SimNode('destination');
  readonly nodes: SimNode[] = [];

  private track(kind: string): SimNode {
    const node = new SimNode(kind);
    this.nodes.push(node);
    return node;
  }

  createGain(): SimNode { return this.track('gain'); }
  createStereoPanner(): SimNode { return this.track('panner'); }
  createAnalyser(): SimNode { return this.track('analyser'); }
  createDynamicsCompressor(): SimNode { return this.track('compressor'); }
  createOscillator(): SimNode { return this.track('oscillator'); }
  createBiquadFilter(): SimNode { return this.track('filter'); }
  createWaveShaper(): SimNode { return this.track('waveshaper'); }
  resume(): Promise<void> { return Promise.resolve(); }
}

function makeChannel(id: string, mixerTrackId: number, overrides: Partial<Channel> = {}): Channel {
  const steps = new Array(16).fill(false);
  steps[0] = true;
  return {
    id,
    name: id,
    color: '#00e5ff',
    instrumentType: 'minisynth',
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    notes: [],
    synthParams: audioEngine.getDefaultSynthParams(),
    mixerTrackId,
    ...overrides,
  };
}

function makeMixerTracks(): MixerTrack[] {
  return [0, 1, 2].map(id => ({
    id,
    name: id === 0 ? 'Master' : `Insert ${id}`,
    color: '#fff',
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  }));
}

const SAVED_FIELDS = [
  'ctx', 'masterGain', 'grossBeatNode', 'masterAnalyser', 'mixerChannels', 'channelPanners',
  'mixerRoutingAdapter', 'mixerRoutingChannelMap', 'activeVoices', 'activeClipSources',
  'playlistLaneMutes', 'isPlaying', 'isOfflineRendering', 'transport', 'activeChannels',
  'activeClips', 'activeMixerTracks', 'playbackProjectChannels', 'playbackProjectMixerTracks',
  'activePlayMode', 'activePatternLengthSteps', 'bpm',
] as const;

const savedState: Record<string, unknown> = {};

function setupLiveGraph(): SimAudioContext {
  const ctx = new SimAudioContext();
  engine.ctx = ctx;
  engine.masterGain = ctx.createGain();
  engine.grossBeatNode = ctx.createGain();
  engine.masterAnalyser = ctx.createAnalyser();
  engine.masterGain.connect(engine.grossBeatNode);
  engine.grossBeatNode.connect(engine.masterAnalyser);
  engine.masterAnalyser.connect(ctx.destination);
  engine.mixerChannels = new Map();
  engine.channelPanners = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.playlistLaneMutes = new Set();
  engine.isPlaying = false;
  engine.isOfflineRendering = false;
  engine.bpm = 120;
  for (const track of makeMixerTracks()) audioEngine.updateMixerTrack(track);
  return ctx;
}

function attachFakeTransport() {
  let callbacks: { onStep?: (step: number, bar: number, audioTime: number) => void } | null = null;
  engine.transport = {
    setBpm: () => undefined,
    setMode: () => undefined,
    setPatternLoopSteps: () => undefined,
    setSongEndSteps: () => undefined,
    setCallbacks: (next: typeof callbacks) => { callbacks = next; },
    start: () => undefined,
    stop: () => undefined,
    pause: () => undefined,
    seek: () => undefined,
    getState: () => ({
      bpm: 120, beatsPerBar: 4, stepsPerBeat: 4, mode: 'pat', playing: true,
      positionSeconds: 0, step: 0, bar: 1,
    }),
  };
  return {
    emitStep: (step: number, bar: number, audioTime: number) => callbacks?.onStep?.(step, bar, audioTime),
  };
}

const mixerChannel = (trackId: number) => engine.mixerChannels.get(trackId) as { output: SimNode; analyser: SimNode };

beforeEach(() => {
  for (const field of SAVED_FIELDS) savedState[field] = engine[field];
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
});

afterEach(() => {
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).window = undefined;
});

describe('Phase 64 F2 — insert strips measure the post-fader signal', () => {
  it('keeps the analyser tapped after the routing rebuild a take start performs', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    const channel = makeChannel('ch-meter', 1);

    audioEngine.play([channel], [], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    transport.emitStep(0, 1, 0);

    const strip = mixerChannel(1);
    assert.ok(
      strip.analyser.incoming.includes(strip.output),
      'the post-fader output must still feed the strip analyser',
    );
    assert.ok(
      audioEngine.getMixerTrackPeak(1) > 0,
      'an audibly playing insert strip must meter above zero',
    );
  });

  it('keeps the analyser tapped after a live mixer edit rebuilds routing', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    const channel = makeChannel('ch-meter', 1);
    audioEngine.play([channel], [], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    transport.emitStep(0, 1, 0);

    audioEngine.updateMixerTrack({ ...makeMixerTracks()[1], volume: 0.5 });

    const strip = mixerChannel(1);
    assert.ok(strip.analyser.incoming.includes(strip.output));
    assert.ok(audioEngine.getMixerTrackPeak(1) > 0, 'a fader move must not blank the meter');
  });

  it('keeps the analyser tapped when routing changes to a sub-bus', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    const channel = makeChannel('ch-meter', 1);
    audioEngine.play([channel], [], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    transport.emitStep(0, 1, 0);

    audioEngine.updateMixerTrack({ ...makeMixerTracks()[1], routingTargetId: 2 });

    const strip = mixerChannel(1);
    assert.ok(strip.analyser.incoming.includes(strip.output));
    assert.ok(audioEngine.getMixerTrackPeak(1) > 0, 're-routing a bus must not blank the meter');
  });

  it('reports silence for a strip that has no playing source', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.play([makeChannel('ch-meter', 1)], [], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    transport.emitStep(0, 1, 0);

    assert.equal(audioEngine.getMixerTrackPeak(2), 0, 'an idle insert strip stays at zero');
  });

  it('still meters the master strip (routing rebuild regression guard)', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.play([makeChannel('ch-meter', 1)], [], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    transport.emitStep(0, 1, 0);

    assert.ok(audioEngine.getMixerTrackPeak(0) > 0);
  });
});
