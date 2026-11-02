import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AudioSettingsModal,
  bindAudioSettingsModalSubscriptions,
  formatLatencyMilliseconds,
  formatSampleRateLabel,
  type AudioSettingsDevicePort,
  type AudioSettingsEnginePort,
} from './AudioSettingsModal';
import type { AudioEngineDiagnostics } from '../audio/audioEngine';
import {
  AudioDeviceManager,
  type AudioDeviceManagerSnapshot,
  type MediaDevicesLike,
} from '../audio/audioDeviceManager';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const makeDiagnostics = (overrides: Partial<AudioEngineDiagnostics> = {}): AudioEngineDiagnostics => ({
  initialized: true,
  contextState: 'running',
  unexpectedlyClosed: false,
  requestedSampleRate: 48000,
  actualSampleRate: 48000,
  sampleRateMatched: true,
  sampleRateMismatchNotice: null,
  latencyHint: 'interactive',
  latencyMetrics: {
    sampleRate: 48000,
    baseLatencySeconds: 0.00533,
    outputLatencySeconds: 0.01067,
    renderQuantumSamples: 128,
    renderQuantumSeconds: 128 / 48000,
  },
  activeOutputDeviceId: 'dac-usb',
  reconfigureBlockedReason: null,
  isReconfiguring: false,
  lastReconfigureError: null,
  ...overrides,
});

const makeDeviceSnapshot = (
  overrides: Partial<AudioDeviceManagerSnapshot> = {},
): AudioDeviceManagerSnapshot => ({
  preferences: {
    outputDeviceId: 'dac-usb',
    inputDeviceId: 'mic-xlr',
    sampleRate: 48000,
    latencyHint: 'interactive',
  },
  storageAvailable: true,
  capabilities: {
    deviceEnumerationSupported: true,
    microphoneCaptureSupported: true,
    outputSinkSelectionSupported: true,
    selectAudioOutputPromptSupported: false,
  },
  microphonePermission: 'granted',
  outputDevices: [
    {
      deviceId: '',
      groupId: 'default',
      kind: 'audiooutput',
      label: 'Default System Device',
      isSystemDefault: true,
      labelRevealed: true,
    },
    {
      deviceId: 'dac-usb',
      groupId: 'grp-dac',
      kind: 'audiooutput',
      label: 'Studio Monitor DAC',
      isSystemDefault: false,
      labelRevealed: true,
    },
  ],
  inputDevices: [
    {
      deviceId: '',
      groupId: 'default',
      kind: 'audioinput',
      label: 'Default System Device',
      isSystemDefault: true,
      labelRevealed: true,
    },
    {
      deviceId: 'mic-xlr',
      groupId: 'grp-mic',
      kind: 'audioinput',
      label: 'XLR Condenser Input 1',
      isSystemDefault: false,
      labelRevealed: true,
    },
  ],
  activeOutputDeviceId: 'dac-usb',
  selectedOutputAvailable: true,
  selectedInputAvailable: true,
  isEnumerating: false,
  isRequestingPermission: false,
  outputNotice: null,
  inputNotice: null,
  ...overrides,
});

const createPorts = (
  diagOverrides: Partial<AudioEngineDiagnostics> = {},
  snapOverrides: Partial<AudioDeviceManagerSnapshot> = {},
): { engine: AudioSettingsEnginePort; deviceManager: AudioSettingsDevicePort } => {
  const diag = makeDiagnostics(diagOverrides);
  const snap = makeDeviceSnapshot(snapOverrides);
  return {
    engine: {
      getAudioEngineDiagnostics: () => diag,
      subscribeAudioEngineState: () => () => {},
      ensureAudioEngineInitialized: async () => diag,
      resumeAudioContext: async () => diag,
      reconfigureAudioContext: async () => ({
        ok: true,
        requestedSampleRate: diag.requestedSampleRate,
        actualSampleRate: diag.actualSampleRate ?? 48000,
        sampleRateMatched: true,
        sampleRateMismatchNotice: null,
        latencyHint: diag.latencyHint,
        contextState: 'running',
      }),
      clearAudioEngineError: () => {},
    },
    deviceManager: {
      getSnapshot: () => snap,
      subscribe: () => () => {},
      refreshDevices: async () => snap,
      requestMicrophonePermission: async () => ({ granted: true, message: null }),
      promptOutputDeviceSelection: async () => ({ ok: true, message: null }),
      selectOutputDevice: async id => ({
        ok: true,
        liveSwitched: true,
        preferenceSaved: true,
        activeDeviceId: id,
        message: null,
      }),
      selectInputDevice: id => ({ ok: true, selectedDeviceId: id, message: null }),
      resetToDefaults: () => ({
        outputDeviceId: '',
        inputDeviceId: '',
        sampleRate: 'default',
        latencyHint: 'interactive',
      }),
    },
  };
};

