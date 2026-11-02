import {
  AudioLatencyPreference,
  AudioPreferences,
  DEFAULT_AUDIO_PREFERENCES,
  RequestedSampleRate,
  SYSTEM_DEFAULT_DEVICE_ID,
  StorageLike,
  loadAudioPreferences,
  normalizeAudioDeviceId,
  normalizeAudioLatencyPreference,
  normalizeRequestedSampleRate,
  resetAudioPreferences,
  saveAudioPreferences,
} from '../state/audioPreferences';

export type MicrophonePermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported' | 'unknown';

export interface AudioDeviceDescriptor {
  deviceId: string;
  groupId: string;
  kind: 'audioinput' | 'audiooutput';
  label: string;
  isSystemDefault: boolean;
  labelRevealed: boolean;
}

export interface AudioContextWithSinkId extends AudioContext {
  readonly sinkId?: string | { type: 'none' };
  setSinkId?: (sinkId: string | { type: 'none' }) => Promise<void>;
}

export interface AudioDeviceCapabilities {
  deviceEnumerationSupported: boolean;
  microphoneCaptureSupported: boolean;
  outputSinkSelectionSupported: boolean;
  selectAudioOutputPromptSupported: boolean;
}

export interface OutputDeviceSwitchResult {
  ok: boolean;
  liveSwitched: boolean;
  preferenceSaved: boolean;
  activeDeviceId: string;
  fellBackToDefault: boolean;
  unsupported: boolean;
  message: string | null;
}

export interface MicrophonePermissionRequestResult {
  granted: boolean;
  permissionState: MicrophonePermissionState;
  message: string | null;
}

export interface AudioDeviceManagerSnapshot {
  preferences: AudioPreferences;
  storageAvailable: boolean;
  capabilities: AudioDeviceCapabilities;
  microphonePermission: MicrophonePermissionState;
  outputDevices: AudioDeviceDescriptor[];
  inputDevices: AudioDeviceDescriptor[];
  activeOutputDeviceId: string;
  selectedOutputAvailable: boolean;
  selectedInputAvailable: boolean;
  isEnumerating: boolean;
  isRequestingPermission: boolean;
  outputNotice: { tone: 'warning' | 'error' | 'info'; message: string } | null;
  inputNotice: { tone: 'warning' | 'error' | 'info'; message: string } | null;
}

export interface MediaDevicesLike {
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
}

export interface PermissionsLike {
  query?: (descriptor: { name: string }) => Promise<{
    state: string;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
    onchange?: (() => void) | null;
  }>;
}

export interface AudioDeviceManagerEnvironment {
  getMediaDevices?: () => MediaDevicesLike | undefined;
  getPermissions?: () => PermissionsLike | undefined;
  getAudioContextConstructor?: () => { prototype?: unknown } | undefined;
  storage?: StorageLike | null;
}

const stripDefaultPrefix = (label: string): string =>
  label.replace(/^default\s*[-–:]\s*/i, '').trim();

const extractDomExceptionName = (error: unknown): string => {
  if (!error || typeof error !== 'object') return '';
  const named = error as { name?: unknown };
  return typeof named.name === 'string' ? named.name : '';
};

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Unknown audio device error.';
};

export const supportsAudioContextSetSinkId = (
  ctx?: AudioContext | null,
  audioContextConstructor?: { prototype?: unknown },
): boolean => {
  if (ctx && typeof (ctx as AudioContextWithSinkId).setSinkId === 'function') {
    return true;
  }
  const ctor =
    audioContextConstructor ??
    (typeof globalThis !== 'undefined'
      ? ((globalThis as unknown as { AudioContext?: { prototype?: unknown }; webkitAudioContext?: { prototype?: unknown } })
          .AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: { prototype?: unknown } }).webkitAudioContext)
      : undefined);
  const proto = ctor?.prototype as { setSinkId?: unknown } | undefined;
  return Boolean(proto && typeof proto.setSinkId === 'function');
};

export const readContextSinkId = (ctx?: AudioContext | null): string => {
  if (!ctx) return SYSTEM_DEFAULT_DEVICE_ID;
  const raw = (ctx as AudioContextWithSinkId).sinkId;
  if (typeof raw !== 'string') return SYSTEM_DEFAULT_DEVICE_ID;
  return normalizeAudioDeviceId(raw);
};

export const buildMicrophoneAudioTrackConstraints = (
  preferredInputDeviceId: string,
): MediaTrackConstraints => {
  const normalizedId = normalizeAudioDeviceId(preferredInputDeviceId);
  const base: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (normalizedId !== SYSTEM_DEFAULT_DEVICE_ID) {
    base.deviceId = { exact: normalizedId };
  }
  return base;
};

export class AudioDeviceManager {
  private preferences: AudioPreferences;
  private storageAvailable: boolean;
  private readonly env: AudioDeviceManagerEnvironment;
  private readonly listeners = new Set<(snapshot: AudioDeviceManagerSnapshot) => void>();

  private microphonePermission: MicrophonePermissionState = 'unknown';
  private outputDevices: AudioDeviceDescriptor[] = [
    {
      deviceId: SYSTEM_DEFAULT_DEVICE_ID,
      groupId: 'default',
      kind: 'audiooutput',
      label: 'Default System Device',
      isSystemDefault: true,
      labelRevealed: true,
    },
  ];
  private inputDevices: AudioDeviceDescriptor[] = [
    {
      deviceId: SYSTEM_DEFAULT_DEVICE_ID,
      groupId: 'default',
      kind: 'audioinput',
      label: 'Default System Device',
      isSystemDefault: true,
      labelRevealed: true,
    },
  ];

