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
  pitch: number; // MIDI note number 0-127 (e.g. 60 = C4)
  start: number; // in steps (16th notes or fractional steps)
  duration: number; // in steps
  velocity: number; // 0 - 1.0
  pan?: number; // -1.0 to 1.0
  muted?: boolean;
}

export type ChordVoicing = 'root' | 'inversion1' | 'inversion2' | 'inversion3' | 'drop2' | 'open_spread';

export interface GrossBeatState {
  enabled: boolean;
  preset: 'half_time' | 'tape_stop' | 'trance_gate' | 'sidechain_pump' | 'triplet_chopper' | 'stutter_32' | 'scratch_slow' | 'reverse';
  mix: number; // 0 - 1.0
  speed: 0.5 | 1.0 | 2.0; // 0.5 = Half Time
  tapeStopActive: boolean;
  tapeStopDurationMs: number; // 100 to 2000 ms
  gateSteps: boolean[]; // 16 steps
  pitchShiftSemitones: number; // e.g. -12 for half-time
}

export interface SidechainSettings {
  enabled: boolean;
  sourceTrackId: number; // Mixer track ID of trigger (e.g. 1 for Kick)
  threshold: number; // dB (-36 to 0)
  amount: number; // 0 to 1.0 (ducking depth)
  attackMs: number; // 1 to 50 ms
  releaseMs: number; // 20 to 500 ms
  lowFreqOnly: boolean; // Duck only frequencies below 150 Hz
}

export interface AutomationPoint {
  x: number; // 0 to 1 normalized along clip length or bar position
  y: number; // 0 to 1 normalized parameter value
  tension?: number; // -1 to 1 bezier tension
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
  octaves: number; // 1 to 4
  gate: number; // 0.1 to 1.5
  swing: number; // 0 to 1.0
  strumMs: number; // 0 to 50ms
  euclideanSteps?: number; // e.g. 16
  euclideanHits?: number; // e.g. 5
  euclideanRotate?: number; // e.g. 0
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
  trimStart?: number; // 0 to 1
  trimEnd?: number; // 0 to 1
  normalize?: boolean;
  reverse?: boolean;
  rootPitch?: number; // default 60 (C4)
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
  steps: boolean[]; // 16 or 32 steps for step sequencer
  stepVelocities?: number[];
  notes: Note[]; // Notes for piano roll
  synthParams: SynthParameters;
  sampleUrl?: string;
  sampleName?: string;
  customSample?: CustomSampleData;
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

  // Wavetable & Unison
  unisonVoices?: number; // 1 to 7 voices
  unisonDetune?: number; // 0 to 50 cents
  unisonSpread?: number; // 0 to 1.0 stereo pan spread

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
  color: string;
  name: string;
  offsetSteps?: number;
  mute?: boolean;
  // Audio clip processing & crossfades
  pitchShiftSemitones?: number; // -24 to +24 semitones
  timeStretchRate?: number; // 0.5x to 2.0x
  fadeInBars?: number; // 0 to 1 bar
  fadeOutBars?: number; // 0 to 1 bar
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
  stereoWidth: number; // 0 = Mono, 1.0 = Normal, 2.0 = Extra wide
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
  frequency: number; // Hz (20 to 20000)
  gain: number; // dB (-18 to +18)
  q: number; // 0.1 to 18
  enabled: boolean;
  color: string;
}

export interface ProjectState {
  meta: ProjectMetadata;
  patterns: Pattern[];
  selectedPatternId: string;
  channels: Channel[];
  selectedChannelId: string;
  playlistTracks: PlaylistTrack[];
  playlistClips: PlaylistClip[];
  mixerTracks: MixerTrack[];
  selectedMixerTrackId: number;
  recordings: AudioRecording[];
  comments: CollabComment[];
  collaborators: CollabUser[];
  midiMappings: MidiMapping[];
  connectedMidiDevices?: MidiDeviceInfo[];
}
