/**
 * UI-03P — Project ZIP Archive Bundler theme contract.
 *
 * `ProjectBundleZipModal` was the last modal still painted with the legacy
 * palette, and the largest remaining consumer of the UI-1C compatibility layer
 * in `index.css` (21 uses over 10 distinct mappings). It is DOM-rendered with no
 * canvas, so every surface now follows the active palette through the existing
 * `--apex-*` tokens:
 *
 *   - **Chrome** (panel, header/footer bands, the two cards, the file-name
 *     inset, the checkbox rows, both secondary buttons, borders, hover, close)
 *     resolves through the shared semantic tokens — the same steps UI-03M/N/O
 *     used, so the rendered Dark palette is unchanged where the compatibility
 *     layer already resolved these names.
 *   - **Identity** (the header tile gradient, the `PORTABLE .ZIP` badge, the
 *     status banner and the primary export CTA) is one accent family on
 *     `--apex-accent` / `--apex-accent-strong` with `--apex-state-playing-fg` as
 *     the on-colour. This is the decision UI-03O recorded for the desktop modal's
 *     raw amber badge: `#ffaa00` was never mapped by the compatibility layer, so
 *     it stayed amber-on-white in Light (1.9:1) instead of following the theme.
 *   - **Payload** (the ZIP's `README.txt`, `project_manifest.json`,
 *     `bundle_manifest.json`, `patterns/*.json`, `mixer_routing/*.json`) keeps
 *     its bytes exactly. Only the modal paints; the archive is data.
 *
 * Behaviour is pinned here as well: the generated archive paths, the bundle
 * manifest format/version, the `audioBlob`/`blob` stripping, the import seam
 * that calls `persistAudioClip` and then `onLoadProjectState` with
 * `source: 'bundle-import'`, both aria-labels, and the fact that a closed modal
 * renders nothing.
 *
 * Live pixel contrast in both palettes is measured in
 * `browser-tests/projectBundleZipTheme.spec.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectBundleZipModal } from './ProjectBundleZipModal';
import { buildBundleAudioAssetPath } from './projectBundleAudioPath';
import { DEFAULT_PROJECT } from '../audio/presets';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};

const render = (isOpen = true): string =>
  renderToStaticMarkup(
    React.createElement(ProjectBundleZipModal, {
      isOpen,
      onClose: noop,
      projectState: DEFAULT_PROJECT,
      onLoadProjectState: noop
    })
  );

const source = readFileSync('src/components/ProjectBundleZipModal.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

/**
 * A colour literal, an arbitrary `[#…]` utility, a white/black utility, a raw
 * `rgb()`/`rgba()` value, or a Tailwind palette colour. Applied to the rendered
 * class attributes *and* to the comment-stripped source, so a literal cannot
 * hide behind a template literal the way it can in a markup-only scan.
 */