  private activeOutputDeviceId: string = SYSTEM_DEFAULT_DEVICE_ID;
  private selectedOutputAvailable = true;
  private selectedInputAvailable = true;
  private isEnumerating = false;
  private isRequestingPermission = false;
  private outputNotice: { tone: 'warning' | 'error' | 'info'; message: string } | null = null;
  private inputNotice: { tone: 'warning' | 'error' | 'info'; message: string } | null = null;

  private boundContext: AudioContext | null = null;
  private monitoringInitialized = false;
  private monitoringGeneration = 0;
  private monitoringInitPromise: Promise<AudioDeviceManagerSnapshot> | null = null;
  private detachDeviceChangeListener: (() => void) | null = null;
  private detachPermissionListener: (() => void) | null = null;
  private knownHardwareOutputIds = new Set<string>();
  private knownHardwareInputIds = new Set<string>();

  constructor(env: AudioDeviceManagerEnvironment = {}) {
    this.env = env;
    const loaded = loadAudioPreferences(env.storage);
    this.preferences = loaded.preferences;
    this.storageAvailable = loaded.storageAvailable;
    if (loaded.hadInvalidStoredData) {
      // Heal invalid stored values immediately if storage is writable.
      const saved = saveAudioPreferences(this.preferences, env.storage);
      this.storageAvailable = saved.persisted || loaded.storageAvailable;
    }
  }

  private resolveMediaDevices(): MediaDevicesLike | undefined {
    if (this.env.getMediaDevices) return this.env.getMediaDevices();
    if (typeof navigator === 'undefined') return undefined;
    return navigator.mediaDevices as unknown as MediaDevicesLike | undefined;
  }

