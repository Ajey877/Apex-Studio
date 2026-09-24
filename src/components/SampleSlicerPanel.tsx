import React, { useMemo, useState } from 'react';
import { Scissors, Play, Wand2 } from 'lucide-react';
import type { Channel, CustomSampleData, DrumPad } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { createEvenSlices, detectTransientSlices, SampleSlice } from '../audio/sampleSlicer';

interface SampleSlicerPanelProps {
  channel: Channel;
  sampleLibrary: CustomSampleData[];
  onUpdateChannel: (channelId: string, updates: Partial<Channel>) => void;
}

export const SampleSlicerPanel: React.FC<SampleSlicerPanelProps> = ({ channel, sampleLibrary, onUpdateChannel }) => {
  const [sampleId, setSampleId] = useState(sampleLibrary[0]?.id || '');
  const [sliceCount, setSliceCount] = useState(8);
  const [slices, setSlices] = useState<SampleSlice[]>([]);
  const sample = sampleLibrary.find(item => item.id === sampleId);

  const waveform = useMemo(() => sample?.waveformPeaks || [], [sample]);
  const maxPeak = Math.max(0.001, ...waveform.map(Math.abs));

  const detect = () => {
    if (!sample) return;
    setSlices(detectTransientSlices(sample, sliceCount));
  };

  const even = () => setSlices(createEvenSlices(sliceCount));

  const audition = (slice: SampleSlice) => {
    if (!sample) return;
    const pads: DrumPad[] = [{
      id: `preview-${slice.id}`, note: 36, name: slice.id, sampleId: sample.id,
      volume: 1, pan: 0, tuneSemitones: 0, trimStart: slice.start, trimEnd: slice.end
    }];
    audioEngine.playNote({ ...channel, instrumentType: 'drumpad', drumPads: pads }, {
      id: `slice-preview-${Date.now()}`, pitch: 36, start: 0, duration: 1, velocity: 1
    });
  };

  const mapToPads = () => {
    if (!sample || !slices.length) return;
    const pads: DrumPad[] = slices.slice(0, 16).map((slice, index) => ({
      id: `slice-pad-${index + 1}`,
      note: 36 + index,
      name: `Slice ${index + 1}`,
      sampleId: sample.id,
      volume: 1,
      pan: 0,
      tuneSemitones: 0,
      trimStart: slice.start,
      trimEnd: slice.end,
      reverse: false,
      loop: false,
      chokeGroup: 0
    }));
    onUpdateChannel(channel.id, { instrumentType: 'drumpad', drumPads: pads });
  };

  return (
    <div className="w-full max-w-4xl bg-[#17171a] border border-[#333336] rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-bold text-white flex items-center gap-2"><Scissors className="w-4 h-4 text-[#ff6e00]" /> SAMPLE SLICER</div>
          <div className="text-[9px] text-[#777] mt-1">Detect transients, preview slices, then map them to the 16-pad sampler.</div>
        </div>
        <span className="text-[9px] text-[#00ff88] font-mono">{slices.length} SLICES</span>
      </div>

      <div className="flex flex-col md:flex-row gap-2">
        <select value={sampleId} onChange={e => { setSampleId(e.target.value); setSlices([]); }}
          className="flex-1 bg-[#111113] text-white text-xs p-2 rounded border border-[#333336]">
          <option value="">Select sample</option>
          {sampleLibrary.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select value={sliceCount} onChange={e => setSliceCount(Number(e.target.value))}
          className="bg-[#111113] text-white text-xs p-2 rounded border border-[#333336]">
          {[4, 8, 12, 16].map(n => <option key={n} value={n}>{n} slices</option>)}
        </select>
        <button type="button" onClick={detect} disabled={!sample} className="px-3 py-2 bg-[#ff6e00] text-black rounded font-bold text-xs flex items-center gap-2 disabled:opacity-40"><Wand2 className="w-3 h-3" /> DETECT</button>
        <button type="button" onClick={even} disabled={!sample} className="px-3 py-2 bg-[#222225] text-white rounded border border-[#333336] text-xs disabled:opacity-40">EVEN SPLIT</button>
      </div>

      {sample && (
        <div className="bg-[#101012] border border-[#29292d] rounded-lg p-3">
          <div className="h-28 flex items-end gap-px overflow-hidden">
            {waveform.map((peak, index) => (
              <div key={index} className="flex-1 min-w-px bg-[#ff6e00]/70" style={{ height: `${Math.max(3, Math.round(Math.abs(peak) / maxPeak * 100))}%` }} />
            ))}
            {slices.slice(1, -1).map(slice => (
              <div key={slice.id} className="absolute" />
            ))}
          </div>
        </div>
      )}

      {slices.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-2">
          {slices.map((slice, index) => (
            <button type="button" key={slice.id} onClick={() => audition(slice)}
              className="bg-[#111113] border border-[#333336] hover:border-[#ff6e00] rounded-lg p-2 text-left">
              <div className="text-[10px] text-white font-bold">Slice {index + 1}</div>
              <div className="text-[8px] text-[#777] font-mono mt-1">{Math.round(slice.start * 100)}% → {Math.round(slice.end * 100)}%</div>
              <div className="text-[8px] text-[#555] mt-1 flex items-center gap-1"><Play className="w-2.5 h-2.5" /> preview</div>
            </button>
          ))}
        </div>
      )}

      <button type="button" onClick={mapToPads} disabled={!slices.length} className="w-full py-2.5 bg-[#00ff88] text-black rounded font-bold text-xs disabled:opacity-40">
        MAP SLICES TO 16-PAD SAMPLER
      </button>
    </div>
  );
};
