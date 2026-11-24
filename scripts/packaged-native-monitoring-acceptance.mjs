// Packaged Windows acceptance: an ALREADY-RUNNING native VST3 Mixer insert must
// survive live-input monitoring initialization while the transport plays.
//
// WHAT THIS IS: Playwright launches the REAL packaged Electron application
// (`dist-electron/win-unpacked/*.exe`) with its real preload bridge, its real
// native VST3 helper process (`apex-vst3-host.exe`) and a REAL native plugin from
// the MDA VST3 bundle. The insert is created through the real Mixer UI, the
// transport is started through the real Play control, and monitoring is enabled
// and disabled through the real Mixer buttons. Native processing is measured from
// the production diagnostics that already exist: the main process's per-block
// `processAudio` timings (real native input/output RMS and per-block errors) and
// the renderer's native Mixer smoke events (worklet block submissions and
// real-time deadline misses). Helper facts come from the OS process table.
//
// WHAT THIS IS NOT: no dev server, no browser tab, no simulated bridge, no
// JavaScript stand-in for the plugin. The audio fed to the insert is a
// deterministic buffer (the same mechanism the packaged Mixer acceptance uses),
// so "the plugin processes real audio" means real PCM through a real native
// session - it is not a physical instrument performance. The microphone is
// Chromium's fake capture device, so this is NOT physical hardware evidence and
// proves nothing about physical round-trip latency.
//
// Timing instrumentation is enabled with APEX_SMOKE_TIMING_ONLY=1, which passes a
// DISTINCT renderer argument, --apex-smoke-timing-only, and exposes
// `desktopApp.smokeTimings`. It deliberately does NOT set `desktopApp.smokeTest`,
// because src/main.tsx launches the built-in runDesktopVst3Smoke() sequence
// whenever smokeTest is true - that sequence creates its own Mixer inserts on
// track 1, drives the transport and opens extra native sessions, and running it
// alongside this acceptance invalidated the measurement. The existing
// APEX_SMOKE_TEST=1 path (smokeTest, the built-in sequence, and its app.exit()
// entry) is unchanged. No production DSP or native lifecycle behaviour is changed
// by either flag, and this script asserts smokeTimings === true AND
// smokeTest === false so it cannot silently regress.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import { buildCiAnnotation } from './lib/ciAnnotation.mjs';
import { runRepetitions } from './lib/acceptanceRunLoop.mjs';
import { captureFailureEvidence } from './lib/failureEvidence.mjs';
import { coldStartFrom } from './lib/coldStartEvidence.mjs';
import { summarizeCpuObservations } from './lib/cpuObservation.mjs';
import { writeLiveInputFixture } from './live-input-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runs = Math.max(1, Number(process.env.APEX_NATIVE_MONITORING_RUNS ?? '5'));
// Overridable so the five-run gate and the sixty-run diagnostic cannot write over
// each other, and so the directory can live outside the packaged resources tree
// (which the workflow's artifact upload cannot see).
const evidenceDir = process.env.APEX_NATIVE_MONITORING_EVIDENCE_DIR
  ? path.resolve(process.env.APEX_NATIVE_MONITORING_EVIDENCE_DIR)
  : path.join(root, 'build', 'native-monitoring-evidence');
mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, 'packaged-windows-native-monitoring.json');

if (process.platform !== 'win32') {
  writeFileSync(evidenceFile, JSON.stringify({
    status: 'NOT_VERIFIED',
    reason: 'Requires Windows and the actual packaged executable with the real native VST3 helper process.',
    platform: process.platform,
    physicalHardware: 'NOT_VERIFIED',
  }, null, 2));
  console.error('NOT_VERIFIED: the packaged Windows native VST3 + live-input coexistence acceptance cannot run on this host.');
  process.exit(3);
}

const packageDir = path.join(root, 'dist-electron', 'win-unpacked');
const executableName = readdirSync(packageDir).find(file => /apex.*\.exe$/i.test(file));
assert.ok(executableName, 'Packaged Apex executable missing. Run npm run package:win:dir first.');
const executable = path.join(packageDir, executableName);
assert.ok(existsSync(executable), `Packaged executable not found: ${executable}`);

// Real native plugins. The packaged Mixer smoke proves these two are discoverable
// and process audio through the helper, so they are the fixtures used here too.
const mdaFixture = path.join(root, 'build/native-vst3/VST3/Release/mda-vst3.vst3');
assert.ok(existsSync(mdaFixture), 'Build the real MDA VST3 fixture first: npm run native:vst3:build');
const PREFERRED_PLUGINS = ['mda RezFilter', 'mda Delay'];

/**
 * Native helper processes, read from the Windows process table rather than from
 * the application's own claims. Mirrors the query in
 * scripts/packaged-editor-acceptance.mjs; duplicated deliberately so this
 * acceptance cannot be broken by an edit to that unrelated 1500-line script.
 */
function helperProcesses() {
  const attempts = [];
  const read = (cmd, args, parse) => {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      return { ok: true, processes: parse(out) };
    } catch (error) {
      attempts.push(`${cmd}: ${error.message.split('\n')[0]}`);
      return null;
    }
  };
  const fromTasklist = read('tasklist', ['/FI', 'IMAGENAME eq apex-vst3-host.exe', '/FO', 'CSV', '/NH'],
    out => out.split(/\r?\n/).map(line => line.trim())
      .filter(line => /^"apex-vst3-host\.exe"/i.test(line))
      .map(line => {
        const cells = line.split('","').map(cell => cell.replace(/^"|"$/g, ''));
        return { image: cells[0], pid: Number(cells[1]) };
      }));
  const fromCim = fromTasklist ?? read('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='apex-vst3-host.exe'\" | Select-Object ProcessId,Name | ConvertTo-Json -Compress"],
    out => {
      const parsed = out.trim() ? JSON.parse(out.trim()) : [];
      return (Array.isArray(parsed) ? parsed : [parsed]).map(entry => ({ image: entry.Name, pid: Number(entry.ProcessId) }));
    });
  const result = fromTasklist ?? fromCim;
  if (!result) return { ok: false, error: attempts, processes: [] };
  return { ok: true, source: fromTasklist ? 'tasklist' : 'powershell-cim', processes: result.processes };
}

const helperPids = () => helperProcesses().processes.map(process => process.pid).sort((a, b) => a - b);

/**
 * Records progress so a failure names the stage it died in. CI logs and artifacts
 * for this job are not always retrievable, so the evidence file itself has to say
 * how far the run got rather than leaving that to a log nobody can read.
 */
const stage = (run, name) => { run.lastStage = name; };


