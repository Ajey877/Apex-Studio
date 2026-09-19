/**
 * Phase 8C — P1-11 regression suite: "Missing audio invisible / startup only warns".
 *
 * Hydration already knew which persisted audio assets could not be restored, but
 * that knowledge only existed in the developer console and turned into a surprise
 * at export time. These tests lock in that:
 *
 * 1. healthy persisted audio is never marked missing,
 * 2. missing persisted audio is marked unavailable and described in user terms,
 * 3. the missing state survives save -> reload -> hydration without fabricating audio,
 * 4. only the affected clips/samples are marked in a project with mixed health,
 * 5. Phase 8B export rejection of missing audio is unchanged,
 * 6. the existing recovery paths clear the missing state,
 * 7. the UI actually consumes the semantics (playlist, sample loader, banner).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { audioEngine } from './audioEngine';
import { deletePersistedAudioClip, deletePersistedProjectState, persistAudioClip } from './audioPersistence';
import { assertAudioClipsExportable, isAudioClipExportable } from './offlineProjectRenderer';
import { hydrateProjectAudio, persistProjectState, restorePersistedProjectState } from '../state/projectPersistence';
import { createDefaultProjectState } from '../state/projectState';
import {
  MISSING_AUDIO_CLIP_BADGE_LABEL,
  MISSING_AUDIO_SAMPLE_BADGE_LABEL,
  collectMissingAudioAssets,
  describeMissingAudioAssets,
  describeMissingAudioClip,
  describeMissingAudioSample,
  getMissingAudioAssetsSignature,
  isChannelSampleAudioUnavailable,
  isPlaylistClipAudioUnavailable,
  isSampleAudioUnavailable
} from '../state/audioAssetAvailability';
import type { Channel, CustomSampleData, PlaylistClip, ProjectState } from '../types/daw';

// ---------------------------------------------------------------------------
// IndexedDB test double (same pattern as projectPersistence.test.ts)
// ---------------------------------------------------------------------------

class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private readonly store: Map<string, unknown>) {}
  objectStore(): FakeObjectStore { return new FakeObjectStore(this.store, this); }
  complete(): void { queueMicrotask(() => this.oncomplete?.()); }
}

class FakeObjectStore {
  constructor(private readonly store: Map<string, unknown>, private readonly tx: FakeTransaction) {}
  put(value: { id: string }): void { this.store.set(value.id, value); this.tx.complete(); }
  get(id: string): FakeRequest { const request = new FakeRequest(); request.result = this.store.get(id); queueMicrotask(() => request.onsuccess?.()); return request; }
  delete(id: string): void { this.store.delete(id); this.tx.complete(); }
  getAllKeys(): FakeRequest {
    const request = new FakeRequest();
    request.result = Array.from(this.store.keys());
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
}

class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>([
    ['clips', new Map()],
    ['projects', new Map()]
  ]);
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string): void { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
  transaction(name: string): FakeTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`Missing fake object store: ${name}`);
    return new FakeTransaction(store);
  }
  close(): void {}
}

const installIndexedDbMock = () => {
  const db = new FakeDb();
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const request = new FakeRequest<FakeDb>();
        request.result = db;
        queueMicrotask(() => request.onupgradeneeded?.());
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    }
  });
  return () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous });
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Records every asset the engine was asked to decode, so "fabricated audio" is detectable. */
const createTrackedEngine = () => {
  const loadedIds: string[] = [];
  return {
    loadedIds,
    engine: {
      loadAudioFile: async (_file: File | Blob, id: string) => {
        loadedIds.push(id);
        return { buffer: { duration: 1 } as AudioBuffer, peaks: [0.5], duration: 1 };
      }
    }
  };
};

const audioClip = (overrides: Partial<PlaylistClip>): PlaylistClip => ({
  id: 'clip-audio',
  trackIndex: 1,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#00ff88',
  name: 'Audio Clip',
  ...overrides
});

