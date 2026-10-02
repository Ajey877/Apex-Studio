import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROSS_BEAT_MIN_GAIN,
  GROSS_BEAT_MIX_DEPTH,
  GROSS_BEAT_OPEN_GAIN,
  GROSS_BEAT_STEP_COUNT,
  isGrossBeatStepOpen,
  resolveGrossBeatClosedGain,
  resolveGrossBeatGateGain,
  wrapGrossBeatStep,
  type GrossBeatGateInput,
} from './grossBeatGate';
import { audioEngine } from './audioEngine';

/**
 * Phase 57 - Gross Beat truth pass: shared master-gate contract.
 *
 * The engine never implemented time-stretch, pitch-shift, half-time or tape
 * processing. It implements a 16-step amplitude gate on the master bus. These
 * tests pin that contract so the live transport and the offline/export
 * renderer cannot drift apart, and so the maths stays exactly:
 *
 *     closed-step gain = max(0.01, 1 - mix * 0.95)
 */

/** Tight enough to pin the contract, loose enough for IEEE-754 double noise. */
const EPSILON = 1e-12;

function assertClose(actual: number, expected: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    `${message ?? 'value'}: expected ${expected}, got ${actual}`,
  );
}

function gate(overrides: Partial<GrossBeatGateInput> = {}): GrossBeatGateInput {
  return {
    enabled: true,
    mix: 1,
    gateSteps: Array.from({ length: GROSS_BEAT_STEP_COUNT }, (_, index) => index % 2 === 0),
    ...overrides,
  };
}

test('an open step always passes the master bus at unity, at every mix depth', () => {
  for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(
      resolveGrossBeatGateGain(gate({ mix }), 0),
      GROSS_BEAT_OPEN_GAIN,
      `open step must stay at unity for mix=${mix}`,
    );
  }
});

test('a closed step at mix 0 applies no depth and stays at unity', () => {
  assert.equal(resolveGrossBeatGateGain(gate({ mix: 0 }), 1), GROSS_BEAT_OPEN_GAIN);
});

test('a closed step at mix 1 reaches the documented maximum depth of 0.05', () => {
  // 1 - (1 * 0.95) === 0.05 - the deepest the gate closes with a 0..1 mix.
  assertClose(resolveGrossBeatGateGain(gate({ mix: 1 }), 1), 0.05);
});

test('closed-step gain follows 1 - mix * 0.95 across the mix range', () => {
  for (const mix of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const expected = Math.max(GROSS_BEAT_MIN_GAIN, 1 - mix * GROSS_BEAT_MIX_DEPTH);
    assertClose(
      resolveGrossBeatGateGain(gate({ mix }), 1),
      expected,
      `mix=${mix} must resolve to 1 - mix * 0.95`,
    );
  }
});

test('closed-step gain deepens monotonically as mix rises', () => {
  let previous = Number.POSITIVE_INFINITY;
  for (let hundredths = 0; hundredths <= 100; hundredths += 1) {
    const gain = resolveGrossBeatGateGain(gate({ mix: hundredths / 100 }), 1);
    assert.ok(gain <= previous, `gain must not rise as mix grows (mix=${hundredths / 100})`);
    previous = gain;
  }
  assertClose(previous, 0.05, 'full mix must reach the documented maximum depth');
});

test('the closed-step gain never falls below the 0.01 floor', () => {
  for (let hundredths = 0; hundredths <= 400; hundredths += 1) {
    const mix = hundredths / 100;
    const gain = resolveGrossBeatGateGain(gate({ mix }), 1);
    assert.ok(
      gain >= GROSS_BEAT_MIN_GAIN,
      `mix=${mix} produced ${gain}, below the ${GROSS_BEAT_MIN_GAIN} floor`,
    );
  }
});

test('the 0.01 floor actually binds once mix drives the formula below it', () => {
  // 1 - mix * 0.95 < 0.01 once mix > ~1.042, so the floor is what is heard.
  assert.equal(resolveGrossBeatGateGain(gate({ mix: 3 }), 1), GROSS_BEAT_MIN_GAIN);
  assert.equal(resolveGrossBeatClosedGain(3), GROSS_BEAT_MIN_GAIN);
});

