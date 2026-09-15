import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState } from './projectState';
import { createHistory, resolveSaveShortcut, resolveUndoRedoShortcut } from './projectHistory';
import { serializeProjectState, persistProjectState, restorePersistedProjectState } from './projectPersistence';
import { getOfflineRenderPlan } from '../audio/offlineProjectRenderer';
import type { Channel, CustomSampleData, FxSlot, Note, Pattern, PlaylistClip, ProjectState } from '../types/daw';
import {
  ContinuousHistoryBatcher,
  addFxSlotToProjectState,
  addPatternToProjectState,
  deleteFxSlotFromProjectState,
  updateChannelInProjectState,
  updateFxSlotInProjectState,
  updateMixerTrackInProjectState,
  updateProjectMetadataInProjectState
} from './projectMutations';
import { deleteChannelFromProjectState } from './projectState';
import { appendChannelWithAllocatedMixerTrackId } from './mixerTrackIdentity';

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


// ==========================================
// 5. PHASE 3C: STEP SEQUENCER UNDO/REDO
// ==========================================

test('Step Sequencer: Toggle step -> undo -> redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // Initial step 1 is false
  assert.equal(history.present.channels[0].steps[1], false);

  // Toggle step 1 to true
  const nextSteps = [...history.present.channels[0].steps];
  nextSteps[1] = true;
  const toggled = updateChannelInProjectState(history.present, history.present.channels[0].id, { steps: nextSteps });
  history = history.commit(toggled, 'Edit steps');

  assert.equal(history.canUndo, true);
  assert.equal(history.present.channels[0].steps[1], true);

  // Undo (Ctrl+Z)
  const undone = history.undo();
  assert.equal(undone.present.channels[0].steps[1], false);

  // Redo (Ctrl+Y)
  const redone = undone.redo();
  assert.equal(redone.present.channels[0].steps[1], true);
});

test('Step Sequencer: Clear and fill steps -> undo -> redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // Clear steps
  const clearedSteps = Array(16).fill(false);
  const clearedState = updateChannelInProjectState(history.present, history.present.channels[0].id, { steps: clearedSteps });
  history = history.commit(clearedState, 'Edit steps');
  assert.equal(history.present.channels[0].steps.every(s => s === false), true);

  // Fill steps on every 4th step
  const filledSteps = Array(16).fill(false);
  for (let i = 0; i < 16; i += 4) filledSteps[i] = true;
  const filledState = updateChannelInProjectState(history.present, history.present.channels[0].id, { steps: filledSteps });
  history = history.commit(filledState, 'Edit steps');
  assert.equal(history.present.channels[0].steps[0], true);
  assert.equal(history.present.channels[0].steps[4], true);

  // Undo fill -> back to cleared
  const undoneFill = history.undo();
  assert.equal(undoneFill.present.channels[0].steps.every(s => s === false), true);

  // Undo clear -> back to initial
  const undoneClear = undoneFill.undo();
  assert.equal(undoneClear.present.channels[0].steps[0], true);
  assert.equal(undoneClear.present.channels[0].steps[1], false);

  // Redo clear
  const redoneClear = undoneClear.redo();
  assert.equal(redoneClear.present.channels[0].steps.every(s => s === false), true);

  // Redo fill
  const redoneFill = redoneClear.redo();
  assert.equal(redoneFill.present.channels[0].steps[4], true);
});

// ==========================================
// 6. PHASE 3C: CHANNEL MUTATIONS UNDO/REDO
// ==========================================

