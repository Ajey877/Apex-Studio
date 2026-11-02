import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MidiOutputScheduler,
  audioTimeToPerformanceMs,
  clampMidiChannelNumber,
  evaluateMidiOutputPortUsability,
  normalizeChannelMidiOutputRouting,
  resolveChannelMidiOutputRouting,
  shouldSuppressInternalChannelAudio,
  shouldTransmitExternalMidi,
  type MidiOutputPortLike,
} from './midiOutputScheduler';
import { createDefaultProjectState } from '../state/projectState';
import type { Channel, Note } from '../types/daw';

interface RecordedMidiPacket {
  bytes: number[];
  timestamp?: number;
}

class InstrumentedMidiOutputPort implements MidiOutputPortLike {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  state: 'connected' | 'disconnected' = 'connected';
  connection: 'open' | 'closed' | 'pending' = 'open';
  readonly sent: RecordedMidiPacket[] = [];
  clearCalls = 0;
  openCalls = 0;
  readonly supportsClear: boolean;

  constructor(
    id: string,
    options: {
      name?: string;
      manufacturer?: string;
      state?: 'connected' | 'disconnected';
      connection?: 'open' | 'closed' | 'pending';
      supportsClear?: boolean;
    } = {},
  ) {
    this.id = id;
    this.name = options.name ?? id;
    this.manufacturer = options.manufacturer ?? 'Sequential';
    this.state = options.state ?? 'connected';
    this.connection = options.connection ?? 'open';
    this.supportsClear = options.supportsClear ?? true;
    if (!this.supportsClear) {
      (this as { clear?: () => void }).clear = undefined;
    }
  }

  send(data: number[] | Uint8Array, timestamp?: number): void {
    if (this.state !== 'connected' || this.connection === 'closed') {
      throw new Error(`Port ${this.id} cannot transmit (${this.state}/${this.connection})`);
    }
    this.sent.push({ bytes: Array.from(data), timestamp });
  }

  clear(): void {
    this.clearCalls += 1;
  }

  async open(): Promise<MidiOutputPortLike> {
    this.openCalls += 1;
    if (this.state === 'connected') {
      this.connection = 'open';
    }
    return this;
  }
}

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  const base = createDefaultProjectState().channels[0];
  return {
    ...base,
    id,
    name: id,
    pitch: 0,
    mute: false,
    solo: false,
    steps: new Array(16).fill(false),
    notes: [],
    midiOutput: {
      outputDeviceId: 'hw-synth-a',
      midiChannel: 1,
      mode: 'external',
    },
    ...overrides,
  };
}

function makeNote(pitch = 60, overrides: Partial<Note> = {}): Note {
  return {
    id: `n-${pitch}-${overrides.start ?? 0}`,
    pitch,
    start: 0,
    duration: 1,
    velocity: 0.8,
    ...overrides,
  };
}

