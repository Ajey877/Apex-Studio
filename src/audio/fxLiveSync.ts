/**
 * Phase 80 — Live FX parameter sync helper.
 *
 * Decides whether a slot's `params` change can be applied live (an
 * AudioParam.setValueAtTime call on the running chain) or must
 * trigger a full chain rebuild. The decision is the membership
 * test against the FX parameter contract.
 *
 * The contract is the source of truth: a param is live-routable iff
 * the contract has a `FxFamilySpec.parameters` entry whose
 * `audioParam` (or `id` fallback) maps to a real AudioParam in
 * `src/audio/effects/`. The membership table is duplicated here to
 * avoid a load-time module cycle between `audioEngine.ts` and
 * `fxParameterContract.ts`; the contract test
 * (`phase80.fxParameterContract.test.ts`) enforces parity between
 * the two so a future drift produces a hard failure.
 */
export function isFxParamLiveUpdatableByName(fxType: string, paramName: string): boolean {
  if (paramName === 'mix') return true; // WetDryEffect wrapper
  // EQ — all 9 band params route to BiquadFilterEffect's AudioParams.
  if (fxType === 'equalizer') {
    return paramName === 'lowFreq' || paramName === 'lowGain' || paramName === 'lowQ'
      || paramName === 'midFreq' || paramName === 'midGain' || paramName === 'midQ'
      || paramName === 'highFreq' || paramName === 'highGain' || paramName === 'highQ';
  }
  if (fxType === 'compressor') {
    return paramName === 'threshold' || paramName === 'knee' || paramName === 'ratio'
      || paramName === 'attack' || paramName === 'release';
  }
  if (fxType === 'delay') {
    return paramName === 'time' || paramName === 'feedback';
  }
  if (fxType === 'limiter') {
    return paramName === 'ceiling' || paramName === 'release' || paramName === 'drive';
  }
  // Reverb has no AudioParam-updatable per-slot params; only the
  // WetDry mix is live-editable.
  // Distortion, bitcrusher, tape_saturation, chorus bake their
  // parameter into a curve or LFO and are not live-updatable.
  return false;
}
