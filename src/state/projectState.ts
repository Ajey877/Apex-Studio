import type { ProjectState } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { createDefaultMixerTracks, createDefaultPlaylistTracks } from '../audio/presets';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => structuredClone(value);

/** Creates a fresh blank project state with no shared mutable project data. */
export const createDefaultProjectState = (): ProjectState => {
  const now = Date.now();
  const synthParams = audioEngine.getDefaultSynthParams();

  return {
    meta: {
      id: `proj-${now}`,
      name: 'Untitled Session',
      author: 'Studio Producer',
      bpm: 128,
      timeSignature: [4, 4],
      swing: 0,
      masterVolume: 1.0,
      masterPitch: 0,
      created: now,
      updated: now,
      version: '4.5.2 Pro',
      isEncrypted: true,
      cloudSynced: true,
      offlineReady: true,
      totalEditTimeSeconds: 0
    },
    patterns: [{ id: 'pat-1', name: 'Pattern 1', color: '#ff6e00', lengthSteps: 16 }],
    selectedPatternId: 'pat-1',
    channels: [
      {
        id: 'ch-1',
        name: '808 Kick Sub',
        color: '#ff6e00',
        instrumentType: 'drumpad',
        mixerTrackId: 1,
        volume: 0.95,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
        notes: [],
        synthParams: clone(synthParams)
      },
      {
        id: 'ch-2',
        name: 'Snare Hard',
        color: '#ff9800',
        instrumentType: 'drumpad',
        mixerTrackId: 2,
        volume: 0.85,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        steps: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
        notes: [],
        synthParams: clone(synthParams)
      }
    ],
    selectedChannelId: 'ch-1',
    mixerTracks: clone(createDefaultMixerTracks()),
    selectedMixerTrackId: 0,
    playlistTracks: clone(createDefaultPlaylistTracks()),
    playlistClips: [],
    recordings: [],
    comments: [],
    collaborators: [],
    midiMappings: []
  };
};

/**
 * Normalizes parsed project data at the persistence boundary.
 * It preserves supplied valid data while filling missing fields from a fresh default project.
 */
export const normalizeProjectState = (input: unknown): ProjectState => {
  if (!isRecord(input)) {
    throw new Error('Invalid project file: expected a project object.');
  }

  const defaults = createDefaultProjectState();
  const candidate = clone(input);

  if ('meta' in candidate && candidate.meta !== undefined && !isRecord(candidate.meta)) {
    throw new Error('Invalid project file: metadata is malformed.');
  }
  if ('patterns' in candidate && candidate.patterns !== undefined && !Array.isArray(candidate.patterns)) {
    throw new Error('Invalid project file: patterns must be an array.');
  }
  if ('channels' in candidate && candidate.channels !== undefined && !Array.isArray(candidate.channels)) {
    throw new Error('Invalid project file: channels must be an array.');
  }
  if ('playlistTracks' in candidate && candidate.playlistTracks !== undefined && !Array.isArray(candidate.playlistTracks)) {
    throw new Error('Invalid project file: playlist tracks must be an array.');
  }
  if ('playlistClips' in candidate && candidate.playlistClips !== undefined && !Array.isArray(candidate.playlistClips)) {
    throw new Error('Invalid project file: playlist clips must be an array.');
  }
  if ('mixerTracks' in candidate && candidate.mixerTracks !== undefined && !Array.isArray(candidate.mixerTracks)) {
    throw new Error('Invalid project file: mixer tracks must be an array.');
  }
  if ('recordings' in candidate && candidate.recordings !== undefined && !Array.isArray(candidate.recordings)) {
    throw new Error('Invalid project file: recordings must be an array.');
  }
  if ('comments' in candidate && candidate.comments !== undefined && !Array.isArray(candidate.comments)) {
    throw new Error('Invalid project file: comments must be an array.');
  }
  if ('collaborators' in candidate && candidate.collaborators !== undefined && !Array.isArray(candidate.collaborators)) {
    throw new Error('Invalid project file: collaborators must be an array.');
  }
  if ('midiMappings' in candidate && candidate.midiMappings !== undefined && !Array.isArray(candidate.midiMappings)) {
    throw new Error('Invalid project file: MIDI mappings must be an array.');
  }

  const normalized: ProjectState = {
    ...defaults,
    ...candidate,
    meta: {
      ...defaults.meta,
      ...(candidate.meta as Partial<ProjectState['meta']> | undefined)
    },
    patterns: Array.isArray(candidate.patterns) ? clone(candidate.patterns) : defaults.patterns,
    channels: Array.isArray(candidate.channels) ? clone(candidate.channels) : defaults.channels,
    playlistTracks: Array.isArray(candidate.playlistTracks) ? clone(candidate.playlistTracks) : defaults.playlistTracks,
    playlistClips: Array.isArray(candidate.playlistClips) ? clone(candidate.playlistClips) : defaults.playlistClips,
    mixerTracks: Array.isArray(candidate.mixerTracks) ? clone(candidate.mixerTracks) : defaults.mixerTracks,
    recordings: Array.isArray(candidate.recordings) ? clone(candidate.recordings) : defaults.recordings,
    comments: Array.isArray(candidate.comments) ? clone(candidate.comments) : defaults.comments,
    collaborators: Array.isArray(candidate.collaborators) ? clone(candidate.collaborators) : defaults.collaborators,
    midiMappings: Array.isArray(candidate.midiMappings) ? clone(candidate.midiMappings) : defaults.midiMappings,
    selectedPatternId: typeof candidate.selectedPatternId === 'string'
      ? candidate.selectedPatternId
      : defaults.selectedPatternId,
    selectedChannelId: typeof candidate.selectedChannelId === 'string'
      ? candidate.selectedChannelId
      : (candidate.channels && Array.isArray(candidate.channels) && candidate.channels[0]?.id) || defaults.selectedChannelId,
    selectedMixerTrackId: typeof candidate.selectedMixerTrackId === 'number'
      ? candidate.selectedMixerTrackId
      : defaults.selectedMixerTrackId
  };

  if (!normalized.meta.id || !normalized.meta.name || !Number.isFinite(normalized.meta.bpm)) {
    throw new Error('Invalid project file: required project metadata is missing or malformed.');
  }

  return normalized;
};
