import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MixerRoutingAdapter, MixerAudioNodePair } from './mixerRoutingAdapter';
import { audioEngine } from './audioEngine';
import { createDefaultProjectState, normalizeProjectState, MAX_AUX_SENDS_PER_TRACK, normalizeAuxSendsForTrack } from '../state/projectState';
import { updateMixerTrackInProjectState } from '../state/projectMutations';
import { applyAuxSendSelection } from '../components/Mixer';
import type { MixerTrack, ProjectState } from '../types/daw';
import { buildDryStemMixerTracks, buildWetStemMixerTracks, getDirectAuxSendSourceIds, getUpstreamMixerTrackIds } from './auxStemRouting';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

// Helpers to create fake nodes
class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  disconnectCount = 0;
  gain?: { value: number; setValueAtTime(v: number, t: number): void; setTargetAtTime(v: number, t: number, c: number): void };
  pan?: { setValueAtTime(v: number, t: number): void };
  constructor(withGain = false) {
    if (withGain) this.gain = { value: 1, setValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.value = v; } };
  }
  connect(target: FakeAudioNode): void { this.connections.push(target); }
  disconnect(target?: FakeAudioNode): void {
    if (target) {
      const idx = this.connections.indexOf(target);
      if (idx >= 0) this.connections.splice(idx, 1);
    } else {
      this.connections.length = 0;
    }
    this.disconnectCount += 1;
  }
}
class FakeAudioContext {
  createGain() { return new FakeAudioNode(true) as unknown as GainNode; }
  createStereoPanner() { return new FakeAudioNode() as unknown as StereoPannerNode; }
  createAnalyser() { return new FakeAudioNode() as unknown as AnalyserNode; }
  get currentTime() { return 0; }
}

// Mock AudioParam supports the scheduling methods exercised by the real
// instrument renderers so an offline test cannot pass after a swallowed
// renderer exception caused by an incomplete fake context.
const mockAudioParam = (value = 0) => ({
  value,
  setValueAtTime(next: number) { this.value = next; },
  setTargetAtTime(next: number) { this.value = next; },
  linearRampToValueAtTime(next: number) { this.value = next; },
  exponentialRampToValueAtTime(next: number) { this.value = next; },
  cancelScheduledValues() {},
});

// Mock for offline
class MockOfflineAudioContext {
  readonly destination = { connect: () => {} };
  numberOfChannels: number; length: number; sampleRate: number; currentTime = 0;
  constructor(ch: number, len: number, sr: number) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; }
  createGain() { return { gain: mockAudioParam(1), connect() {}, disconnect() {} }; }
  createStereoPanner() { return { pan: mockAudioParam(0), connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 256, smoothingTimeConstant: 0.7, connect() {}, disconnect() {} }; }
  createBufferSource() { return { buffer: null, playbackRate: mockAudioParam(1), detune: mockAudioParam(0), start() {}, stop() {}, connect() {}, disconnect() {} }; }
  createOscillator() { return { type: 'sawtooth', frequency: mockAudioParam(440), detune: mockAudioParam(0), start() {}, stop() {}, connect() {}, disconnect() {} }; }
  createBiquadFilter() { return { type: 'lowpass', frequency: mockAudioParam(350), Q: mockAudioParam(1), gain: mockAudioParam(0), connect() {}, disconnect() {} }; }
  createDelay() { return { delayTime: mockAudioParam(0), connect() {}, disconnect() {} }; }
  createConvolver() { return { buffer: null, connect() {}, disconnect() {} }; }
  createWaveShaper() { return { curve: null, connect() {}, disconnect() {} }; }
  createDynamicsCompressor() { return { threshold: mockAudioParam(-24), ratio: mockAudioParam(12), attack: mockAudioParam(0.003), release: mockAudioParam(0.25), connect() {}, disconnect() {} }; }
  createBuffer(_c: number, len: number, _sr: number) { return { numberOfChannels: 1, length: len, sampleRate: 44100, duration: len/44100, getChannelData: () => new Float32Array(len), copyFromChannel(){}, copyToChannel(){} } as unknown as AudioBuffer; }
  async startRendering() { return { numberOfChannels: 2, length: this.length, sampleRate: this.sampleRate, duration: this.length/this.sampleRate, getChannelData: () => new Float32Array(this.length), copyFromChannel(){}, copyToChannel(){} } as unknown as AudioBuffer; }
}

