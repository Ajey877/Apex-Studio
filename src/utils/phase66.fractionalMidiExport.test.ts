/**
 * Phase 66 — F1 (MIDI representation): the project MIDI export keeps sub-step
 * note onsets.
 *
 * `Note.start` is a step position that may be fractional (Piano Roll chord
 * stamping, "Strum Chords", MIDI import's quarter-step quantiser). The project
 * writer (`buildStandardMidiFile`) resolved a note's position with
 * `Math.round(note.start)`, so a 4.2 onset was written to step 4 and a 4.5 onset
 * could be written a whole step late, at step 5 — while the audible scheduler
 * (after Phase 66 F1) plays it 0.2 (or 0.5) of a step after the step-4 boundary.
 *
 * MIDI has 120 ticks per 16th-note step (`TICKS_PER_STEP`), i.e. far finer than
 * the 0.04-step strum offsets the Piano Roll writes, so the writer can — and the
 * Piano Roll's own `MidiParser.exportNotesToMidi` already does — represent the
 * onset exactly. A sub-step onset must not be silently moved to another step:
 * audio playback and the MIDI file must describe the same performance.
 *
 * Every assertion decodes the real bytes the production writer emits.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStandardMidiFile } from './exportUtils';
import type { Channel, Note, ProjectMetadata } from '../types/daw';

const TICKS_PER_STEP = 120;
const STEPS_PER_BAR = 16;

interface DecodedNote {
  tick: number;
  channel: number;
  pitch: number;
  velocity: number;
}

const readVlq = (bytes: Uint8Array, offset: number): { value: number; next: number } => {
  let value = 0;
  let index = offset;
  for (;;) {
    const byte = bytes[index];
    value = (value << 7) | (byte & 0x7f);
    index += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: index };
};

const decodeNotes = (bytes: Uint8Array): DecodedNote[] => {
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd', 'missing MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4);
  const trackCount = view.getUint16(10);
  const notes: DecodedNote[] = [];
  let cursor = 8 + headerLength;

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    assert.equal(String.fromCharCode(...bytes.slice(cursor, cursor + 4)), 'MTrk', 'missing MTrk');
    const length = view.getUint32(cursor + 4);
    const end = cursor + 8 + length;
    let index = cursor + 8;
    let tick = 0;
    let runningStatus: number | null = null;

    while (index < end) {
      const delta = readVlq(bytes, index);
      tick += delta.value;
      index = delta.next;
      let status = bytes[index];
      if (status < 0x80) {
        assert.ok(runningStatus !== null, 'running status without a prior status byte');
        status = runningStatus;
      } else {
        index += 1;
        if (status < 0xf0) runningStatus = status;
      }

      if (status === 0xff) {
        const metaType = bytes[index];
        index += 1;
        const metaLength = readVlq(bytes, index);
        index = metaLength.next;
        if (metaType === 0x2f) {
          index = end;
          break;
        }
        index += metaLength.value;
        continue;
      }

      const dataLength = status >= 0xf0 ? 0 : 2;
      const data = Array.from(bytes.slice(index, index + dataLength));
      index += dataLength;
      if ((status & 0xf0) === 0x90 && data[1] > 0) {
        notes.push({ tick, channel: status & 0x0f, pitch: data[0], velocity: data[1] });
      }
    }

    cursor = end;
  }

  return notes;
};

const makeNote = (id: string, pitch: number, start: number): Note => ({
  id,
  pitch,
  start,
  duration: 1,
  velocity: 0.9,
});

const makeChannel = (notes: Note[]): Channel => ({
  id: 'ch-1',
  name: 'Lead',
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(STEPS_PER_BAR).fill(false),
  notes,
  synthParams: {} as Channel['synthParams'],
});

const META: Pick<ProjectMetadata, 'bpm' | 'timeSignature'> = { bpm: 90, timeSignature: [4, 4] };

const exportPatternBytes = async (channel: Channel): Promise<Uint8Array> => {
  const blob = buildStandardMidiFile([channel], [], META, { scope: 'pattern', patternLengthSteps: STEPS_PER_BAR });
  return new Uint8Array(await blob.arrayBuffer());
};

/** The export window is 4 bars, so a 1-bar loop repeats: keep the first pass. */
const firstPass = (notes: DecodedNote[]): DecodedNote[] =>
  notes.filter(note => note.tick < STEPS_PER_BAR * TICKS_PER_STEP);

