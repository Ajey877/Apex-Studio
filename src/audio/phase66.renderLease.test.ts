/**
 * Phase 66 — F2: the offline render lease must not leave the live engine and the
 * project document silently disagreeing.
 *
 * The Phase 50/51 lease deliberately fences live callers out of the shared
 * engine while a timeline render owns its mutable state: a live write can never
 * reach the offline graph and the frozen take stays deterministic. That part is
 * correct and is asserted here as a control.
 *
 * What was missing is the other half of the contract. A project change made
 * while a render is running (the Export dialog can be dismissed mid-render, so
 * the BPM field, the swing slider and the mixer stay reachable) is written to the
 * React project document — but the engine call that would apply it is swallowed.
 * Both `App.tsx` effects that publish tempo/swing run on the *change*, not after
 * the render, and `App.handleUpdateMixerTrack` skips the engine while a take is
 * "playing" (the renderer sets `isPlaying`), so nothing ever re-publishes the
 * new values. The engine then plays the old tempo/swing/mixer while the UI shows
 * the new ones (`/tmp/probes/p3_lease.ts`).
 *
 * The fix is an explicit release notification: the engine reports that the lease
 * has been released so the owner can re-publish the authoritative project state.
 * These tests pin both halves — no live write may disturb the frozen take, and
 * the release must be observable, exactly once, even when the render fails.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { createDefaultProjectState } from '../state/projectState';
import type { Channel, MixerTrack, PlaylistClip, ProjectState } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;
const RENDER_BPM = 90;
const RENDER_SECONDS_PER_STEP = (60 / RENDER_BPM) / 4;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

class SimParam {
  value: number;
  constructor(initial: number) {
    this.value = initial;
  }
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void {}
}

class SimNode {
  readonly connections: SimNode[] = [];
  readonly gain = new SimParam(1);
  readonly pan = new SimParam(0);
  readonly frequency = new SimParam(440);
  readonly detune = new SimParam(0);
  readonly Q = new SimParam(1);
  readonly threshold = new SimParam(-24);
  readonly knee = new SimParam(30);
  readonly ratio = new SimParam(12);
  readonly attack = new SimParam(0.003);
  readonly release = new SimParam(0.25);
  readonly depth = new SimParam(0);
  readonly rate = new SimParam(1);
  readonly delayTime = new SimParam(0);
  readonly curve: Float32Array | null = null;
  readonly buffer: SimAudioBuffer | null = null;
  constructor(readonly kind: string) {}
  connect(target: SimNode): SimNode {
    if (target instanceof SimNode && !this.connections.includes(target)) this.connections.push(target);
    return target;
  }
  disconnect(target?: SimNode): void {
    if (!target) { this.connections.length = 0; return; }
    const index = this.connections.indexOf(target);
    if (index >= 0) this.connections.splice(index, 1);
  }
  start(): void {}
  stop(): void {}
  setPeriodicWave(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class SimAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0];
  }
}

class SimAudioContext {
  readonly sampleRate = SAMPLE_RATE;
  readonly length = SAMPLE_RATE;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new SimNode('destination');
  private track(kind: string): SimNode { return new SimNode(kind); }
  createGain(): SimNode { return this.track('gain'); }
  createStereoPanner(): SimNode { return this.track('panner'); }
  createAnalyser(): SimNode { return this.track('analyser'); }
  createDynamicsCompressor(): SimNode { return this.track('compressor'); }
  createOscillator(): SimNode { return this.track('oscillator'); }
  createBiquadFilter(): SimNode { return this.track('filter'); }
  createBuffer(channels: number, length: number, sampleRate: number): SimAudioBuffer {
    return new SimAudioBuffer(channels, length, sampleRate);
  }
  // The default project ships real FX slots, so a re-publication of its mixer
  // tracks rebuilds whole chains: the graph surface has to cover every node the
  // chain builder can create.
  createWaveShaper(): SimNode & { curve: Float32Array | null; oversample: string } {
    return Object.assign(new SimNode('waveshaper'), { curve: null as Float32Array | null, oversample: 'none' });
  }
  createConvolver(): SimNode & { buffer: SimAudioBuffer | null; normalize: boolean } {
    return Object.assign(new SimNode('convolver'), { buffer: null as SimAudioBuffer | null, normalize: true });
  }
  createDelay(): SimNode & { delayTime: SimParam } {
    return Object.assign(new SimNode('delay'), { delayTime: new SimParam(0) });
  }
  createConstantSource(): SimNode & { offset: SimParam } {
    return Object.assign(new SimNode('constant'), { offset: new SimParam(0) });
  }
  createOscillatorNode(): SimNode { return this.track('oscillator'); }
  resume(): Promise<void> { return Promise.resolve(); }
  async startRendering(): Promise<SimAudioBuffer> { return new SimAudioBuffer(2, this.length, this.sampleRate); }
}

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  const steps = new Array(16).fill(false);
  steps[1] = true;
  return {
    id,
    name: id,
    color: '#00e5ff',
    instrumentType: 'minisynth',
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    notes: [],
    synthParams: audioEngine.getDefaultSynthParams(),
    mixerTrackId: 1,
    ...overrides,
  };
}

function makeMixerTracks(): MixerTrack[] {
  return [0, 1].map(id => ({
    id,
    name: id === 0 ? 'Master' : 'Insert 1',
    color: '#fff',
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  }));
}

const SAVED_FIELDS = [
  'ctx', 'masterGain', 'grossBeatNode', 'masterAnalyser', 'mixerChannels', 'channelPanners',
  'mixerRoutingAdapter', 'mixerRoutingChannelMap', 'activeVoices', 'activeClipSources',
  'playlistLaneMutes', 'isPlaying', 'isOfflineRendering', 'transport', 'swing', 'bpm',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'activePlayMode', 'activePatternLengthSteps', 'playNote',
] as const;

const savedState: Record<string, unknown> = {};
let realOfflineAudioContext: unknown;

interface TriggeredNote { pitch: number; start: number; time: number }
let triggered: TriggeredNote[] = [];

function setupLiveGraph(): SimAudioContext {
  const ctx = new SimAudioContext();
  engine.ctx = ctx;
  engine.masterGain = ctx.createGain();
  engine.grossBeatNode = ctx.createGain();
  engine.masterAnalyser = ctx.createAnalyser();
  engine.masterGain.connect(engine.grossBeatNode);
  engine.grossBeatNode.connect(engine.masterAnalyser);
  engine.masterAnalyser.connect(ctx.destination);
  engine.mixerChannels = new Map();
  engine.channelPanners = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.playlistLaneMutes = new Set();
  engine.isPlaying = false;
  engine.isOfflineRendering = false;
  engine.bpm = BPM;
  engine.playNote = (channel: Channel, note: { pitch: number; start: number }, startTime?: number) => {
    triggered.push({ pitch: note.pitch, start: note.start, time: startTime ?? Number.NaN });
  };
  return ctx;
}

/** Transport double that records the renderer's stop/resume cycle. */
function attachRecordingTransport() {
  const calls: string[] = [];
  let callbacks: { onStep?: (step: number, bar: number, audioTime: number) => void } | null = null;
  engine.transport = {
    setBpm: () => undefined,
    setMode: () => undefined,
    setPatternLoopSteps: () => undefined,
    setTimeSignature: () => undefined,
    setSongEndSteps: () => undefined,
    setCallbacks: (next: typeof callbacks) => { callbacks = next; },
    start: () => { calls.push('start'); },
    stop: () => { calls.push('stop'); },
    pause: () => undefined,
    seek: () => undefined,
    getState: () => ({
      bpm: BPM, beatsPerBar: 4, stepsPerBeat: 4, mode: 'pat', playing: true,
      positionSeconds: 0, step: 0, bar: 1,
    }),
  };
  return { calls, emitStep: (step: number, bar: number, time: number) => callbacks?.onStep?.(step, bar, time) };
}