/** Add the native insert through the real Mixer UI, in the order a user does. */
async function addNativeInsertThroughMixerUi(page) {
  const ui = {};
  const mixerTab = page.locator('#nav-mixer');
  await mixerTab.waitFor({ state: 'visible', timeout: 30000 });
  await mixerTab.click({ timeout: 15000 });
  ui.openedMixerView = true;
  await page.waitForTimeout(400);

  const trackStrip = page.locator('#mixer-strip-1');
  await trackStrip.waitFor({ state: 'visible', timeout: 30000 });
  // Select the track through its `INS 1` label, NOT by clicking the strip
  // container. The strip's centre is the volume fader, which calls
  // stopPropagation, so a container click never reaches the strip's
  // onSelectTrack: selectedTrackId stays at its default 0 (Master) and the
  // insert is silently created on Master instead of Mixer insert 1.
  // The FX panel is rendered once, for `selectedTrack`; its header is a span of
  // the form `FX SLOTS (<SELECTED TRACK NAME>)`, so it names the track that will
  // receive the next insert.
  const fxHeader = page.locator('span').filter({ hasText: /^FX SLOTS \(/ }).first();
  const headerBefore = await fxHeader.innerText().catch(() => null);
  ui.fxSlotsHeaderBeforeSelection = headerBefore;
  const insLabel = trackStrip.getByText('INS 1', { exact: true });
  await insLabel.waitFor({ state: 'visible', timeout: 15000 });
  await insLabel.click({ timeout: 15000 });
  ui.selectedTrackStrip = '#mixer-strip-1 (INS 1 label)';
  await page.waitForTimeout(300);
  const headerAfter = await fxHeader.innerText().catch(() => null);
  ui.fxSlotsHeaderAfterSelection = headerAfter;
  // Prove the selection actually moved off Master before creating anything. The
  // FX panel is driven by selectedTrack, so its header names the track that will
  // receive the insert.
  assert.ok(headerAfter && headerAfter !== headerBefore,
    `Clicking INS 1 did not change the selected Mixer track (FX panel still reads ${JSON.stringify(headerAfter)}). `
    + 'The insert would land on the previously selected track.');

  const addEffect = page.getByTitle('Add Effect Plugin').first();
  await addEffect.waitFor({ state: 'visible', timeout: 15000 });
  await addEffect.click({ timeout: 15000 });
  ui.openedAddEffectMenu = true;

  const nativeChoice = page.getByRole('button', { name: 'Native VST3 Effect' }).first();
  await nativeChoice.waitFor({ state: 'visible', timeout: 15000 });
  await nativeChoice.click({ timeout: 15000 });
  ui.openedVst3Picker = true;

  ui.pickerStatusText = await page.locator('[aria-label="VST3 effect picker"] [role="status"]').first()
    .innerText().catch(() => '');
  const picker = page.locator('[aria-label="VST3 effect picker"]');
  await picker.waitFor({ state: 'visible', timeout: 30000 });
  const pickerStatus = () => picker.locator('[role="status"]').first().innerText().catch(() => null);
  // The picker scans on mount and only renders plugin rows once discovery
  // resolves, so wait for rows rather than for one predetermined name. textContent
  // rather than innerText: a row scrolled out of the picker's max-height list is
  // still a real, clickable row.
  const rowDeadline = Date.now() + 90000;
  let rowTexts = await picker.locator('button').allTextContents().catch(() => []);
  while (rowTexts.length <= 2 && Date.now() < rowDeadline) {
    await page.waitForTimeout(500);
    rowTexts = await picker.locator('button').allTextContents().catch(() => []);
  }
  // Choose from what the shipped picker actually lists, in a user's order of
  // preference, instead of assuming a fixed plugin is present.
  const pluginName = PREFERRED_PLUGINS.find(name => rowTexts.some(text => text.includes(name)));
  if (!pluginName) {
    // Its status line reports scan results and failures, so this is the shipped
    // explanation for an empty list.
    assert.fail(`The picker listed no preferred native Mixer plugin. `
      + `Picker status: ${JSON.stringify(await pickerStatus())}. `
      + `Picker buttons: ${JSON.stringify(rowTexts)}`);
  }
  ui.pickerPluginName = pluginName;
  const pluginButton = picker.locator('button').filter({ hasText: pluginName }).first();
  await pluginButton.waitFor({ state: 'visible', timeout: 30000 });
  ui.pickerRowLabel = await pluginButton.innerText().catch(() => '');
  const statusLocator = page.locator('[aria-label="VST3 effect picker"] [role="status"]').first();
  ui.pickerStatusBeforeChoose = await statusLocator.innerText().catch(() => '');
  await pluginButton.click({ timeout: 60000 });
  ui.chosePluginFromPicker = true;
  // `choose()` is async: it opens the plugin in the native helper to read its
  // metadata, and on failure reports the reason in the picker's status line while
  // adding nothing. Give it the time it needs, then record what it said - that
  // text is the shipped explanation for "no insert appeared".
  await page.waitForTimeout(4000);
  ui.pickerStatusAfterChoose = await statusLocator.innerText().catch(() => 'picker closed');
  return ui;
}

async function runOnce(runIndex, collector) {
  const profile = mkdtempSync(path.join(root, 'build/native-monitoring-profile-'));
  const fixture = writeLiveInputFixture();
  const env = {
    ...process.env,
    APEX_ACCEPTANCE: '1',
    APEX_ACCEPTANCE_USER_DATA: profile,
    // Real native processing timings, without the built-in smoke entry's app.exit().
    APEX_SMOKE_TIMING_ONLY: '1',
    APEX_VST3_SMOKE_PLUGIN: mdaFixture,
  };
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${fixture}`, '--autoplay-policy=no-user-gesture-required'];

  const run = { runIndex, status: 'RUNNING', executable, profile, lastStage: 'start' };
  let app;
  let page;
  const consoleErrors = [];
  const stages = {};
  try {
    stage(run, 'launch');
    app = await _electron.launch({ executablePath: executable, env, args, timeout: 180000 });
    run.version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion()).catch(() => null);
    stage(run, 'first-window');
    page = await app.firstWindow();
    page.on('dialog', dialog => dialog.accept());
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 400)); });
    page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error?.message ?? error).slice(0, 400)}`));
    stage(run, 'acceptance-surface');
    await page.waitForFunction(() => !!window.__apexAcceptance, null, { timeout: 120000 });

    // Record which microphone streams the app opened, so release is provable.
    await page.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__inputCaptureEvidence = { calls: 0, streams: [] };
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stats = window.__inputCaptureEvidence; stats.calls++;
        const stream = await original(constraints); stats.streams.push(stream);
        const clone = stream.clone.bind(stream);
        stream.clone = () => { const consumer = clone(); stats.streams.push(consumer); return consumer; };
        return stream;
      };
    });

    stage(run, 'audio-settings');
    // Audio engine at the pinned 48 kHz reference with the fake capture device.
    await page.getByRole('menuitem', { name: 'Audio', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Audio Settings…', exact: true }).click();
    await page.locator('#audio-input-device-select').selectOption('');
    await page.locator('#audio-sample-rate-select').selectOption('48000');
    await page.getByRole('button', { name: /^(Initialize with Settings|Apply Engine Settings)$/ }).click();
    await expect(page.getByTestId('audio-actual-sample-rate')).toContainText('48,000');
    await page.getByRole('button', { name: 'Close Audio Settings', exact: true }).click();

    stage(run, 'check-native-timings');
    // Confirm the renderer really is measuring native processing. Deliberately does
    // NOT call discoverEffects here: Vst3Service serializes discovery per owner
    // (`native/vst3/service.mjs`) and rejects an overlapping scan with "A VST3 scan
    // is already running". Scanning here raced the picker's own on-mount scan and
    // made the picker report that error and list nothing. The picker is the real
    // discovery path, so it owns the only pre-insert scan.
    const smoke = await page.evaluate(() => ({
      smokeTest: globalThis.desktopApp?.smokeTest === true,
      smokeTimings: globalThis.desktopApp?.smokeTimings === true,
      hasBridge: !!globalThis.desktopApp?.vst3,
    }));
    assert.ok(smoke.hasBridge, 'The packaged preload VST3 bridge is missing.');
    assert.ok(smoke.smokeTimings, 'Renderer native processing timings are not enabled in this packaged launch.');
    // smokeTest must be OFF. src/main.tsx runs the built-in native VST3 smoke
    // sequence whenever smokeTest is true, and that sequence creates its own Mixer
    // inserts on track 1, drives the transport and opens extra native sessions -
    // which is what made earlier runs of this acceptance fail intermittently with
    // transport stopped, deadline misses, extra helper processes and native
    // diagnostics for slots this script never created.
    assert.equal(smoke.smokeTest, false,
      'The packaged launch is a smoke session, so the built-in native VST3 smoke sequence '
      + 'is running concurrently and would invalidate this acceptance. Use APEX_SMOKE_TIMING_ONLY.');

    stage(run, 'helpers-before-insert');
    run.helpersBeforeInsert = helperPids();

    stage(run, 'mixer-ui-insert');
    // Real native insert on Mixer insert 1, through the real Mixer UI.
    run.mixerUi = await addNativeInsertThroughMixerUi(page);
    const pluginName = run.mixerUi.pickerPluginName;
    // The insert reaches project state through the real mutation path; wait for
    // that instead of assuming the next read already sees it.
    // Read every Mixer track, not only track 1: if the insert landed somewhere
    // else the failure must name where, not report that nothing appeared.
    const readAllVst3Slots = () => page.evaluate(() => [0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap(trackId =>
      window.__apexAcceptance.mixerInsertSlots(trackId)
        .filter(slot => slot.type === 'vst3' && slot.enabled)
        .map(slot => ({ trackId, ...slot }))));
    // Manual poll rather than expect.poll: on timeout the message has to carry the
    // picker's own status line and every track's slots, because that is the only
    // evidence available when this job's log and artifact cannot be retrieved.
    const deadline = Date.now() + 60000;
    let placed = await readAllVst3Slots();
    while (placed.length !== 1 && Date.now() < deadline) {
      await page.waitForTimeout(500);
      placed = await readAllVst3Slots();
    }
    if (placed.length !== 1) {
      const slotsByTrack = await page.evaluate(() => Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8]
        .map(trackId => [trackId, window.__apexAcceptance.mixerInsertSlots(trackId)])));
      assert.fail('The native insert created through the Mixer UI never reached project state. '
        + `Picker status after choose: ${JSON.stringify(run.mixerUi?.pickerStatusAfterChoose ?? null)}. `
        + `All Mixer FX slots: ${JSON.stringify(slotsByTrack)}`);
    }
    assert.equal(placed[0].trackId, 1,
      `The Mixer UI placed the native insert on track ${placed[0].trackId}, not Mixer insert 1. `
      + `Picker status after choose: ${JSON.stringify(run.mixerUi?.pickerStatusAfterChoose ?? null)}`);
    const nativeSlots = placed;
    const slotId = nativeSlots[0].id;
    run.slotId = slotId;
    run.insertSlotsOnTrack1 = await page.evaluate(() => window.__apexAcceptance.mixerInsertSlots(1));
    // Identity is read now that the picker is closed and no scan can overlap.
    stage(run, 'plugin-identity');
    // Vst3Service serializes discovery per owner, so an application-initiated scan
    // makes this read fail with "A VST3 scan is already running". That is a
    // documented transient of the discovery API, not a product failure and not an
    // assertion about the scenario, so wait it out - bounded, only for that exact
    // error, and the wait is recorded. Anything else fails immediately.
    const identityStartedAt = Date.now();
    let identityAttempts = 0;
    for (;;) {
      identityAttempts++;
      try {
        // discoverEffects only. inspectEffect opens a real native session to read
        // parameter metadata, and that session lingers long enough to be counted in
        // the baseline's live session gauge - which is what made the session-count
        // comparison measure this harness instead of monitoring. Name, class ID and
        // path are what the evidence needs and discovery alone provides them.
        run.plugin = await page.evaluate(async name => {
          const bridge = globalThis.desktopApp.vst3;
          const target = (await bridge.discoverEffects()).plugins.find(plugin => plugin.name === name);
          return target
            ? { name: target.name, classId: target.classId, path: target.path }
            : { name, error: 'chosen plugin absent from a post-insert discovery' };
        }, pluginName);
        break;
      } catch (error) {
        const message = String(error?.message ?? error);
        if (!message.includes('A VST3 scan is already running') || Date.now() - identityStartedAt > 60000) throw error;
        await page.waitForTimeout(1000);
      }
    }
    run.pluginIdentityRead = { attempts: identityAttempts, waitedMs: Date.now() - identityStartedAt };

    stage(run, 'transport-play');
    // Start the transport through the real Play control. Production code prepares
    // the native session here - the plugin is NOT prepared after monitoring starts.
    // `#fl-play-btn` is the shipped transport control; its aria-label flips to
    // "Pause" while playing, which is the real playing indicator.
    const playButton = page.locator('#fl-play-btn');
    await playButton.waitFor({ state: 'visible', timeout: 30000 });
    await playButton.click({ timeout: 30000 });
    await expect(playButton).toHaveAttribute('aria-label', 'Pause', { timeout: 60000 });

    stage(run, 'arm-probe');
    await page.evaluate(([track, slot]) => window.__apexAcceptance
      .armNativeMonitoringCoexistenceProbe(track, slot, { inputSignal: true }), [1, slotId]);
    // MANDATORY PRECONDITION. Preparing the native session is asynchronous: starting
    // the transport opens the plugin in the helper process, and a fixed delay is not
    // enough under CI load. Wait for the insert to be prepared AND for its
    // processed-block count to advance between two samples - that is what "already
    // prepared and actively processing" means - and require that this was actually
    // achieved before monitoring is enabled.
    const warmupTimeoutMs = 60000;
    const warmupStartedAt = Date.now();
    let warmup = await page.evaluate(() => window.__apexAcceptance
      .measureNativeMonitoringCoexistence('warmup'));
    let priorBlocks = warmup.native.processedBlocks;
    await page.waitForTimeout(500);
    warmup = await page.evaluate(() => window.__apexAcceptance
      .measureNativeMonitoringCoexistence('warmup'));
    // Gate only on conditions that are directly observable: the insert is prepared
    // and its processed block count is advancing.
    const warmupSucceeded = () => warmup.native.prepared
      && warmup.native.processedBlocks > priorBlocks;
    while (Date.now() - warmupStartedAt < warmupTimeoutMs && !warmupSucceeded()) {
      priorBlocks = warmup.native.processedBlocks;
      await page.waitForTimeout(500);
      warmup = await page.evaluate(() => window.__apexAcceptance
        .measureNativeMonitoringCoexistence('warmup'));
    }
    // The loop above can expire without the precondition ever having been met, so
    // record whether it was and require it explicitly. A timeout is a failure here,
    // at the warmup, with the diagnostics attached - not something to discover
    // later as a confusing baseline mismatch. Monitoring is never enabled on an
    // insert that was not proven prepared and processing.
    const warmupOk = warmupSucceeded();
    // Recorded here as well as after monitoring: a run that fails AT the warmup
    // never reaches the later capture, and that is precisely the run whose block
    // decomposition is needed. The after-monitoring capture overwrites this one
    // when the run gets that far, because it sees more blocks.
    run.coldStart = coldStartFrom(warmup.native, 'warmup');
    run.warmup = { succeeded: warmupOk, waitedMs: Date.now() - warmupStartedAt,
      timeoutMs: warmupTimeoutMs, prepared: warmup.native.prepared,
      processedBlocks: warmup.native.processedBlocks, priorBlocks,
      runtimeIds: warmup.native.runtimeIds, deadlineMisses: warmup.native.deadlineMisses,
      nativeFailures: warmup.native.failures,
      nativeServiceSessionCount: warmup.native.nativeServiceSessionCount };
    assert.equal(warmupOk, true,
      'Warmup timed out: the native insert was never proven prepared and actively '
      + `processing before monitoring would have been enabled. `
      + `waitedMs=${run.warmup.waitedMs} of ${warmupTimeoutMs} `
      + `prepared=${warmup.native.prepared} `
      + `processedBlocks=${warmup.native.processedBlocks} priorBlocks=${priorBlocks} `
      + `runtimeIds=${JSON.stringify(warmup.native.runtimeIds)} `
      + `deadlineMisses=${warmup.native.deadlineMisses} `
      + `nativeFailures=${warmup.native.failures} `
      + `failureMessages=${JSON.stringify(warmup.native.failureMessages)} `
      + `nativeDiagnostics=${JSON.stringify(warmup.diagnostics)} `
      + `blockBudgetMs=${warmup.native.blockBudgetMs} `
      + `mainEventLoopLagMaxMs=${warmup.native.mainEventLoopLagMaxMs} `
      + `helperStartup=${JSON.stringify(warmup.native.helperStartup)} `
      + `coldStartBlocks=${JSON.stringify(warmup.native.coldStartBlocks)} `
      + `rendererConsoleErrors=${JSON.stringify(consoleErrors.slice(0, 8))}`);

    stages.beforeMonitoring = await page.evaluate(label => window.__apexAcceptance
      .measureNativeMonitoringCoexistence(label), 'beforeMonitoring');
    run.helpersBeforeMonitoring = helperPids();

    stage(run, 'enable-monitoring');
    // THE TRANSITION UNDER TEST: monitoring on the SAME insert, during playback.
    const rebuildsBefore = stages.beforeMonitoring.mixerTracksRebuiltSinceArm.length;
    await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
    await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click({ timeout: 30000 });
    await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active', { timeout: 60000 });
    await page.waitForTimeout(1500);

    stages.duringMonitoring = await page.evaluate(label => window.__apexAcceptance
      .measureNativeMonitoringCoexistence(label), 'duringMonitoring');
    run.helpersDuringMonitoring = helperPids();
    run.monitorStatusDuring = await page.evaluate(() => window.__apexAcceptance.liveInputState());

    stage(run, 'disable-monitoring');
    // Disable monitoring through the real Mixer button.
    await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
    await page.getByRole('button', { name: 'Disable monitoring' }).click({ timeout: 30000 });
    await expect.poll(async () => (await page.evaluate(() => window.__apexAcceptance.liveInputState())).status,
      { timeout: 60000 }).toBe('off');
    await page.waitForTimeout(1500);

    stages.afterMonitoring = await page.evaluate(label => window.__apexAcceptance
      .measureNativeMonitoringCoexistence(label), 'afterMonitoring');
    // Cold-start forensics, captured BEFORE the assertions so a failing run still
    // carries the evidence that explains it. `coldStartBlocks` is always the first
    // blocks of the session, so reading it here does not lose the cold window.
    run.coldStart = coldStartFrom(stages.afterMonitoring.native, 'afterMonitoring');
    run.helpersAfterMonitoring = helperPids();
    run.monitorStatusAfter = await page.evaluate(() => window.__apexAcceptance.liveInputState());

    run.resources = await page.evaluate(() => ({
      calls: window.__inputCaptureEvidence.calls,
      tracks: window.__inputCaptureEvidence.streams.flatMap(stream => stream.getTracks().map(track => track.readyState)),
    }));

    await page.evaluate(() => window.__apexAcceptance.disarmNativeMonitoringCoexistenceProbe());
    run.stages = stages;
    run.rebuildsAttributableToMonitoring = stages.duringMonitoring.mixerTracksRebuiltSinceArm.slice(rebuildsBefore);

    stage(run, 'assertions');
    // ---- assertions: any one of these failing is a FAIL, never retried away ----
    // The evidence has to name the real plugin fixture, so a missing identity is a
    // failure rather than a gap in the report.
    assert.ok(run.plugin?.classId && run.plugin?.path,
      `Native plugin fixture identity is incomplete: ${JSON.stringify(run.plugin ?? null)}`);
    const before = stages.beforeMonitoring;
    const during = stages.duringMonitoring;
    const after = stages.afterMonitoring;

    // The insert must ALREADY be a live, prepared native session before monitoring.
    // This has failed intermittently, so the message carries everything that
    // explains a preparation that did not happen: how long the warmup waited,
    // whether any block was ever processed, the production native Mixer
    // diagnostics, and the renderer's own console errors.
    const preparationContext = () => `waitedMs=${run.warmup?.waitedMs} `
      + `processedBlocks=${before.native.processedBlocks} `
      + `runtimeIds=${JSON.stringify(before.native.runtimeIds)} `
      + `deadlineMisses=${before.native.deadlineMisses} `
      + `nativeFailures=${before.native.failures} `
      + `failureMessages=${JSON.stringify(before.native.failureMessages)} `
      + `transportPlaying=${before.transport.playing} positionSeconds=${before.transport.positionSeconds} `
      + `nativeDiagnostics=${JSON.stringify(before.diagnostics)} `
      + `rendererConsoleErrors=${JSON.stringify(consoleErrors.slice(0, 8))}`;
    assert.equal(before.native.prepared, true,
      `Native insert was not prepared before monitoring started. ${preparationContext()}`);
    assert.equal(before.native.nodePresent, true,
      `No native processing node existed before monitoring started. ${preparationContext()}`);
    assert.ok(before.native.processedBlocks > 0,
      `Native plugin processed no audio before monitoring: ${JSON.stringify(before.native)}`);
    assert.ok((before.native.nativeOutputRmsMean ?? 0) > 0.001,
      `Native plugin output was silent before monitoring: ${JSON.stringify(before.native)}`);
    assert.equal(before.transport.playing, true, 'Transport was not playing before monitoring started.');

    // Transport uninterrupted across the transition.
    for (const stage of [before, during, after]) {
      assert.equal(stage.transport.playing, true, `Transport stopped at ${stage.label}.`);
    }
    assert.ok(during.transport.positionSeconds > before.transport.positionSeconds,
      `Transport position did not advance into monitoring: ${before.transport.positionSeconds} -> ${during.transport.positionSeconds}`);
    assert.ok(after.transport.positionSeconds > during.transport.positionSeconds,
      `Transport position did not advance after monitoring: ${during.transport.positionSeconds} -> ${after.transport.positionSeconds}`);

    // The SAME native session and the SAME processing node survived.
    assert.deepEqual(during.native.runtimeIds, before.native.runtimeIds,
      'Native session identity changed when monitoring was enabled (session was re-prepared).');
    assert.deepEqual(after.native.runtimeIds, before.native.runtimeIds,
      'Native session identity changed when monitoring was disabled.');
    assert.equal(before.native.runtimeIds.length, 1,
      `Expected exactly one native session identity, saw ${JSON.stringify(before.native.runtimeIds)}`);
    assert.equal(during.native.nodeId, before.native.nodeId,
      'Native processing node was replaced when monitoring was enabled.');
    assert.equal(after.native.nodeId, before.native.nodeId,
      'Native processing node was replaced when monitoring was disabled.');
    assert.equal(after.native.prepared, true, 'Native insert is no longer prepared after monitoring was disabled.');

    // Native processing continued through and after the transition.
    const blocksDuring = during.native.processedBlocks - before.native.processedBlocks;
    const blocksAfter = after.native.processedBlocks - during.native.processedBlocks;
    run.nativeProcessing = { blocksBefore: before.native.processedBlocks, blocksDuringMonitoring: blocksDuring,
      blocksAfterMonitoringDisabled: blocksAfter,
      workletSubmissionsDelta: during.native.workletSubmissions - before.native.workletSubmissions };
    assert.ok(blocksDuring > 0,
      `Native plugin stopped processing while monitoring was enabled: ${JSON.stringify(run.nativeProcessing)}`);
    assert.ok(blocksAfter > 0,
      `Native plugin did not resume/continue after monitoring was disabled: ${JSON.stringify(run.nativeProcessing)}`);
    assert.ok((during.native.nativeOutputRmsMean ?? 0) > 0.001,
      `Native plugin output was silent during monitoring: ${JSON.stringify(during.native)}`);
    assert.ok((after.native.nativeOutputRmsMean ?? 0) > 0.001,
      `Native plugin output was silent after monitoring: ${JSON.stringify(after.native)}`);

    // No deadline missed, no failed native block, no helper churn.
    const deadlineMisses = after.native.deadlineMisses - before.native.deadlineMisses;
    const failures = after.native.failures - before.native.failures;
    assert.equal(deadlineMisses, 0, `Native processing missed ${deadlineMisses} real-time deadline(s).`);
    assert.equal(failures, 0, `Native processing failed ${failures} block(s): ${JSON.stringify(after.native.failureMessages)}`);
    // nativeServiceSessionCount is NOT used as an equality invariant, and the three
    // readings are recorded instead. Across runs on byte-identical code it measured
    // 3, 2, 1 and 0 for the same healthy scenario, because it is a live gauge of
    // open + pending + closing sessions (native/vst3/service.mjs:41) that also
    // counts this harness's and the shipped picker's short-lived inspectEffect
    // sessions. Requiring it to be unchanged - or to equal one - made the verdict
    // depend on when unrelated inspect sessions happened to close.
    // What monitoring must not do is leave sessions behind, which is directional and
    // unaffected by that noise. The insert's own liveness is asserted separately and
    // soundly above: prepared === true, a processing node present, blocks advancing,
    // one unchanged runtime id and one unchanged node id.
    assert.ok(after.native.nativeServiceSessionCount <= before.native.nativeServiceSessionCount,
      'Native helper sessions leaked across the monitoring cycle. '
      + `before=${before.native.nativeServiceSessionCount} during=${during.native.nativeServiceSessionCount} `
      + `afterDisable=${after.native.nativeServiceSessionCount}.`);
    run.nativeServiceSessionCounts = { before: before.native.nativeServiceSessionCount,
      during: during.native.nativeServiceSessionCount, afterDisable: after.native.nativeServiceSessionCount };
    // The helper PID list is not compared for exact equality, for the same reason
    // the session gauge is not: discovery scans and inspectEffect each spawn a
    // short-lived apex-vst3-host.exe, so the baseline legitimately holds helpers
    // that exit on their own (observed [2428, 3880, 8580] before monitoring and
    // [3880] during, with the insert's own helper 3880 present throughout).
    // What a crash or restart would actually produce is a helper PID that was not
    // there before, and a dead helper would stop the insert processing - which the
    // identity and processed-block assertions above already catch. So the sound
    // invariants are: no new helper appears, and at least one is still alive.
    const unexpectedHelpers = pids => pids.filter(pid => !run.helpersBeforeMonitoring.includes(pid));
    assert.deepEqual(unexpectedHelpers(run.helpersDuringMonitoring), [],
      `A native helper process appeared while monitoring was enabled (crash or restart): `
      + `before=${JSON.stringify(run.helpersBeforeMonitoring)} during=${JSON.stringify(run.helpersDuringMonitoring)}.`);
    assert.deepEqual(unexpectedHelpers(run.helpersAfterMonitoring), [],
      `A native helper process appeared after monitoring was disabled (crash or restart): `
      + `before=${JSON.stringify(run.helpersBeforeMonitoring)} after=${JSON.stringify(run.helpersAfterMonitoring)}.`);
    assert.ok(run.helpersBeforeMonitoring.length > 0, 'No native helper process was running during the scenario.');
    assert.ok(run.helpersDuringMonitoring.length > 0,
      'No native helper process was alive while monitoring was enabled.');
    assert.ok(run.helpersAfterMonitoring.length > 0,
      'No native helper process was alive after monitoring was disabled.');

    // No already-live Mixer graph was rebuilt by monitoring initialization.
    assert.deepEqual(run.rebuildsAttributableToMonitoring, [],
      `Monitoring initialization rebuilt already-live Mixer tracks [${run.rebuildsAttributableToMonitoring.join(', ')}].`);

    // Monitoring really was active, and its PCM really was present then removed.
    assert.equal(run.monitorStatusDuring.status, 'active', 'Monitoring was not active during the scenario.');
    assert.equal(run.monitorStatusAfter.status, 'off', 'Monitoring was not disabled cleanly.');
    const inputDuring = during.pcm.insertInputRms;
    const inputAfter = after.pcm.insertInputRms;
    assert.ok(inputDuring > inputAfter * 1.03,
      `Monitored input was not measurably present on the insert input during monitoring: during=${inputDuring} after=${inputAfter}`);
    assert.ok(inputAfter > 0.01,
      `Deterministic insert signal disappeared after monitoring was disabled: ${JSON.stringify(after.pcm)}`);

    // Microphone resources released.
    assert.equal(run.resources.calls, 1, `Expected exactly one getUserMedia call, saw ${run.resources.calls}`);
    assert.ok(run.resources.tracks.length > 0, 'No microphone tracks were recorded.');
    assert.ok(run.resources.tracks.every(state => state === 'ended'),
      `Microphone tracks were not all released: ${JSON.stringify(run.resources.tracks)}`);

    stage(run, 'complete');
    run.diagnosticsAtEnd = after.diagnostics;
    run.status = 'PASS';
    return run;
  } catch (error) {
    run.status = 'FAIL';
    run.error = `${error?.message ?? error}`.split('\n').slice(0, 12).join(' | ');
    run.stages = stages;
    // Capture what the app was actually showing. This is the only failure detail
    // that survives when the CI log and the evidence artifact cannot be fetched.
    try {
      run.failureContext = { rendererConsoleErrors: consoleErrors.slice(0, 25) };
      if (page) {
        const shot = path.join(evidenceDir, `failure-run${runIndex}.png`);
        await page.screenshot({ path: shot, timeout: 20000 }).catch(() => {});
        if (existsSync(shot)) run.failureContext.screenshot = shot;
        run.failureContext.url = page.url();
        run.failureContext.acceptanceAvailable = await page
          .evaluate(() => typeof window.__apexAcceptance === 'object').catch(() => null);
        run.failureContext.monitorStatus = await page
          .evaluate(() => window.__apexAcceptance?.liveInputState?.() ?? null).catch(() => null);
      }
    } catch { /* failure context is best-effort; the assertion message is authoritative */ }

    // Take one more measurement before the application closes; see the module for
    // why the warm-up snapshot alone is not enough. It never throws and never
    // replaces the acceptance error above, which stays authoritative.
    Object.assign(run, await captureFailureEvidence({ page, coldStartFrom, helperPids }));
    throw error;
  } finally {
    if (app) {
      try { await app.close({ timeout: 60000 }); run.appClosedCleanly = true; }
      catch (error) { run.appClosedCleanly = false; run.closeError = `${error?.message ?? error}`.split('\n')[0]; }
    }
    // The helper is owned by the application and must not outlive it. Poll rather
    // than sleep a fixed interval, so a slow exit is not reported as a leak while
    // a genuine leak is still reported once the grace period expires.
    let helpers = helperPids();
    for (let attempt = 0; attempt < 10 && helpers.length > 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      helpers = helperPids();
    }
    run.helpersAfterShutdown = helpers;
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile retained for inspection */ }
    collector.push(run);
  }
}

