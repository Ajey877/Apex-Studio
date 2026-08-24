import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, 
  X, 
  Sparkles, 
  Zap, 
  Sliders, 
  Radio, 
  Music, 
  Volume2, 
  Check, 
  Activity, 
  RotateCcw,
  Headphones,
  Gauge
} from 'lucide-react';
import { VocalTunerSettings, MusicalScale, Channel } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface VocalTunerModalProps {
  isOpen: boolean;
  onClose: () => void;
  vocalTunerSettings: VocalTunerSettings;
  onUpdateVocalTuner: (settings: VocalTunerSettings) => void;
  channels: Channel[];
}

const ROOT_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALES: { id: MusicalScale; label: string }[] = [
  { id: 'chromatic' as any, label: 'Chromatic (All 12 Notes)' },
  { id: 'major', label: 'Major (Natural / Happy)' },
  { id: 'minor', label: 'Natural Minor (Aeolian / Emotional)' },
  { id: 'harmonic_minor', label: 'Harmonic Minor (Dark / Neo-Classical)' },
  { id: 'pentatonic_minor', label: 'Pentatonic Minor (Trap / Blues / Rock)' },
  { id: 'pentatonic_major', label: 'Pentatonic Major (R&B / Soul)' },
  { id: 'dorian', label: 'Dorian (Deep House / Funk)' },
  { id: 'phrygian', label: 'Phrygian (Spanish / Phonk)' },
  { id: 'lydian', label: 'Lydian (Ethereal / Dream)' },
  { id: 'mixolydian', label: 'Mixolydian (Blues / Southern)' },
  { id: 'blues', label: 'Blues Scale' },
  { id: 'arabic_double_harmonic', label: 'Arabic / Byzantine' }
];

const PRESETS = [
  {
    name: 'Hard Robotic Snap (T-Pain / Travis Scott)',
    retuneSpeedMs: 0,
    formantShift: 0,
    vibratoDepth: 0,
    humanize: 0,
    scale: 'minor' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'Modern Pop Polish (Ariana / The Weeknd)',
    retuneSpeedMs: 18,
    formantShift: 0.5,
    vibratoDepth: 0.2,
    humanize: 0.35,
    scale: 'minor' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'Deep Trap Pitch Down (-3 Semitones)',
    retuneSpeedMs: 5,
    formantShift: -3,
    vibratoDepth: 0.1,
    humanize: 0.1,
    scale: 'minor' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'High Chipmunk Hyperpop (+4 Semitones)',
    retuneSpeedMs: 0,
    formantShift: 4,
    vibratoDepth: 0.3,
    humanize: 0.2,
    scale: 'major' as MusicalScale,
    rootKey: 0
  },
  {
    name: 'Transparent Vocal Glue (Natural)',
    retuneSpeedMs: 45,
    formantShift: 0,
    vibratoDepth: 0.4,
    humanize: 0.75,
    scale: 'major' as MusicalScale,
    rootKey: 0
  }
];

