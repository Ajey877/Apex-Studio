import React, { useState, useEffect } from 'react';
import { 
  X, 
  Power, 
  Disc, 
  Sliders, 
  Play, 
  RotateCcw, 
  Zap, 
  Sparkles,
  Volume2,
  Clock,
  Waves
} from 'lucide-react';
import { GrossBeatState } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface GrossBeatModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentStep: number;
  isPlaying: boolean;
}

const PRESETS: { id: GrossBeatState['preset']; name: string; desc: string; steps: boolean[]; speed: 0.5 | 1.0 | 2.0 }[] = [
  {
    id: 'half_time',
    name: 'Half-Time (1/2x Speed)',
    desc: 'Trap & Hip-Hop half-tempo octave drop',
    steps: [true, true, true, true, false, false, false, false, true, true, true, true, false, false, false, false],
    speed: 0.5
  },
  {
    id: 'tape_stop',
    name: 'Vinyl Tape Brake',
    desc: 'Turntable motor stop pitch drop curve',
    steps: [true, true, true, true, true, true, true, true, false, false, false, false, false, false, false, false],
    speed: 1.0
  },
  {
    id: 'trance_gate',
    name: 'Trance 16-Step Gate',
    desc: 'Classic EDM side-chopped rhythmic envelope',
    steps: [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false],
    speed: 1.0
  },
  {
    id: 'sidechain_pump',
    name: 'Sidechain 4-on-Floor Pump',
    desc: 'Deep French house pumping curve',
    steps: [false, true, true, true, false, true, true, true, false, true, true, true, false, true, true, true],
    speed: 1.0
  },
  {
    id: 'triplet_chopper',
    name: 'Triplet Drill Chopper',
    desc: 'UK Drill & Trap syncopated stutter',
    steps: [true, true, false, true, true, false, true, true, false, true, true, false, true, false, true, false],
    speed: 1.0
  },
  {
    id: 'stutter_32',
    name: '1/32 Micro Stutter',
    desc: 'High-speed glitch build-up',
    steps: [true, false, true, false, true, true, false, true, false, true, true, false, true, false, true, true],
    speed: 2.0
  }
];

