// ApexAcceptanceGain processor. See acceptance-fixture.hpp for provenance.
//
// Contract this class satisfies, and why each part matters to the acceptance run:
//   - stereo audio in and out, NO event input bus (the host refuses effects that
//     declare one, so the Mixer would reject the insert);
//   - one controller-exposed Gain parameter (kParamGain);
//   - real, measurable processing: output = input * gainLinear(normalized);
//   - component state round-trips through getState/setState so save/quit/reload
//     can be proven to preserve the edited value.
#include "acceptance-fixture-processor.hpp"

#include "base/source/fstreamer.h"

namespace ApexAcceptanceGain {

using namespace Steinberg;
using namespace Steinberg::Vst;

FUnknown* AcceptanceGainProcessor::createInstance(void*) {
  return static_cast<IAudioProcessor*>(new AcceptanceGainProcessor());
}

AcceptanceGainProcessor::AcceptanceGainProcessor() {
  // Declare the companion edit controller.
  //
  // PluginHost::PlugProvider::initialize() -- the path every real host, including
  // Apex's editor helper, uses to load a plug-in -- asks the component for its
  // controller class id and fails outright when it gets kResultFalse. The SDK's
  // component factory test creates the two classes side by side, so it passed
  // while the real load path was broken. Setting it here is what makes the fixture
  // loadable rather than merely constructible.
  setControllerClass(kControllerUID);
}

tresult PLUGIN_API AcceptanceGainProcessor::initialize(FUnknown* context) {
  const tresult result = AudioEffect::initialize(context);
  if (result != kResultOk) return result;
  // Exactly one stereo input and one stereo output, and no event buses of any
  // kind: this is what makes the effect eligible for a Mixer insert.
  addAudioInput(USTRING("Stereo In"), SpeakerArr::kStereo);
  addAudioOutput(USTRING("Stereo Out"), SpeakerArr::kStereo);
  return kResultOk;
}

tresult PLUGIN_API AcceptanceGainProcessor::terminate() {
  return AudioEffect::terminate();
}

tresult PLUGIN_API AcceptanceGainProcessor::setActive(TBool state) {
  if (state) {
    // A fresh activation starts from the parameter value.
    gainNormalized.store(cachedGainNormalized);
  }
  return AudioEffect::setActive(state);
}

tresult PLUGIN_API AcceptanceGainProcessor::setupProcessing(ProcessSetup& setup) {
  return AudioEffect::setupProcessing(setup);
}

tresult PLUGIN_API AcceptanceGainProcessor::setProcessing(TBool /*state*/) {
  // No allocation and no reconfiguration: nothing to do, and saying so plainly is
  // better than pretending to act.
  return kResultOk;
}

tresult PLUGIN_API AcceptanceGainProcessor::canProcessSampleSize(int32 symbolicSampleSize) {
  return symbolicSampleSize == kSample32 || symbolicSampleSize == kSample64
    ? kResultOk : kResultFalse;
}

tresult PLUGIN_API AcceptanceGainProcessor::process(ProcessData& data) {
  // Parameters first: a change applied in this block must be audible in it, so the
  // harness can measure "parameter change -> different PCM" in one block.
  if (data.inputParameterChanges) {
    const int32 count = data.inputParameterChanges->getParameterCount();
    for (int32 i = 0; i < count; ++i) {
      IParamValueQueue* queue = data.inputParameterChanges->getParameterData(i);
      if (!queue || queue->getParameterId() != kParamGain) continue;
      int32 sampleOffset = 0;
      ParamValue value = 0.0;
      const int32 points = queue->getPointCount();
      if (points > 0 && queue->getPoint(points - 1, sampleOffset, value) == kResultOk &&
          value >= 0.0 && value <= 1.0) {
        gainNormalized.store(value);
        cachedGainNormalized = value;
      }
    }
  }

  if (!data.outputs || data.numOutputs < 1) return kResultOk;
  AudioBusBuffers& out = data.outputs[0];
  const bool silentOutput = (out.silenceFlags & 1ull) != 0;
  const double gain = gainLinearFromNormalized(gainNormalized.load());

  for (int32 channel = 0; channel < out.numChannels; ++channel) {
    Sample32* outSamples = out.channelBuffers32 ? out.channelBuffers32[channel] : nullptr;
    if (!outSamples) continue;
    if (silentOutput || data.numInputs < 1 || !data.inputs || !data.inputs[0].channelBuffers32) {
      for (int32 frame = 0; frame < data.numSamples; ++frame) outSamples[frame] = 0.f;
      continue;
    }
    // Read the matching input channel, clamping to the last available one so a
    // narrower input still produces defined output rather than reading past it.
    const int32 inChannels = data.inputs[0].numChannels;
    const int32 source = channel < inChannels ? channel : inChannels - 1;
    const Sample32* inSamples = data.inputs[0].channelBuffers32[source];
    if (!inSamples) {
      for (int32 frame = 0; frame < data.numSamples; ++frame) outSamples[frame] = 0.f;
      continue;
    }
    for (int32 frame = 0; frame < data.numSamples; ++frame) {
      outSamples[frame] = static_cast<Sample32>(static_cast<double>(inSamples[frame]) * gain);
    }
  }
  out.silenceFlags = 0;
  // A gain effect adds no latency, which the host validates.
  return kResultOk;
}

tresult PLUGIN_API AcceptanceGainProcessor::getState(IBStream* state) {
  if (!state) return kResultFalse;
  IBStreamer streamer(state, kLittleEndian);
  if (!streamer.writeDouble(gainNormalized.load())) return kResultFalse;
  return kResultOk;
}

tresult PLUGIN_API AcceptanceGainProcessor::setState(IBStream* state) {
  if (!state) return kResultFalse;
  IBStreamer streamer(state, kLittleEndian);
  double value = kDefaultGainNormalized;
  if (!streamer.readDouble(value)) return kResultFalse;
  if (!(value >= 0.0 && value <= 1.0)) value = kDefaultGainNormalized;
  gainNormalized.store(value);
  cachedGainNormalized = value;
  return kResultOk;
}

} // namespace ApexAcceptanceGain
