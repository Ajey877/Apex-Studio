import React, { useState } from 'react';
import { ModalFrame } from './ModalFrame';
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  /**
   * Phase 52: this panel used to animate a pitch needle from `Math.sin(phase)`
   * and print the result as "Detected: <note> (<n>Hz)" next to a control
   * labelled REAL-TIME PITCH QUANTIZER. No microphone is opened and no pitch
   * detection exists anywhere in the app, so every one of those numbers was
   * invented. The readout is gone rather than restyled: a meter may show less,
   * but it must never show a measurement it did not make.
   */
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
    <ModalFrame id="fl-vocal-tuner-modal" labelledBy="fl-vocal-tuner-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00e5ff] to-[#0077ff] flex items-center justify-center text-black shadow-md">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-vocal-tuner-modal-title" className="text-sm font-bold text-white tracking-wide">AUTO-PITCH & VOCAL TUNER</h2>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                  vocalTunerSettings.enabled 
                    ? 'bg-[#00ff88]/20 text-[#00ff88] border-[#00ff88]/40' 
                    : 'bg-[#333]/20 text-[#777] border-[#444]'
                }`}>
                  {vocalTunerSettings.enabled ? 'ENABLED (NOT APPLIED)' : 'DISABLED'}
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Scale, retune, formant and vibrato settings — stored with the project, not applied to audio in this build</p>
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
              <span>{vocalTunerSettings.enabled ? 'ON (STORED)' : 'OFF'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close vocal tuner"
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
          {/* Phase 79: preset/root/scale/knob matrix is STORED INTENT only — wrapped in a
              single disabled fieldset with a uniform "NOT APPLIED" banner so no control
              appears to be altering live audio. onUpdateVocalTuner still fires so the
              values persist as project intent for a future vocal-tuner phase. */}
          <fieldset disabled className="opacity-60 relative">
            <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ffaa00]/20 text-[#ffaa00] border border-[#ffaa00]/40 z-10">
              NOT APPLIED — STORED INTENT
            </div>
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
          <div className="bg-[#0a0a0c] border border-[#ffaa00]/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono font-bold text-[#ffaa00] uppercase tracking-wider">
              AUTO-PITCH: NOT APPLIED — NO PROCESSING IN SIGNAL PATH
            </span>
            <span className="text-[10px] text-[#777] whitespace-nowrap">STORED AS PROJECT INTENT</span>
          </div>

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

          {/* Pitch quantizer — no detection exists, so nothing is measured. */}
          <div className="bg-[#0f0f12] rounded-xl border border-[#ffaa00]/40 p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#ffaa00]" />
                <span className="font-bold text-white">PITCH DETECTION UNAVAILABLE</span>
              </div>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ffaa00]/20 text-[#ffaa00] border border-[#ffaa00]/40">
                NOT APPLIED — NO PITCH ANALYSIS IN SIGNAL PATH
              </span>
            </div>

            <div className="w-full h-24 rounded-lg bg-[#0a0a0c] border border-[#222225] flex items-center justify-center px-5">
              <p className="text-[11px] text-[#888] text-center font-mono leading-relaxed">
                NO MEASURED PITCH
                <span className="block mt-1.5 font-sans">
                  This build does not analyse audio, so there is no detected note, frequency or cents value to show.
                  The controls below are stored with the project as intent.
                </span>
              </p>
            </div>
          </div>

          {/* Knobs Matrix: Retune Speed, Formants, Vibrato, Humanize — STORED INTENT ONLY.
              Phase 79: these sliders are kept for intent-storage (so a future vocal-tuner
              phase can read the user's saved preferences) but the panel is disabled and
              labelled so no control implies the engine is processing audio. */}
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
          </fieldset>
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
                setStatusMessage('Reset to Default Auto-Pitch snap');
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
    </ModalFrame>
  );
};
