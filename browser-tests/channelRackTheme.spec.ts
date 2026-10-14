/**
 * UI-03P/UI-03S — Channel Rack hover and contrast regressions, measured in Chromium.
 *
 * The rack's last chrome literals were the two destructive hovers: **CLR** and
 * the per-row delete control used Tailwind's `hover:text-red-400`, which is not a
 * theme token — it stayed the same red in Light and did not match the danger hue
 * the rest of the app uses. This spec hovers both controls in both palettes and
 * measures the resolved colour against the row surface, plus the AA floor for the
 * label. Channel names use a semantic foreground; the raw per-channel identity
 * hues remain stored data and are preserved in a separate swatch with a
 * contrasting outline. Both the labels and markers are measured in Chromium.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { measureTextContrast } from './themeContrast';

const APP_URL = 'http://localhost:3000';

type Rgba = [number, number, number, number];

const parseColor = (value: string): Rgba | null => {
  const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+))?\s*\)/.exec(value);
  if (srgb) {
    return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(value);
  if (!rgb) return null;
  const channels = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [channels[0], channels[1], channels[2], channels[3] ?? 1];
};

const requireColor = (value: string, label: string): Rgba => {
  const parsed = parseColor(value);
  if (parsed) return parsed;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    const channel = (offset: number) => parseInt(digits.slice(offset, offset + 2), 16);
    return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) / 255 : 1];
  }
  throw new Error(`${label}: cannot parse computed colour "${value}"`);
};

const luminance = ([r, g, b]: Rgba): number => {
  const linear = (value: number): number => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrastRatio = (foreground: Rgba, background: Rgba): number => {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

const colourDistance = (a: Rgba, b: Rgba): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 255);

const token = async (page: Page, name: string): Promise<Rgba> => {
  const value = await page.evaluate(
    (tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
    name,
  );
  return requireColor(value, name);
};

const readForeground = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).color).then((value) => parseColor(value));

const readBackground = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor).then((value) => parseColor(value));

const setTheme = (mode: 'dark' | 'light') => (page: Page) =>
  page.addInitScript((value: string) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* handled by the page */
    }
  }, mode);

const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1000);
};

/** The Channel Rack is the default view; `#nav-channel-rack` makes it explicit. */
const openRack = async (page: Page): Promise<Locator> => {
  await page.locator('#nav-channel-rack').click();
  const root = page.locator('#fl-channel-rack');
  await expect(root).toBeVisible();
  return root;
};

