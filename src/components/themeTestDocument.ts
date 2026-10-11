/**
 * UI-03C — test-only document double for the theme seams.
 *
 * Resolves the real `src/index.css` token blocks (Dark and Light) and picks the
 * table from the live `data-theme`, the way a computed style does. Shared by the
 * Mixer seam and Mixer render tests so they cannot drift from each other.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CanvasThemeDocument } from './canvasThemeTokens';

const css = readFileSync('src/index.css', 'utf8');

const declarations = (block: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[`--${m[1]}`] = m[2].trim();
  return out;
};

// The Dark palette is declared across several `:root { }` blocks; later blocks
// override earlier ones exactly as the cascade does, so merge them in order.
export const DARK_TOKENS: Record<string, string> = (() => {
  const blocks = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'dark token blocks present');
  return Object.assign({}, ...blocks.map(declarations));
})();

export const LIGHT_TOKENS: Record<string, string> = (() => {
  const blocks = [...css.matchAll(/:root\[data-theme="light"\]\s*\{([^}]+)\}/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'light token blocks present');
  return Object.assign({}, ...blocks.map(declarations));
})();

const TOKENS = { dark: DARK_TOKENS, light: LIGHT_TOKENS } as const;

export const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};

/**
 * A document double whose computed style resolves the real token block for one
 * theme. `var(--x)` references are resolved one level, the way Chromium's
 * computed style would for these tokens.
 */
export const makeThemeDocument = (mode: 'dark' | 'light'): CanvasThemeDocument => {
  // The token table is chosen from the live `data-theme`, as a real computed
  // style would be, so flipping the dataset is observable without a new double.
  const root = { dataset: { theme: mode } as { theme: string } };
  const tokensNow = () => TOKENS[root.dataset.theme === 'light' ? 'light' : 'dark'];
  const resolve = (value: string): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
    return ref ? (tokensNow()[ref[1]] ?? '') : value;
  };
  const probes: Array<{ style: { display?: string; backgroundColor?: string } }> = [];
  return {
    documentElement: {
      dataset: root.dataset,
      appendChild: (node: unknown) => node,
    },
    defaultView: {
      getComputedStyle: (element: unknown) => ({
        getPropertyValue: (name: string) => tokensNow()[name] ?? '',
        backgroundColor: element && probes.includes(element as never)
          ? resolve((element as { style: { backgroundColor?: string } }).style.backgroundColor ?? '')
          : '',
      }),
    },
    createElement: () => {
      const probe = { style: { display: '' as string | undefined, backgroundColor: '' as string | undefined }, remove: () => undefined };
      probes.push(probe);
      return probe;
    },
  } as unknown as CanvasThemeDocument;
};

