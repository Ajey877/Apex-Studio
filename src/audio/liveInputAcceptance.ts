// Diagnostic scenario, loaded only by acceptance tooling. Uses the actual engine,
// browser getUserMedia, mixer graph, recording worklet and persistence; no fake DSP.
import type { audioEngine } from './audioEngine';
import type { FxSlot, MixerTrack } from '../types/daw';
import type { Vst3Effect } from './nativeVst3Types';
import { getNativeVst3MixerEffectSmokeTiming, getVst3MixerEffectDiagnostics } from './nativeVst3EffectRuntime';
import { RecordingEngine } from './recordingEngine';
import { deletePersistedAudioClip } from './audioPersistence';
import { sessionBlobUrlRegistry } from '../state/sessionBlobUrlRegistry';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { collectMissedSequences, orderBlocksAroundMiss } from './nativeMissWindow';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const requireSignal = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

/** Start through the actual Mixer UI BEFORE calling this measured diagnostic. */
export async function runLiveInputAcceptance(engine: typeof audioEngine) {
  requireSignal(engine.liveInputMonitor.getSnapshot().status === 'active', 'Enable monitoring through the Mixer first.');
  requireSignal(engine.liveInputMonitor.getSnapshot().trackId === 1, 'Expected insert 1.');
  const context = engine.getContext();
  const tracks: MixerTrack[] = [0, 1, 2, 3, 4].map(id => ({ id, name: `Input acceptance ${id}`, volume: 1, pan: 0,
    mute: false, solo: false, color: '#ffffff', peakL: 0, peakR: 0, fxSlots: [], isAux: id === 4 }));
  const update = (id: number, patch: Partial<MixerTrack>) => { Object.assign(tracks[id], patch); engine.updateMixerTrack(tracks[id]); };
  engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  engine.setMasterVolume(1); engine.setGrossBeatState({ enabled: false });
  tracks.forEach(track => engine.updateMixerTrack(track));
  const taps: AudioNode[] = [];
  const splitter = context.createChannelSplitter(2);
  engine.getOrCreateMixerChannel(1).output.connect(splitter); taps.push(splitter);
  const left = context.createAnalyser(), right = context.createAnalyser(), input = context.createAnalyser();
  left.fftSize = right.fftSize = input.fftSize = 2048;
  taps.push(input);
  splitter.connect(left, 0); splitter.connect(right, 1); taps.push(left, right);
  const rms = (analyser: AnalyserNode) => {
    const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  };
  const measure = async () => {
    // Routing rebuilds deliberately retain only production-owned leaves. Reattach
    // this diagnostic-only stereo tap, without ever creating an audible edge.
    try { engine.getOrCreateMixerChannel(1).output.disconnect(splitter); } catch { /* no old edge */ }
    engine.getOrCreateMixerChannel(1).output.connect(splitter);
    try { engine.getOrCreateMixerChannel(1).input.disconnect(input); } catch { /* no old tap */ }
    engine.getOrCreateMixerChannel(1).input.connect(input);
    await wait(220); let l = 0, r = 0, master = 0, inputRms = 0;
    for (let i = 0; i < 6; i++) {
      l += rms(left); r += rms(right); inputRms += rms(input);
      const bytes = new Uint8Array(512); engine.getMasterWaveformData(bytes);
      master += Math.sqrt(bytes.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / bytes.length);
      await wait(20);
    }
    return { left: l / 6, right: r / 6, input: inputRms / 6, master: master / 6, meter: engine.getMixerTrackPeak(1),
      bus: engine.getMixerTrackPeak(3), aux: engine.getMixerTrackPeak(4), sibling: engine.getMixerTrackPeak(2) };
  };
  const evidence: Record<string, unknown> = { kind: 'browser-fake-device-not-physical-hardware', sampleRate: context.sampleRate,
    latency: engine.liveInputMonitor.getSnapshot() };
  const recorder = new RecordingEngine(() => context);
  let recordingResult: Awaited<ReturnType<RecordingEngine['stop']>> | null = null;
  try {
    const baseline = await measure(); evidence.baseline = baseline;
    requireSignal(baseline.left > 0.02 && baseline.master > 0.02 && baseline.meter > 0.02, `Missing real input: ${JSON.stringify(baseline)}`);
    requireSignal(Math.abs(baseline.input - 0.15 / Math.sqrt(2)) < 0.015, 'Input does not match the known 440 Hz fixture amplitude.');
    requireSignal(baseline.sibling < 0.001, 'Input leaked into unrelated insert.');
    let duplicateRejected = false;
    try { await engine.startLiveInputMonitoring(1); } catch { duplicateRejected = true; }
    requireSignal(duplicateRejected, 'Duplicate monitor was accepted.');
    const duplicate = await measure(); evidence.duplicate = duplicate;
    requireSignal(Math.abs(duplicate.left / baseline.left - 1) < 0.06, 'Duplicate input path changed amplitude.');
    update(1, { volume: 0.5 }); const half = await measure(); evidence.halfFader = half;
    // Compare transfer gain against contemporaneous producer PCM, not a prior
    // wall-clock window: a busy fake-device driver can change source amplitude.
    requireSignal(half.input > 0.02 && Math.abs((half.left / half.input) / (baseline.left / baseline.input) - 0.5) < 0.05, `Fader did not scale monitored PCM: ${JSON.stringify({ baseline, half })}`);
    update(1, { volume: 1, pan: -1 }); const pan = await measure(); evidence.panLeft = pan;
    requireSignal(pan.right < baseline.right * 0.01 && pan.left > baseline.left, 'Pan did not affect stereo PCM.');
    update(1, { pan: 0, mute: true }); const muted = await measure(); evidence.muted = muted;
    requireSignal(muted.left < 0.001 && muted.master < 0.01, 'Mute did not silence input.');
    update(1, { mute: false }); update(2, { solo: true }); const otherSolo = await measure(); evidence.otherSolo = otherSolo;
    requireSignal(otherSolo.left < 0.001 && otherSolo.master < 0.01, 'Another insert solo did not suppress input.');
    update(2, { solo: false }); update(1, { solo: true }); const ownSolo = await measure(); evidence.ownSolo = ownSolo;
    requireSignal(ownSolo.left > baseline.left * 0.95, 'Own solo suppressed input.');
    update(1, { solo: false, fxSlots: [{ id: 'input-eq', type: 'equalizer', name: 'Input EQ', enabled: true, mix: 1,
      params: { lowGain: -24, midGain: -24, highGain: -24, midFreq: 440, midQ: 0.7 } }] });
    const fx = await measure(); evidence.insertFx = fx;
    requireSignal(fx.left < baseline.left * 0.4, 'Insert effect did not process input.');
    update(1, { fxSlots: [], routingTargetId: 3 }); update(3, { volume: 0.5 });
    const bus = await measure(); evidence.bus = bus;
    requireSignal(bus.bus > 0.02 && bus.master < baseline.master * 0.65, `Bus route/fader not processing input: ${JSON.stringify({ baseline, bus })}`);
    update(3, { fxSlots: [{ id: 'bus-eq', type: 'equalizer', name: 'Bus EQ', enabled: true, mix: 1,
      params: { lowGain: -24, midGain: -24, highGain: -24, midFreq: 440 } }] });
    const busFx = await measure(); evidence.busFx = busFx;
    requireSignal(busFx.master < bus.master * 0.5, 'Bus effect did not process input.');
    update(3, { volume: 0, fxSlots: [] }); update(1, { auxSends: [{ targetId: 4, amount: 0.5 }] });
    const aux = await measure(); evidence.aux = aux;
    requireSignal(aux.aux > 0.02 && aux.master > 0.02, 'Aux return not receiving input.');
    update(4, { mute: true }); const auxMuted = await measure(); evidence.auxMuted = auxMuted;
    requireSignal(auxMuted.master < 0.01, 'Muted return still audible with bus at zero.');
    update(4, { mute: false }); engine.setMasterVolume(0.25);
    const master = await measure(); evidence.masterGain = master;
    requireSignal(master.master < aux.master * 0.4, 'Master output gain did not affect input.');
    engine.setMasterVolume(1); update(1, { routingTargetId: 0, auxSends: [] });
    update(0, { fxSlots: [{ id: 'master-eq', type: 'equalizer', name: 'Master EQ', enabled: true, mix: 1,
      params: { lowGain: -24, midGain: -24, highGain: -24, midFreq: 440 } }] });
    const masterFx = await measure(); evidence.masterFx = masterFx;
    requireSignal(masterFx.master < baseline.master * 0.4, 'Master FX did not process input.');
    update(0, { fxSlots: [] });
    await recorder.prepare(); await recorder.start(); await wait(250);
    recorder.pause(); await wait(100); recorder.resume(); await wait(250);
    const coexisting = await measure(); evidence.recordingMonitor = coexisting;
    requireSignal(coexisting.input > 0.02 && Math.abs((coexisting.left / coexisting.input) / (baseline.left / baseline.input) - 1) < 0.06, `Recording duplicated or interrupted monitoring: ${JSON.stringify({ baseline, coexisting, monitor: engine.liveInputMonitor.getSnapshot() })}`);
    // Monitor stop must release only its lease. Recording still captures through the worklet.
    engine.liveInputMonitor.stop(); const off = await measure(); evidence.off = off;
    requireSignal(off.left < 0.001 && off.master < 0.01, 'OFF did not remove monitored PCM.');
    await wait(200);
    const captureDebug = recorder as unknown as { captureBlocks: Array<{ frameStart: number; frameCount: number }>; captureStartFrame: number; pauseIntervals: unknown };
    const debug = { start: captureDebug.captureStartFrame, pauses: captureDebug.pauseIntervals,
      blocks: captureDebug.captureBlocks.map(block => [block.frameStart, block.frameCount]), time: context.currentTime };
    try { recordingResult = await recorder.stop(); } catch (error) { throw new Error(`${String(error)}; ${JSON.stringify(debug)}`); }
    const decoded = await context.decodeAudioData(await recordingResult.blob.arrayBuffer());
    const samples = decoded.getChannelData(0);
    const recordingRms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    evidence.recording = { recordingRms, frames: recordingResult.capturedFrames, sampleRate: recordingResult.sampleRate,
      start: recordingResult.captureStartFrame, end: recordingResult.captureEndFrame };
    requireSignal(recordingRms > 0.02 && recordingResult.capturedFrames > context.sampleRate * 0.4, 'No genuine recorded PCM.');
    requireSignal(recorder.getState() === 'idle', 'Recorder not released.');
    requireSignal(engine.liveInputMonitor.getSnapshot().status === 'off', 'Monitor survived stop.');
    return evidence;
  } finally {
    engine.liveInputMonitor.stop(); await recorder.dispose();
    try { engine.getOrCreateMixerChannel(1).output.disconnect(splitter); } catch { /* removed already */ }
    try { engine.getOrCreateMixerChannel(1).input.disconnect(input); } catch { /* removed already */ }
    taps.forEach(tap => tap.disconnect());
    if (recordingResult) {
      sessionBlobUrlRegistry.release(recordingResult.url);
      await deletePersistedAudioClip(`recording-${recordingResult.id}`);
    }
    engine.stop();
  }
}