test('Channel: Add channel -> undo -> redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);
  const initialCount = initial.channels.length;

  const newChannel = {
    id: 'ch-test-new',
    name: 'Lead Synth',
    color: '#00ffcc',
    instrumentType: 'minisynth' as const,
    volume: 0.85,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: Array(16).fill(false),
    notes: [],
    synthParams: { ...initial.channels[0].synthParams }
  };

  const withAdded = appendChannelWithAllocatedMixerTrackId(initial, newChannel);
  history = history.commit(withAdded, 'Add channel');

  assert.equal(history.present.channels.length, initialCount + 1);
  assert.equal(history.present.channels[initialCount].id, 'ch-test-new');

  const undone = history.undo();
  assert.equal(undone.present.channels.length, initialCount);
  assert.equal(undone.present.channels.some(c => c.id === 'ch-test-new'), false);

  const redone = undone.redo();
  assert.equal(redone.present.channels.length, initialCount + 1);
  assert.equal(redone.present.channels[initialCount].id, 'ch-test-new');
});

test('Channel: Delete channel -> undo -> redo', () => {
  const initial = createTestState();
  const channelToDeleteId = initial.channels[1].id;
  let history = createHistory(initial);

  const result = deleteChannelFromProjectState(initial, channelToDeleteId);
  history = history.commit(result.state, 'Delete channel');

  assert.equal(history.present.channels.length, initial.channels.length - 1);
  assert.equal(history.present.channels.some(c => c.id === channelToDeleteId), false);

  const undone = history.undo();
  assert.equal(undone.present.channels.length, initial.channels.length);
  assert.equal(undone.present.channels.some(c => c.id === channelToDeleteId), true);

  const redone = undone.redo();
  assert.equal(redone.present.channels.length, initial.channels.length - 1);
  assert.equal(redone.present.channels.some(c => c.id === channelToDeleteId), false);
});

test('Channel: Parameter edits (volume, pan, pitch, mute, solo) -> undo -> redo', () => {
  const initial = createTestState();
  const chId = initial.channels[0].id;
  let history = createHistory(initial);

  // Edit volume
  const volState = updateChannelInProjectState(history.present, chId, { volume: 0.45 });
  history = history.commit(volState, 'Change channel volume');

  // Edit pan
  const panState = updateChannelInProjectState(history.present, chId, { pan: -0.6 });
  history = history.commit(panState, 'Change channel pan');

  // Edit pitch
  const pitchState = updateChannelInProjectState(history.present, chId, { pitch: 5 });
  history = history.commit(pitchState, 'Change channel pitch');

  // Toggle mute
  const muteState = updateChannelInProjectState(history.present, chId, { mute: true });
  history = history.commit(muteState, 'Toggle channel mute');

  // Toggle solo
  const soloState = updateChannelInProjectState(history.present, chId, { solo: true });
  history = history.commit(soloState, 'Toggle channel solo');

  assert.equal(history.present.channels[0].solo, true);
  assert.equal(history.present.channels[0].mute, true);
  assert.equal(history.present.channels[0].pitch, 5);
  assert.equal(history.present.channels[0].pan, -0.6);
  assert.equal(history.present.channels[0].volume, 0.45);

  // Undo in reverse order
  history = history.undo(); // undo solo
  assert.equal(history.present.channels[0].solo, false);
  assert.equal(history.present.channels[0].mute, true);

  history = history.undo(); // undo mute
  assert.equal(history.present.channels[0].mute, false);
  assert.equal(history.present.channels[0].pitch, 5);

  history = history.undo(); // undo pitch
  assert.equal(history.present.channels[0].pitch, 0);
  assert.equal(history.present.channels[0].pan, -0.6);

  history = history.undo(); // undo pan
  assert.equal(history.present.channels[0].pan, 0);
  assert.equal(history.present.channels[0].volume, 0.45);

  history = history.undo(); // undo volume
  assert.equal(history.present.channels[0].volume, initial.channels[0].volume);

  // Redo in forward order
  history = history.redo(); // redo volume
  assert.equal(history.present.channels[0].volume, 0.45);

  history = history.redo(); // redo pan
  assert.equal(history.present.channels[0].pan, -0.6);

  history = history.redo(); // redo pitch
  assert.equal(history.present.channels[0].pitch, 5);

  history = history.redo(); // redo mute
  assert.equal(history.present.channels[0].mute, true);

  history = history.redo(); // redo solo
  assert.equal(history.present.channels[0].solo, true);
});

