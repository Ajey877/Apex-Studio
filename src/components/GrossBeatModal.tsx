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
    <ModalFrame id="gross-beat-modal" labelledBy="gross-beat-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-2xl shadow-[var(--apex-shadow)] overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Modal Top Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-gold)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md">
              <Waves className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="gross-beat-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">MASTER GATE</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-gold)_40%,transparent)]">
                  AMPLITUDE GATE
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Sixteen-step amplitude gate on the master bus</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Power Switch */}
            <button
              onClick={handleTogglePower}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm ${
                grossBeatState.enabled
                  ? 'bg-[var(--apex-success)] text-[var(--apex-state-playing-fg)] hover:bg-[color-mix(in_srgb,var(--apex-success)_86%,var(--apex-text))]'
                  : 'bg-[var(--apex-surface-3)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)] hover:bg-[var(--apex-state-hover)] border border-[var(--apex-border)]'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{grossBeatState.enabled ? 'EFFECT ACTIVE' : 'BYPASS'}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close Gross Beat"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-surface-3)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body Content */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-5">

          {/* Truth disclosure: what the gate does, and what it does not do. */}
          <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] space-y-1">
            <p className="text-[11px] text-[var(--apex-text-2)]">
              16-step gate on the master bus, live and in export.
            </p>
            <p className="text-[10px] text-[var(--apex-text-3)] leading-relaxed">
              <span className="font-bold text-[var(--apex-gold)]">NOT APPLIED:</span> no time-stretch, pitch-shift,
              half-time or tape processing &mdash; the engine gates gain on the steps below and nothing else.
            </p>
          </div>

          {/* Main Controls Header Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Gate Depth */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[var(--apex-text-2)] font-bold text-[10px] uppercase">GATE DEPTH</span>
                <span className="font-mono text-[var(--apex-gold)] font-bold text-xs">{Math.round(grossBeatState.mix * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={grossBeatState.mix}
                onChange={(e) => handleMixChange(parseFloat(e.target.value))}
                className="w-full h-1.5 accent-[var(--apex-gold)] bg-[var(--apex-chrome-inset)] rounded cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-[var(--apex-text-3)] mt-1 font-mono">
                <span>0% open</span>
                <span>100% full chop</span>
              </div>
              <div className="text-[9px] text-[var(--apex-text-3)] mt-1 font-mono">
                Closed steps: {closedGainPercent}% gain
              </div>
            </div>

            {/* Master Brake Trigger */}
            <div className="bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] flex flex-col justify-between">
              <div className="flex items-center justify-between text-[10px] text-[var(--apex-text-2)] font-bold uppercase mb-1">
                <span>MASTER BRAKE</span>
                <span className="text-[var(--apex-text)] font-mono">{brakeDuration}ms</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTriggerBrake}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                    isBraking
                      ? 'bg-[var(--apex-danger)] text-[var(--apex-state-recording-fg)] animate-pulse'
                      : 'bg-[var(--apex-surface-3)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_82%,var(--apex-text))] hover:text-[var(--apex-state-playing-fg)] text-[var(--apex-text)] border border-[var(--apex-border)]'
                  }`}
                >
                  <Disc className={`w-3.5 h-3.5 ${isBraking ? 'animate-spin' : ''}`} />
                  <span>{isBraking ? 'BRAKING...' : 'BRAKE'}</span>
                </button>
                <select
                  value={brakeDuration}
                  onChange={(e) => setBrakeDuration(parseInt(e.target.value))}
                  className="bg-[var(--apex-surface)] text-[var(--apex-text)] text-[10px] font-mono px-2 py-1.5 rounded border border-[var(--apex-border)] focus:outline-none"
                >
                  {BRAKE_DURATIONS.map((duration) => (
                    <option key={duration} value={duration}>{duration}ms</option>
                  ))}
                </select>
              </div>
              <div className="text-[9px] text-[var(--apex-text-3)] mt-1 font-mono">
                Master gain fade to silence and back &mdash; not a tape or turntable stop.
              </div>
            </div>
          </div>

          {/* Preset Styles Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--apex-text)] font-bold text-xs flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[var(--apex-gold)]" />
                <span>GATE PATTERN PRESETS</span>
              </span>
              <span className="text-[10px] text-[var(--apex-text-3)]">Click to load a pattern</span>
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
                        ? 'bg-[color-mix(in_srgb,var(--apex-gold)_14%,var(--apex-surface-2))] border-[var(--apex-gold)] text-[var(--apex-text)] shadow-md'
                        : 'bg-[var(--apex-surface-2)] border-[var(--apex-border)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)] hover:bg-[var(--apex-surface-3)] hover:border-[var(--apex-state-selected-border)]'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-bold text-xs text-[var(--apex-text)]">{p.name}</span>
                      {isActive && <span className="w-2 h-2 rounded-full bg-[var(--apex-gold)]"></span>}
                    </div>
                    <span className="text-[10px] text-[var(--apex-text-3)] mt-1">{p.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 16-Step Interactive Amplitude Gate Grid */}
          <div className="bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[var(--apex-text)]">16-STEP AMPLITUDE GATE GRID</span>
                <span className="text-[10px] font-mono text-[var(--apex-text-3)]">1/16 beat grid</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setActivePresetId(null);
                    publish({ gateSteps: grossBeatAllOpenSteps() });
                  }}
                  className="px-2 py-0.5 rounded text-[9px] bg-[var(--apex-surface-3)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)]"
                >
                  All Open
                </button>
                <button
                  onClick={() => {
                    setActivePresetId(null);
                    publish({ gateSteps: grossBeatState.gateSteps.map(s => !s) });
                  }}
                  className="px-2 py-0.5 rounded text-[9px] bg-[var(--apex-surface-3)] text-[var(--apex-text-2)] hover:text-[var(--apex-text)]"
                >
                  Invert
                </button>
              </div>
            </div>

            {/* 16 Step Buttons */}
            <div className="grid grid-cols-16 gap-1 sm:gap-1.5 h-20 items-end bg-[var(--apex-chrome-inset)] p-2 rounded-lg border border-[var(--apex-border)]">
              {grossBeatState.gateSteps.map((isActive, idx) => {
                const isCurrent = isPlaying && currentStep === idx;
                const isBeatStart = idx % 4 === 0;

                return (
                  <div
                    key={idx}
                    onClick={() => handleStepToggle(idx)}
                    className={`h-full flex flex-col justify-end cursor-pointer rounded transition group relative ${
                      isBeatStart ? 'border-l border-[var(--apex-grid-line-strong)]' : ''
                    }`}
                  >
                    {/* Playhead Marker */}
                    {isCurrent && (
                      <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[var(--apex-state-playing)] animate-ping"></div>
                    )}

                    {/* Step Height Bar */}
                    <div
                      className={`w-full rounded-t transition-all ${
                        isActive
                          ? isCurrent
                            ? 'bg-[var(--apex-state-playing)] h-full shadow-lg'
                            : 'bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_82%,var(--apex-text))] h-full shadow'
                          : 'bg-[var(--apex-surface-3)] hover:bg-[var(--apex-state-hover)] h-3'
                      }`}
                    />

                    {/* Step Index Label */}
                    <span className={`text-[8px] font-mono text-center mt-1 ${isCurrent ? 'text-[var(--apex-state-playing)] font-bold' : 'text-[var(--apex-text-3)]'}`}>
                      {idx + 1}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between text-[9px] text-[var(--apex-text-3)] font-mono">
              <span>Beat 1 (1-4)</span>
              <span>Beat 2 (5-8)</span>
              <span>Beat 3 (9-12)</span>
              <span>Beat 4 (13-16)</span>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-[var(--apex-text-3)]">
            <Waves className="w-3.5 h-3.5 text-[var(--apex-gold)]" />
            <span>Master Bus Amplitude Gate</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-gold)] hover:bg-[color-mix(in_srgb,var(--apex-gold)_86%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition shadow"
          >
            Apply &amp; Close
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
