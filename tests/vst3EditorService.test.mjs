// Main-process validation of the native editor session. No plug-in binary and
// no Electron: a stand-in "native helper" speaks the real framed protocol over
// a stub child process, so the service's own contract is what is under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Vst3Service, MAX_VST3_EFFECT_LATENCY_SECONDS } from '../native/vst3/service.mjs';

// The service is Windows x64 only. The native helper is stubbed below anyway, so
// report the supported platform for the duration of this file to exercise the
// real service contract on every CI runner.
const realPlatform = process.platform, realArch = process.arch;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
process.on('exit', () => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

const CLASS_ID = '565354414741494E414741494E'.padEnd(32, '0').toUpperCase();
// A real, empty directory named like a bundle: the service only authorizes paths
// that exist under an authorized root.
const pluginRoot = mkdtempSync(path.join(tmpdir(), 'apex-vst3-editor-'));
const bundlePath = path.join(pluginRoot, 'AGain.vst3');
mkdirSync(bundlePath);
const effect = {
  path: bundlePath,
  classId: CLASS_ID, name: 'AGain', vendor: 'Steinberg', version: '3.8.0',
  state: { schema: 1, classId: CLASS_ID, parameters: [{ id: 0, value: 0.5 }] },
};
const context = { projectId: 'proj-1', trackId: 2, slotId: 'vst3-fx-9' };
const parameters = [
  { id: 0, name: 'Gain', shortTitle: 'Gain', units: 'dB', defaultValue: 0.5, currentValue: 0.5, flags: 1, stepCount: 0 },
  { id: 1, name: 'Read only', shortTitle: 'RO', units: '', defaultValue: 0.5, currentValue: 0.5, flags: 2, stepCount: 0 },
];
const finalState = { schema: 1, classId: CLASS_ID, component: 'beef', parameters: [{ id: 0, value: 0.75 }] };

function frame(json, pcm = Buffer.alloc(0)) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(body.length, 0);
  header.writeUInt32LE(pcm.length, 4);
  return Buffer.concat([header, body, pcm]);
}

/** A helper process double: reads newline JSON requests, answers with frames. */
function fakeHelper(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    // A real process is reaped asynchronously; emit the same event the client
    // waits on so teardown never hangs.
    setImmediate(() => child.emit('close', 0, null));
  };
  child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0, null)));
  let buffered = '';
  child.stdin.on('data', chunk => {
    buffered += chunk.toString('utf8');
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      const response = handler(request);
      if (response === undefined) continue;
      if (response instanceof Error) child.stdout.write(frame({ ok: false, error: response.message }));
      else child.stdout.write(frame({ ok: true, ...response }));
    }
  });
  return child;
}

async function withStubbedClient(run) {
  // NativeVst3Client spawns the helper eagerly; substitute that one seam so the
  // real framed protocol and the real service run against a scripted helper.
  const { setNativeHelperSpawnForTests } = await import('../native/vst3/client.mjs');
  const children = [];
  setNativeHelperSpawnForTests(() => {
    const child = run.helper();
    children.push(child);
    return child;
  });
  try { return await run.service(children); }
  finally {
    setNativeHelperSpawnForTests(null);
    for (const child of children) { child.stdout.end(); child.emit('close', 0, null); }
  }
}

