import { beatsToSeconds, stepsToBeats } from '../music/musicalTime';
import type {
  Channel,
  ChannelMidiOutputMode,
  ChannelMidiOutputRouting,
  MidiDeviceInfo,
  Note,
} from '../types/daw';
import { resolveGateSeconds } from './noteGate';

export type MidiAccessStatus = 'uninitialized' | 'ready' | 'unsupported' | 'denied' | 'error';

export interface MidiAccessStateSnapshot {
  status: MidiAccessStatus;
  errorMessage: string | null;
}

export interface MidiOutputPortLike {
  id: string;
  name?: string;
  manufacturer?: string;
  state?: string;
  connection?: string;
  type?: string;
  open?: () => Promise<unknown>;
  send?: (data: number[] | Uint8Array, timestamp?: number) => void;
  clear?: () => void;
}

export interface MidiOutputUsability {
  usable: boolean;
  state: string;
  connection?: string;
  statusReason?: string;
}

export interface TransportStepMidiContext {
  takeGeneration: number;
  absoluteStep: number;
  step: number;
  stepAudioTimeSeconds: number;
  unswungStepAudioTimeSeconds: number;
  grooveOffsetSeconds: number;
  bpm: number;
  mode: 'pat' | 'song';
  patternLoopSteps: number | null;
  contextCurrentTimeSeconds: number;
}

export interface ScheduleChannelNoteParams {
  channel: Channel;
  note: Note;
  onsetAudioTimeSeconds: number;
  bpm: number;
  contextCurrentTimeSeconds: number;
  liveInputMidiChannel?: number;
}

export interface ScheduleChannelNoteResult {
  sent: boolean;
  deferredToHorizon?: boolean;
  reason?: 'off_or_unassigned' | 'port_unavailable' | 'zero_velocity' | 'duplicate' | 'send_failed';
}

interface ActiveMidiOutputNote {
  id: number;
  channelId: string;
  outputDeviceId: string;
  midiChannel: number;
  pitch: number;
  velocityByte: number;
  onPerfMs: number;
  releaseAbsoluteStep: number | null;
  grooveOffsetSeconds: number;
  queuedOffPerfMs: number | null;
  liveInputMidiChannel?: number;
  isTransportNote: boolean;
  patternCycleIndex: number | null;
}

interface DeferredTransportNoteOn {
  channelId: string;
  outputDeviceId: string;
  midiChannel: number;
  pitch: number;
  velocityByte: number;
  onsetAbsoluteStep: number;
  releaseAbsoluteStep: number;
  grooveOffsetSeconds: number;
  patternCycleIndex: number | null;
}

/**
 * Default bounded lookahead ceiling for MIDI output queuing (250 ms).
 * At ultra-slow tempos where one sixteenth-note step exceeds 250 ms, the window
 * expands only to cover the current single step so sub-step Note Offs are never
 * stranded while multi-step/multi-bar future events remain unqueued until due.
 */
export const DEFAULT_MAX_MIDI_HORIZON_SECONDS = 0.25;

/** Format floor ensuring a Note Off timestamp is always strictly after Note On. */
export const MIN_MIDI_NOTE_OFF_DELTA_MS = 1;

/** Safety cap for one-shot non-transport preview notes (in seconds). */
export const MAX_PREVIEW_MIDI_NOTE_SECONDS = 8;

/** Retention window for per-take scheduler deduplication keys (in seconds). */
const DEDUP_RETENTION_SECONDS = 1.5;

export const DEFAULT_CHANNEL_MIDI_OUTPUT_ROUTING: Readonly<ChannelMidiOutputRouting> = Object.freeze({
  outputDeviceId: null,
  midiChannel: 1,
  mode: 'off',
});

export const isChannelMidiOutputMode = (value: unknown): value is ChannelMidiOutputMode =>
  value === 'off' || value === 'mirror' || value === 'external';

export const clampMidiChannelNumber = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.min(16, Math.round(numeric)));
};

const clampMidiByte = (value: number, min = 0, max = 127): number =>
  Math.max(min, Math.min(max, Math.round(value)));

/**
 * Normalizes channel-level external MIDI output routing at persistence and
 * mutation boundaries. Crucially, `outputDeviceId` is preserved verbatim even
 * when hardware is unplugged — another device is never substituted.
 */
export const normalizeChannelMidiOutputRouting = (input: unknown): ChannelMidiOutputRouting => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_CHANNEL_MIDI_OUTPUT_ROUTING };
  }
  const raw = input as Record<string, unknown>;
  const outputDeviceId =
    typeof raw.outputDeviceId === 'string' && raw.outputDeviceId.trim().length > 0
      ? raw.outputDeviceId.trim()
      : null;
  const midiChannel = clampMidiChannelNumber(raw.midiChannel);
  const mode = isChannelMidiOutputMode(raw.mode) ? raw.mode : 'off';
  return {
    outputDeviceId,
    midiChannel,
    mode,
  };
};

export const resolveChannelMidiOutputRouting = (
  channel: Pick<Channel, 'midiOutput'> | null | undefined,
): ChannelMidiOutputRouting =>
  channel?.midiOutput
    ? normalizeChannelMidiOutputRouting(channel.midiOutput)
    : { ...DEFAULT_CHANNEL_MIDI_OUTPUT_ROUTING };

export const shouldSuppressInternalChannelAudio = (
  channel: Pick<Channel, 'midiOutput'> | null | undefined,
): boolean => channel?.midiOutput?.mode === 'external';

export const shouldTransmitExternalMidi = (
  channel: Pick<Channel, 'midiOutput'> | null | undefined,
): boolean => channel?.midiOutput?.mode === 'mirror' || channel?.midiOutput?.mode === 'external';

export const channelMidiOutputsEqual = (
  a: ChannelMidiOutputRouting | undefined,
  b: ChannelMidiOutputRouting | undefined,
): boolean => {
  const left = a ? normalizeChannelMidiOutputRouting(a) : DEFAULT_CHANNEL_MIDI_OUTPUT_ROUTING;
  const right = b ? normalizeChannelMidiOutputRouting(b) : DEFAULT_CHANNEL_MIDI_OUTPUT_ROUTING;
  return (
    left.outputDeviceId === right.outputDeviceId &&
    left.midiChannel === right.midiChannel &&
    left.mode === right.mode
  );
};

/**
 * Evaluates whether an enumerated MIDI output port is genuinely usable for
 * transmitting MIDI bytes — never reporting `usable: true` merely because the
 * port appeared in `MIDIAccess.outputs`.
 */
