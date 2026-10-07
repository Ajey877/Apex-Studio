/**
 * Phase 1B — canonical note-duration → audible-gate conversion.
 *
 * These tests were written BEFORE `noteGate.ts` existed and were observed RED
 * (ERR_MODULE_NOT_FOUND) on the Phase 1A baseline f7315f77.
 *
 * They pin the corrected contract:
 *
 *   Note.start    = sixteenth-note steps   (unchanged, persisted)
 *   Note.duration = sixteenth-note steps   (unchanged, persisted)
 *   gate seconds  = beatsToSeconds(stepsToBeats(duration), bpm) * character
 *
 * The gate must be INVERSELY PROPORTIONAL to BPM. The pre-Phase-1B renderers
 * multiplied `note.duration` by a hardcoded constant (0.2 … 0.45) and never
 * read BPM at all, so their gate was tempo-invariant. These tests fail against
 * that behaviour and pass only when tempo enters the conversion.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GATE_CHARACTER,
  GATE_SECONDS_PER_STEP_AT_60BPM,
  DEFAULT_ARP_GATE,
  ARP_RATE_STEPS,
  resolveGateSeconds,
  resolveArpRateSteps,
  resolveArpNoteDurationSteps,
  arpStepSeconds,
} from './noteGate';
import { beatsToSeconds, stepsToBeats } from '../music/musicalTime';

const close = (a: number, b: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) < 1e-12, `${msg ?? 'values differ'}: ${a} != ${b}`);

describe('Phase 1B — canonical gate derivation is BPM-aware', () => {
  it('scales the gate inversely with tempo (the core Phase 1B defect)', () => {
    // 4 steps = one beat.
    const g60 = resolveGateSeconds(4, 60);
    const g120 = resolveGateSeconds(4, 120);
    const g240 = resolveGateSeconds(4, 240);

    close(g60, 1, '4 steps at 60 BPM is one quarter note = 1s');
    close(g120, 0.5, '4 steps at 120 BPM is half a second');
    close(g240, 0.25, '4 steps at 240 BPM is a quarter second');

    // The property the old multipliers violated entirely.
    close(g120, g60 * 0.5);
    close(g240, g60 * 0.25);
  });

  it('keeps the musical duration in steps identical across tempi', () => {
    // Only the derived seconds change; the stored Note.duration is untouched.
    const steps = 1.5;
    for (const bpm of [20, 60, 96, 128, 180, 240, 300]) {
      close(resolveGateSeconds(steps, bpm), beatsToSeconds(stepsToBeats(steps), bpm));
    }
  });

  it('uses the canonical Phase 1A helpers rather than recreating timing math', () => {
    for (const bpm of [20, 60, 97.5, 128, 240, 300]) {
      for (const steps of [0.25, 1, 2, 3.5, 16]) {
        close(
          resolveGateSeconds(steps, bpm),
          beatsToSeconds(stepsToBeats(steps), bpm),
          `steps=${steps} bpm=${bpm}`,
        );
      }
    }
  });

  it('supports fractional durations', () => {
    close(resolveGateSeconds(0.25, 120), 60 / 120 / 4 / 4);
    close(resolveGateSeconds(1.5, 60), 0.375);
    close(resolveGateSeconds(0.5, 128), (60 / 128 / 4) * 0.5);
  });
});

describe('Phase 1B — instrument character is preserved, not flattened', () => {
  it('exposes the legacy multipliers as explicit, documented character factors', () => {
    // character = legacyMultiplier / secondsPerStep@60BPM = legacy / 0.25
    close(GATE_CHARACTER.percussive, 0.2 / 0.25, 'legacy 0.20');
    close(GATE_CHARACTER.neutral, 0.25 / 0.25, 'legacy 0.25');
    close(GATE_CHARACTER.firm, 0.3 / 0.25, 'legacy 0.30');
    close(GATE_CHARACTER.sustained, 0.35 / 0.25, 'legacy 0.35');
    close(GATE_CHARACTER.broad, 0.4 / 0.25, 'legacy 0.40');
    close(GATE_CHARACTER.pad, 0.45 / 0.25, 'legacy 0.45');
    close(GATE_SECONDS_PER_STEP_AT_60BPM, 0.25);
  });

  it('does NOT collapse every instrument onto a universal factor of 1', () => {
    const values = Object.values(GATE_CHARACTER);
    assert.ok(values.length >= 6, 'several distinct character factors must exist');
    assert.ok(new Set(values).size === values.length, 'character factors must be distinct');
    assert.ok(
      values.some(v => v < 1) && values.some(v => v > 1),
      'character must both shorten and lengthen the notated length',
    );
  });

  it('preserves the exact relative character between instruments at every tempo', () => {
    const pal = GATE_CHARACTER.percussive;
    for (const bpm of [20, 60, 128, 240, 300]) {
      for (const steps of [1, 4, 8]) {
        const ratio = resolveGateSeconds(steps, bpm, { characterFactor: GATE_CHARACTER.pad })
          / resolveGateSeconds(steps, bpm, { characterFactor: pal });
        close(ratio, GATE_CHARACTER.pad / pal, `bpm=${bpm} steps=${steps}`);
      }
    }
  });

  it('is bit-identical to the legacy sound at 60 BPM', () => {
    // Option A: at 60 BPM the corrected gate reproduces the old multipliers
    // exactly, so no instrument changes character at the calibration tempo.
    const legacy: Array<[number, number]> = [
      [0.2, GATE_CHARACTER.percussive],
      [0.25, GATE_CHARACTER.neutral],
      [0.3, GATE_CHARACTER.firm],
      [0.35, GATE_CHARACTER.sustained],
      [0.4, GATE_CHARACTER.broad],
      [0.45, GATE_CHARACTER.pad],
    ];
    for (const [legacyMultiplier, character] of legacy) {
      for (const steps of [0.5, 1, 2, 4, 8]) {
        close(
          resolveGateSeconds(steps, 60, { characterFactor: character }),
          steps * legacyMultiplier,
          `legacy ${legacyMultiplier} @60BPM, ${steps} steps`,
        );
      }
    }
  });
});

describe('Phase 1B — invalid and extreme durations are handled conservatively', () => {
  it('falls back to the instrument default for zero, NaN and non-numeric durations', () => {
    // Mirrors the historic `(note.duration || 1)` falsy fallback.
    for (const bad of [0, Number.NaN, undefined, null, 'x', {}]) {
      close(resolveGateSeconds(bad, 120, { fallbackSteps: 1 }), resolveGateSeconds(1, 120));
      close(resolveGateSeconds(bad, 120, { fallbackSteps: 2 }), resolveGateSeconds(2, 120));
      close(resolveGateSeconds(bad, 120, { fallbackSteps: 1.5 }), resolveGateSeconds(1.5, 120));
    }
  });

  it('also rejects NEGATIVE durations, which previously produced a negative gate', () => {
    // Pre-Phase-1B: `-2 || 1` === -2 → gate -0.5s → RangeError on scheduling.
    close(resolveGateSeconds(-2, 120, { fallbackSteps: 1 }), resolveGateSeconds(1, 120));
    assert.ok(resolveGateSeconds(-2, 120, { fallbackSteps: 1 }) > 0, 'gate must stay positive');
  });

  it('applies the default fallback of 1 step when none is supplied', () => {
    close(resolveGateSeconds(0, 120), resolveGateSeconds(1, 120));
  });

  it('does NOT invent a minimum-gate floor for very short notes', () => {
    // A 1/64 note must be short, not clamped up to some arbitrary floor.
    const tiny = resolveGateSeconds(0.25, 300);
    close(tiny, beatsToSeconds(stepsToBeats(0.25), 300));
    assert.ok(tiny > 0 && tiny < 0.02, `expected a genuinely short gate, saw ${tiny}`);
  });

  it('does NOT clamp very long notes', () => {
    close(resolveGateSeconds(1e6, 120), beatsToSeconds(stepsToBeats(1e6), 120));
  });

  it('propagates an invalid BPM instead of silently repairing it, like Phase 1A', () => {
    // Phase 1A's musicalTime deliberately does not clamp/validate tempo; the
    // engine owns BPM sanitisation. This module matches that policy so a caller
    // can never mistake a repaired tempo for a real one. beatsToSeconds is
    // `beats * (60 / bpm)`, so: NaN stays NaN, 0 becomes Infinity, and a
    // negative tempo keeps its sign instead of being flipped positive.
    assert.ok(Number.isNaN(resolveGateSeconds(1, Number.NaN)), 'NaN BPM must stay NaN');
    assert.ok(
      !Number.isFinite(resolveGateSeconds(1, 0)),
      'a zero BPM must not be repaired into a plausible finite gate',
    );
    assert.ok(
      resolveGateSeconds(1, -120) < 0,
      'a negative BPM must keep its sign, not be repaired into a positive gate',
    );
  });
});

describe('Phase 1B — arpeggiator gates stay in musical steps', () => {
  it('maps every Step Rate onto the 4-steps-per-beat grid', () => {
    close(ARP_RATE_STEPS['1/4'], 4);
    close(ARP_RATE_STEPS['1/8'], 2);
    close(ARP_RATE_STEPS['1/16'], 1);
    close(ARP_RATE_STEPS['1/32'], 0.5);
    close(ARP_RATE_STEPS['1/8t'], 2 * (2 / 3));
    close(ARP_RATE_STEPS['1/16t'], 1 * (2 / 3));
  });

  it('reproduces the legacy onset spacing exactly at every tempo', () => {
    // Onsets were already correct in Phase 70; deriving them from the same step
    // table must not move them.
    for (const bpm of [60, 90, 120, 180]) {
      const secondsPerBeat = beatsToSeconds(1, bpm);
      const legacy: Array<[keyof typeof ARP_RATE_STEPS, number]> = [
        ['1/4', secondsPerBeat],
        ['1/8', secondsPerBeat / 2],
        ['1/16', secondsPerBeat / 4],
        ['1/32', secondsPerBeat / 8],
        ['1/8t', (secondsPerBeat / 2) * (2 / 3)],
        ['1/16t', (secondsPerBeat / 4) * (2 / 3)],
      ];
      for (const [rate, expectedSeconds] of legacy) {
        close(arpStepSeconds(rate, bpm), expectedSeconds, `${rate} @ ${bpm}`);
      }
    }
  });

  it('falls back to 1/16 for an unknown rate', () => {
    close(resolveArpRateSteps('nope'), 1);
    close(arpStepSeconds('nope', 120), beatsToSeconds(stepsToBeats(1), 120));
  });

  it('expresses the arp gate in STEPS, never in seconds', () => {
    // Pre-Phase-1B the engine wrote `stepDuration * gate` (seconds) straight
    // into Note.duration. The gate must now be a proportion of the step grid.
    assert.equal(DEFAULT_ARP_GATE, 0.8, 'preserves the historic unset-gate default');

    close(resolveArpNoteDurationSteps(1, 0.5), 0.5, '1/16 at 50% gate is half a step');
    close(resolveArpNoteDurationSteps(1, 1), 1);
    close(resolveArpNoteDurationSteps(4, 0.85), 3.4);

    // The value must be tempo-INDEPENDENT: the gate is a musical proportion.
    for (const bpm of [60, 120, 180, 240]) {
      close(resolveArpNoteDurationSteps(ARP_RATE_STEPS['1/8'], 0.5), 1, `bpm=${bpm}`);
    }
  });

  it('falls back to the default gate for a missing or invalid gate', () => {
    close(resolveArpNoteDurationSteps(1, undefined), DEFAULT_ARP_GATE);
    close(resolveArpNoteDurationSteps(1, Number.NaN), DEFAULT_ARP_GATE);
    close(resolveArpNoteDurationSteps(1, 0), DEFAULT_ARP_GATE);
  });

  it('makes the rendered arp gate equal the value the Gate Length slider advertises', () => {
    // Previously the rendered gate was (stepDuration * gate) * 0.25 — a quarter
    // of the intended length on minisynth. It must now be exactly the intended
    // length for a neutral-character instrument.
    const bpm = 120;
    const gate = 0.5;
    const stepSeconds = arpStepSeconds('1/16', bpm);
    const intended = stepSeconds * gate;
    const rendered = resolveGateSeconds(resolveArpNoteDurationSteps(1, gate), bpm, {
      characterFactor: GATE_CHARACTER.neutral,
    });
    close(rendered, intended);
  });
});
