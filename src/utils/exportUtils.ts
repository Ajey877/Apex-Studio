import { stepsPerBar, stepsToBeats, beatsToMidiTicks, bpmToMicrosecondsPerQuarter, DEFAULT_MIDI_PPQ, LEGACY_TIME_SIGNATURE } from '../music/musicalTime';
import type { Channel, PlaylistClip, PlaylistTrack, ProjectMetadata } from '../types/daw';
import { getPatternLengthBars } from '../state/patternLength';
import {
  resolvePatternLoopLengthSteps,
  resolvePlayableContentLengthSteps,
} from '../audio/audioEngine';
import { isRackChannelAudible } from '../audio/midiMappingRuntime';
import { swingOffsetTicksForStep } from '../audio/parameterScaling';
import { derivePlaylistLaneMutes, isClipLaneMuted } from '../audio/playlistLaneMutes';

export type ExportScope = 'song' | 'pattern';

/**
 * Phase 64 — the export options the dialog already knows.
 *
 * Before this, `buildStandardMidiFile` received only the channels, clips and
 * metadata: the selected scope, the declared pattern length, the project's
 * timeline length and the playlist lane rows were all dropped on the floor, so a
 * "Pattern Loop (4 bars)" MIDI export wrote events from bar 24 and a muted lane
 * was exported as if it were audible. The options below are the same values the
 * WAV/stem renderer is given, so one scope selection produces one window.
 *
 * All fields are optional: the three-argument form keeps working as a Full Song
 * export, which is what every legacy caller meant.
 */
export interface MidiExportOptions {
  scope?: ExportScope;
  /** Declared `Pattern.lengthSteps` of the selected pattern (see `state/patternLength`). */
  patternLengthSteps?: number;
  /** Authoritative playlist timeline length; clamps the Song window (Phase 54). */
  totalBars?: number;
  /** Playlist lane rows; muted rows are dropped exactly like the WAV renderer. */
  playlistTracks?: PlaylistTrack[];
}

/**
 * A Pattern Loop export renders the documented 4-bar window, which is also wide
 * enough for every length the model expresses in the UI (16 and 32 steps) and
 * for a 64-step pattern exactly.
 */
export const PATTERN_EXPORT_MIN_BARS = 4;

/**
 * Render window in bars.
 *
 * Song scope still ends at the last playlist clip. Pattern scope keeps the
 * documented 4-bar loop, and grows with the selected pattern's declared
 * `Pattern.lengthSteps` so the window can never truncate a longer pattern. The
 * length itself is normalized by the single pattern-length source of truth; no
 * second pattern-length calculation lives here.
 *
 * Phase 54: when the project's authoritative timeline length is supplied, a
 * song render can never be longer than the timeline the user can see. Clips are
 * already clamped to `totalBars` at creation, on shrink and on load, so this is
 * the final guarantee rather than the only one — it exists so a 32-bar timeline
 * can never produce a 35-bar export again.
 */
export function getProjectRenderBars(
  clips: PlaylistClip[],
  scope: ExportScope,
  patternLengthSteps?: number,
  totalBars?: number
): number {
  if (scope === 'pattern') {
    return Math.max(PATTERN_EXPORT_MIN_BARS, getPatternLengthBars(patternLengthSteps));
  }
  const endBars = clips
    .filter(clip => Number.isFinite(clip.startBar) && Number.isFinite(clip.lengthBars) && clip.lengthBars > 0)
    .map(clip => clip.startBar + clip.lengthBars);
  const lastClipBar = Math.max(1, ...endBars);
  if (totalBars === undefined || !Number.isFinite(totalBars) || totalBars <= 0) return lastClipBar;
  return Math.min(lastClipBar, Math.round(totalBars));
}

const clampMidi = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));

const writeVlq = (value: number): number[] => {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
};

const pushString = (target: number[], value: string): void => {
  for (let i = 0; i < value.length; i += 1) target.push(value.charCodeAt(i));
};

const pushUint16 = (target: number[], value: number): void => {
  target.push((value >> 8) & 0xff, value & 0xff);
};

const pushUint32 = (target: number[], value: number): void => {
  target.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
};