const sampleChannel = (id: string, sampleId: string | undefined, overrides: Partial<Channel> = {}): Channel => ({
  ...createDefaultProjectState().channels[0],
  id,
  name: `Channel ${id}`,
  customSample: sampleId
    ? {
        id: sampleId,
        name: `Sample ${sampleId}`,
        duration: 0.5,
        sampleRate: 44100,
        channels: 1,
        waveformPeaks: [0.3, 0.7, 0.2]
      }
    : undefined,
  ...overrides
});

const projectWith = (clips: PlaylistClip[], channels: Channel[] = []): ProjectState => ({
  ...createDefaultProjectState(),
  channels: channels.length > 0 ? channels : createDefaultProjectState().channels,
  playlistClips: clips,
  recordings: []
});

const persistHealthy = async (id: string, content: string) =>
  persistAudioClip(id, new Blob([content], { type: 'audio/wav' }));

// ---------------------------------------------------------------------------
// 1. Healthy audio is never marked missing
// ---------------------------------------------------------------------------

test('Phase 8C: healthy persisted audio is not marked missing after hydration', async () => {
  const restore = installIndexedDbMock();
  try {
    await persistHealthy('healthy-clip-asset', 'clip-bytes');
    await persistHealthy('healthy-sample-asset', 'sample-bytes');

    const state = projectWith(
      [audioClip({ id: 'clip-healthy', name: 'Healthy Take', audioBufferId: 'healthy-clip-asset' })],
      [sampleChannel('ch-sample', 'healthy-sample-asset')]
    );

    const { engine, loadedIds } = createTrackedEngine();
    const hydrated = await hydrateProjectAudio(state, engine);

    assert.deepEqual(loadedIds.sort(), ['healthy-clip-asset', 'healthy-sample-asset']);
    assert.deepEqual(hydrated.missingAudioIds, []);

    const clip = hydrated.state.playlistClips[0];
    assert.equal(clip.audioUnavailable, false);
    assert.equal(isPlaylistClipAudioUnavailable(clip), false);

    const channel = hydrated.state.channels.find(c => c.id === 'ch-sample')!;
    assert.equal(isSampleAudioUnavailable(channel.customSample), false);
    assert.equal(isChannelSampleAudioUnavailable(channel), false);

    const summary = collectMissingAudioAssets(hydrated.state);
    assert.equal(summary.totalCount, 0);
    assert.deepEqual(summary.clips, []);
    assert.deepEqual(summary.samples, []);
    assert.deepEqual(summary.messages, []);
    assert.equal(describeMissingAudioAssets(summary), '');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Missing audio is marked and described in user terms
// ---------------------------------------------------------------------------

test('Phase 8C: missing persisted audio is marked unavailable and described without fabricating audio', async () => {
  const restore = installIndexedDbMock();
  try {
    const state = projectWith(
      [audioClip({ id: 'clip-lost', name: 'Lost Take', audioBufferId: 'lost-asset', audioWaveform: [0.9, 0.8] })],
      [sampleChannel('ch-sample', 'lost-sample')]
    );

    const { engine, loadedIds } = createTrackedEngine();
    const hydrated = await hydrateProjectAudio(state, engine);

    // No audio was invented for the missing assets.
    assert.deepEqual(loadedIds, []);
    assert.deepEqual(hydrated.hydratedAudioIds, []);
    assert.deepEqual(hydrated.missingAudioIds.sort(), ['lost-asset', 'lost-sample']);

    const clip = hydrated.state.playlistClips[0];
    assert.equal(clip.audioUnavailable, true);
    assert.equal(isPlaylistClipAudioUnavailable(clip), true);
    // Metadata the user needs to recover the clip is preserved verbatim.
    assert.equal(clip.name, 'Lost Take');
    assert.equal(clip.audioBufferId, 'lost-asset');
    assert.deepEqual(clip.audioWaveform, [0.9, 0.8]);

    const channel = hydrated.state.channels.find(c => c.id === 'ch-sample')!;
    assert.equal(channel.customSample?.audioUnavailable, true);
    assert.equal(isSampleAudioUnavailable(channel.customSample), true);
    assert.equal(isChannelSampleAudioUnavailable(channel), true);

    const summary = collectMissingAudioAssets(hydrated.state);
    assert.equal(summary.totalCount, 2);
    assert.deepEqual(summary.clips.map(c => c.clipId), ['clip-lost']);
    assert.deepEqual(summary.samples.map(s => s.sampleId), ['lost-sample']);
    assert.equal(summary.clips[0].name, 'Lost Take');

    // The semantics the UI renders are explicit and user-readable.
    const clipDescription = describeMissingAudioClip(clip);
    assert.match(clipDescription, /Lost Take/);
    assert.match(clipDescription, /lost-asset/);
    assert.match(clipDescription, /unavailable/i);
    assert.match(clipDescription, /could not be restored/i);

    const sampleDescription = describeMissingAudioSample(channel.customSample!, channel.name);
    assert.match(sampleDescription, /lost-sample/);
    assert.match(sampleDescription, /unavailable/i);

    assert.equal(MISSING_AUDIO_CLIP_BADGE_LABEL, 'MISSING AUDIO');
    assert.equal(MISSING_AUDIO_SAMPLE_BADGE_LABEL, 'SAMPLE MISSING');

    const banner = describeMissingAudioAssets(summary);
    assert.match(banner, /2 audio assets/);
    assert.match(banner, /Lost Take/);
    assert.match(banner, /Sample lost-sample/);
    assert.match(banner, /export stays blocked/i);
    assert.deepEqual(summary.messages, [clipDescription, sampleDescription]);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 3. The missing state survives save -> reload -> hydration
// ---------------------------------------------------------------------------

test('Phase 8C: missing state survives save, reload and project hydration', async () => {
  const restore = installIndexedDbMock();
  try {
    const state = projectWith(
      [audioClip({ id: 'clip-persisted', name: 'Persisted Loss', audioBufferId: 'gone-asset' })],
      [sampleChannel('ch-sample', 'gone-sample')]
    );

    // Save the project while the assets are missing from storage.
    await persistProjectState(state);

    const { engine, loadedIds } = createTrackedEngine();
    const restored = await restorePersistedProjectState(engine, createDefaultProjectState());

    assert.equal(restored.restored, true);
    assert.deepEqual(engine && loadedIds, []);
    assert.deepEqual(restored.missingAudioIds.sort(), ['gone-asset', 'gone-sample']);

    const reloadedClip = restored.state.playlistClips[0];
    assert.equal(isPlaylistClipAudioUnavailable(reloadedClip), true);
    assert.equal(reloadedClip.audioBufferId, 'gone-asset');

    const reloadedChannel = restored.state.channels.find(c => c.id === 'ch-sample')!;
    assert.equal(isChannelSampleAudioUnavailable(reloadedChannel), true);

    const summary = collectMissingAudioAssets(restored.state);
    assert.equal(summary.totalCount, 2);
    assert.equal(describeMissingAudioAssets(summary).length > 0, true);

    // Re-hydrating the restored state is idempotent: still missing, still no audio.
    const rehydrated = await hydrateProjectAudio(restored.state, engine);
    assert.equal(isPlaylistClipAudioUnavailable(rehydrated.state.playlistClips[0]), true);
    assert.equal(isChannelSampleAudioUnavailable(rehydrated.state.channels.find(c => c.id === 'ch-sample')!), true);
    assert.deepEqual(loadedIds, []);
  } finally {
    await deletePersistedAudioClip('gone-asset').catch(() => undefined);
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Multiple clips: only the affected clip is marked
// ---------------------------------------------------------------------------

test('Phase 8C: only clips whose persisted audio is missing are marked unavailable', async () => {
  const restore = installIndexedDbMock();
  try {
    await persistHealthy('mix-asset-1', 'one');
    await persistHealthy('mix-asset-3', 'three');

    const state = projectWith([
      audioClip({ id: 'clip-1', name: 'Take One', audioBufferId: 'mix-asset-1' }),
      audioClip({ id: 'clip-2', name: 'Take Two', audioBufferId: 'mix-asset-2' }),
      audioClip({ id: 'clip-3', name: 'Take Three', audioBufferId: 'mix-asset-3' })
    ]);

    const { engine } = createTrackedEngine();
    const hydrated = await hydrateProjectAudio(state, engine);

    const flags = hydrated.state.playlistClips.map(clip => [clip.id, isPlaylistClipAudioUnavailable(clip)]);
    assert.deepEqual(flags, [
      ['clip-1', false],
      ['clip-2', true],
      ['clip-3', false]
    ]);

    const summary = collectMissingAudioAssets(hydrated.state);
    assert.equal(summary.totalCount, 1);
    assert.deepEqual(summary.clips.map(c => c.clipId), ['clip-2']);
    assert.equal(summary.clips[0].audioBufferId, 'mix-asset-2');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Phase 8B export rejection is preserved and driven by the same flag
// ---------------------------------------------------------------------------

test('Phase 8C: export still rejects audio hydration marked unavailable', async () => {
  const restore = installIndexedDbMock();
  try {
    await persistHealthy('export-asset-ok', 'ok');

    const state = projectWith([
      audioClip({ id: 'clip-ok', name: 'Exportable Take', audioBufferId: 'export-asset-ok' }),
      audioClip({ id: 'clip-gone', name: 'Export Blocker', audioBufferId: 'export-asset-gone' })
    ]);

    const { engine } = createTrackedEngine();
    const hydrated = await hydrateProjectAudio(state, engine);
    const clips = hydrated.state.playlistClips;
    const resolveBuffer = (id: string) => (id === 'export-asset-ok' ? ({ duration: 1 } as AudioBuffer) : undefined);

    assert.equal(isAudioClipExportable(clips[0], resolveBuffer), true);
    assert.equal(isAudioClipExportable(clips[1], resolveBuffer), false);

    assert.throws(
      () => assertAudioClipsExportable(clips, resolveBuffer),
      (error: Error) => {
        assert.match(error.message, /Export Blocker/);
        assert.match(error.message, /unavailable audio asset/);
        return true;
      }
    );

    // The engine path (WAV / stems / master export) rejects before rendering
    // anything, even with the healthy asset loaded in the engine registry.
    audioEngine.setSampleBuffer('export-asset-ok', { duration: 1 } as AudioBuffer);
    await assert.rejects(
      async () => {
        await audioEngine.renderTimelineOffline([], clips, [], 120, 4);
      },
      (error: Error) => {
        assert.match(error.message, /Export Blocker/);
        assert.match(error.message, /unavailable audio asset/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 6. Existing recovery paths clear the missing state
// ---------------------------------------------------------------------------

test('Phase 8C: re-importing a replacement sample clears the channel sample missing state', async () => {
  const restore = installIndexedDbMock();
  try {
    const state = projectWith([], [sampleChannel('ch-sample', 'lost-sample')]);

    const { engine } = createTrackedEngine();
    const hydrated = await hydrateProjectAudio(state, engine);
    assert.equal(isChannelSampleAudioUnavailable(hydrated.state.channels[0]), true);
    assert.equal(collectMissingAudioAssets(hydrated.state).totalCount, 1);

    // The Sample Manager's existing recovery path: import a file, then assign it
    // to the channel (App.handleUpdateChannel replaces `customSample`).
    const replacement = `sample-reimport-${Date.now()}`;
    await persistHealthy(replacement, 'replacement-bytes');
    const replacementSample: CustomSampleData = {
      id: replacement,
      name: 'Re-imported Kick',
      duration: 0.4,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [0.5]
    };
    const recovered: ProjectState = {
      ...hydrated.state,
      channels: hydrated.state.channels.map(channel =>
        channel.id === 'ch-sample' ? { ...channel, customSample: replacementSample } : channel
      )
    };

    const rehydrated = await hydrateProjectAudio(recovered, engine);
    const channel = rehydrated.state.channels[0];
    assert.equal(isChannelSampleAudioUnavailable(channel), false);
    assert.equal(isSampleAudioUnavailable(channel.customSample), false);

    const summary = collectMissingAudioAssets(rehydrated.state);
    assert.equal(summary.totalCount, 0);
    assert.equal(describeMissingAudioAssets(summary), '');
  } finally {
    restore();
  }
});

test('Phase 8C: restoring the asset under the same id clears the missing state', async () => {
  const restore = installIndexedDbMock();
  try {
    const state = projectWith([audioClip({ id: 'clip-restored', name: 'Restored Take', audioBufferId: 'restorable-asset' })]);

    const { engine } = createTrackedEngine();
    const missing = await hydrateProjectAudio(state, engine);
    assert.equal(isPlaylistClipAudioUnavailable(missing.state.playlistClips[0]), true);

    // Restoring the persisted asset (as project/manifest import does) must clear the flag.
    await persistHealthy('restorable-asset', 'restored-bytes');
    const recovered = await hydrateProjectAudio(missing.state, engine);

    assert.equal(recovered.state.playlistClips[0].audioUnavailable, false);
    assert.equal(isPlaylistClipAudioUnavailable(recovered.state.playlistClips[0]), false);
    assert.deepEqual(collectMissingAudioAssets(recovered.state).clips, []);
  } finally {
    await deletePersistedAudioClip('restorable-asset').catch(() => undefined);
    restore();
  }
});

test('Phase 8C: removing the affected clip clears the missing entry and banner signature', async () => {
  const restore = installIndexedDbMock();
  try {
    const state = projectWith([
      audioClip({ id: 'clip-keep', name: 'Keep', audioBufferId: 'keep-asset' }),
      audioClip({ id: 'clip-remove', name: 'Remove Me', audioBufferId: 'remove-asset' })
    ]);
    await persistHealthy('keep-asset', 'keep');

    const { engine } = createTrackedEngine();
    const hydrated = await hydrateProjectAudio(state, engine);
    const before = collectMissingAudioAssets(hydrated.state);
    assert.deepEqual(before.clips.map(c => c.clipId), ['clip-remove']);
    assert.equal(getMissingAudioAssetsSignature(before).includes('clip:clip-remove'), true);

    const cleaned: ProjectState = {
      ...hydrated.state,
      playlistClips: hydrated.state.playlistClips.filter(clip => clip.id !== 'clip-remove')
    };
    const after = collectMissingAudioAssets(cleaned);
    assert.equal(after.totalCount, 0);
    assert.deepEqual(after.clips, []);
    assert.equal(getMissingAudioAssetsSignature(after), '');
    assert.notEqual(getMissingAudioAssetsSignature(before), getMissingAudioAssetsSignature(after));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 7. The UI surfaces consume the semantics (no dev tools required)
// ---------------------------------------------------------------------------

test('Phase 8C: playlist, sample loader, channel rack and app banner surface missing audio', () => {
  const playlistSource = readFileSync(new URL('../components/PlaylistArranger.tsx', import.meta.url), 'utf8');
  const sampleManagerSource = readFileSync(new URL('../components/SampleManagerModal.tsx', import.meta.url), 'utf8');
  const channelRackSource = readFileSync(new URL('../components/ChannelRack.tsx', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

  // Playlist clips: visible badge, no healthy waveform, explicit description.
  assert.match(playlistSource, /isPlaylistClipAudioUnavailable/);
  assert.match(playlistSource, /MISSING_AUDIO_CLIP_BADGE_LABEL/);
  assert.match(playlistSource, /data-audio-unavailable=\{isAudioMissing \? 'true' : undefined\}/);
  assert.match(playlistSource, /describeMissingAudioClip/);
  assert.match(playlistSource, /playlist-selected-clip-missing-audio/);

  // Sample loader: unavailable indication + disabled reuse of a dead sample.
  assert.match(sampleManagerSource, /isSampleAudioUnavailable/);
  assert.match(sampleManagerSource, /MISSING_AUDIO_SAMPLE_BADGE_LABEL/);
  assert.match(sampleManagerSource, /sample-manager-missing-audio/);
  assert.match(sampleManagerSource, /disabled=\{isCurrentSampleUnavailable\}/);
  assert.match(sampleManagerSource, /describeMissingAudioSample/);

  // Channel rack: the sample button must not stay healthy-green.
  assert.match(channelRackSource, /isChannelSampleAudioUnavailable/);
  assert.match(channelRackSource, /describeMissingAudioSample/);

  // App: project-wide banner derived from the hydrated project state.
  assert.match(appSource, /collectMissingAudioAssets\(projectState\)/);
  assert.match(appSource, /id="missing-audio-banner"/);
  assert.match(appSource, /describeMissingAudioAssets\(missingAudioAssets\)/);
});
