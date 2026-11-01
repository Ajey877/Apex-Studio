import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const packageRoot = join(process.cwd(), 'dist-electron', 'win-unpacked');
const candidates = readdirSync(packageRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  .map(entry => join(packageRoot, entry.name));
const executable = candidates.find(path => path.toLowerCase().includes('apex')) ?? candidates[0];
if (!executable || !existsSync(executable)) throw new Error('Packaged executable not found');
const fixture = join(process.cwd(), 'build/native-vst3/VST3/Release/mda-vst3.vst3');
if (!existsSync(fixture)) throw new Error('Build the real MDA VST3 fixture before packaged smoke');
const evidence = join(process.cwd(), 'build/native-evidence');
mkdirSync(evidence, { recursive: true });
// Never write test projects into the user's real Apex profile. Preserve exactly
// this isolated profile between two genuinely separate application processes.
const profile = mkdtempSync(join(process.cwd(), 'build/vst3-smoke-profile-'));
async function launch(reopening) {
  const output = join(evidence, `apex-packaged-smoke-${reopening ? 'reopen' : 'save'}.json`);
  console.log(`[Apex Studio smoke] ${reopening ? 'reopening saved project in new process' : 'launching isolated profile'}: ${executable}`);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      env: { ...process.env, APEX_SMOKE_TEST: '1', APEX_SMOKE_REOPEN: reopening ? '1' : '0',
        APEX_VST3_SMOKE_PLUGIN: fixture, APEX_SMOKE_EVIDENCE: output, APEX_SMOKE_USER_DATA: profile },
      stdio: 'inherit', windowsHide: true,
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timed out waiting for packaged app')); }, 120_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Packaged app exited unsuccessfully: ${code ?? signal}`));
    });
  });
  return JSON.parse(readFileSync(output, 'utf8'));
}
try {
  const saved = await launch(false);
  const reopened = await launch(true);
  for (const [label, result] of [['save process', saved], ['reopen process', reopened]]) {
    const mixer = result.vst3?.mixerEffects;
    assert.equal(mixer?.status, 'passed', `${label} did not complete packaged production Mixer-effect acceptance`);
    for (const [runName, timing] of Object.entries(mixer.timing)) {
      assert.equal(timing.missedDeadlines, 0, `${label} ${runName} reported a Mixer deadline miss`);
      assert.equal(timing.unaccountedRequestCount, 0, `${label} ${runName} reported unaccounted Mixer requests`);
      assert.equal(timing.nativeServiceSessionCountAfterCleanup, 0, `${label} ${runName} leaked native helper sessions`);
    }
    assert.equal(mixer.projectReplacementCleanup?.nativeServiceSessionCountAfterReplacement, 0,
      `${label} leaked native helper sessions after project replacement`);
    for (const [stageGroup, stages] of Object.entries(mixer.twoInsertPcmEvidence ?? {})) {
      assert.equal(Object.keys(stages).length, 2, `${label} ${stageGroup} must capture two insert stages`);
      for (const [slotId, metrics] of Object.entries(stages)) {
        assert.equal(metrics.nonFiniteCount, 0, `${label} ${stageGroup} ${slotId} emitted non-finite samples`);
        assert.ok(metrics.leftRms > 0.01 && metrics.rightRms > 0.01 && metrics.rms > 0.01,
          `${label} ${stageGroup} ${slotId} was silent: ${JSON.stringify(metrics)}`);
      }
    }
    assert.equal(mixer.twoInsertSaveReopen?.playbackActiveAtEnd, true, `${label} two-insert save/reopen playback stopped`);
    for (const [slotId, metrics] of Object.entries(mixer.twoInsertSaveReopen?.stagePcm ?? {})) {
      assert.equal(metrics.nonFiniteCount, 0, `${label} save/reopen ${slotId} emitted non-finite samples`);
      assert.ok(metrics.leftRms > 0.01 && metrics.rightRms > 0.01 && metrics.rms > 0.01,
        `${label} save/reopen ${slotId} was silent: ${JSON.stringify(metrics)}`);
    }
  }
  assert.equal(reopened.vst3.mixerEffects.persistedTwoInsertStateChecksum, saved.vst3.mixerEffects.persistedTwoInsertStateChecksum,
    'Actual application restart changed persisted two-insert Mixer VST3 configuration/parameters');
  assert.equal(reopened.vst3.mixerEffects.twoInsertSaveReopen?.restoredFromIndexedDb, true);
  for (const field of ['classId', 'onsetFrame', 'rms', 'pcmChecksum', 'savedStateChecksum', 'parameterValue', 'parameterExportDifferenceRms', 'automationPcmChecksum', 'automationStateChecksum', 'automationExportDifferenceRms']) {
    assert.equal(reopened.vst3[field], saved.vst3[field], `Actual application restart changed ${field}`);
  }
  assert.equal(reopened.vst3.uiRestored, true);
  writeFileSync(join(evidence, 'apex-packaged-smoke.json'), JSON.stringify({ saved, reopened, applicationRestartEqual: true }, null, 2));
  console.log('[Apex Studio smoke] packaged live/export/save/application-restart smoke passed');
  if (process.env.GITHUB_ACTIONS) {
    const { timingSamples: _samples, ...mixerSummary } = reopened.vst3.mixerEffects;
    console.log(`::notice title=Packaged VST3 application restart proof::${JSON.stringify({ applicationRestartEqual: true, ...reopened.vst3, mixerEffects: mixerSummary })}`);
    const compactTiming = Object.fromEntries(Object.entries(reopened.vst3.mixerEffects.timing).map(([runName, t]) => [runName, {
      requestCount: t.requestCount,
      acceptedWorkletResults: t.acceptedWorkletResults,
      cancelledAtStopBlocks: t.cancelledAtStopBlocks,
      missedDeadlines: t.missedDeadlines,
      unaccountedRequestCount: t.unaccountedRequestCount,
      nativeServiceSessionCountAfterCleanup: t.nativeServiceSessionCountAfterCleanup,
      workletReceiptMaxMs: t.workletSubmissionToReceipt?.maxMs ?? null,
      nativeServiceMaxMs: t.mainNativeServiceCall?.maxMs ?? null,
    }]));
    console.log(`::notice title=Packaged VST3 two-insert Mixer proof::${JSON.stringify({
      persistedTwoInsertStateChecksum: reopened.vst3.mixerEffects.persistedTwoInsertStateChecksum,
      twoInsertPcmEvidence: reopened.vst3.mixerEffects.twoInsertPcmEvidence,
      twoInsertSaveReopen: reopened.vst3.mixerEffects.twoInsertSaveReopen,
      projectReplacementCleanup: reopened.vst3.mixerEffects.projectReplacementCleanup,
      rendererStallRegression: reopened.vst3.mixerEffects.rendererStallRegression,
      timing: compactTiming,
    })}`);
  }
  rmSync(profile, { recursive: true, force: true });
} catch (error) {
  console.error('[Apex Studio smoke]', error);
  console.error(`[Apex Studio smoke] failed isolated profile retained at ${profile}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Packaged VST3 restart failed::${String(error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
  process.exitCode = 1;
}
