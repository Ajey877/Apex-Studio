import type { FxSlot, MixerTrack } from '../types/daw';
import type { Vst3Effect, Vst3ParameterChange, Vst3Parameter, Vst3Bridge, Vst3AudioProcessProfile } from './nativeVst3Types';
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

export interface NativeVst3MixerEffectSmokeEvent {
  event: string;
  trackId?: number;
  slotId?: string;
  requestId?: string;
  sequence?: number;
  [key: string]: unknown;
}
const smokeTimingEvents: NativeVst3MixerEffectSmokeEvent[] = [];
const mixerFxSmokeEnabled = () => (globalThis as any).desktopApp?.smokeTest === true;
function recordMixerFxSmokeEvent(event: NativeVst3MixerEffectSmokeEvent) {
  if (!mixerFxSmokeEnabled()) return;
  if (smokeTimingEvents.length < 8192) smokeTimingEvents.push({ ...event, rendererAtMs: performance.now() });
}
export function resetNativeVst3MixerEffectSmokeTiming() {
  if (mixerFxSmokeEnabled()) smokeTimingEvents.length = 0;
}
export function getNativeVst3MixerEffectSmokeTiming(): NativeVst3MixerEffectSmokeEvent[] {
  return mixerFxSmokeEnabled() ? smokeTimingEvents.slice() : [];
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
  constructor(options) {
    super();
    this.blockFrames = ${VST3_FX_BLOCK_FRAMES};
    this.delayFrames = ${VST3_FX_PIPELINE_FRAMES};
    this.left = new Float32Array(this.blockFrames);
    this.right = new Float32Array(this.blockFrames);
    this.silentInput = new Float32Array(128);
    this.fill = 0;
    this.inputFrame = 0;
    this.outputFrame = 0;
    this.nodeStartContextFrame = null;
    this.profileEnabled = !!options.processorOptions?.profileEnabled;
    this.requireLivePort = !!options.processorOptions?.requireLivePort;
    this.livePort = null;
    this.sequence = 0;
    this.pending = -1;
    this.ready = new Map();
    this.dryReady = new Map();
    this.bypass = false;
    this.failed = false;
    this.stopped = false;
    const handleLive = message => {
      if (message?.type === 'bound') { this.port.postMessage({ type: 'live-bound' }); return; }
      if (message?.type === 'error') { this.fail(String(message.reason || 'Live audio port error.')); return; }
      if (message?.type === 'cancelled') {
        if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'worklet-result', sequence: message.sequence,
          accepted: false, pendingSequence: this.pending, receivedOutputFrame: this.outputFrame,
          dueOutputFrame: Number.isInteger(message.sequence) ? this.delayFrames + message.sequence * this.blockFrames : null,
          reason: this.stopped ? 'after-stop' : 'cancelled' });
        return;
      }
      if (message?.type !== 'result') return;
      const valid = !this.failed && message.sequence === this.pending &&
        message.samples instanceof Float32Array && message.samples.length === this.blockFrames * 2;
      if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'worklet-result', sequence: message.sequence,
        accepted: valid, pendingSequence: this.pending, receivedOutputFrame: this.outputFrame,
        dueOutputFrame: Number.isInteger(message.sequence) ? this.delayFrames + message.sequence * this.blockFrames : null,
        reason: valid ? null : (this.failed ? 'after-failure' : 'stale-duplicate-or-malformed') });
      if (!valid) return;
      this.pending = -1;
      this.ready.set(message.sequence, message.samples);
      if (this.ready.size > 2 || this.dryReady.size > 2) this.fail('Native effect output queue exceeded its two-block bound.');
    };
    this.port.onmessage = event => {
      const message = event.data;
      if (message?.type === 'live-port') {
        const next = event.ports && event.ports[0];
        if (!next) { this.fail('Live audio port missing.'); return; }
        this.livePort = next;
        this.livePort.onmessage = liveEvent => handleLive(liveEvent.data);
        return;
      }
      if (message?.type === 'stop') {
        const sequence = this.pending >= 0 ? this.pending : null;
        this.pending = -1;
        this.stopped = true;
        this.ready.clear();
        this.dryReady.clear();
        if (this.livePort) { try { this.livePort.close(); } catch (e) {} this.livePort = null; }
        this.port.postMessage({ type: 'stop-ack', sequence, reason: message.reason || 'dispose' });
        return;
      }
      if (message?.type === 'bypass') { this.bypass = !!message.value; return; }
      if (message?.type === 'failure') { this.failed = true; return; }
      handleLive(message);
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
    if (this.failed || this.stopped) return true;
    const input = inputs[0];
    let left = input?.[0], right = input?.[1] || left;
    // The processor can be constructed well before playback connects its first
    // source. Do not burn the fixed pipeline delay on pre-roll silence: anchor
    // its frame timeline to the first actual input quantum instead.
    if (this.nodeStartContextFrame === null) {
      if (!left || !right) return true;
      this.nodeStartContextFrame = currentFrame;
    }
    // Once active, disconnected/ended sources are timeline silence, not a gap
    // in the 1024-frame request stream. Reuse one zero quantum (no RT allocation)
    // so plugin tails drain and output sequence/deadline accounting stays exact.
    if (!left || !right) left = right = this.silentInput;
    if (left && right) {
      for (let i = 0; i < left.length; i++) {
        this.left[this.fill] = left[i];
        this.right[this.fill] = right[i];
        this.fill++;
        if (this.fill === this.blockFrames) {
          if (this.pending !== -1) {
            if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'pending-deadline-miss', sequence: this.pending,
              nextSequence: this.sequence, inputContextFrame: currentFrame + i, currentOutputFrame: this.outputFrame,
              dueOutputFrame: this.delayFrames + this.pending * this.blockFrames });
            this.fail('Native effect missed its real-time processing deadline; playback stopped rather than replaying stale PCM.');
            break;
          }
          const samples = new Float32Array(this.blockFrames * 2);
          samples.set(this.left, 0);
          samples.set(this.right, this.blockFrames);
          const sequence = this.sequence++;
          const inputBlockStartContextFrame = currentFrame + i + 1 - this.blockFrames;
          const submittedContextFrame = currentFrame + i + 1;
          const submittedOutputFrame = this.outputFrame + i + 1;
          const dueOutputFrame = this.delayFrames + sequence * this.blockFrames;
          const timing = { sequence, inputBlockStartContextFrame, submittedContextFrame, submittedOutputFrame,
            dueOutputFrame, dueContextFrame: this.nodeStartContextFrame + dueOutputFrame };
          this.dryReady.set(sequence, samples.slice());
          this.pending = sequence;
          if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'worklet-submit', ...timing });
          const dest = this.livePort || (!this.requireLivePort ? this.port : null);
          if (!dest) {
            this.fail('Live audio port is not bound.');
            break;
          }
          dest.postMessage({ type: 'process', sequence, samples, ...(this.profileEnabled ? { timing } : {}) });
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
        const dueOutputFrame = this.delayFrames + sequence * this.blockFrames;
        const currentOutputFrame = this.outputFrame + i;
        if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'deadline-miss', sequence, sourceFrame,
          dueOutputFrame, currentOutputFrame, pendingSequence: this.pending, readySequences: Array.from(this.ready.keys()),
          drySequences: Array.from(this.dryReady.keys()) });
        this.fail('Native effect output was not ready at its scheduled audio frame; playback stopped rather than using dry or stale audio. Sequence ' + sequence + ', source frame ' + sourceFrame + ', due output frame ' + dueOutputFrame + ', current output frame ' + currentOutputFrame + ', pending sequence ' + this.pending + '.');
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

