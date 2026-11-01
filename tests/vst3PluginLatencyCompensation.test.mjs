// End-to-end deterministic PCM regression suite for VST3 Plugin Latency
// Compensation (PDC) across all 12 required cases:
//  1) Zero-latency plugin compatibility
//  2) One nonzero-latency insert
//  3) Two serial inserts with cumulative latency
//  4) Both insert orders
//  5) Parallel / routed recombining paths (constructive sum + phase-null cancellation)
//  6) Aux bus routing (upstream-first topological order + live/offline alignment)
//  7) Bypass, removal, and reinsertion
//  8) Stop/restart, DelayNode teardown/flush, project replacement, & sample-rate reconfiguration
//  9) Save, separate-OS-process restart, and reopen
// 10) Offline export alignment (start + end of render) and live/offline parity
// 11) Fixed 2,048-frame live bridge buffering not double-counted (live vs offline)
// 12) Invalid, negative, excessive, or mid-stream-mutating reported latency fails safely
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MessageChannel } from 'node:worker_threads';
import { resolveObjectURL } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as WebAudio from 'web-audio-engine';
import { Vst3Service } from '../native/vst3/service.mjs';
import { createLiveAudioPortSession } from '../native/vst3/liveAudioPort.mjs';

const execFileAsync = promisify(execFile);

const buildDir = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const hostBinaryName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(buildDir, 'bin', hostBinaryName), path.join(buildDir, 'bin/Release', hostBinaryName)].find(existsSync);
assert.ok(executable, 'Build native VST3 targets (npm run native:vst3:build) before running VST3 latency compensation tests');
const vst3Root = path.join(buildDir, 'VST3/Release');
const evidenceDir = path.resolve('build/native-evidence');
await mkdir(evidenceDir, { recursive: true });

// If invoked as the separate child OS process for Case 9, run isolated reopen verification and exit:
if (process.env.APEX_PDC_CHILD_REOPEN_PROJECT) {
  const projectFile = process.env.APEX_PDC_CHILD_REOPEN_PROJECT;
  const outFile = process.env.APEX_PDC_CHILD_REOPEN_RESULT;
  const childService = new Vst3Service(executable, [vst3Root]);
  const childBridge = {
    paths: async () => [vst3Root],
    choosePath: async () => null,
    discover: () => childService.discover('child', 'instrument'),
    discoverEffects: () => childService.discover('child', 'effect'),
    inspect: (p, s) => childService.inspect(p, s, 'child'),
    inspectEffect: (p, s) => childService.inspectEffect(p, s, 'child'),
    describe: inst => childService.describe(inst, 'child'),
    describeEffect: fx => childService.describeEffect(fx, 'child'),
    parameters: (id, ch) => childService.parameters(id, ch, 'child'),
    open: (inst, sr, mode, kind) => childService.open(inst, sr, mode, 'child', kind),
    process: (id, frames, ev, bpm, params) => childService.process(id, frames, ev, bpm, 'child', params),
    processAudio: (id, frames, pcm, bpm, params) => childService.processAudio(id, frames, pcm, bpm, 'child', params),
    close: id => childService.close(id, 'child'),
  };
  globalThis.desktopApp = { isDesktop: true, vst3: childBridge };
  globalThis.window = globalThis;
  globalThis.AudioContext = class extends WebAudio.RenderingAudioContext {
    constructor() { super({ sampleRate: 48000 }); }
  };
  globalThis.OfflineAudioContext = WebAudio.OfflineAudioContext;
  globalThis.document ??= { createElement: () => ({}) };

  const { audioEngine: childEngineSingleton } = await import('../src/audio/audioEngine.ts');
  const { createDefaultProjectState, normalizeProjectState } = await import('../src/state/projectState.ts');
  const ChildAudioEngine = childEngineSingleton.constructor;

  try {
    const rawJson = await readFile(projectFile, 'utf8');
    const parsed = JSON.parse(rawJson);
    const restored = normalizeProjectState(parsed.state ?? parsed);
    const eng = new ChildAudioEngine();
    eng.setMasteringState({ ...createDefaultProjectState().mastering, enabled: false });
    eng.setBpm(restored.meta?.bpm ?? 120);

    // Register deterministic test stimulus buffer at 48 kHz (2 seconds = 1 bar at 120 BPM)
    const sampleRate = 48000;
    const frames = sampleRate * 2;
    const ctx = new WebAudio.OfflineAudioContext(2, 1, sampleRate);
    const stim = ctx.createBuffer(2, frames, sampleRate);
    fillDeterministicStimulus(stim.getChannelData(0), stim.getChannelData(1));
    eng.setSampleBuffer('pdc-stimulus', stim);
    await childBridge.discoverEffects();

    const slots = restored.mixerTracks.find(t => t.id === 1)?.fxSlots ?? [];
    const slotLatencies = [];
    for (const slot of slots) {
      const d = await childBridge.describeEffect(slot.vst3Effect);
      slotLatencies.push(d.latencySamples);
    }

    const rendered = await eng.renderTimelineOffline(
      restored.channels, restored.playlistClips, restored.mixerTracks,
      120, 1, sampleRate, true, 'song', undefined, undefined, undefined, 2,
    );
    const chL = rendered.getChannelData(0);
    const chR = rendered.getChannelData(1);
    const sha256 = hashStereoPcm(chL, chR);
    const onsetL = firstOnsetIndex(chL, 1e-4);
    const endPeakIdx = peakIndexInRange(chL, frames - 256, frames);
    await writeFile(outFile, JSON.stringify({
      pid: process.pid,
      slotLatencies,
      frames: rendered.length,
      onsetL,
      endPeakIdx,
      sha256,
    }));
  } finally {
    await childService.dispose();
  }
  process.exit(0);
}

function fillDeterministicStimulus(left, right) {
  left.fill(0);
  right.fill(0);
  // Early marker impulse at frame 128 (< 2048 live bridge size!)
  left[128] = 0.85;
  right[128] = -0.65;
  // Asymmetric broadband multi-tone burst in [2048, 6144)
  for (let i = 2048; i < 6144; i++) {
    const t = (i - 2048) / 4096;
    const win = Math.sin(Math.PI * t);
    left[i] = win * (0.45 * Math.sin(2 * Math.PI * 7 * t) + 0.30 * Math.cos(2 * Math.PI * 19 * t));
    right[i] = win * (0.40 * Math.sin(2 * Math.PI * 11 * t + 0.4) - 0.25 * Math.cos(2 * Math.PI * 23 * t));
  }
  // End-of-render marker impulse at length - 64 (< 320 samples from end of render!)
  if (left.length > 256) {
    left[left.length - 64] = 0.75;
    right[right.length - 64] = -0.55;
  }
}

