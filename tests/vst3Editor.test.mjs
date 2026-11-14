// Genuine native VST3 editor lifecycle.
//
// The native editor is the plug-in's own VST3 view inside a Windows HWND owned
// by the isolated helper process, so it cannot run in this Linux/CI process.
// These tests exercise the layer that decides whether the user's edits become
// project state or a recovery record, using a bridge that behaves like the
// validated main-process service (including its failure modes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NativeVst3EditorSession, supportsNativeVst3Editor } from '../src/audio/nativeVst3EditorSession.ts';
/**
 * Read a file with CRLF normalised to LF.
 *
 * Several tests assert on multi-line source structure. Assertions that span lines
 * must not silently pass on Linux and fail on a Windows checkout, so read through
 * this helper instead of relying on the platform's line endings.
 */
function readScript(relative = 'scripts/build-native-vst3.mjs') {
  return readSource(relative);
}

function readSource(relative) {
  return readFileSync(path.join(process.cwd(), relative), 'utf8').replace(/\r\n/g, '\n');
}
/** @typedef {import('../src/audio/nativeVst3Types.ts').Vst3EditorStatus} Vst3EditorStatus */
/** @typedef {import('../src/audio/nativeVst3Types.ts').Vst3EditorView} Vst3EditorView */
/** @typedef {import('../src/audio/nativeVst3Types.ts').Vst3Effect} Vst3Effect */
/** @typedef {import('../src/audio/nativeVst3Types.ts').Vst3State} Vst3State */

const CLASS_ID = '56535441 4741696E20616761696E'.replaceAll(' ', '').toUpperCase();
const effect = {
  path: 'C:\\Program Files\\Common Files\\VST3\\AGain.vst3',
  classId: CLASS_ID,
  name: 'AGain',
  vendor: 'Steinberg Media Technologies',
  version: '3.8.0',
  state: { schema: 1, classId: CLASS_ID, parameters: [{ id: 0, value: 0.5 }] },
};
const context = { projectId: 'proj-1', trackId: 3, slotId: 'vst3-fx-1' };
const finalState = {
  schema: 1, classId: CLASS_ID, component: '0102',
  parameters: [{ id: 0, value: 0.75 }],
};

/** @typedef {[string, ...unknown[]]} Call */
/** @param {{ close?: () => Promise<Vst3EditorStatus>, poll?: () => Promise<Vst3EditorStatus> }} script */
function fakeBridge(script) {
  /** @type {Call[]} */
  const calls = [];
  const bridge = {
    paths: async () => [],
    choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }),
    discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); },
    inspectEffect: async () => { throw new Error('unused'); },
    describe: async () => ({ parameters: [], controllerAvailable: true }),
    describeEffect: async () => ({ parameters: [], controllerAvailable: true }),
    parameters: async () => [],
    open: async () => ({ id: 'x', latencySamples: 0 }),
    process: async () => new Float32Array(0),
    processAudio: async () => new Float32Array(0),
    close: async () => {},
    openEditor: async (opened, where) => {
      calls.push(['openEditor', opened.path, opened.classId, where]);
      return {
        id: 'editor-1', classId: CLASS_ID, name: 'AGain', title: 'Apex Studio VST3 Editor - AGain',
        resizable: true, width: 320, height: 200, controllerAvailable: true,
        parameters: [{ id: 0, name: 'Gain', shortTitle: 'Gain', units: 'dB', defaultValue: 0.5,
          currentValue: 0.5, flags: 1, stepCount: 0 }],
      };
    },
    pollEditor: async (id) => {
      calls.push(['pollEditor', id]);
      if (!script.poll) throw new Error('no poll script');
      return script.poll();
    },
    closeEditor: async (id) => {
      calls.push(['closeEditor', id]);
      if (!script.close) throw new Error('no close script');
      return script.close();
    },
    finishEditor: async (id, committed) => { calls.push(['finishEditor', id, committed]); },
  };
  return { bridge, calls };
}

/** @returns {Vst3EditorStatus} */
const openStatus = (/** @type {Partial<Vst3EditorStatus>} */ patch = {}) => ({
  id: 'editor-1', closed: false, events: [{ type: 'begin', id: 0 }, { type: 'perform', id: 0, value: 0.75 }, { type: 'end', id: 0 }],
  editedParameters: [{ id: 0, value: 0.75 }], activeEditIds: [], dirty: false, eventQueueOverflow: false, ...patch,
});
/** @returns {Vst3EditorStatus} */
const closedStatus = (/** @type {Partial<Vst3EditorStatus>} */ patch = {}) =>
  openStatus({ closed: true, state: finalState, ...patch });

/** @param {any} bridge @param {(state: Vst3State) => Promise<void>} commit */
function session(bridge, commit) {
  /** @type {Vst3EditorView[]} */
  const views = [];
  const instance = new NativeVst3EditorSession(bridge, effect, context, {
    onView: view => views.push(view), commit,
  });
  return { instance, views };
}

test('editor bridge is required before a session can be created', () => {
  const { bridge } = fakeBridge({});
  assert.equal(supportsNativeVst3Editor(bridge), true);
  assert.equal(supportsNativeVst3Editor(undefined), false);
  const partial = { ...bridge };
  delete partial.closeEditor;
  assert.equal(supportsNativeVst3Editor(partial), false);
});

test('a plug-in callback is reported, and the captured final state is committed exactly once', async () => {
  const { bridge, calls } = fakeBridge({ close: async () => closedStatus() });
  /** @type {Vst3State[]} */
  const committed = [];
  const { instance, views } = session(bridge, async state => { committed.push(state); });
  const opened = await instance.open();
  assert.equal(opened.classId, CLASS_ID);
  assert.deepEqual(calls[0], ['openEditor', effect.path, CLASS_ID, context]);

  const view = await instance.close();
  assert.equal(view.phase, 'committed');
  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0], finalState);
  assert.deepEqual(calls.at(-1), ['finishEditor', 'editor-1', true], 'the main process is told the state was stored');
  assert.deepEqual(view.editedParameterIds, [0]);
  assert.match(view.status, /one undoable change/);
  // Polling stops once the window is closed.
  const pollCount = calls.filter(call => call[0] === 'pollEditor').length;
  assert.equal(calls.filter(call => call[0] === 'pollEditor').length, pollCount);
});

test('closing twice shares one capture and never double-commits', async () => {
  let closes = 0;
  const { bridge } = fakeBridge({ close: async () => { closes += 1; return closedStatus(); } });
  /** @type {Vst3State[]} */
  const committed = [];
  const { instance } = session(bridge, async state => { committed.push(state); });
  await instance.open();
  const [a, b] = await Promise.all([instance.close(), instance.close()]);
  assert.equal(a.phase, 'committed');
  assert.equal(b.phase, 'committed');
  assert.equal(closes, 1);
  assert.equal(committed.length, 1);
});

