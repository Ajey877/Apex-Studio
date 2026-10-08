/**
 * Phase 1D — the arpeggiator's note length is a TRANSIENT PLAYBACK GATE, not a
 * musical note duration, and it must stay below the musical minimum on purpose.
 *
 * ## Why this file exists
 *
 * `resolveArpNoteDurationSteps()` in `src/audio/noteGate.ts` multiplies the arp
 * rate by the gate proportion and the result is written straight into the
 * `duration` field of a throwaway note handed to the live voice trigger. It is a
 * duration-shaped number in the step domain, so it belongs in the inventory —
 * but it is NOT authoritative:
 *
 *   - it never reaches a stored `Note.duration` (the voice object is discarded),
 *   - it is never persisted, never exported to MIDI, never shown in the Piano Roll,
 *   - the offline renderer does not run the arpeggiator path at all.
 *
 * Its whole job is to say how long one voice sounds, which is the Phase 1C
 * audible-gate question. That question has a different answer from the notated
 * length question this policy owns, and the two answers are allowed to disagree.
 *
 * ## The disagreement is deliberate and measurable
 *
 * The arp slider offers a gate from 0.1 to 1.5 in 0.05 increments, and the rate
 * table goes down to 1/32 (0.5 steps). At the short end the helper therefore
 * emits 1/32 x 0.1 = 0.05 steps — one fifth of the 0.25-step musical minimum,
 * and off the duration grid. That is correct. A 1/32 arpeggio with a tight gate
 * is supposed to tick; flooring it at a quarter of a beat would smear every fast
 * arpeggio into a legato wash and audibly change the instrument.
 *
 * ## What fails if somebody "fixes" it
 *
 * Clamping or snapping this helper to the note-duration policy is the obvious
 * well-meaning mistake, so it is guarded from three directions:
 *
 *   1. the literal expectations below (0.05, and rate x gate across the whole
 *      slider range) break the moment a floor or a grid snap is introduced;
 *   2. strict monotonicity in the gate breaks on a clamp, which flattens the low
 *      end of the slider into a plateau of identical values;
 *   3. the inventory entry's `forbiddenAnchors` break if the policy module, its
 *      quantizer, its constants or its bare literals ever appear in `noteGate.ts`,
 *      and the throwaway-copy tests at the bottom prove that both a policy-importing
 *      clamp and a bare-literal clamp are caught.
 *
 * This phase does NOT change the helper: it only declares and pins it.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ARP_RATE_STEPS,
  DEFAULT_ARP_GATE,
  resolveArpNoteDurationSteps,
  resolveArpRateSteps,
} from '../audio/noteGate';
import {
  DURATION_ALTERING_LAYERS,
  MIN_NOTE_DURATION_STEPS,
  isOnDurationGrid,
  quantizeDurationSteps,
} from './noteDurationPolicy';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOTE_GATE_FILE = 'src/audio/noteGate.ts';
const ARP_LAYER_ID = 'gate.arp-transient-duration';

// ---------------------------------------------------------------------------
// Independently declared literals — the arp slider and rate table as documented
// ---------------------------------------------------------------------------

/** The gate slider in ArpeggiatorModal.tsx: min 0.1, max 1.5, step 0.05. */
const ARP_GATE_SLIDER: readonly number[] = Object.freeze(
  Array.from({ length: 29 }, (_, i) => Number((0.1 + i * 0.05).toFixed(2))),
);

/** Steps per arp rate, declared from the notation itself (triplets scale by 2/3). */
const ARP_RATE_LITERALS: Readonly<Record<string, number>> = Object.freeze({
  '1/4': 4,
  '1/8': 2,
  '1/16': 1,
  '1/32': 0.5,
  '1/8t': 2 * (2 / 3),
  '1/16t': 1 * (2 / 3),
});

/** The shortest gate x the fastest rate — the case that proves there is no floor. */
const SHORTEST_ARP_DURATION = 0.05;

const arpLayer = () => {
  const layer = DURATION_ALTERING_LAYERS.find(entry => entry.id === ARP_LAYER_ID);
  assert.ok(layer, `the inventory must declare "${ARP_LAYER_ID}"`);
  return layer;
};

// ---------------------------------------------------------------------------

