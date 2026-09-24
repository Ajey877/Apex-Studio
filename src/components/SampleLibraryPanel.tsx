import React, { useMemo, useState } from 'react';
import { Folder, Package, Search, Tag, Drum, Layers, Plus, Save, AlertTriangle } from 'lucide-react';
import type { Channel, CustomSampleData, SamplePack } from '../types/daw';
import {
  createSamplePack,
  getSampleLibraryCategories,
  getSampleLibraryTags,
  getSamplePackCounts,
  sampleMatchesFilters,
  updateSampleMetadata
} from '../audio/sampleLibrary';

interface SampleLibraryPanelProps {
  samples: CustomSampleData[];
  packs: SamplePack[];
  selectedChannel: Channel;
  onUpdateSample: (sample: CustomSampleData) => void;
  onUpdatePacks: (packs: SamplePack[]) => void;
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
}

const defaultPads = (channel: Channel) => Array.from({ length: 16 }, (_, index) => ({
  id: `pad-${36 + index}`,
  note: 36 + index,
  name: ['Kick', 'Snare', 'Clap', 'Hat', 'Open Hat', 'Tom', 'Tom 2', 'Crash'][index % 8],
  sampleId: index === 0 ? '' : '',
  volume: 1,
  pan: 0,
  tuneSemitones: 0,
  chokeGroup: [3, 4].includes(index) ? 1 : 0
}));

