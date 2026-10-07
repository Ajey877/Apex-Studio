/**
 * Phase 1D — the declared note-duration policy, checked against literal anchors.
 *
 * Before this phase every layer that touched `Note.duration` picked its own
 * minimum, and the five answers disagreed:
 *
 *   Piano Roll edit/resize      0.25 steps
 *   MIDI import                 0.5  steps
 *   MIDI export                 1    MIDI tick
 *   Piano Roll "Quantize"       1    step
 *   instrument gate fallback    1–2  steps
 *
 * Nothing in the repository said which of those was the policy and which was an
 * accident, so the shortest note a user could draw (0.25 steps) was silently
 * rewritten to 0.5 by an import and to 1 by Quantize.
 *
 * Every expectation below is a literal written from the product decision —
 * `Note.duration` stays in sixteenth-note steps, one beat is 4 steps, and the
 * shortest supported musical duration is 0.25 steps (a 64th note). No
 * expectation is read back out of the implementation, so the test cannot agree
 * with a policy module that drifted.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  DURATION_GRID_STEPS,
  GRID_DIVISIONS_PER_STEP,
  MIN_MIDI_NOTE_OFF_DELTA_TICKS,
  MIN_NOTE_DURATION_STEPS,
  NOTE_DURATION_UNIT,
  STEPS_PER_BEAT,
  isOnDurationGrid,
  quantizeDurationSteps,
} from './noteDurationPolicy';
import { DEFAULT_MIN_NOTE_DURATION } from '../components/pianoRollOperations';

const read = (relative: string): string =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

/**
 * The rule this phase replaces, written out longhand.
 *
 * It is kept here as evidence of the defect, never as the oracle for the new
 * behaviour: the assertions using it state what Quantize *used* to do so the
 * reason the policy exists stays visible next to the rule that superseded it.
 */
const LEGACY_QUANTIZE_DURATION = (steps: number): number => Math.max(1, Math.round(steps));

