import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * UI-03A — theme-foundation guards.
 *
 * These assertions cover pure CSS facts that are cheap to protect: which theme
 * owns `color-scheme`, whether the retired compatibility mapping has any live
 * source consumers, and whether semantic text is readable on every surface.
 *
 * The live behaviour (pre-paint, persistence, switching) is covered by
 * `theme.test.ts` and by the real-browser suite in `browser-tests/`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');
const indexCss = () => read('src/index.css');

const tokenMap = (block: string): Record<string, string> => Object.fromEntries(
  [...block.matchAll(/(--apex-[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])
);

/** The dark palette is the `:root` default; Light layers on top of it. */
const themeTokens = (css: string, mode: 'dark' | 'light'): Record<string, string> => {
  const merge = (blocks: string[]) => blocks.map(tokenMap).reduce((combined, block) => ({ ...combined, ...block }), {});
  const defaults = merge([...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(match => match[1]));
  if (mode === 'dark') return defaults;
  const lightBlocks = [...css.matchAll(/:root\[data-theme="light"\]\s*\{([^}]+)\}/g)].map(match => match[1]);
  return { ...defaults, ...merge(lightBlocks) };
};

type Rgb = { r: number; g: number; b: number };

const parseColor = (value: string): Rgb | null => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    return {
      r: parseInt(hex[1].slice(0, 2), 16),
      g: parseInt(hex[1].slice(2, 4), 16),
      b: parseInt(hex[1].slice(4, 6), 16),
    };
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (rgba) {
    const parts = rgba[1].split(',').map(part => parseFloat(part));
    return { r: parts[0], g: parts[1], b: parts[2] };
  }
  return null;
};

/**
 * Resolves the one token that is intentionally a `color-mix`, so no surface is
 * silently skipped by the contrast sweep below.
 */
const resolveColor = (value: string, tokens: Record<string, string>): Rgb | null => {
  const alias = /^var\((--apex-[\w-]+)\)$/.exec(value.trim());
  if (alias) return resolveColor(tokens[alias[1]] ?? '', tokens);
  const direct = parseColor(value);
  if (direct) return direct;
  const mix = /^color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+(\d+)%,\s*(var\(--apex-[\w-]+\))\)$/i.exec(value);
  if (!mix) return null;
  const base = parseColor(mix[1]);
  const mixed = parseColor(mix[3].replace(/^var\(/, '').replace(/\)$/, '') in tokens
    ? tokens[mix[3].replace(/^var\(/, '').replace(/\)$/, '')]
    : '');
  if (!base || !mixed) return null;
  const weight = parseInt(mix[2], 10) / 100;
  const blend = (a: number, b: number) => a * weight + b * (1 - weight);
  return { r: blend(base.r, mixed.r), g: blend(base.g, mixed.g), b: blend(base.b, mixed.b) };
};

const luminance = ({ r, g, b }: Rgb): number => {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a: Rgb, b: Rgb): number => {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

const TEXT_STEPS = ['--apex-text', '--apex-text-2', '--apex-text-3', '--apex-text-muted'] as const;

const SURFACES = [
  '--apex-bg',
  '--apex-surface',
  '--apex-surface-2',
  '--apex-surface-3',
  '--apex-chrome-menu',
  '--apex-chrome-transport',
  '--apex-chrome-ribbon',
  '--apex-chrome-status',
  '--apex-chrome-inset',
  '--apex-panel',
  '--apex-panel-header',
  '--apex-canvas',
] as const;

// The 44 selector entries removed with UI-1C. Matching source utilities here
// (rather than preserving the old CSS) makes a future consumer force a token
// migration before another compatibility mapping can be added.
const LEGACY_COMPATIBILITY_COLORS = [
  '0a0a0b', '121214', '141416', '1a1a1d', '1e1e20', '18181c',
  '222225', '252525', '2d2d30', '1c1c20', '202024', '242428', '2a2a2e',
  '26262a', '28282e', '2e2e34', '333336', '282830', '333',
  'b0b0b0', '777', '888', '666', '555', '444',
  'ff6e00', 'ff7d1a', '00bcd4', '00e5ff', '000', 'ff0000', '00ff00', '00ff88',
] as const;
const LEGACY_COMPATIBILITY_UTILITY = new RegExp(
  `(?:hover:)?(?:bg|text|border)-\\[#(?:${LEGACY_COMPATIBILITY_COLORS.join('|')})\\]`,
  'i'
);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html']);

const productionSources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const absolutePath = path.join(directory, entry.name);
  if (entry.isDirectory()) return productionSources(absolutePath);
  if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return [];
  if (entry.name.includes('.test.') || entry.name.includes('.spec.')) return [];
  return [absolutePath];
});

