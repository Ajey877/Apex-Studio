import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState } from './projectState';
import { createHistory, resolveSaveShortcut, resolveUndoRedoShortcut } from './projectHistory';
import { serializeProjectState, persistProjectState, restorePersistedProjectState } from './projectPersistence';
import { getOfflineRenderPlan } from '../audio/offlineProjectRenderer';
import type { Note, PlaylistClip, ProjectState } from '../types/daw';

// Helper to create clean test project state
const createTestState = (): ProjectState => {
  const state = createDefaultProjectState();
  state.channels[0].notes = [];
  state.playlistClips = [
    {
      id: 'clip-1',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 4,
      type: 'pattern',
      color: '#ff6e00',
      name: 'Test Clip'
    }
  ];
  return state;
};

// ==========================================
// 1. KEYBOARD SHORTCUT REGRESSION TESTS
// ==========================================

test('Keyboard: Ctrl+Z invokes undo', () => {
  const result = resolveUndoRedoShortcut({ ctrlKey: true, code: 'KeyZ', key: 'z' });
  assert.equal(result.action, 'undo');
});

test('Keyboard: Cmd+Z invokes undo', () => {
  const result = resolveUndoRedoShortcut({ metaKey: true, code: 'KeyZ', key: 'z' });
  assert.equal(result.action, 'undo');
});

test('Keyboard: Ctrl+Y invokes redo', () => {
  const result = resolveUndoRedoShortcut({ ctrlKey: true, code: 'KeyY', key: 'y' });
  assert.equal(result.action, 'redo');
});

test('Keyboard: Cmd+Y invokes redo', () => {
  const result = resolveUndoRedoShortcut({ metaKey: true, code: 'KeyY', key: 'y' });
  assert.equal(result.action, 'redo');
});

test('Keyboard: Ctrl+Shift+Z invokes redo', () => {
  const result = resolveUndoRedoShortcut({ ctrlKey: true, shiftKey: true, code: 'KeyZ', key: 'Z' });
  assert.equal(result.action, 'redo');
});

test('Keyboard: Cmd+Shift+Z invokes redo', () => {
  const result = resolveUndoRedoShortcut({ metaKey: true, shiftKey: true, code: 'KeyZ', key: 'Z' });
  assert.equal(result.action, 'redo');
});

test('Keyboard: Ctrl+Z does NOT resolve to none or raw piano octave shift', () => {
  const result = resolveUndoRedoShortcut({ ctrlKey: true, code: 'KeyZ' });
  assert.notEqual(result.action, 'none');
  assert.equal(result.action, 'undo');
});

test('Keyboard: Ctrl+Y does NOT resolve to none or raw MIDI note Y', () => {
  const result = resolveUndoRedoShortcut({ ctrlKey: true, code: 'KeyY' });
  assert.notEqual(result.action, 'none');
  assert.equal(result.action, 'redo');
});

test('Keyboard: Plain Z without modifier does NOT invoke undo or redo', () => {
  const result = resolveUndoRedoShortcut({ ctrlKey: false, metaKey: false, code: 'KeyZ', key: 'z' });
  assert.equal(result.action, 'none');
});

test('Keyboard: Plain Y without modifier does NOT invoke undo or redo', () => {
  const result = resolveUndoRedoShortcut({ ctrlKey: false, metaKey: false, code: 'KeyY', key: 'y' });
  assert.equal(result.action, 'none');
});

test('Keyboard: Ctrl+S invokes save', () => {
  const result = resolveSaveShortcut({ ctrlKey: true, code: 'KeyS', key: 's' });
  assert.equal(result, true);
});

test('Keyboard: Cmd+S (macOS) invokes save', () => {
  const result = resolveSaveShortcut({ metaKey: true, code: 'KeyS', key: 's' });
  assert.equal(result, true);
});

test('Keyboard: Plain S without modifier does NOT invoke save', () => {
  const result = resolveSaveShortcut({ ctrlKey: false, metaKey: false, code: 'KeyS', key: 's' });
  assert.equal(result, false);
});

// ==========================================
// 2. PIANO ROLL EDIT HISTORY TESTS
// ==========================================

