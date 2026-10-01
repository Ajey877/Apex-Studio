/**
 * Phase 49 — legacy audioless audio clips must survive playlist publication.
 *
 * Phase 48 deliberately kept two behaviours that turned out to contradict each
 * other at the publication gate:
 *
 *   1. a newly introduced `type: 'audio'` clip without a real `audioBufferId`
 *      must never reach project state (`isPublishablePlaylistClip`), and
 *   2. an already-persisted audioless clip must be preserved by hydration and
 *      only flagged `audioUnavailable` (`markAudioClipsMissingBufferId`).
 *
 * The gate only implemented rule 1, so it treated the retained legacy clip as a
 * fresh violation. The next unrelated playlist edit sent the whole clip array
 * through `App.handleUpdateClips`, the legacy clip was filtered out of the
 * publishable list, project state was updated without it, an ordinary
 * "Clip change" was committed to history, and autosave persisted the deletion.
 * The refusal message was wrong as well: it claimed the clip "was not added to
 * the playlist" even though the clip had been in the playlist for a long time
 * and had in fact just been deleted.
 *
 * Phase 49 splits the decision three ways:
 *
 *   valid                                  -> published, exactly as before
 *   unpublishable + absent from current    -> refused (Phase 48 invariant intact)
 *   unpublishable + already present        -> retained, never deleted
 *
 * "Already present" means the live playlist already contains an unpublishable
 * audio clip with that id — the legacy clip hydration preserved. A clip that
 * merely claims an existing *valid* clip's id is still refused, so Phase 48's
 * invariant is not weakened by this distinction.
 *
 * These tests are pure/decision level. The real `App.handleUpdateClips`
 * publication boundary is covered in `playlistAudioPublication.test.ts`.
 *
 * `App.tsx` is deliberately untouched (Phase 49 scope): the existing refusal
 * surface keeps Phase 48's wording for genuinely refused clips, while retained
 * clips are reported by the decision's `retained` result and described by
 * `describeRetainedPlaylistAudioClips()` instead of being called refused.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlaylistClip, ProjectState } from '../types/daw';
import {
  describeRejectedPlaylistAudioClips,
  describeRetainedPlaylistAudioClips,
  isPublishablePlaylistClip,
  markAudioClipsMissingBufferId,
  partitionUnpublishableAudioClips,
  resolvePlaylistClipPublication,
} from './playlistClipIntegrity';
import { normalizeProjectState } from './projectState';
import { collectMissingAudioAssets, isPlaylistClipAudioUnavailable } from './audioAssetAvailability';
import { assertAudioClipsExportable, isAudioClipExportable } from '../audio/offlineProjectRenderer';
import { isPureAdditivePlaylistClipAppend } from './playlistAudioPublication';

const LEGACY_ID = 'legacy-audio-clip';
const PATTERN_A = 'pattern-a';
const PATTERN_B = 'pattern-b';
const NEW_AUDIOLESS = 'new-audioless-audio';

const patternClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: PATTERN_A,
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  channelId: 'ch-1',
  color: '#ff6e00',
  name: 'Kick Pattern',
  ...overrides,
});

/** The exact audioless clip shape an older build could persist. */
const audiolessAudioClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => {
  const clip: PlaylistClip = {
    id: NEW_AUDIOLESS,
    trackIndex: 1,
    startBar: 4,
    lengthBars: 4,
    type: 'audio',
    color: '#00ff88',
    name: 'Audio Stem / Vocal',
    audioWaveform: [0.1, 0.4, 0.8, 0.6],
    ...overrides,
  };
  delete (clip as { audioBufferId?: string }).audioBufferId;
  return clip;
};

const validAudioClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'valid-audio-clip',
  trackIndex: 1,
  startBar: 4,
  lengthBars: 4,
  type: 'audio',
  audioBufferId: 'real-buffer-id',
  color: '#00ff88',
  name: 'Dropped Take',
  ...overrides,
});

const baseProject = (playlistClips: PlaylistClip[]) => ({
  meta: {
    id: 'proj-phase49',
    name: 'Phase 49',
    author: 'Audit',
    bpm: 128,
    timeSignature: [4, 4] as [number, number],
    swing: 0,
    masterVolume: 1,
    masterPitch: 0,
    created: 1,
    updated: 1,
    version: '1',
  },
  patterns: [{ id: 'pat-1', name: 'Pattern 1', color: '#ff6e00', lengthSteps: 16 }],
  channels: [{
    id: 'ch-1',
    name: 'Kick',
    color: '#ff6e00',
    instrumentType: 'drumpad' as const,
    mixerTrackId: 1,
    volume: 0.9,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: Array(16).fill(false),
    notes: [],
    synthParams: {},
  }],
  playlistClips,
  recordings: [],
});

