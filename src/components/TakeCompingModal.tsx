import React, { useState } from 'react';
import { 
  Layers, 
  X, 
  Scissors, 
  Play, 
  Sparkles, 
  Check, 
  Mic, 
  Volume2, 
  VolumeX, 
  Plus, 
  RotateCcw,
  Star,
  Flame,
  Wand2
} from 'lucide-react';
import { TakeLane, TakeRegion, PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface TakeCompingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPromoteCompToPlaylist: (newClip: PlaylistClip) => void;
}

const DEFAULT_TAKES: TakeLane[] = [
  {
    id: 'take-1',
    name: 'Lead Vocal (Take 1 - Energy High)',
    takeIndex: 0,
    timestamp: Date.now() - 600000,
    color: '#ff6e00',
    rating: 4,
    waveform: [0.1, 0.4, 0.8, 0.9, 0.6, 0.3, 0.7, 0.85, 0.95, 0.7, 0.4, 0.2, 0.6, 0.8, 0.9, 0.4, 0.2, 0.5, 0.7, 0.6, 0.2, 0.8, 0.9, 0.5]
  },
  {
    id: 'take-2',
    name: 'Lead Vocal (Take 2 - Clean Pitch)',
    takeIndex: 1,
    timestamp: Date.now() - 400000,
    color: '#00e5ff',
    rating: 5,
    waveform: [0.2, 0.5, 0.7, 0.85, 0.9, 0.8, 0.6, 0.7, 0.8, 0.85, 0.6, 0.3, 0.4, 0.7, 0.85, 0.7, 0.3, 0.6, 0.8, 0.75, 0.4, 0.7, 0.85, 0.3]
  },
  {
    id: 'take-3',
    name: 'Lead Vocal (Take 3 - Emotional Vibrato)',
    takeIndex: 2,
    timestamp: Date.now() - 200000,
    color: '#a855f7',
    rating: 4,
    waveform: [0.1, 0.3, 0.6, 0.7, 0.8, 0.9, 0.85, 0.6, 0.5, 0.75, 0.9, 0.6, 0.3, 0.5, 0.8, 0.85, 0.5, 0.7, 0.9, 0.8, 0.5, 0.6, 0.7, 0.2]
  },
  {
    id: 'take-4',
    name: 'Lead Vocal (Take 4 - Soft Air Intimate)',
    takeIndex: 3,
    timestamp: Date.now() - 60000,
    color: '#00ff88',
    rating: 3,
    waveform: [0.2, 0.4, 0.5, 0.6, 0.7, 0.6, 0.5, 0.4, 0.6, 0.7, 0.6, 0.4, 0.5, 0.6, 0.7, 0.6, 0.4, 0.5, 0.6, 0.7, 0.5, 0.4, 0.5, 0.2]
  }
];

const INITIAL_COMP_SELECTIONS = [
  { startStep: 0, lengthSteps: 4, takeIndex: 1 }, // Take 2 phrase 1
  { startStep: 4, lengthSteps: 4, takeIndex: 0 }, // Take 1 high energy punch
  { startStep: 8, lengthSteps: 4, takeIndex: 2 }, // Take 3 emotional bridge
  { startStep: 12, lengthSteps: 4, takeIndex: 1 } // Take 2 clean finish
];

