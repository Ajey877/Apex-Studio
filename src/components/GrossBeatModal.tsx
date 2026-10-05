import React, { useState } from 'react';
import {
  X,
  Power,
  Sliders,
  Disc,
  Waves
} from 'lucide-react';
import { ModalFrame } from './ModalFrame';
import { GrossBeatState } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import {
  GROSS_BEAT_GATE_PRESETS,
  grossBeatAllOpenSteps,
  resolveGrossBeatClosedGain,
} from '../audio/grossBeatGate';

/**
 * Phase 57 - Gross Beat truth pass.
 *
 * This modal used to advertise a "TIME FX BUFFER" with half-time, buffer speed,
 * octave pitch drops and a turntable tape brake. The engine implements none of
 * that. It implements a 16-step amplitude gate on the master bus, and this
 * surface now says so.
 */

interface GrossBeatModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentStep: number;
  isPlaying: boolean;
  /** Phase 79: project-owned gate state. Same pattern as VocalTunerModal. */
  grossBeatState: GrossBeatState;
  onUpdateGrossBeat: (patch: Partial<GrossBeatState>) => void;
}

const BRAKE_DURATIONS = [250, 500, 800, 1200, 1800];

export const GrossBeatModal: React.FC<GrossBeatModalProps> = ({
  isOpen,
  onClose,
  currentStep,
  isPlaying,
  grossBeatState,
  onUpdateGrossBeat,
}) => {
  // Brake UI is transient (one-shot envelope trigger), not persisted — stays local.
  const [brakeDuration, setBrakeDuration] = useState<number>(600); // ms
  const [isBraking, setIsBraking] = useState<boolean>(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  if (!isOpen) return null;

  const publish = (patch: Partial<GrossBeatState>) => {
    // Push into ProjectState (undo/redo/save/load all round-trip through it).
    // App propagates the new state into audioEngine via the normal project
    // publication path, so the engine and document cannot diverge.
    onUpdateGrossBeat(patch);
  };

  const handleTogglePower = () => {
    publish({ enabled: !grossBeatState.enabled });
  };

  const handleMixChange = (val: number) => {
    publish({ mix: val });
  };

  const handlePresetSelect = (presetId: string) => {
    const found = GROSS_BEAT_GATE_PRESETS.find(p => p.id === presetId);
    if (!found) return;
    setActivePresetId(presetId);
    // Presets only ever write the gate pattern. They do not change tempo,
    // pitch or playback rate, because the engine has no such processing.
    publish({ enabled: true, gateSteps: [...found.steps] });
  };

  const handleStepToggle = (index: number) => {
    const newSteps = [...grossBeatState.gateSteps];
    newSteps[index] = !newSteps[index];
    setActivePresetId(null);
    publish({ gateSteps: newSteps });
  };

  const handleTriggerBrake = () => {
    setIsBraking(true);
    audioEngine.triggerMasterBrake(brakeDuration);
    setTimeout(() => {
      setIsBraking(false);
    }, brakeDuration + 100);
  };

  const closedGainPercent = Math.round(resolveGrossBeatClosedGain(grossBeatState.mix) * 100);

  return (
    <ModalFrame id="gross-beat-modal" labelledBy="gross-beat-modal-title" onClose={onClose} className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Modal Top Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ff9e40] flex items-center justify-center text-black shadow-md">
              <Waves className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="gross-beat-modal-title" className="text-sm font-bold text-white tracking-wide">MASTER GATE</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40">
                  AMPLITUDE GATE
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Sixteen-step amplitude gate on the master bus</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Power Switch */}
            <button
              onClick={handleTogglePower}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm ${
                grossBeatState.enabled
                  ? 'bg-[#ff6e00] text-black hover:bg-[#ff8526]'
                  : 'bg-[#222225] text-[#777] hover:text-white border border-[#333]'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{grossBeatState.enabled ? 'EFFECT ACTIVE' : 'BYPASS'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close Gross Beat"
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222225] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body Content */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-5">

          {/* Truth disclosure: what the gate does, and what it does not do. */}
          <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] space-y-1">
            <p className="text-[11px] text-[#b0b0b0]">
              16-step gate on the master bus, live and in export.
            </p>
            <p className="text-[10px] text-[#777] leading-relaxed">
              <span className="font-bold text-[#ff6e00]">NOT APPLIED:</span> no time-stretch, pitch-shift,
              half-time or tape processing &mdash; the engine gates gain on the steps below and nothing else.
            </p>
          </div>

          {/* Main Controls Header Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Gate Depth */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#888] font-bold text-[10px] uppercase">GATE DEPTH</span>
                <span className="font-mono text-[#ff6e00] font-bold text-xs">{Math.round(grossBeatState.mix * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={grossBeatState.mix}
                onChange={(e) => handleMixChange(parseFloat(e.target.value))}
                className="w-full h-1.5 accent-[#ff6e00] bg-[#121214] rounded cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-[#555] mt-1 font-mono">
                <span>0% open</span>
                <span>100% full chop</span>
              </div>
              <div className="text-[9px] text-[#777] mt-1 font-mono">
                Closed steps: {closedGainPercent}% gain
              </div>
            </div>

            {/* Master Brake Trigger */}
            <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] flex flex-col justify-between">
              <div className="flex items-center justify-between text-[10px] text-[#888] font-bold uppercase mb-1">
                <span>MASTER BRAKE</span>
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
                  <span>{isBraking ? 'BRAKING...' : 'BRAKE'}</span>
                </button>
                <select
                  value={brakeDuration}
                  onChange={(e) => setBrakeDuration(parseInt(e.target.value))}
                  className="bg-[#121214] text-white text-[10px] font-mono px-2 py-1.5 rounded border border-[#333336] focus:outline-none"
                >
                  {BRAKE_DURATIONS.map((duration) => (
                    <option key={duration} value={duration}>{duration}ms</option>
                  ))}
                </select>
              </div>
              <div className="text-[9px] text-[#555] mt-1 font-mono">
                Master gain fade to silence and back &mdash; not a tape or turntable stop.
              </div>
            </div>
          </div>

          {/* Preset Styles Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white font-bold text-xs flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>GATE PATTERN PRESETS</span>
              </span>
              <span className="text-[10px] text-[#777]">Click to load a pattern</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {GROSS_BEAT_GATE_PRESETS.map((p) => {
                const isActive = activePresetId === p.id && grossBeatState.enabled;
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

          {/* 16-Step Interactive Amplitude Gate Grid */}
          <div className="bg-[#18181b] p-4 rounded-xl border border-[#28282b] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white">16-STEP AMPLITUDE GATE GRID</span>
                <span className="text-[10px] font-mono text-[#777]">1/16 beat grid</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setActivePresetId(null);
                    publish({ gateSteps: grossBeatAllOpenSteps() });
                  }}
                  className="px-2 py-0.5 rounded text-[9px] bg-[#222225] text-[#888] hover:text-white"
                >
                  All Open
                </button>
                <button
                  onClick={() => {
                    setActivePresetId(null);
                    publish({ gateSteps: grossBeatState.gateSteps.map(s => !s) });
                  }}
                  className="px-2 py-0.5 rounded text-[9px] bg-[#222225] text-[#888] hover:text-white"
                >
                  Invert
                </button>
              </div>
            </div>

            {/* 16 Step Buttons */}
            <div className="grid grid-cols-16 gap-1 sm:gap-1.5 h-20 items-end bg-[#0e0e10] p-2 rounded-lg border border-[#222225]">
              {grossBeatState.gateSteps.map((isActive, idx) => {
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
            <Waves className="w-3.5 h-3.5 text-[#ff6e00]" />
            <span>Master Bus Amplitude Gate</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff8526] text-black font-bold text-xs rounded transition shadow"
          >
            Apply &amp; Close
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
