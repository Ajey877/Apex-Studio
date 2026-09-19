/**
 * Phase 9D regression coverage: `Pattern.lengthSteps` is the ONE authoritative
 * pattern length, and the Channel Rack / history / persistence / Piano Roll all
 * read and write that single value.
 *
 * These tests drive the real production paths — the pure state transition the
 * Channel Rack length control triggers (`setPatternLengthStepsInProjectState`),
 * the project history it commits through, and the serialize -> parse -> normalize
 * round trip persistence uses — so they prove behaviour instead of mirroring
 * implementation constants. Wiring that can only be observed in the component
 * tree (no DOM in this test runner) is guarded at the source level, the same
 * convention Phase 8C/9C use.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import { createHistory, sanitizeProjectSnapshot } from './projectHistory';
import { getPatternUpdateLabel, updatePatternInProjectState } from './projectMutations';
import {
  DEFAULT_PATTERN_LENGTH_STEPS,
  PATTERN_LENGTH_CHOICES,
  PATTERN_STEPS_PER_BAR,
  findPatternById,
  getPatternLengthBars,
  getSelectedPattern,
  getSelectedPatternLengthSteps,
  normalizePatternLengthSteps,
  setPatternLengthStepsInProjectState
} from './patternLength';
import {
  clearChannelSteps,
  fillChannelSteps,
  getChannelRackStepLength,
  toggleChannelStep
} from '../components/channelRackOperations';
import { resolvePatternLoopLengthSteps } from '../audio/audioEngine';
import { DEFAULT_PROJECT, PRESET_PROJECTS } from '../audio/presets';
import type { Channel, Pattern, ProjectState } from '../types/daw';

const readSource = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

/** A project whose channels hold `stepsLength` step slots with the given hits. */
const makeProject = (options: {
  lengthSteps?: number;
  stepsLength?: number;
  activeSteps?: number[];
  noteStarts?: number[];
  patterns?: Pattern[];
} = {}): ProjectState => {
  const state = createDefaultProjectState();
  const lengthSteps = options.lengthSteps ?? DEFAULT_PATTERN_LENGTH_STEPS;
  state.patterns = options.patterns ?? [
    { id: 'pat-1', name: 'Pattern 1', color: '#ff6e00', lengthSteps }
  ];
  state.selectedPatternId = state.patterns[0].id;

  const stepsLength = options.stepsLength ?? lengthSteps;
  const steps = new Array<boolean>(stepsLength).fill(false);
  for (const step of options.activeSteps ?? []) steps[step] = true;
  const notes = (options.noteStarts ?? []).map((start, index) => ({
    id: `note-${index}`, pitch: 60 + index, start, duration: 1, velocity: 0.9
  }));

  state.channels = state.channels.map((channel, index) => ({
    ...channel,
    steps: index === 0 ? steps : new Array<boolean>(stepsLength).fill(false),
    notes: index === 0 ? notes : []
  }));
  return state;
};

const declaredLength = (state: ProjectState, patternId = state.selectedPatternId): number =>
  findPatternById(state, patternId)?.lengthSteps as number;

/** The length control click the Channel Rack performs. */
const clickLength = (state: ProjectState, lengthSteps: number): ProjectState =>
  setPatternLengthStepsInProjectState(state, state.selectedPatternId, lengthSteps);