/**
 * The production API under test. Accessed structurally so the pre-fix baseline
 * fails on the missing contract instead of failing to load the suite.
 */
const registerReleaseCallback = (callback: (() => void) | null): boolean => {
  const candidate = audioEngine as unknown as {
    setOfflineRenderCompleteCallback?: (next: (() => void) | null) => void;
  };
  if (typeof candidate.setOfflineRenderCompleteCallback !== 'function') return false;
  candidate.setOfflineRenderCompleteCallback(callback);
  return true;
};

beforeEach(() => {
  for (const field of SAVED_FIELDS) savedState[field] = engine[field];
  triggered = [];
  realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = SimAudioContext;
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
});

afterEach(() => {
  registerReleaseCallback(null);
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
  (globalThis as any).window = undefined;
});

const renderPattern = (channel: Channel, bpm: number, onProgress?: (percent: number) => void) =>
  audioEngine.renderTimelineOffline(
    [channel], [] as PlaylistClip[], [] as MixerTrack[], bpm, 1,
    undefined, false, 'pattern', onProgress, 16,
  );

describe('Phase 66 F2 — the render lease fences live writes out of the frozen take', () => {
  it('does not let a mid-render tempo or swing change disturb the rendered take', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    audioEngine.setSwing(0);
    audioEngine.setBpm(BPM);

    let engineBpmDuringRender: number | null = null;
    let engineSwingDuringRender: number | null = null;
    await renderPattern(makeChannel('ch-frozen'), RENDER_BPM, progress => {
      if (progress <= 40 || engineBpmDuringRender !== null) return;
      engineBpmDuringRender = engine.bpm;
      engineSwingDuringRender = engine.swing;
      // The user changes the project while the render is in flight. The App
      // effects forward the values to the engine; the lease must keep them out of
      // the frozen take.
      audioEngine.setBpm(200);
      audioEngine.setSwing(0.4);
    });

    assert.equal(engineBpmDuringRender, RENDER_BPM, 'the render runs on the tempo it was handed');
    assert.equal(engineSwingDuringRender, 0, 'the frozen take keeps the swing it started with');
    assert.equal(triggered.length > 0, true, 'the pattern was scheduled');
    const swungStep = triggered.find(note => note.start === 1)!;
    assert.ok(
      Math.abs(swungStep.time - 1 * RENDER_SECONDS_PER_STEP) < 1e-9,
      'a mid-render swing write never reaches the rendered take (no groove displacement)',
    );
    assert.equal(engine.bpm, BPM, 'and the live tempo is restored untouched');
    assert.equal(engine.swing, 0, 'and the live swing is restored untouched');
  });

  it('refuses a second render while the lease is held', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    const notifications: number[] = [];

    let refusal: unknown = null;
    await renderPattern(makeChannel('ch-nested'), BPM, progress => {
      if (progress < 40 || refusal !== null) return;
      void audioEngine
        .renderTimelineOffline([makeChannel('ch-nested')], [], [], BPM, 1, undefined, false, 'pattern', undefined, 16)
        .then(() => { refusal = 'resolved'; }, error => { refusal = error; });
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok(refusal instanceof Error, 'the nested render is rejected');
    assert.match(String((refusal as Error).message), /already running/i);
    assert.deepEqual(notifications, [], 'and it did not notify a lease release');
  });
});