describe('Phase 1D H — the arp rate table and the helper fallbacks are unchanged', () => {
  it('each arp rate still means the number of sixteenth steps it is named for', () => {
    assert.deepEqual(Object.keys(ARP_RATE_STEPS).sort(), Object.keys(ARP_RATE_LITERALS).sort());
    for (const [rate, steps] of Object.entries(ARP_RATE_LITERALS)) {
      assert.equal(resolveArpRateSteps(rate), steps, `rate ${rate}`);
    }
  });

  it('an unknown or legacy rate falls back to 1/16 rather than to a musical minimum', () => {
    assert.equal(resolveArpRateSteps('nonsense'), 1);
    assert.equal(resolveArpRateSteps(undefined), 1);
    assert.equal(resolveArpRateSteps(null), 1);
    assert.equal(resolveArpRateSteps(0.001), 1);
  });

  it('an unusable gate falls back to the documented arp default, not to 0.25', () => {
    assert.equal(DEFAULT_ARP_GATE, 0.8);
    assert.equal(resolveArpNoteDurationSteps(1, Number.NaN), 0.8);
    assert.equal(resolveArpNoteDurationSteps(1, undefined), 0.8);
    assert.equal(resolveArpNoteDurationSteps(1, 'wide'), 0.8);
    // Zero is not positive, so it takes the same documented fallback path.
    assert.equal(resolveArpNoteDurationSteps(1, 0), 0.8);
  });

  it('the default arp setting is untouched: 1/16 at the default gate is 0.8 steps', () => {
    assert.equal(resolveArpNoteDurationSteps(resolveArpRateSteps('1/16'), DEFAULT_ARP_GATE), 0.8);
  });
});

describe('Phase 1D H2 — the arp gate intentionally emits below the musical minimum', () => {
  it('the 1/32 rate at the shortest slider gate is 0.05 steps, one fifth of the minimum', () => {
    const observed = resolveArpNoteDurationSteps(resolveArpRateSteps('1/32'), 0.1);
    assert.equal(observed, SHORTEST_ARP_DURATION);
    assert.equal(observed, 0.5 * 0.1);
    assert.ok(
      observed < MIN_NOTE_DURATION_STEPS,
      `0.05 steps must stay below the ${MIN_NOTE_DURATION_STEPS}-step musical minimum`,
    );
  });

  it('that value is off the musical duration grid, and stays off it', () => {
    const observed = resolveArpNoteDurationSteps(resolveArpRateSteps('1/32'), 0.1);
    assert.equal(isOnDurationGrid(observed), false, 'a transient gate is not a grid value');
    assert.notEqual(observed, quantizeDurationSteps(observed), 'it must not already be quantized');
    assert.equal(quantizeDurationSteps(observed), 0.25, 'the musical policy would have floored it');
  });

  it('every arp rate x gate pair equals rate x gate exactly, with no floor and no snap', () => {
    let checked = 0;
    for (const [rate, rateSteps] of Object.entries(ARP_RATE_LITERALS)) {
      for (const gate of ARP_GATE_SLIDER) {
        const observed = resolveArpNoteDurationSteps(resolveArpRateSteps(rate), gate);
        assert.equal(observed, rateSteps * gate, `${rate} at gate ${gate}`);
        checked++;
      }
    }
    assert.equal(checked, 6 * ARP_GATE_SLIDER.length, 'the whole slider range is covered');
  });

  it('sub-minimum output is normal, not an edge case: 20 slider positions land below 0.25', () => {
    let below = 0;
    let offGrid = 0;
    for (const rate of Object.keys(ARP_RATE_LITERALS)) {
      for (const gate of ARP_GATE_SLIDER) {
        const observed = resolveArpNoteDurationSteps(resolveArpRateSteps(rate), gate);
        if (observed < MIN_NOTE_DURATION_STEPS) below++;
        if (!isOnDurationGrid(observed)) offGrid++;
      }
    }
    assert.equal(below, 20, 'rates 1/32, 1/16t, 1/16, 1/8t and 1/8 all reach below the minimum');
    assert.ok(offGrid > below, 'triplet rates are off-grid even above the minimum');
  });
});

