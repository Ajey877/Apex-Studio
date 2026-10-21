import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { captureWithReadiness } from '../readiness/capture';
import { analyzeIsolation } from './analyze';
const require = createRequire(import.meta.url);
for (const [profile, seconds, workload] of [['short',1,false], ['long',10,false], ['workload',3,true]] as const) {
  test(profile, async ({ page, browser }, info) => {
    const mode = (process.env.ISOLATION_MODE ?? 'lead') as 'lead' | 'no-ready' | 'immediate' | 'generated';
    await page.route('http://localhost:3000/', route => route.fulfill({ contentType:'text/html',body:'<!doctype html><title>Standalone isolation</title>' }));
    await page.goto('http://localhost:3000/');
    const runId = `${process.env.GITHUB_RUN_ID ?? 'local'}-${mode}-${profile}-${info.repeatEachIndex}-${randomUUID()}`;
    const result = await page.evaluate(captureWithReadiness, {runId,seconds,workload,mode});
    const metrics = analyzeIsolation(result);
    const raw = { ...result, browserVersion:browser.version(), playwrightVersion:require('@playwright/test/package.json').version,
      records:result.records.map(({pcm,...metadata})=>({...metadata,pcmBase64:Buffer.from(Float32Array.from(pcm).buffer).toString('base64')})) };
    const bytes = gzipSync(JSON.stringify(raw));
    const dir=process.env.ISOLATION_RESULTS ?? 'docs/verification/capture-integrity/readiness/results/isolation';
    mkdirSync(dir,{recursive:true});
    writeFileSync(`${dir}/${runId}.json.gz`,bytes);
    writeFileSync(`${dir}/${runId}.summary.json`,JSON.stringify({browserVersion:browser.version(),playwrightVersion:raw.playwrightVersion,profile,
      rawSha256:createHash('sha256').update(bytes).digest('hex'),sampleRate:result.sampleRate,...metrics},null,2));
    expect(result.requiredQuanta).toBe(32); expect(metrics.readiness).toBe(true);
    expect(metrics.identityErrors).toBe(0); expect(metrics.ownershipErrors).toBe(0);
    expect(metrics.integrity).toBe(true); expect(metrics.fidelity).toBe(true);
    if(mode==='lead') expect(metrics.baselineContractPass).toBe(true);
  });
}
