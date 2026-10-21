import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { captureWithReadiness } from './capture';
import { analyzeReady } from './analyze';

for (const [name, seconds, workload] of [['short', 1, false], ['long', 10, false], ['workload', 3, true]] as const) {
  test(name, async ({ page, browser }, info) => {
    await page.route('http://localhost:3000/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Readiness</title>' }));
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto('http://localhost:3000/');
    const runId = `${process.env.GITHUB_RUN_ID ?? 'local'}-${info.project.name}-${name}-${info.repeatEachIndex}-${randomUUID()}`;
    const result = await page.evaluate(captureWithReadiness, { runId, seconds, workload });
    const metrics = analyzeReady(result);
    const raw = { ...result, browserVersion: browser.version(), playwrightVersion: require('@playwright/test/package.json').version,
      requests, pcmEncoding: 'base64-float32-le', records: result.records.map(({ pcm, ...metadata }) => ({
        ...metadata, pcmBase64: Buffer.from(Float32Array.from(pcm).buffer).toString('base64'),
      })) };
    const bytes = gzipSync(JSON.stringify(raw));
    const dir = process.env.READINESS_RESULTS ?? 'docs/verification/capture-integrity/readiness/results';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${runId}.json.gz`, bytes);
    writeFileSync(`${dir}/${runId}.summary.json`, JSON.stringify({ browserVersion: browser.version(),
      playwrightVersion: raw.playwrightVersion, environment: result.environment, stateChanges: result.stateChanges,
      window: result.window, rawSha256: createHash('sha256').update(bytes).digest('hex'), ...metrics }, null, 2));
    console.log('READINESS', JSON.stringify(metrics));
    expect(requests.some(url => url.includes('/src/'))).toBe(false);
    expect(metrics.passed).toBe(true);
  });
}