describe('Phase 66 F1 — the project MIDI export preserves sub-step note onsets', () => {
  it('writes a strummed chord at its exact tick positions, not rounded to the step grid', async () => {
    const bytes = await exportPatternBytes(makeChannel([
      makeNote('n-4', 60, 4),
      makeNote('n-4-1', 64, 4.1),
      makeNote('n-4-2', 67, 4.2),
    ]));

    const notes = firstPass(decodeNotes(bytes));
    assert.equal(notes.length, 3, 'all three onsets are written in the first pass');
    const tickOf = (pitch: number): number => notes.find(note => note.pitch === pitch)!.tick;
    assert.equal(tickOf(60), 4 * TICKS_PER_STEP);
    assert.ok(
      Math.abs(tickOf(64) - 4.1 * TICKS_PER_STEP) < 1e-9,
      `a 4.1 onset belongs at tick ${4.1 * TICKS_PER_STEP}, wrote ${tickOf(64)}`,
    );
    assert.ok(
      Math.abs(tickOf(67) - 4.2 * TICKS_PER_STEP) < 1e-9,
      `a 4.2 onset belongs at tick ${4.2 * TICKS_PER_STEP}, wrote ${tickOf(67)}`,
    );
  });

  it('never moves a half-step onset into the next step', async () => {
    const bytes = await exportPatternBytes(makeChannel([makeNote('n-4-5', 70, 4.5)]));
    const notes = firstPass(decodeNotes(bytes));

    assert.equal(notes.length, 1);
    assert.equal(notes[0].tick, 4.5 * TICKS_PER_STEP, 'rounding a 4.5 onset up to step 5 is a whole step of drift');
  });

  it('writes quarter-step imported onsets exactly', async () => {
    const bytes = await exportPatternBytes(makeChannel([
      makeNote('m-1', 60, 4),
      makeNote('m-2', 63, 4.25),
      makeNote('m-3', 67, 4.75),
    ]));

    const notes = firstPass(decodeNotes(bytes));
    const tickOf = (pitch: number): number => notes.find(note => note.pitch === pitch)!.tick;
    assert.equal(tickOf(60), 480);
    assert.equal(tickOf(63), 510);
    assert.equal(tickOf(67), 570);
  });

  it('repeats a sub-step onset on the same sub-step of every loop pass', async () => {
    // A 0.04-step strum offset is 4.8 ticks, so the file stores it on its own
    // 120-ticks-per-step grid (5 ticks). That is the encoder's resolution, not a
    // rounding to the step grid: the onset stays inside step 1 on every pass.
    const onsetTick = Math.round(1.04 * TICKS_PER_STEP);
    const bytes = await exportPatternBytes(makeChannel([makeNote('n-1-04', 60, 1.04)]));
    const notes = decodeNotes(bytes);

    assert.ok(notes.length >= 2, 'the pattern loop repeats the onset');
    assert.equal(notes[0].tick, onsetTick);
    assert.equal(notes[0].tick < TICKS_PER_STEP, false, 'the onset is not the step boundary itself');
    assert.equal(
      notes[1].tick,
      Math.round((onsetTick / TICKS_PER_STEP + STEPS_PER_BAR) * TICKS_PER_STEP),
      'the repeat keeps the sub-step offset of the first pass',
    );
  });

  it('keeps the channel step lane on the integer grid', async () => {
    const channel = makeChannel([makeNote('n-4', 60, 4)]);
    channel.steps[2] = true;
    const bytes = await exportPatternBytes(channel);
    const notes = firstPass(decodeNotes(bytes));

    assert.deepEqual(
      notes.map(note => note.tick).sort((a, b) => a - b),
      [2 * TICKS_PER_STEP, 4 * TICKS_PER_STEP],
      'step-lane hits stay exactly on their step',
    );
  });
});
