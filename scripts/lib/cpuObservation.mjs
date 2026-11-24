/**
 * Honest classification of helper-thread CPU time readings.
 *
 * The problem this exists to prevent: Windows reported `helper*CpuMs` as 0 for
 * sub-millisecond spans, and a zero reads as "this work cost no CPU". It did not
 * mean that. `GetThreadTimes` advances in whole clock steps, so a span shorter
 * than one step measures 0 while still having consumed CPU.
 *
 * Three states are kept strictly separate, because they license different claims:
 *
 *   clockUnavailable - the platform exposed no per-thread CPU clock at all.
 *                      Nothing is known about CPU time.
 *   noClockTick      - a clock existed but never advanced during the block. The
 *                      CPU time is below one observed step. This is UNKNOWN, not
 *                      zero, and must never be reported as zero CPU.
 *   positiveCpuDelta - the clock advanced and a real CPU delta was measured. Only
 *                      this state is evidence of CPU time.
 *
 * Two further limits are recorded alongside the counts rather than left to the
 * reader: these are the helper thread's own CPU time (a plug-in running its own
 * worker threads would account that CPU elsewhere), and nothing here may drive an
 * audio scheduling or production processing decision.
 *
 * `smallestObservedCpuClockStepMs` is the smallest advance actually measured at
 * helper startup. It is an observation of how the clock steps, NOT the clock's
 * exact resolution - nothing measures that - and must not be reported as one.
 */
export const CPU_OBSERVATION_INTERPRETATION =
  'A zero helper*CpuMs with a supported clock means the per-thread CPU clock did '
  + 'not advance during that block, so the CPU time is below one observed step. It '
  + 'does NOT mean no CPU was used, and the helper-versus-scheduling question '
  + 'stays unanswered. smallestObservedCpuClockStepMs is the smallest advance '
  + 'measured at helper startup, not the clock exact resolution.';

export const CPU_OBSERVATION_USAGE_LIMIT =
  'Helper-thread CPU only. Must not inform any audio scheduling or production '
  + 'processing decision.';

/** Classifies one block's CPU reading into exactly one of the three states. */
export function cpuReadingState(block) {
  const b = block ?? {};
  if (b.helperCpuTimingSupported === false) return 'clockUnavailable';
  // Not a number, or the recorder's own "not measured" sentinel: either way there
  // is no reading to interpret, and inventing one would be worse than saying so.
  if (typeof b.helperInstanceProcessCpuMs !== 'number' || b.helperInstanceProcessCpuMs < 0) {
    return 'cpuFieldNull';
  }
  if (b.helperInstanceProcessCpuMs > 0) return 'positiveCpuDelta';
  // A supported clock that reported exactly zero: the clock did not advance during
  // the span. Unknown CPU time, below one observed step - never "no CPU used".
  return 'noClockTick';
}

/**
 * Summarises every block's CPU reading for one aggregate evidence record.
 * `blocks` are the cold-start block records; `options.runsCounted` is reported
 * back so the reader can see how much of the session this covers.
 */
export function summarizeCpuObservations(blocks, options = {}) {
  const rows = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  const counts = {
    clockUnavailable: 0, cpuFieldNull: 0, noClockTick: 0, positiveCpuDelta: 0,
  };
  let smallestStep = null;
  for (const block of rows) {
    counts[cpuReadingState(block)] += 1;
    const step = block.helperCpuClockObservedStepMs;
    if (typeof step === 'number' && step > 0 && (smallestStep === null || step < smallestStep)) {
      smallestStep = step;
    }
  }
  return {
    runsCounted: typeof options.runsCounted === 'number' ? options.runsCounted : null,
    blocksExamined: rows.length,
    ...counts,
    smallestObservedCpuClockStepMs: smallestStep,
    interpretation: CPU_OBSERVATION_INTERPRETATION,
    usageLimit: CPU_OBSERVATION_USAGE_LIMIT,
  };
}
