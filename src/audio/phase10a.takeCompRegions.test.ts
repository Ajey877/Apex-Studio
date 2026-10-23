/**
 * Phase 10A — Phrase-level take comping: pure model.
 *
 * Everything here is model-level truth the audio engine, the exporter, project
 * normalization and the editor all read. The audible consequences of these
 * numbers are proven separately, through real Web Audio PCM
 * (`browser-tests/takeComping.spec.ts`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaylistClip, ProjectState, TakeCompRegion } from '../types/daw';
import {
  COMP_EPSILON_BARS,
  DEFAULT_COMP_CROSSFADE_BARS,
  MIN_COMP_CROSSFADE_BARS,
  MIN_COMP_REGION_BARS,
  applyCompRegionsToClips,
  createEqualPowerFadeCurve,
  createInitialCompRegions,
  equalPowerGainAt,
  findCompRegionAtBar,
  moveCompRegionStart,
  normalizeCompRegions,
  normalizeTakeCompRegionsInClips,
  removeCompRegion,
  resolveCanonicalCompRegions,
  resolveBlockingCompIssues,
  resolveTakeCompPlan,
  resolveTakeCompRegionAudibility,
  resizeCompRegionEnd,
  setCompRegionCrossfade,
  setCompRegionTake,
  splitCompRegionAtBar,
} from './takeCompRegions';
import { resolveInaudibleTakeClipIds, isTakeAudible } from './takeLaneManager';
import { createHistory } from '../state/projectHistory';
import { normalizeProjectState, createDefaultProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';

const makeClip = (overrides: Partial<PlaylistClip> & { id: string }): PlaylistClip => ({
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#00e5ff',
  name: 'Test Clip',
  audioBufferId: `buf-${overrides.id}`,
  ...overrides,
});

/** Two takes over the same 4-bar region, take 0 active. */
const groupClips = (): PlaylistClip[] => [
  makeClip({ id: 'take-a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
  makeClip({ id: 'take-b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
];

const withRegions = (regions: TakeCompRegion[]): PlaylistClip[] =>
  groupClips().map(clip => ({ ...clip, compRegions: regions }));

const region = (overrides: Partial<TakeCompRegion> & { id: string }): TakeCompRegion => ({
  startBar: 0,
  lengthBars: 1,
  takeIndex: 0,
  crossfadeBars: 0,
  ...overrides,
});

describe('Phase 10A — comp region normalization', () => {
  it('keeps valid regions, sorts them and preserves their explicit take choice', () => {
    const { regions, issues } = normalizeCompRegions([
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 1 }),
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0 }),
    ]);
    assert.deepEqual(issues, []);
    assert.deepEqual(regions.map(r => r.id), ['a', 'b']);
    assert.deepEqual(regions.map(r => r.takeIndex), [0, 1]);
  });

  it('drops unrepresentable entries instead of inventing geometry', () => {
    const { regions, issues } = normalizeCompRegions([
      null,
      { id: 'nan', startBar: Number.NaN, lengthBars: 1, takeIndex: 0, crossfadeBars: 0 },
      { id: 'zero', startBar: 0, lengthBars: 0, takeIndex: 0, crossfadeBars: 0 },
      { id: 'tiny', startBar: 0, lengthBars: MIN_COMP_REGION_BARS / 2, takeIndex: 0, crossfadeBars: 0 },
      { id: 'negative', startBar: -1, lengthBars: 1, takeIndex: 0, crossfadeBars: 0 },
      { id: 'bad-take', startBar: 0, lengthBars: 1, takeIndex: -3, crossfadeBars: 0 },
      { id: 'ok', startBar: 0, lengthBars: 1, takeIndex: 1, crossfadeBars: 0 },
    ]);
    assert.deepEqual(regions.map(r => r.id), ['ok']);
    assert.ok(issues.length >= 5, 'every dropped entry is reported');
  });

  it('drops an overlapping phrase so two takes can never claim the same instant', () => {
    const { regions, issues } = normalizeCompRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2 }),
      region({ id: 'b', startBar: 1, lengthBars: 2 }),
    ]);
    assert.deepEqual(regions.map(r => r.id), ['a']);
    assert.ok(issues.some(issue => issue.code === 'overlap'));
  });

  it('accepts a touching boundary (end === next start) as adjacent, not overlapping', () => {
    const { regions, issues } = normalizeCompRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2 }),
      region({ id: 'b', startBar: 2, lengthBars: 2 }),
    ]);
    assert.equal(regions.length, 2);
    assert.deepEqual(issues, []);
  });

  it('drops a repeated region id deterministically', () => {
    const { regions, issues } = normalizeCompRegions([
      region({ id: 'dup', startBar: 0, lengthBars: 1 }),
      region({ id: 'dup', startBar: 1, lengthBars: 1 }),
    ]);
    assert.equal(regions.length, 1);
    assert.ok(issues.some(issue => issue.code === 'duplicate-id'));
  });

  it('resets an invalid crossfade to zero instead of throwing', () => {
    const { regions, issues } = normalizeCompRegions([
      region({ id: 'a', startBar: 0, lengthBars: 1, crossfadeBars: Number.NaN }),
    ]);
    assert.equal(regions[0].crossfadeBars, 0);
    assert.ok(issues.some(issue => issue.code === 'malformed'));
  });

  it('rejects a non-list payload without throwing', () => {
    assert.deepEqual(normalizeCompRegions('nope').regions, []);
    assert.deepEqual(normalizeCompRegions(undefined).regions, []);
    assert.deepEqual(normalizeCompRegions([{}]).regions, []);
  });
});

