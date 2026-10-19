/**
 * MIDI transport-boundary integrity — regression suite.
 *
 * Policy under test: a MIDI take never spans a transport discontinuity.
 * Pause, playlist ruler seek, Pattern/Song mode switch, natural Song end,
 * manual Stop and input disconnect each close the active take at the
 * PRE-boundary musical position, commit it exactly once to its original
 * channel/pattern, reset the recording UI state, and release held
 * live-monitor notes so no stale voice or held-note bookkeeping survives.
 * Plain Play/resume is not a boundary and must not split a take.
 *
 * This suite drives the actual integration path with a deterministic fake
 * AudioContext clock: raw Web MIDI bytes -> `AudioEngine.handleMidiMessage`
 * -> listener stream -> `MidiNoteInputRuntime` + `MidiPerformanceRecorder`
 * (stamped from the real `AudioClockTransport` through
 * `getTransportMusicalPosition`) -> `finishMidiTake` (the shared App-level
 * finalization) -> `appendRecordedNotesToChannelInProjectState` into real
 * project history. Transport actions are the production `audioEngine`
 * `play/pause/stop/seek` plus the engine's Song-end callback, invoked in the
 * same finalize-first order as the App handlers; source guards at the end
 * pin that ordering inside `src/App.tsx` and `audioEngine.handleSongEnd`.
 * The simulated keyboard workflow through the real UI is covered by
 * browser-tests/midiRecording.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport, START_LEAD_SECONDS } from './transport';
import { audioEngine, type MidiEventPayload } from './audioEngine';
import {
  MidiPerformanceRecorder,
  appendRecordedNotesToChannelInProjectState,
  type MidiRecordingClock,
  type MidiRecordingTarget,
} from './midiRecording';
import { finishMidiTake, type MidiTakeFinalizationPorts } from './midiTakeBoundary';
import { MidiNoteInputRuntime } from './midiMappingRuntime';
import { VirtualMidiInputBridge } from './virtualMidiInput';
import { createDefaultProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { barsToBeats, beatsToSeconds, resolveProjectTimeSignature } from '../music/musicalTime';
import type { Note, PlaylistClip, ProjectState } from '../types/daw';

const STEP_SECONDS_AT_120_BPM = 0.125;

class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  setTargetAtTime(): void {}
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
}
class FakeGainNode { gain = new FakeAudioParam(); connect(): void {} disconnect(): void {} }
class FakePannerNode { pan = new FakeAudioParam(); connect(): void {} disconnect(): void {} }
class FakeAnalyserNode { fftSize = 256; smoothingTimeConstant = 0.7; connect(): void {} disconnect(): void {} }
class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  detune = new FakeAudioParam();
  playbackRate = new FakeAudioParam();
  connect(): void {}
  start(): void {}
  stop(): void {}
  addEventListener(): void {}
}
class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';
  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
}

interface FakeMidiPort {
  id: string;
  name: string;
  type: 'input' | 'output';
  state: 'connected' | 'disconnected';
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}
interface FakeMidiAccess {
  inputs: Map<string, FakeMidiPort>;
  outputs: Map<string, FakeMidiPort>;
  onstatechange: ((event: { port: FakeMidiPort }) => void) | null;
}

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'activeClipSources', 'isPlaying',
  'bpm', 'swing', 'metronome', 'currentStep', 'currentBar',
  'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers',
  'masterGain', 'mixerChannels', 'timerId', 'midiAccess',
  'disconnectedMidiInputIds', 'songEndCallback', 'activePatterns',
  'playlistLaneMutes',
];

let timers: Array<() => void> = [];
let savedInternals: EngineInternals = {};
let originalPlayNote: unknown;
const realWindow = (globalThis as any).window;
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let rigCounter = 0;

beforeEach(() => {
  timers = [];
  (globalThis as any).window = {
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    clearTimeout: () => undefined,
  };
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  originalPlayNote = engine.playNote;
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
  (globalThis as any).window = realWindow;
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
});

const assertCloseTo = (actual: number, expected: number, message?: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `expected ${actual} to be within 1e-9 of ${expected}`);
};

const patternClip = (id: string, lengthBars: number): PlaylistClip => ({
  id, trackIndex: 0, startBar: 0, lengthBars, type: 'pattern', channelId: 'ch-1', color: '#ff6e00', name: id,
});

interface CommitRecord { target: MidiRecordingTarget; notes: Note[] }
interface SongEndRecord { positionSeconds: number; positionSteps: number; playingWhenFired: boolean }

interface Rig {
  fakeCtx: FakeAudioContext;
  recorder: MidiPerformanceRecorder;
  bridge: VirtualMidiInputBridge;
  commits: CommitRecord[];
  songEnds: SongEndRecord[];
  liveStarts: Array<{ channelId: string; pitch: number }>;
  voiceStops: Array<{ channelId: string; pitch: number; midiChannel?: number }>;
  takeEndedCount: () => number;
  uiRecording: () => boolean;
  projectState: () => ProjectState;
  notes: (channelId?: string) => Note[];
  positionSteps: () => number;
  pump: (steps: number) => void;
  sendBytes: (...messages: number[][]) => void;
  setInputState: (state: 'connected' | 'disconnected') => void;
  inputAttached: () => boolean;
  /** Mirror of App's toggleMidiRecording start + handleTogglePlay. */
  startTake: (mode: 'pat' | 'song', clips?: PlaylistClip[]) => void;
  /** Mirror of App's toggleMidiRecording stop (manual finish, no forced release). */
  finishTakeManually: () => void;
  play: (mode: 'pat' | 'song', clips?: PlaylistClip[]) => void;
  pressPause: () => void;
  pressStop: () => void;
  switchMode: (next: 'pat' | 'song', clips?: PlaylistClip[]) => void;
  seekToBar: (bar: number) => void;
  undo: () => void;
  redo: () => void;
  dispose: () => void;
}

