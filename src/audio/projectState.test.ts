import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProjectState } from '../types/daw';
import { DEFAULT_PROJECT, PRESET_PROJECTS } from './presets';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import {
  updateChannelInProjectState,
  updatePatternInProjectState,
} from '../state/projectMutations';
import { createHistory } from '../state/projectHistory';

const roundTrip = (state: ReturnType<typeof createDefaultProjectState>) =>
  normalizeProjectState(JSON.parse(JSON.stringify(state)));

describe('ProjectState foundation', () => {
  it('creates a fresh valid blank project', () => {
    const first = createDefaultProjectState();
    const second = createDefaultProjectState();
    assert.notEqual(first, second);
    assert.notEqual(first.channels, second.channels);
    assert.equal(first.channels[0]?.mixerTrackId, 1);
    assert.equal(first.meta.name, 'Untitled Session');
  });

  it('does not share default application state with presets', () => {
    assert.notEqual(DEFAULT_PROJECT, PRESET_PROJECTS[0].state);
    const project = createDefaultProjectState();
    const originalName = PRESET_PROJECTS[0].state.meta.name;
    project.meta.name = 'Changed';
    project.channels[0].name = 'Changed Channel';
    assert.equal(PRESET_PROJECTS[0].state.meta.name, originalName);
    assert.notEqual(project.channels[0], PRESET_PROJECTS[0].state.channels[0]);
  });

  it('preserves a valid current project during normalization', () => {
    const source = createDefaultProjectState();
    source.meta.name = 'Production Session';
    source.channels[0].mixerTrackId = 7;
    const normalized = normalizeProjectState(source);
    assert.equal(normalized.meta.name, 'Production Session');
    assert.equal(normalized.channels[0].mixerTrackId, 7);
  });

  it('fills missing legacy fields without changing existing identities', () => {
    const source = createDefaultProjectState();
    const legacy = JSON.parse(JSON.stringify(source));
    delete legacy.comments;
    delete legacy.collaborators;
    delete legacy.midiMappings;
    legacy.channels[0].mixerTrackId = 42;
    legacy.mixerTracks[1].id = 42;

    const normalized = normalizeProjectState(legacy);
    assert.equal(normalized.channels[0].mixerTrackId, 42);
    assert.equal(normalized.mixerTracks[1].id, 42);
    assert.deepEqual(normalized.comments, []);
    assert.deepEqual(normalized.collaborators, []);
    assert.deepEqual(normalized.midiMappings, []);
  });

  it('rejects fundamentally invalid project data', () => {
    assert.throws(() => normalizeProjectState(null), /expected a project object/);
    assert.throws(() => normalizeProjectState({ meta: 'bad' }), /metadata is malformed/);
    assert.throws(() => normalizeProjectState({ meta: {}, channels: 'bad' }), /channels must be an array/);
  });

  it('does not mutate the parsed input', () => {
    const source = createDefaultProjectState();
    const parsed = JSON.parse(JSON.stringify(source));
    const before = JSON.stringify(parsed);
    const normalized = normalizeProjectState(parsed);
    normalized.meta.name = 'Changed';
    normalized.channels[0].name = 'Changed Channel';
    assert.equal(JSON.stringify(parsed), before);
  });

  it('normalizes imported legacy JSON into a valid ProjectState', () => {
    const source = createDefaultProjectState();
    const parsed = JSON.parse(JSON.stringify(source));
    delete parsed.comments;
    delete parsed.markers;
    const normalized = normalizeProjectState(parsed);
    assert.equal(normalized.meta.id, source.meta.id);
    assert.ok(Array.isArray(normalized.channels));
    assert.ok(Array.isArray(normalized.mixerTracks));
    assert.ok(Array.isArray(normalized.comments));
  });

  it('preserves important data across save and load', () => {
    const source = createDefaultProjectState();
    source.meta.name = 'Round Trip';
    source.patterns.push({ id: 'pat-2', name: 'Second', color: '#fff', lengthSteps: 32 });
    source.channels[0].mixerTrackId = 6;
    const loaded = roundTrip(source);
    assert.equal(loaded.meta.name, source.meta.name);
    assert.deepEqual(loaded.patterns, source.patterns);
    assert.equal(loaded.channels[0].mixerTrackId, 6);
  });

  it('keeps all preset projects valid and independent when cloned', () => {
    for (const preset of PRESET_PROJECTS) {
      const normalized = normalizeProjectState(JSON.parse(JSON.stringify(preset.state)));
      assert.equal(normalized.meta.id, preset.state.meta.id);
      assert.equal(normalized.channels.length, preset.state.channels.length);
      assert.notEqual(normalized.channels, preset.state.channels);
    }
  });
});

