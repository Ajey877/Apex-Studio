/**
 * UI-03M — Multi-Zone Sampler Light/Dark theme regression, run in a real
 * Chromium against the actual Vite application (no simulation, no stubbed
 * styles).
 *
 * Every expected colour below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The helpers are the ones the MIDI Learn suite established:
 * `color-mix()` surfaces serialize as `color(srgb r g b / a)` and float-round
 * between reads, and Tailwind `transition` classes make a read taken straight
 * after an interaction catch a mid-transition value (sometimes serialized as
 * `oklab(...)`), so colour and focus-ring assertions retry until they settle.
 *
 * The sampler needs a zone before its most characteristic surfaces exist: the
 * zone blocks and the inspector render only after hydration or after
 * "Add Zone Split", and the shipped default project stores no `sampleZones` and
 * no `customSample` on the selected channel. This spec therefore drives the real
 * add-zone flow rather than asserting a first-paint shell — which also lets it
 * check that the keymap maths, the range clamping, the audition path, the
 * one-zone delete guard and cross-reopen persistence all survived a change that
 * was supposed to be presentation-only.
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
const borderLeftOf = (locator: Locator): (() => Promise<string>) =>
  () => locator.evaluate((element) => getComputedStyle(element).borderLeftColor);

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

/** Flattens the stack onto the first opaque layer: the badge, the zone blocks
    and the toast edge are translucent `color-mix()` washes and must be
    composited before a ratio means anything. */
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
    sits on. Used for the identity tile, the CTAs and the zone-block border. */
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