export const evaluateMidiOutputPortUsability = (
  port: MidiOutputPortLike | null | undefined,
  options: { recordedError?: string | null; verifiedOpen?: boolean } = {},
): MidiOutputUsability => {
  if (!port) {
    return {
      usable: false,
      state: 'disconnected',
      statusReason: 'Selected MIDI output device is not connected',
    };
  }
  const state = typeof port.state === 'string' && port.state.length > 0 ? port.state : 'connected';
  if (state !== 'connected') {
    return {
      usable: false,
      state,
      connection: port.connection,
      statusReason: 'Hardware device disconnected',
    };
  }
  if (options.recordedError) {
    return {
      usable: false,
      state,
      connection: port.connection,
      statusReason: options.recordedError,
    };
  }
  if (typeof port.send !== 'function') {
    return {
      usable: false,
      state,
      connection: port.connection,
      statusReason: 'Enumerated port does not support MIDI transmission',
    };
  }
  if (typeof port.connection === 'string' && port.connection !== 'open' && !options.verifiedOpen) {
    if (port.connection === 'pending') {
      return {
        usable: false,
        state,
        connection: 'pending',
        statusReason: 'Opening MIDI output port...',
      };
    }
    return {
      usable: false,
      state,
      connection: port.connection,
      statusReason: 'Port enumerated but connection is closed',
    };
  }
  return {
    usable: true,
    state: 'connected',
    connection: options.verifiedOpen ? 'open' : (port.connection ?? 'open'),
  };
};

export interface AudioTimestampLike {
  contextTime?: number;
  performanceTime?: number;
}

/**
 * Deterministic affine mapping from `AudioContext` time (seconds) to Web MIDI
 * `DOMHighResTimeStamp` (`performance.now()`, milliseconds). Uses the browser's
 * synchronized `AudioContext.getOutputTimestamp()` pair when available and
 * primed, falling back deterministically to `(audioTime - ctx.currentTime) * 1000 + performance.now()`.
 */
export const audioTimeToPerformanceMs = (
  audioTimeSeconds: number,
  contextCurrentTimeSeconds: number,
  performanceNowMs: number,
  outputTimestamp?: AudioTimestampLike | null,
): number => {
  const safeAudio = Number.isFinite(audioTimeSeconds) ? audioTimeSeconds : contextCurrentTimeSeconds;
  const safeCurrent = Number.isFinite(contextCurrentTimeSeconds) ? contextCurrentTimeSeconds : 0;
  const safeNowMs = Number.isFinite(performanceNowMs) ? performanceNowMs : 0;
  if (
    outputTimestamp &&
    typeof outputTimestamp.contextTime === 'number' &&
    Number.isFinite(outputTimestamp.contextTime) &&
    outputTimestamp.contextTime > 0 &&
    typeof outputTimestamp.performanceTime === 'number' &&
    Number.isFinite(outputTimestamp.performanceTime) &&
    outputTimestamp.performanceTime > 0
  ) {
    const mapped = outputTimestamp.performanceTime + (safeAudio - outputTimestamp.contextTime) * 1000;
    return Math.max(safeNowMs, mapped);
  }
  const deltaMs = (safeAudio - safeCurrent) * 1000;
  return Math.max(safeNowMs, safeNowMs + deltaMs);
};

export type MidiCleanupReason =
  | 'stop'
  | 'pause'
  | 'seek'
  | 'songEnd'
  | 'loopBoundary'
  | 'projectReplace'
  | 'channelChange'
  | 'disconnect'
  | 'panic'
  | 'shutdown';

export class MidiOutputScheduler {
  private readonly getPerformanceNowMs: () => number;
  private readonly getOutputTimestamp: () => AudioTimestampLike | null;
  private getOutputsMap: () => Iterable<[string, MidiOutputPortLike]> | Map<string, MidiOutputPortLike> | null;
  private nextNoteSeq = 1;
  private takeGeneration = 0;
  private currentTransportStep: TransportStepMidiContext | null = null;
  private activeNotes = new Map<number, ActiveMidiOutputNote>();
  private deferredTransportNotes: DeferredTransportNoteOn[] = [];
  private scheduledEventKeys = new Map<string, number>();
  private sustainChannelsByPortKey = new Map<string, Set<string>>();
  private portErrors = new Map<string, string>();
  private verifiedOpenPortIds = new Set<string>();
  private openingPortPromises = new Map<string, Promise<boolean>>();
  private stateListeners = new Set<() => void>();

