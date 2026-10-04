/**
 * Phase 70 — F2: studio notes are project data, mutated through the same
 * immutable ProjectState path as every other document edit.
 *
 * The Collaboration modal used to be fed from component-local React state that
 * was never written into `ProjectState`, so a note typed by the user was lost on
 * reload while the modal claimed "Comments and collaborator data are stored in
 * this project". These helpers are the single mutation path for those fields;
 * the persistence half of this suite proves the values survive the real
 * save/restore pipeline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCollabCommentInProjectState,
  createLocalCollabComment,
  toggleCollabCommentResolvedInProjectState,
} from './projectMutations';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import type { CollabComment, ProjectState } from '../types/daw';

const comment = (id: string, overrides: Partial<CollabComment> = {}): CollabComment => ({
  id,
  author: 'You',
  avatarColor: '#ff6e00',
  timestamp: 1700000000000,
  barPosition: 4,
  text: `note ${id}`,
  resolved: false,
  ...overrides,
});

describe('Phase 70 F2 — studio-note mutation helpers', () => {
  it('creates a local note from the real clock value it is given', () => {
    const created = createLocalCollabComment('Tighten the low end', 7, 1700000123456, 'c-test');

    assert.equal(created.id, 'c-test');
    assert.equal(created.text, 'Tighten the low end');
    assert.equal(created.barPosition, 7);
    assert.equal(created.timestamp, 1700000123456, 'the timestamp is the caller-supplied clock, never a fabricated one');
    assert.equal(created.resolved, false);
    assert.ok(created.author.length > 0, 'a note needs an author label');
  });

  it('prepends a note without mutating the input state', () => {
    const state: ProjectState = { ...createDefaultProjectState(), comments: [comment('c-old')] };
    const frozen: string = JSON.stringify(state);

    const next = addCollabCommentInProjectState(state, comment('c-new'));

    assert.deepEqual(next.comments.map(c => c.id), ['c-new', 'c-old']);
    assert.equal(JSON.stringify(state), frozen, 'the previous state object must not be mutated');
    assert.notEqual(next, state);
    assert.equal(next.comments.length, 2);
  });

  it('keeps every other project field untouched when a note is added', () => {
    const state = createDefaultProjectState();
    const next = addCollabCommentInProjectState(state, comment('c-new'));

    const { comments: _before, ...before } = state;
    const { comments: _after, ...after } = next;
    assert.deepEqual(after, before);
  });

  it('toggles resolution of exactly the addressed note', () => {
    const state: ProjectState = {
      ...createDefaultProjectState(),
      comments: [comment('c-1'), comment('c-2', { resolved: true })],
    };

    const next = toggleCollabCommentResolvedInProjectState(state, 'c-2');

    assert.deepEqual(next.comments.map(c => c.resolved), [false, false]);
    assert.notEqual(next, state);
    assert.deepEqual(
      toggleCollabCommentResolvedInProjectState(next, 'c-2').comments.map(c => c.resolved),
      [false, true],
      'toggling twice returns to the original resolution',
    );
  });

  it('leaves the notes untouched when the target id is unknown', () => {
    const state: ProjectState = { ...createDefaultProjectState(), comments: [comment('c-1')] };

    const next = toggleCollabCommentResolvedInProjectState(state, 'missing');

    assert.deepEqual(next.comments, state.comments);
  });
});

describe('Phase 70 F2 — studio notes survive the real persistence pipeline', () => {
  it('round-trips an added note through serializeProjectState and normalizeProjectState', () => {
    const state = createDefaultProjectState();
    const withNote = addCollabCommentInProjectState(
      state,
      createLocalCollabComment('Check the vocal comp at bar 9', 9, 1700000999000, 'c-persist'),
    );

    const serialized = serializeProjectState(withNote);
    const restored = normalizeProjectState((JSON.parse(serialized) as { state: unknown }).state);

    assert.deepEqual(restored.comments, withNote.comments);
    assert.equal(restored.comments[0].text, 'Check the vocal comp at bar 9');
    assert.equal(restored.comments[0].timestamp, 1700000999000);
  });

  it('round-trips a resolution change', () => {
    const state: ProjectState = { ...createDefaultProjectState(), comments: [comment('c-resolve')] };
    const resolved = toggleCollabCommentResolvedInProjectState(state, 'c-resolve');

    const restored = normalizeProjectState(
      (JSON.parse(serializeProjectState(resolved)) as { state: unknown }).state,
    );

    assert.equal(restored.comments[0].resolved, true);
  });

  it('restores collaborators that are actually stored in the document', () => {
    const state: ProjectState = {
      ...createDefaultProjectState(),
      collaborators: [{
        id: 'u-real',
        name: 'Session Mixer',
        color: '#00ff00',
        avatar: 'S',
        role: 'Mixing Engineer',
        status: 'idle',
        lastActive: 'recorded',
      }],
    };

    const restored = normalizeProjectState(
      (JSON.parse(serializeProjectState(state)) as { state: unknown }).state,
    );

    assert.deepEqual(restored.collaborators, state.collaborators);
  });
});
