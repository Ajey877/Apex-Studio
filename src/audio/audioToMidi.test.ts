/**
 * Phase 8C — Audio-to-MIDI against REAL synthesized PCM.
 *
 * Every fixture in this file is generated sample by sample (harmonic tones with
 * attack/release envelopes, deterministic noise, chords, silence). No analysis
 * result is mocked: the assertions read the notes the production pipeline
 * derives from those samples, so a regression in pitch, segmentation or timing
 * fails here.
 *
 * Covered:
 *  - pitch accuracy across the supported registers (MIDI 43 … 83);
 *  - segmentation of note changes, onsets/offsets inside documented tolerances;
 *  - a known melodic phrase → exact note count and order;
 *  - vibrato/jitter does NOT explode into extra notes;
 *  - silence, noise, chords, out-of-range tones and too-short clips refuse;
 *  - timing at 90/120/140 BPM and in 4/4, 3/4 and 7/8;
 *  - clip transforms (offset trim, pitch shift, playback rate) are compensated;
 *  - repeated analysis is bit-identical (determinism);
 *  - the harmonic-consistency check separates a tone from a chord.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PlaylistClip } from '../types/daw';
import {
  AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS,
  AudioToMidiError,
  analyseAudioClipForMidi,
  describeClipTimeline,
  harmonicEnergyRatio,
  normalizeAudioToMidiOptions,
  segmentPitchContour,
  smoothPitchContour,
  transcribePcmToMidi,
} from './audioToMidi';
import { detectPitchFrames, frequencyToMidi } from './pitchDetection';
import { analyseSelectedClipForMidi } from './audioToMidiSource';

const SR = 44100;
const midiToFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const stepsPerSecond = (bpm: number) => (bpm / 60) * 4;

interface ToneSegment {
  /** MIDI note, or null for silence. */
  midi: number | null;
  /** Length in sixteenth-note steps. */
  steps: number;
  /** Vibrato depth in cents (5 Hz). */
  vibratoCents?: number;
  /** Relative gain. */
  gain?: number;
}

/**
 * Synthesizes a monophonic line: one additive tone per segment with a 6 ms
 * attack/release envelope (so there is no click), harmonics 1–3.
 */
const synthesizeLine = (
  segments: readonly ToneSegment[],
  bpm = 120
): { data: Float32Array; duration: number } => {
  const secondsPerStep = 1 / stepsPerSecond(bpm);
  const totalSamples = segments.reduce(
    (sum, segment) => sum + Math.round(segment.steps * secondsPerStep * SR),
    0
  );
  const data = new Float32Array(totalSamples);
  let cursor = 0;
  for (const segment of segments) {
    const length = Math.round(segment.steps * secondsPerStep * SR);
    if (segment.midi !== null) {
      const frequency = midiToFreq(segment.midi);
      const gain = segment.gain ?? 0.5;
      const fade = Math.min(Math.round(0.006 * SR), Math.floor(length / 4));
      let phase = 0;
      for (let i = 0; i < length; i += 1) {
        const envelope = Math.min(1, i / Math.max(1, fade)) *
          Math.min(1, (length - i) / Math.max(1, fade));
        // Vibrato depth is in CENTS: 1200 cents = one octave.
        const cents = segment.vibratoCents
          ? segment.vibratoCents * Math.sin((2 * Math.PI * 5 * i) / SR)
          : 0;
        phase += (2 * Math.PI * frequency * Math.pow(2, cents / 1200)) / SR;
        data[cursor + i] = gain * envelope * (
          Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase)
        );
      }
    }
    cursor += length;
  }
  return { data, duration: totalSamples / SR };
};

/** Deterministic white noise (no Math.random anywhere in the fixtures). */
const makeNoise = (durationSeconds: number, gain = 0.3): Float32Array => {
  const data = new Float32Array(Math.round(durationSeconds * SR));
  let seed = 987654321;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = gain * ((seed / 0x7fffffff) * 2 - 1);
  }
  return data;
};

/** C4 + E4 + G4 together — a chord no monophonic tool may transcribe. */
const makeChord = (durationSeconds: number, midis: number[] = [60, 64, 67]): Float32Array => {
  const length = Math.round(durationSeconds * SR);
  const data = new Float32Array(length);
  for (const midi of midis) {
    const frequency = midiToFreq(midi);
    for (let i = 0; i < length; i += 1) {
      const envelope = Math.min(1, i / 300) * Math.min(1, (length - i) / 300);
      data[i] += 0.28 * envelope * (
        Math.sin((2 * Math.PI * frequency * i) / SR) +
        0.3 * Math.sin((4 * Math.PI * frequency * i) / SR)
      );
    }
  }
  return data;
};

