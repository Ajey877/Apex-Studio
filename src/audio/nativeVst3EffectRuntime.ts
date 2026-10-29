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
const SMOKE_TIMING_EVENT_LIMIT = 65536;
let smokeTimingDropped = 0;
const mixerFxSmokeEnabled = () => (globalThis as any).desktopApp?.smokeTest === true;
function recordMixerFxSmokeEvent(event: NativeVst3MixerEffectSmokeEvent) {
  if (!mixerFxSmokeEnabled()) return;
  if (smokeTimingEvents.length < SMOKE_TIMING_EVENT_LIMIT) smokeTimingEvents.push({ ...event, rendererAtMs: performance.now() });
  else smokeTimingDropped++;
}
export function resetNativeVst3MixerEffectSmokeTiming() {
  if (!mixerFxSmokeEnabled()) return;
  smokeTimingEvents.length = 0;
  smokeTimingDropped = 0;
  stopNativeVst3RendererLoopMonitor();
}
export function getNativeVst3MixerEffectSmokeTiming(): NativeVst3MixerEffectSmokeEvent[] {
  return mixerFxSmokeEnabled() ? smokeTimingEvents.slice() : [];
}
export function getNativeVst3MixerEffectSmokeTimingDropped(): number {
  return mixerFxSmokeEnabled() ? smokeTimingDropped : 0;
}

export const RENDERER_LOOP_HEARTBEAT_INTERVAL_MS = 3;
export const RENDERER_LOOP_STALL_THRESHOLD_MS = 4;
export const RENDERER_LOOP_STALL_SAMPLE_LIMIT = 64;
export const RENDERER_LOOP_LONG_TASK_LIMIT = 32;
const RENDERER_LOOP_STALL_WINDOW_BEFORE_MS = 32;
const RENDERER_LOOP_STALL_WINDOW_AFTER_MS = 32;

export interface NativeVst3RendererLoopHeartbeat {
  expectedAtMs: number;
  actualAtMs: number;
  driftMs: number;
  gapMs: number;
  contextFrame: number | null;
}

export interface NativeVst3RendererLoopSnapshot {
  intervalMs: number;
  startedAtMs: number;
  stoppedAtMs: number | null;
  heartbeatCount: number;
  maxDriftMs: number;
  maxGapMs: number;
  delaysOver4ms: number;
  delaysOver8ms: number;
  last: NativeVst3RendererLoopHeartbeat | null;
  stalls: NativeVst3RendererLoopHeartbeat[];
  longTasks: Array<{ startAtMs: number; durationMs: number }>;
}

interface NativeVst3RendererLoopState extends NativeVst3RendererLoopSnapshot {
  nextExpectedAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  context: BaseAudioContext | null;
  observer: PerformanceObserver | null;
}

let rendererLoopMonitor: NativeVst3RendererLoopState | null = null;

function sampleRendererContextFrame(context: BaseAudioContext | null) {
  try {
    if (!context) return null;
    const rate = context.sampleRate;
    const time = (context as AudioContext).currentTime;
    if (!Number.isFinite(rate) || !Number.isFinite(time)) return null;
    return Math.round(time * rate);
  } catch {
    return null;
  }
}

export function createNativeVst3RendererLoopState(startedAtMs: number, intervalMs = RENDERER_LOOP_HEARTBEAT_INTERVAL_MS): NativeVst3RendererLoopState {
  return {
    intervalMs, startedAtMs, stoppedAtMs: null, nextExpectedAtMs: startedAtMs + intervalMs,
    heartbeatCount: 0, maxDriftMs: 0, maxGapMs: 0, delaysOver4ms: 0, delaysOver8ms: 0,
    last: null, stalls: [], longTasks: [], timer: null, context: null, observer: null,
  };
}

