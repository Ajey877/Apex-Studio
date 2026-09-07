from pathlib import Path

PLAYLIST = Path('src/components/PlaylistArranger.tsx')
PACKAGE = Path('package.json')

s = PLAYLIST.read_text()

def once(old: str, new: str, name: str) -> None:
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{name}: expected 1 match, found {count}')
    s = s.replace(old, new, 1)

once("import React, { useState, useRef } from 'react';", "import React, { useEffect, useState, useRef } from 'react';", 'react import')
once("  AudioWaveform\n} from 'lucide-react';", "  AudioWaveform,\n  Undo2,\n  Redo2\n} from 'lucide-react';", 'icons import')
once("import { audioEngine } from '../audio/audioEngine';", "import { audioEngine } from '../audio/audioEngine';\nimport { createDefaultProjectState } from '../state/projectState';\nimport { createPlaylistDocument, createPlaylistHistory, type PlaylistDocument, type PlaylistHistory } from '../state/playlistHistory';", 'history imports')
once("  onUpdateTracks,\n  onUpdateClips,\n  onUpdateMarkers,\n  onAddTrack,", "  onUpdateTracks: onUpdateTracksProp,\n  onUpdateClips: onUpdateClipsProp,\n  onUpdateMarkers: onUpdateMarkersProp,\n  onAddTrack: onAddTrackProp,", 'prop aliases')

needle = "  const bounds = { totalBars, maxTracks: tracks.length };"
insert = """  const bounds = { totalBars, maxTracks: tracks.length };

  const makeHistoryState = (document: PlaylistDocument) => {
    const state = createDefaultProjectState();
    state.playlistTracks = structuredClone(document.playlistTracks);
    state.playlistClips = structuredClone(document.playlistClips);
    state.markers = structuredClone(document.markers);
    return state;
  };

  const initialPlaylistDocument = createPlaylistDocument(tracks, clips, markers);
  const [playlistHistory, setPlaylistHistory] = useState<PlaylistHistory>(() =>
    createPlaylistHistory(makeHistoryState(initialPlaylistDocument))
  );
  const playlistHistoryRef = useRef(playlistHistory);
  const latestDocumentRef = useRef<PlaylistDocument>(initialPlaylistDocument);
  const interactionStartDocumentRef = useRef<PlaylistDocument | null>(null);
  const interactionPreviewDocumentRef = useRef<PlaylistDocument | null>(null);
  const pendingTrackEditLabelRef = useRef<string | null>(null);

  const documentsEqual = (a: PlaylistDocument, b: PlaylistDocument) =>
    JSON.stringify(a) === JSON.stringify(b);

  const commitPlaylistDocument = (document: PlaylistDocument, label: string) => {
    const nextHistory = playlistHistoryRef.current.commit(makeHistoryState(document), label);
    playlistHistoryRef.current = nextHistory;
    setPlaylistHistory(nextHistory);
  };

  const onUpdateTracks = (nextTracks: PlaylistTrack[]) => {
    const document = createPlaylistDocument(
      nextTracks,
      latestDocumentRef.current.playlistClips,
      latestDocumentRef.current.markers
    );
    latestDocumentRef.current = document;
    onUpdateTracksProp(nextTracks);
    if (interactionStartDocumentRef.current) {
      interactionPreviewDocumentRef.current = document;
      return;
    }
    commitPlaylistDocument(document, 'Edit Playlist Track');
  };

  const onUpdateClips = (nextClips: PlaylistClip[]) => {
    const document = createPlaylistDocument(
      latestDocumentRef.current.playlistTracks,
      nextClips,
      latestDocumentRef.current.markers
    );
    latestDocumentRef.current = document;
    onUpdateClipsProp(nextClips);
    if (interactionStartDocumentRef.current) {
      interactionPreviewDocumentRef.current = document;
      return;
    }
    commitPlaylistDocument(document, 'Edit Playlist Clip');
  };

  const onUpdateMarkers = (nextMarkers: ArrangementMarker[]) => {
    const document = createPlaylistDocument(
      latestDocumentRef.current.playlistTracks,
      latestDocumentRef.current.playlistClips,
      nextMarkers
    );
    latestDocumentRef.current = document;
    onUpdateMarkersProp?.(nextMarkers);
    commitPlaylistDocument(document, 'Edit Arrangement Marker');
  };

  const onAddTrack = () => {
    pendingTrackEditLabelRef.current = 'Add Playlist Track';
    onAddTrackProp();
  };

  const undoPlaylistEdit = () => {
    const result = playlistHistoryRef.current.undo(makeHistoryState(latestDocumentRef.current));
    if (result.history === playlistHistoryRef.current) return;
    const document = createPlaylistDocument(
      result.state.playlistTracks,
      result.state.playlistClips,
      result.state.markers || []
    );
    latestDocumentRef.current = document;
    playlistHistoryRef.current = result.history;
    setPlaylistHistory(result.history);
    onUpdateTracksProp(document.playlistTracks);
    onUpdateClipsProp(document.playlistClips);
    onUpdateMarkersProp?.(document.markers);
  };

  const redoPlaylistEdit = () => {
    const result = playlistHistoryRef.current.redo(makeHistoryState(latestDocumentRef.current));
    if (result.history === playlistHistoryRef.current) return;
    const document = createPlaylistDocument(
      result.state.playlistTracks,
      result.state.playlistClips,
      result.state.markers || []
    );
    latestDocumentRef.current = document;
    playlistHistoryRef.current = result.history;
    setPlaylistHistory(result.history);
    onUpdateTracksProp(document.playlistTracks);
    onUpdateClipsProp(document.playlistClips);
    onUpdateMarkersProp?.(document.markers);
  };

  useEffect(() => {
    const incoming = createPlaylistDocument(tracks, clips, markers);
    if (documentsEqual(incoming, latestDocumentRef.current)) return;
    latestDocumentRef.current = incoming;
    const pendingLabel = pendingTrackEditLabelRef.current;
    pendingTrackEditLabelRef.current = null;
    if (pendingLabel) {
      commitPlaylistDocument(incoming, pendingLabel);
    } else {
      const resetHistory = createPlaylistHistory(makeHistoryState(incoming));
      playlistHistoryRef.current = resetHistory;
      setPlaylistHistory(resetHistory);
    }
  }, [tracks, clips, markers]);"""
