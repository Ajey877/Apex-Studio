/**
 * Phase 64 — F3: Standard MIDI export.
 *
 * The export dialog offers a scope (Full Song / Pattern Loop) and states the
 * bar count it will write, but `buildStandardMidiFile` received only
 * `(channels, clips, meta)`: the scope was dropped, so a "Pattern Loop (4 bars)"
 * export contained events from the whole arrangement. It also serialised only
 * `Channel.notes`, so a Channel Rack step pattern — the primary drum workflow —
 * exported as an empty track, and `PlaylistClip.offsetSteps` and playlist lane
 * mutes were ignored while playback and the WAV renderer honour both.
 *
 * Every assertion below decodes the real bytes the production function emits.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStandardMidiFile,
  getProjectRenderBars,
} from './exportUtils';
import type { Channel, PlaylistClip, PlaylistTrack } from '../types/daw';

const TICKS_PER_BAR = 1920;
const TICKS_PER_STEP = 120;

interface DecodedNote {
  tick: number;
  channel: number;
  pitch: number;
  velocity: number;
}

interface DecodedTrack {
  name: string | null;
  notes: DecodedNote[];
  audioTicks: number[];
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
    const audioTicks: number[] = [];
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
      const command = status & 0xf0;
      if (command === 0x90 && data[1] > 0) {
        notes.push({
          tick,
          channel: status & 0x0f,
          pitch: data[0],
          velocity: data[1],
        });
      } else if (command === 0xb0) {
        audioTicks.push(tick);
      }
    }

    tracks.push({ name, notes, audioTicks, endTick: tick });
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

describe('Phase 64 F3 — Pattern Loop scope is preserved in the .mid', () => {
  it('writes only the requested bar window, not the whole arrangement', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [
      patternClip('clip-1', 'ch-lead', 0),
      patternClip('clip-2', 'ch-lead', 8),
      patternClip('clip-3', 'ch-lead', 24),
    ];

    const patternBars = getProjectRenderBars(clips, 'pattern', 16);
    assert.equal(patternBars, 4, 'the dialog advertises a 4-bar pattern loop');

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));

    const noteOns = decoded.tracks.flatMap(track => track.notes);
    assert.equal(noteOns.length, 1, 'only the clip inside the loop window is exported');
    for (const note of noteOns) {
      assert.ok(
        note.tick < patternBars * TICKS_PER_BAR,
        `note at tick ${note.tick} is outside the advertised ${patternBars}-bar window`,
      );
    }
  });

  it('keeps Full Song scope spanning the last clip', async () => {
    const lead = channel('ch-lead', {
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    });
    const clips = [
      patternClip('clip-1', 'ch-lead', 0),
      patternClip('clip-2', 'ch-lead', 8),
    ];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, { scope: 'song' }),
    ));
    const ticks = decoded.tracks.flatMap(track => track.notes.map(note => note.tick)).sort((a, b) => a - b);
    assert.deepEqual(ticks, [0, 8 * TICKS_PER_BAR], 'song scope keeps every clip start');
  });

  it('drops events at or past the end of the render window', async () => {
    const lead = channel('ch-lead', {
      notes: [
        { id: 'inside', pitch: 60, start: 0, duration: 2, velocity: 0.9 },
        { id: 'outside', pitch: 72, start: 8, duration: 2, velocity: 0.9 },
      ],
    });
    // A note starting at bar 3 of a 2-bar clip sits past a 2-bar render window.
    const clips = [patternClip('clip-1', 'ch-lead', 0, { lengthBars: 4 })];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([lead], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'song',
        totalBars: 2,
      }),
    ));
    const pitches = decoded.tracks.flatMap(track => track.notes.map(note => note.pitch));
    assert.deepEqual(pitches, [60], 'the note past the 2-bar window is not exported');
  });
});

describe('Phase 64 F3 — step-sequencer content is exported', () => {
  it('serialises Channel.steps as notes on the 16th-note grid', async () => {
    const steps = new Array(16).fill(false);
    steps[0] = true;
    steps[3] = true;
    steps[7] = true;
    const drums = channel('ch-drums', { instrumentType: 'drumpad', steps });
    const clips = [patternClip('clip-1', 'ch-drums', 0)];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([drums], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));

    const notes = decoded.tracks[0].notes.sort((a, b) => a.tick - b.tick);
    assert.deepEqual(
      notes.map(note => note.tick),
      [0, 3 * TICKS_PER_STEP, 7 * TICKS_PER_STEP],
      'every active step must produce a note at its own 16th-note position',
    );
    assert.ok(notes.every(note => note.velocity === Math.round(0.9 * 127)));
    assert.deepEqual(
      notes.map(note => note.pitch),
      [36, 36, 36],
      'drum-pad steps use the channel default pitch',
    );
  });

  it('exports step and piano-roll content together for one channel', async () => {
    const steps = new Array(16).fill(false);
    steps[2] = true;
    const synth = channel('ch-synth', {
      steps,
      notes: [{ id: 'n1', pitch: 64, start: 5, duration: 2, velocity: 0.8 }],
    });
    const clips = [patternClip('clip-1', 'ch-synth', 0)];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([synth], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));
    const notes = decoded.tracks[0].notes.sort((a, b) => a.tick - b.tick);
    assert.deepEqual(notes.map(note => note.tick), [2 * TICKS_PER_STEP, 5 * TICKS_PER_STEP]);
    assert.deepEqual(notes.map(note => note.pitch), [60, 64]);
  });

  it('repeats a short pattern across a multi-loop render window', async () => {
    const steps = new Array(16).fill(false);
    steps[0] = true;
    const drums = channel('ch-drums', { instrumentType: 'drumpad', steps });
    // A 32-step (2-bar) loop rendered into the dialog's 4-bar pattern window.
    const clips = [patternClip('clip-1', 'ch-drums', 0, { lengthBars: 4 })];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([drums], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 32,
      }),
    ));
    assert.deepEqual(
      decoded.tracks[0].notes.map(note => note.tick),
      [0, 2 * TICKS_PER_BAR],
      'the loop restarts every pattern length inside the window',
    );
  });
});

describe('Phase 64 F3 — clip offset and lane mute semantics', () => {
  it('applies PlaylistClip.offsetSteps the way playback does', async () => {
    const steps = new Array(16).fill(false);
    steps[3] = true;
    const drums = channel('ch-drums', { instrumentType: 'drumpad', steps });
    // offsetSteps = 2 rotates the content: content step 3 sounds at step 1.
    const clips = [patternClip('clip-1', 'ch-drums', 0, { offsetSteps: 2 })];

    const decoded = decodeMidiFile(await asBytes(
      buildStandardMidiFile([drums], clips, { bpm: 120, timeSignature: [4, 4] }, {
        scope: 'pattern',
        patternLengthSteps: 16,
      }),
    ));
    assert.deepEqual(decoded.tracks[0].notes.map(note => note.tick), [1 * TICKS_PER_STEP]);
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
      decoded.tracks[0].notes.map(note => note.tick),
      [0],
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
  it('keeps the three-argument form working and unscoped', async () => {
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
    assert.deepEqual(decoded.tracks[0].notes.map(note => note.tick), [8 * TICKS_PER_BAR]);
  });

  it('reports the window it actually wrote so the dialog cannot overstate it', async () => {
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
    const lastNoteTick = Math.max(...decoded.tracks.flatMap(track => track.notes.map(note => note.tick)));
    assert.ok(lastNoteTick < getProjectRenderBars(clips, 'pattern', 16) * TICKS_PER_BAR);
  });
});
