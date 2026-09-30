/**
 * Phase 46 — Runtime MIDI CC mapping regression coverage.
 *
 * Before this phase, `ProjectState.midiMappings` were saved, listed as active,
 * and then never consumed by the runtime: `audioEngine` dispatched CC events to
 * its listeners, but no listener ever applied a stored mapping to the mapped
 * DAW parameter. These tests lock in the fix by driving real CC events through
 * the engine's MIDI path and asserting that the mapped parameter actually
 * changes.
 *
 * Covered:
 *   1. CC -> master volume
 *   2. CC -> mixer insert fader / channel fader
 *   3. CC -> channel pan / mixer pan
 *   4. CC -> supported FX parameter (slot wet/dry mix, channel filter cutoff/resonance)
 *   5. CC matching is by CC number only (the mapping model carries no MIDI channel)
 *   6. MIDI 0-127 -> target parameter range normalization
 *   7. Multiple mappings never consume each other's CC
 *   8. Unmapped CC never alters a parameter
 *   9. MIDI Learn capture creates the expected mapping, which then controls the target
 *  10. Mappings saved in a project/preset work after runtime initialization
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, MixerTrack, ProjectState } from '../types/daw';
import { audioEngine, type MidiEventPayload } from './audioEngine';
import { createDefaultProjectState } from '../state/projectState';
import { PRESET_PROJECTS } from './presets';
import {
  MidiCcMappingRuntime,
  findMidiMappingForCc,
  normalizeMidiCcValue,
  resolveMidiCcTarget,
  resolveMidiLearnCapture,
} from './midiMappingRuntime';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAVED_KEYS = [
  'ctx',
  'masterGain',
  'activeChannels',
  'activeMixerTracks',
  'playbackProjectChannels',
  'playbackProjectMixerTracks',
  'isPlaying',
  'isOfflineRendering',
];

let savedInternals: EngineInternals = {};
let masterGainWrites: number[] = [];

/** Installs the minimal engine surface the master-volume path touches. */
function installEngineSurface(): void {
  masterGainWrites = [];
  engine.ctx = { currentTime: 1.5, sampleRate: 48000 };
  engine.masterGain = {
    gain: {
      value: 1,
      setTargetAtTime(value: number) {
        masterGainWrites.push(value);
        this.value = value;
      },
      setValueAtTime(value: number) {
        masterGainWrites.push(value);
        this.value = value;
      },
    },
  };
}

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  installEngineSurface();
  engine.isPlaying = false;
  engine.isOfflineRendering = false;
});

