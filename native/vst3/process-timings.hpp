#pragma once

// Measurement-only timing for one Instance::process() call.
//
// TWO CLOCKS, ON PURPOSE
// Wall time alone cannot answer the question this investigation needs. A 13 ms
// host-preparation span does not prove the helper executed 13 ms of host code: it
// is equally consistent with the thread being descheduled by the operating system
// for most of it. So every span is measured twice:
//
//   *Ms     wall elapsed time, steady_clock. Includes OS descheduling.
//   *CpuMs  helper-thread CPU time. Excludes time the thread was not running.
//
// The difference between the two is wall time not accounted for by this thread's
// own CPU usage, which is the signature of contention rather than of expensive
// code. That distinction is the whole point: it separates "the host is doing
// something slow" from "the host was not scheduled".
//
// `*CpuMs` covers ONLY this thread. A plug-in that runs its own worker threads
// would have their CPU accounted elsewhere, and these numbers must not be read as
// the plug-in's total CPU cost.
//
// WHY THE HOST/PLUGIN SPLIT EXISTS
// The coarse span that existed before this file covered the whole of
// Instance::process(), which is host work - base64/PCM decode, parameter queues,
// output-buffer clearing, ProcessContext preparation, input-buffer setup, then
// output validation and PCM extraction - around exactly one call to
// processor->process(data). Reporting that total as plug-in time blames the plug-in
// for the host's own cost. The call is therefore partitioned into three
// non-overlapping spans, whose sum equals the total by construction:
//   hostPrepare    entry          -> just before processor->process(data)
//   pluginCallback just before    -> just after it returns
//   hostCollect    just after     -> method exit
// They must never be added to the total.
//
// Both clocks are monotonic. Wall uses steady_clock; CPU uses the OS per-thread
// CPU clock. Epoch stamps live only in host.cpp, where a value is compared with
// another process.
//
// Nothing here participates in a scheduling decision or can alter audio behaviour;
// it only fills in a struct that is copied into the response. An unsupported CPU
// clock reports -1 ("not measured"), never 0, because 0 ms of CPU would falsely
// claim the work was free.

#include <chrono>
#include <ctime>

#if defined(_WIN32)
#include <windows.h>
#endif

struct ProcessTimings {
  // Wall elapsed time.
  double instanceProcessMs = -1;  // the entire Instance::process() call
  double hostPrepareMs = -1;      // host work before the plug-in callback
  double pluginCallbackMs = -1;   // exactly processor->process(data)
  double hostCollectMs = -1;      // host work after the callback returns
  // Helper-thread CPU time for the same four spans. -1 means not measured.
  double instanceProcessCpuMs = -1;
  double hostPrepareCpuMs = -1;
  double pluginCallbackCpuMs = -1;
  double hostCollectCpuMs = -1;
  // False when the platform exposed no per-thread CPU clock, so a reader can tell
  // "unsupported" apart from "measured as zero".
  bool cpuTimingSupported = false;
  int frames = -1;                // block size actually processed
  bool flush = false;             // zero-frame flush, excluded from audio stats
};

inline double monotonicMs() {
  return std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
}

// CPU time consumed by the CURRENT thread only, in milliseconds, or -1 when the
// platform provides no such clock.
inline double threadCpuMs() {
#if defined(_WIN32)
  FILETIME creation{};
  FILETIME exitTime{};
  FILETIME kernel{};
  FILETIME user{};
  if (!::GetThreadTimes(::GetCurrentThread(), &creation, &exitTime, &kernel, &user)) return -1;
  const auto fileTimeToMs = [](const FILETIME& value) {
    ULARGE_INTEGER ticks{};
    ticks.LowPart = value.dwLowDateTime;
    ticks.HighPart = value.dwHighDateTime;
    // FILETIME is in 100 ns units.
    return static_cast<double>(ticks.QuadPart) / 10000.0;
  };
  // Kernel plus user: both are this thread's own CPU consumption.
  return fileTimeToMs(kernel) + fileTimeToMs(user);
#elif defined(CLOCK_THREAD_CPUTIME_ID)
  struct timespec spec{};
  if (::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &spec) != 0) return -1;
  return static_cast<double>(spec.tv_sec) * 1000.0 + static_cast<double>(spec.tv_nsec) / 1000000.0;
#else
  return -1;
#endif
}

// The two clock sources, injectable so the unsupported-CPU path can be exercised
// directly. Production callers use the defaults; nothing else changes.
struct TimingClocks {
  double (*wall)() = &monotonicMs;
  double (*cpu)() = &threadCpuMs;
};

// Records both clocks for the three sub-spans. Constructed at method entry; the two
// mark* calls bracket the plug-in callback; finish() writes the result.
//
// A null `out` is supported, so callers that do not want timings pass nullptr.
class ProcessSpanRecorder {
 public:
  explicit ProcessSpanRecorder(ProcessTimings* out, TimingClocks clocks = {})
      : out_(out), wall_(clocks.wall), cpu_(clocks.cpu),
        startMs_(clocks.wall()), startCpuMs_(clocks.cpu()) {}

  // Called immediately before processor->process(data). Everything the host did
  // beforehand is therefore excluded from the callback span.
  void markCallbackStart() {
    prepareEndMs_ = wall_();
    prepareEndCpuMs_ = cpu_();
    callbackStarted_ = true;
  }

  // Called immediately after processor->process(data) returns, before any host
  // output validation runs.
  void markCallbackEnd() {
    callbackEndMs_ = wall_();
    callbackEndCpuMs_ = cpu_();
  }

  void finish(int frames, bool flush) {
    if (!out_) return;
    const double endMs = wall_();
    const double endCpuMs = cpu_();
    // -1 from the first read means the platform has no per-thread CPU clock. Report
    // that honestly instead of writing zeros that would read as free work.
    const bool cpuOk = startCpuMs_ >= 0 && endCpuMs >= 0 &&
                       prepareEndCpuMs_ >= 0 && callbackEndCpuMs_ >= 0;
    out_->cpuTimingSupported = cpuOk;
    // Without both marks the callback was never bracketed - an early throw, say -
    // and inventing spans would be worse than reporting none.
    if (callbackStarted_) {
      out_->hostPrepareMs = prepareEndMs_ - startMs_;
      out_->pluginCallbackMs = callbackEndMs_ - prepareEndMs_;
      out_->hostCollectMs = endMs - callbackEndMs_;
      if (cpuOk) {
        out_->hostPrepareCpuMs = prepareEndCpuMs_ - startCpuMs_;
        out_->pluginCallbackCpuMs = callbackEndCpuMs_ - prepareEndCpuMs_;
        out_->hostCollectCpuMs = endCpuMs - callbackEndCpuMs_;
      }
    }
    out_->instanceProcessMs = endMs - startMs_;
    if (cpuOk) out_->instanceProcessCpuMs = endCpuMs - startCpuMs_;
    out_->frames = frames;
    // A zero-frame flush is not an audio block: folding it into per-block
    // statistics would drag the callback median towards zero and hide real cost.
    out_->flush = flush || frames == 0;
  }

 private:
  ProcessTimings* out_;
  double (*wall_)();
  double (*cpu_)();
  double startMs_;
  double startCpuMs_;
  double prepareEndMs_ = -1;
  double prepareEndCpuMs_ = -1;
  double callbackEndMs_ = -1;
  double callbackEndCpuMs_ = -1;
  bool callbackStarted_ = false;
};
