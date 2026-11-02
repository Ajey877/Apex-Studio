// Genuine native C++ VST3 + WebAudio DSP integration suite verifying that
// native VST3 instruments and native VST3 Mixer insert effects survive live
// `AudioEngine.reconfigureAudioContext()` sample-rate and latencyHint changes
// (48,000 Hz -> 96,000 Hz -> 44,100 Hz) with:
//   - strict blocking while VST3 playback or preparation is active,
//   - zero leaked native helper sessions or live MessagePorts across switches,
//   - preserved binary processor/controller state & parameter overrides,
//   - fresh sample-rate-scaled `IAudioProcessor::getLatencySamples()` queries
//     and exact `frames / ctx.sampleRate` Mixer delay compensation,
//   - working live playback and offline render parity after reconfiguration.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { resolveObjectURL } from 'node:buffer';
import * as WebAudio from 'web-audio-engine';
import { Vst3Service } from '../native/vst3/service.mjs';
import { createLiveAudioPortSession } from '../native/vst3/liveAudioPort.mjs';

const buildDir = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const hostBinaryName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [
  path.join(buildDir, 'bin', hostBinaryName),
  path.join(buildDir, 'bin/Release', hostBinaryName),
].find(existsSync);
assert.ok(
  executable,
  'Build native VST3 targets (npm run native:vst3:build) before running VST3 sample-rate reconfiguration tests',
);
const vst3Root = path.join(buildDir, 'VST3/Release');

const service = new Vst3Service(executable, [vst3Root]);
const livePortSessions = new Map();
let inFlightHelperOps = 0;
let inFlightLiveBlocks = 0;

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
      try {
        workerPort.close();
      } catch {}
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

