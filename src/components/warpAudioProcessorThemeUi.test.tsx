/**
 * UI-03N — Warp Audio Processor theme contract.
 *
 * `WarpAudioProcessorModal` is DOM-rendered with no canvas, so every chrome
 * surface follows the active palette through the existing `--apex-*` tokens;
 * no palette seam or theme observer is required.
 *
 * Three colour families are deliberately treated differently:
 *
 *   - **Chrome** (panel, header/footer bands, target card, control insets,
 *     banners, borders, hover, the secondary Cancel button) resolves through
 *     semantic tokens.
 *   - **Identity and read-out colours are the modal's audio-state vocabulary**:
 *     the green processor identity stays on `--apex-success` (tile, panel
 *     edge, target read-out, behaviour summary, pitch read-out, primary CTAs,
 *     toast), the playback-rate read-out keeps cyan on `--apex-cyan-text`,
 *     and the NOTHING-SELECTED / NO-CLIP / LENGTH-NOT-PRESERVED qualifiers
 *     keep their warning amber on `--apex-gold`.
 *   - **The auditioning-state fill** moves from a fixed `bg-white` to
 *     `--apex-text` with `--apex-state-playing-fg` on-colour: the same
 *     high-contrast "preview is running" reading in both palettes, instead of
 *     a white fill that would stay white in Light.
 *
 * Warp target resolution (`resolveWarpTarget`, `isWarpTargetReady`,
 * `warpTargetMessage`, `WARP_BEHAVIOUR_SUMMARY`, `STRETCH_BEHAVIOUR_SUMMARY`)
 * is owned by `src/components/warpClipTarget.ts` and its suites; this file
 * pins the presentation contract plus the wiring the modal itself owns, across
 * all three target states (ready, no-selection, unsupported-type).
 *
 * Phase 7A truth-contract evolution: this suite used to pin the modal's
 * honest *incapability* statements ('PITCH AND RATE ONLY — LENGTH IS NOT
 * PRESERVED', 'NO LENGTH-PRESERVING STRETCH') and forbade any stretch
 * wording, because no length-preserving stretch existed. That capability has
 * now shipped (WSOLA render/commit, proven by src/audio/wsolaTimeStretch and
 * warpTimeStretchCommit suites), so those pins are replaced by equally strict
 * pins of the NEW truth: the banner states what each processor really does,
 * the stretch section names its algorithm (WSOLA) and supported range
 * (0.25×–4.00×), the commit publishes only a committed clip, and the code
 * still may not claim technologies that are not implemented (élastique-style
 * proprietary algorithms, formant processing, transient preservation,
 * granular synthesis, phase vocoder).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WarpAudioProcessorModal } from './WarpAudioProcessorModal';
import { STRETCH_BEHAVIOUR_SUMMARY, WARP_BEHAVIOUR_SUMMARY } from './warpClipTarget';
import type { PlaylistClip } from '../types/daw';

const source = readFileSync('src/components/WarpAudioProcessorModal.tsx', 'utf8');

/**
 * Source with comments stripped. Literal assertions run against this, so prose
 * *about* a legacy literal (this migration's own explanatory comment names the
 * dead black scrim) can neither satisfy nor trip them.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const noop = (): void => {};

/** Every class string in the source, including the ternary branches that the
    first render never paints (auditioning fill, ready target read-out). */