test('a disabled gate is fully transparent for every step and mix', () => {
  const disabled = gate({ enabled: false, mix: 1 });
  for (let step = 0; step < GROSS_BEAT_STEP_COUNT * 2; step += 1) {
    assert.equal(
      resolveGrossBeatGateGain(disabled, step),
      GROSS_BEAT_OPEN_GAIN,
      `step ${step} must pass at unity while the gate is bypassed`,
    );
  }
});

test('step 16 wraps back onto step 0 of the 16-step grid', () => {
  const alternating = gate({ mix: 0.7 });
  for (let step = 0; step < GROSS_BEAT_STEP_COUNT; step += 1) {
    assert.equal(
      resolveGrossBeatGateGain(alternating, step + GROSS_BEAT_STEP_COUNT),
      resolveGrossBeatGateGain(alternating, step),
      `step ${step + GROSS_BEAT_STEP_COUNT} must behave exactly like step ${step}`,
    );
  }
});

test('the 16-step grid repeats exactly every 16 steps', () => {
  const pattern = gate({
    mix: 0.8,
    gateSteps: [true, true, false, true, false, false, true, false, true, true, false, true, false, false, false, true],
  });
  const firstCycle = Array.from({ length: 16 }, (_, step) => resolveGrossBeatGateGain(pattern, step));
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const later = Array.from(
      { length: 16 },
      (_, step) => resolveGrossBeatGateGain(pattern, step + cycle * 16),
    );
    assert.deepEqual(later, firstCycle, `cycle ${cycle} must repeat cycle 0`);
  }
});

test('negative and fractional step indices wrap onto the same grid', () => {
  const pattern = gate({ mix: 0.6 });
  assert.equal(wrapGrossBeatStep(-1), GROSS_BEAT_STEP_COUNT - 1);
  assert.equal(wrapGrossBeatStep(-16), 0);
  assert.equal(wrapGrossBeatStep(16.9), 0);
  assert.equal(resolveGrossBeatGateGain(pattern, -1), resolveGrossBeatGateGain(pattern, 15));
  assert.equal(resolveGrossBeatGateGain(pattern, -2), resolveGrossBeatGateGain(pattern, 14));
});

test('alternating 16ths gate every other step', () => {
  const alternating = gate({ mix: 1 });
  for (let step = 0; step < 16; step += 1) {
    const open = step % 2 === 0;
    const expected = open ? GROSS_BEAT_OPEN_GAIN : 0.05;
    assertClose(
      resolveGrossBeatGateGain(alternating, step),
      expected,
      `step ${step} should be ${open ? 'open' : 'closed'}`,
    );
  }
});

test('a half-bar chop holds the first half open and closes the second half', () => {
  const halfBar = gate({
    mix: 0.5,
    gateSteps: [
      true, true, true, true, true, true, true, true,
      false, false, false, false, false, false, false, false,
    ],
  });
  for (let step = 0; step < 8; step += 1) {
    assert.equal(resolveGrossBeatGateGain(halfBar, step), GROSS_BEAT_OPEN_GAIN);
  }
  for (let step = 8; step < 16; step += 1) {
    assertClose(resolveGrossBeatGateGain(halfBar, step), Math.max(0.01, 1 - 0.5 * 0.95));
  }
});

test('a long-hold pattern closes exactly one step per bar', () => {
  const longHold = gate({
    mix: 1,
    gateSteps: [false, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true],
  });
  const closed = Array.from({ length: 16 }, (_, step) => resolveGrossBeatGateGain(longHold, step))
    .filter((gain) => gain !== GROSS_BEAT_OPEN_GAIN);
  assert.equal(closed.length, 1);
  assertClose(closed[0], 0.05);
});

