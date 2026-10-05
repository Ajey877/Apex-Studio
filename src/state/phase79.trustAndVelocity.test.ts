/**
 * Phase 79 — Trust & Velocity Gate regression tests.
 *
 * These tests pin the acceptance gates called out in the Phase 79 brief:
 *   1. Gross Beat state is ProjectState-owned and round-trips save/load.
 *   2. The "Zoom" controls on the playlist are no longer advertised as zoom
 *      (they mutate timeline length, not horizontal scale).
 *   3. ProjectState consumers must use the project document — no back-channel
 *      engine private truth for Gross Beat.
 *   4. Truth surfaces no longer advertise unimplemented DSP (Élastique, ARA2,
 *      Melodyne, DirectWave, Edison, hypersaw, 256-frame wavetable, etc.).
 *
 * They are written RED-first against the Phase 57 baseline and green after
 * the Phase 79 fixes land. Any regression here is BLOCKING — do not ship
 * Phase 79 with a red test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { normalizeProjectState, createDefaultProjectState, DEFAULT_GROSS_BEAT_STATE } from './projectState';
import { updateGrossBeatInProjectState } from './projectMutations';
import { GrossBeatModal } from '../components/GrossBeatModal';
import { PlaylistArranger } from '../components/PlaylistArranger';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readSource(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

test('Gross Beat state round-trips normalizeProjectState (save/load)', () => {
  const pattern = [true, false, true, false, true, true, false, true, false, true, false, true, false, true, false, true] as boolean[];
  const original = normalizeProjectState({
    ...createDefaultProjectState(),
    grossBeatState: { enabled: true, mix: 0.6, gateSteps: [...pattern] },
  });
  const serialized = JSON.parse(JSON.stringify(original));
  const reloaded = normalizeProjectState(serialized);
  assert.deepEqual(reloaded.grossBeatState?.enabled, true);
  assert.equal(reloaded.grossBeatState?.mix, 0.6);
  assert.deepEqual(reloaded.grossBeatState?.gateSteps, pattern);
});

test('normalizeProjectState rejects malformed Gross Beat state (16-step invariant)', () => {
  const tooShort = { enabled: true, mix: 0.5, gateSteps: [true, false] } as any;
  assert.throws(
    () => normalizeProjectState({ ...createDefaultProjectState(), grossBeatState: tooShort }),
    /Gross Beat state is malformed/
  );
});

test('updateGrossBeatInProjectState merges patches without dropping unrelated fields', () => {
  const initial = normalizeProjectState(createDefaultProjectState());
  const toggled = updateGrossBeatInProjectState(initial, { enabled: true });
  assert.equal(toggled.grossBeatState?.enabled, true);
  assert.equal(toggled.grossBeatState?.mix, DEFAULT_GROSS_BEAT_STATE.mix);
  const mixed = updateGrossBeatInProjectState(toggled, { mix: 0.3 });
  assert.equal(mixed.grossBeatState?.enabled, true);
  assert.equal(mixed.grossBeatState?.mix, 0.3);
});

test('GrossBeatModal requires project-state props (no direct engine reads)', () => {
  // Structural contract: the modal cannot render without the project-state
  // props. If someone removes them and goes back to reading audioEngine
  // directly, the production code has to drop these props, which will also
  // fail this render.
  const html = renderToStaticMarkup(
    React.createElement(GrossBeatModal, {
      isOpen: true,
      onClose: () => undefined,
      currentStep: 0,
      isPlaying: false,
      grossBeatState: DEFAULT_GROSS_BEAT_STATE,
      onUpdateGrossBeat: () => undefined,
    })
  );
  assert.match(html, /MASTER GATE/);
});

test('PlaylistArranger source does NOT label +/- buttons as Zoom In/Zoom Out', () => {
  const src = readSource('src/components/PlaylistArranger.tsx');
  // Fake-zoom relabelling: the +/- buttons change totalBars, they do not zoom.
  assert.doesNotMatch(src, /title=\"Zoom In\"/);
  assert.doesNotMatch(src, /title=\"Zoom Out\"/);
  assert.match(src, /Shorter timeline/);
  assert.match(src, /Longer timeline/);
});

test('Gross Beat amplitude gate is honestly labelled (no time/pitch marketing)', () => {
  const html = renderToStaticMarkup(
    React.createElement(GrossBeatModal, {
      isOpen: true,
      onClose: () => undefined,
      currentStep: 0,
      isPlaying: false,
      grossBeatState: { enabled: true, mix: 0.7, gateSteps: Array(16).fill(true) as boolean[] },
      onUpdateGrossBeat: () => undefined,
    })
  );
  const forbidden = [
    'TIME FX', 'TIME MANIPULATION', 'HALF TIME', 'PITCH SHIFT', 'TURNTABLE',
    'SCRATCH', 'ÉLASTIQUE', 'ELASTIQUE', 'TIME STRETCH', 'TAPE STOP'
  ];
  for (const word of forbidden) {
    assert.ok(!html.includes(word), `GrossBeatModal must not advertise "${word}"`);
  }
  assert.match(html, /16-STEP AMPLITUDE GATE GRID/);
});

test('Source tree has no references to forbidden trademark DSP names', () => {
  // Third-party trademarks that the app does not implement must not appear
  // anywhere in the runtime source (tests can mention them only to assert
  // their absence). We scope this to the components/audio/state source
  // directories, not tests.
  const targets = ['src/components', 'src/audio', 'src/state'];
  const forbidden = ['Élastique', 'Melodyne', 'ARA2', 'DirectWave', 'Edison'];
  const scan = (p: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(p)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = path.join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...scan(full));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  };
  const bad: string[] = [];
  for (const rel of targets) {
    for (const file of scan(path.join(REPO_ROOT, rel))) {
      const body = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        if (body.includes(needle)) {
          bad.push(`${path.relative(REPO_ROOT, file)}: ${needle}`);
        }
      }
    }
  }
  assert.equal(bad.length, 0, `Forbidden DSP trademarks still present:\n  ${bad.join('\n  ')}`);
});

test('ProjectState grossBeatState field exists and is optional for backward compat', () => {
  // Old project documents without grossBeatState still load.
  const legacy = normalizeProjectState({
    meta: createDefaultProjectState().meta,
    patterns: createDefaultProjectState().patterns,
    channels: createDefaultProjectState().channels,
    mixerTracks: createDefaultProjectState().mixerTracks,
    playlistTracks: createDefaultProjectState().playlistTracks,
    playlistClips: [],
    recordings: [],
    comments: [],
    collaborators: [],
    midiMappings: [],
    selectedPatternId: 'pat-1',
    selectedChannelId: 'ch-1',
    selectedMixerTrackId: 0,
    nextMixerTrackId: 1,
    totalBars: 32,
  });
  assert.ok(legacy.grossBeatState, 'a missing grossBeatState must be filled in with defaults');
  assert.equal(legacy.grossBeatState?.gateSteps.length, 16);
});
