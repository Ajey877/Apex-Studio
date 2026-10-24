/**
 * Phase 10B — polyphonic Audio-to-MIDI against REAL synthesized PCM.
 *
 * Every fixture here is generated sample by sample (additive harmonic tones with
 * independent attack/release envelopes, vibrato as an integrated instantaneous
 * frequency, deterministic LCG noise, bell-like inharmonic partials, silence).
 * Nothing is mocked: the assertions read the notes the production analyzer
 * derives from those samples, and every transcription case is scored against an
 * explicit ground truth with stated pitch/onset/offset tolerances, so precision
 * and recall are measured rather than asserted by eye.
 *
 * Covered:
 *  - two simultaneous notes with independent onsets/offsets;
 *  - a three-note chord and a four-voice chord (the documented ceiling);
 *  - a melody over a sustained bass (shared harmonics: C5 sits on C3's 4th);
 *  - harmonic-rich timbres (sawtooth-like) proving overtones never become notes;
 *  - repeated same-pitch notes, separated and legato;
 *  - vibrato, attack/release envelopes and a 6 dB amplitude difference;
 *  - the range boundaries C2/C6 and out-of-range material (C1, C7, +36 semitones);
 *  - silence, deterministic noise, click trains, inharmonic bells and 5/6-voice
 *    clusters, all of which must refuse with a typed reason and zero notes;
 *  - trims, pitch shift and playback rate;
 *  - several tempos/meters (steps-per-second 4 … 16);
 *  - determinism, the counted analysis budget, voice/note caps and the note
 *    duration policy;
 *  - the confidence and velocity mapping being measured functions, not constants.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  POLY_FFT_SIZE,
  POLY_MAX_FRAMES,
  POLY_MAX_MIDI,
  POLY_MAX_NOTES,
  POLY_MAX_VOICES,
  POLY_MIN_MIDI,
  POLY_MIN_NOTE_FRAMES,
  transcribePolyphonicPcm,
  type PolyphonicAnalysis,
  type PolyphonicNote,
  type PolyphonicRefusal,
} from './polyphonicTranscription';

const SR = 44100;

const midiToFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
const stepsPerSecondFor = (bpm: number): number => (bpm / 60) * 4;

/** A tone in a fixture: MIDI pitch, audible span in seconds, and its timbre. */
interface Tone {
  midi: number;
  startSeconds: number;
  endSeconds: number;
  /** Relative amplitude against the other tones (default 0.25). */
  amplitude?: number;
  /** Harmonic amplitudes (default: a mildly rich 1, 1/2, 1/4, 1/8 series). */
  harmonics?: readonly number[];
  /** Vibrato depth as a frequency *ratio* (0.008 = ±14 cents), 5.5 Hz. */
  vibrato?: number;
}

const RICH: readonly number[] = [1, 0.5, 0.25, 0.125];
/** A bright sawtooth-like timbre: energy in every partial, 1/h roll-off. */
const SAW: readonly number[] = [1, 0.8, 0.65, 0.55, 0.47, 0.4, 0.35, 0.3, 0.26, 0.22, 0.19, 0.16];

/**
 * Renders additive harmonic tones sample by sample. The vibrato is integrated
 * into the phase (a frequency offset, not a time-scaled phase argument, which
 * would smear the pitch by tens of percent), and each tone gets an 8 ms
 * attack/release so onsets are real events rather than clicks.
 */
const renderTones = (seconds: number, tones: readonly Tone[]): Float32Array => {
  const data = new Float32Array(Math.round(seconds * SR));
  for (const tone of tones) {
    const frequency = midiToFreq(tone.midi);
    const harmonics = tone.harmonics ?? RICH;
    const from = Math.max(0, Math.floor(tone.startSeconds * SR));
    const to = Math.min(data.length, Math.ceil(tone.endSeconds * SR));
    const fade = 0.008 * SR;
    let phase = 0;
    for (let i = from; i < to; i += 1) {
      const envelope =
        Math.min(1, (i - tone.startSeconds * SR) / fade) *
        Math.min(1, (tone.endSeconds * SR - i) / fade);
      const vibrato = tone.vibrato ? tone.vibrato * Math.sin(2 * Math.PI * 5.5 * (i / SR)) : 0;
      phase += (2 * Math.PI * frequency * (1 + vibrato)) / SR;
      let sample = 0;
      for (let h = 1; h <= harmonics.length; h += 1) {
        sample += harmonics[h - 1] * Math.sin(phase * h);
      }
      data[i] += (tone.amplitude ?? 0.25) * envelope * sample;
    }
  }
  return data;
};