describe('Phase 10A — equal-power crossfade law', () => {
  it('rises from silence to unity and falls back, complementary in power', () => {
    assert.ok(Math.abs(equalPowerGainAt(0, 'in')) < 1e-12);
    assert.ok(Math.abs(equalPowerGainAt(1, 'in') - 1) < 1e-12);
    assert.ok(Math.abs(equalPowerGainAt(0, 'out') - 1) < 1e-12);
    assert.ok(Math.abs(equalPowerGainAt(1, 'out')) < 1e-12);
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const power = equalPowerGainAt(t, 'in') ** 2 + equalPowerGainAt(t, 'out') ** 2;
      assert.ok(Math.abs(power - 1) < 1e-12, `sin/cos pair is constant-power at t=${t}`);
    }
  });

  it('builds a monotone curve scaled to the peak gain', () => {
    const curve = createEqualPowerFadeCurve('in', 0.5, 17);
    assert.equal(curve.length, 17);
    assert.equal(curve[0], 0);
    assert.ok(Math.abs(curve[curve.length - 1] - 0.5) < 1e-6);
    for (let i = 1; i < curve.length; i += 1) assert.ok(curve[i] >= curve[i - 1]);
    const out = createEqualPowerFadeCurve('out', 0.5, 17);
    assert.ok(Math.abs(out[0] - 0.5) < 1e-6);
    assert.ok(Math.abs(out[out.length - 1]) < 1e-6);
    for (let i = 1; i < out.length; i += 1) assert.ok(out[i] <= out[i - 1]);
  });
});

