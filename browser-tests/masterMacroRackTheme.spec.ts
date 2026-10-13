/**
 * UI-03M — Master Macro Rack Light/Dark theme regression, run in a real
 * Chromium against the actual Vite application (no simulation, no stubbed
 * styles).
 *
 * Every expected colour below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The same two browser realities the MIDI Learn suite documents
 * drive the helpers here:
 *
 *   - Surfaces that come from a `color-mix()` token (the identity badge wash,
 *     the panel border, the themed scrim) serialize as `color(srgb r g b / a)`
 *     and float-round slightly differently between reads, so colours are
 *     compared through a normalizing parser with a one-unit tolerance.
 *   - Several controls carry a Tailwind `transition` class, so a computed-style
 *     read taken right after an interaction can catch a mid-transition value
 *     that Chromium serializes as `oklab(...)`. `expectColor`/`expectFocusRing`
 *     therefore retry until the value settles.
 *
 * Two things this suite deliberately asserts about *data* rather than chrome:
 *
 *   - `macro.color` is persisted project state (`ProjectState.macroKnobs[].color`).
 *     It must survive the migration byte-for-byte on the value arc, the
 *     selected-card border, the range accent and the mapping swatch — in both
 *     themes, because a theme migration has no business rewriting a stored
 *     identity colour.
 *   - The knob values, the arc geometry, the mapping targets, Add Macro
 *     publication and cross-reopen persistence must be unchanged. A theme
 *     migration that quietly broke the rack would still pass a colour-only
 *     suite, so the interaction cycle is asserted alongside the palette.
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

/** Returns null for formats this suite does not model, so polling continues
    instead of throwing on a value that is about to change. */
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
    sits on. Used for the identity tile, the selection ring and the arc track. */
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