  constructor(options: {
    performanceNowMs?: () => number;
    getOutputs?: () => Map<string, MidiOutputPortLike> | null;
    getOutputTimestamp?: () => AudioTimestampLike | null;
  } = {}) {
    this.getPerformanceNowMs =
      options.performanceNowMs ??
      (() => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()));
    this.getOutputsMap = options.getOutputs ?? (() => null);
    this.getOutputTimestamp = options.getOutputTimestamp ?? (() => null);
  }

  private mapAudioToPerfMs(
    audioTimeSeconds: number,
    contextCurrentTimeSeconds: number,
    nowPerfMs: number,
  ): number {
    let ts: AudioTimestampLike | null = null;
    try {
      ts = this.getOutputTimestamp();
    } catch {
      ts = null;
    }
    return audioTimeToPerformanceMs(audioTimeSeconds, contextCurrentTimeSeconds, nowPerfMs, ts);
  }

  public setOutputsProvider(provider: () => Map<string, MidiOutputPortLike> | null): void {
    this.getOutputsMap = provider;
  }

  public subscribeStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public notifyStateListeners(): void {
    for (const listener of [...this.stateListeners]) {
      try {
        listener();
      } catch {
        // UI state subscribers must never break real-time MIDI scheduling.
      }
    }
  }

  private resolveOutputPort(outputDeviceId: string): MidiOutputPortLike | null {
    const outputs = this.getOutputsMap();
    if (!outputs) return null;
    if (outputs instanceof Map) {
      return outputs.get(outputDeviceId) ?? null;
    }
    for (const [id, port] of outputs) {
      if (id === outputDeviceId || port?.id === outputDeviceId) return port;
    }
    return null;
  }

  public getPortUsability(outputDeviceId: string | null | undefined): MidiOutputUsability {
    if (!outputDeviceId) {
      return {
        usable: false,
        state: 'disconnected',
        statusReason: 'No MIDI output device selected',
      };
    }
    const port = this.resolveOutputPort(outputDeviceId);
    return evaluateMidiOutputPortUsability(port, {
      recordedError: this.portErrors.get(outputDeviceId) ?? null,
      verifiedOpen: this.verifiedOpenPortIds.has(outputDeviceId),
    });
  }

  public describePortInfo(port: MidiOutputPortLike, fallbackIndex = 0): MidiDeviceInfo {
    const id = port.id || `midi-out-${fallbackIndex}`;
    const usability = evaluateMidiOutputPortUsability(port, {
      recordedError: this.portErrors.get(id) ?? null,
      verifiedOpen: this.verifiedOpenPortIds.has(id),
    });
    return {
      id,
      name: port.name || 'MIDI Out Port',
      manufacturer: port.manufacturer || 'Hardware Device',
      state: usability.state,
      connection: usability.connection,
      type: 'output',
      usable: usability.usable,
      statusReason: usability.statusReason,
    };
  }

  /**
   * Opens connected output ports that expose `MIDIPort.open()` so driver locks
   * or closed connections are detected honestly instead of assuming every
   * enumerated port is Ready.
   */
  public async openConnectedOutputPorts(): Promise<void> {
    const outputs = this.getOutputsMap();
    if (!outputs) return;
    const ports: MidiOutputPortLike[] = [];
    for (const [, port] of outputs) {
      if (port && (port.state ?? 'connected') === 'connected') {
        ports.push(port);
      }
    }
    await Promise.all(ports.map(port => this.ensureOutputPortOpen(port.id)));
  }

  public async ensureOutputPortOpen(outputDeviceId: string): Promise<boolean> {
    const port = this.resolveOutputPort(outputDeviceId);
    if (!port || (port.state ?? 'connected') !== 'connected') {
      this.verifiedOpenPortIds.delete(outputDeviceId);
      return false;
    }
    if (typeof port.send !== 'function') {
      this.verifiedOpenPortIds.delete(outputDeviceId);
      return false;
    }
    if (typeof port.open !== 'function') {
      // Minimal standard MIDIOutput implementations without explicit open()
      // rely on connection state (if present) and send() availability.
      const usability = this.getPortUsability(outputDeviceId);
      return usability.usable;
    }
    if (port.connection === 'open') {
      this.portErrors.delete(outputDeviceId);
      this.verifiedOpenPortIds.add(outputDeviceId);
      return true;
    }
    const inFlight = this.openingPortPromises.get(outputDeviceId);
    if (inFlight) return inFlight;

    const openPromise = (async () => {
      try {
        await port.open!();
        this.portErrors.delete(outputDeviceId);
        if (port.connection === undefined || port.connection === 'open') {
          this.verifiedOpenPortIds.add(outputDeviceId);
        } else {
          this.verifiedOpenPortIds.delete(outputDeviceId);
        }
        this.notifyStateListeners();
        return this.getPortUsability(outputDeviceId).usable;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to open MIDI output port';
        this.portErrors.set(outputDeviceId, message);
        this.verifiedOpenPortIds.delete(outputDeviceId);
        this.notifyStateListeners();
        return false;
      } finally {
        this.openingPortPromises.delete(outputDeviceId);
      }
    })();

    this.openingPortPromises.set(outputDeviceId, openPromise);
    return openPromise;
  }

  public handlePortDisconnected(outputDeviceId: string): void {
    this.verifiedOpenPortIds.delete(outputDeviceId);
    this.openingPortPromises.delete(outputDeviceId);
    const port = this.resolveOutputPort(outputDeviceId);
    if (port && typeof port.clear === 'function') {
      try {
        port.clear();
      } catch {
        // Disconnected hardware may reject clear(); drop local tracking regardless.
      }
    }
    for (const [noteId, active] of this.activeNotes.entries()) {
      if (active.outputDeviceId === outputDeviceId) {
        this.activeNotes.delete(noteId);
      }
    }
    this.deferredTransportNotes = this.deferredTransportNotes.filter(
      item => item.outputDeviceId !== outputDeviceId,
    );
    for (const key of [...this.sustainChannelsByPortKey.keys()]) {
      if (key.startsWith(`${outputDeviceId}:`)) {
        this.sustainChannelsByPortKey.delete(key);
      }
    }
    this.notifyStateListeners();
  }

  public async handlePortReconnected(outputDeviceId: string): Promise<void> {
    this.portErrors.delete(outputDeviceId);
    await this.ensureOutputPortOpen(outputDeviceId);
    this.notifyStateListeners();
  }

  public resetDeviceErrors(): void {
    this.portErrors.clear();
    this.verifiedOpenPortIds.clear();
  }

  public beginTransportTake(
    takeGeneration: number,
    _mode: 'pat' | 'song' = 'pat',
    _patternLoopSteps: number | null = null,
  ): void {
    this.takeGeneration = takeGeneration;
    this.currentTransportStep = null;
    this.deferredTransportNotes = [];
    this.scheduledEventKeys.clear();
  }

  public beginTransportStep(stepContext: TransportStepMidiContext): void {
    this.takeGeneration = stepContext.takeGeneration;
    this.currentTransportStep = stepContext;
    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs, stepContext.contextCurrentTimeSeconds);

    const safeBpm = Number.isFinite(stepContext.bpm) && stepContext.bpm > 0 ? stepContext.bpm : 120;
    const secondsPerStep = beatsToSeconds(stepsToBeats(1), safeBpm);

    // 1. Pattern loop boundary cleanup: close any note from an earlier pattern
    //    cycle (whether exact-loop-length or overhanging past loop end) before
    //    new step-0 notes on the wrapped cycle are transmitted.
    if (
      stepContext.mode === 'pat' &&
      stepContext.patternLoopSteps !== null &&
      stepContext.patternLoopSteps > 0 &&
      stepContext.absoluteStep > 0 &&
      stepContext.step === 0
    ) {
      const currentCycle = Math.floor(stepContext.absoluteStep / stepContext.patternLoopSteps);
      const boundaryPerfMs = this.mapAudioToPerfMs(
        stepContext.unswungStepAudioTimeSeconds,
        stepContext.contextCurrentTimeSeconds,
        nowPerfMs,
      );
      for (const [noteId, active] of [...this.activeNotes.entries()]) {
        if (!active.isTransportNote) continue;
        if (active.patternCycleIndex === null || active.patternCycleIndex >= currentCycle) continue;
        if (active.queuedOffPerfMs === null) {
          const port = this.resolveUsablePort(active.outputDeviceId);
          if (port) {
            const offMs = Math.max(active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS, boundaryPerfMs);
            this.trySend(port, [0x80 | (active.midiChannel - 1), active.pitch, 0], offMs);
            active.queuedOffPerfMs = offMs;
            if (offMs <= nowPerfMs) {
              this.activeNotes.delete(noteId);
            }
          } else {
            this.activeNotes.delete(noteId);
          }
        }
      }
    }

    // 2. Flush transport Note Offs whose musical release falls within this step
    //    window [absoluteStep, absoluteStep + 1]. Holding multi-step releases
    //    until their target step enters the bounded horizon guarantees live BPM
    //    changes re-time sustained notes without stale pre-queued Note Offs.
    for (const [noteId, active] of [...this.activeNotes.entries()]) {
      if (!active.isTransportNote || active.queuedOffPerfMs !== null || active.releaseAbsoluteStep === null) {
        continue;
      }
      if (active.releaseAbsoluteStep <= stepContext.absoluteStep + 1 + 1e-9) {
        const port = this.resolveUsablePort(active.outputDeviceId);
        if (!port) {
          this.activeNotes.delete(noteId);
          continue;
        }
        const offsetSteps = Math.max(0, active.releaseAbsoluteStep - stepContext.absoluteStep);
        const releaseAudioSeconds =
          stepContext.unswungStepAudioTimeSeconds +
          offsetSteps * secondsPerStep +
          active.grooveOffsetSeconds;
        const offPerfMs = Math.max(
          active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
          this.mapAudioToPerfMs(releaseAudioSeconds, stepContext.contextCurrentTimeSeconds, nowPerfMs),
        );
        if (this.trySend(port, [0x80 | (active.midiChannel - 1), active.pitch, 0], offPerfMs)) {
          active.queuedOffPerfMs = offPerfMs;
        } else {
          this.activeNotes.delete(noteId);
        }
      }
    }

    // 3. Emit any deferred sub-sequence Note Ons (e.g. multi-step arpeggiator
    //    voices) whose musical onset has entered this step's bounded horizon.
    if (this.deferredTransportNotes.length > 0) {
      const remaining: DeferredTransportNoteOn[] = [];
      for (const deferred of this.deferredTransportNotes) {
        if (deferred.onsetAbsoluteStep < stepContext.absoluteStep + 1 - 1e-9) {
          const onsetOffsetSteps = Math.max(0, deferred.onsetAbsoluteStep - stepContext.absoluteStep);
          const onsetAudioSeconds =
            stepContext.unswungStepAudioTimeSeconds +
            onsetOffsetSteps * secondsPerStep +
            deferred.grooveOffsetSeconds;
          this.commitTransportNote({
            channelId: deferred.channelId,
            outputDeviceId: deferred.outputDeviceId,
            midiChannel: deferred.midiChannel,
            pitch: deferred.pitch,
            velocityByte: deferred.velocityByte,
            onsetAudioTimeSeconds: onsetAudioSeconds,
            onsetAbsoluteStep: deferred.onsetAbsoluteStep,
            releaseAbsoluteStep: deferred.releaseAbsoluteStep,
            grooveOffsetSeconds: deferred.grooveOffsetSeconds,
            patternCycleIndex: deferred.patternCycleIndex,
            stepContext,
            secondsPerStep,
            nowPerfMs,
          });
        } else {
          remaining.push(deferred);
        }
      }
      this.deferredTransportNotes = remaining;
    }
  }

  public endTransportStep(): void {
    this.currentTransportStep = null;
  }

  public scheduleChannelNote(params: ScheduleChannelNoteParams): ScheduleChannelNoteResult {
    const routing = resolveChannelMidiOutputRouting(params.channel);
    if (routing.mode === 'off' || !routing.outputDeviceId) {
      return { sent: false, reason: 'off_or_unassigned' };
    }
    const port = this.resolveUsablePort(routing.outputDeviceId);
    if (!port) {
      return { sent: false, reason: 'port_unavailable' };
    }

    const rawVelocity = Number.isFinite(params.note.velocity) ? params.note.velocity : 0.8;
    if (rawVelocity <= 0) {
      return { sent: false, reason: 'zero_velocity' };
    }

    const midiChannel = routing.midiChannel;
    const pitch = clampMidiByte(params.note.pitch + (params.channel.pitch || 0), 0, 127);
    const velocityByte = clampMidiByte(rawVelocity * 127, 1, 127);
    const safeBpm = Number.isFinite(params.bpm) && params.bpm > 0 ? params.bpm : 120;
    const gateSeconds = resolveGateSeconds(params.note.duration, safeBpm);
    const secondsPerStep = beatsToSeconds(stepsToBeats(1), safeBpm);
    const noteLengthInSteps = gateSeconds / secondsPerStep;

    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs, params.contextCurrentTimeSeconds);

    const stepContext = params.liveInputMidiChannel === undefined ? this.currentTransportStep : null;

    if (stepContext !== null) {
      const quantizedOnsetUs = Math.round(params.onsetAudioTimeSeconds * 1_000_000);
      const dedupKey = `${this.takeGeneration}:${params.channel.id}:${routing.outputDeviceId}:${midiChannel}:${pitch}:${params.note.id || 'step'}:${quantizedOnsetUs}`;
      if (this.scheduledEventKeys.has(dedupKey)) {
        return { sent: false, reason: 'duplicate' };
      }
      this.scheduledEventKeys.set(dedupKey, params.onsetAudioTimeSeconds);

      const onsetOffsetSteps =
        (params.onsetAudioTimeSeconds - stepContext.stepAudioTimeSeconds) / secondsPerStep;
      const onsetAbsoluteStep = stepContext.absoluteStep + onsetOffsetSteps;
      const releaseAbsoluteStep = onsetAbsoluteStep + noteLengthInSteps;
      const patternCycleIndex =
        stepContext.mode === 'pat' && stepContext.patternLoopSteps && stepContext.patternLoopSteps > 0
          ? Math.floor(Math.max(0, stepContext.absoluteStep) / stepContext.patternLoopSteps)
          : null;

      const horizonSeconds = Math.max(
        DEFAULT_MAX_MIDI_HORIZON_SECONDS,
        secondsPerStep + Math.abs(stepContext.grooveOffsetSeconds) + 0.02,
      );
      if (
        params.onsetAudioTimeSeconds > params.contextCurrentTimeSeconds + horizonSeconds &&
        onsetAbsoluteStep >= stepContext.absoluteStep + 1 - 1e-9
      ) {
        this.deferredTransportNotes.push({
          channelId: params.channel.id,
          outputDeviceId: routing.outputDeviceId,
          midiChannel,
          pitch,
          velocityByte,
          onsetAbsoluteStep,
          releaseAbsoluteStep,
          grooveOffsetSeconds: stepContext.grooveOffsetSeconds,
          patternCycleIndex,
        });
        return { sent: true, deferredToHorizon: true };
      }

      const sent = this.commitTransportNote({
        channelId: params.channel.id,
        outputDeviceId: routing.outputDeviceId,
        midiChannel,
        pitch,
        velocityByte,
        onsetAudioTimeSeconds: params.onsetAudioTimeSeconds,
        onsetAbsoluteStep,
        releaseAbsoluteStep,
        grooveOffsetSeconds: stepContext.grooveOffsetSeconds,
        patternCycleIndex,
        stepContext,
        secondsPerStep,
        nowPerfMs,
      });
      return sent ? { sent: true } : { sent: false, reason: 'send_failed' };
    }

    // Non-transport live input or preview note:
    const onPerfMs = this.mapAudioToPerfMs(
      params.onsetAudioTimeSeconds,
      params.contextCurrentTimeSeconds,
      nowPerfMs,
    );
    this.retriggerOverlappingPitchIfOpen(routing.outputDeviceId, midiChannel, pitch, onPerfMs, null);

    if (!this.trySend(port, [0x90 | (midiChannel - 1), pitch, velocityByte], onPerfMs)) {
      return { sent: false, reason: 'send_failed' };
    }

    let queuedOffPerfMs: number | null = null;
    if (params.liveInputMidiChannel === undefined) {
      const previewSeconds = Math.min(gateSeconds, MAX_PREVIEW_MIDI_NOTE_SECONDS);
      const offPerfMs = Math.max(
        onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
        this.mapAudioToPerfMs(
          params.onsetAudioTimeSeconds + previewSeconds,
          params.contextCurrentTimeSeconds,
          nowPerfMs,
        ),
      );
      if (this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], offPerfMs)) {
        queuedOffPerfMs = offPerfMs;
      }
    }

    const noteRecord: ActiveMidiOutputNote = {
      id: this.nextNoteSeq++,
      channelId: params.channel.id,
      outputDeviceId: routing.outputDeviceId,
      midiChannel,
      pitch,
      velocityByte,
      onPerfMs,
      releaseAbsoluteStep: null,
      grooveOffsetSeconds: 0,
      queuedOffPerfMs,
      liveInputMidiChannel: params.liveInputMidiChannel,
      isTransportNote: false,
      patternCycleIndex: null,
    };
    this.activeNotes.set(noteRecord.id, noteRecord);
    return { sent: true };
  }

  private commitTransportNote(params: {
    channelId: string;
    outputDeviceId: string;
    midiChannel: number;
    pitch: number;
    velocityByte: number;
    onsetAudioTimeSeconds: number;
    onsetAbsoluteStep: number;
    releaseAbsoluteStep: number;
    grooveOffsetSeconds: number;
    patternCycleIndex: number | null;
    stepContext: TransportStepMidiContext;
    secondsPerStep: number;
    nowPerfMs: number;
  }): boolean {
    const port = this.resolveUsablePort(params.outputDeviceId);
    if (!port) return false;

    const onPerfMs = this.mapAudioToPerfMs(
      params.onsetAudioTimeSeconds,
      params.stepContext.contextCurrentTimeSeconds,
      params.nowPerfMs,
    );

    const mergedReleaseStep = this.retriggerOverlappingPitchIfOpen(
      params.outputDeviceId,
      params.midiChannel,
      params.pitch,
      onPerfMs,
      params.releaseAbsoluteStep,
    );

    if (!this.trySend(port, [0x90 | (params.midiChannel - 1), params.pitch, params.velocityByte], onPerfMs)) {
      return false;
    }

    let queuedOffPerfMs: number | null = null;
    if (mergedReleaseStep <= params.stepContext.absoluteStep + 1 + 1e-9) {
      const releaseOffsetSteps = Math.max(0, mergedReleaseStep - params.stepContext.absoluteStep);
      const releaseAudioSeconds =
        params.stepContext.unswungStepAudioTimeSeconds +
        releaseOffsetSteps * params.secondsPerStep +
        params.grooveOffsetSeconds;
      const offPerfMs = Math.max(
        onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
        this.mapAudioToPerfMs(
          releaseAudioSeconds,
          params.stepContext.contextCurrentTimeSeconds,
          params.nowPerfMs,
        ),
      );
      if (this.trySend(port, [0x80 | (params.midiChannel - 1), params.pitch, 0], offPerfMs)) {
        queuedOffPerfMs = offPerfMs;
      }
    }

    const record: ActiveMidiOutputNote = {
      id: this.nextNoteSeq++,
      channelId: params.channelId,
      outputDeviceId: params.outputDeviceId,
      midiChannel: params.midiChannel,
      pitch: params.pitch,
      velocityByte: params.velocityByte,
      onPerfMs,
      releaseAbsoluteStep: mergedReleaseStep,
      grooveOffsetSeconds: params.grooveOffsetSeconds,
      queuedOffPerfMs,
      isTransportNote: true,
      patternCycleIndex: params.patternCycleIndex,
    };
    this.activeNotes.set(record.id, record);
    return true;
  }

  /**
   * When a new Note On arrives for an `(outputDeviceId, midiChannel, pitch)` that
   * already has an open (unreleased) Note On, emits a clean retrigger Note Off
   * immediately before the new Note On and merges their release span so the
   * longer overlapping note is never cut short and Note On/Off counts stay 1:1.
   */
  private retriggerOverlappingPitchIfOpen(
    outputDeviceId: string,
    midiChannel: number,
    pitch: number,
    onPerfMs: number,
    requestedReleaseStep: number | null,
  ): number {
    let effectiveReleaseStep = requestedReleaseStep ?? 0;
    const port = this.resolveUsablePort(outputDeviceId);
    for (const [id, existing] of [...this.activeNotes.entries()]) {
      if (
        existing.outputDeviceId !== outputDeviceId ||
        existing.midiChannel !== midiChannel ||
        existing.pitch !== pitch
      ) {
        continue;
      }
      if (existing.queuedOffPerfMs !== null && existing.queuedOffPerfMs <= onPerfMs) {
        this.activeNotes.delete(id);
        continue;
      }
      if (existing.queuedOffPerfMs === null) {
        if (port) {
          this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], onPerfMs);
        }
        if (existing.releaseAbsoluteStep !== null && requestedReleaseStep !== null) {
          effectiveReleaseStep = Math.max(effectiveReleaseStep, existing.releaseAbsoluteStep);
        }
        this.activeNotes.delete(id);
      }
    }
    return effectiveReleaseStep;
  }

  /**
   * Sends a MIDI Control Change message on the channel's configured external
   * output and tracks CC 64 (sustain pedal) state for safe cleanup.
   */
  public sendChannelControlChange(
    channel: Channel,
    cc: number,
    valueByte: number,
    audioTimeSeconds?: number,
    contextCurrentTimeSeconds = 0,
  ): boolean {
    const routing = resolveChannelMidiOutputRouting(channel);
    if (routing.mode === 'off' || !routing.outputDeviceId) return false;
    const port = this.resolveUsablePort(routing.outputDeviceId);
    if (!port) return false;

    const ccNum = clampMidiByte(cc, 0, 127);
    const val = clampMidiByte(valueByte, 0, 127);
    const nowPerfMs = this.getPerformanceNowMs();
    const timestampMs =
      audioTimeSeconds !== undefined
        ? this.mapAudioToPerfMs(audioTimeSeconds, contextCurrentTimeSeconds, nowPerfMs)
        : undefined;

    const ok = this.trySend(port, [0xb0 | (routing.midiChannel - 1), ccNum, val], timestampMs);
    if (ok && ccNum === 64) {
      const portChKey = `${routing.outputDeviceId}:${routing.midiChannel}`;
      if (val >= 64) {
        let holders = this.sustainChannelsByPortKey.get(portChKey);
        if (!holders) {
          holders = new Set();
          this.sustainChannelsByPortKey.set(portChKey, holders);
        }
        holders.add(channel.id);
      } else {
        const holders = this.sustainChannelsByPortKey.get(portChKey);
        holders?.delete(channel.id);
        if (holders && holders.size === 0) {
          this.sustainChannelsByPortKey.delete(portChKey);
        }
      }
    }
    return ok;
  }

  /**
   * Stops a live-monitored note (e.g. released on MIDI keyboard or virtual pad)
   * on the specified DAW channel without touching other pitches or channels.
   */
  public stopLiveChannelNote(channelId: string, pitch: number, liveInputMidiChannel?: number): number {
    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs);
    const normalizedPitch = clampMidiByte(pitch, 0, 127);
    let stopped = 0;

    for (const [id, active] of [...this.activeNotes.entries()]) {
      if (active.channelId !== channelId || active.pitch !== normalizedPitch) continue;
      if (
        liveInputMidiChannel !== undefined &&
        active.liveInputMidiChannel !== undefined &&
        active.liveInputMidiChannel !== liveInputMidiChannel
      ) {
        continue;
      }
      if (active.queuedOffPerfMs !== null && active.queuedOffPerfMs <= nowPerfMs) {
        this.activeNotes.delete(id);
        continue;
      }
      const port = this.resolveOutputPort(active.outputDeviceId);
      if (port && (port.state ?? 'connected') === 'connected' && typeof port.send === 'function') {
        const offTimestamp = active.onPerfMs > nowPerfMs ? active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS : undefined;
        this.trySend(port, [0x80 | (active.midiChannel - 1), active.pitch, 0], offTimestamp);
      }
      this.activeNotes.delete(id);
      stopped += 1;
    }
    return stopped;
  }

  /**
   * Cleans up a single DAW channel's external MIDI notes (e.g. channel muted,
   * deleted, switched to another MIDI output device/channel, or set to `off`).
   * Strictly isolated: never clears or silences other DAW channels or ports.
   */
  public cleanupChannel(channelId: string): void {
    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs);
    this.deferredTransportNotes = this.deferredTransportNotes.filter(n => n.channelId !== channelId);

    const channelNotes: ActiveMidiOutputNote[] = [];
    for (const [id, active] of [...this.activeNotes.entries()]) {
      if (active.channelId === channelId) {
        channelNotes.push(active);
        this.activeNotes.delete(id);
      }
    }

    if (channelNotes.length === 0) {
      this.releaseChannelSustainIfExclusive(channelId);
      return;
    }

    const portsUsedByTarget = new Set(channelNotes.map(n => n.outputDeviceId));
    const clearedPorts = new Set<string>();

    for (const outputDeviceId of portsUsedByTarget) {
      const otherChannelHasQueuedFutureOnPort = [...this.activeNotes.values()].some(
        other =>
          other.outputDeviceId === outputDeviceId &&
          (other.onPerfMs > nowPerfMs || (other.queuedOffPerfMs !== null && other.queuedOffPerfMs > nowPerfMs)),
      );
      if (!otherChannelHasQueuedFutureOnPort) {
        const port = this.resolveOutputPort(outputDeviceId);
        if (port && typeof port.clear === 'function') {
          try {
            port.clear();
            clearedPorts.add(outputDeviceId);
          } catch {
            // Fall through to targeted Note Offs below.
          }
        }
      }
    }

    const sentImmediatePitchKeys = new Set<string>();
    const affectedPortChannels = new Set<string>();
    for (const note of channelNotes) {
      const port = this.resolveOutputPort(note.outputDeviceId);
      if (!port || (port.state ?? 'connected') !== 'connected' || typeof port.send !== 'function') {
        continue;
      }
      const wasCleared = clearedPorts.has(note.outputDeviceId);
      // If Note On was still in the future and port.clear() succeeded, it was
      // cancelled before ever sounding; otherwise send Note Off cleanly.
      if (note.onPerfMs > nowPerfMs && wasCleared) {
        continue;
      }
      const key = `${note.outputDeviceId}:${note.midiChannel}:${note.pitch}`;
      if (note.onPerfMs <= nowPerfMs) {
        if (!sentImmediatePitchKeys.has(key)) {
          sentImmediatePitchKeys.add(key);
          this.trySend(port, [0x80 | (note.midiChannel - 1), note.pitch, 0]);
        }
      } else {
        // Port does not support clear() and Note On is queued in the future:
        // schedule Note Off immediately after the queued Note On.
        this.trySend(
          port,
          [0x80 | (note.midiChannel - 1), note.pitch, 0],
          note.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
        );
      }
      affectedPortChannels.add(`${note.outputDeviceId}:${note.midiChannel}`);
    }

    this.releaseChannelSustainIfExclusive(channelId);

    for (const portChKey of affectedPortChannels) {
      const [outputDeviceId, chStr] = portChKey.split(':');
      const midiChannel = Number(chStr);
      const siblingActiveOnSamePortChannel = [...this.activeNotes.values()].some(
        other => other.outputDeviceId === outputDeviceId && other.midiChannel === midiChannel,
      );
      if (!siblingActiveOnSamePortChannel) {
        const port = this.resolveOutputPort(outputDeviceId);
        if (port && (port.state ?? 'connected') === 'connected' && typeof port.send === 'function') {
          this.trySend(port, [0xb0 | (midiChannel - 1), 123, 0]);
        }
      }
    }
  }

  private releaseChannelSustainIfExclusive(channelId: string): void {
    for (const [portChKey, holders] of [...this.sustainChannelsByPortKey.entries()]) {
      if (!holders.has(channelId)) continue;
      holders.delete(channelId);
      if (holders.size === 0) {
        this.sustainChannelsByPortKey.delete(portChKey);
        const [outputDeviceId, chStr] = portChKey.split(':');
        const midiChannel = Number(chStr);
        const port = this.resolveOutputPort(outputDeviceId);
        if (port && (port.state ?? 'connected') === 'connected' && typeof port.send === 'function') {
          this.trySend(port, [0xb0 | (midiChannel - 1), 64, 0]);
        }
      }
    }
  }

  /**
   * Reconciles live channel edits (output device switch, MIDI channel change,
   * mode -> `off`, channel deletion, mute/solo audibility changes) and cleans
   * up only the affected channel/output routes.
   */
  /**
   * Re-times already-queued in-flight transport Note Offs when tempo changes
   * mid-step. Multi-step notes whose release has not yet entered the 1-step
   * horizon already hold `queuedOffPerfMs === null` and pick up the new BPM on
   * their target step automatically; for notes whose Note Off was already sent
   * into a Web MIDI output queue (`queuedOffPerfMs > nowPerfMs`), ports that
   * support `clear()` have their stale Note Off cancelled, any pending future
   * look-ahead Note Ons preserved, and the remaining musical span re-queued at
   * the new tempo.
   */
  public handleTempoChange(previousBpm: number, nextBpm: number): void {
    if (
      !Number.isFinite(previousBpm) ||
      !Number.isFinite(nextBpm) ||
      previousBpm <= 0 ||
      nextBpm <= 0 ||
      Math.abs(previousBpm - nextBpm) < 1e-6
    ) {
      return;
    }

    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs);
    const ratio = previousBpm / nextBpm;
    const nextStepMs = beatsToSeconds(stepsToBeats(1), nextBpm) * 1000;

    const affectedPorts = new Set<string>();
    for (const active of this.activeNotes.values()) {
      if (active.isTransportNote && active.queuedOffPerfMs !== null && active.queuedOffPerfMs > nowPerfMs) {
        affectedPorts.add(active.outputDeviceId);
      }
    }
    if (affectedPorts.size === 0) return;

    const clearedPorts = new Set<string>();
    for (const outputDeviceId of affectedPorts) {
      const port = this.resolveUsablePort(outputDeviceId);
      if (port && typeof port.clear === 'function') {
        try {
          port.clear();
          clearedPorts.add(outputDeviceId);
        } catch {
          // Port does not support queue clearing; existing queued timestamps remain.
        }
      }
    }
    if (clearedPorts.size === 0) return;

    for (const active of this.activeNotes.values()) {
      if (!clearedPorts.has(active.outputDeviceId)) continue;
      const port = this.resolveUsablePort(active.outputDeviceId);
      if (!port) continue;

      // Preserve any look-ahead Note On whose timestamp is still in the future.
      if (active.onPerfMs > nowPerfMs) {
        this.trySend(
          port,
          [0x90 | (active.midiChannel - 1), active.pitch, active.velocityByte],
          active.onPerfMs,
        );
      }

      if (active.queuedOffPerfMs !== null && active.queuedOffPerfMs > nowPerfMs) {
        let retimedOffMs = active.queuedOffPerfMs;
        if (active.isTransportNote) {
          if (active.onPerfMs <= nowPerfMs) {
            const remainingSpanMs = (active.queuedOffPerfMs - nowPerfMs) * ratio;
            retimedOffMs = Math.max(
              active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
              nowPerfMs + remainingSpanMs,
            );
          } else {
            const noteSpanMs = (active.queuedOffPerfMs - active.onPerfMs) * ratio;
            retimedOffMs = Math.max(
              active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
              active.onPerfMs + noteSpanMs,
            );
          }
        }

        // If the retimed release now stretches past the 1-step horizon and has
        // an authoritative `releaseAbsoluteStep`, hold it until that step enters
        // the horizon; otherwise queue the retimed Note Off immediately.
        if (
          active.isTransportNote &&
          active.releaseAbsoluteStep !== null &&
          retimedOffMs > nowPerfMs + nextStepMs * 1.5
        ) {
          active.queuedOffPerfMs = null;
        } else if (this.trySend(port, [0x80 | (active.midiChannel - 1), active.pitch, 0], retimedOffMs)) {
          active.queuedOffPerfMs = retimedOffMs;
        }
      }
    }
  }

  public reconcileChannels(
    previousChannels: readonly Channel[],
    nextChannels: readonly Channel[],
    isChannelAudible: (channel: Channel, allChannels: readonly Channel[]) => boolean,
  ): void {
    const nextById = new Map(nextChannels.map(ch => [ch.id, ch]));
    for (const prev of previousChannels) {
      const next = nextById.get(prev.id);
      if (!next) {
        this.cleanupChannel(prev.id);
        continue;
      }
      const prevRouting = resolveChannelMidiOutputRouting(prev);
      const nextRouting = resolveChannelMidiOutputRouting(next);
      const prevTransmitting =
        shouldTransmitExternalMidi(prev) &&
        Boolean(prevRouting.outputDeviceId) &&
        isChannelAudible(prev, previousChannels);
      const nextTransmitting =
        shouldTransmitExternalMidi(next) &&
        Boolean(nextRouting.outputDeviceId) &&
        isChannelAudible(next, nextChannels);

      if (
        prevTransmitting &&
        (!nextTransmitting ||
          prevRouting.outputDeviceId !== nextRouting.outputDeviceId ||
          prevRouting.midiChannel !== nextRouting.midiChannel)
      ) {
        this.cleanupChannel(prev.id);
      }
    }
  }

  /**
   * Global transport / panic / shutdown cleanup across all active MIDI outputs:
   * 1. Cancels queued future messages via `MIDIOutput.clear()` where supported.
   * 2. Sends explicit Note Offs for every active note on affected `(port, channel)`.
   * 3. Releases active sustain (CC 64 = 0) where held (or unconditionally on panic/shutdown).
   * 4. Sends All Notes Off (CC 123 = 0) on affected `(port, channel)` pairs,
   *    leaving unrelated ports and unrelated MIDI channels untouched.
   */
  public cleanupAll(
    reason: MidiCleanupReason,
    configuredChannels?: readonly Channel[],
  ): void {
    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs);
    this.currentTransportStep = null;
    this.deferredTransportNotes = [];
    if (reason !== 'seek') {
      this.scheduledEventKeys.clear();
    } else {
      // A seek begins a fresh scheduling window at the new timeline position.
      this.scheduledEventKeys.clear();
    }

    const notesToClean = [...this.activeNotes.values()];
    this.activeNotes.clear();

    const affectedPortIds = new Set<string>();
    const affectedPortChannels = new Set<string>();

    for (const note of notesToClean) {
      affectedPortIds.add(note.outputDeviceId);
      affectedPortChannels.add(`${note.outputDeviceId}:${note.midiChannel}`);
    }
    for (const portChKey of this.sustainChannelsByPortKey.keys()) {
      const [portId] = portChKey.split(':');
      affectedPortIds.add(portId);
      affectedPortChannels.add(portChKey);
    }
    if ((reason === 'panic' || reason === 'shutdown') && configuredChannels) {
      for (const ch of configuredChannels) {
        const routing = resolveChannelMidiOutputRouting(ch);
        if (routing.mode !== 'off' && routing.outputDeviceId) {
          affectedPortIds.add(routing.outputDeviceId);
          affectedPortChannels.add(`${routing.outputDeviceId}:${routing.midiChannel}`);
        }
      }
    }

    const clearedPorts = new Set<string>();
    for (const outputDeviceId of affectedPortIds) {
      const port = this.resolveOutputPort(outputDeviceId);
      if (port && typeof port.clear === 'function') {
        try {
          port.clear();
          clearedPorts.add(outputDeviceId);
        } catch {
          // Proceed with explicit Note Off + CC cleanup below.
        }
      }
    }

    const sentImmediatePitches = new Set<string>();
    for (const note of notesToClean) {
      const port = this.resolveOutputPort(note.outputDeviceId);
      if (!port || (port.state ?? 'connected') !== 'connected' || typeof port.send !== 'function') {
        continue;
      }
      const wasCleared = clearedPorts.has(note.outputDeviceId);
      if (note.onPerfMs > nowPerfMs && wasCleared) {
        continue;
      }
      const pitchKey = `${note.outputDeviceId}:${note.midiChannel}:${note.pitch}`;
      if (note.onPerfMs <= nowPerfMs) {
        if (!sentImmediatePitches.has(pitchKey)) {
          sentImmediatePitches.add(pitchKey);
          this.trySend(port, [0x80 | (note.midiChannel - 1), note.pitch, 0]);
        }
      } else {
        this.trySend(
          port,
          [0x80 | (note.midiChannel - 1), note.pitch, 0],
          note.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
        );
      }
    }

    for (const portChKey of affectedPortChannels) {
      const [outputDeviceId, chStr] = portChKey.split(':');
      const midiChannel = Number(chStr);
      const port = this.resolveOutputPort(outputDeviceId);
      if (!port || (port.state ?? 'connected') !== 'connected' || typeof port.send !== 'function') {
        continue;
      }
      const hadSustain = this.sustainChannelsByPortKey.has(portChKey);
      if (hadSustain || reason === 'panic' || reason === 'shutdown') {
        this.trySend(port, [0xb0 | (midiChannel - 1), 64, 0]);
      }
      this.trySend(port, [0xb0 | (midiChannel - 1), 123, 0]);
    }

    this.sustainChannelsByPortKey.clear();
  }

  public getActiveNoteCount(channelId?: string): number {
    this.pruneCompletedState(this.getPerformanceNowMs());
    if (!channelId) return this.activeNotes.size;
    let count = 0;
    for (const note of this.activeNotes.values()) {
      if (note.channelId === channelId) count += 1;
    }
    return count;
  }

  private resolveUsablePort(outputDeviceId: string): MidiOutputPortLike | null {
    const port = this.resolveOutputPort(outputDeviceId);
    if (!port) return null;
    const usability = evaluateMidiOutputPortUsability(port, {
      recordedError: this.portErrors.get(outputDeviceId) ?? null,
      verifiedOpen: this.verifiedOpenPortIds.has(outputDeviceId),
    });
    return usability.usable ? port : null;
  }

  private trySend(port: MidiOutputPortLike, data: number[], timestampMs?: number): boolean {
    if (!port || typeof port.send !== 'function') return false;
    try {
      if (timestampMs !== undefined && Number.isFinite(timestampMs)) {
        port.send(data, timestampMs);
      } else {
        port.send(data);
      }
      return true;
    } catch (error) {
      const id = port.id || '';
      const message = error instanceof Error ? error.message : 'MIDI output send failed';
      if (id) {
        this.portErrors.set(id, message);
        this.verifiedOpenPortIds.delete(id);
      }
      this.notifyStateListeners();
      return false;
    }
  }

  private pruneCompletedState(nowPerfMs: number, contextCurrentTimeSeconds?: number): void {
    for (const [id, note] of [...this.activeNotes.entries()]) {
      if (note.queuedOffPerfMs !== null && note.queuedOffPerfMs <= nowPerfMs) {
        this.activeNotes.delete(id);
      }
    }
    if (contextCurrentTimeSeconds !== undefined && this.scheduledEventKeys.size > 0) {
      const cutoff = contextCurrentTimeSeconds - DEDUP_RETENTION_SECONDS;
      for (const [key, onsetSeconds] of [...this.scheduledEventKeys.entries()]) {
        if (onsetSeconds < cutoff) {
          this.scheduledEventKeys.delete(key);
        }
      }
    }
  }
}
