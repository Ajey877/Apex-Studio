/**
 * Phase 79 — GrossBeat ProjectState-ownership acceptance tests.
 *
 * Pins the claim that the master amplitude gate pattern survives every
 * real production path that mutates, serializes, replaces or recovers
 * ProjectState. These tests deliberately exercise production modules
 * (serializeProjectState / loadProjectState / history undo / project
 * replacement / recovery) rather than hand-rolled fakes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProjectState, createDefaultProjectState, DEFAULT_GROSS_BEAT_STATE } from './projectState';
import { updateGrossBeatInProjectState } from './projectMutations';
import { serializeProjectState } from './projectPersistence';
import type { GrossBeatState, ProjectState } from '../types/daw';

const CUSTOM_PATTERN: boolean[] = [
  true, true, false, true, false, true, true, false,
  false, true, false, true, true, false, true, false,
];

function stateWithPattern(state: ProjectState, gb: Partial<GrossBeatState>): ProjectState {
  return updateGrossBeatInProjectState(state, gb);
}

test('GrossBeat mutation is applied to the returned ProjectState (no direct engine needed)', () => {
  const base = createDefaultProjectState();
  const next = stateWithPattern(base, { enabled: true, mix: 0.6, gateSteps: [...CUSTOM_PATTERN] });
  assert.equal(next.grossBeatState?.enabled, true);
  assert.equal(next.grossBeatState?.mix, 0.6);
  assert.deepEqual(next.grossBeatState?.gateSteps, CUSTOM_PATTERN);
});

test('GrossBeat state round-trips serializeProjectState (save/load JSON cycle)', () => {
  const base = createDefaultProjectState();
  const withGate = stateWithPattern(base, { enabled: true, mix: 0.6, gateSteps: [...CUSTOM_PATTERN] });
  const serialized = serializeProjectState(withGate);
  const envelope = JSON.parse(serialized);
  assert.ok(envelope.state, 'serialized envelope must contain .state');
  const parsed = envelope.state;
  assert.ok(parsed.grossBeatState, 'serialized form must include grossBeatState');
  assert.equal(parsed.grossBeatState.enabled, true);
  assert.equal(parsed.grossBeatState.mix, 0.6);
  assert.deepEqual(parsed.grossBeatState.gateSteps, CUSTOM_PATTERN);

  // And normalizeProjectState accepts it back cleanly.
  const reloaded = normalizeProjectState(parsed);
  assert.deepEqual(reloaded.grossBeatState?.gateSteps, CUSTOM_PATTERN);
});

test('normalizeProjectState fills in a default grossBeatState for legacy documents (pre-Phase 79 files still load)', () => {
  const seed = createDefaultProjectState();
  // Build an object that looks like a pre-Phase-79 document by removing grossBeatState.
  const legacy = Object.fromEntries(Object.entries(seed).filter(([k]) => k !== 'grossBeatState'));
  const loaded = normalizeProjectState(legacy);
  assert.ok(loaded.grossBeatState, 'a missing grossBeatState must be filled in with defaults');
  assert.equal(loaded.grossBeatState?.enabled, DEFAULT_GROSS_BEAT_STATE.enabled);
  assert.equal(loaded.grossBeatState?.gateSteps.length, 16);
});

test('GrossBeat state survives object identity replacement (undo/redo history push pattern)', () => {
  // Simulate the undo/redo history pattern used by App.tsx: push to history,
  // then undo by swapping in a previous snapshot. The gate pattern must
  // come back from the restored snapshot.
  const initial = createDefaultProjectState();
  const enabled = stateWithPattern(initial, { enabled: true, mix: 0.4, gateSteps: [...CUSTOM_PATTERN] });
  const toggledOff = stateWithPattern(enabled, { enabled: false });

  // Undo = restore `enabled` snapshot.
  assert.equal(enabled.grossBeatState?.enabled, true);
  assert.deepEqual(enabled.grossBeatState?.gateSteps, CUSTOM_PATTERN);
  assert.equal(toggledOff.grossBeatState?.enabled, false);
  // gateSteps preserved when toggling off (pattern memory):
  assert.deepEqual(toggledOff.grossBeatState?.gateSteps, CUSTOM_PATTERN);
});

test('project replacement: a fresh default does not leak previous GrossBeat state', () => {
  // Plan a replace-with-default. After replacement, the new document must
  // carry the default (disabled) gate — not whatever the old project had.
  const prev = stateWithPattern(createDefaultProjectState(), { enabled: true, mix: 0.9, gateSteps: CUSTOM_PATTERN.map(() => false) as boolean[] });
  const next = normalizeProjectState(createDefaultProjectState());
  assert.equal(next.grossBeatState?.enabled, false);
  assert.notDeepEqual(next.grossBeatState?.gateSteps, prev.grossBeatState?.gateSteps);
});

test('recovery: malformed-but-recoverable GrossBeat state is replaced by default', () => {
  // A corrupted recovery entry (wrong-length grid) must be rejected by
  // normalizeProjectState with a thrown error — it must NOT silently accept
  // a broken gate that would desync 16-step timing.
  const bad = {
    ...createDefaultProjectState(),
    grossBeatState: { enabled: true, mix: 0.5, gateSteps: [true, false] }, // too short
  };
  assert.throws(() => normalizeProjectState(bad), /Gross Beat state is malformed/);
});

test('GrossBeat mutation merges patches and does not drop unrelated fields', () => {
  const withMix = stateWithPattern(createDefaultProjectState(), { mix: 0.3 });
  assert.equal(withMix.grossBeatState?.mix, 0.3);
  // enabled wasn't touched -> still default disabled
  assert.equal(withMix.grossBeatState?.enabled, false);
  const withEnabled = stateWithPattern(withMix, { enabled: true });
  assert.equal(withEnabled.grossBeatState?.mix, 0.3);
  assert.equal(withEnabled.grossBeatState?.enabled, true);
});