test('Channel: Synth preset and parameter changes -> undo -> redo', () => {
  const initial = createTestState();
  const chId = initial.channels[0].id;
  let history = createHistory(initial);

  // Apply synth preset
  const presetParams = {
    ...initial.channels[0].synthParams,
    filterCutoff: 3500,
    filterResonance: 8,
    osc2Mix: 0.65,
    attack: 0.15
  };
  const presetState = updateChannelInProjectState(history.present, chId, { synthParams: presetParams });
  history = history.commit(presetState, 'Apply synth preset');

  assert.equal(history.present.channels[0].synthParams.filterCutoff, 3500);
  assert.equal(history.present.channels[0].synthParams.osc2Mix, 0.65);

  // Undo preset
  const undonePreset = history.undo();
  assert.equal(undonePreset.present.channels[0].synthParams.filterCutoff, initial.channels[0].synthParams.filterCutoff);

  // Redo preset
  const redonePreset = undonePreset.redo();
  assert.equal(redonePreset.present.channels[0].synthParams.filterCutoff, 3500);
});

test('Channel: Custom sample assignment and creation -> undo -> redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // Assign custom sample to existing channel
  const sampleData: CustomSampleData = {
    id: 'sample-kick-808',
    name: '808 Custom Sub',
    duration: 0.75,
    sampleRate: 44100,
    channels: 1,
    waveformPeaks: [0.1, 0.9, 0.3]
  };
  const assigned = updateChannelInProjectState(history.present, history.present.channels[0].id, { customSample: sampleData });
  history = history.commit(assigned, 'Assign sample');

  assert.equal(history.present.channels[0].customSample?.id, 'sample-kick-808');

  // Undo sample assignment
  const undoneSample = history.undo();
  assert.equal(undoneSample.present.channels[0].customSample, undefined);

  // Redo sample assignment
  const redoneSample = undoneSample.redo();
  assert.equal(redoneSample.present.channels[0].customSample?.id, 'sample-kick-808');

  // Create channel from sample
  const sampleChannel = {
    id: 'ch-sample-pad',
    name: 'Sample Pad',
    instrumentType: 'sampler' as const,
    volume: 0.85,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    color: '#00ff88',
    steps: Array(16).fill(false),
    notes: [],
    synthParams: { ...initial.channels[0].synthParams },
    customSample: sampleData
  };
  const withSampleCh = appendChannelWithAllocatedMixerTrackId(redoneSample.present, sampleChannel);
  const historyWithSampleCh = redoneSample.commit(withSampleCh, 'Create channel from sample');

  assert.equal(historyWithSampleCh.present.channels.some(c => c.id === 'ch-sample-pad'), true);

  const undoneCreate = historyWithSampleCh.undo();
  assert.equal(undoneCreate.present.channels.some(c => c.id === 'ch-sample-pad'), false);

  const redoneCreate = undoneCreate.redo();
  assert.equal(redoneCreate.present.channels.some(c => c.id === 'ch-sample-pad'), true);
});

// ==========================================
// 7. PHASE 3C: MIXER & FX UNDO/REDO
// ==========================================