for (const mode of ['dark', 'light'] as const) {
  test(`the rack's destructive hovers resolve to the danger token in ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setTheme(mode)(page);
    await page.goto(APP_URL);
    await waitForApp(page);
    const root = await openRack(page);

    const danger = await token(page, '--apex-danger');
    const controls: Array<{ label: string; locator: Locator }> = [
      { label: 'CLR (clear steps)', locator: root.locator('button[title="Clear steps"]').first() },
      { label: 'delete channel', locator: root.locator('button[title="Delete channel"]').first() },
    ];

    for (const control of controls) {
      await expect(control.locator).toBeVisible();
      const idle = await readForeground(control.locator);
      const surface = await readBackground(control.locator);
      expect(surface, `${control.label} owns a surface`).not.toBeNull();
      // Idle: the muted text token, AA on the row fill.
      expect(
        contrastRatio(idle!, surface!),
        `${mode} ${control.label} idle AA`,
      ).toBeGreaterThanOrEqual(4.5);

      await control.locator.hover();
      await expect
        .poll(async () => {
          const got = await readForeground(control.locator);
          return got ? colourDistance(got, danger) : Number.MAX_SAFE_INTEGER;
        }, { message: `${control.label} hover = --apex-danger`, timeout: 5_000, intervals: [50] })
        .toBeLessThanOrEqual(2);
      const hovered = await readForeground(control.locator);
      expect(
        contrastRatio(hovered!, surface!),
        `${mode} ${control.label} hover AA`,
      ).toBeGreaterThanOrEqual(4.5);
      // And the literal it replaced is a different colour in both palettes.
      const legacyRed = requireColor('#f87171', 'legacy red-400');
      expect(colourDistance(hovered!, legacyRed), `${control.label} no longer paints red-400`).toBeGreaterThan(4);
    }

    // Labels use theme text; each original project identity value remains a
    // separate, verbatim swatch. The swatch outline is the non-text indicator.
    const names = root.locator('button[data-testid^="channel-name-"]');
    const identities = root.locator('[data-testid^="channel-identity-"]');
    await expect(names).toHaveCount(await identities.count());
    for (let index = 0; index < await names.count(); index += 1) {
      const name = names.nth(index);
      const marker = identities.nth(index);
      const labelContrast = await measureTextContrast(name);
      expect(labelContrast.ratio, `${mode} ${await name.innerText()} label`).toBeGreaterThanOrEqual(4.5);
      const identity = await marker.evaluate((element) => ({
        stored: element.getAttribute('data-identity-color') ?? '',
        painted: getComputedStyle(element).backgroundColor,
        outline: getComputedStyle(element).borderTopColor,
        rowBackground: getComputedStyle(element.closest('[id^="channel-row-"]')!).backgroundColor,
      }));
      expect(identity.stored).toMatch(/^#[0-9a-f]{6}$/i);
      expect(colourDistance(requireColor(identity.painted, identity.stored), requireColor(identity.stored, identity.stored)), `stored hue ${identity.stored} preserved`).toBeLessThanOrEqual(1);
      expect(contrastRatio(requireColor(identity.outline, 'identity outline'), requireColor(identity.rowBackground, 'channel row')), `${mode} identity marker outline`).toBeGreaterThanOrEqual(3);
    }

    const firstName = names.first();
    const rest = await measureTextContrast(firstName);
    await firstName.hover();
    let hovered = await measureTextContrast(firstName);
    await expect
      .poll(async () => {
        hovered = await measureTextContrast(firstName);
        return hovered.foreground !== rest.foreground && hovered.ratio >= 4.5;
      }, { message: `${mode} channel-name hover remains a visible, readable feedback state`, timeout: 2_000, intervals: [50] })
      .toBe(true);
    expect(hovered.ratio, `${mode} hovered channel name`).toBeGreaterThanOrEqual(4.5);

    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `assets/screenshots/ui03s-channel-rack-${mode}.png` });
    expect(errors).toEqual([]);
  });
}

test('a theme flip repaints the rack with no reload and no channel mutation', async ({ page }) => {
  await setTheme('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  const root = await openRack(page);
  const clear = root.locator('button[title="Clear steps"]').first();
  await clear.hover();

  const channelsBefore = await page.evaluate(() => document.getElementById('fl-channel-rack')?.innerHTML ?? '');
  const projectBeforeTheme = await page.evaluate(() => window.localStorage.getItem('apex:project'));
  await page.evaluate(() => {
    (window as unknown as { __ui03pMarker: string }).__ui03pMarker = 'alive';
    window.localStorage.setItem('apex:theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });

  const lightDanger = await token(page, '--apex-danger');
  await expect
    .poll(async () => {
      const got = await readForeground(clear);
      return got ? colourDistance(got, lightDanger) : Number.MAX_SAFE_INTEGER;
    }, { message: 'the hovered control follows the light danger token', timeout: 5_000, intervals: [100] })
    .toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (window as unknown as { __ui03pMarker?: string }).__ui03pMarker)).toBe('alive');
  expect(await page.evaluate(() => document.getElementById('fl-channel-rack')?.innerHTML ?? '')).toEqual(channelsBefore);
  expect(await page.evaluate(() => window.localStorage.getItem('apex:project'))).toBe(projectBeforeTheme);
});
