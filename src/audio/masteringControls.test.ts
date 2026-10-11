import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTERING_CONTROL_RANGES,
  MASTERING_CONTROL_TARGETS,
  applyMasteringControlChange,
  bandRangeLabel,
  clampMasteringControlValue,
  formatFrequencyHz,
  getMasteringControlRange,
  isBandAudible,
  parseMasteringControlTarget,
  resolveCrossoverFrequencies,
  toggleBandMute,
  toggleBandSolo,
} from './masteringControls';
import type { MasteringBandKey, MasteringControlTarget } from './masteringControls';
import {
  DEFAULT_MASTERING_SUITE_STATE,
  MASTERING_NORMALIZATION_BOUNDS,
  normalizeMasteringSuiteState,
} from './masteringState';
import { MasteringProcessor } from './masteringProcessor';
import type { MasteringSuiteState } from '../types/daw';

/**
 * Phase 90 — the mastering control surface.
 *
 * These are behavioural tests of the module that the Mastering Suite modal
 * drives. The two that matter most for truthfulness are:
 *
 *  - every slider range is provably inside the range `normalizeMasteringSuiteState`
 *    will accept, so a control can never write a value the document layer then
 *    silently rewrites;
 *  - `resolveCrossoverFrequencies` agrees with the frequencies the *real*
 *    `MasteringProcessor` pushes into its crossover filters, so the band labels
 *    describe the DSP instead of drifting away from it.
 */

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
}
class FakeNode {
  connections: unknown[][] = [];
  disconnected = false;
  connect(destination: unknown, ...args: unknown[]) { this.connections.push([destination, ...args]); }
  disconnect() { this.disconnected = true; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeBiquad extends FakeNode { frequency = new FakeParam(); type = 'lowpass'; }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}
class FakeWaveShaper extends FakeNode { curve: Float32Array | null = null; oversample = 'none'; }

function fakeContext(sampleRate = 48000) {
  const nodes: FakeNode[] = [];
  const make = <T extends FakeNode>(node: T): T => { nodes.push(node); return node; };
  const context = {
    currentTime: 2,
    sampleRate,
    createGain: () => make(new FakeGain()),
    createBiquadFilter: () => make(new FakeBiquad()),
    createDynamicsCompressor: () => make(new FakeCompressor()),
    createWaveShaper: () => make(new FakeWaveShaper()),
    createChannelSplitter: () => make(new FakeNode()),
    createChannelMerger: () => make(new FakeNode()),
  };
  return { context: context as unknown as AudioContext, nodes };
}

/** Build the processor and hand back the nodes it wrote its parameters into. */
function buildProcessor(state: MasteringSuiteState, sampleRate = 48000) {
  const { context, nodes } = fakeContext(sampleRate);
  const processor = new MasteringProcessor(context, state);
  const biquads = nodes.filter((n): n is FakeBiquad => n instanceof FakeBiquad);
  const compressors = nodes.filter((n): n is FakeCompressor => n instanceof FakeCompressor);
  return {
    processor,
    /** Graph order: low LP, mid HP, mid LP, high HP, then the imager side HP. */
    lowLp: biquads[0],
    midHp: biquads[1],
    midLp: biquads[2],
    highHp: biquads[3],
    bandCompressors: [compressors[0], compressors[1], compressors[2]],
    maximizer: compressors[3],
    // Gain order: input, output, bypass, wet, bandSum, then the three band gains.
    bandGains: nodes.filter((n): n is FakeGain => n instanceof FakeGain).slice(5, 8),
  };
}

describe('Phase 90 — control ranges agree with state normalization', () => {
  const GLOBAL_TO_BOUND = {
    lowCrossFreq: MASTERING_NORMALIZATION_BOUNDS.lowCrossFreq,
    highCrossFreq: MASTERING_NORMALIZATION_BOUNDS.highCrossFreq,
    maximizerRelease: MASTERING_NORMALIZATION_BOUNDS.maximizerRelease,
  } as const;

  it('offers no slider range wider than the document format accepts', () => {
    for (const [control, range] of Object.entries(MASTERING_CONTROL_RANGES)) {
      const bound = control === 'lowCrossFreq' || control === 'highCrossFreq' || control === 'maximizerRelease'
        ? GLOBAL_TO_BOUND[control as keyof typeof GLOBAL_TO_BOUND]
        : MASTERING_NORMALIZATION_BOUNDS.band[control.replace('band', '').toLowerCase() as 'attack' | 'release' | 'knee'];
      assert.ok(
        range.min >= bound.min,
        `${control}: slider min ${range.min} is below the normalized min ${bound.min}`
      );
      assert.ok(
        range.max <= bound.max,
        `${control}: slider max ${range.max} is above the normalized max ${bound.max}`
      );
    }
  });

  it('ships every default inside its own slider range, so a fresh project renders in range', () => {
    const s = DEFAULT_MASTERING_SUITE_STATE;
    const cases: Array<[string, number]> = [
      ['lowCrossFreq', s.lowCrossFreq],
      ['highCrossFreq', s.highCrossFreq],
      ['maximizerRelease', s.maximizerRelease],
    ];
    for (const band of ['lowBand', 'midBand', 'highBand'] as const) {
      cases.push([`${band}.attack`, s[band].attack]);
      cases.push([`${band}.release`, s[band].release]);
      cases.push([`${band}.knee`, s[band].knee]);
    }
    for (const [target, value] of cases) {
      const range = getMasteringControlRange(target as MasteringControlTarget);
      assert.ok(
        value >= range.min && value <= range.max,
        `${target} default ${value} is outside its slider range ${range.min}–${range.max}`
      );
    }
  });

  it('covers exactly the controls Phase 90 was asked to expose', () => {
    assert.deepEqual([...MASTERING_CONTROL_TARGETS].sort(), [
      'highBand.attack', 'highBand.knee', 'highBand.release',
      'highCrossFreq',
      'lowBand.attack', 'lowBand.knee', 'lowBand.release',
      'lowCrossFreq',
      'maximizerRelease',
      'midBand.attack', 'midBand.knee', 'midBand.release',
    ].sort());
  });

  it('exposes the crossovers with the ranges and defaults the phase specifies', () => {
    assert.deepEqual(
      { ...MASTERING_CONTROL_RANGES.lowCrossFreq, unit: 'Hz' },
      { min: 80, max: 500, step: 5, unit: 'Hz' }
    );
    assert.equal(DEFAULT_MASTERING_SUITE_STATE.lowCrossFreq, 150);
    assert.deepEqual(
      { ...MASTERING_CONTROL_RANGES.highCrossFreq, unit: 'Hz' },
      { min: 1800, max: 16000, step: 50, unit: 'Hz' }
    );
    assert.equal(DEFAULT_MASTERING_SUITE_STATE.highCrossFreq, 3500);
    assert.deepEqual(
      { ...MASTERING_CONTROL_RANGES.maximizerRelease, unit: 'ms' },
      { min: 20, max: 300, step: 5, unit: 'ms' }
    );
  });

  it('labels every control in the unit the state actually stores', () => {
    assert.equal(getMasteringControlRange('lowCrossFreq').unit, 'Hz');
    assert.equal(getMasteringControlRange('highCrossFreq').unit, 'Hz');
    assert.equal(getMasteringControlRange('lowBand.attack').unit, 'ms');
    assert.equal(getMasteringControlRange('midBand.release').unit, 'ms');
    assert.equal(getMasteringControlRange('highBand.knee').unit, 'dB');
    assert.equal(getMasteringControlRange('maximizerRelease').unit, 'ms');
  });
});

describe('Phase 90 — applyMasteringControlChange writes one field and nothing else', () => {
  it('patches a per-band field without touching sibling bands or other fields', () => {
    const next = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'midBand.attack', '42');
    assert.equal(next.midBand.attack, 42);
    assert.equal(next.midBand.release, DEFAULT_MASTERING_SUITE_STATE.midBand.release);
    assert.equal(next.midBand.knee, DEFAULT_MASTERING_SUITE_STATE.midBand.knee);
    assert.equal(next.midBand.threshold, DEFAULT_MASTERING_SUITE_STATE.midBand.threshold);
    assert.deepEqual(next.lowBand, DEFAULT_MASTERING_SUITE_STATE.lowBand);
    assert.deepEqual(next.highBand, DEFAULT_MASTERING_SUITE_STATE.highBand);
    assert.equal(next.lowCrossFreq, DEFAULT_MASTERING_SUITE_STATE.lowCrossFreq);
    assert.notEqual(next.midBand, DEFAULT_MASTERING_SUITE_STATE.midBand, 'the band object must be replaced, not mutated');
    assert.equal(DEFAULT_MASTERING_SUITE_STATE.midBand.attack, 15, 'the default state must not be mutated');
  });

  it('patches each global control without touching the bands', () => {
    const low = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'lowCrossFreq', '300');
    assert.equal(low.lowCrossFreq, 300);
    assert.equal(low.highCrossFreq, DEFAULT_MASTERING_SUITE_STATE.highCrossFreq);
    assert.deepEqual(low.lowBand, DEFAULT_MASTERING_SUITE_STATE.lowBand);

    const high = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'highCrossFreq', '8000');
    assert.equal(high.highCrossFreq, 8000);
    assert.equal(high.lowCrossFreq, DEFAULT_MASTERING_SUITE_STATE.lowCrossFreq);

    const rel = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerRelease', '220');
    assert.equal(rel.maximizerRelease, 220);
    assert.equal(rel.maximizerThreshold, DEFAULT_MASTERING_SUITE_STATE.maximizerThreshold);
    assert.equal(rel.maximizerCeiling, DEFAULT_MASTERING_SUITE_STATE.maximizerCeiling);
  });

  it('clamps out-of-range input to the control range instead of storing it', () => {
    assert.equal(clampMasteringControlValue('lowCrossFreq', '40'), 80);
    assert.equal(clampMasteringControlValue('lowCrossFreq', '9999'), 500);
    assert.equal(clampMasteringControlValue('highCrossFreq', '100'), 1800);
    assert.equal(clampMasteringControlValue('highCrossFreq', '99999'), 16000);
    assert.equal(clampMasteringControlValue('maximizerRelease', '1'), 20);
    assert.equal(clampMasteringControlValue('maximizerRelease', '5000'), 300);
    assert.equal(clampMasteringControlValue('lowBand.knee', '99'), 12);
    // And the clamped value is what reaches the state.
    assert.equal(applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'lowCrossFreq', '9999').lowCrossFreq, 500);
  });

  it('snaps to the slider step so stored values match what the control can show', () => {
    assert.equal(clampMasteringControlValue('lowCrossFreq', '153'), 155);
    assert.equal(clampMasteringControlValue('highCrossFreq', '3520'), 3500);
    assert.equal(clampMasteringControlValue('lowBand.knee', '3.3'), 3.5);
    assert.equal(clampMasteringControlValue('maximizerRelease', '83'), 85);
  });

  it('refuses to write a non-finite value, leaving the state object identical', () => {
    for (const bad of ['abc', '', 'NaN', Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as string]) {
      const next = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'lowCrossFreq', bad);
      assert.equal(next, DEFAULT_MASTERING_SUITE_STATE, `non-finite input ${String(bad)} must not produce a new state`);
      assert.ok(Number.isFinite(next.lowCrossFreq));
    }
  });

  it('returns the same reference when the value is unchanged, so no empty history entry is recorded', () => {
    const same = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'lowCrossFreq', String(DEFAULT_MASTERING_SUITE_STATE.lowCrossFreq));
    assert.equal(same, DEFAULT_MASTERING_SUITE_STATE);
    const sameBand = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'lowBand.attack', String(DEFAULT_MASTERING_SUITE_STATE.lowBand.attack));
    assert.equal(sameBand, DEFAULT_MASTERING_SUITE_STATE);
  });

  it('rejects an unknown control target rather than writing to a guessed field', () => {
    assert.throws(() => parseMasteringControlTarget('lowBand.threshold' as MasteringControlTarget), RangeError);
    assert.throws(() => parseMasteringControlTarget('nopeBand.attack' as MasteringControlTarget), RangeError);
  });

  it('survives normalization unchanged — every value a control can produce is document-legal', () => {
    for (const target of MASTERING_CONTROL_TARGETS) {
      for (const raw of ['-1e9', '1e9', '0']) {
        const next = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, target, raw);
        assert.deepEqual(normalizeMasteringSuiteState(next), next, `${target} <- ${raw} changed under normalization`);
      }
    }
  });
});

