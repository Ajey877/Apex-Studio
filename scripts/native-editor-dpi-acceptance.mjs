#!/usr/bin/env node
// P9 -- native VST3 editor high-DPI and multi-monitor acceptance.
//
// WHAT THIS PROVES, AND HOW
//
// Every result here comes from a real Windows desktop whose display scale really
// is the value under test. The script changes the scale the way the Settings app
// does (scripts/windows-display-scale.ps1), so Windows itself reports the new DPI
// to the helper process and Windows itself sends WM_DPICHANGED to the editor
// window. Nothing in this file posts a DPI message, mocks a DPI value or sets a
// content-scale factor by hand: the only inputs are the display configuration and
// real OS input (SendInput), and every check reads back what Windows and the
// plug-in then report.
//
// WHAT IT DOES NOT PROVE
//
// * A configuration that was not executed is recorded NOT_VERIFIED, never PASS.
// * Multi-monitor cases (P9-D, P9-E, P9-F) need two monitors. With one monitor
//   they are NOT_VERIFIED no matter how the single-monitor cases went.
// * Off Windows x64 nothing is verified at all.
//
// MODES
//
//   APEX_P9_ALLOW_DISPLAY_CHANGES=1  the script changes the display scale itself
//                                    (CI, or a tester who accepts that). It
//                                    restores the original configuration when it
//                                    ends, and that restoration is part of the
//                                    verdict (see below).
//   (unset)                          attended: only the display configuration that
//                                    is ALREADY set is tested; change the scale in
//                                    Settings and run again for the next one.
//
// DISPLAY RESTORATION IS PART OF THE VERDICT
//
// The display configuration (per display: resolution, position, DPI, scale) is
// recorded before anything is changed. When the run ends -- normally, after a
// failed case, after an exception, or on an interrupt -- it is put back, read back
// from Windows and compared with the record. The result is `restoration` in the
// evidence file. If the configuration is not back, the verdict is FAIL and the
// exit code is 1, whatever the cases themselves reported.
//
// Exit codes: 0 every case PASS and the display restored; 1 any FAIL, or the
// display was not restored; 2 cannot run here; 3 some NOT_VERIFIED.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeVst3Client, discoverVst3 } from '../native/vst3/client.mjs';
import { acceptanceVerdict, describeRestoration, restoreDisplayConfiguration, snapshotDisplayConfiguration } from './display-restoration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const outDir = path.resolve(process.env.APEX_P9_OUT ?? 'build/native-evidence/p9');
const outPath = path.join(outDir, 'p9-dpi-acceptance.json');
const hostLabel = process.env.APEX_P9_HOST_LABEL ?? 'working-tree';
const allowDisplayChanges = process.env.APEX_P9_ALLOW_DISPLAY_CHANGES === '1';
const wantedScales = (process.env.APEX_P9_SCALES ?? '100,125,150').split(',').map(Number).filter(Boolean);
const displayTool = path.join(here, 'windows-display-scale.ps1');
const WINDOW_CLASS = 'ApexStudioVst3EditorHostWindow';

/** The acceptance matrix. `needs` lists the configurations that must all have run. */
const CASES = {
  'P9-A': { title: 'Single monitor at 100%: editor creation and display', needs: ['single-100'] },
  'P9-B': { title: 'Single monitor at 125%: dimensions and rendering', needs: ['single-125'] },
  'P9-C': { title: 'Single monitor at 150%: dimensions and rendering', needs: ['single-150'] },
  'P9-D': { title: 'Dual monitors 100% + 125%: positioning and scaling', needs: ['dual-100-125'] },
  'P9-E': { title: 'Dual monitors 100% + 150%: positioning and scaling', needs: ['dual-100-150'] },
  'P9-F': { title: 'Move editor between monitors with different DPI', needs: ['dual-move'] },
  'P9-G': { title: 'Resize at different DPI levels and VST3 size constraints', needs: ['single-100', 'single-125', 'single-150'] },
  'P9-H': { title: 'Close and reopen: no stale HWND, leak or lifecycle failure', needs: ['single-100', 'single-125', 'single-150'] },
  'P9-I': { title: 'Keyboard, mouse wheel and focus forwarding', needs: ['single-100', 'single-125', 'single-150'] },
  'P9-J': { title: 'Capture plug-in state and destroy window: state preserved', needs: ['single-100', 'single-125', 'single-150'] },
  // Added because the real requirement demands them (docs/VST3-EDITOR-ACCEPTANCE.md):
  'P9-K': { title: 'Display scale changed while the editor is open (real WM_DPICHANGED)', needs: ['live-scale'] },
  'P9-L': { title: 'Plug-in without content-scale support at 150%', needs: ['no-content-scale'] },
  'P9-M': { title: 'Fixed-size (non-resizable) editor across a real DPI change', needs: ['fixed-size'] },
};

/** runs[caseId] = [{ config, status, checks, evidence }] */
const runs = Object.fromEntries(Object.keys(CASES).map(id => [id, []]));
const notes = [];
/** Exceptions that escaped a pass. Kept apart from `notes`: they are machine-read. */
const harnessErrors = [];
const screenshots = [];
const stage = (name, detail = {}) => console.log(`STAGE ${name} ${JSON.stringify(detail)}`);

function recordRun(caseId, config, checks, evidence = {}) {
  const executed = checks.filter(c => c.ok !== null);
  const status = checks.some(c => c.ok === false) ? 'FAIL'
    : (executed.length === 0 || checks.some(c => c.ok === null)) ? 'NOT_VERIFIED' : 'PASS';
  runs[caseId].push({ config, status, checks, evidence });
  const failed = checks.filter(c => c.ok === false).map(c => c.name);
  const skipped = checks.filter(c => c.ok === null).map(c => c.name);
  console.log(`P9-RUN ${caseId} ${config} ${status}${failed.length ? ` failed=${failed.join(',')}` : ''}${skipped.length ? ` notExecuted=${skipped.join(',')}` : ''}`);
  return status;
}
function skipRun(caseId, config, reason) {
  runs[caseId].push({ config, status: 'NOT_VERIFIED', checks: [], evidence: { reason } });
  console.log(`P9-RUN ${caseId} ${config} NOT_VERIFIED ${reason}`);
}

/** A check list with terse helpers. `ok: null` means "could not be executed". */
function checklist() {
  const list = [];
  return {
    list,
    is(name, ok, detail = {}) { list.push({ name, ok: Boolean(ok), ...detail }); return Boolean(ok); },
    equal(name, actual, expected, detail = {}) {
      list.push({ name, ok: actual === expected, actual, expected, ...detail });
      return actual === expected;
    },
    near(name, actual, expected, tolerance, detail = {}) {
      const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
      list.push({ name, ok, actual, expected, tolerance, ...detail });
      return ok;
    },
    notExecuted(name, reason) { list.push({ name, ok: null, reason }); },
  };
}

function caseStatus(id) {
  const all = runs[id];
  const needed = CASES[id].needs;
  if (all.some(run => run.status === 'FAIL')) return 'FAIL';
  const covered = needed.every(config => all.some(run => run.config === config && run.status === 'PASS'));
  return covered ? 'PASS' : 'NOT_VERIFIED';
}

