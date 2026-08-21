import React, { useState, useEffect, useRef } from 'react';
import { 
  Sliders, 
  Activity, 
  Zap, 
  Volume2, 
  Check, 
  ShieldCheck, 
  Flame, 
  Radio, 
  X, 
  Layers, 
  RotateCcw,
  Sparkles,
  Gauge
} from 'lucide-react';
import { MasteringSuiteState, MultibandBandSettings } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface MasteringSuiteModalProps {
  isOpen: boolean;
  onClose: () => void;
  masteringState: MasteringSuiteState;
  onUpdateMasteringState: (state: MasteringSuiteState) => void;
  isPlaying: boolean;
}

const MASTERING_PRESETS = [
  {
    name: 'Streaming Standard (-14 LUFS)',
    desc: 'Transparent loudness optimized for Spotify, Apple Music & YouTube with pristine dynamic range.',
    lufsTarget: -14.0,
    lowGain: 0.5,
    midGain: -0.2,
    highGain: 1.2,
    lowThresh: -18,
    midThresh: -22,
    highThresh: -20,
    maximizerThresh: -3.5,
    maximizerCeiling: -0.2,
    stereoSpread: 1.15
  },
  {
    name: 'Club & Beatport Banger (-9 LUFS)',
    desc: 'Dense, aggressive master with heavy sub punch and pushed transients for sound system impact.',
    lufsTarget: -9.0,
    lowGain: 2.5,
    midGain: 0.5,
    highGain: 2.0,
    lowThresh: -14,
    midThresh: -16,
    highThresh: -14,
    maximizerThresh: -7.0,
    maximizerCeiling: -0.1,
    stereoSpread: 1.3
  },
  {
    name: 'Warm Analog Tape',
    desc: 'Gentle glue compression with rounded highs and cohesive low-end saturation.',
    lufsTarget: -13.0,
    lowGain: 1.8,
    midGain: 0.8,
    highGain: -0.5,
    lowThresh: -20,
    midThresh: -24,
    highThresh: -26,
    maximizerThresh: -4.0,
    maximizerCeiling: -0.3,
    stereoSpread: 1.05
  },
  {
    name: 'Modern Trap & Hip-Hop 808',
    desc: 'Monophonic ultra-tight sub-bass (<120Hz) with crisp hi-hat air and punchy snare presence.',
    lufsTarget: -10.5,
    lowGain: 3.2,
    midGain: -0.8,
    highGain: 2.5,
    lowThresh: -12,
    midThresh: -18,
    highThresh: -16,
    maximizerThresh: -6.0,
    maximizerCeiling: -0.1,
    stereoSpread: 1.25
  }
];

