import type { ArrangementMarker, PlaylistClip, PlaylistTrack, ProjectState } from '../types/daw';
import { createHistory, type ProjectHistory } from './projectHistory';

export interface PlaylistDocument {
  playlistTracks: PlaylistTrack[];
  playlistClips: PlaylistClip[];
  markers: ArrangementMarker[];
}

export const createPlaylistDocument = (
  playlistTracks: PlaylistTrack[],
  playlistClips: PlaylistClip[],
  markers: ArrangementMarker[] = []
): PlaylistDocument => structuredClone({ playlistTracks, playlistClips, markers });

export const applyPlaylistDocument = (
  projectState: ProjectState,
  document: PlaylistDocument
): ProjectState => ({
  ...projectState,
  playlistTracks: structuredClone(document.playlistTracks),
  playlistClips: structuredClone(document.playlistClips),
  markers: structuredClone(document.markers)
});

const projectStateWithPlaylist = (baseline: ProjectState, document: PlaylistDocument): ProjectState =>
  applyPlaylistDocument(baseline, document);

const getPlaylistDocument = (state: ProjectState): PlaylistDocument =>
  createPlaylistDocument(state.playlistTracks, state.playlistClips, state.markers || []);

export interface PlaylistHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly pastLength: number;
  readonly futureLength: number;
  readonly document: PlaylistDocument;
  commit(nextState: ProjectState, label: string): PlaylistHistory;
  undo(currentState: ProjectState): { history: PlaylistHistory; state: ProjectState };
  redo(currentState: ProjectState): { history: PlaylistHistory; state: ProjectState };
  reset(state: ProjectState): PlaylistHistory;
}

const createPlaylistHistoryState = (
  baseline: ProjectState,
  history: ProjectHistory
): PlaylistHistory => ({
  canUndo: history.canUndo,
  canRedo: history.canRedo,
  pastLength: history.past.length,
  futureLength: history.future.length,
  document: getPlaylistDocument(history.present),
  commit(nextState, label) {
    const nextDocument = getPlaylistDocument(nextState);
    const nextHistory = history.commit(projectStateWithPlaylist(baseline, nextDocument), label);
    return nextHistory === history ? this : createPlaylistHistoryState(baseline, nextHistory);
  },
  undo(currentState) {
    const nextHistory = history.undo();
    if (nextHistory === history) return { history: this, state: currentState };
    return {
      history: createPlaylistHistoryState(baseline, nextHistory),
      state: applyPlaylistDocument(currentState, getPlaylistDocument(nextHistory.present))
    };
  },
  redo(currentState) {
    const nextHistory = history.redo();
    if (nextHistory === history) return { history: this, state: currentState };
    return {
      history: createPlaylistHistoryState(baseline, nextHistory),
      state: applyPlaylistDocument(currentState, getPlaylistDocument(nextHistory.present))
    };
  },
  reset(state) {
    return createPlaylistHistoryState(state, createHistory(projectStateWithPlaylist(state, getPlaylistDocument(state))));
  }
});

export const createPlaylistHistory = (initialState: ProjectState): PlaylistHistory =>
  createPlaylistHistoryState(
    structuredClone(initialState),
    createHistory(projectStateWithPlaylist(initialState, getPlaylistDocument(initialState)))
  );
