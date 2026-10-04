import type { Note } from '../types/daw';
import type { ParsedMidiTrack } from '../utils/midiParser';

/**
 * Phase 66 F3-B: the import plan for a Standard MIDI File.
 *
 * A Format-1 file carries one track per part — Apex's own MIDI export writes one
 * track per channel, named after that channel — while the Piano Roll is a
 * single-channel editor. The import therefore plans one destination per
 * *note-bearing* track: the first one belongs in the channel being edited, and
 * every following one becomes a channel of its own. Unrelated parts are never
 * merged into one another, tracks without notes never invent an empty channel,
 * and the caller reports what was skipped instead of dropping it silently.
 *
 * Planning is separated from the component so the whole decision is a pure
 * function of the parsed file: the same parsed tracks always produce the same
 * plan (including note ids, for a given seed).
 */
export interface MidiImportDestination {
  /** `current` edits the channel being edited; `new` needs a created channel. */
  kind: 'current' | 'new';
  /** The track name the file states (the parser names unnamed tracks `Track N`). */
  name: string;
  notes: Note[];
}

export interface MidiImportPlan {
  destinations: MidiImportDestination[];
  skippedEmptyTrackNames: string[];
}

export interface MidiImportPlanOptions {
  /** Seed for the generated note ids. Defaults to the current time. */
  noteIdSeed?: string | number;
}

export function planMidiImport(
  parsedTracks: readonly ParsedMidiTrack[],
  options: MidiImportPlanOptions = {},
): MidiImportPlan {
  const seed = options.noteIdSeed ?? Date.now();
  const destinations: MidiImportDestination[] = [];
  const skippedEmptyTrackNames: string[] = [];

  parsedTracks.forEach((parsedTrack, trackIndex) => {
    const statedName = typeof parsedTrack.name === 'string' ? parsedTrack.name.trim() : '';
    const name = statedName.length > 0 ? statedName : `Track ${trackIndex + 1}`;

    if (!Array.isArray(parsedTrack.notes) || parsedTrack.notes.length === 0) {
      skippedEmptyTrackNames.push(name);
      return;
    }

    destinations.push({
      kind: destinations.length === 0 ? 'current' : 'new',
      name,
      notes: parsedTrack.notes.map((parsedNote, noteIndex) => ({
        // The track and note index keep ids unique across every destination: a
        // duplicate id would break selection, note edits and undo.
        id: `midi-imp-${seed}-${trackIndex}-${noteIndex}`,
        pitch: parsedNote.pitch,
        start: parsedNote.startStep,
        duration: parsedNote.durationSteps,
        velocity: parsedNote.velocity,
      })),
    });
  });

  return { destinations, skippedEmptyTrackNames };
}
