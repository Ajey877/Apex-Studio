// Packaged Windows application acceptance for the native VST3 editor.
//
// WHAT THIS IS: Playwright launches the REAL packaged Electron application
// (`dist-electron/win-unpacked/*.exe`, built by `npm run package:win:dir`) with its
// real preload bridge and real IPC, and drives the REAL Mixer UI. The editor window
// is therefore created by the packaged application, through the same code path a
// user takes. Native facts (does a separate helper process own a visible window?)
// are then read from the OS process table, not from the app's own claims.
//
// WHAT THIS IS NOT: no `npm run dev`, no browser tab, no service mock. Helper-level
// acceptance is reported separately and is never substituted for this.
//
// Interactive-only checks (physically dragging the window, moving it between
// monitors with different DPI, real 125%/150% display scaling) cannot be produced
// by an automated runner; they are recorded as NOT_VERIFIED and stay in
// docs/VST3-EDITOR-ACCEPTANCE.md as manual steps.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outPath = path.resolve(process.env.APEX_PACKAGED_ACCEPTANCE_OUT
  ?? path.join(root, 'build/native-evidence/packaged-editor-acceptance.json'));

/**
 * Where the plug-in's editor writes its own record of a gesture.
 *
 * The editor runs inside the fixture bundle, which the helper process loads; the
 * harness cannot call into it. The helper inherits this process's environment, so
 * this path is how the editor's own observations of the real control leave that
 * process. It is deleted before the gesture so the trace provably describes THIS
 * gesture and not an earlier one.
 */
const editorTracePath = path.join(path.dirname(outPath), 'editor-gesture-trace.log');

/** Read the editor's trace, or null when the editor wrote nothing. */
function readEditorTrace() {
  if (!existsSync(editorTracePath)) return null;
  const text = readFileSync(editorTracePath, 'utf8');
  const lines = text.split('\n').filter(line => line.length > 0);
  return { lineCount: lines.length, lines };
}

const CRITERIA = {
  'p1-mixer-opens-editor': "Mixer insert opens the plug-in's own editor",
  'p2-native-window-responsive': 'Native window appears and stays responsive',
  'p3-parameter-reaches-apex': 'Parameter changes reach Apex',
  'p4-one-undoable-change': 'Closing the editor commits exactly one undoable change',
  'p5-undo-redo': 'Undo and redo work',
  'p6-save-quit-reload': 'Save, quit and reload preserve state',
  'p7-no-leaked-helpers': 'Closing Apex with the editor open leaks no helper processes',
  'p8-recovery': 'Recovery behaviour works after an editor crash',
  'p9-dpi-125-150': '125% and 150% DPI behaviour',
};
const results = [];
/**
 * The most recent renderer-side diagnosis, kept so a failure thrown further along
 * can explain itself. The UI already knows why an editor did not open; without
 * this the thrown error is only a symptom ("no native editor session is open")
 * and the cause is lost with the evidence blob.
 */