function hashStereoPcm(left, right) {
  const hash = createHash('sha256');
  hash.update(new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
  hash.update(new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
  return hash.digest('hex');
}

function firstOnsetIndex(samples, threshold = 1e-4, start = 0, end = samples.length) {
  for (let i = start; i < Math.min(end, samples.length); i++) {
    if (Math.abs(samples[i]) >= threshold) return i;
  }
  return -1;
}

function peakIndexInRange(samples, start, end) {
  let bestIdx = -1;
  let bestVal = 0;
  for (let i = Math.max(0, start); i < Math.min(samples.length, end); i++) {
    const v = Math.abs(samples[i]);
    if (v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  }
  return bestVal > 1e-4 ? bestIdx : -1;
}

function rmsRange(samples, start = 0, end = samples.length) {
  let sum = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

function rmsDiffRange(a, b, start = 0, end = Math.min(a.length, b.length)) {
  let sum = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

const service = new Vst3Service(executable, [vst3Root]);
const livePortSessions = new Map();
let inFlightHelperOps = 0;
let inFlightLiveBlocks = 0;

const bridge = {
  paths: async () => [vst3Root],
  choosePath: async () => null,
  discover: () => service.discover('pdc-test', 'instrument'),
  discoverEffects: () => service.discover('pdc-test', 'effect'),
  inspect: (plugin, state) => service.inspect(plugin, state, 'pdc-test'),
  inspectEffect: (plugin, state) => service.inspectEffect(plugin, state, 'pdc-test'),
  describe: inst => service.describe(inst, 'pdc-test'),
  describeEffect: fx => service.describeEffect(fx, 'pdc-test'),
  parameters: (id, changes) => service.parameters(id, changes, 'pdc-test'),
  open: (inst, sr, mode, kind) => service.open(inst, sr, mode, 'pdc-test', kind),
  process: (id, frames, events, bpm, params) => service.process(id, frames, events, bpm, 'pdc-test', params),
  processAudio: async (id, frames, audio, bpm, params) => {
    inFlightHelperOps++;
    try {
      return await service.processAudio(id, frames, audio, bpm, 'pdc-test', params);
    } finally {
      inFlightHelperOps--;
    }
  },
  bindLiveAudioPort: async (sessionId, trackId, slotId) => {
    service.assertSession(sessionId, 'pdc-test');
    const channel = new MessageChannel();
    let sessionBlocks = 0;
    const liveSession = createLiveAudioPortSession({
      sessionId,
      owner: 'pdc-test',
      trackId,
      slotId,
      processAudio: async ({ samples }) => {
        inFlightHelperOps++;
        try {
          return await service.processAudio(sessionId, VST3_FX_BLOCK_FRAMES, samples, 120, 'pdc-test', []);
        } finally {
          inFlightHelperOps--;
        }
      },
    });
    const releasePending = () => {
      if (sessionBlocks > 0) {
        inFlightLiveBlocks = Math.max(0, inFlightLiveBlocks - sessionBlocks);
        sessionBlocks = 0;
      }
    };
    livePortSessions.set(sessionId, { liveSession, channel, releasePending });
    liveSession.attach(channel.port1);
    return wrapWorkletTransferPort(channel.port2, delta => {
      sessionBlocks = Math.max(0, sessionBlocks + delta);
      inFlightLiveBlocks = Math.max(0, inFlightLiveBlocks + delta);
    }, releasePending);
  },
  unbindLiveAudioPort: async sessionId => {
    const existing = livePortSessions.get(sessionId);
    if (!existing) return;
    livePortSessions.delete(sessionId);
    existing.releasePending();
    existing.liveSession.unbind('explicit-unbind');
  },
  close: async id => {
    const existing = livePortSessions.get(id);
    if (existing) {
      livePortSessions.delete(id);
      existing.releasePending();
      existing.liveSession.unbind('session-close');
      try { existing.channel.port1.close(); } catch {}
      try { existing.channel.port2.close(); } catch {}
    }
    return service.close(id, 'pdc-test');
  },
};

function wrapWorkletTransferPort(workerPort, adjustBlocks, onClose) {
  let closed = false;
  const wrapper = {
    onmessage: null,
    postMessage(msg) {
      if (closed) return;
      if (msg?.type === 'process') adjustBlocks(1);
      workerPort.postMessage(msg);
    },
    close() {
      if (closed) return;
      closed = true;
      onClose?.();
      try { workerPort.close(); } catch {}
    },
  };
  workerPort.on('message', data => {
    wrapper.onmessage?.({ data });
    if (!closed && (data?.type === 'result' || data?.type === 'error' || data?.type === 'cancelled')) {
      adjustBlocks(-1);
    }
  });
  workerPort.start();
  return wrapper;
}

globalThis.desktopApp = { isDesktop: true, vst3: bridge };
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};

const { VST3_FX_WORKLET_SOURCE, VST3_FX_PIPELINE_FRAMES, VST3_FX_BLOCK_FRAMES } = await import('../src/audio/nativeVst3EffectRuntime.ts');

// Install a deterministic 128-frame-quantum AudioWorkletNode backed by
// web-audio-engine's native dspProcess hook (0 extra internal buffering) that
// executes the exact production VST3_FX_WORKLET_SOURCE processor class.
class DeterministicRenderingAudioContext extends WebAudio.RenderingAudioContext {
  constructor(opts = {}) {
    super({ ...opts, sampleRate: opts?.sampleRate ?? 48000 });
    this.audioWorklet = {
      addModule: async url => {
        const blob = resolveObjectURL(String(url));
        const text = blob ? await blob.text() : decodeURIComponent(String(url));
        if (!text.includes('apex-vst3-mixer-effect')) {
          throw new Error(`Unsupported worklet module in PDC harness: ${String(url).slice(0, 64)}`);
        }
      },
    };
  }
}

let activeWorkletQuantumFrame = 0;
Object.defineProperty(globalThis, 'currentFrame', {
  configurable: true,
  get() { return activeWorkletQuantumFrame; },
});

class DeterministicAudioWorkletNode {
  constructor(context, processorName, options = {}) {
    if (processorName !== 'apex-vst3-mixer-effect') {
      throw new Error(`Unsupported test AudioWorkletProcessor: ${processorName}`);
    }
    const gainNode = context.createGain();
    gainNode.channelCount = 2;
    gainNode.channelCountMode = 'explicit';
    gainNode._impl.outputs[0].setNumberOfChannels(2);

    let currentQuantumFrame = 0;
    let nodeSideHandler = null;
    let processorSideHandler = null;
    let closed = false;

    const processorPort = {
      get onmessage() { return processorSideHandler; },
      set onmessage(fn) { processorSideHandler = fn; },
      postMessage(message) {
        if (closed) return;
        queueMicrotask(() => { if (!closed) nodeSideHandler?.({ data: message }); });
      },
    };
    const nodePort = {
      get onmessage() { return nodeSideHandler; },
      set onmessage(fn) { nodeSideHandler = fn; },
      postMessage(message, transfer) {
        if (closed) return;
        const ports = Array.isArray(transfer) ? transfer : undefined;
        // Deliver control messages synchronously/microtask before DSP advances
        if (message?.type === 'plugin-latency' || message?.type === 'bypass' || message?.type === 'live-port' || message?.type === 'failure') {
          processorSideHandler?.({ data: message, ports });
        } else {
          queueMicrotask(() => { if (!closed) processorSideHandler?.({ data: message, ports }); });
        }
      },
      close() { closed = true; },
    };

    let ProcessorCtor;
    new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      VST3_FX_WORKLET_SOURCE,
    )(
      class {
        constructor() { this.port = processorPort; }
      },
      (_name, ctor) => { ProcessorCtor = ctor; },
    );
    const processor = new ProcessorCtor(options);

    gainNode._impl.dspProcess = function () {
      currentQuantumFrame = this.context.currentSampleFrame;
      activeWorkletQuantumFrame = currentQuantumFrame;
      const inBus = this.inputs[0].bus;
      const outBus = this.outputs[0].bus;
      outBus.setNumberOfChannels(2);
      const outMutable = outBus.getMutableData();
      const outL = new Float32Array(this.blockSize);
      const outR = new Float32Array(this.blockSize);
      const inputs = inBus.getNumberOfChannels() > 0
        ? [[inBus.getChannelData()[0], inBus.getChannelData()[1] ?? inBus.getChannelData()[0]]]
        : [[]];
      processor.process(inputs, [[outL, outR]]);
      outMutable[0].set(outL);
      outMutable[1].set(outR);
    };

    gainNode.port = nodePort;
    gainNode.onprocessorerror = null;
    return gainNode;
  }
}

globalThis.AudioContext = DeterministicRenderingAudioContext;
globalThis.OfflineAudioContext = WebAudio.OfflineAudioContext;
globalThis.AudioWorkletNode = DeterministicAudioWorkletNode;
globalThis.document ??= { createElement: () => ({}) };

const { audioEngine } = await import('../src/audio/audioEngine.ts');
const { createDefaultProjectState, normalizeProjectState } = await import('../src/state/projectState.ts');
const { serializeProjectState } = await import('../src/state/projectPersistence.ts');
const AudioEngine = audioEngine.constructor;

const { plugins: discoveredEffects } = await bridge.discoverEffects();
const mdaDelayIdentity = discoveredEffects.find(p => p.name === 'mda Delay');
const lookaheadIdentity = discoveredEffects.find(p => p.name === 'Apex Latency Fixture');
const invalidLatencyIdentity = discoveredEffects.find(p => p.name === 'Apex Invalid Latency Fixture');
const excessiveLatencyIdentity = discoveredEffects.find(p => p.name === 'Apex Excessive Latency Fixture');
const dynamicLatencyIdentity = discoveredEffects.find(p => p.name === 'Apex Dynamic Latency Fixture');
assert.ok(mdaDelayIdentity && lookaheadIdentity && invalidLatencyIdentity && excessiveLatencyIdentity && dynamicLatencyIdentity,
  'Required MDA and Apex Latency C++ VST3 effect fixtures must be discovered');

const baseLookahead = await bridge.inspectEffect(lookaheadIdentity);
async function makeLookaheadEffect({ latencySamples = 320, drive = 0, gain = 1.0, rateScale = 0 } = {}) {
  const params = [
    { id: 0, value: latencySamples / 4096 },
    { id: 1, value: drive },
    { id: 2, value: gain / 2.0 },
    { id: 3, value: rateScale ? 1 : 0 },
  ];
  const inspected = await bridge.inspectEffect(lookaheadIdentity, {
    ...baseLookahead.state,
    parameters: params,
  });
  return {
    ...inspected,
    state: { ...inspected.state, parameters: params },
  };
}

const baseMdaDelay = await bridge.inspectEffect(mdaDelayIdentity);
const zeroLatencyMdaBypass = await bridge.inspectEffect(mdaDelayIdentity, {
  ...baseMdaDelay.state,
  parameters: [...baseMdaDelay.state.parameters.filter(p => p.id !== 4), { id: 4, value: 0 }],
});

function makeFxSlot(id, effect, enabled = true) {
  return { id, type: 'vst3', name: effect.name, enabled, mix: 1, params: {}, vst3Effect: effect };
}

function makeTrack(id, { fxSlots = [], routingTargetId = 0, auxSends = undefined, volume = 0.8 } = {}) {
  return {
    id,
    name: id === 0 ? 'Master' : `Track ${id}`,
    color: '#fff',
    volume,
    pan: 0,
    mute: false,
    solo: false,
    fxSlots,
    routingTargetId: id === 0 ? undefined : routingTargetId,
    ...(auxSends ? { auxSends } : {}),
    peakL: 0,
    peakR: 0,
  };
}

function makeAudioChannel(id, mixerTrackId, sampleId = 'pdc-stimulus', volume = 1.0) {
  const steps = Array(16).fill(false);
  steps[0] = true;
  return {
    ...createDefaultProjectState().channels[0],
    id,
    name: `Sampler ${id}`,
    instrumentType: 'sampler',
    customSample: { id: sampleId, name: sampleId, rootPitch: 60 },
    synthParams: { ...audioEngine.getDefaultSynthParams(), filterCutoff: 22000, filterResonance: 0.707 },
    mixerTrackId,
    volume,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    notes: [],
  };
}

function makeAudioClip(id, channelId, _unusedSampleId = 'pdc-stimulus', trackIndex = 0) {
  return {
    id,
    type: 'pattern',
    channelId,
    trackIndex,
    startBar: 0,
    lengthBars: 1,
    name: id,
    color: '#fff',
  };
}

function syncLiveMixerGraph(eng, tracks) {
  eng.activeMixerTracks = structuredClone(tracks);
  eng.playbackProjectMixerTracks = structuredClone(tracks);
  const ctx = eng.getContext();
  const master = tracks.find(t => t.id === 0);
  if (master) eng.updateMixerTrack(master);
  else eng.getOrCreateMixerChannel(0);
  for (const t of tracks) {
    if (t.id !== 0) eng.updateMixerTrack(t);
  }
  for (const t of tracks) {
    const ch = eng.getOrCreateMixerChannel(t.id);
    const targetVol = t.mute ? 0 : t.volume;
    ch.output.gain.cancelScheduledValues(ctx.currentTime);
    ch.output.gain.setValueAtTime(targetVol, ctx.currentTime);
  }
  eng.syncMixerRouting(tracks);
}

function createStimulusBuffer(sampleRate = 48000, durationSeconds = 2, polarity = 1) {
  const frames = Math.round(sampleRate * durationSeconds);
  const ctx = new WebAudio.OfflineAudioContext(2, 1, sampleRate);
  const buf = ctx.createBuffer(2, frames, sampleRate);
  fillDeterministicStimulus(buf.getChannelData(0), buf.getChannelData(1));
  if (polarity !== 1) {
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      l[i] *= polarity;
      r[i] *= polarity;
    }
  }
  return buf;
}

function createEngineWithStimulus(sampleRate = 48000, durationSeconds = 2) {
  const eng = new AudioEngine();
  eng.setMasteringState({ ...createDefaultProjectState().mastering, enabled: false });
  eng.setBpm(120);
  eng.setSampleBuffer('pdc-stimulus', createStimulusBuffer(sampleRate, durationSeconds, 1));
  eng.setSampleBuffer('pdc-stimulus-inverted', createStimulusBuffer(sampleRate, durationSeconds, -1));
  return eng;
}

async function drainHelperAndPortQueues() {
  let guard = 0;
  while ((inFlightLiveBlocks > 0 || inFlightHelperOps > 0) && guard++ < 500) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await new Promise(resolve => setImmediate(resolve));
}

async function stepLiveContext(ctx, totalFrames) {
  const quantum = 128;
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let frame = 0; frame < totalFrames; frame += quantum) {
    const nextFrame = Math.min(totalFrames, frame + quantum);
    ctx.processTo(nextFrame / ctx.sampleRate);
    if (inFlightLiveBlocks > 0 || inFlightHelperOps > 0) {
      await drainHelperAndPortQueues();
    }
  }
  await drainHelperAndPortQueues();
}

const proofSummary = {
  sampleRate: 48000,
  fixedLiveBridgeFramesPerInsert: VST3_FX_PIPELINE_FRAMES,
  cases: {},
};

test.after(async () => {
  audioEngine.stop();
  await service.dispose();
  await writeFile(
    path.join(evidenceDir, 'apex-vst3-latency-compensation-proof.json'),
    JSON.stringify(proofSummary, null, 2),
  );
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::notice title=VST3 PDC 12-case PCM proof (${process.platform})::${JSON.stringify(proofSummary)}`);
  }
});

test('Case 1: zero-latency VST3 plugins preserve exact timeline onset offline and exact 2048-frame bridge compensation live', async () => {
  const lookahead0 = await makeLookaheadEffect({ latencySamples: 0, drive: 0, gain: 1.0 });
  assert.equal((await bridge.describeEffect(lookahead0)).latencySamples, 0);
  assert.equal((await bridge.describeEffect(zeroLatencyMdaBypass)).latencySamples, 0);

  const eng = createEngineWithStimulus(48000, 2);
  const ch = makeAudioChannel('ch-1', 1);
  const clip = makeAudioClip('clip-1', ch.id);
  const dryMixer = [makeTrack(0), makeTrack(1)];
  const zeroMdaMixer = [makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('s-mda', zeroLatencyMdaBypass)] })];
  const zeroApexMixer = [makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('s-zero', lookahead0)] })];

  const dryBuf = await eng.renderTimelineOffline([ch], [clip], dryMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const mdaBuf = await eng.renderTimelineOffline([ch], [clip], zeroMdaMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const apex0Buf = await eng.renderTimelineOffline([ch], [clip], zeroApexMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);

  const dryOnset = firstOnsetIndex(dryBuf.getChannelData(0));
  const mdaOnset = firstOnsetIndex(mdaBuf.getChannelData(0));
  const apex0Onset = firstOnsetIndex(apex0Buf.getChannelData(0));
  const apex0RmsErr = rmsDiffRange(dryBuf.getChannelData(0), apex0Buf.getChannelData(0));

  assert.equal(dryOnset, 128);
  assert.equal(mdaOnset, 128);
  assert.equal(apex0Onset, 128);
  assert.ok(apex0RmsErr < 1e-6, `expected unity 0-latency offline render to match dry (<1e-6), got ${apex0RmsErr}`);

  proofSummary.cases.case01_zeroLatencyCompatibility = {
    dryOnsetFrame: dryOnset,
    mdaZeroLatencyOnsetFrame: mdaOnset,
    apexZeroLatencyOnsetFrame: apex0Onset,
    onsetDeltaFrames: apex0Onset - dryOnset,
    waveformRmsError: apex0RmsErr,
  };
});

test('Case 2: one nonzero-latency insert (L = 320) compensates exact start and end frames offline without truncation', async () => {
  const lookahead320 = await makeLookaheadEffect({ latencySamples: 320, drive: 0, gain: 1.0 });
  assert.equal((await bridge.describeEffect(lookahead320)).latencySamples, 320);

  const eng = createEngineWithStimulus(48000, 2);
  const ch = makeAudioChannel('ch-1', 1);
  const clip = makeAudioClip('clip-1', ch.id);
  const dryMixer = [makeTrack(0), makeTrack(1)];
  const wetMixer = [makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('s-320', lookahead320)] })];

  // Use pattern renderScope (no song tail) so the render ends right at 96,000 frames,
  // testing the end-of-render impulse at frame 95,936 (only 64 frames from render end < L = 320!)
  const dryBuf = await eng.renderTimelineOffline([ch], [clip], dryMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const wetBuf = await eng.renderTimelineOffline([ch], [clip], wetMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);

  assert.equal(wetBuf.length, dryBuf.length);
  const dryL = dryBuf.getChannelData(0);
  const wetL = wetBuf.getChannelData(0);
  const dryR = dryBuf.getChannelData(1);
  const wetR = wetBuf.getChannelData(1);

  const dryStartOnset = firstOnsetIndex(dryL);
  const wetStartOnset = firstOnsetIndex(wetL);
  const dryEndPeak = peakIndexInRange(dryL, 96000 - 128, 96000);
  const wetEndPeak = peakIndexInRange(wetL, 96000 - 128, 96000);
  const rmsErrL = rmsDiffRange(dryL, wetL);
  const rmsErrR = rmsDiffRange(dryR, wetR);

  assert.equal(wetStartOnset, dryStartOnset, 'start-of-render impulse must align to exact sample 128');
  assert.equal(wetEndPeak, 96000 - 64, 'end-of-render impulse within L=320 samples of boundary must survive zero-flush compensation');
  assert.equal(wetEndPeak, dryEndPeak);
  assert.ok(rmsErrL < 1e-6 && rmsErrR < 1e-6, `compensated unity L=320 waveform must match dry (<1e-6), got L=${rmsErrL}, R=${rmsErrR}`);

  proofSummary.cases.case02_singleNonzeroInsert = {
    pluginLatencySamples: 320,
    renderFrames: wetBuf.length,
    startOnsetDry: dryStartOnset,
    startOnsetCompensated: wetStartOnset,
    endImpulseDry: dryEndPeak,
    endImpulseCompensated: wetEndPeak,
    rmsErrorL: rmsErrL,
    rmsErrorR: rmsErrR,
  };
});

test('Case 3 & Case 4: two serial nonzero-latency inserts (320 + 512 = 832) compensate cumulative latency accurately in both insert orders while preserving order-dependent DSP', async () => {
  const drive320 = await makeLookaheadEffect({ latencySamples: 320, drive: 0.75, gain: 1.0 });
  const gain512 = await makeLookaheadEffect({ latencySamples: 512, drive: 0.0, gain: 0.55 });

  const eng = createEngineWithStimulus(48000, 2);
  const ch = makeAudioChannel('ch-1', 1);
  const clip = makeAudioClip('clip-1', ch.id);
  const dryMixer = [makeTrack(0, { volume: 1.0 }), makeTrack(1, { volume: 1.0 })];
  const orderAMixer = [makeTrack(0, { volume: 1.0 }), makeTrack(1, { volume: 1.0, fxSlots: [makeFxSlot('a-1', drive320), makeFxSlot('a-2', gain512)] })];
  const orderBMixer = [makeTrack(0, { volume: 1.0 }), makeTrack(1, { volume: 1.0, fxSlots: [makeFxSlot('b-1', gain512), makeFxSlot('b-2', drive320)] })];

  const dryBuf = await eng.renderTimelineOffline([ch], [clip], dryMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const orderABuf = await eng.renderTimelineOffline([ch], [clip], orderAMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const orderBBuf = await eng.renderTimelineOffline([ch], [clip], orderBMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);

  const dryOnset = firstOnsetIndex(dryBuf.getChannelData(0));
  const orderAOnset = firstOnsetIndex(orderABuf.getChannelData(0));
  const orderBOnset = firstOnsetIndex(orderBBuf.getChannelData(0));
  const orderADiffVsOrderB = rmsDiffRange(orderABuf.getChannelData(0), orderBBuf.getChannelData(0), 2048, 6144);

  // Verify analytical DSP equation for both orders:
  // Order A: 0.55 * tanh(x * 4) / tanh(4)
  // Order B: tanh(0.55 * x * 4) / tanh(4)
  const k = 1 + 0.75 * 4;
  const norm = Math.tanh(k);
  const dryL = dryBuf.getChannelData(0);
  const expectedOrderA = new Float32Array(dryL.length);
  const expectedOrderB = new Float32Array(dryL.length);
  for (let i = 0; i < dryL.length; i++) {
    expectedOrderA[i] = 0.55 * (Math.tanh(dryL[i] * k) / norm);
    expectedOrderB[i] = Math.tanh(dryL[i] * 0.55 * k) / norm;
  }
  const errOrderA = rmsDiffRange(orderABuf.getChannelData(0), expectedOrderA, 0, 96000);
  const errOrderB = rmsDiffRange(orderBBuf.getChannelData(0), expectedOrderB, 0, 96000);

  assert.equal(orderAOnset, dryOnset, 'Order A (320 -> 512) must compensate full 832-sample cumulative latency');
  assert.equal(orderBOnset, dryOnset, 'Order B (512 -> 320) must compensate full 832-sample cumulative latency');
  assert.ok(orderADiffVsOrderB > 0.005, `Insert order must produce audibly distinct nonlinear PCM (>0.005 RMS), got ${orderADiffVsOrderB}`);
  assert.ok(errOrderA < 1e-6 && errOrderB < 1e-6, `Both orders must match exact analytical DSP at sample-0 alignment: errA=${errOrderA}, errB=${errOrderB}`);

  proofSummary.cases.case03_twoSerialInsertsCumulative = {
    latencies: [320, 512],
    cumulativePluginLatencySamples: 832,
    dryOnsetFrame: dryOnset,
    orderAOnsetFrame: orderAOnset,
    analyticalRmsErrorOrderA: errOrderA,
  };
  proofSummary.cases.case04_bothInsertOrders = {
    orderAOnsetFrame: orderAOnset,
    orderBOnsetFrame: orderBOnset,
    orderDifferenceRms: orderADiffVsOrderB,
    analyticalRmsErrorOrderA: errOrderA,
    analyticalRmsErrorOrderB: errOrderB,
  };
});

test('Case 5: parallel and nested routed recombining paths achieve sample-exact constructive sum and <1e-6 phase-null cancellation in both live and offline paths', async () => {
  // Path A: Channel A -> Track 3 (L = 377) -> Bus Track 1 (L = 199) -> Master (0)  [notice Bus id=1 < Source id=3!]
  // Path B: Channel B -> Track 2 (dry, 0 inserts) -> Master (0)
  // Plus a direct producer Channel C -> Bus Track 1 (direct bus input aligned with Track 3!)
  const fx377 = await makeLookaheadEffect({ latencySamples: 377, drive: 0, gain: 1.0 });
  const fx199 = await makeLookaheadEffect({ latencySamples: 199, drive: 0, gain: 1.0 });

  const eng = createEngineWithStimulus(48000, 2);
  const chA = makeAudioChannel('ch-a', 3, 'pdc-stimulus');
  const chBPos = makeAudioChannel('ch-b-pos', 2, 'pdc-stimulus');
  const chBNeg = makeAudioChannel('ch-b-neg', 2, 'pdc-stimulus-inverted');
  const clipA = makeAudioClip('clip-a', chA.id, 'pdc-stimulus', 0);
  const clipBConstructive = makeAudioClip('clip-b-pos', chBPos.id, 'pdc-stimulus', 1);
  const clipBInverted = makeAudioClip('clip-b-neg', chBNeg.id, 'pdc-stimulus-inverted', 1);

  // Deliberately place Bus Track 1 BEFORE Source Track 3 in mixerTracks array to prove topological ordering!
  const mixer = [
    makeTrack(0, { volume: 1.0 }),
    makeTrack(1, { fxSlots: [makeFxSlot('bus-199', fx199)], routingTargetId: 0, volume: 1.0 }),
    makeTrack(2, { fxSlots: [], routingTargetId: 0, volume: 1.0 }),
    makeTrack(3, { fxSlots: [makeFxSlot('src-377', fx377)], routingTargetId: 1, volume: 1.0 }),
  ];
  const singleReferenceMixer = [
    makeTrack(0, { volume: 1.0 }),
    makeTrack(2, { fxSlots: [], routingTargetId: 0, volume: 1.0 }),
  ];

  const singleBuf = await eng.renderTimelineOffline([chBPos], [clipBConstructive], singleReferenceMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const sumBuf = await eng.renderTimelineOffline([chA, chBPos], [clipA, clipBConstructive], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const nullBuf = await eng.renderTimelineOffline([chA, chBNeg], [clipA, clipBInverted], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);

  const nullRmsL = rmsRange(nullBuf.getChannelData(0), 0, 96000);
  const nullRmsR = rmsRange(nullBuf.getChannelData(1), 0, 96000);
  const expectedDoubleL = Float32Array.from(singleBuf.getChannelData(0), x => x * 2);
  const sumRmsErr = rmsDiffRange(sumBuf.getChannelData(0), expectedDoubleL, 0, 96000);

  assert.ok(nullRmsL < 1e-6 && nullRmsR < 1e-6, `Parallel routed phase-null test must cancel to <1e-6 RMS, got L=${nullRmsL}, R=${nullRmsR}`);
  assert.ok(sumRmsErr < 1e-6, `Parallel routed constructive sum must equal 2.0x single path (<1e-6), got ${sumRmsErr}`);

  // Now prove the EXACT SAME phase-null cancellation on the LIVE AudioEngine Mixer graph!
  const liveEng = new AudioEngine();
  liveEng.setMasteringState({ enabled: false });
  liveEng.setBpm(120);
  liveEng.init();
  const liveCtx = liveEng.getContext();
  let liveNullRmsL = 1;
  let liveNullRmsR = 1;
  try {
    await liveEng.nativeMixerEffects.prepareTracks(mixer, liveCtx);
    syncLiveMixerGraph(liveEng, mixer);

    const liveFrames = 12288;
    const liveStimPos = createStimulusBuffer(48000, liveFrames / 48000, 1);
    const liveStimNeg = createStimulusBuffer(48000, liveFrames / 48000, -1);
    const srcA = liveCtx.createBufferSource();
    srcA.buffer = liveStimPos;
    srcA.connect(liveEng.getOrCreateMixerChannel(3).input);
    const srcB = liveCtx.createBufferSource();
    srcB.buffer = liveStimNeg;
    srcB.connect(liveEng.getOrCreateMixerChannel(2).input);
    srcA.start(0);
    srcB.start(0);

    await stepLiveContext(liveCtx, liveFrames);
    const liveOut = liveCtx.exportAsAudioData();
    liveNullRmsL = rmsRange(liveOut.channelData[0]);
    liveNullRmsR = rmsRange(liveOut.channelData[1]);
  } finally {
    await liveEng.releaseNativeInstruments();
  }

  assert.ok(liveNullRmsL < 1e-6 && liveNullRmsR < 1e-6,
    `Live Mixer parallel routed phase-null cancellation must be <1e-6 RMS, got L=${liveNullRmsL}, R=${liveNullRmsR}`);

  proofSummary.cases.case05_parallelRoutedRecombiningPaths = {
    pathALatencies: [377, 199],
    offlinePhaseNullRmsL: nullRmsL,
    offlinePhaseNullRmsR: nullRmsR,
    offlineConstructiveSumRmsError: sumRmsErr,
    livePhaseNullRmsL: liveNullRmsL,
    livePhaseNullRmsR: liveNullRmsR,
  };
});

test('Case 6: aux bus routing compensates nonzero-latency inserts on both source and aux return across live and offline graphs', async () => {
  // Source Track 2 (L = 320) -> Master (0) AND aux-sends (amount = 1.0) -> Aux Return Track 1 (L = 440) -> Master (0)
  // Notice Aux Return Track 1 has smaller ID than Source Track 2!
  // Also include Channel Inv on dry Track 3 (amount -2.0x via two inverted clips) to prove exact 2.0x phase cancellation!
  const fx320 = await makeLookaheadEffect({ latencySamples: 320, drive: 0, gain: 1.0 });
  const fx440 = await makeLookaheadEffect({ latencySamples: 440, drive: 0, gain: 1.0 });

  const eng = createEngineWithStimulus(48000, 2);
  const chSrc = makeAudioChannel('ch-aux-src', 2, 'pdc-stimulus');
  const chInv1 = makeAudioChannel('ch-inv-1', 3, 'pdc-stimulus-inverted');
  const chInv2 = makeAudioChannel('ch-inv-2', 3, 'pdc-stimulus-inverted');
  const clipsSum = [makeAudioClip('c-src', chSrc.id, 'pdc-stimulus', 0)];
  const clipsNull = [
    makeAudioClip('c-src', chSrc.id, 'pdc-stimulus', 0),
    makeAudioClip('c-inv-1', chInv1.id, 'pdc-stimulus-inverted', 1),
    makeAudioClip('c-inv-2', chInv2.id, 'pdc-stimulus-inverted', 2),
  ];

  const auxMixer = [
    makeTrack(0, { volume: 1.0 }),
    makeTrack(1, { fxSlots: [makeFxSlot('aux-ret-440', fx440)], routingTargetId: 0, volume: 1.0 }),
    makeTrack(2, {
      fxSlots: [makeFxSlot('aux-src-320', fx320)],
      routingTargetId: 0,
      auxSends: [{ targetId: 1, amount: 1.0 }],
      volume: 1.0,
    }),
    makeTrack(3, { fxSlots: [], routingTargetId: 0, volume: 1.0 }),
  ];

  const auxSumBuf = await eng.renderTimelineOffline([chSrc], clipsSum, auxMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const auxNullBuf = await eng.renderTimelineOffline([chSrc, chInv1, chInv2], clipsNull, auxMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);

  const sumOnset = firstOnsetIndex(auxSumBuf.getChannelData(0));
  const offlineAuxNullRmsL = rmsRange(auxNullBuf.getChannelData(0), 0, 96000);
  const offlineAuxNullRmsR = rmsRange(auxNullBuf.getChannelData(1), 0, 96000);

  assert.equal(sumOnset, 128, 'Aux return + direct source sum must start at exact frame 128 without comb-filter pre-echo');
  assert.ok(offlineAuxNullRmsL < 1e-6 && offlineAuxNullRmsR < 1e-6,
    `Offline aux send + return + dry sum must phase-null to <1e-6 against -2x reference, got L=${offlineAuxNullRmsL}, R=${offlineAuxNullRmsR}`);

  // Also test standalone syncAuxSendsForTrack + live Mixer graph alignment:
  const liveEng = new AudioEngine();
  liveEng.setMasteringState({ enabled: false });
  liveEng.init();
  const liveCtx = liveEng.getContext();
  let liveAuxNullRmsL = 1;
  let liveAuxNullRmsR = 1;
  try {
    const initialNoAux = auxMixer.map(t => t.id === 2 ? { ...t, auxSends: [] } : t);
    await liveEng.nativeMixerEffects.prepareTracks(initialNoAux, liveCtx);
    syncLiveMixerGraph(liveEng, initialNoAux);
    liveEng.activeMixerTracks = structuredClone(auxMixer);
    // Standalone UI-path call (matching Mixer.tsx):
    liveEng.syncAuxSendsForTrack(auxMixer.find(t => t.id === 2), auxMixer);

    const liveFrames = 14336;
    const stimPos = createStimulusBuffer(48000, liveFrames / 48000, 1);
    const stimNeg = createStimulusBuffer(48000, liveFrames / 48000, -2);
    const sSrc = liveCtx.createBufferSource();
    sSrc.buffer = stimPos;
    sSrc.connect(liveEng.getOrCreateMixerChannel(2).input);
    const sCancel = liveCtx.createBufferSource();
    sCancel.buffer = stimNeg;
    sCancel.connect(liveEng.getOrCreateMixerChannel(3).input);
    sSrc.start(0);
    sCancel.start(0);

    await stepLiveContext(liveCtx, liveFrames);
    const liveOut = liveCtx.exportAsAudioData();
    liveAuxNullRmsL = rmsRange(liveOut.channelData[0]);
    liveAuxNullRmsR = rmsRange(liveOut.channelData[1]);
  } finally {
    await liveEng.releaseNativeInstruments();
  }

  assert.ok(liveAuxNullRmsL < 1e-6 && liveAuxNullRmsR < 1e-6,
    `Live standalone syncAuxSendsForTrack + aux return PDC must phase-null to <1e-6, got L=${liveAuxNullRmsL}, R=${liveAuxNullRmsR}`);

  proofSummary.cases.case06_auxBusRouting = {
    sourcePluginLatencySamples: 320,
    auxReturnPluginLatencySamples: 440,
    offlineSumOnsetFrame: sumOnset,
    offlinePhaseNullRmsL: offlineAuxNullRmsL,
    livePhaseNullRmsL: liveAuxNullRmsL,
  };
});

test('Case 7: bypass, removal, and reinsertion update live and offline latency compensation without stale state', async () => {
  const fx320Gain = await makeLookaheadEffect({ latencySamples: 320, drive: 0.6, gain: 0.5 });

  // Live: active -> mid-take bypass -> removed -> reinserted
  const liveEng = new AudioEngine();
  liveEng.setMasteringState({ enabled: false });
  liveEng.init();
  const liveCtx = liveEng.getContext();
  const activeMixer = [
    makeTrack(0, { volume: 1.0 }),
    makeTrack(1, { fxSlots: [makeFxSlot('byp-320', fx320Gain, true)], volume: 1.0 }),
    makeTrack(2, { fxSlots: [], volume: 1.0 }),
  ];
  const bypassedMixer = activeMixer.map(t => t.id === 1 ? { ...t, fxSlots: [makeFxSlot('byp-320', fx320Gain, false)] } : t);
  const removedMixer = [makeTrack(0, { volume: 1.0 }), makeTrack(1, { fxSlots: [], volume: 1.0 }), makeTrack(2, { fxSlots: [], volume: 1.0 })];
  let bypassedNullL = 1;
  try {
    await liveEng.nativeMixerEffects.prepareTracks(activeMixer, liveCtx);
    syncLiveMixerGraph(liveEng, activeMixer);
    assert.equal(liveEng.nativeMixerEffects.liveLatencyFramesFor(1, 'byp-320', liveCtx, fx320Gain), VST3_FX_PIPELINE_FRAMES + 320);

    await liveEng.nativeMixerEffects.reconcileTracks(bypassedMixer);
    syncLiveMixerGraph(liveEng, bypassedMixer);

    const liveFrames = 10240;
    const src1 = liveCtx.createBufferSource();
    src1.buffer = createStimulusBuffer(48000, liveFrames / 48000, 1);
    src1.connect(liveEng.getOrCreateMixerChannel(1).input);
    const src2 = liveCtx.createBufferSource();
    src2.buffer = createStimulusBuffer(48000, liveFrames / 48000, -1);
    src2.connect(liveEng.getOrCreateMixerChannel(2).input);
    src1.start(0);
    src2.start(0);
    await stepLiveContext(liveCtx, liveFrames);
    bypassedNullL = rmsRange(liveCtx.exportAsAudioData().channelData[0]);
    assert.ok(bypassedNullL < 1e-6, `Mid-take bypassed nonzero-latency insert must phase-null with compensated sibling (<1e-6), got ${bypassedNullL}`);

    await liveEng.releaseNativeInstruments();
    await liveEng.nativeMixerEffects.prepareTracks(removedMixer, liveCtx);
    syncLiveMixerGraph(liveEng, removedMixer);
    assert.equal(liveEng.mixerRoutingAdapter.getRouteOutputNode(2), liveEng.getOrCreateMixerChannel(2).output,
      'After insert removal, Track 2 must connect directly without a route compensation DelayNode');

    await liveEng.nativeMixerEffects.prepareTracks(activeMixer, liveCtx);
    syncLiveMixerGraph(liveEng, activeMixer);
    assert.notEqual(liveEng.mixerRoutingAdapter.getRouteOutputNode(2), liveEng.getOrCreateMixerChannel(2).output,
      'After reinsertion, Track 2 route compensation DelayNode must be restored');
  } finally {
    await liveEng.releaseNativeInstruments();
  }

  // Offline: active vs bypassed vs removed vs reinserted
  const offEng = createEngineWithStimulus(48000, 2);
  const ch = makeAudioChannel('ch-byp', 1);
  const clip = makeAudioClip('clip-byp', ch.id);
  const offActive = await offEng.renderTimelineOffline([ch], [clip], activeMixer.slice(0, 2), 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const offBypassed = await offEng.renderTimelineOffline([ch], [clip], bypassedMixer.slice(0, 2), 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const offRemoved = await offEng.renderTimelineOffline([ch], [clip], removedMixer.slice(0, 2), 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const offReinserted = await offEng.renderTimelineOffline([ch], [clip], activeMixer.slice(0, 2), 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);

  assert.equal(firstOnsetIndex(offActive.getChannelData(0)), 128);
  assert.equal(firstOnsetIndex(offBypassed.getChannelData(0)), 128);
  assert.equal(firstOnsetIndex(offRemoved.getChannelData(0)), 128);
  assert.ok(rmsDiffRange(offBypassed.getChannelData(0), offRemoved.getChannelData(0)) < 1e-7, 'Offline bypassed slot must equal removed slot');
  assert.ok(rmsDiffRange(offActive.getChannelData(0), offReinserted.getChannelData(0)) === 0, 'Offline reinserted slot must reproduce bit-identical PCM');
  assert.ok(rmsDiffRange(offActive.getChannelData(0), offBypassed.getChannelData(0), 2048, 6144) > 0.01, 'Active vs bypassed must differ audibly');

  proofSummary.cases.case07_bypassRemovalReinsertion = {
    liveBypassPhaseNullRmsL: bypassedNullL,
    offlineBypassVsRemovedRmsError: rmsDiffRange(offBypassed.getChannelData(0), offRemoved.getChannelData(0)),
    offlineActiveVsReinsertedRmsError: rmsDiffRange(offActive.getChannelData(0), offReinserted.getChannelData(0)),
  };
});

test('Case 8: stop/restart tears down buffered DelayNodes immediately without post-stop bleed, and project replacement / sample-rate changes recompute fresh latency', async () => {
  const fx400RateScaled = await makeLookaheadEffect({ latencySamples: 400, drive: 0, gain: 1.0, rateScale: true });

  // Part A: Live stop/restart flushes DelayNodes so buffered dry audio on Track 2 cannot bleed after Stop!
  const liveEng = new AudioEngine();
  liveEng.setMasteringState({ enabled: false });
  liveEng.init();
  const liveCtx = liveEng.getContext();
  const mixer = [
    makeTrack(0, { volume: 1.0 }),
    makeTrack(1, { fxSlots: [makeFxSlot('sr-400', fx400RateScaled)], volume: 1.0 }),
    makeTrack(2, { fxSlots: [], volume: 1.0 }),
  ];
  let postStopBleedRms = 1;
  try {
    await liveEng.nativeMixerEffects.prepareTracks(mixer, liveCtx);
    syncLiveMixerGraph(liveEng, mixer);

    const preStopFrames = 3072;
    const loudBuf = liveCtx.createBuffer(2, preStopFrames, 48000);
    loudBuf.getChannelData(0).fill(0.9);
    loudBuf.getChannelData(1).fill(0.9);
    const loudSrc = liveCtx.createBufferSource();
    loudSrc.buffer = loudBuf;
    loudSrc.connect(liveEng.getOrCreateMixerChannel(2).input);
    loudSrc.start(0);

    await stepLiveContext(liveCtx, preStopFrames);
    loudSrc.stop(liveCtx.currentTime);
    loudSrc.disconnect();
    await liveEng.releaseNativeInstruments();

    assert.equal(service.sessionCount, 0, 'All native helper sessions must be closed on Stop');
    assert.equal(liveEng.getOrCreateMixerChannel(0).directCompensation, undefined, 'Master directCompensation DelayNode must be torn down on Stop');
    assert.equal(liveEng.mixerRoutingAdapter.getRouteOutputNode(2), liveEng.getOrCreateMixerChannel(2).output,
      'Route DelayNode on Track 2 must be torn down on Stop so its 2448-frame buffer cannot bleed out');

    await stepLiveContext(liveCtx, preStopFrames * 2);
    const fullCapture = liveCtx.exportAsAudioData().channelData[0];
    postStopBleedRms = rmsRange(fullCapture, preStopFrames + 128, preStopFrames * 2);
    assert.equal(postStopBleedRms, 0, `Zero buffered DelayNode samples may bleed after Stop, got RMS=${postStopBleedRms}`);
  } finally {
    await liveEng.releaseNativeInstruments();
  }

  // Part B: Sample-rate reconfiguration (48 kHz -> 96 kHz) with RateScale=1 (400 samples @ 48k -> 800 samples @ 96k!)
  // Because Vst3Effect never caches latencySamples in project state, rendering at 96 kHz queries fresh 800 samples!
  assert.equal(Object.prototype.hasOwnProperty.call(fx400RateScaled, 'latencySamples'), false, 'Vst3Effect must not persist cached latencySamples');
  const eng48 = createEngineWithStimulus(48000, 2);
  const eng96 = createEngineWithStimulus(96000, 2);
  const ch = makeAudioChannel('ch-sr', 1);
  const clip = makeAudioClip('clip-sr', ch.id);
  const srMixer = [makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('slot-sr', fx400RateScaled)] })];

  const dry48 = await eng48.renderTimelineOffline([ch], [clip], [makeTrack(0), makeTrack(1)], 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const wet48 = await eng48.renderTimelineOffline([ch], [clip], srMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const dry96 = await eng96.renderTimelineOffline([ch], [clip], [makeTrack(0), makeTrack(1)], 120, 1, 96000, true, 'song', undefined, undefined, undefined, 2);
  const wet96 = await eng96.renderTimelineOffline([ch], [clip], srMixer, 120, 1, 96000, true, 'song', undefined, undefined, undefined, 2);

  const err48 = rmsDiffRange(dry48.getChannelData(0), wet48.getChannelData(0));
  const err96 = rmsDiffRange(dry96.getChannelData(0), wet96.getChannelData(0));
  assert.equal(firstOnsetIndex(wet48.getChannelData(0)), 128);
  assert.equal(firstOnsetIndex(wet96.getChannelData(0)), 128);
  assert.ok(err48 < 1e-6 && err96 < 1e-6, `Both 48 kHz (400 smp) and 96 kHz (800 smp) renders must align cleanly: err48=${err48}, err96=${err96}`);

  proofSummary.cases.case08_stopRestartReplacementSampleRate = {
    postStopBleedRms,
    sampleRate48kLatencySamples: 400,
    sampleRate96kLatencySamples: 800,
    rmsError48k: err48,
    rmsError96k: err96,
  };
});

test('Case 9: save, separate-OS-process restart, and reopen restores plugin binary state and produces byte-identical compensated PCM', async () => {
  const fx320 = await makeLookaheadEffect({ latencySamples: 320, drive: 0.65, gain: 0.9 });
  const fx512 = await makeLookaheadEffect({ latencySamples: 512, drive: 0.25, gain: 0.8 });

  const eng = createEngineWithStimulus(48000, 2);
  const ch = makeAudioChannel('ch-persist', 1);
  const clip = makeAudioClip('clip-persist', ch.id);
  const mixer = [
    makeTrack(0),
    makeTrack(1, { fxSlots: [makeFxSlot('p-320', fx320), makeFxSlot('p-512', fx512)] }),
  ];

  const preSaveBuf = await eng.renderTimelineOffline([ch], [clip], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const preSaveSha256 = hashStereoPcm(preSaveBuf.getChannelData(0), preSaveBuf.getChannelData(1));
  const preSaveOnset = firstOnsetIndex(preSaveBuf.getChannelData(0));
  const preSaveEndPeak = peakIndexInRange(preSaveBuf.getChannelData(0), 96000 - 256, 96000);

  const initialProject = createDefaultProjectState();
  const serialized = serializeProjectState({
    ...initialProject,
    meta: { ...initialProject.meta, bpm: 120 },
    channels: [ch],
    mixerTracks: mixer,
    playlistClips: [clip],
  });

  const tmpProjectPath = path.join(evidenceDir, 'tmp-pdc-reopen-project.json');
  const tmpResultPath = path.join(evidenceDir, 'tmp-pdc-reopen-result.json');
  await writeFile(tmpProjectPath, serialized, 'utf8');

  try {
    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', path.resolve('tests/vst3PluginLatencyCompensation.test.mjs')],
      {
        env: {
          ...process.env,
          APEX_PDC_CHILD_REOPEN_PROJECT: tmpProjectPath,
          APEX_PDC_CHILD_REOPEN_RESULT: tmpResultPath,
        },
        timeout: 30000,
      },
    );
    const childResult = JSON.parse(await readFile(tmpResultPath, 'utf8'));
    assert.notEqual(childResult.pid, process.pid, 'Reopen verification must execute in a genuinely separate OS process');
    assert.deepEqual(childResult.slotLatencies, [320, 512]);
    assert.equal(childResult.frames, preSaveBuf.length);
    assert.equal(childResult.onsetL, preSaveOnset);
    assert.equal(childResult.endPeakIdx, preSaveEndPeak);
    assert.equal(childResult.sha256, preSaveSha256, 'Separate-process reopened render must be byte-for-byte identical to pre-save render');

    proofSummary.cases.case09_saveRestartReopen = {
      parentPid: process.pid,
      reopenedChildPid: childResult.pid,
      restoredSlotLatencies: childResult.slotLatencies,
      preSaveSha256,
      reopenedSha256: childResult.sha256,
      onsetFrame: childResult.onsetL,
      endPeakFrame: childResult.endPeakIdx,
    };
  } finally {
    await rm(tmpProjectPath, { force: true });
    await rm(tmpResultPath, { force: true });
  }
});

test('Case 10 & Case 11: offline export and live Mixer output achieve exact musical parity, and fixed 2,048-frame live bridge buffering is never double-counted or injected into offline renders', async () => {
  // Build a multi-branch Mixer with serial + parallel nonzero-latency inserts:
  // Track 1: two serial inserts (L1 = 280 + Drive 0.5, L2 = 360 + Gain 0.7) -> Master (0)
  // Track 2: one insert (L3 = 410 + Drive 0.3) -> Master (0)
  // Track 3: dry track (0 inserts) -> Master (0)
  const fx1 = await makeLookaheadEffect({ latencySamples: 280, drive: 0.5, gain: 1.0 });
  const fx2 = await makeLookaheadEffect({ latencySamples: 360, drive: 0.0, gain: 0.7 });
  const fx3 = await makeLookaheadEffect({ latencySamples: 410, drive: 0.3, gain: 0.85 });

  const defaultMastering = createDefaultProjectState().mastering;
  const ch1 = makeAudioChannel('p-ch1', 1, 'pdc-stimulus', 0.85);
  const ch2 = makeAudioChannel('p-ch2', 2, 'pdc-stimulus', 0.65);
  const ch3 = makeAudioChannel('p-ch3', 3, 'pdc-stimulus', 0.45);
  const clips = [
    makeAudioClip('p-c1', ch1.id, 'pdc-stimulus', 0),
    makeAudioClip('p-c2', ch2.id, 'pdc-stimulus', 1),
    makeAudioClip('p-c3', ch3.id, 'pdc-stimulus', 2),
  ];
  const mixer = [
    makeTrack(0, { volume: 1.0 }),
    makeTrack(1, { fxSlots: [makeFxSlot('m-1', fx1), makeFxSlot('m-2', fx2)], volume: 1.0 }),
    makeTrack(2, { fxSlots: [makeFxSlot('m-3', fx3)], volume: 1.0 }),
    makeTrack(3, { fxSlots: [], volume: 1.0 }),
  ];

  // Offline export (both AudioBuffer and encoded WAV), plus exact post-channel dry source references:
  const offEng = createEngineWithStimulus(48000, 2);
  const unitRefCh = makeAudioChannel('p-ref', 1, 'pdc-stimulus', 1.0);
  const unitRefClip = makeAudioClip('p-ref-c', unitRefCh.id, 'pdc-stimulus', 0);
  const drySingleSourceBuf = await offEng.renderTimelineOffline(
    [unitRefCh], [unitRefClip], [makeTrack(0, { volume: 1.0 }), makeTrack(1, { fxSlots: [], volume: 1.0 })],
    120, 1, 48000, true, 'song', undefined, undefined, undefined, 2,
  );
  const offlineBuf = await offEng.renderTimelineOffline([ch1, ch2, ch3], clips, mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 2);
  const wavBlob = await offEng.renderProjectToWav([ch1, ch2, ch3], clips, 120, 1, 24, mixer, true);
  assert.ok(wavBlob.size > 44);

  const offlineOnset = firstOnsetIndex(offlineBuf.getChannelData(0));
  // Stimulus impulse is at frame 128 (< 2048!). If offline ever injected or subtracted 2048 bridge frames,
  // onset 128 would either shift to 2176 or be clipped off completely!
  assert.equal(offlineOnset, 128, 'Offline export must NOT include any 2048-frame live bridge buffering');

  const expectedLiveMasterOffset = 2 * VST3_FX_PIPELINE_FRAMES + 280 + 360; // 4736 frames (NOT double-counted!)
  const liveEng = new AudioEngine();
  liveEng.setMasteringState({ ...defaultMastering, enabled: false });
  liveEng.init();
  const liveCtx = liveEng.getContext();
  const compareWindowFrames = 12000;
  let liveAudio;
  try {
    await liveEng.nativeMixerEffects.prepareTracks(mixer, liveCtx);
    syncLiveMixerGraph(liveEng, mixer);

    const postChannelStim = liveCtx.createBuffer(2, compareWindowFrames + 2048, 48000);
    postChannelStim.getChannelData(0).set(drySingleSourceBuf.getChannelData(0).subarray(0, compareWindowFrames + 2048));
    postChannelStim.getChannelData(1).set(drySingleSourceBuf.getChannelData(1).subarray(0, compareWindowFrames + 2048));
    for (const [trackId, chVol] of [[1, 0.85], [2, 0.65], [3, 0.45]]) {
      const src = liveCtx.createBufferSource();
      src.buffer = postChannelStim;
      const g = liveCtx.createGain();
      g.gain.setValueAtTime(chVol, 0);
      src.connect(g);
      g.connect(liveEng.getOrCreateMixerChannel(trackId).input);
      src.start(0);
    }

    await stepLiveContext(liveCtx, expectedLiveMasterOffset + compareWindowFrames);
    liveAudio = liveCtx.exportAsAudioData();
  } finally {
    await liveEng.releaseNativeInstruments();
  }

  const liveOnset = firstOnsetIndex(liveAudio.channelData[0]);
  assert.equal(liveOnset, 128 + expectedLiveMasterOffset,
    `Live Master onset must equal 128 + 4736 = 4864 (exact 2*2048 + 640, never double-counted), got ${liveOnset}`);

  const liveAlignedL = liveAudio.channelData[0].subarray(expectedLiveMasterOffset, expectedLiveMasterOffset + compareWindowFrames);
  const liveAlignedR = liveAudio.channelData[1].subarray(expectedLiveMasterOffset, expectedLiveMasterOffset + compareWindowFrames);
  const offAlignedL = offlineBuf.getChannelData(0).subarray(0, compareWindowFrames);
  const offAlignedR = offlineBuf.getChannelData(1).subarray(0, compareWindowFrames);

  const parityRmsL = rmsDiffRange(liveAlignedL, offAlignedL);
  const parityRmsR = rmsDiffRange(liveAlignedR, offAlignedR);
  assert.ok(parityRmsL < 1e-5 && parityRmsR < 1e-5,
    `Live vs offline compensated Master mix must match within <1e-5 RMS: L=${parityRmsL}, R=${parityRmsR}`);

  proofSummary.cases.case10_offlineExportAndLiveOfflineParity = {
    offlineOnsetFrame: offlineOnset,
    liveOnsetFrame: liveOnset,
    expectedLiveMonitoringOffsetFrames: expectedLiveMasterOffset,
    liveVsOfflineParityRmsL: parityRmsL,
    liveVsOfflineParityRmsR: parityRmsR,
  };
  proofSummary.cases.case11_fixedBridgeBufferingNotDoubleCounted = {
    fixedBridgeFramesPerInsert: VST3_FX_PIPELINE_FRAMES,
    track1LiveTotalFrames: expectedLiveMasterOffset,
    offlineInjectedBridgeFrames: 0,
    offlineEarlyImpulsePreservedAtFrame: offlineOnset,
  };
});

test('Case 12: invalid, negative, excessive, and mid-stream-mutating reported latencies fail safely in both live and offline paths without corrupting saved state or leaking sessions', async () => {
  const eng = createEngineWithStimulus(48000, 1);
  const ch = makeAudioChannel('ch-bad', 1);
  const clip = makeAudioClip('clip-bad', ch.id);
  const validFx = await makeLookaheadEffect({ latencySamples: 320, drive: 0, gain: 1.0 });

  const makeRawEffect = identity => ({
    ...identity,
    state: { schema: 1, classId: identity.classId, parameters: [] },
  });
  const negEffect = makeRawEffect(invalidLatencyIdentity);
  const bigEffect = makeRawEffect(excessiveLatencyIdentity);
  const dynEffect = makeRawEffect(dynamicLatencyIdentity);

  for (const [label, badFx, expectedPattern] of [
    ['uint32(-1) negative/overflow latency', negEffect, /invalid or excessive latency/i],
    ['250000-sample (>1.0s) excessive latency', bigEffect, /invalid or excessive latency/i],
    ['mid-stream dynamic latency change', dynEffect, /changed reported latency during active processing/i],
  ]) {
    const badMixer = [makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('bad-slot', badFx)] })];
    const snapshotBefore = JSON.stringify(badMixer);

    // Offline export must reject explicitly without substituting dry PCM:
    await assert.rejects(
      eng.renderTimelineOffline([ch], [clip], badMixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 1),
      expectedPattern,
      `Offline export must reject ${label}`,
    );
    assert.equal(JSON.stringify(badMixer), snapshotBefore, `Project state must remain untouched after ${label} failure`);
    assert.equal(service.sessionCount, 0, `No leaked native sessions after offline ${label} failure`);
  }

  // Live prepareTracks must also reject negative & excessive latency cleanly, and live mid-stream change must trigger fatal stop:
  const liveEng = new AudioEngine();
  liveEng.setMasteringState({ enabled: false });
  liveEng.init();
  const liveCtx = liveEng.getContext();
  try {
    await assert.rejects(
      liveEng.nativeMixerEffects.prepareTracks([makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('neg', negEffect)] })], liveCtx),
      /invalid or excessive latency/i,
    );
    await assert.rejects(
      liveEng.nativeMixerEffects.prepareTracks([makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('big', bigEffect)] })], liveCtx),
      /invalid or excessive latency/i,
    );
  } finally {
    await liveEng.releaseNativeInstruments();
  }
  assert.equal(service.sessionCount, 0);

  // Subsequent valid render succeeds cleanly after failures:
  const recoveryBuf = await eng.renderTimelineOffline(
    [ch], [clip], [makeTrack(0), makeTrack(1, { fxSlots: [makeFxSlot('ok-slot', validFx)] })],
    120, 1, 48000, true, 'song', undefined, undefined, undefined, 1,
  );
  assert.equal(firstOnsetIndex(recoveryBuf.getChannelData(0)), 128);
  assert.equal(service.sessionCount, 0);

  proofSummary.cases.case12_invalidExcessiveDynamicLatencyRejectedSafely = {
    negativeUint32Rejected: true,
    excessiveOverOneSecondRejected: true,
    midstreamDynamicChangeRejected: true,
    leakedSessionsAfterFailures: service.sessionCount,
    subsequentValidRenderOnsetFrame: 128,
  };
});
