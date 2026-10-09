import { beatsPerBar, beatsToSeconds, resolveProjectTimeSignature, SIXTEENTH_STEPS_PER_BEAT } from '../music/musicalTime';
import { describePulseLayout, resolveMeterPulseLayout, resolveSevenEightGrouping } from '../music/meterPulse';
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  Cpu,
  Download,
  Keyboard,
  LayoutGrid,
  ListMusic,
  Maximize2,
  Menu,
  Minimize2,
  Pause,
  Piano,
  Play,
  Radio,
  SlidersHorizontal,
  Square,
  type LucideIcon,
} from 'lucide-react';
import { ViewMode, PlayMode, ProjectMetadata } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { fullscreenController } from '../state/fullscreen';
import { TransportToolsMenu, createTransportToolGroups } from './TransportToolsMenu';

export interface TransportBarProps {
  currentView: ViewMode;
  onSelectView: (view: ViewMode) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
  isRecording: boolean;
  onToggleRecord: () => void;
  meta: ProjectMetadata;
  onUpdateMeta: (meta: Partial<ProjectMetadata>) => void;
  currentStep: number;
  currentBar: number;
  metronome: boolean;
  onToggleMetronome: () => void;
  onOpenExport: () => void;
  onOpenProjectManager: () => void;
  onOpenCollab: () => void;
  onOpenAnalytics: () => void;
  onOpenHotkeys: () => void;
  onOpenMidi: () => void;
  onOpenParametricEq?: () => void;
  onOpenMasteringSuite?: () => void;
  onOpenSampleManager?: () => void;
  onOpenGrossBeat?: () => void;
  onOpenSlicer?: () => void;
  onOpenVocalTuner?: () => void;
  onOpenMidiLearn?: () => void;
  onOpenMultiZoneSampler?: () => void;
  onOpenWavetableSynth?: () => void;
  onOpenTakeComping?: () => void;
  onOpenSidechain?: () => void;
  onOpenPolyphonicEditor?: () => void;
  onOpenDesktopApp?: () => void;
  onOpenWarpProcessor?: () => void;
  onOpenMasterMacros?: () => void;
  onOpenProjectZipBundle?: () => void;
  saveError?: string | null;
  collaboratorCount: number;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  /**
   * UI Milestone 1B: lets the application menu focus the existing tempo field
   * (Project → Edit Tempo) instead of introducing a second BPM control.
   * UI 1C: it stays the only tempo control in the shell.
   */
  bpmInputRef?: React.Ref<HTMLInputElement>;
  /** Phase 1J: the Meter readout opens Project Settings (time signature). */
  onOpenProjectSettings?: () => void;
}

