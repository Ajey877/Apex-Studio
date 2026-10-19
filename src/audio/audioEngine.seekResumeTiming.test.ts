/**
 * Regression for audio-clip seek/resume timing integrity.
 * Verifies correct timeline-vs-buffer time handling with timeStretchRate,
 * buffer offset, remaining duration, trim composition, short buffers,
 * endpoint guard, and retrigger paths.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { Channel, PlaylistClip } from '../types/daw';
import { AudioClockTransport } from './transport';

// --- Fake Audio Graph ---

class FakeAudioParam {
  value: number = 1;
  setValueAtTime(v: number, _t: number): void { this.value = v; }
  setTargetAtTime(): void {}
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect(): void {}
  disconnect(): void {}
}

class FakePannerNode {
  pan = new FakeAudioParam();
  connect(): void {}
  disconnect(): void {}
}

class FakeAnalyserNode {
  fftSize = 256;
  smoothingTimeConstant = 0.7;
  connect(): void {}
  disconnect(): void {}
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  detune = new FakeAudioParam();
  playbackRate = new FakeAudioParam();
  // capture
  startCalls: Array<{ when: number; offset: number; duration?: number }> = [];
  startWhen: number | null = null;
  startOffset: number | null = null;
  startDuration: number | null = null;
  // stop
  stopCalls: number[] = [];
  scheduledStopAt: number | null = null;
  connect(): void {}
  start(when?: number, offset?: number, duration?: number): void {
    this.startCalls.push({ when: when ?? 0, offset: offset ?? 0, duration });
    this.startWhen = when ?? 0;
    this.startOffset = offset ?? 0;
    this.startDuration = duration ?? null;
    // also capture playbackRate via setValueAtTime already
  }
  stop(time?: number): void {
    if (time === undefined) {
      this.stopCalls.push(-1);
    } else {
      this.scheduledStopAt = time;
      this.stopCalls.push(time);
    }
  }
  addEventListener(): void {}
}

class FakeAudioContext {
  private _currentTime = 10; // arbitrary non-zero for transport
  state = 'running';
  readonly sources: FakeBufferSource[] = [];
  get currentTime(): number { return this._currentTime; }
  set currentTime(v: number) { this._currentTime = v; }
  createBufferSource(): FakeBufferSource {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
}

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'activeClipSources', 'isPlaying',
  'bpm', 'swing', 'metronome', 'currentStep', 'currentBar',
  'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'sampleBuffers', 'masterGain', 'mixerChannels', 'playlistLaneMutes',
  'inaudibleTakeClipIds', 'meter'
];

let saved: EngineInternals = {};
let fakeCtx: FakeAudioContext;

const makeChannel = (id: string): Channel => ({
  id,
  name: id,
  color: '#ff6e00',
  instrumentType: 'drumpad',
  mixerTrackId: 1,
  volume: 0.9,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes: [],
  synthParams: {} as any
});

const makeAudioClip = (opts: Partial<PlaylistClip> & { id: string; audioBufferId: string }): PlaylistClip => ({
  trackIndex: 0,
  startBar: 0,
  lengthBars: 2, // default 2 bars => 4s at 120bpm 4/4
  type: 'audio',
  color: '#00e5ff',
  name: opts.id,
  ...opts
} as PlaylistClip);

function setupEngineWithFakeCtx() {
  fakeCtx = new FakeAudioContext();
  engine.ctx = fakeCtx as unknown as AudioContext;
  engine.bpm = 120;
  // ensure meter 4/4
  engine.meter = [4, 4];
  // minimal state
  engine.activeChannels = [];
  engine.activeClips = [];
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.activeClipSourceChannels = new Map();
  engine.activeClipChannelVolumes = new Map();
  engine.masterGain = new FakeGainNode();
  engine.mixerChannels = new Map();
  engine.playlistLaneMutes = new Set();
  engine.inaudibleTakeClipIds = new Set();
  engine.sampleBuffers = new Map();
  engine.activeMixerTracks = [];
  engine.isPlaying = true;
}

function assertClose(actual: number, expected: number, eps = 1e-9, msg?: string) {
  assert.ok(Math.abs(actual - expected) < eps, msg ?? `expected ${actual} close to ${expected}`);
}

// Helpers to call private method directly
function callPlayAudioClip(clip: PlaylistClip, startTime: number, positionOffsetSeconds = 0) {
  // ensure channel audible
  return (engine as any).playAudioClipWithFades(clip, startTime, positionOffsetSeconds);
}

beforeEach(() => {
  saved = {};
  for (const k of SAVED_KEYS) saved[k] = engine[k];
  setupEngineWithFakeCtx();
});

afterEach(() => {
  for (const k of SAVED_KEYS) engine[k] = saved[k];
});

// ---------- Tests ----------

describe('playAudioClipWithFades timing integrity', () => {
  it('normal playback: rate 1, no seek offset preserves original timing', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 1 });
    callPlayAudioClip(clip, 10, 0);
    assert.equal(fakeCtx.sources.length, 1);
    const src = fakeCtx.sources[0];
    assertClose(src.startOffset!, 0, 1e-9, 'offset 0');
    assertClose(src.startDuration!, 4, 1e-9, 'duration buffer = 4 (clip 4s * rate 1)');
    assertClose(src.scheduledStopAt!, 14, 1e-9, 'stop at start+4');
    assertClose(src.playbackRate.value, 1, 1e-9);
  });

  it('seek at rate 1: 4s clip resumed 1s in must play for no more than 3 remaining seconds', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 1 });
    // seek 1 sec into clip
    callPlayAudioClip(clip, 10, 1.0);
    assert.equal(fakeCtx.sources.length, 1);
    const src = fakeCtx.sources[0];
    // buffer offset = 1 * rate 1 =1
    assertClose(src.startOffset!, 1.0, 1e-9, 'offset 1 sec');
    // remaining timeline = 3 sec, so remaining buffer =3, actual = min(available 9, 3)=3
    assertClose(src.startDuration!, 3.0, 1e-9, 'duration 3 buffer sec (remaining)');
    assertClose(src.scheduledStopAt!, 13.0, 1e-9, 'stop at start+3');
  });

  it('seek at rate 2: correct rate-adjusted buffer offset and stop after 3 remaining timeline seconds', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 2 });
    callPlayAudioClip(clip, 10, 1.0);
    assert.equal(fakeCtx.sources.length, 1);
    const src = fakeCtx.sources[0];
    // buffer offset = elapsed 1 * rate 2 =2
    assertClose(src.startOffset!, 2.0, 1e-9, 'offset should be 2 buffer sec (1 timeline *2)');
    // remainingTimeline 3, remainingBuffer 6, available buffer 8 (10-2), actual 6
    assertClose(src.startDuration!, 6.0, 1e-9, 'duration 6 buffer sec');
    assertClose(src.scheduledStopAt!, 13.0, 1e-9, 'effective wall duration 3 => stop at 13');
    assertClose(src.playbackRate.value, 2, 1e-9);
  });

  it('seek at rate 0.5: verify buffer offset and remaining source duration', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 0.5 });
    callPlayAudioClip(clip, 10, 1.0);
    assert.equal(fakeCtx.sources.length, 1);
    const src = fakeCtx.sources[0];
    // offset =1 *0.5 =0.5 buffer sec
    assertClose(src.startOffset!, 0.5, 1e-9, 'offset 0.5 buffer sec');
    // remainingTimeline 3, remainingBuffer 1.5 (3*0.5), available 9.5, actual 1.5
    assertClose(src.startDuration!, 1.5, 1e-9, 'duration 1.5 buffer sec');
    assertClose(src.scheduledStopAt!, 13.0, 1e-9, 'stop at start+3');
  });

  it('trim plus seek: offsetSteps and elapsed compose correctly', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    // At 120 BPM, 8 steps = 1 sec
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 2, offsetSteps: 8 });
    callPlayAudioClip(clip, 10, 1.0);
    const src = fakeCtx.sources[0];
    // trim 1 sec timeline + elapsed 1 sec =2 timeline, *2 => 4 buffer offset
    assertClose(src.startOffset!, 4.0, 1e-9, 'trim+seek buffer offset 4');
    // remainingTimeline still 3 (clipDuration 4 - elapsed 1), remainingBuffer 6, available 6 (10-4), actual 6
    assertClose(src.startDuration!, 6.0, 1e-9, 'duration 6');
    assertClose(src.scheduledStopAt!, 13.0, 1e-9);
  });

  it('trim plus seek at rate 1: does not skip too much or replay', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 1, offsetSteps: 8 });
    callPlayAudioClip(clip, 10, 1.0);
    const src = fakeCtx.sources[0];
    assertClose(src.startOffset!, 2.0, 1e-9, 'trim 1 + seek 1 =2 timeline offset, rate1 =>2 buffer');
    assertClose(src.startDuration!, 3.0, 1e-9);
    assertClose(src.scheduledStopAt!, 13.0, 1e-9);
  });

  it('short source buffer: playback ends when available source content exhausted', () => {
    const buf = { duration: 2 } as AudioBuffer; // short
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 1 }); // 4s clip
    // seek 1 sec in, available buffer =2-1=1, remainingTimeline 3, so should play 1 sec only
    callPlayAudioClip(clip, 10, 1.0);
    const src = fakeCtx.sources[0];
    assertClose(src.startOffset!, 1.0, 1e-9);
    assertClose(src.startDuration!, 1.0, 1e-9, 'limited by buffer');
    assertClose(src.scheduledStopAt!, 11.0, 1e-9, 'effective 1 sec');
  });

  it('short buffer with rate 2: remaining buffer limited correctly', () => {
    const buf = { duration: 4 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 2 }); // need 8 buffer for full 4s
    callPlayAudioClip(clip, 10, 1.0);
    const src = fakeCtx.sources[0];
    // offset 2 buffer, available 2, remainingBuffer 6, so actual 2 buffer => effective 1 sec
    assertClose(src.startOffset!, 2.0, 1e-9);
    assertClose(src.startDuration!, 2.0, 1e-9);
    assertClose(src.scheduledStopAt!, 11.0, 1e-9, 'only 1 sec timeline due to buffer exhaustion');
  });

  it('clip endpoint: no source starts when playhead at or beyond timeline endpoint', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, timeStretchRate: 1 }); // duration 4s
    // elapsed exactly 4 sec => at endpoint
    callPlayAudioClip(clip, 10, 4.0);
    assert.equal(fakeCtx.sources.length, 0, 'no source at endpoint');
    // beyond
    callPlayAudioClip(clip, 10, 5.0);
    assert.equal(fakeCtx.sources.length, 0, 'no source beyond endpoint');

    // slightly before endpoint should still play small remainder
    callPlayAudioClip(clip, 10, 3.9);
    assert.equal(fakeCtx.sources.length, 1, 'source before endpoint');
    const src = fakeCtx.sources[0];
    assertClose(src.startDuration!, 0.1, 1e-6);
  });

  it('seek at endpoint via retrigger path does not start source (integration)', () => {
    // This uses the public retrigger path that seek/pause uses
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    // Create fake transport for position mapping
    const fakeCtx2 = new FakeAudioContext();
    fakeCtx2.currentTime = 5;
    const transport = new AudioClockTransport(fakeCtx2 as unknown as AudioContext, { lookAheadSeconds: 0.1, scheduleIntervalMs: 25 });
    engine.ctx = fakeCtx2 as unknown as AudioContext;
    engine.transport = transport;
    engine.bpm = 120;
    engine.meter = [4, 4] as any;
    engine.activeClipSources = new Set();
    engine.activeClipSourceLanes = new Map();
    engine.isPlaying = true;
    // clip at startBar 0 length 2 bars => end 4s
    const clip = makeAudioClip({ id: 'clip1', audioBufferId: 'buf1', lengthBars: 2, startBar: 0, type: 'audio', trackIndex: 0 });
    engine.activeClips = [clip];
    // position beyond end 5 sec
    (engine as any).retriggerAudioClipsAtPosition(5.0);
    assert.equal(fakeCtx2.sources.length, 0, 'no source beyond end');
    // position at endpoint 4.0 exactly => current logic: position >= end => skip
    (engine as any).retriggerAudioClipsAtPosition(4.0);
    assert.equal(fakeCtx2.sources.length, 0, 'no source at endpoint');
    // position 1 sec inside => should start
    (engine as any).retriggerAudioClipsAtPosition(1.0);
    assert.equal(fakeCtx2.sources.length, 1, 'source inside');
    assertClose(fakeCtx2.sources[0].startOffset!, 1.0, 1e-9);
  });

  it('pause/resume and ruler seek pass correct elapsed and do not allow bleed past clip end', () => {
    // Simulate pause/resume via retrigger after play() replacement
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const fakeCtx2 = new FakeAudioContext();
    fakeCtx2.currentTime = 20;
    const transport = new AudioClockTransport(fakeCtx2 as unknown as AudioContext);
    engine.ctx = fakeCtx2 as unknown as AudioContext;
    engine.transport = transport;
    engine.bpm = 120;
    engine.meter = [4, 4] as any;
    engine.activeClipSources = new Set();
    engine.activeClipSourceLanes = new Map();
    engine.isPlaying = true;
    const clip = makeAudioClip({ id: 'clip1', audioBufferId: 'buf1', lengthBars: 2, startBar: 0, type: 'audio', trackIndex: 0, timeStretchRate: 2 });
    engine.activeClips = [clip];
    // simulate seek to 1 sec (inside) with rate 2
    (engine as any).retriggerAudioClipsAtPosition(1.0);
    assert.equal(fakeCtx2.sources.length, 1);
    const src = fakeCtx2.sources[0];
    assertClose(src.startOffset!, 2.0, 1e-9, 'rate-adjusted offset via retrigger');
    assertClose(src.startDuration!, 6.0, 1e-9, 'remaining buffer');
    assertClose(src.scheduledStopAt!, fakeCtx2.currentTime + 3.0, 1e-9, '3 sec remaining timeline');
  });

  it('compatibility: fades, routing, cancellation unchanged (smoke)', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, fadeInBars: 0.5, fadeOutBars: 0.5 });
    callPlayAudioClip(clip, 10, 0);
    assert.equal(fakeCtx.sources.length, 1);
    const src = fakeCtx.sources[0];
    assertClose(src.startOffset!, 0, 1e-9);
    assertClose(src.startDuration!, 4, 1e-9);
    // ensure activeClipSources tracking still works
    assert.equal(engine.activeClipSources.size, 1);
  });

  it('clamp invalid values: negative offsetSteps treated as 0', () => {
    const buf = { duration: 10 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, offsetSteps: -5 });
    callPlayAudioClip(clip, 10, 0);
    const src = fakeCtx.sources[0];
    assertClose(src.startOffset!, 0, 1e-9);
  });

  it('when remaining buffer too short due to trim+seek, clamps to available', () => {
    const buf = { duration: 3 } as AudioBuffer;
    engine.sampleBuffers = new Map([['buf1', buf]]);
    const ch = makeChannel('ch1');
    engine.activeChannels = [ch];
    const clip = makeAudioClip({ id: 'c1', audioBufferId: 'buf1', lengthBars: 2, offsetSteps: 8, timeStretchRate: 1 }); // trim 1 sec
    // seek 1 sec elapsed => total timeline offset 2 sec => buffer offset 2
    // available buffer 1 sec (3-2), remainingTimeline 3 sec, so should play 1 sec
    callPlayAudioClip(clip, 10, 1.0);
    const src = fakeCtx.sources[0];
    assertClose(src.startOffset!, 2.0, 1e-9);
    assertClose(src.startDuration!, 1.0, 1e-9);
    assertClose(src.scheduledStopAt!, 11.0, 1e-9);
  });
});
