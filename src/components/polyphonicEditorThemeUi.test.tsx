/**
 * UI-03M — Polyphonic Blob Editor theme contract.
 *
 * `PolyphonicEditorModal` is DOM-rendered with no canvas, so every surface
 * follows the active palette through the existing `--apex-*` tokens. The
 * prototype's green identity stays on `--apex-success`, the NOT-APPLIED
 * warnings stay on the `--apex-gold` info banner the other migrated modals use,
 * and the three inspector parameters keep one distinct signal hue each
 * (success / cyan / gold).
 *
 * This is an explicit **prototype**: it takes no blob props, publishes nothing,
 * and its own copy states that edits never reach the audio engine. A theme
 * migration must not make a stub read as a working feature, so every
 * PROTOTYPE / DEMO BLOBS / NOT APPLIED / "not detected from audio" string is
 * pinned verbatim here, and the demo blob data (pitches, steps, amplitudes,
 * formant and drift values) is asserted unchanged.
 *
 * `INITIAL_BLOBS` is a module-local constant, so — unlike a persisted identity
 * colour — the blob hues are chrome and resolve through tokens. They are
 * asserted to be exactly the five that clear WCAG 1.4.11 3:1 as a blob border
 * on every surface they are painted on, in both palettes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PolyphonicEditorModal, polyphonicBlobAuditionNote } from './PolyphonicEditorModal';
import type { PolyphonicBlob } from '../types/daw';

const source = readFileSync('src/components/PolyphonicEditorModal.tsx', 'utf8').replace(/\r\n/g, '\n');

/** Source with comments stripped, so prose about a legacy literal cannot
    satisfy or trip a literal assertion. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const noop = (): void => {};

const render = (mode: 'dark' | 'light'): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(PolyphonicEditorModal, { isOpen: true, onClose: noop }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** Any colour that cannot follow the theme: a literal, a fixed palette
    utility, or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring|hover:text|hover:bg)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Polyphonic Blob Editor theme markup (UI-03M)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the complete prototype surface with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-polyphonic-editor-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-polyphonic-editor-modal-title"', 'the dialog is named by its title');
      includes(markup, 'aria-label="Close polyphonic editor"', 'the close control keeps its accessible name');
      includes(markup, 'SPECTRAL NOTE BLOB TIMELINE (16 STEPS)', 'the timeline section renders');
      includes(markup, '>Correct Pitch 100%<', 'the quantize action renders');
      includes(markup, '>Audition<', 'the audition action renders');
      includes(markup, '>Split Blob<', 'the split action renders');
      includes(markup, '>Close Prototype<', 'the footer action renders');
      includes(markup, 'PITCH CENTER', 'the pitch parameter renders');
      includes(markup, 'FORMANT SHIFT', 'the formant parameter renders');
      includes(markup, 'PITCH DRIFT / VIBRATO', 'the drift parameter renders');

      // The six demo blobs render with their real pitch and amplitude labels.
      for (const label of ['C4', 'E4', 'G4', 'B4', 'C3', 'G3']) {
        includes(markup, `>${label}<`, `the ${label} demo blob renders`);
      }
      for (const amplitude of ['85%', '90%', '95%', '80%', '75%']) {
        includes(markup, `>${amplitude}<`, `the ${amplitude} amplitude read-out renders`);
      }
      includes(markup, '>+1.5st<', 'the positive formant shift renders');
      includes(markup, '>-1st<', 'the negative formant shift renders');

      // The pitch ruler keeps its six reference rows.
      for (const row of ['B5', 'G5', 'E5', 'C5', 'G4', 'C4']) {
        includes(markup, `>${row}<`, `the ${row} ruler row renders`);
      }
      for (const midi of ['(71)', '(67)', '(64)', '(60)', '(55)', '(48)']) {
        includes(markup, `>${midi}<`, `the ${midi} ruler value renders`);
      }

      // 16 step grid lines, every fourth one emphasised.
      const strong = markup.match(/border-\[color-mix\(in_srgb,var\(--apex-text\)_26%,transparent\)\]/g) ?? [];
      const weak = markup.match(/border-\[color-mix\(in_srgb,var\(--apex-text\)_12%,transparent\)\]/g) ?? [];
      assert.equal(strong.length, 4, 'the four bar lines stay emphasised');
      assert.equal(weak.length, 12, 'the twelve remaining step lines stay fine');

      // The inspector opens on the first blob.
      includes(markup, 'SELECTED BLOB INSPECTOR: C4 (Orig: C4)', 'the inspector shows the selected blob');

      // Six blob fills, each a token wash rather than a hex-alpha suffix.
      const fills = markup.match(/background-color:color-mix\(in srgb, var\(--apex-[a-z-]+\) 27%, transparent\)/g) ?? [];
      assert.equal(fills.length, 6, 'every demo blob paints a themed wash');
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
    // Exactly one hex literal is allowed to remain: `PREVIEW_CHANNEL.color`.
    // That is a `Channel.color` identity value — the category UI-03A explicitly
    // preserves — it is required by the `Channel` type, `audioEngine.playNote`
    // never reads it, and it is never rendered.
    const remainingHex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(remainingHex, ['#00e5ff'], 'only the inert preview channel identity colour remains');
    assert.match(code, /color: '#00e5ff',\n\s*mixerTrackId: 1,/, 'the remaining literal is the preview channel identity');
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
    assert.doesNotMatch(code, /text-amber-\d/, 'the Tailwind amber palette utility is gone');
  });

  it('uses existing semantic tokens for surfaces, text, borders, hover and insets', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-chrome-inset',
      '--apex-canvas',
      '--apex-border',
      '--apex-grid-line',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover',
      '--apex-state-playing-fg',
    ]) {
      assert.ok(code.includes(`var(${token})`), `polyphonic editor chrome consumes ${token}`);
    }
  });

  it('keeps the green prototype identity, the gold warning banner and three distinct parameter hues', () => {
    assert.match(code, /bg-\[var\(--apex-success\)\]/, 'the identity tile and CTAs use the success token');
    assert.match(
      code,
      /border-\[color-mix\(in_srgb,var\(--apex-success\)_40%,transparent\)\]/,
      'the panel border and badge edge keep a success wash',
    );
    assert.match(
      code,
      /bg-\[color-mix\(in_srgb,var\(--apex-gold\)_14%,transparent\)\]/,
      'the NOT-APPLIED banner keeps the gold info wash',
    );
    assert.match(code, /text-\[var\(--apex-success\)\]/, 'the pitch read-out keeps its green meaning');
    assert.match(code, /text-\[var\(--apex-cyan-text\)\]/, 'the formant read-out keeps its cyan meaning');
    assert.match(code, /text-\[var\(--apex-gold\)\]/, 'the drift read-out keeps its warm meaning');
    assert.match(code, /accent-\[var\(--apex-success\)\]/, 'the pitch slider keeps its accent');
    assert.match(code, /accent-\[var\(--apex-cyan\)\]/, 'the formant slider keeps its accent');
    assert.match(code, /accent-\[var\(--apex-gold\)\]/, 'the drift slider keeps its accent');
    assert.match(code, /ring-\[var\(--apex-accent-strong\)\]/, 'blob selection carries a themed ring');
    assert.match(code, /var\(--apex-state-playing-fg\)/, 'filled controls use a theme-safe on-colour');
  });

  it('themes the demo blob palette and keeps all six blobs distinguishable', () => {
    const blobBlock = /const INITIAL_BLOBS: PolyphonicBlob\[\] = \[([\s\S]*?)\n\];/.exec(code);
    assert.ok(blobBlock, 'the demo blob constant is still present');
    const colors = [...blobBlock[1].matchAll(/color: '(var\(--apex-[a-z-]+\))'/g)].map((m) => m[1]);
    assert.equal(colors.length, 6, 'every demo blob carries a themed identity colour');
    assert.deepEqual(new Set(colors).size, 5, 'the six blobs use five distinct hues');
    for (const token of [
      'var(--apex-cyan-text)', 'var(--apex-success)', 'var(--apex-aux-text)',
      'var(--apex-gold)', 'var(--apex-accent)',
    ]) {
      assert.ok(colors.includes(token), `the blob palette resolves ${token}`);
    }
    assert.equal(colors[4], colors[5], 'the two harmony-voice blobs still share one hue');
    assert.match(code, /backgroundColor: `color-mix\(in srgb, \$\{blob\.color\} 27%, transparent\)`/,
      'the blob fill is a token wash');
    assert.match(code, /borderColor: blob\.color/, 'the blob border keeps the blob hue');
  });

  it('preserves the prototype’s truthfulness copy verbatim', () => {
    const markup = render('dark');
    includes(markup, 'POLYPHONIC AUDIO BLOB EDITOR (PROTOTYPE)', 'the title still declares the prototype');
    includes(markup, 'PROTOTYPE — DEMO BLOBS', 'the badge still declares demo blobs');
    includes(
      markup,
      'Prototype surface with sample blobs. It does not analyse, import or play back your audio.',
      'the subtitle still refuses the analysis claim',
    );
    includes(
      markup,
      'NOT APPLIED — PROTOTYPE, NO AUDIO ANALYSIS OR EDITING',
      'the NOT-APPLIED banner is unchanged',
    );
    includes(markup, 'SAMPLE BLOBS ONLY', 'the banner qualifier is unchanged');
    includes(markup, '6 Demo Blobs (not detected from audio)', 'the blob count still denies audio detection');
    includes(
      markup,
      'Prototype: edits stay in this window and never reach the audio engine',
      'the footer disclaimer is unchanged',
    );
    includes(markup, '>Close Prototype<', 'the footer action still names the prototype');
    // The audition status still says it is a synth preview, not the user's audio.
    includes(
      code,
      'Preview tone at ${midiToName(blob.targetPitch)} (synth preview, not your audio)',
      'the audition toast still refuses the playback claim',
    );
    includes(
      code,
      'Demo blobs snapped to the nearest semitone (prototype display only).',
      'the quantize toast still refuses the edit claim',
    );
    includes(code, "name: 'Prototype Blob Preview'", 'the audition channel still names itself a prototype');
  });

  it('leaves the demo blob data and the audition note contract untouched', () => {
    const blobBlock = /const INITIAL_BLOBS: PolyphonicBlob\[\] = \[([\s\S]*?)\n\];/.exec(code);
    assert.ok(blobBlock);
    for (const expected of [
      "originalPitch: 60, targetPitch: 60, startStep: 0, durationSteps: 4, amplitude: 0.85",
      "originalPitch: 63.8, targetPitch: 64, startStep: 4, durationSteps: 4, amplitude: 0.9",
      "originalPitch: 67.2, targetPitch: 67, startStep: 8, durationSteps: 4, amplitude: 0.95, formantShift: 1.5",
      "originalPitch: 70.9, targetPitch: 71, startStep: 12, durationSteps: 4, amplitude: 0.8, formantShift: -1.0",
      "originalPitch: 48, targetPitch: 48, startStep: 0, durationSteps: 8, amplitude: 0.75",
      "originalPitch: 55.1, targetPitch: 55, startStep: 8, durationSteps: 8, amplitude: 0.8",
    ]) {
      includes(blobBlock[1], expected, 'the demo blob data is unchanged');
    }

    // Phase 1B: `durationSteps` and `Note.duration` are BOTH sixteenth steps,
    // so the value passes straight through with no division.
    const blob: PolyphonicBlob = {
      id: 'probe', originalPitch: 62.4, targetPitch: 62, startStep: 3, durationSteps: 7,
      amplitude: 0.66, formantShift: 2, pitchDriftAmount: 0.2, vibratoDepth: 0.3,
      color: 'var(--apex-gold)',
    };
    const note = polyphonicBlobAuditionNote(blob);
    assert.equal(note.duration, 7, 'the audition gate is the blob’s own step count');
    assert.equal(note.pitch, 62, 'the audition pitch is the corrected target, rounded');
    assert.equal(note.velocity, 0.66, 'the audition velocity is the blob amplitude');
    assert.equal(note.start, 0, 'the audition starts at the beginning of the preview');
    assert.match(code, /audioEngine\.playNote\(\n\s*PREVIEW_CHANNEL,\n\s*polyphonicBlobAuditionNote\(blob\),\n\s*\);/,
      'audition still routes through the real engine on the preview channel');
  });

  it('keeps the quantize and split behaviour intact', () => {
    assert.match(code, /targetPitch: Math\.round\(b\.originalPitch\)/, 'quantize still snaps to the original pitch');
    assert.match(code, /pitchDriftAmount: b\.pitchDriftAmount \* \(1 - pitchDriftCorrection \/ 100\)/,
      'quantize still scales drift by the correction amount');
    assert.match(code, /if \(!target \|\| target\.durationSteps <= 2\) return;/,
      'a blob too short to halve is not split');
    assert.match(code, /const half = Math\.floor\(target\.durationSteps \/ 2\);/,
      'the split still halves the duration');
    assert.match(code, /startStep: target\.startStep \+ half,/, 'the second half still starts after the first');
    assert.match(code, /durationSteps: target\.durationSteps - half/, 'the split still conserves the total length');
    assert.match(code, /setBlobs\(blobs\.map\(b => b\.id === blobId \? blobA : b\)\.concat\(blobB\)\);/,
      'the split still appends the second region');
    assert.match(code, /const \[pitchQuantizeAmount, setPitchQuantizeAmount\] = useState<number>\(100\);/,
      'the quantize amount state is unchanged');
  });

  it('names the icon-only toast dismiss control and keeps it at AA on the toast fill', () => {
    includes(code, 'aria-label="Dismiss status message"', 'the toast dismiss control is named');
    // The \u2715 is text, so it needs 4.5:1 on the success fill. A washed idle
    // glyph (78% of the on-colour) measures 4.24:1 in Light; full opacity
    // measures 10.73:1 Dark and 5.85:1 Light. This matches the convention
    // WavetableSynthModal and AudioSlicerModal already ship.
    includes(
      code,
      'className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]"',
      'the toast dismiss glyph is the full on-colour in both states',
    );
    assert.doesNotMatch(
      code,
      /color-mix\(in_srgb,var\(--apex-state-playing-fg\)_\d+%,transparent\)/,
      'the on-colour is never washed below AA',
    );
  });

  it('keeps the NOT-APPLIED banner qualifier at AA on the gold wash', () => {
    // --apex-text-3 measures 4.17:1 in Dark on the 14% gold wash; -2 measures
    // 6.11:1 Dark and 6.51:1 Light.
    includes(
      code,
      'text-[10px] text-[var(--apex-text-2)] whitespace-nowrap">SAMPLE BLOBS ONLY',
      'the banner qualifier uses the AA text scale',
    );
    includes(
      code,
      'font-mono font-bold text-[var(--apex-text)] uppercase tracking-wider',
      'the NOT-APPLIED statement itself uses the strongest text token',
    );
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim replaces the dead black fill',
    );
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(PolyphonicEditorModal, { isOpen: false, onClose: noop }),
    );
    assert.equal(closed, '');
  });
});
