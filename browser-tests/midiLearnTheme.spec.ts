/**
 * UI-03L — MIDI Learn Light/Dark theme regression, run in a real Chromium
 * against the actual Vite application (no simulation, no stubbed styles).
 *
 * Every expected color below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. Two details of the real browser drive the helpers:
 *
 *   - Surfaces that come from a `color-mix()` token serialize as
 *     `color(srgb r g b / a)` and float-round slightly differently between
 *     reads, so colors are compared through a normalizing parser with a
 *     one-unit tolerance instead of an exact string match.
 *   - Several controls carry a Tailwind `transition` class, so a single
 *     computed-style read right after a click catches a mid-transition value.
 *     `expectColor` therefore retries until the value settles, which is the
 *     standard Playwright auto-retrying pattern rather than a fixed sleep.
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

/** Retrying color assertion: tolerates float rounding and CSS transitions. */
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

interface Outline { color: string; width: string; style: string }

/** Returns null for formats this suite does not model — a control carrying a
    Tailwind `transition` class reports a mid-transition outline color that
    Chromium may serialize as `oklab(...)`. Returning null keeps the retry
    polling instead of throwing on a value that is about to change. */
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

const bgOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor);
const fgOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).color);
const borderTopOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).borderTopColor);
const borderBottomOf = (locator: Locator) => (): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).borderBottomColor);

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
 * matters: form controls and the CC chip own an opaque surface, while text
 * nodes are transparent and inherit theirs from a card.
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
 * washes (the armed badge and the learn banner) must be composited: comparing
 * against their raw un-flattened color would measure the wrong surface.
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

const expectAaContrast = async (locator: Locator, label: string): Promise<void> => {
  const { foreground, stack } = await readBackgroundStack(locator);
  const surface = effectiveSurface(stack);
  const ratio = contrastRatio(parseColor(foreground), surface);
  expect(ratio, `${label}: ${foreground} on ${cssColor(surface)} = ${ratio.toFixed(2)}:1`)
    .toBeGreaterThanOrEqual(4.5);
};

