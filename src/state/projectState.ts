import type { GrossBeatState, ProjectState, Channel, PlaylistClip } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { createDefaultMixerTracks, createDefaultPlaylistTracks } from '../audio/presets';
import { markAudioClipsMissingBufferId } from './playlistClipIntegrity';

/**
 * Phase 79: default Gross Beat gate state used when the persisted project has
 * no grossBeatState field (pre-migration documents) or when the field is
 * malformed. Must match audioEngine's initial state exactly so that
 * bootstrapping a fresh project leaves the engine in sync.
 *
 * Inlined (rather than re-exporting `grossBeatAlternatingSteps`) to avoid a
 * circular import at module load — projectState.ts is loaded very early by
 * presets and tests, and pulling in audioEngine via grossBeatGate creates a
 * TDZ cycle when a test imports the modal first.
 */
const DEFAULT_GROSS_BEAT_STEPS: boolean[] = [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false];
export const DEFAULT_GROSS_BEAT_STATE: GrossBeatState = {
  enabled: false,
  mix: 1.0,
  gateSteps: DEFAULT_GROSS_BEAT_STEPS,
};

const isGrossBeatState = (v: unknown): v is GrossBeatState => {
  if (!isRecord(v)) return false;
  if (typeof v.enabled !== 'boolean') return false;
  if (typeof v.mix !== 'number' || !Number.isFinite(v.mix)) return false;
  if (!Array.isArray(v.gateSteps) || v.gateSteps.length !== 16) return false;
  return v.gateSteps.every(step => typeof step === 'boolean');
};

/**
 * Phase 79: strip obsolete audio-affecting fields from legacy documents so
 * they can no longer masquerade as real DSP. These helpers are called on
 * channels / clips / mixer tracks during normalizeProjectState so:
 *   - old project files still load (no throw);
 *   - the obsolete fields DO NOT survive into the normalized ProjectState;
 *   - subsequent re-saves will not emit them.
 *
 * When a real consumer is ever added for a field, remove the strip for that
 * field and wire it up — do NOT add a new persisted audio field without
 * registering it in the consumer-invariant test (see
 * phase79.projectStateConsumers.test.ts).
 */

// Obsolete fields on Channel.synthParams that were persisted but never read by
// any audio engine path. Drop them from legacy synthParams on load.
const OBSOLETE_SYNTH_PARAM_KEYS = ['unisonSpread'] as const;

function stripObsoleteChannelFields<C extends { synthParams?: Record<string, unknown> | null }>(channel: C): C {
  if (!channel.synthParams || typeof channel.synthParams !== 'object') return channel;
  let cleaned: Record<string, unknown> | undefined;
  for (const key of OBSOLETE_SYNTH_PARAM_KEYS) {
    if (key in channel.synthParams) {
      if (!cleaned) cleaned = { ...channel.synthParams };
      delete cleaned[key];
    }
  }
  if (!cleaned) return channel;
  return { ...channel, synthParams: cleaned as C['synthParams'] };
}

// Obsolete fields on mixer tracks (stereoWidth, inert sidechain fields).
export const MAX_AUX_SENDS_PER_TRACK = 2;

export const clampAuxSendAmount = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
};

