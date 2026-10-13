/**
 * UI-03O — Desktop app modal Light/Dark theme regression, run in a real
 * Chromium against the actual Vite application (no simulation, no stubbed
 * styles).
 *
 * Every expected color below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. This modal has four tabs; each one is opened here so the tab
 * strip's active/inactive states, the per-tab cards, the CLI command inset and
 * the status toast are all exercised in both themes. The generated Windows ZIP
 * payload is not download-and-inspected here — its byte-for-byte contract is
 * pinned by `src/components/desktopAppThemeUi.test.tsx`, which reads the source
 * constants without touching the filesystem.
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
    surface3: rgba(38, 43, 56),
    canvas: rgba(21, 24, 33),
    header: rgba(31, 36, 49),
    border: rgba(43, 48, 64),
    text: rgba(244, 245, 248),
    text2: rgba(174, 181, 196),
    text3: rgba(139, 149, 168),
    accent: rgba(155, 138, 251),
    accentStrong: rgba(178, 165, 255),
    onAccent: rgba(13, 15, 22),
    cyanText: rgba(103, 217, 255),
    gold: rgba(255, 184, 107),
    success: rgba(98, 215, 164),
    auxText: rgba(175, 150, 217),
  },
  light: {
    scrim: rgba(24, 32, 45, 0.55),
    surface: rgba(255, 255, 255),
    surface2: rgba(244, 246, 250),
    surface3: rgba(232, 236, 243),
    canvas: rgba(244, 246, 250),
    header: rgba(231, 235, 242),
    border: rgba(201, 208, 220),
    text: rgba(24, 32, 45),
    text2: rgba(70, 82, 103),
    text3: rgba(91, 104, 121),
    accent: rgba(101, 82, 206),
    accentStrong: rgba(81, 64, 184),
    onAccent: rgba(255, 255, 255),
    cyanText: rgba(6, 87, 117),
    gold: rgba(154, 93, 0),
    success: rgba(20, 115, 78),
    auxText: rgba(91, 58, 168),
  },
} as const;

const openDesktopApp = async (page: Page): Promise<Locator> => {
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-desktop-app-btn').click();
  const dialog = page.locator('#fl-desktop-app-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

const tab = (dialog: Locator, name: string | RegExp): Locator => dialog.getByRole('button', { name });

test.describe('UI-03O desktop app modal theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, all four tabs, the toast and closing`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      // The CLI tab writes the real clipboard; grant the permission up front so
      // the production path runs without a permission error.
      await page.context().grantPermissions(['clipboard-write'], { origin: APP_URL });
      await openApp(page, mode);
      const tokens = TOKENS[mode];

      const dialog = await openDesktopApp(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'fl-desktop-app-modal-title');
      await expect(dialog.locator('#fl-desktop-app-modal-title')).toHaveText('WINDOWS .EXE & DESKTOP SUITE');

      const panel = dialog.locator(':scope > div');
      const header = panel.locator(':scope > div').first();
      const tabStrip = panel.locator(':scope > div').nth(1);
      const body = panel.locator('.custom-scrollbar');
      const footer = panel.locator(':scope > div').last();

      // The scrim is the shared themed overlay token, not a dark-only fill.
      await expectColor(bgOf(dialog), tokens.scrim, 'dialog scrim');
      await expectColor(bgOf(panel), tokens.surface, 'panel surface');
      await expectColor(bgOf(header), tokens.header, 'header band');
      await expectColor(borderTopOf(panel), { ...tokens.accent, a: 0.48 }, 'panel accent edge');
      await expectColor(borderBottomOf(header), tokens.border, 'header divider');
      await expectColor(fgOf(panel), tokens.text2, 'panel body text');
      await expectColor(fgOf(header.locator('p')), tokens.text3, 'header subtitle');
      await expectAaContrast(dialog.locator('#fl-desktop-app-modal-title'), 'modal title');
      await expectAaContrast(header.locator('p'), 'header subtitle');

      // The identity tile resolves its gradient through the accent family.
      const tile = header.locator('div.rounded-lg').first();
      await expectImageContains(tile, tokens.accent, 'header tile gradient start');
      await expectImageContains(tile, tokens.accentStrong, 'header tile gradient end');
      await expectColor(fgOf(tile), tokens.onAccent, 'header tile glyph');
      // The tile's fill is a gradient, so the glyph is measured against both
      // stops rather than the header band behind it.
      const tileRatio = Math.min(
        contrastRatio(tokens.onAccent, tokens.accent),
        contrastRatio(tokens.onAccent, tokens.accentStrong),
      );
      expect(tileRatio, `header tile glyph on the gradient = ${tileRatio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);

      // The readiness badge keeps the accent wash; its label uses the text token.
      const badge = header.getByText('WINDOWS 10 / 11 NATIVE');
      await expectColor(bgOf(badge), { ...tokens.accent, a: 0.16 }, 'readiness badge wash');
      await expectColor(borderTopOf(badge), { ...tokens.accent, a: 0.48 }, 'readiness badge edge');
      await expectColor(fgOf(badge), tokens.text, 'readiness badge label');
      await expectAaContrast(badge, 'readiness badge label');
      // Measured independently of the DOM: the accent label on this wash is
      // 3.90:1 in Light and 4.23:1 in Dark, below AA in both palettes.
      const badgeWash = composite({ ...tokens.accent, a: 0.16 }, tokens.header);
      expect(
        contrastRatio(tokens.accent, badgeWash),
        `accent text on the ${mode} readiness wash (the rejected alternative)`,
      ).toBeLessThan(4.5);

      await expectColor(bgOf(tabStrip), tokens.canvas, 'tab strip');
      await expectColor(borderBottomOf(tabStrip), tokens.border, 'tab strip divider');

      // Tab 1 — Windows bundle (active by default).
      const windowsTab = tab(dialog, /Windows \.EXE & Launcher Bundle/);
      await expectColor(fgOf(windowsTab), tokens.accent, 'active tab label');
      await expectColor(borderBottomOf(windowsTab), tokens.accent, 'active tab underline');
      await expectAaContrast(windowsTab, 'active tab label');
      const pwaTab = tab(dialog, /1-Click App \(PWA\)/);
      await expectColor(fgOf(pwaTab), tokens.text3, 'inactive tab label');
      await expectAaContrast(pwaTab, 'inactive tab label');
      const downloadCard = body.locator(':scope > div > div').first();
      await expectColor(bgOf(downloadCard), tokens.surface2, 'download card');
      await expectColor(borderTopOf(downloadCard), { ...tokens.accent, a: 0.48 }, 'download card edge');
      const suiteBadge = downloadCard.getByText('READY-TO-USE WINDOWS SUITE');
      await expectColor(bgOf(suiteBadge), { ...tokens.accent, a: 0.16 }, 'windows-suite badge wash');
      await expectColor(fgOf(suiteBadge), tokens.text, 'windows-suite badge label');
      await expectAaContrast(suiteBadge, 'windows-suite badge label');
      const downloadCta = downloadCard.getByRole('button', { name: /Download Windows \.EXE Bundle/ });
      await expectColor(bgOf(downloadCta), tokens.accent, 'download CTA fill');
      await expectColor(fgOf(downloadCta), tokens.onAccent, 'download CTA label');
      await expectAaContrast(downloadCta, 'download CTA label');
      await expect(body.getByText('1-Click Batch Runner')).toBeVisible();
      await expect(body.getByText('PowerShell .EXE Builder')).toBeVisible();
      await expect(body.getByText('Low-Latency Audio Mode')).toBeVisible();
      await expect(body.getByText('How to Use on Any Windows PC (Windows 10 / 11)')).toBeVisible();

      // Tab 2 — PWA: the hardware-readiness triad keeps its distinct meanings.
      await pwaTab.click();
      await expect(tab(dialog, /1-Click App \(PWA\)/)).toHaveClass(/text-\[var\(--apex-accent\)\]/);
      await expectColor(fgOf(pwaTab), tokens.accent, 'active PWA tab');
      const engineReadiness = body.getByText('AUDIO ENGINE LATENCY');
      await expectColor(fgOf(engineReadiness), tokens.text3, 'readiness group label');
      await expectAaContrast(engineReadiness, 'readiness group label');
      const readinessValues = body.locator('span.font-mono.text-sm');
      await expect(readinessValues).toHaveCount(3);
      // The latency read-out reports whatever the engine actually measured, or
      // states that it has not started — never a fabricated number.
      await expect(readinessValues.nth(0)).toHaveText(/base .*output |^ENGINE NOT STARTED$/);
      await expectColor(fgOf(readinessValues.nth(0)), tokens.success, 'engine readiness value');
      await expectAaContrast(readinessValues.nth(0), 'engine readiness value');
      await expect(readinessValues.nth(1)).toHaveText('Unlimited IndexedDB');
      await expectColor(fgOf(readinessValues.nth(1)), tokens.cyanText, 'storage readiness value');
      await expectAaContrast(readinessValues.nth(1), 'storage readiness value');
      await expect(readinessValues.nth(2)).toHaveText('Web Audio graph thread');
      await expectColor(fgOf(readinessValues.nth(2)), tokens.gold, 'threading readiness value');
      await expectAaContrast(readinessValues.nth(2), 'threading readiness value');
      const installCta = body.getByRole('button', { name: /Install Desktop Program/ });
      await expectColor(bgOf(installCta), tokens.accent, 'install CTA fill');
      await expectColor(fgOf(installCta), tokens.onAccent, 'install CTA label');
      await expectAaContrast(installCta, 'install CTA label');

      // Tab 3 — display diagnostics: themed read-outs, aux-tinted sub-labels.
      await tab(dialog, /Desktop Display & Scaling/).click();
      await expect(body.getByText('DESKTOP RESOLUTION & UI COMPATIBILITY DIAGNOSTICS')).toBeVisible();
      await expect(body.getByText('DPI SCALE')).toBeVisible();
      const dpiValue = body.locator('span.font-mono.text-sm').filter({ hasText: /x \(\d+%\)/ });
      await expect(dpiValue).toHaveText(/^[\d.]+x \(\d+%\)$/);
      await expectColor(fgOf(dpiValue), tokens.text, 'DPI read-out');
      await expectAaContrast(dpiValue, 'DPI read-out');
      const depthLabel = body.getByText('Studio Visual Spectrum');
      await expectColor(fgOf(depthLabel), tokens.auxText, 'colour-depth sub-label');
      await expectAaContrast(depthLabel, 'colour-depth sub-label');

      // Tab 4 — CLI commands: inset, coloured comments, and the copy toast.
      await tab(dialog, /CLI Exe Build Commands/).click();
      const cliInset = body.locator('.font-mono').first();
      await expectColor(bgOf(cliInset), tokens.canvas, 'CLI inset');
      await expectColor(borderTopOf(cliInset), tokens.border, 'CLI inset border');
      await expect(body.getByText('# 1. Install packaging tools:')).toBeVisible();
      await expectColor(fgOf(body.getByText('# 1. Install packaging tools:')), tokens.success, 'CLI comment 1');
      await expectColor(fgOf(body.getByText('# 2. Compile Windows .exe Installer:')), tokens.cyanText, 'CLI comment 2');
      await expectColor(fgOf(body.getByText('# 3. Compile Portable Single-File .exe:')), tokens.gold, 'CLI comment 3');
      const copyCommands = body.getByRole('button', { name: /Copy Commands/ });
      await expectColor(bgOf(copyCommands), tokens.surface3, 'copy commands control');
      await expectColor(fgOf(copyCommands), tokens.text, 'copy commands label');
      await expectAaContrast(copyCommands, 'copy commands label');
      await copyCommands.click();
      // The control reports the copy by swapping its own label.
      await expect(body.getByRole('button', { name: 'Copied!' })).toBeVisible();

      // The status toast is a themed accent bar with a named dismiss control.
      const toast = panel.getByText(/Copied Windows \.EXE Build Commands/);
      await expect(toast).toBeVisible();
      const toastBar = panel.locator('div[class*="bg-[var(--apex-accent)]"]').first();
      await expectColor(bgOf(toastBar), tokens.accent, 'status toast fill');
      await expectColor(fgOf(toastBar.locator('span').first()), tokens.onAccent, 'status toast text');
      await expectAaContrast(toastBar.locator('span').first(), 'status toast text');
      await panel.getByRole('button', { name: 'Dismiss status message' }).click();
      await expect(toast).toBeHidden();
      // Dismissing removes the focused element, so focus falls back to <body>.
      // Escape is handled by the overlay's own `onKeyDown` (unchanged on main),
      // so the user returns focus inside the dialog before it closes — this spec
      // does the same and the pre-existing gap is documented in the report.
      await tab(dialog, /CLI Exe Build Commands/).click();

      // Footer note and the themed Close action.
      await expect(footer.getByText('Direct Hardware Driver & Web Audio Subsystem Connected')).toBeVisible();
      const footerClose = footer.getByRole('button', { name: 'Close' });
      await expectColor(bgOf(footerClose), tokens.accent, 'footer close fill');
      await expectColor(fgOf(footerClose), tokens.onAccent, 'footer close label');
      await expectAaContrast(footerClose, 'footer close label');

      // The header close control keeps its themed hover, then Escape closes.
      const close = dialog.getByRole('button', { name: 'Close desktop app' });
      await expectColor(fgOf(close), tokens.text3, 'close control idle');
      await close.hover();
      await expectColor(fgOf(close), tokens.text, 'close control hovered');
      // Committed evidence artifact, regenerated by this spec (repo convention).
      await page.screenshot({ path: `assets/screenshots/ui03o-desktop-app-${mode}.png` });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    });
  }
});