/**
 * The legacy fixture is produced by the real hydration path rather than being
 * hand-written, so every test below starts from exactly the state
 * `normalizeProjectState` leaves behind for an already-persisted audioless clip.
 */
const hydratedLegacyProject = (): ProjectState =>
  normalizeProjectState(baseProject([
    audiolessAudioClip({ id: LEGACY_ID, name: 'Legacy Vocal Take' }),
    patternClip({ id: PATTERN_A }),
  ]));

// ---------------------------------------------------------------------------
// Fixture — Phase 48 hydration behaviour this suite builds on
// ---------------------------------------------------------------------------

test('Phase 49 fixture: hydration retains the legacy audioless clip and flags it', () => {
  const project = hydratedLegacyProject();
  const legacy = project.playlistClips[0]!;

  assert.deepEqual(project.playlistClips.map(clip => clip.id), [LEGACY_ID, PATTERN_A]);
  assert.equal(legacy.audioBufferId, undefined, 'no buffer id may be invented by hydration');
  assert.equal(legacy.audioUnavailable, true, 'the Phase 8C flag is required');
  assert.equal(isPlaylistClipAudioUnavailable(legacy), true);
  assert.equal(isPublishablePlaylistClip(legacy), false);
  // Already in its steady state: a second hydration pass changes nothing.
  assert.equal(markAudioClipsMissingBufferId(project.playlistClips), project.playlistClips);
});

// ---------------------------------------------------------------------------
// Test 1 — the legacy clip survives an additive edit
// ---------------------------------------------------------------------------

test('Phase 49 test 1: an additive edit keeps the legacy clip, in order, unflagged and unsynthesised', () => {
  const project = hydratedLegacyProject();
  const current = project.playlistClips;
  const legacy = current[0]!;
  const added = patternClip({ id: PATTERN_B, startBar: 8, name: 'Snare Pattern' });

  const decision = resolvePlaylistClipPublication(current, [...current, added]);

  assert.deepEqual(
    decision.publishable.map(clip => clip.id),
    [LEGACY_ID, PATTERN_A, PATTERN_B],
    'the legacy clip must survive in its original position',
  );
  assert.equal(decision.publishable[0], legacy, 'the retained clip must be the live clip object');
  assert.equal(decision.publishable[2], added, 'the new pattern clip must still be published');
  assert.equal(decision.publishable[0]!.audioBufferId, undefined, 'no audioBufferId may be invented');
  assert.equal(decision.publishable[0]!.audioUnavailable, true, 'audioUnavailable must remain true');
  assert.deepEqual(decision.retained.map(clip => clip.id), [LEGACY_ID], 'it is retained, not refused');
  assert.deepEqual(decision.rejected, [], 'an already-present legacy clip is never a refusal');
});

test('Phase 49 test 1: the retained legacy clip keeps blocking export and stays visible', () => {
  const project = hydratedLegacyProject();
  const current = project.playlistClips;
  const legacy = current[0]!;
  const decision = resolvePlaylistClipPublication(current, [
    ...current,
    patternClip({ id: PATTERN_B, startBar: 8 }),
  ]);

  assert.equal(isAudioClipExportable(legacy, () => undefined), false);
  assert.equal(isAudioClipExportable(decision.publishable[0]!, () => undefined), false);
  assert.throws(
    () => assertAudioClipsExportable(decision.publishable, () => undefined),
    /Legacy Vocal Take/,
    'a legacy audioless clip must keep blocking WAV and stem export',
  );

  const summary = collectMissingAudioAssets({ ...project, playlistClips: decision.publishable });
  assert.deepEqual(
    summary.clips.map(clip => clip.clipId),
    [LEGACY_ID],
    'the Phase 8C missing-audio surfaces must keep describing the retained clip',
  );
  assert.ok(summary.totalCount > 0);
});

// ---------------------------------------------------------------------------
// Test 2 — the legacy clip survives a pure move of another clip
// ---------------------------------------------------------------------------

test('Phase 49 test 2: moving another clip keeps the legacy clip in place', () => {
  const project = normalizeProjectState(baseProject([
    audiolessAudioClip({ id: LEGACY_ID, name: 'Legacy Vocal Take' }),
    patternClip({ id: PATTERN_A }),
    patternClip({ id: PATTERN_B, startBar: 0, name: 'Snare Pattern' }),
  ]));
  const current = project.playlistClips;
  const legacy = current[0]!;

  const incoming = current.map(clip =>
    clip.id === PATTERN_B ? { ...clip, startBar: 8, trackIndex: 2 } : clip,
  );

  const decision = resolvePlaylistClipPublication(current, incoming);

  assert.deepEqual(
    decision.publishable.map(clip => clip.id),
    [LEGACY_ID, PATTERN_A, PATTERN_B],
    'order must be preserved',
  );
  assert.equal(decision.publishable[0], legacy, 'the untouched legacy clip is passed through by identity');
  assert.equal(decision.publishable[2]!.startBar, 8, 'the unrelated edit must still land');
  assert.equal(decision.publishable[2]!.trackIndex, 2);
  assert.equal(legacy.audioBufferId, undefined);
  assert.equal(legacy.audioUnavailable, true);
  assert.deepEqual(decision.retained.map(clip => clip.id), [LEGACY_ID]);
  assert.deepEqual(decision.rejected, []);
  assert.equal(decision.shouldPublish, true, 'a real move is still a real publication');
});

