import { defineConfig } from '@playwright/test';
import base from '../readiness/playwright.config';
export default defineConfig({...base,testDir:'.',testMatch:'isolation.spec.ts',repeatEach:Number(process.env.CAPTURE_REPEATS ?? 10),workers:1,retries:0});
