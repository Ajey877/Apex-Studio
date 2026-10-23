/**
 * UI-03N — Sidechain Routing Light/Dark theme regression, run in a real
 * Chromium against the actual Vite application (no simulation, no stubbed
 * styles).
 *
 * Every expected colour below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The same two browser realities the MIDI Learn suite documents
 * drive the helpers here:
 *
 *   - Surfaces that come from a `color-mix()` token (the badge wash, the panel
 *     border, the themed scrim) serialize as `color(srgb r g b / a)` and
 *     float-round slightly differently between reads, so colours are
 *     compared through a normalizing parser with a one-unit tolerance.
 *   - Several controls carry a Tailwind `transition` class, so a computed-style
 *     read taken right after an interaction can catch a mid-transition value
 *     that Chromium serializes as `oklab(...)`. `expectColor` therefore retries
 *     until the value settles.
 *
 * The modal's audio-state vocabulary is asserted explicitly:
 *
 *   - the amber matrix identity (tile, badge, CTAs, source label, meter
 *     read-out) stays on `--apex-gold` with a theme-safe on-colour;
 *   - the destination/ducked read-out stays cyan on `--apex-cyan-text`;
 *   - the attack and ducking-depth read-outs stay green on `--apex-success`;
 *   - the preview meter keeps its VU-style green → amber → red gradient
 *     through `--apex-success`, `--apex-gold` and `--apex-danger`.
 *
 * The routing behaviour — source/destination selects, the exact apply payload
 * toast, the audition toast, Escape and cross-reopen — is asserted alongside
 * the palette, because a theme migration that quietly broke the routing
 * matrix would still pass a colour-only suite.
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

/** Flattens the stack onto the first opaque layer: the identity badge and the
    panel border are translucent `color-mix()` washes and must be composited
    before a ratio means anything. */
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
    sits on. Used for the identity tile and CTAs. */
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

