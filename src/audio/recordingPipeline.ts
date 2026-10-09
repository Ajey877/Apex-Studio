import { barsToBeats, beatsToSeconds, LEGACY_TIME_SIGNATURE, resolveProjectTimeSignature, type TimeSignature } from '../music/musicalTime';
import type { PunchCapturePlan } from '../music/punchRecording';
import type { AudioRecording, PlaylistClip, PlaylistTrack } from '../types/daw';

export interface RecordingBufferRegistration {
  id: string;
  buffer: AudioBuffer;
  peaks: number[];
  duration: number;
}

export const getRecordingAudioBufferId = (recordingId: string): string => {
  if (!recordingId.trim()) throw new Error('Recording ID is required');
  return `recording-${recordingId}`;
};

/**
 * Phase 1F/1I: recording bar timing derives from the resolved project meter —
 * 3/4 lasts 1.5 s and 7/8 lasts 1.75 s at 120 BPM. Missing/unsupported meters
 * resolve to the legacy 4/4 bar, exactly like the rest of the runtime.
 */
export const getRecordingLengthBars = (durationSeconds: number, bpm: number, meter: TimeSignature = LEGACY_TIME_SIGNATURE): number => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Recording duration must be greater than zero');
  const safeBpm = Number.isFinite(bpm) ? Math.max(20, bpm) : 120;
  const secondsPerBar = beatsToSeconds(barsToBeats(1, resolveProjectTimeSignature({ timeSignature: meter })), safeBpm);
  return Math.max(1, Math.ceil(durationSeconds / secondsPerBar));
};

export const validateRecordingTargetTrack = (tracks: PlaylistTrack[], targetTrackIndex: number): PlaylistTrack => {
  if (!Number.isInteger(targetTrackIndex) || targetTrackIndex < 0) {
    throw new Error('Invalid playlist track selected for the recording');
  }
  const track = tracks[targetTrackIndex];
  if (!track) throw new Error('The selected playlist track no longer exists');
  return track;
};

/**
 * Phase 1F: recording bar timing derives from the resolved project meter — a
 * 3/4 bar lasts 3 beats (1.5 s at 120 BPM), not 4. Missing/unsupported meters
 * resolve to the legacy 4/4 bar, exactly like the rest of the runtime.
 *
 * Phase 1K: `startBar` places the take at the musical bar capture actually
 * began on (the count-in's `clipStartBar`). The default 0 keeps the historic
 * "record onto bar 1" behaviour for callers without a count-in plan.
 */
export const createRecordingPlaylistClip = (
  recording: AudioRecording,
  registration: RecordingBufferRegistration,
  tracks: PlaylistTrack[],
  targetTrackIndex: number,
  bpm: number,
  id = `rec-clip-${Date.now()}`,
  meter: TimeSignature = LEGACY_TIME_SIGNATURE,
  startBar = 0
): PlaylistClip => {
  if (!recording.audioBlob || recording.audioBlob.size === 0) throw new Error('The recording contains no audio data');
  if (registration.id !== getRecordingAudioBufferId(recording.id)) throw new Error('Recording audio buffer registration does not match the recording');
  if (!registration.buffer || registration.buffer.duration <= 0) throw new Error('The recording audio buffer is invalid');

  // Waveform peaks are derived presentation metadata. A decode/peak-generation
  // failure must never make an otherwise valid recorded buffer unusable.
  const waveform = Array.isArray(registration.peaks) ? registration.peaks : [];

  validateRecordingTargetTrack(tracks, targetTrackIndex);
  const lengthBars = getRecordingLengthBars(registration.duration, bpm, meter);
  const safeStartBar = Number.isFinite(startBar) && startBar > 0 ? Math.floor(startBar) : 0;

  return {
    id,
    trackIndex: targetTrackIndex,
    startBar: safeStartBar,
    lengthBars,
    type: 'audio',
    audioBufferId: registration.id,
    audioName: recording.name,
    audioWaveform: waveform,
    audioUnavailable: false,
    color: '#ff6e00',
    name: recording.name
  };
};

