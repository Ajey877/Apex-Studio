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
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <iomanip>
#include <memory>
#include <map>
#include <sstream>
#include <set>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <objbase.h>
#include <fcntl.h>
#include <io.h>
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;
using json = nlohmann::json;
constexpr int kMaxBlock = 16384;
constexpr size_t kMaxRequest = 8 * 1024 * 1024;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}
void checked(tresult result, const std::string& message) {
  require(result == kResultOk, message + " (VST result " + std::to_string(result) + ")");
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
json byteFingerprint(const char* data, size_t size) {
  uint32_t hash = 2166136261u;
  for (size_t i = 0; i < size; ++i) hash = (hash ^ static_cast<unsigned char>(data[i])) * 16777619u;
  std::ostringstream checksum;
  checksum << std::hex << std::setw(8) << std::setfill('0') << hash;
  return {{"available", true}, {"bytes", size}, {"fnv1a32", checksum.str()}};
}
json stateFingerprint(const json& state, const char* key) {
  if (!state.is_object() || !state.contains(key) || !state.at(key).is_string()) return {{"available", false}, {"bytes", 0}};
  const auto bytes = unhex(state.at(key).get<std::string>());
  return byteFingerprint(bytes.data(), bytes.size());
}
json stereoMetrics(const std::vector<float>& planar, int frames) {
  if (frames <= 0 || planar.size() != static_cast<size_t>(frames) * 2) return nullptr;
  double leftSquares = 0, rightSquares = 0, sumSquares = 0, differenceSquares = 0;
  for (int frame = 0; frame < frames; ++frame) {
    const double left = planar[frame], right = planar[frames + frame];
    leftSquares += left * left; rightSquares += right * right;
    sumSquares += (left + right) * (left + right);
    differenceSquares += (left - right) * (left - right);
  }
  return {{"leftRms", std::sqrt(leftSquares / frames)}, {"rightRms", std::sqrt(rightSquares / frames)},
    {"monoSumRms", std::sqrt(sumSquares / frames)}, {"monoDifferenceRms", std::sqrt(differenceSquares / frames)},
    {"combinedRms", std::sqrt((leftSquares + rightSquares) / (2.0 * frames))}};
}
json parameterMapEvidence(const std::map<ParamID, ParamValue>& values) {
  json result = json::array();
  size_t count = 0;
  for (const auto& entry : values) {
    if (count++ == 64) break;
    result.push_back({{"id", entry.first}, {"value", entry.second}});
  }
  return {{"values", result}, {"truncated", values.size() > 64}};
}
json boundedArrayEvidence(const json& values) {
  json result = json::array();
  if (!values.is_array()) return {{"values", result}, {"truncated", false}};
  const size_t count = std::min<size_t>(64, values.size());
  for (size_t i = 0; i < count; ++i) result.push_back(values[i]);
  return {{"values", result}, {"truncated", values.size() > count}};
}
json boundedRequestProfileEvidence(const json& profile, double sampleRate) {
  return {{"requestId", profile.value("requestId", std::string())},
    {"trackId", profile.value("trackId", -1)}, {"slotId", profile.value("slotId", std::string())},
    {"sequence", profile.value("sequence", -1)},
    {"inputBlockStartContextFrame", profile.value("inputBlockStartContextFrame", 0.0)},
    {"submittedContextFrame", profile.value("submittedContextFrame", 0.0)},
    {"submittedOutputFrame", profile.value("submittedOutputFrame", 0.0)},
    {"dueOutputFrame", profile.value("dueOutputFrame", 0.0)},
    {"dueContextFrame", profile.value("dueContextFrame", 0.0)},
    {"sampleRate", profile.value("sampleRate", sampleRate)},
    {"serviceSessionId", profile.value("serviceSessionId", std::string())},
    {"helperPid", profile.value("helperPid", 0)}, {"runtimeId", profile.value("runtimeId", std::string())}};
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

class Instance {
  // Declaration order matters: SDK objects are released BEFORE the module unloads.
  IPtr<HostApplication> host = owned(new HostApplication());
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
  bool captureFailureEvidence = false;
  // Separate opt-in test audit; never enabled by the real-time smoke profile.
  bool captureBlockAudit = false;
  uint64_t auditedBlocks = 0;
  std::set<ParamID> blockAuditParameterIds;
  bool blockAuditParametersTruncated = false;
  bool failureEvidenceCaptured = false;
  bool firstProcessObserved = false;
  json stateApplicationEvidence = json::object();
  json firstProcessEvidence = nullptr;
  json failureEvidence = nullptr;
  json blockEvidence = nullptr;
  std::string classId;
  double sampleRate = 48000;
  int mode = kOffline;
  int64_t cursor = 0;
  uint64_t processedBlocks = 0;
  bool active = false;
  bool processing = false;
  bool isInstrument = true;
public:
  json takeFailureEvidence() {
    json evidence = std::move(failureEvidence);
    failureEvidence = nullptr;
    return evidence;
  }
  json takeFirstProcessEvidence() {
    json evidence = std::move(firstProcessEvidence);
    firstProcessEvidence = nullptr;
    return evidence;
  }
  json takeBlockEvidence() {
    json evidence = std::move(blockEvidence);
    blockEvidence = nullptr;
    return evidence;
  }
  ~Instance() {
    if (processing) processor->setProcessing(false);
    if (active) component->setActive(false);
    data.unprepare();
    processor = nullptr;
    controller = nullptr;
    component = nullptr;
    provider = nullptr; // PlugProvider disconnects and terminates both components.
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
      captureFailureEvidence = !isInstrument && request.value("captureFailureEvidence", false);
      captureBlockAudit = captureFailureEvidence && request.value("captureBlockAudit", false);
      require(isInstrument ? instrument(info) : audioEffect(info), isInstrument ? "Selected class is not a VST3 instrument" : "Selected class is not a VST3 audio effect");
      provider = owned(new PlugProvider(factory, info, true));
      require(provider->initialize(), "Plugin component/controller initialization failed");
      result = identity(info);
      break;
    }
    require(bool(provider), "Saved instrument class ID is not present in this module");
    component = provider->getComponentPtr();
    controller = provider->getControllerPtr();
    processor = FUnknownPtr<IAudioProcessor>(component);
    require(bool(processor), "Plugin has no IAudioProcessor");
    checked(processor->canProcessSampleSize(kSample32), "Plugin does not support float32 processing");
    const auto inputBuses = component->getBusCount(kAudio, kInput);
    const auto outputBuses = component->getBusCount(kAudio, kOutput);
    if (isInstrument) {
      require(inputBuses == 0, "Instrument class unexpectedly requires audio input");
      require(outputBuses >= 1 && component->getBusCount(kEvent, kInput) >= 1,
        "Instrument requires an audio output and event input");
      BusInfo bus{};
      checked(component->getBusInfo(kAudio, kOutput, 0, bus), "Cannot query main output bus");
      require(bus.busType == kMain && (bus.channelCount == 1 || bus.channelCount == 2), "Only mono/stereo instrument output supported");
    } else {
      require(inputBuses == 1 && outputBuses == 1, "Only one-input/one-output VST3 audio effects are supported");
      BusInfo input{}, output{};
      checked(component->getBusInfo(kAudio, kInput, 0, input), "Cannot query main input bus");
      checked(component->getBusInfo(kAudio, kOutput, 0, output), "Cannot query main output bus");
      require(input.busType == kMain && output.busType == kMain && input.channelCount == 2 && output.channelCount == 2,
        "Only effects with a stereo main input and stereo main output are supported");
      require(component->getBusCount(kEvent, kInput) == 0, "VST3 audio effects with event input buses are not supported");
    }
    for (int32 i = 0; i < inputBuses; ++i)
      checked(component->activateBus(kAudio, kInput, i, i == 0), "Cannot configure audio input bus");
    for (int32 i = 0; i < outputBuses; ++i)
      checked(component->activateBus(kAudio, kOutput, i, i == 0), "Cannot configure audio output bus");
    for (int32 i = 0; i < component->getBusCount(kEvent, kInput); ++i)
      checked(component->activateBus(kEvent, kInput, i, i == 0), "Cannot configure MIDI input bus");
    sampleRate = real(request, "sampleRate", 8000, 192000);
    const auto modeName = request.value("mode", std::string("offline"));
    require(modeName == "offline" || modeName == "realtime", "Unknown processing mode");
    mode = modeName == "offline" ? kOffline : kRealtime;
    ProcessSetup setup{mode, kSample32, kMaxBlock, sampleRate};
    checked(processor->setupProcessing(setup), "setupProcessing failed");
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
    if (captureBlockAudit && request.contains("diagnosticParameterIds")) {
      const auto& ids = request.at("diagnosticParameterIds");
      require(ids.is_array() && ids.size() <= 64, "Invalid native block-audit parameter selection");
      for (const auto& value : ids) {
        require(value.is_number_integer(), "Invalid native block-audit parameter ID");
        const auto rawId = value.get<int64_t>();
        require(rawId >= 0 && rawId <= UINT32_MAX, "Invalid native block-audit parameter ID");
        const auto id = static_cast<ParamID>(rawId);
        require(parameterIds.count(id) != 0, "Unknown native block-audit parameter ID");
        blockAuditParameterIds.insert(id);
      }
    } else if (captureBlockAudit) {
      for (const auto& info : parameterInfo) {
        if (blockAuditParameterIds.size() == 64) break;
        blockAuditParameterIds.insert(info.id);
      }
      blockAuditParametersTruncated = parameterInfo.size() > blockAuditParameterIds.size();
    }
    if (captureFailureEvidence) {
      const json inputState = request.value("state", json::object());
      stateApplicationEvidence = {{"classId", classId}, {"stateProvided", request.contains("state")},
        {"controllerAvailable", bool(controller)}, {"componentStateInput", stateFingerprint(inputState, "component")},
        {"controllerStateInput", stateFingerprint(inputState, "controller")},
        {"componentStateApplied", false}, {"controllerComponentStateApplied", false},
        {"controllerStateApplied", false}, {"normalizedOverridesApplied", json::array()},
        {"normalizedOverridesTruncated", false}, {"lifecycleOrder", json::array()}, {"errors", json::array()}};
    }
    if (request.contains("state")) restore(request.at("state"));
    else if (controller) {
      MemoryStream stream;
      if (component->getState(&stream) == kResultOk) {
        stream.seek(0, IBStream::kIBSeekSet, nullptr);
        // Optional for some plugins; required on restore when component state exists.
        const auto componentStateResult = controller->setComponentState(&stream);
        if (captureFailureEvidence) {
          stateApplicationEvidence["componentStateInput"] = byteFingerprint(stream.getData(), stream.getSize());
          stateApplicationEvidence["controllerComponentStateResult"] = componentStateResult;
          stateApplicationEvidence["controllerComponentStateApplied"] = componentStateResult == kResultOk;
          stateApplicationEvidence["lifecycleOrder"].push_back("controller.setComponentState(default component state)");
        }
      }
    }
    data.prepare(*component, kMaxBlock, kSample32);
    if (captureFailureEvidence) stateApplicationEvidence["lifecycleOrder"].push_back("data.prepare");
    checked(component->setActive(true), "setActive failed"); active = true;
    if (captureFailureEvidence) stateApplicationEvidence["lifecycleOrder"].push_back("component.setActive(true)");
    checked(processor->setProcessing(true), "setProcessing failed"); processing = true;
    if (captureFailureEvidence) stateApplicationEvidence["lifecycleOrder"].push_back("processor.setProcessing(true)");
    result["parameters"] = metadata();
    result["controllerAvailable"] = bool(controller);
    result["latencySamples"] = processor->getLatencySamples();
    result["tailSamples"] = processor->getTailSamples();
    if (captureFailureEvidence) result["smokeOpenEvidence"] = {{"schema", 1}, {"pluginClassId", classId},
      {"processingMode", mode == kRealtime ? "realtime" : "offline"}, {"stateApplication", stateApplicationEvidence},
      {"stateSnapshot", {{"captured", false}, {"observation", "passive open-time state/application and lifecycle audit; no component snapshot was taken"}}}};
    return result;
  }
  bool isInstrumentKind() const { return isInstrument; }
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
      if (captureFailureEvidence) {
        stateApplicationEvidence["componentStateApplied"] = true;
        stateApplicationEvidence["lifecycleOrder"].push_back("component.setState(saved component state)");
      }
      if (controller) {
        stream.seek(0, IBStream::kIBSeekSet, nullptr);
        checked(controller->setComponentState(&stream), "Controller rejected saved component state");
        if (captureFailureEvidence) {
          stateApplicationEvidence["controllerComponentStateApplied"] = true;
          stateApplicationEvidence["lifecycleOrder"].push_back("controller.setComponentState(saved component state)");
        }
      }
    }
    if (state.contains("controller")) {
      require(bool(controller), "Saved controller state cannot be restored without controller");
      auto bytes = unhex(state.at("controller"));
      MemoryStream stream(bytes.data(), bytes.size());
      checked(controller->setState(&stream), "Plugin rejected saved controller state");
      if (captureFailureEvidence) {
        stateApplicationEvidence["controllerStateApplied"] = true;
        stateApplicationEvidence["lifecycleOrder"].push_back("controller.setState(saved controller state)");
      }
    }
    if (state.contains("parameters")) applyParameters(state.at("parameters"), false, -1, isInstrument);
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
      if (captureFailureEvidence && !active && !processing) {
        if (stateApplicationEvidence["normalizedOverridesApplied"].size() < 64) {
          stateApplicationEvidence["normalizedOverridesApplied"].push_back({{"id", id}, {"value", value},
            {"controllerReadback", accepted}, {"queuedForFirstProcess", !isInstrument}});
          stateApplicationEvidence["lifecycleOrder"].push_back("controller.setParamNormalized(" + std::to_string(id) + ")");
        } else stateApplicationEvidence["normalizedOverridesTruncated"] = true;
      }
    }
  }
  json snapshot() {
    checked(processor->setProcessing(false), "Cannot suspend for state capture"); processing = false;
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
    checked(processor->setProcessing(true), "Cannot resume after state capture"); processing = true;
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
    const uint64_t processBlockIndex = processedBlocks;
    const int64_t processCursorStart = cursor;
    const bool diagnosticCandidate = captureFailureEvidence && !failureEvidenceCaptured && !isInstrument && frames > 0;
    json failureProfile = nullptr;
    if (diagnosticCandidate) failureProfile = request.value("failureProfile", json::object());
    const bool validFailureProfile = diagnosticCandidate && failureProfile.is_object() && failureProfile.contains("requestId") &&
      failureProfile["requestId"].is_string() && failureProfile["requestId"].get<std::string>().size() <= 180 &&
      failureProfile.contains("slotId") && failureProfile["slotId"].is_string() &&
      failureProfile["slotId"].get<std::string>().size() <= 128 && failureProfile.contains("trackId") &&
      failureProfile["trackId"].is_number_integer() && failureProfile.contains("sequence") &&
      failureProfile["sequence"].is_number_integer() && failureProfile.contains("serviceSessionId") &&
      failureProfile["serviceSessionId"].is_string() && failureProfile["serviceSessionId"].get<std::string>().size() <= 64;
    const json pendingParametersBefore = diagnosticCandidate
      ? (pendingEffectParameters.empty() ? json{{"values", json::array()}, {"truncated", false}} : parameterMapEvidence(pendingEffectParameters))
      : json(nullptr);
    json queuedSavedEffectParameters = diagnosticCandidate ? json::array() : json(nullptr);
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
        if (diagnosticCandidate && queuedSavedEffectParameters.size() < 64)
          queuedSavedEffectParameters.push_back({{"id", entry.first}, {"value", entry.second}});
      }
    }
    const json requestedProcessParameters = diagnosticCandidate ? request.value("parameters", json::array()) : json::array();
    if (request.contains("parameters")) applyParameters(request.at("parameters"), flush, flush ? -1 : frames);
    if (captureFailureEvidence && !firstProcessObserved) {
      firstProcessObserved = true;
      const json firstRequestProfile = validFailureProfile ? boundedRequestProfileEvidence(failureProfile, sampleRate) : json(nullptr);
      stateApplicationEvidence["firstProcess"] = {{"blockIndex", processBlockIndex}, {"cursorStart", processCursorStart},
        {"mode", mode == kRealtime ? "realtime" : "offline"}, {"requestProfile", firstRequestProfile},
        {"pendingSavedOverridesBefore", pendingParametersBefore},
        {"queuedSavedOverrides", queuedSavedEffectParameters},
        {"requestedOverrides", boundedArrayEvidence(requestedProcessParameters)}};
      stateApplicationEvidence["lifecycleOrder"].push_back("first processor.process after saved parameter queue and request overrides");
      firstProcessEvidence = {{"schema", 1}, {"pluginClassId", classId}, {"requestProfile", firstRequestProfile},
        {"frameIndex", processCursorStart}, {"blockIndex", processBlockIndex}, {"frames", frames},
        {"stateApplication", stateApplicationEvidence},
        {"stateSnapshot", {{"captured", false}, {"observation", "same-instance passive open/first-process audit; no component snapshot or suspension"}}}};
    }
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
    const bool auditCurrentBlock = captureBlockAudit && !isInstrument && frames > 0 && auditedBlocks < 64;
    const std::set<ParamID> auditedParameterIds = auditCurrentBlock ? blockAuditParameterIds : std::set<ParamID>{};
    auto readAuditedParameters = [&]() {
      json values = json::array();
      for (const auto id : auditedParameterIds) {
        const auto value = controller->getParamNormalized(id);
        values.push_back({{"id", id}, {"value", std::isfinite(value) && value >= 0 && value <= 1 ? json(value) : json(nullptr)}});
      }
      return json{{"values", values}, {"truncated", blockAuditParametersTruncated}};
    };
    const json parametersBeforeProcess = auditCurrentBlock ? readAuditedParameters() : json(nullptr);
    checked(processor->process(data), "Plugin process failed");
    const json parametersAfterProcess = auditCurrentBlock ? readAuditedParameters() : json(nullptr);
    if (captureFailureEvidence && !firstProcessEvidence.is_null()) {
      stateApplicationEvidence["firstProcess"]["processorCallResult"] = "kResultOk";
      firstProcessEvidence["processorCallResult"] = "kResultOk";
      firstProcessEvidence["stateApplication"] = stateApplicationEvidence;
    }
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
      if (output.silenceFlags & (uint64_t{1} << source)) continue;
      for (int i = 0; i < frames; ++i) {
        float sample = output.channelBuffers32[source][i];
        require(std::isfinite(sample), "Plugin produced non-finite audio");
        pcm[ch * frames + i] = sample;
      }
    }
    if (auditCurrentBlock) {
      json parameterOrder = json::array();
      if (!queuedSavedEffectParameters.empty()) parameterOrder.push_back("queue saved normalized overrides");
      if (!requestedProcessParameters.empty()) parameterOrder.push_back("apply request parameter overrides");
      parameterOrder.push_back("read controller normalized values before processor.process");
      parameterOrder.push_back("processor.process");
      parameterOrder.push_back("read controller normalized values after processor.process");
      blockEvidence = {{"schema", 1}, {"blockIndex", processBlockIndex}, {"frameIndex", processCursorStart}, {"frames", frames},
        {"processingMode", mode == kRealtime ? "realtime" : "offline"},
        {"requestProfile", validFailureProfile ? json{{"requestId", failureProfile.value("requestId", std::string())},
          {"sequence", failureProfile.value("sequence", -1)}, {"slotId", failureProfile.value("slotId", std::string())}} : json(nullptr)},
        {"input", stereoMetrics(inputAudio, frames)}, {"output", stereoMetrics(pcm, frames)},
        {"outputSilenceFlags", output.silenceFlags}, {"outputChannels", output.numChannels},
        {"parameterApplicationOrder", parameterOrder},
        {"controllerParametersBeforeProcess", parametersBeforeProcess},
        {"controllerParametersAfterProcess", parametersAfterProcess}};
      ++auditedBlocks;
    }
    if (captureFailureEvidence) ++processedBlocks;
    const auto inputPeak = diagnosticCandidate ? std::max_element(inputAudio.begin(), inputAudio.end(),
      [](float left, float right) { return std::abs(left) < std::abs(right); }) : inputAudio.end();
    const auto outputPeak = diagnosticCandidate ? std::max_element(pcm.begin(), pcm.end(),
      [](float left, float right) { return std::abs(left) < std::abs(right); }) : pcm.end();
    const bool inputMayExceedSilence = inputPeak != inputAudio.end() && std::abs(*inputPeak) > 1e-8f;
    const bool outputMayBeEffectivelySilent = frames > 0 && outputPeak != pcm.end() &&
      std::abs(*outputPeak) <= 1e-12 * std::sqrt(2.0 * frames);
    if (inputMayExceedSilence && outputMayBeEffectivelySilent && validFailureProfile) {
      const json inputMetrics = stereoMetrics(inputAudio, frames);
      const json outputMetrics = stereoMetrics(pcm, frames);
      if (inputMetrics.value("combinedRms", 0.0) > 1e-8 && outputMetrics.value("combinedRms", 0.0) <= 1e-12) {
        failureEvidenceCaptured = true;
        try {
          json controllerReadbacks = json::array();
          std::string readbackError;
          if (controller) {
            try {
              std::set<ParamID> relevantParameterIds;
              for (const auto& entry : overrides) { if (relevantParameterIds.size() == 64) break; relevantParameterIds.insert(entry.first); }
              for (const auto& entry : pendingEffectParameters) { if (relevantParameterIds.size() == 64) break; relevantParameterIds.insert(entry.first); }
              if (requestedProcessParameters.is_array()) for (const auto& parameter : requestedProcessParameters) {
                if (relevantParameterIds.size() == 64) break;
                if (parameter.is_object() && parameter.contains("id") && parameter.at("id").is_number_integer()) {
                  const auto rawId = parameter.at("id").get<int64_t>();
                  if (rawId >= 0 && rawId <= UINT32_MAX) relevantParameterIds.insert(static_cast<ParamID>(rawId));
                }
              }
              for (const auto id : relevantParameterIds) {
                const auto info = std::find_if(parameterInfo.begin(), parameterInfo.end(), [id](const ParameterInfo& parameter) { return parameter.id == id; });
                if (info == parameterInfo.end()) continue;
                const auto value = controller->getParamNormalized(id);
                controllerReadbacks.push_back({{"id", id}, {"name", StringConvert::convert(info->title)},
                  {"currentValue", std::isfinite(value) && value >= 0 && value <= 1 ? json(value) : json(nullptr)},
                  {"defaultValue", info->defaultNormalizedValue}, {"flags", info->flags}, {"stepCount", info->stepCount}});
              }
            } catch (const std::exception& error) { readbackError = error.what(); }
          }
          const json boundedRequestProfile = boundedRequestProfileEvidence(failureProfile, sampleRate);
          const auto outputSilenceFlags = data.outputs[0].silenceFlags;
          json processOrder = json::array();
          if (!queuedSavedEffectParameters.empty()) processOrder.push_back("queue saved normalized overrides");
          if (!requestedProcessParameters.empty()) processOrder.push_back("apply request parameter overrides");
          processOrder.push_back("processor.process");
          failureEvidence = {{"schema", 1}, {"helperSessionId", failureProfile.value("serviceSessionId", std::string())},
            {"helperProcessId", failureProfile.value("helperPid", 0)}, {"trackId", failureProfile.value("trackId", -1)},
            {"slotId", failureProfile.value("slotId", std::string())}, {"runtimeInstanceId", failureProfile.value("runtimeId", std::string())},
            {"requestId", failureProfile.value("requestId", std::string())}, {"sequence", failureProfile.value("sequence", -1)},
            {"requestProfile", boundedRequestProfile}, {"pluginClassId", classId},
            {"processingMode", mode == kRealtime ? "realtime" : "offline"},
            {"frameIndex", processCursorStart}, {"blockIndex", processBlockIndex}, {"frames", frames},
            {"input", inputMetrics}, {"output", outputMetrics},
            {"channels", {{"input", data.numInputs > 0 ? data.inputs[0].numChannels : 0},
              {"output", data.numOutputs > 0 ? data.outputs[0].numChannels : 0}, {"outputSilenceFlags", outputSilenceFlags}}},
            {"context", {{"sampleRate", sampleRate}, {"bpm", context.tempo}, {"projectTimeSamples", context.projectTimeSamples},
              {"projectTimeMusic", context.projectTimeMusic}, {"stateFlags", context.state}, {"processMode", data.processMode}}},
            {"parameters", {{"controllerReadbacksAfterProcess", controllerReadbacks},
              {"readbackError", readbackError}, {"savedPendingOverridesBeforeBlock", pendingParametersBefore},
              {"savedOverridesAfterBlock", parameterMapEvidence(overrides)},
              {"queuedSavedOverridesInBlock", queuedSavedEffectParameters},
              {"requestOverrides", boundedArrayEvidence(requestedProcessParameters)}}},
            {"stateApplication", stateApplicationEvidence},
            {"stateSnapshot", {{"captured", false}, {"observation", "same-instance state input/application audit; no post-failure snapshot taken"},
              {"reason", "The host snapshot calls setProcessing(false/true); avoid suspending or perturbing the active instance while returning this block."}}},
            {"lifecycle", {{"active", active}, {"processing", processing}, {"errors", stateApplicationEvidence.value("errors", json::array())}}},
            {"processOrder", processOrder}, {"processingError", nullptr}, {"parameterSettingError", nullptr}};
        } catch (const std::exception& error) {
          failureEvidence = {{"schema", 1}, {"requestId", failureProfile.value("requestId", std::string())},
            {"sequence", failureProfile.value("sequence", -1)}, {"pluginClassId", classId},
            {"frameIndex", processCursorStart}, {"blockIndex", processBlockIndex},
            {"input", inputMetrics}, {"output", outputMetrics}, {"evidenceCaptureError", error.what()},
            {"stateApplication", stateApplicationEvidence}, {"processingError", nullptr}};
        }
      }
    }
    cursor += frames;
    return pcm;
  }
};

