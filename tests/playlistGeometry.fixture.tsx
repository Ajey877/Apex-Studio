import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlaylistArranger } from '../src/components/PlaylistArranger';
import type { PlaylistClip, PlaylistTrack } from '../src/types/daw';
import '../src/index.css';
import '../src/uiAudit.css';

// Mount the real arranger with controlled clip props. Browser tests inspect its
// computed layout and use its actual pointer/undo/redo callbacks, not a mocked
// version of the rendered clip or a coordinate-only resolver test.
const tracks: PlaylistTrack[] = [{
  id: 1, name: 'Audio 1', color: '#00ff88', volume: 1, pan: 0, mute: false, solo: false
}];
const initialBar = new URLSearchParams(window.location.search).get('start') === '4' ? 4 : 28;
const initialClips: PlaylistClip[] = [{
  id: 'fixture-audio', trackIndex: 0, startBar: initialBar, lengthBars: 4,
  type: 'audio', audioBufferId: 'fixture-buffer', audioName: 'Fixture Audio',
  name: 'Fixture Audio', color: '#00ff88', audioWaveform: Array(32).fill(0.5)
}];

function Fixture() {
  const [clips, setClips] = useState(initialClips);
  const [historyVersion, setHistoryVersion] = useState(0);
  const clipsRef = useRef(clips);
  const past = useRef<PlaylistClip[][]>([]);
  const future = useRef<PlaylistClip[][]>([]);
  const interactionStart = useRef<PlaylistClip[] | null>(null);

  const update = (next: PlaylistClip[]) => {
    if (!interactionStart.current) {
      past.current.push(clipsRef.current);
      future.current = [];
      setHistoryVersion(version => version + 1);
    }
    clipsRef.current = next;
    setClips(next);
  };
  const undo = () => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(clipsRef.current);
    clipsRef.current = previous;
    setClips(previous);
    setHistoryVersion(version => version + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(clipsRef.current);
    clipsRef.current = next;
    setClips(next);
    setHistoryVersion(version => version + 1);
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <output id="fixture-project-clips" hidden>{JSON.stringify(clips)}</output>
      <PlaylistArranger
        tracks={tracks} clips={clips} patterns={[]} channels={[]} bpm={130}
        currentBar={1} isPlaying={false}
        onUpdateTracks={() => {}} onUpdateClips={update} onAddTrack={() => {}}
        onPlaylistInteractionStart={() => { interactionStart.current = clipsRef.current; }}
        onPlaylistInteractionEnd={() => {
          if (interactionStart.current && interactionStart.current !== clipsRef.current) {
            past.current.push(interactionStart.current);
            future.current = [];
            setHistoryVersion(version => version + 1);
          }
          interactionStart.current = null;
        }}
        canUndo={historyVersion >= 0 && past.current.length > 0}
        canRedo={future.current.length > 0}
        onUndo={undo} onRedo={redo}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