export function applyNativeVst3RendererLoopHeartbeat(
  state: NativeVst3RendererLoopState,
  actualAtMs: number,
  contextFrame: number | null,
): NativeVst3RendererLoopHeartbeat {
  const expectedAtMs = state.nextExpectedAtMs;
  const gapMs = state.last ? actualAtMs - state.last.actualAtMs : actualAtMs - state.startedAtMs;
  const driftMs = actualAtMs - expectedAtMs;
  const sample: NativeVst3RendererLoopHeartbeat = { expectedAtMs, actualAtMs, driftMs, gapMs, contextFrame };
  state.last = sample;
  state.heartbeatCount++;
  if (driftMs > state.maxDriftMs) state.maxDriftMs = driftMs;
  if (gapMs > state.maxGapMs) state.maxGapMs = gapMs;
  if (driftMs >= RENDERER_LOOP_STALL_THRESHOLD_MS) state.delaysOver4ms++;
  if (driftMs >= 8) state.delaysOver8ms++;
  if (driftMs >= RENDERER_LOOP_STALL_THRESHOLD_MS && state.stalls.length < RENDERER_LOOP_STALL_SAMPLE_LIMIT) state.stalls.push(sample);
  state.nextExpectedAtMs = actualAtMs + state.intervalMs;
  return sample;
}

export function selectRendererLoopStallsNear(
  stalls: readonly NativeVst3RendererLoopHeartbeat[],
  arrivedAtMs: number,
  windowBeforeMs = RENDERER_LOOP_STALL_WINDOW_BEFORE_MS,
  windowAfterMs = RENDERER_LOOP_STALL_WINDOW_AFTER_MS,
) {
  return stalls.filter(sample => sample.actualAtMs >= arrivedAtMs - windowBeforeMs && sample.actualAtMs <= arrivedAtMs + windowAfterMs);
}

export function selectLongTasksOverlapping(
  tasks: ReadonlyArray<{ startAtMs: number; durationMs: number }>,
  fromMs: number,
  toMs: number,
) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
  return tasks.filter(task => Number.isFinite(task.startAtMs) && Number.isFinite(task.durationMs) &&
    task.startAtMs < toMs && task.startAtMs + task.durationMs > fromMs);
}

export interface NativeVst3IpcClockSample {
  preloadSentAtMs: number;
  mainReceivedAtMs: number;
  mainReplyAtMs: number;
  preloadReceivedAtMs: number;
}

export function estimateIpcClockOffset(samples: readonly NativeVst3IpcClockSample[]) {
  const analyzed = samples.flatMap(sample => {
    const t1 = Number(sample.preloadSentAtMs), t2 = Number(sample.mainReceivedAtMs);
    const t3 = Number(sample.mainReplyAtMs), t4 = Number(sample.preloadReceivedAtMs);
    if (![t1, t2, t3, t4].every(Number.isFinite) || t4 < t1 || t3 < t2) return [];
    const lower = t3 - t4, upper = t2 - t1;
    if (lower > upper) return [];
    const rttMs = (t4 - t1) - (t3 - t2);
    if (!Number.isFinite(rttMs) || rttMs < 0) return [];
    return [{ rttMs, offsetMainMinusPreloadMs: (lower + upper) / 2, uncertaintyMs: (upper - lower) / 2, lowerMs: lower, upperMs: upper }];
  });
  if (!analyzed.length) {
    return {
      offsetMainMinusPreloadMs: null, uncertaintyMs: null, minRttMs: null, sampleCount: 0,
      rejectedSampleCount: samples.length, inconclusive: true, reason: 'no-valid-samples',
    };
  }
  const best = analyzed.reduce((current, sample) => sample.rttMs < current.rttMs ? sample : current);
  return {
    offsetMainMinusPreloadMs: best.offsetMainMinusPreloadMs, uncertaintyMs: best.uncertaintyMs, minRttMs: best.rttMs,
    sampleCount: analyzed.length, rejectedSampleCount: samples.length - analyzed.length,
    inconclusive: best.uncertaintyMs > 4, reason: best.uncertaintyMs > 4 ? 'uncertainty-exceeds-4ms' : null,
  };
}

