import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState } from './projectState';
import {
  DELAY_FEEDBACK_MAX,
  FILTER_CUTOFF_MAX_HZ,
  applyMacroRackUpdate,
  macroParameterKey,
  reapplyMacroRackOnHydration,
  resolveMacroCurveValue,
  resolveMacroKnob,
  resolveMacroRack,
  summarizeMacroRack,
  type MacroMapping
} from './macroMappings';
import { FILTER_CUTOFF_MIN_HZ, MIXER_VOLUME_MAX } from '../audio/parameterScaling';
import { updateMacroRackInProjectState } from './projectMutations';
import type { MasterMacroKnob, ProjectState } from '../types/daw';

const mapping = (overrides: Partial<MacroMapping> = {}): MacroMapping => ({
  targetType: 'channel_volume',
  targetId: 'ch-1',
  min: 0,
  max: 1,
  curve: 'linear',
  ...overrides
});

const knob = (
  value: number,
  mappings: MacroMapping[],
  overrides: Partial<MasterMacroKnob> = {}
): MasterMacroKnob => ({
  id: 'macro-test',
  name: 'Test Macro',
  value,
  color: '#00ff88',
  mappings,
  ...overrides
});

/** Default project plus one delay slot on track 1, so every target has a home. */
const projectWithFx = (): ProjectState => {
  const state = createDefaultProjectState();
  state.mixerTracks = state.mixerTracks.map(track =>
    track.id === 1
      ? {
          ...track,
          fxSlots: [
            ...track.fxSlots,
            {
              id: 'fx-1-verb',
              type: 'reverb' as const,
              name: 'Insert Reverb',
              enabled: true,
              mix: 0.25,
              params: { roomSize: 0.6 }
            },
            {
              id: 'fx-1-delay',
              type: 'delay' as const,
              name: 'Insert Delay',
              enabled: true,
              mix: 0.3,
              params: { time: 0.35, feedback: 0.45 }
            }
          ]
        }
      : track
  );
  return state;
};

const channelOf = (state: ProjectState, id: string) =>
  state.channels.find(channel => channel.id === id)!;
const trackOf = (state: ProjectState, id: number) =>
  state.mixerTracks.find(track => track.id === id)!;
const slotOf = (state: ProjectState, trackId: number, slotId: string) =>
  trackOf(state, trackId).fxSlots.find(slot => slot.id === slotId)!;

// --- curve semantics -------------------------------------------------------

test('linear curve interpolates evenly and is exact at both endpoints', () => {
  assert.equal(resolveMacroCurveValue(200, 1000, 'linear', 0), 200);
  assert.equal(resolveMacroCurveValue(200, 1000, 'linear', 1), 1000);
  assert.equal(resolveMacroCurveValue(200, 1000, 'linear', 0.5), 600);
});

test('exponential curve is a slow-start taper that still ascends to max', () => {
  assert.equal(resolveMacroCurveValue(200, 1000, 'exponential', 0), 200);
  assert.equal(resolveMacroCurveValue(200, 1000, 'exponential', 1), 1000);
  // Quadratic taper: half travel covers a quarter of the range.
  assert.equal(resolveMacroCurveValue(200, 1000, 'exponential', 0.5), 400);
});

test('logarithmic curve is a fast-start taper that still ascends to max', () => {
  assert.equal(resolveMacroCurveValue(200, 1000, 'logarithmic', 0), 200);
  assert.equal(resolveMacroCurveValue(200, 1000, 'logarithmic', 1), 1000);
  assert.equal(resolveMacroCurveValue(200, 1000, 'logarithmic', 0.5), 800);
});

test('every curve ascends monotonically and never inverts the knob direction', () => {
  for (const curve of ['linear', 'exponential', 'logarithmic'] as const) {
    let previous = Number.NEGATIVE_INFINITY;
    for (let step = 0; step <= 20; step += 1) {
      const value = resolveMacroCurveValue(-40, 120, curve, step / 20);
      assert.ok(value >= previous, `${curve} regressed at step ${step}`);
      previous = value;
    }
  }
});

