/**
 * Phase 1L — punch-in / punch-out recording UI: the recorder's punch section,
 * the window it publishes and the geometry a take is placed at.
 *
 * The tsx suite has no DOM, so the section is pinned through
 * renderToStaticMarkup of the real AudioRecorderModal, and every value the
 * section derives (which bar/beat the transport is on, what the punched window
 * means, where the take lands) is asserted against the pure helpers the
 * handlers actually call. Arming a real take is covered by the audio-engine
 * suite, which drives the production recorder.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AudioRecorderModal } from './AudioRecorderModal';
import {
  DEFAULT_PUNCH_RECORDING,
  beatsToBarBeat,
  describePunchWindow,
  formatPunchPosition,
  planPunchCapture,
  punchPositionFromTransport,
  punchRangeBeats,
  punchRulerSegments,
  resolvePunchRecording,
  validatePunchRecording,
  type PunchCapturePlanParams,
  type PunchRecordingSettings,
} from '../music/punchRecording';
import { planPunchClipPlacement } from '../audio/recordingPipeline';
import { beatsPerBar } from '../music/musicalTime';

const PUNCH: PunchRecordingSettings = { enabled: true, inBar: 5, inBeat: 1, outBar: 9, outBeat: 1 };

const render = (overrides: Partial<React.ComponentProps<typeof AudioRecorderModal>> = {}) =>
  renderToStaticMarkup(
    <AudioRecorderModal
      isOpen
      projectGeneration={1}
      getCurrentProjectGeneration={() => 1}
      countInBars={1}
      onUpdateCountInBars={() => undefined}
      onClose={() => undefined}
      onRegisterProjectReplacementHandler={() => undefined}
      onSaveRecording={() => undefined}
      timeSignature={[4, 4]}
      totalBars={32}
      bpm={120}
      currentBar={1}
      currentStep={0}
      {...overrides}
    />,
  );

const withPunch = (overrides: Partial<React.ComponentProps<typeof AudioRecorderModal>> = {}) =>
  render({ punchRecording: PUNCH, onUpdatePunchRecording: () => undefined, ...overrides });

/** The rendered text inside the first element carrying `marker`. */
const textOf = (html: string, marker: string): string | undefined => {
  const match = new RegExp(`<(\\w+)[^>]*${marker}[^>]*>`).exec(html);
  if (!match) return undefined;
  const open = match.index + match[0].length;
  const close = html.indexOf(`</${match[1]}>`, open);
  return html.slice(open, close).trim();
};

const inputValue = (html: string, label: string): string | undefined => {
  const match = [...html.matchAll(/<input[^>]*>/g)]
    .map(m => m[0])
    .find(tag => tag.includes(`aria-label="${label}"`));
  return match && /value="([^"]*)"/.exec(match)?.[1];
};

/** The plan the modal computes for a window, with the modal's own defaults. */
const planFor = (
  settings: PunchRecordingSettings,
  overrides: Partial<PunchCapturePlanParams> = {}
) => planPunchCapture({ settings, meter: [4, 4], bpm: 120, totalBars: 32, ...overrides });

