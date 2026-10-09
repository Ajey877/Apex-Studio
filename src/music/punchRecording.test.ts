/**
 * Phase 1L — punch-in / punch-out recording policy (pure musical arithmetic).
 *
 * Everything the runtime needs to record the right window: bar.beat
 * conversions in the transport's own notation, endpoint validation, the
 * pre-roll plan, the project-end rule and the ruler overlay geometry. No
 * timers and no audio here — the runtime behaviour is verified through the
 * production path in `src/audio/phase1l.punchRecording.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PUNCH_RECORDING,
  barBeatToBeats,
  beatsToBarBeat,
  describePunchWindow,
  displayedBeatsPerBar,
  formatPunchPosition,
  isPunchRecordingSettings,
  isSamePunchRecording,
  planPunchCapture,
  punchPositionFromTransport,
  punchRangeBeats,
  punchRulerSegments,
  resolvePunchRecording,
  validatePunchRecording,
} from './punchRecording';

const M44 = [4, 4] as const;
const M34 = [3, 4] as const;
const M68 = [6, 8] as const;
const M78 = [7, 8] as const;

const window44 = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  inBar: 5,
  inBeat: 1,
  outBar: 9,
  outBeat: 1,
  ...overrides,
});

describe('Phase 1L TEST 1 — punch positions use the transport bar.beat convention', () => {
  it('bar 1 beat 1 is beat 0 and every later bar follows the resolved meter', () => {
    assert.equal(barBeatToBeats({ bar: 1, beat: 1 }, { meter: M44 }), 0);
    assert.equal(barBeatToBeats({ bar: 5, beat: 1 }, { meter: M44 }), 16);
    assert.equal(barBeatToBeats({ bar: 5, beat: 3 }, { meter: M44 }), 18);
    assert.equal(barBeatToBeats({ bar: 3, beat: 1 }, { meter: M34 }), 6);
  });

  it('6/8 and 7/8 count eighth pulses, so a beat is half a quarter note', () => {
    assert.equal(displayedBeatsPerBar({ meter: M44 }), 4);
    assert.equal(displayedBeatsPerBar({ meter: M68 }), 6);
    assert.equal(displayedBeatsPerBar({ meter: M78 }), 7);
    // Bar 2 beat 7 of 7/8 is one eighth before bar 3.
    assert.equal(barBeatToBeats({ bar: 2, beat: 7 }, { meter: M78 }), 6.5);
    assert.equal(barBeatToBeats({ bar: 3, beat: 1 }, { meter: M78 }), 7);
  });

  it('round-trips beats back to the same bar.beat on the meter pulse grid', () => {
    // The grid a punch position can sit on is the meter's pulse: quarter notes
    // in 4/4 and 3/4, eighths in 6/8 and 7/8. Off-grid positions snap to it.
    const grid: Record<string, number> = { '4,4': 1, '3,4': 1, '6,8': 0.5, '7,8': 0.5 };
    for (const meter of [M44, M34, M68, M78]) {
      const step = grid[`${meter[0]},${meter[1]}`];
      for (let beats = 0; beats < 20; beats += step) {
        const position = beatsToBarBeat(beats, { meter });
        assert.equal(barBeatToBeats(position, { meter }), beats, `${meter} beat ${beats}`);
      }
    }
  });

  it('an off-grid position snaps to the nearest meter pulse instead of inventing one', () => {
    // 4/4 counts quarter pulses, so a sixteenth into the bar snaps back to the
    // pulse and a dotted position rounds up to the next one.
    assert.deepEqual(beatsToBarBeat(0.25, { meter: M44 }), { bar: 1, beat: 1 });
    assert.deepEqual(beatsToBarBeat(1.5, { meter: M44 }), { bar: 1, beat: 3 });
    // 7/8 counts eighths, so the same half beat IS a real position.
    assert.deepEqual(beatsToBarBeat(0.5, { meter: M78 }), { bar: 1, beat: 2 });
    assert.deepEqual(beatsToBarBeat(0.2, { meter: M78 }), { bar: 1, beat: 1 });
  });

  it('a beat past the end of the bar rolls into the next bar instead of clamping', () => {
    assert.equal(barBeatToBeats({ bar: 5, beat: 5 }, { meter: M44 }), barBeatToBeats({ bar: 6, beat: 1 }, { meter: M44 }));
  });

  it('formats and reads positions like the transport readout', () => {
    assert.equal(formatPunchPosition({ bar: 5, beat: 3 }), '05.3');
    assert.equal(formatPunchPosition({ bar: 12, beat: 1 }), '12.1');
  });

  it('"at playhead" follows the meter pulse grid of the transport step', () => {
    // 4/4: step 8 of bar 3 is beat 3.
    assert.deepEqual(punchPositionFromTransport(3, 8, { meter: M44 }), { bar: 3, beat: 3 });
    // 7/8: steps are eighths, so step 9 of bar 3 is beat 5.
    assert.deepEqual(punchPositionFromTransport(3, 9, { meter: M78 }), { bar: 3, beat: 5 });
    // A step beyond the bar wraps inside it.
    assert.deepEqual(punchPositionFromTransport(3, 16, { meter: M44 }), { bar: 3, beat: 1 });
  });
});

describe('Phase 1L TEST 2 — the window validates against the meter and the arrangement', () => {
  it('accepts a window inside the arrangement', () => {
    const result = validatePunchRecording(window44(), { meter: M44, totalBars: 32 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.range, { inBeats: 16, outBeats: 32 });
  });

  it('rejects punch-out at or before punch-in', () => {
    const same = validatePunchRecording(window44({ outBar: 5, outBeat: 1 }), { meter: M44, totalBars: 32 });
    assert.equal(same.valid, false);
    assert.match(same.issues[0].message, /Punch-out must come after punch-in/);
    const before = validatePunchRecording(window44({ outBar: 4, outBeat: 1 }), { meter: M44, totalBars: 32 });
    assert.equal(before.valid, false);
    assert.equal(before.issues[0].field, 'range');
  });

  it('rejects a beat past the end of the active meter bar', () => {
    const result = validatePunchRecording(window44({ inBeat: 5 }), { meter: M44, totalBars: 32 });
    assert.equal(result.valid, false);
    assert.match(result.issues[0].message, /past the end of a 4\/4 bar \(4 beats\)/);
    // The same window is legal in 7/8, which counts seven eighth pulses.
    assert.equal(validatePunchRecording(window44({ inBeat: 7 }), { meter: M78, totalBars: 32 }).valid, true);
  });

  it('rejects a punch-in past the arrangement end but only warns about punch-out', () => {
    const lateIn = validatePunchRecording(window44({ inBar: 40 }), { meter: M44, totalBars: 32 });
    assert.equal(lateIn.valid, false);
    assert.match(lateIn.issues[0].message, /past the end of the arrangement/);
    const lateOut = validatePunchRecording(window44({ outBar: 40 }), { meter: M44, totalBars: 32 });
    assert.equal(lateOut.valid, true, 'a punch-out past the end is truncated, not rejected');
    assert.equal(lateOut.warnings.length, 1);
    assert.match(lateOut.warnings[0].message, /will stop at bar 32/);
  });

  it('rejects malformed stored positions without throwing', () => {
    for (const bad of [{ inBar: 0, inBeat: 1 }, { inBar: 1.5, inBeat: 1 }, { inBar: 1, inBeat: 0 }, { inBar: '5', inBeat: 1 }]) {
      const result = validatePunchRecording({ enabled: true, outBar: 9, outBeat: 1, ...bad } as never, { meter: M44, totalBars: 32 });
      assert.equal(result.valid, false, JSON.stringify(bad));
      assert.equal(result.range, null);
    }
  });
});

describe('Phase 1L TEST 3 — the plan puts the pre-roll before punch-in and capture on the window', () => {
  it('a 1-bar pre-roll starts one bar before punch-in and capture lasts the window', () => {
    const plan = planPunchCapture({ settings: window44(), meter: M44, totalBars: 32, countInBars: 1, bpm: 120 });
    assert.equal(plan.countInStartBeat, 12, 'the count-in begins one 4/4 bar before beat 16');
    assert.equal(plan.inBeats, 16);
    assert.equal(plan.countInBeats, 4);
    assert.equal(plan.captureDurationBeats, 16);
    assert.equal(plan.captureDurationSeconds, 8, '16 quarter beats at 120 BPM');
    assert.equal(plan.preRollSeconds, 2);
    assert.equal(plan.preRollBeforeTimeline, false);
  });

  it('clip geometry is the punched window exactly, including fractional bars', () => {
    const plan = planPunchCapture({
      settings: window44({ inBar: 5, inBeat: 3, outBar: 7, outBeat: 2 }),
      meter: M44,
      totalBars: 32,
      countInBars: 0,
      bpm: 120,
    });
    assert.equal(plan.clipStartBar, 4.5, 'bar 5 beat 3 is half a bar into playlist bar 4');
    assert.equal(plan.clipLengthBars, 1.75);
    assert.equal(plan.captureDurationSeconds, 3.5);
  });

  it('the pre-roll follows the meter: 2 bars of 7/8 is 7 beats, not 8', () => {
    const plan = planPunchCapture({
      settings: { enabled: true, inBar: 5, inBeat: 1, outBar: 7, outBeat: 1 },
      meter: M78,
      totalBars: 32,
      countInBars: 2,
      bpm: 140,
    });
    assert.equal(plan.countInBeats, 7);
    assert.equal(plan.countInStartBeat, 14 - 7);
    assert.equal(plan.inBeats, 14);
    assert.equal(Math.round(plan.preRollSeconds * 1e6) / 1e6, 3);
  });

  it('a punch-in closer to bar 1 than the pre-roll keeps capture on punch-in', () => {
    const plan = planPunchCapture({
      settings: { enabled: true, inBar: 2, inBeat: 1, outBar: 4, outBeat: 1 },
      meter: M44,
      totalBars: 32,
      countInBars: 2,
      bpm: 120,
    });
    assert.equal(plan.countInStartBeat, -4, 'the pre-roll starts before the arrangement');
    assert.equal(plan.preRollBeforeTimeline, true);
    assert.equal(plan.inBeats, 4, 'capture still begins exactly at punch-in');
    assert.equal(plan.clipStartBar, 1);
  });

  it('throws for an invalid window instead of planning the wrong music', () => {
    assert.throws(
      () => planPunchCapture({ settings: window44({ outBar: 4 }), meter: M44, totalBars: 32, countInBars: 1, bpm: 120 }),
      /Punch-out must come after punch-in/,
    );
    assert.throws(
      () => planPunchCapture({ settings: window44({ inBar: 33 }), meter: M44, totalBars: 32, countInBars: 0, bpm: 120 }),
      /past the end of the arrangement/,
    );
  });
});

describe('Phase 1L TEST 4 — the project end shortens the take instead of extending the timeline', () => {
  it('a punch-out past the end is truncated at the arrangement end', () => {
    const plan = planPunchCapture({
      settings: { enabled: true, inBar: 7, inBeat: 1, outBar: 12, outBeat: 1 },
      meter: M44,
      totalBars: 8,
      countInBars: 0,
      bpm: 120,
    });
    assert.equal(plan.truncatedAtProjectEnd, true);
    assert.equal(plan.effectiveOutBeats, 32, 'the take stops on the last bar line of an 8-bar arrangement');
    assert.equal(plan.captureDurationBeats, 8, 'not the 20 beats the user asked for');
    assert.equal(plan.clipStartBar + plan.clipLengthBars, 8, 'the clip fits exactly inside the timeline');
    assert.equal(plan.effectiveOutBar, 9);
  });

  it('a window that fits is not truncated', () => {
    const plan = planPunchCapture({ settings: window44(), meter: M44, totalBars: 32, countInBars: 0, bpm: 120 });
    assert.equal(plan.truncatedAtProjectEnd, false);
    assert.equal(plan.effectiveOutBeats, plan.outBeats);
  });

  it('the summary names the bars, the length and the seconds', () => {
    const plan = planPunchCapture({ settings: window44(), meter: M44, totalBars: 32, countInBars: 1, bpm: 120 });
    assert.equal(describePunchWindow(plan), 'Bars 5 – 9 · 4 bars · 8.00 s');
  });
});

describe('Phase 1L TEST 5 — the selected range is visible on the timeline', () => {
  it('covers every bar the window touches, with fractional edges', () => {
    const segments = punchRulerSegments({ inBeats: 17, outBeats: 26 }, { meter: M44, totalBars: 32 });
    assert.deepEqual(segments.map(segment => segment.barIndex), [4, 5, 6]);
    assert.equal(segments[0].startFraction, 0.25, 'the window starts a beat into bar 5');
    assert.equal(segments[0].containsIn, true);
    assert.equal(segments[1].startFraction, 0);
    assert.equal(segments[1].endFraction, 1);
    assert.equal(segments[2].endFraction, 0.5, 'the window ends two beats into bar 7');
    assert.equal(segments[2].containsOut, true);
  });

  it('never draws past the end of the arrangement and never draws an empty window', () => {
    assert.deepEqual(punchRulerSegments({ inBeats: 16, outBeats: 200 }, { meter: M44, totalBars: 8 }).map(s => s.barIndex), [4, 5, 6, 7]);
    assert.deepEqual(punchRulerSegments({ inBeats: 16, outBeats: 16 }, { meter: M44, totalBars: 32 }), []);
  });
});

describe('Phase 1L TEST 6 — the stored setting resolves safely', () => {
  it('a missing or malformed setting resolves to punch off without throwing', () => {
    assert.equal(resolvePunchRecording({}).enabled, false);
    assert.equal(resolvePunchRecording(null).enabled, false);
    assert.equal(resolvePunchRecording({ punchRecording: { enabled: true } }).enabled, false);
    assert.equal(resolvePunchRecording({ punchRecording: 'bar 5' }).enabled, false);
    assert.deepEqual(resolvePunchRecording({}), DEFAULT_PUNCH_RECORDING);
  });

  it('recognises a well-formed stored window', () => {
    assert.equal(isPunchRecordingSettings(window44()), true);
    assert.equal(isPunchRecordingSettings({ enabled: true, inBar: 5, inBeat: 1, outBar: 9 }), false);
    assert.equal(isPunchRecordingSettings(null), false);
  });

  it('compares windows field by field', () => {
    assert.equal(isSamePunchRecording(window44(), window44()), true);
    assert.equal(isSamePunchRecording(window44(), window44({ enabled: false })), false);
    assert.equal(isSamePunchRecording(window44(), window44({ outBeat: 2 })), false);
  });

  it('converts the stored endpoints into the runtime range', () => {
    assert.deepEqual(punchRangeBeats(window44(), { meter: M44 }), { inBeats: 16, outBeats: 32 });
  });
});
