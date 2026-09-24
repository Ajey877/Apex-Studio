import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSamplePack,
  getSampleLibraryCategories,
  getSampleLibraryTags,
  getSamplePackCounts,
  sampleMatchesFilters,
  updateSampleMetadata
} from './sampleLibrary';
import type { CustomSampleData } from '../types/daw';

const sample = (overrides: Partial<CustomSampleData> = {}): CustomSampleData => ({
  id: 'kick-1',
  name: '808 Punch',
  duration: 1,
  sampleRate: 48000,
  channels: 2,
  waveformPeaks: [0, 1, 0],
  tags: ['kick', '808'],
  category: 'Drums',
  packId: 'pack-drums',
  ...overrides
});

test('filters samples by pack, category, tag and search text', () => {
  const packs = [createSamplePack('Drums', 'Drums', ['one-shots'], 1)];
  packs[0].id = 'pack-drums';
  assert.equal(sampleMatchesFilters(sample(), packs, { packId: 'pack-drums' }), true);
  assert.equal(sampleMatchesFilters(sample(), packs, { category: 'Drums' }), true);
  assert.equal(sampleMatchesFilters(sample(), packs, { tag: '808' }), true);
  assert.equal(sampleMatchesFilters(sample(), packs, { query: 'punch' }), true);
  assert.equal(sampleMatchesFilters(sample(), packs, { query: 'snare' }), false);
});

test('metadata updates normalize names and tags', () => {
  const updated = updateSampleMetadata(sample(), {
    name: '  Kick  ',
    category: '  One Shots ',
    tags: ['808', ' KICK ', '808'],
    packId: 'pack-new'
  });
  assert.equal(updated.name, 'Kick');
  assert.equal(updated.category, 'One Shots');
  assert.deepEqual(updated.tags, ['808', 'kick']);
  assert.equal(updated.packId, 'pack-new');
});

test('library facets and pack counts are deterministic', () => {
  const samples = [
    sample(),
    sample({ id: 'snare-1', name: 'Snare', category: 'Drums', tags: ['snare'] }),
    sample({ id: 'vox-1', name: 'Vocal', category: 'Vocals', tags: ['vocal'], packId: undefined })
  ];
  const packs = [createSamplePack('Drums', 'Drums', [], 1)];
  packs[0].id = 'pack-drums';
  assert.deepEqual(getSampleLibraryCategories(samples), ['Drums', 'Vocals']);
  assert.deepEqual(getSampleLibraryTags(samples), ['808', 'kick', 'snare', 'vocal']);
  assert.equal(getSamplePackCounts(samples, packs)['pack-drums'], 2);
});
