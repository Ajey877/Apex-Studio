/**
 * Application-scoped audio device and engine preferences.
 *
 * Architectural boundary:
 * - Stored in browser/desktop application storage (`localStorage` when available,
 *   with safe in-memory fallback when storage is unavailable or blocked).
 * - Strictly separate from `ProjectState`, project undo/redo history, and
 *   project/bundle exports so hardware IDs and host-specific audio preferences
 *   never pollute portable studio projects or create undo history entries.
 */

export const AUDIO_PREFERENCES_STORAGE_KEY = 'apex:audio-preferences';
export const AUDIO_PREFERENCES_SCHEMA_VERSION = 1;

export const SYSTEM_DEFAULT_DEVICE_ID = '';

export const SUPPORTED_SAMPLE_RATES = [44100, 48000, 88200, 96000] as const;
export type SupportedNumericSampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];
export type RequestedSampleRate = 'default' | SupportedNumericSampleRate;

export const AUDIO_LATENCY_PREFERENCES = ['interactive', 'balanced', 'playback'] as const;
export type AudioLatencyPreference = (typeof AUDIO_LATENCY_PREFERENCES)[number];

export interface AudioPreferences {
  /** Preferred audio output device ID (`''` = Default System Device). */
  outputDeviceId: string;
  /** Preferred audio input device ID (`''` = Default System Device). */
  inputDeviceId: string;
  /** Requested AudioContext sample rate (`'default'` = OS/runtime default). */
  sampleRate: RequestedSampleRate;
  /** Web Audio scheduling/buffering latency preference (`AudioContextLatencyCategory`). */
  latencyHint: AudioLatencyPreference;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface AudioPreferencesLoadResult {
  preferences: AudioPreferences;
  storageAvailable: boolean;
  hadInvalidStoredData: boolean;
}

export interface AudioPreferencesSaveResult {
  preferences: AudioPreferences;
  persisted: boolean;
}

export const DEFAULT_AUDIO_PREFERENCES: Readonly<AudioPreferences> = Object.freeze({
  outputDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
  inputDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
  sampleRate: 'default',
  latencyHint: 'interactive',
});

const MAX_DEVICE_ID_LENGTH = 512;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

export const isSupportedNumericSampleRate = (
  value: unknown,
): value is SupportedNumericSampleRate =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  (SUPPORTED_SAMPLE_RATES as readonly number[]).includes(value);

export const normalizeRequestedSampleRate = (value: unknown): RequestedSampleRate => {
  if (value === 'default' || value === null || value === undefined || value === '') {
    return 'default';
  }
  if (isSupportedNumericSampleRate(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (isSupportedNumericSampleRate(parsed)) {
      return parsed;
    }
  }
  return DEFAULT_AUDIO_PREFERENCES.sampleRate;
};

export const isAudioLatencyPreference = (
  value: unknown,
): value is AudioLatencyPreference =>
  typeof value === 'string' &&
  (AUDIO_LATENCY_PREFERENCES as readonly string[]).includes(value);

export const normalizeAudioLatencyPreference = (value: unknown): AudioLatencyPreference =>
  isAudioLatencyPreference(value) ? value : DEFAULT_AUDIO_PREFERENCES.latencyHint;

/**
 * Normalizes a persisted or user-supplied Web Media/Web Audio device identifier.
 * Both `''` and `'default'` map to the canonical `SYSTEM_DEFAULT_DEVICE_ID` (`''`)
 * so `AudioContext.setSinkId('')` and `getUserMedia` default selection agree.
 */
export const normalizeAudioDeviceId = (value: unknown): string => {
  if (typeof value !== 'string') return SYSTEM_DEFAULT_DEVICE_ID;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed === 'default' ||
    trimmed.length > MAX_DEVICE_ID_LENGTH ||
    CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    return SYSTEM_DEFAULT_DEVICE_ID;
  }
  return trimmed;
};

export const normalizeAudioPreferences = (raw: unknown): AudioPreferences => {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
  const record = raw as Record<string, unknown>;
  return {
    outputDeviceId: normalizeAudioDeviceId(record.outputDeviceId),
    inputDeviceId: normalizeAudioDeviceId(record.inputDeviceId),
    sampleRate: normalizeRequestedSampleRate(record.sampleRate),
    latencyHint: normalizeAudioLatencyPreference(record.latencyHint),
  };
};

export const areAudioPreferencesEqual = (
  a: AudioPreferences,
  b: AudioPreferences,
): boolean =>
  a.outputDeviceId === b.outputDeviceId &&
  a.inputDeviceId === b.inputDeviceId &&
  a.sampleRate === b.sampleRate &&
  a.latencyHint === b.latencyHint;

const resolveDefaultStorage = (): StorageLike | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

export const loadAudioPreferences = (
  storage: StorageLike | null | undefined = undefined,
): AudioPreferencesLoadResult => {
  const target = storage === undefined ? resolveDefaultStorage() : storage;
  if (!target) {
    return {
      preferences: { ...DEFAULT_AUDIO_PREFERENCES },
      storageAvailable: false,
      hadInvalidStoredData: false,
    };
  }

  let rawText: string | null = null;
  try {
    rawText = target.getItem(AUDIO_PREFERENCES_STORAGE_KEY);
  } catch {
    return {
      preferences: { ...DEFAULT_AUDIO_PREFERENCES },
      storageAvailable: false,
      hadInvalidStoredData: false,
    };
  }

  if (rawText === null) {
    return {
      preferences: { ...DEFAULT_AUDIO_PREFERENCES },
      storageAvailable: true,
      hadInvalidStoredData: false,
    };
  }

  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        preferences: { ...DEFAULT_AUDIO_PREFERENCES },
        storageAvailable: true,
        hadInvalidStoredData: true,
      };
    }
    const record = parsed as Record<string, unknown>;
    const normalized = normalizeAudioPreferences(record);
    const hadInvalidSampleRate =
      record.sampleRate !== undefined &&
      record.sampleRate !== normalized.sampleRate &&
      !(record.sampleRate === null && normalized.sampleRate === 'default');
    const hadInvalidLatency =
      record.latencyHint !== undefined && record.latencyHint !== normalized.latencyHint;
    const hadInvalidOutput =
      record.outputDeviceId !== undefined &&
      typeof record.outputDeviceId !== 'string';
    const hadInvalidInput =
      record.inputDeviceId !== undefined &&
      typeof record.inputDeviceId !== 'string';

    return {
      preferences: normalized,
      storageAvailable: true,
      hadInvalidStoredData:
        hadInvalidSampleRate || hadInvalidLatency || hadInvalidOutput || hadInvalidInput,
    };
  } catch {
    return {
      preferences: { ...DEFAULT_AUDIO_PREFERENCES },
      storageAvailable: true,
      hadInvalidStoredData: true,
    };
  }
};