const createRig = async (): Promise<Rig> => {
  rigCounter += 1;
  timers = [];
  const fakeCtx = new FakeAudioContext();
  const transport = new AudioClockTransport(fakeCtx as unknown as AudioContext, {
    lookAheadSeconds: 0.1, scheduleIntervalMs: 25,
  });
  engine.ctx = fakeCtx;
  engine.transport = transport;
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.masterGain = new FakeGainNode();
  engine.mixerChannels = new Map();
  engine.isPlaying = false;
  engine.bpm = 120;
  engine.metronome = false;
  engine.setSwing(0);
  engine.sampleBuffers = new Map();
  engine.playNote = () => {}; // scheduled playback voices are not under test here

  const base = createDefaultProjectState();
  let projectState: ProjectState = { ...base, meta: { ...base.meta, bpm: 120 } };
  let history = createHistory(projectState);

  let noteSeq = 0;
  const recorder = new MidiPerformanceRecorder({ createNoteId: () => `boundary-note-${noteSeq++}` });
  const liveStarts: Rig['liveStarts'] = [];
  const voiceStops: Rig['voiceStops'] = [];
  const runtime = new MidiNoteInputRuntime({
    getProjectState: () => projectState,
    getSelectedChannelId: () => 'ch-1',
    playNote: (channel, note) => { liveStarts.push({ channelId: channel.id, pitch: note.pitch }); },
    stopChannelNote: (channelId, pitch, midiChannel) => { voiceStops.push({ channelId, pitch, midiChannel }); },
  });
  const bridge = new VirtualMidiInputBridge({
    getLiveMonitor: () => runtime,
    getRecorder: () => recorder,
    getClock: () => audioEngine.getTransportMusicalPosition(),
  });

  const commits: CommitRecord[] = [];
  let takeEnded = 0;
  let uiRecording = false;
  const ports: MidiTakeFinalizationPorts = {
    getRecorder: () => recorder,
    getClock: () => audioEngine.getTransportMusicalPosition(),
    commitTake: (target, notes) => {
      commits.push({ target: { ...target }, notes: notes.map(note => ({ ...note })) });
      history = history.commit(
        appendRecordedNotesToChannelInProjectState(projectState, target.channelId, notes, target.patternId),
        'Record MIDI performance',
      );
      projectState = history.present;
    },
    releaseHeldNotes: () => { bridge.releaseAll(); runtime.releaseAllNotes(); },
    onTakeEnded: () => { takeEnded += 1; uiRecording = false; },
  };
  const finalizeAtBoundary = (clock?: MidiRecordingClock): void => {
    finishMidiTake(ports, { clock, releaseHeldNotes: true });
  };

  const songEnds: SongEndRecord[] = [];
  audioEngine.setSongEndCallback(position => {
    songEnds.push({ ...position, playingWhenFired: engine.isPlaying === true });
    finalizeAtBoundary(position);
  });

  // App's engine MIDI listener, verbatim in behaviour.
  const handleMidiMessage = (event: MidiEventPayload): void => {
    if (event.type === 'deviceState') {
      if (event.deviceState === 'disconnected') finalizeAtBoundary();
      return;
    }
    runtime.handleMidiEvent(event);
    if (recorder.isRecording) {
      recorder.handleMidiEvent(event, audioEngine.getTransportMusicalPosition());
    }
  };
  audioEngine.addMidiListener(handleMidiMessage);

  const input: FakeMidiPort = {
    id: `boundary-keyboard-${rigCounter}`, name: 'Boundary Keyboard', type: 'input',
    state: 'connected', onmidimessage: null,
  };
  const access: FakeMidiAccess = { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { requestMIDIAccess: async () => access } as unknown as Navigator,
  });
  await audioEngine.initMidi();
  assert.equal(typeof input.onmidimessage, 'function', 'simulated input must be attached');

  const play = (mode: 'pat' | 'song', clips: PlaylistClip[] = []): void => {
    // Mixer tracks stay empty as in the transport harness this fake clock is
    // modelled on: rebuilding real insert-FX chains needs a full WebAudio
    // graph and has no bearing on transport/recording positions.
    const snapshot = audioEngine.createPlaybackSnapshot(projectState.channels, clips, []);
    audioEngine.play(
      snapshot.channels, snapshot.clips, mode, projectState.selectedPatternId,
      snapshot.mixerTracks, 16, projectState.playlistTracks, projectState.patterns,
    );
  };

  const pump = (steps: number): void => {
    const startTick = Math.round((fakeCtx.currentTime - START_LEAD_SECONDS) / STEP_SECONDS_AT_120_BPM);
    for (let tick = startTick; tick <= startTick + steps; tick += 1) {
      fakeCtx.currentTime = START_LEAD_SECONDS + tick * STEP_SECONDS_AT_120_BPM;
      const pending = timers; timers = [];
      for (const callback of pending) callback();
    }
  };

  return {
    fakeCtx, recorder, bridge, commits, songEnds, liveStarts, voiceStops,
    takeEndedCount: () => takeEnded,
    uiRecording: () => uiRecording,
    projectState: () => projectState,
    notes: (channelId = 'ch-1') => projectState.channels.find(c => c.id === channelId)!.notes.map(n => ({ ...n })),
    positionSteps: () => audioEngine.getTransportMusicalPosition().positionSteps,
    pump,
    sendBytes: (...messages) => {
      assert.equal(typeof input.onmidimessage, 'function', 'input detached');
      for (const data of messages) input.onmidimessage!({ data: new Uint8Array(data) });
    },
    setInputState: (state) => {
      input.state = state;
      assert.ok(access.onstatechange, 'engine must listen for MIDI state changes');
      access.onstatechange({ port: input });
    },
    inputAttached: () => typeof input.onmidimessage === 'function',
    startTake: (mode, clips = []) => {
      const started = recorder.start(
        { channelId: 'ch-1', patternId: 'pat-1', patternLengthSteps: 16, bpm: projectState.meta.bpm },
        audioEngine.getTransportMusicalPosition(),
      );
      assert.equal(started, true, 'take must arm');
      uiRecording = true;
      if (!audioEngine.getTransportMusicalPosition().playing) play(mode, clips);
    },
    finishTakeManually: () => { finishMidiTake(ports); },
    play,
    pressPause: () => { finalizeAtBoundary(); audioEngine.pause(); },
    pressStop: () => { finalizeAtBoundary(); audioEngine.stop(); },
    switchMode: (next, clips = []) => {
      finalizeAtBoundary();
      if (audioEngine.getTransportMusicalPosition().playing) {
        audioEngine.stop();
        play(next, clips);
      }
    },
    seekToBar: (bar) => {
      finalizeAtBoundary();
      const targetBar = Math.max(1, Math.floor(bar));
      const secondsPerBar = beatsToSeconds(
        barsToBeats(1, resolveProjectTimeSignature(projectState.meta)), projectState.meta.bpm,
      );
      audioEngine.seek((targetBar - 1) * secondsPerBar);
    },
    undo: () => { history = history.undo(); projectState = history.present; },
    redo: () => { history = history.redo(); projectState = history.present; },
    dispose: () => {
      audioEngine.removeMidiListener(handleMidiMessage);
      audioEngine.setSongEndCallback(null);
      try { audioEngine.stop(); } catch { /* teardown only */ }
    },
  };
};