export const VocalTunerModal: React.FC<VocalTunerModalProps> = ({
  isOpen,
  onClose,
  vocalTunerSettings,
  onUpdateVocalTuner,
  channels
}) => {
  const [selectedChannelId, setSelectedChannelId] = useState<string>(channels[0]?.id || '');
  const [isLiveMicActive, setIsLiveMicActive] = useState(false);
  const [detectedPitch, setDetectedPitch] = useState<{ note: string; cents: number; hz: number }>({
    note: 'A4',
    cents: 0,
    hz: 440
  });
  const [targetSnapNote, setTargetSnapNote] = useState<string>('A4');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Animate tuner pitch needle & chromatic pitch wheel
  useEffect(() => {
    if (!isOpen) return;

    let animId: number;
    let phase = 0;

    const render = () => {
      phase += 0.05;
      // Simulated live pitch fluctuation around key root
      const rootOffset = vocalTunerSettings.rootKey;
      const baseHz = 220 * Math.pow(2, (rootOffset + Math.sin(phase) * 1.5) / 12);
      const semitone = Math.round(12 * Math.log2(baseHz / 440)) + 69;
      const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const noteName = noteNames[semitone % 12] + Math.floor(semitone / 12 - 1);
      const cents = Math.round((Math.sin(phase * 1.3) * (vocalTunerSettings.retuneSpeedMs > 10 ? 35 : 5)));

      setDetectedPitch({
        note: noteName,
        cents: cents,
        hz: Math.round(baseHz)
      });
      setTargetSnapNote(noteNames[(rootOffset + (vocalTunerSettings.scale === 'minor' ? 3 : 4)) % 12] + '4');

      drawTunerCanvas(cents);
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [isOpen, vocalTunerSettings]);

  const drawTunerCanvas = (cents: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, '#0e0e12');
    bgGrad.addColorStop(1, '#16161c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Center pitch target line
    const centerX = width / 2;
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, 15);
    ctx.lineTo(centerX, height - 15);
    ctx.stroke();

    // Scale tick marks (-50 to +50 cents)
    for (let c = -50; c <= 50; c += 10) {
      const x = centerX + (c / 50) * (width * 0.42);
      ctx.strokeStyle = c === 0 ? '#00ff88' : '#333338';
      ctx.lineWidth = c % 25 === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, height / 2 - 15);
      ctx.lineTo(x, height / 2 + 15);
      ctx.stroke();

      if (c % 25 === 0) {
        ctx.fillStyle = '#66666c';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${c > 0 ? '+' : ''}${c}`, x, height / 2 + 28);
      }
    }

    // Detected pitch indicator needle
    const clampedCents = Math.max(-50, Math.min(50, cents));
    const needleX = centerX + (clampedCents / 50) * (width * 0.42);

    // Glow around needle
    const isTuned = Math.abs(cents) < 8;
    ctx.fillStyle = isTuned ? '#00ff88' : '#ff0055';
    ctx.shadowColor = isTuned ? '#00ff88' : '#ff0055';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(needleX, height / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Pitch label text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${clampedCents > 0 ? '+' : ''}${clampedCents} ct`, needleX, height / 2 - 18);
  };

  const handleApplyPreset = (preset: typeof PRESETS[0]) => {
    onUpdateVocalTuner({
      ...vocalTunerSettings,
      retuneSpeedMs: preset.retuneSpeedMs,
      formantShift: preset.formantShift,
      vibratoDepth: preset.vibratoDepth,
      humanize: preset.humanize,
      scale: preset.scale,
      rootKey: preset.rootKey
    });
    setStatusMessage(`Applied preset: ${preset.name}`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  if (!isOpen) return null;

  return (
    <div id="fl-vocal-tuner-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00e5ff] to-[#0077ff] flex items-center justify-center text-black shadow-md">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">PITCHER & NEWTONE VOCAL TUNER</h2>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                  vocalTunerSettings.enabled 
                    ? 'bg-[#00ff88]/20 text-[#00ff88] border-[#00ff88]/40' 
                    : 'bg-[#333]/20 text-[#777] border-[#444]'
                }`}>
                  {vocalTunerSettings.enabled ? 'ACTIVE' : 'BYPASSED'}
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Real-time vocal scale snapping, robotic retune & formant shifting</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onUpdateVocalTuner({ ...vocalTunerSettings, enabled: !vocalTunerSettings.enabled })}
              className={`px-3 py-1 rounded text-xs font-bold transition flex items-center gap-1.5 ${
                vocalTunerSettings.enabled 
                  ? 'bg-[#00ff88] text-black shadow-md' 
                  : 'bg-[#222225] text-[#888] hover:text-white border border-[#333]'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{vocalTunerSettings.enabled ? 'ON' : 'OFF'}</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222225] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toast */}
        {statusMessage && (
          <div className="bg-[#00e5ff] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Quick Presets Bar */}
          <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] space-y-2">
            <span className="text-[10px] text-[#888] font-bold uppercase tracking-wider block">PRO VOCAL PRESETS</span>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p, idx) => (
                <button
                  key={idx}
                  onClick={() => handleApplyPreset(p)}
                  className="px-2.5 py-1 rounded bg-[#121214] hover:bg-[#222225] text-white text-[11px] font-semibold border border-[#333336] transition hover:border-[#00e5ff]"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* Scale & Key Lock Engine */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Root Key */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] space-y-2">
              <span className="text-[10px] text-[#888] font-bold uppercase block">1. MUSICAL ROOT KEY</span>
              <div className="grid grid-cols-6 gap-1">
                {ROOT_KEYS.map((k, idx) => (
                  <button
                    key={k}
                    onClick={() => onUpdateVocalTuner({ ...vocalTunerSettings, rootKey: idx })}
                    className={`py-1.5 rounded font-mono font-bold text-xs transition ${
                      vocalTunerSettings.rootKey === idx 
                        ? 'bg-[#00e5ff] text-black shadow-md' 
                        : 'bg-[#121214] text-[#888] hover:text-white border border-[#28282b]'
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            {/* Musical Scale */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] space-y-2">
              <span className="text-[10px] text-[#888] font-bold uppercase block">2. TARGET MUSICAL SCALE</span>
              <select
                value={vocalTunerSettings.scale}
                onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, scale: e.target.value as any })}
                className="w-full bg-[#121214] text-white text-xs px-2.5 py-2 rounded border border-[#333336] focus:outline-none font-semibold"
              >
                {SCALES.map(s => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Real-time Tuner Needle Canvas Display */}
          <div className="bg-[#0f0f12] rounded-xl border border-[#28282b] p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#00ff88]" />
                <span className="font-bold text-white">REAL-TIME PITCH QUANTIZER</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span className="text-[#888]">Detected: <strong className="text-white">{detectedPitch.note}</strong> ({detectedPitch.hz}Hz)</span>
                <span className="text-[#00ff88]">Snapped: <strong>{targetSnapNote}</strong></span>
              </div>
            </div>

            <canvas
              ref={canvasRef}
              width={700}
              height={90}
              className="w-full h-24 rounded-lg bg-[#0a0a0c] border border-[#222225]"
            />
          </div>

          {/* Knobs Matrix: Retune Speed, Formants, Vibrato, Humanize */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Retune Speed */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[10px] text-[#888] font-bold uppercase mb-1">
                  <span>RETUNE SPEED</span>
                  <span className="text-[#00e5ff] font-mono">{vocalTunerSettings.retuneSpeedMs} ms</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="80"
                  step="1"
                  value={vocalTunerSettings.retuneSpeedMs}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, retuneSpeedMs: parseInt(e.target.value) })}
                  className="w-full h-1.5 accent-[#00e5ff] bg-[#121214] rounded cursor-pointer"
                />
              </div>
              <span className="text-[9px] text-[#555] mt-1 font-mono">
                {vocalTunerSettings.retuneSpeedMs === 0 ? 'Robotic Snap (0ms)' : vocalTunerSettings.retuneSpeedMs < 20 ? 'Modern Tight' : 'Natural Transparent'}
              </span>
            </div>

            {/* Formant Shift */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[10px] text-[#888] font-bold uppercase mb-1">
                  <span>FORMANT SHIFT</span>
                  <span className="text-[#00ff88] font-mono">{vocalTunerSettings.formantShift > 0 ? `+${vocalTunerSettings.formantShift}` : vocalTunerSettings.formantShift} st</span>
                </div>
                <input
                  type="range"
                  min="-12"
                  max="12"
                  step="0.5"
                  value={vocalTunerSettings.formantShift}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, formantShift: parseFloat(e.target.value) })}
                  className="w-full h-1.5 accent-[#00ff88] bg-[#121214] rounded cursor-pointer"
                />
              </div>
              <span className="text-[9px] text-[#555] mt-1 font-mono">
                {vocalTunerSettings.formantShift < 0 ? 'Deep Throat / Male' : vocalTunerSettings.formantShift > 0 ? 'Chipmunk / Hyperpop' : 'Natural Throat'}
              </span>
            </div>

            {/* Vibrato Depth */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[10px] text-[#888] font-bold uppercase mb-1">
                  <span>VIBRATO DEPTH</span>
                  <span className="text-[#ff6e00] font-mono">{Math.round(vocalTunerSettings.vibratoDepth * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={vocalTunerSettings.vibratoDepth}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, vibratoDepth: parseFloat(e.target.value) })}
                  className="w-full h-1.5 accent-[#ff6e00] bg-[#121214] rounded cursor-pointer"
                />
              </div>
              <span className="text-[9px] text-[#555] mt-1 font-mono">LFO Pitch Modulation</span>
            </div>

            {/* Humanize */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[10px] text-[#888] font-bold uppercase mb-1">
                  <span>HUMANIZE</span>
                  <span className="text-[#a855f7] font-mono">{Math.round(vocalTunerSettings.humanize * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={vocalTunerSettings.humanize}
                  onChange={(e) => onUpdateVocalTuner({ ...vocalTunerSettings, humanize: parseFloat(e.target.value) })}
                  className="w-full h-1.5 accent-[#a855f7] bg-[#121214] rounded cursor-pointer"
                />
              </div>
              <span className="text-[9px] text-[#555] mt-1 font-mono">Micro-variation preserve</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181b] border-t border-[#2e2e32] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onUpdateVocalTuner({
                  enabled: true,
                  scale: 'minor',
                  rootKey: 0,
                  retuneSpeedMs: 0,
                  formantShift: 0,
                  vibratoDepth: 0,
                  humanize: 0
                });
                setStatusMessage('Reset to Default Auto-Tune snap');
              }}
              className="flex items-center gap-1 px-3 py-1.5 bg-[#222225] hover:bg-[#333338] text-white rounded transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Tuner</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#00e5ff] hover:bg-[#00cce6] text-black font-bold rounded transition"
          >
            Apply & Done
          </button>
        </div>
      </div>
    </div>
  );
};