  private resolvePermissions(): PermissionsLike | undefined {
    if (this.env.getPermissions) return this.env.getPermissions();
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as unknown as { permissions?: PermissionsLike }).permissions;
  }

  public getCapabilities(ctx?: AudioContext | null): AudioDeviceCapabilities {
    const mediaDevices = this.resolveMediaDevices();
    const effectiveContext = ctx ?? this.boundContext;
    return {
      deviceEnumerationSupported: typeof mediaDevices?.enumerateDevices === 'function',
      microphoneCaptureSupported: typeof mediaDevices?.getUserMedia === 'function',
      outputSinkSelectionSupported: supportsAudioContextSetSinkId(
        effectiveContext,
        this.env.getAudioContextConstructor?.(),
      ),
      selectAudioOutputPromptSupported: typeof mediaDevices?.selectAudioOutput === 'function',
    };
  }

  public getPreferences(): AudioPreferences {
    return { ...this.preferences };
  }

  public getPreferredInputDeviceId(): string {
    return this.preferences.inputDeviceId;
  }

  public getPreferredOutputDeviceId(): string {
    return this.preferences.outputDeviceId;
  }

  public getBoundAudioContext(): AudioContext | null {
    return this.boundContext;
  }

  public isMonitoringActive(): boolean {
    return this.monitoringInitialized;
  }

  public getActiveOutputDeviceId(ctx?: AudioContext | null): string {
    const effectiveCtx = ctx === undefined ? this.boundContext : ctx;
    if (effectiveCtx && effectiveCtx.state !== 'closed') {
      if (supportsAudioContextSetSinkId(effectiveCtx, this.env.getAudioContextConstructor?.())) {
        const sinkRaw = (effectiveCtx as AudioContextWithSinkId).sinkId;
        if (typeof sinkRaw === 'string') {
          return normalizeAudioDeviceId(sinkRaw);
        }
      }
      return this.activeOutputDeviceId;
    }
    return SYSTEM_DEFAULT_DEVICE_ID;
  }

  public getSnapshot(ctx?: AudioContext | null): AudioDeviceManagerSnapshot {
    return {
      preferences: { ...this.preferences },
      storageAvailable: this.storageAvailable,
      capabilities: this.getCapabilities(ctx),
      microphonePermission: this.microphonePermission,
      outputDevices: this.outputDevices.map(device => ({ ...device })),
      inputDevices: this.inputDevices.map(device => ({ ...device })),
      activeOutputDeviceId: this.getActiveOutputDeviceId(ctx),
      selectedOutputAvailable: this.selectedOutputAvailable,
      selectedInputAvailable: this.selectedInputAvailable,
      isEnumerating: this.isEnumerating,
      isRequestingPermission: this.isRequestingPermission,
      outputNotice: this.outputNotice ? { ...this.outputNotice } : null,
      inputNotice: this.inputNotice ? { ...this.inputNotice } : null,
    };
  }

  public subscribe(listener: (snapshot: AudioDeviceManagerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private persistPreferences(next: Partial<AudioPreferences>): void {
    const saved = saveAudioPreferences(
      {
        ...this.preferences,
        ...next,
      },
      this.env.storage,
    );
    this.preferences = saved.preferences;
    this.storageAvailable = saved.persisted;
  }

  public bindAudioContext(ctx: AudioContext | null): void {
    this.boundContext = ctx;
    if (ctx && ctx.state !== 'closed') {
      this.activeOutputDeviceId = readContextSinkId(ctx);
    } else {
      this.activeOutputDeviceId = SYSTEM_DEFAULT_DEVICE_ID;
    }
    this.emit();
  }

  /**
   * Initializes passive permission inspection and `devicechange` monitoring once.
   * Never calls `getUserMedia` and never triggers a startup permission prompt.
   */
  public initializePassiveMonitoring(): Promise<AudioDeviceManagerSnapshot> {
    if (this.monitoringInitialized) {
      if (this.monitoringInitPromise) {
        return this.monitoringInitPromise;
      }
      return Promise.resolve(this.getSnapshot());
    }

    this.monitoringInitialized = true;
    const generation = ++this.monitoringGeneration;

    const mediaDevices = this.resolveMediaDevices();
    if (mediaDevices?.addEventListener) {
      const onDeviceChange = () => {
        if (this.monitoringGeneration !== generation || !this.monitoringInitialized) return;
        void this.handleDeviceChangeEvent();
      };
      mediaDevices.addEventListener('devicechange', onDeviceChange);
      this.detachDeviceChangeListener = () => {
        mediaDevices.removeEventListener?.('devicechange', onDeviceChange);
      };
    }

    const initRun = (async () => {
      await this.inspectMicrophonePermissionPassively(generation);
      if (this.monitoringGeneration === generation && this.monitoringInitialized) {
        await this.refreshDevices();
      }
      return this.getSnapshot();
    })().finally(() => {
      if (this.monitoringInitPromise === initRun) {
        this.monitoringInitPromise = null;
      }
    });

    this.monitoringInitPromise = initRun;
    return initRun;
  }

  public disposeMonitoring(): void {
    this.monitoringGeneration += 1;
    this.monitoringInitPromise = null;
    this.detachDeviceChangeListener?.();
    this.detachDeviceChangeListener = null;
    this.detachPermissionListener?.();
    this.detachPermissionListener = null;
    this.monitoringInitialized = false;
  }

  private async inspectMicrophonePermissionPassively(generation: number): Promise<void> {
    const capabilities = this.getCapabilities();
    if (!capabilities.microphoneCaptureSupported) {
      this.microphonePermission = 'unsupported';
      return;
    }
    const permissions = this.resolvePermissions();
    if (typeof permissions?.query !== 'function') {
      if (this.microphonePermission === 'unknown') {
        this.microphonePermission = 'prompt';
      }
      return;
    }
    try {
      const status = await permissions.query({ name: 'microphone' });
      if (this.monitoringGeneration !== generation || !this.monitoringInitialized) {
        return;
      }
      const applyState = (rawState: string) => {
        if (this.monitoringGeneration !== generation || !this.monitoringInitialized) return;
        if (rawState === 'granted' || rawState === 'denied' || rawState === 'prompt') {
          const previous = this.microphonePermission;
          this.microphonePermission = rawState;
          if (previous === 'granted' && rawState === 'denied') {
            this.inputNotice = {
              tone: 'warning',
              message:
                'Microphone permission was revoked. Re-enable microphone access in browser or system settings to capture audio inputs.',
            };
            void this.refreshDevices();
          } else if (rawState === 'granted' && previous !== 'granted') {
            void this.refreshDevices();
          }
          this.emit();
        }
      };
      applyState(status.state);
      const onChange = () => applyState(status.state);
      if (typeof status.addEventListener === 'function') {
        status.addEventListener('change', onChange);
        this.detachPermissionListener = () => status.removeEventListener?.('change', onChange);
      } else if ('onchange' in status) {
        status.onchange = onChange;
        this.detachPermissionListener = () => {
          if (status.onchange === onChange) {
            status.onchange = null;
          }
        };
      }
    } catch {
      if (this.microphonePermission === 'unknown') {
        this.microphonePermission = 'prompt';
      }
    }
  }

  private async handleDeviceChangeEvent(): Promise<void> {
    await this.refreshDevices({ fromHotPlug: true });
  }

  public async refreshDevices(options: { fromHotPlug?: boolean } = {}): Promise<AudioDeviceManagerSnapshot> {
    const mediaDevices = this.resolveMediaDevices();
    if (typeof mediaDevices?.enumerateDevices !== 'function') {
      this.outputDevices = [
        {
          deviceId: SYSTEM_DEFAULT_DEVICE_ID,
          groupId: 'default',
          kind: 'audiooutput',
          label: 'Default System Device',
          isSystemDefault: true,
          labelRevealed: true,
        },
      ];
      this.inputDevices = [
        {
          deviceId: SYSTEM_DEFAULT_DEVICE_ID,
          groupId: 'default',
          kind: 'audioinput',
          label: 'Default System Device',
          isSystemDefault: true,
          labelRevealed: true,
        },
      ];
      this.emit();
      return this.getSnapshot();
    }

    this.isEnumerating = true;
    this.emit();

    try {
      const rawDevices = await mediaDevices.enumerateDevices();
      const nextOutputs = this.buildDescriptorList(rawDevices, 'audiooutput');
      const nextInputs = this.buildDescriptorList(rawDevices, 'audioinput');
      this.outputDevices = nextOutputs;
      this.inputDevices = nextInputs;

      const anyInputLabelRevealed = rawDevices.some(
        d => d.kind === 'audioinput' && typeof d.label === 'string' && d.label.trim().length > 0,
      );
      if (anyInputLabelRevealed && (this.microphonePermission === 'unknown' || this.microphonePermission === 'prompt')) {
        this.microphonePermission = 'granted';
      }

      const currentHardwareOutputIds = new Set(
        nextOutputs.filter(d => !d.isSystemDefault && d.deviceId !== '').map(d => d.deviceId),
      );
      const currentHardwareInputIds = new Set(
        nextInputs.filter(d => !d.isSystemDefault && d.deviceId !== '').map(d => d.deviceId),
      );

      for (const id of currentHardwareOutputIds) this.knownHardwareOutputIds.add(id);
      for (const id of currentHardwareInputIds) this.knownHardwareInputIds.add(id);

      await this.reconcileSelectedOutputAfterEnumeration(
        currentHardwareOutputIds,
        Boolean(options.fromHotPlug),
      );
      this.reconcileSelectedInputAfterEnumeration(
        currentHardwareInputIds,
        Boolean(options.fromHotPlug),
      );
    } catch (error) {
      this.outputNotice = {
        tone: 'error',
        message: `Failed to enumerate audio devices: ${extractErrorMessage(error)}`,
      };
    } finally {
      this.isEnumerating = false;
      this.emit();
    }

    return this.getSnapshot();
  }

  private buildDescriptorList(
    rawDevices: readonly MediaDeviceInfo[],
    kind: 'audioinput' | 'audiooutput',
  ): AudioDeviceDescriptor[] {
    const matching = rawDevices.filter(device => device.kind === kind);
    const osDefaultEntry = matching.find(device => device.deviceId === 'default');
    const osDefaultDetail =
      osDefaultEntry && typeof osDefaultEntry.label === 'string'
        ? stripDefaultPrefix(osDefaultEntry.label)
        : '';

    const defaultLabel =
      osDefaultDetail.length > 0 && osDefaultDetail.toLowerCase() !== 'default'
        ? `Default System Device (${osDefaultDetail})`
        : 'Default System Device';

    const list: AudioDeviceDescriptor[] = [
      {
        deviceId: SYSTEM_DEFAULT_DEVICE_ID,
        groupId: osDefaultEntry?.groupId || 'default',
        kind,
        label: defaultLabel,
        isSystemDefault: true,
        labelRevealed: true,
      },
    ];

    const seenIds = new Set<string>([SYSTEM_DEFAULT_DEVICE_ID, 'default']);
    let unnamedIndex = 0;

    for (const device of matching) {
      const normalizedId = normalizeAudioDeviceId(device.deviceId);
      if (!normalizedId || seenIds.has(normalizedId)) continue;
      seenIds.add(normalizedId);

      const trimmedLabel = typeof device.label === 'string' ? device.label.trim() : '';
      const labelRevealed = trimmedLabel.length > 0;
      if (!labelRevealed) unnamedIndex += 1;

      const fallbackNoun = kind === 'audiooutput' ? 'Audio Output' : 'Audio Input';
      const label = labelRevealed
        ? trimmedLabel
        : `${fallbackNoun} ${unnamedIndex} (grant microphone access for hardware name)`;

      list.push({
        deviceId: normalizedId,
        groupId: device.groupId || normalizedId,
        kind,
        label,
        isSystemDefault: false,
        labelRevealed,
      });
    }

    return list;
  }

  private async reconcileSelectedOutputAfterEnumeration(
    currentHardwareOutputIds: ReadonlySet<string>,
    fromHotPlug: boolean,
  ): Promise<void> {
    const preferredOutput = this.preferences.outputDeviceId;
    if (preferredOutput === SYSTEM_DEFAULT_DEVICE_ID) {
      this.selectedOutputAvailable = true;
      return;
    }

    if (currentHardwareOutputIds.has(preferredOutput)) {
      this.selectedOutputAvailable = true;
      // If a previously disconnected preferred output was plugged back in while bound, re-route to it cleanly.
      if (
        fromHotPlug &&
        this.boundContext &&
        this.boundContext.state !== 'closed' &&
        this.getActiveOutputDeviceId(this.boundContext) !== preferredOutput &&
        this.getCapabilities(this.boundContext).outputSinkSelectionSupported
      ) {
        await this.applyOutputDeviceToContext(this.boundContext, preferredOutput, { persist: false });
      }
      return;
    }

    // Only declare the preferred device missing when hardware IDs have actually been exposed
    // or when we previously observed this exact hardware ID before a disconnect.
    const enumerationExposedIds =
      currentHardwareOutputIds.size > 0 || this.knownHardwareOutputIds.has(preferredOutput);
    if (!enumerationExposedIds) {
      return;
    }

    this.selectedOutputAvailable = false;
    await this.fallBackOutputToSystemDefault(
      fromHotPlug
        ? 'Selected audio output device was disconnected. Audio output fell back to Default System Device.'
        : 'Saved audio output device is not currently connected. Using Default System Device.',
      { keepPreferenceForReconnect: false },
    );
  }

  private reconcileSelectedInputAfterEnumeration(
    currentHardwareInputIds: ReadonlySet<string>,
    fromHotPlug: boolean,
  ): void {
    const preferredInput = this.preferences.inputDeviceId;
    if (preferredInput === SYSTEM_DEFAULT_DEVICE_ID) {
      this.selectedInputAvailable = true;
      return;
    }

    if (currentHardwareInputIds.has(preferredInput)) {
      const wasUnavailable = !this.selectedInputAvailable;
      this.selectedInputAvailable = true;
      if (wasUnavailable) {
        this.inputNotice = {
          tone: 'info',
          message: 'Selected audio input device reconnected and is ready for recording.',
        };
      }
      return;
    }

    const enumerationExposedIds =
      currentHardwareInputIds.size > 0 ||
      this.knownHardwareInputIds.has(preferredInput) ||
      this.microphonePermission === 'granted';
    if (!enumerationExposedIds) {
      return;
    }

    this.selectedInputAvailable = false;
    this.inputNotice = {
      tone: 'warning',
      message: fromHotPlug
        ? 'Selected audio input device was disconnected. Reconnect it or choose Default System Device before recording.'
        : 'Saved audio input device is not currently connected. Choose an available input or Default System Device before recording.',
    };
  }

  private async fallBackOutputToSystemDefault(
    reasonMessage: string,
    options: { keepPreferenceForReconnect: boolean },
  ): Promise<void> {
    const liveCtx =
      this.boundContext && this.boundContext.state !== 'closed' ? this.boundContext : null;
    if (
      liveCtx &&
      supportsAudioContextSetSinkId(liveCtx, this.env.getAudioContextConstructor?.())
    ) {
      try {
        await (liveCtx as AudioContextWithSinkId).setSinkId?.(SYSTEM_DEFAULT_DEVICE_ID);
      } catch {
        // Ignore secondary fallback errors on closing/broken contexts.
      }
    }
    const actualAfterFallback = liveCtx
      ? readContextSinkId(liveCtx)
      : SYSTEM_DEFAULT_DEVICE_ID;
    this.activeOutputDeviceId = actualAfterFallback;
    if (!options.keepPreferenceForReconnect) {
      this.persistPreferences({ outputDeviceId: actualAfterFallback });
      this.selectedOutputAvailable = true;
    }
    this.outputNotice = {
      tone: 'warning',
      message: reasonMessage,
    };
  }

  /**
   * Explicit user-initiated microphone permission grant.
   * Opens a temporary audio capture stream and releases every track immediately
   * in `finally` so no background microphone capture remains open.
   */
  public async requestMicrophonePermission(): Promise<MicrophonePermissionRequestResult> {
    const mediaDevices = this.resolveMediaDevices();
    if (typeof mediaDevices?.getUserMedia !== 'function') {
      this.microphonePermission = 'unsupported';
      const message = 'Microphone capture (navigator.mediaDevices.getUserMedia) is not supported in this runtime.';
      this.inputNotice = { tone: 'error', message };
      this.emit();
      return { granted: false, permissionState: 'unsupported', message };
    }

    this.isRequestingPermission = true;
    this.emit();

    let tempStream: MediaStream | null = null;
    try {
      tempStream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (error) {
      const domName = extractDomExceptionName(error);
      let message: string;
      if (domName === 'NotAllowedError' || domName === 'PermissionDeniedError' || domName === 'SecurityError') {
        this.microphonePermission = 'denied';
        message =
          'Microphone permission was denied. Allow microphone access in your browser or system privacy settings to enumerate hardware labels and record audio.';
      } else if (domName === 'NotFoundError' || domName === 'DevicesNotFoundError') {
        message = 'No audio input hardware was detected on this system.';
      } else if (domName === 'NotReadableError' || domName === 'TrackStartError') {
        message =
          'Audio input hardware could not be opened. Check that another application is not holding exclusive control of the device.';
      } else {
        message = `Could not access audio input: ${extractErrorMessage(error)}`;
      }
      this.inputNotice = { tone: 'error', message };
      this.isRequestingPermission = false;
      this.emit();
      return {
        granted: false,
        permissionState: this.microphonePermission,
        message,
      };
    } finally {
      if (tempStream) {
        const tracks =
          typeof tempStream.getTracks === 'function'
            ? tempStream.getTracks()
            : typeof tempStream.getAudioTracks === 'function'
              ? tempStream.getAudioTracks()
              : [];
        for (const track of tracks) {
          try {
            track.stop();
          } catch {
            // Best-effort track teardown.
          }
        }
      }
    }

    this.microphonePermission = 'granted';
    this.inputNotice = null;
    this.isRequestingPermission = false;
    await this.refreshDevices();
    return {
      granted: true,
      permissionState: 'granted',
      message: null,
    };
  }

  /**
   * Optional browser speaker-selection prompt (`navigator.mediaDevices.selectAudioOutput`)
   * for runtimes that gate non-default output enumeration behind an explicit picker.
   */
  public async promptOutputDeviceSelection(
    ctx?: AudioContext | null,
  ): Promise<OutputDeviceSwitchResult> {
    const mediaDevices = this.resolveMediaDevices();
    if (typeof mediaDevices?.selectAudioOutput !== 'function') {
      const message = 'Interactive speaker picker (selectAudioOutput) is not supported in this runtime.';
      this.outputNotice = { tone: 'warning', message };
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: this.getActiveOutputDeviceId(ctx),
        fellBackToDefault: false,
        unsupported: true,
        message,
      };
    }

    try {
      const chosen = await mediaDevices.selectAudioOutput();
      await this.refreshDevices();
      const targetId = normalizeAudioDeviceId(chosen?.deviceId);
      return ctx === undefined
        ? await this.selectOutputDevice(targetId)
        : await this.selectOutputDevice(targetId, ctx);
    } catch (error) {
      const domName = extractDomExceptionName(error);
      const message =
        domName === 'NotAllowedError'
          ? 'Speaker selection was cancelled or denied.'
          : `Speaker selection failed: ${extractErrorMessage(error)}`;
      this.outputNotice = { tone: 'warning', message };
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: this.getActiveOutputDeviceId(ctx),
        fellBackToDefault: false,
        unsupported: false,
        message,
      };
    }
  }

  public async selectOutputDevice(
    requestedDeviceId: string,
    ctx?: AudioContext | null,
  ): Promise<OutputDeviceSwitchResult> {
    const normalizedId = normalizeAudioDeviceId(requestedDeviceId);

    // When called without an explicit context argument (standard Audio Settings UI path),
    // target `this.boundContext`. If the engine has not initialized a live context yet,
    // allow saving the preference for initial context creation WITHOUT reporting a live switch.
    if (ctx === undefined) {
      if (this.boundContext === null) {
        const setSinkSupported = supportsAudioContextSetSinkId(
          null,
          this.env.getAudioContextConstructor?.(),
        );
        if (normalizedId !== SYSTEM_DEFAULT_DEVICE_ID && !setSinkSupported) {
          const message =
            'Audio output device switching (AudioContext.setSinkId) is not supported in this browser/runtime. Audio remains routed to Default System Device.';
          this.activeOutputDeviceId = SYSTEM_DEFAULT_DEVICE_ID;
          this.outputNotice = { tone: 'warning', message };
          this.persistPreferences({ outputDeviceId: SYSTEM_DEFAULT_DEVICE_ID });
          this.emit();
          return {
            ok: false,
            liveSwitched: false,
            preferenceSaved: false,
            activeDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
            fellBackToDefault: true,
            unsupported: true,
            message,
          };
        }

        const enumeratedHardwareOutputs = this.outputDevices.filter(
          device => !device.isSystemDefault && device.deviceId !== SYSTEM_DEFAULT_DEVICE_ID,
        );
        if (
          normalizedId !== SYSTEM_DEFAULT_DEVICE_ID &&
          enumeratedHardwareOutputs.length > 0 &&
          !enumeratedHardwareOutputs.some(device => device.deviceId === normalizedId)
        ) {
          const fallbackMessage =
            'Selected audio output device is no longer connected. Audio output fell back to Default System Device.';
          this.persistPreferences({ outputDeviceId: SYSTEM_DEFAULT_DEVICE_ID });
          this.activeOutputDeviceId = SYSTEM_DEFAULT_DEVICE_ID;
          this.selectedOutputAvailable = true;
          this.outputNotice = { tone: 'warning', message: fallbackMessage };
          this.emit();
          return {
            ok: false,
            liveSwitched: false,
            preferenceSaved: false,
            activeDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
            fellBackToDefault: true,
            unsupported: false,
            message: fallbackMessage,
          };
        }

        this.persistPreferences({ outputDeviceId: normalizedId });
        this.activeOutputDeviceId = SYSTEM_DEFAULT_DEVICE_ID;
        this.selectedOutputAvailable = true;
        this.outputNotice = null;
        this.emit();
        return {
          ok: false,
          liveSwitched: false,
          preferenceSaved: true,
          activeDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
          fellBackToDefault: false,
          unsupported: false,
          message:
            'Preferred audio output device saved. It will be applied when the audio engine initializes.',
        };
      }

      return this.applyOutputDeviceToContext(this.boundContext, normalizedId, { persist: true });
    }

    return this.applyOutputDeviceToContext(ctx, normalizedId, { persist: true });
  }

  public async applyOutputDeviceToContext(
    ctx: AudioContext | null,
    requestedDeviceId: string,
    options: { persist: boolean } = { persist: true },
  ): Promise<OutputDeviceSwitchResult> {
    const normalizedId = normalizeAudioDeviceId(requestedDeviceId);
    const currentLiveCtx =
      this.boundContext && this.boundContext.state !== 'closed' ? this.boundContext : null;
    const currentActiveId = currentLiveCtx
      ? readContextSinkId(currentLiveCtx)
      : SYSTEM_DEFAULT_DEVICE_ID;

    if (!ctx) {
      const message =
        'Cannot switch live audio output: no active AudioContext is available.';
      this.outputNotice = { tone: 'warning', message };
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: currentActiveId,
        fellBackToDefault: false,
        unsupported: false,
        message,
      };
    }

    if (ctx.state === 'closed') {
      const message = 'Cannot switch live audio output on a closed AudioContext.';
      this.outputNotice = { tone: 'error', message };
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: currentActiveId,
        fellBackToDefault: false,
        unsupported: false,
        message,
      };
    }

    if (currentLiveCtx && ctx !== currentLiveCtx) {
      const message =
        'Cannot switch live audio output on a stale AudioContext that is no longer active.';
      this.outputNotice = { tone: 'error', message };
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: currentActiveId,
        fellBackToDefault: false,
        unsupported: false,
        message,
      };
    }

    // `ctx` is verified live and non-stale; keep `boundContext` aligned.
    this.boundContext = ctx;

    const setSinkSupported = supportsAudioContextSetSinkId(
      ctx,
      this.env.getAudioContextConstructor?.(),
    );

    if (normalizedId === SYSTEM_DEFAULT_DEVICE_ID) {
      if (setSinkSupported) {
        try {
          await (ctx as AudioContextWithSinkId).setSinkId?.(SYSTEM_DEFAULT_DEVICE_ID);
        } catch (error) {
          const actualSink = readContextSinkId(ctx);
          this.activeOutputDeviceId = actualSink;
          const message = `Failed to switch audio output to Default System Device: ${extractErrorMessage(error)}`;
          this.outputNotice = { tone: 'error', message };
          this.emit();
          return {
            ok: false,
            liveSwitched: false,
            preferenceSaved: false,
            activeDeviceId: actualSink,
            fellBackToDefault: false,
            unsupported: false,
            message,
          };
        }
        const hasReadableDefaultSink = typeof (ctx as AudioContextWithSinkId).sinkId === 'string';
        const verifiedDefaultSink = hasReadableDefaultSink
          ? readContextSinkId(ctx)
          : SYSTEM_DEFAULT_DEVICE_ID;
        if (verifiedDefaultSink !== SYSTEM_DEFAULT_DEVICE_ID) {
          const message = 'Audio engine did not switch back to Default System Device.';
          this.activeOutputDeviceId = verifiedDefaultSink;
          this.outputNotice = { tone: 'error', message };
          this.emit();
          return {
            ok: false,
            liveSwitched: false,
            preferenceSaved: false,
            activeDeviceId: verifiedDefaultSink,
            fellBackToDefault: false,
            unsupported: false,
            message,
          };
        }
      }
      this.activeOutputDeviceId = SYSTEM_DEFAULT_DEVICE_ID;
      this.selectedOutputAvailable = true;
      this.outputNotice = null;
      if (options.persist) {
        this.persistPreferences({ outputDeviceId: SYSTEM_DEFAULT_DEVICE_ID });
      }
      this.emit();
      return {
        ok: true,
        liveSwitched: true,
        preferenceSaved: Boolean(options.persist),
        activeDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
        fellBackToDefault: false,
        unsupported: false,
        message: null,
      };
    }

    if (!setSinkSupported) {
      const actualSink = readContextSinkId(ctx);
      const message =
        'Audio output device switching (AudioContext.setSinkId) is not supported in this browser/runtime. Audio remains routed to Default System Device.';
      this.activeOutputDeviceId = actualSink;
      this.outputNotice = { tone: 'warning', message };
      if (options.persist) {
        this.persistPreferences({ outputDeviceId: SYSTEM_DEFAULT_DEVICE_ID });
      }
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: actualSink,
        fellBackToDefault: actualSink === SYSTEM_DEFAULT_DEVICE_ID,
        unsupported: true,
        message,
      };
    }

    const enumeratedHardwareOutputs = this.outputDevices.filter(
      device => !device.isSystemDefault && device.deviceId !== SYSTEM_DEFAULT_DEVICE_ID,
    );
    if (
      enumeratedHardwareOutputs.length > 0 &&
      !enumeratedHardwareOutputs.some(device => device.deviceId === normalizedId)
    ) {
      const fallbackMessage =
        'Selected audio output device is no longer connected. Audio output fell back to Default System Device.';
      await this.fallBackOutputToSystemDefault(fallbackMessage, { keepPreferenceForReconnect: false });
      const actualAfterFallback = readContextSinkId(ctx);
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: actualAfterFallback,
        fellBackToDefault: actualAfterFallback === SYSTEM_DEFAULT_DEVICE_ID,
        unsupported: false,
        message: fallbackMessage,
      };
    }

    try {
      await (ctx as AudioContextWithSinkId).setSinkId?.(normalizedId);
      const rawSink = (ctx as AudioContextWithSinkId).sinkId;
      const verifiedSink =
        typeof rawSink === 'string' ? normalizeAudioDeviceId(rawSink) : normalizedId;

      if (verifiedSink !== normalizedId) {
        const mismatchMessage =
          'Audio engine did not switch to the requested output device. Routed audio back to Default System Device.';
        await this.fallBackOutputToSystemDefault(mismatchMessage, { keepPreferenceForReconnect: false });
        const actualSinkAfterFallback = readContextSinkId(ctx);
        this.emit();
        return {
          ok: false,
          liveSwitched: false,
          preferenceSaved: false,
          activeDeviceId: actualSinkAfterFallback,
          fellBackToDefault: actualSinkAfterFallback === SYSTEM_DEFAULT_DEVICE_ID,
          unsupported: false,
          message: mismatchMessage,
        };
      }

      this.activeOutputDeviceId = verifiedSink;
      this.selectedOutputAvailable = true;
      this.knownHardwareOutputIds.add(verifiedSink);
      this.outputNotice = null;
      if (options.persist) {
        this.persistPreferences({ outputDeviceId: verifiedSink });
      }
      this.emit();
      return {
        ok: true,
        liveSwitched: true,
        preferenceSaved: Boolean(options.persist),
        activeDeviceId: verifiedSink,
        fellBackToDefault: false,
        unsupported: false,
        message: null,
      };
    } catch (error) {
      const domName = extractDomExceptionName(error);
      const detail =
        domName === 'NotFoundError'
          ? 'the device is disconnected or unavailable'
          : domName === 'NotAllowedError'
            ? 'speaker selection permission was denied'
            : extractErrorMessage(error);
      const fallbackMessage = `Could not route audio output to the selected device (${detail}). Audio output fell back to Default System Device.`;
      await this.fallBackOutputToSystemDefault(fallbackMessage, { keepPreferenceForReconnect: false });
      const actualSinkAfterFallback = readContextSinkId(ctx);
      this.emit();
      return {
        ok: false,
        liveSwitched: false,
        preferenceSaved: false,
        activeDeviceId: actualSinkAfterFallback,
        fellBackToDefault: actualSinkAfterFallback === SYSTEM_DEFAULT_DEVICE_ID,
        unsupported: false,
        message: fallbackMessage,
      };
    }
  }

  public selectInputDevice(requestedDeviceId: string): {
    ok: boolean;
    selectedDeviceId: string;
    available: boolean;
    message: string | null;
  } {
    const normalizedId = normalizeAudioDeviceId(requestedDeviceId);
    if (normalizedId === SYSTEM_DEFAULT_DEVICE_ID) {
      this.persistPreferences({ inputDeviceId: SYSTEM_DEFAULT_DEVICE_ID });
      this.selectedInputAvailable = true;
      this.inputNotice = null;
      this.emit();
      return {
        ok: true,
        selectedDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
        available: true,
        message: null,
      };
    }

    const enumeratedHardwareInputs = this.inputDevices.filter(
      device => !device.isSystemDefault && device.deviceId !== SYSTEM_DEFAULT_DEVICE_ID,
    );
    const existsInEnumerated =
      enumeratedHardwareInputs.length === 0 ||
      enumeratedHardwareInputs.some(device => device.deviceId === normalizedId);

    if (!existsInEnumerated) {
      const message =
        'Selected audio input device is no longer available. Refresh devices or choose Default System Device.';
      this.inputNotice = { tone: 'error', message };
      this.emit();
      return {
        ok: false,
        selectedDeviceId: this.preferences.inputDeviceId,
        available: this.selectedInputAvailable,
        message,
      };
    }

    this.persistPreferences({ inputDeviceId: normalizedId });
    this.knownHardwareInputIds.add(normalizedId);
    this.selectedInputAvailable = true;
    this.inputNotice = null;
    this.emit();
    return {
      ok: true,
      selectedDeviceId: normalizedId,
      available: true,
      message: null,
    };
  }

  public updateEnginePreferences(patch: {
    sampleRate?: RequestedSampleRate;
    latencyHint?: AudioLatencyPreference;
  }): AudioPreferences {
    const nextPatch: Partial<AudioPreferences> = {};
    if (patch.sampleRate !== undefined) {
      nextPatch.sampleRate = normalizeRequestedSampleRate(patch.sampleRate);
    }
    if (patch.latencyHint !== undefined) {
      nextPatch.latencyHint = normalizeAudioLatencyPreference(patch.latencyHint);
    }
    this.persistPreferences(nextPatch);
    this.emit();
    return this.getPreferences();
  }

  public resetToDefaults(): AudioPreferences {
    const saved = resetAudioPreferences(this.env.storage);
    this.preferences = saved.preferences;
    this.storageAvailable = saved.persisted;
    this.selectedOutputAvailable = true;
    this.selectedInputAvailable = true;
    this.outputNotice = null;
    this.inputNotice = null;
    this.emit();
    return this.getPreferences();
  }

  public buildRecordingConstraints(overrideDeviceId?: string): MediaStreamConstraints {
    const targetDeviceId =
      overrideDeviceId !== undefined
        ? normalizeAudioDeviceId(overrideDeviceId)
        : this.preferences.inputDeviceId;
    return {
      audio: buildMicrophoneAudioTrackConstraints(targetDeviceId),
    };
  }

  public translateAndRecordCaptureFailure(
    error: unknown,
    attemptedDeviceId?: string,
  ): Error {
    const targetId =
      attemptedDeviceId !== undefined
        ? normalizeAudioDeviceId(attemptedDeviceId)
        : this.preferences.inputDeviceId;
    const domName = extractDomExceptionName(error);

    let message: string;
    if (domName === 'NotAllowedError' || domName === 'PermissionDeniedError' || domName === 'SecurityError') {
      this.microphonePermission = 'denied';
      message =
        'Microphone permission denied. Grant microphone access in Audio Settings or browser privacy settings before recording.';
    } else if (
      (domName === 'OverconstrainedError' || domName === 'ConstraintNotSatisfiedError' || domName === 'NotFoundError' || domName === 'DevicesNotFoundError') &&
      targetId !== SYSTEM_DEFAULT_DEVICE_ID
    ) {
      this.selectedInputAvailable = false;
      message =
        'Selected audio input device is unavailable or disconnected. Reconnect the device or switch Input Device to Default System Device in Audio Settings.';
    } else if (domName === 'NotFoundError' || domName === 'DevicesNotFoundError') {
      message = 'No audio input device was found. Connect a microphone or audio interface to record.';
    } else if (domName === 'NotReadableError' || domName === 'TrackStartError') {
      message =
        'Audio input device could not start capture (it may be in exclusive use by another application or hardware faulted).';
    } else {
      message = error instanceof Error ? error.message : `Audio input capture failed: ${extractErrorMessage(error)}`;
    }

    this.inputNotice = { tone: 'error', message };
    this.emit();
    return new Error(message);
  }

  public notifyInputCaptureSucceeded(stream?: MediaStream | null): void {
    if (this.microphonePermission !== 'granted') {
      this.microphonePermission = 'granted';
    }
    this.selectedInputAvailable = true;
    if (this.inputNotice?.tone === 'error') {
      this.inputNotice = null;
    }
    if (stream && this.inputDevices.some(device => !device.labelRevealed)) {
      void this.refreshDevices();
    } else {
      this.emit();
    }
  }

  /**
   * Monitors an active capture `MediaStream` for unexpected hardware disconnect
   * or OS stream revocation (`MediaStreamTrack` `'ended'` event).
   * Call the returned `detach()` function BEFORE stopping tracks normally so
   * intentional stop/cancel never triggers an unexpected-disconnect error.
   */
  public monitorActiveCaptureStream(
    stream: MediaStream,
    onUnexpectedStreamEnd: (error: Error) => void,
  ): () => void {
    const tracks: MediaStreamTrack[] =
      typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length > 0
        ? stream.getAudioTracks()
        : typeof stream.getTracks === 'function'
          ? stream.getTracks()
          : [];

    if (tracks.length === 0) {
      return () => {};
    }

    let detached = false;
    const handleTrackEnded = () => {
      if (detached) return;
      detached = true;
      detachListeners();
      const message =
        'Audio input stream ended unexpectedly (the microphone or audio interface was disconnected or revoked).';
      this.inputNotice = { tone: 'error', message };
      this.emit();
      void this.refreshDevices({ fromHotPlug: true });
      onUnexpectedStreamEnd(new Error(message));
    };

    const detachListeners = () => {
      for (const track of tracks) {
        if (typeof track.removeEventListener === 'function') {
          track.removeEventListener('ended', handleTrackEnded);
        } else if ('onended' in track && track.onended === handleTrackEnded) {
          track.onended = null;
        }
      }
    };

    for (const track of tracks) {
      if (typeof track.addEventListener === 'function') {
        track.addEventListener('ended', handleTrackEnded);
      } else if ('onended' in track) {
        track.onended = handleTrackEnded;
      }
    }

    return () => {
      if (detached) return;
      detached = true;
      detachListeners();
    };
  }

  public clearNotices(): void {
    this.outputNotice = null;
    this.inputNotice = null;
    this.emit();
  }

  public notifyExternalStateChange(): void {
    this.emit();
  }
}

export const audioDeviceManager = new AudioDeviceManager();

const activeRecordingTokens = new Set<symbol>();

export const registerActiveRecordingSession = (): (() => void) => {
  const token = Symbol('active-recording-session');
  activeRecordingTokens.add(token);
  audioDeviceManager.notifyExternalStateChange();
  return () => {
    activeRecordingTokens.delete(token);
    audioDeviceManager.notifyExternalStateChange();
  };
};

export const hasActiveRecordingSession = (): boolean => activeRecordingTokens.size > 0;