describe('Phase 10A — comp plan resolution', () => {
  it('returns null when the group has no comp regions (Phase 1M behaviour preserved)', () => {
    assert.equal(resolveTakeCompPlan({ clips: groupClips(), takeGroupId: 'g1' }), null);
    assert.equal(resolveTakeCompPlan({ clips: withRegions([]), takeGroupId: 'g1' }), null);
    assert.equal(resolveTakeCompPlan({ clips: groupClips(), takeGroupId: 'missing' }), null);
  });

  it('maps each phrase to its own take clip', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 1 }),
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 0 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    assert.ok(plan);
    assert.deepEqual(plan.segments.map(s => s.takeClipId), ['take-b', 'take-a']);
    assert.deepEqual(plan.segments.map(s => [s.startBar, s.endBar]), [[0, 2], [2, 4]]);
    assert.equal(plan.segments[0].usesClipFadeIn, true);
    assert.equal(plan.segments[1].usesClipFadeOut, true);
  });

  it('centres the equal-power crossfade on the boundary when both takes have material', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.25 }),
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 1 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    const [first, second] = plan.segments;
    assert.equal(first.fadeOutBars, 0.25);
    assert.equal(second.fadeInBars, 0.25);
    assert.ok(Math.abs(first.endBar - 2.125) < 1e-9, 'outgoing phrase extends half the blend');
    assert.ok(Math.abs(second.startBar - 1.875) < 1e-9, 'incoming phrase starts half the blend early');
    // The two fades cover exactly the same window: one real crossfade, not a gap
    // and not two full-level takes stacked.
    assert.ok(Math.abs((first.endBar - first.fadeOutBars) - second.startBar) < 1e-9);
    assert.ok(Math.abs(first.endBar - 2) - 0.125 < 1e-9);
  });

  it('bounds the crossfade by half of the shortest neighbouring phrase', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 3.5, takeIndex: 0, crossfadeBars: 3 }),
      region({ id: 'b', startBar: 3.5, lengthBars: 0.5, takeIndex: 1 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    const fade = plan.segments[0].fadeOutBars;
    assert.ok(fade <= 0.25 + 1e-9, `crossfade bounded by the shorter phrase (got ${fade})`);
    assert.ok(fade >= MIN_COMP_CROSSFADE_BARS);
  });

  it('keeps a real blend near the group start instead of reaching before bar 0', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 0.5, takeIndex: 0, crossfadeBars: 0.04 }),
      region({ id: 'b', startBar: 0.5, lengthBars: 3.5, takeIndex: 1 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    const [first, second] = plan.segments;
    assert.ok(second.startBar >= 0, 'the incoming phrase never starts before the group');
    assert.ok(Math.abs(second.startBar - 0.48) < 1e-9, 'the blend is centred on the boundary, inside the group');
    assert.ok(first.fadeOutBars > 0 && Math.abs(first.fadeOutBars - second.fadeInBars) < 1e-9);
  });

  it('bounds a blend by the outgoing tail and moves it before the boundary when there is no tail', () => {
    const clips = [
      makeClip({ id: 'take-a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0, lengthBars: 4 }),
      makeClip({ id: 'take-b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0, compRegions: [
        region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.25 }),
        region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 1 }),
      ] }),
    ];
    // Take A's material ends exactly at the boundary: no tail to fade into, so
    // the blend has to happen entirely inside the outgoing phrase's own window.
    const plan = resolveTakeCompPlan({
      clips,
      takeGroupId: 'g1',
      takeMaterial: clip => (clip.id === 'take-a'
        ? { leadInBars: 0, totalBars: 2 }
        : { leadInBars: 1, totalBars: 4 }),
    })!;
    assert.equal(plan.segments.length, 2);
    const [first, second] = plan.segments;
    assert.ok(Math.abs(first.endBar - 2) < 1e-9, 'outgoing phrase cannot extend past its material');
    assert.ok(Math.abs(second.startBar - 1.75) < 1e-9, 'incoming phrase starts inside the blend window');
    assert.ok(first.fadeOutBars > 0 && Math.abs(first.fadeOutBars - 0.25) < 1e-9);
    assert.ok(Math.abs(first.fadeOutBars - second.fadeInBars) < 1e-9);
  });

  it('never invents material: a phrase whose take has no audio for it is silent, not crossfaded', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.25 }),
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 1 }),
    ]);
    const plan = resolveTakeCompPlan({
      clips,
      takeGroupId: 'g1',
      takeMaterial: clip => (clip.id === 'take-a'
        ? { leadInBars: 0, totalBars: 2 }
        : { leadInBars: 0, totalBars: 0 }),
    })!;
    assert.equal(plan.segments.length, 1, 'the incoming phrase has no audio and is silent');
    assert.ok(plan.issues.some(issue => issue.code === 'trimmed'));
  });

  it('merges adjacent phrases that name the same take into one continuous segment', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0 }),
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.5 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    assert.equal(plan.segments.length, 1);
    assert.deepEqual(plan.segments[0].regionIds, ['a', 'b']);
    assert.equal(plan.segments[0].fadeOutBars, 0);
  });

  it('treats a gap as silence and reports it', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 1, takeIndex: 0 }),
      region({ id: 'b', startBar: 2, lengthBars: 1, takeIndex: 1 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    assert.equal(plan.segments.length, 2);
    assert.deepEqual(plan.gaps.map(gap => [gap.startBar, gap.lengthBars]), [[1, 1], [3, 1]]);
    assert.ok(Math.abs(plan.segments[1].startBar - 2) < 1e-9, 'a gap is never filled by stretching a phrase');
  });

  it('reports a missing take and keeps the other phrases playable', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0 }),
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 7 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    assert.equal(plan.segments.length, 1);
    assert.equal(plan.segments[0].takeIndex, 0);
    assert.ok(plan.issues.some(issue => issue.code === 'missing-take' && issue.regionId === 'b'));
  });

  it('reports an unrestored audio asset instead of playing the wrong take', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 4, takeIndex: 1 }),
    ]).map(clip => (clip.id === 'take-b' ? { ...clip, audioUnavailable: true } : clip));
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    assert.equal(plan.segments.length, 0);
    assert.ok(plan.issues.some(issue => issue.code === 'missing-asset'));
  });

  it('trims a phrase that runs past the end of the take group', () => {
    const clips = withRegions([region({ id: 'a', startBar: 3, lengthBars: 5, takeIndex: 0 })]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    assert.equal(plan.lengthBars, 4);
    assert.equal(plan.segments[0].endBar, 4);
    assert.ok(plan.issues.some(issue => issue.code === 'out-of-range'));
  });

  it('is deterministic and independent of clip array order', () => {
    const regions = [
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: 0.25 }),
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 1 }),
    ];
    const forward = resolveTakeCompPlan({ clips: withRegions(regions), takeGroupId: 'g1' })!;
    const reversed = resolveTakeCompPlan({ clips: [...withRegions(regions)].reverse(), takeGroupId: 'g1' })!;
    const again = resolveTakeCompPlan({ clips: withRegions(regions), takeGroupId: 'g1' })!;
    assert.deepEqual(forward.segments, again.segments);
    assert.deepEqual(forward.segments, reversed.segments);
  });

  it('keeps at most one fade pair per boundary even with three short phrases', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 1, takeIndex: 0, crossfadeBars: 0.5 }),
      region({ id: 'b', startBar: 1, lengthBars: 1, takeIndex: 1, crossfadeBars: 0.5 }),
      region({ id: 'c', startBar: 2, lengthBars: 1, takeIndex: 0 }),
    ]);
    const plan = resolveTakeCompPlan({ clips, takeGroupId: 'g1' })!;
    for (const segment of plan.segments) {
      assert.ok(segment.fadeInBars + segment.fadeOutBars <= segment.endBar - segment.startBar + 1e-9,
        'fades never exceed the segment they belong to');
    }
  });
});