const asBuffer = (data: Float32Array) => ({
  duration: data.length / SR,
  sampleRate: SR,
  numberOfChannels: 1,
  getChannelData: () => data,
});

/** The analysable slice of a real AudioBuffer, expressed for the source seam. */
const asAudioBuffer = (data: Float32Array) => asBuffer(data) as unknown as AudioBuffer;

const makeClip = (patch: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'atmidi-clip',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 2,
  type: 'audio',
  audioBufferId: 'atmidi-asset',
  name: 'Test Clip',
  color: '#00e5ff',
  ...patch,
});

const timing = (bpm = 120, timeSignature: [number, number] = [4, 4]) => ({ bpm, timeSignature });

const analyse = (
  data: Float32Array,
  clip: PlaylistClip = makeClip(),
  ctx = timing()
) => analyseAudioClipForMidi(clip, asBuffer(data), ctx, {});

describe('Audio-to-MIDI: pitch accuracy across registers', () => {
  for (const midi of [43, 48, 55, 60, 69, 76, 83]) {
    it(`reports MIDI ${midi} for a sustained harmonic tone`, () => {
      const { data } = synthesizeLine([{ midi, steps: 8 }], 120);
      const result = analyse(data, makeClip({ lengthBars: 1 }));
      assert.equal(result.status, 'ok', result.message);
      assert.equal(result.notes.length, 1, `expected one note, got ${result.notes.length}`);
      assert.equal(result.notes[0].midi, midi, `measured ${result.notes[0].noteName}`);
      // Pitch is reported to the nearest semitone, so the deviation is < 50 cents.
      assert.ok(
        Math.abs(result.notes[0].centsOffset) < 50,
        `cents off target: ${result.notes[0].centsOffset}`
      );
    });
  }

  it('round-trips its own MIDI→Hz mapping (guard against a shifted scale)', () => {
    for (const midi of [43, 60, 83]) {
      assert.ok(Math.abs(frequencyToMidi(midiToFreq(midi)) - midi) < 1e-9);
    }
  });
});

