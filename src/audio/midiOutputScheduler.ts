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
  /**
   * True when an overlapping same-pitch note already had a future Note Off
   * submitted to a port without a working `MIDIOutput.clear()`, so that
   * pre-queued Note Off could not be cancelled by the Web MIDI API.
   */
  uncancelledQueuedNoteOff?: boolean;
  effectiveReleasePerfMs?: number;
  reason?: 'off_or_unassigned' | 'port_unavailable' | 'zero_velocity' | 'duplicate' | 'send_failed';
}

interface PendingMidiControlChange {
  channelId: string;
  outputDeviceId: string;
  midiChannel: number;
  bytes: [number, number, number];
  perfMs: number;
}

interface DisconnectedMidiPortRecovery {
  /** Unique voices owned on this output at link loss, keyed by MIDI channel and pitch. */
  noteOffs: Map<string, { midiChannel: number; pitch: number; latestOnPerfMs: number }>;
  /** Channels on which this output may still have a held sustain pedal. */
  sustainChannels: Set<number>;
  /** Latest timestamp of any old queued event that clear() could not cancel. */
  latestQueuedEventPerfMs: number;
  /** Prevent concurrent open/statechange paths from queueing duplicate recovery releases. */
  recovering: boolean;
  /** Invalidates an in-flight recovery if the same output disconnects again. */
  generation: number;
}

interface RecentMidiVoiceRecoveryCandidate {
  outputDeviceId: string;
  midiChannel: number;
  pitch: number;
  latestOnPerfMs: number;
  latestEventPerfMs: number;
  expiresAtPerfMs: number;
}

interface RecentMidiSustainRecoveryCandidate {
  outputDeviceId: string;
  midiChannel: number;
  /** Latest queued CC64 event; send acceptance is not receiver acknowledgement. */
  latestEventPerfMs: number;
}

interface PitchScheduleOutcome {
  sent: boolean;
  uncancelledQueuedOffPerfMs: number | null;
}