describe('Phase 90 — solo and mute match the processor audible rule', () => {
  it('toggles only the addressed band', () => {
    const soloed = toggleBandSolo(DEFAULT_MASTERING_SUITE_STATE, 'highBand');
    assert.equal(soloed.highBand.solo, true);
    assert.equal(soloed.lowBand.solo, false);
    assert.equal(soloed.midBand.solo, false);
    const muted = toggleBandMute(soloed, 'highBand');
    assert.equal(muted.highBand.mute, true);
    assert.equal(muted.highBand.solo, true, 'muting must not clear solo');
    assert.equal(DEFAULT_MASTERING_SUITE_STATE.highBand.solo, false, 'defaults are not mutated');
  });

  it('reports every band audible when nothing is soloed or muted', () => {
    for (const band of ['lowBand', 'midBand', 'highBand'] as MasteringBandKey[]) {
      assert.equal(isBandAudible(DEFAULT_MASTERING_SUITE_STATE, band), true);
    }
  });

  it('soloing one band silences the others, and mute wins over solo', () => {
    const soloHigh = toggleBandSolo(DEFAULT_MASTERING_SUITE_STATE, 'highBand');
    assert.equal(isBandAudible(soloHigh, 'highBand'), true);
    assert.equal(isBandAudible(soloHigh, 'lowBand'), false);
    assert.equal(isBandAudible(soloHigh, 'midBand'), false);

    const soloHighMuteHigh = toggleBandMute(soloHigh, 'highBand');
    assert.equal(isBandAudible(soloHighMuteHigh, 'highBand'), false, 'a soloed but muted band is silent');

    const soloTwo = toggleBandSolo(toggleBandSolo(DEFAULT_MASTERING_SUITE_STATE, 'lowBand'), 'highBand');
    assert.equal(isBandAudible(soloTwo, 'lowBand'), true);
    assert.equal(isBandAudible(soloTwo, 'highBand'), true);
    assert.equal(isBandAudible(soloTwo, 'midBand'), false);
  });
});

