/**
 * UI-03O — Orientation lock screen Light/Dark theme regression, run in a real
 * Chromium at a portrait phone-sized viewport, which is the only state in which
 * the screen exists (it self-detects `innerHeight > innerWidth` on a touch or
 * narrow device inside an effect).
 *
 * Every expected color below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The screen deliberately stays outside the shared dialog frame,
 * so this spec asserts it renders no dialog semantics, then dismisses it
 * through its own "Continue Anyway" path and checks the theme is untouched.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

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

/**
 * Retrying color assertion: tolerates `color-mix()` float rounding and the
 * mid-transition values a Tailwind `transition` class produces right after an
 * interaction. The poll message is built eagerly, so it names the expectation;
 * Playwright reports the failing per-channel distance alongside the label.
 */
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

interface Outline {
  color: string;
  width: string;
  style: string;
}

/**
 * Returns null for formats this suite does not model — a control carrying a
 * Tailwind `transition` class reports a mid-transition outline color that
 * Chromium may serialize as `oklab(...)`. Returning null keeps the retry
 * polling instead of throwing on a value that is about to change.
 */
const tryParseColor = (value: string): Rgba | null => {
  if (!/^(?:rgb|rgba|color\(srgb)/.test(value.trim())) return null;
  try {
    return parseColor(value);
  } catch {
    return null;
  }
};

const bgOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor);
const fgOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).color);
const borderTopOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).borderTopColor);
const borderBottomOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).borderBottomColor);
const opacityOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).opacity);

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

/**
 * Collects the element's own background plus every ancestor background, so the
 * effective surface can be composited in Node. Starting at the element itself
 * matters: form controls and chips own an opaque surface, while text nodes are
 * transparent and inherit theirs from a card.
 */
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

/**
 * Flattens the stack onto the first opaque layer. Translucent `color-mix()`
 * washes must be composited: comparing against their raw un-flattened color
 * would measure the wrong surface.
 */
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

/** WCAG AA for text: 4.5:1 against the surface the text actually sits on. */
const expectAaContrast = async (locator: Locator, label: string): Promise<void> => {
  const { foreground, stack } = await readBackgroundStack(locator);
  const surface = effectiveSurface(stack);
  const ratio = contrastRatio(parseColor(foreground), surface);
  expect(ratio, `${label}: ${foreground} on ${cssColor(surface)} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
};

/** WCAG 1.4.11 for functional non-text UI: 3:1 against its effective surface. */
const expectNonTextContrast = async (locator: Locator, label: string): Promise<void> => {
  const { foreground, stack } = await readBackgroundStack(locator);
  const surface = effectiveSurface(stack);
  const ratio = contrastRatio(parseColor(foreground), surface);
  expect(ratio, `${label}: ${foreground} on ${cssColor(surface)} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
};

/** Every color Chromium serializes inside a `background-image`. */
const colorsInImage = (value: string): Rgba[] => {
  const found: Rgba[] = [];
  const pattern =
    /(?:rgb|rgba)\(\s*[\d.]+[^)]*\)|color\(srgb\s+[\d.]+\s+[\d.]+\s+[\d.]+(?:\s*\/\s*[\d.]+)?\s*\)/g;
  for (const match of value.match(pattern) ?? []) {
    const parsed = tryParseColor(match);
    if (parsed) found.push(parsed);
  }
  return found;
};

/** Asserts a gradient stop resolves through the expected theme token. */
const expectImageContains = async (
  locator: Locator,
  expected: Rgba,
  label: string,
  tolerance = 2,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        const image = await locator.evaluate((element) => getComputedStyle(element).backgroundImage);
        const colors = colorsInImage(image);
        if (colors.length === 0) return Number.MAX_SAFE_INTEGER;
        return Math.min(...colors.map((color) => colorDistance(color, expected)));
      },
      {
        message: `${label}: expected the resolved gradient to contain ${describeColor(expected)}`,
        timeout: 5_000,
        intervals: [50],
      },
    )
    .toBeLessThanOrEqual(tolerance);
};

type Mode = 'dark' | 'light';

