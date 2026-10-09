/**
 * Phase 1J — Project Settings time-signature selector, the always-visible
 * meter readout and the meter-aware playlist ruler divisions.
 *
 * The tsx suite has no DOM, so selector behaviour is exercised through the
 * exact pure handlers the dialog's radio inputs call, and rendering through
 * renderToStaticMarkup of the real components.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProjectSettingsModal,
  selectProjectTimeSignature,
  selectSevenEightGrouping,
  type ProjectSettingsModalProps,
} from './ProjectSettingsModal';
import { PlaylistRulerTicks } from './PlaylistRulerTicks';
import { TransportBar, type TransportBarProps } from './TransportBar';
import type { ProjectMetadata } from '../types/daw';

const render = (overrides: Partial<ProjectSettingsModalProps> = {}) =>
  renderToStaticMarkup(
    <ProjectSettingsModal
      isOpen
      timeSignature={[4, 4]}
      sevenEightGrouping={undefined}
      onSelectTimeSignature={() => undefined}
      onSelectSevenEightGrouping={() => undefined}
      onClose={() => undefined}
      {...overrides}
    />,
  );

const checkedValue = (html: string, name: string): string[] =>
  [...html.matchAll(/<input[^>]*>/g)]
    .map(m => m[0])
    .filter(tag => tag.includes(`name="${name}"`) && tag.includes('checked=""'))
    .map(tag => /value="([^"]+)"/.exec(tag)![1]);

test('selector: choosing a supported meter calls the handler once with a [n, d] tuple', () => {
  const calls: Array<[number, number]> = [];
  const outcome = selectProjectTimeSignature('7/8', [4, 4], { onSelectTimeSignature: m => calls.push(m) });
  assert.deepEqual(outcome, { status: 'applied', label: '7/8' });
  assert.deepEqual(calls, [[7, 8]]);
});

test('selector: choosing the active meter is a no-op', () => {
  const calls: unknown[] = [];
  const outcome = selectProjectTimeSignature('3/4', [3, 4], { onSelectTimeSignature: m => calls.push(m) });
  assert.equal(outcome.status, 'unchanged');
  assert.equal(calls.length, 0);
});

test('selector: unsupported values are rejected with a message and never reach the project', () => {
  for (const bad of ['5/4', '7/4', '9/8', '', 'abc', undefined]) {
    const calls: unknown[] = [];
    const outcome = selectProjectTimeSignature(bad, [4, 4], { onSelectTimeSignature: m => calls.push(m) });
    assert.equal(outcome.status, 'rejected', `${String(bad)} must be rejected`);
    assert.match((outcome as { message: string }).message, /4\/4, 3\/4, 6\/8 or 7\/8/);
    assert.equal(calls.length, 0);
  }
});

test('selector: 7/8 grouping applies only valid groupings, and the default counts as active', () => {
  const calls: string[] = [];
  const handlers = { onSelectSevenEightGrouping: (g: string) => calls.push(g) };
  assert.equal(selectSevenEightGrouping('3+2+2', undefined, handlers).status, 'applied');
  assert.equal(selectSevenEightGrouping('2+2+3', undefined, handlers).status, 'unchanged');
  assert.equal(selectSevenEightGrouping('4+3', '2+2+3', handlers).status, 'rejected');
  assert.deepEqual(calls, ['3+2+2']);
});

test('dialog: exposes exactly the four supported meters and marks the active one', () => {
  const html = render({ timeSignature: [6, 8] });
  assert.match(html, /role="dialog"/);
  assert.match(html, /role="radiogroup" aria-label="Time signature"/);
  const values = [...html.matchAll(/<input[^>]*>/g)]
    .map(m => m[0])
    .filter(tag => tag.includes('name="project-time-signature"'))
    .map(tag => /value="([^"]+)"/.exec(tag)![1]);
  assert.deepEqual(values, ['4/4', '3/4', '6/8', '7/8']);
  assert.deepEqual(checkedValue(html, 'project-time-signature'), ['6/8']);
  assert.match(html, /id="project-settings-active-meter"[^>]*data-active-meter="6\/8"[^>]*>6\/8</);
  assert.ok(html.includes('aria-label="Close Project Settings"'));
});

test('dialog: the 7/8 grouping control appears only in 7/8 and shows the stored grouping', () => {
  assert.equal(render({ timeSignature: [4, 4] }).includes('7/8 accent grouping'), false);
  const html = render({ timeSignature: [7, 8], sevenEightGrouping: '3+2+2' });
  assert.ok(html.includes('7/8 accent grouping'));
  assert.deepEqual(checkedValue(html, 'project-seven-eight-grouping'), ['3+2+2']);
  // Active pulse preview: 3+2+2 → downbeat, pulse, pulse, accent, pulse, accent, pulse.
  const active = html.slice(html.indexOf('data-testid="project-settings-active-pulses"'));
  const levels = [...active.slice(0, active.indexOf('</span></div>')).matchAll(/data-pulse-level="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(levels, ['downbeat', 'pulse', 'pulse', 'accent', 'pulse', 'accent', 'pulse']);
  // Legacy project (no grouping) shows the 2+2+3 default as selected.
  assert.deepEqual(checkedValue(render({ timeSignature: [7, 8] }), 'project-seven-eight-grouping'), ['2+2+3']);
});

test('dialog: an unsupported stored meter is reported honestly and no radio claims it', () => {
  const html = render({ timeSignature: [5, 4] });
  assert.ok(html.includes('unsupported time signature (5/4)'));
  assert.ok(html.includes('plays as 4/4'));
  assert.deepEqual(checkedValue(html, 'project-time-signature'), []);
});

test('dialog: states the bar-anchored clip policy', () => {
  assert.ok(render().includes('Clips keep their bar positions'));
});

// --- TransportBar meter readout --------------------------------------------
const meta = (timeSignature: [number, number]): ProjectMetadata => ({
  id: 'p', name: 'Fixture', author: 'T', bpm: 120, timeSignature, swing: 0, masterVolume: 1, masterPitch: 0,
  created: 0, updated: 0, version: 't', offlineReady: true, totalEditTimeSeconds: 0,
});
const transportProps = (m: ProjectMetadata, extra: Partial<TransportBarProps> = {}): TransportBarProps => ({
  currentView: 'channel_rack', onSelectView: () => {}, isPlaying: false, onTogglePlay: () => {}, onStop: () => {},
  playMode: 'pat', onTogglePlayMode: () => {}, isRecording: false, onToggleRecord: () => {}, meta: m,
  onUpdateMeta: () => {}, currentStep: 0, currentBar: 1, metronome: false, onToggleMetronome: () => {},
  onOpenExport: () => {}, onOpenProjectManager: () => {}, onOpenCollab: () => {}, onOpenAnalytics: () => {},
  onOpenHotkeys: () => {}, onOpenMidi: () => {}, collaboratorCount: 0, isSidebarOpen: true, onToggleSidebar: () => {},
  ...extra,
});

test('transport: the active meter is always displayed and opens Project Settings', () => {
  for (const ts of [[4, 4], [3, 4], [6, 8], [7, 8]] as Array<[number, number]>) {
    const html = renderToStaticMarkup(<TransportBar {...transportProps(meta(ts), { onOpenProjectSettings: () => {} })} />);
    const label = `${ts[0]}/${ts[1]}`;
    assert.match(html, new RegExp(`id="fl-meter-readout"[^>]*data-meter="${label}"`));
    assert.ok(html.includes(`aria-label="Time signature ${label}. Open Project Settings."`));
  }
  // An unsupported stored meter displays the meter that actually plays.
  const odd = renderToStaticMarkup(<TransportBar {...transportProps(meta([5, 4]))} />);
  assert.match(odd, /data-meter="4\/4"/);
});

// --- ruler -------------------------------------------------------------------
const rulerTicks = (meter: [number, number], grouping: '2+2+3' | '3+2+2' | '2+3+2' = '2+2+3') => {
  const html = renderToStaticMarkup(<PlaylistRulerTicks meter={meter} grouping={grouping} />);
  return {
    html,
    levels: [...html.matchAll(/data-ruler-tick="(\w+)"/g)].map(m => m[1]),
    lefts: [...html.matchAll(/left:([\d.]+)%/g)].map(m => Number(m[1])),
  };
};

test('ruler: bar divisions follow the active meter', () => {
  assert.deepEqual(rulerTicks([4, 4]).lefts, [25, 50, 75]);
  assert.deepEqual(rulerTicks([3, 4]).lefts.map(Math.round), [33, 67]);
  const six = rulerTicks([6, 8]);
  assert.equal(six.levels.length, 5);
  assert.equal(six.levels[2], 'accent');
  const seven = rulerTicks([7, 8], '3+2+2');
  assert.equal(seven.levels.length, 6);
  assert.match(seven.html, /data-ruler-pulses="7"/);
  assert.match(seven.html, /data-ruler-steps-per-bar="14"/);
  assert.deepEqual(seven.levels, ['pulse', 'pulse', 'accent', 'pulse', 'accent', 'pulse']);
});