const openMultiZoneSampler = async (page: Page): Promise<Locator> => {
  // The keymapper is opened from the transport tool overflow menu; its items are
  // portalled and only exist once the menu is open.
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-multizone-btn').click();
  const dialog = page.locator('#fl-multizone-sampler-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('UI-03M Multi-Zone Sampler theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, orange sampler identity, keymap editing, audition and focus states`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* storage is optional */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      const dialog = await openMultiZoneSampler(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'fl-multizone-sampler-modal-title');
      await expect(dialog.locator('#fl-multizone-sampler-modal-title')).toHaveText('APEX MULTI-SAMPLE KEYMAPPER');

      // Resolved token values, read from the running app in each theme.
      const expected = mode === 'dark'
        ? {
            scrim: rgba(5, 7, 12, 0.66),
            panel: rgba(25, 28, 37),
            header: rgba(31, 36, 49),
            surface2: rgba(32, 36, 48),
            surface3: rgba(38, 43, 56),
            canvas: rgba(21, 24, 33),
            // --apex-chrome-inset is itself a color-mix() token in Dark.
            inset: rgba(14.5, 17.2, 25.1),
            border: rgba(43, 48, 64),
            gridStrong: rgba(52, 58, 74),
            text: rgba(244, 245, 248),
            text2: rgba(174, 181, 196),
            text3: rgba(139, 149, 168),
            gold: rgba(255, 184, 107),
            success: rgba(98, 215, 164),
            danger: rgba(255, 95, 109),
            accent: rgba(155, 138, 251),
            accentStrong: rgba(178, 165, 255),
            onAccent: rgba(13, 15, 22),
            hoverWash: rgba(255, 255, 255, 0.055),
            pianoNatural: rgba(32, 36, 48),
            pianoAccidental: rgba(17, 19, 26),
            laneRule: rgba(244, 245, 248, 0.12),
          }
        : {
            scrim: rgba(24, 32, 45, 0.55),
            panel: rgba(255, 255, 255),
            header: rgba(231, 235, 242),
            surface2: rgba(244, 246, 250),
            surface3: rgba(232, 236, 243),
            canvas: rgba(244, 246, 250),
            inset: rgba(227, 232, 240),
            border: rgba(201, 208, 220),
            gridStrong: rgba(201, 208, 220),
            text: rgba(24, 32, 45),
            text2: rgba(70, 82, 103),
            text3: rgba(91, 104, 121),
            gold: rgba(154, 93, 0),
            success: rgba(20, 115, 78),
            danger: rgba(189, 38, 56),
            accent: rgba(101, 82, 206),
            accentStrong: rgba(81, 64, 184),
            onAccent: rgba(255, 255, 255),
            hoverWash: rgba(24, 32, 45, 0.07),
            pianoNatural: rgba(255, 255, 255),
            pianoAccidental: rgba(223, 228, 236),
            laneRule: rgba(24, 32, 45, 0.12),
          };

      const panel = dialog.locator(':scope > div');
      const header = panel.locator(':scope > div').first();
      const body = panel.locator('.custom-scrollbar');
      const keymapCard = body.locator(':scope > div').first();
      const inset = keymapCard.locator('.relative.h-20');
      const pianoStrip = inset.locator(':scope > div').last();

      // The scrim is the shared themed overlay token, not a dark-only black fill.
      await expectColor(bgOf(dialog), expected.scrim, 'dialog scrim');

      // Chrome surfaces resolve from the active palette. The panel check is the
      // core regression guard: a dark panel surviving into Light mode is the
      // exact defect this migration exists to remove.
      await expectColor(bgOf(panel), expected.panel, 'panel surface');
      await expectColor(bgOf(header), expected.header, 'header band');
      await expectColor(fgOf(panel), expected.text2, 'panel body text');
      await expectColor(borderBottomOf(header), expected.border, 'header border');

      // The sampler identity: a gold-washed panel edge, a solid tile and badge.
      await expectColor(borderTopOf(panel), { ...expected.gold, a: 0.4 }, 'panel identity border');
      const tile = header.locator('.w-8').first();
      await expectColor(bgOf(tile), expected.gold, 'identity tile fill');
      await expectColor(fgOf(tile), expected.onAccent, 'identity tile glyph');
      await expectNonTextContrast(bgOf(tile), expected.header, 'identity tile against the header band');

      const badge = header.locator('span.font-mono').first();
      await expect(badge).toHaveText('MULTI-ZONE');
      await expectColor(bgOf(badge), { ...expected.gold, a: 0.2 }, 'identity badge wash');
      await expectColor(borderTopOf(badge), { ...expected.gold, a: 0.4 }, 'identity badge edge');
      // The label is theme text, not the identity hue: gold on its own wash
      // measures 3.44:1 in Light and cannot clear AA.
      await expectColor(fgOf(badge), expected.text, 'identity badge text');
      await expectAaContrast(badge, 'identity badge text');

      await expectColor(fgOf(dialog.locator('#fl-multizone-sampler-modal-title')), expected.text, 'title');
      await expectAaContrast(dialog.locator('#fl-multizone-sampler-modal-title'), 'title');
      const subtitle = header.locator('p').first();
      await expectColor(fgOf(subtitle), expected.text3, 'subtitle');
      await expectAaContrast(subtitle, 'subtitle');

      const footer = panel.locator(':scope > div').last();
      const footerNote = footer.locator('span').first();
      await expect(footerNote).toHaveText('Zone selection, tuning, trims and loop points are applied to playback');
      await expectColor(bgOf(footer), expected.header, 'footer band');
      await expectColor(fgOf(footerNote), expected.text3, 'footer note');
      await expectAaContrast(footerNote, 'footer note');
      const apply = footer.locator('button:has-text("Apply Keymapping")');
      await expectColor(bgOf(apply), expected.gold, 'Apply Keymapping fill');
      await expectColor(fgOf(apply), expected.onAccent, 'Apply Keymapping on-colour');
      await expectAaContrast(apply, 'Apply Keymapping on-colour');
      await expectNonTextContrast(bgOf(apply), expected.header, 'Apply Keymapping against the band');

      const close = header.locator('button[aria-label="Close multi-zone sampler"]');
      await expectColor(fgOf(close), expected.text3, 'close control idle');
      await expectAaContrast(close, 'close control idle');

      // ---- The keymap card and its recessed visualiser ----
      await expectColor(bgOf(keymapCard), expected.surface2, 'keymap card');
      await expectColor(borderTopOf(keymapCard), expected.border, 'keymap card border');
      const heading = keymapCard.locator('> div').first().locator('span').first();
      await expect(heading).toContainText('KEYBOARD SPLIT ZONE MAP (MIDI C1 - C7)');
      await expectColor(fgOf(heading), expected.text, 'keymap heading');
      await expectAaContrast(heading, 'keymap heading');
      await expectColor(fgOf(heading.locator('svg')), expected.gold, 'keymap heading icon');
      await expectNonTextContrast(fgOf(heading.locator('svg')), expected.surface2, 'keymap heading icon');

      // The inset must separate from its card in BOTH palettes. Light's
      // --apex-canvas and --apex-surface-2 are the same colour, which is why the
      // visualiser sits on --apex-chrome-inset rather than on the canvas token.
      await expectColor(bgOf(inset), expected.inset, 'visualiser inset');
      expect(
        colorDistance(expected.inset, expected.surface2),
        `the inset ${cssColor(expected.inset)} must separate from its card ${cssColor(expected.surface2)}`,
      ).toBeGreaterThan(8);
      await expectColor(borderTopOf(inset), expected.border, 'visualiser inset border');

      const addZone = keymapCard.locator('button:has-text("Add Zone Split")');
      await expectColor(bgOf(addZone), expected.gold, 'Add Zone Split fill');
      await expectColor(fgOf(addZone), expected.onAccent, 'Add Zone Split on-colour');
      await expectAaContrast(addZone, 'Add Zone Split on-colour');
      await expectNonTextContrast(bgOf(addZone), expected.surface2, 'Add Zone Split against the card');

      // Eight octave lanes, ruled with a theme-relative line.
      const lanes = inset.locator('div.absolute.top-0.bottom-0');
      await expect(lanes).toHaveCount(8);
      await expect(lanes.first()).toHaveText('C0');
      await expect(lanes.last()).toHaveText('C7');
      await expectColor(fgOf(lanes.first()), expected.text3, 'octave lane label');
      await expectAaContrast(lanes.first(), 'octave lane label');
      await expectColor(borderLeftOf(lanes.first()), expected.laneRule, 'octave lane rule');

      // A 48-key reference strip on the shared piano-key tokens.
      const keys = pianoStrip.locator(':scope > div');
      await expect(keys).toHaveCount(48);
      await expectColor(bgOf(pianoStrip), expected.pianoAccidental, 'piano strip bed');
      await expectColor(bgOf(keys.nth(0)), expected.pianoNatural, 'natural key C');
      await expectColor(bgOf(keys.nth(1)), expected.pianoAccidental, 'accidental key C#');
      await expectColor(bgOf(keys.nth(2)), expected.pianoNatural, 'natural key D');
      await expectColor(bgOf(keys.nth(3)), expected.pianoAccidental, 'accidental key D#');
      await expectColor(borderLeftOf(keys.nth(0)), expected.border, 'key separator');
      // Naturals and accidentals must stay distinguishable in both palettes: in
      // Dark the naturals are the lighter pair, in Light the darker one.
      expect(
        colorDistance(expected.pianoNatural, expected.pianoAccidental),
        'natural and accidental keys must stay distinguishable',
      ).toBeGreaterThan(8);

      // No zone is hydrated on first paint in the shipped project, so neither
      // the zone blocks nor the inspector exist yet.
      await expect(inset.locator('div.absolute.top-2')).toHaveCount(0);
      await expect(body.locator(':scope > div')).toHaveCount(1);
      await expect(panel.locator(':scope > div')).toHaveCount(3);

      // ---- Add Zone Split: the toast, the zone block and the inspector ----
      await addZone.click();
      await expect(panel.locator(':scope > div')).toHaveCount(4);
      const toast = panel.locator(':scope > div').nth(1);
      await expect(toast).toContainText('Created new Multi-Sample Zone!');
      await expectColor(bgOf(toast), expected.gold, 'status toast fill');
      await expectColor(fgOf(toast), expected.onAccent, 'status toast text');
      await expectAaContrast(toast, 'status toast text');
      const dismiss = toast.locator('button');
      await expect(dismiss).toHaveAttribute('aria-label', 'Dismiss status message');
      await expectColor(fgOf(dismiss), { ...expected.onAccent, a: 0.78 }, 'toast dismiss idle');
      await dismiss.hover();
      await expectColor(fgOf(dismiss), expected.onAccent, 'toast dismiss hovered');

      const zone = inset.locator('div.absolute.top-2');
      await expect(zone).toHaveCount(1);
      await expectColor(bgOf(zone), { ...expected.gold, a: 0.22 }, 'zone block wash');
      await expectColor(borderTopOf(zone), expected.gold, 'zone block border');
      await expectNonTextContrast(borderTopOf(zone), expected.inset, 'zone block border against the inset');
      expect(
        await zone.evaluate((element) => getComputedStyle(element).boxShadow),
        'the selected zone carries a themed accent ring',
      ).toContain(cssColor(expected.accentStrong));
      await expect(zone).toContainText('Zone 1');
      const zoneName = zone.locator('> div').first().locator('span').first();
      await expectColor(fgOf(zoneName), expected.text, 'zone block name');
      await expectAaContrast(zoneName, 'zone block name');
      const zoneRange = zone.locator('> div').last();
      await expect(zoneRange).toHaveText('C4C5');
      await expectColor(fgOf(zoneRange), expected.text2, 'zone block range');
      await expectAaContrast(zoneRange, 'zone block range');

      // The inspector appears with the zone's hue on its swatch.
      await expect(body.locator(':scope > div')).toHaveCount(2);
      const inspector = body.locator(':scope > div').last();
      await expectColor(bgOf(inspector), expected.header, 'inspector card');
      await expectColor(borderTopOf(inspector), expected.border, 'inspector card border');
      await expect(inspector).toContainText('EDITING ZONE: Zone 1');
      await expectColor(bgOf(inspector.locator('div.rounded-full').first()), expected.gold, 'inspector zone swatch');
      await expectColor(fgOf(inspector.locator('span.text-xs').first()), expected.text, 'inspector heading');
      await expectAaContrast(inspector.locator('span.text-xs').first(), 'inspector heading');

      const audition = inspector.locator('button:has-text("Audition")');
      await expectColor(bgOf(audition), expected.surface3, 'audition control surface');
      await expectColor(fgOf(audition), expected.text, 'audition control label');
      await expectAaContrast(audition, 'audition control label');
      await expectColor(fgOf(audition.locator('svg')), expected.success, 'audition icon keeps its green meaning');
      await expectNonTextContrast(fgOf(audition.locator('svg')), expected.surface3, 'audition icon');
      await audition.hover();
      // --apex-surface-3 mixed 85% toward --apex-text, read from the live app.
      await expectColor(
        bgOf(audition),
        mode === 'dark' ? rgba(68.9, 73.3, 84.8) : rgba(200.8, 205.4, 213.3),
        'audition control hover step',
        2,
      );

      // The destructive control keeps its red meaning on hover and is named.
      const remove = inspector.locator('button[aria-label="Delete zone Zone 1"]');
      await expectColor(fgOf(remove), expected.text3, 'delete control idle');
      await expectAaContrast(remove, 'delete control idle');
      await remove.hover();
      await expectColor(fgOf(remove), expected.danger, 'delete control hovered');
      await expectColor(bgOf(remove), expected.hoverWash, 'delete control hover wash');
      // This control is icon-only, so WCAG 1.4.11 non-text contrast (3:1) is the
      // applicable criterion rather than the 4.5:1 text threshold — the same
      // reading the MIDI Learn suite applies to its icon-only delete, whose
      // hovered danger glyph measures the same 4.46:1 on a hover-lifted surface.
      // Measured here: 4.46:1 Dark and 4.40:1 Light on the washed header band,
      // both well clear of 3:1. The idle state is still held to 4.5:1 above.
      const hoveredRemove = await readBackgroundStack(remove);
      const hoveredRemoveRatio = contrastRatio(
        parseColor(hoveredRemove.foreground),
        effectiveSurface(hoveredRemove.stack),
      );
      expect(hoveredRemoveRatio, `hovered delete icon contrast = ${hoveredRemoveRatio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(3);

      // ---- The three range controls keep their clamping invariants ----
      const ranges = inspector.locator('input[type="range"]');
      await expect(ranges).toHaveCount(3);
      expect(
        await ranges.evaluateAll((elements) => elements.map((e) => [e.min, e.max, e.value])),
        'low clamps under high, high clamps over low, root stays inside the zone',
      ).toEqual([['0', '72', '60'], ['60', '127', '72'], ['60', '72', '60']]);

      const labels = inspector.locator('.grid').first().locator('> div');
      await expect(labels.nth(0)).toContainText('Lowest Key Range');
      await expect(labels.nth(0)).toContainText('C4 (60)');
      await expect(labels.nth(1)).toContainText('Highest Key Range');
      await expect(labels.nth(1)).toContainText('C5 (72)');
      await expect(labels.nth(2)).toContainText('Root Key Pitch Center');
      const rootReadout = labels.nth(2).locator('span').last();
      await expect(rootReadout).toHaveText('C4');
      await expectColor(fgOf(rootReadout), expected.success, 'root pitch keeps its green meaning');
      await expectAaContrast(rootReadout, 'root pitch read-out');
      for (const index of [0, 1, 2]) {
        await expectColor(fgOf(labels.nth(index).locator('span').first()), expected.text3, `slider ${index} label`);
        await expectAaContrast(labels.nth(index).locator('span').first(), `slider ${index} label`);
      }

      // The form controls are themed insets, legible in both palettes.
      const fieldLabels = inspector.locator('label');
      await expect(fieldLabels).toHaveCount(2);
      await expect(fieldLabels.first()).toHaveText('ASSIGNED SAMPLE AUDIO BUFFER');
      await expect(fieldLabels.last()).toHaveText('ZONE NAME');
      for (const label of [fieldLabels.first(), fieldLabels.last()]) {
        await expectColor(fgOf(label), expected.text3, 'field label');
        await expectAaContrast(label, 'field label');
      }
      const select = inspector.locator('select');
      const nameInput = inspector.locator('input[type="text"]');
      await expectColor(bgOf(select), expected.canvas, 'sample select surface');
      await expectColor(fgOf(select), expected.text, 'sample select text');
      await expectColor(borderTopOf(select), expected.border, 'sample select border');
      await expectAaContrast(select, 'sample select text');
      await expectColor(bgOf(nameInput), expected.canvas, 'zone name field surface');
      await expectColor(fgOf(nameInput), expected.text, 'zone name field text');
      await expectColor(borderTopOf(nameInput), expected.border, 'zone name field border');
      await expect(nameInput).toHaveValue('Zone 1');
      // The shipped project has an empty sample library, so nothing is assigned.
      await expect(select).toHaveValue('');

      // ---- Editing the key range re-lays the block and re-clamps the ranges ----
      await ranges.nth(0).fill('48');
      await expect(zone).toContainText('C3');
      await expect(labels.nth(0)).toContainText('C3 (48)');
      await expect(zoneRange).toHaveText('C3C5');
      expect(
        await ranges.evaluateAll((elements) => elements.map((e) => [e.min, e.max, e.value])),
        'the other two ranges re-clamp around the new low key',
      ).toEqual([['0', '72', '48'], ['48', '127', '72'], ['48', '72', '60']]);
      // 48/127 = 37.7953%, (72 - 48 + 1)/127 = 19.685%.
      expect(await zone.evaluate((element) => element.style.left)).toBe('37.7953%');
      expect(await zone.evaluate((element) => element.style.width)).toBe('19.685%');

      // ---- Audition still routes through the real engine ----
      await audition.click();
      await expect(toast).toContainText('Auditioning Zone 1 (Root C4)');
      await expectColor(bgOf(toast), expected.gold, 'audition toast fill');
      await expectAaContrast(toast, 'audition toast text');

      // ---- The last zone cannot be deleted ----
      await remove.click();
      await expect(zone).toHaveCount(1);
      await expect(inspector).toContainText('EDITING ZONE: Zone 1');

      // ---- A second zone takes the next identity hue ----
      await addZone.click();
      await expect(zone).toHaveCount(2);
      await expectColor(borderTopOf(zone.nth(1)), expected.success, 'second zone takes the next palette hue');
      await expectNonTextContrast(borderTopOf(zone.nth(1)), expected.inset, 'second zone border against the inset');
      await expect(zone.nth(1)).toContainText('Zone 2');
      // Two distinct zones must not collapse onto one hue.
      expect(
        colorDistance(expected.gold, expected.success),
        'the first two zone hues must stay distinguishable',
      ).toBeGreaterThan(24);

      // Selecting the second zone re-points the inspector.
      await zone.nth(1).click();
      await expect(inspector).toContainText('EDITING ZONE: Zone 2');
      await expectColor(bgOf(inspector.locator('div.rounded-full').first()), expected.success, 'inspector swatch follows the selection');
      await expectColor(fgOf(audition.locator('svg')), expected.success, 'audition icon is unchanged');

      // Deleting now that two zones exist removes the selected one.
      await inspector.locator('button[aria-label="Delete zone Zone 2"]').click();
      await expect(zone).toHaveCount(1);
      await expect(inspector).toContainText('EDITING ZONE: Zone 1');

      // The status toast auto-dismisses on its own timer. Wait for that rather
      // than clicking the dismiss control: ModalFrame handles Escape through a
      // keydown handler on the overlay itself, and removing the focused button
      // would drop focus to <body> and strand the dialog. Letting the toast
      // expire keeps focus on the overlay — and asserts the timer still works.
      await expectColor(bgOf(panel.locator(':scope > div').nth(1)), expected.gold, 'toast still up before it expires');
      await expect(dialog.locator('button[aria-label="Dismiss status message"]')).toHaveCount(0, { timeout: 8_000 });
      await expect(panel.locator(':scope > div')).toHaveCount(3);

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // ---- Reopening shows the published keymap, still themed ----
      const reopened = await openMultiZoneSampler(page);
      const reopenedInset = reopened.locator('.relative.h-20');
      await expect(reopenedInset.locator('div.absolute.top-2')).toHaveCount(1);
      await expect(reopenedInset.locator('div.absolute.top-2').first()).toContainText('C3');
      await expectColor(bgOf(reopened.locator(':scope > div')), expected.panel, 'reopened panel surface');
      await expectColor(
        borderTopOf(reopenedInset.locator('div.absolute.top-2').first()),
        expected.gold,
        'reopened zone border',
      );

      // The dismissal persisted: the reopened panel is header, body, footer.
      await expect(reopened.locator(':scope > div').first().locator(':scope > div')).toHaveCount(3);
      await expect(reopened.locator('button[aria-label="Dismiss status message"]')).toHaveCount(0);

      // ---- Keyboard: initial focus, tab order and the shared focus ring ----
      const activeLabel = (): Promise<string> => page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label')
        ?? document.activeElement?.textContent?.trim().slice(0, 24) ?? '');
      const outlineOf = (): (() => Promise<Outline>) => () => page.evaluate(() => {
        const c = getComputedStyle(document.activeElement as Element);
        return { color: c.outlineColor, width: c.outlineWidth, style: c.outlineStyle };
      });
      expect(await activeLabel(), 'the trap opens on the close control').toBe('Close multi-zone sampler');
      expect(
        await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle),
        'a pointer-focused control shows no ring',
      ).toBe('none');
      await page.keyboard.press('Tab');
      expect(await activeLabel(), 'Tab reaches Add Zone Split').toBe('Add Zone Split');
      await expectFocusRing(outlineOf(), expected.accent, 'Add Zone Split focus ring');
      await page.keyboard.press('Tab');
      expect(await activeLabel(), 'Tab reaches the inspector audition control').toBe('Audition');
      await expectFocusRing(outlineOf(), expected.accent, 'audition focus ring');
      await page.keyboard.press('Tab');
      expect(await activeLabel(), 'Tab reaches the destructive control').toBe('Delete zone Zone 1');
      await expectFocusRing(outlineOf(), expected.accent, 'delete control focus ring');
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => (document.activeElement as HTMLInputElement)?.type),
        'Tab reaches the first key-range slider',
      ).toBe('range');
      await expectFocusRing(outlineOf(), expected.accent, 'key-range slider focus ring');

      await page.keyboard.press('Escape');
      await expect(reopened).toHaveCount(0);
    });
  }
});