afterEach(() => {
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

function closeTo(actual: number, expected: number, message?: string): void {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    message ?? `expected ${actual} to be within 1e-9 of ${expected}`,
  );
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return { ...createDefaultProjectState(), ...overrides };
}

function withMappings(state: ProjectState, mappings: ProjectState['midiMappings']): ProjectState {
  return { ...state, midiMappings: mappings };
}

function channelById(state: ProjectState, id: string): Channel {
  const channel = state.channels.find(candidate => candidate.id === id);
  assert.ok(channel, `fixture channel ${id} must exist`);
  return channel;
}

function trackById(state: ProjectState, id: number): MixerTrack {
  const track = state.mixerTracks.find(candidate => candidate.id === id);
  assert.ok(track, `fixture mixer track ${id} must exist`);
  return track;
}

interface Harness {
  runtime: MidiCcMappingRuntime;
  getState: () => ProjectState;
  mutations: Array<{ label: string; state: ProjectState }>;
  masterValues: number[];
}

/**
 * Wires the runtime exactly like `App.tsx` does: project mutations go through a
 * mutation port (the app routes this into `mutateProjectState`, so history and
 * runtime publication are preserved), while the master output is applied through
 * the audio engine's existing parameter API.
 */
function createHarness(initialState: ProjectState): Harness {
  let state = initialState;
  const mutations: Array<{ label: string; state: ProjectState }> = [];
  const masterValues: number[] = [];
  const runtime = new MidiCcMappingRuntime({
    getProjectState: () => state,
    applyProjectMutation: (updater, label) => {
      state = updater(state);
      mutations.push({ label, state });
    },
    applyMasterVolume: normalizedValue => {
      masterValues.push(normalizedValue);
      audioEngine.applyAutomationValue(
        { type: 'master_vol', targetId: 0 },
        normalizedValue,
        state.channels,
        state.mixerTracks,
      );
    },
  });
  return { runtime, getState: () => state, mutations, masterValues };
}

/** Feeds a raw MIDI byte message through the engine's real dispatch path. */
function dispatchEngineMidi(data: number[]): void {
  engine.handleMidiMessage({ data });
}

describe('Phase 46: CC value normalization (0-127 -> target range)', () => {
  it('normalizes raw MIDI CC bytes deterministically', () => {
    assert.equal(normalizeMidiCcValue(0), 0);
    assert.equal(normalizeMidiCcValue(127), 1);
    closeTo(normalizeMidiCcValue(64), 64 / 127);
    assert.equal(normalizeMidiCcValue(-12), 0, 'below-range values clamp to 0');
    assert.equal(normalizeMidiCcValue(999), 1, 'above-range values clamp to 1');
    assert.equal(normalizeMidiCcValue(Number.NaN), 0, 'non-finite values never produce NaN parameters');
  });

  it('carries a raw engine CC message through to the mixer fader range', () => {
    const state = withMappings(makeState(), [
      { ccNumber: 74, targetType: 'mixer_vol', targetId: 3 },
    ]);
    const harness = createHarness(state);
    const listener = (event: MidiEventPayload) => harness.runtime.handleMidiEvent(event);
    audioEngine.addMidiListener(listener);
    try {
      dispatchEngineMidi([0xb0, 74, 64]);
    } finally {
      audioEngine.removeMidiListener(listener);
    }

    closeTo(trackById(harness.getState(), 3).volume, (64 / 127) * 1.25);
    assert.equal(harness.mutations.length, 1, 'the CC produced exactly one project mutation');
  });
});

describe('Phase 46: CC -> master volume, channel and mixer faders', () => {
  it('applies a master_vol CC to the live master output gain', () => {
    const harness = createHarness(
      withMappings(makeState(), [{ ccNumber: 7, targetType: 'master_vol', targetId: 0 }]),
    );
    const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 7, value: 1 });

    assert.equal(result.status, 'applied');
    assert.deepEqual(harness.masterValues, [1]);
    closeTo(masterGainWrites.at(-1) as number, 1.2, 'master output uses the automation range (0..1.2)');
    assert.equal(harness.mutations.length, 0, 'master output is an engine parameter, not project state');
  });

  it('applies a channel_vol CC to the channel volume fader', () => {
    const harness = createHarness(
      withMappings(makeState(), [{ ccNumber: 74, targetType: 'channel_vol', targetId: 'ch-1' }]),
    );
    const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 0.25 });

    assert.equal(result.status, 'applied');
    closeTo(channelById(harness.getState(), 'ch-1').volume, 0.25);
    closeTo(channelById(harness.getState(), 'ch-2').volume, 0.85, 'other channels are untouched');
    assert.equal(harness.mutations.length, 1);
    assert.match(harness.mutations[0].label, /MIDI CC 74/);
  });

  it('applies a mixer_vol CC to the mixer insert fader (0..1.25 range)', () => {
    const harness = createHarness(
      withMappings(makeState(), [{ ccNumber: 74, targetType: 'mixer_vol', targetId: 3 }]),
    );
    harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 0.5 });

    closeTo(trackById(harness.getState(), 3).volume, 0.5 * 1.25);
    closeTo(trackById(harness.getState(), 1).volume, 0.95, 'other inserts keep their fader');
  });

  it('accepts the numeric-string target ids the mapping UI stores', () => {
    const harness = createHarness(
      withMappings(makeState(), [{ ccNumber: 74, targetType: 'mixer_vol', targetId: '3' }]),
    );
    const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 1 });

    assert.equal(result.status, 'applied');
    closeTo(trackById(harness.getState(), 3).volume, 1.25);
  });

  it('reports an unknown target instead of writing to an unrelated parameter', () => {
    const before = withMappings(makeState(), [
      { ccNumber: 74, targetType: 'channel_vol', targetId: 'ch-does-not-exist' },
    ]);
    const harness = createHarness(before);
    const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 1 });

    assert.equal(result.status, 'unsupported');
    assert.equal(harness.mutations.length, 0);
    assert.deepEqual(harness.getState(), before);
  });
});