describe('Phase 1D A — the policy anchor is declared as a literal', () => {
  it('the minimum supported musical duration is exactly 0.25 steps', () => {
    assert.equal(MIN_NOTE_DURATION_STEPS, 0.25);
  });

  it('the canonical unit of Note.duration is unchanged: sixteenth-note steps', () => {
    assert.equal(NOTE_DURATION_UNIT, 'sixteenth-note steps');
    assert.equal(STEPS_PER_BEAT, 4, '1 beat = 4 steps');
  });

  it('0.25 steps is a 64th note: one sixteenth of a beat', () => {
    // 0.25 steps / 4 steps-per-beat = 0.0625 beats = 1/16 of a quarter note.
    assert.equal(MIN_NOTE_DURATION_STEPS / STEPS_PER_BEAT, 0.0625);
    assert.equal(1 / (MIN_NOTE_DURATION_STEPS / STEPS_PER_BEAT), 16);
  });

  it('the supported duration grid is the minimum duration: multiples of 0.25 steps', () => {
    assert.equal(DURATION_GRID_STEPS, 0.25);
    assert.equal(GRID_DIVISIONS_PER_STEP, 4);
    assert.equal(DURATION_GRID_STEPS, MIN_NOTE_DURATION_STEPS);
  });

  it('a MIDI note-off must be at least 1 tick after its note-on', () => {
    // A format constraint, not a musical one: 1 tick at 480 PPQ is 1/120 of a
    // step, far below the musical minimum. It only binds for durations that
    // already violate the policy, so it stays declared as a tick count.
    assert.equal(MIN_MIDI_NOTE_OFF_DELTA_TICKS, 1);
  });

  it('the Piano Roll minimum derives from the policy instead of restating it', () => {
    assert.equal(DEFAULT_MIN_NOTE_DURATION, MIN_NOTE_DURATION_STEPS);
    assert.equal(DEFAULT_MIN_NOTE_DURATION, 0.25);

    const source = read('src/components/pianoRollOperations.ts');
    assert.match(
      source,
      /import\s*\{[^}]*MIN_NOTE_DURATION_STEPS[^}]*\}\s*from\s*'\.\.\/music\/noteDurationPolicy'/,
      'pianoRollOperations must consume the shared policy',
    );
    assert.ok(
      !/DEFAULT_MIN_NOTE_DURATION\s*=\s*0\.25/.test(source),
      'DEFAULT_MIN_NOTE_DURATION must not restate the literal 0.25',
    );
  });

  it('the policy module stays small, pure and separate from the gate policy', () => {
    const source = read('src/music/noteDurationPolicy.ts');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s*'([^']+)'/gm)].map(m => m[1]);

    assert.deepEqual(imports, ['./musicalTime'], 'the policy may only build on canonical musical time');
    assert.ok(!source.includes('node:'), 'the policy must stay free of platform imports');
    assert.ok(!source.includes('react'), 'the policy must stay free of UI imports');
    // It names the gate layers in its inventory, but must never restate their
    // seconds arithmetic: the audible gate is a separate policy with a separate
    // purpose and the two must not be merged.
    for (const forbidden of ['GATE_SECONDS_PER_STEP_AT_60BPM', 'characterFactor', 'beatsToSeconds']) {
      assert.ok(!source.includes(forbidden), `the policy must not reference ${forbidden}`);
    }
  });

  it('the numeric API holds exactly one musical constant, one format constant and a tolerance', () => {
    // "Small and pure" means no hidden numbers, not a line budget: the module's
    // length is the inventory and its rationale, which this phase was asked for.
    // Everything above the layer inventory is the arithmetic, and the only
    // literals it may use are the declared minimum (0.25 steps), the declared
    // MIDI tick floor and grid numerator (1), the non-positive guard (0) and a
    // float-comparison tolerance (1e-9).
    const source = read('src/music/noteDurationPolicy.ts');
    const arithmetic = source.split('export const DURATION_POLICY_ROLES')[0];
    assert.ok(arithmetic.length > 0 && arithmetic !== source, 'the inventory section must be separable');

    const code = arithmetic
      .split('\n')
      .filter(line => !/^\s*[/*]/.test(line)) // drop the module doc comment
      .join('\n')
      .replace(/\/\/.*$/gm, '');
    const literals = [...code.matchAll(/(?<![A-Za-z0-9_.$])(-?\d+(?:\.\d+)?(?:e-?\d+)?)/gi)].map(m => m[1]);
    assert.deepEqual([...new Set(literals)].sort(), ['0', '0.25', '1', '1e-9'].sort());
  });
});

describe('Phase 1D B — Quantize preserves every duration already on the supported grid', () => {
  it('0.25, 0.5, 0.75, 1, 1.25, 1.5 and 2 steps all survive quantization', () => {
    const onGrid: ReadonlyArray<[number, number]> = [
      [0.25, 0.25],
      [0.5, 0.5],
      [0.75, 0.75],
      [1, 1],
      [1.25, 1.25],
      [1.5, 1.5],
      [2, 2],
    ];
    for (const [input, expected] of onGrid) {
      assert.equal(quantizeDurationSteps(input), expected, `${input} steps must stay ${expected}`);
    }
  });

  it('the rule it replaces destroyed every duration below one step', () => {
    // Documented defect, not the oracle: this is why the policy exists.
    assert.equal(LEGACY_QUANTIZE_DURATION(0.25), 1);
    assert.equal(LEGACY_QUANTIZE_DURATION(0.5), 1);
    assert.equal(LEGACY_QUANTIZE_DURATION(0.75), 1);
    assert.equal(LEGACY_QUANTIZE_DURATION(1.25), 1);
    assert.equal(LEGACY_QUANTIZE_DURATION(1.5), 2);
    for (const steps of [0.25, 0.5, 0.75, 1.25, 1.5]) {
      assert.notEqual(
        LEGACY_QUANTIZE_DURATION(steps),
        quantizeDurationSteps(steps),
        `the declared policy must differ from the legacy rule at ${steps} steps`,
      );
    }
  });

  it('the Piano Roll quantize handler delegates to the policy and no longer floors at 1 step', () => {
    const source = read('src/components/PianoRoll.tsx');
    assert.ok(
      source.includes('duration: quantizeDurationSteps(n.duration)'),
      'handleQuantizeNotes must call the declared policy',
    );
    assert.ok(
      !source.includes('Math.max(1, Math.round(n.duration))'),
      'the hard-coded 1-step duration floor must be gone',
    );
    assert.match(
      source,
      /import\s*\{[^}]*quantizeDurationSteps[^}]*\}\s*from\s*'\.\.\/music\/noteDurationPolicy'/,
      'PianoRoll must consume the shared policy',
    );
    // Quantize still snaps onsets to the 1-step positional grid; only the
    // duration rule changed.
    assert.ok(source.includes('start: Math.round(n.start)'), 'positional quantization is out of scope');
  });
});

describe('Phase 1D B2 — off-grid durations follow one declared rule', () => {
  it('an off-grid duration snaps to the nearest 0.25-step grid line, halves rounding up', () => {
    const offGrid: ReadonlyArray<[number, number]> = [
      [0, 0.25], // below the minimum: floored, not rounded away
      [0.1, 0.25],
      [0.125, 0.25], // exact half between 0 and 0.25 rounds up
      [0.2, 0.25],
      [0.3, 0.25],
      [0.375, 0.5], // exact half between 0.25 and 0.5 rounds up
      [0.4, 0.5],
      [0.6, 0.5],
      [0.9, 1],
      [1.1, 1],
      [1.7, 1.75],
      [2.34, 2.25],
      [-1, 0.25], // a negative duration is invalid input; it lands on the minimum
    ];
    for (const [input, expected] of offGrid) {
      assert.equal(quantizeDurationSteps(input), expected, `${input} steps must quantize to ${expected}`);
    }
  });

  it('every finite result is on the grid and at least the policy minimum', () => {
    for (let i = -40; i <= 400; i += 1) {
      const steps = i / 37; // deliberately awkward, mostly off-grid
      const result = quantizeDurationSteps(steps);
      assert.ok(Number.isFinite(result), `${steps} must produce a finite duration`);
      assert.ok(result >= MIN_NOTE_DURATION_STEPS, `${steps} produced ${result}, below the minimum`);
      assert.ok(isOnDurationGrid(result), `${steps} produced ${result}, which is off the grid`);
      assert.ok(
        Math.abs(result - steps) <= DURATION_GRID_STEPS / 2 + 1e-9 || steps < MIN_NOTE_DURATION_STEPS,
        `${steps} moved to ${result}, further than half a grid line`,
      );
    }
  });

  it('non-finite durations propagate rather than being silently repaired', () => {
    // Matches the declared Phase 1A stance in musicalTime.ts: this layer must
    // not invent a plausible value for malformed legacy input. Persistence
    // behaviour for NaN/Infinity is out of scope (P9) and is unchanged — the
    // legacy rule propagated them too.
    assert.ok(Number.isNaN(quantizeDurationSteps(Number.NaN)));
    assert.equal(quantizeDurationSteps(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
    assert.equal(quantizeDurationSteps(Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
    assert.equal(isOnDurationGrid(Number.NaN), false);
  });

  it('isOnDurationGrid recognises exactly the supported multiples of 0.25', () => {
    for (const steps of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 16]) {
      assert.equal(isOnDurationGrid(steps), true, `${steps} is on the grid`);
    }
    for (const steps of [0, 0.1, 0.3, 1.13, -0.25, 0.05]) {
      assert.equal(isOnDurationGrid(steps), false, `${steps} is not on the grid`);
    }
  });
});
