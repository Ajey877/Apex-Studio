// Native VST3 editor high-DPI regression tests (P9).
//
// What these can and cannot establish:
//
//   * The DPI sizing DECISIONS live in native/vst3/editor-dpi.hpp, which has no
//     Win32 dependency, and are exercised here by a real compiled C++ test.
//   * The Win32 half (editor-host.hpp) cannot run off Windows, so its structure is
//     pinned: the defects fixed for P9 must not be reintroduced.
//   * None of this is Windows acceptance. A real display at 125%/150% is exercised
//     only by scripts/native-editor-dpi-acceptance.mjs on Windows, and this file
//     asserts that the script never reports a case it did not execute as a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = relative => readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const editorHost = read('native/vst3/editor-host.hpp');
const hostMain = read('native/vst3/host.cpp');

/** Body of one `case WM_X:` in the editor window procedure. */
function messageCase(name) {
  // Inside the window procedure proper, not in the test-only geometry trace above it.
  const procedure = editorHost.indexOf('LRESULT handleWindowMessage(');
  assert.ok(procedure >= 0, 'the window procedure exists');
  const start = editorHost.indexOf(`case ${name}:`, procedure);
  assert.ok(start >= 0, `${name} is handled`);
  const next = editorHost.indexOf('\n      case WM_', start + 10);
  return editorHost.slice(start, next < 0 ? undefined : next);
}
/** Body of a member function, from its signature to the next member at the same indent. */
function memberBody(signature) {
  const start = editorHost.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const end = editorHost.indexOf('\n  }\n', start);
  return editorHost.slice(start, end);
}