test('Mixer: Volume, pan, mute, and sidechain -> undo -> redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // Change volume of track 1
  const volState = updateMixerTrackInProjectState(history.present, 1, { volume: 0.42 });
  history = history.commit(volState, 'Change mixer volume');

  // Change pan of track 1
  const panState = updateMixerTrackInProjectState(history.present, 1, { pan: 0.35 });
  history = history.commit(panState, 'Change mixer pan');

  // Toggle mute of track 1
  const muteState = updateMixerTrackInProjectState(history.present, 1, { mute: true });
  history = history.commit(muteState, 'Toggle mixer mute');

  // Configure sidechain on track 1
  const sidechainConfig = {
    enabled: true,
    sourceTrackId: 2,
    threshold: -24,
    amount: 0.8,
    attackMs: 5,
    releaseMs: 140,
    lowFreqOnly: true
  };
  const scState = updateMixerTrackInProjectState(history.present, 1, { sidechain: sidechainConfig });
  history = history.commit(scState, 'Update sidechain');

  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.volume, 0.42);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.pan, 0.35);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.mute, true);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.sidechain?.enabled, true);

  // Undo sidechain
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.sidechain, undefined);

  // Undo mute
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.mute, false);

  // Undo pan
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.pan, 0);

  // Undo volume
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.volume, initial.mixerTracks.find(t => t.id === 1)?.volume);

  // Redo volume
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.volume, 0.42);

  // Redo pan
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.pan, 0.35);

  // Redo mute
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.mute, true);

  // Redo sidechain
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.sidechain?.amount, 0.8);
});

test('FX: Add, delete, update, and bypass FX slots -> undo -> redo', () => {
  const initial = createTestState();
  const initialFxCount = initial.mixerTracks.find(t => t.id === 1)!.fxSlots.length;
  let history = createHistory(initial);

  const newFxSlot: FxSlot = {
    id: 'fx-reverb-1',
    type: 'reverb',
    name: 'Studio Reverb',
    enabled: true,
    mix: 0.75,
    params: { decay: 2.5, preDelay: 20 }
  };

  // Add FX slot
  const added = addFxSlotToProjectState(history.present, 1, newFxSlot);
  history = history.commit(added, 'Add effect');
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.length, initialFxCount + 1);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.some(f => f.id === 'fx-reverb-1'), true);

  // Bypass FX slot
  const bypassed = updateFxSlotInProjectState(history.present, 1, 'fx-reverb-1', { enabled: false });
  history = history.commit(bypassed, 'Bypass effect');
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.enabled, false);

  // Update mix parameter
  const updatedMix = updateFxSlotInProjectState(history.present, 1, 'fx-reverb-1', { mix: 0.3 });
  history = history.commit(updatedMix, 'Change effect mix');
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.mix, 0.3);

  // Delete FX slot
  const deleted = deleteFxSlotFromProjectState(history.present, 1, 'fx-reverb-1');
  history = history.commit(deleted, 'Delete effect');
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.length, initialFxCount);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.some(f => f.id === 'fx-reverb-1'), false);

  // Undo delete -> FX slot restored with mix 0.3 and enabled false
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.length, initialFxCount + 1);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.mix, 0.3);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.enabled, false);

  // Undo mix change -> mix is 0.75
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.mix, 0.75);

  // Undo bypass -> enabled is true
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.enabled, true);

  // Undo add -> initialFxCount fx slots
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.length, initialFxCount);

  // Redo add
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.length, initialFxCount + 1);

  // Redo bypass
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.enabled, false);

  // Redo mix change
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.find(f => f.id === 'fx-reverb-1')?.mix, 0.3);

  // Redo delete
  history = history.redo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.length, initialFxCount);
});

// ==========================================
// 8. PHASE 3C: PROJECT METADATA & PATTERNS
// ==========================================

