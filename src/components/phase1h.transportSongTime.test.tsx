import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TransportBar, type TransportBarProps } from './TransportBar';
import type { ProjectMetadata } from '../types/daw';

/**
 * Phase 1H — TransportBar song-time readout correctness.
 *
 * The Time cell (label "Time", title "Song time") must show the wall-clock
 * song position of the displayed bar.beat.step:
 *
 *   positionBeats = (currentBar - 1) * beatsPerBar(resolvedMeter)
 *                   + currentStep / SIXTEENTH_STEPS_PER_BEAT
 *   readout       = MM:SS:CC of positionBeats * 60 / bpm
 *
 * Defect being fixed (still present at the Phase 1G baseline): the audited
 * formula divided the beat position by 4, so the readout ran at 1/4 of real
 * time (at 120 BPM, bar 2 step 0 displayed 00:00 instead of 00:02, and bar 5
 * step 0 displayed 00:02 instead of 00:08). The same line also read the
 * 16th-note subdivision (currentStep % 4) as the beat-within-bar, assumed a
 * fixed 4-beat bar, and rendered a BPM-independent tick count
 * ((currentStep % 16) * 6) in the centisecond field.
 *
 * Evidence trail: PHASE_1F_IMPLEMENTATION_REPORT.md lists the `totalSeconds`
 * `/4` as remaining known issue #1 (P1, separate hotfix — deliberately not
 * bundled into Phase 1F); docs/PHASE1A_TIMING_FOUNDATION.md lists the
 * `%4` / `%16` / frame-like `*6` transport display indexing as known-defective
 * arithmetic that Phase 1A deliberately left unchanged.
 *
 * Input semantics (pinned by src/audio/transport.ts): currentStep is the
 * 0-based sixteenth-note step within the loop/bar and currentBar is the
 * 1-based meter bar. These tests are behavioural — they render the real
 * component and read the rendered Time cell — so they fail on the defective
 * formula and pass on the corrected one.
 */

const baseMeta: ProjectMetadata = {
  id: 'proj-1h',
  name: 'Phase 1H Fixture',
  author: 'Test',
  bpm: 120,
  timeSignature: [4, 4],
  swing: 0,
  masterVolume: 1,
  masterPitch: 0,
  created: 0,
  updated: 0,
  version: 'test',
  offlineReady: true,
  totalEditTimeSeconds: 0,
};

const baseProps: TransportBarProps = {
  currentView: 'channel_rack',
  onSelectView: () => {},
  isPlaying: false,
  onTogglePlay: () => {},
  onStop: () => {},
  playMode: 'pat',
  onTogglePlayMode: () => {},
  isRecording: false,
  onToggleRecord: () => {},
  meta: baseMeta,
  onUpdateMeta: () => {},
  currentStep: 0,
  currentBar: 1,
  metronome: false,
  onToggleMetronome: () => {},
  onOpenExport: () => {},
  onOpenProjectManager: () => {},
  onOpenCollab: () => {},
  onOpenAnalytics: () => {},
  onOpenHotkeys: () => {},
  onOpenMidi: () => {},
  onOpenGrossBeat: () => {},
  onOpenSlicer: () => {},
  onOpenVocalTuner: () => {},
  onOpenMidiLearn: () => {},
  onOpenMultiZoneSampler: () => {},
  onOpenWavetableSynth: () => {},
  onOpenTakeComping: () => {},
  onOpenSidechain: () => {},
  onOpenPolyphonicEditor: () => {},
  onOpenDesktopApp: () => {},
  onOpenWarpProcessor: () => {},
  onOpenMasterMacros: () => {},
  onOpenProjectZipBundle: () => {},
  onOpenParametricEq: () => {},
  onOpenMasteringSuite: () => {},
  onOpenSampleManager: () => {},
  collaboratorCount: 0,
  isSidebarOpen: true,
  onToggleSidebar: () => {},
};

const renderTransport = (overrides: Partial<TransportBarProps> = {}): string =>
  renderToStaticMarkup(React.createElement(TransportBar, { ...baseProps, ...overrides }));

