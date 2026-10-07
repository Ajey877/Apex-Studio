import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  beatsPerBar, stepsPerBar, stepsToBeats, beatsToSteps,
  beatsToSeconds, secondsToBeats, beatsToBars, barsToBeats,
  beatsToMidiTicks, midiTicksToBeats, millisecondsToSeconds, bpmToMicrosecondsPerQuarter,
  LEGACY_TIME_SIGNATURE, DEFAULT_MIDI_PPQ, SIXTEENTH_STEPS_PER_BEAT,
} from './musicalTime';

const close = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
};

describe('canonical musical time — quarter-note beats', () => {
  it('defines one sixteenth as a quarter beat without changing the legacy grid', () => {
    assert.equal(SIXTEENTH_STEPS_PER_BEAT, 4);
    assert.equal(stepsToBeats(1), 0.25);
    assert.equal(stepsToBeats(4), 1);
    assert.equal(stepsToBeats(16), 4);
    assert.equal(stepsPerBar(LEGACY_TIME_SIGNATURE), 16);
  });

  it('round-trips signed, zero and fractional steps without quantization', () => {
    for (const steps of [-16, -0.04, 0, 0.04, 0.25, 1 / 3, 4.25, 16, 64.125]) {
      close(beatsToSteps(stepsToBeats(steps)), steps);
      close(stepsToBeats(beatsToSteps(steps)), steps);
    }
  });

  for (const bpm of [60, 120, 240]) {
    it(`converts and round-trips beats/seconds at ${bpm} BPM`, () => {
      assert.equal(beatsToSeconds(1, bpm), 60 / bpm);
      assert.equal(secondsToBeats(60 / bpm, bpm), 1);
      assert.equal(beatsToSeconds(stepsToBeats(1), bpm), 60 / bpm / 4);
      for (const beats of [-4, -0.25, 0, 0.01, 1 / 3, 1, 7.5]) {
        close(secondsToBeats(beatsToSeconds(beats, bpm), bpm), beats);
        close(beatsToSeconds(secondsToBeats(beats, bpm), bpm), beats);
      }
    });
  }

  for (const [meter, expectedBeats, expectedSteps] of [
    [[4, 4], 4, 16], [[3, 4], 3, 12], [[6, 8], 3, 12],
    [[5, 4], 5, 20], [[7, 8], 3.5, 14], [[1, 16], 0.25, 1],
  ] as const) {
    it(`converts bars in ${meter.join('/')} with quarter-note BPM semantics`, () => {
      assert.equal(beatsPerBar(meter), expectedBeats);
      assert.equal(stepsPerBar(meter), expectedSteps);
      for (const bars of [-2, -0.25, 0, 0.125, 1, 3.5]) {
        assert.equal(barsToBeats(bars, meter), bars * expectedBeats);
        close(beatsToBars(barsToBeats(bars, meter), meter), bars);
      }
    });
  }

  it('rejects malformed meters instead of silently assuming 4/4', () => {
    for (const meter of [[0, 4], [-1, 4], [1.5, 4], [4, 0], [4, -4], [4, 3], [4, 0.5], [NaN, 4], [4, Infinity], [4, 2 ** 52 + 1]]) {
      const signature = meter as [number, number];
      assert.throws(() => beatsPerBar(signature), RangeError);
      assert.throws(() => stepsPerBar(signature), RangeError);
      assert.throws(() => barsToBeats(1, signature), RangeError);
      assert.throws(() => beatsToBars(1, signature), RangeError);
    }
  });

  it('converts MIDI ticks without imposing export rounding on musical time', () => {
    assert.equal(DEFAULT_MIDI_PPQ, 480);
    assert.equal(beatsToMidiTicks(1, 480), 480);
    assert.equal(beatsToMidiTicks(stepsToBeats(1), 480), 120);
    assert.equal(midiTicksToBeats(480, 480), 1);
    assert.equal(beatsToMidiTicks(0.01, 480), 4.8);
    for (const ppq of [96, 480, 960]) {
      for (const beats of [-2, -0.01, 0, 0.01, 1 / 3, 7.25]) {
        close(midiTicksToBeats(beatsToMidiTicks(beats, ppq), ppq), beats);
      }
    }
  });

  it('preserves MIDI tempo arithmetic and leaves rounding to the writer', () => {
    for (const bpm of [20, 60, 97.5, 120, 137, 240, 300, 999]) {
      assert.equal(bpmToMicrosecondsPerQuarter(bpm), 60_000_000 / bpm);
    }
    assert.ok(Number.isNaN(bpmToMicrosecondsPerQuarter(NaN)));
    assert.equal(bpmToMicrosecondsPerQuarter(0), Infinity);
    assert.equal(bpmToMicrosecondsPerQuarter(Infinity), 0);
  });

  it('converts milliseconds including signed offsets and zero', () => {
    assert.equal(millisecondsToSeconds(1000), 1);
    assert.equal(millisecondsToSeconds(40), 0.04);
    assert.equal(millisecondsToSeconds(0.5), 0.0005);
    assert.equal(millisecondsToSeconds(0), 0);
    assert.equal(millisecondsToSeconds(-50), -0.05);
  });

  it('keeps validation at existing boundaries: NaN/Infinity are not clamped or repaired', () => {
    // These arithmetic adapters deliberately retain IEEE-754 behavior. Adding
    // input validation here would change malformed legacy-project behavior and
    // the MIDI parser's existing zero-division behavior in a conversion refactor.
    const conversions = [stepsToBeats, beatsToSteps, millisecondsToSeconds,
      (v: number) => beatsToSeconds(v, 120), (v: number) => secondsToBeats(v, 120),
      (v: number) => barsToBeats(v, [4, 4]), (v: number) => beatsToBars(v, [4, 4]),
      (v: number) => beatsToMidiTicks(v, 480), (v: number) => midiTicksToBeats(v, 480)];
    for (const convert of conversions) {
      assert.ok(Number.isNaN(convert(NaN)));
      assert.equal(convert(Infinity), Infinity);
      assert.equal(convert(-Infinity), -Infinity);
      assert.equal(convert(0), 0);
    }
    assert.ok(Number.isNaN(beatsToSeconds(1, NaN)));
    assert.equal(beatsToSeconds(1, 0), Infinity);
    assert.equal(beatsToSeconds(1, Infinity), 0);
    assert.equal(beatsToSeconds(1, -120), -0.5);
    assert.equal(secondsToBeats(1, 0), 0);
    assert.ok(Number.isNaN(secondsToBeats(1, NaN)));
    assert.equal(secondsToBeats(1, Infinity), Infinity);
    assert.equal(midiTicksToBeats(1, 0), Infinity);
    assert.ok(Number.isNaN(midiTicksToBeats(1, NaN)));
    assert.ok(Number.isNaN(beatsToMidiTicks(1, NaN)));
  });

  it('does not change the callers’ supported BPM ranges or apply a second clamp', () => {
    for (const bpm of [20, 60, 120, 240, 300, 999]) {
      assert.equal(beatsToSeconds(1, bpm), 60 / bpm);
    }
  });
});
