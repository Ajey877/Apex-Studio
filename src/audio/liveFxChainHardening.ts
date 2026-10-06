import type { FxSlot, MixerTrack } from '../types/daw';
import type { AudioEffect } from './effects/AudioEffect';
import { BiquadFilterEffect } from './effects/BiquadFilterEffect';
import { ChorusEffect } from './effects/ChorusEffect';
import { DelayEffect } from './effects/DelayEffect';
import { DynamicsCompressorEffect } from './effects/DynamicsCompressorEffect';
import { LimiterEffect } from './effects/LimiterEffect';
import { SaturationEffect } from './effects/SaturationEffect';
import { WetDryEffect } from './effects/WetDryEffect';

interface MixerChannelLike {
  input: AudioNode;
  panner: AudioNode;
  fxNodes: AudioNode[];
}

interface AudioEngineLike {
  getContext(): AudioContext;
  getOrCreateMixerChannel(trackId: number): MixerChannelLike;
  getOfflineReverbImpulseResponse?(): AudioBuffer | undefined;
  rebuildTrackFxChain(track: MixerTrack): void;
  removeMixerChannel(trackId: number): void;
}

class CompositeEffect implements AudioEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;

  constructor(
    readonly id: string,
    readonly name: string,
    input: AudioNode,
    output: AudioNode,
    private readonly nodes: AudioNode[],
    private readonly effects: AudioEffect[] = [],
    /**
     * Optional slot-param → AudioEffect route. When provided,
     * `setParameter(name, value, time)` looks up `name` here and forwards
     * the call to the matching inner AudioEffect's AudioParam. This is
     * what makes the EQ's per-band params (`lowFreq` → inner low-band
     * BiquadFilterEffect's `frequency`) live-updatable without rebuilding
     * the chain.
     */
    private readonly paramRoutes?: Readonly<Record<string, { effect: AudioEffect; audioParam: string }>>,
  ) {
    this.input = input;
    this.output = output;
  }

  setParameter(name: string, value: number, time: number): void {
    if (this.paramRoutes && Object.prototype.hasOwnProperty.call(this.paramRoutes, name)) {
      const route = this.paramRoutes[name]!;
      route.effect.setParameter(route.audioParam, value, time);
      return;
    }
    throw new Error(`${this.name} exposes fixed live-chain parameters.`);
  }

  dispose(): void {
    for (const effect of this.effects) effect.dispose();
    for (const node of this.nodes) {
      try {
        if ('stop' in node && typeof (node as any).stop === 'function') {
          (node as any).stop();
        }
      } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    }
  }
}

const installed = new WeakSet<object>();

/**
 * Phase 80: translate a slot-param name (the contract surface) into the
 * name the AudioEffect's `setParameter` contract expects. Most slot-param
 * names match the AudioEffect names directly (compressor, limiter,
 * WetDry's `mix`). EQ performs its own translation via
 * CompositeEffect.paramRoutes (per-band slot-params → `frequency`/`gain`/`q`).
 *
 * The only family that needs registry-side translation is delay, where
 * the slot stores `time` but the DelayEffect contract is `delayTime`. The
 * `createEffect` factory reads `slot.params.time` at construction and
 * passes the value to the DelayEffect constructor, but at runtime the
 * AudioEffect.setParameter switch only recognises `delayTime`. The
 * translate is a no-op for every other case.
 */
function translateSlotParamToFxName(effect: AudioEffect, slotParamName: string): string {
  // Only the WetDryEffect wrapping a DelayEffect needs the translate;
  // we identify it by the inner effect's `name` field.
  const inner = (effect as unknown as { instance?: { name?: string } }).instance
    ?? (effect as unknown as { effect?: { name?: string } }).effect;
  const innerName = (inner as unknown as { name?: string })?.name;
  if (innerName === 'Delay') {
    if (slotParamName === 'time') return 'delayTime';
  }
  return slotParamName;
}

function numericParam(slot: FxSlot, name: string, fallback: number): number {
  const raw = slot.params?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`FX parameter ${name} must be finite.`);
  return value;
}

function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mixFor(slot: FxSlot): number {
  const mix = Number(slot.mix);
  if (!Number.isFinite(mix) || mix < 0 || mix > 1) {
    throw new RangeError(`FX mix for ${slot.type} must be between 0 and 1.`);
  }
  return mix;
}

function wrapWetDry(ctx: AudioContext, effect: AudioEffect, mix: number): AudioEffect {
  try {
    return new WetDryEffect(ctx, effect, mix);
  } catch (error) {
    effect.dispose();
    throw error;
  }
}

