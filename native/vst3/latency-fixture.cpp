// Deterministic Steinberg VST3 audio-effect fixtures for plugin latency
// compensation (PDC) verification. Built only when APEX_BUILD_VST3_FIXTURE=ON
// and never staged into packaged user builds.
#include "public.sdk/source/main/pluginfactory.h"
#include "public.sdk/source/vst/vstsinglecomponenteffect.h"
#include "base/source/fstreamer.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <thread>
#include <vector>

namespace ApexLatencyFixture {
using namespace Steinberg;
using namespace Steinberg::Vst;

static const FUID kLookaheadEffectUid(0x41504558, 0x4C415445, 0x4E435946, 0x58303031);
static const FUID kInvalidLatencyEffectUid(0x41504558, 0x4C415445, 0x4E435946, 0x58424144);
static const FUID kExcessiveLatencyEffectUid(0x41504558, 0x4C415445, 0x4E435946, 0x58424947);
static const FUID kDynamicLatencyEffectUid(0x41504558, 0x4C415445, 0x4E435946, 0x5844594E);
static const FUID kIoChangedEffectUid(0x41504558, 0x4C415445, 0x4E435946, 0x58494F31);

constexpr uint32 kMaxConfigurableSamples = 4096;
constexpr double kDefaultLatencyNormalized = 320.0 / 4096.0; // 320 samples by default

inline double clamp01(double value) {
  if (!std::isfinite(value)) return 0.0;
  return std::max(0.0, std::min(1.0, value));
}

inline float applyNonlinearDrive(float sample, double driveNormalized) {
  if (driveNormalized <= 1e-7) return sample;
  const double drive = 1.0 + driveNormalized * 4.0;
  const double norm = std::tanh(drive);
  return norm > 1e-9 ? static_cast<float>(std::tanh(static_cast<double>(sample) * drive) / norm) : sample;
}

class LookaheadEffect final : public SingleComponentEffect {
  enum ParamIds : ParamID {
    kParamLatency = 0,
    kParamDrive = 1,
    kParamGain = 2,
    kParamRateScale = 3,
  };
  double latencyNorm = kDefaultLatencyNormalized;
  double driveNorm = 0.0;
  double gainNorm = 0.5;
  double rateScaleNorm = 0.0;
  uint32 activeLatencySamples = 320;
  std::vector<float> delayL;
  std::vector<float> delayR;
  size_t writePos = 0;
  bool isComponentActive = false;
  bool isProcessingActive = false;

  uint32 computeTargetLatencySamples() const {
    const uint32 baseSamples = static_cast<uint32>(
      std::llround(clamp01(latencyNorm) * static_cast<double>(kMaxConfigurableSamples)));
    if (rateScaleNorm < 0.5) return baseSamples;
    const double rate = processSetup.sampleRate > 0.0 ? processSetup.sampleRate : 48000.0;
    const auto scaled = std::llround(static_cast<double>(baseSamples) * (rate / 48000.0));
    return scaled > 0 ? static_cast<uint32>(scaled) : 0u;
  }

  void rebuildDelayBuffers() {
    activeLatencySamples = computeTargetLatencySamples();
    const size_t capacity = std::max<size_t>(1, activeLatencySamples);
    delayL.assign(capacity, 0.f);
    delayR.assign(capacity, 0.f);
    writePos = 0;
  }

