import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  ProjectState, 
  ViewMode, 
  PlayMode, 
  Channel, 
  InstrumentType, 
  PlaylistTrack, 
  PlaylistClip, 
  MixerTrack, 
  FxType, 
  FxSlot, 
  AudioRecording, 
  CollabComment, 
  CollabUser,
  ProjectMetadata,
  MasteringSuiteState
} from './types/daw';
import { audioEngine } from './audio/audioEngine';
import { 
  DEFAULT_PROJECT, 
  PRESET_PROJECTS, 
  createDefaultMixerTracks, 
  createDefaultPlaylistTracks 
} from './audio/presets';
import { appendChannelWithAllocatedMixerTrackId } from './state/mixerTrackIdentity';
import { deleteChannelFromProjectState } from './state/projectState';
import { createRecordingPlaylistClip, getRecordingAudioBufferId, validateRecordingTargetTrack } from './audio/recordingPipeline';

// Component Suite
import { TransportBar } from './components/TransportBar';
import { ChannelRack } from './components/ChannelRack';
import { PianoRoll } from './components/PianoRoll';
import { PlaylistArranger } from './components/PlaylistArranger';
import { Mixer } from './components/Mixer';
import { InstrumentRack } from './components/InstrumentRack';

// Modals
import { AudioRecorderModal } from './components/AudioRecorderModal';
import { ExportModal } from './components/ExportModal';
import { CollaborationModal } from './components/CollaborationModal';
import { AnalyticsModal } from './components/AnalyticsModal';
import { SubscriptionModal } from './components/SubscriptionModal';
import { ProjectManagerModal } from './components/ProjectManagerModal';
import { HotkeysModal } from './components/HotkeysModal';
import { OrientationLockModal } from './components/OrientationLockModal';
import { MidiControllerModal } from './components/MidiControllerModal';
import { ParametricEqModal } from './components/ParametricEqModal';
import { MasteringSuiteModal } from './components/MasteringSuiteModal';
import { ArpeggiatorModal } from './components/ArpeggiatorModal';
import { SampleManagerModal } from './components/SampleManagerModal';
import { GrossBeatModal } from './components/GrossBeatModal';
import { AudioSlicerModal } from './components/AudioSlicerModal';
import { VocalTunerModal } from './components/VocalTunerModal';
import { MidiLearnModal } from './components/MidiLearnModal';
import { MultiZoneSamplerModal } from './components/MultiZoneSamplerModal';
import { WavetableSynthModal } from './components/WavetableSynthModal';
import { WamPluginModal } from './components/WamPluginModal';
import { TakeCompingModal } from './components/TakeCompingModal';
import { SidechainRoutingModal } from './components/SidechainRoutingModal';
import { PolyphonicEditorModal } from './components/PolyphonicEditorModal';
import { DesktopAppModal } from './components/DesktopAppModal';
import { WarpAudioProcessorModal } from './components/WarpAudioProcessorModal';
import { VideoScoringModal } from './components/VideoScoringModal';
import { SpatialAudio3DPannerModal } from './components/SpatialAudio3DPannerModal';
import { MpeExpressionModal } from './components/MpeExpressionModal';
import { StemSplitterAiModal } from './components/StemSplitterAiModal';
import { MasterMacroRackModal } from './components/MasterMacroRackModal';
import { ProjectBundleZipModal } from './components/ProjectBundleZipModal';

import { 
  Folder, 
  Music, 
  Disc, 
  Cpu, 
  Radio, 
  Sliders, 
  Volume2, 
  Play, 
  Pause, 
  Plus, 
  Search, 
  ChevronRight, 
  ChevronDown,
  Layers,
  Sparkles,
  Zap,
  Clock,
  ShieldCheck,
  Crown,
  Keyboard,
  X
} from 'lucide-react';