describe('Pattern length model', () => {
  it('1: a new project declares a one-bar (16 step) pattern', () => {
    const state = createDefaultProjectState();
    assert.equal(PATTERN_STEPS_PER_BAR, 16);
    assert.equal(DEFAULT_PATTERN_LENGTH_STEPS, 16);
    assert.equal(state.patterns[0].lengthSteps, 16);
    assert.equal(getSelectedPatternLengthSteps(state), 16);
    assert.equal(getChannelRackStepLength(state.patterns, state.selectedPatternId), 16);
  });

  it('every shipped preset and the startup project stay 16-step compatible', () => {
    const projects = [DEFAULT_PROJECT, ...PRESET_PROJECTS.map(preset => preset.state)];
    for (const project of projects) {
      assert.ok(project.patterns.length > 0);
      for (const pattern of project.patterns) {
        assert.equal(normalizePatternLengthSteps(pattern.lengthSteps), 16);
      }
      assert.equal(getSelectedPatternLengthSteps(project), 16);
    }
  });

  it('App creates new patterns at the shared default length', () => {
    const appSource = readSource('../App.tsx');
    const start = appSource.indexOf('const handleAddPattern');
    const handler = appSource.slice(start, appSource.indexOf('};', start));
    assert.ok(start > 0);
    assert.match(handler, /lengthSteps: DEFAULT_PATTERN_LENGTH_STEPS/);
    assert.doesNotMatch(handler, /lengthSteps:\s*\d/, 'no second hardcoded pattern length');
  });

  it('normalizes a declared length to whole bars and falls back to 16', () => {
    assert.equal(normalizePatternLengthSteps(16), 16);
    assert.equal(normalizePatternLengthSteps(32), 32);
    assert.equal(normalizePatternLengthSteps(64), 64);
    assert.equal(normalizePatternLengthSteps(48), 48);
    // Bar quantization matches the audio engine's own resolution, so the declared
    // value and the resolved loop can never disagree.
    assert.equal(normalizePatternLengthSteps(8), 16);
    assert.equal(normalizePatternLengthSteps(20), 32);
    assert.equal(normalizePatternLengthSteps(256), 256);
    assert.equal(normalizePatternLengthSteps(512), 512, 'the existing numeric model is not narrowed');
  });

  it('falls back to the default for missing or corrupt stored lengths', () => {
    for (const invalid of [undefined, null, NaN, Infinity, 0, -16, '32', {}, []]) {
      assert.equal(normalizePatternLengthSteps(invalid), DEFAULT_PATTERN_LENGTH_STEPS, `invalid: ${String(invalid)}`);
    }
    const state = makeProject();
    state.patterns = [{ id: 'pat-1', name: 'Corrupt', color: '#fff', lengthSteps: Number.NaN }];
    assert.equal(getSelectedPatternLengthSteps(state), 16);
    assert.equal(getChannelRackStepLength(state.patterns, state.selectedPatternId), 16);
  });

  it('exposes the bar count of a declared length for the export window', () => {
    assert.equal(getPatternLengthBars(16), 1);
    assert.equal(getPatternLengthBars(32), 2);
    assert.equal(getPatternLengthBars(64), 4);
    assert.equal(getPatternLengthBars(undefined), 1);
  });

  it('offers 16 and 32 as explicit choices without limiting the model', () => {
    assert.deepEqual([...PATTERN_LENGTH_CHOICES], [16, 32]);
    // The model itself is a plain number: 64 is storable, readable and resolvable.
    const state = makeProject({ lengthSteps: 64, stepsLength: 64, activeSteps: [0, 63] });
    assert.equal(declaredLength(state), 64);
    assert.equal(getSelectedPatternLengthSteps(state), 64);
    assert.equal(resolvePatternLoopLengthSteps(state.channels, 64), 64);
  });
});

