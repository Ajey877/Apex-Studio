/**
 * Turns "the analyser holds the last N samples" into "give me the samples I
 * have not measured yet".
 *
 * An AnalyserNode only exposes a tail of its input, so a streaming meter that
 * reads it on a timer would either double-count the overlapping region or skip
 * whatever went by between reads. This planner maps the audio clock onto an
 * absolute sample index and returns exactly the new region, counting anything it
 * could not read. Keeping the arithmetic here - pure, no Web Audio - is what
 * makes the boundary conditions testable.
 */

export interface MeasurementWindowPlan {
  /** Index into the tail buffer where the unread region starts. */
  offset: number;
  /** How many samples may be consumed; 0 means nothing new arrived. */
  count: number;
  /** Samples that elapsed without being read (throttled tab, long frame). */
  gapSamples: number;
  /** True when this call only established the anchor and measured nothing. */
  primed: boolean;
}

/**
 * `newestSample` is a half-open bound: the absolute index the context will
 * assign to the *next* frame it renders. Intervals are [tail, newest), which
 * keeps "samples consumed" identical to "samples the clock advanced" with no
 * off-by-one at the seam.
 */
export interface MeasurementWindowPlanner {
  plan(newestSample: number, bufferSize: number): MeasurementWindowPlan;
  reset(): void;
  readonly unreadSampleCount: number;
}

export function createMeasurementWindowPlanner(): MeasurementWindowPlanner {
  let tailSample = -1;
  let unreadSamples = 0;

  return {
    plan(newestSample: number, bufferSize: number): MeasurementWindowPlan {
      if (!Number.isFinite(newestSample) || bufferSize <= 0) {
        return { offset: 0, count: 0, gapSamples: 0, primed: true };
      }

      if (tailSample < 0) {
        tailSample = newestSample;
        return { offset: 0, count: 0, gapSamples: 0, primed: true };
      }

      // Clock went backwards (a fresh context, or a device change): anchor
      // again rather than measuring a negative span.
      if (newestSample <= tailSample) {
        if (newestSample < tailSample) tailSample = newestSample;
        return { offset: 0, count: 0, gapSamples: 0, primed: false };
      }

      const oldestAvailable = newestSample - bufferSize;
      const from = Math.max(oldestAvailable, tailSample);
      const gap = oldestAvailable > tailSample ? oldestAvailable - tailSample : 0;
      const count = Math.min(newestSample - from, bufferSize);
      unreadSamples += gap;
      tailSample = from + count;

      return { offset: from - oldestAvailable, count, gapSamples: gap, primed: false };
    },
    reset(): void {
      tailSample = -1;
      unreadSamples = 0;
    },
    get unreadSampleCount(): number {
      return unreadSamples;
    },
  };
}
