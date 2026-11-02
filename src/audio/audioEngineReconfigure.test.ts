/**
 * Engine lifecycle & AudioContext reconfiguration test suite.
 *
 * Clearly distinguishes two test tiers:
 * 1. Controlled Web Audio constructor harness: verifies active-operation blocking
 *    guards, constructor failure rollback, hardware sample-rate override honesty,
 *    and suspended/unexpectedly-closed state recovery.
 * 2. Real DSP rendering via `web-audio-engine` (`RenderingAudioContext` &
 *    `OfflineAudioContext`): verifies actual audio synthesis, Mixer routing/FX,
 *    sample-buffer preservation, and offline export parity across 44.1 / 48 / 96 kHz.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as WebAudio from 'web-audio-engine';
import { audioEngine } from './audioEngine';
import { audioDeviceManager } from './audioDeviceManager';
import { RecordingEngine } from './recordingEngine';
import { createDefaultProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { resynchronizeLiveEngineFromProjectState } from '../state/liveEngineResynchronization';

const AudioEngineCtor = (audioEngine as unknown as { constructor: new () => typeof audioEngine }).constructor;

interface TrackedContextInstance {
  readonly raw: AudioContext & { sinkId: string; sinkCalls: string[] };
  readonly options: AudioContextOptions | undefined;
  readonly sampleRate: number;
  readonly sinkId: string;
  readonly sinkCalls: readonly string[];
  state: AudioContextState;
  closedCount: number;
  resumedCount: number;
  triggerStateChange: () => void;
}

const installRenderingAudioEnvironment = (config: {
  forcedActualSampleRate?: number;
  rejectSampleRate?: number;
  baseLatency?: number;
  outputLatency?: number;
} = {}) => {
  const OriginalWindow = (globalThis as Record<string, unknown>).window;
  const OriginalAudioContext = (globalThis as Record<string, unknown>).AudioContext;
  const OriginalOfflineAudioContext = (globalThis as Record<string, unknown>).OfflineAudioContext;

  const instances: TrackedContextInstance[] = [];

  class InstrumentedAudioContext extends (WebAudio.RenderingAudioContext as unknown as {
    new (opts?: { sampleRate?: number }): AudioContext;
  }) {
    readonly constructedOptions: AudioContextOptions | undefined;
    private _stateOverride: AudioContextState = 'running';
    private _sinkId = '';
    readonly sinkCalls: string[] = [];
    closedCount = 0;
    resumedCount = 0;
    baseLatency: number | undefined;
    outputLatency: number | undefined;
    private readonly stateListeners = new Set<() => void>();
    onstatechange: (() => void) | null = null;

    constructor(options?: AudioContextOptions) {
      if (config.rejectSampleRate !== undefined && options?.sampleRate === config.rejectSampleRate) {
        const err = new Error(`Unsupported sampleRate ${options.sampleRate}`);
        err.name = 'NotSupportedError';
        throw err;
      }
      const effectiveRate =
        config.forcedActualSampleRate ?? options?.sampleRate ?? 44100;
      super({ sampleRate: effectiveRate });
      this.constructedOptions = options ? { ...options } : undefined;
      this.baseLatency = config.baseLatency;
      this.outputLatency = config.outputLatency;

      const self = this;
      instances.push({
        get raw() {
          return self as unknown as AudioContext & { sinkId: string; sinkCalls: string[] };
        },
        get options() {
          return self.constructedOptions;
        },
        get sampleRate() {
          return self.sampleRate;
        },
        get sinkId() {
          return self._sinkId;
        },
        get sinkCalls() {
          return self.sinkCalls;
        },
        get state() {
          return self.state;
        },
        set state(next: AudioContextState) {
          self._stateOverride = next;
        },
        get closedCount() {
          return self.closedCount;
        },
        get resumedCount() {
          return self.resumedCount;
        },
        triggerStateChange: () => {
          for (const listener of [...self.stateListeners]) listener();
          self.onstatechange?.();
        },
      });
    }

    get sinkId(): string {
      return this._sinkId;
    }

    async setSinkId(sinkId: string): Promise<void> {
      if (this._stateOverride === 'closed') {
        const err = new Error('Cannot setSinkId on closed AudioContext');
        err.name = 'InvalidStateError';
        throw err;
      }
      this.sinkCalls.push(sinkId);
      this._sinkId = sinkId;
    }

    override get state(): AudioContextState {
      return this._stateOverride;
    }

    override addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === 'statechange' && typeof listener === 'function') {
        this.stateListeners.add(listener as () => void);
      }
    }

    override removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === 'statechange' && typeof listener === 'function') {
        this.stateListeners.delete(listener as () => void);
      }
    }

    createMediaStreamSource(): MediaStreamAudioSourceNode {
      return this.createGain() as unknown as MediaStreamAudioSourceNode;
    }

    override async resume(): Promise<void> {
      if (this._stateOverride === 'closed') throw new Error('Cannot resume closed AudioContext');
      this.resumedCount += 1;
      this._stateOverride = 'running';
      for (const listener of [...this.stateListeners]) listener();
      this.onstatechange?.();
    }

    override async suspend(): Promise<void> {
      this._stateOverride = 'suspended';
      for (const listener of [...this.stateListeners]) listener();
      this.onstatechange?.();
    }

    override async close(): Promise<void> {
      this.closedCount += 1;
      this._stateOverride = 'closed';
      for (const listener of [...this.stateListeners]) listener();
      this.onstatechange?.();
    }
  }

  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).AudioContext = InstrumentedAudioContext;
  (globalThis as Record<string, unknown>).OfflineAudioContext = WebAudio.OfflineAudioContext;

  return {
    instances,
    restore: () => {
      audioDeviceManager.resetToDefaults();
      (globalThis as Record<string, unknown>).window = OriginalWindow;
      (globalThis as Record<string, unknown>).AudioContext = OriginalAudioContext;
      (globalThis as Record<string, unknown>).OfflineAudioContext = OriginalOfflineAudioContext;
    },
  };
};

test('reconfigureAudioContext refuses every active operation (playback, count-in, punch, recording, MIDI take, offline render, native VST3 prep)', async () => {
  const env = installRenderingAudioEnvironment();
  try {
    const engine = new AudioEngineCtor();
    engine.init();
    assert.equal(env.instances.length, 1);
    const initialCtx = engine.getContext();

    // 1. Active transport playback
    const project = createDefaultProjectState();
    engine.play(project.channels, project.playlistClips, 'pat', undefined, project.mixerTracks);
    assert.equal(engine.isPlaybackActive(), true);
    await assert.rejects(
      () => engine.reconfigureAudioContext({ sampleRate: 48000 }),
      /Stop transport playback/i,
    );
    assert.equal(engine.getContext(), initialCtx);
    assert.equal(env.instances[0].closedCount, 0);
    engine.stop();

    // 2. Active count-in
    const countInPromise = engine.beginRecordingCountIn(1);
    assert.equal(engine.isCountInRunning(), true);
    await assert.rejects(
      () => engine.reconfigureAudioContext({ sampleRate: 48000 }),
      /count-in/i,
    );
    engine.cancelRecordingCountIn();
    await countInPromise.catch(() => {});

    // 3. Active punch recording arm
    engine.setPunchRecording({ enabled: true, inBar: 2, inBeat: 1, outBar: 3, outBeat: 1 });
    const punchSession = engine.beginPunchRecording({ totalBars: 4, countInBars: 1 });
    assert.equal(engine.isPunchTakeActive(), true);
    await assert.rejects(
      () => engine.reconfigureAudioContext({ sampleRate: 48000 }),
      /punch recording|count-in/i,
    );
    engine.cancelPunchRecording();
    await punchSession.then(s => s.punchOut.catch(() => {}), () => {});

    // 4. Active offline render lease
    (engine as unknown as { offlineRenderLeaseHeld: boolean }).offlineRenderLeaseHeld = true;
    await assert.rejects(
      () => engine.reconfigureAudioContext({ sampleRate: 48000 }),
      /Offline audio export/i,
    );
    (engine as unknown as { offlineRenderLeaseHeld: boolean }).offlineRenderLeaseHeld = false;

    // 5. Active native VST3 preparation
    (engine as unknown as { nativePreparing: boolean }).nativePreparing = true;
    await assert.rejects(
      () => engine.reconfigureAudioContext({ sampleRate: 48000 }),
      /Native VST3 preparation/i,
    );
    (engine as unknown as { nativePreparing: boolean }).nativePreparing = false;

    // 6. Active MIDI performance recording via externalActiveOperationCheck
    engine.setExternalActiveOperationCheck(() => 'Stop active MIDI performance recording before reconfiguring the audio engine.');
    await assert.rejects(
      () => engine.reconfigureAudioContext({ sampleRate: 48000 }),
      /MIDI performance recording/i,
    );
    engine.setExternalActiveOperationCheck(null);

    // 7. Active RecordingEngine session
    const OriginalNavigator = globalThis.navigator;
    const OriginalMediaRecorder = globalThis.MediaRecorder;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop() {} }],
            getAudioTracks: () => [{ stop() {} }],
          }),
        },
      },
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: class {
        static isTypeSupported() { return true; }
        state = 'inactive';
        mimeType = 'audio/webm';
        ondataavailable: unknown = null;
        onstop: (() => void) | null = null;
        onerror: unknown = null;
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
      },
    });

    try {
      const rec = new RecordingEngine(() => engine.getContext(), { persistAudioClip: async () => {} });
      await rec.start();
      await assert.rejects(
        () => engine.reconfigureAudioContext({ sampleRate: 48000 }),
        /microphone audio recording/i,
      );
      await rec.cancel().catch(() => {});
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
      Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: OriginalMediaRecorder });
    }

    assert.equal(env.instances.length, 1, 'no replacement AudioContext may be created while blocked');
  } finally {
    env.restore();
  }
});

test('requested sample rates, latency preferences, telemetry honesty, and constructor failure rollback behave truthfully', async () => {
  const env = installRenderingAudioEnvironment({
    rejectSampleRate: 96000,
    baseLatency: 0.00533,
    outputLatency: 0.01067,
  });
  try {
    const engine = new AudioEngineCtor();

    // Uninitialized telemetry never fabricates numbers.
    const beforeInit = engine.getAudioEngineDiagnostics();
    assert.equal(beforeInit.initialized, false);
    assert.equal(beforeInit.contextState, 'uninitialized');
    assert.equal(beforeInit.actualSampleRate, null);
    assert.equal(beforeInit.latencyMetrics, null);

    // Reconfigure through 48,000 Hz + balanced, then 88,200 Hz + playback.
    const r48 = await engine.reconfigureAudioContext({
      sampleRate: 48000,
      latencyHint: 'balanced',
    });
    assert.equal(r48.actualSampleRate, 48000);
    assert.equal(r48.requestedSampleRate, 48000);
    assert.equal(r48.latencyHint, 'balanced');
    assert.equal(r48.sampleRateMatched, true);
    assert.deepEqual(env.instances[0].options, {
      sampleRate: 48000,
      latencyHint: 'balanced',
    });

    const diag48 = engine.getAudioEngineDiagnostics();
    assert.equal(diag48.actualSampleRate, 48000);
    assert.equal(diag48.latencyMetrics?.baseLatencySeconds, 0.00533);
    assert.equal(diag48.latencyMetrics?.outputLatencySeconds, 0.01067);
    assert.equal(diag48.latencyMetrics?.renderQuantumSamples, 128);

    const r88 = await engine.reconfigureAudioContext({
      sampleRate: 88200,
      latencyHint: 'playback',
    });
    assert.equal(r88.actualSampleRate, 88200);
    assert.equal(env.instances[0].closedCount, 1, 'previous 48 kHz context must be closed cleanly');
    assert.deepEqual(env.instances[1].options, {
      sampleRate: 88200,
      latencyHint: 'playback',
    });

    // Constructor failure on 96,000 Hz leaves 88,200 Hz live session untouched!
    const activeCtxBeforeFail = engine.getContext();
    await assert.rejects(
      () => engine.reconfigureAudioContext({ sampleRate: 96000, latencyHint: 'interactive' }),
      /rejected the requested configuration.*Previous audio session remains active/i,
    );
    assert.equal(engine.getContext(), activeCtxBeforeFail);
    assert.equal(env.instances[1].closedCount, 0);
    assert.equal(engine.getAudioEngineDiagnostics().actualSampleRate, 88200);
    assert.equal(engine.getAudioEngineDiagnostics().requestedSampleRate, 88200);
    assert.equal(engine.getAudioEngineDiagnostics().latencyHint, 'playback');
  } finally {
    env.restore();
  }
});

test('never displays requested sample rate as actual when hardware forces a different rate, and recovers from suspended/closed states', async () => {
  // Simulate OS audio hardware locked at 48,000 Hz regardless of requested rate.
  const env = installRenderingAudioEnvironment({ forcedActualSampleRate: 48000 });
  try {
    const engine = new AudioEngineCtor();
    const res = await engine.reconfigureAudioContext({
      sampleRate: 44100,
      latencyHint: 'interactive',
    });

    assert.equal(res.requestedSampleRate, 44100);
    assert.equal(res.actualSampleRate, 48000);
    assert.equal(res.sampleRateMatched, false);
    assert.match(res.sampleRateMismatchNotice ?? '', /Requested 44,100 Hz.*48,000 Hz/);

    const diag = engine.getAudioEngineDiagnostics();
    assert.equal(diag.requestedSampleRate, 44100);
    assert.equal(diag.actualSampleRate, 48000);

    // Simulate OS suspending context, then user resuming via Audio Settings.
    await (engine.getContext() as unknown as { suspend: () => Promise<void> }).suspend();
    assert.equal(engine.getAudioEngineDiagnostics().contextState, 'suspended');
    const afterResume = await engine.resumeAudioContext();
    assert.equal(afterResume.contextState, 'running');

    // Simulate unexpected external AudioContext close and recovery.
    env.instances[0].state = 'closed';
    env.instances[0].triggerStateChange();
    const closedDiag = engine.getAudioEngineDiagnostics();
    assert.equal(closedDiag.contextState, 'closed');
    assert.equal(closedDiag.unexpectedlyClosed, true);

    const recovered = await engine.resumeAudioContext();
    assert.equal(recovered.contextState, 'running');
    assert.equal(recovered.unexpectedlyClosed, false);
    assert.equal(env.instances.length, 2);
  } finally {
    env.restore();
  }
});

test('real DSP rendering: full graph, sample assets, Mixer FX/routing, project history, and offline export parity survive sample-rate reconfigurations (44.1 -> 48 -> 96 kHz)', async () => {
  const env = installRenderingAudioEnvironment();
  try {
    const engine = new AudioEngineCtor();
    const project = createDefaultProjectState();
    project.meta.bpm = 128;
    project.meta.timeSignature = [3, 4];

    // Configure Mixer Track 1 with an insert EQ + custom routing to Track 2 -> Master, plus channel pan.
    project.channels[0].instrumentType = 'minisynth';
    project.channels[0].pan = -0.35;
    project.channels[0].mixerTrackId = 1;
    project.channels[0].notes = [
      { id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
      { id: 'n2', pitch: 64, start: 4, duration: 4, velocity: 0.85 },
    ];
    project.mixerTracks[1].volume = 0.9;
    project.mixerTracks[1].routingTargetId = 2;
    project.mixerTracks[1].fxSlots = [
      {
        id: 'fx-eq-1',
        type: 'equalizer',
        name: '3-Band EQ',
        enabled: true,
        mix: 1,
        params: { lowGain: 2, midGain: 0, highGain: 1.5 },
      },
    ];
    project.playlistClips = [
      {
        id: 'clip-pat-1',
        type: 'pattern',
        channelId: project.channels[0].id,
        patternId: project.selectedPatternId,
        name: 'Pattern 1',
        color: '#4f8cff',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 1,
      },
    ];

    const history = createHistory(project);
    const editedProject = structuredClone(project);
    editedProject.meta.name = 'Session Across Sample Rates';
    const committedHistory = history.commit(editedProject, 'Rename session');

    engine.setAudioContextReconfiguredCallback(() => {
      resynchronizeLiveEngineFromProjectState(engine, editedProject, { metronome: false });
      for (const ch of editedProject.channels) {
        if (ch.pan !== 0) engine.updateChannel(ch);
      }
    });

    // Load a real decoded AudioBuffer asset before any sample-rate switch.
    const assetCtx = new WebAudio.OfflineAudioContext(1, 4410, 44100);
    const sampleAsset = assetCtx.createBuffer(1, 4410, 44100);
    const assetData = sampleAsset.getChannelData(0);
    for (let i = 0; i < assetData.length; i++) {
      assetData[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
    }
    engine.setSampleBuffer('asset-sine-440', sampleAsset as unknown as AudioBuffer);

    // 1. Initialize at 44,100 Hz and park playhead at 0.75s.
    await engine.reconfigureAudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    engine.seek(0.75);
    assert.equal(engine.getSampleRate(), 44100);

    const exportBefore = await engine.renderTimelineOffline(
      editedProject.channels,
      editedProject.playlistClips,
      editedProject.mixerTracks,
      editedProject.meta.bpm,
      1,
      48000,
      true,
      'song',
    );

    // 2. Reconfigure 44,100 Hz -> 48,000 Hz -> 96,000 Hz.
    await engine.reconfigureAudioContext({ sampleRate: 48000, latencyHint: 'balanced' });
    assert.equal(engine.getSampleRate(), 48000);

    await engine.reconfigureAudioContext({ sampleRate: 96000, latencyHint: 'playback' });
    assert.equal(engine.getSampleRate(), 96000);

    // Verify old contexts were cleanly closed and zero assets/history/project data were lost.
    assert.equal(env.instances[0].closedCount, 1);
    assert.equal(env.instances[1].closedCount, 1);
    assert.equal(env.instances[2].closedCount, 0);
    assert.equal(engine.getSampleBuffer('asset-sine-440'), sampleAsset);
    assert.equal(committedHistory.canUndo, true);
    assert.equal(committedHistory.present.meta.name, 'Session Across Sample Rates');
    assert.deepEqual(engine.getTimeSignature(), [3, 4]);
    assert.ok(Math.abs(engine.getTransportMusicalPosition().positionSeconds - 0.75) < 1e-6, 'paused playhead preserved');
    assert.ok(engine.getChannelPanner(editedProject.channels[0].id), 'channel panner rebuilt on 96 kHz context');
    assert.equal(engine.hasMixerChannel(1), true);
    assert.equal(engine.hasMixerChannel(2), true);

    // Trigger real live note synthesis on the 96,000 Hz RenderingAudioContext and verify audible energy!
    const live96Ctx = engine.getContext() as unknown as {
      processTo(time: number): void;
      exportAsAudioData(): { channelData: Float32Array[] };
    };
    engine.playNote(editedProject.channels[0], { id: 'live-n', pitch: 60, start: 0, duration: 4, velocity: 0.9 }, 0, 128);
    live96Ctx.processTo(0.25);
    const liveRendered = live96Ctx.exportAsAudioData();
    let livePeak = 0;
    for (let i = 0; i < liveRendered.channelData[0].length; i++) {
      livePeak = Math.max(
        livePeak,
        Math.abs(liveRendered.channelData[0][i]),
        Math.abs(liveRendered.channelData[1][i]),
      );
    }
    assert.ok(livePeak > 0.01, `expected audible live output on 96 kHz rebuilt graph, measured peak=${livePeak}`);

    // Verify 48 kHz offline export after live sample-rate reconfigurations matches pre-reconfigure export!
    const exportAfter = await engine.renderTimelineOffline(
      editedProject.channels,
      editedProject.playlistClips,
      editedProject.mixerTracks,
      editedProject.meta.bpm,
      1,
      48000,
      true,
      'song',
    );
    assert.equal(exportAfter.sampleRate, 48000);
    assert.equal(exportAfter.length, exportBefore.length);
    const beforeL = exportBefore.getChannelData(0);
    const afterL = exportAfter.getChannelData(0);
    let maxDiff = 0;
    let exportPeak = 0;
    for (let i = 0; i < beforeL.length; i++) {
      exportPeak = Math.max(exportPeak, Math.abs(afterL[i]));
      maxDiff = Math.max(maxDiff, Math.abs(beforeL[i] - afterL[i]));
    }
    assert.ok(exportPeak > 0.01, 'offline export produces audible signal');
    assert.ok(maxDiff < 1e-6, `offline export must remain bit-accurate after live sample-rate switches (maxDiff=${maxDiff})`);
  } finally {
    env.restore();
  }
});

test('P1 regression: binds current live AudioContext when started with persisted non-default output, reconfigured 48 kHz -> 96 kHz, switched between non-default outputs, and hot-unplugged after reconfiguration', async () => {
  const OriginalNavigator = globalThis.navigator;
  const OriginalLocalStorage = (globalThis as Record<string, unknown>).localStorage;

  const makeDevice = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({
    deviceId,
    groupId: `grp-${deviceId}`,
    kind,
    label,
    toJSON: () => ({ deviceId, kind, label }),
  });

  let availableDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'Studio USB DAC'),
    makeDevice('audiooutput', 'monitors-spdif', 'S/PDIF Reference Monitors'),
    makeDevice('audioinput', 'default', 'Default - Built-in Mic'),
  ];
  const deviceChangeListeners = new Set<EventListener>();
  const storageMap = new Map<string, string>();
  const memoryLocalStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageMap.set(key, value);
    },
    removeItem: (key: string) => {
      storageMap.delete(key);
    },
  };

  const env = installRenderingAudioEnvironment();
  try {
    (globalThis as Record<string, unknown>).localStorage = memoryLocalStorage;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          enumerateDevices: async () => availableDevices,
          addEventListener: (type: string, listener: EventListener) => {
            if (type === 'devicechange') deviceChangeListeners.add(listener);
          },
          removeEventListener: (type: string, listener: EventListener) => {
            if (type === 'devicechange') deviceChangeListeners.delete(listener);
          },
        },
      },
    });

    const engine = new AudioEngineCtor();
    audioDeviceManager.disposeMonitoring();
    audioDeviceManager.bindAudioContext(null);
    audioDeviceManager.resetToDefaults();

    // 0. Saving an output preference before the engine is initialized persists the
    // preference while truthfully reporting ok=false / liveSwitched=false.
    await engine.startDeviceMonitoring();
    const preInitChoice = await audioDeviceManager.selectOutputDevice('dac-usb');
    assert.equal(preInitChoice.preferenceSaved, true);
    assert.equal(preInitChoice.ok, false);
    assert.equal(preInitChoice.liveSwitched, false);
    assert.equal(preInitChoice.activeDeviceId, '');
    assert.equal(audioDeviceManager.getPreferredOutputDeviceId(), 'dac-usb');
    audioDeviceManager.updateEnginePreferences({ sampleRate: 48000 });

    // 1. Start engine with persisted non-default output ('dac-usb' @ 48 kHz) and verify
    // audioDeviceManager binds to the newly created 48 kHz context and applies 'dac-usb'.
    await engine.ensureAudioEngineInitialized();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(env.instances.length, 1);
    const ctx48 = env.instances[0];
    assert.equal(ctx48.sampleRate, 48000);
    assert.equal(audioDeviceManager.getBoundAudioContext(), ctx48.raw);
    assert.equal(ctx48.sinkId, 'dac-usb');
    assert.equal(audioDeviceManager.getActiveOutputDeviceId(), 'dac-usb');

    // 2 & 3. Reconfigure from 48 kHz to 96 kHz with non-default output ('dac-usb') selected;
    // verify old context is closed and audioDeviceManager points to the replacement context.
    const reconfig96 = await engine.reconfigureAudioContext({ sampleRate: 96000 });
    assert.equal(reconfig96.actualSampleRate, 96000);
    assert.equal(env.instances.length, 2);
    const ctx96 = env.instances[1];
    assert.notEqual(ctx96.raw, ctx48.raw);
    assert.equal(ctx48.state, 'closed');
    assert.equal(ctx48.closedCount, 1);
    assert.equal(audioDeviceManager.getBoundAudioContext(), ctx96.raw);
    assert.equal(ctx96.sinkId, 'dac-usb');
    assert.equal(audioDeviceManager.getActiveOutputDeviceId(), 'dac-usb');
    const ctx48SinkCallsAfterClose = ctx48.sinkCalls.length;

    // 4 & 5. Switch from one non-default output ('dac-usb') to another ('monitors-spdif')
    // after reconfiguration WITHOUT passing an explicit context (exact AudioSettingsModal call).
    const postReconfigSwitch = await audioDeviceManager.selectOutputDevice('monitors-spdif');
    assert.equal(postReconfigSwitch.ok, true);
    assert.equal(postReconfigSwitch.liveSwitched, true);
    assert.equal(postReconfigSwitch.activeDeviceId, 'monitors-spdif');
    assert.equal(ctx96.sinkId, 'monitors-spdif');
    assert.equal(audioDeviceManager.getActiveOutputDeviceId(), 'monitors-spdif');
    assert.equal(
      ctx48.sinkCalls.length,
      ctx48SinkCallsAfterClose,
      'closed 48 kHz context must never receive post-reconfigure setSinkId calls',
    );

    // 6 & 7. Simulate output-device disconnection after reconfiguration and verify
    // hot-unplug fallback is applied to the replacement 96 kHz context.
    availableDevices = [
      makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
      makeDevice('audiooutput', 'dac-usb', 'Studio USB DAC'),
      makeDevice('audioinput', 'default', 'Default - Built-in Mic'),
    ];
    for (const listener of [...deviceChangeListeners]) {
      listener(new Event('devicechange'));
    }
    await new Promise(resolve => setTimeout(resolve, 25));

    assert.equal(ctx96.sinkId, '');
    assert.equal(ctx96.sinkCalls.at(-1), '');
    assert.equal(audioDeviceManager.getActiveOutputDeviceId(), '');
    assert.equal(audioDeviceManager.getPreferredOutputDeviceId(), '');
    assert.equal(ctx48.sinkCalls.length, ctx48SinkCallsAfterClose);
    assert.match(
      audioDeviceManager.getSnapshot().outputNotice?.message ?? '',
      /disconnected.*Default System Device/i,
    );

    // 8. Verify null, closed, and foreign/stale contexts cannot report a successful live switch.
    const nullSwitch = await audioDeviceManager.selectOutputDevice('dac-usb', null);
    assert.equal(nullSwitch.ok, false);
    assert.equal(nullSwitch.liveSwitched, false);
    assert.equal(nullSwitch.preferenceSaved, false);
    assert.equal(audioDeviceManager.getBoundAudioContext(), ctx96.raw);

    const closedStaleSwitch = await audioDeviceManager.selectOutputDevice('dac-usb', ctx48.raw);
    assert.equal(closedStaleSwitch.ok, false);
    assert.equal(closedStaleSwitch.liveSwitched, false);
    assert.equal(closedStaleSwitch.preferenceSaved, false);
    assert.equal(audioDeviceManager.getBoundAudioContext(), ctx96.raw);

    const foreignCtx = new (globalThis.AudioContext as unknown as {
      new (opts?: AudioContextOptions): AudioContext & { sinkCalls: string[] };
    })({ sampleRate: 44100 });
    try {
      const foreignStaleSwitch = await audioDeviceManager.selectOutputDevice('dac-usb', foreignCtx);
      assert.equal(foreignStaleSwitch.ok, false);
      assert.equal(foreignStaleSwitch.liveSwitched, false);
      assert.equal(foreignStaleSwitch.preferenceSaved, false);
      assert.equal(foreignCtx.sinkCalls.length, 0);
      assert.equal(audioDeviceManager.getBoundAudioContext(), ctx96.raw);
    } finally {
      await foreignCtx.close();
    }

    engine.stopDeviceMonitoring();
    audioDeviceManager.bindAudioContext(null);
    audioDeviceManager.resetToDefaults();
  } finally {
    audioDeviceManager.disposeMonitoring();
    audioDeviceManager.bindAudioContext(null);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
    (globalThis as Record<string, unknown>).localStorage = OriginalLocalStorage;
    env.restore();
  }
});

test('P2 regression: AudioEngine.startDeviceMonitoring detects device changes while Audio Settings is closed without prompting microphone permission, and stopDeviceMonitoring removes listeners on teardown', async () => {
  const OriginalNavigator = globalThis.navigator;

  const makeDevice = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({
    deviceId,
    groupId: `grp-${deviceId}`,
    kind,
    label,
    toJSON: () => ({ deviceId, kind, label }),
  });

  let availableDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Output'),
    makeDevice('audioinput', 'default', 'Default - Built-in Mic'),
  ];
  let getUserMediaCalls = 0;
  let permissionsQueryCalls = 0;
  const deviceChangeListeners = new Set<EventListener>();
  const permissionChangeListeners = new Set<() => void>();

  const env = installRenderingAudioEnvironment();
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          enumerateDevices: async () => availableDevices,
          getUserMedia: async () => {
            getUserMediaCalls += 1;
            throw new Error('getUserMedia must never be called during startup passive monitoring');
          },
          addEventListener: (type: string, listener: EventListener) => {
            if (type === 'devicechange') deviceChangeListeners.add(listener);
          },
          removeEventListener: (type: string, listener: EventListener) => {
            if (type === 'devicechange') deviceChangeListeners.delete(listener);
          },
        },
        permissions: {
          query: async () => {
            permissionsQueryCalls += 1;
            return {
              state: 'prompt',
              addEventListener: (type: string, cb: () => void) => {
                if (type === 'change') permissionChangeListeners.add(cb);
              },
              removeEventListener: (type: string, cb: () => void) => {
                if (type === 'change') permissionChangeListeners.delete(cb);
              },
            };
          },
        },
      },
    });

    const engine = new AudioEngineCtor();
    audioDeviceManager.disposeMonitoring();
    audioDeviceManager.bindAudioContext(null);
    audioDeviceManager.resetToDefaults();

    let engineNotifications = 0;
    const unsubEngine = engine.subscribeAudioEngineState(() => {
      engineNotifications += 1;
    });

    // 1 & 2. Startup monitoring runs with Audio Settings closed and never calls getUserMedia.
    await engine.startDeviceMonitoring();
    assert.equal(getUserMediaCalls, 0, 'startup monitoring must never trigger getUserMedia');
    assert.equal(permissionsQueryCalls, 1, 'passive permission query should execute once');
    assert.equal(deviceChangeListeners.size, 1);
    assert.equal(permissionChangeListeners.size, 1);
    assert.equal(audioDeviceManager.isMonitoringActive(), true);

    // Hot-plug a USB interface while Audio Settings remains closed.
    const notificationsBeforeHotplug = engineNotifications;
    availableDevices = [
      ...availableDevices,
      makeDevice('audiooutput', 'usb-apollo', 'Universal Audio USB Out'),
      makeDevice('audioinput', 'usb-apollo-in', 'Universal Audio USB In'),
    ];
    for (const listener of [...deviceChangeListeners]) {
      listener(new Event('devicechange'));
    }
    await new Promise(resolve => setTimeout(resolve, 25));

    const snapAfterHotplug = audioDeviceManager.getSnapshot();
    assert.equal(
      snapAfterHotplug.outputDevices.some(d => d.deviceId === 'usb-apollo'),
      true,
      'output hot-plug must be observed while Audio Settings modal is closed',
    );
    assert.equal(
      snapAfterHotplug.inputDevices.some(d => d.deviceId === 'usb-apollo-in'),
      true,
      'input hot-plug must be observed while Audio Settings modal is closed',
    );
    assert.ok(engineNotifications > notificationsBeforeHotplug);

    // 5. Output hot-unplug fallback while Audio Settings is closed operates on the current live AudioContext.
    await engine.reconfigureAudioContext({ sampleRate: 96000 });
    const liveCtx96 = env.instances[0];
    const routed = await audioDeviceManager.selectOutputDevice('usb-apollo');
    assert.equal(routed.ok, true);
    assert.equal(liveCtx96.sinkId, 'usb-apollo');

    availableDevices = [
      makeDevice('audiooutput', 'default', 'Default - Built-in Output'),
      makeDevice('audioinput', 'default', 'Default - Built-in Mic'),
    ];
    for (const listener of [...deviceChangeListeners]) {
      listener(new Event('devicechange'));
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(liveCtx96.sinkId, '');
    assert.equal(audioDeviceManager.getActiveOutputDeviceId(), '');

    // 4. Application teardown removes both devicechange and permission listeners.
    unsubEngine();
    engine.stopDeviceMonitoring();
    assert.equal(audioDeviceManager.isMonitoringActive(), false);
    assert.equal(deviceChangeListeners.size, 0, 'teardown must remove devicechange listener');
    assert.equal(permissionChangeListeners.size, 0, 'teardown must remove permission listener');
    assert.equal(getUserMediaCalls, 0);

    audioDeviceManager.bindAudioContext(null);
    audioDeviceManager.resetToDefaults();
  } finally {
    audioDeviceManager.disposeMonitoring();
    audioDeviceManager.bindAudioContext(null);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
    env.restore();
  }
});

