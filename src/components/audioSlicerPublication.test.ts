import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AudioSlice } from '../utils/audioSlicer';
import type { SlicerAudioSource } from './audioSlicerSource';
import {
  MAX_SLICER_CHOPS,
  SLICER_CHOP_ROOT_NOTE,
  buildSlicerChops,
  isSlicerChopPublished,
  isSlicerChopRefused,
  publishSlicerChops,
  slicerChopNotes,
  slicerChopPads,
  slicerChopPianoRollMessage,
  slicerChopRegionIssue,
  slicerChopStepSequencerMessage,
  slicerChopSteps,
} from './audioSlicerPublication';

const slice = (over: Partial<AudioSlice> = {}): AudioSlice => ({
  id: 0,
  startSec: 0,
  endSec: 0.25,
  startRatio: 0,
  endRatio: 0.25,
  gain: 1,
  rootKey: 60,
  padIndex: 0,
  ...over,
});

/** `count` contiguous regions of `lengthSec` each inside a `totalSec` buffer. */
const regions = (count: number, lengthSec = 0.25, totalSec = 4): AudioSlice[] =>
  Array.from({ length: count }, (_, index) =>
    slice({
      id: index,
      startSec: index * lengthSec,
      endSec: (index + 1) * lengthSec,
      startRatio: (index * lengthSec) / totalSec,
      endRatio: ((index + 1) * lengthSec) / totalSec,
      padIndex: index % 16,
      rootKey: 60 + index,
    })
  );

const source = (durationSec = 4, sampleId = 'sample-1'): SlicerAudioSource => ({
  kind: 'sample',
  sampleId,
  buffer: { duration: durationSec } as AudioBuffer,
});

const unavailableSource: SlicerAudioSource = { kind: 'no-sample', channelName: 'Vox Chop' };

