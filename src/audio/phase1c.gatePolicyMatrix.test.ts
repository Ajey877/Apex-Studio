/**
 * Phase 1C — the explicit 24-instrument duration-gate policy matrix.
 *
 * Phase 1B made every *duration-gated* renderer tempo-correct, but which
 * instruments are duration-gated at all was never stated anywhere: the answer
 * was an emergent property of which renderer the engine happened to dispatch to.
 * These tests pin the policy down as data, so "is instrument X gated?" is a
 * declared, reviewable decision instead of a side effect of the dispatch table.
 *
 * RED-first: written before `src/audio/instrumentGatePolicy.ts` existed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  INSTRUMENT_GATE_POLICY,
  INSTRUMENT_GATE_POLICY_KEYS,
  GATE_POLICIES,
  assertCompleteGatePolicy,
  getGatePolicy,
} from './instrumentGatePolicy';

/**
 * The 24 instrument types, written out literally.
 *
 * This is deliberately NOT derived from `INSTRUMENT_GATE_POLICY` — a list that
 * checks itself proves nothing. It is transcribed from the union in
 * `src/types/daw.ts` and independently matched against the engine's renderer
 * dispatch table by the registry cross-check below.
 */
const EXPECTED_INSTRUMENTS = [
  'acid_303',
  'ambient_pad',
  'chiptune_8bit',
  'cinematic_brass',
  'drumpad',
  'fm_bell',
  'fmsynth',
  'grand_piano',
  'hammond_organ',
  'harpsichord',
  'independent_pluck',
  'marimba_bell',
  'minisynth',
  'nylon_guitar',
  'pizzicato_strings',
  'reese_bass',
  'rhodes_epiano',
  'sampler',
  'slap_bass',
  'strings_ensemble',
  'sub_808',
  'supersaw_lead',
  'vox_choir',
  'wavetable',
] as const;

const INSTRUMENT_TYPES_SOURCE = new URL('../types/daw.ts', import.meta.url);

/** Extracts the quoted keys of the `createInstrumentRegistry({ ... })` map. */
const readRegistryKeys = (): string[] => {
  const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
  const call = source.indexOf('createInstrumentRegistry({');
  assert.notEqual(call, -1, 'audioEngine.ts must still build the registry inline');
  const body = source.slice(call, source.indexOf('renderSubtractiveSynthVoice);', call));
  return Array.from(body.matchAll(/^\s{6}([a-z0-9_]+):/gm), match => match[1]);
};

describe('Phase 1C — gate policy matrix covers every instrument', () => {
  it('declares exactly the 24 instrument types', () => {
    assert.deepEqual(
      [...INSTRUMENT_GATE_POLICY_KEYS].sort(),
      [...EXPECTED_INSTRUMENTS].sort(),
      'the policy matrix must cover every instrument type and nothing else',
    );
    assert.equal(INSTRUMENT_GATE_POLICY_KEYS.length, 24);
  });

  it('OMITS NO INSTRUMENT — omitting one fails the suite', () => {
    // A `Record<InstrumentType, ...>` annotation only catches an omission at
    // compile time; this asserts it at runtime too, so the suite fails even if
    // the type union is loosened.
    for (const instrument of EXPECTED_INSTRUMENTS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(INSTRUMENT_GATE_POLICY, instrument),
        `instrument "${instrument}" is missing from INSTRUMENT_GATE_POLICY`,
      );
    }
    assert.equal(assertCompleteGatePolicy(), true);
  });

  it('matches the engine renderer dispatch table key-for-key', () => {
    // Catches the real drift risk: a new instrument added to the engine's
    // registry without a declared gate policy. Source-text inspection is an
    // established pattern in this repo (see missingAudioVisibility.test.ts).
    assert.deepEqual(readRegistryKeys().sort(), [...EXPECTED_INSTRUMENTS].sort());
    assert.deepEqual(readRegistryKeys().sort(), [...INSTRUMENT_GATE_POLICY_KEYS].sort());
  });

  it('matches the InstrumentType union in types/daw.ts', () => {
    const source = readFileSync(INSTRUMENT_TYPES_SOURCE, 'utf8');
    const union = source.match(/export type InstrumentType =([^;]+);/);
    assert.ok(union, 'InstrumentType union must be declared in types/daw.ts');
    const members = Array.from(union[1].matchAll(/'([a-z0-9_]+)'/g), m => m[1]);
    assert.deepEqual(members.sort(), [...EXPECTED_INSTRUMENTS].sort());
  });

  it('classifies every instrument into exactly one known policy', () => {
    for (const instrument of EXPECTED_INSTRUMENTS) {
      const entry = INSTRUMENT_GATE_POLICY[instrument];
      assert.ok(
        (GATE_POLICIES as readonly string[]).includes(entry.policy),
        `${instrument} has unknown policy "${entry.policy}"`,
      );
      assert.ok(entry.reason.length > 0, `${instrument} must document why it has this policy`);
    }
  });
});

