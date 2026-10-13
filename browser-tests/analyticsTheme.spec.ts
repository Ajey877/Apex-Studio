/**
 * UI-03O — Studio telemetry modal Light/Dark theme regression, run in a real
 * Chromium against the actual Vite application (no simulation, no stubbed
 * styles).
 *
 * Every expected color below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The Phase 68 F4 truthfulness contract (recorded session time,
 * project-owned version, and the exhaustive backup-state matrix) is owned by
 * `src/components/phase68.projectStatisticsTruthfulness.test.tsx`; this spec
 * pins the rendered paint, the status tones, and both ways the dialog closes.
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
    scrim: rgba(5, 7, 12, 0.66),
    surface: rgba(25, 28, 37),
    surface2: rgba(32, 36, 48),
    header: rgba(31, 36, 49),
    border: rgba(43, 48, 64),
    text: rgba(244, 245, 248),
    text2: rgba(174, 181, 196),
    text3: rgba(139, 149, 168),
    accent: rgba(155, 138, 251),
    success: rgba(98, 215, 164),
  },
  light: {
    scrim: rgba(24, 32, 45, 0.55),
    surface: rgba(255, 255, 255),
    surface2: rgba(244, 246, 250),
    header: rgba(231, 235, 242),
    border: rgba(201, 208, 220),
    text: rgba(24, 32, 45),
    text2: rgba(70, 82, 103),
    text3: rgba(91, 104, 121),
    accent: rgba(101, 82, 206),
    success: rgba(20, 115, 78),
  },
} as const;

const openAnalytics = async (page: Page): Promise<Locator> => {
  await page.locator('#application-menu-project').click();
  await expect(page.locator('#application-menu-project-menu')).toBeVisible();
  await page.locator('#application-menu-command-project\\.statistics').click();
  const dialog = page.locator('#analytics-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('UI-03O studio telemetry modal theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, honest metrics, status tones and closing`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await openApp(page, mode);
      const tokens = TOKENS[mode];

      const dialog = await openAnalytics(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'analytics-modal-title');
      await expect(dialog.locator('#analytics-modal-title')).toHaveText('STUDIO TELEMETRY & PRODUCTION METRICS');
      await expect(dialog.getByText('Time Tracking, Arranger Density & Performance Stats')).toBeVisible();

      const panel = dialog.locator(':scope > div');
      const header = panel.locator(':scope > div').first();
      const body = panel.locator(':scope > div').nth(1);

      await expectColor(bgOf(dialog), tokens.scrim, 'dialog scrim');
      await expectColor(bgOf(panel), tokens.surface, 'panel surface');
      await expectColor(bgOf(header), tokens.header, 'header band');
      await expectColor(borderTopOf(panel), tokens.border, 'panel border');
      await expectColor(borderBottomOf(header), tokens.border, 'header divider');
      await expectColor(fgOf(panel), tokens.text2, 'panel body text');
      await expectColor(fgOf(header.locator('p')), tokens.text3, 'header subtitle');
      await expectAaContrast(dialog.locator('#analytics-modal-title'), 'modal title');
      await expectAaContrast(header.locator('p'), 'header subtitle');

      // Stopwatch banner: themed inset, accent clock, honest session value.
      const banner = body.locator(':scope > div').first();
      await expectColor(bgOf(banner), tokens.surface2, 'stopwatch banner');
      await expectColor(borderTopOf(banner), tokens.border, 'stopwatch banner border');
      const clock = banner.locator('div.rounded-lg').first();
      await expectColor(bgOf(clock), { ...tokens.accent, a: 0.16 }, 'clock inset wash');
      await expectColor(fgOf(clock.locator('svg')), tokens.accent, 'clock glyph');
      const bannerLabel = banner.getByText('Recorded Studio Session Time');
      await expectColor(fgOf(bannerLabel), tokens.text3, 'stopwatch label');
      await expectAaContrast(bannerLabel, 'stopwatch label');
      // The banner prints the project's own recorded time (the shipped preset
      // records one) in the themed read-out style — never a fabricated value.
      const sessionValue = banner.locator('div.font-mono').first();
      await expect(sessionValue).toHaveText(/^\d{2}:\d{2}:\d{2}$|^Not recorded$/);
      await expectColor(fgOf(sessionValue), tokens.text, 'session value');
      await expectAaContrast(sessionValue, 'session value');

      // The FLOW STATE badge keeps its green identity on the success wash; the
      // label follows the text token because success-on-wash measures 4.32:1 in
      // Light, below the 10px bold label's AA floor.
      const badge = banner.getByText('FLOW STATE');
      await expectColor(bgOf(badge), { ...tokens.success, a: 0.16 }, 'flow state wash');
      await expectColor(borderTopOf(badge), { ...tokens.success, a: 0.48 }, 'flow state edge');
      await expectColor(fgOf(badge), tokens.text, 'flow state label');
      await expectAaContrast(badge, 'flow state label');
      const flowWash = composite({ ...tokens.success, a: 0.16 }, tokens.surface2);
      if (mode === 'light') {
        expect(
          contrastRatio(tokens.success, flowWash),
          'success text on the flow-state wash (the rejected alternative)',
        ).toBeLessThan(4.5);
      } else {
        expect(
          contrastRatio(tokens.success, flowWash),
          'Dark clears the flow-state wash, which is why the decision is documented',
        ).toBeGreaterThan(4.5);
      }

      // Stat grid: every card is a themed inset with legible labels.
      const stats = body.locator('div.grid.grid-cols-2').first();
      const statCards = stats.locator(':scope > div');
      await expect(statCards).toHaveCount(4);
      for (const label of ['Total Notes', 'Active Channels', 'Arranged Clips', 'Project BPM']) {
        await expect(stats.getByText(label, { exact: true })).toBeVisible();
      }
      await expectColor(bgOf(statCards.first()), tokens.surface2, 'stat card');
      await expectColor(borderTopOf(statCards.first()), tokens.border, 'stat card border');
      const statLabel = statCards.first().locator('span');
      await expectColor(fgOf(statLabel), tokens.text3, 'stat label');
      await expectAaContrast(statLabel, 'stat label');
      // Identity read-outs keep the accent; neutral read-outs keep the text step.
      const notesValue = statCards.nth(0).locator('div.font-mono');
      const clipsValue = statCards.nth(2).locator('div.font-mono');
      await expectColor(fgOf(notesValue), tokens.accent, 'accent read-out');
      await expectAaContrast(notesValue, 'accent read-out');
      await expectColor(fgOf(clipsValue), tokens.text, 'neutral read-out');
      await expectAaContrast(clipsValue, 'neutral read-out');

      // Details card: the backup row reports a real, observable state.
      const details = body.locator(':scope > div').nth(2);
      await expectColor(bgOf(details), tokens.surface2, 'details card');
      await expect(details.getByText('Project ID:')).toBeVisible();
      await expect(details.getByText('Project Format Version:')).toBeVisible();
      const backupRow = details.getByText('Offline Backup Status:');
      await expectColor(fgOf(backupRow), tokens.text3, 'backup row label');
      await expectAaContrast(backupRow, 'backup row label');
      const backupStatus = details.locator('span.font-mono').last();
      await expect(backupStatus).toHaveText(/No offline backup yet|\d+ offline backups? · newest /, {
        timeout: 5_000,
      });
      // With no failure and no pending read, the settled tone is the success tone.
      await expectColor(fgOf(backupStatus), tokens.success, 'backup status tone');
      await expectAaContrast(backupStatus, 'backup status tone');

      // Committed evidence artifact, regenerated by this spec (repo convention).
      await page.screenshot({ path: `assets/screenshots/ui03o-analytics-${mode}.png` });
      // Close control, Escape, and the theme stays put.
      const close = dialog.getByRole('button', { name: 'Close analytics' });
      await expectColor(fgOf(close), tokens.text3, 'close control idle');
      await expectAaContrast(close, 'close control idle');
      await close.hover();
      await expectColor(fgOf(close), tokens.text, 'close control hovered');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      // Reopening reports the same observable state (nothing was invented).
      const reopened = await openAnalytics(page);
      await expect(reopened.locator('span.font-mono').last()).toHaveText(
        /No offline backup yet|\d+ offline backups? · newest /,
        { timeout: 5_000 },
      );
      await reopened.getByRole('button', { name: 'Close analytics' }).click();
      await expect(reopened).toBeHidden();
    });
  }
});
