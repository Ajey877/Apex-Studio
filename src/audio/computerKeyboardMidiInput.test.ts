/**
 * Computer-keyboard MIDI recording & sustain — regression suite.
 *
 * Defect (pre-fix `src/App.tsx` global key handler): mapped musical keys
 * (A–K row, numpad pads) called `audioEngine.playNote()` directly with a
 * fixed `duration: 1.2`, bypassing `VirtualMidiInputBridge` entirely. As a
 * result (1) an armed MIDI take never captured computer-keyboard playing,
 * (2) a held key stopped sounding after the fixed gate instead of
 * sustaining until release, (3) `keyup` only deleted bookkeeping and never
 * sent a note-off, and (4) no pitch was stored per physical key, so an
 * octave shift (Z/X) mid-hold could not release the pitch that was started.
 *
 * This suite drives the production keyboard-note tracker
 * (`MusicalKeyboardHeldNotes`, the object the App key handler delegates to)
 * wired exactly as the App wires it: tracker -> real
 * `VirtualMidiInputBridge` -> real `MidiNoteInputRuntime` (live monitor,
 * with fake voice ports) + real `MidiPerformanceRecorder` stamped from a
 * deterministic transport clock -> `finishMidiTake` ->
 * `appendRecordedNotesToChannelInProjectState` into real project history.
 * Source guards at the end pin the App handler to this path (no direct
 * fixed-duration playback, no release-pitch recomputation, blur/unmount
 * release, and the pre-existing input/modal/offline-lease/repeat guards).
 * The real browser UI flow is covered by
 * browser-tests/computerKeyboardMidiRecording.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTER_KEYBOARD_MIDI_CHANNEL,
  COMPUTER_KEYBOARD_VELOCITY,
  MusicalKeyboardHeldNotes,
  getKeyboardNotePitch,
} from '../state/musicalKeyboard';
import { VirtualMidiInputBridge } from './virtualMidiInput';
import { MidiNoteInputRuntime } from './midiMappingRuntime';
import {
  MidiPerformanceRecorder,
  appendRecordedNotesToChannelInProjectState,
  type MidiRecordingTarget,
} from './midiRecording';
import { finishMidiTake, type MidiTakeFinalizationPorts } from './midiTakeBoundary';
import { createDefaultProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import type { Note, ProjectState } from '../types/daw';

interface LiveStart { channelId: string; pitch: number; duration: number; velocity: number }
interface VoiceStop { channelId: string; pitch: number; midiChannel?: number }
interface CommitRecord { target: MidiRecordingTarget; notes: Note[] }

const createRig = () => {
  let projectState: ProjectState = createDefaultProjectState();
  let history = createHistory(projectState);
  let positionSteps = 0;

  const liveStarts: LiveStart[] = [];
  const voiceStops: VoiceStop[] = [];
  const runtime = new MidiNoteInputRuntime({
    getProjectState: () => projectState,
    getSelectedChannelId: () => 'ch-1',
    playNote: (channel, note) => {
      liveStarts.push({
        channelId: channel.id,
        pitch: note.pitch,
        duration: note.duration,
        velocity: note.velocity ?? 0,
      });
    },
    stopChannelNote: (channelId, pitch, midiChannel) => {
      voiceStops.push({ channelId, pitch, midiChannel });
    },
  });

  const recorder = new MidiPerformanceRecorder({
    createNoteId: sequence => `kbd-note-${sequence}`,
  });
  const bridge = new VirtualMidiInputBridge({
    getLiveMonitor: () => runtime,
    getRecorder: () => recorder,
    getClock: () => ({ positionSteps }),
  });
  // The production connection under test: the App key handler delegates
  // physical-key press/release to this tracker, which speaks to the bridge.
  const keyboard = new MusicalKeyboardHeldNotes(() => bridge);

  const commits: CommitRecord[] = [];
  const ports: MidiTakeFinalizationPorts = {
    getRecorder: () => recorder,
    getClock: () => ({ positionSteps }),
    commitTake: (target, notes) => {
      commits.push({ target: { ...target }, notes: notes.map(note => ({ ...note })) });
      history = history.commit(
        appendRecordedNotesToChannelInProjectState(projectState, target.channelId, notes, target.patternId),
        'Record MIDI performance',
      );
      projectState = history.present;
    },
    // Mirrors App's finishMidiRecording release port (bridge + tracker
    // bookkeeping + live runtime), used by boundary endings.
    releaseHeldNotes: () => {
      bridge.releaseAll();
      keyboard.forgetAll();
      runtime.releaseAllNotes();
    },
    onTakeEnded: () => {},
  };

  return {
    bridge,
    keyboard,
    recorder,
    // Mirrors the App key handler exactly: resolve the pitch from the
    // octave in effect at keydown, then delegate to the tracker; keyup
    // delegates by physical code only.
    keyDown: (code: string, octave: number): boolean => {
      const pitch = getKeyboardNotePitch(code, octave);
      return pitch === null ? false : keyboard.press(code, pitch);
    },
    keyUp: (code: string): boolean => keyboard.release(code),
    liveStarts,
    voiceStops,
    commits,
    setPosition: (steps: number) => { positionSteps = steps; },
    arm: () => {
      const started = recorder.start(
        { channelId: 'ch-1', patternId: 'pat-1', patternLengthSteps: 16, bpm: projectState.meta.bpm },
        { positionSteps },
      );
      assert.equal(started, true, 'take must arm');
    },
    finishManually: () => finishMidiTake(ports),
    finishAtBoundary: () => finishMidiTake(ports, { releaseHeldNotes: true }),
    notes: (channelId = 'ch-1'): Note[] =>
      projectState.channels.find(c => c.id === channelId)!.notes.map(n => ({ ...n })),
    pastLength: () => history.past.length,
    undo: () => { history = history.undo(); projectState = history.present; },
    redo: () => { history = history.redo(); projectState = history.present; },
  };
};

describe('Case A — computer-keyboard performance is recorded', () => {
  it('commits exactly one editable note whose duration follows the key hold', () => {
    const rig = createRig();
    const pastBefore = rig.pastLength();
    rig.arm();

    rig.setPosition(2);
    assert.equal(rig.keyDown('KeyA', 0), true);
    rig.setPosition(10);
    assert.equal(rig.keyUp('KeyA'), true);
    rig.setPosition(12);
    rig.finishManually();

    assert.equal(rig.commits.length, 1, 'the take commits exactly once');
    assert.equal(rig.commits[0].target.channelId, 'ch-1');
    assert.equal(rig.commits[0].target.patternId, 'pat-1');

    const notes = rig.notes('ch-1');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].pitch, 60);
    assert.equal(notes[0].start, 2, 'onset follows the keydown transport position');
    assert.equal(notes[0].duration, 8, 'duration follows the 8-step hold, not the old fixed 1.2');
    assert.equal(notes[0].velocity, COMPUTER_KEYBOARD_VELOCITY);

    // One history entry for the whole performance: undo removes the take,
    // redo restores it.
    assert.equal(rig.pastLength(), pastBefore + 1);
    rig.undo();
    assert.equal(rig.notes('ch-1').length, 0);
    rig.redo();
    assert.equal(rig.notes('ch-1').length, 1);
  });

  it('records nothing while no take is armed', () => {
    const rig = createRig();
    rig.setPosition(1);
    rig.keyDown('KeyA', 0);
    rig.setPosition(5);
    rig.keyUp('KeyA');
    assert.equal(rig.recorder.capturedNoteCount, 0);
    rig.finishManually();
    assert.equal(rig.commits.length, 0);
    assert.equal(rig.notes('ch-1').length, 0);
  });
});

describe('Case B — live sustain and release', () => {
  it('sustains while held beyond the old fixed gate and stops exactly once on release', () => {
    const rig = createRig();

    rig.setPosition(0);
    assert.equal(rig.keyDown('KeyA', 0), true);
    assert.equal(rig.liveStarts.length, 1);
    assert.deepEqual(rig.liveStarts[0], {
      channelId: 'ch-1', pitch: 60, duration: 8, velocity: COMPUTER_KEYBOARD_VELOCITY,
    }, 'live voice uses the shared runtime sustained gate, not the old 1.2-step blip');

    // Hold far beyond the previous fixed 1.2-step duration: no stop may be
    // issued while the key remains down.
    rig.setPosition(64);
    assert.equal(rig.voiceStops.length, 0);
    assert.equal(rig.keyboard.heldCount, 1);
    assert.equal(rig.bridge.heldCount, 1);

    // OS key-repeat (and any duplicate keydown) must not retrigger the note.
    assert.equal(rig.keyDown('KeyA', 0), false);
    assert.equal(rig.liveStarts.length, 1);

    assert.equal(rig.keyUp('KeyA'), true);
    assert.deepEqual(rig.voiceStops, [
      { channelId: 'ch-1', pitch: 60, midiChannel: COMPUTER_KEYBOARD_MIDI_CHANNEL },
    ]);
    assert.equal(rig.keyboard.heldCount, 0);
    assert.equal(rig.bridge.heldCount, 0);

    // A spurious second keyup cannot emit a second note-off.
    assert.equal(rig.keyUp('KeyA'), false);
    assert.equal(rig.voiceStops.length, 1);
  });
});

describe('Case C — octave shift while held', () => {
  it('releases the pitch stored at keydown, then plays the new octave on re-press', () => {
    const rig = createRig();

    rig.keyDown('KeyA', 0); // C4 = 60 at octave 0
    // Player presses X (octave +1) without releasing A. Release takes no
    // octave: it must resolve to the stored pitch 60, never recomputed 72.
    assert.equal(rig.keyUp('KeyA'), true);
    assert.deepEqual(rig.voiceStops, [
      { channelId: 'ch-1', pitch: 60, midiChannel: COMPUTER_KEYBOARD_MIDI_CHANNEL },
    ]);
    assert.equal(rig.bridge.heldCount, 0, 'no voice remains stuck after the shift');

    rig.keyDown('KeyA', 1); // same physical key, new octave
    assert.equal(rig.liveStarts.at(-1)?.pitch, 72);
    rig.keyUp('KeyA');
    assert.equal(rig.voiceStops.at(-1)?.pitch, 72);
    assert.equal(rig.bridge.heldCount, 0);
  });

  it('keeps a shared pitch sounding until the last physical key holding it releases', () => {
    const rig = createRig();

    rig.keyDown('KeyK', 0); // 72 at octave 0
    rig.keyDown('KeyA', 1); // also 72 after an octave shift (retrigger)
    assert.equal(rig.liveStarts.filter(n => n.pitch === 72).length, 2);
    const stopsAfterRetrigger = rig.voiceStops.length; // runtime stopped the first gate

    rig.keyUp('KeyK');
    assert.equal(
      rig.voiceStops.length, stopsAfterRetrigger,
      'releasing one of two keys holding pitch 72 must not cut the voice',
    );
    rig.keyUp('KeyA');
    assert.equal(rig.voiceStops.length, stopsAfterRetrigger + 1);
    assert.equal(rig.bridge.heldCount, 0);
  });
});

describe('Case D — focus loss and cleanup', () => {
  it('releaseAll (window blur) releases every held key and later keyups are inert', () => {
    const rig = createRig();
    rig.arm();

    rig.setPosition(1);
    rig.keyDown('KeyA', 0); // 60
    rig.keyDown('KeyS', 0); // 62
    rig.setPosition(6);
    rig.keyboard.releaseAll(); // window blur

    assert.equal(rig.keyboard.heldCount, 0);
    assert.equal(rig.bridge.heldCount, 0);
    assert.deepEqual(
      rig.voiceStops.map(s => s.pitch).sort((a, b) => a - b), [60, 62],
    );

    // The physical keyups arriving after focus returns cannot reopen or
    // corrupt notes, and the recorded gates closed at the blur position.
    assert.equal(rig.keyUp('KeyA'), false);
    assert.equal(rig.keyUp('KeyS'), false);
    assert.equal(rig.voiceStops.length, 2);

    rig.setPosition(8);
    rig.finishManually();
    const notes = rig.notes('ch-1');
    assert.equal(notes.length, 2);
    for (const note of notes) {
      assert.equal(note.start, 1);
      assert.equal(note.duration, 5, 'gate closed at blur (step 6), not at take stop');
    }

    // Normal input works after focus returns.
    rig.keyDown('KeyA', 0);
    assert.equal(rig.liveStarts.at(-1)?.pitch, 60);
    rig.keyUp('KeyA');
    assert.equal(rig.voiceStops.at(-1)?.pitch, 60);
  });

  it('boundary release + forgetAll leaves no stale bookkeeping for the later keyup', () => {
    const rig = createRig();
    rig.arm();
    rig.setPosition(2);
    rig.keyDown('KeyA', 0);
    rig.setPosition(9);
    rig.finishAtBoundary(); // e.g. pause/stop: bridge released, tracker forgotten

    assert.equal(rig.keyboard.heldCount, 0);
    assert.equal(rig.bridge.heldCount, 0);
    assert.equal(rig.voiceStops.length, 1);
    const notes = rig.notes('ch-1');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].duration, 7);

    assert.equal(rig.keyUp('KeyA'), false, 'stale keyup is a no-op');
    assert.equal(rig.voiceStops.length, 1, 'no duplicate note-off after boundary release');
  });

  it('is safe when the bridge is unavailable (teardown)', () => {
    let sink: VirtualMidiInputBridge | null = null;
    const keyboard = new MusicalKeyboardHeldNotes(() => sink);
    assert.doesNotThrow(() => {
      keyboard.press('KeyA', 60);
      keyboard.releaseAll();
      keyboard.release('KeyA');
      keyboard.forgetAll();
    });
    assert.equal(keyboard.heldCount, 0);
  });
});

describe('Case E — numpad pads and mapping compatibility', () => {
  it('routes numpad triggers through the bridge at fixed pitch (never transposed)', () => {
    const rig = createRig();
    rig.keyDown('Numpad1', 2); // octave must not move drum pads
    assert.equal(rig.liveStarts.at(-1)?.pitch, 36);
    rig.keyUp('Numpad1');
    assert.deepEqual(rig.voiceStops.at(-1), {
      channelId: 'ch-1', pitch: 36, midiChannel: COMPUTER_KEYBOARD_MIDI_CHANNEL,
    });
    // Sampler/drum voices are SAMPLE_LENGTH (see instrumentGatePolicy): the
    // sample ends at its own buffer end, so a held pad cannot sustain
    // indefinitely; note-off (e.g. for a looping pad) behaves exactly like
    // the existing hardware-pad path through the same runtime.
    assert.equal(rig.bridge.heldCount, 0, 'pad is not left held after release');
  });

  it('records numpad performances like any other shared-input note', () => {
    const rig = createRig();
    rig.arm();
    rig.setPosition(1);
    rig.keyDown('Numpad5', 0); // 49
    rig.setPosition(3);
    rig.keyUp('Numpad5');
    rig.setPosition(4);
    rig.finishManually();
    const notes = rig.notes('ch-1');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].pitch, 49);
    assert.equal(notes[0].start, 1);
    assert.equal(notes[0].duration, 2);
  });

  it('ignores non-note codes', () => {
    const rig = createRig();
    for (const code of ['KeyN', 'KeyZ', 'KeyX', 'Space', 'Digit1', 'Escape']) {
      assert.equal(rig.keyDown(code, 0), false, `${code} must not start a note`);
    }
    assert.equal(rig.liveStarts.length, 0);
    assert.equal(rig.keyboard.heldCount, 0);
  });
});

describe('App.tsx handler wiring (source guards)', () => {
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const handlerStart = appSource.indexOf('// --- Keyboard Shortcuts & Global Hotkeys ---');
  const handlerEnd = appSource.indexOf(
    '}, [isPlaying, playMode, projectState, selectedChannelId, keyboardOctave, handleUndo, handleRedo]);',
    handlerStart,
  );
  const handler = appSource.slice(handlerStart, handlerEnd);

  it('has a locatable keyboard handler region', () => {
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  });

  it('routes keydown/keyup through the held-notes tracker into the bridge', () => {
    assert.match(handler, /getKeyboardNotePitch\(e\.code, keyboardOctave\)/);
    assert.match(handler, /\.press\(e\.code, notePitch\)/);
    assert.match(handler, /\.release\(e\.code\)/);
    assert.match(appSource, /new MusicalKeyboardHeldNotes\(\(\) => virtualMidiInputRef\.current\)/);
  });

  it('has no direct fixed-duration playback bypass in the keyboard handler', () => {
    assert.ok(!handler.includes('audioEngine.playNote'), 'handler must not call playNote directly');
    assert.ok(!handler.includes('duration: 1.2'), 'the fixed 1.2-step gate must be gone');
  });

  it('never recomputes the release pitch from the current octave', () => {
    const keyupStart = handler.indexOf('const handleKeyUp');
    assert.ok(keyupStart >= 0);
    const keyup = handler.slice(keyupStart, handler.indexOf('window.addEventListener', keyupStart));
    assert.ok(!keyup.includes('getKeyboardNotePitch'), 'keyup must use the stored pitch');
    assert.ok(!keyup.includes('keyboardOctave'), 'keyup must not read the current octave');
  });

  it('preserves the text-entry, modal, offline-lease and repeat guards', () => {
    assert.ok(handler.includes("'INPUT', 'SELECT', 'TEXTAREA'"));
    assert.ok(handler.includes('hasOpenModalDialog'));
    assert.ok(handler.includes('isOfflineRenderLeaseHeld'));
    assert.ok(handler.includes('e.repeat'));
  });

  it('releases held keyboard notes on window blur and on unmount', () => {
    assert.match(appSource, /window\.addEventListener\('blur', releaseHeldKeyboardNotes\)/);
    assert.match(appSource, /window\.removeEventListener\('blur', releaseHeldKeyboardNotes\)/);
    assert.match(appSource, /heldKeyboardNotesRef\.current\?\.releaseAll\(\)/);
  });

  it('clears tracker bookkeeping when a transport boundary releases held notes', () => {
    assert.match(appSource, /heldKeyboardNotesRef\.current\?\.forgetAll\(\)/);
  });
});
