import type { Channel, Note, Pattern, PatternChannelContent, PlaylistClip, ProjectState } from '../types/daw';

/**
 * Independent patterns — the single owner of pattern-scoped sequencer content.
 *
 * Before this module every pattern shared ONE set of channel content. The
 * Channel Rack showed `Channel.steps` / `Channel.notes` whichever pattern tab
 * was selected, so "Add pattern" produced a pattern that already contained the
 * whole beat, editing "Pattern 2" silently rewrote "Pattern 1", and the
 * playlist had no way to place a different pattern for the same instrument.
 *
 * Model
 * -----
 * - The SELECTED pattern's content is the live `Channel.steps` /
 *   `Channel.notes`. Everything that edits or plays "the pattern" — Channel
 *   Rack, Piano Roll, MIDI import, MIDI recording, Audio Slicer mapping,
 *   Pattern Mode, Pattern-loop export — keeps reading/writing the channel.
 * - Every other pattern stores its own content in `Pattern.channelContent`
 *   (one entry per channel; a channel without an entry is empty there).
 * - A pattern WITHOUT `channelContent` plays the live content. That is the
 *   selected pattern, and — in documents saved before patterns were
 *   independent — every pattern, because they all shared it. Loading such a
 *   document therefore changes nothing audible or visible, and persistence
 *   round-trips it unchanged.
 * - Every transition that changes which pattern is selected (select, add,
 *   clone) first runs `ensureIndependentPatterns`: each pattern that still
 *   shares the live content gets its own exact copy, and pattern clips that
 *   name no (existing) pattern are pinned to the selected pattern — the content
 *   they were playing. From the first pattern operation on, editing one pattern
 *   can never change another pattern or a clip that plays another pattern.
 *
 * Readers resolve content through `resolvePatternChannelContent`, which needs
 * only the pattern and the channel — no selection id — so the live scheduler,
 * the offline renderer, MIDI export and bounce resolve it identically.
 */

/** Read-only content one channel has in one pattern. */
export interface ResolvedPatternContent {
  readonly steps: readonly boolean[];
  readonly notes: readonly Note[];
}

/**
 * Cells a channel receives in a pattern it has no content in: the same one-bar
 * grid a freshly created channel starts with. Toggling a later cell grows the
 * array on demand (`toggleChannelStep`), exactly as for any channel.
 */
export const EMPTY_PATTERN_STEP_CELLS = 16;