test('a refused commit (project/slot replaced) keeps the capture as a recovery record', async () => {
  const { bridge, calls } = fakeBridge({ close: async () => closedStatus() });
  const { instance } = session(bridge, async () => { throw new Error('This insert was removed or relinked while the editor was open.'); });
  await instance.open();
  const view = await instance.close();
  assert.equal(view.phase, 'recovered');
  assert.match(view.error, /removed or relinked/);
  assert.match(view.status, /recovery record/);
  assert.deepEqual(calls.at(-1), ['finishEditor', 'editor-1', false], 'uncommitted state is handed to the main process for persistence');
});

test('a failed state capture never claims success and never commits', async () => {
  const { bridge } = fakeBridge({ close: async () => { throw new Error('VST3: Plugin failed to capture component state'); } });
  let commits = 0;
  const { instance } = session(bridge, async () => { commits += 1; });
  await instance.open();
  const view = await instance.close();
  assert.equal(view.phase, 'recovered');
  assert.equal(commits, 0);
  assert.match(view.error, /capture component state/);
});

test('a close response without state is treated as unusable, not as an empty project state', async () => {
  const { bridge, calls } = fakeBridge({ close: async () => closedStatus({ state: undefined }) });
  let commits = 0;
  const { instance } = session(bridge, async () => { commits += 1; });
  await instance.open();
  const view = await instance.close();
  assert.equal(view.phase, 'recovered');
  assert.equal(commits, 0);
  assert.deepEqual(calls.at(-1), ['finishEditor', 'editor-1', false]);
});

test('the plug-in window closing on its own commits through the poll loop', async () => {
  const { bridge, calls } = fakeBridge({
    poll: async () => (calls.filter(call => call[0] === 'pollEditor').length > 1 ? closedStatus() : openStatus()),
  });
  /** @type {Vst3State[]} */
  const committed = [];
  const { instance, views } = session(bridge, async state => { committed.push(state); });
  await instance.open();
  const deadline = Date.now() + 5000;
  while (!committed.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(committed.length, 1, 'a user-closed plug-in window still saves its final state');
  assert.deepEqual(calls.at(-1), ['finishEditor', 'editor-1', true]);
  assert.ok(views.some(view => view.phase === 'committed'));
  await instance.close();
  assert.equal(committed.length, 1, 'a later explicit close does not commit again');
});

test('discard never commits, closes the native window, and leaves recovery to main', async () => {
  const { bridge, calls } = fakeBridge({ close: async () => closedStatus() });
  let commits = 0;
  const { instance } = session(bridge, async () => { commits += 1; });
  await instance.open();
  const view = await instance.discard();
  assert.equal(commits, 0);
  assert.equal(view.phase, 'recovered');
  assert.deepEqual(calls.filter(call => call[0] === 'closeEditor').length, 1);
  assert.deepEqual(calls.at(-1), ['finishEditor', 'editor-1', false]);
});

test('a repeated editor failure stops polling instead of spinning forever', async () => {
  const { bridge, calls } = fakeBridge({ poll: async () => { throw new Error('Native VST3 editor helper failed'); } });
  const { instance } = session(bridge, async () => { throw new Error('must not commit'); });
  await instance.open();
  const deadline = Date.now() + 5000;
  while (instance.currentView.phase !== 'failed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(instance.currentView.phase, 'failed');
  assert.match(instance.currentView.error, /helper failed/);
  const polls = calls.filter(call => call[0] === 'pollEditor').length;
  assert.ok(polls <= 3, `polling is bounded (${polls} polls)`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls.filter(call => call[0] === 'pollEditor').length, polls, 'no polling after the failure');
});

test('opening an unavailable editor fails without touching project state', async () => {
  const { bridge } = fakeBridge({});
  bridge.openEditor = async () => { throw new Error('The VST3 plug-in did not provide a genuine Windows editor view.'); };
  const { instance, views } = session(bridge, async () => { throw new Error('must not commit'); });
  await assert.rejects(instance.open(), /did not provide a genuine Windows editor view/);
  assert.equal(views.at(-1)?.phase, 'failed');
  assert.match(views.at(-1)?.status ?? '', /could not be opened/);
});

test('an editor response for a different class is rejected instead of committing foreign state', async () => {
  const { bridge } = fakeBridge({});
  bridge.openEditor = async () => ({
    id: 'editor-x', classId: 'A'.repeat(32), name: 'Other', title: 'Other', resizable: false,
    width: 100, height: 100, controllerAvailable: true, parameters: [],
  });
  const { instance } = session(bridge, async () => { throw new Error('must not commit'); });
  await assert.rejects(instance.open(), /invalid/);
  assert.equal(instance.currentView.phase, 'failed');
});

test('the renderer editor bridge, IPC handlers and package allowlist are wired together', () => {
  const root = process.cwd();
  const preload = readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  const main = readFileSync(path.join(root, 'desktop-vst3.cjs'), 'utf8');
  const mixer = readFileSync(path.join(root, 'src/components/Mixer.tsx'), 'utf8');
  const app = readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  for (const operation of ['openEditor', 'pollEditor', 'closeEditor', 'finishEditor', 'editorRecovery', 'dismissEditorRecovery']) {
    assert.ok(preload.includes(`vst3:${operation}`), `preload exposes vst3:${operation}`);
    assert.ok(main.includes(`handle('${operation}'`), `main registers vst3:${operation}`);
  }
  assert.ok(main.includes('validateEditorRecoveryRecord'), 'recovery data is validated before it is written');
  assert.ok(main.includes('persistEditorRecovery'), 'recovery data is persisted');
  assert.ok(main.includes("app.on('before-quit'"), 'quitting captures an open editor first');
  assert.ok(mixer.includes('onOpenVst3Editor'), 'the Mixer offers the genuine editor window');
  assert.ok(app.includes('Vst3EditorWindowPanel'), 'the editor panel is rendered');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const file of ['preload.cjs', 'desktop-vst3.cjs', 'native/vst3/service.mjs', 'native/vst3/parameters.mjs',
    'native/vst3/client.mjs', 'native/vst3/editor-host.hpp']) {
    if (file.endsWith('.hpp')) continue; // C++ source, compiled into the staged helper
    assert.ok(pkg.build.files.includes(file), `packaged module ${file}`);
  }
});

test('the editor panel states plainly what the native window is doing', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Vst3EditorWindowPanel } = await import('../src/components/Vst3EditorWindowPanel.tsx');
  /** @type {Vst3EditorView} */
  const view = {
    phase: 'open', name: 'AGain', status: 'The plug-in’s own editor window is open.',
    editedParameterIds: [0, 3], activeEditIds: [3], dirty: true, error: '',
  };
  const html = renderToStaticMarkup(React.createElement(Vst3EditorWindowPanel, {
    view, busy: false, onClose() {}, onDismiss() {},
  }));
  assert.match(html, /Native VST3 editor · AGain/);
  assert.match(html, /separate Windows window/);
  assert.match(html, /2 parameters changed by the plug-in/);
  assert.match(html, /1 gesture\(s\) in progress/);
  assert.match(html, /Close editor and save state/);

  const done = renderToStaticMarkup(React.createElement(Vst3EditorWindowPanel, {
    view: { ...view, phase: 'committed', activeEditIds: [], dirty: false }, busy: false, onClose() {}, onDismiss() {},
  }));
  assert.match(done, /Dismiss/);
  assert.doesNotMatch(done, /Close editor and save state/);
});

