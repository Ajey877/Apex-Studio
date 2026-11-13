// The genuine VSTGUI editor for ApexAcceptanceGain.
// See acceptance-fixture.hpp for provenance.
//
// This is the ONLY translation unit in the fixture that depends on VSTGUI. Keeping
// it separate means the processor, controller and their behavioural test build on a
// host without a GUI toolchain (headless Linux has no X11), while the Windows build
// links this file and gets a real editor.
#include "acceptance-fixture-controller.hpp"

#if APEX_ACCEPTANCE_FIXTURE_HAS_VSTGUI

#include "vstgui/plugin-bindings/vst3editor.h"

namespace ApexAcceptanceGain {

IPlugView* createGainEditor(EditController* controller) {
  // A genuine VSTGUI editor: VST3Editor parses the packaged uidesc, builds the real
  // CControls (the Gain slider and value field), and routes their edits through the
  // component handler as beginEdit / performEdit / endEdit for kParamGain. That is
  // the shipping editor path, not an Apex-drawn substitute.
  return new VSTGUI::VST3Editor(controller, "view", "acceptancegain.uidesc");
}

} // namespace ApexAcceptanceGain

#else

namespace ApexAcceptanceGain {

// No GUI toolchain in this build: the fixture still loads, processes audio and
// exposes its parameter, but reports no editor. The acceptance harness treats a
// missing editor as NOT_VERIFIED rather than a pass.
IPlugView* createGainEditor(EditController*) { return nullptr; }

} // namespace ApexAcceptanceGain

#endif
