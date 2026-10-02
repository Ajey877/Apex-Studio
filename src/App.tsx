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
import { audioEngine, type MidiEventPayload, type PlaybackStateUpdate } from './audio/audioEngine';
import { MidiCcMappingRuntime } from './audio/midiMappingRuntime';
import { 
  DEFAULT_PROJECT, 
  createDefaultMixerTracks, 
  createDefaultPlaylistTracks 
} from './audio/presets';
import { appendChannelWithAllocatedMixerTrackId } from './state/mixerTrackIdentity';
import { deleteChannelFromProjectState, normalizeProjectState } from './state/projectState';
import { reapplyMacroRackOnHydration } from './state/macroMappings';
import {
  DEFAULT_PATTERN_LENGTH_STEPS,
  getSelectedPatternLengthSteps,
  setPatternLengthStepsInProjectState
} from './state/patternLength';
import { getAudioIdsForProject, hydrateProjectAudio, persistProjectState, restorePersistedProjectState, saveAndReconcileProjectState } from './state/projectPersistence';
import { ProjectBackupError, backupProjectBeforeReplacement } from './state/projectBackup';
import { getSampleBufferPersistenceController, waitForSampleBufferPersistence } from './audio/sampleBufferPersistence';
import { getProjectSessionBlobUrls, replaceProjectSessionBlobUrls, sessionBlobUrlRegistry } from './state/sessionBlobUrlRegistry';
import { planProjectReplacement, runProjectReplacementAfterBackup, type ProjectReplacementPlan, type ProjectReplacementSource } from './state/projectReplacement';
import {
  collectMissingAudioAssets,
  describeMissingAudioAssets,
  getMissingAudioAssetsSignature
} from './state/audioAssetAvailability';
import { createRecordingPlaylistClip, getRecordingAudioBufferId, validateRecordingTargetTrack } from './audio/recordingPipeline';
import { createHistory, type ProjectHistory, resolveSaveShortcut, resolveUndoRedoShortcut } from './state/projectHistory';
import { KEY_NOTE_MAP, getKeyboardNotePitch } from './state/musicalKeyboard';
import { fullscreenController } from './state/fullscreen';
import { createNewSessionRequest } from './state/newSession';
import { getProjectTimelineBars, setTimelineBarsInProjectState } from './state/playlistTimeline';
import { resolveApplicationMenuShortcut, type ApplicationMenuCommandId } from './state/applicationMenu';
import {
  createApplicationMenuCommandState,
  runApplicationMenuCommand,
  type ApplicationMenuCommandDeps
} from './state/applicationMenuCommands';
import { isRecordingProjectGenerationCurrent, nextRecordingProjectGeneration } from './state/recordingProjectLifecycle';
import { isPureAdditivePlaylistClipAppend, resolveAdditivePlaylistClipPublication } from './state/playlistAudioPublication';
import {
  describeRejectedPlaylistAudioClips,
  isPublishablePlaylistClip,
  resolvePlaylistClipPublication
} from './state/playlistClipIntegrity';
import { synchronizeBeforeRuntimePublication } from './state/runtimeStatePublication';
import {
  ContinuousHistoryBatcher,
  addFxSlotToProjectState,
  applyRuntimeProjectStateMutation,
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
  updateMacroRackInProjectState,
  updateMidiMappingsInProjectState,
  updateMixerTrackInProjectState,
  updateProjectMetadataInProjectState,
  updateVocalTunerInProjectState
} from './state/projectMutations';

// Component Suite
import { ApplicationMenuBar } from './components/ApplicationMenuBar';
import { TransportBar } from './components/TransportBar';
import { ChannelRack } from './components/ChannelRack';
import { PianoRoll } from './components/PianoRoll';
import { PlaylistArranger } from './components/PlaylistArranger';
import { Mixer } from './components/Mixer';
import { InstrumentRack } from './components/InstrumentRack';
import { SampleSlicerPanel } from './components/SampleSlicerPanel';
import { SampleLibraryPanel } from './components/SampleLibraryPanel';
import { StudioBrowser } from './components/StudioBrowser';
import { StatusBar } from './components/StatusBar';

// Modals
import { AudioRecorderModal } from './components/AudioRecorderModal';
import { ExportModal } from './components/ExportModal';
import { CollaborationModal } from './components/CollaborationModal';
import { AnalyticsModal } from './components/AnalyticsModal';
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
import { TakeCompingModal } from './components/TakeCompingModal';
import { SidechainRoutingModal } from './components/SidechainRoutingModal';
import { PolyphonicEditorModal } from './components/PolyphonicEditorModal';
import { DesktopAppModal } from './components/DesktopAppModal';
import { WarpAudioProcessorModal } from './components/WarpAudioProcessorModal';
import { DEFAULT_INCLUDE_MIXER_FX } from './components/exportMixerFxPreference';
import { MasterMacroRackModal } from './components/MasterMacroRackModal';
import { ProjectBundleZipModal } from './components/ProjectBundleZipModal';
import { ProjectReplaceConfirmModal } from './components/ProjectReplaceConfirmModal';
import { hasOpenModalDialog } from './components/ModalFrame';