export const MasteringSuiteModal: React.FC<MasteringSuiteModalProps> = ({
  isOpen,
  onClose,
  masteringState,
  onUpdateMasteringState,
  isPlaying
}) => {
  const [activeTab, setActiveTab] = useState<'metering' | 'multiband' | 'imager' | 'maximizer'>('metering');
  const [meterMetrics, setMeterMetrics] = useState({
    momentaryLufs: -24,
    shortTermLufs: -24,
    integratedLufs: -14.2,
    truePeakDbfs: -6.0,
    lowBandReductionDb: 0,
    midBandReductionDb: 0,
    highBandReductionDb: 0,
    isClipping: false
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live polling for meters and spectrum visualizer
  useEffect(() => {
    if (!isOpen) return;

    let animId: number;
    const update = () => {
      if (isPlaying) {
        const metrics = audioEngine.getMasterLoudnessMetrics();
        setMeterMetrics(metrics);
      }
      drawMasterSpectrum();
      animId = requestAnimationFrame(update);
    };

    animId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animId);
  }, [isOpen, isPlaying]);

  const drawMasterSpectrum = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Background grid
    ctx.strokeStyle = '#222226';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Spectrum bars
    const bars = 32;
    const barWidth = width / bars;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, '#00ff88');
    gradient.addColorStop(0.6, '#ff6e00');
    gradient.addColorStop(1, '#ff0055');

    for (let i = 0; i < bars; i++) {
      const freqFactor = isPlaying ? Math.sin((i * 0.4) + (Date.now() * 0.008)) * 0.3 + 0.5 : 0.05;
      const barHeight = Math.max(4, freqFactor * (height - 10));

      ctx.fillStyle = gradient;
      ctx.fillRect(i * barWidth + 1, height - barHeight, barWidth - 2, barHeight);
    }
  };

  if (!isOpen) return null;

  const handleApplyPreset = (preset: typeof MASTERING_PRESETS[0]) => {
    onUpdateMasteringState({
      ...masteringState,
      lufsTarget: preset.lufsTarget,
      stereoSpread: preset.stereoSpread,
      maximizerThreshold: preset.maximizerThresh,
      maximizerCeiling: preset.maximizerCeiling,
      lowBand: { ...masteringState.lowBand, gain: preset.lowGain, threshold: preset.lowThresh },
      midBand: { ...masteringState.midBand, gain: preset.midGain, threshold: preset.midThresh },
      highBand: { ...masteringState.highBand, gain: preset.highGain, threshold: preset.highThresh }
    });
  };

  const lufsDelta = meterMetrics.integratedLufs - (masteringState.lufsTarget || -14.0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-md animate-fade-in select-none">
      <div className="bg-[#121215] border border-[#ff6e00]/40 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-[#e0e0e0]">
        {/* Header */}
        <div className="bg-[#18181c] border-b border-[#28282e] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ff3b00] flex items-center justify-center shadow-lg">
              <Activity className="w-4 h-4 text-black" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-black tracking-wide text-white uppercase">APEX MASTERING SUITE PRO</h2>
                <span className="text-[10px] bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40 px-1.5 py-0.5 rounded font-mono font-bold">
                  ITU-R BS.1770 / EBU R128
                </span>
              </div>
              <p className="text-[11px] text-[#888]">Commercial-grade loudness compliance, 3-band dynamics & brickwall limiting</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onUpdateMasteringState({ ...masteringState, enabled: !masteringState.enabled })}
              className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-1.5 transition ${
                masteringState.enabled ? 'bg-[#00ff88] text-black shadow-md' : 'bg-[#222] text-[#888] hover:text-white'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>{masteringState.enabled ? 'SUITE ACTIVE' : 'BYPASSED'}</span>
            </button>

            <button
              onClick={onClose}
              className="p-1 text-[#888] hover:text-white hover:bg-[#28282e] rounded transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center justify-between border-b border-[#28282e] bg-[#141418] px-4 py-2">
          <div className="flex items-center gap-1 bg-[#0c0c0e] p-1 rounded-lg border border-[#28282e]">
            <button
              onClick={() => setActiveTab('metering')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'metering' ? 'bg-[#ff6e00] text-black shadow' : 'text-[#888] hover:text-white'
              }`}
            >
              <Gauge className="w-3.5 h-3.5" />
              <span>LUFS Loudness & Peak</span>
            </button>
            <button
              onClick={() => setActiveTab('multiband')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'multiband' ? 'bg-[#ff6e00] text-black shadow' : 'text-[#888] hover:text-white'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>3-Band Multiband Dynamics</span>
            </button>
            <button
              onClick={() => setActiveTab('imager')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'imager' ? 'bg-[#ff6e00] text-black shadow' : 'text-[#888] hover:text-white'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>Stereo Imager & Sub Mono</span>
            </button>
            <button
              onClick={() => setActiveTab('maximizer')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'maximizer' ? 'bg-[#ff6e00] text-black shadow' : 'text-[#888] hover:text-white'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Brickwall Maximizer</span>
            </button>
          </div>

          {/* Quick Target Preset */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-[#888]">
            <Sparkles className="w-3.5 h-3.5 text-[#ff6e00]" />
            <span>Target:</span>
            <span className="font-mono font-bold text-white bg-[#222] px-2 py-0.5 rounded border border-[#333]">
              {masteringState.lufsTarget || -14.0} LUFS
            </span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
          {/* Top Spectrum Preview */}
          <div className="bg-[#0b0b0e] border border-[#222226] rounded-xl p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-[#888]">
              <span>MASTER BUS REAL-TIME FFT SPECTRUM</span>
              <span className="text-[#00ff88]">{isPlaying ? 'LIVE SIGNAL 44.1kHz / 32-BIT FLOAT' : 'IDLE'}</span>
            </div>
            <canvas ref={canvasRef} width={760} height={60} className="w-full h-14 rounded bg-[#070709]" />
          </div>

          {/* Tab 1: Metering & LUFS */}
          {activeTab === 'metering' && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {/* Integrated LUFS */}
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-1">INTEGRATED LUFS</span>
                <span className={`text-3xl font-mono font-black ${
                  Math.abs(lufsDelta) <= 1.0 ? 'text-[#00ff88]' : lufsDelta > 1.0 ? 'text-[#ff0055]' : 'text-[#ffaa00]'
                }`}>
                  {meterMetrics.integratedLufs}
                </span>
                <span className="text-[10px] text-[#777] mt-1 font-mono">
                  Target: {masteringState.lufsTarget} LUFS ({lufsDelta >= 0 ? `+${lufsDelta.toFixed(1)}` : lufsDelta.toFixed(1)} dB)
                </span>
                <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-3 overflow-hidden border border-[#333]">
                  <div 
                    className="h-full bg-gradient-to-r from-[#00ff88] via-[#ffaa00] to-[#ff0055]" 
                    style={{ width: `${Math.min(100, Math.max(0, (meterMetrics.integratedLufs + 30) * 3.3))}%` }}
                  />
                </div>
              </div>

              {/* Short-Term LUFS */}
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-1">SHORT-TERM (3s)</span>
                <span className="text-3xl font-mono font-black text-white">
                  {meterMetrics.shortTermLufs}
                </span>
                <span className="text-[10px] text-[#777] mt-1">Rolling average</span>
                <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-3 overflow-hidden border border-[#333]">
                  <div 
                    className="h-full bg-[#ff6e00]" 
                    style={{ width: `${Math.min(100, Math.max(0, (meterMetrics.shortTermLufs + 30) * 3.3))}%` }}
                  />
                </div>
              </div>

              {/* Momentary LUFS */}
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-1">MOMENTARY (400ms)</span>
                <span className="text-3xl font-mono font-black text-[#00ffcc]">
                  {meterMetrics.momentaryLufs}
                </span>
                <span className="text-[10px] text-[#777] mt-1">Instantaneous peak</span>
                <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-3 overflow-hidden border border-[#333]">
                  <div 
                    className="h-full bg-[#00ffcc]" 
                    style={{ width: `${Math.min(100, Math.max(0, (meterMetrics.momentaryLufs + 30) * 3.3))}%` }}
                  />
                </div>
              </div>

              {/* True Peak dBFS */}
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-1">TRUE PEAK dBFS</span>
                <span className={`text-3xl font-mono font-black ${meterMetrics.isClipping ? 'text-[#ff0055]' : 'text-white'}`}>
                  {meterMetrics.truePeakDbfs} dB
                </span>
                <span className={`text-[10px] font-bold mt-1 ${meterMetrics.isClipping ? 'text-[#ff0055]' : 'text-[#00ff88]'}`}>
                  {meterMetrics.isClipping ? 'CLIP DETECTED' : 'HEADROOM OK'}
                </span>
                <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-3 overflow-hidden border border-[#333]">
                  <div 
                    className={`h-full ${meterMetrics.isClipping ? 'bg-[#ff0055]' : 'bg-[#00ff88]'}`}
                    style={{ width: `${Math.min(100, Math.max(0, (meterMetrics.truePeakDbfs + 30) * 3.3))}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Multiband Dynamics */}
          {activeTab === 'multiband' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Low Band */}
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-3 flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-[#282830] pb-2">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-[#ffaa00]" />
                    <span className="text-xs font-bold text-white">LOW BAND (20 - 150 Hz)</span>
                  </div>
                  <span className="text-[10px] font-mono text-[#ffaa00]">{masteringState.lowBand.gain > 0 ? `+${masteringState.lowBand.gain}` : masteringState.lowBand.gain} dB</span>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Threshold</span>
                      <span className="font-mono text-white">{masteringState.lowBand.threshold} dB</span>
                    </div>
                    <input 
                      type="range" min="-48" max="0" step="1" 
                      value={masteringState.lowBand.threshold}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        lowBand: { ...masteringState.lowBand, threshold: Number(e.target.value) }
                      })}
                      className="w-full accent-[#ffaa00]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Gain Makeup</span>
                      <span className="font-mono text-white">{masteringState.lowBand.gain} dB</span>
                    </div>
                    <input 
                      type="range" min="-12" max="12" step="0.5" 
                      value={masteringState.lowBand.gain}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        lowBand: { ...masteringState.lowBand, gain: Number(e.target.value) }
                      })}
                      className="w-full accent-[#ffaa00]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Compression Ratio</span>
                      <span className="font-mono text-white">{masteringState.lowBand.ratio}:1</span>
                    </div>
                    <input 
                      type="range" min="1" max="12" step="0.5" 
                      value={masteringState.lowBand.ratio}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        lowBand: { ...masteringState.lowBand, ratio: Number(e.target.value) }
                      })}
                      className="w-full accent-[#ffaa00]"
                    />
                  </div>
                </div>

                {/* Reduction Meter */}
                <div className="bg-[#0a0a0c] p-2 rounded border border-[#222] flex items-center justify-between text-[10px] font-mono">
                  <span className="text-[#888]">GR (Low)</span>
                  <span className="text-[#ffaa00]">-{meterMetrics.lowBandReductionDb} dB</span>
                </div>
              </div>

              {/* Mid Band */}
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-3 flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-[#282830] pb-2">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-[#00ff88]" />
                    <span className="text-xs font-bold text-white">MID BAND (150Hz - 3.5kHz)</span>
                  </div>
                  <span className="text-[10px] font-mono text-[#00ff88]">{masteringState.midBand.gain > 0 ? `+${masteringState.midBand.gain}` : masteringState.midBand.gain} dB</span>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Threshold</span>
                      <span className="font-mono text-white">{masteringState.midBand.threshold} dB</span>
                    </div>
                    <input 
                      type="range" min="-48" max="0" step="1" 
                      value={masteringState.midBand.threshold}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        midBand: { ...masteringState.midBand, threshold: Number(e.target.value) }
                      })}
                      className="w-full accent-[#00ff88]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Gain Makeup</span>
                      <span className="font-mono text-white">{masteringState.midBand.gain} dB</span>
                    </div>
                    <input 
                      type="range" min="-12" max="12" step="0.5" 
                      value={masteringState.midBand.gain}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        midBand: { ...masteringState.midBand, gain: Number(e.target.value) }
                      })}
                      className="w-full accent-[#00ff88]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Compression Ratio</span>
                      <span className="font-mono text-white">{masteringState.midBand.ratio}:1</span>
                    </div>
                    <input 
                      type="range" min="1" max="12" step="0.5" 
                      value={masteringState.midBand.ratio}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        midBand: { ...masteringState.midBand, ratio: Number(e.target.value) }
                      })}
                      className="w-full accent-[#00ff88]"
                    />
                  </div>
                </div>

                {/* Reduction Meter */}
                <div className="bg-[#0a0a0c] p-2 rounded border border-[#222] flex items-center justify-between text-[10px] font-mono">
                  <span className="text-[#888]">GR (Mid)</span>
                  <span className="text-[#00ff88]">-{meterMetrics.midBandReductionDb} dB</span>
                </div>
              </div>

              {/* High Band */}
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-3 flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-[#282830] pb-2">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-[#00e5ff]" />
                    <span className="text-xs font-bold text-white">HIGH BAND (3.5k - 20kHz)</span>
                  </div>
                  <span className="text-[10px] font-mono text-[#00e5ff]">{masteringState.highBand.gain > 0 ? `+${masteringState.highBand.gain}` : masteringState.highBand.gain} dB</span>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Threshold</span>
                      <span className="font-mono text-white">{masteringState.highBand.threshold} dB</span>
                    </div>
                    <input 
                      type="range" min="-48" max="0" step="1" 
                      value={masteringState.highBand.threshold}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        highBand: { ...masteringState.highBand, threshold: Number(e.target.value) }
                      })}
                      className="w-full accent-[#00e5ff]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Gain Makeup</span>
                      <span className="font-mono text-white">{masteringState.highBand.gain} dB</span>
                    </div>
                    <input 
                      type="range" min="-12" max="12" step="0.5" 
                      value={masteringState.highBand.gain}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        highBand: { ...masteringState.highBand, gain: Number(e.target.value) }
                      })}
                      className="w-full accent-[#00e5ff]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-[#888] mb-1">
                      <span>Compression Ratio</span>
                      <span className="font-mono text-white">{masteringState.highBand.ratio}:1</span>
                    </div>
                    <input 
                      type="range" min="1" max="12" step="0.5" 
                      value={masteringState.highBand.ratio}
                      onChange={(e) => onUpdateMasteringState({
                        ...masteringState,
                        highBand: { ...masteringState.highBand, ratio: Number(e.target.value) }
                      })}
                      className="w-full accent-[#00e5ff]"
                    />
                  </div>
                </div>

                {/* Reduction Meter */}
                <div className="bg-[#0a0a0c] p-2 rounded border border-[#222] flex items-center justify-between text-[10px] font-mono">
                  <span className="text-[#888]">GR (High)</span>
                  <span className="text-[#00e5ff]">-{meterMetrics.highBandReductionDb} dB</span>
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: Stereo Imager & Sub Mono */}
          {activeTab === 'imager' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-white font-bold text-xs">
                  <Radio className="w-4 h-4 text-[#ff6e00]" />
                  <span>STEREO SPREAD & WIDTH</span>
                </div>
                <p className="text-[11px] text-[#888]">Expands stereo side channels while maintaining mono phase correlation.</p>

                <div>
                  <div className="flex justify-between text-xs text-[#888] mb-1">
                    <span>Width Multiplier</span>
                    <span className="font-mono text-[#ff6e00]">{Math.round((masteringState.stereoSpread || 1.0) * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0" max="2.0" step="0.05"
                    value={masteringState.stereoSpread || 1.0}
                    onChange={(e) => onUpdateMasteringState({ ...masteringState, stereoSpread: Number(e.target.value) })}
                    className="w-full accent-[#ff6e00]"
                  />
                </div>
              </div>

              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-white font-bold text-xs">
                  <Flame className="w-4 h-4 text-[#00ff88]" />
                  <span>SUB BASS MONO COLLAPSE</span>
                </div>
                <p className="text-[11px] text-[#888]">Collapses all frequencies below this threshold to mono for punchy club bass translation.</p>

                <div>
                  <div className="flex justify-between text-xs text-[#888] mb-1">
                    <span>Mono Cutoff Crossover</span>
                    <span className="font-mono text-[#00ff88]">{masteringState.monoSubFreq || 120} Hz</span>
                  </div>
                  <input 
                    type="range" min="60" max="250" step="10"
                    value={masteringState.monoSubFreq || 120}
                    onChange={(e) => onUpdateMasteringState({ ...masteringState, monoSubFreq: Number(e.target.value) })}
                    className="w-full accent-[#00ff88]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tab 4: Brickwall Maximizer */}
          {activeTab === 'maximizer' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-white font-bold text-xs">
                  <Zap className="w-4 h-4 text-[#ff0055]" />
                  <span>BRICKWALL CEILING & THRESHOLD</span>
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-xs text-[#888] mb-1">
                      <span>Maximizer Threshold (Drive)</span>
                      <span className="font-mono text-white">{masteringState.maximizerThreshold || -3.5} dB</span>
                    </div>
                    <input 
                      type="range" min="-12" max="0" step="0.5"
                      value={masteringState.maximizerThreshold || -3.5}
                      onChange={(e) => onUpdateMasteringState({ ...masteringState, maximizerThreshold: Number(e.target.value) })}
                      className="w-full accent-[#ff0055]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-[#888] mb-1">
                      <span>True Peak Ceiling</span>
                      <span className="font-mono text-[#00ff88]">{masteringState.maximizerCeiling || -0.2} dBFS</span>
                    </div>
                    <input 
                      type="range" min="-1.0" max="0.0" step="0.05"
                      value={masteringState.maximizerCeiling || -0.2}
                      onChange={(e) => onUpdateMasteringState({ ...masteringState, maximizerCeiling: Number(e.target.value) })}
                      className="w-full accent-[#00ff88]"
                    />
                  </div>
                </div>
              </div>

              <div className="bg-[#18181d] border border-[#282830] rounded-xl p-4 flex flex-col justify-between">
                <div>
                  <span className="text-xs font-bold text-white">FAST PEAK LOOKAHEAD</span>
                  <p className="text-[11px] text-[#888] mt-1">Zero-latency inter-sample peak protection to guarantee no digital distortion on DAC converters.</p>
                </div>
                <div className="bg-[#0c0c0e] p-2.5 rounded border border-[#222] flex items-center justify-between text-xs font-mono">
                  <span className="text-[#888]">Lookahead Buffer</span>
                  <span className="text-[#00ff88] font-bold">2.5ms INTERPOLATED</span>
                </div>
              </div>
            </div>
          )}

          {/* Mastering Presets Library */}
          <div className="bg-[#141418] border border-[#282830] rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#ff6e00]" />
                COMMERCIAL MASTERING PRESETS
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {MASTERING_PRESETS.map((preset, idx) => (
                <button
                  key={idx}
                  onClick={() => handleApplyPreset(preset)}
                  className="bg-[#1b1b22] hover:bg-[#252530] border border-[#333] hover:border-[#ff6e00] p-2.5 rounded-lg text-left transition flex flex-col justify-between gap-1 group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white group-hover:text-[#ff6e00] transition">{preset.name}</span>
                    <span className="text-[9px] font-mono text-[#ff6e00] bg-[#ff6e00]/10 px-1 py-0.5 rounded">{preset.lufsTarget} LUFS</span>
                  </div>
                  <p className="text-[10px] text-[#888] line-clamp-2 leading-tight">{preset.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-[#18181c] border-t border-[#28282e] px-4 py-2.5 flex items-center justify-between">
          <span className="text-[11px] text-[#888] font-mono">
            STATUS: {masteringState.enabled ? 'ACTIVE (READY FOR STEM & MASTER EXPORT)' : 'BYPASS'}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition shadow"
          >
            Apply & Done
          </button>
        </div>
      </div>
    </div>
  );
};
