/**
 * UI-03G — Parametric EQ theme, asserted against the markup the real component
 * produces (`renderToStaticMarkup`, as in the UI-03B/C/D/E/F suites) and against
 * the component source where a branch is only reachable after interaction.
 *
 * 1. The dialog renders in full, including all three gain-sign branches.
 * 2. Class attributes carry no colour literal and no `text-white` / `text-black`
 *    / `bg-black` / Tailwind palette utility, so chrome follows the theme.
 * 3. The theme is expressed by CSS custom properties, not by the markup.
 * 4. The overlay is the shared scrim, supplied by ModalFrame.
 * 5. The canvas paints from the palette seam on every frame, so a theme flip is
 *    picked up without an observer, and the animation loop is still cancelled.
 * 6. The EQ behaviour this phase must not touch is still in the source.
 *
 * Contrast of the live text and the repaint on a real theme flip are proven in
 * browser-tests/parametricEqTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ParametricEqModal } from './ParametricEqModal';
import { EQ_BAND_SPECS, publishEqBandsToTrack } from './parametricEqBands';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { ParametricEqBand } from '../types/daw';

const noop = (): void => {};

const baseTrack = DEFAULT_PROJECT.mixerTracks[1];

/**
 * A track carrying a real EQ insert, built through the production publisher so
 * the fixture is exactly what the app hands the modal. The three bands span the
 * three gain signs (-2 dB, +3.5 dB, 0 dB) so every gain-colour branch renders.
 */
const trackWithEq = publishEqBandsToTrack(baseTrack, [
  { id: 1, type: 'lowshelf', frequency: 200, gain: -2, q: 0.9, enabled: true, color: EQ_BAND_SPECS[0].color },
  { id: 2, type: 'peaking', frequency: 2800, gain: 3.5, q: 1.5, enabled: true, color: EQ_BAND_SPECS[1].color },
  { id: 3, type: 'highshelf', frequency: 11000, gain: 0, q: 0.7, enabled: true, color: EQ_BAND_SPECS[2].color },
] as ParametricEqBand[]);

const render = (mixerTrack = trackWithEq) =>
  renderToStaticMarkup(
    React.createElement(ParametricEqModal, {
      isOpen: true,
      onClose: noop,
      mixerTrack,
      onUpdateTrack: noop,
    })
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);

const source = readFileSync('src/components/ParametricEqModal.tsx', 'utf8');

