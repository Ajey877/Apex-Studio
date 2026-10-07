/**
 * Phase 1D — MIDI import and export honour the declared 0.25-step minimum.
 *
 * `Note.duration` is sixteenth-note steps and the shortest supported musical
 * duration is 0.25 steps (a 64th note). Apex writes MIDI at 480 PPQ, so one
 * step is 120 ticks and the shortest supported note is 30 ticks.
 *
 * The importer disagreed. It floored a note twice, both times at half a step:
 *
 *   const durTicks = Math.max(ticksPerStep / 2, currentTick - active.startTick);
 *   durationSteps: Math.max(0.5, Math.round((durTicks / ticksPerStep) * 4) / 4),
 *
 * so a perfectly representable 30-tick note came back as 0.5 steps. Because the
 * Piano Roll can draw 0.25-step notes and the exporter writes them exactly, a
 * project exported and re-imported came back with every short note doubled —
 * the file described a different performance than the one that was played.
 *
 * Nothing here imports the policy module. The Standard MIDI File bytes are built
 * and decoded by an independent implementation written from the SMF spec, and
 * every expected value is a literal derived from 480 PPQ / 120 ticks-per-step,
 * so the production importer is never its own oracle.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MidiParser } from '../utils/midiParser';
import type { Note } from '../types/daw';

// ---- literals declared from the MIDI spec, not read from production ---------
const PPQ = 480; // pulses per quarter note
const TICKS_PER_STEP = 120; // a 16th-note step is 1/4 of a quarter note at 480 PPQ
const TICKS_PER_BEAT = 480;

/** Independent VLQ encoder (spec 7-bit groups, continuation bit first). */
const writeVlq = (value: number): number[] => {
  assert.ok(Number.isInteger(value) && value >= 0, `test VLQ cannot encode ${value}`);
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
};

/** Independent VLQ decoder. */
const readVlq = (view: DataView, offset: number): { value: number; next: number } => {
  let value = 0;
  let index = offset;
  for (;;) {
    const byte = view.getUint8(index);
    index += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: index };
  }
};

interface SmfEvent {
  delta: number;
  data: readonly number[];
}

/** Builds a format-0 Standard MIDI File at 480 PPQ from literal events. */
const buildFormat0 = (events: readonly SmfEvent[], ppq = PPQ): ArrayBuffer => {
  const track: number[] = [];
  for (const event of events) {
    track.push(...writeVlq(event.delta), ...event.data);
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // End of Track

  const bytes = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, // format 0
    0x00, 0x01, // one track
    (ppq >> 8) & 0xff, ppq & 0xff,
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    (track.length >> 24) & 0xff,
    (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff,
    track.length & 0xff,
    ...track,
  ];
  return new Uint8Array(bytes).buffer;
};

interface DecodedPair {
  pitch: number;
  startTick: number;
  endTick: number;
}

/** Independently decodes note-on/note-off pairs, skipping meta events. */
const decodeNotePairs = (buffer: ArrayBuffer): DecodedPair[] => {
  const view = new DataView(buffer);
  assert.equal(String.fromCharCode(...new Uint8Array(buffer).slice(0, 4)), 'MThd', 'missing MThd');
  const headerLength = view.getUint32(4);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);
  assert.equal(division, PPQ, 'the file must state 480 PPQ');

  const pairs: DecodedPair[] = [];
  let cursor = 8 + headerLength;

  for (let track = 0; track < trackCount; track += 1) {
    assert.equal(String.fromCharCode(...new Uint8Array(buffer).slice(cursor, cursor + 4)), 'MTrk', 'missing MTrk');
    const length = view.getUint32(cursor + 4);
    const end = cursor + 8 + length;
    let index = cursor + 8;
    let tick = 0;
    let runningStatus = 0;
    const open = new Map<number, number>();

    while (index < end) {
      const delta = readVlq(view, index);
      tick += delta.value;
      index = delta.next;

      let status = view.getUint8(index);
      if (status & 0x80) {
        runningStatus = status;
        index += 1;
      } else {
        status = runningStatus;
      }

      if (status === 0xff) {
        const metaLength = readVlq(view, index + 1);
        index = metaLength.next + metaLength.value;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const sysExLength = readVlq(view, index);
        index = sysExLength.next + sysExLength.value;
        continue;
      }

      const type = status >> 4;
      const pitch = view.getUint8(index);
      const velocity = view.getUint8(index + 1);
      index += 2;

      if (type === 0x9 && velocity > 0) {
        open.set(pitch, tick);
      } else if (type === 0x8 || (type === 0x9 && velocity === 0)) {
        const startTick = open.get(pitch);
        assert.notEqual(startTick, undefined, `note-off for pitch ${pitch} with no note-on`);
        open.delete(pitch);
        pairs.push({ pitch, startTick: startTick as number, endTick: tick });
      }
    }
    cursor = end;
  }
  return pairs;
};

