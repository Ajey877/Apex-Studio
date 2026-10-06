export type ViewMode = 
  | 'channel_rack' 
  | 'piano_roll' 
  | 'playlist' 
  | 'mixer' 
  | 'instruments' 
  | 'sampler' 
  | 'clip_matrix'
  | 'collaboration' 
  | 'analytics' 
  | 'settings';

export type PlayMode = 'pat' | 'song';

export type InstrumentType = 
  | 'minisynth' 
  | 'fmsynth' 
  | 'drumpad' 
  | 'wavetable' 
  | 'sampler' 
  | 'grand_piano'
  | 'rhodes_epiano'
  | 'hammond_organ'
  | 'harpsichord'
  | 'nylon_guitar'
  | 'strings_ensemble'
  | 'pizzicato_strings'
  | 'cinematic_brass'
  | 'acid_303'
  | 'reese_bass'
  | 'sub_808'
  | 'slap_bass'
  | 'supersaw_lead'
  | 'ambient_pad'
  | 'vox_choir'
  | 'marimba_bell'
  | 'fm_bell'
  | 'chiptune_8bit'
  | 'independent_pluck';

export type FxType = 
  | 'equalizer' 
  | 'reverb' 
  | 'delay' 
  | 'distortion' 
  | 'compressor' 
  | 'chorus' 
  | 'bitcrusher' 
  | 'limiter'
  | 'tape_saturation';

export interface Note {
  id: string;
  pitch: number; // MIDI note number 0-127 (e.g. 60 = C4)
  start: number; // in steps (16th notes or fractional steps)
  duration: number; // in steps
  velocity: number; // 0 - 1.0
  pan?: number; // -1.0 to 1.0
  muted?: boolean;
}

export type ChordVoicing = 'root' | 'inversion1' | 'inversion2' | 'inversion3' | 'drop2' | 'open_spread';

/**
 * Phase 57: Gross Beat is an amplitude gate, not a time/pitch processor.
 * The engine gates the master bus gain on a 16-step grid; there is no
 * time-stretch, pitch-shift, half-time or tape processing to configure.
 */
export interface GrossBeatState {
  enabled: boolean;
  mix: number; // 0 - 1.0 gate depth
  gateSteps: boolean[]; // 16 steps
}

export interface SidechainSettings {
  enabled: boolean;
  sourceTrackId: number; // Mixer track ID of trigger (e.g. 1 for Kick)
  /**
   * Phase 79: the following three fields were previously exposed in the UI
   * and persisted, but the engine's sidechain ducking is note-triggered, not
   * level-detected — there is no threshold detector, no frequency-selective
   * ducking, and no detector high-pass. They are preserved here as OPTIONAL
   * fields for backward-compat loading; normalizeProjectState strips them
   * from the normalized ProjectState so they no longer survive a save/load
   * round-trip into the active document. They will return if a Phase 88
   * level-detected sidechain compressor is implemented.
   */
  /** @deprecated Obsolete Phase 79 — persisted from an inert UI control; stripped on load. */
  threshold?: number;
  amount: number; // 0 to 1.0 (ducking depth)
  attackMs: number; // 1 to 50 ms
  releaseMs: number; // 20 to 500 ms
  /** @deprecated Obsolete Phase 79 — persisted from an inert UI control; stripped on load. */
  lowFreqOnly?: boolean;
  /** @deprecated Obsolete Phase 79 — persisted from an inert UI control; stripped on load. */
  highPassFilterHz?: number;
}

export interface TakeRegion {
  id: string;
  takeIndex: number;
  startStep: number;
  lengthSteps: number;
  isSelected: boolean;
  color: string;
  name?: string;
}

export interface TakeLane {
  id: string;
  name: string;
  waveform: number[];
  takeIndex: number;
  timestamp: number;
  color: string;
  rating?: number; // 1 to 5 stars
  isMuted?: boolean;
}

export interface PolyphonicBlob {
  id: string;
  originalPitch: number; // MIDI note (e.g. 64 = E4)
  targetPitch: number; // Corrected MIDI note
  startStep: number;
  durationSteps: number;
  amplitude: number;
  formantShift: number; // semitones (-12 to +12)
  pitchDriftAmount: number; // 0 to 1
  vibratoDepth: number; // 0 to 1
  color: string;
}