test('curve shapes differ only by acceleration, not by direction', () => {
  const low = 0;
  const high = 1;
  const quarter = [
    resolveMacroCurveValue(low, high, 'exponential', 0.25),
    resolveMacroCurveValue(low, high, 'linear', 0.25),
    resolveMacroCurveValue(low, high, 'logarithmic', 0.25)
  ];
  assert.ok(quarter[0] < quarter[1] && quarter[1] < quarter[2], 'exponential < linear < logarithmic');
});

test('curve output is clamped into the declared range', () => {
  assert.equal(resolveMacroCurveValue(0.2, 0.8, 'linear', 4), 0.8);
  assert.equal(resolveMacroCurveValue(0.2, 0.8, 'linear', -4), 0.2);
  assert.equal(resolveMacroCurveValue(0.2, 0.8, 'exponential', Number.NaN), 0.2);
});

test('an inverted range behaves like the equivalent ascending range', () => {
  assert.equal(resolveMacroCurveValue(1, 0.2, 'linear', 0), 0.2);
  assert.equal(resolveMacroCurveValue(1, 0.2, 'linear', 1), 1);
  assert.ok(Math.abs(resolveMacroCurveValue(1, 0.2, 'linear', 0.5) - 0.6) < 1e-12);
});

test('a single-value range resolves to that value everywhere', () => {
  assert.equal(resolveMacroCurveValue(0.5, 0.5, 'exponential', 0.3), 0.5);
});

test('an unrecognised curve falls back to linear instead of dropping the mapping', () => {
  assert.equal(resolveMacroCurveValue(0, 10, undefined, 0.5), 5);
  assert.equal(resolveMacroCurveValue(0, 10, 'bogus' as never, 0.5), 5);
});

// --- the seven targets -----------------------------------------------------

test('channel_volume and channel_pan resolve against a channel id', () => {
  const state = createDefaultProjectState();
  const resolved = resolveMacroKnob(
    knob(0.5, [
      mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0.4, max: 1 }),
      mapping({ targetType: 'channel_pan', targetId: 'ch-2', min: -1, max: 1 })
    ]),
    state
  );

  assert.equal(resolved.unresolved.length, 0);
  assert.deepEqual(resolved.parameters.map(parameter => [parameter.parameter, parameter.value]), [
    ['channel.volume', 0.7],
    ['channel.pan', 0]
  ]);

  const applied = applyMacroRackUpdate(state, [knob(0.5, [
    mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0.4, max: 1 }),
    mapping({ targetType: 'channel_pan', targetId: 'ch-2', min: -1, max: 1 })
  ])]);
  assert.equal(channelOf(applied, 'ch-1').volume, 0.7);
  assert.equal(channelOf(applied, 'ch-2').pan, 0);
});

test('mixer_volume and mixer_pan resolve numeric and numeric-string track ids identically', () => {
  const state = createDefaultProjectState();
  const fromNumber = resolveMacroKnob(
    knob(1, [mapping({ targetType: 'mixer_volume', targetId: 2, min: 0, max: 1.25 })]),
    state
  );
  const fromString = resolveMacroKnob(
    knob(1, [mapping({ targetType: 'mixer_volume', targetId: '2', min: 0, max: 1.25 })]),
    state
  );

  assert.equal(fromNumber.parameters[0].value, MIXER_VOLUME_MAX);
  assert.equal(fromString.parameters[0].value, MIXER_VOLUME_MAX);
  assert.equal(fromNumber.parameters[0].targetId, fromString.parameters[0].targetId);

  const applied = applyMacroRackUpdate(state, [knob(0.5, [
    mapping({ targetType: 'mixer_pan', targetId: '2', min: -1, max: 1 })
  ])]);
  assert.equal(trackOf(applied, 2).pan, 0);
});

test('filter_cutoff writes the channel synth filter and clamps to the model ceiling', () => {
  const state = createDefaultProjectState();
  const applied = applyMacroRackUpdate(state, [
    knob(1, [mapping({ targetType: 'filter_cutoff', targetId: 'ch-1', min: 200, max: 99000 })])
  ]);

  // 99000 Hz is above the filter model ceiling, so the resolved value is clamped.
  assert.equal(channelOf(applied, 'ch-1').synthParams.filterCutoff, FILTER_CUTOFF_MAX_HZ);
  assert.equal(FILTER_CUTOFF_MIN_HZ, 40);
  assert.equal(channelOf(applied, 'ch-2').synthParams.filterCutoff, 3500, 'untargeted channel untouched');
});