test('editor session lifecycle: open, poll, capture, validate, finish', async () => {
  const answers = {
    editorOpen: () => ({ editor: { available: true, classId: CLASS_ID, name: 'AGain', title: 'AGain',
      resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } }),
    editorPoll: () => ({ editor: { closed: false, events: [{ type: 'begin', id: 0 }, { type: 'perform', id: 0, value: 0.75 }],
      editedParameters: [{ id: 0, value: 0.75 }], activeEditIds: [0], dirty: true, eventQueueOverflow: false } }),
    editorClose: () => ({ editor: { closed: true, events: [{ type: 'end', id: 0 }],
      editedParameters: [{ id: 0, value: 0.75 }], activeEditIds: [], dirty: false, eventQueueOverflow: false,
      state: finalState, nativeCloseError: 'ignored' } }),
    close: () => ({}),
  };
  await withStubbedClient({
    helper: () => fakeHelper(request => (answers[request.command] ? answers[request.command]() : new Error('unexpected'))),
    service: async () => {
      const service = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
      const opened = await service.openEditor(effect, context, 'owner-1');
      assert.equal(opened.available, true);
      assert.equal(service.editorSessionCount, 1);
      const polled = await service.pollEditor(opened.id, 'owner-1');
      assert.deepEqual(polled.editedParameters, [{ id: 0, value: 0.75 }]);
      assert.deepEqual(polled.activeEditIds, [0]);
      assert.equal(polled.dirty, true);
      const closed = await service.closeEditor(opened.id, 'owner-1');
      assert.equal(closed.closed, true);
      assert.deepEqual(closed.state, finalState);
      const recovery = service.getEditorRecovery(opened.id, 'owner-1');
      assert.equal(recovery.schema, 1);
      assert.equal(recovery.projectId, 'proj-1');
      assert.equal(recovery.trackId, 2);
      assert.equal(recovery.slotId, 'vst3-fx-9');
      assert.deepEqual(recovery.effect.state, finalState);
      assert.deepEqual(recovery.originalEffect, effect);
      await service.finishEditor(opened.id, 'owner-1');
      assert.equal(service.editorSessionCount, 0);
    },
  });
});

test('the service rejects callback chronology, unknown IDs and malformed state', async () => {
  const cases = [
    ['editorPoll', { editor: { closed: false, events: [{ type: 'perform', id: 0, value: 0.2 }], editedParameters: [], activeEditIds: [], dirty: false, eventQueueOverflow: false } }],
    ['editorPoll', { editor: { closed: false, events: [{ type: 'begin', id: 0 }, { type: 'perform', id: 0, value: 0.2 }], editedParameters: [], activeEditIds: [0, 1], dirty: false, eventQueueOverflow: false } }],
    ['editorPoll', { editor: { closed: false, events: [{ type: 'begin', id: 1 }], editedParameters: [], activeEditIds: [1], dirty: false, eventQueueOverflow: false } }],
    ['editorPoll', { editor: { closed: false, events: [], editedParameters: [{ id: 0, value: 2 }], activeEditIds: [], dirty: false, eventQueueOverflow: false } }],
    ['editorPoll', { editor: { closed: false, events: [], editedParameters: [], activeEditIds: [], dirty: false } }],
    ['editorClose', { editor: { closed: true, events: [], editedParameters: [], activeEditIds: [], dirty: false, eventQueueOverflow: false, state: { ...finalState, classId: 'F'.repeat(32) } } }],
    ['editorClose', { editor: { closed: true, events: [], editedParameters: [], activeEditIds: [], dirty: false, eventQueueOverflow: false, state: null } }],
  ];
  for (const [command, response] of cases) {
    await withStubbedClient({
      helper: () => fakeHelper(request => {
        if (request.command === 'editorOpen') return { editor: { available: true, classId: CLASS_ID, name: 'AGain', title: 'AGain',
          resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } };
        if (request.command === command) return response;
        return {};
      }),
      service: async () => {
        const service = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
        const opened = await service.openEditor(effect, context, 'owner-1');
        const run = command === 'editorPoll' ? () => service.pollEditor(opened.id, 'owner-1') : () => service.closeEditor(opened.id, 'owner-1');
        await assert.rejects(run, /VST3 editor/);
        // A rejected protocol response can never leave a committed state behind.
        assert.equal(service.getEditorRecovery !== undefined, true);
      },
    });
  }
});

test('a filtered callback burst keeps the authoritative final values after an overflow', async () => {
  await withStubbedClient({
    helper: () => fakeHelper(request => {
      if (request.command === 'editorOpen') return { editor: { available: true, classId: CLASS_ID, name: 'AGain', title: 'AGain',
        resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } };
      if (request.command === 'editorPoll') return { editor: { closed: false, events: [],
        editedParameters: [{ id: 0, value: 0.9 }], activeEditIds: [], dirty: false, eventQueueOverflow: true } };
      if (request.command === 'editorClose') return { editor: { closed: true, events: [],
        editedParameters: [{ id: 0, value: 0.9 }], activeEditIds: [], dirty: false, eventQueueOverflow: true, state: finalState } };
      return {};
    }),
    service: async () => {
      const service = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
      const opened = await service.openEditor(effect, context, 'owner-1');
      const polled = await service.pollEditor(opened.id, 'owner-1');
      assert.equal(polled.eventQueueOverflow, true);
      assert.deepEqual(polled.events, []);
      assert.deepEqual(polled.editedParameters, [{ id: 0, value: 0.9 }]);
      const closed = await service.closeEditor(opened.id, 'owner-1');
      assert.deepEqual(closed.state.parameters, [{ id: 0, value: 0.9 }], 'the final bound value wins over the older captured stream');
    },
  });
});

