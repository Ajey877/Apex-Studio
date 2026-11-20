/**
 * Phase 10H — Track Freeze / Unfreeze: the pure project-state half.
 *
 * FREEZE UNIT
 * -----------
 * One Channel Rack instrument channel (`Channel`). A frozen channel keeps every
 * piece of its source data; a `ChannelFreeze` record on the channel points at a
 * rendered audio asset and at a fingerprint of the source that was rendered.
 *
 * WHAT THE ASSET CONTAINS (baked)
 *   - the channel's instrument voices for every unmuted pattern clip that plays
 *     the channel on the Song timeline (per-channel and whole-pattern clips),
 *   - channel pitch, filter, arpeggiator, sample/zone/drum-pad settings and
 *     VST3 instrument state,
 *   - channel volume and channel pan (the signal is captured where the channel
 *     enters its mixer track),
 *   - automation clips that target the channel (`channel_vol`, `channel_pan`,
 *     `channel_filter_cutoff`, `channel_filter_res`, `channel_pitch`,
 *     `vst3_param`),
 *   - tempo, swing and meter.
 *
 * WHAT STAYS LIVE (never baked)
 *   - channel mute / solo, and the mixer track the channel is routed to,
 *   - the whole mixer: insert effects (built-in and VST3), track volume / pan /
 *     mute / solo, routing, aux sends, sidechain, the master chain and mastering,
 *   - audio clips, including audio clips that belong to the channel,
 *   - Pattern mode: it always plays the original instrument.
 *
 * WHEN THE ASSET IS PLAYED
 * Only while `resolveChannelFreezeStatus` is `'frozen'`: the record exists, its
 * audio is available, and the fingerprint of the *current* source equals the
 * fingerprint stored at freeze time. Any edit to something that was baked makes
 * the fingerprint differ; the channel then plays its original instrument again
 * (`'stale'`) until it is refrozen or unfrozen. That is the rule that makes
 * "frozen audio" and "the source" impossible to hear at the same time, and
 * impossible to drift apart silently: exactly one of them is selected per
 * channel, by one function, for live playback and for every offline render.
 */
import type {
  AutomationTargetType,
  Channel,
  ChannelFreeze,
  Pattern,
  PlaylistClip,
  PlaylistTrack,
  ProjectState,
} from '../types/daw';
import { LEGACY_TIME_SIGNATURE, resolveProjectTimeSignature, type TimeSignature } from '../music/musicalTime';
import { findPatternForClip, isFullPatternPlaylistClip, resolveClipChannelContent } from './patternContent';

export const CHANNEL_FREEZE_VERSION = 1 as const;
/**
 * Longest timeline (content plus tail) one freeze may render. A freeze is a
 * single in-memory stereo float render: ten minutes is about 212 MB at 44.1 kHz.
 */
export const CHANNEL_FREEZE_MAX_SECONDS = 600;
/** Seconds rendered past the channel's last pattern clip so releases can ring out. */
export const CHANNEL_FREEZE_TAIL_SECONDS = 8;
/** Audio-asset id prefix of every freeze render. */
export const CHANNEL_FREEZE_BUFFER_PREFIX = 'freeze-';
/** Peak below which the end of a freeze render counts as decayed (-80 dBFS). */
export const CHANNEL_FREEZE_DECAY_THRESHOLD = 1e-4;

/** Automation targets whose effect is part of the channel stage and therefore baked. */
export const CHANNEL_FREEZE_BAKED_AUTOMATION_TARGETS: readonly AutomationTargetType[] = [
  'channel_vol',
  'channel_pan',
  'channel_filter_cutoff',
  'channel_filter_res',
  'channel_pitch',
  'vst3_param',
];

/**
 * Channel fields that are NOT part of the frozen sound.
 *
 * `steps` / `notes` / `stepVelocities` are excluded here because they are the
 * content of whichever pattern is selected; the fingerprint reads content per
 * clip instead, so merely selecting another pattern does not look like an edit.
 */
const CHANNEL_FIELDS_OUTSIDE_FREEZE: ReadonlySet<string> = new Set([
  'id', 'name', 'color', 'mute', 'solo', 'mixerTrackId', 'steps', 'notes', 'midiOutput', 'freeze',
]);

