import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * UI-03 Phase 0 — theme token contract (RED until Phases 1/5 land).
 *
 * This file pins, in the style of shellDesignTokens.test.ts:
 *  1. The dark Midnight Aurora base stays recognizable — core values are
 *     pinned byte-for-byte so the theme work cannot quietly redesign dark.
 *  2. A `:root[data-theme="light"]` scope exists and defines the same core
 *     semantic set (backgrounds, surfaces, borders, text, accent, chrome,
 *     state colors, modal overlay).
 *  3. The shared interaction/canvas semantic tokens (selection ring,
 *     playhead, note states, clip fills, canvas grids, meter gradients,
 *     correlation colors, scrollbar, strong boundary) exist in BOTH scopes —
 *     these replace the white-alpha overlays (audit F5) and the hardcoded
 *     canvas palettes (audit F4).
 *  4. WCAG AA contrast in BOTH themes: every text token clears 4.5:1 on the
 *     app background and on panels, accent-as-text clears 4.5:1, and the
 *     light-theme control boundary clears 3:1 (1.4.11). This catches the
 *     documented dark-theme text-3 defect (audit F6) and keeps the light
 *     palette honest.
 *  5. index.html applies the stored theme before first paint so a light
 *     preference never flashes dark (audit F8).
 *  6. Native form controls follow the active theme via color-scheme (audit F9).
 *
 * No jsdom in the tsx suite: the CSS and HTML are read and asserted on
 * directly, exactly like the existing shell design-token guard.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const indexCss = () => read('src/index.css');
const indexHtml = () => read('index.html');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Returns the declaration text of every CSS block whose selector is exactly
 * `selector` (terminated by `{` after optional whitespace). Searching for
 * bare `:root` therefore skips `:root[data-theme="light"]`, and vice versa.
 */
const collectScopes = (css: string, selector: string): string[] => {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const idx = css.indexOf(selector, from);
    if (idx < 0) break;
    from = idx + selector.length;
    let i = from;
    while (i < css.length && /\s/.test(css[i])) i += 1;
    if (css[i] !== '{') continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    blocks.push(css.slice(i + 1, end));
    from = end + 1;
  }
  return blocks;
};

const declarationsOf = (block: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
    map.set(`--${match[1]}`, match[2].trim());
  }
  return map;
};

/** Dark = every bare `:root` block; light = every `:root[data-theme="light"]` block. */
const themeDeclarations = (css: string, theme: 'dark' | 'light'): Map<string, string> => {
  const merged = new Map<string, string>();
  const blocks =
    theme === 'dark'
      ? collectScopes(css, ':root')
      : collectScopes(css, ':root[data-theme="light"]');
  for (const block of blocks) {
    for (const [token, value] of declarationsOf(block)) merged.set(token, value);
  }
  return merged;
};

const parseHex = (token: string, value: string): [number, number, number] => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  assert.ok(match, `${token} must be a plain hex color for the contrast contract, got: ${value}`);
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
};