test('a native close failure is reported through the protocol, never through a modal dialog', () => {
  const root = process.cwd();
  const editorHost = readFileSync(path.join(root, 'native/vst3/editor-host.hpp'), 'utf8');
  // Regression: nativeCloseFromWindow() used to raise MessageBoxW on the helper's
  // UI thread when state capture failed. A modal dialog cannot be dismissed without
  // a human click, so it froze the helper, blocked every later editorPoll, and made
  // an unattended or automated session hang forever with the editor stuck open.
  assert.ok(!/MessageBoxW?\s*\(/.test(editorHost),
    'the editor helper must not show a modal message box on its UI thread');
  assert.ok(editorHost.includes('lastNativeCloseError'),
    'a capture failure is still surfaced to the caller');
  assert.ok(/lastCloseFailurePending\s*=\s*true/.test(editorHost),
    'a capture failure is recorded as pending so the failure state is observable');
  // The window must stay open for a retry, as before: the failure is not silently
  // swallowed and partial state is still never published.
  assert.ok(editorHost.includes('closeFailurePending'), 'the pending close failure is exposed');
});

test('the editor helper exposes read-only window diagnostics and no product path depends on them', () => {
  const root = process.cwd();
  const editorHost = readFileSync(path.join(root, 'native/vst3/editor-host.hpp'), 'utf8');
  const host = readFileSync(path.join(root, 'native/vst3/host.cpp'), 'utf8');
  const client = readFileSync(path.join(root, 'native/vst3/client.mjs'), 'utf8');
  assert.ok(editorHost.includes('json windowDiagnostics('), 'window state is observable');
  // Every field comes from a real Win32 call, so the evidence cannot be fabricated.
  for (const call of ['IsWindowVisible', 'GetWindowTextW', 'GetClientRect', 'WindowFromPoint']) {
    assert.ok(editorHost.includes(call), `diagnostics read real Win32 state via ${call}`);
  }
  assert.ok(host.includes('"editorDiagnostics"'), 'the helper answers a diagnostics command');
  assert.ok(client.includes('async editorDiagnostics('), 'the client can read diagnostics');
  // The seam must not be reachable from product code.
  assert.ok(!/editorTestAction|editorDiagnostics/.test(readFileSync(path.join(root, 'native/vst3/service.mjs'), 'utf8')),
    'the product service never calls the acceptance seam');
});

test('the editor window is explicitly shown twice so a hidden helper start cannot keep it invisible', () => {
  const editorHost = readFileSync(path.join(process.cwd(), 'native/vst3/editor-host.hpp'), 'utf8');
  // Win32 honours STARTUPINFO.wShowWindow for the FIRST ShowWindow call of a
  // process. Node spawns helpers with windowsHide:true (SW_HIDE), so a single
  // ShowWindow(SW_SHOWNORMAL) created the window, attached the plug-in, and left
  // it invisible: the user never saw an editor. Showing twice makes it stick.
  const shows = [...editorHost.matchAll(/ShowWindow\(window, (SW_[A-Z]+)\)/g)].map(m => m[1]);
  assert.ok(shows.length >= 2, `expected a second ShowWindow, saw ${JSON.stringify(shows)}`);
  assert.ok(shows.includes('SW_SHOWNORMAL'), 'the window is shown normally');
  assert.ok(shows.includes('SW_SHOW'), 'and shown again so STARTUPINFO cannot override it');
  // Visibility is asserted, not assumed.
  assert.ok(editorHost.includes('IsWindowVisible(window)'),
    'the helper checks the window really is visible before reporting success');
});

test('content scaling is judged by the plug-in\'s response, never by the requested factor', () => {
  const editorHost = readFileSync(path.join(process.cwd(), 'native/vst3/editor-host.hpp'), 'utf8');
  // Regression: a 96-DPI runner with an absent (or ignored) scale interface passed
  // the old check because it compared its own variable with its own variable.
  assert.ok(editorHost.includes('IPlugViewContentScaleSupport'), 'the interface is looked up');
  assert.ok(editorHost.includes('setContentScaleFactor'), 'the factor is actually sent');
  // All three outcomes must stay distinguishable.
  for (const value of ['kResultFalse', 'kNotImplemented', 'kResultTrue']) {
    assert.ok(editorHost.includes(value), `result ${value} is distinguished`);
  }
  // And the evidence records the observed size change, not just the request.
  assert.ok(editorHost.includes('clientWidthBefore') && editorHost.includes('clientWidthAfter'),
    'the client size before and after the scale change is recorded');
  assert.ok(editorHost.includes('pluginRequestedResize'),
    'a plug-in-requested resize after scaling is recorded');
});

test('focus loss is proved by a real focus transition, not by calling onFocus directly', () => {
  const editorHost = readFileSync(path.join(process.cwd(), 'native/vst3/editor-host.hpp'), 'utf8');
  const host = readFileSync(path.join(process.cwd(), 'native/vst3/host.cpp'), 'utf8');
  assert.ok(editorHost.includes('WM_KILLFOCUS') && editorHost.includes('WM_SETFOCUS'),
    'focus transitions come from real window messages');
  assert.ok(/focusLossCount/.test(editorHost), 'focus losses are counted, not assumed');
  assert.ok(/lastFocusLossSucceeded/.test(editorHost), 'the plug-in\'s onFocus(0) result is recorded');
  assert.ok(host.includes('ensureFocusSink'), 'a real second window is created to steal focus');
  assert.ok(/focusSinkOwnsFocus/.test(host), 'the evidence shows focus really moved');
});

test('mouse acceptance uses real OS input instead of posting to the parent window', () => {
  const editorHost = readFileSync(path.join(process.cwd(), 'native/vst3/editor-host.hpp'), 'utf8');
  const host = readFileSync(path.join(process.cwd(), 'native/vst3/host.cpp'), 'utf8');
  // Regression: the harness used to SendMessage the parent HWND, which proves only
  // that the host accepts messages, not that the plug-in receives anything.
  assert.ok(editorHost.includes('SendInput'), 'real OS input is injected');
  assert.ok(editorHost.includes('WindowFromPoint'), 'the OS hit-test result is recorded');
  assert.ok(editorHost.includes('hitIsChildWindow'), 'child-window attribution is recorded');
  assert.ok(/hostMouseDownCount/.test(editorHost),
    'whether the host window swallowed the click is recorded');
  assert.ok(!/injectMouse\(\s*WM_LBUTTONDOWN/.test(host),
    'the parent-window click injection path is gone');
});

test('packaged acceptance uses the purpose-built acceptance fixture', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // No pinned SDK sample is simultaneously a policy-compliant stereo effect, a
  // genuine VSTGUI editor, and one whose controller exposes what its editor edits.
  // Apex therefore ships its own test-only fixture for this run.
  assert.ok(script.includes('apex-acceptance-vst3.vst3'), 'the packaged run uses ApexAcceptanceGain');
  assert.ok(/ApexAcceptanceGain/i.test(script), 'the fixture is matched by its registered name');
  assert.ok(!/again\.vst3/.test(script), 'AGain is not used for the packaged Mixer path');
  // And the host policies the fixture was designed around must be untouched.
  const host = readFileSync(path.join(process.cwd(), 'native/vst3/host.cpp'), 'utf8');
  assert.ok(host.includes('VST3 audio effects with event input buses are not supported'),
    'the event-input-bus policy is still enforced verbatim');
  assert.ok(host.includes('unknown or read-only ParamID') ||
    host.includes('ParamID'), 'parameter identity validation still exists');
});

test('the acceptance fixture is test-only and never staged into a packaged build', () => {
  const cmake = readFileSync(path.join(process.cwd(), 'native/vst3/CMakeLists.txt'), 'utf8');
  assert.ok(/APEX_BUILD_ACCEPTANCE_FIXTURE/.test(cmake), 'the fixture has its own build option');
  // \s+ rather than \n\s+: a Windows checkout has CRLF line endings, and this
  // assertion must not silently depend on the platform that runs it.
  assert.ok(/if\(APEX_BUILD_VST3_EDITOR_FIXTURE\)\s+smtg_add_vst3plugin\(apex-acceptance-vst3/.test(cmake),
    'the VSTGUI bundle half only builds with VSTGUI support');
  // Nothing in the packaging path may pick it up.
  const pkg = readFileSync(path.join(process.cwd(), 'scripts/build-native-vst3.mjs'), 'utf8');
  assert.ok(/apex-acceptance-vst3-test/.test(pkg), 'the DSP test builds everywhere');
  assert.ok(/targets\.push\('apex-acceptance-vst3'\)/.test(pkg),
    'the editor bundle is added explicitly, and only on Windows');
});

test('the packaged acceptance environment enables its own hook, not the smoke hook', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  const main = readFileSync(path.join(process.cwd(), 'electron.cjs'), 'utf8');
  const preload = readFileSync(path.join(process.cwd(), 'preload.cjs'), 'utf8');
  // Regression: every launch previously omitted APEX_ACCEPTANCE, so the renderer
  // hook and the test-only plug-in root were never enabled and the run failed at
  // discovery. One launchEnv() helper now guarantees it.
  assert.ok(/APEX_ACCEPTANCE: '1'/.test(script), 'the acceptance flag is set for launches');
  assert.ok(/function launchEnv/.test(script), 'a single launch environment is used');
  assert.ok(!/APEX_SMOKE_TEST: '1'/.test(script), 'the acceptance run does not borrow the smoke flag');
  assert.ok(main.includes('--apex-packaged-acceptance'), 'the main process passes the renderer flag');
  assert.ok(preload.includes('packagedAcceptance'), 'the preload exposes the flag');
  assert.ok(preload.includes("APEX_ACCEPTANCE === '1'") === false, 'flags stay in the main process');
  assert.ok(main.includes("APEX_ACCEPTANCE === '1'"), 'only the main process reads the env flag');
});

test('the packaged acceptance fixture is actually built', () => {
  const build = readScript();
  // Regression: the harness looked for a bundle the build never produced, so
  // discovery failed on every run. Whatever the harness targets must be built.
  const harness = readScript('scripts/packaged-editor-acceptance.mjs');
  const wanted = harness.match(/Release\/([a-z0-9-]+\.vst3)/)?.[1];
  assert.ok(wanted, 'the harness names the bundle it needs');
  assert.ok(build.includes(`'${wanted.replace(/\.vst3$/, '')}'`),
    `${wanted} is built by scripts/build-native-vst3.mjs`);
  // It is a VSTGUI editor fixture, so it stays Windows-only.
  assert.ok(/if \(process\.platform === 'win32'\)[\s\S]{0,400}apex-acceptance-vst3/.test(build),
    'the editor fixture bundle stays Windows-only');
  // The cross-platform DSP test must still build everywhere: it sits in the base
  // targets array, before any platform guard. Scope to that array -- the file also
  // selects a CMake generator with a win32 check much earlier.
  // lastIndexOf: `run(cmake` first occurs in the helper's own definition.
  const targetList = build.slice(build.indexOf('const targets = ['), build.lastIndexOf('run(cmake'));
  assert.ok(/apex-acceptance-vst3-test/.test(targetList.split("platform === 'win32'")[0]),
    'the DSP test target is unconditional');
});

test('the packaged run matches the fixture by its registered name', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  const entry = readFileSync(path.join(process.cwd(), 'native/vst3/acceptance-fixture-entry.cpp'), 'utf8');
  // The name the factory registers and the name the harness looks for must agree,
  // or discovery fails for a reason that looks like a host bug.
  assert.ok(entry.includes('#define stringPluginName "ApexAcceptanceGain"'), 'the factory name');
  assert.ok(/const EDITOR_FIXTURE_NAME = \/\^ApexAcceptanceGain\$\/i;/.test(script),
    'the harness matcher matches the registered name exactly');
});