test('AudioSettingsModal renders accessible dialog semantics, real telemetry, and supported sample rates & latency hints', () => {
  const { engine, deviceManager } = createPorts();
  const html = renderToStaticMarkup(
    <AudioSettingsModal isOpen onClose={() => undefined} engine={engine} deviceManager={deviceManager} />,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="audio-settings-modal-title"/);
  assert.match(html, /id="audio-output-device-select"/);
  assert.match(html, /id="audio-input-device-select"/);
  assert.match(html, /id="audio-sample-rate-select"/);
  assert.match(html, /role="radiogroup"[^>]*aria-labelledby="audio-latency-preference-label"/);

  // Sample rate options: System Default, 44,100, 48,000, 88,200, 96,000 Hz
  for (const label of ['System Default', '44,100 Hz', '48,000 Hz', '88,200 Hz', '96,000 Hz']) {
    assert.ok(html.includes(label), `expected sample rate option ${label}`);
  }
  // Latency hints: Interactive, Balanced, Playback
  for (const hint of ['Interactive', 'Balanced', 'Playback']) {
    assert.ok(html.includes(hint), `expected latency option ${hint}`);
  }

  // Verified telemetry values
  assert.ok(html.includes('5.33 ms'), 'displays real baseLatency in ms');
  assert.ok(html.includes('10.67 ms'), 'displays real outputLatency in ms');
  assert.ok(html.includes('Studio Monitor DAC'), 'displays verified active output device');
  assert.ok(html.includes('XLR Condenser Input 1'), 'displays enumerated input device');
});

test('AudioSettingsModal never displays requested sample rate as actual when uninitialized or mismatched, and never fabricates unreported latency', () => {
  const uninitPorts = createPorts({
    initialized: false,
    contextState: 'uninitialized',
    requestedSampleRate: 96000,
    actualSampleRate: null,
    latencyMetrics: null,
  });
  const uninitHtml = renderToStaticMarkup(
    <AudioSettingsModal
      isOpen
      onClose={() => undefined}
      engine={uninitPorts.engine}
      deviceManager={uninitPorts.deviceManager}
    />,
  );

  assert.match(uninitHtml, /data-testid="audio-actual-sample-rate"[^>]*>Not initialized</);
  assert.ok(uninitHtml.includes('Requested: 96,000 Hz'));
  assert.match(uninitHtml, /data-testid="audio-base-latency"[^>]*>Not reported by runtime</);
  assert.match(uninitHtml, /data-testid="audio-output-latency"[^>]*>Not reported by runtime</);

  const mismatchPorts = createPorts({
    requestedSampleRate: 96000,
    actualSampleRate: 48000,
    sampleRateMatched: false,
    sampleRateMismatchNotice: 'Requested 96,000 Hz, but the audio hardware/runtime opened at 48,000 Hz.',
  });
  const mismatchHtml = renderToStaticMarkup(
    <AudioSettingsModal
      isOpen
      onClose={() => undefined}
      engine={mismatchPorts.engine}
      deviceManager={mismatchPorts.deviceManager}
    />,
  );
  assert.match(mismatchHtml, /data-testid="audio-actual-sample-rate"[^>]*>48,000 Hz</);
  assert.ok(mismatchHtml.includes('Requested: 96,000 Hz'));
  assert.ok(mismatchHtml.includes('Requested 96,000 Hz, but the audio hardware/runtime opened at 48,000 Hz.'));
});