const noteShape = (notes: Note[]) => notes.map(n => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity }));

describe('MIDI transport boundaries: Case A — pause', () => {
  it('closes the held gate at the pause position, releases the voice, and resume cannot extend the take', async () => {
    const rig = await createRig();
    try {
      rig.startTake('pat');
      rig.pump(8);
      assertCloseTo(rig.positionSteps(), 8);
      rig.sendBytes([0x90, 60, 100]); // held from step 8
      rig.pump(2); // step 10
      assertCloseTo(rig.positionSteps(), 10);

      rig.pressPause();

      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 8, duration: 2, velocity: 100 / 127 }]);
      assert.equal(rig.commits.length, 1, 'exactly one commit');
      assert.equal(rig.recorder.isRecording, false);
      assert.equal(rig.uiRecording(), false, 'recording UI reset at the boundary');
      assert.equal(rig.takeEndedCount(), 1);
      assert.deepEqual(rig.voiceStops, [{ channelId: 'ch-1', pitch: 60, midiChannel: 1 }], 'held live voice released');
      assertCloseTo(rig.positionSteps(), 10, 'pause keeps the position');

      // A late note-off for the closed gate cannot change the committed take.
      rig.sendBytes([0x80, 60, 0]);
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 8, duration: 2, velocity: 100 / 127 }]);

      // Held-note bookkeeping was cleared: another boundary releases nothing more.
      const stopsAfterLateOff = rig.voiceStops.length;
      rig.pressStop();
      assert.equal(rig.commits.length, 1, 'second boundary cannot commit twice');
      assert.equal(rig.takeEndedCount(), 1);
      assert.equal(rig.voiceStops.length, stopsAfterLateOff, 'no stale held note left to release');

      // Resume is not a take: new events are monitored but never recorded.
      rig.play('pat');
      rig.pump(4);
      rig.sendBytes([0x90, 62, 90]);
      rig.pump(2);
      rig.sendBytes([0x80, 62, 0]);
      assert.equal(rig.notes().length, 1, 'no new events enter the completed take');
      assert.equal(rig.commits.length, 1);

      // The boundary commit is one ordinary undoable history entry.
      rig.undo();
      assert.equal(rig.notes().length, 0);
      rig.redo();
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 8, duration: 2, velocity: 100 / 127 }]);
    } finally { rig.dispose(); }
  });
});

