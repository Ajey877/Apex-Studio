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
  | 'vst_custom'
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
  | 'chiptune_8bit';

export type FxType = 
  | 'equalizer' 
  | 'reverb' 
  | 'delay' 
  | 'distortion' 
  | 'compressor' 
  | 'chorus' 
  | 'bitcrusher' 
  | 'limiter'
  | 'tape_saturation'
  | 'gross_beat';

export interface Note {
  id: string;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  pan?: number;
  muted?: boolean;
}

export type ChordVoicing = 'root' | 'inversion1' | 'inversion2' | 'inversion3' | 'drop2' | 'open_spread';

export interface GrossBeatState {
  enabled: boolean;
  preset: 'half_time' | 'tape_stop' | 'trance_gate' | 'sidechain_pump' | 'triplet_chopper' | 'stutter_32' | 'scratch_slow' | 'reverse';
  mix: number;
  speed: 0.5 | 1.0 | 2.0;
  tapeStopActive: boolean;
  tapeStopDurationMs: number;
  gateSteps: boolean[];
  pitchShiftSemitones: number;
}

export interface SidechainSettings {
  enabled: boolean;
  sourceTrackId: number;
  threshold: number;
  amount: number;
  attackMs: number;
  releaseMs: number;
  lowFreqOnly: boolean;
  highPassFilterHz?: number;
  gainReductionDb?: number;
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
  rating?: number;
  isMuted?: boolean;
}

export interface PolyphonicBlob {
  id: string;
  originalPitch: number;
  targetPitch: number;
  startStep: number;
  durationSteps: number;
  amplitude: number;
  formantShift: number;
  pitchDriftAmount: number;
  vibratoDepth: number;
  color: string;
}

export type WarpMode = 'beats' | 'tones' | 'texture' | 'complex_pro' | 'repitch';

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
  smpteOffsetFps: 24 | 25 | 29.97 | 30;
  smpteStartHours: number;
  smpteStartMinutes: number;
  smpteStartSeconds: number;
  smpteStartFrames: number;
  hitPoints: Array<{ id: string; bar: number; name: string; type: 'dialogue' | 'hit' | 'cue' | 'transition'; color: string }>;
}

export interface MpeNoteExpression {
  noteId: string;
  pitchBendCurve: Array<{ timeStep: number; semitones: number }>;
  pressureCurve: Array<{ timeStep: number; pressure: number }>;
  slideTimbreCurve: Array<{ timeStep: number; timbre: number }>;
}

