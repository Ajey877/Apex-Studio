// ApexAcceptanceGain controller declaration. See acceptance-fixture.hpp.
#pragma once

#include "acceptance-fixture.hpp"

namespace ApexAcceptanceGain {

class AcceptanceGainController;

/**
 * Builds the genuine VSTGUI editor for the controller.
 *
 * Implemented in acceptance-fixture-editor.cpp (VSTGUI dependency) so that every
 * other part of the fixture stays free of GUI headers. Returns nullptr when the
 * build has no VSTGUI support.
 */
IPlugView* createGainEditor(EditController* controller);

/** Exposes the single Gain parameter and returns a genuine VSTGUI editor. */
class AcceptanceGainController final : public EditControllerEx1 {
public:
  AcceptanceGainController() = default;
  static FUnknown* createInstance(void*);

  tresult PLUGIN_API initialize(FUnknown* context) override;
  tresult PLUGIN_API terminate() override;
  IPlugView* PLUGIN_API createView(FIDString name) override;
  tresult PLUGIN_API setComponentState(IBStream* state) override;
};

} // namespace ApexAcceptanceGain