test('color-scheme follows the active theme instead of being forced dark', () => {
  const css = indexCss();
  // No bare `:root { color-scheme: dark }`: that is what kept native controls dark
  // in a Light session.
  const baseRoot = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(match => match[1]);
  for (const block of baseRoot) {
    assert.equal(
      /color-scheme\s*:/.test(block),
      false,
      'the default :root block must not pin color-scheme'
    );
  }
  assert.match(css, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;\s*\}/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  // The fallback exists only for the window before the pre-paint script runs.
  assert.match(css, /:root:not\(\[data-theme\]\)\s*\{\s*color-scheme:\s*dark;\s*\}/);
});

test('the dead UI-1C compatibility layer is retired with no remaining source consumers', () => {
  const css = indexCss();
  assert.equal(
    css.includes('/* Map the old black/orange utility palette'),
    false,
    'the compatibility mapping must stay retired'
  );
  assert.doesNotMatch(
    css,
    /\[class\*="(?:bg|text|border)-\[#ff(?:6e00|7d1a)\]/,
    'the old partial-match accent overrides must stay retired'
  );

  const sourceFiles = [
    ...productionSources(path.join(repoRoot, 'src')),
    ...productionSources(path.join(repoRoot, 'scripts')),
    path.join(repoRoot, 'index.html'),
  ];
  const liveConsumers: string[] = [];
  for (const sourcePath of sourceFiles) {
    const source = readFileSync(sourcePath, 'utf8');
    const utility = source.match(LEGACY_COMPATIBILITY_UTILITY);
    if (utility) liveConsumers.push(`${path.relative(repoRoot, sourcePath)}: ${utility[0]}`);
    assert.equal(
      /(?:bg|text|border)-\[\$\{/.test(source),
      false,
      `${path.relative(repoRoot, sourcePath)} must not construct arbitrary legacy colour utilities dynamically`
    );
  }
  assert.deepEqual(
    liveConsumers,
    [],
    'production source must use semantic tokens rather than classes formerly remapped by UI-1C'
  );
});

test('every semantic text step reaches AA on every surface in both themes', () => {
  const css = indexCss();
  for (const mode of ['dark', 'light'] as const) {
    const tokens = themeTokens(css, mode);
    for (const step of TEXT_STEPS) {
      const fg = resolveColor(tokens[step] ?? '', tokens);
      assert.ok(fg, `${mode} ${step} must resolve to a colour`);
      for (const surface of SURFACES) {
        const bg = resolveColor(tokens[surface] ?? '', tokens);
        assert.ok(bg, `${mode} ${surface} must resolve to a colour`);
        const ratio = contrastRatio(fg as Rgb, bg as Rgb);
        assert.ok(
          ratio >= 4.5,
          `${mode} ${step} on ${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 AA floor`
        );
      }
    }
  }
});

test('each theme owns a modal scrim that keeps the dialog panel separated', () => {
  const css = indexCss();
  const dark = themeTokens(css, 'dark');
  const light = themeTokens(css, 'light');
  assert.ok(dark['--apex-modal-overlay'], 'dark defines the scrim token');
  assert.ok(light['--apex-modal-overlay'], 'light overrides the scrim token');
  assert.notEqual(dark['--apex-modal-overlay'], light['--apex-modal-overlay']);

  const scrim = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(light['--apex-modal-overlay']);
  assert.ok(scrim, 'the light scrim is an rgba wash');
  const canvas = parseColor(light['--apex-canvas']);
  const panel = parseColor(light['--apex-panel']);
  assert.ok(canvas && panel);
  const alpha = parseFloat(scrim[4]);
  const behind = {
    r: parseInt(scrim[1], 10) * alpha + (canvas as Rgb).r * (1 - alpha),
    g: parseInt(scrim[2], 10) * alpha + (canvas as Rgb).g * (1 - alpha),
    b: parseInt(scrim[3], 10) * alpha + (canvas as Rgb).b * (1 - alpha),
  };
  assert.ok(
    contrastRatio(panel as Rgb, behind) >= 3,
    'the dialog panel must stay clearly separated from the dimmed canvas'
  );
});

test('disabled and selected states stay distinguishable and perceivable in both themes', () => {
  const css = indexCss();
  for (const mode of ['dark', 'light'] as const) {
    const tokens = themeTokens(css, mode);
    const surface = parseColor(tokens['--apex-surface'] ?? '');
    const disabled = resolveColor(tokens['--apex-state-disabled'] ?? '', tokens);
    const enabled = resolveColor(tokens['--apex-text'] ?? '', tokens);
    assert.ok(surface && disabled && enabled, `${mode} state colours must resolve`);

    const disabledRatio = contrastRatio(disabled as Rgb, surface as Rgb);
    const enabledRatio = contrastRatio(enabled as Rgb, surface as Rgb);
    // Perceivable: a disabled control has to be readable enough to identify.
    assert.ok(disabledRatio >= 3, `${mode} disabled text is ${disabledRatio.toFixed(2)}:1, below 3:1`);
    // Distinguishable: disabled must not read as ordinary enabled text.
    assert.ok(
      disabledRatio < enabledRatio - 3,
      `${mode} disabled (${disabledRatio.toFixed(2)}:1) is too close to enabled (${enabledRatio.toFixed(2)}:1)`
    );

    // Selected must be a real step away from hover, not the same wash.
    assert.notEqual(tokens['--apex-state-selected'], tokens['--apex-state-hover']);
    assert.match(
      tokens['--apex-state-selected'] ?? '',
      /color-mix\(in srgb, var\(--apex-accent\)/,
      `${mode} selection is accent-derived`
    );
  }
});

test('the focus ring is an opaque token, not an alpha wash', () => {
  const css = indexCss();
  for (const mode of ['dark', 'light'] as const) {
    const tokens = themeTokens(css, mode);
    assert.match(tokens['--apex-state-focus'] ?? '', /color-mix\(in srgb, var\(--apex-accent\)/, mode);
  }
  // The global keyboard ring reads from the token; the old 75%-alpha violet wash
  // faded into light surfaces.
  assert.match(css, /outline:\s*2px solid var\(--apex-state-focus\)/);
  assert.equal(
    /outline:\s*2px solid color-mix\(in srgb, var\(--apex-accent\) 75%/.test(css),
    false,
    'the translucent focus ring is the defect being fixed'
  );
});

test('native form controls take their accent from the active theme', () => {
  const css = indexCss();
  assert.match(css, /input\[type="range"\], input\[type="checkbox"\], progress \{ accent-color: var\(--apex-accent\); \}/);
});

test('theme-critical surfaces carry no hardcoded neutral literals', () => {
  const sources = [
    'src/App.tsx',
    'src/components/AppearanceSettingsModal.tsx',
    'src/components/ApplicationMenuBar.tsx',
    'src/components/StatusBar.tsx',
    'src/components/StudioBrowser.tsx',
    'src/components/ChannelRack.tsx',
  ];
  const neutralLiteral = /\b(?:bg|text|border|ring|from|to|via)-\[#(?:0a0a0b|0c0c0e|101014|111113|121214|151821|18181c|1c1c20|1e1e20|202024|242428|28282e|2a2a2e|333|333336|444|555|666|777|888|999|aaa|b0b0b0|ffffff|000)\](?:\/[\d.]+)?/i;
  for (const file of sources) {
    assert.equal(
      neutralLiteral.test(read(file)),
      false,
      `${file} must style through semantic tokens so both themes stay coherent`
    );
  }
});

test('the Settings surface takes its scrim and panel colours from tokens', () => {
  const modal = read('src/components/AppearanceSettingsModal.tsx');
  assert.equal(
    /bg-black\/|bg-white\/|#[0-9a-f]{3,8}/i.test(modal),
    false,
    'the Settings dialog must not hardcode a scrim, panel or palette literal'
  );
  assert.match(modal, /apex-modal-overlay/, 'the shared modal scrim token owns the backdrop');
  assert.match(modal, /bg-\[var\(--apex-surface\)\]/, 'the dialog panel uses the semantic surface token');
  assert.match(modal, /text-\[var\(--apex-text\)\]/, 'the dialog text uses the semantic text token');
});

test('the theme selector is driven by one shared mode list', () => {
  const modal = read('src/components/AppearanceSettingsModal.tsx');
  const theme = read('src/state/theme.ts');
  assert.match(theme, /export const THEME_MODES: readonly ThemeMode\[\] = \['dark', 'light'\]/);
  assert.match(
    modal,
    /THEME_MODES/,
    'the selector renders the shared mode list rather than a second private copy'
  );
  // Both options must be describable in the UI: a mode the user cannot tell apart
  // from the other is not a choice.
  assert.match(modal, /Dark|dark/);
  assert.match(modal, /Light|light/);
});
