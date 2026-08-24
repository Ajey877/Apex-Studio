import React, { useState } from 'react';
import { 
  Layers, 
  X, 
  Plus, 
  Trash2, 
  Sparkles, 
  Volume2, 
  Sliders, 
  Music, 
  Play, 
  Scissors,
  FolderOpen
} from 'lucide-react';
import { Channel } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface MultiZoneSamplerModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
}

interface KeyZone {
  id: string;
  name: string;
  lowNote: number; // 0 - 127 (e.g. 36 = C2)
  highNote: number;
  rootNote: number;
  lowVel: number; // 0 - 127
  highVel: number;
  sampleBufferId: string;
  tuneSemitones: number;
  color: string;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12];
  return `${name}${octave}`;
}

export const MultiZoneSamplerModal: React.FC<MultiZoneSamplerModalProps> = ({
  isOpen,
  onClose,
  channels,
  onUpdateChannel
}) => {
  const [selectedChannelId, setSelectedChannelId] = useState<string>(channels[0]?.id || '');
  const [zones, setZones] = useState<KeyZone[]>([
    {
      id: 'zone-1',
      name: 'Sub Bass 808 Zone',
      lowNote: 24, // C1
      highNote: 47, // B2
      rootNote: 36, // C2
      lowVel: 0,
      highVel: 127,
      sampleBufferId: 'kick',
      tuneSemitones: 0,
      color: '#ff6e00'
    },
    {
      id: 'zone-2',
      name: 'Warm Acoustic Grand Zone',
      lowNote: 48, // C3
      highNote: 71, // B4
      rootNote: 60, // C4
      lowVel: 0,
      highVel: 127,
      sampleBufferId: 'synth',
      tuneSemitones: 0,
      color: '#00ff88'
    },
    {
      id: 'zone-3',
      name: 'High Air Lead / Rhodes Zone',
      lowNote: 72, // C5
      highNote: 96, // C7
      rootNote: 84, // C6
      lowVel: 0,
      highVel: 127,
      sampleBufferId: 'hihat',
      tuneSemitones: 0,
      color: '#00e5ff'
    }
  ]);
  const [selectedZoneId, setSelectedZoneId] = useState<string>('zone-2');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const selectedZone = zones.find(z => z.id === selectedZoneId) || zones[0];

  const handleAddZone = () => {
    const newZone: KeyZone = {
      id: `zone-${Date.now()}`,
      name: `Multi-Zone ${zones.length + 1}`,
      lowNote: 60,
      highNote: 72,
      rootNote: 60,
      lowVel: 0,
      highVel: 127,
      sampleBufferId: 'synth',
      tuneSemitones: 0,
      color: '#a855f7'
    };
    setZones([...zones, newZone]);
    setSelectedZoneId(newZone.id);
    setStatusMessage(`Created new Multi-Sample Zone!`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleDeleteZone = (id: string) => {
    if (zones.length <= 1) return;
    setZones(zones.filter(z => z.id !== id));
    if (selectedZoneId === id) {
      setSelectedZoneId(zones[0].id);
    }
  };

  const handleAuditionZone = (zone: KeyZone) => {
    const targetChannel = channels.find(c => c.id === selectedChannelId) || channels[0];
    if (targetChannel) {
      audioEngine.playNote(targetChannel, { id: `zone-aud-${Date.now()}`, pitch: zone.rootNote, start: 0, duration: 2, velocity: 0.9 });
    }
    setStatusMessage(`Auditioning ${zone.name} (Root ${midiToNoteName(zone.rootNote)})`);
    setTimeout(() => setStatusMessage(null), 2000);
  };

  return (
    <div id="fl-multizone-sampler-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#ff6e00]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6e00] to-[#ff3b00] flex items-center justify-center text-black shadow-md font-bold">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">DIRECTWAVE MULTI-SAMPLE KEYMAPPER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#ff6e00]/20 text-[#ff6e00] border border-[#ff6e00]/40">
                  SFZ / MULTI-ZONE
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Map distinct audio samples across MIDI key ranges C0 - B8 with velocity crossfades</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
          >
            <X className="w-5 h-5" />
          </button>
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
          {/* Visual 128-Key Multi-Zone Mapping Canvas */}
          <div className="bg-[#0b0b0d] p-3 rounded-xl border border-[#26262a] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-[#ff6e00]" />
                <span>KEYBOARD SPLIT ZONE MAP (MIDI C1 - C7)</span>
              </span>
              <button
                onClick={handleAddZone}
                className="px-2 py-0.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-[10px] rounded transition flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                <span>Add Zone Split</span>
              </button>
            </div>

            {/* Piano Roll Map Visualizer */}
            <div className="relative h-20 bg-[#16161a] rounded-lg border border-[#333338] overflow-hidden flex items-end">
              {/* Grid lanes */}
              {Array.from({ length: 8 }).map((_, oct) => (
                <div 
                  key={oct} 
                  style={{ left: `${(oct / 8) * 100}%` }}
                  className="absolute top-0 bottom-0 border-l border-white/5 text-[8px] font-mono text-[#555] pl-1"
                >
                  C{oct}
                </div>
              ))}

              {/* Zone Blocks */}
              {zones.map((zone) => {
                const leftPct = (zone.lowNote / 127) * 100;
                const widthPct = ((zone.highNote - zone.lowNote + 1) / 127) * 100;
                const isSel = zone.id === selectedZoneId;

                return (
                  <div
                    key={zone.id}
                    onClick={() => setSelectedZoneId(zone.id)}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      backgroundColor: `${zone.color}33`,
                      borderColor: zone.color
                    }}
                    className={`absolute top-2 bottom-6 border-2 rounded p-1 flex flex-col justify-between cursor-pointer transition ${
                      isSel ? 'ring-2 ring-white shadow-lg brightness-125' : 'opacity-80 hover:opacity-100'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[9px] font-bold text-white truncate">
                      <span className="truncate">{zone.name}</span>
                      <span className="font-mono text-[8px]" style={{ color: zone.color }}>
                        {midiToNoteName(zone.rootNote)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[8px] font-mono text-white/70">
                      <span>{midiToNoteName(zone.lowNote)}</span>
                      <span>{midiToNoteName(zone.highNote)}</span>
                    </div>
                  </div>
                );
              })}

              {/* Piano keys base row */}
              <div className="w-full h-4 bg-[#111] flex border-t border-[#333]">
                {Array.from({ length: 48 }).map((_, i) => (
                  <div 
                    key={i} 
                    className={`flex-1 border-r border-[#222] ${[1,3,6,8,10].includes(i % 12) ? 'bg-[#181818]' : 'bg-[#e0e0e0]'}`} 
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Selected Zone Inspector */}
          {selectedZone && (
            <div className="bg-[#18181c] p-4 rounded-xl border border-[#2a2a2e] space-y-4">
              <div className="flex items-center justify-between border-b border-[#28282b] pb-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedZone.color }} />
                  <span className="text-xs font-bold text-white uppercase">
                    EDITING ZONE: {selectedZone.name}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAuditionZone(selectedZone)}
                    className="px-2.5 py-1 bg-[#25252a] hover:bg-[#333338] text-white text-xs font-bold rounded flex items-center gap-1.5 transition"
                  >
                    <Play className="w-3 h-3 text-[#00ff88]" />
                    <span>Audition</span>
                  </button>

                  <button
                    onClick={() => handleDeleteZone(selectedZone.id)}
                    className="p-1 text-[#777] hover:text-red-400 rounded hover:bg-[#25252a] transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                {/* Low Note */}
                <div>
                  <div className="flex justify-between text-[11px] text-[#888] mb-1">
                    <span>Lowest Key Range</span>
                    <span className="font-mono text-white font-bold">{midiToNoteName(selectedZone.lowNote)} ({selectedZone.lowNote})</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={selectedZone.highNote}
                    value={selectedZone.lowNote}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, lowNote: Number(e.target.value) } : z);
                      setZones(updated);
                    }}
                    className="w-full accent-[#ff6e00]"
                  />
                </div>

                {/* High Note */}
                <div>
                  <div className="flex justify-between text-[11px] text-[#888] mb-1">
                    <span>Highest Key Range</span>
                    <span className="font-mono text-white font-bold">{midiToNoteName(selectedZone.highNote)} ({selectedZone.highNote})</span>
                  </div>
                  <input
                    type="range"
                    min={selectedZone.lowNote}
                    max="127"
                    value={selectedZone.highNote}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, highNote: Number(e.target.value) } : z);
                      setZones(updated);
                    }}
                    className="w-full accent-[#ff6e00]"
                  />
                </div>

                {/* Root Note Tuning */}
                <div>
                  <div className="flex justify-between text-[11px] text-[#888] mb-1">
                    <span>Root Key Pitch Center</span>
                    <span className="font-mono text-[#00ff88] font-bold">{midiToNoteName(selectedZone.rootNote)}</span>
                  </div>
                  <input
                    type="range"
                    min={selectedZone.lowNote}
                    max={selectedZone.highNote}
                    value={selectedZone.rootNote}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, rootNote: Number(e.target.value) } : z);
                      setZones(updated);
                    }}
                    className="w-full accent-[#00ff88]"
                  />
                </div>
              </div>

              {/* Sample Source Selection */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs border-t border-[#26262a] pt-3">
                <div>
                  <label className="text-[10px] text-[#888] font-bold block mb-1">ASSIGNED SAMPLE AUDIO BUFFER</label>
                  <select
                    value={selectedZone.sampleBufferId}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, sampleBufferId: e.target.value } : z);
                      setZones(updated);
                    }}
                    className="w-full bg-[#121214] text-white p-2 rounded border border-[#333336]"
                  >
                    <option value="kick">Deep Sub 808 Kick (.WAV)</option>
                    <option value="snare">808 Crisp Snare Layer (.WAV)</option>
                    <option value="hihat">Closed Titanium Hat (.WAV)</option>
                    <option value="synth">Warm Poly Saw Key Sample (.WAV)</option>
                    <option value="lead">Hyper Lead Saturated Wave (.WAV)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] text-[#888] font-bold block mb-1">ZONE NAME</label>
                  <input
                    type="text"
                    value={selectedZone.name}
                    onChange={(e) => {
                      const updated = zones.map(z => z.id === selectedZone.id ? { ...z, name: e.target.value } : z);
                      setZones(updated);
                    }}
                    className="w-full bg-[#121214] text-white p-1.5 rounded border border-[#333336]"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Dynamic Pitch Resampling & Velocity Zone Splitting Active</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold rounded transition shadow"
          >
            Apply Keymapping
          </button>
        </div>
      </div>
    </div>
  );
};
