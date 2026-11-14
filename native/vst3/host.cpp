// Apex native VST3 integration prototype. Plugins run only in this helper.
// This is NOT an OS security sandbox and is not connected to the shipped DAW.
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/base/keycodes.h"
#include "component-handler.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <windowsx.h>
#include <objbase.h>
#include <fcntl.h>
#include <io.h>
#include <mutex>
#endif

using ApexVst3Host::HostComponentHandler;
using namespace Steinberg;
using namespace Steinberg::Vst;
using json = nlohmann::json;
constexpr int kMaxBlock = 16384;
constexpr size_t kMaxRequest = 8 * 1024 * 1024;
constexpr double kMaxEffectLatencySeconds = 1.0;
constexpr int32 kStructuralRestartMask =
  RestartFlags::kReloadComponent | RestartFlags::kIoChanged | RestartFlags::kLatencyChanged;

uint32_t maxEffectLatencySamples(double sampleRate) {
  const auto bound = std::llround(std::floor(sampleRate * kMaxEffectLatencySeconds));
  return bound > 0 ? static_cast<uint32_t>(bound) : 0u;
}

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}
void checked(tresult result, const std::string& message) {
  require(result == kResultOk, message + " (VST result " + std::to_string(result) + ")");
}
// IAudioProcessor::setProcessing is advisory in the VST3 contract: the interface
// documents what the call means but assigns no failure semantics, and the SDK's
// own AudioEffect base implements it as `return kNotImplemented;` (the
// DataExchange sample inherits that verbatim). Treating kNotImplemented as fatal
// rejects conformant plug-ins, so any accepted or merely unimplemented result
// passes while a genuine error still fails the operation.
void checkedProcessing(tresult result, const std::string& message) {
  require(result == kResultOk || result == kNotImplemented,
    message + " (VST result " + std::to_string(result) + ")");
}
int integer(const json& object, const char* key, int low, int high) {
  require(object.contains(key) && object.at(key).is_number_integer(), std::string(key) + " must be an integer");
  auto value = object.at(key).get<int64_t>();
  require(value >= low && value <= high, std::string(key) + " out of range");
  return static_cast<int>(value);
}
double real(const json& object, const char* key, double low, double high) {
  double value = object.at(key).get<double>();
  require(std::isfinite(value) && value >= low && value <= high, std::string(key) + " out of range");
  return value;
}
std::string hex(const char* data, size_t size) {
  require(size <= 1024 * 1024, "Plugin state exceeds prototype limit (1 MiB per stream)");
  constexpr char digits[] = "0123456789abcdef";
  std::string result(size * 2, '0');
  for (size_t i = 0; i < size; ++i) {
    auto c = static_cast<unsigned char>(data[i]);
    result[i * 2] = digits[c >> 4]; result[i * 2 + 1] = digits[c & 15];
  }
  return result;
}
std::vector<char> unhex(const std::string& value) {
  require(value.size() % 2 == 0 && value.size() <= 2 * 1024 * 1024, "Invalid or oversized state encoding");
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    throw std::runtime_error("Invalid state hex digit");
  };
  std::vector<char> result(value.size() / 2);
  for (size_t i = 0; i < result.size(); ++i) result[i] = static_cast<char>((nibble(value[i * 2]) << 4) | nibble(value[i * 2 + 1]));
  return result;
}
bool instrument(const VST3::Hosting::ClassInfo& info) {
  const auto& categories = info.subCategories();
  return info.category() == kVstAudioEffectClass &&
    std::find(categories.begin(), categories.end(), "Instrument") != categories.end();
}
bool audioEffect(const VST3::Hosting::ClassInfo& info) {
  if (info.category() != kVstAudioEffectClass || instrument(info)) return false;
  const auto& categories = info.subCategories();
  return std::find(categories.begin(), categories.end(), "Generator") == categories.end() &&
    std::find(categories.begin(), categories.end(), "Analyzer") == categories.end();
}
json identity(const VST3::Hosting::ClassInfo& info) {
  return {{"classId", info.ID().toString()}, {"name", info.name()},
    {"vendor", info.vendor()}, {"version", info.version()}, {"categories", info.subCategories()}};
}
std::vector<float> decodePlanarAudio(const std::string& encoded, int frames) {
  static const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  require(encoded.size() <= 180000 && encoded.size() % 4 == 0, "Invalid or oversized VST3 audio block");
  std::vector<unsigned char> bytes;
  bytes.reserve(encoded.size() / 4 * 3);
  for (size_t i = 0; i < encoded.size(); i += 4) {
    uint32_t value = 0;
    int padding = 0;
    for (int j = 0; j < 4; ++j) {
      const char c = encoded[i + j];
      if (c == '=') { ++padding; value <<= 6; }
      else {
        require(padding == 0, "Invalid base64 audio padding");
        const auto digit = alphabet.find(c);
        require(digit != std::string::npos, "Invalid base64 audio data");
        value = (value << 6) | static_cast<uint32_t>(digit);
      }
    }
    require(padding <= 2 && (padding == 0 || i + 4 == encoded.size()), "Invalid base64 audio padding");
    bytes.push_back(static_cast<unsigned char>((value >> 16) & 255));
    if (padding < 2) bytes.push_back(static_cast<unsigned char>((value >> 8) & 255));
    if (padding < 1) bytes.push_back(static_cast<unsigned char>(value & 255));
  }
  require(bytes.size() == static_cast<size_t>(frames) * 2 * sizeof(float), "VST3 audio block must contain planar stereo float32 samples");
  std::vector<float> result(frames * 2);
  std::memcpy(result.data(), bytes.data(), bytes.size());
  for (float sample : result) require(std::isfinite(sample), "Non-finite VST3 input audio");
  return result;
}

#ifdef _WIN32
#include "editor-host.hpp"
#endif

