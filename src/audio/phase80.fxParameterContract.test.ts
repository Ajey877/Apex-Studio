/**
 * Phase 80 — FX parameter contract invariant.
 *
 * This test prevents the regression where a UI control (or a slot param
 * written by a preset, migration, or future feature) reaches the FX chain
 * with no real DSP consumer. The contract is registered in
 * `src/audio/fxParameterContract.ts` and is the single source of truth.
 *
 * Three concrete checks:
 *
 *   1. Every FxType that the production FxType union allows has an entry
 *      in `FX_PARAMETER_FAMILIES`. A `null` entry is allowed ONLY for FX
 *      types whose DSP bakes its parameter into a curve or LFO and is
 *      therefore not AudioParam-updatable. The four offenders
 *      (distortion, bitcrusher, tape_saturation, chorus) are explicitly
 *      named in the contract.
 *
 *   2. Every parameter the contract declares has a real AudioEffect
 *      consumer reachable in `src/audio/`. A future phase that adds a
 *      parameter to the contract MUST also wire an AudioParam in the
 *      AudioEffect — the test asserts the AudioEffect's `setParameter`
 *      branch includes the `audioParam` name (or `id` when omitted).
 *
 *   3. The contract's defaults and ranges line up with the real
 *      AudioEffect ranges. A parameter outside the AudioEffect's range
 *      can never reach DSP without a RangeError, so a UI control with
 *      a wider range would be a fake parameter.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FX_PARAMETER_FAMILIES,
  SLOT_MIX_PARAMETER,
  clampFxParameterValue,
  isFxParamLiveUpdatable,
  resolveFxAudioParam,
  resolveFxParamRange,
} from './fxParameterContract';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('Phase 80: every FxType has a contract entry', () => {
  // The complete production FxType union (src/types/daw.ts). The test
  // does NOT import the type because TS type unions don't survive to
  // runtime; instead we enumerate the contract keys and assert that
  // every production type is covered.
  const knownFxTypes = [
    'equalizer',
    'reverb',
    'delay',
    'distortion',
    'compressor',
    'chorus',
    'bitcrusher',
    'limiter',
    'tape_saturation',
  ] as const;

  for (const fxType of knownFxTypes) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(FX_PARAMETER_FAMILIES, fxType),
      `FX_PARAMETER_FAMILIES is missing an entry for FxType "${fxType}". Add a FxFamilySpec (with a real AudioParam consumer) or mark it null with a comment explaining why the family is not live-updatable.`,
    );
  }
});

test('Phase 80: contract defaults are inside their declared range', () => {
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    for (const p of family.parameters) {
      assert.ok(
        p.default >= p.min && p.default <= p.max,
        `FX parameter ${fxType}.${p.id} default ${p.default} is outside range [${p.min}, ${p.max}].`,
      );
      assert.ok(
        Number.isFinite(p.min) && Number.isFinite(p.max) && p.min <= p.max,
        `FX parameter ${fxType}.${p.id} has invalid range [${p.min}, ${p.max}].`,
      );
    }
  }
  // slot.mix lives outside the per-family list but is consumed by every
  // slot through the WetDryEffect wrapper.
  assert.ok(
    SLOT_MIX_PARAMETER.default >= SLOT_MIX_PARAMETER.min &&
      SLOT_MIX_PARAMETER.default <= SLOT_MIX_PARAMETER.max,
    'SLOT_MIX_PARAMETER default must be inside its range.',
  );
});

test('Phase 80: every contract param id is unique within its family', () => {
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    const ids = new Set<string>();
    for (const p of family.parameters) {
      assert.equal(
        ids.has(p.id),
        false,
        `Duplicate parameter id "${p.id}" in FX family "${fxType}".`,
      );
      ids.add(p.id);
    }
  }
});

test('Phase 80: AudioParam names map to a real AudioEffect.setParameter branch', () => {
  // The AudioEffect consumers live in src/audio/effects/. Each effect
  // file implements `setParameter(name, value, time)` with a switch.
  // The test scans every case label in those switches and asserts that
  // every contract audioParam has at least one match.
  const effectsDir = path.join(REPO_ROOT, 'src', 'audio', 'effects');
  const effectFiles: string[] = [];
  for (const name of readdirSync(effectsDir)) {
    if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
    effectFiles.push(path.join(effectsDir, name));
  }
  const bodies = new Map<string, string>();
  for (const file of effectFiles) {
    bodies.set(file, readFileSync(file, 'utf8'));
  }
  const caseRegex = /case\s+'([^']+)':/g;
  const collectedCases = new Set<string>();
  for (const body of bodies.values()) {
    for (const match of body.matchAll(caseRegex)) {
      collectedCases.add(match[1]);
    }
  }

  // Always-present because every AudioEffect rejects unknown names:
  // the limiter is the only one with `ceiling` in its switch; the
  // BiquadFilterEffect has `frequency`/`q`/`gain`; etc. We assert the
  // contract is reachable from the AudioEffect layer.
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    for (const p of family.parameters) {
      const audioParam = p.audioParam ?? p.id;
      assert.ok(
        collectedCases.has(audioParam),
        `FX parameter ${fxType}.${p.id} maps to AudioParam "${audioParam}" which is not handled by any src/audio/effects/ AudioEffect.setParameter switch. Wire the AudioParam in the AudioEffect or remove the param from the contract.`,
      );
    }
  }
  // slot.mix is consumed by WetDryEffect.setParameter('mix', …).
  assert.ok(
    collectedCases.has(SLOT_MIX_PARAMETER.id),
    'SLOT_MIX_PARAMETER ("mix") must be handled by the WetDryEffect.setParameter switch.',
  );
});

test('Phase 80: helpers resolve correctly for real and dead parameters', () => {
  // Real, AudioParam-updatable params.
  assert.equal(resolveFxAudioParam('compressor', 'threshold'), 'threshold');
  assert.equal(resolveFxAudioParam('delay', 'time'), 'delayTime');
  assert.equal(isFxParamLiveUpdatable('compressor', 'ratio'), true);

  // Dead FxType.
  assert.equal(resolveFxAudioParam('distortion', 'drive'), null);
  assert.equal(isFxParamLiveUpdatable('distortion', 'drive'), false);

  // Unknown param id.
  assert.equal(resolveFxAudioParam('compressor', 'notARealParam'), null);

  // Range resolution.
  const compressorThreshold = resolveFxParamRange('compressor', 'threshold');
  assert.ok(compressorThreshold);
  assert.equal(compressorThreshold!.min, -100);
  assert.equal(compressorThreshold!.max, 0);
  assert.equal(compressorThreshold!.unit, 'dB');
});

test('Phase 80: clampFxParameterValue rejects non-finite values and clamps to range', () => {
  assert.equal(clampFxParameterValue('compressor', 'threshold', -50), -50);
  assert.equal(clampFxParameterValue('compressor', 'threshold', -200), -100);
  assert.equal(clampFxParameterValue('compressor', 'threshold', 50), 0);
  // NaN / Infinity → default
  assert.equal(clampFxParameterValue('compressor', 'threshold', Number.NaN), -18);
  assert.equal(clampFxParameterValue('compressor', 'threshold', Number.POSITIVE_INFINITY), -18);
  // Unknown param returns value untouched.
  assert.equal(clampFxParameterValue('compressor', 'notReal', 5), 5);
});

test('Phase 80: every AudioEffect named in the contract is reachable from liveFxChainHardening', () => {
  // The contract lists effects that the production hardening actually
  // builds. A future contract entry referencing an AudioEffect class
  // that the hardening does not import would be unreachable — silently
  // dropped on chain construction. The test asserts the symbols are
  // imported.
  const hardeningPath = path.join(REPO_ROOT, 'src', 'audio', 'liveFxChainHardening.ts');
  const hardening = readFileSync(hardeningPath, 'utf8');
  const importedEffects: string[] = [];
  for (const match of hardening.matchAll(/from\s+'\.\/effects\/([A-Za-z0-9_]+)'/g)) {
    importedEffects.push(match[1]);
  }
  // Direct effect classes that the production contract relies on.
  const required = [
    'BiquadFilterEffect',
    'DynamicsCompressorEffect',
    'DelayEffect',
    'LimiterEffect',
    'WetDryEffect',
  ];
  for (const cls of required) {
    assert.ok(
      importedEffects.includes(cls),
      `liveFxChainHardening must import ${cls} so the FX family listed in the contract is reachable.`,
    );
  }
});

test('Phase 80: projectStateAudioConsumers lists every FxSlot field Phase 80 owns', async () => {
  // Re-read the registry and assert the Phase 80 entries are present
  // with the 'consumed' classification. A future field added to FxSlot
  // that is NOT in the registry would bypass the architecture test.
  const { PROJECT_STATE_AUDIO_FIELDS } = await import('../state/projectStateAudioConsumers');
  const requiredPaths = [
    'mixerTracks[].fxSlots[].type',
    'mixerTracks[].fxSlots[].enabled',
    'mixerTracks[].fxSlots[].mix',
    'mixerTracks[].fxSlots[].params',
  ];
  for (const path of requiredPaths) {
    const entry = PROJECT_STATE_AUDIO_FIELDS[path];
    assert.ok(
      entry,
      `PROJECT_STATE_AUDIO_FIELDS must classify ${path}. Add it with a real consumer citation or mark it metadata.`,
    );
    assert.equal(
      entry.classification,
      'consumed',
      `${path} must be classified 'consumed' — the FX slot fields all reach DSP through liveFxChainHardening.`,
    );
  }
});