test("Phase 49 test 2: an edit of the legacy clip itself is retained rather than deleting it", () => {
  const project = hydratedLegacyProject();
  const current = project.playlistClips;
  const legacy = current[0]!;
  // The arranger rebuilds the clip object it edits, so identity alone cannot be
  // used to decide whether a clip is already present.
  const edited = { ...legacy, startBar: 8 };

  const decision = resolvePlaylistClipPublication(current, [edited, current[1]!]);

  assert.deepEqual(decision.retained.map(clip => clip.id), [LEGACY_ID]);
  assert.deepEqual(decision.rejected, []);
  assert.equal(decision.publishable[0], edited, "the user's edit of the legacy clip must land");
  assert.equal(edited.audioBufferId, undefined, 'no audioBufferId may be invented');
  assert.equal(edited.audioUnavailable, true);
});

// ---------------------------------------------------------------------------
// Test 3 — newly introduced audioless audio is still refused
// ---------------------------------------------------------------------------

test('Phase 49 test 3: a newly introduced audioless audio clip is still refused', () => {
  const current = [patternClip({ id: PATTERN_A })];
  const introduced = audiolessAudioClip({ id: NEW_AUDIOLESS });

  const decision = resolvePlaylistClipPublication(current, [...current, introduced]);

  assert.deepEqual(decision.rejected.map(clip => clip.id), [NEW_AUDIOLESS]);
  assert.deepEqual(decision.publishable.map(clip => clip.id), [PATTERN_A]);
  assert.equal(decision.publishable.includes(introduced), false, 'it must never be published');
  assert.equal(decision.shouldPublish, false, 'nothing changed, so nothing may be published');
  assert.equal(isPublishablePlaylistClip(introduced), false, 'the Phase 48 predicate is unchanged');
});

test('Phase 49 test 3: an audioless clip cannot borrow an existing valid clip id to survive', () => {
  // Strictness guard: only an already-present *unpublishable* clip may be
  // retained. A fresh clip claiming a live clip's id is still a new invalid
  // audio clip and must not be able to launder itself into project state.
  const current = [patternClip({ id: PATTERN_A }), validAudioClip({ id: 'valid-audio-clip' })];
  const intruder = audiolessAudioClip({ id: 'valid-audio-clip' });

  const decision = resolvePlaylistClipPublication(current, [
    current[0]!,
    intruder,
  ]);

  assert.deepEqual(decision.rejected.map(clip => clip.id), ['valid-audio-clip']);
  assert.equal(decision.publishable.includes(intruder), false);
  assert.equal(isPublishablePlaylistClip(intruder), false);
});

// ---------------------------------------------------------------------------
// Test 4 — mixed batch
// ---------------------------------------------------------------------------

test('Phase 49 test 4: a mixed batch keeps the legacy clip, refuses the new one, publishes the valid one', () => {
  const project = hydratedLegacyProject();
  const current = project.playlistClips;
  const legacy = current[0]!;
  const introduced = audiolessAudioClip({ id: NEW_AUDIOLESS, name: 'New Broken Stem' });
  const valid = patternClip({ id: PATTERN_B, startBar: 8, name: 'Snare Pattern' });

  const decision = resolvePlaylistClipPublication(current, [...current, introduced, valid]);

  assert.deepEqual(decision.publishable.map(clip => clip.id), [LEGACY_ID, PATTERN_A, PATTERN_B]);
  assert.deepEqual(decision.rejected.map(clip => clip.id), [NEW_AUDIOLESS]);
  assert.equal(decision.publishable[0], legacy, 'the legacy clip is retained');
  assert.equal(decision.publishable.includes(introduced), false, 'the new invalid clip is refused');
  assert.equal(decision.publishable.includes(valid), true, 'the valid clip is published');
  assert.equal(decision.shouldPublish, true);
  assert.equal(decision.publishable[0]!.audioBufferId, undefined, 'no audioBufferId is fabricated');
  assert.equal(decision.publishable[0]!.audioUnavailable, true);
  assert.deepEqual(decision.retained.map(clip => clip.id), [LEGACY_ID], 'retained and refused are disjoint');
});