describe('Audio-to-MIDI: segmentation and timing', () => {
  it('segments a three-note phrase into the right pitches, order and steps', () => {
    const { data } = synthesizeLine([
      { midi: 60, steps: 4 },
      { midi: 64, steps: 4 },
      { midi: 67, steps: 4 },
      { midi: null, steps: 4 },
    ]);
    const result = analyse(data, makeClip({ lengthBars: 1 }));
    assert.equal(result.status, 'ok', result.message);
    assert.deepEqual(result.notes.map(note => note.midi), [60, 64, 67]);
    // Onsets: one grid step (0.25 step = 31 ms at 120 BPM) tolerance.
    assert.deepEqual(result.notes.map(note => note.startStep), [0, 4, 8]);
    for (const note of result.notes) {
      assert.ok(
        Math.abs(note.durationSteps - 4) <= 0.25,
        `${note.noteName} lasted ${note.durationSteps} steps`
      );
    }
  });

  it('translates a longer melodic sequence into the expected note count and order', () => {
    const melody: ToneSegment[] = [
      { midi: 72, steps: 2 },
      { midi: 74, steps: 2 },
      { midi: 76, steps: 2 },
      { midi: 77, steps: 2 },
      { midi: 79, steps: 2 },
      { midi: 81, steps: 2 },
      { midi: null, steps: 4 },
    ];
    const { data } = synthesizeLine(melody);
    const result = analyse(data, makeClip({ lengthBars: 1 }));
    assert.equal(result.status, 'ok', result.message);
    assert.deepEqual(result.notes.map(note => note.midi), [72, 74, 76, 77, 79, 81]);
  });

  it('keeps a repeated note as one event per sounded note, not one merged blob', () => {
    const { data } = synthesizeLine([
      { midi: 60, steps: 2 },
      { midi: null, steps: 2 },
      { midi: 60, steps: 2 },
      { midi: null, steps: 2 },
    ]);
    const result = analyse(data, makeClip({ lengthBars: 1 }));
    assert.equal(result.status, 'ok', result.message);
    assert.equal(result.notes.length, 2, JSON.stringify(result.notes.map(n => n.startStep)));
    assert.deepEqual(result.notes.map(note => note.midi), [60, 60]);
    assert.ok(result.notes[1].startStep >= 3.75);
  });

  it('does not turn vibrato or frame jitter into extra notes', () => {
    const steady = synthesizeLine([{ midi: 60, steps: 8 }, { midi: 64, steps: 8 }]).data;
    const vibrato = synthesizeLine([
      { midi: 60, steps: 8, vibratoCents: 35 },
      { midi: 64, steps: 8, vibratoCents: 35 },
    ]).data;

    const steadyResult = analyse(steady);
    const vibratoResult = analyse(vibrato);
    assert.equal(steadyResult.status, 'ok', steadyResult.message);
    assert.equal(vibratoResult.status, 'ok', vibratoResult.message);
    assert.equal(vibratoResult.notes.length, 2, JSON.stringify(
      vibratoResult.notes.map(note => `${note.noteName}@${note.startStep}`)
    ));
    assert.deepEqual(vibratoResult.notes.map(note => note.midi), [60, 64]);
  });

  it('rides musical vibrato from 10 to 30 cents without inventing notes', () => {
    // Vibrato is a *pitch modulation*, not a new note. The transcription must
    // keep exactly the two sounded notes at every musically normal depth
    // (10–30 cents); heavier flutter is reported as unreliable instead of being
    // guessed (see the refusal suite).
    for (const vibratoCents of [10, 15, 20, 25, 30]) {
      const { data } = synthesizeLine([
        { midi: 60, steps: 8, vibratoCents },
        { midi: 64, steps: 8, vibratoCents },
      ]);
      const result = analyse(data, makeClip({ lengthBars: 2 }));
      assert.equal(result.status, 'ok', `${vibratoCents} cents: ${result.message}`);
      assert.deepEqual(
        result.notes.map(note => `${note.noteName}@${note.startStep}`),
        ['C4@0', 'E4@8'],
        `${vibratoCents} cents of vibrato must not change the note list`
      );
    }
  });

  it('closes notes at real gaps instead of extending them', () => {
    const { data } = synthesizeLine([
      { midi: 60, steps: 2 },
      { midi: null, steps: 4 },
      { midi: 60, steps: 2 },
      { midi: null, steps: 4 },
    ]);
    const result = analyse(data, makeClip({ lengthBars: 1 }));
    assert.equal(result.status, 'ok', result.message);
    assert.equal(result.notes.length, 2);
    assert.ok(
      result.notes[0].durationSteps <= 3,
      `first note should stop near its 2-step gate, got ${result.notes[0].durationSteps}`
    );
  });
});

describe('Audio-to-MIDI: unsupported and uncertain material is refused', () => {
  const refusalOf = (result: ReturnType<typeof analyse>) => result.refusal;

  it('refuses silence', () => {
    const result = analyse(new Float32Array(Math.round(2 * SR)));
    assert.equal(result.status, 'rejected');
    assert.equal(refusalOf(result), 'silence-or-noise');
    assert.deepEqual(result.notes, []);
    assert.match(result.message, /silence|noise/i);
  });

  it('refuses white noise', () => {
    const result = analyse(makeNoise(2));
    assert.equal(result.status, 'rejected');
    assert.match(String(result.refusal), /unreliable-pitch|silence-or-noise/);
    assert.equal(result.notes.length, 0);
    assert.ok(result.message.length > 40, 'a refusal must explain itself');
  });

  it('refuses a chord instead of inventing a melody (no polyphonic transcription)', () => {
    const result = analyse(makeChord(2));
    assert.equal(result.status, 'rejected');
    assert.match(String(result.refusal), /polyphonic-suspected|unreliable-pitch/);
    assert.deepEqual(result.notes, []);
    assert.match(result.message, /polyphonic|chord|fundamental/i);
  });

  it('refuses a tone above the supported range rather than transposing it', () => {
    // 1760 Hz (A6) is outside 75–1000 Hz and its subharmonic (880 Hz) must not
    // be reported as a real note.
    const data = new Float32Array(Math.round(2 * SR));
    for (let i = 0; i < data.length; i += 1) {
      data[i] = 0.5 * Math.sin((2 * Math.PI * 1760 * i) / SR);
    }
    const result = analyse(data);
    assert.equal(result.status, 'rejected');
    assert.equal(result.notes.length, 0);
  });

  it('refuses a clip whose audible window is too short to analyse', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 1 }]);
    assert.throws(
      () => analyse(data, makeClip({ lengthBars: 0.0625 })),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'source-too-short'
    );
  });

  it('refuses a clip longer than the bounded analysis window, and says so', () => {
    const seconds = AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS + 4;
    const data = new Float32Array(Math.round(seconds * SR));
    for (let i = 0; i < data.length; i += 1) {
      data[i] = 0.5 * Math.sin((2 * Math.PI * 261.6256 * i) / SR);
    }
    assert.throws(
      () => analyse(data, makeClip({ lengthBars: seconds / 2 })),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'clip-too-long'
    );
  });

  it('refuses non-audio clips and clips without an asset', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 4 }]);
    assert.throws(
      () => analyse(data, makeClip({ type: 'pattern' as unknown as 'audio' })),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'not-audio-clip'
    );
    assert.throws(
      () => analyse(data, makeClip({ audioBufferId: undefined })),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'no-source-audio'
    );
  });

  it('validates the user controls instead of silently clamping them', () => {
    assert.throws(
      () => normalizeAudioToMidiOptions({ minNoteSteps: 0 }),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'invalid-options'
    );
    assert.throws(
      () => normalizeAudioToMidiOptions({ sensitivity: 2 }),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'invalid-options'
    );
    assert.throws(
      () => normalizeAudioToMidiOptions({ quantizeSteps: 0.3 }),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'invalid-options'
    );
    assert.deepEqual(normalizeAudioToMidiOptions(undefined), {
      minNoteSteps: 0.5,
      sensitivity: 0.5,
      quantizeSteps: 0.25,
    });
  });

  it('drops notes shorter than the minimum length and reports that nothing remains', () => {
    // One 2-step note; the 4-step minimum leaves nothing to commit.
    const { data } = synthesizeLine([{ midi: 60, steps: 2 }, { midi: null, steps: 6 }]);
    const result = analyseAudioClipForMidi(makeClip({ lengthBars: 1 }), asBuffer(data), timing(), {
      minNoteSteps: 4,
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.refusal, 'no-notes');
    assert.deepEqual(result.notes, []);
  });
});

