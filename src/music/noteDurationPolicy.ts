/**
 * Phase 1D — the one authoritative note-duration policy.
 *
 * ## The unit (unchanged, and deliberately not redesigned)
 *
 *   Note.start    = sixteenth-note steps, fractional values allowed
 *   Note.duration = sixteenth-note steps, fractional values allowed
 *   1 beat        = 4 steps
 *
 * Phase 1A fixed the conversions, Phase 1B fixed the audible gate, Phase 1C
 * declared which instruments are gated at all. None of them answered a smaller
 * question that kept producing inconsistent behaviour: **what is the shortest
 * legal note?** Every layer that touched a duration answered it independently:
 *
 *   Piano Roll draw/resize    0.25 steps   (DEFAULT_MIN_NOTE_DURATION)
 *   MIDI import               0.5  steps   (a tick floor AND a step floor)
 *   MIDI export               1    tick    (1/120 of a step)
 *   Piano Roll "Quantize"     1    step    (Math.max(1, Math.round(d)))
 *   audible gate fallback     1–2  steps   (per instrument, Phase 1C)
 *
 * The consequences were user-visible. The Piano Roll lets you draw a 0.25-step
 * note and the exporter writes it exactly, so exporting and re-importing a
 * pattern silently doubled every short note; pressing Quantize multiplied a
 * 0.25-step note by four. Two of those five numbers were the same decision
 * taken twice, and nothing in the repository said which one was the policy.
 *
 * ## The decision
 *
 * The shortest supported musical duration is **0.25 steps** — a 64th note, one
 * sixteenth of a beat. It is the value the Piano Roll already enforced and the
 * finest value the step grid can represent meaningfully, so adopting it changes
 * no stored project and needs no migration. The supported duration grid is the
 * same 0.25 steps: a duration is legal when it is a positive multiple of the
 * minimum.
 *
 * Everything else in this module follows from those two numbers:
 *
 *   quantize  — a duration already on the grid is preserved exactly; an off-grid
 *               duration snaps to the nearest grid line (halves round up) and is
 *               then raised to the minimum. Quantizing must never lengthen a
 *               legal short note, which is what the old 1-step floor did.
 *   import    — MIDI ticks are converted to steps, snapped to the grid and
 *               raised to the minimum. A 30-tick note at 480 PPQ is exactly
 *               0.25 steps, so it imports as 0.25 steps.
 *   export    — steps are converted to ticks and rounded, with a floor of one
 *               tick. That floor is a *format* rule, not a musical one: a MIDI
 *               note-off must come after its note-on. It is far below the
 *               musical minimum on purpose, and only binds for a duration that
 *               already violated the policy upstream.
 *
 * Non-finite durations propagate. That matches the stance `musicalTime` already
 * declares: this layer converts and floors, it does not silently repair malformed
 * legacy input into a plausible value.
 *
 * ## What this module is not
 *
 * It is not a validation framework and it does not own the audible gate. Whether
 * a duration is *heard* at full length is the instrument's business, declared
 * separately by the Phase 1C instrument gate policy and converted by the Phase 1B
 * gate helper; those modules stay independent and this one never imports them.
 * The inventory below records that boundary so the two systems are not merged by
 * accident, and so a new layer that alters a duration cannot appear without
 * declaring which of the two policies it belongs to.
 *
 * No project, audio, browser or UI imports — pure data and arithmetic.
 */
import { SIXTEENTH_STEPS_PER_BEAT } from './musicalTime';

/** The canonical unit of `Note.start` and `Note.duration`. */
export const NOTE_DURATION_UNIT = 'sixteenth-note steps' as const;

/** One beat is four steps. Re-exported so consumers read it from the policy. */
export const STEPS_PER_BEAT = SIXTEENTH_STEPS_PER_BEAT;

/**
 * The shortest supported musical duration: a 64th note, one sixteenth of a beat.
 *
 * Declared as a literal because it is the product decision every other number in
 * this module is derived from.
 */
export const MIN_NOTE_DURATION_STEPS = 0.25;

/** Durations are legal on this grid; it is the same value as the minimum. */
export const DURATION_GRID_STEPS = MIN_NOTE_DURATION_STEPS;

/** Grid lines per step (4), kept as a multiplier so the arithmetic stays exact. */
export const GRID_DIVISIONS_PER_STEP = 1 / DURATION_GRID_STEPS;