function createImpulse(ctx: AudioContext): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * 2.5));
  const impulse = ctx.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  for (let i = 0; i < length; i += 1) {
    const decay = Math.pow(1 - i / length, 2);
    left[i] = (Math.random() * 2 - 1) * decay;
    right[i] = (Math.random() * 2 - 1) * decay;
  }
  return impulse;
}

function createTapeEffect(ctx: AudioContext, slot: FxSlot): AudioEffect {
  const drive = bounded(numericParam(slot, 'drive', 35) / 100, 0, 1);
  const warmth = bounded(numericParam(slot, 'warmth', 0.8), 0, 1);
  const flutter = bounded(numericParam(slot, 'flutter', 0.001), 0, 0.004);

  const saturation = new SaturationEffect(ctx, `${slot.id}-saturation`, drive, 1);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = bounded(16000 - warmth * 4000, 2000, ctx.sampleRate / 2);
  filter.Q.value = 0.7;

  const flutterDelay = ctx.createDelay(0.1);
  flutterDelay.delayTime.value = 0.005;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.5;
  const depth = ctx.createGain();
  depth.gain.value = flutter;

  saturation.output.connect(filter);
  filter.connect(flutterDelay);
  lfo.connect(depth);
  depth.connect(flutterDelay.delayTime);
  lfo.start();

  return new CompositeEffect(`${slot.id}-tape-core`, 'Tape Saturation', saturation.input, flutterDelay, [filter, flutterDelay, lfo, depth], [saturation]);
}

function createEqualizer(ctx: AudioContext, slot: FxSlot): AudioEffect {
  const low = new BiquadFilterEffect(ctx, `${slot.id}-low`, 'lowshelf', bounded(numericParam(slot, 'lowFreq', 120), 10, ctx.sampleRate / 2), bounded(numericParam(slot, 'lowQ', 1), 0.0001, 1000), bounded(numericParam(slot, 'lowGain', 0), -40, 40));
  const mid = new BiquadFilterEffect(ctx, `${slot.id}-mid`, 'peaking', bounded(numericParam(slot, 'midFreq', 1200), 10, ctx.sampleRate / 2), bounded(numericParam(slot, 'midQ', 1.2), 0.0001, 1000), bounded(numericParam(slot, 'midGain', 0), -40, 40));
  const high = new BiquadFilterEffect(ctx, `${slot.id}-high`, 'highshelf', bounded(numericParam(slot, 'highFreq', 6500), 10, ctx.sampleRate / 2), bounded(numericParam(slot, 'highQ', 1), 0.0001, 1000), bounded(numericParam(slot, 'highGain', 0), -40, 40));
  low.output.connect(mid.input);
  mid.output.connect(high.input);
  // Phase 80: route per-band slot-param names to the inner
  // BiquadFilterEffect's AudioParam. This is the live-edit plumbing
  // for the EQ family — without it, an EQ band parameter edit would
  // require a chain rebuild on every move, and the contract test
  // rejects that as a fake parameter.
  const paramRoutes: Record<string, { effect: AudioEffect; audioParam: string }> = {
    lowFreq: { effect: low, audioParam: 'frequency' },
    lowGain: { effect: low, audioParam: 'gain' },
    lowQ: { effect: low, audioParam: 'q' },
    midFreq: { effect: mid, audioParam: 'frequency' },
    midGain: { effect: mid, audioParam: 'gain' },
    midQ: { effect: mid, audioParam: 'q' },
    highFreq: { effect: high, audioParam: 'frequency' },
    highGain: { effect: high, audioParam: 'gain' },
    highQ: { effect: high, audioParam: 'q' },
  };
  return new CompositeEffect(`${slot.id}-eq-core`, '3-Band EQ', low.input, high.output, [], [low, mid, high], paramRoutes);
}

function createNativeWaveShaper(ctx: AudioContext, slot: FxSlot, type: 'distortion' | 'bitcrusher'): AudioEffect {
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '4x';
  const curve = new Float32Array(1024);
  if (type === 'distortion') {
    const drive = Math.max(0, numericParam(slot, 'drive', 20));
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i * 2) / curve.length - 1;
      curve[i] = ((3 + drive) * x * 20 * (Math.PI / 180)) / (Math.PI + drive * Math.abs(x));
    }
  } else {
    const bits = bounded(Math.round(numericParam(slot, 'bits', 4)), 1, 16);
    const steps = Math.pow(2, bits);
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i * 2) / curve.length - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
  }
  shaper.curve = curve;
  return new CompositeEffect(`${slot.id}-${type}`, type === 'distortion' ? 'Distortion' : 'Bitcrusher', shaper, shaper, [shaper]);
}