function receiveLiveAudioPort(
  bridge: Vst3Bridge, sessionId: string, trackId: number, slotId: string, runtimeId: string, sampleRate: number,
): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (port: MessagePort) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof window !== 'undefined') window.removeEventListener('message', onMessage);
      resolve(port);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof window !== 'undefined') window.removeEventListener('message', onMessage);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => fail(new Error('Live audio port bind timed out.')), 2000);
    const onMessage = (event: MessageEvent) => {
      if (event.source != null && event.source !== window) return;
      if (event.data?.type !== 'vst3:liveAudioPort' || event.data.sessionId !== sessionId) return;
      const port = event.ports?.[0];
      if (port) finish(port);
    };
    if (typeof window !== 'undefined') window.addEventListener('message', onMessage);
    Promise.resolve(bridge.bindLiveAudioPort!(sessionId, trackId, slotId, runtimeId, sampleRate)).then(returned => {
      if (returned && typeof returned.postMessage === 'function') finish(returned);
    }).catch(fail);
  });
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
  runtimeId?: string;
  profileEnabled: boolean;
  liveAudioBound: boolean;
  liveBoundResolve?: () => void;
  ready: Promise<void>;
  tail: Promise<void>;
  queueDepth: number;
  disposed: boolean;
  stopping: boolean;
  stopReason?: string;
  faulted: boolean;
  stopAckResolve?: (ack: { sequence: number | null; reason: string }) => void;
  stopAckPromise?: Promise<{ sequence: number | null; reason: string }>;
  stopCancelledSequences: Set<number>;
  disposal?: Promise<void>;
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
    if (!entry || entry.trackId !== trackId || entry.context !== context || entry.disposed || entry.stopping ||
        (effect && entry.configuration !== effectKey(effect))) return undefined;
    return entry.node;
  }

  isPrepared(trackId: number, slotId: string, context: BaseAudioContext, effect?: Vst3Effect): boolean {
    const entry = this.prepared.get(runtimeKey(trackId, slotId));
    return !!entry && entry.trackId === trackId && entry.context === context && !entry.disposed && !entry.stopping && !entry.faulted &&
      (!effect || entry.configuration === effectKey(effect));
  }

  setBypassed(trackId: number, slotId: string, bypassed: boolean) {
    const entry = this.prepared.get(runtimeKey(trackId, slotId));
    if (entry && entry.trackId === trackId && !entry.disposed && !entry.stopping) entry.node.port.postMessage({ type: 'bypass', value: bypassed });
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
    const profileEnabled = mixerFxSmokeEnabled();
    const requireLivePort = typeof bridge.bindLiveAudioPort === 'function';
    const node = new AudioWorkletNode(context as AudioContext, 'apex-vst3-mixer-effect', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { profileEnabled, requireLivePort },
    });
    const entry: PreparedEffect = {
      trackId, slotId: slot.id, configuration: effectKey(slot.vst3Effect), effect: structuredClone(slot.vst3Effect), context, bridge, node,
      runtimeId: crypto.randomUUID(), profileEnabled, liveAudioBound: false,
      tail: Promise.resolve(), queueDepth: 0, disposed: false, stopping: false, faulted: false,
      stopCancelledSequences: new Set(), ready: Promise.resolve(),
    };
    this.prepared.set(runtimeKey(trackId, slot.id), entry);
    node.port.onmessage = event => {
      const message = event.data;
      if (message?.type === 'live-bound') {
        entry.liveBoundResolve?.();
        entry.liveBoundResolve = undefined;
        return;
      }
      if (message?.type === 'stop-ack') {
        const sequence = Number.isInteger(message.sequence) ? message.sequence as number : null;
        recordMixerFxSmokeEvent({ event: 'worklet-stop-ack', trackId, slotId: slot.id,
          ...(sequence === null ? {} : { sequence, requestId: `${entry.runtimeId}:${sequence}` }),
          cancelled: sequence !== null, reason: String(message.reason || 'dispose') });
        entry.stopAckResolve?.({ sequence, reason: String(message.reason || 'dispose') });
        entry.stopAckResolve = undefined;
        return;
      }
      if (message?.type === 'profile') {
        const sequence = Number.isInteger(message.sequence) ? message.sequence : undefined;
        recordMixerFxSmokeEvent({ ...message, trackId, slotId: slot.id,
          ...(sequence === undefined ? {} : { requestId: `${entry.runtimeId}:${sequence}` }) });
        return;
      }
      if (message?.type === 'failure') { this.fail(entry, String(message.reason || 'Native effect worklet failed.')); return; }
      if (message?.type === 'process' && entry.liveAudioBound) {
        this.fail(entry, 'Native effect process arrived on the renderer control port after live audio bind.');
        return;
      }
      if (message?.type !== 'process' || entry.disposed || entry.faulted || !Number.isInteger(message.sequence) ||
          !(message.samples instanceof Float32Array) || message.samples.length !== VST3_FX_BLOCK_FRAMES * 2) {
        if (message?.type === 'process') this.fail(entry, 'Invalid native-effect worklet request.');
        return;
      }
      const sequence = message.sequence;
      const requestId = entry.runtimeId ? `${entry.runtimeId}:${sequence}` : '';
      if (entry.stopping) {
        entry.stopCancelledSequences.add(sequence);
        recordMixerFxSmokeEvent({ event: 'renderer-request-cancelled-at-stop', trackId, slotId: slot.id,
          requestId, sequence, cancellationStage: 'before-native-service', reason: entry.stopReason ?? 'explicit-stop',
          workletStopAckPending: true });
        return;
      }
      const input = message.samples;
      const submitted = message.timing ?? {};
      const queueDepth = entry.profileEnabled ? ++entry.queueDepth : 0;
      const requestReceivedAt = entry.profileEnabled ? performance.now() : 0;
      if (entry.profileEnabled) {
        const requestReceivedContextFrame = Math.round((context as AudioContext).currentTime * context.sampleRate);
        recordMixerFxSmokeEvent({ event: 'renderer-request-received', trackId, slotId: slot.id, requestId, sequence,
          requestReceivedAt, requestReceivedContextFrame, queueDepth, ...submitted });
      }
      const operation = entry.tail.then(async () => {
        if (entry.disposed || entry.stopping || entry.faulted || !entry.sessionId) {
          if (entry.stopping || entry.disposed) {
            entry.stopCancelledSequences.add(sequence);
            recordMixerFxSmokeEvent({ event: 'renderer-request-cancelled-at-stop', trackId, slotId: slot.id,
              requestId, sequence, cancellationStage: 'before-native-service', reason: entry.stopReason ?? 'explicit-stop',
              workletStopAckPending: true });
            return;
          }
          throw new Error('Native effect processing cancelled.');
        }
        const bridgeCallStartedAt = entry.profileEnabled ? performance.now() : 0;
        if (entry.profileEnabled) recordMixerFxSmokeEvent({ event: 'renderer-bridge-call-start', trackId, slotId: slot.id, requestId, sequence,
          bridgeCallStartedAt, queueDepth, ...submitted });
        const profile: Vst3AudioProcessProfile | undefined = entry.profileEnabled ? {
          requestId, trackId, slotId: slot.id, sequence,
          inputBlockStartContextFrame: submitted.inputBlockStartContextFrame,
          submittedContextFrame: submitted.submittedContextFrame,
          submittedOutputFrame: submitted.submittedOutputFrame,
          dueOutputFrame: submitted.dueOutputFrame,
          sampleRate: context.sampleRate,
        } : undefined;
        let samples: Float32Array;
        try { samples = await bridge.processAudio(entry.sessionId, VST3_FX_BLOCK_FRAMES, input, 120, [], profile); }
        catch (error) {
          if (entry.stopping || entry.disposed) {
            entry.stopCancelledSequences.add(sequence);
            recordMixerFxSmokeEvent({ event: 'renderer-request-cancelled-at-stop', trackId, slotId: slot.id,
              requestId, sequence, cancellationStage: 'native-service-cancelled', reason: entry.stopReason ?? 'explicit-stop',
              error: error instanceof Error ? error.message : String(error) });
            return;
          }
          throw error;
        }
        const bridgeResponseAt = entry.profileEnabled ? performance.now() : 0;
        if (entry.profileEnabled) {
          const bridgeResponseContextFrame = Math.round((context as AudioContext).currentTime * context.sampleRate);
          recordMixerFxSmokeEvent({ event: 'renderer-bridge-response', trackId, slotId: slot.id, requestId, sequence,
            bridgeCallStartedAt, bridgeResponseAt, bridgeRoundTripMs: bridgeResponseAt - bridgeCallStartedAt,
            bridgeResponseContextFrame, queueDepth, ...submitted });
        }
        if (entry.stopping || entry.disposed || entry.faulted) {
          if (entry.stopping || entry.disposed) {
            entry.stopCancelledSequences.add(sequence);
            recordMixerFxSmokeEvent({ event: 'renderer-request-cancelled-at-stop', trackId, slotId: slot.id,
              requestId, sequence, cancellationStage: 'result-after-stop', reason: entry.stopReason ?? 'explicit-stop' });
            return;
          }
          throw new Error('Native effect processing cancelled.');
        }
        if (!(samples instanceof Float32Array) || samples.length !== VST3_FX_BLOCK_FRAMES * 2 || samples.some(value => !Number.isFinite(value))) {
          throw new Error('Native effect returned malformed or non-finite PCM.');
        }
        node.port.postMessage({ type: 'result', sequence, samples }, [samples.buffer]);
      });
      entry.tail = operation.catch(error => {
        if (entry.stopping || entry.disposed) {
          entry.stopCancelledSequences.add(sequence);
          recordMixerFxSmokeEvent({ event: 'renderer-request-cancelled-at-stop', trackId, slotId: slot.id,
            requestId, sequence, cancellationStage: 'renderer-rejection', reason: entry.stopReason ?? 'explicit-stop',
            error: error instanceof Error ? error.message : String(error) });
          return;
        }
        this.fail(entry, error instanceof Error ? error.message : String(error));
      })
        .finally(() => { if (entry.profileEnabled) entry.queueDepth = Math.max(0, entry.queueDepth - 1); });
    };
    node.onprocessorerror = () => this.fail(entry, 'Native effect AudioWorklet processor failed.');
    entry.ready = bridge.open(entry.effect, context.sampleRate, 'realtime', 'effect').then(async opened => {
      if (entry.disposed || this.prepared.get(runtimeKey(trackId, slot.id)) !== entry) { await bridge.close(opened.id); throw new Error('Native effect preparation cancelled.'); }
      if (opened.latencySamples !== 0) { await bridge.close(opened.id); throw new Error(`VST3 effect reports ${opened.latencySamples} samples of latency; nonzero plugin latency is unsupported and is not compensated.`); }
      entry.sessionId = opened.id;
      const overlay = entry.effect.state.parameters
        .filter(parameter => Number.isInteger(parameter.id) && parameter.id >= 0 && Number.isFinite(parameter.value) && parameter.value >= 0 && parameter.value <= 1)
        .map(parameter => ({ id: parameter.id, value: parameter.value }));
      // Saved normalized parameters are authoritative overrides over the opaque
      // component stream (host restore applies them after setState). Flush them
      // on the opened session before the worklet can process so the first live
      // block, which sends an empty parameter list, reaches DSP. Not per-block IPC.
      if (overlay.length) {
        try { await bridge.parameters(opened.id, overlay); }
        catch (error) {
          await bridge.close(opened.id).catch(() => {});
          entry.sessionId = undefined;
          throw error;
        }
      }
      if (typeof bridge.bindLiveAudioPort === 'function') {
        const bound = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Live audio port bind timed out.')), 2000);
          entry.liveBoundResolve = () => { clearTimeout(timer); resolve(); };
        });
        try {
          const livePort = await receiveLiveAudioPort(bridge, opened.id, trackId, slot.id, entry.runtimeId!, context.sampleRate);
          node.port.postMessage({ type: 'live-port' }, [livePort]);
          await bound;
        } catch (error) {
          if (typeof bridge.unbindLiveAudioPort === 'function') await bridge.unbindLiveAudioPort(opened.id).catch(() => {});
          await bridge.close(opened.id);
          throw error;
        }
        if (entry.disposed || this.prepared.get(runtimeKey(trackId, slot.id)) !== entry) {
          if (typeof bridge.unbindLiveAudioPort === 'function') await bridge.unbindLiveAudioPort(opened.id).catch(() => {});
          await bridge.close(opened.id);
          throw new Error('Native effect preparation cancelled.');
        }
        entry.liveAudioBound = true;
      } else if ((globalThis as { desktopApp?: { isDesktop?: boolean } }).desktopApp?.isDesktop === true) {
        await bridge.close(opened.id);
        throw new Error('Dedicated live audio port is required in the desktop Mixer.');
      }
      const fixedLatencyMs = VST3_FX_PIPELINE_FRAMES * 1000 / context.sampleRate;
      reportVst3MixerEffect(trackId, slot.id,
        `VST3 ready. Fixed live block buffering: ${fixedLatencyMs.toFixed(1)} ms. Track branches are compensated at Mixer summing inputs; plugin-reported latency remains unsupported.`,
        fixedLatencyMs);
    });
    entry.ready.catch(() => {});
    try { await entry.ready; }
    catch (error) { await this.disposeEntry(entry); throw error; }
  }

  private fail(entry: PreparedEffect, message: string) {
    if (entry.disposed || entry.stopping || entry.faulted) return;
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

  private disposeEntry(entry: PreparedEffect, reason = 'dispose'): Promise<void> {
    if (entry.disposal) return entry.disposal;
    if (entry.disposed) return Promise.resolve();
    entry.stopping = true;
    entry.stopReason = reason;
    const closing = (async () => {
      // The worklet may already have posted a process message when explicit
      // stop begins. Keep its message handler alive until its stop ACK has
      // crossed the same MessagePort, so a pending sequence is either handled
      // or explicitly acknowledged as cancelled before this port is closed.
      entry.stopAckPromise = new Promise(resolve => { entry.stopAckResolve = resolve; });
      try {
        entry.node.port.postMessage({ type: 'stop', reason });
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('AudioWorklet stop acknowledgement timed out')), 250); });
        let ack: { sequence: number | null; reason: string };
        try { ack = await Promise.race([entry.stopAckPromise, timeout]); }
        finally { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); }
        if (ack.sequence !== null) entry.stopCancelledSequences.add(ack.sequence);
        recordMixerFxSmokeEvent({ event: 'renderer-stop-acknowledged', trackId: entry.trackId, slotId: entry.slotId,
          ...(ack.sequence === null ? {} : { sequence: ack.sequence, requestId: `${entry.runtimeId}:${ack.sequence}` }),
          cancelled: ack.sequence !== null, reason: ack.reason });
      } catch (error) {
        recordMixerFxSmokeEvent({ event: 'renderer-stop-ack-timeout', trackId: entry.trackId, slotId: entry.slotId,
          reason, error: error instanceof Error ? error.message : String(error) });
      } finally {
        entry.stopAckResolve = undefined;
        entry.disposed = true;
      }
      entry.node.port.onmessage = null;
      entry.node.port.postMessage({ type: 'failure' });
      entry.node.port.close();
      try { entry.node.disconnect(); } catch { /* context may already be closed */ }
      const sessionId = entry.sessionId;
      entry.sessionId = undefined;
      if (sessionId) {
        // Unbind must only validate ownership and mark the live port stopping.
        // It must not wait for an in-flight native process; close/abort starts next.
        if (typeof entry.bridge.unbindLiveAudioPort === 'function') {
          await entry.bridge.unbindLiveAudioPort(sessionId).catch(() => {});
        }
        await entry.bridge.close(sessionId).catch(() => {});
      }
      try { await entry.tail; } catch { /* the operation reports its own failure */ }
      if (!sessionId) await entry.ready.catch(() => {});
    })();
    entry.disposal = closing;
    this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing));
    return closing;
  }

  async stop(): Promise<void> {
    const entries = [...this.prepared.values()];
    this.prepared.clear();
    await Promise.all([...entries.map(entry => this.disposeEntry(entry, 'explicit-stop')), ...this.closing]);
  }
}

/** Narrow type helper kept local so project imports do not pull native modules into the renderer. */
export type Vst3MixerEffectState = Vst3Effect['state'];
export type Vst3MixerEffectParameter = Vst3Parameter;
