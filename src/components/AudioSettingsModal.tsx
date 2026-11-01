import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Volume2, Mic, Activity, AlertTriangle, CheckCircle2, RotateCcw, Play } from 'lucide-react';
import { ModalFrame } from './ModalFrame';
import {
  audioEngine,
  type AudioContextReconfigureResult,
  type AudioEngineDiagnostics,
} from '../audio/audioEngine';
import {
  audioDeviceManager,
  type AudioDeviceManagerSnapshot,
} from '../audio/audioDeviceManager';
import {
  AUDIO_LATENCY_PREFERENCES,
  SUPPORTED_SAMPLE_RATES,
  SYSTEM_DEFAULT_DEVICE_ID,
  type AudioLatencyPreference,
  type RequestedSampleRate,
} from '../state/audioPreferences';

export interface AudioSettingsEnginePort {
  getAudioEngineDiagnostics(): AudioEngineDiagnostics;
  subscribeAudioEngineState(listener: () => void): () => void;
  ensureAudioEngineInitialized(): Promise<AudioEngineDiagnostics>;
  resumeAudioContext(): Promise<AudioEngineDiagnostics>;
  reconfigureAudioContext(patch: {
    sampleRate?: RequestedSampleRate;
    latencyHint?: AudioLatencyPreference;
  }): Promise<AudioContextReconfigureResult>;
  clearAudioEngineError(): void;
  getContext?(): AudioContext;
}

export interface AudioSettingsDevicePort {
  getSnapshot(ctx?: AudioContext | null): AudioDeviceManagerSnapshot;
  subscribe(listener: (snapshot: AudioDeviceManagerSnapshot) => void): () => void;
  initializePassiveMonitoring(): Promise<AudioDeviceManagerSnapshot>;
  refreshDevices(): Promise<AudioDeviceManagerSnapshot>;
  requestMicrophonePermission(): Promise<{ granted: boolean; message: string | null }>;
  promptOutputDeviceSelection(ctx?: AudioContext | null): Promise<{ ok: boolean; message: string | null }>;
  selectOutputDevice(deviceId: string, ctx?: AudioContext | null): Promise<{ ok: boolean; activeDeviceId: string; message: string | null }>;
  selectInputDevice(deviceId: string): { ok: boolean; selectedDeviceId: string; message: string | null };
  resetToDefaults(): {
    outputDeviceId: string;
    inputDeviceId: string;
    sampleRate: RequestedSampleRate;
    latencyHint: AudioLatencyPreference;
  };
}

export interface AudioSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  engine?: AudioSettingsEnginePort;
  deviceManager?: AudioSettingsDevicePort;
}

const LATENCY_COPY: Record<
  AudioLatencyPreference,
  { label: string; description: string }
> = {
  interactive: {
    label: 'Interactive',
    description: 'Lowest Web Audio scheduling latency for live MIDI and instrument performance.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Balances responsive playback with steady CPU headroom.',
  },
  playback: {
    label: 'Playback',
    description: 'Prioritizes smooth, uninterrupted arrangement playback on heavier mixes.',
  },
};

export const formatSampleRateLabel = (rate: RequestedSampleRate | number | null): string => {
  if (rate === 'default') return 'System Default';
  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
    return `${rate.toLocaleString('en-US')} Hz`;
  }
  return 'Not initialized';
};

export const formatLatencyMilliseconds = (seconds: number | null | undefined): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return 'Not reported by runtime';
  }
  return `${(seconds * 1000).toFixed(2)} ms`;
};

const parseSampleRateSelection = (value: string): RequestedSampleRate => {
  if (value === 'default') return 'default';
  const numeric = Number(value);
  for (const candidate of SUPPORTED_SAMPLE_RATES) {
    if (numeric === candidate) return candidate;
  }
  return 'default';
};

