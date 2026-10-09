/**
 * Phase 1G — Timeline Capacity Expansion (runtime and export consumers).
 *
 * The 512-bar capacity lives in `src/state/playlistTimeline.ts`. The runtime
 * consumers of the timeline — offline render planning, the export window, MIDI
 * export — take the timeline length as an explicit argument and must not read
 * the capacity themselves. This suite pins two things:
 *
 *   1. Long arrangements survive the real persistence path and then render,
 *      export and report their length at the bar they were placed on. These
 *      assertions drive production functions on a document that went through
 *      `normalizeProjectState`, so they fail if the cap clamps the arrangement.
 *   2. The runtime is not coupled to the capacity constant. Playback, offline
 *      rendering, bounce, export, MIDI and metering keep their own arithmetic,
 *      and Phase 1F's meter behaviour is unchanged by the larger timeline.
 *
 * Browser-level 512-bar rendering is not exercised here (no browser in this
 * environment); see the implementation report for the coverage boundary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOfflineRenderPlan } from './offlineProjectRenderer';
import { buildStandardMidiFile, getProjectRenderBars } from '../utils/exportUtils';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';
import { setTimelineBarsInProjectState } from '../state/playlistTimeline';
import type { Channel, PlaylistClip, ProjectState } from '../types/daw';

const BPM = 120;
/** 4/4 at 120 BPM: 4 beats of 0.5 s per bar. */
const SECONDS_PER_BAR = 2;
/** 16 sixteenth steps per 4/4 bar at 480 PPQ: 120 ticks per step, 1920 per bar. */
const PPQ = 480;
const TICKS_PER_BAR = 1920;

const clip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-1',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  color: '#ff6e00',
  name: 'Track Block',
  channelId: 'lead',
  ...overrides,
});

const withBars = (totalBars: number, playlistClips: PlaylistClip[]): ProjectState => ({
  ...createDefaultProjectState(),
  totalBars,
  playlistClips,
});

/** The real save -> stored JSON -> load path used by persistence. */
const roundTrip = (state: ProjectState): ProjectState =>
  normalizeProjectState(JSON.parse(serializeProjectState(state)).state);

const mkChannel = (id: string, stepsOn: number[] = [0]): Channel => {
  const steps = Array(16).fill(false);
  for (const step of stepsOn) steps[step] = true;
  return {
    id,
    name: id,
    color: '#fff',
    instrumentType: 'minisynth' as Channel['instrumentType'],
    mixerTrackId: 1,
    volume: 1,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    synthParams: {} as Channel['synthParams'],
    notes: [],
  };
};

/** Decode the note-on ticks of a Standard MIDI File (format 0/1, one or more tracks). */
const noteOnTicks = async (blob: Blob): Promise<number[]> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ticks: number[] = [];
  let offset = 14; // skip MThd header (length 6)

  const readVlq = (): number => {
    let value = 0;
    for (;;) {
      const byte = bytes[offset++];
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
  };

  while (offset + 8 <= bytes.length) {
    const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4);
    offset += 8;
    const end = offset + length;
    if (tag === 'MTrk') {
      let tick = 0;
      let runningStatus = 0;
      while (offset < end) {
        tick += readVlq();
        let status = bytes[offset];
        if (status & 0x80) {
          offset++;
        } else {
          status = runningStatus;
        }
        if (status === 0xff) {
          const metaLength = (offset++, readVlq());
          offset += metaLength;
          continue;
        }
        if (status === 0xf0 || status === 0xf7) {
          const sysexLength = readVlq();
          offset += sysexLength;
          continue;
        }
        runningStatus = status;
        const kind = status & 0xf0;
        const dataBytes = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        if (kind === 0x90 && bytes[offset + 1] > 0) ticks.push(tick);
        offset += dataBytes;
      }
    }
    offset = end;
  }
  return ticks;
};

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

const walkRuntimeSource = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkRuntimeSource(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
};

describe('Phase 1G — offline render planning at long timeline lengths', () => {
  it('(anchor) a clip at bar 100 is placed at 200 s on a 512-bar window', () => {
    const plan = getOfflineRenderPlan([clip({ id: 'bar100', startBar: 100, lengthBars: 4 })], BPM, 512);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].startSeconds, 100 * SECONDS_PER_BAR);
    assert.equal(plan[0].durationSeconds, 4 * SECONDS_PER_BAR);
  });

  it('(anchor) the render window still truncates a clip that crosses the declared end', () => {
    const plan = getOfflineRenderPlan([clip({ id: 'tail', startBar: 510, lengthBars: 4 })], BPM, 512);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].startSeconds, 510 * SECONDS_PER_BAR);
    assert.equal(plan[0].durationSeconds, 2 * SECONDS_PER_BAR, 'only the two bars inside the 512-bar window render');
  });

  it('(anchor) clips beyond the declared window are excluded, regardless of capacity', () => {
    const plan = getOfflineRenderPlan([clip({ id: 'late', startBar: 130, lengthBars: 4 })], BPM, 128);
    assert.equal(plan.length, 0);
  });

  it('(RED) a persisted 128-bar project renders its bar-100 clip at 200 s, not at the old cap', () => {
    const restored = roundTrip(withBars(128, [clip({ id: 'bar100', startBar: 100, lengthBars: 4 })]));
    const plan = getOfflineRenderPlan(restored.playlistClips, BPM, restored.totalBars);

    assert.equal(restored.totalBars, 128);
    assert.equal(plan.length, 1, 'the bar-100 clip must survive the persistence path');
    assert.equal(plan[0].startSeconds, 100 * SECONDS_PER_BAR);
  });

  it('(RED) a persisted 512-bar project renders a clip on its final bar at 1016 s', () => {
    const restored = roundTrip(withBars(512, [clip({ id: 'last', startBar: 508, lengthBars: 4 })]));
    const plan = getOfflineRenderPlan(restored.playlistClips, BPM, restored.totalBars);

    assert.equal(plan.length, 1);
    assert.equal(plan[0].startSeconds, 508 * SECONDS_PER_BAR);
    assert.equal(plan[0].durationSeconds, 4 * SECONDS_PER_BAR);
  });

  it('(RED) shrinking 512 -> 128 keeps a bar-400 clip rendering inside the new window', () => {
    const initial = withBars(512, [clip({ id: 'far', startBar: 400, lengthBars: 4 })]);
    const shrunk = setTimelineBarsInProjectState(initial, 128);
    const plan = getOfflineRenderPlan(shrunk.playlistClips, BPM, shrunk.totalBars);

    assert.equal(plan.length, 1, 'the relocated clip must still render');
    assert.equal(plan[0].startSeconds, 124 * SECONDS_PER_BAR, 'it renders at its relocated bar 124');
    assert.ok(plan[0].startSeconds + plan[0].durationSeconds <= shrunk.totalBars * SECONDS_PER_BAR);
  });
});

