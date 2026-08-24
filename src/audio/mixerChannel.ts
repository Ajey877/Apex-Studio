export interface MixerChannelState {
  id: number;
  name: string;
  volumeDb: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
}

export const MIN_VOLUME_DB = -60;
export const MAX_VOLUME_DB = 12;

export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db <= MIN_VOLUME_DB) return 0;
  return Math.pow(10, Math.min(db, MAX_VOLUME_DB) / 20);
}

export function createMixerChannel(id: number, name = `Track ${id}`): MixerChannelState {
  if (!Number.isInteger(id) || id < 0) throw new Error('Mixer channel ID must be a non-negative integer.');
  return { id, name: name.trim() || `Track ${id}`, volumeDb: 0, pan: 0, muted: false, soloed: false };
}

export function setChannelVolume(channel: MixerChannelState, volumeDb: number): MixerChannelState {
  if (!Number.isFinite(volumeDb)) throw new Error('Mixer volume must be finite.');
  return { ...channel, volumeDb: Math.max(MIN_VOLUME_DB, Math.min(MAX_VOLUME_DB, volumeDb)) };
}

export function setChannelPan(channel: MixerChannelState, pan: number): MixerChannelState {
  if (!Number.isFinite(pan)) throw new Error('Mixer pan must be finite.');
  return { ...channel, pan: Math.max(-1, Math.min(1, pan)) };
}

export function setChannelMute(channel: MixerChannelState, muted: boolean): MixerChannelState {
  return { ...channel, muted };
}

export function setChannelSolo(channel: MixerChannelState, soloed: boolean): MixerChannelState {
  return { ...channel, soloed };
}

export function isChannelAudible(channel: MixerChannelState, hasSolo: boolean): boolean {
  return !channel.muted && (!hasSolo || channel.soloed);
}
