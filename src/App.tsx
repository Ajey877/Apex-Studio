import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  Pattern,
  MasteringSuiteState
} from './types/daw';
import { audioEngine, type PlaybackStateUpdate } from './audio/audioEngine';
import { 
  DEFAULT_PROJECT, 
  PRESET_PROJECTS, 
  createDefaultMixerTracks, 
  createDefaultPlaylistTracks 
} from './audio/presets';
import { appendChannelWithAllocatedMixerTrackId } from './state/mixerTrackIdentity';
import { deleteChannelFromProjectState, normalizeProjectState } from './state/projectState';
import {
  DEFAULT_PATTERN_LENGTH_STEPS,
  getSelectedPatternLengthSteps,
  setPatternLengthStepsInProjectState
} from './state/patternLength';
import { hydrateProjectAudio, persistProjectState, restorePersistedProjectState, saveAndReconcileProjectState } from './state/projectPersistence';
import { ProjectBackupError, backupProjectBeforeReplacement } from './state/projectBackup';
import { getSampleBufferPersistenceController, waitForSampleBufferPersistence } from './audio/sampleBufferPersistence';
import { planProjectReplacement, runProjectReplacementAfterBackup, type ProjectReplacementPlan, type ProjectReplacementSource } from './state/projectReplacement';
import {
  collectMissingAudioAssets,
  describeMissingAudioAssets,
  getMissingAudioAssetsSignature
} from './state/audioAssetAvailability';
import { createRecordingPlaylistClip, getRecordingAudioBufferId, validateRecordingTargetTrack } from './audio/recordingPipeline';
import { createHistory, type ProjectHistory, resolveSaveShortcut, resolveUndoRedoShortcut } from './state/projectHistory';
import {
  ContinuousHistoryBatcher,
  addFxSlotToProjectState,
  addPatternToProjectState,
  deleteFxSlotFromProjectState,
  getChannelUpdateLabel,
  getFxUpdateLabel,
  getMetaUpdateLabel,
  getMixerUpdateLabel,
  getPatternUpdateLabel,
  isContinuousChannelUpdate,
  isContinuousFxUpdate,
  isContinuousMetaUpdate,
  isContinuousMixerUpdate,
  updateChannelInProjectState,
  updateFxSlotInProjectState,
  updateMacroKnobsInProjectState,
  updateMidiMappingsInProjectState,
  updateMixerTrackInProjectState,
  updateProjectMetadataInProjectState,
  updateVocalTunerInProjectState
} from './state/projectMutations';

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
import { ProjectReplaceConfirmModal } from './components/ProjectReplaceConfirmModal';

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
  AlertTriangle,
  X
} from 'lucide-react';

interface PendingProjectReplacement {
  incomingState: ProjectState;
  plan: ProjectReplacementPlan;
  resolve: (replaced: boolean) => void;
  isWorking: boolean;
  backupError: string | null;
  error: string | null;
}

