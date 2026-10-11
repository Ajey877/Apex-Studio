/**
 * UI-03B — Mastering Suite light/dark migration, asserted against the markup
 * the component actually produces (`renderToStaticMarkup`, the same technique
 * the Phase 90 control tests and the shell tests use).
 *
 * What this pins down:
 *
 *   1. The suite opens in Dark and in Light (the document's `data-theme` is
 *      the only input that changes between the two renders).
 *   2. Neutral chrome is carried by semantic `--apex-*` tokens, not literals.
 *   3. The intentional data colours — the three band accents — survive: exact
 *      legacy literals in Dark, same hues in Light, and nothing else.
 *   4. The canvas draw path reads its colours through the palette seam, so a
 *      theme flip can repaint it without a reload (no literal `fillStyle` /
 *      `strokeStyle` may reappear in the component).
 *
 * The live repaint itself (rAF picking up the flipped theme in a real
 * browser) is covered by `browser-tests/masteringSuiteTheme.spec.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MasteringSuiteModal, type MasteringSuiteTab } from './MasteringSuiteModal';
import { MASTERING_BAND_ACCENTS } from './masteringSuiteTheme';
import { DEFAULT_MASTERING_SUITE_STATE } from '../audio/masteringState';

const noop = (): void => {};

const TABS: readonly MasteringSuiteTab[] = ['metering', 'multiband', 'imager', 'maximizer'];

const renderTab = (tab: MasteringSuiteTab): string =>
  renderToStaticMarkup(
    React.createElement(MasteringSuiteModal, {
      isOpen: true,
      onClose: noop,
      masteringState: DEFAULT_MASTERING_SUITE_STATE,
      onUpdateMasteringState: noop,
      isPlaying: false,
      initialTab: tab,
    })
  );

const renderAllTabs = (): string => TABS.map(renderTab).join('\n');

/** Installs a minimal document double so the seam resolves a chosen mode. */
const withDocumentTheme = (mode: 'dark' | 'light', run: () => void): void => {
  const holder = globalThis as { document?: unknown };
  const previous = holder.document;
  holder.document = { documentElement: { dataset: { theme: mode } } };
  try {
    run();
  } finally {
    if (previous === undefined) delete holder.document;
    else holder.document = previous;
  }
};

/** Every hex literal in a string, normalised to lowercase. */
const hexLiterals = (text: string): string[] =>
  [...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toLowerCase());

const DARK_BAND_LITERALS = Object.values(MASTERING_BAND_ACCENTS.dark).map((value) => value.toLowerCase());
const LIGHT_BAND_LITERALS = Object.values(MASTERING_BAND_ACCENTS.light).map((value) => value.toLowerCase());

const COMPONENT_SOURCE = readFileSync(new URL('./MasteringSuiteModal.tsx', import.meta.url), 'utf8');
const SEAM_SOURCE = readFileSync(new URL('./masteringSuiteTheme.ts', import.meta.url), 'utf8');

afterEach(() => {
  const holder = globalThis as { document?: unknown };
  delete holder.document;
});

describe('UI-03B — the Mastering Suite opens in both themes', () => {
  it('renders the full suite in Dark with its title, tabs and controls', () => {
    withDocumentTheme('dark', () => {
      for (const tab of TABS) {
        const markup = renderTab(tab);
        assert.ok(markup.includes('APEX MASTERING SUITE'), `${tab}: title missing`);
        assert.ok(markup.includes('role="dialog"'), `${tab}: dialog semantics missing`);
      }
      const all = renderAllTabs();
      // `&` serialises as `&amp;` in static markup; compare against that form.
      for (const label of [
        'LUFS Loudness &amp; Peak',
        '3-Band Multiband Dynamics',
        'Stereo Imager &amp; Sub Mono',
        'Brickwall Maximizer',
        'MASTERING PRESETS',
      ]) {
        assert.ok(all.includes(label), `${label} missing from the rendered suite`);
      }
    });
  });

  it('renders the full suite in Light from the same component, unchanged props', () => {
    withDocumentTheme('light', () => {
      for (const tab of TABS) {
        const markup = renderTab(tab);
        assert.ok(markup.includes('APEX MASTERING SUITE'), `${tab}: title missing in Light`);
        assert.ok(markup.includes('role="dialog"'), `${tab}: dialog semantics missing in Light`);
      }
    });
  });

  it('keeps the shared modal frame contract: overlay primitive and verbatim scrim classes', () => {
    withDocumentTheme('dark', () => {
      const markup = renderTab('metering');
      const rootTag = markup.slice(0, markup.indexOf('>') + 1);
      assert.ok(rootTag.includes('apex-modal-overlay'), 'the themed scrim primitive must be wired');
      assert.ok(rootTag.includes('bg-black/80'), 'the overlay classes stay verbatim for the frame contract');
    });
  });
});

