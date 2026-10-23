import React, { useState, useEffect } from 'react';
import { ModalFrame } from './ModalFrame';
import {
  X,
  Sparkles,
  ArrowRight,
  Play,
  Check,
  Zap
} from 'lucide-react';
import { MixerTrack, SidechainMode, SidechainSettings } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import {
  DEFAULT_SIDECHAIN_SETTINGS,
  SIDECHAIN_LIMITS,
  amountToMaxReductionDb,
  normalizeSidechainSettings,
  resolveSidechainMode,
} from '../audio/sidechainCompression';

interface SidechainRoutingModalProps {
  isOpen: boolean;
  onClose: () => void;
  mixerTracks: MixerTrack[];
  onUpdateMixerTracks: (tracks: MixerTrack[]) => void;
}

export const SidechainRoutingModal: React.FC<SidechainRoutingModalProps> = ({
  isOpen,
  onClose,
  mixerTracks,
  onUpdateMixerTracks
}) => {
  const [selectedDestTrackId, setSelectedDestTrackId] = useState<number>(2); // e.g. Bass track #2
  const [sourceTrackId, setSourceTrackId] = useState<number>(1); // e.g. Kick track #1
  const [isEnabled, setIsEnabled] = useState<boolean>(true);
  /**
   * Phase 9A — the two real modes. `note-trigger` is the legacy envelope;
   * `level-detected` is the AudioWorklet detector whose threshold/ratio controls
   * below are wired to the DSP. The mode is persisted on the track and restored
   * here, so the panel always edits the route it is showing.
   */
  const [sidechainMode, setSidechainMode] = useState<SidechainMode>(DEFAULT_SIDECHAIN_SETTINGS.mode);
  const [thresholdDb, setThresholdDb] = useState<number>(DEFAULT_SIDECHAIN_SETTINGS.thresholdDb);
  const [ratio, setRatio] = useState<number>(DEFAULT_SIDECHAIN_SETTINGS.ratio);
  const [duckAmount, setDuckAmount] = useState<number>(0.85);
  const [attackMs, setAttackMs] = useState<number>(5);
  const [releaseMs, setReleaseMs] = useState<number>(120);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  /**
   * Measured gain reduction (dB) reported by the audio thread. This is a real
   * measurement from the attached detector — there is no timer and no synthesised
   * pulse. When no detector is attached the meter is not shown at all, rather
   * than animating something that is not being applied.
   */
  const [measuredReductionDb, setMeasuredReductionDb] = useState<number>(0);
  const [detectorAttached, setDetectorAttached] = useState<boolean>(false);

  // Hydrate the controls from the destination track's stored route.
  useEffect(() => {
    if (!isOpen) return;
    const track = mixerTracks.find(t => t.id === selectedDestTrackId);
    const stored = normalizeSidechainSettings(track?.sidechain);
    setIsEnabled(stored?.enabled ?? true);
    setSourceTrackId(stored?.sourceTrackId ?? DEFAULT_SIDECHAIN_SETTINGS.sourceTrackId);
    setSidechainMode(resolveSidechainMode(stored));
    setThresholdDb(stored?.thresholdDb ?? DEFAULT_SIDECHAIN_SETTINGS.thresholdDb);
    setRatio(stored?.ratio ?? DEFAULT_SIDECHAIN_SETTINGS.ratio);
    setDuckAmount(stored?.amount ?? 0.85);
    setAttackMs(stored?.attackMs ?? 5);
    setReleaseMs(stored?.releaseMs ?? 120);
  }, [isOpen, selectedDestTrackId]);

  // Real meter: event-driven from the detector's measured envelope.
  useEffect(() => {
    if (!isOpen) return;
    setDetectorAttached(audioEngine.hasSidechainDetector(selectedDestTrackId));
    setMeasuredReductionDb(audioEngine.getSidechainReductionDb(selectedDestTrackId));
    return audioEngine.onSidechainReduction(snapshot => {
      if (snapshot.trackId !== selectedDestTrackId) return;
      setDetectorAttached(audioEngine.hasSidechainDetector(selectedDestTrackId));
      setMeasuredReductionDb(snapshot.reductionDb);
    });
  }, [isOpen, selectedDestTrackId]);

  if (!isOpen) return null;

  const destTrack = mixerTracks.find(t => t.id === selectedDestTrackId) || mixerTracks[1] || mixerTracks[0];
  const sourceTrack = mixerTracks.find(t => t.id === sourceTrackId) || mixerTracks[0];
  const maxReductionDb = amountToMaxReductionDb(duckAmount);
  const isLevelDetected = sidechainMode === 'level-detected';

  const handleApplyRouting = () => {
    const updated = mixerTracks.map(t => {
      if (t.id === selectedDestTrackId) {
        // Phase 9A: emit the complete route the engine consumes. The legacy
        // threshold/lowFreqOnly/highPassFilterHz ghosts stay out of the payload.
        const sidechain: SidechainSettings = {
          enabled: isEnabled,
          sourceTrackId,
          amount: duckAmount,
          attackMs,
          releaseMs,
          mode: sidechainMode,
          thresholdDb,
          ratio,
        };
        return { ...t, sidechain };
      }
      return t;
    });

    onUpdateMixerTracks(updated);
    // Push the same route into the live graph immediately, so the meter and the
    // audio reflect the change without waiting for the next project publication.
    const updatedDest = updated.find(t => t.id === selectedDestTrackId);
    if (updatedDest) audioEngine.updateMixerTrack(updatedDest);
    setStatusMessage(
      `Applied ${isLevelDetected ? 'level-detected' : 'note-triggered'} sidechain ducking to ${destTrack.name} (Source: ${sourceTrack.name})`
    );
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleAuditionPump = () => {
    // In level-detected mode the source track is the signal that drives the
    // detector, so the audition plays the source. In legacy mode the note on the
    // destination is what fires the envelope, exactly as before.
    const auditionTrackId = isLevelDetected ? sourceTrackId : selectedDestTrackId;
    audioEngine.playNote(
      {
        id: 'sidechain-audition',
        name: 'Pump Bass',
        instrumentType: 'sub_808',
        volume: 0.85,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        color: '#ff6e00',
        mixerTrackId: auditionTrackId,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `sc-pump-${Date.now()}`, pitch: 36, start: 0, duration: 2, velocity: 0.9 }
    );
    setStatusMessage(
      isLevelDetected
        ? 'Auditioning Source Hit (level detector drives the ducking gain)...'
        : 'Auditioning Sidechain Ducking Envelope...'
    );
    setTimeout(() => setStatusMessage(null), 2000);
  };

  return (
    <ModalFrame id="fl-sidechain-routing-modal" labelledBy="fl-sidechain-routing-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-gold)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-sidechain-routing-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">DYNAMIC SIDECHAIN DUCKING &amp; MODULATION MATRIX</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)]">
                  {isLevelDetected ? 'LEVEL DETECTOR DSP' : 'NOTE-TRIGGER DSP'}
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Duck one mixer track from another track's real audio level, or with the legacy note-triggered envelope</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionPump}
              className="px-3 py-1 bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_86%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isLevelDetected ? 'Audition Source Hit' : 'Audition Pump'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close sidechain routing"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[var(--apex-gold)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} aria-label="Dismiss status message" className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Signal Routing Flow Card */}
          <div className="bg-[var(--apex-canvas)] p-4 rounded-xl border border-[var(--apex-border)] flex flex-col md:flex-row items-center justify-between gap-4">
            {/* Source Track Selection */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] flex-1 w-full space-y-1.5">
              <span className="text-[10px] text-[var(--apex-gold)] font-bold block uppercase tracking-wider">SIDECHAIN TRIGGER SOURCE</span>
              <select
                value={sourceTrackId}
                onChange={(e) => setSourceTrackId(Number(e.target.value))}
                className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs p-2 rounded border border-[var(--apex-border)] font-bold"
              >
                {mixerTracks.map(m => (
                  <option key={m.id} value={m.id}>Track #{m.id}: {m.name}</option>
                ))}
              </select>
              <span className="text-[9px] text-[var(--apex-text-3)] block">
                {isLevelDetected
                  ? 'This track\'s audio level (post-fader) drives the ducking gain'
                  : 'Notes on this track trigger the fixed ducking envelope'}
              </span>
            </div>

            {/* Meter — measured by the audio thread when a detector is attached. */}
            <div className="flex flex-col items-center justify-center gap-1 px-2">
              <div className="flex items-center gap-2">
                <ArrowRight className="w-5 h-5 text-[var(--apex-gold)]" />
              </div>
              <div className="text-[9px] font-mono text-[var(--apex-gold)] font-bold" data-testid="sidechain-measured-reduction">
                {isLevelDetected
                  ? (detectorAttached ? `measured ${measuredReductionDb.toFixed(1)} dB` : 'no detector')
                  : 'no measurement'}
              </div>
              <div className="w-20 h-2 bg-[var(--apex-grid-line-strong)] rounded-full overflow-hidden border border-[var(--apex-border)]">
                <div
                  style={{ width: isLevelDetected && detectorAttached ? `${Math.min(100, (measuredReductionDb / Math.max(1, maxReductionDb)) * 100)}%` : '0%' }}
                  className="h-full bg-gradient-to-r from-[var(--apex-success)] via-[var(--apex-gold)] to-[var(--apex-danger)] transition-all duration-75"
                />
              </div>
              <span className="text-[8px] text-[var(--apex-text-3)] text-center max-w-[100px]" data-testid="sidechain-meter-caption">
                {isLevelDetected
                  ? (detectorAttached ? 'detector measured' : 'detector not attached — apply, then play the source')
                  : 'note-triggered — no level measurement'}
              </span>
            </div>

            {/* Target Destination Track Selection */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] flex-1 w-full space-y-1.5">
              <span className="text-[10px] text-[var(--apex-cyan-text)] font-bold block uppercase tracking-wider">TARGET DESTINATION (DUCKED)</span>
              <select
                value={selectedDestTrackId}
                onChange={(e) => setSelectedDestTrackId(Number(e.target.value))}
                className="w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs p-2 rounded border border-[var(--apex-border)] font-bold"
              >
                {mixerTracks.map(m => (
                  <option key={m.id} value={m.id}>Track #{m.id}: {m.name}</option>
                ))}
              </select>
              <span className="text-[9px] text-[var(--apex-text-3)] block">Volume on this track will be ducked when the trigger fires</span>
            </div>
          </div>

          {/* Mode selection: both modes are implemented; neither is a preview. */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[var(--apex-text)]">SIDECHAIN MODE</span>
              <button
                onClick={() => setIsEnabled(v => !v)}
                className={`px-2 py-0.5 rounded text-[9px] font-bold transition ${
                  isEnabled
                    ? 'bg-[var(--apex-gold)] text-[var(--apex-state-playing-fg)]'
                    : 'bg-[var(--apex-canvas)] text-[var(--apex-text-3)] border border-[var(--apex-border)]'
                }`}
                aria-pressed={isEnabled}
              >
                {isEnabled ? 'ROUTE ACTIVE' : 'ROUTE OFF'}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={() => setSidechainMode('level-detected')}
                aria-pressed={isLevelDetected}
                className={`text-left p-2 rounded-lg border transition ${
                  isLevelDetected
                    ? 'border-[var(--apex-gold)] bg-[color-mix(in_srgb,var(--apex-gold)_12%,transparent)]'
                    : 'border-[var(--apex-border)] bg-[var(--apex-canvas)]'
                }`}
              >
                <span className="block text-[11px] font-bold text-[var(--apex-text)]">REAL LEVEL DETECTION</span>
                <span className="block text-[9px] text-[var(--apex-text-3)]">
                  Audio-thread peak detector on the source track: threshold + ratio, attack/release smoothing. Active in playback and export.
                </span>
              </button>
              <button
                onClick={() => setSidechainMode('note-trigger')}
                aria-pressed={!isLevelDetected}
                className={`text-left p-2 rounded-lg border transition ${
                  !isLevelDetected
                    ? 'border-[var(--apex-gold)] bg-[color-mix(in_srgb,var(--apex-gold)_12%,transparent)]'
                    : 'border-[var(--apex-border)] bg-[var(--apex-canvas)]'
                }`}
              >
                <span className="block text-[11px] font-bold text-[var(--apex-text)]">NOTE-TRIGGERED (LEGACY)</span>
                <span className="block text-[9px] text-[var(--apex-text-3)]">
                  Each note on the source track fires a fixed duck envelope. No audio level is measured — pre-9A projects keep this mode.
                </span>
              </button>
            </div>
          </div>

          {/* Sidechain Parameters Grid — every control below reaches the DSP. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Threshold (level-detected only) */}
            <div className={`bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2 ${isLevelDetected ? '' : 'opacity-40'}`}>
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">DETECTOR THRESHOLD</span>
                <span className="text-[var(--apex-gold)] font-mono font-bold">{thresholdDb.toFixed(0)} dBFS</span>
              </div>
              <input
                type="range"
                min={SIDECHAIN_LIMITS.thresholdDb.min}
                max={SIDECHAIN_LIMITS.thresholdDb.max}
                step={1}
                value={thresholdDb}
                disabled={!isLevelDetected}
                onChange={(e) => setThresholdDb(Number(e.target.value))}
                className="w-full accent-[var(--apex-gold)]"
                aria-label="Sidechain detector threshold in dBFS"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Source audio below this level causes no ducking</span>
            </div>

            {/* Ratio (level-detected only) */}
            <div className={`bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2 ${isLevelDetected ? '' : 'opacity-40'}`}>
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">RATIO</span>
                <span className="text-[var(--apex-gold)] font-mono font-bold">{ratio.toFixed(1)}:1</span>
              </div>
              <input
                type="range"
                min={SIDECHAIN_LIMITS.ratio.min}
                max={SIDECHAIN_LIMITS.ratio.max}
                step={0.5}
                value={ratio}
                disabled={!isLevelDetected}
                onChange={(e) => setRatio(Number(e.target.value))}
                className="w-full accent-[var(--apex-gold)]"
                aria-label="Sidechain detector ratio"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Reduction per dB above the threshold</span>
            </div>

            {/* Duck Depth */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">DUCK DEPTH</span>
                <span className="text-[var(--apex-gold)] font-mono font-bold">{Math.round(duckAmount * 100)}%</span>
              </div>
              <input
                type="range"
                min={SIDECHAIN_LIMITS.amount.min}
                max={SIDECHAIN_LIMITS.amount.max}
                step={0.01}
                value={duckAmount}
                onChange={(e) => setDuckAmount(Number(e.target.value))}
                className="w-full accent-[var(--apex-gold)]"
                aria-label="Sidechain duck depth"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Maximum attenuation ({maxReductionDb.toFixed(1)} dB){isLevelDetected ? ' once the detector ducks fully' : ''}</span>
            </div>

            {/* Attack Time */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">ATTACK SPEED</span>
                <span className="text-[var(--apex-success)] font-mono font-bold">{attackMs} ms</span>
              </div>
              <input
                type="range"
                min={SIDECHAIN_LIMITS.attackMs.min}
                max={SIDECHAIN_LIMITS.attackMs.max}
                value={attackMs}
                onChange={(e) => setAttackMs(Number(e.target.value))}
                className="w-full accent-[var(--apex-success)]"
                aria-label="Sidechain attack time in milliseconds"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Smoothing time constant of the ducking gain closing</span>
            </div>

            {/* Release Time */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">RELEASE (RECOVERY)</span>
                <span className="text-[var(--apex-cyan-text)] font-mono font-bold">{releaseMs} ms</span>
              </div>
              <input
                type="range"
                min={SIDECHAIN_LIMITS.releaseMs.min}
                max={SIDECHAIN_LIMITS.releaseMs.max}
                value={releaseMs}
                onChange={(e) => setReleaseMs(Number(e.target.value))}
                className="w-full accent-[var(--apex-cyan)]"
                aria-label="Sidechain release time in milliseconds"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Smoothing time constant of the ducking gain returning to unity</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)] max-w-[70%]">
            {isLevelDetected
              ? 'Level-detected ducking: the source track\'s post-fader audio drives this track\'s gain. Applies to playback, the song export and master renders.'
              : 'Note-triggered ducking (legacy): each note on the source track fires a fixed envelope. No audio level is measured.'}
          </span>
          <button
            onClick={handleApplyRouting}
            className="px-4 py-1.5 bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_86%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Apply Sidechain Matrix</span>
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
