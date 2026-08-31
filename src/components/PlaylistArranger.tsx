import React, { useRef, useState } from 'react';
import { Layers, Plus, ZoomIn, ZoomOut, Flag, Snowflake, X, Copy, Trash2, Scissors } from 'lucide-react';
import type { PlaylistTrack, PlaylistClip, Pattern, Channel, ArrangementMarker } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import {
  DEFAULT_GRID_BARS,
  deletePlaylistClip,
  duplicatePlaylistClip,
  movePlaylistClip,
  resizePlaylistClipLeft,
  resizePlaylistClipRight,
  splitPlaylistClip,
} from './playlistClipOperations';

interface PlaylistArrangerProps {
  tracks: PlaylistTrack[];
  clips: PlaylistClip[];
  patterns: Pattern[];
  channels: Channel[];
  markers?: ArrangementMarker[];
  onUpdateTracks: (tracks: PlaylistTrack[]) => void;
  onUpdateClips: (clips: PlaylistClip[]) => void;
  onUpdateMarkers?: (markers: ArrangementMarker[]) => void;
  onAddTrack: () => void;
  onSeekToBar?: (bar: number) => void;
  currentBar: number;
  isPlaying: boolean;
}

const BAR_WIDTH = 96;
const TRACK_HEIGHT = 64;
const MIN_CLIP_LENGTH = DEFAULT_GRID_BARS;

type Interaction =
  | { kind: 'move'; clip: PlaylistClip; pointerId: number; originX: number; originY: number }
  | { kind: 'resize-left'; clip: PlaylistClip; pointerId: number; originX: number }
  | { kind: 'resize-right'; clip: PlaylistClip; pointerId: number; originX: number };

