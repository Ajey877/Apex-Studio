/**
 * UI-03N — Take Comping Light/Dark theme regression, run in a real Chromium
 * against the actual Vite application (no simulation, no stubbed styles).
 *
 * Every expected colour below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The same two browser realities the MIDI Learn suite documents
 * drive the helpers here:
 *
 *   - Surfaces that come from a `color-mix()` token (the panel border, the
 *     themed scrim) serialize as `color(srgb r g b / a)` and float-round
 *     slightly differently between reads, so colours are compared through a
 *     normalizing parser with a one-unit tolerance.
 *   - Several controls carry a Tailwind `transition` class, so a computed-style
 *     read taken right after an interaction can catch a mid-transition value
 *     that Chromium serializes as `oklab(...)`. `expectColor` therefore
 *     retries until the value settles.
 *
 * The shipped default project contains no audio takes, so the live app can
 * only reach the *empty* state of the comping tool (take groups are created
 * by the recording pipeline, which the headless browser cannot drive). The
 * group-list surface — group cards, the selected group's identity border and
 * ring, the active-take cyan wash and Check glyph, the take rows — is pinned
 * by `src/components/takeCompingThemeUi.test.tsx`, which renders every branch
 * in both themes with real take-group clips, and by the take-manager suites in
 * `test:audio`. This suite pins what the live app can show:
 *
 *   - the themed empty state (inset, icon, counts, CTA);
 *   - the cyan take identity (tile gradient, panel edge, Done CTA);
 *   - Escape and the focus contract.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

interface Rgba { r: number; g: number; b: number; a: number }

/** Accepts `rgb()`, `rgba()` and `color(srgb r g b / a)` computed values. */
const parseColor = (value: string): Rgba => {
  const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/);
  if (srgb) {
    return {
      r: Number(srgb[1]) * 255,
      g: Number(srgb[2]) * 255,
      b: Number(srgb[3]) * 255,
      a: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  }
  const channels = value.match(/[\d.]+/g)?.slice(0, 4).map(Number);
  if (!channels || channels.length < 3) throw new Error(`Cannot parse computed color: ${value}`);
  return { r: channels[0], g: channels[1], b: channels[2], a: channels[3] ?? 1 };
};

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const cssColor = (value: Rgba): string =>
  `rgb(${Math.round(value.r)}, ${Math.round(value.g)}, ${Math.round(value.b)})`;
const describeColor = (value: Rgba): string =>
  value.a === 1 ? cssColor(value) : `${cssColor(value)} @ ${value.a}`;

/** Largest per-channel distance, with alpha scaled onto the same 0-255 range. */
const colorDistance = (got: Rgba, expected: Rgba): number =>
  Math.max(
    Math.abs(got.r - expected.r),
    Math.abs(got.g - expected.g),
    Math.abs(got.b - expected.b),
    Math.abs(got.a - expected.a) * 255,
  );

/** Retrying colour assertion: tolerates `color-mix()` float rounding and the
    mid-transition values a Tailwind `transition` class produces. */
const expectColor = async (
  read: () => Promise<string>,
  expected: Rgba,
  label: string,
  tolerance = 1,
): Promise<void> => {
  await expect
    .poll(() => read().then((value) => colorDistance(parseColor(value), expected)), {
      message: `${label}: expected ${describeColor(expected)} within ${tolerance} per channel`,
      timeout: 5_000,
      intervals: [50],
    })
    .toBeLessThanOrEqual(tolerance);
};

interface Outline { color: string; width: string; style: string }