describe('Phase 1D H3 — a clamp or a grid snap cannot be introduced silently', () => {
  it('the emitted length is strictly monotonic in the gate for every rate', () => {
    // A floor flattens the low end of the slider into a plateau of equal values,
    // and a 0.25 grid snap does the same, so strict monotonicity catches both.
    for (const rate of Object.keys(ARP_RATE_LITERALS)) {
      let previous = -Infinity;
      for (const gate of ARP_GATE_SLIDER) {
        const observed = resolveArpNoteDurationSteps(resolveArpRateSteps(rate), gate);
        assert.ok(
          observed > previous,
          `${rate}: gate ${gate} emitted ${observed}, not greater than the previous ${previous} — a floor or a snap was introduced`,
        );
        previous = observed;
      }
    }
  });

  it('only pairs whose real product is 0.25 may equal the minimum — nothing is raised to it', () => {
    const atMinimum: string[] = [];
    for (const [rate, rateSteps] of Object.entries(ARP_RATE_LITERALS)) {
      for (const gate of ARP_GATE_SLIDER) {
        const observed = resolveArpNoteDurationSteps(resolveArpRateSteps(rate), gate);
        if (observed === MIN_NOTE_DURATION_STEPS) atMinimum.push(`${rate}@${gate}`);
        // A floor would lift a shorter product up to the minimum; assert it did not.
        if (rateSteps * gate < MIN_NOTE_DURATION_STEPS) {
          assert.ok(
            observed < MIN_NOTE_DURATION_STEPS,
            `${rate} at gate ${gate} has a true product of ${rateSteps * gate} but emitted ${observed} — it was floored`,
          );
        }
      }
    }
    assert.deepEqual(
      atMinimum.sort(),
      ['1/16@0.25', '1/32@0.5'],
      'exactly the two slider positions whose arithmetic genuinely equals 0.25 steps',
    );
  });

  it('noteGate.ts still declares no musical floor of its own', () => {
    const source = readFileSync(join(REPO_ROOT, NOTE_GATE_FILE), 'utf8');
    for (const forbidden of [
      'noteDurationPolicy',
      'quantizeDurationSteps',
      'isOnDurationGrid',
      'MIN_NOTE_DURATION_STEPS',
      'DURATION_GRID_STEPS',
      'Math.max(0.25',
      '* 4) / 4',
    ]) {
      assert.ok(!source.includes(forbidden), `${NOTE_GATE_FILE} must not contain ${forbidden}`);
    }
  });
});

describe('Phase 1D H4 — the inventory declares the arp layer as transient and non-authoritative', () => {
  it('the layer is declared against noteGate.ts with the gate role and no floor', () => {
    const layer = arpLayer();
    assert.equal(layer.file, NOTE_GATE_FILE);
    assert.equal(layer.role, 'AUDIBLE_GATE_SEPARATE_POLICY');
    assert.equal(layer.domain, 'note-steps');
    assert.equal(layer.consumesPolicy, false, 'it must never consume the musical policy');
    assert.equal(layer.declaredMinimum, null, 'it enforces no floor of its own, by design');
    assert.ok(layer.symbols.includes('resolveArpNoteDurationSteps'));
    assert.ok(layer.behavior.length > 0 && layer.reason.length > 0);
  });

  it('the layer declares the tripwires that catch a clamp or a snap', () => {
    const forbidden = arpLayer().forbiddenAnchors ?? [];
    for (const expected of ['noteDurationPolicy', 'quantizeDurationSteps', 'MIN_NOTE_DURATION_STEPS', 'Math.max(0.25']) {
      assert.ok(forbidden.includes(expected), `forbiddenAnchors must include ${expected}`);
    }
    const source = readFileSync(join(REPO_ROOT, NOTE_GATE_FILE), 'utf8');
    for (const anchor of forbidden) {
      assert.ok(!source.includes(anchor), `tripwire "${anchor}" must not be present today`);
    }
  });

  it('the declared anchors are still present in the production source', () => {
    const layer = arpLayer();
    const source = readFileSync(join(REPO_ROOT, NOTE_GATE_FILE), 'utf8');
    for (const anchor of layer.anchors) {
      assert.ok(source.includes(anchor), `anchor "${anchor}" is gone from ${NOTE_GATE_FILE}`);
    }
    for (const symbol of layer.symbols) {
      assert.ok(source.includes(symbol), `symbol "${symbol}" is gone from ${NOTE_GATE_FILE}`);
    }
  });

  it('the gate module and the duration policy still do not import each other', () => {
    const gate = readFileSync(join(REPO_ROOT, NOTE_GATE_FILE), 'utf8');
    const policy = readFileSync(join(REPO_ROOT, 'src/music/noteDurationPolicy.ts'), 'utf8');
    assert.ok(!gate.includes('noteDurationPolicy'), 'the gate must stay independent of the musical policy');
    const policyImports = [...policy.matchAll(/^import\s[^;]*?from\s*'([^']+)'/gm)].map(match => match[1]);
    assert.deepEqual(policyImports, ['./musicalTime'], 'the policy still builds on canonical musical time alone');
  });
});

// ---------------------------------------------------------------------------
// Negative tests: prove the guard has teeth by clamping a throwaway copy.
// The repository source is never modified.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const makeTempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `phase1d-arp-${label}-`));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const REAL_HELPER = [
  'export const resolveArpNoteDurationSteps = (rateSteps: number, gate: unknown): number =>',
  "  (isPositiveFinite(rateSteps) ? rateSteps : ARP_RATE_STEPS['1/16'])",
  '  * (isPositiveFinite(gate) ? gate : DEFAULT_ARP_GATE);',
].join('\n');