describe('Phase 1L TEST 1 — the punch section only appears where punch is wired', () => {
  it('renders no punch controls when the app does not supply the handler', () => {
    const html = render();
    assert.equal(html.includes('data-testid="audio-recorder-punch"'), false);
    assert.equal(html.includes('Punch recording'), false);
    assert.equal(html.includes('START RECORDING'), true, 'the ordinary Record label stays when punch is unavailable');
  });

  it('renders the section and the punch Record label when punch is available', () => {
    const html = withPunch();
    assert.equal(html.includes('data-testid="audio-recorder-punch"'), true);
    assert.equal(html.includes('Punch recording'), true);
    assert.equal(html.includes('PUNCH RECORD'), true);
    assert.equal(html.includes('Punch-in bar'), true);
    assert.equal(html.includes('Punch-out beat'), true);
    assert.equal(html.includes('PLAYHEAD'), true, 'both endpoints can be set from the playhead');
  });

  it('shows the stored window on the first paint, not the disabled default', () => {
    const html = withPunch();
    assert.equal(inputValue(html, 'Punch-in bar'), '5');
    assert.equal(inputValue(html, 'Punch-in beat'), '1');
    assert.equal(inputValue(html, 'Punch-out bar'), '9');
    assert.equal(inputValue(html, 'Punch-out beat'), '1');
    assert.equal(textOf(html, 'data-punch-position="in"'), '05.1');
    assert.equal(textOf(html, 'data-punch-position="out"'), '09.1');
    assert.equal(html.includes('aria-checked="true"'), true, 'the punch switch reads ON');
  });

  it('renders the disabled explainer when the project has punch off', () => {
    const html = render({ punchRecording: undefined, onUpdatePunchRecording: () => undefined });
    assert.equal(html.includes('data-testid="audio-recorder-punch"'), true);
    assert.equal(html.includes('Off — recording runs until you press Stop, exactly as before.'), true);
    assert.equal(html.includes('START RECORDING'), true);
    assert.deepEqual(resolvePunchRecording({}), DEFAULT_PUNCH_RECORDING);
  });

  it('the punch switch mirrors the stored mode and drives the Record label', () => {
    assert.equal(withPunch().includes('aria-checked="true"'), true);
    const off = withPunch({ punchRecording: { ...PUNCH, enabled: false } });
    assert.equal(off.includes('aria-checked="false"'), true);
    assert.equal(off.includes('START RECORDING'), true, 'a stored window that is switched off records an ordinary take');
    assert.equal(off.includes('Off — recording runs until you press Stop, exactly as before.'), true);
    assert.equal(render().includes('START RECORDING'), true);
  });
});

describe('Phase 1L TEST 2 — the section explains the window it will record', () => {
  it('summarises bars, length and seconds', () => {
    const html = withPunch();
    assert.equal(textOf(html, 'data-punch-summary'), describePunchWindow(planFor(PUNCH, { countInBars: 1 })));
    assert.equal(textOf(html, 'data-punch-summary'), 'Bars 5 – 9 · 4 bars · 8.00 s');
    assert.equal(html.includes('data-punch-bars="4"'), true, 'one cell per punched bar');
  });

  it('names the pre-roll bars whose audio is not part of the take', () => {
    assert.equal(
      textOf(withPunch({ countInBars: 2 }), 'data-punch-preroll'),
      'Pre-roll: 2 bars of clicks before punch-in — never recorded.',
    );
    assert.equal(
      textOf(withPunch({ countInBars: 0 }), 'data-punch-preroll'),
      'Pre-roll: off — capture starts immediately at punch-in.',
    );
    const plan = planFor(PUNCH, { countInBars: 2 });
    assert.equal(plan.countInBars, 2);
    assert.equal(plan.countInBeats, 8);
    assert.equal(plan.preRollSeconds, 4);
    assert.equal(plan.countInStartBeat, 8, 'the pre-roll starts one bar earlier than a 1-bar pre-roll');
    assert.equal(plan.inBeats, 16, 'capture still begins exactly at punch-in');
  });

  it('flags a pre-roll that starts before the arrangement', () => {
    const html = withPunch({ punchRecording: { ...PUNCH, inBar: 1, outBar: 3 }, countInBars: 2 });
    assert.equal(
      textOf(html, 'data-punch-preroll-early'),
      'Punch-in is closer to bar 1 than the count-in is long: the pre-roll starts before the arrangement and capture still begins at punch-in.',
    );
    const plan = planFor({ ...PUNCH, inBar: 1, outBar: 3 }, { countInBars: 2 });
    assert.equal(plan.preRollBeforeTimeline, true);
    assert.equal(plan.inBeats, 0);
    assert.equal(plan.countInStartBeat, -8, 'a virtual position before the arrangement');
  });

  it('shows a validation issue for a window that cannot be recorded', () => {
    const broken = { ...PUNCH, outBar: 3 };
    const html = withPunch({ punchRecording: broken });
    const validation = validatePunchRecording(broken, { meter: [4, 4], totalBars: 32 });
    assert.equal(validation.valid, false);
    assert.equal(validation.issues[0].field, 'range');
    assert.equal(html.includes('Punch-out must come after punch-in.'), true);
    assert.equal(textOf(html, 'data-punch-summary'), 'Set a valid punch range');
    assert.throws(() => planFor(broken, { countInBars: 1 }), /Punch-out must come after punch-in/);
  });

  it('refuses a beat past the end of the meter bar', () => {
    const html = withPunch({ punchRecording: { ...PUNCH, inBeat: 5 } });
    assert.equal(html.includes('Punch-in beat 5 is past the end of a 4/4 bar (4 beats).'), true);
    assert.equal(inputValue(html, 'Punch-in beat'), '5', 'the invalid draft stays visible rather than snapping away');
    const sevenEight = withPunch({ punchRecording: { ...PUNCH, inBeat: 7 }, timeSignature: [7, 8] });
    assert.equal(sevenEight.includes('past the end of a'), false, '7/8 counts seven pulses, so beat 7 is legal');
    assert.equal(textOf(sevenEight, 'data-punch-position="in"'), '05.7');
    assert.equal(inputValue(sevenEight, 'Punch-in beat'), '7');
  });

  it('warns about a punch-out past the arrangement end without blocking the take', () => {
    const pastEnd = { ...PUNCH, outBar: 40 };
    const html = withPunch({ punchRecording: pastEnd });
    assert.equal(
      html.includes('Punch-out bar 40 is past the end of the arrangement — the take will stop at bar 32.'),
      true,
    );
    assert.equal(textOf(html, 'data-punch-truncated'), 'The take stops at the end of the arrangement.');
    assert.equal(validatePunchRecording(pastEnd, { meter: [4, 4], totalBars: 32 }).valid, true, 'a warning, not a block');
    const plan = planFor(pastEnd, { countInBars: 1 });
    assert.equal(plan.truncatedAtProjectEnd, true);
    assert.equal(plan.effectiveOutBeats, 128);
    assert.equal(plan.effectiveOutBar, 33);
    assert.equal(plan.captureDurationBeats, 112, 'punch-in at beat 16 through the end of 32 bars');
    assert.equal(plan.clipStartBar + plan.clipLengthBars, 32, 'the clip never reaches past the arrangement');
    // A window that fits needs neither the warning nor the truncation note.
    assert.equal(withPunch().includes('past the end of the arrangement'), false);
    assert.equal(textOf(withPunch(), 'data-punch-truncated'), undefined);
  });
});

