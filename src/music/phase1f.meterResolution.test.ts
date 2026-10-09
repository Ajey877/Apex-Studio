/**
 * Phase 1F/1I — truthful project-meter runtime: meter resolution authority,
 * backward compatibility, recording timing, MIDI export parity and playlist
 * bar arithmetic. Phase 1I extends the same coverage to 7/8.
 *
 * Core invariant:
 *   For supported meters, `stepsPerBar(project.meta.timeSignature)` is the
 *   authoritative runtime bar size (3/4 = 12 steps; 7/8 = 14 steps).
 *   Missing/unsupported meter metadata resolves to legacy [4,4].
 *   `Pattern.lengthSteps` is an ABSOLUTE step quantity and is never
 *   reinterpreted when the meter changes (16 stays 16, never 16 -> 12).
 *
 * These tests exercise production functions directly. No source scanners.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  barsToBeats,
  beatsPerBar,
  beatsToSeconds,
  stepsPerBar,
  LEGACY_TIME_SIGNATURE,
  resolveProjectTimeSignature,
  isRuntimeSupportedMeter,
  type TimeSignature,
} from './musicalTime';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import {
  normalizePatternLengthSteps,
  setPatternLengthStepsInProjectState,
  getSelectedPatternLengthSteps,
} from '../state/patternLength';
import {
  resolvePatternLoopLengthSteps,
  resolvePlayableContentLengthSteps,
} from '../audio/audioEngine';
import { getRecordingLengthBars, createRecordingPlaylistClip } from '../audio/recordingPipeline';
import { buildStandardMidiFile, getProjectRenderBars } from '../utils/exportUtils';
import { splitPlaylistClip, resizePlaylistClipLeft } from '../components/playlistClipOperations';
import type { Channel, PlaylistClip } from '../types/daw';

const mkChannel = (id: string, opts: Partial<Channel> = {}): Channel => ({
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
  steps: Array(16).fill(false),
  notes: [],
  synthParams: {} as Channel['synthParams'],
  ...opts,
});

const mkClip = (channelId: string, startBar: number, lengthBars: number, overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: `clip-${channelId}-${startBar}`,
  trackIndex: 0,
  startBar,
  lengthBars,
  type: 'pattern',
  channelId,
  color: '#fff',
  name: channelId,
  ...overrides,
});

// ---------------------------------------------------------------------------
// TEST N — missing / legacy meter metadata resolves to 4/4
// ---------------------------------------------------------------------------
describe('Phase 1F TEST N — meter resolution authority falls back to 4/4', () => {
  it('missing meta, missing field, undefined and null all resolve to [4,4]', () => {
    assert.deepEqual(resolveProjectTimeSignature(undefined), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature(null), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({}), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: undefined }), [4, 4]);
  });

  it('explicit supported meters resolve to themselves', () => {
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [4, 4] }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [3, 4] }), [3, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [6, 8] }), [6, 8]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [7, 8] }), [7, 8]);
  });

  it('unsupported or malformed values fall back to [4,4]', () => {
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [5, 4] }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [3, 3] }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [0, 4] }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [-3, 4] }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: '3/4' }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [3] }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [3, 4, 5] }), [4, 4]);
    assert.deepEqual(resolveProjectTimeSignature({ timeSignature: [NaN, 4] }), [4, 4]);
  });

  it('never mutates the supplied metadata object', () => {
    const meta: { timeSignature?: unknown } = { timeSignature: [3, 4] };
    resolveProjectTimeSignature(meta);
    assert.deepEqual(meta, { timeSignature: [3, 4] });
    const badMeta: { timeSignature?: unknown } = { timeSignature: [5, 4] };
    resolveProjectTimeSignature(badMeta);
    assert.deepEqual(badMeta, { timeSignature: [5, 4] });
  });

  it('classifies runtime-supported meters explicitly (6/8 mechanical; 7/8 supported)', () => {
    assert.equal(isRuntimeSupportedMeter([4, 4]), true);
    assert.equal(isRuntimeSupportedMeter([3, 4]), true);
    assert.equal(isRuntimeSupportedMeter([6, 8]), true);
    assert.equal(isRuntimeSupportedMeter([7, 8]), true);
    assert.equal(isRuntimeSupportedMeter([5, 4]), false);
    assert.equal(isRuntimeSupportedMeter([2, 4]), false);
    assert.equal(isRuntimeSupportedMeter(undefined), false);
  });

  it('a legacy persisted project without meta.timeSignature normalizes to [4,4]', () => {
    const legacy = JSON.parse(JSON.stringify(createDefaultProjectState()));
    delete (legacy.meta as Record<string, unknown>).timeSignature;
    const restored = normalizeProjectState(legacy);
    assert.deepEqual(restored.meta.timeSignature, [4, 4]);
    // and the resolver agrees on the raw stored shape
    assert.deepEqual(resolveProjectTimeSignature(legacy.meta as never), [4, 4]);
  });

  it('a persisted 7/8 project keeps its meter through project normalization', () => {
    const project = createDefaultProjectState();
    project.meta.timeSignature = [7, 8];
    assert.deepEqual(normalizeProjectState(project).meta.timeSignature, [7, 8]);
  });
});

// ---------------------------------------------------------------------------
// Bar-size arithmetic: 3/4 is 12 steps / 1.5 s at 120 BPM
// ---------------------------------------------------------------------------
describe('Phase 1F — 3/4 bar size arithmetic (steps and seconds)', () => {
  it('TEST B (math layer): a resolved 3/4 bar is 12 sixteenth-note steps', () => {
    const meter = resolveProjectTimeSignature({ timeSignature: [3, 4] });
    assert.equal(stepsPerBar(meter), 12);
    assert.equal(beatsPerBar(meter), 3);
  });

  it('TEST C (math layer): a 3/4 bar lasts 1.5 seconds at 120 BPM', () => {
    const meter = resolveProjectTimeSignature({ timeSignature: [3, 4] });
    const seconds = beatsToSeconds(barsToBeats(1, meter), 120);
    assert.ok(Math.abs(seconds - 1.5) < 1e-12, `expected 1.5s, got ${seconds}`);
  });

  it('TEST A (math layer): 4/4 remains 16 steps / 2.0 seconds at 120 BPM', () => {
    const meter = resolveProjectTimeSignature({ timeSignature: [4, 4] });
    assert.equal(stepsPerBar(meter), 16);
    const seconds = beatsToSeconds(barsToBeats(1, meter), 120);
    assert.ok(Math.abs(seconds - 2.0) < 1e-12, `expected 2.0s, got ${seconds}`);
  });

  it('6/8 is mechanically a 12-step bar (documented: no compound grouping)', () => {
    const meter = resolveProjectTimeSignature({ timeSignature: [6, 8] });
    assert.deepEqual(meter, [6, 8]);
    assert.equal(stepsPerBar(meter), 12);
    // Mechanical support only: the model and existing display give 3
    // quarter-note beats per bar, with no compound-beat grouping added here.
    assert.equal(beatsPerBar(meter), 3);
  });
});

// ---------------------------------------------------------------------------
// Phase 1I — 7/8 resolves to a 14-step bar / 3.5 quarter-note beats
// ---------------------------------------------------------------------------
describe('Phase 1I — 7/8 meter arithmetic', () => {
  it('a 7/8 bar is 14 sixteenth-note steps and lasts 1.75 seconds at 120 BPM', () => {
    const meter = resolveProjectTimeSignature({ timeSignature: [7, 8] });
    assert.equal(stepsPerBar(meter), 14);
    assert.equal(beatsPerBar(meter), 3.5);
    const seconds = beatsToSeconds(barsToBeats(1, meter), 120);
    assert.equal(seconds, 1.75);
  });
});

// ---------------------------------------------------------------------------
// TEST O — Pattern.lengthSteps stays an absolute step quantity in 3/4
// ---------------------------------------------------------------------------
describe('Phase 1F TEST O — pattern length is never reinterpreted by the meter', () => {
  it('a stored lengthSteps of 16 remains 16 in a 3/4 project', () => {
    const project = createDefaultProjectState();
    project.meta.timeSignature = [3, 4];
    project.patterns[0].lengthSteps = 16;

    assert.equal(normalizePatternLengthSteps(project.patterns[0].lengthSteps), 16);
    assert.equal(getSelectedPatternLengthSteps(project), 16);

    const next = setPatternLengthStepsInProjectState(project, project.patterns[0].id, 16);
    assert.equal(next.patterns[0].lengthSteps, 16);
  });

  it('a stored lengthSteps of 32 remains 32 in a 3/4 project', () => {
    const project = createDefaultProjectState();
    project.meta.timeSignature = [3, 4];
    project.patterns[0].lengthSteps = 32;
    assert.equal(normalizePatternLengthSteps(32), 32);
    assert.equal(getSelectedPatternLengthSteps(project), 32);
  });

  it('the pattern loop resolver treats a declared length as absolute steps in 3/4', () => {
    const ch = mkChannel('abs', { steps: Array(16).fill(false) });
    // Declared 16 steps must loop at 16 — not silently migrated to 12 or 24.
    assert.equal(resolvePatternLoopLengthSteps([ch], 16, [3, 4]), 16);
    // A bar-aligned 3/4 length is accepted exactly.
    assert.equal(resolvePatternLoopLengthSteps([ch], 12, [3, 4]), 12);
    assert.equal(resolvePatternLoopLengthSteps([ch], 24, [3, 4]), 24);
    // 7/8 uses its 14-step bar, but still preserves explicit non-legacy lengths.
    assert.equal(resolvePatternLoopLengthSteps([ch], 14, [7, 8]), 14);
    assert.equal(resolvePatternLoopLengthSteps([ch], 16, [7, 8]), 16);
    // 4/4 keeps its existing whole-bar rounding.
    assert.equal(resolvePatternLoopLengthSteps([ch], 16, [4, 4]), 16);
    assert.equal(resolvePatternLoopLengthSteps([ch], 40, [4, 4]), 48);
  });
});

// ---------------------------------------------------------------------------
// Content extent in 3/4 with the Phase 1E onset-only rule intact
// ---------------------------------------------------------------------------
describe('Phase 1F — content extent uses the project bar size (Phase 1E rule intact)', () => {
  it('rounds channel content up to whole 3/4 bars (12 steps)', () => {
    const ch = mkChannel('ext', { steps: Array(13).fill(false) });
    assert.equal(resolvePlayableContentLengthSteps(ch, undefined, [3, 4]), 24);
    const ch12 = mkChannel('ext12', { steps: Array(12).fill(false) });
    assert.equal(resolvePlayableContentLengthSteps(ch12, undefined, [3, 4]), 12);
  });

  it('rounds channel content to the 14-step 7/8 bar without reinterpreting declared steps', () => {
    const ch14 = mkChannel('ext78', { steps: Array(14).fill(false) });
    assert.equal(resolvePlayableContentLengthSteps(ch14, undefined, [7, 8]), 14);
    const ch15 = mkChannel('ext78-plus-one', { steps: Array(15).fill(false) });
    assert.equal(resolvePlayableContentLengthSteps(ch15, undefined, [7, 8]), 28);
    assert.equal(resolvePlayableContentLengthSteps(ch14, 16, [7, 8]), 16);
  });

  it('note tails still do not expand the extent in 3/4', () => {
    const ch = mkChannel('tail', {
      steps: Array(12).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 11.75, duration: 4, velocity: 0.9 }],
    });
    // Onset at 11.75 with a long tail must not push the 12-step extent to 24.
    assert.equal(resolvePlayableContentLengthSteps(ch, undefined, [3, 4]), 12);
    const chZero = mkChannel('tail0', {
      steps: Array(12).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 0, duration: 64, velocity: 0.9 }],
    });
    assert.equal(resolvePlayableContentLengthSteps(chZero, undefined, [3, 4]), 12);
  });

  it('keeps the legacy 16-step behaviour when no meter is supplied', () => {
    const ch = mkChannel('legacy', {
      steps: Array(16).fill(false),
      notes: [{ id: 'n1', pitch: 60, start: 15.75, duration: 1, velocity: 0.9 }],
    });
    assert.equal(resolvePlayableContentLengthSteps(ch), 16);
    assert.equal(resolvePlayableContentLengthSteps(undefined), 16);
    assert.equal(LEGACY_TIME_SIGNATURE[0], 4);
    assert.equal(LEGACY_TIME_SIGNATURE[1], 4);
  });
});

// ---------------------------------------------------------------------------
// TEST J — recording timing is meter-aware
// ---------------------------------------------------------------------------
describe('Phase 1F TEST J — recording bar calculations use the project meter', () => {
  it('a 1.5 s take at 120 BPM in 3/4 is exactly 1 bar', () => {
    assert.equal(getRecordingLengthBars(1.5, 120, [3, 4]), 1);
  });

  it('a 1.75 s take at 120 BPM in 7/8 is exactly 1 bar', () => {
    assert.equal(getRecordingLengthBars(1.75, 120, [7, 8]), 1);
  });

  it('a 6.0 s take at 120 BPM is 3 bars in 3/4 but 4 bars in 4/4', () => {
    assert.equal(getRecordingLengthBars(6.0, 120, [3, 4]), 4);
    assert.equal(getRecordingLengthBars(6.0, 120, [4, 4]), 3);
  });

  it('missing meter keeps the legacy 4/4 behaviour', () => {
    assert.equal(getRecordingLengthBars(2.0, 120), 1);
    assert.equal(getRecordingLengthBars(6.0, 120), 3);
  });

  it('createRecordingPlaylistClip sizes the playlist clip from the project meter', () => {
    const project = createDefaultProjectState();
    const recording = {
      id: 'rec-1',
      name: 'Take 1',
      audioBlob: new Blob(['x']),
      audioUrl: '',
      durationSeconds: 6.0,
      createdAt: Date.now(),
    } as never;
    const buffer = { duration: 6.0 } as AudioBuffer;
    const clip34 = createRecordingPlaylistClip(
      recording,
      { id: 'recording-rec-1', buffer, peaks: [1], duration: 6.0 },
      project.playlistTracks,
      0,
      120,
      'rec-clip-1',
      [3, 4]
    );
    assert.equal(clip34.lengthBars, 4);
    const clip44 = createRecordingPlaylistClip(
      recording,
      { id: 'recording-rec-1', buffer, peaks: [1], duration: 6.0 },
      project.playlistTracks,
      0,
      120,
      'rec-clip-2',
      [4, 4]
    );
    assert.equal(clip44.lengthBars, 3);
  });
});

// ---------------------------------------------------------------------------
// TEST K / TEST L — MIDI export parity with the 3/4 runtime
// ---------------------------------------------------------------------------
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

interface DecodedEvent {
  tick: number;
  status: number;
  data: number[];
}

interface DecodedTrackInfo {
  notes: Array<{ tick: number; pitch: number; velocity: number }>;
  timeSignature: { numerator: number; denominator: number } | null;
  endTick: number;
}

/** Independent SMF reader (notes + time-signature meta), not shared with the writer. */
const decodeMidi = (bytes: Uint8Array): { ticksPerQuarter: number; tracks: DecodedTrackInfo[] } => {
  assert.equal(String.fromCharCode(...Array.from(bytes.slice(0, 4))), 'MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4);
  const trackCount = view.getUint16(10);
  const ticksPerQuarter = view.getUint16(12);
  const tracks: DecodedTrackInfo[] = [];
  let cursor = 8 + headerLength;
  for (let t = 0; t < trackCount; t += 1) {
    assert.equal(String.fromCharCode(...Array.from(bytes.slice(cursor, cursor + 4))), 'MTrk');
    const length = view.getUint32(cursor + 4);
    const end = cursor + 8 + length;
    let index = cursor + 8;
    let tick = 0;
    let runningStatus: number | null = null;
    const notes: Array<{ tick: number; pitch: number; velocity: number }> = [];
    let timeSignature: DecodedTrackInfo['timeSignature'] = null;
    const channelEvents: DecodedEvent[] = [];
    while (index < end) {
      const delta = readVlq(bytes, index);
      tick += delta.value;
      index = delta.next;
      let status = bytes[index];
      if (status < 0x80) {
        status = runningStatus as number;
      } else {
        index += 1;
        if (status < 0xf0) runningStatus = status;
      }
      if (status === 0xff) {
        const metaType = bytes[index];
        index += 1;
        const metaLength = readVlq(bytes, index);
        index = metaLength.next;
        if (metaType === 0x58 && metaLength.value >= 2) {
          timeSignature = { numerator: bytes[index], denominator: 2 ** bytes[index + 1] };
        }
        if (metaType === 0x2f) { index = end; break; }
        index += metaLength.value;
        continue;
      }
      const data = [bytes[index], bytes[index + 1]];
      index += 2;
      channelEvents.push({ tick, status, data });
      if ((status & 0xf0) === 0x90 && data[1] > 0) {
        notes.push({ tick, pitch: data[0], velocity: data[1] });
      }
    }
    tracks.push({ notes, timeSignature, endTick: tick });
    cursor = end;
  }
  return { ticksPerQuarter, tracks };
};

describe('Phase 1F TEST K/L — MIDI export agrees with the 3/4 runtime', () => {
  it('a clip at startBar 1 starts 12 steps (1440 ticks) after the origin in 3/4', () => {
    const ch = mkChannel('midi-34', { steps: [true, ...Array(11).fill(false)] });
    const clip = mkClip('midi-34', 1, 1);
    const blob = buildStandardMidiFile(
      [ch],
      [clip],
      { bpm: 120, timeSignature: [3, 4] },
      { scope: 'song' }
    );
    return blob.arrayBuffer().then(ab => {
      const decoded = decodeMidi(new Uint8Array(ab));
      assert.equal(decoded.ticksPerQuarter, 480);
      const track = decoded.tracks[0];
      // TEST L: header metadata and note layout must agree on the same meter.
      assert.deepEqual(track.timeSignature, { numerator: 3, denominator: 4 });
      // startBar 1 in 3/4 = 12 sixteenth steps = 12 * 120 ticks = 1440.
      assert.ok(track.notes.length > 0, 'expected note events');
      assert.equal(track.notes[0].tick, 1440, `first note at tick ${track.notes[0].tick}, expected 1440`);
      // Nothing may be laid out on the legacy 4/4 1920-tick bar grid.
      assert.ok(
        !track.notes.some(note => note.tick === 1920),
        'notes must not be placed on a 4/4 1920-tick bar in a 3/4 project'
      );
    });
  });

  it('a 3/4 pattern loop repeats every 1440 ticks (12 steps)', () => {
    const steps = Array(12).fill(false);
    steps[0] = true;
    const ch = mkChannel('midi-loop', { steps });
    const blob = buildStandardMidiFile(
      [ch],
      [],
      { bpm: 120, timeSignature: [3, 4] },
      { scope: 'pattern', patternLengthSteps: 12 }
    );
    return blob.arrayBuffer().then(ab => {
      const decoded = decodeMidi(new Uint8Array(ab));
      const ticks = decoded.tracks[0].notes.map(note => note.tick);
      assert.ok(ticks.length >= 3, `expected repeated notes, got ${ticks.length}`);
      assert.equal(ticks[0], 0);
      assert.equal(ticks[1], 1440, `second pass at tick ${ticks[1]}, expected 1440`);
      assert.equal(ticks[2], 2880, `third pass at tick ${ticks[2]}, expected 2880`);
    });
  });

  it('TEST M (MIDI regression): 4/4 exports keep the 1920-tick bar exactly', () => {
    const ch = mkChannel('midi-44', { steps: [true, ...Array(15).fill(false)] });
    const clip = mkClip('midi-44', 1, 1);
    const blob = buildStandardMidiFile(
      [ch],
      [clip],
      { bpm: 120, timeSignature: [4, 4] },
      { scope: 'song' }
    );
    return blob.arrayBuffer().then(ab => {
      const decoded = decodeMidi(new Uint8Array(ab));
      const track = decoded.tracks[0];
      assert.deepEqual(track.timeSignature, { numerator: 4, denominator: 4 });
      assert.equal(track.notes[0].tick, 1920);
    });
  });

  it('mechanical 6/8 keeps its existing 1,440-tick 12-step bar', () => {
    const ch = mkChannel('midi-68', { steps: [true, ...Array(11).fill(false)] });
    const clip = mkClip('midi-68', 1, 1);
    const blob = buildStandardMidiFile(
      [ch], [clip], { bpm: 120, timeSignature: [6, 8] }, { scope: 'song' }
    );
    return blob.arrayBuffer().then(ab => {
      const decoded = decodeMidi(new Uint8Array(ab));
      assert.equal(decoded.ticksPerQuarter, 480);
      assert.deepEqual(decoded.tracks[0].timeSignature, { numerator: 6, denominator: 8 });
      assert.equal(decoded.tracks[0].notes[0].tick, 1440);
    });
  });

  it('7/8 song bars export as 1,680 ticks at 480 PPQ', () => {
    const ch = mkChannel('midi-78', { steps: [true, ...Array(13).fill(false)] });
    const clips = [mkClip('midi-78', 1, 1), mkClip('midi-78', 2, 1)];
    const blob = buildStandardMidiFile(
      [ch],
      clips,
      { bpm: 120, timeSignature: [7, 8] },
      { scope: 'song' }
    );
    return blob.arrayBuffer().then(ab => {
      const decoded = decodeMidi(new Uint8Array(ab));
      const track = decoded.tracks[0];
      assert.equal(decoded.ticksPerQuarter, 480);
      assert.deepEqual(track.timeSignature, { numerator: 7, denominator: 8 });
      assert.deepEqual(track.notes.map(note => note.tick), [1680, 3360]);
      assert.ok(!track.notes.some(note => note.tick === 1920), '7/8 must not retain a 1,920-tick 4/4 bar');
    });
  });

  it('the pattern render window covers a legacy 16-step pattern in 3/4', () => {
    const ch = mkChannel('midi-window', { steps: [true, ...Array(15).fill(false)] });
    // A 16-step pattern in 3/4 needs 16 steps of window; one 12-step bar would
    // truncate it, so the window must grow to 2 bars.
    const bars = getProjectRenderBars([], 'pattern', 16, undefined, [3, 4]);
    assert.ok(bars * stepsPerBar([3, 4] as TimeSignature) >= 16, `window ${bars} bars is too small`);
    assert.ok(bars >= 4, 'the documented 4-bar minimum still applies');
    // A 60-step pattern needs 5 bars of 3/4; a legacy 4/4 window (4 bars of
    // 16 steps = 64 steps would pass, but 4 bars of 12 steps = 48 truncates).
    const longBars = getProjectRenderBars([], 'pattern', 60, undefined, [3, 4]);
    assert.ok(
      longBars * stepsPerBar([3, 4] as TimeSignature) >= 60,
      `window ${longBars} bars truncates a 60-step pattern in 3/4`
    );
    const blob = buildStandardMidiFile(
      [ch],
      [],
      { bpm: 120, timeSignature: [3, 4] },
      { scope: 'pattern', patternLengthSteps: 16 }
    );
    return blob.arrayBuffer().then(ab => {
      const decoded = decodeMidi(new Uint8Array(ab));
      const ticks = decoded.tracks[0].notes.map(note => note.tick);
      // The loop is the absolute 16 steps; step 16 of pass two = 16 * 120 ticks.
      assert.ok(ticks.includes(16 * 120), 'the 16-step loop must wrap at step 16');
      assert.ok(ticks.includes(16 * 120 + 1440 * 0) && ticks.includes(32 * 120), 'subsequent passes keep the absolute loop');
    });
  });
});

// ---------------------------------------------------------------------------
// Playlist bar<->step arithmetic under the project meter
// ---------------------------------------------------------------------------
describe('Phase 1F — playlist clip operations use the project bar size', () => {
  it('splitting a 3/4 clip advances offsetSteps by 12 steps per bar', () => {
    const ch = 'split-ch';
    const clip = mkClip(ch, 0, 2);
    const [left, right] = splitPlaylistClip(clip, 1, 0.25, {}, [3, 4]);
    assert.equal(left.lengthBars, 1);
    assert.equal(right.lengthBars, 1);
    assert.equal(right.offsetSteps, 12, `offsetSteps ${right.offsetSteps}, expected 12`);
  });

  it('splitting a 4/4 clip keeps the legacy 16 steps per bar', () => {
    const clip = mkClip('split-44', 0, 2);
    const [, right] = splitPlaylistClip(clip, 1, 0.25, {});
    assert.equal(right.offsetSteps, 16);
  });

  it('splitting a 7/8 clip advances offsetSteps by 14 steps per bar', () => {
    const clip = mkClip('split-78', 0, 2);
    const [, right] = splitPlaylistClip(clip, 1, 0.25, {}, [7, 8]);
    assert.equal(right.offsetSteps, 14);
  });

  it('left-resize credits offsetSteps at 12 steps per bar in 3/4', () => {
    const clip = mkClip('resize-34', 1, 1, { offsetSteps: 12 });
    // Extending left by one full bar must be allowed (12 steps of source exist).
    const resized = resizePlaylistClipLeft(clip, 0, 0.25, 0.25, {}, [3, 4]);
    assert.equal(resized.startBar, 0);
    assert.equal(resized.lengthBars, 2);
    assert.equal(resized.offsetSteps, 0);
    // …but not further than the source offset permits.
    const clipSmall = mkClip('resize-34b', 1, 1, { offsetSteps: 6 });
    const blocked = resizePlaylistClipLeft(clipSmall, 0, 0.25, 0.25, {}, [3, 4]);
    assert.ok(blocked.startBar >= 0.5, `startBar ${blocked.startBar} went past the source offset`);
  });
});

// ---------------------------------------------------------------------------
// Mutation guards (behavioural)
// ---------------------------------------------------------------------------
describe('Phase 1F mutation guards', () => {
  it('guard: missing timeSignature must resolve to 4/4 (never another value)', () => {
    const resolved = resolveProjectTimeSignature(undefined);
    assert.equal(resolved[0], 4);
    assert.equal(resolved[1], 4);
    assert.equal(stepsPerBar(resolved), 16);
  });

  it('guard: Pattern.lengthSteps stays absolute (no implicit meter-relative rewrite)', () => {
    // If someone turned declared lengths into meter-relative values, a stored 16
    // in a 3/4 project would resolve to 12 (or 24). It must stay 16.
    const ch = mkChannel('guard-abs', { steps: Array(16).fill(false) });
    assert.equal(resolvePatternLoopLengthSteps([ch], 16, [3, 4]), 16);
    assert.equal(normalizePatternLengthSteps(16), 16);
  });

  it('guard: the 3/4 runtime bar is 12 steps, not the legacy 16', () => {
    assert.equal(stepsPerBar(resolveProjectTimeSignature({ timeSignature: [3, 4] })), 12);
  });
});