export const SampleLibraryPanel: React.FC<SampleLibraryPanelProps> = ({
  samples, packs, selectedChannel, onUpdateSample, onUpdatePacks, onUpdateChannel
}) => {
  const [query, setQuery] = useState('');
  const [packId, setPackId] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [selectedId, setSelectedId] = useState(samples[0]?.id || '');
  const [newPackName, setNewPackName] = useState('');
  const [newTags, setNewTags] = useState('');

  const categories = useMemo(() => getSampleLibraryCategories(samples), [samples]);
  const tags = useMemo(() => getSampleLibraryTags(samples), [samples]);
  const counts = useMemo(() => getSamplePackCounts(samples, packs), [samples, packs]);
  const filtered = useMemo(
    () => samples.filter(sample => sampleMatchesFilters(sample, packs, { query, packId, category, tag })),
    [samples, packs, query, packId, category, tag]
  );
  const selected = samples.find(sample => sample.id === selectedId) || filtered[0] || samples[0] || null;

  const assignToDrum = () => {
    if (!selected || selected.audioUnavailable) return;
    const pads = selectedChannel.drumPads?.length ? [...selectedChannel.drumPads] : defaultPads(selectedChannel);
    const index = Math.max(0, pads.findIndex(pad => !pad.sampleId));
    pads[index] = { ...pads[index], sampleId: selected.id, name: selected.name };
    onUpdateChannel(selectedChannel.id, { instrumentType: 'drumpad', drumPads: pads });
  };

  const assignToMulti = () => {
    if (!selected || selected.audioUnavailable) return;
    const existing = selectedChannel.sampleZones?.length ? selectedChannel.sampleZones : [];
    const zone = {
      id: `zone-${selected.id}-library`,
      sampleId: selected.id,
      lowNote: 0,
      highNote: 127,
      rootNote: selected.rootPitch ?? 60,
      lowVelocity: 0,
      highVelocity: 127,
      tuneSemitones: 0,
      trimStart: selected.trimStart,
      trimEnd: selected.trimEnd,
      reverse: selected.reverse,
      loop: selectedChannel.synthParams.sampleLoop
    };
    onUpdateChannel(selectedChannel.id, {
      instrumentType: 'sampler',
      sampleZones: existing.length ? existing : [zone],
      customSample: selectedChannel.customSample?.id === selected.id ? selectedChannel.customSample : selected
    });
  };

  const createPack = () => {
    const name = newPackName.trim();
    if (!name) return;
    const pack = createSamplePack(name, category || 'Uncategorized', newTags.split(','));
    onUpdatePacks([...packs, pack]);
    setNewPackName('');
    setNewTags('');
    setPackId(pack.id);
  };

  return (
    <div className="w-full max-w-5xl bg-[#17171a] border border-[#333336] rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-white flex items-center gap-2"><Package className="w-4 h-4 text-[#ff6e00]" /> SAMPLE PACK LIBRARY</div>
          <div className="text-[9px] text-[#777] mt-1">Organize persistent samples, then send the same source asset to the slicer, drum pads or multi-zone sampler.</div>
        </div>
        <span className="text-[9px] font-mono text-[#00ff88]">{filtered.length}/{samples.length} SAMPLES</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
        <div className="md:col-span-2 relative">
          <Search className="absolute left-2 top-2.5 w-3.5 h-3.5 text-[#666]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search samples, packs, tags..."
            className="w-full bg-[#111113] text-white text-xs p-2 pl-7 rounded border border-[#333336]" />
        </div>
        <select value={packId} onChange={e => setPackId(e.target.value)} className="bg-[#111113] text-white text-xs p-2 rounded border border-[#333336]">
          <option value="">All packs</option>
          {packs.map(pack => <option key={pack.id} value={pack.id}>{pack.name} ({counts[pack.id] || 0})</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} className="bg-[#111113] text-white text-xs p-2 rounded border border-[#333336]">
          <option value="">All categories</option>
          {categories.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={tag} onChange={e => setTag(e.target.value)} className="bg-[#111113] text-white text-xs p-2 rounded border border-[#333336]">
          <option value="">All tags</option>
          {tags.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_260px] gap-3">
        <div className="bg-[#111113] border border-[#29292d] rounded-lg p-3 space-y-2">
          <div className="text-[9px] font-bold text-[#777] uppercase flex items-center gap-1"><Folder className="w-3 h-3" /> Packs</div>
          <button type="button" onClick={() => setPackId('')} className={`w-full text-left px-2 py-1.5 rounded text-[10px] ${!packId ? 'bg-[#ff6e00] text-black font-bold' : 'text-white hover:bg-[#222225]'}`}>All Samples</button>
          {packs.map(pack => (
            <button key={pack.id} type="button" onClick={() => setPackId(pack.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-[10px] flex justify-between ${packId === pack.id ? 'bg-[#ff6e00] text-black font-bold' : 'text-white hover:bg-[#222225]'}`}>
              <span className="truncate">{pack.name}</span><span>{counts[pack.id] || 0}</span>
            </button>
          ))}
          <div className="border-t border-[#29292d] pt-2 space-y-1.5">
            <input value={newPackName} onChange={e => setNewPackName(e.target.value)} placeholder="New pack name"
              className="w-full bg-[#18181c] text-white text-[10px] p-1.5 rounded border border-[#333336]" />
            <input value={newTags} onChange={e => setNewTags(e.target.value)} placeholder="tags: drums, one-shots"
              className="w-full bg-[#18181c] text-white text-[10px] p-1.5 rounded border border-[#333336]" />
            <button type="button" onClick={createPack} className="w-full py-1.5 bg-[#222225] text-white border border-[#333336] rounded text-[9px] font-bold flex items-center justify-center gap-1">
              <Plus className="w-3 h-3" /> CREATE PACK
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 content-start max-h-64 overflow-y-auto pr-1">
          {filtered.map(sample => (
            <button type="button" key={sample.id} onClick={() => setSelectedId(sample.id)}
              className={`text-left p-2 rounded-lg border ${selected?.id === sample.id ? 'border-[#ff6e00] bg-[#ff6e00]/10' : 'border-[#333336] bg-[#111113]'}`}>
              <div className="text-[10px] font-bold text-white truncate">{sample.name}</div>
              <div className="text-[8px] text-[#777] truncate">{sample.category || 'Uncategorized'}</div>
              <div className="text-[8px] text-[#555] mt-1 flex items-center gap-1"><Tag className="w-2.5 h-2.5" /> {(sample.tags || []).slice(0, 3).join(', ') || 'no tags'}</div>
              {sample.audioUnavailable && <div className="text-[8px] text-red-400 flex items-center gap-1 mt-1"><AlertTriangle className="w-2.5 h-2.5" /> audio missing</div>}
            </button>
          ))}
          {!filtered.length && <div className="col-span-full text-[10px] text-[#666] p-6 text-center">No samples match these filters.</div>}
        </div>

        <div className="bg-[#111113] border border-[#29292d] rounded-lg p-3 space-y-2">
          {selected ? <>
            <div className="text-xs font-bold text-white truncate">{selected.name}</div>
            <input value={selected.name} onChange={e => onUpdateSample(updateSampleMetadata(selected, { name: e.target.value }))}
              className="w-full bg-[#18181c] text-white text-[10px] p-1.5 rounded border border-[#333336]" />
            <select value={selected.packId || ''} onChange={e => onUpdateSample(updateSampleMetadata(selected, { packId: e.target.value || undefined }))}
              className="w-full bg-[#18181c] text-white text-[10px] p-1.5 rounded border border-[#333336]">
              <option value="">No pack</option>{packs.map(pack => <option key={pack.id} value={pack.id}>{pack.name}</option>)}
            </select>
            <input value={selected.category || ''} onChange={e => onUpdateSample(updateSampleMetadata(selected, { category: e.target.value }))}
              placeholder="Category" className="w-full bg-[#18181c] text-white text-[10px] p-1.5 rounded border border-[#333336]" />
            <input value={(selected.tags || []).join(', ')} onChange={e => onUpdateSample(updateSampleMetadata(selected, { tags: e.target.value.split(',') }))}
              placeholder="Tags, comma separated" className="w-full bg-[#18181c] text-white text-[10px] p-1.5 rounded border border-[#333336]" />
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button type="button" disabled={Boolean(selected.audioUnavailable)} onClick={assignToDrum} className="py-2 bg-[#ff6e00] text-black rounded text-[9px] font-bold flex items-center justify-center gap-1 disabled:opacity-40"><Drum className="w-3 h-3" /> DRUM PAD</button>
              <button type="button" disabled={Boolean(selected.audioUnavailable)} onClick={assignToMulti} className="py-2 bg-[#00ff88] text-black rounded text-[9px] font-bold flex items-center justify-center gap-1 disabled:opacity-40"><Layers className="w-3 h-3" /> MULTISAMPLER</button>
            </div>
            <div className="text-[8px] text-[#666] flex items-center gap-1"><Save className="w-2.5 h-2.5" /> Metadata is stored in the project document.</div>
          </> : <div className="text-[10px] text-[#666]">Import a sample to start building a pack.</div>}
        </div>
      </div>
    </div>
  );
};
