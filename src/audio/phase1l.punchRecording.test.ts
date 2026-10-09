/**
 * Phase 1L — punch-in / punch-out recording through the PRODUCTION path:
 *
 *   audioEngine.beginPunchRecording → planPunchCapture (punch policy)
 *   → CountInScheduler (the Phase 1K count-in, planned backwards from punch-in)
 *   → RecordingEngine.start() (MediaRecorder opens HERE, at punch-in)
 *   → PunchCaptureWindow (the punch-out stop moment)
 *   → RecordingEngine.stop() → planPunchClipPlacement → playlist clip
 *
 * The harness is the Phase 1K one: a fake AudioContext records every click
 * oscillator and every stop() call, a delay-aware fake `window` timer pump keeps
 * the audio clock and the scheduled moments deterministic, and the browser
 * recording APIs use the same structural fakes as `recordingEngine.test.ts`.
 * This drives the real `RecordingEngine` and the real `audioEngine` punch path —
 * not a UI mock. What is NOT exercised is a real microphone/codec
 * (browser-only; see the report's limitations).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine, CountInCancelledError, PunchCancelledError } from './audioEngine';
import { RecordingEngine } from './recordingEngine';
import { createPunchRecordingPlaylistClip, planPunchClipPlacement, trimAudioBufferToSeconds, getRecordingAudioBufferId } from './recordingPipeline';
import type { AudioRecording, PlaylistTrack } from '../types/daw';

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
  start(): void {}
  stop(): void {}
  addEventListener(): void {}
  connect(): void {}
}

class FakeClickOscillator {
  frequencyHz = 0;
  startAt = Number.NaN;
  stopCalls: number[] = [];
  disconnected = false;
  frequency = { value: 440, setValueAtTime: (v: number) => { this.frequencyHz = v; }, exponentialRampToValueAtTime() {} };
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
  start(t: number): void { this.startAt = t; }
  stop(t: number): void { this.stopCalls.push(t); }
  addEventListener(): void {}
  /** Web Audio: the last stop() wins; stopping at/before start means silence. */
  get audible(): boolean {
    const lastStop = this.stopCalls[this.stopCalls.length - 1];
    return !this.disconnected && lastStop !== undefined && lastStop > this.startAt;
  }
}

/** A decoded buffer that can be sliced, so the punch trim is exercised for real. */
const makeDecodedBuffer = (seconds: number, sampleRate = 1000): AudioBuffer => {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = (i % 10) / 10;
  return {
    numberOfChannels: 1,
    length,
    duration: length / sampleRate,
    sampleRate,
    getChannelData: () => data,
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
};

const createFakeBuffer = (numberOfChannels: number, length: number, sampleRate: number): AudioBuffer => {
  const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  return {
    numberOfChannels,
    length,
    duration: length / sampleRate,
    sampleRate,
    getChannelData: (index: number) => channels[index],
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
};

class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';
  destination = {};
  readonly oscillators: FakeClickOscillator[] = [];
  decoded = makeDecodedBuffer(10);
  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }
  async resume(): Promise<void> {}
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return createFakeBuffer(numberOfChannels, length, sampleRate);
  }
  createOscillator(): FakeClickOscillator {
    const osc = new FakeClickOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect(): void {}, disconnect(): void {} };
  }
  async decodeAudioData(): Promise<AudioBuffer> { return this.decoded; }
}

/** Records the audio-clock moments a capture opened and closed at. */
class FakeTrack { stopped = false; stop(): void { this.stopped = true; } }
class FakeStream { readonly track = new FakeTrack(); getTracks(): FakeTrack[] { return [this.track]; } }

