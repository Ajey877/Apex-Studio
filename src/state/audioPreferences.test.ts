import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIO_PREFERENCES_STORAGE_KEY,
  DEFAULT_AUDIO_PREFERENCES,
  type StorageLike,
  areAudioPreferencesEqual,
  loadAudioPreferences,
  normalizeAudioDeviceId,
  normalizeAudioLatencyPreference,
  normalizeAudioPreferences,
  normalizeRequestedSampleRate,
  readAudioPreferences,
  resetAudioPreferences,
  saveAudioPreferences,
} from './audioPreferences';
import { createDefaultProjectState } from './projectState';
import { createHistory } from './projectHistory';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

test('normalizeAudioPreferences validates sample rates, latency hints, and device IDs strictly', () => {
  assert.deepEqual(normalizeAudioPreferences(null), DEFAULT_AUDIO_PREFERENCES);
  assert.deepEqual(normalizeAudioPreferences('invalid'), DEFAULT_AUDIO_PREFERENCES);

  for (const rate of [44100, 48000, 88200, 96000] as const) {
    assert.equal(normalizeRequestedSampleRate(rate), rate);
    assert.equal(normalizeRequestedSampleRate(String(rate)), rate);
  }
  for (const invalidRate of [8000, 22050, 192000, -48000, NaN, Infinity, {}, []]) {
    assert.equal(normalizeRequestedSampleRate(invalidRate), 'default');
  }

  for (const hint of ['interactive', 'balanced', 'playback'] as const) {
    assert.equal(normalizeAudioLatencyPreference(hint), hint);
  }
  for (const invalidHint of ['low', 'asio', 256, null, undefined]) {
    assert.equal(normalizeAudioLatencyPreference(invalidHint), 'interactive');
  }

  assert.equal(normalizeAudioDeviceId(''), '');
  assert.equal(normalizeAudioDeviceId('default'), '');
  assert.equal(normalizeAudioDeviceId('  usb-interface-01  '), 'usb-interface-01');
  assert.equal(normalizeAudioDeviceId('bad\u0000id'), '');
  assert.equal(normalizeAudioDeviceId('x'.repeat(600)), '');
});

test('saveAudioPreferences, loadAudioPreferences, and resetAudioPreferences round-trip cleanly', () => {
  const storage = new MemoryStorage();

  const initial = loadAudioPreferences(storage);
  assert.equal(initial.storageAvailable, true);
  assert.equal(initial.hadInvalidStoredData, false);
  assert.deepEqual(initial.preferences, DEFAULT_AUDIO_PREFERENCES);

  const saved = saveAudioPreferences(
    {
      outputDeviceId: 'studio-monitors-1',
      inputDeviceId: 'condenser-mic-2',
      sampleRate: 96000,
      latencyHint: 'balanced',
    },
    storage,
  );
  assert.equal(saved.persisted, true);
  assert.ok(storage.getItem(AUDIO_PREFERENCES_STORAGE_KEY));

  const reloaded = loadAudioPreferences(storage);
  assert.equal(reloaded.hadInvalidStoredData, false);
  assert.equal(
    areAudioPreferencesEqual(reloaded.preferences, {
      outputDeviceId: 'studio-monitors-1',
      inputDeviceId: 'condenser-mic-2',
      sampleRate: 96000,
      latencyHint: 'balanced',
    }),
    true,
  );

  const reset = resetAudioPreferences(storage);
  assert.equal(reset.persisted, true);
  assert.deepEqual(readAudioPreferences(storage), DEFAULT_AUDIO_PREFERENCES);
});

test('corrupted JSON and partially invalid stored fields fall back safely without throwing', () => {
  const storage = new MemoryStorage();
  storage.setItem(AUDIO_PREFERENCES_STORAGE_KEY, '{corrupted-json');

  const fromCorrupt = loadAudioPreferences(storage);
  assert.equal(fromCorrupt.storageAvailable, true);
  assert.equal(fromCorrupt.hadInvalidStoredData, true);
  assert.deepEqual(fromCorrupt.preferences, DEFAULT_AUDIO_PREFERENCES);

  storage.setItem(
    AUDIO_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      outputDeviceId: 'valid-dac',
      inputDeviceId: 42,
      sampleRate: 12345,
      latencyHint: 'ultra-low',
    }),
  );
  const fromPartial = loadAudioPreferences(storage);
  assert.equal(fromPartial.hadInvalidStoredData, true);
  assert.deepEqual(fromPartial.preferences, {
    outputDeviceId: 'valid-dac',
    inputDeviceId: '',
    sampleRate: 'default',
    latencyHint: 'interactive',
  });
});

test('unavailable or throwing localStorage (privacy/sandbox restrictions) degrades gracefully', () => {
  const missingResult = loadAudioPreferences(null);
  assert.equal(missingResult.storageAvailable, false);
  assert.deepEqual(missingResult.preferences, DEFAULT_AUDIO_PREFERENCES);

  const throwingStorage: StorageLike = {
    getItem() {
      throw new Error('SecurityError: storage disabled');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };

  const blockedLoad = loadAudioPreferences(throwingStorage);
  assert.equal(blockedLoad.storageAvailable, false);
  assert.deepEqual(blockedLoad.preferences, DEFAULT_AUDIO_PREFERENCES);

  const blockedSave = saveAudioPreferences(
    { sampleRate: 48000, latencyHint: 'playback' },
    throwingStorage,
  );
  assert.equal(blockedSave.persisted, false);
  assert.equal(blockedSave.preferences.sampleRate, 48000);
  assert.equal(blockedSave.preferences.latencyHint, 'playback');
});

test('audio preferences remain strictly isolated from ProjectState and project Undo/Redo history', () => {
  const storage = new MemoryStorage();
  const project = createDefaultProjectState();
  const projectSnapshotBefore = JSON.stringify(project);
  const history = createHistory(project);

  saveAudioPreferences(
    {
      outputDeviceId: 'external-dac',
      inputDeviceId: 'usb-mic',
      sampleRate: 88200,
      latencyHint: 'playback',
    },
    storage,
  );

  assert.equal(JSON.stringify(project), projectSnapshotBefore);
  assert.equal(history.canUndo, false);
  assert.equal('audioPreferences' in (project as unknown as Record<string, unknown>), false);
  assert.equal('outputDeviceId' in (project.meta as unknown as Record<string, unknown>), false);
  assert.equal('inputDeviceId' in (project.meta as unknown as Record<string, unknown>), false);
});
