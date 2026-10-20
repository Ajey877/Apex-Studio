import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  clampSampleRange,
  findSampleZone,
  getSamplePlaybackRate,
  isSupersededGeneratedSeedZone,
  matchesChannelSampleProjection,
} from './sampleZones';
import type { Channel, CustomSampleData, Note, SampleZone } from '../types/daw';

const note = (pitch: number, velocity: number): Note => ({ id: 'n', pitch, start: 0, duration: 1, velocity });
const zones: SampleZone[] = [
  { id: 'low', sampleId: 'soft', lowNote: 0, highNote: 59, rootNote: 48, lowVelocity: 0, highVelocity: 89, tuneSemitones: 0 },
  { id: 'high', sampleId: 'hard', lowNote: 60, highNote: 127, rootNote: 60, lowVelocity: 90, highVelocity: 127, tuneSemitones: 2 }
];

describe('sampler zone resolution', () => {
  test('selects by both key range and MIDI velocity', () => {
    assert.equal(findSampleZone(zones, note(48, 0.5))?.id, 'low');
    assert.equal(findSampleZone(zones, note(60, 1))?.id, 'high');
    assert.equal(findSampleZone(zones, note(48, 1))?.id, undefined);
  });
  test('uses root pitch and tuning for playback rate', () => {
    assert.equal(getSamplePlaybackRate(60, 60), 1);
    assert.ok(Math.abs(getSamplePlaybackRate(72, 60) - 2) < 1e-9);
    assert.ok(Math.abs(getSamplePlaybackRate(60, 60, 0, 12) - 2) < 1e-9);
  });
  test('clamps invalid trim ranges safely', () => {
    assert.deepEqual(clampSampleRange(-1, 2), { start: 0, end: 1 });
    assert.deepEqual(clampSampleRange(0.8, 0.2), { start: 0.8, end: 0.8 });
  });
});

describe('generated seed-zone provenance', () => {
  const sample = (overrides: Partial<CustomSampleData> = {}): CustomSampleData => ({
    id: 'sample-a',
    name: 'Sample A',
    duration: 2,
    sampleRate: 44100,
    channels: 1,
    waveformPeaks: [],
    trimStart: 0.15,
    trimEnd: 0.85,
    rootPitch: 48,
    reverse: true,
    ...overrides,
  });
  const channel = (overrides: Partial<Channel> = {}): Channel => ({
    id: 'ch-1',
    name: 'Sampler',
    color: '#fff',
    instrumentType: 'sampler',
    mixerTrackId: 1,
    volume: 1,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: [],
    notes: [],
    // Only `sampleLoop` participates in seed projection; the rest of the DSP
    // parameters are irrelevant to this predicate.
    synthParams: { sampleLoop: false } as Channel['synthParams'],
    customSample: sample(),
    ...overrides,
  });
  const seed = (overrides: Partial<SampleZone> = {}): SampleZone => ({
    id: 'zone-ch-1',
    sampleId: 'sample-a',
    lowNote: 0,
    highNote: 127,
    rootNote: 48,
    lowVelocity: 0,
    highVelocity: 127,
    tuneSemitones: 0,
    trimStart: 0.15,
    trimEnd: 0.85,
    reverse: true,
    ...overrides,
  });

  test('matches a zone that still projects the body sample and its playback settings', () => {
    assert.equal(matchesChannelSampleProjection(channel(), seed()), true);
    assert.equal(isSupersededGeneratedSeedZone(channel(), seed(), [sample()]), true);
  });

  test('recognises a legacy seed that an older build stamped userAuthored', () => {
    assert.equal(
      isSupersededGeneratedSeedZone(channel(), seed({ userAuthored: true }), [sample()]),
      true,
      'an untouched projection is still generated data even when flagged authored',
    );
  });

  test('preserves authored zones whose settings diverge from the body sample or whose id is not generated', () => {
    assert.equal(
      isSupersededGeneratedSeedZone(channel(), seed({ userAuthored: true, rootNote: 60 }), [sample()]),
      false,
      'an edited root note is user data',
    );
    assert.equal(
      isSupersededGeneratedSeedZone(channel(), seed({ id: 'zone-1234567890', userAuthored: true }), [sample()]),
      false,
      'a split zone id is never treated as the generated seed',
    );
    assert.equal(
      isSupersededGeneratedSeedZone(channel(), seed({ sampleId: 'other-sample', userAuthored: true }), [sample()]),
      false,
      'a zone mapped to another sample is authored data',
    );
    assert.equal(
      isSupersededGeneratedSeedZone(channel(), seed({ lowNote: 12, userAuthored: true }), [sample()]),
      false,
      'a partial key range is authored data',
    );
  });

  test('preserves zones with an explicit loop window and channels without a body sample', () => {
    assert.equal(
      isSupersededGeneratedSeedZone(
        channel(),
        seed({ userAuthored: true, loopStart: 0.2, loopEnd: 0.8 }),
        [sample()],
      ),
      false,
      'a loop window is an explicit edit',
    );

    const zoneOnlyChannel = channel({ customSample: undefined });
    assert.equal(
      isSupersededGeneratedSeedZone(zoneOnlyChannel, seed(), [sample()]),
      false,
      'a legacy zone-only mapping must survive a first sample assignment',
    );
  });
});
