import React, { useState, useEffect, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
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
import { MasteringSuiteState, MultibandBandSettings, MasterMeasurementSnapshot } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface MasteringSuiteModalProps {
  isOpen: boolean;
  onClose: () => void;
  masteringState: MasteringSuiteState;
  onUpdateMasteringState: (state: MasteringSuiteState) => void;
  isPlaying: boolean;
}

/**
 * Display tolerance for the loudness-target readout. This is a presentation
 * threshold chosen by the UI; it is not a delivery certification, and the
 * readout says so rather than claiming a platform "pass".
 */
const TARGET_TOLERANCE_DB = 1.5;

/** Master analyser bins: fftSize 512 -> 256 bins spanning DC..Nyquist. */
const MASTER_FFT_BINS = 256;

/**
 * The mastering processing controls are intentionally not wired to the audio
 * graph in this phase (Phase 46 owns the master chain). Showing live "GR"
 * values or an "active" status for them would be a measurement the engine
 * never made, so every one of these panels says what it is.
 */
const NotAppliedBanner = ({ label }: { label: string }) => (
  <div className="bg-[#0a0a0c] border border-[#ffaa00]/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
    <span className="text-[10px] font-mono font-bold text-[#ffaa00] uppercase tracking-wider">
      {label}: NOT APPLIED — NO PROCESSING IN SIGNAL PATH
    </span>
    <span className="text-[10px] text-[#777] whitespace-nowrap">STORED AS INTENT · PHASE 46</span>
  </div>
);

const MASTERING_PRESETS = [
  {
    name: 'Streaming Standard (-14 LUFS)',
    desc: 'Transparent loudness optimized for Spotify, Apple Music & YouTube with values stored for a future master chain.',
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
    desc: 'Dense, aggressive master with heavy sub punch and pushed transients values stored for a future master chain.',
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
  // No seed values: `null` is the honest "nothing has been measured yet" state,
  // and every readout below has to handle it. The default object this replaces
  // carried a plausible integrated LUFS figure, a reassuring peak and a wide
  // correlation, which let the compliance badges read PASS before a single
  // sample of audio existed.
  const [measurement, setMeasurement] = useState<MasterMeasurementSnapshot | null>(null);
  const measurementRef = useRef<MasterMeasurementSnapshot | null>(null);
  const spectrumDataRef = useRef<Uint8Array | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const goniometerCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live polling for meters and spectrum visualizer
  useEffect(() => {
    if (!isOpen) return;

    let animId: number;
    const update = () => {
      // The engine pumps measurement while the transport runs; this surface only
      // reads it. Reading every frame (instead of only while playing) keeps the
      // numbers live *and* makes the "not measuring" state explicit, rather than
      // leaving a frozen figure on screen looking current.
      const next = audioEngine.getMasterLoudnessMetrics();
      measurementRef.current = next;
      setMeasurement(next);
      drawMasterSpectrum();
      drawGoniometer();
      animId = requestAnimationFrame(update);
    };

    animId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animId);
  }, [isOpen]);

  const drawGoniometer = () => {
    const canvas = goniometerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Dark radar background
    ctx.fillStyle = '#08080a';
    ctx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(centerX, centerY) - 8;

    // Outer grid circles
    ctx.strokeStyle = '#1e1e24';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.arc(centerX, centerY, radius * 0.6, 0, Math.PI * 2);
    ctx.stroke();

    // 45-degree axis lines (Left / Right / Mid / Side)
    ctx.strokeStyle = '#282830';
    ctx.beginPath();
    ctx.moveTo(centerX, 5); ctx.lineTo(centerX, height - 5); // Mid (M)
    ctx.moveTo(5, centerY); ctx.lineTo(width - 5, centerY); // Side (S)
    ctx.moveTo(centerX - radius * 0.7, centerY + radius * 0.7); ctx.lineTo(centerX + radius * 0.7, centerY - radius * 0.7); // Left
    ctx.moveTo(centerX - radius * 0.7, centerY - radius * 0.7); ctx.lineTo(centerX + radius * 0.7, centerY + radius * 0.7); // Right
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#666670';
    ctx.font = '8px monospace';
    ctx.fillText('M', centerX + 4, 12);
    ctx.fillText('+S', width - 15, centerY - 4);
    ctx.fillText('L', centerX - radius * 0.7 - 6, centerY - radius * 0.7);
    ctx.fillText('R', centerX + radius * 0.7 + 2, centerY - radius * 0.7);

    // Lissajous trace from the measured Mid/Side of the master bus. No points
    // means no measurement, so the scope stays dark instead of drawing a
    // plausible cluster.
    const current = measurementRef.current;
    const vectors = audioEngine.getStereoVectors(current?.isPumping ? 128 : 32);
    const correlation = current?.phaseCorrelation ?? null;
    if (vectors.length === 0) {
      ctx.fillStyle = '#4a4a52';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('NO SIGNAL - STEREO FIELD NOT MEASURED', centerX, centerY + 3);
      ctx.textAlign = 'left';
      return;
    }
    if (correlation === null) {
      ctx.strokeStyle = '#4a4a52';
    } else if (vectors.length > 0) {
      ctx.strokeStyle = correlation > 0.4 ? '#00ff88' : correlation >= 0 ? '#ffaa00' : '#ff0055';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 8;
      ctx.beginPath();

      vectors.forEach((pt, idx) => {
        const px = centerX + (pt.x * radius * 1.4);
        const py = centerY - (pt.y * radius * 1.4);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });

      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  };

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

    // Real master FFT, read through the same engine API the mixer already uses.
    // Each bar averages the analyser bins that fall under it, so the shape is a
    // display aggregation of measured data rather than an animation.
    let data = spectrumDataRef.current;
    if (!data || data.length !== MASTER_FFT_BINS) {
      data = new Uint8Array(MASTER_FFT_BINS);
      spectrumDataRef.current = data;
    }
    audioEngine.getMasterFrequencyData(data);

    const binsPerBar = Math.max(1, Math.floor(MASTER_FFT_BINS / bars));
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let b = 0; b < binsPerBar; b++) {
        sum += data[i * binsPerBar + b] ?? 0;
      }
      const level = sum / (binsPerBar * 255);
      const barHeight = level * (height - 10);
      if (barHeight <= 0) continue;

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

  const integratedLufs = measurement?.integratedLufs ?? null;
  const lufsTargetValue = masteringState.lufsTarget ?? -14.0;
  const lufsDelta = integratedLufs === null ? null : integratedLufs - lufsTargetValue;
  // The gate every status readout shares: a verdict may only exist when the
  // measurement it refers to exists.
  const isMeasured = measurement?.availability === 'measured';
  const isMeasuring = !!measurement && measurement.isPumping;
  const sampleRateHz = measurement?.sampleRate ?? null;
  const availabilityNote = (() => {
    if (!measurement) return 'WAITING FOR ENGINE';
    switch (measurement.availability) {
      case 'measured': return isMeasuring ? 'MEASURING' : 'LAST MEASUREMENT (TRANSPORT NOT RUNNING)';
      case 'no-audio': return 'NO SIGNAL ON MASTER BUS';
      case 'offline-render': return 'UNAVAILABLE DURING OFFLINE BOUNCE';
      default: return 'ENGINE NOT STARTED';
    }
  })();
  const formatDb = (value: number | null | undefined, decimals = 1, suffix = ''): string =>
    value === null || value === undefined ? '—' : `${value.toFixed(decimals)}${suffix}`;
  const formatSigned = (value: number | null | undefined, decimals = 2): string =>
    value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(decimals)}`;
  const complianceClass = (target: number): string => {
    if (integratedLufs === null) return 'text-[#666]';
    return Math.abs(integratedLufs - target) <= TARGET_TOLERANCE_DB ? 'text-[#00ff88] font-bold' : 'text-[#ffaa00]';
  };
  const complianceText = (target: number): string => {
    if (integratedLufs === null) return 'NOT MEASURED';
    const delta = integratedLufs - target;
    return Math.abs(delta) <= TARGET_TOLERANCE_DB ? 'ON TARGET' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB`;
  };

  return (
    <ModalFrame labelledBy="mastering-suite-modal-title" onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-md animate-fade-in select-none">
      <div className="bg-[#121215] border border-[#ff6e00]/40 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-[#e0e0e0]">
        {/* Header */}
        <div className="bg-[#18181c] border-b border-[#28282e] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ff3b00] flex items-center justify-center shadow-lg">
              <Activity className="w-4 h-4 text-black" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="mastering-suite-modal-title" className="text-sm font-black tracking-wide text-white uppercase">APEX MASTERING SUITE</h2>
                <span className="text-[10px] bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40 px-1.5 py-0.5 rounded font-mono font-bold">
                  ITU-R BS.1770-4 / EBU R128
                </span>
              </div>
              <p className="text-[11px] text-[#888]">
                Master bus measurement: gated loudness, inter-sample peak and stereo field. Processing controls below are
                stored intent only - the master chain is not wired yet.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              title="Phase 46 owns the master processing chain. Until it exists there is nothing to enable or bypass, so this reads as a fact rather than a switch."
              className="px-3 py-1 text-xs font-bold rounded flex items-center gap-1.5 bg-[#222] text-[#888] border border-[#333]"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>MASTER CHAIN: NOT APPLIED</span>
            </span>

            <button
              onClick={onClose}
              aria-label="Close mastering suite"
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
              <span>{`MASTER BUS FFT SPECTRUM (${MASTER_FFT_BINS} BINS${sampleRateHz ? ` · DC-${Math.round(sampleRateHz / 2000)}kHz` : ''})`}</span>
              <span className={isMeasuring ? 'text-[#00ff88]' : 'text-[#888]'}>
                {sampleRateHz
                  ? `${(sampleRateHz / 1000).toFixed(1)}kHz · 32-bit float · ${availabilityNote}`
                  : 'NO CONTEXT - SPECTRUM NOT MEASURED'}
              </span>
            </div>
            <canvas ref={canvasRef} width={760} height={60} className="w-full h-14 rounded bg-[#070709]" />
          </div>

          {/* Tab 1: Metering & LUFS */}
          {activeTab === 'metering' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                {/* Integrated LUFS */}
                <div className="bg-[#18181d] border border-[#282830] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-0.5">INTEGRATED LUFS</span>
                  <span className={`text-2xl font-mono font-black ${
                    integratedLufs === null
                      ? 'text-[#666]'
                      : Math.abs(lufsDelta ?? 0) <= 1.0 ? 'text-[#00ff88]' : (lufsDelta ?? 0) > 1.0 ? 'text-[#ff0055]' : 'text-[#ffaa00]'
                  }`}>
                    {formatDb(integratedLufs)}
                  </span>
                  <span className="text-[9px] text-[#777] mt-0.5 font-mono">
                    {integratedLufs === null
                      ? `Target ${lufsTargetValue} LUFS · ${measurement?.blockCount ?? 0} blocks measured`
                      : `Target ${lufsTargetValue} LUFS (${formatSigned(lufsDelta)} dB)`}
                  </span>
                  <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-2 overflow-hidden border border-[#333]">
                    <div 
                      className="h-full bg-gradient-to-r from-[#00ff88] via-[#ffaa00] to-[#ff0055]" 
                      style={{ width: `${integratedLufs === null ? 0 : Math.min(100, Math.max(0, (integratedLufs + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>

                {/* Short-Term LUFS */}
                <div className="bg-[#18181d] border border-[#282830] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-0.5">SHORT-TERM (3s)</span>
                  <span className="text-2xl font-mono font-black text-white">
                    {measurement?.shortTermReady ? formatDb(measurement?.shortTermLufs) : '—'}
                  </span>
                  <span className="text-[9px] text-[#777] mt-0.5">
                    {measurement?.shortTermReady
                      ? 'Rolling 3 s average'
                      : `COLLECTING ${Math.min(3, measurement?.measuredSeconds ?? 0).toFixed(1)}s / 3.0s`}
                  </span>
                  <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-2 overflow-hidden border border-[#333]">
                    <div 
                      className="h-full bg-[#ff6e00]" 
                      style={{ width: `${!measurement?.shortTermReady ? 0 : Math.min(100, Math.max(0, ((measurement?.shortTermLufs ?? -30) + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>

                {/* Momentary LUFS */}
                <div className="bg-[#18181d] border border-[#282830] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-0.5">MOMENTARY (400ms)</span>
                  <span className="text-2xl font-mono font-black text-[#00ffcc]">
                    {formatDb(measurement?.momentaryLufs)}
                  </span>
                  <span className="text-[9px] text-[#777] mt-0.5">
                    {measurement && measurement.blockCount > 0
                      ? `${measurement.gatedBlockCount}/${measurement.blockCount} blocks above gate`
                      : 'NO GATING BLOCKS YET'}
                  </span>
                  <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-2 overflow-hidden border border-[#333]">
                    <div 
                      className="h-full bg-[#00ffcc]" 
                      style={{ width: `${measurement?.momentaryLufs === null || measurement?.momentaryLufs === undefined ? 0 : Math.min(100, Math.max(0, (measurement.momentaryLufs + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>

                {/* True Peak dBFS */}
                <div className="bg-[#18181d] border border-[#282830] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[#888] uppercase tracking-wider mb-0.5">
                    TRUE PEAK dBFS ({measurement?.oversampleFactor ? `${measurement.oversampleFactor}× ISP` : 'ISP'})
                  </span>
                  <span className={`text-2xl font-mono font-black ${
                    measurement?.isClipping === null || measurement?.isClipping === undefined ? 'text-[#666]' : measurement.isClipping ? 'text-[#ff0055]' : 'text-white'
                  }`}>
                    {formatDb(measurement?.truePeakDbfs)} dB
                  </span>
                  <span className={`text-[9px] font-bold mt-0.5 ${
                    measurement?.isClipping ? 'text-[#ff0055]' : measurement?.isClipping === false ? 'text-[#00ff88]' : 'text-[#666]'
                  }`}>
                    {measurement?.isClipping === null || measurement?.isClipping === undefined
                      ? 'NOT MEASURED'
                      : measurement.isClipping
                        ? 'OVER 0 dBFS AFTER RECONSTRUCTION'
                        : `HEADROOM ${formatDb(measurement.headroomDb, 1, ' dB')}`}
                  </span>
                  <span className="text-[8px] text-[#666] mt-0.5 font-mono">
                    sample peak {formatDb(measurement?.samplePeakDbfs)} dBFS
                  </span>
                  <div className="w-full bg-[#0a0a0c] h-1.5 rounded-full mt-2 overflow-hidden border border-[#333]">
                    <div 
                      className={`h-full ${measurement?.isClipping ? 'bg-[#ff0055]' : 'bg-[#00ff88]'}`}
                      style={{ width: `${measurement?.truePeakDbfs === null || measurement?.truePeakDbfs === undefined ? 0 : Math.min(100, Math.max(0, (measurement.truePeakDbfs + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Goniometer + Stereo Phase Correlation Row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-[#141418] border border-[#282830] rounded-xl p-3">
                {/* 2D Goniometer Vector Scope */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-white flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-[#00ff88]" />
                      <span>2D GONIOMETER STEREO FIELD SCOPE</span>
                    </span>
                    <span className="text-[10px] font-mono text-[#888]">
                      {measurement?.isPumping ? 'Mid/Side from master tap' : 'NOT MEASURING'}
                    </span>
                  </div>
                  <div className="flex items-center justify-center bg-[#08080a] rounded-lg border border-[#222] p-1">
                    <canvas ref={goniometerCanvasRef} width={280} height={140} className="w-full max-w-[280px] h-32" />
                  </div>
                </div>

                {/* Phase Correlation Meter & Streaming Platform Matrix */}
                <div className="flex flex-col justify-between gap-2 text-xs">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white">STEREO PHASE CORRELATION</span>
                      <span className={`font-mono font-bold ${
                        measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined
                          ? 'text-[#666]'
                          : measurement.phaseCorrelation > 0.4 ? 'text-[#00ff88]' : measurement.phaseCorrelation >= 0 ? 'text-[#ffaa00]' : 'text-[#ff0055]'
                      }`}>
                        {formatSigned(measurement?.phaseCorrelation)}
                      </span>
                    </div>
                    {/* Phase Meter Bar: -1.0 to +1.0 */}
                    <div className="relative w-full h-3 bg-[#0a0a0c] rounded border border-[#333] overflow-hidden flex items-center">
                      <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-[#555] z-10" />
                      <div 
                        className={`h-full transition-all duration-75 ${
                          measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined
                            ? 'bg-[#333]'
                            : measurement.phaseCorrelation > 0.4 ? 'bg-[#00ff88]' : measurement.phaseCorrelation >= 0 ? 'bg-[#ffaa00]' : 'bg-[#ff0055]'
                        }`}
                        style={{
                          marginLeft: `${measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined ? 50 : Math.min(50, Math.max(0, (measurement.phaseCorrelation + 1) * 50))}%`,
                          width: `${measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined ? 0 : Math.abs(measurement.phaseCorrelation) * 50}%`
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-[8px] font-mono text-[#666]">
                      <span>-1.0 (Out of Phase)</span>
                      <span>0.0 (Wide Stereo)</span>
                      <span>+1.0 (Mono Coherent)</span>
                    </div>
                  </div>

                  {/* Streaming Targets Compliance Badges */}
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold text-[#888] uppercase block">STREAMING LOUDNESS TARGETS</span>
                    <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
                      <div className="bg-[#18181d] p-1.5 rounded border border-[#28282b] flex items-center justify-between">
                        <span>Spotify (-14 LUFS)</span>
                        <span className={complianceClass(-14)}>
                          {complianceText(-14)}
                        </span>
                      </div>
                      <div className="bg-[#18181d] p-1.5 rounded border border-[#28282b] flex items-center justify-between">
                        <span>Apple Music (-16 LUFS)</span>
                        <span className={complianceClass(-16)}>
                          {complianceText(-16)}
                        </span>
                      </div>
                      <div className="bg-[#18181d] p-1.5 rounded border border-[#28282b] flex items-center justify-between">
                        <span>Club / Beatport (-9 LUFS)</span>
                        <span className={complianceClass(-9)}>
                          {complianceText(-9)}
                        </span>
                      </div>
                      <div className="bg-[#18181d] p-1.5 rounded border border-[#28282b] flex items-center justify-between">
                        <span>YouTube (-14 LUFS)</span>
                        <span className={complianceClass(-14)}>
                          {complianceText(-14)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Multiband Dynamics */}
          {activeTab === 'multiband' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-3">
                <NotAppliedBanner label="3-BAND MULTIBAND COMPRESSOR" />
              </div>
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
                  <span className="text-[#666]">NOT MEASURED - NO LOW BAND COMPRESSOR IN PATH</span>
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
                  <span className="text-[#666]">NOT MEASURED - NO MID BAND COMPRESSOR IN PATH</span>
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
                  <span className="text-[#666]">NOT MEASURED - NO HIGH BAND COMPRESSOR IN PATH</span>
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: Stereo Imager & Sub Mono */}
          {activeTab === 'imager' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <NotAppliedBanner label="STEREO IMAGER / SUB-MONO" />
              </div>
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
              <div className="md:col-span-2">
                <NotAppliedBanner label="MAXIMIZER / BRICKWALL LIMITER" />
              </div>
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
                  <span className="text-xs font-bold text-white">INTER-SAMPLE PEAK MEASUREMENT</span>
                  <p className="text-[11px] text-[#888] mt-1">
                    The TRUE PEAK readout on the metering tab reconstructs the waveform at
                    {measurement?.oversampleFactor ? ` ${measurement.oversampleFactor}x ` : ' '} oversampling and reports the measured
                    inter-sample maximum. It measures only: nothing here limits, delays or protects the signal.
                  </p>
                </div>
                <div className="bg-[#0c0c0e] p-2.5 rounded border border-[#222] flex items-center justify-between text-xs font-mono">
                  <span className="text-[#888]">Lookahead / Latency</span>
                  <span className="text-[#666] font-bold">NONE - NOT IMPLEMENTED</span>
                </div>
              </div>
            </div>
          )}

          {/* Mastering Presets Library */}
          <div className="bg-[#141418] border border-[#282830] rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#ff6e00]" />
                MASTERING PRESETS
              </span>
            </div>
            <p className="text-[10px] text-[#888] -mt-1 mb-2">
              Selecting a preset stores values only. No processor reads them yet, so the sound of the project does not
              change and no export is affected.
            </p>

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
            STATUS: {availabilityNote}
            {' · '}
            {measurement && measurement.blockCount > 0
              ? `${measurement.measuredSeconds.toFixed(1)}s / ${measurement.blockCount} blocks measured`
              : 'NO MEASUREMENT YET'}
            {' · '}
            TRANSPORT: {isPlaying ? 'PLAYING' : 'STOPPED'}
            {measurement && measurement.droppedSampleCount > 0
              ? ` · ${measurement.droppedSampleCount} SAMPLES UNREAD (INCOMPLETE)`
              : ''}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition shadow"
          >
            Close
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