describe('Phase 46: CC -> pan', () => {
  it('maps channel pan across the -1..1 parameter range', () => {
    const harness = createHarness(
      withMappings(makeState(), [{ ccNumber: 10, targetType: 'channel_pan', targetId: 'ch-1' }]),
    );

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 10, value: 0.5 });
    closeTo(channelById(harness.getState(), 'ch-1').pan, 0, 'center');

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 10, value: 0 });
    closeTo(channelById(harness.getState(), 'ch-1').pan, -1, 'hard left');

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 10, value: 1 });
    closeTo(channelById(harness.getState(), 'ch-1').pan, 1, 'hard right');
  });

  it('maps mixer pan across the -1..1 parameter range', () => {
    const harness = createHarness(
      withMappings(makeState(), [{ ccNumber: 10, targetType: 'mixer_pan', targetId: 2 }]),
    );

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 10, value: 0.75 });
    closeTo(trackById(harness.getState(), 2).pan, 0.5);
    closeTo(trackById(harness.getState(), 1).pan, 0, 'other inserts keep their pan');
  });
});

describe('Phase 46: CC -> supported FX parameter', () => {
  it('writes the FX slot wet/dry mix for the saved preset mapping shape', () => {
    const presetState = structuredClone(PRESET_PROJECTS[0].state);
    const harness = createHarness(presetState);
    const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 1, value: 0.5 });

    assert.equal(result.status, 'applied');
    const verbSlot = trackById(harness.getState(), 5).fxSlots.find(slot => slot.id === 'fx-5-verb');
    assert.ok(verbSlot);
    closeTo(verbSlot.mix, 0.5);
    assert.equal(harness.mutations[0].label, 'MIDI CC 1: Change effect mix');
  });

  it('writes the channel filter cutoff using the existing automation curve (40Hz..18040Hz)', () => {
    const harness = createHarness(
      withMappings(makeState(), [
        { ccNumber: 74, targetType: 'fx_param', targetId: 'ch-1', paramName: 'filterCutoff' },
      ]),
    );

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 1 });
    closeTo(channelById(harness.getState(), 'ch-1').synthParams.filterCutoff, 18040);

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 0.5 });
    closeTo(channelById(harness.getState(), 'ch-1').synthParams.filterCutoff, 4540);
  });

  it('writes the channel filter resonance using the existing automation range (0..20)', () => {
    const harness = createHarness(
      withMappings(makeState(), [
        { ccNumber: 71, targetType: 'fx_param', targetId: 'ch-1', paramName: 'filterResonance' },
      ]),
    );

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 71, value: 0.5 });
    closeTo(channelById(harness.getState(), 'ch-1').synthParams.filterResonance, 10);

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 71, value: 0 });
    closeTo(channelById(harness.getState(), 'ch-1').synthParams.filterResonance, 0.0001);
  });

  it('reports FX parameters with no runtime setter instead of inventing one', () => {
    const before = withMappings(makeState(), [
      { ccNumber: 74, targetType: 'fx_param', targetId: 'ch-1', paramName: 'reverb' },
      { ccNumber: 75, targetType: 'fx_param', targetId: 3, paramName: 'fx_param #3' },
    ]);
    const harness = createHarness(before);

    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 1 }).status, 'unsupported');
    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 75, value: 1 }).status, 'unsupported');
    assert.equal(harness.mutations.length, 0);
    assert.deepEqual(harness.getState(), before);
  });
});

