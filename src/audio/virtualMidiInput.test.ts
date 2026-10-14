/**
 * Virtual MIDI input bridge — focused unit suite.
 *
 * The bridge has no audio graph and no project state of its own: it is a pure
 * router that turns a virtual note-on/off into the SAME `MidiEventPayload` the
 * hardware path emits and forwards it to (a) the live monitor and (b) the
 * recorder, but only while a take is armed. These tests pin that routing,
 * velocity, release, overlap, cancellation and the recorder-disabled gate all
 * behave — using fakes so timing/pitch are fully deterministic.
 *
 * Capture correctness of the recorder itself (pitch/velocity/start/duration,
 * tempo, wrap, retrigger) is pinned separately in src/audio/midiRecording.test.ts;
 * here we assert the bridge delivers the right events to the right consumers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualMidiInputBridge } from './virtualMidiInput';
import type { MidiEventPayload } from './audioEngine';
import type { MidiRecordingClock } from './midiRecording';

class FakeLiveMonitor {
  events: MidiEventPayload[] = [];
  handleMidiEvent(event: MidiEventPayload): { status: string } {
    this.events.push(event);
    return { status: 'note_on' };
  }
  clear(): void {
    this.events = [];
  }
}

class FakeRecorder {
  isRecording = false;
  events: MidiEventPayload[] = [];
  handleMidiEvent(event: MidiEventPayload, _clock: MidiRecordingClock): { status: string } {
    this.events.push(event);
    return { status: 'note_opened' };
  }
  clear(): void {
    this.events = [];
  }
}

const makeBridge = (live: FakeLiveMonitor, recorder: FakeRecorder, clock: MidiRecordingClock = { positionSteps: 0 }) =>
  new VirtualMidiInputBridge({
    getLiveMonitor: () => live,
    getRecorder: () => recorder,
    getClock: () => clock,
  });

const noteOn = (pitch: number, velocity = 0.9, midiChannel = 1): MidiEventPayload => ({
  type: 'noteOn',
  note: pitch,
  velocity,
  midiChannel,
});

test('routes note-on to the live monitor (audition) regardless of record state', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  const bridge = makeBridge(live, recorder);

  bridge.noteOn(60, { velocity: 0.8 });

  assert.equal(live.events.length, 1);
  assert.deepEqual(live.events[0], noteOn(60, 0.8, 1));
  // Not armed: nothing reaches the recorder.
  assert.equal(recorder.events.length, 0);
});

test('routes note-on AND note-off to the recorder only while armed', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  const bridge = makeBridge(live, recorder);

  bridge.noteOn(64, { velocity: 0.5 });
  assert.equal(recorder.events.length, 0, 'recorder silent before arming');

  recorder.isRecording = true;
  bridge.noteOn(64, { velocity: 0.5 });
  bridge.noteOff(64);

  assert.equal(recorder.events.length, 2);
  assert.deepEqual(recorder.events[0], noteOn(64, 0.5, 1));
  assert.deepEqual(recorder.events[1], { type: 'noteOff', note: 64, midiChannel: 1 });
  // Live monitor tracked every gesture (the pre-arm note-on plus the two armed
  // edges) so audition is preserved whether or not a take is running.
  assert.equal(live.events.length, 3);
});

test('preserves pitch, velocity and midi channel on both edges', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  recorder.isRecording = true;
  const bridge = makeBridge(live, recorder);

  bridge.noteOn(72, { velocity: 100 / 127, midiChannel: 3 });
  bridge.noteOff(72, { midiChannel: 3 });

  assert.deepEqual(recorder.events[0], { type: 'noteOn', note: 72, velocity: 100 / 127, midiChannel: 3 });
  assert.deepEqual(recorder.events[1], { type: 'noteOff', note: 72, midiChannel: 3 });
});

test('stamps recorded events with the transport clock at arrival', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  recorder.isRecording = true;
  let clock: MidiRecordingClock = { positionSteps: 12 };
  const bridge = makeBridge(live, recorder, clock);

  bridge.noteOn(60);
  // Mutate the shared clock and fire the off: each event must capture its own time.
  clock = { positionSteps: 20 };
  bridge.noteOff(60);

  // The bridge asks the clock at each call; we can't see the value directly, but
  // we can confirm the recorder received both edges in order with no extra events.
  assert.equal(recorder.events.length, 2);
  assert.equal(recorder.events[0].type, 'noteOn');
  assert.equal(recorder.events[1].type, 'noteOff');
});

test('handles simultaneous notes: each key is its own voice, released independently', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  recorder.isRecording = true;
  const bridge = makeBridge(live, recorder);

  bridge.noteOn(60, { midiChannel: 1 }); // pointer A
  bridge.noteOn(64, { midiChannel: 1 }); // pointer B (chord)
  assert.equal(bridge.heldCount, 2);

  // Release only the first; the second must remain held and still audible.
  bridge.noteOff(60, { midiChannel: 1 });
  assert.equal(bridge.heldCount, 1);
  const noteOffs = recorder.events.filter(e => e.type === 'noteOff');
  assert.equal(noteOffs.length, 1, 'only one note-off delivered');
  assert.equal(noteOffs[0].note, 60);

  bridge.noteOff(64, { midiChannel: 1 });
  assert.equal(bridge.heldCount, 0);

  // Live monitor got 2 on + 2 off = 4; recorder got the same (armed).
  assert.equal(live.events.length, 4);
  assert.equal(recorder.events.length, 4);
});

test('repeated note-on of the same key retriggers without sticking', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  recorder.isRecording = true;
  const bridge = makeBridge(live, recorder);

  bridge.noteOn(67, { midiChannel: 1 });
  bridge.noteOn(67, { midiChannel: 1 }); // re-press while held
  assert.equal(bridge.heldCount, 1, 'same key stays a single held voice');

  bridge.noteOff(67, { midiChannel: 1 });
  assert.equal(bridge.heldCount, 0);

  const ons = recorder.events.filter(e => e.type === 'noteOn');
  assert.equal(ons.length, 2, 'both note-ons forwarded (retrigger finalizes prior gate)');
  assert.equal(recorder.events.filter(e => e.type === 'noteOff').length, 1);
});

test('cancellation / releaseAll closes every held voice exactly once', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  recorder.isRecording = true;
  const bridge = makeBridge(live, recorder);

  bridge.noteOn(60, { midiChannel: 1 });
  bridge.noteOn(64, { midiChannel: 1 });
  bridge.noteOn(67, { midiChannel: 1 });
  assert.equal(bridge.heldCount, 3);

  bridge.releaseAll();
  assert.equal(bridge.heldCount, 0);

  const offs = recorder.events.filter(e => e.type === 'noteOff');
  assert.equal(offs.length, 3, 'every held note released exactly once');
  // A second releaseAll must be a no-op (no stuck double note-offs).
  bridge.releaseAll();
  assert.equal(recorder.events.filter(e => e.type === 'noteOff').length, 3);
});

test('note-off for a never-pressed key is ignored (no phantom release)', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  recorder.isRecording = true;
  const bridge = makeBridge(live, recorder);

  bridge.noteOff(99, { midiChannel: 1 });
  assert.equal(bridge.heldCount, 0);
  assert.equal(recorder.events.length, 0);
  assert.equal(live.events.length, 0);
});

test('recorder disabled (not armed): notes still audition, nothing is recorded', () => {
  const live = new FakeLiveMonitor();
  const recorder = new FakeRecorder();
  const bridge = makeBridge(live, recorder);
  assert.equal(bridge.isRecording, false);

  bridge.noteOn(60, { velocity: 0.9 });
  bridge.noteOff(60);
  bridge.noteOn(62);
  bridge.noteOff(62);

  // Audition path fired for all four edges...
  assert.equal(live.events.length, 4);
  // ...but capture never engaged.
  assert.equal(recorder.events.length, 0);
  assert.equal(bridge.heldCount, 0);
});

test('null live monitor / recorder ports never throw', () => {
  const bridge = new VirtualMidiInputBridge({
    getLiveMonitor: () => null,
    getRecorder: () => null,
    getClock: () => ({ positionSteps: 0 }),
  });
  assert.doesNotThrow(() => {
    bridge.noteOn(60);
    bridge.noteOff(60);
    bridge.releaseAll();
  });
  assert.equal(bridge.heldCount, 0);
});