// --- Phase 1L: punch-in / punch-out take placement --------------------------

/**
 * Phase 1L — where a punch take lands on the playlist.
 *
 * Unlike an ordinary take (which is rounded UP to whole bars by
 * `getRecordingLengthBars`), a punch take's geometry IS its musical window:
 * `startBar` is the punch-in bar (fractional when the punch-in is inside a
 * bar) and `lengthBars` is the punched length in bars, both taken from the
 * capture plan that the runtime actually executed.
 */
export interface PunchClipPlacement {
  /** 0-based fractional playlist bar the take begins at. */
  readonly startBar: number;
  /** Punched length in bars (fractional is legal — playlist clips are bar floats). */
  readonly lengthBars: number;
  /** Decoded audio length the take may keep, in seconds. */
  readonly trimSeconds: number;
}

export const planPunchClipPlacement = (plan: PunchCapturePlan): PunchClipPlacement => {
  if (!Number.isFinite(plan.clipStartBar) || plan.clipStartBar < 0) {
    throw new Error('The punch-in position is not a legal playlist bar');
  }
  if (!Number.isFinite(plan.clipLengthBars) || plan.clipLengthBars <= 0) {
    throw new Error('The punch window has no length');
  }
  if (!Number.isFinite(plan.captureDurationSeconds) || plan.captureDurationSeconds <= 0) {
    throw new Error('The punch window has no duration');
  }
  return Object.freeze({
    startBar: plan.clipStartBar,
    lengthBars: plan.clipLengthBars,
    trimSeconds: plan.captureDurationSeconds,
  });
};

/**
 * Phase 1L — trims a decoded take to the punch window.
 *
 * `MediaRecorder` cannot start or stop on a sample: it opens when the count-in
 * resolves and closes a task or two after the punch-out timer fires, so the
 * encoded blob is normally a few milliseconds longer than the punched window.
 * Trimming the decoded buffer to the window is what guarantees the project
 * never holds audio from beyond punch-out, and it keeps the clip's audio the
 * same length as its playlist geometry.
 *
 * A buffer already at or inside the window is returned unchanged (never padded
 * and never re-allocated), so a take cannot grow silence it never recorded.
 * `createBuffer` is injected because a raw `AudioBuffer` is only constructible
 * through an `AudioContext` (or `OfflineAudioContext`).
 */
export const trimAudioBufferToSeconds = (
  buffer: AudioBuffer,
  seconds: number,
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer
): AudioBuffer => {
  if (!buffer || !(buffer.duration > 0)) throw new Error('The recording audio buffer is invalid');
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Punch trim length must be greater than zero');
  const targetLength = Math.min(buffer.length, Math.floor(seconds * buffer.sampleRate + 1e-6));
  if (targetLength >= buffer.length) return buffer;
  const trimmed = createBuffer(buffer.numberOfChannels, targetLength, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel);
    trimmed.getChannelData(channel).set(source.subarray(0, targetLength));
  }
  return trimmed;
};

/**
 * Phase 1L — builds the playlist clip for a punch take.
 *
 * The take is ADDED at the punched window; no existing clip is moved, resized
 * or deleted (a punch take never overwrites unrelated content). The clip keeps
 * its exact punched geometry, and when the arrangement length is supplied the
 * clip is held inside it, so a punch take can never exceed the arrangement.
 */