describe('Phase 10A — comp-aware audibility', () => {
  it('makes every take that owns a phrase audible, and only those', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0 }),
      region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 1 }),
    ]);
    const inaudible = resolveInaudibleTakeClipIds(clips);
    assert.equal(inaudible.size, 0);
    assert.equal(isTakeAudible(clips[0], clips), true);
    assert.equal(resolveTakeCompRegionAudibility(clips).size, 0);
  });

  it('keeps a take with no phrase silent even when it is the whole-take selection', () => {
    const clips = withRegions([
      region({ id: 'a', startBar: 0, lengthBars: 4, takeIndex: 0 }),
    ]).map(clip => ({ ...clip, activeTakeIndex: 1 }));
    const inaudible = resolveInaudibleTakeClipIds(clips);
    assert.deepEqual([...inaudible], ['take-b']);
  });

  it('leaves whole-take groups on the Phase 1M rule', () => {
    const clips = groupClips();
    assert.deepEqual([...resolveInaudibleTakeClipIds(clips)], ['take-b']);
  });

  it('never silences a clip that is not in a take group', () => {
    const clips = [...groupClips(), makeClip({ id: 'plain', compRegions: [region({ id: 'x' })] })];
    assert.equal(resolveTakeCompRegionAudibility(clips).has('plain'), false);
  });
});

describe('Phase 10A — export blocking', () => {
  it('blocks a mixdown when a phrase names a take whose audio is gone', () => {
    const clips = withRegions([
      region({ id: 'r1', startBar: 0, lengthBars: 2, takeIndex: 0 }),
      region({ id: 'r2', startBar: 2, lengthBars: 2, takeIndex: 1 }),
    ]).map(clip => (clip.id === 'take-b' ? { ...clip, audioUnavailable: true } : clip));
    const blocking = resolveBlockingCompIssues(clips);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].code, 'missing-asset');
    assert.match(blocking[0].message, /unavailable/);
  });

  it('does not block on a phrase naming a take that no longer exists', () => {
    // No asset to restore: the phrase is dropped, the rest of the comp renders,
    // and the editor reports it. Export must not become impossible.
    const clips = withRegions([region({ id: 'r1', startBar: 0, lengthBars: 4, takeIndex: 9 })]);
    assert.deepEqual(resolveBlockingCompIssues(clips), []);
  });

  it('does not block on whole-take groups', () => {
    assert.deepEqual(resolveBlockingCompIssues(groupClips()), []);
  });
});