/** The timeline a freeze is rendered from / compared against. */
export interface ChannelFreezeSource {
  clips: readonly PlaylistClip[];
  patterns: readonly Pattern[] | undefined;
  playlistTracks: readonly PlaylistTrack[] | undefined;
  bpm: number;
  swing: number;
  meter: TimeSignature | readonly [number, number] | undefined;
}

export type ChannelFreezeStatus = 'none' | 'frozen' | 'stale' | 'missing-audio';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Same clamp `AudioEngine.setBpm` and the offline renderer apply. */
export const normalizeFreezeBpm = (bpm: unknown): number =>
  Math.max(20, Math.min(300, Number(bpm) || 120));

const normalizeMeter = (meter: ChannelFreezeSource['meter']): TimeSignature =>
  resolveProjectTimeSignature({ timeSignature: meter ?? LEGACY_TIME_SIGNATURE });

/**
 * Keys ignored wherever they appear. The first four are session-only values
 * `serializeProjectState` never writes (a blob URL is different after every
 * reload); the rest are display data or the hydration flag, none of which is
 * audio.
 */
const SESSION_OR_DISPLAY_KEYS: ReadonlySet<string> = new Set([
  'audioBlob', 'audioUrl', 'blob', 'url', 'sampleUrl', 'waveformPeaks', 'audioUnavailable',
]);

/** Note ids only name voices; they never change what is heard. */
const NOTE_FIELDS_OUTSIDE_FREEZE: ReadonlySet<string> = new Set(['id']);

/** Deterministic JSON: sorted keys, no `undefined`, `-0` folded to `0`. */
const stableStringify = (value: unknown, skipTopLevelKeys?: ReadonlySet<string>): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value === 0 ? 0 : value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      if (skipTopLevelKeys?.has(key) || SESSION_OR_DISPLAY_KEYS.has(key)) continue;
      const item = value[key];
      if (item === undefined || typeof item === 'function') continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
};

/** Two independent 32-bit FNV-1a style lanes plus the length: 80 bits, hex. */
const hashText = (text: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
    h2 = (h2 << 13) | (h2 >>> 19);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return `${hex(h1)}${hex(h2)}${(text.length >>> 0).toString(16)}`;
};

const mutedLanes = (tracks: ChannelFreezeSource['playlistTracks']): Set<number> => {
  const mutes = new Set<number>();
  if (!Array.isArray(tracks)) return mutes;
  tracks.forEach((track, index) => { if (track && track.mute === true) mutes.add(index); });
  return mutes;
};

const isLaneMuted = (clip: Pick<PlaylistClip, 'trackIndex'>, mutes: Set<number>): boolean =>
  mutes.size > 0 && Number.isFinite(clip.trackIndex) && mutes.has(Math.floor(clip.trackIndex));

const hasPlayableExtent = (clip: PlaylistClip): boolean =>
  Number.isFinite(clip.startBar) && Number.isFinite(clip.lengthBars) && clip.lengthBars > 0;

/** True when `clip` is a pattern clip that can trigger `channel` (mute state ignored). */
export const patternClipPlaysChannel = (
  clip: PlaylistClip,
  channel: Pick<Channel, 'id'>,
  patterns: readonly Pattern[] | undefined,
): boolean => {
  if (clip.type !== 'pattern') return false;
  if (isFullPatternPlaylistClip(clip)) return Boolean(findPatternForClip(patterns, clip));
  return clip.channelId === channel.id;
};

/** True when `clip` is an automation clip whose target is baked into `channel`'s freeze. */
export const automationClipIsBakedIntoChannel = (
  clip: PlaylistClip,
  channel: Pick<Channel, 'id'>,
): boolean =>
  clip.type === 'automation' &&
  !!clip.automationTarget &&
  CHANNEL_FREEZE_BAKED_AUTOMATION_TARGETS.includes(clip.automationTarget.type) &&
  String(clip.automationTarget.targetId) === channel.id;