export function App() {
  // --- Core DAW State ---
  const [projectState, setProjectState] = useState<ProjectState>(DEFAULT_PROJECT);
  const [currentView, setCurrentView] = useState<ViewMode>('channel_rack');
  const [playMode, setPlayMode] = useState<PlayMode>('pat');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [currentBar, setCurrentBar] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string>(DEFAULT_PROJECT.channels[0]?.id || 'ch-1');
  const [selectedTrackId, setSelectedTrackId] = useState<number>(0); // 0 = Master

  // --- Studio Browser / Sidebar State ---
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 1024;
    }
    return false;
  });
  const [browserSearch, setBrowserSearch] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'instruments': true,
    'drums': true,
    'presets': true
  });
  const [previewingAudio, setPreviewingAudio] = useState<string | null>(null);

  // --- Modals Visibility State ---
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isProjectManagerOpen, setIsProjectManagerOpen] = useState(false);
  const [isCollabOpen, setIsCollabOpen] = useState(false);
  const [isAnalyticsOpen, setIsAnalyticsOpen] = useState(false);
  const [isSubscriptionOpen, setIsSubscriptionOpen] = useState(false);
  const [isHotkeysOpen, setIsHotkeysOpen] = useState(false);
  const [isAudioRecorderOpen, setIsAudioRecorderOpen] = useState(false);
  const [isMidiModalOpen, setIsMidiModalOpen] = useState(false);
  const [isParametricEqOpen, setIsParametricEqOpen] = useState(false);
  const [eqModalTrackId, setEqModalTrackId] = useState<number>(0);
  const [isMasteringSuiteOpen, setIsMasteringSuiteOpen] = useState(false);
  const [isGrossBeatOpen, setIsGrossBeatOpen] = useState(false);
  const [isAudioSlicerOpen, setIsAudioSlicerOpen] = useState(false);
  const [isArpeggiatorOpen, setIsArpeggiatorOpen] = useState(false);
  const [arpChannelId, setArpChannelId] = useState<string>(DEFAULT_PROJECT.channels[0]?.id || 'ch-1');
  const [isSampleManagerOpen, setIsSampleManagerOpen] = useState(false);
  const [sampleChannelId, setSampleChannelId] = useState<string>(DEFAULT_PROJECT.channels[0]?.id || 'ch-1');
  const [isVocalTunerOpen, setIsVocalTunerOpen] = useState(false);
  const [isMidiLearnOpen, setIsMidiLearnOpen] = useState(false);
  const [isMidiLearnActive, setIsMidiLearnActive] = useState(false);
  const [isMultiZoneSamplerOpen, setIsMultiZoneSamplerOpen] = useState(false);
  const [isWavetableSynthOpen, setIsWavetableSynthOpen] = useState(false);
  const [isWamPluginOpen, setIsWamPluginOpen] = useState(false);
  const [isTakeCompingOpen, setIsTakeCompingOpen] = useState(false);
  const [isSidechainOpen, setIsSidechainOpen] = useState(false);
  const [isPolyphonicEditorOpen, setIsPolyphonicEditorOpen] = useState(false);
  const [isDesktopAppOpen, setIsDesktopAppOpen] = useState(false);
  const [isWarpProcessorOpen, setIsWarpProcessorOpen] = useState(false);
  const [isVideoScoringOpen, setIsVideoScoringOpen] = useState(false);
  const [isSpatialAudioOpen, setIsSpatialAudioOpen] = useState(false);
  const [isMpeExpressionOpen, setIsMpeExpressionOpen] = useState(false);
  const [isStemSplitterOpen, setIsStemSplitterOpen] = useState(false);
  const [isMasterMacrosOpen, setIsMasterMacrosOpen] = useState(false);
  const [isProjectZipOpen, setIsProjectZipOpen] = useState(false);

  // --- Mastering Suite State ---
  const [masteringSuiteState, setMasteringSuiteState] = useState<MasteringSuiteState>({
    enabled: true,
    lufsTarget: -14.0,
    lowCrossFreq: 150,
    highCrossFreq: 3500,
    lowBand: {
      enabled: true,
      threshold: -18,
      ratio: 3.0,
      attack: 20,
      release: 100,
      gain: 1.0,
      knee: 6,
      solo: false,
      mute: false
    },
    midBand: {
      enabled: true,
      threshold: -22,
      ratio: 2.5,
      attack: 15,
      release: 80,
      gain: 0.0,
      knee: 4,
      solo: false,
      mute: false
    },
    highBand: {
      enabled: true,
      threshold: -20,
      ratio: 2.0,
      attack: 10,
      release: 60,
      gain: 1.5,
      knee: 3,
      solo: false,
      mute: false
    },
    stereoSpread: 1.15,
    monoSubFreq: 120,
    maximizerThreshold: -3.5,
    maximizerCeiling: -0.2,
    maximizerRelease: 80,
    maximizerLookahead: true
  });

  // --- Pro & Collab State ---
  const [isProUser, setIsProUser] = useState(true);
  const [collaborators, setCollaborators] = useState<CollabUser[]>([
    { id: 'u1', name: 'Alex (You)', color: '#ff6e00', avatar: 'A', role: 'Producer', status: 'editing', lastActive: 'Now' },
    { id: 'u2', name: 'Maya Beats', color: '#00ff00', avatar: 'M', role: 'Mixing Engineer', status: 'online', lastActive: '1m ago' },
    { id: 'u3', name: 'Liam Vocal', color: '#00bcd4', avatar: 'L', role: 'Vocalist', status: 'idle', lastActive: '5m ago' }
  ]);
  const [comments, setComments] = useState<CollabComment[]>([
    { id: 'c1', author: 'Maya Beats', avatarColor: '#00ff00', timestamp: Date.now() - 3600000, barPosition: 5, text: 'The 808 sub bass needs a tight sidechain ducking on kick hit.', resolved: false },
    { id: 'c2', author: 'Liam Vocal', avatarColor: '#00bcd4', timestamp: Date.now() - 7200000, barPosition: 9, text: 'Hook vocal drop starts here at Bar 9.', resolved: true }
  ]);

  // Audio Engine Synchronization
  useEffect(() => {
    audioEngine.init();
    audioEngine.setBpm(projectState.meta.bpm);
    audioEngine.setSwing(projectState.meta.swing);
    audioEngine.setMetronome(metronome);
  }, []);

  // Update audio engine settings when state changes
  useEffect(() => {
    audioEngine.setBpm(projectState.meta.bpm);
  }, [projectState.meta.bpm]);

  useEffect(() => {
    audioEngine.setSwing(projectState.meta.swing);
  }, [projectState.meta.swing]);

  useEffect(() => {
    audioEngine.setMetronome(metronome);
  }, [metronome]);

  // Audio-clock transport state drives the UI playhead.
  useEffect(() => {
    const handleTransportState = (state: { playing: boolean; step: number; bar: number }) => {
      setIsPlaying(prev => prev === state.playing ? prev : state.playing);
      setCurrentStep(prev => prev === state.step ? prev : state.step);
      setCurrentBar(prev => prev === state.bar ? prev : state.bar);
    };

    audioEngine.setTransportStateCallback(handleTransportState);
    return () => audioEngine.setTransportStateCallback(null);
  }, []);

  // --- Transport Controls ---
  const handleTogglePlay = () => {
    if (isPlaying) {
      audioEngine.stop();
      setIsPlaying(false);
    } else {
      audioEngine.play(
        projectState.channels,
        projectState.playlistClips,
        playMode,
        projectState.selectedPatternId
      );
      setIsPlaying(true);
    }
  };

  const handleStop = () => {
    audioEngine.stop();
    setIsPlaying(false);
    setCurrentStep(0);
    setCurrentBar(1);
  };

  const handleTogglePlayMode = () => {
    const nextMode: PlayMode = playMode === 'pat' ? 'song' : 'pat';
    setPlayMode(nextMode);
    if (isPlaying) {
      audioEngine.stop();
      audioEngine.play(
        projectState.channels,
        projectState.playlistClips,
        nextMode,
        projectState.selectedPatternId
      );
    }
  };

  const handleToggleRecord = () => {
    if (isRecording) {
      setIsRecording(false);
    } else {
      setIsRecording(true);
      setIsAudioRecorderOpen(true);
    }
  };

  // --- Project State Handlers ---
  const handleUpdateMeta = (updates: Partial<ProjectMetadata>) => {
    setProjectState(prev => ({
      ...prev,
      meta: { ...prev.meta, ...updates, updated: Date.now() }
    }));
  };

  const handleUpdateChannel = (channelId: string, updates: Partial<Channel>) => {
    setProjectState(prev => {
      const updatedChannels = prev.channels.map(ch => ch.id === channelId ? { ...ch, ...updates } : ch);
      return { ...prev, channels: updatedChannels };
    });
  };

  const handleAddChannel = (type: InstrumentType, name: string, color: string) => {
    const channel = {
      id: `ch-${Date.now()}`,
      name,
      color,
      instrumentType: type,
      volume: 0.85,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      steps: Array(16).fill(false),
      notes: [],
      synthParams: audioEngine.getDefaultSynthParams()
    } satisfies Omit<Channel, 'mixerTrackId'>;

    setProjectState(prev => appendChannelWithAllocatedMixerTrackId(prev, channel));
    setSelectedChannelId(channel.id);
  };

  const handleDeleteChannel = (channelId: string) => {
    if (projectState.channels.length <= 1) return;

    const result = deleteChannelFromProjectState(projectState, channelId);
    if (!result.deletedChannel) return;

    audioEngine.stopChannelVoices(channelId);

    if (result.removedMixerTrackId !== null) {
      audioEngine.removeMixerChannel(result.removedMixerTrackId);
      if (selectedTrackId === result.removedMixerTrackId) {
        setSelectedTrackId(0);
      }
    }

    setProjectState(result.state);
    if (selectedChannelId === channelId) {
      setSelectedChannelId(result.state.selectedChannelId);
    }
  };

  const handleAddPattern = () => {
    const nextIdx = projectState.patterns.length + 1;
    const newPat = {
      id: `pat-${nextIdx}-${Date.now()}`,
      name: `Pattern ${nextIdx}`,
      color: '#ff6e00',
      lengthSteps: 16
    };
    setProjectState(prev => ({
      ...prev,
      patterns: [...prev.patterns, newPat],
      selectedPatternId: newPat.id
    }));
  };

  const handleUpdateTracks = (tracks: PlaylistTrack[]) => {
    setProjectState(prev => ({ ...prev, playlistTracks: tracks }));
  };

  const handleUpdateClips = (clips: PlaylistClip[]) => {
    setProjectState(prev => ({ ...prev, playlistClips: clips }));
  };

  const handleAddPlaylistTrack = () => {
    const nextId = projectState.playlistTracks.length + 1;
    const newTrack: PlaylistTrack = {
      id: nextId,
      name: `Track ${nextId}`,
      color: '#ff6e00',
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false
    };
    setProjectState(prev => ({
      ...prev,
      playlistTracks: [...prev.playlistTracks, newTrack]
    }));
  };

  const handleUpdateMixerTrack = (trackId: number, updates: Partial<MixerTrack>) => {
    setProjectState(prev => ({
      ...prev,
      mixerTracks: prev.mixerTracks.map(t => t.id === trackId ? { ...t, ...updates } : t)
    }));
  };

  const handleAddFxSlot = (trackId: number, type: FxType) => {
    const newSlot: FxSlot = {
      id: `fx-${Date.now()}`,
      type,
      name: `Studio ${type.toUpperCase()}`,
      enabled: true,
      mix: 0.8,
      params: {}
    };

    setProjectState(prev => ({
      ...prev,
      mixerTracks: prev.mixerTracks.map(t => {
        if (t.id === trackId) {
          return { ...t, fxSlots: [...t.fxSlots, newSlot] };
        }
        return t;
      })
    }));
  };

  const handleDeleteFxSlot = (trackId: number, slotId: string) => {
    setProjectState(prev => ({
      ...prev,
      mixerTracks: prev.mixerTracks.map(t => {
        if (t.id === trackId) {
          return { ...t, fxSlots: t.fxSlots.filter(s => s.id !== slotId) };
        }
        return t;
      })
    }));
  };

  const handleUpdateFxSlot = (trackId: number, slotId: string, updates: Partial<FxSlot>) => {
    setProjectState(prev => ({
      ...prev,
      mixerTracks: prev.mixerTracks.map(t => {
        if (t.id === trackId) {
          return {
            ...t,
            fxSlots: t.fxSlots.map(s => s.id === slotId ? { ...s, ...updates } : s)
          };
        }
        return t;
      })
    }));
  };

  // --- Phase 6D: Recording -> decode -> register -> playlist clip ---
  const handleSaveRecordingToPlaylist = async (recording: AudioRecording, targetTrackIndex: number) => {
    if (!recording.audioBlob || recording.audioBlob.size === 0) {
      throw new Error('The recording contains no audio data');
    }

    // Validate before registering so stale UI selections cannot leave orphaned buffers.
    validateRecordingTargetTrack(projectState.playlistTracks, targetTrackIndex);

    const audioBufferId = getRecordingAudioBufferId(recording.id);
    const loaded = await audioEngine.loadAudioFile(recording.audioBlob, audioBufferId);
    const newClip = createRecordingPlaylistClip(
      recording,
      {
        id: audioBufferId,
        buffer: loaded.buffer,
        peaks: loaded.peaks,
        duration: loaded.duration
      },
      projectState.playlistTracks,
      targetTrackIndex,
      projectState.meta.bpm,
      `rec-clip-${Date.now()}`
    );

    setProjectState(prev => ({
      ...prev,
      recordings: [...prev.recordings, recording],
      playlistClips: [...prev.playlistClips, newClip],
      meta: { ...prev.meta, updated: Date.now() }
    }));
  };

  // --- Computer Keypad & Keyboard Live Engine ---
  const [keyboardOctave, setKeyboardOctave] = useState<number>(0);
  const activeHeldKeysRef = useRef<Set<string>>(new Set());

  // --- Keyboard Shortcuts & Global Hotkeys ---
  useEffect(() => {
    const KEY_NOTE_MAP: Record<string, number> = {
      // QWERTY White & Black Piano Keys (C4 to E5)
      'KeyA': 60, // C4
      'KeyW': 61, // C#4
      'KeyS': 62, // D4
      'KeyE': 63, // D#4
      'KeyD': 64, // E4
      'KeyF': 65, // F4
      'KeyT': 66, // F#4
      'KeyG': 67, // G4
      'KeyY': 68, // G#4
      'KeyH': 69, // A4
      'KeyU': 70, // A#4
      'KeyJ': 71, // B4
      'KeyK': 72, // C5
      'KeyO': 73, // C#5
      'KeyL': 74, // D5
      'KeyP': 75, // D#5
      'Semicolon': 76, // E5

      // Numeric Keypad (Numpad 1..9 MPC Drum & Bass triggers)
      'Numpad1': 36, // Kick / C2
      'Numpad2': 38, // Snare / D2
      'Numpad3': 42, // Closed Hat / F#2
      'Numpad4': 46, // Open Hat / A#2
      'Numpad5': 49, // Crash / C#3
      'Numpad6': 39, // Clap / D#2
      'Numpad7': 51, // Ride / D#3
      'Numpad8': 48, // Mid Tom / C3
      'Numpad9': 45  // Low Tom / A2
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in text input fields
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      // 1. Transport & Playback
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
        return;
      } else if (e.key === 'l' || e.key === 'L') {
        handleTogglePlayMode();
        return;
      } else if (e.key === 'r' || e.key === 'R') {
        handleToggleRecord();
        return;
      } else if (e.key === 'm' || e.key === 'M') {
        setMetronome(m => !m);
        return;
      } else if (e.code === 'Numpad0' || e.key === '0' || e.code === 'Home') {
        handleStop();
        return;
      }

      // 2. View Switches (F-keys & Digits)
      if (e.key === '1' || e.code === 'F6') {
        e.preventDefault();
        setCurrentView('channel_rack');
        return;
      } else if (e.key === '2' || e.code === 'F7') {
        e.preventDefault();
        setCurrentView('piano_roll');
        return;
      } else if (e.key === '3' || e.code === 'F5') {
        e.preventDefault();
        setCurrentView('playlist');
        return;
      } else if (e.key === '4' || e.code === 'F9') {
        e.preventDefault();
        setCurrentView('mixer');
        return;
      } else if (e.key === '5' || e.code === 'F8') {
        e.preventDefault();
        setCurrentView('instruments');
        return;
      }

      // 3. Octave Shift
      if (e.code === 'KeyZ') {
        setKeyboardOctave(prev => Math.max(-2, prev - 1));
        return;
      } else if (e.code === 'KeyX') {
        setKeyboardOctave(prev => Math.min(2, prev + 1));
        return;
      }

      // 4. Live Musical Keypad / Computer Keyboard Note Triggering
      if (KEY_NOTE_MAP[e.code] !== undefined && !activeHeldKeysRef.current.has(e.code) && !e.repeat) {
        activeHeldKeysRef.current.add(e.code);
        const basePitch = KEY_NOTE_MAP[e.code];
        // Apply octave shift only to non-numpad melodic keys
        const isNumpad = e.code.startsWith('Numpad');
        const pitch = isNumpad ? basePitch : basePitch + (keyboardOctave * 12);

        const currentChan = projectState.channels.find(c => c.id === selectedChannelId) || projectState.channels[0];
        if (currentChan) {
          audioEngine.playNote(currentChan, {
            id: `key-${e.code}-${Date.now()}`,
            pitch,
            start: 0,
            duration: 1.2,
            velocity: 0.95
          });
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (activeHeldKeysRef.current.has(e.code)) {
        activeHeldKeysRef.current.delete(e.code);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isPlaying, playMode, projectState, selectedChannelId, keyboardOctave]);

  const selectedChannel = projectState.channels.find(c => c.id === selectedChannelId) || projectState.channels[0];

  const handleAuditionSample = (name: string, pitch = 60) => {
    setPreviewingAudio(name);
    if (selectedChannel) {
      audioEngine.playNote(selectedChannel, {
        id: `prev-${Date.now()}`,
        pitch,
        start: 0,
        duration: 0.8,
        velocity: 0.9
      });
    }
    setTimeout(() => setPreviewingAudio(null), 800);
