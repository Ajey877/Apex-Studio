import { ProjectState, Channel, MixerTrack, PlaylistClip } from '../types/daw';
import { audioEngine } from './audioEngine';

export const createDefaultMixerTracks = (): MixerTrack[] => [
  {
    id: 0,
    name: 'Master',
    color: '#00d26a',
    volume: 1.0,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1.0,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-master-eq',
        type: 'equalizer',
        name: 'Fruity Parametric EQ 2',
        enabled: true,
        mix: 1.0,
        params: { lowGain: 1.5, midGain: -0.5, highGain: 2.0, lowFreq: 100, midFreq: 1500, highFreq: 8000 }
      },
      {
        id: 'fx-master-limiter',
        type: 'limiter',
        name: 'Fruity Master Limiter',
        enabled: true,
        mix: 1.0,
        params: { threshold: -0.2, ceiling: -0.1 }
      }
    ]
  },
  {
    id: 1,
    name: 'Kick / 808',
    color: '#ff5722',
    volume: 0.95,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 0.9,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-1-comp',
        type: 'compressor',
        name: 'Fruity Compressor',
        enabled: true,
        mix: 0.8,
        params: { threshold: -14, ratio: 4.5, attack: 0.01, release: 0.1 }
      },
      {
        id: 'fx-1-dist',
        type: 'distortion',
        name: 'Fruity Fast Dist',
        enabled: true,
        mix: 0.25,
        params: { drive: 15 }
      }
    ]
  },
  {
    id: 2,
    name: 'Snares & Claps',
    color: '#ff9800',
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1.1,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-2-verb',
        type: 'reverb',
        name: 'Fruity Reeverb 2',
        enabled: true,
        mix: 0.3,
        params: { roomSize: 0.6, decay: 1.5 }
      }
    ]
  },
  {
    id: 3,
    name: 'Hi-Hats / Perc',
    color: '#ffc107',
    volume: 0.75,
    pan: 0.1,
    mute: false,
    solo: false,
    stereoWidth: 1.3,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-3-eq',
        type: 'equalizer',
        name: 'Parametric EQ (Air Boost)',
        enabled: true,
        mix: 1.0,
        params: { highGain: 4.0, highFreq: 10000 }
      }
    ]
  },
  {
    id: 4,
    name: 'Bass / Sub',
    color: '#9c27b0',
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 0.0,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-4-dist',
        type: 'distortion',
        name: 'Fruity Blood Overdrive',
        enabled: true,
        mix: 0.35,
        params: { drive: 30 }
      }
    ]
  },
  {
    id: 5,
    name: 'Lead Pluck',
    color: '#00bcd4',
    volume: 0.8,
    pan: -0.15,
    mute: false,
    solo: false,
    stereoWidth: 1.4,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-5-delay',
        type: 'delay',
        name: 'Fruity Stereo Delay 3',
        enabled: true,
        mix: 0.4,
        params: { time: 0.375, feedback: 0.45 }
      },
      {
        id: 'fx-5-verb',
        type: 'reverb',
        name: 'Fruity Reeverb 2',
        enabled: true,
        mix: 0.45,
        params: { roomSize: 0.8, decay: 2.2 }
      }
    ]
  },
  {
    id: 6,
    name: 'Atmosphere Pad',
    color: '#3f51b5',
    volume: 0.7,
    pan: 0.2,
    mute: false,
    solo: false,
    stereoWidth: 1.6,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-6-chorus',
        type: 'chorus',
        name: 'Fruity Chorus',
        enabled: true,
        mix: 0.6,
        params: { rate: 1.2, depth: 0.5 }
      },
      {
        id: 'fx-6-verb',
        type: 'reverb',
        name: 'Fruity Convolver',
        enabled: true,
        mix: 0.55,
        params: { roomSize: 0.9, decay: 3.5 }
      }
    ]
  },
  {
    id: 7,
    name: 'Vocals & FX',
    color: '#e91e63',
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1.2,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-7-comp',
        type: 'compressor',
        name: 'Fruity Limiter / Comp',
        enabled: true,
        mix: 0.85,
        params: { threshold: -16, ratio: 4.0 }
      },
      {
        id: 'fx-7-delay',
        type: 'delay',
        name: 'Fruity Delay Bank',
        enabled: true,
        mix: 0.35,
        params: { time: 0.25, feedback: 0.4 }
      }
    ]
  }
];