const GRAPH_PRESERVATION_NATIVE_EFFECT: Vst3Effect = {
  path: 'C:/acceptance/mda-vst3.vst3', classId: 'ABCDEF0123456789ABCDEF0123456789', name: 'Acceptance native insert',
  vendor: 'acceptance', version: 'test',
  state: { schema: 1, classId: 'ABCDEF0123456789ABCDEF0123456789', parameters: [] },
};
const GRAPH_PRESERVATION_NATIVE_SLOT_ID = 'acceptance-native';
const GRAPH_PRESERVATION_EQ_SLOT: FxSlot = { id: 'preservation-eq', type: 'equalizer', name: 'Preservation EQ', enabled: true, mix: 1,
  params: { lowGain: -24, midGain: -24, highGain: -24, midFreq: 440, midQ: 0.7 } };

/**
 * Proves that enabling input monitoring does NOT tear down an already-running
 * Mixer graph. Runs against the production engine while the transport is
 * playing, and records: which tracks `updateMixerTrack` is asked to rebuild,
 * the identity of the prepared native VST3 node before and after, transport
 * continuity, and real PCM through the monitored insert's own FX chain.
 *
 * The native plugin host is whatever `desktopApp.vst3` provides. In a browser
 * that is an injected bridge standing in for the Windows helper process, so a
 * pass here is fake-device evidence and NOT physical hardware or real native
 * plugin proof - the packaged Windows acceptance run covers that.
 */
