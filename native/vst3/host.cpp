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
#include <memory>
#include <map>
#include <set>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <windows.h>
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
bool instrument(const VST3::Hosting::ClassInfo& info) {
  const auto& categories = info.subCategories();
  return info.category() == kVstAudioEffectClass &&
    std::find(categories.begin(), categories.end(), "Instrument") != categories.end();
}
json identity(const VST3::Hosting::ClassInfo& info) {
  return {{"classId", info.ID().toString()}, {"name", info.name()},
    {"vendor", info.vendor()}, {"version", info.version()}, {"categories", info.subCategories()}};
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
  std::set<ParamID> parameterIds;
  std::set<ParamID> readOnlyIds;
  std::map<ParamID, ParamValue> overrides;
  std::string classId;
  double sampleRate = 48000;
  int mode = kOffline;
  int64_t cursor = 0;
  bool active = false;
  bool processing = false;
public:
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
      require(instrument(info), "Selected class is not a VST3 instrument");
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
    require(component->getBusCount(kAudio, kInput) == 0, "Prototype accepts instruments without audio inputs only");
    require(component->getBusCount(kAudio, kOutput) >= 1 && component->getBusCount(kEvent, kInput) >= 1,
      "Instrument requires an audio output and event input");
    BusInfo bus{};
    checked(component->getBusInfo(kAudio, kOutput, 0, bus), "Cannot query main output bus");
    require(bus.busType == kMain && (bus.channelCount == 1 || bus.channelCount == 2), "Only mono/stereo main output supported");
    for (int32 i = 0; i < component->getBusCount(kAudio, kOutput); ++i)
      checked(component->activateBus(kAudio, kOutput, i, i == 0), "Cannot configure audio output bus");
    for (int32 i = 0; i < component->getBusCount(kEvent, kInput); ++i)
      checked(component->activateBus(kEvent, kInput, i, i == 0), "Cannot configure MIDI input bus");
    sampleRate = real(request, "sampleRate", 8000, 192000);
    const auto modeName = request.value("mode", std::string("offline"));
    require(modeName == "offline" || modeName == "realtime", "Unknown processing mode");
    mode = modeName == "offline" ? kOffline : kRealtime;
    ProcessSetup setup{mode, kSample32, kMaxBlock, sampleRate};
    checked(processor->setupProcessing(setup), "setupProcessing failed");
    json paramInfo = json::array();
    if (controller) {
      require(controller->getParameterCount() <= 4096, "Too many plugin parameters");
      for (int32 i = 0; i < controller->getParameterCount(); ++i) {
        ParameterInfo info{};
        checked(controller->getParameterInfo(i, info), "Cannot query plugin parameter");
        parameterIds.insert(info.id);
        if (info.flags & ParameterInfo::kIsReadOnly) readOnlyIds.insert(info.id);
        paramInfo.push_back({{"id", info.id}, {"name", StringConvert::convert(info.title)},
          {"defaultValue", info.defaultNormalizedValue}, {"flags", info.flags}});
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
    data.prepare(*component, kMaxBlock, kSample32);
    checked(component->setActive(true), "setActive failed"); active = true;
    checked(processor->setProcessing(true), "setProcessing failed"); processing = true;
    result["parameters"] = paramInfo;
    result["latencySamples"] = processor->getLatencySamples();
    result["tailSamples"] = processor->getTailSamples();
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
    if (state.contains("parameters")) applyParameters(state.at("parameters"));
  }
  void applyParameters(const json& changes) {
    require(changes.is_array() && changes.size() <= 4096, "Invalid parameter list");
    for (const auto& change : changes) {
      require(change.at("id").is_number_unsigned() || change.at("id").is_number_integer(), "Parameter ID must be an integer");
      auto rawId = change.at("id").get<int64_t>();
      require(rawId >= 0 && rawId <= UINT32_MAX, "Parameter ID out of range");
      auto id = static_cast<ParamID>(rawId);
      require(parameterIds.count(id) != 0, "Saved parameter ID no longer exists: " + std::to_string(id));
      require(!readOnlyIds.count(id), "Cannot restore a read-only parameter");
      auto value = real(change, "value", 0, 1);
      int32 queueIndex = 0, pointIndex = 0;
      auto* queue = parameters.addParameterData(id, queueIndex);
      require(queue != nullptr, "Parameter queue full");
      checked(queue->addPoint(0, value, pointIndex), "Cannot queue parameter");
      checked(controller->setParamNormalized(id, value), "Controller rejected parameter");
      overrides[id] = value;
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
  std::vector<float> process(const json& request) {
    require(processing, "Plugin processing is suspended; reopen instance");
    const int frames = integer(request, "frames", 1, kMaxBlock);
    auto inputEvents = request.value("events", json::array());
    require(inputEvents.is_array() && inputEvents.size() <= 4096, "Too many events in block");
    events.clear(); outputEvents.clear(); outputParameters.clearQueue();
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
    if (request.contains("parameters")) applyParameters(request.at("parameters"));
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
    data.processMode = mode; data.numSamples = frames;
    data.inputEvents = &events; data.outputEvents = &outputEvents;
    data.inputParameterChanges = &parameters; data.outputParameterChanges = &outputParameters;
    data.processContext = &context;
    checked(processor->process(data), "Plugin process failed");
    parameters.clearQueue();
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
        json plugins = json::array();
        for (const auto& info : module->getFactory().classInfos()) if (instrument(info)) plugins.push_back(identity(info));
        reply({{"ok", true}, {"plugins", plugins}});
      } else if (command == "open") {
        require(!instance, "Close current instance before opening another");
        instance = std::make_unique<Instance>();
        auto result = instance->open(request);
        reply({{"ok", true}, {"plugin", result}});
      } else if (command == "process") {
        require(bool(instance), "No plugin instance loaded");
        auto pcm = instance->process(request);
        reply({{"ok", true}, {"frames", pcm.size() / 2}, {"channels", 2}}, pcm);
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