test('AudioSettingsModal surfaces unsupported setSinkId, explicit microphone permission button, fallback alerts, and active-operation reconfiguration locks', () => {
  const lockedPorts = createPorts(
    {
      reconfigureBlockedReason: 'Stop transport playback before changing sample rate or latency preferences.',
    },
    {
      microphonePermission: 'prompt',
      capabilities: {
        deviceEnumerationSupported: true,
        microphoneCaptureSupported: true,
        outputSinkSelectionSupported: false,
        selectAudioOutputPromptSupported: false,
      },
      outputNotice: {
        tone: 'warning',
        message: 'Selected audio output device was disconnected. Audio output fell back to Default System Device.',
      },
      inputNotice: {
        tone: 'error',
        message: 'Microphone permission was denied.',
      },
    },
  );

  const html = renderToStaticMarkup(
    <AudioSettingsModal
      isOpen
      onClose={() => undefined}
      engine={lockedPorts.engine}
      deviceManager={lockedPorts.deviceManager}
    />,
  );

  assert.match(html, /data-testid="output-sink-unsupported-notice"/);
  assert.ok(html.includes('Grant Microphone Access'));
  assert.ok(html.includes('Selected audio output device was disconnected.'));
  assert.ok(html.includes('Microphone permission was denied.'));
  assert.match(html, /data-testid="audio-reconfigure-locked-banner"/);
  assert.ok(html.includes('Stop transport playback before changing sample rate or latency preferences.'));
  assert.match(html, /id="audio-sample-rate-select"[^>]*disabled=""/);
});

test('AudioSettingsModal enforces strict product truthfulness (no fake buffer-size slider, no ASIO/WASAPI/CoreAudio claims, no live monitoring claims)', () => {
  const source = readFileSync(path.join(repoRoot, 'src/components/AudioSettingsModal.tsx'), 'utf8');

  // Must not contain a fake hardware buffer-size range slider.
  assert.doesNotMatch(source, /type="range"/);
  // Must not claim native driver APIs Web Audio cannot control.
  assert.doesNotMatch(source, /\b(ASIO|WASAPI|CoreAudio)\b/i);
  // Must explicitly disclose that live Mixer input monitoring is not enabled.
  assert.match(source, /Live input monitoring through the Mixer is not enabled/);

  assert.equal(formatSampleRateLabel('default'), 'System Default');
  assert.equal(formatSampleRateLabel(48000), '48,000 Hz');
  assert.equal(formatSampleRateLabel(null), 'Not initialized');
  assert.equal(formatLatencyMilliseconds(null), 'Not reported by runtime');
  assert.equal(formatLatencyMilliseconds(0.008), '8.00 ms');
});

test('P2 regression: opening and closing AudioSettingsModal repeatedly scopes subscriptions to UI lifecycle without initializing or duplicating hardware monitoring listeners, and App starts/stops monitoring once', async () => {
  const modalSource = readFileSync(path.join(repoRoot, 'src/components/AudioSettingsModal.tsx'), 'utf8');
  const appSource = readFileSync(path.join(repoRoot, 'src/App.tsx'), 'utf8');

  assert.doesNotMatch(
    modalSource,
    /initializePassiveMonitoring/,
    'AudioSettingsModal must not own or trigger hardware passive monitoring initialization',
  );
  assert.match(appSource, /audioEngine\.startDeviceMonitoring\(\)/);
  assert.match(appSource, /audioEngine\.stopDeviceMonitoring\(\)/);

  const deviceChangeListeners = new Set<EventListener>();
  const permissionChangeListeners = new Set<() => void>();
  let getUserMediaCalls = 0;

  const mediaDevices: MediaDevicesLike = {
    enumerateDevices: async () => [
      {
        deviceId: 'default',
        groupId: 'grp-default',
        kind: 'audiooutput',
        label: 'Default System Output',
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ],
    getUserMedia: async () => {
      getUserMediaCalls += 1;
      throw new Error('Unexpected startup getUserMedia');
    },
    addEventListener: (type, cb) => {
      if (type === 'devicechange') deviceChangeListeners.add(cb);
    },
    removeEventListener: (type, cb) => {
      if (type === 'devicechange') deviceChangeListeners.delete(cb);
    },
  };

  const manager = new AudioDeviceManager({
    storage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    getMediaDevices: () => mediaDevices,
    getPermissions: () => ({
      query: async () => ({
        state: 'prompt',
        addEventListener: (type: string, cb: () => void) => {
          if (type === 'change') permissionChangeListeners.add(cb);
        },
        removeEventListener: (type: string, cb: () => void) => {
          if (type === 'change') permissionChangeListeners.delete(cb);
        },
      }),
    }),
  });

  const engineListeners = new Set<() => void>();
  const ports = createPorts();
  const trackedEngine: AudioSettingsEnginePort = {
    ...ports.engine,
    subscribeAudioEngineState: cb => {
      engineListeners.add(cb);
      return () => {
        engineListeners.delete(cb);
      };
    },
  };

  // Application startup starts passive monitoring once while modal is closed.
  await manager.initializePassiveMonitoring();
  assert.equal(getUserMediaCalls, 0);
  assert.equal(deviceChangeListeners.size, 1);
  assert.equal(permissionChangeListeners.size, 1);

  // Repeatedly open and close AudioSettingsModal 5 times: hardware listeners stay at 1
  // and UI listeners return cleanly to 0 after every close.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    let syncCalls = 0;
    const disposeModalUi = bindAudioSettingsModalSubscriptions({
      isOpen: true,
      engine: trackedEngine,
      deviceManager: manager,
      onSync: () => {
        syncCalls += 1;
      },
    });
    assert.equal(syncCalls, 1);
    assert.equal(engineListeners.size, 1);
    assert.equal(deviceChangeListeners.size, 1, `cycle ${cycle}: devicechange listener must not duplicate`);
    assert.equal(permissionChangeListeners.size, 1, `cycle ${cycle}: permission listener must not duplicate`);
    disposeModalUi();
    assert.equal(engineListeners.size, 0, `cycle ${cycle}: modal engine subscription must dispose on close`);
  }

  // Application teardown disposes hardware monitoring listeners.
  manager.disposeMonitoring();
  assert.equal(deviceChangeListeners.size, 0);
  assert.equal(permissionChangeListeners.size, 0);
  assert.equal(getUserMediaCalls, 0);
});

