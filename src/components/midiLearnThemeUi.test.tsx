/**
 * UI-03L — MIDI Learn theme contract, asserted against the real component
 * markup and source. `MidiLearnModal` has no canvas, so its DOM surfaces and
 * semantic token classes follow the active palette directly; no palette seam or
 * theme observer is required.
 *
 * The modal carries three color meanings that must survive the migration:
 *   - the MIDI Learn accent (armed state, learn banner, primary bind CTA and
 *     the CC identity chip) stays on `--apex-accent`, matching the sibling
 *     `MidiControllerModal` MIDI Learn tab;
 *   - connected-hardware readiness stays green on `--apex-success`;
 *   - destructive clear/delete stays red on `--apex-danger`.
 *
 * MIDI listener wiring, learn capture, controller assignment, parameter
 * binding, and the project mutation path are pinned here alongside the shared
 * modal contract. Live Dark/Light resolution is exercised in
 * browser-tests/midiLearnTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MidiLearnModal } from './MidiLearnModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { MidiDeviceInfo, MidiMapping } from '../types/daw';

const noop = (): void => {};
const source = readFileSync('src/components/MidiLearnModal.tsx', 'utf8');
const channels = DEFAULT_PROJECT.channels;
const mixerTracks = DEFAULT_PROJECT.mixerTracks;
const mappings: MidiMapping[] = DEFAULT_PROJECT.midiMappings ?? [];

const device: MidiDeviceInfo = {
  id: 'dev-probe',
  name: 'Apex Probe Controller',
  manufacturer: 'Apex Audio',
  state: 'connected',
  type: 'input',
};

interface RenderOverrides {
  midiMappings?: MidiMapping[];
  connectedDevices?: MidiDeviceInfo[];
  isMidiLearnActive?: boolean;
  isOpen?: boolean;
}

const render = (mode: 'dark' | 'light', overrides: RenderOverrides = {}): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(MidiLearnModal, {
        isOpen: overrides.isOpen ?? true,
        onClose: noop,
        midiMappings: overrides.midiMappings ?? mappings,
        onUpdateMidiMappings: noop,
        channels,
        mixerTracks,
        connectedDevices: overrides.connectedDevices ?? [],
        isMidiLearnActive: overrides.isMidiLearnActive ?? false,
        onToggleMidiLearn: noop,
      }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** Any color that cannot follow the theme: a literal, a fixed palette utility,
    or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|fill|ring)-\[#|\b(?:text|bg|border|fill)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral|orange|yellow)-\d/i;

/** Every rendered state of the modal: the union must carry no fixed palette. */
const ALL_STATES: ReadonlyArray<[mode: 'dark' | 'light', overrides: RenderOverrides]> = [
  ['dark', {}],
  ['light', {}],
  ['dark', { isMidiLearnActive: true }],
  ['light', { isMidiLearnActive: true }],
  ['dark', { connectedDevices: [device] }],
  ['light', { connectedDevices: [device] }],
  ['dark', { midiMappings: [] }],
  ['light', { midiMappings: [] }],
];