interface ActiveMidiOutputNote {
  id: number;
  channelId: string;
  outputDeviceId: string;
  midiChannel: number;
  pitch: number;
  velocityByte: number;
  onPerfMs: number;
  // Immutable / per-contributor musical release intent owned by `channelId`:
  onsetAbsoluteStep: number | null;
  intendedReleaseStep: number | null;
  intendedOffPerfMs: number | null;
  grooveOffsetSeconds: number;
  liveInputMidiChannel?: number;
  isTransportNote: boolean;
  patternCycleIndex: number | null;
  // Derived / reconciled physical MIDI wire state:
  emitNoteOn: boolean;
  segmentClosedOnWire: boolean;
  releaseAbsoluteStep: number | null;
  tailGrooveOffsetSeconds: number;
  queuedOffPerfMs: number | null;
  uncancelledHardwareOffPerfMs: number | null;
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

/**
 * A delayed MIDI-port disconnect callback can arrive after the scheduler's
 * intended Note Off has elapsed. Retain only the latest state for each
 * (output, channel, pitch) for a short grace window so that this callback can
 * still recover the physical voice without keeping note history indefinitely.
 */
const RECENT_NOTE_RECOVERY_RETENTION_MS = 30_000;
const MAX_RECENT_NOTE_RECOVERY_CANDIDATES = 8_192;
const MAX_RECENT_SUSTAIN_RECOVERY_CANDIDATES = 8_192;
const MAX_DISCONNECTED_PORT_RECOVERIES = 64;
const MAX_RECOVERY_CAPACITY_BLOCKED_OUTPUTS = 64;
const RECENT_NOTE_RECOVERY_PRUNE_INTERVAL_MS = 1_000;

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
    const impliedNowPerfMs =
      outputTimestamp.performanceTime + (safeCurrent - outputTimestamp.contextTime) * 1000;
    // Guard against unprimed or pre-suspend AudioContext outputTimestamp pairs
    // whose implied clock lags/leads performance.now() by >500 ms (which would
    // otherwise clamp future look-ahead MIDI events down to safeNowMs).
    if (Math.abs(impliedNowPerfMs - safeNowMs) <= 500) {
      const mapped = outputTimestamp.performanceTime + (safeAudio - outputTimestamp.contextTime) * 1000;
      return Math.max(safeNowMs, mapped);
    }
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
  private lastTransportStep: TransportStepMidiContext | null = null;
  private activeNotes = new Map<number, ActiveMidiOutputNote>();
  private deferredTransportNotes: DeferredTransportNoteOn[] = [];
  private pendingControlChanges: PendingMidiControlChange[] = [];
  private scheduledEventKeys = new Map<string, number>();
  private sustainChannelsByPortKey = new Map<string, Set<string>>();
  private disconnectedPortRecoveries = new Map<string, DisconnectedMidiPortRecovery>();
  private recentNoteRecoveryCandidates = new Map<string, RecentMidiVoiceRecoveryCandidate>();
  /** Sticky per-route fail-closed markers for obligations that exceeded a bounded recovery store. */
  private recoveryCapacityBlockedOutputIds = new Set<string>();
  /** If even the bounded per-route marker store fills, quarantine every output for this scheduler session. */
  private recoveryCapacityGloballyBlocked = false;
  /** One persistent uncertainty record per output/channel until reconnect cleanup settles. */
  private recentSustainRecoveryCandidates = new Map<string, RecentMidiSustainRecoveryCandidate>();
  private lastRecentNoteRecoveryPrunePerfMs = Number.NEGATIVE_INFINITY;
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
    const usability = evaluateMidiOutputPortUsability(port, {
      recordedError: this.portErrors.get(outputDeviceId) ?? null,
      verifiedOpen: this.verifiedOpenPortIds.has(outputDeviceId),
    });
    if (this.isRecoveryCapacityBlocked(outputDeviceId)) {
      return {
        ...usability,
        usable: false,
        statusReason: this.recoveryCapacityStatusReason(outputDeviceId),
      };
    }
    const recoveryPending = this.disconnectedPortRecoveries.has(outputDeviceId);
    return recoveryPending && usability.usable
      ? { ...usability, usable: false, statusReason: 'Reconnect cleanup is pending for this MIDI output' }
      : usability;
  }

  public describePortInfo(port: MidiOutputPortLike, fallbackIndex = 0): MidiDeviceInfo {
    const id = port.id || `midi-out-${fallbackIndex}`;
    const usability = evaluateMidiOutputPortUsability(port, {
      recordedError: this.portErrors.get(id) ?? null,
      verifiedOpen: this.verifiedOpenPortIds.has(id),
    });
    const recoveryCapacityBlocked = this.isRecoveryCapacityBlocked(id);
    const recoveryPending = this.disconnectedPortRecoveries.has(id);
    return {
      id,
      name: port.name || 'MIDI Out Port',
      manufacturer: port.manufacturer || 'Hardware Device',
      state: usability.state,
      connection: usability.connection,
      type: 'output',
      usable: usability.usable && !recoveryPending && !recoveryCapacityBlocked,
      statusReason: recoveryCapacityBlocked
        ? this.recoveryCapacityStatusReason(id)
        : recoveryPending && usability.usable
          ? 'Reconnect cleanup is pending for this MIDI output'
          : usability.statusReason,
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
      const usability = evaluateMidiOutputPortUsability(port, {
        recordedError: this.portErrors.get(outputDeviceId) ?? null,
        verifiedOpen: this.verifiedOpenPortIds.has(outputDeviceId),
      });
      if (!usability.usable) return false;
      const recovered = await this.recoverDisconnectedPort(outputDeviceId, port);
      return recovered && this.getPortUsability(outputDeviceId).usable;
    }
    if (port.connection === 'open') {
      this.portErrors.delete(outputDeviceId);
      this.verifiedOpenPortIds.add(outputDeviceId);
      const recovered = await this.recoverDisconnectedPort(outputDeviceId, port);
      return recovered && this.getPortUsability(outputDeviceId).usable;
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
        const recovered = await this.recoverDisconnectedPort(outputDeviceId, port);
        this.notifyStateListeners();
        return recovered && this.getPortUsability(outputDeviceId).usable;
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

  private rememberRecentMidiVoice(port: MidiOutputPortLike, data: number[], timestampMs?: number): void {
    const status = data[0];
    const pitch = data[1];
    const velocity = data[2];
    if (!Number.isInteger(status) || !Number.isInteger(pitch) || !Number.isInteger(velocity)) return;
    const command = status & 0xf0;
    const isNoteOn = command === 0x90 && velocity > 0;
    const isNoteOff = command === 0x80 || (command === 0x90 && velocity === 0);
    if (!isNoteOn && !isNoteOff) return;

    const midiChannel = (status & 0x0f) + 1;
    const key = JSON.stringify([port.id, midiChannel, pitch]);
    const nowPerfMs = this.getPerformanceNowMs();
    const eventPerfMs = Number.isFinite(timestampMs) ? timestampMs! : nowPerfMs;
    const existing = this.recentNoteRecoveryCandidates.get(key);
    // A release without a recently accepted Note On does not establish voice
    // ownership. Keeping one latest record per route voice also coalesces MIDI
    // unison contributors instead of accumulating one record per DAW note.
    if (isNoteOff && !existing) return;

    const candidate: RecentMidiVoiceRecoveryCandidate = {
      outputDeviceId: port.id,
      midiChannel,
      pitch,
      latestOnPerfMs: isNoteOn
        ? Math.max(existing?.latestOnPerfMs ?? Number.NEGATIVE_INFINITY, eventPerfMs)
        : existing!.latestOnPerfMs,
      latestEventPerfMs: Math.max(existing?.latestEventPerfMs ?? Number.NEGATIVE_INFINITY, eventPerfMs),
      expiresAtPerfMs: Math.max(
        existing?.expiresAtPerfMs ?? Number.NEGATIVE_INFINITY,
        Math.max(nowPerfMs, eventPerfMs) + RECENT_NOTE_RECOVERY_RETENTION_MS,
      ),
    };
    if (!existing && this.recentNoteRecoveryCandidates.size >= MAX_RECENT_NOTE_RECOVERY_CANDIDATES) {
      // Do not evict an unresolved physical voice to make room for a newer one.
      // This output is quarantined instead of pretending its recovery state is complete.
      this.blockOutputForRecoveryCapacity(port.id);
      return;
    }
    this.recentNoteRecoveryCandidates.delete(key);
    this.recentNoteRecoveryCandidates.set(key, candidate);
  }

  private sustainRecoveryCandidateKey(outputDeviceId: string, midiChannel: number): string {
    return JSON.stringify([outputDeviceId, midiChannel]);
  }

  private rememberRecentSustainRecoveryCandidate(
    outputDeviceId: string,
    midiChannel: number,
    eventPerfMs: number,
  ): boolean {
    const key = this.sustainRecoveryCandidateKey(outputDeviceId, midiChannel);
    const existing = this.recentSustainRecoveryCandidates.get(key);
    if (!existing && this.recentSustainRecoveryCandidates.size >= MAX_RECENT_SUSTAIN_RECOVERY_CANDIDATES) {
      this.blockOutputForRecoveryCapacity(outputDeviceId);
      return false;
    }
    this.recentSustainRecoveryCandidates.set(key, {
      outputDeviceId,
      midiChannel,
      latestEventPerfMs: Math.max(existing?.latestEventPerfMs ?? Number.NEGATIVE_INFINITY, eventPerfMs),
    });
    return true;
  }

  private clearRecentSustainRecoveryCandidate(
    outputDeviceId: string,
    midiChannel: number,
    noNewerThanPerfMs = Number.POSITIVE_INFINITY,
  ): void {
    const key = this.sustainRecoveryCandidateKey(outputDeviceId, midiChannel);
    const candidate = this.recentSustainRecoveryCandidates.get(key);
    if (candidate && candidate.latestEventPerfMs <= noNewerThanPerfMs) {
      this.recentSustainRecoveryCandidates.delete(key);
    }
  }

  private isRecoveryCapacityBlocked(outputDeviceId: string): boolean {
    return this.recoveryCapacityGloballyBlocked || this.recoveryCapacityBlockedOutputIds.has(outputDeviceId);
  }

  private recoveryCapacityStatusReason(outputDeviceId: string): string {
    if (this.recoveryCapacityGloballyBlocked && !this.recoveryCapacityBlockedOutputIds.has(outputDeviceId)) {
      return 'MIDI recovery capacity exhausted; all output routes are fail-closed until the scheduler is restarted';
    }
    return 'MIDI recovery capacity exhausted; this output is fail-closed until the scheduler is restarted';
  }

  private blockOutputForRecoveryCapacity(outputDeviceId: string): void {
    if (this.isRecoveryCapacityBlocked(outputDeviceId)) return;
    if (this.recoveryCapacityBlockedOutputIds.size < MAX_RECOVERY_CAPACITY_BLOCKED_OUTPUTS) {
      this.recoveryCapacityBlockedOutputIds.add(outputDeviceId);
    } else {
      // Keep the quarantine store bounded. If it fills, fail closed globally so
      // no unrecorded overflow output can be mistaken for a usable route.
      this.recoveryCapacityGloballyBlocked = true;
    }
    this.notifyStateListeners();
  }

  private pruneRecentMidiVoiceRecoveryCandidates(nowPerfMs: number): void {
    if (
      nowPerfMs >= this.lastRecentNoteRecoveryPrunePerfMs &&
      nowPerfMs - this.lastRecentNoteRecoveryPrunePerfMs < RECENT_NOTE_RECOVERY_PRUNE_INTERVAL_MS
    ) {
      return;
    }
    this.lastRecentNoteRecoveryPrunePerfMs = nowPerfMs;
    for (const [key, candidate] of this.recentNoteRecoveryCandidates) {
      if (candidate.expiresAtPerfMs <= nowPerfMs) this.recentNoteRecoveryCandidates.delete(key);
    }
  }

  private clearRecentMidiVoiceRecoveryCandidates(outputDeviceId: string): void {
    for (const [key, candidate] of this.recentNoteRecoveryCandidates) {
      if (candidate.outputDeviceId === outputDeviceId) this.recentNoteRecoveryCandidates.delete(key);
    }
  }

  private retainDisconnectedPortRecovery(
    outputDeviceId: string,
    recovery: DisconnectedMidiPortRecovery,
  ): boolean {
    if (
      !this.disconnectedPortRecoveries.has(outputDeviceId) &&
      this.disconnectedPortRecoveries.size >= MAX_DISCONNECTED_PORT_RECOVERIES
    ) {
      // Never evict another route's unresolved obligation. A route that cannot
      // fit is quarantined and remains unusable for this scheduler session.
      this.blockOutputForRecoveryCapacity(outputDeviceId);
      return false;
    }
    this.disconnectedPortRecoveries.set(outputDeviceId, recovery);
    return true;
  }

  public handlePortDisconnected(outputDeviceId: string): void {
    this.verifiedOpenPortIds.delete(outputDeviceId);
    this.openingPortPromises.delete(outputDeviceId);
    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs);

    const recovery = this.disconnectedPortRecoveries.get(outputDeviceId) ?? {
      noteOffs: new Map<string, { midiChannel: number; pitch: number; latestOnPerfMs: number }>(),
      sustainChannels: new Set<number>(),
      latestQueuedEventPerfMs: nowPerfMs,
      recovering: false,
      generation: 0,
    };
    recovery.generation += 1;
    for (const active of this.activeNotes.values()) {
      if (active.outputDeviceId !== outputDeviceId) continue;
      recovery.latestQueuedEventPerfMs = Math.max(
        recovery.latestQueuedEventPerfMs,
        active.onPerfMs,
        active.queuedOffPerfMs ?? -Infinity,
        active.uncancelledHardwareOffPerfMs ?? -Infinity,
      );
      if (!active.emitNoteOn || active.segmentClosedOnWire) continue;
      const key = `${active.midiChannel}:${active.pitch}`;
      const existing = recovery.noteOffs.get(key);
      recovery.noteOffs.set(key, {
        midiChannel: active.midiChannel,
        pitch: active.pitch,
        latestOnPerfMs: Math.max(existing?.latestOnPerfMs ?? -Infinity, active.onPerfMs),
      });
    }
    // `pruneCompletedState()` intentionally retires completed musical owners.
    // Keep a bounded per-wire-voice journal for a short grace window so a
    // delayed disconnect callback can still release a voice whose Note Off may
    // have been lost with the physical link. A queue timestamp is not delivery
    // acknowledgement, so include both active owners and recently completed
    // accepted Note On voices, deduplicated by (channel, pitch).
    for (const candidate of this.recentNoteRecoveryCandidates.values()) {
      if (
        candidate.outputDeviceId !== outputDeviceId ||
        candidate.expiresAtPerfMs <= nowPerfMs
      ) {
        continue;
      }
      recovery.latestQueuedEventPerfMs = Math.max(
        recovery.latestQueuedEventPerfMs,
        candidate.latestEventPerfMs,
      );
      const key = `${candidate.midiChannel}:${candidate.pitch}`;
      const existing = recovery.noteOffs.get(key);
      recovery.noteOffs.set(key, {
        midiChannel: candidate.midiChannel,
        pitch: candidate.pitch,
        latestOnPerfMs: Math.max(existing?.latestOnPerfMs ?? -Infinity, candidate.latestOnPerfMs),
      });
    }
    for (const candidate of this.recentSustainRecoveryCandidates.values()) {
      if (candidate.outputDeviceId !== outputDeviceId) continue;
      recovery.latestQueuedEventPerfMs = Math.max(
        recovery.latestQueuedEventPerfMs,
        candidate.latestEventPerfMs,
      );
      recovery.sustainChannels.add(candidate.midiChannel);
    }
    const sustainPrefix = `${outputDeviceId}:`;
    for (const [key, holders] of this.sustainChannelsByPortKey.entries()) {
      if (!key.startsWith(sustainPrefix) || holders.size === 0) continue;
      const midiChannel = Number(key.slice(sustainPrefix.length));
      if (Number.isInteger(midiChannel) && midiChannel >= 1 && midiChannel <= 16) {
        recovery.sustainChannels.add(midiChannel);
      }
    }
    // A future CC64 transition may not have reached the receiver before the link
    // disappeared. Reset that specific route as well, regardless of its value.
    for (const pending of this.pendingControlChanges) {
      if (pending.outputDeviceId !== outputDeviceId) continue;
      recovery.latestQueuedEventPerfMs = Math.max(recovery.latestQueuedEventPerfMs, pending.perfMs);
      if (pending.bytes[1] === 64) recovery.sustainChannels.add(pending.midiChannel);
    }
    const hasRecoveryObligation =
      recovery.noteOffs.size > 0 ||
      recovery.sustainChannels.size > 0 ||
      recovery.latestQueuedEventPerfMs > nowPerfMs;
    const retainedRecovery = !hasRecoveryObligation || this.retainDisconnectedPortRecovery(outputDeviceId, recovery);
    // Keep the recent voice journal if the bounded recovery store rejected this
    // route. Its explicit quarantine remains sticky, but retaining available
    // evidence allows a later callback to attempt safe cleanup without evicting
    // another route's obligation.
    if (retainedRecovery) this.clearRecentMidiVoiceRecoveryCandidates(outputDeviceId);

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
    this.pendingControlChanges = this.pendingControlChanges.filter(
      item => item.outputDeviceId !== outputDeviceId,
    );
    for (const key of [...this.sustainChannelsByPortKey.keys()]) {
      if (key.startsWith(sustainPrefix)) {
        this.sustainChannelsByPortKey.delete(key);
      }
    }
    this.notifyStateListeners();
  }

  /**
   * Releases only voices and sustain state owned by a just-disconnected output.
   * Recovery is kept per port/channel/pitch; CC 123 is deliberately avoided so
   * reconnecting one device cannot silence sibling channels or other ports.
   */
  private async recoverDisconnectedPort(
    outputDeviceId: string,
    port: MidiOutputPortLike,
  ): Promise<boolean> {
    const recovery = this.disconnectedPortRecoveries.get(outputDeviceId);
    if (!recovery) return true;
    if (recovery.recovering) return false;
    if ((port.state ?? 'connected') !== 'connected' || typeof port.send !== 'function') return false;
    recovery.recovering = true;
    const recoveryGeneration = recovery.generation;

    try {
      let queueCleared = false;
      if (typeof port.clear === 'function') {
        try {
          port.clear();
          queueCleared = true;
        } catch {
          // If clear() is unsupported/throws, wait out all known queued events before releasing/reopening this route.
        }
      }

      const latestKnownOnPerfMs = Math.max(
        Number.NEGATIVE_INFINITY,
        ...[...recovery.noteOffs.values()].map(note => note.latestOnPerfMs),
      );
      const deadlineNowPerfMs = this.getPerformanceNowMs();
      const recoveryDeadlinePerfMs = queueCleared
        // clear() cancels queued events, but keep every recovery Note Off at
        // least 1 ms after the latest accepted Note On, even if that On was
        // scheduled for the future. The route remains gated until that release
        // timestamp has passed.
        ? Math.max(deadlineNowPerfMs, latestKnownOnPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS)
        // Without a reliable clear(), wait until each known old event and the
        // latest Note On has elapsed by the strict safety delta. Do not add an
        // unnecessary extra millisecond when all timestamps are already past.
        : Math.max(
          deadlineNowPerfMs,
          recovery.latestQueuedEventPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
          latestKnownOnPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
        );
      while (true) {
        const remainingMs = recoveryDeadlinePerfMs - this.getPerformanceNowMs();
        if (remainingMs <= 0) break;
        await new Promise<void>(resolve => setTimeout(resolve, remainingMs));
      }

      const latestRecovery = this.disconnectedPortRecoveries.get(outputDeviceId);
      if (!latestRecovery) return true;
      if (latestRecovery !== recovery || latestRecovery.generation !== recoveryGeneration) {
        // A disconnect/reconnect cycle overtook this async wait. Do not release
        // or clear ownership using a stale queue snapshot; restart from the
        // newest per-port state if the same output is already back online.
        recovery.recovering = false;
        if (
          (port.state ?? 'connected') === 'connected' &&
          (port.connection === undefined || port.connection === 'open')
        ) {
          return await this.recoverDisconnectedPort(outputDeviceId, port);
        }
        return false;
      }
      if (
        (port.state ?? 'connected') !== 'connected' ||
        (port.connection !== undefined && port.connection !== 'open')
      ) {
        return false;
      }

      // Pedal-up first, then explicit Note Offs for known pitches. A Note Off is
      // idempotent here; deduplication by channel/pitch avoids duplicate releases
      // when several DAW channels contributed the same physical voice. A
      // successful CC64 send is still only queue acceptance, so retain pedal
      // ownership until its cleanup timestamp has passed.
      const queuedSustainUps = new Map<number, { releasePerfMs: number; latestEventPerfMs: number }>();
      let latestQueuedRecoverySustainUpPerfMs = Number.NEGATIVE_INFINITY;
      for (const midiChannel of [...latestRecovery.sustainChannels].sort((a, b) => a - b)) {
        const releasePerfMs = this.getPerformanceNowMs();
        if (this.trySend(port, [0xb0 | (midiChannel - 1), 64, 0], releasePerfMs)) {
          const candidate = this.recentSustainRecoveryCandidates.get(
            this.sustainRecoveryCandidateKey(outputDeviceId, midiChannel),
          );
          queuedSustainUps.set(midiChannel, {
            releasePerfMs,
            latestEventPerfMs: candidate?.latestEventPerfMs ?? Number.NEGATIVE_INFINITY,
          });
          latestQueuedRecoverySustainUpPerfMs = Math.max(latestQueuedRecoverySustainUpPerfMs, releasePerfMs);
          latestRecovery.latestQueuedEventPerfMs = Math.max(latestRecovery.latestQueuedEventPerfMs, releasePerfMs);
        }
      }
      const noteOffs = [...latestRecovery.noteOffs.entries()].sort(([, a], [, b]) =>
        a.midiChannel - b.midiChannel || a.pitch - b.pitch,
      );
      const queuedNoteOffs = new Map<string, { latestOnPerfMs: number; releasePerfMs: number }>();
      let latestQueuedRecoveryOffPerfMs = Number.NEGATIVE_INFINITY;
      for (const [key, note] of noteOffs) {
        const sendNowPerfMs = this.getPerformanceNowMs();
        const releasePerfMs = Math.max(sendNowPerfMs, note.latestOnPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS);
        if (this.trySend(port, [0x80 | (note.midiChannel - 1), note.pitch, 0], releasePerfMs)) {
          queuedNoteOffs.set(key, { latestOnPerfMs: note.latestOnPerfMs, releasePerfMs });
          latestQueuedRecoveryOffPerfMs = Math.max(latestQueuedRecoveryOffPerfMs, releasePerfMs);
          latestRecovery.latestQueuedEventPerfMs = Math.max(latestRecovery.latestQueuedEventPerfMs, releasePerfMs);
        }
      }

      // A successful send only queues MIDI. Keep this output gated until
      // future Note Offs and even immediate CC64-up cleanup timestamps have
      // passed; if another disconnect interrupts the wait, the generation
      // checks below retain every obligation for the next reconnect attempt.
      const latestQueuedRecoveryReleasePerfMs = Math.max(
        latestQueuedRecoveryOffPerfMs,
        latestQueuedRecoverySustainUpPerfMs,
      );
      if (
        queuedSustainUps.size > 0 ||
        latestQueuedRecoveryOffPerfMs > this.getPerformanceNowMs()
      ) {
        const releaseDeadlinePerfMs = latestQueuedRecoveryReleasePerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS;
        while (true) {
          const remainingMs = releaseDeadlinePerfMs - this.getPerformanceNowMs();
          if (remainingMs <= 0) break;
          await new Promise<void>(resolve => setTimeout(resolve, remainingMs));
        }
      }

      const settledRecovery = this.disconnectedPortRecoveries.get(outputDeviceId);
      if (!settledRecovery) return true;
      if (settledRecovery !== recovery || settledRecovery.generation !== recoveryGeneration) {
        recovery.recovering = false;
        if (
          (port.state ?? 'connected') === 'connected' &&
          (port.connection === undefined || port.connection === 'open')
        ) {
          return await this.recoverDisconnectedPort(outputDeviceId, port);
        }
        return false;
      }
      if (
        (port.state ?? 'connected') !== 'connected' ||
        (port.connection !== undefined && port.connection !== 'open')
      ) {
        return false;
      }
      for (const [midiChannel, sentRelease] of queuedSustainUps) {
        const candidate = this.recentSustainRecoveryCandidates.get(
          this.sustainRecoveryCandidateKey(outputDeviceId, midiChannel),
        );
        if (candidate && candidate.latestEventPerfMs > sentRelease.latestEventPerfMs) continue;
        settledRecovery.sustainChannels.delete(midiChannel);
        this.clearRecentSustainRecoveryCandidate(outputDeviceId, midiChannel, sentRelease.latestEventPerfMs);
      }
      for (const [key, sentRelease] of queuedNoteOffs) {
        const stillOwned = settledRecovery.noteOffs.get(key);
        if (stillOwned && stillOwned.latestOnPerfMs <= sentRelease.latestOnPerfMs) {
          settledRecovery.noteOffs.delete(key);
        }
      }

      if (settledRecovery.sustainChannels.size === 0 && settledRecovery.noteOffs.size === 0) {
        this.disconnectedPortRecoveries.delete(outputDeviceId);
        this.clearRecentMidiVoiceRecoveryCandidates(outputDeviceId);
        return true;
      }
      return false;
    } finally {
      const currentRecovery = this.disconnectedPortRecoveries.get(outputDeviceId);
      if (currentRecovery === recovery) currentRecovery.recovering = false;
    }
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
    this.lastTransportStep = null;
    this.deferredTransportNotes = [];
    this.scheduledEventKeys.clear();
  }

  public beginTransportStep(stepContext: TransportStepMidiContext): void {
    this.takeGeneration = stepContext.takeGeneration;
    this.currentTransportStep = stepContext;
    this.lastTransportStep = stepContext;
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
        const offMs = Math.max(active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS, boundaryPerfMs);
        if (active.segmentClosedOnWire) {
          active.intendedOffPerfMs =
            active.intendedOffPerfMs === null ? offMs : Math.min(active.intendedOffPerfMs, offMs);
          active.intendedReleaseStep = null;
          if (active.intendedOffPerfMs <= nowPerfMs) {
            this.activeNotes.delete(noteId);
          }
          continue;
        }
        if (active.queuedOffPerfMs === null) {
          const port = this.resolveUsablePort(active.outputDeviceId);
          if (port) {
            this.trySend(port, [0x80 | (active.midiChannel - 1), active.pitch, 0], offMs);
            active.queuedOffPerfMs = offMs;
            active.intendedOffPerfMs =
              active.intendedOffPerfMs === null ? offMs : Math.min(active.intendedOffPerfMs, offMs);
            active.intendedReleaseStep = null;
            active.releaseAbsoluteStep = null;
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
    for (const active of this.activeNotes.values()) {
      if (
        active.isTransportNote &&
        active.intendedReleaseStep !== null &&
        active.intendedReleaseStep <= stepContext.absoluteStep + 1 + 1e-9
      ) {
        const ownOffsetSteps = Math.max(0, active.intendedReleaseStep - stepContext.absoluteStep);
        const ownReleaseAudioSeconds =
          stepContext.unswungStepAudioTimeSeconds +
          ownOffsetSteps * secondsPerStep +
          active.grooveOffsetSeconds;
        active.intendedOffPerfMs = Math.max(
          active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
          this.mapAudioToPerfMs(
            ownReleaseAudioSeconds,
            stepContext.contextCurrentTimeSeconds,
            nowPerfMs,
          ),
        );
      }
    }

    for (const [noteId, active] of [...this.activeNotes.entries()]) {
      if (
        !active.isTransportNote ||
        active.segmentClosedOnWire ||
        active.queuedOffPerfMs !== null ||
        active.releaseAbsoluteStep === null
      ) {
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
          active.tailGrooveOffsetSeconds;
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

      const committed = this.commitTransportNote({
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
      if (!committed.sent) {
        return { sent: false, reason: 'send_failed' };
      }
      if (committed.uncancelledQueuedOffPerfMs !== null) {
        return {
          sent: true,
          uncancelledQueuedNoteOff: true,
          effectiveReleasePerfMs: committed.uncancelledQueuedOffPerfMs,
        };
      }
      return { sent: true };
    }

    // Non-transport live input or preview note:
    const onPerfMs = this.mapAudioToPerfMs(
      params.onsetAudioTimeSeconds,
      params.contextCurrentTimeSeconds,
      nowPerfMs,
    );
    const previewSeconds =
      params.liveInputMidiChannel === undefined
        ? Math.min(gateSeconds, MAX_PREVIEW_MIDI_NOTE_SECONDS)
        : null;
    const requestedOffPerfMs =
      previewSeconds !== null
        ? Math.max(
            onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
            this.mapAudioToPerfMs(
              params.onsetAudioTimeSeconds + previewSeconds,
              params.contextCurrentTimeSeconds,
              nowPerfMs,
            ),
          )
        : null;

    const noteRecord: ActiveMidiOutputNote = {
      id: this.nextNoteSeq++,
      channelId: params.channel.id,
      outputDeviceId: routing.outputDeviceId,
      midiChannel,
      pitch,
      velocityByte,
      onPerfMs,
      onsetAbsoluteStep: null,
      intendedReleaseStep: null,
      intendedOffPerfMs: requestedOffPerfMs,
      grooveOffsetSeconds: 0,
      liveInputMidiChannel: params.liveInputMidiChannel,
      isTransportNote: false,
      patternCycleIndex: null,
      emitNoteOn: true,
      segmentClosedOnWire: false,
      releaseAbsoluteStep: null,
      tailGrooveOffsetSeconds: 0,
      queuedOffPerfMs: null,
      uncancelledHardwareOffPerfMs: null,
    };

    const scheduled = this.retriggerOverlappingPitchIfOpen(noteRecord, nowPerfMs, null);
    if (!scheduled.sent) {
      return { sent: false, reason: 'send_failed' };
    }
    if (scheduled.uncancelledQueuedOffPerfMs !== null) {
      return {
        sent: true,
        uncancelledQueuedNoteOff: true,
        effectiveReleasePerfMs: scheduled.uncancelledQueuedOffPerfMs,
      };
    }
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
  }): PitchScheduleOutcome {
    const port = this.resolveUsablePort(params.outputDeviceId);
    if (!port) return { sent: false, uncancelledQueuedOffPerfMs: null };

    const onPerfMs = this.mapAudioToPerfMs(
      params.onsetAudioTimeSeconds,
      params.stepContext.contextCurrentTimeSeconds,
      params.nowPerfMs,
    );

    const releaseOffsetSteps = Math.max(
      0,
      params.releaseAbsoluteStep - params.stepContext.absoluteStep,
    );
    const releaseAudioSeconds =
      params.stepContext.unswungStepAudioTimeSeconds +
      releaseOffsetSteps * params.secondsPerStep +
      params.grooveOffsetSeconds;
    const intendedOffPerfMs = Math.max(
      onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
      this.mapAudioToPerfMs(
        releaseAudioSeconds,
        params.stepContext.contextCurrentTimeSeconds,
        params.nowPerfMs,
      ),
    );

    const record: ActiveMidiOutputNote = {
      id: this.nextNoteSeq++,
      channelId: params.channelId,
      outputDeviceId: params.outputDeviceId,
      midiChannel: params.midiChannel,
      pitch: params.pitch,
      velocityByte: params.velocityByte,
      onPerfMs,
      onsetAbsoluteStep: params.onsetAbsoluteStep,
      intendedReleaseStep: params.releaseAbsoluteStep,
      intendedOffPerfMs,
      grooveOffsetSeconds: params.grooveOffsetSeconds,
      isTransportNote: true,
      patternCycleIndex: params.patternCycleIndex,
      emitNoteOn: true,
      segmentClosedOnWire: false,
      releaseAbsoluteStep: params.releaseAbsoluteStep,
      tailGrooveOffsetSeconds: params.grooveOffsetSeconds,
      queuedOffPerfMs: null,
      uncancelledHardwareOffPerfMs: null,
    };

    return this.retriggerOverlappingPitchIfOpen(record, params.nowPerfMs, params.stepContext);
  }

  private shouldQueueClusterTailOffNow(
    tailSeg: ActiveMidiOutputNote,
    clusterReleaseStep: number | null,
    clusterOffPerfMs: number | null,
    stepContext: TransportStepMidiContext | null,
  ): boolean {
    if (clusterOffPerfMs === null) return false;
    if (!tailSeg.isTransportNote || clusterReleaseStep === null) return true;
    const effectiveStep = stepContext ?? this.lastTransportStep;
    if (effectiveStep !== null) {
      const refStep = Math.max(
        effectiveStep.absoluteStep,
        tailSeg.onsetAbsoluteStep ?? effectiveStep.absoluteStep,
      );
      return clusterReleaseStep <= refStep + 1 + 1e-9;
    }
    return tailSeg.queuedOffPerfMs !== null;
  }

  private resolveClusterEnvelope(contributors: readonly ActiveMidiOutputNote[]): {
    offPerfMs: number | null;
    releaseStep: number | null;
    tailGrooveOffsetSeconds: number;
  } {
    for (const c of contributors) {
      if (c.intendedOffPerfMs === null) {
        return { offPerfMs: null, releaseStep: null, tailGrooveOffsetSeconds: 0 };
      }
    }
    let winner = contributors[0];
    for (let i = 1; i < contributors.length; i += 1) {
      const candidate = contributors[i];
      const candOff = candidate.intendedOffPerfMs!;
      const winOff = winner.intendedOffPerfMs!;
      if (
        candOff > winOff + 1e-9 ||
        (Math.abs(candOff - winOff) <= 1e-9 && candidate.id > winner.id)
      ) {
        winner = candidate;
      }
    }
    return {
      offPerfMs: winner.intendedOffPerfMs,
      releaseStep: winner.isTransportNote ? winner.intendedReleaseStep : null,
      tailGrooveOffsetSeconds: winner.grooveOffsetSeconds,
    };
  }

  /**
   * Reconciles all active contributors on a single `(outputDeviceId, midiChannel, pitch)`
   * voice into non-overlapping physical wire segments while strictly preserving each
   * contributor's own `channelId`, `intendedReleaseStep`, and `intendedOffPerfMs`.
   *
   * Used both when scheduling new notes (`incomingId !== null`) and when recomputing
   * surviving voice envelopes after channel mute / delete / reroute (`incomingId === null`).
   */
  private reconcileVoiceContributors(
    contributors: readonly ActiveMidiOutputNote[],
    nowPerfMs: number,
    stepContext: TransportStepMidiContext | null,
    incomingId: number | null,
    commitToActiveNotes = true,
  ): Array<{ perfMs: number; order: number; bytes: number[] }> {
    if (contributors.length === 0) return [];
    const { midiChannel, pitch } = contributors[0];

    const sorted = [...contributors].sort((a, b) => {
      if (Math.abs(a.onPerfMs - b.onPerfMs) > 1e-6) {
        return a.onPerfMs - b.onPerfMs;
      }
      const aFired = a.id !== incomingId && a.emitNoteOn && a.onPerfMs <= nowPerfMs ? 0 : 1;
      const bFired = b.id !== incomingId && b.emitNoteOn && b.onPerfMs <= nowPerfMs ? 0 : 1;
      if (aFired !== bFired) return aFired - bFired;
      return a.id - b.id;
    });

    type AttackGroup = { rep: ActiveMidiOutputNote; shadowed: ActiveMidiOutputNote[] };
    const groups: AttackGroup[] = [];
    for (const note of sorted) {
      const prevGroup = groups.length > 0 ? groups[groups.length - 1] : null;
      const prevRep = prevGroup ? prevGroup.rep : null;
      if (prevGroup !== null && prevRep !== null && Math.abs(prevRep.onPerfMs - note.onPerfMs) <= 1e-6) {
        if (note.id !== incomingId && !note.emitNoteOn) {
          prevGroup.shadowed.push(note);
          continue;
        }
        const prevAlreadyFiredOnWire =
          prevRep.id !== incomingId && prevRep.emitNoteOn && prevRep.onPerfMs <= nowPerfMs;
        if (!prevAlreadyFiredOnWire) {
          prevGroup.shadowed.push(prevRep);
          prevGroup.rep = note;
          continue;
        }
      }
      groups.push({ rep: note, shadowed: [] });
    }

    const groupMaxOff = (g: AttackGroup): number | null => {
      let maxOff = g.rep.intendedOffPerfMs;
      if (maxOff === null) return null;
      for (const s of g.shadowed) {
        if (s.intendedOffPerfMs === null) return null;
        maxOff = Math.max(maxOff, s.intendedOffPerfMs);
      }
      return maxOff;
    };

    const clusters: AttackGroup[][] = [];
    let currentCluster: AttackGroup[] = [];
    let runningOffPerfMs: number | null = null;
    for (const g of groups) {
      if (currentCluster.length === 0) {
        currentCluster = [g];
        runningOffPerfMs = groupMaxOff(g);
        continue;
      }
      const overlaps = runningOffPerfMs === null || runningOffPerfMs > g.rep.onPerfMs + 1e-6;
      if (overlaps) {
        currentCluster.push(g);
        const gOff = groupMaxOff(g);
        runningOffPerfMs =
          runningOffPerfMs === null || gOff === null ? null : Math.max(runningOffPerfMs, gOff);
      } else {
        clusters.push(currentCluster);
        currentCluster = [g];
        runningOffPerfMs = groupMaxOff(g);
      }
    }
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    const immediateEvents: Array<{ perfMs: number; order: number; bytes: number[] }> = [];

    for (const cluster of clusters) {
      const allInCluster: ActiveMidiOutputNote[] = [];
      for (const g of cluster) {
        allInCluster.push(g.rep, ...g.shadowed);
      }
      const envelope = this.resolveClusterEnvelope(allInCluster);

      for (const g of cluster) {
        for (const s of g.shadowed) {
          s.emitNoteOn = false;
          s.segmentClosedOnWire = true;
          s.queuedOffPerfMs = null;
          s.releaseAbsoluteStep = null;
          if (commitToActiveNotes) {
            if (s.intendedOffPerfMs !== null && s.intendedOffPerfMs <= nowPerfMs) {
              this.activeNotes.delete(s.id);
            } else {
              this.activeNotes.set(s.id, s);
            }
          }
        }
      }

      if (envelope.offPerfMs !== null && envelope.offPerfMs <= nowPerfMs) {
        for (let k = 0; k < cluster.length; k += 1) {
          const rep = cluster[k].rep;
          const nextRep = k + 1 < cluster.length ? cluster[k + 1].rep : null;
          if (rep.id === incomingId && rep.onPerfMs <= nowPerfMs) {
            immediateEvents.push({
              perfMs: rep.onPerfMs,
              order: 1,
              bytes: [0x90 | (midiChannel - 1), pitch, rep.velocityByte],
            });
          }
          if (incomingId !== null && (rep.id === incomingId || !rep.segmentClosedOnWire)) {
            const offAt = nextRep ? nextRep.onPerfMs : envelope.offPerfMs;
            immediateEvents.push({
              perfMs: offAt,
              order: 0,
              bytes: [0x80 | (midiChannel - 1), pitch, 0],
            });
          }
        }
        if (commitToActiveNotes) {
          for (const c of allInCluster) {
            this.activeNotes.delete(c.id);
          }
        }
        continue;
      }

      let lastPastIdx = -1;
      for (let k = 0; k < cluster.length; k += 1) {
        if (cluster[k].rep.onPerfMs <= nowPerfMs) {
          lastPastIdx = k;
        }
      }

      for (let k = 0; k < cluster.length; k += 1) {
        const rep = cluster[k].rep;
        const nextRep = k + 1 < cluster.length ? cluster[k + 1].rep : null;

        if (rep.id === incomingId && rep.onPerfMs <= nowPerfMs) {
          immediateEvents.push({
            perfMs: rep.onPerfMs,
            order: 1,
            bytes: [0x90 | (midiChannel - 1), pitch, rep.velocityByte],
          });
        }

        if (k < lastPastIdx) {
          if (incomingId !== null && !rep.segmentClosedOnWire && nextRep !== null) {
            immediateEvents.push({
              perfMs: nextRep.onPerfMs,
              order: 0,
              bytes: [0x80 | (midiChannel - 1), pitch, 0],
            });
          }
          rep.segmentClosedOnWire = true;
          rep.queuedOffPerfMs = null;
          rep.releaseAbsoluteStep = null;
          if (commitToActiveNotes) {
            if (rep.intendedOffPerfMs !== null && rep.intendedOffPerfMs <= nowPerfMs) {
              this.activeNotes.delete(rep.id);
            } else {
              this.activeNotes.set(rep.id, rep);
            }
          }
        } else {
          rep.emitNoteOn = true;
          rep.segmentClosedOnWire = false;
          if (nextRep !== null) {
            rep.releaseAbsoluteStep = null;
            rep.queuedOffPerfMs = nextRep.onPerfMs;
          } else {
            rep.releaseAbsoluteStep = envelope.releaseStep;
            rep.tailGrooveOffsetSeconds = envelope.tailGrooveOffsetSeconds;
            rep.queuedOffPerfMs = this.shouldQueueClusterTailOffNow(
              rep,
              envelope.releaseStep,
              envelope.offPerfMs,
              stepContext,
            )
              ? envelope.offPerfMs
              : null;
          }
          if (commitToActiveNotes) {
            this.activeNotes.set(rep.id, rep);
          }
        }
      }
    }

    return immediateEvents;
  }

  /**
   * Order-independent pitch-voice reconciliation for `(outputDeviceId, midiChannel, pitch)`:
   * - Handles forward, reverse, simultaneous, and multi-note mixed arrival orders
   *   without losing future Note Ons/Note Offs when `AudioEngine` iterates notes
   *   in arbitrary stored array order.
   * - Preserves each contributor's own per-channel release ownership (`intendedReleaseStep`,
   *   `intendedOffPerfMs`) independently from the reconciled physical segment so muting,
   *   deleting, or rerouting one DAW channel recomputes the surviving envelope from
   *   surviving contributors only.
   * - On ports lacking `clear()` (or if `clear()` throws), never claims an
   *   already-queued Note Off was cancelled; preserves 1:1 Note On/Off parity and
   *   reports any un-cancellable hardware cutoff via `uncancelledQueuedOffPerfMs`.
   */
  private retriggerOverlappingPitchIfOpen(
    incomingRecord: ActiveMidiOutputNote,
    nowPerfMs: number,
    stepContext: TransportStepMidiContext | null,
  ): PitchScheduleOutcome {
    const { outputDeviceId, midiChannel, pitch, onPerfMs } = incomingRecord;
    const port = this.resolveUsablePort(outputDeviceId);
    if (!port) {
      return { sent: false, uncancelledQueuedOffPerfMs: null };
    }

    this.pruneCompletedState(nowPerfMs);

    const sameVoiceNotes: ActiveMidiOutputNote[] = [];
    for (const existing of this.activeNotes.values()) {
      if (
        existing.outputDeviceId === outputDeviceId &&
        existing.midiChannel === midiChannel &&
        existing.pitch === pitch
      ) {
        sameVoiceNotes.push(existing);
      }
    }

    const hasInteraction = sameVoiceNotes.some(
      existing =>
        existing.onPerfMs >= onPerfMs - 1e-6 ||
        existing.intendedOffPerfMs === null ||
        existing.intendedOffPerfMs > onPerfMs + 1e-6 ||
        (!existing.segmentClosedOnWire &&
          (existing.queuedOffPerfMs === null || existing.queuedOffPerfMs > onPerfMs + 1e-6)),
    );

    // 1. Fast path: no open overlap and no later/simultaneous future note on this voice.
    if (!hasInteraction) {
      if (!this.trySend(port, [0x90 | (midiChannel - 1), pitch, incomingRecord.velocityByte], onPerfMs)) {
        return { sent: false, uncancelledQueuedOffPerfMs: null };
      }
      if (
        this.shouldQueueClusterTailOffNow(
          incomingRecord,
          incomingRecord.intendedReleaseStep,
          incomingRecord.intendedOffPerfMs,
          stepContext,
        )
      ) {
        const offMs = incomingRecord.intendedOffPerfMs!;
        if (this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], offMs)) {
          incomingRecord.queuedOffPerfMs = offMs;
        }
      }
      if (incomingRecord.queuedOffPerfMs === null || incomingRecord.queuedOffPerfMs > nowPerfMs) {
        this.activeNotes.set(incomingRecord.id, incomingRecord);
      }
      return { sent: true, uncancelledQueuedOffPerfMs: null };
    }

    const needsPortQueueClear = sameVoiceNotes.some(
      existing =>
        (existing.queuedOffPerfMs !== null &&
          existing.queuedOffPerfMs > onPerfMs + 1e-6 &&
          existing.queuedOffPerfMs > nowPerfMs) ||
        (existing.emitNoteOn &&
          !existing.segmentClosedOnWire &&
          existing.onPerfMs >= onPerfMs - 1e-6 &&
          existing.onPerfMs > nowPerfMs),
    );

    // 2. Forward overlap against an unqueued open note (`queuedOffPerfMs === null`):
    //    no stale event sits in the Web MIDI queue, so do not call `port.clear()`.
    //    Reconcile contributor ownership in `activeNotes` without mutating any
    //    contributor's own `intendedReleaseStep` / `intendedOffPerfMs`.
    if (!needsPortQueueClear) {
      const openPrior = sameVoiceNotes
        .filter(
          e =>
            e.emitNoteOn &&
            !e.segmentClosedOnWire &&
            e.onPerfMs <= onPerfMs + 1e-6 &&
            (e.queuedOffPerfMs === null || e.queuedOffPerfMs > onPerfMs + 1e-6),
        )
        .sort((a, b) => b.onPerfMs - a.onPerfMs);

      if (openPrior.length > 0) {
        const activeSeg = openPrior[0];
        if (onPerfMs <= nowPerfMs) {
          activeSeg.segmentClosedOnWire = true;
          activeSeg.queuedOffPerfMs = null;
          activeSeg.releaseAbsoluteStep = null;
          if (activeSeg.intendedOffPerfMs !== null && activeSeg.intendedOffPerfMs <= nowPerfMs) {
            this.activeNotes.delete(activeSeg.id);
          }
        } else {
          activeSeg.queuedOffPerfMs = onPerfMs;
          activeSeg.releaseAbsoluteStep = null;
        }
        for (const extra of openPrior.slice(1)) {
          extra.segmentClosedOnWire = true;
          extra.queuedOffPerfMs = null;
          extra.releaseAbsoluteStep = null;
          if (extra.intendedOffPerfMs !== null && extra.intendedOffPerfMs <= nowPerfMs) {
            this.activeNotes.delete(extra.id);
          }
        }
        this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], onPerfMs);
      }

      if (!this.trySend(port, [0x90 | (midiChannel - 1), pitch, incomingRecord.velocityByte], onPerfMs)) {
        return { sent: false, uncancelledQueuedOffPerfMs: null };
      }

      const overlappingContributors = [
        ...sameVoiceNotes.filter(
          e => e.intendedOffPerfMs === null || e.intendedOffPerfMs > onPerfMs + 1e-6,
        ),
        incomingRecord,
      ];
      const envelope = this.resolveClusterEnvelope(overlappingContributors);
      incomingRecord.releaseAbsoluteStep = envelope.releaseStep;
      incomingRecord.tailGrooveOffsetSeconds = envelope.tailGrooveOffsetSeconds;
      if (
        this.shouldQueueClusterTailOffNow(
          incomingRecord,
          envelope.releaseStep,
          envelope.offPerfMs,
          stepContext,
        )
      ) {
        const offMs = envelope.offPerfMs!;
        if (this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], offMs)) {
          incomingRecord.queuedOffPerfMs = offMs;
        }
      }
      if (incomingRecord.queuedOffPerfMs === null || incomingRecord.queuedOffPerfMs > nowPerfMs) {
        this.activeNotes.set(incomingRecord.id, incomingRecord);
      }
      return { sent: true, uncancelledQueuedOffPerfMs: null };
    }

    let cleared = false;
    if (typeof port.clear === 'function') {
      try {
        port.clear();
        cleared = true;
      } catch {
        cleared = false;
      }
    }

    // 3. Canonical multi-note reconciliation when `port.clear()` succeeded:
    //    preserves every contributor's individual release ownership in `activeNotes`
    //    before restoring the shared physical port queue in chronological order.
    if (cleared) {
      const immediateEvents = this.reconcileVoiceContributors(
        [...sameVoiceNotes, incomingRecord],
        nowPerfMs,
        stepContext,
        incomingRecord.id,
      );

      immediateEvents.sort((a, b) => a.perfMs - b.perfMs || a.order - b.order);
      let immediateSentOk = true;
      for (const evt of immediateEvents) {
        if (!this.trySend(port, evt.bytes, evt.perfMs)) {
          immediateSentOk = false;
        }
      }

      this.requeueActivePortEvents(port, outputDeviceId, nowPerfMs);

      if (!immediateSentOk) {
        return { sent: false, uncancelledQueuedOffPerfMs: null };
      }
      return { sent: true, uncancelledQueuedOffPerfMs: null };
    }

    // 4. Honest fallback when the port lacks `MIDIOutput.clear()` (or `clear()` threw):
    //    already-queued events cannot be removed or reordered in Web MIDI.
    const earlierOpen = sameVoiceNotes
      .filter(
        e =>
          e.emitNoteOn &&
          !e.segmentClosedOnWire &&
          e.onPerfMs <= onPerfMs + 1e-6 &&
          (e.queuedOffPerfMs === null || e.queuedOffPerfMs > onPerfMs + 1e-6),
      )
      .sort((a, b) => a.onPerfMs - b.onPerfMs);
    const laterQueued = sameVoiceNotes
      .filter(e => e.emitNoteOn && !e.segmentClosedOnWire && e.onPerfMs > onPerfMs + 1e-6)
      .sort((a, b) => a.onPerfMs - b.onPerfMs);

    const earlierConflicts = earlierOpen
      .filter(e => e.queuedOffPerfMs !== null && e.queuedOffPerfMs > onPerfMs + 1e-6)
      .sort((a, b) => (a.queuedOffPerfMs ?? Infinity) - (b.queuedOffPerfMs ?? Infinity));
    const earliestEarlierConflict = earlierConflicts[0] ?? null;
    const earliestUncancelledOffMs = earliestEarlierConflict?.queuedOffPerfMs ?? null;
    const earliestUncancelledStep = earliestEarlierConflict?.releaseAbsoluteStep ?? null;

    if (earlierOpen.length > 0) {
      if (onPerfMs <= nowPerfMs) {
        for (const existing of earlierOpen) {
          existing.segmentClosedOnWire = true;
          existing.queuedOffPerfMs = null;
          existing.releaseAbsoluteStep = null;
          if (existing.intendedOffPerfMs !== null && existing.intendedOffPerfMs <= nowPerfMs) {
            this.activeNotes.delete(existing.id);
          }
        }
      } else {
        const [segment, ...rest] = earlierOpen;
        segment.queuedOffPerfMs = onPerfMs;
        segment.releaseAbsoluteStep = null;
        for (const extra of rest) {
          extra.segmentClosedOnWire = true;
          extra.queuedOffPerfMs = null;
          extra.releaseAbsoluteStep = null;
          if (extra.intendedOffPerfMs !== null && extra.intendedOffPerfMs <= nowPerfMs) {
            this.activeNotes.delete(extra.id);
          }
        }
      }
      this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], onPerfMs);
    }

    if (!this.trySend(port, [0x90 | (midiChannel - 1), pitch, incomingRecord.velocityByte], onPerfMs)) {
      return { sent: false, uncancelledQueuedOffPerfMs: null };
    }

    let uncancelledQueuedOffPerfMs: number | null = null;
    if (laterQueued.length === 0) {
      if (earliestUncancelledOffMs !== null) {
        uncancelledQueuedOffPerfMs = earliestUncancelledOffMs;
        incomingRecord.uncancelledHardwareOffPerfMs = uncancelledQueuedOffPerfMs;
        incomingRecord.queuedOffPerfMs = uncancelledQueuedOffPerfMs;
        incomingRecord.releaseAbsoluteStep = earliestUncancelledStep;
      } else {
        const overlappingContributors = [
          ...sameVoiceNotes.filter(
            e => e.intendedOffPerfMs === null || e.intendedOffPerfMs > onPerfMs + 1e-6,
          ),
          incomingRecord,
        ];
        const envelope = this.resolveClusterEnvelope(overlappingContributors);
        incomingRecord.releaseAbsoluteStep = envelope.releaseStep;
        incomingRecord.tailGrooveOffsetSeconds = envelope.tailGrooveOffsetSeconds;
        if (
          this.shouldQueueClusterTailOffNow(
            incomingRecord,
            envelope.releaseStep,
            envelope.offPerfMs,
            stepContext,
          )
        ) {
          const offMs = envelope.offPerfMs!;
          if (this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], offMs)) {
            incomingRecord.queuedOffPerfMs = offMs;
          }
        }
      }
    } else {
      const firstLater = laterQueued[0];
      const lastLater = laterQueued[laterQueued.length - 1];
      if (
        earliestUncancelledOffMs !== null &&
        earliestUncancelledOffMs < firstLater.onPerfMs - 1e-6
      ) {
        uncancelledQueuedOffPerfMs = earliestUncancelledOffMs;
        incomingRecord.uncancelledHardwareOffPerfMs = uncancelledQueuedOffPerfMs;
        incomingRecord.queuedOffPerfMs = uncancelledQueuedOffPerfMs;
        incomingRecord.releaseAbsoluteStep = null;
      } else if (
        incomingRecord.intendedOffPerfMs !== null &&
        incomingRecord.intendedOffPerfMs < firstLater.onPerfMs - 1e-6
      ) {
        if (
          this.shouldQueueClusterTailOffNow(
            incomingRecord,
            incomingRecord.intendedReleaseStep,
            incomingRecord.intendedOffPerfMs,
            stepContext,
          )
        ) {
          const offMs = incomingRecord.intendedOffPerfMs;
          if (this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], offMs)) {
            incomingRecord.queuedOffPerfMs = offMs;
          }
        }
      } else {
        // Close `incomingRecord` strictly before `firstLater`'s already-queued Note On
        // so FIFO equal-timestamp ordering on a clear-less port cannot silence `firstLater`.
        const preLaterOffMs =
          firstLater.onPerfMs - onPerfMs > 0.1 ? firstLater.onPerfMs - 0.05 : onPerfMs;
        if (this.trySend(port, [0x80 | (midiChannel - 1), pitch, 0], preLaterOffMs)) {
          incomingRecord.queuedOffPerfMs = preLaterOffMs;
        }
        incomingRecord.releaseAbsoluteStep = null;

        if (
          lastLater.queuedOffPerfMs !== null &&
          (incomingRecord.intendedOffPerfMs === null ||
            incomingRecord.intendedOffPerfMs > lastLater.queuedOffPerfMs + 1e-6)
        ) {
          uncancelledQueuedOffPerfMs = lastLater.queuedOffPerfMs;
          incomingRecord.uncancelledHardwareOffPerfMs = uncancelledQueuedOffPerfMs;
          lastLater.uncancelledHardwareOffPerfMs = uncancelledQueuedOffPerfMs;
        } else if (
          lastLater.queuedOffPerfMs !== null &&
          incomingRecord.intendedOffPerfMs !== null &&
          lastLater.queuedOffPerfMs >= incomingRecord.intendedOffPerfMs - 1e-6
        ) {
          lastLater.uncancelledHardwareOffPerfMs = lastLater.queuedOffPerfMs;
        } else if (
          lastLater.queuedOffPerfMs === null &&
          incomingRecord.intendedReleaseStep !== null &&
          lastLater.patternCycleIndex === incomingRecord.patternCycleIndex
        ) {
          const overlappingContributors = [
            ...sameVoiceNotes.filter(
              e => e.intendedOffPerfMs === null || e.intendedOffPerfMs > onPerfMs + 1e-6,
            ),
            incomingRecord,
          ];
          const envelope = this.resolveClusterEnvelope(overlappingContributors);
          lastLater.releaseAbsoluteStep = envelope.releaseStep;
          lastLater.tailGrooveOffsetSeconds = envelope.tailGrooveOffsetSeconds;
        }
      }
    }

    if (
      incomingRecord.queuedOffPerfMs === null ||
      incomingRecord.queuedOffPerfMs > nowPerfMs ||
      incomingRecord.intendedOffPerfMs === null ||
      (incomingRecord.intendedOffPerfMs > nowPerfMs &&
        incomingRecord.uncancelledHardwareOffPerfMs === null)
    ) {
      this.activeNotes.set(incomingRecord.id, incomingRecord);
    }
    return { sent: true, uncancelledQueuedOffPerfMs };
  }

  /**
   * Re-queues all pending future MIDI events (`timestamp > nowPerfMs`) tracked on
   * `outputDeviceId` after a `MIDIOutput.clear()` call so sibling channels,
   * chord voices, and pending timestamped Control Changes keep their exact
   * original timestamps without losing or duplicating already-fired messages.
   */
  private requeueActivePortEvents(
    port: MidiOutputPortLike,
    outputDeviceId: string,
    nowPerfMs: number,
  ): void {
    if ((port.state ?? 'connected') !== 'connected') return;
    const pending: Array<{ perfMs: number; order: number; bytes: number[] }> = [];
    for (const active of this.activeNotes.values()) {
      if (active.outputDeviceId !== outputDeviceId) continue;
      if (active.emitNoteOn && !active.segmentClosedOnWire && active.onPerfMs > nowPerfMs) {
        pending.push({
          perfMs: active.onPerfMs,
          order: 1,
          bytes: [0x90 | (active.midiChannel - 1), active.pitch, active.velocityByte],
        });
      }
      if (active.queuedOffPerfMs !== null && active.queuedOffPerfMs > nowPerfMs) {
        pending.push({
          perfMs: active.queuedOffPerfMs,
          order: 0,
          bytes: [0x80 | (active.midiChannel - 1), active.pitch, 0],
        });
      }
    }
    for (const ccEvt of this.pendingControlChanges) {
      if (ccEvt.outputDeviceId !== outputDeviceId || ccEvt.perfMs <= nowPerfMs) continue;
      pending.push({
        perfMs: ccEvt.perfMs,
        order: 2,
        bytes: ccEvt.bytes,
      });
    }
    pending.sort((a, b) => a.perfMs - b.perfMs || a.order - b.order);
    for (const item of pending) {
      this.trySend(port, item.bytes, item.perfMs);
    }
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
    this.pruneCompletedState(nowPerfMs);
    const timestampMs =
      audioTimeSeconds !== undefined
        ? this.mapAudioToPerfMs(audioTimeSeconds, contextCurrentTimeSeconds, nowPerfMs)
        : undefined;

    const bytes: [number, number, number] = [0xb0 | (routing.midiChannel - 1), ccNum, val];
    const ok = this.trySend(port, bytes, timestampMs);
    if (ok && timestampMs !== undefined && Number.isFinite(timestampMs) && timestampMs > nowPerfMs) {
      this.pendingControlChanges.push({
        channelId: channel.id,
        outputDeviceId: routing.outputDeviceId,
        midiChannel: routing.midiChannel,
        bytes,
        perfMs: timestampMs,
      });
    }
    if (ok && ccNum === 64) {
      const portChKey = `${routing.outputDeviceId}:${routing.midiChannel}`;
      const sustainCandidateKey = this.sustainRecoveryCandidateKey(routing.outputDeviceId, routing.midiChannel);
      const eventPerfMs = Number.isFinite(timestampMs) ? timestampMs! : nowPerfMs;
      if (val >= 64) {
        // The physical sustain state is shared across every DAW channel routed
        // to this output/channel. Keep one conservative recovery obligation for
        // the physical route, regardless of which contributor raised the pedal.
        if (!this.rememberRecentSustainRecoveryCandidate(routing.outputDeviceId, routing.midiChannel, eventPerfMs)) {
          return true;
        }
        let holders = this.sustainChannelsByPortKey.get(portChKey);
        if (!holders) {
          holders = new Set();
          this.sustainChannelsByPortKey.set(portChKey, holders);
        }
        holders.add(channel.id);
      } else {
        const holders = this.sustainChannelsByPortKey.get(portChKey);
        const mayStillBeHeld = Boolean(holders?.size || this.recentSustainRecoveryCandidates.has(sustainCandidateKey));
        if (
          mayStillBeHeld &&
          !this.rememberRecentSustainRecoveryCandidate(routing.outputDeviceId, routing.midiChannel, eventPerfMs)
        ) {
          return true;
        }
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

    const matching: ActiveMidiOutputNote[] = [];
    for (const active of this.activeNotes.values()) {
      if (active.channelId !== channelId || active.pitch !== normalizedPitch) continue;
      if (
        liveInputMidiChannel !== undefined &&
        active.liveInputMidiChannel !== undefined &&
        active.liveInputMidiChannel !== liveInputMidiChannel
      ) {
        continue;
      }
      matching.push(active);
    }
    if (matching.length === 0) return 0;

    const voiceKeys = new Set(
      matching.map(n => `${n.outputDeviceId}:${n.midiChannel}:${n.pitch}`),
    );
    const matchingIds = new Set(matching.map(n => n.id));
    let stopped = 0;

    for (const voiceKey of voiceKeys) {
      const [outputDeviceId, chStr, pitchStr] = voiceKey.split(':');
      const midiChannel = Number(chStr);
      const voicePitch = Number(pitchStr);
      const allVoiceNotes = [...this.activeNotes.values()].filter(
        n =>
          n.outputDeviceId === outputDeviceId &&
          n.midiChannel === midiChannel &&
          n.pitch === voicePitch,
      );
      const removed = allVoiceNotes.filter(n => matchingIds.has(n.id));
      const surviving = allVoiceNotes.filter(
        n =>
          !matchingIds.has(n.id) &&
          (n.intendedOffPerfMs === null || n.intendedOffPerfMs > nowPerfMs) &&
          (n.uncancelledHardwareOffPerfMs === null || n.uncancelledHardwareOffPerfMs > nowPerfMs),
      );
      const wasSoundingAtNow = allVoiceNotes.some(
        n =>
          n.emitNoteOn &&
          n.onPerfMs <= nowPerfMs &&
          !n.segmentClosedOnWire &&
          (n.queuedOffPerfMs === null || n.queuedOffPerfMs > nowPerfMs),
      );
      for (const rem of removed) {
        this.activeNotes.delete(rem.id);
        stopped += 1;
      }

      const port = this.resolveOutputPort(outputDeviceId);
      const portConnected =
        port !== null && (port.state ?? 'connected') === 'connected' && typeof port.send === 'function';
      const shouldKeepSoundingAtNow = surviving.some(s => s.onPerfMs <= nowPerfMs);

      if (surviving.length === 0) {
        const hadFutureRemoved = removed.some(
          r =>
            (r.emitNoteOn && !r.segmentClosedOnWire && r.onPerfMs > nowPerfMs) ||
            (r.queuedOffPerfMs !== null && r.queuedOffPerfMs > nowPerfMs),
        );
        const siblingHasFutureOnPort =
          [...this.activeNotes.values()].some(
            other =>
              other.outputDeviceId === outputDeviceId &&
              ((other.emitNoteOn && !other.segmentClosedOnWire && other.onPerfMs > nowPerfMs) ||
                (other.queuedOffPerfMs !== null && other.queuedOffPerfMs > nowPerfMs)),
          ) ||
          this.pendingControlChanges.some(
            c => c.outputDeviceId === outputDeviceId && c.perfMs > nowPerfMs,
          );

        let cleared = false;
        if (hadFutureRemoved && port && typeof port.clear === 'function') {
          try {
            port.clear();
            cleared = true;
            if (siblingHasFutureOnPort && portConnected) {
              this.requeueActivePortEvents(port, outputDeviceId, nowPerfMs);
            }
          } catch {
            cleared = false;
          }
        }

        if (portConnected && port) {
          if (cleared) {
            if (wasSoundingAtNow) {
              this.trySend(port, [0x80 | (midiChannel - 1), voicePitch, 0]);
            }
          } else {
            this.applyClearlessVoiceCleanup(
              port,
              {
                midiChannel,
                pitch: voicePitch,
                removedNotes: removed,
                survivingNotes: [],
                wasSoundingAtNow,
                shouldKeepSoundingAtNow: false,
              },
              nowPerfMs,
            );
          }
        }
        continue;
      }

      const prevQueuedOffById = new Map(surviving.map(s => [s.id, s.queuedOffPerfMs]));
      const prevEmitNoteOnById = new Map(
        surviving.map(s => [s.id, s.emitNoteOn && !s.segmentClosedOnWire]),
      );
      const previewSurvivors = surviving.map(s => ({ ...s }));
      this.reconcileVoiceContributors(
        previewSurvivors,
        nowPerfMs,
        this.currentTransportStep,
        null,
        false,
      );
      const needsClear =
        removed.some(
          r =>
            (r.emitNoteOn && !r.segmentClosedOnWire && r.onPerfMs > nowPerfMs) ||
            (r.queuedOffPerfMs !== null && r.queuedOffPerfMs > nowPerfMs),
        ) ||
        previewSurvivors.some(p => {
          const prevOff = prevQueuedOffById.get(p.id) ?? null;
          const prevEmit = prevEmitNoteOnById.get(p.id) ?? false;
          const nextEmit = p.emitNoteOn && !p.segmentClosedOnWire;
          if (p.onPerfMs > nowPerfMs && prevEmit !== nextEmit) {
            return true;
          }
          if (prevOff !== null && prevOff > nowPerfMs) {
            if (p.queuedOffPerfMs === null || Math.abs(p.queuedOffPerfMs - prevOff) > 1e-6) {
              return true;
            }
          }
          return false;
        });

      let cleared = false;
      if (needsClear && port && typeof port.clear === 'function') {
        try {
          port.clear();
          cleared = true;
        } catch {
          cleared = false;
        }
      }

      if (cleared || !needsClear) {
        this.reconcileVoiceContributors(surviving, nowPerfMs, this.currentTransportStep, null);
        if (portConnected && port) {
          if (wasSoundingAtNow && !shouldKeepSoundingAtNow) {
            this.trySend(port, [0x80 | (midiChannel - 1), voicePitch, 0]);
          }
          if (cleared) {
            this.requeueActivePortEvents(port, outputDeviceId, nowPerfMs);
          } else {
            for (const s of surviving) {
              if (
                prevQueuedOffById.get(s.id) === null &&
                s.queuedOffPerfMs !== null &&
                s.queuedOffPerfMs > nowPerfMs &&
                s.uncancelledHardwareOffPerfMs === null
              ) {
                this.trySend(port, [0x80 | (midiChannel - 1), voicePitch, 0], s.queuedOffPerfMs);
              }
            }
          }
        }
      } else if (portConnected && port) {
        this.applyClearlessVoiceCleanup(
          port,
          {
            midiChannel,
            pitch: voicePitch,
            removedNotes: removed,
            survivingNotes: surviving,
            wasSoundingAtNow,
            shouldKeepSoundingAtNow,
          },
          nowPerfMs,
        );
      }
    }

    return stopped;
  }

  /**
   * Honest voice cleanup when a physical `MIDIOutput` lacks `clear()` or its
   * `clear()` threw at runtime:
   * - Never claims already-queued future Note Ons or Note Offs were cancelled.
   * - For every removed future Note On (`onPerfMs > nowPerfMs`) lacking a valid
   *   already-queued Note Off strictly after its onset, enqueues a deterministic
   *   safety Note Off at `onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS`.
   * - Avoids duplicate Note Offs when a valid queued release already exists.
   * - Keeps surviving contributor ownership consistent with actual hardware state.
   */
  private applyClearlessVoiceCleanup(
    port: MidiOutputPortLike,
    snap: {
      midiChannel: number;
      pitch: number;
      removedNotes: ActiveMidiOutputNote[];
      survivingNotes: ActiveMidiOutputNote[];
      wasSoundingAtNow: boolean;
      shouldKeepSoundingAtNow: boolean;
    },
    nowPerfMs: number,
  ): void {
    const removedIds = new Set(snap.removedNotes.map(r => r.id));

    // If a removed future attack had unison-shadowed a surviving contributor at the
    // exact same `onPerfMs`, transfer that unavoidable physical Note On to the survivor.
    const promotedShadowIds = new Set<number>();
    for (const rem of snap.removedNotes) {
      if (!rem.emitNoteOn || rem.segmentClosedOnWire) continue;
      const unisonSurvivor = snap.survivingNotes.find(
        s =>
          !s.emitNoteOn &&
          !promotedShadowIds.has(s.id) &&
          Math.abs(s.onPerfMs - rem.onPerfMs) <= 1e-6,
      );
      if (unisonSurvivor) {
        promotedShadowIds.add(unisonSurvivor.id);
        unisonSurvivor.emitNoteOn = true;
        unisonSurvivor.segmentClosedOnWire = false;
        unisonSurvivor.queuedOffPerfMs = rem.queuedOffPerfMs;
        unisonSurvivor.releaseAbsoluteStep = rem.releaseAbsoluteStep;
        unisonSurvivor.tailGrooveOffsetSeconds = rem.tailGrooveOffsetSeconds;
        rem.emitNoteOn = false;
        rem.segmentClosedOnWire = true;
        rem.queuedOffPerfMs = null;
      }
    }

    const allVoiceNotes = [...snap.removedNotes, ...snap.survivingNotes];
    const wireAttacks = allVoiceNotes
      .filter(n => n.emitNoteOn && !n.segmentClosedOnWire)
      .sort((a, b) => a.onPerfMs - b.onPerfMs || a.id - b.id);

    for (let k = 0; k < wireAttacks.length; k += 1) {
      const atk = wireAttacks[k];
      if (!removedIds.has(atk.id)) continue;

      if (atk.onPerfMs <= nowPerfMs) {
        const hasQueuedFutureOff =
          atk.queuedOffPerfMs !== null && atk.queuedOffPerfMs > nowPerfMs;
        if (snap.shouldKeepSoundingAtNow) {
          const covering = snap.survivingNotes
            .filter(s => s.onPerfMs <= nowPerfMs)
            .sort((a, b) => b.onPerfMs - a.onPerfMs || b.id - a.id);
          const carrier = covering[0] ?? null;
          if (carrier) {
            carrier.emitNoteOn = true;
            carrier.segmentClosedOnWire = false;
            if (hasQueuedFutureOff) {
              carrier.queuedOffPerfMs = atk.queuedOffPerfMs;
              carrier.uncancelledHardwareOffPerfMs = atk.queuedOffPerfMs;
              carrier.releaseAbsoluteStep = null;
            }
          }
        } else if (!hasQueuedFutureOff || snap.survivingNotes.length === 0) {
          this.trySend(port, [0x80 | (snap.midiChannel - 1), snap.pitch, 0]);
        }
        continue;
      }

      const hasValidQueuedOff =
        atk.queuedOffPerfMs !== null && atk.queuedOffPerfMs > atk.onPerfMs + 1e-6;
      if (!hasValidQueuedOff) {
        const nextAtk = k + 1 < wireAttacks.length ? wireAttacks[k + 1] : null;
        const defaultSafetyOffMs = atk.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS;
        const safetyOffMs =
          nextAtk !== null && nextAtk.onPerfMs < defaultSafetyOffMs
            ? (atk.onPerfMs + nextAtk.onPerfMs) * 0.5
            : defaultSafetyOffMs;
        this.trySend(
          port,
          [0x80 | (snap.midiChannel - 1), snap.pitch, 0],
          safetyOffMs,
        );
      }
    }

    if (snap.survivingNotes.length === 0) {
      return;
    }

    const survivingWireAttacks = snap.survivingNotes
      .filter(s => s.emitNoteOn && !s.segmentClosedOnWire)
      .sort((a, b) => a.onPerfMs - b.onPerfMs || a.id - b.id);

    for (let j = 0; j < survivingWireAttacks.length; j += 1) {
      const sAtk = survivingWireAttacks[j];
      const nextSurvivingAtk =
        j + 1 < survivingWireAttacks.length ? survivingWireAttacks[j + 1] : null;

      if (sAtk.queuedOffPerfMs !== null && sAtk.queuedOffPerfMs > nowPerfMs) {
        const reopenedByLaterSurvivor =
          nextSurvivingAtk !== null &&
          (sAtk.intendedOffPerfMs === null ||
            sAtk.intendedOffPerfMs > nextSurvivingAtk.onPerfMs + 1e-6);
        if (!reopenedByLaterSurvivor) {
          sAtk.uncancelledHardwareOffPerfMs = sAtk.queuedOffPerfMs;
          sAtk.releaseAbsoluteStep = null;
        } else {
          sAtk.releaseAbsoluteStep = null;
        }
        this.activeNotes.set(sAtk.id, sAtk);
        continue;
      }

      if (sAtk.queuedOffPerfMs === null) {
        const coveringSurvivors = snap.survivingNotes.filter(
          c =>
            c.uncancelledHardwareOffPerfMs === null &&
            c.onPerfMs <= sAtk.onPerfMs + 1e-6 &&
            (c.intendedOffPerfMs === null || c.intendedOffPerfMs > sAtk.onPerfMs + 1e-6),
        );
        const contributorsForTail =
          coveringSurvivors.length > 0 ? coveringSurvivors : [sAtk];
        const envelope = this.resolveClusterEnvelope(contributorsForTail);
        sAtk.releaseAbsoluteStep = envelope.releaseStep;
        sAtk.tailGrooveOffsetSeconds = envelope.tailGrooveOffsetSeconds;
        if (
          this.shouldQueueClusterTailOffNow(
            sAtk,
            envelope.releaseStep,
            envelope.offPerfMs,
            this.currentTransportStep,
          )
        ) {
          sAtk.queuedOffPerfMs = envelope.offPerfMs;
          if (sAtk.queuedOffPerfMs !== null && sAtk.queuedOffPerfMs > nowPerfMs) {
            this.trySend(
              port,
              [0x80 | (snap.midiChannel - 1), snap.pitch, 0],
              sAtk.queuedOffPerfMs,
            );
          }
        }
        this.activeNotes.set(sAtk.id, sAtk);
      }
    }

    for (const s of snap.survivingNotes) {
      if (!s.segmentClosedOnWire) continue;
      const stillCarriedByOpenSurvivor = survivingWireAttacks.some(
        sAtk =>
          sAtk.uncancelledHardwareOffPerfMs === null &&
          (s.intendedOffPerfMs === null || s.intendedOffPerfMs > sAtk.onPerfMs + 1e-6),
      );
      if (!stillCarriedByOpenSurvivor) {
        this.activeNotes.delete(s.id);
      }
    }
  }

  /**
   * Cleans up a single DAW channel's external MIDI notes (e.g. channel muted,
   * deleted, switched to another MIDI output device/channel, or set to `off`).
   * Strictly isolated: never clears or silences other DAW channels or ports,
   * and recomputes any shared pitch voice's release envelope from surviving
   * contributors only.
   */
  public cleanupChannel(channelId: string): void {
    const nowPerfMs = this.getPerformanceNowMs();
    this.pruneCompletedState(nowPerfMs);
    this.deferredTransportNotes = this.deferredTransportNotes.filter(n => n.channelId !== channelId);
    const channelPendingCcs = this.pendingControlChanges.filter(
      c => c.channelId === channelId && c.perfMs > nowPerfMs,
    );
    this.pendingControlChanges = this.pendingControlChanges.filter(c => c.channelId !== channelId);

    const channelNotes: ActiveMidiOutputNote[] = [];
    for (const active of this.activeNotes.values()) {
      if (active.channelId === channelId) {
        channelNotes.push(active);
      }
    }

    if (channelNotes.length === 0 && channelPendingCcs.length === 0) {
      this.releaseChannelSustainIfExclusive(channelId);
      return;
    }

    interface AffectedVoiceSnapshot {
      outputDeviceId: string;
      midiChannel: number;
      pitch: number;
      removedNotes: ActiveMidiOutputNote[];
      survivingNotes: ActiveMidiOutputNote[];
      previewSurvivors: ActiveMidiOutputNote[];
      wasSoundingAtNow: boolean;
      shouldKeepSoundingAtNow: boolean;
      existingFutureOffs: number[];
      prevQueuedOffById: Map<number, number | null>;
      prevEmitNoteOnById: Map<number, boolean>;
    }

    const voiceMap = new Map<string, AffectedVoiceSnapshot>();
    const affectedPortChannels = new Set<string>();
    const portsUsedByTarget = new Set<string>([
      ...channelNotes.map(n => n.outputDeviceId),
      ...channelPendingCcs.map(c => c.outputDeviceId),
    ]);

    for (const note of channelNotes) {
      affectedPortChannels.add(`${note.outputDeviceId}:${note.midiChannel}`);
      const voiceKey = `${note.outputDeviceId}:${note.midiChannel}:${note.pitch}`;
      if (voiceMap.has(voiceKey)) continue;

      const allVoiceNotes = [...this.activeNotes.values()].filter(
        n =>
          n.outputDeviceId === note.outputDeviceId &&
          n.midiChannel === note.midiChannel &&
          n.pitch === note.pitch,
      );
      const wasSoundingAtNow = allVoiceNotes.some(
        n =>
          n.emitNoteOn &&
          n.onPerfMs <= nowPerfMs &&
          !n.segmentClosedOnWire &&
          (n.queuedOffPerfMs === null || n.queuedOffPerfMs > nowPerfMs),
      );
      const existingFutureOffs = allVoiceNotes
        .filter(n => n.queuedOffPerfMs !== null && n.queuedOffPerfMs > nowPerfMs)
        .map(n => n.queuedOffPerfMs!)
        .sort((a, b) => a - b);

      const removedNotes = allVoiceNotes.filter(n => n.channelId === channelId);
      const survivingNotes: ActiveMidiOutputNote[] = [];
      for (const n of allVoiceNotes) {
        if (n.channelId === channelId) {
          this.activeNotes.delete(n.id);
          continue;
        }
        const expiredOwn = n.intendedOffPerfMs !== null && n.intendedOffPerfMs <= nowPerfMs;
        const expiredHw =
          n.uncancelledHardwareOffPerfMs !== null && n.uncancelledHardwareOffPerfMs <= nowPerfMs;
        if (expiredOwn || expiredHw) {
          this.activeNotes.delete(n.id);
        } else {
          survivingNotes.push(n);
        }
      }

      const shouldKeepSoundingAtNow = survivingNotes.some(s => s.onPerfMs <= nowPerfMs);
      const prevQueuedOffById = new Map<number, number | null>();
      const prevEmitNoteOnById = new Map<number, boolean>();
      for (const s of survivingNotes) {
        prevQueuedOffById.set(s.id, s.queuedOffPerfMs);
        prevEmitNoteOnById.set(s.id, s.emitNoteOn && !s.segmentClosedOnWire);
      }

      const previewSurvivors = survivingNotes.map(s => ({ ...s }));
      if (previewSurvivors.length > 0) {
        this.reconcileVoiceContributors(
          previewSurvivors,
          nowPerfMs,
          this.currentTransportStep,
          null,
          false,
        );
      }

      voiceMap.set(voiceKey, {
        outputDeviceId: note.outputDeviceId,
        midiChannel: note.midiChannel,
        pitch: note.pitch,
        removedNotes,
        survivingNotes,
        previewSurvivors,
        wasSoundingAtNow,
        shouldKeepSoundingAtNow,
        existingFutureOffs,
        prevQueuedOffById,
        prevEmitNoteOnById,
      });
    }

    const portsRequiringClear = new Set<string>();
    const clearedPorts = new Set<string>();

    for (const outputDeviceId of portsUsedByTarget) {
      const targetHadQueuedFutureOnPort =
        channelPendingCcs.some(c => c.outputDeviceId === outputDeviceId && c.perfMs > nowPerfMs) ||
        [...voiceMap.values()].some(
          snap =>
            snap.outputDeviceId === outputDeviceId &&
            snap.removedNotes.some(
              r =>
                (r.emitNoteOn && !r.segmentClosedOnWire && r.onPerfMs > nowPerfMs) ||
                (r.queuedOffPerfMs !== null && r.queuedOffPerfMs > nowPerfMs),
            ),
        );

      const survivingQueueChangedOnPort = [...voiceMap.values()].some(snap => {
        if (snap.outputDeviceId !== outputDeviceId) return false;
        if (snap.survivingNotes.length === 0 && snap.existingFutureOffs.length > 0) {
          return true;
        }
        return snap.previewSurvivors.some(p => {
          const prevOff = snap.prevQueuedOffById.get(p.id) ?? null;
          const prevEmit = snap.prevEmitNoteOnById.get(p.id) ?? false;
          const nextEmit = p.emitNoteOn && !p.segmentClosedOnWire;
          if (p.onPerfMs > nowPerfMs && prevEmit !== nextEmit) {
            return true;
          }
          if (prevOff !== null && prevOff > nowPerfMs) {
            if (p.queuedOffPerfMs === null || Math.abs(p.queuedOffPerfMs - prevOff) > 1e-6) {
              return true;
            }
          }
          return false;
        });
      });

      const siblingHasQueuedFutureOnPort =
        [...this.activeNotes.values()].some(
          other =>
            other.outputDeviceId === outputDeviceId &&
            ((other.emitNoteOn && !other.segmentClosedOnWire && other.onPerfMs > nowPerfMs) ||
              (other.queuedOffPerfMs !== null && other.queuedOffPerfMs > nowPerfMs)),
        ) ||
        this.pendingControlChanges.some(
          c => c.outputDeviceId === outputDeviceId && c.perfMs > nowPerfMs,
        );

      const needsQueueCancellation = targetHadQueuedFutureOnPort || survivingQueueChangedOnPort;
      if (needsQueueCancellation) {
        portsRequiringClear.add(outputDeviceId);
      }

      if (!siblingHasQueuedFutureOnPort || needsQueueCancellation) {
        const port = this.resolveOutputPort(outputDeviceId);
        if (port && typeof port.clear === 'function') {
          try {
            port.clear();
            clearedPorts.add(outputDeviceId);
          } catch {
            // Fall through to honest clear-less fallback below.
          }
        }
      }
    }

    for (const snap of voiceMap.values()) {
      const wasCleared = clearedPorts.has(snap.outputDeviceId);
      const requiredClear = portsRequiringClear.has(snap.outputDeviceId);

      if (wasCleared || !requiredClear) {
        if (snap.survivingNotes.length > 0) {
          this.reconcileVoiceContributors(
            snap.survivingNotes,
            nowPerfMs,
            this.currentTransportStep,
            null,
          );
        }
      }

      const port = this.resolveOutputPort(snap.outputDeviceId);
      if (!port || (port.state ?? 'connected') !== 'connected' || typeof port.send !== 'function') {
        continue;
      }

      if (wasCleared) {
        if (snap.wasSoundingAtNow && !snap.shouldKeepSoundingAtNow) {
          this.trySend(port, [0x80 | (snap.midiChannel - 1), snap.pitch, 0]);
        }
        continue;
      }

      if (!requiredClear) {
        if (snap.wasSoundingAtNow && !snap.shouldKeepSoundingAtNow) {
          this.trySend(port, [0x80 | (snap.midiChannel - 1), snap.pitch, 0]);
        }
        for (const s of snap.survivingNotes) {
          const prevOff = snap.prevQueuedOffById.get(s.id) ?? null;
          if (
            prevOff === null &&
            s.queuedOffPerfMs !== null &&
            s.queuedOffPerfMs > nowPerfMs &&
            s.uncancelledHardwareOffPerfMs === null
          ) {
            this.trySend(
              port,
              [0x80 | (snap.midiChannel - 1), snap.pitch, 0],
              s.queuedOffPerfMs,
            );
          }
        }
        continue;
      }

      this.applyClearlessVoiceCleanup(port, snap, nowPerfMs);
    }

    for (const outputDeviceId of clearedPorts) {
      const port = this.resolveOutputPort(outputDeviceId);
      if (port) {
        this.requeueActivePortEvents(port, outputDeviceId, nowPerfMs);
      }
    }

    this.releaseChannelSustainIfExclusive(channelId);

    for (const portChKey of affectedPortChannels) {
      const [outputDeviceId, chStr] = portChKey.split(':');
      const midiChannel = Number(chStr);
      const siblingActiveOnSamePortChannel =
        [...this.activeNotes.values()].some(
          other => other.outputDeviceId === outputDeviceId && other.midiChannel === midiChannel,
        ) ||
        this.deferredTransportNotes.some(
          d => d.outputDeviceId === outputDeviceId && d.midiChannel === midiChannel,
        );
      if (!siblingActiveOnSamePortChannel) {
        const port = this.resolveOutputPort(outputDeviceId);
        if (port && (port.state ?? 'connected') === 'connected' && typeof port.send !== 'function') {
          continue;
        }
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

    for (const active of this.activeNotes.values()) {
      if (
        active.isTransportNote &&
        active.intendedReleaseStep !== null &&
        active.intendedOffPerfMs !== null &&
        active.intendedOffPerfMs > nowPerfMs
      ) {
        if (active.onPerfMs <= nowPerfMs) {
          const remainingOwnMs = (active.intendedOffPerfMs - nowPerfMs) * ratio;
          active.intendedOffPerfMs = Math.max(
            active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
            nowPerfMs + remainingOwnMs,
          );
        } else {
          const ownSpanMs = (active.intendedOffPerfMs - active.onPerfMs) * ratio;
          active.intendedOffPerfMs = Math.max(
            active.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS,
            active.onPerfMs + ownSpanMs,
          );
        }
      }
    }

    const affectedPorts = new Set<string>();
    for (const active of this.activeNotes.values()) {
      if (
        active.isTransportNote &&
        active.releaseAbsoluteStep !== null &&
        active.queuedOffPerfMs !== null &&
        active.queuedOffPerfMs > nowPerfMs
      ) {
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
      if (active.queuedOffPerfMs !== null && active.queuedOffPerfMs > nowPerfMs) {
        let retimedOffMs = active.queuedOffPerfMs;
        if (active.isTransportNote && active.releaseAbsoluteStep !== null) {
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
        // the horizon; otherwise re-queue the retimed Note Off chronologically.
        if (
          active.isTransportNote &&
          active.releaseAbsoluteStep !== null &&
          retimedOffMs > nowPerfMs + nextStepMs * 1.5
        ) {
          active.queuedOffPerfMs = null;
        } else {
          active.queuedOffPerfMs = retimedOffMs;
        }
      }
    }

    for (const outputDeviceId of clearedPorts) {
      const port = this.resolveUsablePort(outputDeviceId);
      if (port) {
        this.requeueActivePortEvents(port, outputDeviceId, nowPerfMs);
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
    this.lastTransportStep = null;
    this.deferredTransportNotes = [];
    this.pendingControlChanges = [];
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
    const wireNotesToClean = notesToClean
      .filter(n => n.emitNoteOn && !n.segmentClosedOnWire)
      .sort((a, b) => a.onPerfMs - b.onPerfMs || a.id - b.id);
    for (let k = 0; k < wireNotesToClean.length; k += 1) {
      const note = wireNotesToClean[k];
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
      } else if (note.queuedOffPerfMs === null || note.queuedOffPerfMs <= note.onPerfMs + 1e-6) {
        const nextSameVoice = wireNotesToClean
          .slice(k + 1)
          .find(
            other =>
              other.outputDeviceId === note.outputDeviceId &&
              other.midiChannel === note.midiChannel &&
              other.pitch === note.pitch,
          );
        const defaultSafetyOffMs = note.onPerfMs + MIN_MIDI_NOTE_OFF_DELTA_MS;
        const safetyOffMs =
          nextSameVoice !== undefined && nextSameVoice.onPerfMs < defaultSafetyOffMs
            ? (note.onPerfMs + nextSameVoice.onPerfMs) * 0.5
            : defaultSafetyOffMs;
        this.trySend(port, [0x80 | (note.midiChannel - 1), note.pitch, 0], safetyOffMs);
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
    // Do not let playback or control changes race ahead of reconnect cleanup
    // or bypass a sticky fail-closed capacity quarantine.
    if (this.disconnectedPortRecoveries.has(outputDeviceId) || this.isRecoveryCapacityBlocked(outputDeviceId)) return null;
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
      this.rememberRecentMidiVoice(port, data, timestampMs);
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
    this.pruneRecentMidiVoiceRecoveryCandidates(nowPerfMs);
    for (const [id, note] of [...this.activeNotes.entries()]) {
      if (
        note.uncancelledHardwareOffPerfMs !== null &&
        note.uncancelledHardwareOffPerfMs <= nowPerfMs &&
        note.queuedOffPerfMs !== null &&
        note.queuedOffPerfMs <= nowPerfMs
      ) {
        this.activeNotes.delete(id);
        continue;
      }
      if (note.queuedOffPerfMs !== null && note.queuedOffPerfMs <= nowPerfMs) {
        if (note.intendedOffPerfMs !== null && note.intendedOffPerfMs <= nowPerfMs) {
          this.activeNotes.delete(id);
        } else {
          note.segmentClosedOnWire = true;
          note.queuedOffPerfMs = null;
          note.releaseAbsoluteStep = null;
        }
      }
    }

    for (const [id, note] of [...this.activeNotes.entries()]) {
      if (note.intendedOffPerfMs === null || note.intendedOffPerfMs > nowPerfMs) {
        continue;
      }
      if (note.segmentClosedOnWire) {
        this.activeNotes.delete(id);
        continue;
      }
      // `note` was carrying the open physical segment of an overlapping cluster
      // past its own `intendedOffPerfMs` on behalf of a longer contributor.
      let carrier: ActiveMidiOutputNote | null = null;
      for (const other of this.activeNotes.values()) {
        if (
          other.id !== note.id &&
          other.outputDeviceId === note.outputDeviceId &&
          other.midiChannel === note.midiChannel &&
          other.pitch === note.pitch &&
          other.uncancelledHardwareOffPerfMs === null &&
          other.onPerfMs <= nowPerfMs &&
          (other.intendedOffPerfMs === null || other.intendedOffPerfMs > nowPerfMs)
        ) {
          if (carrier === null || other.onPerfMs > carrier.onPerfMs || other.id > carrier.id) {
            carrier = other;
          }
        }
      }
      if (carrier !== null) {
        carrier.emitNoteOn = true;
        carrier.segmentClosedOnWire = false;
        carrier.releaseAbsoluteStep = note.releaseAbsoluteStep;
        carrier.tailGrooveOffsetSeconds = note.tailGrooveOffsetSeconds;
        carrier.queuedOffPerfMs = note.queuedOffPerfMs;
        this.activeNotes.delete(id);
      } else if (note.queuedOffPerfMs !== null && note.queuedOffPerfMs <= nowPerfMs) {
        this.activeNotes.delete(id);
      }
    }

    if (this.pendingControlChanges.length > 0) {
      this.pendingControlChanges = this.pendingControlChanges.filter(c => c.perfMs > nowPerfMs);
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
