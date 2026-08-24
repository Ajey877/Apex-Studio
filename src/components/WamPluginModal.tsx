import React, { useState } from 'react';
import { 
  Cpu, 
  X, 
  Sparkles, 
  Zap, 
  Layers, 
  Sliders, 
  Power, 
  RotateCcw, 
  ExternalLink,
  Plus,
  Play,
  Check
} from 'lucide-react';
import { MixerTrack } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface WamPluginModalProps {
  isOpen: boolean;
  onClose: () => void;
  mixerTracks: MixerTrack[];
  onUpdateMixerTracks: (tracks: MixerTrack[]) => void;
}

interface HostedPlugin {
  id: string;
  name: string;
  developer: string;
  category: 'Synth / Generator' | 'Spatial Reverb' | 'Analog Saturation' | 'Filter / Modulation';
  version: string;
  isLoaded: boolean;
  isActive: boolean;
  assignedMixerTrackId: number;
  params: { name: string; value: number; unit: string; min: number; max: number }[];
}

const AVAILABLE_WAM_PLUGINS: HostedPlugin[] = [
  {
    id: 'wam-obxd',
    name: 'OB-Xd Virtual Analog PolySynth (WAM2 / VST3)',
    developer: 'discoDSP / WAM Community',
    category: 'Synth / Generator',
    version: 'v2.8.4',
    isLoaded: true,
    isActive: true,
    assignedMixerTrackId: 1,
    params: [
      { name: 'Filter Cutoff', value: 2400, unit: 'Hz', min: 20, max: 20000 },
      { name: 'Filter Resonance', value: 0.45, unit: 'Q', min: 0.1, max: 10 },
      { name: 'Voice Unison Detune', value: 0.18, unit: '%', min: 0, max: 1 },
      { name: 'Analog Drift', value: 0.35, unit: '%', min: 0, max: 1 }
    ]
  },
  {
    id: 'wam-freeverb',
    name: 'Schroeder-Moorer Pro Studio Reverb (WAM)',
    developer: 'Jezar at Dreampoint',
    category: 'Spatial Reverb',
    version: 'v1.4.2',
    isLoaded: true,
    isActive: true,
    assignedMixerTrackId: 0,
    params: [
      { name: 'Room Size', value: 0.78, unit: '%', min: 0, max: 1 },
      { name: 'Dampening', value: 0.25, unit: '%', min: 0, max: 1 },
      { name: 'Stereo Width', value: 1.0, unit: 'x', min: 0, max: 2 },
      { name: 'Dry / Wet Mix', value: 0.35, unit: '%', min: 0, max: 1 }
    ]
  },
  {
    id: 'wam-tube-saturator',
    name: '12AX7 Vacuum Tube Triode Warmth (WAM)',
    developer: 'Apex DSP Audio',
    category: 'Analog Saturation',
    version: 'v3.1.0',
    isLoaded: true,
    isActive: true,
    assignedMixerTrackId: 0,
    params: [
      { name: 'Drive / Overdrive', value: 4.5, unit: 'dB', min: 0, max: 24 },
      { name: '2nd Order Even Harmonics', value: 0.6, unit: '%', min: 0, max: 1 },
      { name: 'High-Shelf Air Tone', value: 1.5, unit: 'dB', min: -6, max: 6 },
      { name: 'Output Ceiling', value: -0.5, unit: 'dB', min: -12, max: 0 }
    ]
  }
];

