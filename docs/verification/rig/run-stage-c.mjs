#!/usr/bin/env node
// CDP runner for the Stage C interleaved 16/32-step live-engine campaign.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const rigDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rigDir, '../../..');
const workDir = path.resolve(process.env.STAGE_C_WORKDIR ?? '/tmp/apex-stage-c');
const outputPath = path.resolve(process.env.STAGE_C_OUTPUT ?? path.join(repoRoot, 'docs/verification/results/stage_c_pattern_length_campaign.json'));
const validPairsTarget = Number.parseInt(process.env.STAGE_C_VALID_PAIRS ?? '100', 10);
const maxRounds = Number.parseInt(process.env.STAGE_C_MAX_ROUNDS ?? '150', 10);
const cdpUrl = process.env.RIG_CDP ?? 'http://127.0.0.1:9222';
const rigUrl = process.env.STAGE_C_RIG_URL ?? 'http://127.0.0.1:8099/stage-c-rig.html';

if (!Number.isInteger(validPairsTarget) || validPairsTarget < 100) {
  throw new Error(`STAGE_C_VALID_PAIRS must be an integer >=100 (received ${validPairsTarget})`);
}
if (!Number.isInteger(maxRounds) || maxRounds < validPairsTarget) {
  throw new Error(`STAGE_C_MAX_ROUNDS must be >= STAGE_C_VALID_PAIRS (received ${maxRounds})`);
}
if (existsSync(outputPath)) {
  throw new Error(`Refusing to overwrite existing raw data: ${outputPath}`);
}

