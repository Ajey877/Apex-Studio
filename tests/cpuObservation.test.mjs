// The CPU evidence must never report "zero CPU" when the clock simply did not
// tick. These tests pin the three states apart, because collapsing them is what
// made the Windows readings look like a solved question when they were not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuReadingState,
  summarizeCpuObservations,
  CPU_OBSERVATION_INTERPRETATION,
  CPU_OBSERVATION_USAGE_LIMIT,
} from '../scripts/lib/cpuObservation.mjs';

test('an unavailable CPU clock is its own state, not a zero', () => {
  assert.equal(cpuReadingState({ helperCpuTimingSupported: false }), 'clockUnavailable');
  // Even if a zero somehow rode along, no clock means no CPU claim at all.
  assert.equal(
    cpuReadingState({ helperCpuTimingSupported: false, helperInstanceProcessCpuMs: 0 }),
    'clockUnavailable',
  );
});

test('a supported clock that never advanced is UNKNOWN, not zero CPU', () => {
  // This is the Windows case: sub-millisecond spans measured against a clock that
  // steps in whole increments.
  assert.equal(
    cpuReadingState({
      helperCpuTimingSupported: true,
      helperInstanceProcessCpuMs: 0,
      helperCpuClockTickObserved: false,
      helperCpuClockObservedStepMs: 15.625,
    }),
    'noClockTick',
  );
  // A missing field is not a measurement either.
  assert.equal(cpuReadingState({ helperCpuTimingSupported: true }), 'cpuFieldNull');
  assert.equal(cpuReadingState({}), 'cpuFieldNull');
  assert.equal(cpuReadingState(null), 'cpuFieldNull');
});

test('only a positive delta counts as measured CPU', () => {
  assert.equal(
    cpuReadingState({ helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 1.85 }),
    'positiveCpuDelta',
  );
  assert.equal(
    cpuReadingState({
      helperCpuTimingSupported: true,
      helperInstanceProcessCpuMs: 13.04,
      helperCpuClockTickObserved: true,
    }),
    'positiveCpuDelta',
  );
  // The recorder's own "not measured" sentinel is not a reading either, and it
  // must not be folded into the no-tick state, which says something stronger.
  assert.equal(
    cpuReadingState({ helperCpuTimingSupported: true, helperInstanceProcessCpuMs: -1 }),
    'cpuFieldNull',
  );
  // Exactly zero, with a supported clock, is the no-tick case.
  assert.equal(
    cpuReadingState({ helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0 }),
    'noClockTick',
  );
});

test('the three states are counted separately and never merged', () => {
  const summary = summarizeCpuObservations([
    { helperCpuTimingSupported: false },
    { helperCpuTimingSupported: false },
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0 },
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0 },
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0 },
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 1.85, helperCpuClockObservedStepMs: 0.009 },
    { helperCpuTimingSupported: true },
  ], { runsCounted: 2 });
  assert.equal(summary.clockUnavailable, 2);
  assert.equal(summary.noClockTick, 3);
  assert.equal(summary.positiveCpuDelta, 1);
  assert.equal(summary.cpuFieldNull, 1);
  assert.equal(summary.blocksExamined, 7);
  assert.equal(summary.runsCounted, 2);
  assert.equal(
    summary.clockUnavailable + summary.noClockTick + summary.positiveCpuDelta
      + summary.cpuFieldNull,
    summary.blocksExamined,
    'every block lands in exactly one state',
  );
});

test('the observed step is the smallest measured advance, not an inferred resolution', () => {
  const summary = summarizeCpuObservations([
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 2, helperCpuClockObservedStepMs: 15.625 },
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 2, helperCpuClockObservedStepMs: 0.009 },
    // Zero and absent steps must not drag the observation down to a fake 0.
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0, helperCpuClockObservedStepMs: 0 },
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0 },
  ]);
  assert.equal(summary.smallestObservedCpuClockStepMs, 0.009);
  assert.match(summary.interpretation, /not the clock exact resolution/);
});

test('no ticks observed at all leaves the step unknown rather than zero', () => {
  const summary = summarizeCpuObservations([
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0 },
    { helperCpuTimingSupported: true, helperInstanceProcessCpuMs: 0 },
  ]);
  assert.equal(summary.smallestObservedCpuClockStepMs, null);
  assert.equal(summary.positiveCpuDelta, 0);
});

test('the limits are stated in the evidence itself', () => {
  const summary = summarizeCpuObservations([]);
  assert.equal(summary.interpretation, CPU_OBSERVATION_INTERPRETATION);
  assert.equal(summary.usageLimit, CPU_OBSERVATION_USAGE_LIMIT);
  assert.match(summary.interpretation, /does NOT mean no CPU was used/);
  assert.match(summary.interpretation, /helper-versus-scheduling question stays unanswered/);
  assert.match(summary.usageLimit, /Must not inform any audio scheduling/);
  assert.equal(summary.blocksExamined, 0);
});

test('the failing list comes from the full verdict string, not the halved row list', async () => {
  const { failingRepetitionIndices } = await import('../scripts/lib/cpuObservation.mjs');
  // The real bbfbfa9 diagnostic: eight failures, six of them past the point where
  // the verbose row list was cut down to 30 rows.
  const verdicts = 'FPPPFFPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPFPPPFPPPFPPPPFFPP';
  const rows = Array.from({ length: 30 }, (_, i) => ({ r: i + 1 }));
  assert.equal(verdicts.length, 60);
  assert.deepEqual(
    failingRepetitionIndices(verdicts, rows),
    [1, 5, 6, 44, 48, 52, 57, 58],
    'every failing repetition is named, including those beyond the retained rows',
  );
  // Deriving it from the rows alone - the old behaviour - finds only one.
  assert.deepEqual(rows.filter((_, i) => verdicts[i] === 'F').map(r => r.r), [1, 5, 6]);
});

test('a failure with no surviving row is still attributed to its repetition', async () => {
  const { failingRepetitionIndices } = await import('../scripts/lib/cpuObservation.mjs');
  assert.deepEqual(failingRepetitionIndices('PF', [{ r: 7 }]), [2]);
  assert.deepEqual(failingRepetitionIndices('PFP', []), [2]);
  assert.deepEqual(failingRepetitionIndices('PPP', [{ r: 1 }, { r: 2 }, { r: 3 }]), []);
  assert.deepEqual(failingRepetitionIndices('', []), []);
});
