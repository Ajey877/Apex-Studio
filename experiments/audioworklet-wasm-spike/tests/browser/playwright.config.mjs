// Playwright config for the spike ONLY (the repo-root playwright.config.ts
// targets browser-tests/ and is untouched). Run from the spike directory:
//   node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chrome
//
// Projects:
//   chromium — Playwright's bundled Chromium (Linux CI / local)
//   chrome   — installed Google Chrome stable (channel 'chrome')
//   msedge   — installed Microsoft Edge stable (channel 'msedge')
// Env:
//   SPIKE_HEADED=1      run headed (closer to a real desktop audio path)
//   SPIKE_INSTANCES=16  sustained-load instance count
//   SPIKE_SECONDS=20    sustained-load duration (seconds)
//   SPIKE_PORT=4173     static server port
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.SPIKE_PORT || 4173);
const headless = process.env.SPIKE_HEADED !== '1';
const args = ['--autoplay-policy=no-user-gesture-required'];

// Local sandbox convenience only (mirrors the repo-root config): use a
// pre-extracted Chromium at /tmp/chromium when Playwright's download is absent.
const localChromium = !process.env.CI && existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined;
const localChromiumLaunch = localChromium
  ? {
      executablePath: localChromium,
      args: [...args, '--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--disable-gpu'],
      env: { ...process.env, LD_LIBRARY_PATH: ['/tmp/al2023/lib', '/tmp', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'), FONTCONFIG_PATH: '/tmp/fonts' },
    }
  : { args };

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  outputDir: join(spikeRoot, 'results', 'playwright-artifacts'),
  timeout: 300_000,
  fullyParallel: false,
  workers: 1, // performance tests must not compete for CPU
  retries: 0, // a flaky audio result is a finding, not something to retry away
  reporter: [['list'], ['json', { outputFile: join(spikeRoot, 'results', 'playwright-report.json') }]],
  use: { baseURL: `http://127.0.0.1:${port}`, headless },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: localChromiumLaunch } },
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome', launchOptions: { args } } },
    { name: 'msedge', use: { browserName: 'chromium', channel: 'msedge', launchOptions: { args } } },
  ],
  webServer: {
    command: `node server/serve.mjs --port ${port}`,
    cwd: spikeRoot,
    url: `http://127.0.0.1:${port}/web/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