describe('Phase 55 — Slicer chop publication integrity', () => {
  it('publishes exactly one chop per detected slice, in slice order', () => {
    const detected = regions(5);
    const result = publishSlicerChops(detected, source());

    assert.ok(isSlicerChopPublished(result));
    assert.equal(result.chops.length, 5);
    assert.equal(result.publishedCount, 5);
    assert.equal(result.droppedCount, 0);
    assert.deepEqual(
      result.chops.map(chop => chop.sliceId),
      [0, 1, 2, 3, 4]
    );
    assert.deepEqual(
      result.chops.map(chop => chop.index),
      [0, 1, 2, 3, 4]
    );
  });

  it('keeps the real detected region on every published chop', () => {
    const detected = regions(3, 0.5, 3);
    const result = publishSlicerChops(detected, source(3));

    assert.ok(isSlicerChopPublished(result));
    assert.deepEqual(
      result.chops.map(chop => [chop.startSec, chop.endSec]),
      [
        [0, 0.5],
        [0.5, 1],
        [1, 1.5],
      ]
    );
    assert.deepEqual(
      result.chops.map(chop => [chop.startRatio, chop.endRatio]),
      [
        [0, 1 / 6],
        [1 / 6, 1 / 3],
        [1 / 3, 0.5],
      ]
    );
    assert.deepEqual(
      result.chops.map(chop => chop.durationSec),
      [0.5, 0.5, 0.5]
    );
  });

  it('publishes chops as pads trimmed to the real region of the real sample', () => {
    const result = publishSlicerChops(regions(4, 0.25, 4), source(4, 'break-9'));

    assert.ok(isSlicerChopPublished(result));
    assert.equal(result.pads.length, 4);
    result.pads.forEach((pad, index) => {
      assert.equal(pad.sampleId, 'break-9', 'every chop must point at the sliced sample');
      assert.equal(pad.note, SLICER_CHOP_ROOT_NOTE + index);
      assert.equal(pad.trimStart, result.chops[index].startRatio);
      assert.equal(pad.trimEnd, result.chops[index].endRatio);
    });
    assert.deepEqual(
      result.pads.map(pad => pad.trimStart),
      [0, 0.0625, 0.125, 0.1875]
    );
  });

  it('publishes one piano-roll note per chop, pitched at that chop', () => {
    const chops = buildSlicerChops(regions(6, 0.1, 6), 'sample-1');
    const notes = slicerChopNotes(chops);

    assert.equal(notes.length, chops.length);
    assert.deepEqual(
      notes.map(note => note.pitch),
      chops.map(chop => chop.note)
    );
    assert.deepEqual(
      notes.map(note => note.start),
      [0, 1, 2, 3, 4, 5]
    );
    notes.forEach(note => {
      assert.ok(note.velocity > 0 && note.velocity <= 1);
      assert.ok(note.duration > 0);
    });
  });

  it('caps the publication at sixteen chops and reports the overflow', () => {
    const detected = regions(20, 0.1, 20);
    const result = publishSlicerChops(detected, source(20));

    assert.ok(isSlicerChopPublished(result));
    assert.equal(result.publishedCount, MAX_SLICER_CHOPS);
    assert.equal(result.chops.length, MAX_SLICER_CHOPS);
    assert.equal(result.pads.length, MAX_SLICER_CHOPS);
    assert.equal(result.notes.length, MAX_SLICER_CHOPS);
    assert.equal(result.droppedCount, 4, 'the dropped chops must be counted, not hidden');
    assert.ok(slicerChopPianoRollMessage(result).includes('4 chops past the 16-chop bank'));
  });

  it('refuses to publish when there is no real sample behind the slicer', () => {
    const result = publishSlicerChops(regions(4), unavailableSource);

    assert.ok(isSlicerChopRefused(result));
    assert.equal(result.code, 'no-source');
    assert.ok(result.message.includes('no sample assigned'));
    assert.deepEqual(buildSlicerChops(regions(4), 'sample-1').length, 4, 'the refusal must come from the source, not the slices');
  });

  it('refuses to publish an empty slice set', () => {
    const result = publishSlicerChops([], source());

    assert.ok(isSlicerChopRefused(result));
    assert.equal(result.code, 'no-slices');
    assert.equal(slicerChopRegionIssue([], 4), 'no-slices');
  });

  it('refuses regions that end before they start', () => {
    const inverted = [slice({ id: 0, startSec: 0.5, endSec: 0.5, startRatio: 0.5, endRatio: 0.5 })];
    const result = publishSlicerChops(inverted, source());

    assert.ok(isSlicerChopRefused(result));
    assert.equal(result.code, 'inverted-region');
    assert.ok(result.message.includes('Detect chops again'));
  });

  it('refuses regions that fall outside the loaded sample', () => {
    const stale = [slice({ id: 0, startSec: 0, endSec: 9, startRatio: 0, endRatio: 1.6 })];
    const result = publishSlicerChops(stale, source(2));

    assert.ok(isSlicerChopRefused(result), 'stale regions from another buffer must never be published');
    assert.equal(result.code, 'region-out-of-range');
  });

  it('refuses overlapping or out-of-order regions', () => {
    const overlapping = [
      slice({ id: 0, startSec: 0, endSec: 1, startRatio: 0, endRatio: 0.25 }),
      slice({ id: 1, startSec: 0.5, endSec: 1.5, startRatio: 0.125, endRatio: 0.375 }),
    ];
    const result = publishSlicerChops(overlapping, source(4));

    assert.ok(isSlicerChopRefused(result));
    assert.equal(result.code, 'slices-out-of-order');
    assert.equal(slicerChopRegionIssue(regions(4, 0.25, 4), 4), null, 'contiguous regions must stay publishable');
  });

  it('arms one step per chop without shortening the existing pattern', () => {
    const chops = buildSlicerChops(regions(5, 0.2, 4), 'sample-1');

    assert.deepEqual(slicerChopSteps(chops, 16).filter(Boolean).length, 5);
    assert.equal(slicerChopSteps(chops, 32).length, 32, 'a 32-step pattern must survive publication');
    assert.deepEqual(slicerChopSteps(chops, 32).filter(Boolean).length, 5);
    assert.deepEqual(slicerChopSteps(chops, 16).slice(0, 6), [true, true, true, true, true, false]);

    const result = publishSlicerChops(regions(5, 0.2, 4), source(4), { stepCount: 32 });
    assert.ok(isSlicerChopPublished(result));
    assert.equal(result.steps.length, 32);
    assert.equal(result.steps.filter(Boolean).length, 5);
  });

  it('reports the single-pitch step sequencer limitation instead of claiming distinct chops', () => {
    const result = publishSlicerChops(regions(8, 0.1, 8), source(8));
    assert.ok(isSlicerChopPublished(result));

    const message = slicerChopStepSequencerMessage(result);
    assert.ok(message.includes('8 chops published'), message);
    assert.ok(message.includes('8 steps armed'), message);
    assert.ok(/single sequencer pitch/i.test(message), message);
    assert.ok(/chop 1/.test(message), message);

    const pianoRollMessage = slicerChopPianoRollMessage(result);
    assert.ok(pianoRollMessage.includes('8 chops published'), pianoRollMessage);
    assert.ok(!/16/.test(pianoRollMessage), 'the summary must not claim sixteen of anything');

    // A refusal is a summary too: it must reach the user verbatim rather than
    // being replaced by a success claim.
    const failure = publishSlicerChops([], source());
    assert.ok(isSlicerChopRefused(failure));
    assert.equal(slicerChopPianoRollMessage(failure), failure.message);
    assert.equal(slicerChopStepSequencerMessage(failure), failure.message);
  });

  it('wires the slicer modal to the audited chop publisher', () => {
    const modal = readFileSync(
      path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'AudioSlicerModal.tsx'),
      'utf8'
    );

    assert.ok(modal.includes('publishSlicerChops'), 'the modal must publish through the audited module');
    assert.ok(modal.includes('slicerChopPianoRollMessage'), 'the piano-roll action must use the audited summary');
    assert.ok(modal.includes('slicerChopStepSequencerMessage'), 'the step action must use the audited summary');
    assert.ok(modal.includes('drumPads: publication.pads'), 'both actions must publish the real chop pads');
    assert.ok(modal.includes("instrumentType: 'drumpad'"), 'published chops must land on a channel that can play them');
    assert.ok(
      modal.includes('isSlicerChopRefused(publication)'),
      'a refused publication must be shown, not published anyway'
    );
  });

  it('leaves no count-only chop mapping behind in the slicer modal', () => {
    const modal = readFileSync(
      path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'AudioSlicerModal.tsx'),
      'utf8'
    );

    // The old mapping rebuilt notes and steps from the slice index alone and
    // discarded every region the detector had measured.
    assert.ok(!/pitch:\s*60\s*\+\s*idx/.test(modal), 'chop notes must not be rebuilt from the index');
    assert.ok(!/start:\s*idx\s*\*\s*1/.test(modal), 'chop placement must not be the discarded placeholder');
    assert.ok(!/steps\[idx\]\s*=\s*true/.test(modal), 'steps must not be armed from the index alone');
    assert.ok(!/Successfully mapped \$\{/.test(modal), 'the unqualified success toast must be gone');
    assert.ok(!/Chops mapped to 16 step sequencer/.test(modal), 'the unqualified step toast must be gone');
    assert.ok(
      slicerChopPads(buildSlicerChops(regions(2, 0.5, 2), 'sample-1')).every(pad => pad.sampleId),
      'every published pad must carry a real sample id'
    );
  });
});