  tresult loadFromStream(IBStream* stream, bool syncControllerOnly) {
    if (!stream) return kInvalidArgument;
    IBStreamer reader(stream, kLittleEndian);
    uint32 version = 0;
    double savedLatency = 0.0, savedDrive = 0.0, savedGain = 0.5, savedRateScale = 0.0;
    if (!reader.readInt32u(version) || version != 1 ||
        !reader.readDouble(savedLatency) || !reader.readDouble(savedDrive) ||
        !reader.readDouble(savedGain) || !reader.readDouble(savedRateScale)) {
      return kResultFalse;
    }
    savedLatency = clamp01(savedLatency);
    savedDrive = clamp01(savedDrive);
    savedGain = clamp01(savedGain);
    savedRateScale = clamp01(savedRateScale);
    if (!syncControllerOnly) {
      latencyNorm = savedLatency;
      driveNorm = savedDrive;
      gainNorm = savedGain;
      rateScaleNorm = savedRateScale;
      if (!isProcessingActive) rebuildDelayBuffers();
    }
    SingleComponentEffect::setParamNormalized(kParamLatency, savedLatency);
    SingleComponentEffect::setParamNormalized(kParamDrive, savedDrive);
    SingleComponentEffect::setParamNormalized(kParamGain, savedGain);
    SingleComponentEffect::setParamNormalized(kParamRateScale, savedRateScale);
    return kResultOk;
  }

public:
  static FUnknown* createInstance(void*) {
    return static_cast<IAudioProcessor*>(new LookaheadEffect());
  }