export const AudioSettingsModal: React.FC<AudioSettingsModalProps> = ({
  isOpen,
  onClose,
  engine = audioEngine,
  deviceManager = audioDeviceManager,
}) => {
  const [diagnostics, setDiagnostics] = useState<AudioEngineDiagnostics>(() =>
    engine.getAudioEngineDiagnostics(),
  );
  const [deviceSnapshot, setDeviceSnapshot] = useState<AudioDeviceManagerSnapshot>(() =>
    deviceManager.getSnapshot(),
  );
  const [stagedSampleRate, setStagedSampleRate] = useState<RequestedSampleRate>(
    () => diagnostics.requestedSampleRate,
  );
  const [stagedLatencyHint, setStagedLatencyHint] = useState<AudioLatencyPreference>(
    () => diagnostics.latencyHint,
  );
  const [statusBanner, setStatusBanner] = useState<{
    tone: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const refreshDiagnostics = () => {
      const nextDiag = engine.getAudioEngineDiagnostics();
      setDiagnostics(nextDiag);
      setDeviceSnapshot(deviceManager.getSnapshot());
    };

    refreshDiagnostics();
    const initialDiag = engine.getAudioEngineDiagnostics();
    setStagedSampleRate(initialDiag.requestedSampleRate);
    setStagedLatencyHint(initialDiag.latencyHint);
    setStatusBanner(null);

    const unsubEngine = engine.subscribeAudioEngineState(refreshDiagnostics);
    const unsubDevices = deviceManager.subscribe(nextSnap => {
      setDeviceSnapshot(nextSnap);
      setDiagnostics(engine.getAudioEngineDiagnostics());
    });

    void deviceManager.initializePassiveMonitoring();

    return () => {
      unsubEngine();
      unsubDevices();
    };
  }, [isOpen, engine, deviceManager]);

  const handleRefreshDevices = useCallback(async () => {
    await deviceManager.refreshDevices();
  }, [deviceManager]);

  const handleGrantMicrophonePermission = useCallback(async () => {
    setStatusBanner(null);
    const result = await deviceManager.requestMicrophonePermission();
    if (result.granted) {
      setStatusBanner({
        tone: 'success',
        message: 'Microphone access granted. Hardware input and output labels have been refreshed.',
      });
    }
  }, [deviceManager]);

  const handleOutputDeviceChange = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      setStatusBanner(null);
      const nextDeviceId = event.target.value;
      const result = await deviceManager.selectOutputDevice(nextDeviceId);
      setDiagnostics(engine.getAudioEngineDiagnostics());
      if (result.ok) {
        const chosen = deviceSnapshot.outputDevices.find(d => d.deviceId === result.activeDeviceId);
        setStatusBanner({
          tone: 'success',
          message: `Audio output routed to ${chosen?.label ?? 'Default System Device'}.`,
        });
      }
    },
    [deviceManager, deviceSnapshot.outputDevices, engine],
  );

  const handleInputDeviceChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setStatusBanner(null);
      const nextDeviceId = event.target.value;
      const result = deviceManager.selectInputDevice(nextDeviceId);
      if (result.ok) {
        const chosen = deviceSnapshot.inputDevices.find(d => d.deviceId === result.selectedDeviceId);
        setStatusBanner({
          tone: 'success',
          message: `Recording input set to ${chosen?.label ?? 'Default System Device'}.`,
        });
      }
    },
    [deviceManager, deviceSnapshot.inputDevices],
  );

  const handleInitializeOrResumeEngine = useCallback(async () => {
    setStatusBanner(null);
    engine.clearAudioEngineError();
    try {
      const next =
        diagnostics.contextState === 'uninitialized'
          ? await engine.ensureAudioEngineInitialized()
          : await engine.resumeAudioContext();
      setDiagnostics(next);
      setStagedSampleRate(next.requestedSampleRate);
      setStagedLatencyHint(next.latencyHint);
      if (next.contextState === 'running') {
        setStatusBanner({
          tone: 'success',
          message: `Audio engine active at ${formatSampleRateLabel(next.actualSampleRate)}.`,
        });
      }
    } catch (error) {
      setStatusBanner({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Failed to start or resume the audio engine.',
      });
    }
  }, [diagnostics.contextState, engine]);

  const handleApplyEngineConfig = useCallback(async () => {
    setStatusBanner(null);
    engine.clearAudioEngineError();
    try {
      const result = await engine.reconfigureAudioContext({
        sampleRate: stagedSampleRate,
        latencyHint: stagedLatencyHint,
      });
      setDiagnostics(engine.getAudioEngineDiagnostics());
      if (!result.sampleRateMatched && result.sampleRateMismatchNotice) {
        setStatusBanner({
          tone: 'warning',
          message: result.sampleRateMismatchNotice,
        });
      } else {
        setStatusBanner({
          tone: 'success',
          message: `Audio engine reconfigured: active at ${formatSampleRateLabel(result.actualSampleRate)} (${LATENCY_COPY[result.latencyHint].label} latency preference).`,
        });
      }
    } catch (error) {
      const current = engine.getAudioEngineDiagnostics();
      setDiagnostics(current);
      setStagedSampleRate(current.requestedSampleRate);
      setStagedLatencyHint(current.latencyHint);
      setStatusBanner({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Audio engine reconfiguration failed.',
      });
    }
  }, [engine, stagedLatencyHint, stagedSampleRate]);

  const handleResetDefaults = useCallback(async () => {
    setStatusBanner(null);
    engine.clearAudioEngineError();
    if (diagnostics.reconfigureBlockedReason) {
      setStatusBanner({
        tone: 'warning',
        message: diagnostics.reconfigureBlockedReason,
      });
      return;
    }
    const defaults = deviceManager.resetToDefaults();
    await deviceManager.selectOutputDevice(defaults.outputDeviceId);
    setStagedSampleRate(defaults.sampleRate);
    setStagedLatencyHint(defaults.latencyHint);
    if (diagnostics.initialized) {
      try {
        const result = await engine.reconfigureAudioContext({
          sampleRate: defaults.sampleRate,
          latencyHint: defaults.latencyHint,
        });
        setDiagnostics(engine.getAudioEngineDiagnostics());
        setStatusBanner({
          tone: 'success',
          message: `Restored default audio settings (active at ${formatSampleRateLabel(result.actualSampleRate)}).`,
        });
      } catch (error) {
        setDiagnostics(engine.getAudioEngineDiagnostics());
        setStatusBanner({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Failed to reset audio engine configuration.',
        });
      }
    } else {
      setDiagnostics(engine.getAudioEngineDiagnostics());
      setStatusBanner({
        tone: 'success',
        message: 'Restored default audio preferences.',
      });
    }
  }, [deviceManager, diagnostics.initialized, diagnostics.reconfigureBlockedReason, engine]);

  if (!isOpen) return null;

  const isReconfigureLocked =
    diagnostics.reconfigureBlockedReason !== null || diagnostics.isReconfiguring;
  const hasPendingEngineChanges =
    stagedSampleRate !== diagnostics.requestedSampleRate ||
    stagedLatencyHint !== diagnostics.latencyHint ||
    !diagnostics.initialized ||
    diagnostics.contextState === 'closed';

  const activeOutputLabel =
    deviceSnapshot.outputDevices.find(d => d.deviceId === diagnostics.activeOutputDeviceId)
      ?.label ?? 'Default System Device';

  const selectedOutputValue = deviceSnapshot.capabilities.outputSinkSelectionSupported
    ? deviceSnapshot.preferences.outputDeviceId
    : SYSTEM_DEFAULT_DEVICE_ID;

  const selectedInputInList = deviceSnapshot.inputDevices.some(
    d => d.deviceId === deviceSnapshot.preferences.inputDeviceId,
  );

  const contextStateBadge = (() => {
    if (diagnostics.unexpectedlyClosed || diagnostics.contextState === 'closed') {
      return {
        label: 'Closed',
        className:
          'border-[var(--apex-danger)] bg-[var(--apex-surface-3)] text-[var(--apex-danger)]',
      };
    }
    if (diagnostics.contextState === 'running') {
      return {
        label: 'Running',
        className:
          'border-[var(--apex-success)] bg-[var(--apex-surface-3)] text-[var(--apex-success)]',
      };
    }
    if (diagnostics.contextState === 'suspended') {
      return {
        label: 'Suspended',
        className:
          'border-[var(--apex-gold)] bg-[var(--apex-surface-3)] text-[var(--apex-gold)]',
      };
    }
    return {
      label: 'Standby (Uninitialized)',
      className:
        'border-[var(--apex-border)] bg-[var(--apex-surface-3)] text-[var(--apex-text-2)]',
    };
  })();

  const permissionBadge = (() => {
    switch (deviceSnapshot.microphonePermission) {
      case 'granted':
        return { label: 'Microphone: Granted', toneClass: 'text-[var(--apex-success)]' };
      case 'denied':
        return { label: 'Microphone: Denied', toneClass: 'text-[var(--apex-danger)]' };
      case 'unsupported':
        return { label: 'Microphone: Unsupported', toneClass: 'text-[var(--apex-danger)]' };
      default:
        return { label: 'Microphone: Not Yet Granted', toneClass: 'text-[var(--apex-text-2)]' };
    }
  })();

  return (
    <ModalFrame
      id="audio-settings-modal"
      labelledBy="audio-settings-modal-title"
      onClose={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
    >
      <div className="apex-dialog flex max-h-[90vh] w-[min(95vw,44rem)] flex-col overflow-hidden border border-[var(--apex-border)] bg-[var(--apex-surface)] text-[var(--apex-text)]">
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--apex-border)] bg-[var(--apex-panel-header)] px-5 py-4">
          <div>
            <h2 id="audio-settings-modal-title" className="text-base font-semibold text-[var(--apex-text)]">
              Audio Settings
            </h2>
            <p className="mt-0.5 text-xs text-[var(--apex-text-2)]">
              Application audio I/O devices, Web Audio sample rate, latency preference, and verified engine telemetry
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRefreshDevices()}
              disabled={deviceSnapshot.isEnumerating || !deviceSnapshot.capabilities.deviceEnumerationSupported}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--apex-border)] bg-[var(--apex-surface-2)] px-2.5 py-1.5 text-xs font-medium text-[var(--apex-text)] hover:border-[var(--apex-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${deviceSnapshot.isEnumerating ? 'animate-spin' : ''}`} />
              Refresh Devices
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Audio Settings"
              className="apex-icon-btn rounded-md px-2.5 py-1 text-sm text-[var(--apex-text-2)] hover:text-[var(--apex-text)]"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="custom-scrollbar flex-1 space-y-5 overflow-y-auto p-5">
          {!deviceSnapshot.storageAvailable && (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-lg border border-[var(--apex-gold)] bg-[var(--apex-surface-2)] p-3 text-xs text-[var(--apex-text)]"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--apex-gold)]" />
              <span>
                Browser storage is unavailable or restricted in this session. Audio settings apply to the active session only and will reset when the window closes.
              </span>
            </div>
          )}

          {statusBanner && (
            <div
              role={statusBanner.tone === 'error' ? 'alert' : 'status'}
              className={`flex items-start gap-2.5 rounded-lg border bg-[var(--apex-surface-2)] p-3 text-xs ${
                statusBanner.tone === 'error'
                  ? 'border-[var(--apex-danger)] text-[var(--apex-text)]'
                  : statusBanner.tone === 'warning'
                    ? 'border-[var(--apex-gold)] text-[var(--apex-text)]'
                    : 'border-[var(--apex-success)] text-[var(--apex-text)]'
              }`}
            >
              {statusBanner.tone === 'success' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--apex-success)]" />
              ) : (
                <AlertTriangle
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    statusBanner.tone === 'error' ? 'text-[var(--apex-danger)]' : 'text-[var(--apex-gold)]'
                  }`}
                />
              )}
              <span>{statusBanner.message}</span>
            </div>
          )}

          {diagnostics.unexpectedlyClosed && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--apex-danger)] bg-[var(--apex-surface-2)] p-3 text-xs text-[var(--apex-text)]"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--apex-danger)]" />
                <span>
                  The live AudioContext closed unexpectedly. Recover the audio engine to restore playback and metering.
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleInitializeOrResumeEngine()}
                disabled={isReconfigureLocked}
                className="shrink-0 rounded-md bg-[var(--apex-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--apex-state-playing-fg)] hover:bg-[var(--apex-accent-strong)] disabled:opacity-50"
              >
                Recover Engine
              </button>
            </div>
          )}

          {/* 1. Verified Active Engine Telemetry */}
          <section
            aria-label="Active audio engine telemetry"
            className="rounded-xl border border-[var(--apex-border)] bg-[var(--apex-surface-2)] p-4"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-[var(--apex-accent)]" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--apex-text)]">
                  Verified Active Engine Telemetry
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <span
                  data-testid="audio-context-state-badge"
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${contextStateBadge.className}`}
                >
                  {contextStateBadge.label}
                </span>
                {(diagnostics.contextState === 'uninitialized' ||
                  diagnostics.contextState === 'suspended' ||
                  diagnostics.contextState === 'closed') && (
                  <button
                    type="button"
                    onClick={() => void handleInitializeOrResumeEngine()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--apex-accent)] bg-[var(--apex-state-selected)] px-2.5 py-1 text-xs font-semibold text-[var(--apex-text)] hover:bg-[var(--apex-surface-3)]"
                  >
                    <Play className="h-3 w-3" />
                    {diagnostics.contextState === 'uninitialized'
                      ? 'Initialize Engine'
                      : diagnostics.contextState === 'suspended'
                        ? 'Resume Engine'
                        : 'Recreate Engine'}
                  </button>
                )}
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] p-2.5">
                <dt className="text-[11px] text-[var(--apex-text-3)]">Actual Sample Rate</dt>
                <dd
                  data-testid="audio-actual-sample-rate"
                  className="mt-1 font-mono text-sm font-semibold text-[var(--apex-text)]"
                >
                  {formatSampleRateLabel(diagnostics.actualSampleRate)}
                </dd>
                <span className="mt-0.5 block text-[11px] text-[var(--apex-text-2)]">
                  Requested: {formatSampleRateLabel(diagnostics.requestedSampleRate)}
                </span>
              </div>

              <div className="rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] p-2.5">
                <dt className="text-[11px] text-[var(--apex-text-3)]">Base Latency</dt>
                <dd
                  data-testid="audio-base-latency"
                  className="mt-1 font-mono text-sm font-semibold text-[var(--apex-text)]"
                >
                  {formatLatencyMilliseconds(diagnostics.latencyMetrics?.baseLatencySeconds)}
                </dd>
                <span className="mt-0.5 block text-[11px] text-[var(--apex-text-2)]">
                  AudioContext.baseLatency
                </span>
              </div>

              <div className="rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] p-2.5">
                <dt className="text-[11px] text-[var(--apex-text-3)]">Output Latency</dt>
                <dd
                  data-testid="audio-output-latency"
                  className="mt-1 font-mono text-sm font-semibold text-[var(--apex-text)]"
                >
                  {formatLatencyMilliseconds(diagnostics.latencyMetrics?.outputLatencySeconds)}
                </dd>
                <span className="mt-0.5 block text-[11px] text-[var(--apex-text-2)]">
                  AudioContext.outputLatency
                </span>
              </div>

              <div className="rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] p-2.5">
                <dt className="text-[11px] text-[var(--apex-text-3)]">Render Quantum</dt>
                <dd className="mt-1 font-mono text-sm font-semibold text-[var(--apex-text)]">
                  {diagnostics.latencyMetrics
                    ? `${diagnostics.latencyMetrics.renderQuantumSamples} frames`
                    : '128 frames'}
                </dd>
                <span className="mt-0.5 block text-[11px] text-[var(--apex-text-2)]">
                  Web Audio block (not RTL)
                </span>
              </div>
            </dl>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--apex-border)] pt-2.5 text-xs text-[var(--apex-text-2)]">
              <span>
                Active Output Sink:{' '}
                <strong className="font-medium text-[var(--apex-text)]">{activeOutputLabel}</strong>
              </span>
              <span>
                Active Preference:{' '}
                <strong className="font-medium text-[var(--apex-text)]">
                  {LATENCY_COPY[diagnostics.latencyHint].label}
                </strong>
              </span>
            </div>

            {diagnostics.sampleRateMismatchNotice && (
              <div
                role="status"
                className="mt-3 flex items-start gap-2 rounded-md border border-[var(--apex-gold)] bg-[var(--apex-surface)] p-2.5 text-xs text-[var(--apex-text)]"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--apex-gold)]" />
                <span>{diagnostics.sampleRateMismatchNotice}</span>
              </div>
            )}
          </section>

          {/* 2. Audio Output Device */}
          <fieldset className="rounded-xl border border-[var(--apex-border)] bg-[var(--apex-surface-2)] p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--apex-text)]">
              <span className="inline-flex items-center gap-1.5">
                <Volume2 className="h-4 w-4 text-[var(--apex-accent)]" />
                Audio Output Device
              </span>
            </legend>

            <div className="mt-2 space-y-2.5">
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                <label htmlFor="audio-output-device-select" className="sr-only">
                  Audio Output Device
                </label>
                <select
                  id="audio-output-device-select"
                  value={selectedOutputValue}
                  onChange={e => void handleOutputDeviceChange(e)}
                  disabled={!deviceSnapshot.capabilities.outputSinkSelectionSupported}
                  className="min-h-[36px] flex-1 rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] px-3 py-1.5 text-xs text-[var(--apex-text)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deviceSnapshot.outputDevices.map(device => (
                    <option key={device.deviceId || 'system-default-output'} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
                {deviceSnapshot.capabilities.selectAudioOutputPromptSupported && (
                  <button
                    type="button"
                    onClick={() => void deviceManager.promptOutputDeviceSelection()}
                    className="rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] px-3 py-1.5 text-xs font-medium text-[var(--apex-text)] hover:border-[var(--apex-accent)]"
                  >
                    Choose Speaker…
                  </button>
                )}
              </div>

              {!deviceSnapshot.capabilities.outputSinkSelectionSupported && (
                <p
                  role="status"
                  data-testid="output-sink-unsupported-notice"
                  className="text-xs text-[var(--apex-text-2)]"
                >
                  Audio output device switching (AudioContext.setSinkId) is not supported in this runtime. Playback routes through your operating system Default System Device.
                </p>
              )}

              {deviceSnapshot.outputNotice && (
                <div
                  role={deviceSnapshot.outputNotice.tone === 'error' ? 'alert' : 'status'}
                  className={`flex items-start gap-2 rounded-md border bg-[var(--apex-surface)] p-2.5 text-xs ${
                    deviceSnapshot.outputNotice.tone === 'error'
                      ? 'border-[var(--apex-danger)] text-[var(--apex-text)]'
                      : 'border-[var(--apex-gold)] text-[var(--apex-text)]'
                  }`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--apex-gold)]" />
                  <span>{deviceSnapshot.outputNotice.message}</span>
                </div>
              )}
            </div>
          </fieldset>

          {/* 3. Audio Input Device */}
          <fieldset className="rounded-xl border border-[var(--apex-border)] bg-[var(--apex-surface-2)] p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--apex-text)]">
              <span className="inline-flex items-center gap-1.5">
                <Mic className="h-4 w-4 text-[var(--apex-accent)]" />
                Recording Input Device
              </span>
            </legend>

            <div className="mt-2 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`text-xs font-medium ${permissionBadge.toneClass}`}>
                  {permissionBadge.label}
                </span>
                {deviceSnapshot.microphonePermission !== 'granted' && (
                  <button
                    type="button"
                    onClick={() => void handleGrantMicrophonePermission()}
                    disabled={
                      deviceSnapshot.isRequestingPermission ||
                      !deviceSnapshot.capabilities.microphoneCaptureSupported
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--apex-accent)] bg-[var(--apex-state-selected)] px-3 py-1.5 text-xs font-semibold text-[var(--apex-text)] hover:bg-[var(--apex-surface-3)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Mic className="h-3.5 w-3.5" />
                    {deviceSnapshot.isRequestingPermission
                      ? 'Requesting Access…'
                      : 'Grant Microphone Access'}
                  </button>
                )}
              </div>

              <div>
                <label htmlFor="audio-input-device-select" className="sr-only">
                  Recording Input Device
                </label>
                <select
                  id="audio-input-device-select"
                  value={deviceSnapshot.preferences.inputDeviceId}
                  onChange={handleInputDeviceChange}
                  disabled={!deviceSnapshot.capabilities.microphoneCaptureSupported}
                  className="min-h-[36px] w-full rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] px-3 py-1.5 text-xs text-[var(--apex-text)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deviceSnapshot.inputDevices.map(device => (
                    <option key={device.deviceId || 'system-default-input'} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                  {!selectedInputInList && deviceSnapshot.preferences.inputDeviceId !== SYSTEM_DEFAULT_DEVICE_ID && (
                    <option value={deviceSnapshot.preferences.inputDeviceId}>
                      Saved Input Device (Disconnected)
                    </option>
                  )}
                </select>
              </div>

              <p className="text-xs text-[var(--apex-text-2)]">
                Selects the capture input used when recording audio takes in Audio Recorder. Live input monitoring through the Mixer is not enabled.
              </p>

              {deviceSnapshot.inputNotice && (
                <div
                  role={deviceSnapshot.inputNotice.tone === 'error' ? 'alert' : 'status'}
                  className={`flex items-start gap-2 rounded-md border bg-[var(--apex-surface)] p-2.5 text-xs ${
                    deviceSnapshot.inputNotice.tone === 'error'
                      ? 'border-[var(--apex-danger)] text-[var(--apex-text)]'
                      : 'border-[var(--apex-gold)] text-[var(--apex-text)]'
                  }`}
                >
                  <AlertTriangle
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      deviceSnapshot.inputNotice.tone === 'error'
                        ? 'text-[var(--apex-danger)]'
                        : 'text-[var(--apex-gold)]'
                    }`}
                  />
                  <span>{deviceSnapshot.inputNotice.message}</span>
                </div>
              )}
            </div>
          </fieldset>

          {/* 4. Sample Rate & Latency Preference (Stopped-Only Reconfiguration) */}
          <fieldset className="rounded-xl border border-[var(--apex-border)] bg-[var(--apex-surface-2)] p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--apex-text)]">
              Audio Engine Sample Rate &amp; Latency Preference
            </legend>

            {diagnostics.reconfigureBlockedReason && (
              <div
                role="status"
                data-testid="audio-reconfigure-locked-banner"
                className="mt-2 mb-3 flex items-start gap-2 rounded-md border border-[var(--apex-gold)] bg-[var(--apex-surface)] p-2.5 text-xs text-[var(--apex-text)]"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--apex-gold)]" />
                <span>{diagnostics.reconfigureBlockedReason}</span>
              </div>
            )}

            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="audio-sample-rate-select"
                  className="mb-1.5 block text-xs font-medium text-[var(--apex-text)]"
                >
                  Requested Sample Rate
                </label>
                <select
                  id="audio-sample-rate-select"
                  value={String(stagedSampleRate)}
                  onChange={e => setStagedSampleRate(parseSampleRateSelection(e.target.value))}
                  disabled={isReconfigureLocked}
                  className="min-h-[36px] w-full rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] px-3 py-1.5 text-xs text-[var(--apex-text)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="default">System Default</option>
                  {SUPPORTED_SAMPLE_RATES.map(rate => (
                    <option key={rate} value={String(rate)}>
                      {formatSampleRateLabel(rate)}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-[var(--apex-text-2)]">
                  Applies to live AudioContext creation while stopped. Offline WAV/MP3 export continues to use the sample rate chosen in Export Audio.
                </p>
              </div>

              <div>
                <span
                  id="audio-latency-preference-label"
                  className="mb-1.5 block text-xs font-medium text-[var(--apex-text)]"
                >
                  Latency Preference (latencyHint)
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="audio-latency-preference-label"
                  className="space-y-1.5"
                >
                  {AUDIO_LATENCY_PREFERENCES.map(pref => {
                    const selected = stagedLatencyHint === pref;
                    return (
                      <label
                        key={pref}
                        className={`flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
                          isReconfigureLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                        } ${
                          selected
                            ? 'border-[var(--apex-accent)] bg-[var(--apex-state-selected)]'
                            : 'border-[var(--apex-border)] bg-[var(--apex-surface)] hover:border-[var(--apex-accent)]'
                        }`}
                      >
                        <input
                          type="radio"
                          name="audio-latency-hint"
                          value={pref}
                          checked={selected}
                          disabled={isReconfigureLocked}
                          onChange={() => setStagedLatencyHint(pref)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="block text-xs font-semibold text-[var(--apex-text)]">
                            {LATENCY_COPY[pref].label}
                          </span>
                          <span className="block text-[11px] text-[var(--apex-text-2)]">
                            {LATENCY_COPY[pref].description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <p className="mt-3 text-[11px] text-[var(--apex-text-2)]">
              Web Audio latency preferences request an operating-system scheduling profile rather than a fixed hardware buffer size. Actual buffer timing is governed by your OS audio subsystem and connected device.
            </p>

            {diagnostics.lastReconfigureError && !statusBanner && (
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-md border border-[var(--apex-danger)] bg-[var(--apex-surface)] p-2.5 text-xs text-[var(--apex-text)]"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--apex-danger)]" />
                <span>{diagnostics.lastReconfigureError}</span>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--apex-border)] pt-3">
              <button
                type="button"
                onClick={() => void handleResetDefaults()}
                disabled={isReconfigureLocked}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--apex-border)] bg-[var(--apex-surface)] px-3 py-1.5 text-xs font-medium text-[var(--apex-text)] hover:border-[var(--apex-accent)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset to Defaults
              </button>

              <button
                type="button"
                onClick={() => void handleApplyEngineConfig()}
                disabled={isReconfigureLocked || !hasPendingEngineChanges}
                className="rounded-lg bg-[var(--apex-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--apex-state-playing-fg)] hover:bg-[var(--apex-accent-strong)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {diagnostics.isReconfiguring
                  ? 'Reconfiguring Engine…'
                  : diagnostics.initialized
                    ? 'Apply Engine Settings'
                    : 'Initialize with Settings'}
              </button>
            </div>
          </fieldset>

          <p className="text-[11px] text-[var(--apex-text-3)]">
            Audio Settings are saved as application preferences for this workstation and are never stored inside project files, Undo/Redo history, or portable project exports.
          </p>
        </div>
      </div>
    </ModalFrame>
  );
};

export default AudioSettingsModal;
