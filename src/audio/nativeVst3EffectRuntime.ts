import type { FxSlot, MixerTrack } from '../types/daw';
import type { Vst3Effect, Vst3ParameterChange, Vst3Parameter, Vst3Bridge } from './nativeVst3Types';
import { assertVst3Effect, getVst3Bridge } from './nativeVst3Types';

export interface Vst3MixerEffectDiagnostic {
  trackId: number;
  slotId: string;
  message: string;
  /** Fixed worklet buffering delay; plugin-reported latency must be zero. */
  pipelineLatencyMs?: number;
}

const listeners = new Set<() => void>();
let diagnostics: readonly Vst3MixerEffectDiagnostic[] = [];
export const getVst3MixerEffectDiagnostics = () => diagnostics;
export const subscribeVst3MixerEffectDiagnostics = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function reportVst3MixerEffect(trackId: number, slotId: string, message: string, pipelineLatencyMs?: number) {
  diagnostics = [...diagnostics.filter(item => !(item.trackId === trackId && item.slotId === slotId)),
    { trackId, slotId, message, ...(pipelineLatencyMs === undefined ? {} : { pipelineLatencyMs }) }].slice(-32);
  listeners.forEach(listener => listener());
}
function clearDiagnostic(trackId: number, slotId: string) {
  const next = diagnostics.filter(item => !(item.trackId === trackId && item.slotId === slotId));
  if (next.length !== diagnostics.length) { diagnostics = next; listeners.forEach(listener => listener()); }
}

export const VST3_FX_BLOCK_FRAMES = 1024;
export const VST3_FX_PIPELINE_FRAMES = VST3_FX_BLOCK_FRAMES * 2;

/**
 * Real-time bridge contract: the AudioWorklet never performs IPC or waits. It
 * captures 1024-frame blocks and requires the helper result before the output
 * cursor reaches that block. A two-block fixed FIFO gives the non-real-time
 * control thread one block of scheduling time. Missing/deadline-missed results
 * become silence and an explicit stop/failure, never dry or stale PCM.
 */
export const VST3_FX_WORKLET_SOURCE = `
class ApexVst3FxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockFrames = ${VST3_FX_BLOCK_FRAMES};
    this.delayFrames = ${VST3_FX_PIPELINE_FRAMES};
    this.left = new Float32Array(this.blockFrames);
    this.right = new Float32Array(this.blockFrames);
    this.fill = 0;
    this.inputFrame = 0;
    this.outputFrame = 0;
    this.sequence = 0;
    this.pending = -1;
    this.ready = new Map();
    this.dryReady = new Map();
    this.bypass = false;
    this.failed = false;
    this.port.onmessage = event => {
      const message = event.data;
      if (message?.type === 'bypass') { this.bypass = !!message.value; return; }
      if (message?.type === 'failure') { this.failed = true; return; }
      if (message?.type !== 'result' || this.failed || message.sequence !== this.pending ||
          !(message.samples instanceof Float32Array) || message.samples.length !== this.blockFrames * 2) return;
      this.pending = -1;
      this.ready.set(message.sequence, message.samples);
      if (this.ready.size > 2 || this.dryReady.size > 2) this.fail('Native effect output queue exceeded its two-block bound.');
    };
  }
  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.ready.clear();
    this.dryReady.clear();
    this.port.postMessage({ type: 'failure', reason });
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    for (const channel of out) channel.fill(0);
    if (this.failed) return true;
    const input = inputs[0];
    const left = input?.[0], right = input?.[1] || left;
    if (left && right) {
      for (let i = 0; i < left.length; i++) {
        this.left[this.fill] = left[i];
        this.right[this.fill] = right[i];
        this.fill++;
        if (this.fill === this.blockFrames) {
          if (this.pending !== -1) { this.fail('Native effect missed its real-time processing deadline; playback stopped rather than replaying stale PCM.'); break; }
          const samples = new Float32Array(this.blockFrames * 2);
          samples.set(this.left, 0);
          samples.set(this.right, this.blockFrames);
          const sequence = this.sequence++;
          this.dryReady.set(sequence, samples.slice());
          this.pending = sequence;
          this.port.postMessage({ type: 'process', sequence, samples }, [samples.buffer]);
          this.fill = 0;
        }
      }
    }
    if (this.failed) { this.outputFrame += out[0].length; return true; }
    for (let i = 0; i < out[0].length; i++) {
      const sourceFrame = this.outputFrame + i - this.delayFrames;
      if (sourceFrame < 0) continue;
      const sequence = Math.floor(sourceFrame / this.blockFrames);
      const offset = sourceFrame % this.blockFrames;
      const processed = this.ready.get(sequence);
      const dry = this.dryReady.get(sequence);
      if (!processed || !dry) {
        this.fail('Native effect output was not ready at its scheduled audio frame; playback stopped rather than using dry or stale audio.');
        break;
      }
      out[0][i] = this.bypass ? dry[offset] : processed[offset];
      out[1][i] = this.bypass ? dry[this.blockFrames + offset] : processed[this.blockFrames + offset];
      if (offset === this.blockFrames - 1) { this.ready.delete(sequence); this.dryReady.delete(sequence); }
    }
    this.outputFrame += out[0].length;
    return true;
  }
}
registerProcessor('apex-vst3-mixer-effect', ApexVst3FxProcessor);
`;

