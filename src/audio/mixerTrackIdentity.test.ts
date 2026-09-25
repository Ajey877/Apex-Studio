import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocateMixerTrackIdentity,
  appendChannelWithAllocatedMixerTrackId,
  deriveNextMixerTrackId,
  findDuplicateMixerTrackIdentities,
  normalizeNextMixerTrackId,
  normalizeMixerTrackIdentityIntegrity
} from '../state/mixerTrackIdentity';
import { createDefaultProjectState, deleteChannelFromProjectState, normalizeProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { serializeProjectState } from '../state/projectPersistence';
import { applyRuntimeProjectStateMutation, updateChannelInProjectState, updateMixerTrackInProjectState } from '../state/projectMutations';
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

  it('handles non-sequential existing channel identities', () => {
    const base = createDefaultProjectState();
    const project: ProjectState = {
      ...base,
      channels: [
        { ...base.channels[0], mixerTrackId: 20 },
        { ...base.channels[1], mixerTrackId: 40 }
      ],
      mixerTracks: [],
      nextMixerTrackId: 41
    };

    assert.equal(deriveNextMixerTrackId(project), 41);
    assert.equal(allocateMixerTrackIdentity(project).mixerTrackId, 41);
  });

  it('handles high existing channel identities', () => {
    const base = createDefaultProjectState();
    const project: ProjectState = {
      ...base,
      channels: [{ ...base.channels[0], mixerTrackId: 1000 }],
      mixerTracks: [],
      nextMixerTrackId: 1001
    };

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

    assert.deepEqual(findDuplicateMixerTrackIdentities(legacy), [42]);
    const normalized = normalizeProjectState(legacy);
    assert.deepEqual(findDuplicateMixerTrackIdentities(normalized), []);
    assert.equal(normalized.channels[0].mixerTrackId, 42);
    assert.equal(normalized.channels[1].mixerTrackId, 43);
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


describe('Mixer track identity lifecycle integrity', () => {
  it('creates exactly one mixer track for a newly allocated channel', () => {
    const project = createDefaultProjectState();
    const next = appendChannelWithAllocatedMixerTrackId(project, makeChannel(project, 'Created'));
    const created = next.channels.at(-1)!;

    assert.equal(next.mixerTracks.filter(track => track.id === created.mixerTrackId).length, 1);
    assert.equal(created.mixerTrackId, 8);
  });

  it('repairs a duplicate channel mixer identity without changing the original identity', () => {
    const project = createDefaultProjectState();
    const duplicate: Channel = {
      ...makeChannel(project, 'Duplicate'),
      mixerTrackId: project.channels[0].mixerTrackId
    };
    project.channels.push(duplicate);

    const normalized = normalizeMixerTrackIdentityIntegrity(project);
    const ids = normalized.channels.map(channel => channel.mixerTrackId);

    assert.equal(new Set(ids).size, ids.length);
    assert.equal(normalized.mixerTracks.filter(track => track.id === ids[0]).length, 1);
    assert.equal(normalized.mixerTracks.filter(track => track.id === ids[2]).length, 1);
  });

  it('repairs a channel referencing a missing mixer track', () => {
    const project = createDefaultProjectState();
    project.channels[0] = { ...project.channels[0], mixerTrackId: 99 };

    const normalized = normalizeProjectState(project);
    const repairedId = normalized.channels[0].mixerTrackId;

    assert.equal(repairedId, 99);
    assert.equal(normalized.mixerTracks.filter(track => track.id === repairedId).length, 1);
  });

  it('deduplicates duplicate mixer-track records and preserves channel identities', () => {
    const project = createDefaultProjectState();
    project.mixerTracks.push({ ...project.mixerTracks[1], name: 'Duplicate Record' });

    const normalized = normalizeProjectState(project);
    assert.equal(normalized.mixerTracks.filter(track => track.id === 1).length, 1);
    assert.deepEqual(normalized.channels.map(channel => channel.mixerTrackId), [1, 2]);
  });

  it('preserves mixer identity and routing when a track record is replaced', () => {
    const project = createDefaultProjectState();
    project.mixerTracks = project.mixerTracks.map(track => (
      track.id === 1 ? { ...track, name: 'Replaced Track', routingTargetId: 2 } : track
    ));

    const replaced = normalizeProjectState(project);
    const track = replaced.mixerTracks.find(candidate => candidate.id === 1)!;

    assert.equal(track.name, 'Replaced Track');
    assert.equal(track.routingTargetId, 2);
    assert.equal(replaced.channels.find(channel => channel.id === 'ch-1')!.mixerTrackId, 1);
    assert.equal(replaced.mixerTracks.filter(candidate => candidate.id === 1).length, 1);
  });

  it('preserves routing through reorder and save/load normalization', () => {
    const project = createDefaultProjectState();
    project.mixerTracks.find(track => track.id === 1)!.routingTargetId = 2;
    project.mixerTracks = [...project.mixerTracks].reverse();

    const reloaded = normalizeProjectState(JSON.parse(JSON.stringify(project)));
    assert.equal(reloaded.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
    assert.deepEqual(reloaded.channels.map(channel => channel.mixerTrackId), [1, 2]);
  });
});


describe('Phase 30 runtime mixer identity enforcement', () => {
  const assertIdentityInvariant = (project: ProjectState) => {
    const channelIds = project.channels.map(channel => channel.mixerTrackId);
    assert.equal(new Set(channelIds).size, channelIds.length);
    for (const id of channelIds) {
      assert.equal(project.mixerTracks.filter(track => track.id === id).length, 1);
    }
  };

  it('rejects an arbitrary duplicate mixerTrackId at the runtime mutation boundary', () => {
    const project = createDefaultProjectState();
    const target = project.channels[1].mixerTrackId;
    const next = applyRuntimeProjectStateMutation(project, current =>
      updateChannelInProjectState(current, current.channels[1].id, { mixerTrackId: current.channels[0].mixerTrackId })
    );

    assert.notEqual(next.channels[1].mixerTrackId, project.channels[0].mixerTrackId);
    assert.equal(next.channels[1].mixerTrackId, target);
    assertIdentityInvariant(next);
  });

  it('atomically materializes a valid new mixer identity when a runtime identity change is requested', () => {
    const project = createDefaultProjectState();
    const nextId = 99;
    const next = applyRuntimeProjectStateMutation(project, current =>
      updateChannelInProjectState(current, current.channels[0].id, { mixerTrackId: nextId })
    );
    const mixerTrack = next.mixerTracks.find(track => track.id === nextId);

    assert.equal(next.channels[0].mixerTrackId, nextId);
    assert.ok(mixerTrack);
    assert.equal(mixerTrack!.routingTargetId, 0);
    assertIdentityInvariant(next);
  });

  it('creation -> runtime mutation -> undo/redo preserves mixer identity integrity', () => {
    const initial = createDefaultProjectState();
    const created = appendChannelWithAllocatedMixerTrackId(initial, makeChannel(initial, 'Runtime'));
    const edited = applyRuntimeProjectStateMutation(created, current =>
      updateChannelInProjectState(current, current.channels.at(-1)!.id, { volume: 0.4 })
    );
    let history = createHistory(initial).commit(created, 'Create channel').commit(edited, 'Edit channel');

    assertIdentityInvariant(history.present);
    history = history.undo();
    assertIdentityInvariant(history.present);
    assert.equal(history.present.channels.at(-1)!.mixerTrackId, created.channels.at(-1)!.mixerTrackId);
    history = history.redo();
    assertIdentityInvariant(history.present);
    assert.equal(history.present.channels.at(-1)!.volume, 0.4);
  });

  it('deletion -> undo/redo preserves identity and routing repair', () => {
    const project = createDefaultProjectState();
    const routed = applyRuntimeProjectStateMutation(project, current =>
      updateMixerTrackInProjectState(current, 1, { routingTargetId: 2 })
    );
    const deleted = deleteChannelFromProjectState(routed, 'ch-2');
    let history = createHistory(routed).commit(deleted.state, 'Delete channel');

    assertIdentityInvariant(history.present);
    assert.equal(history.present.mixerTracks.find(track => track.id === 1)?.routingTargetId, 0);
    history = history.undo();
    assertIdentityInvariant(history.present);
    assert.equal(history.present.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
    history = history.redo();
    assertIdentityInvariant(history.present);
    assert.equal(history.present.mixerTracks.some(track => track.id === 2), false);
  });

  it('runtime state survives save/load normalization without changing mixer identity', () => {
    const project = createDefaultProjectState();
    const runtime = applyRuntimeProjectStateMutation(project, current =>
      updateMixerTrackInProjectState(current, 1, { routingTargetId: 2 })
    );
    const restored = normalizeProjectState(JSON.parse(serializeProjectState(runtime)).state);

    assertIdentityInvariant(restored);
    assert.deepEqual(restored.channels.map(channel => channel.mixerTrackId), runtime.channels.map(channel => channel.mixerTrackId));
    assert.equal(restored.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
  });

  it('runtime state can feed the existing live routing adapter without invalid identity references', () => {
    const project = createDefaultProjectState();
    const runtime = applyRuntimeProjectStateMutation(project, current =>
      updateMixerTrackInProjectState(current, 1, { routingTargetId: 2 })
    );
    const graph = new MixerRoutingGraph();
    for (const track of runtime.mixerTracks) graph.addTrack(track.id);
    for (const track of runtime.mixerTracks.filter(track => track.id !== 0)) {
      const result = graph.setRoute(track.id, track.routingTargetId ?? 0);
      assert.equal(result.valid, true);
    }
    assertIdentityInvariant(runtime);
  });

  it('repairs stale and invalid runtime identity mutations before publication', () => {
    const project = createDefaultProjectState();
    const next = applyRuntimeProjectStateMutation(project, current =>
      updateChannelInProjectState(current, current.channels[0].id, { mixerTrackId: -42 })
    );
    const repairedId = next.channels[0].mixerTrackId;

    assert.ok(Number.isSafeInteger(repairedId));
    assert.ok(repairedId > 0);
    assert.notEqual(repairedId, -42);
    assert.equal(next.mixerTracks.filter(track => track.id === repairedId).length, 1);
    assertIdentityInvariant(next);
  });
});
