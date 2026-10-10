/**
 * Phase 48 — audio clip publication invariant.
 *
 * Confirmed P1 defect this suite locks down: two production UI paths could
 * publish `type: 'audio'` playlist clips with no `audioBufferId`.
 *
 *   - `PlaylistArranger` clip-type picker -> "Audio Stem" -> placeholder clip
 *   - `TakeCompingModal.handlePromoteToPlaylist()` -> fabricated comp clip
 *
 * Downstream, every consumer treats `audioBufferId` as mandatory for an audio
 * clip: `playAudioClipWithFades()` returns silently without a buffer, the
 * Phase 8C missing-audio surfaces only fire on `audioUnavailable === true`,
 * and `renderTimelineOffline()` throws. The result was a clip that looked
 * healthy, played nothing, blocked WAV/stem export for the whole project, and
 * survived save/reload.
 *
 * Coverage here:
 *   1. the pure invariant itself
 *   2. the publication decision App uses before touching state/history
 *   3. legacy recovery for projects that already contain such a clip
 *   4. producer regression: the two invalid producers are gone and the three
 *      legitimate audio insertion paths still supply an audioBufferId
 *   5. publication wiring: App gates both entry points and reports through the
 *      existing save-error surface
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PlaylistClip } from '../types/daw';
import {
  describeRejectedPlaylistAudioClips,
  isPublishablePlaylistClip,
  markAudioClipsMissingBufferId,
  partitionUnpublishableAudioClips,
  resolvePlaylistClipPublication,
} from './playlistClipIntegrity';
import { normalizeProjectState } from './projectState';
import { collectMissingAudioAssets, isPlaylistClipAudioUnavailable } from './audioAssetAvailability';

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const audioClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-audio-1',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#00ff88',
  name: 'Audio Take',
  audioBufferId: 'real-buffer-id',
  ...overrides,
});

const patternClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-pattern-1',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  channelId: 'ch-1',
  color: '#ff6e00',
  name: 'Kick Pattern',
  ...overrides,
});

const automationClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-auto-1',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'automation',
  color: '#00e5ff',
  name: 'Auto: Cutoff',
  automationTarget: { type: 'channel_filter_cutoff', targetId: 'ch-1', label: 'Cutoff' },
  automationPoints: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }],
  ...overrides,
});

const baseProject = (playlistClips: PlaylistClip[]) => ({
  meta: {
    id: 'proj-phase48',
    name: 'Phase 48',
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

// ---------------------------------------------------------------------------
// 1. The invariant
// ---------------------------------------------------------------------------

test('Phase 48 invariant: audio clip without audioBufferId is rejected', () => {
  const clip = audioClip();
  delete (clip as { audioBufferId?: string }).audioBufferId;
  assert.equal(isPublishablePlaylistClip(clip), false);
});

test('Phase 48 invariant: audio clip with an empty audioBufferId is rejected', () => {
  assert.equal(isPublishablePlaylistClip(audioClip({ audioBufferId: '' })), false);
});

test('Phase 48 invariant: audio clip with a whitespace-only audioBufferId is rejected', () => {
  assert.equal(isPublishablePlaylistClip(audioClip({ audioBufferId: '   ' })), false);
});

test('Phase 48 invariant: audio clip with a non-string audioBufferId is rejected', () => {
  assert.equal(
    isPublishablePlaylistClip(audioClip({ audioBufferId: 42 as unknown as string })),
    false,
  );
  assert.equal(
    isPublishablePlaylistClip(audioClip({ audioBufferId: null as unknown as string })),
    false,
  );
  assert.equal(
    isPublishablePlaylistClip(audioClip({ audioBufferId: undefined })),
    false,
  );
});

test('Phase 48 invariant: audio clip with a valid audioBufferId is accepted', () => {
  assert.equal(isPublishablePlaylistClip(audioClip({ audioBufferId: 'bounced-clip-123' })), true);
});

test('Phase 48 invariant: pattern clips are accepted with no audio requirements', () => {
  assert.equal(isPublishablePlaylistClip(patternClip()), true);
  // A pattern clip never carries an audioBufferId; that must not matter.
  const bare = patternClip();
  delete (bare as { audioBufferId?: string }).audioBufferId;
  assert.equal(isPublishablePlaylistClip(bare), true);
});

test('Phase 48 invariant: automation clips are accepted with no audio requirements', () => {
  assert.equal(isPublishablePlaylistClip(automationClip()), true);
});

test('Phase 48 invariant: an audio clip already flagged audioUnavailable is still publishable', () => {
  // A hydration-flagged clip has a real asset id whose blob could not be
  // restored. Phase 8C already surfaces it; Phase 48 must not reclassify it.
  assert.equal(
    isPublishablePlaylistClip(audioClip({ audioBufferId: 'lost-asset', audioUnavailable: true })),
    true,
  );
});

// ---------------------------------------------------------------------------
// 2. Publication decision
// ---------------------------------------------------------------------------

test('Phase 48 partition splits an incoming clip array without reordering it', () => {
  const good = audioClip({ id: 'good' });
  const bad = audioClip({ id: 'bad' });
  delete (bad as { audioBufferId?: string }).audioBufferId;
  const pattern = patternClip({ id: 'pattern' });

  const { publishable, rejected } = partitionUnpublishableAudioClips([good, bad, pattern]);

  assert.deepEqual(publishable.map(clip => clip.id), ['good', 'pattern']);
  assert.deepEqual(rejected.map(clip => clip.id), ['bad']);
  // Identity is preserved: App publishes the very same clip objects.
  assert.equal(publishable[0], good);
  assert.equal(publishable[1], pattern);
  assert.equal(rejected[0], bad);
});

test('Phase 48 publication: a fully valid update publishes exactly as before', () => {
  const current = [patternClip({ id: 'existing' })];
  const incoming = [...current, audioClip({ id: 'dropped' })];

  const decision = resolvePlaylistClipPublication(current, incoming);

  assert.deepEqual(decision.rejected, []);
  assert.equal(decision.shouldPublish, true);
  assert.equal(decision.publishable, incoming);
});

test('Phase 48 publication: an appended audioless audio clip is dropped and nothing is published', () => {
  // This is exactly what the old "Audio Stem" placeholder producer did:
  // onUpdateClips([...clips, newClip]) with newClip lacking an audioBufferId.
  const current = [patternClip({ id: 'existing' })];
  const placeholder = audioClip({ id: 'audio-clip-1', name: 'Audio Stem / Vocal' });
  delete (placeholder as { audioBufferId?: string }).audioBufferId;

  const decision = resolvePlaylistClipPublication(current, [...current, placeholder]);

  assert.deepEqual(decision.rejected.map(clip => clip.id), ['audio-clip-1']);
  assert.deepEqual(decision.publishable, current);
  assert.equal(decision.shouldPublish, false, 'a no-op remainder must not create a history entry');
});

test('Phase 48 publication: valid clips in the same batch still publish alongside a rejection', () => {
  const current = [patternClip({ id: 'existing' })];
  const dropped = audioClip({ id: 'dropped', audioBufferId: 'real-buffer' });
  const placeholder = audioClip({ id: 'placeholder' });
  delete (placeholder as { audioBufferId?: string }).audioBufferId;

  const decision = resolvePlaylistClipPublication(current, [...current, placeholder, dropped]);

  assert.deepEqual(decision.rejected.map(clip => clip.id), ['placeholder']);
  assert.deepEqual(decision.publishable.map(clip => clip.id), ['existing', 'dropped']);
  assert.equal(decision.shouldPublish, true, 'the legitimate drop must not be lost');
});

test('Phase 48 rejection message names the clip and the remedy', () => {
  const placeholder = audioClip({ id: 'audio-clip-1', name: 'Audio Stem / Vocal' });
  delete (placeholder as { audioBufferId?: string }).audioBufferId;

  const message = describeRejectedPlaylistAudioClips([placeholder]);

  assert.match(message, /Audio Stem \/ Vocal/);
  assert.match(message, /no audio asset/i);
  // Must not read as a storage failure: nothing about persistence went wrong.
  assert.doesNotMatch(message, /storage/i);
});

// ---------------------------------------------------------------------------
// 3. Legacy recovery for already-persisted invalid projects
// ---------------------------------------------------------------------------

test('Phase 48 legacy recovery: normalizeProjectState flags an audioless audio clip', () => {
  const placeholder = audioClip({ id: 'audio-clip-1', name: 'Audio Stem / Vocal' });
  delete (placeholder as { audioBufferId?: string }).audioBufferId;

  const normalized = normalizeProjectState(baseProject([patternClip(), placeholder]));
  const recovered = normalized.playlistClips.find(clip => clip.id === 'audio-clip-1');

  assert.ok(recovered, 'the clip is preserved, never deleted');
  assert.equal(recovered?.audioUnavailable, true);
  // Still no audioBufferId: nothing invents one.
  assert.equal(recovered?.audioBufferId, undefined);
});

test('Phase 48 legacy recovery: the flagged clip reaches the existing Phase 8C surfaces', () => {
  const placeholder = audioClip({ id: 'audio-clip-1', name: 'Audio Stem / Vocal' });
  delete (placeholder as { audioBufferId?: string }).audioBufferId;

  const normalized = normalizeProjectState(baseProject([patternClip(), placeholder]));
  const recovered = normalized.playlistClips.find(clip => clip.id === 'audio-clip-1')!;

  assert.equal(isPlaylistClipAudioUnavailable(recovered), true);

  const summary = collectMissingAudioAssets(normalized);
  assert.ok(summary.totalCount > 0, 'the app-wide missing-audio banner must fire');
  assert.deepEqual(summary.clips.map(clip => clip.clipId), ['audio-clip-1']);
  assert.match(summary.messages[0], /delete this clip/i);
});

test('Phase 48 legacy recovery leaves valid clips untouched and is idempotent', () => {
  const valid = audioClip({ id: 'valid', audioBufferId: 'real-buffer' });
  const pattern = patternClip({ id: 'pattern' });

  const once = normalizeProjectState(baseProject([valid, pattern]));
  assert.equal(once.playlistClips.find(clip => clip.id === 'valid')?.audioUnavailable, undefined);
  assert.equal(once.playlistClips.find(clip => clip.id === 'pattern')?.audioUnavailable, undefined);

  // Running normalization over already-normalized state must not churn identity.
  const twice = normalizeProjectState(once);
  assert.equal(twice.playlistClips.length, 2);
  assert.equal(twice.playlistClips.find(clip => clip.id === 'valid')?.audioUnavailable, undefined);
});

test('Phase 48 markAudioClipsMissingBufferId preserves identity when nothing changes', () => {
  const clips = [audioClip({ audioBufferId: 'real' }), patternClip()];
  assert.equal(markAudioClipsMissingBufferId(clips), clips);
});

// ---------------------------------------------------------------------------
// 4. Producer regression — the invalid producers are gone, the real ones stay
// ---------------------------------------------------------------------------

test('Phase 48 producer regression: PlaylistArranger no longer creates a placeholder audio clip', () => {
  const source = readSource('../components/PlaylistArranger.tsx');

  assert.doesNotMatch(source, /clipTypeToAdd\s*===\s*'audio'/);
  assert.doesNotMatch(source, /audio-clip-\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(source, /Audio Stem \/ Vocal/);
  // The toolbar option that produced it is gone too.
  assert.doesNotMatch(source, />\s*Audio Stem\s*</);
  // The clip-type picker itself survives for the two legitimate types.
  assert.match(source, /setClipTypeToAdd\('pattern'\)/);
  assert.match(source, /setClipTypeToAdd\('automation'\)/);
});

test('Phase 48 producer regression: TakeComping no longer fabricates an audio clip', () => {
  const source = readSource('../components/TakeCompingModal.tsx');

  assert.doesNotMatch(source, /comp-vocal-\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(source, /Master Comped Vocal/);
  // No fake buffer id is invented either.
  assert.doesNotMatch(source, /audioBufferId:/);
});

test('Phase 48: the three legitimate audio insertion paths still supply an audioBufferId', () => {
  const arranger = readSource('../components/PlaylistArranger.tsx');
  const recording = readSource('../audio/recordingPipeline.ts');

  // 1. Audio drag/drop
  assert.match(arranger, /const\s+dropPlacement\s*=\s*resolvePlaylistDropPlacement\(/);
  assert.match(arranger, /audioBufferId:\s*bufId,/);
  // 2. Bounce-in-place
  assert.match(arranger, /bounceChannelToAudioClip\(/);
  // 3. Recording pipeline
  assert.match(recording, /audioBufferId:\s*registration\.id,/);
});

// ---------------------------------------------------------------------------
// 5. Publication wiring in App
// ---------------------------------------------------------------------------

test('Phase 48 wiring: App gates handleUpdateClips through the publication decision', () => {
  const source = readSource('../App.tsx');

  assert.match(source, /resolvePlaylistClipPublication\(/);

  // The gate must run before the runtime publication and the history commit.
  const handleUpdateClips = source.slice(
    source.indexOf('const handleUpdateClips = ('),
    source.indexOf('// --- Phase 6D: Recording'),
  );
  assert.notEqual(handleUpdateClips.indexOf('resolvePlaylistClipPublication('), -1);

  const gateIndex = handleUpdateClips.indexOf('resolvePlaylistClipPublication(');
  const publishIndex = handleUpdateClips.indexOf('updatePlaylistProjectState(nextState)');
  const historyIndex = handleUpdateClips.indexOf("commitPlaylistHistory(nextState, 'Clip change')");
  assert.ok(gateIndex > -1 && publishIndex > -1 && historyIndex > -1);
  assert.ok(gateIndex < publishIndex, 'the invariant must be evaluated before publication');
  assert.ok(gateIndex < historyIndex, 'the invariant must be evaluated before the history commit');

  // Rejection reaches the existing save-error surface.
  assert.match(handleUpdateClips, /setSaveError\(describeRejectedPlaylistAudioClips\(/);
});

test('Phase 1M wiring: TakeCompingModal receives real project data', () => {
  const source = readSource('../App.tsx');

  // The modal now receives actual playlist clips from project state
  assert.match(source, /playlistClips=\{projectState\.playlistClips\}/);
  // And a callback to update the active take selection
  assert.match(source, /onSelectActiveTake=/);
  // The selection goes through the take manager
  assert.match(source, /selectActiveTake\(/);
  // And is persisted through history
  assert.match(source, /commitPlaylistHistory\(nextState, 'Select active take'\)/);
});