describe('Phase 1L TEST 3 — the section follows the transport and the meter', () => {
  it('maps the transport position onto a bar/beat position', () => {
    // currentStep is the transport's sixteenth step inside the bar.
    assert.deepEqual(punchPositionFromTransport(3, 9, { meter: [4, 4] }), { bar: 3, beat: 3 });
    assert.deepEqual(punchPositionFromTransport(3, 0, { meter: [4, 4] }), { bar: 3, beat: 1 });
    assert.deepEqual(punchPositionFromTransport(0, 0, { meter: [4, 4] }), { bar: 1, beat: 1 }, 'bar 0 is not a bar');
    assert.deepEqual(punchPositionFromTransport(3, 20, { meter: [4, 4] }), { bar: 3, beat: 2 }, 'a step past the bar wraps');
    assert.deepEqual(punchPositionFromTransport(2, 4, { meter: [6, 8] }), { bar: 2, beat: 3 }, '6/8 counts six eighth pulses');
    assert.deepEqual(punchPositionFromTransport(2, 4, { meter: [3, 4] }), { bar: 2, beat: 2 });
  });

  it('rounds a bar/beat position onto the meter pulse grid', () => {
    assert.deepEqual(beatsToBarBeat(0.25, { meter: [4, 4] }), { bar: 1, beat: 1 });
    assert.deepEqual(beatsToBarBeat(0.5, { meter: [4, 4] }), { bar: 1, beat: 2 });
    assert.deepEqual(beatsToBarBeat(1.5, { meter: [4, 4] }), { bar: 1, beat: 3 });
    assert.deepEqual(beatsToBarBeat(0.2, { meter: [7, 8] }), { bar: 1, beat: 1 }, '7/8 snaps to the eighth-note grid');
    assert.equal(formatPunchPosition({ bar: 12, beat: 1 }), '12.1');
    assert.equal(formatPunchPosition({ bar: 5, beat: 3 }), '05.3');
  });

  it('drives the ruler overlay from the punched beats, including partial bars', () => {
    const segments = punchRulerSegments(punchRangeBeats(PUNCH, { meter: [4, 4] }), { meter: [4, 4], totalBars: 32 });
    assert.deepEqual(segments.map(s => [s.barIndex, s.startFraction, s.endFraction]), [[4, 0, 1], [5, 0, 1], [6, 0, 1], [7, 0, 1]]);
    assert.equal(segments[0].containsIn, true, 'the punch-in bar is marked');
    assert.equal(segments[3].containsOut, true, 'the punch-out bar is marked');

    const partial = punchRulerSegments({ inBeats: 17, outBeats: 26 }, { meter: [4, 4], totalBars: 32 });
    assert.deepEqual(partial.map(s => [s.barIndex, s.startFraction, s.endFraction]), [[4, 0.25, 1], [5, 0, 1], [6, 0, 0.5]]);

    const clipped = punchRulerSegments(punchRangeBeats({ ...PUNCH, outBar: 40 }, { meter: [4, 4] }), { meter: [4, 4], totalBars: 8 });
    assert.equal(clipped.length, 4, 'the overlay stops at the end of the arrangement');
    assert.deepEqual(clipped.map(s => s.barIndex), [4, 5, 6, 7]);
  });

  it('keeps the punch geometry valid in every supported meter', () => {
    for (const meter of [[4, 4], [3, 4], [6, 8], [7, 8]] as Array<[number, number]>) {
      const plan = planFor({ ...PUNCH, outBar: 7 }, { meter, countInBars: 1 });
      const barBeats = beatsPerBar(meter);
      assert.ok(plan.captureDurationBeats > 0, `${meter.join('/')} window`);
      assert.equal(plan.captureDurationBeats, plan.effectiveOutBeats - plan.inBeats);
      assert.equal(plan.clipStartBar, plan.inBeats / barBeats, `${meter.join('/')} clip starts on punch-in`);
      assert.equal(plan.clipStartBar + plan.clipLengthBars, plan.effectiveOutBeats / barBeats, `${meter.join('/')} clip ends on punch-out`);
    }
  });
});