describe('MIDI transport boundaries: Case B — playlist ruler seek', () => {
  it('ends the note at the pre-seek position, not at the new playhead', async () => {
    const rig = await createRig();
    try {
      const clips = [patternClip('clip-seek', 8)];
      rig.startTake('song', clips);
      rig.pump(8);
      rig.sendBytes([0x90, 60, 100]);
      rig.pump(4); // step 12
      assertCloseTo(rig.positionSteps(), 12);

      rig.seekToBar(5); // step 64

      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 8, duration: 4, velocity: 100 / 127 }],
        'gate ends at pre-seek step 12, not stretched to the seek target');
      assertCloseTo(rig.positionSteps(), 64, 'seek still moves the playhead');
      assert.equal(rig.recorder.isRecording, false);
      assert.equal(rig.uiRecording(), false);
      assert.ok(rig.voiceStops.some(stop => stop.pitch === 60), 'held voice released at the seek');

      // Continued scrubbing (repeated ruler seeks) cannot finalize twice.
      rig.seekToBar(6);
      assert.equal(rig.commits.length, 1);
      assert.equal(rig.takeEndedCount(), 1);

      // Playback continuing from the new position leaves the closed take alone.
      rig.pump(8);
      rig.sendBytes([0x80, 60, 0], [0x90, 64, 90]);
      rig.pump(2);
      rig.sendBytes([0x80, 64, 0]);
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 8, duration: 4, velocity: 100 / 127 }]);
    } finally { rig.dispose(); }
  });
});