describe('Channel Rack length control writes Pattern.lengthSteps', () => {
  it('2: choosing 32 STEPS updates the selected pattern, not local UI state', () => {
    const before = makeProject();
    assert.equal(getChannelRackStepLength(before.patterns, before.selectedPatternId), 16);

    const after = clickLength(before, 32);

    assert.equal(declaredLength(after), 32, 'Pattern.lengthSteps is written');
    assert.equal(getSelectedPatternLengthSteps(after), 32);
    assert.equal(getChannelRackStepLength(after.patterns, after.selectedPatternId), 32, 'the rack grid follows it');
    assert.equal(resolvePatternLoopLengthSteps(after.channels, getSelectedPatternLengthSteps(after)), 32, 'Pattern Mode follows it');
  });

  it('2b: choosing 16 STEPS returns a 32-step pattern to one bar', () => {
    const before = makeProject({ lengthSteps: 32, stepsLength: 32, activeSteps: [0, 8] });
    const after = clickLength(before, 16);

    assert.equal(declaredLength(after), 16);
    assert.equal(getChannelRackStepLength(after.patterns, after.selectedPatternId), 16);
    assert.equal(resolvePatternLoopLengthSteps(after.channels, getSelectedPatternLengthSteps(after)), 16);
  });

  it('updates only the selected pattern and leaves the others untouched', () => {
    const patterns: Pattern[] = [
      { id: 'pat-1', name: 'One Bar', color: '#ff6e00', lengthSteps: 16 },
      { id: 'pat-2', name: 'Two Bar', color: '#00bcd4', lengthSteps: 32 }
    ];
    const state = makeProject({ patterns });

    const after = clickLength(state, 32);

    assert.equal(declaredLength(after, 'pat-1'), 32);
    assert.equal(declaredLength(after, 'pat-2'), 32);
    assert.equal(after.patterns[1], state.patterns[1], 'untouched patterns keep their identity');
    assert.notEqual(after.patterns[0], state.patterns[0]);

    const backToOneBar = setPatternLengthStepsInProjectState(after, 'pat-2', 16);
    assert.equal(declaredLength(backToOneBar, 'pat-1'), 32, 'the other pattern is not rewritten');
    assert.equal(declaredLength(backToOneBar, 'pat-2'), 16);
  });

  it('is a safe no-op when no pattern matches the selection', () => {
    const state = makeProject();
    state.selectedPatternId = 'pat-missing';

    const after = setPatternLengthStepsInProjectState(state, state.selectedPatternId, 32);

    assert.equal(after, state, 'state identity is unchanged');
    assert.equal(declaredLength(after, 'pat-1'), 16);
    assert.equal(getSelectedPatternLengthSteps(after), 16, 'an unmatched selection resolves to the default');
    assert.equal(getSelectedPattern(after), undefined);
  });

  it('is idempotent: re-clicking the active length records no change', () => {
    const state = makeProject({ lengthSteps: 32, stepsLength: 32, activeSteps: [0, 20] });
    const again = clickLength(state, 32);
    assert.equal(again, state, 'no phantom state object');

    const history = createHistory(state);
    const committed = history.commit(clickLength(history.present, 32), getPatternUpdateLabel({ lengthSteps: 32 }));
    assert.equal(committed.canUndo, false, 'no phantom history entry');
    assert.equal(getPatternUpdateLabel({ lengthSteps: 16 }), 'Change pattern length');
  });

  it('a padded channel tail cannot override the authoritative declared length', () => {
    // Legacy behaviour: the rack's CLR button could write a 32-slot array while
    // the pattern still declared 16. The data is preserved, but the one-bar
    // Pattern now loops exactly 16 because Pattern.lengthSteps is authoritative.
    const state = makeProject({ lengthSteps: 16, stepsLength: 32, activeSteps: [0, 4] });

    assert.equal(state.channels[0].steps.length, 32);
    assert.equal(resolvePatternLoopLengthSteps(state.channels, 16), 16);
    assert.equal(clickLength(state, 16), state, 'no cleanup mutation or phantom history entry is needed');
  });
});

