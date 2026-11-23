// Native helper adapter; only the authorized service is exposed by Electron preload.
// One OS process per plugin instance. A crash/timeout rejects requests; this is
// failure containment, not a security sandbox. Plugins retain OS user privileges.
import { execFileSync, spawn } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Production always spawns the staged helper binary. Unit/integration tests use
// the setter below to substitute a protocol-faithful child process, because the
// real executable only exists after the Windows native build.
let spawnNativeHelper = spawn;
export function setNativeHelperSpawnForTests(factory) {
  spawnNativeHelper = factory ?? spawn;
}
const MAX_JSON = 5 * 1024 * 1024;
const MAX_PCM = 16384 * 2 * 4;
const MAX_REQUEST = 8 * 1024 * 1024;
// Response frames travel on their own pipe, the fourth stdio entry, which the
// helper is told about on its command line. The helper's stdout and stderr are
// diagnostics only: plug-ins print there (mda Piano does, from its audio loop),
// and anything sharing a pipe with the frames corrupts them.
export const PROTOCOL_FD = 3;
// Per stream, the most recent text kept for diagnostics. Everything is always
// read off the pipes; only the retained copy is bounded.
const DIAGNOSTIC_TAIL_BYTES = 8192;
// A write to a helper that has just died fails (EPIPE) a moment before its
// exit is reported. Wait this long for the exit, which names the status and
// carries stderr, before settling for the bare pipe error.
const PIPE_ERROR_GRACE_MS = 1000;