test('filter_cutoff addressed by mixer track sweeps every channel on that insert', () => {
  const state = createDefaultProjectState();
  // ch-1 and ch-2 share insert 2 in this fixture, so one bus mapping moves both.
  state.channels = state.channels.map(channel => ({ ...channel, mixerTrackId: 2 }));

  const applied = applyMacroRackUpdate(state, [
    knob(0.5, [mapping({ targetType: 'filter_cutoff', targetId: 2, min: 100, max: 500, curve: 'linear' })])
  ]);

  assert.equal(channelOf(applied, 'ch-1').synthParams.filterCutoff, 300);
  assert.equal(channelOf(applied, 'ch-2').synthParams.filterCutoff, 300);
});

test('reverb_wet drives the reverb slot wet/dry mix, not a synth parameter', () => {
  const state = projectWithFx();
  const applied = applyMacroRackUpdate(state, [
    knob(0.5, [mapping({ targetType: 'reverb_wet', targetId: 1, min: 0.1, max: 0.9, curve: 'linear' })])
  ]);

  assert.equal(slotOf(applied, 1, 'fx-1-verb').mix, 0.5);
  assert.equal(slotOf(applied, 1, 'fx-1-verb').params.roomSize, 0.6, 'other slot params preserved');
  assert.equal(channelOf(applied, 'ch-1').synthParams.filterCutoff, 3500, 'synth params untouched');
});

test('delay_feedback writes the delay slot feedback and respects the unity-feedback ceiling', () => {
  const state = projectWithFx();
  const applied = applyMacroRackUpdate(state, [
    knob(1, [mapping({ targetType: 'delay_feedback', targetId: 1, min: 0.1, max: 2, curve: 'linear' })])
  ]);

  // 2.0 would build a unity-or-greater feedback loop; the model bound wins.
  assert.equal(slotOf(applied, 1, 'fx-1-delay').params.feedback, DELAY_FEEDBACK_MAX);
  assert.equal(slotOf(applied, 1, 'fx-1-delay').mix, 0.3, 'slot wet mix preserved');
});

test('fx targets accept a channel id and resolve it to that channel insert', () => {
  const state = projectWithFx();
  const applied = applyMacroRackUpdate(state, [
    knob(0.5, [
      mapping({ targetType: 'reverb_wet', targetId: 'ch-2', min: 0, max: 1 }),
      mapping({ targetType: 'delay_feedback', targetId: 'ch-1', min: 0, max: 1 })
    ])
  ]);

  // ch-2 routes to insert 2 (which carries the default reverb slot).
  assert.equal(slotOf(applied, 2, 'fx-2-verb').mix, 0.5);
  // ch-1 routes to insert 1, which this fixture gives the delay slot.
  assert.equal(slotOf(applied, 1, 'fx-1-delay').params.feedback, 0.5);
});

// --- hard-range clamping ---------------------------------------------------

test('a declared range wider than the parameter model is clamped to the model', () => {
  const state = createDefaultProjectState();
  const applied = applyMacroRackUpdate(state, [
    knob(1, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0.4, max: 1.5 })])
  ]);

  assert.equal(channelOf(applied, 'ch-1').volume, 1, 'channel volume cannot exceed 1');
});

test('a declared range below the model floor is clamped up to the model floor', () => {
  const state = createDefaultProjectState();
  const applied = applyMacroRackUpdate(state, [
    knob(0, [mapping({ targetType: 'channel_pan', targetId: 'ch-1', min: -4, max: 4 })])
  ]);

  assert.equal(channelOf(applied, 'ch-1').pan, -1);
});

// --- invalid targets are safe no-ops --------------------------------------