const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const contrastOf = (fg: string, bg: string, tokens: Map<string, string>): number => {
  const la = relativeLuminance(parseHex(fg, tokens.get(fg) ?? ''));
  const lb = relativeLuminance(parseHex(bg, tokens.get(bg) ?? ''));
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

const assertContrast = (
  fg: string,
  bg: string,
  min: number,
  tokens: Map<string, string>,
  label: string
): void => {
  const ratio = contrastOf(fg, bg, tokens);
  assert.ok(ratio >= min - 1e-9, `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the required ${min}:1`);
};

// --- 1. dark base is pinned ------------------------------------------------------

test('the dark Midnight Aurora base stays recognizable (pinned values)', () => {
  const dark = themeDeclarations(stripComments(indexCss()), 'dark');
  const pinned: Array<[string, string]> = [
    ['--apex-bg', '#11131a'],
    ['--apex-surface', '#191c25'],
    ['--apex-surface-2', '#202430'],
    ['--apex-surface-3', '#262b38'],
    ['--apex-border', '#2b3040'],
    ['--apex-text', '#f4f5f8'],
    ['--apex-text-2', '#aeb5c4'],
    ['--apex-accent', '#9b8afb'],
    ['--apex-accent-strong', '#b2a5ff'],
    ['--apex-cyan', '#67d9ff'],
    ['--apex-gold', '#ffb86b'],
    ['--apex-danger', '#ff5f6d'],
    ['--apex-success', '#62d7a4'],
    ['--apex-chrome-transport', '#161a26'],
    ['--apex-canvas', '#151821'],
    ['--apex-state-playing-fg', '#0d0f16'],
  ];
  for (const [token, value] of pinned) {
    assert.equal(dark.get(token), value, `${token} must keep its Midnight Aurora value in the dark scope`);
  }
});

// --- 2. light scope semantic set ----------------------------------------------------

const CORE_SEMANTIC_TOKENS = [
  '--apex-bg',
  '--apex-surface',
  '--apex-surface-2',
  '--apex-surface-3',
  '--apex-border',
  '--apex-text',
  '--apex-text-2',
  '--apex-text-3',
  '--apex-accent',
  '--apex-accent-strong',
  '--apex-cyan',
  '--apex-gold',
  '--apex-danger',
  '--apex-success',
  '--apex-chrome-menu',
  '--apex-chrome-transport',
  '--apex-chrome-ribbon',
  '--apex-chrome-status',
  '--apex-chrome-inset',
  '--apex-panel',
  '--apex-panel-header',
  '--apex-canvas',
  '--apex-state-hover',
  '--apex-state-pressed',
  '--apex-state-selected',
  '--apex-state-selected-border',
  '--apex-state-disabled',
  '--apex-state-focus',
  '--apex-state-playing',
  '--apex-state-playing-fg',
  '--apex-state-recording',
  '--apex-state-recording-fg',
  '--apex-modal-overlay',
];

test('a light theme scope exists and defines the core semantic set', () => {
  const light = themeDeclarations(stripComments(indexCss()), 'light');
  assert.ok(light.size > 0, 'a :root[data-theme="light"] scope with declarations must exist in index.css');
  for (const token of CORE_SEMANTIC_TOKENS) {
    assert.ok(light.has(token), `${token} must be defined in the light scope`);
  }
});

// --- 3. shared interaction/canvas tokens in both themes -------------------------------

const SHARED_STATE_CANVAS_TOKENS = [
  '--apex-border-strong',
  '--apex-selection-ring',
  '--apex-playhead',
  '--apex-grid-hover',
  '--apex-note-fill',
  '--apex-note-border',
  '--apex-note-ghost-fill',
  '--apex-note-ghost-border',
  '--apex-clip-midi-fill',
  '--apex-clip-midi-accent',
  '--apex-clip-midi-border',
  '--apex-clip-audio-fill',
  '--apex-clip-audio-border',
  '--apex-clip-automation-fill',
  '--apex-clip-automation-border',
  '--apex-clip-missing-fill',
  '--apex-clip-missing-border',
  '--apex-canvas-bg',
  '--apex-canvas-grid',
  '--apex-canvas-grid-strong',
  '--apex-canvas-text',
  '--apex-meter-1',
  '--apex-meter-2',
  '--apex-meter-3',
  '--apex-fader-fill',
  '--apex-correlation-pos',
  '--apex-correlation-zero',
  '--apex-correlation-neg',
  '--apex-scrollbar-thumb',
  '--apex-scrollbar-hover',
];

test('interaction and canvas semantic tokens exist in BOTH themes', () => {
  const css = stripComments(indexCss());
  const dark = themeDeclarations(css, 'dark');
  const light = themeDeclarations(css, 'light');
  for (const token of SHARED_STATE_CANVAS_TOKENS) {
    assert.ok(dark.has(token), `${token} must be defined in the dark scope`);
    assert.ok(light.has(token), `${token} must be defined in the light scope`);
  }
});

// --- 4. WCAG AA contrast in both themes ------------------------------------------------

test('WCAG AA contrast holds for text, accent-as-text and boundaries in both themes', () => {
  const css = stripComments(indexCss());
  for (const theme of ['dark', 'light'] as const) {
    const tokens = themeDeclarations(css, theme);
    assert.ok(tokens.size > 0, `the ${theme} scope must exist`);
    const pairs: Array<[string, string]> = [
      ['--apex-text', '--apex-bg'],
      ['--apex-text', '--apex-surface'],
      ['--apex-text-2', '--apex-bg'],
      ['--apex-text-2', '--apex-surface'],
      ['--apex-text-3', '--apex-bg'],
      ['--apex-text-3', '--apex-surface'],
      ['--apex-accent', '--apex-surface'],
    ];
    for (const [fg, bg] of pairs) {
      assertContrast(fg, bg, 4.5, tokens, `${theme}: ${fg} on ${bg}`);
    }
  }
  // Light-theme control boundaries (WCAG 1.4.11): controls sit on panel
  // surfaces, so the strong boundary token must clear 3:1 against the
  // surface. The dark theme keeps its existing pinned --apex-border; the
  // bg-to-surface step is decorative framing, not a control boundary.
  const light = themeDeclarations(css, 'light');
  assertContrast('--apex-border-strong', '--apex-surface', 3.0, light, 'light: border-strong on surface');
});

// --- 5. early application in index.html (no light flash) --------------------------------

test('index.html applies the stored theme before first paint (no light flash)', () => {
  const html = indexHtml();
  const classicScripts = [...html.matchAll(/<script(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)];
  const earlySource = classicScripts.map(m => m[1]).join('\n');
  assert.ok(
    earlySource.includes('apex:theme'),
    'a classic (non-module) head script must read the apex:theme preference'
  );
  assert.ok(
    earlySource.includes('dataset.theme') || earlySource.includes('data-theme') || earlySource.includes('setAttribute'),
    'the early script must set the data-theme attribute on <html>'
  );
  const moduleStart = html.search(/<script[^>]*type="module"/);
  const earlyStart = html.search(/<script(?![^>]*type="module")[^>]*>/);
  assert.ok(
    earlyStart >= 0 && moduleStart >= 0 && earlyStart < moduleStart,
    'the early theme script must run before the module bundle loads'
  );
});

// --- 6. color-scheme follows the active theme --------------------------------------------

test('form controls follow the active theme via color-scheme', () => {
  const css = stripComments(indexCss());
  assert.ok(
    /input,\s*select,\s*textarea\s*{[^}]*color-scheme:\s*dark/.test(css),
    'the dark base must keep color-scheme: dark for form controls'
  );
  assert.ok(
    /:root\[data-theme="light"\][^{]*{[^}]*color-scheme:\s*light/.test(css),
    'a light-scoped rule must set color-scheme: light (native widgets, scrollbars, select menus)'
  );
});