export const readAudioPreferences = (
  storage: StorageLike | null | undefined = undefined,
): AudioPreferences => loadAudioPreferences(storage).preferences;

export const saveAudioPreferences = (
  preferences: Partial<AudioPreferences> | AudioPreferences,
  storage: StorageLike | null | undefined = undefined,
): AudioPreferencesSaveResult => {
  const normalized = normalizeAudioPreferences({
    ...DEFAULT_AUDIO_PREFERENCES,
    ...preferences,
  });
  const target = storage === undefined ? resolveDefaultStorage() : storage;
  if (!target) {
    return { preferences: normalized, persisted: false };
  }
  try {
    const payload = JSON.stringify({
      version: AUDIO_PREFERENCES_SCHEMA_KEY_VERSION,
      ...normalized,
    });
    target.setItem(AUDIO_PREFERENCES_STORAGE_KEY, payload);
    return { preferences: normalized, persisted: true };
  } catch {
    return { preferences: normalized, persisted: false };
  }
};

const AUDIO_PREFERENCES_SCHEMA_KEY_VERSION = AUDIO_PREFERENCES_SCHEMA_VERSION;

export const resetAudioPreferences = (
  storage: StorageLike | null | undefined = undefined,
): AudioPreferencesSaveResult => {
  const target = storage === undefined ? resolveDefaultStorage() : storage;
  if (target?.removeItem) {
    try {
      target.removeItem(AUDIO_PREFERENCES_STORAGE_KEY);
    } catch {
      // Ignore blocked storage removal and overwrite/fallback cleanly below.
    }
  }
  return saveAudioPreferences(DEFAULT_AUDIO_PREFERENCES, target);
};
