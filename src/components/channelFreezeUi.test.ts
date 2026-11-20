import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeChannelFreeze, type ChannelFreezeViewInput } from './channelFreezeUi';

const input = (patch: Partial<ChannelFreezeViewInput>): ChannelFreezeViewInput => ({
  status: 'none', busy: false, anotherBusy: false, playMode: 'song', tailDecayed: true, channelName: 'Lead', ...patch,
});

test('10H UI: an unfrozen channel offers Freeze and no Unfreeze', () => {
  const view = describeChannelFreeze(input({}));
  assert.equal(view.primaryLabel, 'FRZ');
  assert.equal(view.primaryDisabled, false);
  assert.equal(view.showUnfreeze, false);
  assert.equal(view.tone, 'idle');
  assert.equal(view.primaryAriaLabel, 'Freeze Lead');
  assert.match(view.primaryTitle, /Unfreeze brings them back unchanged/);
});

test('10H UI: a frozen channel says what is frozen, what stays live and what an export does', () => {
  const view = describeChannelFreeze(input({ status: 'frozen' }));
  assert.equal(view.primaryLabel, 'FROZEN');
  assert.equal(view.primaryDisabled, true, 'a valid freeze has nothing to refreeze');
  assert.equal(view.showUnfreeze, true);
  assert.equal(view.unfreezeDisabled, false);
  assert.equal(view.tone, 'frozen');
  assert.match(view.primaryTitle, /Song playback uses this channel's rendered audio/);
  assert.match(view.primaryTitle, /freezing never changes an exported file/);
  assert.match(view.primaryTitle, /mute\/solo and the whole mixer stay live/);
  assert.doesNotMatch(view.primaryTitle, /Warning/);
});

test('10H UI: an undecayed tail is a visible warning, never hidden', () => {
  const view = describeChannelFreeze(input({ status: 'frozen', tailDecayed: false }));
  assert.equal(view.tone, 'warning');
  assert.match(view.primaryTitle, /ends earlier than the live instrument would/);
});

test('10H UI: a stale freeze says the instrument is playing and offers Refreeze and Unfreeze', () => {
  const view = describeChannelFreeze(input({ status: 'stale' }));
  assert.equal(view.primaryLabel, 'STALE');
  assert.equal(view.primaryDisabled, false);
  assert.equal(view.showUnfreeze, true);
  assert.equal(view.tone, 'warning');
  assert.match(view.primaryTitle, /the instrument plays instead/);
  assert.match(view.primaryAriaLabel, /Refreeze Lead/);
});

test('10H UI: missing frozen audio is reported as such, with the same two ways out', () => {
  const view = describeChannelFreeze(input({ status: 'missing-audio' }));
  assert.equal(view.primaryLabel, 'NO AUDIO');
  assert.equal(view.tone, 'danger');
  assert.equal(view.primaryDisabled, false);
  assert.equal(view.showUnfreeze, true);
  assert.match(view.primaryTitle, /could not be loaded, so the instrument plays instead/);
  assert.match(view.primaryTitle, /Nothing else was lost/);
});

test('10H UI: while a freeze renders every freeze control is inert', () => {
  const busy = describeChannelFreeze(input({ busy: true }));
  assert.equal(busy.primaryLabel, 'FRZ…');
  assert.equal(busy.primaryDisabled, true);
  assert.equal(busy.busy, true);
  assert.match(busy.primaryTitle, /keeps its instrument until the render is saved/);
  for (const status of ['none', 'frozen', 'stale', 'missing-audio'] as const) {
    const other = describeChannelFreeze(input({ status, anotherBusy: true }));
    assert.equal(other.primaryDisabled, true, status);
    if (other.showUnfreeze) assert.equal(other.unfreezeDisabled, true, status);
  }
  const refreezing = describeChannelFreeze(input({ status: 'stale', busy: true }));
  assert.equal(refreezing.showUnfreeze, true);
  assert.equal(refreezing.unfreezeDisabled, true);
});

test('10H UI: Pattern mode is called out, because the instrument is what plays there', () => {
  for (const status of ['none', 'frozen'] as const) {
    assert.match(describeChannelFreeze(input({ status, playMode: 'pat' })).primaryTitle, /Pattern mode always plays the instrument/);
    assert.doesNotMatch(describeChannelFreeze(input({ status, playMode: 'song' })).primaryTitle, /Pattern mode/);
  }
});

test('10H UI: the Channel Rack wires the described view to real buttons, and the lane bounce is not relabelled', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const rack = read('./ChannelRack.tsx');
  assert.match(rack, /describeChannelFreeze\(/);
  assert.match(rack, /data-testid=\{`channel-freeze-\$\{ch\.id\}`\}/);
  assert.match(rack, /data-testid=\{`channel-unfreeze-\$\{ch\.id\}`\}/);
  assert.match(rack, /data-testid="channel-freeze-message"/);
  assert.match(rack, /onFreezeChannel/);
  assert.match(rack, /onUnfreezeChannel/);
  // Bounce-In-Place keeps its own handler and wording.
  const arranger = read('./PlaylistArranger.tsx');
  assert.match(arranger, /handleBounceTrack/);
  assert.doesNotMatch(arranger, /onFreezeChannel|channelFreeze/);
});
