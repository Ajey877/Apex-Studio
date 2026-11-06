import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_RECENT_NOTE_RECOVERY_CANDIDATES,
  MAX_RECENT_SUSTAIN_RECOVERY_CANDIDATES,
  MidiOutputScheduler,
  RECENT_NOTE_RECOVERY_RETENTION_MS,
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

  it('closes an unavoidable future Note On promptly on ports without clear() or throwing clear() when its channel is removed mid-cluster (exact 1000 / 1062.5 / 1125 / 1500 ms reproduction)', () => {
    for (const mode of ['absent-clear', 'throwing-clear'] as const) {
      let perfMs = 1000;
      const port = new InstrumentedMidiOutputPort(`hw-${mode}-1062`, {
        supportsClear: mode !== 'absent-clear',
        nowPerfMs: () => perfMs,
      });
      if (mode === 'throwing-clear') {
        port.clear = () => {
          port.clearCalls += 1;
          throw new Error('MIDIOutput.clear() failed in driver');
        };
      }

      const scheduler = new MidiOutputScheduler({
        performanceNowMs: () => perfMs,
        getOutputs: () => new Map([[port.id, port]]),
      });

      const chA = makeChannel(`ch-a-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
      });
      const chB = makeChannel(`ch-b-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
      });

      // Step 0 at 1000 ms (120 BPM => 125 ms / step):
      // - Channel A: Note On @ 1000 ms, intended release 1500 ms (4 steps, beyond step-0 horizon)
      // - Channel B: Note On @ 1062.5 ms, intended release 1125 ms (0.5 step; unqueued because cluster envelope is 1500 ms)
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
        note: makeNote(60, { id: `a-1000-${mode}`, start: 0, duration: 4, velocity: 100 / 127 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      scheduler.scheduleChannelNote({
        channel: chB,
        note: makeNote(60, { id: `b-1062-${mode}`, start: 0.5, duration: 0.5, velocity: 112 / 127 }),
        onsetAudioTimeSeconds: 0.0625,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      scheduler.endTransportStep();

      // Before cleanup at 1030 ms, only [1000 On, 1062.5 Off, 1062.5 On] are queued on the wire.
      assert.deepEqual(
        port.sent.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x90, 60, 100], timestamp: 1000 },
          { bytes: [0x80, 60, 0], timestamp: 1062.5 },
          { bytes: [0x90, 60, 112], timestamp: 1062.5 },
        ],
        `[${mode}] pre-cleanup wire schedule has B's 1062.5 ms Note On without a queued tail Note Off`,
      );

      // At 1030 ms, Channel B is muted/removed while Channel A is still sounding on Ch 1 C4.
      perfMs = 1030;
      scheduler.cleanupChannel(chB.id);

      if (mode === 'throwing-clear') {
        assert.ok(port.clearCalls >= 1, 'attempted clear() before falling back cleanly');
      } else {
        assert.equal(port.clearCalls, 0, 'absent clear() cannot be invoked');
      }

      // Cleanup must NOT send CC 123 while Channel A still owns C4 on MIDI Ch 1,
      // must NOT claim B's 1062.5 ms Note On was cancelled, and MUST enqueue a
      // deterministic safety Note Off at 1062.5 + MIN_MIDI_NOTE_OFF_DELTA_MS (1063.5 ms).
      assert.equal(
        port.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123),
        false,
        `[${mode}] CC 123 suppressed while Channel A still owns C4 on MIDI Ch 1`,
      );
      assert.equal(scheduler.getActiveNoteCount(chB.id), 0, `[${mode}] removed Channel B has 0 active notes`);
      assert.equal(scheduler.getActiveNoteCount(chA.id), 1, `[${mode}] Channel A remains tracked until its 1062.5 ms hardware cutoff`);

      // Advance transport through steps 1..4 (1125..1500 ms) and past 1600 ms:
      // no orphan Note Off @ 1500 ms may be emitted after hardware closed at 1063.5 ms.
      for (let step = 1; step <= 4; step += 1) {
        perfMs = 1000 + step * 125;
        const stepSec = step * 0.125;
        scheduler.beginTransportStep({
          takeGeneration: 1,
          absoluteStep: step,
          step,
          stepAudioTimeSeconds: stepSec,
          unswungStepAudioTimeSeconds: stepSec,
          grooveOffsetSeconds: 0,
          bpm: 120,
          mode: 'song',
          patternLoopSteps: null,
          contextCurrentTimeSeconds: stepSec,
        });
        scheduler.endTransportStep();
      }

      perfMs = 1600;
      assert.equal(scheduler.getActiveNoteCount(), 0, `[${mode}] zero active-note records remain after completion`);

      const delivered = port.getDeliveredWirePackets();
      assert.deepEqual(
        delivered.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x90, 60, 100], timestamp: 1000 },
          { bytes: [0x80, 60, 0], timestamp: 1062.5 },
          { bytes: [0x90, 60, 112], timestamp: 1062.5 },
          { bytes: [0x80, 60, 0], timestamp: 1063.5 },
        ],
        `[${mode}] exact wire bytes & timestamps close B's unavoidable 1062.5 ms Note On promptly at 1063.5 ms with 1:1 parity`,
      );

      // Simulate physical MIDI voice state across time to prove B's unavoidable attack closes after 1 ms.
      const ordered = [...delivered].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      let voiceDepth = 0;
      let bAttackOpenedAt: number | null = null;
      let bAttackClosedAt: number | null = null;
      for (const pkt of ordered) {
        if ((pkt.bytes[0] & 0xf0) === 0x90 && pkt.bytes[2] > 0) {
          voiceDepth += 1;
          if (pkt.bytes[2] === 112) {
            bAttackOpenedAt = pkt.timestamp ?? null;
          }
        } else if ((pkt.bytes[0] & 0xf0) === 0x80) {
          assert.ok(voiceDepth > 0, `[${mode}] every Note Off closes an open Note On`);
          voiceDepth -= 1;
          if (bAttackOpenedAt !== null && bAttackClosedAt === null && (pkt.timestamp ?? 0) > bAttackOpenedAt) {
            bAttackClosedAt = pkt.timestamp ?? null;
          }
        }
      }
      assert.equal(voiceDepth, 0, `[${mode}] hardware voice ends completely silent (1:1 Note On/Off parity)`);
      assert.equal(bAttackOpenedAt, 1062.5);
      assert.equal(bAttackClosedAt, 1063.5, `[${mode}] unavoidable future Note On closed 1 ms after sounding`);
    }
  });

  it('avoids duplicate Note Offs on clear-less and throwing-clear ports when a removed future Note On already has a valid queued release', () => {
    for (const mode of ['absent-clear', 'throwing-clear'] as const) {
      // Subcase A: Removed future Note On (1062.5 -> 1125 ms) already queued its own 1125 ms release
      // while sibling note on same MIDI Ch 1 (E4, 1000 -> 1500 ms) keeps MIDI Ch 1 active.
      let perfMs = 1000;
      const portA = new InstrumentedMidiOutputPort(`hw-dup-a-${mode}`, {
        supportsClear: mode !== 'absent-clear',
        nowPerfMs: () => perfMs,
      });
      if (mode === 'throwing-clear') {
        portA.clear = () => {
          portA.clearCalls += 1;
          throw new Error('clear() unsupported');
        };
      }
      const schedA = new MidiOutputScheduler({
        performanceNowMs: () => perfMs,
        getOutputs: () => new Map([[portA.id, portA]]),
      });
      const chHoldE4 = makeChannel(`ch-e4-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: portA.id, midiChannel: 1 },
      });
      const chFutureC4 = makeChannel(`ch-c4-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: portA.id, midiChannel: 1 },
      });

      schedA.beginTransportTake(1, 'song');
      schedA.beginTransportStep({
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
      schedA.scheduleChannelNote({
        channel: chHoldE4,
        note: makeNote(64, { id: `e4-${mode}`, start: 0, duration: 2, velocity: 96 / 127 }),
        onsetAudioTimeSeconds: 0, // 1000 -> 1250 ms
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      schedA.scheduleChannelNote({
        channel: chFutureC4,
        note: makeNote(60, { id: `c4-${mode}`, start: 0.5, duration: 0.5, velocity: 110 / 127 }),
        onsetAudioTimeSeconds: 0.0625, // 1062.5 -> 1125 ms (already queued Note Off @ 1125 ms!)
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      schedA.endTransportStep();

      perfMs = 1030;
      schedA.cleanupChannel(chFutureC4.id);

      // Step 1 flushes E4's 1250 ms Note Off.
      perfMs = 1125;
      schedA.beginTransportStep({
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
      schedA.endTransportStep();

      const c4PacketsA = portA.getDeliveredWirePackets().filter(p => p.bytes[1] === 60);
      assert.deepEqual(
        c4PacketsA.map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x90, 60, 110], timestamp: 1062.5 },
          { bytes: [0x80, 60, 0], timestamp: 1125 },
        ],
        `[${mode}] Subcase A: no duplicate 1063.5 ms safety Note Off when 1125 ms Note Off was already queued`,
      );
      perfMs = 1300;
      assert.equal(schedA.getActiveNoteCount(), 0);

      // Subcase B: Same-pitch 3-note cluster A (1000->1500 ms), B (1062.5->1125 ms), C (1100->1600 ms):
      // B already has its valid queued retrigger Note Off @ 1100 ms before C; removing B at 1030 ms
      // must NOT emit a duplicate Note Off and MUST preserve C's surviving 1600 ms release!
      perfMs = 1000;
      const portB = new InstrumentedMidiOutputPort(`hw-dup-b-${mode}`, {
        supportsClear: mode !== 'absent-clear',
        nowPerfMs: () => perfMs,
      });
      if (mode === 'throwing-clear') {
        portB.clear = () => {
          portB.clearCalls += 1;
          throw new Error('clear() unsupported');
        };
      }
      const schedB = new MidiOutputScheduler({
        performanceNowMs: () => perfMs,
        getOutputs: () => new Map([[portB.id, portB]]),
      });
      const chClusterA = makeChannel(`ch-cl-a-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: portB.id, midiChannel: 1 },
      });
      const chClusterB = makeChannel(`ch-cl-b-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: portB.id, midiChannel: 1 },
      });
      const chClusterC = makeChannel(`ch-cl-c-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: portB.id, midiChannel: 1 },
      });

      schedB.beginTransportTake(1, 'song');
      schedB.beginTransportStep({
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
      schedB.scheduleChannelNote({
        channel: chClusterA,
        note: makeNote(60, { id: `cla-${mode}`, start: 0, duration: 4, velocity: 95 / 127 }),
        onsetAudioTimeSeconds: 0, // 1000 -> 1500 ms
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      schedB.scheduleChannelNote({
        channel: chClusterB,
        note: makeNote(60, { id: `clb-${mode}`, start: 0.5, duration: 0.5, velocity: 105 / 127 }),
        onsetAudioTimeSeconds: 0.0625, // 1062.5 -> 1125 ms
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      schedB.scheduleChannelNote({
        channel: chClusterC,
        note: makeNote(60, { id: `clc-${mode}`, start: 0.8, duration: 4, velocity: 115 / 127 }),
        onsetAudioTimeSeconds: 0.1, // 1100 -> 1600 ms (queues B's retrigger Note Off @ 1100 ms)
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      schedB.endTransportStep();

      perfMs = 1030;
      schedB.cleanupChannel(chClusterB.id);

      for (let step = 1; step <= 4; step += 1) {
        perfMs = 1000 + step * 125;
        const stepSec = step * 0.125;
        schedB.beginTransportStep({
          takeGeneration: 1,
          absoluteStep: step,
          step,
          stepAudioTimeSeconds: stepSec,
          unswungStepAudioTimeSeconds: stepSec,
          grooveOffsetSeconds: 0,
          bpm: 120,
          mode: 'song',
          patternLoopSteps: null,
          contextCurrentTimeSeconds: stepSec,
        });
        schedB.endTransportStep();
      }

      perfMs = 1650;
      assert.equal(schedB.getActiveNoteCount(), 0, `[${mode}] Subcase B: zero active notes after 1600 ms`);
      assert.deepEqual(
        portB.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x90, 60, 95], timestamp: 1000 },
          { bytes: [0x80, 60, 0], timestamp: 1062.5 },
          { bytes: [0x90, 60, 105], timestamp: 1062.5 },
          { bytes: [0x80, 60, 0], timestamp: 1100 },
          { bytes: [0x90, 60, 115], timestamp: 1100 },
          { bytes: [0x80, 60, 0], timestamp: 1600 },
        ],
        `[${mode}] Subcase B: no duplicate Note Off for B and C's 1600 ms release is preserved intact`,
      );

      // Subcase C: Same-pitch reverse-order overlap — B (1062.5 -> 1125 ms) scheduled BEFORE A (1000 -> 1500 ms)
      // on the same port, MIDI Ch 1, and pitch C4, so B already queued its own 1125 ms release.
      // Removing B at 1030 ms must emit zero duplicate Note Offs and leave 0 active notes after completion.
      perfMs = 1000;
      const portC = new InstrumentedMidiOutputPort(`hw-dup-c-${mode}`, {
        supportsClear: mode !== 'absent-clear',
        nowPerfMs: () => perfMs,
      });
      if (mode === 'throwing-clear') {
        portC.clear = () => {
          portC.clearCalls += 1;
          throw new Error('clear() unsupported');
        };
      }
      const schedC = new MidiOutputScheduler({
        performanceNowMs: () => perfMs,
        getOutputs: () => new Map([[portC.id, portC]]),
      });
      const chRevA = makeChannel(`ch-rev-a-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: portC.id, midiChannel: 1 },
      });
      const chRevB = makeChannel(`ch-rev-b-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: portC.id, midiChannel: 1 },
      });

      schedC.beginTransportTake(1, 'song');
      schedC.beginTransportStep({
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
      schedC.scheduleChannelNote({
        channel: chRevB,
        note: makeNote(60, { id: `rev-b-${mode}`, start: 0.5, duration: 0.5, velocity: 112 / 127 }),
        onsetAudioTimeSeconds: 0.0625, // 1062.5 -> 1125 ms (queues 1125 ms Note Off!)
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      schedC.scheduleChannelNote({
        channel: chRevA,
        note: makeNote(60, { id: `rev-a-${mode}`, start: 0, duration: 4, velocity: 100 / 127 }),
        onsetAudioTimeSeconds: 0, // 1000 -> 1500 ms
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      schedC.endTransportStep();

      const preCleanupCountC = portC.sent.length;
      perfMs = 1030;
      schedC.cleanupChannel(chRevB.id);
      assert.equal(
        portC.sent.length,
        preCleanupCountC,
        `[${mode}] Subcase C: zero extra MIDI messages sent when removed future Note On already owns its 1125 ms Note Off`,
      );

      for (let step = 1; step <= 4; step += 1) {
        perfMs = 1000 + step * 125;
        const stepSec = step * 0.125;
        schedC.beginTransportStep({
          takeGeneration: 1,
          absoluteStep: step,
          step,
          stepAudioTimeSeconds: stepSec,
          unswungStepAudioTimeSeconds: stepSec,
          grooveOffsetSeconds: 0,
          bpm: 120,
          mode: 'song',
          patternLoopSteps: null,
          contextCurrentTimeSeconds: stepSec,
        });
        schedC.endTransportStep();
      }

      perfMs = 1600;
      assert.equal(schedC.getActiveNoteCount(), 0, `[${mode}] Subcase C: zero active notes after completion`);
      const cOns = portC.getDeliveredWirePackets().filter(p => p.bytes[0] === 0x90);
      const cOffs = portC.getDeliveredWirePackets().filter(p => p.bytes[0] === 0x80);
      assert.equal(cOns.length, 2, `[${mode}] Subcase C: 2 Note Ons`);
      assert.equal(cOffs.length, 2, `[${mode}] Subcase C: 2 Note Offs (strict 1:1 parity, zero duplicates)`);
    }
  });

  it('preserves sibling pitch on the same MIDI channel plus sibling note and timestamped CCs on another MIDI channel during clear-less future-note cleanup', () => {
    for (const mode of ['absent-clear', 'throwing-clear'] as const) {
      let perfMs = 1000;
      const sharedPort = new InstrumentedMidiOutputPort(`hw-sib-noclear-${mode}`, {
        supportsClear: mode !== 'absent-clear',
        nowPerfMs: () => perfMs,
      });
      if (mode === 'throwing-clear') {
        sharedPort.clear = () => {
          sharedPort.clearCalls += 1;
          throw new Error('clear() unsupported');
        };
      }

      const scheduler = new MidiOutputScheduler({
        performanceNowMs: () => perfMs,
        getOutputs: () => new Map([[sharedPort.id, sharedPort]]),
      });

      const chMainA = makeChannel(`ch-main-a-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
      });
      const chMainB = makeChannel(`ch-main-b-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
      });
      const chSameMidiE4 = makeChannel(`ch-same-ch1-e4-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 1 },
      });
      const chOtherMidiG4 = makeChannel(`ch-other-ch2-g4-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: sharedPort.id, midiChannel: 2 },
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

      // Same voice C4 on MIDI Ch 1: A (1000->1500 ms), B (1062.5->1125 ms)
      scheduler.scheduleChannelNote({
        channel: chMainA,
        note: makeNote(60, { id: `ma-${mode}`, start: 0, duration: 4, velocity: 100 / 127 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      scheduler.scheduleChannelNote({
        channel: chMainB,
        note: makeNote(60, { id: `mb-${mode}`, start: 0.5, duration: 0.5, velocity: 112 / 127 }),
        onsetAudioTimeSeconds: 0.0625,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });

      // Sibling pitch E4 (64) on SAME MIDI Ch 1: 1050 -> 1300 ms
      scheduler.scheduleChannelNote({
        channel: chSameMidiE4,
        note: makeNote(64, { id: `se4-${mode}`, start: 0.4, duration: 2, velocity: 94 / 127 }),
        onsetAudioTimeSeconds: 0.05,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });

      // Sibling note G4 (67) + timestamped CC 74 & CC 1 on MIDI Ch 2: 1075 -> 1325 ms
      scheduler.scheduleChannelNote({
        channel: chOtherMidiG4,
        note: makeNote(67, { id: `sg4-${mode}`, start: 0.6, duration: 2, velocity: 90 / 127 }),
        onsetAudioTimeSeconds: 0.075,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      scheduler.sendChannelControlChange(chOtherMidiG4, 74, 88, 0.08, 0); // @ 1080 ms
      scheduler.sendChannelControlChange(chOtherMidiG4, 1, 64, 0.2, 0);   // @ 1200 ms

      scheduler.endTransportStep();

      // Remove chMainB at 1030 ms
      perfMs = 1030;
      scheduler.cleanupChannel(chMainB.id);

      // Advance through steps 1..4 so sibling E4 (1300 ms) and G4 (1325 ms) flush their tail Note Offs
      for (let step = 1; step <= 4; step += 1) {
        perfMs = 1000 + step * 125;
        const stepSec = step * 0.125;
        scheduler.beginTransportStep({
          takeGeneration: 1,
          absoluteStep: step,
          step,
          stepAudioTimeSeconds: stepSec,
          unswungStepAudioTimeSeconds: stepSec,
          grooveOffsetSeconds: 0,
          bpm: 120,
          mode: 'song',
          patternLoopSteps: null,
          contextCurrentTimeSeconds: stepSec,
        });
        scheduler.endTransportStep();
      }

      perfMs = 1600;
      assert.equal(scheduler.getActiveNoteCount(), 0, `[${mode}] zero active notes remain after all voices finish`);

      const delivered = sharedPort.getDeliveredWirePackets();
      assert.equal(
        delivered.some(p => (p.bytes[0] & 0xf0) === 0xb0 && p.bytes[1] === 123),
        false,
        `[${mode}] no CC 123 emitted on MIDI Ch 1 or MIDI Ch 2`,
      );

      assert.deepEqual(
        delivered
          .filter(p => (p.bytes[0] === 0x90 || p.bytes[0] === 0x80) && p.bytes[1] === 60)
          .map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x90, 60, 100], timestamp: 1000 },
          { bytes: [0x80, 60, 0], timestamp: 1062.5 },
          { bytes: [0x90, 60, 112], timestamp: 1062.5 },
          { bytes: [0x80, 60, 0], timestamp: 1063.5 },
        ],
        `[${mode}] Ch 1 C4 closes B's unavoidable 1062.5 ms Note On at 1063.5 ms with 1:1 parity`,
      );

      assert.deepEqual(
        delivered
          .filter(p => (p.bytes[0] === 0x90 || p.bytes[0] === 0x80) && p.bytes[1] === 64)
          .map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x90, 64, 94], timestamp: 1050 },
          { bytes: [0x80, 64, 0], timestamp: 1300 },
        ],
        `[${mode}] sibling pitch E4 on same MIDI Ch 1 preserved untouched`,
      );

      assert.deepEqual(
        delivered
          .filter(p => (p.bytes[0] === 0x91 || p.bytes[0] === 0x81) && p.bytes[1] === 67)
          .map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x91, 67, 90], timestamp: 1075 },
          { bytes: [0x81, 67, 0], timestamp: 1325 },
        ],
        `[${mode}] sibling note G4 on MIDI Ch 2 preserved untouched`,
      );

      assert.deepEqual(
        delivered
          .filter(p => p.bytes[0] === 0xb1)
          .map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0xb1, 74, 88], timestamp: 1080 },
          { bytes: [0xb1, 1, 64], timestamp: 1200 },
        ],
        `[${mode}] timestamped CC events on MIDI Ch 2 preserved at exact original timestamps`,
      );
    }
  });

  it('recovers only the disconnected port\'s active pitches and sustain after reconnect without CC 123 or sibling-port cleanup', async () => {
    let perfMs = 1000;
    const portA = new InstrumentedMidiOutputPort('reconnect-a', { nowPerfMs: () => perfMs });
    const portB = new InstrumentedMidiOutputPort('reconnect-b', { nowPerfMs: () => perfMs });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[portA.id, portA], [portB.id, portB]]),
    });
    const chA = makeChannel('reconnect-a-ch1', {
      midiOutput: { outputDeviceId: portA.id, midiChannel: 1, mode: 'external' },
    });
    const chAUnison = makeChannel('reconnect-a-unison', {
      midiOutput: { outputDeviceId: portA.id, midiChannel: 1, mode: 'external' },
    });
    const chA2 = makeChannel('reconnect-a-ch2', {
      midiOutput: { outputDeviceId: portA.id, midiChannel: 2, mode: 'external' },
    });
    const chB = makeChannel('reconnect-b-ch1', {
      midiOutput: { outputDeviceId: portB.id, midiChannel: 1, mode: 'external' },
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
    for (const [channel, pitch] of [[chA, 60], [chAUnison, 60], [chA2, 64], [chB, 67]] as const) {
      scheduler.scheduleChannelNote({
        channel,
        note: makeNote(pitch, { id: `reconnect-${channel.id}`, duration: 4 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
    }
    // A future onset on the disconnected port must be canceled, not replayed after reconnect.
    scheduler.scheduleChannelNote({
      channel: chA,
      note: makeNote(72, { id: 'reconnect-future', duration: 1 }),
      onsetAudioTimeSeconds: 0.1,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.sendChannelControlChange(chA, 64, 127);
    scheduler.endTransportStep();

    // Model the receiver state at the wire: link loss itself is not a MIDI Note Off or pedal-up event.
    const receiverNotes = new Set<string>();
    const receiverSustain = new Set<number>();
    const receive = (packet: RecordedMidiPacket) => {
      const [status, data1, data2] = packet.bytes;
      const command = status & 0xf0;
      const midiChannel = (status & 0x0f) + 1;
      if (command === 0x90 && data2 > 0) receiverNotes.add(`${midiChannel}:${data1}`);
      if (command === 0x80 || (command === 0x90 && data2 === 0)) receiverNotes.delete(`${midiChannel}:${data1}`);
      if (command === 0xb0 && data1 === 64) {
        if (data2 >= 64) receiverSustain.add(midiChannel);
        else receiverSustain.delete(midiChannel);
      }
    };
    for (const packet of portA.sent) {
      if (packet.timestamp === undefined || packet.timestamp <= perfMs) receive(packet);
    }
    for (const packet of portB.sent) {
      if (packet.timestamp === undefined || packet.timestamp <= perfMs) receive(packet);
    }
    assert.ok(receiverNotes.has('1:60'));
    assert.ok(receiverNotes.has('2:64'));
    assert.ok(receiverSustain.has(1));

    const portBPacketsBeforeDisconnect = portB.sent.length;
    portA.state = 'disconnected';
    portA.connection = 'closed';
    scheduler.handlePortDisconnected(portA.id);
    assert.ok(receiverNotes.has('1:60'), 'receiver may retain the voice because disconnect is not a MIDI release');
    assert.ok(receiverSustain.has(1), 'receiver may retain CC64 state across link loss');
    assert.equal(scheduler.getActiveNoteCount('reconnect-a-ch1'), 0, 'scheduler drops stale local note ownership');
    assert.equal(scheduler.getActiveNoteCount('reconnect-b-ch1'), 1, 'unrelated output keeps its active note');

    portA.state = 'connected';
    portA.connection = 'closed';
    const reconnect = scheduler.handlePortReconnected(portA.id);
    // Recovery Note Offs are timestamped after any accepted future Note On;
    // advance the deterministic clock while the reconnect task is gated. The
    // extra tick also lets a queued recovery CC64-up reach its timestamp before
    // this fake-clock test awaits route readiness.
    perfMs = 1200;
    await Promise.resolve();
    perfMs = 1205;
    await reconnect;

    const recoveryPackets = portA.sent.slice(-4).map(packet => packet.bytes);
    assert.deepEqual(
      recoveryPackets,
      [
        [0xb0, 64, 0],
        [0x80, 60, 0],
        [0x80, 72, 0],
        [0x81, 64, 0],
      ],
      'reconnect releases held sustain and only the known pitches on the disconnected port/channels; same-pitch unison is deduplicated',
    );
    assert.equal(portA.sent.some(packet => packet.bytes[0] === 0xb0 && packet.bytes[1] === 123), false,
      'reconnect recovery does not broadcast All Notes Off');
    assert.equal(portB.sent.length, portBPacketsBeforeDisconnect, 'unrelated physical output receives no recovery message');
    assert.equal(
      portA.getDeliveredWirePackets().some(packet => packet.bytes[0] === 0x90 && packet.bytes[1] === 72),
      false,
      'future Note On queued before disconnect never fires after reconnect',
    );
    for (const packet of portA.sent.slice(-4)) receive(packet);
    assert.equal(receiverNotes.has('1:60'), false);
    assert.equal(receiverNotes.has('2:64'), false);
    assert.equal(receiverSustain.has(1), false);
    assert.equal(scheduler.getActiveNoteCount('reconnect-b-ch1'), 1);

    perfMs = 2000;
    const resumed = scheduler.scheduleChannelNote({
      channel: chA,
      note: makeNote(69, { id: 'reconnect-after-cleanup' }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
    });
    assert.equal(resumed.sent, true, 'route resumes after route-specific recovery completes');
    assert.ok(portA.sent.some(packet => packet.bytes[0] === 0x90 && packet.bytes[1] === 69));
  });

  it('recovers uncertain sustain after queued pedal-up pruning and a delayed disconnect callback without touching sibling routes or channels', async () => {
    let perfMs = 1000;
    const portA = new InstrumentedMidiOutputPort('delayed-sustain-a', { nowPerfMs: () => perfMs });
    const portB = new InstrumentedMidiOutputPort('delayed-sustain-b', { nowPerfMs: () => perfMs });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[portA.id, portA], [portB.id, portB]]),
    });
    const channelA = makeChannel('delayed-sustain-a-ch1', {
      midiOutput: { outputDeviceId: portA.id, midiChannel: 1, mode: 'external' },
    });
    const channelAShared = makeChannel('delayed-sustain-a-shared-ch1', {
      midiOutput: { outputDeviceId: portA.id, midiChannel: 1, mode: 'external' },
    });
    const channelAOtherMidiChannel = makeChannel('delayed-sustain-a-ch2', {
      midiOutput: { outputDeviceId: portA.id, midiChannel: 2, mode: 'external' },
    });
    const channelB = makeChannel('delayed-sustain-b-ch1', {
      midiOutput: { outputDeviceId: portB.id, midiChannel: 1, mode: 'external' },
    });

    assert.equal(scheduler.sendChannelControlChange(channelA, 64, 127), true);
    assert.equal(scheduler.sendChannelControlChange(channelAShared, 64, 127), true);
    assert.equal(scheduler.sendChannelControlChange(channelB, 64, 127), true);
    assert.equal(scheduler.sendChannelControlChange(channelAOtherMidiChannel, 1, 64), true);
    const queuedPedalUpPerfMs = 1200;
    assert.equal(scheduler.sendChannelControlChange(channelA, 64, 0, 0.2, 0), true);
    assert.equal(scheduler.sendChannelControlChange(channelAShared, 64, 0, 0.2, 0), true);
    assert.deepEqual(
      portA.sent.filter(packet => packet.bytes[0] === 0xb0 && packet.bytes[1] === 64 && packet.bytes[2] === 0)
        .map(packet => packet.timestamp),
      [queuedPedalUpPerfMs, queuedPedalUpPerfMs],
      'both DAW contributors queue pedal-up on the same physical output/channel',
    );

    // The accepted down has reached the modeled receiver, but the link drops
    // before either future pedal-up can be delivered.
    const receiverSustain = new Set<string>();
    for (const packet of portA.sent) {
      const [status, cc, value] = packet.bytes;
      if ((status & 0xf0) !== 0xb0 || cc !== 64) continue;
      const messageTime = packet.timestamp ?? 1000;
      if (messageTime <= 1000) {
        const key = `${portA.id}:${(status & 0x0f) + 1}`;
        if (value >= 64) receiverSustain.add(key);
        else receiverSustain.delete(key);
      }
    }
    assert.deepEqual([...receiverSustain], [`${portA.id}:1`]);

    portA.state = 'disconnected';
    portA.connection = 'closed';
    perfMs = queuedPedalUpPerfMs + 20;
    scheduler.getActiveNoteCount(); // ordinary pruning drops the elapsed pending CC64 transitions
    const pendingControlChanges = (scheduler as unknown as {
      pendingControlChanges: Array<{ outputDeviceId: string; midiChannel: number; bytes: number[] }>;
    }).pendingControlChanges;
    assert.equal(
      pendingControlChanges.some(event => event.outputDeviceId === portA.id && event.midiChannel === 1 && event.bytes[1] === 64),
      false,
      'ordinary pruning has removed the queued CC64-up before the delayed disconnect callback',
    );
    assert.ok(receiverSustain.has(`${portA.id}:1`), 'the receiver remains pedal-down after the disconnected queue is lost');

    const siblingPacketsBeforeRecovery = portB.sent.length;
    const portPacketsBeforeRecovery = portA.sent.length;
    scheduler.handlePortDisconnected(portA.id);
    portA.state = 'connected';
    portA.connection = 'open';
    const reconnect = scheduler.handlePortReconnected(portA.id);
    perfMs += 5;
    await reconnect;

    const recoveryPackets = portA.sent.slice(portPacketsBeforeRecovery);
    assert.deepEqual(recoveryPackets.map(packet => packet.bytes), [[0xb0, 64, 0]],
      'the delayed callback emits one route/channel-specific CC64-up despite ordinary pruning and shared DAW holders');
    assert.equal(portB.sent.length, siblingPacketsBeforeRecovery, 'the sibling output receives no cleanup');
    assert.equal(
      recoveryPackets.some(packet => packet.bytes[0] === 0xb1 && packet.bytes[1] === 64),
      false,
      'the unrelated MIDI channel on the affected output receives no pedal cleanup',
    );
    assert.equal(
      recoveryPackets.some(packet => (packet.bytes[0] & 0xf0) === 0xb0 && packet.bytes[1] === 123),
      false,
      'reconnect recovery does not use CC123',
    );
    for (const packet of recoveryPackets) {
      const [status, cc, value] = packet.bytes;
      if ((status & 0xf0) === 0xb0 && cc === 64 && value < 64) {
        receiverSustain.delete(`${portA.id}:${(status & 0x0f) + 1}`);
      }
    }
    assert.equal(receiverSustain.has(`${portA.id}:1`), false, 'the receiver pedal state is cleared only by completed recovery');
    assert.equal(scheduler.getPortUsability(portA.id).usable, true, 'the route resumes after the recovery CC64-up timestamp passes');

    // A subsequent pedal-down starts a fresh uncertainty lifetime; a second
    // disconnect/reconnect must recover it without reusing or losing the first
    // cycle's settled state.
    assert.equal(scheduler.sendChannelControlChange(channelA, 64, 127), true);
    receiverSustain.add(`${portA.id}:1`);
    assert.equal(scheduler.sendChannelControlChange(channelA, 64, 0, 0.5, 0), true);
    const secondCycleStart = portA.sent.length;
    portA.state = 'disconnected';
    portA.connection = 'closed';
    scheduler.handlePortDisconnected(portA.id);
    portA.state = 'connected';
    portA.connection = 'open';
    const secondReconnect = scheduler.handlePortReconnected(portA.id);
    perfMs += 5;
    await secondReconnect;
    const secondCycleRecovery = portA.sent.slice(secondCycleStart);
    assert.deepEqual(secondCycleRecovery.map(packet => packet.bytes), [[0xb0, 64, 0]],
      'a fresh disconnect/reconnect cycle releases the newly uncertain sustain state exactly once');
    for (const packet of secondCycleRecovery) {
      const [status, cc, value] = packet.bytes;
      if ((status & 0xf0) === 0xb0 && cc === 64 && value < 64) {
        receiverSustain.delete(`${portA.id}:${(status & 0x0f) + 1}`);
      }
    }
    assert.equal(receiverSustain.has(`${portA.id}:1`), false);
    assert.equal(portB.sent.length, siblingPacketsBeforeRecovery, 'neither cycle cleans up the sibling output');
    assert.equal(scheduler.getPortUsability(portA.id).usable, true);
  });

  it('fails closed at disconnected-recovery capacity without evicting older unresolved route ownership', async () => {
    let perfMs = 1000;
    const portCount = 65; // The scheduler retains at most 64 disconnected-output recovery records.
    const ports = Array.from({ length: portCount }, (_, index) =>
      new InstrumentedMidiOutputPort(`recovery-capacity-${index}`, { nowPerfMs: () => perfMs }),
    );
    const outputs = new Map(ports.map(port => [port.id, port]));
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => outputs,
    });
    const channels = ports.map((port, index) => makeChannel(`recovery-capacity-channel-${index}`, {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    }));

    for (let index = 0; index < ports.length; index += 1) {
      const scheduled = scheduler.scheduleChannelNote({
        channel: channels[index],
        note: makeNote(40 + (index % 80), { id: `recovery-capacity-note-${index}`, duration: 4 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      assert.equal(scheduled.sent, true, `output ${index} accepts its initial Note On`);
      ports[index].state = 'disconnected';
      ports[index].connection = 'closed';
      scheduler.handlePortDisconnected(ports[index].id);
    }

    const oldestPort = ports[0];
    oldestPort.state = 'connected';
    oldestPort.connection = 'open';
    assert.equal(scheduler.getPortUsability(oldestPort.id).usable, false,
      'the first unresolved recovery still gates its output after the 65th route arrives');
    assert.match(scheduler.getPortUsability(oldestPort.id).statusReason ?? '', /reconnect cleanup is pending/i);

    // A later callback on the original route must merge into its existing
    // unresolved record rather than replacing it with an empty recovery.
    oldestPort.state = 'disconnected';
    oldestPort.connection = 'closed';
    scheduler.handlePortDisconnected(oldestPort.id);
    oldestPort.state = 'connected';
    oldestPort.connection = 'open';
    assert.equal(scheduler.getPortUsability(oldestPort.id).usable, false,
      'repeated disconnect does not overwrite or erase the original Note Off obligation');
    assert.match(scheduler.getPortUsability(oldestPort.id).statusReason ?? '', /reconnect cleanup is pending/i);

    const overflowPort = ports[64];
    overflowPort.state = 'connected';
    overflowPort.connection = 'open';
    const overflowStatus = scheduler.getPortUsability(overflowPort.id);
    assert.equal(overflowStatus.usable, false, 'the overflow route fails closed instead of being reported ready');
    assert.match(overflowStatus.statusReason ?? '', /recovery capacity exhausted/i);
    assert.equal(scheduler.describePortInfo(overflowPort).usable, false);
    assert.match(scheduler.describePortInfo(overflowPort).statusReason ?? '', /recovery capacity exhausted/i);

    const overflowPacketsBeforePlaybackAttempt = overflowPort.sent.length;
    const blockedPlayback = scheduler.scheduleChannelNote({
      channel: channels[64],
      note: makeNote(100, { id: 'recovery-capacity-must-stay-blocked' }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(blockedPlayback.sent, false, 'the quarantined output cannot resume playback');
    assert.equal(blockedPlayback.reason, 'port_unavailable');
    assert.equal(overflowPort.sent.length, overflowPacketsBeforePlaybackAttempt, 'fail-closed scheduling sends no new MIDI');

    // Another callback cannot clear the sticky capacity quarantine or evict any
    // previously retained recovery record.
    overflowPort.state = 'disconnected';
    overflowPort.connection = 'closed';
    scheduler.handlePortDisconnected(overflowPort.id);
    overflowPort.state = 'connected';
    overflowPort.connection = 'open';
    assert.equal(scheduler.getPortUsability(overflowPort.id).usable, false);
    assert.match(scheduler.getPortUsability(overflowPort.id).statusReason ?? '', /recovery capacity exhausted/i);
    assert.equal(scheduler.getPortUsability(oldestPort.id).usable, false);
    assert.match(scheduler.getPortUsability(oldestPort.id).statusReason ?? '', /reconnect cleanup is pending/i);
  });

  it('recovers a completed voice after prune precedes a delayed disconnect callback, once per unison wire voice across clear modes', async () => {
    for (const clearMode of ['supported', 'absent', 'throwing'] as const) {
      let perfMs = 1000;
      const portA = new InstrumentedMidiOutputPort(`delayed-disconnect-${clearMode}`, {
        supportsClear: clearMode !== 'absent',
        nowPerfMs: () => perfMs,
      });
      if (clearMode === 'throwing') {
        portA.clear = () => {
          portA.clearCalls += 1;
          throw new Error('clear() unsupported');
        };
      }
      const portB = new InstrumentedMidiOutputPort(`delayed-disconnect-sibling-${clearMode}`, {
        nowPerfMs: () => perfMs,
      });
      const scheduler = new MidiOutputScheduler({
        performanceNowMs: () => perfMs,
        getOutputs: () => new Map([[portA.id, portA], [portB.id, portB]]),
      });
      const channelA = makeChannel(`delayed-a-${clearMode}`, {
        midiOutput: { outputDeviceId: portA.id, midiChannel: 1, mode: 'external' },
      });
      const channelAUnison = makeChannel(`delayed-a-unison-${clearMode}`, {
        midiOutput: { outputDeviceId: portA.id, midiChannel: 1, mode: 'external' },
      });
      const channelB = makeChannel(`delayed-b-${clearMode}`, {
        midiOutput: { outputDeviceId: portB.id, midiChannel: 1, mode: 'external' },
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
      scheduler.scheduleChannelNote({
        channel: channelA,
        note: makeNote(60, { id: `delayed-long-${clearMode}`, duration: 2 }),
        onsetAudioTimeSeconds: 0, // Note On @ 1000 ms, intended Note Off @ 1250 ms.
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      scheduler.scheduleChannelNote({
        channel: channelAUnison,
        note: makeNote(60, { id: `delayed-short-${clearMode}`, start: 0.5, duration: 1 }),
        onsetAudioTimeSeconds: 0.0625, // overlapping contributor @ 1062.5 ms, off @ 1187.5 ms.
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      scheduler.scheduleChannelNote({
        channel: channelB,
        note: makeNote(67, { id: `unrelated-${clearMode}`, duration: 100 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      });
      scheduler.endTransportStep();

      // The scheduler releases multi-step contributors when the target step
      // enters its lookahead window. Queue both future Note Offs before loss.
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

      const disconnectAtPerfMs = 1125;
      const receiverNotes = new Set<string>();
      const applyReceiverPacket = (packet: RecordedMidiPacket) => {
        const [status, pitch, velocity] = packet.bytes;
        const command = status & 0xf0;
        const midiChannel = (status & 0x0f) + 1;
        if (command === 0x90 && velocity > 0) receiverNotes.add(`${midiChannel}:${pitch}`);
        if (command === 0x80 || (command === 0x90 && velocity === 0)) receiverNotes.delete(`${midiChannel}:${pitch}`);
      };
      for (const packet of [...portA.getDeliveredWirePackets()]
        .filter(packet => (packet.timestamp ?? packet.sentAtPerfMs) <= disconnectAtPerfMs)
        .sort((a, b) => (a.timestamp ?? a.sentAtPerfMs) - (b.timestamp ?? b.sentAtPerfMs))) {
        applyReceiverPacket(packet);
      }
      assert.ok(receiverNotes.has('1:60'), `[${clearMode}] receiver owns the overlapping C4 before link loss`);
      const latestFutureOffPerfMs = Math.max(
        ...portA.sent
          .filter(packet => (packet.bytes[0] & 0xf0) === 0x80 && packet.bytes[1] === 60 && packet.timestamp! > disconnectAtPerfMs)
          .map(packet => packet.timestamp!),
      );
      const latestAcceptedOnPerfMs = Math.max(
        ...portA.sent
          .filter(packet => (packet.bytes[0] & 0xf0) === 0x90 && packet.bytes[1] === 60)
          .map(packet => packet.timestamp!),
      );
      assert.ok(latestFutureOffPerfMs > disconnectAtPerfMs, `[${clearMode}] a Note Off is still queued when the cable is lost`);

      // Physical disconnect happens now, but deliberately delay its callback.
      // The receiver cannot get either future release while the cable is down.
      portA.state = 'disconnected';
      portA.connection = 'closed';
      perfMs = latestFutureOffPerfMs + 100;
      assert.equal(scheduler.getActiveNoteCount(channelA.id), 0, `[${clearMode}] normal pruning retires completed musical ownership first`);
      assert.equal(scheduler.getActiveNoteCount(channelAUnison.id), 0, `[${clearMode}] the overlapping contributor is pruned too`);
      assert.ok(receiverNotes.has('1:60'), `[${clearMode}] the modeled receiver remains stuck because no Note Off crossed the link`);
      assert.equal(scheduler.getActiveNoteCount(channelB.id), 1, `[${clearMode}] unrelated output ownership remains active`);

      const sentBeforeDisconnectCallback = portA.sent.length;
      scheduler.handlePortDisconnected(portA.id);
      assert.equal(portA.sent.length, sentBeforeDisconnectCallback, `[${clearMode}] disconnect capture sends no message on a lost link`);
      portA.state = 'connected';
      portA.connection = 'closed';
      const reconnect = scheduler.handlePortReconnected(portA.id);
      // Let absent/throwing clear paths pass their old event deadline without
      // requiring a wall-clock MIDI device or an actual hardware connection.
      perfMs += 20;
      await reconnect;

      const recoveryPackets = portA.sent.slice(sentBeforeDisconnectCallback);
      assert.deepEqual(
        recoveryPackets.map(packet => packet.bytes),
        [[0x80, 60, 0]],
        `[${clearMode}] reconnect emits exactly one explicit Note Off for the shared (port, channel, pitch) voice`,
      );
      const recoveryWirePacket = portA.wireQueue.at(-1)!;
      assert.ok(
        recoveryWirePacket.sentAtPerfMs >= latestAcceptedOnPerfMs + 1,
        `[${clearMode}] recovery Note Off is never earlier than the latest accepted Note On`,
      );
      for (const packet of recoveryPackets) applyReceiverPacket(packet);
      assert.equal(receiverNotes.has('1:60'), false, `[${clearMode}] modeled receiver no longer owns the stuck voice`);
      assert.equal(portB.sent.length, 1, `[${clearMode}] reconnect cleanup never substitutes or sends to the sibling output`);
      assert.equal(
        portA.sent.some(packet => (packet.bytes[0] & 0xf0) === 0xb0 && packet.bytes[1] === 123),
        false,
        `[${clearMode}] recovery does not use automatic CC 123`,
      );
    }
  });

  it('restarts reconnect cleanup from the latest disconnect generation when a future Note On is interrupted again', async () => {
    let perfMs = 1000;
    const port = new InstrumentedMidiOutputPort('reconnect-generation-bounce', { nowPerfMs: () => perfMs });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('reconnect-generation-bounce-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const scheduled = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(72, { id: 'generation-bounce-future', duration: 1 }),
      onsetAudioTimeSeconds: 0.1,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(scheduled.sent, true);
    const queuedOn = port.sent.find(packet => packet.bytes[0] === 0x90 && packet.bytes[1] === 72)!;
    const initialPacketCount = port.sent.length;

    port.state = 'disconnected';
    port.connection = 'closed';
    scheduler.handlePortDisconnected(port.id);
    port.state = 'connected';
    port.connection = 'open';
    const firstReconnect = scheduler.handlePortReconnected(port.id);

    // Bounce the same output again while the first recovery is waiting to put a
    // safe Note Off after its future Note On. The second reconnect notification
    // may arrive while that first task is still in flight.
    port.state = 'disconnected';
    port.connection = 'closed';
    scheduler.handlePortDisconnected(port.id);
    port.state = 'connected';
    port.connection = 'open';
    const secondReconnect = scheduler.handlePortReconnected(port.id);
    perfMs = 1300;
    await Promise.all([firstReconnect, secondReconnect]);

    const recoveryPackets = port.sent.slice(initialPacketCount);
    assert.deepEqual(
      recoveryPackets.map(packet => packet.bytes),
      [[0x80, 72, 0]],
      'the invalidated first task does not lose ownership or duplicate cleanup; the new generation releases once',
    );
    assert.ok(recoveryPackets[0].timestamp! >= queuedOn.timestamp! + 1, 'the recovery Note Off remains after its accepted future Note On');
    assert.equal(scheduler.getPortUsability(port.id).usable, true, 'the route resumes only after the fresh generation completes');
  });

  it('holds a clear-less reconnected port until all old timestamped events pass, then sends cleanup before resuming', async () => {
    const perfStart = performance.now();
    const getNowPerfMs = () => 1000 + performance.now() - perfStart;
    const port = new InstrumentedMidiOutputPort('reconnect-no-clear', {
      supportsClear: false,
      nowPerfMs: getNowPerfMs,
    });
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: getNowPerfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('reconnect-no-clear-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const first = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(72, { id: 'no-clear-future', duration: 1 }),
      onsetAudioTimeSeconds: 0.1,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(first.sent, true);
    const queuedOn = port.sent.find(packet => packet.bytes[0] === 0x90 && packet.bytes[1] === 72)!;
    const queuedOff = port.sent.find(packet => packet.bytes[0] === 0x80 && packet.bytes[1] === 72)!;
    assert.ok(queuedOn.timestamp! > 1000, 'the attack is timestamped in the future');
    assert.ok(
      Math.abs((queuedOff.timestamp! - queuedOn.timestamp!) - 125) < 1e-6,
      'the already-queued release remains exactly one 120 BPM step after its Note On',
    );

    port.state = 'disconnected';
    port.connection = 'closed';
    scheduler.handlePortDisconnected(port.id);
    port.state = 'connected';
    port.connection = 'closed';
    const reconnect = scheduler.handlePortReconnected(port.id);
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const blocked = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'must-wait-for-old-queue' }),
      onsetAudioTimeSeconds: 0.2,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(blocked.sent, false, 'new events cannot race the uncancellable old queue');
    assert.equal(blocked.reason, 'port_unavailable');
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'the route is not reported usable during cleanup');
    assert.match(scheduler.getPortUsability(port.id).statusReason ?? '', /reconnect cleanup is pending/i);
    assert.equal(scheduler.describePortInfo(port).usable, false, 'device discovery also reports pending cleanup honestly');
    await reconnect;

    assert.equal(scheduler.getPortUsability(port.id).usable, true, 'route becomes usable after the queue has drained and recovery completes');
    assert.equal(scheduler.describePortInfo(port).usable, true);
    const recoveryOff = port.wireQueue.at(-1);
    assert.ok(
      recoveryOff && recoveryOff.bytes[0] === 0x80 && recoveryOff.bytes[1] === 72,
      'a final timestamp-safe Note Off follows the old scheduled queue',
    );
    assert.ok(
      recoveryOff!.sentAtPerfMs >= queuedOff.timestamp! + 1 &&
        recoveryOff!.timestamp! >= queuedOff.timestamp! + 1,
      `recovery send/timestamp at ${recoveryOff!.sentAtPerfMs}/${recoveryOff!.timestamp} ms follows latest queued release ${queuedOff.timestamp} ms by at least the scheduler 1 ms delta`,
    );
    const resumed = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(69, { id: 'after-no-clear-recovery' }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(resumed.sent, true, 'the configured output resumes after stale events and cleanup have passed');
    assert.equal(port.clearCalls, 0, 'the test path intentionally has no MIDIOutput.clear()');
  });

  it('applies identical clear-less safety Note Off guarantees in stopLiveChannelNote when a future live attack shares a voice with another channel', () => {
    for (const mode of ['absent-clear', 'throwing-clear'] as const) {
      let perfMs = 1000;
      const port = new InstrumentedMidiOutputPort(`hw-live-noclear-${mode}`, {
        supportsClear: mode !== 'absent-clear',
        nowPerfMs: () => perfMs,
      });
      if (mode === 'throwing-clear') {
        port.clear = () => {
          port.clearCalls += 1;
          throw new Error('clear() unsupported');
        };
      }

      const scheduler = new MidiOutputScheduler({
        performanceNowMs: () => perfMs,
        getOutputs: () => new Map([[port.id, port]]),
      });

      const chLiveA = makeChannel(`ch-live-a-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
      });
      const chLiveB = makeChannel(`ch-live-b-${mode}`, {
        midiOutput: { mode: 'external', outputDeviceId: port.id, midiChannel: 1 },
      });

      // Channel A starts holding C4 at 1000 ms; Channel B schedules a look-ahead live C4 at 1060 ms.
      scheduler.scheduleChannelNote({
        channel: chLiveA,
        note: makeNote(60, { id: `live-a-${mode}`, start: 0, duration: 1, velocity: 100 / 127 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
        liveInputMidiChannel: 1,
      });
      scheduler.scheduleChannelNote({
        channel: chLiveB,
        note: makeNote(60, { id: `live-b-${mode}`, start: 0, duration: 1, velocity: 112 / 127 }),
        onsetAudioTimeSeconds: 0.06,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
        liveInputMidiChannel: 1,
      });

      // At 1030 ms, stop Channel B's live C4 before its 1060 ms attack fires.
      perfMs = 1030;
      const stoppedB = scheduler.stopLiveChannelNote(chLiveB.id, 60);
      assert.equal(stoppedB, 1, `[${mode}] stopLiveChannelNote stopped Channel B's pending live note`);
      assert.equal(scheduler.getActiveNoteCount(chLiveB.id), 0);
      assert.equal(scheduler.getActiveNoteCount(chLiveA.id), 1);

      assert.deepEqual(
        port.getDeliveredWirePackets().map(p => ({ bytes: p.bytes, timestamp: p.timestamp })),
        [
          { bytes: [0x90, 60, 100], timestamp: 1000 },
          { bytes: [0x80, 60, 0], timestamp: 1060 },
          { bytes: [0x90, 60, 112], timestamp: 1060 },
          { bytes: [0x80, 60, 0], timestamp: 1061 },
        ],
        `[${mode}] stopLiveChannelNote enqueues deterministic 1061 ms safety Note Off for unavoidable 1060 ms live Note On`,
      );

      // After 1060 ms hardware cutoff passes, stopping Channel A emits no orphan duplicate Note Off and leaves 0 active records.
      perfMs = 1100;
      scheduler.stopLiveChannelNote(chLiveA.id, 60);
      assert.equal(scheduler.getActiveNoteCount(), 0);
      assert.equal(
        port.getDeliveredWirePackets().filter(p => p.bytes[0] === 0x80).length,
        2,
        `[${mode}] strict 1:1 Note On / Note Off parity maintained across live-note cleanup`,
      );
    }
  });
});

/**
 * Lead Engineer finding: bounded recovery-journal capacity was checked only
 * *after* a Note On / tracked CC 64 transition had already been handed to
 * `MIDIOutput.send()`, so the byte reached hardware while the recovery
 * obligation was silently dropped. These regressions pin the fail-closed
 * contract: capacity is preflighted and reserved first, and a rejected event
 * must transmit zero MIDI bytes while never evicting an existing obligation.
 */
describe('MidiOutputScheduler — recovery-capacity preflight fails closed before transmission', () => {
  const noteOnBytesOf = (port: InstrumentedMidiOutputPort): number[] =>
    port.sent.filter(packet => (packet.bytes[0] & 0xf0) === 0x90 && packet.bytes[2] > 0)
      .map(packet => packet.bytes[1]);

  const isSustainOf = (packet: RecordedMidiPacket, value: number): boolean =>
    (packet.bytes[0] & 0xf0) === 0xb0 && packet.bytes[1] === 64 && packet.bytes[2] === value;

  const isChannelModeOf = (packet: RecordedMidiPacket): boolean =>
    (packet.bytes[0] & 0xf0) === 0xb0 && packet.bytes[1] === 123;

  it('refuses a Note On that cannot be journaled, transmits no bytes, and never evicts an existing obligation', () => {
    let perfMs = 1_000;
    // One journal slot per (port, MIDI channel, pitch) wire voice.
    const fillPorts = Array.from({ length: 4 }, (_, index) =>
      new InstrumentedMidiOutputPort(`journal-capacity-${index}`, { nowPerfMs: () => perfMs }),
    );
    const overflowPort = new InstrumentedMidiOutputPort('journal-capacity-overflow', {
      nowPerfMs: () => perfMs,
    });
    const ports = [...fillPorts, overflowPort];
    const outputs = new Map(ports.map(port => [port.id, port]));
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => outputs,
    });
    const channels = new Map<string, Channel>();
    for (const port of fillPorts) {
      for (let midiChannel = 1; midiChannel <= 16; midiChannel += 1) {
        const key = `${port.id}:${midiChannel}`;
        channels.set(key, makeChannel(`journal-capacity-channel-${key}`, {
          midiOutput: { outputDeviceId: port.id, midiChannel, mode: 'external' },
        }));
      }
    }
    const overflowChannel = makeChannel('journal-capacity-overflow-channel', {
      midiOutput: { outputDeviceId: overflowPort.id, midiChannel: 1, mode: 'external' },
    });

    // Fill every journal slot with a distinct, short-lived wire voice. The clock
    // advances 1 ms per voice so each note's 1 ms tail closes before the next
    // onset, keeping `activeNotes` tiny while the journal fills to capacity.
    const expectedJournalSize =
      fillPorts.length * 16 * 128;
    assert.equal(expectedJournalSize, MAX_RECENT_NOTE_RECOVERY_CANDIDATES);
    let scheduledVoices = 0;
    for (const port of fillPorts) {
      for (let midiChannel = 1; midiChannel <= 16; midiChannel += 1) {
        const channel = channels.get(`${port.id}:${midiChannel}`)!;
        for (let pitch = 0; pitch < 128; pitch += 1) {
          const contextSeconds = perfMs / 1000;
          const result = scheduler.scheduleChannelNote({
            channel,
            note: makeNote(pitch, { id: `${port.id}-${midiChannel}-${pitch}`, duration: 0.001 }),
            onsetAudioTimeSeconds: contextSeconds,
            bpm: 120,
            contextCurrentTimeSeconds: contextSeconds,
          });
          assert.equal(result.sent, true, 'filling a free journal slot transmits normally');
          scheduledVoices += 1;
          perfMs += 1;
        }
      }
    }
    assert.equal(scheduledVoices, MAX_RECENT_NOTE_RECOVERY_CANDIDATES);
    assert.equal(scheduler.getActiveNoteCount(), 0, 'the fill uses closed voices, not open ones');

    // The slot that exactly filled the journal was accepted...
    assert.equal(
      noteOnBytesOf(fillPorts[3]).length,
      16 * 128,
      'the boundary Note On that consumes the final journal slot is transmitted',
    );

    // ...but the next *new* wire voice cannot be journaled, so it is refused
    // before transmission and the route is quarantined.
    const overflowContextSeconds = perfMs / 1000;
    const rejected = scheduler.scheduleChannelNote({
      channel: overflowChannel,
      note: makeNote(60, { id: 'journal-capacity-rejected', duration: 0.001 }),
      onsetAudioTimeSeconds: overflowContextSeconds,
      bpm: 120,
      contextCurrentTimeSeconds: overflowContextSeconds,
    });
    assert.equal(rejected.sent, false, 'an unjournalable Note On is rejected');
    assert.equal(rejected.reason, 'send_failed');
    assert.equal(overflowPort.sent.length, 0, 'the rejected Note On transmits no MIDI bytes at all');
    const overflowUsability = scheduler.getPortUsability(overflowPort.id);
    assert.equal(overflowUsability.usable, false, 'the route with no journal slot is quarantined');
    assert.match(overflowUsability.statusReason ?? '', /recovery capacity exhausted/i);
    assert.equal(scheduler.describePortInfo(overflowPort).usable, false);
    assert.match(scheduler.describePortInfo(overflowPort).statusReason ?? '', /recovery capacity exhausted/i);

    // The quarantine is scoped to the affected output and stays fail-closed
    // without ever dismantling another route's existing obligation.
    const blockedRepeat = scheduler.scheduleChannelNote({
      channel: overflowChannel,
      note: makeNote(64, { id: 'journal-capacity-rejected-again', duration: 0.001 }),
      onsetAudioTimeSeconds: overflowContextSeconds,
      bpm: 120,
      contextCurrentTimeSeconds: overflowContextSeconds,
    });
    assert.equal(blockedRepeat.sent, false);
    assert.equal(blockedRepeat.reason, 'port_unavailable');
    assert.equal(overflowPort.sent.length, 0, 'no later attempt on the quarantined route transmits bytes');

    // Refreshing an already-journaled wire voice needs no new capacity, so it
    // must still transmit: capacity gates new obligations, not existing ones.
    const refreshChannel = channels.get(`${fillPorts[0].id}:1`)!;
    const refreshedPortPacketsBefore = fillPorts[0].sent.length;
    const refreshContextSeconds = perfMs / 1000;
    const refreshed = scheduler.scheduleChannelNote({
      channel: refreshChannel,
      note: makeNote(0, { id: 'journal-capacity-refresh', duration: 0.001 }),
      onsetAudioTimeSeconds: refreshContextSeconds,
      bpm: 120,
      contextCurrentTimeSeconds: refreshContextSeconds,
    });
    assert.equal(refreshed.sent, true, 'an existing journal entry is refreshed without new capacity');
    assert.ok(fillPorts[0].sent.length > refreshedPortPacketsBefore);

    // No obligation was evicted to make room: the first route still knows every
    // voice it owns and releases exactly those pitches on reconnect.
    const firstPortPacketsBefore = fillPorts[0].sent.length;
    fillPorts[0].state = 'disconnected';
    fillPorts[0].connection = 'closed';
    scheduler.handlePortDisconnected(fillPorts[0].id);
    fillPorts[0].state = 'connected';
    fillPorts[0].connection = 'open';
    const reconnect = scheduler.handlePortReconnected(fillPorts[0].id);
    perfMs += 5;
    return reconnect.then(() => {
      const recoveryPackets = fillPorts[0].sent.slice(firstPortPacketsBefore);
      assert.equal(recoveryPackets.length, 16 * 128, 'every retained voice is released exactly once');
      assert.equal(recoveryPackets.some(isChannelModeOf), false, 'reconnect recovery never panics with CC 123');
      const releasedVoices = new Set(recoveryPackets.map(packet => `${(packet.bytes[0] & 0x0f) + 1}:${packet.bytes[1]}`));
      assert.equal(releasedVoices.size, 16 * 128, 'the recovery set is one targeted voice per journal entry');
      for (const packet of recoveryPackets) {
        assert.equal(packet.bytes[0] & 0xf0, 0x80, 'every recovery packet is a Note Off');
        assert.equal(packet.bytes[2], 0);
      }
      assert.equal(scheduler.getPortUsability(overflowPort.id).usable, false,
        'the quarantined route stays fail-closed after a sibling route recovers');
      assert.equal(overflowPort.sent.length, 0, 'the quarantined route never regained transmission');
      assert.equal(noteOnBytesOf(fillPorts[1]).length, 16 * 128, 'untouched sibling routes are unaffected');
    });
  });

  it('refuses a tracked CC 64 pedal-down that cannot be journaled while untracked transitions still transmit', async () => {
    let perfMs = 1_000;
    // One sustain slot per (output, MIDI channel); 16 channels per port.
    const portCount = MAX_RECENT_SUSTAIN_RECOVERY_CANDIDATES / 16;
    const ports = Array.from({ length: portCount + 2 }, (_, index) =>
      new InstrumentedMidiOutputPort(`sustain-capacity-${index}`, { nowPerfMs: () => perfMs }),
    );
    const outputs = new Map(ports.map(port => [port.id, port]));
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => outputs,
    });
    const channelFor = (port: InstrumentedMidiOutputPort, midiChannel: number): Channel =>
      makeChannel(`sustain-capacity-channel-${port.id}-${midiChannel}`, {
        midiOutput: { outputDeviceId: port.id, midiChannel, mode: 'external' },
      });

    for (let index = 0; index < portCount; index += 1) {
      const port = ports[index];
      for (let midiChannel = 1; midiChannel <= 16; midiChannel += 1) {
        assert.equal(
          scheduler.sendChannelControlChange(channelFor(port, midiChannel), 64, 127),
          true,
          'filling a free sustain slot transmits normally',
        );
        perfMs += 1;
      }
    }
    assert.equal(
      ports[portCount - 1].sent.filter(packet => isSustainOf(packet, 127)).length,
      16,
      'the boundary pedal-down that consumes the final sustain slot is transmitted',
    );

    // A further pedal-down cannot be journaled: no CC 64 byte may be sent.
    const overflowPort = ports[portCount];
    const overflowChannel = channelFor(overflowPort, 1);
    assert.equal(
      scheduler.sendChannelControlChange(overflowChannel, 64, 127),
      false,
      'an unjournalable tracked pedal-down is rejected',
    );
    assert.equal(overflowPort.sent.length, 0, 'the rejected CC 64 transmits no MIDI bytes at all');
    const overflowUsability = scheduler.getPortUsability(overflowPort.id);
    assert.equal(overflowUsability.usable, false, 'the route that could not journal sustain is quarantined');
    assert.match(overflowUsability.statusReason ?? '', /recovery capacity exhausted/i);
    assert.equal(scheduler.describePortInfo(overflowPort).usable, false);
    assert.match(scheduler.describePortInfo(overflowPort).statusReason ?? '', /recovery capacity exhausted/i);

    // A pedal-up on a route with no held pedal creates no obligation, so it is
    // still safe to transmit while the sustain journal is at capacity.
    const untrackedPort = ports[portCount + 1];
    assert.equal(
      scheduler.sendChannelControlChange(channelFor(untrackedPort, 1), 64, 0),
      true,
      'a pedal-up with no recovery obligation is not blocked by capacity',
    );
    assert.deepEqual(untrackedPort.sent.map(packet => packet.bytes), [[0xb0, 64, 0]]);
    // Non-CC 64 control changes never consume sustain capacity.
    assert.equal(
      scheduler.sendChannelControlChange(channelFor(untrackedPort, 1), 1, 64),
      true,
      'unrelated control changes are unaffected by sustain capacity',
    );
    assert.equal(untrackedPort.sent.length, 2);

    // A pedal-up on a route that already holds the pedal refreshes an existing
    // sustain obligation, so it needs no new slot and must still transmit.
    const heldPortPacketsBefore = ports[0].sent.length;
    assert.equal(
      scheduler.sendChannelControlChange(channelFor(ports[0], 1), 64, 0),
      true,
      'a de-obligating tracked pedal-up is not blocked by a full sustain journal',
    );
    assert.equal(ports[0].sent.length, heldPortPacketsBefore + 1);
    assert.equal(isSustainOf(ports[0].sent[ports[0].sent.length - 1], 0), true);

    // Existing sustain obligations survive untouched: the first route is still
    // gated after its disconnect and releases exactly its own 16 MIDI channels.
    const firstPort = ports[0];
    firstPort.state = 'disconnected';
    firstPort.connection = 'closed';
    scheduler.handlePortDisconnected(firstPort.id);
    firstPort.state = 'connected';
    firstPort.connection = 'open';
    const firstPortPacketsBeforeRecovery = firstPort.sent.length;
    const reconnect = scheduler.handlePortReconnected(firstPort.id);
    perfMs += 5;
    await reconnect;

    const recoveryPackets = firstPort.sent
      .slice(firstPortPacketsBeforeRecovery)
      .filter(packet => isSustainOf(packet, 0));
    assert.equal(recoveryPackets.length, 16, 'every retained sustain obligation is released exactly once');
    assert.deepEqual(
      recoveryPackets.map(packet => (packet.bytes[0] & 0x0f) + 1),
      Array.from({ length: 16 }, (_, index) => index + 1),
      'recovery targets only the affected output/channel set',
    );
    assert.equal(firstPort.sent.some(isChannelModeOf), false, 'sustain recovery never panics with CC 123');
    assert.equal(overflowPort.sent.length, 0, 'the quarantined route stays silent through sibling recovery');
    assert.equal(scheduler.getPortUsability(overflowPort.id).usable, false,
      'the quarantined route remains fail-closed');
    assert.equal(scheduler.getPortUsability(firstPort.id).usable, true,
      'the recovered sibling route resumes normally');
  });

});
/**
 * Lead Engineer finding: an ambiguous `MIDIOutput.send()` failure set a port
 * error but left no pending recovery record, so `handlePortReconnected()` could
 * clear the error and report the route usable while a possibly-delivered Note On
 * or CC64-down was never released. These regressions drive a fake receiver that
 * accepts a message into its simulated hardware state and *then* throws, which is
 * what "ambiguous" actually means: the scheduler has no proof the receiver
 * skipped the message.
 */
describe('MidiOutputScheduler — ambiguous send failure keeps output recovery pending', () => {
  type AmbiguousSendMode = 'accept' | 'deliver_then_throw' | 'discard_then_throw';

  /**
   * Models a receiver's physical state. `deliver_then_throw` applies the message
   * to the simulated hardware and then fails the send, which is precisely the
   * case the scheduler cannot disambiguate.
   */
  class AmbiguousReceiverMidiPort implements MidiOutputPortLike {
    readonly id: string;
    readonly name: string;
    readonly manufacturer = 'Sequential';
    state: 'connected' | 'disconnected' = 'connected';
    connection: 'open' | 'closed' | 'pending' = 'open';
    /** Every message the scheduler attempted, delivered or not. */
    readonly attempted: RecordedMidiPacket[] = [];
    /** Every message the simulated receiver actually acted on. */
    readonly delivered: RecordedMidiPacket[] = [];
    /** Simulated hardware voices, keyed `${midiChannel}:${pitch}`. */
    readonly sounding = new Set<string>();
    /** Simulated hardware pedal state per MIDI channel. */
    readonly pedalDown = new Set<number>();
    clearCalls = 0;
    decideSend: (bytes: number[]) => AmbiguousSendMode = () => 'accept';

    constructor(id: string) {
      this.id = id;
      this.name = id;
    }

    private applyToReceiver(bytes: number[]): void {
      const command = bytes[0] & 0xf0;
      const midiChannel = (bytes[0] & 0x0f) + 1;
      if (command === 0x90 && bytes[2] > 0) {
        this.sounding.add(`${midiChannel}:${bytes[1]}`);
        return;
      }
      if (command === 0x80 || (command === 0x90 && bytes[2] === 0)) {
        this.sounding.delete(`${midiChannel}:${bytes[1]}`);
        return;
      }
      if (command === 0xb0 && bytes[1] === 64) {
        if (bytes[2] >= 64) this.pedalDown.add(midiChannel);
        else this.pedalDown.delete(midiChannel);
        return;
      }
      if (command === 0xb0 && bytes[1] === 123) {
        // Channel-mode "all notes off": modelled so a panic is observable.
        this.sounding.clear();
      }
    }

    send(data: number[] | Uint8Array, timestamp?: number): void {
      const bytes = Array.from(data);
      this.attempted.push({ bytes, timestamp });
      if (this.decideSend(bytes) === 'discard_then_throw') {
        throw new Error(`Port ${this.id} rejected the send`);
      }
      this.delivered.push({ bytes, timestamp });
      this.applyToReceiver(bytes);
      if (this.decideSend(bytes) === 'deliver_then_throw') {
        throw new Error(`Port ${this.id} failed after delivery`);
      }
    }

    clear(): void {
      this.clearCalls += 1;
      // A real `clear()` cannot reach a receiver that already acted on a message,
      // so the simulated hardware state is intentionally left untouched.
    }

    async open(): Promise<MidiOutputPortLike> {
      this.connection = 'open';
      return this;
    }

    deliveredBytes(filter?: (bytes: number[]) => boolean): number[][] {
      const list = filter ? this.delivered.filter(packet => filter(packet.bytes)) : this.delivered;
      return list.map(packet => packet.bytes);
    }
  }

  const noteOnAttempts = (port: AmbiguousReceiverMidiPort): number =>
    port.attempted.filter(packet => (packet.bytes[0] & 0xf0) === 0x90).length;

  const panicPackets = (port: AmbiguousReceiverMidiPort): number[][] =>
    port.deliveredBytes(bytes => (bytes[0] & 0xf0) === 0xb0 && bytes[1] === 123);

  it('releases a Note On whose send threw after delivery, on reconnect and without any disconnect callback', async () => {
    let perfMs = 1_000;
    const port = new AmbiguousReceiverMidiPort('ambiguous-note-on');
    const sibling = new AmbiguousReceiverMidiPort('ambiguous-note-on-sibling');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port], [sibling.id, sibling]]),
    });
    const channel = makeChannel('ambiguous-note-on-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const siblingChannel = makeChannel('ambiguous-note-on-sibling-channel', {
      midiOutput: { outputDeviceId: sibling.id, midiChannel: 1, mode: 'external' },
    });

    // A healthy sibling route carries normal traffic that must never be touched.
    const siblingScheduled = scheduler.scheduleChannelNote({
      channel: siblingChannel,
      note: makeNote(72, { id: 'ambiguous-note-on-sibling-note', duration: 0.5 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
    });
    assert.equal(siblingScheduled.sent, true);
    const siblingPacketsAfterScheduling = sibling.delivered.length;
    assert.equal(siblingPacketsAfterScheduling, 2, 'sibling attack and release were delivered');

    // The attack reaches the simulated receiver, then the send reports failure.
    port.decideSend = () => 'deliver_then_throw';
    const ambiguous = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'ambiguous-note-on', duration: 0.5 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
    });
    assert.equal(ambiguous.sent, false, 'an ambiguous attack is reported as not sent');
    assert.deepEqual([...port.sounding], ['1:60'], 'the simulated receiver did act on the attack');
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'the route is gated immediately');

    // No new Note On may be transmitted while the obligation is unresolved.
    const blocked = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(64, { id: 'ambiguous-note-on-blocked', duration: 0.5 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
    });
    assert.equal(blocked.sent, false);
    assert.equal(blocked.reason, 'port_unavailable');
    assert.equal(noteOnAttempts(port), 1, 'no second attack is even attempted on the gated route');

    // Recovery is driven by reconnection alone — no disconnect callback is fired.
    port.decideSend = () => 'accept';
    const reconnect = scheduler.handlePortReconnected(port.id);
    assert.equal(scheduler.getPortUsability(port.id).usable, false,
      'cleanup in flight still gates the route');
    const duringRecovery = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(67, { id: 'ambiguous-note-on-during-recovery', duration: 0.5 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
    });
    assert.equal(duringRecovery.sent, false, 'no attack may overtake pending cleanup');
    assert.equal(duringRecovery.reason, 'port_unavailable');
    assert.equal(noteOnAttempts(port), 1, 'the in-flight cleanup was not overtaken by a new attack');
    perfMs += 5;
    await reconnect;

    // Exact output/channel/pitch ownership: one targeted Note Off, nothing else.
    assert.deepEqual(
      port.deliveredBytes(),
      [[0x90, 60, 102], [0x80, 60, 0]],
      'the possibly-sounding voice is released exactly once before the route resumes',
    );
    assert.equal(port.sounding.size, 0, 'the simulated voice is no longer stuck');
    assert.equal(panicPackets(port).length, 0, 'recovery never panics with CC 123');
    assert.equal(port.deliveredBytes(bytes => (bytes[0] & 0xf0) === 0xb0).length, 0,
      'no sustain or channel-mode traffic is emitted for a note-only obligation');
    assert.equal(sibling.delivered.length, siblingPacketsAfterScheduling,
      'the sibling output is never substituted or cleaned up');
    assert.equal(scheduler.getPortUsability(port.id).usable, true, 'the route resumes only after cleanup');

    // Transmission resumes strictly after the release.
    const resumed = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(67, { id: 'ambiguous-note-on-resumed', duration: 0.5 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
    });
    assert.equal(resumed.sent, true);
    assert.deepEqual(
      port.deliveredBytes(),
      [[0x90, 60, 102], [0x80, 60, 0], [0x90, 67, 102], [0x80, 67, 0]],
      'the released voice precedes the first post-recovery attack',
    );
    assert.equal(scheduler.getPortUsability(sibling.id).usable, true);
    assert.equal(sibling.delivered.length, siblingPacketsAfterScheduling,
      'the sibling output receives no substituted or cleanup traffic');
  });

  it('resets a sustain pedal-down whose send threw after delivery, on the affected channel only', async () => {
    let perfMs = 2_000;
    const port = new AmbiguousReceiverMidiPort('ambiguous-sustain');
    const sibling = new AmbiguousReceiverMidiPort('ambiguous-sustain-sibling');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port], [sibling.id, sibling]]),
    });
    const channelA = makeChannel('ambiguous-sustain-ch1', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const channelB = makeChannel('ambiguous-sustain-ch2', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 2, mode: 'external' },
    });
    const siblingChannel = makeChannel('ambiguous-sustain-sibling-ch1', {
      midiOutput: { outputDeviceId: sibling.id, midiChannel: 1, mode: 'external' },
    });

    // The pedal-down reaches the receiver, then the send reports failure.
    port.decideSend = bytes => ((bytes[0] & 0xf0) === 0xb0 && bytes[1] === 64 ? 'deliver_then_throw' : 'accept');
    assert.equal(scheduler.sendChannelControlChange(channelA, 64, 127), false);
    assert.deepEqual([...port.pedalDown], [1], 'the simulated receiver is pedal-down');
    assert.equal(scheduler.getPortUsability(port.id).usable, false);

    // A second, unrelated route on the same port cannot slip bytes out meanwhile.
    assert.equal(scheduler.sendChannelControlChange(channelB, 64, 127), false);
    assert.equal(port.attempted.length, 1, 'no further bytes are attempted on the gated route');

    port.decideSend = () => 'accept';
    const reconnect = scheduler.handlePortReconnected(port.id);
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'cleanup in flight still gates the route');
    perfMs += 5;
    await reconnect;

    assert.deepEqual(
      port.deliveredBytes(),
      [[0xb0, 64, 127], [0xb0, 64, 0]],
      'only the affected channel receives a targeted pedal-up before the route resumes',
    );
    assert.equal(port.pedalDown.size, 0, 'the simulated pedal is released');
    assert.equal(panicPackets(port).length, 0, 'sustain recovery never panics with CC 123');
    assert.equal(port.deliveredBytes(bytes => (bytes[0] & 0x0f) === 1).length, 0,
      'the unrelated MIDI channel on the same output is not cleaned up');
    assert.equal(sibling.delivered.length, 0, 'the sibling output receives no cleanup traffic');
    assert.equal(scheduler.getPortUsability(port.id).usable, true);
    assert.equal(
      scheduler.sendChannelControlChange(siblingChannel, 64, 127),
      true,
      'the sibling output still transmits normally',
    );
    assert.deepEqual(sibling.deliveredBytes(), [[0xb0, 64, 127]]);
  });

  it('keeps the original voice obligation when the Note Off send fails', async () => {
    let perfMs = 3_000;
    const port = new AmbiguousReceiverMidiPort('ambiguous-note-off');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('ambiguous-note-off-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });

    // The attack is accepted; the scheduled release is lost.
    port.decideSend = bytes => ((bytes[0] & 0xf0) === 0x80 ? 'discard_then_throw' : 'accept');
    const scheduled = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'ambiguous-note-off', duration: 0.5 }),
      onsetAudioTimeSeconds: 3,
      bpm: 120,
      contextCurrentTimeSeconds: 3,
    });
    assert.equal(scheduled.sent, true, 'the accepted attack is reported as sent');
    assert.deepEqual([...port.sounding], ['1:60'], 'the attack sounds while its release was lost');
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'the failed release gates the route');

    const blocked = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(64, { id: 'ambiguous-note-off-blocked', duration: 0.5 }),
      onsetAudioTimeSeconds: 3,
      bpm: 120,
      contextCurrentTimeSeconds: 3,
    });
    assert.equal(blocked.sent, false);
    assert.equal(blocked.reason, 'port_unavailable');
    assert.equal(noteOnAttempts(port), 1, 'the unresolved voice blocks any further attack');

    // Reconnect only: the retained obligation releases the original voice.
    port.decideSend = () => 'accept';
    const reconnect = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await reconnect;

    assert.deepEqual(
      port.deliveredBytes(),
      [[0x90, 60, 102], [0x80, 60, 0]],
      'the original voice is released exactly once from the retained obligation',
    );
    assert.equal(port.sounding.size, 0);
    assert.equal(panicPackets(port).length, 0);
    assert.equal(scheduler.getPortUsability(port.id).usable, true);
  });

  it('keeps the route gated when cleanup fails and retries the obligation on the next attempt', async () => {
    let perfMs = 4_000;
    const port = new AmbiguousReceiverMidiPort('ambiguous-cleanup-failure');
    const sibling = new AmbiguousReceiverMidiPort('ambiguous-cleanup-failure-sibling');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port], [sibling.id, sibling]]),
    });
    const channel = makeChannel('ambiguous-cleanup-failure-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const siblingChannel = makeChannel('ambiguous-cleanup-failure-sibling-channel', {
      midiOutput: { outputDeviceId: sibling.id, midiChannel: 1, mode: 'external' },
    });

    const siblingScheduled = scheduler.scheduleChannelNote({
      channel: siblingChannel,
      note: makeNote(72, { id: 'ambiguous-cleanup-failure-sibling-note', duration: 0.5 }),
      onsetAudioTimeSeconds: 4,
      bpm: 120,
      contextCurrentTimeSeconds: 4,
    });
    assert.equal(siblingScheduled.sent, true);
    const siblingPacketsAfterScheduling = sibling.delivered.length;

    port.decideSend = bytes => ((bytes[0] & 0xf0) === 0x90 ? 'deliver_then_throw' : 'accept');
    const ambiguous = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'ambiguous-cleanup-failure', duration: 0.5 }),
      onsetAudioTimeSeconds: 4,
      bpm: 120,
      contextCurrentTimeSeconds: 4,
    });
    assert.equal(ambiguous.sent, false);
    assert.deepEqual([...port.sounding], ['1:60']);

    // Every send now fails, so targeted cleanup cannot complete.
    port.decideSend = () => 'discard_then_throw';
    const firstAttempt = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await firstAttempt;
    const gatedStatus = scheduler.getPortUsability(port.id);
    assert.equal(gatedStatus.usable, false, 'a failed cleanup keeps the route gated');
    assert.match(gatedStatus.statusReason ?? '', /recovery|failed|rejected/i);
    assert.deepEqual([...port.sounding], ['1:60'], 'the obligation survives a failed cleanup attempt');
    const blockedAfterFailedCleanup = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(64, { id: 'ambiguous-cleanup-failure-blocked', duration: 0.5 }),
      onsetAudioTimeSeconds: 4,
      bpm: 120,
      contextCurrentTimeSeconds: 4,
    });
    assert.equal(blockedAfterFailedCleanup.sent, false, 'a new attack cannot jump a failed cleanup');
    assert.equal(blockedAfterFailedCleanup.reason, 'port_unavailable');
    assert.equal(noteOnAttempts(port), 1, 'the failed attempt produced no extra attack');
    assert.equal(sibling.delivered.length, siblingPacketsAfterScheduling,
      'a failing route never spills onto a sibling output');

    // The next recovery attempt completes the same obligation exactly once.
    port.decideSend = () => 'accept';
    const retry = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await retry;

    assert.equal(scheduler.getPortUsability(port.id).usable, true, 'the retried cleanup unblocks the route');
    assert.equal(port.sounding.size, 0, 'the retained voice is finally released');
    assert.equal(
      port.deliveredBytes(bytes => (bytes[0] & 0xf0) === 0x80 && bytes[1] === 60).length,
      1,
      'the retried cleanup emits the release exactly once',
    );
    assert.equal(panicPackets(port).length, 0, 'no CC 123 is used to escape the failure');
    assert.equal(sibling.delivered.length, siblingPacketsAfterScheduling,
      'the sibling output still receives no extra traffic');
  });

  it('does not duplicate or restart recovery when a tracked CC 64 cleanup send throws', async () => {
    let perfMs = 5_000;
    const port = new AmbiguousReceiverMidiPort('ambiguous-sustain-cleanup-failure');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('ambiguous-sustain-cleanup-failure-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });

    // The pedal-down is ambiguous: delivered, then the send threw.
    port.decideSend = bytes => ((bytes[0] & 0xf0) === 0xb0 && bytes[1] === 64 ? 'deliver_then_throw' : 'accept');
    assert.equal(scheduler.sendChannelControlChange(channel, 64, 127), false);
    assert.deepEqual([...port.pedalDown], [1]);

    // Now every send fails, including the recovery pedal-up. That failed cleanup
    // send re-enters `trySend`'s catch block: it must merge into the existing
    // pending recovery instead of starting a second disconnect lifecycle.
    port.decideSend = () => 'discard_then_throw';
    const firstAttempt = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await firstAttempt;
    assert.equal(scheduler.getPortUsability(port.id).usable, false,
      'an ambiguous cleanup failure keeps the route gated');
    assert.deepEqual([...port.pedalDown], [1], 'the pedal obligation is retained, not forgotten');
    assert.equal(port.deliveredBytes().length, 1, 'the failed cleanup delivered nothing');

    // The retried cleanup releases the pedal exactly once — no duplicated obligation.
    port.decideSend = () => 'accept';
    const retry = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await retry;
    assert.equal(scheduler.getPortUsability(port.id).usable, true);
    assert.equal(port.pedalDown.size, 0, 'the retained pedal obligation is finally released');
    assert.deepEqual(
      port.deliveredBytes(bytes => (bytes[0] & 0xf0) === 0xb0 && bytes[1] === 64 && bytes[2] === 0),
      [[0xb0, 64, 0]],
      'the merged recovery record releases the pedal exactly once',
    );
    assert.equal(panicPackets(port).length, 0, 'no CC 123 is used');
  });
});