  tresult PLUGIN_API initialize(FUnknown* context) override {
    const tresult result = SingleComponentEffect::initialize(context);
    if (result != kResultOk) return result;
    addAudioInput(STR16("Stereo In"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Stereo Out"), SpeakerArr::kStereo);
    parameters.addParameter(STR16("Latency"), STR16("smp"), kMaxConfigurableSamples,
      kDefaultLatencyNormalized, ParameterInfo::kCanAutomate, kParamLatency, 0, STR16("Lat"));
    parameters.addParameter(STR16("Drive"), STR16(""), 0,
      0.0, ParameterInfo::kCanAutomate, kParamDrive, 0, STR16("Drv"));
    parameters.addParameter(STR16("Gain"), STR16("x"), 0,
      0.5, ParameterInfo::kCanAutomate, kParamGain, 0, STR16("Gain"));
    parameters.addParameter(STR16("RateScale"), STR16(""), 1,
      0.0, ParameterInfo::kCanAutomate, kParamRateScale, 0, STR16("Rate"));
    rebuildDelayBuffers();
    return kResultOk;
  }

  tresult PLUGIN_API canProcessSampleSize(int32 symbolicSampleSize) override {
    return symbolicSampleSize == kSample32 ? kResultTrue : kResultFalse;
  }

  tresult PLUGIN_API setupProcessing(ProcessSetup& setup) override {
    const tresult res = SingleComponentEffect::setupProcessing(setup);
    if (res != kResultOk) return res;
    rebuildDelayBuffers();
    return kResultOk;
  }

  tresult PLUGIN_API setActive(TBool state) override {
    isComponentActive = state != 0;
    if (isComponentActive) rebuildDelayBuffers();
    else isProcessingActive = false;
    return kResultOk;
  }

  tresult PLUGIN_API setProcessing(TBool state) override {
    isProcessingActive = state != 0;
    if (isProcessingActive) {
      std::fill(delayL.begin(), delayL.end(), 0.f);
      std::fill(delayR.begin(), delayR.end(), 0.f);
      writePos = 0;
    }
    return kResultOk;
  }

  uint32 PLUGIN_API getLatencySamples() override {
    return computeTargetLatencySamples();
  }

  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue value) override {
    const double clamped = clamp01(value);
    const tresult res = SingleComponentEffect::setParamNormalized(id, clamped);
    if (res != kResultOk) return res;
    const uint32 previousLatency = computeTargetLatencySamples();
    if (id == kParamLatency) latencyNorm = clamped;
    else if (id == kParamDrive) driveNorm = clamped;
    else if (id == kParamGain) gainNorm = clamped;
    else if (id == kParamRateScale) rateScaleNorm = clamped;
    const uint32 nextLatency = computeTargetLatencySamples();
    if (nextLatency != previousLatency) {
      if (!isProcessingActive) rebuildDelayBuffers();
      if (isComponentActive && componentHandler) {
        componentHandler->restartComponent(kLatencyChanged);
      }
    }
    return kResultOk;
  }

  tresult PLUGIN_API getState(IBStream* state) override {
    if (!state) return kInvalidArgument;
    IBStreamer writer(state, kLittleEndian);
    if (!writer.writeInt32u(1) ||
        !writer.writeDouble(latencyNorm) ||
        !writer.writeDouble(driveNorm) ||
        !writer.writeDouble(gainNorm) ||
        !writer.writeDouble(rateScaleNorm)) {
      return kResultFalse;
    }
    return kResultOk;
  }

  tresult PLUGIN_API setState(IBStream* state) override {
    return loadFromStream(state, false);
  }

  tresult PLUGIN_API setComponentState(IBStream* state) override {
    return loadFromStream(state, true);
  }

  tresult PLUGIN_API process(ProcessData& data) override {
    if (data.inputParameterChanges) {
      const int32 count = data.inputParameterChanges->getParameterCount();
      for (int32 i = 0; i < count; ++i) {
        auto* queue = data.inputParameterChanges->getParameterData(i);
        if (!queue || queue->getPointCount() <= 0) continue;
        int32 sampleOffset = 0;
        ParamValue value = 0.0;
        if (queue->getPoint(queue->getPointCount() - 1, sampleOffset, value) != kResultTrue) continue;
        const double clamped = clamp01(value);
        const ParamID id = queue->getParameterId();
        if (id == kParamDrive) driveNorm = clamped;
        else if (id == kParamGain) gainNorm = clamped;
        else if (id == kParamLatency) {
          const uint32 before = computeTargetLatencySamples();
          latencyNorm = clamped;
          if (computeTargetLatencySamples() != before && componentHandler) {
            componentHandler->restartComponent(kLatencyChanged);
          }
        } else if (id == kParamRateScale) {
          const uint32 before = computeTargetLatencySamples();
          rateScaleNorm = clamped;
          if (computeTargetLatencySamples() != before && componentHandler) {
            componentHandler->restartComponent(kLatencyChanged);
          }
        }
      }
    }
    if (data.numSamples <= 0) return kResultOk;
    if (data.numInputs < 1 || data.numOutputs < 1 ||
        data.inputs[0].numChannels < 2 || data.outputs[0].numChannels < 2) {
      return kResultFalse;
    }
    const float* inL = data.inputs[0].channelBuffers32[0];
    const float* inR = data.inputs[0].channelBuffers32[1];
    float* outL = data.outputs[0].channelBuffers32[0];
    float* outR = data.outputs[0].channelBuffers32[1];
    data.outputs[0].silenceFlags = 0;
    const float gain = static_cast<float>(gainNorm * 2.0);
    const uint32 delaySamples = activeLatencySamples;
    for (int32 i = 0; i < data.numSamples; ++i) {
      const float shapedL = applyNonlinearDrive(inL[i] * gain, driveNorm);
      const float shapedR = applyNonlinearDrive(inR[i] * gain, driveNorm);
      if (delaySamples == 0) {
        outL[i] = shapedL;
        outR[i] = shapedR;
      } else {
        outL[i] = delayL[writePos];
        outR[i] = delayR[writePos];
        delayL[writePos] = shapedL;
        delayR[writePos] = shapedR;
        if (++writePos >= delaySamples) writePos = 0;
      }
    }
    return kResultOk;
  }
};

class InvalidLatencyEffect final : public SingleComponentEffect {
  double modeNorm = 0.0; // 0.0 => 0xFFFFFFFF (-1 cast to uint32), 1.0 => 250000 samples (> 1s @ 48 kHz)
public:
  static FUnknown* createInstance(void*) {
    return static_cast<IAudioProcessor*>(new InvalidLatencyEffect(0.0));
  }
  static FUnknown* createExcessiveInstance(void*) {
    return static_cast<IAudioProcessor*>(new InvalidLatencyEffect(1.0));
  }
  explicit InvalidLatencyEffect(double initialMode = 0.0) : modeNorm(initialMode) {}
  tresult PLUGIN_API initialize(FUnknown* context) override {
    const tresult res = SingleComponentEffect::initialize(context);
    if (res != kResultOk) return res;
    addAudioInput(STR16("Stereo In"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Stereo Out"), SpeakerArr::kStereo);
    parameters.addParameter(STR16("InvalidMode"), STR16(""), 1, 0.0, ParameterInfo::kCanAutomate, 0, 0, STR16("Mode"));
    return kResultOk;
  }
  tresult PLUGIN_API canProcessSampleSize(int32 symbolicSampleSize) override {
    return symbolicSampleSize == kSample32 ? kResultTrue : kResultFalse;
  }
  tresult PLUGIN_API setProcessing(TBool) override { return kResultOk; }
  uint32 PLUGIN_API getLatencySamples() override {
    return modeNorm < 0.5 ? 0xFFFFFFFFu : 250000u;
  }
  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue value) override {
    const double clamped = clamp01(value);
    const tresult res = SingleComponentEffect::setParamNormalized(id, clamped);
    if (res == kResultOk && id == 0) modeNorm = clamped;
    return res;
  }
  tresult PLUGIN_API getState(IBStream* state) override {
    if (!state) return kInvalidArgument;
    IBStreamer writer(state, kLittleEndian);
    return (writer.writeInt32u(1) && writer.writeDouble(modeNorm)) ? kResultOk : kResultFalse;
  }
  tresult PLUGIN_API setState(IBStream* state) override {
    if (!state) return kInvalidArgument;
    IBStreamer reader(state, kLittleEndian);
    uint32 version = 0;
    double savedMode = 0.0;
    if (!reader.readInt32u(version) || version != 1 || !reader.readDouble(savedMode)) return kResultFalse;
    modeNorm = clamp01(savedMode);
    SingleComponentEffect::setParamNormalized(0, modeNorm);
    return kResultOk;
  }
  tresult PLUGIN_API setComponentState(IBStream* state) override { return setState(state); }
  tresult PLUGIN_API process(ProcessData& data) override {
    if (data.numSamples <= 0) return kResultOk;
    for (int32 c = 0; c < 2; ++c) {
      std::copy_n(data.inputs[0].channelBuffers32[c], data.numSamples, data.outputs[0].channelBuffers32[c]);
    }
    data.outputs[0].silenceFlags = 0;
    return kResultOk;
  }
};

class DynamicLatencyEffect final : public SingleComponentEffect {
  double autoChangeNorm = 1.0;
  uint32 reportedLatency = 256;
  int64_t processedAudioBlocks = 0;
public:
  static FUnknown* createInstance(void*) {
    return static_cast<IAudioProcessor*>(new DynamicLatencyEffect());
  }
  tresult PLUGIN_API initialize(FUnknown* context) override {
    const tresult res = SingleComponentEffect::initialize(context);
    if (res != kResultOk) return res;
    addAudioInput(STR16("Stereo In"), SpeakerArr::kStereo);
    addAudioOutput(STR16("Stereo Out"), SpeakerArr::kStereo);
    parameters.addParameter(STR16("AutoChangeMidstream"), STR16(""), 1, 1.0, ParameterInfo::kCanAutomate, 0, 0, STR16("Auto"));
    return kResultOk;
  }
  tresult PLUGIN_API canProcessSampleSize(int32 symbolicSampleSize) override {
    return symbolicSampleSize == kSample32 ? kResultTrue : kResultFalse;
  }
  tresult PLUGIN_API setActive(TBool state) override {
    if (state) {
      reportedLatency = 256;
      processedAudioBlocks = 0;
    }
    return kResultOk;
  }
  tresult PLUGIN_API setProcessing(TBool state) override {
    if (state) processedAudioBlocks = 0;
    return kResultOk;
  }
  uint32 PLUGIN_API getLatencySamples() override { return reportedLatency; }
  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue value) override {
    const double clamped = clamp01(value);
    const tresult res = SingleComponentEffect::setParamNormalized(id, clamped);
    if (res == kResultOk && id == 0) autoChangeNorm = clamped;
    return res;
  }
  tresult PLUGIN_API getState(IBStream* state) override {
    if (!state) return kInvalidArgument;
    IBStreamer writer(state, kLittleEndian);
    return (writer.writeInt32u(1) && writer.writeDouble(autoChangeNorm)) ? kResultOk : kResultFalse;
  }
  tresult PLUGIN_API setState(IBStream* state) override {
    if (!state) return kInvalidArgument;
    IBStreamer reader(state, kLittleEndian);
    uint32 version = 0;
    double saved = 1.0;
    if (!reader.readInt32u(version) || version != 1 || !reader.readDouble(saved)) return kResultFalse;
    autoChangeNorm = clamp01(saved);
    SingleComponentEffect::setParamNormalized(0, autoChangeNorm);
    return kResultOk;
  }
  tresult PLUGIN_API setComponentState(IBStream* state) override { return setState(state); }
  tresult PLUGIN_API process(ProcessData& data) override {
    if (data.numSamples <= 0) return kResultOk;
    ++processedAudioBlocks;
    // Note: inspectEffect runs a single 1-sample flush (numSamples == 1); real
    // live and offline streams process multi-sample audio blocks (numSamples > 1).
    if (autoChangeNorm >= 0.5 && data.numSamples > 1 && processedAudioBlocks >= 2 && reportedLatency == 256) {
      reportedLatency = 512;
      if (componentHandler) componentHandler->restartComponent(kLatencyChanged);
    }
    for (int32 c = 0; c < 2; ++c) {
      std::copy_n(data.inputs[0].channelBuffers32[c], data.numSamples, data.outputs[0].channelBuffers32[c]);
    }
    data.outputs[0].silenceFlags = 0;
    return kResultOk;
  }
};

// Deterministic I/O reconfiguration & concurrent restart-flag fixture:
//   IoScenario = 0 (0.00): Stereo 1 in / 1 out, latency = 192 samples
//   IoScenario = 1 (0.25): Concurrent dual-thread restartComponent(kIoChanged) +
//                          restartComponent(kLatencyChanged) -> rebuilds Stereo 1 in / 1 out
//                          buses while deactivated (latency = 384 samples) and strictly fails
//                          setActive(true) unless the host re-queried bus info, re-activated
//                          both rebuilt buses, and re-ran setupProcessing().
//   IoScenario = 2 (0.50): Raises kIoChanged and reconfigures to unsupported Mono (1 ch in/out)
//   IoScenario = 3 (0.75): Raises kIoChanged and reconfigures to unsupported 2-input (sidechain)
//   IoScenario = 4 (1.00): Raises kIoChanged mid-stream during active process() on block >= 2
class IoChangedEffect final : public SingleComponentEffect {
  int scenario = 0;
  int appliedBusScenario = 0;
  uint32 activeLatencySamples = 192;
  std::vector<float> delayL;
  std::vector<float> delayR;
  size_t writePos = 0;
  bool isComponentActive = false;
  bool requiresFullHostIoReconfigure = false;
  bool busInfoQueriedSinceDeactivate = false;
  bool busArrangementsAppliedSinceDeactivate = false;
  bool setupProcessingSinceDeactivate = false;
  AudioBus* currentMainInBus = nullptr;
  AudioBus* currentMainOutBus = nullptr;
  int64_t processedAudioBlocks = 0;
  bool midstreamRaised = false;

