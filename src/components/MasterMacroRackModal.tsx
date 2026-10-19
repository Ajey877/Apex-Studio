import React, { useEffect, useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Sliders, 
  X, 
  Sparkles, 
  RotateCcw, 
  Check, 
  Plus, 
  Trash2, 
  Zap, 
  Flame, 
  Radio, 
  Layers,
  Settings
} from 'lucide-react';
import { MasterMacroKnob, MixerTrack, Channel } from '../types/daw';

interface MasterMacroRackModalProps {
  isOpen: boolean;
  onClose: () => void;
  mixerTracks: MixerTrack[];
  channels: Channel[];
  macroKnobs?: MasterMacroKnob[];
  onUpdateMacros?: (macros: MasterMacroKnob[]) => void;
}

const DEFAULT_MACRO_KNOBS: MasterMacroKnob[] = [
  {
    id: 'macro-1',
    name: 'DROP BUILDUP (SWEEP)',
    value: 0.2,
    color: '#ff6e00',
    mappings: [
      { targetType: 'filter_cutoff', targetId: 1, min: 200, max: 18000, curve: 'exponential' },
      { targetType: 'reverb_wet', targetId: 1, min: 0.1, max: 0.85, curve: 'linear' }
    ]
  },
  {
    id: 'macro-2',
    name: 'SUB CRUSH & TENSION',
    value: 0.5,
    color: '#00ff88',
    mappings: [
      { targetType: 'channel_volume', targetId: 'ch-808', min: 0.4, max: 1.0, curve: 'linear' },
      { targetType: 'filter_cutoff', targetId: 2, min: 60, max: 800, curve: 'exponential' }
    ]
  },
  {
    id: 'macro-3',
    name: 'SPACE & STEREO WIDTH',
    value: 0.35,
    color: '#00e5ff',
    mappings: [
      { targetType: 'reverb_wet', targetId: 1, min: 0.05, max: 0.9, curve: 'linear' },
      { targetType: 'delay_feedback', targetId: 1, min: 0.1, max: 0.75, curve: 'linear' }
    ]
  },
  {
    id: 'macro-4',
    name: 'LO-FI VINYL DUCK',
    value: 0.1,
    color: '#a855f7',
    mappings: [
      { targetType: 'filter_cutoff', targetId: 1, min: 400, max: 12000, curve: 'logarithmic' }
    ]
  }
];