const openMidiLearn = async (page: Page): Promise<Locator> => {
  // The MIDI Learn modal is opened from the transport tool overflow menu; its
  // items are portalled and only exist once the menu is open.
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-midi-learn-btn').click();
  const dialog = page.locator('#fl-midi-learn-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('UI-03L MIDI Learn theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, MIDI status colors, binding flow, and focus states`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* storage is optional */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      const dialog = await openMidiLearn(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'fl-midi-learn-modal-title');
      await expect(dialog.locator('#fl-midi-learn-modal-title')).toHaveText('MIDI CONTROLLER LEARN & MAPPING');

      // Resolved token values, read from the running app in each theme.
      const expected = mode === 'dark'
        ? {
            scrim: rgba(5, 7, 12, 0.66),
            panel: rgba(25, 28, 37),
            header: rgba(31, 36, 49),
            surface2: rgba(32, 36, 48),
            surface3: rgba(38, 43, 56),
            canvas: rgba(21, 24, 33),
            border: rgba(43, 48, 64),
            text: rgba(244, 245, 248),
            text2: rgba(174, 181, 196),
            text3: rgba(139, 149, 168),
            accent: rgba(155, 138, 251),
            onAccent: rgba(13, 15, 22),
            danger: rgba(255, 95, 109),
          }
        : {
            scrim: rgba(24, 32, 45, 0.55),
            panel: rgba(255, 255, 255),
            header: rgba(231, 235, 242),
            surface2: rgba(244, 246, 250),
            surface3: rgba(232, 236, 243),
            canvas: rgba(244, 246, 250),
            border: rgba(201, 208, 220),
            text: rgba(24, 32, 45),
            text2: rgba(70, 82, 103),
            text3: rgba(91, 104, 121),
            accent: rgba(101, 82, 206),
            onAccent: rgba(255, 255, 255),
            danger: rgba(189, 38, 56),
          };

      const panel = dialog.locator(':scope > div');
      const header = panel.locator(':scope > div').first();
      const footer = panel.locator(':scope > div').last();
      const body = panel.locator('.custom-scrollbar');

      // The scrim is the shared themed overlay token, not a dark-only black fill.
      await expectColor(bgOf(dialog), expected.scrim, 'dialog scrim');

      // Chrome surfaces resolve from the active palette.
      await expectColor(bgOf(panel), expected.panel, 'panel surface');
      await expectColor(bgOf(header), expected.header, 'header band');
      await expectColor(bgOf(footer), expected.header, 'footer band');
      await expectColor(borderTopOf(panel), expected.border, 'panel border');
      await expectColor(borderBottomOf(header), expected.border, 'header border');
      await expectColor(fgOf(panel), expected.text2, 'panel body text');

      const hardwareCard = body.locator(':scope > div').first();
      const hardwareInset = hardwareCard.locator(':scope > div').last();
      await expectColor(bgOf(hardwareCard), expected.surface2, 'hardware card');
      await expectColor(bgOf(hardwareInset), expected.canvas, 'hardware inset');
      await expectColor(fgOf(hardwareCard.locator('span').first()), expected.text2, 'section label');

      // No hardware is attached in headless Chromium, so the WebMIDI-ready hint
      // renders. It must not claim a live connection with the success green.
      await expect(hardwareInset).toContainText('WebMIDI ready.');
      await expectColor(fgOf(hardwareInset.locator('svg').first()), expected.accent, 'idle WebMIDI hint icon');
      await expectColor(fgOf(hardwareInset.locator('span').first()), expected.text2, 'WebMIDI hint text');
      await expectAaContrast(hardwareInset.locator('span').first(), 'WebMIDI hint text');
      await expectAaContrast(hardwareCard.locator('span').first(), 'section label');

      // Form controls are legible themed insets in both palettes.
      const ccInput = body.locator('input[type="number"]');
      const selects = body.locator('select');
      await expect(ccInput).toHaveValue('1');
      await expectColor(bgOf(ccInput), expected.canvas, 'CC input surface');
      await expectColor(fgOf(ccInput), expected.text, 'CC input text');
      await expectColor(borderTopOf(ccInput), expected.border, 'CC input border');
      await expectAaContrast(ccInput, 'CC input text');
      expect(await selects.count()).toBeGreaterThanOrEqual(2);
      await expectColor(bgOf(selects.first()), expected.canvas, 'target select surface');
      await expectColor(fgOf(selects.first()), expected.text, 'target select text');

      // Neutral idle controls: the standby badge and the arm toggle.
      const badge = header.locator('span.font-mono').first();
      await expect(badge).toHaveText('STANDBY');
      await expectColor(bgOf(badge), expected.surface3, 'standby badge');
      await expectColor(fgOf(badge), expected.text3, 'standby badge text');
      await expectAaContrast(badge, 'standby badge text');
      const armToggle = header.getByRole('button', { name: /START MIDI LEARN/ });
      await expectColor(bgOf(armToggle), expected.surface3, 'idle arm toggle');
      await expectColor(fgOf(armToggle), expected.text2, 'idle arm toggle text');
      await expectAaContrast(armToggle, 'idle arm toggle text');

      // Contrast: title, subtitle, field labels and the footer note all clear
      // WCAG AA on the surface they actually sit on.
      await expectAaContrast(dialog.locator('#fl-midi-learn-modal-title'), 'modal title');
      await expectAaContrast(header.locator('p'), 'header subtitle');
      await expectAaContrast(body.locator('label').first(), 'field label');
      await expectAaContrast(footer.locator('span').first(), 'footer CC reference note');

      // Arming MIDI Learn keeps the armed state visually distinct from idle and
      // moves onto the accent wash rather than a fixed orange.
      await armToggle.click();
      await expect(badge).toHaveText('LEARN ACTIVE');
      const armedWash = { ...expected.accent, a: 0.16 };
      await expectColor(bgOf(badge), armedWash, 'armed badge wash');
      await expectColor(borderTopOf(badge), { ...expected.accent, a: 0.48 }, 'armed badge border');
      // The armed label uses the primary text token: accent-on-accent-wash
      // measures only 4.23:1 (Dark) / 3.90:1 (Light) over the header band, so
      // the accent wash plus border carries the armed identity instead.
      await expectColor(fgOf(badge), expected.text, 'armed badge text');
      await expectAaContrast(badge, 'armed badge label');
      // Measured independently of the DOM: accent-on-accent-wash would be
      // ${'4.23:1'} in Dark and 3.90:1 in Light here, below the AA floor.
      expect(contrastRatio(expected.accent, composite(armedWash, expected.header)),
        'accent text on the armed wash (the rejected alternative)').toBeLessThan(4.5);

      const banner = body.locator('div.animate-pulse');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('Waiting for a MIDI CC');
      await expectColor(bgOf(banner), armedWash, 'learn banner wash');
      await expectColor(borderTopOf(banner), { ...expected.accent, a: 0.48 }, 'learn banner border');
      await expectColor(fgOf(banner.locator('svg').first()), expected.accent, 'learn banner icon');
      await expectColor(fgOf(banner.locator('span').first()), expected.text, 'learn banner text');
      await expectAaContrast(banner.locator('span').first(), 'learn banner text');
      // The accent icon stays distinguishable against the wash flattened onto
      // the panel behind it (WCAG non-text contrast, 3:1).
      const bannerSurface = composite(armedWash, expected.panel);
      expect(contrastRatio(expected.accent, bannerSurface),
        `learn banner icon on ${cssColor(bannerSurface)}`).toBeGreaterThanOrEqual(3);

      const stopToggle = header.getByRole('button', { name: /STOP LEARN/ });
      await expectColor(bgOf(stopToggle), expected.accent, 'armed toggle fill');
      await expectColor(fgOf(stopToggle), expected.onAccent, 'armed toggle label');
      await expectAaContrast(stopToggle, 'armed toggle label');

      // Disarming returns to the idle state: the selection state is reversible.
      await stopToggle.click();
      await expect(badge).toHaveText('STANDBY');
      await expect(banner).toBeHidden();
      await expectColor(bgOf(badge), expected.surface3, 'disarmed badge');

      // Manual controller assignment still works after the chrome was tokenised.
      await expect(body.getByText('ACTIVE MIDI CC BINDINGS (2)')).toBeVisible();
      await ccInput.fill('21');
      const bindCta = body.getByRole('button', { name: /Bind CC/ });
      await expectColor(bgOf(bindCta), expected.accent, 'bind CTA fill');
      await expectColor(fgOf(bindCta), expected.onAccent, 'bind CTA label');
      await expectAaContrast(bindCta, 'bind CTA label');
      await bindCta.click();

      const toast = dialog.getByText(/Bound MIDI CC #21 to/);
      await expect(toast).toBeVisible();
      const toastBar = toast.locator('xpath=ancestor::div[contains(@class,"shadow-md")][1]');
      await expectColor(bgOf(toastBar), expected.accent, 'status toast fill');
      await expectColor(fgOf(toastBar), expected.onAccent, 'status toast text');
      await expectAaContrast(toastBar.locator('span'), 'status toast text');

      // The binding is published: the list grows and the new row is named.
      await expect(body.getByText('ACTIVE MIDI CC BINDINGS (3)')).toBeVisible();
      const ccChips = body.locator('div.font-mono.font-bold');
      await expect(ccChips.filter({ hasText: 'CC 21' })).toHaveCount(1);
      await expect(dialog.locator('button[aria-label^="Remove MIDI CC"]')).toHaveCount(3);

      // The CC identity chip keeps the accent on a recessed themed inset.
      const ccChip = ccChips.filter({ hasText: 'CC 21' });
      await expectColor(bgOf(ccChip), expected.surface3, 'CC identity chip');
      await expectColor(fgOf(ccChip), expected.accent, 'CC identity chip text');
      await expectAaContrast(ccChip, 'CC identity chip text');
      await expectAaContrast(ccChip.locator('xpath=following-sibling::div/span[1]'), 'binding name text');
      await expectAaContrast(ccChip.locator('xpath=following-sibling::div/span[2]'), 'binding target text');

      // Destructive controls stay red, and their hover state is visible.
      const clearAll = body.getByRole('button', { name: 'Clear All' });
      await expectColor(fgOf(clearAll), expected.danger, 'Clear All');
      await expectAaContrast(clearAll, 'Clear All');
      const removeCc21 = dialog.locator('button[aria-label="Remove MIDI CC 21 binding"]');
      await expectColor(fgOf(removeCc21), expected.text3, 'resting delete control');
      await removeCc21.hover();
      await expectColor(fgOf(removeCc21), expected.danger, 'hovered delete control');
      // This control is icon-only, so WCAG 1.4.11 non-text contrast (3:1) is the
      // applicable criterion rather than the 4.5:1 text threshold. The measured
      // Dark value is 4.46:1 on the hover-lifted row surface and Light is
      // 4.85:1, both well clear of 3:1. The text-bearing destructive control
      // (Clear All) is held to 4.5:1 above.
      const hoveredDeletePair = await readBackgroundStack(removeCc21);
      const hoveredDeleteRatio = contrastRatio(
        parseColor(hoveredDeletePair.foreground),
        effectiveSurface(hoveredDeletePair.stack),
      );
      expect(hoveredDeleteRatio, `hovered delete icon contrast = ${hoveredDeleteRatio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(3);

      // Removing the binding publishes through the same mutation path.
      await removeCc21.click();
      await expect(body.getByText('ACTIVE MIDI CC BINDINGS (2)')).toBeVisible();
      await expect(dialog.locator('button[aria-label="Remove MIDI CC 21 binding"]')).toHaveCount(0);

      // Keyboard focus stays visible on the themed controls.
      await ccInput.focus();
      const readOutline = (target: Locator): (() => Promise<Outline>) => () =>
        target.evaluate((element) => {
          const cs = getComputedStyle(element);
          return { color: cs.outlineColor, width: cs.outlineWidth, style: cs.outlineStyle };
        });
      await expectFocusRing(readOutline(ccInput), expected.accent, 'CC input focus ring');

      // Tabbing forward from the CC input reaches the bind CTA with a visible
      // ring, so the focus order and the focus style both survive the migration.
      let reachedCta = false;
      for (let step = 0; step < 8 && !reachedCta; step += 1) {
        await page.keyboard.press('Tab');
        reachedCta = await page.evaluate(() => {
          const active = document.activeElement;
          return Boolean(active instanceof HTMLButtonElement && active.textContent?.includes('Bind CC'));
        });
      }
      expect(reachedCta, 'Tab reaches the Bind CC control inside the dialog').toBe(true);
      // The Bind CC control carries a `transition` class, so its outline color
      // is read through the retrying helper rather than in a single sample.
      await expectFocusRing(() => page.evaluate(() => {
        const cs = getComputedStyle(document.activeElement!);
        return { color: cs.outlineColor, width: cs.outlineWidth, style: cs.outlineStyle };
      }), expected.accent, 'Bind CC focus ring');

      // The neutral Done control keeps a themed hover shift.
      const done = footer.getByRole('button', { name: 'Done' });
      await expectColor(bgOf(done), expected.surface3, 'Done button');
      await expectAaContrast(done, 'Done button label');
      await done.hover();
      await expect.poll(bgOf(done), { message: 'the Done button hover shifts its surface' })
        .not.toBe(cssColor(expected.surface3));

      // Escape closes the dialog without touching the theme.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      // Reopening keeps the surviving bindings: the state update persisted.
      const reopened = await openMidiLearn(page);
      await expect(reopened.getByText('ACTIVE MIDI CC BINDINGS (2)')).toBeVisible();
      const reopenedChips = reopened.locator('div.font-mono.font-bold');
      await expect(reopenedChips.filter({ hasText: 'CC 1' })).toHaveCount(1);
      await expect(reopenedChips.filter({ hasText: 'CC 7' })).toHaveCount(1);
      await expect(reopenedChips.filter({ hasText: 'CC 21' })).toHaveCount(0);
      await reopened.getByRole('button', { name: 'Close MIDI learn' }).click();
      await expect(reopened).toBeHidden();
    });
  }
});