test('an unknown channel id resolves to an unresolved no-op and changes nothing', () => {
  const state = createDefaultProjectState();
  const before = structuredClone(state);
  const rack = [knob(0.9, [
    mapping({ targetType: 'channel_volume', targetId: 'bass', min: 0.4, max: 1 })
  ])];

  const resolution = resolveMacroRack(rack, state);
  assert.equal(resolution.parameters.length, 0);
  assert.equal(resolution.unresolved.length, 1);
  assert.match(resolution.unresolved[0].reason, /No channel matches target id "bass"/);

  const after = applyMacroRackUpdate(state, rack);
  assert.deepEqual(after.channels, before.channels);
  assert.deepEqual(after.mixerTracks, before.mixerTracks);
  assert.deepEqual(after.macroKnobs, rack, 'the knob document is still written');
});

test('an unknown mixer track id resolves to an unresolved no-op', () => {
  const state = createDefaultProjectState();
  const resolution = resolveMacroKnob(
    knob(0.5, [mapping({ targetType: 'mixer_volume', targetId: 99, min: 0, max: 1 })]),
    state
  );

  assert.equal(resolution.parameters.length, 0);
  assert.match(resolution.unresolved[0].reason, /No mixer track matches target id "99"/);
});

test('an unsupported target type is reported, never guessed at', () => {
  const state = createDefaultProjectState();
  const resolution = resolveMacroKnob(
    knob(0.5, [mapping({ targetType: 'not_a_target' as never, targetId: 'ch-1' })]),
    state
  );

  assert.equal(resolution.parameters.length, 0);
  assert.match(resolution.unresolved[0].reason, /has no runtime writer/);
});

test('a non-finite mapping range is rejected instead of writing NaN', () => {
  const state = createDefaultProjectState();
  const resolution = resolveMacroKnob(
    knob(0.5, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: Number.NaN, max: 1 })]),
    state
  );

  assert.equal(resolution.parameters.length, 0);
  assert.match(resolution.unresolved[0].reason, /must be finite/);
});

test('a reverb mapping against a track with no reverb slot is a no-op', () => {
  const state = createDefaultProjectState();
  const resolution = resolveMacroKnob(
    knob(0.5, [mapping({ targetType: 'reverb_wet', targetId: 1, min: 0, max: 1 })]),
    state
  );

  assert.equal(resolution.parameters.length, 0);
  assert.match(resolution.unresolved[0].reason, /no reverb slot/);
});

test('a delay mapping against a track with no delay slot is a no-op', () => {
  const state = createDefaultProjectState();
  const resolution = resolveMacroKnob(
    knob(0.5, [mapping({ targetType: 'delay_feedback', targetId: 2, min: 0, max: 1 })]),
    state
  );

  assert.equal(resolution.parameters.length, 0);
  assert.match(resolution.unresolved[0].reason, /no delay slot/);
});

test('the shipped default rack is safe to apply to a project that lacks its targets', () => {
  // The rack modal ships authored defaults, including a channel_volume mapping
  // for a "bass" channel that a fresh project does not have.
  const state = createDefaultProjectState();
  const defaultRack: MasterMacroKnob[] = [{
    id: 'macro-1',
    name: 'DROP BUILDUP (SWEEP)',
    value: 0.2,
    color: '#ff6e00',
    mappings: [
      { targetType: 'filter_cutoff', targetId: 1, min: 200, max: 18000, curve: 'exponential' },
      { targetType: 'reverb_wet', targetId: 1, min: 0.1, max: 0.85, curve: 'linear' },
      { targetType: 'channel_volume', targetId: 'bass', min: 0.4, max: 1.0, curve: 'linear' }
    ]
  }];

  const applied = applyMacroRackUpdate(state, defaultRack);

  // filter_cutoff via insert 1 and reverb_wet (no reverb on insert 1) plus the
  // missing "bass" channel: exactly one parameter resolves, the rest no-op.
  const resolution = summarizeMacroRack(defaultRack, state);
  assert.equal(resolution.parameters, 1);
  assert.equal(resolution.unresolved, 2);
  assert.ok(channelOf(applied, 'ch-1').synthParams.filterCutoff < 3500, 'sweep closed the filter');
});

// --- atomicity, determinism, idempotency ----------------------------------