/** One note, `durationTicks` long, at tick 0 — the smallest file that matters. */
const oneNoteSmf = (durationTicks: number, pitch = 60): ArrayBuffer =>
  buildFormat0([
    { delta: 0, data: [0x90, pitch, 100] },
    { delta: durationTicks, data: [0x80, pitch, 0] },
  ]);

const parseSingleNote = async (buffer: ArrayBuffer) => {
  const tracks = await MidiParser.parseMidiFile(buffer);
  assert.equal(tracks.length, 1, 'a format-0 file with notes parses to one track');
  assert.equal(tracks[0].notes.length, 1, 'the file holds exactly one note');
  return tracks[0].notes[0];
};

const makeNote = (duration: number, start = 0, pitch = 60): Note => ({
  id: `n-${pitch}-${start}-${duration}`,
  pitch,
  start,
  duration,
  velocity: 0.8,
});

describe('Phase 1D C — MIDI import keeps a valid 0.25-step note at 0.25 steps', () => {
  it('a 30-tick note imports as 0.25 steps, not the historical 0.5', async () => {
    // 0.25 steps * 120 ticks/step = 30 ticks. This is a legal, exactly
    // representable note at 480 PPQ; nothing about it is malformed.
    assert.equal(0.25 * TICKS_PER_STEP, 30);

    const parsed = await parseSingleNote(oneNoteSmf(30));
    assert.equal(parsed.startStep, 0);
    assert.equal(parsed.pitch, 60);
    assert.equal(parsed.durationSteps, 0.25);
    assert.notEqual(parsed.durationSteps, 0.5, 'the importer must not promote a short note');
  });

  it('every supported duration on the 0.25-step grid imports unchanged', async () => {
    const cases: ReadonlyArray<[number, number]> = [
      [30, 0.25],
      [60, 0.5],
      [90, 0.75],
      [120, 1],
      [150, 1.25],
      [180, 1.5],
      [240, 2],
      [480, 4],
    ];
    for (const [ticks, expectedSteps] of cases) {
      assert.equal(ticks / TICKS_PER_STEP, expectedSteps, 'the literal tick count must equal the literal step count');
      const parsed = await parseSingleNote(oneNoteSmf(ticks));
      assert.equal(parsed.durationSteps, expectedSteps, `${ticks} ticks must import as ${expectedSteps} steps`);
    }
  });

  it('an off-grid tick count snaps to the nearest 0.25-step grid line', async () => {
    // 45 ticks = 0.375 steps, exactly halfway to 0.5: rounds up.
    assert.equal(45 / TICKS_PER_STEP, 0.375);
    assert.equal((await parseSingleNote(oneNoteSmf(45))).durationSteps, 0.5);
    // 36 ticks = 0.3 steps: nearest grid line is 0.25.
    assert.equal(36 / TICKS_PER_STEP, 0.3);
    assert.equal((await parseSingleNote(oneNoteSmf(36))).durationSteps, 0.25);
  });

  it('a degenerate zero-length note is raised to the 0.25-step minimum, never dropped', async () => {
    assert.equal((await parseSingleNote(oneNoteSmf(0))).durationSteps, 0.25);
    // 10 ticks is 0.0833 steps — below the minimum, so it lands on it.
    assert.equal((await parseSingleNote(oneNoteSmf(10))).durationSteps, 0.25);
  });

  it('a note started away from tick 0 keeps its onset and its own length', async () => {
    // note-on at tick 300 (2.5 steps), note-off 30 ticks later.
    const buffer = buildFormat0([
      { delta: 300, data: [0x90, 62, 90] },
      { delta: 30, data: [0x80, 62, 0] },
    ]);
    const parsed = await parseSingleNote(buffer);
    assert.equal(parsed.startStep, 2.5);
    assert.equal(parsed.durationSteps, 0.25);
  });
});