/** Deterministic uniform noise (LCG — same bytes on every run and machine). */
const renderNoise = (seconds: number, amplitude: number, seed = 0x51f3a7): Float32Array => {
  const data = new Float32Array(Math.round(seconds * SR));
  let state = seed >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = (state / 4294967296 - 0.5) * amplitude;
  }
  return data;
};

/** A click train: broadband transients with no harmonic series at all. */
const renderClicks = (seconds: number, periodSamples = 4000): Float32Array => {
  const data = new Float32Array(Math.round(seconds * SR));
  for (let start = 0; start < data.length; start += periodSamples) {
    for (let i = 0; i < 200 && start + i < data.length; i += 1) {
      data[start + i] += (1 - i / 200) * 0.5;
    }
  }
  return data;
};

/** A bell: partials at non-integer ratios of the fundamental (inharmonic). */
const renderBell = (seconds: number, fundamental = 220): Float32Array => {
  const data = new Float32Array(Math.round(seconds * SR));
  const partials: ReadonlyArray<readonly [number, number, number]> = [
    [1, 1, 1.2],
    [2.76, 0.5, 0.9],
    [5.4, 0.3, 0.6],
    [8.93, 0.18, 0.4],
  ];
  const start = 0.1 * SR;
  for (const [ratio, amplitude, decay] of partials) {
    const frequency = fundamental * ratio;
    for (let i = Math.floor(start); i < Math.min(data.length, seconds * SR); i += 1) {
      const t = (i - start) / SR;
      const envelope = Math.min(1, (i - start) / (0.005 * SR)) * Math.exp(-t / decay);
      data[i] += amplitude * envelope * Math.sin((2 * Math.PI * frequency * i) / SR);
    }
  }
  return data;
};

const planFor = (seconds: number, overrides: Partial<{
  playbackRate: number;
  pitchOffsetSemitones: number;
  stepsPerSecond: number;
  timelineSeconds: number;
}> = {}) => ({
  playbackRate: 1,
  pitchOffsetSemitones: 0,
  stepsPerSecond: 8,
  timelineSeconds: seconds,
  ...overrides,
});

const analyse = (
  channels: readonly Float32Array[],
  seconds: number,
  options: { minNoteSteps?: number; quantizeSteps?: number; candidateShare?: number } = {},
  planOverrides: Parameters<typeof planFor>[1] = {},
): PolyphonicAnalysis =>
  transcribePolyphonicPcm({
    channels,
    sampleRate: SR,
    plan: planFor(seconds, planOverrides),
    options: { minNoteSteps: 0.5, quantizeSteps: 0.25, ...options },
  });

/** One expected note in project steps, against which detections are scored. */
interface ExpectedNote {
  midi: number;
  startStep: number;
  endStep: number;
}

/**
 * The documented matching tolerances. A detection counts as a true positive only
 * when the pitch matches exactly and both edges are within the stated tolerance;
 * anything else is a false positive, so precision cannot be gamed by splitting
 * notes into fragments or by padding durations.
 */
const ONSET_TOLERANCE_STEPS = 0.5;
const OFFSET_TOLERANCE_STEPS = 0.75;

interface Score {
  truePositives: number;
  falsePositives: PolyphonicNote[];
  falseNegatives: ExpectedNote[];
}

