import { defineConfig } from '@playwright/test';
import base from './playwright.config';
// Explicit native gate: never silently skip when the actual helper/fixture is absent.
export default defineConfig({ ...base, testDir: 'native-browser-tests', workers: 1, retries: 0 });