interface MidiEvent {
  tick: number;
  order: number;
  data: number[];
}

/** The arrangement grid: 16 steps per bar, one 16th note per 120 ticks at 480 PPQ. */
const STEPS_PER_BAR = stepsPerBar(LEGACY_TIME_SIGNATURE);
const TICKS_PER_STEP = beatsToMidiTicks(stepsToBeats(1), DEFAULT_MIDI_PPQ);
const TICKS_PER_BAR = STEPS_PER_BAR * TICKS_PER_STEP;

/**
 * Tolerance for resolving which step boundary a tick-quantised onset belongs to.
 *
 * Onsets arrive on the tick grid (`midiOnsetSteps`), and repeated additions can
 * leave an exact step as `4.999999999`. Flooring with this epsilon keeps the
 * boundary — and therefore the groove the onset inherits — stable.
 */
const STEP_EPSILON = 1e-6;

/** One schedulable piece of channel content inside the pattern loop. */
interface ChannelContentStep {
  /** Position inside the loop, 0-based. */
  relStep: number;
  pitch: number;
  durationSteps: number;
  velocity: number;
}

/**
 * The step position a note onset is written at, snapped to the file's own tick
 * resolution (120 ticks per 16th-note step). `Note.start` is a *fractional*
 * step position for strummed chords (`PianoRoll.tsx`), for "Strum Chords" and
 * for MIDI import's quarter-step quantiser, and the scheduler plays those onsets
 * at the fractional position. Rounding the onset to the nearest step here would
 * move it — a 4.5 onset to step 5 — and make the file disagree with the take.
 * Snapping to the tick grid keeps one exact value for the loop arithmetic and
 * the byte writer.
 */
const midiOnsetSteps = (start: unknown): number | null => {
  const value = Number(start);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * TICKS_PER_STEP) / TICKS_PER_STEP;
};

/**
 * Positions inside a loop that actually hold content.
 *
 * A step lane entry and a piano-roll note start are both step-indexed, and both
 * are ignored past the resolved loop length — the same rule playback applies, so
 * a `Channel.steps` array that is longer than the declared pattern length does
 * not leak hidden steps into an export. Sub-step note onsets stay at their own
 * position instead of being folded onto the step grid.
 */
const channelContentSteps = (channel: Channel, loopLengthSteps: number): number[] => {
  const positions = new Set<number>();
  if (Array.isArray(channel.steps)) {
    channel.steps.forEach((active, index) => {
      if (active === true && index < loopLengthSteps) positions.add(index);
    });
  }
  for (const note of channel.notes ?? []) {
    // Phase 68 F3: no `note.muted` filter. The audio scheduler plays every note
    // in `Channel.notes`; the export used to drop the ones a field no production
    // path writes, which made the file disagree with the take.
    const start = midiOnsetSteps(note.start);
    if (start !== null && start < loopLengthSteps) positions.add(start);
  }
  return Array.from(positions).sort((a, b) => a - b);
};

/** The events a single loop position produces: its step-lane hit plus any notes starting there. */
const contentEventsAtStep = (channel: Channel, relStep: number): ChannelContentStep[] => {
  const events: ChannelContentStep[] = [];
  if (Array.isArray(channel.steps) && channel.steps[relStep]) {
    events.push({
      relStep,
      pitch: channel.instrumentType === 'drumpad' ? 36 : 60,
      durationSteps: 1,
      velocity: 0.9,
    });
  }
  for (const note of channel.notes ?? []) {
    if (midiOnsetSteps(note.start) !== relStep) continue;
    const duration = Number.isFinite(note.duration) && note.duration > 0 ? note.duration : 1;
    events.push({
      relStep,
      pitch: note.pitch,
      durationSteps: duration,
      velocity: Number.isFinite(note.velocity) ? note.velocity : 0.8,
    });
  }
  return events;
};

interface MidiTrackContext {
  scope: ExportScope;
  /** Pattern Mode wrap boundary (`resolvePatternLoopLengthSteps`), used by Pattern scope. */
  patternLoopSteps: number;
  /** Advertised render window in ticks; nothing at or past it is written. */
  windowTicks: number;
  laneMutes: Set<number>;
}