describe('Phase 46: mapping matching rules', () => {
  it('matches on CC number and is channel-agnostic, because the mapping model has no MIDI channel', () => {
    const mapping = { ccNumber: 74, targetType: 'mixer_vol' as const, targetId: 3 };
    assert.deepEqual(
      Object.keys(mapping).sort(),
      ['ccNumber', 'targetId', 'targetType'],
      'no MIDI channel field is added to the persisted mapping model',
    );

    const harness = createHarness(
      withMappings(makeState(), [
        { ccNumber: 7, targetType: 'master_vol', targetId: 0 },
        { ccNumber: 74, targetType: 'channel_vol', targetId: 'ch-1' },
      ]),
    );

    // Same CC number from different MIDI channels resolves to the same mapping.
    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 0.5, midiChannel: 1 }).status, 'applied');
    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 0.5, midiChannel: 16 }).status, 'applied');
    closeTo(channelById(harness.getState(), 'ch-1').volume, 0.5);
  });

  it('selects the first mapping registered for a CC number', () => {
    const mappings = [
      { ccNumber: 7, targetType: 'master_vol' as const, targetId: 0 },
      { ccNumber: 74, targetType: 'channel_vol' as const, targetId: 'ch-1' },
    ];
    assert.equal(findMidiMappingForCc(mappings, 74)?.targetType, 'channel_vol');
    assert.equal(findMidiMappingForCc(mappings, 99), undefined);
  });

  it('ignores non-CC MIDI events', () => {
    const harness = createHarness(
      withMappings(makeState(), [{ ccNumber: 60, targetType: 'channel_vol', targetId: 'ch-1' }]),
    );

    assert.equal(harness.runtime.handleMidiEvent({ type: 'noteOn', note: 60, velocity: 1 }).status, 'ignored');
    assert.equal(harness.runtime.handleMidiEvent({ type: 'pitchBend', value: 0.5 }).status, 'ignored');
    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', value: 0.5 }).status, 'ignored');
    assert.equal(harness.mutations.length, 0);
  });

  it('never lets one mapping consume the CC of another mapping', () => {
    const harness = createHarness(
      withMappings(makeState(), [
        { ccNumber: 7, targetType: 'master_vol', targetId: 0 },
        { ccNumber: 74, targetType: 'channel_vol', targetId: 'ch-1' },
        { ccNumber: 71, targetType: 'mixer_vol', targetId: 2 },
      ]),
    );
    const before = harness.getState();

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 0.4 });

    closeTo(channelById(harness.getState(), 'ch-1').volume, 0.4);
    closeTo(channelById(harness.getState(), 'ch-2').volume, before.channels[1].volume, 'sibling channel untouched');
    closeTo(trackById(harness.getState(), 2).volume, before.mixerTracks[2].volume, 'other mapping untouched');
    assert.equal(harness.masterValues.length, 0, 'master mapping untouched');

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 71, value: 0.2 });

    closeTo(trackById(harness.getState(), 2).volume, 0.2 * 1.25);
    closeTo(channelById(harness.getState(), 'ch-1').volume, 0.4, 'previous channel value is preserved');
    assert.equal(harness.masterValues.length, 0, 'master mapping still untouched');
  });

  it('leaves every parameter untouched for an unmapped CC', () => {
    const before = withMappings(makeState(), [
      { ccNumber: 7, targetType: 'master_vol', targetId: 0 },
      { ccNumber: 74, targetType: 'channel_vol', targetId: 'ch-1' },
      { ccNumber: 10, targetType: 'channel_pan', targetId: 'ch-1' },
    ]);
    const harness = createHarness(before);
    const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 99, value: 1 });

    assert.equal(result.status, 'unmapped');
    assert.equal(harness.mutations.length, 0);
    assert.equal(harness.masterValues.length, 0);
    assert.equal(masterGainWrites.length, 0);
    assert.deepEqual(harness.getState(), before);
  });

  it('does nothing when the project has no MIDI mappings at all', () => {
    const harness = createHarness(makeState());
    const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 7, value: 1 });

    assert.equal(result.status, 'unmapped');
    assert.equal(harness.mutations.length, 0);
    assert.equal(harness.masterValues.length, 0);
  });
});

describe('Phase 46: MIDI Learn', () => {
  it('captures the first incoming CC into the requested mapping', () => {
    const capture = resolveMidiLearnCapture({ type: 'cc', cc: 11, value: 0.5, midiChannel: 2 }, [], {
      targetType: 'mixer_vol',
      targetId: 3,
    });

    assert.ok(capture);
    assert.equal(capture.ccNumber, 11);
    assert.deepEqual(capture.mapping, {
      ccNumber: 11,
      targetType: 'mixer_vol',
      targetId: 3,
      paramName: 'mixer_vol #3',
    });
    assert.deepEqual(capture.mappings, [capture.mapping]);
  });

  it('ignores non-CC traffic while learning', () => {
    assert.equal(
      resolveMidiLearnCapture({ type: 'noteOn', note: 60, velocity: 1 }, [], {
        targetType: 'channel_vol',
        targetId: 'ch-1',
      }),
      null,
    );
    assert.equal(
      resolveMidiLearnCapture({ type: 'pitchBend', value: 0.25 }, [], {
        targetType: 'channel_vol',
        targetId: 'ch-1',
      }),
      null,
    );
  });

  it('replaces an existing CC binding and an existing binding for the same target', () => {
    const existing = [
      { ccNumber: 11, targetType: 'master_vol' as const, targetId: 0, paramName: 'Master Volume' },
      { ccNumber: 20, targetType: 'mixer_vol' as const, targetId: 3, paramName: 'Old label' },
    ];

    const capture = resolveMidiLearnCapture({ type: 'cc', cc: 21, value: 1 }, existing, {
      targetType: 'mixer_vol',
      targetId: 3,
    });

    assert.ok(capture);
    assert.deepEqual(capture.mappings, [
      { ccNumber: 11, targetType: 'master_vol', targetId: 0, paramName: 'Master Volume' },
      { ccNumber: 21, targetType: 'mixer_vol', targetId: 3, paramName: 'mixer_vol #3' },
    ]);
  });

  it('controls the mapped target with the CC learned moments earlier', () => {
    const harness = createHarness(makeState());
    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 11, value: 1 }).status, 'unmapped');

    const capture = resolveMidiLearnCapture({ type: 'cc', cc: 11, value: 0.5 }, [], {
      targetType: 'channel_vol',
      targetId: 'ch-2',
    });
    assert.ok(capture);

    // The learning modal writes the capture through the project mutation path.
    harness.runtime.handleMidiEvent({ type: 'cc', cc: 11, value: 0.5 });
    assert.equal(harness.mutations.length, 0, 'nothing applied before the mapping was stored');

    const learned = createHarness(withMappings(makeState(), capture.mappings));
    assert.equal(learned.runtime.handleMidiEvent({ type: 'cc', cc: 11, value: 0.75 }).status, 'applied');
    closeTo(channelById(learned.getState(), 'ch-2').volume, 0.75);
  });
});