export async function runLiveInputGraphPreservationAcceptance(
  engine: typeof audioEngine,
  options: { liveNativeInsert?: boolean } = {},
) {
  // A browser renderer cannot host a LIVE native VST3 insert: the worklet posts
  // each block to the main thread and fails closed with "missed its real-time
  // processing deadline" when the reply is late, which a JS stub servicing PCM
  // on the main thread inevitably is. Measured, not assumed. Native preparation
  // preservation is therefore asserted here only when a real helper process is
  // present (packaged Windows); the deterministic unit regression in
  // nativeVst3EffectRuntime.test.ts covers the renderer-side lifecycle.
  const liveNativeInsert = options.liveNativeInsert === true;
  requireSignal(engine.liveInputMonitor.getSnapshot().status === 'off', 'Monitoring must be OFF before this scenario.');
  const context = engine.getContext();
  const nativeSlot: FxSlot = { id: GRAPH_PRESERVATION_NATIVE_SLOT_ID, type: 'vst3', name: GRAPH_PRESERVATION_NATIVE_EFFECT.name,
    enabled: true, mix: 1, params: {}, vst3Effect: GRAPH_PRESERVATION_NATIVE_EFFECT };
  const insertFx: FxSlot[] = liveNativeInsert ? [GRAPH_PRESERVATION_EQ_SLOT, nativeSlot] : [GRAPH_PRESERVATION_EQ_SLOT];
  const tracks: MixerTrack[] = [0, 1, 2, 3].map(id => ({ id, name: `Graph preservation ${id}`, volume: 1, pan: 0,
    mute: false, solo: false, color: '#ffffff', peakL: 0, peakR: 0, fxSlots: [],
    ...(id === 1 ? { fxSlots: insertFx } : {}) }));
  engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  engine.setMasterVolume(1); engine.setGrossBeatState({ enabled: false });
  // The insert's native session must be prepared BEFORE its chain is built,
  // otherwise the engine correctly withholds the track rather than bypassing an
  // unprepared insert - which is exactly the behaviour under test.
  const nativeSteps: Array<Record<string, unknown>> = [];
  const noteStep = (label: string) => nativeSteps.push({ label,
    playing: engine.getTransportMusicalPosition().playing,
    diagnostics: getVst3MixerEffectDiagnostics().map(item => ({ trackId: item.trackId, slotId: item.slotId, message: item.message })) });
  if (liveNativeInsert) {
    await engine.nativeMixerEffects.prepareTracks(tracks, context);
    noteStep('after-prepareTracks');
  }
  tracks.forEach(track => { engine.updateMixerTrack(track); noteStep(`after-updateMixerTrack-${track.id}`); });
  const nativeNodeBefore = liveNativeInsert
    ? engine.nativeMixerEffects.nodeFor(1, GRAPH_PRESERVATION_NATIVE_SLOT_ID, context, GRAPH_PRESERVATION_NATIVE_EFFECT)
    : undefined;
  if (liveNativeInsert) requireSignal(!!nativeNodeBefore, 'The native insert was not prepared before monitoring started.');

  const transportBefore = engine.getTransportMusicalPosition();
  requireSignal(transportBefore.playing,
    `Start the transport before this scenario: playback must already be running. Steps: ${JSON.stringify(nativeSteps)}`);

  const taps: AudioNode[] = [];
  const splitter = context.createChannelSplitter(2);
  const left = context.createAnalyser(), right = context.createAnalyser(), input = context.createAnalyser();
  left.fftSize = right.fftSize = input.fftSize = 2048;
  taps.push(splitter, left, right, input);
  splitter.connect(left, 0); splitter.connect(right, 1);
  const rms = (analyser: AnalyserNode) => {
    const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  };
  const measure = async () => {
    // Diagnostic-only taps; never create an audible edge.
    try { engine.getOrCreateMixerChannel(1).output.disconnect(splitter); } catch { /* no old edge */ }
    engine.getOrCreateMixerChannel(1).output.connect(splitter);
    try { engine.getOrCreateMixerChannel(1).input.disconnect(input); } catch { /* no old tap */ }
    engine.getOrCreateMixerChannel(1).input.connect(input);
    await wait(220);
    let l = 0, r = 0, inputRms = 0;
    for (let i = 0; i < 6; i++) { l += rms(left); r += rms(right); inputRms += rms(input); await wait(20); }
    return { left: l / 6, right: r / 6, input: inputRms / 6, meter: engine.getMixerTrackPeak(1),
      sibling: engine.getMixerTrackPeak(2), bus: engine.getMixerTrackPeak(3) };
  };

  // Record every track the engine is asked to rebuild while monitoring starts.
  const rebuilt: number[] = [];
  const originalUpdate = engine.updateMixerTrack.bind(engine);
  const spy = (track: MixerTrack) => { rebuilt.push(track.id); return originalUpdate(track); };
  (engine as unknown as { updateMixerTrack: typeof spy }).updateMixerTrack = spy;
  const evidence: Record<string, unknown> = { kind: 'browser-fake-device-not-physical-hardware', sampleRate: context.sampleRate,
    liveNativeInsert, transportBefore, nativeSteps };
  try {
    await engine.startLiveInputMonitoring(1);
    noteStep('after-startLiveInputMonitoring');
    await wait(120);
    noteStep('after-settle');

    // The project's own audio must already be present on this insert while the
    // transport plays; that is the signal monitoring has to coexist with.
    const preMonitoring = await measure();
    evidence.preMonitoring = preMonitoring;
    requireSignal(preMonitoring.left > 0.005,
      `No existing audio signal on insert 1 during playback: ${JSON.stringify(preMonitoring)}`);

    // 1. Playback continues and the transport did not reset.
    const transportAfter = engine.getTransportMusicalPosition();
    evidence.transportAfter = transportAfter;
    evidence.nativeSteps = nativeSteps;
    requireSignal(transportAfter.playing,
      `Enabling monitoring stopped the transport. Steps: ${JSON.stringify(nativeSteps)}`);
    requireSignal(transportAfter.positionSeconds > transportBefore.positionSeconds,
      `Transport position did not advance: ${transportBefore.positionSeconds} -> ${transportAfter.positionSeconds}`);

    // 2. No live Mixer chain was torn down and rebuilt.
    evidence.tracksRebuiltDuringMonitoringInit = [...rebuilt];
    requireSignal(rebuilt.length === 0,
      `Monitoring init rebuilt already-live Mixer chains for tracks [${rebuilt.join(', ')}].`);

    // 3. The prepared native session is the very same one, not a re-prepare.
    if (liveNativeInsert) {
      const nativeNodeAfter = engine.nativeMixerEffects.nodeFor(1, GRAPH_PRESERVATION_NATIVE_SLOT_ID, context, GRAPH_PRESERVATION_NATIVE_EFFECT);
      evidence.nativePreserved = nativeNodeAfter === nativeNodeBefore;
      requireSignal(!!nativeNodeAfter && nativeNodeAfter === nativeNodeBefore,
        'The prepared native VST3 session was destroyed and re-prepared by monitoring init.');
      requireSignal(engine.nativeMixerEffects.isPrepared(1, GRAPH_PRESERVATION_NATIVE_SLOT_ID, context, GRAPH_PRESERVATION_NATIVE_EFFECT),
        'The native insert is no longer prepared after monitoring init.');
    } else {
      evidence.nativePreserved = 'not-exercised: no native helper process in this renderer';
    }

    // 4. The monitored input really enters this insert's own processing path.
    const baseline = await measure();
    evidence.baseline = baseline;
    requireSignal(baseline.input > 0.02, `No real monitored input: ${JSON.stringify(baseline)}`);
    requireSignal(baseline.left > 0.005 && baseline.left < baseline.input * 0.5,
      `Monitored input did not pass through the insert's own FX chain: ${JSON.stringify(baseline)}`);
    // NOTE: insert-2 leakage is deliberately NOT asserted here. getMixerTrackPeak
    // on an insert carrying no audio reported 0.21 for bus 3 before monitoring
    // even started, so it is not a trustworthy probe in this scenario; the
    // stopped-transport scenario in runLiveInputAcceptance asserts leakage with a
    // silent graph. Values are recorded for transparency instead.
    evidence.siblingPeaks = { preMonitoring: preMonitoring.sibling, baseline: baseline.sibling };

    // Per-control transfer gain (fader/pan/mute/solo/routing/effects) is NOT
    // measured here, and deliberately so: the monitored producer and the project's
    // own instruments both enter this insert at mixInput, so the output tap is a
    // mixture that cannot be attributed to either source while the transport plays
    // - and the fake-device source amplitude drifts between windows. Those checks
    // are asserted with real PCM against a silent graph in runLiveInputAcceptance.
    // What this scenario does prove is that monitoring init left the chain that
    // implements them completely untouched (tracksRebuiltDuringMonitoringInit).

    // 6. Disabling monitoring removes the input WITHOUT stopping the project.
    engine.liveInputMonitor.stop();
    // Poll rather than sleep a fixed interval: this separates "the release is
    // still in flight" from "the producer was never removed". The assertion below
    // fails if the monitored input is still on the insert after the grace period.
    let off = await measure();
    for (let attempt = 0; attempt < 6 && off.input >= baseline.input * 0.05; attempt++) {
      await wait(300);
      off = await measure();
    }
    evidence.off = off;
    evidence.monitorSnapshotAfterDisable = engine.liveInputMonitor.getSnapshot();
    // The insert's output tap is the wrong probe here: the transport is still
    // playing project audio through it, and the fake-device source amplitude
    // drifts between measurement windows, so cross-window output comparison is
    // meaningless. The input tap is exact - it carries only the monitored
    // producer, so it must fall silent the moment monitoring is disabled.
    requireSignal(baseline.input > 0.02,
      `Monitoring delivered no PCM to the insert input: ${JSON.stringify(baseline)}`);
    // >95% reduction rather than an arbitrary absolute floor: the analyser still
    // reports the tail of the disconnected producer for a few tens of ms.
    requireSignal(off.input < baseline.input * 0.05,
      `Disabling monitoring did not remove the monitored producer from the insert input: ${JSON.stringify({ baseline, off })}`);
    const transportAfterStop = engine.getTransportMusicalPosition();
    evidence.transportAfterDisable = transportAfterStop;
    requireSignal(transportAfterStop.playing, 'Disabling monitoring stopped the transport.');
    if (liveNativeInsert) {
      requireSignal(engine.nativeMixerEffects.isPrepared(1, GRAPH_PRESERVATION_NATIVE_SLOT_ID, context, GRAPH_PRESERVATION_NATIVE_EFFECT),
        'Disabling monitoring destroyed the prepared native session.');
    }
    return evidence;
  } finally {
    (engine as unknown as { updateMixerTrack: typeof originalUpdate }).updateMixerTrack = originalUpdate;
    engine.liveInputMonitor.stop();
    try { engine.getOrCreateMixerChannel(1).output.disconnect(splitter); } catch { /* removed already */ }
    try { engine.getOrCreateMixerChannel(1).input.disconnect(input); } catch { /* removed already */ }
    taps.forEach(tap => { try { tap.disconnect(); } catch { /* removed already */ } });
  }
}