export const PlaylistArranger: React.FC<PlaylistArrangerProps> = ({
  tracks, clips, patterns, channels, markers = [], onUpdateTracks, onUpdateClips,
  onUpdateMarkers, onAddTrack, onSeekToBar, currentBar, isPlaying,
}) => {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [totalBars, setTotalBars] = useState(32);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const bounds = { totalBars, maxTracks: tracks.length };
  const selectedClip = clips.find((clip) => clip.id === selectedClipId);

  const updateInteraction = (clientX: number, clientY: number) => {
    if (!interaction) return;
    const clip = interaction.clip;
    try {
      if (interaction.kind === 'move') {
        const requestedStart = clip.startBar + (clientX - interaction.originX) / BAR_WIDTH;
        const targetTrack = clip.trackIndex + Math.round((clientY - interaction.originY) / TRACK_HEIGHT);
        const moved = movePlaylistClip(clip, requestedStart, targetTrack, DEFAULT_GRID_BARS, bounds);
        onUpdateClips(clips.map((item) => item.id === clip.id ? moved : item));
      } else if (interaction.kind === 'resize-left') {
        const requestedStart = clip.startBar + (clientX - interaction.originX) / BAR_WIDTH;
        const resized = resizePlaylistClipLeft(clip, requestedStart, DEFAULT_GRID_BARS, MIN_CLIP_LENGTH, bounds);
        onUpdateClips(clips.map((item) => item.id === clip.id ? resized : item));
      } else {
        const requestedEnd = clip.startBar + clip.lengthBars + (clientX - interaction.originX) / BAR_WIDTH;
        const resized = resizePlaylistClipRight(clip, requestedEnd, DEFAULT_GRID_BARS, MIN_CLIP_LENGTH, bounds);
        onUpdateClips(clips.map((item) => item.id === clip.id ? resized : item));
      }
    } catch (error) {
      console.warn('Playlist interaction rejected by operation layer', error);
    }
  };

  const beginInteraction = (event: React.PointerEvent, next: Interaction) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedClipId(next.clip.id);
    setInteraction(next);
  };

  const deleteClip = (clipId: string) => {
    onUpdateClips(deletePlaylistClip(clips, clipId));
    if (selectedClipId === clipId) setSelectedClipId(null);
  };

  const duplicateClip = (clip: PlaylistClip) => {
    try {
      const duplicate = duplicatePlaylistClip(clip, `${clip.id}-copy-${Date.now()}`, clip.startBar + clip.lengthBars, clip.trackIndex, DEFAULT_GRID_BARS, bounds);
      onUpdateClips([...clips, duplicate]);
      setSelectedClipId(duplicate.id);
    } catch {
      setStatusMessage('Duplicate cannot fit within the playlist bounds.');
      setTimeout(() => setStatusMessage(null), 2000);
    }
  };

  const splitClip = (clip: PlaylistClip) => {
    try {
      const [left, right] = splitPlaylistClip(clip, clip.startBar + clip.lengthBars / 2, DEFAULT_GRID_BARS, bounds);
      onUpdateClips([...deletePlaylistClip(clips, clip.id), left, right]);
      setSelectedClipId(left.id);
    } catch {
      setStatusMessage('Clip cannot be split at its midpoint.');
      setTimeout(() => setStatusMessage(null), 2000);
    }
  };

  const handleGridClick = (trackIndex: number, barIndex: number) => {
    const existing = clips.find((clip) => clip.trackIndex === trackIndex && barIndex >= clip.startBar && barIndex < clip.startBar + clip.lengthBars);
    if (existing) { setSelectedClipId(existing.id); return; }
    const channel = channels[0];
    const clip: PlaylistClip = {
      id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      trackIndex, startBar: barIndex, lengthBars: Math.min(4, totalBars - barIndex), type: 'pattern',
      channelId: channel?.id, color: '#ff6e00', name: `${tracks[trackIndex]?.name || 'Track'} Block`,
    };
    onUpdateClips([...clips, clip]);
    setSelectedClipId(clip.id);
  };

  const handleMarkerAdd = () => {
    if (!onUpdateMarkers) return;
    const marker: ArrangementMarker = { id: `marker-${Date.now()}`, name: `Section ${markers.length + 1}`, bar: currentBar, color: '#ffaa00' };
    onUpdateMarkers([...markers.filter((item) => item.bar !== currentBar), marker].sort((a, b) => a.bar - b.bar));
  };

  const handleBounceTrack = async (trackIndex: number) => {
    const channel = channels[trackIndex] || channels[0];
    if (!channel) return;
    try {
      setStatusMessage(`Bouncing ${channel.name}...`);
      const { buffer, waveform } = await audioEngine.bounceChannelToAudioClip(channel, 130, 4);
      const bufferId = `bounced-${Date.now()}`;
      audioEngine.setSampleBuffer(bufferId, buffer);
      const clip: PlaylistClip = {
        id: `audio-bounced-${Date.now()}`, trackIndex, startBar: 0, lengthBars: 4, type: 'audio',
        audioBufferId: bufferId, audioName: `${channel.name} (Bounced Stem)`, audioWaveform: waveform,
        fadeInBars: 0.1, fadeOutBars: 0.2, color: '#00ff88', name: `${channel.name} [Stem]`,
      };
      onUpdateClips([...clips, clip]);
      setStatusMessage(`Bounced ${channel.name}.`);
    } catch { setStatusMessage('Bounce failed.'); }
    setTimeout(() => setStatusMessage(null), 2500);
  };

  return (
    <div id="fl-playlist-arranger" className="flex flex-col h-full bg-[#121214] select-none text-[#b0b0b0]">
      {statusMessage && <div className="bg-[#ff6e00] text-black text-xs font-bold px-3 py-1">{statusMessage}</div>}
      <div className="h-10 bg-[#1e1e20] border-b border-[#333336] flex items-center justify-between px-3 shrink-0">
        <div className="flex items-center gap-3"><div className="flex items-center gap-1.5 text-white font-bold text-xs uppercase"><Layers className="w-3.5 h-3.5 text-[#ff6e00]" /> PLAYLIST SONG ARRANGER</div><span className="text-[9px] text-[#777] font-mono">GRID 1/4 BAR</span></div>
        <div className="flex items-center gap-2">
          {onUpdateMarkers && <button onClick={handleMarkerAdd} className="p-1.5 text-[#ffaa00] hover:bg-[#28282d] rounded" title="Add section marker"><Flag className="w-3.5 h-3.5" /></button>}
          <div className="flex items-center gap-1 bg-[#121214] border border-[#333336] p-0.5 rounded"><button onClick={() => setTotalBars((v) => Math.max(8, v - 8))} className="p-1 text-[#777] hover:text-white"><ZoomIn className="w-3 h-3" /></button><span className="text-[9px] text-[#ff6e00] font-mono px-1">{totalBars} Bars</span><button onClick={() => setTotalBars((v) => Math.min(64, v + 8))} className="p-1 text-[#777] hover:text-white"><ZoomOut className="w-3 h-3" /></button></div>
          <button id="add-playlist-track-btn" onClick={onAddTrack} className="flex items-center gap-1 px-2.5 py-1 bg-[#ff6e00] text-black font-bold text-[11px] rounded"><Plus className="w-3.5 h-3.5" /> Add Track Row</button>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="w-36 sm:w-44 bg-[#141416] border-r border-[#333336] flex flex-col shrink-0">
          <div className="h-12 bg-[#1a1a1d] border-b border-[#333336] px-3 flex items-center justify-between text-[9px] font-bold text-[#777] uppercase"><span>TRACK LANES</span><span>BOUNCE</span></div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">{tracks.map((track, idx) => <div key={track.id} className="h-16 border-b border-[#222225] px-2 flex items-center justify-between group"><div className="flex items-center gap-1.5 min-w-0"><button onClick={() => onUpdateTracks(tracks.map((item) => item.id === track.id ? {...item, mute: !item.mute} : item))} className={`w-2.5 h-2.5 rounded-full border ${track.mute ? 'bg-[#333] border-[#444]' : 'bg-[#00ff88] border-[#00ff88]'}`} /><div className="min-w-0"><span className="text-xs font-bold text-white truncate block">{track.name}</span><span className="text-[8px] text-[#777] font-mono">TRACK {idx + 1}</span></div></div><button onClick={() => handleBounceTrack(idx)} className="opacity-0 group-hover:opacity-100 p-1 bg-[#222] text-[#888] rounded" title="Bounce channel"><Snowflake className="w-3 h-3" /></button></div>)}</div>
        </div>
        <div ref={timelineRef} className="flex-1 overflow-auto custom-scrollbar bg-[#0a0a0b]" onPointerMove={(event) => { if (interaction && event.pointerId === interaction.pointerId) updateInteraction(event.clientX, event.clientY); }} onPointerUp={(event) => { if (interaction && event.pointerId === interaction.pointerId) setInteraction(null); }} onPointerCancel={() => setInteraction(null)}>
          <div className="min-w-[768px]">
            <div className="h-7 flex bg-[#1a1a1d] border-b border-[#333336] sticky top-0 z-20">{Array.from({length: totalBars}).map((_, i) => <button key={i} onClick={() => onSeekToBar?.(i + 1)} className={`w-24 h-full border-r border-[#333336] px-2 text-left text-[9px] font-mono ${isPlaying && currentBar === i + 1 ? 'text-[#ff6e00] bg-[#ff6e00]/10' : 'text-[#777]'}`}>BAR {i + 1}</button>)}</div>
            <div className="relative">{tracks.map((track, trackIdx) => <div key={track.id} className="h-16 border-b border-[#1c1c20] relative bg-[#0e0e10]">
              {Array.from({length: totalBars}).map((_, barIdx) => <button key={barIdx} onClick={() => handleGridClick(trackIdx, barIdx)} className="absolute top-0 h-full w-24 border-r border-[#1c1c20] hover:bg-white/5" style={{left: `${barIdx * BAR_WIDTH}px`}} />)}
              {clips.filter((clip) => clip.trackIndex === trackIdx).map((clip) => { const selected = clip.id === selectedClipId; const isAudio = clip.type === 'audio'; const isAutomation = clip.type === 'automation'; return <div key={clip.id} onPointerDown={(event) => { if (event.button !== 0) return; beginInteraction(event, {kind: 'move', clip: {...clip, automationPoints: clip.automationPoints?.map((point) => ({...point})), spatialAudio: clip.spatialAudio ? {...clip.spatialAudio} : undefined}, pointerId: event.pointerId, originX: event.clientX, originY: event.clientY}); }} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); }} className={`absolute top-1 bottom-1 rounded-sm border shadow overflow-hidden group ${isAudio ? 'bg-[#002b1a]/90 border-[#00ff88]' : isAutomation ? 'bg-[#002233]/90 border-[#00e5ff]' : 'bg-[#1a1a1d] border-[#ff6e00]'} ${selected ? 'ring-2 ring-white/70' : ''}`} style={{left: `${clip.startBar * BAR_WIDTH}px`, width: `${Math.max(12, clip.lengthBars * BAR_WIDTH - 4)}px`}}>
                <div className="h-full px-2 py-1 relative"><div className="flex justify-between text-[10px] font-bold text-white truncate pr-4"><span className="truncate">{clip.name}</span><span className="text-[8px] opacity-70">{clip.lengthBars}B</span></div><div className="absolute inset-x-2 bottom-2 h-4 flex items-end gap-0.5 opacity-60">{Array.from({length: 24}).map((_, i) => <span key={i} className={`flex-1 rounded-sm ${isAudio ? 'bg-[#00ff88]' : isAutomation ? 'bg-[#00e5ff]' : 'bg-[#ff6e00]'}`} style={{height: `${20 + ((i * 37) % 70)}%`}} />)}</div>
                  <div role="separator" aria-label="Resize clip start" onPointerDown={(event) => beginInteraction(event, {kind: 'resize-left', clip: {...clip, automationPoints: clip.automationPoints?.map((point) => ({...point})), spatialAudio: clip.spatialAudio ? {...clip.spatialAudio} : undefined}, pointerId: event.pointerId, originX: event.clientX})} className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/10 opacity-0 group-hover:opacity-100 hover:bg-white/30 z-20" />
                  <div role="separator" aria-label="Resize clip end" onPointerDown={(event) => beginInteraction(event, {kind: 'resize-right', clip: {...clip, automationPoints: clip.automationPoints?.map((point) => ({...point})), spatialAudio: clip.spatialAudio ? {...clip.spatialAudio} : undefined}, pointerId: event.pointerId, originX: event.clientX})} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/10 opacity-0 group-hover:opacity-100 hover:bg-white/30 z-20" />
                </div>
              </div>; })}
              {markers.filter((marker) => marker.bar >= 1 && marker.bar <= totalBars).map((marker) => <div key={marker.id} className="absolute top-0 bottom-0 border-l-2 pointer-events-none" style={{left: `${(marker.bar - 1) * BAR_WIDTH}px`, borderColor: marker.color}} />)}
            </div>)}</div>
          </div>
        </div>
      </div>
      {selectedClip && <div className="bg-[#18181c] border-t border-[#333338] p-2.5 px-4 flex flex-wrap items-center justify-between gap-3 text-xs"><div><span className="font-bold text-white">{selectedClip.name}</span><span className="text-[10px] text-[#777] ml-2 font-mono">{selectedClip.lengthBars} Bars · Track {selectedClip.trackIndex + 1}</span></div><div className="flex items-center gap-2"><button onClick={() => splitClip(selectedClip)} className="px-2 py-1 bg-[#282830] text-white rounded font-bold"><Scissors className="w-3 h-3 inline mr-1" />Split</button><button onClick={() => duplicateClip(selectedClip)} className="px-2 py-1 bg-[#282830] text-white rounded font-bold"><Copy className="w-3 h-3 inline mr-1" />Duplicate</button><button onClick={() => deleteClip(selectedClip.id)} className="px-2 py-1 bg-red-500/20 text-red-400 rounded font-bold"><Trash2 className="w-3 h-3 inline mr-1" />Delete</button><button onClick={() => setSelectedClipId(null)} className="text-[#888] hover:text-white"><X className="w-4 h-4" /></button></div></div>}
    </div>
  );
};