test('DPI sizing decisions pass their compiled C++ regression test', t => {
  const build = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
  const name = process.platform === 'win32' ? 'apex-vst3-editor-dpi-test.exe' : 'apex-vst3-editor-dpi-test';
  let executable = [path.join(build, 'bin', name), path.join(build, 'bin/Release', name)].find(existsSync);
  let scratch = null;
  if (!executable) {
    // No native build in this checkout: compile the test directly. It needs only
    // the standard library, so any C++17 compiler will do.
    const compiler = ['c++', 'g++', 'clang++'].find(candidate =>
      spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
    if (!compiler) {
      t.skip('no native build and no C++ compiler on PATH; run npm run native:vst3:build');
      return;
    }
    scratch = mkdtempSync(path.join(os.tmpdir(), 'apex-editor-dpi-'));
    executable = path.join(scratch, name);
    execFileSync(compiler, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-o', executable,
      path.join(root, 'native/vst3/editor-dpi-test.cpp')], { stdio: 'pipe' });
  }
  try {
    const output = execFileSync(executable, [], { encoding: 'utf8', timeout: 15000 });
    assert.match(output, /all checks passed/);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
});

test('WM_DPICHANGED tells the plug-in the scale before the window is resized', () => {
  // Regression: the handler applied Windows' suggested rectangle first. WM_SIZE then
  // delivered that size to the plug-in at the OLD scale, and the scale call that
  // followed multiplied the enlarged view again (350x120 became 787x270 at 150%
  // instead of 525x180).
  const handler = messageCase('WM_DPICHANGED');
  assert.ok(handler.includes('applyScaleAndFit('), 'the DPI change goes through the shared scale-then-fit path');
  assert.ok(!/SetWindowPos\(/.test(handler),
    'the handler never sizes the window itself; the suggested rect is only a proposal');
  const fit = memberBody('void applyScaleAndFit(');
  const scaleAt = fit.indexOf('applyContentScale(');
  const sizeAt = fit.indexOf('setClientSize(');
  assert.ok(scaleAt >= 0 && sizeAt >= 0, 'the fit applies the scale and then sizes the client area');
  assert.ok(scaleAt < sizeAt, 'the plug-in is told the scale BEFORE the window is sized');
  assert.ok(fit.includes('dpi::planClientAfterScale('), 'the client size comes from the tested decision logic');
});

test('a host-chosen size is not forwarded to the plug-in while the scale is being applied', () => {
  const size = messageCase('WM_SIZE');
  assert.ok(size.includes('!resizingByPlugin') && size.includes('!fittingClient'),
    'WM_SIZE does not call onSize while the host or the plug-in is setting the size');
});

test('a size Windows applies before WM_DPICHANGED is withheld from the plug-in', () => {
  // Regression, measured on Windows Server 2025 with a second display: dragging the
  // editor by its title bar from a 125% monitor to a 100% one, Windows resized the
  // window and delivered WM_SIZE BEFORE WM_DPICHANGED. The host forwarded that size
  // to the plug-in, still at the old scale, and the scale change that followed
  // scaled it again: AGain ended at 276x88 instead of 350x120.
  const size = messageCase('WM_SIZE');
  const withheld = size.indexOf('dpi::sizeBelongsToPendingDpiChange(windowDpi, dpiForWindow(hwnd)');
  const forwarded = size.indexOf('forwardClientSize(');
  assert.ok(withheld >= 0 && forwarded >= 0, 'WM_SIZE asks whether the size belongs to a pending DPI change');
  assert.ok(withheld < forwarded, 'and decides that BEFORE anything is forwarded to the plug-in');
  assert.ok(size.includes('sizeWithheldForDpi = true') && size.includes('++withheldSizeCount'),
    'a withheld size is remembered and counted');
  // The plug-in still learns the real size if no DPI change follows.
  const exit = messageCase('WM_EXITSIZEMOVE');
  assert.ok(exit.includes('sizeWithheldForDpi && dpiForWindow(hwnd) == windowDpi') && exit.includes('forwardClientSize('),
    'a withheld size is delivered when the move ends without a DPI change');
  // And the fit that follows a withheld size starts from what the plug-in still has.
  const fit = memberBody('void applyScaleAndFit(');
  assert.ok(fit.includes('sizeWithheldForDpi && agreedClient ? *agreedClient'),
    'the DPI change compares against the size the plug-in has, not the one Windows set');
  // Every place that tells the plug-in a size records it.
  const told = [...editorHost.matchAll(/view->onSize\(/g)].length;
  const recorded = [...editorHost.matchAll(/agreedClient = /g)].length;
  assert.ok(told === 4 && recorded >= 4, `each of the ${told} onSize calls records the agreed size (${recorded} records)`);
});

test('Windows is told the editor\'s real size for a pending DPI change', () => {
  const start = editorHost.indexOf('case 0x02E4: {  // WM_GETDPISCALEDSIZE');
  assert.ok(start >= 0, 'WM_GETDPISCALEDSIZE is handled');
  const handler = editorHost.slice(start, editorHost.indexOf('case WM_SIZING:', start));
  assert.ok(handler.includes('dpi::outerForPendingDpi(') && handler.includes('frameForDpi(targetDpi)'),
    'the answer is the editor size at the new DPI with the frame of the new DPI');
  assert.ok(handler.includes('return TRUE;'), 'and the handler says it answered');
});

test('a nested WM_DPICHANGED is deferred, never handled re-entrantly', () => {
  const handler = messageCase('WM_DPICHANGED');
  assert.ok(handler.includes('if (applyingDpiChange)') && handler.includes('pendingDpiChange = change'),
    'a DPI change arriving during another one is queued');
  assert.match(handler, /for \(int pass = 0; pass < \d+; \+\+pass\)/, 'the catch-up loop is bounded');
});

test('window frames are measured for the window\'s DPI, not the process DPI', () => {
  // Regression: AdjustWindowRectEx answers for the DPI the process started at. After
  // a scale change, or on a monitor with another scale, the window's frame differs,
  // and the client area ended up a few pixels off the size the plug-in was told.
  assert.ok(editorHost.includes('"AdjustWindowRectExForDpi"'), 'the per-DPI frame call is used');
  const callers = [...editorHost.matchAll(/\bAdjustWindowRectEx\(/g)].map(match => {
    const before = editorHost.slice(0, match.index);
    const owner = [...before.matchAll(/\n  (?:[\w:<>,*& ]+ )?(\w+)\([^;{]*\)(?: const)? \{/g)].at(-1)?.[1];
    return owner;
  });
  assert.deepEqual([...new Set(callers)].sort(), ['createHostWindow', 'frameForDpi'],
    'only the pre-creation estimate and the documented fallback use the process-DPI call');
  for (const name of ['WM_SIZING', 'WM_GETMINMAXINFO']) {
    assert.ok(messageCase(name).includes('frameForDpi(windowDpi)'), `${name} uses the frame for the window's DPI`);
  }
  const sizer = memberBody('bool setClientSize(');
  assert.ok(sizer.includes('frameForDpi(windowDpi)'), 'the client sizer uses the frame for the window\'s DPI');
  assert.ok(sizer.includes('clientRect()') && sizer.includes('frameCorrectionCount'),
    'and reads the real client area back, correcting and counting any disagreement');
});

test('a fixed-size editor is not pinned to its old size during its own resize request', () => {
  const handler = messageCase('WM_GETMINMAXINFO');
  assert.ok(handler.includes('dpi::shouldPinFixedSize(resizable, resizingByPlugin, applyingDpiChange, fittingClient)'),
    'pinning is suspended while a plug-in-requested size or a DPI transition is applied');
});

test('the first scale at open uses the same path and the window\'s real DPI', () => {
  const open = memberBody('json open(const json& request)');
  assert.ok(open.includes('applyScaleAndFit(dpiForWindow(window)'), 'open scales from the live window DPI');
  assert.ok(open.indexOf('applyScaleAndFit(') < open.indexOf('ShowWindow('),
    'the window is sized for its DPI before it is ever shown');
});

test('per-monitor-v2 awareness is requested, recorded and verified on the window', () => {
  assert.ok(hostMain.includes('DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2'), 'per-monitor-v2 is requested');
  assert.ok(hostMain.indexOf('setDpiContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)') < hostMain.indexOf('CoInitializeEx'),
    'before COM and long before any window exists');
  assert.ok(/dpiRequest\.succeeded = setDpiContext\(/.test(hostMain), 'the outcome of the request is recorded');
  assert.ok(editorHost.includes('"GetWindowDpiAwarenessContext"') && editorHost.includes('"AreDpiAwarenessContextsEqual"'),
    'the diagnostics ask Windows what awareness the editor window really has');
});

test('injected pointer input can address every monitor', () => {
  // Regression (harness): absolute coordinates were normalised over the primary
  // monitor, so input aimed at an editor on a second display was clamped to the
  // primary's edge.
  assert.ok(editorHost.includes('MOUSEEVENTF_VIRTUALDESK'), 'absolute moves span the virtual desktop');
  assert.ok(editorHost.includes('SM_CXVIRTUALSCREEN') && editorHost.includes('SM_XVIRTUALSCREEN'),
    'coordinates are normalised over the virtual desktop, including its origin');
  assert.ok(!/GetSystemMetrics\(SM_CXSCREEN\)/.test(editorHost), 'the primary-monitor width is no longer used');
});

test('the acceptance switches are off unless the harness sets them', () => {
  const reader = memberBody('void readTestMode()');
  assert.ok(reader.includes('std::getenv("APEX_VST3_EDITOR_TEST_MODE")') && reader.includes('if (!raw) return;'),
    'without the environment variable nothing changes');
  for (const product of ['electron.cjs', 'desktop-vst3.cjs', 'native/vst3/service.mjs', 'native/vst3/client.mjs']) {
    assert.ok(!read(product).includes('APEX_VST3_EDITOR_TEST_MODE'), `${product} never sets the acceptance switch`);
  }
});

test('the P9 harness never reports a case it could not execute as a pass', () => {
  // Run the real script where it cannot verify anything: off Windows, or on Windows
  // with no helper built. Every case must come back NOT_VERIFIED, with exit code 2.
  const out = mkdtempSync(path.join(os.tmpdir(), 'apex-p9-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/native-editor-dpi-acceptance.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, APEX_P9_OUT: out, APEX_NATIVE_BUILD: path.join(out, 'no-such-build'),
        APEX_P9_ALLOW_DISPLAY_CHANGES: '', GITHUB_ACTIONS: '' },
    });
    assert.equal(result.status, 2, `exit code 2 means "cannot run here"\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(path.join(out, 'p9-dpi-acceptance.json'), 'utf8'));
    const ids = Object.keys(report.statuses);
    for (const id of ['P9-A', 'P9-B', 'P9-C', 'P9-D', 'P9-E', 'P9-F', 'P9-G', 'P9-H', 'P9-I', 'P9-J']) {
      assert.ok(ids.includes(id), `${id} is in the matrix`);
    }
    assert.ok(ids.every(id => report.statuses[id] === 'NOT_VERIFIED'),
      `nothing executed, so nothing may pass: ${JSON.stringify(report.statuses)}`);
    assert.ok(typeof report.blocked === 'string' && report.notes.length > 0, 'and the report says why');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the P9 harness only changes the display when explicitly allowed', () => {
  const harness = read('scripts/native-editor-dpi-acceptance.mjs');
  assert.ok(harness.includes("process.env.APEX_P9_ALLOW_DISPLAY_CHANGES === '1'"), 'display changes are opt-in');
  // The multi-monitor cases are skipped, not passed, with fewer than two monitors.
  assert.ok(/if \(state\.monitorCount < 2\) \{[\s\S]{0,400}skipRun\('P9-D'[\s\S]{0,200}skipRun\('P9-E'[\s\S]{0,200}skipRun\('P9-F'/.test(harness),
    'one monitor means P9-D, P9-E and P9-F are NOT_VERIFIED');
  // It never fabricates the thing it measures.
  assert.ok(!/setEditorScale\(|'setScale'/.test(harness), 'the harness never sets a content-scale factor by hand');
  assert.ok(!/queueMessage|PostMessage|SendMessage/.test(harness), 'and never posts a DPI message');
});

// ---------------------------------------------------------------------------
// Acceptance integrity (PR #303 review)
//
// Two properties of the P9 acceptance itself, not of the editor:
//   1. a lane may only be green for what it actually executed. The two-display
//      lane fails closed; the baseline lane is green only for the known defect;
//   2. a run that leaves the display configuration changed is a FAIL.
// The decisions are plain functions, so they are exercised here for real. The
// evidence used is the evidence recorded on Windows (docs/evidence/p9).
// ---------------------------------------------------------------------------
const { acceptanceVerdict, compareDisplayConfiguration, describeRestoration, restoreDisplayConfiguration, snapshotDisplayConfiguration } =
  await import('../scripts/display-restoration.mjs');
const { evaluateLane, BASELINE_DEFECT, MULTI_MONITOR_CASES } = await import('../scripts/verify-p9-evidence.mjs');

/**
 * A stand-in for the display tool: it holds a display configuration and answers
 * `query`, `set-scale` and `set-resolution` the way scripts/windows-display-scale.ps1
 * does. `ignoreScaleFor` and `failWith` simulate a Windows that does not comply.
 */
function fakeDisplays(displays, { ignoreScaleFor = [], failWith = null } = {}) {
  const state = structuredClone(displays);
  const calls = [];
  const query = () => ({
    monitorCount: state.length,
    monitors: state.map(d => ({ device: d.device, primary: d.primary, left: d.left, top: d.top, width: d.width, height: d.height,
      effectiveDpi: Math.round(96 * d.scale / 100) })),
    sources: state.map((d, index) => ({ index, device: d.device, currentPercent: d.scale, maximumPercent: 175 })),
  });
  const call = (action, args = {}) => {
    calls.push({ action, args });
    if (failWith) throw new Error(failWith);
    if (action === 'query') return query();
    if (action === 'set-scale') {
      const display = state[args.Monitor];
      if (display && !ignoreScaleFor.includes(display.device)) display.scale = args.Scale;
      return { set: { status: 0 }, after: query() };
    }
    if (action === 'set-resolution') {
      const display = state.find(d => d.device === args.Device);
      if (display) { display.width = args.Width; display.height = args.Height; }
      return { status: 0 };
    }
    throw new Error(`unexpected display action ${action}`);
  };
  return { call, calls, state, query };
}
const TWO_DISPLAYS = [
  { device: '\\\\.\\DISPLAY1', primary: true, left: 0, top: 0, width: 1920, height: 1080, scale: 100 },
  { device: '\\\\.\\DISPLAY2', primary: false, left: 1024, top: -1080, width: 1920, height: 1080, scale: 100 },
];

test('the display configuration is recorded per display: resolution, position, DPI and scale', () => {
  const snapshot = snapshotDisplayConfiguration(fakeDisplays(TWO_DISPLAYS).query());
  assert.equal(snapshot.monitorCount, 2);
  assert.deepEqual(snapshot.displays.map(d => d.device), ['\\\\.\\DISPLAY1', '\\\\.\\DISPLAY2']);
  const second = snapshot.displays[1];
  assert.deepEqual({ w: second.width, h: second.height, left: second.left, top: second.top, dpi: second.effectiveDpi, scale: second.scalePercent, primary: second.primary },
    { w: 1920, h: 1080, left: 1024, top: -1080, dpi: 96, scale: 100, primary: false });
  assert.throws(() => snapshotDisplayConfiguration({ monitors: [] }), /no monitors/, 'an empty query is not a configuration');
});

test('a display left at another scale or resolution is put back and read back from Windows', () => {
  const windows = fakeDisplays(TWO_DISPLAYS);
  const original = snapshotDisplayConfiguration(windows.call('query'));
  // What a run leaves behind when it stops in the middle.
  windows.state[0].scale = 150; windows.state[0].width = 1024; windows.state[0].height = 768;
  windows.state[1].scale = 125;
  const record = restoreDisplayConfiguration({ original, call: windows.call });
  assert.equal(record.ok, true, describeRestoration(record));
  assert.equal(record.changesWereNeeded, true);
  assert.deepEqual(record.differences, []);
  assert.deepEqual(windows.state.map(d => [d.scale, d.width, d.height]), [[100, 1920, 1080], [100, 1920, 1080]], 'Windows really is back');
  // The verdict comes from a query made AFTER the last change, not from a set call's return value.
  const lastChange = windows.calls.map(c => c.action).lastIndexOf('set-scale');
  assert.ok(windows.calls.slice(lastChange + 1).some(c => c.action === 'query'), 'the final state is read back');
  assert.ok(record.final.displays.every((d, index) => d.scalePercent === original.displays[index].scalePercent));
  assert.deepEqual(record.steps.map(s => `${s.device} ${s.setting}`).sort(),
    ['\\\\.\\DISPLAY1 resolution', '\\\\.\\DISPLAY1 scale', '\\\\.\\DISPLAY2 scale']);
});

test('a restoration Windows does not honour is a failure that names the display and the setting', () => {
  const windows = fakeDisplays(TWO_DISPLAYS, { ignoreScaleFor: ['\\\\.\\DISPLAY2'] });
  const original = snapshotDisplayConfiguration(windows.call('query'));
  windows.state[0].scale = 125;
  windows.state[1].scale = 150;
  const record = restoreDisplayConfiguration({ original, call: windows.call });
  // Every set call "succeeded" (status 0). Only the read-back shows the truth.
  assert.equal(record.ok, false);
  assert.ok(record.steps.every(step => !step.error), 'no call reported an error');
  assert.deepEqual(record.differences, [
    { device: '\\\\.\\DISPLAY2', setting: 'effectiveDpi', original: 96, final: 144 },
    { device: '\\\\.\\DISPLAY2', setting: 'scalePercent', original: 100, final: 150 },
  ]);
  assert.equal(record.final.displays[0].scalePercent, 100, 'the display that could be restored was restored');
  assert.match(describeRestoration(record), /FAILED.*DISPLAY2 scalePercent: original 100, now 150/);
  assert.ok(record.attempts >= 2, 'it was retried before being declared failed');
});

test('restoration never throws, whatever the display tool does', () => {
  const working = fakeDisplays(TWO_DISPLAYS);
  const original = snapshotDisplayConfiguration(working.call('query'));
  const broken = fakeDisplays(TWO_DISPLAYS, { failWith: 'display tool query failed (1)' });
  let record;
  assert.doesNotThrow(() => { record = restoreDisplayConfiguration({ original, call: broken.call }); }, 'it is called from finally blocks');
  assert.equal(record.ok, false, 'a state that cannot be read back is not "restored"');
  assert.ok(record.errors.length > 0 && record.errors.every(e => /display tool query failed/.test(e.message)));
  assert.ok(broken.calls.some(c => c.action === 'set-scale') && broken.calls.some(c => c.action === 'set-resolution'),
    'it still attempts to put everything back when it cannot see the current state');
  assert.equal(restoreDisplayConfiguration({ original: null, call: working.call }).ok, false, 'no record of the original is a failure too');
});

test('a display that disappeared, or one that appeared, is a restoration failure', () => {
  const windows = fakeDisplays(TWO_DISPLAYS);
  const original = snapshotDisplayConfiguration(windows.call('query'));
  windows.state.pop();
  const gone = restoreDisplayConfiguration({ original, call: windows.call });
  assert.equal(gone.ok, false);
  assert.ok(gone.differences.some(d => d.setting === 'monitorCount' && d.original === 2 && d.final === 1));
  assert.ok(gone.differences.some(d => d.device === '\\\\.\\DISPLAY2' && d.setting === 'present' && d.final === false));
  const one = snapshotDisplayConfiguration(fakeDisplays(TWO_DISPLAYS.slice(0, 1)).query());
  const extra = compareDisplayConfiguration(one, original);
  assert.ok(extra.differences.some(d => d.device === '\\\\.\\DISPLAY2' && d.setting === 'present' && d.final === true));
});

test('with no permission to change the display, restoration only compares', () => {
  const windows = fakeDisplays(TWO_DISPLAYS);
  const original = snapshotDisplayConfiguration(windows.call('query'));
  windows.state[0].scale = 125;  // someone changed it under the test
  const record = restoreDisplayConfiguration({ original, call: windows.call, attempts: 0 });
  assert.ok(windows.calls.every(c => c.action === 'query'), 'attended mode never changes the display');
  assert.equal(record.ok, false, 'but a desktop that changed under the test is still reported');
});

test('the verdict is FAIL when the display was not restored, even if every case passed', () => {
  const allPass = { 'P9-A': 'PASS', 'P9-B': 'PASS' };
  const restored = { ok: true, original: { displays: [] }, differences: [], steps: [], errors: [] };
  assert.deepEqual(acceptanceVerdict({ statuses: allPass, restoration: restored }), { verdict: 'PASS', reasons: [], exitCode: 0 });
  const notRestored = { ...restored, ok: false, differences: [{ device: '\\\\.\\DISPLAY1', setting: 'scalePercent', original: 100, final: 150 }] };
  const failed = acceptanceVerdict({ statuses: allPass, restoration: notRestored });
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.exitCode, 1);
  assert.match(failed.reasons.join(' '), /not restored.*DISPLAY1 scalePercent/);
  // NOT_VERIFIED cases do not soften it either.
  assert.equal(acceptanceVerdict({ statuses: { 'P9-A': 'PASS', 'P9-D': 'NOT_VERIFIED' }, restoration: notRestored }).exitCode, 1);
  assert.equal(acceptanceVerdict({ statuses: { 'P9-A': 'PASS', 'P9-D': 'NOT_VERIFIED' }, restoration: restored }).exitCode, 3);
  assert.equal(acceptanceVerdict({ statuses: { 'P9-A': 'FAIL' }, restoration: restored }).exitCode, 1);
  // Blocked before the display was ever recorded: nothing was changed, nothing verified.
  assert.deepEqual(acceptanceVerdict({ statuses: { 'P9-A': 'NOT_VERIFIED' }, restoration: null, blocked: 'helper-not-built' }),
    { verdict: 'NOT_VERIFIED', reasons: ['blocked: helper-not-built'], exitCode: 2 });
});

test('both acceptance scripts record first, restore in finally, read back, and fail on a failed restoration', () => {
  const harness = read('scripts/native-editor-dpi-acceptance.mjs');
  // Recorded before the first call that changes anything.
  const snapshotAt = harness.indexOf('originalDisplay = snapshotDisplayConfiguration(initial)');
  const firstChange = harness.indexOf('const set = setPrimaryScale(percent);', snapshotAt);
  assert.ok(snapshotAt > 0 && firstChange > snapshotAt, 'the original configuration is recorded before the first scale change');
  assert.ok(/\} finally \{[^}]*const restored = restoreDisplay\(\);/.test(harness), 'restoration runs in finally');
  assert.ok(/for \(const signal of \['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'\]\) process\.on\(signal, \(\) => abnormalExit\(/.test(harness)
    && /process\.on\('uncaughtException', error => abnormalExit\(/.test(harness), 'and on an interrupt or an uncaught error');
  assert.ok(/function abnormalExit[\s\S]{0,500}restoreDisplay\(\)[\s\S]{0,300}process\.exit\(1\)/.test(harness), 'such a run restores and is never a pass');
  assert.ok(harness.includes('acceptanceVerdict({ statuses, restoration: extra.restoration, blocked: extra.blocked })'), 'the verdict includes the restoration');
  assert.ok(/const report = finalReport\(\);[\s\S]{0,200}process\.exit\(report\.exitCode\);/.test(harness), 'and the exit code is that verdict');
  assert.ok(/restoration: restoreDisplay\(\),/.test(harness), 'the restoration record is in the evidence');
  assert.ok(!/if \(values\.includes\('NOT_VERIFIED'\)\) process\.exit\(3\)/.test(harness), 'the exit code is no longer derived from the cases alone');

  const packaged = read('scripts/packaged-editor-acceptance.mjs');
  const pass = packaged.slice(packaged.indexOf('async function displayScalePass()'), packaged.indexOf('await displayScalePass();'));
  const recorded = pass.indexOf('originalDisplay = snapshotDisplayConfiguration(initial)');
  assert.ok(recorded > 0 && recorded < pass.indexOf("displayCall('set-resolution'") && recorded < pass.indexOf('setPrimaryDisplayScale(percent)'),
    'the packaged run records the configuration before changing resolution or scale');
  assert.ok(/\} finally \{[\s\S]{0,300}restorePackagedRunDisplay\(\);/.test(pass), 'restores in finally');
  assert.ok(pass.includes('const restorationFailed = originalDisplay !== null && displayRestoration?.ok !== true;'));
  assert.ok(pass.includes("record('p9-dpi-125-150', (failures.length || restorationFailed) ? 'FAIL' : executed ? 'PASS' : 'NOT_VERIFIED'"),
    'a failed restoration makes the criterion FAIL, never PASS');
  assert.ok(pass.includes('displayRestoration,'), 'with the record in the criterion evidence');
  assert.ok(packaged.includes('writeReport({ displayRestoration });'), 'and at the top of the evidence file');
  assert.ok(/process\.exit\(results\.some\(r => r\.status === 'FAIL'\) \? 1 : 3\);/.test(packaged), 'a FAIL criterion is exit code 1');
  // Neither script decides "restored" from a set call's return value any more.
  assert.ok(!/restored = setPrimaryDisplayScale\(initialPercent\)\.ok/.test(packaged));
});

// ---- lane policies ---------------------------------------------------------
const BASELINE_TREE = '2c63e3b7f952945d181207b40d8b3b086f75dd85';
const BRANCH_TREE = 'a'.repeat(40);
const RECORDED = { branch: { verdict: 'NOT_VERIFIED', exitCode: 3 }, 'branch-second-display': { verdict: 'PASS', exitCode: 0 }, baseline: { verdict: 'FAIL', exitCode: 1 } };
/** Evidence recorded on Windows for `host`, with a consistent restoration record. */
function recordedEvidence(host) {
  const report = JSON.parse(read(`docs/evidence/p9/p9-dpi-acceptance.${host}.json`));
  const displays = report.environment.monitorsAtStart.map(m => ({ device: m.device, primary: m.primary, left: m.left, top: m.top,
    width: m.width, height: m.height, effectiveDpi: m.effectiveDpi, scalePercent: Math.round(m.effectiveDpi * 100 / 96) }));
  const snapshot = { monitorCount: displays.length, displays };
  return { ...report, schemaVersion: 2, host, verdict: RECORDED[host].verdict, exitCode: RECORDED[host].exitCode, harnessErrors: [],
    nativeSourceTree: host === 'baseline' ? BASELINE_TREE : BRANCH_TREE,
    restoration: { ok: true, changesWereNeeded: true, original: snapshot, final: structuredClone(snapshot), differences: [], steps: [], errors: [] } };
}
const laneOptions = (lane, overrides = {}) => ({ lane, exitCode: RECORDED[lane].exitCode,
  expectedNativeTree: lane === 'baseline' ? BASELINE_TREE : BRANCH_TREE, ...overrides });
/** Turn a case into what the harness records when it could not be executed. */
function notExecuted(report, id) {
  const entry = report.cases.find(c => c.id === id);
  entry.status = 'NOT_VERIFIED';
  entry.runs = entry.needs.map(config => ({ config, status: 'NOT_VERIFIED', checks: [], evidence: { reason: 'Windows reports 1 monitor; two are required. Not executed.' } }));
  entry.missing = [...entry.needs];
  report.statuses[id] = 'NOT_VERIFIED';
  return report;
}
const rejected = (result, pattern) => {
  assert.equal(result.ok, false, `must be rejected: ${result.summary}`);
  assert.ok(result.problems.some(problem => pattern.test(problem)), `expected a problem matching ${pattern}; got:\n${result.problems.join('\n')}`);
};

test('the recorded evidence of each lane satisfies that lane\'s policy', () => {
  for (const lane of ['branch', 'branch-second-display', 'baseline']) {
    const result = evaluateLane(recordedEvidence(lane), laneOptions(lane));
    assert.deepEqual(result.problems, [], lane);
    assert.equal(result.ok, true);
  }
});

test('the two-display lane fails closed: exit code 3 and unexecuted P9-D/E/F are rejected', () => {
  // Exactly the reviewed weakness: one display, D/E/F NOT_VERIFIED, exit code 3.
  const single = { ...recordedEvidence('branch'), host: 'branch-second-display' };
  const result = evaluateLane(single, laneOptions('branch-second-display', { exitCode: 3 }));
  rejected(result, /exit code 3.*not accepted/i);
  rejected(result, /1 monitor\(s\).*two are required/);
  for (const id of MULTI_MONITOR_CASES) rejected(result, new RegExp(`${id} is NOT_VERIFIED; every case must be PASS`));

  // Each multi-monitor case is mandatory on its own, two displays or not.
  for (const id of MULTI_MONITOR_CASES) {
    const report = notExecuted(recordedEvidence('branch-second-display'), id);
    report.verdict = 'NOT_VERIFIED';
    rejected(evaluateLane(report, laneOptions('branch-second-display', { exitCode: 3 })), new RegExp(`${id} is NOT_VERIFIED`));
    // A summary edited to say PASS does not help: the runs are read.
    report.statuses[id] = 'PASS'; report.verdict = 'PASS';
    rejected(evaluateLane(report, laneOptions('branch-second-display')), new RegExp(`${id}`));
  }
  // PASS with nothing executed is not a pass.
  const hollow = recordedEvidence('branch-second-display');
  hollow.cases.find(c => c.id === 'P9-F').runs.forEach(run => { run.checks = []; });
  rejected(evaluateLane(hollow, laneOptions('branch-second-display')), /P9-F is reported PASS without executed, passing checks/);
  // Two displays must have been there when the run started.
  const oneMonitor = recordedEvidence('branch-second-display');
  oneMonitor.environment.monitorsAtStart = oneMonitor.environment.monitorsAtStart.slice(0, 1);
  rejected(evaluateLane(oneMonitor, laneOptions('branch-second-display')), /1 monitor\(s\) at the start/);
  // A failing check anywhere, and exit code 1, are rejected as well.
  rejected(evaluateLane(recordedEvidence('branch-second-display'), laneOptions('branch-second-display', { exitCode: 1 })), /exit code 1/);
});

test('the single-display lane accepts NOT_VERIFIED only for P9-D/E/F', () => {
  assert.equal(evaluateLane(recordedEvidence('branch'), laneOptions('branch')).ok, true);
  const report = recordedEvidence('branch');
  const entry = report.cases.find(c => c.id === 'P9-C');
  entry.status = 'NOT_VERIFIED'; report.statuses['P9-C'] = 'NOT_VERIFIED';
  rejected(evaluateLane(report, laneOptions('branch')), /P9-C is NOT_VERIFIED; it must be PASS on a single display/);
  rejected(evaluateLane(recordedEvidence('branch'), laneOptions('branch', { exitCode: 1 })), /exit code 1/);
  rejected(evaluateLane(recordedEvidence('branch'), laneOptions('branch', { exitCode: 0 })), /exited 0 but its evidence says NOT_VERIFIED/);
});

test('no lane is green when the display was not restored, the harness erred, or the evidence is for something else', () => {
  for (const lane of ['branch', 'branch-second-display', 'baseline']) {
    const notRestored = recordedEvidence(lane);
    notRestored.restoration.ok = false;
    notRestored.restoration.differences = [{ device: '\\\\.\\DISPLAY1', setting: 'scalePercent', original: 100, final: 150 }];
    rejected(evaluateLane(notRestored, laneOptions(lane)), /not restored: \\\\\.\\DISPLAY1 scalePercent: original 100, final 150/);
    const noRecord = recordedEvidence(lane); noRecord.restoration = null;
    rejected(evaluateLane(noRecord, laneOptions(lane)), /no display restoration record/);
    const noReadBack = recordedEvidence(lane); noReadBack.restoration.final = null;
    rejected(evaluateLane(noReadBack, laneOptions(lane)), /no final display configuration read back/);
    const erred = recordedEvidence(lane); erred.harnessErrors = [{ where: 'run', message: 'display tool set-scale failed (1)' }];
    rejected(evaluateLane(erred, laneOptions(lane)), /harness itself reported errors/);
    rejected(evaluateLane(recordedEvidence(lane), laneOptions(lane, { commit: 'f'.repeat(40) })), /is for commit/);
    rejected(evaluateLane(recordedEvidence(lane), laneOptions(lane, { expectedNativeTree: 'e'.repeat(40) })), /built from native\/vst3 tree/);
    rejected(evaluateLane({ ...recordedEvidence(lane), host: 'somewhere-else' }, laneOptions(lane)), /not for lane/);
    rejected(evaluateLane({ ...recordedEvidence(lane), schemaVersion: 1 }, laneOptions(lane)), /schemaVersion/);
    rejected(evaluateLane({ ...recordedEvidence(lane), blocked: 'helper-not-built' }, laneOptions(lane)), /blocked/);
  }
});

test('the baseline lane is green only for the known P9-K sizing defect', () => {
  const reproduced = evaluateLane(recordedEvidence('baseline'), laneOptions('baseline'));
  assert.equal(reproduced.ok, true, reproduced.problems.join('\n'));
  // What it saw is the defect as documented: the editor too large after a real DPI change.
  assert.deepEqual(reproduced.reproduction.transitions['to-125'], { width: 548, height: 182, expectedWidth: 437, expectedHeight: 150, equalsRecordedMeasurement: true });
  assert.deepEqual(reproduced.reproduction.transitions['to-150'], { width: 626, height: 202, expectedWidth: 525, expectedHeight: 180, equalsRecordedMeasurement: true });
  assert.match(reproduced.summary, /REPRODUCED.*548x182 \(expected 437x150\)/);

  const liveScale = report => report.cases.find(c => c.id === 'P9-K').runs.find(run => run.config === BASELINE_DEFECT.config);
  const baseline = mutate => { const report = recordedEvidence('baseline'); mutate(report); return evaluateLane(report, laneOptions('baseline')); };

  // The defect is gone (this is also what the fixed code produces).
  rejected(evaluateLane({ ...recordedEvidence('branch'), host: 'baseline', nativeSourceTree: BASELINE_TREE }, laneOptions('baseline', { exitCode: 3 })),
    /P9-K is PASS; the defect was not reproduced/);
  // A build failure: nothing ran. Exit 2, blocked, P9-K merely NOT_VERIFIED.
  rejected(baseline(report => { for (const entry of report.cases) { entry.status = 'NOT_VERIFIED'; entry.runs = []; report.statuses[entry.id] = 'NOT_VERIFIED'; }
    report.blocked = 'helper-not-built'; report.verdict = 'NOT_VERIFIED'; }), /blocked|P9-K is NOT_VERIFIED; the defect was not reproduced/);
  // P9-K red for a reason that is NOT the sizing defect: the helper just died.
  rejected(baseline(report => {
    const run = liveScale(report);
    run.checks = [{ name: 'live-scale-sequence-completed', ok: false, error: 'VST3 helper exited unexpectedly' }];
  }), /did not open correctly at 100%|was not measured/);
  // Sizes correct, something else in P9-K failing.
  rejected(baseline(report => {
    for (const check of liveScale(report).checks) if (/:client-(width|height)$/.test(check.name)) { check.ok = true; check.actual = check.expected; }
  }), /the client width is correct \(437\); the sizing defect is absent/);
  // Wrong size, but in the other direction or by a pixel: not this defect.
  rejected(baseline(report => { liveScale(report).checks.find(c => c.name === 'to-125:client-width').actual = 300; }), /ratio 0\.686/);
  rejected(baseline(report => { liveScale(report).checks.find(c => c.name === 'to-150:client-height').actual = 183; }), /to-150: client height is 183 for an expected 180/);
  // The scale change never reached the window: a wrong size then proves nothing.
  rejected(baseline(report => { liveScale(report).checks.find(c => c.name === 'to-125:windows-sent-WM_DPICHANGED').ok = false; }),
    /to-125: "windows-sent-WM_DPICHANGED" is failing/);
  rejected(baseline(report => { const run = liveScale(report); run.checks = run.checks.filter(c => !c.name.startsWith('to-150:')); }), /to-150: .* absent/);
  // The run is broken somewhere else: cases the old helper passes do not pass, or another case fails.
  rejected(baseline(report => { report.statuses['P9-A'] = 'FAIL'; report.cases.find(c => c.id === 'P9-A').status = 'FAIL'; }),
    /P9-A is FAIL; it passes on the pre-fix sources/);
  rejected(baseline(report => { report.statuses['P9-G'] = 'FAIL'; report.cases.find(c => c.id === 'P9-G').status = 'FAIL'; }),
    /P9-G FAILED; only P9-K is expected to fail/);
  rejected(baseline(report => { report.statuses['P9-I'] = 'NOT_VERIFIED'; report.cases.find(c => c.id === 'P9-I').status = 'NOT_VERIFIED'; }),
    /P9-I is NOT_VERIFIED; it passes on the pre-fix sources/);
  // Not the pre-fix sources, or sources nobody identified.
  rejected(evaluateLane(recordedEvidence('baseline'), laneOptions('baseline', { expectedNativeTree: undefined })), /pre-fix native sources was not stated/);
  rejected(evaluateLane({ ...recordedEvidence('baseline'), nativeSourceTree: BRANCH_TREE }, laneOptions('baseline')), /built from native\/vst3 tree/);
  // Exit codes other than "a case failed".
  for (const exitCode of [0, 2, 3]) rejected(evaluateLane(recordedEvidence('baseline'), laneOptions('baseline', { exitCode })), new RegExp(`exit code ${exitCode}`));
});

test('the lane verifier command line: no evidence is a rejection, and negative controls invert', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'apex-p9-verify-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, ['scripts/verify-p9-evidence.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  const write = (name, report) => { const file = path.join(directory, name); writeFileSync(file, JSON.stringify(report)); return file; };
  const missing = path.join(directory, 'never-written.json');
  for (const lane of ['branch', 'branch-second-display', 'baseline']) {
    const result = run('--lane', lane, '--evidence', missing, '--exit-code', '1', '--expected-native-tree', BASELINE_TREE);
    assert.equal(result.status, 1, `${lane}: a run without evidence can never be green\n${result.stdout}`);
    assert.match(result.stdout, /REJECTED.*no evidence file/s);
  }
  const garbage = path.join(directory, 'garbage.json'); writeFileSync(garbage, '{ not json');
  assert.equal(run('--lane', 'baseline', '--evidence', garbage, '--exit-code', '1').status, 1);

  const second = write('second.json', recordedEvidence('branch-second-display'));
  const single = write('single.json', recordedEvidence('branch'));
  const out = path.join(directory, 'verdict.json');
  const accepted = run('--lane', 'branch-second-display', '--evidence', second, '--exit-code', '0', '--expected-native-tree', BRANCH_TREE, '--out', out);
  assert.equal(accepted.status, 0, accepted.stdout);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).laneMayBeGreen, true);
  assert.equal(run('--lane', 'branch-second-display', '--evidence', second, '--exit-code', '3', '--expected-native-tree', BRANCH_TREE).status, 1, 'exit code 3 is not accepted');
  assert.equal(run('--lane', 'branch-second-display', '--evidence', second, '--expected-native-tree', BRANCH_TREE).status, 1, 'an unknown exit code is not accepted');
  // The negative control the workflow runs: one-display evidence against the two-display policy.
  const control = run('--expect-rejection', '--ignore-host-label', '--lane', 'branch-second-display', '--evidence', single, '--exit-code', '3', '--expected-native-tree', BRANCH_TREE);
  assert.equal(control.status, 0, control.stdout);
  assert.match(control.stdout, /Negative control OK[\s\S]*P9-D is NOT_VERIFIED[\s\S]*P9-F is NOT_VERIFIED/);
  assert.doesNotMatch(control.stdout, /not for lane/, 'and it is rejected for the policy, not for its label');
  // A control that is NOT rejected must fail loudly.
  const broken = run('--expect-rejection', '--lane', 'branch-second-display', '--evidence', second, '--exit-code', '0', '--expected-native-tree', BRANCH_TREE);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /NEGATIVE CONTROL FAILED/);
  assert.equal(run('--ignore-host-label', '--lane', 'branch', '--evidence', single, '--exit-code', '3').status, 2, 'the label may only be ignored in a negative control');
});

test('the P9 workflow gates every lane on the evidence, not on the exit code', () => {
  const workflow = read('.github/workflows/p9-dpi-acceptance.yml');
  const job = workflow.slice(workflow.indexOf('  dpi-acceptance:'), workflow.indexOf('  publish-evidence:'));
  const step = name => {
    const start = job.indexOf(`      - name: ${name}`);
    assert.ok(start >= 0, `step "${name}" exists`);
    const next = job.indexOf('\n      - ', start + 10);
    return job.slice(start, next < 0 ? undefined : next);
  };
  assert.ok(!/^\s*continue-on-error:/m.test(job), 'no lane is allowed to fail silently, the baseline included');

  // Finding 1: the weakness itself must be gone.
  assert.ok(!/\[ "\$status" -eq 0 \] \|\| \[ "\$status" -eq 3 \]/.test(job), 'exit code 3 is no longer accepted wholesale');
  const acceptance = step('P9 acceptance at 100%, 125% and 150% on the real display, judged by the lane policy');
  assert.ok(/node scripts\/verify-p9-evidence\.mjs \\\n\s+--lane "\$APEX_P9_HOST_LABEL" \\\n\s+--evidence "\$APEX_P9_OUT\/p9-dpi-acceptance\.json" \\\n\s+--exit-code "\$status"/.test(acceptance),
    'the lane policy reads the evidence JSON and the real exit code');
  assert.ok(/verdict=\$\?\n\s+echo "lane verdict exit code: \$verdict"\n\s+exit "\$verdict"\n\s+#/.test(acceptance), 'and its result is the result of the step');
  assert.ok(!/continue-on-error|\|\| true/.test(acceptance));
  assert.ok(acceptance.includes('--expected-native-tree "$APEX_P9_NATIVE_TREE"') && acceptance.includes('--commit "$GITHUB_SHA"'));

  const install = step('Add a virtual second display and REQUIRE it (pinned third-party driver, this runner only)');
  assert.ok(install.includes('if: matrix.second_display'));
  assert.ok(install.includes('./scripts/ci-require-second-display.ps1 -InstallerReport $installReport'), 'the gate judges the installer report');
  assert.ok(/if \(\$gateExit -ne 0 -or -not \$accepted\) \{[\s\S]{0,400}exit 1/.test(install), 'and a missing second display stops the job');
  assert.ok(!/::warning/.test(install), 'a warning-and-continue is exactly what was removed');
  assert.ok(job.indexOf('REQUIRE it') < job.indexOf('npm run native:vst3:build'), 'it fails before anything is built or measured');

  const gate = read('scripts/ci-require-second-display.ps1');
  for (const needle of ["$info.available -ne $true", "$state.monitorCount -lt $MinimumMonitors", "'Virtual Display Driver'", "$_.Status -eq 'OK'", 'exit 1']) {
    assert.ok(gate.includes(needle), `the gate checks: ${needle}`);
  }
  // The installer still only reports; it is the gate that decides.
  assert.ok(read('scripts/ci-install-virtual-display.ps1').includes('exit 0'));

  // Baseline: the old sources, exactly, and green only through the policy.
  const sources = step('Use the pre-fix native helper sources, exactly and only (baseline)');
  assert.ok(sources.includes('rm -rf native/vst3') && sources.includes('git checkout "$BASELINE_COMMIT" -- native/vst3 scripts/build-native-vst3.mjs'));
  assert.ok(sources.includes('actual_tree=$(git write-tree --prefix=native/vst3/)') && sources.includes('[ "$actual_tree" != "$baseline_tree" ] || [ "$on_disk" != "$in_tree" ]'),
    'the tree that is built is proven to be the baseline tree and nothing else');
  assert.ok(job.includes('BASELINE_COMMIT: c246e2a91f7d7c7aaca1d9903d334e7eceab5be8'), 'and the baseline commit is unchanged');
  assert.equal(execFileSync('git', ['rev-parse', '--verify', '--quiet', 'c246e2a91f7d7c7aaca1d9903d334e7eceab5be8:native/vst3'], { cwd: root, encoding: 'utf8' }).trim(),
    BASELINE_TREE, 'the tree the tests use for the baseline is the real one');

  // Negative controls run on the runner, on real evidence.
  const controls = step('Negative controls - this evidence is rejected by the other lane policies');
  assert.ok(controls.includes("if: matrix.host == 'branch'"));
  assert.equal((controls.match(/--expect-rejection --ignore-host-label/g) ?? []).length, 2);
  assert.ok(controls.includes('--lane branch-second-display') && controls.includes('--lane baseline'));
  assert.ok(/\|\| failed=1[\s\S]*exit "\$failed"/.test(controls));
  assert.ok(step('Negative control - the second-display gate refuses this one-display runner').includes('if ($gateExit -eq 0 -or $accepted) {'));
});
