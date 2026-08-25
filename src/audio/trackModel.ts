export type TrackId = string;

export interface TrackState {
  readonly id: TrackId;
  readonly name: string;
  readonly gain: number;
  readonly pan: number;
  readonly muted: boolean;
  readonly soloed: boolean;
}

export const DEFAULT_TRACK_GAIN = 1;
export const DEFAULT_TRACK_PAN = 0;

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite.`);
}

export function createTrackState(id: string, name = 'Track'): TrackState {
  if (!id.trim()) throw new Error('Track id must not be empty.');
  if (!name.trim()) throw new Error('Track name must not be empty.');
  return { id, name, gain: DEFAULT_TRACK_GAIN, pan: DEFAULT_TRACK_PAN, muted: false, soloed: false };
}

export function setTrackGain(track: TrackState, gain: number): TrackState {
  assertFinite(gain, 'Track gain');
  if (gain < 0 || gain > 2) throw new RangeError('Track gain must be between 0 and 2.');
  return { ...track, gain };
}

export function setTrackPan(track: TrackState, pan: number): TrackState {
  assertFinite(pan, 'Track pan');
  if (pan < -1 || pan > 1) throw new RangeError('Track pan must be between -1 and 1.');
  return { ...track, pan };
}

export function renameTrack(track: TrackState, name: string): TrackState {
  if (!name.trim()) throw new Error('Track name must not be empty.');
  return { ...track, name };
}

export function toggleTrackMute(track: TrackState): TrackState { return { ...track, muted: !track.muted }; }
export function toggleTrackSolo(track: TrackState): TrackState { return { ...track, soloed: !track.soloed }; }
