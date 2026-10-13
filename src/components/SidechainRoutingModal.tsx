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
import { MixerTrack, SidechainSettings } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

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
  // Inert parameters preserved for forward-compat (Phase 88 level-detected sidechain);
  // not presented as controls today.
  const [thresholdDb] = useState<number>(-18);
  const [duckAmount, setDuckAmount] = useState<number>(0.85);
  const [attackMs, setAttackMs] = useState<number>(5);
  const [releaseMs, setReleaseMs] = useState<number>(120);
  const [lowFreqOnly] = useState<boolean>(true);
  const [highPassFilterHz] = useState<number>(140);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Meter animation
  const [meterReduction, setMeterReduction] = useState<number>(0);

  useEffect(() => {
    if (!isOpen || !isEnabled) return;
    const interval = setInterval(() => {
      // Simulate rhythmic kick ducking pulse
      const now = Date.now();
      const pulse = (Math.sin(now / 150) + 1) / 2;
      setMeterReduction(pulse * duckAmount * 18);
    }, 50);
    return () => clearInterval(interval);
  }, [isOpen, isEnabled, duckAmount]);

  if (!isOpen) return null;

  const destTrack = mixerTracks.find(t => t.id === selectedDestTrackId) || mixerTracks[1] || mixerTracks[0];
  const sourceTrack = mixerTracks.find(t => t.id === sourceTrackId) || mixerTracks[0];

  const handleApplyRouting = () => {
    const updated = mixerTracks.map(t => {
      if (t.id === selectedDestTrackId) {
        // Phase 79: only emit the fields the engine actually consumes
        // (enabled, sourceTrackId, amount, attackMs, releaseMs). The
        // threshold/lowFreqOnly/highPassFilterHz/gainReductionDb fields
        // existed only as UI placeholders and are stripped.
        const sidechain: SidechainSettings = {
          enabled: isEnabled,
          sourceTrackId,
          amount: duckAmount,
          attackMs,
          releaseMs,
        };
        return { ...t, sidechain };
      }
      return t;
    });

    onUpdateMixerTracks(updated);
    setStatusMessage(`Applied Sidechain Ducking to ${destTrack.name} (Source: ${sourceTrack.name})`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleAuditionPump = () => {
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
        mixerTrackId: selectedDestTrackId,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `sc-pump-${Date.now()}`, pitch: 36, start: 0, duration: 2, velocity: 0.9 }
    );
    setStatusMessage('Auditioning Sidechain Ducking Envelope...');
    setTimeout(() => setStatusMessage(null), 2000);
  };

  return (
    <ModalFrame id="fl-sidechain-routing-modal" labelledBy="fl-sidechain-routing-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      {/* UI-03N: every chrome surface, border, text and interaction state below
          consumes the existing `--apex-*` semantic tokens. The matrix's amber
          identity is kept through `--apex-gold`, the destination/duck read-out
          through `--apex-cyan-text`, the attack/duck-preview read-outs through
          `--apex-success`, and the VU-style preview meter keeps its
          green → amber → red audio-state gradient through `--apex-success`,
          `--apex-gold` and `--apex-danger`. The dead `bg-black/85` scrim is
          gone — ModalFrame supplies the shared themed `--apex-modal-overlay`.

          The audition note's `color: '#ff6e00'` is a data field for the
          `playNote` call, not a UI colour: it is preserved exactly as before. */}
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
                  PEAK DUCK DSP
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Route trigger tracks (Kick / Snare) to dynamically compress frequency bands on destination tracks (808 / Synths)</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionPump}
              className="px-3 py-1 bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_86%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Audition Pump</span>
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
              <span className="text-[9px] text-[var(--apex-text-3)] block">Notes on this track trigger the ducking envelope (no level detector)</span>
            </div>

            {/* Preview meter — visual rhythm preview only (not reading live audio). */}
            <div className="flex flex-col items-center justify-center gap-1 px-2">
              <div className="flex items-center gap-2">
                <ArrowRight className="w-5 h-5 text-[var(--apex-gold)]" />
              </div>
              <div className="text-[9px] font-mono text-[var(--apex-gold)] font-bold">
                preview ~{meterReduction.toFixed(1)} dB
              </div>
              <div className="w-20 h-2 bg-[var(--apex-grid-line-strong)] rounded-full overflow-hidden border border-[var(--apex-border)]">
                <div 
                  style={{ width: `${Math.min(100, (meterReduction / 18) * 100)}%` }}
                  className="h-full bg-gradient-to-r from-[var(--apex-success)] via-[var(--apex-gold)] to-[var(--apex-danger)] transition-all duration-75"
                />
              </div>
              <span className="text-[8px] text-[var(--apex-text-3)]">visual preview</span>
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
              <span className="text-[9px] text-[var(--apex-text-3)] block">Volume on this track will be ducked when trigger hits</span>
            </div>
          </div>

          {/* Sidechain Parameters Grid.
              Phase 79: threshold / lowFreqOnly / highPassFilterHz were displayed but
              the engine's sidechain is a note-triggered envelope (not level-detected),
              so those three controls had no effect. They are removed from the UI
              rather than presented as functional. Threshold/lowFreq controls will
              return when Phase 88 ships a real level-detected sidechain compressor. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Duck Depth / Ratio */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">DUCKING AMOUNT</span>
                <span className="text-[var(--apex-gold)] font-mono font-bold">{Math.round(duckAmount * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={duckAmount}
                onChange={(e) => setDuckAmount(Number(e.target.value))}
                className="w-full accent-[var(--apex-gold)]"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Total depth of volume attenuation</span>
            </div>

            {/* Attack Time */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">ATTACK SPEED</span>
                <span className="text-[var(--apex-success)] font-mono font-bold">{attackMs} ms</span>
              </div>
              <input
                type="range"
                min="1"
                max="50"
                value={attackMs}
                onChange={(e) => setAttackMs(Number(e.target.value))}
                className="w-full accent-[var(--apex-success)]"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Speed at which ducking clamps down</span>
            </div>

            {/* Release Time */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-xl border border-[var(--apex-border)] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-[var(--apex-text)] font-bold">RELEASE (RECOVERY)</span>
                <span className="text-[var(--apex-cyan-text)] font-mono font-bold">{releaseMs} ms</span>
              </div>
              <input
                type="range"
                min="20"
                max="500"
                value={releaseMs}
                onChange={(e) => setReleaseMs(Number(e.target.value))}
                className="w-full accent-[var(--apex-cyan)]"
              />
              <span className="text-[9px] text-[var(--apex-text-3)] block">Time taken for volume to return to 0dB</span>
            </div>
          </div>

          {/* Frequency-selective / detector controls intentionally not rendered.
              They are preserved in the SidechainSettings type and persisted as
              intent for Phase 88 (level-detected sidechain) but do not reach DSP
              today, so displaying them would imply audio behavior that does not
              exist. */}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Ducking is triggered by notes on the source track (no level detector)</span>
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
