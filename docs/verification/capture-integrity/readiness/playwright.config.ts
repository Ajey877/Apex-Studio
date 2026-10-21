import { defineConfig } from '@playwright/test';
import base from '../playwright.config';
export default defineConfig({ ...base, testDir: '.', testMatch: 'readiness.spec.ts',
  repeatEach: Number(process.env.CAPTURE_REPEATS ?? 3), workers: 1, retries: 0,
  projects: [{ name: 'chromium', use: { ...base.projects?.[0]?.use,
    ...(process.env.CAPTURE_SYSTEM_CHROME ? { channel: 'chrome' } : {}) } }],
});
