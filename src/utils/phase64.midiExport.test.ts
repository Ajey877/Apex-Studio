/**
 * Phase 64 — F3: Standard MIDI export.
 *
 * The export dialog offers a scope (Full Song / Pattern Loop) and states the bar
 * count it will write, but `buildStandardMidiFile` received only
 * `(channels, clips, meta)`: the scope was dropped, so a "Pattern Loop (4 bars)"
 * export contained events from the entire arrangement. It also serialised only
 * `Channel.notes`, so a Channel Rack step pattern — the primary drum workflow —
 * exported as an empty track, while `PlaylistClip.offsetSteps` and playlist lane
 * mutes were ignored.
 *
 * Every expectation below mirrors the offline WAV renderer's scheduler, which is
 * the audible definition of what an export of this window contains:
 * - song scope repeats a channel's content inside each clip at
 *   `resolvePlayableContentLengthSteps()`, shifted by `clip.offsetSteps`;
 * - pattern scope wraps at `resolvePatternLoopLengthSteps()`, which the declared
 *   `Pattern.lengthSteps` makes authoritative;
 * - a muted clip, and every clip on a muted lane, is skipped;
 * - nothing is written outside the advertised window.
 *
 * Every assertion decodes the real bytes the production function emits.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStandardMidiFile,
  getProjectRenderBars,
} from './exportUtils';
import type { Channel, PlaylistClip, PlaylistTrack } from '../types/daw';

const TICKS_PER_STEP = 120;
const TICKS_PER_BAR = 1920;
const STEPS_PER_BAR = 16;

interface DecodedNote {
  tick: number;
  channel: number;
  pitch: number;
  velocity: number;
}

interface DecodedTrack {
  name: string | null;
  notes: DecodedNote[];
  endTick: number;
}

interface DecodedMidi {
  format: number;
  trackCount: number;
  ticksPerQuarter: number;
  tracks: DecodedTrack[];
}

/** Independent VLQ reader — deliberately not sharing code with the writer. */
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

export function decodeMidiFile(bytes: Uint8Array): DecodedMidi {
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd', 'missing MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4);
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const ticksPerQuarter = view.getUint16(12);

  const tracks: DecodedTrack[] = [];
  let cursor = 8 + headerLength;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    assert.equal(String.fromCharCode(...bytes.slice(cursor, cursor + 4)), 'MTrk', 'missing MTrk');
    const length = view.getUint32(cursor + 4);
    const end = cursor + 8 + length;
    let index = cursor + 8;
    let tick = 0;
    let runningStatus: number | null = null;
    const notes: DecodedNote[] = [];
    let name: string | null = null;

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
        if (metaType === 0x03) {
          name = String.fromCharCode(...bytes.slice(index, index + metaLength.value));
        }
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

    tracks.push({ name, notes, endTick: tick });
    cursor = end;
  }

  return { format, trackCount, ticksPerQuarter, tracks };
}

const channel = (id: string, overrides: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes: [],
  synthParams: {} as Channel['synthParams'],
  ...overrides,
});

const stepsAt = (active: number[], length = 16): boolean[] => {
  const steps = new Array(length).fill(false);
  for (const index of active) steps[index] = true;
  return steps;
};

const patternClip = (
  id: string,
  channelId: string,
  startBar: number,
  overrides: Partial<PlaylistClip> = {},
): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar,
  lengthBars: 2,
  type: 'pattern',
  channelId,
  color: '#fff',
  name: id,
  ...overrides,
});

