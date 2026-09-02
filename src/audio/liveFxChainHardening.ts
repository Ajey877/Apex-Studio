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
  return new WetDryEffect(ctx, effect, mix);
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

  const core = new CompositeEffect(`${slot.id}-tape-core`, 'Tape Saturation', saturation.input, flutterDelay, [filter, flutterDelay, lfo, depth], [saturation]);
  return wrapWetDry(ctx, core, mixFor(slot));
}

function createEqualizer(ctx: AudioContext, slot: FxSlot): AudioEffect {
  const low = new BiquadFilterEffect(ctx, `${slot.id}-low`, 'lowshelf', bounded(numericParam(slot, 'lowFreq', 120), 10, ctx.sampleRate / 2), numericParam(slot, 'lowQ', 1), numericParam(slot, 'lowGain', 0));
  const mid = new BiquadFilterEffect(ctx, `${slot.id}-mid`, 'peaking', bounded(numericParam(slot, 'midFreq', 1200), 10, ctx.sampleRate / 2), bounded(numericParam(slot, 'midQ', 1.2), 0.0001, 1000), numericParam(slot, 'midGain', 0));
  const high = new BiquadFilterEffect(ctx, `${slot.id}-high`, 'highshelf', bounded(numericParam(slot, 'highFreq', 6500), 10, ctx.sampleRate / 2), numericParam(slot, 'highQ', 1), numericParam(slot, 'highGain', 0));
  low.output.connect(mid.input);
  mid.output.connect(high.input);
  const core = new CompositeEffect(`${slot.id}-eq-core`, '3-Band EQ', low.input, high.output, [], [low, mid, high]);
  return wrapWetDry(ctx, core, mixFor(slot));
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
  const core = new CompositeEffect(`${slot.id}-${type}`, type === 'distortion' ? 'Distortion' : 'Bitcrusher', shaper, shaper, [shaper]);
  return wrapWetDry(ctx, core, mixFor(slot));
}

function createReverb(ctx: AudioContext, slot: FxSlot): AudioEffect {
  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulse(ctx);
  const core = new CompositeEffect(`${slot.id}-reverb`, 'Reverb', convolver, convolver, [convolver]);
  return wrapWetDry(ctx, core, mixFor(slot));
}

function createEffect(ctx: AudioContext, slot: FxSlot): AudioEffect | null {
  switch (slot.type) {
    case 'equalizer': return createEqualizer(ctx, slot);
    case 'reverb': return createReverb(ctx, slot);
    case 'delay': {
      const effect = new DelayEffect(ctx, slot.id, numericParam(slot, 'time', 0.35), bounded(numericParam(slot, 'feedback', 0.45), 0, 0.989), 1);
      return wrapWetDry(ctx, effect, mixFor(slot));
    }
    case 'distortion': return createNativeWaveShaper(ctx, slot, 'distortion');
    case 'compressor': {
      const effect = new DynamicsCompressorEffect(ctx, slot.id, numericParam(slot, 'threshold', -18), bounded(numericParam(slot, 'knee', 24), 0, 40), bounded(numericParam(slot, 'ratio', 4), 1, 20), bounded(numericParam(slot, 'attack', 0.005), 0, 1), bounded(numericParam(slot, 'release', 0.15), 0, 1));
      return wrapWetDry(ctx, effect, mixFor(slot));
    }
    case 'chorus': {
      const delay = bounded(numericParam(slot, 'delay', 0.02), 0.005, 0.08);
      const depth = bounded(numericParam(slot, 'depth', 0.003), 0, Math.min(0.02, delay));
      const effect = new ChorusEffect(ctx, slot.id, bounded(numericParam(slot, 'rate', 1.2), 0.05, 20), depth, delay, 1);
      return wrapWetDry(ctx, effect, mixFor(slot));
    }
    case 'bitcrusher': return createNativeWaveShaper(ctx, slot, 'bitcrusher');
    case 'limiter': {
      const effect = new LimiterEffect(ctx, slot.id, bounded(numericParam(slot, 'ceiling', -0.3), -12, 0), bounded(numericParam(slot, 'release', 0.08), 0.01, 1), numericParam(slot, 'drive', 0), 1);
      return wrapWetDry(ctx, effect, mixFor(slot));
    }
    case 'tape_saturation': return createTapeEffect(ctx, slot);
    case 'gross_beat': {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      const core = new CompositeEffect(`${slot.id}-gross-beat`, 'Gross Beat', gain, gain, [gain]);
      return wrapWetDry(ctx, core, mixFor(slot));
    }
    default: return null;
  }
}

export function installLiveFxChainHardening(engine: AudioEngineLike): void {
  if (installed.has(engine as object)) return;
  installed.add(engine as object);

  const states = new Map<number, AudioEffect[]>();

  engine.rebuildTrackFxChain = function rebuildTrackFxChain(track: MixerTrack): void {
    const ctx = this.getContext();
    const channel = this.getOrCreateMixerChannel(track.id);
    const previousEffects = states.get(track.id) ?? [];

    try { channel.input.disconnect(); } catch (_) {}
    for (const node of channel.fxNodes) {
      try { node.disconnect(); } catch (_) {}
    }
    for (const effect of previousEffects) effect.dispose();
    states.delete(track.id);
    channel.fxNodes = [];

    let current: AudioNode = channel.input;
    const created: AudioEffect[] = [];
    for (const slot of track.fxSlots) {
      if (!slot.enabled) continue;
      const effect = createEffect(ctx, slot);
      if (!effect) continue;
      current.connect(effect.input);
      current = effect.output;
      created.push(effect);
      if (!channel.fxNodes.includes(effect.input)) channel.fxNodes.push(effect.input);
      if (!channel.fxNodes.includes(effect.output)) channel.fxNodes.push(effect.output);
    }

    current.connect(channel.panner);
    states.set(track.id, created);
  };

  const originalRemove = engine.removeMixerChannel;
  engine.removeMixerChannel = function removeMixerChannel(trackId: number): void {
    const effects = states.get(trackId) ?? [];
    for (const effect of effects) effect.dispose();
    states.delete(trackId);
    originalRemove.call(this, trackId);
  };
}
