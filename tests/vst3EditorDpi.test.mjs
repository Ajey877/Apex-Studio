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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = relative => readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const editorHost = read('native/vst3/editor-host.hpp');
const hostMain = read('native/vst3/host.cpp');

/** Body of one `case WM_X:` in the editor window procedure. */
function messageCase(name) {
  const start = editorHost.indexOf(`case ${name}:`);
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