export const normalizeAuxSendsForTrack = (
  track: { id: number; auxSends?: unknown; sends?: unknown },
  validTargetIds: Set<number>,
  preferredAuxIds?: number[]
): Array<{ targetId: number; amount: number }> | undefined => {
  const rawAux = (track as unknown as { auxSends?: unknown }).auxSends;
  const rawLegacy = (track as unknown as { sends?: unknown }).sends;
  let candidates: Array<{ targetId: number; amount: number }> = [];

  if (Array.isArray(rawAux)) {
    for (const entry of rawAux) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const targetId = rec.targetId;
      const amount = clampAuxSendAmount(rec.amount);
      if (!Number.isInteger(targetId) || amount === null) continue;
      if (targetId === track.id) continue;
      if (targetId === 0) continue; // Master cannot be aux target (no wet tail)
      if (!validTargetIds.has(targetId as number)) continue;
      candidates.push({ targetId: targetId as number, amount });
    }
  } else if (
    rawLegacy &&
    typeof rawLegacy === 'object' &&
    !Array.isArray(rawLegacy)
  ) {
    const legacy = rawLegacy as Record<string, unknown>;
    const s1 = clampAuxSendAmount(legacy.send1);
    const s2 = clampAuxSendAmount(legacy.send2);
    // Legacy sends had no target; prefer explicit aux returns, else
    // first two non-self inserts. If no candidate exists, the non-zero send
    // is preserved as an amount to the first valid aux target slot and will
    // be dropped by the validTargetIds check if none exists — caller may
    // lazily create returns for legacy migration.
    const preferred = (preferredAuxIds ?? []).filter(id => id !== track.id && validTargetIds.has(id));
    const fallback = [...validTargetIds].filter(id => id !== track.id && id !== 0).sort((a, b) => a - b);
    const auxTargets = preferred.length > 0 ? preferred : fallback;
    if (s1 !== null && s1 > 0 && auxTargets[0] !== undefined) {
      candidates.push({ targetId: auxTargets[0], amount: s1 });
    }
    if (s2 !== null && s2 > 0 && auxTargets[1] !== undefined) {
      candidates.push({ targetId: auxTargets[1], amount: s2 });
    } else if (s2 !== null && s2 > 0 && auxTargets[0] !== undefined && candidates.length === 0) {
      // Only one aux target available — map send2 there if send1 empty
      candidates.push({ targetId: auxTargets[0], amount: s2 });
    }
  }

  // Deduplicate by targetId, keep first, cap at 2
  const seen = new Set<number>();
  const deduped: Array<{ targetId: number; amount: number }> = [];
  for (const c of candidates) {
    if (seen.has(c.targetId)) continue;
    seen.add(c.targetId);
    deduped.push(c);
    if (deduped.length >= MAX_AUX_SENDS_PER_TRACK) break;
  }
  if (deduped.length === 0) return undefined;
  return deduped;
};

export const normalizeAuxSendReferences = (project: ProjectState): ProjectState => {
  const validIds = new Set(project.mixerTracks.map(t => t.id));
  const preferredAuxIds = project.mixerTracks.filter(t => (t as unknown as { isAux?: unknown }).isAux === true).map(t => t.id).sort((a, b) => a - b);
  let changed = false;
  const nextTracks = project.mixerTracks.map(track => {
    const normalized = normalizeAuxSendsForTrack(track as unknown as { id: number; auxSends?: unknown; sends?: unknown }, validIds, preferredAuxIds);
    const current = (track as unknown as { auxSends?: unknown }).auxSends as Array<{ targetId: number; amount: number }> | undefined;
    const currentNormalized = current && Array.isArray(current) ? current : undefined;
    const equal = (a: typeof normalized, b: typeof currentNormalized): boolean => {
      if (a === undefined && b === undefined) return true;
      if (!a || !b) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i].targetId !== b[i].targetId) return false;
        if (Math.abs(a[i].amount - b[i].amount) > 1e-6) return false;
      }
      return true;
    };
    const hasLegacySends = (track as unknown as { sends?: unknown }).sends !== undefined;
    const hasMalformedIsAux = ('isAux' in track) && (typeof (track as unknown as { isAux: unknown }).isAux !== 'boolean' || (track.id === 0 && (track as unknown as { isAux: boolean }).isAux === true));
    if (equal(normalized, currentNormalized) && !hasLegacySends && !hasMalformedIsAux) {
      return track;
    }
    if (equal(normalized, currentNormalized)) {
      // AuxSends already equal but we still need to strip legacy `sends` or fix isAux
      changed = true;
      const next: Record<string, unknown> = { ...track };
      if (hasLegacySends) delete next.sends;
      if ('isAux' in next) {
        if (track.id === 0) delete next.isAux;
        else if (typeof next.isAux !== 'boolean') {
          if (next.isAux) next.isAux = true; else delete next.isAux;
        }
      }
      return next as unknown as typeof track;
    }
    changed = true;
    const next: Record<string, unknown> = { ...track };
    if (normalized === undefined) {
      delete next.auxSends;
    } else {
      next.auxSends = normalized;
    }
    // Legacy `sends` is stripped once we have a normalized auxSends or even if we drop it entirely
    if ('sends' in next) delete next.sends;
    if ('isAux' in next) {
      if (track.id === 0) delete next.isAux;
      else if (typeof next.isAux !== 'boolean') {
        if (next.isAux) next.isAux = true; else delete next.isAux;
      }
    }
    return next as unknown as typeof track;
  });

  // Ensure any aux target that was referenced but missing does not create phantom — already dropped.
  // No auto-creation here; migration that needs new returns is handled separately.
  if (!changed) return project;
  return { ...project, mixerTracks: nextTracks };
};