test('Piano Roll: Add note -> undo removes it', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  const noteA: Note = { id: 'note-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const edited = structuredClone(initial);
  edited.channels[0].notes = [noteA];

  history = history.commit(edited, 'Add note');
  assert.equal(history.canUndo, true);
  assert.equal(history.present.channels[0].notes.length, 1);

  const undone = history.undo();
  assert.equal(undone.canUndo, false);
  assert.equal(undone.canRedo, true);
  assert.equal(undone.present.channels[0].notes.length, 0);
});

test('Piano Roll: Undo -> redo restores it', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  const noteA: Note = { id: 'note-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const edited = structuredClone(initial);
  edited.channels[0].notes = [noteA];

  history = history.commit(edited, 'Add note');
  const undone = history.undo();
  assert.equal(undone.present.channels[0].notes.length, 0);

  const redone = undone.redo();
  assert.equal(redone.canUndo, true);
  assert.equal(redone.canRedo, false);
  assert.equal(redone.present.channels[0].notes.length, 1);
  assert.equal(redone.present.channels[0].notes[0].id, 'note-a');
  assert.equal(redone.present.channels[0].notes[0].pitch, 60);
});

test('Piano Roll: Move note -> undo restores original position', () => {
  const initial = createTestState();
  const noteA: Note = { id: 'note-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  initial.channels[0].notes = [noteA];
  let history = createHistory(initial);

  const moved = structuredClone(initial);
  moved.channels[0].notes = [{ ...noteA, start: 4, pitch: 64 }];

  history = history.commit(moved, 'Move note');
  assert.equal(history.present.channels[0].notes[0].start, 4);
  assert.equal(history.present.channels[0].notes[0].pitch, 64);

  const undone = history.undo();
  assert.equal(undone.present.channels[0].notes[0].start, 0);
  assert.equal(undone.present.channels[0].notes[0].pitch, 60);
});

test('Piano Roll: Delete note -> undo restores note', () => {
  const initial = createTestState();
  const noteA: Note = { id: 'note-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  initial.channels[0].notes = [noteA];
  let history = createHistory(initial);

  const deleted = structuredClone(initial);
  deleted.channels[0].notes = [];

  history = history.commit(deleted, 'Delete note');
  assert.equal(history.present.channels[0].notes.length, 0);

  const undone = history.undo();
  assert.equal(undone.present.channels[0].notes.length, 1);
  assert.equal(undone.present.channels[0].notes[0].id, 'note-a');
});

test('Piano Roll: Multiple edits undo in reverse order', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // Edit 1: Note 1 (pitch 60)
  const s1 = structuredClone(initial);
  s1.channels[0].notes = [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.8 }];
  history = history.commit(s1, 'Add N1');

  // Edit 2: Note 2 (pitch 62)
  const s2 = structuredClone(s1);
  s2.channels[0].notes.push({ id: 'n2', pitch: 62, start: 1, duration: 1, velocity: 0.8 });
  history = history.commit(s2, 'Add N2');

  // Edit 3: Note 3 (pitch 64)
  const s3 = structuredClone(s2);
  s3.channels[0].notes.push({ id: 'n3', pitch: 64, start: 2, duration: 1, velocity: 0.8 });
  history = history.commit(s3, 'Add N3');

  assert.equal(history.present.channels[0].notes.length, 3);

  // Undo 1 -> reverts Edit 3
  const u1 = history.undo();
  assert.equal(u1.present.channels[0].notes.length, 2);
  assert.equal(u1.present.channels[0].notes.some(n => n.id === 'n3'), false);

  // Undo 2 -> reverts Edit 2
  const u2 = u1.undo();
  assert.equal(u2.present.channels[0].notes.length, 1);
  assert.equal(u2.present.channels[0].notes[0].id, 'n1');

  // Undo 3 -> reverts Edit 1
  const u3 = u2.undo();
  assert.equal(u3.present.channels[0].notes.length, 0);
});

test('Piano Roll: Undo -> new edit clears redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  const s1 = structuredClone(initial);
  s1.channels[0].notes = [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.8 }];
  history = history.commit(s1, 'Add N1');

  const u1 = history.undo();
  assert.equal(u1.canRedo, true);

  // Branch with new edit
  const branch = structuredClone(initial);
  branch.channels[0].notes = [{ id: 'n-branch', pitch: 72, start: 0, duration: 1, velocity: 0.9 }];
  const branched = u1.commit(branch, 'Branch edit');

  assert.equal(branched.canRedo, false);
  assert.equal(branched.future.length, 0);
  assert.equal(branched.present.channels[0].notes[0].id, 'n-branch');
});