const openSidechain = async (page: Page): Promise<Locator> => {
  // The matrix is opened from the transport tool overflow menu; its items are
  // portalled and only exist once the menu is open.
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-sidechain-matrix-btn').click();
  const dialog = page.locator('#fl-sidechain-routing-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('UI-03N Sidechain Routing theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, amber identity, VU meter, routing and focus states`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* storage is optional */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      const dialog = await openSidechain(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'fl-sidechain-routing-modal-title');
      await expect(dialog.locator('#fl-sidechain-routing-modal-title')).toHaveText('DYNAMIC SIDECHAIN DUCKING & MODULATION MATRIX');

      // Resolved token values, read from the running app in each theme.
      const expected = mode === 'dark'
        ? {
            scrim: rgba(5, 7, 12, 0.66),
            panel: rgba(25, 28, 37),
            header: rgba(31, 36, 49),
            surface2: rgba(32, 36, 48),
            canvas: rgba(21, 24, 33),
            border: rgba(43, 48, 64),
            gridStrong: rgba(52, 58, 74),
            text: rgba(244, 245, 248),
            text2: rgba(174, 181, 196),
            text3: rgba(139, 149, 168),
            gold: rgba(255, 184, 107),
            success: rgba(98, 215, 164),
            cyanText: rgba(103, 217, 255),
            accent: rgba(155, 138, 251),
            onAccent: rgba(13, 15, 22),
            hoverWash: rgba(255, 255, 255, 0.055),
          }
        : {
            scrim: rgba(24, 32, 45, 0.55),
            panel: rgba(255, 255, 255),
            header: rgba(231, 235, 242),
            surface2: rgba(244, 246, 250),
            canvas: rgba(244, 246, 250),
            border: rgba(201, 208, 220),
            gridStrong: rgba(201, 208, 220),
            text: rgba(24, 32, 45),
            text2: rgba(70, 82, 103),
            text3: rgba(91, 104, 121),
            gold: rgba(154, 93, 0),
            success: rgba(20, 115, 78),
            cyanText: rgba(6, 87, 117),
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

      // The matrix identity: a gold-washed panel edge, a solid gold tile.
      await expectColor(borderTopOf(panel), { ...expected.gold, a: 0.4 }, 'panel identity border');
      const tile = header.locator('.w-8').first();
      await expectColor(bgOf(tile), expected.gold, 'identity tile fill');
      await expectColor(fgOf(tile), expected.onAccent, 'identity tile glyph');
      await expectNonTextContrast(bgOf(tile), expected.header, 'identity tile against the header band');

      const badge = header.locator('span.font-mono').first();
      await expect(badge).toHaveText('NOTE-TRIGGER DSP');
      await expectColor(bgOf(badge), { ...expected.gold, a: 0.2 }, 'identity badge wash');
      await expectColor(borderTopOf(badge), { ...expected.gold, a: 0.4 }, 'identity badge edge');
      // The label is theme text, not the identity hue: a same-hue label on its
      // own 20% wash is 4.46:1 in Light and cannot clear AA.
      await expectColor(fgOf(badge), expected.text, 'identity badge text');
      await expectAaContrast(badge, 'identity badge text');

      await expectColor(fgOf(dialog.locator('#fl-sidechain-routing-modal-title')), expected.text, 'title');
      await expectAaContrast(dialog.locator('#fl-sidechain-routing-modal-title'), 'title');
      const subtitle = header.locator('p').first();
      await expectColor(fgOf(subtitle), expected.text3, 'subtitle');
      await expectAaContrast(subtitle, 'subtitle');
      const footerNote = footer.locator('span').first();
      await expect(footerNote).toHaveText('Note-triggered ducking (legacy): each note on the source track fires a fixed envelope. No audio level is measured.');
      await expectColor(fgOf(footerNote), expected.text3, 'footer note');
      await expectAaContrast(footerNote, 'footer note');

      // ---- Signal routing flow card ----
      const flowCard = body.locator(':scope > div').first();
      await expectColor(bgOf(flowCard), expected.canvas, 'routing flow card');
      await expectColor(borderTopOf(flowCard), expected.border, 'routing flow card border');

      const sourceCard = flowCard.locator('.space-y-1\\.5').first();
      const destCard = flowCard.locator('.space-y-1\\.5').last();
      await expectColor(bgOf(sourceCard), expected.surface2, 'source card surface');
      await expectColor(bgOf(destCard), expected.surface2, 'destination card surface');
      const sourceLabel = sourceCard.locator('span').first();
      await expect(sourceLabel).toHaveText('SIDECHAIN TRIGGER SOURCE');
      await expectColor(fgOf(sourceLabel), expected.gold, 'source label keeps the amber meaning');
      await expectAaContrast(sourceLabel, 'source label');
      const destLabel = destCard.locator('span').first();
      await expect(destLabel).toHaveText('TARGET DESTINATION (DUCKED)');
      await expectColor(fgOf(destLabel), expected.cyanText, 'destination label keeps its cyan meaning');
      await expectAaContrast(destLabel, 'destination label');

      const selects = body.locator('select');
      await expect(selects).toHaveCount(2);
      await expect(selects.first()).toHaveValue('1');
      await expect(selects.last()).toHaveValue('2');
      await expectColor(bgOf(selects.first()), expected.canvas, 'select surface');
      await expectColor(fgOf(selects.first()), expected.text, 'select text');

      // The preview meter keeps its VU-style green → amber → red gradient.
      const meterFill = flowCard.locator('.w-20 > div');
      const gradient = await bgImageOf(meterFill)();
      expect(gradient, 'the meter fill is a gradient').toContain('linear-gradient');
      const gradientColors = [...gradient.matchAll(/rgba?\([^)]+\)|color\(srgb[^)]+\)/g)].map((m) => m[0]);
      expect(gradientColors.length, 'the gradient carries stops').toBeGreaterThanOrEqual(2);
      const flatGradient = gradientColors.map(parseColor);
      const successInGradient = flatGradient.some((c) => colorDistance(c, expected.success) <= 1);
      const goldInGradient = flatGradient.some((c) => colorDistance(c, expected.gold) <= 1);
      // The red ceiling is `--apex-danger`, not a Tailwind red: #ff5f6d Dark,
      // #bd2638 Light.
      const dangerInGradient = flatGradient.some((c) =>
        colorDistance(c, mode === 'dark' ? rgba(255, 95, 109) : rgba(189, 38, 56)) <= 1,
      );
      expect(successInGradient, 'the meter gradient keeps its green floor').toBe(true);
      expect(goldInGradient, 'the meter gradient keeps its amber middle').toBe(true);
      expect(dangerInGradient, 'the meter gradient keeps its red ceiling').toBe(true);
      const meterLabel = flowCard.locator('[data-testid="sidechain-measured-reduction"]');
      // No detector is attached in note-triggered mode: the read-out says so
      // instead of animating a value that is not being applied.
      await expect(meterLabel).toHaveText('no measurement');
      await expectColor(fgOf(meterLabel), expected.gold, 'meter read-out keeps the amber meaning');
      await expectAaContrast(meterLabel, 'meter read-out');
      await expect(flowCard.locator('[data-testid="sidechain-meter-caption"]'))
        .toHaveText('note-triggered — no level measurement');
      const meterTrack = flowCard.locator('.w-20');
      await expectColor(bgOf(meterTrack), expected.gridStrong, 'meter track');

      // ---- The five implemented parameter cards (Phase 9A) ----
      const cards = body.locator('.grid > div');
      await expect(cards).toHaveCount(5);
      await expect(cards.nth(0)).toContainText('DETECTOR THRESHOLD');
      await expect(cards.nth(1)).toContainText('RATIO');
      await expect(cards.nth(2)).toContainText('DUCK DEPTH');
      await expect(cards.nth(3)).toContainText('ATTACK SPEED');
      await expect(cards.nth(4)).toContainText('RELEASE (RECOVERY)');
      for (let i = 0; i < 5; i += 1) {
        await expectColor(bgOf(cards.nth(i)), expected.surface2, `parameter card ${i + 1} surface`);
      }
      const thresholdValue = cards.nth(0).locator('.font-mono');
      await expect(thresholdValue).toHaveText('-18 dBFS');
      await expectColor(fgOf(thresholdValue), expected.gold, 'threshold read-out keeps the amber meaning');
      await expectAaContrast(thresholdValue, 'threshold read-out');
      const duckValue = cards.nth(2).locator('.font-mono');
      await expect(duckValue).toHaveText('85%');
      await expectColor(fgOf(duckValue), expected.gold, 'ducking depth read-out keeps the amber meaning');
      await expectAaContrast(duckValue, 'ducking depth read-out');
      const attackValue = cards.nth(3).locator('.font-mono');
      await expect(attackValue).toHaveText('5 ms');
      await expectColor(fgOf(attackValue), expected.success, 'attack read-out keeps its green meaning');
      await expectAaContrast(attackValue, 'attack read-out');
      const releaseValue = cards.nth(4).locator('.font-mono');
      await expect(releaseValue).toHaveText('120 ms');
      await expectColor(fgOf(releaseValue), expected.cyanText, 'release read-out keeps its cyan meaning');
      await expectAaContrast(releaseValue, 'release read-out');

      const duckRange = cards.nth(2).locator('input[type="range"]');
      await expect(duckRange).toHaveAttribute('min', '0');
      await expect(duckRange).toHaveAttribute('max', '1');
      await expect(duckRange).toHaveAttribute('step', '0.01');
      await expect(cards.nth(0).locator('input[type="range"]')).toHaveAttribute('min', '-60');
      await expect(cards.nth(0).locator('input[type="range"]')).toHaveAttribute('max', '0');
      await expect(cards.nth(1).locator('input[type="range"]')).toHaveAttribute('min', '1');
      await expect(cards.nth(1).locator('input[type="range"]')).toHaveAttribute('max', '20');
      await expect(cards.nth(3).locator('input[type="range"]')).toHaveAttribute('min', '1');
      await expect(cards.nth(3).locator('input[type="range"]')).toHaveAttribute('max', '50');
      await expect(cards.nth(4).locator('input[type="range"]')).toHaveAttribute('min', '20');
      await expect(cards.nth(4).locator('input[type="range"]')).toHaveAttribute('max', '500');

      // ---- CTAs ----
      const audition = header.locator('button:has-text("Audition Pump")');
      const apply = footer.locator('button:has-text("Apply Sidechain Matrix")');
      for (const [label, button] of [['Audition Pump', audition], ['Apply Sidechain Matrix', apply]] as const) {
        await expectColor(bgOf(button), expected.gold, `${label} fill`);
        await expectColor(fgOf(button), expected.onAccent, `${label} on-colour`);
        await expectAaContrast(button, `${label} on-colour`);
        await expectNonTextContrast(bgOf(button), expected.header, `${label} against the band`);
      }
      const close = header.locator('button[aria-label="Close sidechain routing"]');
      await expectColor(fgOf(close), expected.text3, 'close control idle');
      await expectAaContrast(close, 'close control idle');
      await close.hover();
      await expectColor(fgOf(close), expected.text, 'close control hovered');
      await expectColor(bgOf(close), expected.hoverWash, 'close control hover wash');

      // ---- Interaction: the routing matrix still publishes the exact payload ----
      await apply.click();
      const toast = panel.locator(':scope > div').nth(1);
      await expect(toast).toContainText('Applied note-triggered sidechain ducking to Snares & Claps (Source: Kick / 808)');
      await expectColor(bgOf(toast), expected.gold, 'status toast fill');
      await expectColor(fgOf(toast), expected.onAccent, 'status toast text');
      await expectAaContrast(toast.locator('span'), 'status toast text');

      // The audition plays the pump bass and reports its envelope preview.
      await audition.click();
      const auditionToast = panel.locator(':scope > div').nth(1);
      await expect(auditionToast).toContainText('Auditioning Sidechain Ducking Envelope...');

      // ---- Interaction: the sliders still drive the read-outs ----
      await duckRange.fill('0.5');
      await expect(cards.nth(2).locator('.font-mono')).toHaveText('50%');
      await cards.nth(3).locator('input[type="range"]').fill('25');
      await expect(cards.nth(3).locator('.font-mono')).toHaveText('25 ms');

      // ---- Interaction: the source select still re-points the toast ----
      await selects.first().selectOption('0');
      await apply.click();
      await expect(panel.locator(':scope > div').nth(1)).toContainText('Applied note-triggered sidechain ducking to Snares & Claps (Source: Master)');

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // Reopening shows the themed matrix again. The component stays mounted
      // between openings, so its local state (the re-pointed source select,
      // the edited depth) survives the close — pre-existing behaviour this
      // migration neither fixes nor changes.
      const reopened = await openSidechain(page);
      await expectColor(bgOf(reopened.locator(':scope > div')), expected.panel, 'reopened panel surface');
      await expect(reopened.locator('select').first()).toHaveValue('0');
      await expect(reopened.locator('.grid > div').nth(2).locator('.font-mono')).toHaveText('50%');

      // ---- Keyboard: initial focus, tab order and the shared focus ring ----
      const activeText = (): Promise<string> => page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 24) ?? '');
      const outlineOf = (): (() => Promise<Outline>) => () => page.evaluate(() => {
        const c = getComputedStyle(document.activeElement as Element);
        return { color: c.outlineColor, width: c.outlineWidth, style: c.outlineStyle };
      });

      // The trap opens on the header's primary action.
      expect(await activeText(), 'the dialog opens with focus on its primary action').toBe('Audition Pump');
      // A pointer click must not paint a focus ring — :focus-visible is keyboard-only.
      expect(
        await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle),
        'a pointer-focused control shows no ring',
      ).toBe('none');

      await page.keyboard.press('Tab');
      expect(await activeText(), 'Tab moves to the close control').toBe('Close sidechain routing');
      await expectFocusRing(outlineOf(), expected.accent, 'close button focus ring');

      await page.keyboard.press('Escape');
      await expect(reopened).toHaveCount(0);
    });
  }
});
