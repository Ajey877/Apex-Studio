/**
 * UI-03N — Warp Audio Processor Light/Dark theme regression, run in a real
 * Chromium against the actual Vite application (no simulation, no stubbed
 * styles).
 *
 * Every expected colour below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The same two browser realities the MIDI Learn suite documents
 * drive the helpers here:
 *
 *   - Surfaces that come from a `color-mix()` token (the badge wash, the panel
 *     border, the banner edges, the themed scrim) serialize as `color(srgb
 *     r g b / a)` and float-round slightly differently between reads, so
 *     colours are compared through a normalizing parser with a one-unit
 *     tolerance.
 *   - Several controls carry a Tailwind `transition` class, so a computed-style
 *     read taken right after an interaction can catch a mid-transition value
 *     that Chromium serializes as `oklab(...)`. `expectColor` therefore
 *     retries until the value settles.
 *
 * The shipped default project holds pattern clips only, so the live app can
 * reach the *no-selection* and *unsupported-type* (pattern clip) target
 * states, but not the ready state (that needs a recorded/bounced audio clip).
 * The ready state — stored pitch/rate values, the enabled sliders, the
 * audition and apply paths — is pinned by
 * `src/components/warpAudioProcessorThemeUi.test.tsx`, which renders every
 * state in both themes with real audio-clip data, and by
 * `src/components/warpClipTarget.test.ts`. This suite pins what the live app
 * can show:
 *
 *   - the green identity (tile, panel edge, behaviour summary, pitch
 *     read-out) and the gold warning qualifiers;
 *   - the disabled, honest un-actionable states (NOTHING SELECTED,
 *     NO AUDIO CLIP TO WARP, REPITCH CHANGES PITCH AND LENGTH TOGETHER —
 *     WSOLA STRETCH PRESERVES PITCH);
 *   - Phase 7A: the shipped WSOLA stretch card (named algorithm, supported
 *     0.25×–4.00× range, disabled commit CTA without a target) themed with
 *     the same token contract as the repitch controls;
 *   - the theme-aware auditioning-state fill contract (no fixed `bg-white`);
 *   - Escape and the focus contract, including that the disabled preview
 *     button is skipped by the focus trap.
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

/** Flattens the stack onto the first opaque layer: the badge and banner
    washes are translucent `color-mix()` layers and must be composited before
    a ratio means anything. */
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