test('setProcessing accepts kNotImplemented but still rejects real errors', () => {
  const host = readFileSync(path.join(process.cwd(), 'native/vst3/host.cpp'), 'utf8');
  // IAudioProcessor::setProcessing has no failure semantics in the VST3 contract
  // and the SDK's AudioEffect base returns kNotImplemented. The DataExchange
  // sample (our packaged editor fixture) inherits that, so a strict kResultOk
  // gate made it unloadable: "setProcessing failed (VST result -2147467263)".
  assert.ok(/void checkedProcessing\(tresult result, const std::string& message\) \{\s*require\(result == kResultOk \|\| result == kNotImplemented,/.test(host),
    'kNotImplemented is tolerated for setProcessing');
  assert.strictEqual((host.match(/checked\(processor->setProcessing/g) ?? []).length, 0,
    'no setProcessing call site uses the strict gate');
  assert.strictEqual((host.match(/checkedProcessing\(processor->setProcessing/g) ?? []).length, 5,
    'every setProcessing call site uses the tolerant gate');
});

test('p1 drives the real Mixer UI and never substitutes a test-only handler', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // The previous version fell back to an acceptance hook when the insert row did
  // not render, and reported that as UI acceptance. That fallback is gone.
  assert.ok(!/openEditorOnInsert/.test(script), 'no test-only open path is used');
  assert.ok(!/insert row not rendered/.test(script), 'no fallback is claimed');
  // The real control chain must be present, in order.
  assert.ok(/getByTitle\('Add Effect Plugin'\)/.test(script), 'the real "+" button');
  assert.ok(/name: 'Native VST3 Effect'/.test(script), 'the real picker entry point');
  assert.ok(/getByRole\('button', \{ name: \/ApexAcceptanceGain\/ \}\)/.test(script),
    'the fixture is chosen from the real picker list');
  // The picker row's accessible name is "<name> · <vendor><path>", so discovery's
  // anchored EDITOR_FIXTURE_NAME matcher cannot be reused for the click; the
  // criterion must say what the picker reported so a missing row is diagnosable.
  assert.ok(/pickerStatusText/.test(script), 'the picker status is recorded');
  assert.ok(/pickerRowLabel/.test(script), 'the matched row label is recorded');
  assert.ok(/name: 'Open VST3 editor'/.test(script), 'the real editor control');
  assert.ok(/ui\.insertRowRendered = true/.test(script), 'the rendered insert row is recorded');
});

test('the packaged run cross-checks that a VST3 insert really reached the project', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // A rendered row is not enough on its own; the project must agree an insert of
  // type 'vst3' exists, so a UI-only illusion cannot pass.
  assert.ok(/vst3InsertCountInProject/.test(script), 'the insert count is read from project state');
  assert.ok(/filter\(slot => slot\.type === 'vst3'\)/.test(script), 'only real vst3 slots count');
  assert.ok(/ui\.vst3InsertCountInProject !== 0/.test(script), 'a zero insert count cannot pass p1');
});

test('the packaged run builds its effect from the inspected result', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // inspectEffect resolves to the effect itself. Reading .effect off it produced
  // an identity-less insert that openEditor rightly rejected.
  assert.ok(!/inspected\?\.effect/.test(script), 'does not read a non-existent .effect wrapper');
  assert.ok(/inspected \?\? \{\}/.test(script), 'spreads the inspected effect');
  assert.ok(/no usable identity\/state/.test(script), 'reports a bad inspection by name');
});

test('acceptance slots are resolved by identity, not position', () => {
  const app = readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
  const readInsert = app.slice(app.indexOf('readInsertParameter: async'));
  // The parameter readout looked at track 0 while inserts live on track 1, so p3
  // could never see the edited value.
  assert.ok(/readInsertParameter: async \(trackId: number, slotId\?: string\)/.test(app),
    'parameter readout is told which track and slot to read');
  assert.ok(!/mixerTracks\[0\]\?\.fxSlots\.filter\(slot => slot\.type === 'vst3'\)\[slotIndex\]/.test(readInsert),
    'no positional lookup on a hardcoded track');
  assert.ok(/is not a VST3 insert/.test(app), 'a non-VST3 slot is reported, not opened');
});

test('every non-PASS criterion states why in an annotation', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  assert.ok(/ACCEPTANCE-DETAIL \$\{id\} \$\{status\}/.test(script),
    'FAIL/NOT_VERIFIED reasons are visible without downloading artifacts');
});

