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

  if (failures == 0) {
    std::printf("process-timings: all checks passed\n");
    return 0;
  }
  std::printf("process-timings: %d check(s) FAILED\n", failures);
  return 1;
}