class Instance {
  // Declaration order matters: SDK objects are released BEFORE the module unloads.
  IPtr<HostApplication> host = owned(new HostApplication());
  IPtr<HostComponentHandler> componentHandler = owned(new HostComponentHandler());
  VST3::Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IEditController> controller;
  IPtr<IAudioProcessor> processor;
  HostProcessData data;
  EventList events{4096};
  EventList outputEvents{4096};
  ParameterChanges parameters{4096};
  ParameterChanges outputParameters{4096};
  std::vector<ParameterInfo> parameterInfo;
  std::set<ParamID> parameterIds;
  std::set<ParamID> readOnlyIds;
  std::map<ParamID, ParamValue> overrides;
  std::map<ParamID, ParamValue> pendingEffectParameters;
  std::string classId;
  double sampleRate = 48000;
  int mode = kOffline;
  int64_t cursor = 0;
  uint32_t configuredLatencySamples = 0;
  bool active = false;
  bool processing = false;
  bool isInstrument = true;

  uint32_t validateLatencySamples(uint32_t latency) const {
    if (isInstrument) {
      require(latency == 0, "VST3 instrument reports " + std::to_string(latency) +
        " samples of latency; this host path currently supports zero-reported-latency instruments only");
      return 0;
    }
    const auto maxSamples = maxEffectLatencySamples(sampleRate);
    require(latency <= maxSamples, "VST3 effect reports invalid or excessive latency (" +
      std::to_string(latency) + " samples; maximum supported is " + std::to_string(maxSamples) +
      " samples at " + std::to_string(static_cast<int>(std::llround(sampleRate))) + " Hz)");
    return latency;
  }
  void validateBusContract() {
    const auto inputBuses = component->getBusCount(kAudio, kInput);
    const auto outputBuses = component->getBusCount(kAudio, kOutput);
    const auto eventInputBuses = component->getBusCount(kEvent, kInput);
    if (isInstrument) {
      require(inputBuses == 0, "Instrument class unexpectedly requires audio input");
      require(outputBuses >= 1 && eventInputBuses >= 1,
        "Instrument requires an audio output and event input");
      BusInfo bus{};
      checked(component->getBusInfo(kAudio, kOutput, 0, bus), "Cannot query main output bus");
      require(bus.busType == kMain && (bus.channelCount == 1 || bus.channelCount == 2),
        "Only mono/stereo instrument output supported");
    } else {
      require(inputBuses == 1 && outputBuses == 1,
        "Only one-input/one-output VST3 audio effects are supported");
      BusInfo input{}, output{};
      checked(component->getBusInfo(kAudio, kInput, 0, input), "Cannot query main input bus");
      checked(component->getBusInfo(kAudio, kOutput, 0, output), "Cannot query main output bus");
      require(input.busType == kMain && output.busType == kMain &&
        input.channelCount == 2 && output.channelCount == 2,
        "Only effects with a stereo main input and stereo main output are supported");
      SpeakerArrangement inArr = 0, outArr = 0;
      if (processor->getBusArrangement(kInput, 0, inArr) == kResultOk) {
        require(inArr == SpeakerArr::kStereo,
          "Only stereo input speaker arrangement (kStereo) is supported for VST3 effects");
      }
      if (processor->getBusArrangement(kOutput, 0, outArr) == kResultOk) {
        require(outArr == SpeakerArr::kStereo,
          "Only stereo output speaker arrangement (kStereo) is supported for VST3 effects");
      }
      require(eventInputBuses == 0, "VST3 audio effects with event input buses are not supported");
    }
  }

  void assertPreparedProcessDataMatchesContract() const {
    require(data.numOutputs >= 1 && data.outputs != nullptr && data.outputs[0].numChannels >= 1,
      "Prepared HostProcessData has no valid main output bus");
    if (!isInstrument) {
      require(data.numInputs == 1 && data.numOutputs == 1 &&
        data.inputs != nullptr &&
        data.inputs[0].numChannels == 2 && data.outputs[0].numChannels == 2,
        "Prepared HostProcessData does not match stereo effect contract");
    }
  }

  void configureBusesAndSetup(bool prepareProcessData) {
    validateBusContract();
    if (!isInstrument) {
      SpeakerArrangement stereoIn = SpeakerArr::kStereo;
      SpeakerArrangement stereoOut = SpeakerArr::kStereo;
      const auto arrangeRes = processor->setBusArrangements(&stereoIn, 1, &stereoOut, 1);
      require(arrangeRes == kResultOk || arrangeRes == kNotImplemented,
        "Plugin rejected stereo bus arrangement (VST result " + std::to_string(arrangeRes) + ")");
    }
    const auto inputBuses = component->getBusCount(kAudio, kInput);
    const auto outputBuses = component->getBusCount(kAudio, kOutput);
    const auto eventInputBuses = component->getBusCount(kEvent, kInput);
    for (int32 i = 0; i < inputBuses; ++i)
      checked(component->activateBus(kAudio, kInput, i, i == 0), "Cannot configure audio input bus");
    for (int32 i = 0; i < outputBuses; ++i)
      checked(component->activateBus(kAudio, kOutput, i, i == 0), "Cannot configure audio output bus");
    for (int32 i = 0; i < eventInputBuses; ++i)
      checked(component->activateBus(kEvent, kInput, i, i == 0), "Cannot configure MIDI input bus");
    ProcessSetup setup{mode, kSample32, kMaxBlock, sampleRate};
    checked(processor->setupProcessing(setup), "setupProcessing failed");
    if (prepareProcessData) {
      data.unprepare();
      require(data.prepare(*component, kMaxBlock, kSample32), "HostProcessData preparation failed");
      assertPreparedProcessDataMatchesContract();
    }
  }

