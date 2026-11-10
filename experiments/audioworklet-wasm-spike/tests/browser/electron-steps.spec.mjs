// Executes the Electron investigation step list (electron/investigation-steps.cjs)
// in a Playwright browser, the same way electron/main.cjs does (fresh document
// per step, expression evaluated in the page). Purpose: prove the step
// expressions run and produce the expected shapes before they run in Electron
// on Windows CI. This is NOT Electron evidence.
//
// Opt-in (adds minutes):  SPIKE_ELECTRON_STEPS=1
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { investigationSteps, summarizeInvestigation } = require('../../electron/investigation-steps.cjs');

test.skip(process.env.SPIKE_ELECTRON_STEPS !== '1', 'opt-in: SPIKE_ELECTRON_STEPS=1');

test('Electron investigation steps execute in a browser with the expected shapes', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('crash', () => errors.push('PAGE CRASHED'));
  // Same as main.cjs: a full main-thread GC after each fresh load, via CDP.
  const cdp = await page.context().newCDPSession(page);
  const inv = { steps: {} };
  for (const step of investigationSteps({ instances: 16, env: process.env })) {
    const t0 = Date.now();
    try {
      if (step.fresh) { await page.goto('/csp-none/web/index.html'); await cdp.send('HeapProfiler.collectGarbage'); }
      inv.steps[step.id] = { ok: true, ms: Date.now() - t0, value: await page.evaluate(step.js) };
    } catch (err) {
      inv.steps[step.id] = { ok: false, ms: Date.now() - t0, error: String(err && err.message).slice(0, 300) };
    }
  }
  const s = summarizeInvestigation(inv);
  console.log(`[${testInfo.project.name}] electron-steps summary ${JSON.stringify(s)}`);
  expect(errors).toEqual([]);
  expect(s.stepErrors).toEqual([]);
  expect(s.capacity.fresh).toBeGreaterThanOrEqual(100);
  expect(s.capacity.afterOfflineThroughput).toBeLessThan(s.capacity.fresh - 10);
  expect(s.parity.pass).toBe(true);
});