const evidence = {
  status: 'RUNNING',
  requestedRuns: runs,
  source: 'Real packaged Windows application + real native VST3 helper process + real MDA plugin; Chromium fake microphone',
  physicalHardware: 'NOT_VERIFIED',
  microphone: 'Chromium --use-file-for-fake-audio-capture fixture, NOT a physical microphone',
  insertAudioSource: 'Deterministic buffer at the insert input (same mechanism as the packaged Mixer acceptance), NOT a physical instrument',
  host: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
  runs: [],
};

/**
 * Every run, including a failing one, with its full stage detail. Populated from
 * `runOnce`'s finally block so a failure cannot lose the measurements that
 * explain it.
 */
const allRuns = [];

// Diagnostic mode, and ONLY the dedicated CI diagnostic step, sets this. It changes
// one thing: a failed repetition no longer ends the run, so all requested
// repetitions are attempted and every one is recorded PASS or FAIL. It does not
// retry anything - the next index is a fresh application, a fresh profile and a
// genuinely cold helper, never a rerun of the repetition that failed. The overall
// result is still FAIL if any repetition failed, and the five-repetition production
// acceptance keeps its fail-fast meaning because it does not set this.
const continueAfterFailure = process.env.APEX_NATIVE_MONITORING_CONTINUE_AFTER_FAILURE === '1';
const loopResult = await runRepetitions({
  runs,
  runOnce: index => runOnce(index, allRuns),
  continueAfterFailure,
  logStart: (index, total, continuing) => console.log(`[native-monitoring] run ${index}/${total}`
    + (continuing ? ' (diagnostic mode: a failure does not end the run)' : '')),
  logPass: message => console.log(message),
  logError: message => console.error(`[native-monitoring] ${message}`),
  describePass: run => `run ${run.runIndex} PASS: session=${JSON.stringify(run.stages.beforeMonitoring.native.runtimeIds)} `
    + `node=${run.stages.beforeMonitoring.native.nodeId} blocks=${run.nativeProcessing.blocksBefore}`
    + `/+${run.nativeProcessing.blocksDuringMonitoring}/+${run.nativeProcessing.blocksAfterMonitoringDisabled}`,
  describeFail: error => `run FAIL: ${String(error?.message ?? error).split('\n')[0]}`,
});
const exitCode = loopResult.exitCode;
evidence.runs = allRuns;

