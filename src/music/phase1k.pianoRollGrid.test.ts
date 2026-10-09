/**
 * Phase 1K — meter-aware Piano Roll grid model (pure).
 *
 * Pins: 4/4 and 3/4 keep their historical quarter-note decoration exactly
 * (running quarter labels, strong lines on every quarter); 6/8 and 7/8 draw
 * bar / beat-group / eighth-pulse lines and per-bar pulse labels that match
 * the metronome's accent grouping. Navigation deltas follow the meter: the
 * historical Shift+Arrow quarter nudge stays 4 steps in 4/4/3/4 and becomes
 * one eighth (2 steps) in 6/8 and 7/8; one-bar navigation is the real bar.
 * Nothing here moves notes — storage stays sixteenth steps.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePianoRollGridModel, pianoRollNavigationDeltas } from './pianoRollGrid';

describe('Phase 1K TEST 1 — 4/4 and 3/4 keep the historical quarter-note grid', () => {
  it('4/4 labels every quarter step with a running quarter count', () => {
    const model = resolvePianoRollGridModel([4, 4], '2+2+3', 32);
    assert.equal(model.legacyQuarterDecoration, true);
    assert.equal(model.stepsPerBar, 16);
    assert.equal(model.stepsPerPulse, 4);
    for (let step = 0; step < 32; step += 1) {
      const deco = model.steps[step];
      if (step % 4 === 0) {
        assert.equal(deco.strength, 'pulse', `4/4 step ${step} is a quarter line`);
        assert.equal(deco.label, String(step / 4 + 1), `4/4 step ${step} keeps the running label`);
      } else {
        assert.equal(deco.strength, 'none', `4/4 step ${step} is a plain step`);
        assert.equal(deco.label, null);
      }
    }
  });

  it('3/4 keeps the same quarter scheme (labels run across bars)', () => {
    const model = resolvePianoRollGridModel([3, 4], '2+2+3', 24);
    assert.equal(model.legacyQuarterDecoration, true);
    assert.equal(model.stepsPerBar, 12);
    assert.deepEqual(
      model.steps.filter(s => s.label !== null).map(s => s.label),
      ['1', '2', '3', '4', '5', '6'],
    );
  });

  it('navigation deltas keep the historical quarter nudge in /4 meters', () => {
    const model = resolvePianoRollGridModel([4, 4], '2+2+3', 32);
    assert.deepEqual(pianoRollNavigationDeltas(model), { pulseSteps: 4, barSteps: 16 });
    const waltz = resolvePianoRollGridModel([3, 4], '2+2+3', 24);
    assert.deepEqual(pianoRollNavigationDeltas(waltz), { pulseSteps: 4, barSteps: 12 });
  });
});

describe('Phase 1K TEST 2 — 6/8 grid shows the two dotted-quarter groups', () => {
  const model = resolvePianoRollGridModel([6, 8], '2+2+3', 24);

  it('eighth pulses carry per-bar labels 1..6 with two sixteenth steps each', () => {
    assert.equal(model.legacyQuarterDecoration, false);
    assert.equal(model.stepsPerBar, 12);
    assert.equal(model.stepsPerPulse, 2);
    const labels = model.steps.slice(0, 12).map(s => s.label);
    assert.deepEqual(labels, ['1', null, '2', null, '3', null, '4', null, '5', null, '6', null]);
    // Bar 2 restarts the pulse count.
    assert.equal(model.steps[12].label, '1');
  });

  it('bar lines and dotted-quarter group starts are distinct from plain eighths', () => {
    // 6/8 group starts are pulses 0 and 3 (steps 0 and 6).
    assert.equal(model.steps[0].strength, 'bar');
    assert.equal(model.steps[6].strength, 'group');
    assert.equal(model.steps[2].strength, 'pulse'); // eighth 2
    assert.equal(model.steps[12].strength, 'bar'); // bar 2 line
    assert.equal(model.steps[18].strength, 'group'); // bar 2 second group
    assert.equal(model.steps[1].strength, 'none');
    // Group membership: pulses 0-2 in group 0, pulses 3-5 in group 1.
    assert.equal(model.steps[0].groupIndexInBar, 0);
    assert.equal(model.steps[4].groupIndexInBar, 0);
    assert.equal(model.steps[6].groupIndexInBar, 1);
    assert.equal(model.steps[10].groupIndexInBar, 1);
    assert.deepEqual(model.layout.groups, [3, 3]);
  });

  it('navigation: one eighth per Shift+Arrow, one 6/8 bar (12 steps) per bar', () => {
    assert.deepEqual(pianoRollNavigationDeltas(model), { pulseSteps: 2, barSteps: 12 });
  });
});

describe('Phase 1K TEST 3 — 7/8 grid follows the selected grouping', () => {
  it('labels seven eighth pulses per bar and marks the 2+2+3 group starts', () => {
    const model = resolvePianoRollGridModel([7, 8], '2+2+3', 28);
    assert.equal(model.stepsPerBar, 14);
    assert.deepEqual(
      model.steps.slice(0, 14).map(s => s.label),
      ['1', null, '2', null, '3', null, '4', null, '5', null, '6', null, '7', null],
    );
    // 2+2+3: group starts at pulses 0, 2, 4 (steps 0, 4, 8).
    assert.equal(model.steps[0].strength, 'bar');
    assert.equal(model.steps[4].strength, 'group');
    assert.equal(model.steps[8].strength, 'group');
    assert.equal(model.steps[2].strength, 'pulse');
    assert.deepEqual(model.layout.groups, [2, 2, 3]);
    assert.equal(model.steps[12].groupIndexInBar, 2);
  });

  it('3+2+2 and 2+3+2 move the group lines without moving any step labels', () => {
    const b = resolvePianoRollGridModel([7, 8], '3+2+2', 14);
    assert.deepEqual(b.layout.groups, [3, 2, 2]);
    assert.equal(b.steps[0].strength, 'bar');
    assert.equal(b.steps[6].strength, 'group'); // pulse 3
    assert.equal(b.steps[10].strength, 'group'); // pulse 5
    assert.equal(b.steps[4].strength, 'pulse'); // was a group line in 2+2+3
    const c = resolvePianoRollGridModel([7, 8], '2+3+2', 14);
    assert.deepEqual(c.layout.groups, [2, 3, 2]);
    assert.equal(c.steps[4].strength, 'group'); // pulse 2
    assert.equal(c.steps[10].strength, 'group'); // pulse 5
    // Labels are grouping-independent.
    assert.deepEqual(
      b.steps.map(s => s.label),
      c.steps.map(s => s.label),
    );
  });

  it('navigation: one eighth per Shift+Arrow, one 7/8 bar (14 steps) per bar', () => {
    const model = resolvePianoRollGridModel([7, 8], '2+2+3', 28);
    assert.deepEqual(pianoRollNavigationDeltas(model), { pulseSteps: 2, barSteps: 14 });
  });

  it('an unsupported stored meter decorates the legacy 4/4 grid (runtime parity)', () => {
    // resolveMeterPulseLayout falls back to 4/4 for unsupported meters; the grid
    // model must follow so the editor never disagrees with playback.
    const model = resolvePianoRollGridModel([5, 4] as unknown as [number, number], '2+2+3', 32);
    assert.equal(model.legacyQuarterDecoration, true);
    assert.equal(model.stepsPerBar, 16);
    assert.equal(model.steps[0].label, '1');
    assert.equal(model.steps[4].label, '2');
  });
});