describe('MIDI transport boundaries: Case C — Pattern/Song mode switch', () => {
  it('closes the take at the old position before the transport restarts, keeping the original target', async () => {
    const rig = await createRig();
    try {
      rig.startTake('pat');
      rig.pump(8);
      rig.sendBytes([0x90, 60, 100]);
      rig.pump(4); // step 12

      rig.switchMode('song', [patternClip('clip-mode', 8)]);

      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 8, duration: 4, velocity: 100 / 127 }],
        'duration measured to the pre-switch position, not collapsed by the reset clock');
      assert.equal(rig.commits.length, 1);
      assert.deepEqual(rig.commits[0].target, {
        channelId: 'ch-1', patternId: 'pat-1', patternLengthSteps: 16, bpm: 120,
      }, 'notes belong to the channel/pattern the take started on');
      assert.equal(rig.notes('ch-2').length, 0, 'no other channel receives the take');
      assert.equal(rig.recorder.isRecording, false);
      assert.ok(rig.voiceStops.some(stop => stop.pitch === 60));

      rig.pump(4);
      rig.sendBytes([0x80, 60, 0]);
      assert.equal(rig.notes().length, 1, 'late note-off after the switch cannot reopen the take');
    } finally { rig.dispose(); }
  });
});

describe('MIDI transport boundaries: Case D — natural Song end', () => {
  it('finalizes at the arrangement endpoint via the pre-teardown engine callback, exactly once', async () => {
    const rig = await createRig();
    try {
      const clips = [patternClip('clip-end', 2)]; // arrangement ends at step 32
      rig.startTake('song', clips);
      rig.pump(28);
      assertCloseTo(rig.positionSteps(), 28);
      rig.sendBytes([0x90, 60, 100]); // held through the end
      rig.pump(12); // through step 32: song end fires inside this pump

      assert.equal(rig.songEnds.length, 1, 'song-end callback fired exactly once');
      assertCloseTo(rig.songEnds[0].positionSteps, 32, 'callback reports the true endpoint');
      assertCloseTo(rig.songEnds[0].positionSeconds, 4.0);
      assert.equal(rig.songEnds[0].playingWhenFired, true,
        'callback runs before Song-end teardown flips isPlaying / stops voices');
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 12, duration: 4, velocity: 100 / 127 }],
        'start folds into the pattern (28 % 16) and the gate ends at step 32');
      assert.equal(rig.commits.length, 1);
      assert.equal(rig.recorder.isRecording, false);
      assert.equal(rig.uiRecording(), false);
      assert.ok(rig.voiceStops.some(stop => stop.pitch === 60), 'held voice released at the end');
      assert.equal(engine.isPlaying, false, 'teardown still completes after the callback');

      // Transport teardown / replay cannot change the committed duration.
      rig.pressStop();
      assert.equal(rig.commits.length, 1, 'no second commit from a later boundary');
      rig.play('song', clips); // restarts from the top
      rig.pump(3);
      rig.sendBytes([0x80, 60, 0]); // the physical key is finally released
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 12, duration: 4, velocity: 100 / 127 }]);
      assert.equal(rig.songEnds.length, 1, 'replay has not re-ended');
    } finally { rig.dispose(); }
  });

  it('Pattern Mode loops forever and never reports a song end', async () => {
    const rig = await createRig();
    try {
      rig.startTake('pat');
      rig.pump(48);
      assert.equal(rig.songEnds.length, 0);
      assert.equal(rig.recorder.isRecording, true, 'take legitimately spans pattern loops');
      rig.finishTakeManually();
    } finally { rig.dispose(); }
  });
});