export const migrateLegacySendsToAuxSends = (project: ProjectState): ProjectState => {
  // Detect legacy projects where at least one track has `sends` with non-zero
  // but no valid auxSends target exists. We synthesize up to 2 aux return
  // tracks (isAux:true) so the legacy amount has a destination instead of
  // being silently dropped. This mirrors the Phase 88 requirement that
  // existing inert send1/send2 values must no longer be ignored.
  const hasLegacy = project.mixerTracks.some(t => {
    const s = (t as unknown as { sends?: { send1?: unknown; send2?: unknown } }).sends;
    if (!s || typeof s !== 'object') return false;
    const a1 = typeof s.send1 === 'number' && Number.isFinite(s.send1) ? s.send1 : 0;
    const a2 = typeof s.send2 === 'number' && Number.isFinite(s.send2) ? s.send2 : 0;
    return (a1 > 0 || a2 > 0) && !(Array.isArray((t as unknown as { auxSends?: unknown }).auxSends) && (t as unknown as { auxSends: unknown[] }).auxSends.length > 0);
  });
  if (!hasLegacy) return project;

  // Ensure at least 2 aux returns exist; create them if missing.
  const existingIds = new Set(project.mixerTracks.map(t => t.id));
  const auxReturnCandidates = project.mixerTracks.filter(t => (t as unknown as { isAux?: unknown }).isAux === true).map(t => t.id).sort((a, b) => a - b);
  let nextId = Math.max(0, ...project.mixerTracks.map(t => t.id)) + 1;
  const ensureReturn = (index: number): number => {
    if (auxReturnCandidates[index] !== undefined && existingIds.has(auxReturnCandidates[index])) {
      return auxReturnCandidates[index];
    }
    // Reuse spare insert ids 8,9 if free, else allocate nextId
    const preferred = 8 + index;
    if (!existingIds.has(preferred)) {
      existingIds.add(preferred);
      return preferred;
    }
    while (existingIds.has(nextId)) nextId++;
    const id = nextId++;
    existingIds.add(id);
    return id;
  };

  const needed = hasLegacy ? 2 : 0;
  const returnIds: number[] = [];
  for (let i = 0; i < needed; i++) returnIds.push(ensureReturn(i));

  // Create missing return tracks
  const missingReturns: typeof project.mixerTracks = [];
  for (let i = 0; i < returnIds.length; i++) {
    const id = returnIds[i];
    if (project.mixerTracks.some(t => t.id === id)) continue;
    const name = i === 0 ? 'Reverb Return' : 'Delay Return';
    const color = i === 0 ? '#7e57c2' : '#00acc1';
    const fx = i === 0
      ? [{ id: `fx-${id}-verb`, type: 'reverb' as const, name: 'Studio Reverb', enabled: true, mix: 1.0, params: { roomSize: 0.7, decay: 2.0 } }]
      : [{ id: `fx-${id}-delay`, type: 'delay' as const, name: 'Tape Delay', enabled: true, mix: 0.6, params: { time: 0.35, feedback: 0.4 } }];
    missingReturns.push({
      id,
      name,
      color,
      volume: 0.85,
      pan: 0,
      mute: false,
      solo: false,
      peakL: 0,
      peakR: 0,
      fxSlots: fx as unknown as typeof fx,
      isAux: true,
    } as unknown as typeof project.mixerTracks[0]);
  }

  if (missingReturns.length === 0) return project;
  return {
    ...project,
    mixerTracks: [...project.mixerTracks, ...missingReturns],
  };
};