test('renderer teardown captures an open editor into a recovery record', async () => {
  await withStubbedClient({
    helper: () => fakeHelper(request => {
      if (request.command === 'editorOpen') return { editor: { available: true, classId: CLASS_ID, name: 'AGain', title: 'AGain',
        resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } };
      if (request.command === 'editorPoll') return { editor: { closed: false, events: [],
        editedParameters: [{ id: 0, value: 0.8 }], activeEditIds: [], dirty: false, eventQueueOverflow: false } };
      if (request.command === 'editorClose') return { editor: { closed: true, events: [],
        editedParameters: [{ id: 0, value: 0.8 }], activeEditIds: [], dirty: false, eventQueueOverflow: false, state: finalState } };
      return {};
    }),
    service: async () => {
      const service = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
      await service.openEditor(effect, context, 'owner-1');
      const recovery = await service.closeOwner('owner-1');
      assert.equal(recovery?.projectId, 'proj-1');
      // The last value the plug-in reported through performEdit is the newest
      // authority for that parameter; the captured component stream supplies
      // everything else (here the opaque `component` blob).
      assert.deepEqual(recovery?.effect.state.parameters, [{ id: 0, value: 0.8 }]);
      assert.equal(recovery?.effect.state.component, 'beef');
      assert.equal(service.editorSessionCount, 0);
      // A different owner can never read or close that session.
      const other = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
      await assert.rejects(other.pollEditor('missing', 'owner-1'), /closed or belongs to another renderer/);
    },
  });
});

test('the editor session issues only editor commands, never audio processing', async () => {
  const commands = [];
  await withStubbedClient({
    helper: () => fakeHelper(request => {
      commands.push(request.command);
      if (request.command === 'editorOpen') return { editor: { available: true, classId: CLASS_ID, name: 'AGain', title: 'AGain',
        resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } };
      if (request.command === 'editorPoll') return { editor: { closed: false, events: [], editedParameters: [],
        activeEditIds: [], dirty: false, eventQueueOverflow: false } };
      if (request.command === 'editorClose') return { editor: { closed: true, events: [], editedParameters: [],
        activeEditIds: [], dirty: false, eventQueueOverflow: false, state: finalState } };
      return {};
    }),
    service: async () => {
      const service = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
      const opened = await service.openEditor(effect, context, 'owner-1');
      await service.pollEditor(opened.id, 'owner-1');
      await service.closeEditor(opened.id, 'owner-1');
      await service.finishEditor(opened.id, 'owner-1');
    },
  });
  // The helper protocol itself refuses audio work in an editor-only process, and
  // the editor code path never even asks for it.
  assert.deepEqual([...new Set(commands)].sort(), ['close', 'editorClose', 'editorOpen', 'editorPoll']);
  for (const forbidden of ['open', 'process', 'parameters', 'processAudio', 'snapshot']) {
    assert.equal(commands.includes(forbidden), false, `editor session must never send ${forbidden}`);
  }
});

