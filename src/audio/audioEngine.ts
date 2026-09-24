import { 
  Channel, 
  Note, 
  MixerTrack, 
  FxSlot, 
  PlaylistClip, 
  PlaylistTrack,
  SynthParameters,
  AudioRecording,
  GrossBeatState,
  SidechainSettings
} from '../types/daw';
import { AudioClockTransport, TransportState } from './transport';
import { ChorusEffect } from './effects/ChorusEffect';
import { WetDryEffect } from './effects/WetDryEffect';
import { createInstrumentRegistry, InstrumentRegistry, InstrumentVoiceHandle } from './instrumentRegistry';
import { renderIndependentPluckVoice } from './instruments/independentPluck';
import { renderSubtractiveSynthVoice } from './instruments/subtractiveSynth';
import { renderFmSynthVoice } from './instruments/fmSynth';
import { renderSamplerVoice } from './instruments/sampler';
import { renderDrumPadVoice } from './instruments/drumPad';
import { renderGrandPianoVoice, renderRhodesVoice, renderOrganVoice, renderPluckedGuitarVoice, renderStringsVoice, renderPizzicatoVoice, renderBrassVoice, renderMarimbaVoice } from './instruments/legacyAcoustic';
import { renderAcid303Voice, renderReeseBassVoice, render808SubVoice, renderSupersawVoice, renderAmbientPadVoice, renderVoxChoirVoice, renderChiptuneVoice } from './instruments/legacySynth';

export type MidiEventPayload = {
  type: 'noteOn' | 'noteOff' | 'cc' | 'pitchBend';
  note?: number;
  velocity?: number;
  cc?: number;
  value?: number;
  midiChannel?: number;
};

export interface InternalMidiMessageEvent {
  data: Uint8Array | number[];
}

interface WindowWithWebKitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
}

interface ChainedAudioNode extends AudioNode {
  _chainEnd?: AudioNode;
}

function setChainEnd<T extends AudioNode>(node: T, chainEnd: AudioNode): T {
  (node as ChainedAudioNode)._chainEnd = chainEnd;
  return node;
}

function getChainEnd(node: AudioNode): AudioNode {
  return (node as ChainedAudioNode)._chainEnd ?? node;
}

export type OfflineRenderScope = 'song' | 'pattern';
export type OfflineRenderProgress = (progress: number, status: string) => void;

/**
 * Project-owned data that the live scheduler is allowed to receive while a
 * playback take is running. The engine deliberately does not accept the
 * complete React state object: these are the only collections consumed by
 * real-time playback and each is cloned at the synchronization boundary.
 */
export interface PlaybackStateUpdate {
  channels?: Channel[];
  clips?: PlaylistClip[];
  mixerTracks?: MixerTrack[];
  /**
   * Playlist lane rows whose `mute` flag belongs to the live take. A muted lane
   * silences the pattern and audio clips placed on it without touching the
   * mixer insert they route to, so lanes sharing an insert stay independent.
   */
  playlistTracks?: PlaylistTrack[];
  /**
   * Declared `Pattern.lengthSteps` of the pattern Pattern Mode is playing. It is
   * project state like the collections above, so a 16 <-> 32 length change made
   * while the transport runs moves the loop boundary of the active take instead
   * of waiting for a restart. Song Mode ignores it (bar-grid scheduling).
   */
  patternLengthSteps?: number;
}

export interface MixerChannel {
  input: GainNode;
  output: GainNode;
  duckingGain: GainNode;
  panner: StereoPannerNode | GainNode;
  analyser: AnalyserNode;
  fxNodes: AudioNode[];
  sidechain?: SidechainSettings;
}

const isPlaybackRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Playback automation mutates the isolated active channel/mixer objects. To
 * merge a project edit without erasing those transient values, compare the
 * incoming project value with the last project value received by playback:
 * unchanged project fields keep their active value, while changed fields are
 * copied in. This keeps project edits authoritative without ever sharing a
 * project object with the renderer.
 */
const playbackValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => playbackValuesEqual(value, right[index]));
  }
  if (isPlaybackRecord(left) || isPlaybackRecord(right)) {
    if (!isPlaybackRecord(left) || !isPlaybackRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && playbackValuesEqual(left[key], right[key]));
  }
  return false;
};

/**
 * Phase 10B: a per-track edit where the only field that changed is a subset of
 * `slot.mix` values for previously-known, enabled slots. Used during a live
 * take to skip the full FX chain rebuild and route the new mix directly to
 * the live WetDry wrapper. Any structural change (new slot, removed slot,
 * enabled/disabled change, params change, channel volume/pan/mute/routing)
 * returns `false` so the safe fall-back (a full rebuild via
 * `updateMixerTrack`) handles it instead.
 */
interface TrackMixDiff {
  onlyMixChanged: boolean;
  mixChanges: Array<{ slotId: string; mix: number }>;
}

function trackOnlyMixChanged(previous: MixerTrack, next: MixerTrack): TrackMixDiff {
  const mixChanges: Array<{ slotId: string; mix: number }> = [];
  if (previous.id !== next.id) return { onlyMixChanged: false, mixChanges };
  if (previous.fxSlots.length !== next.fxSlots.length) return { onlyMixChanged: false, mixChanges };
  const previousById = new Map(previous.fxSlots.map(slot => [slot.id, slot]));
  for (const nextSlot of next.fxSlots) {
    const prevSlot = previousById.get(nextSlot.id);
    if (!prevSlot) return { onlyMixChanged: false, mixChanges };
    if (prevSlot.type !== nextSlot.type) return { onlyMixChanged: false, mixChanges };
    if (prevSlot.enabled !== nextSlot.enabled) return { onlyMixChanged: false, mixChanges };
    if (!playbackValuesEqual(prevSlot.params, nextSlot.params)) return { onlyMixChanged: false, mixChanges };
    if (prevSlot.mix !== nextSlot.mix) {
      mixChanges.push({ slotId: nextSlot.id, mix: nextSlot.mix });
    }
  }
  const topLevelKeys: ReadonlyArray<keyof MixerTrack> = ['name', 'color', 'volume', 'pan', 'mute', 'solo', 'stereoWidth', 'peakL', 'peakR', 'sidechain', 'routingTargetId', 'sends'];
  const optionalKeys = ['height', 'armedForRecord'];
  for (const key of optionalKeys) {
    if (!playbackValuesEqual((previous as any)[key], (next as any)[key])) {
      return { onlyMixChanged: false, mixChanges };
    }
  }
  for (const key of topLevelKeys) {
    if (!playbackValuesEqual((previous as any)[key], (next as any)[key])) {
      return { onlyMixChanged: false, mixChanges };
    }
  }
  return { onlyMixChanged: mixChanges.length > 0, mixChanges };
}

const mergePlaybackProjectEdits = (
  activeValue: unknown,
  previousProjectValue: unknown,
  nextProjectValue: unknown
): unknown => {
  if (playbackValuesEqual(nextProjectValue, previousProjectValue)) return activeValue;

  if (isPlaybackRecord(activeValue) && isPlaybackRecord(previousProjectValue) && isPlaybackRecord(nextProjectValue)) {
    const merged = structuredClone(activeValue) as Record<string, unknown>;
    const keys = new Set([...Object.keys(previousProjectValue), ...Object.keys(nextProjectValue)]);

    for (const key of keys) {
      const hadPreviousValue = Object.prototype.hasOwnProperty.call(previousProjectValue, key);
      const hasNextValue = Object.prototype.hasOwnProperty.call(nextProjectValue, key);
      if (!hasNextValue) {
        if (hadPreviousValue) delete merged[key];
        continue;
      }
      if (!hadPreviousValue) {
        merged[key] = structuredClone(nextProjectValue[key]);
        continue;
      }
      if (playbackValuesEqual(nextProjectValue[key], previousProjectValue[key])) continue;

      merged[key] = mergePlaybackProjectEdits(
        activeValue[key],
        previousProjectValue[key],
        nextProjectValue[key]
      );
    }
    return merged;
  }

  return structuredClone(nextProjectValue);
};

/**
 * Deterministic PRNG used by the offline reverb-impulse generator.
 *
 * `Math.random()` is non-seeded, so an offline convolution reverb would produce
 * a different tail on every export and the regression suite could not detect a
 * DSP regression from a sample mismatch. A small linear congruential generator
 * is sufficient for an impulse response: only amplitude distribution matters,
 * and any reproducible noise source with reasonable autocorrelation works.
 */
function createSeededRandom(seed: number): () => number {
  // Park-Miller LCG constants: a well-known deterministic 31-bit PRNG.
  const a = 16807;
  const m = 2147483647;
  let state = Math.abs(Math.floor(seed)) % m;
  if (state === 0) state = 1;
  return () => {
    state = (a * state) % m;
    return (state - 1) / (m - 1);
  };
}

export function resolvePlayableContentLengthSteps(
  channel?: Channel,
  patternLengthSteps?: number
): number {
  const STEPS_PER_BAR = 16;
  if (!channel) {
    const fallback = typeof patternLengthSteps === 'number' && Number.isFinite(patternLengthSteps) && patternLengthSteps > 0
      ? Math.max(1, Math.ceil(patternLengthSteps / STEPS_PER_BAR)) * STEPS_PER_BAR
      : STEPS_PER_BAR;
    return fallback;
  }

  let maxStep = 0;

  if (typeof patternLengthSteps === 'number' && Number.isFinite(patternLengthSteps) && patternLengthSteps > 0) {
    maxStep = Math.max(maxStep, patternLengthSteps);
  }

  if (Array.isArray(channel.steps) && channel.steps.length > 0) {
    maxStep = Math.max(maxStep, channel.steps.length);
  }

  if (Array.isArray(channel.notes) && channel.notes.length > 0) {
    for (const note of channel.notes) {
      if (typeof note.start === 'number' && Number.isFinite(note.start) && note.start >= 0) {
        const duration = (typeof note.duration === 'number' && Number.isFinite(note.duration) && note.duration > 0)
          ? note.duration
          : 1;
        maxStep = Math.max(maxStep, note.start + duration);
      }
    }
  }

  const bars = Math.max(1, Math.ceil(maxStep / STEPS_PER_BAR));
  return bars * STEPS_PER_BAR;
}

/**
 * Pattern Mode loops over the declared length of the pattern that is playing.
 *
 * `Pattern.lengthSteps` is authoritative when supplied: channel data may be
 * longer because reducing a pattern length intentionally preserves hidden steps
 * and piano-roll notes, but those events are ignored until the declared length
 * is extended again. This gives an exact 0..15 -> 0 or 0..31 -> 0 boundary and
 * prevents a padded `Channel.steps` array from silently overriding the pattern.
 *
 * The content-derived branch is the compatibility fallback for legacy/internal
 * callers that do not have a Pattern model. Song Mode is unaffected and still
 * resolves each playlist channel's content length directly.
 */
export function resolvePatternLoopLengthSteps(
  channels: Channel[],
  patternLengthSteps?: number
): number {
  if (typeof patternLengthSteps === 'number' && Number.isFinite(patternLengthSteps) && patternLengthSteps > 0) {
    return resolvePlayableContentLengthSteps(undefined, patternLengthSteps);
  }

  let loopLengthSteps = resolvePlayableContentLengthSteps();
  for (const channel of channels) {
    loopLengthSteps = Math.max(loopLengthSteps, resolvePlayableContentLengthSteps(channel));
  }
  return loopLengthSteps;
}

class AudioEngine {
  public isOfflineRendering = false;
  private liveCtx: AudioContext | null = null;
  private ctx: AudioContext | null = null;
  private transport: AudioClockTransport | null = null;
  private playbackGeneration = 0;
  private masterGain: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private grossBeatNode: GainNode | null = null;
  private mixerChannels: Map<number, MixerChannel> = new Map();

  private grossBeatState: GrossBeatState = {
    enabled: false,
    preset: 'half_time',
    mix: 1.0,
    speed: 0.5,
    tapeStopActive: false,
    tapeStopDurationMs: 600,
    gateSteps: [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false],
    pitchShiftSemitones: -12
  };

  private activeVoices: Map<string, { stop: (time?: number) => void }> = new Map();
  /** Renderer handles currently participating in drum-pad choke groups. */
  private activeDrumPadVoices: Map<number, Map<string, InstrumentVoiceHandle>> = new Map();
  /** Buffer sources of the active take's playlist audio; cancelled by stop/pause/seek. */
  private activeClipSources: Set<AudioBufferSourceNode> = new Set();
  /** Playlist lane row each active clip source was started from, so a live lane mute can cancel exactly that lane's audio. */
  private activeClipSourceLanes: Map<AudioBufferSourceNode, number> = new Map();
  /** Playlist lane rows muted for the active take; enforced before clips reach their mixer insert. */
  private playlistLaneMutes: Set<number> = new Set();
  private sampleBuffers: Map<string, AudioBuffer> = new Map();
  private impulseResponses: Map<string, AudioBuffer> = new Map();
  private readonly instrumentRegistry: InstrumentRegistry;

  // Recording
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingAnalyser: AnalyserNode | null = null;

  // MIDI
  private midiAccess: MIDIAccess | null = null;
  private midiListeners: ((e: MidiEventPayload) => void)[] = [];

  constructor() {
    // All built-in voices now enter through one registry boundary. The voice
    // implementations remain unchanged; this phase separates dispatch from
    // audio generation so a future external instrument can implement the same
    // contract without another growing instrumentType switch.
    this.instrumentRegistry = createInstrumentRegistry({
      drumpad: renderDrumPadVoice,
      fmsynth: renderFmSynthVoice,
      fm_bell: renderFmSynthVoice,
      grand_piano: renderGrandPianoVoice,
      rhodes_epiano: renderRhodesVoice,
      hammond_organ: renderOrganVoice,
      nylon_guitar: renderPluckedGuitarVoice,
      harpsichord: renderPluckedGuitarVoice,
      strings_ensemble: renderStringsVoice,
      pizzicato_strings: renderPizzicatoVoice,
      cinematic_brass: renderBrassVoice,
      acid_303: renderAcid303Voice,
      reese_bass: renderReeseBassVoice,
      slap_bass: renderReeseBassVoice,
      sub_808: render808SubVoice,
      supersaw_lead: renderSupersawVoice,
      ambient_pad: renderAmbientPadVoice,
      vox_choir: renderVoxChoirVoice,
      marimba_bell: renderMarimbaVoice,
      chiptune_8bit: renderChiptuneVoice,
      independent_pluck: renderIndependentPluckVoice,
      minisynth: renderSubtractiveSynthVoice,
      wavetable: renderSubtractiveSynthVoice,
      sampler: renderSamplerVoice,
    }, renderSubtractiveSynthVoice);
  }

