/**
 * Phase 1K — recording count-in policy (pure musical arithmetic).
 *
 * Covers: the Off / 1 bar / 2 bars setting, click schedules built from the
 * ACTIVE meter's pulse layout (tempo, time signature, metronome accent
 * grouping), 1-bar/2-bar capture starts and the recording offset each start
 * produces. No timers, no audio — `phase1k.countInScheduler.test.ts` and
 * `phase1k.recordingCountIn.test.ts` drive the real scheduling/capture path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCountInSchedule,
  captureBarNumbers,
  describeCountInBars,
  isCountInBars,
  planCountInCapturePosition,
  resolveCountInBars,
  COUNT_IN_OPTIONS,
  DEFAULT_COUNT_IN_BARS,
} from './countIn';
import { resolveMeterPulseLayout } from './meterPulse';
import { beatsPerBar, stepsPerBar } from './musicalTime';

describe('Phase 1K TEST 1 — count-in setting is Off, 1 bar or 2 bars', () => {
  it('accepts exactly 0, 1 and 2', () => {
    assert.deepEqual([...COUNT_IN_OPTIONS], [0, 1, 2]);
    assert.equal(isCountInBars(0), true);
    assert.equal(isCountInBars(1), true);
    assert.equal(isCountInBars(2), true);
    assert.equal(isCountInBars(3), false);
    assert.equal(isCountInBars(-1), false);
    assert.equal(isCountInBars(1.5), false);
    assert.equal(isCountInBars('1'), false);
    assert.equal(isCountInBars(undefined), false);
    assert.equal(DEFAULT_COUNT_IN_BARS, 0);
  });

  it('resolves stored values; missing or unknown falls back to Off', () => {
    assert.equal(resolveCountInBars({ countInBars: 2 }), 2);
    assert.equal(resolveCountInBars({ countInBars: 0 }), 0);
    assert.equal(resolveCountInBars({}), 0);
    assert.equal(resolveCountInBars(null), 0);
    assert.equal(resolveCountInBars({ countInBars: 7 }), 0);
    assert.equal(resolveCountInBars({ countInBars: '2 bars' }), 0);
  });

  it('describes the options for the UI', () => {
    assert.equal(describeCountInBars(0), 'Off');
    assert.equal(describeCountInBars(1), '1 bar');
    assert.equal(describeCountInBars(2), '2 bars');
  });
});

describe('Phase 1K TEST 2 — the click schedule uses the active meter pulse layout', () => {
  it('4/4 counts quarter pulses with the legacy downbeat/accent pattern', () => {
    const layout = resolveMeterPulseLayout([4, 4]);
    const schedule = buildCountInSchedule({ bars: 1, layout, bpm: 120 });
    // 4 pulses in one 4/4 bar, clicking on quarter beats 0, 1, 2, 3.
    assert.equal(schedule.clicks.length, 4);
    assert.deepEqual(schedule.clicks.map(c => c.beatOffset), [0, 1, 2, 3]);
    assert.deepEqual(schedule.clicks.map(c => c.level), ['downbeat', 'pulse', 'pulse', 'pulse']);
    assert.equal(schedule.durationBeats, 4);
    assert.equal(schedule.durationSeconds, 2); // 4 beats at 120 BPM
  });

  it('3/4 counts three quarter pulses per bar', () => {
    const layout = resolveMeterPulseLayout([3, 4]);
    const schedule = buildCountInSchedule({ bars: 1, layout, bpm: 120 });
    assert.deepEqual(schedule.clicks.map(c => c.beatOffset), [0, 1, 2]);
    assert.equal(schedule.durationBeats, 3);
    assert.equal(schedule.durationSeconds, 1.5);
  });

  it('6/8 counts six eighth pulses with the 3+3 dotted-quarter accent grouping', () => {
    const layout = resolveMeterPulseLayout([6, 8]);
    const schedule = buildCountInSchedule({ bars: 1, layout, bpm: 120 });
    assert.equal(schedule.clicks.length, 6);
    assert.deepEqual(schedule.clicks.map(c => c.stepOffset), [0, 2, 4, 6, 8, 10]);
    // Downbeat at the bar line, accent at the second dotted-quarter group start.
    assert.deepEqual(schedule.clicks.map(c => c.level), ['downbeat', 'pulse', 'pulse', 'accent', 'pulse', 'pulse']);
    assert.equal(schedule.durationBeats, 3); // 6 eighths = 3 quarter beats
    assert.equal(schedule.durationSeconds, 1.5);
  });

  it('7/8 follows the selected accent grouping: 2+2+3 (default), 3+2+2, 2+3+2', () => {
    const a = buildCountInSchedule({ bars: 1, layout: resolveMeterPulseLayout([7, 8], '2+2+3'), bpm: 120 });
    assert.deepEqual(a.clicks.map(c => c.level), ['downbeat', 'pulse', 'accent', 'pulse', 'accent', 'pulse', 'pulse']);
    assert.deepEqual(a.clicks.map(c => c.stepOffset), [0, 2, 4, 6, 8, 10, 12]);
    const b = buildCountInSchedule({ bars: 1, layout: resolveMeterPulseLayout([7, 8], '3+2+2'), bpm: 120 });
    assert.deepEqual(b.clicks.map(c => c.level), ['downbeat', 'pulse', 'pulse', 'accent', 'pulse', 'accent', 'pulse']);
    const c = buildCountInSchedule({ bars: 1, layout: resolveMeterPulseLayout([7, 8], '2+3+2'), bpm: 120 });
    assert.deepEqual(c.clicks.map(c2 => c2.level), ['downbeat', 'pulse', 'accent', 'pulse', 'pulse', 'accent', 'pulse']);
  });

  it('the schedule follows the project tempo', () => {
    const layout = resolveMeterPulseLayout([4, 4]);
    const slow = buildCountInSchedule({ bars: 1, layout, bpm: 60 });
    assert.equal(slow.durationSeconds, 4); // 4 beats at 60 BPM
    assert.deepEqual(slow.clicks.map(c => c.beatOffset * (60 / slow.bpm)), [0, 1, 2, 3]);
    const fast = buildCountInSchedule({ bars: 2, layout, bpm: 240 });
    assert.equal(fast.durationSeconds, 2); // 8 beats at 240 BPM
  });
});

describe('Phase 1K TEST 3 — 1-bar and 2-bar count-ins and their capture offsets', () => {
  const meters: Array<[string, [number, number]]> = [
    ['4/4', [4, 4]],
    ['3/4', [3, 4]],
    ['6/8', [6, 8]],
    ['7/8', [7, 8]],
  ];

  it('a 2-bar count-in clicks every pulse of both bars and each bar line clicks a downbeat', () => {
    for (const [label, meter] of meters) {
      const layout = resolveMeterPulseLayout(meter as [number, number]);
      const schedule = buildCountInSchedule({ bars: 2, layout, bpm: 120 });
      const pulsesPerBar = layout.pulses.length;
      assert.equal(schedule.clicks.length, 2 * pulsesPerBar, `${label}: two full bars of pulses`);
      const downbeats = schedule.clicks.filter(c => c.level === 'downbeat');
      assert.equal(downbeats.length, 2, `${label}: one downbeat per counted bar`);
      assert.deepEqual(downbeats.map(c => c.barIndex), [0, 1], `${label}: downbeats on bar lines`);
      // Every click sits strictly before capture.
      for (const click of schedule.clicks) {
        assert.ok(click.beatOffset < schedule.durationBeats, `${label}: click at ${click.beatOffset} is before capture`);
      }
    }
  });

  it('capture starts exactly N bars after the count-in start (1-bar and 2-bar starts)', () => {
    for (const [label, meter] of meters) {
      const barBeats = beatsPerBar(meter as [number, number]);
      // A request already on a bar line counts from that line.
      const oneBar = planCountInCapturePosition(0, meter as [number, number], 1);
      assert.equal(oneBar.captureBeat, barBeats, `${label}: 1-bar start`);
      assert.equal(oneBar.captureBar, 2, `${label}: capture lands on bar 2`);
      assert.equal(oneBar.clipStartBar, 1, `${label}: clip offset for 1-bar start`);
      const twoBars = planCountInCapturePosition(0, meter as [number, number], 2);
      assert.equal(twoBars.captureBeat, 2 * barBeats, `${label}: 2-bar start`);
      assert.equal(twoBars.captureBar, 3, `${label}: capture lands on bar 3`);
      assert.equal(twoBars.clipStartBar, 2, `${label}: clip offset for 2-bar start`);
    }
  });

  it('count-in snaps up to the next bar line of the active meter', () => {
    // 4/4: a request at bar 5 beat 3 (beat 19) snaps to bar 6 (beat 20).
    const mid = planCountInCapturePosition(19, [4, 4], 1);
    assert.equal(mid.startBeat, 20);
    assert.equal(mid.captureBeat, 24);
    assert.equal(mid.captureBar, 7);
    // 7/8: bar lines are every 3.5 beats. A request at beat 4 (inside bar 2)
    // snaps to beat 7 (bar 3), and a 1-bar count-in captures at beat 10.5.
    const irregular = planCountInCapturePosition(4, [7, 8], 1);
    assert.equal(irregular.startBeat, 7);
    assert.equal(irregular.captureBeat, 10.5);
    assert.equal(irregular.captureBar, 4);
    assert.equal(irregular.clipStartBar, 3);
  });

  it('Off (0 bars) preserves the immediate pre-Phase-1K start at the request position', () => {
    const off = planCountInCapturePosition(0, [4, 4], 0);
    assert.equal(off.startBeat, 0);
    assert.equal(off.captureBeat, 0);
    assert.equal(off.captureBar, 1);
    assert.equal(off.clipStartBar, 0);
    // Even mid-bar, Off captures at the request position itself.
    const mid = planCountInCapturePosition(19, [4, 4], 0);
    assert.equal(mid.captureBeat, 19);
  });

  it('captureBarNumbers maps capture beats to transport bars and playlist offsets', () => {
    assert.deepEqual(captureBarNumbers(0, [4, 4]), { captureBar: 1, clipStartBar: 0 });
    assert.deepEqual(captureBarNumbers(4, [4, 4]), { captureBar: 2, clipStartBar: 1 });
    assert.deepEqual(captureBarNumbers(3, [3, 4]), { captureBar: 2, clipStartBar: 1 });
    assert.deepEqual(captureBarNumbers(3, [6, 8]), { captureBar: 2, clipStartBar: 1 });
    assert.deepEqual(captureBarNumbers(3.5, [7, 8]), { captureBar: 2, clipStartBar: 1 });
    assert.deepEqual(captureBarNumbers(7, [7, 8]), { captureBar: 3, clipStartBar: 2 });
  });

  it('count-in lengths are measured in bars of the ACTIVE meter, not quarters', () => {
    // One 7/8 bar = 3.5 quarter beats; one 6/8 bar = 3 quarter beats.
    assert.equal(buildCountInSchedule({ bars: 1, layout: resolveMeterPulseLayout([7, 8], '2+2+3'), bpm: 120 }).durationBeats, 3.5);
    assert.equal(buildCountInSchedule({ bars: 1, layout: resolveMeterPulseLayout([6, 8]), bpm: 120 }).durationBeats, 3);
    // A 2-bar 3/4 count-in is 6 beats — 3 seconds at 120 BPM.
    const waltz = buildCountInSchedule({ bars: 2, layout: resolveMeterPulseLayout([3, 4]), bpm: 120 });
    assert.equal(waltz.durationSeconds, 3);
    assert.equal(waltz.durationBeats, 6);
  });

  it('click step offsets are integer sixteenth steps of the meter bar grid', () => {
    for (const [label, meter] of meters) {
      const layout = resolveMeterPulseLayout(meter as [number, number]);
      const schedule = buildCountInSchedule({ bars: 2, layout, bpm: 120 });
      const barSteps = stepsPerBar(meter as [number, number]);
      for (const click of schedule.clicks) {
        assert.equal(click.stepOffset % 1, 0, `${label}: integral step offset`);
        assert.ok(click.stepOffset >= 0 && click.stepOffset < 2 * barSteps, `${label}: offset inside the count-in`);
      }
    }
  });
});