export type WarpMode = 'beats' | 'tones' | 'texture' | 'complex_pro' | 'repitch';

/**
 * Phase 79: SpatialAudioSettings is retained as a type-only export for
 * backward-compat hydration (normalizeProjectState needs to recognise the
 * shape to strip it from legacy clips). No mixer/instrument/clip DSP reads
 * it, and no UI edits it. It will not round-trip into normalized state.
 */
export interface SpatialAudioSettings {
  enabled: boolean;
  azimuthDeg: number;
  elevationDeg: number;
  distanceMeters: number;
  binauralRoomSize: 'studio_dry' | 'concert_hall' | 'cathedral' | 'cinema_atmos';
  lfeSubLevel: number;
  spread: number;
}

export interface VideoScoringTrack {
  enabled: boolean;
  videoUrl?: string;
  videoName?: string;
  smpteOffsetFps: 24 | 25 | 29.97 | 30; // SMPTE Timecode frame rate
  smpteStartHours: number;
  smpteStartMinutes: number;
  smpteStartSeconds: number;
  smpteStartFrames: number;
  hitPoints: Array<{ id: string; bar: number; name: string; type: 'dialogue' | 'hit' | 'cue' | 'transition'; color: string }>;
}

export interface MpeNoteExpression {
  noteId: string;
  pitchBendCurve: Array<{ timeStep: number; semitones: number }>; // -48 to +48 per-note bend
  pressureCurve: Array<{ timeStep: number; pressure: number }>; // 0 to 1 aftertouch
  slideTimbreCurve: Array<{ timeStep: number; timbre: number }>; // 0 to 1 CC74 brightness
}

export interface AutomationPoint {
  x: number; // 0 to 1 normalized along clip length or bar position
  y: number; // 0 to 1 normalized parameter value
  tension?: number; // -1 to 1 bezier tension (-1 log, 0 linear, +1 exp)
  lfoRateHz?: number; // If modulated by LFO
  lfoDepth?: number;
}

export type AutomationTargetType = 
  | 'channel_vol' 
  | 'channel_pan' 
  | 'channel_filter_cutoff' 
  | 'channel_filter_res'
  | 'channel_pitch'
  | 'mixer_vol' 
  | 'mixer_pan' 
  | 'fx_mix' 
  /**
   * Phase 81: any parameter the FX contract (`fxParameterContract.ts`) owns on
   * a mixer insert slot, including the slot's wet/dry mix.
   *
   * Addressing: `targetId` is the composite `"<mixerTrackId>/<fxSlotId>"` and
   * `paramName` is the contract slot-param id (`'lowFreq'`, `'threshold'`,
   * `'time'`, `'ceiling'`, … , or `'mix'`). The composite id pins the track, so
   * a deleted or replaced slot resolves to nothing instead of silently driving
   * a different insert. `fxParameterControl.resolveFxParameterUpdate` is the
   * single resolver; the legacy bare-slot-id form is accepted there for
   * pre-Phase 81 documents but is never written by the UI.
   *
   * `fx_mix` is retained unchanged: it addresses `targetId` = mixer track id
   * (number) and `paramName` = slot id, and existing projects keep using it.
   */
  | 'fx_param'
  | 'master_vol';

export interface ArpSettings {
  enabled: boolean;
  mode: 'up' | 'down' | 'updown' | 'random' | 'chord_strum' | 'euclidean';
  rate: '1/4' | '1/8' | '1/16' | '1/32' | '1/8t' | '1/16t';
  octaves: number; // 1 to 4
  gate: number; // 0.1 to 1.5
  swing: number; // 0 to 1.0
  strumMs: number; // 0 to 50ms
  euclideanSteps?: number; // e.g. 16
  euclideanHits?: number; // e.g. 5
  euclideanRotate?: number; // e.g. 0
}

export interface SampleZone {
  id: string;
  sampleId: string;
  lowNote: number;
  highNote: number;
  rootNote: number;
  lowVelocity: number;
  highVelocity: number;
  tuneSemitones: number;
  trimStart?: number;
  trimEnd?: number;
  reverse?: boolean;
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number;
}