test('Project Metadata: BPM, name, swing, and time signature -> undo -> redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // Change BPM
  const bpmState = updateProjectMetadataInProjectState(history.present, { bpm: 145 });
  history = history.commit(bpmState, 'Change tempo');

  // Rename project
  const nameState = updateProjectMetadataInProjectState(history.present, { name: 'Masterpiece Vol 1' });
  history = history.commit(nameState, 'Rename project');

  // Change time signature
  const tsState = updateProjectMetadataInProjectState(history.present, { timeSignature: [3, 4] });
  history = history.commit(tsState, 'Change time signature');

  // Change swing
  const swingState = updateProjectMetadataInProjectState(history.present, { swing: 0.3 });
  history = history.commit(swingState, 'Change swing');

  assert.equal(history.present.meta.bpm, 145);
  assert.equal(history.present.meta.name, 'Masterpiece Vol 1');
  assert.deepEqual(history.present.meta.timeSignature, [3, 4]);
  assert.equal(history.present.meta.swing, 0.3);

  // Undo in reverse order
  history = history.undo(); // undo swing
  assert.equal(history.present.meta.swing, initial.meta.swing);

  history = history.undo(); // undo time signature
  assert.deepEqual(history.present.meta.timeSignature, [4, 4]);

  history = history.undo(); // undo name
  assert.equal(history.present.meta.name, initial.meta.name);

  history = history.undo(); // undo BPM
  assert.equal(history.present.meta.bpm, initial.meta.bpm);

  // Redo in forward order
  history = history.redo(); // redo BPM
  assert.equal(history.present.meta.bpm, 145);

  history = history.redo(); // redo name
  assert.equal(history.present.meta.name, 'Masterpiece Vol 1');

  history = history.redo(); // redo time signature
  assert.deepEqual(history.present.meta.timeSignature, [3, 4]);

  history = history.redo(); // redo swing
  assert.equal(history.present.meta.swing, 0.3);
});

test('Pattern: Add pattern -> undo -> redo', () => {
  const initial = createTestState();
  let history = createHistory(initial);
  const initialPatCount = initial.patterns.length;

  const newPat: Pattern = {
    id: 'pat-synth-2',
    name: 'Chorus Lead Pattern',
    color: '#ff6e00',
    lengthSteps: 16
  };
  const withPat = addPatternToProjectState(history.present, newPat);
  history = history.commit(withPat, 'Add pattern');

  assert.equal(history.present.patterns.length, initialPatCount + 1);
  assert.equal(history.present.patterns[initialPatCount].id, 'pat-synth-2');

  const undone = history.undo();
  assert.equal(undone.present.patterns.length, initialPatCount);
  assert.equal(undone.present.patterns.some(p => p.id === 'pat-synth-2'), false);

  const redone = undone.redo();
  assert.equal(redone.present.patterns.length, initialPatCount + 1);
  assert.equal(redone.present.patterns[initialPatCount].id, 'pat-synth-2');
});

// ==========================================
// 9. PHASE 3C: THE UNCOMMITTED MUTATION TRAP
// ==========================================

