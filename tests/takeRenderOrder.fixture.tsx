/**
 * Active-take paint-order fixture (take comping regression).
 *
 * Mounts the REAL PlaylistArranger with a two-take comping group at bars 5–6
 * plus one unrelated pattern clip, exactly the reported defect scenario:
 * Take 2 (recorded last, later in the persisted array) is active by default;
 * the buttons drive the REAL `selectActiveTake` — the same call
 * TakeCompingModal's `onSelectActiveTake` makes in App.tsx.
 *
 * `browser-tests/takeRenderOrder.spec.ts` measures the browser's own hit
 * testing (`document.elementFromPoint`) over the take overlap to prove which
 * clip paints on top, and clicks the overlap to prove which clip the click
 * selects. The readouts below pin that the persisted clip order never changes:
 *
 *   #active-take-display     active take number (1-based) for the group
 *   #selected-clip-display   clip id published through onSelectedClipIdChange
 *   #persisted-order-display JSON of the stored `playlistClips` id order
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlaylistArranger } from '../src/components/PlaylistArranger';
import { resolveActiveTakeIndex, selectActiveTake } from '../src/audio/takeLaneManager';
import type { PlaylistClip, PlaylistTrack } from '../src/types/daw';
import '../src/index.css';
import '../src/uiAudit.css';

const GROUP_ID = 'take-group-fixture';

const tracks: PlaylistTrack[] = [
  { id: 1, name: 'Vocal', color: '#00ff88', volume: 1, pan: 0, mute: false, solo: false },
];

/** Persisted order: the plain clip, then Take 1, then Take 2 (recording order).
    Take 2 carries the default-active selection, like a fresh second pass. */
const initialClips: PlaylistClip[] = [
  {
    id: 'plain-clip', trackIndex: 0, startBar: 0, lengthBars: 2,
    type: 'pattern', color: '#00e5ff', name: 'Intro Pattern',
  },
  {
    id: 'take-1', trackIndex: 0, startBar: 4, lengthBars: 2,
    type: 'audio', color: '#00ff88', name: 'Vocal Take 1',
    audioBufferId: 'fixture-buffer-1', audioName: 'take_1.wav',
    audioWaveform: Array(32).fill(0.5),
    takeGroupId: GROUP_ID, takeIndex: 0, activeTakeIndex: 1,
  },
  {
    id: 'take-2', trackIndex: 0, startBar: 4, lengthBars: 2,
    type: 'audio', color: '#00ff88', name: 'Vocal Take 2',
    audioBufferId: 'fixture-buffer-2', audioName: 'take_2.wav',
    audioWaveform: Array(32).fill(0.4),
    takeGroupId: GROUP_ID, takeIndex: 1, activeTakeIndex: 1,
  },
];

function Fixture() {
  const [clips, setClips] = useState<PlaylistClip[]>(initialClips);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // Same call App.tsx makes from TakeCompingModal's onSelectActiveTake.
  const selectTake = (takeIndex: number) => {
    setClips(current => selectActiveTake(current, GROUP_ID, takeIndex));
  };

  const activeTake = resolveActiveTakeIndex(clips, GROUP_ID);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div data-testid="take-fixture-controls" style={{ display: 'flex', gap: 12, padding: 8, alignItems: 'center' }}>
        <button data-select-take="0" onClick={() => selectTake(0)}>Select Take 1</button>
        <button data-select-take="1" onClick={() => selectTake(1)}>Select Take 2</button>
        <span>Active take: <strong id="active-take-display">{activeTake === null ? 'none' : activeTake + 1}</strong></span>
        <span>Selected clip: <strong id="selected-clip-display">{selectedClipId ?? 'none'}</strong></span>
        <output id="persisted-order-display">{JSON.stringify(clips.map(c => c.id))}</output>
      </div>
      <PlaylistArranger
        totalBars={16} onUpdateTotalBars={() => {}}
        tracks={tracks} clips={clips} patterns={[]} channels={[]} bpm={120}
        currentBar={1} isPlaying={false}
        onUpdateTracks={() => {}} onUpdateClips={setClips} onAddTrack={() => {}}
        onSelectedClipIdChange={setSelectedClipId}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