export function estimateIpcDirectionalDelay(input: {
  invokeStartedAt?: unknown; responseReceivedAt?: unknown;
  ipcReceivedAtMainMs?: unknown; ipcReplyAtMainMs?: unknown;
  offsetMainMinusPreloadMs?: unknown; uncertaintyMs?: unknown;
}) {
  const t1 = Number(input.invokeStartedAt), t4 = Number(input.responseReceivedAt);
  const t2 = Number(input.ipcReceivedAtMainMs), t3 = Number(input.ipcReplyAtMainMs);
  const offset = Number(input.offsetMainMinusPreloadMs), uncertainty = Number(input.uncertaintyMs);
  if (![t1, t2, t3, t4, offset, uncertainty].every(Number.isFinite)) {
    return { requestLegMs: null, responseLegMs: null, uncertaintyMs: Number.isFinite(uncertainty) ? uncertainty : null,
      inconclusive: true, reason: 'missing-timestamps-or-offset' };
  }
  const requestLegMs = (t2 - t1) - offset;
  const responseLegMs = (t4 - t3) + offset;
  const inconclusive = uncertainty > 4 || requestLegMs < -uncertainty || responseLegMs < -uncertainty;
  return {
    requestLegMs, responseLegMs, uncertaintyMs: uncertainty, inconclusive,
    reason: inconclusive ? (uncertainty > 4 ? 'uncertainty-exceeds-4ms' : 'leg-inconsistent-with-uncertainty') : null,
  };
}

export function correlateNativeVst3RendererLoopArrival(
  snapshot: Pick<NativeVst3RendererLoopSnapshot, 'last' | 'stalls' | 'maxDriftMs' | 'heartbeatCount'>,
  arrivedAtMs: number,
  attached?: { precedingHeartbeatDriftMs?: unknown; precedingHeartbeatGapMs?: unknown; precedingHeartbeatAtMs?: unknown; precedingHeartbeatContextFrame?: unknown },
) {
  const stallsInWindow = selectRendererLoopStallsNear(snapshot.stalls, arrivedAtMs);
  const maxDriftInWindowMs = stallsInWindow.reduce((max, sample) => Math.max(max, sample.driftMs), 0);
  return {
    precedingHeartbeatDriftMs: Number.isFinite(Number(attached?.precedingHeartbeatDriftMs)) ? Number(attached?.precedingHeartbeatDriftMs) : snapshot.last?.driftMs ?? null,
    precedingHeartbeatGapMs: Number.isFinite(Number(attached?.precedingHeartbeatGapMs)) ? Number(attached?.precedingHeartbeatGapMs) : snapshot.last?.gapMs ?? null,
    precedingHeartbeatAtMs: Number.isFinite(Number(attached?.precedingHeartbeatAtMs)) ? Number(attached?.precedingHeartbeatAtMs) : snapshot.last?.actualAtMs ?? null,
    precedingHeartbeatContextFrame: Number.isFinite(Number(attached?.precedingHeartbeatContextFrame)) ? Number(attached?.precedingHeartbeatContextFrame) : snapshot.last?.contextFrame ?? null,
    maxDriftInWindowMs, stallCountInWindow: stallsInWindow.length,
    stallsInWindow: stallsInWindow.map(sample => ({
      driftMs: sample.driftMs, gapMs: sample.gapMs, contextFrame: sample.contextFrame, actualAtMs: sample.actualAtMs,
    })),
    monitorMaxDriftMs: snapshot.maxDriftMs, monitorHeartbeatCount: snapshot.heartbeatCount,
  };
}

function snapshotRendererLoopMonitor(state: NativeVst3RendererLoopState): NativeVst3RendererLoopSnapshot {
  return {
    intervalMs: state.intervalMs, startedAtMs: state.startedAtMs, stoppedAtMs: state.stoppedAtMs,
    heartbeatCount: state.heartbeatCount, maxDriftMs: state.maxDriftMs, maxGapMs: state.maxGapMs,
    delaysOver4ms: state.delaysOver4ms, delaysOver8ms: state.delaysOver8ms, last: state.last,
    stalls: state.stalls.slice(), longTasks: state.longTasks.slice(),
  };
}

