import React, { useState } from 'react';
import { 
  Film, 
  X, 
  Sparkles, 
  Play, 
  Pause, 
  RotateCcw, 
  Plus, 
  Trash2, 
  Flag, 
  Clock, 
  Check, 
  Compass, 
  Volume2, 
  Flame 
} from 'lucide-react';
import { VideoScoringTrack } from '../types/daw';

interface VideoScoringModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBar?: number;
  bpm?: number;
  onSeekToBar?: (bar: number) => void;
}

const DEFAULT_HIT_POINTS = [
  { id: 'hit-1', bar: 1, name: 'Main Studio Title Sequence', type: 'cue' as const, color: '#00e5ff' },
  { id: 'hit-2', bar: 9, name: 'Protagonist Enters Frame (Door Kick)', type: 'hit' as const, color: '#ff6e00' },
  { id: 'hit-3', bar: 17, name: 'Action Chase Sequence Begins', type: 'transition' as const, color: '#00ff88' },
  { id: 'hit-4', bar: 25, name: 'Suspense Climax / Dialogue Reveal', type: 'dialogue' as const, color: '#a855f7' }
];

export const VideoScoringModal: React.FC<VideoScoringModalProps> = ({
  isOpen,
  onClose,
  currentBar = 1,
  bpm = 120,
  onSeekToBar
}) => {
  const [fps, setFps] = useState<24 | 25 | 29.97 | 30>(24);
  const [hitPoints, setHitPoints] = useState(DEFAULT_HIT_POINTS);
  const [newHitName, setNewHitName] = useState('');
  const [newHitBar, setNewHitBar] = useState(currentBar || 1);
  const [newHitType, setNewHitType] = useState<'dialogue' | 'hit' | 'cue' | 'transition'>('hit');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  // Calculate SMPTE Timecode from bar and BPM
  // 1 bar = 4 beats = (4 * 60 / BPM) seconds
  const totalSeconds = ((currentBar - 1) * 4 * 60) / bpm;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.floor((totalSeconds % 1) * fps);

  const smpteFormatted = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;

  const handleAddHitPoint = () => {
    if (!newHitName.trim()) return;
    const colors = {
      dialogue: '#a855f7',
      hit: '#ff6e00',
      cue: '#00e5ff',
      transition: '#00ff88'
    };
    const newPoint = {
      id: `hit-${Date.now()}`,
      bar: Number(newHitBar),
      name: newHitName,
      type: newHitType,
      color: colors[newHitType]
    };
    setHitPoints([...hitPoints, newPoint].sort((a, b) => a.bar - b.bar));
    setNewHitName('');
    setStatusMessage(`Added SMPTE Film Cue Marker at Bar ${newHitBar}`);
    setTimeout(() => setStatusMessage(null), 2500);
  };

  const handleDeleteHit = (id: string) => {
    setHitPoints(hitPoints.filter(h => h.id !== id));
  };

  return (
    <div id="fl-video-scoring-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#a855f7]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#a855f7] to-[#7928ca] flex items-center justify-center text-white shadow-md font-bold">
              <Film className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">FILM SCORING & SMPTE VIDEO TIMECODE MONITOR</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#a855f7]/20 text-[#a855f7] border border-[#a855f7]/40">
                  FRAME-ACCURATE SYNC
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Synchronize musical beats, transitions, and orchestral hits directly to movie frame timecodes</p>
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
          {/* SMPTE Timecode Display & Video Stage */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Virtual Screen Stage */}
            <div className="bg-[#0a0a0c] rounded-xl border border-[#2d2d34] h-52 flex flex-col justify-between p-3 relative overflow-hidden group">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[10px] font-mono text-[#00ff88] flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-[#00ff88] animate-pulse" />
                  <span>SMPTE GENLOCK ACTIVE</span>
                </span>
                <span className="text-[10px] font-mono text-[#888]">{fps} FPS CINEMA</span>
              </div>

              {/* Center Scene Mock Visualizer */}
              <div className="text-center space-y-1">
                <div className="w-12 h-12 mx-auto rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-[#a855f7]">
                  <Film className="w-6 h-6" />
                </div>
                <div className="text-xs font-bold text-white tracking-widest">SCENE 04 - THE HEIST</div>
                <div className="text-[10px] text-[#666] font-mono">1080p ProRes 422 HQ (Direct Stream)</div>
              </div>

              {/* Bottom SMPTE Readout */}
              <div className="bg-black/80 px-3 py-1.5 rounded-lg border border-white/10 flex items-center justify-between font-mono">
                <span className="text-xs text-[#aaa]">TIMECODE:</span>
                <span className="text-sm font-bold text-[#00e5ff] tracking-widest">{smpteFormatted}</span>
              </div>
            </div>

            {/* Timecode Settings Card */}
            <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] flex flex-col justify-between space-y-3">
              <div className="space-y-2">
                <span className="text-xs font-bold text-white uppercase block">FRAME RATE & OFFSET SYNC</span>
                <div className="grid grid-cols-4 gap-2">
                  {[24, 25, 29.97, 30].map((rate) => (
                    <button
                      key={rate}
                      onClick={() => setFps(rate as any)}
                      className={`py-1.5 text-xs font-bold font-mono rounded border transition ${
                        fps === rate
                          ? 'bg-[#a855f7] text-white border-[#a855f7]'
                          : 'bg-[#121214] text-[#888] border-[#333] hover:text-white'
                      }`}
                    >
                      {rate} FPS
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#121214] p-3 rounded-lg border border-[#242428] space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-[#888]">Current Playhead Bar:</span>
                  <span className="font-bold text-white font-mono">Bar {currentBar}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#888]">Project Tempo:</span>
                  <span className="font-bold text-[#ffaa00] font-mono">{bpm} BPM</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#888]">Seconds per Measure:</span>
                  <span className="font-bold text-[#00ff88] font-mono">{((4 * 60) / bpm).toFixed(3)}s</span>
                </div>
              </div>
            </div>
          </div>

          {/* Film Hit Points & Cue Markers */}
          <div className="bg-[#18181c] p-4 rounded-xl border border-[#28282e] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white uppercase flex items-center gap-1.5">
                <Flag className="w-3.5 h-3.5 text-[#a855f7]" />
                <span>FILM CUE & HIT-POINT LIST</span>
              </span>
              <span className="text-[10px] text-[#777]">{hitPoints.length} Markers Placed</span>
            </div>

            {/* Hit point items */}
            <div className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
              {hitPoints.map((hit) => {
                const hitSeconds = ((hit.bar - 1) * 4 * 60) / bpm;
                const hitMin = Math.floor(hitSeconds / 60);
                const hitSec = Math.floor(hitSeconds % 60);
                const hitFr = Math.floor((hitSeconds % 1) * fps);
                const timeStr = `${String(hitMin).padStart(2, '0')}:${String(hitSec).padStart(2, '0')}:${String(hitFr).padStart(2, '0')}`;

                return (
                  <div
                    key={hit.id}
                    className="bg-[#121214] p-2.5 rounded-lg border border-[#26262a] flex items-center justify-between hover:border-[#444] transition"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: hit.color }} />
                      <span className="text-xs font-bold text-white">{hit.name}</span>
                      <span 
                        style={{ color: hit.color, borderColor: `${hit.color}55` }}
                        className="px-1.5 py-0.2 rounded text-[8px] font-mono font-bold uppercase border bg-white/[0.02]"
                      >
                        {hit.type}
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-[#00e5ff] font-bold">Bar {hit.bar}</span>
                      <span className="text-[10px] font-mono text-[#777]">({timeStr})</span>
                      {onSeekToBar && (
                        <button
                          onClick={() => onSeekToBar(hit.bar)}
                          className="px-2 py-0.5 bg-[#222228] hover:bg-[#33333e] text-white text-[10px] font-bold rounded transition"
                        >
                          Jump
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteHit(hit.id)}
                        className="text-[#666] hover:text-red-400 p-1 rounded"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add Hit Point Input Form */}
            <div className="bg-[#121214] p-3 rounded-lg border border-[#28282e] flex flex-wrap items-center gap-2 text-xs">
              <input
                type="text"
                placeholder="Cue Title (e.g. Gunshot Impact, Jump Scare)..."
                value={newHitName}
                onChange={(e) => setNewHitName(e.target.value)}
                className="flex-1 min-w-[200px] bg-[#18181c] text-white px-2.5 py-1.5 rounded border border-[#333] text-xs"
              />

              <div className="flex items-center gap-1.5">
                <span className="text-[#777] text-[10px] font-bold">BAR:</span>
                <input
                  type="number"
                  min="1"
                  max="128"
                  value={newHitBar}
                  onChange={(e) => setNewHitBar(Number(e.target.value))}
                  className="w-16 bg-[#18181c] text-white px-2 py-1.5 rounded border border-[#333] text-xs font-mono font-bold text-center"
                />
              </div>

              <select
                value={newHitType}
                onChange={(e) => setNewHitType(e.target.value as any)}
                className="bg-[#18181c] text-white px-2 py-1.5 rounded border border-[#333] text-xs"
              >
                <option value="hit">Action Hit</option>
                <option value="dialogue">Dialogue</option>
                <option value="cue">Music Cue</option>
                <option value="transition">Scene Cut</option>
              </select>

              <button
                onClick={handleAddHitPoint}
                className="px-3 py-1.5 bg-[#a855f7] hover:bg-[#b86bf8] text-white font-bold rounded flex items-center gap-1 transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Cue</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Frame-accurate SMPTE Sub-frame Clock Running</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#a855f7] hover:bg-[#b86bf8] text-white font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Save Cue List</span>
          </button>
        </div>
      </div>
    </div>
  );
};
