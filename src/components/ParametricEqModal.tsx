import React, { useState, useEffect, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  X, 
  Activity, 
  Volume2, 
  Sliders, 
  RotateCcw, 
  Check, 
  Layers, 
  Sparkles,
  Zap
} from 'lucide-react';
import { ParametricEqBand, MixerTrack } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import {
  EQ_BAND_SPECS,
  EQ_PRESETS,
  createFlatEqBands,
  findEqualizerSlot,
  publishEqBandsToTrack,
  readEqBandsFromTrack,
} from './parametricEqBands';

interface ParametricEqModalProps {
  isOpen: boolean;
  onClose: () => void;
  mixerTrack: MixerTrack;
  onUpdateTrack: (track: MixerTrack) => void;
}

/**
 * Phase 52: the editor is three stages because the production `equalizer`
 * insert is three biquads — lowshelf, peaking, highshelf (see
 * `liveFxChainHardening.createEqualizer`). The previous seven-band editor drew
 * two extra filters the engine never built and published nothing at all.
 */
export const ParametricEqModal: React.FC<ParametricEqModalProps> = ({
  isOpen,
  onClose,
  mixerTrack,
  onUpdateTrack
}) => {
  const [bands, setBands] = useState<ParametricEqBand[]>(() => readEqBandsFromTrack(mixerTrack));
  const [selectedBandId, setSelectedBandId] = useState<number>(2);
  const [draggingBandId, setDraggingBandId] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  /**
   * Dragging fires far faster than React re-renders, so the handlers below would
   * otherwise read a stale `bands` array and drop intermediate moves. The ref
   * always holds the newest committed value.
   */
  const bandsRef = useRef<ParametricEqBand[]>(bands);
  const setBandsSynced = (next: ParametricEqBand[]) => {
    bandsRef.current = next;
    setBands(next);
  };

  // Re-read the track's published bands whenever the modal is opened on it, so
  // the editor always shows the values the engine is actually using.
  useEffect(() => {
    if (!isOpen) return;
    setBandsSynced(readEqBandsFromTrack(mixerTrack));
  }, [isOpen, mixerTrack.id]);

  // 60fps Canvas Spectrum & Response Curve Renderer
  useEffect(() => {
    if (!isOpen) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const freqData = new Uint8Array(256);

    const render = () => {
      audioEngine.getMasterFrequencyData(freqData);

      const width = canvas.width;
      const height = canvas.height;

      // 1. Background Fill
      ctx.fillStyle = '#101014';
      ctx.fillRect(0, 0, width, height);

      // 2. Frequency Grid Lines (20Hz, 50Hz, 100Hz, 500Hz, 1kHz, 5kHz, 10kHz, 20kHz)
      const freqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
      ctx.strokeStyle = '#222228';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#555560';
      ctx.font = '10px monospace';

      freqs.forEach(f => {
        const x = freqToX(f, width);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
        ctx.fillText(label, x + 3, height - 6);
      });

      // 3. dB Grid Lines (+12, +6, 0, -6, -12)
      const dBs = [12, 6, 0, -6, -12];
      dBs.forEach(db => {
        const y = dbToY(db, height);
        ctx.strokeStyle = db === 0 ? '#383842' : '#1e1e24';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillText(`${db > 0 ? '+' : ''}${db}dB`, 6, y - 3);
      });

      // 4. Live Audio Spectrum Fill
      ctx.fillStyle = 'rgba(255, 110, 0, 0.15)';
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let i = 0; i < freqData.length; i++) {
        const x = (i / freqData.length) * width;
        const mag = freqData[i] / 255;
        const y = height - (mag * height * 0.85);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();

      // 5. Calculate Composite EQ Response Curve
      ctx.strokeStyle = '#ff6e00';
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      for (let x = 0; x <= width; x += 3) {
        const freq = xToFreq(x, width);
        let totalGainDb = 0;

        bands.forEach(b => {
          if (!b.enabled) return;
          const ratio = freq / b.frequency;
          if (b.type === 'peaking') {
            const bell = Math.exp(-Math.pow(Math.log2(ratio) * b.q, 2));
            totalGainDb += b.gain * bell;
          } else if (b.type === 'lowshelf') {
            if (freq < b.frequency) totalGainDb += b.gain;
          } else if (b.type === 'highshelf') {
            if (freq > b.frequency) totalGainDb += b.gain;
          } else if (b.type === 'highpass') {
            if (freq < b.frequency) totalGainDb -= 24 * Math.log2(b.frequency / Math.max(1, freq));
          } else if (b.type === 'lowpass') {
            if (freq > b.frequency) totalGainDb -= 24 * Math.log2(freq / b.frequency);
          }
        });

        const y = dbToY(totalGainDb, height);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 6. Draw Interactive Band Nodes
      bands.forEach(b => {
        if (!b.enabled) return;
        const x = freqToX(b.frequency, width);
        const y = dbToY(b.gain, height);
        const isSelected = b.id === selectedBandId;

        ctx.fillStyle = b.color;
        ctx.strokeStyle = isSelected ? '#ffffff' : '#000000';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;

        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 8 : 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Node ID Text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${b.id}`, x, y);
      });

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isOpen, bands, selectedBandId]);

  // Coordinate Helpers
  const freqToX = (f: number, width: number) => {
    const minF = Math.log10(20);
    const maxF = Math.log10(20000);
    const logF = Math.log10(Math.max(20, Math.min(20000, f)));
    return ((logF - minF) / (maxF - minF)) * width;
  };

  const xToFreq = (x: number, width: number) => {
    const minF = Math.log10(20);
    const maxF = Math.log10(20000);
    const logF = minF + (x / width) * (maxF - minF);
    return Math.round(Math.pow(10, logF));
  };

  const dbToY = (db: number, height: number) => {
    const minDb = -18;
    const maxDb = 18;
    const clamped = Math.max(minDb, Math.min(maxDb, db));
    return height - ((clamped - minDb) / (maxDb - minDb)) * height;
  };

  const yToDb = (y: number, height: number) => {
    const minDb = -18;
    const maxDb = 18;
    const clampedY = Math.max(0, Math.min(height, y));
    return Number(((height - clampedY) / height * (maxDb - minDb) + minDb).toFixed(1));
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Check hit test on nodes
    for (const b of bands) {
      const nodeX = freqToX(b.frequency, canvas.width);
      const nodeY = dbToY(b.gain, canvas.height);
      const dist = Math.hypot(mouseX - nodeX, mouseY - nodeY);
      if (dist < 15) {
        setSelectedBandId(b.id);
        setDraggingBandId(b.id);
        return;
      }
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingBandId === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = Math.max(0, Math.min(canvas.width, e.clientX - rect.left));
    const mouseY = Math.max(0, Math.min(canvas.height, e.clientY - rect.top));

    const newFreq = xToFreq(mouseX, canvas.width);
    const newGain = yToDb(mouseY, canvas.height);

    commitBands(prev =>
      prev.map(b => (b.id === draggingBandId ? { ...b, frequency: newFreq, gain: newGain } : b))
    );
  };

  const handleCanvasMouseUp = () => {
    setDraggingBandId(null);
  };

  const currentBand = bands.find(b => b.id === selectedBandId) || bands[0];

  /**
   * Every edit is written straight through to the track's EQ insert, so the
   * values reach the audio engine instead of stopping in React state.
   */
  const commitBands = (update: ParametricEqBand[] | ((prev: ParametricEqBand[]) => ParametricEqBand[])) => {
    const next = typeof update === 'function' ? update(bandsRef.current) : update;
    setBandsSynced(next);
    onUpdateTrack(publishEqBandsToTrack(mixerTrack, next));
  };

  const applyPreset = (preset: (typeof EQ_PRESETS)[number]) => {
    commitBands(preset.bands as ParametricEqBand[]);
  };

  if (!isOpen) return null;

  return (
    <ModalFrame
      id="parametric-eq-modal-overlay"
      labelledBy="parametric-eq-modal-title"
      onClose={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in"
    >
      <div 
        id="parametric-eq-modal-container"
        className="bg-[#18181b] border border-[#333336] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2a2a2d] bg-[#141416]">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-[#ff6e00]/10 border border-[#ff6e00]/30 flex items-center justify-center text-[#ff6e00]">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h2 id="parametric-eq-modal-title" className="text-base font-bold text-white flex items-center space-x-2">
                <span>3-Band EQ — Dynamic Equalizer</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-[#ff6e00]/20 text-[#ff851b] font-mono font-medium border border-[#ff6e00]/30">
                  Track: {mixerTrack.name}
                </span>
              </h2>
              <p className="text-xs text-[#888]">
                Mastering-grade surgical frequency sculpting with live FFT spectrum response
              </p>
            </div>
          </div>
          <button
            id="close-parametric-eq-btn"
            onClick={onClose}
            aria-label="Close parametric EQ"
            className="text-[#888] hover:text-white p-1.5 rounded-lg hover:bg-[#27272a] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1 custom-scrollbar">
          {/* Preset Selector */}
          <div className="flex items-center justify-between bg-[#202024] p-3 rounded-lg border border-[#2e2e32]">
            <div className="flex items-center space-x-2 text-xs text-[#888]">
              <Sparkles className="w-4 h-4 text-[#ff6e00]" />
              <span className="font-semibold text-white">Studio Mastering Profiles:</span>
            </div>
            <div className="flex items-center space-x-2">
              {EQ_PRESETS.map((p, idx) => (
                <button
                  key={idx}
                  onClick={() => applyPreset(p)}
                  className="px-2.5 py-1 text-[11px] font-semibold bg-[#2a2a2e] hover:bg-[#333] text-white rounded border border-[#3e3e44] transition-colors"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* Interactive EQ Canvas */}
          <div className="relative rounded-xl border border-[#2e2e32] overflow-hidden bg-[#101014] shadow-inner">
            <canvas
              ref={canvasRef}
              width={800}
              height={260}
              className="w-full h-64 cursor-crosshair block"
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
            />
          </div>

          {/* Band Selector Buttons */}
          <div className="grid grid-cols-7 gap-2">
            {bands.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelectedBandId(b.id)}
                className={`p-2.5 rounded-lg border flex flex-col items-center space-y-1 transition-all ${
                  b.id === selectedBandId
                    ? 'bg-[#28282e] border-[#ff6e00] shadow-md'
                    : 'bg-[#1c1c20] border-[#2e2e32] hover:bg-[#222226]'
                }`}
              >
                <div className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: b.color }}></span>
                  <span className="text-xs font-bold text-white">Band {b.id}</span>
                </div>
                <span className="text-[10px] text-[#888] font-mono">{b.frequency >= 1000 ? `${(b.frequency / 1000).toFixed(1)}k` : `${b.frequency}`} Hz</span>
                <span className={`text-[10px] font-bold ${b.gain > 0 ? 'text-[#2ecc71]' : b.gain < 0 ? 'text-[#e74c3c]' : 'text-[#888]'}`}>
                  {b.gain > 0 ? `+${b.gain}` : `${b.gain}`} dB
                </span>
              </button>
            ))}
          </div>

          {/* Precision Parameter Controls for Selected Band */}
          {currentBand && (
            <div className="p-4 bg-[#202024] rounded-xl border border-[#2e2e32] grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
              {/* Type — fixed per stage: these are the three filters the insert builds. */}
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-[#888] uppercase tracking-wider block">Filter Type</label>
                <div className="w-full bg-[#18181b] border border-[#333336] rounded-lg px-3 py-1.5 text-xs text-white capitalize font-semibold">
                  {EQ_BAND_SPECS.find(spec => spec.role === (currentBand.id === 1 ? 'low' : currentBand.id === 2 ? 'mid' : 'high'))?.label ?? 'Band'}
                </div>
                <span className="text-[9px] text-[#666] block">Fixed by the insert's signal chain.</span>
              </div>

              {/* Frequency */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-bold text-[#888] uppercase">
                  <span>Frequency</span>
                  <span className="text-white font-mono">{currentBand.frequency} Hz</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="20000"
                  value={currentBand.frequency}
                  onChange={(e) => {
                    const f = Number(e.target.value);
                    commitBands(prev => prev.map(b => (b.id === currentBand.id ? { ...b, frequency: f } : b)));
                  }}
                  className="w-full accent-[#ff6e00] h-1.5 bg-[#333] rounded-lg cursor-pointer"
                />
              </div>

              {/* Gain */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-bold text-[#888] uppercase">
                  <span>Gain (dB)</span>
                  <span className="text-white font-mono">{currentBand.gain} dB</span>
                </div>
                <input
                  type="range"
                  min="-18"
                  max="18"
                  step="0.1"
                  value={currentBand.gain}
                  onChange={(e) => {
                    const g = Number(e.target.value);
                    commitBands(prev => prev.map(b => (b.id === currentBand.id ? { ...b, gain: g } : b)));
                  }}
                  className="w-full accent-[#ff6e00] h-1.5 bg-[#333] rounded-lg cursor-pointer"
                />
              </div>

              {/* Bandwidth / Q */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-bold text-[#888] uppercase">
                  <span>Bandwidth (Q)</span>
                  <span className="text-white font-mono">{currentBand.q}</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={currentBand.q}
                  onChange={(e) => {
                    const qVal = Number(e.target.value);
                    commitBands(prev => prev.map(b => (b.id === currentBand.id ? { ...b, q: qVal } : b)));
                  }}
                  className="w-full accent-[#ff6e00] h-1.5 bg-[#333] rounded-lg cursor-pointer"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-[#2a2a2d] bg-[#141416] text-xs text-[#888]">
          <button
            onClick={() => commitBands(createFlatEqBands())}
            className="flex items-center space-x-1.5 text-xs text-[#888] hover:text-white"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset to Flat Linear Response</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff851b] text-white font-bold rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