const EMPTY_CONTENT: ResolvedPatternContent = Object.freeze({
  steps: Object.freeze([]) as readonly boolean[],
  notes: Object.freeze([]) as readonly Note[],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const copySteps = (steps: unknown): boolean[] =>
  (Array.isArray(steps) ? Array.from(steps, cell => cell === true) : []);

const copyNotes = (notes: unknown): Note[] =>
  (Array.isArray(notes) ? notes.filter(isRecord).map(note => ({ ...(note as unknown as Note) })) : []);

const emptySteps = (): boolean[] => new Array<boolean>(EMPTY_PATTERN_STEP_CELLS).fill(false);

/** True when the pattern owns stored content (it is not sharing the live content). */
export const hasStoredPatternContent = (
  pattern: Pattern | undefined
): pattern is Pattern & { channelContent: PatternChannelContent[] } =>
  Boolean(pattern) && Array.isArray(pattern!.channelContent);

/**
 * Content of `channel` in `pattern`:
 * - no pattern (a clip that names none, an unknown id, or a caller without a
 *   pattern model) or a pattern without stored content -> the live channel
 *   content (the selected pattern / legacy shared content);
 * - otherwise -> the pattern's stored entry for the channel, or empty.
 *
 * The returned arrays are not copies: treat them as read-only.
 */
export const resolvePatternChannelContent = (
  pattern: Pattern | undefined,
  channel: Pick<Channel, 'id' | 'steps' | 'notes'>
): ResolvedPatternContent => {
  if (!hasStoredPatternContent(pattern)) {
    return {
      steps: Array.isArray(channel.steps) ? channel.steps : EMPTY_CONTENT.steps,
      notes: Array.isArray(channel.notes) ? channel.notes : EMPTY_CONTENT.notes,
    };
  }
  const entry = pattern.channelContent.find(candidate => isRecord(candidate) && candidate.channelId === channel.id);
  if (!entry) return EMPTY_CONTENT;
  return {
    steps: Array.isArray(entry.steps) ? entry.steps : EMPTY_CONTENT.steps,
    notes: Array.isArray(entry.notes) ? entry.notes : EMPTY_CONTENT.notes,
  };
};

/** The pattern a playlist clip plays, or `undefined` when it names none that exists. */
export const findPatternForClip = (
  patterns: readonly Pattern[] | undefined,
  clip: Pick<PlaylistClip, 'patternId'>
): Pattern | undefined => {
  if (!clip.patternId || !Array.isArray(patterns)) return undefined;
  return patterns.find(pattern => isRecord(pattern) && pattern.id === clip.patternId);
};

/** Content of `channel` in the pattern `clip` plays. */
export const resolveClipChannelContent = (
  patterns: readonly Pattern[] | undefined,
  clip: Pick<PlaylistClip, 'patternId'>,
  channel: Pick<Channel, 'id' | 'steps' | 'notes'>
): ResolvedPatternContent => resolvePatternChannelContent(findPatternForClip(patterns, clip), channel);

/**
 * A read-only channel view whose `steps` / `notes` are `content`. Every other
 * field (instrument, volume, routing...) is the channel's own, so a view can be
 * handed to code that measures or renders a channel's content.
 */
export const withPatternChannelContent = (channel: Channel, content: ResolvedPatternContent): Channel => ({
  ...channel,
  steps: content.steps as boolean[],
  notes: content.notes as Note[],
});

/** Deep copy of every channel's live content, one entry per channel. */
const captureLiveContent = (channels: readonly Channel[]): PatternChannelContent[] =>
  channels.map(channel => ({ channelId: channel.id, steps: copySteps(channel.steps), notes: copyNotes(channel.notes) }));

const copyEntries = (entries: readonly PatternChannelContent[]): PatternChannelContent[] =>
  entries.map(entry => ({ channelId: entry.channelId, steps: copySteps(entry.steps), notes: copyNotes(entry.notes) }));

/** Channels whose live content becomes `entries`; a channel without an entry becomes empty. */
const loadContentIntoChannels = (
  channels: readonly Channel[],
  entries: readonly PatternChannelContent[] | undefined
): Channel[] => channels.map(channel => {
  const entry = entries?.find(candidate => candidate.channelId === channel.id);
  return {
    ...channel,
    steps: entry ? copySteps(entry.steps) : emptySteps(),
    notes: entry ? copyNotes(entry.notes) : [],
  };
});

const withoutStoredContent = (pattern: Pattern): Pattern => {
  const { channelContent: _stored, ...rest } = pattern;
  return rest;
};

const isValidEntry = (entry: unknown): entry is PatternChannelContent =>
  isRecord(entry)
  && typeof entry.channelId === 'string'
  && Array.isArray(entry.steps)
  && entry.steps.every(cell => typeof cell === 'boolean')
  && Array.isArray(entry.notes)
  && entry.notes.every(isRecord);

/**
 * Stored entries the project can use: malformed entries are repaired (cells
 * coerced to booleans, non-record notes dropped), and entries for channels the
 * project no longer has — or a second entry for the same channel — are dropped.
 * Returns the input array itself when it is already clean.
 */
export const sanitizePatternChannelContent = (
  entries: readonly unknown[],
  channelIds: ReadonlySet<string>
): PatternChannelContent[] => {
  const seen = new Set<string>();
  let clean = true;
  for (const entry of entries) {
    if (!isValidEntry(entry) || !channelIds.has(entry.channelId) || seen.has(entry.channelId)) {
      clean = false;
      break;
    }
    seen.add(entry.channelId);
  }
  if (clean) return entries as PatternChannelContent[];

  seen.clear();
  const sanitized: PatternChannelContent[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.channelId !== 'string') continue;
    if (!channelIds.has(entry.channelId) || seen.has(entry.channelId)) continue;
    seen.add(entry.channelId);
    sanitized.push({ channelId: entry.channelId, steps: copySteps(entry.steps), notes: copyNotes(entry.notes) });
  }
  return sanitized;
};

/**
 * Persistence-boundary invariant, run by `normalizeProjectState` (and so by
 * every save and history snapshot). It is lossless: a document this model
 * wrote, and a legacy document, come back unchanged. It never gives a legacy
 * pattern its own copy — that happens at the first pattern operation — it only:
 *
 * - drops a malformed (non-array) `channelContent`, which the resolver already
 *   treats as "no stored content", and sanitizes stored entries;
 * - repairs a selected pattern that still carries stored content. That shape is
 *   reachable only by writing `selectedPatternId` without
 *   `selectPatternInProjectState`: the live content belongs to the pattern that
 *   was selected before, so it is stored on every non-selected pattern without
 *   content first, then the selected pattern's stored content becomes the live
 *   content.
 */
export const normalizePatternContentModel = (state: ProjectState): ProjectState => {
  if (!Array.isArray(state.patterns) || state.patterns.length === 0) return state;
  const channels = Array.isArray(state.channels) ? state.channels : [];
  const channelIds = new Set(channels.map(channel => channel?.id).filter((id): id is string => typeof id === 'string'));

  let changed = false;
  let patterns = state.patterns.map(pattern => {
    if (!isRecord(pattern) || !('channelContent' in pattern)) return pattern;
    if (!Array.isArray(pattern.channelContent)) {
      changed = true;
      return withoutStoredContent(pattern);
    }
    const sanitized = sanitizePatternChannelContent(pattern.channelContent, channelIds);
    if (sanitized === pattern.channelContent) return pattern;
    changed = true;
    return { ...pattern, channelContent: sanitized };
  });

  let nextChannels = channels;
  const selectedIndex = patterns.findIndex(pattern => isRecord(pattern) && pattern.id === state.selectedPatternId);
  const selected = selectedIndex >= 0 ? patterns[selectedIndex] : undefined;
  if (hasStoredPatternContent(selected)) {
    const live = captureLiveContent(channels);
    patterns = patterns.map((pattern, index) => {
      if (index === selectedIndex) return withoutStoredContent(pattern);
      if (!isRecord(pattern) || hasStoredPatternContent(pattern)) return pattern;
      return { ...pattern, channelContent: copyEntries(live) };
    });
    nextChannels = loadContentIntoChannels(channels, selected.channelContent);
    changed = true;
  }

  if (!changed) return state;
  return { ...state, patterns, channels: nextChannels };
};

/**
 * Makes every pattern independent before a pattern operation:
 *
 * - each non-selected pattern that still shares the live content (a pattern
 *   from a document saved before patterns were independent) gets its own
 *   exact copy — what it showed and played until now;
 * - each pattern clip that names no pattern, or one that does not exist, is
 *   pinned to the selected pattern — the content it was playing.
 *
 * Idempotent; returns the (normalized) state itself when nothing needs
 * migrating.
 */
export const ensureIndependentPatterns = (state: ProjectState): ProjectState => {
  const base = normalizePatternContentModel(state);
  const patterns = Array.isArray(base.patterns) ? base.patterns : [];
  const channels = Array.isArray(base.channels) ? base.channels : [];
  const selected = patterns.find(pattern => pattern.id === base.selectedPatternId);

  let live: PatternChannelContent[] | null = null;
  let firstCopiedId: string | undefined;
  let patternsChanged = false;
  const nextPatterns = patterns.map(pattern => {
    if (pattern === selected || hasStoredPatternContent(pattern)) return pattern;
    live ??= captureLiveContent(channels);
    firstCopiedId ??= pattern.id;
    patternsChanged = true;
    return { ...pattern, channelContent: copyEntries(live) };
  });

  // A project whose selection names no pattern has no selected pattern to pin
  // to; the first pattern that just received the live content plays the same
  // content, so it is the faithful anchor.
  const pinId = selected?.id ?? firstCopiedId;
  const knownIds = new Set(patterns.map(pattern => pattern.id));
  let clipsChanged = false;
  const clips = Array.isArray(base.playlistClips) ? base.playlistClips : [];
  const nextClips = pinId
    ? clips.map(clip => {
        if (!clip || clip.type !== 'pattern' || (clip.patternId && knownIds.has(clip.patternId))) return clip;
        clipsChanged = true;
        return { ...clip, patternId: pinId };
      })
    : clips;

  if (!patternsChanged && !clipsChanged) return base;
  return {
    ...base,
    patterns: patternsChanged ? nextPatterns : base.patterns,
    playlistClips: clipsChanged ? nextClips : base.playlistClips,
  };
};

/**
 * Selects `patternId`. The outgoing pattern stores an exact copy of the live
 * content; the incoming pattern's stored content becomes the live content
 * (channels it has no entry for become empty). Placed clips, other patterns and
 * every non-content channel field are untouched, so selecting a pattern never
 * changes what the arrangement plays.
 *
 * Selecting the already-selected pattern, or an unknown id, returns `state`.
 */
export const selectPatternInProjectState = (state: ProjectState, patternId: string): ProjectState => {
  if (!Array.isArray(state.patterns) || !state.patterns.some(pattern => pattern.id === patternId)) return state;
  if (state.selectedPatternId === patternId) return state;

  const base = ensureIndependentPatterns(state);
  const target = base.patterns.find(pattern => pattern.id === patternId);
  if (!target) return state;
  const live = captureLiveContent(base.channels);
  const patterns = base.patterns.map(pattern => {
    if (pattern.id === base.selectedPatternId) return { ...pattern, channelContent: live };
    if (pattern.id === patternId) return withoutStoredContent(pattern);
    return pattern;
  });
  return {
    ...base,
    patterns,
    channels: loadContentIntoChannels(base.channels, target.channelContent),
    selectedPatternId: patternId,
  };
};

/** Stores the live content on the selected pattern (used before another pattern takes over the channels). */
const storeLiveContentOnSelected = (state: ProjectState): Pattern[] => {
  const live = captureLiveContent(state.channels);
  return state.patterns.map(pattern => (
    pattern.id === state.selectedPatternId ? { ...pattern, channelContent: live } : pattern
  ));
};

/**
 * Appends `pattern` as a new, EMPTY pattern and selects it — a new pattern
 * starts blank, as in FL Studio. The previously selected pattern keeps its
 * content. When no existing pattern owns the live content (the project's
 * selection names no pattern), the new pattern adopts it instead, so nothing
 * the Channel Rack shows is ever discarded. A duplicate id returns `state`.
 */
export const addEmptyPatternToProjectState = (state: ProjectState, pattern: Pattern): ProjectState => {
  const patterns = Array.isArray(state.patterns) ? state.patterns : [];
  if (patterns.some(existing => existing.id === pattern.id)) return state;
  const base = ensureIndependentPatterns({ ...state, patterns });
  const created = withoutStoredContent(pattern);
  const hasSelected = base.patterns.some(existing => existing.id === base.selectedPatternId);
  if (!hasSelected) {
    return { ...base, patterns: [...base.patterns, created], selectedPatternId: created.id };
  }
  return {
    ...base,
    patterns: [...storeLiveContentOnSelected(base), created],
    channels: base.channels.map(channel => ({ ...channel, steps: emptySteps(), notes: [] })),
    selectedPatternId: created.id,
  };
};

/**
 * Appends `pattern` as an exact copy of `sourcePatternId` — every channel's
 * steps and notes plus the declared length — and selects it: the "Clone
 * pattern" workflow for building a variation. An unknown source or a duplicate
 * id returns `state`.
 */
export const clonePatternInProjectState = (
  state: ProjectState,
  sourcePatternId: string,
  pattern: Pattern
): ProjectState => {
  const patterns = Array.isArray(state.patterns) ? state.patterns : [];
  if (patterns.some(existing => existing.id === pattern.id)) return state;
  if (!patterns.some(existing => existing.id === sourcePatternId)) return state;
  const base = ensureIndependentPatterns(state);
  const source = base.patterns.find(existing => existing.id === sourcePatternId);
  if (!source) return state;

  const sourceContent = base.channels.map(channel => {
    const content = resolvePatternChannelContent(source, channel);
    return { channelId: channel.id, steps: copySteps(content.steps), notes: copyNotes(content.notes) };
  });
  const clone: Pattern = { ...withoutStoredContent(pattern), lengthSteps: source.lengthSteps };
  return {
    ...base,
    patterns: [...storeLiveContentOnSelected(base), clone],
    channels: loadContentIntoChannels(base.channels, sourceContent),
    selectedPatternId: clone.id,
  };
};

/**
 * Rewrites one channel's content in one pattern: the live channel when the
 * pattern has no stored content (the selected pattern), its stored entry
 * otherwise. Used where a write targets a pattern that may no longer be
 * selected — a MIDI take finalized after the user switched patterns. Unknown
 * pattern or channel ids return `state`.
 */
export const updatePatternChannelContentInProjectState = (
  state: ProjectState,
  patternId: string,
  channelId: string,
  update: (current: ResolvedPatternContent) => Partial<Pick<PatternChannelContent, 'steps' | 'notes'>>
): ProjectState => {
  const pattern = state.patterns.find(candidate => candidate.id === patternId);
  const channel = state.channels.find(candidate => candidate.id === channelId);
  if (!pattern || !channel) return state;

  const current = resolvePatternChannelContent(pattern, channel);
  const next = update(current);
  const steps = next.steps ?? copySteps(current.steps);
  const notes = next.notes ?? copyNotes(current.notes);

  if (!hasStoredPatternContent(pattern)) {
    return {
      ...state,
      channels: state.channels.map(candidate => (candidate.id === channelId ? { ...candidate, steps, notes } : candidate)),
    };
  }
  const entry: PatternChannelContent = { channelId, steps, notes };
  const entries = pattern.channelContent.some(candidate => candidate.channelId === channelId)
    ? pattern.channelContent.map(candidate => (candidate.channelId === channelId ? entry : candidate))
    : [...pattern.channelContent, entry];
  return {
    ...state,
    patterns: state.patterns.map(candidate => (candidate.id === patternId ? { ...candidate, channelContent: entries } : candidate)),
  };
};

/** Drops a deleted channel's stored content from every pattern. */
export const removeChannelFromPatternContent = (state: ProjectState, channelId: string): ProjectState => {
  let changed = false;
  const patterns = state.patterns.map(pattern => {
    if (!hasStoredPatternContent(pattern) || !pattern.channelContent.some(entry => entry.channelId === channelId)) {
      return pattern;
    }
    changed = true;
    return { ...pattern, channelContent: pattern.channelContent.filter(entry => entry.channelId !== channelId) };
  });
  return changed ? { ...state, patterns } : state;
};

/**
 * Every piano-roll note the project holds: the live content once (the selected
 * pattern, plus any legacy patterns that still share it) and each pattern's
 * stored content.
 */
export const countProjectNotes = (patterns: readonly Pattern[], channels: readonly Channel[]): number => {
  const channelIds = new Set(channels.map(channel => channel.id));
  let total = channels.reduce((sum, channel) => sum + (Array.isArray(channel.notes) ? channel.notes.length : 0), 0);
  for (const pattern of patterns) {
    if (!hasStoredPatternContent(pattern)) continue;
    for (const entry of pattern.channelContent) {
      if (channelIds.has(entry.channelId) && Array.isArray(entry.notes)) total += entry.notes.length;
    }
  }
  return total;
};

/** Pattern clip as the selection-neutral view describes it: by the content it plays. */
export type SelectionNeutralClip =
  | PlaylistClip
  | (Omit<PlaylistClip, 'patternId'> & { playsContent: { steps: boolean[]; notes: Note[] } | null });

export interface SelectionNeutralPatternView {
  patterns: Array<Omit<Pattern, 'channelContent'> & { content: PatternChannelContent[] }>;
  channels: Channel[];
  playlistClips: SelectionNeutralClip[];
}

/**
 * The project's pattern content in a form that does not depend on which
 * pattern is selected, nor on whether a legacy document has been migrated yet:
 * every pattern lists its resolved content, channels carry no content of their
 * own, and each pattern clip is described by the content it plays rather than
 * by a pattern id (a legacy clip that names no pattern plays the live content,
 * which a migration pins to whichever pattern was selected — the content is the
 * invariant, the id is not). When the selection names no pattern the live
 * content belongs to none, so it stays on the channels and still counts.
 */
export const resolveSelectionNeutralPatternView = (state: ProjectState): SelectionNeutralPatternView => {
  const patterns = Array.isArray(state.patterns) ? state.patterns : [];
  const channels = Array.isArray(state.channels) ? state.channels : [];
  const clips = Array.isArray(state.playlistClips) ? state.playlistClips : [];
  const selectedExists = patterns.some(pattern => pattern.id === state.selectedPatternId);

  return {
    patterns: patterns.map(pattern => ({
      ...withoutStoredContent(pattern),
      content: channels.map(channel => {
        const content = resolvePatternChannelContent(pattern, channel);
        return { channelId: channel.id, steps: copySteps(content.steps), notes: copyNotes(content.notes) };
      }),
    })),
    channels: selectedExists
      ? channels.map(channel => ({ ...channel, steps: [], notes: [] }))
      : channels,
    playlistClips: clips.map((clip): SelectionNeutralClip => {
      if (clip?.type !== 'pattern') return clip;
      const { patternId: _patternId, ...rest } = clip;
      const channel = channels.find(candidate => candidate.id === clip.channelId);
      const content = channel ? resolveClipChannelContent(patterns, clip, channel) : undefined;
      return {
        ...rest,
        playsContent: content ? { steps: copySteps(content.steps), notes: copyNotes(content.notes) } : null,
      };
    }),
  };
};