describe('Phase 1G — export window and length at long timeline lengths', () => {
  it('(anchor) a song export ends at the last clip when the arrangement is shorter than the timeline', () => {
    const clips = [clip({ id: 'a', startBar: 100, lengthBars: 4 })];
    assert.equal(getProjectRenderBars(clips, 'song', undefined, 512), 104);
  });

  it('(anchor) a song export never exceeds the timeline it is handed', () => {
    const clips = [clip({ id: 'a', startBar: 100, lengthBars: 4 })];
    assert.equal(getProjectRenderBars(clips, 'song', undefined, 64), 64);
  });

  it('(RED) a persisted 128-bar project exports through its bar-100 clip (104 bars)', () => {
    const restored = roundTrip(withBars(128, [clip({ id: 'bar100', startBar: 100, lengthBars: 4 })]));
    assert.equal(getProjectRenderBars(restored.playlistClips, 'song', undefined, restored.totalBars), 104);
  });

  it('(anchor) a pattern export window is independent of the timeline length', () => {
    const clips = [clip({ id: 'a', startBar: 100, lengthBars: 4 })];
    assert.equal(
      getProjectRenderBars(clips, 'pattern', 16, 512),
      getProjectRenderBars(clips, 'pattern', 16, 64),
    );
    assert.equal(getProjectRenderBars(clips, 'pattern', 16, 512), 4);
  });
});

describe('Phase 1G — MIDI export at long timeline lengths', () => {
  it('(anchor) a legacy 64-bar project writes its bar-60 note at tick 60 bars', async () => {
    const channels = [mkChannel('lead')];
    const clips = [clip({ id: 'legacy', startBar: 60, lengthBars: 1 })];
    const blob = buildStandardMidiFile(channels, clips, { bpm: BPM, timeSignature: [4, 4] }, {
      scope: 'song',
      totalBars: 64,
    });
    assert.deepEqual(await noteOnTicks(blob), [60 * TICKS_PER_BAR]);
  });

  it('(RED) a persisted 512-bar project writes a bar-400 note at tick 400 bars', async () => {
    const restored = roundTrip(withBars(512, [clip({ id: 'far', startBar: 400, lengthBars: 1 })]));
    const blob = buildStandardMidiFile([mkChannel('lead')], restored.playlistClips, { bpm: BPM, timeSignature: [4, 4] }, {
      scope: 'song',
      totalBars: restored.totalBars,
    });
    assert.deepEqual(await noteOnTicks(blob), [400 * TICKS_PER_BAR]);
  });

  it('(RED) a persisted 512-bar project writes a note on its final bar at tick 508 bars', async () => {
    const restored = roundTrip(withBars(512, [clip({ id: 'last', startBar: 508, lengthBars: 1 })]));
    const blob = buildStandardMidiFile([mkChannel('lead')], restored.playlistClips, { bpm: BPM, timeSignature: [4, 4] }, {
      scope: 'song',
      totalBars: restored.totalBars,
    });
    assert.deepEqual(await noteOnTicks(blob), [508 * TICKS_PER_BAR]);
  });
});

describe('Phase 1G — runtime is not coupled to the capacity constant', () => {
  it('(anchor) no runtime audio, export, music or metering module reads the timeline capacity', () => {
    const runtimeDirs = [path.join(SRC_ROOT, 'audio'), path.join(SRC_ROOT, 'music')];
    const runtimeFiles = [
      ...runtimeDirs.flatMap(walkRuntimeSource),
      path.join(SRC_ROOT, 'utils', 'exportUtils.ts'),
    ];

    const offenders = runtimeFiles
      .filter(file => {
        const source = readFileSync(file, 'utf8');
        return /MAX_TIMELINE_BARS|state\/playlistTimeline|from '\.\.\/state\/playlistTimeline'/.test(source);
      })
      .map(file => path.relative(SRC_ROOT, file).replace(/\\/g, '/'));

    assert.deepEqual(offenders, [], 'runtime modules must take the timeline length as an argument');
  });

  it('(anchor) the offline render plan is pure in its declared window, not in the capacity', () => {
    const clips = [clip({ id: 'a', startBar: 100, lengthBars: 4 })];
    assert.deepEqual(
      getOfflineRenderPlan(clips, BPM, 512),
      getOfflineRenderPlan(clips, BPM, 512),
    );
  });
});
