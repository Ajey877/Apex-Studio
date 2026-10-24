/**
 * Phase 8C — Audio-to-MIDI theme + truthfulness contract.
 *
 * `AudioToMidiModal` replaced the hard-coded "Polyphonic Blob Editor" prototype.
 * It renders with no canvas and no project props (the DSP and commit paths are
 * covered by `src/audio/audioToMidi.test.ts`, `src/state/audioToMidiCommit.test.ts`
 * and the Chromium spec), so what this suite pins is:
 *
 *  - every surface follows the active palette through `--apex-*` tokens;
 *  - the shared ModalFrame scrim and dialog semantics are intact;
 *  - both analysis modes are selectable, and the copy states each one's real
 *    boundary (monophonic: single voice; polyphonic: C2–C6, up to 4 voices, no
 *    source separation) plus the non-mutating preview guarantee — instead of
 *    claiming what the DSP does not do;
 *  - the entry point is reachable from the transport tools menu;
 *  - there is no demo blob data left anywhere in the component.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AudioToMidiModal } from './AudioToMidiModal';
import { TRANSPORT_TOOL_GROUPS, TRANSPORT_TOOL_IDS } from './TransportToolsMenu';

const source = readFileSync('src/components/AudioToMidiModal.tsx', 'utf8').replace(/\r\n/g, '\n');

/** Source with comments stripped, so prose cannot satisfy a literal assertion. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const noop = (): void => {};

const render = (mode: 'dark' | 'light'): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(AudioToMidiModal, { isOpen: true, onClose: noop }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** Any colour that cannot follow the theme. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring|hover:text|hover:bg)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Audio to MIDI theme markup (Phase 8C)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the real analysis surface with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-audio-to-midi-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-audio-to-midi-modal-title"', 'the dialog is named by its title');
      includes(markup, 'aria-label="Close audio to MIDI"', 'the close control has an accessible name');
      includes(markup, '>AUDIO TO MIDI<', 'the title renders');
      includes(markup, 'MONOPHONIC · REAL PCM', 'the badge names the default mode');
      includes(markup, 'aria-label="Monophonic analysis mode"', 'the monophonic mode is selectable');
      includes(markup, 'aria-label="Polyphonic analysis mode"', 'the polyphonic mode is selectable');
      includes(markup, 'ANALYSIS MODE', 'the mode control is labelled');
      includes(markup, '>Analyse clip<', 'the analysis action renders');
      includes(markup, 'aria-label="Minimum note length"', 'the minimum-length control renders');
      includes(markup, 'aria-label="Quantize note starts and lengths"', 'the quantize control renders');
      includes(markup, '>Close<', 'the footer action renders');
      includes(markup, 'No audio clip selected', 'the empty source state is honest');
    });
  }

  it('carries no fixed palette in any rendered class of either theme', () => {
    for (const mode of ['dark', 'light'] as const) {
      const offenders = classAttributes(render(mode)).filter((value) => UNTHEMED_CLASS.test(value));
      assert.deepEqual(offenders, [], `${mode} renders an unthemed class`);
    }
  });

  it('carries no chrome literal anywhere in the component code', () => {
    const offenders = [...code.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
      .filter((value) => UNTHEMED_CLASS.test(value));
    assert.deepEqual(offenders, [], 'a className in the source still carries a fixed palette');
    assert.doesNotMatch(code, /rgba?\(/, 'no rgb literal remains in the component code');
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('uses existing semantic tokens for surfaces, text, borders, hover and insets', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover',
      '--apex-state-playing-fg',
    ]) {
      assert.ok(code.includes(`var(${token})`), `audio to MIDI chrome consumes ${token}`);
    }
  });

  it('keeps the success identity and the gold warning banner', () => {
    assert.match(code, /bg-\[var\(--apex-success\)\]/, 'the identity tile and CTAs use the success token');
    assert.match(code, /text-\[var\(--apex-gold\)\]/, 'the discard/warning meaning keeps its warm token');
    assert.match(code, /text-\[var\(--apex-state-playing-fg\)\]/, 'filled controls use a theme-safe on-colour');
  });

  it('states each mode’s real boundaries and never over-claims', () => {
    const markup = render('dark');
    includes(markup, 'review first, commit explicitly', 'the subtitle keeps the explicit-commit promise');
    // Default mode = monophonic, with its existing boundary statement intact.
    includes(
      markup,
      'Monophonic, clearly voiced melodic material, fundamentals 75–1000 Hz',
      'the boundary text names the supported material',
    );
    includes(
      markup,
      'polyphonic material (chords) are refused with a reason and',
      'the monophonic boundary refuses polyphonic material',
    );
    includes(markup, 'No chord or source separation', 'the boundary text refuses chord separation');
    // The polyphonic mode's limits are stated in the component (and rendered once
    // it is selected): range, voice cap and the honest failure modes.
    includes(code, 'POLYPHONIC · REAL PCM', 'the polyphonic badge names the mode truthfully');
    includes(code, 'up to ${POLY_MAX_VOICES} simultaneous fundamentals in C2–C6', 'the polyphonic range and voice cap are stated');
    includes(code, 'bells/inharmonic material and more than ${POLY_MAX_VOICES} voices are refused', 'the polyphonic refusals are stated');
    includes(code, 'two fundamentals about a semitone apart in one register can merge', 'the merge limit is stated');
    includes(code, 'No source separation and no instrument identification', 'polyphonic mode refuses source separation too');
    includes(code, 'confidence is the share of the spectrum a note explains', 'confidence is described as a measurement');
    includes(
      markup,
      'Analysis and preview never change the project; only the explicit commit writes notes, as one undoable step.',
      'the footer states the non-mutating preview guarantee',
    );
    includes(
      code,
      'Preview only — nothing has been written to the project yet.',
      'the preview banner states that analysis writes nothing',
    );
    includes(
      code,
      'default: a NEW pattern, so no existing part can be overwritten',
      'the destination default is non-destructive',
    );
    includes(
      code,
      'I understand this deletes {existingNotes} existing note',
      'replacing existing notes needs an explicit confirmation',
    );
    // The prototype's claims are gone for good.
    assert.doesNotMatch(code, /INITIAL_BLOBS|DEMO BLOBS|PolyphonicBlob|polyphonicBlobAuditionNote|Phase-Locked/i);
    assert.doesNotMatch(code, /SPECTRAL NOTE BLOB TIMELINE/);
  });

  it('analyses real PCM through the shared pipeline and the project history path', () => {
    assert.match(code, /analyseSelectedClipForMidi\(/, 'the modal runs the real monophonic module');
    assert.match(code, /analyseSelectedClipForPolyphonicMidi\(/, 'the modal runs the real polyphonic module');
    assert.match(code, /analysisMode === 'polyphonic'/, 'the selected mode decides which analyzer runs');
    assert.match(code, /audioEngine\.getSampleBuffer\(id\)/, 'the real asset lookup is used');
    assert.match(code, /hydrateAudioClip\(audioEngine, id\)/, 'the persisted-asset fallback is used');
    assert.match(code, /onCommitNotes\(\{/, 'the commit goes through the injected App handler');
    assert.match(code, /commitAudioToMidiNotes\(/, 'the destination dry run uses the real commit contract');
    assert.match(code, /addEmptyPatternToProjectState\(/, 'a new destination pattern uses the pattern API');
    assert.match(code, /audioToMidiNewPatternLengthSteps\(/, 'the new pattern length comes from the commit contract');
  });

  it('is reachable from the transport tools menu', () => {
    const audioToMidi = TRANSPORT_TOOL_GROUPS.flatMap(group => group.items).find(
      item => item.id === 'fl-audio-to-midi-btn'
    );
    assert.ok(audioToMidi, 'the Audio to MIDI tool ships in the overflow menu');
    assert.equal(audioToMidi!.label, 'Audio to MIDI');
    assert.equal(audioToMidi!.handler, 'audioToMidi');
    assert.ok(TRANSPORT_TOOL_IDS.includes('fl-audio-to-midi-btn'));
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim is used',
    );
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(AudioToMidiModal, { isOpen: false, onClose: noop }),
    );
    assert.equal(closed, '');
  });
});