describe('Phase 66 F2 — the engine reports the released render lease', () => {
  it('notifies exactly once, after the lease is released and the live take resumed', async () => {
    setupLiveGraph();
    const transport = attachRecordingTransport();
    audioEngine.setSwing(0);
    audioEngine.play([makeChannel('ch-live')], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    assert.deepEqual(transport.calls, ['stop', 'start'], 'the take is running before the export');

    const observations: Array<{ leaseHeld: boolean; transportCalls: number }> = [];
    assert.ok(
      registerReleaseCallback(() => {
        observations.push({ leaseHeld: audioEngine.isOfflineRenderLeaseHeld(), transportCalls: transport.calls.length });
      }),
      'the engine exposes the render-lease release callback',
    );

    await renderPattern(makeChannel('ch-live'), BPM);

    assert.equal(observations.length, 1, 'one release notification per render');
    assert.equal(observations[0].leaseHeld, false, 'the lease is already released when the callback runs');
    assert.deepEqual(
      transport.calls,
      ['stop', 'start', 'stop', 'start'],
      'the renderer resumed the live take before notifying, so the callback re-publishes into a live engine',
    );
    assert.equal(observations[0].transportCalls, 4);
  });

  it('does not notify while the render still holds the lease', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    let notifications = 0;
    let leaseHeldDuringRender: boolean | null = null;
    assert.ok(registerReleaseCallback(() => { notifications += 1; }));

    await renderPattern(makeChannel('ch-timing'), BPM, progress => {
      if (progress <= 40 || leaseHeldDuringRender !== null) return;
      leaseHeldDuringRender = audioEngine.isOfflineRenderLeaseHeld();
      assert.equal(notifications, 0, 'nothing is published while the offline graph owns the engine');
    });

    assert.equal(leaseHeldDuringRender, true, 'the render really did hold the lease');
    assert.equal(notifications, 1);
  });

  it('still notifies when the render fails, and releases the lease', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    let notifications = 0;
    assert.ok(registerReleaseCallback(() => { notifications += 1; }));

    const brokenClip: PlaylistClip = {
      id: 'clip-missing',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'audio',
      audioBufferId: 'never-loaded',
      color: '#fff',
      name: 'Missing audio',
    };

    await assert.rejects(
      audioEngine.renderTimelineOffline([], [brokenClip], [], BPM, 1, undefined, false, 'song', undefined, undefined),
      /Missing audio buffer/,
    );

    assert.equal(audioEngine.isOfflineRenderLeaseHeld(), false, 'the lease is released after a failure');
    assert.equal(notifications, 1, 'the caller can re-publish the project state even when the export failed');
  });

  it('contains a throwing notification so the export still completes', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    assert.ok(registerReleaseCallback(() => { throw new Error('injected resync failure'); }));

    const buffer = await renderPattern(makeChannel('ch-throwing'), BPM);
    assert.ok(buffer, 'the rendered buffer is still returned');
    assert.equal(audioEngine.isOfflineRenderLeaseHeld(), false);
  });

  it('keeps a single notification even when a listener is replaced mid-render', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    const seen: string[] = [];
    assert.ok(registerReleaseCallback(() => seen.push('first')));

    await renderPattern(makeChannel('ch-replace'), BPM, progress => {
      if (progress > 40 && !seen.length) registerReleaseCallback(() => seen.push('second'));
    });

    assert.deepEqual(seen, ['second'], 'only the current listener is notified');
  });
});