test('a crashed helper is reported by its own reason, not a later generic error', async () => {
  // Regression: the service drops the dead session on the first failed poll, so
  // attempts 2 and 3 answer "closed or belongs to another renderer". The panel
  // published the LAST message, so the real cause ("VST3 helper exited ...") was
  // reported as a foreign-owner error -- which is why the Windows packaged run
  // showed only "No native editor session is open" with no root cause.
  let polls = 0;
  const { bridge } = fakeBridge({
    poll: async () => {
      polls += 1;
      if (polls === 1) throw new Error('VST3 helper exited (3). helper crashed: editorHostInit failed');
      throw new Error('VST3 editor session is closed or belongs to another renderer.');
    },
  });
  const { instance, views } = session(bridge, async () => {});
  await instance.open();
  // Let the poll loop fail MAX_POLL_FAILURES (3) times at 120ms intervals.
  await new Promise(resolve => setTimeout(resolve, 900));
  const failed = views.filter(v => v.phase === 'failed');
  assert.ok(failed.length > 0, 'the session reaches a failed phase');
  const error = failed.at(-1).error;
  assert.match(error, /helper crashed|helper exited/i, 'the crash reason survives to the UI');
  assert.doesNotMatch(error, /belongs to another renderer/, 'a later generic error does not replace it');
});

test('the AGain audio-policy row measures the refusal instead of assuming it', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/native-editor-windows-acceptance.mjs'), 'utf8');
  const host = readFileSync(path.join(process.cwd(), 'native/vst3/host.cpp'), 'utf8');
  // It used to be a hardcoded NOT_VERIFIED, so nobody learned whether the policy
  // still held. It now opens AGain and requires the exact refusal.
  assert.ok(/expectedPolicy = \/VST3 audio effects with event input buses are not supported\//.test(script),
    'the harness requires the exact policy message');
  assert.ok(/openedSession: refusal === null/.test(script), 'it records that no session was created');
  assert.ok(host.includes('VST3 audio effects with event input buses are not supported'),
    'the policy message is still the host\'s own');
});

test('the packaged run samples for a short-lived window instead of glancing once', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // One read at +4s missed helpers that were reaped earlier, so p1 reported
  // "no window" even when a window had appeared.
  assert.ok(/while \(Date\.now\(\) < deadline\)/.test(script), 'reads are taken across a window');
  assert.ok(/observationSamples: samples/.test(script), 'every sample is kept as evidence');
  assert.ok(!/await page\.waitForTimeout\(4000\); \/\/ let the helper spawn/.test(script),
    'no single-shot read remains');
});

test('a criterion is only FAIL when the host was actually shown to be wrong', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // p2/p3 used to fail whenever no window appeared, which reads as a host defect
  // even when the bundled fixture is the reason no window could appear.
  assert.ok(/!windowEverObserved \? 'NOT_VERIFIED'/.test(script), 'p2 does not fail without an observation');
  assert.ok(/edited\?\.phase === 'failed' \? 'FAIL' : 'NOT_VERIFIED'/.test(script),
    'p3 fails on a real rejection, not on absence');
  assert.ok(/fixtureLimit:/.test(script), 'the fixture limit is named in the evidence');
});

test('a correct policy rejection is not scored as a host failure', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // The DataExchange editor edits UI-only parameters. The host rejecting those is
  // right, so p3/p4/p5 must be NOT_VERIFIED (fixture block), not FAIL.
  assert.ok(/fixtureRejection = \/unknown or read-only ParamID\//.test(script), 'the policy rejection is recognised');
  assert.ok(/blockedByFixture \? 'NOT_VERIFIED' : 'FAIL'/.test(script), 'p4 inherits the block');
  assert.ok(/blockedByFixture \? 'NOT_VERIFIED' : 'FAIL', \{ blockedByFixture, \.\.\.undoRedo \}/.test(script),
    'p5 inherits the block');
});