describe('MidiOutputScheduler — port usability, clock mapping, and routing normalization', () => {
  it('never marks an enumerated closed, pending, disconnected, or sendless port as usable', () => {
    assert.deepEqual(evaluateMidiOutputPortUsability(null), {
      usable: false,
      state: 'disconnected',
      statusReason: 'Selected MIDI output device is not connected',
    });

    const disconnected = new InstrumentedMidiOutputPort('out-disc', { state: 'disconnected' });
    assert.equal(evaluateMidiOutputPortUsability(disconnected).usable, false);

    const closedEnumerated = new InstrumentedMidiOutputPort('out-closed', {
      state: 'connected',
      connection: 'closed',
    });
    const closedStatus = evaluateMidiOutputPortUsability(closedEnumerated);
    assert.equal(closedStatus.usable, false, 'enumerated closed port must not report usable');
    assert.equal(closedStatus.connection, 'closed');

    const pendingPort = new InstrumentedMidiOutputPort('out-pending', {
      state: 'connected',
      connection: 'pending',
    });
    assert.equal(evaluateMidiOutputPortUsability(pendingPort).usable, false);

    const openPort = new InstrumentedMidiOutputPort('out-open', {
      state: 'connected',
      connection: 'open',
    });
    assert.deepEqual(evaluateMidiOutputPortUsability(openPort), {
      usable: true,
      state: 'connected',
      connection: 'open',
    });
  });

  it('normalizes Channel.midiOutput deterministically and distinguishes off / mirror / external modes', () => {
    assert.deepEqual(normalizeChannelMidiOutputRouting(undefined), {
      outputDeviceId: null,
      midiChannel: 1,
      mode: 'off',
    });
    assert.deepEqual(
      normalizeChannelMidiOutputRouting({
        outputDeviceId: '  moog-sub37  ',
        midiChannel: 99,
        mode: 'external',
      }),
      {
        outputDeviceId: 'moog-sub37',
        midiChannel: 16,
        mode: 'external',
      },
    );
    assert.equal(clampMidiChannelNumber(0), 1);
    assert.equal(clampMidiChannelNumber(10), 10);
    assert.equal(clampMidiChannelNumber(20), 16);

    const offCh = makeChannel('off', { midiOutput: { outputDeviceId: 'a', midiChannel: 1, mode: 'off' } });
    const mirrorCh = makeChannel('mirror', { midiOutput: { outputDeviceId: 'a', midiChannel: 3, mode: 'mirror' } });
    const extCh = makeChannel('ext', { midiOutput: { outputDeviceId: 'a', midiChannel: 5, mode: 'external' } });

    assert.equal(shouldTransmitExternalMidi(offCh), false);
    assert.equal(shouldSuppressInternalChannelAudio(offCh), false);

    assert.equal(shouldTransmitExternalMidi(mirrorCh), true);
    assert.equal(shouldSuppressInternalChannelAudio(mirrorCh), false);

    assert.equal(shouldTransmitExternalMidi(extCh), true);
    assert.equal(shouldSuppressInternalChannelAudio(extCh), true);
    assert.equal(resolveChannelMidiOutputRouting(extCh).midiChannel, 5);
  });

  it('maps AudioContext event times to performance.now() timestamps via getOutputTimestamp with monotonic floor', () => {
    const mappedWithBridge = audioTimeToPerformanceMs(2.125, 2.01, 5010, {
      contextTime: 2.0,
      performanceTime: 5000,
    });
    assert.ok(Math.abs(mappedWithBridge - 5125) < 1e-6);

    const mappedFallback = audioTimeToPerformanceMs(2.125, 2.0, 5000, null);
    assert.ok(Math.abs(mappedFallback - 5125) < 1e-6);

    // Past audioTime clamps to nowPerfMs so Web MIDI never receives stale negative deltas.
    assert.equal(audioTimeToPerformanceMs(0.9, 1.0, 3000, null), 3000);
  });
});