const passed = allRuns.filter(run => run.status === 'PASS').length;
evidence.status = exitCode === 0 && passed === runs ? 'PASS' : 'FAIL';
evidence.mode = continueAfterFailure ? 'diagnostic' : 'acceptance';
evidence.summary = { requestedRuns: runs, completedRuns: allRuns.length, passedRuns: passed,
  failedRuns: allRuns.length - passed,
  attemptedRuns: loopResult.attempted,
  mode: evidence.mode,
  // Every attempt and its outcome, so a diagnostic run cannot be read as "the last
  // one passed". A repetition that failed stays failed even if later ones pass.
  outcomes: allRuns.map(run => ({ run: run.runIndex, status: run.status,
    lastStage: run.lastStage ?? null })),
  // Every block sequence the real-time guard gave up on, across all repetitions.
  missedSequences: [...new Set(allRuns.flatMap(run => [
    ...(run.coldStartAtFailure?.missedSequences ?? []),
    ...(run.coldStart?.missedSequences ?? []),
  ]))].sort((a, b) => a - b),
  // Helper identity per repetition, proving each attempt really was cold.
  helperPids: allRuns.map(run => ({ run: run.runIndex,
    pid: Object.values((run.coldStartAtFailure ?? run.coldStart)?.helperStartup ?? {})[0]?.pid ?? null,
    leakedAfterShutdown: run.helpersAfterShutdown ?? [],
    aliveAtFailure: run.helpersAtFailure ?? null })),
  // Any run whose helper outlived the application is a resource-release failure.
  helperProcessesLeakedAfterShutdown: allRuns.flatMap(run => run.helpersAfterShutdown ?? []),
  // A clean application shutdown is part of the acceptance, not an assumption.
  appShutdownFailures: allRuns.filter(run => run.appClosedCleanly === false).map(run => run.runIndex) };
