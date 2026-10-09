import React, { useState, useEffect, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import { Mic, Square, Pause, Play, Check, X, AlertCircle, Crosshair } from 'lucide-react';
import { AudioRecording } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { RecordingEngine } from '../audio/recordingEngine';
import { CountInCancelledError } from '../audio/countInScheduler';
import { PunchCancelledError } from '../audio/punchCaptureWindow';
import { planPunchClipPlacement, type PunchClipPlacement } from '../audio/recordingPipeline';
import { COUNT_IN_OPTIONS, describeCountInBars, isCountInBars, resolveCountInBars, type CountInBars } from '../music/countIn';
import { beatsPerBar, resolveProjectTimeSignature, type TimeSignature } from '../music/musicalTime';
import { resolveSevenEightGrouping } from '../music/meterPulse';
import {
  DEFAULT_PUNCH_RECORDING,
  describePunchWindow,
  displayedBeatsPerBar,
  formatPunchPosition,
  planPunchCapture,
  punchPositionFromTransport,
  resolvePunchRecording,
  validatePunchRecording,
  type PunchRecordingSettings,
} from '../music/punchRecording';
import { sessionBlobUrlRegistry } from '../state/sessionBlobUrlRegistry';

interface AudioRecorderModalProps {
  isOpen: boolean;
  projectGeneration: number;
  getCurrentProjectGeneration: () => number;
  /** Phase 1K: the persisted `ProjectMetadata.countInBars` (0 = Off, 1, 2). */
  countInBars: unknown;
  /** Persists a count-in setting change (project history + save). */
  onUpdateCountInBars: (bars: CountInBars) => void;
  /** Phase 1L: the persisted `ProjectMetadata.punchRecording` window. */
  punchRecording?: unknown;
  /** Phase 1L: persists a punch window change. Absent = punch UI unavailable. */
  onUpdatePunchRecording?: (settings: PunchRecordingSettings) => void;
  /** Phase 1L: project meter + grouping, so bar.beat means the transport's beats. */
  timeSignature?: unknown;
  sevenEightGrouping?: unknown;
  /** Phase 1L: arrangement length in bars — the take is truncated at this end. */
  totalBars?: number;
  /** Phase 1L: project tempo, for the punched duration readout. */
  bpm?: number;
  /** Phase 1L: transport position, for "at playhead". */
  currentBar?: number;
  currentStep?: number;
  onClose: () => void;
  onRegisterProjectReplacementHandler: (handler: () => Promise<void>) => void;
  /**
   * `captureStartBar` is the 0-based playlist bar audio capture began on after
   * the count-in (Phase 1K); the take must be placed there so playback lands
   * on the same musical position. Defaults to 0 (bar 1) when absent.
   *
   * Phase 1L: `punchPlacement` is supplied for a punch take. It carries the
   * exact punched geometry (fractional bar, fractional length, trim length) and
   * is then the placement authority; `captureStartBar` stays a display value.
   */
  onSaveRecording: (recording: AudioRecording, targetTrackIndex: number, projectGeneration: number, captureStartBar?: number, punchPlacement?: PunchClipPlacement) => void | Promise<void>;
}

type RecorderUiState = 'idle' | 'counting-in' | 'recording' | 'paused' | 'stopping';

export const AudioRecorderModal: React.FC<AudioRecorderModalProps> = ({ isOpen, projectGeneration, getCurrentProjectGeneration, countInBars, onUpdateCountInBars, punchRecording, onUpdatePunchRecording, timeSignature, sevenEightGrouping, totalBars, bpm, currentBar, currentStep, onClose, onRegisterProjectReplacementHandler, onSaveRecording }) => {
  const [recordingState, setRecordingState] = useState<RecorderUiState>('idle');
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [targetTrack, setTargetTrack] = useState(4);
  const [recordedTake, setRecordedTake] = useState<AudioRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  /** Phase 1K: the musical bar capture began on (0-based playlist bar). */
  const [captureStartBar, setCaptureStartBar] = useState(0);
  /**
   * Phase 1L: the punch window being edited, seeded from the stored setting so
   * the first paint already shows the project's window (a lazy initializer, not
   * an effect — an effect would render the disabled default first). Published
   * back to the project only once the edited window is valid.
   */
  const [punchDraft, setPunchDraft] = useState<PunchRecordingSettings>(
    () => resolvePunchRecording({ punchRecording })
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<RecordingEngine | null>(null);
  const recordingProjectGenerationRef = useRef(projectGeneration);
  const recordedTakeRef = useRef<AudioRecording | null>(null);
  /** Phase 1L: the placement of the take being captured, when punching. */
  const punchPlacementRef = useRef<PunchClipPlacement | null>(null);
  /** Phase 1L: a double-pressed Record must never arm a second recorder. */
  const isStartingRef = useRef(false);

  // Phase 1L: bar.beat of the punch window follows the transport readout, so it
  // needs the resolved meter and 7/8 grouping rather than a fixed 4-beat bar.
  const meter: TimeSignature = resolveProjectTimeSignature({ timeSignature });
  const grouping = resolveSevenEightGrouping({ sevenEightGrouping });
  const punchContext = {
    meter,
    grouping,
    totalBars: Number.isFinite(totalBars) && (totalBars as number) > 0 ? (totalBars as number) : 0,
  };
  const punchValidation = validatePunchRecording(punchDraft, punchContext);
  const punchPlan = punchValidation.valid && punchValidation.range
    ? planPunchCapture({
        settings: punchDraft,
        meter,
        grouping,
        totalBars: punchContext.totalBars,
        countInBars: resolveCountInBars({ countInBars }),
        bpm: Number.isFinite(bpm) && (bpm as number) > 0 ? (bpm as number) : 120,
      })
    : null;
  const maxBeat = displayedBeatsPerBar({ meter, grouping });
  const punchedBars = punchValidation.range
    ? Math.max(1, Math.min(32, Math.round((punchValidation.range.outBeats - punchValidation.range.inBeats) / (beatsPerBar(meter) || 1))))
    : 0;

  useEffect(() => {
    if (!engineRef.current) engineRef.current = new RecordingEngine(() => audioEngine.getContext(), { onError: error => setError(error.message) });
    return () => {
      // Effect cleanups must be synchronous; dispose() is async and any failure is already reported via onError.
      void engineRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    recordingProjectGenerationRef.current = projectGeneration;
  }, [projectGeneration]);

  useEffect(() => {
    recordedTakeRef.current = recordedTake;
  }, [recordedTake]);

  // Phase 1L: opening the modal (or replacing the project) reloads the stored
  // window. It is deliberately NOT re-synced on every prop change — a value the
  // user is mid-edit on must not be overwritten by the stored one.
  useEffect(() => {
    if (isOpen) setPunchDraft(resolvePunchRecording({ punchRecording }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, projectGeneration]);

  const cancelForProjectReplacement = React.useCallback(async () => {
    // Phase 1K: abort any count-in first — its pending promise rejects with
    // CountInCancelledError and the start flow below never reaches capture.
    audioEngine.cancelRecordingCountIn();
    // Phase 1L: an armed punch take goes with it (pre-roll silenced, punch-out
    // moment cleared, capture cancelled) — a replaced project has no window.
    audioEngine.cancelPunchRecording();
    punchPlacementRef.current = null;
    const cancellation = engineRef.current?.cancel();
    if (cancellation) await cancellation.catch(() => undefined);
    const take = recordedTakeRef.current;
    if (take?.audioUrl) sessionBlobUrlRegistry.release(take.audioUrl);
    recordedTakeRef.current = null;
    setRecordedTake(null);
    setRecordingState('idle');
    setRecordSeconds(0);
    setInputLevel(0);
    setIsApplying(false);
    isStartingRef.current = false;
    onClose();
  }, [onClose]);

  useEffect(() => {
    onRegisterProjectReplacementHandler(cancelForProjectReplacement);
  }, [cancelForProjectReplacement, onRegisterProjectReplacementHandler]);

  useEffect(() => {
    if (!isOpen) return;
    let animationId = 0;
    const update = () => {
      const engine = engineRef.current;
      if (engine) {
        const peak = engine.getPeak();
        setInputLevel(peak);
        if (engine.getState() === 'recording' || engine.getState() === 'paused') setRecordSeconds(engine.getDurationSeconds());
        const canvas = canvasRef.current;
        if (canvas) {
          const context = canvas.getContext('2d');
          if (context) {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#0a0a0b';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.strokeStyle = '#ff6e00';
            context.lineWidth = 2;
            context.beginPath();
            const mid = canvas.height / 2;
            const amplitude = Math.max(1, peak * mid * 0.9);
            context.moveTo(0, mid);
            for (let x = 0; x < canvas.width; x += 4) {
              const y = mid + Math.sin(x * 0.18) * amplitude * (0.35 + 0.65 * Math.abs(Math.sin(x * 0.031)));
              context.lineTo(x, y);
            }
            context.stroke();
          }
        }
      }
      animationId = requestAnimationFrame(update);
    };
    animationId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      // Phase 1K: closing during a count-in aborts it before capture — no
      // clicks can end up inside a take that never should have started.
      audioEngine.cancelRecordingCountIn();
      // Phase 1L: closing mid-take abandons the punch window too, so no
      // scheduled punch-out can stop a recorder that no longer exists.
      audioEngine.cancelPunchRecording();
      punchPlacementRef.current = null;
      // Cancellation is intentionally rejected by RecordingEngine so callers can
      // distinguish it from a successful recording. Modal teardown is an expected
      // cancellation path, so consume that rejection here to avoid an unhandled
      // promise when the modal is closed while capture is active.
      const cancellation = engineRef.current?.cancel();
      if (cancellation) void cancellation.catch(() => undefined);
      setRecordingState('idle');
      setRecordSeconds(0);
      setInputLevel(0);
      setError(null);
      if (recordedTake?.audioUrl) sessionBlobUrlRegistry.release(recordedTake.audioUrl);
      setRecordedTake(null);
      setIsApplying(false);
      isStartingRef.current = false;
    }
  }, [isOpen]);

  /** Finalizes the active capture into a take (Stop button and punch-out). */
  const handleStop = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      setError(null);
      setRecordingState('stopping');
      const result = await engine.stop();
      const recording: AudioRecording = { id: result.id, name: result.name, timestamp: result.timestamp, durationSeconds: result.durationSeconds, audioBlob: result.blob, audioUrl: result.url, waveform: result.waveform };
      setRecordedTake(recording);
      setRecordingState('idle');
      setRecordSeconds(result.durationSeconds);
    } catch (err) {
      setRecordingState('idle');
      setError(err instanceof Error ? err.message : 'Unable to stop audio recording');
    }
  };

  /**
   * Phase 1K: count-in first, capture second.
   *
   * When the count-in is 1 or 2 bars, `audioEngine.beginRecordingCountIn`
   * clicks the active meter's pulses at the project tempo (including the 7/8
   * accent grouping) and resolves exactly at the planned capture moment.
   * `RecordingEngine.start()` — the only path that opens the microphone and
   * MediaRecorder — runs strictly AFTER that, which is what prevents count-in
   * clicks from being recorded as audio. No note/step data is ever written by
   * the count-in, so nothing can be "recorded as notes" either. The resolved
   * `clipStartBar` is kept so the take is placed at the bar capture began on.
   *
   * Phase 1L: with punch on, the SAME count-in runs as the pre-roll (planned
   * backwards so its capture moment IS the punch-in), capture then starts, and
   * the scheduled punch-out stops it. With punch off this is byte-for-byte the
   * Phase 1K path.
   */
  const handleStart = async () => {
    // A double-pressed Record must never arm a second recorder.
    if (isStartingRef.current || recordingState !== 'idle' || recordedTake) return;
    isStartingRef.current = true;
    try {
      setError(null);
      setRecordedTake(null);
      punchPlacementRef.current = null;
      recordingProjectGenerationRef.current = projectGeneration;
      const bars = resolveCountInBars({ countInBars });

      if (punchDraft.enabled) {
        // Phase 1L: a punch take refuses to arm an invalid window — recording
        // the wrong bars is worse than not recording.
        if (!punchValidation.valid) {
          setError(punchValidation.issues[0]?.message ?? 'The punch window is not valid');
          return;
        }
        setRecordingState('counting-in');
        const session = await audioEngine.beginPunchRecording({
          settings: punchDraft,
          countInBars: bars,
          totalBars: punchContext.totalBars,
        });
        if (recordingProjectGenerationRef.current !== getCurrentProjectGeneration()) {
          audioEngine.cancelPunchRecording();
          throw new Error('The recording was cancelled because the project was replaced');
        }
        punchPlacementRef.current = planPunchClipPlacement(session.plan);
        setCaptureStartBar(session.plan.clipStartBar);
        await engineRef.current!.start();
        if (recordingProjectGenerationRef.current !== getCurrentProjectGeneration()) {
          audioEngine.cancelPunchRecording();
          await engineRef.current!.cancel().catch(() => undefined);
          throw new Error('The recording was cancelled because the project was replaced');
        }
        setRecordingState('recording');
        // The punch-out moment owns the take's end: capture stops there without
        // the user pressing Stop. An abort (stop / pause / seek / meter change /
        // close / project replacement) discards the take instead of leaving a
        // truncated one on the playlist.
        void session.punchOut.then(() => {
          void handleStop();
        }, (punchError: unknown) => {
          if (punchError instanceof PunchCancelledError) {
            void engineRef.current?.cancel().catch(() => undefined);
            punchPlacementRef.current = null;
            setRecordingState('idle');
            setRecordSeconds(0);
            return;
          }
          setError(punchError instanceof Error ? punchError.message : 'The punch recording failed');
        });
        return;
      }

      if (bars > 0) {
        setRecordingState('counting-in');
        const countIn = await audioEngine.beginRecordingCountIn(bars);
        if (recordingProjectGenerationRef.current !== getCurrentProjectGeneration()) {
          throw new Error('The recording was cancelled because the project was replaced');
        }
        setCaptureStartBar(countIn.clipStartBar);
      } else {
        setCaptureStartBar(0);
      }
      await engineRef.current!.start();
      if (recordingProjectGenerationRef.current !== getCurrentProjectGeneration()) {
        await engineRef.current!.cancel().catch(() => undefined);
        throw new Error('The recording was cancelled because the project was replaced');
      }
      setRecordingState('recording');
    } catch (err) {
      setRecordingState('idle');
      if (err instanceof CountInCancelledError) {
        // A deliberate abort (Stop, close, seek, project replacement): no take
        // exists and the count-in clicks were silenced. Nothing to report.
        return;
      }
      if (err instanceof PunchCancelledError) {
        // Phase 1L: the same rule for an aborted punch pre-roll.
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to start audio recording');
    } finally {
      isStartingRef.current = false;
    }
  };

  /** Phase 1K: aborts an in-progress count-in without capturing anything. */
  const handleCancelCountIn = () => {
    audioEngine.cancelRecordingCountIn();
    // Phase 1L: cancelling the pre-roll of a punch take abandons the take.
    audioEngine.cancelPunchRecording();
  };

  const handlePauseResume = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (recordingState === 'recording') {
      engine.pause();
      setRecordingState('paused');
    } else if (recordingState === 'paused') {
      engine.resume();
      setRecordingState('recording');
    }
  };

  /** Phase 1L: edits the window locally and publishes it once it is valid. */
  const applyPunchDraft = (next: PunchRecordingSettings) => {
    setPunchDraft(next);
    if (validatePunchRecording(next, punchContext).valid) onUpdatePunchRecording?.(next);
  };

  const applyPunchEndpoint = (endpoint: 'in' | 'out', bar: number, beat: number) => {
    applyPunchDraft(endpoint === 'in'
      ? { ...punchDraft, inBar: bar, inBeat: beat }
      : { ...punchDraft, outBar: bar, outBeat: beat });
  };

  /** Phase 1L: "at playhead" uses the transport's own bar.beat convention. */
  const setPunchEndpointAtPlayhead = (endpoint: 'in' | 'out') => {
    const position = punchPositionFromTransport(currentBar ?? 1, currentStep ?? 0, { meter, grouping });
    applyPunchEndpoint(endpoint, position.bar, position.beat);
  };

  const handleApplyToPlaylist = async () => {
    if (!recordedTake || isApplying) return;
    try {
      setError(null);
      setIsApplying(true);
      // Phase 1K: the take is placed at the bar capture actually began on
      // (after the count-in), not blindly on bar 1.
      // Phase 1L: a punch take hands over its exact punched geometry instead.
      await onSaveRecording(recordedTake, targetTrack, recordingProjectGenerationRef.current, captureStartBar, punchPlacementRef.current ?? undefined);
      // Ownership was transferred to the project by onSaveRecording.
      setRecordedTake(null);
      punchPlacementRef.current = null;
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to place recording on the playlist');
      setIsApplying(false);
    }
  };

  const formatTime = (secs: number) => {
    const safe = Math.max(0, Math.floor(secs));
    const mins = Math.floor(safe / 60);
    const seconds = safe % 60;
    return `${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  if (!isOpen) return null;

  const statusLabel = recordingState === 'counting-in'
    ? (punchDraft.enabled ? 'COUNT-IN → PUNCH' : 'COUNT-IN')
    : recordingState === 'recording' && punchDraft.enabled
      ? 'PUNCH RECORDING'
      : recordingState.toUpperCase();

  return (
    <ModalFrame id="audio-recorder-modal" labelledBy="audio-recorder-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden text-[#b0b0b0]">
        <div className="px-5 py-3.5 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between">
          <div className="flex items-center space-x-2.5"><div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center"><Mic className="w-4 h-4 text-[#ff6e00]" /></div><div><h3 id="audio-recorder-modal-title" className="font-bold text-sm text-white tracking-tight">AUDIO RECORDER</h3><p className="text-[10px] text-[#777]">Real microphone / line-in capture</p></div></div>
          <button onClick={onClose} aria-label="Close audio recorder" disabled={recordingState === 'stopping' || isApplying} className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-[#0a0a0b] border border-[#333336] rounded-lg p-4 flex flex-col items-center justify-center space-y-2">
            <div className="text-2xl font-mono font-bold text-white flex items-center gap-2">{(recordingState === 'recording' || recordingState === 'paused') && <div className="w-3 h-3 bg-[#ff0000] rounded-full animate-pulse" />}<span>{formatTime(recordSeconds)}</span></div>
            <canvas ref={canvasRef} width={360} height={50} className="w-full h-12 bg-[#121214] rounded border border-[#222225]" />
            <div className="w-full flex items-center justify-between text-[10px] text-[#777] font-mono"><span>INPUT PEAK: {Math.round(inputLevel * 100)}%</span><span data-recorder-status={statusLabel} className={(recordingState === 'recording' || recordingState === 'paused' || recordingState === 'counting-in') ? 'text-[#ff6e00] font-bold' : ''}>STATUS: {statusLabel}</span></div>
          </div>
          {error && <div className="flex items-start gap-2 p-3 bg-red-950/30 border border-red-800/50 rounded-lg text-xs text-red-200"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span></div>}
          {/* Phase 1K: recording count-in setting — Off / 1 bar / 2 bars. The
              choice is persisted with the project and shared with the engine:
              the count-in clicks the active meter's pulses at project tempo. */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-[#777] font-bold uppercase tracking-wider">Count-in</span>
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Recording count-in length">
              {COUNT_IN_OPTIONS.map(option => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={resolveCountInBars({ countInBars }) === option}
                  disabled={recordingState !== 'idle' || isApplying}
                  onClick={() => onUpdateCountInBars(option)}
                  className={`px-2.5 py-1 rounded text-[10px] font-bold transition border disabled:opacity-40 ${
                    resolveCountInBars({ countInBars }) === option
                      ? 'bg-[#ff6e00] text-black border-[#ff6e00]'
                      : 'bg-[#1a1a1d] text-[#b0b0b0] border-[#333336] hover:border-[#ff6e00]'
                  }`}
                  data-count-in={option}
                >
                  {describeCountInBars(option)}
                </button>
              ))}
            </div>
          </div>
          {/* Phase 1L: punch-in / punch-out recording. The window is bar/beat
              anchored (the transport readout's notation) and is the pre-roll's
              target: capture starts at punch-in and stops at punch-out. */}
          {onUpdatePunchRecording && (
            <div className="rounded-lg border border-[#333336] bg-[#101012] p-3 space-y-2.5" data-testid="audio-recorder-punch">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] text-[#777] font-bold uppercase tracking-wider">
                  <Crosshair className="w-3.5 h-3.5" />Punch recording
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={punchDraft.enabled}
                  aria-label="Enable punch recording"
                  disabled={recordingState !== 'idle' || isApplying}
                  onClick={() => applyPunchDraft({ ...punchDraft, enabled: !punchDraft.enabled })}
                  data-punch-enabled={punchDraft.enabled}
                  className={`px-2.5 py-1 rounded text-[10px] font-bold transition border disabled:opacity-40 ${
                    punchDraft.enabled
                      ? 'bg-[#ff6e00] text-black border-[#ff6e00]'
                      : 'bg-[#1a1a1d] text-[#b0b0b0] border-[#333336] hover:border-[#ff6e00]'
                  }`}
                >
                  {punchDraft.enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {punchDraft.enabled ? (
                <>
                  {(['in', 'out'] as const).map(endpoint => (
                    <div key={endpoint} className="flex items-center gap-1.5" data-punch-endpoint={endpoint}>
                      <span className="text-[10px] text-[#777] w-12 uppercase tracking-wider">{endpoint}</span>
                      <label className="flex items-center gap-1 text-[10px] text-[#777]">
                        BAR
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={endpoint === 'in' ? punchDraft.inBar : punchDraft.outBar}
                          disabled={recordingState !== 'idle' || isApplying}
                          aria-label={`Punch-${endpoint} bar`}
                          onChange={event => applyPunchEndpoint(
                            endpoint,
                            Math.max(1, Math.floor(Number(event.target.value)) || 1),
                            endpoint === 'in' ? punchDraft.inBeat : punchDraft.outBeat
                          )}
                          className="w-14 bg-[#121214] text-white text-xs px-1.5 py-1 rounded border border-[#333336] focus:outline-none disabled:opacity-50 font-mono"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-[10px] text-[#777]">
                        BEAT
                        <input
                          type="number"
                          min={1}
                          max={maxBeat}
                          step={1}
                          value={endpoint === 'in' ? punchDraft.inBeat : punchDraft.outBeat}
                          disabled={recordingState !== 'idle' || isApplying}
                          aria-label={`Punch-${endpoint} beat`}
                          onChange={event => applyPunchEndpoint(
                            endpoint,
                            endpoint === 'in' ? punchDraft.inBar : punchDraft.outBar,
                            Math.max(1, Math.floor(Number(event.target.value)) || 1)
                          )}
                          className="w-12 bg-[#121214] text-white text-xs px-1.5 py-1 rounded border border-[#333336] focus:outline-none disabled:opacity-50 font-mono"
                        />
                      </label>
                      <span className="text-[10px] font-mono text-[#ff6e00]" data-punch-position={endpoint}>
                        {formatPunchPosition(endpoint === 'in'
                          ? { bar: punchDraft.inBar, beat: punchDraft.inBeat }
                          : { bar: punchDraft.outBar, beat: punchDraft.outBeat })}
                      </span>
                      <button
                        type="button"
                        disabled={recordingState !== 'idle' || isApplying}
                        onClick={() => setPunchEndpointAtPlayhead(endpoint)}
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-[#333336] bg-[#1a1a1d] hover:border-[#ff6e00] transition disabled:opacity-40"
                      >
                        PLAYHEAD
                      </button>
                    </div>
                  ))}
                  {/* The selected range, always visible while punch is on: one
                      cell per punched bar, so the length is readable at a glance. */}
                  {punchValidation.range && (
                    <div
                      className="flex items-stretch h-6 bg-[#0a0a0b] rounded overflow-hidden border border-[#222225]"
                      data-punch-range-preview
                      data-punch-bars={punchedBars}
                      aria-hidden="true"
                    >
                      {Array.from({ length: punchedBars }).map((_, index) => (
                        <div key={index} className="flex-1 h-full bg-[#ff6e00]/35 border-r border-[#ff6e00]/25 last:border-r-0" />
                      ))}
                    </div>
                  )}
                  <div className="text-[10px] font-mono text-[#b0b0b0] space-y-1">
                    <div data-punch-summary>{punchPlan ? describePunchWindow(punchPlan) : 'Set a valid punch range'}</div>
                    <div className="text-[#777]" data-punch-preroll>
                      {resolveCountInBars({ countInBars }) > 0
                        ? `Pre-roll: ${describeCountInBars(resolveCountInBars({ countInBars }))} of clicks before punch-in — never recorded.`
                        : 'Pre-roll: off — capture starts immediately at punch-in.'}
                    </div>
                  </div>
                  {punchValidation.issues.map(issue => (
                    <p key={issue.message} role="alert" className="text-[10px] text-red-300" data-punch-issue={issue.field}>{issue.message}</p>
                  ))}
                  {punchValidation.valid && punchValidation.warnings.map(warning => (
                    <p key={warning.message} className="text-[10px] text-[#d97706]" data-punch-warning={warning.field}>{warning.message}</p>
                  ))}
                  {punchPlan?.truncatedAtProjectEnd && (
                    <p className="text-[10px] text-[#d97706]" data-punch-truncated>The take stops at the end of the arrangement.</p>
                  )}
                  {punchPlan?.preRollBeforeTimeline && (
                    <p className="text-[10px] text-[#777]" data-punch-preroll-early>
                      Punch-in is closer to bar 1 than the count-in is long: the pre-roll starts before the arrangement and capture still begins at punch-in.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[10px] text-[#777]">Off — recording runs until you press Stop, exactly as before.</p>
              )}
            </div>
          )}
          <div className="flex items-center justify-center gap-3">
            {recordingState === 'idle' && !recordedTake && <button onClick={handleStart} className="flex items-center gap-2 px-6 py-2.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-sm rounded shadow-lg transition active:scale-95"><div className="w-3 h-3 bg-black rounded-full" />{punchDraft.enabled ? 'PUNCH RECORD' : 'START RECORDING'}</button>}
            {recordingState === 'counting-in' && <><span className="text-xs text-[#ff6e00] font-bold font-mono">COUNT-IN · {describeCountInBars(resolveCountInBars({ countInBars }))}</span><button onClick={handleCancelCountIn} className="flex items-center gap-2 px-5 py-2.5 bg-[#222225] hover:bg-[#2d2d30] text-white font-bold text-sm rounded border border-[#333336] transition"><X className="w-4 h-4" />CANCEL</button></>}
            {(recordingState === 'recording' || recordingState === 'paused') && <><button onClick={handlePauseResume} disabled={punchDraft.enabled} className="flex items-center gap-2 px-5 py-2.5 bg-[#222225] hover:bg-[#2d2d30] text-white font-bold text-sm rounded border border-[#333336] transition disabled:opacity-40" title={punchDraft.enabled ? 'A punch take has a fixed length and cannot be paused' : undefined}>{recordingState === 'recording' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}{recordingState === 'recording' ? 'PAUSE' : 'RESUME'}</button><button onClick={handleStop} className="flex items-center gap-2 px-6 py-2.5 bg-[#ff0000] hover:bg-red-600 text-white font-bold text-sm rounded shadow-lg transition active:scale-95"><Square className="w-4 h-4 fill-current" />STOP & SAVE</button></>}
            {recordingState === 'stopping' && <span className="text-xs text-[#777]">Finalizing recording…</span>}
          </div>
          {recordedTake && <div className="p-3 bg-[#1a1a1d] border border-[#ff6e00]/50 rounded-lg space-y-3">
            <div className="flex items-center justify-between text-xs"><span className="font-bold text-white">RECORDED TAKE</span><span className="text-[#ff6e00] font-mono font-bold">{recordedTake.durationSeconds.toFixed(2)}s</span></div>
            {punchPlacementRef.current && (
              <div className="text-[10px] font-mono text-[#b0b0b0]" data-punch-take-placement>
                PUNCH TAKE · starts at bar {(punchPlacementRef.current.startBar + 1).toFixed(2)} · {punchPlacementRef.current.lengthBars.toFixed(2)} bars long
              </div>
            )}
            <div className="flex items-center justify-between text-xs"><span className="text-[#777]">Insert onto Track Lane:</span><select value={targetTrack} onChange={e => setTargetTrack(Number(e.target.value))} disabled={isApplying} className="bg-[#121214] text-white text-xs px-2.5 py-1 rounded border border-[#333336] focus:outline-none disabled:opacity-50"><option value={0}>Track 1 (Drums)</option><option value={1}>Track 2 (Bass)</option><option value={2}>Track 3 (Synths)</option><option value={3}>Track 4 (Melody)</option><option value={4}>Track 5 (Lead Vocals)</option><option value={5}>Track 6 (Backing Vocals)</option></select></div>
            <div className="h-8 flex items-end gap-px bg-[#0a0a0b] rounded px-1 overflow-hidden">{recordedTake.waveform.slice(0, 128).map((value, index) => <div key={index} className="flex-1 bg-[#ff6e00]" style={{ height: `${Math.max(2, value * 100)}%` }} />)}</div>
            <button onClick={handleApplyToPlaylist} disabled={isApplying} className="w-full py-2 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-wait"><Check className="w-4 h-4" />{isApplying ? 'PLACING TAKE…' : 'PLACE TAKE ON PLAYLIST'}</button>
          </div>}
        </div>
      </div>
    </ModalFrame>
  );
};
