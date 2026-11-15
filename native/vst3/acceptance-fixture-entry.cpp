// ApexAcceptanceGain factory registration. See acceptance-fixture.hpp for provenance.
//
// Registered as a VST3 audio-effect class ("Audio Module Class") in the Fx
// category, so Apex's Mixer discovers it as an effect that can be placed on an
// insert, exactly like a third-party effect.
#include "acceptance-fixture-processor.hpp"
#include "acceptance-fixture-controller.hpp"

#include "public.sdk/source/main/pluginfactory.h"

#define stringPluginName "ApexAcceptanceGain"

BEGIN_FACTORY_DEF("Apex Studio", "https://github.com/Ajey877/Apex-Studio", "mailto:noreply@example.invalid")

  DEF_CLASS2(INLINE_UID_FROM_FUID(ApexAcceptanceGain::kProcessorUID),
    PClassInfo::kManyInstances, kVstAudioEffectClass, stringPluginName,
    Vst::kDistributable, Vst::PlugType::kFx,
    "1.0.0", kVstVersionString, ApexAcceptanceGain::AcceptanceGainProcessor::createInstance)

  DEF_CLASS2(INLINE_UID_FROM_FUID(ApexAcceptanceGain::kControllerUID),
    PClassInfo::kManyInstances, kVstComponentControllerClass, stringPluginName " Controller",
    0, nullptr, "1.0.0", kVstVersionString, ApexAcceptanceGain::AcceptanceGainController::createInstance)

END_FACTORY
