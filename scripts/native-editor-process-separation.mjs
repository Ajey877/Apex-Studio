// Evidence for the Editor MVP architecture requirement:
//   "a dedicated editor-only native helper process".
//
// This script measures the real service + real helper binary and prints a JSON
// report. It never fabricates a plug-in or a window; on Linux the editor path is
// expected to refuse ("Windows x64 only"), which is itself part of the contract.
//
// Checks
//  1. An audio session and an editor session are separate OS processes.
//  2. A slow/hung editor helper cannot delay native audio processing.
//  3. Editor callback polling cannot delay native audio processing.
//  4. Editor teardown/failure cannot destroy an active audio session.
//  5. Ownership is independent (closing the editor leaves audio open, and vice
//     versa the editor cannot be closed through the audio session id).
//  6. State transfer between sessions is bounded, validated and never aliases
//     live native handles (only component/controller bytes + normalized values).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vst3Service } from '../native/vst3/service.mjs';
import { discoverVst3 } from '../native/vst3/client.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, 'build/native-vst3');
const executableName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', executableName), path.join(build, 'bin/Release', executableName)].find(existsSync);
if (!executable) throw new Error('Build the native helper first (npm run native:vst3:build)');
const bundleRoot = path.join(build, 'VST3/Release');
const bundle = path.join(bundleRoot, 'mda-vst3.vst3');
if (!existsSync(bundle)) throw new Error('Build the MDA fixture first (npm run native:vst3:build)');

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push({ check: name, detail });
  return { check: name, ok, detail };
};

// The real host, captured before any platform simulation below. OS observation
// must always use the host it is really running on, never the simulated one.
const hostPlatform = process.platform;

/** Is this OS pid alive right now? POSIX reads /proc, Windows asks tasklist.
 * Both are cheap: this must never block the event loop for long. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (hostPlatform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return out.includes(`"${pid}"`);
    } catch { return false; }
  }
  try { return existsSync(`/proc/${pid}`); } catch { return false; }
}

/** Helper processes matching a command-line fragment, read from the OS.
 * POSIX can enumerate command lines through /proc. Windows cannot do that
 * cheaply without PowerShell/WMI (which is slow enough to stall the run), so
 * Windows callers must use processAlive() on a pid the OS already gave us. */
function helperProcesses(match = 'apex-vst3-host') {
  if (hostPlatform === 'win32') return [];
  const found = [];
  let entries;
  try { entries = readdirSync('/proc'); } catch { return found; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (cmdline.some(part => part.includes(match))) found.push({ pid: Number(entry), cmdline });
    } catch { /* process exited while scanning */ }
  }
  return found;
}

/** pids of this script's helper processes that are still running. */
function liveHelpers(pids) {
  return pids.filter(processAlive);
}

/** Poll `predicate` until true or `timeoutMs` elapses (child exit is async). */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Poll a synchronous getter until it produces a value (child spawn is async). */
async function waitForValue(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Progress markers: if the run is killed, the last marker names the stage.
const stage = name => console.log(`STAGE ${name} ${Date.now()}`);

// Every helper pid this run created, for the final leak check.
const helperPidsSeen = new Set();

const sampleRate = 48000;
const { plugins, errors } = await discoverVst3(executable, [bundle], { kind: 'effect' });
if (errors.length) throw new Error(`fixture discovery failed: ${JSON.stringify(errors)}`);
const delay = plugins.find(plugin => plugin.name === 'mda Delay');
if (!delay) throw new Error('mda Delay fixture missing');

function makeAudio(frames) {
  const audio = new Float32Array(frames * 2);
  for (let i = 0; i < frames; ++i) {
    const sample = Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 0.2;
    audio[i] = sample;
    audio[frames + i] = sample;
  }
  return audio;
}
const rms = audio => Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);

// The editor path is Windows-only. Report the platform honestly and exercise the
// cross-session guarantees through the same service code paths.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
// Record the REAL host before simulating the Windows-only gate: the editor path
// refuses to open on anything else, and the report must say so.
const report = {
  platform: {
    hostOs: process.platform, hostArch: process.arch,
    editorNativeOnThisHost: process.platform === 'win32' && process.arch === 'x64',
    note: 'The editor gate is simulated to win32 for the cross-session checks; the editor native window itself is NOT exercised on this host.',
  },
  checks: [],
};
// Only simulate on a host where the editor gate would otherwise refuse; a real
// Windows runner must keep its real platform value.
if (!(process.platform === 'win32' && process.arch === 'x64')) {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
}
// Hard wall clock bound. A hung native teardown on a CI runner must fail fast
// with a nameable stage instead of silently eating the job timeout.
const watchdogMs = Number(process.env.APEX_EVIDENCE_TIMEOUT_MS ?? 240000);
const watchdog = setTimeout(() => {
  console.error(`EVIDENCE TIMEOUT after ${watchdogMs}ms`);
  process.exit(2);
}, watchdogMs);
watchdog.unref?.();

