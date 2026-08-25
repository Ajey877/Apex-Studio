import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PROJECT, PRESET_PROJECTS } from './presets';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';

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