/**
 * A MIDI note-off must be at least this many ticks after its note-on.
 *
 * One tick at 480 PPQ is 1/120 of a step — a transport-format minimum, not a
 * musical one. Declaring it here keeps the two MIDI writers from each inventing
 * their own `Math.max(1, …)`.
 */
export const MIN_MIDI_NOTE_OFF_DELTA_TICKS = 1;

/** True when `steps` is a positive multiple of the supported duration grid. */
export const isOnDurationGrid = (steps: number): boolean => {
  if (!Number.isFinite(steps) || steps <= 0) return false;
  const gridUnits = steps * GRID_DIVISIONS_PER_STEP;
  return Math.abs(gridUnits - Math.round(gridUnits)) < 1e-9;
};

/**
 * The one duration-quantization rule.
 *
 * On-grid durations are preserved exactly — 0.25 stays 0.25, 1.5 stays 1.5 —
 * because a duration that is already legal is not what quantization is for.
 * Off-grid durations snap to the nearest grid line, halves rounding up, and the
 * result is raised to the minimum so quantization can never produce a note
 * shorter than the product supports. Non-finite input propagates.
 */
export const quantizeDurationSteps = (steps: number): number => {
  if (!Number.isFinite(steps)) return steps;
  const snapped = Math.round(steps * GRID_DIVISIONS_PER_STEP) / GRID_DIVISIONS_PER_STEP;
  return Math.max(MIN_NOTE_DURATION_STEPS, snapped);
};

/** The shortest legal note expressed in MIDI ticks for a given resolution. */
export const minNoteDurationTicks = (ticksPerStep: number): number => MIN_NOTE_DURATION_STEPS * ticksPerStep;

/**
 * Steps to MIDI ticks for a note-off delta.
 *
 * Rounding is exact for every supported duration: 0.25 steps is 30 ticks at 480
 * PPQ, so the shortest legal note needs no repair on the way out.
 */
export const stepsToMidiDurationTicks = (steps: number, ticksPerStep: number): number =>
  Math.max(MIN_MIDI_NOTE_OFF_DELTA_TICKS, Math.round(steps * ticksPerStep));

/**
 * MIDI ticks to steps for an imported note.
 *
 * The importer's only job is to land the file's ticks on the supported grid and
 * keep the result legal, so a 30-tick note arrives as 0.25 steps rather than
 * being promoted to half a step.
 */
export const midiTicksToDurationSteps = (ticks: number, ticksPerStep: number): number =>
  quantizeDurationSteps(ticks / ticksPerStep);

/** What a layer is doing when it changes a duration. */
export const DURATION_POLICY_ROLES = [
  /** This module: declares the unit, the minimum and the grid. */
  'POLICY_OWNER',
  /** Raises a user edit up to the musical minimum. */
  'EDIT_FLOOR',
  /** Snaps a duration onto the declared grid. */
  'QUANTIZE',
  /** Raises an imported duration up to the musical minimum. */
  'IMPORT_FLOOR',
  /** Guarantees a legal MIDI note-off delta. */
  'EXPORT_TICK_FLOOR',
  /** Substitutes a duration when the stored one is unusable. */
  'FALLBACK',
  /** Copies a duration between representations without changing it. */
  'PASS_THROUGH',
  /** Turns steps into audible seconds — owned by the separate gate policy. */
  'AUDIBLE_GATE_SEPARATE_POLICY',
  /** A duration-shaped number that is not `Note.duration` at all. */
  'NON_MUSICAL',
] as const;

export type DurationPolicyRole = (typeof DURATION_POLICY_ROLES)[number];

/** The unit a layer's numbers are expressed in. */
export const DURATION_POLICY_DOMAINS = ['note-steps', 'midi-ticks', 'audio-seconds'] as const;

export type DurationPolicyDomain = (typeof DURATION_POLICY_DOMAINS)[number];

export interface DurationPolicyLayer {
  /** Stable identifier used by the completeness guard. */
  id: string;
  /** Repo-relative production file. Never a test file. */
  file: string;
  /** Functions or constants in that file that own the behaviour. */
  symbols: readonly string[];
  role: DurationPolicyRole;
  domain: DurationPolicyDomain;
  /** True when the layer reads its numbers from this module, not from literals. */
  consumesPolicy: boolean;
  /**
   * The shortest duration this layer can emit or allow, in its own domain, or
   * `null` when it enforces no floor of its own.
   */
  declaredMinimum: number | null;
  /** What the layer does today, for a reviewer who has not read the code. */
  behavior: string;
  /** Why it has this role, and why that is still the right decision. */
  reason: string;
  /** Literal source fragments that must still be present. */
  anchors: readonly string[];
  /** Literal source fragments that must never come back. */
  forbiddenAnchors?: readonly string[];
}

