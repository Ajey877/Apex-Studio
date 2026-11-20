/**
 * Phase 10H — what the Channel Rack says about a channel's freeze.
 *
 * Kept out of the component so every sentence the user reads is unit-tested
 * against the status it describes.
 */
import type { ChannelFreezeStatus } from '../state/trackFreeze';

export interface ChannelFreezeViewInput {
  status: ChannelFreezeStatus;
  /** This channel's freeze render is running. */
  busy: boolean;
  /** Another channel's freeze render is running. */
  anotherBusy: boolean;
  playMode: 'pat' | 'song';
  tailDecayed: boolean;
  channelName: string;
}

export interface ChannelFreezeView {
  status: ChannelFreezeStatus;
  busy: boolean;
  tone: 'idle' | 'frozen' | 'warning' | 'danger';
  primaryLabel: string;
  primaryTitle: string;
  primaryAriaLabel: string;
  /** The primary button freezes / refreezes; it is inert while the freeze is valid. */
  primaryDisabled: boolean;
  showUnfreeze: boolean;
  unfreezeDisabled: boolean;
}

const PATTERN_MODE_NOTE =
  ' Pattern mode always plays the instrument; the frozen audio is used in Song mode.';

export const describeChannelFreeze = (input: ChannelFreezeViewInput): ChannelFreezeView => {
  const { status, busy, anotherBusy, playMode, tailDecayed, channelName } = input;
  const patternNote = playMode === 'pat' ? PATTERN_MODE_NOTE : '';
  if (busy) {
    return {
      status, busy: true, tone: 'idle', primaryLabel: 'FRZ…',
      primaryTitle: `Freezing ${channelName}: rendering its Song timeline to audio. The channel keeps its instrument until the render is saved.`,
      primaryAriaLabel: `Freezing ${channelName}`,
      primaryDisabled: true, showUnfreeze: status !== 'none', unfreezeDisabled: true,
    };
  }
  switch (status) {
    case 'frozen':
      return {
        status, busy: false, tone: tailDecayed ? 'frozen' : 'warning', primaryLabel: 'FROZEN',
        primaryTitle: `Frozen: Song playback uses this channel's rendered audio instead of its instrument. An export uses it only where it is sample-identical to the instrument, so freezing never changes an exported file. Channel mute/solo and the whole mixer stay live. Editing the channel's notes, clips, instrument, volume, pan, its automation or the tempo makes the freeze stale.${
          tailDecayed ? '' : ' Warning: the instrument was still sounding at the end of the rendered tail, so the frozen audio ends earlier than the live instrument would.'}${patternNote}`,
        primaryAriaLabel: `${channelName} is frozen`,
        primaryDisabled: true, showUnfreeze: true, unfreezeDisabled: anotherBusy,
      };
    case 'stale':
      return {
        status, busy: false, tone: 'warning', primaryLabel: 'STALE',
        primaryTitle: `Stale freeze: something baked into the frozen audio was edited after it was frozen, so the frozen audio is not used and the instrument plays instead. Click to freeze again, or Unfreeze to remove it. Undoing the edit makes the freeze valid again.${patternNote}`,
        primaryAriaLabel: `Refreeze ${channelName} (freeze is stale)`,
        primaryDisabled: anotherBusy, showUnfreeze: true, unfreezeDisabled: anotherBusy,
      };
    case 'missing-audio':
      return {
        status, busy: false, tone: 'danger', primaryLabel: 'NO AUDIO',
        primaryTitle: 'Frozen audio missing: the rendered audio for this freeze could not be loaded, so the instrument plays instead. Nothing else was lost. Click to freeze again, or Unfreeze to remove the freeze.',
        primaryAriaLabel: `Refreeze ${channelName} (frozen audio is missing)`,
        primaryDisabled: anotherBusy, showUnfreeze: true, unfreezeDisabled: anotherBusy,
      };
    default:
      return {
        status: 'none', busy: false, tone: 'idle', primaryLabel: 'FRZ',
        primaryTitle: `Freeze: render this channel's Song timeline to audio and play that instead of the instrument, to save CPU and plug-in instances. Notes, clips and instrument settings are kept and Unfreeze brings them back unchanged.${patternNote}`,
        primaryAriaLabel: `Freeze ${channelName}`,
        primaryDisabled: anotherBusy, showUnfreeze: false, unfreezeDisabled: true,
      };
  }
};
