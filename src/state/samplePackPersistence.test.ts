import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';

test('sample packs and sample organization metadata survive project serialization', () => {
  const state = createDefaultProjectState();
  state.samplePacks = [{
    id: 'pack-drums',
    name: 'Drum Essentials',
    description: 'Core one-shots',
    category: 'Drums',
    tags: ['one-shots', 'core'],
    created: 1,
    updated: 2
  }];
  state.sampleLibrary = [{
    id: 'kick-1',
    name: 'Kick',
    duration: 1,
    sampleRate: 48000,
    channels: 2,
    waveformPeaks: [0, 1, 0],
    packId: 'pack-drums',
    category: 'Drums',
    tags: ['kick', 'one-shots']
  }];

  const restored = normalizeProjectState(JSON.parse(serializeProjectState(state)).state);
  assert.deepEqual(restored.samplePacks, state.samplePacks);
  assert.deepEqual(restored.sampleLibrary, state.sampleLibrary);
});

test('legacy projects without sample packs remain valid', () => {
  const legacy = createDefaultProjectState();
  delete legacy.samplePacks;
  const restored = normalizeProjectState(JSON.parse(serializeProjectState(legacy)).state);
  assert.deepEqual(restored.samplePacks, undefined);
});