/** One block the native helper actually processed, as the main process recorded it. */
interface NativeProcessRecord {
  requestId?: string;
  trackId?: number;
  slotId?: string;
  sequence?: number;
  frames?: number;
  nativeInputRms?: number | null;
  nativeOutputRms?: number | null;
  nativeServiceCallMs?: number;
  error?: string | null;
  // Cold-start forensics. Epoch stamps are `performance.timeOrigin + now()` at
  // each end, which is the only clock comparable across the renderer, the main
  // process and the helper channel; the bare `*AtMainMs` values are main-process
  // monotonic and are only meaningful as differences from each other.
  submittedAtEpochMs?: number | null;
  ipcReceivedAtMainMs?: number;
  ipcReceivedAtMainEpochMs?: number | null;
  serviceStartAtMainMs?: number;
  serviceCompletedAtMainMs?: number;
  helperQueueWaitMs?: number | null;
  helperSerializeMs?: number | null;
  helperRoundTripMs?: number | null;
  helperFrameParseMs?: number | null;
  helperPipeAndScheduleMs?: number | null;
  helperDecodeMs?: number | null;
  // The helper's own split of Instance::process() at the host/plug-in boundary.
  // helperInstanceProcessMs is the total; the three sub-spans partition it.
  helperInstanceProcessMs?: number | null;
  helperHostPrepareMs?: number | null;
  helperPluginCallbackMs?: number | null;
  helperHostCollectMs?: number | null;
  helperProcessFrames?: number | null;
  helperProcessIsFlush?: boolean | null;
  helperRequestBytes?: number | null;
  eventLoopLagMaxMs?: number | null;
  eventLoopLagDuringBlockMs?: number | null;
}
interface HelperStartupTimings {
  pid?: number | null;
  firstRequestAtMainMs?: number | null;
  constructedAtMs?: number | null;
  spawnedAtMs?: number | null;
  protocolBoundAtMs?: number | null;
  firstRequestWrittenAtMs?: number | null;
  firstResponseAtMs?: number | null;
  openCompletedAtMs?: number | null;
  spawnToProtocolBoundMs?: number | null;
  protocolBoundToFirstWriteMs?: number | null;
  firstRequestRoundTripMs?: number | null;
  constructedToOpenCompletedMs?: number | null;
}
type SmokeSnapshot = {
  main?: {
    processAudio?: NativeProcessRecord[];
    nativeServiceSessionCount?: number;
    eventLoopLag?: {
      maxLagMs?: number; samples?: number; startedAtMs?: number | null;
      maxLagDuringAudioMs?: number; firstAudioAtMs?: number | null; lastAudioAtMs?: number | null;
      worstStalls?: { atMs: number; lagMs: number }[];
    };
    helperStartup?: Record<string, HelperStartupTimings>;
  };
} | null;