  void reconfigureActiveComponent(int32 flags, const char* contextLabel) {
    require((flags & RestartFlags::kReloadComponent) == 0,
      std::string("VST3 plugin requested full component reload (kReloadComponent) during ") +
      contextLabel + ", which is unsupported");
    checkedProcessing(processor->setProcessing(false), std::string("Cannot suspend processing (") + contextLabel + ")");
    processing = false;
    checked(component->setActive(false), std::string("Cannot deactivate component (") + contextLabel + ")");
    active = false;
    if ((flags & RestartFlags::kIoChanged) != 0) {
      data.unprepare();
      configureBusesAndSetup(true);
    }
    checked(component->setActive(true), std::string("Cannot reactivate component (") + contextLabel + ")");
    active = true;
    checkedProcessing(processor->setProcessing(true), std::string("Cannot resume processing (") + contextLabel + ")");
    processing = true;
    const int32 postFlags = componentHandler->consumeRestartFlags();
    require((postFlags & kStructuralRestartMask) == 0,
      std::string("VST3 plugin raised recursive structural restart flags (") +
      std::to_string(postFlags) + ") during " + contextLabel);
  }

  void assertNoActiveProcessRestartFlags(int32 restartFlags) const {
    require((restartFlags & RestartFlags::kReloadComponent) == 0,
      "VST3 plugin requested full component reload (kReloadComponent) during active processing");
    require((restartFlags & RestartFlags::kIoChanged) == 0,
      "VST3 plugin requested I/O bus reconfiguration (kIoChanged) during active processing; dynamic bus changes are unsupported");
    const uint32_t currentLatency = validateLatencySamples(processor->getLatencySamples());
    require((restartFlags & RestartFlags::kLatencyChanged) == 0 &&
      currentLatency == configuredLatencySamples,
      "VST3 plugin changed reported latency during active processing (" +
      std::to_string(configuredLatencySamples) + " -> " + std::to_string(currentLatency) +
      " samples); stop and restart playback to recompute Mixer delay compensation");
  }
public:
  ~Instance() {
    if (processing) processor->setProcessing(false);
    if (active) component->setActive(false);
    if (controller) controller->setComponentHandler(nullptr);
    data.unprepare();
    processor = nullptr;
    controller = nullptr;
    component = nullptr;
    provider = nullptr; // PlugProvider disconnects and terminates both components.
    componentHandler = nullptr;
    module.reset();
    PluginContextFactory::instance().setPluginContext(nullptr);
  }
  json open(const json& request) {
    std::string error;
    module = VST3::Hosting::Module::create(request.at("path").get<std::string>(), error);
    require(bool(module), "Plugin module load failed: " + error);
    classId = request.at("classId").get<std::string>();
    const auto factory = module->getFactory();
    factory.setHostContext(host);
    PluginContextFactory::instance().setPluginContext(host);
    json result;
    for (const auto& info : factory.classInfos()) {
      if (info.ID().toString() != classId) continue;
      const auto kind = request.value("kind", std::string("instrument"));
      require(kind == "instrument" || kind == "effect", "Unknown VST3 plugin kind");
      isInstrument = kind == "instrument";
      require(isInstrument ? instrument(info) : audioEffect(info), isInstrument ? "Selected class is not a VST3 instrument" : "Selected class is not a VST3 audio effect");
      provider = owned(new PlugProvider(factory, info, true));
      require(provider->initialize(), "Plugin component/controller initialization failed");
      result = identity(info);
      break;
    }
    require(bool(provider), "Saved instrument class ID is not present in this module");
    component = provider->getComponentPtr();
    controller = provider->getControllerPtr();
    if (controller) {
      const auto handlerResult = controller->setComponentHandler(componentHandler);
      require(handlerResult == kResultOk || handlerResult == kNotImplemented,
        "setComponentHandler failed (VST result " + std::to_string(handlerResult) + ")");
    }
    processor = FUnknownPtr<IAudioProcessor>(component);
    require(bool(processor), "Plugin has no IAudioProcessor");
    checked(processor->canProcessSampleSize(kSample32), "Plugin does not support float32 processing");
    sampleRate = real(request, "sampleRate", 8000, 192000);
    const auto modeName = request.value("mode", std::string("offline"));
    require(modeName == "offline" || modeName == "realtime", "Unknown processing mode");
    mode = modeName == "offline" ? kOffline : kRealtime;
    configureBusesAndSetup(false);
    if (controller) {
      const auto count = controller->getParameterCount();
      require(count >= 0 && count <= 4096, "Too many plugin parameters");
      for (int32 i = 0; i < count; ++i) {
        ParameterInfo info{};
        checked(controller->getParameterInfo(i, info), "Cannot query plugin parameter");
        require(parameterIds.insert(info.id).second, "Duplicate plugin parameter ID");
        require(std::isfinite(info.defaultNormalizedValue) && info.defaultNormalizedValue >= 0 && info.defaultNormalizedValue <= 1 && info.stepCount >= 0, "Invalid plugin parameter metadata");
        parameterInfo.push_back(info);
        if (info.flags & ParameterInfo::kIsReadOnly) readOnlyIds.insert(info.id);
      }
    }
    if (request.contains("state")) restore(request.at("state"));
    else if (controller) {
      MemoryStream stream;
      if (component->getState(&stream) == kResultOk) {
        stream.seek(0, IBStream::kIBSeekSet, nullptr);
        // Optional for some plugins; required on restore when component state exists.
        controller->setComponentState(&stream);
      }
    }
    const int32 preActiveFlags = componentHandler->consumeRestartFlags();
    require((preActiveFlags & RestartFlags::kReloadComponent) == 0,
      "VST3 plugin requested full component reload (kReloadComponent) during state restore, which is unsupported");
    if ((preActiveFlags & RestartFlags::kIoChanged) != 0) {
      configureBusesAndSetup(true);
    } else {
      validateBusContract();
      require(data.prepare(*component, kMaxBlock, kSample32), "HostProcessData preparation failed");
      assertPreparedProcessDataMatchesContract();
    }
    checked(component->setActive(true), "setActive failed"); active = true;
    checkedProcessing(processor->setProcessing(true), "setProcessing failed"); processing = true;
    // Component/controller streams are restored while inactive. Apply saved
    // normalized overrides after activation so effect processors and controller
    // metadata reflect authoritative saved values before the first live block.
    if (!isInstrument && request.contains("state") && request.at("state").contains("parameters"))
      applyParameters(request.at("state").at("parameters"), false, -1, false);
    const int32 setupFlags = componentHandler->consumeRestartFlags();
    if ((setupFlags & kStructuralRestartMask) != 0)
      reconfigureActiveComponent(setupFlags, "open setup");
    configuredLatencySamples = validateLatencySamples(processor->getLatencySamples());
    result["parameters"] = metadata();
    result["controllerAvailable"] = bool(controller);
    result["latencySamples"] = configuredLatencySamples;
    result["tailSamples"] = processor->getTailSamples();
    return result;
  }
  bool isInstrumentKind() const { return isInstrument; }
  uint32_t latencySamples() const { return configuredLatencySamples; }
  uint32_t reconcileParameterRestartAndLatency() {
    const int32 flags = componentHandler->consumeRestartFlags();
    require((flags & RestartFlags::kReloadComponent) == 0,
      "VST3 effect requested full component reload (kReloadComponent) after parameter update, which is unsupported");
    const bool ioChanged = (flags & RestartFlags::kIoChanged) != 0;
    const bool latencyFlagged = (flags & RestartFlags::kLatencyChanged) != 0;
    const uint32_t nextLatency = validateLatencySamples(processor->getLatencySamples());
    if (!ioChanged && !latencyFlagged && nextLatency == configuredLatencySamples) {
      return configuredLatencySamples;
    }
    if (ioChanged && mode != kOffline) {
      throw std::runtime_error(
        "VST3 effect requested I/O bus reconfiguration (kIoChanged) on an active live session; "
        "stop playback to reconfigure");
    }
    require(mode == kOffline, "VST3 effect changed reported latency (" +
      std::to_string(configuredLatencySamples) + " -> " + std::to_string(nextLatency) +
      " samples) on an active live session; stop playback to reconfigure Mixer delay compensation");
    reconfigureActiveComponent(
      flags | (nextLatency != configuredLatencySamples ? RestartFlags::kLatencyChanged : 0),
      ioChanged ? "parameter I/O reconfiguration" : "parameter latency reconfiguration");
    configuredLatencySamples = validateLatencySamples(processor->getLatencySamples());
    return configuredLatencySamples;
  }
  json metadata() {
    json result = json::array();
    int choiceBudget = 4096;
    for (const auto& info : parameterInfo) {
      auto current = controller->getParamNormalized(info.id);
      json item{{"id", info.id}, {"name", StringConvert::convert(info.title)},
        {"shortTitle", StringConvert::convert(info.shortTitle)}, {"units", StringConvert::convert(info.units)},
        {"defaultValue", info.defaultNormalizedValue}, {"flags", info.flags}, {"stepCount", info.stepCount},
        {"currentValue", std::isfinite(current) && current >= 0 && current <= 1 ? json(current) : json(nullptr)}};
      // Only genuine controller labels; never synthesize enumeration names.
      if ((info.flags & ParameterInfo::kIsList) && info.stepCount > 0 && info.stepCount <= 127 && choiceBudget >= info.stepCount + 1) {
        json choices = json::array();
        for (int32 step = 0; step <= info.stepCount; ++step) {
          String128 label{};
          auto value = double(step) / info.stepCount;
          if (controller->getParamStringByValue(info.id, value, label) != kResultOk || !label[0]) { choices.clear(); break; }
          choices.push_back({{"value", value}, {"label", StringConvert::convert(label)}});
        }
        if (!choices.empty()) { choiceBudget -= choices.size(); item["choices"] = choices; }
      }
      result.push_back(item);
    }
    return result;
  }
  void restore(const json& state) {
    require(state.at("classId") == classId && state.at("schema") == 1, "State identity/schema mismatch; refusing to substitute instrument");
    if (state.contains("component")) {
      auto bytes = unhex(state.at("component"));
      MemoryStream stream(bytes.data(), bytes.size());
      checked(component->setState(&stream), "Plugin rejected saved component state");
      if (controller) {
        stream.seek(0, IBStream::kIBSeekSet, nullptr);
        checked(controller->setComponentState(&stream), "Controller rejected saved component state");
      }
    }
    if (state.contains("controller")) {
      require(bool(controller), "Saved controller state cannot be restored without controller");
      auto bytes = unhex(state.at("controller"));
      MemoryStream stream(bytes.data(), bytes.size());
      checked(controller->setState(&stream), "Plugin rejected saved controller state");
    }
    // Instruments keep the established pre-activation queue contract. Effect
    // overlays are applied after setActive/setProcessing in open().
    if (isInstrument && state.contains("parameters")) applyParameters(state.at("parameters"), false, -1, true);
  }
  void applyParameters(const json& changes, bool live = false, int32 frames = -1, bool enqueue = true) {
    require(changes.is_array() && changes.size() <= 4096, "Invalid parameter list");
    std::map<ParamID, int32> seen;
    // Validate the entire batch before touching controller/processor state.
    for (const auto& change : changes) {
      require(change.is_object() && change.contains("id") && change.contains("value"), "Invalid parameter change");
      require(change.at("id").is_number_integer(), "Parameter ID must be an integer");
      auto raw = change.at("id").get<int64_t>();
      require(raw >= 0 && raw <= UINT32_MAX, "Parameter ID out of range");
      auto id = static_cast<ParamID>(raw);
      const bool timed = change.contains("offset");
      const auto offset = timed ? integer(change, "offset", 0, std::max(0, frames - 1)) : 0;
      require(!timed || frames > 0, "Automation requires a nonempty process block");
      require(!seen.count(id) || (timed && offset > seen[id]), "Duplicate or unordered parameter point");
      seen[id] = offset;
      require(parameterIds.count(id), "Saved parameter ID no longer exists: " + std::to_string(id));
      require(!readOnlyIds.count(id), "Cannot restore a read-only parameter");
      real(change, "value", 0, 1);
      if (live || frames >= 0) for (const auto& info : parameterInfo) {
        if (id == info.id && timed) require(info.flags & ParameterInfo::kCanAutomate, "Parameter cannot automate");
        if (id == info.id && timed && (info.flags & ParameterInfo::kIsList)) {
          const auto list = metadata();
          auto item = std::find_if(list.begin(), list.end(), [id](const json& p) { return p.at("id") == id; });
          require(item != list.end() && item->contains("choices"), "List choices unavailable");
          bool valid = false;
          for (const auto& c : item->at("choices")) if (c.at("value") == change.at("value")) valid = true;
          require(valid, "Invalid list automation value");
        }
        if (id == info.id) require(!(info.flags & (ParameterInfo::kIsHidden | ParameterInfo::kIsProgramChange)), "Hidden/program-change parameter is not live editable");
      }
    }
    for (const auto& change : changes) {
      require(change.at("id").is_number_unsigned() || change.at("id").is_number_integer(), "Parameter ID must be an integer");
      auto rawId = change.at("id").get<int64_t>();
      require(rawId >= 0 && rawId <= UINT32_MAX, "Parameter ID out of range");
      auto id = static_cast<ParamID>(rawId);
      require(parameterIds.count(id) != 0, "Saved parameter ID no longer exists: " + std::to_string(id));
      require(!readOnlyIds.count(id), "Cannot restore a read-only parameter");
      auto value = real(change, "value", 0, 1);
      const bool timed = change.contains("offset");
      require(enqueue || !timed, "Timed parameter points require an audio process block");
      if (enqueue) {
        int32 queueIndex = 0, pointIndex = 0;
        auto* queue = parameters.addParameterData(id, queueIndex);
        require(queue != nullptr, "Parameter queue full");
        const auto offset = timed ? integer(change, "offset", 0, frames - 1) : 0;
        checked(queue->addPoint(offset, value, pointIndex), "Cannot queue parameter");
      }
      if (timed) continue; // Runtime automation never overwrites saved base/controller state.
      checked(controller->setParamNormalized(id, value), "Controller rejected parameter");
      const auto accepted = controller->getParamNormalized(id);
      require(std::isfinite(accepted) && std::abs(accepted - value) <= 1e-7, "Controller did not accept the requested normalized value");
      overrides[id] = value;
      if (!isInstrument) pendingEffectParameters[id] = value;
    }
  }
  json snapshot() {
    checkedProcessing(processor->setProcessing(false), "Cannot suspend for state capture"); processing = false;
    json state{{"schema", 1}, {"classId", classId}, {"parameters", json::array()}};
    MemoryStream componentState;
    auto componentResult = component->getState(&componentState);
    if (componentResult == kResultOk) state["component"] = hex(componentState.getData(), componentState.getSize());
    else require(componentResult == kNotImplemented, "Plugin failed component state capture");
    if (controller) {
      MemoryStream controllerState;
      auto controllerResult = controller->getState(&controllerState);
      if (controllerResult == kResultOk) state["controller"] = hex(controllerState.getData(), controllerState.getSize());
      else require(controllerResult == kNotImplemented, "Plugin failed controller state capture");
      // Component/controller streams are authoritative. Do not round-trip
      // unedited controller defaults as DSP changes: MIDI-mapped controller
      // defaults can differ from the processor (e.g. MDA pitch bend).
      for (const auto& entry : overrides)
        state["parameters"].push_back({{"id", entry.first}, {"value", entry.second}});
    }
    checkedProcessing(processor->setProcessing(true), "Cannot resume after state capture"); processing = true;
    return state;
  }
  std::vector<float> process(const json& request, bool flush = false) {
    require(processing, "Plugin processing is suspended; reopen instance");
    const int frames = integer(request, "frames", flush ? 0 : 1, kMaxBlock);
    auto inputEvents = request.value("events", json::array());
    require(inputEvents.is_array() && inputEvents.size() <= 4096, "Too many events in block");
    events.clear(); outputEvents.clear(); outputParameters.clearQueue();
    std::vector<float> inputAudio;
    if (isInstrument) {
      int lastOffset = -1;
      for (const auto& item : inputEvents) {
        Event event{};
        event.busIndex = 0;
        event.sampleOffset = integer(item, "offset", 0, frames - 1);
        require(event.sampleOffset >= lastOffset, "Events must be ordered by sample offset");
        lastOffset = event.sampleOffset;
        auto pitch = integer(item, "pitch", 0, 127);
        auto channel = item.contains("channel") ? integer(item, "channel", 0, 15) : 0;
        auto noteId = integer(item, "noteId", 0, INT32_MAX);
        auto type = item.at("type").get<std::string>();
        if (type == "on") {
          event.type = Event::kNoteOnEvent;
          event.noteOn.channel = channel; event.noteOn.pitch = pitch;
          event.noteOn.velocity = static_cast<float>(real(item, "velocity", 0, 1));
          event.noteOn.noteId = noteId;
        } else {
          require(type == "off", "Unknown MIDI event type");
          event.type = Event::kNoteOffEvent;
          event.noteOff.channel = channel; event.noteOff.pitch = pitch;
          event.noteOff.velocity = 0; event.noteOff.noteId = noteId;
        }
        checked(events.addEvent(event), "Event queue full");
      }
    } else {
      require(inputEvents.empty(), "MIDI events cannot be sent to a VST3 audio effect");
      if (frames > 0) {
        require(request.contains("audio") && request.at("audio").is_string(), "VST3 effect process requires stereo input audio");
        inputAudio = decodePlanarAudio(request.at("audio").get<std::string>(), frames);
      }
    }
    if (!isInstrument && frames > 0 && !pendingEffectParameters.empty()) {
      std::set<ParamID> requested;
      if (request.contains("parameters") && request.at("parameters").is_array())
        for (const auto& change : request.at("parameters")) if (change.is_object() && change.contains("id") && change.at("id").is_number_integer()) {
          const auto raw = change.at("id").get<int64_t>();
          if (raw >= 0 && raw <= UINT32_MAX) requested.insert(static_cast<ParamID>(raw));
        }
      for (const auto& entry : pendingEffectParameters) {
        if (requested.count(entry.first)) continue;
        int32 queueIndex = 0, pointIndex = 0;
        auto* queue = parameters.addParameterData(entry.first, queueIndex);
        require(queue != nullptr, "Parameter queue full");
        checked(queue->addPoint(0, entry.second, pointIndex), "Cannot queue saved effect parameter");
      }
    }
    if (request.contains("parameters")) applyParameters(request.at("parameters"), flush, flush ? -1 : frames);
    assertNoActiveProcessRestartFlags(componentHandler->consumeRestartFlags());
    assertPreparedProcessDataMatchesContract();
    for (int32 bus = 0; bus < data.numOutputs; ++bus) {
      data.outputs[bus].silenceFlags = 0;
      for (int32 ch = 0; ch < data.outputs[bus].numChannels; ++ch)
        std::fill_n(data.outputs[bus].channelBuffers32[ch], frames, 0.f);
    }
    ProcessContext context{};
    context.sampleRate = sampleRate;
    context.projectTimeSamples = cursor;
    context.continousTimeSamples = cursor;
    context.tempo = real(request, "bpm", 1, 999);
    context.timeSigNumerator = request.contains("numerator") ? integer(request, "numerator", 1, 32) : 4;
    context.timeSigDenominator = request.contains("denominator") ? integer(request, "denominator", 1, 32) : 4;
    context.projectTimeMusic = static_cast<double>(cursor) / sampleRate * context.tempo / 60.;
    context.state = ProcessContext::kPlaying | ProcessContext::kTempoValid |
      ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid | ProcessContext::kContTimeValid;
    if (!isInstrument && frames > 0) {
      require(data.numInputs == 1 && data.inputs[0].numChannels == 2, "VST3 effect input layout changed after setup");
      data.inputs[0].silenceFlags = 0;
      std::copy_n(inputAudio.data(), frames, data.inputs[0].channelBuffers32[0]);
      std::copy_n(inputAudio.data() + frames, frames, data.inputs[0].channelBuffers32[1]);
    }
    data.processMode = mode; data.numSamples = frames;
    data.inputEvents = &events; data.outputEvents = &outputEvents;
    data.inputParameterChanges = &parameters; data.outputParameterChanges = &outputParameters;
    data.processContext = &context;
    checked(processor->process(data), "Plugin process failed");
    assertNoActiveProcessRestartFlags(componentHandler->consumeRestartFlags());
    assertPreparedProcessDataMatchesContract();
    // Retain a zero-sample flush for the next audible block too: some SDK
    // processors recalculate coefficients only while processing samples.
    if (frames > 0) {
      parameters.clearQueue();
      pendingEffectParameters.clear();
    }
    std::vector<float> pcm(frames * 2);
    const auto& output = data.outputs[0];
    for (int ch = 0; ch < 2; ++ch) {
      const int source = std::min(ch, output.numChannels - 1);
      const bool channelSilent = (output.silenceFlags & (uint64_t{1} << source)) != 0;
      for (int i = 0; i < frames; ++i) {
        float sample = output.channelBuffers32[source][i];
        require(std::isfinite(sample), "Plugin produced non-finite audio");
        if (!channelSilent) pcm[ch * frames + i] = sample;
      }
    }
    cursor += frames;
    return pcm;
  }
};