class FakeMediaRecorder {
  static isTypeSupported(): boolean { return true; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  startedAtAudioTime = Number.NaN;
  stoppedAtAudioTime = Number.NaN;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: FakeStream, readonly clock?: () => number) {}
  start(): void {
    this.startedAtAudioTime = this.clock?.() ?? Number.NaN;
    this.state = 'recording';
  }
  pause(): void {}
  resume(): void {}
  stop(): void {
    this.stoppedAtAudioTime = this.clock?.() ?? Number.NaN;
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['recorded'], { type: 'audio/webm' }) });
      void this.onstop?.();
    });
  }
}

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;
const realWindow = (globalThis as any).window;
interface PumpedTimer { at: number; fn: () => void; cleared: boolean }
let timers: PumpedTimer[] = [];
let saved: EngineInternals = {};
const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'activeClipSources', 'activeClipSourceLanes',
  'activeClipSourceChannels', 'activeClipChannelVolumes', 'isPlaying',
  'bpm', 'swing', 'meter', 'metronome', 'currentStep', 'currentBar',
  'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers',
  'masterGain', 'mixerChannels', 'isOfflineRendering', 'offlineRenderLeaseHeld',
  'playlistLaneMutes', 'sevenEightGrouping', 'metronomePulseLayout', 'activeMetronomeClicks',
  'countInBars', 'countInScheduler', 'timerId',
  // Phase 1L state must be saved and restored too, or a take leaks across tests.
  'punchRecording', 'punchWindow', 'activePunchTake',
];

interface Harness { ctx: FakeAudioContext; recorders: FakeMediaRecorder[] }

const install = (options: { punch?: unknown; countInBars?: number } = {}): Harness => {
  timers = [];
  const ctx = new FakeAudioContext();
  const recorders: FakeMediaRecorder[] = [];
  // Delay-aware fake window timers: a timer fires when the audio clock reaches
  // schedule-time + delay, so the count-in and punch-out moments land exactly
  // on their planned instants under the pump.
  (globalThis as any).window = {
    setTimeout: (fn: () => void, ms = 0) => {
      timers.push({ at: ctx.currentTime + ms / 1000, fn, cleared: false });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      const timer = timers[id - 1];
      if (timer) timer.cleared = true;
    },
  };
  const OriginalNavigator = globalThis.navigator;
  const OriginalMediaRecorder = globalThis.MediaRecorder;
  const OriginalCreateObjectURL = URL.createObjectURL;
  const stream = new FakeStream();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: class extends FakeMediaRecorder {
      constructor(input: FakeStream) {
        super(input, () => ctx.currentTime);
        recorders.push(this);
      }
    },
  });
  URL.createObjectURL = () => 'blob:punch-test';
  (globalThis as any).__restorePunchMocks = () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: OriginalMediaRecorder });
    URL.createObjectURL = OriginalCreateObjectURL;
  };

  saved = {};
  for (const key of SAVED_KEYS) saved[key] = engine[key];
  engine.ctx = ctx;
  engine.transport = null;
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.activeClipSourceChannels = new Map();
  engine.activeClipChannelVolumes = new Map();
  engine.masterGain = new FakeGainNode();
  engine.mixerChannels = new Map();
  engine.isPlaying = false;
  engine.isOfflineRendering = false;
  engine.offlineRenderLeaseHeld = false;
  engine.bpm = 120;
  engine.swing = 0;
  engine.metronome = false;
  engine.playbackGeneration = 0;
  engine.timerId = null;
  engine.countInBars = options.countInBars ?? 0;
  engine.countInScheduler = null;
  engine.punchRecording = options.punch ?? { enabled: false, inBar: 1, inBeat: 1, outBar: 5, outBeat: 1 };
  engine.punchWindow = null;
  engine.activePunchTake = null;
  engine.setTimeSignature([4, 4]);
  engine.setSevenEightGrouping(undefined);
  return { ctx, recorders };
};

afterEach(() => {
  engine.cancelPunchRecording?.();
  engine.cancelRecordingCountIn?.();
  (globalThis as any).__restorePunchMocks?.();
  delete (globalThis as any).__restorePunchMocks;
  for (const key of SAVED_KEYS) engine[key] = saved[key];
  (globalThis as any).window = realWindow;
});