const processorModule = new WeakMap<BaseAudioContext, Promise<void>>();
async function ensureProcessor(context: BaseAudioContext) {
  const worklet = (context as AudioContext).audioWorklet;
  if (!worklet || typeof worklet.addModule !== 'function' || typeof AudioWorkletNode === 'undefined' ||
      typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Native Mixer effects require AudioWorklet support in the desktop renderer. Existing project state is retained.');
  }
  let pending = processorModule.get(context);
  if (!pending) {
    pending = (async () => {
      const url = URL.createObjectURL(new Blob([VST3_FX_WORKLET_SOURCE], { type: 'application/javascript' }));
      try { await worklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }
    })();
    processorModule.set(context, pending);
    pending.catch(() => { if (processorModule.get(context) === pending) processorModule.delete(context); });
  }
  await pending;
}

interface PreparedEffect {
  trackId: number;
  slotId: string;
  configuration: string;
  effect: Vst3Effect;
  context: BaseAudioContext;
  bridge: Vst3Bridge;
  node: AudioWorkletNode;
  sessionId?: string;
  ready: Promise<void>;
  tail: Promise<void>;
  disposed: boolean;
  faulted: boolean;
}
const runtimeKey = (trackId: number, slotId: string) => `${trackId}:${slotId}`;
const effectConfigurationKeys = new WeakMap<object, string>();
const effectKey = (effect?: Vst3Effect): string => {
  if (!effect || typeof effect !== 'object') return JSON.stringify(effect);
  let key = effectConfigurationKeys.get(effect);
  if (key === undefined) { key = JSON.stringify(effect); effectConfigurationKeys.set(effect, key); }
  return key;
};

export class NativeVst3EffectRuntime {
  private prepared = new Map<string, PreparedEffect>();
  private closing = new Set<Promise<void>>();
  constructor(private readonly onFatal: (trackId: number, slotId: string, message: string) => void,
    private readonly getBridge: () => Vst3Bridge | undefined = getVst3Bridge) {}

  nodeFor(trackId: number, slotId: string, context: BaseAudioContext, effect?: Vst3Effect): AudioWorkletNode | undefined {
    const entry = this.prepared.get(runtimeKey(trackId, slotId));
    if (!entry || entry.trackId !== trackId || entry.context !== context || entry.disposed ||
        (effect && entry.configuration !== effectKey(effect))) return undefined;
    return entry.node;
  }