const playlistTracks = (count: number): PlaylistTrack[] =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Lane ${index + 1}`,
    color: '#fff',
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
  }));

const asBytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

const noteTicks = (decoded: DecodedMidi, trackIndex = 0): number[] =>
  decoded.tracks[trackIndex].notes.map(note => note.tick);

describe('Phase 64 F3 — export scope selects the written window', () => {
  it('writes only the pattern-loop window, not the whole arrangement', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [
      patternClip('clip-1', 'ch-lead', 0),
      patternClip('clip-2', 'ch-lead', 8),
      patternClip('clip-3', 'ch-lead', 24),
    ];

    const windowBars = getProjectRenderBars(clips, 'pattern', 16);
    assert.equal(windowBars, 4, 'the dialog advertises a 4-bar pattern loop');

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));

    // Pattern Mode wraps every 16 steps, so the 4-bar window holds four passes.
    assert.deepEqual(
      noteTicks(decoded),
      [0, 1, 2, 3].map(pass => pass * STEPS_PER_BAR * TICKS_PER_STEP),
    );
    for (const tick of noteTicks(decoded)) {
      assert.ok(
        tick < windowBars * TICKS_PER_BAR,
        `note at tick ${tick} is outside the advertised ${windowBars}-bar window`,
      );
    }
  });

  it('keeps Song scope spanning the whole arrangement', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [
      patternClip('clip-1', 'ch-lead', 0),
      patternClip('clip-2', 'ch-lead', 8),
    ];

    const songScope = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, { scope: 'song' }),
    ));
    assert.deepEqual(
      noteTicks(songScope),
      [0, STEPS_PER_BAR, 8 * STEPS_PER_BAR, 8 * STEPS_PER_BAR + STEPS_PER_BAR].map(step => step * TICKS_PER_STEP),
      'song scope writes every clip in the arrangement',
    );

    const patternScope = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));
    assert.ok(
      noteTicks(patternScope).every(tick => tick < 4 * TICKS_PER_BAR),
      'pattern scope must not reach the clip at bar 9',
    );
  });

  it('drops events at or past the end of the render window', async () => {
    const lead = channel('ch-lead', {
      notes: [
        { id: 'inside', pitch: 60, start: 0, duration: 2, velocity: 0.9 },
        { id: 'outside', pitch: 72, start: 32, duration: 2, velocity: 0.9 },
      ],
    });
    // A 4-bar clip in a project the user has shortened to 2 bars.
    const clips = [patternClip('clip-1', 'ch-lead', 0, { lengthBars: 4 })];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'song',
        totalBars: 2,
      }),
    ));
    assert.deepEqual(noteTicks(decoded), [0], 'the event past the 2-bar window is not written');
  });
});

describe('Phase 64 F3 — step-sequencer content is exported', () => {
  it('serialises Channel.steps as notes on the 16th-note grid', async () => {
    const drums = channel('ch-drums', { instrumentType: 'drumpad', steps: stepsAt([0, 3, 7]) });
    const clips = [patternClip('clip-1', 'ch-drums', 0)];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([drums], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));

    const notes = decoded.tracks[0].notes;
    const perLoop = [0, 3, 7];
    assert.deepEqual(
      noteTicks(decoded),
      [0, 1, 2, 3].flatMap(pass => perLoop.map(step => (pass * STEPS_PER_BAR + step) * TICKS_PER_STEP)),
      'every active step must produce a note at its own 16th-note position in every loop pass',
    );
    assert.ok(notes.every(note => note.velocity === Math.round(0.9 * 127)));
    assert.ok(notes.every(note => note.pitch === 36), 'drum-pad steps use the channel default pitch');
  });

  it('exports step and piano-roll content together for one channel', async () => {
    const synth = channel('ch-synth', {
      steps: stepsAt([2]),
      notes: [{ id: 'n1', pitch: 64, start: 5, duration: 2, velocity: 0.8 }],
    });
    const clips = [patternClip('clip-1', 'ch-synth', 0)];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([synth], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));
    const notes = decoded.tracks[0].notes;
    assert.deepEqual(
      noteTicks(decoded),
      [0, 1, 2, 3].flatMap(pass => [2, 5].map(step => (pass * STEPS_PER_BAR + step) * TICKS_PER_STEP)),
    );
    assert.deepEqual([...new Set(notes.map(note => note.pitch))], [60, 64]);
  });

  it('repeats a short pattern across a multi-loop render window', async () => {
    const drums = channel('ch-drums', { instrumentType: 'drumpad', steps: stepsAt([0]) });
    const clips = [patternClip('clip-1', 'ch-drums', 0, { lengthBars: 4 })];

    // A declared 2-bar pattern loop rendered into the dialog's 4-bar window.
    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([drums], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 32,
      }),
    ));
    assert.deepEqual(noteTicks(decoded), [0, 2 * TICKS_PER_BAR], 'the loop restarts every pattern length');
  });
});

describe('Phase 64 F3 — clip offset and lane mute semantics', () => {
  it('keeps Pattern scope clip-less: a clip offset cannot trim the pattern loop', async () => {
    // Pattern Mode never consults clips, so `offsetSteps` — a clip property —
    // has no meaning there. The loop boundary stays the declared pattern length.
    const drums = channel('ch-drums', { instrumentType: 'drumpad', steps: stepsAt([19], 32) });
    const clips = [patternClip('clip-1', 'ch-drums', 0, { offsetSteps: 2 })];
    const windowBars = getProjectRenderBars(clips, 'pattern', 32);
    assert.equal(windowBars, 4);

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([drums], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 32,
      }),
    ));
    assert.deepEqual(
      noteTicks(decoded),
      [19 * TICKS_PER_STEP, 19 * TICKS_PER_STEP + 2 * TICKS_PER_BAR],
      'the content keeps its own step position and wraps at the declared length',
    );
  });

  it('applies PlaylistClip.offsetSteps in Song scope too', async () => {
    const drums = channel('ch-drums', { instrumentType: 'drumpad', steps: stepsAt([3]) });
    const clips = [patternClip('clip-1', 'ch-drums', 4, { offsetSteps: 2 })];
    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([drums], clips, { bpm: 120, timeSignature: [4, 4] }, { scope: 'song' }),
    ));
    const clipStartTick = 4 * TICKS_PER_BAR;
    assert.deepEqual(
      noteTicks(decoded),
      [clipStartTick + TICKS_PER_STEP, clipStartTick + TICKS_PER_STEP + STEPS_PER_BAR * TICKS_PER_STEP],
      'content step 3 trimmed by 2 sounds on the clip grid at step 1, then loops',
    );
  });

  it('omits muted playlist lanes, matching the WAV renderer', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [
      patternClip('clip-1', 'ch-lead', 0, { trackIndex: 0 }),
      patternClip('clip-2', 'ch-lead', 4, { trackIndex: 1 }),
    ];
    const lanes = playlistTracks(2);
    lanes[1] = { ...lanes[1], mute: true };

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'song',
        playlistTracks: lanes,
      }),
    ));
    assert.deepEqual(
      noteTicks(decoded),
      [0, STEPS_PER_BAR * TICKS_PER_STEP],
      'a muted lane must not reach the exported MIDI',
    );
  });

  it('keeps a muted clip out of the export (existing contract)', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [patternClip('clip-1', 'ch-lead', 0, { mute: true })];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }),
    ));
    assert.deepEqual(decoded.tracks[0].notes, []);
  });
});

describe('Phase 64 F3 — legacy callers and file structure', () => {
  it('keeps the three-argument form working and unscoped (Song)', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [patternClip('clip-1', 'ch-lead', 8)];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }),
    ));
    assert.equal(decoded.format, 0, 'a single-channel file is a format-0 file');
    assert.equal(decoded.trackCount, 1);
    assert.equal(decoded.ticksPerQuarter, 480);
    assert.deepEqual(
      noteTicks(decoded),
      [8 * STEPS_PER_BAR * TICKS_PER_STEP, 9 * STEPS_PER_BAR * TICKS_PER_STEP],
      'the clip content repeats inside its 2-bar clip',
    );
  });

  it('never writes content the advertised window cannot hold', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [patternClip('clip-1', 'ch-lead', 0), patternClip('clip-2', 'ch-lead', 12)];
    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));
    const windowTicks = getProjectRenderBars(clips, 'pattern', 16) * TICKS_PER_BAR;
    assert.ok(noteTicks(decoded).every(tick => tick < windowTicks));
  });

  it('names each track after its channel', async () => {
    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile(
        [channel('ch-lead', { name: 'Lead Pluck' })],
        [patternClip('clip-1', 'ch-lead', 0)],
        { bpm: 120, timeSignature: [4, 4] },
      ),
    ));
    assert.equal(decoded.tracks[0].name, 'Lead Pluck');
  });
});
