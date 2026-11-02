/**
 * Unit & integration suite for AudioDeviceManager, RecordingEngine input
 * device routing, and AudioEngine recording capture constraints.
 *
 * Note on test environment: Node.js has no physical audio hardware or Web Media
 * browser backend, so MediaDevices / AudioContext.setSinkId / MediaRecorder are
 * deterministic test doubles exercising the production AudioDeviceManager,
 * RecordingEngine, and AudioEngine classes directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AudioDeviceManager,
  type AudioContextWithSinkId,
  type MediaDevicesLike,
  buildMicrophoneAudioTrackConstraints,
} from './audioDeviceManager';
import { RecordingEngine } from './recordingEngine';
import { audioEngine } from './audioEngine';
import {
  AUDIO_PREFERENCES_STORAGE_KEY,
  type StorageLike,
} from '../state/audioPreferences';

class MemoryStorage implements StorageLike {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

class FakeMediaStreamTrack {
  stopped = false;
  private readonly endedListeners = new Set<() => void>();
  onended: (() => void) | null = null;

  stop(): void {
    this.stopped = true;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.endedListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.endedListeners.delete(listener);
  }

  triggerUnexpectedHardwareEnd(): void {
    this.stopped = true;
    for (const listener of [...this.endedListeners]) {
      listener();
    }
    this.onended?.();
  }
}

class FakeMediaStream {
  readonly tracks: FakeMediaStreamTrack[];
  constructor(trackCount = 1) {
    this.tracks = Array.from({ length: trackCount }, () => new FakeMediaStreamTrack());
  }
  getTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }
}

class FakeSinkAudioContext {
  state: AudioContextState = 'running';
  sampleRate = 48000;
  sinkId = '';
  readonly sinkCalls: string[] = [];
  failOnSinkId: string | null = null;
  readonly failOnSinkIds = new Set<string>();
  failErrorMessage = 'Requested device not found';
  ignoreSinkSwitchForTarget: string | null = null;
  readonly ignoreSinkSwitchForTargets = new Set<string>();

  async setSinkId(id: string): Promise<void> {
    this.sinkCalls.push(id);
    if ((this.failOnSinkId !== null && id === this.failOnSinkId) || this.failOnSinkIds.has(id)) {
      const err = new Error(this.failErrorMessage);
      err.name = id === '' ? 'InvalidStateError' : 'NotFoundError';
      throw err;
    }
    if (
      (this.ignoreSinkSwitchForTarget !== null && id === this.ignoreSinkSwitchForTarget) ||
      this.ignoreSinkSwitchForTargets.has(id)
    ) {
      return;
    }
    this.sinkId = id;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return { connect() {}, disconnect() {} } as unknown as MediaStreamAudioSourceNode;
  }

  createAnalyser(): AnalyserNode {
    return {
      fftSize: 1024,
      smoothingTimeConstant: 0.65,
      connect() {},
      disconnect() {},
      getByteTimeDomainData(arr: Uint8Array) {
        arr.fill(128);
      },
    } as unknown as AnalyserNode;
  }
}

const makeDevice = (
  kind: 'audioinput' | 'audiooutput',
  deviceId: string,
  label: string,
  groupId = `grp-${deviceId}`,
): MediaDeviceInfo =>
  ({
    kind,
    deviceId,
    label,
    groupId,
    toJSON: () => ({ kind, deviceId, label, groupId }),
  }) as MediaDeviceInfo;

test('startup and passive monitoring never automatically request microphone permission', async () => {
  let getUserMediaCalls = 0;
  let enumerateCalls = 0;
  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => {
      enumerateCalls += 1;
      return [
        makeDevice('audiooutput', 'default', ''),
        makeDevice('audiooutput', 'dac-1', ''),
        makeDevice('audioinput', 'mic-1', ''),
      ];
    },
    getUserMedia: async () => {
      getUserMediaCalls += 1;
      return new FakeMediaStream() as unknown as MediaStream;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const manager = new AudioDeviceManager({
    storage: new MemoryStorage(),
    getMediaDevices: () => mediaDevices,
    getPermissions: () => ({
      query: async () => ({ state: 'prompt' }),
    }),
  });

  // Constructor performs zero media calls.
  assert.equal(getUserMediaCalls, 0);
  assert.equal(enumerateCalls, 0);

  // Passive monitoring enumerates devices without opening getUserMedia.
  const snap = await manager.initializePassiveMonitoring();
  assert.equal(getUserMediaCalls, 0);
  assert.equal(enumerateCalls, 1);
  assert.equal(snap.microphonePermission, 'prompt');

  // Unrevealed hardware labels use honest generic numbered placeholders, never fake brand names.
  assert.equal(snap.inputDevices[0].deviceId, '');
  assert.equal(snap.inputDevices[0].label, 'Default System Device');
  assert.equal(snap.inputDevices[1].deviceId, 'mic-1');
  assert.match(snap.inputDevices[1].label, /Audio Input 1 \(grant microphone access for hardware name\)/);
});

test('explicit microphone permission grant releases temporary tracks immediately and reveals hardware labels', async () => {
  let permissionGranted = false;
  const createdStreams: FakeMediaStream[] = [];
  let tracksStoppedBeforeEnumeration = false;

  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => {
      if (createdStreams.length > 0) {
        tracksStoppedBeforeEnumeration = createdStreams[0].tracks.every(t => t.stopped);
      }
      return [
        makeDevice('audiooutput', 'default', permissionGranted ? 'Default - USB Studio Monitors' : ''),
        makeDevice('audiooutput', 'out-usb', permissionGranted ? 'USB Studio Monitors' : ''),
        makeDevice('audioinput', 'default', permissionGranted ? 'Default - Condenser Mic' : ''),
        makeDevice('audioinput', 'in-xlr', permissionGranted ? 'XLR Interface Input 1' : ''),
      ];
    },
    getUserMedia: async () => {
      permissionGranted = true;
      const stream = new FakeMediaStream(2);
      createdStreams.push(stream);
      return stream as unknown as MediaStream;
    },
  };

  const manager = new AudioDeviceManager({
    storage: new MemoryStorage(),
    getMediaDevices: () => mediaDevices,
  });

  const result = await manager.requestMicrophonePermission();
  assert.equal(result.granted, true);
  assert.equal(result.permissionState, 'granted');
  assert.equal(createdStreams.length, 1);
  assert.equal(createdStreams[0].tracks.every(t => t.stopped), true);
  assert.equal(tracksStoppedBeforeEnumeration, true, 'temporary stream must stop before post-grant enumeration');

  const snap = manager.getSnapshot();
  assert.equal(snap.outputDevices[0].label, 'Default System Device (USB Studio Monitors)');
  assert.equal(snap.outputDevices[1].label, 'USB Studio Monitors');
  assert.equal(snap.inputDevices[1].label, 'XLR Interface Input 1');
});

test('microphone permission denial and runtime permission revocation report clear user-facing errors', async () => {
  let permState = 'granted';
  let onPermChange: (() => void) | null = null;

  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => [makeDevice('audioinput', 'in-1', permState === 'granted' ? 'Studio Mic' : '')],
    getUserMedia: async () => {
      const err = new Error('Permission dismissed');
      err.name = 'NotAllowedError';
      throw err;
    },
  };

  const manager = new AudioDeviceManager({
    storage: new MemoryStorage(),
    getMediaDevices: () => mediaDevices,
    getPermissions: () => ({
      query: async () => ({
        get state() {
          return permState;
        },
        addEventListener(_type: string, cb: () => void) {
          onPermChange = cb;
        },
      }),
    }),
  });

  await manager.initializePassiveMonitoring();
  assert.equal(manager.getSnapshot().microphonePermission, 'granted');

  // Revoke permission mid-session.
  permState = 'denied';
  onPermChange?.();
  assert.equal(manager.getSnapshot().microphonePermission, 'denied');
  assert.match(manager.getSnapshot().inputNotice?.message ?? '', /revoked/i);

  // Explicit request when denied surfaces actionable message.
  const deniedResult = await manager.requestMicrophonePermission();
  assert.equal(deniedResult.granted, false);
  assert.equal(deniedResult.permissionState, 'denied');
  assert.match(deniedResult.message ?? '', /denied/i);
});

test('output device switching routes live AudioContext via setSinkId, handles unsupported runtimes honestly, and falls back on unplug', async () => {
  let currentDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
    makeDevice('audiooutput', 'headphones-bt', 'Studio Headphones'),
  ];
  let deviceChangeHandler: EventListener | null = null;

  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => currentDevices,
    addEventListener: (type, cb) => {
      if (type === 'devicechange') deviceChangeHandler = cb;
    },
    removeEventListener: () => {
      deviceChangeHandler = null;
    },
  };

  const storage = new MemoryStorage();
  const manager = new AudioDeviceManager({
    storage,
    getMediaDevices: () => mediaDevices,
    getAudioContextConstructor: () => FakeSinkAudioContext,
  });

  const ctx = new FakeSinkAudioContext() as unknown as AudioContext & AudioContextWithSinkId;
  manager.bindAudioContext(ctx);
  await manager.initializePassiveMonitoring();

  // 1. Valid switch to External Studio DAC.
  const switched = await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(switched.ok, true);
  assert.equal(switched.activeDeviceId, 'dac-usb');
  assert.equal(ctx.sinkId, 'dac-usb');
  assert.equal(manager.getPreferences().outputDeviceId, 'dac-usb');

  // 2. Engine silent refusal (setSinkId resolves without changing sinkId to headphones-bt) is caught and never reported as success.
  (ctx as unknown as FakeSinkAudioContext).ignoreSinkSwitchForTarget = 'headphones-bt';
  const silentFailure = await manager.selectOutputDevice('headphones-bt', ctx);
  assert.equal(silentFailure.ok, false);
  assert.notEqual(silentFailure.activeDeviceId, 'headphones-bt');
  assert.equal(silentFailure.fellBackToDefault, true);
  assert.equal(manager.getActiveOutputDeviceId(ctx), '');
  (ctx as unknown as FakeSinkAudioContext).ignoreSinkSwitchForTarget = null;

  // Re-select External Studio DAC, then simulate physical USB unplug via devicechange.
  const reselected = await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(reselected.ok, true);
  assert.equal(ctx.sinkId, 'dac-usb');

  currentDevices = [makeDevice('audiooutput', 'default', 'Default - Built-in Speakers')];
  assert.ok(deviceChangeHandler, 'devicechange listener must be attached');
  deviceChangeHandler(new Event('devicechange'));
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(ctx.sinkId, '');
  assert.equal(manager.getActiveOutputDeviceId(ctx), '');
  assert.equal(manager.getPreferences().outputDeviceId, '');
  assert.match(manager.getSnapshot(ctx).outputNotice?.message ?? '', /disconnected.*Default System Device/i);

  // 3. Unsupported runtime (no setSinkId on AudioContext) never claims switching works.
  const unsupportedCtx = { state: 'running', sampleRate: 48000 } as unknown as AudioContext;
  const unsupportedManager = new AudioDeviceManager({
    storage: new MemoryStorage(),
    getMediaDevices: () => mediaDevices,
    getAudioContextConstructor: () => ({ prototype: {} }),
  });
  unsupportedManager.bindAudioContext(unsupportedCtx);
  const unsupportedResult = await unsupportedManager.selectOutputDevice('headphones-bt', unsupportedCtx);
  assert.equal(unsupportedResult.ok, false);
  assert.equal(unsupportedResult.unsupported, true);
  assert.equal(unsupportedResult.activeDeviceId, '');
  assert.match(unsupportedResult.message ?? '', /not supported/i);
});

test('selected input device wires exact deviceId constraints into BOTH RecordingEngine and AudioEngine, and handles unplug & unexpected stream end', async () => {
  const OriginalNavigator = globalThis.navigator;
  const OriginalMediaRecorder = globalThis.MediaRecorder;

  const capturedConstraints: MediaStreamConstraints[] = [];
  let activeStream = new FakeMediaStream(1);
  let rejectOverconstrained = false;

  class StubMediaRecorder {
    static isTypeSupported(): boolean {
      return true;
    }
    state: 'inactive' | 'recording' | 'paused' = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['pcm'], { type: 'audio/webm' }) });
        this.onstop?.();
      });
    }
  }

  const manager = new AudioDeviceManager({
    storage: new MemoryStorage(),
    getMediaDevices: () => ({
      enumerateDevices: async () => [
        makeDevice('audioinput', 'default', 'Default Mic'),
        makeDevice('audioinput', 'usb-mic-77', 'Studio USB Condenser'),
      ],
      getUserMedia: async constraints => {
        capturedConstraints.push(constraints);
        if (rejectOverconstrained) {
          const err = new Error('Overconstrained');
          err.name = 'OverconstrainedError';
          throw err;
        }
        activeStream = new FakeMediaStream(1);
        return activeStream as unknown as MediaStream;
      },
    }),
  });

  await manager.refreshDevices();
  const selected = manager.selectInputDevice('usb-mic-77');
  assert.equal(selected.ok, true);
  assert.deepEqual(buildMicrophoneAudioTrackConstraints('usb-mic-77'), {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    deviceId: { exact: 'usb-mic-77' },
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [
          makeDevice('audioinput', 'default', 'Default Mic'),
          makeDevice('audioinput', 'usb-mic-77', 'Studio USB Condenser'),
        ],
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          capturedConstraints.push(constraints);
          if (rejectOverconstrained) {
            const err = new Error('Overconstrained');
            err.name = 'OverconstrainedError';
            throw err;
          }
          activeStream = new FakeMediaStream(1);
          return activeStream as unknown as MediaStream;
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: StubMediaRecorder,
  });

  const prevEngineCtx = (audioEngine as unknown as { ctx: AudioContext | null }).ctx;
  try {
    const fakeCtx = new FakeSinkAudioContext() as unknown as AudioContext;
    const recorderErrors: Error[] = [];

    // Entry point A: RecordingEngine.start()
    const recorder = new RecordingEngine(() => fakeCtx, {
      deviceManager: manager,
      persistAudioClip: async () => {},
      onError: err => recorderErrors.push(err),
    });

    await recorder.start();
    assert.equal(recorder.getState(), 'recording');
    assert.deepEqual((capturedConstraints[0].audio as MediaTrackConstraints).deviceId, {
      exact: 'usb-mic-77',
    });

    // Simulate unexpected microphone USB disconnect mid-recording!
    activeStream.tracks[0].triggerUnexpectedHardwareEnd();
    assert.equal(recorder.getState(), 'idle');
    assert.equal(recorderErrors.length, 1);
    assert.match(recorderErrors[0].message, /ended unexpectedly/i);

    // Entry point B: AudioEngine.startAudioRecording() via global audioDeviceManager
    const { audioDeviceManager: globalDeviceManager } = await import('./audioDeviceManager');
    await globalDeviceManager.refreshDevices();
    globalDeviceManager.selectInputDevice('usb-mic-77');
    (audioEngine as unknown as { ctx: AudioContext | null }).ctx = fakeCtx;

    await audioEngine.startAudioRecording();
    const lastConstraint = capturedConstraints[capturedConstraints.length - 1];
    assert.deepEqual((lastConstraint.audio as MediaTrackConstraints).deviceId, {
      exact: 'usb-mic-77',
    });
    assert.equal(audioEngine.isAudioRecordingActive(), true);

    // Unexpected stream end on AudioEngine recording path cleans up active state immediately.
    activeStream.tracks[0].triggerUnexpectedHardwareEnd();
    assert.equal(audioEngine.isAudioRecordingActive(), false);

    // Missing selected device produces clear actionable error instead of silent wrong-mic fallback.
    rejectOverconstrained = true;
    await assert.rejects(
      () => recorder.start(),
      /Selected audio input device is unavailable or disconnected/i,
    );
    assert.equal(manager.getSnapshot().selectedInputAvailable, false);

    globalDeviceManager.resetToDefaults();
  } finally {
    (audioEngine as unknown as { ctx: AudioContext | null }).ctx = prevEngineCtx;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: OriginalMediaRecorder });
  }
});

test('P1 regression: pre-init output selection saves preference with ok=false, while null, closed, or stale AudioContext never reports a successful live switch or clobbers boundContext', async () => {
  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => [
      makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
      makeDevice('audiooutput', 'dac-usb', 'Studio USB DAC'),
      makeDevice('audiooutput', 'monitors-spdif', 'S/PDIF Reference Monitors'),
    ],
  };

  const storage = new MemoryStorage();
  const manager = new AudioDeviceManager({
    storage,
    getMediaDevices: () => mediaDevices,
    getAudioContextConstructor: () => FakeSinkAudioContext,
  });
  await manager.refreshDevices();

  // 1. Pre-initialization: boundContext is null; preference is saved while ok=false / liveSwitched=false.
  const preInit = await manager.selectOutputDevice('dac-usb');
  assert.equal(preInit.ok, false);
  assert.equal(preInit.liveSwitched, false);
  assert.equal(preInit.preferenceSaved, true);
  assert.equal(preInit.activeDeviceId, '');
  assert.equal(manager.getPreferredOutputDeviceId(), 'dac-usb');

  // 2. Bind live 48 kHz context, then replace with live 96 kHz context and close the 48 kHz context.
  const oldCtx48 = new FakeSinkAudioContext() as unknown as AudioContext & AudioContextWithSinkId;
  manager.bindAudioContext(oldCtx48);
  const firstLive = await manager.selectOutputDevice('dac-usb');
  assert.equal(firstLive.ok, true);
  assert.equal(firstLive.liveSwitched, true);
  assert.equal(oldCtx48.sinkId, 'dac-usb');

  const liveCtx96Fake = new FakeSinkAudioContext();
  liveCtx96Fake.sampleRate = 96000;
  const liveCtx96 = liveCtx96Fake as unknown as AudioContext & AudioContextWithSinkId;
  (oldCtx48 as unknown as FakeSinkAudioContext).state = 'closed';
  manager.bindAudioContext(liveCtx96);
  const appliedReplacement = await manager.applyOutputDeviceToContext(liveCtx96, 'dac-usb', {
    persist: true,
  });
  assert.equal(appliedReplacement.ok, true);
  assert.equal(appliedReplacement.liveSwitched, true);
  assert.equal(manager.getBoundAudioContext(), liveCtx96);
  assert.equal(liveCtx96.sinkId, 'dac-usb');

  // 3. Explicit null context cannot report a live switch or clobber boundContext.
  const nullDirect = await manager.applyOutputDeviceToContext(null, 'monitors-spdif');
  assert.equal(nullDirect.ok, false);
  assert.equal(nullDirect.liveSwitched, false);
  assert.equal(nullDirect.preferenceSaved, false);
  assert.equal(manager.getBoundAudioContext(), liveCtx96);
  assert.equal(manager.getPreferredOutputDeviceId(), 'dac-usb');

  // 4. Closed stale context cannot report a live switch or re-bind itself.
  const closedSwitch = await manager.selectOutputDevice('monitors-spdif', oldCtx48);
  assert.equal(closedSwitch.ok, false);
  assert.equal(closedSwitch.liveSwitched, false);
  assert.equal(closedSwitch.preferenceSaved, false);
  assert.equal(manager.getBoundAudioContext(), liveCtx96);
  assert.equal(liveCtx96.sinkId, 'dac-usb');

  // 5. Foreign running (stale/unclosed) context cannot report a live switch or hijack boundContext.
  const foreignRunningCtx = new FakeSinkAudioContext() as unknown as AudioContext & AudioContextWithSinkId;
  const foreignSwitch = await manager.selectOutputDevice('monitors-spdif', foreignRunningCtx);
  assert.equal(foreignSwitch.ok, false);
  assert.equal(foreignSwitch.liveSwitched, false);
  assert.equal(foreignSwitch.preferenceSaved, false);
  assert.equal((foreignRunningCtx as unknown as FakeSinkAudioContext).sinkCalls.length, 0);
  assert.equal(manager.getBoundAudioContext(), liveCtx96);

  // 6. Verified sinkId readback also guards Default System Device ('') switches.
  (liveCtx96 as unknown as FakeSinkAudioContext).ignoreSinkSwitchForTarget = '';
  const failedDefaultReset = await manager.selectOutputDevice('');
  assert.equal(failedDefaultReset.ok, false);
  assert.equal(failedDefaultReset.liveSwitched, false);
  assert.equal(failedDefaultReset.activeDeviceId, 'dac-usb');
  (liveCtx96 as unknown as FakeSinkAudioContext).ignoreSinkSwitchForTarget = null;
});

test('P2 regression: initializePassiveMonitoring is idempotent across concurrent/repeated calls, never calls getUserMedia, and disposeMonitoring cleanly removes devicechange and permission listeners even mid-flight', async () => {
  let getUserMediaCalls = 0;
  let permissionsQueryCalls = 0;
  const deviceChangeListeners = new Set<EventListener>();
  const permissionChangeListeners = new Set<() => void>();

  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => [
      makeDevice('audiooutput', 'default', 'Default Speakers'),
      makeDevice('audioinput', 'default', 'Default Mic'),
    ],
    getUserMedia: async () => {
      getUserMediaCalls += 1;
      throw new Error('getUserMedia must not run during passive monitoring');
    },
    addEventListener: (type, cb) => {
      if (type === 'devicechange') deviceChangeListeners.add(cb);
    },
    removeEventListener: (type, cb) => {
      if (type === 'devicechange') deviceChangeListeners.delete(cb);
    },
  };

  const manager = new AudioDeviceManager({
    storage: new MemoryStorage(),
    getMediaDevices: () => mediaDevices,
    getPermissions: () => ({
      query: async () => {
        permissionsQueryCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
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
    }),
  });

  // Concurrent + repeated calls attach listeners exactly once and never call getUserMedia.
  await Promise.all([
    manager.initializePassiveMonitoring(),
    manager.initializePassiveMonitoring(),
  ]);
  await manager.initializePassiveMonitoring();

  assert.equal(getUserMediaCalls, 0);
  assert.equal(permissionsQueryCalls, 1);
  assert.equal(deviceChangeListeners.size, 1);
  assert.equal(permissionChangeListeners.size, 1);
  assert.equal(manager.isMonitoringActive(), true);

  // Teardown disposes both listeners cleanly.
  manager.disposeMonitoring();
  assert.equal(manager.isMonitoringActive(), false);
  assert.equal(deviceChangeListeners.size, 0);
  assert.equal(permissionChangeListeners.size, 0);

  // Mid-flight dispose during async permissions.query prevents stale permission listener attachment.
  const inflight = manager.initializePassiveMonitoring();
  manager.disposeMonitoring();
  await inflight;
  assert.equal(manager.isMonitoringActive(), false);
  assert.equal(deviceChangeListeners.size, 0);
  assert.equal(permissionChangeListeners.size, 0);
  assert.equal(getUserMediaCalls, 0);
});

test('Fallback regression 1: hot-unplug + rejected setSinkId("") never claims fallback succeeded, preserves observed sinkId, keeps output unavailable, and never persists disconnected sink', async () => {
  let currentDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
  ];
  let deviceChangeHandler: EventListener | null = null;

  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => currentDevices,
    addEventListener: (type, cb) => {
      if (type === 'devicechange') deviceChangeHandler = cb;
    },
    removeEventListener: () => {
      deviceChangeHandler = null;
    },
  };

  const storage = new MemoryStorage();
  const manager = new AudioDeviceManager({
    storage,
    getMediaDevices: () => mediaDevices,
    getAudioContextConstructor: () => FakeSinkAudioContext,
  });

  const fakeCtx = new FakeSinkAudioContext();
  const ctx = fakeCtx as unknown as AudioContext & AudioContextWithSinkId;
  manager.bindAudioContext(ctx);
  await manager.initializePassiveMonitoring();

  const selected = await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(selected.ok, true);
  assert.equal(fakeCtx.sinkId, 'dac-usb');
  assert.equal(manager.getPreferences().outputDeviceId, 'dac-usb');

  // Unplug External Studio DAC while live fallback setSinkId('') rejects.
  currentDevices = [makeDevice('audiooutput', 'default', 'Default - Built-in Speakers')];
  fakeCtx.failOnSinkIds.add('');
  fakeCtx.failErrorMessage = 'Audio hardware sink busy';

  assert.ok(deviceChangeHandler, 'devicechange listener must be attached');
  deviceChangeHandler(new Event('devicechange'));
  await new Promise(resolve => setTimeout(resolve, 20));

  const snap = manager.getSnapshot(ctx);
  assert.equal(snap.lastOutputFallback?.status, 'failed');
  assert.equal(snap.lastOutputFallback?.verifiedLiveDefault, false);
  assert.equal(snap.lastOutputFallback?.attemptedLiveSwitch, true);
  assert.equal(snap.lastOutputFallback?.actualOutputDeviceId, 'dac-usb');
  assert.equal(snap.selectedOutputAvailable, false, 'disconnected device must not be marked available');
  assert.equal(snap.activeOutputDeviceId, 'dac-usb', 'actual observed sinkId readback must be preserved');
  assert.equal(manager.getActiveOutputDeviceId(ctx), 'dac-usb');

  // Disconnected sink ID must NOT remain persisted as though fallback succeeded.
  assert.equal(manager.getPreferences().outputDeviceId, '');
  const persistedRaw = JSON.parse(storage.getItem(AUDIO_PREFERENCES_STORAGE_KEY) ?? '{}') as {
    outputDeviceId?: string;
  };
  assert.equal(persistedRaw.outputDeviceId, '');

  assert.equal(snap.outputNotice?.tone, 'error');
  assert.match(snap.outputNotice?.message ?? '', /disconnected/i);
  assert.match(
    snap.outputNotice?.message ?? '',
    /Default System Device fallback could not be confirmed.*Audio hardware sink busy/i,
  );
  assert.doesNotMatch(
    snap.outputNotice?.message ?? '',
    /Audio output fell back to Default System Device/i,
  );

  // Subsequent passive refresh while fallback remains unverified must keep selectedOutputAvailable=false.
  const refreshed = await manager.refreshDevices();
  assert.equal(refreshed.selectedOutputAvailable, false);
  assert.equal(refreshed.activeOutputDeviceId, 'dac-usb');
});

test('Fallback regression 2: hot-unplug + silent no-op setSinkId("") treats stuck sinkId readback as failed fallback', async () => {
  let currentDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
  ];

  const storage = new MemoryStorage();
  const manager = new AudioDeviceManager({
    storage,
    getMediaDevices: () => ({
      enumerateDevices: async () => currentDevices,
    }),
    getAudioContextConstructor: () => FakeSinkAudioContext,
  });

  const fakeCtx = new FakeSinkAudioContext();
  const ctx = fakeCtx as unknown as AudioContext & AudioContextWithSinkId;
  manager.bindAudioContext(ctx);
  await manager.refreshDevices();

  const switched = await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(switched.ok, true);
  assert.equal(fakeCtx.sinkId, 'dac-usb');

  // Unplug External Studio DAC while setSinkId('') resolves as a silent no-op (sinkId stays 'dac-usb').
  currentDevices = [makeDevice('audiooutput', 'default', 'Default - Built-in Speakers')];
  fakeCtx.ignoreSinkSwitchForTargets.add('');

  const snap = await manager.refreshDevices({ fromHotPlug: true });

  assert.equal(fakeCtx.sinkCalls.at(-1), '');
  assert.equal(fakeCtx.sinkId, 'dac-usb');
  assert.equal(snap.lastOutputFallback?.status, 'failed');
  assert.equal(snap.lastOutputFallback?.verifiedLiveDefault, false);
  assert.equal(snap.lastOutputFallback?.actualOutputDeviceId, 'dac-usb');
  assert.equal(snap.selectedOutputAvailable, false, 'silent no-op fallback must not mark output available');
  assert.equal(snap.activeOutputDeviceId, 'dac-usb', 'observed stuck sinkId must be preserved');

  // Disconnected sink ID must NOT be persisted as current output preference.
  assert.equal(manager.getPreferences().outputDeviceId, '');
  const persistedRaw = JSON.parse(storage.getItem(AUDIO_PREFERENCES_STORAGE_KEY) ?? '{}') as {
    outputDeviceId?: string;
  };
  assert.equal(persistedRaw.outputDeviceId, '');

  assert.equal(snap.outputNotice?.tone, 'error');
  assert.match(
    snap.outputNotice?.message ?? '',
    /Default System Device fallback could not be confirmed.*remained routed to "dac-usb"/i,
  );
  assert.doesNotMatch(
    snap.outputNotice?.message ?? '',
    /Audio output fell back to Default System Device/i,
  );

  const refreshedAfterSilentNoop = await manager.refreshDevices();
  assert.equal(refreshedAfterSilentNoop.selectedOutputAvailable, false);
  assert.equal(refreshedAfterSilentNoop.activeOutputDeviceId, 'dac-usb');
});

test('Fallback regression 3: separates switch/fallback failure from existing output availability across default (Case A), connected non-default (Case B), and genuinely disconnected (Case C) outputs', async () => {
  let currentDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
    makeDevice('audiooutput', 'broken-spdif', 'Broken S/PDIF Output'),
  ];

  const storage = new MemoryStorage();
  const manager = new AudioDeviceManager({
    storage,
    getMediaDevices: () => ({
      enumerateDevices: async () => currentDevices,
    }),
    getAudioContextConstructor: () => FakeSinkAudioContext,
  });

  const fakeCtx = new FakeSinkAudioContext();
  const ctx = fakeCtx as unknown as AudioContext & AudioContextWithSinkId;
  manager.bindAudioContext(ctx);
  await manager.refreshDevices();

  // Case A: Existing Default System Device ('') remains active when 'broken-spdif' and redundant setSinkId('') both reject.
  // Availability must remain true, while ok=false, fellBackToDefault=false, and fallbackOutcome.status='failed'.
  fakeCtx.failOnSinkIds.add('broken-spdif');
  fakeCtx.failOnSinkIds.add('');
  fakeCtx.failErrorMessage = 'Driver endpoint fault';

  const fromDefaultFail = await manager.selectOutputDevice('broken-spdif', ctx);
  assert.equal(fromDefaultFail.ok, false);
  assert.equal(fromDefaultFail.liveSwitched, false);
  assert.equal(fromDefaultFail.preferenceSaved, false);
  assert.equal(fromDefaultFail.fellBackToDefault, false);
  assert.equal(fromDefaultFail.activeDeviceId, '');
  assert.equal(fromDefaultFail.fallbackOutcome?.status, 'failed');
  assert.equal(fromDefaultFail.fallbackOutcome?.verifiedLiveDefault, false);
  assert.equal(fromDefaultFail.fallbackOutcome?.selectedOutputAvailable, true);

  assert.equal(fakeCtx.sinkId, '');
  assert.equal(manager.getActiveOutputDeviceId(ctx), '');
  assert.equal(manager.getPreferences().outputDeviceId, '');

  const snapCaseABeforeRefresh = manager.getSnapshot(ctx);
  assert.equal(snapCaseABeforeRefresh.activeOutputDeviceId, '');
  assert.equal(snapCaseABeforeRefresh.preferences.outputDeviceId, '');
  assert.equal(
    snapCaseABeforeRefresh.selectedOutputAvailable,
    true,
    'existing Default System Device remains active and available',
  );
  assert.equal(snapCaseABeforeRefresh.lastOutputFallback?.status, 'failed');
  assert.equal(snapCaseABeforeRefresh.outputNotice?.tone, 'error');
  assert.match(
    fromDefaultFail.message ?? '',
    /Could not route audio output to the selected device.*Default System Device fallback could not be confirmed.*Audio output remains on Default System Device/i,
  );
  assert.doesNotMatch(
    fromDefaultFail.message ?? '',
    /Audio output fell back to Default System Device/i,
  );

  const snapCaseAAfterRefresh = await manager.refreshDevices();
  assert.equal(snapCaseAAfterRefresh.selectedOutputAvailable, true);
  assert.equal(snapCaseAAfterRefresh.activeOutputDeviceId, '');
  assert.equal(snapCaseAAfterRefresh.preferences.outputDeviceId, '');
  assert.equal(snapCaseAAfterRefresh.outputNotice?.tone, 'error');

  // Case B: Select connected 'dac-usb', keep 'dac-usb' enumerated & connected, then fail both 'broken-spdif' and fallback ''.
  // 'dac-usb' remains persisted, active, and available before and after passive refreshDevices().
  fakeCtx.failOnSinkIds.clear();
  const onUsb = await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(onUsb.ok, true);
  assert.equal(fakeCtx.sinkId, 'dac-usb');
  assert.equal(manager.getPreferences().outputDeviceId, 'dac-usb');

  fakeCtx.failOnSinkIds.add('broken-spdif');
  fakeCtx.failOnSinkIds.add('');
  fakeCtx.failErrorMessage = 'Sink switch rejected';

  const fromUsbFail = await manager.selectOutputDevice('broken-spdif', ctx);
  assert.equal(fromUsbFail.ok, false);
  assert.equal(fromUsbFail.liveSwitched, false);
  assert.equal(fromUsbFail.preferenceSaved, false);
  assert.equal(fromUsbFail.fellBackToDefault, false);
  assert.equal(fromUsbFail.activeDeviceId, 'dac-usb');
  assert.equal(fromUsbFail.fallbackOutcome?.status, 'failed');
  assert.equal(fromUsbFail.fallbackOutcome?.verifiedLiveDefault, false);
  assert.equal(fromUsbFail.fallbackOutcome?.selectedOutputAvailable, true);

  assert.equal(fakeCtx.sinkId, 'dac-usb');
  assert.equal(manager.getActiveOutputDeviceId(ctx), 'dac-usb');
  assert.equal(manager.getPreferences().outputDeviceId, 'dac-usb');
  const persistedCaseB = JSON.parse(storage.getItem(AUDIO_PREFERENCES_STORAGE_KEY) ?? '{}') as {
    outputDeviceId?: string;
  };
  assert.equal(persistedCaseB.outputDeviceId, 'dac-usb');

  const snapCaseBBeforeRefresh = manager.getSnapshot(ctx);
  assert.equal(snapCaseBBeforeRefresh.activeOutputDeviceId, 'dac-usb');
  assert.equal(snapCaseBBeforeRefresh.preferences.outputDeviceId, 'dac-usb');
  assert.equal(
    snapCaseBBeforeRefresh.selectedOutputAvailable,
    true,
    'connected dac-usb remains active and must not be marked unavailable',
  );
  assert.equal(snapCaseBBeforeRefresh.lastOutputFallback?.status, 'failed');
  assert.equal(snapCaseBBeforeRefresh.outputNotice?.tone, 'error');
  assert.match(
    fromUsbFail.message ?? '',
    /Could not route audio output to the selected device.*Default System Device fallback could not be confirmed.*Previous output \(External Studio DAC\) remains active/i,
  );
  assert.doesNotMatch(
    fromUsbFail.message ?? '',
    /Audio output fell back to Default System Device/i,
  );

  const snapCaseBAfterRefresh = await manager.refreshDevices();
  assert.equal(snapCaseBAfterRefresh.selectedOutputAvailable, true);
  assert.equal(snapCaseBAfterRefresh.activeOutputDeviceId, 'dac-usb');
  assert.equal(snapCaseBAfterRefresh.preferences.outputDeviceId, 'dac-usb');
  assert.equal(snapCaseBAfterRefresh.outputNotice?.tone, 'error');

  // Also verify missing target ('unplugged-hdmi') while 'dac-usb' remains connected and fallback silently no-ops:
  // 'dac-usb' still remains connected and active, so selectedOutputAvailable stays true while fellBackToDefault=false.
  fakeCtx.failOnSinkIds.clear();
  fakeCtx.ignoreSinkSwitchForTargets.add('');
  const missingTargetWhileUsbConnected = await manager.selectOutputDevice('unplugged-hdmi', ctx);
  assert.equal(missingTargetWhileUsbConnected.ok, false);
  assert.equal(missingTargetWhileUsbConnected.fellBackToDefault, false);
  assert.equal(missingTargetWhileUsbConnected.activeDeviceId, 'dac-usb');
  assert.equal(missingTargetWhileUsbConnected.fallbackOutcome?.status, 'failed');
  assert.equal(manager.getSnapshot(ctx).selectedOutputAvailable, true);

  // Case C: When 'dac-usb' itself is genuinely disconnected (absent from enumerated outputs) and both target switch
  // and fallback fail (leaving ctx.sinkId on unenumerated 'dac-usb'), selectedOutputAvailable MUST be false before and after refresh.
  currentDevices = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'broken-spdif', 'Broken S/PDIF Output'),
  ];
  await manager.refreshDevices({ fromHotPlug: true });
  assert.equal(manager.getSnapshot(ctx).selectedOutputAvailable, false);
  assert.equal(manager.getSnapshot(ctx).activeOutputDeviceId, 'dac-usb');

  fakeCtx.ignoreSinkSwitchForTargets.clear();
  fakeCtx.failOnSinkIds.add('broken-spdif');
  fakeCtx.failOnSinkIds.add('');
  const switchWhileDisconnectedFail = await manager.selectOutputDevice('broken-spdif', ctx);
  assert.equal(switchWhileDisconnectedFail.ok, false);
  assert.equal(switchWhileDisconnectedFail.fellBackToDefault, false);
  assert.equal(switchWhileDisconnectedFail.activeDeviceId, 'dac-usb');
  assert.equal(switchWhileDisconnectedFail.fallbackOutcome?.status, 'failed');
  assert.equal(switchWhileDisconnectedFail.fallbackOutcome?.selectedOutputAvailable, false);
  assert.equal(manager.getPreferences().outputDeviceId, '');
  assert.equal(manager.getSnapshot(ctx).selectedOutputAvailable, false);
  assert.doesNotMatch(
    switchWhileDisconnectedFail.message ?? '',
    /remains active|remains on Default System Device/i,
  );

  const snapCaseCAfterRefresh = await manager.refreshDevices();
  assert.equal(snapCaseCAfterRefresh.selectedOutputAvailable, false);
  assert.equal(snapCaseCAfterRefresh.activeOutputDeviceId, 'dac-usb');
});

test('Fallback regression 4: confirmed sinkId === "" fallback control case and preference-only no-context distinction', async () => {
  let currentDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
    makeDevice('audiooutput', 'flaky-hdmi', 'HDMI Receiver'),
  ];

  const storage = new MemoryStorage();
  const manager = new AudioDeviceManager({
    storage,
    getMediaDevices: () => ({
      enumerateDevices: async () => currentDevices,
    }),
    getAudioContextConstructor: () => FakeSinkAudioContext,
  });

  // 1. Pre-init (no live AudioContext): missing device produces 'preference-only' outcome, never claiming live fallback.
  await manager.refreshDevices();
  const preInitMissing = await manager.selectOutputDevice('missing-thunderbolt');
  assert.equal(preInitMissing.ok, false);
  assert.equal(preInitMissing.liveSwitched, false);
  assert.equal(preInitMissing.fellBackToDefault, false);
  assert.equal(preInitMissing.fallbackOutcome?.status, 'preference-only');
  assert.equal(preInitMissing.fallbackOutcome?.verifiedLiveDefault, false);
  assert.equal(preInitMissing.fallbackOutcome?.attemptedLiveSwitch, false);
  assert.equal(manager.getPreferences().outputDeviceId, '');
  assert.equal(manager.getSnapshot().selectedOutputAvailable, true);
  assert.match(preInitMissing.message ?? '', /Output preference reset to Default System Device/i);

  // 2. Live context bound: select 'dac-usb', then fail switch to 'flaky-hdmi' with working fallback to ''.
  const fakeCtx = new FakeSinkAudioContext();
  const ctx = fakeCtx as unknown as AudioContext & AudioContextWithSinkId;
  manager.bindAudioContext(ctx);
  const selected = await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(selected.ok, true);
  assert.equal(fakeCtx.sinkId, 'dac-usb');

  fakeCtx.failOnSinkIds.add('flaky-hdmi');
  const recoveredSwitch = await manager.selectOutputDevice('flaky-hdmi', ctx);
  assert.equal(recoveredSwitch.ok, false);
  assert.equal(recoveredSwitch.fellBackToDefault, true);
  assert.equal(recoveredSwitch.activeDeviceId, '');
  assert.equal(recoveredSwitch.fallbackOutcome?.status, 'verified-default');
  assert.equal(recoveredSwitch.fallbackOutcome?.verifiedLiveDefault, true);
  assert.equal(fakeCtx.sinkId, '');
  assert.equal(manager.getPreferences().outputDeviceId, '');
  assert.equal(manager.getSnapshot(ctx).selectedOutputAvailable, true);
  assert.equal(manager.getSnapshot(ctx).outputNotice?.tone, 'warning');
  assert.match(
    recoveredSwitch.message ?? '',
    /Audio output fell back to Default System Device/i,
  );

  // 3. Hot-unplug control with confirmed sinkId === '' readback.
  fakeCtx.failOnSinkIds.clear();
  await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(fakeCtx.sinkId, 'dac-usb');

  currentDevices = [makeDevice('audiooutput', 'default', 'Default - Built-in Speakers')];
  const unplugVerifiedSnap = await manager.refreshDevices({ fromHotPlug: true });
  assert.equal(fakeCtx.sinkId, '');
  assert.equal(unplugVerifiedSnap.lastOutputFallback?.status, 'verified-default');
  assert.equal(unplugVerifiedSnap.lastOutputFallback?.verifiedLiveDefault, true);
  assert.equal(unplugVerifiedSnap.activeOutputDeviceId, '');
  assert.equal(unplugVerifiedSnap.preferences.outputDeviceId, '');
  assert.equal(unplugVerifiedSnap.selectedOutputAvailable, true);
  assert.equal(unplugVerifiedSnap.outputNotice?.tone, 'warning');
  assert.match(
    unplugVerifiedSnap.outputNotice?.message ?? '',
    /Selected audio output device was disconnected\. Audio output fell back to Default System Device\./,
  );
});

test('Fallback regression 5: keepPreferenceForReconnect preserves intended device preference across both failed/unconfirmed and verified fallbacks, and re-routes on reconnect', async () => {
  let currentDevices: MediaDeviceInfo[] = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
  ];

  const storage = new MemoryStorage();
  const manager = new AudioDeviceManager({
    storage,
    getMediaDevices: () => ({
      enumerateDevices: async () => currentDevices,
    }),
    getAudioContextConstructor: () => FakeSinkAudioContext,
    keepOutputPreferenceOnDisconnect: true,
  });

  const fakeCtx = new FakeSinkAudioContext();
  const ctx = fakeCtx as unknown as AudioContext & AudioContextWithSinkId;
  manager.bindAudioContext(ctx);
  await manager.refreshDevices();

  const initialSelect = await manager.selectOutputDevice('dac-usb', ctx);
  assert.equal(initialSelect.ok, true);
  assert.equal(fakeCtx.sinkId, 'dac-usb');

  // Phase A: Temporary disconnect while fallback setSinkId('') REJECTS.
  currentDevices = [makeDevice('audiooutput', 'default', 'Default - Built-in Speakers')];
  fakeCtx.failOnSinkIds.add('');
  fakeCtx.failErrorMessage = 'Endpoint unavailable during unplug';

  const rejectedDisconnectSnap = await manager.refreshDevices({ fromHotPlug: true });
  assert.equal(rejectedDisconnectSnap.lastOutputFallback?.status, 'failed');
  assert.equal(rejectedDisconnectSnap.lastOutputFallback?.verifiedLiveDefault, false);
  assert.equal(rejectedDisconnectSnap.preferences.outputDeviceId, 'dac-usb');
  assert.equal(
    (JSON.parse(storage.getItem(AUDIO_PREFERENCES_STORAGE_KEY) ?? '{}') as { outputDeviceId?: string })
      .outputDeviceId,
    'dac-usb',
    'persisted preference must be preserved for reconnect even when fallback rejects',
  );
  assert.equal(rejectedDisconnectSnap.selectedOutputAvailable, false);
  assert.equal(rejectedDisconnectSnap.activeOutputDeviceId, 'dac-usb');
  assert.equal(rejectedDisconnectSnap.outputNotice?.tone, 'error');
  assert.match(
    rejectedDisconnectSnap.outputNotice?.message ?? '',
    /Default System Device fallback could not be confirmed/i,
  );

  // Reconnect 'dac-usb' after failed fallback: must re-apply 'dac-usb' to live context and clear notice.
  fakeCtx.failOnSinkIds.clear();
  const sinkCallCountBeforeReconnectA = fakeCtx.sinkCalls.length;
  currentDevices = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
  ];
  const reconnectedAfterReject = await manager.refreshDevices({ fromHotPlug: true });
  assert.ok(
    fakeCtx.sinkCalls.length > sinkCallCountBeforeReconnectA &&
      fakeCtx.sinkCalls.at(-1) === 'dac-usb',
    'reconnect after unconfirmed fallback must still invoke setSinkId(preferredOutput)',
  );
  assert.equal(reconnectedAfterReject.activeOutputDeviceId, 'dac-usb');
  assert.equal(reconnectedAfterReject.preferences.outputDeviceId, 'dac-usb');
  assert.equal(reconnectedAfterReject.selectedOutputAvailable, true);
  assert.equal(reconnectedAfterReject.outputNotice, null);

  // Phase B: Temporary disconnect while fallback setSinkId('') is a SILENT NO-OP.
  currentDevices = [makeDevice('audiooutput', 'default', 'Default - Built-in Speakers')];
  fakeCtx.ignoreSinkSwitchForTargets.add('');
  const silentDisconnectSnap = await manager.refreshDevices({ fromHotPlug: true });
  assert.equal(silentDisconnectSnap.lastOutputFallback?.status, 'failed');
  assert.equal(silentDisconnectSnap.preferences.outputDeviceId, 'dac-usb');
  assert.equal(silentDisconnectSnap.selectedOutputAvailable, false);
  assert.equal(silentDisconnectSnap.activeOutputDeviceId, 'dac-usb');
  assert.equal(silentDisconnectSnap.outputNotice?.tone, 'error');

  // Reconnect after silent no-op fallback.
  fakeCtx.ignoreSinkSwitchForTargets.clear();
  currentDevices = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
  ];
  const reconnectedAfterNoop = await manager.refreshDevices({ fromHotPlug: true });
  assert.equal(reconnectedAfterNoop.selectedOutputAvailable, true);
  assert.equal(reconnectedAfterNoop.activeOutputDeviceId, 'dac-usb');
  assert.equal(reconnectedAfterNoop.outputNotice, null);

  // Phase C: Temporary disconnect with VERIFIED default fallback, followed by reconnect.
  currentDevices = [makeDevice('audiooutput', 'default', 'Default - Built-in Speakers')];
  const verifiedDisconnectSnap = await manager.refreshDevices({ fromHotPlug: true });
  assert.equal(verifiedDisconnectSnap.lastOutputFallback?.status, 'verified-default');
  assert.equal(verifiedDisconnectSnap.lastOutputFallback?.verifiedLiveDefault, true);
  assert.equal(verifiedDisconnectSnap.activeOutputDeviceId, '');
  assert.equal(verifiedDisconnectSnap.preferences.outputDeviceId, 'dac-usb');
  assert.equal(verifiedDisconnectSnap.selectedOutputAvailable, false);
  assert.equal(verifiedDisconnectSnap.outputNotice?.tone, 'warning');
  assert.match(
    verifiedDisconnectSnap.outputNotice?.message ?? '',
    /Audio output fell back to Default System Device and will reconnect when available/i,
  );

  currentDevices = [
    makeDevice('audiooutput', 'default', 'Default - Built-in Speakers'),
    makeDevice('audiooutput', 'dac-usb', 'External Studio DAC'),
  ];
  const reconnectedAfterVerified = await manager.refreshDevices({ fromHotPlug: true });
  assert.equal(fakeCtx.sinkId, 'dac-usb');
  assert.equal(reconnectedAfterVerified.activeOutputDeviceId, 'dac-usb');
  assert.equal(reconnectedAfterVerified.preferences.outputDeviceId, 'dac-usb');
  assert.equal(reconnectedAfterVerified.selectedOutputAvailable, true);
  assert.equal(reconnectedAfterVerified.outputNotice, null);
});