describe('MidiOutputScheduler — MIDI channels 1–16, velocity, durations, horizon, and deduplication', () => {
  it('encodes Note On and Note Off accurately across all 16 MIDI channels, velocities, and channel transpose', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-synth-a');
    const ports = new Map<string, MidiOutputPortLike>([[port.id, port]]);
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => ports,
      performanceNowMs: () => perfMs,
    });

    scheduler.beginTransportTake(1);
    for (let midiCh = 1; midiCh <= 16; midiCh += 1) {
      const ch = makeChannel(`ch-${midiCh}`, {
        pitch: 2, // +2 semitones transpose
        midiOutput: { outputDeviceId: port.id, midiChannel: midiCh, mode: 'external' },
      });
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep: midiCh - 1,
        step: (midiCh - 1) % 16,
        stepAudioTimeSeconds: (midiCh - 1) * 0.125,
        unswungStepAudioTimeSeconds: (midiCh - 1) * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'pat',
        patternLoopSteps: 16,
        contextCurrentTimeSeconds: (midiCh - 1) * 0.125,
      });
      const res = scheduler.scheduleChannelNote({
        channel: ch,
        note: makeNote(60, { duration: 1, velocity: midiCh / 16 }),
        onsetAudioTimeSeconds: (midiCh - 1) * 0.125,
        bpm: 120,
        contextCurrentTimeSeconds: (midiCh - 1) * 0.125,
      });
      scheduler.endTransportStep();
      assert.equal(res.sent, true);
      perfMs += 125;
    }

    assert.equal(port.sent.length, 32, '16 Note Ons + 16 Note Offs');
    for (let i = 0; i < 16; i += 1) {
      const midiCh = i + 1;
      const expectedVel = Math.max(1, Math.min(127, Math.round(((midiCh / 16) * 127))));
      const onMsg = port.sent[i * 2];
      const offMsg = port.sent[i * 2 + 1];
      assert.deepEqual(onMsg.bytes, [0x90 | (midiCh - 1), 62, expectedVel]);
      assert.deepEqual(offMsg.bytes, [0x80 | (midiCh - 1), 62, 0]);
      assert.ok(Math.abs((offMsg.timestamp! - onMsg.timestamp!) - 125) < 1e-6, '1 step @ 120 BPM = 125 ms');
    }
  });

  it('holds multi-step Note Offs until their release step enters the bounded horizon and defers distant sub-sequence Note Ons', () => {
    let perfMs = 2000;
    const port = new InstrumentedMidiOutputPort('hw-synth-a');
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => new Map([[port.id, port]]),
      performanceNowMs: () => perfMs,
    });
    const ch = makeChannel('lead');

    scheduler.beginTransportTake(1);
    // Step 0 at 120 BPM (125 ms/step): schedule a 4-step sustained note (releases at step 4 = +500 ms)
    // AND a distant arp voice at +3 steps (+375 ms, beyond bounded horizon).
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0.05,
      unswungStepAudioTimeSeconds: 0.05,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(64, { id: 'sustained-4', duration: 4, velocity: 1 }),
      onsetAudioTimeSeconds: 0.05,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    const deferredArp = scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(71, { id: 'arp-step-3', duration: 1, velocity: 0.75 }),
      onsetAudioTimeSeconds: 0.05 + 3 * 0.125, // step 3 (0.425 s > horizon)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    assert.equal(deferredArp.deferredToHorizon, true, 'distant sub-sequence note is held until its step enters horizon');
    assert.equal(port.sent.length, 1, 'only step-0 Note On transmitted initially; 4-step Note Off is NOT pre-queued');
    assert.deepEqual(port.sent[0].bytes, [0x90, 64, 127]);
    assert.ok(Math.abs(port.sent[0].timestamp! - 2050) < 1e-6);

    // Advance through steps 1 and 2: neither release (step 4) nor deferred arp (step 3) should fire yet.
    for (const stepIdx of [1, 2]) {
      perfMs = 2000 + stepIdx * 125;
      const stepAudio = 0.05 + stepIdx * 0.125;
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepAudio,
        unswungStepAudioTimeSeconds: stepAudio,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }
    assert.equal(port.sent.length, 1, 'still holding 4-step Note Off across steps 1 and 2');

    // Step 3 enters horizon: deferred arp Note On + its 1-step Note Off AND the 4-step Note Off (step 4 <= 3 + 1) flush!
    perfMs = 2000 + 3 * 125;
    const step3Audio = 0.05 + 3 * 0.125;
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 3,
      step: 3,
      stepAudioTimeSeconds: step3Audio,
      unswungStepAudioTimeSeconds: step3Audio,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 3 * 0.125,
    });
    scheduler.endTransportStep();

    const pitch64Off = port.sent.find(p => p.bytes[0] === 0x80 && p.bytes[1] === 64);
    const pitch71On = port.sent.find(p => p.bytes[0] === 0x90 && p.bytes[1] === 71);
    const pitch71Off = port.sent.find(p => p.bytes[0] === 0x80 && p.bytes[1] === 71);
    assert.ok(pitch64Off, '4-step sustained note released cleanly at step 4');
    assert.ok(Math.abs(pitch64Off!.timestamp! - 2550) < 1e-6, '2050 ms + 500 ms = 2550 ms');
    assert.ok(pitch71On && Math.abs(pitch71On.timestamp! - 2425) < 1e-6);
    assert.ok(pitch71Off && Math.abs(pitch71Off.timestamp! - 2550) < 1e-6);
  });

  it('deduplicates repeated scheduler passes for the same step while allowing genuine loop retriggers', () => {
    let perfMs = 500;
    const port = new InstrumentedMidiOutputPort('hw-synth-a');
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => new Map([[port.id, port]]),
      performanceNowMs: () => perfMs,
    });
    const ch = makeChannel('pluck');
    const note = makeNote(67, { id: 'riff-0', duration: 1, velocity: 0.9 });

    scheduler.beginTransportTake(1);
    const runPass = (absoluteStep: number, onsetSeconds: number) => {
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep,
        step: absoluteStep % 4,
        stepAudioTimeSeconds: onsetSeconds,
        unswungStepAudioTimeSeconds: onsetSeconds,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'pat',
        patternLoopSteps: 4,
        contextCurrentTimeSeconds: onsetSeconds,
      });
      const r = scheduler.scheduleChannelNote({
        channel: ch,
        note,
        onsetAudioTimeSeconds: onsetSeconds,
        bpm: 120,
        contextCurrentTimeSeconds: onsetSeconds,
      });
      scheduler.endTransportStep();
      return r;
    };

    const first = runPass(0, 0.05);
    const duplicate = runPass(0, 0.05);
    assert.equal(first.sent, true);
    assert.deepEqual(duplicate, { sent: false, reason: 'duplicate' });
    assert.equal(port.sent.filter(m => m.bytes[0] === 0x90).length, 1, 'no duplicate Note On on repeated pass');

    // Next loop cycle (absoluteStep = 4, onset = 0.55 s) is a genuine new cycle and MUST fire!
    perfMs = 1000;
    const nextCycle = runPass(4, 0.55);
    assert.equal(nextCycle.sent, true);
    assert.equal(port.sent.filter(m => m.bytes[0] === 0x90).length, 2);
  });
});

