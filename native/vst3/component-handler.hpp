#pragma once

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include <atomic>

namespace ApexVst3Host {

class HostComponentHandler final : public Steinberg::Vst::IComponentHandler {
  std::atomic<Steinberg::uint32> refCount{1};
  std::atomic<Steinberg::int32> pendingRestartFlags{0};

public:
  Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID _iid, void** obj) override {
    if (Steinberg::FUnknownPrivate::iidEqual(_iid, Steinberg::Vst::IComponentHandler::iid) ||
        Steinberg::FUnknownPrivate::iidEqual(_iid, Steinberg::FUnknown::iid)) {
      addRef();
      *obj = static_cast<Steinberg::Vst::IComponentHandler*>(this);
      return Steinberg::kResultTrue;
    }
    *obj = nullptr;
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

  Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID) override {
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID, Steinberg::Vst::ParamValue) override {
    return Steinberg::kResultOk;
  }

  Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID) override {
    return Steinberg::kResultOk;
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