const sourceClassNames = (text: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(/className=(?:\"([^\"]*)\"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  // The ternary branches inside a template className are covered by the raw
  // string above; the single-quoted literals inside them are matched too.
  for (const match of text.matchAll(/'([^']*(?:bg|text|border|ring|accent)-\[[^']*)'/g)) {
    out.push(match[1]);
  }
  return out;
};

/** Any colour that cannot follow the theme: a literal, a fixed palette
    utility, or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const readyClip: PlaylistClip = {
  id: 'clip-warp',
  trackIndex: 2,
  startBar: 4,
  lengthBars: 2,
  type: 'audio',
  color: '#00ff88',
  name: 'Bass Drop',
  audioBufferId: 'buf-111111111111',
  pitchShiftSemitones: 3,
  timeStretchRate: 1.5,
};

const patternClip: PlaylistClip = {
  id: 'clip-pattern',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  channelId: 'ch-kick',
  color: '#ff5722',
  name: 'Kick Pattern',
};

interface RenderOverrides {
  clips?: PlaylistClip[];
  selectedClipId?: string | null;
  isOpen?: boolean;
  /** Phase 7B: the authoritative project tempo the App feeds the modal. */
  projectBpm?: number;
  /** Phase 7C: the authoritative project meter the App feeds the modal. */
  timeSignature?: [number, number];
}

const render = (mode: 'dark' | 'light', overrides: RenderOverrides = {}): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(WarpAudioProcessorModal, {
        isOpen: overrides.isOpen ?? true,
        onClose: noop,
        clips: overrides.clips ?? [],
        selectedClipId: overrides.selectedClipId ?? null,
        onUpdateClip: noop,
        projectBpm: overrides.projectBpm ?? 120,
        timeSignature: overrides.timeSignature ?? [4, 4],
      }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** The class string carries `disabled:opacity-40`, so disabled-ness must be
    read from the boolean attribute (`disabled=""`), not a substring. */
const hasDisabledAttr = (tag: string): boolean => /(^|\s)disabled(=""|\s|>)/.test(tag);

const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Warp Audio Processor theme markup (UI-03N)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the no-selection state with semantic theme classes in ${mode}`, () => {
      const markup = render(mode, { clips: [readyClip], selectedClipId: null });
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-warp-processor-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-warp-processor-modal-title"', 'the dialog is named by its title');
      includes(markup, 'AUDIO CLIP PITCH &amp; PLAYBACK RATE', 'the title text is unchanged');
      includes(markup, '>REPITCH — LENGTH NOT PRESERVED<', 'the repitch qualifier badge renders');
      includes(markup, '>WSOLA — PITCH-PRESERVING STRETCH<', 'the shipped-stretch qualifier badge renders');
      includes(markup, '>No audio clip selected<', 'the no-selection subtitle renders');
      includes(markup, 'aria-label="Close warp processor"', 'the close control keeps its accessible name');
      includes(markup, '>Preview Clip<', 'the preview action renders');
      includes(markup, '>NOTHING SELECTED<', 'the target read-out reports the empty selection');
      includes(markup, '>NO AUDIO CLIP TO WARP<', 'the blocker banner renders');
      includes(markup, 'REPITCH CHANGES PITCH AND LENGTH TOGETHER — WSOLA STRETCH PRESERVES PITCH', 'the behaviour banner states both shipped truths');
      includes(markup, '>STRETCH COMMITS A NEW AUDIO ASSET · ORIGINAL KEPT FOR UNDO<', 'the banner qualifier states the commit semantics');
      includes(markup, 'Applies to live playback and WAV export', 'the footer note is unchanged');
      includes(markup, '>Cancel<', 'the cancel action renders');
      includes(markup, '>Apply to Clip<', 'the apply action renders');
      includes(markup, '>Render &amp; Commit Stretch<', 'the stretch commit action renders');
      includes(markup, 'SUPPORTED 0.25×–4.00×', 'the stretch section states its supported ratio range');
      // Phase 7B: Fit to Project Tempo renders inside the stretch card, driven
      // by the authoritative projectBpm prop, disabled without a target.
      includes(markup, '>FIT TO PROJECT TEMPO<', 'the fit-to-tempo workflow renders');
      includes(markup, 'ratio = source BPM ÷ project BPM', 'the fit formula is stated openly');
      includes(markup, '>SOURCE BPM<', 'the source tempo field is labelled');
      includes(markup, 'id="fl-warp-fit-source-bpm"', 'the source tempo input has a stable id');
      includes(markup, '>120.00 BPM<', 'the target tempo read-out renders the projectBpm prop value');
      includes(markup, '>ENTER SOURCE BPM TO PREVIEW THE FIT<', 'the fit preview starts in its honest empty state');
      includes(markup, '>Render &amp; Commit Fit<', 'the fit commit action renders');
      includes(markup, 'No beat detection is performed', 'the fit panel never claims automatic detection');
      includes(markup, 'does not reprocess', 'the fit panel states the stretch is baked into the new asset');
      includes(markup, 'smear transients', 'the fit panel keeps the WSOLA transient-smearing limitation honest');
      const fitInput = markup.match(/<input[^>]*id="fl-warp-fit-source-bpm"[^>]*>/);
      assert.ok(fitInput, 'the fit source-BPM input renders');
      assert.ok(fitInput![0].includes('type="number"'), 'the source tempo is a numeric field');
      assert.ok(hasDisabledAttr(fitInput![0]), 'the fit input is disabled without a target');
      const fitButton = markup.match(/<button[^>]*>(?:(?!<button)[\s\S])*?Render &amp; Commit Fit[\s\S]*?<\/button>/);
      assert.ok(fitButton, 'the fit commit button renders');
      assert.ok(hasDisabledAttr(fitButton![0]), 'the fit commit button is disabled without a target');

      // No actionable target: the banner carries the module message and all
      // three sliders plus the primary actions are disabled.
      includes(markup, 'Select an audio clip in the Playlist Arranger first', 'the blocker message comes from warpClipTarget');
      const ranges = [...markup.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0]);
      assert.equal(ranges.length, 3, 'the pitch, rate and stretch-ratio sliders render');
      assert.ok(hasDisabledAttr(ranges[0]), 'the pitch slider is disabled without a target');
      assert.ok(hasDisabledAttr(ranges[1]), 'the rate slider is disabled without a target');
      assert.ok(hasDisabledAttr(ranges[2]), 'the stretch-ratio slider is disabled without a target');
      assert.ok(ranges[0].includes('min="-24"') && ranges[0].includes('max="24"'), 'the pitch range is unchanged');
      assert.ok(ranges[1].includes('min="0.25"') && ranges[1].includes('max="3.0"') && ranges[1].includes('step="0.05"'), 'the rate range is unchanged');
      assert.ok(ranges[2].includes('min="0.25"') && ranges[2].includes('max="4.0"') && ranges[2].includes('step="0.01"'), 'the stretch ratio is bounded to the supported WSOLA range');
      includes(markup, '>0 st<', 'the pitch read-out reports the default');
      includes(markup, '>1.00x<', 'the rate read-out reports the default');
      includes(markup, '>1.00×<', 'the stretch-ratio read-out reports the default');
    });

    it(`renders the ready-target state with the stored values in ${mode}`, () => {
      const markup = render(mode, { clips: [readyClip], selectedClipId: 'clip-warp' });
      includes(markup, 'Editing &quot;Bass Drop&quot;', 'the subtitle names the selected clip');
      includes(markup, 'Bass Drop · bar 4 · 2 bars', 'the target read-out reports name, bar and length');
      assert.ok(!markup.includes('NOTHING SELECTED'), 'the empty-selection read-out is gone');
      assert.ok(!markup.includes('NO AUDIO CLIP TO WARP'), 'the blocker banner is gone');
      includes(markup, '>+3 st<', 'the pitch read-out shows the stored semitone offset');
      includes(markup, '>1.50x<', 'the rate read-out shows the stored stretch rate');
      const ranges = [...markup.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0]);
      assert.ok(!hasDisabledAttr(ranges[0]), 'the pitch slider is enabled for an audio clip');
      assert.ok(!hasDisabledAttr(ranges[1]), 'the rate slider is enabled for an audio clip');
      assert.ok(!hasDisabledAttr(ranges[2]), 'the stretch-ratio slider is enabled for an audio clip');
      // The plan read-out shows the exact consequence BEFORE any commit: at the
      // default 1.00× a 2-bar clip stays 2 bars. (No engine buffer exists in
      // this render, so the read-out honestly omits the audio-duration part.)
      includes(markup, '1.00× · 2 → 2 bars', 'the stretch plan states ratio and resulting bar length up front');
      includes(markup, STRETCH_BEHAVIOUR_SUMMARY, 'the stretch summary renders verbatim from the shared module');
      // Phase 7B: the fit target tempo renders exactly the authoritative prop —
      // no duplicated, stale or engine-side BPM setting inside the modal.
      includes(markup, '>120.00 BPM<', 'the fit target renders the projectBpm prop (120)');
      const retuned = render(mode, { clips: [readyClip], selectedClipId: 'clip-warp', projectBpm: 140 });
      includes(retuned, '>140.00 BPM<', 'a different authoritative tempo renders verbatim');
      assert.ok(!retuned.includes('>120.00 BPM<'), 'the modal keeps no stale BPM of its own');
    });

    it(`renders the unsupported-type state for a pattern clip in ${mode}`, () => {
      const markup = render(mode, { clips: [patternClip], selectedClipId: 'clip-pattern' });
      // An un-actionable target has no `targetClip`, so the subtitle falls
      // back to the no-selection wording; the clip name appears in the
      // blocker message instead.
      includes(markup, '>No audio clip selected<', 'the subtitle reports no actionable target');
      includes(markup, 'NOTHING SELECTED', 'an un-actionable target reports nothing selected');
      includes(markup, 'NO AUDIO CLIP TO WARP', 'the blocker banner renders for a pattern clip');
      includes(
        markup,
        'is a pattern clip. Pitch and playback-rate warping is applied to audio clips only',
        'the blocker message explains why the pattern clip is un-actionable',
      );
      const ranges = [...markup.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0]);
      assert.ok(
        hasDisabledAttr(ranges[0]) && hasDisabledAttr(ranges[1]) && hasDisabledAttr(ranges[2]),
        'all sliders stay disabled for a pattern clip'
      );
      const fitInput = markup.match(/<input[^>]*id="fl-warp-fit-source-bpm"[^>]*>/);
      assert.ok(fitInput && hasDisabledAttr(fitInput[0]), 'the fit source-BPM input stays disabled for a pattern clip');
      const fitButton = markup.match(/<button[^>]*>(?:(?!<button)[\s\S])*?Render &amp; Commit Fit[\s\S]*?<\/button>/);
      assert.ok(fitButton && hasDisabledAttr(fitButton[0]), 'the fit commit stays disabled for a pattern clip');
    });
  }

  it('carries no fixed chrome palette in any rendered state of either theme', () => {
    const states: ReadonlyArray<[string, RenderOverrides]> = [
      ['no-selection', { clips: [readyClip], selectedClipId: null }],
      ['ready', { clips: [readyClip], selectedClipId: 'clip-warp' }],
      ['unsupported-type', { clips: [patternClip], selectedClipId: 'clip-pattern' }],
    ];
    for (const mode of ['dark', 'light'] as const) {
      for (const [label, overrides] of states) {
        const offenders = classAttributes(render(mode, overrides)).filter((value) => UNTHEMED_CLASS.test(value));
        assert.deepEqual(offenders, [], `${mode} ${label} renders an unthemed class`);
      }
    }
  });

  it('carries no fixed palette in any className in the source, including the auditioning branch', () => {
    const names = sourceClassNames(code);
    assert.ok(names.length > 12, `expected the full class surface, found ${names.length}`);
    const offenders = names.filter((value) => UNTHEMED_CLASS.test(value));
    assert.deepEqual(offenders, [], 'a className in the source still carries a fixed palette');
    assert.doesNotMatch(code, /rgba?\(/, 'no rgb()/rgba() literal remains in the component code');
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('keeps the green identity, the cyan rate read-out and the gold qualifiers', () => {
    assert.match(source, /bg-\[var\(--apex-success\)\]/, 'the identity tile and primary CTAs use the success token');
    assert.match(
      source,
      /border-\[color-mix\(in_srgb,var\(--apex-success\)_40%,transparent\)\]/,
      'the panel edge keeps a success wash',
    );
    assert.match(source, /text-\[var\(--apex-success\)\]/, 'the target read-out, behaviour summary and pitch read-out keep their green meaning');
    assert.match(source, /text-\[var\(--apex-cyan-text\)\]/, 'the playback-rate read-out keeps its cyan meaning');
    assert.match(source, /text-\[var\(--apex-gold\)\]/, 'the selection and blocker qualifiers keep their amber warning meaning');
    assert.match(
      source,
      /border-\[color-mix\(in_srgb,var\(--apex-gold\)_40%,transparent\)\]/,
      'the warning banners keep a gold edge',
    );
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-gold\)_20%,transparent\)\]/,
      'the repitch badge keeps a gold wash',
    );
    assert.match(source, /var\(--apex-state-playing-fg\)/, 'filled controls use a theme-safe on-colour');
    assert.match(
      source,
      /hover:bg-\[color-mix\(in_srgb,var\(--apex-success\)_82%,var\(--apex-text\)\)\]/,
      'the green CTAs keep a themed hover step',
    );
    assert.match(
      source,
      /isAuditioning \? 'bg-\[var\(--apex-text\)\]' : 'bg-\[var\(--apex-success\)\] hover:bg-\[color-mix\(in_srgb,var\(--apex-success\)_82%,var\(--apex-text\)\)\]'/,
      'the auditioning state swaps to a theme-aware fill instead of fixed white',
    );
    assert.match(
      source,
      /bg-\[var\(--apex-surface-3\)\] hover:bg-\[color-mix\(in_srgb,var\(--apex-surface-3\)_85%,var\(--apex-text\)\)\] text-\[var\(--apex-text\)\]/,
      'the secondary Cancel button uses a themed surface step',
    );
  });

  it('uses existing semantic tokens for surfaces, text and borders', () => {
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
      '--apex-state-hover',
      '--apex-state-playing-fg',
    ]) {
      assert.ok(source.includes(`var(${token})`), `warp processor chrome consumes ${token}`);
    }
  });

  it('keeps the real-buffer audition path and the apply payload intact', () => {
    assert.match(
      code,
      /if \(!targetClip\?\.audioBufferId\) \{\s*setStatusMessage\('This clip has no loaded audio to audition\.'\);/,
      'an audio-less clip still gets the no-audio message',
    );
    assert.match(code, /const buffer = audioEngine\.getSampleBuffer\(targetClip\.audioBufferId\);/, 'the audition reads the clip’s real buffer');
    assert.match(
      code,
      /source\.playbackRate\.value = stretchRate;\s*source\.detune\.value = pitchSemitones \* 100;/,
      'the audition applies the shown rate and pitch to the buffer source',
    );
    assert.match(
      code,
      /const previewSeconds = Math\.min\(buffer\.duration \/ Math\.max\(0\.05, stretchRate\), 4\);/,
      'the audition keeps its 4 second ceiling',
    );
    assert.match(
      code,
      /onUpdateClip\(\{\s*\.\.\.targetClip,\s*pitchShiftSemitones: pitchSemitones,\s*timeStretchRate: stretchRate\s*\}\);/,
      'apply publishes exactly the two warp fields over the stored clip',
    );
    assert.match(
      code,
      /setStatusMessage\(`Applied pitch \$\{pitchSemitones > 0 \? '\+' : ''\}\$\{pitchSemitones\} st and \$\{stretchRate\.toFixed\(2\)\}x rate to "\$\{targetClip\.name\}"\.`\);/,
      'the apply toast keeps its exact wording',
    );
    assert.match(
      code,
      /setPitchSemitones\(targetClip\?\.pitchShiftSemitones \?\? 0\);\s*setStretchRate\(targetClip\?\.timeStretchRate \?\? 1\.0\);/,
      'the controls re-seed from the target clip when the modal opens',
    );
    assert.match(code, /setStatusMessage\('Previewing the clip’s own audio at the pitch and rate above \(mixer inserts bypassed\).'\);/, 'the preview toast keeps its exact wording');
  });

  it('states repitch truth and the shipped WSOLA stretch truth — and claims no unimplemented technology', () => {
    assert.match(source, /REPITCH|playback rate|playback-rate/i, 'the repitch wording survives');
    // The stretch capability is real now, so the claim pins flip: the code MUST
    // name the algorithm that is actually implemented (WSOLA) and MUST NOT name
    // technologies that are not (proprietary élastique-style algorithms,
    // formant processing, transient preservation, granular synthesis, phase
    // vocoder). This replaces the old blanket no-stretch-wording guard.
    assert.match(code, /WSOLA/, 'the stretch section names the implemented algorithm');
    assert.doesNotMatch(
      code,
      /elastique|élastique|formant|granular|transient preserv|phase vocoder/i,
      'no unimplemented warp technology is claimed'
    );
    assert.match(code, /WARP_BEHAVIOUR_SUMMARY/, 'the repitch behaviour summary is read from the shared module');
    assert.match(code, /STRETCH_BEHAVIOUR_SUMMARY/, 'the stretch behaviour summary is read from the shared module');
    // Commit wiring honesty: the real pipeline is invoked, its typed errors are
    // surfaced, and only a committed clip is published — never a fake success.
    // Phase 7B: both the manual ratio and the fit workflow route through ONE
    // shared commit helper, so both carry identical guarantees.
    assert.match(code, /commitWarpTimeStretch\(targetClip, ratio,/, 'the shared commit helper calls the tested render/commit pipeline');
    assert.match(code, /commitWsolaRender\(wsolaRatio, 'stretch'/, 'the manual ratio button routes through the shared helper');
    assert.match(code, /commitWsolaRender\(\s*fitRatio,/, 'the fit-to-tempo button routes through the same shared helper');
    assert.match(code, /onUpdateClip\(result\.clip\);/, 'only the committed clip is published');
    assert.match(code, /error instanceof WarpTimeStretchError/, 'typed pipeline failures are surfaced honestly');
    assert.match(code, /waitForSampleBufferPersistence/, 'the commit waits for asset durability before publishing');
    assert.match(code, /hydrateAudioClip/, 'an out-of-memory source is recovered through the persisted-asset hydration path');
    const readyMarkup = render('light', { clips: [readyClip], selectedClipId: 'clip-warp' });
    includes(readyMarkup, WARP_BEHAVIOUR_SUMMARY, 'the repitch summary text renders verbatim');
    includes(readyMarkup, STRETCH_BEHAVIOUR_SUMMARY, 'the stretch summary text renders verbatim');
  });

  it('Phase 7B: fit-to-tempo states the user-entered-source truth and reads the target from authoritative state', () => {
    // The fit uses the tested pure computation with the prop-fed project BPM —
    // never an engine-side or locally duplicated tempo.
    assert.match(code, /computeFitToTempoRatio\(sourceBpmText, projectBpm\)/, 'the fit ratio comes from the tested computation on the authoritative prop');
    assert.match(code, /projectBpm: number;/, 'the modal requires the project tempo as a prop');
    // No automatic-detection claim may exist; the disclaimer must.
    assert.match(code, /No beat detection is performed/, 'the no-detection disclaimer is required text');
    assert.doesNotMatch(code, /automatically detect|auto-?detect|detects the tempo|detects the BPM/i, 'no automatic BPM-detection claim');
    // The bake-into-asset truth: later tempo changes do not reprocess the asset.
    assert.match(code, /changing the project tempo later does not reprocess it/i, 'the baked-asset semantics are stated');
    // The App must feed the modal the authoritative project tempo.
    const appSource = readFileSync('src/App.tsx', 'utf8');
    assert.match(
      appSource,
      /<WarpAudioProcessorModal[\s\S]{0,400}?projectBpm=\{projectState\.meta\.bpm\}/,
      'the App wires projectBpm from the authoritative project state'
    );
    // Duplicate-commit protection: both commit entry points guard on the
    // in-flight flag before doing any work.
    assert.match(code, /const handleCommitFitToTempo = \(\) => \{\s*if \(!targetClip \|\| !onUpdateClip \|\| isCommittingStretch\) return;/, 'the fit handler refuses while a commit is in flight');
    assert.match(code, /const commitWsolaRender = async \(ratio: number, operation: string, successLabel: string\) => \{\s*if \(!targetClip \|\| !onUpdateClip \|\| isCommittingStretch\) return;/, 'the shared commit helper refuses while a commit is in flight');
  });

  it('Phase 7C: fit-to-length reads tempo AND meter from authoritative state and commits through the tested exact-length pipeline', () => {
    // The dedicated pipeline is invoked with the authoritative context — never
    // a locally invented tempo, meter or ratio.
    assert.match(code, /commitWarpTimeStretchToLength\(targetClip, fitTarget, fitCtx,/, 'the length fit calls the tested exact-length pipeline');
    assert.match(code, /timeSignature: unknown;/, 'the modal requires the project meter as a prop');
    assert.match(code, /const fitCtx: FitToLengthContext = \{ bpm: projectBpm, timeSignature \};/, 'the fit context is built ONLY from the authoritative props');
    assert.match(code, /resolveProjectTimeSignature\(\{ timeSignature \}\)/, 'the displayed meter resolves through the single runtime authority');
    // Preview and commit share the tested pure computation — they cannot disagree.
    assert.match(code, /describeFitToLengthPlan\(targetClip, fitTarget, fitCtx, buffer\.duration\)/, 'the ready preview comes from the same plan computation the commit uses');
    assert.match(code, /describeFitToLengthTarget\(fitTarget, fitCtx\)/, 'the destination preview comes from the tested resolver');
    // No duplicated editable tempo/meter settings: the project grid is a
    // read-out span and the only inputs in the panel are the target length.
    assert.match(code, /<span id="fl-warp-fit-length-project-grid"/, 'the authoritative tempo+meter render as a read-out, not an input');
    assert.doesNotMatch(code, /id="fl-warp-fit-length-(?:bpm|meter|time-signature)"/, 'no editable tempo or meter duplicates the project state');
    // The App must feed the modal the authoritative meter as well as the tempo.
    const appSource = readFileSync('src/App.tsx', 'utf8');
    assert.match(
      appSource,
      /<WarpAudioProcessorModal[\s\S]{0,500}?timeSignature=\{projectState\.meta\.timeSignature\}/,
      'the App wires timeSignature from the authoritative project state'
    );
    // Honesty: refusals are stated, ratios are never clamped, and success names
    // the exact committed length.
    assert.match(code, /refused honestly — never silently shifted/i, 'the refusal truth is stated');
    assert.match(code, /never\s+silently clamped/i, 'the no-clamping truth is stated');
    assert.match(code, /now occupies exactly \$\{formatBars\(result\.clip\.lengthBars\)\} bars/, 'the success message names the exact committed length');
    // Duplicate-commit protection on the third entry point.
    assert.match(code, /const handleCommitFitToLength = async \(\) => \{\s*if \(!targetClip \|\| !onUpdateClip \|\| isCommittingStretch\) return;/, 'the length-fit handler refuses while a commit is in flight');
    // The error branch of the preview renders the typed refusal inline.
    assert.match(code, /fitLengthPreview\.kind === 'error'/, 'invalid targets and refusals surface inline before any commit');
  });

  it('Phase 7C: the length-fit panel renders the meter-aware destination in both themes', () => {
    for (const mode of ['dark', 'light'] as const) {
      // A 4/4 project at 120 BPM.
      const m44 = render(mode, { clips: [readyClip], selectedClipId: 'clip-warp', projectBpm: 120, timeSignature: [4, 4] });
      includes(m44, 'FIT TO MUSICAL LENGTH', 'the operation is clearly and distinctly named');
      includes(m44, '120.00 BPM · 4/4', 'the authoritative grid renders as a read-out');
      includes(m44, 'beats stay below 4', 'the beat limit follows the meter, not a hardcoded 4/4');
      includes(m44, 'Render &amp; Commit Fit to Length', 'the commit CTA is labelled');
      assert.match(m44, /id="fl-warp-fit-length-bars"[^>]*type="number"/, 'the bars input renders');
      assert.match(m44, /id="fl-warp-fit-length-beats"[^>]*step="0\.25"/, 'the beats input renders with a practical quarter-beat step');
      assert.match(m44, /id="fl-warp-fit-length-commit"/, 'the commit button is browser-testable');
      // Without a resident buffer the preview is honest about where the ratio
      // will come from — never a fabricated number.
      includes(m44, 'the ratio is computed from the real source at commit time', 'the unloaded-source preview stays honest');

      // A 3/4 project at 90 BPM — the panel must follow the authoritative meter.
      const m34 = render(mode, { clips: [readyClip], selectedClipId: 'clip-warp', projectBpm: 90, timeSignature: [3, 4] });
      includes(m34, '90.00 BPM · 3/4', 'a non-4/4 project renders its real grid');
      includes(m34, 'beats stay below 3', 'the beat limit follows 3/4');
      includes(m34, 'one bar of 3/4', 'the bar reference follows 3/4');

      // An unsupported stored meter resolves to the same grid the runtime
      // plays — the transport’s resolution authority, never a silent guess.
      const m54 = render(mode, { clips: [readyClip], selectedClipId: 'clip-warp', projectBpm: 120, timeSignature: [5, 4] });
      includes(m54, '120.00 BPM · 4/4', 'an unsupported stored meter shows the resolved runtime grid');
    }
  });

  it('Phase 7D: the stretch strategy selector renders as an explicit, honest, themed choice with classic WSOLA as the default', () => {
    for (const mode of ['dark', 'light'] as const) {
      const markup = render(mode, { clips: [readyClip], selectedClipId: 'clip-warp' });
      // The selector exists as a labelled group with two stable-id buttons.
      includes(markup, 'role="group"', 'the strategy selector is a group');
      includes(markup, 'aria-label="Stretch strategy"', 'the group is accessibly named');
      includes(markup, 'id="fl-warp-stretch-strategy-wsola"', 'the classic strategy button has a stable id');
      includes(markup, 'id="fl-warp-stretch-strategy-transient"', 'the transient strategy button has a stable id');
      includes(markup, '>CLASSIC WSOLA<', 'the classic option renders');
      includes(markup, '>TRANSIENT-AWARE<', 'the transient option renders');
      // DEFAULT is classic WSOLA, pressed-state honest, and the note states
      // the classic limitations without claiming anything it does not do.
      includes(markup, 'id="fl-warp-stretch-strategy-wsola" type="button" aria-pressed="true"', 'classic is the default selection');
      includes(markup, 'id="fl-warp-stretch-strategy-transient" type="button" aria-pressed="false"', 'transient is not selected by default');
      includes(markup, 'id="fl-warp-stretch-strategy-note"', 'the strategy note renders');
      includes(markup, 'Classic WSOLA: best for tonal and sustained material', 'the default note describes the classic mode honestly');
      includes(markup, 'makes no transient-handling claim', 'the classic mode claims no transient handling');
    }
    // The transient-mode copy (rendered after the user switches) states the
    // measured improvement, the identical-render fallback and the edge
    // limitation — checked in source because static markup renders the
    // default state only.
    assert.match(code, /anchors detected attacks so drum\/percussion timing stays tight/i, 'the transient note states the measured improvement');
    assert.match(code, /renders identically to classic WSOLA/i, 'the no-attack fallback is stated honestly');
    assert.match(code, /keep classic treatment/i, 'the clip-edge limitation is stated honestly');
    // The strategy is an EXPLICIT user choice, never automatic, and flows
    // into every commit workflow through the tested pipeline parameter.
    assert.match(code, /const \[stretchStrategy, setStretchStrategy\] = useState<WarpStretchStrategy>\('wsola'\);/, 'the strategy is modal-internal state defaulting to wsola');
    assert.match(code, /\}, stretchStrategy\);/, 'the selected strategy is passed to the tested commit pipeline');
    assert.doesNotMatch(code, /auto(?:matically)?\s+(?:select|choose|switch)\w*\s+(?:the\s+)?(?:strategy|transient)/i, 'the strategy is never chosen automatically');
    // Themed chrome only: the selector buttons use semantic tokens.
    const selectorTag = code.match(/id="fl-warp-stretch-strategy-transient"[\s\S]{0,600}?className=\{`([^`]*)`\}/);
    assert.ok(selectorTag, 'the transient button carries a template className');
    assert.doesNotMatch(selectorTag[1], UNTHEMED_CLASS, 'the selector follows the theme');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light', { clips: [readyClip], selectedClipId: null });
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim replaces the dead bg-black/85 fill',
    );
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(WarpAudioProcessorModal, {
        isOpen: false,
        onClose: noop,
        clips: [readyClip],
        selectedClipId: 'clip-warp',
        onUpdateClip: noop,
        projectBpm: 120,
        timeSignature: [4, 4],
      }),
    );
    assert.equal(closed, '');
  });
});