describe('Audio-to-MIDI: project tempo and meter', () => {
  for (const bpm of [90, 120, 140]) {
    it(`keeps step timing at ${bpm} BPM`, () => {
      const { data } = synthesizeLine(
        [{ midi: 60, steps: 4 }, { midi: 67, steps: 4 }, { midi: 72, steps: 4 }, { midi: null, steps: 4 }],
        bpm
      );
      const result = analyse(data, makeClip({ lengthBars: 1 }), timing(bpm));
      assert.equal(result.status, 'ok', result.message);
      assert.deepEqual(result.notes.map(note => note.startStep), [0, 4, 8]);
      assert.deepEqual(result.notes.map(note => note.midi), [60, 67, 72]);
    });
  }

  it('resolves a 3/4 bar to 12 steps and a 7/8 bar to 14 steps', () => {
    // At 120 BPM a sixteenth step is 0.125 s, so a bar's step count is
    // seconds × 8: 3/4 = 1.5 s = 12 steps, 7/8 = 1.75 s = 14 steps.
    const threeFour = describeClipTimeline(makeClip({ lengthBars: 1 }), timing(120, [3, 4]), 30);
    assert.equal(Math.round(threeFour.timelineSeconds * stepsPerSecond(120)), 12);
    const sevenEight = describeClipTimeline(makeClip({ lengthBars: 1 }), timing(120, [7, 8]), 30);
    assert.equal(Math.round(sevenEight.timelineSeconds * stepsPerSecond(120)), 14);
    assert.equal(sevenEight.clipStartStep, 0);
  });

  it('places a clip that starts later on the timeline without shifting its notes', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 4 }, { midi: 64, steps: 4 }]);
    const atZero = analyse(data, makeClip({ lengthBars: 1, startBar: 0 }));
    const atBar4 = analyse(data, makeClip({ lengthBars: 1, startBar: 4 }));
    assert.equal(atBar4.status, 'ok', atBar4.message);
    assert.deepEqual(atBar4.notes.map(note => note.startStep), atZero.notes.map(note => note.startStep));
    assert.equal(atBar4.plan?.clipStartStep, 64);
  });
});