const readSmokeSnapshot = async (): Promise<SmokeSnapshot> => {
  const desktop = (globalThis as unknown as { desktopApp?: { smokeTest?: boolean; smokeTimings?: boolean; vst3?: { smokeTimingSnapshot?: () => Promise<SmokeSnapshot> } } }).desktopApp;
  // Either capability exposes the snapshot: a smoke session, or a timing-only
  // session that records measurements without running the built-in smoke sequence.
  const timingsOn = desktop?.smokeTest === true || desktop?.smokeTimings === true;
  if (!timingsOn || typeof desktop?.vst3?.smokeTimingSnapshot !== 'function') return null;
  return desktop.vst3.smokeTimingSnapshot();
};

type CoexistenceProbe = {
  trackId: number;
  slotId: string;
  rebuilds: number[];
  nodeIds: WeakMap<AudioNode, string>;
  nodeIdCounter: number;
  originalUpdate: (track: MixerTrack) => void;
  inputTap: AnalyserNode;
  outputTap: AnalyserNode;
  splitter: AudioNode;
  /**
   * Deterministic signal fed to the insert input so the native plugin is provably
   * processing non-silent audio. The plugin session and its processing are real;
   * only the source is synthetic, exactly as the packaged Mixer acceptance feeds a
   * deterministic buffer. It is not a physical instrument performance.
   */
  signal: { source: AudioBufferSourceNode; gain: GainNode } | null;
};
let coexistenceProbe: CoexistenceProbe | null = null;