once(needle, insert, 'history state')

once("    didMoveRef.current = false;\n    event.currentTarget.setPointerCapture(event.pointerId);", "    didMoveRef.current = false;\n    interactionStartDocumentRef.current = latestDocumentRef.current;\n    interactionPreviewDocumentRef.current = latestDocumentRef.current;\n    event.currentTarget.setPointerCapture(event.pointerId);", 'interaction start')
once("    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) {\n      event.currentTarget.releasePointerCapture(event.pointerId);\n    }\n    setInteraction(null);", "    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) {\n      event.currentTarget.releasePointerCapture(event.pointerId);\n    }\n    if (didMoveRef.current && interactionStartDocumentRef.current && interactionPreviewDocumentRef.current) {\n      if (!documentsEqual(interactionStartDocumentRef.current, interactionPreviewDocumentRef.current)) {\n        const label = interaction?.kind === 'move' ? 'Move Playlist Clip' : 'Resize Playlist Clip';\n        commitPlaylistDocument(interactionPreviewDocumentRef.current, label);\n      }\n    }\n    interactionStartDocumentRef.current = null;\n    interactionPreviewDocumentRef.current = null;\n    setInteraction(null);", 'interaction end')

marker = "        {/* Section Markers & Zoom & Add Track */}"
toolbar = """        <div className=\"flex items-center gap-1 bg-[#121214] border border-[#333336] p-0.5 rounded\" aria-label=\"Playlist history\">\n          <button\n            type=\"button\"\n            onClick={undoPlaylistEdit}\n            disabled={!playlistHistory.canUndo}\n            title=\"Undo last playlist edit\"\n            className={`px-2 py-0.5 rounded-sm font-semibold text-[10px] flex items-center gap-1 ${playlistHistory.canUndo ? 'text-white hover:bg-[#222225]' : 'text-[#444] cursor-not-allowed'}`}\n          >\n            <Undo2 className=\"w-3 h-3\" />Undo\n          </button>\n          <button\n            type=\"button\"\n            onClick={redoPlaylistEdit}\n            disabled={!playlistHistory.canRedo}\n            title=\"Redo last playlist edit\"\n            className={`px-2 py-0.5 rounded-sm font-semibold text-[10px] flex items-center gap-1 ${playlistHistory.canRedo ? 'text-white hover:bg-[#222225]' : 'text-[#444] cursor-not-allowed'}`}\n          >\n            <Redo2 className=\"w-3 h-3\" />Redo\n          </button>\n        </div>\n\n        {/* Section Markers & Zoom & Add Track */}"""
once(marker, toolbar, 'history toolbar')

PLAYLIST.write_text(s)

pkg = PACKAGE.read_text()
old_test = '"test:audio": "tsx --test src/audio/*.test.ts src/audio/automation/*.test.ts src/state/projectPersistence.test.ts src/utils/*.test.ts"'
new_test = '"test:audio": "tsx --test src/audio/*.test.ts src/audio/automation/*.test.ts src/state/projectPersistence.test.ts src/state/playlistHistory.test.ts src/utils/*.test.ts"'
if pkg.count(old_test) != 1:
    raise SystemExit(f'package test script: expected 1 match, found {pkg.count(old_test)}')
PACKAGE.write_text(pkg.replace(old_test, new_test, 1))

print('Phase 8B PlaylistArranger integration applied')
