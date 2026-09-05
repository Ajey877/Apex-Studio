import type { ProjectState } from '../types/daw';
import { normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';

export const DEFAULT_HISTORY_MAX_ENTRIES = 50;

export interface HistoryEntry {
  state: ProjectState;
  label: string;
}

export interface ProjectHistory {
  readonly present: ProjectState;
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  commit(nextState: ProjectState, label: string): ProjectHistory;
  undo(): ProjectHistory;
  redo(): ProjectHistory;
  reset(state: ProjectState): ProjectHistory;
}

/**
 * Turns a ProjectState into the same document representation used by project
 * persistence. Binary/session-only fields are removed and document IDs are
 * preserved as references.
 */
export const sanitizeProjectSnapshot = (state: ProjectState): ProjectState => {
  const normalized = normalizeProjectState(state);
  return JSON.parse(serializeProjectState(normalized)).state as ProjectState;
};

const getSemanticComparable = (state: ProjectState): string => {
  const snapshot = sanitizeProjectSnapshot(state);
  return JSON.stringify({
    ...snapshot,
    meta: {
      ...snapshot.meta,
      // updated is persistence metadata, not an editing operation by itself.
      updated: 0
    }
  });
};

const areSemanticallyEqual = (left: ProjectState, right: ProjectState): boolean =>
  getSemanticComparable(left) === getSemanticComparable(right);

const createEntry = (state: ProjectState, label: string): HistoryEntry => ({
  state: sanitizeProjectSnapshot(state),
  label
});

const clampMaxEntries = (maxEntries: number): number => {
  if (!Number.isFinite(maxEntries)) return DEFAULT_HISTORY_MAX_ENTRIES;
  return Math.max(1, Math.floor(maxEntries));
};

const trimPast = (past: HistoryEntry[], maxEntries: number): HistoryEntry[] =>
  past.length > maxEntries ? past.slice(past.length - maxEntries) : past;

const createHistoryState = (
  present: ProjectState,
  past: HistoryEntry[],
  future: HistoryEntry[],
  maxEntries: number
): ProjectHistory => {
  const snapshot = sanitizeProjectSnapshot(present);
  const safePast = trimPast(past.map(entry => createEntry(entry.state, entry.label)), maxEntries);
  const safeFuture = future.map(entry => createEntry(entry.state, entry.label));

  return {
    present: snapshot,
    past: safePast,
    future: safeFuture,
    canUndo: safePast.length > 0,
    canRedo: safeFuture.length > 0,
    commit(nextState, label) {
      const nextSnapshot = sanitizeProjectSnapshot(nextState);
      if (areSemanticallyEqual(snapshot, nextSnapshot)) return this;

      const nextPast = trimPast([...safePast, createEntry(snapshot, label)], maxEntries);
      return createHistoryState(nextSnapshot, nextPast, [], maxEntries);
    },
    undo() {
      if (safePast.length === 0) return this;
      const previousEntry = safePast[safePast.length - 1];
      const remainingPast = safePast.slice(0, -1);
      const nextFuture = [createEntry(snapshot, previousEntry.label), ...safeFuture];
      return createHistoryState(previousEntry.state, remainingPast, nextFuture, maxEntries);
    },
    redo() {
      if (safeFuture.length === 0) return this;
      const nextEntry = safeFuture[0];
      const remainingFuture = safeFuture.slice(1);
      const nextPast = trimPast([...safePast, createEntry(snapshot, nextEntry.label)], maxEntries);
      return createHistoryState(nextEntry.state, nextPast, remainingFuture, maxEntries);
    },
    reset(state) {
      return createHistory(state, maxEntries);
    }
  };
};

export const createHistory = (
  initialState: ProjectState,
  maxEntries = DEFAULT_HISTORY_MAX_ENTRIES
): ProjectHistory => {
  const safeMaxEntries = clampMaxEntries(maxEntries);
  return createHistoryState(initialState, [], [], safeMaxEntries);
};
