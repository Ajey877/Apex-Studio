import React, { useState, useEffect } from 'react';
import { 
  Sliders, 
  Radio, 
  X, 
  Zap, 
  Trash2, 
  Plus, 
  Check, 
  Sparkles, 
  RotateCcw, 
  Smartphone, 
  Activity,
  Cpu,
  Keyboard
} from 'lucide-react';
import { MidiMapping, Channel, MixerTrack, MidiDeviceInfo } from '../types/daw';

interface MidiLearnModalProps {
  isOpen: boolean;
  onClose: () => void;
  midiMappings: MidiMapping[];
  onUpdateMidiMappings: (mappings: MidiMapping[]) => void;
  channels: Channel[];
  mixerTracks: MixerTrack[];
  connectedDevices?: MidiDeviceInfo[];
  isMidiLearnActive: boolean;
  onToggleMidiLearn: (active: boolean) => void;
}

export const MidiLearnModal: React.FC<MidiLearnModalProps> = ({
  isOpen,
  onClose,
  midiMappings,
  onUpdateMidiMappings,
  channels,
  mixerTracks,
  connectedDevices = [],
  isMidiLearnActive,
  onToggleMidiLearn
}) => {
  const [selectedTargetType, setSelectedTargetType] = useState<MidiMapping['targetType']>('master_vol');
  const [selectedTargetId, setSelectedTargetId] = useState<string | number>(0);
  const [manualCc, setManualCc] = useState<number>(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleAddMapping = () => {
    const exists = midiMappings.some(m => m.ccNumber === manualCc);
    if (exists) {
      setStatusMessage(`CC #${manualCc} is already bound. Overwriting...`);
    }

    const newMapping: MidiMapping = {
      ccNumber: manualCc,
      targetType: selectedTargetType,
      targetId: selectedTargetId,
      paramName: selectedTargetType === 'master_vol' ? 'Master Volume' : `${selectedTargetType} #${selectedTargetId}`
    };

    const filtered = midiMappings.filter(m => m.ccNumber !== manualCc);
    onUpdateMidiMappings([...filtered, newMapping]);
    setStatusMessage(`Bound MIDI CC #${manualCc} to ${newMapping.paramName}!`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleDelete = (cc: number) => {
    onUpdateMidiMappings(midiMappings.filter(m => m.ccNumber !== cc));
  };

  const handleClearAll = () => {
    onUpdateMidiMappings([]);
    setStatusMessage('Cleared all MIDI CC mappings.');
    setTimeout(() => setStatusMessage(null), 3000);
  };

  if (!isOpen) return null;

  return (
    <div id="fl-midi-learn-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121214] border border-[#2e2e32] rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181b] border-b border-[#2e2e32] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ffaa00] flex items-center justify-center text-black shadow-md">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">MIDI CONTROLLER LEARN & MAPPING</h2>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                  isMidiLearnActive 
                    ? 'bg-[#ff6e00]/20 text-[#ff6e00] border-[#ff6e00]/40 animate-pulse' 
                    : 'bg-[#333]/20 text-[#777] border-[#444]'
                }`}>
                  {isMidiLearnActive ? 'LEARN ACTIVE' : 'STANDBY'}
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Map physical MIDI knobs, faders, and pads to DAW controls</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onToggleMidiLearn(!isMidiLearnActive)}
              className={`px-3 py-1 rounded text-xs font-bold transition flex items-center gap-1.5 ${
                isMidiLearnActive 
                  ? 'bg-[#ff6e00] text-black shadow-lg animate-pulse' 
                  : 'bg-[#222225] text-[#888] hover:text-white border border-[#333]'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{isMidiLearnActive ? 'STOP LEARN' : 'START MIDI LEARN'}</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222225] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[#ff6e00] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Connected WebMIDI Devices */}
          <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b]">
            <span className="text-[10px] text-[#888] font-bold uppercase tracking-wider block mb-1.5">CONNECTED HARDWARE CONTROLLERS</span>
            {connectedDevices.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {connectedDevices.map(d => (
                  <div key={d.id} className="bg-[#121214] p-2 rounded border border-[#2e2e32] flex items-center gap-2">
                    <Keyboard className="w-4 h-4 text-[#00ff88]" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-bold text-white truncate">{d.name}</span>
                      <span className="text-[9px] text-[#777] font-mono">{d.manufacturer || 'Generic USB MIDI'} ({d.state})</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-[#121214] p-3 rounded border border-[#28282b] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-[#ff6e00]" />
                  <span className="text-xs text-[#aaa]">WebMIDI ready. Plug in any USB MIDI keyboard or DJ controller.</span>
                </div>
                <span className="text-[9px] font-mono text-[#666]">Auto-Detecting</span>
              </div>
            )}
          </div>

          {/* Quick Manual Bind Form */}
          <div className="bg-[#18181b] p-3 rounded-lg border border-[#28282b] space-y-2">
            <span className="text-[10px] text-[#888] font-bold uppercase tracking-wider block">QUICK PARAMETER BIND</span>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              {/* CC Number */}
              <div>
                <label className="text-[9px] text-[#777] font-mono block mb-0.5">MIDI CC #</label>
                <input
                  type="number"
                  min="0"
                  max="127"
                  value={manualCc}
                  onChange={(e) => setManualCc(parseInt(e.target.value) || 0)}
                  className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336] font-mono"
                />
              </div>

              {/* Target Type */}
              <div>
                <label className="text-[9px] text-[#777] font-mono block mb-0.5">TARGET CONTROL</label>
                <select
                  value={selectedTargetType}
                  onChange={(e) => setSelectedTargetType(e.target.value as any)}
                  className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336]"
                >
                  <option value="master_vol">Master Out Volume</option>
                  <option value="channel_vol">Channel Volume Fader</option>
                  <option value="channel_pan">Channel Pan Knob</option>
                  <option value="mixer_vol">Mixer Insert Fader</option>
                  <option value="mixer_pan">Mixer Insert Pan</option>
                  <option value="fx_param">Filter Cutoff (Hz)</option>
                </select>
              </div>

              {/* Target Item / Track */}
              <div>
                <label className="text-[9px] text-[#777] font-mono block mb-0.5">ASSIGN TO TRACK</label>
                <select
                  value={selectedTargetId}
                  onChange={(e) => setSelectedTargetId(e.target.value)}
                  className="w-full bg-[#121214] text-white text-xs px-2 py-1.5 rounded border border-[#333336]"
                >
                  {selectedTargetType.startsWith('channel') ? (
                    channels.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))
                  ) : (
                    mixerTracks.map(m => (
                      <option key={m.id} value={m.id}>{m.name} (#{m.id})</option>
                    ))
                  )}
                </select>
              </div>

              {/* Add Button */}
              <div className="flex items-end">
                <button
                  onClick={handleAddMapping}
                  className="w-full py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center justify-center gap-1 shadow"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Bind CC</span>
                </button>
              </div>
            </div>
          </div>

          {/* Active Mappings Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white font-bold flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>ACTIVE MIDI CC BINDINGS ({midiMappings.length})</span>
              </span>
              {midiMappings.length > 0 && (
                <button
                  onClick={handleClearAll}
                  className="text-[10px] text-red-400 hover:text-red-300 transition"
                >
                  Clear All
                </button>
              )}
            </div>

            {midiMappings.length === 0 ? (
              <div className="bg-[#18181b] p-6 rounded-lg border border-dashed border-[#2e2e32] text-center space-y-2">
                <Sliders className="w-8 h-8 text-[#555] mx-auto" />
                <p className="text-xs text-[#888]">No MIDI CC bindings active yet.</p>
                <p className="text-[10px] text-[#666]">
                  Click <strong>START MIDI LEARN</strong> above, or bind a knob manually.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {midiMappings.map(m => (
                  <div
                    key={m.ccNumber}
                    className="bg-[#18181b] p-2.5 rounded-lg border border-[#28282b] flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-7 rounded bg-[#222225] border border-[#333338] flex items-center justify-center font-mono font-bold text-xs text-[#ff6e00]">
                        CC {m.ccNumber}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-white">{m.paramName || m.targetType}</span>
                        <span className="text-[9px] text-[#777] font-mono">
                          Target: {m.targetType} | ID: {m.targetId}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDelete(m.ccNumber)}
                      className="p-1.5 text-[#777] hover:text-red-400 rounded hover:bg-[#222225] transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181b] border-t border-[#2e2e32] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Standard MIDI CC: 1=ModWheel, 7=Volume, 10=Pan, 11=Expression, 71=Resonance, 74=Cutoff</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#222225] hover:bg-[#333338] text-white font-bold rounded transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