export const createPunchRecordingPlaylistClip = (
  recording: AudioRecording,
  registration: RecordingBufferRegistration,
  tracks: PlaylistTrack[],
  targetTrackIndex: number,
  placement: PunchClipPlacement,
  id = `punch-clip-${Date.now()}`,
  totalBars?: number
): PlaylistClip => {
  if (!recording.audioBlob || recording.audioBlob.size === 0) throw new Error('The recording contains no audio data');
  if (registration.id !== getRecordingAudioBufferId(recording.id)) throw new Error('Recording audio buffer registration does not match the recording');
  if (!registration.buffer || registration.buffer.duration <= 0) throw new Error('The recording audio buffer is invalid');

  validateRecordingTargetTrack(tracks, targetTrackIndex);

  const clip: PlaylistClip = {
    id,
    trackIndex: targetTrackIndex,
    startBar: placement.startBar,
    lengthBars: placement.lengthBars,
    type: 'audio',
    audioBufferId: registration.id,
    audioName: recording.name,
    audioWaveform: Array.isArray(registration.peaks) ? registration.peaks : [],
    audioUnavailable: false,
    color: '#ff6e00',
    name: recording.name
  };

  // Defense-in-depth: the punch plan already truncates the window at the
  // arrangement end, but a clip must never reach past the length it is handed.
  // The arrangement length stays an argument — runtime audio must not read the
  // timeline capacity constant (Phase 1G anchor) — and this applies only the
  // geometric rule, never a cap of its own.
  if (!Number.isFinite(totalBars) || (totalBars as number) <= 0) return clip;
  const arrangementBars = totalBars as number;
  const lengthBars = Math.min(clip.lengthBars, arrangementBars);
  const startBar = Math.min(Math.max(0, clip.startBar), Math.max(0, arrangementBars - lengthBars));
  return startBar === clip.startBar && lengthBars === clip.lengthBars
    ? clip
    : { ...clip, startBar, lengthBars };
};

// --- Phase 1M: take-lane recording clip creation ----------------------------

import { nextTakeIndexForGroup } from './takeLaneManager';

/**
 * Phase 1M — creates a playlist clip for a new recording take that belongs to
 * an existing take group, or starts a new group.
 *
 * The clip is placed at the same position as the existing takes (or at a
 * caller-supplied position for a new group). The `takeIndex` is computed from
 * the existing group clips so it is always unique. The new clip becomes the
 * active take automatically, so the musician hears the most recent recording
 * immediately after capture.
 *
 * When `takeGroupId` is `undefined`, a new group is created and the clip
 * starts as take 0. When a `takeGroupId` is supplied, the clip joins that
 * group and its `takeIndex` is set to the next available value.
 *
 * The function is pure: it creates the clip but does not mutate the existing
 * clips array. Callers are responsible for updating the active take on every
 * clip in the group via `selectActiveTake` or by setting `activeTakeIndex`.
 */
export const createTakeRecordingPlaylistClip = (
  recording: AudioRecording,
  registration: RecordingBufferRegistration,
  tracks: PlaylistTrack[],
  targetTrackIndex: number,
  placement: PunchClipPlacement,
  takeGroupId: string | undefined,
  existingClips: readonly PlaylistClip[] = [],
  id = `take-clip-${Date.now()}`,
  totalBars?: number
): PlaylistClip => {
  // Create the base clip using the existing punch placement logic
  const baseClip = createPunchRecordingPlaylistClip(
    recording,
    registration,
    tracks,
    targetTrackIndex,
    placement,
    id,
    totalBars
  );

  if (!takeGroupId) {
    // New group: take 0, active
    return {
      ...baseClip,
      takeGroupId: `take-group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      takeIndex: 0,
      activeTakeIndex: 0,
    };
  }

  // Existing group: compute next takeIndex, mark as active
  const nextIndex = nextTakeIndexForGroup(existingClips, takeGroupId);
  return {
    ...baseClip,
    takeGroupId,
    takeIndex: nextIndex,
    activeTakeIndex: nextIndex,
  };
};

/**
 * Phase 1M — given a set of clips and a takeGroupId, updates `activeTakeIndex`
 * on every clip in the group to the specified take. Returns the full clip
 * array with the selection applied. This is the persistence-safe way to
 * change take selection: it goes through the normal clip publication path.
 */
export const applyTakeSelectionToClips = (
  clips: readonly PlaylistClip[],
  takeGroupId: string,
  activeTakeIndex: number
): PlaylistClip[] => {
  return clips.map(clip => {
    if (clip.takeGroupId !== takeGroupId) return clip;
    if (clip.activeTakeIndex === activeTakeIndex) return clip;
    return { ...clip, activeTakeIndex: activeTakeIndex };
  });
};