/**
 * Every production location that intentionally sets, floors, rounds or converts
 * a musical duration.
 *
 * This is the inventory Phase 1D was asked for. It is deliberately complete
 * rather than minimal: it also lists the layers that are *not* duration-policy
 * authorities — the audible gate, the offline renderer's seconds conversion and
 * the sample-trim floors — because an undeclared site and a misdeclared one are
 * the same failure, and the guard can only tell them apart if both are written
 * down. `phase1d.durationPolicyAudit.test.ts` pins this list with literals of
 * its own and cross-checks it against a narrow scan of the source tree.
 */
export const DURATION_ALTERING_LAYERS: readonly DurationPolicyLayer[] = Object.freeze([
  {
    id: 'policy.owner',
    file: 'src/music/noteDurationPolicy.ts',
    symbols: [
      'MIN_NOTE_DURATION_STEPS',
      'DURATION_GRID_STEPS',
      'GRID_DIVISIONS_PER_STEP',
      'MIN_MIDI_NOTE_OFF_DELTA_TICKS',
      'isOnDurationGrid',
      'quantizeDurationSteps',
      'minNoteDurationTicks',
      'stepsToMidiDurationTicks',
      'midiTicksToDurationSteps',
      'DURATION_ALTERING_LAYERS',
      'assertCompleteDurationPolicy',
    ],
    role: 'POLICY_OWNER',
    domain: 'note-steps',
    consumesPolicy: true,
    declaredMinimum: 0.25,
    behavior: 'Declares the unit, the 0.25-step minimum, the grid and every conversion the other layers use.',
    reason: 'One owner. Before this module each layer derived its own floor, which is the defect being fixed.',
    anchors: [
      "NOTE_DURATION_UNIT = 'sixteenth-note steps'",
      'DURATION_GRID_STEPS = MIN_NOTE_DURATION_STEPS',
      'MIN_MIDI_NOTE_OFF_DELTA_TICKS = 1',
    ],
  },
  {
    id: 'piano-roll.edit-floor',
    file: 'src/components/pianoRollOperations.ts',
    symbols: ['DEFAULT_MIN_NOTE_DURATION', 'validateNote', 'resizeNoteRight', 'resizeNoteLeft'],
    role: 'EDIT_FLOOR',
    domain: 'note-steps',
    consumesPolicy: true,
    declaredMinimum: 0.25,
    behavior: 'Drawing, dragging and resizing clamp a note up to DEFAULT_MIN_NOTE_DURATION and reject anything shorter.',
    reason:
      'This was already the strictest layer in the product and the only one users can see, so its value became ' +
      'the policy minimum; the constant now reads it from the policy instead of restating it.',
    anchors: ['DEFAULT_MIN_NOTE_DURATION = MIN_NOTE_DURATION_STEPS'],
    forbiddenAnchors: ['DEFAULT_MIN_NOTE_DURATION = 0.25'],
  },
  {
    id: 'piano-roll.quantize',
    file: 'src/components/PianoRoll.tsx',
    symbols: ['handleQuantizeNotes', 'quantizeDurationSteps'],
    role: 'QUANTIZE',
    domain: 'note-steps',
    consumesPolicy: true,
    declaredMinimum: 0.25,
    behavior: 'Snaps onsets to the 1-step positional grid and durations to the declared 0.25-step duration grid.',
    reason:
      'The duration grid is finer than the positional grid on purpose. Rounding durations to whole steps multiplied ' +
      'every legal short note, which is not quantization but destruction of the shortest notes the editor supports.',
    anchors: ['duration: quantizeDurationSteps(n.duration)'],
    forbiddenAnchors: ['Math.max(1, Math.round(n.duration))'],
  },
  {
    id: 'midi.import',
    file: 'src/utils/midiParser.ts',
    symbols: ['parseMidiFile', 'midiTicksToDurationSteps', 'minNoteDurationTicks'],
    role: 'IMPORT_FLOOR',
    domain: 'note-steps',
    consumesPolicy: true,
    declaredMinimum: 0.25,
    behavior: 'Converts note-on/note-off tick deltas to steps, snaps them to the grid and raises them to the minimum.',
    reason:
      'The importer floored twice at half a step, so a 30-tick note that Apex itself had just written came back ' +
      'twice as long. A valid short note must survive the round trip.',
    anchors: ['midiTicksToDurationSteps(durTicks, ticksPerStep)', 'minNoteDurationTicks(ticksPerStep)'],
    forbiddenAnchors: [
      'Math.max(0.5, Math.round((durTicks / ticksPerStep) * 4) / 4)',
      'Math.max(ticksPerStep / 2,',
    ],
  },
  {
    id: 'midi.import-unterminated-fallback',
    file: 'src/utils/midiParser.ts',
    symbols: ['activeNotes.forEach'],
    role: 'FALLBACK',
    domain: 'note-steps',
    consumesPolicy: false,
    declaredMinimum: 2,
    behavior: 'A note-on with no matching note-off anywhere in the track is imported as two steps long.',
    reason:
      'A truncated file states no length at all, so the importer supplies one. Two steps is a visible, editable ' +
      'default well above the minimum; this phase records it rather than changing it.',
    anchors: ['durationSteps: 2,'],
  },
  {
    id: 'midi.export-piano-roll',
    file: 'src/utils/midiParser.ts',
    symbols: ['exportNotesToMidi', 'stepsToMidiDurationTicks'],
    role: 'EXPORT_TICK_FLOOR',
    domain: 'midi-ticks',
    consumesPolicy: true,
    declaredMinimum: 1,
    behavior: 'Writes a note-off one rounded tick delta after its note-on, never closer than one tick.',
    reason:
      'A zero-tick delta is not a note a reader can parse. The floor is a format rule, so it stays in ticks and far ' +
      'below the musical minimum; 0.25 steps already writes an exact 30 ticks at 480 PPQ.',
    anchors: ['stepsToMidiDurationTicks(n.duration, ticksPerStep)'],
    forbiddenAnchors: ['Math.max(1, Math.round(n.duration * ticksPerStep))'],
  },
  {
    id: 'midi.export-project',
    file: 'src/utils/exportUtils.ts',
    symbols: ['emitAtStep', 'MIN_MIDI_NOTE_OFF_DELTA_TICKS'],
    role: 'EXPORT_TICK_FLOOR',
    domain: 'midi-ticks',
    consumesPolicy: true,
    declaredMinimum: 1,
    behavior: 'The project writer emits the same one-tick-minimum note-off delta as the channel writer.',
    reason:
      'Two MIDI writers must not state two different minimums for one project. The step-domain guard on the same ' +
      'line predates the policy and is deliberately left alone: it only binds for input that is already invalid.',
    anchors: ['MIN_MIDI_NOTE_OFF_DELTA_TICKS'],
    forbiddenAnchors: ['Math.max(1, Math.round(Math.max(0.01, content.durationSteps)'],
  },
  {
    id: 'midi.export-content-fallback',
    file: 'src/utils/exportUtils.ts',
    symbols: ['contentEventsAtStep'],
    role: 'FALLBACK',
    domain: 'note-steps',
    consumesPolicy: false,
    declaredMinimum: 1,
    behavior: 'A note whose stored length is not a positive finite number is exported as one step.',
    reason:
      'Malformed input needs a value, and one step is the historical choice. It is above the minimum, so it is ' +
      'recorded as compliant rather than rewritten; repairing stored data is a persistence concern (P9).',
    anchors: ['? note.duration : 1'],
  },
  {
    id: 'midi.import-plan',
    file: 'src/components/pianoRollMidiImport.ts',
    symbols: ['planMidiImport'],
    role: 'PASS_THROUGH',
    domain: 'note-steps',
    consumesPolicy: false,
    declaredMinimum: null,
    behavior: 'Copies parsed step values into new notes unchanged, assigning each destination and note id.',
    reason:
      'Planning is about which track lands where, not how long a note is. It must stay a pass-through so the ' +
      'importer remains the only layer that decides a floor.',
    anchors: ['duration: parsedNote.durationSteps'],
  },
  {
    id: 'engine.playable-length-fallback',
    file: 'src/audio/audioEngine.ts',
    symbols: ['resolvePlayableContentLengthSteps'],
    role: 'FALLBACK',
    domain: 'note-steps',
    consumesPolicy: false,
    declaredMinimum: 1,
    behavior: 'Measures how much timeline a channel occupies, treating an unusable note length as one step.',
    reason:
      'This computes a pattern length, not a note. A one-step assumption only widens the loop boundary and cannot ' +
      'shorten anything the user hears, so it stays as it is.',
    anchors: ['Number.isFinite(note.duration) && note.duration > 0'],
  },
  {
    id: 'engine.bass-extraction-fallback',
    file: 'src/audio/audioEngine.ts',
    symbols: ['extractBassNotesFromChords'],
    role: 'FALLBACK',
    domain: 'note-steps',
    consumesPolicy: false,
    declaredMinimum: 2,
    behavior: 'Derives a bassline from chord roots, giving a generated note two steps when the source has no usable length.',
    reason:
      'Generated content, not a floor on user content: two steps keeps a bass note audible under a chord. Recorded ' +
      'here so the constant is a decision rather than an accident.',
    anchors: ['lowest.duration || 2'],
  },
  {
    id: 'engine.offline-render-window',
    file: 'src/audio/audioEngine.ts',
    symbols: ['renderTimelineOffline', 'minimumDurationSeconds'],
    role: 'NON_MUSICAL',
    domain: 'audio-seconds',
    consumesPolicy: false,
    declaredMinimum: null,
    behavior: 'Floors the offline render window at a number of seconds, defaulting to four when none is requested.',
    reason:
      'Shares a variable name shape with a note length but is a render-window duration in seconds. Listed so the ' +
      'guard never mistakes it for a musical floor.',
    anchors: ['const requestedMinimumDuration'],
  },
  {
    id: 'polyphonic.blob-audition',
    file: 'src/components/PolyphonicEditorModal.tsx',
    symbols: ['polyphonicBlobAuditionNote', 'handleSplitBlob'],
    role: 'PASS_THROUGH',
    domain: 'note-steps',
    consumesPolicy: false,
    declaredMinimum: null,
    behavior: 'Auditions a vocal blob with its own step length, and splits a blob longer than two steps in half.',
    reason:
      'Blob lengths are already step values, so the audition note passes them through (Phase 1B fixed a stray ' +
      'division here). The split refuses blobs of two steps or less, so neither half can fall below the minimum.',
    anchors: ['duration: blob.durationSteps', 'target.durationSteps <= 2'],
  },
  {
    id: 'gate.note-gate',
    file: 'src/audio/noteGate.ts',
    symbols: ['resolveGateSeconds', 'DEFAULT_GATE_FALLBACK_STEPS'],
    role: 'AUDIBLE_GATE_SEPARATE_POLICY',
    domain: 'audio-seconds',
    consumesPolicy: false,
    declaredMinimum: null,
    behavior: 'Converts a duration in steps to an audible gate in seconds, scaled by the instrument character.',
    reason:
      'Phase 1B. A different question — how long a voice sounds — with its own tempo arithmetic. Declared here so ' +
      'the boundary is explicit; the two modules must not import each other.',
    anchors: ['resolveGateSeconds'],
  },
  {
    id: 'gate.instrument-policy',
    file: 'src/audio/instrumentGatePolicy.ts',
    symbols: ['INSTRUMENT_GATE_POLICY', 'fallbackSteps'],
    role: 'AUDIBLE_GATE_SEPARATE_POLICY',
    domain: 'note-steps',
    consumesPolicy: false,
    declaredMinimum: 1,
    behavior: 'Declares per instrument whether a length is audible at all, and the steps assumed when it is unusable.',
    reason:
      'Phase 1C. Its fallback values are 1 to 2 steps and are about an inaudible or malformed note, not about the ' +
      'shortest legal one, so they are intentionally untouched by this phase.',
    anchors: ['INSTRUMENT_GATE_POLICY'],
  },
  {
    id: 'render.offline-note-gate',
    file: 'src/audio/offlineProjectRenderer.ts',
    symbols: ['renderProjectTimelineOffline', 'noteDuration'],
    role: 'AUDIBLE_GATE_SEPARATE_POLICY',
    domain: 'audio-seconds',
    consumesPolicy: false,
    declaredMinimum: null,
    behavior: 'Converts each note length to seconds for the offline mixdown, clipped to the remaining clip time.',
    reason:
      'A consumer of the unit, not an owner of the minimum. The offline renderer is protected scope (P1) and its ' +
      'conversion is already step-based, so a 0.25-step note renders at a quarter of a step of seconds.',
    anchors: ['noteDuration'],
  },
  {
    id: 'dsp.sample-trim-drumpad',
    file: 'src/audio/instruments/drumPad.ts',
    symbols: ['renderDrumPadVoice'],
    role: 'NON_MUSICAL',
    domain: 'audio-seconds',
    consumesPolicy: false,
    declaredMinimum: null,
    behavior: 'Floors a trimmed sample region at one millisecond of audio so the player node gets a positive length.',
    reason:
      'Sample trim length in seconds. It looks like a duration floor and is not one; declared so a reviewer sees ' +
      'that it was considered and left alone.',
    anchors: ['Math.max(0.001, end - start)'],
  },
  {
    id: 'dsp.sample-trim-sampler',
    file: 'src/audio/instruments/sampler.ts',
    symbols: ['renderSamplerVoice'],
    role: 'NON_MUSICAL',
    domain: 'audio-seconds',
    consumesPolicy: false,
    declaredMinimum: null,
    behavior: 'Floors a trimmed sampler zone at one millisecond of audio for the same reason as the drum pad.',
    reason: 'Sample trim length in seconds, not a note length. Protected DSP scope, recorded as non-musical.',
    anchors: ['Math.max(0.001, trimEnd - trimStart)'],
  },
]);