  static int decodeScenario(double norm) {
    return std::max(0, std::min(4, static_cast<int>(std::llround(clamp01(norm) * 4.0))));
  }

  uint32 targetLatencyForScenario(int sc) const {
    return sc == 1 ? 384u : 192u;
  }

  void rebuildDelayLine(uint32 samples) {
    activeLatencySamples = samples;
    const size_t cap = std::max<size_t>(1, samples);
    delayL.assign(cap, 0.f);
    delayR.assign(cap, 0.f);
    writePos = 0;
  }

  void rebuildBusesForScenario(int sc) {
    removeAudioBusses();
    currentMainInBus = nullptr;
    currentMainOutBus = nullptr;
    if (sc == 2) {
      currentMainInBus = addAudioInput(STR16("Mono In"), SpeakerArr::kMono);
      currentMainOutBus = addAudioOutput(STR16("Mono Out"), SpeakerArr::kMono);
    } else if (sc == 3) {
      currentMainInBus = addAudioInput(STR16("Stereo Main In"), SpeakerArr::kStereo);
      addAudioInput(STR16("Stereo Sidechain In"), SpeakerArr::kStereo, kAux);
      currentMainOutBus = addAudioOutput(STR16("Stereo Main Out"), SpeakerArr::kStereo);
    } else {
      currentMainInBus = addAudioInput(STR16("Stereo In"), SpeakerArr::kStereo);
      currentMainOutBus = addAudioOutput(STR16("Stereo Out"), SpeakerArr::kStereo);
    }
    appliedBusScenario = sc;
  }

