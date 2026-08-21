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
    <div id="gross-beat-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Modal Top Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ff9e40] flex items-center justify-center text-black shadow-md">
              <Waves className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">GROSS BEAT & TIME FX BUFFER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40">
                  STUDIO DSP
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Half-Time, Turntable Tape-Stop & 16-Step Rhythmic Gater</p>
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
              <div className="text-[9px] text-[#777] mt-1 truncate">
                {grossState.speed === 0.5 ? 'Octave down pitch drop' : 'Standard sync rate'}
              </div>
            </div>

            {/* Instant Tape Brake Trigger */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div className="flex items-center justify-between text-[10px] text-[#888] font-bold uppercase mb-1">
                <span>TURNTABLE BRAKE</span>
                <span className="text-white font-mono">{brakeDuration}ms</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTriggerBrake}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                    isBraking
                      ? 'bg-red-500 text-white animate-pulse'
                      : 'bg-[#222225] hover:bg-[#ff6e00] hover:text-black text-white border border-[#333336]'
                  }`}
                >
                  <Disc className={`w-3.5 h-3.5 ${isBraking ? 'animate-spin' : ''}`} />
                  <span>{isBraking ? 'STOPPING...' : 'TAPE STOP'}</span>
                </button>
                <select
                  value={brakeDuration}
                  onChange={(e) => setBrakeDuration(parseInt(e.target.value))}
                  className="bg-[#121214] text-white text-[10px] font-mono px-2 py-1.5 rounded border border-[#333336] focus:outline-none"
                >
                  <option value="250">250ms</option>
                  <option value="500">500ms</option>
                  <option value="800">800ms</option>
                  <option value="1200">1.2s</option>
                  <option value="1800">1.8s</option>
                </select>
              </div>
              <div className="text-[9px] text-[#555] mt-1 font-mono">Simulates analog turntable shutoff</div>
            </div>
          </div>

          {/* Preset Styles Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white font-bold text-xs flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>CHOPPER & RHYTHMIC PRESETS</span>
              </span>
              <span className="text-[10px] text-[#777]">Click to load pattern</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PRESETS.map((p) => {
                const isActive = grossState.preset === p.id && grossState.enabled;
                return (
                  <button
                    key={p.id}
                    onClick={() => handlePresetSelect(p.id)}
                    className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
                      isActive
                        ? 'bg-[#1e1710] border-[#ff6e00] text-white shadow-md'
                        : 'bg-[#18181b] border-[#28282b] text-[#999] hover:text-white hover:border-[#3e3e42]'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-bold text-xs text-white">{p.name}</span>
                      {isActive && <span className="w-2 h-2 rounded-full bg-[#ff6e00]"></span>}
                    </div>
                    <span className="text-[10px] text-[#666] mt-1">{p.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 16-Step Interactive Rhythmic Gate Visualizer */}
          <div className="bg-[#18181b] p-4 rounded-xl border border-[#28282b] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white">16-STEP TIME CHOPPER GRID</span>
                <span className="text-[10px] font-mono text-[#777]">1/16 Beat Grid</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const allOn = new Array(16).fill(true);
                    const updated = { ...grossState, gateSteps: allOn };
                    setGrossState(updated);
                    audioEngine.setGrossBeatState(updated);
                  }}
                  className="px-2 py-0.5 rounded text-[9px] bg-[#222225] text-[#888] hover:text-white"
                >
                  All Active
                </button>
                <button
                  onClick={() => {
                    const inv = grossState.gateSteps.map(s => !s);
                    const updated = { ...grossState, gateSteps: inv };
                    setGrossState(updated);
                    audioEngine.setGrossBeatState(updated);
                  }}
                  className="px-2 py-0.5 rounded text-[9px] bg-[#222225] text-[#888] hover:text-white"
                >
                  Invert
                </button>
              </div>
            </div>

            {/* 16 Step Buttons */}
            <div className="grid grid-cols-16 gap-1 sm:gap-1.5 h-20 items-end bg-[#0e0e10] p-2 rounded-lg border border-[#222225]">
              {grossState.gateSteps.map((isActive, idx) => {
                const isCurrent = isPlaying && currentStep === idx;
                const isBeatStart = idx % 4 === 0;

                return (
                  <div
                    key={idx}
                    onClick={() => handleStepToggle(idx)}
                    className={`h-full flex flex-col justify-end cursor-pointer rounded transition group relative ${
                      isBeatStart ? 'border-l border-[#333338]' : ''
                    }`}
                  >
                    {/* Playhead Marker */}
                    {isCurrent && (
                      <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-white animate-ping"></div>
                    )}

                    {/* Step Height Bar */}
                    <div
                      className={`w-full rounded-t transition-all ${
                        isActive
                          ? isCurrent
                            ? 'bg-white h-full shadow-lg'
                            : 'bg-[#ff6e00] hover:bg-[#ff8c33] h-full shadow'
                          : 'bg-[#222225] hover:bg-[#333338] h-3'
                      }`}
                    />

                    {/* Step Index Label */}
                    <span className={`text-[8px] font-mono text-center mt-1 ${isCurrent ? 'text-white font-bold' : 'text-[#555]'}`}>
                      {idx + 1}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between text-[9px] text-[#666] font-mono">
              <span>Beat 1 (1-4)</span>
              <span>Beat 2 (5-8)</span>
              <span>Beat 3 (9-12)</span>
              <span>Beat 4 (13-16)</span>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 bg-[#18181b] border-t border-[#2e2e32] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-[#777]">
            <Clock className="w-3.5 h-3.5 text-[#ff6e00]" />
            <span>Master Bus Time Manipulation</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff8526] text-black font-bold text-xs rounded transition shadow"
          >
            Apply & Close
          </button>
        </div>
      </div>
    </div>
  );
};