const readoutField = (overrides: Partial<TransportBarProps>, title: string): string => {
  const html = renderTransport(overrides);
  const match = html.match(new RegExp(`title="${title}">([^<]*)<`));
  assert.ok(match, `expected the "${title}" readout to render`);
  return match[1];
};

/** Renders the Time cell (song time, MM:SS:CC) for the given position. */
const songTimeOf = (overrides: Partial<TransportBarProps> = {}): string =>
  readoutField(overrides, 'Song time');

/** Renders the Bar cell (bar.beat.step) for the given position. */
const barPositionOf = (overrides: Partial<TransportBarProps> = {}): string =>
  readoutField(overrides, 'Bar . beat . step');

const metaWith = (partial: Partial<ProjectMetadata>): ProjectMetadata => ({
  ...baseMeta,
  ...partial,
});

// ---------------------------------------------------------------------------
// TEST A — 4/4 at 120 BPM: the readout is the true song position
// ---------------------------------------------------------------------------

test('TEST A: 4/4 at 120 BPM — the Time cell shows the true song position (the /4 defect ran at 1/4 speed)', () => {
  const cases: Array<[bar: number, step: number, expected: string]> = [
    [1, 0, '00:00:00'],
    [1, 4, '00:00:50'], // beat 2 = 0.5 s
    [1, 8, '00:01:00'], // beat 3 = 1.0 s
    [1, 12, '00:01:50'], // beat 4 = 1.5 s
    [2, 0, '00:02:00'], // one 4/4 bar = 4 beats = 2.0 s (defect displayed 00:00)
    [3, 12, '00:05:50'], // 2 bars + 3 beats = 11 beats = 5.5 s (defect displayed 00:01)
    [5, 0, '00:08:00'], // 16 beats = 8.0 s (defect displayed 00:02)
  ];
  for (const [bar, step, expected] of cases) {
    assert.equal(
      songTimeOf({ currentBar: bar, currentStep: step }),
      expected,
      `bar ${bar} step ${step}`,
    );
  }
});

// ---------------------------------------------------------------------------
// TEST B — the readout scales with the project tempo
// ---------------------------------------------------------------------------

test('TEST B: the song time scales with the project BPM', () => {
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 0, meta: metaWith({ bpm: 60 }) }), '00:04:00');
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 0, meta: metaWith({ bpm: 240 }) }), '00:01:00');
  assert.equal(songTimeOf({ currentBar: 1, currentStep: 4, meta: metaWith({ bpm: 60 }) }), '00:01:00');
});

// ---------------------------------------------------------------------------
// TEST C — the third field is centiseconds of the song position
// ---------------------------------------------------------------------------

test('TEST C: the third field is the centisecond part of the song position', () => {
  assert.equal(songTimeOf({ currentBar: 1, currentStep: 1 }), '00:00:12'); // 0.125 s
  assert.equal(songTimeOf({ currentBar: 1, currentStep: 2 }), '00:00:25'); // 0.25 s
  assert.equal(songTimeOf({ currentBar: 1, currentStep: 6 }), '00:00:75'); // 0.75 s
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 1 }), '00:02:12'); // 2.125 s
});

// ---------------------------------------------------------------------------
// TEST D — meter-aware: 3/4 projects read out in 3-beat bars
// ---------------------------------------------------------------------------

test('TEST D: 3/4 at 120 BPM — the song time uses 3-beat bars (Phase 1F meter wiring)', () => {
  const meta34 = metaWith({ timeSignature: [3, 4] });
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 0, meta: meta34 }), '00:01:50'); // 3 beats = 1.5 s
  assert.equal(songTimeOf({ currentBar: 3, currentStep: 0, meta: meta34 }), '00:03:00'); // 6 beats = 3.0 s
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 4, meta: meta34 }), '00:02:00'); // 4 beats = 2.0 s
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 8, meta: meta34 }), '00:02:50'); // 5 beats = 2.5 s
});

// ---------------------------------------------------------------------------
// TEST E — 7/8 song time uses its 3.5 quarter-note beats per bar
// ---------------------------------------------------------------------------

