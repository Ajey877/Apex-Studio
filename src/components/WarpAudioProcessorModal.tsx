import React, { useEffect, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { Zap, X, Sparkles, Play, Check, Waves } from 'lucide-react';
import { PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { hydrateAudioClip } from '../audio/audioPersistence';
import { waitForSampleBufferPersistence } from '../audio/sampleBufferPersistence';
import {
  WSOLA_MAX_RATIO,
  WSOLA_MIN_RATIO,
  WarpTimeStretchError,
  commitWarpTimeStretch,
  commitWarpTimeStretchToLength,
  computeFitToTempoRatio,
  describeFitToLengthPlan,
  describeFitToLengthTarget,
  describeWarpStretchPlan,
  formatBars,
  type FitToLengthContext,
  type FitToLengthTarget,
  type WarpStretchStrategy,
} from '../audio/warpTimeStretchCommit';
import { beatsPerBar, resolveProjectTimeSignature } from '../music/musicalTime';
import {
  STRETCH_BEHAVIOUR_SUMMARY,
  WARP_BEHAVIOUR_SUMMARY,
  isWarpTargetReady,
  resolveWarpTarget,
  warpTargetMessage,
} from './warpClipTarget';

interface WarpAudioProcessorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Every clip in the project plus the id of the clip the user selected, so the
   * tool edits the clip they chose. It used to receive `playlistClips[0]`, which
   * silently edited an unrelated clip on any multi-clip timeline.
   */
  clips: PlaylistClip[];
  selectedClipId: string | null;
  onUpdateClip?: (clip: PlaylistClip) => void;
  /**
   * Phase 7B: the project's authoritative tempo (`projectState.meta.bpm` in
   * the App). Fit to Project Tempo reads its TARGET from here — the modal
   * keeps no independent BPM setting of its own, so the fit can never drift
   * from the transport's tempo.
   */
  projectBpm: number;
  /**
   * Phase 7C: the project's authoritative time signature
   * (`projectState.meta.timeSignature` in the App). Fit to Musical Length
   * resolves it through the SAME `resolveProjectTimeSignature` authority the
   * transport/engine use — the modal never assumes 4/4 and offers no
   * independent meter setting, so the fit can never drift from the grid the
   * project actually plays on.
   */
  timeSignature: unknown;
}

export const WarpAudioProcessorModal: React.FC<WarpAudioProcessorModalProps> = ({
  isOpen,
  onClose,
  clips,
  selectedClipId,
  onUpdateClip,
  projectBpm,
  timeSignature
}) => {
  const target = resolveWarpTarget(clips, selectedClipId);
  const targetClip = isWarpTargetReady(target) ? target.clip : null;
  const blocker = isWarpTargetReady(target) ? '' : warpTargetMessage(target);

  const [pitchSemitones, setPitchSemitones] = useState<number>(targetClip?.pitchShiftSemitones || 0);
  const [stretchRate, setStretchRate] = useState<number>(targetClip?.timeStretchRate || 1.0);
  const [isAuditioning, setIsAuditioning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // Phase 7A: WSOLA pitch-preserving stretch — ratio + in-flight commit guard.
  const [wsolaRatio, setWsolaRatio] = useState<number>(1.0);
  const [isCommittingStretch, setIsCommittingStretch] = useState<boolean>(false);
  // Phase 7D: which renderer the user EXPLICITLY selects for the next stretch
  // commit (all three workflows). 'wsola' is the Phase 7A classic and the
  // default — nothing changes for users who never touch this. 'transient'
  // renders through the transient-anchored WSOLA (TAW), which measurably
  // tightens drum/percussion attack timing and cuts pre-echo. The choice is
  // never made automatically and never claimed for the classic path.
  const [stretchStrategy, setStretchStrategy] = useState<WarpStretchStrategy>('wsola');
  // Phase 7B: user-entered source tempo for Fit to Project Tempo. Kept as raw
  // input text so invalid entries can be reported instead of silently coerced.
  const [sourceBpmText, setSourceBpmText] = useState<string>('');
  // Phase 7C: the desired musical length in bars + quarter-note beats. Kept as
  // raw input text so invalid entries are reported instead of silently coerced.
  const [fitLenBarsText, setFitLenBarsText] = useState<string>('1');
  const [fitLenBeatsText, setFitLenBeatsText] = useState<string>('0');

  // The project's authoritative tempo + meter for Fit to Musical Length. Both
  // come from project state — they are deliberately NOT editable here.
  const fitCtx: FitToLengthContext = { bpm: projectBpm, timeSignature };
  const fitResolvedMeter = resolveProjectTimeSignature({ timeSignature });
  const fitMeterBeats = beatsPerBar(fitResolvedMeter);
  // The parsed target: empty bars are invalid (reported inline), empty beats
  // mean "whole bars only".
  const fitTarget: FitToLengthTarget = {
    bars: fitLenBarsText.trim() === '' ? Number.NaN : Number(fitLenBarsText),
    beats: fitLenBeatsText.trim() === '' ? 0 : Number(fitLenBeatsText),
  };

  // The modal stays mounted between openings, so re-seed the controls whenever
  // it opens or the target clip changes. Without this the sliders would keep
  // showing the previous clip's values.
  useEffect(() => {
    if (!isOpen) return;
    setPitchSemitones(targetClip?.pitchShiftSemitones ?? 0);
    setStretchRate(targetClip?.timeStretchRate ?? 1.0);
    setWsolaRatio(1.0);
    setStretchStrategy('wsola');
    setSourceBpmText('');
    setFitLenBarsText('1');
    setFitLenBeatsText('0');
  }, [isOpen, targetClip?.id]);

  if (!isOpen) return null;

  /**
   * Audition the *selected clip's own audio* at the current pitch and rate.
   *
   * The previous audition built a fake `sampler` channel with no sample behind
   * it; the sampler renderer finds no buffer and returns early, so the button
   * played nothing while reporting "Auditioning … Warp DSP Algorithm". This
   * plays the real buffer through the engine's context so the preview is the
   * actual clip audio at the settings shown.
   */
  const handleAuditionWarp = () => {
    if (!targetClip?.audioBufferId) {
      setStatusMessage('This clip has no loaded audio to audition.');
      setTimeout(() => setStatusMessage(null), 2500);
      return;
    }
    const buffer = audioEngine.getSampleBuffer(targetClip.audioBufferId);
    if (!buffer) {
      setStatusMessage('This clip’s audio is not loaded in this session, so it cannot be auditioned.');
      setTimeout(() => setStatusMessage(null), 2500);
      return;
    }

    const ctx = audioEngine.getContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = stretchRate;
    source.detune.value = pitchSemitones * 100;

    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    source.connect(gain);
    gain.connect(ctx.destination);

    const previewSeconds = Math.min(buffer.duration / Math.max(0.05, stretchRate), 4);
    setIsAuditioning(true);
    source.start(0, 0, previewSeconds);
    source.onended = () => setIsAuditioning(false);

    setStatusMessage('Previewing the clip’s own audio at the pitch and rate above (mixer inserts bypassed).');
    setTimeout(() => setStatusMessage(null), 2500);
  };

  const handleApplyWarp = () => {
    if (!targetClip || !onUpdateClip) return;
    onUpdateClip({
      ...targetClip,
      pitchShiftSemitones: pitchSemitones,
      timeStretchRate: stretchRate
    });
    setStatusMessage(`Applied pitch ${pitchSemitones > 0 ? '+' : ''}${pitchSemitones} st and ${stretchRate.toFixed(2)}x rate to "${targetClip.name}".`);
    setTimeout(() => {
      onClose();
    }, 1000);
  };

  /**
   * Phase 7A/7B: the ONE render/commit path for WSOLA stretches. Both the
   * manual ratio button and Fit to Project Tempo route through here, so both
   * share the same guarantees:
   *
   * This is NOT another setting: `commitWarpTimeStretch` resolves the selected
   * clip's real source PCM (engine memory, then the persisted project store),
   * renders it through WSOLA into new processed audio, registers that audio as
   * a NEW durable asset (the original asset is never touched, so undo always
   * has somewhere to go home to), waits for the asset write to settle, and only
   * then hands the updated clip to `onUpdateClip` — the same path the Apply
   * button uses, so the commit lands in project history and undo/redo restores
   * the previous clip AND its previous audio reference.
   *
   * Every refusal (no source audio, unavailable asset, unsupported ratio,
   * persistence failure) surfaces its typed, honest reason here and changes
   * nothing. Success is only reported after the asset is committed, and the
   * in-flight guard makes duplicate commits impossible while one is running.
   */
  const commitWsolaRender = async (ratio: number, operation: string, successLabel: string) => {
    if (!targetClip || !onUpdateClip || isCommittingStretch) return;
    if (!targetClip.audioBufferId) {
      setStatusMessage('This clip has no source audio asset — there is nothing to stretch.');
      return;
    }
    setIsCommittingStretch(true);
    const strategyLabel = stretchStrategy === 'transient' ? 'transient-anchored (TAW)' : 'WSOLA';
    setStatusMessage(`Rendering ${operation} — ${ratio.toFixed(2)}× pitch-preserving ${strategyLabel} stretch…`);
    try {
      const result = await commitWarpTimeStretch(targetClip, ratio, {
        getSourceBuffer: id => audioEngine.getSampleBuffer(id),
        hydrateSource: id => hydrateAudioClip(audioEngine, id),
        registerAsset: (id, buffer) => audioEngine.setSampleBuffer(id, buffer),
        waitForAsset: id => waitForSampleBufferPersistence(audioEngine, id),
        createBuffer: (channels, length, sampleRate) => audioEngine.getContext().createBuffer(channels, length, sampleRate),
        now: () => Date.now(),
      }, stretchStrategy);
      onUpdateClip(result.clip);
      setStatusMessage(
        `Committed ${successLabel} (${result.strategy === 'transient' ? 'transient-aware' : 'WSOLA'} render): "${targetClip.name}" now references ${result.stretchedBuffer.duration.toFixed(2)} s of processed audio. The original asset is untouched — Undo restores it.`
      );
      setTimeout(() => {
        onClose();
      }, 2500);
    } catch (error) {
      // Errors stay visible until dismissed — no auto-clear, no fake success.
      setStatusMessage(
        error instanceof WarpTimeStretchError
          ? error.message
          : `Stretch failed (${error instanceof Error ? error.message : String(error)}). The clip was not changed.`
      );
    } finally {
      setIsCommittingStretch(false);
    }
  };

  const handleCommitTimeStretch = () =>
    commitWsolaRender(wsolaRatio, 'stretch', `${wsolaRatio.toFixed(2)}× pitch-preserving stretch`);

  /**
   * Phase 7B: Fit to Project Tempo. The target tempo is the project's
   * authoritative BPM (the `projectBpm` prop — `projectState.meta.bpm`, the
   * same value the transport shows); the source tempo is ENTERED BY THE USER.
   * No beat detection is performed and no tempo is ever guessed. The ratio
   * r = sourceBpm / projectBpm commits through the same WSOLA pipeline as the
   * manual control — including its bounds refusal (never clamped) and its
   * durability/undo guarantees.
   */
  const handleCommitFitToTempo = () => {
    if (!targetClip || !onUpdateClip || isCommittingStretch) return;
    let fitRatio: number;
    try {
      fitRatio = computeFitToTempoRatio(sourceBpmText, projectBpm);
    } catch (error) {
      setStatusMessage(
        error instanceof WarpTimeStretchError
          ? error.message
          : `Fit to tempo failed (${error instanceof Error ? error.message : String(error)}). The clip was not changed.`
      );
      return;
    }
    const sourceLabel = Number(sourceBpmText.trim());
    void commitWsolaRender(
      fitRatio,
      `fit to project tempo (${sourceLabel} → ${projectBpm} BPM)`,
      `fit-to-tempo ${fitRatio.toFixed(2)}× (${sourceLabel} → ${projectBpm} BPM)`
    );
  };

  /**
   * Live, honest preview of the fit BEFORE committing: empty input reports
   * itself, invalid input shows the typed refusal text inline, and a valid
   * input shows the exact plan (ratio, bars and audio duration) that the
   * commit will produce — computed with the same functions the commit uses,
   * so preview and committed result cannot disagree.
   */
  const fitPreview = ((): { kind: 'empty' } | { kind: 'error'; message: string } | { kind: 'ready'; ratio: number; plan: string } => {
    if (!sourceBpmText.trim()) return { kind: 'empty' };
    try {
      const ratio = computeFitToTempoRatio(sourceBpmText, projectBpm);
      const plan = targetClip
        ? describeWarpStretchPlan(
            targetClip,
            ratio,
            targetClip.audioBufferId ? audioEngine.getSampleBuffer(targetClip.audioBufferId) : undefined
          )
        : `${ratio.toFixed(2)}×`;
      return { kind: 'ready', ratio, plan };
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof WarpTimeStretchError ? error.message : 'Enter the source tempo as a positive BPM number.',
      };
    }
  })();

  /**
   * Phase 7C: live, honest preview of the musical-length fit BEFORE committing.
   * It shows the EXACT intended destination (target bars → seconds at the
   * project's authoritative tempo + meter) and, when the clip's real source
   * PCM is resident, the full plan — required WSOLA ratio, processed-audio
   * duration and whether the fit is SUPPORTED — computed with the SAME
   * `computeFitToLengthPlan` the commit uses, so preview and committed result
   * cannot disagree. Unsupported clips (offsets, trims, detune, take groups)
   * and out-of-range ratios surface their typed refusal inline; nothing is
   * ever clamped or guessed. When the source is not loaded yet, the preview
   * says so honestly instead of fabricating a ratio.
   */
  const fitLengthPreview = ((): { kind: 'no-clip' } | { kind: 'no-source'; destination: string } | { kind: 'error'; message: string } | { kind: 'ready'; plan: string } => {
    if (!targetClip) return { kind: 'no-clip' };
    try {
      const destination = describeFitToLengthTarget(fitTarget, fitCtx);
      const buffer = targetClip.audioBufferId ? audioEngine.getSampleBuffer(targetClip.audioBufferId) : null;
      if (!buffer) return { kind: 'no-source', destination };
      return { kind: 'ready', plan: describeFitToLengthPlan(targetClip, fitTarget, fitCtx, buffer.duration) };
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof WarpTimeStretchError ? error.message : 'Enter the target length in whole bars and beats (e.g. 2 bars + 1.5 beats).',
      };
    }
  })();

  /**
   * Phase 7C: Fit to Musical Length. The destination (bars + quarter-note
   * beats) is entered by the user; the tempo and meter are the project's
   * AUTHORITATIVE values (`projectBpm` / `timeSignature` props — never
   * editable here, never assumed 4/4). `commitWarpTimeStretchToLength` runs
   * the SAME durable pipeline as the ratio and tempo fits — real source PCM →
   * WSOLA render → NEW unique asset → persistence awaited → only then publish
   * the clip with `lengthBars` set to the EXACT target — and refuses, with a
   * typed actionable message and zero mutation, anything that could not land
   * exactly on the requested destination (offsets, trims, detune, take
   * groups, out-of-range ratios).
   */
  const handleCommitFitToLength = async () => {
    if (!targetClip || !onUpdateClip || isCommittingStretch) return;
    if (!targetClip.audioBufferId) {
      setStatusMessage('This clip has no source audio asset — there is nothing to fit.');
      return;
    }
    setIsCommittingStretch(true);
    const strategyLabel = stretchStrategy === 'transient' ? 'transient-anchored (TAW)' : 'WSOLA';
    setStatusMessage(`Rendering fit to musical length — deriving the exact ${strategyLabel} ratio from the project tempo, meter and real source audio…`);
    try {
      const result = await commitWarpTimeStretchToLength(targetClip, fitTarget, fitCtx, {
        getSourceBuffer: id => audioEngine.getSampleBuffer(id),
        hydrateSource: id => hydrateAudioClip(audioEngine, id),
        registerAsset: (id, buffer) => audioEngine.setSampleBuffer(id, buffer),
        waitForAsset: id => waitForSampleBufferPersistence(audioEngine, id),
        createBuffer: (channels, length, sampleRate) => audioEngine.getContext().createBuffer(channels, length, sampleRate),
        now: () => Date.now(),
      }, stretchStrategy);
      onUpdateClip(result.clip);
      setStatusMessage(
        `Committed fit to musical length (${result.strategy === 'transient' ? 'transient-aware' : 'WSOLA'} render): "${targetClip.name}" now occupies exactly ${formatBars(result.clip.lengthBars)} bars (${result.plan.targetWindowSeconds.toFixed(2)} s at ${projectBpm.toFixed(2)} BPM ${result.plan.resolvedMeter[0]}/${result.plan.resolvedMeter[1]}) with ${result.stretchedBuffer.duration.toFixed(2)} s of processed audio. The audio length is baked into the new asset — the original is untouched and Undo restores it.`
      );
      setTimeout(() => {
        onClose();
      }, 2500);
    } catch (error) {
      // Errors stay visible until dismissed — no auto-clear, no fake success.
      setStatusMessage(
        error instanceof WarpTimeStretchError
          ? error.message
          : `Fit to length failed (${error instanceof Error ? error.message : String(error)}). The clip was not changed.`
      );
    } finally {
      setIsCommittingStretch(false);
    }
  };

  return (
    <ModalFrame id="fl-warp-processor-modal" labelledBy="fl-warp-processor-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      {/* UI-03N: every chrome surface, border, text and interaction state below
          consumes the existing `--apex-*` semantic tokens. The processor's
          green identity (tile, panel edge, target read-out, behaviour summary,
          pitch read-out and the primary CTAs) stays on `--apex-success`, the
          playback-rate read-out keeps cyan on `--apex-cyan-text`, and the
          NOT-SELECTED / NO-CLIP / LENGTH-NOT-PRESERVED qualifiers keep their
          warning amber on `--apex-gold`. The dead `bg-black/85` scrim is gone
          — ModalFrame supplies the shared themed `--apex-modal-overlay`.

          The auditioning state fill moves from a fixed `bg-white` to
          `--apex-text` with `--apex-state-playing-fg` on-colour, which keeps
          the high-contrast "preview is running" reading in both palettes
          (near-black on near-white in Dark, near-white on near-black in
          Light) instead of a white fill that stays white in Light. */}
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-success)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-warp-processor-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">AUDIO CLIP PITCH &amp; PLAYBACK RATE</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)]">
                  REPITCH — LENGTH NOT PRESERVED
                </span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)]">
                  WSOLA — PITCH-PRESERVING STRETCH
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">
                {targetClip ? `Editing "${targetClip.name}"` : 'No audio clip selected'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionWarp}
              disabled={!targetClip}
              className={`px-3 py-1 text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow disabled:opacity-40 ${
                isAuditioning ? 'bg-[var(--apex-text)]' : 'bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))]'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isAuditioning ? 'Previewing...' : 'Preview Clip'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close warp processor"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} aria-label="Dismiss status message" className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Target: the clip this tool will actually change. */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)]">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--apex-text)] font-bold uppercase tracking-wider">TARGET CLIP</span>
              {targetClip ? (
                <span className="text-[10px] font-mono text-[var(--apex-success)]">
                  {targetClip.name} · bar {targetClip.startBar} · {targetClip.lengthBars} bar{targetClip.lengthBars === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="text-[10px] font-mono text-[var(--apex-gold)]">NOTHING SELECTED</span>
              )}
            </div>
          </div>

          {!targetClip && (
            <div className="bg-[var(--apex-canvas)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] rounded-xl px-4 py-3">
              <span className="text-[11px] font-mono font-bold text-[var(--apex-gold)] uppercase tracking-wider block mb-1">
                NO AUDIO CLIP TO WARP
              </span>
              <span className="text-[11px] text-[var(--apex-text-2)]">{blocker}</span>
            </div>
          )}

          {/* What each processor does — the honest capability banner. */}
          <div className="bg-[var(--apex-canvas)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono font-bold text-[var(--apex-gold)] uppercase tracking-wider">
              REPITCH CHANGES PITCH AND LENGTH TOGETHER — WSOLA STRETCH PRESERVES PITCH
            </span>
            <span className="text-[10px] text-[var(--apex-text-3)] whitespace-nowrap">STRETCH COMMITS A NEW AUDIO ASSET · ORIGINAL KEPT FOR UNDO</span>
          </div>

          {/* Implemented controls */}
          <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)] space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[var(--apex-text)] uppercase">PITCH &amp; SPEED (APPLIED TO THIS CLIP)</span>
              <span className="text-[10px] font-mono text-[var(--apex-success)]">{WARP_BEHAVIOUR_SUMMARY}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {/* Pitch Shift */}
              <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--apex-text)] font-bold">PITCH OFFSET</span>
                  <span className="text-[var(--apex-success)] font-mono font-bold">{pitchSemitones > 0 ? `+${pitchSemitones}` : pitchSemitones} st</span>
                </div>
                <input
                  type="range"
                  min="-24"
                  max="24"
                  value={pitchSemitones}
                  disabled={!targetClip}
                  onChange={(e) => setPitchSemitones(Number(e.target.value))}
                  className="w-full accent-[var(--apex-success)] disabled:opacity-40"
                />
                <span className="text-[9px] text-[var(--apex-text-3)] block">Detunes the clip without changing its length.</span>
              </div>

              {/* Stretch Rate */}
              <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--apex-text)] font-bold">PLAYBACK RATE</span>
                  <span className="text-[var(--apex-cyan-text)] font-mono font-bold">{stretchRate.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0.25"
                  max="3.0"
                  step="0.05"
                  value={stretchRate}
                  disabled={!targetClip}
                  onChange={(e) => setStretchRate(Number(e.target.value))}
                  className="w-full accent-[var(--apex-cyan)] disabled:opacity-40"
                />
                <span className="text-[9px] text-[var(--apex-text-3)] block">
                  Speeds the clip up or slows it down. Pitch rides with the rate: slower is lower.
                </span>
              </div>
            </div>
          </div>

          {/* Phase 7A: pitch-preserving time stretch — WSOLA render & commit. */}
          <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[var(--apex-text)] uppercase flex items-center gap-1.5">
                <Waves className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                TIME STRETCH — PITCH PRESERVED (WSOLA)
              </span>
              <span className="text-[10px] font-mono text-[var(--apex-success)]">{STRETCH_BEHAVIOUR_SUMMARY}</span>
            </div>

            {/* Phase 7D: stretch strategy — an EXPLICIT user choice for every
                commit workflow below (manual ratio, fit to tempo, fit to
                musical length). Classic WSOLA stays the default and never
                claims transient handling; the transient-aware option states
                honestly what it improves and what it does not. */}
            <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1.5" role="group" aria-label="Stretch strategy">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--apex-text)] font-bold">STRETCH STRATEGY</span>
                <div className="flex items-center gap-1">
                  <button
                    id="fl-warp-stretch-strategy-wsola"
                    type="button"
                    aria-pressed={stretchStrategy === 'wsola'}
                    disabled={!targetClip || isCommittingStretch}
                    onClick={() => setStretchStrategy('wsola')}
                    className={`px-2.5 py-1 rounded text-[10px] font-bold border transition disabled:opacity-40 ${
                      stretchStrategy === 'wsola'
                        ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] border-[var(--apex-success)]'
                        : 'bg-[var(--apex-surface-2)] text-[var(--apex-text-2)] border-[var(--apex-border)] hover:text-[var(--apex-text)]'
                    }`}
                  >
                    CLASSIC WSOLA
                  </button>
                  <button
                    id="fl-warp-stretch-strategy-transient"
                    type="button"
                    aria-pressed={stretchStrategy === 'transient'}
                    disabled={!targetClip || isCommittingStretch}
                    onClick={() => setStretchStrategy('transient')}
                    className={`px-2.5 py-1 rounded text-[10px] font-bold border transition disabled:opacity-40 ${
                      stretchStrategy === 'transient'
                        ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] border-[var(--apex-success)]'
                        : 'bg-[var(--apex-surface-2)] text-[var(--apex-text-2)] border-[var(--apex-border)] hover:text-[var(--apex-text)]'
                    }`}
                  >
                    TRANSIENT-AWARE
                  </button>
                </div>
              </div>
              <span id="fl-warp-stretch-strategy-note" className="text-[9px] text-[var(--apex-text-3)] block">
                {stretchStrategy === 'wsola'
                  ? 'Classic WSOLA: best for tonal and sustained material. Attacks (drums, percussion) can smear — measured timing errors up to ~30 ms and audible pre-echo at some ratios. This mode does not anchor attacks and makes no transient-handling claim.'
                  : 'Transient-aware (TAW): anchors detected attacks so drum/percussion timing stays tight (measured ≤ ~7 ms worst-case on test loops vs ≤ ~69 ms classic) with far less pre-echo. Material with no detectable attacks renders identically to classic WSOLA. Attacks within ~23 ms of the clip start/end keep classic treatment.'}
              </span>
            </div>

            <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1.5 text-xs">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">STRETCH RATIO</span>
                <span className="text-[var(--apex-success)] font-mono font-bold">{wsolaRatio.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min="0.25"
                max="4.0"
                step="0.01"
                value={wsolaRatio}
                disabled={!targetClip || isCommittingStretch}
                onChange={(e) => setWsolaRatio(Number(e.target.value))}
                className="w-full accent-[var(--apex-success)] disabled:opacity-40"
              />
              <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
                <span className="text-[var(--apex-text-3)] whitespace-nowrap">
                  SUPPORTED {WSOLA_MIN_RATIO.toFixed(2)}×–{WSOLA_MAX_RATIO.toFixed(2)}×
                </span>
                <span className="text-[var(--apex-text-2)] text-right">
                  {targetClip
                    ? describeWarpStretchPlan(
                        targetClip,
                        wsolaRatio,
                        targetClip.audioBufferId ? audioEngine.getSampleBuffer(targetClip.audioBufferId) : undefined
                      )
                    : '—'}
                </span>
              </div>
              <span className="text-[9px] text-[var(--apex-text-3)] block">
                Renders new audio with the pitch preserved, then commits it as a new project asset.
                The original audio is kept — Undo restores the clip and its original reference.
                The Repitch controls above are not changed by this operation.
              </span>
            </div>

            <button
              onClick={handleCommitTimeStretch}
              disabled={!targetClip || isCommittingStretch}
              className="px-4 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] disabled:opacity-40 disabled:hover:bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow flex items-center gap-1.5 text-xs"
            >
              <Check className="w-4 h-4" />
              <span>{isCommittingStretch ? 'Rendering & Committing…' : 'Render & Commit Stretch'}</span>
            </button>

            {/* Phase 7B: Fit to Project Tempo — the same WSOLA commit, with the
                ratio derived from tempos instead of dialled by hand. */}
            <div className="border-t border-[var(--apex-border)] pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-[var(--apex-text)] uppercase tracking-wider">
                  FIT TO PROJECT TEMPO
                </span>
                <span className="text-[10px] font-mono text-[var(--apex-text-3)]">
                  ratio = source BPM ÷ project BPM
                </span>
              </div>

              <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <label htmlFor="fl-warp-fit-source-bpm" className="text-[var(--apex-text)] font-bold">
                      SOURCE BPM
                    </label>
                    <input
                      id="fl-warp-fit-source-bpm"
                      type="number"
                      min="1"
                      max="999"
                      step="0.01"
                      placeholder="e.g. 90"
                      value={sourceBpmText}
                      disabled={!targetClip || isCommittingStretch}
                      onChange={(e) => setSourceBpmText(e.target.value)}
                      className="w-24 px-2 py-1 rounded bg-[var(--apex-surface-2)] border border-[var(--apex-border)] text-[var(--apex-text)] font-mono text-xs disabled:opacity-40"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--apex-text)] font-bold">PROJECT BPM</span>
                    <span className="text-[var(--apex-success)] font-mono font-bold">{projectBpm.toFixed(2)} BPM</span>
                  </div>
                </div>

                <div className="text-[10px] font-mono">
                  {fitPreview.kind === 'empty' && (
                    <span className="text-[var(--apex-text-3)]">ENTER SOURCE BPM TO PREVIEW THE FIT</span>
                  )}
                  {fitPreview.kind === 'error' && (
                    <span className="text-[var(--apex-gold)]">{fitPreview.message}</span>
                  )}
                  {fitPreview.kind === 'ready' && (
                    <span className="text-[var(--apex-text-2)]">{fitPreview.plan}</span>
                  )}
                </div>

                <span className="text-[9px] text-[var(--apex-text-3)] block">
                  Enter the tempo the audio was recorded at — from its sample details, its origin project, or by
                  tapping it out. No beat detection is performed and nothing is guessed. The fit bakes the stretch
                  into a NEW audio asset: changing the project tempo later does not reprocess it. WSOLA can smear
                  transients — percussive material has a narrower quality envelope (best 0.5×–2.0×).
                </span>
              </div>

              <button
                onClick={handleCommitFitToTempo}
                disabled={!targetClip || isCommittingStretch}
                className="px-4 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] disabled:opacity-40 disabled:hover:bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow flex items-center gap-1.5 text-xs"
              >
                <Check className="w-4 h-4" />
                <span>{isCommittingStretch ? 'Rendering & Committing…' : 'Render & Commit Fit'}</span>
              </button>
            </div>

            {/* Phase 7C: Fit to Musical Length — a clearly distinct operation:
                the destination is an exact bars+beats length under the
                project's authoritative tempo and meter (both read from
                project state, never editable here, never assumed 4/4). */}
            <div className="border-t border-[var(--apex-border)] pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-[var(--apex-text)] uppercase tracking-wider">
                  FIT TO MUSICAL LENGTH
                </span>
                <span className="text-[10px] font-mono text-[var(--apex-text-3)]">
                  ratio = target seconds ÷ source seconds
                </span>
              </div>

              <div className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] space-y-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <label htmlFor="fl-warp-fit-length-bars" className="text-[var(--apex-text)] font-bold">
                      BARS
                    </label>
                    <input
                      id="fl-warp-fit-length-bars"
                      type="number"
                      min="0"
                      step="1"
                      placeholder="2"
                      value={fitLenBarsText}
                      disabled={!targetClip || isCommittingStretch}
                      onChange={(e) => setFitLenBarsText(e.target.value)}
                      className="w-20 px-2 py-1 rounded bg-[var(--apex-surface-2)] border border-[var(--apex-border)] text-[var(--apex-text)] font-mono text-xs disabled:opacity-40"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label htmlFor="fl-warp-fit-length-beats" className="text-[var(--apex-text)] font-bold">
                      BEATS
                    </label>
                    <input
                      id="fl-warp-fit-length-beats"
                      type="number"
                      min="0"
                      step="0.25"
                      placeholder="0"
                      value={fitLenBeatsText}
                      disabled={!targetClip || isCommittingStretch}
                      onChange={(e) => setFitLenBeatsText(e.target.value)}
                      className="w-20 px-2 py-1 rounded bg-[var(--apex-surface-2)] border border-[var(--apex-border)] text-[var(--apex-text)] font-mono text-xs disabled:opacity-40"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--apex-text)] font-bold">PROJECT</span>
                    <span id="fl-warp-fit-length-project-grid" className="text-[var(--apex-success)] font-mono font-bold">
                      {projectBpm.toFixed(2)} BPM · {fitResolvedMeter[0]}/{fitResolvedMeter[1]}
                    </span>
                  </div>
                </div>

                <div id="fl-warp-fit-length-preview" className="text-[10px] font-mono">
                  {fitLengthPreview.kind === 'no-clip' && (
                    <span className="text-[var(--apex-text-3)]">SELECT AN AUDIO CLIP TO PREVIEW THE FIT</span>
                  )}
                  {fitLengthPreview.kind === 'error' && (
                    <span className="text-[var(--apex-gold)]">{fitLengthPreview.message}</span>
                  )}
                  {fitLengthPreview.kind === 'no-source' && (
                    <span className="text-[var(--apex-text-2)]">
                      {fitLengthPreview.destination} · source audio not loaded — the ratio is computed from the real source at commit time
                    </span>
                  )}
                  {fitLengthPreview.kind === 'ready' && (
                    <span className="text-[var(--apex-text-2)]">{fitLengthPreview.plan}</span>
                  )}
                </div>

                <span className="text-[9px] text-[var(--apex-text-3)] block">
                  Stretches the clip's audio so it occupies EXACTLY the length entered — bars plus quarter-note beats
                  (beats stay below {fitMeterBeats}, one bar of {fitResolvedMeter[0]}/{fitResolvedMeter[1]}) — at the
                  project's tempo and meter. The clip's start position and fades are kept; the audio is baked into a
                  NEW asset, so changing the project tempo later does not reprocess it. The required ratio is never
                  silently clamped: clips with offsets, trims, detune or take groups, and fits outside the supported
                  WSOLA range, are refused honestly — never silently shifted.
                </span>
              </div>

              <button
                id="fl-warp-fit-length-commit"
                onClick={handleCommitFitToLength}
                disabled={!targetClip || isCommittingStretch}
                className="px-4 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] disabled:opacity-40 disabled:hover:bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow flex items-center gap-1.5 text-xs"
              >
                <Check className="w-4 h-4" />
                <span>{isCommittingStretch ? 'Rendering & Committing…' : 'Render & Commit Fit to Length'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">
            Applies to live playback and WAV export
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-surface-3)_85%,var(--apex-text))] text-[var(--apex-text)] font-bold rounded transition"
            >
              Cancel
            </button>
            <button
              onClick={handleApplyWarp}
              disabled={!targetClip || isCommittingStretch}
              className="px-4 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] disabled:opacity-40 disabled:hover:bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>Apply to Clip</span>
            </button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
};
