import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Run after `npx playwright install chromium` (and install browser system libraries).
// PLAYLIST_BROWSER_EXECUTABLE optionally selects an already installed Chromium binary.
let server;
let browser;
let baseUrl;

before(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/tests/playlistGeometry.html`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYLIST_BROWSER_EXECUTABLE || undefined,
    args: ['--no-sandbox'],
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openFixture(startBar, width = 1200) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.goto(`${baseUrl}?start=${startBar}`);
  const clip = page.locator('#fl-playlist-arranger .group').filter({ hasText: 'Fixture Audio' });
  await clip.waitFor();
  return { page, clip };
}

async function readStartBar(page) {
  return page.locator('#fixture-project-clips').evaluate(element => JSON.parse(element.textContent)[0].startBar);
}

async function assertAligned(page, clip, startBar) {
  const firstBar = page.getByText(`BAR ${startBar + 1}`, { exact: true }).locator('..');
  const lastBar = page.getByText(`BAR ${startBar + 4}`, { exact: true }).locator('..');
  const [clipBox, firstBox, lastBox] = await Promise.all([
    clip.boundingBox(), firstBar.boundingBox(), lastBar.boundingBox()
  ]);
  assert.ok(clipBox && firstBox && lastBox, 'clip and ruler cells have browser layout boxes');
  assert.ok(Math.abs(clipBox.x - firstBox.x) <= 1,
    `clip at ${clipBox.x} must start at displayed Bar ${startBar + 1} (${firstBox.x})`);
  assert.ok(Math.abs(clipBox.x + clipBox.width - (lastBox.x + lastBox.width - 4)) <= 1,
    'four-bar clip must finish 4px inside the last bar cell, preserving the existing width rule');
  assert.equal(Math.round(clipBox.width), 4 * 96 - 4);
  const positioning = await clip.evaluate(element => ({
    clip: getComputedStyle(element).position,
    lane: getComputedStyle(element.parentElement).position
  }));
  assert.deepEqual(positioning, { clip: 'absolute', lane: 'relative' });
  assert.equal(await readStartBar(page), startBar);
  return clipBox;
}

test('four-bar audio clip at startBar 28 spans displayed Bars 29–32', async () => {
  const { page, clip } = await openFixture(28);
  try {
    await assertAligned(page, clip, 28);
  } finally {
    await page.close();
  }
});

test('four-bar audio clip at startBar 4 starts at displayed Bar 5', async () => {
  const { page, clip } = await openFixture(4);
  try {
    await assertAligned(page, clip, 4);
  } finally {
    await page.close();
  }
});

test('scrolling keeps the clip aligned with ruler/grid coordinates', async () => {
  const { page, clip } = await openFixture(28);
  try {
    const before = await assertAligned(page, clip, 28);
    const scroll = page.locator('#fl-playlist-arranger .overflow-auto').first();
    await scroll.evaluate(element => { element.scrollLeft = 1920; });
    await page.waitForFunction(() =>
      document.querySelector('#fl-playlist-arranger .overflow-auto')?.scrollLeft >= 1900
    );
    const after = await assertAligned(page, clip, 28);
    assert.ok(before.x - after.x >= 1900, 'clip and ruler move with horizontal scrolling');
  } finally {
    await page.close();
  }
});

// The fixture's existing clip sits at Bars 5-8 (startBar 4), leaving the rest of
// the 32-bar timeline empty so grid clicks actually create clips. `.w-24.h-full
// .cursor-pointer` selects the arrangement grid cells specifically — the bar
// ruler uses the same width/height classes but is `select-none`, not clickable.
const gridCell = (page, barIndex) =>
  page.locator('#fl-playlist-arranger .w-24.h-full.cursor-pointer').nth(barIndex);

const readClips = page =>
  page.locator('#fixture-project-clips').evaluate(element => JSON.parse(element.textContent));

test('Phase 54: clicking the final grid cell clamps the new clip inside the 32-bar timeline', async () => {
  const { page } = await openFixture(4);
  try {
    // Place mode + pattern clip type is the fixture default. Click the last
    // grid cell (Bar 32, zero-indexed bar 31). Before Phase 54 this published a
    // 4-bar clip at startBar 31 ending at bar 35 — outside the timeline, and
    // outside the export window, which is how a 32-bar arrangement exported as
    // a 35-bar WAV.
    await gridCell(page, 31).click();

    const published = await readClips(page);
    const added = published.find(clip => clip.id !== 'fixture-audio');
    assert.ok(added, 'clicking an empty grid cell must create a clip');
    assert.ok(
      added.startBar + added.lengthBars <= 32,
      `created clip spans ${added.startBar}..${added.startBar + added.lengthBars} on a 32-bar timeline`
    );
    assert.equal(added.startBar, 28, 'it is pulled back to the latest legal start bar');
  } finally {
    await page.close();
  }
});

test('Phase 54: a clip created mid-timeline keeps the exact clicked position', async () => {
  const { page } = await openFixture(4);
  try {
    // Bar 21 (zero-indexed 20) has room for a 4-bar clip, so placement must be
    // unchanged by the clamp — this guards against over-correcting.
    await gridCell(page, 20).click();

    const published = await readClips(page);
    const added = published.find(clip => clip.id !== 'fixture-audio');
    assert.ok(added, 'a clip is created');
    assert.equal(added.startBar, 20, 'no clamping when the clip already fits');
  } finally {
    await page.close();
  }
});

test('drag from end to Bar 5 updates state and layout; undo/redo restore both', async () => {
  const { page, clip } = await openFixture(28, 3600);
  try {
    const start = await assertAligned(page, clip, 28);
    const pointerX = start.x + 60;
    const pointerY = start.y + 12;
    await page.mouse.move(pointerX, pointerY);
    await page.mouse.down();
    await page.mouse.move(pointerX - 24 * 96, pointerY, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#fixture-project-clips').textContent)[0].startBar === 4);
    await assertAligned(page, clip, 4);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#fixture-project-clips').textContent)[0].startBar === 28);
    await assertAligned(page, clip, 28);

    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#fixture-project-clips').textContent)[0].startBar === 4);
    await assertAligned(page, clip, 4);
  } finally {
    await page.close();
  }
});