/**
 * Arms the measurements for the native-VST3 / live-input coexistence acceptance.
 *
 * Installs a spy that records which Mixer tracks `updateMixerTrack` is asked to
 * rebuild, and attaches read-only analyser taps to the insert's own input and
 * output. Everything else is read from production diagnostics: the main-process
 * per-block `processAudio` timings (real native plugin input/output RMS and any
 * per-block error) and the renderer's native Mixer smoke events (worklet block
 * submissions and real-time deadline misses).
 */
export function armNativeVst3MonitoringCoexistenceProbe(engine: typeof audioEngine, trackId: number, slotId: string,
  options: { inputSignal?: boolean } = {}): void {
  if (coexistenceProbe) throw new Error('A native coexistence probe is already armed.');
  const context = engine.getContext();
  const channel = engine.getOrCreateMixerChannel(trackId);
  const splitter = context.createChannelSplitter(2);
  const inputTap = context.createAnalyser();
  const outputTap = context.createAnalyser();
  inputTap.fftSize = outputTap.fftSize = 2048;
  const rebuilds: number[] = [];
  const originalUpdate = engine.updateMixerTrack.bind(engine);
  const spy = (track: MixerTrack) => { rebuilds.push(track.id); return originalUpdate(track); };
  (engine as unknown as { updateMixerTrack: typeof spy }).updateMixerTrack = spy;
  coexistenceProbe = { trackId, slotId, rebuilds, nodeIds: new WeakMap(), nodeIdCounter: 0,
    originalUpdate, inputTap, outputTap, splitter, signal: null };
  channel.input.connect(inputTap);
  channel.output.connect(splitter);
  splitter.connect(outputTap, 0);
  if (options.inputSignal !== false) {
    const frames = Math.ceil(context.sampleRate);
    const buffer = context.createBuffer(2, frames, context.sampleRate);
    // Deliberately NOT 440 Hz: the fake capture fixture is a 440 Hz sine, and two
    // correlated tones sum phase-dependently, which would make "monitored input
    // is present" an unsound comparison. At 311/659 Hz the two sources are
    // uncorrelated, so their RMS combines in quadrature and the monitored
    // contribution is a deterministic, measurable increase.
    for (let index = 0; index < frames; index++) {
      const t = index / context.sampleRate;
      buffer.getChannelData(0)[index] = Math.sin(2 * Math.PI * 311 * t) * 0.25;
      buffer.getChannelData(1)[index] = Math.sin(2 * Math.PI * 659 * t) * 0.25;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(channel.input);
    source.start();
    coexistenceProbe.signal = { source, gain };
  }
}

/** Removes the probe's taps and restores `updateMixerTrack` exactly as it was. */
export function disarmNativeVst3MonitoringCoexistenceProbe(engine: typeof audioEngine): void {
  const probe = coexistenceProbe;
  coexistenceProbe = null;
  if (!probe) return;
  (engine as unknown as { updateMixerTrack: typeof probe.originalUpdate }).updateMixerTrack = probe.originalUpdate;
  if (probe.signal) {
    try { probe.signal.source.stop(); } catch { /* never started or already stopped */ }
    try { probe.signal.source.disconnect(); } catch { /* already disconnected */ }
    try { probe.signal.gain.disconnect(); } catch { /* already disconnected */ }
  }
  for (const node of [probe.inputTap, probe.outputTap, probe.splitter]) {
    try { node.disconnect(); } catch { /* already disconnected */ }
  }
}

const analyserRms = (analyser: AnalyserNode): number => {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
};

/**
 * Reads the live native + monitoring state once. Cumulative counters are returned
 * so the caller can diff stages; nothing here is invented - a value that cannot be
 * observed is reported null and named in `unverified`.
 */
export async function measureNativeVst3MonitoringCoexistence(engine: typeof audioEngine, label: string) {
  const probe = coexistenceProbe;
  if (!probe) throw new Error('Arm the native coexistence probe before measuring.');
  const unverified: string[] = [];
  const context = engine.getContext();
  const snapshot = await readSmokeSnapshot();
  if (!snapshot) unverified.push('nativeProcessingBlocks', 'nativeInputRms', 'nativeOutputRms', 'nativeServiceSessionCount',
    'nativeSessionIdentity', 'nativeProcessingFailures');

  const records = (snapshot?.main?.processAudio ?? [])
    .filter(record => record.trackId === probe.trackId && record.slotId === probe.slotId);
  // `requestId` is `${runtimeId}:${sequence}`; the runtime id is minted per prepared
  // native session, so a changed set means the session was re-prepared.
  const runtimeIds = [...new Set(records.map(record => String(record.requestId ?? '').split(':')[0]).filter(Boolean))].sort();
  const failures = records.filter(record => record.error !== null && record.error !== undefined);
  const finiteOutputs = records.filter(record => Number.isFinite(record.nativeOutputRms ?? NaN));

  const rendererEvents = getNativeVst3MixerEffectSmokeTiming()
    .filter(event => event.trackId === probe.trackId && event.slotId === probe.slotId);
  const countEvents = (name: string) => rendererEvents.filter(event => event.event === name).length;

  // Cold-start forensics. The worklet fails closed when a 1024-frame block fills
  // while the previous block's result is still outstanding, so the real budget is
  // one block period. Decompose each early block's round trip into the legs that
  // can actually spend it: renderer -> main, the helper channel (serial-queue
  // wait, request serialization, helper round trip, frame parsing) and main ->
  // renderer. Epoch stamps are the only cross-process comparable clock.
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const blockBudgetMs = 1024 * 1000 / context.sampleRate;
  const resultsBySequence = new Map<number, { acceptedAtEpochMs: number | null; roundTripMs: number | null }>();
  for (const event of rendererEvents) {
    if (event.event !== 'worklet-result') continue;
    const sequence = num(event.sequence);
    if (sequence === null) continue;
    resultsBySequence.set(sequence, {
      acceptedAtEpochMs: num(event.acceptedAtEpochMs), roundTripMs: num(event.roundTripMs),
    });
  }
  const decompose = (record: NativeProcessRecord) => {
    const sequence = num(record.sequence);
    const submittedAtEpochMs = num(record.submittedAtEpochMs);
    const ipcReceivedAtMainEpochMs = num(record.ipcReceivedAtMainEpochMs);
    const ipcReceivedAtMainMs = num(record.ipcReceivedAtMainMs);
    const serviceCompletedAtMainMs = num(record.serviceCompletedAtMainMs);
    const accepted = sequence === null ? undefined : resultsBySequence.get(sequence);
    const acceptedAtEpochMs = accepted?.acceptedAtEpochMs ?? null;
    // The main process's monotonic clock rebased onto the epoch clock, so its
    // completion stamp can be compared with the worklet's acceptance stamp.
    const mainEpochOriginMs = ipcReceivedAtMainEpochMs !== null && ipcReceivedAtMainMs !== null
      ? ipcReceivedAtMainEpochMs - ipcReceivedAtMainMs : null;
    const serviceCompletedAtMainEpochMs = mainEpochOriginMs !== null && serviceCompletedAtMainMs !== null
      ? mainEpochOriginMs + serviceCompletedAtMainMs : null;
    const totalMs = acceptedAtEpochMs !== null && submittedAtEpochMs !== null
      ? acceptedAtEpochMs - submittedAtEpochMs : null;
    return {
      sequence,
      rendererToMainMs: ipcReceivedAtMainEpochMs !== null && submittedAtEpochMs !== null
        ? ipcReceivedAtMainEpochMs - submittedAtEpochMs : null,
      nativeServiceCallMs: num(record.nativeServiceCallMs),
      helperQueueWaitMs: num(record.helperQueueWaitMs),
      helperSerializeMs: num(record.helperSerializeMs),
      helperRoundTripMs: num(record.helperRoundTripMs),
      helperFrameParseMs: num(record.helperFrameParseMs),
      // The three spans measured inside the helper process itself.
      helperPipeAndScheduleMs: num(record.helperPipeAndScheduleMs),
      helperDecodeMs: num(record.helperDecodeMs),
      // `num` yields null for anything absent or non-finite, so a helper that did
      // not report a span stays visibly unmeasured instead of reading as zero.
      helperInstanceProcessMs: num(record.helperInstanceProcessMs),
      helperHostPrepareMs: num(record.helperHostPrepareMs),
      helperPluginCallbackMs: num(record.helperPluginCallbackMs),
      helperHostCollectMs: num(record.helperHostCollectMs),
      helperProcessFrames: num(record.helperProcessFrames),
      helperProcessIsFlush: typeof record.helperProcessIsFlush === 'boolean'
        ? record.helperProcessIsFlush : null,
      helperRequestBytes: num(record.helperRequestBytes),
      mainToRendererMs: acceptedAtEpochMs !== null && serviceCompletedAtMainEpochMs !== null
        ? acceptedAtEpochMs - serviceCompletedAtMainEpochMs : null,
      totalRoundTripMs: totalMs ?? accepted?.roundTripMs ?? null,
      budgetMs: blockBudgetMs,
      marginMs: totalMs !== null ? blockBudgetMs - totalMs : null,
      eventLoopLagMaxMs: num(record.eventLoopLagMaxMs),
      // The discriminator this whole investigation turns on: the worst main-process
      // event-loop stall sampled inside this block's own request/response window.
      eventLoopLagDuringBlockMs: num(record.eventLoopLagDuringBlockMs),
      error: record.error ?? null,
    };
  };
  const coldStartBlocks = records.slice(0, 12).map(decompose);

  // A miss is not always a cold-start event: one was measured at sequence 117,
  // about 2.5 s into playback, around where monitoring is enabled. Capturing only
  // the first blocks would report a healthy window for a run that failed, so also
  // capture the blocks either side of every sequence the guard named. The
  // selection is pure and unit-tested in nativeMissWindow.test.ts.
  const missedSequences = collectMissedSequences(rendererEvents);
  const aroundAMiss = orderBlocksAroundMiss(records, missedSequences).map(decompose);

  const node = engine.nativeMixerEffects.nodeFor(probe.trackId, probe.slotId, context);
  let nodeId: string | null = null;
  if (node) {
    const known = probe.nodeIds.get(node as unknown as AudioNode);
    if (known) nodeId = known;
    else {
      nodeId = `${probe.slotId}-node-${++probe.nodeIdCounter}`;
      probe.nodeIds.set(node as unknown as AudioNode, nodeId);
    }
  }

  return {
    label,
    atMs: performance.now(),
    transport: engine.getTransportMusicalPosition(),
    monitor: engine.liveInputMonitor.getSnapshot(),
    native: {
      prepared: engine.nativeMixerEffects.isPrepared(probe.trackId, probe.slotId, context),
      nodePresent: !!node,
      nodeId,
      runtimeIds,
      pluginLatencyFrames: engine.nativeMixerEffects.pluginLatencyFramesFor(probe.trackId, probe.slotId, context) ?? null,
      processedBlocks: records.length,
      maxSequence: records.reduce((max, record) => Math.max(max, Number(record.sequence ?? -1)), -1),
      failures: failures.length,
      failureMessages: [...new Set(failures.map(record => String(record.error)))].slice(0, 5),
      nativeInputRmsLast: finiteOutputs.length ? records[records.length - 1]?.nativeInputRms ?? null : null,
      nativeOutputRmsLast: finiteOutputs.length ? records[records.length - 1]?.nativeOutputRms ?? null : null,
      nativeOutputRmsMean: finiteOutputs.length
        ? finiteOutputs.reduce((sum, record) => sum + Number(record.nativeOutputRms), 0) / finiteOutputs.length : null,
      nativeServiceCallMsMax: records.reduce((max, record) => Math.max(max, Number(record.nativeServiceCallMs ?? 0)), 0),
      nativeServiceSessionCount: snapshot?.main?.nativeServiceSessionCount ?? null,
      // Cold-start evidence: the first blocks' decomposed round trips, the main
      // process's worst event-loop stall, and how long the helper took to spawn,
      // bind its protocol channel and load the plug-in.
      coldStartBlocks,
      // Blocks either side of a miss, whichever part of the session it happened in.
      blocksAroundMiss: aroundAMiss,
      missedSequences,
      // The guard's own report. It names the sequence that was still outstanding
      // and the frame it was due at, which is what distinguishes "the request
      // never reached the main process" from "the helper answered too late":
      // a pending sequence with no main-process record never arrived.
      deadlineMissEvents: rendererEvents
        .filter(event => event.event === 'pending-deadline-miss' || event.event === 'deadline-miss')
        .slice(0, 6)
        .map(event => ({
          event: String(event.event), sequence: num(event.sequence), nextSequence: num(event.nextSequence),
          pendingSequence: num(event.pendingSequence), inputContextFrame: num(event.inputContextFrame),
          currentOutputFrame: num(event.currentOutputFrame), dueOutputFrame: num(event.dueOutputFrame),
          sourceFrame: num(event.sourceFrame),
        })),
      mainRecordedSequences: records.map(record => num(record.sequence)).filter((v): v is number => v !== null),
      blockBudgetMs,
      worstColdStartTotalMs: coldStartBlocks.reduce((worst, block) => (
        block.totalRoundTripMs !== null && (worst === null || block.totalRoundTripMs > worst)
          ? block.totalRoundTripMs : worst), null as number | null),
      worstColdStartMarginMs: coldStartBlocks.reduce((worst, block) => (
        block.marginMs !== null && (worst === null || block.marginMs < worst)
          ? block.marginMs : worst), null as number | null),
      mainEventLoopLagMaxMs: num(snapshot?.main?.eventLoopLag?.maxLagMs),
      mainEventLoopLagDuringAudioMs: num(snapshot?.main?.eventLoopLag?.maxLagDuringAudioMs),
      mainEventLoopWorstStalls: snapshot?.main?.eventLoopLag?.worstStalls ?? null,
      helperStartup: snapshot?.main?.helperStartup ?? null,
      workletSubmissions: countEvents('worklet-submit'),
      deadlineMisses: countEvents('pending-deadline-miss'),
      cancelledAtStop: countEvents('renderer-request-cancelled-at-stop'),
    },
    pcm: { insertInputRms: analyserRms(probe.inputTap), insertOutputRms: analyserRms(probe.outputTap) },
    mixerTracksRebuiltSinceArm: [...probe.rebuilds],
    diagnostics: getVst3MixerEffectDiagnostics().map(item => ({ trackId: item.trackId, slotId: item.slotId, message: item.message })),
    unverified,
  };
}

export type NativeVst3MonitoringCoexistenceMeasurement = Awaited<ReturnType<typeof measureNativeVst3MonitoringCoexistence>>;