test('one macro move writes the knob value and every resolved target in one state', () => {
  const state = projectWithFx();
  const rack = [knob(0.75, [
    mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0.2, max: 1, curve: 'linear' }),
    mapping({ targetType: 'mixer_volume', targetId: 2, min: 0, max: 1.25, curve: 'linear' }),
    mapping({ targetType: 'filter_cutoff', targetId: 'ch-2', min: 200, max: 2000, curve: 'linear' }),
    mapping({ targetType: 'reverb_wet', targetId: 2, min: 0, max: 1, curve: 'linear' })
  ])];

  const next = updateMacroRackInProjectState(state, rack);

  assert.equal(next.macroKnobs![0].value, 0.75);
  assert.equal(channelOf(next, 'ch-1').volume, 0.8);
  assert.equal(trackOf(next, 2).volume, 0.9375);
  assert.equal(channelOf(next, 'ch-2').synthParams.filterCutoff, 1550);
  assert.equal(slotOf(next, 2, 'fx-2-verb').mix, 0.75);
  assert.deepEqual(state.channels, createDefaultProjectState().channels, 'input state is not mutated');
});

test('applying the same rack twice is idempotent and returns the same reference', () => {
  const state = projectWithFx();
  const rack = [knob(0.4, [
    mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0, max: 1 }),
    mapping({ targetType: 'reverb_wet', targetId: 2, min: 0, max: 1 })
  ])];

  const once = applyMacroRackUpdate(state, rack);
  const twice = applyMacroRackUpdate(once, rack);

  assert.equal(twice, once, 'a re-applied rack is a no-op by reference');
  assert.equal(channelOf(twice, 'ch-1').volume, channelOf(once, 'ch-1').volume);
  assert.equal(slotOf(twice, 2, 'fx-2-verb').mix, slotOf(once, 2, 'fx-2-verb').mix);
});

test('overlapping mappings are still idempotent by identity', () => {
  // Regression: an earlier mapping's write must not register as a change when a
  // later mapping on the same parameter restores the value already in the state.
  const state = projectWithFx();
  const rack = [
    knob(0.25, [mapping({ targetType: 'mixer_volume', targetId: 2, min: 0, max: 1.25 })], { id: 'macro-a' }),
    knob(0.8, [mapping({ targetType: 'mixer_volume', targetId: 2, min: 0, max: 1.25 })], { id: 'macro-b' })
  ];

  const once = applyMacroRackUpdate(state, rack);
  const twice = applyMacroRackUpdate(once, rack);

  assert.equal(trackOf(once, 2).volume, 1);
  assert.equal(twice, once, 'a re-applied overlapping rack is a no-op by reference');
});

test('resolution depends on the rack, not on the current parameter value', () => {
  const state = projectWithFx();
  const rack = [knob(0.5, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0.2, max: 0.8 })])];

  const fromDefault = applyMacroRackUpdate(state, rack);
  const manuallyEdited: ProjectState = {
    ...state,
    channels: state.channels.map(channel =>
      channel.id === 'ch-1' ? { ...channel, volume: 0.05 } : channel
    )
  };
  const fromEdited = applyMacroRackUpdate(manuallyEdited, rack);

  assert.equal(channelOf(fromDefault, 'ch-1').volume, 0.5);
  assert.equal(channelOf(fromEdited, 'ch-1').volume, 0.5, 'no drift from the previous parameter value');
});

test('overlapping mappings resolve to the last declared write', () => {
  const state = projectWithFx();
  const rack = [
    knob(1, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0, max: 0.3 })], { id: 'macro-a' }),
    knob(1, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0, max: 0.9 })], { id: 'macro-b' })
  ];

  const applied = applyMacroRackUpdate(state, rack);

  assert.equal(channelOf(applied, 'ch-1').volume, 0.9);
});

test('two macros can drive one parameter and the second wins', () => {
  const state = createDefaultProjectState();
  const rack = [
    knob(0, [mapping({ targetType: 'channel_pan', targetId: 'ch-1', min: -1, max: 1 })], { id: 'macro-a' }),
    knob(1, [mapping({ targetType: 'channel_pan', targetId: 'ch-1', min: -1, max: 1 })], { id: 'macro-b' })
  ];

  const resolution = resolveMacroRack(rack, state);
  assert.equal(resolution.parameters.length, 2);
  assert.equal(
    macroParameterKey('channel_pan', 'ch-1', 'channel.pan'),
    'channel_pan:ch-1:channel.pan'
  );
  assert.equal(channelOf(applyMacroRackUpdate(state, rack), 'ch-1').pan, 1);
});

