/**
 * Phase 1C — the gate helper checked against literal musical-time anchors.
 *
 * Phase 1B's own tests recover the gate by *differencing* two renderer probe
 * runs, which proves the gate is tempo-relative but never pins an absolute
 * number. A regression that scaled every gate by a constant would still pass
 * that shape of test. These assertions fix absolute values derived from first
 * principles instead:
 *
 *   one sixteenth step = 1/4 beat          (4 steps per beat, by definition)
 *   seconds per beat   = 60 / bpm
 *   step seconds       = (60 / bpm) / 4
 *
 * Every expectation below is arithmetic written out longhand, never a call to
 * the helper under test, so the test cannot agree with a broken implementation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GATE_CHARACTER,
  GATE_SECONDS_PER_STEP_AT_60BPM,
  resolveGateSeconds,
} from './noteGate';

/** Independent reference implementation, written from the definition of a step. */
const stepSeconds = (bpm: number): number => 60 / bpm / 4;

const closeTo = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
};

describe('Phase 1C — literal step-duration anchors', () => {
  it('one step is 0.25 s at 60 BPM, 0.125 s at 120 BPM, 0.0625 s at 240 BPM', () => {
    assert.equal(GATE_SECONDS_PER_STEP_AT_60BPM, 0.25);
    closeTo(stepSeconds(60), 0.25, '60 BPM');
    closeTo(stepSeconds(120), 0.125, '120 BPM');
    closeTo(stepSeconds(240), 0.0625, '240 BPM');
    closeTo(stepSeconds(300), 0.05, '300 BPM');
  });

  it('neutral character (1.0) makes the gate exactly the notated length', () => {
    closeTo(resolveGateSeconds(1, 60, { characterFactor: GATE_CHARACTER.neutral }), 0.25, '1 step @ 60');
    closeTo(resolveGateSeconds(4, 60, { characterFactor: GATE_CHARACTER.neutral }), 1.0, '1 beat @ 60');
    closeTo(resolveGateSeconds(16, 120, { characterFactor: GATE_CHARACTER.neutral }), 2.0, '1 bar @ 120');
    closeTo(resolveGateSeconds(8, 240, { characterFactor: GATE_CHARACTER.neutral }), 0.5, 'half bar @ 240');
  });

  it('the same note halves in seconds every time the tempo doubles', () => {
    for (const bpm of [60, 120, 240, 300]) {
      closeTo(
        resolveGateSeconds(4, bpm, { characterFactor: GATE_CHARACTER.neutral }),
        4 * stepSeconds(bpm),
        `4 steps @ ${bpm}`,
      );
    }
  });

  it('character factors are the documented legacy ratios', () => {
    assert.ok(Math.abs(GATE_CHARACTER.percussive - 0.8) < 1e-9);
    assert.ok(Math.abs(GATE_CHARACTER.neutral - 1.0) < 1e-9);
    assert.ok(Math.abs(GATE_CHARACTER.firm - 1.2) < 1e-9);
    assert.ok(Math.abs(GATE_CHARACTER.sustained - 1.4) < 1e-9);
    assert.ok(Math.abs(GATE_CHARACTER.broad - 1.6) < 1e-9);
    assert.ok(Math.abs(GATE_CHARACTER.pad - 1.8) < 1e-9);
  });

  it('character scales the gate linearly', () => {
    // A 2-step broad note (0.5 s of notated time at 60 BPM) rings 0.8 s.
    closeTo(resolveGateSeconds(2, 60, { characterFactor: GATE_CHARACTER.broad }), 0.8, '2 steps broad');
    // A 2-step percussive note is shorter than notated.
    closeTo(resolveGateSeconds(2, 60, { characterFactor: GATE_CHARACTER.percussive }), 0.4, '2 steps percussive');
    // A 2-step pad note rings longest.
    closeTo(resolveGateSeconds(2, 60, { characterFactor: GATE_CHARACTER.pad }), 0.9, '2 steps pad');
  });

  it('an unusable duration falls back to the declared step count', () => {
    closeTo(resolveGateSeconds(NaN, 120, { characterFactor: 1, fallbackSteps: 2 }), 0.25, 'NaN -> 2 steps @ 120');
    closeTo(resolveGateSeconds(0, 120, { characterFactor: 1, fallbackSteps: 2 }), 0.25, '0 -> 2 steps @ 120');
    closeTo(resolveGateSeconds(-4, 120, { characterFactor: 1, fallbackSteps: 2 }), 0.25, 'negative -> 2 steps @ 120');
    closeTo(resolveGateSeconds(Infinity, 120, { characterFactor: 1, fallbackSteps: 1 }), 0.125, 'Infinity -> 1 step @ 120');
  });

  it('a very short but valid duration is respected, never rounded up', () => {
    closeTo(resolveGateSeconds(0.25, 120, { characterFactor: 1 }), 0.03125, 'quarter step @ 120');
  });

  it('a fractional duration scales the gate fractionally', () => {
    // The arpeggiator writes fractional step counts (e.g. triplet rates).
    closeTo(resolveGateSeconds(2 / 3, 120, { characterFactor: 1 }), (2 / 3) * 0.125, '1/16t @ 120');
  });
});