  void emitConcurrentIoAndLatencyFlags() {
    if (!componentHandler) return;
    std::atomic<int> ready{0};
    std::atomic<bool> go{false};
    std::thread tIo([&]() {
      ready.fetch_add(1, std::memory_order_acq_rel);
      while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
      componentHandler->restartComponent(kIoChanged);
    });
    std::thread tLat([&]() {
      ready.fetch_add(1, std::memory_order_acq_rel);
      while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
      componentHandler->restartComponent(kLatencyChanged);
    });
    while (ready.load(std::memory_order_acquire) < 2) std::this_thread::yield();
    go.store(true, std::memory_order_release);
    tIo.join();
    tLat.join();
  }

public:
  static FUnknown* createInstance(void*) {
    return static_cast<IAudioProcessor*>(new IoChangedEffect());
  }

  tresult PLUGIN_API initialize(FUnknown* context) override {
    const tresult res = SingleComponentEffect::initialize(context);
    if (res != kResultOk) return res;
    rebuildBusesForScenario(0);
    parameters.addParameter(STR16("IoScenario"), STR16(""), 4, 0.0,
      ParameterInfo::kCanAutomate, 0, 0, STR16("IO"));
    rebuildDelayLine(192);
    return kResultOk;
  }

  tresult PLUGIN_API canProcessSampleSize(int32 symbolicSampleSize) override {
    return symbolicSampleSize == kSample32 ? kResultTrue : kResultFalse;
  }