describe('Phase 10A — editing helpers', () => {
  const twoPhrases = (): TakeCompRegion[] => [
    region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 0, crossfadeBars: DEFAULT_COMP_CROSSFADE_BARS }),
    region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 1 }),
  ];

  it('splits a phrase into two that keep the same take and default crossfade', () => {
    const next = splitCompRegionAtBar(twoPhrases(), 1);
    assert.equal(next.length, 3);
    const left = next.find(r => r.startBar === 0)!;
    const right = next.find(r => r.startBar === 1 && r.id !== 'b')!;
    assert.equal(left.lengthBars, 1);
    assert.equal(right.lengthBars, 1);
    assert.equal(left.takeIndex, right.takeIndex);
    assert.equal(left.crossfadeBars, DEFAULT_COMP_CROSSFADE_BARS);
    assert.equal(next.find(r => r.id === 'b')!.takeIndex, 1);
  });

  it('refuses a split that would create an unrepresentable phrase', () => {
    const next = splitCompRegionAtBar(twoPhrases(), 0.0001);
    assert.equal(next.length, 2);
  });

  it('moves a phrase start but never into its neighbour or before the group', () => {
    const moved = moveCompRegionStart(twoPhrases(), 'b', 10);
    assert.equal(moved.find(r => r.id === 'b')!.startBar, 4 - MIN_COMP_REGION_BARS);
    const earlier = moveCompRegionStart(twoPhrases(), 'b', -5);
    assert.equal(earlier.find(r => r.id === 'b')!.startBar, 2);
  });

  it('trims a phrase end but never into the next phrase or below the minimum length', () => {
    const trimmed = resizeCompRegionEnd(twoPhrases(), 'a', 9);
    assert.equal(trimmed.find(r => r.id === 'a')!.lengthBars, 2);
    const shorter = resizeCompRegionEnd(twoPhrases(), 'a', 1.5);
    assert.equal(shorter.find(r => r.id === 'a')!.lengthBars, 1.5);
    const tiny = resizeCompRegionEnd(twoPhrases(), 'a', -1);
    assert.equal(tiny.find(r => r.id === 'a')!.lengthBars, MIN_COMP_REGION_BARS);
  });

  it('repoints a phrase at another take and removes a phrase without moving its neighbours', () => {
    const retargeted = setCompRegionTake(twoPhrases(), 'a', 1);
    assert.equal(retargeted.find(r => r.id === 'a')!.takeIndex, 1);
    const removed = removeCompRegion(twoPhrases(), 'a');
    assert.deepEqual(removed.map(r => [r.id, r.startBar]), [['b', 2]]);
  });

  it('sets the trailing crossfade and normalizes it', () => {
    assert.equal(setCompRegionCrossfade(twoPhrases(), 'a', 0.5).find(r => r.id === 'a')!.crossfadeBars, 0.5);
    assert.equal(setCompRegionCrossfade(twoPhrases(), 'a', -1).find(r => r.id === 'a')!.crossfadeBars, 0);
    assert.equal(setCompRegionCrossfade(twoPhrases(), 'a', Number.NaN).find(r => r.id === 'a')!.crossfadeBars, 0);
  });

  it('finds the region under a bar and reports a gap as no region', () => {
    const regions = [
      region({ id: 'a', startBar: 0, lengthBars: 1 }),
      region({ id: 'b', startBar: 2, lengthBars: 1 }),
    ];
    assert.equal(findCompRegionAtBar(regions, 0.5)?.id, 'a');
    assert.equal(findCompRegionAtBar(regions, 1.5), null);
    assert.equal(findCompRegionAtBar(regions, 2)?.id, 'b');
  });

  it('starts a comp from the whole-take selection, never guessing phrases', () => {
    const initial = createInitialCompRegions(groupClips(), 1);
    assert.equal(initial.length, 1);
    assert.equal(initial[0].startBar, 0);
    assert.equal(initial[0].lengthBars, 4);
    assert.equal(initial[0].takeIndex, 1);
  });
});

