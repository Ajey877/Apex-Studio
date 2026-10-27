// Privileged main-process service shared by Electron and real integration tests.
// This is a process boundary, NOT a security sandbox for untrusted plugins.
import { validateMetadata, validateParameterChanges, validateProcessParameters } from './parameters.mjs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeVst3Client, discoverVst3 } from './client.mjs';

export class Vst3Service {
  #executable;
  #roots;
  #sessions = new Map();
  #pending = 0;
  #closed = false;
  #ownerTokens = new Map();
  #loading = new Map();
  #closing = new Set();
  #scans = new Map();
  constructor(executable, roots) { this.#executable = executable; this.#roots = roots; }
  setRoots(roots) { this.#roots = [...roots]; }
  get sessionCount() { return this.#sessions.size + this.#pending + this.#closing.size; }
  async discover(owner = 'local', kind = 'instrument') {
    if (!['instrument', 'effect'].includes(kind)) throw new Error('Invalid VST3 discovery kind');
    if (this.#closed) throw new Error('VST3 service closed');
    if (this.#scans.has(owner)) throw new Error('A VST3 scan is already running');
    if (this.#scans.size >= 2) throw new Error('VST3 discovery limit reached');
    const controller = new AbortController();
    this.#scans.set(owner, controller);
    try { return await discoverVst3(this.#executable, this.#roots, { signal: controller.signal, timeoutMs: 2000, scanTimeoutMs: 30000, maxCandidates: 256, kind }); }
    finally { this.#scans.delete(owner); }
  }
  async #authorize(instrument) {
    if (!instrument || typeof instrument.path !== 'string' || instrument.path.length > 4096 ||
      !/^[A-F0-9]{32}$/.test(instrument.classId ?? '') || !instrument.path.toLowerCase().endsWith('.vst3')) {
      throw new Error('Invalid VST3 identity');
    }
    let pluginPath;
    try { pluginPath = await realpath(instrument.path); }
    catch { throw new Error(`VST3 plugin missing: ${instrument.path}. Add its folder and relink; saved state has not been changed.`); }
    for (const root of this.#roots) {
      let resolved;
      try { resolved = await realpath(root); } catch { continue; }
      const relative = path.relative(resolved, pluginPath);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return pluginPath;
    }
    throw new Error('VST3 location is not authorized. Add the plugin folder using the desktop folder chooser, then retry.');
  }
  async open(instrument, sampleRate, mode, owner = 'local', kind = 'instrument') {
    if (this.#closed || this.sessionCount >= 16) throw new Error('VST3 session limit reached or service closed (maximum 16 including exports)');
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !['offline', 'realtime'].includes(mode) || !['instrument', 'effect'].includes(kind)) throw new Error('Invalid VST3 processing configuration');
    this.#pending++;
    const token = this.#ownerTokens.get(owner) ?? Symbol();
    this.#ownerTokens.set(owner, token);
    let client;
    try {
      const pluginPath = await this.#authorize(instrument);
      if (this.#closed || this.#ownerTokens.get(owner) !== token) throw new Error('VST3 service/renderer closed during load');
      client = new NativeVst3Client(this.#executable, { timeoutMs: 2000 });
      this.#loading.set(client, owner);
      const opened = await client.open({ ...instrument, path: pluginPath }, { sampleRate, mode, state: instrument.state, kind });
      if (this.#closed || this.#ownerTokens.get(owner) !== token) throw new Error('VST3 service/renderer closed during load');
      // Nonzero plugin latency needs explicit delay compensation; fail honestly
      // rather than exporting time-shifted audio in this first slice.
      if (opened.plugin.latencySamples !== 0) throw new Error(`VST3 ${kind} reports ${opened.plugin.latencySamples} samples of latency; this host path currently supports zero-reported-latency ${kind}s only.`);
      const parameters = validateMetadata(opened.plugin.parameters, opened.plugin.controllerAvailable);
      const id = randomUUID();
      this.#sessions.set(id, { client, owner, processing: false, parameters, kind });
      return { id, latencySamples: opened.plugin.latencySamples, parameters, controllerAvailable: opened.plugin.controllerAvailable };
    } catch (error) { if (client) await client.dispose().catch(() => {}); throw error; }
    finally { if (client) this.#loading.delete(client); this.#pending--; }
  }
  #session(id, owner) {
    const session = this.#sessions.get(id);
    if (!session || session.owner !== owner) throw new Error('VST3 session is closed or belongs to another renderer');
    return session;
  }
  async process(id, frames, events, bpm, owner = 'local', parameters = []) {
    const session = this.#session(id, owner);
    if (session.kind !== 'instrument') throw new Error('MIDI processing is unavailable for a VST3 audio effect');
    if (session.processing) throw new Error('Concurrent VST3 processing request rejected');
    if (!Number.isInteger(frames) || frames < 1 || frames > 16384 || !Array.isArray(events) || events.length > 4096) throw new Error('VST3 batch exceeds bounds');
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('Invalid VST3 tempo');
    const midi = events.map(event => {
      if (!event || !Number.isInteger(event.offset) || event.offset < 0 || event.offset >= frames ||
        !['on', 'off'].includes(event.type) || !Number.isInteger(event.pitch) || event.pitch < 0 || event.pitch > 127 ||
        !Number.isInteger(event.noteId) || event.noteId < 0 || event.noteId > 0x7fffffff ||
        !Number.isInteger(event.channel ?? 0) || (event.channel ?? 0) < 0 || (event.channel ?? 0) > 15 ||
        !Number.isFinite(event.velocity ?? 0) || (event.velocity ?? 0) < 0 || (event.velocity ?? 0) > 1) throw new Error('Invalid VST3 MIDI event');
      return { offset: event.offset, type: event.type, pitch: event.pitch, noteId: event.noteId, channel: event.channel ?? 0, velocity: event.velocity ?? 0 };
    });
    const changes = validateProcessParameters(parameters, session.parameters, frames);
    session.processing = true;
    try { return (await session.client.process(frames, midi, changes, bpm)).samples; }
    catch (error) { await this.close(id, owner); throw error; }
    finally { session.processing = false; }
  }
  async processAudio(id, frames, audio, bpm, owner = 'local', parameters = []) {
    const session = this.#session(id, owner);
    if (session.kind !== 'effect') throw new Error('Audio-effect processing requires a VST3 effect session');
    if (session.processing) throw new Error('Concurrent VST3 effect processing request rejected');
    if (!Number.isInteger(frames) || frames < 1 || frames > 16384 ||
      !(audio instanceof Float32Array) || audio.length !== frames * 2 ||
      audio.some(sample => !Number.isFinite(sample))) throw new Error('VST3 effect requires a bounded planar stereo float32 block');
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('Invalid VST3 tempo');
    const changes = validateProcessParameters(parameters, session.parameters, frames);
    session.processing = true;
    try { return (await session.client.processAudio(frames, audio, changes, bpm)).samples; }
    catch (error) { await this.close(id, owner); throw error; }
    finally { session.processing = false; }
  }
  async describe(instrument, owner = 'local') {
    const opened = await this.open(instrument, 48000, 'offline', owner);
    try { return { parameters: opened.parameters, controllerAvailable: opened.controllerAvailable }; }
    finally { await this.close(opened.id, owner); }
  }
  async parameters(id, changes, owner = 'local') {
    const session = this.#session(id, owner);
    if (session.processing) throw new Error('Concurrent VST3 parameter/process request rejected');
    const validated = validateParameterChanges(changes, session.parameters);
    session.processing = true;
    try {
      const metadata = await session.client.parameters(validated);
      // A missing/invalid controller response is never acknowledged as a successful edit.
      session.parameters = validateMetadata(metadata, true);
      for (const change of validated) {
        const p = session.parameters.find(p => p.id === change.id);
        if (!p || p.currentValue === null || Math.abs(p.currentValue - change.value) > 1e-7) throw new Error('VST3 controller did not accept the requested value');
      }
      if (this.#sessions.get(id) !== session) throw new Error('VST3 edit cancelled');
      return session.parameters;
    } catch (error) { await this.close(id, owner); throw error; }
    finally { session.processing = false; }
  }
  async inspect(plugin, state, owner = 'local') {
    const instrument = { ...plugin, ...(state === undefined ? {} : { state }) };
    const { id } = await this.open(instrument, 48000, 'offline', owner);
    try {
      const session = this.#session(id, owner);
      // Flush supported state/parameter queues before capturing the authoritative
      // component/controller streams. No generated PCM is substituted or stored.
      await session.client.process(1);
      return { path: plugin.path, classId: plugin.classId, name: plugin.name,
        vendor: plugin.vendor, version: plugin.version, state: await session.client.snapshot() };
    } finally { await this.close(id, owner); }
  }
  async close(id, owner = 'local') {
    const session = this.#sessions.get(id);
    if (!session || session.owner !== owner) return;
    this.#sessions.delete(id);
    // Never queue teardown behind a process call that may be hung.
    if (session.processing) session.client.abort();
    const closing = session.client.dispose().catch(() => {});
    this.#closing.add(closing);
    try { await closing; } finally { this.#closing.delete(closing); }
  }
  async closeOwner(owner) {
    this.#ownerTokens.delete(owner);
    this.#scans.get(owner)?.abort();
    for (const [client, loadingOwner] of this.#loading) if (loadingOwner === owner) client.abort();
    await Promise.all([...this.#sessions].filter(([, s]) => s.owner === owner).map(([id]) => this.close(id, owner)));
  }
  async dispose() {
    this.#closed = true;
    for (const controller of this.#scans.values()) controller.abort();
    for (const client of this.#loading.keys()) client.abort();
    await Promise.all([...this.#sessions].map(([id, session]) => this.close(id, session.owner)));
    await Promise.all([...this.#closing]);
    this.#ownerTokens.clear();
  }
}