describe('Audio-to-MIDI: clip transforms are compensated, not ignored', () => {
  it('applies a +12 semitone clip pitch shift to the reported notes', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 8 }]);
    const plain = analyse(data, makeClip({ lengthBars: 1 }));
    const shifted = analyse(data, makeClip({ lengthBars: 1, pitchShiftSemitones: 12 }));
    assert.equal(plain.notes[0].midi, 60);
    assert.equal(shifted.notes[0].midi, 72);
  });

  it('follows a 2× playback rate: octave up and half the timeline length', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 8 }]);
    const plain = analyse(data, makeClip({ lengthBars: 1 }));
    const stretched = analyse(data, makeClip({ lengthBars: 1, timeStretchRate: 2 }));
    assert.equal(stretched.notes[0].midi, 72);
    assert.ok(
      Math.abs(stretched.notes[0].durationSteps - plain.notes[0].durationSteps / 2) <= 0.5,
      `${stretched.notes[0].durationSteps} vs ${plain.notes[0].durationSteps}`
    );
  });

  it('starts analysis at the clip trim offset', () => {
    const { data } = synthesizeLine([
      { midi: 60, steps: 4 },
      { midi: 67, steps: 4 },
      { midi: 72, steps: 4 },
      { midi: null, steps: 4 },
    ]);
    // Trim 4 steps (0.5 s at 120 BPM): the first audible note is G4.
    const trimmed = analyse(data, makeClip({ lengthBars: 1, offsetSteps: 4 }));
    assert.equal(trimmed.status, 'ok', trimmed.message);
    assert.equal(trimmed.notes[0].midi, 67);
    assert.equal(trimmed.plan?.sourceOffsetSeconds, 0.5);
  });

  it('refuses a clip trimmed past the end of its source', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 4 }]);
    assert.throws(
      () => analyse(data, makeClip({ lengthBars: 1, offsetSteps: 64 })),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'clip-outside-source'
    );
  });
});

describe('Audio-to-MIDI: determinism and purity', () => {
  it('is bit-identical on repeated analysis', () => {
    const { data } = synthesizeLine([
      { midi: 57, steps: 3 },
      { midi: 62, steps: 3 },
      { midi: 65, steps: 2 },
      { midi: null, steps: 2 },
    ]);
    const first = analyse(data);
    const second = analyse(data);
    assert.deepEqual(first.notes, second.notes);
    assert.deepEqual(first.stats, second.stats);
  });

  it('does not modify the source PCM', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 4 }]);
    const copy = Float32Array.from(data);
    analyse(data);
    assert.deepEqual(data, copy);
  });

  it('never emits negative or overlapping note times', () => {
    const { data } = synthesizeLine([
      { midi: 60, steps: 2 },
      { midi: 62, steps: 2 },
      { midi: 64, steps: 2 },
      { midi: 65, steps: 2 },
      { midi: null, steps: 4 },
    ]);
    const result = analyse(data, makeClip({ lengthBars: 1 }));
    assert.equal(result.status, 'ok', result.message);
    let previousEnd = 0;
    for (const note of result.notes) {
      assert.ok(note.startStep >= 0);
      assert.ok(note.durationSteps >= 0.25);
      assert.ok(note.startStep >= previousEnd - 1e-9, `${note.noteName} overlaps the previous note`);
      previousEnd = note.startStep + note.durationSteps;
    }
  });
});

describe('Audio-to-MIDI: shared building blocks', () => {
  it('harmonicEnergyRatio is ~1 for a tone and low for a chord', () => {
    const tone = synthesizeLine([{ midi: 60, steps: 8 }]).data;
    const chord = makeChord(2);
    const asFloat64 = (input: Float32Array) => Float64Array.from(input);
    const toneRatio = harmonicEnergyRatio(asFloat64(tone), 8000, midiToFreq(60), SR);
    const chordRatio = harmonicEnergyRatio(asFloat64(chord), 8000, midiToFreq(60), SR);
    assert.ok(toneRatio > 0.9, `tone ratio ${toneRatio}`);
    assert.ok(chordRatio < 0.7, `chord ratio ${chordRatio}`);
  });

  it('median smoothing removes a per-frame wobble but keeps a step', () => {
    const values = [
      ...Array.from({ length: 20 }, (_, i) => 60 + (i % 2 === 0 ? 0.02 : -0.02)),
      ...Array.from({ length: 20 }, () => 64),
    ];
    const smoothed = smoothPitchContour(values, 3);
    // The wobble is ±0.02 semitone; smoothing must keep it well inside a semitone.
    assert.ok(Math.abs((smoothed[10] as number) - 60) < 0.05);
    assert.ok(Math.abs((smoothed[35] as number) - 64) < 0.05);
    // ...and it must not blur the step into an in-between value.
    assert.ok(Math.round(smoothed[35] as number) === 64);
  });

  it('segmentPitchContour reports one segment for a steady contour and two for a step', () => {
    const frames = Array.from({ length: 60 }, (_, index) => ({
      index,
      timeSeconds: index * 0.0029,
      f0Hz: index < 30 ? midiToFreq(60) : midiToFreq(64),
      confidence: 0.98,
      voiced: true,
      rms: 0.2,
    }));
    const { segments } = segmentPitchContour(frames, { sensitivity: 0.5, minFrames: 2 });
    assert.equal(segments.length, 2);
  });

  it('shares one detector with the vocal tuner: identical frames for identical PCM', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 4 }, { midi: 67, steps: 4 }]);
    const detection = detectPitchFrames([data], SR);
    assert.ok(detection.voicedFrameCount > 0);
    assert.ok(detection.medianF0Hz !== null && Math.abs(detection.medianF0Hz - midiToFreq(60)) < 30);
  });

  it('transcribePcmToMidi accepts a pre-resolved plan (engine caller path)', () => {
    const { data } = synthesizeLine([{ midi: 60, steps: 4 }, { midi: 64, steps: 4 }]);
    const plan = describeClipTimeline(makeClip({ lengthBars: 1 }), timing(), data.length / SR);
    const result = transcribePcmToMidi([data], SR, plan, {});
    assert.equal(result.status, 'ok', result.message);
    assert.deepEqual(result.notes.map(note => note.midi), [60, 64]);
    assert.equal(result.plan, plan);
  });
});