const score = (notes: readonly PolyphonicNote[], expected: readonly ExpectedNote[]): Score => {
  const used = new Set<number>();
  const falseNegatives: ExpectedNote[] = [];
  let truePositives = 0;
  for (const target of expected) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    notes.forEach((note, index) => {
      if (used.has(index) || note.midi !== target.midi) return;
      const onset = Math.abs(note.startStep - target.startStep);
      const offset = Math.abs(note.startStep + note.durationSteps - target.endStep);
      if (onset > ONSET_TOLERANCE_STEPS || offset > OFFSET_TOLERANCE_STEPS) return;
      if (onset + offset < bestCost) {
        best = index;
        bestCost = onset + offset;
      }
    });
    if (best >= 0) {
      used.add(best);
      truePositives += 1;
    } else {
      falseNegatives.push(target);
    }
  }
  const falsePositives = notes.filter((_, index) => !used.has(index));
  return { truePositives, falsePositives, falseNegatives };
};

/** Steps for a fixture time, quantised to the 0.25 grid the analyzer uses. */
const stepOf = (seconds: number, stepsPerSecond = 8): number =>
  Math.round((seconds * stepsPerSecond) / 0.25) * 0.25;

const expectNotes = (midi: number, startSeconds: number, endSeconds: number, sps = 8): ExpectedNote => ({
  midi,
  startStep: stepOf(startSeconds, sps),
  endStep: stepOf(endSeconds, sps),
});

const describeScore = (label: string, result: PolyphonicAnalysis, expected: readonly ExpectedNote[]) => {
  const scored = score(result.notes, expected);
  const precision = result.notes.length === 0
    ? (expected.length === 0 ? 1 : 0)
    : scored.truePositives / result.notes.length;
  const recall = expected.length === 0 ? 1 : scored.truePositives / expected.length;
  return {
    label,
    ...scored,
    precision,
    recall,
    detected: result.notes.map(note => `${note.noteName}@${note.startStep}+${note.durationSteps}`),
  };
};

const assertScore = (label: string, result: PolyphonicAnalysis, expected: readonly ExpectedNote[]) => {
  const report = describeScore(label, result, expected);
  assert.equal(result.status, 'ok', `${label}: expected a transcription, got ${result.status}/${result.refusal}`);
  assert.deepEqual(
    report.falseNegatives.map(note => `${note.midi}@${note.startStep}`),
    [],
    `${label}: missed ground-truth notes (detected ${report.detected.join(', ')})`
  );
  assert.deepEqual(
    report.falsePositives.map(note => `${note.noteName}@${note.startStep}+${note.durationSteps}`),
    [],
    `${label}: reported notes that are not in the ground truth`
  );
  assert.equal(report.recall, 1);
  assert.equal(report.precision, 1);
  return report;
};

const assertRefusal = (
  label: string,
  result: PolyphonicAnalysis,
  refusal: PolyphonicRefusal,
) => {
  assert.equal(result.status, 'rejected', `${label}: expected a refusal`);
  assert.equal(result.refusal, refusal, `${label}: wrong refusal reason`);
  assert.deepEqual(result.notes, [], `${label}: a refusal must not carry notes`);
  assert.ok(result.message.length > 20, `${label}: a refusal needs a real explanation`);
};