describe('Channel step semantics when the declared length changes', () => {
  it('16 -> 32 does not pad channel step arrays', () => {
    const state = makeProject({ lengthSteps: 16, stepsLength: 16, activeSteps: [0, 4] });
    const after = clickLength(state, 32);

    for (const channel of after.channels) {
      assert.equal(channel.steps.length, 16, 'no speculative padding');
    }
    assert.equal(after.channels[0], state.channels[0], 'untouched channels keep their identity');
    // Padding would have made empty slots look like content and forced a 32-step
    // loop even after the length returns to 16.
    assert.equal(resolvePatternLoopLengthSteps(after.channels, 16), 16);
  });

  it('6: 32 -> 16 preserves steps that are ON past the new length', () => {
    const state = makeProject({ lengthSteps: 32, stepsLength: 32, activeSteps: [0, 15, 16, 20, 31] });
    const after = clickLength(state, 16);

    assert.equal(declaredLength(after), 16);
    const steps = after.channels[0].steps;
    for (const kept of [0, 15, 16, 20, 31]) {
      assert.equal(steps[kept], true, `step ${kept} survives the length reduction`);
    }
    assert.equal(steps.length, 32, 'the whole Channel-scoped array is preserved');
    // The data remains stored but is ignored while this Pattern declares one bar.
    assert.equal(resolvePatternLoopLengthSteps(after.channels, getSelectedPatternLengthSteps(after)), 16);
    // Extending the pattern reveals it again without reconstructing any data.
    const extendedAgain = clickLength(after, 32);
    assert.equal(resolvePatternLoopLengthSteps(extendedAgain.channels, getSelectedPatternLengthSteps(extendedAgain)), 32);
  });

  it('32 -> 16 preserves empty and active later slots but ignores them for Pattern playback', () => {
    const state = makeProject({ lengthSteps: 32, stepsLength: 32, activeSteps: [0, 12] });
    const after = clickLength(state, 16);

    assert.equal(after.channels[0], state.channels[0], 'changing a Pattern never rewrites Channel-scoped data');
    assert.equal(after.channels[0].steps.length, 32);
    assert.equal(after.channels[0].steps[0], true);
    assert.equal(after.channels[0].steps[12], true);
    assert.equal(resolvePatternLoopLengthSteps(after.channels, getSelectedPatternLengthSteps(after)), 16);
  });

  it('never touches piano roll notes, velocities or any other channel field', () => {
    const state = makeProject({
      lengthSteps: 32, stepsLength: 32, activeSteps: [0, 20], noteStarts: [0, 17, 30]
    });
    state.channels[0].stepVelocities = new Array(32).fill(0.5);
    const notesBefore = structuredClone(state.channels[0].notes);
    const velocitiesBefore = structuredClone(state.channels[0].stepVelocities);

    const after = clickLength(state, 16);

    assert.deepEqual(after.channels[0].notes, notesBefore, 'notes are untouched');
    assert.deepEqual(after.channels[0].stepVelocities, velocitiesBefore, 'velocities are untouched');
    assert.equal(after.channels[0].name, state.channels[0].name);
    assert.equal(after.channels[0].volume, state.channels[0].volume);
    assert.deepEqual(after.playlistClips, state.playlistClips);
    assert.deepEqual(after.mixerTracks, state.mixerTracks);
    assert.equal(after.meta.bpm, state.meta.bpm);
  });

  it('grid edits stay inside the declared length and preserve hidden steps', () => {
    const channel = makeProject({ lengthSteps: 16, stepsLength: 16 }).channels[0];

    // Clicking a cell grows the array on demand (legacy 16-slot channel, 32 grid).
    const toggled = toggleChannelStep(channel, 20);
    assert.equal(toggled.length, 21);
    assert.equal(toggled[20], true);
    assert.equal(toggleChannelStep({ ...channel, steps: toggled }, 20)[20], false, 'and toggles back off');

    const hidden = makeProject({ lengthSteps: 16, stepsLength: 24, activeSteps: [0, 20] }).channels[0];
    const cleared = clearChannelSteps(hidden, 16);
    assert.equal(cleared.length, 24);
    assert.deepEqual(cleared.slice(0, 16), new Array(16).fill(false), 'the visible grid is cleared');
    assert.equal(cleared[20], true, 'steps the user cannot see survive CLR');

    const filled = fillChannelSteps(hidden, 4, 16);
    assert.deepEqual(filled.slice(0, 16), [0, 4, 8, 12].reduce<boolean[]>((acc, step) => {
      acc[step] = true;
      return acc;
    }, new Array<boolean>(16).fill(false)));
    assert.equal(filled[20], true, 'steps the user cannot see survive FILL');
    assert.equal(filled.length, 24);
  });
});