const bridge = {
  paths: async () => [vst3Root],
  choosePath: async () => null,
  discover: () => service.discover('sr-reconfig', 'instrument'),
  discoverEffects: () => service.discover('sr-reconfig', 'effect'),
  inspect: (plugin, state) => service.inspect(plugin, state, 'sr-reconfig'),
  inspectEffect: (plugin, state) => service.inspectEffect(plugin, state, 'sr-reconfig'),
  describe: inst => service.describe(inst, 'sr-reconfig'),
  describeEffect: fx => service.describeEffect(fx, 'sr-reconfig'),
  parameters: (id, changes) => service.parameters(id, changes, 'sr-reconfig'),
  open: (inst, sr, mode, kind) => service.open(inst, sr, mode, 'sr-reconfig', kind),
  process: async (id, frames, events, bpm, params) => {
    inFlightHelperOps++;
    try {
      return await service.process(id, frames, events, bpm, 'sr-reconfig', params);
    } finally {
      inFlightHelperOps--;
    }
  },
  processAudio: async (id, frames, audio, bpm, params) => {
    inFlightHelperOps++;
    try {
      return await service.processAudio(id, frames, audio, bpm, 'sr-reconfig', params);
    } finally {
      inFlightHelperOps--;
    }
  },
  bindLiveAudioPort: async (sessionId, trackId, slotId) => {
    service.assertSession(sessionId, 'sr-reconfig');
    const channel = new MessageChannel();
    let sessionBlocks = 0;
    const liveSession = createLiveAudioPortSession({
      sessionId,
      owner: 'sr-reconfig',
      trackId,
      slotId,
      processAudio: async ({ samples }) => {
        inFlightHelperOps++;
        try {
          return await service.processAudio(sessionId, VST3_FX_BLOCK_FRAMES, samples, 120, 'sr-reconfig', []);
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
    return wrapWorkletTransferPort(
      channel.port2,
      delta => {
        sessionBlocks = Math.max(0, sessionBlocks + delta);
        inFlightLiveBlocks = Math.max(0, inFlightLiveBlocks + delta);
      },
      releasePending,
    );
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
      try {
        existing.channel.port1.close();
      } catch {}
      try {
        existing.channel.port2.close();
      } catch {}
    }
    return service.close(id, 'sr-reconfig');
  },
};

globalThis.desktopApp = { isDesktop: true, vst3: bridge };
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.document ??= { createElement: () => ({}) };

const { VST3_FX_WORKLET_SOURCE, VST3_FX_PIPELINE_FRAMES, VST3_FX_BLOCK_FRAMES } = await import(
  '../src/audio/nativeVst3EffectRuntime.ts'
);

const createdContextRates = [];

class ConfigurableRenderingAudioContext extends WebAudio.RenderingAudioContext {
  constructor(opts = {}) {
    const rate = opts?.sampleRate ?? 48000;
    super({ ...opts, sampleRate: rate });
    this.constructedOptions = { ...opts };
    createdContextRates.push({ sampleRate: this.sampleRate, latencyHint: opts?.latencyHint });
    this.audioWorklet = {
      addModule: async url => {
        const blob = resolveObjectURL(String(url));
        const text = blob ? await blob.text() : decodeURIComponent(String(url));
        if (!text.includes('apex-vst3-mixer-effect')) {
          throw new Error(`Unexpected worklet module in test: ${String(url).slice(0, 64)}`);
        }
      },
    };
  }
}

let activeWorkletQuantumFrame = 0;
Object.defineProperty(globalThis, 'currentFrame', {
  configurable: true,
  get() {
    return activeWorkletQuantumFrame;
  },
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
      get onmessage() {
        return processorSideHandler;
      },
      set onmessage(fn) {
        processorSideHandler = fn;
      },
      postMessage(message) {
        if (closed) return;
        queueMicrotask(() => {
          if (!closed) nodeSideHandler?.({ data: message });
        });
      },
    };
    const nodePort = {
      get onmessage() {
        return nodeSideHandler;
      },
      set onmessage(fn) {
        nodeSideHandler = fn;
      },
      postMessage(message, transfer) {
        if (closed) return;
        const ports = Array.isArray(transfer) ? transfer : undefined;
        if (
          message?.type === 'plugin-latency' ||
          message?.type === 'bypass' ||
          message?.type === 'live-port' ||
          message?.type === 'failure'
        ) {
          processorSideHandler?.({ data: message, ports });
        } else {
          queueMicrotask(() => {
            if (!closed) processorSideHandler?.({ data: message, ports });
          });
        }
      },
      close() {
        closed = true;
      },
    };

    let ProcessorCtor;
    new Function('AudioWorkletProcessor', 'registerProcessor', VST3_FX_WORKLET_SOURCE)(
      class {
        constructor() {
          this.port = processorPort;
        }
      },
      (_name, ctor) => {
        ProcessorCtor = ctor;
      },
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
      const inputs =
        inBus.getNumberOfChannels() > 0
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

globalThis.AudioContext = ConfigurableRenderingAudioContext;
globalThis.OfflineAudioContext = WebAudio.OfflineAudioContext;
globalThis.AudioWorkletNode = DeterministicAudioWorkletNode;

const { audioEngine } = await import('../src/audio/audioEngine.ts');
const { audioDeviceManager } = await import('../src/audio/audioDeviceManager.ts');
const { createDefaultProjectState } = await import('../src/state/projectState.ts');
const AudioEngine = audioEngine.constructor;

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

function rmsRange(samples, start = 0, end = samples.length) {
  let sum = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

function createBroadbandStimulus(sampleRate, durationSeconds, polarity = 1) {
  const frames = Math.round(sampleRate * durationSeconds);
  const ctx = new WebAudio.OfflineAudioContext(2, 1, sampleRate);
  const buf = ctx.createBuffer(2, frames, sampleRate);
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  for (let i = 512; i < Math.min(frames - 512, 8192); i++) {
    const t = (i - 512) / 4096;
    const env = Math.sin(Math.PI * Math.min(1, t));
    l[i] = polarity * env * (0.4 * Math.sin(2 * Math.PI * 9 * t) + 0.25 * Math.cos(2 * Math.PI * 21 * t));
    r[i] = polarity * env * (0.35 * Math.sin(2 * Math.PI * 13 * t) - 0.2 * Math.cos(2 * Math.PI * 17 * t));
  }
  return buf;
}

test.after(async () => {
  audioEngine.stop();
  audioDeviceManager.resetToDefaults();
  await service.dispose();
});

test('native VST3 instruments and sample-rate-scaling VST3 Mixer effects survive live AudioContext reconfigurations (48 kHz -> 96 kHz -> 44.1 kHz) without session leaks or PDC drift', async () => {
  const { plugins: instruments } = await bridge.discover();
  const { plugins: effects } = await bridge.discoverEffects();

  const jx10Identity = instruments.find(p => p.name === 'mda JX10') ?? instruments[0];
  const lookaheadIdentity = effects.find(p => p.name === 'Apex Latency Fixture');
  assert.ok(jx10Identity, 'Expected at least one compiled C++ VST3 instrument');
  assert.ok(lookaheadIdentity, 'Expected compiled Apex Latency Fixture VST3 effect');

  // Inspect VST3 instrument with custom parameter override and capture processor/controller state.
  const baseInst = await bridge.inspect(jx10Identity);
  const editedInstParams = [
    { id: 14, value: 0 },
    { id: 18, value: 0 },
  ];
  const inspectedInst = await bridge.inspect(jx10Identity, {
    ...baseInst.state,
    parameters: editedInstParams,
  });
  const vst3Instrument = {
    ...inspectedInst,
    state: { ...inspectedInst.state, parameters: editedInstParams },
  };

  // Inspect VST3 Mixer effect with rateScale=1 so getLatencySamples() scales with sampleRate:
  // 320 samples @ 48 kHz -> 640 samples @ 96 kHz -> 294 samples @ 44.1 kHz!
  const baseFx = await bridge.inspectEffect(lookaheadIdentity);
  const fxParams = [
    { id: 0, value: 320 / 4096 }, // base latency 320 frames @ 48 kHz
    { id: 1, value: 0 },          // linear pass-through (drive = 0)
    { id: 2, value: 1.0 / 2.0 },  // unity gain = 1.0
    { id: 3, value: 1 },          // rateScale = 1 (scales latency with sampleRate!)
  ];
  const inspectedFx = await bridge.inspectEffect(lookaheadIdentity, {
    ...baseFx.state,
    parameters: fxParams,
  });
  const vst3Effect = {
    ...inspectedFx,
    state: { ...inspectedFx.state, parameters: fxParams },
  };

  const eng = new AudioEngine();
  eng.setMasteringState({ ...createDefaultProjectState().mastering, enabled: false });
  eng.setBpm(120);

  // Build a project with Channel 1 = native VST3 instrument -> Track 3 -> Master!
  const defaultProject = createDefaultProjectState();
  const vst3Channel = {
    ...defaultProject.channels[0],
    id: 'ch-vst3-epiano',
    name: 'VST3 EPiano',
    instrumentType: 'vst3',
    vst3: vst3Instrument,
    mixerTrackId: 3,
    volume: 0.9,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: Array(16).fill(false),
    notes: [{ id: 'ep-1', pitch: 60, start: 0, duration: 8, velocity: 0.9 }],
  };

  const mixerTracksWithVst3 = [
    { id: 0, name: 'Master', color: '#fff', volume: 1.0, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 },
    {
      id: 1,
      name: 'Wet Bus',
      color: '#fff',
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      routingTargetId: 0,
      fxSlots: [{ id: 'slot-rate-scaled-fx', type: 'vst3', name: vst3Effect.name, enabled: true, mix: 1, params: {}, vst3Effect }],
      peakL: 0,
      peakR: 0,
    },
    { id: 2, name: 'Dry Inverted Bus', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, routingTargetId: 0, fxSlots: [], peakL: 0, peakR: 0 },
    { id: 3, name: 'Synth Bus', color: '#fff', volume: 0.9, pan: 0, mute: false, solo: false, routingTargetId: 0, fxSlots: [], peakL: 0, peakR: 0 },
  ];

  const synthClip = {
    id: 'clip-vst3-synth',
    type: 'pattern',
    channelId: vst3Channel.id,
    patternId: defaultProject.selectedPatternId,
    name: 'VST3 Pattern',
    trackIndex: 0,
    startBar: 0,
    lengthBars: 1,
  };

  try {
    // --- STAGE 1: Configure at 48,000 Hz (interactive) and verify VST3 playback + active guard ---
    const res48 = await eng.reconfigureAudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    assert.equal(res48.actualSampleRate, 48000);
    assert.equal(eng.getSampleRate(), 48000);

    await eng.play([vst3Channel], [synthClip], 'song', defaultProject.selectedPatternId, mixerTracksWithVst3);
    assert.equal(eng.isPlaybackActive(), true);
    assert.ok(service.sessionCount >= 2, 'Both VST3 instrument and VST3 Mixer effect sessions must be open during 48 kHz playback');

    // Reconfiguration MUST be refused while VST3 playback is running!
    await assert.rejects(
      () => eng.reconfigureAudioContext({ sampleRate: 96000 }),
      /Stop transport playback/i,
    );
    assert.equal(eng.getSampleRate(), 48000);

    await stepLiveContext(eng.getContext(), 12000);
    await eng.flushNativeLiveForTest();
    const rendered48 = eng.getContext().exportAsAudioData();
    const synthRms48 = rmsRange(rendered48.channelData[0]);
    assert.ok(synthRms48 > 1e-4, `Expected audible VST3 synth output at 48 kHz, got RMS=${synthRms48}`);

    // Verify 48 kHz PDC route delay on Track 2 -> Master (2048 bridge + 320 plugin = 2368 frames)
    assert.equal(
      eng.mixerRoutingAdapter.routeDelayFrames.get(2),
      VST3_FX_PIPELINE_FRAMES + 320,
      '48 kHz PDC route delay must equal 2048 + 320 = 2368 frames',
    );

    eng.stop();
    await drainHelperAndPortQueues();
    assert.equal(service.sessionCount, 2, 'Warm 48 kHz VST3 instrument + effect sessions remain cached while stopped');

    // --- STAGE 2: Reconfigure live AudioContext to 96,000 Hz (balanced) ---
    const res96 = await eng.reconfigureAudioContext({ sampleRate: 96000, latencyHint: 'balanced' });
    await drainHelperAndPortQueues();
    assert.equal(res96.actualSampleRate, 96000);
    assert.equal(res96.latencyHint, 'balanced');
    assert.equal(eng.getSampleRate(), 96000);
    assert.equal(service.sessionCount, 0, 'reconfigureAudioContext closes all 48 kHz native VST3 sessions (zero leaks)');
    assert.equal(livePortSessions.size, 0, 'reconfigureAudioContext closes all 48 kHz live worklet MessagePorts');

    // Test 2A: Verify sample-rate-scaled PDC alignment at 96,000 Hz (plugin latency doubles from 320 -> 640 samples!)
    const ctx96 = eng.getContext();
    await eng.nativeMixerEffects.prepareTracks(mixerTracksWithVst3, ctx96);
    for (const t of mixerTracksWithVst3) {
      eng.updateMixerTrack(t);
      const ch = eng.getOrCreateMixerChannel(t.id);
      ch.output.gain.cancelScheduledValues(ctx96.currentTime);
      ch.output.gain.setValueAtTime(t.mute ? 0 : t.volume, ctx96.currentTime);
    }
    eng.syncMixerRouting(mixerTracksWithVst3);

    const expectedFramesAt96k = VST3_FX_PIPELINE_FRAMES + 640; // 2048 bridge + 640 plugin samples @ 96 kHz
    assert.equal(
      eng.mixerRoutingAdapter.routeDelayFrames.get(2),
      expectedFramesAt96k,
      '96 kHz PDC route delay must rescale from 2368 -> 2688 frames (2048 + 640)',
    );
    const adapterDelayNode96 = eng.mixerRoutingAdapter.routeDelayNodes.get(2);
    assert.ok(adapterDelayNode96, 'Expected DelayNode on dry parallel route 2 -> 0');
    assert.ok(
      Math.abs(adapterDelayNode96.delayTime.value - expectedFramesAt96k / 96000) < 1e-6,
      `Expected 96 kHz PDC delay ${(expectedFramesAt96k / 96000).toFixed(6)}s (${expectedFramesAt96k} frames), got ${adapterDelayNode96.delayTime.value.toFixed(6)}s`,
    );

    const liveFrames96 = 16384;
    const stimPos96 = createBroadbandStimulus(96000, liveFrames96 / 96000, 1);
    const stimNeg96 = createBroadbandStimulus(96000, liveFrames96 / 96000, -1);
    const srcWet96 = ctx96.createBufferSource();
    srcWet96.buffer = stimPos96;
    srcWet96.connect(eng.getOrCreateMixerChannel(1).input);
    const srcDry96 = ctx96.createBufferSource();
    srcDry96.buffer = stimNeg96;
    srcDry96.connect(eng.getOrCreateMixerChannel(2).input);
    srcWet96.start(0);
    srcDry96.start(0);

    await stepLiveContext(ctx96, liveFrames96);
    const nullOut96 = ctx96.exportAsAudioData();
    const nullResidual96L = rmsRange(nullOut96.channelData[0]);
    const nullResidual96R = rmsRange(nullOut96.channelData[1]);
    assert.ok(
      nullResidual96L < 1e-6 && nullResidual96R < 1e-6,
      `Parallel wet + inverted-dry buses must phase-null to <1e-6 RMS at 96 kHz with rescaled PDC (got L=${nullResidual96L}, R=${nullResidual96R})`,
    );
    assert.equal(service.sessionCount, 1, 'Warm 96 kHz VST3 Mixer effect session active prior to 44.1 kHz switch');

    // --- STAGE 3: Reconfigure live AudioContext to 44,100 Hz (playback) and verify VST3 instrument + offline export ---
    const res44 = await eng.reconfigureAudioContext({ sampleRate: 44100, latencyHint: 'playback' });
    await drainHelperAndPortQueues();
    assert.equal(res44.actualSampleRate, 44100);
    assert.equal(res44.latencyHint, 'playback');
    assert.equal(eng.getSampleRate(), 44100);
    assert.equal(service.sessionCount, 0, 'reconfigureAudioContext closes all 96 kHz native VST3 sessions (zero leaks)');
    assert.equal(livePortSessions.size, 0, 'reconfigureAudioContext closes all 96 kHz live worklet MessagePorts');

    await eng.play([vst3Channel], [synthClip], 'song', defaultProject.selectedPatternId, mixerTracksWithVst3);
    // At 44,100 Hz, Apex Latency Fixture rateScale=1 reports round(320 * 44100 / 48000) = 294 samples!
    assert.equal(
      eng.mixerRoutingAdapter.routeDelayFrames.get(2),
      VST3_FX_PIPELINE_FRAMES + 294,
      '44.1 kHz PDC route delay must rescale to 2048 + 294 = 2342 frames',
    );
    await stepLiveContext(eng.getContext(), 12000);
    await eng.flushNativeLiveForTest();
    const rendered44 = eng.getContext().exportAsAudioData();
    const synthRms44 = rmsRange(rendered44.channelData[0]);
    assert.ok(synthRms44 > 1e-4, `Expected audible VST3 synth output at 44.1 kHz after two switches, got RMS=${synthRms44}`);

    eng.stop();
    await eng.releaseNativeInstruments();
    await drainHelperAndPortQueues();
    assert.equal(service.sessionCount, 0, 'Zero native VST3 helper sessions left open after releaseNativeInstruments');
    assert.equal(livePortSessions.size, 0, 'Zero live MessagePorts left open after releaseNativeInstruments');

    // Verify offline export still works cleanly with both VST3 instrument and VST3 Mixer effect!
    const offlineBuffer = await eng.renderTimelineOffline(
      [vst3Channel],
      [synthClip],
      mixerTracksWithVst3,
      120,
      1,
      48000,
      true,
      'song',
    );
    assert.equal(offlineBuffer.sampleRate, 48000);
    const offlineRms = rmsRange(offlineBuffer.getChannelData(0));
    assert.ok(offlineRms > 1e-4, `Offline export with VST3 instrument + effect must produce audio after live reconfigurations (RMS=${offlineRms})`);
    assert.equal(service.sessionCount, 0, 'Zero native VST3 sessions remain after offline export');
  } finally {
    eng.stop();
    await eng.releaseNativeInstruments();
    await drainHelperAndPortQueues();
  }
});
