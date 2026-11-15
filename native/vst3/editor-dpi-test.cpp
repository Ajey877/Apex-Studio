// Regression tests for the native editor's DPI sizing decisions (editor-dpi.hpp).
//
// These are platform-independent logic tests. They do NOT stand in for Windows
// acceptance: real display scaling is exercised by
// scripts/native-editor-dpi-acceptance.mjs against a live HWND.
#include "editor-dpi.hpp"

#include <cstdlib>
#include <iostream>

using namespace ApexVst3Host::dpi;

namespace {

int failures = 0;

void expect(bool condition, const char* message) {
  if (condition) return;
  std::cerr << "editor-dpi-test FAILED: " << message << "\n";
  ++failures;
}

void testScaleFactor() {
  expect(scaleFactorForDpi(96) == 1.f, "96 DPI is scale 1.0");
  expect(scaleFactorForDpi(120) == 1.25f, "120 DPI is scale 1.25");
  expect(scaleFactorForDpi(144) == 1.5f, "144 DPI is scale 1.5");
  expect(scaleFactorForDpi(192) == 2.f, "192 DPI is scale 2.0");
  expect(scaleFactorForDpi(0) == 1.f, "an unknown DPI falls back to 1.0, never 0");
}

void testFrameArithmetic() {
  const Frame at96{16, 39};
  const Frame at144{22, 56};
  expect(outerForClient({350, 120}, at96) == Size{366, 159}, "outer size adds the 96 DPI frame");
  expect(outerForClient({525, 180}, at144) == Size{547, 236}, "outer size adds the 144 DPI frame");
  expect(clientForOuter({547, 236}, at144) == Size{525, 180}, "client size removes the same frame");
  // The defect this guards: sizing a 144 DPI window with the 96 DPI frame leaves
  // the client area short by the difference between the two frames.
  expect(clientForOuter(outerForClient({525, 180}, at96), at144) != Size{525, 180},
    "a frame measured for another DPI does not yield the requested client size");
  expect(clientForOuter({4, 4}, at96) == Size{0, 0}, "a degenerate outer rect never goes negative");
}

void testRescale() {
  expect(rescaleClient({350, 120}, 96, 144) == Size{525, 180}, "100% -> 150%");
  expect(rescaleClient({350, 120}, 96, 120) == Size{438, 150}, "100% -> 125% rounds to nearest");
  expect(rescaleClient({525, 180}, 144, 96) == Size{350, 120}, "150% -> 100%");
  expect(rescaleClient({350, 120}, 0, 0) == Size{350, 120}, "unknown DPI values are treated as 96");
}

ScaleOutcome vstguiStyle(Size before, Size requested) {
  ScaleOutcome outcome;
  outcome.clientBefore = before;
  outcome.hostProposal = requested;
  outcome.hostProposalValid = true;
  outcome.scaleSupported = true;
  outcome.scaleApplied = true;
  outcome.pluginResized = true;
  outcome.pluginRequested = requested;
  outcome.pluginSizeKnown = true;
  outcome.pluginSize = requested;
  outcome.resizable = true;
  return outcome;
}

void testPluginRequestedSizeWins() {
  // A scale-aware plug-in (VSTGUI) asks for 437x150 at 125%: floor(350 * 1.25).
  auto outcome = vstguiStyle({350, 120}, {437, 150});
  outcome.hostProposal = {438, 150};  // Windows rounds differently
  const auto plan = planClientAfterScale(outcome);
  expect(plan.source == ClientSource::PluginRequested, "the plug-in's requested size is used");
  expect(plan.client == Size{437, 150}, "the plug-in's rounding wins over Windows' suggestion");
  expect(!plan.notifyPlugin, "resizeView already delivered onSize; it is not repeated");
  expect(!plan.constrain, "a size the plug-in asked for is not re-constrained");
}

void testNoDoubleScaling() {
  // The original defect: the suggested rect (525x180) was applied first, the
  // plug-in saw it as a resize at the old scale, then scaled it again to 787x270.
  // The plan must never produce more than one application of the scale.
  const auto plan = planClientAfterScale(vstguiStyle({350, 120}, {525, 180}));
  expect(plan.client == Size{525, 180}, "100% -> 150% yields exactly one scale step");
  expect(plan.client.width < 600, "the view is not scaled twice");
}

void testResizableScaleAwareWithoutRequest() {
  // Accepts the scale, is resizable, but leaves sizing to the host.
  ScaleOutcome outcome;
  outcome.clientBefore = {640, 420};
  outcome.hostProposal = {960, 630};
  outcome.hostProposalValid = true;
  outcome.scaleSupported = true;
  outcome.scaleApplied = true;
  outcome.pluginSizeKnown = true;
  outcome.pluginSize = {640, 420};
  outcome.resizable = true;
  const auto plan = planClientAfterScale(outcome);
  expect(plan.source == ClientSource::HostProposed, "the host proposes Windows' scaled size");
  expect(plan.client == Size{960, 630}, "the proposal is the linearly scaled client");
  expect(plan.notifyPlugin, "a host-chosen size is delivered with onSize");
  expect(plan.constrain, "a host-chosen size goes through checkSizeConstraint first");
}

void testScaleAwareThatChangedItsOwnSize() {
  // Accepted the scale and now REPORTS a new size without calling resizeView.
  ScaleOutcome outcome;
  outcome.clientBefore = {400, 300};
  outcome.hostProposal = {600, 450};
  outcome.hostProposalValid = true;
  outcome.scaleSupported = true;
  outcome.scaleApplied = true;
  outcome.pluginSizeKnown = true;
  outcome.pluginSize = {598, 449};
  outcome.resizable = true;
  const auto plan = planClientAfterScale(outcome);
  expect(plan.source == ClientSource::PluginReported, "the size the plug-in reports is honoured");
  expect(plan.client == Size{598, 449}, "the reported size is used verbatim");
  expect(plan.notifyPlugin, "the window follows and the plug-in is told");
}

void testPluginWithoutScaleSupportKeepsItsPixels() {
  ScaleOutcome outcome;
  outcome.clientBefore = {350, 120};
  outcome.hostProposal = {525, 180};
  outcome.hostProposalValid = true;
  outcome.scaleSupported = false;
  outcome.pluginSizeKnown = true;
  outcome.pluginSize = {350, 120};
  outcome.resizable = true;
  const auto plan = planClientAfterScale(outcome);
  expect(plan.source == ClientSource::PluginReported, "a non-scaling plug-in keeps its own size");
  expect(plan.client == Size{350, 120}, "no blank area is added around an unscaled editor");
  expect(!plan.notifyPlugin, "an unchanged size is not re-announced");
}

void testRejectedScaleIsNotTreatedAsApplied() {
  ScaleOutcome outcome;
  outcome.clientBefore = {350, 120};
  outcome.hostProposal = {525, 180};
  outcome.hostProposalValid = true;
  outcome.scaleSupported = true;
  outcome.scaleApplied = false;  // kResultFalse / kNotImplemented
  outcome.pluginSizeKnown = true;
  outcome.pluginSize = {350, 120};
  outcome.resizable = true;
  const auto plan = planClientAfterScale(outcome);
  expect(plan.client == Size{350, 120}, "a rejected scale leaves the editor at its own size");
  expect(plan.source == ClientSource::PluginReported, "the plug-in's size is still the source");
}

void testFixedSizePluginThatScales() {
  // Fixed-size (canResize == false) but scale-aware, without a resizeView call.
  ScaleOutcome outcome;
  outcome.clientBefore = {300, 200};
  outcome.hostProposal = {450, 300};
  outcome.hostProposalValid = true;
  outcome.scaleSupported = true;
  outcome.scaleApplied = true;
  outcome.pluginSizeKnown = true;
  outcome.pluginSize = {450, 300};
  outcome.resizable = false;
  const auto plan = planClientAfterScale(outcome);
  expect(plan.client == Size{450, 300}, "a fixed-size editor's new reported size is applied");
  expect(plan.source == ClientSource::PluginReported, "it is never host-proposed");
  expect(!plan.constrain, "a fixed-size editor is not offered an arbitrary size");
}

void testInvalidSizesFallBack() {
  ScaleOutcome outcome;
  outcome.clientBefore = {350, 120};
  outcome.pluginResized = true;
  outcome.pluginRequested = {0, 0};      // nonsense request
  outcome.pluginSizeKnown = true;
  outcome.pluginSize = {100000, 5};      // nonsense report
  auto plan = planClientAfterScale(outcome);
  expect(plan.source == ClientSource::Unchanged, "unusable sizes leave the client untouched");
  expect(plan.client == Size{350, 120}, "the previous client size is kept");
  expect(!plan.notifyPlugin, "nothing is announced when nothing changed");

  outcome.pluginSizeKnown = false;
  plan = planClientAfterScale(outcome);
  expect(plan.client == Size{350, 120}, "an unknown plug-in size also keeps the client");
}

void testFixedSizePinning() {
  expect(shouldPinFixedSize(false, false, false, false), "a fixed-size editor is pinned at rest");
  expect(!shouldPinFixedSize(true, false, false, false), "a resizable editor is never pinned");
  expect(!shouldPinFixedSize(false, true, false, false),
    "a plug-in-requested resize is not clamped to the size it had before the request");
  expect(!shouldPinFixedSize(false, false, true, false), "a DPI transition is not clamped to the old size");
  expect(!shouldPinFixedSize(false, false, false, true), "fitting the client area is not clamped");
}

} // namespace

int main() {
  testScaleFactor();
  testFrameArithmetic();
  testRescale();
  testPluginRequestedSizeWins();
  testNoDoubleScaling();
  testResizableScaleAwareWithoutRequest();
  testScaleAwareThatChangedItsOwnSize();
  testPluginWithoutScaleSupportKeepsItsPixels();
  testRejectedScaleIsNotTreatedAsApplied();
  testFixedSizePluginThatScales();
  testInvalidSizesFallBack();
  testFixedSizePinning();
  if (failures) {
    std::cerr << "editor-dpi-test: " << failures << " failure(s)\n";
    return 1;
  }
  std::cout << "editor-dpi-test: all checks passed\n";
  return 0;
}