describe('Pattern length participates in project history', () => {
  it('3/5: 16 -> 32 is undoable and redoable', () => {
    let history = createHistory(makeProject());
    assert.equal(history.present.patterns[0].lengthSteps, 16);

    history = history.commit(
      clickLength(history.present, 32),
      getPatternUpdateLabel({ lengthSteps: 32 })
    );
    assert.equal(history.present.patterns[0].lengthSteps, 32);
    assert.equal(history.past.length, 1);
    assert.equal(history.past[0].label, 'Change pattern length');
    assert.equal(history.canUndo, true);

    const undone = history.undo();
    assert.equal(undone.present.patterns[0].lengthSteps, 16, 'undo restores 16');
    assert.equal(getSelectedPatternLengthSteps(undone.present), 16);
    assert.equal(undone.canRedo, true);

    const redone = undone.redo();
    assert.equal(redone.present.patterns[0].lengthSteps, 32, 'redo restores 32');
    assert.equal(getChannelRackStepLength(redone.present.patterns, redone.present.selectedPatternId), 32);
  });

  it('4: 32 -> 16 is undoable and keeps musical data in both directions', () => {
    let history = createHistory(makeProject({ lengthSteps: 32, stepsLength: 32, activeSteps: [0, 16, 20, 31] }));

    history = history.commit(
      clickLength(history.present, 16),
      getPatternUpdateLabel({ lengthSteps: 16 })
    );
    assert.equal(history.present.patterns[0].lengthSteps, 16);
    for (const step of [16, 20, 31]) {
      assert.equal(history.present.channels[0].steps[step], true, `step ${step} survives`);
    }

    const undone = history.undo();
    assert.equal(undone.present.patterns[0].lengthSteps, 32, 'undo restores 32');
    for (const step of [16, 20, 31]) {
      assert.equal(undone.present.channels[0].steps[step], true, `step ${step} is still there after undo`);
    }

    const redone = undone.redo();
    assert.equal(redone.present.patterns[0].lengthSteps, 16);
    assert.equal(redone.present.channels[0].steps[31], true, 'redo does not destroy the preserved tail');
  });

  it('a length change is a discrete commit, never a continuous batch', () => {
    const history = createHistory(makeProject());
    const committed = history.commit(clickLength(history.present, 32), 'Change pattern length');
    assert.equal(committed.past.length, 1);

    // An unrelated edit afterwards keeps both entries separate.
    const withBpm = { ...committed.present, meta: { ...committed.present.meta, bpm: 140 } };
    const second = committed.commit(withBpm, 'Change tempo');
    assert.equal(second.past.length, 2);
    assert.equal(second.undo().present.patterns[0].lengthSteps, 32, 'tempo undo does not revert the length');
    assert.equal(second.undo().undo().present.patterns[0].lengthSteps, 16);
  });

  it('the sanitized history snapshot keeps the declared length', () => {
    const snapshot = sanitizeProjectSnapshot(makeProject({ lengthSteps: 64, stepsLength: 64 }));
    assert.equal(snapshot.patterns[0].lengthSteps, 64);
    assert.equal(getSelectedPatternLengthSteps(snapshot), 64);
  });

  it('updatePatternInProjectState is the generic pattern mutation behind it', () => {
    const state = makeProject();
    const renamed = updatePatternInProjectState(state, 'pat-1', { name: 'Verse' });
    assert.equal(renamed.patterns[0].name, 'Verse');
    assert.equal(renamed.patterns[0].lengthSteps, 16);
    assert.equal(renamed.patterns[0].id, 'pat-1');
    assert.equal(
      updatePatternInProjectState(state, 'pat-nope', { lengthSteps: 32 }),
      state,
      'unknown ids change nothing'
    );
    assert.equal(getPatternUpdateLabel({ name: 'Verse' }), 'Rename pattern');
    assert.equal(getPatternUpdateLabel({ color: '#fff' }), 'Change pattern color');
    assert.equal(getPatternUpdateLabel({}), 'Update pattern');
  });
});

describe('Pattern length persistence', () => {
  const roundTrip = (state: ProjectState): ProjectState =>
    normalizeProjectState((JSON.parse(serializeProjectState(state)) as { state: unknown }).state);

  it('7: the declared length survives serializeProjectState -> JSON', () => {
    for (const lengthSteps of [16, 32, 64]) {
      const serialized = JSON.parse(serializeProjectState(makeProject({ lengthSteps }))) as {
        state: { patterns: Pattern[] };
      };
      assert.equal(serialized.state.patterns[0].lengthSteps, lengthSteps);
    }
  });

  it('8: the declared length survives normalizeProjectState without a migration', () => {
    for (const lengthSteps of [16, 32, 64]) {
      const restored = roundTrip(makeProject({ lengthSteps }));
      assert.equal(restored.patterns[0].lengthSteps, lengthSteps, `${lengthSteps} steps hydrate unchanged`);
      assert.equal(getSelectedPatternLengthSteps(restored), lengthSteps);
      assert.equal(getChannelRackStepLength(restored.patterns, restored.selectedPatternId), lengthSteps);
    }
  });

  it('a 32-step Channel Rack edit survives save -> reload', () => {
    const edited = clickLength(makeProject({ activeSteps: [0, 4] }), 32);
    const restored = roundTrip(edited);

    assert.equal(restored.patterns[0].lengthSteps, 32);
    assert.equal(restored.selectedPatternId, edited.selectedPatternId);
    assert.deepEqual(restored.channels[0].steps, edited.channels[0].steps);
    assert.equal(resolvePatternLoopLengthSteps(restored.channels, getSelectedPatternLengthSteps(restored)), 32);
  });

  it('preserved steps past a reduced length survive the round trip too', () => {
    const reduced = clickLength(makeProject({ lengthSteps: 32, stepsLength: 32, activeSteps: [0, 20] }), 16);
    const restored = roundTrip(reduced);

    assert.equal(restored.patterns[0].lengthSteps, 16);
    assert.equal(restored.channels[0].steps[20], true);
    assert.equal(restored.channels[0].steps.length, 32, 'all Channel-scoped slots survive');
  });

  it('hydration does not rewrite a stored length it does not recognize', () => {
    const state = makeProject();
    state.patterns = [{ id: 'pat-1', name: 'Odd', color: '#fff', lengthSteps: 40 }];
    const restored = roundTrip(state);

    // No schema migration: the document keeps what it stored ...
    assert.equal(restored.patterns[0].lengthSteps, 40);
    // ... and every consumer reads it through the one normalizer (40 -> 48 steps).
    assert.equal(getSelectedPatternLengthSteps(restored), 48);
    assert.equal(resolvePatternLoopLengthSteps(restored.channels, getSelectedPatternLengthSteps(restored)), 48);
  });
});