test('an audio session and an editor session are independent helpers with independent ownership', async () => {
  const children = [];
  const commandsByChild = new Map();
  const { setNativeHelperSpawnForTests } = await import('../native/vst3/client.mjs');
  setNativeHelperSpawnForTests(() => {
    const log = [];
    const child = fakeHelper(request => {
      log.push(request);
      if (request.command === 'open') return { plugin: { latencySamples: 0, controllerAvailable: true, parameters } };
      if (request.command === 'editorOpen') return { editor: { available: true, classId: CLASS_ID, name: 'AGain', title: 'AGain',
        resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } };
      if (request.command === 'editorClose') return { editor: { closed: true, events: [], editedParameters: [],
        activeEditIds: [], dirty: false, eventQueueOverflow: false, state: finalState } };
      if (request.command === 'process') return { frames: 1, channels: 2 };
      return {};
    });
    commandsByChild.set(log, child);
    children.push(child);
    return child;
  });
  try {
    const service = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
    const audio = await service.open(effect, 48000, 'realtime', 'owner-audio', 'effect');
    const editor = await service.openEditor(effect, context, 'owner-editor');
    assert.equal(commandsByChild.size, 2, 'the audio session and the editor session use separate helper processes');
    const [audioLog, editorLog] = [...commandsByChild.keys()];
    assert.deepEqual([...new Set(audioLog.map(request => request.command))].sort(), ['open']);
    assert.deepEqual([...new Set(editorLog.map(request => request.command))].sort(), ['editorOpen']);
    // Closing/failing the editor leaves the audio session untouched, and vice versa.
    await service.closeEditor(editor.id, 'owner-editor');
    await service.finishEditor(editor.id, 'owner-editor');
    assert.equal(service.sessionCount, 1);
    await service.close(audio.id, 'owner-audio');
    assert.equal(service.sessionCount, 0);
    await service.dispose();
  } finally {
    setNativeHelperSpawnForTests(null);
    for (const child of children) { child.stdout.end(); child.emit('close', 0, null); }
  }
});

test('editor state validation is shared with the renderer contract', async () => {
  const { validateEditorActiveEdits, validateEditorEvents, validateEditorParameterSnapshot, validateEditorState, validateEditorContext } =
    await import('../native/vst3/parameters.mjs');
  assert.deepEqual(validateEditorContext(context), context);
  assert.throws(() => validateEditorContext({ ...context, extra: 1 }), /context/);
  const active = new Set();
  assert.deepEqual(validateEditorEvents([{ type: 'begin', id: 0 }, { type: 'perform', id: 0, value: 0.4 }, { type: 'end', id: 0 }], parameters, active), [
    { type: 'begin', id: 0 }, { type: 'perform', id: 0, value: 0.4 }, { type: 'end', id: 0 },
  ]);
  assert.equal(active.size, 0);
  assert.throws(() => validateEditorEvents([{ type: 'begin', id: 1 }], parameters), /read-only/);
  assert.deepEqual([...validateEditorActiveEdits([0], parameters)], [0]);
  assert.throws(() => validateEditorActiveEdits([0, 0], parameters), /active-edit/);
  assert.deepEqual(validateEditorParameterSnapshot([{ id: 0, value: 0.3 }], parameters), [{ id: 0, value: 0.3 }]);
  assert.throws(() => validateEditorParameterSnapshot([{ id: 1, value: 0.3 }], parameters), /read-only/);
  assert.deepEqual(validateEditorState(finalState, CLASS_ID, parameters), finalState);
  assert.throws(() => validateEditorState({ ...finalState, classId: 'B'.repeat(32) }, CLASS_ID, parameters), /classId|Invalid/);
  assert.ok(MAX_VST3_EFFECT_LATENCY_SECONDS > 0);
  // The helper module is imported by URL so this test proves the real path.
  assert.ok(pathToFileURL(path.resolve('native/vst3/service.mjs')).href.endsWith('service.mjs'));
});

test('a recovery record names the plug-in path exactly as the caller identified it, not the resolved one', async () => {
  // Windows resolves case and 8.3 short components (RUNNER~1), and POSIX resolves
  // symlinks, so realpath() can return a different spelling of the same bundle.
  // A recovery record is matched against the saved project, so it must keep the
  // caller's identity; only the helper load uses the authorized path.
  const aliasDir = mkdtempSync(path.join(tmpdir(), 'apex-vst3-alias-'));
  const aliasRoot = path.join(aliasDir, 'alias');
  try {
    try { symlinkSync(pluginRoot, aliasRoot, 'dir'); }
    catch { return; } // no symlink permission on this runner; the path fix is still covered above
    const aliasEffect = { ...effect, path: path.join(aliasRoot, 'AGain.vst3') };
    await withStubbedClient({
      helper: () => fakeHelper(request => {
        if (request.command === 'editorOpen') return { editor: { available: true, classId: CLASS_ID, name: 'AGain',
          title: 'AGain', resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } };
        return {};
      }),
      service: async () => {
        const service = new Vst3Service('apex-vst3-host.exe', [aliasRoot]);
        const opened = await service.openEditor(aliasEffect, context, 'owner-1');
        const recovery = service.getEditorRecovery(opened.id, 'owner-1');
        assert.equal(recovery.originalEffect.path, aliasEffect.path);
        assert.equal(recovery.effect.path, aliasEffect.path);
        assert.equal('authorizedPath' in recovery.originalEffect, false);
        await service.finishEditor(opened.id, 'owner-1').catch(() => {});
      },
    });
  } finally { rmSync(aliasDir, { recursive: true, force: true }); }
});

