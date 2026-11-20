import assert from 'node:assert/strict';
import test from 'node:test';
import type { Channel, ChannelFreeze, PlaylistClip, ProjectState } from '../types/daw';
import { createDefaultProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import {
  channelFreezeSourceFromProject,
  computeChannelFreezeFingerprint,
  resolveChannelFreezeStatus,
} from '../state/trackFreeze';
import { freezeChannel, unfreezeChannel, type ChannelFreezePorts } from './channelFreezeWorkflow';

const project = (): ProjectState => {
  const state = createDefaultProjectState();
  const lead: Channel = { ...state.channels[0], id: 'lead', name: 'Lead', notes: [{ id: 'n', pitch: 60, start: 0, duration: 2, velocity: 0.8 }] };
  state.channels = [lead, { ...state.channels[0], id: 'other', name: 'Other' }];
  state.patterns = [{ id: 'p', name: 'Main', lengthSteps: 16, color: '#fff' }];
  state.selectedPatternId = 'p';
  state.playlistClips = [{ id: 'c', type: 'pattern', patternId: 'p', channelId: 'lead', color: '#fff', name: 'c', trackIndex: 0, startBar: 0, lengthBars: 1 } as PlaylistClip];
  return state;
};

interface Harness {
  ports: ChannelFreezePorts;
  state: () => ProjectState;
  setState: (next: ProjectState) => void;
  log: string[];
  buffers: Map<string, unknown>;
  mutations: string[];
}

const harness = (options: {
  renderFails?: string;
  persistenceFails?: string;
  duringRender?: (h: Harness) => void;
  duringPersistence?: (h: Harness) => void;
} = {}): Harness => {
  let current = project();
  const fakeBuffer = { length: 1000 } as unknown as AudioBuffer;
  const h: Harness = {
    state: () => current,
    setState: next => { current = next; },
    log: [], buffers: new Map(), mutations: [],
    ports: {
      engine: {
        async renderChannelFreeze(channel, clips, patterns, playlistTracks, bpm) {
          h.log.push('render');
          if (options.renderFails) throw new Error(options.renderFails);
          const freeze: Omit<ChannelFreeze, 'audioBufferId'> = {
            version: 1,
            sourceFingerprint: computeChannelFreezeFingerprint(channel, {
              clips, patterns, playlistTracks, bpm, swing: current.meta.swing, meter: [4, 4],
            }),
            frozenAt: 5, sampleRate: 44100, frameCount: 1000, leadInFrames: 4410, contentSeconds: 2, tailSeconds: 8, tailDecayed: true,
          };
          options.duringRender?.(h);
          return { buffer: fakeBuffer, freeze, peak: 0.5 };
        },
        setSampleBuffer(id, buffer) { h.log.push('store'); h.buffers.set(id, buffer); },
        discardUnpublishedSampleBuffer(id, expected) {
          h.log.push('discard');
          if (h.buffers.get(id) === expected) h.buffers.delete(id);
        },
      },
      getState: () => current,
      async waitForPersistence() {
        h.log.push('persist');
        options.duringPersistence?.(h);
        if (options.persistenceFails) throw new Error(options.persistenceFails);
      },
      mutate(updater, label) {
        h.log.push('mutate');
        h.mutations.push(label);
        current = updater(current);
      },
      createBufferId: channelId => `freeze-${channelId}-fixed`,
    },
  };
  return h;
};

const leadStatus = (state: ProjectState) =>
  resolveChannelFreezeStatus(state.channels[0], channelFreezeSourceFromProject(state));

test('10H workflow: render, make durable, then attach the record in one undoable step', async () => {
  const h = harness();
  const before = h.state();
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'frozen');
  assert.deepEqual(h.log, ['render', 'store', 'persist', 'mutate']);
  assert.deepEqual(h.mutations, ['Freeze channel']);
  assert.equal(h.state().channels[0].freeze?.audioBufferId, 'freeze-lead-fixed');
  assert.equal(leadStatus(h.state()), 'frozen');
  assert.ok(h.buffers.has('freeze-lead-fixed'));
  // The source is untouched: only the record was added.
  const { freeze: _freeze, ...rest } = h.state().channels[0];
  assert.deepEqual(rest, before.channels[0]);
  assert.equal(h.state().channels[1], before.channels[1]);
  assert.equal(h.state().playlistClips, before.playlistClips);

  // One undo removes the freeze, one redo restores it.
  const history = createHistory(before).commit(h.state(), 'Freeze channel');
  assert.equal(history.undo().present.channels[0].freeze, undefined);
  assert.equal(history.undo().redo().present.channels[0].freeze?.audioBufferId, 'freeze-lead-fixed');
});

test('10H workflow: a blocked channel is rejected before any render', async () => {
  const h = harness();
  h.setState({ ...h.state(), playlistClips: [] });
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'rejected');
  assert.match((result as { reason: string }).reason, /Nothing to freeze/);
  assert.deepEqual(h.log, []);

  const gone = await freezeChannel(h.ports, 'missing');
  assert.deepEqual(gone, { status: 'rejected', reason: 'That channel no longer exists.' });
});