/** Advances the audio clock in 25 ms ticks up to `until`, firing due timers. */
const runUntil = (h: Harness, until: number): void => {
  while (h.ctx.currentTime < until - 1e-12) {
    h.ctx.currentTime = Math.min(until, Math.round((h.ctx.currentTime + 0.025) * 1e6) / 1e6);
    for (const timer of timers) {
      if (!timer.cleared && timer.at <= h.ctx.currentTime + 1e-12) {
        timer.cleared = true;
        timer.fn();
      }
    }
  }
};

const audible = (h: Harness) => h.ctx.oscillators.filter(o => o.audible).sort((a, b) => a.startAt - b.startAt);
const r = (x: number) => Math.round(x * 1e6) / 1e6;

const newRecorder = (ctx: FakeAudioContext): RecordingEngine =>
  new RecordingEngine(() => ctx as unknown as AudioContext, { waveformSamples: 32, persistAudioClip: async () => {} });

/** The window used by most tests: bars 3–5 of a 4/4 project, 1-bar pre-roll. */
const PUNCH = { enabled: true, inBar: 3, inBeat: 1, outBar: 5, outBeat: 1 };
const TRACKS: PlaylistTrack[] = [
  { id: 1, name: 'Vocals', color: '#fff', mute: false, solo: false, volume: 1, pan: 0 },
];