// Binary framing: little-endian uint32 JSON length, uint32 PCM byte length,
// UTF-8 JSON, then planar stereo float32 PCM. No per-sample IPC.
void reply(const json& message, const std::vector<float>& pcm = {}) {
  const auto text = message.dump();
  auto put32 = [](uint32_t n) { for (int i = 0; i < 4; ++i) std::cout.put(static_cast<char>((n >> (8 * i)) & 255)); };
  put32(static_cast<uint32_t>(text.size())); put32(static_cast<uint32_t>(pcm.size() * sizeof(float)));
  std::cout.write(text.data(), text.size());
  if (!pcm.empty()) std::cout.write(reinterpret_cast<const char*>(pcm.data()), pcm.size() * sizeof(float));
  std::cout.flush();
}
int main() {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(com)) return 2;
#endif
  PlugProvider::setErrorStream(&std::cerr);
  // Reserve stdout exclusively for framed protocol; plugin debug logs using
  // stdout will be detected as a protocol error by the parent, not played.
  std::unique_ptr<Instance> instance;
  std::string line;
  while (true) {
    line.clear();
    char c;
    while (std::cin.get(c) && c != '\n') {
      line.push_back(c);
      if (line.size() > kMaxRequest) { reply({{"ok", false}, {"error", "Request exceeds 8 MiB limit"}}); return 1; }
    }
    if (line.empty() && !std::cin) break;
    try {
      auto request = json::parse(line);
      auto command = request.at("command").get<std::string>();
      if (command == "scan") {
        require(!instance, "Scan requires a separate helper");
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
        instance = std::make_unique<Instance>();
        auto result = instance->open(request);
        reply({{"ok", true}, {"plugin", result}});
      } else if (command == "process") {
        require(bool(instance), "No plugin instance loaded");
        auto pcm = instance->process(request);
        json response{{"ok", true}, {"frames", pcm.size() / 2}, {"channels", 2}};
        const auto firstProcessEvidence = instance->takeFirstProcessEvidence();
        if (!firstProcessEvidence.is_null()) response["firstProcessEvidence"] = firstProcessEvidence;
        const auto failureEvidence = instance->takeFailureEvidence();
        if (!failureEvidence.is_null()) response["failureEvidence"] = failureEvidence;
        const auto blockEvidence = instance->takeBlockEvidence();
        if (!blockEvidence.is_null()) response["blockEvidence"] = blockEvidence;
        reply(response, pcm);
      } else if (command == "parameters") {
        require(bool(instance), "No plugin instance loaded");
        // Instruments retain the established zero-sample flush contract. Audio
        // effects defer controller values to the next real audio block because
        // some processors ignore parameter queues on zero-sample calls.
        if (instance->isInstrumentKind())
          instance->process({{"frames", 0}, {"events", json::array()}, {"bpm", 120}, {"parameters", request.at("parameters")}}, true);
        else instance->applyParameters(request.at("parameters"), false, -1, false);
        reply({{"ok", true}, {"parameters", instance->metadata()}});
      } else if (command == "snapshot") {
        require(bool(instance), "No plugin instance loaded");
        reply({{"ok", true}, {"state", instance->snapshot()}});
      } else if (command == "close") {
        instance.reset(); reply({{"ok", true}});
      } else throw std::runtime_error("Unknown command");
    } catch (const std::exception& error) {
      // Invalid state, process errors and partial initialization invalidate this
      // instance. Caller keeps its original project state and can reopen/retry.
      instance.reset();
      reply({{"ok", false}, {"error", error.what()}});
    }
  }
  instance.reset();
#ifdef _WIN32
  CoUninitialize();
#endif
  return 0;
}