describe('Phase 66 F2 — no silent state divergence after a render', () => {
  /**
   * Reproduces the audited defect exactly as the probe found it: the project
   * document moves on, the engine call is swallowed, and nothing ever
   * re-publishes the value. This is why the release notification is required —
   * the engine cannot know the project changed.
   */
  it('reproduces the divergence: a project change made during a render is swallowed', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    audioEngine.setSwing(0);
    audioEngine.setBpm(BPM);

    let liveProjectState: ProjectState = createDefaultProjectState();

    await renderPattern(makeChannel('ch-divergence'), RENDER_BPM, progress => {
      if (progress <= 40) return;
      // React project state first, then the App's existing publication effects.
      liveProjectState = {
        ...liveProjectState,
        meta: { ...liveProjectState.meta, bpm: 200, swing: 0.4 },
      };
      audioEngine.setBpm(liveProjectState.meta.bpm);
      audioEngine.setSwing(liveProjectState.meta.swing);
    });

    assert.equal(liveProjectState.meta.bpm, 200, 'the project document kept the user change');
    assert.equal(liveProjectState.meta.swing, 0.4);
    assert.equal(engine.bpm, BPM, 'the engine never learned about it');
    assert.equal(engine.swing, 0, 'and nothing re-published it after the render');
  });

  it('converges: the project state is re-published when the lease is released', async () => {
    setupLiveGraph();
    attachRecordingTransport();
    audioEngine.setSwing(0);
    audioEngine.setBpm(BPM);

    let liveProjectState: ProjectState = createDefaultProjectState();
    const { resynchronizeLiveEngineFromProjectState } = await import('../state/liveEngineResynchronization');

    assert.ok(
      registerReleaseCallback(() => {
        resynchronizeLiveEngineFromProjectState(audioEngine, liveProjectState, { metronome: false });
      }),
      'the engine exposes the render-lease release callback',
    );

    await renderPattern(makeChannel('ch-convergence'), RENDER_BPM, progress => {
      if (progress <= 40) return;
      liveProjectState = {
        ...liveProjectState,
        meta: { ...liveProjectState.meta, bpm: 200, swing: 0.4 },
        mixerTracks: liveProjectState.mixerTracks.map(track =>
          track.id === 1 ? { ...track, volume: 0.42 } : track,
        ),
      };
      audioEngine.setBpm(liveProjectState.meta.bpm);
      audioEngine.setSwing(liveProjectState.meta.swing);
      audioEngine.updateMixerTrack(liveProjectState.mixerTracks[1]);
    });

    assert.equal(engine.bpm, 200, 'the engine ends on the project tempo the user set during the render');
    assert.equal(engine.swing, 0.4, 'and on the project swing');
    assert.equal(
      engine.mixerChannels.get(1)?.output.gain.value,
      0.42,
      'the mixer edit reaches the live mixer graph the engine is actually playing through',
    );
  });
});