describe('Piano Roll stays consistent with the pattern model', () => {
  const pianoRollSource = readSource('../components/PianoRoll.tsx');

  it('derives its width from the declared length with a two-bar floor', () => {
    assert.match(pianoRollSource, /const PIANO_ROLL_MIN_STEPS = 32;/);
    assert.match(
      pianoRollSource,
      /const totalSteps = Math\.max\(PIANO_ROLL_MIN_STEPS, normalizePatternLengthSteps\(patternLengthSteps\)\);/
    );
    assert.match(pianoRollSource, /patternLengthSteps\?: number;/, 'the prop is additive and optional');
    assert.doesNotMatch(pianoRollSource, /useState\(32\)/, 'no competing local length state');
  });

  it('12: keeps notes beyond the declared length editable and preserved', () => {
    // A 16-step pattern still shows the historical 32-column editor, so notes at
    // 17/30 remain visible; nothing in the length path rewrites channel notes.
    const state = makeProject({ lengthSteps: 16, noteStarts: [0, 17, 30] });
    const after = clickLength(state, 32);
    assert.deepEqual(after.channels[0].notes, state.channels[0].notes);

    const backToOneBar = clickLength(after, 16);
    assert.deepEqual(backToOneBar.channels[0].notes, state.channels[0].notes);
    assert.equal(resolvePatternLoopLengthSteps(backToOneBar.channels, 16), 16, 'later notes are ignored at the shorter declared length');
    assert.equal(resolvePatternLoopLengthSteps(clickLength(backToOneBar, 32).channels, 32), 32, 'extending reveals them again');
  });
});