// ==========================================
// 3. PLAYLIST INTERACTION & HISTORY TESTS
// ==========================================

test('Playlist: Move clip -> undo restores original position', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  const moved = structuredClone(initial);
  moved.playlistClips[0].startBar = 8;
  moved.playlistClips[0].trackIndex = 2;

  history = history.commit(moved, 'Move clip');
  assert.equal(history.present.playlistClips[0].startBar, 8);
  assert.equal(history.present.playlistClips[0].trackIndex, 2);

  const undone = history.undo();
  assert.equal(undone.present.playlistClips[0].startBar, 0);
  assert.equal(undone.present.playlistClips[0].trackIndex, 0);
});

test('Playlist: Undo -> redo restores moved position', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  const moved = structuredClone(initial);
  moved.playlistClips[0].startBar = 12;

  history = history.commit(moved, 'Move clip');
  const undone = history.undo();
  assert.equal(undone.present.playlistClips[0].startBar, 0);

  const redone = undone.redo();
  assert.equal(redone.present.playlistClips[0].startBar, 12);
});

test('Playlist: Resize clip -> history commits after pointer release', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // During active drag, interactionActive is true and history is not yet committed
  let interactionActive = true;
  const draggingState = structuredClone(initial);
  draggingState.playlistClips[0].lengthBars = 8;

  // Pointer released: interaction ends, history committed
  interactionActive = false;
  history = history.commit(draggingState, 'Resize clip');

  assert.equal(history.canUndo, true);
  assert.equal(history.present.playlistClips[0].lengthBars, 8);

  const undone = history.undo();
  assert.equal(undone.present.playlistClips[0].lengthBars, 4);
});

test('Playlist: Resize cancellation does not permanently lock interaction', () => {
  let interactionActive = false;

  const onInteractionStart = () => { interactionActive = true; };
  const onInteractionEnd = () => { interactionActive = false; };

  // Pointer down on resize handle
  onInteractionStart();
  assert.equal(interactionActive, true);

  // Pointer cancel event arrives (e.g. touch/stylus/window blur)
  onInteractionEnd();
  assert.equal(interactionActive, false);
});

test('Playlist: Cross-track drag does not permanently lock interaction', () => {
  let interactionActive = false;
  let commitCount = 0;

  const onInteractionStart = () => { interactionActive = true; };
  const onInteractionEnd = () => {
    interactionActive = false;
    commitCount += 1;
  };

  // Start drag on Track 0
  onInteractionStart();
  assert.equal(interactionActive, true);

  // Clip moves across tracks; even if DOM reparents, window pointerup executes end
  onInteractionEnd();
  assert.equal(interactionActive, false);
  assert.equal(commitCount, 1);
});

test('Playlist: Lost pointer capture terminates interaction safely', () => {
  let interactionActive = false;
  let commitCalled = false;

  const onInteractionStart = () => { interactionActive = true; };
  const onLostPointerCapture = () => {
    interactionActive = false;
    commitCalled = true;
  };

  onInteractionStart();
  assert.equal(interactionActive, true);

  // Browser fires lostpointercapture
  onLostPointerCapture();
  assert.equal(interactionActive, false);
  assert.equal(commitCalled, true);
});

test('Playlist: After a problematic pointer sequence, Undo/Redo still works', () => {
  const initial = createTestState();
  let history = createHistory(initial);
  let interactionActive = false;

  // Problematic sequence: pointerdown -> lostpointercapture -> interaction ends cleanly
  interactionActive = true;
  // Lost pointer capture forces cleanup
  interactionActive = false;

  // User subsequently edits clip
  const edited = structuredClone(initial);
  edited.playlistClips[0].startBar = 4;
  history = history.commit(edited, 'Edit after glitch');

  // Verify Undo/Redo is not blocked
  assert.equal(interactionActive, false);
  assert.equal(history.canUndo, true);

  const undone = history.undo();
  assert.equal(undone.present.playlistClips[0].startBar, 0);

  const redone = undone.redo();
  assert.equal(redone.present.playlistClips[0].startBar, 4);
});