if (evidence.summary.helperProcessesLeakedAfterShutdown.length > 0) evidence.status = 'FAIL';
if (evidence.summary.appShutdownFailures.length > 0) evidence.status = 'FAIL';

writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
console.log(`[native-monitoring] ${evidence.status}: ${passed}/${runs} runs passed -> ${evidenceFile}`);
// A GitHub step summary is written even on failure, because this job's logs and
// artifacts redirect to blob storage that is not always reachable - the summary is
// the one failure detail that is reliably visible on the run page.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const summaryLines = [
  `## Packaged native VST3 + live-input coexistence: ${evidence.status}`,
  '',
  `- requested runs: ${runs}, completed: ${allRuns.length}, passed: ${passed}`,
  `- microphone: Chromium fake capture fixture (NOT physical hardware)`,
  `- insert audio source: deterministic buffer at the insert input (NOT a physical instrument)`,
];
for (const run of allRuns) {
  const before = run.stages?.beforeMonitoring;
  summaryLines.push('', `### Run ${run.runIndex} — ${run.status} (last stage: ${run.lastStage ?? 'unknown'})`);
  if (run.error) summaryLines.push('', '```', String(run.error).slice(0, 2000), '```');
  if (before?.native) {
    summaryLines.push('', `- native session identity: \`${JSON.stringify(before.native.runtimeIds)}\``,
      `- native node id: \`${before.native.nodeId}\``,
      `- native blocks before/during/after: ${run.nativeProcessing?.blocksBefore} / +${run.nativeProcessing?.blocksDuringMonitoring} / +${run.nativeProcessing?.blocksAfterMonitoringDisabled}`,
      `- transport position s: ${before.transport.positionSeconds} -> ${run.stages.duringMonitoring?.transport?.positionSeconds} -> ${run.stages.afterMonitoring?.transport?.positionSeconds}`,
      `- mixer tracks rebuilt by monitoring init: \`${JSON.stringify(run.rebuildsAttributableToMonitoring)}\``,
      `- deadline misses: ${run.stages.afterMonitoring?.native?.deadlineMisses}, native failures: ${run.stages.afterMonitoring?.native?.failures}`);
  }
  if (run.coldStart) {
    summaryLines.push(`- cold start: budget ${run.coldStart.blockBudgetMs} ms, worst round trip ${run.coldStart.worstTotalRoundTripMs} ms, worst margin ${run.coldStart.worstMarginMs} ms, main event-loop lag max ${run.coldStart.mainEventLoopLagMaxMs} ms`,
      `- helper start-up: \`${JSON.stringify(run.coldStart.helperStartup)}\``);
    summaryLines.push('', '<details><summary>cold-start block decomposition</summary>', '', '```',
      JSON.stringify(run.coldStart.blocks, null, 1).slice(0, 6000), '```', '', '</details>');
  }
  summaryLines.push(`- helper PIDs before/during/after/after-shutdown: ${JSON.stringify(run.helpersBeforeMonitoring ?? [])} / ${JSON.stringify(run.helpersDuringMonitoring ?? [])} / ${JSON.stringify(run.helpersAfterMonitoring ?? [])} / ${JSON.stringify(run.helpersAfterShutdown ?? [])}`);
  if (run.failureContext?.rendererConsoleErrors?.length) {
    summaryLines.push('', '<details><summary>renderer console errors</summary>', '', '```',
      run.failureContext.rendererConsoleErrors.join('\n').slice(0, 3000), '```', '', '</details>');
  }
}
if (summaryPath) {
  try { appendFileSync(summaryPath, `${summaryLines.join('\n')}\n`); } catch { /* summary is best-effort */ }
}