export const GrossBeatModal: React.FC<GrossBeatModalProps> = ({
  isOpen,
  onClose,
  currentStep,
  isPlaying
}) => {
  const [grossState, setGrossState] = useState<GrossBeatState>(() => audioEngine.getGrossBeatState());
  const [brakeDuration, setBrakeDuration] = useState<number>(600); // ms
  const [isBraking, setIsBraking] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setGrossState(audioEngine.getGrossBeatState());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTogglePower = () => {
    const updated = { ...grossState, enabled: !grossState.enabled };
    setGrossState(updated);
    audioEngine.setGrossBeatState(updated);
  };

  const handleMixChange = (val: number) => {
    const updated = { ...grossState, mix: val };
    setGrossState(updated);
    audioEngine.setGrossBeatState(updated);
  };

  const handlePresetSelect = (presetId: GrossBeatState['preset']) => {
    const found = PRESETS.find(p => p.id === presetId);
    if (!found) return;
    const updated: GrossBeatState = {
      ...grossState,
      enabled: true,
      preset: presetId,
      gateSteps: [...found.steps],
      speed: found.speed
    };
    setGrossState(updated);
    audioEngine.setGrossBeatState(updated);
  };

  const handleStepToggle = (index: number) => {
    const newSteps = [...grossState.gateSteps];
    newSteps[index] = !newSteps[index];
    const updated = { ...grossState, gateSteps: newSteps };
    setGrossState(updated);
    audioEngine.setGrossBeatState(updated);
  };

  const handleTriggerBrake = () => {
    setIsBraking(true);
    audioEngine.triggerTapeStop(brakeDuration);
    setTimeout(() => {
      setIsBraking(false);
    }, brakeDuration + 100);
  };

  return (
    <div id="time-fx-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Modal Top Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ff9e40] flex items-center justify-center text-black shadow-md">
              <Waves className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">TIME FX & RHYTHMIC GATE</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40">
                  STUDIO DSP
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Half-Time, Tape-Stop & 16-Step Rhythmic Gater</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Power Switch */}
            <button
              onClick={handleTogglePower}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm ${
                grossState.enabled
                  ? 'bg-[#ff6e00] text-black hover:bg-[#ff8526]'
                  : 'bg-[#222225] text-[#777] hover:text-white border border-[#333]'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{grossState.enabled ? 'EFFECT ACTIVE' : 'BYPASS'}</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222225] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body Content */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-5">
          {/* Main Controls Header Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Mix Wet/Dry */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#888] font-bold text-[10px] uppercase">WET / DRY MIX</span>
                <span className="font-mono text-[#ff6e00] font-bold text-xs">{Math.round(grossState.mix * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={grossState.mix}
                onChange={(e) => handleMixChange(parseFloat(e.target.value))}
                className="w-full h-1.5 accent-[#ff6e00] bg-[#121214] rounded cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-[#555] mt-1 font-mono">
                <span>0% Dry</span>
                <span>100% Full Wet</span>
              </div>
            </div>

            {/* Playback Speed Multiplier */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <span className="text-[#888] font-bold text-[10px] uppercase mb-1">TIME BUFFER SPEED</span>
              <div className="grid grid-cols-3 gap-1">
                {[
                  { label: '1/2x Half', val: 0.5 },
                  { label: '1x Norm', val: 1.0 },
                  { label: '2x Fast', val: 2.0 }
                ].map((sp) => (
                  <button
                    key={sp.val}
                    onClick={() => {
                      const updated = { ...grossState, speed: sp.val as 0.5 | 1.0 | 2.0 };
                      setGrossState(updated);
                      audioEngine.setGrossBeatState(updated);
                    }}
                    className={`py-1 rounded text-[10px] font-bold transition font-mono ${
                      grossState.speed === sp.val
                        ? 'bg-[#ff6e00] text-black'
                        : 'bg-[#121214] text-[#888] hover:text-white border border-[#28282b]'
                    }`}
                  >
                    {sp.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tape Stop */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[#888] font-bold text-[10px] uppercase">TAPE STOP</span>
                <Disc className={`w-3.5 h-3.5 ${isBraking ? 'animate-spin text-[#ff6e00]' : 'text-[#555]'}`} />
              </div>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="range"
                  min="100"
                  max="2000"
                  step="50"
                  value={brakeDuration}
                  onChange={(e) => setBrakeDuration(parseInt(e.target.value))}
                  className="flex-1 h-1 accent-[#ff6e00] bg-[#121214] rounded cursor-pointer"
                />
                <span className="font-mono text-[9px] text-[#ff6e00]">{brakeDuration}ms</span>
              </div>
              <button
                onClick={handleTriggerBrake}
                disabled={isBraking}
                className="mt-2 py-1.5 bg-[#121214] border border-[#333] hover:border-[#ff6e00] hover:text-[#ff6e00] disabled:opacity-50 rounded text-[9px] font-bold transition"
              >
                {isBraking ? 'BRAKING...' : 'TRIGGER STOP'}
              </button>
            </div>
          </div>

          {/* Presets */}
          <div>
            <div className="flex items-center gap-2 mb-2 text-[10px] font-bold text-[#888] uppercase">
              <Sparkles className="w-3 h-3 text-[#ff6e00]" />
              RHYTHMIC PRESETS
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {PRESETS.map(preset => (
                <button
                  key={preset.id}
                  onClick={() => handlePresetSelect(preset.id)}
                  className={`p-2 text-left rounded border transition ${
                    grossState.preset === preset.id
                      ? 'bg-[#ff6e00]/10 border-[#ff6e00]/50 text-[#ff6e00]'
                      : 'bg-[#18181b] border-[#28282b] hover:border-[#555] text-[#aaa]'
                  }`}
                >
                  <div className="text-[10px] font-bold truncate">{preset.name}</div>
                  <div className="text-[8px] text-[#555] mt-0.5 truncate">{preset.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Step Grid */}
          <div className="bg-[#18181b] border border-[#28282b] rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-[10px] font-bold text-[#888] uppercase">
                <Sliders className="w-3 h-3 text-[#ff6e00]" />
                16-STEP RHYTHMIC GATE
              </div>
              <div className="text-[9px] font-mono text-[#555]">STEP {currentStep % 16 + 1} / 16</div>
            </div>
            <div className="grid grid-cols-8 sm:grid-cols-16 gap-1">
              {grossState.gateSteps.map((active, idx) => (
                <button
                  key={idx}
                  onClick={() => handleStepToggle(idx)}
                  className={`h-8 rounded border text-[8px] font-mono font-bold transition ${
                    active
                      ? 'bg-[#ff6e00] text-black border-[#ff6e00]'
                      : 'bg-[#121214] text-[#555] border-[#28282b] hover:border-[#555]'
                  } ${idx === currentStep % 16 ? 'ring-1 ring-white' : ''}`}
                >
                  {idx + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[9px] text-[#555] leading-relaxed border-t border-[#222] pt-3">
            <span className="text-[#888] font-bold">APEX TIME FX:</span> A real-time rhythmic effect combining gated amplitude, time feel changes and tape-style stop transitions. All processing runs locally through the project audio engine.
          </div>
        </div>
      </div>
    </div>
  );
};