/** Asserts an exact substring, so the failure names the missing contract. */
const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('MIDI Learn theme markup (UI-03L)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the complete MIDI Learn surface with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-midi-learn-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-midi-learn-modal-title"', 'the dialog is named by its title');
      includes(markup, 'MIDI CONTROLLER LEARN &amp; MAPPING', 'the title text is unchanged');
      includes(markup, 'Map physical MIDI knobs, faders, and pads to DAW controls', 'the subtitle is unchanged');
      includes(markup, '>STANDBY<', 'the idle armed-state badge renders');
      includes(markup, '>START MIDI LEARN<', 'the arm toggle renders');
      includes(markup, 'CONNECTED HARDWARE CONTROLLERS', 'the hardware section renders');
      includes(markup, 'QUICK PARAMETER BIND', 'the manual bind form renders');
      includes(markup, 'ACTIVE MIDI CC BINDINGS (2)', 'the binding count reflects the project mappings');
      includes(
        markup,
        'Standard MIDI CC: 1=ModWheel, 7=Volume, 10=Pan, 11=Expression, 71=Resonance, 74=Cutoff',
        'the footer reference text is unchanged',
      );
      includes(markup, 'aria-label="Close MIDI learn"', 'the close control keeps its accessible name');

      // The quick-bind form keeps every target the runtime can actually bind.
      for (const option of [
        'Master Out Volume', 'Channel Volume Fader', 'Channel Pan Knob',
        'Mixer Insert Fader', 'Mixer Insert Pan', 'Filter Cutoff (Hz)',
        'FX Slot Parameter',
      ]) {
        includes(markup, option, `the ${option} target control stays selectable`);
      }
      // Both seeded project mappings are listed with their real target data.
      includes(markup, 'CC 1', 'the first seeded mapping renders');
      includes(markup, 'CC 7', 'the second seeded mapping renders');
      includes(markup, 'Target: fx_param | ID: fx-5-verb', 'the FX parameter mapping keeps its target data');
      includes(markup, 'Target: master_vol | ID: 0', 'the master volume mapping keeps its target data');
    });
  }

  it('uses semantic token classes for every chrome surface in every rendered state', () => {
    for (const [mode, overrides] of ALL_STATES) {
      const offenders = classAttributes(render(mode, overrides))
        .filter((value) => UNTHEMED_CLASS.test(value))
        .map((value) => `${mode} ${JSON.stringify(overrides)} -> ${value}`);
      assert.deepEqual(offenders, [], 'rendered chrome must not carry fixed palette colors');
    }
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-accent',
      '--apex-accent-strong',
      '--apex-state-playing-fg',
      '--apex-state-hover',
      '--apex-success',
      '--apex-danger',
    ]) {
      includes(source, `var(${token})`, `the component consumes ${token}`);
    }
  });

  it('uses ModalFrame for the themed scrim and keeps no dark-only chrome classes', () => {
    includes(
      render('light'),
      'class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"',
      'ModalFrame prepends the shared themed scrim and the modal keeps its blur/layout classes',
    );
    assert.doesNotMatch(source, /bg-black\//, 'ModalFrame supplies the scrim');
    assert.doesNotMatch(source, /(?:bg|text|border|from|to|accent)-\[#(?:18181b|121214|222225|ff6e00|ffaa00|ff7d1a)/i);
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:white|black)\b/i);
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral|orange|yellow)-\d/i);
    // The panel keeps its structural contract: overlay id, dialog labelling, and
    // the direct-child panel div the shared modal CSS rounds and elevates.
    includes(source, 'id="fl-midi-learn-modal"', 'the overlay id is preserved verbatim');
    includes(source, 'labelledBy="fl-midi-learn-modal-title"', 'the accessible name wiring is preserved');
    includes(source, 'rounded-xl w-full max-w-3xl', 'the panel geometry is preserved');
    includes(source, 'max-h-[92vh]', 'the panel height cap is preserved');
  });

  it('keeps MIDI status meanings distinct through the accent, success and danger tokens', () => {
    // Armed state: the badge is an accent wash while idle is a neutral surface,
    // so LEARN ACTIVE and STANDBY stay distinguishable in both themes.
    includes(
      source,
      "'bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] text-[var(--apex-text)] border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] animate-pulse'",
      'the LEARN ACTIVE badge keeps the armed accent wash, border and pulse',
    );
    // Accent text on an accent wash measures 4.23:1 (Dark) / 3.90:1 (Light) over
    // the header band, so the armed label uses the primary text token instead.
    assert.doesNotMatch(
      source,
      /_16%,transparent\)\] text-\[var\(--apex-accent\)\] border-\[color-mix/,
      'the armed badge label must not use accent-on-accent-wash (below AA)',
    );
    includes(
      source,
      "'bg-[var(--apex-surface-3)] text-[var(--apex-text-3)] border-[var(--apex-border)]'",
      'the STANDBY badge stays a legible neutral state',
    );
    includes(
      source,
      'bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded-lg p-3 flex items-center gap-2 animate-pulse',
      'the waiting-for-CC banner keeps the armed accent wash',
    );
    includes(source, '<Radio className="w-4 h-4 text-[var(--apex-accent)]" />', 'the armed banner icon keeps the accent');
    // Arm toggle: armed paints the accent with a theme-safe on-colour.
    includes(
      source,
      "'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow-lg animate-pulse'",
      'the armed toggle uses the accent with a theme-safe on-colour',
    );
    includes(
      source,
      'bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)]',
      'the primary bind CTA uses the accent with a theme-safe on-colour',
    );
    includes(
      source,
      'bg-[var(--apex-accent)] flex items-center justify-center text-[var(--apex-state-playing-fg)]',
      'the brand chip keeps a solid accent fill and a theme-safe icon colour',
    );
    // CC identity chip keeps the accent on a themed inset; destructive actions keep danger.
    includes(
      source,
      'bg-[var(--apex-surface-3)] border border-[var(--apex-border)] flex items-center justify-center font-mono font-bold text-xs text-[var(--apex-accent)]',
      'the CC identity chip keeps the accent on a recessed themed inset',
    );
    includes(source, '<Sliders className="w-3.5 h-3.5 text-[var(--apex-accent)]" />', 'the bindings heading icon keeps the accent');
    includes(
      source,
      'text-[10px] text-[var(--apex-danger)] hover:text-[color-mix(in_srgb,var(--apex-danger)_78%,var(--apex-text))]',
      'Clear All stays destructive and gains a themed hover',
    );
    includes(
      source,
      'p-1.5 text-[var(--apex-text-3)] hover:text-[var(--apex-danger)] rounded hover:bg-[var(--apex-state-hover)]',
      'the per-row delete stays destructive on hover',
    );
    // Connected hardware readiness stays green; the idle WebMIDI hint does not.
    includes(source, '<Keyboard className="w-4 h-4 text-[var(--apex-success)]" />', 'a connected controller stays success green');
    includes(source, '<Cpu className="w-4 h-4 text-[var(--apex-accent)]" />', 'the idle WebMIDI hint does not claim a live connection');
    assert.equal(
      (source.match(/var\(--apex-success\)/g) ?? []).length,
      1,
      'green stays reserved for genuinely connected hardware',
    );
  });

  it('gives every icon-only control an accessible name and labels every form control', () => {
    const markup = render('light');
    includes(markup, 'aria-label="Close MIDI learn"', 'the close control is named');
    for (const ccNumber of [1, 7]) {
      includes(
        markup,
        `aria-label="Remove MIDI CC ${ccNumber} binding"`,
        `the icon-only delete control for CC ${ccNumber} is named`,
      );
    }
    // Text-bearing controls are named by their content.
    includes(markup, '<span>Bind CC</span>', 'the bind CTA is named by its text');
    includes(markup, '>Clear All<', 'Clear All is named by its text');
    includes(markup, '>Done<', 'Done is named by its text');
    // Every form control keeps its visible label text. The FX PARAMETER label
    // only renders once the FX slot target is selected, so it is pinned against
    // the source rather than the default static render.
    for (const label of ['MIDI CC #', 'TARGET CONTROL', 'ASSIGN TO TRACK']) {
      includes(markup, label, `the ${label} field label renders`);
    }
    includes(source, "'ASSIGN TO FX SLOT' : 'ASSIGN TO TRACK'", 'the assignment label still follows the selected target type');
    includes(source, 'FX PARAMETER', 'the FX parameter field label is preserved');
    includes(
      source,
      '<label className="text-[9px] text-[var(--apex-text-3)] font-mono block mb-0.5">',
      'field labels use the AA-safe muted text token',
    );
    // Form controls keep a themed inset surface, themed text, and the global
    // focus ring (nothing suppresses it with focus:outline-none).
    includes(
      source,
      'w-full bg-[var(--apex-canvas)] text-[var(--apex-text)] text-xs px-2 py-1.5 rounded border border-[var(--apex-border)]',
      'form controls use the themed canvas inset with themed text and border',
    );
    assert.doesNotMatch(source, /focus:outline-none/, 'the global focus-visible ring is never suppressed');
    assert.equal(
      (source.match(/bg-\[var\(--apex-canvas\)\] text-\[var\(--apex-text\)\] text-xs/g) ?? []).length,
      5,
      'all five form controls (CC input + four selects) are themed',
    );
  });

  it('preserves MIDI learn capture, controller assignment and parameter binding behavior', () => {
    // Arming connects to the engine MIDI stream; disarming removes the listener.
    includes(source, 'if (!isOpen || !isMidiLearnActive) return;', 'the listener only attaches while open and armed');
    includes(source, 'audioEngine.addMidiListener(handleLearnedCc)', 'arming subscribes to the engine MIDI stream');
    includes(source, 'audioEngine.removeMidiListener(handleLearnedCc)', 'disarming unsubscribes from the engine MIDI stream');
    // The first captured CC binds through the shared runtime resolver.
    includes(source, 'resolveMidiLearnCapture(event, midiMappings, learnTarget)', 'capture goes through the shared resolver');
    includes(source, 'onUpdateMidiMappings(capture.mappings)', 'the learned mapping publishes through the project mutation path');
    includes(source, 'setManualCc(capture.ccNumber)', 'the learned CC is reflected in the manual field');
    includes(source, 'onToggleMidiLearn(false)', 'learning disarms after one capture');
    includes(source, 'Learned MIDI CC #', 'the learned binding is reported to the user');
    // Manual binding keeps both paths: the FX slot contract mapper and the
    // pre-existing normalization for every other target type.
    includes(source, 'buildFxSlotParameterMapping(manualCc, mixerTracks, fxSlotTargetId, fxParamId)', 'the FX slot binder keeps the shared contract mapper');
    assert.match(
      source,
      /buildMidiLearnMapping\(\s*manualCc,\s*selectedTargetType,\s*selectedTargetId,\s*channels,\s*mixerTracks,\s*\)/,
      'manual binding keeps its normalization path',
    );
    includes(source, 'normalizeMidiLearnTargetSelection(nextType, selectedTargetId, channels, mixerTracks)', 'changing target type re-normalizes the selection');
    includes(source, 'defaultFxSlotParameterSelection(mixerTracks)', 'the FX pickers seed on a bindable parameter');
    // An already-bound CC is overwritten, and the user is told so.
    includes(source, 'midiMappings.some(m => m.ccNumber === manualCc)', 'a duplicate CC is detected');
    includes(source, 'midiMappings.filter(m => m.ccNumber !== manualCc)', 'a duplicate CC is replaced rather than duplicated');
    includes(source, 'is already bound. Overwriting', 'overwriting a bound CC is reported');
    includes(source, 'onUpdateMidiMappings([...filtered, newMapping])', 'the new binding publishes through the project mutation path');
    // Delete and clear-all still publish through the same mutation path.
    includes(source, 'onUpdateMidiMappings(midiMappings.filter(m => m.ccNumber !== cc))', 'deleting a binding publishes through the mutation path');
    includes(source, 'onUpdateMidiMappings([])', 'Clear All publishes through the mutation path');
    includes(source, 'Cleared all MIDI CC mappings.', 'Clear All is reported to the user');
    // The FX slot selection is re-seeded when a slot disappears mid-session, so
    // the form can never publish a binding for a deleted slot.
    includes(source, 'if (fxSlotExists && fxParamExists) return;', 'a valid FX selection is left alone');
    includes(source, 'setFxSlotTargetId(fxFallbackSlotTargetId)', 'a deleted FX slot re-seeds the picker');
    includes(source, 'setFxParamId(fxFallbackParamId)', 'a deleted FX parameter re-seeds the picker');
    includes(source, 'That FX slot has no contract parameter to bind.', 'an unbindable slot is reported instead of silently dropped');
    // The CC input keeps its 0-127 MIDI byte range.
    includes(source, 'min="0"', 'the CC input keeps its MIDI byte floor');
    includes(source, 'max="127"', 'the CC input keeps its MIDI byte ceiling');
    includes(source, 'setManualCc(parseInt(e.target.value) || 0)', 'the CC input parsing is unchanged');
    // Status toasts still self-clear on the existing timer.
    assert.equal(
      (source.match(/setTimeout\(\(\) => setStatusMessage\(null\), 3000\)/g) ?? []).length,
      4,
      'every status message keeps its 3s self-clear',
    );
  });

  it('contains no literal color anywhere in the component source', () => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'no fixed hex color remains');
    assert.doesNotMatch(source, /rgba?\(/i, 'no fixed rgb/rgba color remains');
  });

  it('renders nothing while closed', () => {
    for (const mode of ['dark', 'light'] as const) {
      const closed = render(mode, { isOpen: false });
      assert.equal(closed, `<div data-theme="${mode}"></div>`, 'the modal renders no markup while closed');
      assert.doesNotMatch(closed, /role="dialog"/, 'no dialog is mounted while closed');
      assert.doesNotMatch(closed, /fl-midi-learn-modal/, 'no overlay is mounted while closed');
    }
  });
});