describe('Phase 90 — crossover labels describe the filters the processor really sets', () => {
  const cases: Array<Pick<MasteringSuiteState, 'lowCrossFreq' | 'highCrossFreq'>> = [
    { lowCrossFreq: 150, highCrossFreq: 3500 },
    { lowCrossFreq: 80, highCrossFreq: 1800 },
    { lowCrossFreq: 500, highCrossFreq: 16000 },
    // Adversarial: the document format allows low above high; the processor guards it.
    { lowCrossFreq: 900, highCrossFreq: 600 },
    { lowCrossFreq: 1000, highCrossFreq: 500 },
  ];

  it('matches the frequencies the real processor writes to its crossover nodes', () => {
    for (const c of cases) {
      const state: MasteringSuiteState = { ...DEFAULT_MASTERING_SUITE_STATE, ...c };
      const { processor, lowLp, midHp, midLp, highHp } = buildProcessor(state);
      const resolved = resolveCrossoverFrequencies(state);
      assert.equal(lowLp.frequency.value, resolved.lowCrossHz, `low LP for ${c.lowCrossFreq}/${c.highCrossFreq}`);
      assert.equal(midHp.frequency.value, resolved.lowCrossHz, `mid HP for ${c.lowCrossFreq}/${c.highCrossFreq}`);
      assert.equal(midLp.frequency.value, resolved.highCrossHz, `mid LP for ${c.lowCrossFreq}/${c.highCrossFreq}`);
      assert.equal(highHp.frequency.value, resolved.highCrossHz, `high HP for ${c.lowCrossFreq}/${c.highCrossFreq}`);
      processor.dispose();
    }
  });

  it('keeps the low split below the high split even when the stored values invert', () => {
    const resolved = resolveCrossoverFrequencies({ lowCrossFreq: 900, highCrossFreq: 600 });
    assert.ok(resolved.lowCrossHz < resolved.highCrossHz, 'low crossover must stay below the high crossover');
    assert.equal(resolved.lowCrossHz, 500, 'low is pulled to high - 100');
    assert.equal(resolved.highCrossHz, 600);
  });

  it('never labels a band above Nyquist', () => {
    const resolved = resolveCrossoverFrequencies({ lowCrossFreq: 150, highCrossFreq: 30000 }, 48000);
    assert.ok(resolved.highCrossHz <= 48000 * 0.49);
    const lowRate = resolveCrossoverFrequencies({ lowCrossFreq: 150, highCrossFreq: 30000 }, 22050);
    assert.ok(lowRate.highCrossHz <= 22050 * 0.49);
  });

  it('moves the band labels when the crossovers move, instead of printing a fixed range', () => {
    const narrow = bandRangeLabel({ lowCrossFreq: 80, highCrossFreq: 1800 }, 'midBand');
    const wide = bandRangeLabel({ lowCrossFreq: 500, highCrossFreq: 16000 }, 'midBand');
    assert.notEqual(narrow, wide);
    assert.equal(narrow, '80 Hz – 1.80 kHz');
    assert.equal(wide, '500 Hz – 16.0 kHz');
    assert.equal(bandRangeLabel({ lowCrossFreq: 150, highCrossFreq: 3500 }, 'lowBand'), '20 Hz – 150 Hz');
    assert.equal(bandRangeLabel({ lowCrossFreq: 300, highCrossFreq: 3500 }, 'lowBand'), '20 Hz – 300 Hz');
  });

  it('formats frequencies in the unit a mastering engineer would read', () => {
    assert.equal(formatFrequencyHz(150), '150 Hz');
    assert.equal(formatFrequencyHz(3500), '3.50 kHz');
    assert.equal(formatFrequencyHz(16000), '16.0 kHz');
    assert.equal(formatFrequencyHz(Number.NaN), '—');
  });
});

