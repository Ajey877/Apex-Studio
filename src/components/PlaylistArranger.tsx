import React, { useState, useRef, useEffect } from 'react';
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
  Edit2,
  Flag,
  Bookmark,
  Snowflake,
  AudioWaveform,
  AlertTriangle
} from 'lucide-react';
import { PlaylistTrack, PlaylistClip, Pattern, Channel, AutomationTargetType, ArrangementMarker, MixerTrack } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import {
  MISSING_AUDIO_CLIP_BADGE_LABEL,
  describeMissingAudioClip,
  isPlaylistClipAudioUnavailable
} from '../state/audioAssetAvailability';
import {
  DEFAULT_GRID_BARS,
  createPlaylistPatternClip,
  deletePlaylistClip,
  duplicatePlaylistClip,
  movePlaylistClip,
  resizePlaylistClipLeft,
  resizePlaylistClipRight,
  resolvePlaylistKeyboardShortcut,
  resolvePlaylistTargetChannel,
  resolveClipClickBar,
  splitPlaylistClip,
  addPlaylistAutomationPoint,
  movePlaylistAutomationPoint,
  deletePlaylistAutomationPoint,
  updatePlaylistAutomationTarget,
  nextSelectedPointIndex,
  findAutomationPointIndexNearX,
  resolveAddNodePosition,
} from './playlistClipOperations';

