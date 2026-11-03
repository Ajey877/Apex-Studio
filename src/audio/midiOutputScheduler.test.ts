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

interface WireQueueMidiPacket extends RecordedMidiPacket {
  sentAtPerfMs: number;
  cancelledByClearAtPerfMs: number | null;
}

class InstrumentedMidiOutputPort implements MidiOutputPortLike {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  state: 'connected' | 'disconnected' = 'connected';
  connection: 'open' | 'closed' | 'pending' = 'open';
  readonly sent: RecordedMidiPacket[] = [];
  readonly wireQueue: WireQueueMidiPacket[] = [];
  clearCalls = 0;
  openCalls = 0;
  readonly supportsClear: boolean;
  private readonly getNowPerfMs: () => number;

  constructor(
    id: string,
    options: {
      name?: string;
      manufacturer?: string;
      state?: 'connected' | 'disconnected';
      connection?: 'open' | 'closed' | 'pending';
      supportsClear?: boolean;
      nowPerfMs?: () => number;
    } = {},
  ) {
    this.id = id;
    this.name = options.name ?? id;
    this.manufacturer = options.manufacturer ?? 'Sequential';
    this.state = options.state ?? 'connected';
    this.connection = options.connection ?? 'open';
    this.supportsClear = options.supportsClear ?? true;
    this.getNowPerfMs = options.nowPerfMs ?? (() => 0);
    if (!this.supportsClear) {
      (this as { clear?: () => void }).clear = undefined;
    }
  }

  send(data: number[] | Uint8Array, timestamp?: number): void {
    if (this.state !== 'connected' || this.connection === 'closed') {
      throw new Error(`Port ${this.id} cannot transmit (${this.state}/${this.connection})`);
    }
    const packetBytes = Array.from(data);
    this.sent.push({ bytes: packetBytes, timestamp });
    this.wireQueue.push({
      bytes: packetBytes,
      timestamp,
      sentAtPerfMs: this.getNowPerfMs(),
      cancelledByClearAtPerfMs: null,
    });
  }

  clear(): void {
    this.clearCalls += 1;
    const now = this.getNowPerfMs();
    for (const pkt of this.wireQueue) {
      if (pkt.cancelledByClearAtPerfMs === null && pkt.timestamp !== undefined && pkt.timestamp > now) {
        pkt.cancelledByClearAtPerfMs = now;
      }
    }
  }

  getDeliveredWirePackets(): WireQueueMidiPacket[] {
    return this.wireQueue.filter(pkt => pkt.cancelledByClearAtPerfMs === null);
  }