import { AlertTriangle, X } from 'lucide-react';

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
  /**
   * Phase 52: the playlist's selected clip id, published up from
   * PlaylistArranger. Timeline tools (the Warp processor) use it so they edit
   * the clip the user selected instead of whichever clip happened to be first
   * in the array.
   */
  const [selectedPlaylistClipId, setSelectedPlaylistClipId] = useState<string | null>(null);

  // Project-wide history preserving channels, notes, playlist, and markers.
  const projectHistoryRef = useRef<ProjectHistory>(createHistory(DEFAULT_PROJECT));
  const playlistInteractionActiveRef = useRef(false);
  const projectStateRef = useRef<ProjectState>(DEFAULT_PROJECT);
  const recordingProjectGenerationRef = useRef(0);
  const cancelRecordingForReplacementRef = useRef<(() => Promise<void>) | null>(null);
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
  const [isTakeCompingOpen, setIsTakeCompingOpen] = useState(false);
  const [isSidechainOpen, setIsSidechainOpen] = useState(false);
  const [isPolyphonicEditorOpen, setIsPolyphonicEditorOpen] = useState(false);
  const [isDesktopAppOpen, setIsDesktopAppOpen] = useState(false);
  const [isWarpProcessorOpen, setIsWarpProcessorOpen] = useState(false);
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
          audioEngine.setProjectSampleBufferOwnership(getAudioIdsForProject(restored.state));
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
    options?: { reconcileAudio?: boolean; additionalReferencedIds?: Iterable<string> }
  ): Promise<boolean> => {
    try {
      if (options?.reconcileAudio) {
        await saveAndReconcileProjectState(stateToSave, {
          history: projectHistoryRef.current,
          reconcileAudio: true,
          // Preserve explicit session-only buffers without treating stale project-owned
          // engine residency as a reference to the active project.
          additionalReferencedIds: options?.additionalReferencedIds ?? audioEngine.getPersistableSampleBufferIds()
        });
      } else {
        await persistProjectState(stateToSave);
      }

      audioEngine.setProjectSampleBufferOwnership(getAudioIdsForProject(stateToSave));
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
    if (audioEngine.isOfflineRenderLeaseHeld()) return;
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
    if (audioEngine.isOfflineRenderLeaseHeld()) return;
    audioEngine.stop();
    setIsPlaying(false);
    setCurrentStep(0);
    setCurrentBar(1);
  };

  const handleTogglePlayMode = () => {
    if (audioEngine.isOfflineRenderLeaseHeld()) return;
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
    if (audioEngine.isOfflineRenderLeaseHeld()) return;
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
    // silences its clips at the trigger boundary, unmuting restarts the clip the
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

  const synchronizeRuntimeState = useCallback((previous: ProjectState, next: ProjectState) => {
    synchronizeActivePlayback(previous, next);
    if (!audioEngine.isPlaybackActive() && previous.mixerTracks !== next.mixerTracks) {
      next.mixerTracks.forEach(track => audioEngine.updateMixerTrack(track));
    }
  }, [synchronizeActivePlayback]);

  const restoreRuntimeState = useCallback((previous: ProjectState) => {
    if (audioEngine.isPlaybackActive()) {
      previous.mixerTracks.forEach(track => audioEngine.updateMixerTrack(track));
      audioEngine.synchronizePlaybackState({
        channels: previous.channels,
        clips: previous.playlistClips,
        mixerTracks: previous.mixerTracks,
        playlistTracks: previous.playlistTracks,
        patternLengthSteps: getSelectedPatternLengthSteps(previous),
      });
    } else {
      previous.mixerTracks.forEach(track => audioEngine.updateMixerTrack(track));
    }
  }, []);


  const resetPlaylistHistory = resetProjectHistory;
  const commitPlaylistHistory = commitProjectHistory;

  const updatePlaylistProjectState = useCallback((state: ProjectState) => {
    const previousState = projectStateRef.current;
    synchronizeBeforeRuntimePublication(
      previousState,
      state,
      synchronizeRuntimeState,
      publishedState => {
        projectStateRef.current = publishedState;
        setProjectState(publishedState);
        return publishedState;
      },
      restoreRuntimeState,
    );
  }, [restoreRuntimeState, synchronizeRuntimeState]);

  const mutateProjectState = useCallback((
    updater: (current: ProjectState) => ProjectState,
    label: string,
    options?: { isContinuous?: boolean }
  ): ProjectState => {
    const currentState = projectStateRef.current;
    const nextState = applyRuntimeProjectStateMutation(currentState, updater);
    return synchronizeBeforeRuntimePublication(
      currentState,
      nextState,
      synchronizeRuntimeState,
      publishedState => {
        projectStateRef.current = publishedState;
        setProjectState(publishedState);

        if (options?.isContinuous) {
          continuousBatcherRef.current.update(publishedState, label);
        } else {
          continuousBatcherRef.current.flush();
          commitProjectHistory(publishedState, label);
        }
        return publishedState;
      },
      restoreRuntimeState,
    );
  }, [commitProjectHistory, restoreRuntimeState, synchronizeRuntimeState]);

  // Keep the MIDI bridge pointed at the freshest mutation callback without
  // re-subscribing to the engine's MIDI stream on every render.
  const mutateProjectStateRef = useRef(mutateProjectState);
  useEffect(() => {
    mutateProjectStateRef.current = mutateProjectState;
  }, [mutateProjectState]);

  /**
   * Phase 46: make saved MIDI CC mappings actually control their targets.
   *
   * The runtime is a consumer of the audio engine's existing MIDI stream (the
   * same one the transport LED and MIDI Learn use) and applies each mapping
   * through the existing project mutation/history path, so undo/redo,
   * persistence and live playback stay consistent. The master output is the one
   * target that is not project state, so it goes through the engine's existing
   * master-volume parameter API.
   */
  useEffect(() => {
    const midiMappingRuntime = new MidiCcMappingRuntime({
      getProjectState: () => projectStateRef.current,
      applyProjectMutation: (updater, label) => {
        mutateProjectStateRef.current(updater, label, { isContinuous: true });
      },
      applyMasterVolume: normalizedValue => {
        const state = projectStateRef.current;
        audioEngine.applyAutomationValue(
          { type: 'master_vol', targetId: 0 },
          normalizedValue,
          state.channels,
          state.mixerTracks,
        );
      }
    });

    const handleMidiMessage = (event: MidiEventPayload) => {
      midiMappingRuntime.handleMidiEvent(event);
    };

    audioEngine.addMidiListener(handleMidiMessage);
    return () => {
      audioEngine.removeMidiListener(handleMidiMessage);
    };
  }, []);

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
    synchronizeBeforeRuntimePublication(
      previousState,
      nextHistory.present,
      synchronizeRuntimeState,
      publishedState => {
        projectHistoryRef.current = nextHistory;
        projectStateRef.current = publishedState;
        setProjectState(publishedState);
        setProjectHistoryVersion(version => version + 1);
        return publishedState;
      },
      restoreRuntimeState,
    );

  }, [restoreRuntimeState, synchronizeRuntimeState]);

  const handleRedo = useCallback(() => {
    if (playlistInteractionActiveRef.current) return;
    continuousBatcherRef.current.flush();
    const previousState = projectStateRef.current;
    const nextHistory = projectHistoryRef.current.redo();
    if (nextHistory === projectHistoryRef.current) return;
    synchronizeBeforeRuntimePublication(
      previousState,
      nextHistory.present,
      synchronizeRuntimeState,
      publishedState => {
        projectHistoryRef.current = nextHistory;
        projectStateRef.current = publishedState;
        setProjectState(publishedState);
        setProjectHistoryVersion(version => version + 1);
        return publishedState;
      },
      restoreRuntimeState,
    );

  }, [restoreRuntimeState, synchronizeRuntimeState]);

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
    // Phase 51: every interactive load path (project manager import, bundle ZIP,
    // demo project, backup restore) funnels through here, so this is where a
    // loaded macro rack is re-applied to the parameters it drives. Doing it
    // before hydration/backup means the published, persisted and audio-hydrated
    // state are all the same resolved document.
    const normalized = reapplyMacroRackOnHydration(normalizeProjectState(state));
    await runProjectReplacementAfterBackup(
      options.backup
        ? () => backupProjectBeforeReplacement(projectStateRef.current, { reason: 'replace' }).then(() => undefined)
        : undefined,
      async () => {
        recordingProjectGenerationRef.current = nextRecordingProjectGeneration(recordingProjectGenerationRef.current);
        await cancelRecordingForReplacementRef.current?.();
        handleStop();
        try {
          const previousProjectState = projectStateRef.current;
          const hydrated = await hydrateProjectAudio(normalized, audioEngine);
          replaceProjectSessionBlobUrls(previousProjectState, hydrated.state);
          projectStateRef.current = hydrated.state;
          skipNextAutosaveStateRef.current = hydrated.state;
          setProjectState(hydrated.state);
          resetProjectHistory(hydrated.state);
          setSelectedChannelId(hydrated.state.selectedChannelId || hydrated.state.channels[0]?.id || 'ch-1');
          setSelectedTrackId(hydrated.state.selectedMixerTrackId ?? 0);
          const replacementReferencedIds = new Set([
            ...getAudioIdsForProject(hydrated.state),
            ...audioEngine.getSessionSampleBufferIds()
          ]);
          const saved = await performSave(hydrated.state, {
            reconcileAudio: true,
            additionalReferencedIds: replacementReferencedIds
          });
          if (!saved) throw new Error('Replaced project could not be persisted');
        } catch (error) {
          console.warn('[Apex Studio] Project audio hydration failed; loading project without audio.', error);
          for (const url of getProjectSessionBlobUrls(projectStateRef.current)) {
            sessionBlobUrlRegistry.release(url);
          }
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

  const handleUpdateClips = (incomingClips: PlaylistClip[]) => {
    const currentState = projectStateRef.current;

    /**
     * Phase 48 publication invariant. A `type: 'audio'` clip with no real
     * `audioBufferId` is silent during playback, is never flagged by the
     * missing-audio surfaces, and hard-blocks WAV and stem export for the whole
     * project. It must never reach project state, project history, or
     * persistence — so the gate runs before `updatePlaylistProjectState`,
     * before the history commit, and before the autosave that follows it.
     *
     * Valid clips in the same batch still publish, so a legitimate drag/drop
     * travelling alongside a rejected clip is never lost. When a rejection
     * leaves nothing that differs from the live playlist we return instead of
     * publishing a no-op state object.
     */
    const { publishable: clips, rejected, shouldPublish } =
      resolvePlaylistClipPublication(currentState.playlistClips, incomingClips);
    if (rejected.length > 0) {
      setSaveError(describeRejectedPlaylistAudioClips(rejected));
      if (!shouldPublish) return;
    }

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

    // An import that only appends clips can land on top of whatever the playlist
    // became while its asset was being persisted. Anything else keeps the strict
    // gate, so a stale or conflicting write can never clobber newer edits.
    const isAdditiveImport = isPureAdditivePlaylistClipAppend(currentState.playlistClips, clips);

    const commitClipChange = () => {
      const latestState = projectStateRef.current;
      const playlistClips = isAdditiveImport
        ? resolveAdditivePlaylistClipPublication(latestState.playlistClips, currentState.playlistClips, clips)
        : clips;
      // Null means the captured update is no longer valid against the live
      // playlist: reject it rather than republishing the stale snapshot. When the
      // merge resolves to the live array itself, a sibling publication already
      // carried every appended clip and there is nothing left to publish.
      if (playlistClips === null) return;
      if (playlistClips === latestState.playlistClips && playlistClips !== clips) return;
      const nextState = { ...latestState, playlistClips };
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
    void Promise.all(newAudioIds.map(id => waitForSampleBufferPersistence(
      audioEngine,
      id,
      isAdditiveImport ? { allowAdditivePlaylistRevision: true } : undefined
    )))
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

  /**
   * Phase 54: the playlist timeline length is project state, not component
   * state, so changing it goes through the same mutation + history path as any
   * other arrangement edit. `setTimelineBarsInProjectState` also revalidates
   * every clip against the new boundary, which is what makes shrink safe.
   */
  const handleUpdateTotalBars = (totalBars: number) => {
    mutateProjectState(
      current => setTimelineBarsInProjectState(current, totalBars),
      'Change timeline length'
    );
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

  /**
   * Phase 48: the take-comping promotion path is gated by the same invariant as
   * `handleUpdateClips`. A clip with no real `audioBufferId` never reaches
   * project state or history; the refusal is reported through the existing
   * save-error surface. Nothing here fabricates audio or a buffer id.
   */
  const handlePromoteCompToPlaylist = (newClip: PlaylistClip) => {
    if (!isPublishablePlaylistClip(newClip)) {
      setSaveError(describeRejectedPlaylistAudioClips([newClip]));
      return;
    }
    const nextState = {
      ...projectStateRef.current,
      playlistClips: [...projectStateRef.current.playlistClips, newClip]
    };
    updatePlaylistProjectState(nextState);
    commitPlaylistHistory(nextState, 'Promote comp to playlist');
  };

  // --- Phase 6D: Recording -> decode -> register -> playlist clip ---
  const handleSaveRecordingToPlaylist = async (
    recording: AudioRecording,
    targetTrackIndex: number,
    recordingProjectGeneration: number
  ) => {
    if (!isRecordingProjectGenerationCurrent(recordingProjectGeneration, recordingProjectGenerationRef.current)) {
      throw new Error('The recording belongs to a project that has already been replaced');
    }
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
    if (!isRecordingProjectGenerationCurrent(recordingProjectGeneration, recordingProjectGenerationRef.current)) {
      sessionBlobUrlRegistry.release(recording.audioUrl ?? '');
      throw new Error('The recording belongs to a project that has already been replaced');
    }
    const persistedRecording: AudioRecording = { ...recording, audioBufferId };
    // AudioEngine has no buffer-removal API; a removed target leaves only this narrow in-memory orphan.
    const currentState = projectStateRef.current;
    if (!isRecordingProjectGenerationCurrent(recordingProjectGeneration, recordingProjectGenerationRef.current)) {
      sessionBlobUrlRegistry.release(recording.audioUrl ?? '');
      throw new Error('The recording belongs to a project that has already been replaced');
    }
    if (!currentState.playlistTracks.some(track => track.id === targetTrackId)) {
      // The temporary take is being discarded because its target disappeared.
      sessionBlobUrlRegistry.release(recording.audioUrl ?? '');
      return;
    }
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
    if (!isRecordingProjectGenerationCurrent(recordingProjectGeneration, recordingProjectGenerationRef.current)) {
      sessionBlobUrlRegistry.release(recording.audioUrl ?? '');
      throw new Error('The recording belongs to a project that has already been replaced');
    }
    updatePlaylistProjectState(nextState);
    commitPlaylistHistory(nextState, 'Record audio to playlist');
    // The modal's temporary recording ownership is transferred to the project
    // only after the project state has successfully accepted the take.
    sessionBlobUrlRegistry.transfer(recording.audioUrl ?? '');
  };

  // --- Computer Keypad & Keyboard Live Engine ---
  // --- Application Menu (UI Milestone 1B) ---
  // Every entry below is an existing production entry point. The menu adds no new
  // project lifecycle, persistence or audio behaviour — it only makes the current
  // capabilities reachable from a desktop-style menu bar.
  const bpmInputRef = useRef<HTMLInputElement | null>(null);
  const manifestInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Opens a project manifest (.flmp/.json). This is the single importer: the
   * Project Hub button and File → Open Project Manifest both reach it, and it
   * funnels into the same handleLoadProjectState replacement path as every other
   * project load.
   */
  const handleManifestImport = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const normalized = normalizeProjectState(parsed);
      const replaced = await handleLoadProjectState(normalized, { source: 'manifest-import' });
      if (replaced !== false) setIsProjectManagerOpen(false);
    } catch (error) {
      console.error('Could not load project file.', error);
      window.alert(error instanceof Error ? error.message : 'Could not load project file.');
    } finally {
      event.target.value = '';
    }
  }, [handleLoadProjectState]);

  const menuCommandDeps: ApplicationMenuCommandDeps = {
    newSession: () => {
      // Shared with the Project Hub "New Session" tile: one blank document and one
      // replacement source, so both entry points run the identical lifecycle.
      const request = createNewSessionRequest();
      void handleLoadProjectState(request.state, request.options);
    },
    openProjectManifest: () => manifestInputRef.current?.click(),
    save: () => performSave(projectStateRef.current, { reconcileAudio: true }),
    exportAudio: () => setIsExportOpen(true),
    exportProjectBundle: () => setIsProjectZipOpen(true),
    exportProjectManifest: () => setIsProjectManagerOpen(true),

    undo: handleUndo,
    redo: handleRedo,

    selectView: view => setCurrentView(view),
    toggleBrowser: () => setIsSidebarOpen(open => !open),
    toggleFullscreen: () => {
      void fullscreenController.toggle();
    },

    openProjectHub: () => setIsProjectManagerOpen(true),
    openProjectStatistics: () => setIsAnalyticsOpen(true),
    editTempo: () => {
      const input = bpmInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    },

    showInstrumentBrowser: () => setIsSidebarOpen(true),
    addPlaylistTrack: handleAddPlaylistTrack,
    toggleSelectedChannelMute: () => {
      const channel = projectStateRef.current.channels.find(candidate => candidate.id === selectedChannelId);
      if (channel) handleUpdateChannel(channel.id, { mute: !channel.mute });
    },
    toggleSelectedChannelSolo: () => {
      const channel = projectStateRef.current.channels.find(candidate => candidate.id === selectedChannelId);
      if (channel) handleUpdateChannel(channel.id, { solo: !channel.solo });
    },
    deleteSelectedChannel: () => handleDeleteChannel(selectedChannelId),

    toggleMetronome: () => setMetronome(value => !value),
    toggleRecord: handleToggleRecord,

    openMidiDevices: () => setIsMidiModalOpen(true),
    openMidiLearn: () => setIsMidiLearnOpen(true),
    openKeyboardShortcuts: () => setIsHotkeysOpen(true),

    // projectHistoryVersion is read so the menu re-renders with fresh history
    // state exactly like the existing Playlist undo/redo wiring does.
    canUndo: () => projectHistoryVersion >= 0 && projectHistoryRef.current.canUndo,
    canRedo: () => projectHistoryVersion >= 0 && projectHistoryRef.current.canRedo,
    hasSelectedChannel: () => projectState.channels.some(channel => channel.id === selectedChannelId),
    canDeleteSelectedChannel: () => projectState.channels.length > 1,
    currentView: () => currentView,
    isBrowserOpen: () => isSidebarOpen,
    isFullscreen: () => fullscreenController.isFullscreen(),
    isMetronomeOn: () => metronome,
    isRecording: () => isRecording,
  };

  const menuCommandState = createApplicationMenuCommandState(menuCommandDeps);

  const menuCommandDepsRef = useRef(menuCommandDeps);
  useEffect(() => {
    menuCommandDepsRef.current = menuCommandDeps;
  });

  const handleMenuCommand = useCallback((id: ApplicationMenuCommandId) => {
    runApplicationMenuCommand(id, menuCommandDepsRef.current);
  }, []);

  // Keeps the global keydown subscription stable while always dispatching to the
  // freshest menu dependencies.
  const runApplicationMenuCommandRef = useRef(handleMenuCommand);
  useEffect(() => {
    runApplicationMenuCommandRef.current = handleMenuCommand;
  }, [handleMenuCommand]);

  const [keyboardOctave, setKeyboardOctave] = useState<number>(0);
  const activeHeldKeysRef = useRef<Set<string>>(new Set());

  // --- Keyboard Shortcuts & Global Hotkeys ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      // UI Milestone 1C Step 4 — while any modal owns the interaction, the
      // shell shortcuts stay inert (Escape itself is handled by the dialog).
      if (hasOpenModalDialog(typeof document === 'undefined' ? undefined : document)) {
        return;
      }

      // Modifier shortcuts take precedence over virtual piano keyboard triggers.
      const shortcut = resolveUndoRedoShortcut(e);
      const isModifier = Boolean(e.ctrlKey || e.metaKey);
      // UI Milestone 1B application-shell accelerators. The resolver requires
      // Ctrl/Cmd and rejects Shift/Alt, while note entry is only reachable without
      // a modifier, so these can never take a key away from the virtual piano.
      const applicationShortcut = resolveApplicationMenuShortcut(e);
      if (audioEngine.isOfflineRenderLeaseHeld()) {
        const isOfflineRenderMutationKey = shortcut.action !== 'none' ||
          applicationShortcut !== null ||
          (!isModifier && (e.code === 'Space' || e.code === 'KeyL' || e.code === 'KeyR' || e.code === 'KeyM')) ||
          e.code === 'Numpad0' || e.code === 'Home' ||
          (!isModifier && e.key === '0') ||
          (!isModifier && KEY_NOTE_MAP[e.code] !== undefined);
        if (isOfflineRenderMutationKey) {
          e.preventDefault();
          return;
        }
      }

      if (applicationShortcut) {
        e.preventDefault();
        runApplicationMenuCommandRef.current(applicationShortcut);
        return;
      }

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

      const notePitch = isModifier ? null : getKeyboardNotePitch(e.code, keyboardOctave);
      if (notePitch !== null && !activeHeldKeysRef.current.has(e.code) && !e.repeat) {
        activeHeldKeysRef.current.add(e.code);
        const pitch = notePitch;

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

  /**
   * Phase 54: resolved once here and passed to both the arranger and the export
   * modal, so clip bounds and the render window can never disagree about how
   * long the arrangement is.
   */
  const projectTimelineBars = getProjectTimelineBars(projectState);

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
      {/* 0. Application Menu (UI Milestone 1B).
          Rendered as a SIBLING ABOVE the transport on purpose: src/uiAudit.css
          positions the transport with `#fl-transport-bar > div:first-child >
          div:nth-child(4)`, so the transport must keep its current parent and
          child order. Nesting the menu inside the header would silently
          re-target those overrides and move the workspace. */}
      <ApplicationMenuBar commandState={menuCommandState} onRunCommand={handleMenuCommand} />

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
        onOpenTakeComping={() => setIsTakeCompingOpen(true)}
        onOpenSidechain={() => setIsSidechainOpen(true)}
        onOpenPolyphonicEditor={() => setIsPolyphonicEditorOpen(true)}
        onOpenDesktopApp={() => setIsDesktopAppOpen(true)}
        onOpenWarpProcessor={() => setIsWarpProcessorOpen(true)}
        onOpenMasterMacros={() => setIsMasterMacrosOpen(true)}
        onOpenProjectZipBundle={() => setIsProjectZipOpen(true)}
        collaboratorCount={collaborators.length}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        saveError={saveError}
        bpmInputRef={bpmInputRef}
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
          <StudioBrowser
            search={browserSearch}
            onSearchChange={setBrowserSearch}
            expandedFolders={expandedFolders}
            onToggleFolder={(folderId) => setExpandedFolders(f => ({ ...f, [folderId]: !f[folderId] }))}
            previewingAudio={previewingAudio}
            onOpenProjectManager={() => setIsProjectManagerOpen(true)}
            onAddInstrument={(instrument) => handleAddChannel(instrument.type, instrument.name, instrument.color)}
            onAuditionSample={handleAuditionSample}
            onLoadPresetProject={(preset) => void handleLoadProjectState(preset.state, { source: 'studio-demo' })}
          />
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
              totalBars={projectTimelineBars}
              onUpdateTotalBars={handleUpdateTotalBars}
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
              onSelectedClipIdChange={setSelectedPlaylistClipId}
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
              sampleLibrary={projectState.sampleLibrary || []}
            />
          )}

          {currentView === 'sampler' && (
            <div className="flex flex-col h-full overflow-y-auto p-4 bg-[#121214] items-center gap-4">
              <div className="w-full max-w-4xl flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold text-white">APEX SAMPLE WORKSTATION</h2>
                  <p className="text-[10px] text-[#777]">Import, inspect, slice and map real audio into the drum sampler.</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setIsAudioRecorderOpen(true)} className="px-3 py-2 bg-[#ff6e00] text-black font-bold text-xs rounded">RECORD</button>
                  <button onClick={() => setIsSampleManagerOpen(true)} className="px-3 py-2 bg-[#00ff88] text-black font-bold text-xs rounded">SAMPLE LIBRARY</button>
                  <button onClick={() => setCurrentView('instruments')} className="px-3 py-2 bg-[#222225] text-white font-bold text-xs rounded border border-[#333336]">INSTRUMENTS</button>
                </div>
              </div>
              {selectedChannel && (
                <>
                  <SampleLibraryPanel
                    samples={projectState.sampleLibrary || []}
                    packs={projectState.samplePacks || []}
                    selectedChannel={selectedChannel}
                    onUpdateSample={(sample) => mutateProjectState(
                      current => ({
                        ...current,
                        sampleLibrary: (current.sampleLibrary || []).map(item => item.id === sample.id ? sample : item)
                      }),
                      'Update sample library metadata'
                    )}
                    onUpdatePacks={(samplePacks) => mutateProjectState(
                      current => ({ ...current, samplePacks }),
                      'Update sample packs'
                    )}
                    onUpdateChannel={handleUpdateChannel}
                  />
                  <SampleSlicerPanel channel={selectedChannel} sampleLibrary={projectState.sampleLibrary || []} onUpdateChannel={handleUpdateChannel} />
                </>
              )}
            </div>
          )}
        </section>
      </main>

      <StatusBar
        meta={projectState.meta}
        currentView={currentView}
        saveError={saveError}
        channelCount={projectState.channels.length}
        clipCount={projectState.playlistClips.length}
      />

      <ExportModal isOpen={isExportOpen} onClose={() => setIsExportOpen(false)} channels={projectState.channels} clips={projectState.playlistClips} mixerTracks={projectState.mixerTracks} meta={projectState.meta} patternLengthSteps={selectedPatternLengthSteps} playlistTracks={projectState.playlistTracks} includeMixerFx={DEFAULT_INCLUDE_MIXER_FX} totalBars={projectTimelineBars} />
      {/* The single manifest importer, shared by File → Open Project Manifest and the Project Hub. */}
      <input
        id="project-manifest-input"
        type="file"
        ref={manifestInputRef}
        onChange={handleManifestImport}
        accept=".json,.flmp"
        className="hidden"
      />
      <ProjectManagerModal isOpen={isProjectManagerOpen} onClose={() => setIsProjectManagerOpen(false)} currentState={projectState} onLoadProject={handleLoadProjectState} onUpdateMeta={handleUpdateMeta} onRequestManifestImport={() => manifestInputRef.current?.click()} />
      <CollaborationModal isOpen={isCollabOpen} onClose={() => setIsCollabOpen(false)} comments={comments} collaborators={collaborators} onAddComment={(text, bar) => { const newC: CollabComment = { id: `c-${Date.now()}`, author: 'Alex (You)', avatarColor: '#ff6e00', timestamp: Date.now(), barPosition: bar, text, resolved: false }; setComments(prev => [newC, ...prev]); }} onToggleResolveComment={(id) => setComments(prev => prev.map(c => c.id === id ? { ...c, resolved: !c.resolved } : c))} />
      <AnalyticsModal isOpen={isAnalyticsOpen} onClose={() => setIsAnalyticsOpen(false)} meta={projectState.meta} channels={projectState.channels} clips={projectState.playlistClips} />
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
      <SampleManagerModal isOpen={isSampleManagerOpen} onClose={() => setIsSampleManagerOpen(false)} channels={projectState.channels} sampleLibrary={projectState.sampleLibrary || []} selectedChannel={projectState.channels.find(c => c.id === sampleChannelId) || projectState.channels[0]} onSampleImported={(sample) => { mutateProjectState(current => ({ ...current, sampleLibrary: [...(current.sampleLibrary || []).filter(existing => existing.id !== sample.id), sample] }), 'Import sample into library'); }} onAssignSampleToChannel={(chId, sampleData) => { handleUpdateChannel(chId, { customSample: sampleData }); }} onCreateChannelFromSample={(sampleData) => { const channel = { id: `ch-sample-${Date.now()}`, name: sampleData.name || 'Sample Pad', instrumentType: 'sampler' as const, volume: 0.85, pan: 0, pitch: 0, mute: false, solo: false, color: '#00ff88', steps: Array(16).fill(false), notes: [], synthParams: { ...DEFAULT_PROJECT.channels[0].synthParams }, customSample: sampleData } satisfies Omit<Channel, 'mixerTrackId'>; mutateProjectState(current => appendChannelWithAllocatedMixerTrackId(current, channel), 'Create channel from sample'); setSelectedChannelId(channel.id); }} />
      <AudioRecorderModal
        isOpen={isAudioRecorderOpen}
        projectGeneration={recordingProjectGenerationRef.current}
        getCurrentProjectGeneration={() => recordingProjectGenerationRef.current}
        onRegisterProjectReplacementHandler={handler => { cancelRecordingForReplacementRef.current = handler; }}
        onClose={() => { setIsAudioRecorderOpen(false); setIsRecording(false); }}
        onSaveRecording={handleSaveRecordingToPlaylist}
      />
      <VocalTunerModal isOpen={isVocalTunerOpen} onClose={() => setIsVocalTunerOpen(false)} vocalTunerSettings={projectState.vocalTuner || { enabled: true, rootKey: 0, scale: 'minor', retuneSpeedMs: 15, formantShift: 0, vibratoDepth: 0.2, humanize: 0.3 }} onUpdateVocalTuner={(settings) => mutateProjectState(curr => updateVocalTunerInProjectState(curr, settings), 'Update vocal tuner')} channels={projectState.channels} />
      <MidiLearnModal isOpen={isMidiLearnOpen} onClose={() => setIsMidiLearnOpen(false)} midiMappings={projectState.midiMappings || []} onUpdateMidiMappings={(mappings) => mutateProjectState(curr => updateMidiMappingsInProjectState(curr, mappings), 'Update MIDI mappings')} channels={projectState.channels} mixerTracks={projectState.mixerTracks} connectedDevices={projectState.connectedMidiDevices || []} isMidiLearnActive={isMidiLearnActive} onToggleMidiLearn={(active) => setIsMidiLearnActive(active)} />
      <MultiZoneSamplerModal isOpen={isMultiZoneSamplerOpen} onClose={() => setIsMultiZoneSamplerOpen(false)} channels={projectState.channels} sampleLibrary={projectState.sampleLibrary || []} onUpdateChannel={handleUpdateChannel} />
      <WavetableSynthModal isOpen={isWavetableSynthOpen} onClose={() => setIsWavetableSynthOpen(false)} channels={projectState.channels} onUpdateChannel={handleUpdateChannel} />
      <TakeCompingModal isOpen={isTakeCompingOpen} onClose={() => setIsTakeCompingOpen(false)} onPromoteCompToPlaylist={handlePromoteCompToPlaylist} />
      <SidechainRoutingModal isOpen={isSidechainOpen} onClose={() => setIsSidechainOpen(false)} mixerTracks={projectState.mixerTracks} onUpdateMixerTracks={(tracks) => mutateProjectState(curr => ({ ...curr, mixerTracks: tracks }), 'Update mixer routing')} />
      <PolyphonicEditorModal isOpen={isPolyphonicEditorOpen} onClose={() => setIsPolyphonicEditorOpen(false)} />
      <DesktopAppModal isOpen={isDesktopAppOpen} onClose={() => setIsDesktopAppOpen(false)} />
      <WarpAudioProcessorModal isOpen={isWarpProcessorOpen} onClose={() => setIsWarpProcessorOpen(false)} clips={projectState.playlistClips} selectedClipId={selectedPlaylistClipId} onUpdateClip={(updatedClip) => { const nextState = { ...projectStateRef.current, playlistClips: projectStateRef.current.playlistClips.map(c => c.id === updatedClip.id ? updatedClip : c) }; updatePlaylistProjectState(nextState); commitPlaylistHistory(nextState, 'Warp audio clip'); }} />
      <MasterMacroRackModal isOpen={isMasterMacrosOpen} onClose={() => setIsMasterMacrosOpen(false)} mixerTracks={projectState.mixerTracks} channels={projectState.channels} macroKnobs={projectState.macroKnobs} onUpdateMacros={(macros) => mutateProjectState(curr => updateMacroRackInProjectState(curr, macros), 'Update macro controls', { isContinuous: true })} />
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