const tryParseColor = (value: string): Rgba | null => {
  if (!/^(?:rgb|rgba|color\(srgb)/.test(value.trim())) return null;
  try {
    return parseColor(value);
  } catch {
    return null;
  }
};

/** Retrying focus-ring assertion: a solid 2px ring on the theme focus token. */
const expectFocusRing = async (read: () => Promise<Outline>, accent: Rgba, label: string): Promise<void> => {
  const expected = { ...accent, a: 0.78 };
  await expect
    .poll(async () => {
      const outline = await read();
      if (outline.style !== 'solid' || outline.width !== '2px') return Number.MAX_SAFE_INTEGER;
      const parsed = tryParseColor(outline.color);
      return parsed === null ? Number.MAX_SAFE_INTEGER : colorDistance(parsed, expected);
    }, {
      message: `${label}: expected a 2px solid ring at ${describeColor(expected)}`,
      timeout: 5_000,
      intervals: [50],
    })
    .toBeLessThanOrEqual(2);
};

const bgOf = (locator: Locator): (() => Promise<string>) =>
  () => locator.evaluate((element) => getComputedStyle(element).backgroundColor);
const fgOf = (locator: Locator): (() => Promise<string>) =>
  () => locator.evaluate((element) => getComputedStyle(element).color);
const borderTopOf = (locator: Locator): (() => Promise<string>) =>
  () => locator.evaluate((element) => getComputedStyle(element).borderTopColor);
const borderBottomOf = (locator: Locator): (() => Promise<string>) =>
  () => locator.evaluate((element) => getComputedStyle(element).borderBottomColor);
const bgImageOf = (locator: Locator): (() => Promise<string>) =>
  () => locator.evaluate((element) => getComputedStyle(element).backgroundImage);

const luminance = ({ r, g, b }: Rgba): number => {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrastRatio = (foreground: Rgba, background: Rgba): number => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/** Flattens a semi-transparent foreground onto the surface behind it. */
const composite = (foreground: Rgba, background: Rgba): Rgba => ({
  r: foreground.r * foreground.a + background.r * (1 - foreground.a),
  g: foreground.g * foreground.a + background.g * (1 - foreground.a),
  b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  a: 1,
});

/** The element's own background plus every ancestor background, so the
    effective surface can be composited in Node. */
const readBackgroundStack = (locator: Locator): Promise<{ foreground: string; stack: string[] }> =>
  locator.evaluate((element) => {
    const stack: string[] = [];
    let surface: Element | null = element;
    for (let depth = 0; surface && depth < 16; depth += 1) {
      stack.push(getComputedStyle(surface).backgroundColor);
      surface = surface.parentElement;
    }
    return { foreground: getComputedStyle(element).color, stack };
  });

/** Flattens the stack onto the first opaque layer: the panel border is a
    translucent `color-mix()` wash and must be composited before a ratio
    means anything. */
const effectiveSurface = (stack: readonly string[]): Rgba => {
  const layers = stack.map(parseColor);
  const opaqueIndex = layers.findIndex((layer) => layer.a >= 1);
  const from = opaqueIndex === -1 ? layers.length - 1 : opaqueIndex;
  let base = layers[from];
  for (let index = from - 1; index >= 0; index -= 1) {
    base = composite(layers[index], { r: base.r, g: base.g, b: base.b, a: 1 });
  }
  return { r: base.r, g: base.g, b: base.b, a: 1 };
};

/** WCAG 2.1 SC 1.4.3 — text must clear 4.5:1 on its effective surface. */
const expectAaContrast = async (locator: Locator, label: string): Promise<void> => {
  const { foreground, stack } = await readBackgroundStack(locator);
  const surface = effectiveSurface(stack);
  const ratio = contrastRatio(parseColor(foreground), surface);
  expect(ratio, `${label}: ${foreground} on ${cssColor(surface)} = ${ratio.toFixed(2)}:1`)
    .toBeGreaterThanOrEqual(4.5);
};

/** WCAG 2.1 SC 1.4.11 — a non-text UI component must clear 3:1 against what it
    sits on. Used for the identity tile and the Done CTA. */
const expectNonTextContrast = async (
  read: () => Promise<string>,
  background: Rgba,
  label: string,
): Promise<void> => {
  const value = parseColor(await read());
  const flat = value.a < 1 ? composite(value, background) : value;
  const ratio = contrastRatio(flat, background);
  expect(ratio, `${label}: ${describeColor(flat)} on ${cssColor(background)} = ${ratio.toFixed(2)}:1`)
    .toBeGreaterThanOrEqual(3);
};

const openTakeComping = async (page: Page): Promise<Locator> => {
  // The comping tool is opened from the transport tool overflow menu; its
  // items are portalled and only exist once the menu is open.
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-take-comp-btn').click();
  const dialog = page.locator('#fl-take-comping-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('UI-03N Take Comping theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, cyan identity, empty state and focus states`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* storage is optional */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      const dialog = await openTakeComping(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'fl-take-comping-modal-title');
      await expect(dialog.locator('#fl-take-comping-modal-title')).toHaveText('TAKE COMPING');

      // Resolved token values, read from the running app in each theme.
      const expected = mode === 'dark'
        ? {
            scrim: rgba(5, 7, 12, 0.66),
            panel: rgba(25, 28, 37),
            header: rgba(31, 36, 49),
            canvas: rgba(21, 24, 33),
            border: rgba(43, 48, 64),
            text: rgba(244, 245, 248),
            text2: rgba(174, 181, 196),
            text3: rgba(139, 149, 168),
            cyan: rgba(103, 217, 255),
            cyanStrong: rgba(113, 239, 255),
            accent: rgba(155, 138, 251),
            onAccent: rgba(13, 15, 22),
            hoverWash: rgba(255, 255, 255, 0.055),
          }
        : {
            scrim: rgba(24, 32, 45, 0.55),
            panel: rgba(255, 255, 255),
            header: rgba(231, 235, 242),
            canvas: rgba(244, 246, 250),
            border: rgba(201, 208, 220),
            text: rgba(24, 32, 45),
            text2: rgba(70, 82, 103),
            text3: rgba(91, 104, 121),
            cyan: rgba(8, 125, 168),
            cyanStrong: rgba(7, 116, 156),
            accent: rgba(101, 82, 206),
            onAccent: rgba(255, 255, 255),
            hoverWash: rgba(24, 32, 45, 0.07),
          };

      const panel = dialog.locator(':scope > div');
      const header = panel.locator(':scope > div').first();
      const footer = panel.locator(':scope > div').last();
      const body = panel.locator('.custom-scrollbar');

      // The scrim is the shared themed overlay token, not a dark-only black fill.
      await expectColor(bgOf(dialog), expected.scrim, 'dialog scrim');

      // Chrome surfaces resolve from the active palette. The panel check is the
      // core regression guard: a dark panel surviving into Light mode is the
      // exact defect this migration exists to remove.
      await expectColor(bgOf(panel), expected.panel, 'panel surface');
      await expectColor(bgOf(header), expected.header, 'header band');
      await expectColor(bgOf(footer), expected.header, 'footer band');
      await expectColor(fgOf(panel), expected.text2, 'panel body text');
      await expectColor(borderBottomOf(header), expected.border, 'header border');
      await expectColor(borderTopOf(footer), expected.border, 'footer border');

      // The take identity: a cyan-washed panel edge and a cyan gradient tile.
      await expectColor(borderTopOf(panel), { ...expected.cyan, a: 0.4 }, 'panel identity border');
      const tile = header.locator('.w-8').first();
      const tileGradient = await bgImageOf(tile)();
      expect(tileGradient, 'the identity tile is a gradient').toContain('gradient');
      const tileColors = [...tileGradient.matchAll(/rgba?\([^)]+\)|color\(srgb[^)]+\)/g)].map((m) => parseColor(m[0]));
      expect(tileColors.some((c) => colorDistance(c, expected.cyan) <= 1), 'the tile keeps its cyan floor').toBe(true);
      expect(tileColors.some((c) => colorDistance(c, expected.cyanStrong) <= 1), 'the tile keeps its cyan-strong ceiling').toBe(true);
      await expectColor(fgOf(tile), expected.onAccent, 'identity tile glyph');

      await expectColor(fgOf(dialog.locator('#fl-take-comping-modal-title')), expected.text, 'title');
      await expectAaContrast(dialog.locator('#fl-take-comping-modal-title'), 'title');
      const subtitle = header.locator('p').first();
      await expectColor(fgOf(subtitle), expected.text3, 'subtitle');
      await expectAaContrast(subtitle, 'subtitle');

      // ---- The empty state (the only state the shipped default project can
      //      reach: take groups are created by the recording pipeline) ----
      const empty = body.locator(':scope > div').first();
      await expectColor(bgOf(empty), expected.canvas, 'empty-state inset');
      await expectColor(borderTopOf(empty), expected.border, 'empty-state border');
      const emptyIcon = empty.locator('svg').first();
      await expectColor(fgOf(emptyIcon), expected.text3, 'empty-state icon');
      await expectAaContrast(emptyIcon, 'empty-state icon');
      const emptyHeading = empty.locator('p').first();
      await expect(emptyHeading).toHaveText('No take groups found');
      await expectColor(fgOf(emptyHeading), expected.text2, 'empty-state heading');
      await expectAaContrast(emptyHeading, 'empty-state heading');
      const emptyHint = empty.locator('p').nth(1);
      await expect(emptyHint).toHaveText('Record multiple takes on the same track to create take groups');
      await expectColor(fgOf(emptyHint), expected.text3, 'empty-state hint');
      await expectAaContrast(emptyHint, 'empty-state hint');

      const footerNote = footer.locator('div').first();
      await expect(footerNote).toHaveText('0 take groups · 0 total takes');
      await expectColor(fgOf(footerNote), expected.text3, 'footer note');
      await expectAaContrast(footerNote, 'footer note');

      const done = footer.locator('button:has-text("Done")');
      await expectColor(bgOf(done), expected.cyan, 'Done CTA fill');
      await expectColor(fgOf(done), expected.onAccent, 'Done CTA on-colour');
      await expectAaContrast(done, 'Done CTA on-colour');
      await expectNonTextContrast(bgOf(done), expected.header, 'Done CTA against the footer band');

      const close = header.locator('button[aria-label="Close take comping"]');
      await expectColor(fgOf(close), expected.text3, 'close control idle');
      await expectAaContrast(close, 'close control idle');
      await close.hover();
      await expectColor(fgOf(close), expected.text, 'close control hovered');
      await expectColor(bgOf(close), expected.hoverWash, 'close control hover wash');

      // ---- Keyboard: initial focus and the shared focus ring ----
      // The only focusable controls in the empty state are the close and Done
      // buttons, in DOM order.
      const activeText = (): Promise<string> => page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 24) ?? '');
      const outlineOf = (): (() => Promise<Outline>) => () => page.evaluate(() => {
        const c = getComputedStyle(document.activeElement as Element);
        return { color: c.outlineColor, width: c.outlineWidth, style: c.outlineStyle };
      });

      expect(await activeText(), 'the dialog opens with focus on its close control').toBe('Close take comping');

      await page.keyboard.press('Tab');
      expect(await activeText(), 'Tab moves to the Done action').toBe('Done');
      await expectFocusRing(outlineOf(), expected.accent, 'Done button focus ring');

      // Escape dismisses; the themed app stays behind the themed scrim.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // Reopening shows the themed empty state again.
      const reopened = await openTakeComping(page);
      await expectColor(bgOf(reopened.locator(':scope > div')), expected.panel, 'reopened panel surface');
      await expect(reopened.locator('.custom-scrollbar p').first()).toHaveText('No take groups found');
      await expectColor(bgOf(reopened.locator('.custom-scrollbar > div').first()), expected.canvas, 'reopened empty-state inset');
    });
  }
});
