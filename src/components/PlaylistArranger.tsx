import { barsToBeats, beatsToSeconds, LEGACY_TIME_SIGNATURE } from '../music/musicalTime';
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
import { resolvePlaylistBounceTarget } from './playlistBounceTarget';
import { formatFxParameterRange, listFxSlotOptions } from '../audio/fxParameterControl';
import {
  buildFxAutomationTarget,
  buildFxParamAutomationTarget,
  buildFxSlotAutomationTarget,
  fxAutomationSlotTargetId,
  listFxSlotParameterOptions,
  type FxAutomationTargetType,
} from './fxAutomationTargets';
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
import {
  resolvePlaylistDropPlacement,
  resolvePlaylistClipMove,
  resolveAudioDropStartBarFromClientX,
} from './audioDropPlacement';
import {
  MAX_TIMELINE_BARS,
  MIN_TIMELINE_BARS,
  clampStartBarToTimeline,
} from '../state/playlistTimeline';

/** Both grid-click producers create a 4-bar clip; the timeline clamp needs its length. */
const DEFAULT_PATTERN_CLIP_LENGTH_BARS = 4;
const AUTOMATION_CLIP_LENGTH_BARS = 4;

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
  /**
   * Phase 52: publishes the selected clip id upwards so timeline tools (the Warp
   * processor) act on the clip the user actually selected. The selection itself
   * stays owned by this component; this is a notification only.
   */
  onSelectedClipIdChange?: (clipId: string | null) => void;
  currentBar: number;
  isPlaying: boolean;
  /** Project tempo (`meta.bpm`); Bounce-In-Place renders stems at this tempo and imported audio is sized to it. */
  bpm: number;
  /**
   * Phase 54: the arrangement length, owned by `ProjectState` and passed down.
   *
   * It is deliberately required: this component used to keep its own
   * `useState(32)`, which is how a clip clicked near the end of the timeline
   * ended up past the boundary while the document (and the export window) had a
   * different idea of how long the arrangement was. Requiring the prop means
   * there is exactly one owner and the compiler enforces it.
   */
  totalBars: number;
  /** Publishes a new arrangement length through the normal project mutation path (single history entry). */
  onUpdateTotalBars: (totalBars: number) => void;
}