export interface AutomationPoint {
  x: number;
  y: number;
  tension?: number;
  lfoRateHz?: number;
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
  | 'master_vol';

export interface ArpSettings {
  enabled: boolean;
  mode: 'up' | 'down' | 'updown' | 'random' | 'chord_strum' | 'euclidean';
  rate: '1/4' | '1/8' | '1/16' | '1/32' | '1/8t' | '1/16t';
  octaves: number;
  gate: number;
  swing: number;
  strumMs: number;
  euclideanSteps?: number;
  euclideanHits?: number;
  euclideanRotate?: number;
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
  trimStart?: number;
  trimEnd?: number;
  normalize?: boolean;
  reverse?: boolean;
  rootPitch?: number;
}

export interface Channel {
  id: string;
  name: string;
  color: string;
  instrumentType: InstrumentType;
  mixerTrackId: number;
  volume: number;
  pan: number;
  pitch: number;
  mute: boolean;
  solo: boolean;
  steps: boolean[];
  stepVelocities?: number[];
  notes: Note[];
  synthParams: SynthParameters;
  sampleUrl?: string;
  sampleName?: string;
  customSample?: CustomSampleData;
  arp?: ArpSettings;
}

export interface SynthParameters {
  osc1Type: OscillatorType;
  osc1Octave: number;
  osc1Detune: number;
  osc1Mix: number;
  osc2Type: OscillatorType;
  osc2Octave: number;
  osc2Detune: number;
  osc2Mix: number;
  filterType: BiquadFilterType;
  filterCutoff: number;
  filterResonance: number;
  filterEnvAmount: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  lfoRate: number;
  lfoDepth: number;
  lfoTarget: 'pitch' | 'filter' | 'volume' | 'none';
  unisonVoices?: number;
  unisonDetune?: number;
  unisonSpread?: number;
  fmCarrierMultiplier: number;
  fmModulatorMultiplier: number;
  fmModulationIndex: number;
  fmFeedback: number;
  sampleRootNote: number;
  sampleGlide: number;
  sampleReverse: boolean;
  sampleLoop: boolean;
  sampleDrive: number;
}

export interface VocalTunerSettings {
  enabled: boolean;
  scale: MusicalScale;
  rootKey: number;
  retuneSpeedMs: number;
  formantShift: number;
  vibratoDepth: number;
  humanize: number;
}

export interface PlaylistClip {
  id: string;
  trackIndex: number;
  startBar: number;
  lengthBars: number;
  type: 'pattern' | 'audio' | 'automation';
  patternId?: string;
  channelId?: string;
  audioBufferId?: string;
  audioName?: string;
  audioWaveform?: number[];
  /** Base64 payload used for portable project persistence of recorded/imported audio. */
  audioDataBase64?: string;
  /** Original MIME type for audioDataBase64 decoding. */
  audioMimeType?: string;
  color: string;
  name: string;
  offsetSteps?: number;
  mute?: boolean;
  pitchShiftSemitones?: number;
  timeStretchRate?: number;
  fadeInBars?: number;
  fadeOutBars?: number;
  warpMode?: WarpMode;
  spatialAudio?: SpatialAudioSettings;
  automationTarget?: {
    type: AutomationTargetType;
    targetId: string | number;
    paramName?: string;
    label?: string;
  };
  automationPoints?: AutomationPoint[];
}

export interface MultibandBandSettings {
  enabled: boolean;
  gain: number;
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
  solo: boolean;
  mute: boolean;
}

export interface MasteringSuiteState {
  enabled: boolean;
  lowCrossFreq: number;
  highCrossFreq: number;
  lowBand: MultibandBandSettings;
  midBand: MultibandBandSettings;
  highBand: MultibandBandSettings;
  monoSubFreq: number;
  stereoSpread: number;
  maximizerThreshold: number;
  maximizerCeiling: number;
  maximizerRelease: number;
  maximizerLookahead: boolean;
  lufsTarget: number;
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
  lengthSteps: number;
}

export interface FxSlot {
  id: string;
  type: FxType;
  name: string;
  enabled: boolean;
  mix: number;
  params: Record<string, number | string | boolean>;
}

export interface MixerTrack {
  id: number;
  name: string;
  color: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  stereoWidth: number;
  fxSlots: FxSlot[];
  peakL: number;
  peakR: number;
  sidechain?: SidechainSettings;
  routingTargetId?: number;
  sends?: {
    send1: number;
    send2: number;
  };
}

export interface ProjectMetadata {
  id: string;
  name: string;
  author: string;
  bpm: number;
  timeSignature: [number, number];
  swing: number;
  masterVolume: number;
  masterPitch: number;
  created: number;
  updated: number;
  version: string;
  isEncrypted: boolean;
  cloudSynced: boolean;
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
  frequency: number;
  gain: number;
  q: number;
  enabled: boolean;
  color: string;
}

export interface ArrangementMarker {
  id: string;
  name: string;
  bar: number;
  color?: string;
}

export interface ProjectState {
  meta: ProjectMetadata;
  patterns: Pattern[];
  selectedPatternId: string;
  channels: Channel[];
  selectedChannelId: string;
  mixerTracks: MixerTrack[];
  selectedMixerTrackId: number;
  nextMixerTrackId: number;
  playlistTracks: PlaylistTrack[];
  playlistClips: PlaylistClip[];
  recordings: AudioRecording[];
  comments: CollabComment[];
  collaborators: CollabUser[];
  midiMappings: MidiMapping[];
  vocalTunerSettings?: VocalTunerSettings;
  masteringSuiteState?: MasteringSuiteState;
  macroKnobs?: unknown[];
  arrangementMarkers?: ArrangementMarker[];
  videoScoringTrack?: VideoScoringTrack;
  grossBeatState?: GrossBeatState;
}