  tresult PLUGIN_API getBusInfo(MediaType type, BusDirection dir, int32 index, BusInfo& info) override {
    if (!isComponentActive) busInfoQueriedSinceDeactivate = true;
    return SingleComponentEffect::getBusInfo(type, dir, index, info);
  }

  tresult PLUGIN_API setBusArrangements(SpeakerArrangement* inputs, int32 numIns,
                                        SpeakerArrangement* outputs, int32 numOuts) override {
    if (appliedBusScenario == 2) {
      if (numIns != 1 || numOuts != 1 || !inputs || !outputs ||
          inputs[0] != SpeakerArr::kMono || outputs[0] != SpeakerArr::kMono) {
        return kResultFalse;
      }
    } else if (appliedBusScenario == 3) {
      if (numIns != 2 || numOuts != 1) return kResultFalse;
    } else {
      if (numIns != 1 || numOuts != 1 || !inputs || !outputs ||
          inputs[0] != SpeakerArr::kStereo || outputs[0] != SpeakerArr::kStereo) {
        return kResultFalse;
      }
    }
    const tresult res = SingleComponentEffect::setBusArrangements(inputs, numIns, outputs, numOuts);
    if (res == kResultOk && !isComponentActive) {
      busArrangementsAppliedSinceDeactivate = true;
    }
    return res;
  }