function rendererLoopAttachment(context: BaseAudioContext) {
  const last = rendererLoopMonitor?.last ?? null;
  return {
    rendererHandleContextFrame: sampleRendererContextFrame(context),
    precedingHeartbeatDriftMs: last?.driftMs ?? null,
    precedingHeartbeatGapMs: last?.gapMs ?? null,
    precedingHeartbeatAtMs: last?.actualAtMs ?? null,
    precedingHeartbeatExpectedAtMs: last?.expectedAtMs ?? null,
    precedingHeartbeatContextFrame: last?.contextFrame ?? null,
    monitorMaxDriftMs: rendererLoopMonitor?.maxDriftMs ?? null,
    monitorHeartbeatCount: rendererLoopMonitor?.heartbeatCount ?? null,
  };
}

function scheduleRendererLoopHeartbeat(state: NativeVst3RendererLoopState) {
  state.timer = setTimeout(() => {
    if (rendererLoopMonitor !== state || state.stoppedAtMs !== null) return;
    applyNativeVst3RendererLoopHeartbeat(state, performance.now(), sampleRendererContextFrame(state.context));
    scheduleRendererLoopHeartbeat(state);
  }, state.intervalMs);
}

export function startNativeVst3RendererLoopMonitor(context: BaseAudioContext) {
  if (!mixerFxSmokeEnabled()) return;
  stopNativeVst3RendererLoopMonitor();
  const startedAtMs = performance.now();
  const state = createNativeVst3RendererLoopState(startedAtMs);
  state.context = context;
  if (typeof PerformanceObserver === 'function') {
    try {
      state.observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (state.longTasks.length >= RENDERER_LOOP_LONG_TASK_LIMIT) break;
          state.longTasks.push({ startAtMs: entry.startTime, durationMs: entry.duration });
        }
      });
      state.observer.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
    } catch {
      state.observer = null;
    }
  }
  rendererLoopMonitor = state;
  scheduleRendererLoopHeartbeat(state);
}

export function stopNativeVst3RendererLoopMonitor(): NativeVst3RendererLoopSnapshot | null {
  const state = rendererLoopMonitor;
  if (!state) return null;
  if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
  try { state.observer?.disconnect(); } catch { /* observer may already be gone */ }
  state.observer = null;
  state.stoppedAtMs = performance.now();
  rendererLoopMonitor = null;
  return snapshotRendererLoopMonitor(state);
}

export function getNativeVst3RendererLoopMonitorSnapshot(): NativeVst3RendererLoopSnapshot | null {
  return rendererLoopMonitor ? snapshotRendererLoopMonitor(rendererLoopMonitor) : null;
}