export interface CustomSampleData {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  waveformPeaks: number[];
  blob?: Blob;
  url?: string;
  /**
   * Set by project hydration when this sample's persisted audio could not be
   * restored. Mirrors `PlaylistClip.audioUnavailable`: the project keeps the
   * reference so the user can see (and recover) the missing asset; the audio
   * itself is never fabricated.
   */
  audioUnavailable?: boolean;
  trimStart?: number; // 0 to 1
  trimEnd?: number; // 0 to 1
  normalize?: boolean;
  reverse?: boolean;
  rootPitch?: number; // default 60 (C4)
  /** Phase 19: reusable library organization metadata. */
  packId?: string;
  category?: string;
  tags?: string[];
}

export interface SamplePack {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags: string[];
  created: number;
  updated: number;
}

export interface DrumPad {
  id: string;
  note: number;
  name: string;
  sampleId: string;
  volume: number;
  pan: number;
  tuneSemitones: number;
  trimStart?: number;
  trimEnd?: number;
  reverse?: boolean;
  loop?: boolean;
  chokeGroup?: number;
}

export interface Channel {
  id: string;
  name: string;
  color: string;
  instrumentType: InstrumentType;
  mixerTrackId: number; // 0 = Master, 1-8 = Inserts
  volume: number; // 0 - 1.0
  pan: number; // -1.0 to 1.0
  pitch: number; // semitones offset (-12 to +12)
  mute: boolean;
  solo: boolean;
  steps: boolean[]; // Channel-scoped sequencer data; typically 16/32, may preserve later steps
  stepVelocities?: number[];
  notes: Note[]; // Notes for piano roll
  synthParams: SynthParameters;
  sampleUrl?: string;
  sampleName?: string;
  customSample?: CustomSampleData;
  sampleZones?: SampleZone[];
  drumPads?: DrumPad[];
  arp?: ArpSettings;
}

export interface SynthParameters {
  // MiniSynth (Subtractive)
  osc1Type: OscillatorType;
  osc1Octave: number;
  osc1Detune: number;
  osc1Mix: number;
  
  osc2Type: OscillatorType;
  osc2Octave: number;
  osc2Detune: number;
  osc2Mix: number;

  filterType: BiquadFilterType;
  filterCutoff: number; // 20 - 20000 Hz
  filterResonance: number; // 0 - 20
  filterEnvAmount: number; // 0 - 1.0

  attack: number; // seconds
  decay: number;
  sustain: number; // 0 - 1.0
  release: number; // seconds

  lfoRate: number; // Hz
  lfoDepth: number; // 0 - 1.0
  lfoTarget: 'pitch' | 'filter' | 'volume' | 'none';

  // Wavetable & Unison (preview-only modal controls; not in DSP. Phase 79:
  // unisonSpread dropped — was persisted into synthParams but no consumer
  // ever read it. Voices/Detune kept on the type because the wavetable
  // modal's local UI state and future wavetable phases may reference them;
  // they are preview-only and not read by any audio engine consumer today.)
  unisonVoices?: number; // 1 to 7 voices
  unisonDetune?: number; // 0 to 50 cents

  // FM Synth
  fmCarrierMultiplier: number;
  fmModulatorMultiplier: number;
  fmModulationIndex: number;
  fmFeedback: number;

  // Sampler
  sampleRootNote: number;
  sampleGlide: number;
  sampleReverse: boolean;
  sampleLoop: boolean;
  sampleDrive: number;
}

export interface VocalTunerSettings {
  enabled: boolean;
  scale: MusicalScale;
  rootKey: number; // 0 = C, 1 = C#, etc.
  retuneSpeedMs: number; // 0 (hard snap / T-Pain) to 80 (natural)
  formantShift: number; // -12 to +12 semitones
  vibratoDepth: number; // 0 to 1.0
  humanize: number; // 0 to 1.0
}