  tresult PLUGIN_API setupProcessing(ProcessSetup& newSetup) override {
    const tresult res = SingleComponentEffect::setupProcessing(newSetup);
    if (res == kResultOk && !isComponentActive) {
      setupProcessingSinceDeactivate = true;
    }
    return res;
  }

  tresult PLUGIN_API setActive(TBool state) override {
    const tresult res = SingleComponentEffect::setActive(state);
    if (res != kResultOk) return res;
    if (!state) {
      isComponentActive = false;
      busInfoQueriedSinceDeactivate = false;
      busArrangementsAppliedSinceDeactivate = false;
      setupProcessingSinceDeactivate = false;
      if (scenario == 1 || scenario == 2 || scenario == 3) {
        rebuildBusesForScenario(scenario);
      }
      return kResultOk;
    }
    if (requiresFullHostIoReconfigure) {
      if (!busInfoQueriedSinceDeactivate || !busArrangementsAppliedSinceDeactivate ||
          !setupProcessingSinceDeactivate || !currentMainInBus || !currentMainOutBus ||
          !currentMainInBus->isActive() || !currentMainOutBus->isActive()) {
        return kResultFalse;
      }
      requiresFullHostIoReconfigure = false;
    }
    isComponentActive = true;
    processedAudioBlocks = 0;
    midstreamRaised = false;
    rebuildDelayLine(targetLatencyForScenario(scenario));
    return kResultOk;
  }

  tresult PLUGIN_API setProcessing(TBool state) override {
    if (state) {
      processedAudioBlocks = 0;
      midstreamRaised = false;
    }
    return kResultOk;
  }

  uint32 PLUGIN_API getLatencySamples() override {
    return activeLatencySamples;
  }

  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue value) override {
    const double clamped = clamp01(value);
    const tresult res = SingleComponentEffect::setParamNormalized(id, clamped);
    if (res != kResultOk || id != 0) return res;
    const int nextScenario = decodeScenario(clamped);
    if (nextScenario == scenario) return kResultOk;
    scenario = nextScenario;
    if (!isComponentActive) {
      if (scenario == 1 || scenario == 2 || scenario == 3) {
        rebuildBusesForScenario(scenario);
      } else if (appliedBusScenario != 0) {
        rebuildBusesForScenario(0);
      }
      rebuildDelayLine(targetLatencyForScenario(scenario));
      return kResultOk;
    }
    if (scenario == 1) {
      requiresFullHostIoReconfigure = true;
      emitConcurrentIoAndLatencyFlags();
    } else if (scenario == 2 || scenario == 3) {
      requiresFullHostIoReconfigure = true;
      if (componentHandler) componentHandler->restartComponent(kIoChanged);
    } else if (scenario == 0 && appliedBusScenario != 0) {
      requiresFullHostIoReconfigure = true;
      emitConcurrentIoAndLatencyFlags();
    }
    return kResultOk;
  }

  tresult PLUGIN_API getState(IBStream* state) override {
    if (!state) return kInvalidArgument;
    IBStreamer writer(state, kLittleEndian);
    return (writer.writeInt32u(1) && writer.writeInt32(scenario)) ? kResultOk : kResultFalse;
  }

  tresult PLUGIN_API setState(IBStream* state) override {
    if (!state) return kInvalidArgument;
    IBStreamer reader(state, kLittleEndian);
    uint32 version = 0;
    int32 savedScenario = 0;
    if (!reader.readInt32u(version) || version != 1 || !reader.readInt32(savedScenario)) {
      return kResultFalse;
    }
    scenario = std::max(0, std::min(4, static_cast<int>(savedScenario)));
    SingleComponentEffect::setParamNormalized(0, static_cast<double>(scenario) / 4.0);
    if (!isComponentActive) {
      rebuildBusesForScenario(scenario);
      rebuildDelayLine(targetLatencyForScenario(scenario));
    }
    return kResultOk;
  }

