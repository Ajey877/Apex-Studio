import assert from 'node:assert/strict';
import test from 'node:test';
import { NEW_SESSION_SOURCE, createNewSessionRequest } from './newSession';
import { isPristineProject, planProjectReplacement } from './projectReplacement';
import { getProjectFingerprint } from './projectReplacement';
import { createDefaultProjectState } from './projectState';

test('the New Session source is the audited replacement source string', () => {
  assert.equal(NEW_SESSION_SOURCE, 'new-session');
});

test('a New Session request is a blank untitled project', () => {
  const { state, options } = createNewSessionRequest();
  assert.equal(options.source, 'new-session');
  assert.equal(state.meta.name, 'Untitled Session');
  assert.equal(state.meta.bpm, 128);
  assert.deepEqual(state.meta.timeSignature, [4, 4]);
  assert.equal(state.playlistClips.length, 0);
  assert.equal(state.recordings.length, 0);
});

test('a New Session request is semantically identical to a blank session', () => {
  // This is the exact equivalence the existing Project Hub "New Session" tile relies on:
  // a blank request must fingerprint as pristine, otherwise the replacement flow would
  // demand a confirmation dialog for opening a brand-new empty project.
  const { state } = createNewSessionRequest();
  assert.equal(isPristineProject(state), true);
  assert.equal(
    getProjectFingerprint(state),
    getProjectFingerprint(createDefaultProjectState()),
  );
});

test('New Session replaces a pristine project without a confirmation dialog', () => {
  const { state, options } = createNewSessionRequest();
  const plan = planProjectReplacement(createDefaultProjectState(), state, { source: options.source });
  assert.equal(plan.requiresConfirmation, false);
  assert.equal(plan.shouldBackup, false);
  assert.equal(plan.reason, 'pristine-current');
  assert.equal(plan.incomingName, 'Untitled Session');
});

test('New Session still protects a project that contains work', () => {
  const { state, options } = createNewSessionRequest();
  const workedOn = createDefaultProjectState();
  workedOn.meta.name = 'Real Song';
  workedOn.channels[0].notes = [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.8 }];
  const plan = planProjectReplacement(workedOn, state, { source: options.source });
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.shouldBackup, true);
  assert.equal(plan.reason, 'current-has-work');
  assert.equal(plan.currentName, 'Real Song');
});

test('each New Session request is a fresh document with no shared mutable state', () => {
  const first = createNewSessionRequest();
  const second = createNewSessionRequest();
  assert.notEqual(first.state, second.state, 'each request must be its own object graph');

  // Deep mutation of one request must never reach the other or the bundled demo
  // that DEFAULT_PROJECT is cloned from.
  first.state.channels[0].name = 'Mutated';
  first.state.channels[0].steps[0] = !first.state.channels[0].steps[0];
  first.state.patterns[0].name = 'Mutated Pattern';
  first.state.playlistClips.push({
    id: 'injected',
    trackIndex: 0,
    startBar: 0,
    lengthBars: 1,
    type: 'pattern',
    patternId: 'pat-1',
    name: 'Injected',
    color: '#ff6e00',
  });

  assert.notEqual(second.state.channels[0].name, 'Mutated');
  assert.notEqual(second.state.patterns[0].name, 'Mutated Pattern');
  assert.equal(second.state.playlistClips.length, 0);
  assert.notEqual(getProjectFingerprint(first.state), getProjectFingerprint(second.state));
  assert.equal(isPristineProject(second.state), true, 'the untouched request must still be pristine');
});