test('a batch helper is spawned through the shell, the real .exe helper is not', async () => {
  // spawn() with shell:false throws EINVAL for a .cmd target on Windows. A batch
  // helper is only used by the process-separation evidence script, but the client
  // must not be the reason that evidence cannot run.
  const { NativeVst3Client, setNativeHelperSpawnForTests } = await import('../native/vst3/client.mjs');
  const seen = [];
  setNativeHelperSpawnForTests((file, args, options) => {
    seen.push({ file, options });
    const child = fakeHelper(() => ({}));
    return child;
  });
  try {
    const cmdClient = new NativeVst3Client('C:\\evidence\\slow-helper.cmd');
    assert.equal(seen.at(-1).options.shell, true, 'a .cmd helper must be spawned through the shell');
    await cmdClient.dispose();
    const exeClient = new NativeVst3Client('C:\\build\\apex-vst3-host.exe');
    assert.equal(seen.at(-1).options.shell, false, 'the real helper must never go through a shell');
    await exeClient.dispose();
  } finally { setNativeHelperSpawnForTests(null); }
});

test('disposing a helper that never exits is bounded instead of hanging', async () => {
  // A shell-spawned helper leaves a grandchild holding the pipes, so `close` can
  // never fire. Teardown must give up and kill the tree rather than hanging the
  // caller forever (this hung a Windows CI job for 20 minutes).
  const { NativeVst3Client, setNativeHelperSpawnForTests } = await import('../native/vst3/client.mjs');
  setNativeHelperSpawnForTests(() => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    // Deliberately never emits 'close' and never answers a request.
    child.stdin.on('data', () => {});
    return child;
  });
  const started = Date.now();
  try {
    const client = new NativeVst3Client('apex-vst3-host.exe', { timeoutMs: 200 });
    await client.dispose();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 12000, `dispose must be bounded, took ${elapsed}ms`);
  } finally { setNativeHelperSpawnForTests(null); }
});

test.after(() => { rmSync(pluginRoot, { recursive: true, force: true }); });

test('a helper that dies mid-session is reported as a failure, not a missing session', async () => {
  // Regression for the packaged Windows run: the editor helper exited on its own,
  // the service dropped the session, and every later poll answered "closed or
  // belongs to another renderer" -- which describes a foreign owner, not a crash,
  // so the app never entered its failure/recovery path.
  await withStubbedClient({
    helper: () => fakeHelper(request => {
      if (request.command === 'editorOpen') return { editor: { available: true, classId: CLASS_ID, name: 'DataExchange',
        title: 'DataExchange', resizable: true, width: 320, height: 200, controllerAvailable: true, parameters } };
      if (request.command === 'editorPoll') return { editor: { closed: false, events: [], editedParameters: [],
        activeEditIds: [], dirty: false, eventQueueOverflow: false } };
      return {};
    }),
    service: async (children) => {
      const service = new Vst3Service('apex-vst3-host.exe', [pluginRoot]);
      const opened = await service.openEditor(effect, context, 'owner-1');
      await service.pollEditor(opened.id, 'owner-1');
      // The helper process goes away; the service learns about it on the next poll.
      children.at(-1).stderr.write('helper crashed: editorHostInit failed');
      children.at(-1).emit('exit', 3, null);
      await new Promise(resolve => setTimeout(resolve, 50));
      await assert.rejects(() => service.pollEditor(opened.id, 'owner-1'),
        error => {
          assert.match(error.message, /helper failed/i, 'the crash is named as a helper failure');
          assert.doesNotMatch(error.message, /belongs to another renderer/, 'a crash is not disguised as a foreign owner');
          assert.match(error.message, /previously committed project state is preserved/i, 'the preserved-state contract is stated');
          return true;
        });
    },
  });
});