  getCancelledWirePackets(): WireQueueMidiPacket[] {
    return this.wireQueue.filter(pkt => pkt.cancelledByClearAtPerfMs !== null);
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

  it('prevents an already-queued short-note Note Off (1125 ms) from prematurely terminating an overlapping fractional-onset Note On (1062.5 ms -> 1187.5 ms)', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-overlap-short', { nowPerfMs: () => perfMs });
    const ports = new Map<string, MidiOutputPortLike>([[port.id, port]]);
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => ports,
    });
    const ch = makeChannel('ch-lead', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });

    // Case A: Step 0 at 120 BPM (125 ms/step).
    // 1. First C4 Note On is scheduled at 1000 ms; its 1-step Note Off is already queued at 1125 ms.
    scheduler.beginTransportTake(1, 'song');
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
      note: makeNote(60, { id: 'c4-first', start: 0, duration: 1, velocity: 0.8 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(port.sent.length, 2, 'first C4 immediately queued Note On (1000 ms) and Note Off (1125 ms)');
    assert.equal(port.sent[0].timestamp, 1000);
    assert.equal(port.sent[1].timestamp, 1125);

    // 2. Second C4 Note On arrives at 1062.5 ms (fractional 0.5-step onset) with intended release at 1187.5 ms.
    const secondRes = scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'c4-second', start: 0.5, duration: 1, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.deepEqual(secondRes, { sent: true });
    scheduler.endTransportStep();

    assert.equal(port.clearCalls, 1, 'cleared pending 1125 ms Note Off from port queue');
    const cancelled = port.getCancelledWirePackets();
    assert.equal(cancelled.length, 1);
    assert.deepEqual(cancelled[0].bytes, [0x80, 60, 0]);
    assert.equal(cancelled[0].timestamp, 1125, 'exact stale 1125 ms Note Off was cancelled before firing');

    // 3. Step 1 (1125 ms) enters bounded horizon and queues the intended 1187.5 ms Note Off.
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
    scheduler.endTransportStep();

    const delivered = port.getDeliveredWirePackets();
    assert.equal(delivered.length, 4, 'exact 4 MIDI events delivered on wire (2 Note Ons, 2 Note Offs)');
    assert.deepEqual(
      delivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, Math.round(0.8 * 127)], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1062.5 },
        { bytes: [0x90, 60, Math.round(0.9 * 127)], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1187.5 },
      ],
    );

    perfMs = 1200;
    assert.equal(scheduler.getActiveNoteCount(), 0, 'zero stuck notes after 1187.5 ms release');

    // Case B: Look-ahead pass (perfMs = 980 ms) where First C4 Note On (1000 ms) is ALSO still pending
    // in the Web MIDI queue when the overlapping 1062.5 ms Note On triggers port.clear().
    port.sent.length = 0;
    port.wireQueue.length = 0;
    port.clearCalls = 0;
    perfMs = 980;

    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0.02, // +20 ms look-ahead -> 1000 ms
      unswungStepAudioTimeSeconds: 0.02,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'c4-la-1', start: 0, duration: 1, velocity: 0.8 }),
      onsetAudioTimeSeconds: 0.02,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'c4-la-2', start: 0.5, duration: 1, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0.0825, // +82.5 ms -> 1062.5 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 1105;
    scheduler.beginTransportStep({
      takeGeneration: 2,
      absoluteStep: 1,
      step: 1,
      stepAudioTimeSeconds: 0.145, // -> 1125 ms
      unswungStepAudioTimeSeconds: 0.145,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0.125,
    });
    scheduler.endTransportStep();

    const lookAheadDelivered = port.getDeliveredWirePackets();
    assert.deepEqual(
      lookAheadDelivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, Math.round(0.8 * 127)], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1062.5 },
        { bytes: [0x90, 60, Math.round(0.9 * 127)], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1187.5 },
      ],
    );
  });

  it('protects shared physical output ports during overlap clear() by preserving sibling channels queued Note Ons, Note Offs, and CCs at exact original timestamps', () => {
    let perfMs = 950;
    const sharedPort = new InstrumentedMidiOutputPort('hw-shared', { nowPerfMs: () => perfMs });
    const otherPort = new InstrumentedMidiOutputPort('hw-other', { nowPerfMs: () => perfMs });
    const ports = new Map<string, MidiOutputPortLike>([
      [sharedPort.id, sharedPort],
      [otherPort.id, otherPort],
    ]);
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => ports,
    });

    const chLead = makeChannel('ch-lead', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
    });
    const chSibling = makeChannel('ch-sibling', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 2 },
    });
    const chOtherPort = makeChannel('ch-other-port', {
      midiOutput: { mode: 'external', outputDeviceId: otherPort.id, midiChannel: 10 },
    });

    // 1. At 950 ms, schedule a preview/live-style note on chSibling (MIDI Ch 2) that is ALREADY sounding
    //    by 980 ms (onPerfMs = 950 <= 980) with a pending future Note Off at 1075 ms (> 980).
    scheduler.scheduleChannelNote({
      channel: chSibling,
      note: makeNote(55, { id: 'sib-sounding', start: 0, duration: 1, velocity: 0.75 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120, // 1 step = 125 ms -> Note Off at 1075 ms
      contextCurrentTimeSeconds: 0,
    });

    // 2. Advance to 980 ms (20 ms look-ahead before Step 0 at 1000 ms).
    perfMs = 980;
    scheduler.beginTransportTake(1, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0.05, // ctxCurrent = 0.03 -> +20 ms -> 1000 ms
      unswungStepAudioTimeSeconds: 0.05,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0.03,
    });

    // Sibling channel schedules a future look-ahead Note On (1010 ms) + Note Off (1135 ms) AND a future CC 74 (1040 ms) on MIDI Ch 2,
    // while unrelated port schedules a hit on MIDI Ch 10.
    scheduler.scheduleChannelNote({
      channel: chSibling,
      note: makeNote(64, { id: 'sib-future', start: 0.08, duration: 1, velocity: 0.85 }),
      onsetAudioTimeSeconds: 0.06, // -> 1010 ms, Note Off -> 1135 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0.03,
    });
    scheduler.sendChannelControlChange(chSibling, 74, 96, 0.09, 0.03); // -> 1040 ms
    scheduler.scheduleChannelNote({
      channel: chOtherPort,
      note: makeNote(36, { id: 'kick-other', start: 0, duration: 1, velocity: 1.0 }),
      onsetAudioTimeSeconds: 0.05, // -> 1000 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0.03,
    });

    // Target channel (MIDI Ch 1) schedules overlapping C4 notes: 1000 -> 1125 ms, then 1062.5 -> 1187.5 ms.
    scheduler.scheduleChannelNote({
      channel: chLead,
      note: makeNote(60, { id: 'lead-c4-1', start: 0, duration: 1, velocity: 0.8 }),
      onsetAudioTimeSeconds: 0.05, // -> 1000 ms, Note Off -> 1125 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0.03,
    });
    scheduler.scheduleChannelNote({
      channel: chLead,
      note: makeNote(60, { id: 'lead-c4-2', start: 0.5, duration: 1, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0.1125, // -> 1062.5 ms, intended Note Off -> 1187.5 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0.03,
    });
    scheduler.endTransportStep();

    // Advance to Step 1 so chLead's 1187.5 ms Note Off enters the horizon.
    perfMs = 1105;
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 1,
      step: 1,
      stepAudioTimeSeconds: 0.175, // -> 1125 ms
      unswungStepAudioTimeSeconds: 0.175,
      grooveOffsetSeconds: 0,
      bpm: 120,
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0.155,
    });
    scheduler.endTransportStep();

    assert.equal(sharedPort.clearCalls, 1, 'sharedPort cleared once during overlap cancellation');
    assert.equal(otherPort.clearCalls, 0, 'unrelated physical port never cleared');

    const deliveredShared = sharedPort.getDeliveredWirePackets();
    const ch1Packets = deliveredShared.filter(p => (p.bytes[0] & 0x0f) === 0);
    const ch2Packets = deliveredShared.filter(p => (p.bytes[0] & 0x0f) === 1);

    // MIDI Ch 1 (chLead): exact overlap resolution, stale 1125 ms Note Off absent.
    assert.deepEqual(
      ch1Packets.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, Math.round(0.8 * 127)], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1062.5 },
        { bytes: [0x90, 60, Math.round(0.9 * 127)], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1187.5 },
      ],
    );

    // MIDI Ch 2 (chSibling): zero lost or duplicated Note Ons, Note Offs, or CCs; exact original timestamps preserved.
    assert.deepEqual(
      ch2Packets.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x91, 55, Math.round(0.75 * 127)], timestamp: 950 },
        { bytes: [0x91, 64, Math.round(0.85 * 127)], timestamp: 1010 },
        { bytes: [0xb1, 74, 96], timestamp: 1040 },
        { bytes: [0x81, 55, 0], timestamp: 1075 },
        { bytes: [0x81, 64, 0], timestamp: 1135 },
      ],
    );
  });

  it('handles ports without MIDIOutput.clear() honestly without falsely claiming a pre-queued Note Off was cancelled', () => {
    let perfMs = 1000;
    const noClearPort = new InstrumentedMidiOutputPort('hw-no-clear', {
      supportsClear: false,
      nowPerfMs: () => perfMs,
    });
    const ports = new Map<string, MidiOutputPortLike>([[noClearPort.id, noClearPort]]);
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => ports,
    });
    const ch = makeChannel('ch-legacy', {
      midiOutput: { mode: 'external', outputDeviceId: noClearPort.id, midiChannel: 1 },
    });

    scheduler.beginTransportTake(1, 'song');
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

    const firstRes = scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'nc-1', start: 0, duration: 1, velocity: 0.8 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.deepEqual(firstRes, { sent: true });

    const secondRes = scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'nc-2', start: 0.5, duration: 1, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    assert.equal(noClearPort.clearCalls, 0, 'never invokes missing clear()');
    assert.deepEqual(
      secondRes,
      {
        sent: true,
        uncancelledQueuedNoteOff: true,
        effectiveReleasePerfMs: 1125,
      },
      'honestly reports that the pre-queued 1125 ms Note Off could not be cancelled without MIDIOutput.clear()',
    );

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
    scheduler.endTransportStep();

    const noteOns = noClearPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x90);
    const noteOffs = noClearPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x80);
    assert.equal(noteOns.length, 2, '2 Note Ons transmitted');
    assert.equal(noteOffs.length, 2, 'strict 1:1 Note Off parity — no orphan 3rd Note Off queued at 1187.5 ms');
    assert.deepEqual(
      noteOffs.map(p => p.timestamp).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [1062.5, 1125],
    );

    perfMs = 1200;
    assert.equal(scheduler.getActiveNoteCount(), 0, 'zero stuck notes after uncancelled 1125 ms cutoff');
  });

  it('preserves future Note Ons and velocities when overlapping same-pitch notes are scheduled in reverse chronological order (1100->1225 ms then 1062.5->1187.5 ms)', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-reverse-order', { nowPerfMs: () => perfMs });
    const ports = new Map<string, MidiOutputPortLike>([[port.id, port]]);
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => ports,
    });
    const ch = makeChannel('ch-reverse', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });

    const velLater = Math.round(0.7 * 127); // 89
    const velEarlier = Math.round(0.95 * 127); // 121

    scheduler.beginTransportTake(1, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 1,
      absoluteStep: 0,
      step: 0,
      stepAudioTimeSeconds: 0,
      unswungStepAudioTimeSeconds: 0,
      grooveOffsetSeconds: 0,
      bpm: 120, // 1 sixteenth step = 125 ms
      mode: 'song',
      patternLoopSteps: null,
      contextCurrentTimeSeconds: 0,
    });

    // 1. First submitted: LATER musical note (C4, Ch 1, onset 1100 ms, duration 1 step, intended release 1225 ms).
    const firstRes = scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'c4-later-1100', start: 0.8, duration: 1, velocity: 0.7 }),
      onsetAudioTimeSeconds: 0.1, // 1000 + 100 = 1100 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.deepEqual(firstRes, { sent: true });
    assert.deepEqual(
      port.sent.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, velLater], timestamp: 1100 },
        { bytes: [0x80, 60, 0], timestamp: 1225 },
      ],
      'later musical note (1100 -> 1225 ms) queued both its Note On and Note Off first',
    );

    // 2. Second submitted: EARLIER musical note (C4, Ch 1, onset 1062.5 ms, duration 1 step, intended release 1187.5 ms).
    const secondRes = scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'c4-earlier-1062_5', start: 0.5, duration: 1, velocity: 0.95 }),
      onsetAudioTimeSeconds: 0.0625, // 1000 + 62.5 = 1062.5 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.deepEqual(secondRes, { sent: true });
    scheduler.endTransportStep();

    assert.equal(port.clearCalls, 1, 'physical port queue cleared once to reorder reverse-arriving segment');
    assert.equal(
      port.getCancelledWirePackets().length,
      2,
      'initial pre-clear 1100 ms / 1225 ms queue entries were cleared before canonical re-emission',
    );

    // Advance through Step 1 (1125 ms) and verify zero extra/duplicate emissions.
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
    scheduler.endTransportStep();

    const delivered = port.getDeliveredWirePackets();
    assert.deepEqual(
      delivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, velEarlier], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1100 },
        { bytes: [0x90, 60, velLater], timestamp: 1100 },
        { bytes: [0x80, 60, 0], timestamp: 1225 },
      ],
      'both Note Ons survive with original velocities, retrigger Note Off precedes Note On at 1100 ms, and obsolete 1187.5 ms Note Off is absent',
    );

    perfMs = 1250;
    assert.equal(scheduler.getActiveNoteCount(), 0, 'zero active notes after 1225 ms completion');

    // Also verify reverse-order when the earlier note is a 4-step sustained note (1062.5 -> 1562.5 ms)
    // submitted AFTER the shorter later note (1100 -> 1225 ms): merged 4-step sustain carries forward!
    port.sent.length = 0;
    port.wireQueue.length = 0;
    port.clearCalls = 0;
    perfMs = 2000;

    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
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
      note: makeNote(60, { id: 'rev-short-late', start: 0.8, duration: 1, velocity: 0.65 }),
      onsetAudioTimeSeconds: 0.1, // -> 2100..2225 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: ch,
      note: makeNote(60, { id: 'rev-long-early', start: 0.5, duration: 4, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0.0625, // -> 2062.5..2562.5 ms (releaseStep = 4.5)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 2000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 2,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }

    assert.deepEqual(
      port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, Math.round(0.9 * 127)], timestamp: 2062.5 },
        { bytes: [0x80, 60, 0], timestamp: 2100 },
        { bytes: [0x90, 60, Math.round(0.65 * 127)], timestamp: 2100 },
        { bytes: [0x80, 60, 0], timestamp: 2562.5 },
      ],
      'reverse-order long-note envelope propagates cleanly onto the surviving 2100 ms segment',
    );
    perfMs = 2600;
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('produces identical wire output across all 6 mixed array-order permutations of three overlapping same-pitch notes', () => {
    const permutations: ReadonlyArray<readonly [number, number, number]> = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    for (const [longFirstNote] of [[false], [true]] as const) {
      const expectedFinalOffMs = longFirstNote ? 1500 : 1225;
      for (const perm of permutations) {
        let perfMs = 980; // 20 ms look-ahead before Step 0 at 1000 ms
        const port = new InstrumentedMidiOutputPort(`hw-perm-${perm.join('')}`, { nowPerfMs: () => perfMs });
        const ports = new Map<string, MidiOutputPortLike>([[port.id, port]]);
        const scheduler = new MidiOutputScheduler({
          performanceNowMs: () => perfMs,
          getOutputs: () => ports,
        });
        const ch = makeChannel('ch-3note', {
          midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
        });

        const specs = [
          {
            note: makeNote(60, {
              id: 'n-earliest',
              start: 0,
              duration: longFirstNote ? 4 : 1,
              velocity: 70 / 127,
            }),
            onsetAudio: 0.02, // -> 1000 ms
          },
          {
            note: makeNote(60, {
              id: 'n-middle',
              start: 0.5,
              duration: 1,
              velocity: 95 / 127,
            }),
            onsetAudio: 0.0825, // -> 1062.5 ms
          },
          {
            note: makeNote(60, {
              id: 'n-latest',
              start: 0.8,
              duration: 1,
              velocity: 120 / 127,
            }),
            onsetAudio: 0.12, // -> 1100 ms
          },
        ] as const;

        scheduler.beginTransportTake(1, 'song');
        scheduler.beginTransportStep({
          takeGeneration: 1,
          absoluteStep: 0,
          step: 0,
          stepAudioTimeSeconds: 0.02,
          unswungStepAudioTimeSeconds: 0.02,
          grooveOffsetSeconds: 0,
          bpm: 120,
          mode: 'song',
          patternLoopSteps: null,
          contextCurrentTimeSeconds: 0,
        });
        for (const idx of perm) {
          const item = specs[idx];
          const res = scheduler.scheduleChannelNote({
            channel: ch,
            note: item.note,
            onsetAudioTimeSeconds: item.onsetAudio,
            bpm: 120,
            contextCurrentTimeSeconds: 0,
          });
          assert.deepEqual(res, { sent: true });
        }
        scheduler.endTransportStep();

        for (const stepIdx of [1, 2, 3]) {
          perfMs = 980 + stepIdx * 125;
          scheduler.beginTransportStep({
            takeGeneration: 1,
            absoluteStep: stepIdx,
            step: stepIdx,
            stepAudioTimeSeconds: 0.02 + stepIdx * 0.125,
            unswungStepAudioTimeSeconds: 0.02 + stepIdx * 0.125,
            grooveOffsetSeconds: 0,
            bpm: 120,
            mode: 'song',
            patternLoopSteps: null,
            contextCurrentTimeSeconds: stepIdx * 0.125,
          });
          scheduler.endTransportStep();
        }

        const delivered = port.getDeliveredWirePackets();
        assert.deepEqual(
          delivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
          [
            { bytes: [0x90, 60, 70], timestamp: 1000 },
            { bytes: [0x80, 60, 0], timestamp: 1062.5 },
            { bytes: [0x90, 60, 95], timestamp: 1062.5 },
            { bytes: [0x80, 60, 0], timestamp: 1100 },
            { bytes: [0x90, 60, 120], timestamp: 1100 },
            { bytes: [0x80, 60, 0], timestamp: expectedFinalOffMs },
          ],
          `permutation [${perm.join(', ')}] (longFirst=${longFirstNote}) produced canonical 3-note sequence`,
        );

        perfMs = expectedFinalOffMs + 50;
        assert.equal(scheduler.getActiveNoteCount(), 0);
      }
    }
  });

  it('isolates future same-pitch notes across different DAW channels on shared and independent ports while preserving sibling Note Ons, Note Offs, and CCs', () => {
    let perfMs = 950;
    const sharedPort = new InstrumentedMidiOutputPort('hw-shared-rev', { nowPerfMs: () => perfMs });
    const independentPort = new InstrumentedMidiOutputPort('hw-indep-rev', { nowPerfMs: () => perfMs });
    const ports = new Map<string, MidiOutputPortLike>([
      [sharedPort.id, sharedPort],
      [independentPort.id, independentPort],
    ]);
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => ports,
    });

    // Sub-case A: Different DAW channels sharing `sharedPort` on DIFFERENT MIDI channels, both playing pitch C4 (60)!
    const chLeadCh1 = makeChannel('ch-lead-ch1', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
    });
    const chSiblingCh2 = makeChannel('ch-sibling-ch2', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 2 },
    });
    const chIndepCh10 = makeChannel('ch-indep-ch10', {
      midiOutput: { mode: 'external', outputDeviceId: independentPort.id, midiChannel: 10 },
    });

    // Already-sounding G3 (55) on sibling MIDI Ch 2 (started at 950 ms, Note Off queued for 1075 ms)
    scheduler.scheduleChannelNote({
      channel: chSiblingCh2,
      note: makeNote(55, { id: 'sib-g3', start: 0, duration: 1, velocity: 80 / 127 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });

    perfMs = 1000;
    scheduler.beginTransportTake(1, 'song');
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

    // Sibling DAW channel on MIDI Ch 2 queues a FUTURE SAME-PITCH C4 (60) at 1080..1205 ms + future CC 1 at 1090 ms
    scheduler.scheduleChannelNote({
      channel: chSiblingCh2,
      note: makeNote(60, { id: 'sib-c4', start: 0.64, duration: 1, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0.08, // -> 1080..1205 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.sendChannelControlChange(chSiblingCh2, 1, 84, 0.09, 0); // -> 1090 ms

    // Independent port queues same-pitch C4 on MIDI Ch 10
    scheduler.scheduleChannelNote({
      channel: chIndepCh10,
      note: makeNote(60, { id: 'indep-c4', start: 0.5, duration: 1, velocity: 110 / 127 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });

    // Target DAW channel on MIDI Ch 1 schedules reverse-order C4 overlap (1100..1225 then 1062.5..1187.5)
    scheduler.scheduleChannelNote({
      channel: chLeadCh1,
      note: makeNote(60, { id: 'lead-late', start: 0.8, duration: 1, velocity: 89 / 127 }),
      onsetAudioTimeSeconds: 0.1,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chLeadCh1,
      note: makeNote(60, { id: 'lead-early', start: 0.5, duration: 1, velocity: 121 / 127 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    assert.equal(sharedPort.clearCalls, 1);
    assert.equal(independentPort.clearCalls, 0, 'independent physical port never cleared');

    const deliveredShared = sharedPort.getDeliveredWirePackets();
    const ch1Wire = deliveredShared.filter(p => (p.bytes[0] & 0x0f) === 0);
    const ch2Wire = deliveredShared.filter(p => (p.bytes[0] & 0x0f) === 1);

    assert.deepEqual(
      ch1Wire.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 121], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1100 },
        { bytes: [0x90, 60, 89], timestamp: 1100 },
        { bytes: [0x80, 60, 0], timestamp: 1225 },
      ],
    );
    assert.deepEqual(
      ch2Wire.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x91, 55, 80], timestamp: 950 },
        { bytes: [0x81, 55, 0], timestamp: 1075 },
        { bytes: [0x91, 60, 100], timestamp: 1080 },
        { bytes: [0xb1, 1, 84], timestamp: 1090 },
        { bytes: [0x81, 60, 0], timestamp: 1205 },
      ],
      'sibling MIDI Ch 2 preserved same-pitch C4 (1080->1205 ms), G3 Note Off (1075 ms), and CC 1 (1090 ms) at exact timestamps',
    );

    perfMs = 1300;
    assert.equal(scheduler.getActiveNoteCount(), 0);

    // Sub-case B: Two DIFFERENT DAW channels layered onto the SAME port AND SAME MIDI channel (Ch 1),
    // scheduling overlapping future C4 notes in reverse order, followed by muting the earlier DAW channel!
    sharedPort.sent.length = 0;
    sharedPort.wireQueue.length = 0;
    sharedPort.clearCalls = 0;
    perfMs = 2000;

    const chLayerLate = makeChannel('ch-layer-late', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
    });
    const chLayerEarly = makeChannel('ch-layer-early', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
    });

    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
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
      channel: chLayerLate,
      note: makeNote(60, { id: 'layer-late', start: 0.8, duration: 1, velocity: 88 / 127 }),
      onsetAudioTimeSeconds: 0.1, // -> 2100..2225 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chLayerEarly,
      note: makeNote(60, { id: 'layer-early', start: 0.5, duration: 1, velocity: 116 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 2062.5..2187.5 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    // At 2020 ms (before either future note has sounded), mute `ch-layer-early`:
    // `ch-layer-early`'s [2062.5..2100] segment is cancelled while `ch-layer-late`'s [2100..2225] survives!
    perfMs = 2020;
    scheduler.cleanupChannel('ch-layer-early');

    const postMuteDelivered = sharedPort.getDeliveredWirePackets();
    assert.deepEqual(
      postMuteDelivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 88], timestamp: 2100 },
        { bytes: [0x80, 60, 0], timestamp: 2225 },
      ],
      'per-DAW-channel ownership preserved: muting ch-layer-early left ch-layer-late future C4 (2100->2225 ms) intact without emitting CC 123 on shared Ch 1',
    );
    perfMs = 2250;
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('handles reverse-order same-pitch overlaps honestly on ports without MIDIOutput.clear() and guarantees Note Off precedes Note On at simultaneous boundaries', () => {
    // 1. Port without `clear()` under reverse-order scheduling:
    let perfMs = 1000;
    const noClearPort = new InstrumentedMidiOutputPort('hw-rev-noclear', {
      supportsClear: false,
      nowPerfMs: () => perfMs,
    });
    const schedulerNoClear = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[noClearPort.id, noClearPort]]),
    });
    const chNoClear = makeChannel('ch-rev-noclear', {
      midiOutput: { mode: 'external', outputDeviceId: noClearPort.id, midiChannel: 1 },
    });

    // Sub-test 1a: 1100->1225 queued first, then 1062.5->1187.5 queued second on clear-less port
    schedulerNoClear.beginTransportTake(1, 'song');
    schedulerNoClear.beginTransportStep({
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
    schedulerNoClear.scheduleChannelNote({
      channel: chNoClear,
      note: makeNote(60, { id: 'nc-rev-late', start: 0.8, duration: 1, velocity: 89 / 127 }),
      onsetAudioTimeSeconds: 0.1,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    const revShortRes = schedulerNoClear.scheduleChannelNote({
      channel: chNoClear,
      note: makeNote(60, { id: 'nc-rev-early-short', start: 0.5, duration: 1, velocity: 121 / 127 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    schedulerNoClear.endTransportStep();

    assert.equal(noClearPort.clearCalls, 0);
    assert.deepEqual(revShortRes, { sent: true });
    const ncOns1 = noClearPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x90);
    const ncOffs1 = noClearPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x80);
    assert.equal(ncOns1.length, 2, 'both Note Ons preserved on clear-less port');
    assert.equal(ncOffs1.length, 2, 'strict 1:1 Note Off parity — obsolete 1187.5 ms Note Off never sent');
    const preBoundaryOff = ncOffs1.find(p => p.timestamp !== 1225)!;
    assert.ok(
      preBoundaryOff.timestamp! > 1062.5 && preBoundaryOff.timestamp! < 1100,
      'retrigger Note Off placed strictly prior to 1100 ms so clear-less FIFO cannot silence the 1100 ms attack',
    );
    perfMs = 1250;
    assert.equal(schedulerNoClear.getActiveNoteCount(), 0);

    // Sub-test 1b: 2100->2225 queued first, then longer 2062.5->2562.5 queued second on clear-less port:
    // already-queued 2225 ms Note Off cannot be cancelled without clear() -> reported honestly!
    noClearPort.sent.length = 0;
    perfMs = 2000;
    schedulerNoClear.beginTransportTake(2, 'song');
    schedulerNoClear.beginTransportStep({
      takeGeneration: 2,
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
    schedulerNoClear.scheduleChannelNote({
      channel: chNoClear,
      note: makeNote(60, { id: 'nc-rev-late-2', start: 0.8, duration: 1, velocity: 89 / 127 }),
      onsetAudioTimeSeconds: 0.1, // -> 2100..2225 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    const revLongRes = schedulerNoClear.scheduleChannelNote({
      channel: chNoClear,
      note: makeNote(60, { id: 'nc-rev-early-long', start: 0.5, duration: 4, velocity: 121 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // intended 2062.5..2562.5 ms, but 2225 ms is already queued!
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    schedulerNoClear.endTransportStep();

    assert.deepEqual(
      revLongRes,
      {
        sent: true,
        uncancelledQueuedNoteOff: true,
        effectiveReleasePerfMs: 2225,
      },
      'honestly reports that pre-queued 2225 ms Note Off could not be cancelled without MIDIOutput.clear()',
    );
    perfMs = 2300;
    assert.equal(schedulerNoClear.getActiveNoteCount(), 0);

    // 2. Simultaneous timestamp ordering (Note Off strictly before Note On) on clear()-capable port:
    let simPerfMs = 980;
    const simPort = new InstrumentedMidiOutputPort('hw-sim-boundary', { nowPerfMs: () => simPerfMs });
    const simScheduler = new MidiOutputScheduler({
      performanceNowMs: () => simPerfMs,
      getOutputs: () => new Map([[simPort.id, simPort]]),
    });
    const simCh = makeChannel('ch-sim', {
      midiOutput: { mode: 'external', outputDeviceId: simPort.id, midiChannel: 1 },
    });

    // Reverse-order adjacent legato notes sharing exact boundary 1125 ms:
    // [1125 -> 1250 ms] scheduled FIRST, then [1000 -> 1125 ms] scheduled SECOND!
    simScheduler.scheduleChannelNote({
      channel: simCh,
      note: makeNote(60, { id: 'adj-second', start: 1, duration: 1, velocity: 90 / 127 }),
      onsetAudioTimeSeconds: 0.145, // -> 1125..1250 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    simScheduler.scheduleChannelNote({
      channel: simCh,
      note: makeNote(60, { id: 'adj-first', start: 0, duration: 1, velocity: 115 / 127 }),
      onsetAudioTimeSeconds: 0.02, // -> 1000..1125 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });

    const simDelivered = simPort.getDeliveredWirePackets();
    assert.deepEqual(
      simDelivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 115], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1125 },
        { bytes: [0x90, 60, 90], timestamp: 1125 },
        { bytes: [0x80, 60, 0], timestamp: 1250 },
      ],
      'at simultaneous timestamp 1125 ms, Note Off (0x80) is strictly queued before Note On (0x90)',
    );

    // Simultaneous future unison notes at exact same onset (1080 ms > simPerfMs) deduplicate cleanly
    // while keeping the longer intended release:
    simPort.sent.length = 0;
    simPort.wireQueue.length = 0;
    simPerfMs = 2000;
    simScheduler.scheduleChannelNote({
      channel: simCh,
      note: makeNote(64, { id: 'unison-long', start: 0, duration: 2, velocity: 80 / 127 }),
      onsetAudioTimeSeconds: 0.08, // -> 2080..2330 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    simScheduler.scheduleChannelNote({
      channel: simCh,
      note: makeNote(64, { id: 'unison-short', start: 0, duration: 1, velocity: 112 / 127 }),
      onsetAudioTimeSeconds: 0.08, // -> 2080..2205 ms (merged to 2330 ms!)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });

    assert.deepEqual(
      simPort.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 64, 112], timestamp: 2080 },
        { bytes: [0x80, 64, 0], timestamp: 2330 },
      ],
    );
    simPerfMs = 2400;
    assert.equal(simScheduler.getActiveNoteCount(), 0, 'zero stuck notes after all releases');
  });

  it('preserves per-channel release ownership (Long A 1000->1500 ms, Short B 1062.5->1187.5 ms): removing A releases B at 1187.5 ms, not 1500 ms', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-ownership-long-short', {
      nowPerfMs: () => perfMs,
    });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const chA = makeChannel('ch-a', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });
    const chB = makeChannel('ch-b', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });

    // Subcase A: Mute/reroute Channel A at 1100 ms (after B's 1062.5 ms attack, before B's 1187.5 ms release)
    scheduler.beginTransportTake(1, 'song');
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
      channel: chA,
      note: makeNote(60, { id: 'long-a', start: 0, duration: 4, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0, // -> 1000..1500 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chB,
      note: makeNote(60, { id: 'short-b', start: 0.5, duration: 1, velocity: 112 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 1062.5..1187.5 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    assert.equal(scheduler.getActiveNoteCount('ch-a'), 1);
    assert.equal(scheduler.getActiveNoteCount('ch-b'), 1);

    // At 1100 ms: B is actively sounding; mute Channel A via reconcileChannels
    perfMs = 1100;
    const chAMuted: Channel = { ...chA, mute: true };
    scheduler.reconcileChannels([chA, chB], [chAMuted, chB], c => !c.mute);

    assert.equal(scheduler.getActiveNoteCount('ch-a'), 0, 'Channel A contributor removed');
    assert.equal(scheduler.getActiveNoteCount('ch-b'), 1, 'Channel B contributor remains active until 1187.5 ms');
    assert.equal(
      port.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123),
      false,
      'must not send CC 123 while Channel B still owns an active note on MIDI Ch 1',
    );

    // Advance through steps 1..4 to verify no trailing 1500 ms Note Off ever fires
    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 1000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
      if (stepIdx === 2) {
        // 1250 ms > 1187.5 ms: B must already be completely released!
        assert.equal(scheduler.getActiveNoteCount(), 0, 'B already released before 1250 ms');
      }
    }

    const deliveredA = port.getDeliveredWirePackets();
    assert.deepEqual(
      deliveredA.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 100], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1062.5 },
        { bytes: [0x90, 60, 112], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1187.5 },
      ],
      'B releases at its own 1187.5 ms timestamp (not A inherited 1500 ms) with exact 1:1 Note Off parity',
    );

    // Subcase B: Reroute Channel A at 1030 ms (while A is sounding, before B's 1062.5 ms attack)
    port.sent.length = 0;
    port.wireQueue.length = 0;
    port.clearCalls = 0;
    perfMs = 2000;

    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
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
      channel: chA,
      note: makeNote(60, { id: 'long-a2', start: 0, duration: 4, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0, // -> 2000..2500 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chB,
      note: makeNote(60, { id: 'short-b2', start: 0.5, duration: 1, velocity: 112 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 2062.5..2187.5 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 2030;
    const chARerouted: Channel = {
      ...chA,
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 5 },
    };
    scheduler.reconcileChannels([chA, chB], [chARerouted, chB], c => !c.mute);

    assert.equal(scheduler.getActiveNoteCount('ch-a'), 0);
    assert.equal(scheduler.getActiveNoteCount('ch-b'), 1);
    assert.equal(
      port.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123),
      false,
      'no CC 123 on MIDI Ch 1 while B owns upcoming 2062.5 ms note',
    );

    const deliveredB = port.getDeliveredWirePackets();
    assert.deepEqual(
      deliveredB.map(p => ({ bytes: p.bytes, timestamp: p.timestamp ?? 2030 })),
      [
        { bytes: [0x90, 60, 100], timestamp: 2000 },
        { bytes: [0x80, 60, 0], timestamp: 2030 },
        { bytes: [0x90, 60, 112], timestamp: 2062.5 },
        { bytes: [0x80, 60, 0], timestamp: 2187.5 },
      ],
      'A stops immediately at 2030 ms, stale 2062.5 ms Note Off is cancelled, and B plays 2062.5->2187.5 ms with 1:1 Note Off parity',
    );
    perfMs = 2200;
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('preserves inverse release ownership: removing the shorter contributor keeps the longer surviving note release intact', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-inverse-ownership', {
      nowPerfMs: () => perfMs,
    });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const chA = makeChannel('ch-short-a', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });
    const chB = makeChannel('ch-long-b', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });

    // Subcase 1: Short A (1000->1125 ms) + Long B (1062.5->1562.5 ms); remove shorter A at 1080 ms
    scheduler.beginTransportTake(1, 'song');
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
      channel: chA,
      note: makeNote(60, { id: 'inv-short-a', start: 0, duration: 1, velocity: 96 / 127 }),
      onsetAudioTimeSeconds: 0, // -> 1000..1125 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chB,
      note: makeNote(60, { id: 'inv-long-b', start: 0.5, duration: 4, velocity: 118 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 1062.5..1562.5 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 1080;
    scheduler.cleanupChannel('ch-short-a');
    assert.equal(scheduler.getActiveNoteCount('ch-short-a'), 0);
    assert.equal(scheduler.getActiveNoteCount('ch-long-b'), 1);

    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 1000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }

    assert.deepEqual(
      port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 96], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1062.5 },
        { bytes: [0x90, 60, 118], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1562.5 },
      ],
      'longer later-arriving B retains its full 1562.5 ms release after shorter A is removed',
    );
    perfMs = 1600;
    assert.equal(scheduler.getActiveNoteCount(), 0);

    // Subcase 2: Long A (2000->2500 ms) + Short B (2062.5->2187.5 ms); remove shorter B at 2100 ms (after B retriggered!)
    // Surviving Long A must still extend the physical voice until 2500 ms without premature cutoff!
    port.sent.length = 0;
    port.wireQueue.length = 0;
    port.clearCalls = 0;
    perfMs = 2000;

    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
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
      channel: chB, // chB plays long 2000->2500
      note: makeNote(60, { id: 'inv2-long-early', start: 0, duration: 4, velocity: 104 / 127 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chA, // chA plays short 2062.5->2187.5
      note: makeNote(60, { id: 'inv2-short-late', start: 0.5, duration: 1, velocity: 90 / 127 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 2100;
    scheduler.cleanupChannel('ch-short-a');
    assert.equal(scheduler.getActiveNoteCount('ch-short-a'), 0);
    assert.equal(scheduler.getActiveNoteCount('ch-long-b'), 1, 'surviving long contributor reclaims open voice');

    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 2000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 2,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }

    assert.deepEqual(
      port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 104], timestamp: 2000 },
        { bytes: [0x80, 60, 0], timestamp: 2062.5 },
        { bytes: [0x90, 60, 90], timestamp: 2062.5 },
        { bytes: [0x80, 60, 0], timestamp: 2500 },
      ],
      'removing shorter B mid-voice allows surviving Long A to keep extending the voice to 2500 ms with 1:1 Note Off parity',
    );
    perfMs = 2550;
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('preserves per-channel release ownership when overlapping notes are submitted in reverse chronological order', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-reverse-ownership', {
      nowPerfMs: () => perfMs,
    });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const chA = makeChannel('ch-rev-a', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });
    const chB = makeChannel('ch-rev-b', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });

    // Subcase 1 (Reverse Long A + Short B): Submit Short B (1062.5->1187.5 ms) FIRST, then Long A (1000->1500 ms) SECOND!
    scheduler.beginTransportTake(1, 'song');
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
      channel: chB,
      note: makeNote(60, { id: 'rev-own-b', start: 0.5, duration: 1, velocity: 112 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 1062.5..1187.5 ms (queued FIRST)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chA,
      note: makeNote(60, { id: 'rev-own-a', start: 0, duration: 4, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0, // -> 1000..1500 ms (submitted SECOND)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 1100;
    scheduler.cleanupChannel('ch-rev-a');
    assert.equal(scheduler.getActiveNoteCount('ch-rev-a'), 0);
    assert.equal(scheduler.getActiveNoteCount('ch-rev-b'), 1);

    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 1000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }

    assert.deepEqual(
      port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 100], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1062.5 },
        { bytes: [0x90, 60, 112], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1187.5 },
      ],
      'reverse-scheduled Short B releases at its own 1187.5 ms after Long A is removed',
    );
    perfMs = 1200;
    assert.equal(scheduler.getActiveNoteCount(), 0);

    // Subcase 2 (Reverse Inverse Ownership): Submit Long B (2100->2600 ms) FIRST, then Short A (2062.5->2187.5 ms) SECOND;
    // remove Short A at 2120 ms -> Long B must retain 2600 ms!
    port.sent.length = 0;
    port.wireQueue.length = 0;
    port.clearCalls = 0;
    perfMs = 2000;

    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
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
      channel: chB,
      note: makeNote(60, { id: 'rev-inv-b', start: 0.8, duration: 4, velocity: 115 / 127 }),
      onsetAudioTimeSeconds: 0.1, // -> 2100..2600 ms (submitted FIRST)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chA,
      note: makeNote(60, { id: 'rev-inv-a', start: 0.5, duration: 1, velocity: 92 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 2062.5..2187.5 ms (submitted SECOND)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 2120;
    scheduler.cleanupChannel('ch-rev-a');
    assert.equal(scheduler.getActiveNoteCount('ch-rev-a'), 0);
    assert.equal(scheduler.getActiveNoteCount('ch-rev-b'), 1);

    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 2000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 2,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }

    assert.deepEqual(
      port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 92], timestamp: 2062.5 },
        { bytes: [0x80, 60, 0], timestamp: 2100 },
        { bytes: [0x90, 60, 115], timestamp: 2100 },
        { bytes: [0x80, 60, 0], timestamp: 2600 },
      ],
      'reverse-scheduled Long B retains its full 2600 ms release when Short A is removed',
    );
    perfMs = 2650;
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('recomputes three-note same-pitch cluster releases from surviving contributors without blindly shortening surviving envelopes', () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('hw-three-cluster-ownership', {
      nowPerfMs: () => perfMs,
    });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const chA = makeChannel('ch-3a', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });
    const chB = makeChannel('ch-3b', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });
    const chC = makeChannel('ch-3c', {
      midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
    });

    // Subcase 1: Mixed arrival order (C -> A -> B):
    //   A: 1000 -> 1500 ms (4 steps, vel 100)
    //   B: 1062.5 -> 1375 ms (2.5 steps, vel 92)
    //   C: 1100 -> 1225 ms (1 step, vel 84)
    // Remove A at 1120 ms -> surviving {B, C} must release at B's 1375 ms (NOT 1500 ms, and NOT C's 1225 ms)!
    scheduler.beginTransportTake(1, 'song');
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
      channel: chC,
      note: makeNote(60, { id: '3c', start: 0.8, duration: 1, velocity: 84 / 127 }),
      onsetAudioTimeSeconds: 0.1, // -> 1100..1225 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chA,
      note: makeNote(60, { id: '3a', start: 0, duration: 4, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0, // -> 1000..1500 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chB,
      note: makeNote(60, { id: '3b', start: 0.5, duration: 2.5, velocity: 92 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 1062.5..1375 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 1120;
    scheduler.cleanupChannel('ch-3a');
    assert.equal(scheduler.getActiveNoteCount('ch-3a'), 0);
    assert.equal(scheduler.getActiveNoteCount('ch-3b'), 1);
    assert.equal(scheduler.getActiveNoteCount('ch-3c'), 1);

    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 1000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }

    assert.deepEqual(
      port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 100], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1062.5 },
        { bytes: [0x90, 60, 92], timestamp: 1062.5 },
        { bytes: [0x80, 60, 0], timestamp: 1100 },
        { bytes: [0x90, 60, 84], timestamp: 1100 },
        { bytes: [0x80, 60, 0], timestamp: 1375 },
      ],
      'removing longest contributor A recalculates cluster tail to surviving B 1375 ms (3 Note Ons, 3 Note Offs)',
    );
    perfMs = 1400;
    assert.equal(scheduler.getActiveNoteCount(), 0);

    // Subcase 2: Sequential removal of A (at 2120 ms) AND B (at 2150 ms) collapses release to C's own 2225 ms!
    port.sent.length = 0;
    port.wireQueue.length = 0;
    port.clearCalls = 0;
    perfMs = 2000;

    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
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
      channel: chA,
      note: makeNote(60, { id: '3a-seq', start: 0, duration: 4, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0, // -> 2000..2500 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chB,
      note: makeNote(60, { id: '3b-seq', start: 0.5, duration: 2.5, velocity: 92 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 2062.5..2375 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chC,
      note: makeNote(60, { id: '3c-seq', start: 0.8, duration: 1, velocity: 84 / 127 }),
      onsetAudioTimeSeconds: 0.1, // -> 2100..2225 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 2120;
    scheduler.cleanupChannel('ch-3a');
    perfMs = 2150;
    scheduler.cleanupChannel('ch-3b');
    assert.equal(scheduler.getActiveNoteCount('ch-3c'), 1);
    assert.equal(scheduler.getActiveNoteCount(), 1);

    assert.deepEqual(
      port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 100], timestamp: 2000 },
        { bytes: [0x80, 60, 0], timestamp: 2062.5 },
        { bytes: [0x90, 60, 92], timestamp: 2062.5 },
        { bytes: [0x80, 60, 0], timestamp: 2100 },
        { bytes: [0x90, 60, 84], timestamp: 2100 },
        { bytes: [0x80, 60, 0], timestamp: 2225 },
      ],
      'removing both A and B leaves C releasing at its own 2225 ms',
    );
    perfMs = 2250;
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('preserves shared-port sibling Note Ons, Note Offs, and CCs and suppresses CC 123 while another DAW channel owns an active note on the same MIDI channel', () => {
    let perfMs = 1000;
    const sharedPort = new InstrumentedMidiOutputPort('hw-shared-own', {
      nowPerfMs: () => perfMs,
    });
    const otherPort = new InstrumentedMidiOutputPort('hw-other-own', {
      nowPerfMs: () => perfMs,
    });
    const ports = new Map<string, MidiOutputPortLike>([
      [sharedPort.id, sharedPort],
      [otherPort.id, otherPort],
    ]);
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => ports,
    });

    const chA = makeChannel('ch-own-a', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
    });
    const chB = makeChannel('ch-own-b', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
    });
    const chSiblingSameMidiCh = makeChannel('ch-own-sib-ch1', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
    });
    const chSiblingCh2 = makeChannel('ch-own-sib-ch2', {
      midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 2 },
    });
    const chOtherPort = makeChannel('ch-own-other-port', {
      midiOutput: { mode: 'external', outputDeviceId: otherPort.id, midiChannel: 1 },
    });

    scheduler.beginTransportTake(1, 'song');
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
    // Long A (1000->1500 ms) + Short B (1062.5->1187.5 ms) on sharedPort Ch 1 pitch C4 (60)
    scheduler.scheduleChannelNote({
      channel: chA,
      note: makeNote(60, { id: 'sh-a', start: 0, duration: 4, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chB,
      note: makeNote(60, { id: 'sh-b', start: 0.5, duration: 1, velocity: 112 / 127 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    // Additional note on sharedPort Ch 1 pitch E4 (64) owned by chSiblingSameMidiCh (1080->1205 ms)
    scheduler.scheduleChannelNote({
      channel: chSiblingSameMidiCh,
      note: makeNote(64, { id: 'sh-sib-ch1', start: 0.64, duration: 1, velocity: 95 / 127 }),
      onsetAudioTimeSeconds: 0.08,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    // Unrelated sibling channel on sharedPort Ch 2 with future Note On (1090 ms), Note Off (1215 ms), and future CCs
    scheduler.scheduleChannelNote({
      channel: chSiblingCh2,
      note: makeNote(67, { id: 'sh-sib-ch2', start: 0.72, duration: 1, velocity: 108 / 127 }),
      onsetAudioTimeSeconds: 0.09,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    // Unrelated physical port
    scheduler.scheduleChannelNote({
      channel: chOtherPort,
      note: makeNote(48, { id: 'sh-other', start: 0.4, duration: 1, velocity: 90 / 127 }),
      onsetAudioTimeSeconds: 0.05,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    scheduler.sendChannelControlChange(chSiblingCh2, 74, 99, 0.11, 0); // -> 1110 ms on Ch 2
    scheduler.sendChannelControlChange(chSiblingCh2, 1, 64, 0.075, 0); // -> 1075 ms on Ch 2

    // At 1030 ms (before 1062.5 ms, forcing sharedPort.clear()), clean up chA!
    perfMs = 1030;
    scheduler.cleanupChannel('ch-own-a');

    assert.equal(otherPort.clearCalls, 0, 'unrelated physical port never cleared');
    assert.equal(
      sharedPort.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123),
      false,
      'must NOT emit CC 123 on MIDI Ch 1 while ch-own-b and ch-own-sib-ch1 still own active notes on Ch 1',
    );
    assert.equal(
      sharedPort.sent.some(p => p.bytes[0] === 0xb1 && p.bytes[1] === 123),
      false,
      'must NOT emit CC 123 on sibling MIDI Ch 2',
    );

    const deliveredShared = sharedPort.getDeliveredWirePackets();
    const ch1Delivered = deliveredShared.filter(p => (p.bytes[0] & 0x0f) === 0);
    const ch2Delivered = deliveredShared.filter(p => (p.bytes[0] & 0x0f) === 1);

    assert.deepEqual(
      ch1Delivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp ?? 1030 })),
      [
        { bytes: [0x90, 60, 100], timestamp: 1000 },
        { bytes: [0x80, 60, 0], timestamp: 1030 },
        { bytes: [0x90, 60, 112], timestamp: 1062.5 },
        { bytes: [0x90, 64, 95], timestamp: 1080 },
        { bytes: [0x80, 60, 0], timestamp: 1187.5 },
        { bytes: [0x80, 64, 0], timestamp: 1205 },
      ],
      'Ch 1 preserves sibling E4 at 1080->1205 ms and releases B C4 at 1187.5 ms without CC 123',
    );

    assert.deepEqual(
      ch2Delivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0xb1, 1, 64], timestamp: 1075 },
        { bytes: [0x91, 67, 108], timestamp: 1090 },
        { bytes: [0xb1, 74, 99], timestamp: 1110 },
        { bytes: [0x81, 67, 0], timestamp: 1215 },
      ],
      'Ch 2 sibling Note On, Note Off, and timestamped CCs preserved at exact original timestamps',
    );

    // Once chB finishes at 1187.5 ms, cleaning up the final active owner on Ch 1 (at 1195 ms) DOES emit CC 123!
    perfMs = 1195;
    scheduler.cleanupChannel('ch-own-sib-ch1');
    assert.equal(
      sharedPort.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123 && p.bytes[2] === 0),
      true,
      'CC 123 emitted once the final active owner on MIDI Ch 1 is cleaned up',
    );

    perfMs = 1250;
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('handles per-channel ownership cleanup honestly on ports without MIDIOutput.clear() (or when clear() throws) with strict Note Off parity', () => {
    let perfMs = 1000;
    const noClearPort = new InstrumentedMidiOutputPort('hw-own-noclear', {
      supportsClear: false,
      nowPerfMs: () => perfMs,
    });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[noClearPort.id, noClearPort]]),
    });
    const chA = makeChannel('ch-nc-a', {
      midiOutput: { mode: 'external', outputDeviceId: noClearPort.id, midiChannel: 1 },
    });
    const chB = makeChannel('ch-nc-b', {
      midiOutput: { mode: 'external', outputDeviceId: noClearPort.id, midiChannel: 1 },
    });

    // Subcase 1: Short A (1000->1125 ms, Note Off @ 1125 already queued!) + Long B (1062.5->1562.5 ms).
    // Even if Short A is cleaned up at 1080 ms, the clear-less port CANNOT cancel the queued 1125 ms Note Off:
    // never pretend it was cancelled and never emit an orphan 3rd Note Off at 1562.5 ms!
    scheduler.beginTransportTake(1, 'song');
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
    assert.deepEqual(
      scheduler.scheduleChannelNote({
        channel: chA,
        note: makeNote(60, { id: 'nc-own-short', start: 0, duration: 1, velocity: 96 / 127 }),
        onsetAudioTimeSeconds: 0, // -> 1000..1125 ms
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      }),
      { sent: true },
    );
    assert.deepEqual(
      scheduler.scheduleChannelNote({
        channel: chB,
        note: makeNote(60, { id: 'nc-own-long', start: 0.5, duration: 4, velocity: 114 / 127 }),
        onsetAudioTimeSeconds: 0.0625, // -> 1062.5..1562.5 ms
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      }),
      {
        sent: true,
        uncancelledQueuedNoteOff: true,
        effectiveReleasePerfMs: 1125,
      },
    );
    scheduler.endTransportStep();

    perfMs = 1080;
    scheduler.cleanupChannel('ch-nc-a');
    assert.equal(noClearPort.clearCalls, 0);
    assert.equal(
      noClearPort.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123),
      false,
      'no CC 123 while B remains active until uncancelled 1125 ms cutoff',
    );

    for (const stepIdx of [1, 2, 3, 4]) {
      perfMs = 1000 + stepIdx * 125;
      scheduler.beginTransportStep({
        takeGeneration: 1,
        absoluteStep: stepIdx,
        step: stepIdx,
        stepAudioTimeSeconds: stepIdx * 0.125,
        unswungStepAudioTimeSeconds: stepIdx * 0.125,
        grooveOffsetSeconds: 0,
        bpm: 120,
        mode: 'song',
        patternLoopSteps: null,
        contextCurrentTimeSeconds: stepIdx * 0.125,
      });
      scheduler.endTransportStep();
    }

    const ncOns1 = noClearPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x90);
    const ncOffs1 = noClearPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x80);
    assert.equal(ncOns1.length, 2, 'exact 2 Note Ons');
    assert.equal(ncOffs1.length, 2, 'strict 1:1 Note Off parity — no orphan 1562.5 ms Note Off');
    assert.deepEqual(
      ncOffs1.map(p => p.timestamp).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [1062.5, 1125],
    );
    perfMs = 1200;
    assert.equal(scheduler.getActiveNoteCount(), 0);

    // Subcase 2: Long A (2000->2500 ms, unqueued beyond horizon) + Short B (2062.5->2187.5 ms) on clear-less port:
    // removing Long A at 2100 ms queues Short B's 2187.5 ms Note Off cleanly!
    noClearPort.sent.length = 0;
    perfMs = 2000;
    scheduler.beginTransportTake(2, 'song');
    scheduler.beginTransportStep({
      takeGeneration: 2,
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
      channel: chA,
      note: makeNote(60, { id: 'nc2-long-a', start: 0, duration: 4, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel: chB,
      note: makeNote(60, { id: 'nc2-short-b', start: 0.5, duration: 1, velocity: 112 / 127 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    perfMs = 2100;
    scheduler.cleanupChannel('ch-nc-a');

    assert.deepEqual(
      noClearPort.sent.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
      [
        { bytes: [0x90, 60, 100], timestamp: 2000 },
        { bytes: [0x80, 60, 0], timestamp: 2062.5 },
        { bytes: [0x90, 60, 112], timestamp: 2062.5 },
        { bytes: [0x80, 60, 0], timestamp: 2187.5 },
      ],
      'clear-less port still releases Short B at 2187.5 ms when Long A had no pre-queued hardware Note Off',
    );
    perfMs = 2200;
    assert.equal(scheduler.getActiveNoteCount(), 0);

    // Subcase 3: Port whose `clear()` throws at runtime with Medium A (3040->3165 ms, pre-queued 3165 ms Note Off)
    // and Shorter B (3062.5->3125 ms): removing A at 3080 ms preserves 1:1 Note Off parity honestly!
    let throwPerfMs = 3000;
    const throwingPort = new InstrumentedMidiOutputPort('hw-throwing-clear', {
      nowPerfMs: () => throwPerfMs,
    });
    throwingPort.clear = () => {
      throwingPort.clearCalls += 1;
      throw new Error('clear() unsupported by driver');
    };
    const throwingScheduler = new MidiOutputScheduler({
      performanceNowMs: () => throwPerfMs,
      getOutputs: () => new Map([[throwingPort.id, throwingPort]]),
    });
    const chThrowA = makeChannel('ch-th-a', {
      midiOutput: { mode: 'external', outputDeviceId: throwingPort.id, midiChannel: 1 },
    });
    const chThrowB = makeChannel('ch-th-b', {
      midiOutput: { mode: 'external', outputDeviceId: throwingPort.id, midiChannel: 1 },
    });

    throwingScheduler.beginTransportTake(1, 'song');
    throwingScheduler.beginTransportStep({
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
    throwingScheduler.scheduleChannelNote({
      channel: chThrowA,
      note: makeNote(60, { id: 'th-med-a', start: 0.32, duration: 1, velocity: 100 / 127 }),
      onsetAudioTimeSeconds: 0.04, // -> 3040..3165 ms (queued 3165 ms Note Off!)
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    const throwResB = throwingScheduler.scheduleChannelNote({
      channel: chThrowB,
      note: makeNote(60, { id: 'th-short-b', start: 0.5, duration: 0.5, velocity: 110 / 127 }),
      onsetAudioTimeSeconds: 0.0625, // -> 3062.5..3125 ms
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    throwingScheduler.endTransportStep();

    assert.deepEqual(throwResB, {
      sent: true,
      uncancelledQueuedNoteOff: true,
      effectiveReleasePerfMs: 3165,
    });

    throwPerfMs = 3080;
    throwingScheduler.cleanupChannel('ch-th-a');
    const thOns = throwingPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x90);
    const thOffs = throwingPort.sent.filter(p => (p.bytes[0] & 0xf0) === 0x80);
    assert.equal(thOns.length, 2, '2 Note Ons on throwing-clear port');
    assert.equal(thOffs.length, 2, 'strict 1:1 Note Off parity — no duplicate 3125 ms Note Off sent alongside uncancelled 3165 ms');
    throwPerfMs = 3200;
    assert.equal(throwingScheduler.getActiveNoteCount(), 0);
  });
});