  tresult PLUGIN_API setComponentState(IBStream* state) override {
    return setState(state);
  }

  tresult PLUGIN_API process(ProcessData& data) override {
    if (data.numSamples <= 0) return kResultOk;
    if (data.numInputs < 1 || data.numOutputs < 1 ||
        data.inputs[0].numChannels < 2 || data.outputs[0].numChannels < 2) {
      return kResultFalse;
    }
    ++processedAudioBlocks;
    if (scenario == 4 && data.numSamples > 1 && processedAudioBlocks >= 2 && !midstreamRaised) {
      midstreamRaised = true;
      if (componentHandler) componentHandler->restartComponent(kIoChanged);
    }
    const float* inL = data.inputs[0].channelBuffers32[0];
    const float* inR = data.inputs[0].channelBuffers32[1];
    float* outL = data.outputs[0].channelBuffers32[0];
    float* outR = data.outputs[0].channelBuffers32[1];
    data.outputs[0].silenceFlags = 0;
    const uint32 delaySamples = activeLatencySamples;
    for (int32 i = 0; i < data.numSamples; ++i) {
      outL[i] = delayL[writePos];
      outR[i] = delayR[writePos];
      delayL[writePos] = inL[i];
      delayR[writePos] = inR[i];
      if (++writePos >= delaySamples) writePos = 0;
    }
    return kResultOk;
  }
};

} // namespace ApexLatencyFixture

BEGIN_FACTORY_DEF("Apex Studio Test Fixtures", "https://github.com/Ajey877/Apex-Studio", "mailto:noreply@example.com")
  DEF_CLASS2(INLINE_UID_FROM_FUID(ApexLatencyFixture::kLookaheadEffectUid),
    PClassInfo::kManyInstances, kVstAudioEffectClass, "Apex Latency Fixture",
    Steinberg::Vst::kDistributable, Steinberg::Vst::PlugType::kFx, "1.0.0", kVstVersionString,
    ApexLatencyFixture::LookaheadEffect::createInstance)
  DEF_CLASS2(INLINE_UID_FROM_FUID(ApexLatencyFixture::kInvalidLatencyEffectUid),
    PClassInfo::kManyInstances, kVstAudioEffectClass, "Apex Invalid Latency Fixture",
    Steinberg::Vst::kDistributable, Steinberg::Vst::PlugType::kFx, "1.0.0", kVstVersionString,
    ApexLatencyFixture::InvalidLatencyEffect::createInstance)
  DEF_CLASS2(INLINE_UID_FROM_FUID(ApexLatencyFixture::kExcessiveLatencyEffectUid),
    PClassInfo::kManyInstances, kVstAudioEffectClass, "Apex Excessive Latency Fixture",
    Steinberg::Vst::kDistributable, Steinberg::Vst::PlugType::kFx, "1.0.0", kVstVersionString,
    ApexLatencyFixture::InvalidLatencyEffect::createExcessiveInstance)
  DEF_CLASS2(INLINE_UID_FROM_FUID(ApexLatencyFixture::kDynamicLatencyEffectUid),
    PClassInfo::kManyInstances, kVstAudioEffectClass, "Apex Dynamic Latency Fixture",
    Steinberg::Vst::kDistributable, Steinberg::Vst::PlugType::kFx, "1.0.0", kVstVersionString,
    ApexLatencyFixture::DynamicLatencyEffect::createInstance)
  DEF_CLASS2(INLINE_UID_FROM_FUID(ApexLatencyFixture::kIoChangedEffectUid),
    PClassInfo::kManyInstances, kVstAudioEffectClass, "Apex IoChanged Fixture",
    Steinberg::Vst::kDistributable, Steinberg::Vst::PlugType::kFx, "1.0.0", kVstVersionString,
    ApexLatencyFixture::IoChangedEffect::createInstance)
END_FACTORY