export interface PlaylistClip {
  id: string;
  trackIndex: number; // Playlist track row (0-15)
  startBar: number; // Start in bars (1 bar = 16 steps)
  lengthBars: number; // Duration in bars
  type: 'pattern' | 'audio' | 'automation';
  patternId?: string; // If type is pattern
  channelId?: string;
  audioBufferId?: string;
  audioName?: string;
  audioWaveform?: number[]; // Normalized peaks for rendering
  audioUnavailable?: boolean;
  color: string;
  name: string;
  offsetSteps?: number;
  mute?: boolean;
  // Audio clip processing & crossfades
  pitchShiftSemitones?: number; // -24 to +24 semitones
  timeStretchRate?: number; // 0.5x to 2.0x
  fadeInBars?: number; // 0 to 1 bar
  fadeOutBars?: number; // 0 to 1 bar
  warpMode?: WarpMode; // Beats, Tones, Texture, Complex Pro
  // Phase 79: spatialAudio was persisted on clips but no DSP consumer, no
  // UI editor, no playback code ever read it. Removed from the type;
  // normalizeProjectState strips it from legacy documents on load so old
  // files still parse without carrying dead data.
  // Automation specific
  automationTarget?: {
    type: AutomationTargetType;
    targetId: string | number; // channel id or mixer track id
    paramName?: string;
    label?: string;
  };
  automationPoints?: AutomationPoint[];
}

export interface MultibandBandSettings {
  enabled: boolean;
  gain: number; // dB (-12 to +12)
  threshold: number; // dB (-48 to 0)
  ratio: number; // 1 to 20
  attack: number; // ms
  release: number; // ms
  knee: number; // dB
  solo: boolean;
  mute: boolean;
}

export interface MasteringSuiteState {
  enabled: boolean;
  // Multiband Crossover Frequencies
  lowCrossFreq: number; // Hz (e.g. 150)
  highCrossFreq: number; // Hz (e.g. 3500)
  lowBand: MultibandBandSettings;
  midBand: MultibandBandSettings;
  highBand: MultibandBandSettings;
  // Stereo Imager
  monoSubFreq: number; // Hz (e.g. 120 - sum to mono below this)
  stereoSpread: number; // 0 (mono) to 2.0 (super-wide)
  // Maximizer / Brickwall Limiter
  maximizerThreshold: number; // dB (-12 to 0)
  maximizerCeiling: number; // dB (-1.0 to 0.0)
  maximizerRelease: number; // ms (10 to 500)
  maximizerLookahead: boolean;
  // Metering Targets
  lufsTarget: number; // -14 for Spotify / Youtube, -9 for Club / Beatport
}

/**
 * Why a master measurement is unavailable. Kept explicit so the UI can say
 * "not measured" instead of quietly displaying a plausible number.
 * - `measured`: at least one real block of master audio has been analysed.
 * - `no-audio`: the engine ran but the master bus carried only silence.
 * - `engine-idle`: no audio context / measurement tap exists yet.
 * - `offline-render`: a bounce owns the graph; live meters must not read it.
 */
export type MasterMeasurementAvailability =
  | 'measured'
  | 'no-audio'
  | 'engine-idle'
  | 'offline-render';

/**
 * Snapshot of genuine master-bus measurements (Phase 45).
 *
 * Nullability is the contract: `null` means "this was not measured", and no
 * consumer may render one of these fields as a result, a status, or a pass.
 */
export interface MasterMeasurementSnapshot {
  // --- ITU-R BS.1770-4 loudness (K-weighted, gated) ---
  momentaryLufs: number | null;
  shortTermLufs: number | null;
  integratedLufs: number | null;
  /** Complete 400 ms gating blocks produced since the last reset. */
  blockCount: number;
  /** Blocks that survived the absolute and relative gates. */
  gatedBlockCount: number;
  /** Seconds of master audio actually measured. */
  measuredSeconds: number;
  /** False until 3 s of blocks exist, i.e. while short-term is not yet a 3 s figure. */
  shortTermReady: boolean;