export function App() {
  // --- Core DAW State ---
  const [projectState, setProjectState] = useState<ProjectState>(DEFAULT_PROJECT);
  const [isProjectHydrating, setIsProjectHydrating] = useState(true);
  const projectPersistenceReadyRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const skipNextAutosaveStateRef = useRef<ProjectState | null>(null);
  const lifecycleSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Phase 8C (P1-11): missing audio must be visible in the app, not only in the
  // console. The banner re-appears whenever the set of missing assets changes.
  const [dismissedMissingAudioSignature, setDismissedMissingAudioSignature] = useState<string | null>(null);
  // Phase 8A: destructive project replacement waits for explicit confirmation (and a backup).
  const [pendingReplacement, setPendingReplacement] = useState<PendingProjectReplacement | null>(null);
  const pendingReplacementRef = useRef<PendingProjectReplacement | null>(null);
  const [currentView, setCurrentView] = useState<ViewMode>('channel_rack');
  const [playMode, setPlayMode] = useState<PlayMode>('pat');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [currentBar, setCurrentBar] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string>(DEFAULT_PROJECT.channels[0]?.id || 'ch-1');
  const [selectedTrackId, setSelectedTrackId] = useState<number>(0); // 0 = Master

  // Project-wide history preserving channels, notes, playlist, and markers.
  const projectHistoryRef = useRef<ProjectHistory>(createHistory(DEFAULT_PROJECT));
  const playlistInteractionActiveRef = useRef(false);
  const projectStateRef = useRef<ProjectState>(DEFAULT_PROJECT);
  const [projectHistoryVersion, setProjectHistoryVersion] = useState(0);

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

  // Project persistence is intentionally hydrated before autosave is enabled.
  useEffect(() => {
    let cancelled = false;
    try {
      audioEngine.init();
    } catch (error) {
      console.warn('[Apex Studio] Audio engine startup initialization failed; continuing with project hydration.', error);
    }

    const restore = async () => {
      try {
        const restored = await restorePersistedProjectState(audioEngine, DEFAULT_PROJECT);
        if (!cancelled && restored.restored) {
          setProjectState(restored.state);
          projectStateRef.current = restored.state;
          resetProjectHistory(restored.state);
          setSelectedChannelId(restored.state.selectedChannelId || DEFAULT_PROJECT.channels[0]?.id || 'ch-1');
          setSelectedTrackId(restored.state.selectedMixerTrackId ?? 0);
          setDismissedMissingAudioSignature(restored.state.dismissedMissingAudioSignature ?? null);
          if (restored.recovered) {
            console.warn('[Apex Studio] The active project record was recovered from a last-known-good snapshot.');
          }
          if (restored.missingAudioIds.length > 0) {
            console.warn(`[Apex Studio] ${restored.missingAudioIds.length} persisted audio asset(s) were unavailable after reload.`);
          }
        }
      } catch (error) {
        console.warn('[Apex Studio] Project startup hydration failed; continuing with the current project.', error);
      } finally {
        if (!cancelled) {
          projectPersistenceReadyRef.current = true;
          setIsProjectHydrating(false);
        }
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const performSave = useCallback(async (
    stateToSave: ProjectState = projectStateRef.current,
    options?: { reconcileAudio?: boolean }
  ): Promise<boolean> => {
    try {
      if (options?.reconcileAudio) {
        await saveAndReconcileProjectState(stateToSave, {
          history: projectHistoryRef.current,
          reconcileAudio: true,
          // Imported-but-unassigned samples and other session audio must not be purged mid-session.
          additionalReferencedIds: audioEngine.getSampleBufferIds()
        });
      } else {
        await persistProjectState(stateToSave);
      }

      if (projectStateRef.current === stateToSave) {
        hasUnsavedChangesRef.current = false;
      }
      setSaveError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Storage persistence failed';
      console.warn('[Apex Studio] Project save failed.', error);
      setSaveError(message);
      return false;
    }
  }, []);

  // Controlled autosave: persist settled project changes without writing on every render.
  useEffect(() => {
    if (!projectPersistenceReadyRef.current) return;
    if (skipNextAutosaveStateRef.current === projectState) {
      skipNextAutosaveStateRef.current = null;
      return;
    }
    hasUnsavedChangesRef.current = true;
    const timer = window.setTimeout(() => {
      void performSave(projectState);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [projectState, performSave]);

  // Save while the page is still active. IndexedDB writes created during
  // unload/beforeunload are not guaranteed to complete, so visibilitychange is
  // the primary recovery signal; beforeunload remains a last-chance trigger and
  // warns when changes are still unsettled.
  useEffect(() => {
    const flushLifecycleSave = () => {
      if (!projectPersistenceReadyRef.current || !hasUnsavedChangesRef.current) return;
      if (lifecycleSavePromiseRef.current) return;
      const pendingAudio = getSampleBufferPersistenceController(audioEngine);
      lifecycleSavePromiseRef.current = (async () => {
        try {
          if (pendingAudio) await pendingAudio.flush();
          return await performSave(projectStateRef.current);
        } finally {
          lifecycleSavePromiseRef.current = null;
        }
      })();
      void lifecycleSavePromiseRef.current.catch(error => {
        console.warn('[Apex Studio] Lifecycle project save failed.', error);
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushLifecycleSave();
    };
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      flushLifecycleSave();
      if (hasUnsavedChangesRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [performSave]);

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
  // Pattern Mode loops over the selected pattern's declared length (16/32/64).
  // `Pattern.lengthSteps` is the single source of truth: the Channel Rack grid,
  // the Piano Roll width, this transport argument and Pattern export all read it.
  const selectedPatternLengthSteps = getSelectedPatternLengthSteps(projectState);

  const handleTogglePlay = () => {
    if (isPlaying) {
      // Real pause: the transport keeps its position, scheduled audio is
      // cancelled, and Play resumes from the paused position.
      audioEngine.pause();
      setIsPlaying(false);
    } else {
      // Play from an isolated snapshot: automation writes channel volume/pan/filter
      // during playback and must never mutate live project state (undo/redo and
      // saves would otherwise capture transient playback values).
      const snapshot = audioEngine.createPlaybackSnapshot(
        projectState.channels,
        projectState.playlistClips,
        projectState.mixerTracks
      );
      audioEngine.play(
        snapshot.channels,
        snapshot.clips,
        playMode,
        projectState.selectedPatternId,
        snapshot.mixerTracks,
        selectedPatternLengthSteps,
        projectState.playlistTracks
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
      const snapshot = audioEngine.createPlaybackSnapshot(
        projectState.channels,
        projectState.playlistClips,
        projectState.mixerTracks
      );
      audioEngine.play(
        snapshot.channels,
        snapshot.clips,
        nextMode,
        projectState.selectedPatternId,
        snapshot.mixerTracks,
        selectedPatternLengthSteps,
        projectState.playlistTracks
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

  // Keep a synchronous project ref for pointer and history interactions.
  useEffect(() => {
    projectStateRef.current = projectState;
  }, [projectState]);

  const continuousBatcherRef = useRef<ContinuousHistoryBatcher>(
    new ContinuousHistoryBatcher({
      debounceMs: 300,
      onCommit: (state, label) => commitProjectHistory(state, label)
    })
  );

  const resetProjectHistory = useCallback((state: ProjectState) => {
    continuousBatcherRef.current.cancel();
    projectHistoryRef.current = createHistory(state);
    playlistInteractionActiveRef.current = false;
    setProjectHistoryVersion(version => version + 1);
  }, []);

  const commitProjectHistory = useCallback((state: ProjectState, label: string) => {
    continuousBatcherRef.current.cancel();
    const nextHistory = projectHistoryRef.current.commit(state, label);
    if (nextHistory !== projectHistoryRef.current) {
      projectHistoryRef.current = nextHistory;
      setProjectHistoryVersion(version => version + 1);
    }
  }, []);

  /**
   * Keep only playback-consumed project collections synchronized while the
   * engine owns an isolated take. Other React state remains UI/history state
   * and is intentionally not copied into the real-time scheduler.
   */
  const synchronizeActivePlayback = useCallback((previous: ProjectState, next: ProjectState) => {
    const update: PlaybackStateUpdate = {};
    if (previous.channels !== next.channels) update.channels = next.channels;
    if (previous.playlistClips !== next.playlistClips) update.clips = next.playlistClips;
    if (previous.mixerTracks !== next.mixerTracks) update.mixerTracks = next.mixerTracks;
    // Playlist lane mute is audio state for the running take: muting a lane
    // silences its clips at the trigger boundary, unmuting restarts a clip the
    // playhead is inside. The mixer insert routing is never touched.
    if (previous.playlistTracks !== next.playlistTracks) update.playlistTracks = next.playlistTracks;
    // Pattern Mode plays the selected pattern, so its declared length belongs to
    // the live take: a 16 <-> 32 change (or switching to a pattern of a different
    // length) moves the running loop boundary instead of waiting for a restart.
    // Song Mode ignores it inside the engine.
    const previousPatternLengthSteps = getSelectedPatternLengthSteps(previous);
    const nextPatternLengthSteps = getSelectedPatternLengthSteps(next);
    if (previousPatternLengthSteps !== nextPatternLengthSteps) {
      update.patternLengthSteps = nextPatternLengthSteps;
    }
    if (update.channels || update.clips || update.mixerTracks || update.playlistTracks || update.patternLengthSteps !== undefined) {
      audioEngine.synchronizePlaybackState(update);
    }
  }, []);

  const resetPlaylistHistory = resetProjectHistory;
  const commitPlaylistHistory = commitProjectHistory;

  const updatePlaylistProjectState = useCallback((state: ProjectState) => {
    const previousState = projectStateRef.current;
    projectStateRef.current = state;
    synchronizeActivePlayback(previousState, state);
    setProjectState(state);
  }, [synchronizeActivePlayback]);

  const mutateProjectState = useCallback((
    updater: (current: ProjectState) => ProjectState,
    label: string,
    options?: { isContinuous?: boolean }
  ): ProjectState => {
    const currentState = projectStateRef.current;
    const nextState = updater(currentState);
    projectStateRef.current = nextState;
    synchronizeActivePlayback(currentState, nextState);
    setProjectState(nextState);

    if (options?.isContinuous) {
      continuousBatcherRef.current.update(nextState, label);
    } else {
      continuousBatcherRef.current.flush();
      commitProjectHistory(nextState, label);
    }
    return nextState;
  }, [commitProjectHistory, synchronizeActivePlayback]);

  const handleContinuousInteractionStart = useCallback((label?: string) => {
    continuousBatcherRef.current.start(label);
  }, []);

  const handleContinuousInteractionEnd = useCallback((label?: string) => {
    continuousBatcherRef.current.flush(label);
  }, []);

  const handleUndo = useCallback(() => {
    if (playlistInteractionActiveRef.current) return;
    continuousBatcherRef.current.flush();
    const previousState = projectStateRef.current;
    const nextHistory = projectHistoryRef.current.undo();
    if (nextHistory === projectHistoryRef.current) return;
    projectHistoryRef.current = nextHistory;
    projectStateRef.current = nextHistory.present;
    synchronizeActivePlayback(previousState, nextHistory.present);
    setProjectState(nextHistory.present);
    setProjectHistoryVersion(version => version + 1);

    // When stopped there is no playback snapshot to update, so keep the live
    // mixer graph in step with history for the next audition.
    if (!audioEngine.isPlaybackActive()) {
      nextHistory.present.mixerTracks.forEach(track => {
        audioEngine.updateMixerTrack(track);
      });
    }
  }, [synchronizeActivePlayback]);

  const handleRedo = useCallback(() => {
    if (playlistInteractionActiveRef.current) return;
    continuousBatcherRef.current.flush();
    const previousState = projectStateRef.current;
    const nextHistory = projectHistoryRef.current.redo();
    if (nextHistory === projectHistoryRef.current) return;
    projectHistoryRef.current = nextHistory;
    projectStateRef.current = nextHistory.present;
    synchronizeActivePlayback(previousState, nextHistory.present);
    setProjectState(nextHistory.present);
    setProjectHistoryVersion(version => version + 1);

    if (!audioEngine.isPlaybackActive()) {
      nextHistory.present.mixerTracks.forEach(track => {
        audioEngine.updateMixerTrack(track);
      });
    }
  }, [synchronizeActivePlayback]);

  const handlePlaylistUndo = handleUndo;
  const handlePlaylistRedo = handleRedo;

  const handlePlaylistInteractionStart = useCallback(() => {
    playlistInteractionActiveRef.current = true;
  }, []);

  const handlePlaylistInteractionEnd = useCallback(() => {
    if (!playlistInteractionActiveRef.current) return;
    playlistInteractionActiveRef.current = false;
    commitProjectHistory(projectStateRef.current, 'Playlist interaction');
  }, [commitProjectHistory]);

  /**
   * Replaces the open project. Validation happens before anything destructive:
   * a project that fails normalization leaves the current project untouched.
   */
  const applyProjectReplacement = useCallback(async (
    state: ProjectState,
    options: { backup: boolean }
  ): Promise<void> => {
    const normalized = normalizeProjectState(state);
    await runProjectReplacementAfterBackup(
      options.backup
        ? () => backupProjectBeforeReplacement(projectStateRef.current, { reason: 'replace' }).then(() => undefined)
        : undefined,
      async () => {
        handleStop();
        try {
          const hydrated = await hydrateProjectAudio(normalized, audioEngine);
          projectStateRef.current = hydrated.state;
          skipNextAutosaveStateRef.current = hydrated.state;
          setProjectState(hydrated.state);
          resetProjectHistory(hydrated.state);
          setSelectedChannelId(hydrated.state.selectedChannelId || hydrated.state.channels[0]?.id || 'ch-1');
          setSelectedTrackId(hydrated.state.selectedMixerTrackId ?? 0);
          const saved = await performSave(hydrated.state, { reconcileAudio: true });
          if (!saved) throw new Error('Replaced project could not be persisted');
        } catch (error) {
          console.warn('[Apex Studio] Project audio hydration failed; loading project without audio.', error);
          projectStateRef.current = normalized;
          skipNextAutosaveStateRef.current = normalized;
          setProjectState(normalized);
          resetProjectHistory(normalized);
          setSelectedChannelId(normalized.selectedChannelId || normalized.channels[0]?.id || 'ch-1');
          setSelectedTrackId(normalized.selectedMixerTrackId ?? 0);
          const saved = await performSave(normalized, { reconcileAudio: false });
          if (!saved) throw new Error('Replaced project could not be persisted');
        }
      }
    );
  }, [resetProjectHistory, performSave]);

  const settlePendingReplacement = useCallback((replaced: boolean) => {
    const pending = pendingReplacementRef.current;
    pendingReplacementRef.current = null;
    setPendingReplacement(null);
    pending?.resolve(replaced);
  }, []);

  /**
   * Entry point for every project load (demos, manifest/bundle import, new session,
   * backup restore). Pristine templates are replaced immediately; anything with
   * work waits for the confirm dialog. Resolves true only when the project was replaced.
   */
  const handleLoadProjectState = useCallback(async (
    state: ProjectState,
    options?: { source?: ProjectReplacementSource }
  ): Promise<boolean> => {
    const plan = planProjectReplacement(projectStateRef.current, state, { source: options?.source });
    if (!plan.requiresConfirmation) {
      await applyProjectReplacement(state, { backup: false });
      return true;
    }
    // A newer request supersedes any dialog still waiting for an answer.
    if (pendingReplacementRef.current) settlePendingReplacement(false);
    return new Promise<boolean>(resolve => {
      const pending: PendingProjectReplacement = { incomingState: state, plan, resolve, isWorking: false, backupError: null, error: null };
      pendingReplacementRef.current = pending;
      setPendingReplacement(pending);
    });
  }, [applyProjectReplacement, settlePendingReplacement]);

  const confirmPendingReplacement = useCallback(async () => {
    const pending = pendingReplacementRef.current;
    if (!pending || pending.isWorking) return;
    const update = (patch: Partial<PendingProjectReplacement>) => {
      const current = pendingReplacementRef.current;
      if (!current) return; // superseded or cancelled while working
      const next = { ...current, ...patch };
      pendingReplacementRef.current = next;
      setPendingReplacement(next);
    };
    update({ isWorking: true, backupError: null, error: null });
    try {
      // A confirmed replacement always takes the backup-required path. There is
      // intentionally no alternate confirmation that can bypass it.
      await applyProjectReplacement(pending.incomingState, { backup: pending.plan.shouldBackup });
      settlePendingReplacement(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn('[Apex Studio] Project replacement did not complete.', error);
      if (error instanceof ProjectBackupError) {
        update({ isWorking: false, backupError: message });
      } else {
        update({ isWorking: false, error: message });
      }
    }
  }, [applyProjectReplacement, settlePendingReplacement]);

  // --- Project State Handlers ---
  const handleUpdateMeta = (updates: Partial<ProjectMetadata>, options?: { isContinuous?: boolean }) => {
    const isContinuous = options?.isContinuous ?? isContinuousMetaUpdate(updates);
    mutateProjectState(
      current => updateProjectMetadataInProjectState(current, updates),
      getMetaUpdateLabel(updates),
      { isContinuous }
    );
  };

  const handleUpdateChannel = (
    channelId: string,
    updates: Partial<Channel>,
    options?: { isContinuous?: boolean }
  ) => {
    const isContinuous = options?.isContinuous ?? isContinuousChannelUpdate(updates);
    mutateProjectState(
      current => updateChannelInProjectState(current, channelId, updates),
      getChannelUpdateLabel(updates),
      { isContinuous }
    );
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

    mutateProjectState(
      current => appendChannelWithAllocatedMixerTrackId(current, channel),
      'Add channel'
    );
    setSelectedChannelId(channel.id);
  };

  const handleDeleteChannel = (channelId: string) => {
    const currentState = projectStateRef.current;
    if (currentState.channels.length <= 1) return;

    const result = deleteChannelFromProjectState(currentState, channelId);
    if (!result.deletedChannel) return;

    audioEngine.stopChannelVoices(channelId);

    if (result.removedMixerTrackId !== null) {
      audioEngine.removeMixerChannel(result.removedMixerTrackId);
      if (selectedTrackId === result.removedMixerTrackId) {
        setSelectedTrackId(0);
      }
    }

    mutateProjectState(
      () => result.state,
      'Delete channel'
    );
    if (selectedChannelId === channelId) {
      setSelectedChannelId(result.state.selectedChannelId);
    }
  };

  const handleAddPattern = () => {
    const current = projectStateRef.current;
    const nextIdx = current.patterns.length + 1;
    const newPat: Pattern = {
      id: `pat-${nextIdx}-${Date.now()}`,
      name: `Pattern ${nextIdx}`,
      color: '#ff6e00',
      lengthSteps: DEFAULT_PATTERN_LENGTH_STEPS
    };
    mutateProjectState(
      curr => addPatternToProjectState(curr, newPat),
      'Add pattern'
    );
  };

  /**
   * Channel Rack 16/32 control. It writes the SELECTED pattern's declared length
   * through the project mutation layer, so the change is history-aware (undo/redo),
   * persisted, and reaches the running playback take via `synchronizeActivePlayback`.
   * A pattern id that matches nothing (corrupt/legacy project) is a safe no-op.
   */
  const handleUpdatePatternLength = (lengthSteps: number) => {
    const updates = { lengthSteps };
    mutateProjectState(
      current => setPatternLengthStepsInProjectState(current, current.selectedPatternId, lengthSteps),
      getPatternUpdateLabel(updates)
    );
  };

  const handleUpdateTracks = (tracks: PlaylistTrack[]) => {
    const nextState = { ...projectStateRef.current, playlistTracks: tracks };
    updatePlaylistProjectState(nextState);
    if (!playlistInteractionActiveRef.current) {
      commitPlaylistHistory(nextState, 'Track change');
    }
  };

  const handleUpdateClips = (clips: PlaylistClip[]) => {
    const currentState = projectStateRef.current;
    const currentAudioIds = new Set(
      currentState.playlistClips
        .map(clip => clip.type === 'audio' ? clip.audioBufferId : undefined)
        .filter((id): id is string => Boolean(id))
    );
    const newAudioIds = [...new Set(
      clips
        .filter(clip => clip.type === 'audio' && Boolean(clip.audioBufferId))
        .map(clip => clip.audioBufferId as string)
        .filter(id => !currentAudioIds.has(id))
    )];

    const commitClipChange = () => {
      const nextState = { ...projectStateRef.current, playlistClips: clips };
      updatePlaylistProjectState(nextState);
      if (!playlistInteractionActiveRef.current) {
        commitPlaylistHistory(nextState, 'Clip change');
      }
    };

    if (newAudioIds.length === 0) {
      commitClipChange();
      return;
    }

    // Dropped/bounced buffers are registered synchronously, but their storage
    // write is asynchronous. Do not put the clip id into project state until
    // every newly referenced asset has completed successfully.
    void Promise.all(newAudioIds.map(id => waitForSampleBufferPersistence(audioEngine, id)))
      .then(() => {
        commitClipChange();
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : 'audio persistence failed';
        setSaveError(`Audio asset could not be persisted: ${message}`);
      });
  };

  const handleUpdateMarkers = (markers: ProjectState['markers']) => {
    const nextState = { ...projectStateRef.current, markers };
    updatePlaylistProjectState(nextState);
    commitPlaylistHistory(nextState, 'Marker change');
  };

  const handleAddPlaylistTrack = () => {
    const nextId = projectStateRef.current.playlistTracks.length + 1;
    const newTrack: PlaylistTrack = {
      id: nextId,
      name: `Track ${nextId}`,
      color: '#ff6e00',
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false
    };
    const nextState = {
      ...projectStateRef.current,
      playlistTracks: [...projectStateRef.current.playlistTracks, newTrack]
    };
    updatePlaylistProjectState(nextState);
    commitPlaylistHistory(nextState, 'Add playlist track');
  };

  const handleUpdateMixerTrack = (
    trackId: number,
    updates: Partial<MixerTrack>,
    options?: { isContinuous?: boolean }
  ) => {
    const isContinuous = options?.isContinuous ?? isContinuousMixerUpdate(updates);
    mutateProjectState(
      current => updateMixerTrackInProjectState(current, trackId, updates),
      getMixerUpdateLabel(updates),
      { isContinuous }
    );

    const target = projectStateRef.current.mixerTracks.find(t => t.id === trackId);
    if (target && !audioEngine.isPlaybackActive()) {
      audioEngine.updateMixerTrack(target);
    }
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

    mutateProjectState(
      current => addFxSlotToProjectState(current, trackId, newSlot),
      'Add effect'
    );
  };

  const handleDeleteFxSlot = (trackId: number, slotId: string) => {
    mutateProjectState(
      current => deleteFxSlotFromProjectState(current, trackId, slotId),
      'Delete effect'
    );
  };

  const handleUpdateFxSlot = (
    trackId: number,
    slotId: string,
    updates: Partial<FxSlot>,
    options?: { isContinuous?: boolean }
  ) => {
    const isContinuous = options?.isContinuous ?? isContinuousFxUpdate(updates);
    mutateProjectState(
      current => updateFxSlotInProjectState(current, trackId, slotId, updates),
      getFxUpdateLabel(updates),
      { isContinuous }
    );
  };

  // --- Phase 6D: Recording -> decode -> register -> playlist clip ---
  const handleSaveRecordingToPlaylist = async (recording: AudioRecording, targetTrackIndex: number) => {
    if (!recording.audioBlob || recording.audioBlob.size === 0) {
      throw new Error('The recording contains no audio data');
    }

    // Validate before registering so stale UI selections cannot leave orphaned buffers.
    const targetTrack = validateRecordingTargetTrack(projectState.playlistTracks, targetTrackIndex);
    const targetTrackId = targetTrack.id;

    const audioBufferId = getRecordingAudioBufferId(recording.id);
    const loaded = await audioEngine.loadAudioFile(recording.audioBlob, audioBufferId);
    // Recording registration uses the same persistence gate as dropped/bounced
    // playlist audio. Do not commit a project reference before its asset is durable.
    await waitForSampleBufferPersistence(audioEngine, audioBufferId);
    const persistedRecording: AudioRecording = { ...recording, audioBufferId };
    // AudioEngine has no buffer-removal API; a removed target leaves only this narrow in-memory orphan.
    const currentState = projectStateRef.current;
    if (!currentState.playlistTracks.some(track => track.id === targetTrackId)) return;
    const currentTargetTrackIndex = currentState.playlistTracks.findIndex(track => track.id === targetTrackId);
    const recordingClip = createRecordingPlaylistClip(
      persistedRecording,
      { id: audioBufferId, buffer: loaded.buffer, peaks: loaded.peaks, duration: loaded.duration },
      currentState.playlistTracks,
      currentTargetTrackIndex,
      currentState.meta.bpm,
      `rec-clip-${Date.now()}`
    );
    const nextState = {
      ...currentState,
      recordings: [...currentState.recordings, persistedRecording],
      playlistClips: [...currentState.playlistClips, recordingClip],
      meta: { ...currentState.meta, updated: Date.now() }
    };
    updatePlaylistProjectState(nextState);
    commitPlaylistHistory(nextState, 'Record audio to playlist');
  };

  // --- Computer Keypad & Keyboard Live Engine ---
  const [keyboardOctave, setKeyboardOctave] = useState<number>(0);
  const activeHeldKeysRef = useRef<Set<string>>(new Set());

  // --- Keyboard Shortcuts & Global Hotkeys ---
  useEffect(() => {
    const KEY_NOTE_MAP: Record<string, number> = {
      // QWERTY White & Black Piano Keys (C4 to E5)
      'KeyA': 60,
      'KeyW': 61,
      'KeyS': 62,
      'KeyE': 63,
      'KeyD': 64,
      'KeyF': 65,
      'KeyT': 66,
      'KeyG': 67,
      'KeyY': 68,
      'KeyH': 69,
      'KeyU': 70,
      'KeyJ': 71,
      'KeyK': 72,
      'KeyO': 73,
      'KeyL': 74,
      'KeyP': 75,
      'Semicolon': 76,

      // Numeric Keypad (Numpad 1..9 MPC Drum & Bass triggers)
      'Numpad1': 36,
      'Numpad2': 38,
      'Numpad3': 42,
      'Numpad4': 46,
      'Numpad5': 49,
      'Numpad6': 39,
      'Numpad7': 51,
      'Numpad8': 48,
      'Numpad9': 45
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      // Modifier shortcuts take precedence over virtual piano keyboard triggers.
      const shortcut = resolveUndoRedoShortcut(e);
      if (shortcut.action === 'undo') {
        e.preventDefault();
        handleUndo();
        return;
      } else if (shortcut.action === 'redo') {
        e.preventDefault();
        handleRedo();
        return;
      }

      if (resolveSaveShortcut(e)) {
        e.preventDefault();
        void performSave(projectStateRef.current, { reconcileAudio: true });
        return;
      }

      const isModifier = Boolean(e.ctrlKey || e.metaKey);

      if (!isModifier && e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
        return;
      } else if (!isModifier && (e.key === 'l' || e.key === 'L')) {
        handleTogglePlayMode();
        return;
      } else if (!isModifier && (e.key === 'r' || e.key === 'R')) {
        handleToggleRecord();
        return;
      } else if (!isModifier && (e.key === 'm' || e.key === 'M')) {
        setMetronome(m => !m);
        return;
      } else if (e.code === 'Numpad0' || (!isModifier && e.key === '0') || e.code === 'Home') {
        handleStop();
        return;
      }

      if (!isModifier && (e.key === '1' || e.code === 'F6')) {
        e.preventDefault();
        setCurrentView('channel_rack');
        return;
      } else if (!isModifier && (e.key === '2' || e.code === 'F7')) {
        e.preventDefault();
        setCurrentView('piano_roll');
        return;
      } else if (!isModifier && (e.key === '3' || e.code === 'F5')) {
        e.preventDefault();
        setCurrentView('playlist');
        return;
      } else if (!isModifier && (e.key === '4' || e.code === 'F9')) {
        e.preventDefault();
        setCurrentView('mixer');
        return;
      } else if (!isModifier && (e.key === '5' || e.code === 'F8')) {
        e.preventDefault();
        setCurrentView('instruments');
        return;
      }

      if (!isModifier && e.code === 'KeyZ') {
        setKeyboardOctave(prev => Math.max(-2, prev - 1));
        return;
      } else if (!isModifier && e.code === 'KeyX') {
        setKeyboardOctave(prev => Math.min(2, prev + 1));
        return;
      }

      if (!isModifier && KEY_NOTE_MAP[e.code] !== undefined && !activeHeldKeysRef.current.has(e.code) && !e.repeat) {
        activeHeldKeysRef.current.add(e.code);
        const basePitch = KEY_NOTE_MAP[e.code];
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
  }, [isPlaying, playMode, projectState, selectedChannelId, keyboardOctave, handleUndo, handleRedo]);

  const selectedChannel = projectState.channels.find(c => c.id === selectedChannelId) || projectState.channels[0];

  // Phase 8C (P1-11): missing audio is derived from the project itself (hydration
  // flags clips/samples), so it stays accurate across save, reload and recovery
  // without a second source of truth.
  const missingAudioAssets = useMemo(
    () => collectMissingAudioAssets(projectState),
    [projectState]
  );
  const missingAudioSignature = getMissingAudioAssetsSignature(missingAudioAssets);
  const showMissingAudioBanner =
    missingAudioAssets.totalCount > 0 && missingAudioSignature !== dismissedMissingAudioSignature;

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

  if (isProjectHydrating) {
    return (
      <div className="bg-[#0a0a0b] text-[#b0b0b0] h-screen w-screen flex items-center justify-center font-sans">
        <div className="text-xs font-bold tracking-[0.2em] text-[#ff6e00]">LOADING PROJECT</div>
      </div>
    );
  }

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
        saveError={saveError}
      />

      {saveError && (
        <div
          id="save-failure-banner"
          role="alert"
          className="bg-[#361111] border-b border-red-500/60 px-3 sm:px-4 py-1.5 flex items-center justify-between text-xs text-red-200 z-40 shrink-0 select-text"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>
              <strong>Project save failed:</strong> {saveError}. Recent changes could not be saved to local storage.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              id="save-retry-btn"
              onClick={() => void performSave(projectStateRef.current, { reconcileAudio: true })}
              className="px-2.5 py-0.5 bg-red-600 hover:bg-red-500 text-white font-bold text-[11px] rounded transition cursor-pointer"
            >
              Retry Save
            </button>
            <button
              id="save-failure-dismiss-btn"
              onClick={() => setSaveError(null)}
              className="text-red-300 hover:text-white p-0.5 transition cursor-pointer"
              title="Dismiss warning"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {showMissingAudioBanner && (
        <div
          id="missing-audio-banner"
          role="alert"
          data-audio-unavailable="true"
          title={missingAudioAssets.messages.join('\n')}
          className="bg-[#3a2411] border-b border-amber-500/60 px-3 sm:px-4 py-1.5 flex items-center justify-between text-xs text-amber-100 z-40 shrink-0 select-text"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Missing audio:</strong> {describeMissingAudioAssets(missingAudioAssets)}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {missingAudioAssets.samples.length > 0 && (
              <button
                id="missing-audio-open-sample-loader-btn"
                onClick={() => {
                  setSampleChannelId(missingAudioAssets.samples[0].channelId);
                  setIsSampleManagerOpen(true);
                }}
                className="px-2.5 py-0.5 bg-amber-500 hover:bg-amber-400 text-black font-bold text-[11px] rounded transition cursor-pointer"
              >
                Re-import Sample
              </button>
            )}
            <button
              id="missing-audio-dismiss-btn"
              onClick={() => {
                const nextState = { ...projectStateRef.current, dismissedMissingAudioSignature: missingAudioSignature, meta: { ...projectStateRef.current.meta, updated: Date.now() } };
                projectStateRef.current = nextState;
                setProjectState(nextState);
                setDismissedMissingAudioSignature(missingAudioSignature);
              }}
              className="text-amber-200 hover:text-white p-0.5 transition cursor-pointer"
              title="Dismiss warning"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 2. Main Studio Work Area */}
      <main className="flex-1 flex overflow-hidden">
        {isSidebarOpen && (
          <aside className="w-56 md:w-64 bg-[#141416] border-r border-[#333336] flex flex-col shrink-0">
            <div className="p-2.5 border-b border-[#333336] flex justify-between items-center bg-[#1a1a1d]">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#777]">STUDIO BROWSER</span>
              <button onClick={() => setIsProjectManagerOpen(true)} className="text-[#ff6e00] hover:text-white text-[10px] font-bold transition">+ New</button>
            </div>
            <div className="p-2 border-b border-[#333336] bg-[#121214]">
              <div className="flex items-center gap-1.5 bg-[#1a1a1d] px-2 py-1 rounded border border-[#333336]">
                <Search className="w-3 h-3 text-[#777]" />
                <input type="text" placeholder="Search samples & VSTs..." value={browserSearch} onChange={(e) => setBrowserSearch(e.target.value)} className="w-full bg-transparent text-[11px] text-white placeholder-[#555] focus:outline-none" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-3 text-xs">
              <div className="space-y-1">
                <div onClick={() => setExpandedFolders(f => ({ ...f, instruments: !f.instruments }))} className="flex items-center justify-between text-[10px] font-bold text-[#777] hover:text-white cursor-pointer px-1">
                  <span className="flex items-center gap-1"><Cpu className="w-3 h-3 text-[#ff6e00]" /><span>SYNTHS & GENERATORS</span></span>
                  {expandedFolders.instruments ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </div>
                {expandedFolders.instruments && (
                  <div className="space-y-0.5 pl-3 border-l border-[#222225] mt-1">
                    {[{ name: 'Grand Concert Piano', type: 'grand_piano', color: '#e0e0e0' },{ name: 'Vintage Rhodes MK1', type: 'rhodes_epiano', color: '#e67e22' },{ name: 'Hammond B3 Organ', type: 'hammond_organ', color: '#d35400' },{ name: 'Orchestral Strings', type: 'strings_ensemble', color: '#9b59b6' },{ name: 'Pizzicato Strings', type: 'pizzicato_strings', color: '#8e44ad' },{ name: 'Nylon Pluck Guitar', type: 'nylon_guitar', color: '#27ae60' },{ name: 'Cinematic Horns/Brass', type: 'cinematic_brass', color: '#f39c12' },{ name: '808 Tuned Sub Bass', type: 'sub_808', color: '#ff5722' },{ name: 'TB-303 Acid Bassline', type: 'acid_303', color: '#2ecc71' },{ name: 'Reese Heavy Bass', type: 'reese_bass', color: '#c0392b' },{ name: 'JP-8000 Supersaw', type: 'supersaw_lead', color: '#00d2d3' },{ name: 'Atmospheric Pad', type: 'ambient_pad', color: '#54a0ff' },{ name: 'Vocal Choir Formant', type: 'vox_choir', color: '#ff9ff3' },{ name: 'Wooden Marimba/Bell', type: 'marimba_bell', color: '#1dd1a1' },{ name: '8-Bit Retro Chiptune', type: 'chiptune_8bit', color: '#feca57' },{ name: 'MiniSynth Subtractive', type: 'minisynth', color: '#ff6e00' },{ name: 'Toxic FM Synthesizer', type: 'fmsynth', color: '#00bcd4' },{ name: 'DirectWave Sampler', type: 'sampler', color: '#4caf50' },{ name: '808 Drum Machine', type: 'drumpad', color: '#ff5722' }].map((item, i) => (
                      <div key={i} onClick={() => handleAddChannel(item.type as InstrumentType, item.name, item.color)} className="flex items-center justify-between px-2 py-1 rounded hover:bg-[#222225] text-[11px] text-zinc-300 hover:text-white cursor-pointer group"><span className="truncate">{item.name}</span><span className="text-[9px] text-[#ff6e00] opacity-0 group-hover:opacity-100 font-bold">+ LOAD</span></div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div onClick={() => setExpandedFolders(f => ({ ...f, drums: !f.drums }))} className="flex items-center justify-between text-[10px] font-bold text-[#777] hover:text-white cursor-pointer px-1">
                  <span className="flex items-center gap-1"><Disc className="w-3 h-3 text-[#ff6e00]" /><span>DRUM SAMPLES (808 / MPC)</span></span>
                  {expandedFolders.drums ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </div>
                {expandedFolders.drums && (
                  <div className="space-y-0.5 pl-3 border-l border-[#222225] mt-1">
                    {[{ name: '808_Sub_Punch.wav', pitch: 36 },{ name: 'Snare_Trap_Hard.wav', pitch: 38 },{ name: 'HiHat_Closed_Tight.wav', pitch: 42 },{ name: 'Clap_Studio_Dry.wav', pitch: 39 },{ name: 'Perc_Rimshot_Wood.wav', pitch: 37 }].map((sample, i) => (
                      <div key={i} onClick={() => handleAuditionSample(sample.name, sample.pitch)} className={`flex items-center justify-between px-2 py-1 rounded text-[11px] cursor-pointer transition ${previewingAudio === sample.name ? 'bg-[#ff6e00] text-black font-bold' : 'hover:bg-[#222225] text-zinc-300 hover:text-white'}`}><span className="truncate">{sample.name}</span><Play className="w-2.5 h-2.5 opacity-60" /></div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div onClick={() => setExpandedFolders(f => ({ ...f, presets: !f.presets }))} className="flex items-center justify-between text-[10px] font-bold text-[#777] hover:text-white cursor-pointer px-1">
                  <span className="flex items-center gap-1"><Folder className="w-3 h-3 text-[#ff6e00]" /><span>STUDIO DEMOS</span></span>
                  {expandedFolders.presets ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </div>
                {expandedFolders.presets && (
                  <div className="space-y-0.5 pl-3 border-l border-[#222225] mt-1">
                    {PRESET_PROJECTS.map((p, i) => (
                      <div key={i} onClick={() => void handleLoadProjectState(p.state, { source: 'studio-demo' })} className="flex items-center justify-between px-2 py-1 rounded hover:bg-[#222225] text-[11px] text-zinc-300 hover:text-white cursor-pointer group"><span className="truncate">{p.name}</span><span className="text-[9px] text-[#ff6e00] font-mono">{p.bpm} BPM</span></div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="p-3 border-t border-[#333336] bg-[#1a1a1d] space-y-1.5">
              <div className="flex justify-between items-center text-[9px] font-bold"><span className="text-white">ACTIVE PREVIEW:</span><span className="text-[#ff6e00] font-mono">{previewingAudio ? 'AUDITIONING' : 'READY'}</span></div>
              <div className="h-6 bg-[#0a0a0b] rounded border border-[#333336] flex items-center px-1.5 gap-0.5 overflow-hidden">{Array.from({ length: 28 }).map((_, i) => <div key={i} className={`flex-1 rounded-xs transition-all ${previewingAudio ? 'bg-[#ff6e00]' : 'bg-[#333336]'}`} style={{ height: `${20 + (i % 7) * 12}%` }} />)}</div>
            </div>
          </aside>
        )}

        <section className="flex-1 flex flex-col bg-[#121214] overflow-hidden">
          {currentView === 'channel_rack' && (
            <ChannelRack
              channels={projectState.channels}
              patterns={projectState.patterns}
              selectedPatternId={projectState.selectedPatternId}
              onSelectPattern={(id) => {
                const previousState = projectStateRef.current;
                projectStateRef.current = { ...previousState, selectedPatternId: id };
                setProjectState(prev => ({ ...prev, selectedPatternId: id }));
                // Pattern Mode plays the selected pattern, so the running take must
                // follow the newly selected pattern's declared length (selection is
                // a view change: it stays outside project history, as before).
                synchronizeActivePlayback(previousState, projectStateRef.current);
              }}
              onAddPattern={handleAddPattern}
              onUpdatePatternLength={handleUpdatePatternLength}
              selectedChannelId={selectedChannelId}
              onSelectChannel={(id) => setSelectedChannelId(id)}
              onUpdateChannel={handleUpdateChannel}
              onAddChannel={handleAddChannel}
              onDeleteChannel={handleDeleteChannel}
              onOpenPianoRoll={(id) => { setSelectedChannelId(id); setCurrentView('piano_roll'); }}
              onOpenInstrument={(id) => { setSelectedChannelId(id); setCurrentView('instruments'); }}
              onOpenArp={(id) => { setArpChannelId(id); setIsArpeggiatorOpen(true); }}
              onOpenSampleManager={(id) => { setSampleChannelId(id); setIsSampleManagerOpen(true); }}
              currentStep={currentStep}
              isPlaying={isPlaying}
              swing={projectState.meta.swing}
              onUpdateSwing={(swing) => handleUpdateMeta({ swing })}
              onInteractionStart={handleContinuousInteractionStart}
              onInteractionEnd={handleContinuousInteractionEnd}
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
              patternLengthSteps={selectedPatternLengthSteps}
            />
          )}

          {currentView === 'playlist' && (
            <PlaylistArranger
              tracks={projectState.playlistTracks}
              clips={projectState.playlistClips}
              patterns={projectState.patterns}
              channels={projectState.channels}
              mixerTracks={projectState.mixerTracks}
              markers={projectState.markers || []}
              onUpdateTracks={handleUpdateTracks}
              onUpdateClips={handleUpdateClips}
              onAddTrack={handleAddPlaylistTrack}
              onUpdateMarkers={handleUpdateMarkers}
              onPlaylistInteractionStart={handlePlaylistInteractionStart}
              onPlaylistInteractionEnd={handlePlaylistInteractionEnd}
              canUndo={projectHistoryVersion >= 0 && projectHistoryRef.current.canUndo}
              canRedo={projectHistoryVersion >= 0 && projectHistoryRef.current.canRedo}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onSeekToBar={(bar) => {
                // Real transport seek: works stopped, paused and playing. While
                // playing it cancels audio scheduled for the old position and
                // restarts any playlist audio clip the new position lands in.
                const targetBar = Math.max(1, Math.floor(Number(bar) || 1));
                const secondsPerBar = (60 / projectState.meta.bpm) * 4;
                audioEngine.seek((targetBar - 1) * secondsPerBar);
                setCurrentBar(targetBar);
              }}
              currentBar={currentBar}
              isPlaying={isPlaying}
              bpm={projectState.meta.bpm}
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
              onOpenParametricEq={(track) => { setEqModalTrackId(track.id); setIsParametricEqOpen(true); }}
              onInteractionStart={handleContinuousInteractionStart}
              onInteractionEnd={handleContinuousInteractionEnd}
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
              <div className="w-16 h-16 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded-2xl flex items-center justify-center text-[#ff6e00]"><Volume2 className="w-8 h-8" /></div>
              <div><h2 className="text-xl font-bold text-white tracking-tight">DIRECTWAVE AUDIO SAMPLER & VOCAL CAPTURE</h2><p className="text-xs text-[#777] max-w-md mt-1">High-fidelity 48kHz Direct-to-Disk recording station with automatic waveform slicing and transient detection.</p></div>
              <div className="flex items-center gap-3 pt-2">
                <button onClick={() => setIsAudioRecorderOpen(true)} className="px-5 py-2.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center gap-2 shadow"><div className="w-2.5 h-2.5 bg-black rounded-full" /><span>OPEN MICROPHONE RECORDER</span></button>
                <button onClick={() => setIsSampleManagerOpen(true)} className="px-5 py-2.5 bg-[#00ff88] hover:bg-[#00e67a] text-black font-bold text-xs rounded transition flex items-center gap-2 shadow"><Volume2 className="w-3.5 h-3.5" /><span>DIRECTWAVE SAMPLE LOADER</span></button>
                <button onClick={() => setCurrentView('instruments')} className="px-5 py-2.5 bg-[#222225] hover:bg-[#2d2d30] text-white font-bold text-xs rounded border border-[#333336] transition">Open VST Synthesizers</button>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="h-6 bg-[#1a1a1d] border-t border-[#333336] flex items-center px-4 justify-between shrink-0 select-none">
        <div className="flex items-center gap-4 text-[9px]">
          <span className="text-[#777]">SYNC: <span className="text-[#00ff00] font-bold">ONLINE (E2EE)</span></span>
          <span className="text-[#777]">DSP CPU: <span className="text-white font-bold">{isPlaying ? '18%' : '8%'}</span></span>
          <span className="text-[#777]">LATENCY: <span className="text-white font-bold">2.4ms (LOW)</span></span>
          <span className="text-[#777] hidden md:inline">PROJECT: <span className="text-[#ff6e00] font-bold">{projectState.meta.name}</span></span>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-bold text-[#777]">
          <button onClick={() => setIsHotkeysOpen(true)} className="hover:text-white transition cursor-pointer">HOTKEYS (SPACE / 1-5)</button>
          <span className="w-1 h-1 bg-[#444] rounded-full"></span>
          <button onClick={() => setIsExportOpen(true)} className="hover:text-white transition cursor-pointer">EXPORT MASTER</button>
          <span className="w-1 h-1 bg-[#444] rounded-full"></span>
          <button onClick={() => setIsSubscriptionOpen(true)} className="text-[#ff6e00] hover:text-[#ff7d1a] transition cursor-pointer">{isProUser ? 'PRO SUITE ACTIVE' : 'PREMIUM TIER'}</button>
        </div>
      </footer>

      <ExportModal isOpen={isExportOpen} onClose={() => setIsExportOpen(false)} channels={projectState.channels} clips={projectState.playlistClips} mixerTracks={projectState.mixerTracks} meta={projectState.meta} patternLengthSteps={selectedPatternLengthSteps} playlistTracks={projectState.playlistTracks} />
      <ProjectManagerModal isOpen={isProjectManagerOpen} onClose={() => setIsProjectManagerOpen(false)} currentState={projectState} onLoadProject={handleLoadProjectState} onUpdateMeta={handleUpdateMeta} />
      <CollaborationModal isOpen={isCollabOpen} onClose={() => setIsCollabOpen(false)} comments={comments} collaborators={collaborators} onAddComment={(text, bar) => { const newC: CollabComment = { id: `c-${Date.now()}`, author: 'Alex (You)', avatarColor: '#ff6e00', timestamp: Date.now(), barPosition: bar, text, resolved: false }; setComments(prev => [newC, ...prev]); }} onToggleResolveComment={(id) => setComments(prev => prev.map(c => c.id === id ? { ...c, resolved: !c.resolved } : c))} />
      <AnalyticsModal isOpen={isAnalyticsOpen} onClose={() => setIsAnalyticsOpen(false)} meta={projectState.meta} channels={projectState.channels} clips={projectState.playlistClips} />
      <SubscriptionModal isOpen={isSubscriptionOpen} onClose={() => setIsSubscriptionOpen(false)} isProUser={isProUser} onTogglePro={() => setIsProUser(!isProUser)} />
      <HotkeysModal isOpen={isHotkeysOpen} onClose={() => setIsHotkeysOpen(false)} />
      <MidiControllerModal isOpen={isMidiModalOpen} onClose={() => setIsMidiModalOpen(false)} channels={projectState.channels} mixerTracks={projectState.mixerTracks} midiMappings={projectState.midiMappings || []} onUpdateMidiMappings={(mappings) => mutateProjectState(curr => updateMidiMappingsInProjectState(curr, mappings), 'Update MIDI mappings')} activeChannel={selectedChannel} />
      <ParametricEqModal isOpen={isParametricEqOpen} onClose={() => setIsParametricEqOpen(false)} mixerTrack={projectState.mixerTracks.find(t => t.id === eqModalTrackId) || projectState.mixerTracks[0]} onUpdateTrack={(track) => handleUpdateMixerTrack(track.id, track)} />
      <MasteringSuiteModal isOpen={isMasteringSuiteOpen} onClose={() => setIsMasteringSuiteOpen(false)} masteringState={masteringSuiteState} onUpdateMasteringState={(st) => setMasteringSuiteState(st)} isPlaying={isPlaying} />
      <GrossBeatModal isOpen={isGrossBeatOpen} onClose={() => setIsGrossBeatOpen(false)} currentStep={currentStep} isPlaying={isPlaying} />
      <AudioSlicerModal isOpen={isAudioSlicerOpen} onClose={() => setIsAudioSlicerOpen(false)} channels={projectState.channels} onUpdateChannel={(chId, updates) => handleUpdateChannel(chId, updates)} />
      {(() => {
        const targetArpChannel = projectState.channels.find(c => c.id === arpChannelId) || projectState.channels[0];
        return targetArpChannel ? <ArpeggiatorModal isOpen={isArpeggiatorOpen} onClose={() => setIsArpeggiatorOpen(false)} channel={targetArpChannel} onUpdateChannel={(updatedCh) => handleUpdateChannel(updatedCh.id, updatedCh)} bpm={projectState.meta.bpm} /> : null;
      })()}
      <SampleManagerModal isOpen={isSampleManagerOpen} onClose={() => setIsSampleManagerOpen(false)} channels={projectState.channels} selectedChannel={projectState.channels.find(c => c.id === sampleChannelId) || projectState.channels[0]} onAssignSampleToChannel={(chId, sampleData) => { handleUpdateChannel(chId, { customSample: sampleData }); }} onCreateChannelFromSample={(sampleData) => { const channel = { id: `ch-sample-${Date.now()}`, name: sampleData.name || 'Sample Pad', instrumentType: 'sampler' as const, volume: 0.85, pan: 0, pitch: 0, mute: false, solo: false, color: '#00ff88', steps: Array(16).fill(false), notes: [], synthParams: { ...DEFAULT_PROJECT.channels[0].synthParams }, customSample: sampleData } satisfies Omit<Channel, 'mixerTrackId'>; mutateProjectState(current => appendChannelWithAllocatedMixerTrackId(current, channel), 'Create channel from sample'); setSelectedChannelId(channel.id); }} />
      <AudioRecorderModal isOpen={isAudioRecorderOpen} onClose={() => { setIsAudioRecorderOpen(false); setIsRecording(false); }} onSaveRecording={handleSaveRecordingToPlaylist} />
      <VocalTunerModal isOpen={isVocalTunerOpen} onClose={() => setIsVocalTunerOpen(false)} vocalTunerSettings={projectState.vocalTuner || { enabled: true, rootKey: 0, scale: 'minor', retuneSpeedMs: 15, formantShift: 0, vibratoDepth: 0.2, humanize: 0.3 }} onUpdateVocalTuner={(settings) => mutateProjectState(curr => updateVocalTunerInProjectState(curr, settings), 'Update vocal tuner')} channels={projectState.channels} />
      <MidiLearnModal isOpen={isMidiLearnOpen} onClose={() => setIsMidiLearnOpen(false)} midiMappings={projectState.midiMappings || []} onUpdateMidiMappings={(mappings) => mutateProjectState(curr => updateMidiMappingsInProjectState(curr, mappings), 'Update MIDI mappings')} channels={projectState.channels} mixerTracks={projectState.mixerTracks} connectedDevices={projectState.connectedMidiDevices || []} isMidiLearnActive={isMidiLearnActive} onToggleMidiLearn={(active) => setIsMidiLearnActive(active)} />
      <MultiZoneSamplerModal isOpen={isMultiZoneSamplerOpen} onClose={() => setIsMultiZoneSamplerOpen(false)} channels={projectState.channels} onUpdateChannel={handleUpdateChannel} />
      <WavetableSynthModal isOpen={isWavetableSynthOpen} onClose={() => setIsWavetableSynthOpen(false)} channels={projectState.channels} onUpdateChannel={handleUpdateChannel} />
      <WamPluginModal isOpen={isWamPluginOpen} onClose={() => setIsWamPluginOpen(false)} mixerTracks={projectState.mixerTracks} onUpdateMixerTracks={(tracks) => mutateProjectState(curr => ({ ...curr, mixerTracks: tracks }), 'Update mixer tracks')} />
      <TakeCompingModal isOpen={isTakeCompingOpen} onClose={() => setIsTakeCompingOpen(false)} onPromoteCompToPlaylist={(newClip) => { const nextState = { ...projectStateRef.current, playlistClips: [...projectStateRef.current.playlistClips, newClip] }; updatePlaylistProjectState(nextState); commitPlaylistHistory(nextState, 'Promote comp to playlist'); }} />
      <SidechainRoutingModal isOpen={isSidechainOpen} onClose={() => setIsSidechainOpen(false)} mixerTracks={projectState.mixerTracks} onUpdateMixerTracks={(tracks) => mutateProjectState(curr => ({ ...curr, mixerTracks: tracks }), 'Update mixer routing')} />
      <PolyphonicEditorModal isOpen={isPolyphonicEditorOpen} onClose={() => setIsPolyphonicEditorOpen(false)} />
      <DesktopAppModal isOpen={isDesktopAppOpen} onClose={() => setIsDesktopAppOpen(false)} />
      <WarpAudioProcessorModal isOpen={isWarpProcessorOpen} onClose={() => setIsWarpProcessorOpen(false)} selectedClip={projectState.playlistClips[0] || null} onUpdateClip={(updatedClip) => { const nextState = { ...projectStateRef.current, playlistClips: projectStateRef.current.playlistClips.map(c => c.id === updatedClip.id ? updatedClip : c) }; updatePlaylistProjectState(nextState); commitPlaylistHistory(nextState, 'Warp audio clip'); }} />
      <VideoScoringModal isOpen={isVideoScoringOpen} onClose={() => setIsVideoScoringOpen(false)} currentBar={currentBar} bpm={projectState.meta.bpm} onSeekToBar={(bar) => { setCurrentBar(bar); setCurrentStep((bar - 1) * 16); }} />
      <SpatialAudio3DPannerModal isOpen={isSpatialAudioOpen} onClose={() => setIsSpatialAudioOpen(false)} mixerTracks={projectState.mixerTracks} />
      <MpeExpressionModal isOpen={isMpeExpressionOpen} onClose={() => setIsMpeExpressionOpen(false)} />
      <StemSplitterAiModal isOpen={isStemSplitterOpen} onClose={() => setIsStemSplitterOpen(false)} onImportStemsToTracks={(stems) => { const base = projectStateRef.current; const newTracks = stems.map((s, idx) => ({ id: base.playlistTracks.length + idx + 1, name: s.name, color: s.type === 'vocals' ? '#ff6e00' : s.type === 'drums' ? '#00ff88' : s.type === 'bass' ? '#00e5ff' : '#a855f7', volume: 0.9, pan: 0, mute: false, solo: false, height: 'normal' as const })); const newClips = stems.map((s, idx) => ({ id: `stem-clip-${Date.now()}-${idx}`, trackIndex: base.playlistTracks.length + idx, startBar: 0, lengthBars: 8, type: 'audio' as const, audioBufferId: `stem-${s.type}`, audioName: s.name, color: s.type === 'vocals' ? '#ff6e00' : s.type === 'drums' ? '#00ff88' : s.type === 'bass' ? '#00e5ff' : '#a855f7', name: s.name })); const nextState = { ...base, playlistTracks: [...base.playlistTracks, ...newTracks], playlistClips: [...base.playlistClips, ...newClips] }; updatePlaylistProjectState(nextState); commitPlaylistHistory(nextState, 'Import stems to playlist'); }} />
      <MasterMacroRackModal isOpen={isMasterMacrosOpen} onClose={() => setIsMasterMacrosOpen(false)} mixerTracks={projectState.mixerTracks} channels={projectState.channels} macroKnobs={projectState.macroKnobs} onUpdateMacros={(macros) => mutateProjectState(curr => updateMacroKnobsInProjectState(curr, macros), 'Update macro controls', { isContinuous: true })} />
      <ProjectBundleZipModal isOpen={isProjectZipOpen} onClose={() => setIsProjectZipOpen(false)} projectState={projectState} onLoadProjectState={handleLoadProjectState} />
      <ProjectReplaceConfirmModal
        plan={pendingReplacement?.plan ?? null}
        isWorking={pendingReplacement?.isWorking ?? false}
        backupError={pendingReplacement?.backupError ?? null}
        error={pendingReplacement?.error ?? null}
        onConfirm={() => void confirmPendingReplacement()}
        onCancel={() => settlePendingReplacement(false)}
      />
      <OrientationLockModal />
    </div>
  );
}

export default App;
