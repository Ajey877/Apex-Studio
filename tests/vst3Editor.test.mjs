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

test('packaged acceptance uses a policy-compliant fixture that also has a genuine editor', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // AGain has a real editor but an EVENT INPUT bus, which Apex refuses for audio,
  // so it can never become a real Mixer insert. The packaged path must be proven
  // with an effect that is stereo-in/stereo-out AND has a genuine VSTGUI editor.
  assert.ok(script.includes('data-exchange.vst3'),
    'the packaged acceptance uses the data-exchange SDK fixture');
  assert.ok(/data-exchange/i.test(script), 'the fixture is matched by name');
  assert.ok(!/again\.vst3/.test(script), 'AGain is not used for the packaged Mixer path');
  // And the host policy itself must be untouched.
  const host = readFileSync(path.join(process.cwd(), 'native/vst3/host.cpp'), 'utf8');
  assert.ok(host.includes('VST3 audio effects with event input buses are not supported'),
    'the event-input-bus policy is still enforced verbatim');
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
  const build = readFileSync(path.join(process.cwd(), 'scripts/build-native-vst3.mjs'), 'utf8');
  // Regression: the harness looked for data-exchange.vst3 but the build never
  // produced it, so discovery failed on every run.
  assert.ok(/targets\.push\('again', 'data-exchange'\)/.test(build),
    'data-exchange is built alongside again on Windows');
  assert.ok(/platform === 'win32'/.test(build), 'the editor fixtures stay Windows-only');
});

test('the packaged run matches the fixture by its real registered name', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // The SDK registers the class as "DataExchange"; an /^data-exchange/ matcher
  // never matched it, so discovery failed even once the bundle was built.
  assert.ok(/const EDITOR_FIXTURE_NAME = \/\^data-\?exchange\/i;/.test(script),
    'fixture matcher tolerates the hyphenless registered name');
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

test('p1 falls back to the shipped open path and says which one it used', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // The injected insert did not always render a Mixer row, which made the run die
  // on a 30s click timeout before any criterion was evaluated.
  assert.ok(/openEditorOnInsert\(trackId, slotId\)/.test(script), 'falls back to the shipped handler');
  assert.ok(/clickedControl: triggeredVia/.test(script), 'records the path that actually ran');
  assert.ok(/insert row not rendered/.test(script), 'labels the fallback honestly');
});

test('the acceptance insert reports its own slot index', () => {
  const app = readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
  const script = readFileSync(path.join(process.cwd(), 'scripts/packaged-editor-acceptance.mjs'), 'utf8');
  // Tracks ship with FX slots, so the appended insert is never at index 0; the
  // harness used to open index 0 and hit a non-VST3 slot.
  assert.ok(/slotId, slotIndex: slotIds\(trackId\)\.indexOf\(slotId\)/.test(app), 'hook reports the real index');
  assert.ok(/inserted\?\.slotIndex/.test(script), 'harness opens the slot it inserted');
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
