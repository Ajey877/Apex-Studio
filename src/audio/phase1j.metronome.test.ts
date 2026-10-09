/**
 * Phase 1J — metronome scheduling through the production path:
 *
 *   audioEngine.play() → AudioClockTransport → onStep → triggerCurrentStep
 *   → resolveMetronomeClickLevel (meter + 7/8 grouping) → scheduleMetronomeClick
 *
 * A fake AudioContext records every click oscillator (frequency, start time and
 * every stop() call). A click is AUDIBLE when its last stop() lands after its
 * start and it was not disconnected — exactly the Web Audio rule that a node
 * stopped before its start time never plays. Timers are pumped manually so the
 * results are deterministic.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport } from './transport';
import { audioEngine } from './audioEngine';
import { METRONOME_CLICK_VOICES } from './metronomeClick';
import type { Channel } from '../types/daw';

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
  readonly oscillators: FakeClickOscillator[] = [];
  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
  createOscillator(): FakeClickOscillator {
    const osc = new FakeClickOscillator();
    this.oscillators.push(osc);
    return osc;
  }
}

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;
const realWindow = (globalThis as any).window;
let timers: Array<() => void> = [];
let saved: EngineInternals = {};
let originalPlayNote: unknown;
const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'activeClipSources', 'isPlaying',
  'bpm', 'swing', 'meter', 'metronome', 'currentStep', 'currentBar',
  'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers',
  'masterGain', 'mixerChannels', 'isOfflineRendering', 'offlineRenderLeaseHeld',
  'playlistLaneMutes', 'sevenEightGrouping', 'metronomePulseLayout', 'activeMetronomeClicks',
];

beforeEach(() => {
  timers = [];
  (globalThis as any).window = {
    setTimeout: (cb: () => void) => { timers.push(cb); return timers.length; },
    clearTimeout: () => undefined,
  };
  saved = {};
  for (const key of SAVED_KEYS) saved[key] = engine[key];
  originalPlayNote = engine.playNote;
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  for (const key of SAVED_KEYS) engine[key] = saved[key];
  (globalThis as any).window = realWindow;
});

const silentChannel = (): Channel => ({
  id: 'ch-silent', name: 'silent', color: '#fff', instrumentType: 'drumpad', mixerTrackId: 1,
  volume: 0.9, pan: 0, pitch: 0, mute: false, solo: false, steps: new Array(16).fill(false), notes: [], synthParams: {} as any,
});

interface Take { ctx: FakeAudioContext; transport: AudioClockTransport }

const startTake = (opts: {
  meter: [number, number];
  grouping?: string;
  bpm?: number;
  mode?: 'pat' | 'song';
  patternLengthSteps?: number;
}): Take => {
  timers = [];
  const ctx = new FakeAudioContext();
  const transport = new AudioClockTransport(ctx as unknown as AudioContext, { lookAheadSeconds: 0.1, scheduleIntervalMs: 25 });
  engine.ctx = ctx;
  engine.transport = transport;
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeMetronomeClicks = new Set();
  engine.masterGain = new FakeGainNode();
  engine.mixerChannels = new Map();
  engine.isPlaying = false;
  engine.isOfflineRendering = false;
  engine.offlineRenderLeaseHeld = false;
  engine.bpm = opts.bpm ?? 120;
  engine.setSwing(0);
  engine.setTimeSignature(opts.meter);
  engine.setSevenEightGrouping?.(opts.grouping);
  engine.metronome = true;
  engine.playNote = () => undefined;
  // Song Mode with a clip far away keeps the transport running (no song end
  // inside the test window) while nothing but the metronome makes sound.
  const clips = opts.mode === 'pat' ? [] : [{ id: 'far', trackIndex: 0, startBar: 60, lengthBars: 1, type: 'pattern', channelId: 'ch-silent', color: '#fff', name: 'far' }];
  engine.play([silentChannel()], clips, opts.mode ?? 'song', 'pat-1', [], opts.patternLengthSteps);
  return { ctx, transport };
};

/** Advances the audio clock in 25 ms ticks up to `until`, running scheduler timers. */
const runUntil = (take: Take, until: number): void => {
  while (take.ctx.currentTime < until - 1e-12) {
    take.ctx.currentTime = Math.min(until, Math.round((take.ctx.currentTime + 0.025) * 1e6) / 1e6);
    const pending = timers;
    timers = [];
    for (const cb of pending) cb();
  }
};

const audible = (take: Take) => take.ctx.oscillators.filter(o => o.audible).sort((a, b) => a.startAt - b.startAt);
const r = (x: number) => Math.round(x * 1e6) / 1e6;
const clickList = (take: Take, before = Infinity) =>
  audible(take).filter(o => o.startAt < before - 1e-9).map(o => [r(o.startAt), o.frequencyHz]);

