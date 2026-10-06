/**
 * Phase 79 — ProjectState audio-consumer invariant.
 *
 * Prevents the regression where a persisted audio-affecting field sits on
 * ProjectState (or a nested audio object it owns) with no consumer in
 * src/audio/. Three concrete checks:
 *
 *   1. Legacy inert fields stripped in Phase 79
 *      (sidechain.threshold / lowFreqOnly / highPassFilterHz / gainReductionDb,
 *      unisonSpread, stereoWidth, spatialAudio) must NOT be reachable on the
 *      normalized ProjectState produced by normalizeProjectState.
 *
 *   2. Running a recursive scan of src/audio for .field references, each
 *      audio-affecting field path the registry classifies as 'consumed'
 *      must have at least one src/audio/ reference (sanity check that the
 *      registry doesn't lie).
 *
 *   3. The STRIPPED_INERT_FIELDS list is the source of truth: those names
 *      must not appear as keys on any ProjectState-owned audio type. If a
 *      future phase re-adds one of those fields, it MUST be re-categorised
 *      in PROJECT_STATE_AUDIO_FIELDS AND come with a real src/audio/
 *      consumer (which check #2 will enforce).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Channel, MixerTrack, PlaylistClip, ProjectState, SidechainSettings } from '../types/daw';
import { normalizeProjectState, createDefaultProjectState, DEFAULT_GROSS_BEAT_STATE } from './projectState';
import { PROJECT_STATE_AUDIO_FIELDS, STRIPPED_INERT_FIELDS } from './projectStateAudioConsumers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('Phase 79 stripped inert fields are absent from normalized ProjectState', () => {
  // Build a poisoned legacy project carrying every old inert field, plus
  // a clip with spatialAudio, then normalize and verify they were stripped.
  const seed = createDefaultProjectState();

  const poisoned = {
    ...seed,
    mixerTracks: seed.mixerTracks.map((t, idx) => idx === 0
      ? t
      : {
          ...t,
          stereoWidth: 1.5,
          sidechain: {
            enabled: true,
            sourceTrackId: 1,
            threshold: -22,
            amount: 0.6,
            attackMs: 6,
            releaseMs: 180,
            lowFreqOnly: true,
            highPassFilterHz: 120,
            gainReductionDb: 4.5,
          } as SidechainSettings,
        } as MixerTrack),
    channels: seed.channels.map(c => ({
      ...c,
      synthParams: { ...(c.synthParams ?? {}), unisonSpread: 0.7 } as Channel['synthParams'],
    })),
    playlistClips: [
      ...seed.playlistClips,
      {
        id: 'legacy-clip',
        type: 'audio' as const,
        channelId: seed.channels[0]?.id ?? 'ch-1',
        name: 'legacy',
        startBar: 1,
        lengthBars: 2,
        volume: 1,
        pan: 0,
        spatialAudio: {
          enabled: true, azimuthDeg: 0, elevationDeg: 0, distanceMeters: 1,
          binauralRoomSize: 'studio_dry' as const, lfeSubLevel: 0, spread: 0,
        },
      } as unknown as PlaylistClip,
    ],
  };

  const normalized = normalizeProjectState(poisoned);

  // Mixer tracks: stereoWidth and inert sidechain sub-fields must be gone.
  for (const track of normalized.mixerTracks) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(track, 'stereoWidth'),
      false,
      `Mixer track #${track.id} must not carry stereoWidth after normalization`,
    );
    if (track.sidechain) {
      for (const bad of ['threshold', 'lowFreqOnly', 'highPassFilterHz', 'gainReductionDb']) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(track.sidechain, bad),
          false,
          `sidechain on track #${track.id} must not carry ${bad} after normalization`,
        );
      }
    }
  }

  // Channels: synthParams must not carry unisonSpread.
  for (const ch of normalized.channels) {
    if (ch.synthParams) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(ch.synthParams, 'unisonSpread'),
        false,
        `Channel ${ch.id} synthParams must not carry unisonSpread after normalization`,
      );
    }
  }

  // Clips: spatialAudio must be stripped.
  for (const clip of normalized.playlistClips) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(clip, 'spatialAudio'),
      false,
      `Clip ${clip.id} must not carry spatialAudio after normalization`,
    );
  }
});

test('Default project state does not contain any stripped inert fields', () => {
  const fresh = normalizeProjectState(createDefaultProjectState());
  function walk(obj: unknown, path: string): void {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // FxSlot.params is an opaque per-effect parameter bag; the dynamics
      // compressor legitimately uses `threshold` (DynamicsCompressorNode.threshold)
      // so skip that subtree — stripped-field names are banned on audio state
      // objects (ProjectState/Channel/MixerTrack/PlaylistClip/SidechainSettings),
      // not on per-effect parameter dictionaries.
      if (k === 'params' && /\.fxSlots\[\d+\]$/.test(path)) { continue; }
      // Phase 89 adds a real mastering DSP configuration; its compressor fields (threshold, ratio, attack, release, gain) are intentionally valid project data, not stripped legacy fields.
      if (path === 'state.masteringSuiteState' || path.startsWith('state.masteringSuiteState.')) { continue; }
      assert.equal(
        STRIPPED_INERT_FIELDS.includes(k),
        false,
        `Default project has stripped field at ${path}.${k}`,
      );
      walk(v, `${path}.${k}`);
    }
  }
  walk(fresh, 'state');
});

test('normalizeProjectState accepts old project files that used stripped fields (no throw)', () => {
  const legacy = {
    ...createDefaultProjectState(),
    mixerTracks: createDefaultProjectState().mixerTracks.map(t => ({ ...t, stereoWidth: 2.0 })),
  };
  // Must not throw; must produce a state with no stereoWidth.
  const normalized = normalizeProjectState(legacy);
  for (const t of normalized.mixerTracks) {
    assert.equal('stereoWidth' in t, false);
  }
});

test('every "consumed" audio field in the registry has a reference in src/audio/ or src/state/', () => {
  // Production code lives in src/audio (DSP + engine) and src/state (the
  // project-state bridge that translates ProjectState into engine calls).
  // UI components in src/components MUST NOT be the sole consumer of an
  // audio-affecting field — that's the exact bug this invariant prevents.
  const roots = [path.join(REPO_ROOT, 'src', 'audio'), path.join(REPO_ROOT, 'src', 'state')];
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) sources.push(full);
    }
  };
  for (const r of roots) walk(r);

  const sourceBodies = new Map<string, string>();
  for (const file of sources) sourceBodies.set(file, readFileSync(file, 'utf8'));

  const fieldToConsumer = Object.entries(PROJECT_STATE_AUDIO_FIELDS)
    .filter(([, c]) => c.classification === 'consumed');

  // We require the LAST identifier of the field path appears as a
  // whole-word match in at least one production audio/state source. A
  // whole-word match catches "registry says consumed but no code reads it"
  // without pinning us to exact dotted-access syntax.
  const misses: string[] = [];
  for (const [fieldPath, entry] of fieldToConsumer) {
    const last = fieldPath.split('.').pop()!;
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`);
    const found = [...sourceBodies.values()].some(body => pattern.test(body));
    if (!found) misses.push(`${fieldPath} — no src/audio|state/ reference for "${last}" (cited consumer: ${(entry as any).consumer})`);
  }
  assert.deepEqual(misses, [], 'Registry "consumed" entries must have a matching reference in src/audio/ or src/state/');
});

test('DEFAULT_GROSS_BEAT_STATE is the canonical default (enabled=false, 16-step alternating)', () => {
  assert.equal(DEFAULT_GROSS_BEAT_STATE.enabled, false);
  assert.equal(DEFAULT_GROSS_BEAT_STATE.mix, 1.0);
  assert.equal(DEFAULT_GROSS_BEAT_STATE.gateSteps.length, 16);
});

test('ProjectState default for grossBeatState is set and matches DEFAULT_GROSS_BEAT_STATE', () => {
  const fresh = createDefaultProjectState();
  assert.ok(fresh.grossBeatState, 'fresh project must seed grossBeatState');
  assert.deepEqual(fresh.grossBeatState, {
    ...DEFAULT_GROSS_BEAT_STATE,
    gateSteps: DEFAULT_GROSS_BEAT_STATE.gateSteps.slice(),
  });
});