const UNTHEMED =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring|fill|divide|placeholder|caret|shadow)-\[#|\b(?:text|bg|border|divide|ring|from|to|placeholder)-(?:white|black)\b|\brgba?\(|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-[0-9]/i;

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const luminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (foreground: string, background: string): number => {
  const first = luminance(hexToRgb(foreground));
  const second = luminance(hexToRgb(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

describe('project bundle audio archive paths', () => {
  it('keeps distinct audio IDs on distinct ZIP paths, including sanitized and truncated collisions', () => {
    const ids = [
      'take/one',
      'take_one',
      `${'x'.repeat(120)}a`,
      `${'x'.repeat(120)}b`
    ];
    const paths = ids.map((id, index) => buildBundleAudioAssetPath(id, index));

    assert.equal(new Set(paths).size, ids.length);
  });
});

describe('Project Bundle Zip modal theme contract (UI-03P)', () => {
  it('renders the full modal: title, badge, both cards, both actions and the footer', () => {
    const markup = render();
    assert.match(markup, /id="fl-project-zip-modal-title"/);
    assert.match(markup, /PROJECT ZIP ARCHIVE BUNDLER/);
    assert.match(markup, /PORTABLE \.ZIP/);
    assert.match(markup, /EXPORT COMPLETE PROJECT ZIP/);
    assert.match(markup, /ARCHIVE FILE NAME/);
    assert.match(markup, /Include Pattern JSONs/);
    assert.match(markup, /Include Audio Assets/);
    assert.match(markup, /Download Portable \.ZIP Bundle/);
    assert.match(markup, /IMPORT EXISTING PROJECT ZIP/);
    assert.match(markup, /Choose \.ZIP File to Import/);
    assert.match(markup, /Apex Studio Portable Bundle v2/);
    assert.match(markup, />Close</);
    assert.match(markup, /accept="\.zip,application\/zip"/);
    assert.match(markup, /aria-label="Close project bundler"/);
  });

  it('renders nothing while closed — the open guard is untouched', () => {
    assert.equal(render(false), '');
  });

  it('renders no colour literal in any class attribute, and none in the source', () => {
    const classes = classAttributes(render());
    assert.ok(classes.length > 20, `expected the full modal markup, got ${classes.length} class attributes`);
    const offenders = classes.filter((value) => UNTHEMED.test(value));
    assert.deepEqual(offenders, [], 'class attributes must resolve through semantic tokens');
    assert.equal(UNTHEMED.test(code), false, 'the comment-stripped source must carry no colour literal');
  });

  it('uses the shared chrome, state and identity tokens the migrated modals use', () => {
    const markup = render();
    for (const token of [
      'bg-[var(--apex-surface)]',
      'bg-[var(--apex-panel-header)]',
      'bg-[var(--apex-surface-2)]',
      'bg-[var(--apex-surface-3)]',
      'bg-[var(--apex-canvas)]',
      'border-[var(--apex-border)]',
      'hover:bg-[var(--apex-state-hover)]',
      'text-[var(--apex-text)]',
      'text-[var(--apex-text-2)]',
      'text-[var(--apex-text-3)]',
      'text-[var(--apex-state-playing-fg)]',
      'accent-[var(--apex-accent)]'
    ]) {
      assert.ok(markup.includes(token), `expected the modal to use ${token}`);
    }
    // The status banner is state-driven (it only mounts once a message exists),
    // so its accent fill and accessible dismiss control are pinned at source level.
    assert.match(code, /className="bg-\[var\(--apex-accent\)\] text-\[var\(--apex-state-playing-fg\)\] font-bold text-xs px-4 py-1\.5 flex items-center justify-between shadow-md"/);
    assert.match(markup, /border-\[color-mix\(in_srgb,var\(--apex-accent\)_48%,transparent\)\]/);
    assert.match(markup, /bg-gradient-to-br from-\[var\(--apex-accent\)\] to-\[var\(--apex-accent-strong\)\]/);
    assert.match(markup, /from-\[var\(--apex-accent\)\] to-\[var\(--apex-accent-strong\)\] hover:opacity-90/);
    // The scrim is ModalFrame's shared overlay token, never a dead black fill.
    assert.equal(/bg-black/.test(markup), false);
  });

  it('keeps every archive path, manifest field and import seam byte-identical', () => {
    for (const path of [
      "'project_manifest.json'",
      "'bundle_manifest.json'",
      "'README.txt'",
      "'mixer_routing'",
      "'mixer_tracks.json'",
      "'patterns'",
      "'audio'"
    ]) {
      assert.ok(code.includes(path), `expected the export to keep ${path}`);
    }
    assert.match(code, /format: 'apex-studio-project-bundle'/);
    assert.match(code, /formatVersion: 2/);
    assert.match(code, /buildBundleAudioAssetPath\(audioId, audioFiles\.length\)/);
    assert.match(code, /if \(key === 'audioBlob' \|\| key === 'blob'\) return undefined;/);
    assert.match(code, /pattern_\$\{idx \+ 1\}_\$\{sanitizeFilePart\(pat\.name\)\}\.json/);
    assert.match(code, /a\.download = `\$\{bundleName\}\.zip`/);
    // Import seam: load, normalise, restore audio, then hand the state to the app.
    assert.match(code, /JSZip\.loadAsync\(file\)/);
    assert.match(code, /normalizeProjectState\(JSON\.parse\(manifestContent\)\)/);
    assert.match(code, /await persistAudioClip\(audioFile\.id, typedBlob\)/);
    assert.match(code, /onLoadProjectState\(loadedState, \{ source: 'bundle-import' \}\)/);
    assert.match(code, /if \(replaced === false\) \{/);
    // The user-visible copy that describes the format is unchanged.
    assert.match(code, /Import cancelled — the current project was kept unchanged\./);
    assert.match(code, /Error unpacking ZIP archive\. Please ensure it contains a valid Apex Studio bundle\./);
    // The glyph-only status dismiss control carries an accessible name.
    assert.match(code, /aria-label="Dismiss status message"/);
  });

  it('keeps the identity family AA in both palettes (measured from the pinned tokens)', () => {
    for (const [mode, tokens] of [['dark', DARK_TOKENS], ['light', LIGHT_TOKENS]] as const) {
      const accent = tokens['--apex-accent'];
      const onAccent = tokens['--apex-state-playing-fg'];
      const surface = tokens['--apex-surface'];
      assert.ok(
        contrastRatio(onAccent, accent) >= 4.5,
        `${mode}: the on-accent label must clear 4.5:1 on the accent banner (${contrastRatio(onAccent, accent).toFixed(2)}:1)`
      );
      for (const step of ['--apex-text', '--apex-text-2', '--apex-text-3']) {
        assert.ok(
          contrastRatio(tokens[step], surface) >= 4.5,
          `${mode}: ${step} on the panel surface (${contrastRatio(tokens[step], surface).toFixed(2)}:1)`
        );
      }
    }
  });
});
