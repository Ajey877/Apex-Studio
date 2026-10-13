/**
 * UI-03K — Arpeggiator theme contract.
 *
 * The modal is DOM-rendered (no canvas), so every neutral surface consumes
 * the active palette through the existing `--apex-*` tokens. The warm orange
 * arpeggiator identity stays on the shared gold token; the enabled/gate
 * green keeps its success meaning and the strum/rotation cyan keeps its
 * accent meaning in both themes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArpeggiatorModal } from './ArpeggiatorModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { ArpSettings, Channel } from '../types/daw';

const source = readFileSync('src/components/ArpeggiatorModal.tsx', 'utf8');
const noop = (): void => {};

const channel: Channel = DEFAULT_PROJECT.channels[0];

const defaultArp: ArpSettings = {
  enabled: false,
  mode: 'up',
  rate: '1/16',
  octaves: 2,
  gate: 0.85,
  swing: 0,
  strumMs: 15,
  euclideanSteps: 16,
  euclideanHits: 5,
  euclideanRotate: 0,
};

const render = (mode: 'dark' | 'light', arp: ArpSettings = defaultArp): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(ArpeggiatorModal, {
        isOpen: true,
        onClose: noop,
        channel: { ...channel, arp },
        onUpdateChannel: noop,
        bpm: 128,
      }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const fixedPaletteClass =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|fill)-\[#|\b(?:text|bg|border|fill)-(?:white|black)\b|bg-black(?:\/\d+)?\b|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/i;

describe('Arpeggiator theme markup (UI-03K)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the complete arpeggiator surface with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      assert.match(markup, /id="arpeggiator-modal-title"/);
      assert.ok(markup.includes(`${channel.name} ARPEGGIATOR`), 'the title keeps the channel name');
      assert.match(markup, /Polyphonic pattern generator, Euclidean math rhythms &amp; humanizer/);
      for (const label of [
        'Arp Mode', 'Step Rate (Grid Division)', 'Octaves Range', 'Gate Length',
        'Strum Micro-Delay', 'Audition Pattern', 'Save Arp Settings',
      ]) {
        assert.ok(markup.includes(label), `expected the ${label} control`);
      }
      for (const mode_ of ['UP (Ascending)', 'DOWN (Descending)', 'UP / DOWN (Bounce)', 'RANDOM (Stochastic)', 'CHORD STRUM', 'EUCLIDEAN RHYTHM']) {
        assert.ok(markup.includes(mode_), `expected the ${mode_} mode`);
      }
      for (const rate of ['1/4 Beat', '1/8 Beat', '1/16 Beat', '1/32 Fast', '1/8 Triplet', '1/16 Triplet']) {
        assert.ok(markup.includes(rate), `expected the ${rate} rate`);
      }
      assert.match(markup, /aria-label="Close arpeggiator"/);
      assert.match(markup, />DISABLED</);
      assert.match(markup, />OFF</);
    });
  }

  it('uses existing semantic tokens for surfaces, text, borders, hover and insets', () => {
    const markup = render('dark');
    const offenders = classAttributes(markup).filter((value) => fixedPaletteClass.test(value));
    assert.deepEqual(offenders, [], 'rendered classes must not carry fixed palette colours');

    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-chrome-inset',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
    ]) {
      assert.ok(source.includes(`var(${token})`), `Arpeggiator chrome consumes ${token}`);
    }
  });

  it('keeps the orange arp identity and the distinct enabled and cyan accent meanings', () => {
    assert.match(source, /bg-\[var\(--apex-gold\)\]/, 'the arp identity and filled controls use the shared gold token');
    assert.match(source, /text-\[var\(--apex-gold\)\]/, 'octave and euclidean readouts retain the orange identity');
    assert.match(source, /var\(--apex-success\)/, 'the enabled state and gate readout keep a distinct success color');
    assert.match(source, /var\(--apex-cyan-text\)/, 'strum and rotation readouts keep the cyan accent');
    assert.match(source, /accent-\[var\(--apex-cyan\)\]/, 'cyan sliders keep the accent control color');
    assert.match(source, /var\(--apex-state-playing-fg\)/, 'filled controls use a theme-safe on-colour');
  });

  it('uses ModalFrame’s themed scrim and removes the redundant dark overlay fill', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 backdrop-blur-md animate-fade-in select-none"/,
    );
    assert.doesNotMatch(source, /bg-black/);
  });

  it('preserves the enabled/bypass labels, slider ranges, and all published settings', () => {
    const enabledArp: ArpSettings = { ...defaultArp, enabled: true, mode: 'euclidean', rate: '1/8t', octaves: 3, gate: 0.6, strumMs: 22 };
    const markup = render('light', enabledArp);
    assert.match(markup, />ENABLED</);
    assert.match(markup, />ON</);
    assert.match(markup, /60%/);
    assert.match(markup, /3 Oct/);
    assert.match(markup, /22ms/);
    assert.match(markup, /E\(5, 16\)/);
    assert.match(markup, /EUCLIDEAN RHYTHM GENERATOR/);
    // The euclidean visualizer renders every step of the generated pattern:
    // 5 hits for E(5, 16), each numbered, on the gold identity colour.
    const steps = [...markup.matchAll(/min-w-\[12px\][^"]*">(\d*)</g)].map((m) => m[1]);
    assert.equal(steps.length, 16, 'the visualizer renders all 16 euclidean steps');
    assert.equal(steps.filter((step) => step !== '').length, 5, 'E(5, 16) renders 5 numbered hits');
    assert.match(source, /audioEngine\.generateEuclideanPattern\(/);
    assert.match(source, /audioEngine\.playNote\(tempChannel, dummyNote, undefined, bpm\)/);
    assert.match(source, /onUpdateChannel\(\{\s*\.\.\.channel,\s*arp: arpState\s*\}\)/);
    assert.match(source, /enabled: !prev\.enabled/);
    const ranges = [...markup.matchAll(/type="range"[^>]*"/g)].map((m) => m[0]);
    assert.equal(ranges.length, 6, 'octaves, gate, strum, steps, hits and rotation stay editable');
    assert.ok(ranges.some((r) => r.includes('min="1"') && r.includes('max="4"')), 'octaves keeps its 1–4 range');
    assert.ok(ranges.some((r) => r.includes('min="0.1"') && r.includes('max="1.5"') && r.includes('step="0.05"')), 'gate keeps its range');
    assert.ok(ranges.some((r) => r.includes('min="0"') && r.includes('max="50"') && r.includes('step="2"')), 'strum keeps its range');
    assert.ok(ranges.some((r) => r.includes('min="4"') && r.includes('max="32"')), 'euclidean steps keeps its range');
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(ArpeggiatorModal, {
        isOpen: false,
        onClose: noop,
        channel: { ...channel, arp: defaultArp },
        onUpdateChannel: noop,
        bpm: 128,
      }),
    );
    assert.equal(closed, '');
  });
});