describe('Phase 10B polyphonic transcription — measured musical accuracy', () => {
  it('transcribes a single rich tone as exactly one note (harmonics are not notes)', () => {
    const pcm = renderTones(2, [{ midi: 60, startSeconds: 0.1, endSeconds: 1.4 }]);
    const result = analyse([pcm], 2);
    assertScore('single tone', result, [expectNotes(60, 0.1, 1.4)]);
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].midi, 60);
    assert.ok(Math.abs(result.notes[0].centsOffset) <= 20, 'measured pitch must be within 20 cents');
  });

  it('transcribes a sawtooth-like tone as one note — no octave/fifth inflation', () => {
    const pcm = renderTones(2, [
      { midi: 57, startSeconds: 0.1, endSeconds: 1.5, harmonics: SAW },
    ]);
    const result = analyse([pcm], 2);
    assertScore('sawtooth', result, [expectNotes(57, 0.1, 1.5)]);
    assert.equal(result.notes.length, 1, 'twelve partials must still produce one note');
    assert.equal(result.notes[0].midi, 57);
  });

  it('separates two simultaneous notes with independent onsets and offsets', () => {
    const pcm = renderTones(2, [
      { midi: 60, startSeconds: 0.1, endSeconds: 0.7 },
      { midi: 67, startSeconds: 0.9, endSeconds: 1.6 },
    ]);
    const result = analyse([pcm], 2);
    assertScore('two notes', result, [
      expectNotes(60, 0.1, 0.7),
      expectNotes(67, 0.9, 1.6),
    ]);
    // The independent onsets must survive: the notes must not be merged.
    const [first, second] = result.notes.slice().sort((a, b) => a.startStep - b.startStep);
    assert.ok(second.startStep - (first.startStep + first.durationSteps) >= 0.5, 'notes must not merge');
  });

  it('transcribes a three-note chord', () => {
    const pcm = renderTones(2, [60, 64, 67].map(midi => ({
      midi,
      startSeconds: 0.1,
      endSeconds: 1.6,
    })));
    const result = analyse([pcm], 2);
    assertScore('triad', result, [
      expectNotes(60, 0.1, 1.6),
      expectNotes(64, 0.1, 1.6),
      expectNotes(67, 0.1, 1.6),
    ]);
    assert.deepEqual(result.notes.map(note => note.midi), [60, 64, 67]);
  });

  it('transcribes the documented four-voice ceiling', () => {
    const pcm = renderTones(2, [48, 55, 64, 72].map(midi => ({
      midi,
      startSeconds: 0.1,
      endSeconds: 1.6,
    })));
    const result = analyse([pcm], 2);
    assertScore('four voices', result, [48, 55, 64, 72].map(midi => expectNotes(midi, 0.1, 1.6)));
    assert.ok(result.stats.maxSimultaneousVoices <= POLY_MAX_VOICES);
  });

  it('transcribes a melody over a sustained bass whose harmonics it shares', () => {
    // C5 and E5 sit exactly on the 4th and 5th harmonics of the C3 bass: the
    // case where cancelling shared bins would erase the melody.
    const pcm = renderTones(3, [
      { midi: 48, startSeconds: 0.1, endSeconds: 2.6 },
      { midi: 72, startSeconds: 0.1, endSeconds: 0.8 },
      { midi: 76, startSeconds: 1.0, endSeconds: 1.7 },
      { midi: 74, startSeconds: 1.9, endSeconds: 2.6 },
    ]);
    const result = analyse([pcm], 3);
    assertScore('melody over bass', result, [
      expectNotes(48, 0.1, 2.6),
      expectNotes(72, 0.1, 0.8),
      expectNotes(76, 1.0, 1.7),
      expectNotes(74, 1.9, 2.6),
    ]);
  });

  it('keeps repeated same-pitch notes apart, with a gap and legato-like', () => {
    const gapped = renderTones(2, [
      { midi: 60, startSeconds: 0.1, endSeconds: 0.6 },
      { midi: 60, startSeconds: 0.85, endSeconds: 1.4 },
    ]);
    assertScore('repeated with gap', analyse([gapped], 2), [
      expectNotes(60, 0.1, 0.6),
      expectNotes(60, 0.85, 1.4),
    ]);

    const legato = renderTones(2, [
      { midi: 60, startSeconds: 0.1, endSeconds: 0.6 },
      { midi: 60, startSeconds: 0.62, endSeconds: 1.1 },
    ]);
    assertScore('repeated legato', analyse([legato], 2), [
      expectNotes(60, 0.1, 0.6),
      expectNotes(60, 0.62, 1.1),
    ]);
  });

  it('does not explode a vibrato tone into extra notes', () => {
    const pcm = renderTones(2, [
      { midi: 69, startSeconds: 0.1, endSeconds: 1.4, vibrato: 0.008 },
    ]);
    const result = analyse([pcm], 2);
    assertScore('vibrato', result, [expectNotes(69, 0.1, 1.4)]);
    assert.equal(result.notes.length, 1);
  });

  it('detects two notes 6 dB apart and derives velocity from the measurement', () => {
    const pcm = renderTones(2, [
      { midi: 60, startSeconds: 0.1, endSeconds: 1.4, amplitude: 0.3 },
      { midi: 67, startSeconds: 0.1, endSeconds: 1.4, amplitude: 0.15 },
    ]);
    const result = analyse([pcm], 2);
    assertScore('6 dB apart', result, [expectNotes(60, 0.1, 1.4), expectNotes(67, 0.1, 1.4)]);
    const loud = result.notes.find(note => note.midi === 60)!;
    const soft = result.notes.find(note => note.midi === 67)!;
    assert.ok(loud.velocity > soft.velocity, 'the louder note must get the higher velocity');
    assert.ok(loud.velocity > 0.6 && soft.velocity < 0.95, 'velocity must track the measured amplitude');
  });

  it('transcribes the documented range boundaries C2 and C6', () => {
    const low = renderTones(2, [{ midi: POLY_MIN_MIDI, startSeconds: 0.1, endSeconds: 1.3 }]);
    assertScore('C2', analyse([low], 2), [expectNotes(POLY_MIN_MIDI, 0.1, 1.3)]);

    const high = renderTones(2, [{ midi: POLY_MAX_MIDI, startSeconds: 0.1, endSeconds: 1.3 }]);
    assertScore('C6', analyse([high], 2), [expectNotes(POLY_MAX_MIDI, 0.1, 1.3)]);
  });

  it('refuses material outside the range instead of reporting its harmonics', () => {
    // C1 (MIDI 24) is below the range: without the guard range its 2nd and 3rd
    // harmonics would be reported as C2 and G2, which are not in the audio.
    const low = renderTones(2, [{ midi: 24, startSeconds: 0.1, endSeconds: 1.5 }]);
    assertRefusal('C1', analyse([low], 2), 'no-fundamentals');

    const high = renderTones(2, [{ midi: 96, startSeconds: 0.1, endSeconds: 1.5 }]);
    assertRefusal('C7', analyse([high], 2), 'no-fundamentals');
  });

  it('applies the clip pitch offset once and refuses when it leaves the range', () => {
    const pcm = renderTones(2, [{ midi: 60, startSeconds: 0.1, endSeconds: 1.1 }]);
    const shifted = analyse([pcm], 2, {}, { pitchOffsetSemitones: 5 });
    assertScore('pitch +5', shifted, [expectNotes(65, 0.1, 1.1)]);

    const tooFar = analyse([pcm], 2, {}, { pitchOffsetSemitones: 36 });
    assertRefusal('pitch +36', tooFar, 'no-fundamentals');
  });

  it('compensates the clip playback rate', () => {
    // The engine plays the window twice as fast, so 0.05–0.55 s of source is
    // 0.025–0.275 s on the timeline.
    const pcm = renderTones(2, [{ midi: 60, startSeconds: 0.05, endSeconds: 0.55 }]);
    const result = analyse([pcm], 2, {}, { playbackRate: 2 });
    assertScore('rate 2', result, [expectNotes(60, 0.025, 0.275)]);
  });

  it('honours trims: the analysed window is the audio that plays', () => {
    const source = renderTones(2.4, [{ midi: 60, startSeconds: 0.5, endSeconds: 1.5 }]);
    const trimmed = source.subarray(Math.round(0.3 * SR)).slice();
    const result = analyse([trimmed], 2);
    assertScore('trimmed', result, [expectNotes(60, 0.2, 1.2)]);
  });

  it('keeps onset/offset accuracy across tempos and meters (4 … 16 steps per second)', () => {
    const pcm = renderTones(2, [{ midi: 60, startSeconds: 0.12, endSeconds: 1.05 }]);
    for (const stepsPerSecond of [4, 8, 12, 16]) {
      // 60/90/180/240 BPM in 4/4; a 3/4 and 7/8 bar change only the bar length,
      // which this analyzer never uses for note timing.
      const result = analyse([pcm], 2, {}, { stepsPerSecond });
      const report = assertScore(`sps ${stepsPerSecond}`, result, [
        expectNotes(60, 0.12, 1.05, stepsPerSecond),
      ]);
      assert.equal(report.truePositives, 1);
    }
  });
});

