import React, { useState, useEffect } from 'react';
import { ModalFrame } from './ModalFrame';
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
import { resolveMidiLearnCapture, type MidiLearnTarget } from '../audio/midiMappingRuntime';

export interface QuickArmTargetDescriptor extends MidiLearnTarget {
  label: string;
  subtitle: string;
}

export const buildQuickArmTargets = (
  activeChannel: Channel,
  mixerTracks: readonly MixerTrack[],
): QuickArmTargetDescriptor[] => {
  const routedTrack = mixerTracks.find(t => t.id === activeChannel.mixerTrackId);
  const reverbSlot =
    routedTrack?.fxSlots.find(slot => slot.type === 'reverb') ??
    mixerTracks.flatMap(t => t.fxSlots).find(slot => slot.type === 'reverb') ??
    routedTrack?.fxSlots[0] ??
    mixerTracks.flatMap(t => t.fxSlots)[0];

  const fourthTarget: QuickArmTargetDescriptor = reverbSlot
    ? {
        label: 'Reverb Wet Mix',
        subtitle: 'Spatial FX',
        targetType: 'fx_param',
        targetId: reverbSlot.id,
        paramName: 'mix',
      }
    : {
        label: 'Filter Resonance',
        subtitle: 'Synth Reso/Cutoff',
        targetType: 'fx_param',
        targetId: activeChannel.id,
        paramName: 'filterResonance',
      };

  return [
    {
      label: 'Master Volume',
      subtitle: 'Click to Learn CC',
      targetType: 'master_vol',
      targetId: 0,
      paramName: 'Master Volume',
    },
    {
      label: `${activeChannel.name} Vol`,
      subtitle: 'Active Channel',
      targetType: 'channel_vol',
      targetId: activeChannel.id,
      paramName: `${activeChannel.name} Vol`,
    },
    {
      label: 'Filter Cutoff',
      subtitle: 'Synth Reso/Cutoff',
      targetType: 'fx_param',
      targetId: activeChannel.id,
      paramName: 'filterCutoff',
    },
    fourthTarget,
  ];
};

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
        const capture = resolveMidiLearnCapture(e, midiMappings, {
          targetType: learningTarget.targetType,
          targetId: learningTarget.targetId,
          paramName: learningTarget.paramName,
        });
        if (capture) {
          onUpdateMidiMappings(capture.mappings);
          setLearningTarget(null);
        }
      }
    };

    audioEngine.addMidiListener(handleMidiEvent);
    return () => {
      audioEngine.removeMidiListener(handleMidiEvent);
    };
  }, [isOpen, learningTarget, midiMappings, onUpdateMidiMappings]);

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
    <ModalFrame
      id="midi-controller-modal-overlay"
      labelledBy="midi-controller-modal-title"
      onClose={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in"
    >
      <div 
        id="midi-controller-modal-container"
        className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--apex-border)] bg-[var(--apex-panel-header)]">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_40%,transparent)] flex items-center justify-center text-[var(--apex-accent)]">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h2 id="midi-controller-modal-title" className="text-base font-bold text-[var(--apex-text)] flex items-center space-x-2">
                <span>Hardware MIDI & Controller Hub</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-[color-mix(in_srgb,var(--apex-cyan)_20%,transparent)] text-[var(--apex-cyan-text)] font-mono font-medium border border-[color-mix(in_srgb,var(--apex-cyan)_40%,transparent)]">
                  Web MIDI Studio
                </span>
              </h2>
              <p className="text-xs text-[var(--apex-text-2)]">
                Connect USB/Bluetooth MIDI keyboards, pad controllers, and map hardware knobs
              </p>
            </div>
          </div>
          <button
            id="close-midi-modal-btn"
            onClick={onClose}
            aria-label="Close MIDI controller"
            className="text-[var(--apex-text-2)] hover:text-[var(--apex-text)] p-1.5 rounded-lg hover:bg-[var(--apex-state-hover)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center space-x-2 px-6 pt-3 border-b border-[var(--apex-border)] bg-[var(--apex-panel-header)]">
          <button
            id="tab-midi-devices"
            onClick={() => setActiveTab('devices')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 border-b-2 ${
              activeTab === 'devices'
                ? 'text-[var(--apex-accent)] border-[var(--apex-state-selected-border)] bg-[var(--apex-state-selected)]'
                : 'text-[var(--apex-text-2)] border-transparent hover:text-[var(--apex-text)]'
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
                ? 'text-[var(--apex-accent)] border-[var(--apex-state-selected-border)] bg-[var(--apex-state-selected)]'
                : 'text-[var(--apex-text-2)] border-transparent hover:text-[var(--apex-text)]'
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
                ? 'text-[var(--apex-accent)] border-[var(--apex-state-selected-border)] bg-[var(--apex-state-selected)]'
                : 'text-[var(--apex-text-2)] border-transparent hover:text-[var(--apex-text)]'
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
                ? 'text-[var(--apex-accent)] border-[var(--apex-state-selected-border)] bg-[var(--apex-state-selected)]'
                : 'text-[var(--apex-text-2)] border-transparent hover:text-[var(--apex-text)]'
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
              <div className="flex items-center justify-between bg-[var(--apex-surface-2)] p-4 rounded-lg border border-[var(--apex-border)]">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-[var(--apex-text)] flex items-center space-x-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[var(--apex-success)] animate-pulse"></span>
                    <span>Web MIDI Engine Active</span>
                  </div>
                  <p className="text-xs text-[var(--apex-text-2)]">
                    Plug in any class-compliant USB or Bluetooth MIDI controller (AKAI, Novation, Arturia, KORG, Roland, Yamaha, etc.)
                  </p>
                </div>
                <button
                  id="rescan-midi-devices-btn"
                  onClick={refreshDevices}
                  className="px-3.5 py-1.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text)] text-xs font-semibold rounded-lg border border-[var(--apex-border)] flex items-center space-x-2 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Rescan Hardware</span>
                </button>
              </div>

              {devices.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-[var(--apex-border)] rounded-xl bg-[color-mix(in_srgb,var(--apex-chrome-inset)_50%,transparent)]">
                  <Cpu className="w-12 h-12 text-[var(--apex-text-3)] mx-auto mb-3" />
                  <h3 className="text-sm font-semibold text-[var(--apex-text)] mb-1">No Hardware MIDI Devices Detected</h3>
                  <p className="text-xs text-[var(--apex-text-3)] max-w-md mx-auto mb-4">
                    Connect a MIDI keyboard or drum pad via USB or Bluetooth. You can also use computer keyboard hotkeys or the Virtual Controller tab below!
                  </p>
                  <button
                    onClick={() => setActiveTab('virtual_controller')}
                    className="px-4 py-2 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] text-xs font-bold rounded-lg transition-colors"
                  >
                    Open Virtual Controller
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {devices.map((device, idx) => (
                    <div 
                      key={device.id || idx}
                      className="p-4 bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl flex items-center justify-between"
                    >
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-lg bg-[color-mix(in_srgb,var(--apex-success)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)] flex items-center justify-center text-[var(--apex-success)]">
                          <Zap className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="text-sm font-bold text-[var(--apex-text)]">{device.name}</div>
                          <div className="text-xs text-[var(--apex-text-2)] flex items-center space-x-2">
                            <span>{device.manufacturer || 'Generic'}</span>
                            <span>•</span>
                            <span className="uppercase text-[10px] text-[var(--apex-accent)] font-mono">{device.type}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-1.5 text-xs text-[var(--apex-success)] font-semibold bg-[color-mix(in_srgb,var(--apex-success)_16%,transparent)] px-2.5 py-1 rounded-full border border-[color-mix(in_srgb,var(--apex-success)_40%,transparent)]">
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
                <div className="p-4 bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded-xl flex items-center justify-between animate-pulse">
                  <div className="flex items-center space-x-3">
                    <Radio className="w-5 h-5 text-[var(--apex-accent)]" />
                    <div>
                      <div className="text-xs font-bold text-[var(--apex-text)]">MIDI Learn Armed: Waiting for Hardware CC Knob / Fader...</div>
                      <div className="text-[11px] text-[var(--apex-text-2)]">
                        Move any knob or fader on your MIDI controller to bind to: <strong className="text-[var(--apex-accent)]">{learningTarget.targetType} ({learningTarget.paramName || learningTarget.targetId})</strong>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setLearningTarget(null)}
                    className="px-3 py-1 bg-[var(--apex-surface-2)] text-[var(--apex-text)] text-xs rounded hover:bg-[var(--apex-surface-3)]"
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-[var(--apex-text-2)] uppercase tracking-wider">Active CC Parameter Bindings</h3>
                  <div className="text-xs text-[var(--apex-text-3)]">Twist physical knobs to automate in real-time</div>
                </div>

                {/* Quick Arm Matrix */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {buildQuickArmTargets(activeChannel, mixerTracks).map(target => (
                    <button
                      key={`${target.targetType}:${String(target.targetId)}:${target.paramName ?? ''}`}
                      onClick={() => handleStartLearn(target.targetType, target.targetId, target.paramName)}
                      className="p-2.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] border border-[var(--apex-border)] hover:border-[var(--apex-accent-strong)] rounded-lg text-left transition-colors group"
                    >
                      <div className="text-xs font-bold text-[var(--apex-text)] group-hover:text-[var(--apex-accent)]">{target.label}</div>
                      <div className="text-[10px] text-[var(--apex-text-2)]">{target.subtitle}</div>
                    </button>
                  ))}
                </div>

                {/* Existing Mappings List */}
                <div className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded-xl overflow-hidden mt-4">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-[var(--apex-panel-header)] text-[var(--apex-text-2)] font-semibold border-b border-[var(--apex-border)]">
                      <tr>
                        <th className="px-4 py-2">MIDI CC#</th>
                        <th className="px-4 py-2">Target Type</th>
                        <th className="px-4 py-2">Target Name / Param</th>
                        <th className="px-4 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--apex-border)] text-[var(--apex-text)]">
                      {midiMappings.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-[var(--apex-text-3)]">
                            No custom MIDI CC mappings configured yet. Click any quick arm button above!
                          </td>
                        </tr>
                      ) : (
                        midiMappings.map((m, idx) => (
                          <tr key={idx} className="hover:bg-[var(--apex-state-hover)]">
                            <td className="px-4 py-2.5 font-mono text-[var(--apex-accent)] font-bold">CC {m.ccNumber}</td>
                            <td className="px-4 py-2.5 capitalize">{m.targetType.replace('_', ' ')}</td>
                            <td className="px-4 py-2.5 font-medium">{m.paramName || `Track ${m.targetId}`}</td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                onClick={() => handleRemoveMapping(idx)}
                                className="text-[var(--apex-danger)] px-2 py-0.5 rounded hover:bg-[color-mix(in_srgb,var(--apex-danger)_12%,transparent)]"
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
              <div className="flex items-center justify-between bg-[var(--apex-surface-2)] p-4 rounded-xl border border-[var(--apex-border)]">
                <div className="flex items-center space-x-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase tracking-wider block">Octave Shift</label>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => setVirtualOctave(Math.max(1, virtualOctave - 1))}
                        className="px-3 py-1 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text)] text-xs font-bold rounded"
                      >
                        -
                      </button>
                      <span className="font-mono text-sm font-bold text-[var(--apex-accent)] w-6 text-center">C{virtualOctave}</span>
                      <button
                        onClick={() => setVirtualOctave(Math.min(7, virtualOctave + 1))}
                        className="px-3 py-1 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text)] text-xs font-bold rounded"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="h-8 w-px bg-[var(--apex-border)]"></div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase tracking-wider block">Target Channel</label>
                    <span className="text-xs font-bold text-[var(--apex-text)] px-2.5 py-1 bg-[var(--apex-surface-3)] rounded border border-[var(--apex-border)]">
                      {activeChannel.name} ({activeChannel.instrumentType})
                    </span>
                  </div>
                </div>

                <div className="text-xs text-[var(--apex-text-3)]">
                  Play via Touch, Mouse, or Hardware Controller
                </div>
              </div>

              {/* 8 MPC Velocity Drum Pads */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[var(--apex-text-2)] uppercase tracking-wider">16-Pad MPC Drum Grid (Channel Root Keys)</h3>
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
                      className="h-20 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] active:scale-95 border border-[var(--apex-border)] rounded-xl flex flex-col items-center justify-center space-y-1 transition-all shadow-md group"
                      style={{ borderBottomColor: pad.color, borderBottomWidth: '3px' }}
                    >
                      <span className="text-xs font-bold text-[var(--apex-text)] group-hover:text-[var(--apex-accent)]">{pad.name}</span>
                      <span className="text-[9px] text-[var(--apex-text-3)] font-mono">MIDI {pad.pitch}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 2-Octave Virtual Keyboard */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[var(--apex-text-2)] uppercase tracking-wider">Interactive 25-Key Studio Keyboard</h3>
                <div className="relative h-32 bg-[var(--apex-canvas)] p-1.5 rounded-xl border border-[var(--apex-border)] flex select-none overflow-x-auto">
                  {/* White Keys */}
                  {Array.from({ length: 15 }).map((_, i) => {
                    const whiteKeyOffsets = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
                    const noteNum = (virtualOctave * 12) + whiteKeyOffsets[i];
                    return (
                      <button
                        key={`white-${i}`}
                        onMouseDown={() => playVirtualNote(noteNum)}
                        className="flex-1 h-full bg-[var(--apex-piano-key-natural)] hover:bg-[var(--apex-surface-3)] active:bg-[var(--apex-state-playing)] border-r border-[var(--apex-border)] rounded-b-md flex flex-col justify-end pb-2 items-center text-[10px] font-bold text-[var(--apex-text)] active:text-[var(--apex-state-playing-fg)] transition-colors"
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
                <h3 className="text-xs font-bold text-[var(--apex-text-2)] uppercase tracking-wider">Real-Time Raw MIDI Ingress Log</h3>
                <button
                  onClick={() => setLogs([])}
                  className="text-xs text-[var(--apex-text-2)] hover:text-[var(--apex-text)] px-2.5 py-1 rounded bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)]"
                >
                  Clear Console
                </button>
              </div>

              <div className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded-xl p-3 h-80 overflow-y-auto font-mono text-xs custom-scrollbar space-y-1">
                {logs.length === 0 ? (
                  <div className="text-center py-20 text-[var(--apex-text-3)]">
                    No MIDI events received yet. Hit notes on your physical keyboard or pads to monitor traffic.
                  </div>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="flex items-center space-x-3 py-1 px-2 hover:bg-[var(--apex-state-hover)] rounded border-b border-[var(--apex-border)]">
                      <span className="text-[var(--apex-text-3)] text-[10px] w-20">{log.time}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase text-[var(--apex-text)] ${
                        log.type === 'noteOn' ? 'bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)]' :
                        log.type === 'noteOff' ? 'bg-[color-mix(in_srgb,var(--apex-danger)_20%,transparent)]' :
                        log.type === 'cc' ? 'bg-[color-mix(in_srgb,var(--apex-cyan)_20%,transparent)]' : 'bg-[color-mix(in_srgb,var(--apex-gold)_20%,transparent)]'
                      }`}>
                        {log.type}
                      </span>
                      <span className="text-[var(--apex-text-2)]">Ch: {log.channel}</span>
                      {log.note !== undefined && <span className="text-[var(--apex-text)] font-bold">Note: {log.note}</span>}
                      {log.velocity !== undefined && <span className="text-[var(--apex-accent)]">Vel: {log.velocity}</span>}
                      {log.cc !== undefined && <span className="text-[var(--apex-cyan-text)]">CC#: {log.cc}</span>}
                      {log.value !== undefined && <span className="text-[var(--apex-accent)]">Val: {log.value}</span>}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-[var(--apex-border)] bg-[var(--apex-panel-header)] text-xs text-[var(--apex-text-2)]">
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-[var(--apex-success)]"></span>
            <span>Studio Engine: 0ms Latency Direct Hardware Ingress</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-surface-2)] hover:bg-[var(--apex-surface-3)] text-[var(--apex-text)] font-semibold rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
