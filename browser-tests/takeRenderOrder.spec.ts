/**
 * Active-take Playlist paint order — real-browser regression for the take
 * comping rendering-order defect.
 *
 * Defect (fixed): Playlist clip nodes are absolutely positioned siblings
 * painted in DOM order and every take of a comping group covers the same
 * timeline region, so the arranger's raw persisted-array rendering let a
 * silenced later-recorded take visually cover (and steal clicks from) the
 * active take the musician had just selected in Take Comping.
 *
 * The shipped default project contains no audio takes (see
 * takeCompingTheme.spec.ts), so this suite drives `tests/takeRenderOrder.html`
 * — the real PlaylistArranger mounted by `tests/takeRenderOrder.fixture.tsx`
 * with a real two-take group, the same pattern `tests/playlistGeometry.*`
 * established for geometry. The fixture's take-selection buttons call the real
 * `selectActiveTake`, the exact function App.tsx wires to TakeCompingModal's
 * `onSelectActiveTake`.
 *
 * Stacking is measured with the browser's own hit testing
 * (`document.elementFromPoint` at the centre of the take overlap): the element
 * the browser reports there is the one painted on top AND the one a real click
 * lands on, so each test pins visual stacking and click behaviour together.
 * All asserted values are structural (clip ids, DOM order, readouts) — no
 * colours, no pixel tolerances.
 */
import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';
const FIXTURE_URL = `${APP_URL}/tests/takeRenderOrder.html`;

/** Clip id whose subtree is topmost at the centre of the take overlap —
    what the browser paints last and what a real click hits there. */
const topmostClipIdAtOverlap = async (page: Page): Promise<string> => {
  const box = await page.locator('[data-clip-id="take-1"]').boundingBox();
  expect(box, 'the take clip has a browser layout box').not.toBeNull();
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return (el?.closest('[data-clip-id]') as HTMLElement | null)?.dataset.clipId ?? 'none';
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2]
  );
};

/** Clip ids in DOM order (paint order for the positioned siblings). */
const domClipOrder = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-clip-id]')].map(el => el.dataset.clipId!)
  );

/** Clicks the centre of the take overlap like a musician would. */
const clickTakeOverlap = async (page: Page): Promise<void> => {
  const box = await page.locator('[data-clip-id="take-1"]').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
};

const readPersistedOrder = (page: Page): Promise<string> =>
  page.locator('#persisted-order-display').innerText();

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE_URL);
  await page.locator('[data-clip-id="take-1"]').waitFor();
  await page.locator('[data-clip-id="take-2"]').waitFor();
});

test('default state: the newest take (Take 2) is active and paints on top', async ({ page }) => {
  await expect(page.locator('#active-take-display')).toHaveText('2');
  expect(await domClipOrder(page)).toEqual(['plain-clip', 'take-1', 'take-2']);
  expect(await topmostClipIdAtOverlap(page)).toBe('take-2');

  await clickTakeOverlap(page);
  await expect(page.locator('#selected-clip-display')).toHaveText('take-2');
});

test('selecting Take 1 makes it paint on top and receive clicks', async ({ page }) => {
  await page.locator('button[data-select-take="0"]').click();
  await expect(page.locator('#active-take-display')).toHaveText('1');

  // DEFECT REGRESSION: the silenced Take 2 must no longer cover the active
  // Take 1 — the arranger renders the active take as the group's last DOM
  // sibling so it paints (and hit-tests) on top.
  expect(await domClipOrder(page)).toEqual(['plain-clip', 'take-2', 'take-1']);
  expect(await topmostClipIdAtOverlap(page)).toBe('take-1');

  // Click behaviour follows the visual stacking: the take the musician sees
  // on top is the take the click selects.
  await clickTakeOverlap(page);
  await expect(page.locator('#selected-clip-display')).toHaveText('take-1');

  // The persisted project array keeps its stored recording order — the fix is
  // a derived visual order, never a data reorder.
  expect(JSON.parse(await readPersistedOrder(page))).toEqual(['plain-clip', 'take-1', 'take-2']);
});

test('switching the active take back to Take 2 reverses the stacking', async ({ page }) => {
  await page.locator('button[data-select-take="0"]').click();
  expect(await topmostClipIdAtOverlap(page)).toBe('take-1');

  await page.locator('button[data-select-take="1"]').click();
  await expect(page.locator('#active-take-display')).toHaveText('2');
  expect(await domClipOrder(page)).toEqual(['plain-clip', 'take-1', 'take-2']);
  expect(await topmostClipIdAtOverlap(page)).toBe('take-2');

  await clickTakeOverlap(page);
  await expect(page.locator('#selected-clip-display')).toHaveText('take-2');
  expect(JSON.parse(await readPersistedOrder(page))).toEqual(['plain-clip', 'take-1', 'take-2']);
});

test('the unrelated clip keeps its position, order and hit target', async ({ page }) => {
  await page.locator('button[data-select-take="0"]').click();

  const order = await domClipOrder(page);
  expect(order.indexOf('plain-clip')).toBe(0);

  const box = await page.locator('[data-clip-id="plain-clip"]').boundingBox();
  expect(box).not.toBeNull();
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return (el?.closest('[data-clip-id]') as HTMLElement | null)?.dataset.clipId ?? 'none';
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2]
  );
  expect(hit).toBe('plain-clip');
});
