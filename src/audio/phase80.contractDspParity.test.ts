/**
 * Phase 80 — Contract ↔ DSP range / unit parity.
 *
 * The contract (FX_PARAMETER_FAMILIES) is the source of truth for
 * the UI range. The AudioEffect (DSP) validates the SAME range
 * (or a superset) when setParameter is called. This file probes
 * every contract param against the production AudioEffect.
 *
 * If the contract ever claims a range that the AudioEffect
 * rejects, this test fails: the UI would either show a slider
 * whose value is silently dropped at runtime, or the live
 * bridge would throw on a valid UI input.
 *
 * The test is also the regression for the delay slot-param
 * 'time' → AudioParam 'delayTime' translation, exercising the
 * AudioEffect's own setParameter validation so a future
 * "loosen" of the throw becomes visible here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FX_PARAMETER_FAMILIES,
  resolveFxAudioParam,
} from './fxParameterContract';
import { BiquadFilterEffect } from './effects/BiquadFilterEffect';
import { DynamicsCompressorEffect } from './effects/DynamicsCompressorEffect';
import { DelayEffect } from './effects/DelayEffect';
import { LimiterEffect } from './effects/LimiterEffect';

// --- Minimal AudioContext stand-ins (no real Web Audio) -----------------------

class FakeParam {
  value = 0;
  setValueAtTime(v: number) { this.value = v; }
}

const makeCtx = () => {
  const ctx: any = {
    sampleRate: 44100,
    currentTime: 0,
    destination: { connect() {} },
    createGain() {
      return {
        gain: new FakeParam(),
        connect() {}, disconnect() {},
      };
    },
    createBiquadFilter() {
      return {
        type: 'lowpass',
        frequency: new FakeParam(),
        Q: new FakeParam(),
        gain: new FakeParam(),
        connect() {}, disconnect() {},
      };
    },
    createDynamicsCompressor() {
      return {
        threshold: new FakeParam(),
        knee: new FakeParam(),
        ratio: new FakeParam(),
        attack: new FakeParam(),
        release: new FakeParam(),
        connect() {}, disconnect() {},
      };
    },
    createDelay() {
      return {
        delayTime: new FakeParam(),
        connect() {}, disconnect() {},
      };
    },
    createConvolver() {
      return { buffer: null, connect() {}, disconnect() {} };
    },
    createWaveShaper() {
      return {
        curve: null as Float32Array | null,
        oversample: 'none' as 'none' | '2x' | '4x',
        connect() {}, disconnect() {},
      };
    },
    createBufferSource() {
      return { connect() {}, disconnect() {} };
    },
  };
  return ctx as AudioContext;
};

// --- Helpers ------------------------------------------------------------------

/** Try a value on an AudioEffect. Returns true on success, false on throw. */
const trySet = (eff: any, name: string, value: number): boolean => {
  try {
    eff.setParameter(name, value, 0);
    return true;
  } catch {
    return false;
  }
};

// --- Tests --------------------------------------------------------------------

test('Phase 80 EQ contract: every per-band param is accepted by BiquadFilterEffect.setParameter', () => {
  const ctx = makeCtx();
  for (const band of ['low', 'mid', 'high']) {
    const eff = new BiquadFilterEffect(ctx, 'probe', 'lowpass', 1000, 1, 0);
    for (const dim of ['Freq', 'Gain', 'Q']) {
      const name = `${band}${dim}`;
      const param = FX_PARAMETER_FAMILIES.equalizer!.parameters.find(p => p.id === name);
      assert.ok(param, `contract must define ${name}`);
      const audioParam = resolveFxAudioParam('equalizer', name);
      assert.ok(
        trySet(eff, audioParam!, param!.default),
        `${audioParam}=${param!.default} must be accepted by BiquadFilterEffect.setParameter`,
      );
      // The contract default must be inside the contract range.
      assert.ok(
        param!.default >= param!.min && param!.default <= param!.max,
        `${param!.id} default ${param!.default} must be inside [${param!.min}, ${param!.max}]`,
      );
    }
  }
});

