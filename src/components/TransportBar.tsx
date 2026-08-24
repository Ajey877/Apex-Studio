import React, { useState, useEffect } from 'react';
import { 
  Play, 
  Pause, 
  Square, 
  Circle, 
  Volume2, 
  Save, 
  Download, 
  ShieldCheck, 
  Users, 
  BarChart2, 
  Sliders, 
  Music, 
  Layers, 
  Mic, 
  Cpu, 
  Crown,
  Keyboard,
  Clock,
  Radio,
  Menu,
  Maximize2,
  Minimize2,
  Smartphone,
  Activity,
  Waves,
  Scissors,
  Monitor,
  Zap,
  Film,
  Headphones,
  Compass,
  Wand2,
  Sparkles,
  FolderArchive
} from 'lucide-react';
import { ViewMode, PlayMode, ProjectMetadata } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface TransportBarProps {
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
  onOpenSubscription: () => void;
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
  onOpenWamPlugin?: () => void;
  onOpenTakeComping?: () => void;
  onOpenSidechain?: () => void;
  onOpenPolyphonicEditor?: () => void;
  onOpenDesktopApp?: () => void;
  onOpenWarpProcessor?: () => void;
  onOpenVideoScoring?: () => void;
  onOpenSpatialAudio?: () => void;
  onOpenMpeExpression?: () => void;
  onOpenStemSplitter?: () => void;
  onOpenMasterMacros?: () => void;
  onOpenProjectZipBundle?: () => void;
  collaboratorCount: number;
  isProUser: boolean;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

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
  onOpenAnalytics,
  onOpenSubscription,
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
  onOpenWamPlugin,
  onOpenTakeComping,
  onOpenSidechain,
  onOpenPolyphonicEditor,
  onOpenDesktopApp,
  onOpenWarpProcessor,
  onOpenVideoScoring,
  onOpenSpatialAudio,
  onOpenMpeExpression,
  onOpenStemSplitter,
  onOpenMasterMacros,
  onOpenProjectZipBundle,
  collaboratorCount,
  isProUser,
  isSidebarOpen,
  onToggleSidebar
}) => {
  const [tapTimes, setTapTimes] = useState<number[]>([]);
  const [cpuUsage, setCpuUsage] = useState(12);
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
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const handleToggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
        if (screen.orientation && 'lock' in screen.orientation) {
          // @ts-ignore
          await screen.orientation.lock('landscape').catch(() => {});
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (e) {
      console.log('Fullscreen error', e);
    }
  };

  // Dynamic DSP simulation
  useEffect(() => {
    const interval = setInterval(() => {
      const base = isPlaying ? 22 : 8;
      setCpuUsage(Math.floor(base + Math.random() * 8));
    }, 2000);
    return () => clearInterval(interval);
  }, [isPlaying]);

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

  const formattedBeat = (currentStep % 4) + 1;
  const formatted16th = (currentStep % 4) + 1;

  // Calculate song time string (e.g. 03:24:12)
  const totalSeconds = Math.floor(((currentBar - 1) * 4 + (currentStep % 4)) * (60 / meta.bpm) / 4);
  const songTimeStr = `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}:${String((currentStep % 16) * 6).padStart(2, '0')}`;

  return (
    <header id="fl-transport-bar" className="bg-[#1e1e20] border-b border-[#333336] select-none text-[#b0b0b0] shrink-0">
      {/* Top Navbar */}
      <div className="h-12 flex items-center justify-between px-2 sm:px-3 md:px-4 gap-2 md:gap-4 overflow-hidden">
        {/* Brand & Project Info */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            onClick={onToggleSidebar}
            className="p-1.5 hover:bg-[#2d2d30] rounded text-[#777] hover:text-white transition"
            title="Toggle Studio Browser"
          >
            <Menu className="w-4 h-4" />
          </button>

          <button 
            id="fl-logo-btn"
            onClick={onOpenProjectManager}
            className="flex items-center gap-2 group transition"
            title="Project Menu & Presets"
          >
            <div className="w-7 h-7 bg-[#ff6e00] rounded-sm flex items-center justify-center shadow-sm">
              <div className="w-3.5 h-3.5 bg-[#0a0a0b] rounded-full group-hover:scale-110 transition-transform"></div>
            </div>
            <span className="text-white font-bold tracking-tight text-sm hidden sm:inline">APEX STUDIO PRO</span>
          </button>

          <button
            id="project-name-btn"
            onClick={onOpenProjectManager}
            className="text-xs font-semibold text-zinc-300 hover:text-white px-2 py-1 rounded bg-[#121214] border border-[#333336] max-w-[130px] md:max-w-[180px] truncate transition"
            title="Click to rename or change project"
          >
            <span className="truncate">{meta.name}</span>
          </button>
        </div>

        {/* BPM & Time LCD Pill */}
        <div className="flex items-center bg-[#121214] border border-[#333336] rounded px-2.5 py-1 gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold uppercase tracking-wider text-[#777]">BPM</span>
            <input
              id="fl-bpm-input"
              type="number"
              min="40"
              max="260"
              value={meta.bpm}
              onChange={(e) => onUpdateMeta({ bpm: Number(e.target.value) || 120 })}
              className="w-11 bg-transparent text-[#ff6e00] font-mono font-bold text-xs text-center focus:outline-none focus:bg-[#1a1a1d] rounded"
            />
            <button
              onClick={handleTapTempo}
              className="text-[8px] font-mono uppercase bg-[#222225] hover:bg-[#2d2d30] px-1 py-0.5 rounded text-[#b0b0b0]"
              title="Tap Tempo"
            >
              TAP
            </button>
          </div>

          <div className="w-px h-3 bg-[#333336]"></div>

          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold uppercase tracking-wider text-[#777]">TIME</span>
            <span className="text-[#ff6e00] font-mono text-xs font-bold">{songTimeStr}</span>
          </div>

          <div className="w-px h-3 bg-[#333336] hidden lg:block"></div>

          <div className="hidden lg:flex items-center gap-1 text-[10px] font-mono text-[#b0b0b0]">
            <span className="text-[#777]">BAR:</span>
            <span className="text-white font-bold">{String(currentBar).padStart(2, '0')}.{formattedBeat}.{formatted16th}</span>
          </div>
        </div>

        {/* Transport Playback Buttons */}
        <div className="flex items-center gap-1.5 md:gap-2">
          {/* Mode Switch (Pattern vs Song) */}
          <button
            id="fl-playmode-toggle"
            onClick={onTogglePlayMode}
            className={`px-2 py-1 text-[10px] font-bold rounded transition font-mono border ${
              playMode === 'pat' 
                ? 'bg-[#ff6e00] text-black border-[#ff6e00]' 
                : 'bg-[#222225] text-[#ff6e00] border-[#333336] hover:bg-[#2d2d30]'
            }`}
            title="Switch between Pattern Mode and Full Song Playlist Mode (L)"
          >
            {playMode.toUpperCase()}
          </button>

          {/* Play / Pause */}
          <button
            id="fl-play-btn"
            onClick={onTogglePlay}
            className={`p-2 rounded transition active:scale-95 ${
              isPlaying 
                ? 'bg-[#ff6e00] text-black hover:bg-[#ff7d1a]' 
                : 'hover:bg-[#333336] text-white bg-[#121214] border border-[#333336]'
            }`}
            title="Play / Pause (Space)"
          >
            {isPlaying ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" /></svg>
            )}
          </button>

          {/* Stop */}
          <button
            id="fl-stop-btn"
            onClick={onStop}
            className="p-2 hover:bg-[#333336] rounded text-[#777] hover:text-white transition active:scale-95 bg-[#121214] border border-[#333336]"
            title="Stop (Home)"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>

          {/* Record */}
          <button
            id="fl-record-btn"
            onClick={onToggleRecord}
            className={`p-2 rounded transition active:scale-95 ${
              isRecording 
                ? 'bg-[#ff0000] text-white animate-pulse' 
                : 'hover:bg-[#333336] text-[#777] hover:text-red-500 bg-[#121214] border border-[#333336]'
            }`}
            title="Arm / Disarm Recording (R)"
          >
            <div className="w-3 h-3 bg-white rounded-full"></div>
          </button>

          {/* Metronome */}
          <button
            id="fl-metronome-btn"
            onClick={onToggleMetronome}
            className={`px-2 py-1 rounded text-[10px] font-mono font-bold transition border ${
              metronome 
                ? 'bg-[#ff6e00]/20 text-[#ff6e00] border-[#ff6e00]' 
                : 'bg-[#121214] text-[#777] border-[#333336] hover:text-white'
            }`}
            title="Metronome Click (M)"
          >
            METRO
          </button>
        </div>

        {/* Right Status Badges & Action Buttons */}
        <div className="flex items-center gap-1.5 md:gap-2 overflow-x-auto no-scrollbar py-1 shrink">
          {/* Hardware MIDI Controller Status */}
          <button
            id="fl-midi-hub-btn"
            onClick={onOpenMidi}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs border transition font-mono ${
              midiActiveBlink
                ? 'bg-[#2ecc71] text-black border-[#2ecc71] font-bold shadow-[0_0_8px_rgba(46,204,113,0.8)]'
                : 'bg-[#121214] text-[#b0b0b0] hover:text-white border-[#333336] hover:bg-[#222225]'
            }`}
            title="Open Hardware MIDI & USB Controller Hub"
          >
            <Radio className={`w-3.5 h-3.5 ${midiActiveBlink ? 'text-black' : 'text-[#ff6e00]'}`} />
            <span className="text-[10px] font-bold hidden sm:inline">MIDI</span>
          </button>

          {/* Gross Beat Time FX Button */}
          {onOpenGrossBeat && (
            <button
              id="fl-gross-beat-btn"
              onClick={onOpenGrossBeat}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Open Gross Beat, Half-Time & Turntable Tape Stop"
            >
              <Waves className="w-3.5 h-3.5 text-[#ff6e00]" />
              <span className="text-[10px] font-bold hidden lg:inline">GROSS BEAT</span>
            </button>
          )}

          {/* Audio & Drum Slicer Button */}
          {onOpenSlicer && (
            <button
              id="fl-slicer-btn"
              onClick={onOpenSlicer}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Open Edison Transient Drum Slicer & Chopper"
            >
              <Scissors className="w-3.5 h-3.5 text-[#00bcd4]" />
              <span className="text-[10px] font-bold hidden lg:inline">SLICER</span>
            </button>
          )}

          {/* Vocal Tuner Auto-Pitch Button */}
          {onOpenVocalTuner && (
            <button
              id="fl-vocal-tuner-btn"
              onClick={onOpenVocalTuner}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Real-time Auto-Pitch & Vocal Tuner Pitch Correction (NewTone)"
            >
              <Mic className="w-3.5 h-3.5 text-[#00ff88]" />
              <span className="text-[10px] font-bold hidden xl:inline">AUTOTUNE</span>
            </button>
          )}

          {/* Wavetable Synth Button */}
          {onOpenWavetableSynth && (
            <button
              id="fl-wavetable-btn"
              onClick={onOpenWavetableSynth}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Serum / Vital 3D Wavetable Morphing Synthesizer"
            >
              <Waves className="w-3.5 h-3.5 text-[#00e5ff]" />
              <span className="text-[10px] font-bold hidden xl:inline">WAVETABLE</span>
            </button>
          )}

          {/* Multi-Zone Sampler Keymapper */}
          {onOpenMultiZoneSampler && (
            <button
              id="fl-multizone-btn"
              onClick={onOpenMultiZoneSampler}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="DirectWave Multi-Zone Keyboard Split & Velocity Keymapping"
            >
              <Layers className="w-3.5 h-3.5 text-[#ff6e00]" />
              <span className="text-[10px] font-bold hidden xl:inline">KEYMAP</span>
            </button>
          )}

          {/* Third-Party WAM / VST3 Host Rack */}
          {onOpenWamPlugin && (
            <button
              id="fl-wam-btn"
              onClick={onOpenWamPlugin}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Web Audio Modules (WAM2 / VST3) Third-Party Plugin Rack"
            >
              <Cpu className="w-3.5 h-3.5 text-[#a855f7]" />
              <span className="text-[10px] font-bold hidden xl:inline">WAM/VST3</span>
            </button>
          )}

          {/* Hardware MIDI Controller Learn */}
          {onOpenMidiLearn && (
            <button
              id="fl-midi-learn-btn"
              onClick={onOpenMidiLearn}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Hardware MIDI Controller Learn & CC Mapping"
            >
              <Sliders className="w-3.5 h-3.5 text-[#ffaa00]" />
              <span className="text-[10px] font-bold hidden xl:inline">MIDI LEARN</span>
            </button>
          )}

          {/* Take Comping Multi-Lane Studio */}
          {onOpenTakeComping && (
            <button
              id="fl-take-comp-btn"
              onClick={onOpenTakeComping}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Stacked Multi-Take Loop Recording & Swipe Comping"
            >
              <Scissors className="w-3.5 h-3.5 text-[#00e5ff]" />
              <span className="text-[10px] font-bold hidden xl:inline">COMPING</span>
            </button>
          )}

          {/* Sidechain Ducking Matrix */}
          {onOpenSidechain && (
            <button
              id="fl-sidechain-matrix-btn"
              onClick={onOpenSidechain}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Dynamic Sidechain Ducking & Modulation Matrix"
            >
              <Zap className="w-3.5 h-3.5 text-[#ffaa00]" />
              <span className="text-[10px] font-bold hidden xl:inline">SIDECHAIN</span>
            </button>
          )}

          {/* Melodyne Polyphonic ARA Blob Editor */}
          {onOpenPolyphonicEditor && (
            <button
              id="fl-polyphonic-editor-btn"
              onClick={onOpenPolyphonicEditor}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Melodyne / ARA2 Polyphonic Note Blob & Formant Editor"
            >
              <Activity className="w-3.5 h-3.5 text-[#00ff88]" />
              <span className="text-[10px] font-bold hidden xl:inline">ARA BLOB</span>
            </button>
          )}

          {/* Advanced Warp Modes (Beats, Tones, Texture, Complex Pro) */}
          {onOpenWarpProcessor && (
            <button
              id="fl-warp-processor-btn"
              onClick={onOpenWarpProcessor}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Advanced Time-Stretch & Transient Warp Modes (Élastique Pro)"
            >
              <Zap className="w-3.5 h-3.5 text-[#00ff88]" />
              <span className="text-[10px] font-bold hidden xl:inline">WARP</span>
            </button>
          )}

          {/* Film Scoring Video Sync */}
          {onOpenVideoScoring && (
            <button
              id="fl-video-scoring-btn"
              onClick={onOpenVideoScoring}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Film Scoring & SMPTE Video Timecode Monitor"
            >
              <Film className="w-3.5 h-3.5 text-[#a855f7]" />
              <span className="text-[10px] font-bold hidden xl:inline">VIDEO SYNC</span>
            </button>
          )}

          {/* 3D Dolby Atmos Spatial Panner */}
          {onOpenSpatialAudio && (
            <button
              id="fl-spatial-panner-btn"
              onClick={onOpenSpatialAudio}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="3D Dolby Atmos & Spatial Audio Binaural Panner"
            >
              <Headphones className="w-3.5 h-3.5 text-[#00e5ff]" />
              <span className="text-[10px] font-bold hidden xl:inline">3D SPATIAL</span>
            </button>
          )}

          {/* MPE Polyphonic Expression Editor */}
          {onOpenMpeExpression && (
            <button
              id="fl-mpe-expression-btn"
              onClick={onOpenMpeExpression}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="MPE (MIDI Polyphonic Expression) Per-Note Slide & Aftertouch"
            >
              <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
              <span className="text-[10px] font-bold hidden xl:inline">MPE</span>
            </button>
          )}

          {/* AI Stem Splitter & Motif Generator */}
          {onOpenStemSplitter && (
            <button
              id="fl-stem-splitter-btn"
              onClick={onOpenStemSplitter}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="AI 4-Stem Audio Splitter & Neural Motif Generator"
            >
              <Wand2 className="w-3.5 h-3.5 text-[#ff6e00]" />
              <span className="text-[10px] font-bold hidden xl:inline">AI STEMS</span>
            </button>
          )}

          {/* Master Macro Performance Rack */}
          {onOpenMasterMacros && (
            <button
              id="fl-master-macros-btn"
              onClick={onOpenMasterMacros}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Master Macro Performance Multi-Target Knobs"
            >
              <Sliders className="w-3.5 h-3.5 text-[#00ff88]" />
              <span className="text-[10px] font-bold hidden xl:inline">MACROS</span>
            </button>
          )}

          {/* Project ZIP Archive Exporter & Importer */}
          {onOpenProjectZipBundle && (
            <button
              id="fl-project-zip-btn"
              onClick={onOpenProjectZipBundle}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#1a1712] hover:bg-[#2a2218] text-[#ffaa00] hover:text-white rounded border border-[#ffaa00]/40 text-xs transition"
              title="Project .ZIP Archive Exporter & Importer"
            >
              <FolderArchive className="w-3.5 h-3.5 text-[#ffaa00]" />
              <span className="text-[10px] font-bold hidden xl:inline">.ZIP BUNDLE</span>
            </button>
          )}

          {/* Standalone Desktop Computer Program Installer */}
          {onOpenDesktopApp && (
            <button
              id="fl-desktop-app-btn"
              onClick={onOpenDesktopApp}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#221812] hover:bg-[#332218] text-[#ffaa00] hover:text-white rounded border border-[#ff6e00]/50 text-xs transition font-bold shadow-sm"
              title="Run as Standalone Windowed Desktop Computer Program (Windows / Mac / Linux)"
            >
              <Monitor className="w-3.5 h-3.5 text-[#ff6e00]" />
              <span className="text-[10px] hidden sm:inline">DESKTOP APP</span>
            </button>
          )}

          {/* Parametric EQ 2 Master Button */}
          {onOpenParametricEq && (
            <button
              id="fl-master-eq-btn"
              onClick={onOpenParametricEq}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Open 7-Band Parametric EQ 2"
            >
              <BarChart2 className="w-3.5 h-3.5 text-[#00bcd4]" />
              <span className="text-[10px] font-bold hidden lg:inline">EQ 2</span>
            </button>
          )}

          {/* Mastering Suite Pro Button */}
          {onOpenMasteringSuite && (
            <button
              id="fl-mastering-suite-btn"
              onClick={onOpenMasteringSuite}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Open Apex Mastering Suite (LUFS, Multiband, Limiter)"
            >
              <Activity className="w-3.5 h-3.5 text-[#ff6e00]" />
              <span className="text-[10px] font-bold hidden lg:inline">MASTER</span>
            </button>
          )}

          {/* DirectWave Sample Loader Button */}
          {onOpenSampleManager && (
            <button
              id="fl-sampler-modal-btn"
              onClick={onOpenSampleManager}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
              title="Import Audio Samples & Slicing"
            >
              <Music className="w-3.5 h-3.5 text-[#00ff88]" />
              <span className="text-[10px] font-bold hidden xl:inline">SAMPLE</span>
            </button>
          )}

          {/* Desktop Hotkeys Guide */}
          <button
            id="fl-hotkeys-btn"
            onClick={onOpenHotkeys}
            className="flex items-center gap-1 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
            title="Desktop DAW Keyboard Shortcuts (Space, F5, F6, F7, F9)"
          >
            <Keyboard className="w-3.5 h-3.5 text-[#e67e22]" />
          </button>

          {/* Fullscreen Landscape Toggle */}
          <button
            id="fl-fullscreen-btn"
            onClick={handleToggleFullscreen}
            className={`p-1.5 rounded transition border text-xs flex items-center gap-1 ${
              isFullscreen
                ? 'bg-[#ff6e00]/20 text-[#ff6e00] border-[#ff6e00]'
                : 'bg-[#121214] text-[#b0b0b0] hover:text-white border-[#333336] hover:bg-[#222225]'
            }`}
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen Desktop Mode"}
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            <span className="text-[9px] font-bold hidden xl:inline">{isFullscreen ? 'WINDOW' : 'FULLSCREEN'}</span>
          </button>

          {/* Collab */}
          <button
            id="fl-collab-btn"
            onClick={onOpenCollab}
            className="flex items-center gap-1.5 px-2 py-1 bg-[#121214] hover:bg-[#222225] text-[#b0b0b0] hover:text-white rounded border border-[#333336] text-xs transition"
            title="Real-time multi-user collaboration"
          >
            <Users className="w-3.5 h-3.5 text-[#ff6e00]" />
            <span className="text-[10px] font-bold text-[#ff6e00]">{collaboratorCount}</span>
          </button>

          {/* Export Studio Master */}
          <button
            id="fl-export-btn"
            onClick={onOpenExport}
            className="flex items-center gap-1 px-2.5 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black rounded font-bold text-xs shadow-sm transition active:scale-95"
            title="Render Master Stems (ZIP, WAV, MP3, MIDI)"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">EXPORT</span>
          </button>

          {/* Pro Upgrade */}
          <button
            id="fl-pro-tier-btn"
            onClick={onOpenSubscription}
            className={`hidden md:flex items-center gap-1 px-2 py-1 rounded text-xs font-bold border transition ${
              isProUser 
                ? 'bg-[#222225] text-[#ff6e00] border-[#ff6e00]/40' 
                : 'bg-[#121214] text-[#ff6e00] border-[#333336] hover:border-[#ff6e00]'
            }`}
            title="Pro Membership"
          >
            <Crown className="w-3.5 h-3.5 text-[#ff6e00]" />
            <span className="text-[10px]">{isProUser ? 'PRO TIER' : 'UPGRADE'}</span>
          </button>
        </div>
      </div>

      {/* Subnav Ribbon / View Navigation Tabs */}
      <nav id="fl-view-tabs" className="h-8 bg-[#1a1a1d] border-t border-[#333336] flex items-center overflow-x-auto no-scrollbar px-2 sm:px-3 gap-1">
        <button
          id="nav-channel-rack"
          onClick={() => onSelectView('channel_rack')}
          className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 text-xs font-bold rounded-sm transition whitespace-nowrap ${
            currentView === 'channel_rack'
              ? 'bg-[#2d2d30] text-white border-b-2 border-[#ff6e00]'
              : 'text-[#777] hover:text-white hover:bg-[#222225]'
          }`}
        >
          <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span>Channel Rack</span>
        </button>

        <button
          id="nav-piano-roll"
          onClick={() => onSelectView('piano_roll')}
          className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 text-xs font-bold rounded-sm transition whitespace-nowrap ${
            currentView === 'piano_roll'
              ? 'bg-[#2d2d30] text-white border-b-2 border-[#ff6e00]'
              : 'text-[#777] hover:text-white hover:bg-[#222225]'
          }`}
        >
          <Music className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span>Piano Roll</span>
        </button>

        <button
          id="nav-playlist"
          onClick={() => onSelectView('playlist')}
          className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 text-xs font-bold rounded-sm transition whitespace-nowrap ${
            currentView === 'playlist'
              ? 'bg-[#2d2d30] text-white border-b-2 border-[#ff6e00]'
              : 'text-[#777] hover:text-white hover:bg-[#222225]'
          }`}
        >
          <Layers className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span>Playlist</span>
        </button>

        <button
          id="nav-mixer"
          onClick={() => onSelectView('mixer')}
          className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 text-xs font-bold rounded-sm transition whitespace-nowrap ${
            currentView === 'mixer'
              ? 'bg-[#2d2d30] text-white border-b-2 border-[#ff6e00]'
              : 'text-[#777] hover:text-white hover:bg-[#222225]'
          }`}
        >
          <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span>Mixer</span>
        </button>

        <button
          id="nav-instruments"
          onClick={() => onSelectView('instruments')}
          className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 text-xs font-bold rounded-sm transition whitespace-nowrap ${
            currentView === 'instruments'
              ? 'bg-[#2d2d30] text-white border-b-2 border-[#ff6e00]'
              : 'text-[#777] hover:text-white hover:bg-[#222225]'
          }`}
        >
          <Cpu className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span>VST Synths</span>
        </button>

        <button
          id="nav-sampler"
          onClick={() => onSelectView('sampler')}
          className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 text-xs font-bold rounded-sm transition whitespace-nowrap ${
            currentView === 'sampler'
              ? 'bg-[#2d2d30] text-white border-b-2 border-[#ff6e00]'
              : 'text-[#777] hover:text-white hover:bg-[#222225]'
          }`}
        >
          <Mic className="w-3.5 h-3.5 text-[#ff6e00]" />
          <span>Recorder</span>
        </button>
      </nav>
    </header>
  );
};