function createReverb(ctx: AudioContext, slot: FxSlot, offlineImpulse?: AudioBuffer): AudioEffect {
  const convolver = ctx.createConvolver();
  // Offline export supplies the seeded impulse already created by AudioEngine.
  // The live path intentionally keeps generating its existing per-chain impulse.
  convolver.buffer = offlineImpulse ?? createImpulse(ctx);
  return new CompositeEffect(`${slot.id}-reverb`, 'Reverb', convolver, convolver, [convolver]);
}

function createEffect(ctx: AudioContext, slot: FxSlot, offlineReverbImpulse?: AudioBuffer): AudioEffect | null {
  const mix = mixFor(slot);

  switch (slot.type) {
    case 'equalizer': return wrapWetDry(ctx, createEqualizer(ctx, slot), mix);
    case 'reverb': return wrapWetDry(ctx, createReverb(ctx, slot, offlineReverbImpulse), mix);
    case 'delay': {
      const time = bounded(numericParam(slot, 'time', 0.35), 0, 10);
      const feedback = bounded(numericParam(slot, 'feedback', 0.45), 0, 0.989);
      const effect = new DelayEffect(ctx, slot.id, time, feedback, 1);
      return wrapWetDry(ctx, effect, mix);
    }
    case 'distortion': return wrapWetDry(ctx, createNativeWaveShaper(ctx, slot, 'distortion'), mix);
    case 'compressor': {
      const effect = new DynamicsCompressorEffect(
        ctx,
        slot.id,
        bounded(numericParam(slot, 'threshold', -18), -100, 0),
        bounded(numericParam(slot, 'knee', 24), 0, 40),
        bounded(numericParam(slot, 'ratio', 4), 1, 20),
        bounded(numericParam(slot, 'attack', 0.005), 0, 1),
        bounded(numericParam(slot, 'release', 0.15), 0, 1),
      );
      return wrapWetDry(ctx, effect, mix);
    }
    case 'chorus': {
      const delay = bounded(numericParam(slot, 'delay', 0.02), 0.005, 0.08);
      const depth = bounded(numericParam(slot, 'depth', 0.003), 0, Math.min(0.02, delay));
      const effect = new ChorusEffect(ctx, slot.id, bounded(numericParam(slot, 'rate', 1.2), 0.05, 20), depth, delay, 1);
      return wrapWetDry(ctx, effect, mix);
    }
    case 'bitcrusher': return wrapWetDry(ctx, createNativeWaveShaper(ctx, slot, 'bitcrusher'), mix);
    case 'limiter': {
      const effect = new LimiterEffect(ctx, slot.id, bounded(numericParam(slot, 'ceiling', -0.3), -12, 0), bounded(numericParam(slot, 'release', 0.08), 0.01, 1), bounded(numericParam(slot, 'drive', 0), -12, 24), 1);
      return wrapWetDry(ctx, effect, mix);
    }
    case 'tape_saturation': return wrapWetDry(ctx, createTapeEffect(ctx, slot), mix);
    // Phase 58: the dead mixer `gross_beat` insert (a unity GainNode that never
    // processed audio) was removed from `FxType`. Slot objects carried in by
    // pre-Phase-58 projects fall through to `default` and are dropped instead
    // of inserting a no-op node. Phase 57's master-bus `grossBeat` amplitude
    // gate lives in `grossBeatGate.ts`/`audioEngine.ts` and is unrelated.
    default: return null;
  }
}

export interface LiveFxChainHandle {
  /** Per-slot effect lookup keyed by FxSlot.id — populated at chain construction. */
  readonly slotEffects: ReadonlyMap<string, AudioEffect>;
}

/**
 * Side-channel registry shared between `installLiveFxChainHardening` and the
 * rest of the audio engine. Phase 10B uses this to:
 *   (1) update slot.mix on the live WetDry wrapper without tearing the chain
 *       down on every slider tick, and
 *   (2) let the engine reach the same WetDry during fx_mix automation, so
 *       playback and export both share a single live + offline code path.
 *
 * Lookup is by (trackId, slotId). An entry is registered when
 * `rebuildTrackFxChain` constructs the chain for a track, and cleared on
 * `removeMixerChannel` or the next rebuild of that track.
 */