const openApp = async (page: Page, mode: Mode): Promise<void> => {
  await page.addInitScript((value: string) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* storage is optional */
    }
  }, mode);
  await page.goto(APP_URL);
  await page.waitForSelector('#root > *', { state: 'attached' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
};

const readOutline = (target: Locator) => (): Promise<Outline> =>
  target.evaluate((element) => {
    const cs = getComputedStyle(element);
    return { color: cs.outlineColor, width: cs.outlineWidth, style: cs.outlineStyle };
  });

/** Retrying focus-ring assertion: a solid 2px ring on the theme focus token. */
const expectFocusRing = async (read: () => Promise<Outline>, accent: Rgba, label: string): Promise<void> => {
  const expected = { ...accent, a: 0.78 };
  await expect
    .poll(
      async () => {
        const outline = await read();
        if (outline.style !== 'solid' || outline.width !== '2px') return Number.MAX_SAFE_INTEGER;
        const parsed = tryParseColor(outline.color);
        return parsed === null ? Number.MAX_SAFE_INTEGER : colorDistance(parsed, expected);
      },
      {
        message: `${label}: expected a 2px solid ring at ${describeColor(expected)}`,
        timeout: 5_000,
        intervals: [50],
      },
    )
    .toBeLessThanOrEqual(2);
};

const TOKENS = {
  dark: {
    bg: rgba(17, 19, 26),
    surface2: rgba(32, 36, 48),
    surface3: rgba(38, 43, 56),
    border: rgba(43, 48, 64),
    text: rgba(244, 245, 248),
    text2: rgba(174, 181, 196),
    text3: rgba(139, 149, 168),
    accent: rgba(155, 138, 251),
    onAccent: rgba(13, 15, 22),
    success: rgba(98, 215, 164),
    danger: rgba(255, 95, 109),
  },
  light: {
    bg: rgba(238, 241, 246),
    surface2: rgba(244, 246, 250),
    surface3: rgba(232, 236, 243),
    border: rgba(201, 208, 220),
    text: rgba(24, 32, 45),
    text2: rgba(70, 82, 103),
    text3: rgba(91, 104, 121),
    accent: rgba(101, 82, 206),
    onAccent: rgba(255, 255, 255),
    success: rgba(20, 115, 78),
    danger: rgba(189, 38, 56),
  },
} as const;

test.use({ viewport: { width: 420, height: 900 }, hasTouch: true });

test.describe('UI-03O orientation lock screen theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed veil, illustration, meter meanings and dismissal`, async ({ page }) => {
      await openApp(page, mode);
      const tokens = TOKENS[mode];

      const lock = page.locator('#fl-orientation-lock-overlay');
      await expect(lock).toBeVisible();
      // Full-screen page state, not a dialog: the shell contract owns this.
      await expect(lock).not.toHaveAttribute('role', 'dialog');
      await expect(lock).not.toHaveAttribute('aria-modal', 'true');
      await expect(lock.locator('h1')).toHaveText('ROTATE DEVICE TO LANDSCAPE');
      await expect(
        lock.getByText('APEX STUDIO • LANDSCAPE MODE ONLY'),
      ).toBeVisible();

      // The veil keeps its near-opaque character through the themed background.
      await expectColor(bgOf(lock), { ...tokens.bg, a: 0.96 }, 'lock-screen veil');
      await expectColor(fgOf(lock), tokens.text, 'lock-screen base text');
      const title = lock.locator('h1');
      await expectAaContrast(title, 'lock-screen title');
      const explanation = lock.locator('p').first();
      await expectColor(fgOf(explanation), tokens.text2, 'lock-screen explanation');
      await expectAaContrast(explanation, 'lock-screen explanation');

      // The identity pill keeps the accent wash; its label uses the text token
      // because accent-on-accent-wash measures 4.10:1 in Light (Dark clears it
      // at 5.18:1), below the 4.5:1 floor for this 11px label.
      const pill = lock.getByText('APEX STUDIO • LANDSCAPE MODE ONLY').locator('..');
      await expectColor(bgOf(pill), { ...tokens.accent, a: 0.16 }, 'identity pill wash');
      await expectColor(borderTopOf(pill), { ...tokens.accent, a: 0.48 }, 'identity pill edge');
      await expectColor(fgOf(pill), tokens.text, 'identity pill label');
      await expectAaContrast(pill, 'identity pill label');
      const pillWash = composite({ ...tokens.accent, a: 0.16 }, tokens.bg);
      if (mode === 'light') {
        expect(
          contrastRatio(tokens.accent, pillWash),
          'accent text on the identity wash (the rejected alternative)',
        ).toBeLessThan(4.5);
      } else {
        expect(
          contrastRatio(tokens.accent, pillWash),
          'Dark clears the identity wash, which is why the decision is documented',
        ).toBeGreaterThan(4.5);
      }

      // Illustration: the accent glow, the themed phone body, and the four
      // meter bars that keep their success / accent / danger meanings.
      const glow = lock.locator('div.w-28');
      await expectColor(bgOf(glow), { ...tokens.accent, a: 0.16 }, 'illustration glow wash');
      await expectColor(borderTopOf(glow), { ...tokens.accent, a: 0.48 }, 'illustration glow edge');
      const phone = lock.locator('div.w-12');
      await expectColor(bgOf(phone), tokens.surface3, 'phone body surface');
      await expectColor(borderTopOf(phone), tokens.accent, 'phone body edge');
      const bars = phone.locator('div.h-8 > div');
      await expect(bars).toHaveCount(4);
      await expectColor(bgOf(bars.nth(0)), tokens.success, 'meter bar 1');
      await expectColor(bgOf(bars.nth(1)), tokens.accent, 'meter bar 2');
      await expectColor(bgOf(bars.nth(2)), tokens.accent, 'meter bar 3');
      await expectColor(bgOf(bars.nth(3)), tokens.danger, 'meter bar 4');
      const arrowBadge = lock.locator('div[class*="absolute"][class*="-top-3"]');
      await expectColor(bgOf(arrowBadge), tokens.accent, 'rotation badge fill');
      await expectColor(fgOf(arrowBadge), tokens.onAccent, 'rotation badge glyph');

      // Primary CTA keeps the accent identity and a theme-safe on-colour.
      const primary = lock.getByRole('button', { name: /Rotate & Fullscreen/ });
      await expectColor(bgOf(primary), tokens.accent, 'primary CTA fill');
      await expectColor(fgOf(primary), tokens.onAccent, 'primary CTA label');
      await expectAaContrast(primary, 'primary CTA label');
      // No hover assertion here: the context reports a touch device, and
      // Tailwind gates `hover:` utilities behind `@media (hover: hover)`, so the
      // hover step is intentionally inert on the device this screen targets.
      // The unit suite pins the `hover:bg-[var(--apex-accent-strong)]` class.

      // Secondary CTA is a themed neutral that lifts on hover.
      const secondary = lock.getByRole('button', { name: 'Continue Anyway' });
      await expectColor(bgOf(secondary), tokens.surface2, 'secondary CTA surface');
      await expectColor(fgOf(secondary), tokens.text2, 'secondary CTA label');
      await expectColor(borderTopOf(secondary), tokens.border, 'secondary CTA border');
      await expectAaContrast(secondary, 'secondary CTA label');

      // The corner dismiss control keeps its themed neutral treatment.
      const dismiss = lock.locator('button[title="Dismiss lock screen"]');
      await expectColor(bgOf(dismiss), tokens.surface2, 'dismiss control surface');
      await expectColor(fgOf(dismiss), tokens.text3, 'dismiss control glyph');
      await expectNonTextContrast(dismiss, 'dismiss control glyph');

      // The tip and the pill hints stay legible on the veil.
      const tip = lock.getByText(/TIP: Turn off Portrait Orientation Lock/);
      await expectColor(fgOf(tip), tokens.text3, 'tip copy');
      await expectAaContrast(tip, 'tip copy');

      // Committed evidence artifact, regenerated by this spec (repo convention).
      await page.screenshot({ path: `assets/screenshots/ui03o-orientation-lock-${mode}.png` });
      // Dismissing through the shipped path hides the screen and leaves the
      // theme exactly as it was.
      await secondary.click();
      await expect(lock).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      await page.setViewportSize({ width: 900, height: 420 });
      await expect(lock).toBeHidden();
    });
  }
});
