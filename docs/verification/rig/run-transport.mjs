// SCRATCH — verification rig driver (CDP).
//
// Chromium in this sandbox cannot be launched by Playwright (AudioWorklet
// crashes the page), so the driver attaches over CDP to an already-running
// headless Chromium with --remote-debugging-port.
import { chromium } from 'playwright';

const RIG_PORT = process.env.RIG_PORT || '8099';
const RIG_CDP = process.env.RIG_CDP || 'http://127.0.0.1:9222';
const CONDITIONS = JSON.parse(process.env.RIG_CONDITIONS || '[]');

const browser = await chromium.connectOverCDP(RIG_CDP);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n');
});
page.on('pageerror', (e) => process.stderr.write('[pageerror] ' + e.message + '\n'));

const url = `http://127.0.0.1:${RIG_PORT}/scratch-rig/rig-transport.html`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__rigReady === true', null, { timeout: 30000 });

const globals = await page.evaluate(() => ({
  hasTransport: typeof window.AudioClockTransport === 'function',
  hasEngine: typeof window.audioEngine === 'object',
  lead: window.START_LEAD_SECONDS ?? null,
}));
process.stderr.write('globals: ' + JSON.stringify(globals) + '\n');

const results = await page.evaluate(async (conds) => window.runRig(conds), CONDITIONS);

process.stdout.write(JSON.stringify(results, null, 1));
await page.close();
await browser.close();