interface PlaylistArrangerProps {
  tracks: PlaylistTrack[];
  clips: PlaylistClip[];
  patterns: Pattern[];
  channels: Channel[];
  mixerTracks?: MixerTrack[];
  markers?: ArrangementMarker[];
  onUpdateTracks: (tracks: PlaylistTrack[]) => void;
  onUpdateClips: (clips: PlaylistClip[]) => void;
  onUpdateMarkers?: (markers: ArrangementMarker[]) => void;
  onPlaylistInteractionStart?: (kind: Interaction['kind']) => void;
  onPlaylistInteractionEnd?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
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
  | { kind: 'resize-right'; clip: PlaylistClip; pointerId: number; originX: number }
  | {
      kind: 'automation-point';
      clip: PlaylistClip;
      pointerId: number;
      pointIndex: number;
      originX: number;
      originY: number;
      automationLeft: number;
      automationTop: number;
      clipLengthBars: number;
    };

const MARKER_PRESETS: { name: string; markers: { name: string; bar: number; color: string }[] }[] = [
  {
    name: 'EDM / Dance Structure',
    markers: [
      { name: 'Intro', bar: 1, color: '#00e5ff' },
      { name: 'Build Up', bar: 9, color: '#ffaa00' },
      { name: 'FESTIVAL DROP', bar: 17, color: '#ff0055' },
      { name: 'Breakdown', bar: 25, color: '#a855f7' },
      { name: 'Outro', bar: 33, color: '#00ff88' }
    ]
  },
  {
    name: 'Pop / Radio Hit (3 Min)',
    markers: [
      { name: 'Intro', bar: 1, color: '#00e5ff' },
      { name: 'Verse 1', bar: 5, color: '#3b82f6' },
      { name: 'Pre-Chorus', bar: 13, color: '#ffaa00' },
      { name: 'CHORUS 1', bar: 17, color: '#ff0055' },
      { name: 'Verse 2', bar: 25, color: '#3b82f6' },
      { name: 'CHORUS 2', bar: 33, color: '#ff0055' },
      { name: 'Bridge', bar: 41, color: '#a855f7' },
      { name: 'Outro', bar: 49, color: '#00ff88' }
    ]
  },
  {
    name: 'Hip-Hop / Trap Beat',
    markers: [
      { name: 'Intro', bar: 1, color: '#00e5ff' },
      { name: 'Hook / Chorus', bar: 5, color: '#ff0055' },
      { name: 'Verse (16 Bars)', bar: 13, color: '#3b82f6' },
      { name: 'Hook 2', bar: 29, color: '#ff0055' },
      { name: 'Outro', bar: 37, color: '#00ff88' }
    ]
  }
];

export const PlaylistArranger: React.FC<PlaylistArrangerProps> = ({
  tracks,
  clips,
  patterns,
  channels,
  mixerTracks = [],
  markers = [],
  onUpdateTracks,
  onUpdateClips,
  onUpdateMarkers,
  onPlaylistInteractionStart,
  onPlaylistInteractionEnd,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onAddTrack,
  onSeekToBar,
  currentBar,
  isPlaying
}) => {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [totalBars, setTotalBars] = useState(32);
  const [activeTool, setActiveTool] = useState<'place' | 'cut' | 'delete'>('place');
  const [clipTypeToAdd, setClipTypeToAdd] = useState<'pattern' | 'audio' | 'automation'>('pattern');
  const [automationEditorClipId, setAutomationEditorClipId] = useState<string | null>(null);
  const [isMarkerMenuOpen, setIsMarkerMenuOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  // Always-current ref so updateInteraction never closes over a stale clips array.
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const didMoveRef = useRef(false);
  const lastScrubBarRef = useRef<number>(1);
  const rulerContainerRef = useRef<HTMLDivElement | null>(null);

  const bounds = { totalBars, maxTracks: tracks.length };

  const NEAR_POINT_TOLERANCE_PX = 8;

  /**
   * Single funnel for clip selection. A selected automation point is only
   * meaningful while its clip stays selected, so the index is resolved through
   * nextSelectedPointIndex: switching to another clip, selecting a fresh clip,
   * or clearing the selection can never leave a stale point index behind that
   * a later Delete could act on.
   */
  const selectClip = (clipId: string | null, opts?: { openAutomationEditor?: boolean }) => {
    setSelectedClipId(clipId);
    setSelectedPointIndex(prev => nextSelectedPointIndex(selectedClipId, prev, clipId));
    if (opts?.openAutomationEditor && clipId !== null) {
      setAutomationEditorClipId(clipId);
    }
  };

  const handleRulerScrub = (clientX: number) => {
    if (!rulerContainerRef.current || !onSeekToBar) return;
    const rect = rulerContainerRef.current.getBoundingClientRect();
    const relativeX = Math.max(0, clientX - rect.left);
    const barWidth = 96; // Standard bar slot width
    const targetBar = Math.min(totalBars, Math.max(1, Math.floor(relativeX / barWidth) + 1));

    if (targetBar !== lastScrubBarRef.current) {
      lastScrubBarRef.current = targetBar;
      onSeekToBar(targetBar);
      audioEngine.playTimelineScrubSound(targetBar, 1.25);
    }
  };

  const handleTrackMute = (trackId: number) => {
    const updated = tracks.map(t => t.id === trackId ? { ...t, mute: !t.mute } : t);
    onUpdateTracks(updated);
  };

  const handleBounceTrack = async (trackIdx: number) => {
    const channel = channels[trackIdx] || channels[0];
    if (!channel) return;

    setStatusMessage(`Bouncing ${channel.name} into offline Audio Stem...`);
    try {
      const { buffer, waveform } = await audioEngine.bounceChannelToAudioClip(channel, 130, 4);
      const bufId = `bounced-clip-${Date.now()}`;
      audioEngine.setSampleBuffer(bufId, buffer);

      const newAudioClip: PlaylistClip = {
        id: `audio-bounced-${Date.now()}`,
        trackIndex: trackIdx,
        startBar: 0,
        lengthBars: 4,
        type: 'audio',
        audioBufferId: bufId,
        audioName: `${channel.name} (Bounced Stem)`,
        audioWaveform: waveform,
        fadeInBars: 0.1,
        fadeOutBars: 0.2,
        color: '#00ff88',
        name: `${channel.name} [Stem]`
      };

      onUpdateClips([...clips, newAudioClip]);
      setStatusMessage(`Successfully bounced ${channel.name} to 32-bit audio stem in Playlist!`);
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (e: any) {
      console.error(e);
      setStatusMessage('Bounce failed.');
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleAddMarker = (name: string, bar: number, color: string) => {
    if (!onUpdateMarkers) return;
    const newMarker: ArrangementMarker = {
      id: `marker-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name,
      bar,
      color
    };
    const updated = [...markers.filter(m => m.bar !== bar), newMarker].sort((a, b) => a.bar - b.bar);
    onUpdateMarkers(updated);
    setIsMarkerMenuOpen(false);
    setStatusMessage(`Added section marker: ${name} at Bar ${bar}`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleApplyMarkerPreset = (preset: typeof MARKER_PRESETS[0]) => {
    if (!onUpdateMarkers) return;
    const mapped: ArrangementMarker[] = preset.markers.map((m, idx) => ({
      id: `m-preset-${Date.now()}-${idx}`,
      name: m.name,
      bar: m.bar,
      color: m.color
    }));
    onUpdateMarkers(mapped);
    setIsMarkerMenuOpen(false);
    setStatusMessage(`Applied ${preset.name}!`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleDeleteMarker = (id: string) => {
    if (!onUpdateMarkers) return;
    onUpdateMarkers(markers.filter(m => m.id !== id));
  };

  const handleAdjustClipFade = (clipId: string, type: 'in' | 'out', delta: number) => {
    const updated = clips.map(c => {
      if (c.id === clipId) {
        if (type === 'in') {
          const current = c.fadeInBars || 0;
          const next = Math.max(0, Math.min(c.lengthBars / 2, current + delta));
          return { ...c, fadeInBars: Number(next.toFixed(2)) };
        } else {
          const current = c.fadeOutBars || 0;
          const next = Math.max(0, Math.min(c.lengthBars / 2, current + delta));
          return { ...c, fadeOutBars: Number(next.toFixed(2)) };
        }
      }
      return c;
    });
    onUpdateClips(updated);
  };

  // Read exclusively from refs so this function is safe to call from any stale closure
  // (e.g. the window pointermove listener captured inside useEffect([interaction])).
  // interactionRef.current always holds the live interaction; clipsRef.current always
  // holds the latest clips array.
  const updateInteraction = (clientX: number, clientY: number) => {
    const active = interactionRef.current;
    if (!active) return;
    const clip = active.clip;

    if (Math.abs(clientX - active.originX) > 2 || (active.kind !== 'resize-left' && active.kind !== 'resize-right' && Math.abs(clientY - active.originY) > 2)) {
      didMoveRef.current = true;
    }

    const currentClips = clipsRef.current;
    try {
      if (active.kind === 'automation-point') {
        const usableWidth = Math.max(1, active.clipLengthBars * 96 - 12);
        const rawX = (clientX - active.automationLeft) / usableWidth;
        const rawY = 1 - (clientY - active.automationTop) / 20;
        const snapSteps = active.clipLengthBars > 0 ? Math.round(active.clipLengthBars / DEFAULT_GRID_BARS) : undefined;
        const result = movePlaylistAutomationPoint(clip, active.pointIndex, rawX, rawY, snapSteps);
        active.clip = result.clip;
        active.pointIndex = result.nextIndex;
        setSelectedPointIndex(result.nextIndex);
        onUpdateClips(currentClips.map(item => item.id === clip.id ? result.clip : item));
      } else if (active.kind === 'move') {
        const requestedStart = clip.startBar + (clientX - active.originX) / BAR_WIDTH;
        const targetTrack = clip.trackIndex + Math.round((clientY - active.originY) / TRACK_HEIGHT);
        const moved = movePlaylistClip(clip, requestedStart, targetTrack, DEFAULT_GRID_BARS, bounds);
        onUpdateClips(currentClips.map(item => item.id === clip.id ? moved : item));
      } else if (active.kind === 'resize-left') {
        const requestedStart = clip.startBar + (clientX - active.originX) / BAR_WIDTH;
        const resized = resizePlaylistClipLeft(clip, requestedStart, DEFAULT_GRID_BARS, MIN_CLIP_LENGTH, bounds);
        onUpdateClips(currentClips.map(item => item.id === clip.id ? resized : item));
      } else {
        const requestedEnd = clip.startBar + clip.lengthBars + (clientX - active.originX) / BAR_WIDTH;
        const resized = resizePlaylistClipRight(clip, requestedEnd, DEFAULT_GRID_BARS, MIN_CLIP_LENGTH, bounds);
        onUpdateClips(currentClips.map(item => item.id === clip.id ? resized : item));
      }
    } catch (error) {
      // Invalid coordinates are rejected by the operation layer; the UI remains unchanged.
      console.warn('Playlist interaction rejected by operation layer', error);
    }
  };

  const beginAutomationPointInteraction = (event: React.PointerEvent<SVGCircleElement>, clip: PlaylistClip, pointIndex: number) => {
    if (activeTool !== 'place') return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg || clip.type !== 'automation' || !clip.automationPoints?.[pointIndex]) return;
    event.preventDefault();
    event.stopPropagation();
    // Capture on the circle so the drag keeps receiving pointermove/up even
    // when the pointer leaves the SVG or the element reparents mid-drag.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Browser or unmounted target may reject capture
    }
    const rect = svg.getBoundingClientRect();
    didMoveRef.current = false;
    onPlaylistInteractionStart?.('automation-point');
    selectClip(clip.id, { openAutomationEditor: true });
    setSelectedPointIndex(pointIndex);
    const next: Interaction = {
      kind: 'automation-point',
      clip,
      pointerId: event.pointerId,
      pointIndex,
      originX: event.clientX,
      originY: event.clientY,
      automationLeft: rect.left,
      automationTop: rect.top,
      clipLengthBars: clip.lengthBars
    };
    interactionRef.current = next;
    setInteraction(next);
  };

  const beginInteraction = (event: React.PointerEvent, next: Interaction) => {
    if (activeTool !== 'place') return;
    event.preventDefault();
    event.stopPropagation();
    didMoveRef.current = false;
    onPlaylistInteractionStart?.(next.kind);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Browser or unmounted target may reject capture
    }
    selectClip(next.clip.id);
    interactionRef.current = next;
    setInteraction(next);
  };

  const endInteraction = (event?: React.PointerEvent | PointerEvent) => {
    if (!interactionRef.current && !interaction) return;
    try {
      if (event && 'currentTarget' in event && event.currentTarget && typeof (event.currentTarget as any).hasPointerCapture === 'function') {
        const target = event.currentTarget as HTMLElement;
        if (target.hasPointerCapture(event.pointerId)) {
          target.releasePointerCapture(event.pointerId);
        }
      }
    } catch {
      // Pointer capture already released or element unmounted
    }
    interactionRef.current = null;
    setInteraction(null);
    onPlaylistInteractionEnd?.();
  };

  // Keep latest callbacks in refs so the permanently-mounted window listeners
  // below never operate on stale closures (bounds, props, or state snapshots).
  const updateInteractionRef = useRef(updateInteraction);
  updateInteractionRef.current = updateInteraction;
  const endInteractionRef = useRef(endInteraction);
  endInteractionRef.current = endInteraction;
  const onPlaylistInteractionEndRef = useRef(onPlaylistInteractionEnd);
  onPlaylistInteractionEndRef.current = onPlaylistInteractionEnd;

  // Window pointer listeners guarantee that even if DOM elements reparent or drop pointer capture,
  // pointer up/cancel will always terminate the active playlist interaction safely.
  // Mounted continuously for the component lifetime, reading synchronously from refs.
  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      const active = interactionRef.current;
      if (active && e.pointerId === active.pointerId) {
        updateInteractionRef.current(e.clientX, e.clientY);
      }
    };

    const handleWindowPointerUp = (e: PointerEvent) => {
      const active = interactionRef.current;
      if (active && e.pointerId === active.pointerId) {
        endInteractionRef.current(e);
      }
    };

    const handleWindowPointerCancel = (e: PointerEvent) => {
      const active = interactionRef.current;
      if (active && e.pointerId === active.pointerId) {
        endInteractionRef.current(e);
      }
    };

    // If the window loses focus mid-drag (alt-tab, OS overlay), finalize the
    // interaction so onPlaylistInteractionEnd always fires and undo/redo is
    // never left blocked by a phantom active interaction.
    const handleWindowBlur = () => {
      if (interactionRef.current) {
        endInteractionRef.current();
      }
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerCancel);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerCancel);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  // Unmount safety net: if the component unmounts mid-drag (view switch),
  // release the App-level interaction lock so undo/redo and history commits
  // are not stuck for the rest of the session.
  useEffect(() => {
    return () => {
      if (interactionRef.current) {
        interactionRef.current = null;
        setInteraction(null);
        onPlaylistInteractionEndRef.current?.();
      }
    };
  }, []);

  const deleteClip = (clipId: string) => {
    onUpdateClips(deletePlaylistClip(clips, clipId));
    if (selectedClipId === clipId) selectClip(null);
    if (automationEditorClipId === clipId) setAutomationEditorClipId(null);
  };

  const duplicateClip = (clip: PlaylistClip) => {
    try {
      const duplicate = duplicatePlaylistClip(
        clip,
        `${clip.id}-copy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        clip.startBar + clip.lengthBars,
        clip.trackIndex,
        DEFAULT_GRID_BARS,
        bounds
      );
      onUpdateClips([...clips, duplicate]);
      selectClip(duplicate.id);
      if (clip.type === 'automation') setAutomationEditorClipId(duplicate.id);
    } catch {
      setStatusMessage('Duplicate cannot fit within the playlist bounds.');
      setTimeout(() => setStatusMessage(null), 2000);
    }
  };

  const splitClip = (clip: PlaylistClip, splitBar: number) => {
    try {
      const [left, right] = splitPlaylistClip(clip, splitBar, DEFAULT_GRID_BARS, bounds);
      onUpdateClips([...deletePlaylistClip(clips, clip.id), left, right]);
      selectClip(left.id);
      if (automationEditorClipId === clip.id) setAutomationEditorClipId(null);
    } catch {
      setStatusMessage('Clip cannot be split at that position.');
      setTimeout(() => setStatusMessage(null), 2000);
    }
  };

  const handleGridCellClick = (trackIndex: number, barIndex: number) => {
    const existingClip = clips.find(c => c.trackIndex === trackIndex && barIndex >= c.startBar && barIndex < c.startBar + c.lengthBars);

    if (activeTool === 'delete') {
      if (existingClip) deleteClip(existingClip.id);
      return;
    }

    if (activeTool === 'cut' && existingClip) {
      splitClip(existingClip, barIndex);
      return;
    }

    if (existingClip) {
      selectClip(existingClip.id, { openAutomationEditor: existingClip.type === 'automation' });
      return;
    }

    // Place new clip according to selected clip type
    const targetChannel = resolvePlaylistTargetChannel(channels, trackIndex);
    let newClip: PlaylistClip;

    if (clipTypeToAdd === 'automation') {
      const initialTargetChannel = targetChannel || channels[0];
      newClip = {
        id: `auto-clip-${Date.now()}`,
        trackIndex,
        startBar: barIndex,
        lengthBars: 4,
        type: 'automation',
        color: '#00e5ff',
        name: `Auto: ${initialTargetChannel?.name || 'Channel'} Cutoff`,
        automationTarget: {
          type: 'channel_filter_cutoff',
          targetId: initialTargetChannel?.id || '',
          label: `${initialTargetChannel?.name || 'Channel'} Filter Cutoff`
        },
        automationPoints: [
          { x: 0, y: 0.2, tension: 0.3 },
          { x: 0.5, y: 0.85, tension: -0.2 },
          { x: 1, y: 0.3, tension: 0 }
        ]
      };
      setAutomationEditorClipId(newClip.id);
      setSelectedPointIndex(null);
    } else if (clipTypeToAdd === 'audio') {
      newClip = {
        id: `audio-clip-${Date.now()}`,
        trackIndex,
        startBar: barIndex,
        lengthBars: 4,
        type: 'audio',
        color: '#00ff88',
        name: 'Audio Stem / Vocal',
        fadeInBars: 0.25,
        fadeOutBars: 0.5,
        audioWaveform: [0.1, 0.4, 0.8, 0.6, 0.9, 0.7, 0.4, 0.2, 0.8, 0.9, 0.5, 0.3, 0.1, 0.6, 0.8, 0.2]
      };
    } else {
      // Pattern
      newClip = createPlaylistPatternClip(
        trackIndex,
        barIndex,
        targetChannel,
        tracks[trackIndex]
      );
    }

    onUpdateClips([...clips, newClip]);
  };

  const handleAddAutomationPoint = (clipId: string, normX: number, normY: number) => {
    const targetClip = clips.find(c => c.id === clipId);
    if (!targetClip || targetClip.type !== 'automation') return;
    try {
      const res = addPlaylistAutomationPoint(targetClip, normX, normY);
      selectClip(clipId, { openAutomationEditor: true });
      setSelectedPointIndex(res.pointIndex);
      onUpdateClips(clips.map(c => c.id === clipId ? res.clip : c));
    } catch (err) {
      console.warn('Failed to add automation point', err);
    }
  };

  const handleDeleteAutomationPoint = (clipId: string, pointIndex: number) => {
    const targetClip = clips.find(c => c.id === clipId);
    if (!targetClip || targetClip.type !== 'automation' || !targetClip.automationPoints) return;
    if (targetClip.automationPoints.length <= 2) {
      setStatusMessage('Automation lane must retain at least 2 points');
      setTimeout(() => setStatusMessage(null), 2500);
      return;
    }
    try {
      const updatedClip = deletePlaylistAutomationPoint(targetClip, pointIndex);
      setSelectedPointIndex(null);
      onUpdateClips(clips.map(c => c.id === clipId ? updatedClip : c));
    } catch (err) {
      console.warn('Failed to delete automation point', err);
    }
  };

  const activeAutomationClip = clips.find(c => c.id === automationEditorClipId);
  const selectedClip = clips.find(c => c.id === selectedClipId);

  // Selection hygiene: if the selected clip disappears or its point count
  // shrinks below the selected index (delete, split, undo/redo), drop the
  // stale point index so Delete can never act on an out-of-range point.
  useEffect(() => {
    if (selectedPointIndex === null) return;
    const clip = clips.find(c => c.id === selectedClipId);
    if (!clip || clip.type !== 'automation' || !clip.automationPoints || selectedPointIndex >= clip.automationPoints.length) {
      setSelectedPointIndex(null);
    }
  }, [clips, selectedClipId, selectedPointIndex]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)
      ) {
        return;
      }

      const hasSelection = Boolean(selectedClipId && selectedClip);
      const action = resolvePlaylistKeyboardShortcut(e, hasSelection);

      if (action === 'escape') {
        e.preventDefault();
        if (interactionRef.current) {
          endInteraction();
          return;
        }
        if (isMarkerMenuOpen) {
          setIsMarkerMenuOpen(false);
          return;
        }
        if (selectedClipId) {
          selectClip(null);
          return;
        }
        return;
      }

      if (interactionRef.current) {
        return;
      }

      if (action === 'delete') {
        e.preventDefault();
        if (selectedClipId) {
          const selected = clips.find(c => c.id === selectedClipId);
          if (selected?.type === 'automation' && selectedPointIndex !== null) {
            handleDeleteAutomationPoint(selectedClipId, selectedPointIndex);
            return;
          }
          deleteClip(selectedClipId);
        }
        return;
      }

      if (action === 'duplicate') {
        e.preventDefault();
        e.stopPropagation();
        if (selectedClip) {
          duplicateClip(selectedClip);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [clips, selectedClipId, selectedClip, isMarkerMenuOpen, bounds]);

  return (
    <div id="fl-playlist-arranger" className="flex flex-col h-full bg-[#121214] select-none text-[#b0b0b0]">
      {/* Toast Notification */}
      {statusMessage && (
        <div className="bg-[#ff6e00] text-black font-bold text-xs px-4 py-1 flex items-center justify-between shadow-md z-20">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{statusMessage}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
        </div>
      )}

      {/* Playlist Top Toolbar */}
      <div className="h-10 bg-[#1e1e20] border-b border-[#333336] flex items-center justify-between px-3 shrink-0 gap-3">
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-1.5 text-white font-bold text-xs uppercase tracking-wider">
            <Layers className="w-3.5 h-3.5 text-[#ff6e00]" />
            <span className="hidden sm:inline">PLAYLIST SONG ARRANGER</span>
          </div>

          {/* Playlist History */}
          <div className="flex items-center gap-0.5 bg-[#121214] border border-[#333336] p-0.5 rounded text-xs">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className="px-2 py-0.5 rounded-sm font-semibold text-[10px] text-white hover:bg-[#333336] disabled:opacity-30 disabled:cursor-not-allowed"
              title="Undo playlist edit"
            >
              Undo
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className="px-2 py-0.5 rounded-sm font-semibold text-[10px] text-white hover:bg-[#333336] disabled:opacity-30 disabled:cursor-not-allowed"
              title="Redo playlist edit"
            >
              Redo
            </button>
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
              Audio Stem
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

        {/* Section Markers & Zoom & Add Track */}
        <div className="flex items-center gap-2">
          {/* Arrangement Markers Button */}
          <div className="relative">
            <button
              onClick={() => setIsMarkerMenuOpen(!isMarkerMenuOpen)}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#18181c] hover:bg-[#25252a] text-[#ffaa00] border border-[#ffaa00]/30 rounded text-xs font-bold transition shadow"
              title="Arrangement Timeline Section Markers"
            >
              <Flag className="w-3 h-3" />
              <span className="hidden md:inline">Sections ({markers.length})</span>
            </button>

            {isMarkerMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-64 bg-[#18181c] border border-[#333338] rounded-xl shadow-2xl p-3 z-30 space-y-3">
                <div className="flex items-center justify-between border-b border-[#28282b] pb-2">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <Flag className="w-3.5 h-3.5 text-[#ffaa00]" />
                    <span>TIMELINE SECTION MARKERS</span>
                  </span>
                  <button onClick={() => setIsMarkerMenuOpen(false)} className="text-[#888] hover:text-white">✕</button>
                </div>

                {/* Quick Add at Playhead */}
                <div className="space-y-1.5">
                  <span className="text-[10px] font-bold text-[#888] uppercase block">QUICK ADD MARKER (BAR {currentBar})</span>
                  <div className="grid grid-cols-2 gap-1 text-[10px] font-bold">
                    <button
                      onClick={() => handleAddMarker('Intro', currentBar, '#00e5ff')}
                      className="p-1 rounded bg-[#00e5ff]/20 text-[#00e5ff] border border-[#00e5ff]/40 hover:bg-[#00e5ff]/30"
                    >
                      + Intro
                    </button>
                    <button
                      onClick={() => handleAddMarker('Verse', currentBar, '#3b82f6')}
                      className="p-1 rounded bg-[#3b82f6]/20 text-[#3b82f6] border border-[#3b82f6]/40 hover:bg-[#3b82f6]/30"
                    >
                      + Verse
                    </button>
                    <button
                      onClick={() => handleAddMarker('Drop / Chorus', currentBar, '#ff0055')}
                      className="p-1 rounded bg-[#ff0055]/20 text-[#ff0055] border border-[#ff0055]/40 hover:bg-[#ff0055]/30"
                    >
                      + Drop / Chorus
                    </button>
                    <button
                      onClick={() => handleAddMarker('Outro', currentBar, '#00ff88')}
                      className="p-1 rounded bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40 hover:bg-[#00ff88]/30"
                    >
                      + Outro
                    </button>
                  </div>
                </div>

                {/* Presets */}
                <div className="space-y-1.5 border-t border-[#28282b] pt-2">
                  <span className="text-[10px] font-bold text-[#888] uppercase block">PRESET STRUCTURES</span>
                  <div className="space-y-1">
                    {MARKER_PRESETS.map((p, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleApplyMarkerPreset(p)}
                        className="w-full text-left p-1.5 rounded bg-[#121214] hover:bg-[#222225] text-xs text-white border border-[#2e2e32] flex items-center justify-between"
                      >
                        <span>{p.name}</span>
                        <span className="text-[9px] text-[#777]">{p.markers.length} pts</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 bg-[#121214] border border-[#333336] p-0.5 rounded">
            <button
              onClick={() => setTotalBars(prev => Math.max(8, prev - 8))}
              className="p-1 text-[#777] hover:text-white"
              title="Zoom In"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <span className="text-[9px] text-[#ff6e00] font-mono px-1">{totalBars} Bars</span>
            <button
              onClick={() => setTotalBars(prev => Math.min(64, prev + 8))}
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
          <div className="h-12 bg-[#1a1a1d] border-b border-[#333336] px-3 flex items-center justify-between text-[9px] font-bold text-[#777] uppercase tracking-wider">
            <span>TRACK LANES</span>
            <span>BOUNCE</span>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {tracks.map((track, idx) => (
              <div
                key={track.id}
                className="h-16 border-b border-[#222225] px-2 flex items-center justify-between bg-[#141416] hover:bg-[#1a1a1d] transition group"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <button
                    onClick={() => handleTrackMute(track.id)}
                    className={`w-2.5 h-2.5 rounded-full border transition shrink-0 ${
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

                <div className="flex items-center gap-1">
                  {/* Bounce / Freeze Button */}
                  <button
                    onClick={() => handleBounceTrack(idx)}
                    className="opacity-0 group-hover:opacity-100 p-1 bg-[#222] hover:bg-[#00ff88] hover:text-black text-[#888] rounded transition"
                    title="Bounce Channel to Audio Clip Stem"
                  >
                    <Snowflake className="w-3 h-3" />
                  </button>
                  <div className="w-1.5 h-8 rounded-xs bg-[#ff6e00]" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline Clips Area */}
        <div className="flex-1 flex flex-col overflow-auto custom-scrollbar bg-[#0a0a0b]">
          {/* Top Section Markers Ribbon */}
          <div className="flex h-5 bg-[#121215] border-b border-[#28282b] sticky top-0 z-20 min-w-[768px] relative">
            {markers.map((marker) => (
              <div
                key={marker.id}
                onClick={() => onSeekToBar && onSeekToBar(marker.bar)}
                className="absolute top-0.5 bottom-0.5 px-2 rounded-xs border-l-2 text-[9px] font-bold font-mono flex items-center gap-1 cursor-pointer shadow-sm hover:brightness-125 transition"
                style={{
                  left: `${(marker.bar - 1) * 96}px`,
                  backgroundColor: `${marker.color}22`,
                  borderLeftColor: marker.color,
                  color: marker.color
                }}
              >
                <Flag className="w-2.5 h-2.5 shrink-0" />
                <span className="truncate">{marker.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteMarker(marker.id);
                  }}
                  className="hover:text-red-400 opacity-60 hover:opacity-100 ml-1 text-[8px]"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Bars Header Ruler with Real-Time Audio Scrubbing */}
          <div 
            ref={rulerContainerRef}
            onMouseDown={(e) => {
              setIsScrubbing(true);
              handleRulerScrub(e.clientX);
            }}
            onMouseMove={(e) => {
              if (isScrubbing) {
                handleRulerScrub(e.clientX);
              }
            }}
            onMouseUp={() => setIsScrubbing(false)}
            onMouseLeave={() => setIsScrubbing(false)}
            className={`flex h-7 bg-[#1a1a1d] border-b border-[#333336] sticky top-5 z-10 min-w-[768px] ${
              isScrubbing ? 'cursor-ew-resize bg-[#242429]' : 'cursor-pointer'
            }`}
          >
            {Array.from({ length: totalBars }).map((_, barIdx) => {
              const isPlayHead = isPlaying && currentBar === barIdx + 1;
              return (
                <div
                  key={barIdx}
                  onClick={() => onSeekToBar && onSeekToBar(barIdx + 1)}
                  className={`w-24 h-full border-r border-[#333336] flex items-center justify-between px-2 text-[9px] font-mono transition select-none ${
                    isPlayHead ? 'bg-[#ff6e00]/20 text-[#ff6e00] font-bold' : 'text-[#777] hover:bg-white/5'
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
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.add('bg-[#1a2e22]');
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('bg-[#1a2e22]');
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('bg-[#1a2e22]');

                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    const file = e.dataTransfer.files[0];
                    if (file.type.startsWith('audio/') || file.name.endsWith('.wav') || file.name.endsWith('.mp3') || file.name.endsWith('.ogg')) {
                      setStatusMessage(`Importing sample "${file.name}" to Track #${track.id}...`);
                      try {
                        const arrayBuf = await file.arrayBuffer();
                        const audioCtx = audioEngine.getContext();
                        const decoded = await audioCtx.decodeAudioData(arrayBuf);
                        const bufId = `dropped-sample-${Date.now()}`;
                        audioEngine.setSampleBuffer(bufId, decoded);

                        // Generate waveform peaks
                        const rawData = decoded.getChannelData(0);
                        const samples = 32;
                        const blockSize = Math.floor(rawData.length / samples);
                        const peaks: number[] = [];
                        for (let i = 0; i < samples; i++) {
                          let sum = 0;
                          for (let j = 0; j < blockSize; j++) {
                            sum += Math.abs(rawData[i * blockSize + j]);
                          }
                          peaks.push(Math.min(1, (sum / blockSize) * 3));
                        }

                        const durationBars = Math.max(1, Math.round(decoded.duration / ((4 * 60) / 130)));
                        const newDroppedClip: PlaylistClip = {
                          id: `audio-drop-${Date.now()}`,
                          trackIndex: trackIdx,
                          startBar: currentBar - 1 >= 0 ? currentBar - 1 : 0,
                          lengthBars: durationBars,
                          type: 'audio',
                          audioBufferId: bufId,
                          audioName: file.name,
                          audioWaveform: peaks,
                          color: '#00ff88',
                          name: file.name.replace(/\.[^/.]+$/, '')
                        };

                        onUpdateClips([...clips, newDroppedClip]);
                        setStatusMessage(`Loaded audio clip "${file.name}" onto Track #${track.id}!`);
                        setTimeout(() => setStatusMessage(null), 3000);
                      } catch (err) {
                        console.error(err);
                        setStatusMessage('Error decoding dropped audio file.');
                        setTimeout(() => setStatusMessage(null), 3000);
                      }
                    }
                  }
                }}
                className="h-16 border-b border-[#1c1c20] flex relative bg-[#0e0e10] transition-colors"
              >
                {/* 1 Bar grid slots */}
                {Array.from({ length: totalBars }).map((_, barIdx) => {
                  const isPlayheadBar = isPlaying && currentBar === barIdx + 1;
                  return (
                    <div
                      key={barIdx}
                      onClick={() => handleGridCellClick(trackIdx, barIdx)}
                      className={`w-24 h-full border-r border-[#1c1c20] cursor-pointer transition ${
                        isPlayheadBar ? 'bg-white/5' : 'hover:bg-white/10'
                      }`}
                    />
                  );
                })}

                {/* Clips in this track row */}
                {clips.filter(c => c.trackIndex === trackIdx).map((clip) => {
                  const isAuto = clip.type === 'automation';
                  const isAudio = clip.type === 'audio';
                  // Phase 8C (P1-11): audio hydration flagged this clip's asset as
                  // unrestorable. It must never look like a healthy clip.
                  const isAudioMissing = isPlaylistClipAudioUnavailable(clip);
                  const audioMissingDescription = isAudioMissing ? describeMissingAudioClip(clip) : undefined;
                  const isSelected = selectedClipId === clip.id;

                  return (
                    <div
                      key={clip.id}
                      data-audio-unavailable={isAudioMissing ? 'true' : undefined}
                      aria-label={audioMissingDescription}
                      title={audioMissingDescription}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        beginInteraction(e, { kind: 'move', clip, pointerId: e.pointerId, originX: e.clientX, originY: e.clientY });
                      }}
                      onPointerMove={(e) => {
                        if (interaction && e.pointerId === interaction.pointerId) updateInteraction(e.clientX, e.clientY);
                      }}
                      onPointerUp={(e) => {
                        if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                      }}
                      onPointerCancel={(e) => {
                        if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                      }}
                      onLostPointerCapture={(e) => {
                        if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (didMoveRef.current) {
                          didMoveRef.current = false;
                          return;
                        }
                        if (activeTool === 'delete') {
                          deleteClip(clip.id);
                        } else if (activeTool === 'cut') {
                          // Clips render above the grid cells, so a Slice click lands
                          // here instead of handleGridCellClick: derive the bar from
                          // the click position inside the clip and split in place.
                          const clipLeft = e.currentTarget.getBoundingClientRect().left;
                          splitClip(clip, resolveClipClickBar(clip, e.clientX, clipLeft, BAR_WIDTH));
                        } else {
                          selectClip(clip.id, { openAutomationEditor: isAuto });
                        }
                      }}
                      style={{
                        left: `${clip.startBar * 96}px`,
                        width: `${clip.lengthBars * 96 - 4}px`
                      }}
                      className={`absolute top-1 bottom-1 border rounded-sm p-1.5 flex flex-col justify-between overflow-hidden shadow cursor-pointer transition relative group ${
                        isAuto 
                          ? 'bg-[#002233]/90 border-[#00e5ff] hover:bg-[#00334d]' 
                          : isAudio 
                            ? isAudioMissing
                              ? 'bg-[#3a0d12]/90 border-red-500 hover:bg-[#46141a]'
                              : 'bg-[#002b1a]/90 border-[#00ff88] hover:bg-[#003d24]'
                            : 'bg-[#1a1a1d] border-l-4 border-l-[#ff6e00] border-[#333336] hover:border-[#ff6e00]'
                      } ${isSelected ? 'ring-2 ring-white/60' : ''}`}
                    >
                      {/* Top Header */}
                      <div className="flex items-center justify-between gap-1 font-bold text-[10px] truncate z-10 min-w-0">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className={`truncate ${isAuto ? 'text-[#00e5ff]' : isAudioMissing ? 'text-red-300' : isAudio ? 'text-[#00ff88]' : 'text-white'}`}>
                            {clip.name}
                          </span>
                          {isAudioMissing && (
                            <span
                              id={`missing-audio-clip-badge-${clip.id}`}
                              role="status"
                              data-audio-unavailable="true"
                              title={audioMissingDescription}
                              className="flex items-center gap-0.5 px-1 py-[1px] rounded bg-red-600 text-white text-[8px] font-bold uppercase tracking-wide shrink-0"
                            >
                              <AlertTriangle className="w-2.5 h-2.5" />
                              {MISSING_AUDIO_CLIP_BADGE_LABEL}
                            </span>
                          )}
                        </div>
                        <span className="text-[8px] opacity-70 font-mono shrink-0">{clip.lengthBars}B</span>
                      </div>

                      {/* Content Preview & Fade Overlays */}
                      {isAuto && clip.automationPoints ? (
                        <div className="relative h-6 w-full flex items-center z-10">
                          <svg
                            className="w-full h-full overflow-visible cursor-crosshair"
                            style={{ pointerEvents: 'all' }}
                            onPointerDown={(e) => {
                              if (e.button !== 0 || activeTool !== 'place') return;
                              if ((e.target as HTMLElement).tagName?.toLowerCase() === 'circle') return;
                              e.preventDefault();
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const usableWidth = Math.max(1, clip.lengthBars * 96 - 12);
                              const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / usableWidth));
                              const normY = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / 20));
                              // Clicks that land on/near an existing point select that point
                              // instead of silently relocating it; adding happens on free space.
                              const nearIdx = findAutomationPointIndexNearX(clip.automationPoints ?? [], normX, NEAR_POINT_TOLERANCE_PX / usableWidth);
                              if (nearIdx !== null) {
                                selectClip(clip.id, { openAutomationEditor: true });
                                setSelectedPointIndex(nearIdx);
                                return;
                              }
                              try {
                                const res = addPlaylistAutomationPoint(clip, normX, normY);
                                selectClip(clip.id, { openAutomationEditor: true });
                                setSelectedPointIndex(res.pointIndex);
                                onUpdateClips(clips.map(c => c.id === clip.id ? res.clip : c));
                              } catch (err) {
                                console.warn('Failed to add automation point', err);
                              }
                            }}
                          >
                            <rect width="100%" height="100%" fill="transparent" />
                            <polyline
                              fill="none"
                              stroke="#00e5ff"
                              strokeWidth="2"
                              points={clip.automationPoints.map(p => `${p.x * (clip.lengthBars * 96 - 12)},${(1 - p.y) * 20}`).join(' ')}
                            />
                            {clip.automationPoints.map((p, pIdx) => {
                              const isPointSelected = isSelected && selectedPointIndex === pIdx;
                              return (
                                <circle
                                  key={pIdx}
                                  cx={p.x * (clip.lengthBars * 96 - 12)}
                                  cy={(1 - p.y) * 20}
                                  r={isPointSelected ? "4.5" : "3"}
                                  fill={isPointSelected ? "#00e5ff" : "#ffffff"}
                                  stroke={isPointSelected ? "#ffffff" : "none"}
                                  strokeWidth="1.5"
                                  className="cursor-move"
                                  style={{ touchAction: 'none' }}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleDeleteAutomationPoint(clip.id, pIdx);
                                  }}
                                  onPointerDown={(e) => {
                                    if (e.button === 2) return;
                                    if (e.button !== 0) return;
                                    beginAutomationPointInteraction(e, clip, pIdx);
                                  }}
                                />
                              );
                            })}
                          </svg>
                        </div>
                      ) : isAudio ? (
                        isAudioMissing ? (
                          // No peaks are drawn for an unavailable asset: a green
                          // waveform here would read as "loaded and ready".
                          <div className="relative h-4 w-full flex items-center z-10" data-audio-unavailable="true">
                            <div className="w-full border-t border-dashed border-red-400/80" />
                            <span className="absolute left-0 text-[8px] font-bold uppercase tracking-wide text-red-300 bg-[#3a0d12]/80 pr-1">
                              {MISSING_AUDIO_CLIP_BADGE_LABEL} — waveform unavailable
                            </span>
                          </div>
                        ) : (
                          <div className="relative flex items-center gap-0.5 h-4 opacity-80 z-10">
                            {Array.from({ length: 32 }).map((_, i) => {
                              const waveVal = clip.audioWaveform ? (clip.audioWaveform[i] || 0.4) : (0.2 + Math.sin(i * 0.5) * 0.4);
                              return (
                                <div
                                  key={i}
                                  className="flex-1 bg-[#00ff88] rounded-xs"
                                  style={{ height: `${Math.max(15, waveVal * 100)}%` }}
                                />
                              );
                            })}
                          </div>
                        )
                      ) : (
                        <div className="flex items-center gap-0.5 h-3 opacity-60 z-10">
                          {Array.from({ length: 16 }).map((_, i) => (
                            <div 
                              key={i} 
                              className="flex-1 bg-[#ff6e00] rounded-xs"
                              style={{ height: `${20 + (i % 5) * 15}%` }}
                            />
                          ))}
                        </div>
                      )}

                      {/* Visual Fade-In / Fade-Out Translucent Bezier Curves for Audio */}
                      {isAudio && (
                        <>
                          {/* Fade In Handle */}
                          <div
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAdjustClipFade(clip.id, 'in', 0.25);
                            }}
                            style={{ width: `${(clip.fadeInBars || 0) * 96}px` }}
                            className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-black/80 to-transparent pointer-events-auto border-r border-white/40 cursor-ew-resize opacity-0 group-hover:opacity-100 transition"
                            title={`Fade In: ${(clip.fadeInBars || 0)} Bars (Click to extend)`}
                          >
                            <span className="text-[7px] text-white font-mono pl-1">IN</span>
                          </div>

                          {/* Fade Out Handle */}
                          <div
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAdjustClipFade(clip.id, 'out', 0.25);
                            }}
                            style={{ width: `${(clip.fadeOutBars || 0) * 96}px` }}
                            className="absolute top-0 bottom-0 right-0 bg-gradient-to-l from-black/80 to-transparent pointer-events-auto border-l border-white/40 cursor-ew-resize opacity-0 group-hover:opacity-100 transition"
                            title={`Fade Out: ${(clip.fadeOutBars || 0)} Bars (Click to extend)`}
                          >
                            <span className="text-[7px] text-white font-mono pr-1 float-right">OUT</span>
                          </div>
                        </>
                      )}

                      {/* Phase 4 clip resize handles */}
                      <div
                        role="separator"
                        aria-label="Resize clip start"
                        onPointerDown={(e) => beginInteraction(e, { kind: 'resize-left', clip, pointerId: e.pointerId, originX: e.clientX })}
                        onPointerMove={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) updateInteraction(e.clientX, e.clientY);
                        }}
                        onPointerUp={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                        }}
                        onPointerCancel={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                        }}
                        onLostPointerCapture={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                        }}
                        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/20 hover:bg-white/40 z-30"
                      />
                      <div
                        role="separator"
                        aria-label="Resize clip end"
                        onPointerDown={(e) => beginInteraction(e, { kind: 'resize-right', clip, pointerId: e.pointerId, originX: e.clientX })}
                        onPointerMove={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) updateInteraction(e.clientX, e.clientY);
                        }}
                        onPointerUp={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                        }}
                        onPointerCancel={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                        }}
                        onLostPointerCapture={(e) => {
                          if (interaction && e.pointerId === interaction.pointerId) endInteraction(e);
                        }}
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/20 hover:bg-white/40 z-30"
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Clip Property Inspector Drawer for Selected Clip */}
      {selectedClip && !activeAutomationClip && (
        <div className="bg-[#18181c] border-t border-[#333338] p-2.5 px-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-bold text-white">{selectedClip.name}</span>
            <span className="text-[10px] text-[#777] font-mono">({selectedClip.lengthBars} Bars)</span>
          </div>

          <div className="flex items-center gap-3">
            {selectedClip.type === 'audio' && (
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span>Fade In: <strong>{selectedClip.fadeInBars || 0}B</strong></span>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'in', -0.25)}
                  className="px-1.5 py-0.5 bg-[#25252a] rounded hover:bg-[#333]"
                >
                  -
                </button>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'in', 0.25)}
                  className="px-1.5 py-0.5 bg-[#25252a] rounded hover:bg-[#333]"
                >
                  +
                </button>

                <span className="ml-2">Fade Out: <strong>{selectedClip.fadeOutBars || 0}B</strong></span>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'out', -0.25)}
                  className="px-1.5 py-0.5 bg-[#25252a] rounded hover:bg-[#333]"
                >
                  -
                </button>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'out', 0.25)}
                  className="px-1.5 py-0.5 bg-[#25252a] rounded hover:bg-[#333]"
                >
                  +
                </button>
              </div>
            )}

            <button
              onClick={() => duplicateClip(selectedClip)}
              className="px-2 py-1 bg-[#282830] text-white hover:bg-[#333] rounded font-bold flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              Duplicate
            </button>

            <button
              onClick={() => deleteClip(selectedClip.id)}
              className="px-2 py-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded font-bold flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              Delete Clip
            </button>

            <button onClick={() => selectClip(null)} className="text-[#888] hover:text-white">✕</button>
          </div>

          {isPlaylistClipAudioUnavailable(selectedClip) && (
            <div
              id="playlist-selected-clip-missing-audio"
              role="alert"
              data-audio-unavailable="true"
              className="w-full flex items-center gap-2 px-2 py-1 rounded bg-[#361111] border border-red-500/60 text-[10px] text-red-200"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span>{describeMissingAudioClip(selectedClip)}</span>
            </div>
          )}
        </div>
      )}

      {/* Automation Node Quick Drawer */}
      {activeAutomationClip && (
        <div className="bg-[#18181c] border-t border-[#00e5ff]/40 p-3 flex flex-col md:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-[#00e5ff] flex items-center justify-center text-black font-bold">
              <TrendingUp className="w-3.5 h-3.5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-white">AUTOMATION ENVELOPE: {activeAutomationClip.name}</span>
                {selectedPointIndex !== null && activeAutomationClip.automationPoints?.[selectedPointIndex] && (
                  <span className="px-1.5 py-0.5 rounded bg-[#00e5ff]/20 text-[#00e5ff] font-mono text-[10px]">
                    Point #{selectedPointIndex + 1} (X: {activeAutomationClip.automationPoints[selectedPointIndex].x.toFixed(2)}, Y: {activeAutomationClip.automationPoints[selectedPointIndex].y.toFixed(2)})
                  </span>
                )}
              </div>
              <p className="text-[10px] text-[#888]">
                Click envelope curve to add point • Drag to move (snapped to grid) • Right-click / Del to remove point
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#888]">Target:</span>
            <select
              value={activeAutomationClip.automationTarget?.type || 'channel_filter_cutoff'}
              onChange={(e) => {
                const newType = e.target.value as AutomationTargetType;
                let targetId: string | number = '';
                let label = '';
                if (newType.startsWith('channel_')) {
                  const currChan = channels.find(c => c.id === activeAutomationClip.automationTarget?.targetId) || channels[0];
                  targetId = currChan?.id || '';
                  const paramLabel = newType === 'channel_filter_cutoff' ? 'Filter Cutoff' : newType === 'channel_vol' ? 'Volume' : 'Pan';
                  label = `${currChan?.name || 'Channel'} ${paramLabel}`;
                } else if (newType.startsWith('mixer_')) {
                  const currTrk = mixerTracks.find(t => t.id === Number(activeAutomationClip.automationTarget?.targetId)) || mixerTracks[1] || mixerTracks[0];
                  targetId = currTrk ? currTrk.id : 1;
                  const paramLabel = newType === 'mixer_vol' ? 'Volume' : 'Pan';
                  label = `Mixer ${currTrk?.name || targetId} ${paramLabel}`;
                } else {
                  targetId = 0;
                  label = 'Master Output Volume';
                }
                const updated = updatePlaylistAutomationTarget(activeAutomationClip, {
                  type: newType,
                  targetId,
                  label
                });
                onUpdateClips(clips.map(c => c.id === activeAutomationClip.id ? updated : c));
              }}
              className="bg-[#0c0c0e] border border-[#333] text-white text-xs rounded px-2 py-1 font-bold"
            >
              <option value="channel_filter_cutoff">Channel Filter Cutoff (Hz)</option>
              <option value="channel_vol">Channel Volume (0 - 100%)</option>
              <option value="channel_pan">Channel Panning (L/R)</option>
              <option value="mixer_vol">Mixer Insert Volume</option>
              <option value="mixer_pan">Mixer Insert Panning</option>
              <option value="master_vol">Master Out Volume</option>
            </select>

            {/* Contextual Target Entity Selector */}
            {(activeAutomationClip.automationTarget?.type || 'channel_filter_cutoff').startsWith('channel_') && (
              <select
                value={activeAutomationClip.automationTarget?.targetId || channels[0]?.id || ''}
                onChange={(e) => {
                  const ch = channels.find(c => c.id === e.target.value);
                  const currentType = activeAutomationClip.automationTarget?.type || 'channel_filter_cutoff';
                  const paramLabel = currentType === 'channel_filter_cutoff' ? 'Filter Cutoff' : currentType === 'channel_vol' ? 'Volume' : 'Pan';
                  const updated = updatePlaylistAutomationTarget(activeAutomationClip, {
                    type: currentType,
                    targetId: e.target.value,
                    label: `${ch?.name || 'Channel'} ${paramLabel}`
                  });
                  onUpdateClips(clips.map(c => c.id === activeAutomationClip.id ? updated : c));
                }}
                className="bg-[#0c0c0e] border border-[#333] text-white text-xs rounded px-2 py-1 font-bold max-w-[130px] truncate"
              >
                {channels.map(ch => (
                  <option key={ch.id} value={ch.id}>{ch.name}</option>
                ))}
              </select>
            )}

            {(activeAutomationClip.automationTarget?.type || '').startsWith('mixer_') && (
              <select
                value={activeAutomationClip.automationTarget?.targetId ?? (mixerTracks[1]?.id ?? 1)}
                onChange={(e) => {
                  const trkId = Number(e.target.value);
                  const trk = mixerTracks.find(t => t.id === trkId);
                  const currentType = activeAutomationClip.automationTarget?.type || 'mixer_vol';
                  const paramLabel = currentType === 'mixer_vol' ? 'Volume' : 'Pan';
                  const updated = updatePlaylistAutomationTarget(activeAutomationClip, {
                    type: currentType,
                    targetId: trkId,
                    label: `Mixer ${trk?.name || trkId} ${paramLabel}`
                  });
                  onUpdateClips(clips.map(c => c.id === activeAutomationClip.id ? updated : c));
                }}
                className="bg-[#0c0c0e] border border-[#333] text-white text-xs rounded px-2 py-1 font-bold max-w-[130px] truncate"
              >
                {mixerTracks.map(trk => (
                  <option key={trk.id} value={trk.id}>{trk.name} (#{trk.id})</option>
                ))}
              </select>
            )}

            <button
              onClick={() => {
                // Resolve a collision-free insert position (widest-gap midpoint,
                // value on the envelope) so Add Node always adds on fresh clips
                // whose template already has a node at the center.
                const pos = resolveAddNodePosition(activeAutomationClip.automationPoints || []);
                handleAddAutomationPoint(activeAutomationClip.id, pos.x, pos.y);
              }}
              className="px-2.5 py-1 bg-[#282830] hover:bg-[#333] text-white rounded font-bold"
              title="Add a new automation point on the widest envelope gap"
            >
              + Add Node
            </button>

            <button
              onClick={() => {
                const pts = activeAutomationClip.automationPoints || [];
                const idxToDelete = selectedPointIndex !== null ? selectedPointIndex : pts.length - 1;
                handleDeleteAutomationPoint(activeAutomationClip.id, idxToDelete);
              }}
              disabled={!activeAutomationClip.automationPoints || activeAutomationClip.automationPoints.length <= 2}
              className={`px-2.5 py-1 rounded font-bold transition ${
                activeAutomationClip.automationPoints && activeAutomationClip.automationPoints.length > 2
                  ? 'bg-red-950/60 hover:bg-red-800 text-red-200 border border-red-800/40'
                  : 'bg-[#202024] text-[#555] cursor-not-allowed'
              }`}
              title={
                activeAutomationClip.automationPoints && activeAutomationClip.automationPoints.length > 2
                  ? `Delete ${selectedPointIndex !== null ? `node #${selectedPointIndex + 1}` : 'node'}`
                  : 'Automation lane must retain at least 2 points'
              }
            >
              Delete Node
            </button>

            <button
              onClick={() => {
                setAutomationEditorClipId(null);
                setSelectedPointIndex(null);
              }}
              className="p-1 text-[#888] hover:text-white rounded"
              title="Close editor drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
