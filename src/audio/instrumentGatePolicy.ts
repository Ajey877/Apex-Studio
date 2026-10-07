/**
 * Phase 1C — the explicit duration-gate policy for all 24 instruments.
 *
 * ## Why this module exists
 *
 * Phase 1B corrected *how* a duration-gated instrument converts `Note.duration`
 * (sixteenth-note steps) into an audible gate in seconds. It did not answer a
 * prior question: **which instruments are duration-gated at all?**
 *
 * Before Phase 1C the answer was an emergent property of the engine's dispatch
 * table (`audioEngine.ts`, `createInstrumentRegistry`). Whether `Note.duration`
 * audibly mattered depended on which renderer a channel happened to route to,
 * and nothing in the codebase stated that as a decision, reviewed it, or tested
 * it. Tracing the 24 renderers shows three genuinely different policies:
 *
 *   DURATION_GATED  (18) — the voice length follows `Note.duration`, converted
 *                          by `resolveGateSeconds` and scaled by the
 *                          instrument's sustain character.
 *   FIXED_ENVELOPE   (4) — the voice length is an intrinsic property of the
 *                          instrument's envelope. `Note.duration` has NO audible
 *                          effect. This is intentional modelling: a struck bell
 *                          or a plucked string decays on its own terms.
 *   SAMPLE_LENGTH    (2) — the voice length is the sample's own trimmed length.
 *                          `Note.duration` has no audible effect; the note stops
 *                          early only if an explicit `stop()` is issued.
 *
 * Phase 1C writes that decision down as data, so "does note length matter on
 * this instrument?" is answerable without reading 24 renderers, and so that
 * adding a 25th instrument cannot silently inherit an undeclared policy.
 *
 * ## What this module is NOT
 *
 * It changes no audio. It is a declaration plus a completeness guard: the
 * renderers are untouched, and `resolveGateSeconds` remains the single
 * sanctioned duration→seconds conversion for the DURATION_GATED family.
 */
import type { InstrumentType } from '../types/daw';
import { GATE_CHARACTER } from './noteGate';

/** The three declared duration policies. */
export const GATE_POLICIES = ['DURATION_GATED', 'FIXED_ENVELOPE', 'SAMPLE_LENGTH'] as const;

export type GatePolicy = (typeof GATE_POLICIES)[number];

/** Sustain character names, keyed off the noteGate table so they cannot drift. */
export type GateCharacterName = keyof typeof GATE_CHARACTER;

/**
 * What a sampler-family channel does when its audio asset cannot be resolved.
 *
 * `AUDIBLE_FALLBACK` — the engine substitutes the subtractive-synth voice
 *                      (`audioEngine.ts`, the `!voiceHandle && (customSample?.id
 *                      || sampler)` branch), which matches the promise the UI
 *                      already makes in `describeMissingAudioSample`.
 * `SILENT_REPORTED`  — no substitute voice is played, so the note must at least
 *                      be reported through the engine diagnostic channel.
 */
export type MissingSampleBehavior = 'AUDIBLE_FALLBACK' | 'SILENT_REPORTED';

export interface InstrumentGatePolicyEntry {
  /** How this instrument's audible voice length is determined. */
  policy: GatePolicy;
  /**
   * Why this instrument has this policy. Written for a reviewer deciding whether
   * the policy is still the right product choice — not a restatement of the code.
   */
  reason: string;
  /** DURATION_GATED only: the sustain character applied to the gate. */
  character?: GateCharacterName;
  /** DURATION_GATED only: steps assumed when `Note.duration` is unusable. */
  fallbackSteps?: number;
  /** SAMPLE_LENGTH only: behaviour when the referenced audio is missing. */
  missingSampleBehavior?: MissingSampleBehavior;
}

/**
 * The gate policy for every instrument type.
 *
 * The `Record<InstrumentType, …>` annotation is load-bearing: omitting an
 * instrument is a compile error, and `assertCompleteGatePolicy` re-checks the
 * same invariant at runtime for the test suite.
 */
