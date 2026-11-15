// ApexAcceptanceGain processor declaration. See acceptance-fixture.hpp.
#pragma once

#include "acceptance-fixture.hpp"
#include "public.sdk/source/vst/vstaudioeffect.h"

namespace ApexAcceptanceGain {

/** Stereo in/out gain effect. No event buses by construction. */
class AcceptanceGainProcessor final : public AudioEffect {
public:
  // Declares the companion controller; see the definition for why the real host
  // load path depends on it.
  AcceptanceGainProcessor();
  static FUnknown* createInstance(void*);

  tresult PLUGIN_API initialize(FUnknown* context) override;
  tresult PLUGIN_API terminate() override;
  tresult PLUGIN_API setActive(TBool state) override;
  tresult PLUGIN_API setupProcessing(ProcessSetup& setup) override;
  tresult PLUGIN_API setProcessing(TBool state) override;
  tresult PLUGIN_API canProcessSampleSize(int32 symbolicSampleSize) override;
  tresult PLUGIN_API process(ProcessData& data) override;
  tresult PLUGIN_API getState(IBStream* state) override;
  tresult PLUGIN_API setState(IBStream* state) override;

  ParamValue currentGainNormalized() const { return gainNormalized.load(); }

private:
  std::atomic<ParamValue> gainNormalized{kDefaultGainNormalized};
  /** Single-threaded mirror, so the audio loop needs no atomics. */
  ParamValue cachedGainNormalized{kDefaultGainNormalized};
};

} // namespace ApexAcceptanceGain
