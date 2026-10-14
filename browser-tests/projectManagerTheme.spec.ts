/** UI-03Q — Project Hub scrim (entry: Studio Browser New button), measured in a real Chromium. */

import { expect, test, type Locator, type Page } from '@playwright/test';
const APP_URL = 'http://localhost:3000';
type Rgba = [number, number, number, number];
const parseColor = (value: string): Rgba | null => {
  const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+))?\s*\)/.exec(value);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
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
  throw new Error(`${label}: cannot parse "${value}"`);
};
const luminance = ([r, g, b]: Rgba): number => {
  const linear = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
const contrastRatio = (a: Rgba, b: Rgba): number => {
  const x = luminance(a); const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const colourDistance = (a: Rgba, b: Rgba): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 255);
const token = async (page: Page, name: string): Promise<Rgba> => {
  const value = await page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  return requireColor(value, name);
};
const computedBg = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
const setTheme = (mode: 'dark' | 'light') => (page: Page) =>
  page.addInitScript((v: string) => { try { window.localStorage.setItem('apex:theme', v); } catch { /* optional */ } }, mode);
const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1000);
};
const expectScrim = async (page: Page, dialog: Locator): Promise<void> => {
  await expect(dialog).toHaveClass(/apex-modal-overlay/);
  expect((await dialog.getAttribute('class')) ?? '').not.toContain('bg-black');
  const scrim = requireColor(await computedBg(dialog), 'scrim');
  const expected = await token(page, '--apex-modal-overlay');
  expect(colourDistance(scrim, expected), 'scrim = --apex-modal-overlay').toBeLessThanOrEqual(2);
};
const expectAaOnOwnSurface = async (locator: Locator, label: string): Promise<void> => {
  const fg = requireColor(await locator.evaluate((el) => getComputedStyle(el).color), label);
  const stack = await locator.evaluate((el) => {
    const out: string[] = [];
    for (let n: Element | null = el; n && out.length < 12; n = n.parentElement) out.push(getComputedStyle(n).backgroundColor);
    return out;
  });
  let surface: Rgba = [255, 255, 255, 1];
  for (const layer of stack.map(parseColor).filter((v): v is Rgba => v !== null)) {
    if (layer[3] >= 1) { surface = layer; break; }
  }
  const ratio = contrastRatio(fg, surface);
  expect(ratio, `${label} AA ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
};

const openDialog = async (page: Page): Promise<Locator> => {
  await page.locator('#browser-new-project-btn').click();
  const dialog = page.locator('#project-manager-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};
for (const mode of ['dark', 'light'] as const) {
  test(`the dialog opens on the themed scrim in ${mode} (UI-03Q)`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setTheme(mode)(page);
    await page.goto(APP_URL);
    await waitForApp(page);
    const dialog = await openDialog(page);
    await expect(page.locator('#project-manager-modal-title')).toContainText('STUDIO');
    await expectScrim(page, dialog);
    await expectAaOnOwnSurface(page.locator('#project-manager-modal-title'), `${mode} title`);
    await page.screenshot({ path: `assets/screenshots/ui03q-project-manager-${mode}.png` });
    expect(errors).toEqual([]);
  });
}
test('a theme flip repaints the scrim with no reload (UI-03Q)', async ({ page }) => {
  await setTheme('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  const dialog = await openDialog(page);
  const before = requireColor(await computedBg(dialog), 'dark scrim');
  await page.evaluate(() => {
    (window as unknown as { __ui03q: string }).__ui03q = 'alive';
    window.localStorage.setItem('apex:theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });
  await expect.poll(async () => colourDistance(requireColor(await computedBg(dialog), 'light scrim'), await token(page, '--apex-modal-overlay'))).toBeLessThanOrEqual(2);
  expect(colourDistance(before, await token(page, '--apex-modal-overlay'))).toBeGreaterThan(4);
  expect(await page.evaluate(() => (window as unknown as { __ui03q?: string }).__ui03q)).toBe('alive');
});
