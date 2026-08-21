import React, { useState } from 'react';
import { 
  Plus, 
  Layers, 
  Trash2, 
  Copy, 
  Volume2, 
  Mic, 
  Music, 
  Split, 
  ZoomIn, 
  ZoomOut,
  Sliders,
  Scissors,
  Activity,
  Sparkles,
  TrendingUp,
  X,
  Edit2
} from 'lucide-react';
import { PlaylistTrack, PlaylistClip, Pattern, Channel, AutomationTargetType } from '../types/daw';

interface PlaylistArrangerProps {
  tracks: PlaylistTrack[];
  clips: PlaylistClip[];
  patterns: Pattern[];
  channels: Channel[];
  onUpdateTracks: (tracks: PlaylistTrack[]) => void;
  onUpdateClips: (clips: PlaylistClip[]) => void;
  onAddTrack: () => void;
  currentBar: number;
  isPlaying: boolean;
}

export const PlaylistArranger: React.FC<PlaylistArrangerProps> = ({
  tracks,
  clips,
  patterns,
  channels,
  onUpdateTracks,
  onUpdateClips,
  onAddTrack,
  currentBar,
  isPlaying
}) => {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [totalBars, setTotalBars] = useState(16);
  const [activeTool, setActiveTool] = useState<'place' | 'cut' | 'delete'>('place');
  const [clipTypeToAdd, setClipTypeToAdd] = useState<'pattern' | 'audio' | 'automation'>('pattern');
  const [automationEditorClipId, setAutomationEditorClipId] = useState<string | null>(null);

  const handleTrackMute = (trackId: number) => {
    const updated = tracks.map(t => t.id === trackId ? { ...t, mute: !t.mute } : t);
    onUpdateTracks(updated);
  };

  const handleGridCellClick = (trackIndex: number, barIndex: number) => {
    const existingClip = clips.find(c => c.trackIndex === trackIndex && barIndex >= c.startBar && barIndex < c.startBar + c.lengthBars);

    if (activeTool === 'delete') {
      if (existingClip) {
        onUpdateClips(clips.filter(c => c.id !== existingClip.id));
      }
      return;
    }

    if (activeTool === 'cut' && existingClip) {
      // Split clip at clicked bar
      const splitOffset = barIndex - existingClip.startBar;
      if (splitOffset > 0 && splitOffset < existingClip.lengthBars) {
        const leftClip: PlaylistClip = {
          ...existingClip,
          id: `clip-split-1-${Date.now()}`,
          lengthBars: splitOffset
        };
        const rightClip: PlaylistClip = {
          ...existingClip,
          id: `clip-split-2-${Date.now()}`,
          startBar: barIndex,
          lengthBars: existingClip.lengthBars - splitOffset
        };
        onUpdateClips(clips.map(c => c.id === existingClip.id ? leftClip : c).concat(rightClip));
      }
      return;
    }

    if (existingClip) {
      setSelectedClipId(existingClip.id);
      if (existingClip.type === 'automation') {
        setAutomationEditorClipId(existingClip.id);
      }
      return;
    }

    // Place new clip according to selected clip type
    const activeChannel = channels[0];
    let newClip: PlaylistClip;

    if (clipTypeToAdd === 'automation') {
      newClip = {
        id: `auto-clip-${Date.now()}`,
        trackIndex,
        startBar: barIndex,
        lengthBars: 4,
        type: 'automation',
        color: '#00e5ff',
        name: 'Auto: Cutoff Filter',
        automationTarget: {
          type: 'channel_filter_cutoff',
          targetId: activeChannel?.id || '',
          label: `${activeChannel?.name || 'Channel'} Filter Cutoff`
        },
        automationPoints: [
          { x: 0, y: 0.2, tension: 0.3 },
          { x: 0.5, y: 0.85, tension: -0.2 },
          { x: 1, y: 0.3, tension: 0 }
        ]
      };
      setAutomationEditorClipId(newClip.id);
    } else if (clipTypeToAdd === 'audio') {
      newClip = {
        id: `audio-clip-${Date.now()}`,
        trackIndex,
        startBar: barIndex,
        lengthBars: 4,
        type: 'audio',
        color: '#00ff88',
        name: 'Audio Stem / Vocal',
        audioWaveform: [0.1, 0.4, 0.8, 0.6, 0.9, 0.7, 0.4, 0.2, 0.8, 0.9, 0.5, 0.3, 0.1, 0.6, 0.8, 0.2]
      };
    } else {
      // Pattern
      newClip = {
        id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        trackIndex,
        startBar: barIndex,
        lengthBars: 4,
        type: 'pattern',
        channelId: activeChannel?.id,
        color: '#ff6e00',
        name: `${tracks[trackIndex]?.name || 'Track'} Block`
      };
    }

    onUpdateClips([...clips, newClip]);
  };

  const handleUpdateAutomationPoint = (clipId: string, pointIndex: number, newY: number) => {
    const updated = clips.map(c => {
      if (c.id === clipId && c.automationPoints) {
        const newPts = [...c.automationPoints];
        newPts[pointIndex] = { ...newPts[pointIndex], y: Math.max(0, Math.min(1, newY)) };
        return { ...c, automationPoints: newPts };
      }
      return c;
    });
    onUpdateClips(updated);
  };

  const handleAddAutomationPoint = (clipId: string, normX: number, normY: number) => {
    const updated = clips.map(c => {
      if (c.id === clipId && c.automationPoints) {
        const newPts = [...c.automationPoints, { x: normX, y: normY, tension: 0 }].sort((a, b) => a.x - b.x);
        return { ...c, automationPoints: newPts };
      }
      return c;
    });
    onUpdateClips(updated);
  };

  const activeAutomationClip = clips.find(c => c.id === automationEditorClipId);

  return (
    <div id="fl-playlist-arranger" className="flex flex-col h-full bg-[#121214] select-none text-[#b0b0b0]">
      {/* Playlist Top Toolbar */}
      <div className="h-10 bg-[#1e1e20] border-b border-[#333336] flex items-center justify-between px-3 shrink-0 gap-3">
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-1.5 text-white font-bold text-xs uppercase tracking-wider">
            <Layers className="w-3.5 h-3.5 text-[#ff6e00]" />
            <span className="hidden sm:inline">PLAYLIST SONG ARRANGER</span>
          </div>

          {/* Clip Type Picker */}
          <div className="flex items-center gap-0.5 bg-[#121214] border border-[#333336] p-0.5 rounded text-xs">
            <button
              onClick={() => setClipTypeToAdd('pattern')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                clipTypeToAdd === 'pattern' ? 'bg-[#ff6e00] text-black shadow' : 'text-[#777] hover:text-white'
              }`}
            >
              Pattern
            </button>
            <button
              onClick={() => setClipTypeToAdd('audio')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                clipTypeToAdd === 'audio' ? 'bg-[#00ff88] text-black shadow' : 'text-[#777] hover:text-white'
              }`}
            >
              Audio
            </button>
            <button
              onClick={() => setClipTypeToAdd('automation')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                clipTypeToAdd === 'automation' ? 'bg-[#00e5ff] text-black shadow' : 'text-[#777] hover:text-white'
              }`}
            >
              Automation
            </button>
          </div>

          {/* Tools */}
          <div className="flex items-center gap-0.5 bg-[#121214] border border-[#333336] p-0.5 rounded text-xs">
            <button
              onClick={() => setActiveTool('place')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                activeTool === 'place' ? 'bg-[#ff6e00] text-black shadow' : 'text-[#777] hover:text-white'
              }`}
            >
              Draw
            </button>
            <button
              onClick={() => setActiveTool('cut')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                activeTool === 'cut' ? 'bg-[#00e5ff] text-black shadow' : 'text-[#777] hover:text-white'
              }`}
            >
              Slice
            </button>
            <button
              onClick={() => setActiveTool('delete')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                activeTool === 'delete' ? 'bg-[#ff0000] text-white shadow' : 'text-[#777] hover:text-white'
              }`}
            >
              Erase
            </button>
          </div>
        </div>

        {/* Zoom & Add Track */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-[#121214] border border-[#333336] p-0.5 rounded">
            <button
              onClick={() => setTotalBars(prev => Math.max(8, prev - 4))}
              className="p-1 text-[#777] hover:text-white"
              title="Zoom In"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <span className="text-[9px] text-[#ff6e00] font-mono px-1">{totalBars} Bars</span>
            <button
              onClick={() => setTotalBars(prev => Math.min(64, prev + 4))}
              className="p-1 text-[#777] hover:text-white"
              title="Zoom Out"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
          </div>

          <button
            id="add-playlist-track-btn"
            onClick={onAddTrack}
            className="flex items-center gap-1 px-2.5 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-[11px] rounded transition active:scale-95 shadow"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Add Track Row</span>
          </button>
        </div>
      </div>

      {/* Main Playlist Matrix */}
      <div className="flex-1 flex overflow-hidden">
        {/* Track Headers List on Left */}
        <div className="w-36 sm:w-44 bg-[#141416] border-r border-[#333336] flex flex-col shrink-0">
          <div className="h-7 bg-[#1a1a1d] border-b border-[#333336] px-3 flex items-center text-[9px] font-bold text-[#777] uppercase tracking-wider">
            TRACK LANES
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {tracks.map((track, idx) => (
              <div
                key={track.id}
                className="h-16 border-b border-[#222225] px-2.5 flex items-center justify-between bg-[#141416] hover:bg-[#1a1a1d] transition"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => handleTrackMute(track.id)}
                    className={`w-2.5 h-2.5 rounded-full border transition ${
                      !track.mute 
                        ? 'bg-[#00ff88] border-[#00ff88]' 
                        : 'bg-[#333336] border-[#444]'
                    }`}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-bold text-white truncate">{track.name}</span>
                    <span className="text-[8px] text-[#777] font-mono">TRACK {idx + 1}</span>
                  </div>
                </div>

                <div className="w-1.5 h-8 rounded-xs bg-[#ff6e00]" />
              </div>
            ))}
          </div>
        </div>

        {/* Timeline Clips Area */}
        <div className="flex-1 flex flex-col overflow-auto custom-scrollbar bg-[#0a0a0b]">
          {/* Bars Header Ruler */}
          <div className="flex h-7 bg-[#1a1a1d] border-b border-[#333336] sticky top-0 z-10 min-w-[768px]">
            {Array.from({ length: totalBars }).map((_, barIdx) => {
              const isPlayHead = isPlaying && currentBar === barIdx + 1;
              return (
                <div
                  key={barIdx}
                  className={`w-24 sm:w-28 h-full border-r border-[#333336] flex items-center justify-between px-2 text-[9px] font-mono ${
                    isPlayHead ? 'bg-[#ff6e00]/20 text-[#ff6e00] font-bold' : 'text-[#777]'
                  }`}
                >
                  <span>BAR {barIdx + 1}</span>
                  <span className="text-[7px] text-[#555]">| : : :</span>
                </div>
              );
            })}
          </div>

          {/* Track Lane Rows */}
          <div className="min-w-[768px]">
            {tracks.map((track, trackIdx) => (
              <div
                key={track.id}
                className="h-16 border-b border-[#1c1c20] flex relative bg-[#0e0e10]"
              >
                {/* 1 Bar grid slots */}
                {Array.from({ length: totalBars }).map((_, barIdx) => {
                  const isPlayheadBar = isPlaying && currentBar === barIdx + 1;
                  return (
                    <div
                      key={barIdx}
                      onClick={() => handleGridCellClick(trackIdx, barIdx)}
                      className={`w-24 sm:w-28 h-full border-r border-[#1c1c20] cursor-pointer transition ${
                        isPlayheadBar ? 'bg-white/5' : 'hover:bg-white/10'
                      }`}
                    />
                  );
                })}

                {/* Clips in this track row */}
                {clips.filter(c => c.trackIndex === trackIdx).map((clip) => {
                  const isAuto = clip.type === 'automation';
                  const isAudio = clip.type === 'audio';

                  return (
                    <div
                      key={clip.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (activeTool === 'delete') {
                          onUpdateClips(clips.filter(item => item.id !== clip.id));
                        } else if (isAuto) {
                          setAutomationEditorClipId(clip.id);
                        } else {
                          setSelectedClipId(clip.id);
                        }
                      }}
                      style={{
                        left: `${clip.startBar * 96}px`,
                        width: `${clip.lengthBars * 96 - 4}px`
                      }}
                      className={`absolute top-1 bottom-1 border rounded-sm p-1.5 flex flex-col justify-between overflow-hidden shadow cursor-pointer transition ${
                        isAuto 
                          ? 'bg-[#002233]/90 border-[#00e5ff] hover:bg-[#00334d]' 
                          : isAudio 
                            ? 'bg-[#002b1a]/90 border-[#00ff88] hover:bg-[#003d24]' 
                            : 'bg-[#1a1a1d] border-l-4 border-l-[#ff6e00] border-[#333336] hover:border-[#ff6e00]'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold text-[10px] truncate">
                        <span className={`truncate ${isAuto ? 'text-[#00e5ff]' : isAudio ? 'text-[#00ff88]' : 'text-white'}`}>
                          {clip.name}
                        </span>
                        <span className="text-[8px] opacity-70 font-mono">{clip.lengthBars}B</span>
                      </div>

                      {/* Content Preview */}
                      {isAuto && clip.automationPoints ? (
                        <div className="relative h-6 w-full flex items-center">
                          <svg className="w-full h-full overflow-visible">
                            <polyline
                              fill="none"
                              stroke="#00e5ff"
                              strokeWidth="2"
                              points={clip.automationPoints.map(p => `${p.x * (clip.lengthBars * 96 - 12)},${(1 - p.y) * 20}`).join(' ')}
                            />
                            {clip.automationPoints.map((p, pIdx) => (
                              <circle
                                key={pIdx}
                                cx={p.x * (clip.lengthBars * 96 - 12)}
                                cy={(1 - p.y) * 20}
                                r="3"
                                fill="#ffffff"
                              />
                            ))}
                          </svg>
                        </div>
                      ) : isAudio ? (
                        <div className="flex items-center gap-0.5 h-4 opacity-70">
                          {Array.from({ length: 32 }).map((_, i) => (
                            <div 
                              key={i} 
                              className="flex-1 bg-[#00ff88] rounded-xs"
                              style={{ height: `${20 + Math.sin(i * 0.5) * 40 + (i % 3) * 15}%` }}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5 h-3 opacity-60">
                          {Array.from({ length: 16 }).map((_, i) => (
                            <div 
                              key={i} 
                              className="flex-1 bg-[#ff6e00] rounded-xs"
                              style={{ height: `${20 + (i % 5) * 15}%` }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Automation Node Quick Drawer */}
      {activeAutomationClip && (
        <div className="bg-[#18181c] border-t border-[#00e5ff]/40 p-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-[#00e5ff] flex items-center justify-center text-black font-bold">
              <TrendingUp className="w-3.5 h-3.5" />
            </div>
            <div>
              <span className="font-bold text-white">AUTOMATION ENVELOPE: {activeAutomationClip.name}</span>
              <p className="text-[10px] text-[#888]">Adjust curve points or change target parameter binding</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[#888]">Binding:</span>
            <select
              value={activeAutomationClip.automationTarget?.type || 'channel_filter_cutoff'}
              onChange={(e) => {
                const updated = clips.map(c => {
                  if (c.id === activeAutomationClip.id) {
                    return {
                      ...c,
                      name: `Auto: ${e.target.value}`,
                      automationTarget: {
                        type: e.target.value as AutomationTargetType,
                        targetId: channels[0]?.id || '',
                        label: e.target.value
                      }
                    };
                  }
                  return c;
                });
                onUpdateClips(updated);
              }}
              className="bg-[#0c0c0e] border border-[#333] text-white text-xs rounded p-1 font-bold"
            >
              <option value="channel_filter_cutoff">Channel Filter Cutoff (Hz)</option>
              <option value="channel_vol">Channel Volume (0 - 100%)</option>
              <option value="channel_pan">Channel Panning (L/R)</option>
              <option value="master_vol">Master Out Volume</option>
              <option value="mixer_vol">Mixer Insert Volume</option>
            </select>

            <button
              onClick={() => handleAddAutomationPoint(activeAutomationClip.id, 0.75, 0.5)}
              className="px-2.5 py-1 bg-[#282830] hover:bg-[#333] text-white rounded font-bold"
            >
              + Add Node
            </button>

            <button
              onClick={() => setAutomationEditorClipId(null)}
              className="p-1 text-[#888] hover:text-white rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