class DiagnosticTail {
  #tail = Buffer.alloc(0);
  bytes = 0;
  push(chunk) {
    this.bytes += chunk.length;
    // Copy the part worth keeping; never hold on to the stream's own buffers,
    // and never hold more than the tail however large a single chunk is.
    const fresh = chunk.length > DIAGNOSTIC_TAIL_BYTES ? chunk.subarray(chunk.length - DIAGNOSTIC_TAIL_BYTES) : chunk;
    const keep = Math.min(this.#tail.length, DIAGNOSTIC_TAIL_BYTES - fresh.length);
    this.#tail = Buffer.concat([this.#tail.subarray(this.#tail.length - keep), fresh]);
  }
  text(limit = DIAGNOSTIC_TAIL_BYTES) {
    let start = Math.max(0, this.#tail.length - limit);
    // Do not start in the middle of a UTF-8 sequence.
    while (start > 0 && start < this.#tail.length && (this.#tail[start] & 0xc0) === 0x80) start++;
    return this.#tail.toString('utf8', start);
  }
  snapshot() { return { text: this.text(), bytes: this.bytes, truncated: this.bytes > this.#tail.length }; }
}

export class NativeVst3Client {
  #child;
  #protocol;
  #pipeFailure;
  #stdout = new DiagnosticTail();
  #stderr = new DiagnosticTail();
  #buffer = Buffer.alloc(0);
  #pending;
  #tail = Promise.resolve();
  #dead;
  #queued = 0;
  #timeoutMs;
  #exited;
  #pid = null;
  #batched = false;
  // Cold-start forensics. Every stage of bringing a helper up is stamped on the
  // same `performance.now()` clock the main process uses for the audio path, so
  // a deadline miss can be attributed to spawn, handshake, plug-in load or a
  // slow first block instead of being inferred from the deadline counter.
  // Measurement only: nothing here gates, retries or changes protocol behaviour.
  #lifecycle = { constructedAtMs: null, spawnedAtMs: null, protocolBoundAtMs: null,
    firstRequestWrittenAtMs: null, firstResponseAtMs: null, openCompletedAtMs: null };
  get isDead() { return Boolean(this.#dead); }
  /** OS pid of this helper, or null if the spawn never produced one. */
  get pid() { return this.#pid; }
  /**
   * Wall-clock (`performance.now()`) stamps for this helper's start-up, plus the
   * derived spans. Returned by value; safe to embed in evidence JSON.
   */
  lifecycleTimings() {
    const t = this.#lifecycle;
    const span = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);
    return {
      ...t,
      spawnToProtocolBoundMs: span(t.spawnedAtMs, t.protocolBoundAtMs),
      protocolBoundToFirstWriteMs: span(t.protocolBoundAtMs, t.firstRequestWrittenAtMs),
      firstRequestRoundTripMs: span(t.firstRequestWrittenAtMs, t.firstResponseAtMs),
      constructedToOpenCompletedMs: span(t.constructedAtMs, t.openCompletedAtMs),
    };
  }
  /**
   * What the helper process (in practice: the plug-in) wrote to stdout and
   * stderr. `bytes` counts everything received on the stream, `text` is the
   * most recent part of it and `truncated` says whether older text was dropped.
   * This is diagnostic text only; it never takes part in the protocol.
   */
  diagnostics() { return { stdout: this.#stdout.snapshot(), stderr: this.#stderr.snapshot() }; }
  constructor(executable, { timeoutMs = 10000 } = {}) {
    this.#timeoutMs = timeoutMs;
    this.#lifecycle.constructedAtMs = performance.now();
    // A `.cmd`/`.bat` helper cannot be spawned with shell:false on Windows
    // (spawn raises EINVAL), so batch helpers go through cmd.exe. The real
    // helper is an .exe and keeps the strict shell:false path.
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    this.#batched = batch;
    // A batch launcher gets no argument: cmd.exe does not hand descriptor 3 on
    // to what it starts, so such a helper cannot answer in any case.
    this.#child = spawnNativeHelper(executable, batch ? [] : [`--protocol-fd=${PROTOCOL_FD}`], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, shell: batch,
    });
    this.#pid = this.#child.pid ?? null;
    this.#lifecycle.spawnedAtMs = performance.now();
    this.#exited = new Promise(resolve => this.#child.once('close', resolve));
    this.#child.on('error', error => this.#fail(error));
    this.#child.on('exit', (code, signal) => this.#fail(new Error(`VST3 helper exited (${signal ?? code}). ${this.#stderr.text(4096)}`)));
    this.#child.stdin.on('error', error => this.#pipeFailed(error));
    // Diagnostics: always consumed, so a plug-in that prints megabytes can
    // neither fill a pipe and stall the helper nor grow this process. A read
    // error here costs diagnostics, never the session.
    for (const [stream, tail] of [[this.#child.stdout, this.#stdout], [this.#child.stderr, this.#stderr]]) {
      stream?.on('data', chunk => tail.push(chunk));
      stream?.on('error', () => {});
    }
    this.#protocol = this.#child.stdio?.[PROTOCOL_FD] ?? null;
    if (!this.#protocol) {
      // Never fall back to stdout: that is the path this channel replaces.
      this.#fail(new Error('VST3 helper protocol channel is unavailable'));
      return;
    }
    this.#lifecycle.protocolBoundAtMs = performance.now();
    this.#protocol.on('error', error => this.#pipeFailed(error));
    this.#protocol.on('data', chunk => {
      // A dead client has already rejected its request and killed the helper.
      if (this.#dead) return;
      if (this.#pending?.timings && this.#pending.timings.firstChunkAtMs === null) {
        this.#pending.timings.firstChunkAtMs = performance.now();
      }
      try {
        // The helper only ever answers. Bytes with no request waiting are a
        // protocol violation now, not something to match to the next request.
        if (!this.#pending) throw new Error('Unsolicited VST3 helper response');
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        if (this.#buffer.length < 8) return;
        const jsonBytes = this.#buffer.readUInt32LE(0), pcmBytes = this.#buffer.readUInt32LE(4);
        if (jsonBytes > MAX_JSON || pcmBytes > MAX_PCM || pcmBytes % 8 !== 0) throw new Error('Invalid VST3 helper frame');
        const size = 8 + jsonBytes + pcmBytes;
        if (this.#buffer.length < size) return;
        if (!this.#pending || this.#buffer.length !== size) throw new Error('Unsolicited VST3 helper response');
        const result = JSON.parse(this.#buffer.subarray(8, 8 + jsonBytes).toString('utf8'));
        const samples = new Float32Array(pcmBytes / 4);
        for (let i = 0; i < samples.length; ++i) {
          samples[i] = this.#buffer.readFloatLE(8 + jsonBytes + i * 4);
          if (!Number.isFinite(samples[i])) throw new Error('Non-finite plugin PCM');
        }
        this.#buffer = Buffer.alloc(0);
        const pending = this.#pending;
        this.#pending = undefined;
        clearTimeout(pending.timer);
        if (pending.timings) {
          // Helper-side stamps, reported by the helper itself. These are what
          // separate "the OS left the helper descheduled" from "the plug-in's
          // process() was slow": helperRequestLineReadAtMs is comparable with
          // writeAtMs because both are wall clock, and the rest are durations
          // measured inside the helper.
          if (typeof result.helperRequestLineReadAtMs === 'number') {
            pending.timings.helperRequestLineReadAtMs = result.helperRequestLineReadAtMs;
            if (typeof pending.timings.writeAtEpochMs === 'number') {
              // Both sides are wall clock now, so this is a real duration: pipe
              // transfer plus however long the OS left the helper descheduled.
              pending.timings.pipeAndScheduleMs =
                result.helperRequestLineReadAtMs - pending.timings.writeAtEpochMs;
            }
          }
          if (typeof result.helperDecodeMs === 'number') pending.timings.helperDecodeMs = result.helperDecodeMs;
          // The helper now splits its own per-block work into host preparation, the
          // plug-in callback and host output collection. `helperInstanceProcessMs`
          // is the total those three partition; the old `helperPluginProcessMs`
          // name for that same total is gone, because it read as plug-in time when
          // it was host-plus-plug-in time.
          for (const field of ['helperInstanceProcessMs', 'helperHostPrepareMs',
            'helperPluginCallbackMs', 'helperHostCollectMs', 'helperProcessFrames']) {
            if (typeof result[field] === 'number') pending.timings[field] = result[field];
          }
          if (typeof result.helperProcessIsFlush === 'boolean') {
            pending.timings.helperProcessIsFlush = result.helperProcessIsFlush;
          }
          if (typeof result.helperRepliedAtMs === 'number') pending.timings.helperRepliedAtMs = result.helperRepliedAtMs;
          pending.timings.responseAtMs = performance.now();
          pending.timings.frameParseMs = (pending.timings.firstChunkAtMs === null ? null
            : pending.timings.responseAtMs - pending.timings.firstChunkAtMs);
          pending.timings.helperRoundTripMs = (pending.timings.writeAtMs === null ? null
            : pending.timings.responseAtMs - pending.timings.writeAtMs);
        }
        if (this.#lifecycle.firstResponseAtMs === null) this.#lifecycle.firstResponseAtMs = performance.now();
        if (!result.ok) pending.reject(new Error(`VST3: ${result.error}`));
        else if (pcmBytes && (result.channels !== 2 || result.frames * 8 !== pcmBytes)) {
          pending.reject(new Error('Invalid plugin PCM shape'));
          this.#fail(new Error('Invalid plugin PCM shape'));
        } else pending.resolve({ ...result, samples });
      } catch (error) { this.#fail(error); }
    });
  }
  /** stdin or the protocol pipe failed. If the helper is exiting, its exit
   *  event follows and is the more useful report; otherwise fail with this. */
  #pipeFailed(error) {
    if (this.#dead || this.#pipeFailure) return;
    this.#pipeFailure = setTimeout(() => this.#fail(new Error(`VST3 helper pipe failed: ${error.message}`)), PIPE_ERROR_GRACE_MS);
    this.#pipeFailure.unref?.();
  }
  #fail(error) {
    if (this.#dead) return;
    this.#dead = error;
    clearTimeout(this.#pipeFailure);
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(error);
      this.#pending = undefined;
    }
    this.#buffer = Buffer.alloc(0);
    this.#child.kill('SIGKILL');
  }
  request(message, timings) {
    if (this.#dead) return Promise.reject(this.#dead);
    if (this.#queued >= 64) return Promise.reject(new Error('VST3 helper request queue full'));
    // Cold-start forensics, measurement only. `timings` is filled in place so the
    // caller can attribute a slow block to serialization, queueing behind another
    // request on this strictly serial channel, the helper round trip, or frame
    // parsing - the four places the 1024-frame budget can actually be spent.
    const stamp = timings && typeof timings === 'object' ? timings : null;
    if (stamp) {
      stamp.queuedAtMs = performance.now();
      stamp.command = typeof message?.command === 'string' ? message.command : null;
      stamp.firstChunkAtMs = null; stamp.writeAtMs = null; stamp.responseAtMs = null;
      stamp.frameParseMs = null; stamp.helperRoundTripMs = null; stamp.queueWaitMs = null;
      stamp.pipeAndScheduleMs = null; stamp.helperDecodeMs = null; stamp.writeAtEpochMs = null;
      stamp.helperRequestLineReadAtMs = null;
      // Absent helper fields stay null rather than becoming 0: a fabricated zero
      // would read as "the plug-in callback was instant" instead of "not measured".
      stamp.helperInstanceProcessMs = null; stamp.helperHostPrepareMs = null;
      stamp.helperPluginCallbackMs = null; stamp.helperHostCollectMs = null;
      stamp.helperProcessFrames = null; stamp.helperProcessIsFlush = null;
    }
    const serializeStartedAtMs = performance.now();
    const text = JSON.stringify(message) + '\n';
    const requestBytes = Buffer.byteLength(text);
    if (stamp) {
      stamp.serializeMs = performance.now() - serializeStartedAtMs;
      stamp.requestBytes = requestBytes;
    }
    if (requestBytes > MAX_REQUEST) return Promise.reject(new Error('VST3 request too large'));
    this.#queued++;
    const operation = this.#tail.then(() => {
      if (this.#dead) throw this.#dead;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.#fail(new Error(`VST3 helper timed out after ${this.#timeoutMs}ms`)), this.#timeoutMs);
        this.#pending = { resolve, reject, timer, timings: stamp };
        const writtenAtMs = performance.now();
        // Stamped unconditionally: the first request is normally `open`, the
        // plug-in load, and that caller passes no timings object. Gating this on
        // `stamp` left the most interesting start-up span unmeasured.
        if (this.#lifecycle.firstRequestWrittenAtMs === null) this.#lifecycle.firstRequestWrittenAtMs = writtenAtMs;
        if (stamp) {
          stamp.writeAtMs = writtenAtMs;
          // Epoch form of the same instant. The helper reports its arrival on a
          // wall clock, and this process's performance.now() origin differs, so
          // subtracting the two directly yields an epoch-sized nonsense number -
          // which is exactly what the first helper-instrumented run produced.
          stamp.writeAtEpochMs = performance.timeOrigin + writtenAtMs;
          stamp.queueWaitMs = writtenAtMs - stamp.queuedAtMs;
        }
        this.#child.stdin.write(text, error => { if (error) this.#pipeFailed(error); });
      });
    }).finally(() => { this.#queued--; });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  open(plugin, { sampleRate = 48000, mode = 'offline', state, kind = 'instrument' } = {}) {
    if (!['instrument', 'effect'].includes(kind)) throw new Error('Invalid VST3 plugin kind');
    return this.request({ command: 'open', path: plugin.path, classId: plugin.classId, sampleRate, mode, kind,
      ...(state === undefined ? {} : { state }) }).then(opened => {
      if (this.#lifecycle.openCompletedAtMs === null) this.#lifecycle.openCompletedAtMs = performance.now();
      return opened;
    });
  }
  openEditor(effect) {
    if (!effect || typeof effect.path !== 'string' || typeof effect.classId !== 'string' || !effect.state) {
      throw new Error('Invalid VST3 editor identity/state');
    }
    return this.request({ command: 'editorOpen', path: effect.path, classId: effect.classId, state: effect.state });
  }
  async pollEditor() { return (await this.request({ command: 'editorPoll' })).editor; }
  /** Acceptance harness: perform one real Win32 operation on the live editor
   * window. Only used by the Windows acceptance script; product code never calls it. */
  async editorTestAction(action, fields = {}) {
    if (typeof action !== 'string' || !action) throw new Error('Invalid editor test action');
    return (await this.request({ command: 'editorTestAction', action, ...fields })).result;
  }
  /** Acceptance harness: move a REAL second window into focus to force focus loss. */
  async loseEditorFocus(classId) { return this.editorTestAction('loseFocus', { classId }); }
  /** Acceptance harness: apply an explicit content scale factor and observe it. */
  async setEditorScale(scale, classId) { return this.editorTestAction('setScale', { scale, classId }); }
  /**
   * Acceptance harness: deliver mouse input at real screen coordinates.
   *
   * Press, move and release travel as genuine mouse messages carrying the button
   * state, addressed to the window the OS reports under the point. `zoomModifier`
   * asks the helper to hold the real shift key for the gesture, which VSTGUI reads
   * as its slider zoom modifier -- that is what lets a drag move the value by a
   * controlled step instead of jumping the handle to the pointer.
   */
  async sendEditorMouse(action, { x = 20, y = 20, classId, zoomModifier = false } = {}) {
    // `up` must be routable: a press with no release never completes a click.
    const name = { move: 'mouseMove', down: 'mouseDown', up: 'mouseUp', wheel: 'mouseWheel' }[action];
    if (!name) throw new Error('Invalid mouse action');
    return this.editorTestAction(name, { x, y, classId, zoomModifier });
  }
  /** Acceptance harness: hold or release the real shift key around a gesture. */
  async setEditorGestureModifier(down, classId) {
    if (typeof down !== 'boolean') throw new Error('Invalid gesture modifier state');
    return this.editorTestAction('gestureModifier', { down, classId });
  }
  /** Read-only observation of the live native editor window (Windows x64 only). */
  async editorDiagnostics(classId) {
    if (typeof classId !== 'string' || !/^[A-F0-9]{32}$/.test(classId)) {
      throw new Error('Invalid VST3 class id for editor diagnostics');
    }
    return (await this.request({ command: 'editorDiagnostics', classId })).diagnostics;
  }
  async closeEditor() { return (await this.request({ command: 'editorClose' })).editor; }
  async parameters(changes) { return (await this.request({ command: 'parameters', parameters: changes })).parameters; }
  async snapshot() { return (await this.request({ command: 'snapshot' })).state; }
  process(frames, events = [], parameters = [], bpm = 120) {
    return this.request({ command: 'process', frames, events, parameters, bpm });
  }
  processAudio(frames, samples, parameters = [], bpm = 120, timings) {
    if (!Number.isInteger(frames) || frames < 1 || frames > 16384 ||
      !(samples instanceof Float32Array) || samples.length !== frames * 2 ||
      samples.some(sample => !Number.isFinite(sample))) throw new Error('Invalid planar stereo VST3 audio block');
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    return this.request({ command: 'process', frames, events: [], parameters, bpm, audio: bytes.toString('base64') }, timings);
  }
  async dispose() {
    // Kill rather than waiting on untrusted plugin teardown forever. Destructors
    // run on normal close/EOF, but OS reclamation is the final bound for a hang.
    if (!this.#dead) {
      // A teardown path must not throw: a plugin that refuses or ignores `close`
      // still has to be reclaimed, and the caller is already discarding it.
      try { await this.request({ command: 'close' }); } catch { /* reclaim below */ } finally {
        this.#child.stdin.end();
        this.#child.kill('SIGKILL');
        // A helper started through a shell has a grandchild that can outlive the
        // shell and keep the pipes open, so `close` may never fire. Bound the wait
        // instead of hanging the caller (and the app) forever.
        const exited = await Promise.race([
          this.#exited.then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!exited) await this.#killTree();
      }
    } else await Promise.race([this.#exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  /** Last resort for a surviving grandchild: kill by pid tree, never by name. */
  async #killTree() {
    if (this.#pid) {
      try {
        if (process.platform === 'win32') { execFileSync('taskkill', ['/PID', String(this.#pid), '/T', '/F'], { stdio: 'ignore' }); }
        else process.kill(this.#pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    // Do not leave the parent waiting on pipes a dead grandchild still holds.
    this.#protocol?.destroy();
    this.#child.stdout?.destroy();
    this.#child.stderr?.destroy();
    this.#child.stdin?.destroy();
    await Promise.race([this.#exited, new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  // External cancellation (project/channel/renderer replacement).
  abort() { this.#fail(new Error('VST3 instance cancelled')); }
}

/** Scan user-supplied roots; each bundle loads in its own short-lived process.
 * No default/fabricated identities. Failed bundles remain explicit diagnostics.
 * Symlinks are not followed, to avoid cycles and accidental scans outside roots.
 */
export async function discoverVst3(executable, roots, { signal, timeoutMs = 10000, scanTimeoutMs = 120000, maxCandidates = 4096, kind = 'instrument' } = {}) {
  if (!['instrument', 'effect'].includes(kind)) throw new Error('Invalid VST3 discovery kind');
  const candidates = new Set(), errors = [];
  let visited = 0;
  const deadline = Date.now() + scanTimeoutMs;
  function checkCancelled() {
    if (signal?.aborted) throw new Error('VST3 discovery cancelled');
    if (Date.now() > deadline) throw new Error('VST3 discovery deadline exceeded; scan fewer folders');
  }
  async function walk(target, depth = 0) {
    checkCancelled();
    if (++visited > 100000 || depth > 32) throw new Error('Plugin search exceeds traversal limit');
    const info = await lstat(target);
    if (info.isSymbolicLink()) return;
    if (target.toLowerCase().endsWith('.vst3')) {
      if (candidates.size >= maxCandidates) throw new Error(`Plugin search exceeds ${maxCandidates} bundle limit`);
      candidates.add(target); return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(target)) await walk(path.join(target, entry), depth + 1);
  }
  for (const root of roots) {
    try { await walk(path.resolve(root)); } catch (error) { errors.push({ path: root, error: error.message }); }
  }
  const plugins = [];
  for (const candidate of [...candidates].sort()) {
    try { checkCancelled(); } catch (error) { errors.push({ path: candidate, error: error.message }); break; }
    const helper = new NativeVst3Client(executable, { timeoutMs: Math.max(1, Math.min(timeoutMs, deadline - Date.now())) });
    const abort = () => helper.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await helper.request({ command: 'scan', path: candidate, kind });
      plugins.push(...response.plugins.map(plugin => ({ ...plugin, path: candidate })));
    } catch (error) { errors.push({ path: candidate, error: error.message }); }
    finally { signal?.removeEventListener('abort', abort); await helper.dispose(); }
  }
  return { plugins, errors };
}

/** Render an event sequence using the SAME block processor in realtime/offline
 * SDK modes. Independent test reference, NOT the AudioEngine song-export path.
 * Events are absolute sample frames, not wall-clock timers.
 */
export async function renderNativeSequence(client, { frames, events, bpm = 120, blockSize = 4096 }) {
  if (!Number.isInteger(frames) || frames < 1 || frames > 192000 * 60) throw new Error('Prototype render limited to 60s at 192kHz');
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 16384) throw new Error('Invalid native block size');
  if (!Array.isArray(events) || events.some((event, index) =>
    !Number.isInteger(event.frame) || event.frame < 0 || event.frame >= frames ||
    (index > 0 && event.frame < events[index - 1].frame))) throw new Error('Events must be ordered and inside render');
  const left = new Float32Array(frames), right = new Float32Array(frames);
  let eventIndex = 0;
  for (let start = 0; start < frames; start += blockSize) {
    const count = Math.min(blockSize, frames - start), blockEvents = [];
    while (eventIndex < events.length && events[eventIndex].frame < start + count) {
      const { frame, ...event } = events[eventIndex++];
      blockEvents.push({ ...event, offset: frame - start });
    }
    const { samples } = await client.process(count, blockEvents, [], bpm);
    left.set(samples.subarray(0, count), start);
    right.set(samples.subarray(count), start);
  }
  return [left, right];
}