if (process.env.GITHUB_ACTIONS) {
  // Null-safe by construction: a run that failed before producing stages must
  // still report. Guarding on `first.stages` alone is not enough because an empty
  // object is truthy, and that crash previously suppressed the error annotation.
  const first = allRuns[0];
  const before = first?.stages?.beforeMonitoring;
  if (before?.native) {
    console.log(`::notice title=Packaged native VST3 + live input coexistence::${JSON.stringify({
      status: evidence.status, passedRuns: passed, requestedRuns: runs,
      plugin: first.plugin, slotId: first.slotId,
      nativeRuntimeIds: before.native.runtimeIds,
      nativeNodeId: before.native.nodeId,
      nativeProcessing: first.nativeProcessing,
      transportPositionSeconds: {
        before: before.transport.positionSeconds,
        during: first.stages.duringMonitoring?.transport?.positionSeconds ?? null,
        after: first.stages.afterMonitoring?.transport?.positionSeconds ?? null,
      },
      mixerTracksRebuiltByMonitoring: first.rebuildsAttributableToMonitoring,
      deadlineMisses: first.stages.afterMonitoring?.native?.deadlineMisses ?? null,
      nativeFailures: first.stages.afterMonitoring?.native?.failures ?? null,
      helperProcessesLeakedAfterShutdown: evidence.summary.helperProcessesLeakedAfterShutdown,
      physicalHardware: 'NOT_VERIFIED',
    })}`);
  }
  // Cold-start decomposition, one annotation per repetition. This job's log and
  // artifact redirect outside the retrievable host, so annotations are the only
  // channel that carries the timing evidence out of CI. Each line splits one
  // block's round trip into renderer->main, the helper channel and main->renderer,
  // against the one-block budget the fail-closed guard actually enforces.
  // GitHub both truncates an annotation at 4096 characters and caps how many a
  // check run keeps - a 15-repetition pass emitted 30 per-run annotations and the
  // later ones were dropped. So: ONE aggregate annotation covering every
  // repetition, and full per-block detail only where it is needed - every failing
  // repetition, plus repetition 1 as a representative cold sample.
  const r2 = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : value ?? null);
  // Annotation size handling lives in its own module so it can be tested: GitHub
  // truncates at 4096 characters mid-JSON, which is what lost the failing run's
  // per-block decomposition twice. `blocksAroundMiss` is preserved longest because
  // it is the window the real-time guard actually gave up on.
  const emit = (title, payload) => console.log(
    buildCiAnnotation(title, payload, { cap: 3900, preserve: 'blocksAroundMiss' }).text);
  const label = process.env.APEX_NATIVE_MONITORING_LABEL ?? 'acceptance';
  const startupOf = cold => Object.values(cold?.helperStartup ?? {})[0] ?? null;
  const detailed = allRuns.filter(run => run.coldStart && (run.status !== 'PASS' || run.runIndex === 1));
  const aggregate = allRuns.filter(run => run.coldStart).map(run => {
    const startup = startupOf(run.coldStart);
    return { r: run.runIndex, st: run.status, worst: r2(run.coldStart.worstTotalRoundTripMs),
      margin: r2(run.coldStart.worstMarginMs), lagAudio: r2(run.coldStart.mainEventLoopLagDuringAudioMs),
      lagMax: r2(run.coldStart.mainEventLoopLagMaxMs), load: r2(startup?.firstRequestRoundTripMs) };
  });
  // Honest classification of every helper-thread CPU reading, so a zero can never
  // be read as "no CPU used". The three states and their limits are defined in the
  // shared module, where they are unit-tested.
  const cpuObservation = summarizeCpuObservations(
    allRuns.filter(run => run.coldStart).flatMap(run => run.coldStart.blocks ?? []),
    { runsCounted: allRuns.filter(run => run.coldStart).length });
  emit(`[${label}] Cold-start aggregate (${aggregate.length} cold repetitions)`, {
    label, repetitions: aggregate.length,
    cpuObservation,
    passed: aggregate.filter(row => row.st === 'PASS').length,
    failed: aggregate.filter(row => row.st !== 'PASS').length,
    tightestMarginMs: aggregate.reduce((worst, row) => (
      row.margin !== null && (worst === null || row.margin < worst) ? row.margin : worst), null),
    slowestBlockMs: aggregate.reduce((worst, row) => (
      row.worst !== null && (worst === null || row.worst > worst) ? row.worst : worst), null),
    blockBudgetMs: r2(allRuns.find(run => run.coldStart)?.coldStart?.blockBudgetMs),
    runs: aggregate,
  });
  // Block keys, and what each means:
  //   inst = whole Instance::process() in the helper
  //   prep / cb / coll = host preparation, the processor->process(data) callback,
  //     and host output collection. These three PARTITION inst - never add them to
  //     it. The key this replaces was `plugin`, which reported inst under a name
  //     that read as plug-in time; it was host-plus-plug-in.
  const fmtBlock = block => ({
    seq: block.sequence, rToMain: r2(block.rendererToMainMs), svc: r2(block.nativeServiceCallMs),
    qWait: r2(block.helperQueueWaitMs), ser: r2(block.helperSerializeMs),
    hRtt: r2(block.helperRoundTripMs), parse: r2(block.helperFrameParseMs),
    pipe: r2(block.helperPipeAndScheduleMs), decode: r2(block.helperDecodeMs),
    inst: r2(block.helperInstanceProcessMs), prep: r2(block.helperHostPrepareMs),
    cb: r2(block.helperPluginCallbackMs), coll: r2(block.helperHostCollectMs),
    // Helper-thread CPU time for the same spans: wall minus CPU is descheduling,
    // not expensive code. acc = the AudioWorklet genuinely accepted this block;
    // a false or null acc means no margin below may be read as a pass.
    instCpu: r2(block.helperInstanceProcessCpuMs), prepCpu: r2(block.helperHostPrepareCpuMs),
    cbCpu: r2(block.helperPluginCallbackCpuMs), collCpu: r2(block.helperHostCollectCpuMs),
    cpuOk: block.helperCpuTimingSupported ?? null,
    // tick: did the per-thread CPU clock ADVANCE during this block? false with
    // cpuOk true means the span was below one clock step, not that no CPU was used.
    // step: the smallest advance measured at helper startup, carried so a zero can
    // be read as below-resolution. It is not the clock's exact resolution.
    tick: block.helperCpuClockTickObserved ?? null, step: r2(block.helperCpuClockObservedStepMs),
    acc: block.resultAccepted ?? null, rej: block.resultRejectionReasons ?? [],
    gen: block.runtimeGeneration ?? null,
    flush: block.helperProcessIsFlush ?? null,
    mainToR: r2(block.mainToRendererMs), total: r2(block.totalRoundTripMs),
    margin: r2(block.marginMs), lagInBlock: r2(block.eventLoopLagDuringBlockMs), err: block.error,
  });
  for (const run of detailed) {
    // The failure-time capture sees the blocks around a mid-session miss, which the
    // warm-up snapshot cannot. Prefer it, but keep reporting which one was used, and
    // fall back to the warm-up snapshot when the capture was unavailable.
    const cold = run.coldStartAtFailure ?? run.coldStart;
    const warmupKept = Boolean(run.coldStartAtFailure) && run.coldStart?.capturedAt === 'warmup';
    const startup = startupOf(cold);
    emit(`[${label}] Cold-start detail run ${run.runIndex} (${run.status}, ${cold.capturedAt ?? 'unknown'})`, {
      runIndex: run.runIndex, status: run.status, capturedAt: cold.capturedAt ?? null,
      warmupSnapshotRetained: warmupKept ? { capturedAt: run.coldStart.capturedAt,
        worstMarginMs: r2(run.coldStart.worstMarginMs) } : null,
      failureCaptureError: run.failureCaptureError ?? null,
      failureCaptureSkipped: run.failureCaptureSkipped ?? null,
      blockBudgetMs: r2(cold.blockBudgetMs),
      worstTotalRoundTripMs: r2(cold.worstTotalRoundTripMs), worstMarginMs: r2(cold.worstMarginMs),
      mainEventLoopLagMaxMs: r2(cold.mainEventLoopLagMaxMs),
      mainEventLoopLagDuringAudioMs: r2(cold.mainEventLoopLagDuringAudioMs),
      mainEventLoopWorstStalls: (cold.mainEventLoopWorstStalls ?? []).slice(0, 6)
        .map(stall => ({ atMs: r2(stall.atMs), lagMs: r2(stall.lagMs) })),
      helperPid: startup?.pid ?? null,
      helperSpawnToProtocolBoundMs: r2(startup?.spawnToProtocolBoundMs),
      helperFirstRequestRoundTripMs: r2(startup?.firstRequestRoundTripMs),
      helperConstructedToOpenCompletedMs: r2(startup?.constructedToOpenCompletedMs),
      deadlineMissEvents: cold.deadlineMissEvents ?? [],
      mainRecordedSequences: (cold.mainRecordedSequences ?? []).slice(0, 24),
      missedSequences: cold.missedSequences ?? [],
      // Acceptance accounting: how many results the AudioWorklet actually took.
      // Any margin below is only meaningful for an accepted block.
      resultsAccepted: cold.workletResultsAccepted ?? null,
      resultsRejected: cold.workletResultsRejected ?? null,
      resultsUnattributable: cold.workletResultsUnattributable ?? null,
      rejections: (cold.workletResultRejections ?? []).slice(0, 4).map(entry => ({
        seq: entry.sequence, reason: entry.reason, pending: entry.pendingSequence,
        recvFrame: entry.receivedOutputFrame, dueFrame: entry.dueOutputFrame,
        rtt: r2(entry.roundTripMs) })),
      // Cold-window versus mid-session misses, from the guard's own sequences.
      missPhases: (cold.deadlineMissEvents ?? []).map(entry => ({
        guard: entry.guard ?? entry.event ?? null, seq: entry.sequence ?? null,
        phase: entry.phase ?? null, curFrame: entry.currentOutputFrame ?? null,
        dueFrame: entry.dueOutputFrame ?? null, nextSeq: entry.nextSequence ?? null,
        inputFrame: entry.inputContextFrame ?? null, srcFrame: entry.sourceFrame ?? null,
        ready: entry.readySequences ?? null, dry: entry.drySequences ?? null })),
      // The blocks the guard actually gave up on. For a cold-window miss these
      // overlap `blocks`; for a mid-session miss they are the only relevant ones.
      blocksAroundMiss: (cold.blocksAroundMiss ?? []).slice(0, 8).map(fmtBlock),
      blocks: (cold.blocks ?? []).slice(0, 8).map(fmtBlock),
    });
  }
  if (evidence.status !== 'PASS') {
    const failed = allRuns.find(run => run.status === 'FAIL');
    const detail = [String(failed?.error ?? 'unknown'),
      // Last and truncated: this blob is large and was pushing the actual
      // diagnostics past the annotation limit, which is how the failing run's
      // block decomposition got lost.
      failed?.mixerUi ? `mixerUi=${JSON.stringify(failed.mixerUi).slice(0, 300)}` : ''].filter(Boolean).join(' || ');
    console.log(`::error title=Packaged native VST3 coexistence failed at stage '${failed?.lastStage ?? 'unknown'}'::${detail.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A').slice(0, 3900)}`);
  }
}
process.exit(exitCode);