describe('Phase 90 — band dynamics parameters reach the compressor with honest units', () => {
  it('converts per-band attack and release from ms to seconds and passes knee through in dB', () => {
    const state: MasteringSuiteState = {
      ...DEFAULT_MASTERING_SUITE_STATE,
      lowBand: { ...DEFAULT_MASTERING_SUITE_STATE.lowBand, attack: 40, release: 320, knee: 9 },
      midBand: { ...DEFAULT_MASTERING_SUITE_STATE.midBand, attack: 5, release: 45, knee: 0 },
      highBand: { ...DEFAULT_MASTERING_SUITE_STATE.highBand, attack: 1, release: 500, knee: 12 },
    };
    const { processor, bandCompressors } = buildProcessor(state);
    assert.equal(bandCompressors[0].attack.value, 0.04);
    assert.equal(bandCompressors[0].release.value, 0.32);
    assert.equal(bandCompressors[0].knee.value, 9);
    assert.equal(bandCompressors[1].attack.value, 0.005);
    assert.equal(bandCompressors[1].release.value, 0.045);
    assert.equal(bandCompressors[1].knee.value, 0);
    assert.equal(bandCompressors[2].attack.value, 0.001);
    assert.equal(bandCompressors[2].release.value, 0.5);
    assert.equal(bandCompressors[2].knee.value, 12);
    processor.dispose();
  });

  it('follows a live control change into the same parameters via setState', () => {
    const { processor, bandCompressors } = buildProcessor(DEFAULT_MASTERING_SUITE_STATE);
    const afterAttack = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'highBand.attack', '75');
    processor.setState(afterAttack);
    assert.equal(bandCompressors[2].attack.value, 0.075);
    // Sibling bands keep their previous attack.
    assert.equal(bandCompressors[0].attack.value, DEFAULT_MASTERING_SUITE_STATE.lowBand.attack / 1000);
    assert.equal(bandCompressors[1].attack.value, DEFAULT_MASTERING_SUITE_STATE.midBand.attack / 1000);

    const afterKnee = applyMasteringControlChange(afterAttack, 'lowBand.knee', '11.5');
    processor.setState(afterKnee);
    assert.equal(bandCompressors[0].knee.value, 11.5);
    processor.dispose();
  });

  it('writes maximizer release in seconds, leaving threshold and ceiling alone', () => {
    const { processor, maximizer } = buildProcessor(DEFAULT_MASTERING_SUITE_STATE);
    assert.equal(maximizer.release.value, DEFAULT_MASTERING_SUITE_STATE.maximizerRelease / 1000);
    const before = { threshold: maximizer.threshold.value, ratio: maximizer.ratio.value, knee: maximizer.knee.value };

    const next = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerRelease', '240');
    processor.setState(next);
    assert.equal(maximizer.release.value, 0.24);
    assert.equal(maximizer.threshold.value, before.threshold, 'release must not move the maximizer threshold');
    assert.equal(maximizer.ratio.value, before.ratio);
    assert.equal(maximizer.knee.value, before.knee);
    processor.dispose();
  });

  it('drives band solo and mute through the band gain node only', () => {
    const { processor, bandGains } = buildProcessor(DEFAULT_MASTERING_SUITE_STATE);
    const unityFor = (gainDb: number) => Math.pow(10, gainDb / 20);

    const mutedLow = toggleBandMute(DEFAULT_MASTERING_SUITE_STATE, 'lowBand');
    processor.setState(mutedLow);
    assert.equal(bandGains[0].gain.value, 0, 'a muted band is silent');
    assert.ok(Math.abs(bandGains[1].gain.value - unityFor(DEFAULT_MASTERING_SUITE_STATE.midBand.gain)) < 1e-9, 'the mid band is untouched');
    assert.ok(Math.abs(bandGains[2].gain.value - unityFor(DEFAULT_MASTERING_SUITE_STATE.highBand.gain)) < 1e-9, 'the high band is untouched');

    const soloHigh = toggleBandSolo(DEFAULT_MASTERING_SUITE_STATE, 'highBand');
    processor.setState(soloHigh);
    assert.equal(bandGains[0].gain.value, 0);
    assert.equal(bandGains[1].gain.value, 0);
    assert.ok(Math.abs(bandGains[2].gain.value - unityFor(DEFAULT_MASTERING_SUITE_STATE.highBand.gain)) < 1e-9, 'the soloed band keeps its makeup gain');
    processor.dispose();
  });
});