test('10H workflow: a failed render changes nothing', async () => {
  const h = harness({ renderFails: 'The freeze render is silent, so there is nothing to freeze.' });
  const before = h.state();
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'rejected');
  assert.match((result as { reason: string }).reason, /silent/);
  assert.equal(h.state(), before);
  assert.deepEqual(h.log, ['render']);
  assert.equal(h.buffers.size, 0);
});

test('10H workflow: a persistence failure discards the audio and leaves the channel unfrozen', async () => {
  const h = harness({ persistenceFails: 'QuotaExceededError' });
  const before = h.state();
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'rejected');
  assert.match((result as { reason: string }).reason, /could not be saved.*QuotaExceededError/);
  assert.equal(h.state(), before);
  assert.deepEqual(h.log, ['render', 'store', 'persist', 'discard']);
  assert.equal(h.buffers.size, 0);
  assert.deepEqual(h.mutations, []);
});

test('10H workflow: a source edit during the render discards it before anything is stored', async () => {
  const h = harness({
    duringRender: harnessState => harnessState.setState({
      ...harnessState.state(),
      channels: harnessState.state().channels.map(c => (c.id === 'lead' ? { ...c, volume: 0.11 } : c)),
    }),
  });
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'rejected');
  assert.match((result as { reason: string }).reason, /changed while it was being frozen/);
  assert.deepEqual(h.log, ['render']);
  assert.equal(h.state().channels[0].freeze, undefined);
  assert.equal(h.state().channels[0].volume, 0.11, 'the edit is kept');
});

test('10H workflow: a source edit while the audio is being saved discards the stored audio', async () => {
  const h = harness({
    duringPersistence: harnessState => harnessState.setState({
      ...harnessState.state(),
      playlistClips: harnessState.state().playlistClips.map(c => ({ ...c, startBar: 4 })),
    }),
  });
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'rejected');
  assert.deepEqual(h.log, ['render', 'store', 'persist', 'discard']);
  assert.equal(h.buffers.size, 0);
  assert.equal(h.state().channels[0].freeze, undefined);
});

test('10H workflow: an edit to something that stays live during the render does not reject the freeze', async () => {
  const h = harness({
    duringRender: harnessState => harnessState.setState({
      ...harnessState.state(),
      channels: harnessState.state().channels.map(c => (c.id === 'lead' ? { ...c, mute: true, mixerTrackId: 7 } : c)),
    }),
  });
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'frozen');
  assert.equal(h.state().channels[0].mute, true);
  assert.equal(h.state().channels[0].mixerTrackId, 7);
  assert.equal(leadStatus(h.state()), 'frozen');
});

test('10H workflow: the channel being deleted during the render rejects cleanly', async () => {
  const h = harness({
    duringRender: harnessState => harnessState.setState({
      ...harnessState.state(), channels: harnessState.state().channels.filter(c => c.id !== 'lead'),
    }),
  });
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'rejected');
  assert.deepEqual(h.log, ['render']);
});

test('10H workflow: Unfreeze removes only the record, in one undoable step; nothing to do is a no-op', async () => {
  const h = harness();
  const source = h.state();
  await freezeChannel(h.ports, 'lead');
  h.log.length = 0; h.mutations.length = 0;
  assert.equal(unfreezeChannel(h.ports, 'lead'), true);
  assert.deepEqual(h.mutations, ['Unfreeze channel']);
  assert.deepEqual(h.state().channels, source.channels);
  assert.equal(h.state().playlistClips, source.playlistClips);
  // The audio stays loaded: undo of the Unfreeze needs it.
  assert.ok(h.buffers.has('freeze-lead-fixed'));

  h.mutations.length = 0;
  assert.equal(unfreezeChannel(h.ports, 'lead'), false);
  assert.equal(unfreezeChannel(h.ports, 'missing'), false);
  assert.deepEqual(h.mutations, []);
});

test('10H workflow: a refreeze of a stale freeze replaces the record with a new asset', async () => {
  const h = harness();
  await freezeChannel(h.ports, 'lead');
  h.setState({ ...h.state(), channels: h.state().channels.map(c => (c.id === 'lead' ? { ...c, pan: 0.5 } : c)) });
  assert.equal(leadStatus(h.state()), 'stale');
  let counter = 0;
  h.ports.createBufferId = id => `freeze-${id}-again-${counter += 1}`;
  const result = await freezeChannel(h.ports, 'lead');
  assert.equal(result.status, 'frozen');
  assert.equal(h.state().channels[0].freeze?.audioBufferId, 'freeze-lead-again-1');
  assert.equal(leadStatus(h.state()), 'frozen');
  assert.equal(h.state().channels[0].pan, 0.5);
});