describe('Phase 10A — persistence and history', () => {
  const regions = (): TakeCompRegion[] => [
    region({ id: 'a', startBar: 0, lengthBars: 2, takeIndex: 1, crossfadeBars: 0.125 }),
    region({ id: 'b', startBar: 2, lengthBars: 2, takeIndex: 0, crossfadeBars: 0 }),
  ];

  it('writes the comp to every clip of the group and clears it from all of them', () => {
    const applied = applyCompRegionsToClips(groupClips(), 'g1', regions());
    assert.ok(applied.every(clip => clip.compRegions?.length === 2));
    assert.deepEqual(applied[1].compRegions, applied[0].compRegions);
    assert.ok(applied[0].compRegions !== applied[1].compRegions, 'each clip owns its copy');
    const cleared = applyCompRegionsToClips(applied, 'g1', null);
    assert.ok(cleared.every(clip => clip.compRegions === undefined));
    assert.equal(cleared[0].activeTakeIndex, 0, 'reverting a comp keeps the whole-take selection');
  });

  it('normalizes a partially written group to one canonical comp', () => {
    const partial = [
      { ...groupClips()[0], compRegions: regions() },
      groupClips()[1],
    ];
    const normalized = normalizeTakeCompRegionsInClips(partial);
    assert.ok(normalized.every(clip => clip.compRegions?.length === 2));
    assert.equal(signature(normalized[1].compRegions), signature(regions()));
  });

  it('drops comp regions from a clip that is not in a take group', () => {
    const orphan = [{ ...makeClip({ id: 'plain' }), compRegions: regions() }];
    assert.equal(normalizeTakeCompRegionsInClips(orphan)[0].compRegions, undefined);
  });

  it('survives serialize → normalize, byte for byte', () => {
    const base = createDefaultProjectState();
    const state: ProjectState = { ...base, playlistClips: withRegions(regions()) };
    const serialized = serializeProjectState(state);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed.state.playlistClips[0].compRegions, regions());
    const reloaded = normalizeProjectState(parsed.state);
    assert.deepEqual(reloaded.playlistClips[0].compRegions, regions());
    assert.deepEqual(reloaded.playlistClips[1].compRegions, regions());
  });

  it('keeps projects without comp regions on the legacy shape', () => {
    const base = createDefaultProjectState();
    const reloaded = normalizeProjectState({ ...base, playlistClips: groupClips() });
    assert.ok(reloaded.playlistClips.every(clip => clip.compRegions === undefined));
  });

  it('undo and redo restore exact regions and boundaries', () => {
    const base = createDefaultProjectState();
    const started: ProjectState = { ...base, playlistClips: applyCompRegionsToClips(groupClips(), 'g1', regions()) };
    const history = createHistory(started);
    const editedRegions = splitCompRegionAtBar(regions(), 1);
    const edited: ProjectState = {
      ...started,
      playlistClips: applyCompRegionsToClips(started.playlistClips, 'g1', editedRegions),
    };
    const committed = history.commit(edited, 'Edit take comp');
    assert.equal(committed.present.playlistClips[0].compRegions?.length, 3);
    const undone = committed.undo();
    assert.deepEqual(undone.present.playlistClips[0].compRegions, regions());
    const redone = undone.redo();
    assert.deepEqual(redone.present.playlistClips[0].compRegions, editedRegions);
  });

  it('a cleared comp is undone back to the exact assembled phrases', () => {
    const base = createDefaultProjectState();
    const comped: ProjectState = { ...base, playlistClips: applyCompRegionsToClips(groupClips(), 'g1', regions()) };
    const history = createHistory(comped);
    const reverted: ProjectState = {
      ...comped,
      playlistClips: applyCompRegionsToClips(comped.playlistClips, 'g1', null),
    };
    const afterRevert = history.commit(reverted, 'Revert take comp');
    assert.equal(afterRevert.present.playlistClips[0].compRegions, undefined);
    assert.deepEqual(afterRevert.undo().present.playlistClips[0].compRegions, regions());
  });

  it('the canonical copy is chosen deterministically, not by array order', () => {
    const a = { ...groupClips()[0], compRegions: regions() };
    const b = { ...groupClips()[1], activeTakeIndex: 1 };
    assert.deepEqual(resolveCanonicalCompRegions([a, b]).regions, regions());
    assert.deepEqual(resolveCanonicalCompRegions([b, a]).regions, regions());
  });

  it('reports overlapping persisted regions on load instead of stacking two takes', () => {
    const overlapping = [
      region({ id: 'a', startBar: 0, lengthBars: 3, takeIndex: 0 }),
      region({ id: 'b', startBar: 1, lengthBars: 3, takeIndex: 1 }),
    ];
    const plan = resolveTakeCompPlan({ clips: withRegions(overlapping), takeGroupId: 'g1' })!;
    assert.equal(plan.regions.length, 1);
    assert.equal(plan.segments.length, 1);
    assert.ok(plan.issues.some(issue => issue.code === 'overlap'));
    assert.ok(COMP_EPSILON_BARS > 0);
  });
});

const signature = (regions: readonly TakeCompRegion[] | undefined): string =>
  (regions ?? []).map(r => `${r.id}@${r.startBar}:${r.lengthBars}:${r.takeIndex}:${r.crossfadeBars}`).join('|');