  public init() {
    if (this.isOfflineRendering) return;
    const isOffline = this.ctx && (typeof (this.ctx as any).startRendering === 'function' || (typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext));
    if (this.ctx && this.ctx.state !== 'closed') {
      if (!isOffline && this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioContextClass = window.AudioContext || (window as unknown as WindowWithWebKitAudio).webkitAudioContext;
    this.ctx = new AudioContextClass({ latencyHint: 'interactive' });

    // Master bus with Time FX processor
    this.masterGain = this.ctx.createGain();
    this.grossBeatNode = this.ctx.createGain();
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.smoothingTimeConstant = 0.8;

    this.masterGain.connect(this.grossBeatNode);
    this.grossBeatNode.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    // Build default reverb impulse response
    this.buildReverbImpulse(2.5, 2.0);

    // Initialize default mixer tracks (0 to 8)
    for (let i = 0; i <= 8; i++) {
      this.getOrCreateMixerChannel(i);
    }

    this.transport = new AudioClockTransport(this.ctx);

    // Init Web MIDI
    this.initMidi();
  }

  public getContext(): AudioContext {
    if (this.isOfflineRendering && this.ctx) {
      return this.ctx;
    }
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as unknown as WindowWithWebKitAudio).webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    const isOffline = typeof (this.ctx as any).startRendering === 'function' || (typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext);
    if (!isOffline && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public getSampleBuffer(id: string): AudioBuffer | undefined {
    return this.sampleBuffers.get(id);
  }

  public setSampleBuffer(id: string, buffer: AudioBuffer): void {
    this.sampleBuffers.set(id, buffer);
  }

  /** Ids of every audio asset currently registered in memory (recordings, imports, drops, bounces, hydrated assets). */
  public getSampleBufferIds(): string[] {
    return [...this.sampleBuffers.keys()];
  }

  private buildReverbImpulse(duration: number, decay: number, options?: { seed?: number }) {
    if (!this.ctx) return;
    const rate = this.ctx.sampleRate;
    const length = rate * duration;
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    // Offline renders must produce a byte-identical WAV for the same project
    // (regression coverage depends on that — see `src/audio/exportParity.test.ts`).
    // Math.random() would change the convolution tail between exports, so the
    // renderer is the only offline caller and supplies an explicit seed. The
    // live engine keeps its existing seeded RNG behaviour.
    const seed = options?.seed;
    const rng = typeof seed === 'number' ? createSeededRandom(seed) : Math.random;

    for (let i = 0; i < length; i++) {
      const n = i / length;
      const factor = Math.pow(1 - n, decay);
      left[i] = (rng() * 2 - 1) * factor;
      right[i] = (rng() * 2 - 1) * factor;
    }
    this.impulseResponses.set('default', impulse);
  }

  /**
   * A clip is lane-muted when its playlist row is muted. Lane mute is enforced
   * at the trigger boundary — before the clip reaches its routed mixer insert —
   * so muting one lane can never silence another lane or a channel that shares
   * the same insert.
   *
   * `laneMutes` is the project-derived mute set; passing an empty set makes
   * the check branch-free so callers in the hot path don't pay for the
   * row-lookup when the project has no muted lanes.
   */
  private isClipPlaylistLaneMuted(clip: PlaylistClip, laneMutes: Set<number>): boolean {
    if (laneMutes.size === 0) return false;
    if (!Number.isFinite(clip.trackIndex)) return false;
    return laneMutes.has(Math.floor(clip.trackIndex));
  }

  public getOrCreateMixerChannel(trackId: number) {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;

    if (this.mixerChannels.has(trackId)) {
      return this.mixerChannels.get(trackId)!;
    }

    const input = ctx.createGain();
    const output = ctx.createGain();
    const duckingGain = ctx.createGain();
    const panner: StereoPannerNode | GainNode = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;

    // Connect input -> panner -> duckingGain -> output -> analyser
    input.connect(panner);
    panner.connect(duckingGain);
    duckingGain.connect(output);
    output.connect(analyser);

    if (trackId === 0) {
      // Master channel routes to masterGain
      output.connect(this.masterGain!);
    } else {
      // Insert tracks route to master channel input (track 0)
      const masterChannel = this.getOrCreateMixerChannel(0);
      output.connect(masterChannel.input);
    }

    const channelObj: MixerChannel = {
      input,
      output,
      duckingGain,
      panner,
      analyser,
      fxNodes: [] as AudioNode[],
    };

    this.mixerChannels.set(trackId, channelObj);
    return channelObj;
  }

  public hasMixerChannel(trackId: number): boolean {
    return this.mixerChannels.has(trackId);
  }

  public removeMixerChannel(trackId: number): void {
    if (trackId === 0) return; // Master track must never be disconnected or removed

    const channel = this.mixerChannels.get(trackId);
    if (!channel) return;

    try {
      channel.input.disconnect();
    } catch (_) {}

    channel.fxNodes.forEach(node => {
      try {
        node.disconnect();
      } catch (_) {}
    });
    channel.fxNodes = [];

    try {
      channel.panner.disconnect();
    } catch (_) {}

    try {
      channel.duckingGain.disconnect();
    } catch (_) {}

    try {
      channel.output.disconnect();
    } catch (_) {}

    try {
      channel.analyser.disconnect();
    } catch (_) {}

    this.mixerChannels.delete(trackId);
  }

  public updateMixerTrack(track: MixerTrack) {
    const channel = this.getOrCreateMixerChannel(track.id);
    if (!this.ctx) return;

    channel.sidechain = track.sidechain;

    const now = this.ctx.currentTime;
    const targetVol = track.mute ? 0 : track.volume;
    channel.output.gain.setTargetAtTime(targetVol, now, 0.02);

    if ('pan' in channel.panner && channel.panner.pan) {
      channel.panner.pan.setTargetAtTime(track.pan, now, 0.02);
    }

    // Update FX chain if any
    this.rebuildTrackFxChain(track);
  }

  public rebuildTrackFxChain(track: MixerTrack) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const channel = this.getOrCreateMixerChannel(track.id);

    // Disconnect existing FX
    channel.input.disconnect();
    channel.fxNodes.forEach(node => node.disconnect());
    channel.fxNodes = [];

    let currentSource: AudioNode = channel.input;

    track.fxSlots.forEach(slot => {
      if (!slot.enabled) return;

      const fxNode = this.createFxNode(slot);
      if (fxNode) {
        currentSource.connect(fxNode);
        const chainEnd = getChainEnd(fxNode);
        currentSource = chainEnd;
        channel.fxNodes.push(fxNode);
        if (chainEnd !== fxNode) channel.fxNodes.push(chainEnd);
      }
    });

    currentSource.connect(channel.panner);
  }

  private createFxNode(slot: FxSlot): AudioNode | null {
    if (!this.ctx) return null;
    const ctx = this.ctx;

    switch (slot.type) {
      case 'equalizer': {
        // 3-band EQ: Lowshelf, Peaking, Highshelf
        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = Number(slot.params.lowFreq || 120);
        low.gain.value = Number(slot.params.lowGain || 0);

        const mid = ctx.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = Number(slot.params.midFreq || 1200);
        mid.gain.value = Number(slot.params.midGain || 0);
        mid.Q.value = Number(slot.params.midQ || 1.2);

        const high = ctx.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = Number(slot.params.highFreq || 6500);
        high.gain.value = Number(slot.params.highGain || 0);

        low.connect(mid);
        mid.connect(high);

        // Return container wrapper object
        setChainEnd(low, high);
        return low;
      }
      case 'distortion': {
        const waveshaper = ctx.createWaveShaper();
        const drive = Number(slot.params.drive || 20);
        const curve = new Float32Array(512);
        const deg = Math.PI / 180;
        const k = typeof drive === 'number' ? drive : 20;
        for (let i = 0; i < 512; ++i) {
          const x = (i * 2) / 512 - 1;
          curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
        }
        waveshaper.curve = curve;
        waveshaper.oversample = '4x';
        return waveshaper;
      }
      case 'compressor': {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = Number(slot.params.threshold || -18);
        comp.knee.value = Number(slot.params.knee || 24);
        comp.ratio.value = Number(slot.params.ratio || 4);
        comp.attack.value = Number(slot.params.attack || 0.005);
        comp.release.value = Number(slot.params.release || 0.15);
        return comp;
      }
      case 'delay': {
        const delay = ctx.createDelay();
        delay.delayTime.value = Number(slot.params.time || 0.35);
        const feedback = ctx.createGain();
        feedback.gain.value = Number(slot.params.feedback || 0.45);
        delay.connect(feedback);
        feedback.connect(delay);
        return delay;
      }
      case 'reverb': {
        const convolver = ctx.createConvolver();
        const impulse = this.impulseResponses.get('default');
        if (impulse) {
          convolver.buffer = impulse;
        }
        return convolver;
      }
      case 'bitcrusher': {
        const waveshaper = ctx.createWaveShaper();
        const bits = Number(slot.params.bits || 4);
        const steps = Math.pow(2, bits);
        const curve = new Float32Array(512);
        for (let i = 0; i < 512; i++) {
          const x = (i * 2) / 512 - 1;
          curve[i] = Math.round(x * steps) / steps;
        }
        waveshaper.curve = curve;
        return waveshaper;
      }
      case 'limiter': {
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -0.5;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.05;
        return limiter;
      }
      case 'tape_saturation': {
        // Vintage Analog Tape & Tube Saturation Unit
        const drive = Number(slot.params.drive || 35);
        const warmth = Number(slot.params.warmth || 0.8);
        const flutter = Number(slot.params.flutter || 0.001);

        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        const k = drive * 0.1;
        for (let i = 0; i < 1024; i++) {
          const x = (i * 2) / 1024 - 1;
          // Soft asymmetric saturation curve mimicking triode tube & analog tape compression
          curve[i] = Math.tanh(x * (1 + k)) * (1 - 0.1 * Math.sin(Math.PI * x));
        }
        shaper.curve = curve;
        shaper.oversample = '4x';

        // Tape head warmth filter (soft roll-off above 16kHz)
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 16000 - (warmth * 4000);
        filter.Q.value = 0.7;

        shaper.connect(filter);
        setChainEnd(shaper, filter);
        return shaper;
      }
      case 'gross_beat': {
        const gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;
        return gainNode;
      }
      case 'chorus': {
        // Phase 10C-B: defensive parity with liveFxChainHardening.createEffect.
        // The hardening patch installed at app init already routes both live
        // and offline FX chains through that factory, so `createFxNode` is
        // currently a dead path. Wiring chorus here guarantees the legacy
        // single-switch factory can never silently drop a chorus slot if a
        // future refactor bypasses the patch (or if the patch is uninstalled
        // for any reason). The full wet/dry wrapping matches the live path so
        // a slot.mix change and the chorus modulation behavior are identical
        // between the two factories.
        const rate = Math.max(0.05, Math.min(20, Number(slot.params.rate ?? 1.2) || 1.2));
        const delaySec = Math.max(0.005, Math.min(0.08, Number(slot.params.delay ?? 0.02) || 0.02));
        const depthSec = Math.max(0, Math.min(Math.min(0.02, delaySec), Number(slot.params.depth ?? 0.003) || 0));
        const mix = Math.max(0, Math.min(1, Number(slot.mix) || 0));
        const chorus = new ChorusEffect(ctx, slot.id, rate, depthSec, delaySec, 1);
        const wrapper = new WetDryEffect(ctx, chorus, mix);
        setChainEnd(wrapper.input, wrapper.output);
        return wrapper.input;
      }
      default:
        return null;
    }
  }

  // Instrument sound triggers
  public playNote(channel: Channel, note: Note, startTime?: number, bpm: number = 120) {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    const time = startTime ?? ctx.currentTime;

    // Check if arpeggiator is enabled on this channel
    if (channel.arp && channel.arp.enabled) {
      this.playArpSequence(channel, note, time, bpm);
      return;
    }

    this.playSingleVoice(channel, note, time);
  }

  public playSingleVoice(channel: Channel, note: Note, time: number) {
    if (!this.ctx) return;
    const mixerChannel = this.getOrCreateMixerChannel(channel.mixerTrackId);
    const voiceId = `${channel.id}-${note.pitch}-${Math.random()}`;

    // Trigger Dynamic Sidechain Ducking on receiving tracks
    this.triggerSidechainDucking(channel.mixerTrackId, time);

    let voiceHandle: InstrumentVoiceHandle | void;
    const onEnded = () => {
      if (voiceHandle && this.activeVoices.get(voiceId) === voiceHandle) {
        this.activeVoices.delete(voiceId);
      }
      this.removeDrumPadChokeVoice(voiceId, voiceHandle);
    };

    const pad = channel.instrumentType === 'drumpad'
      ? channel.drumPads?.find(candidate => candidate.note === note.pitch)
      : undefined;
    const chokeGroup = pad?.chokeGroup || 0;
    const sampledDrumPadBuffer = pad?.sampleId
      ? this.sampleBuffers.get(pad.sampleId)
      : undefined;
    const canChokeDrumPad =
      channel.instrumentType === 'drumpad' &&
      Boolean(pad?.sampleId) &&
      Boolean(sampledDrumPadBuffer) &&
      chokeGroup > 0;

    const renderer = channel.instrumentType === 'drumpad'
      ? this.instrumentRegistry.get('drumpad')
      : channel.customSample && channel.customSample.id
        ? this.instrumentRegistry.get('sampler')
        : this.instrumentRegistry.get(channel.instrumentType);

    let rendererFailed = false;
    try {
      voiceHandle = renderer({
        channel,
        note,
        time,
        destination: mixerChannel.input,
        audioContext: this.ctx!,
        voiceId,
        onEnded,
        getSampleBuffer: (id) => this.sampleBuffers.get(id),
      });
    } catch (error) {
      rendererFailed = true;
      console.error('[AudioEngine] Instrument renderer failed', {
        instrumentType: channel.instrumentType,
        voiceId,
        error,
      });
    }

    if (rendererFailed) return;

    if (!voiceHandle && (channel.customSample?.id || channel.instrumentType === 'sampler')) {
      // Preserve the pre-22C sampler behavior: an unavailable custom sample,
      // and a sampler channel without a sample, both fall back to subtractive synthesis.
      try {
        voiceHandle = renderSubtractiveSynthVoice({
          channel,
          note,
          time,
          destination: mixerChannel.input,
          audioContext: this.ctx!,
          voiceId,
          onEnded,
        });
      } catch (error) {
        console.error('[AudioEngine] Sampler fallback renderer failed', {
          instrumentType: channel.instrumentType,
          voiceId,
          error,
        });
        return;
      }
    }

    if (
      voiceHandle &&
      (typeof voiceHandle !== 'object' || typeof voiceHandle.stop !== 'function')
    ) {
      console.error('[AudioEngine] Instrument renderer returned an invalid voice handle', {
        instrumentType: channel.instrumentType,
        voiceId,
      });
      return;
    }

    if (!voiceHandle) return;

    if (canChokeDrumPad) {
      this.stopDrumPadChokeGroup(chokeGroup, time);
    }

    this.activeVoices.set(voiceId, voiceHandle);
    if (canChokeDrumPad && chokeGroup > 0) {
      const voices = this.activeDrumPadVoices.get(chokeGroup) || new Map<string, InstrumentVoiceHandle>();
      voices.set(voiceId, voiceHandle);
      this.activeDrumPadVoices.set(chokeGroup, voices);
    }
  }

  private stopDrumPadChokeGroup(group: number, time: number) {
    const voices = this.activeDrumPadVoices.get(group);
    if (!voices) return;

    for (const [voiceId, handle] of voices) {
      try {
        handle.stop(time);
      } catch (_) {}
      if (this.activeVoices.get(voiceId) === handle) {
        this.activeVoices.delete(voiceId);
      }
    }
    this.activeDrumPadVoices.delete(group);
  }

  private removeDrumPadChokeVoice(
    voiceId: string,
    handle: InstrumentVoiceHandle | void,
  ) {
    if (!handle) return;

    for (const [group, voices] of this.activeDrumPadVoices) {
      if (voices.get(voiceId) !== handle) continue;
      voices.delete(voiceId);
      if (voices.size === 0) {
        this.activeDrumPadVoices.delete(group);
      }
      break;
    }
  }
  // Real-Time Arpeggiator & Euclidean Rhythm Engine
  public generateEuclideanPattern(steps: number = 16, hits: number = 5, rotate: number = 0): boolean[] {
    const pattern = new Array(steps).fill(false);
    if (hits <= 0) return pattern;
    if (hits >= steps) return new Array(steps).fill(true);
    let bucket = 0;
    for (let i = 0; i < steps; i++) {
      bucket += hits;
      if (bucket >= steps) {
        bucket -= steps;
        pattern[i] = true;
      }
    }
    if (rotate > 0) {
      const rot = rotate % steps;
      return [...pattern.slice(steps - rot), ...pattern.slice(0, steps - rot)];
    }
    return pattern;
  }

  public playArpSequence(channel: Channel, rootNote: Note, startTime: number, bpm: number) {
    const arp = channel.arp;
    if (!arp) return;

    const secondsPerBeat = 60 / bpm;
    let stepDuration = secondsPerBeat / 4; // 1/16
    if (arp.rate === '1/4') stepDuration = secondsPerBeat;
    else if (arp.rate === '1/8') stepDuration = secondsPerBeat / 2;
    else if (arp.rate === '1/16') stepDuration = secondsPerBeat / 4;
    else if (arp.rate === '1/32') stepDuration = secondsPerBeat / 8;
    else if (arp.rate === '1/8t') stepDuration = (secondsPerBeat / 2) * (2 / 3);
    else if (arp.rate === '1/16t') stepDuration = (secondsPerBeat / 4) * (2 / 3);

    const octaves = arp.octaves || 1;
    const basePitch = rootNote.pitch;
    const pitches: number[] = [];

    // Form arpeggiation chord tones
    for (let oct = 0; oct < octaves; oct++) {
      pitches.push(basePitch + oct * 12);
      pitches.push(basePitch + 3 + oct * 12);
      pitches.push(basePitch + 7 + oct * 12);
      pitches.push(basePitch + 10 + oct * 12);
    }

    let sequence: number[] = [];
    if (arp.mode === 'up') sequence = [...pitches];
    else if (arp.mode === 'down') sequence = [...pitches].reverse();
    else if (arp.mode === 'updown') sequence = [...pitches, ...pitches.slice(1, -1).reverse()];
    else if (arp.mode === 'random') sequence = [...pitches].sort(() => Math.random() - 0.5);
    else if (arp.mode === 'chord_strum') sequence = [...pitches];
    else if (arp.mode === 'euclidean') {
      const euc = this.generateEuclideanPattern(arp.euclideanSteps || 16, arp.euclideanHits || 5, arp.euclideanRotate || 0);
      let pIdx = 0;
      euc.forEach((hit, idx) => {
        if (hit) {
          const t = startTime + (idx * stepDuration);
          const p = pitches[pIdx % pitches.length];
          pIdx++;
          this.playSingleVoice(channel, {
            ...rootNote,
            pitch: p,
            duration: stepDuration * (arp.gate || 0.8)
          }, t);
        }
      });
      return;
    }

    const totalSteps = Math.min(16, sequence.length * 2);
    for (let i = 0; i < totalSteps; i++) {
      const pitch = sequence[i % sequence.length];
      const t = startTime + (i * stepDuration);
      this.playSingleVoice(channel, {
        ...rootNote,
        pitch,
        duration: stepDuration * (arp.gate || 0.8)
      }, t);
    }
  }

  // Dynamic Sidechain Ducking Processor (Kick to Bass / Lead ducking)
  public triggerSidechainDucking(sourceTrackId: number, time: number) {
    if (!this.ctx) return;

    this.mixerChannels.forEach((targetChannel, targetId) => {
      if (targetId === sourceTrackId) return;
      if (targetChannel.sidechain && targetChannel.sidechain.enabled && targetChannel.sidechain.sourceTrackId === sourceTrackId) {
        const duckAmount = targetChannel.sidechain.amount ?? 0.75;
        const attackSec = (targetChannel.sidechain.attackMs ?? 5) / 1000;
        const releaseSec = (targetChannel.sidechain.releaseMs ?? 140) / 1000;
        const minGain = Math.max(0.02, 1.0 - duckAmount);

        const duckParam = targetChannel.duckingGain.gain;
        duckParam.cancelScheduledValues(time);
        duckParam.setValueAtTime(duckParam.value, time);
        duckParam.linearRampToValueAtTime(minGain, time + attackSec);
        duckParam.exponentialRampToValueAtTime(1.0, time + attackSec + releaseSec);
      }
    });
  }

  // Time FX & Tape Stop Performance Controller
  public triggerTapeStop(durationMs: number = 600) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const durSec = durationMs / 1000;

    if (this.grossBeatNode) {
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setValueAtTime(1.0, now);
      // Classic vinyl deceleration ramp
      this.grossBeatNode.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
      this.grossBeatNode.gain.setValueAtTime(1.0, now + durSec + 0.05);
    }
  }

  public setGrossBeatState(state: Partial<GrossBeatState>) {
    this.grossBeatState = { ...this.grossBeatState, ...state };
    if (!this.ctx || !this.grossBeatNode) return;
    const now = this.ctx.currentTime;
    if (!this.grossBeatState.enabled) {
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setTargetAtTime(1.0, now, 0.01);
    }
  }

  public getGrossBeatState(): GrossBeatState {
    return { ...this.grossBeatState };
  }

  // Music Theory Chord Voicing & Strum Engine
  public applyChordVoicing(pitches: number[], voicing: string): number[] {
    if (pitches.length <= 1) return pitches;
    const sorted = [...pitches].sort((a, b) => a - b);
    if (voicing === 'root') return sorted;
    if (voicing === 'inversion1') {
      const first = sorted.shift()!;
      return [...sorted, first + 12];
    }
    if (voicing === 'inversion2') {
      if (sorted.length >= 2) {
        const first = sorted.shift()!;
        const second = sorted.shift()!;
        return [...sorted, first + 12, second + 12];
      }
      return sorted;
    }
    if (voicing === 'drop2') {
      if (sorted.length >= 4) {
        const secondFromTop = sorted[sorted.length - 2];
        const rest = sorted.filter((_, i) => i !== sorted.length - 2);
        return [secondFromTop - 12, ...rest].sort((a, b) => a - b);
      }
      return sorted;
    }
    if (voicing === 'open_spread') {
      return sorted.map((p, idx) => (idx % 2 === 1 ? p + 12 : p));
    }
    return sorted;
  }

  // Bass Note Auto-Extractor: Extracts root notes from chord progressions
  public extractBassNotesFromChords(notes: Note[]): Note[] {
    if (!notes || notes.length === 0) return [];
    // Group notes by step
    const stepMap = new Map<number, Note[]>();
    notes.forEach(note => {
      const step = Math.round(note.start);
      if (!stepMap.has(step)) stepMap.set(step, []);
      stepMap.get(step)!.push(note);
    });

    const bassNotes: Note[] = [];
    stepMap.forEach((stepNotes, step) => {
      // Find lowest pitch
      const lowest = stepNotes.reduce((min, n) => (n.pitch < min.pitch ? n : min), stepNotes[0]);
      // Transpose down into bass range C1-C3 (24 - 48)
      let bassPitch = lowest.pitch;
      while (bassPitch > 48) bassPitch -= 12;
      while (bassPitch < 24) bassPitch += 12;

      bassNotes.push({
        id: `bass-${Date.now()}-${step}-${Math.random().toString(36).substr(2, 4)}`,
        pitch: bassPitch,
        start: lowest.start,
        duration: lowest.duration || 2,
        velocity: 0.95
      });
    });

    return bassNotes.sort((a, b) => a.start - b.start);
  }

  // Audio File Loader
  public async loadAudioFile(file: File | Blob, id: string): Promise<{ buffer: AudioBuffer; peaks: number[]; duration: number }> {
    const ctx = this.getContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.sampleBuffers.set(id, audioBuffer);

    const rawData = audioBuffer.getChannelData(0);
    const numPeaks = 64;
    const blockSize = Math.floor(rawData.length / numPeaks);
    const peaks: number[] = [];
    for (let i = 0; i < numPeaks; i++) {
      let max = 0;
      for (let j = 0; j < blockSize; j++) {
        const val = Math.abs(rawData[i * blockSize + j] || 0);
        if (val > max) max = val;
      }
      peaks.push(Math.min(1.0, max));
    }
    return { buffer: audioBuffer, peaks, duration: audioBuffer.duration };
  }

  // Automation Evaluator
  public interpolateAutomationCurve(points: { x: number; y: number; tension?: number }[], relX: number): number {
    if (!points || points.length === 0) return 0.5;
    if (points.length === 1) return points[0].y;

    const sorted = [...points].sort((a, b) => a.x - b.x);
    if (relX <= sorted[0].x) return sorted[0].y;
    if (relX >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

    for (let i = 0; i < sorted.length - 1; i++) {
      const p1 = sorted[i];
      const p2 = sorted[i + 1];
      if (relX >= p1.x && relX <= p2.x) {
        const segT = (relX - p1.x) / (p2.x - p1.x);
        // Linear or ease
        const tension = p1.tension || 0;
        let curvedT = segT;
        if (tension > 0) {
          curvedT = Math.pow(segT, 1 + tension * 2);
        } else if (tension < 0) {
          curvedT = 1 - Math.pow(1 - segT, 1 + Math.abs(tension) * 2);
        }
        return p1.y + (p2.y - p1.y) * curvedT;
      }
    }
    return 0.5;
  }

  public applyAutomationValue(
    target: { type: string; targetId: string | number; paramName?: string },
    value: number, // 0 to 1
    channels: Channel[],
    mixerTracks: MixerTrack[],
    atTime?: number
  ) {
    if (!this.ctx) return;
    const now = atTime ?? this.ctx.currentTime;

    if (target.type === 'master_vol') {
      if (this.masterGain) {
        this.masterGain.gain.setTargetAtTime(value * 1.2, now, 0.02);
      }
    } else if (target.type === 'channel_vol') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch) {
        ch.volume = value;
      }
    } else if (target.type === 'channel_pan') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch) {
        ch.pan = (value * 2) - 1;
      }
    } else if (target.type === 'channel_filter_cutoff') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch && ch.synthParams) {
        ch.synthParams.filterCutoff = 40 + Math.pow(value, 2) * 18000;
      }
    } else if (target.type === 'mixer_vol') {
      const trk = mixerTracks.find(t => t.id === Number(target.targetId));
      if (trk) {
        trk.volume = value * 1.25;
      }
      const mixerChannel = this.mixerChannels.get(Number(target.targetId));
      if (mixerChannel) {
        const targetVol = (trk && trk.mute) ? 0 : value * 1.25;
        mixerChannel.output.gain.setTargetAtTime(targetVol, now, 0.02);
      }
    } else if (target.type === 'mixer_pan') {
      const trk = mixerTracks.find(t => t.id === Number(target.targetId));
      const targetPan = (value * 2) - 1;
      if (trk) {
        trk.pan = targetPan;
      }
      const mixerChannel = this.mixerChannels.get(Number(target.targetId));
      if (mixerChannel && 'pan' in mixerChannel.panner && mixerChannel.panner.pan) {
        mixerChannel.panner.pan.setTargetAtTime(targetPan, now, 0.02);
      }
    } else if (target.type === 'channel_filter_res') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch && ch.synthParams) {
        // Map the automation's normalized 0-1 value onto the model's 0-20 resonance
        // range. New voices constructed at note-trigger read this value, so the
        // next note already hears the automated Q.
        ch.synthParams.filterResonance = Math.max(0.0001, value * 20);
      }
    } else if (target.type === 'channel_pitch') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch) {
        // Map normalized 0-1 onto the FL Studio-style ±12 semitone offset so the
        // middle of the curve is no transposition. Every note trigger reads
        // `channel.pitch`, so writing it here takes effect on the next note.
        ch.pitch = (value * 24) - 12;
      }
    } else if (target.type === 'fx_mix') {
      const trackId = Number(target.targetId);
      const trk = mixerTracks.find(t => t.id === trackId);
      if (trk) {
        const slotId = target.paramName;
        if (slotId) {
          const slot = trk.fxSlots.find(s => s.id === slotId);
          if (slot) {
            // Offline renders consume slot.mix at chain construction time. Update
            // the slot's mix so the next export rebuild (or next offline take)
            // observes the automated value. Live playback updates the running
            // WetDry via the patch registry, when installed, so the user hears
            // the change without a chain rebuild.
            slot.mix = Math.max(0, Math.min(1, value));
            const registry = (this as unknown as {
              __liveFxChainRegistry?: {
                applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
              };
            }).__liveFxChainRegistry;
            registry?.applyLiveMix(trackId, slotId, slot.mix, now);
          }
        }
      }
    }
  }

  /**
   * Phase 10B: Apply a slot.mix change to the live WetDry wrapper without
   * tearing down the active chain. Returns true when the patch supplied an
   * updated live WetDry, false when the caller must rebuild the chain (e.g.
   * stopped playback with no live instance) — the project state is updated
   * either way so the next chain rebuild picks up the value.
   */
  public setFxSlotMix(trackId: number, slotId: string, mix: number): boolean {
    const bounded = Math.max(0, Math.min(1, Number(mix)));
    if (!Number.isFinite(bounded)) return false;
    const track = this.activeMixerTracks.find(t => t.id === trackId);
    if (track) {
      const slot = track.fxSlots.find(s => s.id === slotId);
      if (slot) slot.mix = bounded;
    }
    const now = this.ctx?.currentTime ?? 0;
    const registry = (this as unknown as {
      __liveFxChainRegistry?: {
        applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
      };
    }).__liveFxChainRegistry;
    return registry?.applyLiveMix(trackId, slotId, bounded, now) ?? false;
  }

  public stopNote(voiceId: string) {
    if (this.activeVoices.has(voiceId)) {
      const voice = this.activeVoices.get(voiceId);
      voice?.stop();
      this.activeVoices.delete(voiceId);
      this.removeDrumPadChokeVoice(voiceId, voice);
    }
  }

  public stopChannelVoices(channelId: string): void {
    const prefix = `${channelId}-`;
    for (const [voiceId, voice] of this.activeVoices.entries()) {
      if (voiceId.startsWith(prefix)) {
        try {
          voice.stop();
        } catch (_) {}
        this.activeVoices.delete(voiceId);
        this.removeDrumPadChokeVoice(voiceId, voice);
      }
    }
  }



  // 2. 3-Osc Subtractive MiniSynth
  // --- Acoustic & Orchestral Instrument Synthesis Engines ---

































  public midiToFreq(midiNote: number): number {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  public getDefaultSynthParams(): SynthParameters {
    return {
      osc1Type: 'sawtooth',
      osc1Octave: 0,
      osc1Detune: 0,
      osc1Mix: 0.8,

      osc2Type: 'square',
      osc2Octave: 0,
      osc2Detune: 7,
      osc2Mix: 0.5,

      filterType: 'lowpass',
      filterCutoff: 3500,
      filterResonance: 2.5,
      filterEnvAmount: 0.4,

      attack: 0.01,
      decay: 0.25,
      sustain: 0.6,
      release: 0.2,

      lfoRate: 4,
      lfoDepth: 0.1,
      lfoTarget: 'none',

      fmCarrierMultiplier: 1.0,
      fmModulatorMultiplier: 2.0,
      fmModulationIndex: 200,
      fmFeedback: 0,

      sampleRootNote: 60,
      sampleGlide: 0,
      sampleReverse: false,
      sampleLoop: false,
      sampleDrive: 0,
    };
  }

  // Metering & Visualizers
  public getMasterFrequencyData(array: Uint8Array) {
    if (this.isOfflineRendering) {
      array.fill(0);
      return;
    }
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteFrequencyData(array);
    }
  }

  public getMasterWaveformData(array: Uint8Array) {
    if (this.isOfflineRendering) {
      array.fill(128);
      return;
    }
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteTimeDomainData(array);
    }
  }

  public getMixerTrackPeak(trackId: number): number {
    if (this.isOfflineRendering) return 0;
    const channel = this.mixerChannels.get(trackId);
    if (!channel || !this.ctx) return 0;
    const array = new Uint8Array(128);
    channel.analyser.getByteTimeDomainData(array);
    let max = 0;
    for (let i = 0; i < array.length; i++) {
      const val = Math.abs(array[i] - 128) / 128;
      if (val > max) max = val;
    }
    return max;
  }

  // Real-time Audio Recorder (Microphone/Line-In)
  public async startAudioRecording(): Promise<MediaStream> {
    if (!this.ctx) await this.init();
    this.recordedChunks = [];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    this.mediaStream = stream;
    const source = this.ctx!.createMediaStreamSource(stream);
    this.recordingAnalyser = this.ctx!.createAnalyser();
    this.recordingAnalyser.fftSize = 256;
    source.connect(this.recordingAnalyser);

    this.mediaRecorder = new MediaRecorder(stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };
    this.mediaRecorder.start();

    return stream;
  }

  public getRecordingPeak(): number {
    if (!this.recordingAnalyser) return 0;
    const array = new Uint8Array(128);
    this.recordingAnalyser.getByteTimeDomainData(array);
    let max = 0;
    for (let i = 0; i < array.length; i++) {
      const val = Math.abs(array[i] - 128) / 128;
      if (val > max) max = val;
    }
    return max;
  }

  public async stopAudioRecording(): Promise<AudioRecording> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        resolve({
          id: `rec-${Date.now()}`,
          name: 'Take 1',
          timestamp: Date.now(),
          durationSeconds: 1,
          waveform: [0.2, 0.5, 0.8, 0.4, 0.1],
        });
        return;
      }

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        
        // Stop stream tracks
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
        }

        // Generate waveform preview
        const waveform = [0.1, 0.3, 0.6, 0.9, 0.7, 0.4, 0.8, 0.5, 0.2, 0.6, 0.3];

        const rec: AudioRecording = {
          id: `rec-${Date.now()}`,
          name: `Vocal Take ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          timestamp: Date.now(),
          durationSeconds: 4,
          audioBlob: blob,
          audioUrl: url,
          waveform,
        };

        resolve(rec);
      };

      this.mediaRecorder.stop();
    });
  }

  // Web MIDI API Integration
  public async initMidi() {
    try {
      if (typeof navigator !== 'undefined' && navigator.requestMIDIAccess) {
        this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        
        const attachInputs = () => {
          for (const input of this.midiAccess.inputs.values()) {
            input.onmidimessage = this.handleMidiMessage.bind(this);
          }
        };

        attachInputs();
        this.midiAccess.onstatechange = () => {
          attachInputs();
        };
      }
    } catch (err) {
      console.log('Web MIDI access not available or user denied permission');
    }
  }

  public getConnectedMidiDevices(): { id: string; name: string; manufacturer?: string; state: string; type: 'input' | 'output' }[] {
    const devices: { id: string; name: string; manufacturer?: string; state: string; type: 'input' | 'output' }[] = [];
    if (this.midiAccess) {
      for (const input of this.midiAccess.inputs.values()) {
        devices.push({
          id: input.id || `midi-in-${devices.length}`,
          name: input.name || 'Generic MIDI Controller',
          manufacturer: input.manufacturer || 'Hardware Device',
          state: input.state || 'connected',
          type: 'input'
        });
      }
      for (const output of this.midiAccess.outputs.values()) {
        devices.push({
          id: output.id || `midi-out-${devices.length}`,
          name: output.name || 'MIDI Out Port',
          manufacturer: output.manufacturer || 'Hardware Device',
          state: output.state || 'connected',
          type: 'output'
        });
      }
    }
    return devices;
  }

  public addMidiListener(listener: (e: MidiEventPayload) => void) {
    this.midiListeners.push(listener);
  }

  public removeMidiListener(listener: (e: MidiEventPayload) => void) {
    this.midiListeners = this.midiListeners.filter(l => l !== listener);
  }

  private handleMidiMessage(event: InternalMidiMessageEvent | MIDIMessageEvent) {
    const [status, data1, data2] = event.data;
    const command = status >> 4;
    const midiChannel = (status & 0xf) + 1;

    if (command === 9 && data2 > 0) {
      // Note On
      this.midiListeners.forEach(l => l({ type: 'noteOn', note: data1, velocity: data2 / 127, midiChannel }));
    } else if (command === 8 || (command === 9 && data2 === 0)) {
      // Note Off
      this.midiListeners.forEach(l => l({ type: 'noteOff', note: data1, midiChannel }));
    } else if (command === 11) {
      // Control Change (CC)
      this.midiListeners.forEach(l => l({ type: 'cc', cc: data1, value: data2 / 127, midiChannel }));
    } else if (command === 14) {
      // Pitch Bend
      const bendVal = ((data2 << 7) + data1 - 8192) / 8192;
      this.midiListeners.forEach(l => l({ type: 'pitchBend', value: bendVal, midiChannel }));
    }
  }

  /**
   * Offline timeline render used by export.
   *
   * `patternLengthSteps` is the declared `Pattern.lengthSteps` of the pattern a
   * Pattern Loop export renders. It is additive and optional: Song exports and
   * every existing caller keep their behaviour, and a Pattern export without it
   * resolves the loop from channel content exactly as before. When supplied it is
   * handed to the same `resolvePatternLoopLengthSteps()` Pattern Mode plays with,
   * so a pattern that declares 32 steps exports a 32-step loop even when steps
   * 16-31 hold no notes. Loop length is never re-derived here.
   */
  public async renderTimelineOffline(
    channels: Channel[],
    clips: PlaylistClip[],
    mixerTracks: MixerTrack[],
    bpm: number,
    totalBars: number,
    sampleRate?: number,
    includeMixerFx = false,
    renderScope: OfflineRenderScope = 'song',
    onProgress?: OfflineRenderProgress,
    patternLengthSteps?: number,
    playlistTracks?: PlaylistTrack[],
    minimumDurationSeconds: number = 4,
  ): Promise<AudioBuffer> {
    onProgress?.(15, `Preparing ${renderScope === 'pattern' ? 'pattern loop' : 'song'} export...`);

    // Phase 10A: a muted playlist lane must behave like a muted clip during
    // export — a missing audio buffer on a silenced lane should never fail the
    // export, and that lane's clips are dropped from the rendered WAV exactly
    // the way the live scheduler drops them at the trigger boundary.
    const offlineLaneMutes = this.derivePlaylistLaneMutes(playlistTracks);

    // Validate audio buffers for all audible audio clips.
    // Phase 8B (P1-4): an unresolvable or unavailable audio asset (placeholder
    // stem, missing buffer, or hydration-flagged `audioUnavailable`) must fail
    // the export up front instead of rendering a misleading silent WAV.
    // Phase 10A: lane-muted clips are silently dropped, so their missing
    // buffers must not fail the export — only audible clips are validated.
    for (const clip of clips) {
      if (clip.type === 'audio' && !clip.mute && !this.isClipPlaylistLaneMuted(clip, offlineLaneMutes)) {
        if (!clip.audioBufferId) {
          throw new Error(
            `Audio clip "${clip.name || clip.audioName || clip.id}" is missing an audioBufferId.`
          );
        }
        if (clip.audioUnavailable) {
          throw new Error(
            `Audio clip "${clip.name || clip.audioName || clip.id}" (buffer ID: ${clip.audioBufferId}) references an unavailable audio asset; its persisted audio could not be restored.`
          );
        }
        const buffer = this.sampleBuffers.get(clip.audioBufferId);
        if (!buffer) {
          throw new Error(
            `Missing audio buffer for clip "${clip.name || clip.audioName || clip.id}" (buffer ID: ${clip.audioBufferId}). The audio asset is not loaded in memory.`
          );
        }
      }
    }

    if (this.transport && this.isPlaying) {
      this.transport.stop(false);
    }

    const previous = {
      ctx: this.ctx,
      transport: this.transport,
      masterGain: this.masterGain,
      masterAnalyser: this.masterAnalyser,
      grossBeatNode: this.grossBeatNode,
      mixerChannels: this.mixerChannels,
      impulseResponses: this.impulseResponses,
      activeVoices: this.activeVoices,
      activeClipSources: this.activeClipSources,
      isPlaying: this.isPlaying,
      activeChannels: this.activeChannels,
      activeClips: this.activeClips,
      activeMixerTracks: this.activeMixerTracks,
      playbackProjectChannels: this.playbackProjectChannels,
      playbackProjectMixerTracks: this.playbackProjectMixerTracks,
      activePlayMode: this.activePlayMode,
      activePatternId: this.activePatternId,
      activePatternLengthSteps: this.activePatternLengthSteps,
      currentStep: this.currentStep,
      currentBar: this.currentBar,
      bpm: this.bpm,
      metronome: this.metronome,
      playlistLaneMutes: this.playlistLaneMutes
    };
    this.isOfflineRendering = true;
    this.liveCtx = previous.ctx;
    const safeBpm = Math.max(20, Math.min(300, Number(bpm) || 120));
    const secondsPerStep = (60 / safeBpm) / 4;
    const requestedMinimumDuration = Number.isFinite(minimumDurationSeconds) && minimumDurationSeconds >= 0
      ? minimumDurationSeconds
      : 4;
    const totalDurationSeconds = Math.max(
      requestedMinimumDuration,
      Math.max(1, totalBars) * 4 * (60 / safeBpm),
    );
    const renderSampleRate = sampleRate ?? previous.ctx?.sampleRate ?? 44100;
    const OfflineContextClass =
      (typeof window !== 'undefined' && (window as unknown as WindowWithWebKitAudio).OfflineAudioContext) ||
      (typeof window !== 'undefined' && (window as unknown as WindowWithWebKitAudio).webkitOfflineAudioContext) ||
      (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!OfflineContextClass) {
      throw new Error('OfflineAudioContext is unavailable in this environment.');
    }
    const offlineCtx = new OfflineContextClass(
      2,
      Math.ceil(renderSampleRate * totalDurationSeconds),
      renderSampleRate,
    );
    try {
      this.ctx = offlineCtx as unknown as AudioContext;
      this.transport = null;
      this.masterGain = offlineCtx.createGain();
      this.grossBeatNode = offlineCtx.createGain();
      this.masterAnalyser = offlineCtx.createAnalyser();
      this.masterAnalyser.fftSize = 512;
      this.masterAnalyser.smoothingTimeConstant = 0.8;
      this.masterGain.connect(this.grossBeatNode);
      this.grossBeatNode.connect(this.masterAnalyser);
      this.masterAnalyser.connect(offlineCtx.destination);
      this.mixerChannels = new Map();
      this.impulseResponses = new Map();
      this.activeVoices = new Map();
      this.activeChannels = structuredClone(channels);
      this.activeClips = structuredClone(clips);
      this.playbackProjectChannels = structuredClone(channels);
      this.playbackProjectMixerTracks = [];
      this.activePlayMode = renderScope === 'pattern' ? 'pat' : 'song';
      onProgress?.(40, `Offline graph ready (${renderScope === 'pattern' ? 'pattern' : 'song'} mode).`);
      this.activePatternId = undefined;
      // An offline Pattern render is its own take: it must not inherit (or leave
      // behind) the declared length of a live playback take.
      this.activePatternLengthSteps = renderScope === 'pattern' ? patternLengthSteps : undefined;
      this.isPlaying = true;
      this.currentStep = 0;
      this.currentBar = 1;
      this.bpm = safeBpm;
      this.metronome = false;

      // Browser exports use a bounded offline graph by default. Live mixer FX
      // (especially convolution and feedback delay) can make OfflineAudioContext
      // rendering disproportionately expensive. Preserve the full FX graph as an
      // explicit opt-in for validation/internal callers.
      const tracks = [...mixerTracks].sort((a, b) => a.id - b.id);
      const renderTracks = includeMixerFx
        ? tracks
        : tracks.map(track => ({ ...track, fxSlots: [] }));
      this.activeMixerTracks = structuredClone(renderTracks);
      this.playbackProjectMixerTracks = structuredClone(renderTracks);
      // Phase 10A: share the project's lane-mute derivation with the offline
      // scheduler so the trigger boundary drops muted-lane clips the same way
      // the live `play()` boundary does. Without this, the offline renderer
      // would still call `playAudioClipWithFades` on muted-lane audio clips.
      this.playlistLaneMutes = offlineLaneMutes;
      if (includeMixerFx) {
        // Phase 10A: a seeded impulse is required so offline exports are
        // byte-deterministic across runs. The live engine never reaches this
        // branch (`includeMixerFx` defaults to false on the offline path) and
        // keeps its existing non-deterministic convolution tail.
        this.buildReverbImpulse(2.5, 2.0, { seed: 0x10a4eb });
      }
      const masterTrack = renderTracks.find(track => track.id === 0);
      if (masterTrack) this.updateMixerTrack(masterTrack); else this.getOrCreateMixerChannel(0);
      for (const track of renderTracks) if (track.id !== 0) this.updateMixerTrack(track);
      const totalSteps = Math.ceil(totalDurationSeconds / secondsPerStep);
      // A Pattern Loop export must wrap at the same boundary as Pattern Mode
      // playback, otherwise steps beyond the first bar render silence. Song
      // exports keep the one-bar grid the playlist is scheduled on. The declared
      // pattern length is passed to the same resolver playback uses, so a
      // declared 32-step pattern exports 32 steps even with an empty second bar.
      const patternLoopSteps = renderScope === 'pattern'
        ? resolvePatternLoopLengthSteps(this.activeChannels, patternLengthSteps)
        : 16;
      const scheduleStartProgress = 40;
      const scheduleEndProgress = 65;
      // Schedule the offline timeline in small cooperative batches so the browser
      // can service rendering/UI work instead of appearing unresponsive on longer exports.
      for (let globalStep = 0; globalStep < totalSteps; globalStep += 1) {
        this.currentStep = globalStep % patternLoopSteps;
        this.currentBar = Math.floor(globalStep / 16) + 1;
        const swingOffsetSeconds = this.currentStep % 2 === 1 ? (this.swing / 100) * (secondsPerStep * 0.4) : 0;
        const audioTime = globalStep * secondsPerStep + swingOffsetSeconds;
        if (audioTime >= totalDurationSeconds) break;
        this.triggerCurrentStep(audioTime);
        if ((globalStep + 1) % 4 === 0 || globalStep === totalSteps - 1) {
          const scheduleProgress = scheduleStartProgress + Math.round(((globalStep + 1) / totalSteps) * (scheduleEndProgress - scheduleStartProgress));
          onProgress?.(scheduleProgress, `Scheduling ${renderScope === 'pattern' ? 'pattern' : 'song'} audio (${globalStep + 1}/${totalSteps} steps)...`);
        }

        if ((globalStep + 1) % 16 === 0 && globalStep + 1 < totalSteps) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
      onProgress?.(70, `Rendering offline audio (${totalDurationSeconds.toFixed(2)}s)...`);
      const renderedBuffer = await offlineCtx.startRendering();
      onProgress?.(85, 'Offline render complete. Encoding WAV...');
      return renderedBuffer;
    } finally {
      this.isOfflineRendering = false;
      this.liveCtx = null;
      this.ctx = previous.ctx;
      this.transport = previous.transport;
      this.masterGain = previous.masterGain;
      this.masterAnalyser = previous.masterAnalyser;
      this.grossBeatNode = previous.grossBeatNode;
      this.mixerChannels = previous.mixerChannels;
      this.impulseResponses = previous.impulseResponses;
      this.activeVoices = previous.activeVoices;
      this.isPlaying = previous.isPlaying;
      this.activeChannels = previous.activeChannels;
      this.activeClips = previous.activeClips;
      this.activeMixerTracks = previous.activeMixerTracks;
      this.playbackProjectChannels = previous.playbackProjectChannels;
      this.playbackProjectMixerTracks = previous.playbackProjectMixerTracks;
      this.activePlayMode = previous.activePlayMode;
      this.activePatternId = previous.activePatternId;
      this.activePatternLengthSteps = previous.activePatternLengthSteps;
      this.currentStep = previous.currentStep;
      this.currentBar = previous.currentBar;
      this.bpm = previous.bpm;
      this.metronome = previous.metronome;
      this.playlistLaneMutes = previous.playlistLaneMutes;
    }
  }

  // High-Grade Offline Audio Renderer (WAV, MP3, MIDI, Stems)
  public async renderProjectToWav(
    channels: Channel[],
    clips: PlaylistClip[],
    bpm: number,
    totalBars: number,
    bitDepth: 16 | 24 | 32 = 24,
    mixerTracks?: MixerTrack[],
    includeMixerFx: boolean = false,
    playlistTracks?: PlaylistTrack[]
  ): Promise<Blob> {
    const renderedBuffer = await this.renderTimelineOffline(
      channels,
      clips,
      mixerTracks ?? [],
      bpm,
      totalBars,
      undefined,
      includeMixerFx,
      'song',
      undefined,
      undefined,
      playlistTracks
    );
    return this.audioBufferToWav(renderedBuffer, bitDepth);
  }

  // Multi-Track Offline Stem Exporter: Renders individual isolated tracks with real DSP & FX
  public async renderProjectStems(
    channels: Channel[],
    clips: PlaylistClip[],
    mixerTracksOrBpm: MixerTrack[] | number,
    bpmOrTotalBars?: number,
    totalBarsOrBitDepth?: number | (16 | 24 | 32),
    bitDepthParam?: 16 | 24 | 32,
    renderScope: OfflineRenderScope = 'song',
    patternLengthSteps?: number,
    playlistTracks?: PlaylistTrack[],
    includeMixerFx: boolean = false
  ): Promise<{ stems: Record<string, Blob>; master: Blob }> {
    let mixerTracks: MixerTrack[] = [];
    let bpm = 120;
    let totalBars = 4;
    let bitDepth: 16 | 24 | 32 = 24;

    if (Array.isArray(mixerTracksOrBpm)) {
      mixerTracks = mixerTracksOrBpm;
      bpm = Number(bpmOrTotalBars) || 120;
      totalBars = Number(totalBarsOrBitDepth) || 4;
      bitDepth = bitDepthParam ?? 24;
    } else {
      bpm = Number(mixerTracksOrBpm) || 120;
      totalBars = Number(bpmOrTotalBars) || 4;
      bitDepth = (totalBarsOrBitDepth as (16 | 24 | 32)) ?? 24;
      mixerTracks = [];
    }

    // Phase 10A: stems must honour playlist lane mutes exactly like the master
    // mix and the live scheduler — a muted lane is dropped before the stem
    // pipeline runs its per-clip filters, so a missing audio buffer on a
    // silenced lane never aborts the export.
    const stemLaneMutes = this.derivePlaylistLaneMutes(playlistTracks);

    // 1. Render Full Master Mix using verified offline timeline renderer
    const masterBuffer = await this.renderTimelineOffline(
      channels,
      clips,
      mixerTracks,
      bpm,
      totalBars,
      undefined,
      includeMixerFx,
      renderScope,
      undefined,
      patternLengthSteps,
      playlistTracks
    );
    const master = this.audioBufferToWav(masterBuffer, bitDepth);

    const stems: Record<string, Blob> = {};

    // 2. Render each channel stem
    for (const channel of channels) {
      const channelClips = clips.filter(clip => {
        if (clip.mute) return false;
        if (this.isClipPlaylistLaneMuted(clip, stemLaneMutes)) return false;
        if (clip.type === 'pattern') {
          return clip.channelId === channel.id;
        }
        if (clip.type === 'audio') {
          return clip.channelId === channel.id;
        }
        if (clip.type === 'automation') {
          const target = clip.automationTarget;
          if (!target) return false;
          return (
            String(target.targetId) === String(channel.id) ||
            String(target.targetId) === String(channel.mixerTrackId)
          );
        }
        return false;
      });

      const stemBuffer = await this.renderTimelineOffline(
        [channel],
        channelClips,
        mixerTracks,
        bpm,
        totalBars,
        undefined,
        includeMixerFx,
        renderScope,
        undefined,
        patternLengthSteps,
        playlistTracks
      );

      const cleanName = (channel.name || `Channel_${channel.id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
      stems[`${channel.id}_${cleanName}.wav`] = this.audioBufferToWav(stemBuffer, bitDepth);
    }

    // 3. Render unassociated audio clips (recordings / samples not assigned to a channel)
    // Group them by playlist trackIndex
    const channelIds = new Set(channels.map(c => c.id));
    const unassociatedAudioClips = clips.filter(
      clip =>
        clip.type === 'audio' &&
        !clip.mute &&
        !this.isClipPlaylistLaneMuted(clip, stemLaneMutes) &&
        (!clip.channelId || !channelIds.has(clip.channelId))
    );

    const clipsByTrack = new Map<number, PlaylistClip[]>();
    for (const clip of unassociatedAudioClips) {
      const trackIdx = Number.isFinite(clip.trackIndex) ? Math.floor(clip.trackIndex) : 0;
      const list = clipsByTrack.get(trackIdx) || [];
      list.push(clip);
      clipsByTrack.set(trackIdx, list);
    }

    for (const [trackIdx, trackClips] of clipsByTrack.entries()) {
      const mixerTrackId = Math.max(1, trackIdx + 1);
      const trackAutomationClips = clips.filter(clip => {
        if (clip.mute || clip.type !== 'automation' || !clip.automationTarget) return false;
        if (this.isClipPlaylistLaneMuted(clip, stemLaneMutes)) return false;
        return String(clip.automationTarget.targetId) === String(mixerTrackId);
      });

      const stemBuffer = await this.renderTimelineOffline(
        [],
        [...trackClips, ...trackAutomationClips],
        mixerTracks,
        bpm,
        totalBars,
        undefined,
        includeMixerFx,
        renderScope,
        undefined,
        patternLengthSteps,
        playlistTracks
      );

      const trackNum = trackIdx + 1;
      const trackClipNames = trackClips.map(c => c.name || c.audioName).filter(Boolean);
      const firstClipName = trackClipNames[0] || `Audio_Track_${trackNum}`;
      const cleanName = firstClipName.replace(/[^a-zA-Z0-9_-]/g, '_');
      stems[`track_${trackNum}_${cleanName}.wav`] = this.audioBufferToWav(stemBuffer, bitDepth);
    }

    return { stems, master };
  }

  private renderNoteOffline(
    ctx: OfflineAudioContext,
    channel: Channel,
    note: Note,
    time: number,
    destination: AudioNode
  ) {
    const freq = this.midiToFreq(note.pitch);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = channel.synthParams?.osc1Type || 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    const vel = (note.velocity || 0.8) * channel.volume;
    const dur = (note.duration || 1) * 0.25;

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(vel, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur + 0.2);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(time);
    osc.stop(time + dur + 0.25);
  }

  // AudioBuffer to Lossless WAV encoder with IEEE Float or PCM Header
  private audioBufferToWav(buffer: AudioBuffer, bitDepth: 16 | 24 | 32): Blob {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = bitDepth === 32 ? 3 : 1; // 3 = IEEE Float, 1 = PCM
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const dataLength = buffer.length * blockAlign;
    const bufferLength = 44 + dataLength;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    // RIFF identifier
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Interleave left and right channels
    const left = buffer.getChannelData(0);
    const right = numChannels > 1 ? buffer.getChannelData(1) : left;

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = ch === 0 ? left[i] : right[i];
        const clamped = Math.max(-1, Math.min(1, sample));

        if (bitDepth === 16) {
          view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
          offset += 2;
        } else if (bitDepth === 24) {
          const val = clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff;
          view.setUint8(offset, val & 0xff);
          view.setUint8(offset + 1, (val >> 8) & 0xff);
          view.setUint8(offset + 2, (val >> 16) & 0xff);
          offset += 3;
        } else {
          view.setFloat32(offset, clamped, true);
          offset += 4;
        }
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  // --- Transport & Sequencer Loop ---
  private bpm: number = 128;
  private swing: number = 0;
  private metronome: boolean = false;
  private isPlaying: boolean = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private currentStep: number = 0;
  private currentBar: number = 1;
  private stepCallback: ((step: number, bar: number) => void) | null = null;
  private transportStateCallback: ((state: Readonly<TransportState>) => void) | null = null;
  private activeChannels: Channel[] = [];
  private activeClips: PlaylistClip[] = [];
  private activeMixerTracks: MixerTrack[] = [];
  /** Last project-owned values supplied to the active playback take. */
  private playbackProjectChannels: Channel[] = [];
  private playbackProjectMixerTracks: MixerTrack[] = [];
  private activePlayMode: 'pat' | 'song' = 'pat';
  private activePatternId?: string;
  /** Declared `Pattern.lengthSteps` of the pattern the active take is looping. */
  private activePatternLengthSteps?: number;

  public setBpm(bpm: number) {
    this.bpm = Math.max(20, Math.min(300, bpm));
    if (this.transport) {
      this.transport.setBpm(this.bpm);
    }
  }

  public setSwing(swing: number) {
    this.swing = Math.max(0, Math.min(100, swing));
  }

  public setMetronome(enabled: boolean) {
    this.metronome = enabled;
  }

  public setStepCallback(cb: (step: number, bar: number) => void) {
    this.stepCallback = cb;
  }

  public setTransportStateCallback(cb: ((state: Readonly<TransportState>) => void) | null) {
    this.transportStateCallback = cb;
  }

  /**
   * Creates an isolated copy of the project data a playback take runs on.
   * The scheduler mutates channel volume/pan/filter values while evaluating
   * automation, so playback must operate on clones: live automation must
   * never write through to ProjectState (history entries and saved projects
   * would otherwise capture transient playback values).
   */
  public createPlaybackSnapshot(
    channels: Channel[],
    clips: PlaylistClip[],
    mixerTracks: MixerTrack[]
  ): { channels: Channel[]; clips: PlaylistClip[]; mixerTracks: MixerTrack[] } {
    return {
      channels: structuredClone(channels),
      clips: structuredClone(clips),
      mixerTracks: structuredClone(mixerTracks)
    };
  }

  private getAutomationTargetKey(clip: PlaylistClip): string | null {
    if (clip.type !== 'automation' || !clip.automationTarget) return null;
    const target = clip.automationTarget;
    return `${target.type}:${String(target.targetId)}:${target.paramName ?? ''}`;
  }

  private isAutomationClipActiveAtCurrentPosition(clip: PlaylistClip): boolean {
    if (clip.type !== 'automation' || clip.mute || !clip.automationTarget) return false;
    if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) return false;
    const currentBarPosition = Math.max(0, this.currentBar - 1) + (this.currentStep / 16);
    return currentBarPosition >= clip.startBar && currentBarPosition <= clip.startBar + clip.lengthBars;
  }

  /**
   * Removing or moving the last active automation clip for a target must not
   * leave its previous transient value latched in the isolated take. Restore
   * that target from the latest project baseline; a still-active replacement
   * clip remains authoritative and will be evaluated on the next scheduler
   * callback.
   */
  private resetAutomationTargetsForClipChanges(previousClips: PlaylistClip[], nextClips: PlaylistClip[]): void {
    const nextActiveTargets = new Set(
      nextClips
        .filter(clip => this.isAutomationClipActiveAtCurrentPosition(clip))
        .map(clip => this.getAutomationTargetKey(clip))
        .filter((key): key is string => Boolean(key))
    );

    for (const previousClip of previousClips) {
      const previousTargetKey = this.getAutomationTargetKey(previousClip);
      if (!previousTargetKey) continue;

      const nextVersion = nextClips.find(clip => clip.id === previousClip.id);
      const structuralChange = !nextVersion ||
        previousClip.mute !== nextVersion.mute ||
        previousClip.startBar !== nextVersion.startBar ||
        previousClip.lengthBars !== nextVersion.lengthBars ||
        !playbackValuesEqual(previousClip.automationTarget, nextVersion.automationTarget);
      if (structuralChange && !nextActiveTargets.has(previousTargetKey)) {
        this.resetActiveAutomationTarget(previousClip.automationTarget!);
      }
    }
  }

  private resetActiveAutomationTarget(target: NonNullable<PlaylistClip['automationTarget']>): void {
    const now = this.ctx?.currentTime ?? 0;
    if (target.type === 'channel_vol' || target.type === 'channel_pan' || target.type === 'channel_filter_cutoff' || target.type === 'channel_filter_res' || target.type === 'channel_pitch') {
      const activeChannel = this.activeChannels.find(channel => String(channel.id) === String(target.targetId));
      const projectChannel = this.playbackProjectChannels.find(channel => String(channel.id) === String(target.targetId));
      if (!activeChannel || !projectChannel) return;

      if (target.type === 'channel_vol') activeChannel.volume = projectChannel.volume;
      if (target.type === 'channel_pan') activeChannel.pan = projectChannel.pan;
      if (target.type === 'channel_filter_cutoff' && activeChannel.synthParams && projectChannel.synthParams) {
        activeChannel.synthParams.filterCutoff = projectChannel.synthParams.filterCutoff;
      }
      if (target.type === 'channel_filter_res' && activeChannel.synthParams && projectChannel.synthParams) {
        activeChannel.synthParams.filterResonance = projectChannel.synthParams.filterResonance;
      }
      if (target.type === 'channel_pitch') {
        activeChannel.pitch = projectChannel.pitch;
      }
      return;
    }

    if (target.type === 'mixer_vol' || target.type === 'mixer_pan') {
      const trackId = Number(target.targetId);
      const activeTrack = this.activeMixerTracks.find(track => track.id === trackId);
      const projectTrack = this.playbackProjectMixerTracks.find(track => track.id === trackId);
      if (!activeTrack || !projectTrack) return;

      if (target.type === 'mixer_vol') activeTrack.volume = projectTrack.volume;
      if (target.type === 'mixer_pan') activeTrack.pan = projectTrack.pan;
      this.updateMixerTrack(activeTrack);
      return;
    }

    if (target.type === 'fx_mix') {
      // Reset to the project's declared slot.mix and re-apply on the live chain
      // so a removed/finished automation clip does not leave the wet/dry value
      // latched at the last automation value.
      const trackId = Number(target.targetId);
      const slotId = target.paramName;
      if (!slotId) return;
      const activeTrack = this.activeMixerTracks.find(track => track.id === trackId);
      const projectTrack = this.playbackProjectMixerTracks.find(track => track.id === trackId);
      if (!activeTrack || !projectTrack) return;
      const activeSlot = activeTrack.fxSlots.find(slot => slot.id === slotId);
      const projectSlot = projectTrack.fxSlots.find(slot => slot.id === slotId);
      if (!activeSlot || !projectSlot) return;
      activeSlot.mix = projectSlot.mix;
      const registry = (this as unknown as {
        __liveFxChainRegistry?: {
          applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
        };
      }).__liveFxChainRegistry;
      registry?.applyLiveMix(trackId, slotId, projectSlot.mix, now);
      return;
    }

    if (target.type === 'master_vol' && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(1, now, 0.02);
    }
  }

  /**
   * Applies an edit to the isolated playback take without replacing the
   * project object used by React/history/persistence. Playlist clips are
   * replaced as a cloned schedule, while channel and mixer collections merge
   * only fields that changed in project state so an in-flight automation value
   * remains active until the next automation event.
   */
  public synchronizePlaybackState(update: PlaybackStateUpdate): void {
    if (!this.isPlaying) return;

    // Adopt the declared pattern length before merging channel edits so a length
    // change that arrives together with content is resolved against the new value.
    const patternLengthChanged = typeof update.patternLengthSteps === 'number'
      && update.patternLengthSteps !== this.activePatternLengthSteps;
    if (patternLengthChanged) {
      this.activePatternLengthSteps = update.patternLengthSteps;
    }

    if (update.channels) {
      const previousProjectById = new Map(this.playbackProjectChannels.map(channel => [channel.id, channel]));
      const activeById = new Map(this.activeChannels.map(channel => [channel.id, channel]));
      this.activeChannels = update.channels.map(channel => {
        const previousProject = previousProjectById.get(channel.id);
        const active = activeById.get(channel.id);
        if (!previousProject || !active) return structuredClone(channel);
        return mergePlaybackProjectEdits(active, previousProject, channel) as Channel;
      });
      this.playbackProjectChannels = structuredClone(update.channels);
    }

    // Re-resolve once after either source changed. With a declared length the
    // Pattern owns the boundary; without one, legacy content-derived takes still
    // follow channel edits. Song Mode stays on its bar-relative playlist grid.
    if ((update.channels || patternLengthChanged) && this.activePlayMode === 'pat') {
      this.transport?.setPatternLoopSteps(
        resolvePatternLoopLengthSteps(this.activeChannels, this.activePatternLengthSteps)
      );
    }

    if (update.clips) {
      // The scheduler never mutates clips; replacing this clone makes move,
      // resize, split and delete edits visible to the next scheduled step.
      this.resetAutomationTargetsForClipChanges(this.activeClips, update.clips);
      this.activeClips = structuredClone(update.clips);
      if (this.activePlayMode === 'song') {
        // A clip edit moves the arrangement's real end; the running take must
        // stop at the new end instead of a stale one.
        this.transport?.setSongEndSteps(this.resolveSongEndSteps());
      }
    }

    if (update.mixerTracks) {
      const previousProjectById = new Map(this.playbackProjectMixerTracks.map(track => [track.id, track]));
      const activeById = new Map(this.activeMixerTracks.map(track => [track.id, track]));
      const nextTracks = update.mixerTracks.map(track => {
        const previousProject = previousProjectById.get(track.id);
        const active = activeById.get(track.id);
        const projectChanged = !previousProject || !playbackValuesEqual(track, previousProject);
        const nextTrack = !previousProject || !active
          ? structuredClone(track)
          : mergePlaybackProjectEdits(active, previousProject, track) as MixerTrack;

        if (projectChanged) {
          // Phase 10B: when an in-flight track edit only touched slot.mix on
          // already-built FX slots, route the new mix values directly to the
          // live WetDry wrappers and skip the full chain rebuild. The active
          // track is updated so a future render/export sees the new values
          // and `applyAutomationValue` for fx_mix reads the same source.
          const mixDiff = previousProject ? trackOnlyMixChanged(previousProject, track) : { onlyMixChanged: false, mixChanges: [] };
          if (mixDiff.onlyMixChanged) {
            const now = this.ctx?.currentTime ?? 0;
            for (const change of mixDiff.mixChanges) {
              const slot = nextTrack.fxSlots.find(s => s.id === change.slotId);
              if (slot) slot.mix = change.mix;
              const registry = (this as unknown as {
                __liveFxChainRegistry?: {
                  applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
                };
              }).__liveFxChainRegistry;
              const updated = registry?.applyLiveMix(nextTrack.id, change.slotId, change.mix, now);
              // Fallback only if the live chain was not built (e.g. an offline
              // take) — in that case the offline renderer rebuilds per export.
              if (!updated && !this.isOfflineRendering) {
                this.updateMixerTrack(nextTrack);
                break;
              }
            }
          } else {
            this.updateMixerTrack(nextTrack);
          }
        }
        return nextTrack;
      });
      const nextTrackIds = new Set(update.mixerTracks.map(track => track.id));
      for (const trackId of this.activeMixerTracks.map(track => track.id)) {
        if (!nextTrackIds.has(trackId)) this.removeMixerChannel(trackId);
      }
      this.activeMixerTracks = nextTracks;
      this.playbackProjectMixerTracks = structuredClone(update.mixerTracks);
    }

    if (update.playlistTracks) {
      const previousMutes = this.playlistLaneMutes;
      const nextMutes = this.derivePlaylistLaneMutes(update.playlistTracks);
      // A lane muted mid-take goes silent at once: its in-flight clip audio is
      // cancelled and the scheduler stops triggering its pattern clips. The
      // routed mixer insert is left untouched so lanes and channels sharing it
      // keep sounding.
      for (const lane of nextMutes) {
        if (!previousMutes.has(lane)) this.stopActiveClipSourcesForLane(lane);
      }
      this.playlistLaneMutes = nextMutes;
      // Unmuting mid-take must not wait for a future start-bar trigger: the
      // lane's clip spanning the playhead restarts from the correct offset,
      // exactly like a seek landing inside it.
      if (this.activePlayMode === 'song') {
        const positionSeconds = this.transport?.getState().positionSeconds ?? 0;
        for (const lane of previousMutes) {
          if (nextMutes.has(lane)) continue;
          this.retriggerAudioClipsAtPosition(positionSeconds, lane);
        }
      }
    }
  }

  /** True only while the live transport owns an active playback take. */
  public isPlaybackActive(): boolean {
    return this.isPlaying;
  }

  public play(
    channels: Channel[],
    clips: PlaylistClip[],
    mode: 'pat' | 'song',
    patternId?: string,
    mixerTracks?: MixerTrack[],
    patternLengthSteps?: number,
    playlistTracks?: PlaylistTrack[]
  ) {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    // A new take tears down the previous take's audio without resetting the
    // transport position: Stop already resets it to bar one, Pause keeps it,
    // so Play resumes from wherever the playhead currently is.
    this.playbackGeneration++;
    this.stopActivePlaybackAudio();
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    const currentGeneration = this.playbackGeneration;

    const playbackSnapshot = this.createPlaybackSnapshot(channels, clips, mixerTracks ?? []);
    this.isPlaying = true;
    this.activeChannels = playbackSnapshot.channels;
    this.activeClips = playbackSnapshot.clips;
    this.activeMixerTracks = playbackSnapshot.mixerTracks;
    this.playlistLaneMutes = this.derivePlaylistLaneMutes(playlistTracks);
    this.playbackProjectChannels = structuredClone(playbackSnapshot.channels);
    this.playbackProjectMixerTracks = structuredClone(playbackSnapshot.mixerTracks);
    this.activePlayMode = mode;
    this.activePatternId = patternId;
    this.activePatternLengthSteps = patternLengthSteps;

    // Apply the current project mixer graph at transport start. Subsequent
    // mixer edits use synchronizePlaybackState and update only the changed
    // active track while the transport remains running.
    for (const track of this.activeMixerTracks) this.updateMixerTrack(track);

    if (!this.transport && this.ctx) {
      this.transport = new AudioClockTransport(this.ctx);
    }
    if (!this.transport) return;

    this.transport.setBpm(this.bpm);
    this.transport.setMode(mode);
    // Pattern Mode loops over the pattern length (16/32/64 steps); Song Mode
    // keeps the one-bar grid that playlist scheduling is built on.
    this.transport.setPatternLoopSteps(
      mode === 'pat'
        ? resolvePatternLoopLengthSteps(this.activeChannels, patternLengthSteps)
        : undefined
    );
    // Song Mode owns its real end from the active clip schedule; Pattern Mode
    // loops its declared length forever (Phase 9D).
    const songEndSteps = mode === 'song' ? this.resolveSongEndSteps() : null;
    this.transport.setSongEndSteps(songEndSteps ?? undefined);
    // Starting at or beyond the arrangement's real end restarts from the top.
    if (songEndSteps !== null) {
      const stepDurationSeconds = 60 / this.bpm / 4;
      if (this.transport.getState().positionSeconds >= songEndSteps * stepDurationSeconds - 1e-9) {
        this.transport.seek(0);
      }
    }
    if (this.transport.getState().playing) {
      // Replacing a running take must restart the scheduler loop cleanly.
      this.transport.stop(false);
    }
    this.transport.setCallbacks({
      onStep: (step, bar, audioTime) => {
        if (!this.isPlaying || this.playbackGeneration !== currentGeneration) return;

        this.currentStep = step;
        this.currentBar = bar;

        const secondsPerBeat = 60 / this.bpm;
        const secondsPerStep = secondsPerBeat / 4;
        const swingOffsetSeconds = step % 2 === 1
          ? (this.swing / 100) * (secondsPerStep * 0.4)
          : 0;

        this.triggerCurrentStep(audioTime + swingOffsetSeconds);

        if (this.stepCallback) {
          this.stepCallback(step, bar);
        }
      },
      onStateChange: (state) => {
        if (!this.isPlaying || this.playbackGeneration !== currentGeneration) return;
        this.transportStateCallback?.(state);
      },
      onSongEnd: () => {
        if (this.playbackGeneration !== currentGeneration) return;
        this.handleSongEnd();
      }
    });

    this.transport.start();

    // Resuming a take at a mid-arrangement position must restore the audio the
    // previous take silenced: playlist clips spanning the position restart
    // from their correct offset and automation is re-based instead of
    // latching the pre-pause value. A fresh start at position 0 leaves the
    // scheduler's first-bar triggers untouched.
    const resumedPositionSeconds = this.transport.getState().positionSeconds;
    if (resumedPositionSeconds > 0) {
      this.syncEnginePositionFromTransport();
      this.retriggerAudioClipsAtPosition(resumedPositionSeconds);
      this.rebaseAutomationAtPosition(resumedPositionSeconds);
    }
  }

 public stop() {
  this.isPlaying = false;
  this.playbackGeneration++;

  if (this.timerId) {
    clearTimeout(this.timerId);
    this.timerId = null;
  }

  if (this.transport) {
    this.transport.stop();
  }

  this.stopActivePlaybackAudio();

  this.currentStep = 0;
  this.currentBar = 1;
}

  /**
   * Pauses the live take at its current position: everything the transport
   * scheduled ahead — note voices and playlist clip sources — stops
   * immediately, while the transport keeps the exact position so Play resumes
   * from here. Transport actions never touch project data.
   */
  public pause(): void {
    if (!this.isPlaying || !this.transport) return;
    this.playbackGeneration++;
    this.stopActivePlaybackAudio();
    this.transport.pause();
    this.isPlaying = false;
    this.syncEnginePositionFromTransport();
    const state = this.transport.getState();
    this.transportStateCallback?.(state);
  }

  /**
   * Moves the playhead to `positionSeconds` in every transport state
   * (stopped, paused, playing). While playing, audio scheduled for the old
   * position is cancelled, playlist audio clips spanning the new position
   * restart from their correct offset, and automation is re-based so no
   * pre-seek value stays latched until the next step boundary.
   */
  public seek(positionSeconds: number): void {
    const transport = this.transport;
    if (!transport || !this.ctx) return;

    const boundedPosition = this.boundSeekPosition(positionSeconds);

    if (this.isPlaying) {
      this.stopActivePlaybackAudio();
    }
    transport.seek(boundedPosition);
    this.syncEnginePositionFromTransport();

    if (this.isPlaying) {
      this.retriggerAudioClipsAtPosition(boundedPosition);
      this.rebaseAutomationAtPosition(boundedPosition);
    }
    const state = transport.getState();
    this.transportStateCallback?.(state);
  }

  /** Stops every playlist clip source and note voice of the active take. */
  private stopActivePlaybackAudio(): void {
    for (const source of Array.from(this.activeClipSources)) {
      try { source.stop(); } catch (_) { /* already inactive */ }
      this.activeClipSources.delete(source);
    }
    this.activeClipSourceLanes.clear();

    const now = this.ctx?.currentTime;
    for (const voice of this.activeVoices.values()) {
      try {
        voice.stop(now);
      } catch (_) {
        // Continue stopping remaining voices even if one has already stopped.
      }
    }
    this.activeVoices.clear();
    this.activeDrumPadVoices.clear();
  }

  /** Keeps the engine's step/bar mirror aligned with the authoritative transport position. */
  private syncEnginePositionFromTransport(): void {
    const state = this.transport?.getState();
    if (!state) return;
    this.currentStep = state.step;
    this.currentBar = state.bar;
  }

  /**
   * Playlist lane rows muted in project state. Rows are array indices — the
   * same coordinate space as `PlaylistClip.trackIndex`. Clips whose row is
   * missing from the collection are never muted.
   */
  private derivePlaylistLaneMutes(tracks?: PlaylistTrack[]): Set<number> {
    const mutes = new Set<number>();
    if (!Array.isArray(tracks)) return mutes;
    tracks.forEach((track, index) => {
      if (track && track.mute === true) mutes.add(index);
    });
    return mutes;
  }

  /**
   * A clip is lane-muted when its playlist row is muted. Lane mute is enforced
   * at the trigger boundary — before the clip reaches its routed mixer insert —
   * so muting one lane can never silence another lane or a channel that shares
   * the same insert.
   */
  private isPlaylistLaneMuted(clip: PlaylistClip): boolean {
    if (this.playlistLaneMutes.size === 0) return false;
    if (!Number.isFinite(clip.trackIndex)) return false;
    return this.playlistLaneMutes.has(Math.floor(clip.trackIndex));
  }

  /** Silences one lane immediately: cancels that lane's in-flight clip audio only. */
  private stopActiveClipSourcesForLane(laneIndex: number): void {
    for (const source of Array.from(this.activeClipSources)) {
      if (this.activeClipSourceLanes.get(source) !== laneIndex) continue;
      try { source.stop(); } catch (_) { /* already inactive */ }
      this.activeClipSources.delete(source);
      this.activeClipSourceLanes.delete(source);
    }
  }

  /** Total steps the Song Mode arrangement occupies, or null when it has none. */
  private resolveSongEndSteps(): number | null {
    let endSteps = 0;
    for (const clip of this.activeClips) {
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      endSteps = Math.max(endSteps, (clip.startBar + clip.lengthBars) * 16);
    }
    return endSteps > 0 ? endSteps : null;
  }

  /** Song Mode seeks never land past the arrangement's real end. */
  private boundSeekPosition(positionSeconds: number): number {
    const next = Math.max(0, Number.isFinite(positionSeconds) ? positionSeconds : 0);
    if (this.activePlayMode !== 'song') return next;
    const endSteps = this.resolveSongEndSteps();
    if (endSteps === null) return next;
    const stepDurationSeconds = 60 / this.bpm / 4;
    return Math.min(next, endSteps * stepDurationSeconds);
  }

  /**
   * Starts every unmuted audio clip whose body spans `positionSeconds` so a
   * seek (or resume) into a clip restarts it from the correct offset instead
   * of waiting for — or missing — its start-bar trigger. A clip that begins
   * exactly at the position is left to the scheduler's start-bar trigger so
   * it can never sound twice.
   *
   * With `laneIndex` the sweep is limited to clips on that playlist row; it is
   * used when a lane is unmuted mid-take so only that lane's spanning clip
   * restarts. Without it (seek/resume), still-muted lanes are skipped.
   */
  private retriggerAudioClipsAtPosition(positionSeconds: number, laneIndex?: number): void {
    const ctx = this.ctx;
    if (!ctx || positionSeconds <= 0) return;
    const stepDurationSeconds = 60 / this.bpm / 4;
    const now = ctx.currentTime;
    for (const clip of this.activeClips) {
      if (clip.type !== 'audio' || clip.mute) continue;
      if (laneIndex === undefined) {
        if (this.isPlaylistLaneMuted(clip)) continue;
      } else {
        if (!Number.isFinite(clip.trackIndex) || Math.floor(clip.trackIndex) !== laneIndex) continue;
      }
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      const startSeconds = clip.startBar * 16 * stepDurationSeconds;
      const endSeconds = startSeconds + clip.lengthBars * 16 * stepDurationSeconds;
      if (positionSeconds <= startSeconds || positionSeconds >= endSeconds) continue;
      this.playAudioClipWithFades(clip, now, positionSeconds - startSeconds);
    }
  }

  /**
   * Writes the automation values at `positionSeconds` into the isolated take
   * so a seek does not leave the pre-seek value latched until the next
   * scheduled step re-evaluates the active clips.
   */
  private rebaseAutomationAtPosition(positionSeconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const secondsPerBar = 16 * (60 / this.bpm) / 4;
    const barPosition = positionSeconds / secondsPerBar;
    const now = ctx.currentTime;
    for (const clip of this.activeClips) {
      if (clip.type !== 'automation' || clip.mute || !clip.automationTarget) continue;
      if (!clip.automationPoints || clip.automationPoints.length < 2) continue;
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      if (barPosition < clip.startBar || barPosition > clip.startBar + clip.lengthBars) continue;
      const relX = (barPosition - clip.startBar) / clip.lengthBars;
      const value = this.interpolateAutomationCurve(clip.automationPoints, relX);
      this.applyAutomationValue(clip.automationTarget, value, this.activeChannels, this.activeMixerTracks, now);
    }
  }

  /** Song Mode reached its real end: halt the take exactly on the end position. */
  private handleSongEnd(): void {
    this.playbackGeneration++;
    this.stopActivePlaybackAudio();
    this.isPlaying = false;
    const state = this.transport?.getState();
    if (state) {
      this.currentStep = state.step;
      this.currentBar = state.bar;
      this.transportStateCallback?.(state);
    }
  }

  private triggerCurrentStep(audioTime?: number) {
    if (!this.ctx) return;
    const now = audioTime ?? this.ctx.currentTime;

    // Metronome on quarter notes (steps 0, 4, 8, 12)
    if (this.metronome && this.currentStep % 4 === 0) {
      const isDownbeat = this.currentStep === 0;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.setValueAtTime(isDownbeat ? 1400 : 880, now);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(this.masterGain || this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    }

    // Time FX Rhythmic Chopper & Gater
    if (this.grossBeatState.enabled && this.grossBeatNode) {
      const stepVal = this.grossBeatState.gateSteps[this.currentStep % 16];
      const targetGain = stepVal ? 1.0 : Math.max(0.01, 1.0 - (this.grossBeatState.mix * 0.95));
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setTargetAtTime(targetGain, now, 0.012);
    }

    if (this.activePlayMode === 'pat') {
      // Trigger all channel active steps
      this.activeChannels.forEach(channel => {
        if (channel.mute) return;

        // 1. Step sequencer trigger
        if (channel.steps && channel.steps[this.currentStep]) {
          const defaultPitch = channel.instrumentType === 'drumpad' ? 36 : 60;
          this.playNote(channel, {
            id: `seq-${channel.id}-${this.currentStep}`,
            pitch: defaultPitch,
            start: this.currentStep,
            duration: 1,
            velocity: 0.9
          }, now);
        }

        // 2. Piano roll notes starting on this step
        if (channel.notes) {
          channel.notes.forEach(note => {
            if (note.start === this.currentStep) {
              this.playNote(channel, note, now);
            }
          });
        }
      });
    } else {
      // Song mode: trigger clips in current bar
      const barIdx = this.currentBar - 1;
      const currentGlobalStep = (barIdx * 16) + this.currentStep;

      // 1. Evaluate automation clips at current bar & step
      this.activeClips.forEach(clip => {
        if (clip.type === 'automation' && !clip.mute && clip.automationTarget && clip.automationPoints && clip.automationPoints.length >= 2) {
          const currentTotalBar = barIdx + (this.currentStep / 16);
          if (currentTotalBar >= clip.startBar && currentTotalBar <= clip.startBar + clip.lengthBars) {
            const relX = (currentTotalBar - clip.startBar) / clip.lengthBars;
            const val = this.interpolateAutomationCurve(clip.automationPoints, relX);
            this.applyAutomationValue(clip.automationTarget, val, this.activeChannels, this.activeMixerTracks, now);
          }
        }
      });

      this.activeClips.forEach(clip => {
        if (clip.type === 'pattern') {
          const clipStartStep = clip.startBar * 16;
          const clipEndStep = clipStartStep + (clip.lengthBars * 16);

          if (currentGlobalStep >= clipStartStep && currentGlobalStep < clipEndStep) {
            const channel = this.activeChannels.find(c => c.id === clip.channelId);
            if (channel && !channel.mute && !this.isPlaylistLaneMuted(clip)) {
              const loopLength = resolvePlayableContentLengthSteps(channel);
              const stepOffset = clip.offsetSteps || 0;
              const relStep = ((currentGlobalStep - clipStartStep + stepOffset) % loopLength + loopLength) % loopLength;

              if (channel.steps && channel.steps[relStep]) {
                const defaultPitch = channel.instrumentType === 'drumpad' ? 36 : 60;
                this.playNote(channel, {
                  id: `song-${channel.id}-${relStep}`,
                  pitch: defaultPitch,
                  start: relStep,
                  duration: 1,
                  velocity: 0.9
                }, now);
              }
              if (channel.notes) {
                channel.notes.forEach(note => {
                  if (note.start === relStep) {
                    this.playNote(channel, note, now);
                  }
                });
              }
            }
          }
        } else if (clip.type === 'audio') {
          const clipStartStep = clip.startBar * 16;
          if (currentGlobalStep === clipStartStep && !clip.mute && !this.isPlaylistLaneMuted(clip)) {
            // Trigger audio clip at its start bar
            this.playAudioClipWithFades(clip, now);
          }
        }
      });
    }
  }

  /**
   * `positionOffsetSeconds` is how far into the clip the transport position
   * already is when the source is (re)started — 0 for the normal start-bar
   * trigger, and `position - clipStart` for seek/resume re-triggers. The
   * clip's own `offsetSteps` trim is applied first, so both compose.
   */
  private playAudioClipWithFades(clip: PlaylistClip, startTime: number, positionOffsetSeconds = 0) {
    if (!this.ctx) return;
    const buf = clip.audioBufferId ? this.sampleBuffers.get(clip.audioBufferId) : null;
    if (!buf) return;

    if (!Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) return;

    const safeBpm = Number.isFinite(this.bpm) && this.bpm > 0 ? this.bpm : 120;
    const secondsPerStep = (60 / safeBpm) / 4;
    const offsetSeconds =
      Math.max(0, (clip.offsetSteps || 0) * secondsPerStep) + Math.max(0, positionOffsetSeconds);

    if (offsetSeconds >= buf.duration) return;

    const clipDurationSec = clip.lengthBars * 4 * (60 / safeBpm);
    if (!Number.isFinite(clipDurationSec) || clipDurationSec <= 0.0005) return;

    const rate = Number.isFinite(clip.timeStretchRate) && (clip.timeStretchRate ?? 1) > 0 ? (clip.timeStretchRate ?? 1) : 1;
    const playDurationBufferSec = clipDurationSec * rate;
    const actualDurationBufferSec = Math.min(buf.duration - offsetSeconds, playDurationBufferSec);
    if (actualDurationBufferSec <= 0) return;

    const effectiveDuration = Math.min(clipDurationSec, actualDurationBufferSec / rate);
    if (effectiveDuration <= 0.0005) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buf;

    // Pitch shift / Playback rate
    if (clip.pitchShiftSemitones) {
      source.detune.setValueAtTime(clip.pitchShiftSemitones * 100, startTime);
    }
    if (clip.timeStretchRate) {
      source.playbackRate.setValueAtTime(clip.timeStretchRate, startTime);
    }

    const gainNode = this.ctx.createGain();

    // Safe fade envelope calculation: in and out cannot invert or exceed half duration
    const maxFade = effectiveDuration / 2;
    const secondsPerBar = (60 / safeBpm) * 4;
    const requestedFadeIn = Math.max(0, (clip.fadeInBars || 0) * secondsPerBar);
    const requestedFadeOut = Math.max(0, (clip.fadeOutBars || 0) * secondsPerBar);

    const minMicroFade = Math.min(0.002, maxFade);
    const fadeInSec = Math.min(maxFade, requestedFadeIn > 0 ? requestedFadeIn : minMicroFade);
    const fadeOutSec = Math.min(maxFade, requestedFadeOut > 0 ? requestedFadeOut : minMicroFade);

    const t0 = startTime;
    const t1 = startTime + fadeInSec;
    const t2 = Math.max(t1, startTime + effectiveDuration - fadeOutSec);
    const t3 = startTime + effectiveDuration;

    let mixerTrackId = Math.max(1, Math.floor(clip.trackIndex) + 1);
    let baseGain = 1.0;
    if (clip.channelId) {
      const ch = this.activeChannels.find(c => c.id === clip.channelId);
      if (ch) {
        if (Number.isFinite(ch.mixerTrackId)) {
          mixerTrackId = ch.mixerTrackId;
        }
        if (Number.isFinite(ch.volume)) {
          baseGain = Math.max(0, ch.volume);
        }
      }
    }

    const peakGain = Math.max(0.0001, baseGain);
    gainNode.gain.setValueAtTime(0.0001, t0);
    if (fadeInSec > 0.0001) {
      gainNode.gain.exponentialRampToValueAtTime(peakGain, t1);
    } else {
      gainNode.gain.setValueAtTime(peakGain, t0);
    }

    if (t2 > t1) {
      gainNode.gain.setValueAtTime(peakGain, t2);
    }

    if (fadeOutSec > 0.0001 && t3 > t2) {
      gainNode.gain.exponentialRampToValueAtTime(0.0001, t3);
    }

    source.connect(gainNode);
    const mixer = this.getOrCreateMixerChannel(mixerTrackId);
    gainNode.connect(mixer.input);

    source.start(startTime, offsetSeconds, actualDurationBufferSec);
    source.stop(startTime + effectiveDuration);

    // Keep the take's playlist audio under transport control: pause, seek and
    // stop cancel it instead of letting it keep playing as zombie audio.
    this.activeClipSources.add(source);
    if (Number.isFinite(clip.trackIndex)) {
      this.activeClipSourceLanes.set(source, Math.floor(clip.trackIndex));
    }
    source.addEventListener('ended', () => {
      this.activeClipSources.delete(source);
      this.activeClipSourceLanes.delete(source);
    }, { once: true });
  }

  /**
   * Fast offline Bounce-In-Place / Channel Render.
   *
   * The channel is read over its full playable length — the same
   * `resolvePlayableContentLengthSteps()` resolution Song Mode loops a pattern
   * clip with — so 32/64-step sequences and piano-roll notes past step 15 are
   * rendered instead of being cut to the first bar. The stem always contains
   * whole passes of that content and is at least `minBars` long.
   *
   * `bpm` is the project tempo; it must come from project state so the stem's
   * step spacing matches the arrangement grid. A non-finite value falls back to
   * the transport tempo, which App keeps in sync with `meta.bpm`. The rendered
   * length is returned so callers can derive `PlaylistClip.lengthBars` from the
   * audio that was actually produced instead of a fixed number.
   */
  public async bounceChannelToAudioClip(
    channel: Channel,
    bpm: number,
    minBars: number = 1
  ): Promise<{ buffer: AudioBuffer; waveform: number[]; lengthBars: number; bpm: number }> {
    const STEPS_PER_BAR = 16;
    const requestedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : this.bpm;
    const safeBpm = Math.max(20, Math.min(300, requestedBpm));
    const sampleRate = this.ctx?.sampleRate || 44100;

    const loopLengthSteps = resolvePlayableContentLengthSteps(channel);
    const loopLengthBars = loopLengthSteps / STEPS_PER_BAR;
    const safeMinBars = Number.isFinite(minBars) && minBars > 0 ? minBars : 1;
    const passes = Math.max(1, Math.ceil(safeMinBars / loopLengthBars));
    const lengthBars = passes * loopLengthBars;

    const stepDuration = (60 / safeBpm) / 4;
    const durationSec = lengthBars * STEPS_PER_BAR * stepDuration;

    // Bounce-In-Place is an offline scheduling/rendering operation, not a second
    // instrument DSP implementation. The existing timeline renderer already
    // drives InstrumentRegistry -> instrument renderer against OfflineAudioContext.
    // Disable arpeggiation and channel mute here to preserve the historical
    // bounce contract: this method renders the channel's own step/note content,
    // independent of live transport-only controls.
    const bounceChannel = {
      ...structuredClone(channel),
      arp: undefined,
      mute: false,
    };

    const renderedBuffer = await this.renderTimelineOffline(
      [bounceChannel],
      [],
      [],
      safeBpm,
      lengthBars,
      sampleRate,
      false,
      'pattern',
      undefined,
      loopLengthSteps,
      undefined,
      durationSec,
    );

    // The offline renderer is intentionally sized to the exact bounce duration
    // above, so the returned AudioBuffer remains contract-compatible with the
    // existing PlaylistClip lengthBars metadata.
    const waveform: number[] = [];
    const left = renderedBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(renderedBuffer.length / 32));
    for (let b = 0; b < 32; b += 1) {
      let max = 0;
      const offset = b * blockSize;
      for (let j = 0; j < blockSize && offset + j < renderedBuffer.length; j += 1) {
        max = Math.max(max, Math.abs(left[offset + j]));
      }
      waveform.push(Math.min(1.0, max * 1.5));
    }

    // Session-only convenience registration. The caller registers the buffer under
    // the clip's own asset id via setSampleBuffer (which is what gets persisted).
    const bufId = `bounced-${channel.id}-${Date.now()}`;
    this.sampleBuffers.set(bufId, renderedBuffer);

    return { buffer: renderedBuffer, waveform, lengthBars, bpm: safeBpm };
  }


  public getMasterLoudnessMetrics() {
    if (!this.masterAnalyser || !this.ctx) {
      return {
        momentaryLufs: -24,
        shortTermLufs: -24,
        integratedLufs: -14.2,
        truePeakDbfs: -6.0,
        lowBandReductionDb: 0,
        midBandReductionDb: 0,
        highBandReductionDb: 0,
        phaseCorrelation: 0.95,
        stereoSpread: 1.0,
        isClipping: false
      };
    }

    const bufferLength = this.masterAnalyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    this.masterAnalyser.getFloatTimeDomainData(dataArray);

    let sumSquares = 0;
    let peak = 0;
    let sumL = 0;
    let sumR = 0;
    let sumDot = 0;

    for (let i = 0; i < bufferLength; i++) {
      const val = dataArray[i];
      sumSquares += val * val;
      const absVal = Math.abs(val);
      if (absVal > peak) peak = absVal;

      // Simulated stereo correlation across channel bins
      const l = val;
      const r = i < bufferLength - 1 ? dataArray[i + 1] * 0.98 : val;
      sumL += l * l;
      sumR += r * r;
      sumDot += l * r;
    }

    const denom = Math.sqrt(sumL * sumR);
    const phaseCorrelation = denom > 1e-6 ? Math.max(-1.0, Math.min(1.0, sumDot / denom)) : 1.0;

    const rms = Math.sqrt(sumSquares / bufferLength);
    const dbfs = 20 * Math.log10(Math.max(1e-5, rms));
    const lufs = Math.max(-70, Math.min(0, dbfs - 0.691));
    const peakDbfs = 20 * Math.log10(Math.max(1e-5, peak));

    return {
      momentaryLufs: Number(lufs.toFixed(1)),
      shortTermLufs: Number((lufs * 0.95).toFixed(1)),
      integratedLufs: Number((lufs * 0.92).toFixed(1)),
      truePeakDbfs: Number(peakDbfs.toFixed(1)),
      lowBandReductionDb: peakDbfs > -3 ? Number((peakDbfs + 3).toFixed(1)) : 0,
      midBandReductionDb: peakDbfs > -6 ? Number(((peakDbfs + 6) * 0.7).toFixed(1)) : 0,
      highBandReductionDb: peakDbfs > -4 ? Number(((peakDbfs + 4) * 0.5).toFixed(1)) : 0,
      phaseCorrelation: Number(phaseCorrelation.toFixed(2)),
      stereoSpread: Number((1.0 - Math.abs(phaseCorrelation - 1.0) * 0.5).toFixed(2)),
      isClipping: peak >= 0.99
    };
  }

  // Generate Goniometer / Lissajous vector points for 2D stereo phase scope
  public getStereoVectors(numPoints: number = 64): { x: number; y: number }[] {
    if (!this.masterAnalyser) return [];
    const bufferLength = this.masterAnalyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    this.masterAnalyser.getFloatTimeDomainData(dataArray);

    const step = Math.max(1, Math.floor(bufferLength / numPoints));
    const points: { x: number; y: number }[] = [];

    for (let i = 0; i < numPoints; i++) {
      const idx = i * step;
      const l = dataArray[idx] || 0;
      const r = (dataArray[idx + 1] || dataArray[idx]) * 0.95;
      
      // Rotate 45 degrees: M = (L+R)/sqrt(2) (vertical), S = (L-R)/sqrt(2) (horizontal)
      const x = (l - r) * 0.7071;
      const y = (l + r) * 0.7071;
      points.push({ x, y });
    }

    return points;
  }

  // Real-time timeline tape scrub audition sound synthesis
  public playTimelineScrubSound(bar: number, speedMultiplier: number = 1.0) {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    // Analog tape scrub pitch calculation based on bar and scrub speed
    const baseFreq = 110 * Math.pow(2, ((bar % 12) + 24) / 12);
    const scrubPitch = Math.max(60, Math.min(3000, baseFreq * speedMultiplier));

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(scrubPitch, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, scrubPitch * 0.4), now + 0.08);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(Math.min(4000, scrubPitch * 1.5), now);
    filter.Q.value = 3.0;

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(filter);
    filter.connect(gain);
    if (this.masterGain) {
      gain.connect(this.masterGain);
    } else {
      gain.connect(ctx.destination);
    }

    osc.start(now);
    osc.stop(now + 0.09);
  }
}

export const audioEngine = new AudioEngine();
