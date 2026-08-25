import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allocateStableMixerTrackId } from './mixerTrackIdentity';

describe('allocateStableMixerTrackId', () => {
  it('allocates above every existing channel and mixer identity', () => {
    const id = allocateStableMixerTrackId(
      [{ mixerTrackId: 1 }, { mixerTrackId: 7 }, { mixerTrackId: 12 }],
      [{ id: 0 }, { id: 3 }, { id: 20 }],
    );

    assert.equal(id, 21);
  });

  it('does not collide after a channel is deleted', () => {
    const channels = [{ mixerTrackId: 1 }, { mixerTrackId: 8 }, { mixerTrackId: 9 }];
    const mixerTracks = [{ id: 0 }, { id: 1 }, { id: 8 }, { id: 9 }];

    channels.splice(1, 1);
    mixerTracks.splice(2, 1);

    const nextId = allocateStableMixerTrackId(channels, mixerTracks);
    assert.equal(nextId, 10);
    assert.ok(!channels.some(channel => channel.mixerTrackId === nextId));
    assert.ok(!mixerTracks.some(track => track.id === nextId));
  });

  it('keeps legacy persisted identities intact and allocates beyond them', () => {
    const legacyChannels = [
      { mixerTrackId: 1 },
      { mixerTrackId: 1 },
      { mixerTrackId: 7 },
    ];
    const legacyMixerTracks = [{ id: 0 }, { id: 1 }, { id: 7 }];

    const nextId = allocateStableMixerTrackId(legacyChannels, legacyMixerTracks);

    assert.equal(nextId, 8);
    assert.deepEqual(legacyChannels.map(channel => channel.mixerTrackId), [1, 1, 7]);
  });

  it('ignores invalid persisted identities when selecting a new identity', () => {
    const nextId = allocateStableMixerTrackId(
      [{ mixerTrackId: -1 }, { mixerTrackId: Number.NaN }, { mixerTrackId: 4 }],
      [{ id: 2 }, { id: 6 }],
    );

    assert.equal(nextId, 7);
  });
});