/**
 * The clips handed to the freeze render: every pattern clip that can play the
 * channel and every automation clip baked into it. Muted clips are kept — the
 * renderer drops them exactly like playback does.
 */
export const collectChannelFreezeRenderClips = (
  channel: Pick<Channel, 'id'>,
  clips: readonly PlaylistClip[],
  patterns: readonly Pattern[] | undefined,
): PlaylistClip[] =>
  clips.filter(clip => patternClipPlaysChannel(clip, channel, patterns) || automationClipIsBakedIntoChannel(clip, channel));

/** Unmuted pattern clips on unmuted lanes that play the channel, in timeline order. */
const audiblePatternClips = (
  channel: Pick<Channel, 'id'>,
  source: ChannelFreezeSource,
): PlaylistClip[] => {
  const mutes = mutedLanes(source.playlistTracks);
  return source.clips
    .filter(clip => patternClipPlaysChannel(clip, channel, source.patterns)
      && !clip.mute && !isLaneMuted(clip, mutes) && hasPlayableExtent(clip))
    .sort((a, b) => a.startBar - b.startBar || a.lengthBars - b.lengthBars || String(a.id).localeCompare(String(b.id)));
};

/** End of the channel's last audible pattern clip, in bars (0 when it has none). */
export const resolveChannelFreezeContentEndBars = (
  channel: Pick<Channel, 'id'>,
  source: ChannelFreezeSource,
): number => audiblePatternClips(channel, source).reduce((end, clip) => Math.max(end, clip.startBar + clip.lengthBars), 0);

/**
 * Fingerprint of everything a freeze of `channel` bakes.
 *
 * Deliberately a superset: a field that might affect the sound is included, so
 * the failure mode is a freeze reported Stale that would still have matched,
 * never frozen audio that no longer matches its source.
 */
export const computeChannelFreezeFingerprint = (
  channel: Channel,
  source: ChannelFreezeSource,
): string => {
  const meter = normalizeMeter(source.meter);
  const mutes = mutedLanes(source.playlistTracks);
  const patternClips = audiblePatternClips(channel, source).map(clip => {
    const content = resolveClipChannelContent(source.patterns, clip, channel);
    return {
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      offsetSteps: finite(clip.offsetSteps, 0),
      full: isFullPatternPlaylistClip(clip),
      patternLength: finite(findPatternForClip(source.patterns, clip)?.lengthSteps, 0),
      steps: content.steps.map(cell => (cell === true ? 1 : 0)).join(''),
      notes: content.notes.map(note => stableStringify(note, NOTE_FIELDS_OUTSIDE_FREEZE)),
    };
  });
  const automation = source.clips
    .filter(clip => automationClipIsBakedIntoChannel(clip, channel)
      && !clip.mute && !isLaneMuted(clip, mutes) && hasPlayableExtent(clip) && Array.isArray(clip.automationPoints))
    .sort((a, b) => a.startBar - b.startBar || String(a.id).localeCompare(String(b.id)))
    .map(clip => ({
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      target: clip.automationTarget,
      points: clip.automationPoints,
    }));
  const payload = {
    version: CHANNEL_FREEZE_VERSION,
    bpm: Math.round(normalizeFreezeBpm(source.bpm) * 1e6) / 1e6,
    swing: Math.round(finite(source.swing, 0) * 1e6) / 1e6,
    meter: [meter[0], meter[1]],
    // An external-only channel has no internal audio; a freeze can never be
    // made in that mode, so switching to it invalidates an existing one.
    internalAudio: channel.midiOutput?.mode !== 'external',
    stepVelocities: channel.stepVelocities ?? null,
    patternClips,
    automation,
  };
  return hashText(`${stableStringify(channel, CHANNEL_FIELDS_OUTSIDE_FREEZE)}|${stableStringify(payload)}`);
};