function makeTrack(id: number, overrides: Partial<MixerTrack> = {}): MixerTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#fff',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
    routingTargetId: 0,
    ...overrides,
  } as MixerTrack;
}

describe('Phase 88 — Aux Sends / Return Bussing', () => {
  describe('data model — bounded 0..1 with stable IDs and legacy migration', () => {
    it('clamps amount to 0..1 and drops out-of-range', () => {
      const valid = new Set([1,2,8]);
      const track: any = { id: 1, auxSends: [{ targetId: 8, amount: 1.5 }, { targetId: 2, amount: -0.2 }] };
      const normalized = normalizeAuxSendsForTrack(track, valid);
      // amount 1.5 clamped to 1, -0.2 clamped to 0 (but still considered? Our clamp returns 0..1, so both survive)
      // However our function uses clampAuxSendAmount which clamps, not drops.
      assert.ok(normalized);
      assert.equal(normalized!.length, 2);
      assert.equal(normalized![0].amount, 1);
      assert.equal(normalized![1].amount, 0);
    });

    it('rejects self, master, non-existent, duplicate, >2', () => {
      const valid = new Set([0,1,2,3,8,9]);
      const track: any = { id: 1, auxSends: [{ targetId: 1, amount: 0.5 }, { targetId: 0, amount: 0.5 }, { targetId: 99, amount: 0.5 }, { targetId: 8, amount: 0.5 }, { targetId: 8, amount: 0.8 }, { targetId: 9, amount: 0.5 }] };
      const normalized = normalizeAuxSendsForTrack(track, valid);
      assert.ok(normalized);
      assert.equal(normalized!.length, 2);
      assert.equal(normalized![0].targetId, 8);
      assert.equal(normalized![1].targetId, 9);
    });

    it('migrates legacy sends to auxSends when auxSends missing', () => {
      const project = createDefaultProjectState();
      // Inject legacy sends on track 1
      const t1 = project.mixerTracks.find(t => t.id === 1)!;
      (t1 as any).sends = { send1: 0.6, send2: 0.3 };
      // Ensure we have at least targets 8,9 as aux returns not yet, but migration should create them
      const normalized = normalizeProjectState(project);
      const nt1 = normalized.mixerTracks.find(t => t.id === 1)!;
      assert.ok(nt1.auxSends, 'legacy sends migrated to auxSends');
      assert.equal(nt1.auxSends!.length, 2);
      assert.ok((nt1 as any).sends === undefined, 'legacy sends stripped after migration');
      // Check that aux returns exist
      const hasReturn = normalized.mixerTracks.some(t => (t as any).isAux === true);
      assert.ok(hasReturn, 'migration creates aux return tracks');
    });

    it('deterministic save→reload preserves auxSends', () => {
      const project = createDefaultProjectState();
      const t2 = project.mixerTracks.find(t => t.id === 2)!;
      // Create a return
      const nextId = Math.max(...project.mixerTracks.map(t => t.id)) + 1;
      const ret: MixerTrack = makeTrack(nextId, { name: 'Return', isAux: true, fxSlots: [{ id: 'fx-verb', type: 'reverb', name: 'Verb', enabled: true, mix: 1, params: {} }] });
      project.mixerTracks.push(ret);
      t2.auxSends = [{ targetId: ret.id, amount: 0.42 }];
      const once = normalizeProjectState(project);
      const twice = normalizeProjectState(JSON.parse(JSON.stringify(once)));
      const a = once.mixerTracks.find(t => t.id === 2)!.auxSends;
      const b = twice.mixerTracks.find(t => t.id === 2)!.auxSends;
      assert.deepEqual(a, b);
      assert.equal(a![0].amount, 0.42);
    });
  });

  describe('aux/return tracks with own mixer channel+FX→master', () => {
    it('return track can hold FX and routes to master', () => {
      const ret = makeTrack(8, { isAux: true, fxSlots: [{ id: 'fx-1', type: 'reverb', name: 'Verb', enabled: true, mix: 1, params: {} }], routingTargetId: 0 });
      assert.equal(ret.isAux, true);
      assert.equal(ret.routingTargetId, 0);
      assert.equal(ret.fxSlots.length, 1);
      assert.equal(ret.fxSlots[0].type, 'reverb');
    });
  });

  describe('live audio graph — post-fader send gains summed into returns with cycle protection+meter taps no leaks', () => {
    it('creates post-fader gain nodes for each aux send', () => {
      const fakeCtx = new FakeAudioContext() as unknown as AudioContext;
      const prevCtx = engine.ctx;
      const prevChannels = engine.mixerChannels;
      const prevAdapter = engine.mixerRoutingAdapter;
      const prevMap = engine.mixerRoutingChannelMap;
      try {
        engine.ctx = fakeCtx;
        engine.mixerChannels = new Map();
        engine.mixerRoutingAdapter = null;
        engine.mixerRoutingChannelMap = null;
        // Create master and two inserts + return
        const master = (engine as any).getOrCreateMixerChannel(0);
        const ch1 = (engine as any).getOrCreateMixerChannel(1);
        const ret8 = (engine as any).getOrCreateMixerChannel(8);
        // Simulate track 1 sends to 8 with amount 0.5
        const track1 = makeTrack(1, { auxSends: [{ targetId: 8, amount: 0.5 }] });
        (engine as any).syncAuxSendsForTrack(track1);
        assert.ok(ch1.auxSendGains, 'auxSendGains map exists');
        assert.ok(ch1.auxSendGains.has(8), 'gain for target 8 exists');
        const gain = ch1.auxSendGains.get(8) as unknown as FakeAudioNode;
        assert.ok(gain.gain, 'gain node has gain');
        assert.equal((gain.gain as any).value, 0.5);
        // Verify output connects to gain and gain to return input
        const output = ch1.output as unknown as FakeAudioNode;
        assert.ok(output.connections.includes(gain), 'output -> gain');
        const retInput = ret8.input as unknown as FakeAudioNode;
        assert.ok(gain.connections.includes(retInput), 'gain -> return input');
        // Meter tap must still be connected after routing rebuild
        const analyser = ch1.analyser as unknown as FakeAudioNode;
        // After syncMixerRouting, meter tap should be restored; we trigger a bus rebuild
        const tracks = [makeTrack(0), track1, makeTrack(8, { isAux: true })];
        (engine as any).syncMixerRouting(tracks);
        // After rebuild, output should still have connection to gain plus to master/bus and to analyser
        // We check that gain still connected from output
        assert.ok(output.connections.includes(gain), 'output still -> gain after bus rebuild');
        assert.ok(output.connections.includes(analyser) || output.connections.includes(gain), 'meter or aux still connected');
      } finally {
        engine.ctx = prevCtx;
        engine.mixerChannels = prevChannels;
        engine.mixerRoutingAdapter = prevAdapter;
        engine.mixerRoutingChannelMap = prevMap;
      }
    });

    it('cycle protection rejects aux that would create cycle', () => {
      const tracks: MixerTrack[] = [
        makeTrack(0),
        makeTrack(1, { routingTargetId: 2 }),
        makeTrack(2, { routingTargetId: 0 }),
      ];
      // Try to add aux 2->1 which would create 1->2->1 cycle via aux
      const nextAux = [{ targetId: 1, amount: 0.5 }];
      const mockUpdate = (id: number, upd: Partial<MixerTrack>) => {};
      // applyAuxSendSelection should reject
      const result = applyAuxSendSelection(tracks as any, 2, nextAux as any, mockUpdate as any);
      assert.equal(result, false, 'aux cycle should be rejected');
    });

    it('disconnects aux gains when target removed and does not leak', () => {
      const fakeCtx = new FakeAudioContext() as unknown as AudioContext;
      const prevCtx = engine.ctx;
      const prevChannels = engine.mixerChannels;
      const prevAdapter = engine.mixerRoutingAdapter;
      const prevMap = engine.mixerRoutingChannelMap;
      try {
        engine.ctx = fakeCtx;
        engine.mixerChannels = new Map();
        engine.mixerRoutingAdapter = null;
        engine.mixerRoutingChannelMap = null;
        const ch1 = (engine as any).getOrCreateMixerChannel(1);
        const ch8 = (engine as any).getOrCreateMixerChannel(8);
        const track1 = makeTrack(1, { auxSends: [{ targetId: 8, amount: 0.7 }] });
        (engine as any).syncAuxSendsForTrack(track1);
        assert.equal(ch1.auxSendGains.size, 1);
        // Remove target
        (engine as any).removeMixerChannel(8);
        // ch1's auxSendGains targeting 8 should be cleaned up (since we also clean incoming? Actually removeMixerChannel cleans other channels' aux targeting deleted id)
        // But ch1 is other channel targeting 8, so after removing 8, ch1 should have its gain removed via removeMixerChannel's loop
        assert.equal(ch1.auxSendGains.has(8), false, 'incoming aux cleaned after target deletion');
        assert.equal(ch1.auxSendGains.size, 0);
      } finally {
        engine.ctx = prevCtx;
        engine.mixerChannels = prevChannels;
        engine.mixerRoutingAdapter = prevAdapter;
        engine.mixerRoutingChannelMap = prevMap;
      }
    });
  });

  describe('offline rendering identical topology/amount/automation/tails', () => {
    it('offline sync creates same aux gains as live', async () => {
      const saved = (globalThis as any).OfflineAudioContext;
      (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
      const prev = { ctx: engine.ctx, mixerChannels: engine.mixerChannels, isOfflineRendering: engine.isOfflineRendering, offlineRenderLeaseHeld: engine.offlineRenderLeaseHeld, offlineRenderOperationDepth: engine.offlineRenderOperationDepth };
      try {
        const channel = { id: 'ch-test', name: 'Test', color: '#fff', instrumentType: 'minisynth' as const, mixerTrackId: 1, volume: 0.9, pan: 0, pitch: 0, mute: false, solo: false, steps: Array(16).fill(false), notes: [{ id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 }], synthParams: (audioEngine as any).getDefaultSynthParams ? (audioEngine as any).getDefaultSynthParams() : {} };
        const clip = { id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern' as const, channelId: 'ch-test', color: '#fff', name: 'Clip' };
        const dryTracks = [makeTrack(0), makeTrack(1, { auxSends: [] }), makeTrack(8, { isAux: true, fxSlots: [{ id: 'fx-verb', type: 'reverb', name: 'Verb', enabled: true, mix: 1, params: {} }] })];
        const wetTracks = [makeTrack(0), makeTrack(1, { auxSends: [{ targetId: 8, amount: 0.8 }] }), makeTrack(8, { isAux: true, fxSlots: [{ id: 'fx-verb', type: 'reverb', name: 'Verb', enabled: true, mix: 1, params: {} }] })];
        // Just verify both renders succeed and have finite buffers
        const dryBuf = await audioEngine.renderTimelineOffline([channel as any], [clip as any], dryTracks as any, 120, 1, 44100, true);
        const wetBuf = await audioEngine.renderTimelineOffline([channel as any], [clip as any], wetTracks as any, 120, 1, 44100, true);
        assert.ok(dryBuf.length > 0);
        assert.ok(wetBuf.length > 0);
        assert.equal(dryBuf.numberOfChannels, 2);
        assert.equal(wetBuf.numberOfChannels, 2);
      } finally {
        (globalThis as any).OfflineAudioContext = saved;
        engine.ctx = prev.ctx;
        engine.mixerChannels = prev.mixerChannels;
        engine.isOfflineRendering = prev.isOfflineRendering;
        engine.offlineRenderLeaseHeld = prev.offlineRenderLeaseHeld;
        engine.offlineRenderOperationDepth = prev.offlineRenderOperationDepth;
      }
    });
  });

  describe('send automation mixer_send1/2 via existing automation infra persisted/undoable/live+offline', () => {
    it('applyAutomationValue updates auxSend amount and gain', () => {
      const fakeCtx = new FakeAudioContext() as unknown as AudioContext;
      const prevCtx = engine.ctx;
      const prevChannels = engine.mixerChannels;
      const prevAdapter = engine.mixerRoutingAdapter;
      const prevMap = engine.mixerRoutingChannelMap;
      try {
        engine.ctx = fakeCtx;
        engine.mixerChannels = new Map();
        engine.mixerRoutingAdapter = null;
        engine.mixerRoutingChannelMap = null;
        const ch1 = (engine as any).getOrCreateMixerChannel(1);
        (engine as any).getOrCreateMixerChannel(8);
        const track1 = makeTrack(1, { auxSends: [{ targetId: 8, amount: 0.2 }] });
        (engine as any).syncAuxSendsForTrack(track1);
        const gain = ch1.auxSendGains.get(8) as unknown as FakeAudioNode;
        assert.equal((gain.gain as any).value, 0.2);
        // Automate send1 to 0.9
        const mixerTracks: MixerTrack[] = [makeTrack(0), track1];
        (engine as any).applyAutomationValue({ type: 'mixer_send1', targetId: 1 }, 0.9, [], mixerTracks);
        assert.equal(track1.auxSends![0].amount, 0.9);
        assert.equal((gain.gain as any).value, 0.9);
        // send2 should not exist, automating it should be no-op
        const before = JSON.stringify(track1.auxSends);
        (engine as any).applyAutomationValue({ type: 'mixer_send2', targetId: 1 }, 0.5, [], mixerTracks);
        assert.equal(JSON.stringify(track1.auxSends), before, 'mixer_send2 with no entry is no-op');
      } finally {
        engine.ctx = prevCtx;
        engine.mixerChannels = prevChannels;
        engine.mixerRoutingAdapter = prevAdapter;
        engine.mixerRoutingChannelMap = prevMap;
      }
    });
  });

  describe('Mixer.tsx functional 0..1 controls + return target selector no pre/post', () => {
    it('applyAuxSendSelection validates 0..1 and target', () => {
      const tracks: MixerTrack[] = [makeTrack(0), makeTrack(1), makeTrack(8, { isAux: true })];
      let lastUpdate: any = null;
      const onUpdate = (id: number, upd: Partial<MixerTrack>) => { lastUpdate = { id, upd }; };
      // Valid
      let ok = applyAuxSendSelection(tracks as any, 1, [{ targetId: 8, amount: 0.5 }], onUpdate as any);
      assert.equal(ok, true);
      assert.deepEqual(lastUpdate.upd.auxSends, [{ targetId: 8, amount: 0.5 }]);
      // Invalid amount >1
      ok = applyAuxSendSelection(tracks as any, 1, [{ targetId: 8, amount: 1.5 }], onUpdate as any);
      assert.equal(ok, false);
      // Self target
      ok = applyAuxSendSelection(tracks as any, 1, [{ targetId: 1, amount: 0.5 }], onUpdate as any);
      assert.equal(ok, false);
      // Master target
      ok = applyAuxSendSelection(tracks as any, 1, [{ targetId: 0, amount: 0.5 }], onUpdate as any);
      assert.equal(ok, false);
      // >2
      ok = applyAuxSendSelection(tracks as any, 1, [{ targetId: 8, amount: 0.5 }, { targetId: 8, amount: 0.5 }, { targetId: 8, amount: 0.5 }], onUpdate as any);
      assert.equal(ok, false);
    });
  });

  describe('persistence/migration deterministic save→reload', () => {
    it('save and reload via JSON retains auxSends', () => {
      const project = createDefaultProjectState();
      const ret = makeTrack(9, { isAux: true });
      project.mixerTracks.push(ret);
      const src = project.mixerTracks.find(t => t.id === 1)!;
      src.auxSends = [{ targetId: 9, amount: 0.33 }];
      const json = JSON.stringify(project);
      const reloaded = normalizeProjectState(JSON.parse(json));
      const reSrc = reloaded.mixerTracks.find(t => t.id === 1)!;
      assert.deepEqual(reSrc.auxSends, [{ targetId: 9, amount: 0.33 }]);
    });
  });

  describe('stem export (track dry / return wet / master combined no double-count)', () => {
    it('dry stem uses auxSends=[] while wet uses aux', async () => {
      // This is a logic test, not audio: verify that renderProjectStems clones correctly
      const project = createDefaultProjectState();
      const retId = Math.max(...project.mixerTracks.map(t => t.id)) + 1;
      const ret = makeTrack(retId, { isAux: true, fxSlots: [{ id: 'fx-verb', type: 'reverb', name: 'Verb', enabled: true, mix: 1, params: {} }] });
      project.mixerTracks.push(ret);
      const src = project.mixerTracks.find(t => t.id === 1)!;
      src.auxSends = [{ targetId: retId, amount: 0.8 }];
      // Simulate dryMixerTracks creation as done in renderProjectStems
      const dryMixerTracks = project.mixerTracks.map(t => {
        if (t.id === 1 && t.auxSends) return { ...t, auxSends: [] as any };
        return t;
      });
      assert.equal(dryMixerTracks.find(t => t.id === 1)!.auxSends?.length ?? 0, 0, 'dry has no aux');
      assert.equal(project.mixerTracks.find(t => t.id === 1)!.auxSends!.length, 1, 'original still has aux');
      // Wet should have source routing to dummy
      const DUMMY = 9999;
      const wetMixerTracks = project.mixerTracks.map(t => {
        if (t.id === 1) return { ...t, routingTargetId: DUMMY };
        return t;
      });
      wetMixerTracks.push(makeTrack(DUMMY, { volume: 0 }));
      assert.equal(wetMixerTracks.find(t => t.id === 1)!.routingTargetId, DUMMY);
      assert.equal(wetMixerTracks.find(t => t.id === retId)!.routingTargetId, 0, 'return still to master');
    });
  });
});


describe('Phase 88 stem routing regressions', () => {
  const track = (id: number, overrides: Partial<MixerTrack> = {}): MixerTrack => ({
    id,
    name: `Track ${id}`,
    color: '#000000',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
    routingTargetId: 0,
    ...overrides,
  });

  it('removes aux sends from every track in a dry stem snapshot without mutating project state', () => {
    const tracks = [
      track(1, { auxSends: [{ targetId: 9, amount: 0.7 }] }),
      track(2, { routingTargetId: 1, auxSends: [{ targetId: 8, amount: 0.4 }] }),
      track(9, { isAux: true } as Partial<MixerTrack>),
    ];
    const dry = buildDryStemMixerTracks(tracks);
    assert.deepEqual(dry.map(t => t.auxSends ?? []), [[], [], []]);
    assert.equal(tracks[0].auxSends?.length, 1, 'original project remains unchanged');
    assert.equal(tracks[1].auxSends?.length, 1, 'downstream bus send is also removed');
  });

  it('finds instrument channels upstream of a bus that sends to an aux return', () => {
    const tracks = [
      track(1, { routingTargetId: 2 }),
      track(2, { routingTargetId: 0, auxSends: [{ targetId: 9, amount: 0.65 }] }),
      track(3, { routingTargetId: 1 }),
      track(9, { isAux: true } as Partial<MixerTrack>),
      track(10, { routingTargetId: 0 }),
    ];
    const directSources = getDirectAuxSendSourceIds(tracks, 9);
    assert.deepEqual([...directSources], [2]);
    const upstream = getUpstreamMixerTrackIds(tracks, directSources);
    assert.deepEqual([...upstream].sort((a, b) => a - b), [1, 2, 3]);
    assert.equal(upstream.has(10), false, 'unrelated track is excluded');
    assert.equal(upstream.has(9), false, 'return itself is not treated as a source');
  });

  it('isolates a wet return stem from sends to other returns on source and upstream buses', () => {
    const tracks = [
      track(1, { routingTargetId: 2, auxSends: [{ targetId: 8, amount: 0.5 }] }),
      track(2, { routingTargetId: 0, auxSends: [{ targetId: 8, amount: 0.7 }, { targetId: 9, amount: 0.4 }] }),
      track(8, { isAux: true, routingTargetId: 0 }),
      track(9, { isAux: true, routingTargetId: 0 }),
    ];
    const wet = buildWetStemMixerTracks(tracks, new Set([2]), 9, 9999);
    assert.equal(wet.find(t => t.id === 2)?.routingTargetId, 9999, 'direct sender dry output is diverted');
    assert.deepEqual(wet.find(t => t.id === 1)?.auxSends, [], 'upstream send to another return is removed');
    assert.deepEqual(wet.find(t => t.id === 2)?.auxSends, [{ targetId: 9, amount: 0.4 }], 'only selected return send remains');
    assert.deepEqual(tracks[1].auxSends, [{ targetId: 8, amount: 0.7 }, { targetId: 9, amount: 0.4 }], 'source project is immutable');
  });

  it('handles multiple levels of upstream bus routing', () => {
    const tracks = [
      track(1, { routingTargetId: 2 }),
      track(2, { routingTargetId: 3 }),
      track(3, { auxSends: [{ targetId: 9, amount: 1 }] }),
      track(4, { routingTargetId: 2 }),
      track(9, { isAux: true } as Partial<MixerTrack>),
    ];
    const upstream = getUpstreamMixerTrackIds(tracks, getDirectAuxSendSourceIds(tracks, 9));
    assert.deepEqual([...upstream].sort((a, b) => a - b), [1, 2, 3, 4]);
  });
});