test('p8 opens a real editor through the UI before crashing one', () => {
  const script = readScript('scripts/packaged-editor-acceptance.mjs');
  // Recovery is only meaningful for an editor a user could actually open, so p8
  // drives the same visible controls as p1 rather than a test-only opener.
  assert.ok(/openEditorThroughMixerUi\(page3\)/.test(script),
    'p8 opens the editor through the real Mixer UI');
  assert.ok(!/openEditorOnInsert/.test(script), 'no test-only opener is used anywhere');
  assert.ok(/blockedByFixture: false/.test(script),
    'a fixture excuse is no longer reported for p8');
  assert.ok(/openedThroughMixerUi: reopen\.ok/.test(script),
    'the reopen result is part of the evidence');
  assert.ok(/!reopen\.ok \? 'NOT_VERIFIED'/.test(script),
    'a failed reopen is a block, not a crash-recovery verdict');
});

// ---- Keyboard and mouse delivery proof (acceptance harness) ----------------
// These pin the specific defects the Lead Engineer identified: a test that passes
// without ever observing delivery, and a "received" counter that was really an
// attempt counter.

test('keyboard acceptance requires OS input and observes real receipts', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/native-editor-windows-acceptance.mjs'), 'utf8');
  const start = script.indexOf("criterion('5-keyboard'");
  const body = script.slice(start, script.indexOf("criterion('6-mouse-wheel'", start));

  // Real OS input, not a hand-posted window message.
  assert.ok(/SendInput/.test(readFileSync(path.join(process.cwd(), 'native/vst3/editor-host.hpp'), 'utf8')),
    'the host uses SendInput for keyboard input');
  assert.ok(!/PostMessageW\([^)]*WM_KEYDOWN/.test(script), 'no WM_KEYDOWN is hand-posted');
  assert.ok(!/WM_KEYDOWN VK_TAB'/.test(body) || /SendInput/.test(body), 'the criterion names the real method');

  // The verdict must depend on observation, not on the window merely existing.
  for (const required of [
    /sendInputAcceptedDown === 1/,
    /windowSawKeyDown/,
    /windowSawKeyUp/,
    /viewGotKeyDown/,
    /viewGotKeyUp/,
    /rightKeyDown/,
    /rightKeyUp/,
  ]) assert.match(body, required);
  assert.ok(!/stillAttached: keyAfter\.attached,\s*focusOwnedByWindow/.test(body),
    'an attached window alone is no longer the pass condition');
});

test('mouse-wheel acceptance counts only what a receiver observed', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/native-editor-windows-acceptance.mjs'), 'utf8');
  const start = script.indexOf("criterion('6-mouse-wheel'");
  const body = script.slice(start, script.indexOf("criterion('7-focus'", start));

  // The old non-discriminating condition must be gone. Strip comments first: the
  // criterion documents the old bug, and that documentation is not the bug.
  const code = body.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/>= 0\b/.test(code), 'no assertion that is true of every count');

  // And the new verdict must be built from receiver-side counters.
  for (const required of [
    /wheelMessageCount/,
    /viewWheelCount/,
    /deltaMatchesTheSentEvent/,
    /observedEventIsTheInjectedOne/,
    /const pathA =/,
    /const pathB =/,
  ]) assert.match(body, required);

  // C++ side: the attempt counter must not also be the receipt counter.
  const host = readFileSync(path.join(process.cwd(), 'native/vst3/editor-host.hpp'), 'utf8');
  const wheelCase = host.slice(host.indexOf('case WM_MOUSEWHEEL:'));
  assert.ok(/wheelMessageCount\+\+/.test(wheelCase.slice(0, 700)),
    'WM_MOUSEWHEEL raises a receipt counter in the WndProc');
  assert.ok(/viewWheelCount\+\+/.test(wheelCase.slice(0, 900)),
    'IPlugView::onWheel invocation is counted');
  // injectedWheelCount may only be bumped in the injection helper.
  const injectionSite = host.indexOf('injectedWheelCount++');
  const wndProc = host.indexOf('case WM_MOUSEWHEEL:');
  assert.ok(injectionSite > wndProc, 'injectedWheelCount is not raised inside the WndProc');
});

test('the acceptance fixture builds, is test-only, and proves its own DSP', () => {
  const cmake = readFileSync(path.join(process.cwd(), 'native/vst3/CMakeLists.txt'), 'utf8');
  const test = readFileSync(path.join(process.cwd(), 'native/vst3/acceptance-fixture-test.cpp'), 'utf8');
  const proc = readFileSync(path.join(process.cwd(), 'native/vst3/acceptance-fixture-processor.cpp'), 'utf8');

  // Stereo, and no event buses: the two properties that make it a legal insert.
  assert.ok(/addAudioInput\(USTRING\("Stereo In"\), SpeakerArr::kStereo\)/.test(proc));
  assert.ok(/addAudioOutput\(USTRING\("Stereo Out"\), SpeakerArr::kStereo\)/.test(proc));
  assert.ok(!/addEventInput/.test(proc), 'the fixture declares no event input bus');

  // The processor and controller must agree on the parameter id.
  const ctrl = readFileSync(path.join(process.cwd(), 'native/vst3/acceptance-fixture-controller.cpp'), 'utf8');
  assert.ok(/kParamGain/.test(proc) && /kParamGain/.test(ctrl), 'one shared parameter id');

  // The behavioural test must actually assert measured audio.
  assert.ok(/boost\.leftRms \/ inputRms/.test(test), 'the gain is measured, not asserted');
  assert.ok(/a parameter change applies within the block that delivered it/.test(test));
  assert.ok(/NO event input bus/.test(test));

  // Test-only.
  assert.ok(/APEX_BUILD_ACCEPTANCE_FIXTURE/.test(cmake));

  // The SDK's own instruction: vstsinglecomponenteffect.cpp already #includes
  // vsteditcontroller.cpp, so listing both defines ProgramList and
  // ProgramListWithPitchNames twice (MSVC LNK2005). Linux hid this because nothing
  // pulled both in, so assert it here rather than waiting for a Windows build.
  const code = cmake.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.ok(!/vsteditcontroller\.cpp/.test(code),
    'vsteditcontroller.cpp is never compiled alongside vstsinglecomponenteffect.cpp');
});