/** Structural validation for a persisted record; anything else is dropped on load. */
export const isChannelFreezeRecord = (value: unknown): value is ChannelFreeze => {
  if (!isRecord(value)) return false;
  return value.version === CHANNEL_FREEZE_VERSION
    && typeof value.audioBufferId === 'string' && value.audioBufferId.length > 0
    && typeof value.sourceFingerprint === 'string' && value.sourceFingerprint.length > 0
    && Number.isFinite(value.frozenAt)
    && Number.isFinite(value.sampleRate) && (value.sampleRate as number) > 0
    && Number.isFinite(value.frameCount) && (value.frameCount as number) > 0
    && Number.isInteger(value.leadInFrames) && (value.leadInFrames as number) >= 0
    && Number.isFinite(value.contentSeconds) && (value.contentSeconds as number) >= 0
    && Number.isFinite(value.tailSeconds) && (value.tailSeconds as number) >= 0
    && typeof value.tailDecayed === 'boolean'
    && (value.audioUnavailable === undefined || typeof value.audioUnavailable === 'boolean');
};

/** Frames per Web Audio render quantum. */
export const WEB_AUDIO_RENDER_QUANTUM_FRAMES = 128;

/**
 * Whether an offline render reproduces a frozen channel's source sample for
 * sample, so that swapping the instrument for the frozen audio cannot change
 * the rendered file.
 *
 * Web Audio processes in 128-frame quanta and a synth voice is not invariant
 * under a shift of its start inside a quantum (measured: the same note moved by
 * 58 frames differs by up to 0.5 full scale around its envelope corners, moved
 * by a whole number of quanta it is bit-identical). A render therefore matches
 * the freeze only at the freeze's sample rate and with a lead-in that differs
 * from the freeze's by a whole number of quanta.
 */
export const isChannelFreezeSampleExact = (
  freeze: Pick<ChannelFreeze, 'sampleRate' | 'leadInFrames'>,
  render: { sampleRate: number; leadInFrames: number },
): boolean => {
  if (freeze.sampleRate !== render.sampleRate) return false;
  const delta = render.leadInFrames - freeze.leadInFrames;
  return Number.isInteger(delta) && delta % WEB_AUDIO_RENDER_QUANTUM_FRAMES === 0;
};

/** Drops a malformed `freeze` record from a loaded channel; valid ones pass through untouched. */
export const normalizeChannelFreeze = <T extends { freeze?: unknown }>(channel: T): T => {
  if (!isRecord(channel) || !('freeze' in channel) || channel.freeze === undefined) return channel;
  if (isChannelFreezeRecord(channel.freeze)) return channel;
  const { freeze: _dropped, ...rest } = channel;
  return rest as T;
};

export const resolveChannelFreezeStatus = (
  channel: Channel,
  source: ChannelFreezeSource,
): ChannelFreezeStatus => {
  const freeze = channel.freeze;
  if (!freeze) return 'none';
  if (freeze.audioUnavailable === true) return 'missing-audio';
  return computeChannelFreezeFingerprint(channel, source) === freeze.sourceFingerprint ? 'frozen' : 'stale';
};

/**
 * Channels whose frozen audio replaces their instrument for this timeline.
 * `hasAudio` answers whether the engine actually holds the asset; without it a
 * channel is never selected, so a missing buffer can only ever fall back to the
 * original instrument.
 */
export const resolveActiveChannelFreezes = (
  channels: readonly Channel[],
  source: ChannelFreezeSource,
  hasAudio: (audioBufferId: string) => boolean,
  /** Extra condition an offline render applies; see `isChannelFreezeSampleExact`. */
  accepts: (freeze: ChannelFreeze) => boolean = () => true,
): Map<string, ChannelFreeze> => {
  const active = new Map<string, ChannelFreeze>();
  for (const channel of channels) {
    if (!channel.freeze) continue;
    if (resolveChannelFreezeStatus(channel, source) !== 'frozen') continue;
    if (!hasAudio(channel.freeze.audioBufferId)) continue;
    if (!accepts(channel.freeze)) continue;
    active.set(channel.id, channel.freeze);
  }
  return active;
};

/** Why a channel cannot be frozen right now, or `null` when it can. */
export const getChannelFreezeBlocker = (
  channel: Channel,
  source: ChannelFreezeSource,
): string | null => {
  if (channel.midiOutput?.mode === 'external') {
    return 'This channel only sends external MIDI, so it has no internal audio to freeze.';
  }
  if (audiblePatternClips(channel, source).length === 0) {
    return 'Nothing to freeze: no unmuted pattern clip plays this channel in the Song timeline.';
  }
  return null;
};