interface LiveFxChainRegistry {
  applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
  /**
   * Apply a single named parameter to a live slot's underlying AudioEffect
   * without rebuilding the chain. Returns true when the live chain owns a
   * slot with that id AND the effect supports the parameter; false
   * otherwise (caller should rebuild the chain or correct the parameter
   * name). `paramName` is the AudioEffect.setParameter contract — typically
   * the engine-level names (`threshold`, `ratio`, `attack`, `release`,
   * `knee`, `delayTime`, `feedback`, `decay`, `wet`, `dry`, `ceiling`,
   * `drive`, `frequency`, `q`, `gain`, …). Names not on the contract are
   * rejected so a typo cannot silently no-op.
   */
  applyLiveParameter(trackId: number, slotId: string, paramName: string, value: number, currentTime: number): boolean;
  getChain(trackId: number): LiveFxChainHandle | undefined;
}

function buildChain(track: MixerTrack, ctx: AudioContext, offlineReverbImpulse?: AudioBuffer): {
  effects: AudioEffect[];
  slotIndex: Map<string, AudioEffect>;
  createdNodes: AudioNode[];
  firstInput: AudioNode | null;
  current: AudioNode | null;
} {
  const effects: AudioEffect[] = [];
  const slotIndex = new Map<string, AudioEffect>();
  const createdNodes: AudioNode[] = [];
  let firstInput: AudioNode | null = null;
  let current: AudioNode | null = null;

  for (const slot of track.fxSlots) {
    if (!slot.enabled) continue;
    const effect = createEffect(ctx, slot, offlineReverbImpulse);
    if (!effect) continue;

    if (!firstInput) firstInput = effect.input;
    if (current) current.connect(effect.input);
    current = effect.output;
    effects.push(effect);
    // The WetDry wrapper owns the slot.id and forwards unsupported setParameter
    // calls through to the inner effect, so lookups by slotId hit the wrapper
    // (which is what owns the dry/wet gain pair).
    slotIndex.set(slot.id, effect);
    if (!createdNodes.includes(effect.input)) createdNodes.push(effect.input);
    if (effect.output !== effect.input && !createdNodes.includes(effect.output)) createdNodes.push(effect.output);
  }

  return { effects, slotIndex, createdNodes, firstInput, current };
}

function boundedMix(mix: number): number {
  if (!Number.isFinite(mix)) return 0;
  return Math.max(0, Math.min(1, mix));
}

