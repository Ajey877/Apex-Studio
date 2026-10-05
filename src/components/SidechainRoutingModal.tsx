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
    <ModalFrame id="fl-sidechain-routing-modal" labelledBy="fl-sidechain-routing-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#ffaa00]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ffaa00] to-[#ff6e00] flex items-center justify-center text-black shadow-md font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-sidechain-routing-modal-title" className="text-sm font-bold text-white tracking-wide">DYNAMIC SIDECHAIN DUCKING & MODULATION MATRIX</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ffaa00]/20 text-[#ffaa00] border border-[#ffaa00]/40">
                  PEAK DUCK DSP
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Route trigger tracks (Kick / Snare) to dynamically compress frequency bands on destination tracks (808 / Synths)</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionPump}
              className="px-3 py-1 bg-[#ffaa00] hover:bg-[#ffbb22] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Audition Pump</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close sidechain routing"
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[#ffaa00] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Signal Routing Flow Card */}
          <div className="bg-[#0b0b0d] p-4 rounded-xl border border-[#26262a] flex flex-col md:flex-row items-center justify-between gap-4">
            {/* Source Track Selection */}
            <div className="bg-[#18181c] p-3 rounded-lg border border-[#333] flex-1 w-full space-y-1.5">
              <span className="text-[10px] text-[#ffaa00] font-bold block uppercase tracking-wider">SIDECHAIN TRIGGER SOURCE</span>
              <select
                value={sourceTrackId}
                onChange={(e) => setSourceTrackId(Number(e.target.value))}
                className="w-full bg-[#121214] text-white text-xs p-2 rounded border border-[#333336] font-bold"
              >
                {mixerTracks.map(m => (
                  <option key={m.id} value={m.id}>Track #{m.id}: {m.name}</option>
                ))}
              </select>
              <span className="text-[9px] text-[#666] block">Notes on this track trigger the ducking envelope (no level detector)</span>
            </div>

            {/* Preview meter — visual rhythm preview only (not reading live audio). */}
            <div className="flex flex-col items-center justify-center gap-1 px-2">
              <div className="flex items-center gap-2">
                <ArrowRight className="w-5 h-5 text-[#ffaa00]" />
              </div>
              <div className="text-[9px] font-mono text-[#ffaa00] font-bold">
                preview ~{meterReduction.toFixed(1)} dB
              </div>
              <div className="w-20 h-2 bg-[#222] rounded-full overflow-hidden border border-[#333]">
                <div 
                  style={{ width: `${Math.min(100, (meterReduction / 18) * 100)}%` }}
                  className="h-full bg-gradient-to-r from-[#00ff88] via-[#ffaa00] to-red-500 transition-all duration-75"
                />
              </div>
              <span className="text-[8px] text-[#555]">visual preview</span>
            </div>

            {/* Target Destination Track Selection */}
            <div className="bg-[#18181c] p-3 rounded-lg border border-[#333] flex-1 w-full space-y-1.5">
              <span className="text-[10px] text-[#00e5ff] font-bold block uppercase tracking-wider">TARGET DESTINATION (DUCKED)</span>
              <select
                value={selectedDestTrackId}
                onChange={(e) => setSelectedDestTrackId(Number(e.target.value))}
                className="w-full bg-[#121214] text-white text-xs p-2 rounded border border-[#333336] font-bold"
              >
                {mixerTracks.map(m => (
                  <option key={m.id} value={m.id}>Track #{m.id}: {m.name}</option>
                ))}
              </select>
              <span className="text-[9px] text-[#666] block">Volume on this track will be ducked when trigger hits</span>
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
            <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white font-bold">DUCKING AMOUNT</span>
                <span className="text-[#ffaa00] font-mono font-bold">{Math.round(duckAmount * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={duckAmount}
                onChange={(e) => setDuckAmount(Number(e.target.value))}
                className="w-full accent-[#ffaa00]"
              />
              <span className="text-[9px] text-[#777] block">Total depth of volume attenuation</span>
            </div>

            {/* Attack Time */}
            <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white font-bold">ATTACK SPEED</span>
                <span className="text-[#00ff88] font-mono font-bold">{attackMs} ms</span>
              </div>
              <input
                type="range"
                min="1"
                max="50"
                value={attackMs}
                onChange={(e) => setAttackMs(Number(e.target.value))}
                className="w-full accent-[#00ff88]"
              />
              <span className="text-[9px] text-[#777] block">Speed at which ducking clamps down</span>
            </div>

            {/* Release Time */}
            <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white font-bold">RELEASE (RECOVERY)</span>
                <span className="text-[#00e5ff] font-mono font-bold">{releaseMs} ms</span>
              </div>
              <input
                type="range"
                min="20"
                max="500"
                value={releaseMs}
                onChange={(e) => setReleaseMs(Number(e.target.value))}
                className="w-full accent-[#00e5ff]"
              />
              <span className="text-[9px] text-[#777] block">Time taken for volume to return to 0dB</span>
            </div>
          </div>

          {/* Frequency-selective / detector controls intentionally not rendered.
              They are preserved in the SidechainSettings type and persisted as
              intent for Phase 88 (level-detected sidechain) but do not reach DSP
              today, so displaying them would imply audio behavior that does not
              exist. */}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Ducking is triggered by notes on the source track (no level detector)</span>
          <button
            onClick={handleApplyRouting}
            className="px-4 py-1.5 bg-[#ffaa00] hover:bg-[#ffbb22] text-black font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Apply Sidechain Matrix</span>
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
