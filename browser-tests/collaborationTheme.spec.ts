/**
 * UI-03O — Collaboration modal Light/Dark theme regression, run in a real
 * Chromium against the actual Vite application (no simulation, no stubbed
 * styles).
 *
 * Every expected color below was read from the running app with
 * `getComputedStyle`, so the assertions pin the resolved palette rather than a
 * guessed one. The spec also drives the modal's conditional states — the empty
 * and populated note lists, the resolved-note card, the composer, and the
 * identity chips — in both themes, and closes the dialog both ways it supports
 * (close control and Escape) to prove the wiring survived the migration.
 *
 * The phase70 truthfulness contract (project data only, no invented presence) is
 * owned by `src/components/phase70.collaborationTruth.test.tsx`; this spec pins
 * the rendered paint.
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
    canvas: rgba(21, 24, 33),
    header: rgba(31, 36, 49),
    border: rgba(43, 48, 64),
    text: rgba(244, 245, 248),
    text2: rgba(174, 181, 196),
    text3: rgba(139, 149, 168),
    accent: rgba(155, 138, 251),
    onAccent: rgba(13, 15, 22),
    success: rgba(98, 215, 164),
  },
  light: {
    scrim: rgba(24, 32, 45, 0.55),
    surface: rgba(255, 255, 255),
    surface2: rgba(244, 246, 250),
    canvas: rgba(244, 246, 250),
    header: rgba(231, 235, 242),
    border: rgba(201, 208, 220),
    text: rgba(24, 32, 45),
    text2: rgba(70, 82, 103),
    text3: rgba(91, 104, 121),
    accent: rgba(101, 82, 206),
    onAccent: rgba(255, 255, 255),
    success: rgba(20, 115, 78),
  },
} as const;

const openCollaboration = async (page: Page): Promise<Locator> => {
  await page.locator('#fl-tools-menu-btn').click();
  await expect(page.locator('#fl-tools-menu')).toBeVisible();
  await page.locator('#fl-collab-btn').click();
  const dialog = page.locator('#collab-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

const countIn = async (locator: Locator): Promise<number> => {
  const text = (await locator.textContent()) ?? '';
  const match = text.match(/\((\d+)\)/);
  return match ? Number(match[1]) : -1;
};

test.describe('UI-03O collaboration modal theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, note flow, resolve state and focus`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await openApp(page, mode);
      const tokens = TOKENS[mode];

      const dialog = await openCollaboration(page);
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('aria-labelledby', 'collab-modal-title');
      await expect(dialog.locator('#collab-modal-title')).toHaveText('STUDIO NOTES & COLLABORATION');
      await expect(dialog.getByText('Comments and collaborator data are stored in this project. No live network sync is active.')).toBeVisible();

      const panel = dialog.locator(':scope > div');
      const header = panel.locator(':scope > div').first();
      const body = panel.locator(':scope > div').nth(1);

      // The scrim is the shared themed overlay token, not a dark-only black fill.
      await expectColor(bgOf(dialog), tokens.scrim, 'dialog scrim');
      await expectColor(bgOf(panel), tokens.surface, 'panel surface');
      await expectColor(bgOf(header), tokens.header, 'header band');
      await expectColor(borderTopOf(panel), tokens.border, 'panel border');
      await expectColor(borderBottomOf(header), tokens.border, 'header divider');
      await expectColor(fgOf(panel), tokens.text2, 'panel body text');
      await expectColor(fgOf(header.locator('p')), tokens.text3, 'header subtitle');
      await expectAaContrast(dialog.locator('#collab-modal-title'), 'modal title');
      await expectAaContrast(header.locator('p'), 'header subtitle');

      // Local workspace card: a themed inset with the accent share action.
      const workspace = body.locator(':scope > div').first();
      await expectColor(bgOf(workspace), tokens.surface2, 'workspace card');
      await expectColor(borderTopOf(workspace), tokens.border, 'workspace card border');
      const workspaceTitle = workspace.getByText('Local collaboration workspace');
      const workspaceNote = workspace.getByText('Comments and collaborator data are stored in this project. No live network sync is active.');
      await expectColor(fgOf(workspaceTitle), tokens.text, 'workspace card title');
      await expectColor(fgOf(workspaceNote), tokens.text3, 'workspace card note');
      await expectAaContrast(workspaceTitle, 'workspace card title');
      await expectAaContrast(workspaceNote, 'workspace card note');

      const copyLink = workspace.getByRole('button', { name: /COPY APP LINK/ });
      await expectColor(bgOf(copyLink), tokens.accent, 'copy link CTA');
      await expectColor(fgOf(copyLink), tokens.onAccent, 'copy link CTA label');
      await expectAaContrast(copyLink, 'copy link CTA label');

      // Collaborators are stored project data: identity and role only.
      const collaboratorSections = body.locator(':scope > div').nth(1);
      const collaboratorHeading = collaboratorSections.locator('div').first();
      await expect(collaboratorHeading).toContainText(/Project Collaborators \(\d+\)/);
      await expectColor(fgOf(collaboratorHeading), tokens.text3, 'collaborators heading');
      const collaboratorCount = await countIn(collaboratorHeading);
      expect(collaboratorCount, 'the project records collaborators').toBeGreaterThan(0);
      const firstAvatar = collaboratorSections.locator('div.rounded-full').first();
      await expect(firstAvatar).toBeVisible();
      // The avatar fill is the stored project colour; its on-colour is the one
      // documented fixed utility (text-black), so the card stays readable for
      // any stored colour in either theme.
      await expectColor(fgOf(firstAvatar), rgba(0, 0, 0), 'stored avatar on-colour');
      await expect(collaboratorSections.locator('div.font-mono')).toHaveCount(collaboratorCount);
      await expectAaContrast(collaboratorSections.locator('div.text-xs').first(), 'collaborator name');
      await expectAaContrast(collaboratorSections.locator('div.font-mono').first(), 'collaborator role');

      // Timeline notes list: every stored note renders on a themed card.
      const notesSection = body.locator(':scope > div').nth(2);
      const notesHeading = notesSection.locator('div').first();
      await expect(notesHeading).toContainText(/Timeline Mix Feedback & Annotations \(\d+\)/);
      await expectColor(fgOf(notesHeading), tokens.text3, 'notes heading');
      const initialNotes = await countIn(notesHeading);
      expect(initialNotes, 'the shipped preset carries notes').toBeGreaterThan(0);
      const firstNote = notesSection.locator(':scope > div > div > div').first();
      await expectColor(fgOf(firstNote.locator('span.font-bold')), tokens.text, 'note author');
      await expectAaContrast(firstNote.locator('span.font-bold'), 'note author');
      const barChip = firstNote.locator('span.font-mono').first();
      await expectColor(bgOf(barChip), tokens.canvas, 'bar chip inset');
      await expectColor(fgOf(barChip), tokens.accent, 'bar chip identity');
      await expectAaContrast(barChip, 'bar chip identity');

      // The composer is a themed inset; its placeholder and value are legible.
      const composer = body.locator('form');
      await expectColor(bgOf(composer), tokens.surface2, 'composer card');
      const input = composer.locator('input[type="text"]');
      await expectColor(bgOf(input), tokens.canvas, 'composer input');
      await expectColor(fgOf(input), tokens.text, 'composer input text');
      await expectAaContrast(input, 'composer input text');
      const placeholderColor = await input.evaluate((element) => getComputedStyle(element, '::placeholder').color);
      expect(placeholderColor, `composer placeholder is themed: ${placeholderColor}`).not.toBe('rgb(85, 85, 85)');
      const barSelect = composer.locator('select');
      await expectColor(bgOf(barSelect), tokens.canvas, 'bar selector');
      await expectColor(fgOf(barSelect), tokens.accent, 'bar selector value');

      const post = composer.getByRole('button', { name: /POST/ });
      await expectColor(bgOf(post), tokens.accent, 'post CTA');
      await expectColor(fgOf(post), tokens.onAccent, 'post CTA label');
      await expectAaContrast(post, 'post CTA label');

      // Posting a note publishes through the existing handler.
      const noteText = `Check the ${mode} mix bus`;
      await barSelect.selectOption('9');
      await input.fill(noteText);
      await post.click();
      await expect(notesSection.getByText(noteText)).toBeVisible();
      await expect(notesHeading).toContainText(`(${initialNotes + 1})`);
      await expect(input).toHaveValue('');

      const newCard = notesSection.locator('div', { hasText: noteText }).last();
      const resolveButton = newCard.getByRole('button', { name: 'MARK RESOLVED' });
      // The wash carries the green "resolved" meaning; the label uses the
      // primary text token because success-on-success-wash measures only
      // 4.08:1 (Light, resting) and 4.33:1 (Dark, hover wash) — below AA.
      await expectColor(bgOf(resolveButton), { ...tokens.success, a: 0.2 }, 'unresolved action wash');
      await expectColor(fgOf(resolveButton), tokens.text, 'unresolved action label');
      await expectAaContrast(resolveButton, 'unresolved action label');
      // Measured independently of the DOM: Light rejects the success label on
      // both washes (4.08:1 resting, 3.50:1 hover) and Dark clears the resting
      // wash (5.54:1) but not the lifted hover wash (4.33:1), so one text token
      // is used for both themes.
      const restingWash = composite({ ...tokens.success, a: 0.2 }, tokens.surface2);
      const hoverWash = composite({ ...tokens.success, a: 0.3 }, tokens.surface2);
      const rejectedWashes = mode === 'light' ? [restingWash, hoverWash] : [hoverWash];
      for (const wash of rejectedWashes) {
        expect(
          contrastRatio(tokens.success, wash),
          `success text on the ${mode} wash (the rejected alternative)`,
        ).toBeLessThan(4.5);
      }
      if (mode === 'dark') {
        expect(
          contrastRatio(tokens.success, restingWash),
          'Dark clears the resting wash, which is why the decision is documented rather than assumed',
        ).toBeGreaterThan(4.5);
      }

      // Resolving flips the card to the recessed resolved state.
      await resolveButton.click();
      const resolvedCard = notesSection.locator('div', { hasText: noteText }).last();
      await expect(resolvedCard.getByRole('button', { name: 'RESOLVED' })).toBeVisible();
      await expect.poll(opacityOf(resolvedCard), { message: 'resolved cards recede' }).toBe('0.5');
      const resolvedButton = resolvedCard.getByRole('button', { name: 'RESOLVED' });
      await expectColor(bgOf(resolvedButton), tokens.surface2, 'resolved action surface');
      await expectColor(fgOf(resolvedButton), tokens.text3, 'resolved action label');
      await expectAaContrast(resolvedButton, 'resolved action label');

      // Neutral close control keeps a themed hover shift.
      const close = dialog.getByRole('button', { name: 'Close collaboration' });
      await expectColor(fgOf(close), tokens.text3, 'close control idle');
      await expectAaContrast(close, 'close control idle');
      await close.hover();
      await expectColor(fgOf(close), tokens.text, 'close control hovered');

      // Committed evidence artifact, regenerated by this spec (repo convention).
      await page.screenshot({ path: `assets/screenshots/ui03o-collaboration-${mode}.png` });
      // Escape closes the dialog without touching the theme.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      // Reopening keeps the note and its resolved state: the state update persisted.
      const reopened = await openCollaboration(page);
      const reopenedBody = reopened.locator(':scope > div').locator(':scope > div').nth(1);
      const reopenedNotes = reopenedBody.locator(':scope > div').nth(2);
      await expect(reopenedNotes.getByText(noteText)).toBeVisible();
      await expect(reopenedNotes.getByRole('button', { name: 'RESOLVED' }).last()).toBeVisible();
      await reopened.getByRole('button', { name: 'Close collaboration' }).click();
      await expect(reopened).toBeHidden();
    });
  }
});
