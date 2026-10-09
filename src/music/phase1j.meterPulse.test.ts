/**
 * Phase 1J — pulse layouts, metronome click decisions and ruler divisions for
 * the four supported meters, plus 7/8 accent groupings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stepsPerBar, type TimeSignature } from './musicalTime';
import {
  DEFAULT_SEVEN_EIGHT_GROUPING,
  SUPPORTED_TIME_SIGNATURES,
  describePulseLayout,
  describeStoredTimeSignature,
  parseSupportedTimeSignature,
  resolveMeterPulseLayout,
  resolveMetronomeClickLevel,
  resolveRulerTicks,
  resolveSevenEightGrouping,
} from './meterPulse';

const clicksForBar = (meter: TimeSignature, grouping = DEFAULT_SEVEN_EIGHT_GROUPING) => {
  const layout = resolveMeterPulseLayout(meter, grouping);
  const out: Array<[number, string]> = [];
  for (let step = 0; step < layout.stepsPerBar; step++) {
    const level = resolveMetronomeClickLevel(layout, step);
    if (level) out.push([step, level]);
  }
  return out;
};

describe('Phase 1J — supported meter selector values', () => {
  it('offers exactly 4/4, 3/4, 6/8 and 7/8', () => {
    assert.deepEqual(SUPPORTED_TIME_SIGNATURES.map(m => `${m[0]}/${m[1]}`), ['4/4', '3/4', '6/8', '7/8']);
  });
  it('parses supported labels and rejects everything else', () => {
    assert.deepEqual(parseSupportedTimeSignature('7/8'), [7, 8]);
    assert.deepEqual(parseSupportedTimeSignature(' 3 / 4 '), [3, 4]);
    for (const bad of ['5/4', '7/4', '2/4', '12/8', '4/3', '0/4', '7/8/1', '7-8', '', 'abc', 7, null, undefined, [7, 8]]) {
      assert.equal(parseSupportedTimeSignature(bad), null, `${String(bad)} must be rejected`);
    }
  });
  it('describes unsupported stored meters honestly with the 4/4 runtime fallback', () => {
    assert.deepEqual(describeStoredTimeSignature([7, 8]), { label: '7/8', supported: true, runtime: [7, 8] });
    const odd = describeStoredTimeSignature([5, 4]);
    assert.equal(odd.label, '5/4');
    assert.equal(odd.supported, false);
    assert.deepEqual(odd.runtime, [4, 4]);
    assert.equal(describeStoredTimeSignature(undefined).label, 'missing');
  });
});

describe('Phase 1J — pulse layouts tile the authoritative runtime bar', () => {
  it('every supported meter tiles stepsPerBar exactly', () => {
    for (const meter of SUPPORTED_TIME_SIGNATURES) {
      const layout = resolveMeterPulseLayout(meter);
      assert.equal(layout.stepsPerBar, stepsPerBar(meter));
      assert.equal(layout.pulses.length * layout.stepsPerPulse, stepsPerBar(meter));
    }
  });

  it('4/4 keeps the legacy quarter-note click grid (steps 0, 4, 8, 12; downbeat on 0)', () => {
    assert.deepEqual(clicksForBar([4, 4]), [[0, 'downbeat'], [4, 'pulse'], [8, 'pulse'], [12, 'pulse']]);
  });
  it('3/4 clicks three quarter notes', () => {
    assert.deepEqual(clicksForBar([3, 4]), [[0, 'downbeat'], [4, 'pulse'], [8, 'pulse']]);
  });
  it('6/8 clicks six eighth notes accented 3+3', () => {
    assert.deepEqual(clicksForBar([6, 8]), [[0, 'downbeat'], [2, 'pulse'], [4, 'pulse'], [6, 'accent'], [8, 'pulse'], [10, 'pulse']]);
  });
  it('7/8 clicks seven eighth notes; accents follow the grouping', () => {
    assert.deepEqual(clicksForBar([7, 8], '2+2+3'),
      [[0, 'downbeat'], [2, 'pulse'], [4, 'accent'], [6, 'pulse'], [8, 'accent'], [10, 'pulse'], [12, 'pulse']]);
    assert.deepEqual(clicksForBar([7, 8], '3+2+2'),
      [[0, 'downbeat'], [2, 'pulse'], [4, 'pulse'], [6, 'accent'], [8, 'pulse'], [10, 'accent'], [12, 'pulse']]);
    assert.deepEqual(clicksForBar([7, 8], '2+3+2'),
      [[0, 'downbeat'], [2, 'pulse'], [4, 'accent'], [6, 'pulse'], [8, 'pulse'], [10, 'accent'], [12, 'pulse']]);
  });
  it('7/8 never clicks on step 14 of a bar — the next bar downbeat is step 0', () => {
    const layout = resolveMeterPulseLayout([7, 8]);
    // A 16-step pattern loop in 7/8: steps 14/15 fold onto the next bar.
    assert.equal(resolveMetronomeClickLevel(layout, 14), 'downbeat');
    assert.equal(resolveMetronomeClickLevel(layout, 15), null);
    assert.equal(resolveMetronomeClickLevel(layout, 13), null);
  });
  it('long 4/4 pattern loops accent every bar line, not only step 0', () => {
    const layout = resolveMeterPulseLayout([4, 4]);
    assert.equal(resolveMetronomeClickLevel(layout, 16), 'downbeat');
    assert.equal(resolveMetronomeClickLevel(layout, 20), 'pulse');
    assert.equal(resolveMetronomeClickLevel(layout, 63), null);
  });
  it('invalid steps never click; unsupported meters/groupings fall back like the runtime', () => {
    const layout = resolveMeterPulseLayout([4, 4]);
    for (const bad of [-1, 0.5, Number.NaN, Infinity]) assert.equal(resolveMetronomeClickLevel(layout, bad), null);
    assert.deepEqual(resolveMeterPulseLayout([5, 4] as unknown as TimeSignature).meter, [4, 4]);
    assert.deepEqual(resolveMeterPulseLayout([7, 8], 'bogus' as never).groups, [2, 2, 3]);
  });
  it('resolves missing/unknown stored groupings to 2+2+3', () => {
    assert.equal(resolveSevenEightGrouping({}), '2+2+3');
    assert.equal(resolveSevenEightGrouping({ sevenEightGrouping: '4+3' }), '2+2+3');
    assert.equal(resolveSevenEightGrouping(null), '2+2+3');
    assert.equal(resolveSevenEightGrouping({ sevenEightGrouping: '2+3+2' }), '2+3+2');
  });
});

describe('Phase 1J — ruler bar divisions', () => {
  const ticks = (meter: TimeSignature, grouping = DEFAULT_SEVEN_EIGHT_GROUPING) =>
    resolveRulerTicks(resolveMeterPulseLayout(meter, grouping)).map(t => [Number(t.fraction.toFixed(6)), t.level]);
  it('4/4 → 3 inner quarter ticks; 3/4 → 2', () => {
    assert.deepEqual(ticks([4, 4]), [[0.25, 'pulse'], [0.5, 'pulse'], [0.75, 'pulse']]);
    assert.deepEqual(ticks([3, 4]), [[0.333333, 'pulse'], [0.666667, 'pulse']]);
  });
  it('6/8 → 5 inner eighth ticks with the 3+3 group line at the half bar', () => {
    assert.deepEqual(ticks([6, 8]).map(t => t[1]), ['pulse', 'pulse', 'accent', 'pulse', 'pulse']);
    assert.equal(ticks([6, 8])[2][0], 0.5);
  });
  it('7/8 → 6 inner eighth ticks with group lines at 2/7 and 4/7 (2+2+3) or 3/7 and 5/7 (3+2+2)', () => {
    const a = ticks([7, 8], '2+2+3').filter(t => t[1] === 'accent').map(t => t[0]);
    assert.deepEqual(a, [Number((2 / 7).toFixed(6)), Number((4 / 7).toFixed(6))]);
    const b = ticks([7, 8], '3+2+2').filter(t => t[1] === 'accent').map(t => t[0]);
    assert.deepEqual(b, [Number((3 / 7).toFixed(6)), Number((5 / 7).toFixed(6))]);
    assert.equal(ticks([7, 8]).length, 6);
  });
  it('describes layouts for display', () => {
    assert.equal(describePulseLayout(resolveMeterPulseLayout([7, 8], '3+2+2')), '7/8 · 3+2+2 eighths');
    assert.equal(describePulseLayout(resolveMeterPulseLayout([3, 4])), '3/4 · 3 quarters');
  });
});