export function tickNativeVst3RendererLoopMonitorForTest(actualAtMs: number, contextFrame: number | null) {
  if (!rendererLoopMonitor) throw new Error('Renderer loop monitor is not running');
  return applyNativeVst3RendererLoopHeartbeat(rendererLoopMonitor, actualAtMs, contextFrame);
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
      const afterStop = this.stopped;
      const valid = !afterStop && !this.failed && message.sequence === this.pending &&
        message.samples instanceof Float32Array && message.samples.length === this.blockFrames * 2;
      if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'worklet-result', sequence: message.sequence,
        accepted: valid, pendingSequence: this.pending, receivedOutputFrame: this.outputFrame,
        dueOutputFrame: Number.isInteger(message.sequence) ? this.delayFrames + message.sequence * this.blockFrames : null,
        reason: valid ? null : (afterStop ? 'after-stop' : (this.failed ? 'after-failure' : 'stale-duplicate-or-malformed')) });
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
        if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'worklet-stop-received',
          sequence, pendingSequence: this.pending, stoppedOutputFrame: this.outputFrame,
          reason: message.reason || 'dispose' });
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
              workletCurrentFrame: currentFrame, workletCurrentTimeFrame: Math.round(currentTime * sampleRate),
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
            dueOutputFrame, dueContextFrame: this.nodeStartContextFrame + dueOutputFrame,
            workletCurrentFrame: currentFrame, workletCurrentTimeFrame: Math.round(currentTime * sampleRate) };
          this.dryReady.set(sequence, samples.slice());
          this.pending = sequence;
          if (this.profileEnabled) this.port.postMessage({ type: 'profile', event: 'worklet-submit', ...timing });
          const dest = this.livePort || (!this.requireLivePort ? this.port : null);
          if (!dest) {
            this.fail('Live audio port is not bound.');
            break;
          }
          dest.postMessage({ type: 'process', sequence, samples, ...(this.profileEnabled ? { timing } : {}) }, [samples.buffer]);
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
        recordMixerFxSmokeEvent({ event: 'worklet-stop-ack', trackId, slotId: slot.id, runtimeId: entry.runtimeId,
          sequence, pendingSequence: sequence, cancelled: sequence !== null,
          reason: String(message.reason || 'dispose'),
          ...(sequence === null ? {} : { requestId: `${entry.runtimeId}:${sequence}` }) });
        entry.stopAckResolve?.({ sequence, reason: String(message.reason || 'dispose') });
        entry.stopAckResolve = undefined;
        return;
      }
      if (message?.type === 'profile') {
        const sequence = Number.isInteger(message.sequence) ? message.sequence : undefined;
        const loop = message.event === 'worklet-submit' ? rendererLoopAttachment(context) : null;
        recordMixerFxSmokeEvent({ ...message, trackId, slotId: slot.id, runtimeId: entry.runtimeId,
          ...(sequence === undefined ? {} : { requestId: `${entry.runtimeId}:${sequence}` }),
          ...(loop ? {
            rendererProfileContextFrame: loop.rendererHandleContextFrame,
            precedingHeartbeatDriftMs: loop.precedingHeartbeatDriftMs,
            precedingHeartbeatGapMs: loop.precedingHeartbeatGapMs,
            precedingHeartbeatAtMs: loop.precedingHeartbeatAtMs,
            precedingHeartbeatExpectedAtMs: loop.precedingHeartbeatExpectedAtMs,
            precedingHeartbeatContextFrame: loop.precedingHeartbeatContextFrame,
            monitorMaxDriftMs: loop.monitorMaxDriftMs,
            monitorHeartbeatCount: loop.monitorHeartbeatCount,
          } : {}) });
        return;
      }
      if (message?.type === 'failure') { this.fail(entry, String(message.reason || 'Native effect worklet failed.')); return; }
      if (message?.type === 'process' && entry.liveAudioBound) {
        this.fail(entry, 'Native effect process arrived on the renderer control port after live audio bind.');
        return;
      }
      if (message?.type === 'process' && entry.profileEnabled) {
        const arrivedSequence = Number.isInteger(message.sequence) ? message.sequence as number : null;
        const loop = rendererLoopAttachment(context);
        recordMixerFxSmokeEvent({
          event: 'renderer-process-arrived', trackId, slotId: slot.id, runtimeId: entry.runtimeId,
          sequence: arrivedSequence, requestId: entry.runtimeId && arrivedSequence !== null ? `${entry.runtimeId}:${arrivedSequence}` : '',
          arrivedAt: performance.now(),
          arrivedContextFrame: loop.rendererHandleContextFrame,
          stopping: entry.stopping, disposed: entry.disposed, faulted: entry.faulted,
          validSequence: Number.isInteger(message.sequence),
          validSamples: message.samples instanceof Float32Array && message.samples.length === VST3_FX_BLOCK_FRAMES * 2,
          precedingHeartbeatDriftMs: loop.precedingHeartbeatDriftMs,
          precedingHeartbeatGapMs: loop.precedingHeartbeatGapMs,
          precedingHeartbeatAtMs: loop.precedingHeartbeatAtMs,
          precedingHeartbeatExpectedAtMs: loop.precedingHeartbeatExpectedAtMs,
          precedingHeartbeatContextFrame: loop.precedingHeartbeatContextFrame,
          monitorMaxDriftMs: loop.monitorMaxDriftMs,
          monitorHeartbeatCount: loop.monitorHeartbeatCount,
        });
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
          dueContextFrame: submitted.dueContextFrame,
          sampleRate: context.sampleRate,
        } : undefined;
        let samples: Float32Array;
        try { samples = await bridge.processAudio(entry.sessionId, VST3_FX_BLOCK_FRAMES, input, 120, [], profile); }
        catch (error) {
          if (entry.profileEnabled) {
            const rejectedAt = performance.now();
            recordMixerFxSmokeEvent({ event: 'renderer-bridge-rejected', trackId, slotId: slot.id, requestId, sequence,
              bridgeCallStartedAt, bridgeResponseAt: rejectedAt, bridgeRoundTripMs: rejectedAt - bridgeCallStartedAt,
              bridgeResponseContextFrame: Math.round((context as AudioContext).currentTime * context.sampleRate),
              stopping: entry.stopping, disposed: entry.disposed, queueDepth,
              error: error instanceof Error ? error.message : String(error), ...submitted });
          }
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
        const resultPostedAt = entry.profileEnabled ? performance.now() : 0;
        const resultPostedContextFrame = entry.profileEnabled
          ? Math.round((context as AudioContext).currentTime * context.sampleRate) : null;
        try {
          node.port.postMessage({ type: 'result', sequence, samples }, [samples.buffer]);
        } catch (error) {
          if (entry.profileEnabled) recordMixerFxSmokeEvent({ event: 'renderer-result-post-failed', trackId, slotId: slot.id,
            requestId, sequence, runtimeId: entry.runtimeId, stopping: entry.stopping, disposed: entry.disposed,
            resultPostedAt, resultPostedContextFrame, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        if (entry.profileEnabled) recordMixerFxSmokeEvent({ event: 'renderer-result-posted', trackId, slotId: slot.id,
          requestId, sequence, runtimeId: entry.runtimeId, resultPostedAt, resultPostedContextFrame,
          stopping: entry.stopping, disposed: entry.disposed, faulted: entry.faulted });
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
    entry.ready = bridge.open(entry.effect, context.sampleRate, 'realtime', 'effect',
      profileEnabled && entry.effect.name === 'mda RezFilter').then(async opened => {
      if (entry.disposed || this.prepared.get(runtimeKey(trackId, slot.id)) !== entry) { await bridge.close(opened.id); throw new Error('Native effect preparation cancelled.'); }
      if (opened.latencySamples !== 0) { await bridge.close(opened.id); throw new Error(`VST3 effect reports ${opened.latencySamples} samples of latency; nonzero plugin latency is unsupported and is not compensated.`); }
      entry.sessionId = opened.id;
      if (typeof bridge.bindLiveAudioPort === 'function') {
        if (typeof MessageChannel !== 'function') {
          await bridge.close(opened.id);
          throw new Error('Dedicated live audio port requires MessageChannel.');
        }
        const channel = new MessageChannel();
        const bound = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Live audio port bind timed out.')), 2000);
          entry.liveBoundResolve = () => { clearTimeout(timer); resolve(); };
        });
        try {
          node.port.postMessage({ type: 'live-port' }, [channel.port1]);
          bridge.bindLiveAudioPort(opened.id, trackId, slot.id, entry.runtimeId!, context.sampleRate, channel.port2);
          await bound;
        } catch (error) {
          try { channel.port1.close(); } catch { /* already transferred */ }
          try { channel.port2.close(); } catch { /* already transferred */ }
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
      const requestedParameters = entry.effect.state.parameters;
      const controllerParameterEvidence = profileEnabled ? requestedParameters.map(({ id, value }) => ({
        id, requestedValue: value, helperControllerValue: opened.parameters?.find(parameter => parameter.id === id)?.currentValue ?? null,
      })) : undefined;
      if (profileEnabled) recordMixerFxSmokeEvent({ event: 'native-effect-open', trackId, slotId: slot.id,
        runtimeId: entry.runtimeId, helperSessionId: opened.id, classId: entry.effect.classId,
        parameterEvidence: controllerParameterEvidence, nativeOpenEvidence: opened.smokeOpenEvidence ?? null });
      reportVst3MixerEffect(trackId, slot.id,
        `VST3 ready. Fixed live block buffering: ${fixedLatencyMs.toFixed(1)} ms. Track branches are compensated at Mixer summing inputs; plugin-reported latency remains unsupported.${profileEnabled ? ` Smoke controller parameters at open: ${JSON.stringify(controllerParameterEvidence)}.` : ''}`,
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
      const stopContextFrame = () => {
        try { return Math.round((entry.context as AudioContext).currentTime * entry.context.sampleRate); }
        catch { return null; }
      };
      recordMixerFxSmokeEvent({ event: 'renderer-stop-requested', trackId: entry.trackId, slotId: entry.slotId,
        runtimeId: entry.runtimeId, reason, stopContextFrame: stopContextFrame() });
      entry.stopAckPromise = new Promise(resolve => { entry.stopAckResolve = resolve; });
      try {
        entry.node.port.postMessage({ type: 'stop', reason });
        recordMixerFxSmokeEvent({ event: 'renderer-worklet-stop-posted', trackId: entry.trackId, slotId: entry.slotId,
          runtimeId: entry.runtimeId, reason, stopContextFrame: stopContextFrame() });
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('AudioWorklet stop acknowledgement timed out')), 250); });
        let ack: { sequence: number | null; reason: string };
        try { ack = await Promise.race([entry.stopAckPromise, timeout]); }
        finally { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); }
        if (ack.sequence !== null) entry.stopCancelledSequences.add(ack.sequence);
        recordMixerFxSmokeEvent({ event: 'renderer-stop-acknowledged', trackId: entry.trackId, slotId: entry.slotId,
          runtimeId: entry.runtimeId, sequence: ack.sequence, pendingSequence: ack.sequence,
          cancelled: ack.sequence !== null, reason: ack.reason, stopContextFrame: stopContextFrame(),
          ...(ack.sequence === null ? {} : { requestId: `${entry.runtimeId}:${ack.sequence}` }) });
      } catch (error) {
        recordMixerFxSmokeEvent({ event: 'renderer-stop-ack-timeout', trackId: entry.trackId, slotId: entry.slotId,
          runtimeId: entry.runtimeId, reason, stopContextFrame: stopContextFrame(),
          error: error instanceof Error ? error.message : String(error) });
      } finally {
        entry.stopAckResolve = undefined;
        entry.disposed = true;
      }
      recordMixerFxSmokeEvent({ event: 'renderer-port-closing', trackId: entry.trackId, slotId: entry.slotId,
        runtimeId: entry.runtimeId, reason, stopContextFrame: stopContextFrame(),
        cancelledSequences: [...entry.stopCancelledSequences] });
      entry.node.port.onmessage = null;
      entry.node.port.postMessage({ type: 'failure' });
      entry.node.port.close();
      recordMixerFxSmokeEvent({ event: 'renderer-port-closed', trackId: entry.trackId, slotId: entry.slotId,
        runtimeId: entry.runtimeId, reason, stopContextFrame: stopContextFrame() });
      try { entry.node.disconnect(); } catch { /* context may already be closed */ }
      const sessionId = entry.sessionId;
      entry.sessionId = undefined;
      if (sessionId) {
        if (typeof entry.bridge.unbindLiveAudioPort === 'function') {
          await entry.bridge.unbindLiveAudioPort(sessionId).catch(() => {});
        }
        await entry.bridge.close(sessionId).catch(() => {});
        recordMixerFxSmokeEvent({ event: 'renderer-session-closed', trackId: entry.trackId, slotId: entry.slotId,
          runtimeId: entry.runtimeId, helperSessionId: sessionId, reason, stopContextFrame: stopContextFrame() });
      }
      try { await entry.tail; } catch { /* the operation reports its own failure */ }
      recordMixerFxSmokeEvent({ event: 'renderer-tail-settled', trackId: entry.trackId, slotId: entry.slotId,
        runtimeId: entry.runtimeId, reason, stopContextFrame: stopContextFrame(),
        cancelledSequences: [...entry.stopCancelledSequences] });
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
