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
}
type SmokeSnapshot = { main?: { processAudio?: NativeProcessRecord[]; nativeServiceSessionCount?: number } } | null;

const readSmokeSnapshot = async (): Promise<SmokeSnapshot> => {
  const desktop = (globalThis as unknown as { desktopApp?: { smokeTest?: boolean; vst3?: { smokeTimingSnapshot?: () => Promise<SmokeSnapshot> } } }).desktopApp;
  if (desktop?.smokeTest !== true || typeof desktop.vst3?.smokeTimingSnapshot !== 'function') return null;
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