test('an empty gate pattern cannot silence the master bus', () => {
  const empty = gate({ mix: 1, gateSteps: [] });
  for (let step = 0; step < 16; step += 1) {
    assert.equal(resolveGrossBeatGateGain(empty, step), GROSS_BEAT_OPEN_GAIN);
  }
  assert.equal(isGrossBeatStepOpen([], 3), true);
});

test('the resolver is a pure function of its inputs', () => {
  const state = gate({ mix: 0.42 });
  const first = Array.from({ length: 32 }, (_, step) => resolveGrossBeatGateGain(state, step));
  const second = Array.from({ length: 32 }, (_, step) => resolveGrossBeatGateGain(state, step));
  assert.deepEqual(first, second);
  assert.equal(resolveGrossBeatGateGain(state, 5), resolveGrossBeatGateGain(gate({ mix: 0.42 }), 5));
});

test('live and offline/export paths schedule identical gains through the shared resolver', () => {
  // The live transport (audioEngine step callback) and the offline renderer
  // both drive the engine's single step trigger. Recording the gains each one
  // schedules onto the master-gate node proves both paths resolve through the
  // same shared contract rather than a duplicated formula.
  const engine = audioEngine as any;
  const saved = {
    ctx: engine.ctx,
    grossBeatNode: engine.grossBeatNode,
    grossBeatState: engine.grossBeatState,
    activePlayMode: engine.activePlayMode,
    activeChannels: engine.activeChannels,
    activeClips: engine.activeClips,
    currentStep: engine.currentStep,
    metronome: engine.metronome,
    masterGain: engine.masterGain,
  };

  const makeGateNode = () => {
    const scheduled: number[] = [];
    const node = {
      scheduled,
      connect: () => node,
      gain: {
        value: 1,
        setTargetAtTime: (value: number) => { scheduled.push(value); },
        setValueAtTime: (value: number) => { scheduled.push(value); },
        cancelScheduledValues: () => undefined,
      },
    };
    return node;
  };

  try {
    const state = gate({ enabled: true, mix: 0.65 });
    engine.ctx = { currentTime: 0, destination: {} };
    engine.grossBeatState = { ...state };
    engine.activePlayMode = 'pat';
    engine.activeChannels = [];
    engine.activeClips = [];
    engine.metronome = false;
    engine.masterGain = null;

    // Pass 1 - the live transport's step driver.
    const liveNode = makeGateNode();
    engine.grossBeatNode = liveNode;
    for (let step = 0; step < 16; step += 1) {
      engine.currentStep = step;
      engine.triggerCurrentStep(1);
    }

    // Pass 2 - the offline/export renderer's step driver, invoked exactly the
    // way the render loop invokes it (inside an offline render operation).
    const exportNode = makeGateNode();
    engine.grossBeatNode = exportNode;
    for (let step = 0; step < 16; step += 1) {
      engine.currentStep = step;
      engine.withOfflineRenderOperation(() => engine.triggerCurrentStep(1));
    }

    const expected = Array.from({ length: 16 }, (_, step) => resolveGrossBeatGateGain(state, step));

    assert.equal(liveNode.scheduled.length, 16, 'live path must schedule one gain per step');
    assert.equal(exportNode.scheduled.length, 16, 'export path must schedule one gain per step');
    assert.deepEqual(liveNode.scheduled, expected, 'live path must use the shared resolver');
    assert.deepEqual(exportNode.scheduled, expected, 'export path must use the shared resolver');
    assert.deepEqual(exportNode.scheduled, liveNode.scheduled, 'live and export must agree exactly');
  } finally {
    engine.ctx = saved.ctx;
    engine.grossBeatNode = saved.grossBeatNode;
    engine.grossBeatState = saved.grossBeatState;
    engine.activePlayMode = saved.activePlayMode;
    engine.activeChannels = saved.activeChannels;
    engine.activeClips = saved.activeClips;
    engine.currentStep = saved.currentStep;
    engine.metronome = saved.metronome;
    engine.masterGain = saved.masterGain;
  }
});
