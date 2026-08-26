import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocateMixerTrackIdentity,
  appendChannelWithAllocatedMixerTrackId,
  deriveNextMixerTrackId,
  findDuplicateMixerTrackIdentities,
  normalizeNextMixerTrackId
} from '../state/mixerTrackIdentity';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import type { Channel, ProjectState } from '../types/daw';

const clone = <T>(value: T): T => structuredClone(value);

const makeChannel = (project: ProjectState, name: string): Omit<Channel, 'mixerTrackId'> => {
  const source = project.channels[0];
  if (!source) throw new Error('Test project has no source channel.');
  const { mixerTrackId: _mixerTrackId, ...channel } = clone(source);
  return { ...channel, id: `${channel.id}-${name}`, name };
};

describe('Stable mixer track identity', () => {
  it('allocates 1 for an empty project', () => {
    const project = createDefaultProjectState();
    project.channels = [];
    project.mixerTracks = [];
    project.nextMixerTrackId = 1;

    assert.deepEqual(allocateMixerTrackIdentity(project), {
      mixerTrackId: 1,
      nextMixerTrackId: 2
    });
  });

  it('starts above the predefined mixer identities in a default project', () => {
    const project = createDefaultProjectState();
    assert.equal(project.nextMixerTrackId, 8);
    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 8);
  });

  it('allocates sequential unique identities', () => {
    let project = createDefaultProjectState();
    const allocated: number[] = [];

    for (let i = 0; i < 5; i += 1) {
      const allocation = allocateMixerTrackIdentity(project);
      allocated.push(allocation.mixerTrackId);
      project = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, `Seq ${i}`));
    }

    assert.deepEqual(allocated, [8, 9, 10, 11, 12]);
    assert.equal(new Set(allocated).size, allocated.length);
  });

  it('keeps repeated allocations unique', () => {
    let project = createDefaultProjectState();
    const ids: number[] = [];

    for (let i = 0; i < 20; i += 1) {
      project = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, `Repeated ${i}`));
      ids.push(project.channels.at(-1)!.mixerTrackId);
    }

    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => i + 8));
  });

  it('does not intentionally reuse a deleted highest identity', () => {
    let project = createDefaultProjectState();
    project = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, 'Highest'));
    const deletedId = project.channels.at(-1)!.mixerTrackId;
    project = { ...project, channels: project.channels.slice(0, -1) };

    const allocation = allocateMixerTrackIdentity(project);
    assert.equal(deletedId, 8);
    assert.equal(allocation.mixerTrackId, 9);
  });

  it('does not intentionally reuse a deleted middle identity', () => {
    let project = createDefaultProjectState();
    project = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, 'A'));
    project = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, 'B'));
    project = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, 'C'));
    project = { ...project, channels: project.channels.filter(ch => ch.mixerTrackId !== 9) };

    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 11);
  });

  it('handles non-sequential existing identities', () => {
    const project = createDefaultProjectState();
    project.channels = project.channels.map((channel, index) => ({
      ...channel,
      mixerTrackId: index === 0 ? 20 : 40
    }));
    project.nextMixerTrackId = 1;

    assert.equal(deriveNextMixerTrackId(project), 41);
    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 41);
  });

  it('handles high existing identities', () => {
    const project = createDefaultProjectState();
    project.channels[0].mixerTrackId = 1000;
    project.nextMixerTrackId = 1;

    assert.equal(deriveNextMixerTrackId(project), 1001);
    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 1001);
  });

  it('skips a channel identity collision', () => {
    const project = createDefaultProjectState();
    project.nextMixerTrackId = 8;
    project.channels.push({ ...makeChannel(project, 'Collision'), mixerTrackId: 8 });

    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 9);
  });

  it('skips a mixer-track identity collision', () => {
    const project = createDefaultProjectState();
    project.nextMixerTrackId = 8;
    project.mixerTracks.push({ ...project.mixerTracks[1], id: 8 });

    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 9);
  });

  it('skips collisions across channels and mixer tracks', () => {
    const project = createDefaultProjectState();
    project.nextMixerTrackId = 8;
    project.channels.push({ ...makeChannel(project, 'Collision A'), mixerTrackId: 8 });
    project.mixerTracks.push({ ...project.mixerTracks[1], id: 9 });

    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 10);
  });

  it('normalizes a legacy project without nextMixerTrackId', () => {
    const legacy = JSON.parse(JSON.stringify(createDefaultProjectState()));
    delete legacy.nextMixerTrackId;
    legacy.channels[0].mixerTrackId = 42;

    const normalized = normalizeProjectState(legacy);
    assert.equal(normalized.nextMixerTrackId, 43);
    assert.equal(normalized.channels[0].mixerTrackId, 42);
  });

  it('normalizes invalid persisted high-water marks', () => {
    const source = createDefaultProjectState();
    for (const value of [0, -1, 1.5, NaN, '8', null]) {
      const legacy = JSON.parse(JSON.stringify(source));
      legacy.nextMixerTrackId = value;
      const normalized = normalizeProjectState(legacy);
      assert.equal(normalized.nextMixerTrackId, 8);
    }
  });

  it('advances a persisted high-water mark below occupied identities', () => {
    const project = createDefaultProjectState();
    assert.equal(normalizeNextMixerTrackId(project, 3), 8);
  });

  it('advances a persisted high-water mark that collides with an occupied identity', () => {
    const project = createDefaultProjectState();
    project.channels.push({ ...makeChannel(project, 'Occupied 8'), mixerTrackId: 8 });
    assert.equal(normalizeNextMixerTrackId(project, 8), 9);
  });

  it('never allocates Master identity 0', () => {
    const project = createDefaultProjectState();
    project.channels = [];
    project.mixerTracks = [{ ...project.mixerTracks[0], id: 0 }];
    project.nextMixerTrackId = 0;

    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 1);
  });

  it('preserves legacy identities while detecting duplicates', () => {
    const legacy = JSON.parse(JSON.stringify(createDefaultProjectState()));
    legacy.channels[0].mixerTrackId = 42;
    legacy.channels[1].mixerTrackId = 42;
    delete legacy.nextMixerTrackId;

    const duplicateIds = findDuplicateMixerTrackIdentities(normalizeProjectState(legacy));
    assert.deepEqual(duplicateIds, [1, 2, 42]);
    const normalized = normalizeProjectState(legacy);
    assert.equal(normalized.channels[0].mixerTrackId, 42);
    assert.equal(normalized.channels[1].mixerTrackId, 42);
  });

  it('persists the high-water mark across save and reload', () => {
    let project = createDefaultProjectState();
    project = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, 'Before Save'));
    assert.equal(project.channels.at(-1)!.mixerTrackId, 8);
    assert.equal(project.nextMixerTrackId, 9);

    const reloaded = normalizeProjectState(JSON.parse(JSON.stringify(project)));
    const next = appendChannelWithAllocatedMixerTrackId(reloaded, makeChannel(reloaded, 'After Reload'));

    assert.equal(next.channels.at(-1)!.mixerTrackId, 9);
    assert.equal(next.nextMixerTrackId, 10);
  });

  it('uses the same allocator behavior for normal and sample-style channel creation', () => {
    let project = createDefaultProjectState();
    const normal = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, 'Normal'));
    project = normal;
    const sample = appendChannelWithAllocatedMixerTrackId(project, {
      ...makeChannel(project, 'Sample'),
      instrumentType: 'sampler',
      customSample: undefined
    });

    assert.equal(normal.channels.at(-1)!.mixerTrackId, 8);
    assert.equal(sample.channels.at(-1)!.mixerTrackId, 9);
    assert.equal(sample.nextMixerTrackId, 10);
  });
});