describe('UI-03B — chrome surfaces and text ride the semantic tokens', () => {
  const all = (() => {
    let markup = '';
    withDocumentTheme('dark', () => {
      markup = renderAllTabs();
    });
    return markup;
  })();

  it('uses the Midnight Aurora tokens for structure, text and states', () => {
    for (const token of [
      'var(--apex-surface)',
      'var(--apex-surface-2)',
      'var(--apex-surface-3)',
      'var(--apex-border)',
      'var(--apex-panel-header)',
      'var(--apex-canvas)',
      'var(--apex-chrome-inset)',
      'var(--apex-text)',
      'var(--apex-text-2)',
      'var(--apex-text-3)',
      'var(--apex-accent)',
      'var(--apex-accent-strong)',
      'var(--apex-state-hover)',
      'var(--apex-state-playing-fg)',
      'var(--apex-success)',
      'var(--apex-gold)',
      'var(--apex-danger)',
      'var(--apex-cyan)',
    ]) {
      assert.ok(all.includes(token), `${token} is not used by the rendered suite`);
    }
  });

  it('carries no hardcoded neutral chrome literal anywhere in the markup', () => {
    const allowed = new Set([...DARK_BAND_LITERALS, ...LIGHT_BAND_LITERALS]);
    const offenders = [...new Set(hexLiterals(all))].filter((literal) => !allowed.has(literal));
    assert.deepEqual(offenders, [], 'every chrome colour must come from a token or the seam');
  });
});

describe('UI-03B — intentional data colours survive the migration', () => {
  it('paints the exact legacy band accents in Dark', () => {
    let markup = '';
    withDocumentTheme('dark', () => {
      markup = renderTab('multiband');
    });
    for (const literal of DARK_BAND_LITERALS) {
      const occurrences = hexLiterals(markup).filter((value) => value === literal).length;
      // Dot, gain readout and six slider accents per band: identity is present
      // more than once, never replaced by a generic token.
      assert.ok(occurrences >= 2, `band accent ${literal} must survive in Dark (found ${occurrences})`);
    }
    assert.ok(
      markup.includes('data-band-accent="low"') &&
        markup.includes('data-band-accent="mid"') &&
        markup.includes('data-band-accent="high"'),
      'each band keeps its identity marker'
    );
  });

  it('keeps the same band hues in Light, distinct from the Dark literals', () => {
    let markup = '';
    withDocumentTheme('light', () => {
      markup = renderTab('multiband');
    });
    for (const literal of LIGHT_BAND_LITERALS) {
      assert.ok(markup.toLowerCase().includes(literal), `light band accent ${literal} missing`);
    }
    for (const literal of DARK_BAND_LITERALS) {
      assert.ok(!markup.toLowerCase().includes(literal), `dark-only accent ${literal} must not leak into Light`);
    }
  });

  it('keeps the legacy dark literals pinned in the seam source itself', () => {
    for (const literal of ['#ffaa00', '#00ff88', '#00e5ff', '#ff6e00', '#ff0055']) {
      assert.ok(SEAM_SOURCE.includes(`'${literal}'`), `seam must keep ${literal} as a dark data colour`);
    }
  });
});

describe('UI-03B — canvas colours come from the palette seam, never literals', () => {
  it('leaves no hex literal in the component source, including the draw code', () => {
    assert.deepEqual(
      [...new Set(hexLiterals(COMPONENT_SOURCE))],
      [],
      'a literal in the component can only be dark-only chrome'
    );
  });

  it('assigns fillStyle/strokeStyle only from the seam or a gradient built from it', () => {
    assert.doesNotMatch(
      COMPONENT_SOURCE,
      /(fillStyle|strokeStyle)\s*=\s*['"`#]/,
      'canvas colour assignments must read the palette seam'
    );
    assert.match(COMPONENT_SOURCE, /readMasteringSuitePalette\(\)/, 'the draw loop reads the seam');
  });

  it('reads the seam per frame so a theme flip repaints without a reload', () => {
    // The palette read happens inside the two draw functions, which the rAF
    // loop calls every frame while the modal is open — not once at mount.
    for (const drawFn of ['drawGoniometer', 'drawMasterSpectrum']) {
      const body = COMPONENT_SOURCE.slice(COMPONENT_SOURCE.indexOf(`const ${drawFn} = () =>`));
      assert.ok(
        body.slice(0, 1200).includes('readMasteringSuitePalette()'),
        `${drawFn} must resolve its palette at draw time`
      );
    }
  });
});
