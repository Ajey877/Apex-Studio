import React, { useEffect, useRef, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Mic, 
  X, 
  Sparkles, 
  Zap, 
  Sliders, 
  Radio, 
  Music, 
  Volume2, 
  Check, 
  Activity, 
  RotateCcw,
  Headphones,
  Gauge,
  Play,
  Wand2
} from 'lucide-react';
import { VocalTunerSettings, MusicalScale, Channel, PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { hydrateAudioClip } from '../audio/audioPersistence';
import { waitForSampleBufferPersistence } from '../audio/sampleBufferPersistence';
import { vocalCorrectAudioBuffer } from '../audio/vocalPitchCorrection';
import {
  VocalCorrectionCommitError,
  analyseVocalCorrectionSource,
  commitVocalPitchCorrection,
  describeVocalCorrectionPlan,
  type VocalCorrectionAnalysisResult,
} from '../audio/vocalPitchCorrectionCommit';
import { resolveWarpTarget, type WarpTargetResolution } from './warpClipTarget';

interface VocalTunerModalProps {
  isOpen: boolean;
  onClose: () => void;
  vocalTunerSettings: VocalTunerSettings;
  onUpdateVocalTuner: (settings: VocalTunerSettings) => void;
  channels: Channel[];
  /**
   * Phase 8A: the project's playlist clips plus the id of the clip the user
   * SELECTED — the offline pitch correction acts on that clip and nothing
   * else (never an arbitrary channel or the first clip in an array). Optional
   * so every pre-8A render site (tests included) keeps working unchanged; the
   * correction workflow honestly reports "no clip selected" without them.
   */
  clips?: PlaylistClip[];
  selectedClipId?: string | null;
  /** Publishes the corrected clip through the App's existing history path. */
  onUpdateClip?: (clip: PlaylistClip) => void;
}

const ROOT_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALES: { id: MusicalScale; label: string }[] = [
  { id: 'chromatic' as any, label: 'Chromatic (All 12 Notes)' },
  { id: 'major', label: 'Major (Natural / Happy)' },
  { id: 'minor', label: 'Natural Minor (Aeolian / Emotional)' },
  { id: 'harmonic_minor', label: 'Harmonic Minor (Dark / Neo-Classical)' },
  { id: 'pentatonic_minor', label: 'Pentatonic Minor (Trap / Blues / Rock)' },
  { id: 'pentatonic_major', label: 'Pentatonic Major (R&B / Soul)' },
  { id: 'dorian', label: 'Dorian (Deep House / Funk)' },
  { id: 'phrygian', label: 'Phrygian (Spanish / Phonk)' },
  { id: 'lydian', label: 'Lydian (Ethereal / Dream)' },
  { id: 'mixolydian', label: 'Mixolydian (Blues / Southern)' },
  { id: 'blues', label: 'Blues Scale' },
  { id: 'arabic_double_harmonic', label: 'Arabic / Byzantine' }
];

const PRESETS = [
  {
    name: 'Hard Robotic Snap (T-Pain / Travis Scott)',
    retuneSpeedMs: 0,
    formantShift: 0,
    vibratoDepth: 0,
    humanize: 0,
    scale: 'minor' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'Modern Pop Polish (Ariana / The Weeknd)',
    retuneSpeedMs: 18,
    formantShift: 0.5,
    vibratoDepth: 0.2,
    humanize: 0.35,
    scale: 'minor' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'Deep Trap Pitch Down (-3 Semitones)',
    retuneSpeedMs: 5,
    formantShift: -3,
    vibratoDepth: 0.1,
    humanize: 0.1,
    scale: 'minor' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'High Chipmunk Hyperpop (+4 Semitones)',
    retuneSpeedMs: 0,
    formantShift: 4,
    vibratoDepth: 0.3,
    humanize: 0.2,
    scale: 'major' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'Transparent Vocal Glue (Natural)',
    retuneSpeedMs: 45,
    formantShift: 0,
    vibratoDepth: 0.4,
    humanize: 0.75,
    scale: 'major' as MusicalScale,
    rootKey: 0
  }
];

/**
 * Phase 8A — what the offline correction workflow really does, stated once so
 * the UI never overclaims:
 *  - it analyses the SELECTED audio clip's real PCM (YIN pitch detection),
 *  - maps confidently voiced notes to the chosen key/scale (±2 semitones max),
 *  - renders duration-preserving corrected PCM and commits it as a NEW asset
 *    through the durable pipeline (original kept for undo),
 *  - and it is the ONLY way this panel touches audio: nothing here processes
 *    the live signal path, and formant/vibrato/humanize remain stored intent.
 */
export const VocalTunerModal: React.FC<VocalTunerModalProps> = ({
  isOpen,
  onClose,
  vocalTunerSettings,
  onUpdateVocalTuner,
  channels,
  clips,
  selectedClipId,
  onUpdateClip
}) => {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // Phase 8A offline-correction workflow state.
  const [analysis, setAnalysis] = useState<VocalCorrectionAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [correctedPreview, setCorrectedPreview] = useState<AudioBuffer | null>(null);
  const [isAnalysing, setIsAnalysing] = useState<boolean>(false);
  const [isCommitting, setIsCommitting] = useState<boolean>(false);
  const [previewKind, setPreviewKind] = useState<'original' | 'corrected' | null>(null);
  const previewNodeRef = useRef<AudioBufferSourceNode | null>(null);

  const target: WarpTargetResolution = resolveWarpTarget(clips ?? [], selectedClipId ?? null);
  const targetClip = target.kind === 'ready' ? target.clip : null;
  const busy = isAnalysing || isCommitting;

  // Any change of clip or settings invalidates a previous analysis: the plan
  // must always describe the audio and settings a commit would really use.
  useEffect(() => {
    setAnalysis(null);
    setCorrectedPreview(null);
    setAnalysisError(null);
  }, [selectedClipId, vocalTunerSettings, clips]);

  // Stop any audition when the modal closes or unmounts.
  const stopPreview = (): void => {
    if (previewNodeRef.current) {
      try { previewNodeRef.current.stop(); } catch { /* already stopped */ }
      previewNodeRef.current.disconnect();
      previewNodeRef.current = null;
    }
    setPreviewKind(null);
  };
  useEffect(() => {
    if (!isOpen) stopPreview();
    return () => stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  /** Real audio audition of a real buffer through the engine context. */
  const playPreview = (buffer: AudioBuffer | null, kind: 'original' | 'corrected'): void => {
    stopPreview();
    if (!buffer) return;
    try {
      const ctx = audioEngine.getContext();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.start();
      previewNodeRef.current = node;
      setPreviewKind(kind);
      node.onended = () => {
        if (previewNodeRef.current === node) {
          previewNodeRef.current = null;
          setPreviewKind(null);
        }
      };
    } catch (error) {
      setStatusMessage(`Preview playback failed (${error instanceof Error ? error.message : String(error)}).`);
    }
  };

  const buildDeps = () => ({
    getSourceBuffer: (id: string) => audioEngine.getSampleBuffer(id),
    hydrateSource: (id: string) => hydrateAudioClip(audioEngine, id),
    registerAsset: (id: string, buffer: AudioBuffer) => audioEngine.setSampleBuffer(id, buffer),
    waitForAsset: (id: string) => waitForSampleBufferPersistence(audioEngine, id),
    createBuffer: (numberOfChannels: number, length: number, sampleRate: number) =>
      audioEngine.getContext().createBuffer(numberOfChannels, length, sampleRate),
    now: () => Date.now(),
  });

  const handleAnalyse = async (): Promise<void> => {
    if (!targetClip || busy) return;
    setIsAnalysing(true);
    setAnalysisError(null);
    setAnalysis(null);
    setCorrectedPreview(null);
    stopPreview();
    setStatusMessage('Analysing the selected clip\'s real audio (YIN pitch detection)…');
    try {
      const deps = buildDeps();
      const result = await analyseVocalCorrectionSource(targetClip, vocalTunerSettings, deps);
      // Render the corrected preview PCM now so "Preview corrected" plays the
      // ACTUAL processed audio — never a fabricated animation.
      const preview = vocalCorrectAudioBuffer(result.sourceBuffer, result.settings, deps.createBuffer);
      setAnalysis(result);
      setCorrectedPreview(preview);
      setStatusMessage(`Analysis complete — ${describeVocalCorrectionPlan(result)}`);
    } catch (error) {
      if (error instanceof VocalCorrectionCommitError) {
        setAnalysisError(error.message);
        setStatusMessage(null);
      } else {
        setAnalysisError(`Analysis failed (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`);
        setStatusMessage(null);
      }
    } finally {
      setIsAnalysing(false);
    }
  };

  const handleCommit = async (): Promise<void> => {
    if (!targetClip || busy || !analysis) return;
    setIsCommitting(true);
    setAnalysisError(null);
    stopPreview();
    setStatusMessage('Rendering pitch-corrected audio and committing it as a new durable asset…');
    try {
      const result = await commitVocalPitchCorrection(targetClip, vocalTunerSettings, buildDeps());
      if (!onUpdateClip) {
        throw new Error('this app surface does not accept corrected clips (no update path wired)');
      }
      onUpdateClip(result.clip);
      const { summary } = result;
      setStatusMessage(
        `Committed offline pitch correction (${summary.measuredNoteName ?? '?'} → ${summary.targetNoteName ?? '?'}, mean ${summary.meanCentsApplied.toFixed(0)}¢): "${targetClip.name}" now references ${result.correctedBuffer.duration.toFixed(2)} s of corrected audio. The original asset is untouched — Undo restores it.`
      );
      setAnalysis(null);
      setCorrectedPreview(null);
      setTimeout(() => {
        onClose();
      }, 2600);
    } catch (error) {
      if (error instanceof VocalCorrectionCommitError) {
        setAnalysisError(error.message);
      } else {
        setAnalysisError(`Commit failed (${error instanceof Error ? error.message : String(error)}). The clip was not changed.`);
      }
      setStatusMessage(null);
    } finally {
      setIsCommitting(false);
    }
  };

  const targetMessage = (resolution: WarpTargetResolution): string => {
    switch (resolution.kind) {
      case 'no-selection':
        return 'Select an audio clip in the Playlist Arranger first — pitch correction edits the clip you select, not a default one.';
      case 'missing':
        return 'The selected clip is no longer in the project. Select an audio clip in the Playlist Arranger.';
      case 'unsupported-type':
        return `"${resolution.clip.name}" is a ${resolution.clip.type} clip. Pitch correction applies to audio clips only.`;
      case 'ready':
        return '';
    }
  };

  /**
   * Phase 52: this panel used to animate a pitch needle from a sine curve and
   * print invented "measured" numbers. Phase 8A replaces the invented display
   * with a REAL offline analysis: nothing is shown as measured until the user
   * analyses the selected clip's actual PCM, and the readings below come only
   * from that analysis (note names and cents — the DSP module owns every
   * number). The live signal path still contains no pitch processor.
   */
  const handleApplyPreset = (preset: typeof PRESETS[0]) => {
    onUpdateVocalTuner({
      ...vocalTunerSettings,
      retuneSpeedMs: preset.retuneSpeedMs,
      formantShift: preset.formantShift,
      vibratoDepth: preset.vibratoDepth,
      humanize: preset.humanize,
      scale: preset.scale,
      rootKey: preset.rootKey
    });
    setStatusMessage(`Applied preset: ${preset.name}`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  if (!isOpen) return null;

  return (
    <ModalFrame id="fl-vocal-tuner-modal" labelledBy="fl-vocal-tuner-modal-title" onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-cyan)] to-[var(--apex-cyan-strong)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-vocal-tuner-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">AUTO-PITCH &amp; VOCAL TUNER</h2>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                  vocalTunerSettings.enabled 
                    ? 'bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)] text-[var(--apex-text)] border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)]'
                    : 'bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] border-[var(--apex-border)]'
                }`}>
                  {vocalTunerSettings.enabled ? 'ENABLED (NOT APPLIED)' : 'DISABLED'}
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Offline pitch correction for the selected audio clip — an explicit analyse &amp; commit; formant, vibrato and humanize remain stored intent, NOT APPLIED</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onUpdateVocalTuner({ ...vocalTunerSettings, enabled: !vocalTunerSettings.enabled })}
              className={`px-3 py-1 rounded text-xs font-bold transition flex items-center gap-1.5 ${
                vocalTunerSettings.enabled 
                  ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] shadow-md' 
                  : 'bg-[var(--apex-surface-2)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)] border border-[var(--apex-border)]'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{vocalTunerSettings.enabled ? 'ON (STORED)' : 'OFF'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close vocal tuner"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-cyan)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-[var(--apex-state-playing-fg)]/80 hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* ============ Phase 8A: OFFLINE PITCH CORRECTION (real processing) ============ */}
          <div className="bg-[var(--apex-surface-2)] rounded-xl border-t-2 border border-[var(--apex-border)] p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-[var(--apex-cyan-text)]" />
                <span className="text-xs font-bold text-[var(--apex-text)] tracking-wide">OFFLINE PITCH CORRECTION — ANALYSE &amp; RENDER/COMMIT</span>
              </div>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-cyan)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-cyan)_40%,transparent)] whitespace-nowrap">
                EXPLICIT OFFLINE ACTION · NO PROCESSING IN SIGNAL PATH
              </span>
            </div>

            {/* Target clip — the SELECTED playlist audio clip, never a default */}
            <div id="fl-vocal-correction-target" className="bg-[var(--apex-chrome-inset)] rounded-lg px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase tracking-wider">TARGET CLIP</span>
              {targetClip ? (
                <span className="text-[11px] font-mono font-bold text-[var(--apex-text)] truncate">{targetClip.name}</span>
              ) : (
                <span className="text-[10px] text-[var(--apex-text-3)] text-right">{targetMessage(target)}</span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Root Key */}
              <div className="bg-[var(--apex-surface)] p-3 rounded-lg border border-[var(--apex-border)] space-y-2">
                <span className="text-[10px] text-[var(--apex-text-2)] font-bold uppercase block">1. MUSICAL ROOT KEY</span>
                <div className="grid grid-cols-6 gap-1">
                  {ROOT_KEYS.map((k, idx) => (
                    <button
                      key={k}
                      onClick={() => onUpdateVocalTuner({ ...vocalTunerSettings, rootKey: idx })}
                      className={`py-1.5 rounded font-mono font-bold text-xs transition ${
                        vocalTunerSettings.rootKey === idx 
                          ? 'bg-[var(--apex-cyan)] text-[var(--apex-state-playing-fg)] shadow-md' 
                          : 'bg-[var(--apex-surface-2)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)] border border-[var(--apex-border)]'
                      }`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>

              {/* Musical Scale */}
              <div className="bg-[var(--apex-surface)] p-3 rounded-lg border border-[var(--apex-border)] space-y-2">
                <span className="text-[10px] text-[var(--apex-text-2)] font-bold uppercase block">2. TARGET MUSICAL SCALE</span>
                <select
                  value={vocalTunerSettings.scale}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, scale: e.target.value as any })}
                  className="w-full bg-[var(--apex-surface-2)] text-[var(--apex-text)] text-xs px-2.5 py-2 rounded border border-[var(--apex-border)] focus:outline-none font-semibold"
                >
                  {SCALES.map(s => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Retune Speed — governs the correction glide (real, applied) */}
            <div className="bg-[var(--apex-surface)] p-3 rounded-lg border border-[var(--apex-border)]">
              <div className="flex items-center justify-between text-[10px] text-[var(--apex-text-2)] font-bold uppercase mb-1">
                <span>RETUNE SPEED</span>
                <span className="text-[var(--apex-cyan-text)] font-mono">{vocalTunerSettings.retuneSpeedMs} ms</span>
              </div>
              <input
                type="range"
                min="0"
                max="80"
                step="1"
                value={vocalTunerSettings.retuneSpeedMs}
                onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, retuneSpeedMs: parseInt(e.target.value) })}
                className="w-full h-1.5 accent-[var(--apex-cyan)] bg-[var(--apex-surface-2)] rounded cursor-pointer"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] mt-1 font-mono block">
                {vocalTunerSettings.retuneSpeedMs === 0 ? 'Robotic Snap (0ms)' : vocalTunerSettings.retuneSpeedMs < 20 ? 'Modern Tight' : 'Natural Transparent'}
              </span>
            </div>

            {/* Analysis panel — honest by construction: nothing is shown as
                measured until the real analysis of the selected clip ran. */}
            <div className="bg-[var(--apex-chrome-inset)] rounded-xl border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] p-3.5 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[var(--apex-gold)]" />
                  <span className="font-bold text-[var(--apex-text)]">{analysis ? 'MEASURED CORRECTION PLAN' : 'PITCH DETECTION UNAVAILABLE'}</span>
                </div>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)] text-[var(--apex-gold)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)]">
                  {analysis ? 'FROM THE REAL ANALYSIS OF THIS CLIP' : 'NOTHING MEASURED YET'}
                </span>
              </div>

              {analysis ? (
                <div id="fl-vocal-correction-plan" className="w-full rounded-lg bg-[var(--apex-canvas)] border border-[var(--apex-border)] px-4 py-3 space-y-1.5">
                  <p className="text-[11px] font-mono font-bold text-[var(--apex-text)]">
                    {analysis.summary.measuredNoteName} → {analysis.summary.targetNoteName}
                    <span className="text-[var(--apex-text-2)]"> · mean {analysis.summary.meanCentsApplied.toFixed(0)}¢ · max {analysis.summary.maxCentsApplied.toFixed(0)}¢</span>
                  </p>
                  <p className="text-[10px] text-[var(--apex-text-2)] font-mono">
                    {(analysis.summary.voicedRatio * 100).toFixed(0)} % of frames confidently voiced ({analysis.summary.voicedSeconds.toFixed(2)} s) · {analysis.summary.correctedSeconds.toFixed(2)} s will be corrected · duration preserved exactly
                  </p>
                  <p className="text-[10px] text-[var(--apex-text-3)]">
                    Monophonic vocal-style material, fundamentals E2–B5, correction within ±2 semitones. Unvoiced, silent and out-of-range passages pass through untouched. Polyphonic material is refused, never guessed.
                  </p>
                </div>
              ) : (
                <div className="w-full h-24 rounded-lg bg-[var(--apex-canvas)] border border-[var(--apex-border)] flex items-center justify-center px-5">
                  <p className="text-[11px] text-[var(--apex-text-2)] text-center font-mono leading-relaxed">
                    NO MEASURED PITCH
                    <span className="block mt-1.5 font-sans">
                      Nothing is measured until you analyse the selected clip: the offline analysis reads that clip's real
                      audio and reports exactly what a correction would change. No live pitch analysis runs in the signal path.
                    </span>
                  </p>
                </div>
              )}

              {analysisError && (
                <p id="fl-vocal-correction-error" className="text-[11px] font-mono font-bold text-[var(--apex-gold)] bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] rounded px-3 py-2">
                  {analysisError}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                id="fl-vocal-correction-analyse"
                type="button"
                onClick={() => void handleAnalyse()}
                disabled={!targetClip || busy}
                className={`px-3 py-1.5 rounded text-xs font-bold border transition flex items-center gap-1.5 disabled:opacity-40 ${
                  analysis
                    ? 'bg-[var(--apex-surface)] text-[var(--apex-text-2)] border-[var(--apex-border)]'
                    : 'bg-[var(--apex-cyan)] text-[var(--apex-state-playing-fg)] border-[var(--apex-cyan)]'
                }`}
              >
                <Gauge className="w-3.5 h-3.5" />
                <span>{isAnalysing ? 'Analysing…' : analysis ? 'Re-analyse Clip' : 'Analyse Clip'}</span>
              </button>
              <button
                id="fl-vocal-correction-preview-original"
                type="button"
                onClick={() => playPreview(analysis?.sourceBuffer ?? null, 'original')}
                disabled={!analysis || busy}
                className={`px-3 py-1.5 rounded text-xs font-bold border transition flex items-center gap-1.5 disabled:opacity-40 ${
                  previewKind === 'original'
                    ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] border-[var(--apex-success)]'
                    : 'bg-[var(--apex-surface)] text-[var(--apex-text-2)] border-[var(--apex-border)]'
                }`}
              >
                <Headphones className="w-3.5 h-3.5" />
                <span>Preview Original</span>
              </button>
              <button
                id="fl-vocal-correction-preview-corrected"
                type="button"
                onClick={() => playPreview(correctedPreview, 'corrected')}
                disabled={!correctedPreview || busy}
                className={`px-3 py-1.5 rounded text-xs font-bold border transition flex items-center gap-1.5 disabled:opacity-40 ${
                  previewKind === 'corrected'
                    ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] border-[var(--apex-success)]'
                    : 'bg-[var(--apex-surface)] text-[var(--apex-text-2)] border-[var(--apex-border)]'
                }`}
              >
                <Play className="w-3.5 h-3.5" />
                <span>Preview Corrected</span>
              </button>
              <button
                id="fl-vocal-correction-commit"
                type="button"
                onClick={() => void handleCommit()}
                disabled={!targetClip || !analysis || busy || !onUpdateClip}
                className="px-3 py-1.5 rounded text-xs font-bold bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] border border-[var(--apex-success)] transition flex items-center gap-1.5 disabled:opacity-40 ml-auto"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{isCommitting ? 'Rendering & Committing…' : 'Render & Commit Correction'}</span>
              </button>
            </div>

            <p className="text-[9px] text-[var(--apex-text-3)] font-mono">
              Committing writes the corrected PCM as a NEW audio asset (original kept for Undo) through the same durable
              pipeline as recording and bounce. The ON/OFF toggle above only stores project intent — correction never
              happens automatically, and there is no live pitch processing in the signal path.
            </p>
          </div>

          {/* ============ Stored-intent controls (NOT APPLIED) ============ */}
          {/* Phase 79: the preset matrix and the formant/vibrato/humanize knobs are
              STORED INTENT only — wrapped in a disabled fieldset with a uniform
              "NOT APPLIED" banner so no control appears to be altering audio.
              onUpdateVocalTuner still fires so the values persist as project
              intent. Phase 8A implements offline correction ONLY; formant shift,
              vibrato depth and humanize are still not applied anywhere. */}
          <fieldset disabled className="opacity-60 relative">
            <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)] text-[var(--apex-gold)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] z-10">
              NOT APPLIED — STORED INTENT
            </div>
          {/* Quick Presets Bar */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] space-y-2">
            <span className="text-[10px] text-[var(--apex-text-2)] font-bold uppercase tracking-wider block">PRO VOCAL PRESETS</span>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p, idx) => (
                <button
                  key={idx}
                  onClick={() => handleApplyPreset(p)}
                  className="px-2.5 py-1 rounded bg-[var(--apex-surface)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text)] text-[11px] font-semibold border border-[var(--apex-border)] transition hover:border-[var(--apex-cyan)]"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* Scale & Key Lock Engine */}
          <div className="bg-[var(--apex-chrome-inset)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] rounded-lg px-3 py-2 flex items-center justify-between gap-2 mt-3">
            <span className="text-[10px] font-mono font-bold text-[var(--apex-gold)] uppercase tracking-wider">
              AUTO-PITCH: NOT APPLIED — NO PROCESSING IN SIGNAL PATH
            </span>
            <span className="text-[10px] text-[var(--apex-text-3)] whitespace-nowrap">STORED AS PROJECT INTENT</span>
          </div>

          {/* Knobs Matrix: Formants, Vibrato, Humanize — STORED INTENT ONLY.
              These sliders are kept for intent-storage (so a future phase can read
              the user's saved preferences) but the panel is disabled and labelled
              so no control implies the engine is processing audio. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            {/* Formant Shift */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[10px] text-[var(--apex-text-2)] font-bold uppercase mb-1">
                  <span>FORMANT SHIFT</span>
                  <span className="text-[var(--apex-success)] font-mono">{vocalTunerSettings.formantShift > 0 ? `+${vocalTunerSettings.formantShift}` : vocalTunerSettings.formantShift} st</span>
                </div>
                <input
                  type="range"
                  min="-12"
                  max="12"
                  step="0.5"
                  value={vocalTunerSettings.formantShift}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, formantShift: parseFloat(e.target.value) })}
                  className="w-full h-1.5 accent-[var(--apex-success)] bg-[var(--apex-surface)] rounded cursor-pointer"
                />
              </div>
              <span className="text-[9px] text-[var(--apex-text-3)] mt-1 font-mono">
                {vocalTunerSettings.formantShift < 0 ? 'Deep Throat / Male' : vocalTunerSettings.formantShift > 0 ? 'Chipmunk / Hyperpop' : 'Natural Throat'}
              </span>
            </div>

            {/* Vibrato Depth */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[10px] text-[var(--apex-text-2)] font-bold uppercase mb-1">
                  <span>VIBRATO DEPTH</span>
                  <span className="text-[var(--apex-accent)] font-mono">{Math.round(vocalTunerSettings.vibratoDepth * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={vocalTunerSettings.vibratoDepth}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, vibratoDepth: parseFloat(e.target.value) })}
                  className="w-full h-1.5 accent-[var(--apex-accent)] bg-[var(--apex-surface)] rounded cursor-pointer"
                />
              </div>
              <span className="text-[9px] text-[var(--apex-text-3)] mt-1 font-mono">LFO Pitch Modulation</span>
            </div>

            {/* Humanize */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[10px] text-[var(--apex-text-2)] font-bold uppercase mb-1">
                  <span>HUMANIZE</span>
                  <span className="text-[var(--apex-aux-text)] font-mono">{Math.round(vocalTunerSettings.humanize * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={vocalTunerSettings.humanize}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, humanize: parseFloat(e.target.value) })}
                  className="w-full h-1.5 accent-[var(--apex-aux)] bg-[var(--apex-surface)] rounded cursor-pointer"
                />
              </div>
              <span className="text-[9px] text-[var(--apex-text-3)] mt-1 font-mono">Micro-variation preserve</span>
            </div>
          </div>
          </fieldset>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onUpdateVocalTuner({
                  enabled: true,
                  scale: 'minor',
                  rootKey: 0,
                  retuneSpeedMs: 0,
                  formantShift: 0,
                  vibratoDepth: 0,
                  humanize: 0
                });
                setStatusMessage('Reset to Default Auto-Pitch snap');
              }}
              className="flex items-center gap-1 px-3 py-1.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text)] rounded transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Tuner</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-cyan)] hover:bg-[var(--apex-cyan-strong)] text-[var(--apex-state-playing-fg)] font-bold rounded transition"
          >
            Apply & Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