test('AudioSettingsModal surfaces unverified fallback failure honestly without displaying Disconnected sink as Default System Device', () => {
  const unverifiedPorts = createPorts(
    {
      activeOutputDeviceId: 'dac-usb',
    },
    {
      preferences: {
        outputDeviceId: 'dac-usb',
        inputDeviceId: 'mic-xlr',
        sampleRate: 48000,
        latencyHint: 'interactive',
      },
      outputDevices: [
        {
          deviceId: '',
          groupId: 'default',
          kind: 'audiooutput',
          label: 'Default System Device',
          isSystemDefault: true,
          labelRevealed: true,
        },
      ],
      activeOutputDeviceId: 'dac-usb',
      selectedOutputAvailable: false,
      outputNotice: {
        tone: 'error',
        message:
          'Selected audio output device was disconnected. Default System Device fallback could not be confirmed (AudioContext remained routed to "dac-usb").',
      },
    },
  );

  const html = renderToStaticMarkup(
    <AudioSettingsModal
      isOpen
      onClose={() => undefined}
      engine={unverifiedPorts.engine}
      deviceManager={unverifiedPorts.deviceManager}
    />,
  );

  assert.match(html, /data-testid="audio-output-unavailable-badge"/);
  assert.ok(html.includes('Disconnected Output Device (Fallback Unverified)'));
  assert.ok(html.includes('Saved Output Device (Disconnected)'));
  assert.match(html, /role="alert"[\s\S]*Default System Device fallback could not be confirmed/);
});

