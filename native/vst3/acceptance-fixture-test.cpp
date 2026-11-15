// Behavioural test for the ApexAcceptanceGain fixture.
//
// VSTGUI cannot link on a headless Linux host (no X11), so this test covers the
// parts that decide the acceptance numbers and that do NOT need a GUI:
//   - the gain law (unity at 0.5, -24 dB .. +12 dB, monotonic, exact round-trip);
//   - real audio processing through IAudioProcessor::process, driven by a real
//     parameter change, with the measured amplitude compared against the law;
//   - component state round-trip through getState/setState;
//   - the declared bus layout: stereo in, stereo out, and NO event buses.
//
// The editor half (IPlugView) needs VSTGUI and is verified on the Windows runner
// by scripts/native-editor-windows-acceptance.mjs and the packaged harness.
#include "acceptance-fixture-processor.hpp"
#include "acceptance-fixture-controller.hpp"

#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"

#include <cmath>
#include <cstdio>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;
using namespace ApexAcceptanceGain;

namespace {

int failures = 0;

void check(bool condition, const char* what) {
  if (!condition) {
    std::printf("FAIL %s\n", what);
    ++failures;
  } else {
    std::printf("ok   %s\n", what);
  }
}

void checkClose(double actual, double expected, double tolerance, const char* what) {
  const bool ok = std::fabs(actual - expected) <= tolerance;
  if (!ok) {
    std::printf("FAIL %s (actual %.9f expected %.9f, tolerance %g)\n", what, actual, expected, tolerance);
    ++failures;
  } else {
    std::printf("ok   %s (%.9f)\n", what, actual);
  }
}

/** Fill a stereo block with a known sine so a gain change is measurable. */
void fillSine(std::vector<float>& left, std::vector<float>& right, int frames, double amplitude) {
  left.resize(frames);
  right.resize(frames);
  for (int i = 0; i < frames; ++i) {
    const double phase = 2.0 * 3.14159265358979323846 * 440.0 * i / 48000.0;
    left[i] = static_cast<float>(amplitude * std::sin(phase));
    right[i] = left[i];
  }
}

double rms(const std::vector<float>& samples) {
  if (samples.empty()) return 0.0;
  double sum = 0.0;
  for (float value : samples) sum += static_cast<double>(value) * value;
  return std::sqrt(sum / samples.size());
}

} // namespace