describe('Phase 1L — capture begins exactly at punch-in and stops exactly at punch-out', () => {
  it('a 1-bar pre-roll clicks before punch-in, then capture runs the punched length', async () => {
    const h = install({ punch: PUNCH, countInBars: 1 });
    const recorder = newRecorder(h.ctx);
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 1, totalBars: 32 });
    runUntil(h, 1);
    assert.equal(h.recorders.length, 0, 'capture must not open during the pre-roll');
    assert.ok(h.ctx.oscillators.length > 0, 'the pre-roll clicks are sounding');
    runUntil(h, 2.03);
    const session = await armed;
    assert.equal(h.recorders.length, 0, 'capture must not open before the pre-roll promise resolves');
    await recorder.start();
    assert.equal(h.recorders.length, 1, 'the punch take opens exactly one recorder');
    const mediaRecorder = h.recorders[0];
    // punch-in = bar 3 beat 1 = beat 8; a 1-bar 4/4 pre-roll starts at beat 4.
    assert.equal(session.plan.inBeats, 8);
    assert.equal(session.plan.countInStartBeat, 4);
    assert.equal(session.plan.captureDurationSeconds, 4);
    assert.equal(r(session.captureTime), 2.03, 'pre-roll lead (30 ms) + one 4/4 bar at 120 BPM');
    assert.ok(mediaRecorder.startedAtAudioTime >= session.captureTime - 1e-9, 'capture opens at punch-in, never before');
    assert.equal(r(mediaRecorder.startedAtAudioTime), r(session.captureTime), 'capture opens exactly on punch-in');
    // Every count-in click lands strictly before punch-in.
    const clicks = audible(h);
    assert.equal(clicks.length, 4);
    assert.ok(clicks.every(click => click.startAt < session.captureTime - 1e-9), 'no click may fall inside the take');

    let stopped = false;
    const punchOut = session.punchOut.then(() => { stopped = true; });
    runUntil(h, 6.0);
    assert.equal(stopped, false, 'capture must still be running just before punch-out');
    runUntil(h, 6.03);
    await punchOut;
    await recorder.stop();
    const captured = mediaRecorder.stoppedAtAudioTime - mediaRecorder.startedAtAudioTime;
    assert.equal(r(captured), 4, 'capture runs exactly the punched length — no audio beyond punch-out');
  });

  it('with the count-in off, capture starts immediately at punch-in', async () => {
    const h = install({ punch: PUNCH, countInBars: 0 });
    const recorder = newRecorder(h.ctx);
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 0, totalBars: 32 });
    runUntil(h, 0.03);
    const session = await armed;
    await recorder.start();
    assert.equal(h.ctx.oscillators.length, 0, 'no pre-roll clicks are scheduled');
    assert.equal(r(session.captureTime), 0.03, 'only the scheduler lead separates the request from capture');
    assert.equal(session.plan.countInBeats, 0);
    runUntil(h, 4.0);
    assert.equal(engine.isPunchTakeActive(), true, 'the take runs until punch-out');
    runUntil(h, 4.03);
    await session.punchOut;
    await recorder.stop();
  });

  it('the recorded take is placed at the punched geometry, and trimmed to the window', async () => {
    const h = install({ punch: PUNCH, countInBars: 1 });
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 1, totalBars: 32 });
    runUntil(h, 2.03);
    const session = await armed;
    runUntil(h, 6.03);
    await session.punchOut;
    const placement = planPunchClipPlacement(session.plan);
    assert.equal(placement.startBar, 2, 'bar 3 beat 1 is 0-based playlist bar 2');
    assert.equal(placement.lengthBars, 2);
    assert.equal(placement.trimSeconds, 4);

    // The decoded take is 10 s in the harness; the punch window is 4 s.
    const trimmed = trimAudioBufferToSeconds(h.ctx.decoded, placement.trimSeconds, createFakeBuffer);
    assert.equal(r(trimmed.duration), 4, 'audio from beyond punch-out never reaches the project');

    const take: AudioRecording = {
      id: 'take-1', name: 'Punch Take', timestamp: 0, durationSeconds: 4, waveform: [0.5],
      audioBlob: new Blob(['x'], { type: 'audio/webm' }),
    };
    const clip = createPunchRecordingPlaylistClip(
      take,
      { id: getRecordingAudioBufferId(take.id), buffer: trimmed, peaks: [0.5], duration: trimmed.duration },
      TRACKS,
      0,
      placement,
      'punch-clip-1',
      32,
    );
    assert.equal(clip.startBar, 2);
    assert.equal(clip.lengthBars, 2);
    assert.equal(clip.type, 'audio');
    assert.equal(clip.trackIndex, 0);
  });

  it('a fractional punch window keeps its fractional geometry', async () => {
    const h = install({ countInBars: 0 });
    const punch = { enabled: true, inBar: 5, inBeat: 3, outBar: 7, outBeat: 2 };
    const armed = engine.beginPunchRecording({ settings: punch, countInBars: 0, totalBars: 32 });
    runUntil(h, 0.03);
    const session = await armed;
    const placement = planPunchClipPlacement(session.plan);
    assert.equal(placement.startBar, 4.5, 'bar 5 beat 3 is half a bar into playlist bar 4');
    assert.equal(placement.lengthBars, 1.75);
    assert.equal(placement.trimSeconds, 3.5);
    runUntil(h, 3.53);
    await session.punchOut;
  });

  it('the playhead is parked at the pre-roll start so transport and take agree', async () => {
    const h = install({ punch: PUNCH, countInBars: 1 });
    const seeks: number[] = [];
    engine.transport = {
      getState: () => ({ positionSeconds: 0, step: 0, bar: 1, playing: false, bpm: 120, beatsPerBar: 4, stepsPerBeat: 4, mode: 'song' }),
      seek: (positionSeconds: number) => { seeks.push(positionSeconds); },
    };
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 1, totalBars: 32 });
    assert.deepEqual(seeks, [2], 'the pre-roll starts one 4/4 bar (2 s at 120 BPM) before punch-in');
    runUntil(h, 2.03);
    const session = await armed;
    runUntil(h, 6.03);
    await session.punchOut;
  });
});

