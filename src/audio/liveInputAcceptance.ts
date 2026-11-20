// Diagnostic scenario, loaded only by acceptance tooling. Uses the actual engine,
// browser getUserMedia, mixer graph, recording worklet and persistence; no fake DSP.
import type { audioEngine } from './audioEngine';
import type { MixerTrack } from '../types/daw';
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
