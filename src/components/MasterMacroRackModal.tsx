import React, { useState } from 'react';
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
      { targetType: 'channel_volume', targetId: 'bass', min: 0.4, max: 1.0, curve: 'linear' },
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
    <div id="fl-master-macro-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00ff88]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00ff88] to-[#00aa55] flex items-center justify-center text-black shadow-md font-bold">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">MASTER MACRO PERFORMANCE RACK</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40">
                  MULTI-TARGET MATRIX
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Map single rotary macro controllers to multiple filter cutoffs, wet levels, and dynamic sweeps</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAddMacro}
              className="px-3 py-1 bg-[#00ff88] hover:bg-[#33ff9f] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Macro</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
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
                  style={{ borderColor: isSelected ? macro.color : '#28282e' }}
                  className={`p-3.5 rounded-xl border-2 cursor-pointer transition flex flex-col items-center justify-between text-center space-y-3 ${
                    isSelected ? 'bg-[#18181f] ring-2 ring-white/10 shadow-lg' : 'bg-[#141417] hover:border-[#444]'
                  }`}
                >
                  <div className="w-full flex items-center justify-between text-[10px] font-bold font-mono">
                    <span style={{ color: macro.color }}>{macro.mappings.length} MAPPINGS</span>
                    <span className="text-white">{(macro.value * 100).toFixed(0)}%</span>
                  </div>

                  {/* Circular Rotary Slider Knob */}
                  <div className="relative w-20 h-20 flex items-center justify-center">
                    <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                      <path
                        className="text-[#25252b]"
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
                    <span className="absolute text-xs font-mono font-bold text-white">
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

                  <span className="text-[11px] font-bold text-white tracking-wide truncate w-full">
                    {macro.name}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Macro Mapping Matrix List for Selected Knob */}
          {currentMacro && (
            <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-white uppercase flex items-center gap-1.5">
                    <Settings className="w-3.5 h-3.5 text-[#00ff88]" />
                    <span>MAPPED DESTINATIONS FOR: <strong style={{ color: currentMacro.color }}>{currentMacro.name}</strong></span>
                  </span>
                  <span className="text-[10px] text-[#777]">Controls all targets below proportionally with custom curves</span>
                </div>
              </div>

              <div className="space-y-2">
                {currentMacro.mappings.map((mapping, idx) => (
                  <div
                    key={idx}
                    className="bg-[#121214] p-3 rounded-lg border border-[#26262a] flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: currentMacro.color }} />
                      <span className="font-bold text-white uppercase">{mapping.targetType.replace('_', ' ')}</span>
                      <span className="text-[10px] font-mono text-[#888]">→ Track #{mapping.targetId}</span>
                    </div>

                    <div className="flex items-center gap-3 font-mono text-[10px]">
                      <span className="text-[#888]">MIN: <strong className="text-white">{mapping.min}</strong></span>
                      <span className="text-[#888]">MAX: <strong className="text-[#00ff88]">{mapping.max}</strong></span>
                      <span className="px-1.5 py-0.5 rounded bg-[#222] text-[#00e5ff] uppercase font-bold">
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
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Macro Automation Dispatcher Active</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#00ff88] hover:bg-[#33ff9f] text-black font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Done</span>
          </button>
        </div>
      </div>
    </div>
  );
};