/**
 * Lead Engineer finding: a live MIDI note held longer than
 * `RECENT_NOTE_RECOVERY_RETENTION_MS` outlives its bounded recent-wire journal
 * entry, and `stopLiveChannelNote()` removes the active-note records before it
 * attempts the physical Note Off. A failed release therefore had neither a
 * journal entry nor an active record, so no pending recovery was registered and
 * reconnection could report the route usable with the voice still sounding.
 *
 * The correction carries the known wire voice from the release call site into
 * the send-failure recovery path, without extending journal retention.
 */
describe('MidiOutputScheduler — long-held live note ownership survives a failed release', () => {
  /** Receiver that models physical state and can fail (and withhold) a release. */
  class LiveNoteReceiverPort implements MidiOutputPortLike {
    readonly id: string;
    readonly name: string;
    readonly manufacturer = 'Sequential';
    state: 'connected' | 'disconnected' = 'connected';
    connection: 'open' | 'closed' | 'pending' = 'open';
    readonly attempted: RecordedMidiPacket[] = [];
    readonly delivered: RecordedMidiPacket[] = [];
    readonly sounding = new Set<string>();
    /** When true, every Note Off attempt throws without reaching the receiver. */
    failReleaseSends = false;
    /** When true, every attempt throws without reaching the receiver. */
    failAllSends = false;
    clearCalls = 0;

    constructor(id: string) {
      this.id = id;
      this.name = id;
    }

    send(data: number[] | Uint8Array, timestamp?: number): void {
      const bytes = Array.from(data);
      this.attempted.push({ bytes, timestamp });
      const command = bytes[0] & 0xf0;
      const isRelease = command === 0x80 || (command === 0x90 && bytes[2] === 0);
      if (this.failAllSends || (isRelease && this.failReleaseSends)) {
        throw new Error(`Port ${this.id} rejected the release`);
      }
      this.delivered.push({ bytes, timestamp });
      const midiChannel = (bytes[0] & 0x0f) + 1;
      if (command === 0x90 && bytes[2] > 0) {
        this.sounding.add(`${midiChannel}:${bytes[1]}`);
      } else if (isRelease) {
        this.sounding.delete(`${midiChannel}:${bytes[1]}`);
      } else if (command === 0xb0 && bytes[1] === 123) {
        this.sounding.clear();
      }
    }

    clear(): void {
      this.clearCalls += 1;
      // `clear()` cancels queued messages; it cannot un-sound a delivered attack.
    }

    async open(): Promise<MidiOutputPortLike> {
      this.connection = 'open';
      return this;
    }

    deliveredBytes(filter?: (bytes: number[]) => boolean): number[][] {
      const list = filter ? this.delivered.filter(packet => filter(packet.bytes)) : this.delivered;
      return list.map(packet => packet.bytes);
    }
  }

  const journalOf = (scheduler: MidiOutputScheduler): Map<string, unknown> =>
    (scheduler as unknown as { recentNoteRecoveryCandidates: Map<string, unknown> })
      .recentNoteRecoveryCandidates;

  const journalKey = (outputDeviceId: string, midiChannel: number, pitch: number): string =>
    JSON.stringify([outputDeviceId, midiChannel, pitch]);

  const noteOnAttempts = (port: LiveNoteReceiverPort): number =>
    port.attempted.filter(packet => (packet.bytes[0] & 0xf0) === 0x90 && packet.bytes[2] > 0).length;

  it('releases a live voice whose Note Off failed after the journal retention expired', async () => {
    let perfMs = 1_000;
    const port = new LiveNoteReceiverPort('long-held-live-note');
    const sibling = new LiveNoteReceiverPort('long-held-live-note-sibling');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port], [sibling.id, sibling]]),
    });
    const channel = makeChannel('long-held-live-note-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const siblingChannel = makeChannel('long-held-live-note-sibling-channel', {
      midiOutput: { outputDeviceId: sibling.id, midiChannel: 1, mode: 'external' },
    });

    // A healthy sibling route carries traffic that must never be touched.
    const siblingScheduled = scheduler.scheduleChannelNote({
      channel: siblingChannel,
      note: makeNote(72, { id: 'long-held-live-note-sibling', duration: 0.5 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
    });
    assert.equal(siblingScheduled.sent, true);
    const siblingPacketsAfterScheduling = sibling.delivered.length;

    // 1. The live Note On is delivered and its active ownership is stored.
    const attack = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'long-held-live-note', duration: 1 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
      liveInputMidiChannel: 1,
    });
    assert.equal(attack.sent, true);
    assert.deepEqual([...port.sounding], ['1:60'], 'the live attack is sounding');
    assert.equal(scheduler.getActiveNoteCount(channel.id), 1, 'the live note is owned');
    assert.equal(
      journalOf(scheduler).has(journalKey(port.id, 1, 60)),
      true,
      'the accepted attack is journaled',
    );

    // 2. The key is held far beyond the bounded journal retention.
    perfMs += RECENT_NOTE_RECOVERY_RETENTION_MS + 5_000;

    // 3. Ordinary pruning expires the journal entry while the note stays owned.
    assert.equal(
      scheduler.getActiveNoteCount(channel.id),
      1,
      'the live note is still owned after the retention window',
    );
    assert.equal(
      journalOf(scheduler).has(journalKey(port.id, 1, 60)),
      false,
      'the bounded recent-wire journal no longer remembers the voice',
    );

    // 4. The release send fails without reaching the receiver.
    port.failReleaseSends = true;
    const stopped = scheduler.stopLiveChannelNote(channel.id, 60, 1);
    assert.equal(stopped, 1, 'the held live note ownership was stopped');

    // 5. The receiver still has the voice sounding.
    assert.deepEqual([...port.sounding], ['1:60'], 'the receiver kept the voice after the failed release');
    assert.equal(
      port.attempted.filter(packet => (packet.bytes[0] & 0xf0) === 0x80).length,
      1,
      'exactly one release was attempted',
    );

    // The failed release must gate the route rather than silently resume.
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'the failed release gates the route');
    assert.equal(
      journalOf(scheduler).has(journalKey(port.id, 1, 60)),
      false,
      'the obligation is carried without reviving the journal',
    );

    // 8. A new Note On cannot overtake the unresolved cleanup.
    const blocked = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(67, { id: 'long-held-live-note-blocked', duration: 0.5 }),
      onsetAudioTimeSeconds: perfMs / 1000,
      bpm: 120,
      contextCurrentTimeSeconds: perfMs / 1000,
    });
    assert.equal(blocked.sent, false, 'no new attack may jump the pending recovery');
    assert.equal(blocked.reason, 'port_unavailable');
    assert.equal(noteOnAttempts(port), 1, 'the blocked attack transmitted nothing');

    // 6. Reconnection alone performs the cleanup — no disconnect callback is used.
    port.failReleaseSends = false;
    const reconnect = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await reconnect;

    // 7. The targeted Note Off is delivered before the route becomes usable.
    assert.deepEqual(
      port.deliveredBytes(),
      [[0x90, 60, 102], [0x80, 60, 0]],
      'exactly one targeted Note Off releases the long-held voice',
    );
    assert.equal(port.sounding.size, 0, 'the simulated receiver voice is finally released');
    assert.equal(scheduler.getPortUsability(port.id).usable, true, 'the route resumes only after cleanup');

    // 9. No panic, no unrelated-channel traffic, no sibling substitution.
    assert.equal(
      port.deliveredBytes(bytes => (bytes[0] & 0xf0) === 0xb0).length,
      0,
      'no control-change or CC 123 panic traffic is emitted',
    );
    assert.equal(
      port.deliveredBytes(bytes => (bytes[0] & 0x0f) !== 0).length,
      0,
      'only the affected MIDI channel is touched',
    );
    assert.equal(
      sibling.delivered.length,
      siblingPacketsAfterScheduling,
      'the sibling output is never substituted or cleaned up',
    );
    assert.equal(scheduler.getActiveNoteCount(channel.id), 0, 'no stale local ownership remains');

    // The released voice precedes the first post-recovery attack.
    const resumed = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(67, { id: 'long-held-live-note-resumed', duration: 0.5 }),
      onsetAudioTimeSeconds: perfMs / 1000,
      bpm: 120,
      contextCurrentTimeSeconds: perfMs / 1000,
      liveInputMidiChannel: 1,
    });
    assert.equal(resumed.sent, true);
    assert.deepEqual(
      port.deliveredBytes().slice(0, 3),
      [[0x90, 60, 102], [0x80, 60, 0], [0x90, 67, 102]],
      'the recovered release precedes the next attack',
    );
  });

  it('does not retain stale ownership or duplicate releases when the live Note Off succeeds', async () => {
    let perfMs = 1_000;
    const port = new LiveNoteReceiverPort('long-held-live-note-success');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('long-held-live-note-success-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });

    const attack = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'long-held-live-note-success', duration: 1 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
      liveInputMidiChannel: 1,
    });
    assert.equal(attack.sent, true);
    assert.deepEqual([...port.sounding], ['1:60']);

    // Held past the journal retention, then released successfully.
    perfMs += RECENT_NOTE_RECOVERY_RETENTION_MS + 5_000;
    assert.equal(scheduler.getActiveNoteCount(), 1);
    assert.equal(
      journalOf(scheduler).has(journalKey(port.id, 1, 60)),
      false,
      'the journal expired the long-held voice',
    );

    const stopped = scheduler.stopLiveChannelNote(channel.id, 60, 1);
    assert.equal(stopped, 1);
    assert.deepEqual(
      port.deliveredBytes(),
      [[0x90, 60, 102], [0x80, 60, 0]],
      'the successful release is delivered exactly once',
    );
    assert.equal(port.sounding.size, 0, 'the receiver voice is released');
    assert.equal(scheduler.getActiveNoteCount(), 0, 'no stale ownership is retained');
    assert.equal(
      scheduler.getPortUsability(port.id).usable,
      true,
      'a successful release never gates the route',
    );

    // A later reconnection must not replay anything: no obligation was registered.
    const reconnect = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await reconnect;
    assert.equal(port.attempted.length, 2, 'reconnection sends no duplicate Note Off');
    assert.deepEqual(port.deliveredBytes(), [[0x90, 60, 102], [0x80, 60, 0]]);

    // The same pitch can be attacked and released again without duplication.
    const again = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'long-held-live-note-success-again', duration: 1 }),
      onsetAudioTimeSeconds: perfMs / 1000,
      bpm: 120,
      contextCurrentTimeSeconds: perfMs / 1000,
      liveInputMidiChannel: 1,
    });
    assert.equal(again.sent, true);
    assert.equal(scheduler.stopLiveChannelNote(channel.id, 60, 1), 1);
    assert.equal(
      port.deliveredBytes(bytes => (bytes[0] & 0xf0) === 0x80 && bytes[1] === 60).length,
      2,
      'one release per accepted attack, never a duplicate',
    );
    assert.equal(port.sounding.size, 0);
    assert.equal(scheduler.getActiveNoteCount(), 0);
  });

  it('carries the obligation when the journal entry is stale but not yet pruned', async () => {
    let perfMs = 1_000;
    const port = new LiveNoteReceiverPort('stale-journal-live-note');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('stale-journal-live-note-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });

    const attack = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'stale-journal-live-note', duration: 1 }),
      onsetAudioTimeSeconds: 1,
      bpm: 120,
      contextCurrentTimeSeconds: 1,
      liveInputMidiChannel: 1,
    });
    assert.equal(attack.sent, true);
    const key = journalKey(port.id, 1, 60);
    const expiresAtPerfMs = (
      journalOf(scheduler).get(key) as { expiresAtPerfMs: number }
    ).expiresAtPerfMs;

    // Prune just before expiry so the entry survives, then step past expiry while
    // the prune throttle suppresses the next sweep: the journal still *holds* an
    // entry for the voice, but that entry is no longer evidence of anything.
    perfMs = expiresAtPerfMs - 500;
    assert.equal(scheduler.getActiveNoteCount(channel.id), 1);
    assert.equal(journalOf(scheduler).has(key), true, 'the entry is still inside its retention window');

    perfMs = expiresAtPerfMs + 200;
    assert.equal(scheduler.getActiveNoteCount(channel.id), 1, 'the live note is still owned');
    const stale = journalOf(scheduler).get(key) as { expiresAtPerfMs: number } | undefined;
    assert.notEqual(stale, undefined, 'the throttled sweep has not removed the expired entry yet');
    assert.ok((stale as { expiresAtPerfMs: number }).expiresAtPerfMs <= perfMs, 'the entry is stale');

    // Transport cleanup drops its active records before releasing, so this also
    // proves the obligation travels with the release attempt itself. Every send
    // fails here, including the cleanup's own CC 123.
    port.failAllSends = true;
    scheduler.cleanupAll('stop');
    assert.deepEqual([...port.sounding], ['1:60'], 'the receiver keeps the voice after the failed cleanup');
    assert.equal(port.delivered.length, 1, 'the failed cleanup delivered nothing');
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'the failed cleanup gates the route');

    port.failAllSends = false;
    const reconnect = scheduler.handlePortReconnected(port.id);
    perfMs += 5;
    await reconnect;

    assert.deepEqual(
      port.deliveredBytes(),
      [[0x90, 60, 102], [0x80, 60, 0]],
      'ownership evidence comes from the live records, not the stale journal entry',
    );
    assert.equal(port.sounding.size, 0);
    assert.equal(scheduler.getPortUsability(port.id).usable, true);
    assert.equal(port.deliveredBytes(bytes => (bytes[0] & 0xf0) === 0xb0).length, 0, 'no CC traffic');
  });
});