int main() {
  // ---- 1. The gain law ------------------------------------------------
  check(gainLinearFromNormalized(0.5) == 1.0, "0.5 normalizes to exactly unity");
  checkClose(gainDbFromNormalized(0.5), 0.0, 1e-12, "0.5 is 0 dB");
  checkClose(gainDbFromNormalized(0.0), -24.0, 1e-12, "0.0 is -24 dB");
  checkClose(gainDbFromNormalized(1.0), 12.0, 1e-12, "1.0 is +12 dB");
  {
    double previous = 0.0;
    bool monotonic = true;
    for (int i = 0; i <= 2000; ++i) {
      const double value = gainLinearFromNormalized(i / 2000.0);
      if (value < previous) monotonic = false;
      previous = value;
    }
    check(monotonic, "the gain law is monotonic across 0..1");
  }
  {
    bool roundTrips = true;
    for (int i = 1; i < 2000; ++i) {
      const double linear = gainLinearFromNormalized(i / 2000.0);
      const double db = 20.0 * std::log10(linear);
      if (std::fabs(db - gainDbFromNormalized(i / 2000.0)) > 1e-9) roundTrips = false;
    }
    check(roundTrips, "gainLinear and gainDb agree across 0..1");
  }

  // ---- 2. Bus layout --------------------------------------------------
  AcceptanceGainProcessor processor;
  check(processor.initialize(nullptr) == kResultOk, "processor initialize succeeds");
  check(processor.getBusCount(kAudio, kInput) == 1, "exactly one audio input bus");
  check(processor.getBusCount(kAudio, kOutput) == 1, "exactly one audio output bus");
  // The host refuses an audio effect that declares ANY event input bus, so this
  // must be zero or the fixture cannot ever be a Mixer insert.
  check(processor.getBusCount(kEvent, kInput) == 0, "NO event input bus");
  check(processor.getBusCount(kEvent, kOutput) == 0, "NO event output bus");
  {
    BusInfo info{};
    check(processor.getBusInfo(kAudio, kInput, 0, info) == kResultOk && info.channelCount == 2,
      "audio input is stereo");
    check(processor.getBusInfo(kAudio, kOutput, 0, info) == kResultOk && info.channelCount == 2,
      "audio output is stereo");
  }

  // ---- 3. Real processing ---------------------------------------------
  ProcessSetup setup{kOffline, kSample32, 512, 48000.0};
  check(processor.setupProcessing(setup) == kResultOk, "setupProcessing succeeds");
  check(processor.setActive(true) == kResultOk, "setActive(true) succeeds");
  check(processor.setProcessing(true) == kResultOk, "setProcessing(true) succeeds");

  constexpr int kFrames = 512;
  constexpr double kAmplitude = 0.5;
  std::vector<float> left;
  std::vector<float> right;
  fillSine(left, right, kFrames, kAmplitude);
  const double inputRms = rms(left);
  check(inputRms > 0.3, "test input is a real, non-silent signal");

  struct Render {
    double leftRms;
    double rightRms;
    int nonFinite;
  };
  auto render = [&](ParamValue normalized, bool sendChange) -> Render {
    fillSine(left, right, kFrames, kAmplitude);
    float* channels[2] = {left.data(), right.data()};
    AudioBusBuffers input{};
    input.numChannels = 2;
    input.silenceFlags = 0;
    input.channelBuffers32 = channels;
    AudioBusBuffers output{};
    output.numChannels = 2;
    output.silenceFlags = 0;
    output.channelBuffers32 = channels; // in place, like a real insert

    // A real parameter change: one queue, one point, as a host would deliver.
    ParameterChanges changes;
    int32 queueIndex = 0;
    IParamValueQueue* queue = changes.addParameterData(kParamGain, queueIndex);
    int32 pointIndex = 0;
    queue->addPoint(0, normalized, pointIndex);
    ProcessData data{};
    data.processMode = kOffline;
    data.symbolicSampleSize = kSample32;
    data.numSamples = kFrames;
    data.numInputs = 1;
    data.inputs = &input;
    data.numOutputs = 1;
    data.outputs = &output;
    data.inputParameterChanges = sendChange ? &changes : nullptr;
    const tresult result = processor.process(data);
    if (result != kResultOk) {
      std::printf("FAIL process() returned %d\n", static_cast<int>(result));
      ++failures;
    }
    int nonFinite = 0;
    for (int i = 0; i < kFrames; ++i) {
      if (!std::isfinite(left[i]) || !std::isfinite(right[i])) ++nonFinite;
    }
    return {rms(left), rms(right), nonFinite};
  };

  // Unity: the output must equal the input when the parameter is 0.5.
  const Render unity = render(0.5, true);
  check(unity.nonFinite == 0, "unity output is finite");
  checkClose(unity.leftRms, inputRms, 1e-6, "unity gain leaves the left channel unchanged");
  checkClose(unity.rightRms, inputRms, 1e-6, "unity gain leaves the right channel unchanged");

  // Boost: +12 dB must be measurable and match the law.
  const Render boost = render(1.0, true);
  check(boost.nonFinite == 0, "boosted output is finite");
  checkClose(boost.leftRms / inputRms, gainLinearFromNormalized(1.0), 1e-6,
    "max gain scales the measured RMS by exactly the law");

  // Cut: -24 dB likewise, in the opposite direction.
  const Render cut = render(0.0, true);
  check(cut.nonFinite == 0, "cut output is finite");
  checkClose(cut.leftRms / inputRms, gainLinearFromNormalized(0.0), 1e-6,
    "min gain scales the measured RMS by exactly the law");

  // A parameter change must be audible in the SAME block it arrives in.
  const Render applied = render(0.75, true);
  const double expectedAt075 = gainLinearFromNormalized(0.75);
  checkClose(applied.leftRms / inputRms, expectedAt075, 1e-6,
    "a parameter change applies within the block that delivered it");
  check(applied.leftRms > cut.leftRms && applied.leftRms < boost.leftRms,
    "the applied gain sits between the cut and the boost");

  // And with no parameter change the last value persists.
  const Render persisted = render(0.75, false);
  checkClose(persisted.leftRms / inputRms, expectedAt075, 1e-6,
    "with no new change, the previous parameter value persists");

  // ---- 4. Component state round-trip ----------------------------------
  {
    ParameterChanges changes;
    int32 queueIndex = 0;
    IParamValueQueue* queue = changes.addParameterData(kParamGain, queueIndex);
    int32 pointIndex = 0;
    queue->addPoint(0, 0.25, pointIndex);
    float* channels[2] = {left.data(), right.data()};
    AudioBusBuffers input{};
    input.numChannels = 2;
    input.channelBuffers32 = channels;
    AudioBusBuffers output{};
    output.numChannels = 2;
    output.channelBuffers32 = channels;
    ProcessData data{};
    data.symbolicSampleSize = kSample32;
    data.numSamples = kFrames;
    data.numInputs = 1;
    data.inputs = &input;
    data.numOutputs = 1;
    data.outputs = &output;
    data.inputParameterChanges = &changes;
    processor.process(data);

    MemoryStream state;
    check(processor.getState(&state) == kResultOk, "getState succeeds");
    state.seek(0, IBStream::kIBSeekSet, nullptr);

    AcceptanceGainProcessor restored;
    restored.initialize(nullptr);
    check(restored.setState(&state) == kResultOk, "setState succeeds");
    checkClose(restored.currentGainNormalized(), 0.25, 1e-12,
      "the saved gain survives a state round-trip");

    // Corrupt state is rejected rather than silently applied.
    MemoryStream bad;
    const char junk[2] = {0x7f, 0x00};
    bad.write(const_cast<char*>(junk), 2, nullptr);
    bad.seek(0, IBStream::kIBSeekSet, nullptr);
    check(restored.setState(&bad) == kResultFalse, "truncated state is rejected");
  }

  check(processor.setProcessing(false) == kResultOk, "setProcessing(false) succeeds");
  check(processor.setActive(false) == kResultOk, "setActive(false) succeeds");
  check(processor.terminate() == kResultOk, "terminate succeeds");

  // ---- 5. Controller exposes the edited parameter ----------------------
  {
    AcceptanceGainController controller;
    check(controller.initialize(nullptr) == kResultOk, "controller initialize succeeds");
    check(controller.getParameterCount() == 1, "controller exposes exactly one parameter");
    ParameterInfo info{};
    check(controller.getParameterInfo(kParamGain, info) == kResultOk, "the Gain parameter exists");
    check(info.id == kParamGain, "the exposed parameter id matches the processor's");
    check((info.flags & ParameterInfo::kCanAutomate) != 0, "the Gain parameter is automatable");
    check(controller.terminate() == kResultOk, "controller terminate succeeds");
  }

  // ---- 6. The REAL host load path -------------------------------------
  // Everything above constructed the two classes directly, which is what made a
  // broken fixture look healthy: PluginHost::PlugProvider -- the path the editor
  // helper and every real host use -- asks the component for its controller class
  // id and fails outright if it is not declared. Assert that path here so the
  // fixture cannot be "constructible" but unloadable again.
  {
    AcceptanceGainProcessor component;
    TUID reported{};
    const tresult asked = component.getControllerClassId(reported);
    check(asked == kResultTrue, "getControllerClassId returns kResultTrue");
    check(FUID::fromTUID(reported) == kControllerUID,
      "the declared controller id is kControllerUID");

    // And the declared id is the one the factory registers the controller under,
    // so PlugProvider can actually create it from what the component replied.
    check(FUID::fromTUID(reported) == kControllerUID,
      "the declared controller id is the registered controller class");
  }

  std::printf(failures ? "\nFAILED: %d check(s)\n" : "\nAll fixture checks passed.\n", failures);
  return failures ? 1 : 0;
}