describe('MIDI transport boundaries: Case E — compatibility', () => {
  it('manual Stop still finalizes at the pre-reset position', async () => {
    const rig = await createRig();
    try {
      rig.startTake('pat');
      rig.pump(4);
      rig.sendBytes([0x90, 60, 100]);
      rig.pump(5); // step 9
      rig.pressStop();
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 4, duration: 5, velocity: 100 / 127 }]);
      assertCloseTo(rig.positionSteps(), 0, 'stop still resets the playhead after finalizing');
      assert.equal(rig.commits.length, 1);
      assert.ok(rig.voiceStops.some(stop => stop.pitch === 60), 'held bookkeeping cleared on stop');
    } finally { rig.dispose(); }
  });

  it('input disconnect finalizes and releases; reconnect records a fresh take (PR #246 preserved)', async () => {
    const rig = await createRig();
    try {
      rig.startTake('pat');
      rig.pump(4);
      rig.sendBytes([0x90, 60, 100]); // no note-off: device vanishes mid-gate
      rig.pump(4); // step 8
      rig.setInputState('disconnected');

      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 4, duration: 4, velocity: 100 / 127 }]);
      assert.equal(rig.recorder.isRecording, false);
      assert.equal(rig.uiRecording(), false);
      assert.ok(rig.voiceStops.some(stop => stop.pitch === 60));

      rig.setInputState('disconnected'); // duplicate notification
      assert.equal(rig.commits.length, 1, 'duplicate disconnect cannot commit twice');

      rig.setInputState('connected');
      assert.equal(rig.inputAttached(), true, 'reconnected input is reattached');
      rig.startTake('pat'); // transport kept playing through the disconnect
      rig.sendBytes([0x90, 64, 90]);
      rig.pump(3);
      rig.sendBytes([0x80, 64, 0]);
      rig.finishTakeManually();
      assert.equal(rig.commits.length, 2);
      assert.equal(rig.notes().length, 2);
      const second = rig.notes().find(note => note.pitch === 64)!;
      assertCloseTo(second.duration, 3);
    } finally { rig.dispose(); }
  });

  it('disconnect with no take armed still releases held live notes and commits nothing', async () => {
    const rig = await createRig();
    try {
      rig.play('pat');
      rig.pump(2);
      rig.sendBytes([0x90, 65, 100]); // live monitoring only
      assert.equal(rig.liveStarts.length, 1);
      rig.setInputState('disconnected');
      assert.ok(rig.voiceStops.some(stop => stop.pitch === 65), 'held voice released even without a take');
      assert.equal(rig.commits.length, 0);
      assert.equal(rig.takeEndedCount(), 0);
    } finally { rig.dispose(); }
  });

  it('ordinary recording is unchanged: manual finish does not force-release a still-held key', async () => {
    const rig = await createRig();
    try {
      rig.startTake('pat');
      rig.pump(2);
      rig.sendBytes([0x90, 60, 100]);
      rig.pump(4); // step 6, key still physically held
      rig.finishTakeManually();
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 60, start: 2, duration: 4, velocity: 100 / 127 }]);
      assert.equal(rig.voiceStops.length, 0,
        'stopping the take from the record toggle leaves the held key sounding until its note-off');
      rig.sendBytes([0x80, 60, 0]); // physical release ends the live voice only
      assert.equal(rig.voiceStops.length, 1);
      assert.equal(rig.notes().length, 1, 'note-off after manual finish changes nothing recorded');
    } finally { rig.dispose(); }
  });

  it('starting playback for a fresh take creates no boundary (arm while paused, then record)', async () => {
    const rig = await createRig();
    try {
      rig.play('pat');
      rig.pump(4);
      rig.pressPause(); // no take armed: nothing to finalize
      assert.equal(rig.commits.length, 0);
      assert.equal(rig.takeEndedCount(), 0);

      rig.startTake('pat'); // arms the recorder, then resumes the transport
      assert.equal(rig.recorder.isRecording, true, 'resume must not instantly finalize the new take');
      rig.sendBytes([0x90, 60, 100]);
      rig.pump(3);
      rig.sendBytes([0x80, 60, 0]);
      rig.finishTakeManually();
      assert.equal(rig.notes().length, 1);
      assertCloseTo(rig.notes()[0].duration, 3);
    } finally { rig.dispose(); }
  });

  it('virtual held keys are cleared at a boundary so a later pointer-up is a no-op', async () => {
    const rig = await createRig();
    try {
      rig.startTake('pat');
      rig.pump(4);
      rig.bridge.noteOn(64);
      assert.equal(rig.bridge.heldCount, 1);
      rig.pump(3); // step 7
      rig.pressPause();
      assert.deepEqual(noteShape(rig.notes()), [{ pitch: 64, start: 4, duration: 3, velocity: 0.9 }]);
      assert.equal(rig.bridge.heldCount, 0, 'bridge held-key bookkeeping cleared');
      rig.bridge.noteOff(64); // pointer released after the boundary
      assert.equal(rig.notes().length, 1);
      assert.equal(rig.commits.length, 1);
    } finally { rig.dispose(); }
  });
});