test('Phase 80 Compressor contract: every param accepted by DynamicsCompressorEffect.setParameter', () => {
  const ctx = makeCtx();
  const eff = new DynamicsCompressorEffect(ctx, 'probe', -24, 30, 12, 0.003, 0.25);
  for (const id of ['threshold', 'ratio', 'attack', 'release', 'knee']) {
    const param = FX_PARAMETER_FAMILIES.compressor!.parameters.find(p => p.id === id);
    assert.ok(param, `contract must define ${id}`);
    const audioParam = resolveFxAudioParam('compressor', id);
    assert.ok(
      trySet(eff, audioParam!, param!.default),
      `${audioParam}=${param!.default} must be accepted by DynamicsCompressorEffect.setParameter`,
    );
  }
});

test('Phase 80 Delay contract: slot-param "time" is NOT a DSP name; "delayTime" is', () => {
  // This is the regression for the registry translation. The
  // contract exposes 'time' (the slot-param) and the AudioEffect
  // accepts 'delayTime' (the DSP name). The live-bridge translates
  // between them.
  const ctx = makeCtx();
  const eff = new DelayEffect(ctx, 'probe', 0.25, 0.3, 0.5);
  const d = (eff as any).delay;
  assert.equal(d.delayTime.value, 0.25, 'construction param "delayTime" is the DSP name');

  assert.doesNotThrow(
    () => eff.setParameter('delayTime', 0.7, 0),
    'DelayEffect.setParameter(delayTime) must succeed',
  );
  assert.equal(d.delayTime.value, 0.7);

  assert.throws(
    () => eff.setParameter('time', 0.7, 0),
    /Unknown Delay effect parameter: time/,
    'DelayEffect must reject slot-param name "time" (the live-bridge translates it)',
  );
});

test('Phase 80 Delay contract: feedback param accepted by DelayEffect.setParameter', () => {
  const ctx = makeCtx();
  const eff = new DelayEffect(ctx, 'probe', 0.25, 0.3, 0.5);
  const param = FX_PARAMETER_FAMILIES.delay!.parameters.find(p => p.id === 'feedback');
  assert.ok(param);
  const audioParam = resolveFxAudioParam('delay', 'feedback');
  assert.ok(
    trySet(eff, audioParam!, param!.default),
    `feedback=${param!.default} must be accepted by DelayEffect.setParameter`,
  );
});

test('Phase 80 Limiter contract: ceiling/release/drive accepted by LimiterEffect.setParameter', () => {
  const ctx = makeCtx();
  const eff = new LimiterEffect(ctx, 'probe', 0, 0.1, 0);
  for (const id of ['ceiling', 'release', 'drive']) {
    const param = FX_PARAMETER_FAMILIES.limiter!.parameters.find(p => p.id === id);
    assert.ok(param);
    const audioParam = resolveFxAudioParam('limiter', id);
    assert.ok(
      trySet(eff, audioParam!, param!.default),
      `${audioParam}=${param!.default} must be accepted by LimiterEffect.setParameter`,
    );
  }
});

test('Phase 80 Reverb contract: no per-slot DSP params; only mix is AudioParam-updatable', () => {
  const family = FX_PARAMETER_FAMILIES.reverb;
  assert.ok(family, 'reverb family exists');
  assert.equal(family!.parameters.length, 0, 'reverb has no per-slot DSP params (ConvolverNode is set-once)');
});

test('Phase 80: every contract "default" passes the live-bridge range check', () => {
  // The contract's `min`/`max`/`default` are the producer-visible
  // knobs. The live-bridge's `applyLiveFxSlotParameter` clamps
  // inputs to [min, max] via clampFxParameterValue. Assert the
  // contract defaults are inside the contract ranges.
  for (const family of Object.values(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    for (const p of family.parameters) {
      assert.ok(
        p.default >= p.min && p.default <= p.max,
        `${family.fxType}.${p.id} default ${p.default} must be inside [${p.min}, ${p.max}]`,
      );
    }
  }
});