export const PRESET_PROJECTS: { id: string; name: string; genre: string; bpm: number; state: ProjectState }[] = [
  {
    id: 'trap-heat',
    name: 'Midnight Trap Heat',
    genre: 'Trap / Hip-Hop',
    bpm: 140,
    state: {
      meta: {
        id: 'proj-trap-heat',
        name: 'Midnight Trap Heat',
        author: 'FL Mobile Producer',
        bpm: 140,
        timeSignature: [4, 4],
        swing: 0.15,
        masterVolume: 0.9,
        masterPitch: 0,
        created: Date.now(),
        updated: Date.now(),
        version: '4.5.2 Pro',
        isEncrypted: true,
        cloudSynced: true,
        offlineReady: true,
        totalEditTimeSeconds: 3840
      },
      patterns: [
        { id: 'pat-1', name: 'Main Groove', color: '#ff5722', lengthSteps: 16 },
        { id: 'pat-2', name: 'Melody & Pluck', color: '#00bcd4', lengthSteps: 16 },
        { id: 'pat-3', name: 'Hi-Hat Rolls', color: '#ffc107', lengthSteps: 16 }
      ],
      selectedPatternId: 'pat-1',
      channels: [
        {
          id: 'ch-kick',
          name: '808 Kick Punch',
          color: '#ff5722',
          instrumentType: 'drumpad',
          mixerTrackId: 1,
          volume: 0.95,
          pan: 0,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [true, false, false, false, false, false, true, false, false, false, true, false, false, false, false, false],
          notes: [
            { id: 'n1', pitch: 36, start: 0, duration: 1, velocity: 1.0 },
            { id: 'n2', pitch: 36, start: 6, duration: 1, velocity: 0.9 },
            { id: 'n3', pitch: 36, start: 10, duration: 1, velocity: 0.95 }
          ],
          synthParams: audioEngine.getDefaultSynthParams()
        },
        {
          id: 'ch-snare',
          name: 'Trap Snare Clack',
          color: '#ff9800',
          instrumentType: 'drumpad',
          mixerTrackId: 2,
          volume: 0.85,
          pan: 0,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
          notes: [
            { id: 's1', pitch: 38, start: 4, duration: 1, velocity: 0.9 },
            { id: 's2', pitch: 38, start: 12, duration: 1, velocity: 0.95 }
          ],
          synthParams: audioEngine.getDefaultSynthParams()
        },
        {
          id: 'ch-hihat',
          name: 'Hi-Hat Rolling',
          color: '#ffc107',
          instrumentType: 'drumpad',
          mixerTrackId: 3,
          volume: 0.75,
          pan: 0.05,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true],
          notes: [
            { id: 'h1', pitch: 42, start: 0, duration: 0.5, velocity: 0.7 },
            { id: 'h2', pitch: 42, start: 2, duration: 0.5, velocity: 0.6 },
            { id: 'h3', pitch: 42, start: 4, duration: 0.5, velocity: 0.8 },
            { id: 'h4', pitch: 42, start: 6, duration: 0.5, velocity: 0.6 },
            { id: 'h5', pitch: 42, start: 8, duration: 0.5, velocity: 0.75 },
            { id: 'h6', pitch: 42, start: 10, duration: 0.5, velocity: 0.6 },
            { id: 'h7', pitch: 42, start: 12, duration: 0.5, velocity: 0.85 },
            { id: 'h8', pitch: 42, start: 14, duration: 0.5, velocity: 0.7 }
          ],
          synthParams: audioEngine.getDefaultSynthParams()
        },
        {
          id: 'ch-808',
          name: '808 Sub Glide',
          color: '#9c27b0',
          instrumentType: 'minisynth',
          mixerTrackId: 4,
          volume: 0.9,
          pan: 0,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [true, false, false, false, false, false, true, false, false, false, true, false, false, false, false, false],
          notes: [
            { id: 'b1', pitch: 36, start: 0, duration: 4, velocity: 0.95 },
            { id: 'b2', pitch: 36, start: 6, duration: 3, velocity: 0.9 },
            { id: 'b3', pitch: 39, start: 10, duration: 4, velocity: 0.9 }
          ],
          synthParams: {
            ...audioEngine.getDefaultSynthParams(),
            osc1Type: 'sine',
            osc2Type: 'triangle',
            osc1Mix: 0.9,
            osc2Mix: 0.3,
            filterCutoff: 650,
            filterResonance: 3.5,
            decay: 0.6,
            sustain: 0.4
          }
        },
        {
          id: 'ch-pluck',
          name: 'Dark Bell Pluck',
          color: '#00bcd4',
          instrumentType: 'fmsynth',
          mixerTrackId: 5,
          volume: 0.8,
          pan: -0.1,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [true, false, false, true, false, true, false, false, true, false, false, true, false, false, true, false],
          notes: [
            { id: 'p1', pitch: 60, start: 0, duration: 2, velocity: 0.8 },
            { id: 'p2', pitch: 63, start: 3, duration: 2, velocity: 0.75 },
            { id: 'p3', pitch: 67, start: 5, duration: 2, velocity: 0.85 },
            { id: 'p4', pitch: 70, start: 8, duration: 2, velocity: 0.8 },
            { id: 'p5', pitch: 68, start: 11, duration: 2, velocity: 0.75 },
            { id: 'p6', pitch: 65, start: 14, duration: 2, velocity: 0.7 }
          ],
          synthParams: {
            ...audioEngine.getDefaultSynthParams(),
            fmCarrierMultiplier: 1.0,
            fmModulatorMultiplier: 3.5,
            fmModulationIndex: 280,
            decay: 0.45
          }
        }
      ],
      selectedChannelId: 'ch-kick',
      playlistTracks: [
        { id: 1, name: 'Drums', color: '#ff5722', volume: 0.9, pan: 0, mute: false, solo: false },
        { id: 2, name: 'Percussion', color: '#ffc107', volume: 0.8, pan: 0, mute: false, solo: false },
        { id: 3, name: '808 Bass', color: '#9c27b0', volume: 0.9, pan: 0, mute: false, solo: false },
        { id: 4, name: 'Dark Pluck Lead', color: '#00bcd4', volume: 0.8, pan: 0, mute: false, solo: false },
        { id: 5, name: 'Atmosphere FX', color: '#3f51b5', volume: 0.7, pan: 0, mute: false, solo: false }
      ],
      playlistClips: [
        { id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'pattern', channelId: 'ch-kick', color: '#ff5722', name: 'Kick Pattern' },
        { id: 'clip-2', trackIndex: 0, startBar: 4, lengthBars: 4, type: 'pattern', channelId: 'ch-kick', color: '#ff5722', name: 'Kick Pattern' },
        { id: 'clip-3', trackIndex: 1, startBar: 0, lengthBars: 4, type: 'pattern', channelId: 'ch-hihat', color: '#ffc107', name: 'Hi-Hat Grid' },
        { id: 'clip-4', trackIndex: 1, startBar: 4, lengthBars: 4, type: 'pattern', channelId: 'ch-hihat', color: '#ffc107', name: 'Hi-Hat Grid' },
        { id: 'clip-5', trackIndex: 2, startBar: 0, lengthBars: 4, type: 'pattern', channelId: 'ch-808', color: '#9c27b0', name: '808 Sub Line' },
        { id: 'clip-6', trackIndex: 2, startBar: 4, lengthBars: 4, type: 'pattern', channelId: 'ch-808', color: '#9c27b0', name: '808 Sub Line' },
        { id: 'clip-7', trackIndex: 3, startBar: 0, lengthBars: 8, type: 'pattern', channelId: 'ch-pluck', color: '#00bcd4', name: 'Dark Bell Chords' }
      ],
      mixerTracks: createDefaultMixerTracks(),
      selectedMixerTrackId: 0,
      recordings: [],
      comments: [
        {
          id: 'c1',
          author: 'Alex (Lead Producer)',
          avatarColor: '#ff5722',
          timestamp: Date.now() - 3600000,
          barPosition: 4,
          text: 'The 808 slide into bar 4 hits so clean! Let us widen the bell pluck reverb in section B.',
          resolved: false
        },
        {
          id: 'c2',
          author: 'Elena (Vocalist)',
          avatarColor: '#00bcd4',
          timestamp: Date.now() - 1800000,
          barPosition: 8,
          text: 'Recorded vocal harmony stems uploaded. Ready for auto-tune and delay ducking.',
          resolved: true
        }
      ],
      collaborators: [
        { id: 'u1', name: 'You (Mobile Studio)', color: '#00d26a', avatar: 'ME', role: 'Admin', status: 'online', currentTrack: 'Piano Roll - Dark Pluck', lastActive: 'Now' },
        { id: 'u2', name: 'Marcus K.', color: '#ff5722', avatar: 'MK', role: 'Producer', status: 'online', currentTrack: 'Mixer - Track 1', lastActive: '2m ago' },
        { id: 'u3', name: 'Elena V.', color: '#00bcd4', avatar: 'EV', role: 'Vocalist', status: 'idle', currentTrack: 'Playlist Arranger', lastActive: '15m ago' }
      ],
      midiMappings: [
        { ccNumber: 1, targetType: 'fx_param', targetId: 'fx-5-verb', paramName: 'mix' },
        { ccNumber: 7, targetType: 'master_vol', targetId: 0 }
      ]
    }
  },
  {
    id: 'synthwave-80s',
    name: 'Outrun Neon Synthwave',
    genre: 'Synthwave / Retrowave',
    bpm: 118,
    state: {
      meta: {
        id: 'proj-synthwave',
        name: 'Outrun Neon Synthwave',
        author: 'Retro Wave Lab',
        bpm: 118,
        timeSignature: [4, 4],
        swing: 0.0,
        masterVolume: 0.92,
        masterPitch: 0,
        created: Date.now(),
        updated: Date.now(),
        version: '4.5.2 Pro',
        isEncrypted: true,
        cloudSynced: true,
        offlineReady: true,
        totalEditTimeSeconds: 5120
      },
      patterns: [
        { id: 'pat-1', name: 'Analog Beat', color: '#ff007f', lengthSteps: 16 },
        { id: 'pat-2', name: 'Arp Bassline', color: '#00e5ff', lengthSteps: 16 }
      ],
      selectedPatternId: 'pat-1',
      channels: [
        {
          id: 'ch-sw-kick',
          name: 'LinnDrum Kick',
          color: '#ff007f',
          instrumentType: 'drumpad',
          mixerTrackId: 1,
          volume: 0.95,
          pan: 0,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
          notes: [{ id: 'k1', pitch: 36, start: 0, duration: 1, velocity: 1 }],
          synthParams: audioEngine.getDefaultSynthParams()
        },
        {
          id: 'ch-sw-snare',
          name: 'Gated 80s Snare',
          color: '#ff9100',
          instrumentType: 'drumpad',
          mixerTrackId: 2,
          volume: 0.9,
          pan: 0,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
          notes: [{ id: 's1', pitch: 38, start: 4, duration: 1, velocity: 1 }],
          synthParams: audioEngine.getDefaultSynthParams()
        },
        {
          id: 'ch-sw-bass',
          name: 'Rolling Saw Bass',
          color: '#00e5ff',
          instrumentType: 'minisynth',
          mixerTrackId: 4,
          volume: 0.88,
          pan: 0,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true],
          notes: [
            { id: 'b1', pitch: 48, start: 0, duration: 1, velocity: 0.8 },
            { id: 'b2', pitch: 48, start: 2, duration: 1, velocity: 0.8 },
            { id: 'b3', pitch: 51, start: 4, duration: 1, velocity: 0.8 },
            { id: 'b4', pitch: 51, start: 6, duration: 1, velocity: 0.8 },
            { id: 'b5', pitch: 46, start: 8, duration: 1, velocity: 0.8 },
            { id: 'b6', pitch: 46, start: 10, duration: 1, velocity: 0.8 },
            { id: 'b7', pitch: 44, start: 12, duration: 1, velocity: 0.8 },
            { id: 'b8', pitch: 44, start: 14, duration: 1, velocity: 0.8 }
          ],
          synthParams: {
            ...audioEngine.getDefaultSynthParams(),
            osc1Type: 'sawtooth',
            osc2Type: 'sawtooth',
            osc1Detune: -5,
            osc2Detune: 5,
            filterCutoff: 1800,
            filterResonance: 4.5,
            decay: 0.2
          }
        },
        {
          id: 'ch-sw-lead',
          name: 'Jupiter Brass Lead',
          color: '#ffd600',
          instrumentType: 'minisynth',
          mixerTrackId: 5,
          volume: 0.82,
          pan: 0,
          pitch: 0,
          mute: false,
          solo: false,
          steps: [true, false, false, false, false, false, true, false, false, false, false, false, false, false, false, false],
          notes: [
            { id: 'l1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
            { id: 'l2', pitch: 63, start: 6, duration: 3, velocity: 0.9 },
            { id: 'l3', pitch: 67, start: 10, duration: 4, velocity: 0.9 }
          ],
          synthParams: {
            ...audioEngine.getDefaultSynthParams(),
            osc1Type: 'sawtooth',
            osc2Type: 'square',
            osc1Mix: 0.8,
            osc2Mix: 0.6,
            filterCutoff: 4200,
            attack: 0.05,
            release: 0.35
          }
        }
      ],
      selectedChannelId: 'ch-sw-bass',
      playlistTracks: [
        { id: 1, name: 'Drums', color: '#ff007f', volume: 0.95, pan: 0, mute: false, solo: false },
        { id: 2, name: 'Synth Bass', color: '#00e5ff', volume: 0.9, pan: 0, mute: false, solo: false },
        { id: 3, name: 'Analog Leads', color: '#ffd600', volume: 0.85, pan: 0, mute: false, solo: false }
      ],
      playlistClips: [
        { id: 'sw-c1', trackIndex: 0, startBar: 0, lengthBars: 8, type: 'pattern', channelId: 'ch-sw-kick', color: '#ff007f', name: 'Linn Kick Pattern' },
        { id: 'sw-c2', trackIndex: 1, startBar: 0, lengthBars: 8, type: 'pattern', channelId: 'ch-sw-bass', color: '#00e5ff', name: 'Rolling Bass' },
        { id: 'sw-c3', trackIndex: 2, startBar: 2, lengthBars: 6, type: 'pattern', channelId: 'ch-sw-lead', color: '#ffd600', name: 'Jupiter Lead' }
      ],
      mixerTracks: createDefaultMixerTracks(),
      selectedMixerTrackId: 0,
      recordings: [],
      comments: [],
      collaborators: [
        { id: 'u1', name: 'You (Producer)', color: '#00d26a', avatar: 'ME', role: 'Admin', status: 'online', lastActive: 'Now' }
      ],
      midiMappings: []
    }
  }
];

export const getInitialProjectState = (): ProjectState => structuredClone(PRESET_PROJECTS[0].state);

export const DEFAULT_PROJECT: ProjectState = structuredClone(PRESET_PROJECTS[0].state);

export const createDefaultPlaylistTracks = () => structuredClone(PRESET_PROJECTS[0].state.playlistTracks);