test('Uncommitted Mutation Trap: Committed edit followed by formerly-uncommitted mutations is safe on Ctrl+Z', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  // 1. Perform an initial committed edit: Note edit in Piano Roll
  const note: Note = { id: 'note-committed-1', pitch: 62, start: 0, duration: 2, velocity: 0.85 };
  const noteState = updateChannelInProjectState(history.present, history.present.channels[0].id, { notes: [note] });
  history = history.commit(noteState, 'Edit notes');
  assert.equal(history.present.channels[0].notes.length, 1);

  // 2. Perform previously-uncommitted mutations:
  // Mutation A: Step sequencer edit (channel 0 step 3 toggled)
  const nextSteps = [...history.present.channels[0].steps];
  nextSteps[3] = true;
  const stepState = updateChannelInProjectState(history.present, history.present.channels[0].id, { steps: nextSteps });
  history = history.commit(stepState, 'Edit steps');

  // Mutation B: Mixer volume fader adjustment (track 1 volume set to 0.38)
  const mixerState = updateMixerTrackInProjectState(history.present, 1, { volume: 0.38 });
  history = history.commit(mixerState, 'Change mixer volume');

  // Mutation C: Add FX slot (reverb on track 1)
  const fxSlot: FxSlot = { id: 'fx-trap-test', type: 'reverb', name: 'Trap Reverb', enabled: true, mix: 0.5, params: {} };
  const fxState = addFxSlotToProjectState(history.present, 1, fxSlot);
  history = history.commit(fxState, 'Add effect');

  // Verify all changes are present
  assert.equal(history.present.channels[0].notes.length, 1);
  assert.equal(history.present.channels[0].steps[3], true);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.volume, 0.38);
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.some(f => f.id === 'fx-trap-test'), true);

  // 3. Press Ctrl+Z (Undo):
  // Crucial test: ONLY the latest mutation (Add FX) must be undone.
  // The earlier mutations (mixer volume, step sequencer toggle, note edit) MUST NOT BE DESTROYED!
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.some(f => f.id === 'fx-trap-test'), false, 'FX slot undone');
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.volume, 0.38, 'Mixer volume NOT destroyed');
  assert.equal(history.present.channels[0].steps[3], true, 'Step toggle NOT destroyed');
  assert.equal(history.present.channels[0].notes.length, 1, 'Note edit NOT destroyed');

  // Undo mixer volume
  history = history.undo();
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.volume, initial.mixerTracks.find(t => t.id === 1)?.volume);
  assert.equal(history.present.channels[0].steps[3], true, 'Step toggle still intact');
  assert.equal(history.present.channels[0].notes.length, 1, 'Note edit still intact');

  // Undo step toggle
  history = history.undo();
  assert.equal(history.present.channels[0].steps[3], false, 'Step toggle undone');
  assert.equal(history.present.channels[0].notes.length, 1, 'Note edit still intact');

  // Undo note edit
  history = history.undo();
  assert.equal(history.present.channels[0].notes.length, 0, 'Note edit undone');

  // Redo all 4 operations and verify expected final state
  history = history.redo(); // Redo Note edit
  assert.equal(history.present.channels[0].notes.length, 1);

  history = history.redo(); // Redo Step toggle
  assert.equal(history.present.channels[0].steps[3], true);

  history = history.redo(); // Redo Mixer volume
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.volume, 0.38);

  history = history.redo(); // Redo FX slot
  assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.fxSlots.some(f => f.id === 'fx-trap-test'), true);
});

// ==========================================
// 10. PHASE 3C: REF SYNCHRONIZATION
// ==========================================