test('TEST E: 7/8 at 120 BPM — the song-time cell advances by 1.75 seconds per bar', () => {
  const meta78 = metaWith({ timeSignature: [7, 8] });
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 0, meta: meta78 }), '00:01:75');
  assert.equal(songTimeOf({ currentBar: 2, currentStep: 12, meta: meta78 }), '00:03:25');
});

// ---------------------------------------------------------------------------
// TEST F — the readout is monotonic across a bar (the %4 defect oscillated)
// ---------------------------------------------------------------------------

test('TEST F: the song time never runs backwards inside a bar and advances one beat per beat', () => {
  let previousTotalCentiseconds = -1;
  for (let step = 0; step < 16; step += 1) {
    const [minutes, seconds, centiseconds] = songTimeOf({ currentBar: 1, currentStep: step })
      .split(':')
      .map(Number);
    const totalCentiseconds = (minutes * 60 + seconds) * 100 + centiseconds;
    assert.ok(
      totalCentiseconds >= previousTotalCentiseconds,
      `step ${step} ran backwards (${totalCentiseconds} < ${previousTotalCentiseconds})`,
    );
    previousTotalCentiseconds = totalCentiseconds;
  }
  // Beat boundaries at 120 BPM are 0.5 s apart.
  assert.equal(songTimeOf({ currentBar: 1, currentStep: 4 }), '00:00:50');
  assert.equal(songTimeOf({ currentBar: 1, currentStep: 8 }), '00:01:00');
  assert.equal(songTimeOf({ currentBar: 1, currentStep: 12 }), '00:01:50');
});

// ---------------------------------------------------------------------------
// TEST G — isolation: the bar.beat.step position cell is unchanged
// ---------------------------------------------------------------------------

test('TEST G: the Bar position cell keeps its existing 4/4 and 3/4 behavior', () => {
  assert.equal(barPositionOf({ currentBar: 2, currentStep: 5 }), '02.2.2');
  assert.equal(
    barPositionOf({ currentBar: 2, currentStep: 4, meta: metaWith({ timeSignature: [3, 4] }) }),
    '02.2.1',
  );
});

test('Phase 1I: 7/8 displays seven eighth-note beats with two sixteenth subdivisions each', () => {
  const meta78 = metaWith({ timeSignature: [7, 8] });
  const expected = [
    '01.1.1', '01.1.2',
    '01.2.1', '01.2.2',
    '01.3.1', '01.3.2',
    '01.4.1', '01.4.2',
    '01.5.1', '01.5.2',
    '01.6.1', '01.6.2',
    '01.7.1', '01.7.2',
  ];
  expected.forEach((position, currentStep) => {
    assert.equal(
      barPositionOf({ currentBar: 1, currentStep, meta: meta78 }),
      position,
      `7/8 step ${currentStep}`,
    );
  });
  assert.equal(barPositionOf({ currentBar: 2, currentStep: 0, meta: meta78 }), '02.1.1');
  assert.equal(barPositionOf({ currentBar: 1, currentStep: 14, meta: meta78 }), '01.1.1');
  assert.equal(barPositionOf({ currentBar: 1, currentStep: 15, meta: meta78 }), '01.1.2');
});

test('Phase 1I: mechanical 6/8 keeps its existing three quarter-note-beat display', () => {
  const meta68 = metaWith({ timeSignature: [6, 8] });
  assert.equal(barPositionOf({ currentBar: 1, currentStep: 0, meta: meta68 }), '01.1.1');
  assert.equal(barPositionOf({ currentBar: 1, currentStep: 3, meta: meta68 }), '01.1.4');
  assert.equal(barPositionOf({ currentBar: 1, currentStep: 4, meta: meta68 }), '01.2.1');
  assert.equal(barPositionOf({ currentBar: 1, currentStep: 8, meta: meta68 }), '01.3.1');
  assert.equal(barPositionOf({ currentBar: 1, currentStep: 11, meta: meta68 }), '01.3.4');
  assert.equal(barPositionOf({ currentBar: 2, currentStep: 0, meta: meta68 }), '02.1.1');
});