const assertNoDuplicates = (take: Take, minGap: number) => {
  const times = audible(take).map(o => o.startAt);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= minGap - 1e-6, `clicks ${r(times[i - 1])}s and ${r(times[i])}s are only ${r(times[i] - times[i - 1])}s apart (duplicate/stale click)`);
  }
};

describe('Phase 1J — metronome follows the authoritative meter and tempo', () => {
  it('4/4 keeps the legacy click grid exactly (quarter notes, 1400 Hz downbeat, 880 Hz beats)', () => {
    const take = startTake({ meter: [4, 4] });
    runUntil(take, 4.2);
    assert.deepEqual(clickList(take, 4), [
      [0, HI], [0.5, LO], [1, LO], [1.5, LO],
      [2, HI], [2.5, LO], [3, LO], [3.5, LO],
    ]);
  });

  it('3/4 clicks three quarter notes per 1.5 s bar', () => {
    const take = startTake({ meter: [3, 4] });
    runUntil(take, 3.2);
    assert.deepEqual(clickList(take, 3), [[0, HI], [0.5, LO], [1, LO], [1.5, HI], [2, LO], [2.5, LO]]);
  });

  it('6/8 clicks six eighth notes per 1.5 s bar with a 3+3 accent', () => {
    const take = startTake({ meter: [6, 8] });
    runUntil(take, 1.7);
    assert.deepEqual(clickList(take, 1.6), [[0, HI], [0.25, LO], [0.5, LO], [0.75, MID], [1, LO], [1.25, LO], [1.5, HI]]);
  });

  it('7/8 clicks seven eighth-note pulses per 1.75 s bar (default 2+2+3)', () => {
    const take = startTake({ meter: [7, 8] });
    runUntil(take, 3.7);
    const bar = [HI, LO, MID, LO, MID, LO, LO];
    assert.deepEqual(clickList(take, 3.5), [...bar, ...bar].map((f, i) => [r(i * 0.25), f]));
    // The second bar's downbeat is exactly 14 sixteenths (1.75 s) after the first.
    assert.equal(clickList(take)[7][0], 1.75);
  });

  it('7/8 accent patterns are configurable: 3+2+2 and 2+3+2', () => {
    const a = startTake({ meter: [7, 8], grouping: '3+2+2' });
    runUntil(a, 1.8);
    assert.deepEqual(clickList(a, 1.75).map(c => c[1]), [HI, LO, LO, MID, LO, MID, LO]);
    const b = startTake({ meter: [7, 8], grouping: '2+3+2' });
    runUntil(b, 1.8);
    assert.deepEqual(clickList(b, 1.75).map(c => c[1]), [HI, LO, MID, LO, LO, MID, LO]);
  });

  it('a grouping change while playing applies from the next scheduled step, without duplicates', () => {
    const take = startTake({ meter: [7, 8], grouping: '2+2+3' });
    runUntil(take, 1.6);
    engine.setSevenEightGrouping('3+2+2');
    runUntil(take, 3.6);
    assertNoDuplicates(take, 0.25);
    const secondBar = clickList(take).filter(c => c[0] >= 1.75 && c[0] < 3.5).map(c => c[1]);
    assert.deepEqual(secondBar, [HI, LO, LO, MID, LO, MID, LO]);
  });

  it('click tempo follows the project BPM (7/8 at 90 BPM → 1/3 s eighth notes)', () => {
    const take = startTake({ meter: [7, 8], bpm: 90 });
    runUntil(take, 2.5);
    const times = clickList(take, 2.4).map(c => c[0]);
    times.forEach((t, i) => assert.ok(Math.abs(t - i / 3) < 1e-6, `click ${i} at ${t}s, expected ${i / 3}s`));
    assert.equal(clickList(take)[7][1], HI, 'bar 2 downbeat after 7 eighths');
  });

  it('pattern loops longer than a bar accent each bar line and restart on a downbeat', () => {
    const take = startTake({ meter: [4, 4], mode: 'pat', patternLengthSteps: 32 });
    runUntil(take, 4.2);
    const downbeats = clickList(take, 4.1).filter(c => c[1] === HI).map(c => c[0]);
    assert.deepEqual(downbeats, [0, 2, 4], 'bar 2 of a 2-bar pattern is accented (pre-1J only step 0 was)');
  });
});