/** Copies src/, rewrites the arp helper, and imports the mutated gate module. */
const mutatedNoteGate = async (label: string, mutate: (source: string) => string) => {
  const dir = makeTempDir(label);
  cpSync(join(REPO_ROOT, 'src'), join(dir, 'src'), { recursive: true });
  const target = join(dir, NOTE_GATE_FILE);
  const original = readFileSync(target, 'utf8');
  assert.ok(original.includes(REAL_HELPER), 'the real helper text moved; update REAL_HELPER');
  const mutated = mutate(original);
  assert.notEqual(mutated, original, 'the mutation did not change the gate source');
  writeFileSync(target, mutated);
  const module = (await import(pathToFileURL(target).href)) as typeof import('../audio/noteGate');
  return { module, mutated };
};

describe('Phase 1D H5 — clamping the arp helper to the musical policy is caught', () => {
  it('rejects a copy that imports the policy and floors at MIN_NOTE_DURATION_STEPS', async () => {
    const { module, mutated } = await mutatedNoteGate('clamp-policy', source =>
      source
        .replace(
          REAL_HELPER,
          [
            'export const resolveArpNoteDurationSteps = (rateSteps: number, gate: unknown): number =>',
            '  Math.max(MIN_NOTE_DURATION_STEPS, (isPositiveFinite(rateSteps) ? rateSteps : ARP_RATE_STEPS[\'1/16\'])',
            '  * (isPositiveFinite(gate) ? gate : DEFAULT_ARP_GATE));',
          ].join('\n'),
        )
        .replace(
          "import { beatsToSeconds, stepsToBeats } from '../music/musicalTime';",
          "import { beatsToSeconds, stepsToBeats } from '../music/musicalTime';\n" +
            "import { MIN_NOTE_DURATION_STEPS } from '../music/noteDurationPolicy';",
        ),
    );

    // The behaviour changed: the shortest arpeggio is now pinned to the minimum.
    const observed = module.resolveArpNoteDurationSteps(module.resolveArpRateSteps('1/32'), 0.1);
    assert.equal(observed, MIN_NOTE_DURATION_STEPS, 'the clamped copy floors 0.05 up to 0.25');
    assert.notEqual(observed, SHORTEST_ARP_DURATION, 'so the literal expectation above would fail');

    // And the inventory tripwire sees it.
    const caught = (arpLayer().forbiddenAnchors ?? []).filter(anchor => mutated.includes(anchor));
    assert.ok(caught.length > 0, 'a policy-importing clamp must trip at least one forbiddenAnchor');
    assert.ok(caught.includes('MIN_NOTE_DURATION_STEPS'));
    assert.ok(caught.includes('noteDurationPolicy'));
  });

  it('rejects a copy that quantizes with bare literals and never mentions the policy', async () => {
    const { module, mutated } = await mutatedNoteGate('clamp-literal', source =>
      source.replace(
        REAL_HELPER,
        [
          'export const resolveArpNoteDurationSteps = (rateSteps: number, gate: unknown): number =>',
          '  Math.max(0.25, Math.round((isPositiveFinite(rateSteps) ? rateSteps : ARP_RATE_STEPS[\'1/16\'])',
          '  * (isPositiveFinite(gate) ? gate : DEFAULT_ARP_GATE) * 4) / 4);',
        ].join('\n'),
      ),
    );

    const observed = module.resolveArpNoteDurationSteps(module.resolveArpRateSteps('1/32'), 0.1);
    assert.equal(observed, 0.25, 'the snapped copy rounds 0.05 up to the first grid line');
    assert.equal(module.resolveArpNoteDurationSteps(module.resolveArpRateSteps('1/32'), 0.15), 0.25);
    assert.equal(
      module.resolveArpNoteDurationSteps(module.resolveArpRateSteps('1/32'), 0.1),
      module.resolveArpNoteDurationSteps(module.resolveArpRateSteps('1/32'), 0.15),
      'a snap creates the plateau that the monotonicity test forbids',
    );

    const caught = (arpLayer().forbiddenAnchors ?? []).filter(anchor => mutated.includes(anchor));
    assert.ok(caught.length > 0, 'a bare-literal clamp must still trip a forbiddenAnchor');
    assert.ok(caught.includes('Math.max(0.25'));
    assert.ok(caught.includes('* 4) / 4'));
  });

  it('an unmutated copy of the gate module keeps emitting 0.05', async () => {
    const { module } = await mutatedNoteGate('control', source => source.replace(
      '/** Steps for a rate, falling back to 1/16 for an unknown or legacy value. */',
      '/** Steps for a rate, falling back to 1/16 for an unknown or legacy value. (control) */',
    ));
    assert.equal(module.resolveArpNoteDurationSteps(module.resolveArpRateSteps('1/32'), 0.1), SHORTEST_ARP_DURATION);
  });
});