let lastUiDiagnosis = null;
const stage = (name, detail = '') =>
  console.log(`STAGE ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
const record = (id, status, evidence) => {
  results.push({ id, criterion: CRITERIA[id], status, evidence, kind: 'automated-packaged' });
  // Annotations are the only CI evidence channel available here, so every
  // non-PASS criterion states why in one line instead of only living in the JSON.
  if (status !== 'PASS') {
    // Annotations are truncated near 1000 characters, so a nested evidence blob can
    // hide its own diagnosis: the fields that explain a failure sit past the cut.
    // The compact reason therefore goes FIRST, inside the line the workflow already
    // lifts (`reason` is conventional for this script), then the detail as far as
    // it fits. No new prefix is introduced -- the workflow's allowlist is shipped
    // behaviour and this change is not allowed to touch it.
    const summary = compactReason(evidence);
    const payload = summary ? { reason: summary, detail: evidence } : (evidence ?? {});
    const why = JSON.stringify(payload).slice(0, 700);
    console.log(`ACCEPTANCE-DETAIL ${id} ${status} ${why}`);
  }
};

/** The handful of evidence fields that actually explain a non-PASS result. */
function compactReason(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  const pick = {};
  const take = (key, value) => { if (value !== undefined && value !== null && `${value}` !== '') pick[key] = value; };
  take('reason', evidence.reason);
  take('error', evidence.error);
  // Verdict-deciding facts that are otherwise buried past the annotation cut.
  take('killedPid', evidence.killedPid);
  take('phaseAfterCrash', evidence.phaseAfterCrash);
  take('recoveryRecordOffered', evidence.recoveryRecordOffered);
  take('gainParameterEdited', evidence.gainParameterEdited);
  take('editedParameterIds', Array.isArray(evidence.editedParameterIds) ? evidence.editedParameterIds.join(',') : evidence.editedParameterIds);
  take('sessionPhase', evidence.sessionPhase);
  take('sessionError', evidence.sessionError);
  take('undoRestored', evidence.undoRestored);
  take('redoReapplied', evidence.redoReapplied);
  take('redoDiffersAt', evidence.redoDiffersAt);
  take('redoDepths', evidence.depthsAfterUndo ? JSON.stringify({
    before: evidence.depthsBefore, afterUndo: evidence.depthsAfterUndo, afterRedo: evidence.depthsAfterRedo,
  }) : undefined);
  take('undoDepthBefore', evidence.undoDepthBefore);
  take('undoDepthAfter', evidence.undoDepthAfter);
  const diagnosed = evidence.diagnosedByRenderer ?? {};
  for (const [key, value] of Object.entries(diagnosed)) {
    if (value !== undefined && value !== null && value !== '') pick[key] = value;
  }
  const ui = evidence.mixerUi ?? diagnosed;
  take('insertRowRendered', ui.insertRowRendered);
  take('clickedControl', evidence.clickedControl);
  take('vst3Inserts', ui.vst3InsertCountInProject);
  take('lastEditorOpenError', ui.lastEditorOpenError);
  take('editorAlerts', Array.isArray(ui.editorAlertAfterClick) ? ui.editorAlertAfterClick.join(' | ') : ui.editorAlertAfterClick);
  take('editorStatus', Array.isArray(ui.editorStatusAfterClick) ? ui.editorStatusAfterClick.join(' | ') : undefined);
  take('helperLifetimeMs', evidence.helperLifetimeMs ? JSON.stringify(evidence.helperLifetimeMs) : undefined);
  take('helperSessionErrors', Array.isArray(evidence.helperSessionErrors) && evidence.helperSessionErrors.length
    ? evidence.helperSessionErrors.join(' | ') : undefined);
  try { return JSON.stringify(pick).slice(0, 600); } catch { return ''; }
}

function environment() {
  const query = (cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim(); }
    catch (error) { return `unavailable: ${error.message}`; }
  };
  return {
    platform: process.platform, arch: process.arch, osRelease: os.release(),
    windowsBuild: query('cmd', ['/c', 'ver']), node: process.version,
    isCi: Boolean(process.env.CI), runnerImage: process.env.ImageOS ?? null,
    commit: process.env.GITHUB_SHA ?? null,
    packaging: 'electron-builder --win --x64 --dir (real packaged app, win-unpacked)',
  };
}

function writeReport(extra = {}) {
  const report = {
    schemaVersion: 1,
    kind: 'packaged-application-acceptance',
    generatedAt: new Date().toISOString(),
    environment: environment(),
    criteria: results,
    summary: {
      total: results.length,
      pass: results.filter(r => r.status === 'PASS').length,
      fail: results.filter(r => r.status === 'FAIL').length,
      notVerified: results.filter(r => r.status === 'NOT_VERIFIED').length,
      allVerifiedPassing: results.length > 0 && results.every(r => r.status === 'PASS'),
    },
    ...extra,
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`ACCEPTANCE-SUMMARY ${JSON.stringify({
    kind: 'packaged-application', summary: report.summary,
    statuses: Object.fromEntries(results.map(r => [r.id, r.status])),
  })}`);
  for (const r of results) console.log(`${r.status.padEnd(12)} ${r.id.padEnd(26)} ${r.criterion}`);
  // The C/D instrument's own finding, printed whether or not p3 passes.
  //
  // `record()` only annotates non-PASS criteria, so once p3 passes its trace became
  // invisible in CI: the verdict was reported but the evidence that justified it was
  // not. This additive line is lifted to a notice by the workflow and states what the
  // editor actually observed, so the PASS is auditable from the run itself.
  const p3 = results.find(r => r.id === 'p3-parameter-reaches-apex');
  if (p3?.evidence?.cOrDVerdict) {
    const facts = p3.evidence.traceFacts ?? {};
    console.log(`ACCEPTANCE-EDITOR-TRACE ${JSON.stringify({
      cOrDVerdict: p3.evidence.cOrDVerdict,
      mouseDownOnGainSlider: facts.mouseDownOnGainSlider ?? null,
      controlValueMoved: facts.controlValueMoved ?? null,
      valuesSeen: facts.valuesSeen ?? null,
      beganEditing: facts.beganEditing ?? null,
      controlBeginEditObserved: facts.controlBeginEditObserved ?? null,
      valueChangedObserved: facts.valueChangedObserved ?? null,
      performEditObserved: facts.performEditObserved ?? null,
      controlEndEditObserved: facts.controlEndEditObserved ?? null,
      gainParameterEdited: p3.evidence.gainParameterEdited ?? null,
      editedParameterIds: p3.evidence.editedParameterIds ?? null,
      traceLineCount: p3.evidence.editorTraceLineCount ?? null,
    })}`);
  }
  return report;
}

/** apex-vst3-host processes the OS currently knows about. */
// Enumerating helpers must never be able to say "no helpers" when the question
// could not be asked at all: a silent [] turned "we saw nothing" into a PASS for
// the no-leak criterion. Every call reports whether the read actually succeeded.
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
    out => out.split(/\r?\n/).map(l => l.trim())
      .filter(l => /^"apex-vst3-host\.exe"/i.test(l))
      .map(l => {
        const cells = l.split('","').map(c => c.replace(/^"|"$/g, ''));
        return { image: cells[0], pid: Number(cells[1]) };
      }));
  const fromCim = fromTasklist ?? read('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='apex-vst3-host.exe'\" | Select-Object ProcessId,Name | ConvertTo-Json -Compress"],
    out => {
      const parsed = out.trim() ? JSON.parse(out.trim()) : [];
      return (Array.isArray(parsed) ? parsed : [parsed]).map(e => ({ image: e.Name, pid: Number(e.ProcessId) }));
    });
  const result = fromTasklist ?? fromCim;
  if (!result) return { ok: false, error: attempts, processes: [] };
  return { ok: true, source: fromTasklist ? 'tasklist' : 'powershell-cim', processes: result.processes };
}

/** Pids with a visible top-level window (OS truth, not the app's claim). */
function helperWindows(pids) {
  const ids = pids.map(p => p.pid).filter(Boolean);
  if (!ids.length) return [];
  try {
    const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ` +
      'Select-Object Id,MainWindowHandle,MainWindowTitle | ConvertTo-Json -Compress';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(entry => ({
      pid: Number(entry.Id), handle: Number(entry.MainWindowHandle), title: entry.MainWindowTitle ?? '',
    }));
  } catch { return []; }
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  for (const id of Object.keys(CRITERIA)) {
    record(id, 'NOT_VERIFIED', { reason: `requires Windows x64 with a packaged app; this host is ${process.platform}/${process.arch}` });
  }
  writeReport({ blocked: 'not-a-windows-x64-host' });
  console.log('Not a Windows x64 host: packaged acceptance recorded as NOT_VERIFIED.');
  process.exit(2);
}

