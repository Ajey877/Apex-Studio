import React, { useEffect, useMemo, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import {
  Activity,
  AlertTriangle,
  Check,
  FileMusic,
  Gauge,
  Music,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { Channel, Pattern, ProjectState, PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { hydrateAudioClip } from '../audio/audioPersistence';
import {
  AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_STEPS,
  AUDIO_TO_MIDI_DEFAULT_QUANTIZE_STEPS,
  AUDIO_TO_MIDI_QUANTIZE_CHOICES,
  AudioToMidiError,
  type AudioToMidiAnalysis,
  type AudioToMidiOptions,
  type ClipTimelinePlan,
  type TranscribedMidiNote,
} from '../audio/audioToMidi';
import {
  analyseSelectedClipForMidi,
  analyseSelectedClipForPolyphonicMidi,
} from '../audio/audioToMidiSource';
import {
  POLY_MAX_VOICES,
  POLY_MAX_MIDI,
  POLY_MIN_MIDI,
  type PolyphonicAnalysis,
} from '../audio/polyphonicTranscription';
import {
  AudioToMidiCommitError,
  audioToMidiNewPatternLengthSteps,
  commitAudioToMidiNotes,
  countChannelNotesInPattern,
} from '../state/audioToMidiCommit';
import { addEmptyPatternToProjectState } from '../state/patternContent';
import { resolveWarpTarget, type WarpTargetResolution } from './warpClipTarget';

/**
 * Phase 8C — Audio-to-MIDI.
 *
 * This surface replaces the previous "Polyphonic Blob Editor" prototype, which
 * was hard-coded demo data that never read a single sample of project audio.
 * What this modal does now, and only this:
 *
 *  1. resolves the SELECTED playlist audio clip's real PCM (engine memory, then
 *     the persisted asset store) and transcribes it with the shared YIN detector
 *     (`src/audio/pitchDetection.ts` — the same code the Vocal Tuner uses);
 *  2. SHOWS the transcription before anything is written: note names, start
 *     steps, lengths, velocities, the measured per-note confidence and the
 *     measurement statistics behind the verdict;
 *  3. on an explicit confirm, writes those notes into a real pattern through the
 *     App's existing history path (`mutateProjectState` → one undo step, autosaved);
 *  4. lets the user open the destination in the Piano Roll to edit and hear it.
 *
 * TWO EXPLICIT MODES (Phase 10B)
 * The user picks the analysis mode before analysing, and the panel always states
 * which one produced the verdict:
 *  - MONOPHONIC (default) — one voice, the shared YIN detector, 75–1000 Hz.
 *    Unchanged behaviour, including its `polyphonic-suspected` refusal.
 *  - POLYPHONIC — up to 4 simultaneous fundamentals in C2–C6 (MIDI 36–84), the
 *    multi-pitch analyzer in `polyphonicTranscription.ts`. Notes carry measured
 *    confidence (from the share of the spectrum they explain) and measured
 *    velocity; dense, inharmonic or over-4-voice material is REFUSED.
 *
 * HONEST BOUNDARIES, stated in the UI and enforced by the DSP modules:
 *  - monophonic: clearly voiced melodic material, fundamentals 75–1000 Hz;
 *  - polyphonic: clear tonal chords / melody-over-bass, C2–C6, at most 4 voices,
 *    no source separation, and adjacent semitones in one register can merge;
 *  - silence, noise, unreliable pitch, clips that are too short/wrong range and
 *    unsupported polyphony are REFUSED with a reason, never guessed;
 *  - a refusal leaves the project untouched, and the default destination is a
 *    NEW pattern, so an existing part can never be overwritten by accident.
 */

/** Which analysis produced the panel's verdict. Monophonic is the default. */
export type AudioToMidiAnalysisMode = 'monophonic' | 'polyphonic';

/** A completed analysis, tagged with the mode that produced it. */
type AnalysisReview =
  | { mode: 'monophonic'; analysis: AudioToMidiAnalysis; plan: ClipTimelinePlan | null }
  | { mode: 'polyphonic'; analysis: PolyphonicAnalysis; plan: ClipTimelinePlan | null };

/** Where a confirmed transcription goes. */
export interface AudioToMidiCommitRequest {
  /** `null` = create a new pattern for the transcription (the default). */
  patternId: string | null;
  channelId: string;
  notes: TranscribedMidiNote[];
  mode: 'append' | 'replace';
  confirmReplace: boolean;
}

export interface AudioToMidiCommitOutcome {
  ok: boolean;
  message: string;
  patternId?: string;
  patternName?: string;
  channelName?: string;
  notesWritten?: number;
}

interface AudioToMidiModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Real project state: destination patterns, channels, timing and lengths. */
  project?: ProjectState | null;
  clips?: PlaylistClip[];
  selectedClipId?: string | null;
  /** Commits through the App's history path; never called by an analysis. */
  onCommitNotes?: (request: AudioToMidiCommitRequest) => AudioToMidiCommitOutcome;
  /** Brings the destination into view in the Piano Roll. */
  onRevealInPianoRoll?: (patternId: string, channelId: string) => void;
}

/** Id used for the dry-run pattern while previewing a "new pattern" commit. */
const NEW_PATTERN_DRY_RUN_ID = 'audio-to-midi-preview';
const NEW_PATTERN_OPTION = '__new__';

const percent = (value: number): string => `${Math.round(value * 100)} %`;

const midiName = (midi: number): string => {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const rounded = Math.round(midi);
  return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
};

const cents = (value: number): string =>
  `${value > 0 ? '+' : ''}${value.toFixed(0)}¢`;

const targetMessage = (resolution: WarpTargetResolution): string => {
  switch (resolution.kind) {
    case 'no-selection':
      return 'Select an audio clip in the Playlist Arranger first — Audio-to-MIDI transcribes the clip you select, not a default one.';
    case 'missing':
      return 'The selected clip is no longer in the project. Select an audio clip in the Playlist Arranger.';
    case 'unsupported-type':
      return `"${resolution.clip.name}" is a ${resolution.clip.type} clip. Audio-to-MIDI reads audio clips only.`;
    case 'ready':
      return '';
  }
};

/** Playback facts the review panel shows, straight from the resolved plan. */
const describeWindow = (plan: ClipTimelinePlan | null): string => {
  if (!plan) return '—';
  return `${plan.sourceOffsetSeconds.toFixed(2)} s into the source, ${plan.sourceWindowSeconds.toFixed(2)} s of source → ${plan.timelineSeconds.toFixed(2)} s on the timeline`;
};

/** The mode badge: what actually produced the notes below. */
const MODE_BADGE: Record<AudioToMidiAnalysisMode, string> = {
  monophonic: 'MONOPHONIC · REAL PCM',
  polyphonic: 'POLYPHONIC · REAL PCM',
};

/** Per-mode statements of what is supported, shown next to the mode switch. */
const MODE_SUMMARY: Record<AudioToMidiAnalysisMode, string> = {
  monophonic: 'One voice at a time (YIN), 75–1000 Hz. Chords are refused.',
  polyphonic: `Up to ${POLY_MAX_VOICES} simultaneous notes, C2–C6 (MIDI ${POLY_MIN_MIDI}–${POLY_MAX_MIDI}). Chords and melody-over-bass only.`,
};

/** The measured pitch span of a set of notes, or an honest dash. */
const analysisRangeLabel = (notes: readonly { midi: number }[]): string => {
  if (notes.length === 0) return '—';
  const pitches = notes.map(note => note.midi);
  return `${midiName(Math.min(...pitches))}–${midiName(Math.max(...pitches))}`;
};

const MODE_LIMITS: Record<AudioToMidiAnalysisMode, string> = {
  monophonic:
    'Monophonic, clearly voiced melodic material, fundamentals 75–1000 Hz (≈ E2–B5). The clip\'s real trim offset, pitch shift and playback rate are compensated, so notes land where they sound. Silence, noise, unstable pitch, clips shorter than 0.25 s and polyphonic material (chords) are refused with a reason and never guessed. No chord or source separation, no harmonic-as-note inflation.',
  polyphonic: `Polyphonic tonal material: up to ${POLY_MAX_VOICES} simultaneous fundamentals in C2–C6 (MIDI ${POLY_MIN_MIDI}–${POLY_MAX_MIDI}). Harmonics are explained by the note that produced them and are never reported as extra notes. Confidence and velocity are measured from the spectrum (confidence is the share of the spectrum a note explains, mapped through a documented curve), not guessed. Dense mixes, drums, bells/inharmonic material and more than ${POLY_MAX_VOICES} voices are refused with a reason; two fundamentals about a semitone apart in one register can merge; a note sharing its fundamental with a much louder note can be missed. No source separation and no instrument identification. The clip's real trim offset, pitch shift and playback rate are compensated.`,
};

export const AudioToMidiModal: React.FC<AudioToMidiModalProps> = ({
  isOpen,
  onClose,
  project,
  clips,
  selectedClipId,
  onCommitNotes,
  onRevealInPianoRoll,
}) => {
  const [minNoteSteps, setMinNoteSteps] = useState<number>(AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_STEPS);
  const [quantizeSteps, setQuantizeSteps] = useState<number>(AUDIO_TO_MIDI_DEFAULT_QUANTIZE_STEPS);
  /** Monophonic stays the default: the existing behaviour is never a surprise. */
  const [analysisMode, setAnalysisMode] = useState<AudioToMidiAnalysisMode>('monophonic');
  const [review, setReview] = useState<AnalysisReview | null>(null);
  const [analysedClipId, setAnalysedClipId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [destination, setDestination] = useState<string>(NEW_PATTERN_OPTION);
  const [channelId, setChannelId] = useState<string>('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [committed, setCommitted] = useState<AudioToMidiCommitOutcome | null>(null);

  const target = resolveWarpTarget(clips ?? [], selectedClipId ?? null);
  const clip = target.kind === 'ready' ? target.clip : null;
  const timing = project
    ? { bpm: project.meta.bpm, timeSignature: project.meta.timeSignature }
    : null;
  const patterns: Pattern[] = project?.patterns ?? [];
  const channels: Channel[] = project?.channels ?? [];

  // A different clip or different controls invalidate a previous transcription:
  // what the panel shows must always describe the audio and settings a commit
  // would really use.
  useEffect(() => {
    setReview(null);
    setAnalysedClipId(null);
    setError(null);
    setCommitted(null);
  }, [selectedClipId, minNoteSteps, quantizeSteps, analysisMode]);

  // Reopening the surface starts clean: a commit report from a previous visit
  // must never read as if it had just happened.
  useEffect(() => {
    if (!isOpen) return;
    setCommitted(null);
    setError(null);
  }, [isOpen]);

  // Default destination is the SAFEST one: a brand-new pattern. The channel
  // defaults to the project's selected channel, then the first one.
  useEffect(() => {
    setDestination(NEW_PATTERN_OPTION);
    setMode('append');
    setConfirmReplace(false);
  }, [selectedClipId]);
  useEffect(() => {
    setChannelId(current => {
      if (current && channels.some(channel => channel.id === current)) return current;
      return project?.selectedChannelId ?? channels[0]?.id ?? '';
    });
  }, [channels, project?.selectedChannelId]);

  const options = useMemo<AudioToMidiOptions>(
    () => ({ minNoteSteps, quantizeSteps }),
    [minNoteSteps, quantizeSteps]
  );

  const accepted = review?.analysis.status === 'ok' && review.analysis.notes.length > 0;
  const previewNotes = useMemo<TranscribedMidiNote[]>(
    () => (accepted && review ? review.analysis.notes : []),
    [accepted, review]
  );
  const destinationPattern = destination === NEW_PATTERN_OPTION
    ? null
    : patterns.find(pattern => pattern.id === destination) ?? null;
  const destinationChannel = channels.find(channel => channel.id === channelId) ?? null;
  const existingNotes = destinationPattern && project && destinationChannel
    ? countChannelNotesInPattern(project, destinationPattern.id, destinationChannel.id)
    : 0;

  /**
   * Dry run of the exact commit the button would perform, on a COPY of the
   * project state. It answers "does this fit, and what will it write" before
   * the user commits — and it is why a refused destination never reaches the App.
   */
  const dryRun = useMemo(() => {
    if (!project || !destinationChannel || previewNotes.length === 0 || !accepted) return null;
    const patternLengthSteps = destinationPattern?.lengthSteps ?? project.totalBars ?? 0;
    try {
      let base = project;
      let targetPatternId = destinationPattern?.id ?? null;
      if (!targetPatternId) {
        base = addEmptyPatternToProjectState(project, {
          id: NEW_PATTERN_DRY_RUN_ID,
          name: 'New pattern',
          color: '#00e5ff',
          lengthSteps: audioToMidiNewPatternLengthSteps(previewNotes),
        });
        targetPatternId = NEW_PATTERN_DRY_RUN_ID;
      }
      const result = commitAudioToMidiNotes(base, {
        patternId: targetPatternId,
        channelId: destinationChannel.id,
        notes: previewNotes,
        mode: destinationPattern ? mode : 'append',
        confirmReplace: destinationPattern ? confirmReplace : true,
      });
      return { ok: true as const, result, patternLengthSteps };
    } catch (commitError) {
      if (commitError instanceof AudioToMidiCommitError) {
        return { ok: false as const, message: commitError.message, patternLengthSteps };
      }
      return {
        ok: false as const,
        message: commitError instanceof Error ? commitError.message : String(commitError),
        patternLengthSteps,
      };
    }
    // `mode`/`confirmReplace` deliberately participate: the preview must reflect
    // exactly what the commit button would do.
  }, [project, destinationChannel, destinationPattern, mode, confirmReplace, previewNotes, accepted]);

  if (!isOpen) return null;

  const handleAnalyse = async (): Promise<void> => {
    if (!clip || !timing || isAnalysing) return;
    setIsAnalysing(true);
    setError(null);
    setReview(null);
    setCommitted(null);
    const deps = {
      getSourceBuffer: (id: string) => audioEngine.getSampleBuffer(id),
      hydrateSource: (id: string) => hydrateAudioClip(audioEngine, id),
    };
    try {
      if (analysisMode === 'polyphonic') {
        const { analysis: result, plan } = await analyseSelectedClipForPolyphonicMidi(
          clip,
          timing,
          options,
          deps
        );
        setReview({ mode: 'polyphonic', analysis: result, plan });
      } else {
        const { analysis: result } = await analyseSelectedClipForMidi(clip, timing, options, deps);
        setReview({ mode: 'monophonic', analysis: result, plan: result.plan });
      }
      setAnalysedClipId(clip.id);
    } catch (caught) {
      if (caught instanceof AudioToMidiError) {
        setError(caught.message);
      } else {
        setError(
          `Analysis failed (${caught instanceof Error ? caught.message : String(caught)}). Nothing was changed.`
        );
      }
    } finally {
      setIsAnalysing(false);
    }
  };

  const handleCommit = (): void => {
    if (!onCommitNotes || !destinationChannel || !accepted) return;
    if (destinationPattern && mode === 'replace' && !confirmReplace) return;
    const outcome = onCommitNotes({
      patternId: destinationPattern?.id ?? null,
      channelId: destinationChannel.id,
      notes: previewNotes,
      mode: destinationPattern ? mode : 'append',
      confirmReplace: destinationPattern ? confirmReplace : true,
    });
    if (outcome.ok) {
      setCommitted(outcome);
      setReview(null);
      setAnalysedClipId(null);
    } else {
      setCommitted(null);
      setError(outcome.message);
    }
  };

  const handleDiscard = (): void => {
    setReview(null);
    setAnalysedClipId(null);
    setError(null);
  };

  const commitDisabled =
    !onCommitNotes ||
    !accepted ||
    !dryRun ||
    !dryRun.ok ||
    isAnalysing ||
    (Boolean(destinationPattern) && mode === 'replace' && !confirmReplace);

  return (
    <ModalFrame
      id="fl-audio-to-midi-modal"
      labelledBy="fl-audio-to-midi-modal-title"
      onClose={onClose}
      className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"
    >
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)] rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-success)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <FileMusic className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-audio-to-midi-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">
                  AUDIO TO MIDI
                </h2>
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)]"
                  data-testid="atm-mode-badge"
                >
                  {MODE_BADGE[analysisMode]}
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">
                Transcribes the selected audio clip's real PCM into editable MIDI notes — review first, commit explicitly
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close audio to MIDI"
            className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="bg-[var(--apex-gold)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center gap-1.5"
          >
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-4 space-y-3 overflow-y-auto">
          {/* Source + controls */}
          <div className="bg-[var(--apex-panel-header)] p-3 rounded-xl border border-[var(--apex-border)] flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[240px]">
              <div className="text-[10px] uppercase tracking-wide text-[var(--apex-text-3)]">Source clip</div>
              <div className="text-xs font-bold text-[var(--apex-text)] truncate" data-testid="atm-source-clip">
                {clip ? `${clip.name} (${clip.type})` : 'No audio clip selected'}
              </div>
              {!clip && (
                <div className="text-[10px] text-[var(--apex-text-3)]">{targetMessage(target)}</div>
              )}
            </div>

            <fieldset className="text-[10px] text-[var(--apex-text-3)] flex flex-col gap-1">
              <legend className="text-[10px] text-[var(--apex-text-3)]">ANALYSIS MODE</legend>
              <div className="flex items-center gap-3 text-[11px] text-[var(--apex-text-2)]">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="atm-analysis-mode"
                    aria-label="Monophonic analysis mode"
                    checked={analysisMode === 'monophonic'}
                    onChange={() => setAnalysisMode('monophonic')}
                  />
                  Monophonic
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="atm-analysis-mode"
                    aria-label="Polyphonic analysis mode"
                    checked={analysisMode === 'polyphonic'}
                    onChange={() => setAnalysisMode('polyphonic')}
                  />
                  Polyphonic
                </label>
              </div>
            </fieldset>

            <label className="text-[10px] text-[var(--apex-text-3)] flex flex-col gap-1">
              MIN NOTE
              <select
                aria-label="Minimum note length"
                value={minNoteSteps}
                onChange={event => setMinNoteSteps(Number(event.target.value))}
                className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded px-2 py-1 text-xs text-[var(--apex-text)]"
              >
                <option value={0.25}>1/64 (0.25 step)</option>
                <option value={0.5}>1/32 (0.5 step)</option>
                <option value={1}>1/16 (1 step)</option>
                <option value={2}>1/8 (2 steps)</option>
              </select>
            </label>

            <label className="text-[10px] text-[var(--apex-text-3)] flex flex-col gap-1">
              QUANTIZE
              <select
                aria-label="Quantize note starts and lengths"
                value={quantizeSteps}
                onChange={event => setQuantizeSteps(Number(event.target.value))}
                className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded px-2 py-1 text-xs text-[var(--apex-text)]"
              >
                {AUDIO_TO_MIDI_QUANTIZE_CHOICES.map(choice => (
                  <option key={choice} value={choice}>
                    {choice === 1 ? '1/16' : `${choice} steps`}
                  </option>
                ))}
              </select>
            </label>

            <button
              onClick={() => void handleAnalyse()}
              disabled={!clip || !timing || isAnalysing}
              className="px-3 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] disabled:opacity-40 text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isAnalysing ? 'Analysing real PCM…' : 'Analyse clip'}</span>
            </button>

            <div
              className="w-full text-[10px] text-[var(--apex-text-3)]"
              data-testid="atm-mode-summary"
            >
              {MODE_SUMMARY[analysisMode]}
            </div>
          </div>

          {/* Verdict / preview */}
          {review && (
            <div className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[var(--apex-success)]" />
                  <span className="text-xs font-bold text-[var(--apex-text)]">
                    {accepted ? `${previewNotes.length} note${previewNotes.length === 1 ? '' : 's'} transcribed` : 'Not transcribed'}
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border border-[var(--apex-border)] text-[var(--apex-text-3)]"
                    data-testid="atm-verdict"
                  >
                    {MODE_BADGE[review.mode].split(' ·')[0]} · {review.analysis.status.toUpperCase()}
                    {review.analysis.refusal ? ` · ${review.analysis.refusal}` : ''}
                  </span>
                </div>
                <span className="text-[10px] text-[var(--apex-text-3)]">{describeWindow(review.plan)}</span>
              </div>

              <p className="text-[11px] text-[var(--apex-text-2)]" data-testid="atm-message">
                {review.analysis.status === 'ok'
                  ? review.mode === 'polyphonic'
                    ? `Real multi-pitch analysis of the selected clip (${review.analysis.notes.length} notes, up to ${POLY_MAX_VOICES} simultaneous, ${percent(review.analysis.stats.explainedShare)} of the spectral peaks explained; ${minNoteSteps}-step minimum, ${quantizeSteps}-step grid). Note lengths are quantized to the project grid; edit them in the Piano Roll after committing.`
                    : `Real YIN analysis of the selected clip (${review.analysis.settings.quantizeSteps}-step grid, ${review.analysis.settings.minNoteSteps}-step minimum). Note lengths are quantized to the project grid; edit them in the Piano Roll after committing.`
                  : review.analysis.message}
              </p>

              {review.mode === 'monophonic' && review.analysis.stats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">VOICED</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">{percent(review.analysis.stats.voicedRatio)}</div>
                  </div>
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">CONFIDENCE</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">{percent(review.analysis.stats.medianConfidence)}</div>
                  </div>
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">RANGE</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">
                      {review.analysis.stats.lowestMidi === null || review.analysis.stats.highestMidi === null
                        ? '—'
                        : `${midiName(review.analysis.stats.lowestMidi)}–${midiName(review.analysis.stats.highestMidi)}`}
                    </div>
                  </div>
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">HARMONIC</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">{percent(review.analysis.stats.medianHarmonicRatio)}</div>
                  </div>
                </div>
              )}

              {review.mode === 'polyphonic' && review.analysis.stats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]" data-testid="atm-poly-stats">
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">PITCHED FRAMES</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">{percent(review.analysis.stats.pitchedRatio)}</div>
                  </div>
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">PEAK VOICES</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">
                      {review.analysis.stats.maxSimultaneousVoices} / {POLY_MAX_VOICES} voices
                    </div>
                  </div>
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">PEAKS EXPLAINED</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">{percent(review.analysis.stats.explainedShare)}</div>
                  </div>
                  <div className="bg-[var(--apex-surface)] rounded p-1.5 border border-[var(--apex-border)]">
                    <div className="text-[var(--apex-text-3)]">RANGE</div>
                    <div className="font-mono font-bold text-[var(--apex-text)]">
                      {analysisRangeLabel(review.analysis.notes)}
                    </div>
                  </div>
                </div>
              )}

              {accepted && (
                <div className="max-h-56 overflow-y-auto border border-[var(--apex-border)] rounded">
                  <table className="w-full text-[10px] font-mono">
                    <thead className="bg-[var(--apex-panel-header)] sticky top-0 text-[var(--apex-text-3)]">
                      <tr>
                        <th className="text-left px-2 py-1">#</th>
                        <th className="text-left px-2 py-1">NOTE</th>
                        <th className="text-right px-2 py-1">START</th>
                        <th className="text-right px-2 py-1">SEC</th>
                        <th className="text-right px-2 py-1">LEN</th>
                        <th className="text-right px-2 py-1">CONF</th>
                        <th className="text-right px-2 py-1">CENTS</th>
                        <th className="text-right px-2 py-1">VEL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewNotes.map((note, index) => (
                        <tr key={`${note.startStep}-${note.midi}-${index}`} className="border-t border-[var(--apex-border)]">
                          <td className="px-2 py-0.5 text-[var(--apex-text-3)]">{index + 1}</td>
                          <td className="px-2 py-0.5 text-[var(--apex-text)] font-bold">{note.noteName || midiName(note.midi)}</td>
                          <td className="px-2 py-0.5 text-right text-[var(--apex-text-2)]">{note.startStep}</td>
                          <td className="px-2 py-0.5 text-right text-[var(--apex-text-3)]">{note.startSeconds.toFixed(2)}</td>
                          <td className="px-2 py-0.5 text-right text-[var(--apex-text-2)]">{note.durationSteps}</td>
                          <td className="px-2 py-0.5 text-right text-[var(--apex-text-2)]">{percent(note.confidence)}</td>
                          <td className="px-2 py-0.5 text-right text-[var(--apex-text-3)]">{cents(note.centsOffset)}</td>
                          <td className="px-2 py-0.5 text-right text-[var(--apex-text-3)]">{percent(note.velocity)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[var(--apex-text-3)]">
                  Preview only — nothing has been written to the project yet.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDiscard}
                    className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] text-xs font-bold rounded flex items-center gap-1.5 transition"
                  >
                    <Trash2 className="w-3 h-3 text-[var(--apex-gold)]" />
                    <span>Discard preview</span>
                  </button>
                  <button
                    onClick={() => void handleAnalyse()}
                    disabled={!clip || isAnalysing}
                    className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] text-xs font-bold rounded flex items-center gap-1.5 transition disabled:opacity-40"
                  >
                    <RotateCcw className="w-3 h-3 text-[var(--apex-success)]" />
                    <span>Re-analyse</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Destination */}
          {accepted && project && (
            <div className="bg-[var(--apex-panel-header)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex items-center gap-2">
                <Music className="w-4 h-4 text-[var(--apex-success)]" />
                <span className="text-xs font-bold text-[var(--apex-text)] uppercase">Destination</span>
                <span className="text-[10px] text-[var(--apex-text-3)]">
                  default: a NEW pattern, so no existing part can be overwritten
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-[10px] text-[var(--apex-text-3)] flex flex-col gap-1">
                  PATTERN
                  <select
                    aria-label="Destination pattern"
                    value={destination}
                    onChange={event => {
                      setDestination(event.target.value);
                      setMode('append');
                      setConfirmReplace(false);
                    }}
                    className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded px-2 py-1 text-xs text-[var(--apex-text)]"
                  >
                    <option value={NEW_PATTERN_OPTION}>New pattern</option>
                    {patterns.map(pattern => (
                      <option key={pattern.id} value={pattern.id}>
                        {pattern.name} ({pattern.lengthSteps ?? 16} steps)
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-[10px] text-[var(--apex-text-3)] flex flex-col gap-1">
                  CHANNEL (INSTRUMENT)
                  <select
                    aria-label="Destination channel"
                    value={channelId}
                    onChange={event => setChannelId(event.target.value)}
                    className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded px-2 py-1 text-xs text-[var(--apex-text)]"
                  >
                    {channels.map(channel => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* A drum pad has no pitches. Saying so here is the difference
                  between "the transcription was wrong" and "you chose a kit". */}
              {destinationChannel?.instrumentType === 'drumpad' && (
                <p
                  data-testid="atm-channel-hint"
                  className="text-[10px] text-[var(--apex-gold)] leading-snug"
                >
                  {destinationChannel.name} is a drum pad: transcribed pitches will
                  trigger drum pads, not the notes reviewed above. Pick a pitched
                  instrument channel to hear the transcription.
                </p>
              )}

              {destinationPattern && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-4 text-[11px] text-[var(--apex-text-2)]">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="atm-mode"
                        checked={mode === 'append'}
                        onChange={() => {
                          setMode('append');
                          setConfirmReplace(false);
                        }}
                      />
                      Add after the {existingNotes} existing note{existingNotes === 1 ? '' : 's'}
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="atm-mode"
                        checked={mode === 'replace'}
                        onChange={() => setMode('replace')}
                      />
                      Replace them
                    </label>
                    {mode === 'replace' && (
                      <label className="flex items-center gap-1.5 text-[var(--apex-gold)] font-bold">
                        <input
                          type="checkbox"
                          checked={confirmReplace}
                          onChange={event => setConfirmReplace(event.target.checked)}
                        />
                        I understand this deletes {existingNotes} existing note{existingNotes === 1 ? '' : 's'}
                      </label>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-[var(--apex-text-3)]" data-testid="atm-dry-run">
                  {dryRun && dryRun.ok
                    ? `Will write ${dryRun.result.notesWritten} note${dryRun.result.notesWritten === 1 ? '' : 's'} to "${
                        destinationPattern ? destinationPattern.name : 'a new pattern'
                      }" · ${destinationChannel?.name ?? 'no channel'}${
                        dryRun.result.offsetSteps > 0 ? ` · starts at step ${dryRun.result.offsetSteps}` : ''
                      }`
                    : dryRun && !dryRun.ok
                      ? dryRun.message
                      : 'Choose a destination to continue.'}
                </span>
                <button
                  onClick={handleCommit}
                  disabled={commitDisabled}
                  className="px-3 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] disabled:opacity-40 text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{mode === 'replace' && destinationPattern ? 'Replace notes with transcription' : 'Commit notes to project'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Commit result */}
          {committed && (
            <div className="bg-[color-mix(in_srgb,var(--apex-success)_14%,transparent)] border border-[color-mix(in_srgb,var(--apex-success)_45%,transparent)] rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--apex-text)]">
                <Check className="w-4 h-4 text-[var(--apex-success)]" />
                <span data-testid="atm-commit-result">{committed.message}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (committed.patternId && onRevealInPianoRoll) {
                      onRevealInPianoRoll(committed.patternId, channelId);
                    }
                    onClose();
                  }}
                  disabled={!committed.patternId || !onRevealInPianoRoll}
                  className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] disabled:opacity-40 text-[var(--apex-text)] text-xs font-bold rounded flex items-center gap-1.5 transition"
                >
                  <Play className="w-3 h-3 text-[var(--apex-success)]" />
                  <span>Open in Piano Roll</span>
                </button>
                <button
                  onClick={onClose}
                  className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] text-xs font-bold rounded transition"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Boundaries */}
          <div className="text-[10px] text-[var(--apex-text-3)] border-t border-[var(--apex-border)] pt-2 flex items-start gap-1.5">
            <Gauge className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span data-testid="atm-limits">
              {MODE_LIMITS[analysisMode]}{' '}
              {analysedClipId ? `Analysed clip: ${analysedClipId}.` : ''}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">
            Analysis and preview never change the project; only the explicit commit writes notes, as one undoable step.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] font-bold rounded transition flex items-center gap-1.5"
          >
            <X className="w-4 h-4" />
            <span>Close</span>
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
