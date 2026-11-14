// ApexAcceptanceGain controller + genuine VSTGUI editor.
// See acceptance-fixture.hpp for provenance.
//
// Why this is a real editor rather than a stub:
//   - createView(kEditor) returns a VSTGUI VST3Editor bound to the packaged
//     uidesc, which builds real CControls (the Gain slider and its value field);
//   - each control's control-tag resolves through this controller's parameter set,
//     so dragging the slider emits IComponentHandler::beginEdit / performEdit /
//     endEdit for kParamGain -- a tag the controller genuinely exposes, which is
//     exactly the property DataExchange lacks;
//   - setComponentState pushes the component's saved value into the controller, so
//     the editor shows the value the project actually has.
#include "acceptance-fixture-controller.hpp"

#include "base/source/fstreamer.h"
#include "pluginterfaces/base/ustring.h"

namespace ApexAcceptanceGain {

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

/** A plain automatable range parameter that prints and parses decibels. */
class GainParameter final : public Parameter {
public:
  GainParameter(ParamID id, const TChar* title, ParamValue defaultValue)
  : Parameter(title, id, USTRING("dB"), defaultValue, 0, ParameterInfo::kCanAutomate) {}

  void toString(ParamValue normValue, String128 string) const override {
    // String128 is a TChar[128] that decays to a pointer in this signature, so
    // USTRINGSIZE (sizeof-based) would compute the size of a pointer. The contract
    // guarantees 128 characters, and fromString below already uses 128.
    UString(string, 128).printFloat(gainDbFromNormalized(normValue), 2);
  }

  bool fromString(const TChar* string, ParamValue& normValue) const override {
    UString wrapper(const_cast<TChar*>(string), 128);
    double db = 0.0;
    if (wrapper.scanFloat(db) != kResultOk) return false;
    // Exact inverse of gainDbFromNormalized.
    const double clampedDb = db < -24.0 ? -24.0 : (db > 12.0 ? 12.0 : db);
    normValue = clampedDb <= 0.0 ? ((clampedDb + 24.0) / 24.0) * 0.5
                                 : 0.5 + (clampedDb / 12.0) * 0.5;
    return true;
  }
};

} // namespace

FUnknown* AcceptanceGainController::createInstance(void*) {
  return static_cast<IEditController*>(new AcceptanceGainController());
}

tresult PLUGIN_API AcceptanceGainController::initialize(FUnknown* context) {
  const tresult result = EditControllerEx1::initialize(context);
  if (result != kResultOk) return result;
  parameters.addParameter(new GainParameter(kParamGain, USTRING("Gain"), kDefaultGainNormalized));
  return kResultOk;
}

tresult PLUGIN_API AcceptanceGainController::terminate() {
  return EditControllerEx1::terminate();
}

IPlugView* PLUGIN_API AcceptanceGainController::createView(FIDString name) {
  if (!name || !FIDStringsEqual(name, ViewType::kEditor)) return nullptr;
  // Constructed in acceptance-fixture-editor.cpp, which is the only translation
  // unit that depends on VSTGUI. Keeping it separate lets the DSP/parameter halves
  // of this fixture build and be tested on a host without a GUI toolchain.
  return createGainEditor(this);
}

tresult PLUGIN_API AcceptanceGainController::setComponentState(IBStream* state) {
  if (!state) return kResultFalse;
  IBStreamer streamer(state, kLittleEndian);
  double savedGain = kDefaultGainNormalized;
  if (!streamer.readDouble(savedGain)) return kResultFalse;
  if (!(savedGain >= 0.0 && savedGain <= 1.0)) return kResultFalse;
  // Push the component's value into the controller so the editor reflects it.
  return setParamNormalized(kParamGain, savedGain);
}

} // namespace ApexAcceptanceGain