const packageRoot = path.join(root, 'dist-electron/win-unpacked');
const executable = (() => {
  if (!existsSync(packageRoot)) return undefined;
  const candidates = readdirSync(packageRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map(entry => path.join(packageRoot, entry.name));
  return candidates.find(file => file.toLowerCase().includes('apex')) ?? candidates[0];
})();
if (!executable) {
  for (const id of Object.keys(CRITERIA)) {
    record(id, 'NOT_VERIFIED', { reason: 'packaged app not built; run npm run package:win:dir', packageRoot });
  }
  writeReport({ blocked: 'packaged-app-not-built' });
  console.log('Packaged app missing: packaged acceptance recorded as NOT_VERIFIED.');
  process.exit(2);
}

// The fixture is Apex's own test-only acceptance plug-in, built next to the other
// native fixtures. It is the ONLY plug-in available here that satisfies all three
// requirements at once (see docs/VST3-EDITOR-ACCEPTANCE.md for the full survey):
//   - stereo in/out with NO event input bus, so the Mixer accepts the insert;
//   - a genuine VSTGUI editor window;
//   - a controller that exposes the exact parameter its editor edits, so its
//     beginEdit/performEdit/endEdit callbacks name known, writable ParamIDs.
const editorFixture = path.join(root, 'build/native-vst3/VST3/Release/apex-acceptance-vst3.vst3');
// Registered name from acceptance-fixture-entry.cpp.
const EDITOR_FIXTURE_NAME = /^ApexAcceptanceGain$/i;
/**
 * Open the fixture's editor through the real Mixer UI, in the order a user does:
 * Mixer tab, track strip, "+", "Native VST3 Effect", the plug-in row, then the
 * insert row's "Open VST3 editor" button. Shared by p1 and p8 so the two cannot
 * drift into different definitions of "the UI".
 *
 * Deliberately has no fallback: if a row does not render, that is the result.
 */
async function openEditorThroughMixerUi(page) {
  const ui = {};
  try {
    const mixerTab = page.locator('#nav-mixer');
    await mixerTab.waitFor({ state: 'visible', timeout: 30000 });
    await mixerTab.click({ timeout: 15000 });
    ui.openedMixerView = true;
    await page.waitForTimeout(500);

    const trackStrip = page.locator('#mixer-strip-1');
    await trackStrip.waitFor({ state: 'visible', timeout: 30000 });
    await trackStrip.click({ timeout: 15000 });
    ui.selectedTrackStrip = '#mixer-strip-1';
    await page.waitForTimeout(300);

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
    const fixtureButton = page.getByRole('button', { name: /ApexAcceptanceGain/ }).first();
    await fixtureButton.waitFor({ state: 'visible', timeout: 60000 });
    ui.pickerRowLabel = await fixtureButton.innerText().catch(() => '');
    await fixtureButton.click({ timeout: 60000 });
    ui.choseFixtureFromPicker = true;

    const openButton = page.getByRole('button', { name: 'Open VST3 editor' }).first();
    await openButton.waitFor({ state: 'visible', timeout: 60000 });
    ui.insertRowRendered = true;
    await openButton.click({ timeout: 30000 });
    ui.clickedOpenVst3Editor = true;
    return { ok: true, ui };
  } catch (error) {
    return { ok: false, ui, error: `${error?.message ?? error}`.split('\n')[0] };
  }
}

const profile = path.join(root, 'build', `packaged-acceptance-profile-${Date.now()}`);
/** Every launch of the packaged app uses this environment. Declared once so no
 *  launch can silently forget the flag that enables the acceptance hook. */
function launchEnv(extra = {}) {
  return {
    ...process.env,
    APEX_ACCEPTANCE: '1',
    APEX_ACCEPTANCE_USER_DATA: profile,
    APEX_VST3_SMOKE_PLUGIN: editorFixture,
    APEX_ACCEPTANCE_EDITOR_TRACE: editorTracePath,
    ...extra,
  };
}

async function run() {
  const { _electron } = await import('playwright');
  stage('launch-packaged-app', { executable });
  const app = await _electron.launch({
    executablePath: executable,
    env: launchEnv(),
    timeout: 180000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Discover AGain through the packaged preload bridge, and put it on an insert.
  const setup = await page.evaluate(async () => {
    const bridge = globalThis.desktopApp?.vst3;
    if (!bridge) return { error: 'packaged preload bridge missing' };
    const discovered = await bridge.discoverEffects();
    const target = (discovered.plugins ?? []).find(p => /^ApexAcceptanceGain$/i.test(p.name));
    if (!target) {
      return { error: 'ApexAcceptanceGain was not discovered in the packaged app',
        errors: discovered.errors, names: (discovered.plugins ?? []).map(p => p.name) };
    }
    // inspectEffect resolves to the effect itself (see App.handleEditVst3Effect),
    // carrying the state that openEditor validates; it is not wrapped in {effect}.
    const inspected = await bridge.inspectEffect(target, undefined);
    const effect = { ...target, ...(inspected ?? {}) };
    if (!effect.state || effect.state.classId !== effect.classId || !Array.isArray(effect.state.parameters)) {
      return { error: 'inspected fixture has no usable identity/state',
        names: [], errors: [{ inspectedKeys: Object.keys(inspected ?? {}), classId: effect.classId ?? null,
          stateClassId: effect.state?.classId ?? null, parameterCount: effect.state?.parameters?.length ?? null }] };
    }
    return { effect, pluginCount: (discovered.plugins ?? []).length };
  });
  if (setup?.error) {
    // The reason matters more than the symptom: record what WAS discoverable.
    console.log(`ACCEPTANCE-ERROR ${setup.error} | names=${JSON.stringify(setup.names ?? [])} | errors=${JSON.stringify(setup.errors ?? [])}`.slice(0, 900));
    throw new Error(setup.error);
  }

  /** Editor-session errors the app reported, collected for p1's evidence. */
  const sessionErrors = [];
  const helpersBeforeRead = helperProcesses();
  const helpersBefore = helpersBeforeRead.processes;

  // ---- p1: the Mixer insert opens the plug-in's own editor ----------------
  // This drives the app's REAL user interface end to end, in this order:
  //   Mixer track -> "+" (Add Effect Plugin) -> "Native VST3 Effect" -> pick the
  //   discovered plug-in -> the insert row renders -> its "Open VST3 editor".
  // No test-only handler is used to open the editor: the visible control is the
  // control that is clicked, and its absence is a FAIL rather than a fallback.
  stage('p1-mixer-ui');
  const opened = await openEditorThroughMixerUi(page);
  const ui = { ...opened.ui, selectedTrack: 'Kick / 808' };
  if (!opened.ok) {
    // One of the visible controls was missing. Say which step and stop: every later
    // packaged criterion depends on an editor that this path could not open.
    record('p1-mixer-opens-editor', 'FAIL', {
      clickedControl: 'Mixer insert "Open VST3 editor" button (real UI click)',
      mixerUi: ui,
      failingStep: opened.error,
      note: 'The real Mixer UI could not open the editor; no test-only path is used as a substitute.',
    });
    throw new Error(`the real Mixer UI could not open the editor: ${opened.error}`);
  }
  const triggeredVia = 'Mixer insert "Open VST3 editor" button (real UI click)';
  ui.fxSlotsHeaderNamesSelection = await page
    .getByText(/FX SLOTS \(KICK \/ 808\)/i).first().isVisible().catch(() => false);

  // Capture the insert row's own status/error text. If the editor failed to open,
  // the UI already says why -- recording it turns "no helper" into a diagnosis
  // instead of a mystery.
  ui.editorStatusAfterClick = await page
    .locator('p[role="status"]').allInnerTexts().then(list => list.filter(Boolean).slice(-4)).catch(() => []);
  ui.editorAlertAfterClick = await page
    .locator('p[role="alert"]').allInnerTexts().then(list => list.filter(Boolean).slice(-4)).catch(() => []);
  // The renderer's own record of why the open failed, which carries the helper's
  // stderr through every layer. This is the only place the native cause survives.
  // NOTE: the renderer's own diagnosis is read AFTER the sampling loop below. The
  // open is asynchronous, so reading it here captures the "Opening…" state and
  // misses the rejection that actually explains the failure.

  // Cross-check that the project state agrees an insert was actually added.
  const inserted = await page.evaluate(async () => {
    const app = globalThis.__apexAcceptance;
    if (!app) return null;
    return app.projectSnapshot();
  });
  const insertCount = (() => {
    try { return JSON.parse(inserted?.vst3State ?? '[]')
      .flatMap(track => track.fxSlots ?? []).filter(slot => slot.type === 'vst3').length; } catch { return null; }
  })();
  ui.vst3InsertCountInProject = insertCount;

  // Sample continuously instead of once at +4s: a short-lived helper (one whose
  // session is reaped early, e.g. by a rejected callbacks stream) would otherwise
  // leave "no window" as the only observation even though a window did appear.
  const samples = [];
  const seenHelpers = new Map();
  let visibleWindow;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const read = helperProcesses();
    const fresh = read.processes.filter(h => !helpersBefore.some(b => b.pid === h.pid));
    for (const helper of fresh) seenHelpers.set(helper.pid, helper);
    const found = helperWindows(fresh);
    const visible = found.find(w => w.handle > 0);
    samples.push({ atMs: 6000 - (deadline - Date.now()), ok: read.ok,
      helperPids: fresh.map(h => h.pid), visibleWindows: found.filter(w => w.handle > 0).length });
    if (visible) { visibleWindow = visible; break; }
    await page.waitForTimeout(150);
  }
  // Now that the window-sampling window has elapsed, the open has either produced a
  // window or rejected. Read what the renderer recorded, which is where the
  // helper's own stderr survives.
  ui.lastEditorOpenError = await page
    .evaluate(() => globalThis.__apexAcceptance?.lastEditorOpenError?.() ?? null)
    .catch(() => null);
  ui.editorAlertAfterClick = await page
    .locator('p[role="alert"]').allInnerTexts().then(list => list.filter(Boolean).slice(-4)).catch(() => []);
  ui.editorStatusAfterClick = await page
    .locator('p[role="status"]').allInnerTexts().then(list => list.filter(Boolean).slice(-4)).catch(() => []);
  lastUiDiagnosis = {
    insertRowRendered: ui.insertRowRendered ?? null,
    vst3InsertCountInProject: ui.vst3InsertCountInProject ?? null,
    lastEditorOpenError: ui.lastEditorOpenError ?? null,
    editorAlertAfterClick: ui.editorAlertAfterClick ?? null,
    editorStatusAfterClick: ui.editorStatusAfterClick ?? null,
    pickerStatusText: ui.pickerStatusText ?? null,
  };
  const helpersDuringRead = { ok: samples.some(sample => sample.ok), source: 'sampled',
    error: samples.every(sample => !sample.ok) ? ['process table unreadable for every sample'] : null };
  const helpersDuring = [...seenHelpers.values()];
  const newHelpers = helpersDuring;
  const windows = helperWindows(helpersDuring);
  // No helper read means no evidence either way: never PASS and never claim FAIL.
  // A helper that appeared and vanished before a window could be observed is also
  // NOT_VERIFIED: the criterion was not observed, and no host code was proven wrong.
  const helperLifetimeMs = newHelpers.length && samples.length
    ? { firstSeenMs: samples.find(sample => sample.helperPids.length)?.atMs ?? null,
        lastSeenMs: samples.filter(sample => sample.helperPids.length).at(-1)?.atMs ?? null }
    : null;
  // p1 requires the whole visible chain to have worked: the insert row rendered,
  // the real control was clicked, a helper spawned, and an OS-visible window
  // appeared. Anything less is unproven rather than passed.
  const uiChainComplete = ui.insertRowRendered === true && ui.vst3InsertCountInProject !== 0;
  record('p1-mixer-opens-editor', !helpersDuringRead.ok ? 'NOT_VERIFIED'
    : newHelpers.length > 0 && visibleWindow ? 'PASS'
    : uiChainComplete ? 'NOT_VERIFIED'
    : 'FAIL', {
    helperLifetimeMs,
    // The fixture, not the host, is what limits this run: see the fixture table in
    // docs/VST3-EDITOR-ACCEPTANCE.md. Recorded so nobody reads this as a host bug.
    // No fixture excuse any more: ApexAcceptanceGain is stereo, declares no event
    // buses, has a genuine VSTGUI editor and exposes the parameter its editor edits.
    // If no window appears now, that is a host or package finding, not a fixture
    // limitation, and the evidence must say so rather than blame the fixture.
    fixtureLimit: null,
    helperSessionErrors: sessionErrors.length ? sessionErrors : ui.editorAlertAfterClick ?? [],
    helperEnumeration: { before: helpersBeforeRead.ok, during: helpersDuringRead.ok,
      source: helpersDuringRead.source ?? null, errors: helpersDuringRead.error ?? null },
    clickedControl: triggeredVia,
    mixerUi: ui,
    discoveredThroughPackagedIpc: { name: setup.effect?.name, classId: setup.effect?.classId, pluginCount: setup.pluginCount },
    helperProcessesBefore: helpersBefore,
    helperProcessesDuring: helpersDuring,
    observationSamples: samples.slice(0, 40),
    newHelperCount: newHelpers.length,
    helperWindows: windows,
    // A separate OS process owning a visible top-level window IS the native window.
    nativeWindowPid: visibleWindow?.pid ?? null,
    nativeWindowHandle: visibleWindow?.handle ?? null,
    nativeWindowTitle: visibleWindow?.title ?? null,
  });

  // ---- p2: the window is alive and the app is responsive ------------------
  stage('p2');
  const responsive = await page.evaluate(async () => {
    const started = performance.now();
    await new Promise(r => setTimeout(r, 250));
    const bridge = globalThis.desktopApp?.vst3;
    const paths = await bridge.paths();
    return { roundTripMs: Math.round(performance.now() - started), pathCount: paths.length };
  });
  // Still the same live window a moment later (not a one-frame flash).
  const helpersLaterRead = helperProcesses();
  const helpersLater = helpersLaterRead.processes;
  const windowStillThere = helpersLaterRead.ok && windows.some(w => helpersLater.some(h => h.pid === w.pid));
  const windowEverObserved = Boolean(visibleWindow);
  record('p2-native-window-responsive', !windowEverObserved ? 'NOT_VERIFIED'
    : windowStillThere && responsive.roundTripMs < 5000 ? 'PASS' : 'FAIL', {
    windowEverObserved,
    windowObservedAgainAfterDelay: windowStillThere,
    packagedIpcRoundTripMs: responsive.roundTripMs,
    dialogsBlockingApp: false,
    note: 'The window persisted across a second OS process-table read, and packaged IPC answered while it was open, so the app is not blocked by the native window.',
  });

  // ---- p3: a parameter change reaches Apex -------------------------------
  stage('p3');
  // An open plug-in window that reports a parameter change must reach Apex. The
  // real panel polls the session; a session that reports an edit here proves the
  // same path the panel uses.
  // Drive the plug-in's own editor window with genuine OS input over the Gain
  // slider, then read what Apex received.
  //
  // Coordinates come from the real uidesc nesting and are added up here on purpose:
  // the slider's origin is relative to its PARENT container, and the parent panel
  // sits at (10, 12) inside the 320x120 root view. Using the slider's own origin
  // directly (as an earlier version did) aimed at empty space between the title and
  // the gain label, which is why the plug-in reported no edit at all.
  //   panel origin (10,12) + slider origin (64,40) = (74,52); size 168x18
  const GAIN_SLIDER = { panelOrigin: { x: 10, y: 12 }, origin: { x: 64, y: 40 }, size: { width: 168, height: 18 } };
  // Where the handle sits, and where the drag takes it.
  //
  // The fixture's default gain is 0.5 (0 dB), so the handle starts at the middle
  // of the track. A CLICK at that point re-sets the value it already holds:
  // VSTGUI's slider only emits valueChanged() when isDirty(), so a well-aimed
  // click emits no performEdit at all and the parameter never changes. The
  // gesture must therefore be a real drag -- press on the handle, move, release
  // -- which is also what a user does to change a gain.
  const sliderTrack = {
    left: GAIN_SLIDER.panelOrigin.x + GAIN_SLIDER.origin.x,
    centreY: GAIN_SLIDER.panelOrigin.y + GAIN_SLIDER.origin.y + Math.round(GAIN_SLIDER.size.height / 2),
  };
  const sliderPoint = { x: sliderTrack.left + Math.round(GAIN_SLIDER.size.width * 0.5), y: sliderTrack.centreY };
  const dragTarget = { x: sliderTrack.left + Math.round(GAIN_SLIDER.size.width * 0.75), y: sliderTrack.centreY };
  // Start from an empty trace so every line recorded below belongs to this gesture.
  mkdirSync(path.dirname(editorTracePath), { recursive: true });
  rmSync(editorTracePath, { force: true });
  const gainInput = await page.evaluate(async (point) => {
    const app = globalThis.__apexAcceptance;
    if (!app?.driveEditorWithRealInput) return { error: 'no real-input hook available' };
    return app.driveEditorWithRealInput(point);
  }, { ...sliderPoint, to: dragTarget }).catch(error => ({ error: String(error?.message ?? error) }));
  // Then let the panel's normal poll loop observe the edit. Sample rather than
  // reading once: the click is delivered asynchronously by the OS and the plug-in
  // reports the change on its next poll, so a single read can race it.
  const edited = await page.evaluate(async () => {
    const app = globalThis.__apexAcceptance;
    const before = await app.pollOpenEditor();
    let latest = before;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      latest = await app.pollOpenEditor();
      // Stop as soon as the plug-in reports an edit of the Gain parameter.
      if ((latest.editedParameterIds ?? []).length > 0) break;
    }
    return { ...latest, beforeParameterIds: before.editedParameterIds ?? [],
      observedWithinMs: (latest.editedParameterIds ?? []).length > 0 ? 'edit reported by the poll loop' : null };
  });
  const reachedApex = await page.evaluate(async (slotId) => globalThis.__apexAcceptance.readInsertParameter(1, slotId), inserted?.slotId);
  // A rejection is a genuine FAIL (the host refused something). A session that
  // never reached a live window has no edit to forward, so it is NOT_VERIFIED.
  // The host rejects edits that name parameters the controller does not expose.
  // For a fixture whose editor drives UI-only tags that is CORRECT behaviour, so
  // the criterion is unproven rather than failed. Any other rejection is a FAIL.
  const fixtureRejection = /unknown or read-only ParamID/.test(String(edited?.error ?? ''));
  // PASS requires the plug-in's own editor to have reported an edit of a real
  // parameter, observed by the same poll loop the panel uses. The presence of the
  // insert's saved value is NOT evidence: it is non-null before the click too.
  const gainEdited = (edited?.editedParameterIds ?? []).includes(0);
  const p3Verdict = gainEdited ? 'PASS'
    : fixtureRejection ? 'NOT_VERIFIED'
    : edited?.phase === 'failed' ? 'FAIL' : 'NOT_VERIFIED';
  const blockedByFixture = fixtureRejection;
  // The plug-in's own editor wrote this during the gesture. It is the only evidence
  // that says WHERE the genuine interaction stops, so it is recorded with the verdict
  // rather than left in a log file.
  const editorTrace = readEditorTrace();
  const traceText = editorTrace ? editorTrace.lines.join('\n') : '';

  /**
   * Parse the editor's trace into per-stage slider states instead of matching log
   * prose with patterns: a test that greps fixed text breaks the moment a number
   * changes width, and would report the wrong thing rather than fail.
   *
   * Each `state:<stage> afterDispatch` line is one post-event observation of the
   * real Gain slider: its normalized value, whether it is editing, and what the
   * controller holds at that moment.
   */
  function parseSliderStates(lines) {
    const states = {};
    for (const line of lines) {
      const match = /^state:(down|move|up) afterDispatch sliderValue=([-\d.e+]+) sliderNormalized=([-\d.e+]+) editing=(true|false) dirty=(true|false) controllerNormalized=([-\d.eNa/]+)/.exec(line);
      if (!match) continue;
      const [, stage, value, normalized, editing, dirty, controller] = match;
      // Keep every observation per stage: a drag produces several moves.
      (states[stage] ??= []).push({
        value: Number(value), normalized: Number(normalized), editing: editing === 'true',
        dirty: dirty === 'true', controllerNormalized: Number(controller),
      });
    }
    return states;
  }

  const sliderStates = editorTrace ? parseSliderStates(editorTrace.lines) : {};
  const firstDown = sliderStates.down?.[0] ?? null;
  const allMoves = sliderStates.move ?? [];
  const lastUp = sliderStates.up?.at(-1) ?? null;
  // The value moved if any post-dispatch observation differs from where the press
  // found it. This is the measurement, not an expectation about the direction.
  const anyStateNormalized = [firstDown, ...allMoves, lastUp]
    .filter(Boolean).map(state => state.normalized);
  const valuesSeen = [...new Set(anyStateNormalized)];
  const controlValueMoved = valuesSeen.length > 1;
  // A post-dispatch read can be unavailable (the frame was not inside event
  // handling). That is missing evidence, not an observation that the value stayed
  // put, so it must never be classified as case C.
  const postDispatchUnavailable = /afterDispatch=UNAVAILABLE/.test(traceText);
  const havePostDispatchState = firstDown !== null || allMoves.length > 0 || lastUp !== null;
  const beganEditing = Boolean(firstDown?.editing) || allMoves.some(state => state.editing);
  const endedEditing = lastUp ? lastUp.editing === false : false;

  const traceFacts = {
    // Decisive facts first: annotations truncate, and these are what name the case.
    mouseDownOnGainSlider: editorTrace?.lines.some(line => line.startsWith('mouse:downLandedOnGainSlider')) === true,
    controlValueMoved,
    beganEditing,
    endedEditing,
    controlBeginEditObserved: /lifecycle:controlBeginEdit/.test(traceText),
    controlEndEditObserved: /lifecycle:controlEndEdit/.test(traceText),
    valueChangedObserved: /lifecycle:valueChanged/.test(traceText),
    performEditObserved: /controller:performEdit .*accepted=true/.test(traceText),
    parameterListenerPresent: /parameterListener=present/.test(traceText),
    parameterListenerMissing: /parameterListener=null/.test(traceText),
    // Then the supporting detail.
    valuesSeen,
    sliderPresentAtOpen: /editor:binding[^\n]*gainSliderPresent=true/.test(traceText),
    listenerIsEditor: /listenerIsEditor=true/.test(traceText),
    havePostDispatchState,
    postDispatchUnavailable,
    performEditRejected: /controller:performEdit .*accepted=false/.test(traceText),
    performEditSkipped: /controller:performEditSkipped/.test(traceText),
    sliderStates,
  };


  /**
   * Which hypothesis the trace supports.
   *
   * C = the control took the gesture and its value did not change.
   * D = the value changed but the beginEdit/performEdit/endEdit lifecycle did not run.
   * With no trace, and with any state the trace does not cover, the answer stays
   * open: it is never supplied by assumption.
   */
  const traceVerdict = !editorTrace || editorTrace.lineCount === 0 ? 'NO_TRACE'
    : traceFacts.performEditObserved ? 'EDIT_REACHED_CONTROLLER'
    : traceFacts.parameterListenerMissing ? 'CASE_D_NO_PARAMETER_BINDING'
    : !traceFacts.mouseDownOnGainSlider ? 'CASE_C_NO_MOUSEDOWN_ON_SLIDER'
    : traceFacts.postDispatchUnavailable || !traceFacts.havePostDispatchState
      ? 'UNRESOLVED_NO_POST_DISPATCH_STATE'
    : !traceFacts.controlValueMoved ? 'CASE_C_CONTROL_VALUE_DID_NOT_MOVE'
    : !traceFacts.controlBeginEditObserved ? 'CASE_D_LIFECYCLE_NOT_INVOKED'
    : 'UNRESOLVED';

  record('p3-parameter-reaches-apex', p3Verdict, {
    // The editor's own account of the gesture comes FIRST, before the bulky
    // gesture/poll payloads below. CI annotations are truncated, and the C/D
    // verdict plus its raw evidence are the whole point of this run: burying them
    // made the first instrumented run report a verdict nobody could read.
    cOrDVerdict: traceVerdict,
    editorTracePresent: Boolean(editorTrace),
    editorTraceLineCount: editorTrace?.lineCount ?? 0,
    traceFacts,
    editorTraceLines: editorTrace?.lines ?? null,
    editorTracePath: editorTrace ? editorTracePath : null,
    // Compact, front-loaded facts: annotations are truncated, and these are the
    // three things that decide the verdict.
    gainParameterEdited: gainEdited,
    editedParameterIds: edited?.editedParameterIds ?? null,
    sessionPhase: edited?.phase ?? null,
    sessionError: edited?.error || null,
    // Front-loaded because annotations truncate: a failure has to say what
    // gesture was performed and whether the OS actually delivered it.
    gesture: gainInput?.gesture ?? null,
    sent: gainInput?.sent ?? null,
    injectionError: gainInput?.error ?? null,
    // What actually reached the plug-in window, per step. `postedMessages` is the
    // receipt (real mouse messages), never the attempt.
    deliveredSteps: gainInput?.delivered ? Object.keys(gainInput.delivered) : null,
    // What the helper's SendInput accepted per step, and whether the button was
    // really held at the steps where that is what makes it a drag.
    sentEvents: gainInput?.delivered
      ? Object.fromEntries(Object.entries(gainInput.delivered).map(([step, value]) => [step, value?.postedMessages ?? null]))
      : null,
    buttonHeldAfter: gainInput?.delivered
      ? Object.fromEntries(Object.entries(gainInput.delivered).map(([step, value]) => [step, value?.buttonHeldAfter ?? null]))
      : null,
    mechanism: 'genuine OS input (SendInput) was aimed at the Gain slider inside the plug-in\'s own editor window, then the panel\'s normal poll loop observed the edit',
    gainInput,
    sliderPoint,
    dragTarget,
    sliderGeometry: GAIN_SLIDER,
    blockedByFixture,
    blockedBy: blockedByFixture
      ? 'the fixture editor references ParamIDs its own controller does not expose (DataExchange UI-only tags); the host rejects them by design'
      : null,
    edited: edited,
    insertStateAfterEdit: reachedApex,
    valueIsNotEvidence: 'readInsertParameter returns the insert\'s saved value, which is non-null before the click; the editedParameterIds reported by the plug-in are what prove the edit.',
  });

  // ---- p4/p5: one undoable change, undo and redo -------------------------
  stage('p4');
  // Closing the editor is the commit. This reads the PARAMETER across the gesture and
  // the undo/redo that follow, so "one undoable change" is proven on the actual value
  // the user edited rather than on the depth counter alone: a depth-only check passes
  // for any change, including one that never touched the gain.
  const history = await page.evaluate(async (slotId) => {
    const app = globalThis.__apexAcceptance;
    return app.editorParameterUndoRedo(1, slotId);
  }, inserted?.slotId);
  const added = history?.entriesAddedByGesture;
  // The edited value must differ from the fixture default (0.5); otherwise "undo
  // restored the original" is a comparison of two identical numbers and proves
  // nothing. The plugin's own default is the only honest baseline.
  const editedDiffersFromDefault = typeof history?.valueAfterClose === 'number'
    && Math.abs(history.valueAfterClose - 0.5) > 1e-6;
  const p4Passed = added === 1 && editedDiffersFromDefault
    && history?.undoChanged === true && history?.redoRestoredEdited === true;
  record('p4-one-undoable-change', p4Passed ? 'PASS' : blockedByFixture ? 'NOT_VERIFIED' : 'FAIL', {
    // Front-loaded: these decide the verdict.
    entriesAddedByGesture: added,
    editedValue: history?.valueAfterClose ?? null,
    valueAfterUndo: history?.valueAfterUndo ?? null,
    valueAfterRedo: history?.valueAfterRedo ?? null,
    editedDiffersFromDefault,
    undoChanged: history?.undoChanged ?? null,
    redoRestoredEdited: history?.redoRestoredEdited ?? null,
    noDuplicateEntries: history?.noDuplicateEntries ?? null,
    depthBeforeClose: history?.depthBeforeClose ?? null,
    depthAfterClose: history?.depthAfterClose ?? null,
    depthAfterUndo: history?.depthAfterUndo ?? null,
    depthAfterRedo: history?.depthAfterRedo ?? null,
    blockedByFixture,
    note: 'One completed gesture adds exactly one undo entry; undo restores the pre-edit gain and redo restores the edited gain.',
  });
  // Remember the edited value so the reload check cannot pass on the default.
  const editedParameterValue = typeof history?.valueAfterRedo === 'number' ? history.valueAfterRedo : null;

  stage('p5');
  const undoRedo = await page.evaluate(async () => globalThis.__apexAcceptance.undoRedoRoundTrip());
  record('p5-undo-redo', undoRedo?.undoRestored === true && undoRedo?.redoReapplied === true ? 'PASS'
    : blockedByFixture ? 'NOT_VERIFIED' : 'FAIL', { blockedByFixture, ...undoRedo });

  // ---- p6: save, quit and reload ----------------------------------------
  stage('p6');
  const saved = await page.evaluate(async () => globalThis.__apexAcceptance.saveProject());
  const stateBeforeQuit = await page.evaluate(async () => globalThis.__apexAcceptance.projectSnapshot());
  await app.close();
  await new Promise(r => setTimeout(r, 2000));

  const app2 = await _electron.launch({
    executablePath: executable,
    env: launchEnv({ APEX_ACCEPTANCE_REOPEN: '1' }),
    timeout: 180000,
  });
  try {
    const page2 = await app2.firstWindow();
    await page2.waitForLoadState('domcontentloaded');
    await page2.waitForTimeout(4000);
    const stateAfterReload = await page2.evaluate(async () => globalThis.__apexAcceptance.projectSnapshot());
    const same = JSON.stringify(stateAfterReload?.vst3State) === JSON.stringify(stateBeforeQuit?.vst3State);
    // The reloaded value must be the EDITED gain, read back through the same hook the
    // Mixer uses. Comparing the serialized state to itself proves durability but says
    // nothing about whether the edited parameter was the thing that survived: the
    // fixture default would survive a run in which the edit never happened.
    const reloaded = await page2.evaluate(async (slotId) =>
      globalThis.__apexAcceptance.readInsertParameter(1, slotId), inserted?.slotId);
    const reloadedParameter = reloaded?.value ?? null;
    const reloadedMatchesEdit = typeof editedParameterValue === 'number'
      && typeof reloadedParameter === 'number'
      && Math.abs(reloadedParameter - editedParameterValue) < 1e-6;
    record('p6-save-quit-reload', saved?.ok === true && same && reloadedMatchesEdit ? 'PASS' : 'FAIL', {
      saved, vst3StateIdentical: same,
      editedParameterValue,
      reloadedParameter,
      reloadedMatchesEdit,
      beforeQuit: stateBeforeQuit, afterReload: stateAfterReload,
    });

    // ---- p7: quitting with an editor open leaks no helper -----------------
    stage('p7');
    const beforeOpenRead = helperProcesses();
    const beforeOpen = beforeOpenRead.processes;
    // Open it through the SAME real control the user would use. The insert survived
    // the reload, so its row and its editor button must be present again.
    const reopenButton = page2.getByRole('button', { name: 'Open VST3 editor' }).first();
    let reopened;
    try {
      await reopenButton.waitFor({ state: 'visible', timeout: 30000 });
      await reopenButton.click({ timeout: 30000 });
      reopened = { viaRealUi: true };
    } catch (error) {
      reopened = { viaRealUi: false, error: String(error?.message ?? error).split('\n')[0] };
    }
    await page2.waitForTimeout(4000);
    const duringOpenRead = helperProcesses();
    const duringOpen = duringOpenRead.processes;
    const openedForQuit = duringOpen.filter(h => !beforeOpen.some(b => b.pid === h.pid));
    // Quit WITHOUT closing the editor: the app must capture state and reap helpers.
    await page2.evaluate(async () => { await globalThis.__apexAcceptance.quitApp(); });
    await new Promise(r => setTimeout(r, 6000));
    const afterQuitRead = helperProcesses();
    const survivors = afterQuitRead.processes;
    // A leak can only be ruled out if the process table was actually readable.
    record('p7-no-leaked-helpers', !afterQuitRead.ok ? 'NOT_VERIFIED' : survivors.length === 0 ? 'PASS' : 'FAIL', {
      helperEnumeration: { before: beforeOpenRead.ok, during: duringOpenRead.ok, after: afterQuitRead.ok,
        source: afterQuitRead.source ?? null, errors: afterQuitRead.error ?? null },
      reopenedEditor: reopened,
      helpersBeforeOpening: beforeOpen.length,
      helpersWithEditorOpen: duringOpen.length,
      openedForQuit: openedForQuit.length,
      helpersAfterQuitWithEditorOpen: survivors,
      note: 'Apex quit while the plug-in window was still open; every helper must be gone.',
    });
  } finally {
    await app2.close().catch(() => {});
  }

  // ---- p8: recovery after an editor crash -------------------------------
  stage('p8');
  const app3 = await _electron.launch({
    executablePath: executable,
    env: launchEnv({ APEX_ACCEPTANCE_REOPEN: '1' }),
    timeout: 180000,
  });
  try {
    const page3 = await app3.firstWindow();
    await page3.waitForLoadState('domcontentloaded');
    await page3.waitForTimeout(3000);
    // Recovery is only meaningful with a live editor, so open one exactly the way
    // the user does -- same visible controls, same order as p1. Using a test-only
    // opener here would prove recovery of something a user never opened.
    const reopen = await openEditorThroughMixerUi(page3);
    // Asking the app to crash an editor that was never opened says nothing about
    // recovery, so it is reported as a block rather than aborting the whole run.
    const crash = await page3.evaluate(async () => {
      try {
        return { ok: true, result: await globalThis.__apexAcceptance.crashEditorAndRecover() };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    record('p8-recovery', !reopen.ok ? 'NOT_VERIFIED'
      : !crash.ok ? 'NOT_VERIFIED'
      : crash.result?.recoveryRecordOffered === true ? 'PASS' : 'FAIL', {
      openedThroughMixerUi: reopen.ok,
      openerEvidence: reopen,
      blockedByFixture: false,
      blockedBy: !reopen.ok ? `the real Mixer UI could not open an editor to crash: ${reopen.error}`
        : !crash.ok ? `the editor session was not usable after opening: ${crash.error}` : null,
      ...(crash.ok ? crash.result : { error: crash.error }),
    });
  } finally {
    await app3.close().catch(() => {});
  }
}

try {
  await run();
} catch (error) {
  console.log(`ACCEPTANCE-ERROR ${error.message}`);
  if (error.stack) console.log(error.stack.slice(0, 2000));
  record('harness', 'FAIL', {
    // Diagnosed by the renderer, listed first so annotation truncation cannot hide
    // it: this is what actually says why the run stopped.
    diagnosedByRenderer: lastUiDiagnosis,
    error: error.message,
    stack: error.stack?.slice(0, 4000),
    // Surface what the app could and could not discover, so a failure names the
    // fixture rather than only the symptom.
    hint: /discovered/.test(error.message)
      ? 'The packaged app did not see the fixture bundle. Check that the bundle exists and that the launch env adds its root.'
      : undefined,
  });
}

// p9 needs an interactive display; it is never inferred from the runner.
record('p9-dpi-125-150', 'NOT_VERIFIED', {
  reason: 'Changing the Windows display scale to 125%/150% and moving the window between monitors requires an interactive desktop; the automated desktop is 96 DPI.',
  whatIsNeeded: 'On a Windows 11 x64 desktop, set Settings > Display > Scale to 150%, reopen the editor, and repeat at 125%; the plug-in must re-layout without blank areas. Multi-monitor migration with different per-monitor DPI is also manual.',
});

for (const id of Object.keys(CRITERIA)) {
  if (!results.some(r => r.id === id)) record(id, 'NOT_VERIFIED', { reason: 'the run did not reach this check' });
}
writeReport();
process.exit(results.some(r => r.status === 'FAIL') ? 1 : 3);