describe('Phase 1L TEST 4 — a completed take is placed at the punched geometry', () => {
  it('a whole-bar window keeps whole-bar geometry', () => {
    assert.deepEqual(planPunchClipPlacement(planFor(PUNCH, { countInBars: 1 })), { startBar: 4, lengthBars: 4, trimSeconds: 8 });
  });

  it('a fractional window keeps fractional geometry and trims to it', () => {
    const plan = planFor({ ...PUNCH, inBar: 5, inBeat: 3, outBar: 6, outBeat: 3 }, { countInBars: 0 });
    assert.deepEqual(planPunchClipPlacement(plan), { startBar: 4.5, lengthBars: 1, trimSeconds: 2 });
    assert.equal(plan.inBeats, 18, 'bar 5 beat 3 is four whole bars plus two beats');
    assert.equal(plan.effectiveOutBeats, 22);
  });

  it('a truncated window is placed inside the arrangement', () => {
    const plan = planFor({ ...PUNCH, outBar: 20 }, { countInBars: 0, totalBars: 8 });
    assert.equal(plan.truncatedAtProjectEnd, true);
    const placement = planPunchClipPlacement(plan);
    assert.equal(placement.startBar, 4);
    assert.equal(placement.lengthBars, 4, 'four bars remain between bar 5 and the end of an 8-bar arrangement');
    assert.equal(placement.startBar + placement.lengthBars, 8);
  });

  it('the geometry is bar/beat derived, so it survives a tempo change', () => {
    const slow = planFor(PUNCH, { countInBars: 1, bpm: 60 });
    const fast = planFor(PUNCH, { countInBars: 1, bpm: 240 });
    // The clip geometry is musical: the same four bars at any tempo. Only the
    // trim length is wall-clock, because it trims decoded audio.
    assert.deepEqual(
      { startBar: slow.clipStartBar, lengthBars: slow.clipLengthBars },
      { startBar: fast.clipStartBar, lengthBars: fast.clipLengthBars },
    );
    assert.equal(planPunchClipPlacement(slow).trimSeconds, 16, '16 beats at 60 BPM');
    assert.equal(planPunchClipPlacement(fast).trimSeconds, 4, '16 beats at 240 BPM');
    assert.equal(slow.captureDurationSeconds, 16);
    assert.equal(fast.captureDurationSeconds, 4);
  });
});
