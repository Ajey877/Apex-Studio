// Apex Studio VST3 acceptance fixture: "ApexAcceptanceGain".
//
// PROVENANCE
// ----------
// This is original Apex Studio code, written for this repository, licensed under
// the same terms as the rest of Apex Studio. It is NOT copied from a Steinberg
// sample: it uses the pinned VST3 SDK (GPLv3 / Steinberg proprietary dual licence,
// see build/native-deps/vst3sdk/LICENSE.txt) and the VSTGUI submodule of that SDK
// only as libraries. No SDK or VSTGUI source is modified.
//
// WHY IT EXISTS
// -------------
// The packaged editor acceptance needs a plug-in that is simultaneously:
//   1. a stereo-in/stereo-out audio effect the Mixer accepts (no event input bus,
//      because the host deliberately refuses effects that declare one),
//   2. an effect with a genuine IPlugView editor,
//   3. an effect whose controller exposes exactly the parameters its own editor
//      edits, so beginEdit/performEdit/endEdit reference known, writable ParamIDs.
// No sample in the pinned SDK satisfies all three at once:
//   - AGain            : has an editor, but declares an event input bus.
//   - DataExchange     : its editor drives UI-only tags the controller never
//                        exposes, so its callbacks are correctly rejected.
//   - panner           : mono input; the host requires stereo in and out.
//   - utf16name        : createView returns nullptr (no editor).
//   - adelay/syncdelay : no editor on Windows.
//   - mda-vst3 (28)    : no editor at all.
// Rather than weaken a host policy to accommodate a sample (refusing event-input
// effects; rejecting unknown ParamIDs), this fixture is purpose-built to satisfy
// the policies as they stand.
//
// SCOPE
// -----
// Test-only. Built only when the native acceptance fixture option is ON and never
// staged into packaged user builds.
#pragma once

#include "public.sdk/source/vst/vstsinglecomponenteffect.h"
#include "public.sdk/source/vst/vsteditcontroller.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"

#include <atomic>
#include <cmath>
#include <string>

namespace ApexAcceptanceGain {

using namespace Steinberg;
using namespace Steinberg::Vst;

// Class IDs are fixed so acceptance scripts can refer to them by name and the
// identity survives rebuilds.
static const FUID kProcessorUID(0x41504558, 0x41434741, 0x494E0001, 0x00000001);
static const FUID kControllerUID(0x41504558, 0x41434741, 0x494E0002, 0x00000002);

class AcceptanceGainProcessor;
class AcceptanceGainController;

/** The single parameter, shared verbatim by processor, controller and editor. */
enum ParamIDs : ParamID {
  kParamGain = 0,
};

constexpr ParamID kGainParamId = kParamGain;
constexpr ParamValue kDefaultGainNormalized = 0.5;

/** Editor view size in pixels. Fixed, so checkSizeConstraint has a stable answer. */
constexpr int32 kEditorWidth = 320;
constexpr int32 kEditorHeight = 120;

/**
 * Gain in decibels for a normalized value: -24 dB .. +12 dB, 0 dB at 0.5.
 *
 * Deliberately simple and monotonic so the acceptance harness can assert an exact
 * measurable amplitude change from a known PCM input. 0.0 -> -24 dB (x0.0631),
 * 1.0 -> +12 dB (x3.9811). A normalized 0.5 must be EXACTLY 1.0 (0 dB), which is
 * what the "unity" step in the evidence relies on.
 */
inline double gainDbFromNormalized(ParamValue normalized) {
  const double clamped = normalized < 0.0 ? 0.0 : (normalized > 1.0 ? 1.0 : normalized);
  return clamped <= 0.5 ? (clamped / 0.5) * 24.0 - 24.0
                        : ((clamped - 0.5) / 0.5) * 12.0;
}

inline double gainLinearFromNormalized(ParamValue normalized) {
  const double db = gainDbFromNormalized(normalized);
  if (db == 0.0) return 1.0;
  return std::pow(10.0, db / 20.0);
}

} // namespace ApexAcceptanceGain