// Binary framing: little-endian uint32 JSON length, uint32 PCM byte length,
// UTF-8 JSON, then planar stereo float32 PCM. The editor mode drains callback
// events only in response to a bounded poll command; it never writes unsolicited
// stdout that could desynchronize this synchronous helper protocol.
void reply(const json& message, const std::vector<float>& pcm = {}) {
  const auto text = message.dump();
  require(text.size() <= 5 * 1024 * 1024, "VST3 helper response exceeds 5 MiB limit");
  auto put32 = [](uint32_t n) { for (int i = 0; i < 4; ++i) std::cout.put(static_cast<char>((n >> (8 * i)) & 255)); };
  put32(static_cast<uint32_t>(text.size())); put32(static_cast<uint32_t>(pcm.size() * sizeof(float)));
  std::cout.write(text.data(), text.size());
  if (!pcm.empty()) std::cout.write(reinterpret_cast<const char*>(pcm.data()), pcm.size() * sizeof(float));
  std::cout.flush();
}

#ifdef _WIN32
std::optional<std::string> tryReadEditorPipeLine(std::string& pending, bool& eof) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  DWORD available = 0;
  if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
    const auto error = GetLastError();
    if (error == ERROR_BROKEN_PIPE || error == ERROR_INVALID_HANDLE) { eof = true; return std::nullopt; }
    throw std::runtime_error("Could not poll the VST3 editor command pipe");
  }
  if (available > 0) {
    char chunk[4096];
    const auto requested = std::min<DWORD>(available, static_cast<DWORD>(sizeof(chunk)));
    DWORD received = 0;
    if (!ReadFile(input, chunk, requested, &received, nullptr)) {
      const auto error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_INVALID_HANDLE) { eof = true; return std::nullopt; }
      throw std::runtime_error("Could not read the VST3 editor command pipe");
    }
    if (received == 0) { eof = true; return std::nullopt; }
    pending.append(chunk, chunk + received);
    if (pending.size() > kMaxRequest + 1) throw std::runtime_error("Request exceeds 8 MiB limit");
  }
  const auto newline = pending.find('\n');
  if (newline == std::string::npos) return std::nullopt;
  auto line = pending.substr(0, newline);
  pending.erase(0, newline + 1);
  if (!line.empty() && line.back() == '\r') line.pop_back();
  return line;
}
#endif

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  const auto user32 = GetModuleHandleW(L"user32.dll");
  using SetDpiContextFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
  const auto setDpiContext = reinterpret_cast<SetDpiContextFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
  if (setDpiContext) setDpiContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(com)) return 2;
