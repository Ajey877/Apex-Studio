/**
 * UI-03I — Midi Controller theme contract, asserted against the real component
 * markup and source. This component has no canvas, so its DOM surfaces and
 * semantic token classes follow the active palette directly.
 *
 * Hardware/connection colours remain semantically distinct; the virtual drum
 * pads keep their original instrument identity hues. MIDI listeners, mapping,
 * and virtual-note paths are guarded here alongside the shared modal contract.
 * Live Dark/Light resolution is exercised in
 * browser-tests/midiControllerTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MidiControllerModal } from './MidiControllerModal';
import { DEFAULT_PROJECT } from '../audio/presets';

const noop = (): void => {};
const source = readFileSync('src/components/MidiControllerModal.tsx', 'utf8');
const channels = DEFAULT_PROJECT.channels;
const mixerTracks = DEFAULT_PROJECT.mixerTracks;
const mappings = DEFAULT_PROJECT.midiMappings ?? [];

const render = (isOpen = true): string =>
  renderToStaticMarkup(
    React.createElement(MidiControllerModal, {
      isOpen,
      onClose: noop,
      channels,
      mixerTracks,
      midiMappings: mappings,
      onUpdateMidiMappings: noop,
      activeChannel: channels[0],
    })
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring|fill)-\[#|\b(?:text|bg|border)-(?:white|black)\b|bg-black|rgba?\(|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/i;

const PAD_IDENTITIES = [
  { name: 'Kick 1', pitch: 36, color: '#ff5722' },
  { name: 'Kick 2', pitch: 35, color: '#e64a19' },
  { name: 'Snare 1', pitch: 38, color: '#ff9800' },
  { name: 'Clap', pitch: 39, color: '#fbc02d' },
  { name: 'CH Hat', pitch: 42, color: '#00bcd4' },
  { name: 'OH Hat', pitch: 46, color: '#0288d1' },
  { name: 'Tom Low', pitch: 41, color: '#9c27b0' },
  { name: 'Crash', pitch: 49, color: '#e91e63' },
] as const;

describe('Midi Controller theme markup (UI-03I)', () => {
  it('renders the accessible controller dialog, all four tabs, and the device empty state', () => {
    const markup = render();
    assert.match(markup, /id="midi-controller-modal-overlay"/);
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-labelledby="midi-controller-modal-title"/);
    assert.match(markup, /Hardware MIDI &amp; Controller Hub/);
    assert.match(markup, /Web MIDI Studio/);
    assert.match(markup, /Connected Devices \(0\)/);
    assert.match(markup, /MIDI Learn &amp; CC Map/);
    assert.match(markup, /Virtual Controller &amp; Pads/);
    assert.match(markup, /Live Traffic Monitor/);
    assert.match(markup, /Web MIDI Engine Active/);
    assert.match(markup, /No Hardware MIDI Devices Detected/);
    assert.match(markup, /Rescan Hardware/);
    assert.match(markup, /aria-label="Close MIDI controller"/);
  });

  it('uses semantic token classes for every rendered chrome surface in the default tab', () => {
    const offenders = classAttributes(render()).filter((value) => UNTHEMED_CLASS.test(value));
    assert.deepEqual(offenders, [], 'rendered chrome must not carry fixed palette colors');
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-chrome-inset',
      '--apex-accent',
      '--apex-accent-strong',
      '--apex-state-selected',
      '--apex-state-selected-border',
      '--apex-success',
      '--apex-cyan',
      '--apex-cyan-text',
      '--apex-state-hover',
    ]) {
      assert.ok(source.includes(`var(${token})`), `the component consumes ${token}`);
    }
  });

  it('uses ModalFrame for the themed scrim and has no dark-only chrome color classes', () => {
    const markup = render();
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in"/
    );
    assert.doesNotMatch(source, /bg-black\//, 'ModalFrame supplies the scrim');
    assert.doesNotMatch(source, /(?:bg|text|border|accent)-\[#(?:18181b|141416|ff6e00)/i);
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:white|black)\b/i);
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/i);
  });

  it('preserves every MPC pad identity color and paints it from pad data', () => {
    const found = [...source.matchAll(/\{ name: '([^']+)', pitch: (\d+), color: '(#[0-9a-fA-F]{6})' \}/g)]
      .map((match) => ({ name: match[1], pitch: Number(match[2]), color: match[3] }));
    assert.deepEqual(found, PAD_IDENTITIES);
    assert.match(source, /style=\{\{ borderBottomColor: pad\.color, borderBottomWidth: '3px' \}\}/);
    assert.match(source, /bg-\[var\(--apex-piano-key-natural\)\]/, 'natural key surface follows the theme');
    assert.match(source, /active:bg-\[var\(--apex-state-playing\)\].*active:text-\[var\(--apex-state-playing-fg\)\]/);
  });

  it('keeps MIDI event meanings distinct through the success, danger, cyan, and gold tokens', () => {
    assert.match(source, /log\.type === 'noteOn'.*var\(--apex-success\)/s);
    assert.match(source, /log\.type === 'noteOff'.*var\(--apex-danger\)/s);
    assert.match(source, /log\.type === 'cc'.*var\(--apex-cyan\).*var\(--apex-cyan-text\)/s);
    assert.match(source, /log\.type === 'cc'[\s\S]*var\(--apex-gold\)/);
    assert.match(source, /bg-\[var\(--apex-success\)\]/, 'engine-ready indicators remain success green');
    assert.match(source, /bg-\[color-mix\(in_srgb,var\(--apex-success\)_16%,transparent\)\]/, 'device-ready badges retain a success wash');
    assert.match(source, /text-\[var\(--apex-cyan-text\)\]">CC#:/, 'small CC readouts use the AA-safe cyan foreground');
  });

  it('preserves MIDI learning, mapping, listener, and virtual-note behavior', () => {
    assert.match(source, /audioEngine\.addMidiListener\(handleMidiEvent\)/);
    assert.match(source, /audioEngine\.removeMidiListener\(handleMidiEvent\)/);
    assert.match(source, /if \(e\.type === 'cc' && learningTarget\)/);
    assert.match(source, /resolveMidiLearnCapture\(e, midiMappings/);
    assert.match(source, /onUpdateMidiMappings\(capture\.mappings\)/);
    assert.match(source, /updated\.splice\(index, 1\)/);
    assert.match(source, /audioEngine\.playNote\(activeChannel/);
    assert.match(source, /onMouseDown=\{\(\) => playVirtualNote\(pad\.pitch\)\}/);
    assert.match(source, /onMouseDown=\{\(\) => playVirtualNote\(noteNum\)\}/);
    assert.match(source, /setVirtualOctave\(Math\.max\(1, virtualOctave - 1\)\)/);
    assert.match(source, /setVirtualOctave\(Math\.min\(7, virtualOctave \+ 1\)\)/);
  });

  it('contains no literal color outside the preserved MPC pad identity palette', () => {
    const withoutPadData = source.replace(/color: '#[0-9a-fA-F]{6}'/g, 'color: PAD_IDENTITY');
    assert.doesNotMatch(withoutPadData, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(withoutPadData, /rgba?\(/i);
  });

  it('renders nothing while closed', () => {
    assert.equal(render(false), '');
  });
});