  // --- Inter-sample peaks (never a plain sample peak) ---
  truePeakDbfs: number | null;
  truePeakLeftDbfs: number | null;
  truePeakRightDbfs: number | null;
  /** Largest raw sample magnitude, kept separate so the two cannot be confused. */
  samplePeakDbfs: number | null;
  /** Oversampling factor the detector actually used; null when there was no
   * detector to ask, never a default that implies a measurement happened. */
  oversampleFactor: number | null;
  headroomDb: number | null;
  /** Null when undecidable; true only when the reconstructed peak reaches 0 dBFS. */
  isClipping: boolean | null;

  // --- Stereo field from an independent L/R tap ---
  phaseCorrelation: number | null;
  sideMidRatioDb: number | null;
  midPowerDbfs: number | null;
  sidePowerDbfs: number | null;

  // --- Measurement provenance ---
  /** True while the engine is actively consuming master audio. */
  isPumping: boolean;
  /** Samples the pump could not read (e.g. a throttled tab); never guessed. */
  droppedSampleCount: number;
  sampleRate: number | null;
  availability: MasterMeasurementAvailability;
}

/** Latency reported by the live audio context, with unknowns left unknown. */
export interface AudioLatencyMetrics {
  sampleRate: number;
  baseLatencySeconds: number | null;
  outputLatencySeconds: number | null;
  renderQuantumSamples: number;
  renderQuantumSeconds: number;
}

export interface PlaylistTrack {
  id: number;
  name: string;
  color: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  height?: 'compact' | 'normal' | 'large';
  armedForRecord?: boolean;
}

export interface Pattern {
  id: string;
  name: string;
  color: string;
  lengthSteps: number; // usually 16, 32, or 64
}

export interface FxSlot {
  id: string;
  type: FxType;
  name: string;
  enabled: boolean;
  mix: number; // Wet/Dry 0 - 1.0
  params: Record<string, number | string | boolean>;
}

export interface MixerTrack {
  id: number; // 0 is Master, 1-8+ are inserts, 9+ can be sub-busses / sends
  name: string;
  color: string;
  volume: number; // 0 - 1.25 (1.0 = 0dB)
  pan: number; // -1.0 to 1.0
  mute: boolean;
  solo: boolean;
  /**
   * Phase 79: stereoWidth was persisted on every mixer track and populated by
   * presets, but no DSP consumer, no UI control, and no live-sync path ever
   * read it. It is retained as OPTIONAL for backward-compat (old project
   * files still have it); normalizeProjectState strips it from the
   * normalized active ProjectState so it does not survive a save/load cycle.
   * If a future stereo-widener phase implements this, it will re-add the
   * field with a real consumer and a UI control.
   * @deprecated Obsolete Phase 79 — persisted inert value; stripped on load.
   */
  stereoWidth?: number;
  fxSlots: FxSlot[];
  peakL: number;
  peakR: number;
  sidechain?: SidechainSettings;
  routingTargetId?: number; // 0 = Master, or id of sub-group track
  sends?: {
    send1: number; // 0 to 1.0 (e.g. Reverb Aux)
    send2: number; // 0 to 1.0 (e.g. Delay Aux)
  };
}

export interface ProjectMetadata {
  id: string;
  name: string;
  author: string;
  bpm: number;
  timeSignature: [number, number]; // [4, 4]
  swing: number; // 0 - 1.0
  masterVolume: number;
  masterPitch: number;
  created: number;
  updated: number;
  version: string;
  offlineReady: boolean;
  totalEditTimeSeconds: number;
}

export interface CollabComment {
  id: string;
  author: string;
  avatarColor: string;
  timestamp: number;
  barPosition: number;
  text: string;
  resolved: boolean;
}

export interface CollabUser {
  id: string;
  name: string;
  color: string;
  avatar: string;
  role: 'Admin' | 'Producer' | 'Vocalist' | 'Mixing Engineer' | 'Guest';
  status: 'online' | 'editing' | 'idle';
  currentTrack?: string;
  lastActive: string;
}

export interface MidiMapping {
  ccNumber: number;
  targetType: 'channel_vol' | 'channel_pan' | 'mixer_vol' | 'mixer_pan' | 'fx_param' | 'master_vol';
  targetId: string | number;
  paramName?: string;
}

export interface AudioRecording {
  id: string;
  name: string;
  timestamp: number;
  durationSeconds: number;
  waveform: number[];
  audioBufferId?: string;
  audioBlob?: Blob;
  audioUrl?: string;
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
  manufacturer?: string;
  state: string;
  type: 'input' | 'output';
}

