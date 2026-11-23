#pragma once

// Measurement-only timing for one Instance::process() call.
//
// WHY THIS IS SPLIT AT ALL
// The coarse span that existed before this file covered the whole of
// Instance::process(). That method is host work - base64/PCM decode, parameter
// queues, output-buffer clearing, ProcessContext preparation, input-buffer setup,
// then output validation and PCM extraction - wrapped around exactly one call to
// processor->process(data). Reporting that total as plug-in time blames the
// plug-in for the host's own cost, which is precisely the misreading that made an
// earlier 14 ms block look like a slow plug-in.
//
// So the call is partitioned into three non-overlapping spans:
//   hostPrepareMs    entry            -> just before processor->process(data)
//   pluginCallbackMs just before      -> just after it returns
//   hostCollectMs    just after       -> method exit
// Their sum equals instanceProcessMs by construction. They must never be added to
// instanceProcessMs.
//
// steady_clock, not system_clock: every span here is intra-process, and a monotonic
// clock is immune to wall-clock adjustment in the middle of an audio block. Epoch
// stamps are kept only in host.cpp, where a value is compared with another process.
//
// Nothing in this file participates in a scheduling decision or can alter audio
// behaviour; it only fills in a struct that is copied into the response.

#include <chrono>

struct ProcessTimings {
  double instanceProcessMs = -1;  // the entire Instance::process() call
  double hostPrepareMs = -1;      // host work before the plug-in callback
  double pluginCallbackMs = -1;   // exactly processor->process(data)
  double hostCollectMs = -1;      // host work after the callback returns
  int frames = -1;                // block size actually processed
  bool flush = false;             // zero-frame flush, excluded from audio stats
};

inline double monotonicMs() {
  return std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Records the three sub-spans. Constructed at method entry; the two mark* calls
// bracket the plug-in callback; finish() writes the result.
//
// A null `out` is supported and costs nothing beyond two clock reads, so the
// zero-frame flush path and any caller that does not want timings can pass nullptr.
class ProcessSpanRecorder {
 public:
  explicit ProcessSpanRecorder(ProcessTimings* out) : out_(out), startMs_(monotonicMs()) {}

  // Called immediately before processor->process(data). Everything the host did
  // beforehand is therefore excluded from the callback span.
  void markCallbackStart() { prepareEndMs_ = monotonicMs(); callbackStarted_ = true; }

  // Called immediately after processor->process(data) returns, before any host
  // output validation runs.
  void markCallbackEnd() { callbackEndMs_ = monotonicMs(); }

  void finish(int frames, bool flush) {
    if (!out_) return;
    const double endMs = monotonicMs();
    // Without both marks the callback was never bracketed - an early throw, say -
    // and inventing spans would be worse than reporting none.
    if (callbackStarted_) {
      out_->hostPrepareMs = prepareEndMs_ - startMs_;
      out_->pluginCallbackMs = callbackEndMs_ - prepareEndMs_;
      out_->hostCollectMs = endMs - callbackEndMs_;
    }
    out_->instanceProcessMs = endMs - startMs_;
    out_->frames = frames;
    // A zero-frame flush is not an audio block: folding it into per-block
    // statistics would drag the callback median towards zero and hide real cost.
    out_->flush = flush || frames == 0;
  }

 private:
  ProcessTimings* out_;
  double startMs_;
  double prepareEndMs_ = -1;
  double callbackEndMs_ = -1;
  bool callbackStarted_ = false;
};