test('the acceptance-only input hook is unreachable outside an acceptance run', () => {
  const desktop = readFileSync(path.join(process.cwd(), 'desktop-vst3.cjs'), 'utf8');
  const start = desktop.indexOf("handle('editorInput'");
  const body = desktop.slice(start, start + 600);
  assert.ok(/process\.env\.APEX_ACCEPTANCE !== '1'/.test(body),
    'the hook refuses to run unless APEX_ACCEPTANCE is set');
  assert.ok(/throw new Error/.test(body), 'it throws rather than silently no-oping');
  // It injects input; it must not fabricate a parameter change.
  const service = readFileSync(path.join(process.cwd(), 'native/vst3/service.mjs'), 'utf8');
  const svc = service.slice(service.indexOf('async editorInput('));
  assert.ok(/sendEditorMouse/.test(svc.slice(0, 1200)), 'it routes real injected input');
  assert.ok(!/performEdit|setParamNormalized/.test(svc.slice(0, 1600)),
    'it never synthesises a parameter change');
});

test('the keyboard criterion expects the SDK keycode, not a remembered one', () => {
  const script = readSource('scripts/native-editor-windows-acceptance.mjs');
  const start = script.indexOf("criterion('5-keyboard'");
  const body = script.slice(start, script.indexOf("criterion('6-mouse-wheel'", start));
  const expected = Number(body.match(/const KEY_TAB = (\d+);/)?.[1]);
  assert.ok(Number.isInteger(expected), 'the criterion states the keycode explicitly');

  // Derive KEY_TAB from the pinned SDK enum instead of trusting the literal.
  // KEY_BACK = 1, KEY_TAB is the next enumerator.
  const header = readSource('build/native-deps/vst3sdk/pluginterfaces/base/keycodes.h');
  const enumBody = header.slice(header.indexOf('enum VirtualKeyCodes'));
  const names = [...enumBody.slice(0, enumBody.indexOf('}')).matchAll(/^\s*(KEY_[A-Z0-9_]+)/gm)]
    .map(match => match[1]);
  const tabIndex = names.indexOf('KEY_TAB');
  assert.ok(tabIndex >= 0, 'KEY_TAB is present in the SDK enum');
  const backValue = Number(enumBody.match(/KEY_BACK\s*=\s*(\d+)/)?.[1]);
  assert.equal(expected, backValue + tabIndex,
    `KEY_TAB must be ${backValue + tabIndex} per the pinned keycodes.h, not ${expected}`);
});

test('one keystroke is one onKeyDown invocation, not two', () => {
  const host = readSource('native/vst3/editor-host.hpp');
  // WM_CHAR describes the same stroke as WM_KEYDOWN; counting it as another
  // onKeyDown corrupted both the invocation count and the recorded keycode.
  const charCase = host.slice(host.indexOf('case WM_CHAR:'));
  const block = charCase.slice(0, charCase.indexOf('case WM_DESTROY:'));
  assert.ok(!/viewKeyDownCount\+\+/.test(block), 'WM_CHAR does not raise viewKeyDownCount');
  assert.ok(!/lastViewKeyDownKeycode\s*=/.test(block), 'WM_CHAR does not overwrite the keycode');
  assert.ok(!/onKeyDown\(/.test(block), 'WM_CHAR does not invoke onKeyDown again');
  assert.ok(/keyCharMessageCount\+\+/.test(block), 'WM_CHAR is still observed, separately');
});

test('the fixture declares its controller class, so PlugProvider can load it', () => {
  const processor = readSource('native/vst3/acceptance-fixture-processor.cpp');
  const test_ = readSource('native/vst3/acceptance-fixture-test.cpp');
  // PluginHost::PlugProvider::initialize() asks the component for its controller
  // class id and fails outright on kResultFalse. Constructing the two classes side
  // by side -- which is all the DSP test used to do -- never exercises that, so the
  // fixture could be constructible and still unloadable by every real host.
  assert.match(processor, /setControllerClass\(kControllerUID\)/,
    'the component registers its companion controller');
  assert.ok(/the declared controller id is the registered controller class/.test(test_),
    'the behavioural test asserts the id the factory registers');
  assert.ok(/getControllerClassId returns kResultTrue/.test(test_),
    'the behavioural test asserts the real load-path precondition');
});

test('the acceptance fixture uidesc is well-formed XML', () => {
  // VSTGUI parses this at createView time. A malformed file yields no view, so the
  // plug-in reports a null/zero size and the host correctly refuses to open a
  // window with "invalid or unsupported initial size" -- a message that points at
  // the host while the fault is in the layout file. Nothing else in the repository
  // parsed it, so it shipped broken while every other fixture check was green.
  const xml = readSource('native/vst3/resources/acceptancegain.uidesc');
  // `--` is illegal inside an XML comment, which is how this broke.
  for (const comment of xml.match(/<!--[\s\S]*?-->/g) ?? []) {
    const body = comment.slice(4, -3);
    assert.ok(!body.includes('--'), 'no XML comment contains a double hyphen');
  }
  // Element balance, which catches everything a double hyphen did.
  const tagPattern = /<\s*(\/?)\s*([A-Za-z_][\w.:-]*)([^>]*?)(\/?)\s*>/g;
  const stack = [];
  for (const match of xml.matchAll(tagPattern)) {
    const [, closing, name, attrs, selfClosing] = match;
    if (closing) { assert.equal(stack.pop(), name, `unbalanced </${name}>`); continue; }
    if (selfClosing || attrs.trimEnd().endsWith('/')) continue;
    stack.push(name);
  }
  assert.deepEqual(stack, [], 'every element is closed');

  // And the layout must still describe the editor the host opens.
  assert.match(xml, /class="CViewContainer"[^>]*size="320, 120"/, 'the root view is 320x120');
  assert.match(xml, /control-tag="Gain"/, 'the Gain control still targets ParamID 0');
});

test('the packaged Gain click is derived from the real uidesc nesting', () => {
  const script = readScript('scripts/packaged-editor-acceptance.mjs');
  const xml = readSource('native/vst3/resources/acceptancegain.uidesc');
  const pair = raw => raw.split(',').map(part => Number(part.trim()));

  const panel = xml.match(/name="panel"[^>]*origin="([^"]+)"[^>]*size="([^"]+)"/) ??
    xml.match(/origin="([^"]+)"[^>]*size="([^"]+)"[^>]*name="panel"/);
  assert.ok(panel, 'the panel container declares an origin and size');
  const [panelX, panelY] = pair(panel[1]);

  const slider = xml.match(/class="CSlider"[^>]*origin="([^"]+)"[^>]*size="([^"]+)"/) ??
    xml.match(/origin="([^"]+)"[^>]*size="([^"]+)"[^>]*class="CSlider"/);
  assert.ok(slider, 'the Gain slider declares an origin and size');
  const [sliderX, sliderY] = pair(slider[1]);
  const [sliderWidth, sliderHeight] = pair(slider[2]);

  // The slider's origin is relative to its parent panel. Both offsets must appear
  // in the script, or the click lands somewhere the control is not.
  assert.ok(new RegExp(`panelOrigin: \\{ x: ${panelX}, y: ${panelY} \\}`).test(script),
    `the panel offset (${panelX},${panelY}) is used`);
  assert.ok(new RegExp(`origin: \\{ x: ${sliderX}, y: ${sliderY} \\}`).test(script),
    `the slider offset (${sliderX},${sliderY}) is used`);
  assert.ok(new RegExp(`width: ${sliderWidth}, height: ${sliderHeight}`).test(script),
    'the slider size is used to centre the click');
});

test('the acceptance click sends a press and a release', () => {
  // A press with no release leaves the button down for every later event: the
  // control sees a drag that never ends and commits no value. p3 injected only
  // MOUSEEVENTF_LEFTDOWN, so the plug-in never reported an edit -- the criterion
  // was right to report no edit, and the injection was the defect.
  const host = readSource('native/vst3/editor-host.hpp');
  assert.ok(/MOUSEEVENTF_LEFTDOWN/.test(host), 'the press is sent');
  assert.ok(/MOUSEEVENTF_LEFTUP/.test(host), 'the release is sent');
  assert.ok(/isUp/.test(host), 'up is a distinct action, not another press');

  const service = readSource('native/vst3/service.mjs');
  assert.ok(/\['move', 'down', 'up', 'wheel'\]/.test(service), 'the service accepts up');

  const app = readSource('src/App.tsx');
  const hook = app.slice(app.indexOf('driveEditorWithRealInput'), app.indexOf('closeOpenEditor'));
  assert.ok(/editorInput\(id, step\.action/.test(hook), 'every step goes through the real-input IPC');
  assert.ok(/'down'/.test(hook) && /'up'/.test(hook), 'the renderer sends both halves of the click');
  // A press exactly where the handle already is computes the value the control
  // already holds, so VSTGUI's isDirty() is false and no performEdit is emitted.
  // That is why a well-aimed click produced no edit while the binding was fine.
  assert.ok(/action: 'move', point: start \},/.test(hook), 'the pointer lands on the handle first');
  assert.ok(/action: 'down', point: start \}/.test(hook), 'the press happens on the handle');
  assert.ok(/action: 'move', point: target \}/.test(hook),
    'the gesture moves between the press and the release, so the value actually changes');
  assert.ok(/whyDrag/.test(hook), 'the evidence states why a click is not enough');
});