export function installLiveFxChainHardening(engine: AudioEngineLike): void {
  if (installed.has(engine as object)) return;
  installed.add(engine as object);

  const states = new Map<number, AudioEffect[]>();
  // Per-track slot-id index. Cleared on every rebuild of that track's chain.
  const slotIndexByTrack = new Map<number, Map<string, AudioEffect>>();

  const registry: LiveFxChainRegistry = {
    getChain(trackId: number) {
      const slotIndex = slotIndexByTrack.get(trackId);
      if (!slotIndex) return undefined;
      return { slotEffects: slotIndex };
    },
    applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean {
      const slotIndex = slotIndexByTrack.get(trackId);
      const effect = slotIndex?.get(slotId);
      if (!effect) return false;
      try {
        effect.setParameter('mix', boundedMix(mix), currentTime);
        return true;
      } catch (_) {
        return false;
      }
    },
    applyLiveParameter(trackId: number, slotId: string, paramName: string, value: number, currentTime: number): boolean {
      if (!Number.isFinite(value)) return false;
      const slotIndex = slotIndexByTrack.get(trackId);
      const effect = slotIndex?.get(slotId);
      if (!effect) return false;
      try {
        // Phase 80: translate the slot-param name (the contract surface)
        // to the AudioEffect param name. EQ does this internally via its
        // CompositeEffect.paramRoutes; the other families rely on a
        // direct name match, EXCEPT delay which stores `time` in the
        // slot but consumes `delayTime` on the DelayEffect contract.
        // The translate table is the single source of truth for slot-param
        // → AudioParam renames; it is the registry-side mirror of
        // fxParameterContract.ts (the contract test pins parity).
        const translated = translateSlotParamToFxName(effect, paramName);
        // WetDryEffect.setParameter forwards non-'mix' names to its inner
        // effect, so the AudioEffect contract is reached in one call.
        effect.setParameter(translated, value, currentTime);
        return true;
      } catch (_) {
        return false;
      }
    },
  };
  // Expose the registry on the engine for the audio engine and tests.
  (engine as unknown as { __liveFxChainRegistry: LiveFxChainRegistry }).__liveFxChainRegistry = registry;

  engine.rebuildTrackFxChain = function rebuildTrackFxChain(track: MixerTrack): void {
    const rawCtx = (this as any).ctx;
    const isOffline = (this as any).isOfflineRendering ||
      (rawCtx && (typeof rawCtx.startRendering === 'function' || (typeof OfflineAudioContext !== 'undefined' && rawCtx instanceof OfflineAudioContext)));
    const ctx = isOffline && rawCtx ? rawCtx : this.getContext();
    const channel = this.getOrCreateMixerChannel(track.id);

    if (isOffline) {
      try { channel.input.disconnect(); } catch (_) {}
      for (const node of channel.fxNodes) {
        try { node.disconnect(); } catch (_) {}
      }
      channel.fxNodes = [];

      const offlineReverbImpulse = this.getOfflineReverbImpulseResponse?.();
      const built = buildChain(track, ctx, offlineReverbImpulse);
      if (built.firstInput && built.current) {
        channel.input.connect(built.firstInput);
        built.current.connect(channel.panner);
        channel.fxNodes = built.createdNodes;
      } else {
        channel.input.connect(channel.panner);
      }
      // Offline renders are not registered for live re-application; the chain
      // is rebuilt per export. The slot index still helps tests inspect state.
      slotIndexByTrack.set(track.id, built.slotIndex);
      return;
    }

    const previousEffects = states.get(track.id) ?? [];
    let created: AudioEffect[] = [];
    let createdNodes: AudioNode[] = [];
    let firstInput: AudioNode | null = null;
    let current: AudioNode | null = null;
    let slotIndex: Map<string, AudioEffect> = new Map();

    try {
      const built = buildChain(track, ctx);
      created = built.effects;
      createdNodes = built.createdNodes;
      firstInput = built.firstInput;
      current = built.current;
      slotIndex = built.slotIndex;

      (current ?? channel.input).connect(channel.panner);
    } catch (error) {
      for (const effect of created) effect.dispose();
      throw error;
    }

    try { channel.input.disconnect(); } catch (_) {}
    for (const node of channel.fxNodes) {
      try { node.disconnect(); } catch (_) {}
    }
    for (const effect of previousEffects) effect.dispose();
    states.delete(track.id);
    channel.fxNodes = [];

    if (firstInput) {
      channel.input.connect(firstInput);
      channel.fxNodes = createdNodes;
    } else {
      channel.input.connect(channel.panner);
    }

    states.set(track.id, created);
    slotIndexByTrack.set(track.id, slotIndex);
  };

  const originalRemove = engine.removeMixerChannel;
  engine.removeMixerChannel = function removeMixerChannel(trackId: number): void {
    const effects = states.get(trackId) ?? [];
    for (const effect of effects) effect.dispose();
    states.delete(trackId);
    slotIndexByTrack.delete(trackId);
    originalRemove.call(this, trackId);
  };
}

/**
 * Phase 10B: Apply a new `mix` value to the live WetDry wrapper that owns the
 * given slot, without tearing down the active chain. Returns `true` when the
 * live chain owns a slot with that id; `false` when the caller must rebuild
 * the chain (no live instance, slot disabled, or unknown slot id).
 */
export function applyLiveFxChainMix(
  engine: { __liveFxChainRegistry?: LiveFxChainRegistry },
  trackId: number,
  slotId: string,
  mix: number,
  currentTime: number,
): boolean {
  return engine.__liveFxChainRegistry?.applyLiveMix(trackId, slotId, mix, currentTime) ?? false;
}

/**
 * Phase 10B: Resolve the AudioEffect (typically a `WetDryEffect`) that backs
 * the named slot on the live chain, or `undefined` when the chain has not
 * been built yet (playback stopped) or the slot is not present.
 */
export function getLiveFxSlotEffect(
  engine: { __liveFxChainRegistry?: LiveFxChainRegistry },
  trackId: number,
  slotId: string,
): AudioEffect | undefined {
  return engine.__liveFxChainRegistry?.getChain(trackId)?.slotEffects.get(slotId);
}

/**
 * Phase 80: Apply a single named parameter to the live AudioEffect that
 * backs the named slot, without rebuilding the chain. Mirrors
 * `applyLiveFxChainMix` for the `mix` value but works for every parameter
 * the effect's `setParameter` contract accepts. Returns true when the live
 * chain owns a slot with that id AND the effect accepted the value; false
 * when the caller must rebuild the chain (no live instance, slot disabled,
 * or the effect rejected the parameter — e.g. an unknown name or
 * out-of-range value).
 */
export function applyLiveFxSlotParameter(
  engine: { __liveFxChainRegistry?: LiveFxChainRegistry },
  trackId: number,
  slotId: string,
  paramName: string,
  value: number,
  currentTime: number,
): boolean {
  return engine.__liveFxChainRegistry?.applyLiveParameter(trackId, slotId, paramName, value, currentTime) ?? false;
}