describe('Phase 1D G — a 0.25-step note survives export then import', () => {
  it('the exporter writes exactly 30 ticks for a 0.25-step note', async () => {
    const blob = MidiParser.exportNotesToMidi([makeNote(0.25)], 120, 'Round Trip');
    const buffer = await blob.arrayBuffer();
    const pairs = decodeNotePairs(buffer);

    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].startTick, 0);
    assert.equal(pairs[0].endTick, 30, '0.25 steps * 120 ticks/step');
    assert.equal(pairs[0].endTick - pairs[0].startTick, 30);
  });

  it('exporting then importing returns the same duration for every supported length', async () => {
    const durations = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
    for (const duration of durations) {
      const blob = MidiParser.exportNotesToMidi([makeNote(duration, 3)], 120, 'Round Trip');
      const buffer = await blob.arrayBuffer();

      const pairs = decodeNotePairs(buffer);
      assert.equal(pairs.length, 1, `${duration} steps must produce one note pair`);
      assert.equal(pairs[0].startTick, 3 * TICKS_PER_STEP, `${duration} steps must start at tick ${3 * TICKS_PER_STEP}`);
      assert.equal(
        pairs[0].endTick - pairs[0].startTick,
        duration * TICKS_PER_STEP,
        `${duration} steps must last ${duration * TICKS_PER_STEP} ticks`,
      );

      const tracks = await MidiParser.parseMidiFile(buffer);
      assert.equal(tracks[0].notes.length, 1);
      assert.equal(tracks[0].notes[0].startStep, 3);
      assert.equal(tracks[0].notes[0].durationSteps, duration, `${duration} steps must round-trip to ${duration}`);
    }
  });

  it('a whole pattern of mixed short notes round-trips note for note', async () => {
    const notes = [makeNote(0.25, 0), makeNote(0.5, 0.25), makeNote(0.25, 0.75), makeNote(1.5, 1), makeNote(0.75, 3)];
    const blob = MidiParser.exportNotesToMidi(notes, 120, 'Round Trip');
    const buffer = await blob.arrayBuffer();

    const tracks = await MidiParser.parseMidiFile(buffer);
    const imported = [...tracks[0].notes].sort((a, b) => a.startStep - b.startStep);
    const expected = [...notes].sort((a, b) => a.start - b.start);

    assert.equal(imported.length, notes.length);
    imported.forEach((note, index) => {
      assert.equal(note.startStep, expected[index].start, 'onset must round-trip');
      assert.equal(note.durationSteps, expected[index].duration, 'duration must round-trip');
      assert.equal(note.pitch, expected[index].pitch, 'pitch must round-trip');
    });
  });

  it('keeps 480 PPQ and 120 ticks per step in both directions', async () => {
    const blob = MidiParser.exportNotesToMidi([makeNote(1)], 120, 'Round Trip');
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);

    assert.equal(view.getUint16(12), PPQ, 'the exported division must be 480 PPQ');
    assert.equal(TICKS_PER_BEAT / 4, TICKS_PER_STEP, 'one step is a quarter of a beat');
    assert.equal(decodeNotePairs(buffer)[0].endTick, TICKS_PER_STEP, 'a 1-step note is 120 ticks');
  });
});