describe('Phase 1C — policy classification is asserted against literal expectations', () => {
  // Literal, hand-checked split. Not derived from the implementation: each
  // instrument was traced to its renderer in audioEngine.ts and classified by
  // whether that renderer actually calls resolveGateSeconds.
  const DURATION_GATED = [
    'acid_303', 'ambient_pad', 'chiptune_8bit', 'cinematic_brass', 'grand_piano',
    'hammond_organ', 'harpsichord', 'independent_pluck', 'minisynth', 'nylon_guitar',
    'reese_bass', 'rhodes_epiano', 'slap_bass', 'strings_ensemble', 'sub_808',
    'supersaw_lead', 'vox_choir', 'wavetable',
  ];
  const FIXED_ENVELOPE = ['fmsynth', 'fm_bell', 'pizzicato_strings', 'marimba_bell'];
  const SAMPLE_LENGTH = ['sampler', 'drumpad'];

  it('duration-gated set is exactly the 18 Phase 1B fixed renderers', () => {
    assert.equal(DURATION_GATED.length, 18);
    assert.deepEqual([...INSTRUMENT_GATE_POLICY_KEYS].filter(
      k => getGatePolicy(k) === 'DURATION_GATED',
    ).sort(), [...DURATION_GATED].sort());
  });

  it('fixed-envelope set is exactly the 4 renderers that ignore Note.duration', () => {
    assert.equal(FIXED_ENVELOPE.length, 4);
    assert.deepEqual([...INSTRUMENT_GATE_POLICY_KEYS].filter(
      k => getGatePolicy(k) === 'FIXED_ENVELOPE',
    ).sort(), [...FIXED_ENVELOPE].sort());
  });

  it('sample-length set is exactly sampler and drumpad', () => {
    assert.deepEqual([...INSTRUMENT_GATE_POLICY_KEYS].filter(
      k => getGatePolicy(k) === 'SAMPLE_LENGTH',
    ).sort(), [...SAMPLE_LENGTH].sort());
  });

  it('the three policies partition all 24 instruments', () => {
    assert.equal(DURATION_GATED.length + FIXED_ENVELOPE.length + SAMPLE_LENGTH.length, 24);
  });
});

describe('Phase 1C — a same-renderer pair must not disagree on policy', () => {
  it('nylon_guitar and harpsichord share renderPluckedGuitarVoice and both gate', () => {
    assert.equal(getGatePolicy('nylon_guitar'), 'DURATION_GATED');
    assert.equal(getGatePolicy('harpsichord'), 'DURATION_GATED');
  });

  it('reese_bass and slap_bass share renderReeseBassVoice and both gate', () => {
    assert.equal(getGatePolicy('reese_bass'), 'DURATION_GATED');
    assert.equal(getGatePolicy('slap_bass'), 'DURATION_GATED');
  });

  it('fmsynth and fm_bell share renderFmSynthVoice and neither gates', () => {
    assert.equal(getGatePolicy('fmsynth'), 'FIXED_ENVELOPE');
    assert.equal(getGatePolicy('fm_bell'), 'FIXED_ENVELOPE');
  });

  it('minisynth and wavetable share renderSubtractiveSynthVoice and both gate', () => {
    assert.equal(getGatePolicy('minisynth'), 'DURATION_GATED');
    assert.equal(getGatePolicy('wavetable'), 'DURATION_GATED');
  });
});