describe('MIDI transport boundaries: production wiring guards', () => {
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const engineSource = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');

  const slice = (source: string, start: string, end: string): string => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `missing marker: ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.ok(to > from, `missing end marker: ${end}`);
    return source.slice(from, to);
  };

  it('App finalizes before pause, stop, mode-switch stop and ruler seek — never on plain Play', () => {
    const togglePlay = slice(appSource, 'const handleTogglePlay = () => {', 'const handleStop = () => {');
    const finalizeInToggle = togglePlay.indexOf('finalizeMidiRecordingRef.current?.()');
    assert.ok(finalizeInToggle >= 0, 'pause path must finalize the take');
    assert.ok(finalizeInToggle < togglePlay.indexOf('audioEngine.pause()'), 'finalize precedes pause');
    assert.equal(togglePlay.split('finalizeMidiRecordingRef.current?.()').length - 1, 1,
      'the Play/resume branch must not create a take boundary');

    const stop = slice(appSource, 'const handleStop = () => {', 'const handleTogglePlayMode = () => {');
    assert.ok(stop.indexOf('finalizeMidiRecordingRef.current?.()') < stop.indexOf('audioEngine.stop()'),
      'Stop keeps its pre-reset finalization');

    const mode = slice(appSource, 'const handleTogglePlayMode = () => {', 'const handleToggleRecord = () => {');
    assert.ok(mode.indexOf('finalizeMidiRecordingRef.current?.()') >= 0, 'mode switch must finalize');
    assert.ok(mode.indexOf('finalizeMidiRecordingRef.current?.()') < mode.indexOf('audioEngine.stop()'),
      'finalize precedes the mode-switch transport restart');

    const seek = slice(appSource, 'onSeekToBar={(bar) => {', 'audioEngine.seek((targetBar - 1) * secondsPerBar);');
    assert.ok(seek.includes('finalizeMidiRecordingRef.current?.()'),
      'ruler seek finalizes at the old position before seeking');
  });

  it('App registers the engine Song-end callback and the engine notifies before teardown', () => {
    const registration = slice(appSource, 'audioEngine.setSongEndCallback(', 'audioEngine.setSongEndCallback(null)');
    assert.ok(registration.includes('finalizeMidiRecordingRef.current?.(position)'),
      'song end finalizes with the engine-reported endpoint clock');

    const handleSongEnd = slice(engineSource, 'private handleSongEnd(): void {', 'private triggerCurrentStep');
    const notifyAt = handleSongEnd.indexOf('notifySongEnd(');
    assert.ok(notifyAt >= 0, 'engine must notify song end');
    assert.ok(notifyAt < handleSongEnd.indexOf('stopActivePlaybackAudio()'),
      'notification precedes voice teardown');
    assert.ok(notifyAt < handleSongEnd.indexOf('this.isPlaying = false'),
      'notification precedes the playing-state flip');
  });
});
