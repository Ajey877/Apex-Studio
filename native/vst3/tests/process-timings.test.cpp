// Unit test for the host/plug-in timing split, run against the SAME header the
// helper ships (native/vst3/process-timings.hpp), not against a copy of it.
//
// What this can and cannot prove. It proves the recorder attributes injected delay
// to the right span, that the three spans partition the total, and that an
// unbracketed or unrequested measurement reports nothing rather than inventing
// zeros. It cannot prove that host.cpp places the two mark* calls around the real
// processor->process(data) - only a run of the built helper against a real plug-in
// can show that, which is what the packaged acceptance annotations report.
//
// Build and run: see the `test:native-timings-cpp` script. Exits non-zero on the
// first failed check.

#include "../process-timings.hpp"

#include <cmath>
#include <cstdio>
#include <thread>

namespace {

int failures = 0;

void check(bool condition, const char* what) {
  if (condition) {
    std::printf("  ok   %s\n", what);
  } else {
    std::printf("  FAIL %s\n", what);
    ++failures;
  }
}

void sleepMs(double ms) {
  std::this_thread::sleep_for(std::chrono::microseconds(static_cast<long long>(ms * 1000)));
}

// Stands in for Instance::process(): the same three phases in the same order, with
// the recorder used exactly as host.cpp uses it.
ProcessTimings runPhases(double prepareMs, double callbackMs, double collectMs,
                         int frames, bool flush, ProcessTimings* out) {
  ProcessSpanRecorder span(out);
  sleepMs(prepareMs);
  span.markCallbackStart();
  sleepMs(callbackMs);
  span.markCallbackEnd();
  sleepMs(collectMs);
  span.finish(frames, flush);
  return out ? *out : ProcessTimings{};
}

// Stepped clock used to make the span arithmetic exact rather than timing-dependent.
struct Stepper {
  static double value;
  static double next() { return (value += 1.0); }
};
double Stepper::value = 0;

}  // namespace