// ---------------------------------------------------------------------------
// Test 5 — messaging
// ---------------------------------------------------------------------------

test('Phase 49 test 5: newly refused clips keep the exact Phase 48 refusal wording', () => {
  const introduced = audiolessAudioClip({ id: NEW_AUDIOLESS, name: 'New Broken Stem' });

  const message = describeRejectedPlaylistAudioClips([introduced]);

  assert.match(message, /New Broken Stem/);
  assert.match(message, /no audio asset/);
  assert.match(message, /was not added to the playlist/);
  assert.doesNotMatch(message, /storage/i);
});

test('Phase 49 test 5: retained legacy clips get accurate wording instead of the refusal wording', () => {
  const project = hydratedLegacyProject();
  const current = project.playlistClips;
  const decision = resolvePlaylistClipPublication(current, [
    ...current,
    patternClip({ id: PATTERN_B, startBar: 8 }),
  ]);

  const message = describeRetainedPlaylistAudioClips(decision.retained);

  assert.match(message, /Legacy Vocal Take/);
  assert.match(message, /already on the playlist/, 'it was already present');
  assert.match(message, /retained/, 'it was retained');
  assert.match(message, /no audio asset/, 'it still has no audio asset');
  assert.match(message, /still blocks WAV and stem export/, 'it still blocks export');
  assert.doesNotMatch(message, /was not added to the playlist/, 'it was already there; that would be a lie');
  assert.doesNotMatch(message, /storage/i);
});

test('Phase 49 test 5: the retained wording stays accurate for several retained clips', () => {
  const clips = [
    audiolessAudioClip({ id: 'legacy-1', name: 'First Legacy Take' }),
    audiolessAudioClip({ id: 'legacy-2', name: 'Second Legacy Take' }),
  ];

  const message = describeRetainedPlaylistAudioClips(clips);

  assert.match(message, /First Legacy Take/);
  assert.match(message, /Second Legacy Take/);
  assert.match(message, /were already on the playlist and were retained/);
  assert.match(message, /they still have no audio asset and still block WAV and stem export/);
});

// ---------------------------------------------------------------------------
// Test 6 — an unchanged legacy-only batch is not a publication
// ---------------------------------------------------------------------------

test('Phase 49 test 6: a batch that only re-sends an already-present legacy clip is a no-op', () => {
  const project = hydratedLegacyProject();
  const current = project.playlistClips;
  const legacy = current[0]!;
  const incoming = [...current];

  const decision = resolvePlaylistClipPublication(current, incoming);

  assert.deepEqual(
    decision.publishable.map(clip => clip.id),
    [LEGACY_ID, PATTERN_A],
    'nothing may be removed from the playlist',
  );
  assert.equal(decision.publishable.every((clip, index) => clip === current[index]), true);
  assert.equal(decision.publishable[0], legacy);
  assert.equal(decision.publishable, incoming, 'the unchanged payload is handed back by identity');
  assert.deepEqual(decision.retained.map(clip => clip.id), [LEGACY_ID]);
  assert.deepEqual(decision.rejected, [], 'a retained legacy clip is not a refusal');
  assert.equal(
    decision.shouldPublish,
    false,
    'an unchanged payload must not be published as if something happened',
  );
});

// ---------------------------------------------------------------------------
// Test 7 — clean batches keep the identity fast path
// ---------------------------------------------------------------------------

test('Phase 49 test 7: a clean batch is handed straight back by identity', () => {
  const current = [patternClip({ id: PATTERN_A })];
  const incoming = [...current, validAudioClip({ id: 'valid-audio-clip' })];

  const decision = resolvePlaylistClipPublication(current, incoming);

  assert.equal(decision.publishable, incoming, 'the additive-import machinery depends on this identity');
  assert.deepEqual(decision.rejected, []);
  assert.equal(decision.shouldPublish, true);
});

test('Phase 49 test 7: a payload whose only violations are retained keeps its array identity', () => {
  const project = hydratedLegacyProject();
  const current = project.playlistClips;

  const decision = resolvePlaylistClipPublication(current, current);

  assert.equal(decision.publishable, current, 'retention must not rebuild the array');
  // The additive classifier still recognises the published sequence, which is
  // what lets a sibling import merge on top of a retained legacy clip.
  assert.equal(isPureAdditivePlaylistClipAppend(current, decision.publishable), true);
});

test('Phase 49 test 7: partition of a clean batch keeps every clip and reorders nothing', () => {
  const clips = [patternClip({ id: PATTERN_A }), validAudioClip({ id: 'valid-audio-clip' })];
  const { publishable, rejected } = partitionUnpublishableAudioClips(clips);

  assert.deepEqual(publishable, clips);
  assert.equal(publishable[0], clips[0]);
  assert.equal(publishable[1], clips[1]);
  assert.deepEqual(rejected, []);
});
