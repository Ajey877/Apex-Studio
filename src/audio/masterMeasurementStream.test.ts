import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementWindowPlanner } from './masterMeasurementStream.ts';

describe('Phase 45: measurement stream windowing', () => {
  it('primes on the first read without measuring anything', () => {
    const planner = createMeasurementWindowPlanner();
    const first = planner.plan(4800, 4096);
    assert.equal(first.primed, true);
    assert.equal(first.count, 0);
  });

  it('consumes exactly the samples that arrived between reads', () => {
    const planner = createMeasurementWindowPlanner();
    planner.plan(10000, 4096);
    const next = planner.plan(11200, 4096);
    assert.equal(next.count, 1200);
    // The buffer spans [7104, 11200), so the 1200 new samples start at 10000,
    // i.e. 4096 - 1200 = 2896 samples into the buffer.
    assert.equal(next.offset, 4096 - 1200);
    assert.equal(next.gapSamples, 0);
  });

  it('never double-counts the overlapping region of two reads', () => {
    const planner = createMeasurementWindowPlanner();
    planner.plan(10000, 4096);
    const a = planner.plan(10500, 4096);
    const b = planner.plan(10800, 4096);
    assert.equal(a.count + b.count, 800, 'overlapping reads must not measure a sample twice');
  });

  it('reports zero work when the clock has not advanced', () => {
    const planner = createMeasurementWindowPlanner();
    planner.plan(10000, 4096);
    assert.equal(planner.plan(10000, 4096).count, 0);
    assert.equal(planner.plan(9990, 4096).count, 0, 'a rewound clock must not measure backwards');
    // Re-anchored, so the next advance is measured from the new position.
    assert.equal(planner.plan(10100, 4096).count, 110);
  });

  it('counts audio that went by unread instead of guessing it', () => {
    const planner = createMeasurementWindowPlanner();
    planner.plan(10000, 4096);
    // A throttled tab: 20000 samples elapsed but only the last 4096 survive.
    const after = planner.plan(30000, 4096);
    assert.equal(after.count, 4096, 'only what is still in the buffer can be measured');
    assert.equal(after.gapSamples, 20000 - 4096);
    assert.equal(planner.unreadSampleCount, after.gapSamples);
  });

  it('resets so a new take cannot inherit the previous window', () => {
    const planner = createMeasurementWindowPlanner();
    planner.plan(10000, 4096);
    planner.plan(11000, 4096);
    planner.reset();
    assert.equal(planner.unreadSampleCount, 0);
    assert.equal(planner.plan(12000, 4096).primed, true);
  });

  it('is inert for a nonsense clock or an empty buffer', () => {
    const planner = createMeasurementWindowPlanner();
    assert.equal(planner.plan(Number.NaN, 4096).count, 0);
    assert.equal(planner.plan(1000, 0).count, 0);
  });
});
