/**
 * UI-03O — Studio telemetry modal theme contract.
 *
 * `AnalyticsModal` is DOM-rendered with no canvas, so every surface follows the
 * active palette through the existing `--apex-*` tokens. Three colour families
 * are deliberately treated differently:
 *
 *   - **Chrome** (panel, header band, stat cards, the details card, borders,
 *     hover, close) resolves through semantic tokens.
 *   - **Metric identity** (identity tile, tile glyph, the two numeric read-outs,
 *     the clock inset) stays on `--apex-accent`, which is the token the UI-1C
 *     compatibility layer already resolved these `#ff6e00` literals to, so the
 *     rendered identity hue is unchanged.
 *   - **Status is semantic and honest**: the FLOW STATE badge is
 *     `--apex-success`, and the offline-backup row's tone is `--apex-danger` for
 *     a failed save or an unreadable store, `--apex-text-3` while the real
 *     records are still being read, and `--apex-success` only for real records.
 *     `text-[#ff6b6b]` was never covered by the compatibility layer, so the
 *     failure row previously painted a raw near-white red (#ff6b6b on white is
 *     2.78:1) in Light; that branch now follows the theme.
 *
 * The Phase 68 F4 truthfulness contract (recorded session time, project-owned
 * version, and the exhaustive `describeOfflineBackupStatus` state matrix) is owned
 * by `phase68.projectStatisticsTruthfulness.test.tsx`; this file pins the
 * presentation contract and the tone mapping those states render through.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalyticsModal } from './AnalyticsModal';
import { createDefaultProjectState } from '../state/projectState';

const source = readFileSync('src/components/AnalyticsModal.tsx', 'utf8');

const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const noop = (): void => {};

const project = createDefaultProjectState();

const render = (
  mode: 'dark' | 'light',
  overrides: {
    isOpen?: boolean;
    saveError?: string | null;
    totalEditTimeSeconds?: number;
  } = {}
): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(AnalyticsModal, {
        isOpen: overrides.isOpen ?? true,
        onClose: noop,
        meta: {
          ...project.meta,
          totalEditTimeSeconds: overrides.totalEditTimeSeconds ?? 0
        },
        channels: project.channels,
        clips: project.playlistClips,
        saveError: overrides.saveError
      })
    )
  );

const classAttributes = (markup: string): string[] => [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const includes = (haystack: string, needle: string, message: string): void => assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Studio telemetry modal theme markup (UI-03O)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the metrics panel with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="analytics-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="analytics-modal-title"', 'the dialog is named by its title');
      includes(markup, 'STUDIO TELEMETRY &amp; PRODUCTION METRICS', 'the title text is unchanged');
      includes(markup, 'Time Tracking, Arranger Density &amp; Performance Stats', 'the subtitle is unchanged');
      includes(markup, 'aria-label="Close analytics"', 'the close control keeps its accessible name');
      includes(markup, 'Recorded Studio Session Time', 'the stopwatch banner label is unchanged');
      includes(markup, 'Not recorded', 'an unmeasured metric still says so');
      includes(markup, 'FLOW STATE', 'the status badge still renders');
      includes(markup, 'Total Notes', 'the note stat renders');
      includes(markup, 'Active Channels', 'the channel stat renders');
      includes(markup, 'Arranged Clips', 'the clip stat renders');
      includes(markup, 'Project BPM', 'the tempo stat renders');
      includes(markup, 'Project ID:', 'the project id row renders');
      includes(markup, 'Project Format Version:', 'the version row renders');
      includes(markup, 'Offline Backup Status:', 'the backup row renders');
      includes(markup, 'Checking offline backups', 'the row states what it is actually doing');
      assert.match(markup, new RegExp(`>${project.meta.bpm}<|>${project.meta.bpm}\\s*<`), 'the shipped tempo is rendered');
    });
  }

  it('renders a persisted session time exactly, without a themed regression', () => {
    const markup = render('light', { totalEditTimeSeconds: 3840 });
    includes(markup, '01:04:00', 'the persisted value is what the user sees');
    assert.doesNotMatch(markup, /Not recorded/, 'a measured value is not marked unrecorded');
  });

  it('carries no fixed chrome palette in any rendered state of either theme', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const state of [render(mode), render(mode, { totalEditTimeSeconds: 3840 }), render(mode, { saveError: 'Quota exceeded' })]) {
        const offenders = classAttributes(state).filter((value) => UNTHEMED_CLASS.test(value));
        assert.deepEqual(offenders, [], `${mode} renders an unthemed class`);
      }
    }
  });

  it('uses existing semantic tokens for surfaces, text, borders and hover', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-panel-header',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover'
    ]) {
      assert.ok(source.includes(`var(${token})`), `analytics chrome consumes ${token}`);
    }
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('keeps the metric identity and the FLOW STATE status meaning', () => {
    assert.match(source, /text-\[var\(--apex-accent\)\]/, 'the identity glyph and numeric read-outs keep the accent');
    assert.match(source, /bg-\[color-mix\(in_srgb,var\(--apex-accent\)_16%,transparent\)\]/, 'the identity tile and clock inset keep an accent wash');
    assert.match(source, /border-\[color-mix\(in_srgb,var\(--apex-accent\)_48%,transparent\)\]/, 'the identity tile and clock inset keep an accent edge');
    // Measured in Chromium: success-on-success-wash is 4.32:1 in Light (Dark
    // clears it at 6.11:1), below the AA floor for the 10px bold label. The wash and border carry the green
    // meaning; the label uses the primary text token (UI-03L precedent).
    assert.match(source, /bg-\[color-mix\(in_srgb,var\(--apex-success\)_16%,transparent\)\]/, 'the badge keeps a success wash instead of the raw neon literal');
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-success\)_16%,transparent\)\] px-2 py-0\.5 rounded border/,
      'the badge keeps its success wash and border',
    );
    assert.match(source, /border-\[color-mix\(in_srgb,var\(--apex-success\)_48%,transparent\)\]/, 'the badge keeps its success edge');
    assert.match(source, /text-\[var\(--apex-text\)\] font-bold/, 'the badge label follows the primary text token');
  });

  it('maps every offline-backup tone branch onto a semantic token', () => {
    const toneBlock = code.slice(code.indexOf('const backupTone'), code.indexOf('return (', code.indexOf('const backupTone')));
    assert.ok(toneBlock.includes('text-[var(--apex-danger)]'), 'a failed or unreadable store is the danger tone');
    assert.ok(toneBlock.includes('text-[var(--apex-text-3)]'), 'the loading state is the muted tone');
    assert.ok(toneBlock.includes('text-[var(--apex-success)]'), 'real records are the success tone');
    assert.doesNotMatch(code, /ff6b6b/, 'the unmapped near-white red is gone');
    assert.match(render('light', { saveError: 'Quota exceeded' }), /text-\[var\(--apex-danger\)\]/, 'a real save failure renders through the danger token');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    assert.match(
      render('light'),
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-sm z-50 flex items-center justify-center p-4"/,
      'the shared themed scrim replaces the dead bg-black/85 fill'
    );
  });

  it('keeps the observable backup state machine and the open guard intact', () => {
    assert.match(code, /if \(!isOpen\) return null;/, 'the open guard is untouched');
    assert.match(code, /listProjectBackups\(\)/, 'the modal still reads the real backup records');
    assert.match(code, /const backupStatus = describeOfflineBackupStatus\(backupState\);/, 'the row still prints the observable state');
    assert.match(code, /\bsaveError\b\s*\n?\s*\};/, 'a failed write still reaches the row through the backup state');
    assert.doesNotMatch(code, /1840/, 'the fabricated stopwatch fallback must not return');
    assert.doesNotMatch(code, /Low-Latency Core/, 'the hard-coded engine claim must not return');
  });

  it('renders nothing while closed', () => {
    assert.equal(render('dark', { isOpen: false }), '<div data-theme="dark"></div>');
  });
});