describe('Pattern length wiring is single-sourced', () => {
  const rackSource = readSource('../components/ChannelRack.tsx');
  const appSource = readSource('../App.tsx');
  const exportModalSource = readSource('../components/ExportModal.tsx');
  const engineSource = readSource('../audio/audioEngine.ts');

  it('the Channel Rack keeps no pattern length state of its own', () => {
    assert.doesNotMatch(rackSource, /const \[stepLength, setStepLength\]\s*=\s*useState/, 'no local 16/32 length state');
    assert.doesNotMatch(rackSource, /setStepLength/, 'no local length setter');
    assert.match(rackSource, /const stepLength = getChannelRackStepLength\(patterns, selectedPatternId\);/);
    assert.match(rackSource, /onUpdatePatternLength: \(lengthSteps: number\) => void;/);
    assert.match(rackSource, /onUpdatePatternLength\(lengthSteps\)/, 'the control writes project state');
    assert.match(rackSource, /PATTERN_LENGTH_CHOICES\.map/, 'the choices come from the pattern-length module');
    assert.match(rackSource, /length: Math\.ceil\(stepLength \/ 4\)/, 'the grid is rendered from the declared length');
    assert.match(rackSource, /\(currentStep % stepLength\) === stepIdx/, 'the playhead wraps at the declared length');
  });

  it('App writes the length through project mutations/history and feeds playback + export', () => {
    const handlerStart = appSource.indexOf('const handleUpdatePatternLength');
    const handler = appSource.slice(handlerStart, appSource.indexOf('const handleUpdateTracks', handlerStart));
    assert.ok(handlerStart > 0);
    assert.match(handler, /mutateProjectState\(/, 'goes through the history-aware mutation path');
    assert.match(handler, /setPatternLengthStepsInProjectState\(current, current\.selectedPatternId, lengthSteps\)/);
    assert.match(handler, /getPatternUpdateLabel\(updates\)/);
    assert.doesNotMatch(handler, /projectStateRef\.current\s*=\s*\{/, 'never writes project state directly');

    assert.match(appSource, /onUpdatePatternLength=\{handleUpdatePatternLength\}/);
    assert.match(appSource, /const selectedPatternLengthSteps = getSelectedPatternLengthSteps\(projectState\);/);
    assert.match(appSource, /patternLengthSteps=\{selectedPatternLengthSteps\}/, 'Piano Roll and Export read the same value');

    const exportUsage = appSource.slice(appSource.indexOf('<ExportModal'), appSource.indexOf('/>', appSource.indexOf('<ExportModal')));
    assert.match(exportUsage, /patternLengthSteps=\{selectedPatternLengthSteps\}/);

    const playCalls = appSource.split('audioEngine.play(').slice(1);
    assert.equal(playCalls.length, 2, 'both transport start paths');
    for (const call of playCalls) {
      assert.match(call.slice(0, call.indexOf(');')), /selectedPatternLengthSteps/, 'Pattern Mode receives the declared length');
    }
  });

  it('App synchronizes the declared length into the running take', () => {
    const syncStart = appSource.indexOf('const synchronizeActivePlayback');
    const sync = appSource.slice(syncStart, appSource.indexOf('}, []);', syncStart));
    assert.ok(syncStart > 0);
    assert.match(sync, /update\.patternLengthSteps = nextPatternLengthSteps/);
    assert.match(sync, /getSelectedPatternLengthSteps\(previous\)/);
    assert.match(sync, /getSelectedPatternLengthSteps\(next\)/);
  });

  it('ExportModal passes the declared length through instead of resolving its own', () => {
    assert.match(exportModalSource, /patternLengthSteps\?: number;/, 'additive optional prop');
    assert.match(exportModalSource, /getProjectRenderBars\(clips, scope, patternLengthSteps\)/);
    assert.match(exportModalSource, /renderTimelineOffline\(/);
    assert.match(exportModalSource, /renderProjectStems\(/);
    const stemCall = exportModalSource.slice(
      exportModalSource.indexOf('await audioEngine.renderProjectStems('),
      exportModalSource.indexOf("folder?.file('project_info.txt'")
    );
    assert.match(stemCall, /scope,/);
    assert.match(stemCall, /patternLengthSteps/);

    const renderCall = exportModalSource.slice(
      exportModalSource.indexOf('await audioEngine.renderTimelineOffline('),
      exportModalSource.indexOf('setRenderProgress(85)')
    );
    assert.match(renderCall, /patternLengthSteps,/, 'the render API receives the declared length');
    // No second pattern-length algorithm in the modal.
    assert.doesNotMatch(exportModalSource, /%\s*16\b/);
    assert.doesNotMatch(exportModalSource, /Math\.ceil\([^)]*\/\s*16\s*\)/);
    assert.doesNotMatch(exportModalSource, /resolvePatternLoopLengthSteps|resolvePlayableContentLengthSteps/);
  });

  it('the offline render resolves the loop through the single engine resolver', () => {
    const renderStart = engineSource.indexOf('public async renderTimelineOffline(');
    const renderFn = engineSource.slice(renderStart, engineSource.indexOf('// High-Grade Offline Audio Renderer', renderStart));
    assert.ok(renderStart > 0);
    assert.match(renderFn, /patternLengthSteps\?: number,/);
    assert.match(renderFn, /resolvePatternLoopLengthSteps\(this\.activeChannels, patternLengthSteps\)/);
    assert.equal(
      renderFn.match(/resolvePatternLoopLengthSteps\(/g)?.length,
      1,
      'exactly one loop-length resolution in the render path'
    );
    assert.match(renderFn, /activePatternLengthSteps: this\.activePatternLengthSteps/, 'a render never leaks into a live take');
    assert.match(renderFn, /this\.activePatternLengthSteps = previous\.activePatternLengthSteps/);

    const syncStart = engineSource.indexOf('public synchronizePlaybackState(');
    const syncFn = engineSource.slice(syncStart, engineSource.indexOf('/** True only while the live transport', syncStart));
    assert.match(syncFn, /update\.patternLengthSteps/);
    assert.equal(
      engineSource.match(/export function resolvePatternLoopLengthSteps\(/g)?.length,
      1,
      'the resolver itself is defined once'
    );
  });
});