test('an out-of-range knob value is clamped before it is used', () => {
  const state = createDefaultProjectState();
  const high = applyMacroRackUpdate(state, [
    knob(9, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0, max: 1 })])
  ]);
  const low = applyMacroRackUpdate(state, [
    knob(-9, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0, max: 1 })])
  ]);

  assert.equal(channelOf(high, 'ch-1').volume, 1);
  assert.equal(channelOf(low, 'ch-1').volume, 0);
});

test('a non-finite knob value resolves as the bottom of the range', () => {
  const state = createDefaultProjectState();
  const applied = applyMacroRackUpdate(state, [
    knob(Number.NaN, [mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0.25, max: 1 })])
  ]);

  assert.equal(channelOf(applied, 'ch-1').volume, 0.25);
});

test('a malformed mapping entry is reported without breaking its siblings', () => {
  const state = createDefaultProjectState();
  const rack = [knob(0.5, [
    undefined as unknown as MacroMapping,
    mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0, max: 1 })
  ])];

  const resolution = resolveMacroRack(rack, state);
  assert.equal(resolution.parameters.length, 1, 'the valid sibling still resolves');
  assert.equal(resolution.unresolved.length, 1);

  const applied = applyMacroRackUpdate(state, rack);
  assert.equal(channelOf(applied, 'ch-1').volume, 0.5);
});

test('a rack with no mappings leaves project state untouched', () => {
  const state = createDefaultProjectState();
  const next = applyMacroRackUpdate(state, [knob(0.5, [])]);

  assert.equal(next.channels, state.channels);
  assert.equal(next.mixerTracks, state.mixerTracks);
  assert.equal(next.macroKnobs!.length, 1);
});

test('projects without a rack are returned by reference on hydration', () => {
  const state = createDefaultProjectState();
  assert.equal(state.macroKnobs, undefined);
  assert.equal(reapplyMacroRackOnHydration(state), state, 'a missing rack is a no-op');

  const explicitEmptyRack: ProjectState = { ...state, macroKnobs: [] };
  assert.equal(reapplyMacroRackOnHydration(explicitEmptyRack), explicitEmptyRack, 'an empty rack is a no-op');
});

test('hydration re-applies a stored rack so a reopened project matches its macros', () => {
  const state = projectWithFx();
  const rack = [knob(0.8, [
    mapping({ targetType: 'channel_volume', targetId: 'ch-1', min: 0, max: 1 }),
    mapping({ targetType: 'reverb_wet', targetId: 2, min: 0, max: 1 })
  ])];
  const saved = applyMacroRackUpdate(state, rack);

  // Simulate a stale/partially-applied document: same rack, unresolved parameters.
  const stale: ProjectState = {
    ...state,
    macroKnobs: rack,
    channels: state.channels.map(channel =>
      channel.id === 'ch-1' ? { ...channel, volume: 0.11 } : channel
    )
  };

  const hydrated = reapplyMacroRackOnHydration(stale);
  assert.equal(channelOf(hydrated, 'ch-1').volume, 0.8);
  assert.equal(slotOf(hydrated, 2, 'fx-2-verb').mix, 0.8);
  assert.equal(channelOf(hydrated, 'ch-1').volume, channelOf(saved, 'ch-1').volume);
});

test('summarizeMacroRack counts applied and unresolved mappings', () => {
  const state = projectWithFx();
  const rack = [knob(0.5, [
    mapping({ targetType: 'channel_volume', targetId: 'ch-1' }),
    mapping({ targetType: 'channel_pan', targetId: 'ch-1' }),
    mapping({ targetType: 'channel_volume', targetId: 'ghost' })
  ])];

  assert.deepEqual(summarizeMacroRack(rack, state), { applied: 2, unresolved: 1, parameters: 2 });
  assert.deepEqual(summarizeMacroRack([], state), { applied: 0, unresolved: 0, parameters: 0 });
  assert.deepEqual(summarizeMacroRack(undefined, state), { applied: 0, unresolved: 0, parameters: 0 });
});
