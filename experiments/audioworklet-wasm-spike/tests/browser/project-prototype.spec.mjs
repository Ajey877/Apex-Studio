// Acceptance tests for the bounded synthetic multi-track live/offline prototype.
// Browser platforms are separate Playwright projects; Electron uses its own runner.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultsDir = join(spikeRoot, 'results');
mkdirSync(resultsDir, { recursive: true });

async function openPrototype(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('crash', () => errors.push('PAGE CRASHED'));
  await page.goto('/csp-none/web/index.html');
  return errors;
}

async function run(page, functionName, args = []) {
  return page.evaluate(async ({ functionName, args }) => {
    const module = await import(new URL('./project-prototype.mjs', location.href).href);
    return module[functionName](...args);
  }, { functionName, args });
}

function save(testInfo, name, result) {
  const file = join(resultsDir, `${testInfo.project.name}-project-${name}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return testInfo.attach(name, { path: file, contentType: 'application/json' });
}

test.describe('prototype-only representative Apex-style multitrack project', () => {
  test('[must] live shared engine: independent tracks, routing, effects, automation, timing and slot release', async ({ page }, testInfo) => {
    const errors = await openPrototype(page);
    const result = await run(page, 'runLiveProjectParity');
    await save(testInfo, 'live-project', result);
    console.log(`[${testInfo.project.name}] live multitrack: ${JSON.stringify({
      pass: result.pass,
      trackIds: result.fixture.trackIds,
      events: result.fixture.clipEventCount,
      maxAbsDiff: result.comparisons.maxAbsDiff,
      tolerance: result.comparisons.tolerance,
      alternateOrderDiff: result.orderingSensitivity.alternateMaxAbsDiff,
      worklet: result.live,
      playbackStats: result.audioContext.playbackStats,
      disposedSlots: result.disposed.after.slotsInUse,
    })}`);
    expect(errors).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.fixture.trackIds).toHaveLength(4);
    expect(result.fixture.clipEventCount).toBeGreaterThanOrEqual(40);
    expect(result.source.distinct).toBe(true);
    expect(result.comparisons.withinTolerance).toBe(true);
    expect(result.comparisons.maxAbsDiff).toBeLessThanOrEqual(1e-6);
    expect(result.orderingSensitivity.alternateMaxAbsDiff).toBeGreaterThan(1e-6);
    expect(result.live.engineInstances).toBe(1);
    expect(result.live.wasmMemoryBytes).toBe(131072);
    expect(result.live.slotsInUse).toBe(4);
    expect(result.live.frameDiscontinuities).toBe(0);
    expect(result.live.kernelErrors).toBe(0);
    expect(result.disposed.after.slotsInUse).toBe(0);
  });

  test('[must] live parameter changes update only the addressed track', async ({ page }, testInfo) => {
    const errors = await openPrototype(page);
    const result = await run(page, 'runLiveParameterChange');
    await save(testInfo, 'live-parameter-change', result);
    console.log(`[${testInfo.project.name}] live parameter change: ${JSON.stringify({
      pass: result.pass,
      appliedAtProjectFrame: result.appliedAtProjectFrame,
      before: result.regions.before,
      after: result.regions.after,
      unaffectedHatMaxAbsDiff: result.regions.unaffectedHatMaxAbsDiff,
      deadlines: result.worklet.missedDeadlines,
      playbackStats: result.audioContext.playbackStats,
    })}`);
    expect(errors).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.oldControls.fader).toBe(0.78);
    expect(result.newControls.fader).toBe(0.12);
    expect(result.regions.after.ratioToUnchangedBaseline).toBeLessThan(0.25);
    expect(result.regions.unaffectedHatMaxAbsDiff).toBeLessThanOrEqual(1e-6);
    expect(result.disposed.after.slotsInUse).toBe(0);
  });

  test('[must] long-lived Worker completes 200 full fixture exports with stable memory and deterministic WAV output', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const errors = await openPrototype(page);
    const result = await run(page, 'runOfflineProjectBatch', [{ renders: Number(process.env.SPIKE_PROJECT_EXPORTS || 200) }]);
    await save(testInfo, 'offline-200-exports', result);
    console.log(`[${testInfo.project.name}] Worker exports: ${JSON.stringify({
      pass: result.pass,
      jobsCompleted: result.jobsCompleted,
      fixture: result.fixture,
      memoryBytes: [result.wasmMemoryBytesMin, result.wasmMemoryBytesMax],
      hashes: result.hashes,
      decodedFirstExport: result.decodedFirstExport,
      numerical: result.numerical,
      performance: result.performance,
      heap: result.memory,
      wavBytesPerExport: result.wavBytesPerExport,
    })}`);
    expect(errors).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.jobsCompleted).toBe(200);
    expect(result.wasmMemoryBytesMin).toBe(131072);
    expect(result.wasmMemoryBytesMax).toBe(131072);
    expect(result.hashes.distinctRepeatedExportHashes).toBe(1);
    expect(result.hashes.matchesIndependentReferenceWithinPcmTolerance).toBe(true);
    expect(result.numerical.maxAbsDiffAfterPCM16Quantization).toBeLessThanOrEqual(result.numerical.tolerance);
  });

  test('[must] Worker cancellation is cooperative and a full export succeeds afterward', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors = await openPrototype(page);
    const result = await run(page, 'runOfflineCancellationRecovery');
    await save(testInfo, 'offline-cancel-recovery', result);
    console.log(`[${testInfo.project.name}] cancel/recovery: ${JSON.stringify(result)}`);
    expect(errors).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.cancel.acknowledged).toBe(true);
    expect(result.memory.jobsCancelled).toBe(1);
    expect(result.memory.jobsCompleted).toBe(1);
    expect(result.memory.engineInstances).toBe(1);
    expect(result.memory.wasmMemoryBytes).toBe(131072);
    expect(result.recovery.matchesReference).toBe(true);
  });
});