describe('Phase 46: saved mappings after runtime initialization', () => {
  it('applies the preset project mappings (saved FX wet/dry + master volume) at runtime', () => {
    const presetState = structuredClone(PRESET_PROJECTS[0].state);
    assert.deepEqual(presetState.midiMappings, [
      { ccNumber: 1, targetType: 'fx_param', targetId: 'fx-5-verb', paramName: 'mix' },
      { ccNumber: 7, targetType: 'master_vol', targetId: 0 },
    ]);

    const harness = createHarness(presetState);

    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 1, value: 0.9 }).status, 'applied');
    const slot = trackById(harness.getState(), 5).fxSlots.find(entry => entry.id === 'fx-5-verb');
    assert.ok(slot);
    closeTo(slot.mix, 0.9);

    assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 7, value: 0.5 }).status, 'applied');
    closeTo(masterGainWrites.at(-1) as number, 0.6);
  });

  it('keeps the resolved parameter inside its declared range for the extremes', () => {
    const state = withMappings(makeState(), [
      { ccNumber: 7, targetType: 'master_vol', targetId: 0 },
      { ccNumber: 74, targetType: 'mixer_vol', targetId: 3 },
      { ccNumber: 10, targetType: 'mixer_pan', targetId: 3 },
      { ccNumber: 71, targetType: 'channel_pan', targetId: 'ch-1' },
    ]);
    const harness = createHarness(state);

    harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 1 });
    closeTo(trackById(harness.getState(), 3).volume, 1.25, 'fader maximum stays at the +1.25 model maximum');
    harness.runtime.handleMidiEvent({ type: 'cc', cc: 10, value: 1 });
    closeTo(trackById(harness.getState(), 3).pan, 1);
    harness.runtime.handleMidiEvent({ type: 'cc', cc: 71, value: 0 });
    closeTo(channelById(harness.getState(), 'ch-1').pan, -1);
    harness.runtime.handleMidiEvent({ type: 'cc', cc: 7, value: 0 });
    closeTo(masterGainWrites.at(-1) as number, 0);
  });
});

describe('Phase 46: deterministic resolution surface', () => {
  it('resolves project targets to pure state transitions', () => {
    const state = withMappings(makeState(), []);
    const resolution = resolveMidiCcTarget(
      { ccNumber: 74, targetType: 'channel_vol', targetId: 'ch-1' },
      state,
      0.5,
    );

    assert.equal(resolution.kind, 'project');
    if (resolution.kind !== 'project') return;
    const next = resolution.apply(state);
    closeTo(channelById(next, 'ch-1').volume, 0.5);
    closeTo(channelById(state, 'ch-1').volume, 0.95, 'the transition never mutates the input state');
  });

  it('resolves master volume to the engine target and unknown targets to an explicit rejection', () => {
    const state = makeState();
    assert.equal(
      resolveMidiCcTarget({ ccNumber: 7, targetType: 'master_vol', targetId: 0 }, state, 0.5).kind,
      'engine-master-volume',
    );
    const unsupported = resolveMidiCcTarget(
      { ccNumber: 7, targetType: 'fx_param', targetId: 'ch-1', paramName: 'tremolo' },
      state,
      0.5,
    );
    assert.equal(unsupported.kind, 'unsupported');
  });
});
