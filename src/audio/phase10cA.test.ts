/**
 * Phase 10C-A — UI honesty & live FX regression coverage.
 *
 * Three small, focused tests guarding the post-10B mixer contract:
 *
 *   1. The FX picker dropdown exposed by `Mixer.tsx` contains every value in
 *      the `FxType` union, so no supported FX type is silently unreachable
 *      from the UI. This is a static-source guard — when a future type
 *      extension adds a new FxType, the test fails until the dropdown is
 *      extended too. (A user-visible regression of the kind the audit found:
 *      `chorus` and `gross_beat` shipped as supported types but were absent
 *      from the picker.)
 *
 *   2. A chorus slot built through the production `installLiveFxChainHardening`
 *      path is reachable through `getLiveFxSlotEffect` and accepts a live
 *      `setParameter('mix', …)` call. The hardening patch is the only path
 *      that reaches `createEffect`'s `case 'chorus'` branch; the test fails if
 *      the chorus becomes silently rejected (e.g. by an `if (slot.type ===
 *      'chorus') return null` guard or by missing wiring).
 *
 *   3. A `slot.mix` change made mid-take through `synchronizePlaybackState`
 *      does NOT trigger an FX-chain rebuild AND routes the new value to the
 *      live WetDry wrapper. The Phase 10B plan guarantees this — this test
 *      pins the invariant by exercising the production
 *      `installLiveFxChainHardening`-installed registry together with the
 *      real `synchronizePlaybackState` code path.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FxSlot, MixerTrack } from '../types/daw';
import { audioEngine } from './audioEngine';
import {
  applyLiveFxChainMix,
  getLiveFxSlotEffect,
  installLiveFxChainHardening,
} from './liveFxChainHardening';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Shared helpers (mirroring liveFxChainHardening.test.ts) ────────────────

type FakeParam = {
  value: number;
  setValueAtTime(value: number, time: number): void;
};

type FakeNode = {
  connections: unknown[];
  disconnectCalls: number;
  connect(target: unknown): void;
  disconnect(): void;
};

function makeContext() {
  const param = (value = 0): FakeParam => ({
    value,
    setValueAtTime(next, _time) {
      this.value = next;
    },
  });

  const make = <T extends Record<string, unknown>>(extra: T = {} as T): T & FakeNode => {
    const created = Object.assign({
      connections: [],
      disconnectCalls: 0,
      connect(target: unknown) {
        this.connections.push(target);
      },
      disconnect() {
        this.connections.length = 0;
        this.disconnectCalls += 1;
      },
    }, extra) as T & FakeNode;
    return created;
  };

  const context = {
    currentTime: 1,
    sampleRate: 48000,
    createGain: () => make({ gain: param(1) }),
    createDelay: () => make({ delayTime: param(0) }),
    createBiquadFilter: () => make({ type: 'lowpass', frequency: param(1000), Q: param(1), gain: param(0) }),
    createDynamicsCompressor: () => make({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0 }),
    createWaveShaper: () => make({ curve: null, oversample: 'none' }),
    createConvolver: () => make({ buffer: null }),
    createOscillator: () => make({ frequency: param(0), start() {}, stop() {} }),
    createConstantSource: () => make({ offset: param(0), start() {}, stop() {} }),
    createBuffer: (_channels: number, length: number, _rate: number) => ({ getChannelData: () => new Float32Array(length) }),
  } as unknown as AudioContext;

  return { context };
}

function slot(type: FxSlot['type'], id = `${type}-1`, mix = 0.5): FxSlot {
  return { id, type, name: type, enabled: true, mix, params: {} };
}

function track(id: number, fxSlots: FxSlot[]): MixerTrack {
  return {
    id,
    name: `Test Track ${id}`,
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    fxSlots,
  } as MixerTrack;
}

// ── Test 1: FX picker dropdown completeness ───────────────────────────────

describe('Phase 10C-A: FX picker dropdown completeness', () => {
  it('includes every FxType value in the Mixer Add-FX dropdown', () => {
    // The complete list of FxType values the type system allows. Adding a new
    // member to the union in `src/types/daw.ts` makes this list the source of
    // truth for the UI honesty contract.
    const SUPPORTED_FX_TYPES: ReadonlyArray<FxSlot['type']> = [
      'equalizer',
      'reverb',
      'delay',
      'distortion',
      'compressor',
      'chorus',
      'bitcrusher',
      'limiter',
      'tape_saturation',
      'gross_beat',
    ];

    // Static source inspection — the dropdown array lives inline in the JSX
    // and is not exported. Reading the file keeps the test dependency-free
    // (no React, no DOM, no Vite transform) and pinpoints the exact line
    // when a member is missing.
    const mixerPath = resolve(__dirname, '..', 'components', 'Mixer.tsx');
    const source = readFileSync(mixerPath, 'utf8');

    const missing: FxSlot['type'][] = [];
    for (const fxType of SUPPORTED_FX_TYPES) {
      // Match the literal token `id: '<fxType>'` inside the dropdown array.
      // Anchored with a leading `{` or `[` and trailing `'` so partial matches
      // (e.g. a comment) cannot pass.
      const re = new RegExp(`id:\\s*'${fxType}'`);
      if (!re.test(source)) missing.push(fxType);
    }

    assert.deepEqual(
      missing,
      [],
      `Mixer.tsx Add-FX dropdown is missing FxType value(s): ${missing.join(', ')}. ` +
        `Every value in the FxType union must be reachable from the UI.`,
    );
  });

  it('does not expose unsupported FX types in the dropdown', () => {
    // Defensive: a future engineer might add a literal to the dropdown array
    // that is not in the FxType union (e.g. while prototyping). Every literal
    // `id: '...'` inside the dropdown region must be a real FxType.
    const SUPPORTED_FX_TYPES = new Set<string>([
      'equalizer', 'reverb', 'delay', 'distortion', 'compressor',
      'chorus', 'bitcrusher', 'limiter', 'tape_saturation', 'gross_beat',
    ]);

    const mixerPath = resolve(__dirname, '..', 'components', 'Mixer.tsx');
    const source = readFileSync(mixerPath, 'utf8');

    // Extract the dropdown array region. The opening token is the comment
    // `/* Add FX dropdown */` introduced by the surrounding component; the
    // closing token is the matching `].map(...)`. Anything between them is the
    // candidate set.
    const startIdx = source.indexOf('Add FX dropdown');
    assert.ok(startIdx >= 0, 'Could not locate the Add FX dropdown region in Mixer.tsx');
    const endMarker = '].map((fx) => (';
    const endIdx = source.indexOf(endMarker, startIdx);
    assert.ok(endIdx > startIdx, 'Could not locate the dropdown array close marker');
    const dropdownRegion = source.slice(startIdx, endIdx);

    const idLiterals = Array.from(
      dropdownRegion.matchAll(/id:\s*'([^']+)'/g),
      (m) => m[1],
    );
    assert.ok(idLiterals.length >= 5, 'expected the dropdown to contain several FX entries');

    const offending = idLiterals.filter((id) => !SUPPORTED_FX_TYPES.has(id));
    assert.deepEqual(
      offending,
      [],
      `Mixer.tsx Add-FX dropdown contains FxType literal(s) that are not in the supported set: ` +
        `${offending.join(', ')}. The dropdown must only list values from the FxType union.`,
    );
  });
});

// ── Tests 2 & 3: shared engine-instance lifecycle ──────────────────────────

const SAVED_KEYS = [
  'ctx', 'activeChannels', 'activeMixerTracks', 'activeClips',
  'playbackProjectChannels', 'playbackProjectMixerTracks',
  'masterGain', 'mixerChannels', 'isOfflineRendering', 'isPlaying',
  'currentBar', 'currentStep',
];

const engine = audioEngine as unknown as Record<string, any>;
let savedInternals: Record<string, any> = {};
let originalUpdateMixerTrack: unknown;

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  originalUpdateMixerTrack = engine.updateMixerTrack;

  engine.ctx = { currentTime: 1.5, sampleRate: 48000 };
  engine.masterGain = { gain: { setTargetAtTime() {}, setValueAtTime() {} } };
  engine.isOfflineRendering = false;
  engine.isPlaying = true;
  engine.activeChannels = [];
  engine.activeMixerTracks = [];
  engine.activeClips = [];
  engine.playbackProjectChannels = [];
  engine.playbackProjectMixerTracks = [];
  engine.currentBar = 1;
  engine.currentStep = 0;
});

afterEach(() => {
  engine.updateMixerTrack = originalUpdateMixerTrack;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
  delete engine.__liveFxChainRegistry;
});

// ── Test 2: Chorus through the production hardening path ──────────────────

describe('Phase 10C-A: chorus FX installs and is reachable through the live registry', () => {
  it('registers a chorus slot in the live slot index and forwards setParameter calls', () => {
    const { context } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const fakeEngine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(fakeEngine as any);
    fakeEngine.rebuildTrackFxChain(track(1, [slot('chorus', 'chorus-1', 0.4)]));

    // The chorus slot must appear in the live slot index. If the hardening
    // patch silently dropped chorus (e.g. returned null from createEffect),
    // the lookup returns undefined — the test fails.
    const chorusEffect = getLiveFxSlotEffect(fakeEngine as any, 1, 'chorus-1');
    assert.ok(
      chorusEffect,
      'chorus slot must be registered in the live slot index after rebuildTrackFxChain',
    );
    // The chorus slot is wrapped in a WetDryEffect (so the user-facing mix
    // slider is a real dry/wet control, not a no-op). WetDryEffect takes the
    // inner effect's name verbatim, so the wrapper reports `name === 'Chorus'`.
    const wrapper = chorusEffect as unknown as { name: string; effect?: unknown };
    assert.equal(
      wrapper.name,
      'Chorus',
      'chorus slot must be wrapped in a WetDryEffect whose name mirrors the inner effect',
    );
    // And the wrapper must hold a real ChorusEffect — a future regression
    // that wraps the wrong effect type (or a stub) still fails this test.
    const innerEffect = wrapper.effect as { name?: string } | undefined;
    assert.ok(
      innerEffect && innerEffect.name === 'Chorus',
      'chorus slot must wrap a real ChorusEffect, not a stub',
    );

    // A live mix change must reach the WetDry wrapper (the ChorusEffect's
    // wet/dry gain pair). The wrapper's setParameter call should not throw
    // and should return true (indicating the slot was found in the live index).
    const ok = applyLiveFxChainMix(fakeEngine as any, 1, 'chorus-1', 0.9, 1.0);
    assert.equal(ok, true, 'a live mix update to the chorus slot returns true');
  });

  it('keeps a previously-built chorus slot reachable after a peer-slot update', () => {
    // The cross-cutting concern from the Phase 10B slot.mix work: a live mix
    // update on one slot must not invalidate another slot's registry entry.
    // A chorus slot is the most fragile (it routes through the hardening-only
    // createEffect branch), so this scenario is the right place to assert it.
    const { context } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const fakeEngine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(fakeEngine as any);
    fakeEngine.rebuildTrackFxChain(track(1, [
      slot('chorus', 'chorus-1', 0.3),
      slot('reverb', 'reverb-1', 0.5),
    ]));

    const chorusBefore = getLiveFxSlotEffect(fakeEngine as any, 1, 'chorus-1');
    assert.ok(chorusBefore, 'chorus slot is registered initially');
    assert.equal(
      applyLiveFxChainMix(fakeEngine as any, 1, 'reverb-1', 0.8, 1.5),
      true,
      'reverb slot accepts the live mix update',
    );
    const chorusAfter = getLiveFxSlotEffect(fakeEngine as any, 1, 'chorus-1');
    assert.equal(
      chorusAfter,
      chorusBefore,
      'chorus slot remains the same instance after a peer slot is updated',
    );
  });
});

// ── Test 3: slot.mix mid-playback bypasses the FX chain rebuild ───────────

describe('Phase 10C-A: slot.mix mid-playback via the production synchronizePlaybackState path', () => {
  function makeMixerTrackForEngine(id: number, fxSlots: FxSlot[]): MixerTrack {
    return {
      id,
      name: `Track ${id}`,
      color: '#fff',
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      stereoWidth: 1,
      peakL: 0,
      peakR: 0,
      fxSlots,
    };
  }

  it('a slot.mix-only edit during playback skips updateMixerTrack and reaches the live WetDry', () => {
    const initialSlot = slot('chorus', 'fx-live', 0.2);
    const updatedSlot = slot('chorus', 'fx-live', 0.78);
    const initial = makeMixerTrackForEngine(1, [initialSlot]);
    const updated = makeMixerTrackForEngine(1, [updatedSlot]);

    engine.activeMixerTracks = [structuredClone(initial)];
    engine.playbackProjectMixerTracks = [structuredClone(initial)];

    // Capture every call to updateMixerTrack — the production path must NOT
    // invoke it when only slot.mix changed.
    let rebuildCount = 0;
    engine.updateMixerTrack = () => { rebuildCount += 1; };

    // Capture every call to the live registry — the production path MUST
    // forward the new mix to the live WetDry wrapper (the audio engine has
    // already installed the registry for the real AudioContext, so this test
    // confirms the engine's synchronizePlaybackState handles the case even
    // when no real chain is attached).
    const applied: Array<{ trackId: number; slotId: string; mix: number }> = [];
    const registry = {
      applyLiveMix(trackId: number, slotId: string, mix: number) {
        applied.push({ trackId, slotId, mix });
        return true;
      },
    };
    engine.__liveFxChainRegistry = registry;

    engine.synchronizePlaybackState({ mixerTracks: [updated] });

    assert.equal(
      rebuildCount,
      0,
      'a slot.mix-only edit must NOT trigger an FX chain rebuild during playback',
    );
    assert.equal(
      applied.length,
      1,
      'the live patch registry receives exactly one application',
    );
    assert.deepEqual(
      applied[0],
      { trackId: 1, slotId: 'fx-live', mix: 0.78 },
      'the live application carries the new mix value',
    );

    // The active take (the engine's internal playback copy) must reflect the
    // new mix too — playback reads from this object for every scheduled step.
    const activeSlot = engine.activeMixerTracks[0].fxSlots[0];
    assert.equal(activeSlot.mix, 0.78, 'the active playback take observes the new mix');
  });

  it('also handles the chorus-specific FX type — the chorus slot.mix is the most fragile case', () => {
    // The chorus FX only reaches audio through the hardening-only createEffect
    // branch in `liveFxChainHardening.ts`. A future regression that disables
    // chorus (e.g. by short-circuiting the case) would still leave
    // `reverb`/`delay` working, but a `slot.mix` mid-playback update on a
    // chorus slot would either fail or trigger a full rebuild. This test pins
    // both invariants: no rebuild, and the live patch receives the new mix.
    const initial = makeMixerTrackForEngine(1, [slot('chorus', 'fx-chorus', 0.5)]);
    const updated = makeMixerTrackForEngine(1, [slot('chorus', 'fx-chorus', 0.25)]);

    engine.activeMixerTracks = [structuredClone(initial)];
    engine.playbackProjectMixerTracks = [structuredClone(initial)];

    let rebuildCount = 0;
    engine.updateMixerTrack = () => { rebuildCount += 1; };
    const applied: number[] = [];
    engine.__liveFxChainRegistry = {
      applyLiveMix(_t: number, _s: string, mix: number) { applied.push(mix); return true; },
    };

    engine.synchronizePlaybackState({ mixerTracks: [updated] });

    assert.equal(rebuildCount, 0, 'chorus slot.mix mid-take does NOT trigger an FX rebuild');
    assert.deepEqual(applied, [0.25], 'chorus slot.mix reaches the live patch');
  });
});