/**
 * Metadata the writer needs. `swing` is optional so the legacy three-argument
 * call sites keep meaning "no groove", while `ExportModal` passes the project
 * document's own `ProjectMetadata.swing` straight through.
 */
type MidiExportMeta = Pick<ProjectMetadata, 'bpm' | 'timeSignature'> & { swing?: number };

function buildMidiTrack(
  channel: Channel,
  channelIndex: number,
  clips: PlaylistClip[],
  meta: MidiExportMeta,
  context?: MidiTrackContext,
  /**
   * Phase 68 F3: whether this channel is audible under the canonical Channel
   * Rack predicate. The track is still written (so track order and the MIDI
   * channel number derived from `channelIndex` stay aligned with the project)
   * but it carries no note events, exactly as the channel produces no audio.
   */
  audible: boolean = true,
): number[] {
  const midiChannel = channelIndex % 16;
  const events: MidiEvent[] = [];
  const safeBpm = Number.isFinite(meta.bpm) && meta.bpm > 0 ? meta.bpm : 120;
  const windowTicks = context ? context.windowTicks : Number.POSITIVE_INFINITY;

  const name = channel.name || `Channel ${channelIndex + 1}`;
  const nameBytes = Array.from(new TextEncoder().encode(name));
  events.push({ tick: 0, order: 0, data: [0xff, 0x03, ...writeVlq(nameBytes.length), ...nameBytes] });

  if (channelIndex === 0) {
    const microsPerQuarter = Math.max(1, Math.round(bpmToMicrosecondsPerQuarter(safeBpm)));
    const numerator = Number.isFinite(meta.timeSignature?.[0]) && meta.timeSignature[0] > 0 ? Math.round(meta.timeSignature[0]) : 4;
    const denominator = Number.isFinite(meta.timeSignature?.[1]) && meta.timeSignature[1] > 0 ? Math.round(meta.timeSignature[1]) : 4;
    const denominatorPower = Math.max(0, Math.min(7, Math.round(Math.log2(denominator))));
    events.push({
      tick: 0,
      order: 0,
      data: [0xff, 0x51, 0x03, (microsPerQuarter >> 16) & 0xff, (microsPerQuarter >> 8) & 0xff, microsPerQuarter & 0xff],
    });
    events.push({ tick: 0, order: 0, data: [0xff, 0x58, 0x04, numerator & 0xff, denominatorPower, 24, 8] });
  }

  /**
   * Writes one content event at an absolute timeline step.
   *
   * Events that begin at or past the advertised window are dropped: the dialog
   * names a bar count, so the file must not contain anything it cannot describe.
   * A note whose release lands past the window keeps its release, exactly like a
   * note-off at the very end of a DAW export.
   *
   * Phase 68 F2: the start tick carries the project's groove. The scheduler
   * (`audioEngine` live and offline) displaces only the odd step boundaries, and
   * a fractional onset belongs to the boundary at or before it — so the groove
   * an onset takes is the one belonging to `floor(start)`, never a
   * re-quantisation of the onset itself. A straight project (`swing = 0`) adds
   * exactly zero ticks and leaves today's bytes untouched.
   */
  const emitAtStep = (absoluteStep: number, content: ChannelContentStep): void => {
    // A sub-step onset lands on a fractional step position; the file stores it on
    // the tick grid, which is what `Math.round` resolves for a whole step too.
    const boundaryStep = Math.floor(absoluteStep + STEP_EPSILON);
    const grooveTicks = boundaryStep % 2 === 0 ? 0 : swingOffsetTicksForStep(meta.swing, TICKS_PER_STEP);
    const startTick = Math.round(absoluteStep * TICKS_PER_STEP) + grooveTicks;
    if (startTick < 0 || startTick >= windowTicks) return;
    const durationTick = Math.max(1, Math.round(Math.max(0.01, content.durationSteps) * TICKS_PER_STEP));
    const velocity = Math.max(1, Math.min(127, Math.round(content.velocity * 127)));
    events.push({ tick: startTick, order: 2, data: [0x90 | midiChannel, clampMidi(content.pitch), velocity] });
    events.push({ tick: startTick + durationTick, order: 1, data: [0x80 | midiChannel, clampMidi(content.pitch), 0] });
  };

  if (!audible) {
    // A muted or solo-silenced channel writes no note events. The rest of the
    // track (name, and the tempo/time-signature map on track 0) is kept so a
    // reader cannot lose the channel map or mistake the silence for a missing
    // part; the audio it replaces is silent for the same predicate.
  } else if (context && context.scope === 'pattern') {
    // Pattern Mode: the loop is the declared pattern length and it wraps for as
    // long as the window lasts, so the MIDI matches a Pattern Loop WAV render.
    const loopLength = Math.max(1, Math.round(context.patternLoopSteps));
    const windowSteps = Math.ceil(windowTicks / TICKS_PER_STEP);
    for (const relStep of channelContentSteps(channel, loopLength)) {
      for (let step = relStep; step < windowSteps; step += loopLength) {
        for (const content of contentEventsAtStep(channel, relStep)) emitAtStep(step, content);
      }
    }
  } else {
    // Song Mode: each clip plays the channel's content on its own loop length and
    // its own `offsetSteps` trim, from the clip's start bar to its end bar.
    const loopLength = Math.max(1, resolvePlayableContentLengthSteps(channel));
    for (const clip of clips) {
      if (clip.type !== 'pattern' || clip.mute || clip.channelId !== channel.id) continue;
      if (context && isClipLaneMuted(clip, context.laneMutes)) continue;
      const startStep = Math.round(clip.startBar * STEPS_PER_BAR);
      const endStep = startStep + Math.round(clip.lengthBars * STEPS_PER_BAR);
      const offsetSteps = Math.max(0, Math.round(Number(clip.offsetSteps) || 0));
      for (const relStep of channelContentSteps(channel, loopLength)) {
        const phase = ((relStep - offsetSteps) % loopLength + loopLength) % loopLength;
        for (let step = startStep + phase; step < endStep; step += loopLength) {
          for (const content of contentEventsAtStep(channel, relStep)) emitAtStep(step, content);
        }
      }
    }
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const trackData: number[] = [];
  let previousTick = 0;
  for (const event of events) {
    trackData.push(...writeVlq(Math.max(0, event.tick - previousTick)), ...event.data);
    previousTick = event.tick;
  }
  trackData.push(0x00, 0xff, 0x2f, 0x00);

  const track: number[] = [];
  pushString(track, 'MTrk');
  pushUint32(track, trackData.length);
  track.push(...trackData);
  return track;
}

export function buildStandardMidiFile(
  channels: Channel[],
  clips: PlaylistClip[],
  meta: MidiExportMeta,
  options: MidiExportOptions = {},
): Blob {
  const scope: ExportScope = options.scope === 'pattern' ? 'pattern' : 'song';
  // The same window the WAV/stem renderer is handed, so the dialog's bar count
  // and the file's contents cannot disagree.
  const windowTicks = getProjectRenderBars(clips, scope, options.patternLengthSteps, options.totalBars) * TICKS_PER_BAR;
  const context: MidiTrackContext = {
    scope,
    patternLoopSteps: resolvePatternLoopLengthSteps(channels, options.patternLengthSteps),
    windowTicks,
    laneMutes: derivePlaylistLaneMutes(options.playlistTracks),
  };

  // Phase 68 F3: one audibility contract for the whole application. The live
  // scheduler and the offline/stem renderer gate on `isRackChannelAudible`, so
  // the file is written from the same predicate instead of a MIDI-only rule.
  const tracks = channels.map((channel, index) =>
    buildMidiTrack(channel, index, clips, meta, context, isRackChannelAudible(channel, channels)));
  if (tracks.length === 0) {
    tracks.push(buildMidiTrack({ id: 'empty', name: 'Apex Studio', notes: [] } as Channel, 0, [], meta, context));
  }

  const header: number[] = [];
  pushString(header, 'MThd');
  pushUint32(header, 6);
  pushUint16(header, tracks.length > 1 ? 1 : 0);
  pushUint16(header, tracks.length);
  pushUint16(header, DEFAULT_MIDI_PPQ);

  const bytes = new Uint8Array([...header, ...tracks.flat()]);
  return new Blob([bytes], { type: 'audio/midi' });
}