/** The declared entry for one layer id. */
export const getDurationPolicyLayer = (id: string): DurationPolicyLayer | undefined =>
  DURATION_ALTERING_LAYERS.find(layer => layer.id === id);

/**
 * Runtime completeness guard, mirroring the Phase 1C equivalent.
 *
 * Throws rather than returning false so the failure names the offending entry.
 * The test suite cross-checks this list against the source tree; this function
 * only validates the list against itself, so it stays cheap enough to call from
 * anywhere.
 */
export const assertCompleteDurationPolicy = (): true => {
  const seen = new Set<string>();
  for (const layer of DURATION_ALTERING_LAYERS) {
    if (!layer.id) throw new Error('[DurationPolicy] an entry declares no id');
    if (seen.has(layer.id)) throw new Error(`[DurationPolicy] duplicate entry id "${layer.id}"`);
    seen.add(layer.id);
    if (!layer.file.startsWith('src/') || layer.file.includes('.test.')) {
      throw new Error(`[DurationPolicy] "${layer.id}" must point at a production file under src/`);
    }
    if (!DURATION_POLICY_ROLES.includes(layer.role)) {
      throw new Error(`[DurationPolicy] "${layer.id}" declares unknown role "${layer.role}"`);
    }
    if (!DURATION_POLICY_DOMAINS.includes(layer.domain)) {
      throw new Error(`[DurationPolicy] "${layer.id}" declares unknown domain "${layer.domain}"`);
    }
    if (layer.symbols.length === 0) throw new Error(`[DurationPolicy] "${layer.id}" declares no symbols`);
    if (layer.anchors.length === 0) throw new Error(`[DurationPolicy] "${layer.id}" declares no source anchors`);
    if (!layer.behavior) throw new Error(`[DurationPolicy] "${layer.id}" does not describe what it does`);
    if (!layer.reason) throw new Error(`[DurationPolicy] "${layer.id}" does not say why it has that role`);
    if (layer.declaredMinimum !== null) {
      if (!Number.isFinite(layer.declaredMinimum) || layer.declaredMinimum <= 0) {
        throw new Error(`[DurationPolicy] "${layer.id}" declares a non-positive minimum`);
      }
      if (layer.domain === 'note-steps' && layer.declaredMinimum < MIN_NOTE_DURATION_STEPS) {
        throw new Error(
          `[DurationPolicy] "${layer.id}" declares ${layer.declaredMinimum} steps, below the policy minimum`,
        );
      }
    }
    if (layer.role === 'POLICY_OWNER' && layer.file !== 'src/music/noteDurationPolicy.ts') {
      throw new Error(`[DurationPolicy] "${layer.id}" claims ownership from outside the policy module`);
    }
  }
  if (!seen.has('policy.owner')) throw new Error('[DurationPolicy] the inventory does not name its own owner');
  return true;
};
