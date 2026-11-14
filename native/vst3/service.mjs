// Privileged main-process service shared by Electron and real integration tests.
// This is a process boundary, NOT a security sandbox for untrusted plugins.
import {
  validateEditorActiveEdits,
  validateEditorContext,
  validateEditorEvents,
  validateEditorParameterSnapshot,
  validateEditorState,
  validateMetadata,
  validateParameterChanges,
  validateProcessParameters,
} from './parameters.mjs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeVst3Client, discoverVst3 } from './client.mjs';

export const MAX_VST3_EFFECT_LATENCY_SECONDS = 1;
export function maxVst3EffectLatencySamples(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return Math.floor(sampleRate * MAX_VST3_EFFECT_LATENCY_SECONDS);
}

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
  #editor = null;
  #editorOpening = null;
  // Editors whose helper died. Kept with their last reported parameter values so a
  // recovery record can still be produced; cleared when the renderer releases them.
  #retiredEditors = new Map();
  constructor(executable, roots) { this.#executable = executable; this.#roots = roots; }
  setRoots(roots) { this.#roots = [...roots]; }
  get sessionCount() { return this.#sessions.size + this.#pending + this.#closing.size + (this.#editor ? 1 : 0) + this.#retiredEditors.size; }
  get editorSessionCount() { return this.#editor ? 1 : 0; }
  get hasEditorSession() { return Boolean(this.#editor || this.#editorOpening); }
  #validateLatency(latencySamples, kind, sampleRate) {
    if (!Number.isSafeInteger(latencySamples) || latencySamples < 0) {
      throw new Error(`VST3 ${kind} reported an invalid latency value (${String(latencySamples)} samples).`);
    }
    if (kind === 'instrument' && latencySamples !== 0) {
      throw new Error(`VST3 instrument reports ${latencySamples} samples of latency; this host path currently supports zero-reported-latency instruments only.`);
    }
    if (kind === 'effect' && latencySamples > maxVst3EffectLatencySamples(sampleRate)) {
      throw new Error(`VST3 effect reports excessive latency (${latencySamples} samples at ${sampleRate} Hz; maximum supported is ${maxVst3EffectLatencySamples(sampleRate)} samples).`);
    }
    return latencySamples;
  }
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
      const latencySamples = this.#validateLatency(opened.plugin.latencySamples, kind, sampleRate);
      const parameters = validateMetadata(opened.plugin.parameters, opened.plugin.controllerAvailable);
      const id = randomUUID();
      this.#sessions.set(id, { client, owner, processing: false, parameters, kind, sampleRate, latencySamples });
      return { id, latencySamples, parameters, controllerAvailable: opened.plugin.controllerAvailable };
    } catch (error) { if (client) await client.dispose().catch(() => {}); throw error; }
    finally { if (client) this.#loading.delete(client); this.#pending--; }
  }
  async openEditor(effect, context, owner = 'local') {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('Genuine VST3 editor windows are available only in the Windows x64 desktop build.');
    }
    if (this.#closed || this.#editor || this.#editorOpening) throw new Error('One native VST3 editor window is allowed per application session.');
    if (this.sessionCount >= 16) throw new Error('VST3 session limit reached (maximum 16 including editors and exports).');
    const editorContext = validateEditorContext(context);
    if (!effect || typeof effect !== 'object' || Array.isArray(effect) ||
        typeof effect.name !== 'string' || effect.name.length > 512 ||
        typeof effect.vendor !== 'string' || effect.vendor.length > 512 ||
        typeof effect.version !== 'string' || effect.version.length > 512 ||
        typeof effect.classId !== 'string' || !/^[A-F0-9]{32}$/.test(effect.classId) ||
        !effect.state || effect.state.classId !== effect.classId || !Array.isArray(effect.state.parameters)) {
      throw new Error('Invalid VST3 effect identity/state; the committed project state was not changed.');
    }
    if (!effect.state.parameters.every(parameter => parameter && Number.isInteger(parameter.id) &&
        parameter.id >= 0 && parameter.id <= 0xffffffff && Number.isFinite(parameter.value) &&
        parameter.value >= 0 && parameter.value <= 1) ||
        new Set(effect.state.parameters.map(parameter => parameter.id)).size !== effect.state.parameters.length) {
      throw new Error('Invalid VST3 effect parameter state; the committed project state was not changed.');
    }
    // The controller's real metadata (with its read-only flags) is authoritative,
    // so the saved values are structurally validated here and re-validated
    // against that metadata once the helper reports it.
    const initialState = validateEditorState(effect.state, effect.classId,
      effect.state.parameters.map(parameter => ({ id: parameter.id, flags: 0 })));
    const safeEffect = { ...effect, state: initialState };
    if (JSON.stringify(safeEffect).length > 4 * 1024 * 1024) throw new Error('VST3 effect state exceeds the 4 MiB editor limit.');

    let resolveOpening;
    const opening = {
      owner, effect: safeEffect, context: editorContext, client: null,
      cancelled: false, recoveryRecord: null,
      settled: new Promise(resolve => { resolveOpening = resolve; }),
      settle: () => resolveOpening(),
    };
    this.#editorOpening = opening;
    this.#pending++;
    const token = this.#ownerTokens.get(owner) ?? Symbol();
    this.#ownerTokens.set(owner, token);
    let client;
    try {
      const pluginPath = await this.#authorize(safeEffect);
      if (this.#closed || this.#ownerTokens.get(owner) !== token) throw new Error('VST3 editor was cancelled while authorizing the plug-in.');
      client = new NativeVst3Client(this.#executable, { timeoutMs: 15000 });
      opening.client = client;
      this.#loading.set(client, owner);
      // The helper loads the authorized (resolved) path, but the session must
      // keep the identity the caller supplied: a recovery record has to name the
      // insert exactly as the project does. Windows resolves case and 8.3 short
      // components (RUNNER~1), so substituting the resolved path here would make
      // the record refer to a different-looking plug-in than the saved project.
      const plugin = { ...safeEffect, path: pluginPath, authorizedPath: pluginPath };
      const opened = await client.openEditor(plugin);
      if (!opened.editor || opened.editor.available !== true || opened.editor.classId !== safeEffect.classId) {
        throw new Error('The VST3 plug-in did not provide a genuine Windows editor view.');
      }
      const parameters = validateMetadata(opened.editor.parameters, opened.editor.controllerAvailable);
      if (!opened.editor.controllerAvailable) throw new Error('This VST3 plug-in has no edit controller for its native editor.');
      // Saved values must still exist and stay writable on THIS controller.
      for (const saved of initialState.parameters) {
        const metadata = parameters.find(parameter => parameter.id === saved.id);
        if (!metadata || (metadata.flags & (2 | 16))) {
          throw new Error(`Saved VST3 parameter ${saved.id} is no longer writable on this plug-in controller.`);
        }
      }
      const id = randomUUID();
      const session = {
        id, owner, client, effect: plugin, requestedPath: safeEffect.path, context: editorContext, parameters,
        activeEdits: new Set(), draftParameters: new Map(initialState.parameters.map(item => [item.id, item.value])),
        busy: false, busyPromise: null, closed: false, finalState: null, finalStatus: null, recoveryRecord: null,
      };
      this.#editor = session;
      if (this.#closed || this.#ownerTokens.get(owner) !== token) {
        try {
          const finalStatus = await this.closeEditor(id, owner);
          opening.recoveryRecord = this.#makeEditorRecovery(session, finalStatus.state,
            'The renderer closed while the native VST3 editor was opening.');
        } catch (error) {
          opening.recoveryRecord = this.#makeEditorRecovery(session, null,
            `The renderer closed while the native VST3 editor was opening; the last committed state was preserved. ${error.message}`);
        }
        throw new Error('VST3 editor was cancelled while loading the plug-in.');
      }
      return { id, ...opened.editor, parameters };
    } catch (error) {
      if (opening.cancelled && !opening.recoveryRecord) {
        opening.recoveryRecord = this.#makePendingEditorRecovery(opening,
          `The native VST3 editor could not finish opening; the last committed state was preserved. ${error.message}`);
      }
      if (client) await client.dispose().catch(() => {});
      throw error;
    } finally {
      if (client) this.#loading.delete(client);
      this.#pending--;
      if (this.#editorOpening === opening) this.#editorOpening = null;
      opening.settle();
    }
  }
  /**
   * A helper that died cannot be asked for the plug-in's final state, but the
   * parameters the user already changed were reported by the last successful poll
   * and are still here. Retire the session instead of deleting it: the record
   * built from those values is the only thing standing between a crash and silent
   * data loss, and `getEditorRecovery` is the shipped surface that produces it.
   *
   * Dropping the session (which is what this did before) made every later call
   * answer "closed or belongs to another renderer" -- a description of a foreign
   * owner, not of a crash -- so recovery could never be offered.
   */
  async #retireDeadSession(session) {
    session.closed = true;
    session.crashed = true;
    session.activeEdits.clear();
    session.finalState = null;
    session.recoveryRecord = this.#makeEditorRecovery(session, null,
      session.recoveryError ?? 'The native editor helper exited while the editor was open; the last parameter values the plug-in reported were kept for recovery.');
    this.#retiredEditors.set(session.id, session);
    if (this.#editor === session) this.#editor = null;
    await session.client.dispose().catch(() => {});
  }
  #editorSession(id, owner) {
    const session = this.#editor;
    if (!session || session.id !== id || session.owner !== owner) throw new Error('VST3 editor session is closed or belongs to another renderer.');
    return session;
  }
  #editorResult(session, value) {
    const allowedKeys = new Set(['closed', 'events', 'editedParameters', 'activeEditIds', 'dirty', 'eventQueueOverflow', 'nativeCloseError', 'state']);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !allowedKeys.has(key)) || typeof value.closed !== 'boolean' ||
        typeof value.dirty !== 'boolean' || typeof value.eventQueueOverflow !== 'boolean') {
      throw new Error('Invalid VST3 editor status response.');
    }
    if (value.closed !== Object.hasOwn(value, 'state')) throw new Error('VST3 editor state/closed status mismatch.');
    if (!Array.isArray(value.events) || value.events.length > 4096) throw new Error('Invalid VST3 editor event batch.');
    const activeEdits = new Set(session.activeEdits);
    const activeSnapshot = validateEditorActiveEdits(value.activeEditIds, session.parameters);
    let events;
    if (value.eventQueueOverflow) {
      // The native helper also sends complete bounded snapshots. After an
      // overflow, those are authoritative; partial callback chronology is not.
      activeEdits.clear();
      for (const id of activeSnapshot) activeEdits.add(id);
      events = [];
    } else {
      events = validateEditorEvents(value.events, session.parameters, activeEdits);
      if (activeEdits.size !== activeSnapshot.size || [...activeEdits].some(id => !activeSnapshot.has(id))) {
        throw new Error('VST3 editor callback sequence disagrees with its active-edit snapshot.');
      }
    }
    const editedParameters = validateEditorParameterSnapshot(value.editedParameters, session.parameters);
    for (const item of editedParameters) session.draftParameters.set(item.id, item.value);
    session.activeEdits = activeEdits;
    const result = { id: session.id, closed: value.closed, events, editedParameters,
      activeEditIds: [...activeSnapshot], dirty: value.dirty,
      eventQueueOverflow: value.eventQueueOverflow };
    if (value.nativeCloseError !== undefined) {
      if (typeof value.nativeCloseError !== 'string' || value.nativeCloseError.length > 1024) throw new Error('Invalid VST3 editor close diagnostic.');
      result.nativeCloseError = value.nativeCloseError;
    }
    if (value.closed) {
      const state = validateEditorState(value.state, session.effect.classId, session.parameters);
      const mergedParameters = new Map(state.parameters.map(item => [item.id, item.value]));
      for (const item of editedParameters) mergedParameters.set(item.id, item.value);
      const finalState = validateEditorState({ ...state,
        parameters: [...mergedParameters].map(([id, value]) => ({ id, value })) },
      session.effect.classId, session.parameters);
      session.closed = true;
      session.activeEdits.clear();
      session.finalState = finalState;
      session.finalStatus = { ...result, activeEditIds: [], state: finalState };
      return session.finalStatus;
    }
    return result;
  }
  async pollEditor(id, owner = 'local') {
    const session = this.#editorSession(id, owner);
    if (session.closed) return session.finalStatus;
    if (session.busy) throw new Error('Concurrent VST3 editor status request rejected.');
    session.busy = true;
    const operation = (async () => {
      try {
        // NativeVst3Client.pollEditor/closeEditor already unwrap the helper's
        // `editor` field; validate that payload directly.
        return this.#editorResult(session, await session.client.pollEditor());
      } catch (error) {
        if (session.client.isDead) {
          await this.#retireDeadSession(session);
          throw new Error(`Native VST3 editor helper failed; the previously committed project state is preserved and can be retried. ${error.message}`);
        }
        // A malformed response is a helper protocol failure, not a plug-in edit.
        if (this.#editor === session) this.#editor = null;
        session.client.abort();
        await session.client.dispose().catch(() => {});
        throw new Error(`Native VST3 editor response was rejected; the previously committed project state is preserved. ${error.message}`);
      }
    })();
    session.busyPromise = operation;
    try { return await operation; }
    finally { session.busy = false; session.busyPromise = null; }
  }
  /**
   * ACCEPTANCE ONLY. Drive the open editor window with genuine OS input.
   *
   * Used by scripts/packaged-editor-acceptance.mjs to prove that a user action in
   * the plug-in's own window reaches Apex. The main process refuses to route it
   * unless the packaged acceptance flag is set (see desktop-vst3.cjs), so it is
   * unreachable in a normal user session. It does not bypass any product logic: the
   * helper injects real input and the renderer's normal poll loop observes the
   * resulting parameter change exactly as it would for a human.
   */
  async editorInput(id, action, point, owner = 'local') {
    const session = this.#editorSession(id, owner);
    if (session.closed) throw new Error('The native VST3 editor is closed.');
    if (session.busy) throw new Error('VST3 editor is still servicing another request; retry in a moment.');
    if (!['move', 'down', 'up', 'wheel'].includes(action)) throw new Error('Invalid editor input action');
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 8192 || y > 8192) {
      throw new Error('Invalid editor input point');
    }
    session.busy = true;
    try {
      return await session.client.sendEditorMouse(action, { x, y, classId: session.effect.classId });
    } finally {
      session.busy = false;
      session.busyPromise = null;
    }
  }
  async closeEditor(id, owner = 'local') {
    const session = this.#editorSession(id, owner);
    if (session.closed) return session.finalStatus;
    if (session.busy) throw new Error('VST3 editor is still servicing another request; retry in a moment.');
    session.busy = true;
    const operation = (async () => {
      try {
        return this.#editorResult(session, await session.client.closeEditor());
      } catch (error) {
        if (session.client.isDead) {
          await this.#retireDeadSession(session);
          throw new Error(`Native VST3 editor stopped before state capture; the previously committed project state is preserved. ${error.message}`);
        }
        // The native helper deliberately remains alive after a failed state
        // capture so the user can retry without losing the plug-in's live state.
        if (String(error.message).includes('Invalid VST3 editor')) {
          if (this.#editor === session) this.#editor = null;
          session.client.abort();
          await session.client.dispose().catch(() => {});
        }
        throw new Error(`VST3 editor state capture failed; nothing was committed. Retry closing the editor. ${error.message}`);
      }
    })();
    session.busyPromise = operation;
    try { return await operation; }
    finally { session.busy = false; session.busyPromise = null; }
  }
  async finishEditor(id, owner = 'local') {
    const retired = this.#retiredEditor(id, owner);
    const session = retired ?? this.#editorSession(id, owner);
    if (!session.closed) throw new Error('Capture the final VST3 editor state before releasing the helper.');
    if (session.busy) throw new Error('VST3 editor is still servicing another request.');
    if (this.#editor === session) this.#editor = null;
    await session.client.dispose().catch(() => {});
    if (retired) this.#retiredEditors.delete(id);
  }
  getEditorRecovery(id, owner = 'local') {
    // A crashed editor keeps its last reported values; nothing here invents a
    // final state the dead helper never provided.
    const session = this.#retiredEditor(id, owner) ?? this.#editorSession(id, owner);
    if (session.crashed) return session.recoveryRecord;
    const state = session.closed && session.finalState ? session.finalState : this.#editorDraftState(session);
    session.recoveryRecord = this.#makeEditorRecovery(session, state);
    return session.recoveryRecord;
  }
  #retiredEditor(id, owner) {
    const session = this.#retiredEditors.get(id);
    if (!session || session.owner !== owner) return null;
    return session;
  }
  #editorDraftState(session) {
    const parameters = new Map(session.effect.state.parameters.map(item => [item.id, item.value]));
    for (const [id, value] of session.draftParameters) parameters.set(id, value);
    return validateEditorState({ ...session.effect.state,
      parameters: [...parameters].map(([id, value]) => ({ id, value })) },
    session.effect.classId, session.parameters);
  }
  /** The effect exactly as the caller identified it (no resolved path). */
  #callerEffect(session) {
    const { authorizedPath, ...identity } = session.effect;
    return { ...identity, path: session.requestedPath };
  }
  #makeEditorRecovery(session, state, error) {
    const effectState = state ?? this.#editorDraftState(session);
    const identity = this.#callerEffect(session);
    return {
      schema: 1,
      id: session.recoveryRecord?.id ?? randomUUID(),
      projectId: session.context.projectId,
      trackId: session.context.trackId,
      slotId: session.context.slotId,
      originalEffect: identity,
      effect: { ...identity, state: effectState },
      ...(error ? { error: String(error).slice(0, 2048) } : {}),
      createdAt: Date.now(),
    };
  }
  #makePendingEditorRecovery(opening, error) {
    return {
      schema: 1,
      id: opening.recoveryRecord?.id ?? randomUUID(),
      projectId: opening.context.projectId,
      trackId: opening.context.trackId,
      slotId: opening.context.slotId,
      originalEffect: opening.effect,
      effect: opening.effect,
      error: String(error).slice(0, 2048),
      createdAt: Date.now(),
    };
  }
  #session(id, owner) {
    const session = this.#sessions.get(id);
    if (!session || session.owner !== owner) throw new Error('VST3 session is closed or belongs to another renderer');
    return session;
  }
  assertSession(id, owner) { this.#session(id, owner); }
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
    const opened = await this.open(instrument, 48000, 'offline', owner, 'instrument');
    try { return { parameters: opened.parameters, controllerAvailable: opened.controllerAvailable }; }
    finally { await this.close(opened.id, owner); }
  }
  async describeEffect(effect, owner = 'local') {
    const opened = await this.open(effect, 48000, 'offline', owner, 'effect');
    try { return { parameters: opened.parameters, controllerAvailable: opened.controllerAvailable, latencySamples: opened.latencySamples }; }
    finally { await this.close(opened.id, owner); }
  }
  async inspectEffect(plugin, state, owner = 'local') {
    const effect = { ...plugin, ...(state === undefined ? {} : { state }) };
    const opened = await this.open(effect, 48000, 'offline', owner, 'effect');
    try {
      const session = this.#session(opened.id, owner);
      // Effect parameters are applied at the next actual process block by the
      // helper. One bounded zero-frame-free sample advances that native state
      // before the component/controller snapshot is captured.
      await session.client.processAudio(1, new Float32Array(2));
      return { path: plugin.path, classId: plugin.classId, name: plugin.name,
        vendor: plugin.vendor, version: plugin.version, state: await session.client.snapshot() };
    } finally { await this.close(opened.id, owner); }
  }
  async parameters(id, changes, owner = 'local') {
    const session = this.#session(id, owner);
    if (session.processing) throw new Error('Concurrent VST3 parameter/process request rejected');
    const validated = validateParameterChanges(changes, session.parameters);
    session.processing = true;
    try {
      const response = await session.client.request({ command: 'parameters', parameters: validated });
      if (response.latencySamples !== undefined) {
        session.latencySamples = this.#validateLatency(response.latencySamples, session.kind, session.sampleRate);
      }
      // A missing/invalid controller response is never acknowledged as a successful edit.
      session.parameters = validateMetadata(response.parameters, true);
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
  /** OS pid of the helper backing a session, for diagnostics and evidence.
   * Returns null when the session is unknown to this owner or the spawn failed.
   * This is an observation of the real child process, never a fabricated value. */
  getSessionHelperPid(id, owner = 'local') {
    const session = this.#sessions.get(id);
    return session && session.owner === owner ? session.client.pid ?? null : null;
  }
  /** OS pid of the editor helper while its session is open or opening. */
  getEditorHelperPid(owner = null) {
    const client = this.#editor?.client ?? this.#editorOpening?.client ?? null;
    if (!client) return null;
    const clientOwner = this.#editor?.owner ?? this.#editorOpening?.owner ?? null;
    return owner === null || owner === clientOwner ? client.pid ?? null : null;
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
    const opening = this.#editorOpening?.owner === owner ? this.#editorOpening : null;
    if (opening) {
      // Let an in-flight editorOpen finish its native handshake. openEditor sees
      // the invalidated owner token and closes/captures before resolving; killing
      // the helper here could otherwise lose a view that was already visible.
      opening.cancelled = true;
      await opening.settled.catch(() => {});
    }
    for (const [client, loadingOwner] of this.#loading) {
      if (loadingOwner === owner && client !== opening?.client) client.abort();
    }

    let recovery = opening?.recoveryRecord ?? null;
    // A crashed editor this renderer owned still owes a recovery record.
    for (const [id, retired] of [...this.#retiredEditors]) {
      if (retired.owner !== owner) continue;
      recovery = recovery ?? retired.recoveryRecord;
      this.#retiredEditors.delete(id);
    }
    const editor = this.#editor?.owner === owner ? this.#editor : null;
    if (editor) {
      if (editor.busyPromise) await editor.busyPromise.catch(() => {});
      try {
        const result = editor.closed ? editor.finalStatus : await this.closeEditor(editor.id, owner);
        recovery = this.#makeEditorRecovery(editor, result.state);
      } catch (error) {
        recovery = this.#makeEditorRecovery(editor, null,
          `Editor state capture failed during renderer shutdown; the last captured parameter values and previous committed plug-in state were retained. ${error.message}`);
      }
      if (this.#editor === editor) this.#editor = null;
      if (!editor.client.isDead) {
        if (!editor.closed) editor.client.abort();
        await editor.client.dispose().catch(() => {});
      }
    }
    await Promise.all([...this.#sessions].filter(([, session]) => session.owner === owner).map(([id]) => this.close(id, owner)));
    return recovery;
  }
  async dispose() {
    this.#closed = true;
    for (const controller of this.#scans.values()) controller.abort();
    const owners = new Set([...this.#sessions.values()].map(session => session.owner));
    if (this.#editor) owners.add(this.#editor.owner);
    if (this.#editorOpening) owners.add(this.#editorOpening.owner);
    for (const [client, owner] of this.#loading) {
      if (owner !== this.#editorOpening?.owner) client.abort();
    }
    await Promise.all([...owners].map(owner => this.closeOwner(owner)));
    await Promise.all([...this.#closing]);
    this.#ownerTokens.clear();
  }
}