describe('MidiOutputScheduler — overlapping pitches, cleanup isolation, loop wrap, and tempo retiming', () => {
  it('handles overlapping notes of the same pitch with 1:1 Note On/Off parity without cutting the longer note short', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-synth-a');
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => new Map([[port.id, port]]),
      performanceNowMs: () => perfMs,
    });
    const ch = makeChannel('mono-lead');

    scheduler.beginTransportTake(1);
    // Step 0: long 4-step C4 (releases at step 4)
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0,
      unswungStepAudioTimeSeconds: 0,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'long', duration: 4, velocity: 0.8 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    // Step 1 (+125 ms): shorter 1-step C4 overlaps while first C4 is still open!
    perfMs = 1125;
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 1,
      step: 1,
      stepAudioTimeSeconds: 0.125,
      unswungStepAudioTimeSeconds: 0.125,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0.125,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'short-overlap', duration: 1, velocity: 1.0 }),
      onsetAudioTimeSeconds: 0.125,
      bpm: 120,
      contextCurrentTimeSeconds: 0.125,
    });
    scheduler.endTransportStep();

    // Step 3 (+375 ms): flush step-4 merged release!
    perfMs = 1375;
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 3,
      step: 3,
      stepAudioTimeSeconds: 0.375,
      unswungStepAudioTimeSeconds: 0.375,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0.375,
    });
    scheduler.endTransportStep();

    const ons = port.sent.filter(m => m.bytes[0] === 0x90);
    const offs = port.sent.filter(m => m.bytes[0] === 0x80);
    assert.equal(ons.length, 2);
    assert.equal(offs.length, 2, 'strict 1:1 Note On / Note Off count');
    assert.equal(offs[0].timestamp, 1125, 'clean retrigger Note Off before overlapping Note On');
    assert.equal(offs[1].timestamp, 1500, 'merged release preserves the longer 4-step span (step 4 = 1500 ms)');
  });

  it('closes overhanging notes at pattern loop wrap without silencing step-0 notes of the new cycle', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-synth-a');
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => new Map([[port.id, port]]),
      performanceNowMs: () => perfMs,
    });
    const ch = makeChannel('pad');

    scheduler.beginTransportTake(1);
    // 4-step pattern: trigger a 4-step note at step 2 of cycle 0 (overhangs wrap at step 4)
    perfMs = 1250;
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 2,
      step: 2,
      stepAudioTimeSeconds: 0.25,
      unswungStepAudioTimeSeconds: 0.25,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'pat',
      patternLoopSteps: 4,
      contextCurrentTimeSeconds: 0.25,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(65, { id: 'overhang', duration: 4, velocity: 0.85 }),
      onsetAudioTimeSeconds: 0.25,
      bpm: 120,
      contextCurrentTimeSeconds: 0.25,
    });
    scheduler.endTransportStep();

    // Wrap boundary: cycle 1 step 0 (absoluteStep = 4, t = 0.50 s -> 1500 ms)
    perfMs = 1500;
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 4,
      step: 0,
      stepAudioTimeSeconds: 0.5,
      unswungStepAudioTimeSeconds: 0.5,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'pat',
      patternLoopSteps: 4,
      contextCurrentTimeSeconds: 0.5,
    });
    // Also trigger a fresh note at step 0 of cycle 1!
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(67, { id: 'cycle1-step0', duration: 2, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0.5,
      bpm: 120,
      contextCurrentTimeSeconds: 0.5,
    });
    scheduler.endTransportStep();

    const overhangOff = port.sent.find(m => m.bytes[0] === 0x80 && m.bytes[1] === 65);
    const freshOn = port.sent.find(m => m.bytes[0] === 0x90 && m.bytes[1] === 67);
    assert.ok(overhangOff, 'overhanging note from cycle 0 closed at pattern loop wrap');
    assert.equal(overhangOff!.timestamp, 1500);
    assert.ok(freshOn, 'step-0 note of new cycle still triggers cleanly');
    assert.equal(scheduler.getActiveNoteCount(), 1, 'only the cycle-1 note remains active');
  });

  it('isolates channel cleanup on output switch / mute without silencing sibling channels on the same or other ports', () => {
    let perfMs = 1000;
    const portA = new InstrumentedMidiOutputPort('port-a');
    const portB = new InstrumentedMidiOutputPort('port-b');
    const ports = new Map<string, MidiOutputPortLike>([
      [portA.id, portA],
      [portB.id, portB],
    ]);
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => ports,
      performanceNowMs: () => perfMs,
    });

    const ch1 = makeChannel('ch-1', {
      midiOutput: { outputDeviceId: 'port-a', midiChannel: 1, mode: 'external' },
    });
    const ch2 = makeChannel('ch-2', {
      midiOutput: { outputDeviceId: 'port-a', midiChannel: 2, mode: 'external' },
    });
    const ch3 = makeChannel('ch-3', {
      midiOutput: { outputDeviceId: 'port-b', midiChannel: 1, mode: 'mirror' },
    });

    scheduler.beginTransportTake(1);
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0,
      unswungStepAudioTimeSeconds: 0,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0,
    });
    for (const [ch, pitch] of [
      [ch1, 60],
      [ch2, 64],
      [ch3, 67],
    ] as const) {
      scheduler.scheduleChannelNote({
        channel: ch,
        note: makeNote(pitch, { duration: 4 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
    }
    scheduler.endTransportStep();
    scheduler.sendChannelControlChange(ch1, 64, 127); // hold sustain on ch1 (port-a ch 1)

    // Switch ch1 from port-a Ch 1 -> port-b Ch 5 mid-note:
    perfMs = 1050;
    const ch1Switched: Channel = {
      ...ch1,
      midiOutput: { outputDeviceId: 'port-b', midiChannel: 5, mode: 'external' },
    };
    scheduler.reconcileChannels([ch1, ch2, ch3], [ch1Switched, ch2, ch3], c => !c.mute);

    // ch1's pitch 60 + sustain CC64 + CC123 on port-a Ch 1 MUST be cleaned up,
    // while ch2 (port-a Ch 2) and ch3 (port-b Ch 1) remain untouched!
    assert.ok(portA.sent.some(m => m.bytes[0] === 0x80 && m.bytes[1] === 60), 'ch1 Note Off sent on port-a Ch 1');
    assert.ok(portA.sent.some(m => m.bytes[0] === 0xb0 && m.bytes[1] === 64 && m.bytes[2] === 0), 'ch1 sustain released on port-a Ch 1');
    assert.ok(portA.sent.some(m => m.bytes[0] === 0xb0 && m.bytes[1] === 123 && m.bytes[2] === 0), 'CC 123 sent on port-a Ch 1');
    assert.equal(portA.sent.some(m => (m.bytes[0] & 0x0f) === 1 && m.bytes[0] !== 0x91), false, 'ch2 on port-a Ch 2 untouched');
    assert.equal(portB.sent.length, 1, 'ch3 on port-b Ch 1 untouched');
    assert.equal(scheduler.getActiveNoteCount(), 2, 'ch2 and ch3 remain active');
  });

  it('re-times both intra-step queued Note Offs and multi-step sustained notes when BPM changes mid-playback', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-synth-a');
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => new Map([[port.id, port]]),
      performanceNowMs: () => perfMs,
    });
    const ch = makeChannel('lead');

    scheduler.beginTransportTake(1);
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0,
      unswungStepAudioTimeSeconds: 0,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0,
    });
    // 1-step note queued immediately for 1125 ms
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'one-step', duration: 1, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    assert.equal(port.sent.length, 2);
    assert.equal(port.sent[1].timestamp, 1125);

    // 25 ms into the step (perfMs = 1025), BPM halves from 120 -> 60!
    // Remaining 100 ms @ 120 BPM becomes 200 ms @ 60 BPM -> retimed Note Off at 1225 ms!
    perfMs = 1025;
    scheduler.handleTempoChange(120, 60);

    assert.equal(port.clearCalls, 1, 'cancelled stale 120-BPM Note Off via port.clear()');
    const lastPacket = port.sent[port.sent.length - 1];
    assert.deepEqual(lastPacket.bytes, [0x80, 60, 0]);
    assert.ok(Math.abs(lastPacket.timestamp! - 1225) < 1e-6, 'retimed Note Off placed at 1225 ms');
  });

  it('falls back cleanly on stop/pause when a MIDIOutput implementation omits clear()', () => {
    let perfMs = 5000;
    const legacyPort = new InstrumentedMidiOutputPort('legacy-din', { supportsClear: false });
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => new Map([[legacyPort.id, legacyPort]]),
      performanceNowMs: () => perfMs,
    });
    const ch = makeChannel('din', {
      midiOutput: { outputDeviceId: legacyPort.id, midiChannel: 3, mode: 'external' },
    });

    scheduler.beginTransportTake(1);
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0.04, // future onset at 5040 ms
      unswungStepAudioTimeSeconds: 0.04,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'pat',
      patternLoopSteps: 16,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(48, { duration: 4 }),
      onsetAudioTimeSeconds: 0.04,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    // Stop before the future Note On at 5040 ms has even sounded:
    scheduler.cleanupAll('stop');
    const noteOff = legacyPort.sent.find(m => m.bytes[0] === 0x82 && m.bytes[1] === 48);
    assert.ok(noteOff, 'scheduled safety Note Off after non-cancellable future Note On');
    assert.ok(noteOff!.timestamp! > 5040);
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('guards audioTimeToPerformanceMs against stale pre-suspend getOutputTimestamp pairs so look-ahead timestamps stay in the future', () => {
    // Stale outputTimestamp from 3 seconds before resume: impliedNowPerfMs = 2010 vs safeNowMs = 5010
    const mappedAfterResume = audioTimeToPerformanceMs(2.04, 2.01, 5010, {
      contextTime: 2.0,
      performanceTime: 2000,
    });
    assert.ok(
      Math.abs(mappedAfterResume - 5040) < 1e-6,
      'falls back cleanly to preserve +30 ms look-ahead when outputTimestamp is stale',
    );
  });

  it('distinguishes completed vs active vs future-queued notes on Stop and preserves sibling future events during per-channel cleanup', () => {
    let perfMs = 1000;
    const portA = new InstrumentedMidiOutputPort('port-a');
    const portB = new InstrumentedMidiOutputPort('port-b');
    const ports = new Map<string, MidiOutputPortLike>([
      [portA.id, portA],
      [portB.id, portB],
    ]);
    const scheduler = new MidiOutputScheduler({
      getOutputs: () => ports,
      performanceNowMs: () => perfMs,
    });

    const chA1 = makeChannel('ch-a1', {
      midiOutput: { outputDeviceId: 'port-a', midiChannel: 4, mode: 'external' },
    });
    const chA2 = makeChannel('ch-a2', {
      midiOutput: { outputDeviceId: 'port-a', midiChannel: 7, mode: 'external' },
    });

    // 1. Completed note before Stop -> no unnecessary port.clear() call
    scheduler.beginTransportTake(1);
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0,
      unswungStepAudioTimeSeconds: 0,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'pat',
      patternLoopSteps: 16,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chA1,
      note: makeNote(36, { id: 'short-done', duration: 1 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 1300; // past 1125 ms release
    scheduler.cleanupAll('stop');
    assert.equal(portA.clearCalls, 0, 'completed note does not trigger unnecessary port.clear()');
    assert.equal(scheduler.getActiveNoteCount(), 0);

    // 2. Shared-port per-channel cleanup cancels target future Note On while re-queuing sibling future events
    portA.sent.length = 0;
    perfMs = 2000;
    scheduler.beginTransportTake(2);
    scheduler.beginTransportStep({
      takeGeneration: 2,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 2.06, // +60 ms look-ahead -> 2060 ms
      unswungStepAudioTimeSeconds: 2.06,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'pat',
      patternLoopSteps: 16,
      contextCurrentTimeSeconds: 2.0,
    });
    scheduler.scheduleChannelNote({
      channel: chA1,
      note: makeNote(48, { id: 'target-future', duration: 4 }),
      onsetAudioTimeSeconds: 2.06,
      bpm: 120,
      contextCurrentTimeSeconds: 2.0,
    });
    scheduler.scheduleChannelNote({
      channel: chA2,
      note: makeNote(60, { id: 'sibling-future', duration: 1 }),
      onsetAudioTimeSeconds: 2.06,
      bpm: 120,
      contextCurrentTimeSeconds: 2.0,
    });
    scheduler.endTransportStep();

    perfMs = 2010; // both notes still queued in the future at 2060 ms
    scheduler.cleanupChannel('ch-a1');
    assert.equal(portA.clearCalls, 1, 'cleared port-a to cancel ch-a1 queued future Note On');
    const postClearPackets = portA.sent.slice(3); // after initial 3 packets (chA1 On, chA2 On, chA2 Off)
    assert.ok(
      postClearPackets.some(p => p.bytes[0] === 0x96 && p.bytes[1] === 60 && p.timestamp === 2060),
      're-queued ch-a2 future Note On on Ch 7 at exact timestamp 2060 ms',
    );
    assert.ok(
      postClearPackets.some(p => p.bytes[0] === 0x86 && p.bytes[1] === 60 && p.timestamp === 2185),
      're-queued ch-a2 future Note Off on Ch 7 at exact timestamp 2185 ms',
    );
    assert.equal(
      postClearPackets.some(p => p.bytes[0] === 0x83 && p.bytes[1] === 48),
      false,
      'cancelled future ch-a1 Note On never sounded and required no redundant Note Off',
    );
    assert.ok(
      postClearPackets.some(p => p.bytes[0] === 0xb3 && p.bytes[1] === 123 && p.bytes[2] === 0),
      'emitted CC 123 All Notes Off exclusively on Ch 4',
    );
    assert.equal(
      postClearPackets.some(p => p.bytes[0] === 0xb6 && p.bytes[1] === 123),
      false,
      'did not emit CC 123 on sibling Ch 7',
    );
    assert.equal(portB.clearCalls, 0, 'unrelated port-b untouched');
    assert.equal(portB.sent.length, 0, 'unrelated port-b received zero MIDI messages');
  });
});
