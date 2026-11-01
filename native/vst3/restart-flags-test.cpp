// Regression test for thread-safe atomic accumulation & consumption of
// Steinberg::Vst::IComponentHandler::restartComponent(flags) in HostComponentHandler.
#include "component-handler.hpp"
#include <atomic>
#include <cstdlib>
#include <iostream>
#include <thread>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;
using ApexVst3Host::HostComponentHandler;

namespace {

void requireTrue(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "restart-flags-test FAILED: " << message << "\n";
    std::exit(1);
  }
}

void testSequentialCombinedFlags() {
  IPtr<HostComponentHandler> handler = owned(new HostComponentHandler());
  requireTrue(handler->peekRestartFlags() == 0, "initial restart flags must be 0");
  requireTrue(handler->consumeRestartFlags() == 0, "initial consume must return 0");

  // Invalid non-positive values are safely ignored without clobbering state
  requireTrue(handler->restartComponent(0) == kResultOk, "zero flag returns kResultOk");
  requireTrue(handler->restartComponent(-4) == kResultOk, "negative flag returns kResultOk");
  requireTrue(handler->peekRestartFlags() == 0, "non-positive flags must not set bits");

  // Combined flags across separate calls accumulate without overwriting previous flags
  requireTrue(handler->restartComponent(RestartFlags::kLatencyChanged) == kResultOk, "set kLatencyChanged");
  requireTrue(handler->restartComponent(RestartFlags::kIoChanged) == kResultOk, "set kIoChanged");
  requireTrue(handler->restartComponent(RestartFlags::kParamValuesChanged) == kResultOk, "set kParamValuesChanged");

  const int32 expected =
    RestartFlags::kLatencyChanged | RestartFlags::kIoChanged | RestartFlags::kParamValuesChanged;
  requireTrue(handler->peekRestartFlags() == expected, "peek must report exact combined bitmask");
  requireTrue(handler->consumeRestartFlags() == expected, "consume must atomically return combined bitmask");
  requireTrue(handler->peekRestartFlags() == 0, "consume must clear pendingRestartFlags to 0");
  requireTrue(handler->consumeRestartFlags() == 0, "second consume must return 0");
}

void testConcurrentAccumulateAndConsumeNoLostFlags() {
  // 4 persistent producer/consumer threads + 1 dedicated consumer thread across
  // 10,000 synchronized epochs (80,000 restartComponent calls racing directly
  // against 80,000 concurrent consumeRestartFlags calls).
  // Any non-atomic read-then-clear in consumeRestartFlags() would overwrite
  // concurrent restartComponent() bits and fail roundObserved == kExpectedMask.
  constexpr int kProducerCount = 4;
  constexpr int kTotalWorkers = kProducerCount + 1;
  constexpr int kRounds = 10000;
  constexpr int32 kExpectedMask = 0xFF; // 8 unique disjoint RestartFlags bits (0..7)

  IPtr<HostComponentHandler> handler = owned(new HostComponentHandler());
  std::atomic<int> currentRound{0};
  std::atomic<int> activeWorkers{0};
  std::atomic<int32> roundObserved{0};
  std::atomic<bool> corruptedBit{false};
  std::atomic<bool> stopAll{false};

  auto recordConsumed = [&](int32 flags) {
    if (flags != 0) {
      if ((flags & ~kExpectedMask) != 0) {
        corruptedBit.store(true, std::memory_order_release);
      }
      roundObserved.fetch_or(flags, std::memory_order_acq_rel);
    }
  };

  std::thread consumer([&]() {
    int lastRound = 0;
    while (!stopAll.load(std::memory_order_acquire)) {
      const int r = currentRound.load(std::memory_order_acquire);
      if (r > lastRound) {
        lastRound = r;
        for (int spin = 0; spin < 4; ++spin) {
          recordConsumed(handler->consumeRestartFlags());
        }
        activeWorkers.fetch_sub(1, std::memory_order_acq_rel);
      } else {
        std::this_thread::yield();
      }
    }
  });

  std::vector<std::thread> producers;
  producers.reserve(kProducerCount);
  for (int i = 0; i < kProducerCount; ++i) {
    producers.emplace_back([&, i]() {
      const int32 bitA = (1 << (2 * i));
      const int32 bitB = (1 << (2 * i + 1));
      int lastRound = 0;
      while (!stopAll.load(std::memory_order_acquire)) {
        const int r = currentRound.load(std::memory_order_acquire);
        if (r > lastRound) {
          lastRound = r;
          handler->restartComponent(bitA);
          recordConsumed(handler->consumeRestartFlags());
          handler->restartComponent(bitB);
          activeWorkers.fetch_sub(1, std::memory_order_acq_rel);
        } else {
          std::this_thread::yield();
        }
      }
    });
  }

  for (int round = 1; round <= kRounds; ++round) {
    roundObserved.store(0, std::memory_order_release);
    activeWorkers.store(kTotalWorkers, std::memory_order_release);
    currentRound.store(round, std::memory_order_release);

    while (activeWorkers.load(std::memory_order_acquire) > 0) {
      std::this_thread::yield();
    }
    recordConsumed(handler->consumeRestartFlags());

    requireTrue(!corruptedBit.load(std::memory_order_acquire), "corrupted bit observed during concurrent consume");
    requireTrue(roundObserved.load(std::memory_order_acquire) == kExpectedMask,
      "lost restart flag bit under concurrent restartComponent() + consumeRestartFlags()");
    requireTrue(handler->peekRestartFlags() == 0, "pendingRestartFlags must be 0 after round drain");
  }

  stopAll.store(true, std::memory_order_release);
  for (auto& producer : producers) producer.join();
  consumer.join();
}

void testAtomicRefCountThreadSafety() {
  auto* raw = new HostComponentHandler();
  constexpr int kThreads = 4;
  constexpr int kOpsPerThread = 25000;
  std::vector<std::thread> workers;
  workers.reserve(kThreads);
  for (int t = 0; t < kThreads; ++t) {
    workers.emplace_back([raw, kOpsPerThread]() {
      for (int i = 0; i < kOpsPerThread; ++i) {
        raw->addRef();
        raw->release();
      }
    });
  }
  for (auto& w : workers) w.join();
  requireTrue(raw->release() == 0, "final release after concurrent addRef/release must reach 0");
}

} // namespace

int main() {
  testSequentialCombinedFlags();
  testConcurrentAccumulateAndConsumeNoLostFlags();
  testAtomicRefCountThreadSafety();
  std::cout << "{\"ok\":true,\"rounds\":10000,\"producers\":4}\n";
  return 0;
}
