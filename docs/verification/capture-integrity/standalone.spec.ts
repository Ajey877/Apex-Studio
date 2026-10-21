import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { standaloneCapture } from './capture';
import { analyzeCapture } from './analyze';

// Each Playwright case gets a fresh page; each run gets a fresh AudioContext.
for (const [name, seconds, workload] of [
  ['short-1', 1, false], ['long-1', 5, false], ['workload-1', 2, true],
  ['repeat-1', 1, false], ['repeat-2', 1, false], ['long-2', 5, false],
  ['extended', 15, false], ['workload-2', 5, true],
  ['offline-contexts', 5, false],
] as const) {
  test(name, async ({ page, browser }) => {
    await page.route('http://localhost:3000/', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Standalone capture integrity</title>',
    }));
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto('http://localhost:3000/');
    const run = await page.evaluate(standaloneCapture, { seconds, workload, offlineWorkload: name === 'offline-contexts' });
    const metrics = analyzeCapture(run);
    const dir = `docs/verification/capture-integrity/evidence/${process.env.CAPTURE_BATCH ?? `local-${Date.now()}`}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}.json.gz`, gzipSync(JSON.stringify({ browserVersion: browser.version(), ...run,
      pcmEncoding: 'base64-float32-le', requests, records: run.records.map(record => {
        const { pcm, ...metadata } = record;
        return { ...metadata, pcmBase64: Buffer.from(Float32Array.from(pcm).buffer).toString('base64') };
      }) })));
    writeFileSync(`${dir}/${name}.summary.json`, JSON.stringify({ name, browserVersion: browser.version(),
      environment: run.environment, ...metrics }, null, 2));
    console.log(name, JSON.stringify(metrics));
    expect(requests.some(url => url.includes('/src/'))).toBe(false);
    expect(metrics.passed, JSON.stringify(metrics.firstFailure)).toBe(true);
  });
}
