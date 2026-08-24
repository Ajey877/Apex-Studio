import React, { useState, useEffect } from 'react';
import { 
  Sliders, 
  X, 
  Sparkles, 
  Activity, 
  Radio, 
  ArrowRight, 
  Volume2, 
  RotateCcw,
  Play,
  Check,
  Zap,
  Filter
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
  const [thresholdDb, setThresholdDb] = useState<number>(-18);
  const [duckAmount, setDuckAmount] = useState<number>(0.85);
  const [attackMs, setAttackMs] = useState<number>(5);
  const [releaseMs, setReleaseMs] = useState<number>(120);
  const [lowFreqOnly, setLowFreqOnly] = useState<boolean>(true);
  const [highPassFilterHz, setHighPassFilterHz] = useState<number>(140);
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
        const sidechain: SidechainSettings = {
          enabled: isEnabled,
          sourceTrackId,
          threshold: thresholdDb,
          amount: duckAmount,
          attackMs,
          releaseMs,
          lowFreqOnly,
          highPassFilterHz
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
    <div id="fl-sidechain-routing-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#ffaa00]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ffaa00] to-[#ff6e00] flex items-center justify-center text-black shadow-md font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">DYNAMIC SIDECHAIN DUCKING & MODULATION MATRIX</h2>
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
              <span className="text-[9px] text-[#666] block">Audio peaks from this track trigger the compression envelope</span>
            </div>

            {/* Dynamic Arrow & Gain Reduction Meter */}
            <div className="flex flex-col items-center justify-center gap-1 px-2">
              <div className="flex items-center gap-2">
                <ArrowRight className="w-5 h-5 text-[#ffaa00]" />
              </div>
              <div className="text-[9px] font-mono text-[#ffaa00] font-bold">
                -{meterReduction.toFixed(1)} dB
              </div>
              <div className="w-20 h-2 bg-[#222] rounded-full overflow-hidden border border-[#333]">
                <div 
                  style={{ width: `${Math.min(100, (meterReduction / 18) * 100)}%` }}
                  className="h-full bg-gradient-to-r from-[#00ff88] via-[#ffaa00] to-red-500 transition-all duration-75"
                />
              </div>
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

          {/* Sidechain Parameters Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Threshold */}
            <div className="bg-[#18181c] p-3 rounded-xl border border-[#28282e] space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white font-bold">THRESHOLD</span>
                <span className="text-[#ffaa00] font-mono font-bold">{thresholdDb} dB</span>
              </div>
              <input
                type="range"
                min="-36"
                max="0"
                value={thresholdDb}
                onChange={(e) => setThresholdDb(Number(e.target.value))}
                className="w-full accent-[#ffaa00]"
              />
              <span className="text-[9px] text-[#777] block">Trigger level to initiate ducking envelope</span>
            </div>

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

          {/* Frequency-Selective Sidechain Filtering */}
          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-[#ffaa00]" />
                <span className="text-xs font-bold text-white uppercase">FREQUENCY-SELECTIVE LOW-END DUCKING (SUB DUCK)</span>
              </div>
              <label className="flex items-center gap-2 text-xs text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={lowFreqOnly}
                  onChange={(e) => setLowFreqOnly(e.target.checked)}
                  className="accent-[#ffaa00]"
                />
                <span>Duck Low Frequencies Only (&lt;150Hz)</span>
              </label>
            </div>

            <p className="text-[10px] text-[#777]">
              When enabled, only the sub-bass frequencies below the crossover are ducked when the kick hits, keeping the highs and mid-harmonics untouched.
            </p>

            <div className="flex items-center gap-3">
              <span className="text-xs text-[#888] font-mono">Detector High-Pass Cutoff:</span>
              <input
                type="range"
                min="40"
                max="500"
                value={highPassFilterHz}
                onChange={(e) => setHighPassFilterHz(Number(e.target.value))}
                className="w-48 accent-[#ffaa00]"
              />
              <span className="text-xs font-mono font-bold text-white">{highPassFilterHz} Hz</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Real-time lookahead sidechain dynamic envelope active</span>
          <button
            onClick={handleApplyRouting}
            className="px-4 py-1.5 bg-[#ffaa00] hover:bg-[#ffbb22] text-black font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Apply Sidechain Matrix</span>
          </button>
        </div>
      </div>
    </div>
  );
};