describe('Phase 1L — the take stops at the end of the project', () => {
  it('a punch-out past the arrangement end truncates the take instead of extending the timeline', async () => {
    const h = install({ countInBars: 0 });
    const punch = { enabled: true, inBar: 7, inBeat: 1, outBar: 12, outBeat: 1 };
    const armed = engine.beginPunchRecording({ settings: punch, countInBars: 0, totalBars: 8 });
    runUntil(h, 0.03);
    const session = await armed;
    assert.equal(session.plan.truncatedAtProjectEnd, true);
    assert.equal(session.plan.captureDurationBeats, 8, 'two bars, not the five the user asked for');
    assert.equal(session.plan.clipStartBar + session.plan.clipLengthBars, 8, 'the clip fits the 8-bar timeline');
    runUntil(h, 4.03);
    await session.punchOut;
  });

  it('a punch-in past the arrangement end is refused before anything is armed', async () => {
    const h = install({ countInBars: 0 });
    const punch = { enabled: true, inBar: 9, inBeat: 1, outBar: 12, outBeat: 1 };
    await assert.rejects(
      engine.beginPunchRecording({ settings: punch, countInBars: 0, totalBars: 8 }),
      /past the end of the arrangement/,
    );
    assert.equal(h.recorders.length, 0);
    assert.equal(engine.isPunchTakeActive(), false);
  });
});

describe('Phase 1L — stop, pause, seek, cancel and close abort the take', () => {
  it('stop() during the pre-roll silences the clicks and opens no capture', async () => {
    const h = install({ punch: PUNCH, countInBars: 2 });
    const recorder = newRecorder(h.ctx);
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 2, totalBars: 32 });
    const settled = assert.rejects(armed, CountInCancelledError);
    runUntil(h, 0.6);
    const pending = h.ctx.oscillators.filter(o => o.startAt > h.ctx.currentTime);
    assert.ok(pending.length > 0, 'the pre-roll must be mid-flight for this test to mean anything');
    engine.stop();
    await settled;
    assert.ok(pending.every(o => !o.audible), 'stop() pre-empts every pending pre-roll click');
    assert.equal(h.recorders.length, 0, 'capture never opens');
    assert.equal(recorder.getState(), 'idle');
    assert.equal(engine.isPunchTakeActive(), false);
  });

  it('seek() and pause() during the pre-roll abort the take the same way', async () => {
    for (const action of ['seek', 'pause'] as const) {
      const h = install({ punch: PUNCH, countInBars: 2 });
      const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 2, totalBars: 32 });
      const settled = assert.rejects(armed, CountInCancelledError);
      runUntil(h, 0.6);
      if (action === 'seek') engine.seek(3);
      else engine.pause();
      await settled;
      assert.equal(engine.isPunchTakeActive(), false, `${action} must clear the armed take`);
      assert.equal(h.recorders.length, 0);
    }
  });

  it('stop() during capture rejects punch-out instead of keeping a partial take', async () => {
    const h = install({ punch: PUNCH, countInBars: 1 });
    const recorder = newRecorder(h.ctx);
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 1, totalBars: 32 });
    runUntil(h, 2.03);
    const session = await armed;
    await recorder.start();
    assert.equal(recorder.getState(), 'recording');
    runUntil(h, 3);
    engine.stop();
    await assert.rejects(session.punchOut, PunchCancelledError);
    await recorder.cancel().catch(() => undefined);
    assert.equal(engine.isPunchTakeActive(), false);
    assert.equal(timers.filter(timer => !timer.cleared).length, 0, 'no stale punch-out timer survives a stop');
  });

  it('cancelPunchRecording() mid-take abandons it and a fresh take can be armed', async () => {
    const h = install({ punch: PUNCH, countInBars: 1 });
    const firstArmed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 1, totalBars: 32 });
    runUntil(h, 2.03);
    const first = await firstArmed;
    runUntil(h, 3);
    engine.cancelPunchRecording();
    await assert.rejects(first.punchOut, PunchCancelledError);
    const secondArmed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 1, totalBars: 32 });
    runUntil(h, 6.03);
    const second = await secondArmed;
    assert.equal(engine.isPunchTakeActive(), true);
    runUntil(h, 10.06);
    await second.punchOut;
    assert.equal(engine.isPunchTakeActive(), false);
  });

  it('a double-pressed Record cannot arm two takes', async () => {
    const h = install({ punch: PUNCH, countInBars: 2 });
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 2, totalBars: 32 });
    const settled = assert.rejects(armed, CountInCancelledError);
    const before = h.ctx.oscillators.length;
    assert.throws(() => engine.beginRecordingCountIn(2), /already running/, 'the count-in scheduler still refuses a duplicate');
    assert.equal(h.ctx.oscillators.length, before, 'no second click set is scheduled');
    engine.cancelPunchRecording();
    await settled;
  });

  it('punch recording must be enabled before a punch take can be armed', async () => {
    install({ countInBars: 1 });
    await assert.rejects(
      engine.beginPunchRecording({ settings: { enabled: false, inBar: 3, inBeat: 1, outBar: 5, outBeat: 1 }, countInBars: 1, totalBars: 32 }),
      /Punch recording is off/,
    );
  });

  it('an invalid window is refused instead of recording the wrong bars', async () => {
    install({ countInBars: 1 });
    await assert.rejects(
      engine.beginPunchRecording({ settings: { enabled: true, inBar: 5, inBeat: 1, outBar: 5, outBeat: 1 }, countInBars: 1, totalBars: 32 }),
      /Punch-out must come after punch-in/,
    );
  });
});