describe('Preset immutability and project isolation', () => {
  /** Preset documents are legacy shapes: `normalizeProjectState` fills newer
   *  defaults (`grossBeatState`, `macroKnobs`, ...) and drops obsolete fields
   *  (`stereoWidth`) on the LOADED copy. Compare only the fields the presets
   *  actually declare so normalization noise does not mask real aliasing. */
  const declared = (state: ProjectState) => ({
    meta: state.meta,
    patterns: state.patterns,
    selectedPatternId: state.selectedPatternId,
    channels: state.channels,
    selectedChannelId: state.selectedChannelId,
    playlistTracks: state.playlistTracks,
    playlistClips: state.playlistClips,
    mixerTracks: state.mixerTracks,
    selectedMixerTrackId: state.selectedMixerTrackId,
    nextMixerTrackId: state.nextMixerTrackId,
    recordings: state.recordings,
    comments: state.comments,
    collaborators: state.collaborators,
    midiMappings: state.midiMappings,
  });

  // The catalog's own declared fields: the ground truth that must never change.
  const catalogOf = (preset: (typeof PRESET_PROJECTS)[number]) => declared(preset.state);

  // What a freshly instantiated preset should look like: a normalized copy.
  const expectedLoaded = (preset: (typeof PRESET_PROJECTS)[number]) =>
    declared(normalizeProjectState(structuredClone(preset.state)));

  // A genuinely detached snapshot of a preset's canonical catalog state.
  // `structuredClone` breaks every reference into the live catalog, so an
  // in-place mutation taken after the snapshot is detectable by deep
  // comparison (unlike `catalogOf`, which retains live references).
  const snapshotCatalog = (preset: (typeof PRESET_PROJECTS)[number]) =>
    structuredClone(preset.state);

  it('instantiating a preset gives independent nested state (no shared references)', () => {
    const preset = PRESET_PROJECTS[0];
    const catalogBefore = snapshotCatalog(preset);
    const loaded = normalizeProjectState(preset.state);

    assert.notEqual(loaded, preset.state);
    assert.notEqual(loaded.meta, preset.state.meta);
    assert.notEqual(loaded.channels, preset.state.channels);
    assert.notEqual(loaded.channels[0], preset.state.channels[0]);
    assert.notEqual(loaded.channels[0].notes, preset.state.channels[0].notes);
    assert.notEqual(loaded.channels[0].steps, preset.state.channels[0].steps);
    assert.notEqual(loaded.patterns, preset.state.patterns);
    assert.notEqual(loaded.playlistClips, preset.state.playlistClips);
    assert.notEqual(loaded.mixerTracks, preset.state.mixerTracks);

    // Declared content survives the load unchanged on the copy.
    assert.deepEqual(declared(loaded), expectedLoaded(preset));
    // The catalog itself is not altered by instantiation (detached comparison).
    assert.deepEqual(structuredClone(preset.state), catalogBefore);
  });

  it('editing notes in an instantiated preset does not mutate the canonical definition', () => {
    const preset = PRESET_PROJECTS[0];
    const catalogBefore = snapshotCatalog(preset);
    const loaded = normalizeProjectState(preset.state);

    const kick = loaded.channels.find(ch => ch.id === 'ch-kick')!;
    const before = kick.notes.length;

    const edited = updateChannelInProjectState(loaded, 'ch-kick', {
      notes: [...kick.notes, { id: 'n-edit', pitch: 99, start: 0, duration: 1, velocity: 1.0 }],
    });

    assert.equal(edited.channels.find(ch => ch.id === 'ch-kick')!.notes.length, before + 1);
    // Canonical definition untouched (detached comparison).
    assert.deepEqual(structuredClone(preset.state), catalogBefore);
    assert.equal(preset.state.channels.find(ch => ch.id === 'ch-kick')!.notes.length, before);
    assert.equal(
      preset.state.channels.find(ch => ch.id === 'ch-kick')!.notes.some((n: { id: string }) => n.id === 'n-edit'),
      false
    );
  });

  it('editing steps in an instantiated preset does not mutate the canonical definition', () => {
    const preset = PRESET_PROJECTS[0];
    const catalogBefore = snapshotCatalog(preset);
    const loaded = normalizeProjectState(preset.state);

    const kick = loaded.channels.find(ch => ch.id === 'ch-kick')!;
    const editedSteps = kick.steps.map((cell, index) => index === 0 ? false : cell);

    const edited = updateChannelInProjectState(loaded, 'ch-kick', { steps: editedSteps });
    assert.equal(edited.channels.find(ch => ch.id === 'ch-kick')!.steps[0], false);

    assert.deepEqual(structuredClone(preset.state), catalogBefore);
    assert.equal(preset.state.channels.find(ch => ch.id === 'ch-kick')!.steps[0], true);
  });

  it('editing pattern length in an instantiated preset does not mutate the canonical definition', () => {
    const preset = PRESET_PROJECTS[0];
    const catalogBefore = snapshotCatalog(preset);
    const loaded = normalizeProjectState(preset.state);

    const edited = updatePatternInProjectState(loaded, 'pat-1', { lengthSteps: 32 });
    assert.equal(edited.patterns.find(p => p.id === 'pat-1')!.lengthSteps, 32);

    assert.deepEqual(structuredClone(preset.state), catalogBefore);
    assert.equal(preset.state.patterns.find(p => p.id === 'pat-1')!.lengthSteps, 16);
  });

  it('reloading the same preset after an earlier session edit yields pristine content', () => {
    const preset = PRESET_PROJECTS[0];
    const catalogBefore = snapshotCatalog(preset);

    const loaded = normalizeProjectState(preset.state);
    const edited = updateChannelInProjectState(loaded, 'ch-kick', {
      notes: [...loaded.channels.find(ch => ch.id === 'ch-kick')!.notes, { id: 'n-edit', pitch: 99, start: 0, duration: 1, velocity: 1.0 }],
    });
    assert.ok(edited.channels.find(ch => ch.id === 'ch-kick')!.notes.some((n: { id: string }) => n.id === 'n-edit'));

    const reloaded = normalizeProjectState(preset.state);
    assert.deepEqual(declared(reloaded), expectedLoaded(preset));
    assert.deepEqual(structuredClone(preset.state), catalogBefore);
  });

  it('undo/redo over a preset edit does not mutate the preset catalog', () => {
    const preset = PRESET_PROJECTS[0];
    const catalogBefore = snapshotCatalog(preset);
    const loaded = normalizeProjectState(preset.state);

    let history = createHistory(loaded);
    const edited = updateChannelInProjectState(history.present, 'ch-kick', {
      notes: [...history.present.channels.find(ch => ch.id === 'ch-kick')!.notes, { id: 'n-edit', pitch: 99, start: 0, duration: 1, velocity: 1.0 }],
    });
    history = history.commit(edited, 'Edit notes');

    const undone = history.undo();
    const redone = undone.redo();

    assert.equal(redone.present.channels.find(ch => ch.id === 'ch-kick')!.notes.some((n: { id: string }) => n.id === 'n-edit'), true);
    assert.equal(undone.present.channels.find(ch => ch.id === 'ch-kick')!.notes.some((n: { id: string }) => n.id === 'n-edit'), false);

    assert.deepEqual(structuredClone(preset.state), catalogBefore);
  });

  it('all shipped presets instantiate independently of the catalog and each other', () => {
    const snapshots = PRESET_PROJECTS.map(snapshotCatalog);
    const expected = PRESET_PROJECTS.map(expectedLoaded);
    const loaded = PRESET_PROJECTS.map(preset => normalizeProjectState(preset.state));

    loaded.forEach((state, index) => {
      assert.notEqual(state, PRESET_PROJECTS[index].state);
      assert.notEqual(state.channels, PRESET_PROJECTS[index].state.channels);
      assert.notEqual(state.channels[0], PRESET_PROJECTS[index].state.channels[0]);
      assert.notEqual(state.channels[0].notes, PRESET_PROJECTS[index].state.channels[0].notes);
      assert.deepEqual(declared(state), expected[index]);
    });
    PRESET_PROJECTS.forEach((preset, index) =>
      assert.deepEqual(structuredClone(preset.state), snapshots[index])
    );
  });

  it('an edited session does not leak into a subsequently loaded preset catalog', () => {
    const presetA = PRESET_PROJECTS[0];
    const presetB = PRESET_PROJECTS[1];
    const catalogBeforeA = snapshotCatalog(presetA);
    const catalogBeforeB = snapshotCatalog(presetB);

    const sessionA = normalizeProjectState(presetA.state);
    const editedA = updateChannelInProjectState(sessionA, 'ch-kick', {
      notes: [...sessionA.channels.find(ch => ch.id === 'ch-kick')!.notes, { id: 'n-edit', pitch: 99, start: 0, duration: 1, velocity: 1.0 }],
    });

    // The edit genuinely took effect on the instantiated session.
    assert.equal(
      editedA.channels.find(ch => ch.id === 'ch-kick')!.notes.some((n: { id: string }) => n.id === 'n-edit'),
      true
    );

    // Loading preset B afterwards yields pristine content.
    const loadedB = normalizeProjectState(presetB.state);
    assert.deepEqual(declared(loadedB), expectedLoaded(presetB));

    // Neither catalog was mutated by the edited session or by loading B
    // (detached comparison, so in-place mutation would be detected).
    assert.deepEqual(structuredClone(presetA.state), catalogBeforeA);
    assert.deepEqual(structuredClone(presetB.state), catalogBeforeB);

    // Loaded B is pristine: its kick-equivalent channel keeps its single note.
    assert.equal(presetB.state.channels.find(ch => ch.id === 'ch-sw-kick')!.notes.length, 1);
  });
});

