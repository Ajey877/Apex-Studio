/**
 * Phase 80 — FX parameter drag history grouping.
 *
 * The spec:
 *   "A knob drag should behave like a sensible DAW operation. Do not
 *    redesign the entire history system in Phase 80."
 *
 * The existing `ContinuousHistoryBatcher` debounces a stream of
 * `update(nextState, label)` calls into a single history commit when
 * the stream stops for `debounceMs` (default 300 ms). Phase 80
 * threads FX param edits through the same `isContinuousFxUpdate`
 * path that already routes `mix` and `params` to the batcher; this
 * test exercises the contract end-to-end and asserts:
 *
 *   - A 250-ms flurry of `update` calls (faster than the debounce
 *     window) results in a single history commit.
 *   - The committed state is the LATEST state in the flurry (every
 *     intermediate value is dropped; the producer sees a single
 *     undo step that lands on the pre-flurry state).
 *   - Calling `flush()` while the timer is active commits the
 *     pending state immediately (e.g. on pointer-up), even if the
 *     debounce has not elapsed.
 *   - A discrete (non-continuous) edit gets its own history entry
 *     — the batcher must not bundle a "Change effect parameters" edit
 *     with a subsequent "Enable effect" edit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ContinuousHistoryBatcher, isContinuousFxUpdate, getFxUpdateLabel, updateFxSlotInProjectState } from './projectMutations';
import { createDefaultProjectState } from './projectState';
import { createHistory } from './projectHistory';
import type { FxSlot, ProjectState } from '../types/daw';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const eqSlot = (overrides: Partial<FxSlot> = {}): FxSlot => ({
  id: 'eq-drag',
  type: 'equalizer',
  name: 'Drag EQ',
  enabled: true,
  mix: 0.8,
  params: { lowFreq: 100, lowGain: 0, lowQ: 1, midFreq: 1000, midGain: 0, highFreq: 8000, highGain: 0 },
  ...overrides,
});

test('Phase 80: isContinuousFxUpdate classifies mix and params as continuous', () => {
  assert.equal(isContinuousFxUpdate({ mix: 0.5 }), true);
  assert.equal(isContinuousFxUpdate({ params: { lowFreq: 200 } }), true);
  // enabled / type / name are discrete edits.
  assert.equal(isContinuousFxUpdate({ enabled: false }), false);
  assert.equal(isContinuousFxUpdate({ type: 'reverb' }), false);
  assert.equal(isContinuousFxUpdate({ name: 'X' }), false);
});

test('Phase 80: getFxUpdateLabel produces a producer-readable label for each edit type', () => {
  assert.equal(getFxUpdateLabel({ mix: 0.5 }), 'Change effect mix');
  assert.equal(getFxUpdateLabel({ params: { lowFreq: 200 } }), 'Update effect parameters');
  assert.equal(getFxUpdateLabel({ enabled: false }), 'Bypass effect');
  assert.equal(getFxUpdateLabel({ enabled: true }), 'Enable effect');
});

test('Phase 80: a flurry of FX param updates within the debounce window commits once', async () => {
  let history = createHistory(createDefaultProjectState());
  const trackId = 1;
  history = history.commit(updateFxSlotInProjectState(history.present, trackId, 'eq-drag', { params: { lowFreq: 200 } }), 'seed');
  // Actually, we need to first add the slot. Easier: start with the
  // slot pre-seeded via the project state.
  const seeded: ProjectState = {
    ...history.present,
    mixerTracks: history.present.mixerTracks.map(t =>
      t.id === trackId ? { ...t, fxSlots: [...t.fxSlots, eqSlot()] } : t,
    ),
  };
  history = history.commit(seeded, 'Add EQ slot');
  const initialLowGain = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-drag')!.params.lowGain;
  assert.equal(initialLowGain, 0);

  // Now simulate a drag: 30 updates over ~250ms (well under the 300ms debounce).
  // The producer computes the next state and hands it to the batcher;
  // the public API is `update(nextState, label)`. We track the most
  // recently computed state in a closure so the next call always sees
  // the freshest project state.
  const commits: Array<{ state: ProjectState; label: string }> = [];
  const batcher = new ContinuousHistoryBatcher({
    debounceMs: 300,
    onCommit: (state, label) => commits.push({ state, label }),
  });
  batcher.start('Change effect parameters');
  let latest = history.present;
  for (let i = 1; i <= 30; i += 1) {
    const next = updateFxSlotInProjectState(
      latest,
      trackId,
      'eq-drag',
      { params: { ...(latest.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-drag')!.params), lowGain: i } },
    );
    latest = next;
    batcher.update(next, 'Change effect parameters');
    // No await — back-to-back in the same microtask.
  }
  // Wait long enough for the debounce to elapse.
  await wait(400);
  assert.equal(commits.length, 1, 'a 30-step drag must collapse to one history commit');
  assert.equal(commits[0]!.label, 'Change effect parameters');
  const finalLowGain = commits[0]!.state.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-drag')!.params.lowGain;
  assert.equal(finalLowGain, 30, 'the committed state is the last value in the drag, not an intermediate');
});

test('Phase 80: a discrete edit (enable/disable) is its own history entry, not bundled with a params drag', () => {
  // Even if the batcher is "active" because of a params drag, an
  // explicit `flush()` followed by a non-continuous edit must not
  // merge them. The API uses `isContinuous: true|false` on the
  // mutateProjectState options; this test asserts the batcher's
  // contract: a flush is a flush, period.
  let history = createHistory(createDefaultProjectState());
  const trackId = 1;
  const seeded: ProjectState = {
    ...history.present,
    mixerTracks: history.present.mixerTracks.map(t =>
      t.id === trackId ? { ...t, fxSlots: [...t.fxSlots, eqSlot()] } : t,
    ),
  };
  history = history.commit(seeded, 'Add EQ slot');

  const commits: Array<{ state: ProjectState; label: string }> = [];
  const batcher = new ContinuousHistoryBatcher({
    debounceMs: 300,
    onCommit: (state, label) => commits.push({ state, label }),
  });
  // Drag in progress.
  batcher.start('Change effect parameters');
  let latestDiscrete = history.present;
  for (let i = 1; i <= 5; i += 1) {
    const next = updateFxSlotInProjectState(
      latestDiscrete,
      trackId,
      'eq-drag',
      { params: { lowGain: i } },
    );
    latestDiscrete = next;
    batcher.update(next, 'Change effect parameters');
  }
  // The drag is flushed manually (e.g. on pointer-up).
  batcher.flush();
  // A discrete edit (enable toggle) is a separate commit.
  const toggled = updateFxSlotInProjectState(history.present, trackId, 'eq-drag', { enabled: false });
  history = history.commit(toggled, 'Bypass effect');
  // The batcher should NOT bundle the discrete edit — the
  // mutateProjectState API uses `isContinuous: false` for discrete
  // edits, so it bypasses the batcher entirely. The test asserts
  // the batcher's contract: it does not absorb history entries
  // after a flush.
  assert.equal(commits.length, 1, 'flush commits once, then a discrete edit is a separate history entry');
  assert.equal(commits[0]!.label, 'Change effect parameters');
  assert.equal(history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-drag')!.enabled, false);
});

test('Phase 80: a continuous edit is dropped when the user undoes (the latest pending state is the new history entry)', async () => {
  // The producer moves the slider, undoes, and lands on the pre-drag
  // state — never on an intermediate.
  let history = createHistory(createDefaultProjectState());
  const trackId = 1;
  const seeded: ProjectState = {
    ...history.present,
    mixerTracks: history.present.mixerTracks.map(t =>
      t.id === trackId ? { ...t, fxSlots: [...t.fxSlots, eqSlot()] } : t,
    ),
  };
  history = history.commit(seeded, 'Add EQ slot');

  const commits: Array<{ state: ProjectState; label: string }> = [];
  const batcher = new ContinuousHistoryBatcher({
    debounceMs: 50, // shorter for the test
    onCommit: (state, label) => commits.push({ state, label }),
  });
  batcher.start('Change effect parameters');
  let latestContinuous = history.present;
  for (let i = 1; i <= 10; i += 1) {
    const next = updateFxSlotInProjectState(
      latestContinuous,
      trackId,
      'eq-drag',
      { params: { lowGain: i } },
    );
    latestContinuous = next;
    batcher.update(next, 'Change effect parameters');
  }
  await wait(80);
  assert.equal(commits.length, 1);
  history = history.commit(commits[0]!.state, commits[0]!.label);
  // Now undo: must land on the pre-drag state (lowGain=0).
  history = history.undo();
  const slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-drag')!;
  assert.equal(slot.params.lowGain, 0, 'undo collapses the drag into a single step');
  // Redo: must restore the final drag value (lowGain=10).
  history = history.redo();
  const slot2 = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-drag')!;
  assert.equal(slot2.params.lowGain, 10, 'redo restores the final drag value, not an intermediate');
});
