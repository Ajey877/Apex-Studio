import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config';
export default defineConfig({ ...base, testDir: '.', fullyParallel: false, workers: 1, retries: 0,
  reporter: [['list']], timeout: 120_000,
  projects: base.projects?.map(project => ({ ...project, use: { ...project.use,
    launchOptions: { ...project.use?.launchOptions,
      ...(process.env.CAPTURE_CHROMIUM ? { executablePath: process.env.CAPTURE_CHROMIUM } : {}) } } })) });