describe('Phase 66 F2 — production wiring', () => {
  it('App registers the release callback and re-publishes the project document', async () => {
    const { readFileSync } = await import('node:fs');
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.ok(
      appSource.includes('setOfflineRenderCompleteCallback'),
      'App.tsx must register the engine release callback',
    );
    assert.ok(
      appSource.includes('resynchronizeLiveEngineFromProjectState'),
      'and re-publish the authoritative project state through the shared module',
    );
  });

  it('the export dialog cannot be dismissed while a render is in flight', async () => {
    const { readFileSync } = await import('node:fs');
    const exportSource = readFileSync(new URL('../components/ExportModal.tsx', import.meta.url), 'utf8');

    assert.match(
      exportSource,
      /dismissible=\{!isRendering\}/,
      'Escape must be refused while the render that owns the dialog is still running',
    );
    const closeControl = exportSource.match(/<button[^>]*aria-label="Close export"[^>]*>/)?.[0] ?? '';
    assert.ok(closeControl.length > 0, 'the close control still exists');
    assert.ok(
      closeControl.includes('disabled={isRendering}') && closeControl.includes('onClick={onClose}'),
      'and it must not look clickable while dismissal is refused',
    );
  });

  it('the shared frame refuses Escape while a modal is not dismissible', async () => {
    const { readFileSync } = await import('node:fs');
    const frameSource = readFileSync(new URL('../components/ModalFrame.tsx', import.meta.url), 'utf8');

    assert.match(
      frameSource,
      /if \(!dismissibleRef\.current\) return;[\s\S]{0,160}handleDialogEscapeKey\(event, onCloseRef\.current\)/,
      'the dismissibility guard must run before the frame delegates to the shared Escape handler',
    );
    assert.match(
      frameSource,
      /dismissible\?: boolean;/,
      'and the frame must expose the contract to the modals that own long-running work',
    );
  });
});