const manifest = JSON.parse(readFileSync(path.join(workDir, 'manifest.json'), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// Strict round-robin: every 16-step run is immediately followed by a
// 32-step run, and then the next pair returns to 16 steps.
function makeRoundRobinOrders(count) {
  return Array.from({ length: count }, () => [16, 32]);
}

function persist(data) {
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(data, null, 2) + '\n');
  renameSync(temporaryPath, outputPath);
}

let browser;
let page;
let campaign;
try {
  browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('console', (message) => {
    if (message.type() === 'error') process.stderr.write(`[page console] ${message.text()}\n`);
  });
  page.on('pageerror', (error) => process.stderr.write(`[page error] ${error.message}\n`));

  let bundleResponsePromiseResolve;
  const bundleResponsePromise = new Promise((resolve) => { bundleResponsePromiseResolve = resolve; });
  let bundleResponseSeen = false;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/bundle-engine.js' || bundleResponseSeen) return;
    bundleResponseSeen = true;
    void (async () => {
      const body = await response.body();
      const headers = response.headers();
      bundleResponsePromiseResolve({
        status: response.status(),
        url: response.url(),
        bodySha256: sha256(body),
        bodyBytes: body.length,
        cacheControl: headers['cache-control'] ?? null,
        fromServiceWorker: response.fromServiceWorker(),
      });
    })().catch((error) => bundleResponsePromiseResolve({ error: error.message }));
  });

  await page.goto(`${rigUrl}?load=${Date.now()}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('window.__stageCRigReady === true', null, { timeout: 30000 });
  const bundleResponse = await Promise.race([
    bundleResponsePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('bundle response was not observed')), 10000)),
  ]);
  if (bundleResponse.error) throw new Error(`Could not verify bundle response: ${bundleResponse.error}`);
  if (bundleResponse.status !== 200) throw new Error(`Bundle HTTP status was ${bundleResponse.status}, expected 200`);
  if (bundleResponse.bodySha256 !== manifest.bundleSha256) {
    throw new Error(`Executed bundle digest mismatch: response=${bundleResponse.bodySha256}, manifest=${manifest.bundleSha256}`);
  }
  if (!bundleResponse.cacheControl?.includes('no-store') || bundleResponse.fromServiceWorker) {
    throw new Error(`Bundle cache gate failed: cache-control=${bundleResponse.cacheControl}, service-worker=${bundleResponse.fromServiceWorker}`);
  }

  const runtime = await page.evaluate(() => window.stageCGetInfo());
  if (runtime.sourceCommit !== manifest.sourceCommit) {
    throw new Error(`Browser bundle source marker mismatch: ${runtime.sourceCommit} vs ${manifest.sourceCommit}`);
  }
  if (runtime.sampleRate !== 44100) {
    throw new Error(`AudioContext sample rate is ${runtime.sampleRate}, expected 44100 Hz; no conditions were run`);
  }
  if (runtime.startLeadSeconds !== 0.03) {
    throw new Error(`Unexpected production start lead ${runtime.startLeadSeconds}; bundle identity gate failed`);
  }

  const channelFixtureHash = sha256(Buffer.from(stableStringify(runtime.channelFixture)));
  const orders = makeRoundRobinOrders(maxRounds);

  campaign = {
    schema: 'apex-studio-stage-c-pattern-length-v1',
    status: 'running',
    metadata: {
      experiment: 'Stage C final controlled experiment — pattern length vs load variation',
      startedAtUtc: new Date().toISOString(),
      sourceBranch: manifest.sourceBranch,
      sourceCommit: manifest.sourceCommit,
      sourceArchiveSha256: manifest.sourceArchiveSha256,
      bundleSha256: manifest.bundleSha256,
      bundleBytes: manifest.bundleBytes,
      esbuildVersion: manifest.esbuildVersion,
      bundleResponse,
      cdpUrl,
      rigUrl,
      validPairedRoundsTarget: validPairsTarget,
      maximumRounds: maxRounds,
      roundRobinOrder: [16, 32],
      orderPlan: orders,
      runtime,
      channelFixtureSha256: channelFixtureHash,
      design: {
        conditions: [16, 32],
        activeSteps: [0, 8],
        onlyPatternConditionChange: 'Pattern.lengthSteps and the matching zero-padded channel.steps storage length',
        bpm: 120,
        eventSpacingSeconds: 1,
        mode: 'Pattern (pat)',
        patternLoopLengthSteps: '16 or 32, passed to production audioEngine.play()',
        sampleRateHz: 44100,
        captureBufferSamples: 4096,
        captureRenderQuantumSamples: 128,
        injectedReferenceBurstInEitherCondition: false,
        effects: 'no channel FX; identical master engine state; capture tapped at masterGain before the master output chain',
        interleaving: 'strict round-robin, 16-step then 32-step on every adjacent pair; no blocked condition runs',
      },
      measurement: {
        productionPath: 'audioEngine.play() -> production AudioClockTransport -> production triggerCurrentStep() -> MiniSynth voice',
        tap: runtime.captureMethod.tap,
        onsetDetector: runtime.captureMethod.detector,
        primary: 'N0 - N8 differential in ms = (scheduledStep8 - scheduledStep0) - (observedOnset8 - observedOnset0)',
        exclusions: [
          'sample-rate mismatch',
          'step 0 or step 8 trigger count not exactly one',
          'onset count not exactly two',
          'one or more dropped capture buffers',
          'capture chunks not all 4096 samples or mean chunk step differs from 4096',
        ],
        retainedOutliers: true,
        bundleStartLeadMedianGate: 'diagnostic only; median scheduledStep0-tCall must be near 30 ms for each pattern length; never used to exclude an otherwise valid run',
      },
      artifactPath: path.relative(repoRoot, outputPath),
    },
    runSequence: [],
    rounds: [],
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  persist(campaign);

  let validPairedRounds = 0;
  for (let roundIndex = 0; roundIndex < maxRounds && validPairedRounds < validPairsTarget; roundIndex += 1) {
    const order = orders[roundIndex];
    const round = {
      roundIndex,
      order,
      sequenceIndices: [],
      complete: false,
      bothRunsValid: false,
      includedInPrimaryPairedAnalysis: false,
      validPairOrdinal: null,
    };
    campaign.rounds.push(round);

    for (let orderPosition = 0; orderPosition < order.length; orderPosition += 1) {
      if (campaign.runSequence.length > 0
          && campaign.runSequence[campaign.runSequence.length - 1].patternLengthSteps === order[orderPosition]) {
        throw new Error('Interleaving guard failed: adjacent campaign runs have the same pattern length');
      }
      const sequenceIndex = campaign.runSequence.length;
      const raw = await page.evaluate((request) => window.stageCRunCondition(request), {
        patternLengthSteps: order[orderPosition],
        roundIndex,
        orderPosition,
        sequenceIndex,
      });
      const record = {
        runId: `C${String(sequenceIndex + 1).padStart(3, '0')}`,
        sourceCommit: manifest.sourceCommit,
        bundleSha256: manifest.bundleSha256,
        ...raw,
      };
      campaign.runSequence.push(record);
      round.sequenceIndices.push(sequenceIndex);
      persist(campaign);

      // The source marker and response digest are fixed before measurement;
      // check the runtime marker after every capture as an in-campaign guard.
      if (record.sourceCommit !== manifest.sourceCommit
          || record.sourceCommitMarker !== manifest.sourceCommit
          || record.bundleSha256 !== manifest.bundleSha256) {
        throw new Error(`Bundle identity changed during ${record.runId}`);
      }
      if (record.inConditionReferenceBurstCount !== 0) {
        throw new Error(`Reference burst detected in ${record.runId}`);
      }
      if (!record.valid) {
        process.stderr.write(`[invalid] ${record.runId} ${record.patternLengthSteps}-step: ${record.exclusionReasons.join(', ')}\n`);
      }
    }

    const first = campaign.runSequence[round.sequenceIndices[0]];
    const second = campaign.runSequence[round.sequenceIndices[1]];
    const byLength = new Map([[first.patternLengthSteps, first], [second.patternLengthSteps, second]]);
    const sixteen = byLength.get(16);
    const thirtyTwo = byLength.get(32);
    round.complete = Boolean(sixteen && thirtyTwo);
    round.bothRunsValid = Boolean(sixteen?.valid && thirtyTwo?.valid);
    if (round.bothRunsValid) {
      validPairedRounds += 1;
      round.includedInPrimaryPairedAnalysis = true;
      round.validPairOrdinal = validPairedRounds;
    }
    persist(campaign);

    if ((roundIndex + 1) % 5 === 0 || validPairedRounds >= validPairsTarget) {
      process.stderr.write(`[progress] rounds=${roundIndex + 1}/${maxRounds}, valid pairs=${validPairedRounds}/${validPairsTarget}, valid 16-step=${campaign.runSequence.filter((run) => run.patternLengthSteps === 16 && run.valid).length}, valid 32-step=${campaign.runSequence.filter((run) => run.patternLengthSteps === 32 && run.valid).length}\n`);
    }
  }

  const valid16 = campaign.runSequence.filter((run) => run.patternLengthSteps === 16 && run.valid).length;
  const valid32 = campaign.runSequence.filter((run) => run.patternLengthSteps === 32 && run.valid).length;
  campaign.status = validPairedRounds >= validPairsTarget && valid16 >= 100 && valid32 >= 100
    ? 'complete'
    : 'incomplete';
  campaign.metadata.completedAtUtc = new Date().toISOString();
  campaign.metadata.validPairedRounds = validPairedRounds;
  campaign.metadata.validRunsByLength = { '16': valid16, '32': valid32 };
  campaign.metadata.bundleIdentityGate = {
    sourceCommitMarkerMatches: runtime.sourceCommit === manifest.sourceCommit,
    browserExecutedBundleSha256MatchesManifest: bundleResponse.bodySha256 === manifest.bundleSha256,
    responseStatus: bundleResponse.status,
    cacheControl: bundleResponse.cacheControl,
    fromServiceWorker: bundleResponse.fromServiceWorker,
  };
  campaign.metadata.startLeadDiagnosticByLength = Object.fromEntries([16, 32].map((length) => {
    const values = campaign.runSequence
      .filter((run) => run.patternLengthSteps === length && run.valid && Number.isFinite(run.startOffsetMs))
      .map((run) => run.startOffsetMs)
      .sort((a, b) => a - b);
    const median = values.length % 2
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
    return [String(length), {
      n: values.length,
      medianScheduledStep0MinusTCallMs: median,
      expectedMs: runtime.startLeadSeconds * 1000,
      gatePass: values.length >= 100 && Math.abs(median - runtime.startLeadSeconds * 1000) < 1,
    }];
  }));
  persist(campaign);

  process.stdout.write(JSON.stringify({
    status: campaign.status,
    outputPath,
    sourceCommit: manifest.sourceCommit,
    bundleSha256: manifest.bundleSha256,
    validPairedRounds,
    validRunsByLength: { '16': valid16, '32': valid32 },
    startLeadDiagnosticByLength: campaign.metadata.startLeadDiagnosticByLength,
    bundleIdentityGate: campaign.metadata.bundleIdentityGate,
  }, null, 2) + '\n');
  if (campaign.status !== 'complete') process.exitCode = 1;
} finally {
  if (page) {
    try { await page.close(); } catch (_) { /* browser may already have disconnected */ }
  }
  if (browser) {
    try { await browser.close(); } catch (_) { /* browser may already have disconnected */ }
  }
}