test('AudioSettingsModal renders no unavailable badge when existing Default or connected output stays active on failed switch (Cases A & B), and renders unavailable badge on genuine disconnect (Case C)', async () => {
  let currentDevices: MediaDeviceInfo[] = [
    {
      deviceId: 'default',
      groupId: 'grp-default',
      kind: 'audiooutput',
      label: 'Default - Built-in Speakers',
      toJSON: () => ({}),
    } as MediaDeviceInfo,
    {
      deviceId: 'dac-usb',
      groupId: 'grp-usb',
      kind: 'audiooutput',
      label: 'External Studio DAC',
      toJSON: () => ({}),
    } as MediaDeviceInfo,
    {
      deviceId: 'broken-spdif',
      groupId: 'grp-spdif',
      kind: 'audiooutput',
      label: 'Broken S/PDIF Output',
      toJSON: () => ({}),
    } as MediaDeviceInfo,
  ];

  class ModalTestSinkContext {
    state: AudioContextState = 'running';
    sampleRate = 48000;
    sinkId = '';
    readonly failIds = new Set<string>();
    async setSinkId(id: string): Promise<void> {
      if (this.failIds.has(id)) {
        const err = new Error('Endpoint switch rejected');
        err.name = id === '' ? 'InvalidStateError' : 'NotFoundError';
        throw err;
      }
      this.sinkId = id;
    }
  }

  const store = new Map<string, string>();
  const manager = new AudioDeviceManager({
    storage: {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: k => {
        store.delete(k);
      },
    },
    getMediaDevices: () => ({
      enumerateDevices: async () => currentDevices,
    }),
    getAudioContextConstructor: () => ModalTestSinkContext,
  });

  const sinkCtx = new ModalTestSinkContext();
  const liveCtx = sinkCtx as unknown as AudioContext;
  manager.bindAudioContext(liveCtx);
  await manager.refreshDevices();

  const renderModalForCurrentManagerState = (): string => {
    const snap = manager.getSnapshot(liveCtx);
    const ports = createPorts(
      { activeOutputDeviceId: snap.activeOutputDeviceId },
      snap,
    );
    return renderToStaticMarkup(
      <AudioSettingsModal
        isOpen
        onClose={() => undefined}
        engine={ports.engine}
        deviceManager={ports.deviceManager}
      />,
    );
  };

  // Case A: Existing Default System Device ('') stays active after 'broken-spdif' and fallback '' both reject.
  sinkCtx.failIds.add('broken-spdif');
  sinkCtx.failIds.add('');
  const caseAResult = await manager.selectOutputDevice('broken-spdif', liveCtx);
  assert.equal(caseAResult.ok, false);
  assert.equal(caseAResult.fellBackToDefault, false);

  const htmlCaseA = renderModalForCurrentManagerState();
  assert.doesNotMatch(htmlCaseA, /data-testid="audio-output-unavailable-badge"/);
  assert.doesNotMatch(htmlCaseA, /Disconnected Output Device/);
  assert.match(htmlCaseA, /role="alert"[\s\S]*Audio output remains on Default System Device/);

  await manager.refreshDevices();
  assert.doesNotMatch(renderModalForCurrentManagerState(), /data-testid="audio-output-unavailable-badge"/);

  // Case B: Existing connected 'dac-usb' stays active after 'broken-spdif' and fallback '' both reject.
  sinkCtx.failIds.clear();
  const usbOk = await manager.selectOutputDevice('dac-usb', liveCtx);
  assert.equal(usbOk.ok, true);

  sinkCtx.failIds.add('broken-spdif');
  sinkCtx.failIds.add('');
  const caseBResult = await manager.selectOutputDevice('broken-spdif', liveCtx);
  assert.equal(caseBResult.ok, false);
  assert.equal(caseBResult.fellBackToDefault, false);

  const htmlCaseB = renderModalForCurrentManagerState();
  assert.doesNotMatch(htmlCaseB, /data-testid="audio-output-unavailable-badge"/);
  assert.doesNotMatch(htmlCaseB, /Disconnected Output Device/);
  assert.doesNotMatch(htmlCaseB, /Saved Output Device \(Disconnected\)/);
  assert.ok(htmlCaseB.includes('External Studio DAC'));
  assert.match(
    htmlCaseB,
    /role="alert"[\s\S]*Previous output \(External Studio DAC\) remains active/,
  );

  await manager.refreshDevices();
  const htmlCaseBAfterRefresh = renderModalForCurrentManagerState();
  assert.doesNotMatch(htmlCaseBAfterRefresh, /data-testid="audio-output-unavailable-badge"/);
  assert.match(
    htmlCaseBAfterRefresh,
    /role="alert"[\s\S]*Previous output \(External Studio DAC\) remains active/,
  );

  // Case C: Genuine disconnect of 'dac-usb' while fallback '' rejects MUST show unavailable badge & disconnected sink.
  currentDevices = [
    {
      deviceId: 'default',
      groupId: 'grp-default',
      kind: 'audiooutput',
      label: 'Default - Built-in Speakers',
      toJSON: () => ({}),
    } as MediaDeviceInfo,
  ];
  await manager.refreshDevices({ fromHotPlug: true });
  const htmlCaseC = renderModalForCurrentManagerState();
  assert.match(htmlCaseC, /data-testid="audio-output-unavailable-badge"/);
  assert.ok(htmlCaseC.includes('Disconnected Output Device (Fallback Unverified)'));
  assert.match(htmlCaseC, /role="alert"[\s\S]*Default System Device fallback could not be confirmed/);

  await manager.refreshDevices();
  assert.match(renderModalForCurrentManagerState(), /data-testid="audio-output-unavailable-badge"/);
});



