#pragma once

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include <atomic>
#include <cmath>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace ApexVst3Host {

struct ParameterEditEvent {
  std::string type;
  Steinberg::Vst::ParamID id = 0;
  Steinberg::Vst::ParamValue value = 0.;
};

class HostComponentHandler final : public Steinberg::Vst::IComponentHandler,
                                   public Steinberg::Vst::IComponentHandler2 {
  static constexpr size_t kMaxQueuedEditEvents = 4096;
  static constexpr size_t kMaxOpenEdits = 256;
  static constexpr size_t kMaxGroupDepth = 64;

  std::atomic<Steinberg::uint32> refCount{1};
  std::atomic<Steinberg::int32> pendingRestartFlags{0};
  mutable std::mutex editMutex;
  bool captureEdits = false;
  bool pluginDirty = false;
  bool editQueueOverflow = false;
  size_t groupDepth = 0;
  std::set<Steinberg::Vst::ParamID> parameterIds;
  std::set<Steinberg::Vst::ParamID> readOnlyIds;
  std::set<Steinberg::Vst::ParamID> activeEdits;
  std::map<Steinberg::Vst::ParamID, Steinberg::Vst::ParamValue> editedValues;
  std::deque<ParameterEditEvent> editEvents;

  bool validEditableId(Steinberg::Vst::ParamID id) const {
    return parameterIds.count(id) != 0 && readOnlyIds.count(id) == 0;
  }

  bool queueEvent(const ParameterEditEvent& event) {
    if (editEvents.size() >= kMaxQueuedEditEvents) {
      editQueueOverflow = true;
      return false;
    }
    editEvents.push_back(event);
    return true;
  }

public:
  Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID _iid, void** obj) override {
    if (!obj) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    if (Steinberg::FUnknownPrivate::iidEqual(_iid, Steinberg::Vst::IComponentHandler::iid) ||
        Steinberg::FUnknownPrivate::iidEqual(_iid, Steinberg::FUnknown::iid)) {
      addRef();
      *obj = static_cast<Steinberg::Vst::IComponentHandler*>(this);
      return Steinberg::kResultTrue;
    }
    if (Steinberg::FUnknownPrivate::iidEqual(_iid, Steinberg::Vst::IComponentHandler2::iid)) {
      addRef();
      *obj = static_cast<Steinberg::Vst::IComponentHandler2*>(this);
      return Steinberg::kResultTrue;
    }
    return Steinberg::kNoInterface;
  }

  Steinberg::uint32 PLUGIN_API addRef() override {
    return refCount.fetch_add(1, std::memory_order_relaxed) + 1;
  }

  Steinberg::uint32 PLUGIN_API release() override {
    const Steinberg::uint32 remaining = refCount.fetch_sub(1, std::memory_order_acq_rel) - 1;
    if (remaining == 0) delete this;
    return remaining;
  }

  void enableParameterCapture(const std::set<Steinberg::Vst::ParamID>& ids,
                              const std::set<Steinberg::Vst::ParamID>& readOnly) {
    std::lock_guard<std::mutex> lock(editMutex);
    parameterIds = ids;
    readOnlyIds = readOnly;
    activeEdits.clear();
    editedValues.clear();
    editEvents.clear();
    pluginDirty = false;
    editQueueOverflow = false;
    groupDepth = 0;
    captureEdits = true;
  }

  void disableParameterCapture() noexcept {
    std::lock_guard<std::mutex> lock(editMutex);
    captureEdits = false;
    activeEdits.clear();
  }

  Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID id) override {
    std::lock_guard<std::mutex> lock(editMutex);
    if (!captureEdits) return Steinberg::kResultOk;
    if (!validEditableId(id) || activeEdits.size() >= kMaxOpenEdits || !activeEdits.insert(id).second) {
      return Steinberg::kResultFalse;
    }
    return queueEvent({"begin", id, 0.}) ? Steinberg::kResultOk : Steinberg::kResultFalse;
  }

  Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID id,
                                             Steinberg::Vst::ParamValue value) override {
    std::lock_guard<std::mutex> lock(editMutex);
    if (!captureEdits) return Steinberg::kResultOk;
    if (!validEditableId(id) || activeEdits.count(id) == 0 || !std::isfinite(value) || value < 0. || value > 1.) {
      return Steinberg::kResultFalse;
    }

    // Keep the final validated value even when a noisy plug-in has saturated the
    // drain queue. Coalesce pending perform events for the same parameter; the
    // project only needs the final normalized value and polling remains bounded.
    editedValues[id] = value;
    for (auto it = editEvents.rbegin(); it != editEvents.rend(); ++it) {
      if (it->type == "end" && it->id == id) break;
      if (it->type == "perform" && it->id == id) {
        it->value = value;
        return Steinberg::kResultOk;
      }
    }
    return queueEvent({"perform", id, value}) ? Steinberg::kResultOk : Steinberg::kResultFalse;
  }

  Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID id) override {
    std::lock_guard<std::mutex> lock(editMutex);
    if (!captureEdits) return Steinberg::kResultOk;
    if (activeEdits.erase(id) == 0) return Steinberg::kResultFalse;
    return queueEvent({"end", id, 0.}) ? Steinberg::kResultOk : Steinberg::kResultFalse;
  }

  Steinberg::tresult PLUGIN_API setDirty(Steinberg::TBool state) override {
    std::lock_guard<std::mutex> lock(editMutex);
    if (captureEdits) pluginDirty = state != 0;
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API requestOpenEditor(Steinberg::FIDString name) override {
    std::lock_guard<std::mutex> lock(editMutex);
    if (!captureEdits || !name || std::string(name) != Steinberg::Vst::ViewType::kEditor) {
      return Steinberg::kResultFalse;
    }
    // This dedicated editor process already owns its one native view. Never
    // create a second top-level window from a plug-in callback.
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API startGroupEdit() override {
    std::lock_guard<std::mutex> lock(editMutex);
    if (!captureEdits) return Steinberg::kResultOk;
    if (groupDepth >= kMaxGroupDepth) return Steinberg::kResultFalse;
    ++groupDepth;
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API finishGroupEdit() override {
    std::lock_guard<std::mutex> lock(editMutex);
    if (!captureEdits) return Steinberg::kResultOk;
    if (groupDepth == 0) return Steinberg::kResultFalse;
    --groupDepth;
    return Steinberg::kResultOk;
  }

  std::vector<ParameterEditEvent> drainEditEvents() {
    std::lock_guard<std::mutex> lock(editMutex);
    std::vector<ParameterEditEvent> result(editEvents.begin(), editEvents.end());
    editEvents.clear();
    return result;
  }

  std::map<Steinberg::Vst::ParamID, Steinberg::Vst::ParamValue> editedParameterValues() const {
    std::lock_guard<std::mutex> lock(editMutex);
    return editedValues;
  }

  std::set<Steinberg::Vst::ParamID> activeEditIds() const {
    std::lock_guard<std::mutex> lock(editMutex);
    return activeEdits;
  }

  bool consumeDirty() {
    std::lock_guard<std::mutex> lock(editMutex);
    const bool value = pluginDirty;
    pluginDirty = false;
    return value;
  }

  bool editQueueOverflowed() const {
    std::lock_guard<std::mutex> lock(editMutex);
    return editQueueOverflow;
  }

  Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32 flags) override {
    if (flags > 0) {
      pendingRestartFlags.fetch_or(flags, std::memory_order_acq_rel);
    }
    return Steinberg::kResultOk;
  }

  Steinberg::int32 consumeRestartFlags() noexcept {
    return pendingRestartFlags.exchange(0, std::memory_order_acq_rel);
  }

  Steinberg::int32 peekRestartFlags() const noexcept {
    return pendingRestartFlags.load(std::memory_order_acquire);
  }
};

} // namespace ApexVst3Host
