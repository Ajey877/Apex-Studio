import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const customChromiumPath = existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined;
const customEnv = customChromiumPath
  ? {
      ...process.env,
      LD_LIBRARY_PATH: ['/tmp/al2023/lib', '/tmp', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      FONTCONFIG_PATH: '/tmp/fonts',
    }
  : undefined;

export default defineConfig({
  testDir: 'browser-tests',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(customChromiumPath
          ? {
              launchOptions: {
                executablePath: customChromiumPath,
                args: [
                  '--no-sandbox',
                  '--no-zygote',
                  '--disable-setuid-sandbox',
                  '--disable-dev-shm-usage',
                  '--disable-gpu',
                ],
                env: customEnv,
              },
            }
          : {}),
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
