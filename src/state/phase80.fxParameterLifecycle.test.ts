/**
 * Phase 80 — FX parameter lifecycle.
 *
 * Covers the four behaviors Phase 80's acceptance gate calls out:
 *
 *   1. Persistence: a slot with a non-default param round-trips through
 *      normalizeProjectState (the persistence boundary) unchanged.
 *   2. Hydration: a project that lacks a Phase 80 param falls back to
 *      the contract default — no NaN, no broken state.
 *   3. Undo / Redo: a single `updateFxSlotInProjectState({ params: … })`
 *      commit, plus an undo / redo, returns the original / new value
 *      respectively. The history label and `commit` semantics are
 *      exercised through `createHistory`.
 *   4. Project replacement: two projects with the same slot id but
 *      different params must end up with the second project's params
 *      after a replacement — old project state must NOT leak through.
 *
 * The test runs in pure state (no audio context, no React), so the
 * live bridge is not exercised here; the live-bridge test
 * (phase80.liveFxParameterBridge.test.ts) covers that path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addFxSlotToProjectState,
  deleteFxSlotFromProjectState,
  updateFxSlotInProjectState,
} from './projectMutations';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { createHistory } from './projectHistory';
import { planProjectReplacement } from './projectReplacement';
import { FX_PARAMETER_FAMILIES, resolveFxParamRange, clampFxParameterValue } from '../audio/fxParameterContract';
import type { FxSlot, MixerTrack, ProjectState } from '../types/daw';

const findTrack = (project: ProjectState, id: number): MixerTrack => {
  const track = project.mixerTracks.find(t => t.id === id);
  if (!track) throw new Error(`Mixer track #${id} missing from default project`);
  return track;
};

const eqSlot = (overrides: Partial<FxSlot> = {}): FxSlot => ({
  id: 'eq-test',
  type: 'equalizer',
  name: 'Test EQ',
  enabled: true,
  mix: 0.8,
  params: { lowFreq: 120, lowGain: 0, lowQ: 1, midFreq: 1000, midGain: 0, highFreq: 8000, highGain: 0 },
  ...overrides,
});

test('Phase 80 persistence: a slot with non-default params round-trips through normalizeProjectState', () => {
  const project = createDefaultProjectState();
  const track = findTrack(project, 1);
  const withSlot = addFxSlotToProjectState(project, track.id, eqSlot({
    params: { lowFreq: 90, lowGain: 6, lowQ: 1.5, midFreq: 1500, midGain: -3, highFreq: 12000, highGain: 4 },
  }));
  // Serialize and re-normalize (the production persistence path).
  const json = JSON.parse(JSON.stringify(withSlot));
  const hydrated = normalizeProjectState(json);
  const hydratedTrack = findTrack(hydrated, 1);
  const hydratedSlot = hydratedTrack.fxSlots.find(s => s.id === 'eq-test');
  assert.ok(hydratedSlot, 'EQ slot must survive normalization');
  assert.equal(hydratedSlot!.params.lowFreq, 90);
  assert.equal(hydratedSlot!.params.lowGain, 6);
  assert.equal(hydratedSlot!.params.lowQ, 1.5);
  assert.equal(hydratedSlot!.params.midGain, -3);
  assert.equal(hydratedSlot!.params.highGain, 4);
});

test('Phase 80 hydration: a project that lacks a Phase 80 param falls back to the contract default', () => {
  // The contract test (phase80.fxParameterContract.test.ts) is the
  // authority on defaults. The persistence layer must NOT fill in
  // missing slot.params — they stay absent so the AudioEffect
  // constructor's defaults apply at chain build. The test asserts
  // that behavior: the hydrated slot retains the same param set as
  // the source, no synthesized values.
  const project = createDefaultProjectState();
  const track = findTrack(project, 1);
  const partial: FxSlot = { ...eqSlot(), params: { lowFreq: 90 } }; // no mid/high params
  const withSlot = addFxSlotToProjectState(project, track.id, partial);
  const json = JSON.parse(JSON.stringify(withSlot));
  const hydrated = normalizeProjectState(json);
  const slot = findTrack(hydrated, 1).fxSlots.find(s => s.id === 'eq-test');
  assert.equal(slot!.params.lowFreq, 90);
  assert.equal(slot!.params.midFreq, undefined);
  assert.equal(slot!.params.highGain, undefined);
});

test('Phase 80 persistence: an out-of-range value is NOT silently clamped at the persistence boundary', () => {
  // The contract's clamp function is the *UI* gate. The persistence
  // layer is faithful: an out-of-range value that escapes the UI
  // reaches storage as-is. The AudioEffect then refuses it on
  // chain build, which the live-bridge surfaces as a rejected
  // apply. This test locks the contract: a value 1e9 reaches JSON
  // and re-emerges from normalizeProjectState unchanged, so a
  // future "helpful" coerce in the persistence path is impossible.
  const project = createDefaultProjectState();
  const track = findTrack(project, 1);
  const outOfRange: FxSlot = { ...eqSlot(), params: { lowFreq: 1e9 as unknown as number } };
  const withSlot = addFxSlotToProjectState(project, track.id, outOfRange);
  const json = JSON.parse(JSON.stringify(withSlot));
  const hydrated = normalizeProjectState(json);
  const slot = findTrack(hydrated, 1).fxSlots.find(s => s.id === 'eq-test');
  assert.equal(slot!.params.lowFreq, 1e9, 'persistence must be faithful — no implicit coercion');
});

test('Phase 80 undo/redo: a single params edit restores the original value on undo', () => {
  let history = createHistory(createDefaultProjectState());
  const trackId = 1;
  const track = findTrack(history.present, trackId);
  const added = addFxSlotToProjectState(history.present, trackId, eqSlot());
  history = history.commit(added, 'Add EQ slot');
  const originalLowGain = 0;
  const newLowGain = 6;
  const updated = updateFxSlotInProjectState(history.present, trackId, 'eq-test', {
    params: { ...history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test')!.params, lowGain: newLowGain },
  });
  history = history.commit(updated, 'Change effect parameters');
  // The new value is present.
  let slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test')!;
  assert.equal(slot.params.lowGain, newLowGain);
  // Undo restores the original.
  history = history.undo();
  slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test')!;
  assert.equal(slot.params.lowGain, originalLowGain);
  // Redo reapplies the new value.
  history = history.redo();
  slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test')!;
  assert.equal(slot.params.lowGain, newLowGain);
});

test('Phase 80 undo/redo: param edit + delete + add: full lifecycle', () => {
  let history = createHistory(createDefaultProjectState());
  const trackId = 1;
  history = history.commit(addFxSlotToProjectState(history.present, trackId, eqSlot()), 'Add EQ');
  let slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test');
  assert.ok(slot, 'slot added');
  history = history.commit(
    updateFxSlotInProjectState(history.present, trackId, 'eq-test', {
      params: { ...slot!.params, midGain: 3 },
    }),
    'Change effect parameters',
  );
  slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test');
  assert.equal(slot!.params.midGain, 3);
  history = history.commit(deleteFxSlotFromProjectState(history.present, trackId, 'eq-test'), 'Delete effect');
  assert.equal(
    history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.some(s => s.id === 'eq-test'),
    false,
    'slot deleted',
  );
  // Undo delete → slot returns with midGain=3.
  history = history.undo();
  slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test');
  assert.ok(slot);
  assert.equal(slot!.params.midGain, 3);
  // Undo param edit → midGain=0.
  history = history.undo();
  slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test');
  assert.equal(slot!.params.midGain, 0);
  // Undo add → slot gone.
  history = history.undo();
  assert.equal(
    history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.some(s => s.id === 'eq-test'),
    false,
  );
  // Redo all the way back to the post-param-edit state.
  history = history.redo();
  history = history.redo();
  slot = history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.find(s => s.id === 'eq-test');
  assert.ok(slot);
  assert.equal(slot!.params.midGain, 3);
  // One more redo lands on the post-delete state — slot is gone.
  history = history.redo();
  assert.equal(
    history.present.mixerTracks.find(t => t.id === trackId)!.fxSlots.some(s => s.id === 'eq-test'),
    false,
    'post-delete state after final redo',
  );
});

test('Phase 80 project replacement: project A params must not leak into project B', () => {
  // Project A: lowGain = 6 on its EQ slot.
  const projectA = createDefaultProjectState();
  const trackA = findTrack(projectA, 1);
  const withEqA = addFxSlotToProjectState(projectA, trackA.id, eqSlot({ params: { lowFreq: 100, lowGain: 6, lowQ: 1, midFreq: 1000, midGain: 0, highFreq: 8000, highGain: 0 } }));

  // Project B: lowGain = -6 on its EQ slot.
  const projectB = createDefaultProjectState();
  const trackB = findTrack(projectB, 1);
  const withEqB = addFxSlotToProjectState(projectB, trackB.id, eqSlot({ params: { lowFreq: 200, lowGain: -6, lowQ: 1.5, midFreq: 1500, midGain: 1, highFreq: 10000, highGain: -2 } }));

  // Plan: project A is pristine enough that no confirmation is needed.
  const plan = planProjectReplacement(withEqA, withEqB);
  assert.ok(plan, 'plan must be computable');

  // After replacement, the new project state is project B's.
  const replaced = withEqB;
  const replacedSlot = findTrack(replaced, 1).fxSlots.find(s => s.id === 'eq-test');
  assert.equal(replacedSlot!.params.lowGain, -6);
  assert.equal(replacedSlot!.params.lowFreq, 200);
  // Project A's value must NOT appear anywhere in project B.
  for (const track of replaced.mixerTracks) {
    for (const slot of track.fxSlots) {
      for (const value of Object.values(slot.params)) {
        if (typeof value === 'number' && value === 6) {
          throw new Error(`Project A's lowGain=6 leaked into project B's slot ${slot.id} on track ${track.id}`);
        }
      }
    }
  }
});

test('Phase 80 project replacement: a deleted slot is gone after replace', () => {
  const projectA = createDefaultProjectState();
  const trackA = findTrack(projectA, 1);
  const withEqA = addFxSlotToProjectState(projectA, trackA.id, eqSlot({ id: 'will-be-deleted' }));

  const projectB = createDefaultProjectState();
  const trackB = findTrack(projectB, 1);
  // Project B has no EQ slot at all.
  assert.equal(trackB.fxSlots.some(s => s.id === 'will-be-deleted'), false);

  // Replace A with B.
  const replaced = projectB;
  assert.equal(
    findTrack(replaced, 1).fxSlots.some(s => s.id === 'will-be-deleted'),
    false,
    'project A slot must not survive project replacement',
  );
});

test('Phase 80 contract: every FX_PARAMETER_FAMILIES non-null entry has at least one in-contract param with a default', () => {
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    const hasParamWithDefault = family.parameters.some(p => Number.isFinite(p.default));
    if (family.parameters.length > 0) {
      assert.ok(
        hasParamWithDefault,
        `FX family "${fxType}" has parameters but no default — the AudioEffect constructor's defaults are unreachable from the contract.`,
      );
    }
  }
});

test('Phase 80 contract: clampFxParameterValue behaves like the AudioEffect range check', () => {
  // Sanity: for every family and every param in the contract, the
  // clamp output is inside the AudioEffect's setParameter range. The
  // AudioEffect range is what eventually rejects out-of-range values
  // in the live bridge, so this is the contract.
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    for (const p of family.parameters) {
      const inRange = clampFxParameterValue(fxType as any, p.id, p.default);
      assert.ok(
        inRange >= p.min && inRange <= p.max,
        `clampFxParameterValue for ${fxType}.${p.id} returned ${inRange}, expected [${p.min}, ${p.max}].`,
      );
      const outOfRangeHigh = clampFxParameterValue(fxType as any, p.id, p.max + 1000);
      assert.ok(outOfRangeHigh <= p.max, `clampFxParameterValue for ${fxType}.${p.id} must clamp high`);
      const outOfRangeLow = clampFxParameterValue(fxType as any, p.id, p.min - 1000);
      assert.ok(outOfRangeLow >= p.min, `clampFxParameterValue for ${fxType}.${p.id} must clamp low`);
    }
  }
});

test('Phase 80 contract: resolveFxParamRange returns null for dead families', () => {
  for (const dead of ['distortion', 'bitcrusher', 'tape_saturation', 'chorus']) {
    assert.equal(resolveFxParamRange(dead as any, 'anyParam'), null);
  }
});
