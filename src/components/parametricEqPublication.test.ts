import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FxSlot, MixerTrack, ParametricEqBand } from '../types/daw';
import {
  EQ_BAND_SPECS,
  EQ_PRESETS,
  EQ_SLOT_ID_PREFIX,
  createFlatEqBands,
  eqBandsFromSlotParams,
  eqBandsToSlotParams,
  eqParamNames,
  findEqualizerSlot,
  publishEqBandsToTrack,
  readEqBandsFromTrack,
} from './parametricEqBands';
import { getLiveFxSlotEffect, installLiveFxChainHardening } from '../audio/liveFxChainHardening';

/**
 * Minimal Web Audio stand-in, mirroring the harness in
 * `liveFxChainHardening.test.ts`, so the test can prove published EQ values
 * land on real filter AudioParams instead of only on the project object.
 */
type FakeParam = {
  value: number;
  setValueAtTime(next: number, _time: number): void;
  setTargetAtTime(next: number, _time: number, _tau: number): void;
  linearRampToValueAtTime(next: number, _time: number): void;
  exponentialRampToValueAtTime(next: number, _time: number): void;
  cancelScheduledValues(_time: number): void;
};
type FakeNode = Record<string, unknown>;

function makeContext(): { context: AudioContext; nodes: FakeNode[] } {
  const nodes: FakeNode[] = [];
  const param = (value = 0): FakeParam => ({
    value,
    setValueAtTime(next) {
      this.value = next;
    },
    setTargetAtTime(next) {
      this.value = next;
    },
    linearRampToValueAtTime(next) {
      this.value = next;
    },
    exponentialRampToValueAtTime(next) {
      this.value = next;
    },
    cancelScheduledValues() {},
  });
  const make = <T extends FakeNode>(extra: T): T => {
    const created = {
      connect() {},
      disconnect() {},
      ...extra,
    } as T;
    nodes.push(created);
    return created;
  };
  const context = {
    currentTime: 1,
    sampleRate: 48000,
    createGain: () => make({ gain: param(1) }),
    createBiquadFilter: () => make({ type: 'lowpass', frequency: param(1000), Q: param(1), gain: param(0) }),
    createDelay: () => make({ delayTime: param(0) }),
    createDynamicsCompressor: () => make({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createWaveShaper: () => make({ curve: null, oversample: 'none' }),
    createConvolver: () => make({ buffer: null }),
    createOscillator: () => make({ frequency: param(0), start() {}, stop() {} }),
    createConstantSource: () => make({ offset: param(0), start() {}, stop() {} }),
    createBuffer: (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
  } as unknown as AudioContext;
  return { context, nodes };
}

const track = (fxSlots: FxSlot[] = []): MixerTrack => ({
  id: 3,
  name: 'Bass',
  color: '#ff6e00',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  stereoWidth: 1,
  fxSlots,
  peakL: 0,
  peakR: 0,
});

const bands = (
  low: [number, number, number],
  mid: [number, number, number],
  high: [number, number, number]
): ParametricEqBand[] => [
  { id: 1, type: 'lowshelf', frequency: low[0], gain: low[1], q: low[2], enabled: true, color: '#e67e22' },
  { id: 2, type: 'peaking', frequency: mid[0], gain: mid[1], q: mid[2], enabled: true, color: '#2ecc71' },
  { id: 3, type: 'highshelf', frequency: high[0], gain: high[1], q: high[2], enabled: true, color: '#3498db' },
];

describe('Phase 52 — Parametric EQ publication', () => {
  it('publishes the three stages into the production slot param names', () => {
    const params = eqBandsToSlotParams(bands([80, 4, 1.1], [2500, -3, 2.0], [9000, 2, 0.7]));

    assert.equal(params.lowFreq, 80);
    assert.equal(params.lowGain, 4);
    assert.equal(params.lowQ, 1.1);
    assert.equal(params.midFreq, 2500);
    assert.equal(params.midGain, -3);
    assert.equal(params.midQ, 2.0);
    assert.equal(params.highFreq, 9000);
    assert.equal(params.highGain, 2);
    assert.equal(params.highQ, 0.7);
  });

  it('uses exactly the param names the production readers consume', () => {
    for (const spec of EQ_BAND_SPECS) {
      const names = eqParamNames(spec.role);
      assert.equal(names.frequency, `${spec.role}Freq`);
      assert.equal(names.gain, `${spec.role}Gain`);
      assert.equal(names.q, `${spec.role}Q`);
    }
  });

  it('publishes a disabled band as 0 dB, which is a true bypass for these filter types', () => {
    const withDisabled: ParametricEqBand[] = [
      { id: 1, type: 'lowshelf', frequency: 120, gain: 9, q: 0.9, enabled: false, color: '#e67e22' },
      { id: 2, type: 'peaking', frequency: 1200, gain: -6, q: 1.2, enabled: true, color: '#2ecc71' },
      { id: 3, type: 'highshelf', frequency: 6500, gain: 3, q: 0.8, enabled: true, color: '#3498db' },
    ];
    const params = eqBandsToSlotParams(withDisabled);
    assert.equal(params.lowGain, 0, 'a disabled band must not reach the filter as gain');
    assert.equal(params.midGain, -6);
  });

  it('creates the EQ insert when the track has none, so the values can reach audio', () => {
    const published = publishEqBandsToTrack(track(), bands([120, 3, 0.9], [1200, 1, 1.2], [6500, -2, 0.8]));
    const slot = findEqualizerSlot(published);

    assert.ok(slot, 'publishing must create an equalizer insert');
    assert.equal(slot!.type, 'equalizer');
    assert.ok(slot!.id.startsWith(EQ_SLOT_ID_PREFIX));
    assert.equal(slot!.params.lowGain, 3);
    assert.equal(slot!.mix, 1, 'the insert EQ is in series; a partial mix would not be a bypass');
  });

  it('updates the existing insert in place rather than stacking duplicates', () => {
    const once = publishEqBandsToTrack(track(), bands([120, 3, 0.9], [1200, 1, 1.2], [6500, -2, 0.8]));
    const twice = publishEqBandsToTrack(once, bands([120, -7, 0.9], [1200, 1, 1.2], [6500, -2, 0.8]));

    assert.equal(twice.fxSlots.length, 1, 'a second publish must not append a second EQ');
    assert.equal(findEqualizerSlot(twice)!.params.lowGain, -7);
  });

  it('round-trips bands through the slot so reopening the modal shows the published values', () => {
    const published = publishEqBandsToTrack(track(), bands([65, 4, 1.2], [800, 1.5, 2], [6000, -6, 0.8]));
    const readBack = readEqBandsFromTrack(published);

    assert.equal(readBack.length, 3);
    assert.equal(readBack[0].frequency, 65);
    assert.equal(readBack[0].gain, 4);
    assert.equal(readBack[1].frequency, 800);
    assert.equal(readBack[2].gain, -6);
  });

  it('reports flat bands for a track with no EQ insert, matching the engine', () => {
    const readBack = readEqBandsFromTrack(track());
    const flat = createFlatEqBands();
    assert.deepEqual(
      readBack.map(b => b.gain),
      flat.map(b => b.gain)
    );
    assert.equal(findEqualizerSlot(track()), undefined);
  });

  it('falls back to defaults for missing params instead of NaN', () => {
    const recovered = eqBandsFromSlotParams({});
    assert.equal(recovered.length, 3);
    for (const band of recovered) {
      assert.ok(Number.isFinite(band.frequency));
      assert.ok(Number.isFinite(band.gain));
      assert.ok(Number.isFinite(band.q));
    }
  });

  it('ships only filter types the production chain implements', () => {
    for (const preset of EQ_PRESETS) {
      assert.equal(preset.bands.length, 3);
      for (const band of preset.bands) {
        assert.ok(
          ['lowshelf', 'peaking', 'highshelf'].includes(band.type),
          `preset "${preset.name}" must not use a ${band.type} stage the engine does not build`
        );
      }
    }
    for (const band of createFlatEqBands()) {
      assert.ok(['lowshelf', 'peaking', 'highshelf'].includes(band.type));
    }
  });
});

describe('Phase 52 — published EQ values reach the real effect', () => {
  it('builds filter AudioParams from the published slot params', () => {
    const published = publishEqBandsToTrack(track(), bands([65, 4, 1.2], [800, -6, 2.0], [6000, 3, 0.8]));
    const slot = findEqualizerSlot(published)!;

    const { context, nodes } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: () => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel() {},
      ctx: context,
      isOfflineRendering: false,
    };

    installLiveFxChainHardening(engine as never);
    engine.rebuildTrackFxChain(published);

    const effect = getLiveFxSlotEffect(engine as never, published.id, slot.id);
    assert.ok(effect, 'the published EQ slot must be registered on the live chain');

    // The three biquads the production equalizer creates, in chain order.
    const filters = nodes.filter(
      node => 'frequency' in node && 'Q' in node && 'gain' in node
    ) as Array<{ type: string; frequency: FakeParam; Q: FakeParam; gain: FakeParam }>;

    assert.equal(filters.length, 3, 'the production EQ is a three-stage chain');
    assert.deepEqual(filters.map(f => f.type), ['lowshelf', 'peaking', 'highshelf']);

    assert.equal(filters[0].frequency.value, 65);
    assert.equal(filters[0].gain.value, 4);
    assert.equal(filters[0].Q.value, 1.2);

    assert.equal(filters[1].frequency.value, 800);
    assert.equal(filters[1].gain.value, -6);
    assert.equal(filters[1].Q.value, 2.0);

    assert.equal(filters[2].frequency.value, 6000);
    assert.equal(filters[2].gain.value, 3);
    assert.equal(filters[2].Q.value, 0.8);
  });
});