describe('Phase 10B polyphonic transcription — refusals with zero output', () => {
  it('refuses silence', () => {
    assertRefusal('silence', analyse([new Float32Array(SR * 2)], 2), 'silence-or-noise');
  });

  it('refuses deterministic broadband noise', () => {
    assertRefusal('noise', analyse([renderNoise(2, 0.25)], 2), 'no-fundamentals');
  });

  it('refuses a click train (no harmonic series)', () => {
    assertRefusal('clicks', analyse([renderClicks(2)], 2), 'no-fundamentals');
  });

  it('refuses inharmonic bell partials rather than inventing notes', () => {
    assertRefusal('bell', analyse([renderBell(2)], 2), 'unreliable-harmonics');
  });

  it('refuses more than four simultaneous fundamentals', () => {
    const pcm = renderTones(2, [48, 52, 55, 59, 62].map(midi => ({
      midi,
      startSeconds: 0.1,
      endSeconds: 1.6,
    })));
    assertRefusal('five voices', analyse([pcm], 2), 'polyphony-exceeded');

    const six = renderTones(2, [48, 52, 55, 59, 62, 65].map(midi => ({
      midi,
      startSeconds: 0.1,
      endSeconds: 1.6,
    })));
    assertRefusal('six voices', analyse([six], 2), 'polyphony-exceeded');
  });

  it('refuses a window longer than the analysis budget', () => {
    const long = renderNoise(31, 0.05);
    assertRefusal('31 s', analyse([long], 31), 'analysis-budget');
  });

  it('refuses when no note clears the note-duration policy', () => {
    // Two long notes with one very short note between them: the clip is pitched
    // (so it is not "short coverage"), but the short note cannot be reported at a
    // 1-step minimum.
    const pcm = renderTones(2, [
      { midi: 60, startSeconds: 0.05, endSeconds: 0.8 },
      { midi: 64, startSeconds: 0.81, endSeconds: 0.86 },
      { midi: 60, startSeconds: 1.2, endSeconds: 1.9 },
    ]);
    const result = analyse([pcm], 2, { minNoteSteps: 2 });
    assert.equal(result.status, 'ok');
    assert.ok(
      result.notes.every(note => note.durationSteps >= 2),
      'no reported note may be shorter than the minimum length'
    );
    assert.ok(result.stats.droppedShortNotes >= 0);
    const nothing = analyse([renderTones(2, [{ midi: 64, startSeconds: 0.05, endSeconds: 0.08 }])], 2, {
      minNoteSteps: 2,
    });
    assert.notEqual(nothing.status, 'ok');
    assert.deepEqual(nothing.notes, []);
  });
});

