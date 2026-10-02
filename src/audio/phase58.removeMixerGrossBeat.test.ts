/**
 * Phase 58 — Remove dead mixer `gross_beat` insert.
 *
 * The mixer `gross_beat` FX type was a separate subsystem from the Phase 57
 * master-bus `grossBeat` amplitude gate. Its only reachable implementation was
 * a unity `GainNode` inside `liveFxChainHardening.createEffect` (net transfer
 * 1.000000 at every wet mix), so the picker entry advertised processing the
 * engine never performed. Phase 58 removes the mixer insert and keeps the real
 * Phase 57 master gate exactly as it was.
 *
 * These tests pin the product contract, not the deletion:
 *
 *   1. `gross_beat` is no longer a member of the mixer `FxType` union
 *      (compile-time assertions below, verified by `npm run lint`).
 *   2. The Mixer "Choose Effect Plugin" dropdown lists every supported FX and
 *      no longer exposes Gross Beat.
 *   3. Every remaining FX type still builds through the production
 *      `installLiveFxChainHardening` factory (live + offline) and still
 *      registers a real effect in the slot-id index.
 *   4. A legacy/persisted slot with the removed `gross_beat` type is dropped
 *      by the reachable factory instead of inserting a no-op unity gain, and
 *      the resulting graph is identical to a no-FX chain.
 *   5. The legacy `audioEngine.createFxNode` factory (retained for the Phase
 *      10C-B defensive chorus contract) also drops the removed type and still
 *      builds the remaining types.
 *   6. Existing wet/dry mix behaviour remains valid for every remaining FX.
 *   7. The Phase 57 master-bus Gross Beat amplitude gate remains present and
 *      functional: state contract, closed-step gain maths, and per-step master
 *      gain scheduling through the shared resolver.
 *   8. No production source references the removed mixer `gross_beat`
 *      identifier, while the Phase 57 `grossBeat` identifiers remain.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FxSlot, FxType, MixerTrack } from '../types/daw';
import { audioEngine } from './audioEngine';
import { getLiveFxSlotEffect, installLiveFxChainHardening } from './liveFxChainHardening';
import {
  GROSS_BEAT_MIX_DEPTH,
  GROSS_BEAT_OPEN_GAIN,
  GROSS_BEAT_STEP_COUNT,
  resolveGrossBeatClosedGain,
  resolveGrossBeatGateGain,
  type GrossBeatGateInput,
} from './grossBeatGate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, '..');

// ── Compile-time contract #1: FxType === supported set, without gross_beat ──

/**
 * The complete mixer FX surface that must remain reachable after Phase 58.
 * `satisfies` proves every entry is still a real `FxType`; the `Covered`
 * assertion below proves the union has no other members — so re-adding
 * `gross_beat` (or any other picker-less type) fails `npm run lint`.
 */
const SUPPORTED_MIXER_FX_TYPES = [
  'equalizer',
  'reverb',
  'delay',
  'distortion',
  'compressor',
  'chorus',
  'bitcrusher',
  'limiter',
  'tape_saturation',
] as const satisfies readonly FxType[];

type Covered<T extends string, U extends string> = [T] extends [U] ? true : false;
const unionIsCovered: Covered<FxType, (typeof SUPPORTED_MIXER_FX_TYPES)[number]> = true;
void unionIsCovered;

// Compile-time contract #2: the removed mixer insert cannot be typed again.
// `@ts-expect-error` is only satisfied while `'gross_beat'` is NOT an FxType;
// if the member ever returns, this directive becomes unused and lint fails.
// @ts-expect-error Phase 58 removed the dead mixer gross_beat insert.
const removedMixerFxType: FxType = 'gross_beat';
void removedMixerFxType;

/**
 * A legacy/persisted mixer slot carrying the removed type. Projects saved
 * before Phase 58 (or hand-edited files) can still contain this literal, and
 * the factories must drop it rather than insert anything. The double cast is
 * deliberate: it is the only way to simulate out-of-union persisted data while
 * production code stays strictly typed.
 */