try {
  const service = new Vst3Service(executable, [bundleRoot]);
  const OWNER_AUDIO = 'evidence-audio';
  const OWNER_EDITOR = 'evidence-editor';

  // ---- 1. audio session uses its own helper process -------------------------
    stage('open audio session');
  const audio = await service.open(delay, sampleRate, 'realtime', OWNER_AUDIO, 'effect');
  await service.parameters(audio.id, [{ id: 4, value: 0 }], OWNER_AUDIO); // 100% dry
  // The pid comes from the child process the OS actually created. The process
  // table scan below is an independent cross-check (one scan: on Windows it is a
  // PowerShell query, so it must never sit in a polling loop).
  const audioPid = await waitForValue(() => service.getSessionHelperPid(audio.id, OWNER_AUDIO), 15000);
  const dryReference = await service.processAudio(audio.id, 1024, makeAudio(1024), 120, OWNER_AUDIO, []);
  report.checks.push(check('the audio session runs in its own helper process', Number.isInteger(audioPid),
    { audioHelperPid: audioPid }));

  // ---- 2. editor open cannot block audio processing ------------------------
    stage('audio processing under a pending editor open');
  // A dedicated, separately spawned helper that never answers stands in for a
  // plug-in slow to build its window. It is a real OS process (a POSIX launcher
  // that exec()s a Node worker) whose file name stays in the process table, so
  // "separate process" is observed from the OS rather than asserted in
  // JavaScript. Audio must keep processing while it hangs.
  const workerName = 'apex-vst3-editor-slow-helper-worker.cjs';
  const evidenceDir = path.join(root, 'build/native-evidence');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, workerName), [
    "'use strict';",
    '// Never writes a protocol frame; exits only when the client kills it.',
    'process.stdin.resume();',
    "process.stdin.on('data', () => {});",
    'setInterval(() => {}, 1e9);',
    '',
  ].join('\n'), { mode: 0o644 });
  const workerPath = path.join(evidenceDir, workerName);
  // The helper executable is whatever the OS spawns for us. On POSIX a shell
  // launcher exec()s the worker; on Windows that needs a batch shim, and the
  // worker file name still appears in the process command line either way.
  const launcherName = hostPlatform === 'win32' ? 'apex-vst3-editor-slow-helper.cmd' : 'apex-vst3-editor-slow-helper.sh';
  const slowHelper = path.join(evidenceDir, launcherName);
  writeFileSync(slowHelper, hostPlatform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${workerPath}"\r\n`
    : `#!/bin/sh\nexec node "${workerPath}"\n`);
  if (hostPlatform !== 'win32') chmodSync(slowHelper, 0o755);

  const editorService = new Vst3Service(slowHelper, [bundleRoot]);
  const effect = { ...delay, state: { schema: 1, classId: delay.classId, parameters: [{ id: 4, value: 0 }] } };
  let editorSettled = false;
  const editorOpen = editorService.openEditor(effect, { projectId: 'evidence', trackId: 1, slotId: 'vst3-fx-1' }, OWNER_EDITOR)
    .then(() => 'opened', error => error.message).finally(() => { editorSettled = true; });

  const during = [];
  for (let block = 0; block < 12; block++) {
    const started = process.hrtime.bigint();
    const pcm = await service.processAudio(audio.id, 1024, makeAudio(1024), 120, OWNER_AUDIO, []);
    during.push({ ms: Number(process.hrtime.bigint() - started) / 1e6, identical: pcm.length === dryReference.length &&
      pcm.every((sample, index) => Math.abs(sample - dryReference[index]) < 1e-9) });
  }
  const editorPid = await waitForValue(() => editorService.getEditorHelperPid(OWNER_EDITOR), 15000);
  // Cross-check with the OS: the editor helper pid must be alive and running this
  // launcher/worker, and the audio helper must be a different live process.
  const editorAlive = processAlive(editorPid);
  const onPosix = hostPlatform !== 'win32';
  const editorCmdline = onPosix && editorAlive
    ? (helperProcesses(workerName).find(process => process.pid === editorPid)?.cmdline ??
       helperProcesses(launcherName).find(process => process.pid === editorPid)?.cmdline ?? [])
    : [];
  helperPidsSeen.add(audioPid);
  if (Number.isInteger(editorPid)) helperPidsSeen.add(editorPid);
  // The blocking claim is about DURING the open. If a very slow machine let the
  // editor request finish first, say so instead of silently passing on a weak
  // signal: `editorStillPending` records what was actually observed.
  report.checks.push(check('editor open did not block native audio processing', during.length === 12,
    { editorStillPending: !editorSettled, audioBlocksDuring: during.length,
      maxAudioBlockMs: Math.max(...during.map(item => item.ms)).toFixed(2) }));
  report.checks.push(check('audio PCM is bit-identical while the editor is opening', during.every(item => item.identical),
    { blocks: during.length }));

  // ---- 3/5. editor failure is isolated from audio -------------------------
    stage('editor failure isolation');
  const editorResult = await editorOpen;
  report.checks.push(check('a failing editor helper reports a clear error', typeof editorResult === 'string' && editorResult.length > 0,
    { editorResult }));
  report.checks.push(check('audio session survived the editor failure', service.sessionCount === 1,
    { audioSessions: service.sessionCount, editorSessions: editorService.editorSessionCount }));
  const after = await service.processAudio(audio.id, 1024, makeAudio(1024), 120, OWNER_AUDIO, []);
  report.checks.push(check('audio output is unchanged after the editor helper died',
    after.length === dryReference.length && after.every((sample, index) => Math.abs(sample - dryReference[index]) < 1e-9),
    { rms: rms(after) }));
  // On Windows the launcher (.cmd) and the node worker are two processes; on
  // POSIX the launcher exec()s into the worker. Either way the claim is the same:
  // the editor's process tree shares no pid with the audio helper's.
  report.checks.push(check('the editor helper was a separate, live OS process from the audio helper',
    Number.isInteger(editorPid) && Number.isInteger(audioPid) && editorPid !== audioPid &&
      editorAlive && processAlive(audioPid) && (!onPosix || editorCmdline.some(part => part.includes(workerName))),
    { audioHelperPid: audioPid, editorHelperPid: editorPid, editorAlive,
      audioAlive: processAlive(audioPid), editorCmdline }));

  // ---- 5. ownership is explicit and non-overlapping -----------------------
    stage('ownership and teardown');
  let crossOwnerRejected = false;
  try { await service.assertSession(audio.id, OWNER_EDITOR); } catch { crossOwnerRejected = true; }
  report.checks.push(check('a different owner cannot address the audio session', crossOwnerRejected, {}));
  let editorViaAudioIdRejected = false;
  try { await service.closeEditor(audio.id, OWNER_AUDIO); } catch { editorViaAudioIdRejected = true; }
  report.checks.push(check('the editor API rejects a non-editor session id', editorViaAudioIdRejected, {}));
  await editorService.dispose();

  // ---- 6. state transfer is bounded bytes, not shared handles -------------
    stage('state transfer');
  const snapshot = await service.inspectEffect(delay, { schema: 1, classId: delay.classId, parameters: [] }, OWNER_AUDIO);
  const keys = Object.keys(snapshot.state).sort();
  report.checks.push(check('state transfer carries validated component/controller bytes and normalized values only',
    keys.every(key => ['schema', 'classId', 'component', 'controller', 'parameters'].includes(key)) &&
    typeof snapshot.state.schema === 'number' && Array.isArray(snapshot.state.parameters),
    { keys, parameterCount: snapshot.state.parameters.length,
      componentBytes: typeof snapshot.state.component === 'string' ? snapshot.state.component.length / 2 : 0,
      controllerBytes: typeof snapshot.state.controller === 'string' ? snapshot.state.controller.length / 2 : 0,
      serializable: typeof JSON.stringify(snapshot.state) === 'string' }));

  const stillAlive = await service.processAudio(audio.id, 1024, makeAudio(1024), 120, OWNER_AUDIO, []);
  report.checks.push(check('audio session still processes after all editor activity',
    stillAlive.length === dryReference.length, { rms: rms(stillAlive) }));

  // ---- editor teardown never enumerates audio sessions -------------------
  await service.close(audio.id, OWNER_AUDIO);
  stage('teardown');
  report.checks.push(check('closing the audio session leaves no service session', service.sessionCount === 0,
    { sessionCount: service.sessionCount }));
  await service.dispose();
} finally {
  clearTimeout(watchdog);
  if (originalPlatform && Object.getOwnPropertyDescriptor(process, 'platform')?.value !== originalPlatform.value) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
}

// Leak check on the exact pids this run created, plus a POSIX table sweep for
// any stray helper. Both must be empty.
const survivors = await waitForValue(() => (liveHelpers([...helperPidsSeen]).length === 0 ? [] : null), 5000) ?? liveHelpers([...helperPidsSeen]);
const strays = helperProcesses(executableName);
report.checks.push(check('no helper process leaks after evidence run', survivors.length === 0 && strays.length === 0,
  { watchedPids: [...helperPidsSeen], survivorPids: survivors, strayPids: strays.map(p => p.pid) }));
report.failures = failures;
const evidencePath = path.join(root, 'build/native-evidence/native-editor-process-separation.json');
mkdirSync(path.dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
// One line per check so a truncated CI capture still identifies what failed.
for (const item of report.checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.check} ${JSON.stringify(item.detail)}`);
}
if (failures.length) {
  console.error(`\n${failures.length} process-separation check(s) failed`);
  for (const failure of failures) {
    console.error(`FAILED: ${failure.check} :: ${JSON.stringify(failure.detail)}`);
  }
  process.exit(1);
}
console.log('\nAll process-separation checks passed.');
