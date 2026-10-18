import type { Channel, Note, PlaylistClip } from '../types/daw';
import type { ResolvedPatternContent } from '../state/patternContent';

/** Events on the absolute step grid. Fractional bar starts/offsets (notably 7/8
 * quarter-bar trims) must keep their phase, not be rounded to a different beat.
 * Both live/offline callbacks and MIDI use these same half-open windows.
 */
export function fullPatternEventsInWindow(
  channel: Channel, content: ResolvedPatternContent, clip: PlaylistClip,
  loopLength: number, barSteps: number, windowStart: number, windowEnd: number
): Array<{ note: Note; step: number }> {
  const start = clip.startBar * barSteps;
  const end = Math.min(start + clip.lengthBars * barSteps, windowEnd);
  const lower = Math.max(start, windowStart);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= lower || loopLength <= 0) return [];
  const offset = Number.isFinite(clip.offsetSteps) ? clip.offsetSteps! : 0;
  const notes: Note[] = [];
  content.steps.forEach((on, i) => {
    if (on && i < loopLength) notes.push({ id: `song-${channel.id}-${i}`, pitch: channel.instrumentType === 'drumpad' ? 36 : 60, start: i, duration: 1, velocity: 0.9 });
  });
  notes.push(...content.notes);
  const events: Array<{ note: Note; step: number }> = [];
  for (const note of notes) {
    if (!Number.isFinite(note.start) || note.start < 0 || note.start >= loopLength) continue;
    const phase = ((note.start - offset) % loopLength + loopLength) % loopLength;
    const first = start + phase;
    const pass = Math.max(0, Math.ceil((lower - first - 1e-9) / loopLength));
    for (let step = first + pass * loopLength; step < end - 1e-9; step += loopLength) {
      if (step >= lower - 1e-9) events.push({ note, step });
    }
  }
  return events;
}
