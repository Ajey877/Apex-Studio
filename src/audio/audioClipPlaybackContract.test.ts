import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlaylistClip } from '../types/daw';
import { getAudioClipPlaybackContract, shouldSkipAudioClip } from './audioClipPlaybackContract';

const clip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-1',
  trackIndex: 0,
  startBar: 2,
  lengthBars: 4,
  type: 'audio',
  audioBufferId: 'audio-1',
  color: '#fff',
  name: 'Audio',
  ...overrides,
});

test('basic audio clip contract converts bars to seconds and starts at source zero', () => {
  const result = getAudioClipPlaybackContract(clip(), 120, 20);
  assert.ok(result);
  assert.equal(result.startSeconds, 4);
  assert.equal(result.clipDurationSeconds, 8);
  assert.equal(result.sourceOffsetSeconds, 0);
  assert.equal(result.sourceDurationSeconds, 8);
  assert.equal(result.playbackRate, 1);
  assert.equal(result.pitchShiftSemitones, 0);
});

test('split clip source offset advances by the left clip length', () => {
  const result = getAudioClipPlaybackContract(clip({ startBar: 4, lengthBars: 2, offsetSteps: 32 }), 120, 20);
  assert.ok(result);
  assert.equal(result.startSeconds, 8);
  assert.equal(result.clipDurationSeconds, 4);
  assert.equal(result.sourceOffsetSeconds, 4);
  assert.equal(result.sourceDurationSeconds, 4);
});

test('resize-left semantics preserve source alignment through offsetSteps', () => {
  const result = getAudioClipPlaybackContract(clip({ startBar: 1, lengthBars: 5, offsetSteps: 16 }), 120, 20);
  assert.ok(result);
  assert.equal(result.startSeconds, 2);
  assert.equal(result.clipDurationSeconds, 10);
  assert.equal(result.sourceOffsetSeconds, 2);
});

test('resize-right changes clip duration without changing source offset', () => {
  const result = getAudioClipPlaybackContract(clip({ lengthBars: 6, offsetSteps: 24 }), 120, 20);
  assert.ok(result);
  assert.equal(result.clipDurationSeconds, 12);
  assert.equal(result.sourceOffsetSeconds, 3);
  assert.equal(result.sourceDurationSeconds, 12);
});

test('playback rate is clamped to the existing 0.5x-2x contract', () => {
  assert.equal(getAudioClipPlaybackContract(clip({ timeStretchRate: 0.5 }), 120, 20)?.playbackRate, 0.5);
  assert.equal(getAudioClipPlaybackContract(clip({ timeStretchRate: 1 }), 120, 20)?.playbackRate, 1);
  assert.equal(getAudioClipPlaybackContract(clip({ timeStretchRate: 2 }), 120, 20)?.playbackRate, 2);
  assert.equal(getAudioClipPlaybackContract(clip({ timeStretchRate: 10 }), 120, 20)?.playbackRate, 2);
});

test('source duration accounts for playback rate while preserving clip output duration', () => {
  const half = getAudioClipPlaybackContract(clip({ lengthBars: 2, timeStretchRate: 0.5 }), 120, 20);
  const double = getAudioClipPlaybackContract(clip({ lengthBars: 2, timeStretchRate: 2 }), 120, 20);
  assert.equal(half?.clipDurationSeconds, 4);
  assert.equal(half?.sourceDurationSeconds, 2);
  assert.equal(double?.clipDurationSeconds, 4);
  assert.equal(double?.sourceDurationSeconds, 8);
});

test('pitch shift is clamped to the existing +/-24 semitone contract', () => {
  assert.equal(getAudioClipPlaybackContract(clip({ pitchShiftSemitones: -24 }), 120, 20)?.pitchShiftSemitones, -24);
  assert.equal(getAudioClipPlaybackContract(clip({ pitchShiftSemitones: 24 }), 120, 20)?.pitchShiftSemitones, 24);
  assert.equal(getAudioClipPlaybackContract(clip({ pitchShiftSemitones: 48 }), 120, 20)?.pitchShiftSemitones, 24);
});

test('fades are expressed in seconds and remain inside the clip boundary', () => {
  const result = getAudioClipPlaybackContract(clip({ fadeInBars: 1, fadeOutBars: 1 }), 120, 20);
  assert.ok(result);
  assert.equal(result.fadeInSeconds, 2);
  assert.equal(result.fadeOutSeconds, 2);
  assert.equal(result.fadeOutStartSeconds, 6);
});

test('zero fades remain zero rather than introducing an artificial envelope', () => {
  const result = getAudioClipPlaybackContract(clip(), 120, 20);
  assert.ok(result);
  assert.equal(result.fadeInSeconds, 0);
  assert.equal(result.fadeOutSeconds, 0);
  assert.equal(result.fadeOutStartSeconds, result.clipDurationSeconds);
});

test('source boundaries reject an offset at or beyond the decoded buffer duration', () => {
  assert.equal(getAudioClipPlaybackContract(clip({ offsetSteps: 160 }), 120, 20), null);
  assert.equal(getAudioClipPlaybackContract(clip({ offsetSteps: 160 }), 120, 10), null);
});

test('short buffers clip source duration to the available source region', () => {
  const result = getAudioClipPlaybackContract(clip({ lengthBars: 8 }), 120, 5);
  assert.ok(result);
  assert.equal(result.clipDurationSeconds, 16);
  assert.equal(result.sourceDurationSeconds, 5);
});

test('clip mute and channel mute are both skip conditions', () => {
  assert.equal(shouldSkipAudioClip(clip(), false), false);
  assert.equal(shouldSkipAudioClip(clip({ mute: true }), false), true);
  assert.equal(shouldSkipAudioClip(clip(), true), true);
});