const openWarpProcessor = async (page: Page): Promise<Locator> => {
  // The processor is opened from the transport tool overflow menu; its items
  // are portalled and only exist once the menu is open.
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-warp-processor-btn').click();
  const dialog = page.locator('#fl-warp-processor-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('UI-03N Warp Audio Processor theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, green identity, honest un-actionable states and focus`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* storage is optional */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      // Phase 7B: capture the transport's authoritative project BPM BEFORE the
      // modal opens — the fit-to-tempo target read-out must equal it (one
      // project tempo, no duplicated setting inside the modal).
      const transportBpm = await page.locator('#fl-bpm-input').inputValue();
      // Phase 7C: the transport's RESOLVED meter (data-meter is written from
      // the same resolveProjectTimeSignature authority the engine plays) — the
      // fit-to-length panel's grid read-out must show exactly this meter.
      const transportMeter = await page.locator('#fl-meter-readout').getAttribute('data-meter');

      const dialog = await openWarpProcessor(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'fl-warp-processor-modal-title');
      await expect(dialog.locator('#fl-warp-processor-modal-title')).toHaveText('AUDIO CLIP PITCH & PLAYBACK RATE');

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
            surface3: rgba(232, 236, 243),
            canvas: rgba(244, 246, 250),
            border: rgba(201, 208, 220),
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

      // The processor identity: a success-washed panel edge and a solid tile.
      await expectColor(borderTopOf(panel), { ...expected.success, a: 0.4 }, 'panel identity border');
      const tile = header.locator('.w-8').first();
      await expectColor(bgOf(tile), expected.success, 'identity tile fill');
      await expectColor(fgOf(tile), expected.onAccent, 'identity tile glyph');

      // The repitch qualifier keeps its gold wash and theme-text label.
      const badge = header.locator('span.font-mono').first();
      await expect(badge).toHaveText('REPITCH — LENGTH NOT PRESERVED');
      await expectColor(bgOf(badge), { ...expected.gold, a: 0.2 }, 'repitch badge wash');
      await expectColor(borderTopOf(badge), { ...expected.gold, a: 0.4 }, 'repitch badge edge');
      await expectColor(fgOf(badge), expected.text, 'repitch badge text');
      await expectAaContrast(badge, 'repitch badge text');
      // Phase 7A: the shipped-stretch badge states the new capability truth.
      const stretchBadge = header.locator('span.font-mono').nth(1);
      await expect(stretchBadge).toHaveText('WSOLA — PITCH-PRESERVING STRETCH');
      await expectColor(bgOf(stretchBadge), { ...expected.success, a: 0.2 }, 'stretch badge wash');
      await expectColor(borderTopOf(stretchBadge), { ...expected.success, a: 0.4 }, 'stretch badge edge');
      await expectColor(fgOf(stretchBadge), expected.text, 'stretch badge text');
      await expectAaContrast(stretchBadge, 'stretch badge text');

      await expectColor(fgOf(dialog.locator('#fl-warp-processor-modal-title')), expected.text, 'title');
      await expectAaContrast(dialog.locator('#fl-warp-processor-modal-title'), 'title');
      const subtitle = header.locator('p').first();
      await expect(subtitle).toHaveText('No audio clip selected');
      await expectColor(fgOf(subtitle), expected.text3, 'subtitle');
      await expectAaContrast(subtitle, 'subtitle');

      // ---- The disabled preview action (no actionable target) ----
      const preview = header.locator('button:has-text("Preview Clip")');
      await expect(preview).toBeDisabled();
      await expect(preview).toHaveCSS('opacity', '0.4');
      await expectColor(bgOf(preview), expected.success, 'preview CTA fill');
      await expectColor(fgOf(preview), expected.onAccent, 'preview CTA on-colour');
      // The auditioning state must not be a fixed white fill: the class
      // contract (checked in the unit suite) resolves to `--apex-text`
      // + `--apex-state-playing-fg`, which is what keeps the state readable
      // in Light.
      const close = header.locator('button[aria-label="Close warp processor"]');
      await expectColor(fgOf(close), expected.text3, 'close control idle');
      await expectAaContrast(close, 'close control idle');
      await close.hover();
      await expectColor(fgOf(close), expected.text, 'close control hovered');
      await expectColor(bgOf(close), expected.hoverWash, 'close control hover wash');

      // ---- The target card and the no-clip banner ----
      const targetCard = body.locator(':scope > div').first();
      await expectColor(bgOf(targetCard), expected.surface2, 'target card surface');
      await expectColor(borderTopOf(targetCard), expected.border, 'target card border');
      await expect(targetCard).toContainText('TARGET CLIP');
      const nothingSelected = targetCard.locator('text=NOTHING SELECTED');
      await expectColor(fgOf(nothingSelected), expected.gold, 'NOTHING SELECTED keeps its amber warning meaning');
      await expectAaContrast(nothingSelected, 'NOTHING SELECTED');

      const noClipBanner = body.locator('text=NO AUDIO CLIP TO WARP').locator('..');
      await expectColor(bgOf(noClipBanner), expected.canvas, 'no-clip banner surface');
      await expectColor(borderTopOf(noClipBanner), { ...expected.gold, a: 0.4 }, 'no-clip banner edge');
      await expectAaContrast(noClipBanner.locator('span').first(), 'no-clip banner heading');
      await expect(noClipBanner).toContainText('Select an audio clip in the Playlist Arranger first');
      await expectAaContrast(noClipBanner.locator('span').nth(1), 'no-clip banner message');

      // ---- The behaviour banner: what each processor really does ----
      const behaviourBanner = body.locator('text=REPITCH CHANGES PITCH AND LENGTH TOGETHER — WSOLA STRETCH PRESERVES PITCH').locator('..');
      await expectColor(bgOf(behaviourBanner), expected.canvas, 'behaviour banner surface');
      await expectColor(borderTopOf(behaviourBanner), { ...expected.gold, a: 0.4 }, 'behaviour banner edge');
      await expectAaContrast(behaviourBanner.locator('span').first(), 'behaviour banner statement');
      const qualifier = behaviourBanner.locator('text=STRETCH COMMITS A NEW AUDIO ASSET · ORIGINAL KEPT FOR UNDO');
      await expectColor(fgOf(qualifier), expected.text3, 'behaviour banner qualifier');
      await expectAaContrast(qualifier, 'behaviour banner qualifier');

      // ---- The control card: green pitch read-out, cyan rate read-out ----
      // (The Phase 7A stretch card is the body's last child; the repitch
      // control card is the one before it.)
      const controlCard = body.locator(':scope > div').nth(-2);
      await expectColor(bgOf(controlCard), expected.surface2, 'control card surface');
      await expect(controlCard).toContainText('PITCH & SPEED (APPLIED TO THIS CLIP)');
      const behaviourSummary = controlCard.locator(':scope > div:first-child span.font-mono');
      await expect(behaviourSummary).toContainText('resampler-style repitch');
      await expectColor(fgOf(behaviourSummary), expected.success, 'behaviour summary keeps its green meaning');
      await expectAaContrast(behaviourSummary, 'behaviour summary');

      const insets = controlCard.locator('.grid > div');
      await expect(insets).toHaveCount(2);
      await expect(insets.nth(0)).toContainText('PITCH OFFSET');
      await expect(insets.nth(1)).toContainText('PLAYBACK RATE');
      for (let i = 0; i < 2; i += 1) {
        await expectColor(bgOf(insets.nth(i)), expected.canvas, `control inset ${i + 1} surface`);
      }
      const pitchValue = insets.nth(0).locator('.font-mono');
      await expect(pitchValue).toHaveText('0 st');
      await expectColor(fgOf(pitchValue), expected.success, 'pitch read-out keeps its green meaning');
      await expectAaContrast(pitchValue, 'pitch read-out');
      const rateValue = insets.nth(1).locator('.font-mono');
      await expect(rateValue).toHaveText('1.00x');
      await expectColor(fgOf(rateValue), expected.cyanText, 'rate read-out keeps its cyan meaning');
      await expectAaContrast(rateValue, 'rate read-out');
      const pitchRange = insets.nth(0).locator('input[type="range"]');
      await expect(pitchRange).toBeDisabled();
      await expect(pitchRange).toHaveAttribute('min', '-24');
      await expect(pitchRange).toHaveAttribute('max', '24');
      const rateRange = insets.nth(1).locator('input[type="range"]');
      await expect(rateRange).toBeDisabled();
      await expect(rateRange).toHaveAttribute('min', '0.25');
      await expect(rateRange).toHaveAttribute('max', '3.0');
      await expect(rateRange).toHaveAttribute('step', '0.05');

      // ---- Phase 7A stretch card: shipped WSOLA truth, same token contract ----
      const stretchCard = body.locator(':scope > div').last();
      await expectColor(bgOf(stretchCard), expected.surface2, 'stretch card surface');
      await expectColor(borderTopOf(stretchCard), expected.border, 'stretch card border');
      await expect(stretchCard).toContainText('TIME STRETCH — PITCH PRESERVED (WSOLA)');
      const stretchSummary = stretchCard.locator(':scope > div:first-child span.font-mono');
      await expect(stretchSummary).toContainText('WSOLA render/commit');
      await expectColor(fgOf(stretchSummary), expected.success, 'stretch summary keeps its green meaning');
      await expectAaContrast(stretchSummary, 'stretch summary');
      await expect(stretchCard).toContainText('SUPPORTED 0.25×–4.00×');
      const stretchValue = stretchCard.locator('.font-mono.font-bold').first();
      await expect(stretchValue).toHaveText('1.00×');
      await expectColor(fgOf(stretchValue), expected.success, 'stretch ratio read-out keeps its green meaning');
      await expectAaContrast(stretchValue, 'stretch ratio read-out');
      const stretchRange = stretchCard.locator('input[type="range"]');
      await expect(stretchRange).toBeDisabled();
      await expect(stretchRange).toHaveAttribute('min', '0.25');
      await expect(stretchRange).toHaveAttribute('max', '4.0');
      await expect(stretchRange).toHaveAttribute('step', '0.01');
      const commitStretch = stretchCard.locator('button:has-text("Render & Commit Stretch")');
      await expect(commitStretch).toBeDisabled();
      await expect(commitStretch).toHaveCSS('opacity', '0.4');
      await expectColor(bgOf(commitStretch), expected.success, 'stretch commit CTA fill');
      await expectColor(fgOf(commitStretch), expected.onAccent, 'stretch commit CTA on-colour');

      // ---- Phase 7B: fit-to-tempo panel — honest, disabled, authoritative ----
      await expect(stretchCard).toContainText('FIT TO PROJECT TEMPO');
      await expect(stretchCard).toContainText('No beat detection is performed');
      const fitInput = stretchCard.locator('#fl-warp-fit-source-bpm');
      await expect(fitInput).toBeDisabled();
      // getByRole with an EXACT accessible name — Phase 7C added a distinct
      // "Render & Commit Fit to Length" CTA whose label contains this one as a
      // substring, so a plain :has-text would now match both buttons.
      const fitCommit = stretchCard.getByRole('button', { name: 'Render & Commit Fit', exact: true });
      await expect(fitCommit).toBeDisabled();
      await expect(fitCommit).toHaveCSS('opacity', '0.4');
      await expectColor(bgOf(fitCommit), expected.success, 'fit commit CTA fill');
      await expectColor(fgOf(fitCommit), expected.onAccent, 'fit commit CTA on-colour');
      // The authoritative-tempo proof: the modal's PROJECT BPM read-out equals
      // the transport BPM captured before the modal opened.
      const fitTargetReadout = stretchCard.locator('span.font-mono.font-bold', { hasText: /^\d+(?:\.\d+)? BPM$/ }).last();
      await expect(fitTargetReadout).toBeVisible();
      const readoutBpm = parseFloat((await fitTargetReadout.textContent()) ?? '');
      expect(readoutBpm).toBeCloseTo(parseFloat(transportBpm), 6);

      // ---- Phase 7C: fit-to-musical-length panel — authoritative grid, honest, disabled ----
      await expect(stretchCard).toContainText('FIT TO MUSICAL LENGTH');
      await expect(stretchCard).toContainText('refused honestly — never silently shifted');
      const fitLenBars = stretchCard.locator('#fl-warp-fit-length-bars');
      const fitLenBeats = stretchCard.locator('#fl-warp-fit-length-beats');
      await expect(fitLenBars).toBeDisabled();
      await expect(fitLenBeats).toBeDisabled();
      await expect(fitLenBeats).toHaveAttribute('step', '0.25');
      const fitLenCommit = stretchCard.getByRole('button', { name: 'Render & Commit Fit to Length', exact: true });
      await expect(fitLenCommit).toBeDisabled();
      await expect(fitLenCommit).toHaveCSS('opacity', '0.4');
      await expectColor(bgOf(fitLenCommit), expected.success, 'fit-to-length commit CTA fill');
      await expectColor(fgOf(fitLenCommit), expected.onAccent, 'fit-to-length commit CTA on-colour');
      // The authoritative-grid proof: the panel's PROJECT read-out equals the
      // transport BPM AND the transport's resolved meter captured before the
      // modal opened — one project grid, no duplicated setting inside the
      // modal and no hardcoded 4/4 assumption.
      const fitGridReadout = stretchCard.locator('#fl-warp-fit-length-project-grid');
      await expect(fitGridReadout).toBeVisible();
      const gridText = ((await fitGridReadout.textContent()) ?? '').trim();
      const gridMatch = /^(\d+(?:\.\d+)?) BPM · (\d+\/\d+)$/.exec(gridText);
      expect(gridMatch, `grid read-out "${gridText}"`).not.toBeNull();
      expect(parseFloat(gridMatch?.[1] ?? '')).toBeCloseTo(parseFloat(transportBpm), 6);
      expect(gridMatch?.[2]).toBe(transportMeter);
      // Without a selected clip the preview honestly asks for one.
      await expect(stretchCard.locator('#fl-warp-fit-length-preview')).toContainText('SELECT AN AUDIO CLIP TO PREVIEW THE FIT');

      const footerNote = footer.locator('span').first();
      await expect(footerNote).toHaveText('Applies to live playback and WAV export');
      await expectColor(fgOf(footerNote), expected.text3, 'footer note');
      await expectAaContrast(footerNote, 'footer note');

      const cancel = footer.locator('button:has-text("Cancel")');
      await expectColor(bgOf(cancel), expected.surface3, 'Cancel fill');
      await expectColor(fgOf(cancel), expected.text, 'Cancel label');
      await expectAaContrast(cancel, 'Cancel label');
      await cancel.hover();
      const apply = footer.locator('button:has-text("Apply to Clip")');
      await expect(apply).toBeDisabled();
      await expect(apply).toHaveCSS('opacity', '0.4');
      await expectColor(bgOf(apply), expected.success, 'Apply CTA fill');
      await expectColor(fgOf(apply), expected.onAccent, 'Apply CTA on-colour');

      // ---- Keyboard: the focus trap skips the disabled preview button ----
      const activeText = (): Promise<string> => page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 24) ?? '');
      const outlineOf = (): (() => Promise<Outline>) => () => page.evaluate(() => {
        const c = getComputedStyle(document.activeElement as Element);
        return { color: c.outlineColor, width: c.outlineWidth, style: c.outlineStyle };
      });

      // The preview button is disabled, so the trap lands on the close control.
      expect(await activeText(), 'the dialog opens with focus on its close control (preview disabled)').toBe('Close warp processor');
      await page.keyboard.press('Tab');
      expect(await activeText(), 'Tab moves to the cancel action').toBe('Cancel');
      await expectFocusRing(outlineOf(), expected.accent, 'Cancel button focus ring');

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // ---- Interaction: selecting a pattern clip reaches the
      //      unsupported-type state, still themed, still honest ----
      // The app opens on the Channel Rack; the timeline lives on the Playlist
      // view, so switch views before selecting a clip.
      await page.locator('#fl-view-tabs button', { hasText: 'Playlist' }).click();
      await expect(page.locator('#fl-playlist-arranger')).toBeVisible();
      const kickClip = page.locator('#fl-playlist-arranger div.absolute.cursor-pointer', { hasText: 'Kick Pattern' }).first();
      await kickClip.click();
      const reopened = await openWarpProcessor(page);
      await expectColor(bgOf(reopened.locator(':scope > div')), expected.panel, 'reopened panel surface');
      await expect(reopened.locator('text=NOTHING SELECTED')).toBeVisible();
      const reopenedBanner = reopened.locator('text=NO AUDIO CLIP TO WARP').locator('..');
      await expectColor(bgOf(reopenedBanner), expected.canvas, 'reopened no-clip banner surface');
      await expectColor(borderTopOf(reopenedBanner), { ...expected.gold, a: 0.4 }, 'reopened banner edge');
      await expect(reopenedBanner).toContainText('Kick Pattern');
      await expect(reopenedBanner).toContainText('is a pattern clip. Pitch and playback-rate warping is applied to audio clips only');
      const reopenedInsets = reopened.locator('.custom-scrollbar .grid > div');
      await expect(reopenedInsets.nth(0).locator('input[type="range"]')).toBeDisabled();
      await expect(reopenedInsets.nth(1).locator('input[type="range"]')).toBeDisabled();
      // Phase 7A: the stretch-ratio slider (the dialog's third range) stays
      // disabled for a pattern clip, and so does its commit CTA.
      await expect(reopened.locator('input[type="range"]').nth(2)).toBeDisabled();
      await expect(reopened.locator('button:has-text("Render & Commit Stretch")')).toBeDisabled();
      // Phase 7B: the fit-to-tempo input and its commit CTA stay disabled too
      // (exact accessible names — 7C's longer CTA label contains this one).
      await expect(reopened.locator('#fl-warp-fit-source-bpm')).toBeDisabled();
      await expect(reopened.getByRole('button', { name: 'Render & Commit Fit', exact: true })).toBeDisabled();
      // Phase 7C: the fit-to-length inputs and their distinct CTA stay disabled
      // for a pattern clip — the exact-length operation is audio-only too.
      await expect(reopened.locator('#fl-warp-fit-length-bars')).toBeDisabled();
      await expect(reopened.locator('#fl-warp-fit-length-beats')).toBeDisabled();
      await expect(reopened.getByRole('button', { name: 'Render & Commit Fit to Length', exact: true })).toBeDisabled();

      await page.keyboard.press('Escape');
      await expect(reopened).toHaveCount(0);
    });
  }
});