function stripObsoleteMixerTrackFields<T extends { stereoWidth?: unknown; sidechain?: Record<string, unknown> | null }>(track: T): T {
  const next: Record<string, unknown> = { ...track };
  delete next.stereoWidth;
  if (track.sidechain && typeof track.sidechain === 'object') {
    const sc = { ...track.sidechain };
    // threshold/lowFreqOnly/highPassFilterHz/gainReductionDb are inert UI ghosts.
    delete sc.threshold;
    delete sc.lowFreqOnly;
    delete sc.highPassFilterHz;
    delete sc.gainReductionDb;
    next.sidechain = sc as T['sidechain'];
  }
  return next as T;
}

// Obsolete fields on PlaylistClip.
function stripObsoleteClipFields(clip: PlaylistClip): PlaylistClip {
  // Cast-then-omit: spatialAudio is no longer on the PlaylistClip type so we
  // strip via a record intermediate. Legacy objects parsed from JSON may still
  // carry the key; we must drop it.
  const legacy = clip as unknown as Record<string, unknown>;
  if (!('spatialAudio' in legacy)) return clip;
  const { spatialAudio: _dropped, ...rest } = legacy;
  return rest as unknown as PlaylistClip;
}
import { DEFAULT_TIMELINE_BARS, normalizeTimelineBars, revalidateProjectTimeline } from './playlistTimeline';
import {
  MASTER_MIXER_TRACK_ID,
  deriveNextMixerTrackId,
  findDuplicateMixerTrackIdentities,
  normalizeNextMixerTrackId,
  normalizeMixerTrackIdentityIntegrity
} from './mixerTrackIdentity';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => structuredClone(value);

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Normalizes mixer routing references at the project-state boundary.
 * Master (0) is always valid; every other target must be an existing mixer track.
 * Valid routes are preserved; malformed or stale references fall back to Master.
 */
export const normalizeMixerRoutingReferences = (project: ProjectState): ProjectState => {
  const mixerTrackIds = new Set(project.mixerTracks.map(track => track.id));
  const mixerTracks = project.mixerTracks.map(track => {
    const targetId = track.routingTargetId;
    const normalizedTargetId =
      targetId === undefined || targetId === 0
        ? 0
        : Number.isInteger(targetId) && mixerTrackIds.has(targetId)
          ? targetId
          : 0;

    return track.routingTargetId === normalizedTargetId
      ? track
      : { ...track, routingTargetId: normalizedTargetId };
  });

  return mixerTracks === project.mixerTracks ? project : { ...project, mixerTracks };
};
const assertArrayOfRecords = (value: unknown, label: string, validator?: (entry: Record<string, unknown>) => boolean): void => {
  if (!Array.isArray(value)) throw new Error(`Invalid project file: ${label} must be an array.`);
  if (validator && value.some(entry => !isRecord(entry) || !validator(entry))) {
    throw new Error(`Invalid project file: ${label} contains malformed entries.`);
  }
};

const isMarker = (entry: Record<string, unknown>): boolean =>
  typeof entry.id === 'string' &&
  typeof entry.name === 'string' &&
  Number.isFinite(entry.bar) &&
  typeof entry.color === 'string';