describe('Phase 1J — no stale, duplicate or drifting clicks', () => {
  it('stop cancels clicks already scheduled inside the look-ahead window', () => {
    const take = startTake({ meter: [7, 8] });
    runUntil(take, 0.7);
    const pending = take.ctx.oscillators.filter(o => o.startAt > take.ctx.currentTime);
    assert.ok(pending.length > 0, 'the look-ahead must have scheduled a future click for this test to be meaningful');
    engine.stop();
    assert.ok(pending.every(o => !o.audible), 'future clicks must be silenced by stop()');
    const countAfterStop = take.ctx.oscillators.length;
    runUntil(take, 2);
    assert.equal(take.ctx.oscillators.length, countAfterStop, 'no clicks are scheduled after stop');
    assert.equal(engine.activeMetronomeClicks.size, 0);
  });

  it('pause cancels pending clicks and resume continues the bar without repeating a pulse', () => {
    const take = startTake({ meter: [7, 8] });
    runUntil(take, 0.7);
    const future = take.ctx.oscillators.filter(o => o.startAt > 0.7);
    engine.pause();
    assert.ok(future.length > 0 && future.every(o => !o.audible));
    engine.play([silentChannel()], [{ id: 'far', trackIndex: 0, startBar: 60, lengthBars: 1, type: 'pattern', channelId: 'ch-silent', color: '#fff', name: 'far' }], 'song', 'pat-1', []);
    runUntil(take, 2.4);
    assertNoDuplicates(take, 0.25);
  });

  it('seek silences pre-seek clicks and resumes on the new bar grid without doubling', () => {
    const take = startTake({ meter: [7, 8] });
    runUntil(take, 0.7);
    const preSeekFuture = take.ctx.oscillators.filter(o => o.startAt > 0.7);
    assert.ok(preSeekFuture.length > 0);
    engine.seek(3.5); // bar 3 downbeat in 7/8 at 120 BPM (2 × 1.75 s)
    assert.ok(preSeekFuture.every(o => !o.audible), 'clicks scheduled for the old position must not sound');
    runUntil(take, 1.7);
    assertNoDuplicates(take, 0.25);
    const post = audible(take).filter(o => o.startAt > 0.7);
    assert.equal(post[0].frequencyHz, HI, 'first click after seeking to a bar line is the downbeat');
    assert.ok(Math.abs(post[0].startAt - 0.705) < 1e-6);
  });

  it('a tempo change mid-bar continues the pulse sequence (no replayed or skipped pulses)', () => {
    const take = startTake({ meter: [7, 8] });
    runUntil(take, 1.0);
    engine.setBpm(60); // eighth note becomes 0.5 s
    runUntil(take, 6);
    assertNoDuplicates(take, 0.25);
    // Levels must continue the 2+2+3 cycle exactly: no pulse repeated after the change.
    const levels = audible(take).map(o => o.frequencyHz).slice(0, 14);
    const cycle = [HI, LO, MID, LO, MID, LO, LO];
    assert.deepEqual(levels, [...cycle, ...cycle]);
    // After the change, consecutive clicks are 0.5 s apart.
    const late = audible(take).filter(o => o.startAt > 1.5).map(o => o.startAt);
    for (let i = 1; i < late.length; i++) assert.ok(Math.abs(late[i] - late[i - 1] - 0.5) < 1e-6);
  });

  it('a meter change while playing applies from the next scheduled step without duplicates', () => {
    const take = startTake({ meter: [4, 4] });
    runUntil(take, 1.05);
    engine.setTimeSignature([7, 8]);
    runUntil(take, 5);
    assertNoDuplicates(take, 0.25);
    const after = audible(take).filter(o => o.startAt > 1.2);
    // From here the clicks are 7/8 eighth pulses (0.25 s apart).
    for (let i = 1; i < after.length; i++) assert.ok(Math.abs(after[i].startAt - after[i - 1].startAt - 0.25) < 1e-6);
    // Absolute step 14k is a 7/8 bar line: 3.5 s (step 28) must be a downbeat.
    const at35 = after.find(o => Math.abs(o.startAt - 3.5) < 1e-6);
    assert.equal(at35?.frequencyHz, HI);
  });

  it('turning the metronome off silences already-scheduled clicks immediately', () => {
    const take = startTake({ meter: [7, 8] });
    runUntil(take, 0.7);
    const future = take.ctx.oscillators.filter(o => o.startAt > 0.7);
    engine.setMetronome(false);
    assert.ok(future.length > 0 && future.every(o => !o.audible));
    const n = take.ctx.oscillators.length;
    runUntil(take, 1.5);
    assert.equal(take.ctx.oscillators.length, n);
  });

  it('long runs do not drift: the 40th 7/8 bar downbeat lands on 39 × 1.75 s exactly', () => {
    const take = startTake({ meter: [7, 8] });
    runUntil(take, 39 * 1.75 + 0.2);
    const downbeats = audible(take).filter(o => o.frequencyHz === HI).map(o => o.startAt);
    assert.equal(downbeats.length, 40);
    downbeats.forEach((t, i) => assert.ok(Math.abs(t - i * 1.75) < 1e-6, `downbeat ${i + 1} at ${t}`));
  });
});