/**
 * Lead Engineer finding: `trySend()` did not enforce the pending-recovery gate
 * itself. Every caller resolves a *usable* port up front, but a failure part-way
 * through a multi-event operation converts that output into pending recovery
 * while the caller keeps iterating with the port reference it already holds — so
 * a later Note On in the same batch could reach the wire, land outside the
 * recovery snapshot that had just been taken, and survive reconnection.
 *
 * These regressions drive `commitTransportNote()` → `reconcileVoiceContributors()`
 * → `requeueActivePortEvents()` through a receiver that records every attempt,
 * can reject one release without delivering it, and can observe route usability
 * at the moment each message is transmitted.
 */
describe('MidiOutputScheduler — pending recovery gates transmission at the send boundary', () => {
  class GateProbeReceiverPort implements MidiOutputPortLike {
    readonly id: string;
    readonly name: string;
    readonly manufacturer = 'Roland';
    state: 'connected' | 'disconnected' = 'connected';
    connection: 'open' | 'closed' | 'pending' = 'open';
    readonly attempted: RecordedMidiPacket[] = [];
    readonly delivered: RecordedMidiPacket[] = [];
    readonly sounding = new Set<string>();
    /** Number of upcoming release sends that throw without reaching the receiver. */
    failReleaseAttempts = 0;
    clearCalls = 0;
    /** Observes scheduler state at the moment a message is actually transmitted. */
    onDelivered?: (packet: RecordedMidiPacket) => void;

    constructor(id: string) {
      this.id = id;
      this.name = id;
    }

    send(data: number[] | Uint8Array, timestamp?: number): void {
      const bytes = Array.from(data);
      this.attempted.push({ bytes, timestamp });
      const command = bytes[0] & 0xf0;
      const isRelease = command === 0x80 || (command === 0x90 && bytes[2] === 0);
      if (isRelease && this.failReleaseAttempts > 0) {
        this.failReleaseAttempts -= 1;
        throw new Error(`Port ${this.id} rejected the release`);
      }
      this.delivered.push({ bytes, timestamp });
      const midiChannel = (bytes[0] & 0x0f) + 1;
      if (command === 0x90 && bytes[2] > 0) {
        this.sounding.add(`${midiChannel}:${bytes[1]}`);
      } else if (isRelease) {
        this.sounding.delete(`${midiChannel}:${bytes[1]}`);
      }
      this.onDelivered?.({ bytes, timestamp });
    }

    clear(): void {
      this.clearCalls += 1;
    }

    async open(): Promise<MidiOutputPortLike> {
      this.connection = 'open';
      return this;
    }

    deliveredBytes(filter?: (bytes: number[]) => boolean): number[][] {
      const list = filter ? this.delivered.filter(packet => filter(packet.bytes)) : this.delivered;
      return list.map(packet => packet.bytes);
    }
  }

  const transportStep = (absoluteStep: number, seconds: number) => ({
    takeGeneration: 1,
    absoluteStep,
    step: absoluteStep % 16,
    stepAudioTimeSeconds: seconds,
    unswungStepAudioTimeSeconds: seconds,
    grooveOffsetSeconds: 0,
    bpm: 120,
    mode: 'song' as const,
    patternLoopSteps: null,
    contextCurrentTimeSeconds: seconds,
  });

  /**
   * Drives one real multi-event scheduler operation: an open C4 whose 1125 ms
   * release is already queued, a future E4 attack at 1250 ms, and then an
   * overlapping C4 whose commit path clears the port queue and replays every
   * pending event through `requeueActivePortEvents()`.
   */
  const runOverlapBatch = (failFirstRelease: boolean) => {
    const clock = { now: 1_000 };
    const port = new GateProbeReceiverPort('gated-batch');
    const sibling = new GateProbeReceiverPort('gated-batch-sibling');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => clock.now,
      getOutputs: () => new Map([[port.id, port], [sibling.id, sibling]]),
    });
    const lead = makeChannel('gated-batch-lead', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const siblingChannel = makeChannel('gated-batch-sibling-channel', {
      midiOutput: { outputDeviceId: sibling.id, midiChannel: 1, mode: 'external' },
    });

    scheduler.beginTransportTake(1, 'song');
    scheduler.beginTransportStep(transportStep(0, 0));
    assert.equal(
      scheduler.scheduleChannelNote({
        channel: lead,
        note: makeNote(60, { id: 'gated-batch-c4', duration: 1 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      }).sent,
      true,
    );
    assert.equal(
      scheduler.scheduleChannelNote({
        channel: lead,
        note: makeNote(64, { id: 'gated-batch-e4', start: 0.25, duration: 0.5 }),
        onsetAudioTimeSeconds: 0.25,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      }).sent,
      true,
    );
    assert.equal(
      scheduler.scheduleChannelNote({
        channel: siblingChannel,
        note: makeNote(72, { id: 'gated-batch-sibling', duration: 1 }),
        onsetAudioTimeSeconds: 0,
        bpm: 120,
        contextCurrentTimeSeconds: 0,
      }).sent,
      true,
    );
    scheduler.endTransportStep();

    const state = {
      scheduler,
      port,
      sibling,
      lead,
      clock,
      attemptsBefore: port.attempted.length,
      deliveredBefore: port.delivered.length,
      siblingAttemptsBefore: sibling.attempted.length,
      siblingDeliveredBefore: sibling.delivered.length,
    };

    if (failFirstRelease) port.failReleaseAttempts = 1;
    scheduler.scheduleChannelNote({
      channel: lead,
      note: makeNote(60, { id: 'gated-batch-overlap', start: 0.5, duration: 1, velocity: 0.9 }),
      onsetAudioTimeSeconds: 0.0625,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    return state;
  };

  const batchBytes = (state: ReturnType<typeof runOverlapBatch>): number[][] =>
    state.port.attempted.slice(state.attemptsBefore).map(packet => packet.bytes);

  it('replays the whole cached-port batch when nothing fails (control)', () => {
    const state = runOverlapBatch(false);
    assert.deepEqual(
      batchBytes(state),
      [
        [0x80, 60, 0],
        [0x90, 60, 114],
        [0x80, 60, 0],
        [0x90, 64, 102],
        [0x80, 64, 0],
      ],
      'the batch commits its release and attack, then requeueActivePortEvents replays the pending events',
    );
    assert.equal(state.port.delivered.length, state.deliveredBefore + 5, 'every event was transmitted');
  });

  it('stops a cached-port batch at the send boundary once recovery begins', async () => {
    // 2. An early Note Off of the batch fails ambiguously (throws, not delivered)
    //    while the caller keeps iterating with the port it already resolved.
    const state = runOverlapBatch(true);
    const { port, sibling, scheduler, lead } = state;

    // 3. + 4. The batch keeps running, but the gate rejects everything after the
    //    failed release: no commit Note On, no requeued Note Off or attack, no CC.
    assert.deepEqual(
      batchBytes(state),
      [[0x80, 60, 0]],
      'nothing is transmitted after the failed release, not even an attempt',
    );
    assert.equal(port.delivered.length, state.deliveredBefore, 'no post-failure message reached the receiver');

    // 5. The route stays unavailable.
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'the failed release gates the route');

    // 8. A later attack cannot overtake the pending cleanup.
    const blocked = scheduler.scheduleChannelNote({
      channel: lead,
      note: makeNote(67, { id: 'gated-batch-blocked', start: 0.5, duration: 0.5 }),
      onsetAudioTimeSeconds: 0.5,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(blocked.sent, false, 'a new attack is refused while cleanup is pending');
    assert.equal(blocked.reason, 'port_unavailable');
    assert.deepEqual(batchBytes(state), [[0x80, 60, 0]], 'the refused attack attempted no bytes');

    // 9. No panic, no sibling traffic, no unrelated channel.
    assert.equal(
      port.attempted.some(packet => (packet.bytes[0] & 0xf0) === 0xb0),
      false,
      'the gated batch emits no CC traffic, let alone a CC 123 panic',
    );
    assert.equal(sibling.attempted.length, state.siblingAttemptsBefore, 'the sibling output is untouched');
    assert.equal(sibling.delivered.length, state.siblingDeliveredBefore);
    assert.deepEqual(
      [...new Set(port.attempted.map(packet => (packet.bytes[0] & 0x0f) + 1))],
      [1],
      'only the affected MIDI channel is addressed',
    );

    // 7. Recovery cleanup is explicitly authorized through the gate: both owed
    //    voices are released while the route still reports unusable.
    state.clock.now = 1_400;
    const usabilityWhenCleaningUp: boolean[] = [];
    port.onDelivered = () => usabilityWhenCleaningUp.push(scheduler.getPortUsability(port.id).usable);
    // 6. Reconnection alone performs the cleanup — no disconnect callback is used.
    await scheduler.handlePortReconnected(port.id);

    assert.deepEqual(
      usabilityWhenCleaningUp,
      [false, false],
      'every cleanup send passes the gate while the route is still closed',
    );
    assert.deepEqual(port.deliveredBytes().slice(-2), [[0x80, 60, 0], [0x80, 64, 0]],
      'each accepted voice is released exactly once by targeted Note Offs');
    assert.deepEqual(port.deliveredBytes(), [
      [0x90, 60, 102],
      [0x80, 60, 0],
      [0x90, 64, 102],
      [0x80, 64, 0],
      [0x80, 60, 0],
      [0x80, 64, 0],
    ]);
    assert.equal(scheduler.getPortUsability(port.id).usable, true, 'the route resumes after cleanup');

    // Ordinary traffic is gated only while recovery is pending.
    const resumed = scheduler.scheduleChannelNote({
      channel: lead,
      note: makeNote(67, { id: 'gated-batch-resumed', start: 0.5, duration: 0.5 }),
      onsetAudioTimeSeconds: 0.5,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    assert.equal(resumed.sent, true, 'the recovered route transmits again');
    assert.deepEqual(port.deliveredBytes().slice(6), [[0x90, 67, 102], [0x80, 67, 0]],
      'the post-recovery attack is the first new byte after the cleanup');
  });

  it('keeps a failed cleanup retryable while refusing ordinary traffic in between', async () => {
    let perfMs = 1_000;
    const port = new GateProbeReceiverPort('gated-retry');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('gated-retry-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });

    assert.equal(
      scheduler.scheduleChannelNote({
        channel,
        note: makeNote(60, { id: 'gated-retry-note', duration: 1 }),
        onsetAudioTimeSeconds: 1,
        bpm: 120,
        contextCurrentTimeSeconds: 1,
        liveInputMidiChannel: 1,
      }).sent,
      true,
    );
    assert.deepEqual([...port.sounding], ['1:60']);

    // The live release throws without delivering, which opens pending recovery.
    port.failReleaseAttempts = 1;
    assert.equal(scheduler.stopLiveChannelNote(channel.id, 60, 1), 1);
    assert.equal(scheduler.getPortUsability(port.id).usable, false);

    perfMs += 50;
    // The first cleanup attempt fails too: the route must stay gated and keep the
    // obligation for another attempt.
    port.failReleaseAttempts = 1;
    await scheduler.handlePortReconnected(port.id);
    assert.equal(scheduler.getPortUsability(port.id).usable, false, 'a failed cleanup keeps the route closed');
    assert.deepEqual([...port.sounding], ['1:60'], 'the voice is still sounding on the receiver');

    // Ordinary traffic is still refused and transmits nothing.
    const attemptsBefore = port.attempted.length;
    const blocked = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(72, { id: 'gated-retry-blocked', duration: 0.5 }),
      onsetAudioTimeSeconds: perfMs / 1000,
      bpm: 120,
      contextCurrentTimeSeconds: perfMs / 1000,
    });
    assert.equal(blocked.sent, false);
    assert.equal(blocked.reason, 'port_unavailable');
    assert.equal(port.attempted.length, attemptsBefore, 'the refused attack attempts no bytes');

    // The retry delivers exactly one release and only then reopens the route.
    perfMs += 50;
    await scheduler.handlePortReconnected(port.id);
    assert.equal(scheduler.getPortUsability(port.id).usable, true);
    assert.deepEqual([...port.sounding], [], 'the retried cleanup released the voice once');
    assert.deepEqual(
      port.deliveredBytes().filter(bytes => (bytes[0] & 0xf0) === 0x80),
      [[0x80, 60, 0]],
      'exactly one Note Off is delivered across both cleanup attempts',
    );
  });

  it('keeps a voice whose release the gate blocked recoverable', async () => {
    // Two long-held live notes: both journal entries have expired, so only the
    // release attempts themselves can carry ownership. The first cleanup send
    // fails and closes the gate; the second is refused but must still be recorded,
    // otherwise that voice would be lost and left sounding after recovery.
    let perfMs = 1_000;
    const port = new GateProbeReceiverPort('gated-blocked-release');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => perfMs,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('gated-blocked-release-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });

    for (const pitch of [60, 72]) {
      assert.equal(
        scheduler.scheduleChannelNote({
          channel,
          note: makeNote(pitch, { id: `gated-blocked-release-${pitch}`, duration: 1 }),
          onsetAudioTimeSeconds: 1,
          bpm: 120,
          contextCurrentTimeSeconds: 1,
          liveInputMidiChannel: 1,
        }).sent,
        true,
      );
    }
    assert.deepEqual([...port.sounding], ['1:60', '1:72']);

    perfMs += RECENT_NOTE_RECOVERY_RETENTION_MS + 5_000;
    const attemptsBefore = port.attempted.length;
    port.failReleaseAttempts = 1;
    scheduler.cleanupAll('stop');

    // Only the first release was even attempted; the second was gated outright.
    assert.deepEqual(
      port.attempted.slice(attemptsBefore).map(packet => packet.bytes),
      [[0x80, 60, 0]],
      'the gate stops the cleanup batch at the failed release',
    );
    assert.equal(
      port.attempted.slice(attemptsBefore).some(packet => (packet.bytes[0] & 0xf0) === 0xb0),
      false,
      'no CC 123 panic escapes the gate either',
    );
    assert.equal(scheduler.getPortUsability(port.id).usable, false);

    // Both voices are released on reconnect, including the one whose release was
    // blocked rather than attempted.
    await scheduler.handlePortReconnected(port.id);
    assert.deepEqual(
      port.deliveredBytes().filter(bytes => (bytes[0] & 0xf0) === 0x80),
      [[0x80, 60, 0], [0x80, 72, 0]],
      'the blocked release still contributed its ownership evidence',
    );
    assert.deepEqual([...port.sounding], []);
    assert.equal(scheduler.getPortUsability(port.id).usable, true);
  });

  it('the sticky capacity quarantine rejects cached-port queue replay', () => {
    const clock = { now: 1_000 };
    const port = new GateProbeReceiverPort('gated-capacity');
    const scheduler = new MidiOutputScheduler({
      performanceNowMs: () => clock.now,
      getOutputs: () => new Map([[port.id, port]]),
    });
    const channel = makeChannel('gated-capacity-channel', {
      midiOutput: { outputDeviceId: port.id, midiChannel: 1, mode: 'external' },
    });
    const requeue = () =>
      (scheduler as unknown as {
        requeueActivePortEvents: (
          port: MidiOutputPortLike,
          outputDeviceId: string,
          nowPerfMs: number,
        ) => void;
      }).requeueActivePortEvents(port, port.id, clock.now);

    scheduler.beginTransportTake(1, 'song');
    scheduler.beginTransportStep(transportStep(0, 0));
    scheduler.scheduleChannelNote({
      channel,
      note: makeNote(60, { id: 'gated-capacity-held', duration: 1 }),
      onsetAudioTimeSeconds: 0,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.scheduleChannelNote({
      channel,
      note: makeNote(64, { id: 'gated-capacity-future', start: 0.25, duration: 0.5 }),
      onsetAudioTimeSeconds: 0.25,
      bpm: 120,
      contextCurrentTimeSeconds: 0,
    });
    scheduler.endTransportStep();

    // Quarantine the output exactly as the capacity preflight does.
    (scheduler as unknown as { blockOutputForRecoveryCapacity: (id: string) => void })
      .blockOutputForRecoveryCapacity(port.id);
    const usability = scheduler.getPortUsability(port.id);
    assert.equal(usability.usable, false);
    assert.match(usability.statusReason ?? '', /recovery capacity exhausted/i);

    // The loop still owns pending work — so silence proves the gate, not an
    // empty queue.
    assert.ok(scheduler.getActiveNoteCount() > 0, 'the route still owns voices with pending events');
    const attemptsBefore = port.attempted.length;
    requeue();
    assert.equal(port.attempted.length, attemptsBefore, 'a quarantined output accepts no cached-port queue replay');

    clock.now += 10;
    const blocked = scheduler.scheduleChannelNote({
      channel,
      note: makeNote(67, { id: 'gated-capacity-blocked', duration: 0.5 }),
      onsetAudioTimeSeconds: 0.01,
      bpm: 120,
      contextCurrentTimeSeconds: 0.01,
    });
    assert.equal(blocked.sent, false);
    assert.equal(blocked.reason, 'port_unavailable');
    assert.equal(port.attempted.length, attemptsBefore, 'the quarantine stays fail-closed');
  });
});
