// Validates the method used by electron/probe-production-app.mjs: probes
// evaluated over the DevTools protocol (Runtime.evaluate) must observe the page's
// CSP exactly as page scripts do (REPORT §12.4). Runs probeViaCdp() against pages
// served with known CSPs in a browser launched with --remote-debugging-port.
import { test, expect } from '@playwright/test';
import { probeViaCdp } from '../../electron/probe-production-app.mjs';

// inline = DOM-injected inline <script> (the CSP-enforcement indicator).
// Page scripts see eval blocked under both production policies (§12.4), but
// DevTools-evaluated code is exempt from that check, so eval is only recorded.
const CASES = [
  { mode: 'csp-none', inline: 'allowed', wasm: 'allowed' },
  { mode: 'csp-production', inline: 'blocked', wasm: 'blocked' },
  { mode: 'csp-production-wasm', inline: 'blocked', wasm: 'allowed' },
];

test('[must] DevTools-evaluated probes observe the page CSP like page scripts (method check for the production-app probe)', async ({ playwright, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const port = 9400 + Math.floor(Math.random() * 400);
  const use = testInfo.project.use;
  const base = use.launchOptions || {};
  const browser = await playwright.chromium.launch({ ...base, channel: use.channel, headless: true, args: [...(base.args || []), `--remote-debugging-port=${port}`] });
  const seen = {};
  try {
    const page = await browser.newPage();
    for (const c of CASES) {
      await page.goto(new URL(`/${c.mode}/web/index.html`, baseURL).href);
      const r = await probeViaCdp({ port, match: url => url.includes(`/${c.mode}/web/`), timeoutMs: 30_000 });
      seen[c.mode] = { inlineScript: r.inlineScript, violations: r.violations, evalFromDevtools: r.evalFromDevtools, newFunctionFromDevtools: r.newFunctionFromDevtools, wasmCompile: r.wasmCompile.split(':')[0], wasmModuleSync: r.wasmModuleSync, wasmInstantiate: r.wasmInstantiate, memoryCap: r.memoryCap };
      expect(r.inlineScript, `${c.mode} inline script`).toBe(c.inline);
      if (c.inline === 'blocked') expect(r.violations.some(v => v.startsWith('script-src')), `${c.mode} violation event`).toBe(true);
      expect(r.wasmCompile.split(':')[0], `${c.mode} WebAssembly.compile`).toBe(c.wasm);
      expect(r.wasmModuleSync.split(':')[0], `${c.mode} new WebAssembly.Module`).toBe(c.wasm);
      expect(r.wasmInstantiate.split(':')[0], `${c.mode} WebAssembly.instantiate`).toBe(c.wasm);
    }
  } finally {
    console.log(`[${testInfo.project.name}] production-probe method check: ${JSON.stringify(seen)}`);
    await browser.close();
  }
});
