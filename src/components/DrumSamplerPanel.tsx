import React, { useMemo, useState } from 'react';
import { Drum, Play, Volume2 } from 'lucide-react';
import type { Channel, CustomSampleData, DrumPad } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface DrumSamplerPanelProps {
  channel: Channel;
  sampleLibrary: CustomSampleData[];
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
}

const DEFAULT_NOTES = Array.from({ length: 16 }, (_, index) => 36 + index);
const PAD_COLORS = ['#ff6e00', '#ff9800', '#ffc107', '#00ff88', '#00e5ff', '#a855f7', '#ef4444', '#ec4899'];

const createPads = (channel: Channel): DrumPad[] => {
  if (channel.drumPads?.length) return channel.drumPads;
  return DEFAULT_NOTES.map((note, index) => ({
    id: `pad-${note}`,
    note,
    name: ['Kick', 'Snare', 'Clap', 'Hat', 'Open Hat', 'Tom', 'Tom 2', 'Crash'][index % 8],
    sampleId: index === 0 ? channel.customSample?.id || '' : '',
    volume: 1,
    pan: 0,
    tuneSemitones: 0,
    chokeGroup: [3, 4].includes(index) ? 1 : 0
  }));
};

export const DrumSamplerPanel: React.FC<DrumSamplerPanelProps> = ({ channel, sampleLibrary, onUpdateChannel }) => {
  const initialPads = useMemo(() => createPads(channel), [channel.id]);
  const [pads, setPads] = useState<DrumPad[]>(initialPads);
  const [selectedId, setSelectedId] = useState(initialPads[0]?.id || '');
  const selected = pads.find(pad => pad.id === selectedId) || pads[0];

  const commit = (next: DrumPad[]) => {
    setPads(next);
    onUpdateChannel(channel.id, { instrumentType: 'drumpad', drumPads: next });
  };

  const updateSelected = (updates: Partial<DrumPad>) => {
    if (!selected) return;
    commit(pads.map(pad => pad.id === selected.id ? { ...pad, ...updates } : pad));
  };

  const trigger = (pad: DrumPad) => {
    audioEngine.playNote(channel, {
      id: `drum-pad-${pad.id}-${Date.now()}`,
      pitch: pad.note,
      start: 0,
      duration: 1,
      velocity: 1
    });
  };

  return (
    <div className="bg-[#17171a] border border-[#333336] rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-bold text-white flex items-center gap-2"><Drum className="w-4 h-4 text-[#ff6e00]" /> DRUM SAMPLER</div>
          <div className="text-[9px] text-[#777] mt-1">16 velocity-sensitive pads · choke groups · sample library</div>
        </div>
        <span className="text-[9px] font-mono text-[#00ff88]">{sampleLibrary.length} LIBRARY SAMPLES</span>
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
        {pads.map((pad, index) => (
          <button key={pad.id} type="button" onClick={() => { setSelectedId(pad.id); trigger(pad); }}
            className={`aspect-square rounded-lg border p-2 flex flex-col justify-between text-left transition ${selected?.id === pad.id ? 'border-white ring-2 ring-[#ff6e00]/60' : 'border-[#333336]'} bg-[#101012] hover:bg-[#222225]`}>
            <span className="text-[9px] font-bold text-white truncate">{pad.name || `Pad ${index + 1}`}</span>
            <span className="text-[8px] font-mono" style={{ color: PAD_COLORS[index % PAD_COLORS.length] }}>MIDI {pad.note}</span>
            <span className="text-[8px] text-[#666] truncate">{sampleLibrary.find(s => s.id === pad.sampleId)?.name || 'Empty'}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-[#111113] border border-[#29292d] rounded-lg p-3">
          <div className="space-y-2">
            <label className="text-[9px] text-[#777] font-bold">SAMPLE</label>
            <select value={selected.sampleId} onChange={e => updateSelected({ sampleId: e.target.value })}
              className="w-full bg-[#1b1b1f] text-white text-xs p-2 rounded border border-[#333336]">
              <option value="">Empty pad</option>
              {sampleLibrary.map(sample => <option key={sample.id} value={sample.id}>{sample.name}</option>)}
            </select>
            <input value={selected.name} onChange={e => updateSelected({ name: e.target.value })} className="w-full bg-[#1b1b1f] text-white text-xs p-2 rounded border border-[#333336]" placeholder="Pad name" />
          </div>
          <div className="space-y-2">
            <label className="text-[9px] text-[#777] font-bold">VOLUME / PAN / TUNE</label>
            <div className="text-[9px] text-[#888]">Volume {Math.round(selected.volume * 100)}%</div>
            <input type="range" min="0" max="1.25" step="0.01" value={selected.volume} onChange={e => updateSelected({ volume: Number(e.target.value) })} className="w-full accent-[#ff6e00]" />
            <div className="text-[9px] text-[#888]">Pan {selected.pan.toFixed(2)}</div>
            <input type="range" min="-1" max="1" step="0.01" value={selected.pan} onChange={e => updateSelected({ pan: Number(e.target.value) })} className="w-full accent-[#00e5ff]" />
            <div className="text-[9px] text-[#888]">Tune {selected.tuneSemitones} st</div>
            <input type="range" min="-24" max="24" value={selected.tuneSemitones} onChange={e => updateSelected({ tuneSemitones: Number(e.target.value) })} className="w-full accent-[#00ff88]" />
          </div>
          <div className="space-y-2">
            <label className="text-[9px] text-[#777] font-bold">PLAYBACK</label>
            <button type="button" onClick={() => trigger(selected)} className="w-full py-2 bg-[#ff6e00] text-black rounded font-bold text-xs flex items-center justify-center gap-2"><Play className="w-3 h-3" /> AUDITION</button>
            <label className="flex items-center gap-2 text-[10px] text-white"><input type="checkbox" checked={Boolean(selected.reverse)} onChange={e => updateSelected({ reverse: e.target.checked })} /> Reverse</label>
            <label className="flex items-center gap-2 text-[10px] text-white"><input type="checkbox" checked={Boolean(selected.loop)} onChange={e => updateSelected({ loop: e.target.checked })} /> Loop</label>
            <label className="text-[9px] text-[#777] font-bold">CHOKE GROUP</label>
            <select value={selected.chokeGroup || 0} onChange={e => updateSelected({ chokeGroup: Number(e.target.value) })} className="w-full bg-[#1b1b1f] text-white text-xs p-1.5 rounded border border-[#333336]">
              <option value="0">Off</option><option value="1">Hi-hat</option><option value="2">Toms</option><option value="3">Custom 3</option>
            </select>
          </div>
        </div>
      )}

      <div className="text-[9px] text-[#666] flex items-center gap-1"><Volume2 className="w-3 h-3" /> Pad velocity is routed through the real sample voice and channel mixer.</div>
    </div>
  );
};