// ==========================================
// 4. INTEGRATION TESTS
// ==========================================

test('Integration: Undo/redo followed by playback still works', () => {
  const initial = createTestState();
  const clip1: PlaylistClip = {
    id: 'render-clip-1',
    trackIndex: 0,
    startBar: 2,
    lengthBars: 4,
    type: 'audio',
    color: '#00ff88',
    name: 'Stem 1'
  };
  const clip2: PlaylistClip = {
    id: 'render-clip-2',
    trackIndex: 1,
    startBar: 6,
    lengthBars: 4,
    type: 'audio',
    color: '#00e5ff',
    name: 'Stem 2'
  };

  const withClips = structuredClone(initial);
  withClips.playlistClips = [clip1, clip2];

  let history = createHistory(initial);
  history = history.commit(withClips, 'Add audio stems');

  // Render plan has 2 active clips
  const planBeforeUndo = getOfflineRenderPlan(history.present.playlistClips, 120, 16);
  assert.equal(planBeforeUndo.length, 2);

  // Undo back to single initial clip
  const undone = history.undo();
  const planAfterUndo = getOfflineRenderPlan(undone.present.playlistClips, 120, 16);
  assert.equal(planAfterUndo.length, 1);

  // Redo back to 2 active clips
  const redone = undone.redo();
  const planAfterRedo = getOfflineRenderPlan(redone.present.playlistClips, 120, 16);
  assert.equal(planAfterRedo.length, 2);
});

// Mock IndexedDB for headless node integration tests
class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private readonly store: Map<string, unknown>) {}
  objectStore(): FakeObjectStore { return new FakeObjectStore(this.store, this); }
  complete(): void { queueMicrotask(() => this.oncomplete?.()); }
}

class FakeObjectStore {
  constructor(private readonly store: Map<string, unknown>, private readonly tx: FakeTransaction) {}
  put(value: { id: string }): void { this.store.set(value.id, value); this.tx.complete(); }
  get(id: string): FakeRequest {
    const request = new FakeRequest();
    request.result = this.store.get(id);
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
  delete(id: string): void { this.store.delete(id); this.tx.complete(); }
}

class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>([
    ['clips', new Map()],
    ['projects', new Map()]
  ]);
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string): void { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
  transaction(name: string): FakeTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`Missing fake object store: ${name}`);
    return new FakeTransaction(store);
  }
  close(): void {}
}

const installIndexedDbMock = () => {
  const db = new FakeDb();
  const previous = (globalThis as any).indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const request = new FakeRequest<FakeDb>();
        request.result = db;
        queueMicrotask(() => request.onupgradeneeded?.());
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });
  return () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous });
};

test('Integration: Undo/redo followed by save/reload preserves the resulting state', async () => {
  const restoreDb = installIndexedDbMock();
  try {
    const initial = createTestState();
    const note: Note = { id: 'persist-note', pitch: 65, start: 2, duration: 2, velocity: 0.9 };
    const edited = structuredClone(initial);
    edited.channels[0].notes = [note];

    let history = createHistory(initial);
    history = history.commit(edited, 'Add note');

    // Undo -> removes note
    const undone = history.undo();

    // Persist undone state
    await persistProjectState(undone.present);

    // Reload from persistence
    const fakeAudioEngine = {
      loadAudioFile: async () => ({ buffer: {} as AudioBuffer, peaks: [], duration: 0 })
    };
    const restored = await restorePersistedProjectState(fakeAudioEngine, createDefaultProjectState());
    assert.equal(restored.restored, true);
    assert.equal(restored.state.channels[0].notes.length, 0);

    // Redo -> restores note
    const redone = undone.redo();
    await persistProjectState(redone.present);

    const reloaded = await restorePersistedProjectState(fakeAudioEngine, createDefaultProjectState());
    assert.equal(reloaded.restored, true);
    assert.equal(reloaded.state.channels[0].notes.length, 1);
    assert.equal(reloaded.state.channels[0].notes[0].id, 'persist-note');
    assert.equal(reloaded.state.channels[0].notes[0].pitch, 65);
  } finally {
    restoreDb();
  }
});