describe('Phase 1L — tempo and meter changes while a punch take is live', () => {
  it('a tempo change during the pre-roll keeps capture on punch-in', async () => {
    const h = install({ punch: PUNCH, countInBars: 1 });
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 1, totalBars: 32 });
    runUntil(h, 0.5);
    engine.setBpm(60);
    // Re-timed capture: 0.5 s in, 0.94 beats had elapsed, so capture moves to
    // 0.5 + (8 - 4.94) s. Pump past it, then past the retimed punch-out.
    runUntil(h, 4);
    const session = await armed;
    assert.equal(session.plan.inBeats, 8, 'the musical punch-in never moves with the tempo');
    assert.equal(session.plan.clipStartBar, 2);
    runUntil(h, 25);
    await session.punchOut;
  });

  it('a tempo change during capture preserves the punched musical length', async () => {
    const h = install({ punch: PUNCH, countInBars: 0 });
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 0, totalBars: 32 });
    runUntil(h, 0.03);
    const session = await armed;
    // 2 bars at 120 BPM would end at 4.03. One second into the take, halve it.
    runUntil(h, 1.03);
    engine.setBpm(60);
    runUntil(h, 4.03);
    assert.equal(engine.isPunchTakeActive(), true, 'the take must not be cut short at the old tempo punch-out');
    runUntil(h, 7.03);
    const result = await session.punchOut;
    assert.equal(r(result.durationBeats), 6, '2 beats captured at 120 BPM, 6 still owed at 60 BPM');
    assert.equal(r(result.stopTime), 7.03, 'the punch-out moved with the tempo, not with the old clock');
  });

  it('a meter change aborts the take: the bar-anchored window no longer means the same music', async () => {
    const h = install({ punch: PUNCH, countInBars: 2 });
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 2, totalBars: 32 });
    const settled = assert.rejects(armed, CountInCancelledError);
    runUntil(h, 0.6);
    engine.setTimeSignature([7, 8]);
    await settled;
    assert.equal(engine.isPunchTakeActive(), false);
    assert.equal(h.recorders.length, 0, 'no capture opened for a window that no longer exists');
  });

  it('a meter change during capture aborts the take rather than re-targeting it', async () => {
    const h = install({ punch: PUNCH, countInBars: 0 });
    const armed = engine.beginPunchRecording({ settings: PUNCH, countInBars: 0, totalBars: 32 });
    runUntil(h, 0.03);
    const session = await armed;
    runUntil(h, 1);
    engine.setTimeSignature([3, 4]);
    await assert.rejects(session.punchOut, PunchCancelledError);
    assert.equal(engine.isPunchTakeActive(), false);
  });

  it('a 7/8 accent-grouping change leaves the punch window alone', async () => {
    const h = install({ countInBars: 0 });
    engine.setTimeSignature([7, 8]);
    engine.setSevenEightGrouping('2+2+3');
    const punch = { enabled: true, inBar: 2, inBeat: 1, outBar: 4, outBeat: 1 };
    const armed = engine.beginPunchRecording({ settings: punch, countInBars: 1, totalBars: 32 });
    runUntil(h, 1.78);
    const session = await armed;
    engine.setSevenEightGrouping('3+2+2');
    runUntil(h, 5.28);
    await session.punchOut;
    assert.equal(session.plan.inBeats, 3.5, 'bar 2 beat 1 of 7/8');
    assert.equal(engine.isPunchTakeActive(), false);
  });
});