export interface WorkspaceTab {
  readonly id: string;
  readonly view: ViewMode;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * UI Milestone 1C — the workspace navigation layer.
 *
 * The six views are declared once, in DOM order, so the ribbon can never drift
 * into six differently styled buttons again. The ids are a public contract used
 * by the shell tests and by the workspace keyboard shortcuts in App.
 */
export const WORKSPACE_TABS: readonly WorkspaceTab[] = [
  { id: 'nav-channel-rack', view: 'channel_rack', label: 'Channel Rack', icon: LayoutGrid },
  { id: 'nav-piano-roll', view: 'piano_roll', label: 'Piano Roll', icon: Piano },
  { id: 'nav-playlist', view: 'playlist', label: 'Playlist', icon: ListMusic },
  { id: 'nav-mixer', view: 'mixer', label: 'Mixer', icon: SlidersHorizontal },
  { id: 'nav-instruments', view: 'instruments', label: 'Instruments', icon: Cpu },
  { id: 'nav-sampler', view: 'sampler', label: 'Recorder', icon: AudioLines },
];

/** The single path from a ribbon tab to the view the shell renders. */
export const selectWorkspaceTab = (
  tab: WorkspaceTab,
  onSelectView: (view: ViewMode) => void
): void => {
  onSelectView(tab.view);
};

interface WorkspaceTabButtonProps {
  id: string;
  currentView: ViewMode;
  onSelectView: (view: ViewMode) => void;
}

/**
 * One ribbon tab. All six are rendered through this component so the geometry,
 * the focus treatment and the selected state can never drift between views.
 */
const WorkspaceTabButton: React.FC<WorkspaceTabButtonProps> = ({ id, currentView, onSelectView }) => {
  const tab = WORKSPACE_TABS.find(candidate => candidate.id === id);
  if (!tab) return null;
  const Icon = tab.icon;
  const isActive = currentView === tab.view;

  return (
    <button
      id={id}
      type="button"
      aria-current={isActive ? 'page' : undefined}
      aria-label={tab.label}
      title={tab.label}
      onClick={() => selectWorkspaceTab(tab, onSelectView)}
      className="apex-tab"
    >
      <Icon className="apex-tab-icon" aria-hidden="true" />
      <span className="apex-tab-label">{tab.label}</span>
    </button>
  );
};

/**
 * The Apex Studio transport header: brand and project identity, the transport
 * readout, the playback controls, the workspace ribbon, and a small always-visible
 * tool set with the remaining tools behind one deliberate overflow menu.
 *
 * Layout contract (see src/state/applicationShellLayout.test.ts and
 * src/uiAudit.css): the top row has exactly four direct children in this order,
 * because the positional CSS indexes `div:nth-child(4)`. The tool cluster is
 * ordered core-controls-first so that the pinned `overflow-hidden` on the row can
 * only ever clip the trailing, menu-backed status chips.
 */
export const TransportBar: React.FC<TransportBarProps> = ({
  currentView,
  onSelectView,
  isPlaying,
  onTogglePlay,
  onStop,
  playMode,
  onTogglePlayMode,
  isRecording,
  onToggleRecord,
  meta,
  onUpdateMeta,
  currentStep,
  currentBar,
  metronome,
  onToggleMetronome,
  onOpenExport,
  onOpenProjectManager,
  onOpenCollab,
  onOpenHotkeys,
  onOpenMidi,
  onOpenParametricEq,
  onOpenMasteringSuite,
  onOpenSampleManager,
  onOpenGrossBeat,
  onOpenSlicer,
  onOpenVocalTuner,
  onOpenMidiLearn,
  onOpenMultiZoneSampler,
  onOpenWavetableSynth,
  onOpenTakeComping,
  onOpenSidechain,
  onOpenDesktopApp,
  onOpenWarpProcessor,
  onOpenMasterMacros,
  onOpenProjectZipBundle,
  saveError,
  collaboratorCount,
  isSidebarOpen,
  onToggleSidebar,
  bpmInputRef,
  onOpenProjectSettings
}) => {
  const [tapTimes, setTapTimes] = useState<number[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [midiActiveBlink, setMidiActiveBlink] = useState(false);

  useEffect(() => {
    const handleMidi = (e: any) => {
      if (e.type === 'noteOn' || e.type === 'cc') {
        setMidiActiveBlink(true);
        setTimeout(() => setMidiActiveBlink(false), 120);
      }
    };
    audioEngine.addMidiListener(handleMidi);
    return () => audioEngine.removeMidiListener(handleMidi);
  }, []);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(fullscreenController.isFullscreen());
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // The shared controller is the single implementation, used by both this button
  // and View → Fullscreen in the application menu.
  const handleToggleFullscreen = async () => {
    setIsFullscreen(await fullscreenController.toggle());
  };

  const handleTapTempo = () => {
    const now = performance.now();
    const newTimes = [...tapTimes.slice(-3), now];
    setTapTimes(newTimes);

    if (newTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < newTimes.length; i++) {
        intervals.push(newTimes[i] - newTimes[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avgInterval);
      if (bpm >= 40 && bpm <= 260) {
        onUpdateMeta({ bpm });
      }
    }
  };

  const toolGroups = useMemo(
    () =>
      createTransportToolGroups({
        samples: onOpenSampleManager,
        wavetable: onOpenWavetableSynth,
        keymap: onOpenMultiZoneSampler,
        vocalTuner: onOpenVocalTuner,
        timeFx: onOpenGrossBeat,
        warp: onOpenWarpProcessor,
        slicer: onOpenSlicer,
        comping: onOpenTakeComping,
        eq: onOpenParametricEq,
        mastering: onOpenMasteringSuite,
        sidechain: onOpenSidechain,
        macros: onOpenMasterMacros,
        midiLearn: onOpenMidiLearn,
        projectBundle: onOpenProjectZipBundle,
        desktopApp: onOpenDesktopApp,
        collab: onOpenCollab,
      }),
    [
      onOpenSampleManager,
      onOpenWavetableSynth,
      onOpenMultiZoneSampler,
      onOpenVocalTuner,
      onOpenGrossBeat,
      onOpenWarpProcessor,
      onOpenSlicer,
      onOpenTakeComping,
      onOpenParametricEq,
      onOpenMasteringSuite,
      onOpenSidechain,
      onOpenMasterMacros,
      onOpenMidiLearn,
      onOpenProjectZipBundle,
      onOpenDesktopApp,
      onOpenCollab,
    ]
  );

  // Phase 1F/1I: keep the existing quarter-note beat display for 4/4, 3/4.
  // Phase 1K: the displayed beat is the METRONOME PULSE of the active meter,
  // so the readout and the click agree beat-for-beat — quarter pulses (1..4 /
  // 1..3) in 4/4 and 3/4 with their historical 4-way subdivision, eighth
  // pulses in 6/8 (1..6) and 7/8 (1..7) with two sixteenth subdivisions.
  // Wrapping the beat index prevents a longer absolute pattern loop from
  // showing a phantom pulse after the bar. In 6/8 and 7/8 a beat-group strip
  // additionally shows the dotted-quarter / selected grouping (3+3, 2+2+3,
  // 3+2+2, 2+3+2) with the active group highlighted — presentation only; no
  // stored note or clip position depends on how the display is grouped.
  const resolvedMeter = resolveProjectTimeSignature(meta);
  const meterBeatsPerBar = beatsPerBar(resolvedMeter);
  const pulseGrouping = resolveSevenEightGrouping(meta);
  const pulseLayout = resolveMeterPulseLayout(resolvedMeter, pulseGrouping);
  const stepsPerDisplayedBeat = pulseLayout.stepsPerPulse;
  const displayedBeatsPerBar = pulseLayout.pulses.length;
  const formattedBeat = (Math.floor(currentStep / stepsPerDisplayedBeat) % displayedBeatsPerBar) + 1;
  const formatted16th = (currentStep % stepsPerDisplayedBeat) + 1;
  const currentPulseIndex = Math.floor(currentStep / stepsPerDisplayedBeat) % displayedBeatsPerBar;
  const beatGroupOfPulse = (pulseIndex: number): number => {
    let pulseCursor = 0;
    for (let groupIndex = 0; groupIndex < pulseLayout.groups.length; groupIndex++) {
      pulseCursor += pulseLayout.groups[groupIndex];
      if (pulseIndex < pulseCursor) return groupIndex;
    }
    return 0;
  };
  const activeGroupIndex = beatGroupOfPulse(currentPulseIndex);
  const showBeatGroups = pulseLayout.groups.length > 1;

  // Calculate song time string (e.g. 03:24:12)
  // Phase 1H: the Time cell is the wall-clock position of the displayed
  // bar.beat.step — (bar - 1) bars plus the step's beat offset, converted
  // through the resolved meter and the project tempo. The previous formula
  // divided the beat position by 4 (the readout ran at 1/4 of real time),
  // read the 16th-note subdivision as the beat, assumed a fixed 4-beat bar,
  // and showed a BPM-independent tick count in the centisecond field.
  const positionBeats =
    (currentBar - 1) * meterBeatsPerBar + currentStep / SIXTEENTH_STEPS_PER_BEAT;
  const positionCentiseconds = Math.floor(positionBeats * beatsToSeconds(1, meta.bpm) * 100 + 1e-9);
  const totalSeconds = Math.floor(positionCentiseconds / 100);
  const songTimeStr = `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}:${String(positionCentiseconds % 100).padStart(2, '0')}`;
  const barPosition = `${String(currentBar).padStart(2, '0')}.${formattedBeat}.${formatted16th}`;

  return (
    <header id="fl-transport-bar" className="apex-transport select-none shrink-0">
      {/* Top Navbar — four direct children, in the order src/uiAudit.css indexes. */}
      <div className="h-12 flex items-center justify-between px-2 sm:px-3 md:px-4 gap-2 md:gap-4 overflow-hidden">
        {/* 1. Brand, project identity and save state */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 min-w-0">
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Toggle Studio Browser"
            aria-pressed={isSidebarOpen}
            title="Toggle Studio Browser"
            className="apex-icon-btn apex-sidebar-toggle"
          >
            <Menu className="apex-icon" aria-hidden="true" />
          </button>

          <button
            type="button"
            id="fl-logo-btn"
            onClick={onOpenProjectManager}
            aria-label="Apex Studio — open the project hub"
            title="Project Hub & Presets"
            className="apex-brand"
          >
            <i className="apex-brand-mark" aria-hidden="true" />
            <span className="apex-brand-wordmark" aria-hidden="true" />
          </button>

          <span className="apex-shell-divider" aria-hidden="true" />

          <button
            type="button"
            id="project-name-btn"
            onClick={onOpenProjectManager}
            aria-label={`Project: ${meta.name}. Open the project hub.`}
            title="Click to rename or change project"
            className="apex-project-name"
          >
            <span className="apex-project-name-text">{meta.name}</span>
          </button>

          {saveError && (
            <span
              id="transport-save-error-indicator"
              className="apex-badge-danger"
              title={`Save failed: ${saveError}`}
            >
              <AlertTriangle className="apex-badge-icon" aria-hidden="true" />
              <span className="apex-badge-text">Save failed</span>
            </span>
          )}
        </div>

        {/* 2. Transport readout: tempo, song time and bar position */}
        <div className="apex-readout shrink-0">
          <div className="apex-readout-cell">
            <span className="apex-readout-label">BPM</span>
            <span className="apex-readout-field">
              <input
                id="fl-bpm-input"
                ref={bpmInputRef}
                type="number"
                min="40"
                max="260"
                value={meta.bpm}
                onChange={(e) => onUpdateMeta({ bpm: Number(e.target.value) || 120 })}
                aria-label="Project tempo in beats per minute"
                className="apex-readout-input"
              />
              <button
                type="button"
                onClick={handleTapTempo}
                className="apex-tap"
                title="Tap tempo"
                aria-label="Tap tempo"
              >
                TAP
              </button>
            </span>
          </div>

          <span className="apex-readout-divider" aria-hidden="true" />

          {/* Phase 1J: the active (resolved) time signature, always visible. */}
          <div className="apex-readout-cell">
            <span className="apex-readout-label">Meter</span>
            <button
              type="button"
              id="fl-meter-readout"
              onClick={onOpenProjectSettings}
              disabled={!onOpenProjectSettings}
              data-meter={`${resolvedMeter[0]}/${resolvedMeter[1]}`}
              aria-label={`Time signature ${resolvedMeter[0]}/${resolvedMeter[1]}. Open Project Settings.`}
              title="Time signature — open Project Settings"
              className="apex-readout-value cursor-pointer hover:text-[var(--apex-accent)]"
            >
              {`${resolvedMeter[0]}/${resolvedMeter[1]}`}
            </button>
          </div>

          <span className="apex-readout-divider" aria-hidden="true" />

          <div className="apex-readout-cell">
            <span className="apex-readout-label">Time</span>
            <span className="apex-readout-value" title="Song time">
              {songTimeStr}
            </span>
          </div>

          <span className="apex-readout-divider apex-readout-divider--wide" aria-hidden="true" />

          <div className="apex-readout-cell apex-readout-cell--position">
            <span className="apex-readout-label">Bar</span>
            <span className="apex-readout-value" title="Bar . beat . step">
              {barPosition}
            </span>
            {/* Phase 1K: beat-group strip for compound/irregular meters. The
                pills show the metronome's grouping (6/8 → two dotted-quarter
                groups of 3 eighths; 7/8 → the selected 2+2+3 / 3+2+2 / 2+3+2)
                with the group the playhead is in highlighted. 4/4 and 3/4 are
                unchanged — their quarter beats already are the grouping. */}
            {showBeatGroups && (
              <span
                className="flex items-center gap-0.5 ml-1"
                data-testid="transport-beat-groups"
                data-grouping={pulseLayout.groups.join('+')}
                data-active-group={activeGroupIndex}
                title={describePulseLayout(pulseLayout)}
                aria-label={`Beat groups ${pulseLayout.groups.join('+')}, group ${activeGroupIndex + 1} of ${pulseLayout.groups.length}`}
              >
                {pulseLayout.groups.map((size, index) => (
                  <span
                    key={index}
                    data-group-index={index}
                    data-group-size={size}
                    className={`px-1 rounded-sm font-mono text-[length:var(--apex-type-micro)] leading-4 border ${
                      index === activeGroupIndex
                        ? 'border-[var(--apex-accent)] text-[var(--apex-accent)] font-semibold bg-[var(--apex-state-selected)]'
                        : 'border-[var(--apex-border)] text-[var(--apex-text-3)]'
                    }`}
                  >
                    {size}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>

        {/* 3. Playback controls — the visual centre of the transport */}
        <div className="apex-transport-cluster flex items-center gap-1.5 md:gap-2 shrink-0">
          <button
            type="button"
            id="fl-playmode-toggle"
            role="switch"
            aria-checked={playMode === 'pat'}
            aria-label="Pattern mode"
            onClick={onTogglePlayMode}
            title="Pattern mode ⇄ Song mode (L)"
            data-mode={playMode}
            className="apex-mode-switch"
          >
            <span className="apex-mode-option" aria-hidden="true">PAT</span>
            <span className="apex-mode-option" aria-hidden="true">SONG</span>
          </button>

          <button
            type="button"
            id="fl-play-btn"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title="Play / Pause (Space)"
            data-playing={isPlaying}
            className="apex-transport-btn apex-transport-btn--play"
          >
            {isPlaying ? (
              <Pause className="apex-transport-icon" aria-hidden="true" />
            ) : (
              <Play className="apex-transport-icon" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            id="fl-stop-btn"
            onClick={onStop}
            aria-label="Stop"
            title="Stop (Home)"
            className="apex-transport-btn"
          >
            <Square className="apex-transport-icon" aria-hidden="true" />
          </button>

          <button
            type="button"
            id="fl-record-btn"
            onClick={onToggleRecord}
            aria-pressed={isRecording}
            aria-label={isRecording ? 'Stop recording' : 'Arm recording'}
            title="Arm / Disarm Recording (R)"
            className="apex-transport-btn apex-transport-btn--record"
          >
            <span className="apex-record-dot" aria-hidden="true" />
            <span className="apex-transport-label">REC</span>
          </button>

          <button
            type="button"
            id="fl-metronome-btn"
            onClick={onToggleMetronome}
            aria-pressed={metronome}
            aria-label="Metronome click"
            title="Metronome Click (M)"
            className="apex-toggle"
          >
            <span className="apex-toggle-dot" aria-hidden="true" />
            <span className="apex-chip-label">Metro</span>
          </button>
        </div>

        {/* 4. Tool cluster: core actions first, status chips last.
               The core two are never hidden; the trailing chips are the only
               controls the pinned row overflow can ever clip, and each of them
               has an application-menu command as well. */}
        <div className="apex-tool-cluster flex items-center gap-1 md:gap-1.5 flex-1 min-w-0">
          <TransportToolsMenu groups={toolGroups} />

          <button
            type="button"
            id="fl-export-btn"
            onClick={onOpenExport}
            title="Render WAV, MIDI and stems"
            className="apex-primary-action"
          >
            <Download className="apex-chip-icon" aria-hidden="true" />
            <span className="apex-chip-label">Export</span>
          </button>

          <button
            type="button"
            id="fl-midi-hub-btn"
            onClick={onOpenMidi}
            aria-label="MIDI devices and controllers"
            title="Hardware MIDI activity — open the controller hub"
            className="apex-tool-chip apex-chip-xl"
          >
            <Radio className="apex-chip-icon" aria-hidden="true" />
            <span className="apex-chip-label">MIDI</span>
            <span className="apex-status-dot" data-active={midiActiveBlink} aria-hidden="true" />
          </button>

          <button
            type="button"
            id="fl-hotkeys-btn"
            onClick={onOpenHotkeys}
            aria-label="Keyboard shortcuts"
            title="Desktop DAW keyboard shortcuts"
            className="apex-icon-btn apex-chip-xl"
          >
            <Keyboard className="apex-icon" aria-hidden="true" />
          </button>

          <button
            type="button"
            id="fl-fullscreen-btn"
            onClick={handleToggleFullscreen}
            aria-pressed={isFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen Desktop Mode'}
            className="apex-icon-btn apex-chip-xl"
          >
            {isFullscreen ? (
              <Minimize2 className="apex-icon" aria-hidden="true" />
            ) : (
              <Maximize2 className="apex-icon" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Workspace navigation ribbon.
             The six ids stay literal in this file because
             src/state/applicationShellLayout.test.ts pins them here; the view,
             label and icon behind each id come from WORKSPACE_TABS, and
             transportShell.test.tsx keeps the two in sync. */}
      <nav id="fl-view-tabs" className="apex-ribbon" aria-label="Workspace views">
        <WorkspaceTabButton id="nav-channel-rack" currentView={currentView} onSelectView={onSelectView} />
        <WorkspaceTabButton id="nav-piano-roll" currentView={currentView} onSelectView={onSelectView} />
        <WorkspaceTabButton id="nav-playlist" currentView={currentView} onSelectView={onSelectView} />
        <WorkspaceTabButton id="nav-mixer" currentView={currentView} onSelectView={onSelectView} />
        <WorkspaceTabButton id="nav-instruments" currentView={currentView} onSelectView={onSelectView} />
        <WorkspaceTabButton id="nav-sampler" currentView={currentView} onSelectView={onSelectView} />
      </nav>
    </header>
  );
};

export default TransportBar;