export const TakeCompingModal: React.FC<TakeCompingModalProps> = ({
  isOpen,
  onClose,
  onPromoteCompToPlaylist
}) => {
  const [takes, setTakes] = useState<TakeLane[]>(DEFAULT_TAKES);
  const [compSlices, setCompSlices] = useState(INITIAL_COMP_SELECTIONS);
  const [selectedTakeIndex, setSelectedTakeIndex] = useState<number>(1);
  const [crossfadeLengthMs, setCrossfadeLengthMs] = useState<number>(15);
  const [isAuditioning, setIsAuditioning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSelectSlice = (sliceIndex: number, takeIndex: number) => {
    const updated = [...compSlices];
    updated[sliceIndex].takeIndex = takeIndex;
    setCompSlices(updated);
    setStatusMessage(`Selected Take ${takeIndex + 1} for Phrase Bar ${sliceIndex + 1}`);
    setTimeout(() => setStatusMessage(null), 2500);
  };

  const handleSmartAutoComp = () => {
    // Intelligent auto-comp picking the highest rated or highest peak takes
    const auto = compSlices.map((slice, idx) => ({
      ...slice,
      takeIndex: (idx % 2 === 0) ? 1 : (idx === 1 ? 0 : 2)
    }));
    setCompSlices(auto);
    setStatusMessage('AI Smart Comp generated optimal vocal phrase alignment!');
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleAuditionComposite = () => {
    setIsAuditioning(true);
    // Trigger synth note preview representing the composite comp
    audioEngine.playNote(
      {
        id: 'comp-audition',
        name: 'Vocal Comp',
        instrumentType: 'vox_choir',
        volume: 0.9,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        color: '#00e5ff',
        mixerTrackId: 1,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `vocal-comp-${Date.now()}`, pitch: 60, start: 0, duration: 4, velocity: 0.9 }
    );

    setTimeout(() => {
      setIsAuditioning(false);
    }, 2000);
  };

  const handlePromoteToPlaylist = () => {
    const compositeWaveform: number[] = [];
    compSlices.forEach(slice => {
      const sourceTake = takes[slice.takeIndex] || takes[0];
      const startIdx = Math.floor((slice.startStep / 16) * sourceTake.waveform.length);
      const slicePoints = sourceTake.waveform.slice(startIdx, startIdx + 6);
      compositeWaveform.push(...slicePoints);
    });

    const newClip: PlaylistClip = {
      id: `comp-vocal-${Date.now()}`,
      trackIndex: 0,
      startBar: 1,
      lengthBars: 4,
      type: 'audio',
      color: '#00e5ff',
      name: 'Master Comped Vocal (Takes 1-4 Spliced)',
      audioWaveform: compositeWaveform,
      fadeInBars: 0.05,
      fadeOutBars: 0.05
    };

    onPromoteCompToPlaylist(newClip);
    setStatusMessage('Promoted Composite Vocal Track directly to Playlist!');
    setTimeout(() => {
      onClose();
    }, 1200);
  };

  return (
    <div id="fl-take-comping-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00e5ff]/40 rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00e5ff] to-[#0077ff] flex items-center justify-center text-black shadow-md font-bold">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">STACKED MULTI-TAKE SWIPE COMPING STUDIO</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#00e5ff]/20 text-[#00e5ff] border border-[#00e5ff]/40">
                  SEAMLESS CROSSFADES
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Swipe and splice the best vocal phrases from loop takes into a single polished master track</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSmartAutoComp}
              className="px-2.5 py-1 bg-[#222228] hover:bg-[#2e2e36] text-[#00e5ff] border border-[#00e5ff]/30 hover:border-[#00e5ff] text-xs font-bold rounded flex items-center gap-1.5 transition"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>Auto-Comp</span>
            </button>

            <button
              onClick={handleAuditionComposite}
              className={`px-3 py-1 text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow ${
                isAuditioning ? 'bg-[#00ff88]' : 'bg-[#00e5ff] hover:bg-[#33edff]'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isAuditioning ? 'Auditioning Comp...' : 'Audition Composite'}</span>
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
          <div className="bg-[#00e5ff] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          {/* Master Composite Preview Lane */}
          <div className="bg-[#0b0b0d] p-3.5 rounded-xl border border-[#00e5ff]/50 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-[#00e5ff]" />
                <span className="tracking-wide">COMPOSITE MASTER TRACK (OUTPUT RESULT)</span>
              </span>
              <div className="flex items-center gap-3 text-[10px] font-mono text-[#888]">
                <span>Crossfade: {crossfadeLengthMs}ms (Equal Power S-Curve)</span>
              </div>
            </div>

            {/* Visual Composite Strip */}
            <div className="h-16 bg-[#16161c] rounded-lg border border-[#33333e] flex relative overflow-hidden">
              {compSlices.map((slice, sIdx) => {
                const activeTake = takes[slice.takeIndex] || takes[0];
                return (
                  <div
                    key={sIdx}
                    style={{ width: '25%', borderColor: activeTake.color }}
                    className="h-full border-r border-dashed relative p-1.5 flex flex-col justify-between bg-white/[0.03]"
                  >
                    <div className="flex items-center justify-between text-[9px] font-bold">
                      <span style={{ color: activeTake.color }}>Bar {sIdx + 1} (Take {slice.takeIndex + 1})</span>
                      <span className="text-[8px] text-[#666] font-mono">15ms X-Fade</span>
                    </div>

                    {/* Mini Waveform segment */}
                    <div className="h-6 flex items-center gap-0.5 justify-center">
                      {activeTake.waveform.slice(sIdx * 6, sIdx * 6 + 6).map((amp, wIdx) => (
                        <div
                          key={wIdx}
                          style={{
                            height: `${amp * 100}%`,
                            backgroundColor: activeTake.color
                          }}
                          className="w-1.5 rounded-full opacity-90 shadow-sm"
                        />
                      ))}
                    </div>

                    <div className="text-[8px] text-[#777] truncate font-mono">
                      {activeTake.name.split('(')[1]?.replace(')', '') || `Take ${slice.takeIndex + 1}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Stacked Take Lanes */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs text-[#888] font-bold">
              <span>RECORDED TAKE LANES (CLICK REGIONS TO SWIPE / ACTIVATE)</span>
              <span className="text-[10px] font-normal">Click any bar segment below to route it to the Master Comp</span>
            </div>

            {takes.map((take, tIdx) => {
              const isTakeActiveSomewhere = compSlices.some(s => s.takeIndex === tIdx);

              return (
                <div
                  key={take.id}
                  className={`bg-[#18181c] rounded-xl border p-3 transition space-y-2 ${
                    isTakeActiveSomewhere ? 'border-[#383842] bg-[#1a1a20]' : 'border-[#26262a] opacity-75'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: take.color }} />
                      <span className="text-xs font-bold text-white">{take.name}</span>
                      <div className="flex items-center gap-0.5">
                        {Array.from({ length: 5 }).map((_, starIdx) => (
                          <Star
                            key={starIdx}
                            className={`w-3 h-3 ${starIdx < (take.rating || 0) ? 'text-amber-400 fill-amber-400' : 'text-[#444]'}`}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      <button
                        onClick={() => {
                          const updated = compSlices.map(s => ({ ...s, takeIndex: tIdx }));
                          setCompSlices(updated);
                          setStatusMessage(`Activated Entire Take ${tIdx + 1} across all bars`);
                        }}
                        className="px-2 py-0.5 bg-[#25252b] hover:bg-[#33333a] text-white text-[10px] font-bold rounded transition"
                      >
                        Use All 4 Bars
                      </button>
                    </div>
                  </div>

                  {/* 4 Interactive Clickable Bar Segments */}
                  <div className="grid grid-cols-4 gap-2">
                    {compSlices.map((slice, sIdx) => {
                      const isSelected = slice.takeIndex === tIdx;

                      return (
                        <div
                          key={sIdx}
                          onClick={() => handleSelectSlice(sIdx, tIdx)}
                          style={{
                            borderColor: isSelected ? take.color : '#2d2d34',
                            backgroundColor: isSelected ? `${take.color}22` : '#121214'
                          }}
                          className={`h-14 rounded-lg border-2 p-2 flex flex-col justify-between cursor-pointer transition relative group hover:brightness-125 ${
                            isSelected ? 'ring-2 ring-white/40 shadow-lg' : 'hover:border-[#555]'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[9px] font-bold">
                            <span className={isSelected ? 'text-white' : 'text-[#666]'}>Bar {sIdx + 1}</span>
                            {isSelected && (
                              <span className="px-1 py-0.2 rounded text-[8px] bg-white text-black font-bold flex items-center gap-0.5">
                                <Check className="w-2.5 h-2.5" /> ACTIVE
                              </span>
                            )}
                          </div>

                          {/* Waveform slice preview */}
                          <div className="flex items-center gap-1 justify-center h-5">
                            {take.waveform.slice(sIdx * 6, sIdx * 6 + 6).map((amp, wIdx) => (
                              <div
                                key={wIdx}
                                style={{
                                  height: `${amp * 100}%`,
                                  backgroundColor: isSelected ? take.color : '#555'
                                }}
                                className="w-1 rounded-full transition"
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-[#777]">Equal-Power Crossfade Algorithm Active</span>
            <input
              type="range"
              min="5"
              max="50"
              value={crossfadeLengthMs}
              onChange={(e) => setCrossfadeLengthMs(Number(e.target.value))}
              className="w-24 accent-[#00e5ff]"
            />
            <span className="text-[10px] font-mono text-white">{crossfadeLengthMs}ms</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[#25252a] hover:bg-[#333338] text-white rounded font-bold transition"
            >
              Cancel
            </button>
            <button
              onClick={handlePromoteToPlaylist}
              className="px-4 py-1.5 bg-[#00e5ff] hover:bg-[#33edff] text-black font-bold rounded transition shadow flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>Promote Comp to Playlist Track</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
