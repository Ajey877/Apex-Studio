import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GrossBeatModal } from './GrossBeatModal';
import { audioEngine } from '../audio/audioEngine';
import { resolveGrossBeatClosedGain } from '../audio/grossBeatGate';
import type { GrossBeatState } from '../types/daw';

/**
 * Phase 57 — Gross Beat truth pass.
 *
 * The modal used to present itself as a "TIME FX BUFFER" offering half-time,
 * buffer speed, octave pitch drops and a turntable tape brake. The engine
 * implements none of that: it applies a 16-step amplitude gate to the master
 * bus. These tests render the real modal and pin the truthful surface, so the
 * misleading claims cannot quietly come back.
 */

const PROPS = {
  isOpen: true,
  onClose: () => undefined,
  currentStep: 0,
  isPlaying: false,
  // Phase 79: the modal reads state from ProjectState; tests supply a default
  // pattern (disabled) so the surface renders the bypass state.
  grossBeatState: { enabled: false, mix: 1.0, gateSteps: Array(16).fill(true) as boolean[] },
  onUpdateGrossBeat: () => undefined,
};

function renderModal(overrides: Partial<typeof PROPS> = {}): string {
  return renderToStaticMarkup(React.createElement(GrossBeatModal, { ...PROPS, ...overrides }));
}

/** Phrases the engine has never implemented and must never advertise again. */
const UNSUPPORTED_CLAIMS = [
  'TIME FX',
  'TIME BUFFER',
  'TIME MANIPULATION',
  'TAPE STOP',
  'HALF-TIME',
  'HALF TIME',
  'OCTAVE',
  'PITCH DROP',
  'PITCH SHIFT',
  'TIME-STRETCH',
  'STUTTER',
  'BUFFER SPEED',
  'VINYL',
  'ANALOG SHUTOFF',
  'DECELERATION',
];

/** The modal is closed: nothing renders at all. */
test('renders nothing while closed', () => {
  assert.equal(renderModal({ isOpen: false }), '');
});

test('names the surface MASTER GATE / AMPLITUDE GATE', () => {
  const markup = renderModal();
  assert.match(markup, />MASTER GATE</);
  assert.match(markup, /AMPLITUDE GATE/);
});

test('describes the implemented behaviour as a sixteen-step master-bus gate', () => {
  const markup = renderModal();
  assert.match(markup, /Sixteen-step amplitude gate on the master bus/);
});

test('keeps the shared modal dialog contract intact', () => {
  const markup = renderModal();
  assert.match(markup, /id="gross-beat-modal-title"/);
  assert.match(markup, /aria-label="Close Gross Beat"/);
  assert.match(markup, /aria-modal="true"/);
});

test('discloses what the gate does, live and in export', () => {
  const markup = renderModal();
  assert.match(markup, /16-step gate on the master bus, live and in export\./);
});

test('explicitly discloses the operations it does NOT perform', () => {
  const markup = renderModal();
  assert.match(markup, /NOT APPLIED/);
  assert.match(markup, /no time-stretch, pitch-shift, half-time or tape processing/);
  assert.match(markup, /the engine gates gain on the steps below and nothing else/);
});

test('no longer advertises any unsupported time or pitch operation', () => {
  // The mandated disclosure necessarily names the unsupported operations in
  // order to deny them ("no time-stretch, pitch-shift, half-time or tape
  // processing"), so that sentence is stripped before the scan runs. What is
  // left must contain no claim of processing the engine does not implement.
  const withoutDisclosure = renderModal().replace(/NOT APPLIED:[\s\S]*?nothing else\./g, ' ');
  const upper = withoutDisclosure.toUpperCase();
  for (const claim of UNSUPPORTED_CLAIMS) {
    assert.ok(
      !upper.includes(claim),
      `the modal must not advertise "${claim}" - the engine does not implement it`,
    );
  }
});