/** A colour literal, a white/black/alpha-black utility, or a Tailwind palette colour. */
const UNTHEMED =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring|fill)-\[#|\b(?:text|bg|border)-(?:white|black)\b|bg-black|rgba?\(|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/i;

describe('Parametric EQ theme markup (UI-03G)', () => {
  it('renders the full dialog', () => {
    const markup = render();
    assert.match(markup, /id="parametric-eq-modal-title"/);
    assert.match(markup, /3-Band EQ — Dynamic Equalizer/);
    assert.match(markup, /Studio Mastering Profiles:/);
    assert.match(markup, /Mastering-grade surgical frequency sculpting with live FFT spectrum response/);
    assert.match(markup, /Filter Type/);
    assert.match(markup, /Bandwidth \(Q\)/);
    assert.match(markup, /Reset to Flat Linear Response/);
    assert.match(markup, /Done/);
  });

  it('renders every preset and all three band cards from the published insert', () => {
    const markup = render();
    for (const preset of ['Vocal Clarity &amp; Air', '808 Sub Bass Sculpt', 'Master Bus Polish', 'Punchy Drum Bus']) {
      assert.ok(markup.includes(preset), `preset ${preset} renders`);
    }
    // The parameter panel edits one band at a time, and the modal opens with
    // band 2 selected, so only that band's filter type is named.
    assert.ok(markup.includes(EQ_BAND_SPECS[1].label), `${EQ_BAND_SPECS[1].label} renders for the selected band`);
    assert.ok(!markup.includes(EQ_BAND_SPECS[0].label), 'an unselected band\'s filter type is not shown');
    assert.match(markup, /Band 1/);
    assert.match(markup, /Band 2/);
    assert.match(markup, /Band 3/);
    // The published slot params are what the readouts show.
    assert.match(markup, /200 Hz/);
    assert.match(markup, /-2 dB/);
    assert.match(markup, /\+3\.5 dB/);
  });

  it('paints the three gain signs with the semantic success/danger pair', () => {
    const classes = classAttributes(render()).join(' ');
    assert.ok(classes.includes('text-[var(--apex-success)]'), 'positive gain uses --apex-success');
    assert.ok(classes.includes('text-[var(--apex-danger)]'), 'negative gain uses --apex-danger');
    assert.ok(classes.includes('text-[var(--apex-text-2)]'), 'a flat gain uses secondary text');
  });

  it('paints both band surfaces from the one display mapping, and never the raw stored colour', () => {
    // The canvas node and the band card's swatch must agree, so both go through
    // the seam's `bandFill`. Painting `b.color` directly on either surface would
    // let the node and its card disagree after a theme flip.
    assert.match(source, /ctx\.fillStyle = palette\.bandFill\(b\.color\)/, 'the canvas node reads the mapping');
    assert.match(source, /style=\{\{ backgroundColor: eqPalette\.bandFill\(b\.color\) \}\}/, 'the swatch reads the same mapping');
    assert.doesNotMatch(source, /ctx\.fillStyle = b\.color/, 'the node never paints the raw stored colour');
    assert.doesNotMatch(source, /backgroundColor: b\.color/, 'the swatch never paints the raw stored colour');
  });

  it('repaints the swatch when the theme flips, and disconnects the observer', () => {
    // The canvas re-reads the palette every frame, but a DOM swatch cannot, so
    // the modal subscribes to the theme attribute the settings switch writes.
    assert.match(source, /new MutationObserver\(\(\) => setThemeGeneration/, 'a theme mutation re-renders the modal');
    assert.match(source, /observer\.observe\(document\.documentElement, \{ attributeFilter: \['data-theme'\] \}\)/, 'it watches the theme attribute');
    assert.match(source, /return \(\) => observer\.disconnect\(\)/, 'the observer is cleaned up');
  });

  it('renders the swatches through the seam: with no document they fall back to the stored colours', () => {
    // renderToStaticMarkup has no document, so the seam takes its Dark fallback,
    // where the mapping is the identity — the markup must therefore carry the
    // stored band colours, proving the swatch value comes from the seam.
    const markup = render();
    for (const spec of EQ_BAND_SPECS) {
      assert.ok(
        markup.includes(`background-color:${spec.color}`) || markup.includes(`background-color: ${spec.color}`),
        `swatch renders ${spec.color} from the seam`
      );
    }
  });

  it('carries no colour literal or white/black/palette utility in any class attribute', () => {
    const offenders = classAttributes(render()).filter((cls) => UNTHEMED.test(cls));
    assert.deepEqual(offenders, [], 'class attributes must use semantic tokens only');
  });

  it('expresses theme colour through CSS custom properties', () => {
    const classes = classAttributes(render()).join(' ');
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-canvas',
      '--apex-panel-header',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-accent',
      '--apex-accent-strong',
      '--apex-state-playing-fg',
      '--apex-state-selected',
      '--apex-state-selected-border',
      '--apex-success',
      '--apex-danger',
    ]) {
      assert.ok(classes.includes(`var(${token})`), `chrome uses ${token}`);
    }
  });

  it('gives the primary action its on-accent label and a solid hover fill', () => {
    const done = /<button[^>]*>(?:(?!<\/button>).)*Done/s.exec(render())?.[0] ?? '';
    assert.ok(done.includes('bg-[var(--apex-accent)]'), 'Done uses the accent fill');
    assert.ok(done.includes('text-[var(--apex-state-playing-fg)]'), 'Done label uses the on-accent token');
    assert.ok(done.includes('hover:bg-[var(--apex-accent-strong)]'), 'Done hover uses the strong accent');
  });

  it('uses the shared scrim: the overlay class is supplied by ModalFrame, not by the modal', () => {
    const markup = render();
    assert.match(markup, /class="apex-modal-overlay fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in"/);
    assert.doesNotMatch(source, /bg-black\//, 'no hardcoded black scrim in the modal');
  });

  it('paints the canvas from the palette seam on every frame, and still cancels the loop', () => {
    assert.match(source, /import \{ readEqPalette \} from '\.\/parametricEqTheme'/);
    assert.match(source, /const palette = readEqPalette\(\)/, 'the palette is read in the frame callback');
    assert.match(source, /ctx\.fillStyle = palette\.canvasBackground/, 'background comes from the seam');
    assert.match(source, /ctx\.strokeStyle = palette\.gridLine/, 'the frequency grid comes from the seam');
    assert.match(source, /ctx\.fillStyle = palette\.axisLabel/, 'the axis labels come from the seam');
    assert.match(source, /ctx\.strokeStyle = db === 0 \? palette\.gridLineStrong : palette\.gridLine/, 'the 0 dB reference line comes from the seam');
    assert.match(source, /ctx\.fillStyle = graph\.spectrum/, 'the spectrum fill comes from the seam');
    assert.match(source, /ctx\.strokeStyle = graph\.curve/, 'the response curve comes from the seam');
    assert.match(source, /ctx\.strokeStyle = isSelected \? graph\.nodeOutlineSelected : graph\.nodeOutline/, 'the node rings come from the seam');
    assert.match(source, /ctx\.fillStyle = graph\.nodeLabel/, 'the node number comes from the seam');
    assert.match(source, /if \(animFrameRef\.current\) cancelAnimationFrame\(animFrameRef\.current\)/, 'the animation loop is cancelled on cleanup');
    // The canvas itself needs no observer: the per-frame read already follows
    // the theme. The one observer in the file exists for the DOM swatch, and is
    // asserted separately above.
    assert.equal(source.match(/new MutationObserver/g)?.length, 1, 'exactly one observer, and it serves the swatch');
  });

  it('contains no colour literal, white/black utility or palette utility in the component source', () => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'hex literals belong in parametricEqTheme.ts');
    assert.doesNotMatch(source, /rgba\(/, 'no literal rgba() paint strings');
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:white|black)\b/, 'no white/black utilities');
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/, 'no palette utilities');
  });

  it('leaves the EQ behaviour this phase must not touch in place', () => {
    // Coordinate mapping and the drag path are untouched.
    for (const helper of ['const freqToX', 'const xToFreq', 'const dbToY', 'const yToDb']) {
      assert.ok(source.includes(helper), `${helper} is unchanged`);
    }
    assert.match(source, /handleCanvasMouseDown/);
    assert.match(source, /handleCanvasMouseMove/);
    assert.match(source, /handleCanvasMouseUp/);
    assert.match(source, /if \(dist < 15\)/, 'the node hit-test radius is unchanged');
    // The publication path and the control ranges are unchanged.
    assert.match(source, /onUpdateTrack\(publishEqBandsToTrack\(mixerTrack, next\)\)/);
    assert.match(source, /min="20"\s+max="20000"/, 'frequency range');
    assert.match(source, /min="-18"\s+max="18"\s+step="0\.1"/, 'gain range');
    assert.match(source, /min="0\.1"\s+max="10"\s+step="0\.1"/, 'Q range');
    // Accessibility and the truthful feature copy.
    assert.match(render(), /aria-label="Close parametric EQ"/);
    assert.match(source, /Fixed by the insert's signal chain\./);
    assert.match(source, /The editor always shows the values the engine is actually using|readEqBandsFromTrack\(mixerTrack\)/);
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(ParametricEqModal, {
        isOpen: false,
        onClose: noop,
        mixerTrack: trackWithEq,
        onUpdateTrack: noop,
      })
    );
    assert.equal(closed, '');
  });

  it('renders the flat default for a track with no EQ insert', () => {
    const markup = render(DEFAULT_PROJECT.mixerTracks[1]);
    // No insert means the engine builds no EQ node, so the editor shows flat.
    assert.match(markup, /0 dB/);
    assert.match(markup, /120 Hz/);
    assert.match(markup, /1\.2k Hz/);
  });
});