export type MusicalScale = 
  | 'major' 
  | 'minor' 
  | 'harmonic_minor' 
  | 'melodic_minor' 
  | 'dorian' 
  | 'phrygian' 
  | 'lydian' 
  | 'mixolydian' 
  | 'locrian' 
  | 'pentatonic_minor' 
  | 'pentatonic_major' 
  | 'blues' 
  | 'japanese_hirajoshi' 
  | 'arabic_double_harmonic' 
  | 'whole_tone';

export type ChordStampType = 
  | 'none'
  | 'major_triad'
  | 'minor_triad'
  | 'sus2'
  | 'sus4'
  | 'diminished'
  | 'augmented'
  | 'maj7'
  | 'min7'
  | 'dom7'
  | 'min_maj7'
  | 'maj9'
  | 'min9'
  | 'octave_double'
  | 'power_chord_5';

export interface ParametricEqBand {
  id: number;
  type: 'highpass' | 'lowshelf' | 'peaking' | 'highshelf' | 'lowpass';
  frequency: number; // Hz (20 to 20000)
  gain: number; // dB (-18 to +18)
  q: number; // 0.1 to 18
  enabled: boolean;
  color: string;
}

export interface ArrangementMarker {
  id: string;
  name: string; // e.g. "Intro", "Verse", "Build", "Drop", "Chorus", "Bridge", "Outro"
  bar: number; // 0-indexed or 1-indexed bar position (e.g. 1, 9, 17, 33)
  color: string; // Hex badge color
}

export interface MasterMacroKnob {
  id: string;
  name: string;
  value: number; // 0 to 1
  color: string;
  mappings: Array<{
    targetType: 'channel_volume' | 'channel_pan' | 'mixer_volume' | 'mixer_pan' | 'filter_cutoff' | 'reverb_wet' | 'delay_feedback';
    targetId: string | number;
    min: number;
    max: number;
    curve?: 'linear' | 'exponential' | 'logarithmic';
  }>;
}

export interface StemSeparationResult {
  vocalsBlobUrl?: string;
  drumsBlobUrl?: string;
  bassBlobUrl?: string;
  otherBlobUrl?: string;
  originalFileName: string;
  durationSeconds: number;
}

export interface ProjectState {
  meta: ProjectMetadata;
  patterns: Pattern[];
  selectedPatternId: string;
  /** Persistent metadata for every imported sample available to the project. */
  sampleLibrary?: CustomSampleData[];
  /** Phase 19: persistent reusable sample-pack metadata. */
  samplePacks?: SamplePack[];
  channels: Channel[];
  selectedChannelId: string;
  playlistTracks: PlaylistTrack[];
  playlistClips: PlaylistClip[];
  mixerTracks: MixerTrack[];
  selectedMixerTrackId: number;
  nextMixerTrackId: number;
  recordings: AudioRecording[];
  comments: CollabComment[];
  collaborators: CollabUser[];
  midiMappings: MidiMapping[];
  connectedMidiDevices?: MidiDeviceInfo[];
  markers?: ArrangementMarker[];
  /**
   * Phase 54: playlist timeline length in bars — the single authority for
   * playlist clip bounds and the export render window.
   *
   * Optional in the type so project documents written before this phase still
   * load; `normalizeProjectState` always resolves it to a concrete, legal
   * length (`DEFAULT_TIMELINE_BARS` when absent), and revalidates the
   * arrangement against it.
   */
  totalBars?: number;
  vocalTuner?: VocalTunerSettings;
  /**
   * Phase 79: Gross Beat gate state owned by the project. Hydrated into the
   * engine on project load; mutated through the same macro-rack bridge
   * pattern as Phase 51 master macros so save/load, undo/redo, and project
   * replacement all round-trip the gate pattern correctly.
   */
  grossBeatState?: GrossBeatState;
  macroKnobs?: MasterMacroKnob[];
  /** UI-only persistence marker for an acknowledged missing-audio warning. */
  dismissedMissingAudioSignature?: string;
}