  isPrepared(trackId: number, slotId: string, context: BaseAudioContext, effect?: Vst3Effect): boolean {
    const entry = this.prepared.get(runtimeKey(trackId, slotId));
    return !!entry && entry.trackId === trackId && entry.context === context && !entry.disposed && !entry.faulted &&
      (!effect || entry.configuration === effectKey(effect));
  }

  setBypassed(trackId: number, slotId: string, bypassed: boolean) {
    const entry = this.prepared.get(runtimeKey(trackId, slotId));
    if (entry && entry.trackId === trackId && !entry.disposed) entry.node.port.postMessage({ type: 'bypass', value: bypassed });
  }

  async prepareTracks(tracks: MixerTrack[], context: BaseAudioContext): Promise<void> {
    await this.stop();
    const slots = tracks.flatMap(track => track.fxSlots.filter(slot => slot.type === 'vst3' && slot.enabled).map(slot => ({ track, slot })));
    if (!slots.length) return;
    if (slots.length > 8) throw new Error('At most 8 live VST3 Mixer effect inserts are supported in one take.');
    const bridge = this.getBridge();
    if (!bridge) throw new Error('Native VST3 Mixer effects require the Windows desktop application. The saved effect and state are retained.');
    await ensureProcessor(context);
    const results = await Promise.allSettled(slots.map(({ track, slot }) => this.prepareOne(track.id, slot, context, bridge).catch(error => {
      reportVst3MixerEffect(track.id, slot.id, error instanceof Error ? error.message : String(error));
      throw error;
    })));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
      await this.stop();
      throw failure.reason;
    }
  }

  private async prepareOne(trackId: number, slot: FxSlot, context: BaseAudioContext, bridge: Vst3Bridge) {
    if (!slot.vst3Effect) throw new Error(`Mixer track ${trackId}, slot ${slot.id}: VST3 effect identity/state is missing; relink the effect. No dry substitute was installed.`);
    assertVst3Effect(slot.vst3Effect);
    const node = new AudioWorkletNode(context as AudioContext, 'apex-vst3-mixer-effect', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    const entry: PreparedEffect = {
      trackId, slotId: slot.id, configuration: effectKey(slot.vst3Effect), effect: structuredClone(slot.vst3Effect), context, bridge, node,
      tail: Promise.resolve(), disposed: false, faulted: false, ready: Promise.resolve(),
    };
    this.prepared.set(runtimeKey(trackId, slot.id), entry);
    node.port.onmessage = event => {
      const message = event.data;
      if (message?.type === 'failure') { this.fail(entry, String(message.reason || 'Native effect worklet failed.')); return; }
      if (message?.type !== 'process' || entry.disposed || entry.faulted || !Number.isInteger(message.sequence) ||
          !(message.samples instanceof Float32Array) || message.samples.length !== VST3_FX_BLOCK_FRAMES * 2) {
        if (message?.type === 'process') this.fail(entry, 'Invalid native-effect worklet request.');
        return;
      }
      const sequence = message.sequence;
      const input = message.samples;
      const operation = entry.tail.then(async () => {
        if (entry.disposed || entry.faulted || !entry.sessionId) throw new Error('Native effect processing cancelled.');
        const samples = await bridge.processAudio(entry.sessionId, VST3_FX_BLOCK_FRAMES, input, 120);
        if (entry.disposed || entry.faulted) throw new Error('Native effect processing cancelled.');
        if (!(samples instanceof Float32Array) || samples.length !== VST3_FX_BLOCK_FRAMES * 2 || samples.some(value => !Number.isFinite(value))) {
          throw new Error('Native effect returned malformed or non-finite PCM.');
        }
        node.port.postMessage({ type: 'result', sequence, samples }, [samples.buffer]);
      });
      entry.tail = operation.catch(error => { this.fail(entry, error instanceof Error ? error.message : String(error)); });
    };
    node.onprocessorerror = () => this.fail(entry, 'Native effect AudioWorklet processor failed.');
    entry.ready = bridge.open(entry.effect, context.sampleRate, 'realtime', 'effect').then(async opened => {
      if (entry.disposed || this.prepared.get(runtimeKey(trackId, slot.id)) !== entry) { await bridge.close(opened.id); throw new Error('Native effect preparation cancelled.'); }
      if (opened.latencySamples !== 0) { await bridge.close(opened.id); throw new Error(`VST3 effect reports ${opened.latencySamples} samples of latency; nonzero plugin latency is unsupported and is not compensated.`); }
      entry.sessionId = opened.id;
      const fixedLatencyMs = VST3_FX_PIPELINE_FRAMES * 1000 / context.sampleRate;
      reportVst3MixerEffect(trackId, slot.id, `VST3 ready. Fixed live block buffering: ${fixedLatencyMs.toFixed(1)} ms. No inter-track latency compensation is provided.`, fixedLatencyMs);
    });
    entry.ready.catch(() => {});
    try { await entry.ready; }
    catch (error) { await this.disposeEntry(entry); throw error; }
  }

  private fail(entry: PreparedEffect, message: string) {
    if (entry.disposed || entry.faulted) return;
    entry.faulted = true;
    entry.node.port.postMessage({ type: 'failure' });
    reportVst3MixerEffect(entry.trackId, entry.slotId, message);
    this.onFatal(entry.trackId, entry.slotId, message);
    void this.disposeEntry(entry);
  }

  async updateParameters(trackId: number, slotId: string, changes: Vst3ParameterChange[]): Promise<Vst3Parameter[]> {
    const entry = this.prepared.get(runtimeKey(trackId, slotId));
    if (!entry || entry.trackId !== trackId || entry.disposed || entry.faulted || !entry.sessionId) throw new Error('The native Mixer effect is not prepared for live editing. Stop playback, edit the saved parameters, then restart.');
    await entry.tail;
    return entry.bridge.parameters(entry.sessionId, changes);
  }

  async reconcileTracks(tracks: MixerTrack[]) {
    const live = new Map(tracks.flatMap(track => track.fxSlots.filter(slot => slot.type === 'vst3')
      .map(slot => [runtimeKey(track.id, slot.id), { track, slot }] as const)));
    for (const [key, entry] of [...this.prepared]) {
      const current = live.get(key);
      if (!current || current.track.id !== entry.trackId || effectKey(current.slot.vst3Effect) !== entry.configuration) {
        this.prepared.delete(key);
        clearDiagnostic(entry.trackId, entry.slotId);
        await this.disposeEntry(entry);
      } else this.setBypassed(entry.trackId, entry.slotId, !current.slot.enabled);
    }
  }

  private disposeEntry(entry: PreparedEffect): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    entry.disposed = true;
    entry.node.port.onmessage = null;
    entry.node.port.postMessage({ type: 'failure' });
    entry.node.port.close();
    try { entry.node.disconnect(); } catch { /* context may already be closed */ }
    const sessionId = entry.sessionId;
    entry.sessionId = undefined;
    const closeSession = sessionId ? entry.bridge.close(sessionId).catch(() => {}) : undefined;
    const closing = (async () => {
      if (closeSession) await closeSession;
      try { await entry.tail; } catch { /* the operation reports its own failure */ }
      if (!sessionId) await entry.ready.catch(() => {});
    })();
    this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing));
    return closing;
  }

  async stop(): Promise<void> {
    const entries = [...this.prepared.values()];
    this.prepared.clear();
    await Promise.all([...entries.map(entry => this.disposeEntry(entry)), ...this.closing]);
  }
}

/** Narrow type helper kept local so project imports do not pull native modules into the renderer. */
export type Vst3MixerEffectState = Vst3Effect['state'];
export type Vst3MixerEffectParameter = Vst3Parameter;
