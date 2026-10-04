/**
 * Phase 64 — F4: Playlist lane bounce target.
 *
 * The lane BOUNCE button passed the playlist **lane index** straight into
 * `channels[trackIdx]`, so in the shipped factory project lane 2 bounced the
 * snare channel, lane 3 bounced the hi-hat channel and lane 4 bounced the 808 —
 * and a lane with no matching channel index fell through to `channels[0]`.
 * A lane's material is identified by its clips (`PlaylistClip.channelId`), the
 * same way playback, the stem renderer and the export path identify it.
 *
 * `resolvePlaylistBounceTarget` is the pure resolver the arranger uses, and it
 * is asserted against the real factory project so lane N can never silently
 * render channels[N].
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlaylistBounceTarget } from './playlistBounceTarget';
import { PRESET_PROJECTS } from '../audio/presets';
import type { Channel, PlaylistClip, PlaylistTrack } from '../types/daw';

const factory = PRESET_PROJECTS[0].state;
const factoryChannels = factory.channels as Channel[];
const factoryClips = factory.playlistClips as PlaylistClip[];
const factoryTracks = factory.playlistTracks as PlaylistTrack[];

const clip = (overrides: Partial<PlaylistClip> & { trackIndex: number }): PlaylistClip => ({
  id: `clip-${overrides.trackIndex}-${overrides.startBar ?? 0}`,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  color: '#fff',
  name: 'clip',
  ...overrides,
});

describe('Phase 64 F4 — lane content decides the bounce target', () => {
  it('resolves the factory project lane 2 to its hi-hat channel, not channels[1]', () => {
    const target = resolvePlaylistBounceTarget(factoryChannels, factoryClips, 1);
    assert.equal(target.status, 'ready');
    assert.equal(target.channelId, 'ch-hihat');
    assert.notEqual(target.channelId, factoryChannels[1].id);
  });

  it('resolves every populated factory lane to the channel its clips name', () => {
    // The factory project deliberately interleaves its channel list: the channel
    // order is kick, snare, hi-hat, 808, pluck while the lanes are kick, hi-hat,
    // 808, pluck. Only lane 0 happens to agree with its index.
    const expected: Record<number, string> = {
      0: 'ch-kick',
      1: 'ch-hihat',
      2: 'ch-808',
      3: 'ch-pluck',
    };
    for (const [lane, channelId] of Object.entries(expected)) {
      const target = resolvePlaylistBounceTarget(factoryChannels, factoryClips, Number(lane));
      assert.equal(target.channelId, channelId, `lane ${lane} must bounce ${channelId}`);
    }
    for (const lane of [1, 2, 3]) {
      assert.notEqual(
        resolvePlaylistBounceTarget(factoryChannels, factoryClips, lane).channelId,
        factoryChannels[lane]?.id,
        `lane ${lane} must never fall back to channels[${lane}]`,
      );
    }
  });

  it('refuses to bounce an empty lane instead of substituting channels[0]', () => {
    const target = resolvePlaylistBounceTarget(factoryChannels, factoryClips, 4);
    assert.equal(target.status, 'empty');
    assert.equal(target.channelId, null);
  });

  it('refuses a lane whose clips reference a channel that no longer exists', () => {
    const channels = factoryChannels.filter(channel => channel.id !== 'ch-hihat');
    const target = resolvePlaylistBounceTarget(channels, factoryClips, 1);
    assert.equal(target.status, 'no-channel');
    assert.equal(target.channelId, null);
  });

  it('refuses a lane that only holds audio clips with no channel', () => {
    const clips = [clip({ trackIndex: 2, type: 'audio', audioBufferId: 'buf-1' })];
    const target = resolvePlaylistBounceTarget(factoryChannels, clips, 2);
    assert.equal(target.status, 'no-channel');
    assert.equal(target.channelId, null);
  });

  it('anchors the bounce at the lane content, not at bar 1', () => {
    const clips = [
      clip({ trackIndex: 3, startBar: 8, channelId: 'ch-pluck' }),
      clip({ trackIndex: 3, startBar: 16, channelId: 'ch-pluck' }),
    ];
    const target = resolvePlaylistBounceTarget(factoryChannels, clips, 3);
    assert.equal(target.channelId, 'ch-pluck');
    assert.equal(target.startBar, 8);
  });

  it('ignores automation clips when choosing the lane target', () => {
    const clips = [
      clip({ trackIndex: 1, startBar: 0, type: 'automation', channelId: undefined }),
      clip({ trackIndex: 1, startBar: 4, channelId: 'ch-808' }),
    ];
    const target = resolvePlaylistBounceTarget(factoryChannels, clips, 1);
    assert.equal(target.channelId, 'ch-808');
  });

  it('is deterministic when one lane holds several channels', () => {
    const clips = [
      clip({ id: 'late', trackIndex: 0, startBar: 12, channelId: 'ch-808' }),
      clip({ id: 'early', trackIndex: 0, startBar: 4, channelId: 'ch-pluck' }),
    ];
    const first = resolvePlaylistBounceTarget(factoryChannels, clips, 0);
    const second = resolvePlaylistBounceTarget(factoryChannels, [...clips].reverse(), 0);
    assert.equal(first.channelId, 'ch-pluck', 'the earliest lane content wins');
    assert.equal(second.channelId, 'ch-pluck');
    assert.deepEqual(first.channelIds, ['ch-pluck', 'ch-808']);
  });

  it('reports the lane with no channels and no clips as empty', () => {
    const target = resolvePlaylistBounceTarget([], [], 0);
    assert.equal(target.status, 'empty');
    assert.equal(target.channelId, null);
    assert.equal(target.startBar, 0);
  });

  it('never returns a channel that is not the lane content', () => {
    const channels: Channel[] = [
      { id: 'other', name: 'Other' } as Channel,
      { id: 'lane-owner', name: 'Owner' } as Channel,
    ];
    const clips = [clip({ trackIndex: 0, startBar: 0, channelId: 'lane-owner' })];
    const target = resolvePlaylistBounceTarget(channels, clips, 0);
    assert.equal(target.channelId, 'lane-owner');
  });
});