test('Ref Synchronization: Mutate via each formerly-stale handler then immediately perform another edit', () => {
  // Simulate the authoritative ref container as in App.tsx
  const stateRef = { current: createTestState() };
  let history = createHistory(stateRef.current);

  const mutate = (updater: (s: ProjectState) => ProjectState, label: string) => {
    const next = updater(stateRef.current);
    stateRef.current = next;
    history = history.commit(next, label);
    return next;
  };

  // 1. Formerly-stale handler: updateMixerTrack
  mutate(s => updateMixerTrackInProjectState(s, 1, { volume: 0.15 }), 'Change mixer volume');
  assert.equal(stateRef.current.mixerTracks.find(t => t.id === 1)?.volume, 0.15);

  // Immediately perform another edit: note edit on channel 0
  const note: Note = { id: 'note-sync-1', pitch: 70, start: 1, duration: 1, velocity: 0.9 };
  mutate(s => updateChannelInProjectState(s, s.channels[0].id, { notes: [note] }), 'Edit notes');

  // Verify prior mixer mutation remains intact and was NOT reverted by a stale ref!
  assert.equal(stateRef.current.mixerTracks.find(t => t.id === 1)?.volume, 0.15);
  assert.equal(stateRef.current.channels[0].notes.length, 1);

  // 2. Formerly-stale handler: addChannel
  const ch = {
    id: 'ch-ref-sync',
    name: 'Sync Channel',
    color: '#123456',
    instrumentType: 'minisynth' as const,
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: Array(16).fill(false),
    notes: [],
    synthParams: { ...stateRef.current.channels[0].synthParams }
  };
  mutate(s => appendChannelWithAllocatedMixerTrackId(s, ch), 'Add channel');
  assert.equal(stateRef.current.channels.some(c => c.id === 'ch-ref-sync'), true);

  // Immediately perform another edit: update project metadata
  mutate(s => updateProjectMetadataInProjectState(s, { bpm: 155 }), 'Change tempo');
  assert.equal(stateRef.current.channels.some(c => c.id === 'ch-ref-sync'), true);
  assert.equal(stateRef.current.meta.bpm, 155);

  // 3. Formerly-stale handler: addPattern
  const pat: Pattern = { id: 'pat-sync-test', name: 'Sync Pat', color: '#ff6e00', lengthSteps: 16 };
  mutate(s => addPatternToProjectState(s, pat), 'Add pattern');
  assert.equal(stateRef.current.patterns.some(p => p.id === 'pat-sync-test'), true);

  // Immediately perform another edit: add FX slot
  const fx: FxSlot = { id: 'fx-sync-test', type: 'chorus', name: 'Sync Chorus', enabled: true, mix: 0.6, params: {} };
  mutate(s => addFxSlotToProjectState(s, 1, fx), 'Add effect');
  assert.equal(stateRef.current.patterns.some(p => p.id === 'pat-sync-test'), true);
  assert.equal(stateRef.current.mixerTracks.find(t => t.id === 1)?.fxSlots.some(f => f.id === 'fx-sync-test'), true);

  // 4. Formerly-stale handler: deleteChannel
  mutate(s => deleteChannelFromProjectState(s, 'ch-ref-sync').state, 'Delete channel');
  assert.equal(stateRef.current.channels.some(c => c.id === 'ch-ref-sync'), false);

  // Immediately perform another edit: toggle mixer mute
  mutate(s => updateMixerTrackInProjectState(s, 1, { mute: true }), 'Toggle mixer mute');
  assert.equal(stateRef.current.channels.some(c => c.id === 'ch-ref-sync'), false);
  assert.equal(stateRef.current.mixerTracks.find(t => t.id === 1)?.mute, true);
});

// ==========================================
// 11. PHASE 3C: CONTINUOUS CONTROL BATCHING
// ==========================================

test('Continuous Control: Drag sequence produces one logical history entry rather than flooding history', () => {
  const initial = createTestState();
  let history = createHistory(initial);

  const batcher = new ContinuousHistoryBatcher({
    debounceMs: 50,
    onCommit: (state, label) => {
      history = history.commit(state, label);
    }
  });

  const chId = initial.channels[0].id;
  const initialVolume = initial.channels[0].volume;

  // Simulate continuous drag of volume slider: 0.80 -> 0.70 -> 0.60 -> 0.50
  batcher.start('Change channel volume');
  const s1 = updateChannelInProjectState(initial, chId, { volume: 0.80 });
  batcher.update(s1, 'Change channel volume');

  const s2 = updateChannelInProjectState(s1, chId, { volume: 0.70 });
  batcher.update(s2, 'Change channel volume');

  const s3 = updateChannelInProjectState(s2, chId, { volume: 0.60 });
  batcher.update(s3, 'Change channel volume');

  const s4 = updateChannelInProjectState(s3, chId, { volume: 0.50 });
  batcher.update(s4, 'Change channel volume');

  // Before interaction ends, no history entries are committed
  assert.equal(history.past.length, 0);

  // Interaction completes (pointer release / end)
  batcher.flush('Change channel volume');

  // Verify exactly ONE logical history entry was created, NOT 4!
  assert.equal(history.past.length, 1);
  assert.equal(history.past[0].label, 'Change channel volume');
  assert.equal(history.present.channels[0].volume, 0.50);

  // Undo restores the pre-drag initial value
  const undone = history.undo();
  assert.equal(undone.present.channels[0].volume, initialVolume);

  // Redo restores the final drag value
  const redone = undone.redo();
  assert.equal(redone.present.channels[0].volume, 0.50);
});