export const WamPluginModal: React.FC<WamPluginModalProps> = ({
  isOpen,
  onClose,
  mixerTracks,
  onUpdateMixerTracks
}) => {
  const [plugins, setPlugins] = useState<HostedPlugin[]>(AVAILABLE_WAM_PLUGINS);
  const [selectedPluginId, setSelectedPluginId] = useState<string>(AVAILABLE_WAM_PLUGINS[0].id);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const selectedPlugin = plugins.find(p => p.id === selectedPluginId) || plugins[0];

  const handleToggleActive = (id: string) => {
    const updated = plugins.map(p => p.id === id ? { ...p, isActive: !p.isActive } : p);
    setPlugins(updated);
    const target = updated.find(p => p.id === id);
    setStatusMessage(`${target?.name}: ${target?.isActive ? 'ACTIVE' : 'BYPASS'}`);
    setTimeout(() => setStatusMessage(null), 2000);
  };

  const handleParamChange = (pluginId: string, paramIndex: number, newVal: number) => {
    const updated = plugins.map(p => {
      if (p.id === pluginId) {
        const nextParams = [...p.params];
        nextParams[paramIndex] = { ...nextParams[paramIndex], value: newVal };
        return { ...p, params: nextParams };
      }
      return p;
    });
    setPlugins(updated);
  };

  const handleAuditionPlugin = () => {
    const tempChannel = {
      id: 'wam-audition-ch',
      name: 'WAM Synth',
      instrumentType: 'supersaw_lead' as const,
      volume: 0.8,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      color: '#a855f7',
      mixerTrackId: selectedPlugin.assignedMixerTrackId,
      steps: [],
      notes: []
    };
    audioEngine.playNote(tempChannel as any, { id: `wam-aud-${Date.now()}`, pitch: 64, start: 0, duration: 2, velocity: 0.8 });
    setStatusMessage(`Auditioning through ${selectedPlugin.name}...`);
    setTimeout(() => setStatusMessage(null), 2000);
  };

  return (
    <div id="fl-wam-plugin-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#a855f7]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#a855f7] to-[#ec4899] flex items-center justify-center text-white shadow-md font-bold">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">WEB AUDIO MODULES (WAM2 / VST3) HOST RACK</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#a855f7]/20 text-[#a855f7] border border-[#a855f7]/40">
                  SANDBOXED DSP PIPELINE
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Run standards-compliant Web Audio Modules, third-party VST3 synths & FX plugins directly in DAW inserts</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionPlugin}
              className="px-3 py-1 bg-[#a855f7] hover:bg-[#b86df8] text-white font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Audition E3</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[#a855f7] text-white font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-white/80 hover:text-white">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Plugin Browser List */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {plugins.map((plugin) => {
              const isSelected = plugin.id === selectedPluginId;
              return (
                <div
                  key={plugin.id}
                  onClick={() => setSelectedPluginId(plugin.id)}
                  className={`p-3 rounded-xl border transition cursor-pointer flex flex-col justify-between gap-2 ${
                    isSelected 
                      ? 'bg-[#201a2c] border-[#a855f7] ring-1 ring-[#a855f7]' 
                      : 'bg-[#18181c] border-[#2a2a30] hover:border-[#555]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="text-xs font-bold text-white block leading-tight">{plugin.name}</span>
                      <span className="text-[9px] text-[#777] font-mono">{plugin.developer} • {plugin.version}</span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleActive(plugin.id);
                      }}
                      className={`p-1 rounded transition ${plugin.isActive ? 'text-[#00ff88] bg-[#00ff88]/10' : 'text-[#666] bg-[#222]'}`}
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-[9px] font-mono border-t border-white/5 pt-1.5">
                    <span className="text-[#a855f7]">{plugin.category}</span>
                    <span className="text-[#888]">Track #{plugin.assignedMixerTrackId}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Plugin GUI Inspector & Parameter Sliders */}
          {selectedPlugin && (
            <div className="bg-[#18181c] p-4 rounded-xl border border-[#2a2a32] space-y-4">
              <div className="flex items-center justify-between border-b border-[#28282b] pb-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="w-3 h-3 rounded-full bg-[#a855f7]" />
                  <div>
                    <h3 className="text-xs font-bold text-white uppercase">{selectedPlugin.name}</h3>
                    <span className="text-[10px] text-[#777] font-mono">Status: {selectedPlugin.isActive ? 'ACTIVE DSP RUNNING' : 'BYPASSED'}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[#888]">Assign to Mixer Track:</span>
                  <select
                    value={selectedPlugin.assignedMixerTrackId}
                    onChange={(e) => {
                      const updated = plugins.map(p => p.id === selectedPlugin.id ? { ...p, assignedMixerTrackId: Number(e.target.value) } : p);
                      setPlugins(updated);
                    }}
                    className="bg-[#121214] text-white text-xs p-1 rounded border border-[#333336]"
                  >
                    {mixerTracks.map(m => (
                      <option key={m.id} value={m.id}>{m.name} (#{m.id})</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Parameter Knobs / Faders */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {selectedPlugin.params.map((param, pIdx) => (
                  <div key={pIdx} className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-white font-bold">{param.name}</span>
                      <span className="text-[#a855f7] font-mono">{param.value} {param.unit}</span>
                    </div>

                    <input
                      type="range"
                      min={param.min}
                      max={param.max}
                      step={(param.max - param.min) / 100}
                      value={param.value}
                      onChange={(e) => handleParamChange(selectedPlugin.id, pIdx, Number(e.target.value))}
                      className="w-full accent-[#a855f7]"
                    />

                    <div className="flex justify-between text-[8px] font-mono text-[#666]">
                      <span>{param.min} {param.unit}</span>
                      <span>{param.max} {param.unit}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Web Audio Modules V2 Standard Compatible Pipeline</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#a855f7] hover:bg-[#b86df8] text-white font-bold rounded transition shadow"
          >
            Apply Plugin Routing
          </button>
        </div>
      </div>
    </div>
  );
};