const isMidiDevice = (entry: Record<string, unknown>): boolean =>
  typeof entry.id === 'string' &&
  typeof entry.name === 'string' &&
  typeof entry.state === 'string' &&
  (entry.type === 'input' || entry.type === 'output') &&
  (entry.manufacturer === undefined || typeof entry.manufacturer === 'string');

const isMacroKnob = (entry: Record<string, unknown>): boolean =>
  typeof entry.id === 'string' &&
  typeof entry.name === 'string' &&
  Number.isFinite(entry.value) &&
  typeof entry.color === 'string' &&
  Array.isArray(entry.mappings);

const isVocalTuner = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return typeof value.enabled === 'boolean' &&
    typeof value.scale === 'string' &&
    Number.isInteger(value.rootKey) &&
    Number.isFinite(value.retuneSpeedMs) &&
    Number.isFinite(value.formantShift) &&
    Number.isFinite(value.vibratoDepth) &&
    Number.isFinite(value.humanize);
};


/** Creates a fresh blank project state with no shared mutable project data. */
export const createDefaultProjectState = (): ProjectState => {
  const now = Date.now();
  const synthParams = audioEngine.getDefaultSynthParams();

  const project: ProjectState = {
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
      offlineReady: true,
      totalEditTimeSeconds: 0
    },
    patterns: [{ id: 'pat-1', name: 'Pattern 1', color: '#ff6e00', lengthSteps: 16 }],
    selectedPatternId: 'pat-1',
    sampleLibrary: [],
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
    nextMixerTrackId: 1,
    playlistTracks: clone(createDefaultPlaylistTracks()),
    playlistClips: [],
    totalBars: DEFAULT_TIMELINE_BARS,
    recordings: [],
    comments: [],
    collaborators: [],
    midiMappings: [],
    // Phase 79: Gross Beat is owned by ProjectState (like macroKnobs); the
    // engine reads from this on load/undo/redo instead of holding its own
    // private truth, so save/load round-trips and project replacement all
    // preserve the gate pattern.
    grossBeatState: { ...DEFAULT_GROSS_BEAT_STATE, gateSteps: [...DEFAULT_GROSS_BEAT_STATE.gateSteps] }
  };

  return {
    ...project,
    nextMixerTrackId: deriveNextMixerTrackId(project)
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
  if ('sampleLibrary' in candidate && candidate.sampleLibrary !== undefined && !Array.isArray(candidate.sampleLibrary)) {
    throw new Error('Invalid project file: sample library must be an array.');
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
  if ('connectedMidiDevices' in candidate && candidate.connectedMidiDevices !== undefined) {
    assertArrayOfRecords(candidate.connectedMidiDevices, 'connected MIDI devices', isMidiDevice);
  }
  if ('markers' in candidate && candidate.markers !== undefined) {
    assertArrayOfRecords(candidate.markers, 'markers', isMarker);
  }
  if ('macroKnobs' in candidate && candidate.macroKnobs !== undefined) {
    assertArrayOfRecords(candidate.macroKnobs, 'macro knobs', isMacroKnob);
  }
  if ('grossBeatState' in candidate && candidate.grossBeatState !== undefined && !isGrossBeatState(candidate.grossBeatState)) {
    throw new Error('Invalid project file: Gross Beat state is malformed (expected 16-step boolean grid).');
  }
  if ('vocalTuner' in candidate && candidate.vocalTuner !== undefined && !isVocalTuner(candidate.vocalTuner)) {
    throw new Error('Invalid project file: vocal tuner settings are malformed.');
  }

  const normalized: ProjectState = {
    ...defaults,
    ...candidate,
    meta: {
      ...defaults.meta,
      ...(candidate.meta as Partial<ProjectState['meta']> | undefined)
    },
    patterns: Array.isArray(candidate.patterns) ? clone(candidate.patterns) : defaults.patterns,
    sampleLibrary: Array.isArray(candidate.sampleLibrary)
      ? clone(candidate.sampleLibrary)
      : clone((Array.isArray(candidate.channels) ? candidate.channels : defaults.channels)
        .map(channel => channel.customSample)
        .filter((sample): sample is NonNullable<typeof sample> => Boolean(sample?.id))),
    // Phase 79 backward-compat: strip obsolete `unisonSpread` from every
    // channel's synthParams if an older project saved it. The field was never
    // consumed by any DSP and must not round-trip back out on the next save.
    channels: (Array.isArray(candidate.channels) ? clone(candidate.channels) : defaults.channels)
      .map(stripObsoleteChannelFields),
    playlistTracks: Array.isArray(candidate.playlistTracks) ? clone(candidate.playlistTracks) : defaults.playlistTracks,
    // Phase 48 legacy recovery: an audio clip that reached persistence without
    // an `audioBufferId` (an older build could publish one) is silent, blocks
    // WAV/stem export, and was invisible. Flag it so the existing Phase 8C
    // badge, banner and remediation text explain it. Never deleted, never
    // given an invented buffer id.
    playlistClips: Array.isArray(candidate.playlistClips)
      ? markAudioClipsMissingBufferId(clone(candidate.playlistClips) as PlaylistClip[])
          .map(stripObsoleteClipFields)
      : defaults.playlistClips,
    mixerTracks: (Array.isArray(candidate.mixerTracks) ? clone(candidate.mixerTracks) : defaults.mixerTracks)
      .map(stripObsoleteMixerTrackFields),
    recordings: Array.isArray(candidate.recordings) ? clone(candidate.recordings) : defaults.recordings,
    comments: Array.isArray(candidate.comments) ? clone(candidate.comments) : defaults.comments,
    collaborators: Array.isArray(candidate.collaborators) ? clone(candidate.collaborators) : defaults.collaborators,
    midiMappings: Array.isArray(candidate.midiMappings) ? clone(candidate.midiMappings) : defaults.midiMappings,
    connectedMidiDevices: Array.isArray(candidate.connectedMidiDevices) ? clone(candidate.connectedMidiDevices) : [],
    markers: Array.isArray(candidate.markers) ? clone(candidate.markers) : [],
    // Phase 54: an absent or malformed length resolves to the default here and
    // the arrangement is revalidated against it before the document is handed
    // back (see the `revalidateProjectTimeline` wrap on the return value).
    totalBars: normalizeTimelineBars(candidate.totalBars),
    macroKnobs: Array.isArray(candidate.macroKnobs) ? clone(candidate.macroKnobs) : [],
    grossBeatState: isGrossBeatState(candidate.grossBeatState)
      ? { ...clone(candidate.grossBeatState) as GrossBeatState, mix: clamp01((candidate.grossBeatState as GrossBeatState).mix) }
      : { ...DEFAULT_GROSS_BEAT_STATE, gateSteps: [...DEFAULT_GROSS_BEAT_STATE.gateSteps] },
    vocalTuner: candidate.vocalTuner === undefined ? undefined : clone(candidate.vocalTuner) as ProjectState['vocalTuner'],
    selectedPatternId: typeof candidate.selectedPatternId === 'string'
      ? candidate.selectedPatternId
      : defaults.selectedPatternId,
    selectedChannelId: typeof candidate.selectedChannelId === 'string'
      ? candidate.selectedChannelId
      : (candidate.channels && Array.isArray(candidate.channels) && candidate.channels[0]?.id) || defaults.selectedChannelId,
    selectedMixerTrackId: typeof candidate.selectedMixerTrackId === 'number'
      ? candidate.selectedMixerTrackId
      : defaults.selectedMixerTrackId,
    nextMixerTrackId: 1
  };

  const identityNormalized = normalizeMixerTrackIdentityIntegrity(normalized);
  const routingNormalized = normalizeMixerRoutingReferences(identityNormalized);
  const legacyMigrated = migrateLegacySendsToAuxSends(routingNormalized);
  const auxNormalized = normalizeAuxSendReferences(legacyMigrated);

  const duplicateIdentities = findDuplicateMixerTrackIdentities(auxNormalized);
  if (duplicateIdentities.length > 0) {
    throw new Error(
      `[Apex Studio] Project contains duplicate mixer identities after normalization: ${duplicateIdentities.join(', ')}`
    );
  }

  if (!normalized.meta.id || !normalized.meta.name || !Number.isFinite(normalized.meta.bpm)) {
    throw new Error('Invalid project file: required project metadata is missing or malformed.');
  }

  return revalidateProjectTimeline({
    ...auxNormalized,
    nextMixerTrackId: normalizeNextMixerTrackId(auxNormalized, candidate.nextMixerTrackId)
  });
};

export interface DeleteChannelResult {
  state: ProjectState;
  deletedChannel: Channel | null;
  removedMixerTrackId: number | null;
}

/**
 * Pure state transition for channel deletion:
 * - Preserves the final channel (minimum 1 channel).
 * - Removes the channel from channels list.
 * - Removes orphaned MixerTrack if no other surviving channel references it (and not Master track 0).
 * - Updates selectedChannelId if deleted channel was selected.
 * - Resets selectedMixerTrackId to 0 if removed mixer track was selected.
 */
export const deleteChannelFromProjectState = (
  project: ProjectState,
  channelId: string
): DeleteChannelResult => {
  if (project.channels.length <= 1) {
    return {
      state: project,
      deletedChannel: null,
      removedMixerTrackId: null
    };
  }

  const channelToDelete = project.channels.find(ch => ch.id === channelId);
  if (!channelToDelete) {
    return {
      state: project,
      deletedChannel: null,
      removedMixerTrackId: null
    };
  }

  const trackId = channelToDelete.mixerTrackId;
  const remainingChannels = project.channels.filter(ch => ch.id !== channelId);
  const isTrackStillReferenced =
    trackId === MASTER_MIXER_TRACK_ID || remainingChannels.some(ch => ch.mixerTrackId === trackId);

  const nextMixerTracks = isTrackStillReferenced
    ? project.mixerTracks.map(t => {
        // Even when the deleted track itself is retained (shared), other tracks
        // that sent to it via aux must not retain a stale target.
        if (!t.auxSends) return t;
        const filtered = t.auxSends.filter(s => s.targetId !== trackId);
        if (filtered.length === t.auxSends.length) return t;
        return { ...t, auxSends: filtered.length === 0 ? undefined : filtered };
      })
    : project.mixerTracks
      .filter(t => t.id !== trackId)
      .map(t => {
        let next: typeof t = t;
        if (t.routingTargetId === trackId) next = { ...next, routingTargetId: MASTER_MIXER_TRACK_ID };
        if (t.auxSends) {
          const filtered = t.auxSends.filter(s => s.targetId !== trackId);
          if (filtered.length !== t.auxSends.length) {
            next = { ...next, auxSends: filtered.length === 0 ? undefined : filtered };
          }
        }
        return next;
      });

  const nextSelectedChannelId =
    project.selectedChannelId === channelId
      ? remainingChannels[0]?.id || 'ch-1'
      : project.selectedChannelId;

  const nextSelectedMixerTrackId =
    !isTrackStillReferenced && project.selectedMixerTrackId === trackId
      ? MASTER_MIXER_TRACK_ID
      : project.selectedMixerTrackId;

  return {
    state: {
      ...project,
      channels: remainingChannels,
      mixerTracks: nextMixerTracks,
      selectedChannelId: nextSelectedChannelId,
      selectedMixerTrackId: nextSelectedMixerTrackId
    },
    deletedChannel: channelToDelete,
    removedMixerTrackId: isTrackStillReferenced ? null : trackId
  };
};

