import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  createMixerChannel,
  dbToGain,
  isChannelAudible,
  setChannelMute,
  setChannelPan,
  setChannelSolo,
  setChannelVolume,
} from './mixerChannel';

describe('mixer channel', () => {
  it('creates a neutral channel', () => {
    assert.deepEqual(createMixerChannel(1, 'Lead'), { id: 1, name: 'Lead', volumeDb: 0, pan: 0, muted: false, soloed: false });
  });

  it('clamps volume and pan to safe ranges', () => {
    const channel = createMixerChannel(1);
    assert.equal(setChannelVolume(channel, 999).volumeDb, MAX_VOLUME_DB);
    assert.equal(setChannelVolume(channel, -999).volumeDb, MIN_VOLUME_DB);
    assert.equal(setChannelPan(channel, 4).pan, 1);
    assert.equal(setChannelPan(channel, -4).pan, -1);
  });

  it('converts dB to linear gain', () => {
    assert.equal(dbToGain(-60), 0);
    assert.equal(dbToGain(0), 1);
    assert.equal(Math.round(dbToGain(-6) * 1000) / 1000, 0.501);
  });

  it('applies mute and solo rules', () => {
    let channel = createMixerChannel(1);
    channel = setChannelMute(channel, true);
    assert.equal(isChannelAudible(channel, false), false);
    channel = setChannelMute(channel, false);
    assert.equal(isChannelAudible(channel, false), true);
    assert.equal(isChannelAudible(channel, true), false);
    channel = setChannelSolo(channel, true);
    assert.equal(isChannelAudible(channel, true), true);
  });
});