describe('Phase 1L — ordinary recording is untouched when punch is off', () => {
  it('the Phase 1K count-in path still captures from the transport position', async () => {
    const h = install({ countInBars: 1 });
    const recorder = newRecorder(h.ctx);
    engine.transport = {
      getState: () => ({ positionSeconds: 2, step: 0, bar: 2, playing: false, bpm: 120, beatsPerBar: 4, stepsPerBeat: 4, mode: 'song' }),
    };
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 2.5);
    const countIn = await promise;
    await recorder.start();
    assert.equal(countIn.captureBar, 3, 'an ordinary take is placed at the count-in capture bar');
    assert.equal(countIn.clipStartBar, 2);
    assert.equal(engine.isPunchTakeActive(), false, 'no punch take is armed for an ordinary recording');
    assert.equal(h.recorders.length, 1);
    await recorder.stop();
  });

  it('an ordinary take keeps whole-bar clip rounding and no punch placement', async () => {
    const h = install({ countInBars: 0 });
    const take: AudioRecording = {
      id: 'take-2', name: 'Ordinary Take', timestamp: 0, durationSeconds: 1.5, waveform: [0.5],
      audioBlob: new Blob(['x'], { type: 'audio/webm' }),
    };
    const { createRecordingPlaylistClip } = await import('./recordingPipeline');
    const clip = createRecordingPlaylistClip(
      take,
      { id: getRecordingAudioBufferId(take.id), buffer: h.ctx.decoded, peaks: [0.5], duration: 1.5 },
      TRACKS,
      0,
      120,
      'rec-clip-1',
      [4, 4],
      2,
    );
    assert.equal(clip.startBar, 2);
    assert.equal(clip.lengthBars, 1, '1.5 s rounds up to one 4/4 bar, exactly as before Phase 1L');
    assert.ok(!clip.id.startsWith('punch-clip'));
  });

  it('the punch setting defaults to off and publishes like the count-in', () => {
    install();
    assert.equal(engine.getPunchRecording().enabled, false);
    engine.setPunchRecording({ enabled: true, inBar: 3, inBeat: 1, outBar: 5, outBeat: 1 });
    assert.equal(engine.isPunchRecordingEnabled(), true);
    assert.deepEqual(engine.getPunchRecording(), { enabled: true, inBar: 3, inBeat: 1, outBar: 5, outBeat: 1 });
    engine.setPunchRecording('nonsense');
    assert.equal(engine.getPunchRecording().enabled, false, 'a malformed value resolves to punch off');
  });

  it('planPunchTake reports the window without arming anything', () => {
    const h = install({ countInBars: 1 });
    engine.setPunchRecording(PUNCH);
    const plan = engine.planPunchTake({ totalBars: 32 });
    assert.equal(plan.inBeats, 8);
    assert.equal(plan.countInBeats, 4);
    assert.equal(plan.captureDurationSeconds, 4);
    assert.equal(engine.isPunchTakeActive(), false);
    assert.equal(h.ctx.oscillators.length, 0, 'planning schedules no clicks');
  });
});