function legacyRemovedSlot(id = 'gross-beat-legacy'): FxSlot {
  return {
    id,
    type: 'gross_beat' as unknown as FxType,
    name: 'Gross Beat',
    enabled: true,
    mix: 0.8,
    params: {},
  };
}

function supportedSlot(type: FxType, id = `${type}-1`, mix = 0.5): FxSlot {
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

// ── Shared Web Audio mocks ────────────────────────────────────────────────

type FakeParam = {
  value: number;
  setValueAtTime(value: number, time: number): void;
  setTargetAtTime(value: number, time: number, timeConstant: number): void;
  cancelScheduledValues(time: number): void;
};

type FakeNode = {
  connections: unknown[];
  disconnectCalls: number;
  connect(target: unknown): unknown;
  disconnect(): void;
};

type CountingContext = {
  ctx: AudioContext;
  nodes: Array<Record<string, unknown>>;
  createdDelays: number;
  createdOscillators: number;
  createdConstantSources: number;
};

function makeContext(): CountingContext {
  const nodes: Array<Record<string, unknown>> = [];
  const counters = { delays: 0, oscillators: 0, constantSources: 0 };

  const param = (value = 0): FakeParam => ({
    value,
    setValueAtTime(next: number) {
      this.value = next;
    },
    setTargetAtTime(next: number) {
      this.value = next;
    },
    cancelScheduledValues() {},
  });

  const make = <T extends Record<string, unknown>>(extra: T = {} as T): T & FakeNode => {
    const created = Object.assign(
      {
        connections: [],
        disconnectCalls: 0,
        connect(target: unknown) {
          this.connections.push(target);
          return target;
        },
        disconnect() {
          this.connections.length = 0;
          this.disconnectCalls += 1;
        },
      },
      extra,
    ) as T & FakeNode;
    nodes.push(created as unknown as Record<string, unknown>);
    return created;
  };

  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    destination: make(),
    createGain: () => make({ gain: param(1) }),
    createDelay: () => {
      counters.delays += 1;
      return make({ delayTime: param(0) });
    },
    createBiquadFilter: () => make({ type: 'lowpass', frequency: param(1000), Q: param(1), gain: param(0) }),
    createDynamicsCompressor: () => make({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0 }),
    createWaveShaper: () => make({ curve: null, oversample: 'none' }),
    createConvolver: () => make({ buffer: null }),
    createOscillator: () => {
      counters.oscillators += 1;
      return make({ frequency: param(0), start() {}, stop() {} });
    },
    createConstantSource: () => {
      counters.constantSources += 1;
      return make({ offset: param(0), start() {}, stop() {} });
    },
    createStereoPanner: () => make({ pan: param(0) }),
    createAnalyser: () => make({ fftSize: 0, smoothingTimeConstant: 0 }),
    createBuffer: (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
  } as unknown as AudioContext;

  return {
    ctx,
    nodes,
    get createdDelays() { return counters.delays; },
    get createdOscillators() { return counters.oscillators; },
    get createdConstantSources() { return counters.constantSources; },
  } as CountingContext;
}

type HardeningEngine = Parameters<typeof installLiveFxChainHardening>[0];
type RegistryEngine = Parameters<typeof getLiveFxSlotEffect>[0];

function makeLiveFixture() {
  const fixture = makeContext();
  const channel = {
    input: fixture.ctx.createGain(),
    panner: fixture.ctx.createGain(),
    fxNodes: [] as AudioNode[],
  };
  const engine = {
    getContext: () => fixture.ctx,
    getOrCreateMixerChannel: (_trackId: number) => channel,
    rebuildTrackFxChain(_track: MixerTrack) {},
    removeMixerChannel(_trackId: number) {},
  };
  installLiveFxChainHardening(engine as unknown as HardeningEngine);
  return { ...fixture, channel, engine };
}

// ── Test 1: FxType / picker contract ──────────────────────────────────────

describe('Phase 58: mixer FX registry no longer carries a Gross Beat insert', () => {
  it('keeps every remaining mixer FX type declared in FxType (runtime mirror of the compile-time check)', () => {
    // The compile-time `Covered` assertion above is the real contract; this
    // assertion keeps the list visible to the runtime suite so a deleted
    // member is reported as a test failure too, not only a lint failure.
    assert.deepEqual(
      [...SUPPORTED_MIXER_FX_TYPES],
      ['equalizer', 'reverb', 'delay', 'distortion', 'compressor', 'chorus', 'bitcrusher', 'limiter', 'tape_saturation'],
    );
  });

  it('Mixer picker lists exactly the supported FX and no Gross Beat entry', () => {
    const source = readFileSync(resolve(SRC_ROOT, 'components', 'Mixer.tsx'), 'utf8');
    const startIdx = source.indexOf('Add FX dropdown');
    assert.ok(startIdx >= 0, 'Could not locate the Add FX dropdown region in Mixer.tsx');
    const endIdx = source.indexOf('].map((fx) => (', startIdx);
    assert.ok(endIdx > startIdx, 'Could not locate the dropdown array close marker');
    const dropdown = source.slice(startIdx, endIdx);

    const ids = Array.from(dropdown.matchAll(/id:\s*'([^']+)'/g), (match) => match[1]);
    assert.deepEqual(
      [...ids].sort(),
      [...SUPPORTED_MIXER_FX_TYPES].sort(),
      'the picker must expose every supported mixer FX exactly once and nothing else',
    );
    assert.ok(
      !ids.includes('gross_beat'),
      'Gross Beat must no longer be offered as a mixer insert',
    );
    assert.ok(
      !/Gross Beat/i.test(dropdown),
      'the picker must not expose any "Gross Beat" insert label (Phase 57 master gate controls live elsewhere)',
    );
  });
});

// ── Test 2: reachable production factory ──────────────────────────────────

describe('Phase 58: production live FX factory', () => {
  it('builds and registers every remaining mixer FX type live and offline', () => {
    for (const type of SUPPORTED_MIXER_FX_TYPES) {
      for (const offline of [false, true]) {
        const { ctx, channel, engine } = makeLiveFixture();
        const offlineCtx = offline
          ? (Object.assign(Object.create(null), ctx, { startRendering: () => Promise.resolve({} as AudioBuffer) }) as AudioContext)
          : undefined;
        if (offline) {
          (engine as unknown as { ctx: AudioContext; isOfflineRendering: boolean }).ctx = offlineCtx!;
          (engine as unknown as { ctx: AudioContext; isOfflineRendering: boolean }).isOfflineRendering = true;
          (engine as unknown as { getContext: () => AudioContext }).getContext = () => offlineCtx!;
        }

        assert.doesNotThrow(
          () => engine.rebuildTrackFxChain(track(21, [supportedSlot(type)])),
          `${type}: ${offline ? 'offline' : 'live'} chain must build`,
        );
        assert.ok(
          getLiveFxSlotEffect(engine as unknown as RegistryEngine, 21, `${type}-1`),
          `${type}: ${offline ? 'offline' : 'live'} slot must register a real effect`,
        );
        assert.ok(channel.fxNodes.length > 0, `${type}: chain must wire nodes into the channel`);
      }
    }
  });

  it('drops a legacy gross_beat slot instead of inserting a unity-gain stub', () => {
    const { engine, channel } = makeLiveFixture();
    engine.rebuildTrackFxChain(track(22, [legacyRemovedSlot()]));

    assert.equal(
      getLiveFxSlotEffect(engine as unknown as RegistryEngine, 22, 'gross-beat-legacy'),
      undefined,
      'the removed mixer type must not register any effect in the live slot index',
    );
    assert.ok(
      !channel.fxNodes.some((node) => (node as unknown as { name?: string }).name === 'Time FX'),
      'the removed mixer type must not fall back to the old "Time FX" unity-gain stub',
    );
  });

  it('produces the same graph as a no-FX chain when only the removed slot is present', () => {
    const withRemoved = makeLiveFixture();
    const withoutFx = makeLiveFixture();

    withRemoved.engine.rebuildTrackFxChain(track(23, [legacyRemovedSlot()]));
    withoutFx.engine.rebuildTrackFxChain(track(23, []));

    assert.equal(
      withRemoved.channel.fxNodes.length,
      withoutFx.channel.fxNodes.length,
      'a dropped legacy slot must not add nodes to the live graph',
    );
    // Both chains must wire input → panner directly.
    assert.equal(
      (withRemoved.channel.input as unknown as FakeNode).connections[0],
      withRemoved.channel.panner,
      'a dropped legacy slot must leave input → panner wiring intact',
    );
  });

  it('keeps building the remaining FX after a dropped legacy slot in the same chain', () => {
    const { engine, channel } = makeLiveFixture();
    engine.rebuildTrackFxChain(track(24, [
      legacyRemovedSlot('gross-beat-legacy'),
      supportedSlot('reverb', 'reverb-1', 0.4),
    ]));

    assert.ok(
      getLiveFxSlotEffect(engine as unknown as RegistryEngine, 24, 'reverb-1'),
      'a supported slot following the dropped legacy slot must still be wired',
    );
    assert.equal(
      getLiveFxSlotEffect(engine as unknown as RegistryEngine, 24, 'gross-beat-legacy'),
      undefined,
      'the dropped legacy slot must not be registered',
    );
    assert.ok(channel.fxNodes.length > 0, 'the reverb slot must have produced nodes');
  });

  it('preserves the wet/dry mix contract for every remaining FX type', () => {
    for (const type of SUPPORTED_MIXER_FX_TYPES) {
      const { engine } = makeLiveFixture();
      engine.rebuildTrackFxChain(track(25, [supportedSlot(type)]));
      const effect = getLiveFxSlotEffect(engine as unknown as RegistryEngine, 25, `${type}-1`) as unknown as {
        setParameter?: (name: string, value: number, time: number) => void;
      };
      assert.equal(typeof effect?.setParameter, 'function', `${type}: effect must expose setParameter`);
      assert.doesNotThrow(
        () => effect!.setParameter!('mix', 0.37, 0.5),
        `${type}: live mix update must be accepted`,
      );
    }
  });
});

// ── Test 3: legacy factory (retained for the Phase 10C-B chorus contract) ──

const LEGACY_SAVED_KEYS = [
  'ctx',
  'masterGain',
  'masterAnalyser',
  'grossBeatNode',
  'mixerChannels',
  'isOfflineRendering',
  'offlineRenderLeaseHeld',
  'offlineRenderOperationDepth',
  'isPlaying',
  'mixerRoutingAdapter',
  'mixerRoutingChannelMap',
];

describe('Phase 58: legacy createFxNode factory', () => {
  const engineInternal = audioEngine as unknown as Record<string, unknown>;
  let saved: Record<string, unknown> = {};

  beforeEach(() => {
    saved = {};
    for (const key of LEGACY_SAVED_KEYS) saved[key] = engineInternal[key];

    const fixture = makeContext();
    engineInternal.ctx = fixture.ctx;
    engineInternal.masterGain = fixture.ctx.createGain();
    engineInternal.masterAnalyser = fixture.ctx.createAnalyser();
    engineInternal.grossBeatNode = null;
    engineInternal.mixerChannels = new Map();
    engineInternal.isOfflineRendering = false;
    engineInternal.offlineRenderLeaseHeld = false;
    engineInternal.offlineRenderOperationDepth = 0;
    engineInternal.isPlaying = false;
    engineInternal.mixerRoutingAdapter = null;
    engineInternal.mixerRoutingChannelMap = null;
  });

  afterEach(() => {
    for (const key of LEGACY_SAVED_KEYS) engineInternal[key] = saved[key];
  });

  it('drops a legacy gross_beat slot on the unwrapped path too', () => {
    // Do NOT install the hardening patch: this exercises the legacy
    // `audioEngine.createFxNode` switch directly.
    const channel = (audioEngine as unknown as {
      getOrCreateMixerChannel(id: number): { fxNodes: unknown[] };
    }).getOrCreateMixerChannel(31);
    audioEngine.rebuildTrackFxChain(track(31, [legacyRemovedSlot()]));

    assert.equal(
      channel.fxNodes.length,
      0,
      'the legacy factory must not build a unity GainNode for the removed type',
    );
  });

  it('still wires the remaining types the Phase 10C-B defensive contract covers', () => {
    const fixture = makeContext();
    engineInternal.ctx = fixture.ctx;

    const channel = (audioEngine as unknown as {
      getOrCreateMixerChannel(id: number): { fxNodes: unknown[] };
    }).getOrCreateMixerChannel(32);
    audioEngine.rebuildTrackFxChain(track(32, [
      supportedSlot('reverb', 'reverb-1'),
      supportedSlot('chorus', 'chorus-1'),
    ]));

    assert.ok(channel.fxNodes.length >= 2, 'reverb + chorus must still produce legacy FX nodes');
    assert.ok(fixture.createdDelays >= 1, 'legacy chorus must still create its delay line');
    assert.ok(fixture.createdOscillators >= 1, 'legacy chorus must still create its LFO');
    assert.ok(
      fixture.createdConstantSources >= 1,
      'legacy chorus must still create its ConstantSource offset',
    );
  });
});

// ── Test 4: Phase 57 master-bus gate stays intact ─────────────────────────

describe('Phase 58: Phase 57 master Gross Beat amplitude gate is untouched', () => {
  it('keeps the engine master-gate state contract', () => {
    const state = audioEngine.getGrossBeatState();
    assert.deepEqual(Object.keys(state).sort(), ['enabled', 'gateSteps', 'mix']);
    assert.equal(state.gateSteps.length, GROSS_BEAT_STEP_COUNT);

    const saved = audioEngine.getGrossBeatState();
    try {
      audioEngine.setGrossBeatState({ enabled: true, mix: 0.5 });
      const updated = audioEngine.getGrossBeatState();
      assert.equal(updated.enabled, true);
      assert.equal(updated.mix, 0.5);
    } finally {
      audioEngine.setGrossBeatState(saved);
    }
  });

  it('keeps the documented closed-step gain maths', () => {
    const gate: GrossBeatGateInput = {
      enabled: true,
      mix: 1,
      gateSteps: Array.from({ length: GROSS_BEAT_STEP_COUNT }, (_, index) => index % 2 === 0),
    };
    assert.equal(resolveGrossBeatGateGain(gate, 0), GROSS_BEAT_OPEN_GAIN);
    assert.equal(resolveGrossBeatGateGain(gate, 1), Math.max(0.01, 1 - 1 * GROSS_BEAT_MIX_DEPTH));
    // 1 - 0.95 is 0.050000000000000044 in IEEE-754; the Phase 57 suite pins
    // the documented 0.05 within an epsilon too.
    assert.ok(
      Math.abs(resolveGrossBeatClosedGain(1) - 0.05) < 1e-12,
      `full-depth closed gain must be the documented 0.05 (got ${resolveGrossBeatClosedGain(1)})`,
    );
    assert.equal(resolveGrossBeatGateGain({ ...gate, enabled: false }, 1), GROSS_BEAT_OPEN_GAIN);
  });

  it('still schedules master-bus gate gains on the transport step', () => {
    const engine = audioEngine as unknown as Record<string, unknown>;
    const saveKeys = [
      'ctx', 'grossBeatNode', 'grossBeatState', 'activePlayMode',
      'activeChannels', 'activeClips', 'currentStep', 'metronome', 'masterGain',
    ];
    const saved: Record<string, unknown> = {};
    for (const key of saveKeys) saved[key] = engine[key];

    const scheduled: number[] = [];
    const gateNode = {
      connect: () => gateNode,
      gain: {
        value: GROSS_BEAT_OPEN_GAIN,
        setTargetAtTime: (value: number) => { scheduled.push(value); },
        setValueAtTime: (value: number) => { scheduled.push(value); },
        cancelScheduledValues: () => undefined,
      },
    };

    try {
      const state: GrossBeatGateInput = {
        enabled: true,
        mix: 0.4,
        gateSteps: Array.from({ length: GROSS_BEAT_STEP_COUNT }, (_, index) => index % 2 === 0),
      };
      engine.ctx = { currentTime: 0, destination: {} };
      engine.grossBeatState = { ...state };
      engine.grossBeatNode = gateNode;
      engine.activePlayMode = 'pat';
      engine.activeChannels = [];
      engine.activeClips = [];
      engine.metronome = false;
      engine.masterGain = null;

      for (let step = 0; step < GROSS_BEAT_STEP_COUNT; step += 1) {
        engine.currentStep = step;
        (engine.triggerCurrentStep as (duration: number) => void).call(engine, 1);
      }

      const expected = Array.from(
        { length: GROSS_BEAT_STEP_COUNT },
        (_, step) => resolveGrossBeatGateGain(state, step),
      );
      assert.deepEqual(
        scheduled,
        expected,
        'the live transport must still drive the master gate through the shared resolver',
      );
    } finally {
      for (const key of saveKeys) engine[key] = saved[key];
    }
  });

  it('keeps both Phase 57 master-gate identifiers in the engine source', () => {
    const engineSource = readFileSync(resolve(SRC_ROOT, 'audio', 'audioEngine.ts'), 'utf8');
    assert.match(engineSource, /grossBeatNode/, 'the master-gate node must remain in the master chain');
    assert.match(engineSource, /resolveGrossBeatGateGain/, 'the master gate must keep using the shared resolver');
    const gateSource = readFileSync(resolve(SRC_ROOT, 'audio', 'grossBeatGate.ts'), 'utf8');
    assert.match(gateSource, /GROSS_BEAT_MIX_DEPTH/, 'the shared gate constant must remain');
  });
});

// ── Test 5: source hygiene (supplements the behavioural contracts above) ──

/**
 * Strip `//` and block comments while keeping string literal contents intact.
 * Phase 58 deliberately leaves short historical comments in the two factories
 * that used to special-case the removed type; the hygiene contract is that no
 * *executable* reference survives, not that the removal cannot be documented.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; index += 2; continue; }
      if (char === '/' && next === '*') { state = 'block'; index += 2; continue; }
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
      out += char;
      index += 1;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char; }
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; index += 2; continue; }
      if (char === '\n') out += char;
      index += 1;
      continue;
    }

    // Inside a string/template literal: copy verbatim, honouring escapes.
    if (char === '\\') {
      out += char;
      if (next !== undefined) out += next;
      index += 2;
      continue;
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      state = 'code';
    }
    out += char;
    index += 1;
  }

  return out;
}

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...productionSources(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

describe('Phase 58: source hygiene', () => {
  it('no production source executes or declares the removed mixer gross_beat identifier', () => {
    const offenders = productionSources(SRC_ROOT)
      .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('gross_beat'))
      .map((file) => file.slice(SRC_ROOT.length + 1));
    assert.deepEqual(
      offenders,
      [],
      'the mixer gross_beat identifier must not survive in production code outside explanatory comments ' +
        '(Phase 57 uses grossBeat)',
    );
  });

  it('keeps the Phase 57 grossBeat subsystem referenced', () => {
    const sources = productionSources(SRC_ROOT).map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const identifier of ['grossBeatNode', 'grossBeatState', 'GrossBeatState', 'grossBeatGate']) {
      assert.ok(
        sources.includes(identifier),
        `Phase 57 master-gate identifier "${identifier}" must remain in production code`,
      );
    }
  });
});