const openMacroRack = async (page: Page): Promise<Locator> => {
  // The rack is opened from the transport tool overflow menu; its items are
  // portalled and only exist once the menu is open.
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-master-macros-btn').click();
  const dialog = page.locator('#fl-master-macro-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('UI-03M Master Macro Rack theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, green rack identity, persisted macro colours, editing and focus states`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* storage is optional */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      const dialog = await openMacroRack(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'fl-master-macro-modal-title');
      await expect(dialog.locator('#fl-master-macro-modal-title')).toHaveText('MASTER MACRO PERFORMANCE RACK');

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
            gridStrong: rgba(52, 58, 74),
            text: rgba(244, 245, 248),
            text2: rgba(174, 181, 196),
            text3: rgba(139, 149, 168),
            success: rgba(98, 215, 164),
            cyan: rgba(103, 217, 255),
            accent: rgba(155, 138, 251),
            accentStrong: rgba(178, 165, 255),
            onAccent: rgba(13, 15, 22),
            hoverWash: rgba(255, 255, 255, 0.055),
            // The first shipped knob's persisted identity colour.
            macroColor: rgba(255, 110, 0),
          }
        : {
            scrim: rgba(24, 32, 45, 0.55),
            panel: rgba(255, 255, 255),
            header: rgba(231, 235, 242),
            surface2: rgba(244, 246, 250),
            surface3: rgba(232, 236, 243),
            canvas: rgba(244, 246, 250),
            border: rgba(201, 208, 220),
            gridStrong: rgba(201, 208, 220),
            text: rgba(24, 32, 45),
            text2: rgba(70, 82, 103),
            text3: rgba(91, 104, 121),
            success: rgba(20, 115, 78),
            // --apex-cyan-text, the AA variant the chip read-out uses.
            cyan: rgba(6, 87, 117),
            accent: rgba(101, 82, 206),
            accentStrong: rgba(81, 64, 184),
            onAccent: rgba(255, 255, 255),
            hoverWash: rgba(24, 32, 45, 0.07),
            macroColor: rgba(255, 110, 0),
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

      // The rack identity: a success-washed panel edge, a solid tile and badge.
      await expectColor(borderTopOf(panel), { ...expected.success, a: 0.4 }, 'panel identity border');
      const tile = header.locator('.w-8').first();
      await expectColor(bgOf(tile), expected.success, 'identity tile fill');
      await expectColor(fgOf(tile), expected.onAccent, 'identity tile glyph');
      await expectNonTextContrast(bgOf(tile), expected.header, 'identity tile against the header band');

      const badge = header.locator('span.font-mono').first();
      await expect(badge).toHaveText('MULTI-TARGET MATRIX');
      await expectColor(bgOf(badge), { ...expected.success, a: 0.2 }, 'identity badge wash');
      await expectColor(borderTopOf(badge), { ...expected.success, a: 0.4 }, 'identity badge edge');
      // The label is theme text, not the identity hue: a same-hue label on its
      // own wash measures 3.73:1 in Light and cannot clear AA.
      await expectColor(fgOf(badge), expected.text, 'identity badge text');
      await expectAaContrast(badge, 'identity badge text');

      await expectColor(fgOf(dialog.locator('#fl-master-macro-modal-title')), expected.text, 'title');
      await expectAaContrast(dialog.locator('#fl-master-macro-modal-title'), 'title');
      const subtitle = header.locator('p').first();
      await expectColor(fgOf(subtitle), expected.text3, 'subtitle');
      await expectAaContrast(subtitle, 'subtitle');
      const footerNote = footer.locator('span').first();
      await expect(footerNote).toHaveText('Macro Automation Dispatcher Active');
      await expectColor(fgOf(footerNote), expected.text3, 'footer note');
      await expectAaContrast(footerNote, 'footer note');

      // ---- The four shipped knobs ----
      const cards = body.locator('.grid > div');
      await expect(cards).toHaveCount(4);
      await expect(cards.nth(0)).toContainText('DROP BUILDUP (SWEEP)');
      await expect(cards.nth(1)).toContainText('SUB CRUSH & TENSION');
      await expect(cards.nth(2)).toContainText('SPACE & STEREO WIDTH');
      await expect(cards.nth(3)).toContainText('LO-FI VINYL DUCK');

      // The first knob is selected on open: a lighter card, a themed ring, and
      // its persisted identity colour on the border.
      await expectColor(bgOf(cards.nth(0)), expected.surface3, 'selected card surface');
      await expectColor(bgOf(cards.nth(1)), expected.surface2, 'idle card surface');
      await expectColor(borderTopOf(cards.nth(0)), expected.macroColor, 'selected card border (persisted data colour)');
      await expectColor(borderTopOf(cards.nth(1)), expected.border, 'idle card border');
      expect(
        await cards.nth(0).evaluate((element) => getComputedStyle(element).boxShadow),
        'the selected card carries a themed accent ring',
      ).toContain(cssColor(expected.accentStrong));

      // The persisted identity colour survives on the arc and the range accent,
      // byte-for-byte, in both themes — it is project data, not chrome.
      const arc = cards.nth(0).locator('svg path').nth(1);
      await expect(arc).toHaveAttribute('stroke', '#ff6e00');
      await expect(arc).toHaveAttribute('stroke-dasharray', '20, 100');
      await expectColor(
        () => cards.nth(0).locator('input[type="range"]')
          .evaluate((element) => getComputedStyle(element).accentColor),
        expected.macroColor,
        'the rotary slider keeps the persisted identity colour',
      );

      // The arc track is a themed token, so the groove resolves from the active
      // palette instead of the legacy `#25252b`. It is deliberately *not* held
      // to WCAG 1.4.11's 3:1: the track is the groove behind the value, not the
      // value indicator — the same low-contrast relationship the shipped
      // `#25252b`-on-`#18181f` track had (~1.15:1). The value itself is
      // available as AA text in the knob centre and as a percentage, so nothing
      // is conveyed by the groove alone. What must hold is that the groove is
      // still distinguishable from the card it sits on in both palettes.
      const track = cards.nth(0).locator('svg path').first();
      await expectColor(fgOf(track), expected.gridStrong, 'arc track');
      const trackColor = parseColor(await track.evaluate((element) => getComputedStyle(element).color));
      expect(
        colorDistance(trackColor, expected.surface3),
        `arc track ${cssColor(trackColor)} must stay distinguishable from the card ${cssColor(expected.surface3)}`,
      ).toBeGreaterThan(8);

      // Card labels: identity hue removed from text, theme scale restored.
      const mappingsLabel = cards.nth(1).locator('> div').first().locator('span').first();
      await expect(mappingsLabel).toHaveText('2 MAPPINGS');
      await expectColor(fgOf(mappingsLabel), expected.text3, 'mapping count label');
      await expectAaContrast(mappingsLabel, 'mapping count label');
      const valueReadout = cards.nth(1).locator('span.absolute').first();
      await expect(valueReadout).toHaveText('50');
      await expectColor(fgOf(valueReadout), expected.text, 'knob value read-out');
      await expectAaContrast(valueReadout, 'knob value read-out');
      const cardName = cards.nth(1).locator('> span').last();
      await expectColor(fgOf(cardName), expected.text, 'knob name');
      await expectAaContrast(cardName, 'knob name');

      // ---- The mapping matrix ----
      const matrix = body.locator(':scope > div').last();
      await expectColor(bgOf(matrix), expected.header, 'matrix card');
      await expectColor(borderTopOf(matrix), expected.border, 'matrix card border');
      await expect(matrix).toContainText('MAPPED DESTINATIONS FOR:');
      await expect(matrix).toContainText('DROP BUILDUP (SWEEP)');
      await expectColor(fgOf(matrix.locator('strong').first()), expected.text, 'matrix macro name');
      await expectAaContrast(matrix.locator('strong').first(), 'matrix macro name');
      await expectNonTextContrast(fgOf(matrix.locator('svg').first()), expected.header, 'matrix settings icon');

      const rows = matrix.locator('.space-y-2 > div');
      await expect(rows).toHaveCount(2);
      const row = rows.first();
      await expectColor(bgOf(row), expected.canvas, 'mapping row inset');
      await expectColor(borderTopOf(row), expected.border, 'mapping row border');
      await expect(row).toContainText('filter cutoff');
      await expect(row).toContainText('→ Track #1');
      await expect(row).toContainText('MIN:');
      await expect(row).toContainText('MAX:');
      await expectColor(bgOf(row.locator('div.rounded-full').first()), expected.macroColor, 'mapping swatch (persisted data colour)');
      await expectColor(fgOf(row.locator('span').first()), expected.text, 'mapping target label');
      await expectAaContrast(row.locator('span').first(), 'mapping target label');

      // The MAX ceiling keeps its green meaning; the curve chip keeps cyan.
      const metrics = row.locator('> div').last().locator('span');
      await expect(metrics.nth(0)).toContainText('MIN:');
      await expectColor(fgOf(metrics.nth(0)), expected.text3, 'MIN metric');
      await expectAaContrast(metrics.nth(0), 'MIN metric');
      await expectColor(fgOf(metrics.nth(0).locator('strong')), expected.text, 'MIN value');
      await expectAaContrast(metrics.nth(0).locator('strong'), 'MIN value');
      await expectColor(fgOf(metrics.nth(1)), expected.text3, 'MAX metric');
      await expectColor(fgOf(metrics.nth(1).locator('strong')), expected.success, 'MAX ceiling keeps its green meaning');
      await expectAaContrast(metrics.nth(1).locator('strong'), 'MAX ceiling');
      const chip = metrics.nth(2);
      await expect(chip).toHaveText('exponential');
      await expectColor(bgOf(chip), expected.surface3, 'curve chip surface');
      await expectColor(fgOf(chip), expected.cyan, 'curve chip read-out');
      await expectAaContrast(chip, 'curve chip read-out');

      // ---- CTAs ----
      const addMacro = header.locator('button:has-text("Add Macro")');
      const done = footer.locator('button:has-text("Done")');
      const close = header.locator('button[aria-label="Close macro rack"]');
      for (const [label, button] of [['Add Macro', addMacro], ['Done', done]] as const) {
        await expectColor(bgOf(button), expected.success, `${label} fill`);
        await expectColor(fgOf(button), expected.onAccent, `${label} on-colour`);
        await expectAaContrast(button, `${label} on-colour`);
        await expectNonTextContrast(bgOf(button), expected.header, `${label} against the band`);
      }
      await expectColor(fgOf(close), expected.text3, 'close control idle');
      await expectAaContrast(close, 'close control idle');
      await close.hover();
      await expectColor(fgOf(close), expected.text, 'close control hovered');
      await expectColor(bgOf(close), expected.hoverWash, 'close control hover wash');

      // ---- Interaction: selecting another knob re-points the matrix ----
      await cards.nth(1).click();
      await expectColor(bgOf(cards.nth(1)), expected.surface3, 'newly selected card surface');
      await expectColor(bgOf(cards.nth(0)), expected.surface2, 'previously selected card surface');
      await expectColor(borderTopOf(cards.nth(1)), rgba(0, 255, 136), 'newly selected card border (persisted data colour)');
      await expect(matrix).toContainText('MAPPED DESTINATIONS FOR:');
      await expect(matrix).toContainText('SUB CRUSH & TENSION');
      await expect(matrix.locator('.space-y-2 > div').first()).toContainText('channel volume');
      await expect(matrix.locator('.space-y-2 > div').first()).toContainText('→ Track #bass');

      // ---- Interaction: hover feedback on an idle card ----
      // This was dead before UI-03M: an inline `borderColor` on every card beat
      // the `hover:border-*` class, so the idle card never responded.
      await cards.nth(2).hover();
      await expectColor(borderTopOf(cards.nth(2)), expected.gridStrong, 'idle card hover border');
      await expectColor(borderTopOf(cards.nth(3)), expected.border, 'unhovered idle card border');

      // ---- Interaction: the rotary slider still drives the arc and read-out ----
      const range = cards.nth(1).locator('input[type="range"]');
      await expect(range).toHaveAttribute('min', '0');
      await expect(range).toHaveAttribute('max', '1');
      await expect(range).toHaveAttribute('step', '0.01');
      await range.fill('0.8');
      await expect(cards.nth(1).locator('span.absolute').first()).toHaveText('80');
      await expect(cards.nth(1).locator('> div').first()).toContainText('80%');
      await expect(cards.nth(1).locator('svg path').nth(1)).toHaveAttribute('stroke-dasharray', '80, 100');

      // ---- Interaction: Add Macro publishes and the rack persists ----
      await addMacro.click();
      await expect(cards).toHaveCount(5);
      const created = cards.nth(4);
      await expect(created).toContainText('MACRO 5 (CUSTOM)');
      await expect(created).toContainText('1 MAPPINGS');
      // The rotation hands a new knob the fifth persisted identity colour.
      await expectColor(borderTopOf(created), rgba(255, 170, 0), 'new knob border (persisted data colour)');
      await expect(created.locator('svg path').nth(1)).toHaveAttribute('stroke', '#ffaa00');
      await expect(matrix).toContainText('MACRO 5 (CUSTOM)');

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // Reopening must show the published rack: five knobs, the edited value.
      const reopened = await openMacroRack(page);
      const reopenedCards = reopened.locator('.custom-scrollbar .grid > div');
      await expect(reopenedCards).toHaveCount(5);
      await expect(reopenedCards.nth(1)).toContainText('80%');
      await expect(reopenedCards.nth(1).locator('svg path').nth(1)).toHaveAttribute('stroke-dasharray', '80, 100');
      await expect(reopenedCards.nth(4)).toContainText('MACRO 5 (CUSTOM)');
      // The reopened dialog is still themed, not a dark panel in Light mode.
      await expectColor(bgOf(reopened.locator(':scope > div')), expected.panel, 'reopened panel surface');

      // ---- Keyboard: initial focus, tab order and the shared focus ring ----
      const activeLabel = (): Promise<string> => page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label')
        ?? document.activeElement?.textContent?.trim().slice(0, 20) ?? '');
      const activeType = (): Promise<string> => page.evaluate(() =>
        (document.activeElement as HTMLInputElement)?.type ?? document.activeElement?.tagName ?? '');
      const outlineOf = (): (() => Promise<Outline>) => () => page.evaluate(() => {
        const c = getComputedStyle(document.activeElement as Element);
        return { color: c.outlineColor, width: c.outlineWidth, style: c.outlineStyle };
      });

      // The trap opens on the header's primary action.
      expect(await activeLabel(), 'the dialog opens with focus on its primary action').toBe('Add Macro');
      // A pointer click must not paint a focus ring — :focus-visible is keyboard-only.
      expect(
        await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle),
        'a pointer-focused control shows no ring',
      ).toBe('none');

      await page.keyboard.press('Tab');
      expect(await activeLabel(), 'Tab moves to the close control').toBe('Close macro rack');
      await expectFocusRing(outlineOf(), expected.accent, 'close button focus ring');
      await page.keyboard.press('Tab');
      expect(await activeType(), 'Tab reaches the first rotary slider').toBe('range');
      await expectFocusRing(outlineOf(), expected.accent, 'rotary slider focus ring');

      await page.keyboard.press('Escape');
      await expect(reopened).toHaveCount(0);
    });
  }
});