test('the master brake is described as a gain fade, not a tape or turntable stop', () => {
  const markup = renderModal();
  assert.match(markup, /MASTER BRAKE/);
  assert.match(markup, /BRAKE</);
  assert.match(markup, /Master gain fade to silence and back/);
  assert.match(markup, /not a tape or turntable stop/);
});

test('"turntable" is only ever mentioned to deny it, never to advertise it', () => {
  const markup = renderModal();
  const mentions = markup.match(/turntable/gi) ?? [];
  // The single permitted mention is inside the explicit negation above. Any
  // second mention would mean the claim crept back into the surface.
  assert.equal(mentions.length, 1, `expected exactly one (negated) turntable mention, got ${mentions.length}`);
  assert.ok(
    markup.includes('not a tape or turntable stop'),
    'the turntable mention must sit inside the explicit negation',
  );
});

test('the master brake is a duration-scoped gain fade on the master bus', () => {
  const markup = renderModal();
  for (const duration of ['250', '500', '800', '1200', '1800']) {
    assert.match(markup, new RegExp(`value="${duration}"`), `expected a ${duration}ms brake option`);
  }
});

test('presets only offer gate patterns, never time or pitch processing', () => {
  const markup = renderModal();
  assert.match(markup, /GATE PATTERN PRESETS/);
  for (const preset of [
    'Half-Bar Chop',
    'Long Hold',
    'Alternating 16ths',
    'Pump Gap',
    'Triplet Chop',
    'Broken 16ths',
  ]) {
    assert.ok(markup.includes(preset), `expected the "${preset}" gate-pattern preset`);
  }
});

test('the gate grid is a 16-step amplitude gate grid', () => {
  const markup = renderModal();
  assert.match(markup, /16-STEP AMPLITUDE GATE GRID/);
  assert.match(markup, /1\/16 beat grid/);
  for (let step = 1; step <= 16; step += 1) {
    assert.ok(markup.includes(`>${step}<`), `expected step ${step} in the gate grid`);
  }
});

test('the footer describes the real master bus processing', () => {
  const markup = renderModal();
  assert.match(markup, /Master Bus Amplitude Gate/);
});

test('the depth control reports the actual closed-step gain', () => {
  const markup = renderModal();
  // Default engine mix is 1.0, so closed steps sit at 1 - 1 * 0.95 = 0.05.
  assert.match(markup, /Closed steps: 5% gain/);
  assert.match(markup, /GATE DEPTH/);
});

test('the power switch reports bypass while the gate is disabled', () => {
  const markup = renderModal();
  assert.match(markup, />BYPASS</);
});

test('renders the engine gate pattern and reports an active gate', () => {
  // Phase 79: the modal reads state from props (ProjectState-owned), not
  // straight from audioEngine. Pass an active override via renderModal.
  const enabled: GrossBeatState = {
    enabled: true,
    mix: 0.5,
    gateSteps: Array.from({ length: 16 }, (_, index) => index < 8),
  };
  const markup = renderModal({ grossBeatState: enabled });
  assert.match(markup, />EFFECT ACTIVE</);
  assert.match(markup, /50%/);
  // 1 - 0.5 * 0.95 = 0.525
  assert.match(markup, /Closed steps: 53% gain/);
  assert.equal(resolveGrossBeatClosedGain(0.5), 0.525);
});

test('the engine Gross Beat state carries only the fields the gate uses', () => {
  const state: GrossBeatState = audioEngine.getGrossBeatState();
  assert.deepEqual(Object.keys(state).sort(), ['enabled', 'gateSteps', 'mix']);
  assert.equal(state.gateSteps.length, 16);
  assert.ok(state.gateSteps.every((step) => typeof step === 'boolean'));
});

test('the engine does not expose any time or pitch gate state', () => {
  const state = audioEngine.getGrossBeatState() as unknown as Record<string, unknown>;
  for (const removed of ['preset', 'speed', 'tapeStopActive', 'tapeStopDurationMs', 'pitchShiftSemitones']) {
    assert.ok(!(removed in state), `Gross Beat state must not carry "${removed}"`);
  }
});