function writeReport(extra = {}) {
  const statuses = Object.fromEntries(Object.keys(CASES).map(id => [id, caseStatus(id)]));
  // The cases say whether the editor behaved; the restoration says whether the
  // machine was left as it was found. The verdict needs both.
  const { verdict, reasons: verdictReasons, exitCode } = acceptanceVerdict({ statuses, restoration: extra.restoration, blocked: extra.blocked });
  // `environment` is merged below; spreading it again would replace the merge.
  const { environment: extraEnvironment, ...rest } = extra;
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    host: hostLabel,
    commit: process.env.GITHUB_SHA ?? null,
    // Git tree of native/vst3 that the helper under test was built from, when the
    // caller states it (CI does). It tells a baseline build from the current one.
    nativeSourceTree: process.env.APEX_P9_NATIVE_TREE || null,
    verdict,
    verdictReasons,
    exitCode,
    restoration: null,
    harnessErrors,
    environment: {
      platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version,
      isCi: Boolean(process.env.CI), runnerImage: process.env.ImageOS ?? null,
      runnerImageVersion: process.env.ImageVersion ?? null,
      displayChangesAllowed: allowDisplayChanges,
      ...extraEnvironment,
    },
    rule: 'A case is PASS only when every configuration it needs was executed on this machine and every check passed. Anything not executed is NOT_VERIFIED.',
    statuses,
    cases: Object.keys(CASES).map(id => ({
      id, title: CASES[id].title, status: statuses[id], needs: CASES[id].needs,
      missing: CASES[id].needs.filter(config => !runs[id].some(run => run.config === config && run.status === 'PASS')),
      runs: runs[id],
    })),
    notes,
    screenshots,
    ...rest,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  const summary = `P9-SUMMARY ${JSON.stringify({ host: hostLabel, verdict, statuses,
    displayRestored: report.restoration ? report.restoration.ok === true : null, harnessErrors: harnessErrors.length })}`;
  console.log(summary);
  const restorationLine = `P9-RESTORATION ${describeRestoration(report.restoration)}`;
  console.log(restorationLine);
  if (report.restoration && report.restoration.ok !== true) {
    console.log(`P9-RESTORATION-DETAIL ${JSON.stringify({ differences: report.restoration.differences, steps: report.restoration.steps, errors: report.restoration.errors }).slice(0, 3600)}`);
  }
  const failures = [];
  for (const entry of report.cases) {
    for (const run of entry.runs) {
      const failed = run.checks.filter(c => c.ok === false);
      if (!failed.length) continue;
      failures.push(`P9-FAIL-DETAIL ${JSON.stringify({ case: entry.id, config: run.config, failed }).slice(0, 3600)}`);
    }
  }
  for (const line of failures) console.log(line);
  // The measurements themselves, so the record does not depend on a log or an
  // artifact being retrievable: what Windows reported for the window at each step.
  const measured = [];
  for (const entry of report.cases) {
    for (const run of entry.runs) {
      const d = run.evidence?.diagnostics;
      if (d) measured.push(`${entry.id} ${run.config}: dpi=${d.dpi} client=${d.clientWidth}x${d.clientHeight} view=${d.viewWidth}x${d.viewHeight} outer=${d.windowWidth}x${d.windowHeight} scale=${d.contentScale?.appliedFactor} awareness=${d.dpiAwareness?.windowContext ?? 'n/a'}`);
      for (const t of run.evidence?.transitions ?? []) {
        measured.push(`${entry.id} live ->${t.percent}%: dpi=${t.dpi} client=${t.client.join('x')} view=${t.view.join('x')} windowsSuggestedOuter=${t.suggested.join('x')} source=${t.scaleFit?.source ?? 'n/a'}`);
      }
    }
  }
  for (const line of measured) console.log(`P9-MEASURED ${line}`);
  if (process.env.GITHUB_ACTIONS) {
    // Check-run annotations are the one channel that is always readable. They are
    // capped at 10 per step and 4096 characters each, so the verdict goes first.
    const encode = text => text.slice(0, 4000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    const note = (title, text) => console.log(`::notice title=${title}::${encode(text)}`);
    // Verdict, restoration and (if it failed) what is still wrong, in one annotation.
    note(`P9-SUMMARY ${hostLabel}`, [summary, restorationLine,
      ...(verdictReasons.length ? [`verdict reasons: ${verdictReasons.join(' | ')}`] : []),
      ...(harnessErrors.length ? [`harness errors: ${harnessErrors.map(e => `${e.where}: ${e.message}`).join(' | ')}`] : []),
    ].join('\n'));
    note(`P9-RUNS ${hostLabel}`, report.cases.flatMap(entry => entry.runs.map(run => {
      const failed = run.checks.filter(c => c.ok === false).map(c => c.name);
      const skipped = run.checks.filter(c => c.ok === null).map(c => c.name);
      return `${entry.id} ${run.config} ${run.status} (${run.checks.filter(c => c.ok === true).length}/${run.checks.length} checks)` +
        `${failed.length ? ` failed=${failed.join(',')}` : ''}${skipped.length ? ` notExecuted=${skipped.join(',')}` : ''}` +
        `${run.checks.length ? '' : ` ${run.evidence?.reason ?? ''}`}`;
    })).join('\n'));
    if (measured.length) note(`P9-MEASURED ${hostLabel}`, measured.join('\n'));
    if (notes.length) note(`P9-NOTES ${hostLabel}`, notes.join('\n'));
    for (const line of failures.slice(0, 5)) note(`P9-FAIL-DETAIL ${hostLabel}`, line);
  }
  return report;
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  notes.push(`Requires a Windows x64 host; this is ${process.platform}/${process.arch}. Nothing was verified.`);
  writeReport({ blocked: 'not-a-windows-x64-host' });
  process.exit(2);
}
const executable = [`${build}/bin/apex-vst3-host.exe`, `${build}/bin/Release/apex-vst3-host.exe`].find(existsSync);
if (!executable) {
  notes.push('The native helper is not built (npm run native:vst3:build). Nothing was verified.');
  writeReport({ blocked: 'helper-not-built' });
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Display control and observation (real Windows display configuration)
// ---------------------------------------------------------------------------
const shell = (() => {
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (probe.status === 0) return candidate;
  }
  return 'powershell.exe';
})();

function display(action, args = {}) {
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', displayTool, '-Action', action];
  for (const [key, value] of Object.entries(args)) argv.push(`-${key}`, String(value));
  const result = spawnSync(shell, argv, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const line = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  try { return JSON.parse(line); }
  catch { throw new Error(`display tool ${action} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(-600)}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const primaryOf = state => state.monitors.find(m => m.primary) ?? state.monitors[0];

/** Set the primary display's scale and confirm Windows reports it. */
let primarySourceIndex = null;
function setPrimaryScale(percent) {
  if (primarySourceIndex === null) {
    const before = display('query');
    primarySourceIndex = Math.max(0, before.sources.findIndex(s => s.device === primaryOf(before).device));
  }
  const changed = display('set-scale', { Scale: percent, Monitor: primarySourceIndex });
  const after = changed.after ?? display('query');
  const dpi = primaryOf(after).effectiveDpi;
  return { ok: dpi === Math.round(96 * percent / 100), percent, dpi, detail: changed.set, monitorCount: after.monitorCount };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
function findBundle(directory, name, depth = 0) {
  if (depth > 5) return undefined;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(directory, entry.name);
    if (entry.name.toLowerCase() === name.toLowerCase()) return full;
    const found = findBundle(full, name, depth + 1);
    if (found) return found;
  }
  return undefined;
}
const againBundle = findBundle(path.join(build, 'VST3'), 'again.vst3');
const again = againBundle
  ? (await discoverVst3(executable, [againBundle], { kind: 'effect' })).plugins.find(p => /^AGain( VST3)?$/.test(p.name))
  : undefined;
if (!again) {
  notes.push('The AGain VSTGUI editor fixture was not discovered. Nothing was verified.');
  writeReport({ blocked: 'again-not-discovered' });
  process.exit(2);
}
// AGain's own layout (public.sdk/samples/vst/again/resource/again.uidesc), in the
// plug-in's unscaled coordinates. The editor is fixed-size: minSize == maxSize.
const AGAIN = {
  base: { width: 350, height: 120 },
  slider: { left: 90, top: 90, width: 130, height: 18, handleWidth: 22 },
};
const emptyState = () => ({ schema: 1, classId: again.classId, parameters: [] });

async function openEditor({ state = emptyState(), testMode } = {}) {
  if (testMode) process.env.APEX_VST3_EDITOR_TEST_MODE = testMode;
  else delete process.env.APEX_VST3_EDITOR_TEST_MODE;
  const client = new NativeVst3Client(executable, { timeoutMs: 45000 });
  delete process.env.APEX_VST3_EDITOR_TEST_MODE;
  try {
    const opened = (await client.openEditor({ path: again.path, classId: again.classId, state })).editor;
    const diag = await client.editorDiagnostics(again.classId);
    return { client, opened, diag };
  } catch (error) {
    await client.dispose().catch(() => {});
    throw error;
  }
}
const diagnose = session => session.client.editorDiagnostics(again.classId);
const action = (session, name, fields = {}) => session.client.editorTestAction(name, { classId: again.classId, ...fields });
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitForExit(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!processAlive(pid)) return true; await sleep(100); }
  return !processAlive(pid);
}
const gainOf = parameters => (parameters ?? []).find(p => /gain/i.test(p.name ?? ''));

/** Every live editor host window on the desktop, or null if that cannot be read. */
function editorWindows() {
  try { return display('find-windows', { WindowClass: WINDOW_CLASS }).windows ?? []; }
  catch (error) { notes.push(`find-windows failed: ${error.message.slice(0, 200)}`); return null; }
}

/** Window handle: reported by the helper, or found from its process on older builds. */
function windowHandle(diag) {
  if (diag.hwnd) return Number(diag.hwnd);
  return Number((editorWindows() ?? []).find(w => w.processId === diag.processId)?.hwnd ?? 0);
}

let referenceClientPng = null;
/** Capture what is really on screen for the editor window and measure it. */
function capture(session, diag, name, checks, { compareToReference = true, isReference = false, fillsClient = true } = {}) {
  const hwnd = windowHandle(diag);
  if (!hwnd) { checks.notExecuted('screenshot', 'window handle not found'); return null; }
  const file = path.join(outDir, `${hostLabel}-${name}.png`);
  let shot;
  try { shot = display('screenshot', { Hwnd: hwnd, Out: file }); }
  catch (error) { checks.notExecuted('screenshot', error.message.slice(0, 200)); return null; }
  screenshots.push({ name, file: path.basename(file), client: shot.clientOut ? path.basename(shot.clientOut) : null,
    bounds: shot.bounds, measured: shot.client ?? null });
  if (!shot.written || !shot.client) { checks.notExecuted('rendered-not-blank', 'screenshot was not written'); return shot; }
  // A blank or unpainted editor is one flat colour. AGain's background bitmap,
  // labels and slider give dozens of colours when it has really drawn itself.
  checks.is('rendered-not-blank', shot.client.distinctColours >= 8 && shot.client.dominantColourFraction < 0.95, {
    distinctColours: shot.client.distinctColours, dominantColourFraction: shot.client.dominantColourFraction });
  // Content must reach the right and bottom edges of the client area. An editor
  // drawn at the wrong scale leaves those strips as flat, unpainted background.
  // (Not asked of a window the harness forced larger than a fixed-layout editor.)
  if (fillsClient) checks.is('content-reaches-edges', shot.client.distinctColoursInRightStrip >= 2 && shot.client.distinctColoursInBottomStrip >= 2, {
    rightStripColours: shot.client.distinctColoursInRightStrip, bottomStripColours: shot.client.distinctColoursInBottomStrip });
  if (isReference && shot.clientOut) referenceClientPng = shot.clientOut;
  else if (compareToReference && referenceClientPng && shot.clientOut) {
    let compared;
    try { compared = display('compare', { A: referenceClientPng, B: shot.clientOut }); }
    catch (error) { checks.notExecuted('layout-matches-100-percent', error.message.slice(0, 200)); return shot; }
    // Same editor, same layout, only larger: resampled to a common grid the two
    // images agree closely. A mis-scaled layout does not.
    checks.is('layout-matches-100-percent', compared.meanAbsDifference <= 16, {
      meanAbsDifference: compared.meanAbsDifference, maxCellDifference: compared.maxCellDifference,
      limit: 16, sizes: `${compared.aSize} vs ${compared.bSize}` });
  }
  return shot;
}

/** Size and placement checks shared by every "editor at DPI" observation. */
function sizeChecks(checks, diag, { dpi, pluginScale, expectedClient, label = '' }) {
  const prefix = label ? `${label}:` : '';
  checks.equal(`${prefix}window-dpi`, Number(diag.dpi), dpi);
  if (diag.monitor?.dpi !== undefined) checks.equal(`${prefix}monitor-dpi`, Number(diag.monitor.dpi), dpi);
  if (diag.dpiAwareness?.windowContext !== undefined)
    checks.equal(`${prefix}window-is-per-monitor-v2`, diag.dpiAwareness.windowContext, 'per-monitor-v2');
  checks.near(`${prefix}client-width`, Number(diag.clientWidth), expectedClient.width, 1);
  checks.near(`${prefix}client-height`, Number(diag.clientHeight), expectedClient.height, 1);
  // The plug-in and the window must agree exactly on the size.
  checks.equal(`${prefix}view-width-equals-client`, Number(diag.viewWidth), Number(diag.clientWidth));
  checks.equal(`${prefix}view-height-equals-client`, Number(diag.viewHeight), Number(diag.clientHeight));
  const children = diag.childWindows ?? [];
  checks.is(`${prefix}plugin-window-covers-client`, children.some(c => c.visible &&
    c.width === diag.clientWidth && c.height === diag.clientHeight), { children, client: [diag.clientWidth, diag.clientHeight] });
  if (pluginScale !== undefined) {
    checks.near(`${prefix}content-scale-factor`, Number(diag.contentScale?.appliedFactor), dpi / 96, 0.001);
  }
  if (diag.frame) {
    // The frame around the client area must be the frame Windows uses at THIS DPI.
    checks.equal(`${prefix}frame-width-for-dpi`, diag.frame.actualWidth, diag.frame.expectedWidthForWindowDpi);
    checks.equal(`${prefix}frame-height-for-dpi`, diag.frame.actualHeight, diag.frame.expectedHeightForWindowDpi);
  }
  if (diag.windowRect && diag.monitor?.width) {
    const m = diag.monitor, r = diag.windowRect;
    // Allow the invisible resize border to hang over the edge; the body must be on the monitor.
    checks.is(`${prefix}window-on-its-monitor`, r.left >= m.left - 16 && r.top >= m.top - 16 &&
      r.right <= m.left + m.width + 16 && r.bottom <= m.top + m.height + 16, { windowRect: r, monitor: m });
  }
  checks.equal(`${prefix}visible`, diag.visible, true);
  checks.equal(`${prefix}not-minimised`, diag.iconic, false);
}
const scaled = (size, factor) => ({ width: Math.floor(size.width * factor), height: Math.floor(size.height * factor) });

/** Click AGain's Gain slider at a fraction of its travel, with real mouse input. */
async function clickSlider(session, fraction, pluginScale) {
  const s = AGAIN.slider;
  const x = Math.round((s.left + s.handleWidth / 2 + fraction * (s.width - s.handleWidth)) * pluginScale);
  const y = Math.round((s.top + s.height / 2) * pluginScale);
  await session.client.pollEditor();
  await session.client.sendEditorMouse('move', { x, y, classId: again.classId });
  const down = await session.client.sendEditorMouse('down', { x, y, classId: again.classId });
  await session.client.sendEditorMouse('move', { x: x + 1, y, classId: again.classId });
  await session.client.sendEditorMouse('up', { x: x + 1, y, classId: again.classId });
  await sleep(120);
  const polled = await session.client.pollEditor();
  const gainId = gainOf(session.opened.parameters)?.id;
  const performed = (polled.events ?? []).filter(e => e.type === 'perform' && e.id === gainId);
  const edited = (polled.editedParameters ?? []).find(p => p.id === gainId);
  return { point: { x, y }, screenPoint: down.screenPoint, hitIsChildWindow: down.hitIsChildWindow,
    hitWindowClass: down.hitWindowClass, pressAccepted: down.postedCount ?? 0, buttonHeld: down.buttonHeldAfter,
    value: performed.at(-1)?.value ?? edited?.value ?? null, performEvents: performed.length };
}

/** P9-I at one scale: keyboard, mouse (pointer and wheel) and focus. */
async function inputChecks(session, checks, pluginScale) {
  // Keyboard, by receipt: SendInput accepted, WndProc saw it, the view was called.
  const keyDown = await action(session, 'keyDown', { vk: 0x09 });
  const keyUp = await action(session, 'keyUp', { vk: 0x09 });
  checks.equal('keyboard:sendinput-accepted', (keyDown.sendInputAccepted ?? 0) + (keyUp.sendInputAccepted ?? 0), 2);
  checks.is('keyboard:window-received', (keyDown.observation?.keyDownMessageCount ?? 0) > 0 &&
    (keyUp.observation?.keyUpMessageCount ?? 0) > 0);
  checks.equal('keyboard:view-onKeyDown-calls', keyDown.observation?.viewKeyDownCount ?? 0, 1);
  checks.equal('keyboard:view-onKeyUp-calls', keyUp.observation?.viewKeyUpCount ?? 0, 1);
  checks.equal('keyboard:keycode-is-tab', keyDown.observation?.viewKeyDownKeycode, 2);

  // Mouse: a real click on the Gain slider at a known fraction of its travel. The
  // value the PLUG-IN reports back is the proof that the pointer landed where it
  // was aimed -- at a wrong scale the click lands elsewhere and the value is wrong.
  const low = await clickSlider(session, 0.25, pluginScale);
  checks.is('mouse:click-hit-plugin-window', low.hitIsChildWindow === true, { hitWindowClass: low.hitWindowClass });
  checks.is('mouse:press-delivered', low.pressAccepted >= 1 && low.buttonHeld === true);
  checks.near('mouse:slider-value-at-25-percent', low.value, 0.25, 0.06, { point: low.point, screenPoint: low.screenPoint });
  const high = await clickSlider(session, 0.8, pluginScale);
  checks.near('mouse:slider-value-at-80-percent', high.value, 0.8, 0.06, { point: high.point, screenPoint: high.screenPoint });

  // Wheel at the centre of the editor: either the host window received it and
  // forwarded it to IPlugView::onWheel, or the plug-in's own child window owns the
  // point and Windows delivered it there directly.
  const live = await diagnose(session);
  const centre = { x: Math.round(live.clientWidth / 2), y: Math.round(live.clientHeight / 2) };
  await session.client.sendEditorMouse('move', { ...centre, classId: again.classId });
  const wheel = await session.client.sendEditorMouse('wheel', { ...centre, classId: again.classId });
  const pathA = (wheel.wheelMessageCount ?? 0) > 0 && (wheel.viewWheelCount ?? 0) > 0 &&
    Math.abs((wheel.viewWheelDelta ?? 0) - (wheel.lastInjectedWheelDelta ?? 0) / 120) < 1e-6;
  const pathB = (wheel.wheelMessageCount ?? 0) === 0 && wheel.hitIsChildWindow === true && wheel.sendInputCount === 1;
  checks.is('wheel:delivered', pathA || pathB, { path: pathA ? 'host -> IPlugView::onWheel' : pathB ? 'OS -> plug-in child window' : null,
    sendInputAccepted: wheel.sendInputCount, hitIsChildWindow: wheel.hitIsChildWindow, screenPoint: wheel.screenPoint });

  // Focus: gain, loss to a real second window, regain.
  const before = await diagnose(session);
  const gain = (await action(session, 'focus')).diagnostics;
  const loss = await action(session, 'loseFocus');
  const afterLoss = loss.diagnostics;
  const regain = (await action(session, 'focus')).diagnostics;
  await action(session, 'destroyFocusSink');
  checks.is('focus:gained', gain.focus?.state === 1 && gain.focus?.windowOwnsFocus === true,
    { gainCountBefore: before.focus?.gainCount, gainCount: gain.focus?.gainCount });
  checks.is('focus:lost-to-another-window', loss.focusSinkOwnsFocus === true && afterLoss.focus?.state === 0 &&
    afterLoss.focus?.lossCount === (gain.focus?.lossCount ?? 0) + 1);
  checks.is('focus:regained', regain.focus?.state === 1 && regain.focus?.gainCount === (afterLoss.focus?.gainCount ?? 0) + 1);
  return { lastSliderValue: high.value };
}

/** P9-G at one scale: programmatic resize, then an interactive border drag. */
async function resizeChecks(session, checks, { factor, restingClient }) {
  const target = { width: Math.round(640 * factor), height: Math.round(420 * factor) };
  const resized = (await action(session, 'resizeClient', target)).diagnostics;
  checks.equal('resize:client-width', Number(resized.clientWidth), target.width);
  checks.equal('resize:client-height', Number(resized.clientHeight), target.height);
  checks.is('resize:view-equals-client', resized.viewWidth === resized.clientWidth && resized.viewHeight === resized.clientHeight,
    { view: [resized.viewWidth, resized.viewHeight], client: [resized.clientWidth, resized.clientHeight] });
  checks.is('resize:plugin-window-covers-client', (resized.childWindows ?? []).some(c =>
    c.width === resized.clientWidth && c.height === resized.clientHeight));
  const restored = (await action(session, 'resizeClient', restingClient)).diagnostics;
  checks.is('resize:restored', restored.clientWidth === restingClient.width && restored.clientHeight === restingClient.height,
    { client: [restored.clientWidth, restored.clientHeight], wanted: restingClient });

  // Interactive: a real mouse drag on the bottom-right sizing border. Windows runs
  // its own modal size loop and sends WM_SIZING; the host must ask the plug-in
  // (checkSizeConstraint) and honour the answer. AGain is fixed-size, so at this
  // scale the only size it grants is base x scale -- NOT the unscaled 350x120.
  if (!restored.windowRect) {
    checks.notExecuted('constraint:interactive-border-drag', 'this helper build has no pointerDrag action');
    return;
  }
  const r = restored.windowRect;
  const from = { x: r.right - 3, y: r.bottom - 3 };
  let drag;
  try {
    drag = await action(session, 'pointerDrag', { fromX: from.x, fromY: from.y,
      toX: from.x + Math.round(160 * factor), toY: from.y + Math.round(110 * factor), steps: 20, stepDelayMs: 15 });
  } catch (error) {
    checks.notExecuted('constraint:interactive-border-drag', error.message.slice(0, 160));
    return;
  }
  const after = drag.diagnostics;
  checks.is('constraint:real-input-accepted', drag.sendInputAccepted === drag.sendInputExpected && drag.buttonHeldDuringDrag === true,
    { accepted: drag.sendInputAccepted, expected: drag.sendInputExpected });
  checks.is('constraint:windows-size-loop-ran', drag.enteredSizeMove >= 1 && drag.exitedSizeMove >= 1 && drag.sizingMessages > 0,
    { sizingMessages: drag.sizingMessages, entered: drag.enteredSizeMove, exited: drag.exitedSizeMove });
  checks.is('constraint:plugin-was-asked', drag.constraintCalls > 0, { calls: drag.constraintCalls });
  const requested = after.sizing?.lastConstraintRequested ?? {};
  const granted = after.sizing?.lastConstraintGranted ?? {};
  checks.is('constraint:drag-asked-for-a-larger-size', requested.width > restingClient.width && requested.height > restingClient.height,
    { requested, restingClient });
  checks.near('constraint:granted-width-is-scaled-limit', granted.width, AGAIN.base.width * factor, 1, { granted });
  checks.near('constraint:granted-height-is-scaled-limit', granted.height, AGAIN.base.height * factor, 1, { granted });
  checks.is('constraint:window-kept-the-granted-size', after.clientWidth === granted.width && after.clientHeight === granted.height &&
    after.viewWidth === after.clientWidth && after.viewHeight === after.clientHeight,
    { client: [after.clientWidth, after.clientHeight], view: [after.viewWidth, after.viewHeight], granted });
}

/** One complete single-monitor pass at a real display scale. */
async function singleScalePass(percent) {
  const config = `single-${percent}`;
  const dpi = Math.round(96 * percent / 100);
  const factor = percent / 100;
  const expectedClient = scaled(AGAIN.base, factor);
  const openCase = { 100: 'P9-A', 125: 'P9-B', 150: 'P9-C' }[percent];
  stage('single-scale', { percent, dpi });

  // ---- A/B/C: cold open ------------------------------------------------------
  let session;
  const open = checklist();
  try {
    session = await openEditor();
  } catch (error) {
    open.is('editor-opened', false, { error: error.message });
    for (const id of [openCase, 'P9-G', 'P9-H', 'P9-I', 'P9-J'].filter(Boolean)) recordRun(id, config, open.list);
    return;
  }
  let captured = null;
  try {
    const { opened, diag } = session;
    open.is('editor-opened', opened.available === true && diag.windowCreated === true && diag.attached === true);
    open.is('plugin-reports-its-unscaled-size', opened.width === AGAIN.base.width && opened.height === AGAIN.base.height,
      { reported: [opened.width, opened.height] });
    open.is('content-scale-supported-and-applied', diag.contentScale?.supported === true && diag.contentScale?.applied === true,
      { contentScale: diag.contentScale });
    sizeChecks(open, diag, { dpi, pluginScale: factor, expectedClient });
    if (diag.dpiAwareness) open.equal('helper-dpi-awareness-request-succeeded', diag.dpiAwareness.requestSucceeded, true,
      { awareness: diag.dpiAwareness });
    captured = capture(session, diag, config, open, { isReference: percent === 100 });
    if (openCase) recordRun(openCase, config, open.list, { diagnostics: slim(diag), screenshot: captured?.out ? path.basename(captured.out) : null });

    // ---- I: input ------------------------------------------------------------
    const input = checklist();
    let lastValue = null;
    try { lastValue = (await inputChecks(session, input, factor)).lastSliderValue; }
    catch (error) { input.is('input-sequence-completed', false, { error: error.message }); }
    recordRun('P9-I', config, input.list);

    // ---- G: resize -----------------------------------------------------------
    const resize = checklist();
    try { await resizeChecks(session, resize, { factor, restingClient: { width: diag.clientWidth, height: diag.clientHeight } }); }
    catch (error) { resize.is('resize-sequence-completed', false, { error: error.message }); }
    recordRun('P9-G', config, resize.list);

    // ---- J: state capture, window destruction, state preserved ---------------
    const state = checklist();
    const helperPid = diag.processId;
    const hwnd = windowHandle(diag);
    const beforeClose = await diagnose(session);
    const closed = await session.client.closeEditor();
    const afterClose = await diagnose(session).catch(error => ({ error: error.message }));
    const gainId = gainOf(session.opened.parameters)?.id;
    const captured_ = (closed.state?.parameters ?? []).find(p => p.id === gainId);
    state.is('window-was-open-when-capture-began', beforeClose.visible === true);
    state.is('component-state-captured', typeof closed.state?.component === 'string' && closed.state.component.length > 0,
      { bytes: (closed.state?.component?.length ?? 0) / 2 });
    state.is('edited-gain-is-in-captured-state', captured_ !== undefined && lastValue !== null &&
      Math.abs(captured_.value - lastValue) < 1e-6, { captured: captured_?.value ?? null, lastEdited: lastValue });
    state.is('window-destroyed', afterClose.windowCreated === false || afterClose.closed === true, { afterClose: slim(afterClose) });
    const remaining = editorWindows();
    if (remaining === null) state.notExecuted('no-editor-window-left-for-the-helper', 'window enumeration failed');
    else state.equal('no-editor-window-left-for-the-helper', remaining.filter(w => w.processId === helperPid).length, 0, { hwnd });
    await session.client.dispose().catch(() => {});
    state.is('helper-process-exited', await waitForExit(helperPid), { pid: helperPid });
    session = null;
    // Reopen in a NEW helper from the captured state: the value must come back.
    let reopened;
    try {
      reopened = await openEditor({ state: closed.state });
      const restored = gainOf(reopened.opened.parameters)?.currentValue;
      state.is('state-restored-after-reopen', typeof restored === 'number' && lastValue !== null && Math.abs(restored - lastValue) < 1e-4,
        { restored, expected: lastValue });
      sizeChecks(state, reopened.diag, { dpi, pluginScale: factor, expectedClient, label: 'reopened' });
    } catch (error) {
      state.is('state-restored-after-reopen', false, { error: error.message });
    }
    recordRun('P9-J', config, state.list);

    // ---- H: close / reopen lifecycle ----------------------------------------
    const life = checklist();
    const pids = [];
    if (reopened) {
      pids.push(reopened.diag.processId);
      const shut = await action(reopened, 'closeFromWindow');
      life.is('reopened-editor-closed-by-WM_CLOSE', shut.diagnostics.closed === true);
      await reopened.client.dispose().catch(() => {});
    } else life.is('reopened-editor-closed-by-WM_CLOSE', false, { reason: 'reopen failed' });
    const cycles = [];
    for (let i = 0; i < 4; i++) {
      const cycle = await openEditor();
      pids.push(cycle.diag.processId);
      const sizeOk = Math.abs(cycle.diag.clientWidth - expectedClient.width) <= 1 &&
        Math.abs(cycle.diag.clientHeight - expectedClient.height) <= 1 && Number(cycle.diag.dpi) === dpi;
      const shut = await action(cycle, 'closeFromWindow');
      const polled = await cycle.client.pollEditor();
      cycles.push({ cycle: i + 1, pid: cycle.diag.processId, hwnd: cycle.diag.hwnd ?? null, visible: cycle.diag.visible === true,
        sizeOk, client: [cycle.diag.clientWidth, cycle.diag.clientHeight], closed: shut.diagnostics.closed === true,
        stateOnClose: typeof polled.state?.component === 'string', resources: cycle.diag.resources ?? null });
      await cycle.client.dispose().catch(() => {});
    }
    life.is('every-cycle-opened-at-the-right-size', cycles.every(c => c.visible && c.sizeOk), { cycles });
    life.is('every-cycle-closed-and-returned-state', cycles.every(c => c.closed && c.stateOnClose));
    const exited = [];
    for (const pid of pids) exited.push(await waitForExit(pid));
    life.is('every-helper-process-exited', exited.every(Boolean), { pids, exited });
    const windowsNow = editorWindows();
    if (windowsNow === null) life.notExecuted('no-stale-editor-windows', 'window enumeration failed');
    else {
      const leftovers = windowsNow.filter(w => pids.includes(w.processId) || w.processId === helperPid);
      life.equal('no-stale-editor-windows', leftovers.length, 0, { leftovers });
    }
    recordRun('P9-H', config, life.list, {
      note: 'A helper process hosts exactly one editor session, so "reopen" is a new helper. Stale state is therefore judged at the OS level: the window class has no surviving window and every helper process has exited.',
    });
  } catch (error) {
    notes.push(`single-${percent}: ${error.message}`);
    console.log(`P9-ERROR ${config} ${error.message}`);
  } finally {
    if (session) await session.client.dispose().catch(() => {});
  }
}

/** Keep the evidence file readable: the diagnostics that matter for DPI. */
function slim(diag) {
  if (!diag || typeof diag !== 'object') return diag;
  const keep = ['dpi', 'trackedWindowDpi', 'clientWidth', 'clientHeight', 'windowWidth', 'windowHeight', 'viewWidth', 'viewHeight',
    'visible', 'iconic', 'contentScale', 'dpiWindowObservation', 'childWindows', 'style', 'processId', 'hwnd', 'windowRect',
    'monitor', 'monitorCount', 'dpiAwareness', 'frame', 'scaleFit', 'sizing', 'testMode', 'resources', 'closed', 'windowCreated', 'error'];
  return Object.fromEntries(keep.filter(key => diag[key] !== undefined).map(key => [key, diag[key]]));
}

async function waitForDpi(session, dpi, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let diag = await diagnose(session);
  while (Number(diag.dpi) !== dpi && Date.now() < deadline) { await sleep(250); diag = await diagnose(session); }
  // Let the plug-in finish any repaint before the window is measured and captured.
  await sleep(400);
  return diagnose(session);
}

/** P9-K: the display scale changes while the editor is open. */
async function liveScalePass() {
  const config = 'live-scale';
  stage('live-scale', {});
  const checks = checklist();
  const start = setPrimaryScale(100);
  if (!start.ok) { skipRun('P9-K', config, `could not set 100%: ${JSON.stringify(start)}`); return; }
  let session;
  try {
    session = await openEditor();
    const base = { width: session.diag.clientWidth, height: session.diag.clientHeight };
    checks.is('opened-at-100', Number(session.diag.dpi) === 96 && base.width === AGAIN.base.width && base.height === AGAIN.base.height,
      { dpi: session.diag.dpi, base });
    let messages = session.diag.dpiWindowObservation?.dpiChangedMessageCount ?? 0;
    const transitions = [];
    let currentPercent = 100;
    for (const percent of [125, 150, 125, 100]) {
      const dpi = Math.round(96 * percent / 100);
      // A step that would not change the scale (because an earlier scale was not
      // available here) cannot produce a WM_DPICHANGED and proves nothing.
      if (percent === currentPercent) { checks.notExecuted(`to-${percent}:scale-change`, 'the display is already at this scale'); continue; }
      const set = setPrimaryScale(percent);
      if (!set.ok) { checks.notExecuted(`to-${percent}:scale-change`, JSON.stringify(set).slice(0, 200)); continue; }
      currentPercent = percent;
      const diag = await waitForDpi(session, dpi);
      const observed = diag.dpiWindowObservation ?? {};
      const label = `to-${percent}`;
      // The receipt that matters: Windows itself sent WM_DPICHANGED to the window.
      checks.is(`${label}:windows-sent-WM_DPICHANGED`, (observed.dpiChangedMessageCount ?? 0) > messages && observed.lastNewDpi === dpi,
        { before: messages, after: observed.dpiChangedMessageCount, lastNewDpi: observed.lastNewDpi });
      messages = observed.dpiChangedMessageCount ?? messages;
      sizeChecks(checks, diag, { dpi, pluginScale: percent / 100, expectedClient: scaled(AGAIN.base, percent / 100), label });
      capture(session, diag, `live-${transitions.length + 1}-to-${percent}`, checks);
      // Pointer input still lands where it is aimed after the transition.
      const click = await clickSlider(session, percent === 125 ? 0.3 : 0.7, percent / 100);
      checks.near(`${label}:slider-click-lands`, click.value, percent === 125 ? 0.3 : 0.7, 0.06, { point: click.point });
      transitions.push({ percent, dpi, client: [diag.clientWidth, diag.clientHeight], view: [diag.viewWidth, diag.viewHeight],
        suggested: [observed.suggestedWidth, observed.suggestedHeight], scaleFit: diag.scaleFit ?? null, frame: diag.frame ?? null });
    }
    // A window the HOST has sized must scale from ITS size, and come back to it.
    // This exercises the host's arithmetic only. AGain's layout is fixed, so the
    // editor stays at its own scaled size in the corner of the enlarged window:
    // the screenshot is kept as evidence but is not expected to be filled. A
    // genuinely resizable plug-in layout at high DPI is not covered by any fixture.
    const custom = { width: 640, height: 420 };
    await action(session, 'resizeClient', custom);
    let set = setPrimaryScale(150);
    if (set.ok) {
      const up = await waitForDpi(session, 144);
      checks.near('resized-window:width-at-150', Number(up.clientWidth), 960, 1);
      checks.near('resized-window:height-at-150', Number(up.clientHeight), 630, 1);
      checks.is('resized-window:view-equals-client-at-150', up.viewWidth === up.clientWidth && up.viewHeight === up.clientHeight,
        { view: [up.viewWidth, up.viewHeight], client: [up.clientWidth, up.clientHeight] });
      capture(session, up, 'live-resized-at-150', checks, { compareToReference: false, fillsClient: false });
      set = setPrimaryScale(100);
      if (set.ok) {
        const down = await waitForDpi(session, 96);
        checks.near('resized-window:width-back-at-100', Number(down.clientWidth), 640, 1);
        checks.near('resized-window:height-back-at-100', Number(down.clientHeight), 420, 1);
        checks.is('resized-window:view-equals-client-at-100', down.viewWidth === down.clientWidth && down.viewHeight === down.clientHeight);
      } else checks.notExecuted('resized-window:back-to-100', JSON.stringify(set).slice(0, 200));
    } else checks.notExecuted('resized-window:to-150', JSON.stringify(set).slice(0, 200));
    // The session survived every transition and still captures state on close.
    const closed = await session.client.closeEditor();
    checks.is('session-survived-and-captured-state', closed.closed === true && typeof closed.state?.component === 'string');
    recordRun('P9-K', config, checks.list, { transitions });
  } catch (error) {
    checks.is('live-scale-sequence-completed', false, { error: error.message });
    recordRun('P9-K', config, checks.list);
  } finally {
    if (session) await session.client.dispose().catch(() => {});
  }
}

/** P9-L: a plug-in that does not implement content scaling, on a 150% display. */
async function noContentScalePass() {
  const config = 'no-content-scale';
  stage('no-content-scale', {});
  const checks = checklist();
  const set = setPrimaryScale(150);
  if (!set.ok) { skipRun('P9-L', config, `could not set 150%: ${JSON.stringify(set)}`); return; }
  let session;
  try {
    session = await openEditor({ testMode: 'no-content-scale' });
    const diag = session.diag;
    if (diag.testMode?.ignoreContentScale !== true) {
      skipRun('P9-L', config, 'this helper build has no no-content-scale test mode');
      return;
    }
    checks.equal('window-dpi', Number(diag.dpi), 144);
    checks.equal('scale-interface-not-used', diag.contentScale?.supported, false);
    // The plug-in draws at its own pixel size; the window must fit it exactly, with
    // no blank margin, and with the frame Windows uses at 150%.
    checks.equal('client-width-is-plugin-pixels', Number(diag.clientWidth), AGAIN.base.width);
    checks.equal('client-height-is-plugin-pixels', Number(diag.clientHeight), AGAIN.base.height);
    checks.is('view-equals-client', diag.viewWidth === diag.clientWidth && diag.viewHeight === diag.clientHeight);
    checks.equal('frame-width-for-dpi', diag.frame?.actualWidth, diag.frame?.expectedWidthForWindowDpi);
    checks.equal('frame-height-for-dpi', diag.frame?.actualHeight, diag.frame?.expectedHeightForWindowDpi);
    capture(session, diag, 'no-content-scale-at-150', checks);
    const click = await clickSlider(session, 0.6, 1);
    checks.near('slider-click-lands-in-plugin-pixels', click.value, 0.6, 0.06, { point: click.point });
    // And across a real DPI change it must keep its own pixel size.
    const back = setPrimaryScale(100);
    if (back.ok) {
      const after = await waitForDpi(session, 96);
      checks.is('windows-sent-WM_DPICHANGED', (after.dpiWindowObservation?.dpiChangedMessageCount ?? 0) > 0);
      checks.equal('client-width-unchanged-after-dpi-change', Number(after.clientWidth), AGAIN.base.width);
      checks.equal('client-height-unchanged-after-dpi-change', Number(after.clientHeight), AGAIN.base.height);
      checks.equal('frame-width-for-new-dpi', after.frame?.actualWidth, after.frame?.expectedWidthForWindowDpi);
      checks.equal('frame-height-for-new-dpi', after.frame?.actualHeight, after.frame?.expectedHeightForWindowDpi);
      checks.equal('size-source', after.scaleFit?.source, 'plugin-reported');
    } else checks.notExecuted('dpi-change-150-to-100', JSON.stringify(back).slice(0, 200));
    recordRun('P9-L', config, checks.list, {
      note: 'AGain itself supports content scaling. This run uses the helper\'s acceptance switch (APEX_VST3_EDITOR_TEST_MODE=no-content-scale) so the host takes the path it takes for a plug-in WITHOUT IPlugViewContentScaleSupport. The display scale, the window and the plug-in view are real; a third-party plug-in that genuinely lacks the interface was not available.',
    });
  } catch (error) {
    checks.is('sequence-completed', false, { error: error.message });
    recordRun('P9-L', config, checks.list);
  } finally {
    if (session) await session.client.dispose().catch(() => {});
  }
}

/** P9-M: an editor treated as fixed-size, across a real DPI change. */
async function fixedSizePass() {
  const config = 'fixed-size';
  stage('fixed-size', {});
  const checks = checklist();
  const set = setPrimaryScale(100);
  if (!set.ok) { skipRun('P9-M', config, `could not set 100%: ${JSON.stringify(set)}`); return; }
  let session;
  try {
    session = await openEditor({ testMode: 'fixed-size' });
    const diag = session.diag;
    if (diag.testMode?.forceFixedSize !== true) {
      skipRun('P9-M', config, 'this helper build has no fixed-size test mode');
      return;
    }
    checks.equal('window-has-no-sizing-border', (Number(diag.style) & 0x40000) === 0, true, { style: `0x${Number(diag.style).toString(16)}` });
    checks.equal('opened-at-plugin-size', `${diag.clientWidth}x${diag.clientHeight}`, `${AGAIN.base.width}x${AGAIN.base.height}`);
    for (const percent of [150, 100]) {
      const changed = setPrimaryScale(percent);
      if (!changed.ok) { checks.notExecuted(`to-${percent}`, JSON.stringify(changed).slice(0, 200)); continue; }
      const dpi = Math.round(96 * percent / 100);
      const after = await waitForDpi(session, dpi);
      // The plug-in asks for its new size through resizeView. A fixed-size window
      // pinned to the OLD size would clamp that request away.
      sizeChecks(checks, after, { dpi, pluginScale: percent / 100, expectedClient: scaled(AGAIN.base, percent / 100), label: `to-${percent}` });
      if (percent === 150) capture(session, after, 'fixed-size-at-150', checks);
    }
    recordRun('P9-M', config, checks.list, {
      note: 'AGain reports canResize() == true. This run uses APEX_VST3_EDITOR_TEST_MODE=fixed-size so the host treats it as a non-resizable editor (no sizing border, min/max pinned) while the display scale really changes.',
    });
  } catch (error) {
    checks.is('sequence-completed', false, { error: error.message });
    recordRun('P9-M', config, checks.list);
  } finally {
    if (session) await session.client.dispose().catch(() => {});
  }
}

/** P9-D/E/F: only when Windows really has two monitors with different scales. */
async function multiMonitorPass(state) {
  if (state.monitorCount < 2) {
    const reason = `Windows reports ${state.monitorCount} monitor; two are required. Not executed.`;
    skipRun('P9-D', 'dual-100-125', reason);
    skipRun('P9-E', 'dual-100-150', reason);
    skipRun('P9-F', 'dual-move', reason);
    return;
  }
  const secondary = state.monitors.find(m => !m.primary);
  const secondaryIndex = state.sources.findIndex(s => s.device === secondary.device);
  for (const [caseId, percent] of [['P9-D', 125], ['P9-E', 150]]) {
    const config = `dual-100-${percent}`;
    stage('multi-monitor', { percent });
    const checks = checklist();
    const move = checklist();
    let session;
    try {
      // Attended runs never touch the display: they test the layout that is set.
      const second = allowDisplayChanges ? (setPrimaryScale(100), display('set-scale', { Scale: percent, Monitor: secondaryIndex })) : null;
      const now = display('query');
      const p = primaryOf(now), s = now.monitors.find(m => !m.primary);
      const secondDpi = Math.round(96 * percent / 100);
      if (p.effectiveDpi !== 96 || s.effectiveDpi !== secondDpi) {
        skipRun(caseId, config, `displays are not at 100% + ${percent}% (primary ${p.effectiveDpi} DPI, second ${s.effectiveDpi} DPI)`);
        if (second) notes.push(`set-scale on the second display: ${JSON.stringify(second.set)}`);
        continue;
      }
      session = await openEditor();
      if (!session.diag.windowRect) {
        skipRun(caseId, config, 'this helper build cannot move the window or report its monitor');
        continue;
      }
      // Opened on the primary (100%) monitor.
      checks.equal('opened-on-primary', session.diag.monitor?.device, p.device);
      sizeChecks(checks, session.diag, { dpi: 96, pluginScale: 1, expectedClient: AGAIN.base, label: 'on-primary' });
      capture(session, session.diag, `${config}-on-primary`, checks, { compareToReference: false });
      // Move it onto the second monitor: Windows sends WM_DPICHANGED.
      const before = session.diag.dpiWindowObservation?.dpiChangedMessageCount ?? 0;
      await action(session, 'moveWindow', { x: s.workLeft + 120, y: s.workTop + 120 });
      const onSecond = await waitForDpi(session, secondDpi);
      checks.equal('moved-to-second-monitor', onSecond.monitor?.device, s.device);
      checks.is('windows-sent-WM_DPICHANGED', (onSecond.dpiWindowObservation?.dpiChangedMessageCount ?? 0) > before,
        { before, after: onSecond.dpiWindowObservation?.dpiChangedMessageCount });
      sizeChecks(checks, onSecond, { dpi: secondDpi, pluginScale: percent / 100, expectedClient: scaled(AGAIN.base, percent / 100), label: 'on-second' });
      capture(session, onSecond, `${config}-on-second`, checks, { compareToReference: false });
      // Input must land on the editor on the SECOND monitor.
      const click = await clickSlider(session, 0.4, percent / 100);
      checks.near('on-second:slider-click-lands', click.value, 0.4, 0.06, { point: click.point, screenPoint: click.screenPoint });

      // ---- F: repeated crossings, programmatic and by real title-bar drag -------
      // Run BEFORE the resize checks below. Those force a size onto this fixed-size
      // editor and restore it with onSize, after which VSTGUI derives its unscaled
      // width from a whole number of pixels (437 / 1.25 = 349.6, floored to 349).
      // Here nothing but the monitor changes, so the size must come back EXACTLY.
      const exact = diag => `${diag.clientWidth}x${diag.clientHeight}`;
      const homeSize = `${AGAIN.base.width}x${AGAIN.base.height}`;
      const awaySize = exact(onSecond);
      for (let trip = 0; trip < 3; trip++) {
        await action(session, 'moveWindow', { x: p.workLeft + 160, y: p.workTop + 160 });
        const backHome = await waitForDpi(session, 96);
        sizeChecks(move, backHome, { dpi: 96, pluginScale: 1, expectedClient: AGAIN.base, label: `trip${trip + 1}-primary` });
        move.equal(`trip${trip + 1}-primary:exact-size`, exact(backHome), homeSize);
        await action(session, 'moveWindow', { x: s.workLeft + 160, y: s.workTop + 160 });
        const away = await waitForDpi(session, secondDpi);
        sizeChecks(move, away, { dpi: secondDpi, pluginScale: percent / 100, expectedClient: scaled(AGAIN.base, percent / 100), label: `trip${trip + 1}-second` });
        move.equal(`trip${trip + 1}-second:exact-size`, exact(away), awaySize);
      }
      // A person dragging the title bar across the boundary.
      const start = await diagnose(session);
      const grab = { x: start.windowRect.left + Math.round((start.windowRect.right - start.windowRect.left) / 2), y: start.windowRect.top + 14 };
      const drop = { x: p.workLeft + Math.round(p.workWidth / 2), y: p.workTop + Math.round(p.workHeight / 2) };
      const drag = await action(session, 'pointerDrag', { fromX: grab.x, fromY: grab.y, toX: drop.x, toY: drop.y, steps: 40, stepDelayMs: 20 });
      const dropped = await waitForDpi(session, 96);
      // Who sized the window during the drag, in the order Windows sent it.
      const trace = (drag.geometryTrace ?? []).map(e => [e.m, e.dpi ?? '', (e.suggested ?? e.rect ?? e.client ?? []).join(','),
        e.flags === undefined ? '' : `f${e.flags.toString(16)}`, `${e.byPlugin ? 'P' : ''}${e.fitting ? 'F' : ''}${e.inDpiChange ? 'D' : ''}`]
        .filter(part => part !== '').join(' '));
      if (trace.length) notes.push(`title-drag geometry (${config}): ${trace.join(' | ')}`.slice(0, 1900));
      move.is('title-drag:windows-move-loop-ran', drag.enteredSizeMove >= 1 && drag.exitedSizeMove >= 1, { drag: { ...drag, diagnostics: undefined, geometryTrace: undefined }, trace });
      move.is('title-drag:WM_DPICHANGED-during-drag', drag.dpiChangedMessages >= 1, { messages: drag.dpiChangedMessages });
      move.equal('title-drag:landed-on-primary', dropped.monitor?.device, p.device);
      sizeChecks(move, dropped, { dpi: 96, pluginScale: 1, expectedClient: AGAIN.base, label: 'title-drag' });
      move.equal('title-drag:exact-size', exact(dropped), homeSize);
      // If Windows resized the window before it sent WM_DPICHANGED (it does during a
      // drag on Windows Server 2025), that size must not have reached the plug-in.
      const raw = drag.geometryTrace ?? [];
      const dpiAt = raw.findIndex(e => e.m === 'dpiChanged');
      const sizedFirst = dpiAt > 0 && raw.slice(0, dpiAt).some(e => e.m === 'size' && !e.byPlugin && !e.fitting);
      if (sizedFirst) {
        move.is('title-drag:size-applied-before-WM_DPICHANGED-was-withheld', dropped.scaleFit?.sizeWasWithheld === true,
          { scaleFit: dropped.scaleFit ?? null, sizing: dropped.sizing ?? null });
      }
      move.is('title-drag:plug-in-chose-the-final-size', dropped.scaleFit?.source === 'plugin-requested'
        && dropped.scaleFit?.planned?.width === AGAIN.base.width && dropped.scaleFit?.planned?.height === AGAIN.base.height,
        { scaleFit: dropped.scaleFit ?? null });
      capture(session, dropped, `${config}-after-title-drag`, move, { compareToReference: false });

      // ---- D/E, last part: resize and constraints on the second monitor ---------
      await action(session, 'moveWindow', { x: s.workLeft + 120, y: s.workTop + 120 });
      const backOnSecond = await waitForDpi(session, secondDpi);
      await resizeChecks(session, checks, { factor: percent / 100, restingClient: { width: backOnSecond.clientWidth, height: backOnSecond.clientHeight } });
      recordRun(caseId, config, checks.list, { primary: p, second: s });
      const closed = await session.client.closeEditor();
      move.is('session-survived-and-captured-state', closed.closed === true && typeof closed.state?.component === 'string');
      recordRun('P9-F', 'dual-move', move.list, { secondMonitorPercent: percent });
    } catch (error) {
      checks.is('sequence-completed', false, { error: error.message });
      recordRun(caseId, config, checks.list);
    } finally {
      if (session) await session.client.dispose().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
let initial;
try { initial = display('query'); }
catch (error) {
  console.log(`P9-ERROR the display tool could not query this desktop: ${error.message}`);
  notes.push(`The display tool could not query this desktop, so nothing was verified: ${error.message}`);
  writeReport({ blocked: 'display-tool-failed' });
  process.exit(2);
}
// Recorded BEFORE anything is changed: this is what the desktop must look like
// again when the run ends.
let originalDisplay;
try { originalDisplay = snapshotDisplayConfiguration(initial); }
catch (error) {
  console.log(`P9-ERROR the display configuration could not be recorded: ${error.message}`);
  notes.push(`The display configuration could not be recorded, so nothing was changed and nothing was verified: ${error.message}`);
  writeReport({ blocked: 'display-snapshot-failed' });
  process.exit(2);
}
const initialPercent = originalDisplay.displays.find(d => d.primary)?.scalePercent ?? null;
stage('environment', { monitors: initial.monitorCount, primaryDpi: primaryOf(initial).effectiveDpi, initialPercent, host: hostLabel });
console.log(`P9-ORIGINAL-DISPLAY ${JSON.stringify(originalDisplay.displays)}`);
const executedScales = [];

/**
 * Put the display back and verify it. Runs once, from wherever the run ends.
 * In attended mode this script never changes the display, so it only compares:
 * a desktop that changed under the test invalidates the measurements.
 */
let restoration = null;
function restoreDisplay() {
  restoration ??= restoreDisplayConfiguration({ original: originalDisplay, call: display, attempts: allowDisplayChanges ? 3 : 0 });
  return restoration;
}
function finalReport() {
  let final = null;
  try { final = display('query'); } catch (error) { harnessErrors.push({ where: 'final display query', message: error.message }); }
  return writeReport({
    restoration: restoreDisplay(),
    environment: { monitorsAtStart: initial.monitors, sourcesAtStart: initial.sources, monitorsAtEnd: final?.monitors ?? null,
      sourcesAtEnd: final?.sources ?? null,
      executedScales, shell, osCaption: (() => {
        try { return execFileSync('cmd', ['/c', 'ver'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; }
      })() },
  });
}
/**
 * The run is being torn down from outside the normal flow (an interrupt, or an
 * error nothing caught). The display is still put back and the evidence still
 * written; such a run is never a pass.
 */
let abnormalExitHandled = false;
function abnormalExit(where, error) {
  if (abnormalExitHandled) return;
  abnormalExitHandled = true;
  harnessErrors.push({ where, message: String(error?.message ?? error).slice(0, 800) });
  console.log(`P9-ERROR ${where}: ${error?.message ?? error}`);
  try { restoreDisplay(); } catch { /* restoreDisplayConfiguration does not throw; belt and braces */ }
  try { finalReport(); } catch (reportError) { console.log(`P9-ERROR the report could not be written: ${reportError.message}`); }
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => abnormalExit('interrupted', signal));
process.on('uncaughtException', error => abnormalExit('uncaught exception', error));
process.on('unhandledRejection', error => abnormalExit('unhandled rejection', error));

try {
  if (allowDisplayChanges) {
    for (const percent of wantedScales) {
      const set = setPrimaryScale(percent);
      if (!set.ok) {
        notes.push(`Windows did not apply ${percent}% on the primary display: ${JSON.stringify(set)}`);
        continue;
      }
      executedScales.push(percent);
      await singleScalePass(percent);
    }
    await liveScalePass();
    await noContentScalePass();
    await fixedSizePass();
  } else {
    // Attended: test exactly the configuration the tester has set.
    const percent = Math.round(primaryOf(initial).effectiveDpi / 96 * 100);
    if ([100, 125, 150].includes(percent)) {
      executedScales.push(percent);
      await singleScalePass(percent);
    } else notes.push(`The primary display is at ${percent}%, which is not one of the P9 scales (100/125/150).`);
    notes.push('Attended mode: the display scale was not changed by this script, so the live-scale case and the other scales were not executed.');
  }
  await multiMonitorPass(display('query'));
} catch (error) {
  harnessErrors.push({ where: 'run', message: String(error.message).slice(0, 800) });
  notes.push(`harness error: ${error.message}`);
  console.log(`P9-ERROR ${error.message}`);
  if (error.stack) console.log(error.stack.slice(0, 1500));
} finally {
  // Always: after a clean run, after a failed case and after an exception alike.
  // The outcome is read back from Windows and decides the verdict with the cases.
  const restored = restoreDisplay();
  notes.push(describeRestoration(restored));
}

const report = finalReport();
abnormalExitHandled = true;  // the run has ended normally; nothing more to tear down
process.exit(report.exitCode);
