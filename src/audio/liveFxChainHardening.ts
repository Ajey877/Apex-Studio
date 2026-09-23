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
  ) {
    this.input = input;
    this.output = output;
  }

  setParameter(): void {
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
  return new CompositeEffect(`${slot.id}-eq-core`, '3-Band EQ', low.input, high.output, [], [low, mid, high]);
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

function createReverb(ctx: AudioContext, slot: FxSlot): AudioEffect {
  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulse(ctx);
  return new CompositeEffect(`${slot.id}-reverb`, 'Reverb', convolver, convolver, [convolver]);
}

function createEffect(ctx: AudioContext, slot: FxSlot): AudioEffect | null {
  const mix = mixFor(slot);

  switch (slot.type) {
    case 'equalizer': return wrapWetDry(ctx, createEqualizer(ctx, slot), mix);
    case 'reverb': return wrapWetDry(ctx, createReverb(ctx, slot), mix);
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
    case 'gross_beat': {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      const core = new CompositeEffect(`${slot.id}-gross-beat`, 'Time FX', gain, gain, [gain]);
      return wrapWetDry(ctx, core, mix);
    }
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
  getChain(trackId: number): LiveFxChainHandle | undefined;
}

function buildChain(track: MixerTrack, ctx: AudioContext): {
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
    const effect = createEffect(ctx, slot);
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

      const built = buildChain(track, ctx);
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