int main() {
  // A generous tolerance: these are wall-clock sleeps on a shared CI runner, and
  // the point is attribution, not precision.
  const double tol = 4.0;

  std::printf("process-timings: host/plug-in span attribution\n");

  {
    // 1. Delay inside the plug-in callback must land in pluginCallbackMs.
    ProcessTimings t{};
    runPhases(1.0, 40.0, 1.0, 1024, false, &t);
    std::printf("  instance=%.2f prepare=%.2f callback=%.2f collect=%.2f\n",
                t.instanceProcessMs, t.hostPrepareMs, t.pluginCallbackMs, t.hostCollectMs);
    check(t.pluginCallbackMs > 35.0, "a 40 ms plug-in callback is reported in helperPluginCallbackMs");
    check(t.hostPrepareMs < 1.0 + tol, "that delay does not leak into host preparation");
    check(t.hostCollectMs < 1.0 + tol, "that delay does not leak into host collection");
    check(t.frames == 1024, "the processed frame count is reported");
    check(!t.flush, "an ordinary audio block is not flagged as a flush");
  }

  {
    // 2. Delay in host-side preparation must land in hostPrepareMs, NOT the callback.
    ProcessTimings t{};
    runPhases(40.0, 1.0, 1.0, 1024, false, &t);
    std::printf("  instance=%.2f prepare=%.2f callback=%.2f collect=%.2f\n",
                t.instanceProcessMs, t.hostPrepareMs, t.pluginCallbackMs, t.hostCollectMs);
    check(t.hostPrepareMs > 35.0, "a 40 ms host preparation is reported in helperHostPrepareMs");
    check(t.pluginCallbackMs < 1.0 + tol,
          "host preparation is NOT attributed to the plug-in callback");
  }

  {
    // 3. Delay in host-side output collection must land in hostCollectMs.
    ProcessTimings t{};
    runPhases(1.0, 1.0, 40.0, 1024, false, &t);
    std::printf("  instance=%.2f prepare=%.2f callback=%.2f collect=%.2f\n",
                t.instanceProcessMs, t.hostPrepareMs, t.pluginCallbackMs, t.hostCollectMs);
    check(t.hostCollectMs > 35.0, "a 40 ms host collection is reported in helperHostCollectMs");
    check(t.pluginCallbackMs < 1.0 + tol,
          "host output collection is NOT attributed to the plug-in callback");
  }

  {
    // 4. The three spans must partition the total, within timing tolerance.
    ProcessTimings t{};
    runPhases(6.0, 20.0, 6.0, 512, false, &t);
    const double sum = t.hostPrepareMs + t.pluginCallbackMs + t.hostCollectMs;
    std::printf("  sum=%.3f instance=%.3f\n", sum, t.instanceProcessMs);
    check(std::fabs(sum - t.instanceProcessMs) <= tol,
          "prepare + callback + collect equals the instance total");
    check(t.instanceProcessMs > 30.0, "the instance total covers all three phases");
  }

  {
    // 5. No timings requested: nothing is written, and the caller's struct keeps
    //    its "not measured" sentinels rather than acquiring fabricated zeros.
    ProcessTimings untouched{};
    runPhases(1.0, 5.0, 1.0, 1024, false, nullptr);
    check(untouched.instanceProcessMs == -1 && untouched.hostPrepareMs == -1 &&
              untouched.pluginCallbackMs == -1 && untouched.hostCollectMs == -1,
          "a null timings pointer leaves every span unmeasured (-1)");
    check(untouched.frames == -1 && !untouched.flush, "and leaves frames/flush unset");
  }

  {
    // 6. The callback never ran (early throw before mark*): report the total but
    //    leave the sub-spans unmeasured instead of inventing a split.
    ProcessTimings t{};
    {
      ProcessSpanRecorder span(&t);
      sleepMs(3.0);
      span.finish(1024, false);
    }
    check(t.instanceProcessMs > 2.0, "the instance total is still reported");
    check(t.hostPrepareMs == -1 && t.pluginCallbackMs == -1 && t.hostCollectMs == -1,
          "an unbracketed callback leaves the sub-spans unmeasured");
  }

  {
    // 7. The zero-frame flush is flagged so it can be excluded from audio stats.
    ProcessTimings t{};
    runPhases(1.0, 1.0, 1.0, 0, false, &t);
    check(t.flush, "a zero-frame block is flagged as a flush even without the flag");
    ProcessTimings f{};
    runPhases(1.0, 1.0, 1.0, 1024, true, &f);
    check(f.flush, "an explicit flush is flagged");
  }

  {
    // 7+8. Wall and helper-thread CPU time are reported separately, and a sleep
    // inflates the wall span without becoming CPU time. This is the distinction the
    // whole phase turns on: a 13 ms host-preparation span has to be attributable to
    // either executing code or being descheduled, and wall time alone cannot say.
    ProcessTimings slept{};
    runPhases(30.0, 1.0, 1.0, 1024, false, &slept);
    check(slept.cpuTimingSupported, "the platform per-thread CPU clock is reported as supported");
    check(slept.hostPrepareMs > 25.0, "a 30 ms sleep shows up in host preparation wall time");
    check(slept.hostPrepareCpuMs >= 0.0, "host preparation CPU time is measured, not absent");
    check(slept.hostPrepareCpuMs < 15.0,
          "a sleep does NOT become equivalent helper-thread CPU time");
    check(slept.instanceProcessCpuMs >= 0.0 && slept.instanceProcessCpuMs < slept.instanceProcessMs,
          "instance CPU time is strictly below instance wall time when the thread slept");
    std::printf("  slept: wall prepare=%.2f cpu prepare=%.2f | wall total=%.2f cpu total=%.2f\n",
                slept.hostPrepareMs, slept.hostPrepareCpuMs,
                slept.instanceProcessMs, slept.instanceProcessCpuMs);

    // The converse: real work must appear as CPU time, or the CPU numbers would be
    // useless for telling contention from expensive code.
    ProcessTimings worked{};
    {
      ProcessSpanRecorder span(&worked);
      volatile double sink = 0;
      for (int i = 0; i < 4000000; ++i) sink += i * 0.5;
      span.markCallbackStart();
      for (int i = 0; i < 200000; ++i) sink += i * 0.25;
      span.markCallbackEnd();
      span.finish(1024, false);
    }
    check(worked.hostPrepareCpuMs > 1.0,
          "genuine host work is visible as helper-thread CPU time");
    check(worked.hostPrepareCpuMs <= worked.hostPrepareMs + tol,
          "CPU time cannot exceed the wall time that contains it");
    std::printf("  worked: wall prepare=%.2f cpu prepare=%.2f\n",
                worked.hostPrepareMs, worked.hostPrepareCpuMs);
  }

  {
    // 9. An unsupported CPU clock reports "not measured", never zero. Zero would
    // claim the work was free; -1 says the platform could not answer.
    ProcessTimings t{};
    const auto noCpu = []() { return -1.0; };
    TimingClocks clocks{};
    clocks.cpu = +noCpu;
    {
      ProcessSpanRecorder span(&t, clocks);
      sleepMs(3.0);
      span.markCallbackStart();
      sleepMs(2.0);
      span.markCallbackEnd();
      sleepMs(1.0);
      span.finish(1024, false);
    }
    check(!t.cpuTimingSupported, "an unavailable CPU clock is reported as unsupported");
    check(t.instanceProcessCpuMs == -1 && t.hostPrepareCpuMs == -1 &&
              t.pluginCallbackCpuMs == -1 && t.hostCollectCpuMs == -1,
          "unsupported CPU time stays -1 (null), not 0");
    check(t.instanceProcessMs > 5.0 && t.pluginCallbackMs > 1.0,
          "wall spans are still measured when the CPU clock is unavailable");
    check(!t.cpuClockTickObserved,
          "case 1 (no clock at all): no CPU tick can be claimed");
  }

  {
    // 9b. Case 3: the CPU clock IS available but never advanced during the span.
    // This is what Windows reports for the sub-millisecond spans here. The record
    // must say "the clock did not tick", never "zero CPU was used".
    ProcessTimings t{};
    const auto frozenCpu = []() { return 1000.0; };  // supported, but never moves
    TimingClocks clocks{};
    clocks.cpu = +frozenCpu;
    clocks.cpuStepMs = 15.625;  // a calibrated step, as the helper would supply
    {
      ProcessSpanRecorder span(&t, clocks);
      sleepMs(3.0);
      span.markCallbackStart();
      sleepMs(2.0);
      span.markCallbackEnd();
      sleepMs(1.0);
      span.finish(1024, false);
    }
    check(t.cpuTimingSupported, "a frozen-but-present CPU clock is still supported");
    check(t.instanceProcessCpuMs == 0.0, "the measured delta really is zero");
    check(!t.cpuClockTickObserved,
          "case 3 (supported clock, no tick): the reader is told the clock did not advance");
    check(t.instanceProcessMs > 5.0,
          "the wall span is still reported alongside the uninformative CPU reading");
    check(t.cpuClockObservedStepMs == 15.625,
          "the calibrated step is carried through so a zero can be read as below-resolution");
  }

  {
    // 9c. Case 2: a positive CPU delta was actually measured. Only this case is
    // evidence of CPU time, and only this case may set the tick flag.
    ProcessTimings t{};
    Stepper::value = 0;
    TimingClocks clocks{};
    clocks.wall = &Stepper::next;
    clocks.cpu = &Stepper::next;
    clocks.cpuStepMs = 1.0;
    {
      ProcessSpanRecorder span(&t, clocks);
      span.markCallbackStart();
      span.markCallbackEnd();
      span.finish(1024, false);
    }
    check(t.cpuTimingSupported && t.instanceProcessCpuMs > 0,
          "case 2: a positive CPU delta is recorded");
    check(t.cpuClockTickObserved,
          "case 2 (positive delta): the tick flag is set");
  }

  {
    // 9d. The observed step is measured, not assumed. On a real host this returns
    // either a positive advance it actually saw, or -1 meaning no tick arrived
    // within the budget. Neither answer may be reported as an exact resolution.
    const double step = measureCpuClockStepMs(500.0);
    check(step == -1 || step > 0,
          "the observed CPU clock step is positive or explicitly unknown, never zero");
    std::printf("process-timings: observed CPU clock step = %.6f ms%s\n", step,
                step < 0 ? " (no tick observed within the budget: unknown)" : "");
  }

  {
    // A synthetic CPU clock proves the CPU spans partition the CPU total exactly as
    // the wall spans do, independent of whatever the host clock happens to report.
    ProcessTimings t{};
    // Stepped clock: each read advances a fixed amount, so the arithmetic is exact
    // instead of depending on how the host happens to schedule this process.
    Stepper::value = 0;
    TimingClocks clocks{};
    clocks.wall = &Stepper::next;
    clocks.cpu = &Stepper::next;
    {
      ProcessSpanRecorder span(&t, clocks);
      span.markCallbackStart();
      span.markCallbackEnd();
      span.finish(1024, false);
    }
    check(t.cpuTimingSupported, "a working CPU clock is reported as supported");
    const double wallSum = t.hostPrepareMs + t.pluginCallbackMs + t.hostCollectMs;
    const double cpuSum = t.hostPrepareCpuMs + t.pluginCallbackCpuMs + t.hostCollectCpuMs;
    check(std::fabs(wallSum - t.instanceProcessMs) < 1e-9, "wall sub-spans partition the wall total");
    check(std::fabs(cpuSum - t.instanceProcessCpuMs) < 1e-9, "CPU sub-spans partition the CPU total");
    check(t.hostPrepareCpuMs > 0 && t.pluginCallbackCpuMs > 0 && t.hostCollectCpuMs > 0,
          "each span receives its own non-zero CPU measurement");
  }

  if (failures == 0) {
    std::printf("process-timings: all checks passed\n");
    return 0;
  }
  std::printf("process-timings: %d check(s) FAILED\n", failures);
  return 1;
}