describe('Phase 10B polyphonic transcription — measurement, bounds and determinism', () => {
  it('is deterministic: same PCM and settings produce identical notes', () => {
    const pcm = renderTones(2, [
      { midi: 60, startSeconds: 0.1, endSeconds: 1.0 },
      { midi: 67, startSeconds: 0.3, endSeconds: 1.4 },
    ]);
    const first = analyse([pcm], 2);
    const second = analyse([pcm], 2);
    const strip = (result: PolyphonicAnalysis) => ({
      ...result,
      stats: { ...result.stats, analysisMilliseconds: 0 },
    });
    assert.deepEqual(strip(second), strip(first));
  });

  it('bounds its work with counted quantities, not wall-clock time', () => {
    const seconds = 30;
    const pcm = renderTones(seconds, [{ midi: 60, startSeconds: 0.2, endSeconds: seconds - 0.5 }]);
    const result = analyse([pcm], seconds);
    assert.equal(result.status, 'ok');
    assert.ok(result.stats.frameCount <= POLY_MAX_FRAMES, 'frame count must respect the budget');
    assert.ok(result.stats.windowSamples === POLY_FFT_SIZE);
    assert.ok(result.stats.analysedSeconds <= seconds);
    // Informational only — reported, never used to decide anything.
    assert.equal(typeof result.stats.analysisMilliseconds, 'number');
  });

  it('caps reported notes, voices and the minimum note frames', () => {
    assert.ok(POLY_MAX_NOTES >= 16 && POLY_MAX_NOTES <= 512);
    assert.equal(POLY_MAX_VOICES, 4);
    assert.ok(POLY_MIN_NOTE_FRAMES >= 3);
    const pcm = renderTones(2, [
      { midi: 60, startSeconds: 0.1, endSeconds: 1.5 },
      { midi: 64, startSeconds: 0.1, endSeconds: 1.5 },
      { midi: 67, startSeconds: 0.1, endSeconds: 1.5 },
    ]);
    const result = analyse([pcm], 2);
    assert.ok(result.notes.length <= POLY_MAX_NOTES);
    for (const note of result.notes) {
      assert.ok(note.frameCount >= POLY_MIN_NOTE_FRAMES);
      assert.ok(note.midi >= POLY_MIN_MIDI && note.midi <= POLY_MAX_MIDI);
      assert.ok(note.durationSteps > 0);
      assert.ok(Number.isInteger(note.midi));
    }
  });

  it('reports confidence and velocity as measured functions, not constants', () => {
    const clean = analyse([renderTones(2, [{ midi: 60, startSeconds: 0.1, endSeconds: 1.5 }])], 2);
    const chord = analyse([renderTones(2, [60, 64, 67].map(midi => ({
      midi,
      startSeconds: 0.1,
      endSeconds: 1.5,
    })))], 2);
    assert.equal(clean.notes.length, 1);
    assert.equal(chord.notes.length, 3);
    // A note that owns most of the spectrum is more confident than notes that
    // share it — the mapping is the documented function of the measured share.
    assert.ok(clean.notes[0].confidence > chord.notes[0].confidence);
    assert.ok(clean.notes[0].confidence > 0 && clean.notes[0].confidence <= 1);
    // Per frame the confidence *is* the documented function of the measured
    // share; a note reports the mean of its frames, which is why the note-level
    // value is checked for the same monotonic relationship rather than equality.
    const confidenceOf = (share: number) => Math.min(1, Math.max(0, Math.pow(Math.min(1, share) * 2, 0.75)));
    for (const result of [clean, chord]) {
      for (const frame of result.frames) {
        for (const candidate of frame.candidates) {
          assert.ok(
            Math.abs(candidate.confidence - confidenceOf(candidate.share)) < 1e-9,
            'frame confidence must be the documented function of the frame share'
          );
        }
      }
    }
    const byShare = [...chord.notes].sort((a, b) => a.share - b.share);
    for (let i = 1; i < byShare.length; i += 1) {
      assert.ok(byShare[i].confidence >= byShare[i - 1].confidence - 1e-9);
    }
    for (const note of [...clean.notes, ...chord.notes]) {
      assert.ok(note.velocity >= 0.2 && note.velocity <= 1);
    }
    const shares = new Set(chord.notes.map(note => note.share.toFixed(4)));
    assert.ok(shares.size > 1, 'confidence must not be a hard-coded constant');
  });

  it('exposes the per-frame measurements the verdict was built from', () => {
    const result = analyse([renderTones(2, [{ midi: 60, startSeconds: 0.1, endSeconds: 1.5 }])], 2);
    assert.ok(result.frames.length > 0);
    const pitched = result.frames.filter(frame => frame.candidates.length > 0);
    assert.ok(pitched.length > 0);
    assert.equal(result.stats.pitchedFrameCount, pitched.length);
    assert.ok(result.stats.pitchedRatio > 0.5);
    assert.ok(result.stats.explainedShare > 0.8);
    assert.ok(result.stats.peakRms > 0);
    for (const frame of pitched) {
      for (const candidate of frame.candidates) {
        assert.ok(candidate.share > 0);
        assert.ok(candidate.confidence > 0);
        assert.ok(Math.abs(candidate.midiFloat - candidate.midi) <= 0.5);
      }
    }
  });

  it('pins the measured limit for two fundamentals a semitone apart', () => {
    // 261.6 Hz and 277.2 Hz are 1.4 FFT bins apart in a 93 ms window, so the
    // analyzer cannot always resolve them as two separate peaks. This test pins
    // the honest consequence instead of pretending the limitation away: both
    // fundamentals are still reported, and everything the merge adds stays
    // strictly weaker (in measured confidence) than either fundamental.
    const pcm = renderTones(2, [
      { midi: 60, startSeconds: 0.1, endSeconds: 1.6 },
      { midi: 61, startSeconds: 0.1, endSeconds: 1.6 },
    ]);
    const result = analyse([pcm], 2);
    assert.equal(result.status, 'ok');
    const fundamentals = result.notes.filter(note => note.midi === 60 || note.midi === 61);
    assert.deepEqual(fundamentals.map(note => note.midi).sort((a, b) => a - b), [60, 61]);
    const weakestFundamental = Math.min(...fundamentals.map(note => note.confidence));
    const extras = result.notes.filter(note => note.midi !== 60 && note.midi !== 61);
    for (const extra of extras) {
      assert.ok(
        extra.confidence < weakestFundamental,
        `${extra.noteName} (confidence ${extra.confidence.toFixed(3)}) must stay weaker than the fundamentals (${weakestFundamental.toFixed(3)})`,
      );
    }
  });

  it('scores the whole fixture suite against ground truth (precision/recall)', () => {
    const cases: Array<{ label: string; pcm: Float32Array; expected: ExpectedNote[] }> = [
      {
        label: 'single',
        pcm: renderTones(2, [{ midi: 62, startSeconds: 0.1, endSeconds: 1.2 }]),
        expected: [expectNotes(62, 0.1, 1.2)],
      },
      {
        label: 'dyad',
        pcm: renderTones(2, [
          { midi: 59, startSeconds: 0.1, endSeconds: 0.8 },
          { midi: 66, startSeconds: 0.5, endSeconds: 1.5 },
        ]),
        expected: [expectNotes(59, 0.1, 0.8), expectNotes(66, 0.5, 1.5)],
      },
      {
        label: 'triad',
        pcm: renderTones(2, [53, 57, 60].map(midi => ({
          midi,
          startSeconds: 0.15,
          endSeconds: 1.5,
        }))),
        expected: [53, 57, 60].map(midi => expectNotes(midi, 0.15, 1.5)),
      },
      {
        label: 'bass + melody',
        pcm: renderTones(3, [
          { midi: 45, startSeconds: 0.1, endSeconds: 2.7 },
          { midi: 69, startSeconds: 0.2, endSeconds: 0.9 },
          { midi: 72, startSeconds: 1.2, endSeconds: 1.9 },
        ]),
        expected: [
          expectNotes(45, 0.1, 2.7),
          expectNotes(69, 0.2, 0.9),
          expectNotes(72, 1.2, 1.9),
        ],
      },
      {
        label: 'sawtooth',
        pcm: renderTones(2, [{ midi: 55, startSeconds: 0.1, endSeconds: 1.4, harmonics: SAW }]),
        expected: [expectNotes(55, 0.1, 1.4)],
      },
    ];
    const reports = cases.map(item => describeScore(item.label, analyse([item.pcm], 3), item.expected));
    const totalTruePositives = reports.reduce((sum, report) => sum + report.truePositives, 0);
    const totalDetected = reports.reduce(
      (sum, report, index) => sum + report.truePositives + report.falsePositives.length,
      0
    );
    const totalExpected = reports.reduce((sum, report) => sum + report.truePositives + report.falseNegatives.length, 0);
    const precision = totalTruePositives / Math.max(1, totalDetected);
    const recall = totalTruePositives / Math.max(1, totalExpected);
    // Measured on this fixture suite; the numbers are asserted so a regression
    // fails loudly instead of quietly lowering product quality.
    assert.equal(totalTruePositives, totalExpected, `recall regression: ${JSON.stringify(reports)}`);
    assert.equal(precision, 1, `precision regression: ${JSON.stringify(reports)}`);
    assert.equal(recall, 1);
    assert.ok(totalExpected >= 9, 'the scored suite must cover a meaningful number of notes');
  });
});
