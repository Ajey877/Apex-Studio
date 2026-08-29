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

  // Clock tick listener from Audio Engine
  useEffect(() => {
    const handleStepTick = (step: number, bar: number) => {
      setCurrentStep(step);
      setCurrentBar(bar);
    };

    audioEngine.setStepCallback(handleStepTick);
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

  const handleSaveRecordingToPlaylist = (recording: AudioRecording, targetTrackIndex: number) => {
    const newClip: PlaylistClip = {
      id: `rec-clip-${Date.now()}`,
      trackIndex: targetTrackIndex,
      startBar: 0,
      lengthBars: Math.max(2, Math.ceil(recording.durationSeconds / 2)),
      type: 'audio',
      audioName: recording.name,
      color: '#ff6e00',
      name: recording.name
    };

    setProjectState(prev => ({
      ...prev,
      playlistClips: [...prev.playlistClips, newClip]
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

  // Audition sample in browser
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
  };

  return (
    <div id="phantom-mobile-daw" className="bg-[#0a0a0b] text-[#b0b0b0] h-screen w-screen flex flex-col font-sans select-none overflow-hidden">
      {/* 1. Top Transport Header */}
      <TransportBar
        currentView={currentView}
        onSelectView={(v) => setCurrentView(v)}
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        onStop={handleStop}
        playMode={playMode}
        onTogglePlayMode={handleTogglePlayMode}
        isRecording={isRecording}
        onToggleRecord={handleToggleRecord}
        meta={projectState.meta}
        onUpdateMeta={handleUpdateMeta}
        currentStep={currentStep}
        currentBar={currentBar}
        metronome={metronome}
        onToggleMetronome={() => setMetronome(!metronome)}
        onOpenExport={() => setIsExportOpen(true)}
        onOpenProjectManager={() => setIsProjectManagerOpen(true)}
        onOpenCollab={() => setIsCollabOpen(true)}
        onOpenAnalytics={() => setIsAnalyticsOpen(true)}
        onOpenSubscription={() => setIsSubscriptionOpen(true)}
        onOpenHotkeys={() => setIsHotkeysOpen(true)}
        onOpenMidi={() => setIsMidiModalOpen(true)}
        onOpenParametricEq={() => {
          setEqModalTrackId(0);
          setIsParametricEqOpen(true);
        }}
        onOpenGrossBeat={() => setIsGrossBeatOpen(true)}
        onOpenSlicer={() => setIsAudioSlicerOpen(true)}
        onOpenMasteringSuite={() => setIsMasteringSuiteOpen(true)}
        onOpenSampleManager={() => setIsSampleManagerOpen(true)}
        onOpenVocalTuner={() => setIsVocalTunerOpen(true)}
        onOpenMidiLearn={() => setIsMidiLearnOpen(true)}
        onOpenMultiZoneSampler={() => setIsMultiZoneSamplerOpen(true)}
        onOpenWavetableSynth={() => setIsWavetableSynthOpen(true)}
        onOpenWamPlugin={() => setIsWamPluginOpen(true)}
        onOpenTakeComping={() => setIsTakeCompingOpen(true)}
        onOpenSidechain={() => setIsSidechainOpen(true)}
        onOpenPolyphonicEditor={() => setIsPolyphonicEditorOpen(true)}
        onOpenDesktopApp={() => setIsDesktopAppOpen(true)}
        onOpenWarpProcessor={() => setIsWarpProcessorOpen(true)}
        onOpenVideoScoring={() => setIsVideoScoringOpen(true)}
        onOpenSpatialAudio={() => setIsSpatialAudioOpen(true)}
        onOpenMpeExpression={() => setIsMpeExpressionOpen(true)}
        onOpenStemSplitter={() => setIsStemSplitterOpen(true)}
        onOpenMasterMacros={() => setIsMasterMacrosOpen(true)}
        onOpenProjectZipBundle={() => setIsProjectZipOpen(true)}
        collaboratorCount={collaborators.length}
        isProUser={isProUser}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
      />

      {/* 2. Main Studio Work Area */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Studio Browser & File Manager */}
        {isSidebarOpen && (
          <aside className="w-56 md:w-64 bg-[#141416] border-r border-[#333336] flex flex-col shrink-0">
            {/* Browser Header */}
            <div className="p-2.5 border-b border-[#333336] flex justify-between items-center bg-[#1a1a1d]">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#777]">STUDIO BROWSER</span>
              <button 
                onClick={() => setIsProjectManagerOpen(true)}
                className="text-[#ff6e00] hover:text-white text-[10px] font-bold transition"
              >
                + New
              </button>
            </div>

            {/* Quick Search */}
            <div className="p-2 border-b border-[#333336] bg-[#121214]">
              <div className="flex items-center gap-1.5 bg-[#1a1a1d] px-2 py-1 rounded border border-[#333336]">
                <Search className="w-3 h-3 text-[#777]" />
                <input
                  type="text"
                  placeholder="Search samples & VSTs..."
                  value={browserSearch}
                  onChange={(e) => setBrowserSearch(e.target.value)}
                  className="w-full bg-transparent text-[11px] text-white placeholder-[#555] focus:outline-none"
                />
              </div>
            </div>

            {/* Tree Categories */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-3 text-xs">
              {/* Category 1: Instruments */}
              <div className="space-y-1">
                <div 
                  onClick={() => setExpandedFolders(f => ({ ...f, instruments: !f.instruments }))}
                  className="flex items-center justify-between text-[10px] font-bold text-[#777] hover:text-white cursor-pointer px-1"
                >
                  <span className="flex items-center gap-1">
                    <Cpu className="w-3 h-3 text-[#ff6e00]" />
                    <span>SYNTHS & GENERATORS</span>
                  </span>
                  {expandedFolders.instruments ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </div>

                {expandedFolders.instruments && (
                  <div className="space-y-0.5 pl-3 border-l border-[#222225] mt-1">
                    {[
                      { name: 'Grand Concert Piano', type: 'grand_piano', color: '#e0e0e0' },
                      { name: 'Vintage Rhodes MK1', type: 'rhodes_epiano', color: '#e67e22' },
                      { name: 'Hammond B3 Organ', type: 'hammond_organ', color: '#d35400' },
                      { name: 'Orchestral Strings', type: 'strings_ensemble', color: '#9b59b6' },
                      { name: 'Pizzicato Strings', type: 'pizzicato_strings', color: '#8e44ad' },
                      { name: 'Nylon Pluck Guitar', type: 'nylon_guitar', color: '#27ae60' },
                      { name: 'Cinematic Horns/Brass', type: 'cinematic_brass', color: '#f39c12' },
                      { name: '808 Tuned Sub Bass', type: 'sub_808', color: '#ff5722' },
                      { name: 'TB-303 Acid Bassline', type: 'acid_303', color: '#2ecc71' },
                      { name: 'Reese Heavy Bass', type: 'reese_bass', color: '#c0392b' },
                      { name: 'JP-8000 Supersaw', type: 'supersaw_lead', color: '#00d2d3' },
                      { name: 'Atmospheric Pad', type: 'ambient_pad', color: '#54a0ff' },
                      { name: 'Vocal Choir Formant', type: 'vox_choir', color: '#ff9ff3' },
                      { name: 'Wooden Marimba/Bell', type: 'marimba_bell', color: '#1dd1a1' },
                      { name: '8-Bit Retro Chiptune', type: 'chiptune_8bit', color: '#feca57' },
                      { name: 'MiniSynth Subtractive', type: 'minisynth', color: '#ff6e00' },
                      { name: 'Toxic FM Synthesizer', type: 'fmsynth', color: '#00bcd4' },
                      { name: 'DirectWave Sampler', type: 'sampler', color: '#4caf50' },
                      { name: '808 Drum Machine', type: 'drumpad', color: '#ff5722' }
                    ].map((item, i) => (
                      <div
                        key={i}
                        onClick={() => handleAddChannel(item.type as InstrumentType, item.name, item.color)}
                        className="flex items-center justify-between px-2 py-1 rounded hover:bg-[#222225] text-[11px] text-zinc-300 hover:text-white cursor-pointer group"
                      >
                        <span className="truncate">{item.name}</span>
                        <span className="text-[9px] text-[#ff6e00] opacity-0 group-hover:opacity-100 font-bold">+ LOAD</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Category 2: Drum Samples */}
              <div className="space-y-1">
                <div 
                  onClick={() => setExpandedFolders(f => ({ ...f, drums: !f.drums }))}
                  className="flex items-center justify-between text-[10px] font-bold text-[#777] hover:text-white cursor-pointer px-1"
                >
                  <span className="flex items-center gap-1">
                    <Disc className="w-3 h-3 text-[#ff6e00]" />
                    <span>DRUM SAMPLES (808 / MPC)</span>
                  </span>
                  {expandedFolders.drums ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </div>

                {expandedFolders.drums && (
                  <div className="space-y-0.5 pl-3 border-l border-[#222225] mt-1">
                    {[
                      { name: '808_Sub_Punch.wav', pitch: 36 },
                      { name: 'Snare_Trap_Hard.wav', pitch: 38 },
                      { name: 'HiHat_Closed_Tight.wav', pitch: 42 },
                      { name: 'Clap_Studio_Dry.wav', pitch: 39 },
                      { name: 'Perc_Rimshot_Wood.wav', pitch: 37 }
                    ].map((sample, i) => (
                      <div
                        key={i}
                        onClick={() => handleAuditionSample(sample.name, sample.pitch)}
                        className={`flex items-center justify-between px-2 py-1 rounded text-[11px] cursor-pointer transition ${
                          previewingAudio === sample.name ? 'bg-[#ff6e00] text-black font-bold' : 'hover:bg-[#222225] text-zinc-300 hover:text-white'
                        }`}
                      >
                        <span className="truncate">{sample.name}</span>
                        <Play className="w-2.5 h-2.5 opacity-60" />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Category 3: Demo Projects */}
              <div className="space-y-1">
                <div 
                  onClick={() => setExpandedFolders(f => ({ ...f, presets: !f.presets }))}
                  className="flex items-center justify-between text-[10px] font-bold text-[#777] hover:text-white cursor-pointer px-1"
                >
                  <span className="flex items-center gap-1">
                    <Folder className="w-3 h-3 text-[#ff6e00]" />
                    <span>STUDIO DEMOS</span>
                  </span>
                  {expandedFolders.presets ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </div>

                {expandedFolders.presets && (
                  <div className="space-y-0.5 pl-3 border-l border-[#222225] mt-1">
                    {PRESET_PROJECTS.map((p, i) => (
                      <div
                        key={i}
                        onClick={() => setProjectState(p.state)}
                        className="flex items-center justify-between px-2 py-1 rounded hover:bg-[#222225] text-[11px] text-zinc-300 hover:text-white cursor-pointer group"
                      >
                        <span className="truncate">{p.name}</span>
                        <span className="text-[9px] text-[#ff6e00] font-mono">{p.bpm} BPM</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Waveform Sample Preview Area at Sidebar Bottom */}
            <div className="p-3 border-t border-[#333336] bg-[#1a1a1d] space-y-1.5">
              <div className="flex justify-between items-center text-[9px] font-bold">
                <span className="text-white">ACTIVE PREVIEW:</span>
                <span className="text-[#ff6e00] font-mono">{previewingAudio ? 'AUDITIONING' : 'READY'}</span>
              </div>
              <div className="h-6 bg-[#0a0a0b] rounded border border-[#333336] flex items-center px-1.5 gap-0.5 overflow-hidden">
                {Array.from({ length: 28 }).map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 rounded-xs transition-all ${
                      previewingAudio ? 'bg-[#ff6e00]' : 'bg-[#333336]'
                    }`}
                    style={{ height: `${20 + (i % 7) * 12}%` }}
                  />
                ))}
              </div>
            </div>
          </aside>
        )}

        {/* Central View Area */}
        <section className="flex-1 flex flex-col bg-[#121214] overflow-hidden">
          {currentView === 'channel_rack' && (
            <ChannelRack
              channels={projectState.channels}
              patterns={projectState.patterns}
              selectedPatternId={projectState.selectedPatternId}
              onSelectPattern={(id) => setProjectState(prev => ({ ...prev, selectedPatternId: id }))}
              onAddPattern={handleAddPattern}
              selectedChannelId={selectedChannelId}
              onSelectChannel={(id) => setSelectedChannelId(id)}
              onUpdateChannel={handleUpdateChannel}
              onAddChannel={handleAddChannel}
              onDeleteChannel={handleDeleteChannel}
              onOpenPianoRoll={(id) => {
                setSelectedChannelId(id);
                setCurrentView('piano_roll');
              }}
              onOpenInstrument={(id) => {
                setSelectedChannelId(id);
                setCurrentView('instruments');
              }}
              onOpenArp={(id) => {
                setArpChannelId(id);
                setIsArpeggiatorOpen(true);
              }}
              onOpenSampleManager={(id) => {
                setSampleChannelId(id);
                setIsSampleManagerOpen(true);
              }}
              currentStep={currentStep}
              isPlaying={isPlaying}
              swing={projectState.meta.swing}
              onUpdateSwing={(swing) => handleUpdateMeta({ swing })}
            />
          )}

          {currentView === 'piano_roll' && selectedChannel && (
            <PianoRoll
              channel={selectedChannel}
              allChannels={projectState.channels}
              onSelectChannel={(id) => setSelectedChannelId(id)}
              onUpdateChannel={handleUpdateChannel}
              currentStep={currentStep}
              isPlaying={isPlaying}
            />
          )}

          {currentView === 'playlist' && (
            <PlaylistArranger
              tracks={projectState.playlistTracks}
              clips={projectState.playlistClips}
              patterns={projectState.patterns}
              channels={projectState.channels}
              markers={projectState.markers || []}
              onUpdateTracks={handleUpdateTracks}
              onUpdateClips={handleUpdateClips}
              onAddTrack={handleAddPlaylistTrack}
              onUpdateMarkers={(markers) => setProjectState(prev => ({ ...prev, markers }))}
              onSeekToBar={(bar) => setCurrentBar(bar)}
              currentBar={currentBar}
              isPlaying={isPlaying}
            />
          )}

          {currentView === 'mixer' && (
            <Mixer
              tracks={projectState.mixerTracks}
              selectedTrackId={selectedTrackId}
              onSelectTrack={(id) => setSelectedTrackId(id)}
              onUpdateTrack={handleUpdateMixerTrack}
              onAddFxSlot={handleAddFxSlot}
              onDeleteFxSlot={handleDeleteFxSlot}
              onUpdateFxSlot={handleUpdateFxSlot}
              isPlaying={isPlaying}
              onOpenParametricEq={(track) => {
                setEqModalTrackId(track.id);
                setIsParametricEqOpen(true);
              }}
            />
          )}

          {currentView === 'instruments' && selectedChannel && (
            <InstrumentRack
              channel={selectedChannel}
              allChannels={projectState.channels}
              onSelectChannel={(id) => setSelectedChannelId(id)}
              onUpdateChannel={handleUpdateChannel}
            />
          )}

          {currentView === 'sampler' && (
            <div className="flex flex-col h-full items-center justify-center p-8 bg-[#121214] text-center space-y-4">
              <div className="w-16 h-16 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded-2xl flex items-center justify-center text-[#ff6e00]">
                <Volume2 className="w-8 h-8" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white tracking-tight">DIRECTWAVE AUDIO SAMPLER & VOCAL CAPTURE</h2>
                <p className="text-xs text-[#777] max-w-md mt-1">
                  High-fidelity 48kHz Direct-to-Disk recording station with automatic waveform slicing and transient detection.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => setIsAudioRecorderOpen(true)}
                  className="px-5 py-2.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center gap-2 shadow"
                >
                  <div className="w-2.5 h-2.5 bg-black rounded-full" />
                  <span>OPEN MICROPHONE RECORDER</span>
                </button>

                <button
                  onClick={() => setIsSampleManagerOpen(true)}
                  className="px-5 py-2.5 bg-[#00ff88] hover:bg-[#00e67a] text-black font-bold text-xs rounded transition flex items-center gap-2 shadow"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>DIRECTWAVE SAMPLE LOADER</span>
                </button>

                <button
                  onClick={() => setCurrentView('instruments')}
                  className="px-5 py-2.5 bg-[#222225] hover:bg-[#2d2d30] text-white font-bold text-xs rounded border border-[#333336] transition"
                >
                  Open VST Synthesizers
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* 3. Bottom Studio Status Footer */}
      <footer className="h-6 bg-[#1a1a1d] border-t border-[#333336] flex items-center px-4 justify-between shrink-0 select-none">
        <div className="flex items-center gap-4 text-[9px]">
          <span className="text-[#777]">SYNC: <span className="text-[#00ff00] font-bold">ONLINE (E2EE)</span></span>
          <span className="text-[#777]">DSP CPU: <span className="text-white font-bold">{isPlaying ? '18%' : '8%'}</span></span>
          <span className="text-[#777]">LATENCY: <span className="text-white font-bold">2.4ms (LOW)</span></span>
          <span className="text-[#777] hidden md:inline">PROJECT: <span className="text-[#ff6e00] font-bold">{projectState.meta.name}</span></span>
        </div>

        <div className="flex items-center gap-3 text-[9px] font-bold text-[#777]">
          <button 
            onClick={() => setIsHotkeysOpen(true)}
            className="hover:text-white transition cursor-pointer"
          >
            HOTKEYS (SPACE / 1-5)
          </button>
          <span className="w-1 h-1 bg-[#444] rounded-full"></span>
          <button 
            onClick={() => setIsExportOpen(true)}
            className="hover:text-white transition cursor-pointer"
          >
            EXPORT MASTER
          </button>
          <span className="w-1 h-1 bg-[#444] rounded-full"></span>
          <button 
            onClick={() => setIsSubscriptionOpen(true)}
            className="text-[#ff6e00] hover:text-[#ff7d1a] transition cursor-pointer"
          >
            {isProUser ? 'PRO SUITE ACTIVE' : 'PREMIUM TIER'}
          </button>
        </div>
      </footer>

      {/* 4. Modals Container */}
      <ExportModal
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
        channels={projectState.channels}
        clips={projectState.playlistClips}
        meta={projectState.meta}
      />

      <ProjectManagerModal
        isOpen={isProjectManagerOpen}
        onClose={() => setIsProjectManagerOpen(false)}
        currentState={projectState}
        onLoadProject={(st) => setProjectState(st)}
        onUpdateMeta={handleUpdateMeta}
      />

      <CollaborationModal
        isOpen={isCollabOpen}
        onClose={() => setIsCollabOpen(false)}
        comments={comments}
        collaborators={collaborators}
        onAddComment={(text, bar) => {
          const newC: CollabComment = {
            id: `c-${Date.now()}`,
            author: 'Alex (You)',
            avatarColor: '#ff6e00',
            timestamp: Date.now(),
            barPosition: bar,
            text,
            resolved: false
          };
          setComments(prev => [newC, ...prev]);
        }}
        onToggleResolveComment={(id) => {
          setComments(prev => prev.map(c => c.id === id ? { ...c, resolved: !c.resolved } : c));
        }}
        isEncrypted={projectState.meta.isEncrypted}
        onToggleEncryption={() => handleUpdateMeta({ isEncrypted: !projectState.meta.isEncrypted })}
      />

      <AnalyticsModal
        isOpen={isAnalyticsOpen}
        onClose={() => setIsAnalyticsOpen(false)}
        meta={projectState.meta}
        channels={projectState.channels}
        clips={projectState.playlistClips}
      />

      <SubscriptionModal
        isOpen={isSubscriptionOpen}
        onClose={() => setIsSubscriptionOpen(false)}
        isProUser={isProUser}
        onTogglePro={() => setIsProUser(!isProUser)}
      />

      <HotkeysModal
        isOpen={isHotkeysOpen}
        onClose={() => setIsHotkeysOpen(false)}
      />

      <MidiControllerModal
        isOpen={isMidiModalOpen}
        onClose={() => setIsMidiModalOpen(false)}
      />

      <ParametricEqModal
        isOpen={isParametricEqOpen}
        onClose={() => setIsParametricEqOpen(false)}
        track={projectState.mixerTracks.find(t => t.id === eqModalTrackId) || projectState.mixerTracks[0]}
        onUpdateTrack={handleUpdateMixerTrack}
      />

      <MasteringSuiteModal
        isOpen={isMasteringSuiteOpen}
        onClose={() => setIsMasteringSuiteOpen(false)}
        masteringState={masteringSuiteState}
        onUpdateMasteringState={(st) => setMasteringSuiteState(st)}
        isPlaying={isPlaying}
      />

      <GrossBeatModal
        isOpen={isGrossBeatOpen}
        onClose={() => setIsGrossBeatOpen(false)}
        currentStep={currentStep}
        isPlaying={isPlaying}
      />

      <AudioSlicerModal
        isOpen={isAudioSlicerOpen}
        onClose={() => setIsAudioSlicerOpen(false)}
        channels={projectState.channels}
        onUpdateChannel={(chId, updates) => handleUpdateChannel(chId, updates)}
      />

      {(() => {
        const targetArpChannel = projectState.channels.find(c => c.id === arpChannelId) || projectState.channels[0];
        return targetArpChannel ? (
          <ArpeggiatorModal
            isOpen={isArpeggiatorOpen}
            onClose={() => setIsArpeggiatorOpen(false)}
            channel={targetArpChannel}
            onUpdateChannel={(updatedCh) => handleUpdateChannel(updatedCh.id, updatedCh)}
            bpm={projectState.meta.bpm}
          />
        ) : null;
      })()}

      <SampleManagerModal
        isOpen={isSampleManagerOpen}
        onClose={() => setIsSampleManagerOpen(false)}
        channels={projectState.channels}
        selectedChannel={projectState.channels.find(c => c.id === sampleChannelId) || projectState.channels[0]}
        onAssignSampleToChannel={(chId, sampleData) => {
          handleUpdateChannel(chId, { customSample: sampleData });
        }}
        onCreateChannelFromSample={(sampleData) => {
          const channel = {
            id: `ch-sample-${Date.now()}`,
            name: sampleData.name || 'Sample Pad',
            instrumentType: 'sampler' as const,
            volume: 0.85,
            pan: 0,
            pitch: 0,
            mute: false,
            solo: false,
            color: '#00ff88',
            steps: Array(16).fill(false),
            notes: [],
            synthParams: { ...DEFAULT_PROJECT.channels[0].synthParams },
            customSample: sampleData
          } satisfies Omit<Channel, 'mixerTrackId'>;

          setProjectState(prev => appendChannelWithAllocatedMixerTrackId(prev, channel));
          setSelectedChannelId(channel.id);
        }}
      />

      <AudioRecorderModal
        isOpen={isAudioRecorderOpen}
        onClose={() => {
          setIsAudioRecorderOpen(false);
          setIsRecording(false);
        }}
        onSaveRecording={handleSaveRecordingToPlaylist}
      />

      <VocalTunerModal
        isOpen={isVocalTunerOpen}
        onClose={() => setIsVocalTunerOpen(false)}
        vocalTunerSettings={projectState.vocalTunerSettings || {
          enabled: true,
          rootKey: 0,
          scale: 'minor',
          retuneSpeedMs: 15,
          formantShift: 0,
          pitchCorrectionAmount: 0.85,
          vibratoDepth: 0.2,
          humanize: 0.3
        }}
        onUpdateVocalTuner={(settings) => setProjectState(prev => ({ ...prev, vocalTunerSettings: settings }))}
        channels={projectState.channels}
      />

      <MidiLearnModal
        isOpen={isMidiLearnOpen}
        onClose={() => setIsMidiLearnOpen(false)}
        mappings={projectState.midiMappings || []}
        onUpdateMappings={(mappings) => setProjectState(prev => ({ ...prev, midiMappings: mappings }))}
        isLearnActive={isMidiLearnActive}
        onToggleLearn={() => setIsMidiLearnActive(!isMidiLearnActive)}
        onClearAll={() => setProjectState(prev => ({ ...prev, midiMappings: [] }))}
      />

      <MultiZoneSamplerModal
        isOpen={isMultiZoneSamplerOpen}
        onClose={() => setIsMultiZoneSamplerOpen(false)}
        channels={projectState.channels}
        onUpdateChannel={handleUpdateChannel}
      />

      <WavetableSynthModal
        isOpen={isWavetableSynthOpen}
        onClose={() => setIsWavetableSynthOpen(false)}
        channels={projectState.channels}
        onUpdateChannel={handleUpdateChannel}
      />

      <WamPluginModal
        isOpen={isWamPluginOpen}
        onClose={() => setIsWamPluginOpen(false)}
        mixerTracks={projectState.mixerTracks}
        onUpdateMixerTracks={(tracks) => setProjectState(prev => ({ ...prev, mixerTracks: tracks }))}
      />

      <TakeCompingModal
        isOpen={isTakeCompingOpen}
        onClose={() => setIsTakeCompingOpen(false)}
        onPromoteCompToPlaylist={(newClip) => {
          setProjectState(prev => ({
            ...prev,
            playlistClips: [...prev.playlistClips, newClip]
          }));
        }}
      />

      <SidechainRoutingModal
        isOpen={isSidechainOpen}
        onClose={() => setIsSidechainOpen(false)}
        mixerTracks={projectState.mixerTracks}
        onUpdateMixerTracks={(tracks) => setProjectState(prev => ({ ...prev, mixerTracks: tracks }))}
      />

      <PolyphonicEditorModal
        isOpen={isPolyphonicEditorOpen}
        onClose={() => setIsPolyphonicEditorOpen(false)}
      />

      <DesktopAppModal
        isOpen={isDesktopAppOpen}
        onClose={() => setIsDesktopAppOpen(false)}
      />

      <WarpAudioProcessorModal
        isOpen={isWarpProcessorOpen}
        onClose={() => setIsWarpProcessorOpen(false)}
        selectedClip={projectState.playlistClips[0] || null}
        onUpdateClip={(updatedClip) => {
          setProjectState(prev => ({
            ...prev,
            playlistClips: prev.playlistClips.map(c => c.id === updatedClip.id ? updatedClip : c)
          }));
        }}
      />

      <VideoScoringModal
        isOpen={isVideoScoringOpen}
        onClose={() => setIsVideoScoringOpen(false)}
        currentBar={currentBar}
        bpm={projectState.meta.bpm}
        onSeekToBar={(bar) => {
          setCurrentBar(bar);
          setCurrentStep((bar - 1) * 16);
        }}
      />

      <SpatialAudio3DPannerModal
        isOpen={isSpatialAudioOpen}
        onClose={() => setIsSpatialAudioOpen(false)}
        mixerTracks={projectState.mixerTracks}
      />

      <MpeExpressionModal
        isOpen={isMpeExpressionOpen}
        onClose={() => setIsMpeExpressionOpen(false)}
      />

      <StemSplitterAiModal
        isOpen={isStemSplitterOpen}
        onClose={() => setIsStemSplitterOpen(false)}
        onImportStemsToTracks={(stems) => {
          const newTracks = stems.map((s, idx) => ({
            id: projectState.playlistTracks.length + idx + 1,
            name: s.name,
            color: s.type === 'vocals' ? '#ff6e00' : s.type === 'drums' ? '#00ff88' : s.type === 'bass' ? '#00e5ff' : '#a855f7',
            volume: 0.9,
            pan: 0,
            mute: false,
            solo: false,
            height: 'normal' as const
          }));
          const newClips = stems.map((s, idx) => ({
            id: `stem-clip-${Date.now()}-${idx}`,
            trackIndex: projectState.playlistTracks.length + idx,
            startBar: 0,
            lengthBars: 8,
            type: 'audio' as const,
            audioBufferId: `stem-${s.type}`,
            audioName: s.name,
            color: s.type === 'vocals' ? '#ff6e00' : s.type === 'drums' ? '#00ff88' : s.type === 'bass' ? '#00e5ff' : '#a855f7',
            name: s.name
          }));
          setProjectState(prev => ({
            ...prev,
            playlistTracks: [...prev.playlistTracks, ...newTracks],
            playlistClips: [...prev.playlistClips, ...newClips]
          }));
        }}
      />

      <MasterMacroRackModal
        isOpen={isMasterMacrosOpen}
        onClose={() => setIsMasterMacrosOpen(false)}
        mixerTracks={projectState.mixerTracks}
        channels={projectState.channels}
        macroKnobs={projectState.macroKnobs}
        onUpdateMacros={(macros) => {
          setProjectState(prev => ({ ...prev, macroKnobs: macros }));
        }}
      />

      <ProjectBundleZipModal
        isOpen={isProjectZipOpen}
        onClose={() => setIsProjectZipOpen(false)}
        projectState={projectState}
        onLoadProjectState={(loadedState) => {
          setProjectState(loadedState);
        }}
      />

      <OrientationLockModal />
    </div>
  );
}

export default App;
