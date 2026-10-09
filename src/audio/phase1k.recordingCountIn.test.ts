/**
 * Phase 1K — recording count-in through the PRODUCTION path:
 *
 *   audioEngine.beginRecordingCountIn → CountInScheduler
 *   → scheduleMetronomeClick (the real metronome click voice)
 *   → capture moment → RecordingEngine.start() (MediaRecorder opens HERE)
 *   → createRecordingPlaylistClip at the capture bar
 *
 * A fake AudioContext records every click oscillator (frequency, start time,
 * every stop() call) exactly like the Phase 1J metronome tests; a delay-aware
 * fake `window` timer pump keeps the audio clock and the count-in completion
 * timer deterministic. The browser recording APIs (getUserMedia/MediaRecorder)
 * use the same structural fakes as `recordingEngine.test.ts`, so this drives
 * the real RecordingEngine — not a UI mock. What is NOT exercised is a real
 * microphone/codec (browser-only; see the report's browser-test limitations).
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine, CountInCancelledError } from './audioEngine';
import { RecordingEngine } from './recordingEngine';
import { METRONOME_CLICK_VOICES } from './metronomeClick';
import { createRecordingPlaylistClip, getRecordingAudioBufferId } from './recordingPipeline';
import type { AudioRecording, PlaylistTrack } from '../types/daw';

const HI = METRONOME_CLICK_VOICES.downbeat.frequencyHz; // 1400
const MID = METRONOME_CLICK_VOICES.accent.frequencyHz; // 1100
const LO = METRONOME_CLICK_VOICES.pulse.frequencyHz; // 880

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

class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';
  destination = {};
  readonly oscillators: FakeClickOscillator[] = [];
  readonly decoded = {
    numberOfChannels: 1,
    length: 4,
    duration: 0.1,
    sampleRate: 44100,
    getChannelData: () => new Float32Array([0, 0.5, -0.25, 0.1]),
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }
  async resume(): Promise<void> {}
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
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

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;
const realWindow = (globalThis as any).window;
interface PumpedTimer { at: number; fn: () => void; cleared: boolean }
let timers: PumpedTimer[] = [];
let saved: EngineInternals = {};
let originalPlayNote: unknown;
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
];

interface Harness { ctx: FakeAudioContext }

const install = (): Harness => {
  timers = [];
  const ctx = new FakeAudioContext();
  // Delay-aware fake window timers: a timer fires when the audio clock reaches
  // schedule-time + delay, so the count-in completion lands exactly on its
  // capture moment under the pump.
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
  saved = {};
  for (const key of SAVED_KEYS) saved[key] = engine[key];
  originalPlayNote = engine.playNote;
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
  engine.countInBars = 0;
  engine.countInScheduler = null;
  engine.setTimeSignature([4, 4]);
  engine.setSevenEightGrouping(undefined);
  return { ctx };
};

afterEach(() => {
  engine.cancelRecordingCountIn?.();
  engine.playNote = originalPlayNote;
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

const assertNoDuplicates = (h: Harness, minGap: number) => {
  const times = audible(h).map(o => o.startAt);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= minGap - 1e-6, `clicks ${r(times[i - 1])} and ${r(times[i])} duplicated/stale`);
  }
};

describe('Phase 1K — engine count-in clicks follow tempo, meter and accent grouping', () => {
  it('2-bar 4/4 at 120 BPM clicks 8 quarters and captures at bar 3 (clip offset 2)', async () => {
    const h = install();
    const promise = engine.beginRecordingCountIn(2);
    runUntil(h, 4.5);
    const result = await promise;
    const clicks = audible(h);
    assert.equal(clicks.length, 8);
    assert.deepEqual(clicks.map(o => r(o.startAt)), [0.03, 0.53, 1.03, 1.53, 2.03, 2.53, 3.03, 3.53]);
    assert.deepEqual(clicks.map(o => o.frequencyHz), [HI, LO, LO, LO, HI, LO, LO, LO]);
    assert.equal(result.captureBar, 3, 'recording begins on bar 3 after a 2-bar count-in');
    assert.equal(result.clipStartBar, 2, 'the take is placed at playlist bar 2 (0-based)');
    assert.equal(result.captureBeat, 8);
    assert.equal(r(result.captureTime), 4.03);
  });

  it('1-bar 6/8 clicks the 3+3 dotted-quarter grouping (accent on the second group)', async () => {
    const h = install();
    engine.setTimeSignature([6, 8]);
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 2);
    const result = await promise;
    const clicks = audible(h);
    assert.equal(clicks.length, 6);
    assert.deepEqual(clicks.map(o => o.frequencyHz), [HI, LO, LO, MID, LO, LO]);
    assert.deepEqual(clicks.map(o => r(o.startAt)), [0.03, 0.28, 0.53, 0.78, 1.03, 1.28]);
    assert.equal(result.captureBar, 2);
    assert.equal(result.clipStartBar, 1);
  });

  it('1-bar 7/8 follows the selected grouping (3+2+2 accents)', async () => {
    const h = install();
    engine.setTimeSignature([7, 8]);
    engine.setSevenEightGrouping('3+2+2');
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 2.2);
    const result = await promise;
    assert.deepEqual(audible(h).map(o => o.frequencyHz), [HI, LO, LO, MID, LO, MID, LO]);
    assert.equal(result.captureBeat, 3.5);
    assert.equal(result.captureBar, 2);
  });

  it('count-in clicks follow the project tempo', async () => {
    const h = install();
    engine.setBpm(60);
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 5);
    await promise;
    const times = audible(h).map(o => o.startAt);
    times.forEach((t, i) => assert.ok(Math.abs(t - (0.03 + i)) < 1e-6, `click ${i} at ${t}`));
  });

  it('count-in starts from the transport position and reports the capture bar', async () => {
    const h = install();
    // Transport parked at bar 2 beat 1 of 4/4 (2.0 s at 120 BPM = beat 4).
    engine.transport = {
      getState: () => ({ positionSeconds: 2, step: 0, bar: 2, playing: false, bpm: 120, beatsPerBar: 4, stepsPerBeat: 4, mode: 'song' }),
    };
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 2.5);
    const result = await promise;
    // Already on a bar line: the count-in is bar 2 itself, capture at bar 3.
    assert.equal(result.captureBar, 3);
    assert.equal(result.clipStartBar, 2);
  });

  it('Off (0 bars) schedules no clicks and captures at the current position', async () => {
    const h = install();
    engine.countInBars = 0;
    const promise = engine.beginRecordingCountIn();
    runUntil(h, 0.5);
    const result = await promise;
    assert.equal(h.ctx.oscillators.length, 0);
    assert.equal(result.captureBar, 1);
    assert.equal(result.clipStartBar, 0);
  });
});

describe('Phase 1K — stop, cancel, seek and double-start lifecycle', () => {
  it('stop() during a count-in silences pending clicks and rejects with CountInCancelledError', async () => {
    const h = install();
    const promise = engine.beginRecordingCountIn(2);
    runUntil(h, 0.6);
    const pending = h.ctx.oscillators.filter(o => o.startAt > h.ctx.currentTime);
    assert.ok(pending.length > 0, 'future clicks must be scheduled for this test to be meaningful');
    engine.stop();
    await assert.rejects(promise, CountInCancelledError);
    assert.ok(pending.every(o => !o.audible), 'stop() must pre-empt every pending click');
    assert.equal(engine.isCountInRunning(), false);
    const countAfter = h.ctx.oscillators.length;
    runUntil(h, 5);
    assert.equal(h.ctx.oscillators.length, countAfter, 'no clicks are scheduled after stop');
  });

  it('seek() during a count-in aborts it (stale capture offset)', async () => {
    const h = install();
    const promise = engine.beginRecordingCountIn(2);
    runUntil(h, 0.6);
    const pending = h.ctx.oscillators.filter(o => o.startAt > h.ctx.currentTime);
    assert.ok(pending.length > 0);
    engine.seek(3);
    await assert.rejects(promise, CountInCancelledError);
    assert.ok(pending.every(o => !o.audible));
  });

  it('pause() during a count-in aborts it', async () => {
    const h = install();
    const promise = engine.beginRecordingCountIn(2);
    runUntil(h, 0.6);
    engine.pause();
    await assert.rejects(promise, CountInCancelledError);
    assert.equal(engine.isCountInRunning(), false);
  });

  it('cancelRecordingCountIn() aborts capture; a fresh count-in can start afterwards', async () => {
    const h = install();
    const first = engine.beginRecordingCountIn(1);
    runUntil(h, 0.3);
    engine.cancelRecordingCountIn();
    await assert.rejects(first, CountInCancelledError);
    assert.ok(h.ctx.oscillators.every(o => !o.audible), 'cancelled clicks never sound');
    const second = engine.beginRecordingCountIn(1);
    runUntil(h, 3);
    const result = await second;
    assert.equal(result.captureBar, 2);
    assertNoDuplicates(h, 0.2);
  });

  it('a second beginRecordingCountIn throws instead of scheduling duplicate clicks', async () => {
    const h = install();
    const first = engine.beginRecordingCountIn(2);
    const settled = assert.rejects(first, CountInCancelledError);
    const before = h.ctx.oscillators.length;
    assert.throws(() => engine.beginRecordingCountIn(2), /already running/);
    assert.equal(h.ctx.oscillators.length, before);
    engine.cancelRecordingCountIn();
    await settled;
  });
});

describe('Phase 1K — tempo and meter changes during a count-in', () => {
  it('a tempo change re-times the remaining clicks; the capture bar is unchanged', async () => {
    const h = install();
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 0.6);
    engine.setBpm(60);
    runUntil(h, 6);
    const result = await promise;
    assert.equal(result.captureBar, 2, 'the musical capture position does not move with the tempo');
    assert.equal(result.clipStartBar, 1);
    assertNoDuplicates(h, 0.4);
    // After the change the remaining quarters are 1 s apart.
    const late = audible(h).filter(o => o.startAt > 0.6).map(o => o.startAt);
    for (let i = 1; i < late.length; i++) assert.ok(Math.abs(late[i] - late[i - 1] - 1) < 1e-6);
  });

  it('a meter change restarts the count-in under the new bar grid (capture bar re-derived)', async () => {
    const h = install();
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 0.6);
    engine.setTimeSignature([7, 8]);
    runUntil(h, 5);
    const result = await promise;
    // Restart snaps to the next 7/8 bar line (beat 3.5) and counts one 7/8
    // bar: capture on beat 7 = bar 3 of the new grid.
    assert.equal(result.schedule.layout.meter[0], 7);
    assert.equal(result.captureBeat, 7);
    assert.equal(result.captureBar, 3);
    assert.equal(result.clipStartBar, 2);
    const restarted = audible(h).filter(o => o.startAt >= 0.6);
    assert.deepEqual(restarted.map(o => o.frequencyHz), [HI, LO, MID, LO, MID, LO, LO]);
    assertNoDuplicates(h, 0.2);
  });

  it('a 7/8 grouping change updates the pending click accents in place — the capture offset does not move', async () => {
    const h = install();
    engine.setTimeSignature([7, 8]);
    engine.setSevenEightGrouping('2+2+3');
    const promise = engine.beginRecordingCountIn(1);
    runUntil(h, 0.3);
    engine.setSevenEightGrouping('2+3+2');
    runUntil(h, 3);
    const result = await promise;
    // Same meter: capture stays exactly one 7/8 bar after the start (bar 2).
    assert.equal(result.captureBar, 2);
    assert.equal(result.clipStartBar, 1);
    // The full bar now reads as 2+3+2: pending clicks changed voice in place.
    assert.deepEqual(audible(h).map(o => o.frequencyHz), [HI, LO, MID, LO, LO, MID, LO]);
    assertNoDuplicates(h, 0.2);
  });
});

// ---------------------------------------------------------------------------
// Real recording path: RecordingEngine + MediaRecorder ordering and offsets.
// ---------------------------------------------------------------------------

class FakeTrack { stopped = false; stop(): void { this.stopped = true; } }
class FakeStream { readonly track = new FakeTrack(); getTracks(): FakeTrack[] { return [this.track]; } }

class FakeMediaRecorder {
  static isTypeSupported(): boolean { return true; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  startedAtAudioTime = Number.NaN;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: FakeStream, readonly onConstruct?: () => number) {}
  start(): void {
    this.startedAtAudioTime = this.onConstruct?.() ?? Number.NaN;
    this.state = 'recording';
  }
  pause(): void {}
  resume(): void {}
  stop(): void {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['recorded'], { type: 'audio/webm' }) });
      void this.onstop?.();
    });
  }
}

const installBrowserMocks = (ctx: () => FakeAudioContext) => {
  const stream = new FakeStream();
  const recorderInstances: FakeMediaRecorder[] = [];
  const OriginalMediaRecorder = globalThis.MediaRecorder;
  const OriginalNavigator = globalThis.navigator;
  const OriginalCreateObjectURL = URL.createObjectURL;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: class extends FakeMediaRecorder {
      constructor(input: FakeStream) {
        super(input, () => ctx().currentTime);
        recorderInstances.push(this);
      }
    },
  });
  URL.createObjectURL = () => 'blob:count-in-test';
  return {
    stream,
    recorderInstances,
    restore: () => {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
      Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: OriginalMediaRecorder });
      URL.createObjectURL = OriginalCreateObjectURL;
    },
  };
};

describe('Phase 1K — the real recording path never captures the count-in', () => {
  it('MediaRecorder opens only after the count-in resolves — at the capture moment, on the capture bar', async () => {
    const h = install();
    const mocks = installBrowserMocks(() => h.ctx);
    try {
      const recorder = new RecordingEngine(() => h.ctx as unknown as AudioContext, {
        waveformSamples: 32,
        persistAudioClip: async () => {},
      });
      const promise = engine.beginRecordingCountIn(2);
      runUntil(h, 1);
      assert.ok(h.ctx.oscillators.length > 0, 'count-in clicks are sounding');
      assert.equal(mocks.recorderInstances.length, 0, 'capture must not open while the count-in runs');
      runUntil(h, 4.5);
      const result = await promise;
      assert.equal(mocks.recorderInstances.length, 0, 'capture must not open before the promise resolves');
      await recorder.start();
      assert.equal(mocks.recorderInstances.length, 1);
      const mediaRecorder = mocks.recorderInstances[0];
      assert.ok(
        mediaRecorder.startedAtAudioTime >= result.captureTime - 1e-9,
        `MediaRecorder started at ${mediaRecorder.startedAtAudioTime}, before capture time ${result.captureTime}`
      );
      // No count-in click is scheduled at/after capture: the take window starts
      // silent of clicks (and the mic stream is a separate graph anyway).
      const clicksAfterCapture = h.ctx.oscillators.filter(o => o.startAt >= result.captureTime - 1e-9);
      assert.equal(clicksAfterCapture.length, 0, 'count-in clicks never overlap the take window');
      // The count-in wrote no notes and triggered no instrument voices.
      assert.equal(engine.playNote, originalPlayNote, 'the count-in never calls playNote');

      // Offset: the take is placed on the bar capture began on.
      const take: AudioRecording = {
        id: 'take-1', name: 'Take', timestamp: 0, durationSeconds: 1.5, waveform: [0.5],
        audioBlob: new Blob(['x'], { type: 'audio/webm' }),
      };
      const tracks: PlaylistTrack[] = [{ id: 1, name: 'Vocals', color: '#fff', mute: false, solo: false, volume: 1, pan: 0 }];
      const clip = createRecordingPlaylistClip(
        take,
        { id: getRecordingAudioBufferId(take.id), buffer: h.ctx.decoded, peaks: [0.5], duration: 1.5 },
        tracks,
        0,
        120,
        'clip-1',
        [4, 4],
        result.clipStartBar
      );
      assert.equal(clip.startBar, 2, 'the take lands at the capture bar, not blindly on bar 1');
      assert.equal(clip.lengthBars, 1);
      await recorder.stop();
    } finally {
      mocks.restore();
    }
  });

  it('cancelling the count-in opens no capture at all', async () => {
    const h = install();
    const mocks = installBrowserMocks(() => h.ctx);
    try {
      const recorder = new RecordingEngine(() => h.ctx as unknown as AudioContext, {
        waveformSamples: 32,
        persistAudioClip: async () => {},
      });
      const promise = engine.beginRecordingCountIn(2);
      runUntil(h, 0.5);
      // Modal "CANCEL" path: abort the count-in, never start the recorder.
      engine.cancelRecordingCountIn();
      await assert.rejects(promise, CountInCancelledError);
      assert.equal(mocks.recorderInstances.length, 0);
      assert.equal(recorder.getState(), 'idle');
      assert.ok(h.ctx.oscillators.every(o => !o.audible), 'cancelled clicks never sound');
    } finally {
      mocks.restore();
    }
  });

  it('a take started with the count-in Off behaves like the pre-Phase-1K immediate start', async () => {
    const h = install();
    const mocks = installBrowserMocks(() => h.ctx);
    try {
      const recorder = new RecordingEngine(() => h.ctx as unknown as AudioContext, {
        waveformSamples: 32,
        persistAudioClip: async () => {},
      });
      engine.countInBars = 0;
      const promise = engine.beginRecordingCountIn();
      runUntil(h, 0.2);
      const result = await promise;
      await recorder.start();
      assert.equal(result.captureBar, 1);
      assert.equal(result.clipStartBar, 0);
      assert.equal(h.ctx.oscillators.length, 0, 'Off schedules no clicks');
      await recorder.stop();
    } finally {
      mocks.restore();
    }
  });
});