const BAR_WIDTH = 96;
/** Bounced stems are at least this long; longer channel content extends the stem. */
const MIN_BOUNCE_BARS = 4;
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
  onSelectedClipIdChange,
  currentBar,
  isPlaying,
  totalBars,
  onUpdateTotalBars,
  bpm
}) => {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<'place' | 'cut' | 'delete'>('place');
  const [clipTypeToAdd, setClipTypeToAdd] = useState<'pattern' | 'automation'>('pattern');
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
  const timelineScrollContainerRef = useRef<HTMLDivElement | null>(null);

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
    onSelectedClipIdChange?.(clipId);
    setSelectedPointIndex(prev => nextSelectedPointIndex(selectedClipId, prev, clipId));
    if (opts?.openAutomationEditor && clipId !== null) {
      setAutomationEditorClipId(clipId);
    }
  };

  const handleRulerScrub = (clientX: number) => {
    if (!rulerContainerRef.current || !onSeekToBar) return;
    const rect = rulerContainerRef.current.getBoundingClientRect();
    // Phase 79: ruler scrub must account for horizontal scroll, mirroring the
    // audio-drop placement fix (PRs #151/#152). Without `scrollLeft`, scrubbing
    // while the timeline is scrolled past bar 1 seeks to the wrong bar.
    const scrollLeft = timelineScrollContainerRef.current?.scrollLeft ?? 0;
    const relativeX = Math.max(0, clientX - rect.left + scrollLeft);
    const barWidth = BAR_WIDTH; // Standard bar slot width
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
    // Phase 64: the lane decides the channel. Using the lane index as a channel
    // index bounced the wrong instrument on any project whose channel list does
    // not match its lane order (the factory project is one of them), and an empty
    // lane silently bounced `channels[0]`.
    const target = resolvePlaylistBounceTarget(channels, clips, trackIdx);
    const channel = target.channelId ? channels.find(c => c.id === target.channelId) : undefined;
    if (!channel || target.status !== 'ready') {
      setStatusMessage(
        target.status === 'empty'
          ? 'Nothing to bounce on this lane.'
          : 'This lane has no channel to bounce.',
      );
      setTimeout(() => setStatusMessage(null), 3000);
      return;
    }

    setStatusMessage(`Bouncing ${channel.name} into offline Audio Stem...`);
    try {
      // Render at the project tempo over the channel's full playable length so the
      // stem lines up with the arrangement grid and no step past bar 1 is dropped.
      // The project's mixer strips are passed through so the stem carries the same
      // insert FX, fader and bus routing the lane was monitored through.
      const bounceOptions = { mixerTracks, includeMixerFx: true };
      const { buffer, waveform, lengthBars } = await audioEngine.bounceChannelToAudioClip(
        channel,
        bpm,
        MIN_BOUNCE_BARS,
        bounceOptions,
      );
      const bufId = `bounced-clip-${Date.now()}`;
      audioEngine.setSampleBuffer(bufId, buffer);

      const newAudioClip: PlaylistClip = {
        id: `audio-bounced-${Date.now()}`,
        trackIndex: trackIdx,
        startBar: target.startBar,
        // Clip metadata mirrors the rendered audio so playback never truncates or pads the stem.
        lengthBars,
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
        const movedCoords = resolvePlaylistClipMove(
          clip,
          active.originX,
          active.originY,
          clientX,
          clientY,
          { barWidth: BAR_WIDTH, trackHeight: TRACK_HEIGHT },
          { totalBars, maxTracks: tracks.length, gridBars: DEFAULT_GRID_BARS }
        );
        const moved = movePlaylistClip(clip, movedCoords.startBar, movedCoords.trackIndex, DEFAULT_GRID_BARS, bounds);
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

    // Place new clip according to selected clip type.
    //
    // Phase 54: both branches below place a 4-bar clip at the clicked bar, so
    // both must resolve that bar against the timeline before publishing. This
    // is the path that could previously create a clip ending at bar 35 on a
    // 32-bar timeline: the pattern branch called `createPlaylistPatternClip`
    // without `bounds` (so `assertValidPlaylistClip` skipped its timeline
    // check) and the automation branch never validated at all.
    const targetChannel = resolvePlaylistTargetChannel(channels, trackIndex);
    let newClip: PlaylistClip;

    if (clipTypeToAdd === 'automation') {
      const initialTargetChannel = targetChannel || channels[0];
      newClip = {
        id: `auto-clip-${Date.now()}`,
        trackIndex,
        startBar: clampStartBarToTimeline(barIndex, AUTOMATION_CLIP_LENGTH_BARS, bounds),
        lengthBars: AUTOMATION_CLIP_LENGTH_BARS,
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
    } else {
      // Pattern.
      //
      // Phase 48: there is deliberately no `audio` branch here. The one that
      // used to exist drew a placeholder clip carrying a decorative
      // `audioWaveform` and no `audioBufferId`: silent during playback, never
      // flagged by the missing-audio surfaces, and a hard blocker for WAV and
      // stem export. Playlist audio is only ever created by a path that owns a
      // real buffer — drag/drop, recording, or bounce-in-place.
      newClip = createPlaylistPatternClip(
        trackIndex,
        clampStartBarToTimeline(barIndex, DEFAULT_PATTERN_CLIP_LENGTH_BARS, bounds),
        targetChannel,
        tracks[trackIndex],
        DEFAULT_PATTERN_CLIP_LENGTH_BARS,
        undefined,
        bounds
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
    <div id="fl-playlist-arranger" className="flex flex-col h-full bg-[var(--apex-canvas)] select-none text-[var(--apex-text-2)]">
      {/* Toast Notification */}
      {statusMessage && (
        <div className="bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] font-bold text-xs px-4 py-1 flex items-center justify-between shadow-md z-20">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{statusMessage}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]">✕</button>
        </div>
      )}

      {/* Playlist Top Toolbar */}
      <div className="h-10 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between px-3 shrink-0 gap-3">
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-1.5 text-[var(--apex-text)] font-bold text-xs uppercase tracking-wider">
            <Layers className="w-3.5 h-3.5 text-[var(--apex-accent)]" />
            <span className="hidden sm:inline">PLAYLIST SONG ARRANGER</span>
          </div>

          {/* Playlist History */}
          <div className="flex items-center gap-0.5 bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] p-0.5 rounded text-xs">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className="px-2 py-0.5 rounded-sm font-semibold text-[10px] text-[var(--apex-text)] hover:bg-[var(--apex-state-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
              title="Undo playlist edit"
            >
              Undo
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className="px-2 py-0.5 rounded-sm font-semibold text-[10px] text-[var(--apex-text)] hover:bg-[var(--apex-state-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
              title="Redo playlist edit"
            >
              Redo
            </button>
          </div>

          {/* Clip Type Picker.
              Phase 48: no "Audio Stem" option. A drawn audio clip had no audio
              behind it and deadlocked export. Real audio arrives by dropping a
              file on a lane, recording a take, or bouncing a channel. */}
          <div className="flex items-center gap-0.5 bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] p-0.5 rounded text-xs">
            <button
              onClick={() => setClipTypeToAdd('pattern')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                clipTypeToAdd === 'pattern' ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              Pattern
            </button>
            <button
              onClick={() => setClipTypeToAdd('automation')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                clipTypeToAdd === 'automation' ? 'bg-[#00e5ff] text-black shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              Automation
            </button>
          </div>

          {/* Tools */}
          <div className="flex items-center gap-0.5 bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] p-0.5 rounded text-xs">
            <button
              onClick={() => setActiveTool('place')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                activeTool === 'place' ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              Draw
            </button>
            <button
              onClick={() => setActiveTool('cut')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                activeTool === 'cut' ? 'bg-[#00e5ff] text-black shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              Slice
            </button>
            <button
              onClick={() => setActiveTool('delete')}
              className={`px-2 py-0.5 rounded-sm font-semibold transition text-[10px] ${
                activeTool === 'delete' ? 'bg-[var(--apex-danger)] text-[var(--apex-state-recording-fg)] shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
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
              className="flex items-center gap-1.5 px-2 py-1 bg-[var(--apex-panel)] hover:bg-[var(--apex-surface-3)] text-[#ffaa00] border border-[#ffaa00]/30 rounded text-xs font-bold transition shadow"
              title="Arrangement Timeline Section Markers"
            >
              <Flag className="w-3 h-3" />
              <span className="hidden md:inline">Sections ({markers.length})</span>
            </button>

            {isMarkerMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-64 bg-[var(--apex-panel)] border border-[var(--apex-border)] rounded-xl shadow-2xl p-3 z-30 space-y-3">
                <div className="flex items-center justify-between border-b border-[var(--apex-border)] pb-2">
                  <span className="text-xs font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                    <Flag className="w-3.5 h-3.5 text-[#ffaa00]" />
                    <span>TIMELINE SECTION MARKERS</span>
                  </span>
                  <button onClick={() => setIsMarkerMenuOpen(false)} className="text-[var(--apex-text-muted)] hover:text-[var(--apex-text)]">✕</button>
                </div>

                {/* Quick Add at Playhead */}
                <div className="space-y-1.5">
                  <span className="text-[10px] font-bold text-[var(--apex-text-muted)] uppercase block">QUICK ADD MARKER (BAR {currentBar})</span>
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
                <div className="space-y-1.5 border-t border-[var(--apex-border)] pt-2">
                  <span className="text-[10px] font-bold text-[var(--apex-text-muted)] uppercase block">PRESET STRUCTURES</span>
                  <div className="space-y-1">
                    {MARKER_PRESETS.map((p, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleApplyMarkerPreset(p)}
                        className="w-full text-left p-1.5 rounded bg-[var(--apex-chrome-inset)] hover:bg-[var(--apex-surface-2)] text-xs text-[var(--apex-text)] border border-[var(--apex-border)] flex items-center justify-between"
                      >
                        <span>{p.name}</span>
                        <span className="text-[9px] text-[var(--apex-text-3)]">{p.markers.length} pts</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Phase 79: the +/- buttons change the playlist timeline LENGTH
              (totalBars), they do NOT zoom horizontally. Relabel honestly
              instead of pretending to zoom. Phase 80+ will add real zoom. */}
          <div className="flex items-center gap-1 bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] p-0.5 rounded">
            <button
              onClick={() => onUpdateTotalBars(Math.max(MIN_TIMELINE_BARS, totalBars - 8))}
              className="px-1.5 py-0.5 text-[var(--apex-text-3)] hover:text-[var(--apex-text)] text-xs font-bold leading-none"
              title="Shorter timeline (−8 bars)"
              aria-label="Shorter timeline"
            >
              −
            </button>
            <span className="text-[9px] text-[var(--apex-accent)] font-mono px-1">{totalBars} Bars</span>
            <button
              onClick={() => onUpdateTotalBars(Math.min(MAX_TIMELINE_BARS, totalBars + 8))}
              className="px-1.5 py-0.5 text-[var(--apex-text-3)] hover:text-[var(--apex-text)] text-xs font-bold leading-none"
              title="Longer timeline (+8 bars)"
              aria-label="Longer timeline"
            >
              +
            </button>
          </div>

          <button
            id="add-playlist-track-btn"
            onClick={onAddTrack}
            className="flex items-center gap-1 px-2.5 py-1 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold text-[11px] rounded transition active:scale-95 shadow"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Add Track Row</span>
          </button>
        </div>
      </div>

      {/* Main Playlist Matrix */}
      <div className="flex-1 flex overflow-hidden">
        {/* Track Headers List on Left */}
        <div className="w-36 sm:w-44 bg-[var(--apex-panel)] border-r border-[var(--apex-border)] flex flex-col shrink-0">
          <div className="h-12 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] px-3 flex items-center justify-between text-[9px] font-bold text-[var(--apex-text-3)] uppercase tracking-wider">
            <span>TRACK LANES</span>
            <span>BOUNCE</span>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {tracks.map((track, idx) => (
              <div
                key={track.id}
                className="h-16 border-b border-[var(--apex-grid-line)] px-2 flex items-center justify-between bg-[var(--apex-panel)] hover:bg-[var(--apex-state-hover)] transition group"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <button
                    onClick={() => handleTrackMute(track.id)}
                    className={`w-2.5 h-2.5 rounded-full border transition shrink-0 ${
                      !track.mute 
                        ? 'bg-[#00ff88] border-[#00ff88]' 
                        : 'bg-[var(--apex-surface-3)] border-[var(--apex-border)]'
                    }`}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-bold text-[var(--apex-text)] truncate">{track.name}</span>
                    <span className="text-[8px] text-[var(--apex-text-3)] font-mono">TRACK {idx + 1}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {/* Bounce / Freeze Button */}
                  <button
                    onClick={() => handleBounceTrack(idx)}
                    className="opacity-0 group-hover:opacity-100 p-1 bg-[var(--apex-surface-2)] hover:bg-[#00ff88] hover:text-[var(--apex-state-playing-fg)] text-[var(--apex-text-muted)] rounded transition"
                    title="Bounce Channel to Audio Clip Stem"
                  >
                    <Snowflake className="w-3 h-3" />
                  </button>
                  <div className="w-1.5 h-8 rounded-xs bg-[var(--apex-accent)]" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline Clips Area */}
        <div
          ref={timelineScrollContainerRef}
          className="flex-1 flex flex-col overflow-auto custom-scrollbar bg-[var(--apex-canvas)]"
        >
          {/* Top Section Markers Ribbon */}
          <div className="flex h-5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] sticky top-0 z-20 min-w-[768px] relative">
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
                  className="hover:text-[var(--apex-danger)] opacity-60 hover:opacity-100 ml-1 text-[8px]"
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
            className={`flex h-7 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] sticky top-5 z-10 min-w-[768px] ${
              isScrubbing ? 'cursor-ew-resize bg-[var(--apex-state-pressed)]' : 'cursor-pointer'
            }`}
          >
            {Array.from({ length: totalBars }).map((_, barIdx) => {
              const isPlayHead = isPlaying && currentBar === barIdx + 1;
              return (
                <div
                  key={barIdx}
                  onClick={() => onSeekToBar && onSeekToBar(barIdx + 1)}
                  className={`w-24 h-full border-r border-[var(--apex-border)] flex items-center justify-between px-2 text-[9px] font-mono transition select-none ${
                    isPlayHead ? 'bg-[var(--apex-state-selected)] text-[var(--apex-accent)] font-bold' : 'text-[var(--apex-text-3)] hover:bg-[var(--apex-state-hover)]'
                  }`}
                >
                  <span>BAR {barIdx + 1}</span>
                  <span className="text-[7px] text-[var(--apex-text-3)]">| : : :</span>
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
                  e.currentTarget.classList.add('apex-playlist-drop-target');
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('apex-playlist-drop-target');
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('apex-playlist-drop-target');

                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    const file = e.dataTransfer.files[0];
                    if (file.type.startsWith('audio/') || file.name.endsWith('.wav') || file.name.endsWith('.mp3') || file.name.endsWith('.ogg')) {
                      const dropClientX = e.clientX;
                      const dropClientY = e.clientY;
                      const trackRect = e.currentTarget.getBoundingClientRect();
                      const container = timelineScrollContainerRef.current;
                      const containerRect = container?.getBoundingClientRect();
                      const scrollLeft = container?.scrollLeft ?? 0;
                      const scrollTop = container?.scrollTop ?? 0;
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

                        const durationBars = Math.max(1, Math.round(decoded.duration / beatsToSeconds(barsToBeats(1, LEGACY_TIME_SIGNATURE), bpm)));
                        const dropPlacement = resolvePlaylistDropPlacement(
                          dropClientX,
                          dropClientY,
                          durationBars,
                          {
                            trackLeft: trackRect.left,
                            trackTop: trackRect.top,
                            viewportLeft: containerRect?.left,
                            viewportTop: containerRect?.top,
                            scrollLeft,
                            scrollTop,
                            barWidth: BAR_WIDTH,
                            trackHeight: TRACK_HEIGHT,
                          },
                          { totalBars, gridBars: DEFAULT_GRID_BARS, maxTracks: tracks.length }
                        );

                        const newDroppedClip: PlaylistClip = {
                          id: `audio-drop-${Date.now()}`,
                          trackIndex: trackIdx,
                          startBar: dropPlacement.startBar,
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
                className="h-16 border-b border-[var(--apex-grid-line)] flex relative bg-[var(--apex-canvas)] transition-colors"
              >
                {/* 1 Bar grid slots */}
                {Array.from({ length: totalBars }).map((_, barIdx) => {
                  const isPlayheadBar = isPlaying && currentBar === barIdx + 1;
                  return (
                    <div
                      key={barIdx}
                      onClick={() => handleGridCellClick(trackIdx, barIdx)}
                      className={`w-24 h-full border-r border-[var(--apex-grid-line)] cursor-pointer transition ${
                        isPlayheadBar ? 'bg-[var(--apex-state-selected)]' : 'hover:bg-[var(--apex-state-hover)]'
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
                      className={`absolute top-1 bottom-1 border rounded-sm p-1.5 flex flex-col justify-between overflow-hidden shadow cursor-pointer transition group ${
                        isAuto 
                          ? 'bg-[#002233]/90 border-[#00e5ff] hover:bg-[#00334d]' 
                          : isAudio 
                            ? isAudioMissing
                              ? 'bg-[color-mix(in_srgb,var(--apex-danger)_18%,var(--apex-panel))] border-[var(--apex-danger)] hover:bg-[color-mix(in_srgb,var(--apex-danger)_24%,var(--apex-panel))]'
                              : 'bg-[#002b1a]/90 border-[#00ff88] hover:bg-[#003d24]'
                            : 'bg-[var(--apex-surface-2)] border-l-4 border-l-[var(--apex-accent)] border-[var(--apex-border)] hover:border-[var(--apex-accent)]'
                      } ${isSelected ? 'ring-2 ring-[var(--apex-accent)]' : ''}`}
                    >
                      {/* Top Header */}
                      <div className="flex items-center justify-between gap-1 font-bold text-[10px] truncate z-10 min-w-0">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className={`truncate ${isAuto ? 'text-[#00e5ff]' : isAudioMissing ? 'text-[var(--apex-danger)]' : isAudio ? 'text-[#00ff88]' : 'text-[var(--apex-text)]'}`}>
                            {clip.name}
                          </span>
                          {isAudioMissing && (
                            <span
                              id={`missing-audio-clip-badge-${clip.id}`}
                              role="status"
                              data-audio-unavailable="true"
                              title={audioMissingDescription}
                              className="flex items-center gap-0.5 px-1 py-[1px] rounded bg-[var(--apex-danger)] text-[var(--apex-state-recording-fg)] text-[8px] font-bold uppercase tracking-wide shrink-0"
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
                            <div className="w-full border-t border-dashed border-[color-mix(in_srgb,var(--apex-danger)_80%,transparent)]" />
                            <span className="absolute left-0 text-[8px] font-bold uppercase tracking-wide text-[var(--apex-danger)] bg-[color-mix(in_srgb,var(--apex-danger)_18%,var(--apex-panel))] pr-1">
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
                              className="flex-1 bg-[var(--apex-accent)] rounded-xs"
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
                        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-[var(--apex-state-hover)] hover:bg-[var(--apex-state-pressed)] z-30"
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
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-[var(--apex-state-hover)] hover:bg-[var(--apex-state-pressed)] z-30"
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
        <div className="apex-playlist-selection-panel bg-[var(--apex-panel)] border-t border-[var(--apex-border)] p-2.5 px-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[var(--apex-text)]">{selectedClip.name}</span>
            <span className="text-[10px] text-[var(--apex-text-3)] font-mono">({selectedClip.lengthBars} Bars)</span>
          </div>

          <div className="flex items-center gap-3">
            {selectedClip.type === 'audio' && (
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span>Fade In: <strong>{selectedClip.fadeInBars || 0}B</strong></span>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'in', -0.25)}
                  className="px-1.5 py-0.5 bg-[var(--apex-surface-3)] rounded hover:bg-[var(--apex-state-hover)]"
                >
                  -
                </button>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'in', 0.25)}
                  className="px-1.5 py-0.5 bg-[var(--apex-surface-3)] rounded hover:bg-[var(--apex-state-hover)]"
                >
                  +
                </button>

                <span className="ml-2">Fade Out: <strong>{selectedClip.fadeOutBars || 0}B</strong></span>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'out', -0.25)}
                  className="px-1.5 py-0.5 bg-[var(--apex-surface-3)] rounded hover:bg-[var(--apex-state-hover)]"
                >
                  -
                </button>
                <button
                  onClick={() => handleAdjustClipFade(selectedClip.id, 'out', 0.25)}
                  className="px-1.5 py-0.5 bg-[var(--apex-surface-3)] rounded hover:bg-[var(--apex-state-hover)]"
                >
                  +
                </button>
              </div>
            )}

            <button
              onClick={() => duplicateClip(selectedClip)}
              className="px-2 py-1 bg-[var(--apex-surface-3)] text-[var(--apex-text)] hover:bg-[var(--apex-state-hover)] rounded font-bold flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              Duplicate
            </button>

            <button
              onClick={() => deleteClip(selectedClip.id)}
              className="px-2 py-1 bg-[color-mix(in_srgb,var(--apex-danger)_20%,transparent)] text-[var(--apex-danger)] hover:bg-[color-mix(in_srgb,var(--apex-danger)_30%,transparent)] rounded font-bold flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              Delete Clip
            </button>

            <button onClick={() => selectClip(null)} className="text-[var(--apex-text-muted)] hover:text-[var(--apex-text)]">✕</button>
          </div>

          {isPlaylistClipAudioUnavailable(selectedClip) && (
            <div
              id="playlist-selected-clip-missing-audio"
              role="alert"
              data-audio-unavailable="true"
              className="w-full flex items-center gap-2 px-2 py-1 rounded bg-[color-mix(in_srgb,var(--apex-danger)_12%,var(--apex-panel))] border border-[color-mix(in_srgb,var(--apex-danger)_55%,transparent)] text-[10px] text-[var(--apex-danger)]"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--apex-danger)] shrink-0" />
              <span>{describeMissingAudioClip(selectedClip)}</span>
            </div>
          )}
        </div>
      )}

      {/* Automation Node Quick Drawer */}
      {activeAutomationClip && (
        <div className="bg-[var(--apex-panel)] border-t border-[#00e5ff]/40 p-3 flex flex-col md:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-[#00e5ff] flex items-center justify-center text-black font-bold">
              <TrendingUp className="w-3.5 h-3.5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-[var(--apex-text)]">AUTOMATION ENVELOPE: {activeAutomationClip.name}</span>
                {selectedPointIndex !== null && activeAutomationClip.automationPoints?.[selectedPointIndex] && (
                  <span className="px-1.5 py-0.5 rounded bg-[#00e5ff]/20 text-[#00e5ff] font-mono text-[10px]">
                    Point #{selectedPointIndex + 1} (X: {activeAutomationClip.automationPoints[selectedPointIndex].x.toFixed(2)}, Y: {activeAutomationClip.automationPoints[selectedPointIndex].y.toFixed(2)})
                  </span>
                )}
              </div>
              <p className="text-[10px] text-[var(--apex-text-muted)]">
                Click envelope curve to add point • Drag to move (snapped to grid) • Right-click / Del to remove point
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[var(--apex-text-muted)]">Target:</span>
            <select
              value={activeAutomationClip.automationTarget?.type || 'channel_filter_cutoff'}
              onChange={(e) => {
                const newType = e.target.value as AutomationTargetType;
                let targetId: string | number = '';
                let paramName: string | undefined;
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
                } else if (newType === 'fx_mix' || newType === 'fx_param') {
                  // Phase 81: FX slot targets. The slot list (and, for
                  // `fx_param`, the parameter list) comes from the FX contract
                  // through `fxParameterControl`, so the picker can only offer
                  // a parameter that has a real AudioParam consumer.
                  const next = buildFxAutomationTarget(newType, mixerTracks, activeAutomationClip.automationTarget);
                  targetId = next.targetId;
                  paramName = next.paramName;
                  label = next.label;
                } else {
                  targetId = 0;
                  label = 'Master Output Volume';
                }
                const updated = updatePlaylistAutomationTarget(activeAutomationClip, {
                  type: newType,
                  targetId,
                  paramName,
                  label
                });
                onUpdateClips(clips.map(c => c.id === activeAutomationClip.id ? updated : c));
              }}
              className="bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] text-[var(--apex-text)] text-xs rounded px-2 py-1 font-bold"
            >
              <option value="channel_filter_cutoff">Channel Filter Cutoff (Hz)</option>
              <option value="channel_vol">Channel Volume (0 - 100%)</option>
              <option value="channel_pan">Channel Panning (L/R)</option>
              <option value="mixer_vol">Mixer Insert Volume</option>
              <option value="mixer_pan">Mixer Insert Panning</option>
              <option value="fx_param">FX Slot Parameter</option>
              <option value="fx_mix">FX Slot Wet/Dry Mix</option>
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
                className="bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] text-[var(--apex-text)] text-xs rounded px-2 py-1 font-bold max-w-[130px] truncate"
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
                className="bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] text-[var(--apex-text)] text-xs rounded px-2 py-1 font-bold max-w-[130px] truncate"
              >
                {mixerTracks.map(trk => (
                  <option key={trk.id} value={trk.id}>{trk.name} (#{trk.id})</option>
                ))}
              </select>
            )}

            {/* Phase 81: FX slot + contract parameter selectors. The candidate
                lists come from the FX contract, so a parameter that has no real
                AudioParam consumer can never be offered here. */}
            {(activeAutomationClip.automationTarget?.type === 'fx_mix' || activeAutomationClip.automationTarget?.type === 'fx_param') && (() => {
              const fxTargetType = activeAutomationClip.automationTarget!.type as FxAutomationTargetType;
              const slotTargetId = fxAutomationSlotTargetId(activeAutomationClip.automationTarget);
              const slotOptions = listFxSlotOptions(mixerTracks);
              const parsedSlot = slotTargetId.split('/');
              const slotTrackId = parsedSlot.length === 2 && parsedSlot[0] !== '' ? Number(parsedSlot[0]) : null;
              const paramOptions = listFxSlotParameterOptions(mixerTracks, slotTrackId, parsedSlot.length === 2 ? parsedSlot[1] : '');

              const publish = (draft: { type: AutomationTargetType; targetId: string | number; paramName?: string; label?: string }) => {
                const updated = updatePlaylistAutomationTarget(activeAutomationClip, draft);
                onUpdateClips(clips.map(c => c.id === activeAutomationClip.id ? updated : c));
              };

              return (
                <>
                  <select
                    value={slotTargetId}
                    onChange={(e) => publish(buildFxSlotAutomationTarget(fxTargetType, mixerTracks, e.target.value, activeAutomationClip.automationTarget))}
                    className="bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] text-[var(--apex-text)] text-xs rounded px-2 py-1 font-bold max-w-[160px] truncate"
                    title="FX slot this envelope drives"
                  >
                    {slotOptions.length === 0 && <option value="">— no effect slots —</option>}
                    {!slotOptions.some(option => option.targetId === slotTargetId) && slotTargetId !== '' && (
                      <option value={slotTargetId}>{'— missing FX slot —'}</option>
                    )}
                    {slotOptions.map(option => (
                      <option key={option.targetId} value={option.targetId}>{option.label}</option>
                    ))}
                  </select>

                  {fxTargetType === 'fx_param' && (
                    <select
                      value={activeAutomationClip.automationTarget?.paramName ?? ''}
                      onChange={(e) => {
                        const draft = buildFxParamAutomationTarget(mixerTracks, slotTargetId, e.target.value);
                        if (draft) publish(draft);
                      }}
                      className="bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] text-[var(--apex-text)] text-xs rounded px-2 py-1 font-bold max-w-[190px] truncate"
                      title="Contract parameter this envelope drives"
                    >
                      {paramOptions.length === 0 && <option value="">— no automatable parameter —</option>}
                      {paramOptions.map(option => (
                        <option key={option.paramId} value={option.paramId}>
                          {`${option.paramLabel} (${formatFxParameterRange(option)})`}
                        </option>
                      ))}
                    </select>
                  )}

                  {fxTargetType === 'fx_param' && paramOptions.length === 0 && (
                    <span className="text-[10px] text-[var(--apex-text-3)] italic">
                      This effect bakes its parameters at chain build; only its wet/dry mix is automatable.
                    </span>
                  )}
                </>
              );
            })()}

            <button
              onClick={() => {
                // Resolve a collision-free insert position (widest-gap midpoint,
                // value on the envelope) so Add Node always adds on fresh clips
                // whose template already has a node at the center.
                const pos = resolveAddNodePosition(activeAutomationClip.automationPoints || []);
                handleAddAutomationPoint(activeAutomationClip.id, pos.x, pos.y);
              }}
              className="px-2.5 py-1 bg-[var(--apex-surface-3)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text)] rounded font-bold"
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
                  ? 'bg-[color-mix(in_srgb,var(--apex-danger)_14%,var(--apex-panel))] hover:bg-[color-mix(in_srgb,var(--apex-danger)_22%,var(--apex-panel))] text-[var(--apex-danger)] border border-[color-mix(in_srgb,var(--apex-danger)_45%,transparent)]'
                  : 'bg-[var(--apex-surface-2)] text-[var(--apex-text-3)] cursor-not-allowed'
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
              className="p-1 text-[var(--apex-text-muted)] hover:text-[var(--apex-text)] rounded"
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
