// Native helper adapter; only the authorized service is exposed by Electron preload.
// One OS process per plugin instance. A crash/timeout rejects requests; this is
// failure containment, not a security sandbox. Plugins retain OS user privileges.
import { spawn } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const MAX_JSON = 5 * 1024 * 1024;
const MAX_PCM = 16384 * 2 * 4;
const MAX_REQUEST = 8 * 1024 * 1024;
export class NativeVst3Client {
  #child;
  #buffer = Buffer.alloc(0);
  #pending;
  #tail = Promise.resolve();
  #dead;
  #queued = 0;
  #timeoutMs;
  #stderr = '';
  #exited;
  #sessionId;
  constructor(executable, { timeoutMs = 10000, diagnosticSessionId } = {}) {
    this.#timeoutMs = timeoutMs;
    this.#sessionId = diagnosticSessionId || undefined;
    const env = { ...process.env };
    if (this.#sessionId) env.APEX_REZFILTER_SESSION_ID = this.#sessionId;
    this.#child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env });
    this.#exited = new Promise(resolve => this.#child.once('close', resolve));
    this.#child.on('error', error => this.#fail(error));
    this.#child.on('exit', (code, signal) => this.#fail(new Error(`VST3 helper exited (${signal ?? code}). ${this.#stderr}`)));
    this.#child.stdin.on('error', error => this.#fail(error));
    this.#child.stderr.on('data', chunk => { this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-4096); });
    this.#child.stdout.on('data', chunk => {
      try {
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
        if (!result.ok) pending.reject(new Error(`VST3: ${result.error}`));
        else if (pcmBytes && (result.channels !== 2 || result.frames * 8 !== pcmBytes)) {
          pending.reject(new Error('Invalid plugin PCM shape'));
          this.#fail(new Error('Invalid plugin PCM shape'));
        } else pending.resolve({ ...result, samples });
      } catch (error) { this.#fail(error); }
    });
  }
  #fail(error) {
    if (this.#dead) return;
    this.#dead = error;
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(error);
      this.#pending = undefined;
    }
    this.#buffer = Buffer.alloc(0);
    this.#child.kill('SIGKILL');
  }
  request(message) {
    if (this.#dead) return Promise.reject(this.#dead);
    if (this.#queued >= 64) return Promise.reject(new Error('VST3 helper request queue full'));
    const text = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(text) > MAX_REQUEST) return Promise.reject(new Error('VST3 request too large'));
    this.#queued++;
    const operation = this.#tail.then(() => {
      if (this.#dead) throw this.#dead;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.#fail(new Error(`VST3 helper timed out after ${this.#timeoutMs}ms`)), this.#timeoutMs);
        this.#pending = { resolve, reject, timer };
        this.#child.stdin.write(text, error => { if (error) this.#fail(error); });
      });
    }).finally(() => { this.#queued--; });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  get pid() { return this.#child?.pid ?? null; }
  get diagnosticSessionId() { return this.#sessionId ?? null; }
  open(plugin, { sampleRate = 48000, mode = 'offline', state, kind = 'instrument', diagnosticSessionId } = {}) {
    if (!['instrument', 'effect'].includes(kind)) throw new Error('Invalid VST3 plugin kind');
    const sessionId = diagnosticSessionId || this.#sessionId;
    return this.request({ command: 'open', path: plugin.path, classId: plugin.classId, sampleRate, mode, kind,
      ...(sessionId ? { diagnosticSessionId: sessionId } : {}),
      ...(state === undefined ? {} : { state }) });
  }
  async parameters(changes) { return (await this.request({ command: 'parameters', parameters: changes })).parameters; }
  async snapshot() { return (await this.request({ command: 'snapshot' })).state; }
  process(frames, events = [], parameters = [], bpm = 120) {
    return this.request({ command: 'process', frames, events, parameters, bpm });
  }
  processAudio(frames, samples, parameters = [], bpm = 120, trace = false) {
    if (!Number.isInteger(frames) || frames < 1 || frames > 16384 ||
      !(samples instanceof Float32Array) || samples.length !== frames * 2 ||
      samples.some(sample => !Number.isFinite(sample))) throw new Error('Invalid planar stereo VST3 audio block');
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    return this.request({ command: 'process', frames, events: [], parameters, bpm, audio: bytes.toString('base64'), ...(trace ? { trace: true } : {}) });
  }
  async dispose() {
    // Kill rather than waiting on untrusted plugin teardown forever. Destructors
    // run on normal close/EOF, but OS reclamation is the final bound for a hang.
    if (!this.#dead) {
      try { await this.request({ command: 'close' }); } finally {
        this.#child.stdin.end();
        const timer = setTimeout(() => this.#child.kill('SIGKILL'), 1000);
        await this.#exited;
        clearTimeout(timer);
      }
    } else await this.#exited;
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
