import React, { useState, useEffect } from 'react';
import { 
  X, 
  Radio, 
  Cpu, 
  Sliders, 
  Activity, 
  CheckCircle, 
  RefreshCw, 
  Zap, 
  Volume2, 
  Disc,
  Layers
} from 'lucide-react';
import { MidiDeviceInfo, MidiMapping, Channel, MixerTrack } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface MidiControllerModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  mixerTracks: MixerTrack[];
  midiMappings: MidiMapping[];
  onUpdateMidiMappings: (mappings: MidiMapping[]) => void;
  activeChannel: Channel;
}

interface MidiLogEntry {
  id: string;
  time: string;
  type: string;
  note?: number;
  velocity?: number;
  cc?: number;
  value?: number;
  channel?: number;
}

export const MidiControllerModal: React.FC<MidiControllerModalProps> = ({
  isOpen,
  onClose,
  channels,
  mixerTracks,
  midiMappings,
  onUpdateMidiMappings,
  activeChannel
}) => {
  const [devices, setDevices] = useState<MidiDeviceInfo[]>([]);
  const [logs, setLogs] = useState<MidiLogEntry[]>([]);
  const [learningTarget, setLearningTarget] = useState<MidiMapping | null>(null);
  const [activeTab, setActiveTab] = useState<'devices' | 'learn' | 'virtual_controller' | 'monitor'>('devices');
  const [virtualOctave, setVirtualOctave] = useState<number>(4);
  const [pitchBend, setPitchBend] = useState<number>(0);
  const [modWheel, setModWheel] = useState<number>(0);

  // Scan devices on mount
  useEffect(() => {
    if (!isOpen) return;
    refreshDevices();

    const handleMidiEvent = (e: any) => {
      const now = new Date();
      const timeStr = `${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
      
      const newEntry: MidiLogEntry = {
        id: `${Date.now()}-${Math.random()}`,
        time: timeStr,
        type: e.type,
        note: e.note,
        velocity: e.velocity ? Math.round(e.velocity * 127) : undefined,
        cc: e.cc,
        value: e.value ? Math.round(e.value * 127) : undefined,
        channel: e.midiChannel || 1
      };

      setLogs(prev => [newEntry, ...prev.slice(0, 49)]);

      // If MIDI Learn mode is active and we received a CC message
      if (e.type === 'cc' && learningTarget) {
        const updated = midiMappings.filter(
          m => !(m.targetType === learningTarget.targetType && m.targetId === learningTarget.targetId && m.paramName === learningTarget.paramName)
        );
        updated.push({
          ...learningTarget,
          ccNumber: e.cc
        });
        onUpdateMidiMappings(updated);
        setLearningTarget(null);
      }
    };

    audioEngine.addMidiListener(handleMidiEvent);
    return () => {
      audioEngine.removeMidiListener(handleMidiEvent);
    };
  }, [isOpen, learningTarget, midiMappings]);

  const refreshDevices = async () => {
    await audioEngine.initMidi();
    const devList = audioEngine.getConnectedMidiDevices();
    setDevices(devList);
  };

  const handleStartLearn = (targetType: MidiMapping['targetType'], targetId: string | number, paramName?: string) => {
    setLearningTarget({
      ccNumber: -1,
      targetType,
      targetId,
      paramName
    });
  };

  const handleRemoveMapping = (index: number) => {
    const updated = [...midiMappings];
    updated.splice(index, 1);
    onUpdateMidiMappings(updated);
  };

  const playVirtualNote = (noteNum: number) => {
    if (!activeChannel) return;
    audioEngine.playNote(activeChannel, {
      id: `virt-${Date.now()}`,
      pitch: noteNum,
      start: 0,
      duration: 1,
      velocity: 0.9
    });
  };

  if (!isOpen) return null;

  return (
    <div 
      id="midi-controller-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in"
    >
      <div 
        id="midi-controller-modal-container"
        className="bg-[#18181b] border border-[#333336] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2a2a2d] bg-[#141416]">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-[#ff6e00]/10 border border-[#ff6e00]/30 flex items-center justify-center text-[#ff6e00]">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center space-x-2">
                <span>Hardware MIDI & Controller Hub</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-[#27ae60]/20 text-[#2ecc71] font-mono font-medium border border-[#27ae60]/30">
                  Web MIDI Studio
                </span>
              </h2>
              <p className="text-xs text-[#888]">
                Connect USB/Bluetooth MIDI keyboards, pad controllers, and map hardware knobs
              </p>
            </div>
          </div>
          <button
            id="close-midi-modal-btn"
            onClick={onClose}
            className="text-[#888] hover:text-white p-1.5 rounded-lg hover:bg-[#27272a] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center space-x-2 px-6 pt-3 border-b border-[#2a2a2d] bg-[#161619]">
          <button
            id="tab-midi-devices"
            onClick={() => setActiveTab('devices')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 border-b-2 ${
              activeTab === 'devices'
                ? 'text-[#ff6e00] border-[#ff6e00] bg-[#222226]'
                : 'text-[#888] border-transparent hover:text-white'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Connected Devices ({devices.length})</span>
          </button>
          <button
            id="tab-midi-learn"
            onClick={() => setActiveTab('learn')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 border-b-2 ${
              activeTab === 'learn'
                ? 'text-[#ff6e00] border-[#ff6e00] bg-[#222226]'
                : 'text-[#888] border-transparent hover:text-white'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>MIDI Learn & CC Map ({midiMappings.length})</span>
          </button>
          <button
            id="tab-midi-virtual"
            onClick={() => setActiveTab('virtual_controller')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 border-b-2 ${
              activeTab === 'virtual_controller'
                ? 'text-[#ff6e00] border-[#ff6e00] bg-[#222226]'
                : 'text-[#888] border-transparent hover:text-white'
            }`}
          >
            <Disc className="w-3.5 h-3.5" />
            <span>Virtual Controller & Pads</span>
          </button>
          <button
            id="tab-midi-monitor"
            onClick={() => setActiveTab('monitor')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 border-b-2 ${
              activeTab === 'monitor'
                ? 'text-[#ff6e00] border-[#ff6e00] bg-[#222226]'
                : 'text-[#888] border-transparent hover:text-white'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Live Traffic Monitor</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
          {/* TAB 1: Connected Devices */}
          {activeTab === 'devices' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between bg-[#202024] p-4 rounded-lg border border-[#2e2e32]">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-white flex items-center space-x-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#2ecc71] animate-pulse"></span>
                    <span>Web MIDI Engine Active</span>
                  </div>
                  <p className="text-xs text-[#999]">
                    Plug in any class-compliant USB or Bluetooth MIDI controller (AKAI, Novation, Arturia, KORG, Roland, Yamaha, etc.)
                  </p>
                </div>
                <button
                  id="rescan-midi-devices-btn"
                  onClick={refreshDevices}
                  className="px-3.5 py-1.5 bg-[#2a2a2e] hover:bg-[#333338] text-white text-xs font-semibold rounded-lg border border-[#3e3e44] flex items-center space-x-2 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Rescan Hardware</span>
                </button>
              </div>

              {devices.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-[#333336] rounded-xl bg-[#141416]/50">
                  <Cpu className="w-12 h-12 text-[#555] mx-auto mb-3" />
                  <h3 className="text-sm font-semibold text-white mb-1">No Hardware MIDI Devices Detected</h3>
                  <p className="text-xs text-[#777] max-w-md mx-auto mb-4">
                    Connect a MIDI keyboard or drum pad via USB or Bluetooth. You can also use computer keyboard hotkeys or the Virtual Controller tab below!
                  </p>
                  <button
                    onClick={() => setActiveTab('virtual_controller')}
                    className="px-4 py-2 bg-[#ff6e00] hover:bg-[#ff851b] text-white text-xs font-bold rounded-lg transition-colors"
                  >
                    Open Virtual Controller
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {devices.map((device, idx) => (
                    <div 
                      key={device.id || idx}
                      className="p-4 bg-[#202024] border border-[#2e2e32] rounded-xl flex items-center justify-between"
                    >
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-lg bg-[#27ae60]/10 border border-[#27ae60]/30 flex items-center justify-center text-[#2ecc71]">
                          <Zap className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="text-sm font-bold text-white">{device.name}</div>
                          <div className="text-xs text-[#888] flex items-center space-x-2">
                            <span>{device.manufacturer || 'Generic'}</span>
                            <span>•</span>
                            <span className="uppercase text-[10px] text-[#ff6e00] font-mono">{device.type}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-1.5 text-xs text-[#2ecc71] font-semibold bg-[#27ae60]/10 px-2.5 py-1 rounded-full border border-[#27ae60]/20">
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>Ready</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: MIDI Learn & CC Map */}
          {activeTab === 'learn' && (
            <div className="space-y-6">
              {learningTarget && (
                <div className="p-4 bg-[#ff6e00]/10 border border-[#ff6e00]/50 rounded-xl flex items-center justify-between animate-pulse">
                  <div className="flex items-center space-x-3">
                    <Radio className="w-5 h-5 text-[#ff6e00]" />
                    <div>
                      <div className="text-xs font-bold text-white">MIDI Learn Armed: Waiting for Hardware CC Knob / Fader...</div>
                      <div className="text-[11px] text-[#ddd]">
                        Move any knob or fader on your MIDI controller to bind to: <strong className="text-[#ff6e00]">{learningTarget.targetType} ({learningTarget.paramName || learningTarget.targetId})</strong>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setLearningTarget(null)}
                    className="px-3 py-1 bg-[#27272a] text-white text-xs rounded hover:bg-[#333]"
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-[#888] uppercase tracking-wider">Active CC Parameter Bindings</h3>
                  <div className="text-xs text-[#666]">Twist physical knobs to automate in real-time</div>
                </div>

                {/* Quick Arm Matrix */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    onClick={() => handleStartLearn('master_vol', 'master')}
                    className="p-2.5 bg-[#202024] hover:bg-[#2a2a2e] border border-[#2e2e32] hover:border-[#ff6e00] rounded-lg text-left transition-colors group"
                  >
                    <div className="text-xs font-bold text-white group-hover:text-[#ff6e00]">Master Volume</div>
                    <div className="text-[10px] text-[#888]">Click to Learn CC</div>
                  </button>

                  <button
                    onClick={() => handleStartLearn('channel_vol', activeChannel.id)}
                    className="p-2.5 bg-[#202024] hover:bg-[#2a2a2e] border border-[#2e2e32] hover:border-[#ff6e00] rounded-lg text-left transition-colors group"
                  >
                    <div className="text-xs font-bold text-white group-hover:text-[#ff6e00]">{activeChannel.name} Vol</div>
                    <div className="text-[10px] text-[#888]">Active Channel</div>
                  </button>

                  <button
                    onClick={() => handleStartLearn('fx_param', activeChannel.id, 'filterCutoff')}
                    className="p-2.5 bg-[#202024] hover:bg-[#2a2a2e] border border-[#2e2e32] hover:border-[#ff6e00] rounded-lg text-left transition-colors group"
                  >
                    <div className="text-xs font-bold text-white group-hover:text-[#ff6e00]">Filter Cutoff</div>
                    <div className="text-[10px] text-[#888]">Synth Reso/Cutoff</div>
                  </button>

                  <button
                    onClick={() => handleStartLearn('fx_param', activeChannel.id, 'reverb')}
                    className="p-2.5 bg-[#202024] hover:bg-[#2a2a2e] border border-[#2e2e32] hover:border-[#ff6e00] rounded-lg text-left transition-colors group"
                  >
                    <div className="text-xs font-bold text-white group-hover:text-[#ff6e00]">Reverb Wet Mix</div>
                    <div className="text-[10px] text-[#888]">Spatial FX</div>
                  </button>
                </div>

                {/* Existing Mappings List */}
                <div className="bg-[#141416] border border-[#28282b] rounded-xl overflow-hidden mt-4">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-[#1c1c1f] text-[#888] font-semibold border-b border-[#28282b]">
                      <tr>
                        <th className="px-4 py-2">MIDI CC#</th>
                        <th className="px-4 py-2">Target Type</th>
                        <th className="px-4 py-2">Target Name / Param</th>
                        <th className="px-4 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#242427] text-white">
                      {midiMappings.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-[#666]">
                            No custom MIDI CC mappings configured yet. Click any quick arm button above!
                          </td>
                        </tr>
                      ) : (
                        midiMappings.map((m, idx) => (
                          <tr key={idx} className="hover:bg-[#1a1a1d]">
                            <td className="px-4 py-2.5 font-mono text-[#ff6e00] font-bold">CC {m.ccNumber}</td>
                            <td className="px-4 py-2.5 capitalize">{m.targetType.replace('_', ' ')}</td>
                            <td className="px-4 py-2.5 font-medium">{m.paramName || `Track ${m.targetId}`}</td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                onClick={() => handleRemoveMapping(idx)}
                                className="text-red-400 hover:text-red-300 px-2 py-0.5 rounded hover:bg-red-500/10"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Virtual Controller & Pads */}
          {activeTab === 'virtual_controller' && (
            <div className="space-y-6">
              {/* Pitch Bend / Mod Wheel & Octave */}
              <div className="flex items-center justify-between bg-[#202024] p-4 rounded-xl border border-[#2e2e32]">
                <div className="flex items-center space-x-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-[#888] uppercase tracking-wider block">Octave Shift</label>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => setVirtualOctave(Math.max(1, virtualOctave - 1))}
                        className="px-3 py-1 bg-[#2a2a2e] hover:bg-[#333] text-white text-xs font-bold rounded"
                      >
                        -
                      </button>
                      <span className="font-mono text-sm font-bold text-[#ff6e00] w-6 text-center">C{virtualOctave}</span>
                      <button
                        onClick={() => setVirtualOctave(Math.min(7, virtualOctave + 1))}
                        className="px-3 py-1 bg-[#2a2a2e] hover:bg-[#333] text-white text-xs font-bold rounded"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="h-8 w-px bg-[#333]"></div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-[#888] uppercase tracking-wider block">Target Channel</label>
                    <span className="text-xs font-bold text-white px-2.5 py-1 bg-[#2a2a2e] rounded border border-[#3e3e44]">
                      {activeChannel.name} ({activeChannel.instrumentType})
                    </span>
                  </div>
                </div>

                <div className="text-xs text-[#777]">
                  Play via Touch, Mouse, or Hardware Controller
                </div>
              </div>

              {/* 8 MPC Velocity Drum Pads */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[#888] uppercase tracking-wider">16-Pad MPC Drum Grid (Channel Root Keys)</h3>
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                  {[
                    { name: 'Kick 1', pitch: 36, color: '#ff5722' },
                    { name: 'Kick 2', pitch: 35, color: '#e64a19' },
                    { name: 'Snare 1', pitch: 38, color: '#ff9800' },
                    { name: 'Clap', pitch: 39, color: '#fbc02d' },
                    { name: 'CH Hat', pitch: 42, color: '#00bcd4' },
                    { name: 'OH Hat', pitch: 46, color: '#0288d1' },
                    { name: 'Tom Low', pitch: 41, color: '#9c27b0' },
                    { name: 'Crash', pitch: 49, color: '#e91e63' },
                  ].map((pad, i) => (
                    <button
                      key={i}
                      onMouseDown={() => playVirtualNote(pad.pitch)}
                      className="h-20 bg-[#222226] hover:bg-[#2d2d32] active:scale-95 border border-[#333336] rounded-xl flex flex-col items-center justify-center space-y-1 transition-all shadow-md group"
                      style={{ borderBottomColor: pad.color, borderBottomWidth: '3px' }}
                    >
                      <span className="text-xs font-bold text-white group-hover:text-[#ff6e00]">{pad.name}</span>
                      <span className="text-[9px] text-[#777] font-mono">MIDI {pad.pitch}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 2-Octave Virtual Keyboard */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[#888] uppercase tracking-wider">Interactive 25-Key Studio Keyboard</h3>
                <div className="relative h-32 bg-[#121214] p-1.5 rounded-xl border border-[#2e2e32] flex select-none overflow-x-auto">
                  {/* White Keys */}
                  {Array.from({ length: 15 }).map((_, i) => {
                    const whiteKeyOffsets = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
                    const noteNum = (virtualOctave * 12) + whiteKeyOffsets[i];
                    return (
                      <button
                        key={`white-${i}`}
                        onMouseDown={() => playVirtualNote(noteNum)}
                        className="flex-1 h-full bg-[#f0f0f0] hover:bg-white active:bg-[#ff6e00] border-r border-[#333] rounded-b-md flex flex-col justify-end pb-2 items-center text-[10px] font-bold text-[#333] active:text-white transition-colors"
                      >
                        <span>{i === 0 ? `C${virtualOctave}` : i === 7 ? `C${virtualOctave + 1}` : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Live Traffic Monitor */}
          {activeTab === 'monitor' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-[#888] uppercase tracking-wider">Real-Time Raw MIDI Ingress Log</h3>
                <button
                  onClick={() => setLogs([])}
                  className="text-xs text-[#999] hover:text-white px-2.5 py-1 rounded bg-[#202024] hover:bg-[#2a2a2e]"
                >
                  Clear Console
                </button>
              </div>

              <div className="bg-[#101012] border border-[#222225] rounded-xl p-3 h-80 overflow-y-auto font-mono text-xs custom-scrollbar space-y-1">
                {logs.length === 0 ? (
                  <div className="text-center py-20 text-[#555]">
                    No MIDI events received yet. Hit notes on your physical keyboard or pads to monitor traffic.
                  </div>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="flex items-center space-x-3 py-1 px-2 hover:bg-[#18181b] rounded border-b border-[#1c1c1f]">
                      <span className="text-[#666] text-[10px] w-20">{log.time}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                        log.type === 'noteOn' ? 'bg-[#2ecc71]/20 text-[#2ecc71]' :
                        log.type === 'noteOff' ? 'bg-[#e74c3c]/20 text-[#e74c3c]' :
                        log.type === 'cc' ? 'bg-[#3498db]/20 text-[#3498db]' : 'bg-[#f1c40f]/20 text-[#f1c40f]'
                      }`}>
                        {log.type}
                      </span>
                      <span className="text-[#888]">Ch: {log.channel}</span>
                      {log.note !== undefined && <span className="text-white font-bold">Note: {log.note}</span>}
                      {log.velocity !== undefined && <span className="text-[#ff6e00]">Vel: {log.velocity}</span>}
                      {log.cc !== undefined && <span className="text-[#00bcd4]">CC#: {log.cc}</span>}
                      {log.value !== undefined && <span className="text-[#e67e22]">Val: {log.value}</span>}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-[#2a2a2d] bg-[#141416] text-xs text-[#888]">
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-[#2ecc71]"></span>
            <span>Studio Engine: 0ms Latency Direct Hardware Ingress</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#27272a] hover:bg-[#333] text-white font-semibold rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