test('the recovery crash kills the real helper and is acceptance-only', () => {
  const desktop = readScript('desktop-vst3.cjs');
  const start = desktop.indexOf("handle('editorCrash'");
  assert.ok(start > 0, 'the crash hook exists');
  const body = desktop.slice(start, start + 700);
  assert.ok(/process\.env\.APEX_ACCEPTANCE !== '1'/.test(body),
    'the hook refuses to run outside an acceptance run');
  assert.ok(/getEditorHelperPid/.test(body),
    'the pid is observed from the spawned child, not from app bookkeeping');
  assert.ok(/process\.kill\(pid, 'SIGKILL'\)/.test(body), 'the real helper is killed');

  const app = readSource('src/App.tsx');
  const hook = app.slice(app.indexOf('crashEditorAndRecover'), app.indexOf('undoRedoRoundTrip'));
  assert.ok(/bridge\.editorCrash\(sessionId\)/.test(hook), 'the renderer crashes the real helper');
  assert.ok(/killedPid/.test(hook), 'the killed pid is reported as evidence');
  // Without a kill the session stays open and recovery is never exercised.
  assert.ok(!/^ {8}crashEditorAndRecover: async \(\) => \{\n {10}const session[\s\S]{0,400}await new Promise\(resolve => setTimeout\(resolve, 2500\)\);$/m.test(hook),
    'the hook no longer merely waits and hopes');
});

test('every control-tag used by the uidesc is declared in the control-tag table', () => {
  const xml = readSource('native/vst3/resources/acceptancegain.uidesc');
  // UIDescription::getTagForName() looks the name up in <control-tags> and then
  // asks the controller; a name in neither place resolves to -1, and a control
  // whose tag is -1 is bound to nothing, so it can never emit
  // beginEdit/performEdit/endEdit. That is exactly how the Gain slider silently
  // produced no parameter change at all.
  const declared = new Map([...xml.matchAll(/<control-tag\s+name="([^"]+)"\s+tag="(\d+)"/g)]
    .map(match => [match[1], Number(match[2])]));
  assert.ok(declared.size > 0, 'the uidesc declares a control-tag table');

  const used = [...xml.matchAll(/control-tag="([^"]+)"/g)].map(match => match[1]);
  assert.ok(used.length > 0, 'the layout binds at least one control');
  for (const name of used) {
    assert.ok(declared.has(name), `control-tag "${name}" is declared in <control-tags>`);
  }

  // And the table must name the same parameter the controller exposes, or the
  // binding points at a parameter that does not exist.
  const controller = readSource('native/vst3/acceptance-fixture-controller.cpp');
  const gainId = Number(controller.match(/kParamGain\s*=\s*(\d+)/)?.[1]
    ?? readSource('native/vst3/acceptance-fixture.hpp').match(/kParamGain\s*=\s*(\d+)/)?.[1]);
  assert.equal(declared.get('Gain'), gainId,
    'the Gain control-tag resolves to the controller parameter id');
});

test('undo/redo comparison uses the representation history stores', () => {
  const app = readSource('src/App.tsx');
  // The hook runs until the next acceptance member; crashEditorAndRecover appears
  // EARLIER in the file, so slicing to it would produce an empty string.
  const start = app.indexOf('undoRedoRoundTrip');
  const rest = app.slice(start + 'undoRedoRoundTrip'.length);
  const hook = rest.slice(0, rest.search(/\n {6}\w+: async \(/) === -1 ? rest.length
    : rest.search(/\n {6}\w+: async \(/));
  assert.ok(hook.includes('comparable'), 'the round trip body was found');
  // History stores sanitizeProjectSnapshot(state), a normalise + document round
  // trip, so the restored state is the sanitized form. Comparing it against the raw
  // pre-undo object reported a redo failure that did not exist.
  assert.ok(/import \{ canonicalProjectJson, sanitizeProjectSnapshot \}/.test(app),
    'the sanitizer history uses is imported');
  assert.ok(/sanitizeProjectSnapshot\(state\)/.test(hook),
    'the round trip snapshots the same way history does');
  // Key order is a real defect, not a test artefact: history decides whether to
  // record an entry with the same canonical form, so if the two disagree history
  // records an entry the round trip then calls a change. Assert the SHARED helper is
  // used on both sides rather than a local sort that can drift.
  assert.ok(/canonicalProjectJson\(/.test(hook), 'the round trip uses the shared canonical form');
  const history = readSource('src/state/projectHistory.ts');
  assert.ok(/export const canonicalProjectJson/.test(history), 'history exports it');
  assert.ok(/getSemanticComparable = \(state: ProjectState\): string => \{[\s\S]{0,200}canonicalProjectJson\(/.test(history),
    'history decides equality with that same canonical form');
});