export const channelFreezeSourceFromProject = (state: ProjectState): ChannelFreezeSource => ({
  clips: state.playlistClips,
  patterns: state.patterns,
  playlistTracks: state.playlistTracks,
  bpm: state.meta.bpm,
  swing: state.meta.swing,
  meter: resolveProjectTimeSignature(state.meta),
});

export const createChannelFreezeBufferId = (channelId: string, now: number = Date.now()): string =>
  `${CHANNEL_FREEZE_BUFFER_PREFIX}${channelId}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Attaches a freeze record. Returns the same state when the channel is gone. */
export const applyChannelFreeze = (
  state: ProjectState,
  channelId: string,
  freeze: ChannelFreeze,
): ProjectState => {
  if (!state.channels.some(channel => channel.id === channelId)) return state;
  return {
    ...state,
    channels: state.channels.map(channel => (channel.id === channelId ? { ...channel, freeze: { ...freeze } } : channel)),
  };
};

/** Removes a freeze record and nothing else. Returns the same state when there is none. */
export const removeChannelFreeze = (state: ProjectState, channelId: string): ProjectState => {
  const target = state.channels.find(channel => channel.id === channelId);
  if (!target?.freeze) return state;
  return {
    ...state,
    channels: state.channels.map(channel => {
      if (channel.id !== channelId) return channel;
      const { freeze: _removed, ...rest } = channel;
      return rest as Channel;
    }),
  };
};

/** Audio assets the project's freeze records reference. */
export const collectChannelFreezeAudioIds = (state: Pick<ProjectState, 'channels'>): string[] => {
  const ids: string[] = [];
  for (const channel of Array.isArray(state.channels) ? state.channels : []) {
    const id = channel?.freeze?.audioBufferId;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
};

/** Marks each freeze record available / unavailable after audio hydration. */
export const markChannelFreezeAvailability = (
  channels: readonly Channel[],
  missingIds: ReadonlySet<string>,
): Channel[] => channels.map(channel => {
  const freeze = channel.freeze;
  if (!freeze) return channel;
  const unavailable = missingIds.has(freeze.audioBufferId);
  if ((freeze.audioUnavailable === true) === unavailable) return channel;
  const next: ChannelFreeze = { ...freeze };
  if (unavailable) next.audioUnavailable = true; else delete next.audioUnavailable;
  return { ...channel, freeze: next };
});

export interface ChannelFreezeTailAnalysis {
  /** Frames to keep: everything up to the last sample above the silence floor. */
  trimmedFrameCount: number;
  tailDecayed: boolean;
  peak: number;
}

/**
 * Finds where a freeze render falls silent and whether it had decayed by its
 * last frame. `channelData` is one Float32Array per audio channel.
 */
export const analyzeChannelFreezeRender = (
  channelData: readonly Float32Array[],
  sampleRate: number,
): ChannelFreezeTailAnalysis => {
  const length = channelData.reduce((max, data) => Math.max(max, data.length), 0);
  let lastAudible = -1;
  let peak = 0;
  for (const data of channelData) {
    for (let index = 0; index < data.length; index += 1) {
      const magnitude = Math.abs(data[index]);
      if (magnitude > peak) peak = magnitude;
      if (magnitude > 1e-7 && index > lastAudible) lastAudible = index;
    }
  }
  const window = Math.max(1, Math.round(sampleRate * 0.05));
  let endPeak = 0;
  for (const data of channelData) {
    for (let index = Math.max(0, data.length - window); index < data.length; index += 1) {
      endPeak = Math.max(endPeak, Math.abs(data[index]));
    }
  }
  // Keep a few milliseconds past the last audible sample so the end is not a hard cut.
  const padding = Math.round(sampleRate * 0.01);
  return {
    trimmedFrameCount: Math.max(1, Math.min(length, lastAudible + 1 + padding)),
    tailDecayed: endPeak <= CHANNEL_FREEZE_DECAY_THRESHOLD,
    peak,
  };
};