#endif
  PlugProvider::setErrorStream(&std::cerr);
  // Reserve stdout exclusively for framed protocol; plugin debug logs using
  // stdout will be rejected by the parent, never interpreted as UI events.
  std::unique_ptr<Instance> instance;
#ifdef _WIN32
  std::unique_ptr<ApexVst3Host::NativeEditorSession> editor;
  std::string editorPipeBuffer;
#endif
  std::string line;
  while (true) {
    line.clear();
#ifdef _WIN32
    if (editor) {
      bool eof = false;
      std::optional<std::string> editorLine;
      try { editorLine = tryReadEditorPipeLine(editorPipeBuffer, eof); }
      catch (const std::exception& error) {
        reply({{"ok", false}, {"error", error.what()}});
        break;
      }
      if (!editorLine) {
        if (eof) break;
        editor->pumpMessages();
        MsgWaitForMultipleObjectsEx(0, nullptr, 12, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        continue;
      }
      line = std::move(*editorLine);
    } else
#endif
    {
      char c;
      while (std::cin.get(c) && c != '\n') {
        line.push_back(c);
        if (line.size() > kMaxRequest) {
          reply({{"ok", false}, {"error", "Request exceeds 8 MiB limit"}});
          return 1;
        }
      }
      if (line.empty() && !std::cin) break;
    }

    std::string command;
    try {
      auto request = json::parse(line);
      command = request.at("command").get<std::string>();
      if (command == "scan") {
        require(!instance, "Scan requires a separate helper");
#ifdef _WIN32
        require(!editor, "Plugin discovery cannot run inside an editor-only helper");
#endif
        std::string error;
        auto module = VST3::Hosting::Module::create(request.at("path").get<std::string>(), error);
        require(bool(module), "Plugin module load failed: " + error);
        const auto kind = request.value("kind", std::string("instrument"));
        require(kind == "instrument" || kind == "effect", "Unknown VST3 discovery kind");
        json plugins = json::array();
        for (const auto& info : module->getFactory().classInfos())
          if (kind == "instrument" ? instrument(info) : audioEffect(info)) plugins.push_back(identity(info));
        reply({{"ok", true}, {"plugins", plugins}});
      } else if (command == "open") {
        require(!instance, "Close current instance before opening another");
#ifdef _WIN32
        require(!editor, "Audio processing cannot run inside an editor-only helper");
#endif
        instance = std::make_unique<Instance>();
        auto result = instance->open(request);
        reply({{"ok", true}, {"plugin", result}});
      } else if (command == "editorOpen") {
#ifdef _WIN32
        require(!instance && !editor, "A VST3 helper process can host exactly one isolated session");
        editor = std::make_unique<ApexVst3Host::NativeEditorSession>();
        auto result = editor->open(request);
        reply({{"ok", true}, {"editor", result}});
#else
        throw std::runtime_error("Native VST3 editor windows are supported only on Windows x64");
#endif
      } else if (command == "editorPoll") {
#ifdef _WIN32
        require(editor != nullptr, "No native VST3 editor session is open");
        editor->pumpMessages();
        reply({{"ok", true}, {"editor", editor->poll()}});
#else
        throw std::runtime_error("Native VST3 editor windows are supported only on Windows x64");
#endif
      } else if (command == "editorClose") {
#ifdef _WIN32
        require(editor != nullptr, "No native VST3 editor session is open");
        reply({{"ok", true}, {"editor", editor->closeAndCapture()}});
#else
        throw std::runtime_error("Native VST3 editor windows are supported only on Windows x64");
#endif
      } else if (command == "editorTestAction") {
        // Acceptance harness only. Performs a REAL Win32 operation on the live
        // window (not a simulated message) and lets the plug-in react through its
        // normal path, then reports what the OS and the plug-in observed.
#ifdef _WIN32
        require(editor != nullptr, "No native VST3 editor session is open");
        json result = json::object();
        const auto action = request.value("action", std::string());
        HWND window = editor->testWindowHandle();
        require(window != nullptr && !editor->isClosed(), "The native editor window is not open");
        const auto classId = request.value("classId", std::string());
        if (action == "resizeClient") {
          const auto width = request.at("width").get<int>();
          const auto height = request.at("height").get<int>();
          require(width >= 32 && height >= 32 && width <= 8192 && height <= 8192, "Invalid resize target");
          RECT target{0, 0, width, height};
          const auto style = static_cast<DWORD>(GetWindowLongPtrW(window, GWL_STYLE));
          AdjustWindowRectEx(&target, style, FALSE, 0);
          // A real resize goes through WM_SIZING/WM_SIZE exactly like a user drag,
          // so IPlugView::checkSizeConstraint() is genuinely exercised.
          SetWindowPos(window, nullptr, 0, 0, target.right - target.left, target.bottom - target.top,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
          editor->pumpMessages();
          result["requestedWidth"] = width;
          result["requestedHeight"] = height;
        } else if (action == "keyDown" || action == "keyUp") {
          // Real keyboard input: focus the editor window, then inject the key with
          // SendInput so Windows routes WM_KEYDOWN to the focused window.
          const auto vk = static_cast<WORD>(request.at("vk").get<unsigned>());
          const unsigned long accepted = editor->sendKeyForTest(vk, action == "keyDown");
          editor->pumpMessages();
          result["vk"] = vk;
          result["key"] = action;
          // accepted = how many events SendInput consumed (the ATTEMPT). The
          // observation below is what the window procedure and the plug-in view
          // actually saw (the RECEIPT). They are reported separately on purpose.
          result["sendInputAccepted"] = accepted;
          result["observation"] = editor->keyObservation();
        } else if (action == "mouseMove" || action == "mouseDown" || action == "mouseUp" ||
                   action == "mouseWheel") {
          // mouseUp is a real action, not a synonym: a press with no release leaves
          // the button down and the control never commits a value.
          const auto kind = action == "mouseMove" ? "move"
            : action == "mouseDown" ? "down"
            : action == "mouseUp" ? "up"
            : "wheel";
          result = editor->deliverMouse(kind, request.value("x", 0), request.value("y", 0));
        } else if (action == "setScale") {
          const auto factor = request.at("scale").get<float>();
          require(factor >= 0.5f && factor <= 4.f, "Invalid content scale factor");
          const auto code = editor->setScaleForTest(factor);
          result["requestedScale"] = factor;
          result["result"] = ApexVst3Host::NativeEditorSession::resultName(code);
          result["supported"] = editor->scaleSupported();
        } else if (action == "destroyFocusSink") {
          editor->destroyFocusSink();
          result["focusSinkDestroyed"] = true;
          editor->pumpMessages();
        } else if (action == "requestPluginResize") {
          result["accepted"] = editor->requestTestPluginResize(request.value("width", 480), request.value("height", 320));
          editor->pumpMessages();
        } else if (action == "closeFromWindow") {
          // A real WM_CLOSE, exactly what the title-bar X produces.
          PostMessageW(window, WM_CLOSE, 0, 0);
          editor->pumpMessages();
          result["closePosted"] = true;
        } else if (action == "focus") {
          SetForegroundWindow(window);
          SetFocus(window);
          editor->pumpMessages();
          result["focusRequested"] = true;
        } else if (action == "loseFocus") {
          // A genuine focus change needs a real second window that can own focus.
          // This helper is otherwise GUI-less, so create one: a real, separate
          // top-level window owned by this process. Focus then moves through the
          // normal Win32 path and the plug-in receives onFocus(0) via WM_KILLFOCUS.
          editor->ensureFocusSink();
          HWND sink = editor->focusSink();
          require(sink != nullptr, "Could not create the focus-loss target window");
          ShowWindow(sink, SW_SHOWNOACTIVATE);
          SetForegroundWindow(sink);
          SetFocus(sink);
          editor->pumpMessages();
          result["focusSinkCreated"] = true;
          result["focusSinkIsSeparateWindow"] = sink != window;
          result["focusSinkOwnsFocus"] = GetFocus() == sink;
        } else if (action == "minimize") {
          ShowWindow(window, SW_MINIMIZE);
          editor->pumpMessages();
          result["minimized"] = IsIconic(window) != 0;
          ShowWindow(window, SW_RESTORE);
          editor->pumpMessages();
        } else {
          throw std::runtime_error("Unknown editor test action: " + action);
        }
        editor->pumpMessages();
        result["diagnostics"] = editor->windowDiagnostics(classId.c_str());
        reply({{"ok", true}, {"action", action}, {"result", result}});
#else
        throw std::runtime_error("Native VST3 editor windows are supported only on Windows x64");
#endif
      } else if (command == "editorDiagnostics") {
        // Read-only observation of the live native window, used to verify genuine
        // HWND creation, visibility, focus, DPI and resize behaviour. It never
        // mutates the session, so it is safe while the editor is open.
#ifdef _WIN32
        require(editor != nullptr, "No native VST3 editor session is open");
        editor->pumpMessages();
        // The caller supplies the class id it expects; the diagnostics report it
        // back so an evidence run can prove it inspected the intended plug-in.
        const auto expectedClassId = request.value("classId", std::string());
        reply({{"ok", true}, {"diagnostics", editor->windowDiagnostics(expectedClassId.c_str())}});
#else
        throw std::runtime_error("Native VST3 editor windows are supported only on Windows x64");
#endif
      } else if (command == "process") {
        require(bool(instance), "No plugin instance loaded");
        auto pcm = instance->process(request);
        reply({{"ok", true}, {"frames", pcm.size() / 2}, {"channels", 2}}, pcm);
      } else if (command == "parameters") {
        require(bool(instance), "No plugin instance loaded");
        // Instruments retain the established zero-sample flush contract. Audio
        // effects defer controller values to the next real audio block because
        // some processors ignore parameter queues on zero-sample calls.
        if (instance->isInstrumentKind())
          instance->process({{"frames", 0}, {"events", json::array()}, {"bpm", 120}, {"parameters", request.at("parameters")}}, true);
        else {
          instance->applyParameters(request.at("parameters"), false, -1, false);
          instance->reconcileParameterRestartAndLatency();
        }
        reply({{"ok", true}, {"parameters", instance->metadata()}, {"latencySamples", instance->latencySamples()}});
      } else if (command == "snapshot") {
        require(bool(instance), "No plugin instance loaded");
        reply({{"ok", true}, {"state", instance->snapshot()}});
      } else if (command == "close") {
#ifdef _WIN32
        if (editor) {
          if (!editor->isClosed()) editor->closeAndCapture();
          editor.reset();
        }
#endif
        instance.reset();
        reply({{"ok", true}});
      } else throw std::runtime_error("Unknown command");
    } catch (const std::exception& error) {
      // A state-capture failure during editorClose intentionally keeps the
      // editor process/window alive so the user can retry. Processing failures
      // continue to invalidate only their independent processing instance.
      instance.reset();
#ifdef _WIN32
      if (command == "editorOpen") editor.reset();
#endif
      reply({{"ok", false}, {"error", error.what()}});
    }
  }
  instance.reset();
#ifdef _WIN32
  editor.reset();
  CoUninitialize();
#endif
  return 0;
}