export const MasterMacroRackModal: React.FC<MasterMacroRackModalProps> = ({
  isOpen,
  onClose,
  mixerTracks,
  channels,
  macroKnobs = DEFAULT_MACRO_KNOBS,
  onUpdateMacros
}) => {
  const [macros, setMacros] = useState<MasterMacroKnob[]>(macroKnobs.length > 0 ? macroKnobs : DEFAULT_MACRO_KNOBS);
  const [selectedMacroId, setSelectedMacroId] = useState<string>(macros[0]?.id || 'macro-1');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    const nextMacros = macroKnobs.length > 0 ? macroKnobs : DEFAULT_MACRO_KNOBS;
    setMacros(nextMacros);
    setSelectedMacroId(prev =>
      nextMacros.some(m => m.id === prev) ? prev : (nextMacros[0]?.id || 'macro-1')
    );
  }, [macroKnobs, isOpen]);

  if (!isOpen) return null;

  const currentMacro = macros.find(m => m.id === selectedMacroId) || macros[0];

  const handleKnobChange = (id: string, val: number) => {
    const updated = macros.map(m => m.id === id ? { ...m, value: val } : m);
    setMacros(updated);
    if (onUpdateMacros) {
      onUpdateMacros(updated);
    }
  };

  const handleAddMacro = () => {
    const newMacro: MasterMacroKnob = {
      id: `macro-${Date.now()}`,
      name: `MACRO ${macros.length + 1} (CUSTOM)`,
      value: 0.5,
      color: ['#ff6e00', '#00ff88', '#00e5ff', '#a855f7', '#ffaa00'][macros.length % 5],
      mappings: [
        { targetType: 'filter_cutoff', targetId: 1, min: 500, max: 15000, curve: 'exponential' }
      ]
    };
    const updated = [...macros, newMacro];
    setMacros(updated);
    setSelectedMacroId(newMacro.id);
    if (onUpdateMacros) onUpdateMacros(updated);
  };

  return (
    <ModalFrame id="fl-master-macro-modal" labelledBy="fl-master-macro-modal-title" onClose={onClose} className="fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      {/* UI-03M: every chrome surface, border, text and interaction state below
          consumes the existing `--apex-*` semantic tokens. The rack's green
          identity is kept through `--apex-success` (the token the compatibility
          layer already resolved `#00ff88` text to), the curve chip's cyan
          readout through `--apex-cyan-text`, and the mapping MAX ceiling stays
          green. The dead `bg-black/85` scrim is gone — ModalFrame supplies the
          shared themed `--apex-modal-overlay`.

          `macro.color` is *persisted project data* (`ProjectState.macroKnobs[].color`),
          the same category UI-03A explicitly preserves for `ch.color` and
          `PAD_COLORS`, so it is left exactly as stored and still paints the
          value arc, the selected-card border, the range accent and the mapping
          swatch. It is no longer used as a 10px text colour: a stored neon
          identity hue cannot clear AA on the Light palette (`#00e5ff` on
          `--apex-surface-3` measures 1.30:1), so those two labels use
          `--apex-text`. Selection additionally carries a themed
          `--apex-accent-strong` ring, so it never depends on a data colour. */}
      <div className="bg-[var(--apex-surface)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[var(--apex-text-2)] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-success)] flex items-center justify-center text-[var(--apex-state-playing-fg)] shadow-md font-bold">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="fl-master-macro-modal-title" className="text-sm font-bold text-[var(--apex-text)] tracking-wide">MASTER MACRO PERFORMANCE RACK</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)] text-[var(--apex-text)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)]">
                  MULTI-TARGET MATRIX
                </span>
              </div>
              <p className="text-[10px] text-[var(--apex-text-3)]">Map single rotary macro controllers to multiple filter cutoffs, wet levels, and dynamic sweeps</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAddMacro}
              className="px-3 py-1 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Macro</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close macro rack"
              className="text-[var(--apex-text-3)] hover:text-[var(--apex-text)] p-1 rounded hover:bg-[var(--apex-state-hover)] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Main 4-8 Macro Knobs Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {macros.map((macro) => {
              const isSelected = macro.id === selectedMacroId;
              return (
                <div
                  key={macro.id}
                  onClick={() => setSelectedMacroId(macro.id)}
                  // UI-03M fix: the inline `borderColor` used to be set on every
                  // card, which silently beat the `hover:border-*` class — the
                  // unselected card's hover feedback has never worked. The inline
                  // style now carries only the selected card's persisted identity
                  // colour; the idle card takes its border from tokens, so the
                  // hover lift actually paints in both themes.
                  style={isSelected ? { borderColor: macro.color } : undefined}
                  className={`p-3.5 rounded-xl border-2 cursor-pointer transition flex flex-col items-center justify-between text-center space-y-3 ${
                    isSelected
                      ? 'bg-[var(--apex-surface-3)] ring-2 ring-[var(--apex-accent-strong)] shadow-lg'
                      : 'bg-[var(--apex-surface-2)] border-[var(--apex-border)] hover:border-[var(--apex-grid-line-strong)]'
                  }`}
                >
                  <div className="w-full flex items-center justify-between text-[10px] font-bold font-mono">
                    <span className="text-[var(--apex-text-3)]">{macro.mappings.length} MAPPINGS</span>
                    <span className="text-[var(--apex-text)]">{(macro.value * 100).toFixed(0)}%</span>
                  </div>

                  {/* Circular Rotary Slider Knob */}
                  <div className="relative w-20 h-20 flex items-center justify-center">
                    <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                      <path
                        className="text-[var(--apex-grid-line-strong)]"
                        strokeWidth="3.5"
                        stroke="currentColor"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                      <path
                        stroke={macro.color}
                        strokeDasharray={`${macro.value * 100}, 100`}
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                    </svg>
                    <span className="absolute text-xs font-mono font-bold text-[var(--apex-text)]">
                      {(macro.value * 100).toFixed(0)}
                    </span>
                  </div>

                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={macro.value}
                    onChange={(e) => handleKnobChange(macro.id, Number(e.target.value))}
                    className="w-full"
                    style={{ accentColor: macro.color }}
                  />

                  <span className="text-[11px] font-bold text-[var(--apex-text)] tracking-wide truncate w-full">
                    {macro.name}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Macro Mapping Matrix List for Selected Knob */}
          {currentMacro && (
            <div className="bg-[var(--apex-panel-header)] p-4 rounded-xl border border-[var(--apex-border)] space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-[var(--apex-text)] uppercase flex items-center gap-1.5">
                    <Settings className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                    <span>MAPPED DESTINATIONS FOR: <strong className="text-[var(--apex-text)]">{currentMacro.name}</strong></span>
                  </span>
                  <span className="text-[10px] text-[var(--apex-text-3)]">Controls all targets below proportionally with custom curves</span>
                </div>
              </div>

              <div className="space-y-2">
                {currentMacro.mappings.map((mapping, idx) => (
                  <div
                    key={idx}
                    className="bg-[var(--apex-canvas)] p-3 rounded-lg border border-[var(--apex-border)] flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: currentMacro.color }} />
                      <span className="font-bold text-[var(--apex-text)] uppercase">{mapping.targetType.replace('_', ' ')}</span>
                      <span className="text-[10px] font-mono text-[var(--apex-text-3)]">→ Track #{mapping.targetId}</span>
                    </div>

                    <div className="flex items-center gap-3 font-mono text-[10px]">
                      <span className="text-[var(--apex-text-3)]">MIN: <strong className="text-[var(--apex-text)]">{mapping.min}</strong></span>
                      <span className="text-[var(--apex-text-3)]">MAX: <strong className="text-[var(--apex-success)]">{mapping.max}</strong></span>
                      <span className="px-1.5 py-0.5 rounded bg-[var(--apex-surface-3)] text-[var(--apex-cyan-text)] uppercase font-bold">
                        {mapping.curve || 'linear'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[var(--apex-text-3)]">Macro Automation Dispatcher Active</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-success)] hover:bg-[color-mix(in_srgb,var(--apex-success)_82%,var(--apex-text))] text-[var(--apex-state-playing-fg)] font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Done</span>
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