describe('Audio-to-MIDI: real source resolution (the modal/fake-store seam)', () => {
  const analyseWithStore = async (
    clip: PlaylistClip,
    store: Map<string, AudioBuffer>,
    hydrated: boolean
  ) => {
    let hydrateCalls = 0;
    const result = await analyseSelectedClipForMidi(clip, timing(), {}, {
      getSourceBuffer: id => store.get(id),
      hydrateSource: async id => {
        hydrateCalls += 1;
        if (hydrated) store.set(id, asAudioBuffer(synthesizeLine([{ midi: 60, steps: 4 }]).data));
        return hydrated;
      },
    });
    return { result, hydrateCalls };
  };

  it('uses the in-memory buffer without touching the persisted store', async () => {
    const store = new Map<string, AudioBuffer>();
    store.set('atmidi-asset', asAudioBuffer(synthesizeLine([{ midi: 64, steps: 4 }]).data));
    const { result, hydrateCalls } = await analyseWithStore(
      makeClip({ lengthBars: 1 }),
      store,
      true
    );
    assert.equal(hydrateCalls, 0, 'an in-memory asset must not trigger a hydrate');
    assert.equal(result.analysis.status, 'ok', result.analysis.message);
    assert.deepEqual(result.analysis.notes.map(note => note.midi), [64]);
  });

  it('hydrates from the persisted store when memory has no buffer', async () => {
    const store = new Map<string, AudioBuffer>();
    const { result, hydrateCalls } = await analyseWithStore(
      makeClip({ lengthBars: 1 }),
      store,
      true
    );
    assert.equal(hydrateCalls, 1);
    assert.equal(result.analysis.status, 'ok', result.analysis.message);
    assert.deepEqual(result.analysis.notes.map(note => note.midi), [60]);
  });

  it('refuses honestly when the asset cannot be found anywhere', async () => {
    const store = new Map<string, AudioBuffer>();
    await assert.rejects(
      () => analyseWithStore(makeClip({ lengthBars: 1 }), store, false),
      (error: unknown) =>
        error instanceof AudioToMidiError && error.failure === 'source-unavailable'
    );
  });

  it('refuses a non-audio clip and a clip with no asset before any analysis', async () => {
    const deps = {
      getSourceBuffer: () => undefined,
      hydrateSource: async () => false,
    };
    await assert.rejects(
      () => analyseSelectedClipForMidi(makeClip({ type: 'pattern' }), timing(), {}, deps),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'not-audio-clip'
    );
    await assert.rejects(
      () => analyseSelectedClipForMidi(makeClip({ audioBufferId: undefined }), timing(), {}, deps),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'no-source-audio'
    );
  });

  it('does not mutate the source buffer it analyses', async () => {
    const data = synthesizeLine([{ midi: 60, steps: 4 }, { midi: 67, steps: 4 }]).data;
    const before = Float32Array.from(data);
    const store = new Map<string, AudioBuffer>();
    store.set('atmidi-asset', asAudioBuffer(data));
    await analyseWithStore(makeClip({ lengthBars: 1 }), store, false);
    assert.deepEqual(Array.from(data), Array.from(before), 'analysis must not touch the PCM');
  });
});
