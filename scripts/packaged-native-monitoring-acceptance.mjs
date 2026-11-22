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
// Timing instrumentation is enabled with APEX_SMOKE_TIMING_ONLY=1, which turns on
// the renderer smoke timings WITHOUT the built-in smoke entry (that entry ends
// with app.exit() and would end this run). No production DSP or native lifecycle
// behaviour is changed by that flag.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import { writeLiveInputFixture } from './live-input-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runs = Math.max(1, Number(process.env.APEX_NATIVE_MONITORING_RUNS ?? '5'));
const evidenceDir = path.join(root, 'build', 'native-monitoring-evidence');
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
    // Preparing the native session is asynchronous: starting the transport opens
    // the plugin in the helper process. A fixed delay is not enough under CI load,
    // and measuring too early reported an unprepared insert as a coexistence
    // failure (3 of 5 runs passed, then one measured prepared === false). Wait for
    // the insert to be prepared AND for its processed-block count to advance, which
    // is what "actively processing" means. This relaxes nothing: if preparation
    // never completes the wait expires and the baseline assertions still fail.
    const warmupStartedAt = Date.now();
    let warmup = await page.evaluate(() => window.__apexAcceptance
      .measureNativeMonitoringCoexistence('warmup'));
    let priorBlocks = warmup.native.processedBlocks;
    await page.waitForTimeout(500);
    warmup = await page.evaluate(() => window.__apexAcceptance
      .measureNativeMonitoringCoexistence('warmup'));
    // The baseline also has to be taken at a SETTLED session count. Reading the
    // plugin fixture opens short-lived inspect sessions, and sessionCount counts
    // open + pending + closing sessions, so sampling too early produced baselines
    // of 3 and of 1 on different runs - and the comparison then measured the
    // teardown of those inspect sessions rather than anything monitoring did
    // (observed: before=3 during=1 afterDisable=1, and before=1 during=2).
    // Requiring the count to be unchanged between consecutive samples makes the
    // reference stable; it does not relax the comparison itself.
    // Gate only on conditions that are directly observable and that the baseline
    // assertions independently require: the insert is prepared and its processed
    // block count is advancing.
    const settled = () => warmup.native.prepared
      && warmup.native.processedBlocks > priorBlocks;
    while (Date.now() - warmupStartedAt < 60000 && !settled()) {
      priorBlocks = warmup.native.processedBlocks;
      await page.waitForTimeout(500);
      warmup = await page.evaluate(() => window.__apexAcceptance
        .measureNativeMonitoringCoexistence('warmup'));
    }
    run.warmup = { waitedMs: Date.now() - warmupStartedAt, prepared: warmup.native.prepared,
      processedBlocks: warmup.native.processedBlocks, runtimeIds: warmup.native.runtimeIds,
      nativeServiceSessionCount: warmup.native.nativeServiceSessionCount,
      reachedSingleSessionSteadyState: warmup.native.nativeServiceSessionCount === 1 };

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

let exitCode = 0;
for (let index = 1; index <= runs; index++) {
  console.log(`[native-monitoring] run ${index}/${runs}`);
  try {
    const run = await runOnce(index, allRuns);
    console.log(`[native-monitoring] run ${index} PASS: session=${JSON.stringify(run.stages.beforeMonitoring.native.runtimeIds)} `
      + `node=${run.stages.beforeMonitoring.native.nodeId} blocks=${run.nativeProcessing.blocksBefore}/+${run.nativeProcessing.blocksDuringMonitoring}/+${run.nativeProcessing.blocksAfterMonitoringDisabled}`);
  } catch (error) {
    // A failing run is a failing acceptance. No retry converts it into a pass.
    exitCode = 1;
    console.error(`[native-monitoring] run ${index} FAIL: ${String(error?.message ?? error).split('\n')[0]}`);
    break;
  }
}
evidence.runs = allRuns;

const passed = allRuns.filter(run => run.status === 'PASS').length;
evidence.status = exitCode === 0 && passed === runs ? 'PASS' : 'FAIL';
evidence.summary = { requestedRuns: runs, completedRuns: allRuns.length, passedRuns: passed,
  failedRuns: allRuns.length - passed,
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
  if (evidence.status !== 'PASS') {
    const failed = allRuns.find(run => run.status === 'FAIL');
    const detail = [String(failed?.error ?? 'unknown'),
      failed?.mixerUi ? `mixerUi=${JSON.stringify(failed.mixerUi)}` : ''].filter(Boolean).join(' || ');
    console.log(`::error title=Packaged native VST3 coexistence failed at stage '${failed?.lastStage ?? 'unknown'}'::${detail.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A').slice(0, 1500)}`);
  }
}
process.exit(exitCode);