export const INSTRUMENT_GATE_POLICY: Readonly<Record<InstrumentType, InstrumentGatePolicyEntry>> = Object.freeze({
  // ---- DURATION_GATED: renderer calls resolveGateSeconds ----------------
  acid_303: {
    policy: 'DURATION_GATED',
    character: 'neutral',
    fallbackSteps: 1,
    reason: 'Acid line length is part of the bassline phrasing; gate equals the notated step length.',
  },
  ambient_pad: {
    policy: 'DURATION_GATED',
    character: 'pad',
    fallbackSteps: 2,
    reason: 'Longest sustain character (1.8x); pad notes must outlast their notated length to overlap chords.',
  },
  chiptune_8bit: {
    policy: 'DURATION_GATED',
    character: 'percussive',
    fallbackSteps: 1,
    reason: 'Shortest character (0.8x) — consoley staccato; note length drives the chiptune articulation.',
  },
  cinematic_brass: {
    policy: 'DURATION_GATED',
    character: 'sustained',
    fallbackSteps: 2,
    reason: 'Brass swells follow the written note; score notes of different lengths must differ audibly.',
  },
  grand_piano: {
    policy: 'DURATION_GATED',
    character: 'broad',
    fallbackSteps: 2,
    reason: 'Gate is the notated length times 1.6 then damps into the release tail, matching piano damping.',
  },
  hammond_organ: {
    policy: 'DURATION_GATED',
    character: 'sustained',
    fallbackSteps: 1.5,
    reason: 'Drawbar organ sustains until release; 1.4x character preserves the legacy 0.35 s constant at 60 BPM.',
  },
  harpsichord: {
    policy: 'DURATION_GATED',
    character: 'broad',
    fallbackSteps: 2,
    reason: 'Shares renderPluckedGuitarVoice with nylon_guitar, so it inherits the same broad 1.6x damping.',
  },
  independent_pluck: {
    policy: 'DURATION_GATED',
    character: 'percussive',
    fallbackSteps: 1,
    reason: 'Pluck length is the expressive parameter of this instrument; note length must control the ring.',
  },
  minisynth: {
    policy: 'DURATION_GATED',
    character: 'neutral',
    fallbackSteps: 1,
    reason: 'Reference subtractive voice: the audible gate equals the notated length exactly (1.0x).',
  },
  nylon_guitar: {
    policy: 'DURATION_GATED',
    character: 'broad',
    fallbackSteps: 2,
    reason: 'Fingerpicked string damping follows note length at 1.6x, closest to a real damped string.',
  },
  reese_bass: {
    policy: 'DURATION_GATED',
    character: 'firm',
    fallbackSteps: 2,
    reason: 'Bass note length defines the groove; 1.2x keeps the legacy sustain without smearing the low end.',
  },
  rhodes_epiano: {
    policy: 'DURATION_GATED',
    character: 'sustained',
    fallbackSteps: 2,
    reason: 'Tine sustain follows the held note at 1.4x; short notes must be short to keep stabs tight.',
  },
  slap_bass: {
    policy: 'DURATION_GATED',
    character: 'firm',
    fallbackSteps: 2,
    reason: 'Shares renderReeseBassVoice, so it inherits the same firm 1.2x bass gate.',
  },
  strings_ensemble: {
    policy: 'DURATION_GATED',
    character: 'broad',
    fallbackSteps: 2,
    reason: 'Bowing follows the notated length; 1.6x covers the bow-lift so long notes sustain.',
  },
  sub_808: {
    policy: 'DURATION_GATED',
    character: 'broad',
    fallbackSteps: 2,
    reason: '808 note length is the glide/decay gesture itself; 1.6x preserves the classic long sub.',
  },
  supersaw_lead: {
    policy: 'DURATION_GATED',
    character: 'firm',
    fallbackSteps: 2,
    reason: 'Trance lead articulation is note-length driven; 1.2x keeps short notes punchy.',
  },
  vox_choir: {
    policy: 'DURATION_GATED',
    character: 'sustained',
    fallbackSteps: 2,
    reason: 'Choral phrase length must follow the written note so sustained chords swell correctly.',
  },
  wavetable: {
    policy: 'DURATION_GATED',
    character: 'neutral',
    fallbackSteps: 1,
    reason: 'Shares renderSubtractiveSynthVoice with minisynth, so it inherits the exact-length 1.0x gate.',
  },

  // ---- FIXED_ENVELOPE: Note.duration is intentionally inaudible ----------
  fmsynth: {
    policy: 'FIXED_ENVELOPE',
    reason:
      'FM operators carry a self-contained ADSR; the voice decays on its own envelope and does not ' +
      'read Note.duration. Lengthening a note in the piano roll therefore changes nothing audible.',
  },
  fm_bell: {
    policy: 'FIXED_ENVELOPE',
    reason:
      'Shares renderFmSynthVoice. A struck bell may ring longer than its notated length, so the ' +
      'envelope — not the note — owns the decay; this is the intended bell model.',
  },
  pizzicato_strings: {
    policy: 'FIXED_ENVELOPE',
    reason:
      'A pizzicato is a fixed short pluck by definition. The renderer models the pluck decay itself ' +
      'and ignores Note.duration, which is correct for the articulation.',
  },
  marimba_bell: {
    policy: 'FIXED_ENVELOPE',
    reason:
      'A struck mallet bar has a characteristic fixed decay that does not follow note length, so the ' +
      'envelope owns the voice lifetime rather than the gate.',
  },

  // ---- SAMPLE_LENGTH: the asset defines the length ----------------------
  sampler: {
    policy: 'SAMPLE_LENGTH',
    missingSampleBehavior: 'AUDIBLE_FALLBACK',
    reason:
      'The trimmed sample region sets the voice length (plus optional loop); Note.duration does not ' +
      'shorten it. When the asset cannot be resolved the engine substitutes the subtractive voice, ' +
      'which is what the UI already promises the user.',
  },
  drumpad: {
    policy: 'SAMPLE_LENGTH',
    missingSampleBehavior: 'SILENT_REPORTED',
    reason:
      'Each pad plays its own trimmed sample, so pad length — not note length — is the voice. A pad ' +
      'with no sampleId falls back to the legacy drum voice, but a pad whose referenced asset is ' +
      'missing has no substitute voice, so the failure is reported instead of being silent.',
  },
});

