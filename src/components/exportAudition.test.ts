/**
 * Phase — Export Audition Player: focused tests.
 *
 * The audition player lives inside `ExportModal.tsx`. The component renders
 * an in-modal `<audio>` element over the existing WAV download URL so a user
 * can preview the render before downloading. This file pins the two pieces
 * of the feature that are deterministically testable without a browser:
 *
 *   1. The pure gating helper `canAuditionExport(format, hasDownloadUrl)`
 *      decides whether the audition UI is visible. MIDI and stem-zip blobs
 *      are not audible so they must hide the audition block.
 *   2. The pure time-formatting helper `formatAuditionTime(seconds)` renders
 *      durations as `m:ss`.
 *
 * These two helpers are also used by the component itself (via the `canAudition`
 * alias) so the static-render structure and the unit tests stay in sync.
 * The component itself is exercised end-to-end in the browser via the manual
 * QA flow that ships with every release.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canAuditionExport, formatAuditionTime } from './ExportModal';

test('canAuditionExport — WAV formats are auditable when a download URL exists', () => {
  assert.equal(canAuditionExport('wav16', true), true, 'wav16 must audition');
  assert.equal(canAuditionExport('wav24', true), true, 'wav24 must audition');
  assert.equal(canAuditionExport('wav32', true), true, 'wav32 must audition');
});

test('canAuditionExport — MIDI and stems are NOT auditable even with a download URL', () => {
  assert.equal(canAuditionExport('midi', true), false, 'MIDI blob is not an audio file the <audio> element can play');
  assert.equal(canAuditionExport('stems', true), false, 'stem-zip blob is not an audio file the <audio> element can play');
});

test('canAuditionExport — no download URL disables the audition block for every format', () => {
  // Even the WAV formats must hide the audition UI before the export completes;
  // exposing an <audio src={null}> would render an empty control.
  assert.equal(canAuditionExport('wav16', false), false);
  assert.equal(canAuditionExport('wav24', false), false);
  assert.equal(canAuditionExport('wav32', false), false);
  assert.equal(canAuditionExport('midi', false), false);
  assert.equal(canAuditionExport('stems', false), false);
});

test('formatAuditionTime — formats seconds as m:ss with zero-padded seconds', () => {
  assert.equal(formatAuditionTime(0), '0:00');
  assert.equal(formatAuditionTime(1), '0:01');
  assert.equal(formatAuditionTime(9), '0:09');
  assert.equal(formatAuditionTime(10), '0:10');
  assert.equal(formatAuditionTime(59), '0:59');
  // The minute boundary must roll over without an hours digit.
  assert.equal(formatAuditionTime(60), '1:00');
  assert.equal(formatAuditionTime(61), '1:01');
  assert.equal(formatAuditionTime(125), '2:05');
  assert.equal(formatAuditionTime(599), '9:59');
  // Sub-second precision must floor (the player reads currentTime in seconds).
  assert.equal(formatAuditionTime(0.999), '0:00');
  assert.equal(formatAuditionTime(59.9), '0:59');
});

test('formatAuditionTime — non-finite or negative inputs degrade to 0:00', () => {
  assert.equal(formatAuditionTime(NaN), '0:00');
  assert.equal(formatAuditionTime(Infinity), '0:00');
  assert.equal(formatAuditionTime(-Infinity), '0:00');
  assert.equal(formatAuditionTime(-5), '0:00');
});
