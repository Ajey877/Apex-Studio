import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlaylistClip } from '../types/daw';
import {
  STRETCH_BEHAVIOUR_SUMMARY,
  WARP_BEHAVIOUR_SUMMARY,
  isWarpTargetReady,
  resolveWarpTarget,
  warpTargetMessage,
} from './warpClipTarget';

const clip = (over: Partial<PlaylistClip> & Pick<PlaylistClip, 'id'>): PlaylistClip => ({
  trackIndex: 0,
  startBar: 0,
  lengthBars: 1,
  type: 'audio',
  color: '#ff6e00',
  name: over.id,
  ...over,
});

const clips: PlaylistClip[] = [
  clip({ id: 'clip-a', name: 'Intro Vox', type: 'audio', pitchShiftSemitones: 0 }),
  clip({ id: 'clip-b', name: 'Chorus Vox', type: 'audio', pitchShiftSemitones: 0 }),
  clip({ id: 'clip-c', name: 'Bridge Vox', type: 'audio', pitchShiftSemitones: 0 }),
];

describe('Phase 52 — Warp clip target', () => {
  it('targets the selected clip, not the first clip in the array', () => {
    const resolution = resolveWarpTarget(clips, 'clip-c');
    assert.ok(isWarpTargetReady(resolution));
    assert.equal(resolution.clip.id, 'clip-c');

    // The defect this replaces: App passed `playlistClips[0]`, so selecting the
    // third clip would have edited the first one.
    const first = resolveWarpTarget(clips, 'clip-c');
    assert.notEqual(first.kind === 'ready' ? first.clip.id : null, clips[0].id);
  });

  it('resolves every clip in a multi-clip timeline independently', () => {
    for (const expected of clips) {
      const resolution = resolveWarpTarget(clips, expected.id);
      assert.ok(isWarpTargetReady(resolution), `${expected.id} must be actionable`);
      assert.equal(resolution.clip.id, expected.id);
    }
  });

  it('reports no-selection when no clip is selected', () => {
    const resolution = resolveWarpTarget(clips, null);
    assert.equal(resolution.kind, 'no-selection');
    assert.ok(warpTargetMessage(resolution).includes('Select an audio clip'));
  });

  it('reports a stale selection instead of falling back to another clip', () => {
    const resolution = resolveWarpTarget(clips, 'deleted-clip-id');
    assert.equal(resolution.kind, 'missing');
    assert.ok(!isWarpTargetReady(resolution));
  });

  it('refuses pattern and automation clips, which the engine does not warp', () => {
    const patternClip = clip({ id: 'clip-p', name: 'Drum Pattern', type: 'pattern' });
    const automationClip = clip({ id: 'clip-auto', name: 'Filter Sweep', type: 'automation' });

    const pattern = resolveWarpTarget([patternClip], 'clip-p');
    assert.equal(pattern.kind, 'unsupported-type');
    assert.ok(!isWarpTargetReady(pattern));
    assert.ok(warpTargetMessage(pattern).includes('audio clips only'));

    const automation = resolveWarpTarget([automationClip], 'clip-auto');
    assert.equal(automation.kind, 'unsupported-type');
  });

  it('describes the implemented behaviour without claiming time-stretching', () => {
    // The audit found the footer claimed an "Élastique 3.4.1 Resampling Kernel".
    // The summary must describe repitch only.
    assert.ok(WARP_BEHAVIOUR_SUMMARY.length > 0);
    assert.ok(/pitch and playback-rate/i.test(WARP_BEHAVIOUR_SUMMARY));
    assert.ok(!/elastique/i.test(WARP_BEHAVIOUR_SUMMARY));
    assert.ok(!/granular/i.test(WARP_BEHAVIOUR_SUMMARY));
    assert.ok(!/time-stretch/i.test(WARP_BEHAVIOUR_SUMMARY));
  });

  it('describes the shipped Phase 7A stretch truthfully (WSOLA, range, commit semantics)', () => {
    // The stretch summary must name the algorithm that is actually implemented
    // (WSOLA — proven by src/audio/wsolaTimeStretch.test.ts), state its
    // supported ratio range, and describe the render/commit asset semantics.
    // It must never claim proprietary or unimplemented technologies.
    assert.ok(STRETCH_BEHAVIOUR_SUMMARY.length > 0);
    assert.ok(/WSOLA/.test(STRETCH_BEHAVIOUR_SUMMARY), 'names the implemented algorithm');
    assert.ok(/preserving pitch/i.test(STRETCH_BEHAVIOUR_SUMMARY), 'states the pitch-preserving capability');
    assert.ok(/0\.25×–4\.00×/.test(STRETCH_BEHAVIOUR_SUMMARY), 'states the supported ratio range');
    assert.ok(/render\/commit/i.test(STRETCH_BEHAVIOUR_SUMMARY), 'states that this is a render/commit operation');
    assert.ok(/new asset/i.test(STRETCH_BEHAVIOUR_SUMMARY) && /undo/i.test(STRETCH_BEHAVIOUR_SUMMARY), 'states the asset and undo semantics');
    assert.ok(!/elastique|élastique/i.test(STRETCH_BEHAVIOUR_SUMMARY));
    assert.ok(!/granular/i.test(STRETCH_BEHAVIOUR_SUMMARY));
    assert.ok(!/formant/i.test(STRETCH_BEHAVIOUR_SUMMARY));
    assert.ok(!/transient/i.test(STRETCH_BEHAVIOUR_SUMMARY), 'no transient-preservation claim');
    assert.ok(!/real-?time/i.test(STRETCH_BEHAVIOUR_SUMMARY), 'no real-time promise');
  });
});