/** Every instrument type the policy matrix claims to cover, in declaration order. */
export const INSTRUMENT_GATE_POLICY_KEYS = Object.freeze(
  Object.keys(INSTRUMENT_GATE_POLICY) as InstrumentType[],
);

/** Instruments whose audible voice length follows `Note.duration`. */
export const DURATION_GATED_INSTRUMENTS: readonly InstrumentType[] = Object.freeze(
  INSTRUMENT_GATE_POLICY_KEYS.filter(key => INSTRUMENT_GATE_POLICY[key].policy === 'DURATION_GATED'),
);

/** Instruments whose envelope owns the voice lifetime, ignoring `Note.duration`. */
export const FIXED_ENVELOPE_INSTRUMENTS: readonly InstrumentType[] = Object.freeze(
  INSTRUMENT_GATE_POLICY_KEYS.filter(key => INSTRUMENT_GATE_POLICY[key].policy === 'FIXED_ENVELOPE'),
);

/** Instruments whose voice length comes from the sample asset. */
export const SAMPLE_LENGTH_INSTRUMENTS: readonly InstrumentType[] = Object.freeze(
  INSTRUMENT_GATE_POLICY_KEYS.filter(key => INSTRUMENT_GATE_POLICY[key].policy === 'SAMPLE_LENGTH'),
);

/** The declared policy for one instrument. */
export const getGatePolicy = (instrumentType: InstrumentType): GatePolicy =>
  INSTRUMENT_GATE_POLICY[instrumentType].policy;

/** True when `Note.duration` audibly changes this instrument's voice length. */
export const isDurationGated = (instrumentType: InstrumentType): boolean =>
  getGatePolicy(instrumentType) === 'DURATION_GATED';

/**
 * Runtime completeness guard.
 *
 * The `Record<InstrumentType, …>` annotation already makes an omission a
 * compile error; this exists so the *test suite* fails too, and so a future
 * instrument added to the union under a looser type cannot slip through.
 * Throws rather than returning false so the failure names the missing key.
 */
export const assertCompleteGatePolicy = (): true => {
  for (const entry of Object.entries(INSTRUMENT_GATE_POLICY)) {
    const [key, value] = entry as [string, InstrumentGatePolicyEntry];
    if (!GATE_POLICIES.includes(value.policy)) {
      throw new Error(`[GatePolicy] ${key} declares unknown policy "${value.policy}"`);
    }
    if (!value.reason) {
      throw new Error(`[GatePolicy] ${key} does not document why it has policy "${value.policy}"`);
    }
    if (value.policy === 'DURATION_GATED') {
      if (!value.character || !(value.character in GATE_CHARACTER)) {
        throw new Error(`[GatePolicy] ${key} is duration-gated but declares no valid character`);
      }
      if (!(typeof value.fallbackSteps === 'number' && value.fallbackSteps > 0)) {
        throw new Error(`[GatePolicy] ${key} is duration-gated but declares no fallback steps`);
      }
    }
    if (value.policy !== 'DURATION_GATED' && (value.character || value.fallbackSteps)) {
      throw new Error(`[GatePolicy] ${key} declares gate settings but is not duration-gated`);
    }
  }
  return true;
};
