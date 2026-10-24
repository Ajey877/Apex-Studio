import { nativeTarget } from './nativeVst3Automation';
// Executed ONLY by the existing packaged-runtime smoke launch flag. This calls
// the production engine/registry/export path, not an alternate WAV renderer.
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { getVst3Bridge } from './nativeVst3Types';
import { getVst3Diagnostics } from './nativeVst3Runtime';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { persistProjectState, restorePersistedProjectState, serializeProjectState } from '../state/projectPersistence';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';

export async function runDesktopVst3Smoke() {
  const bridge = getVst3Bridge();
  if (!bridge) throw new Error('Packaged VST3 preload bridge missing');
  const discovered = await bridge.discover();
  const plugin = discovered.plugins.find(item => item.name === 'mda JX10');
  if (!plugin) throw new Error(`Real MDA fixture not discovered through packaged IPC: ${JSON.stringify(discovered.errors)}`);
  const initial = await bridge.inspect(plugin);
  const instrument = await bridge.inspect(plugin, { ...initial.state, parameters: [{ id: 14, value: 0 }, { id: 18, value: 0 }] });
  const instance = new (audioEngine.constructor as { new(): typeof audioEngine })();
  instance.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  instance.setBpm(120);
  let channel: Channel = {
    ...createDefaultProjectState().channels[0], id: 'packaged-native', name: 'Real packaged MDA JX10',
    instrumentType: 'vst3', vst3: instrument, volume: 1, pan: 0, pitch: 0, mute: false, solo: false, mixerTrackId: 1,
    steps: Array(16).fill(false), notes: [{ id: 'native-smoke-note', pitch: 60, start: 1, duration: 1, velocity: 0.8 }],
  };
  const mixer = [0, 1].map(id => ({ id, name: 'Smoke insert', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 })) as MixerTrack[];
  const clip: PlaylistClip = { id: 'native-smoke-clip', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern', channelId: channel.id, name: 'Native smoke', color: '#fff' };
  let savedAutomation: PlaylistClip | undefined;
  const reopening = (globalThis as unknown as { desktopApp?: { smokeReopen?: boolean } }).desktopApp?.smokeReopen === true;
  if (reopening) {
    const saved = await restorePersistedProjectState(instance, createDefaultProjectState());
    if (!saved.restored || saved.recovered || saved.state.channels[0]?.instrumentType !== 'vst3') throw new Error('Native project did not reopen from the real current-project IndexedDB record');
    channel = saved.state.channels[0];
    savedAutomation = saved.state.playlistClips.find(c => c.automationTarget?.type === 'vst3_param');
    if (!savedAutomation) throw new Error('Native automation lane did not survive application restart');
    if (channel.vst3?.classId !== plugin.classId) throw new Error('Reopened project selected the wrong native class');
  }
  function digest(bytes: Uint8Array): string {
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
    return value.toString(16).padStart(8, '0');
  }
  const render = (value: Channel) => instance.renderTimelineOffline([value], [clip], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 0.5);
  try {
    const reference = await render({ ...channel, vst3: instrument });
    if (!reopening) {
      await instance.editVst3Parameters(channel, [{ id: 6, value: .05 }], () => true, vst3 => { channel = { ...channel, vst3 }; });
      await instance.releaseNativeInstruments();
    }
    if (channel.vst3?.state.parameters.find(p => p.id === 6)?.value !== .05) throw new Error('Edited native parameter did not survive application restart');
    const metadata = await bridge.describe(channel.vst3);
    if (Math.abs((metadata.parameters.find(p => p.id === 6)?.currentValue ?? -1) - .05) > 1e-7) throw new Error('Packaged native controller did not restore the edited value');
    const frequency = metadata.parameters.find(p => p.id === 6)!;
    const automation: PlaylistClip = savedAutomation ?? { id: 'packaged-vcf-automation', type: 'automation', trackIndex: 1,
      startBar: 0, lengthBars: 1, name: 'VCF automation', color: '#fff', automationTarget: nativeTarget(channel, frequency),
      automationPoints: [{ x: 0, y: .9 }, { x: 1, y: .05 }] };
    const automated = await instance.renderTimelineOffline([channel], [clip, automation], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, .5);
    const output = await render(channel);
    const samples = output.getChannelData(0);
    let differenceSum = 0;
    const before = reference.getChannelData(0);
    for (let i = 0; i < samples.length; i++) differenceSum += (samples[i] - before[i]) ** 2;
    const parameterExportDifferenceRms = Math.sqrt(differenceSum / samples.length);
    if (parameterExportDifferenceRms < .001) throw new Error('Packaged parameter edit did not alter real production PCM');
    const automatedPcm = automated.getChannelData(0);
    let automationDifference = 0;
    for (let i = 0; i < samples.length; i++) automationDifference += (automatedPcm[i] - samples[i]) ** 2;
    const automationExportDifferenceRms = Math.sqrt(automationDifference / samples.length);
    if (automationExportDifferenceRms < .001) throw new Error('Packaged Playlist automation did not affect real native export');
    const automationPcmChecksum = digest(new Uint8Array(automatedPcm.buffer, automatedPcm.byteOffset, automatedPcm.byteLength));
    const automationStateChecksum = digest(new TextEncoder().encode(JSON.stringify(automation)));
    const onsetFrame = samples.findIndex(value => Math.abs(value) > 1e-7);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = Math.sqrt(sum / samples.length);
    if (onsetFrame < 6000 || onsetFrame > 6064 || rms < 0.001) throw new Error(`Packaged production export failed: onset=${onsetFrame}, rms=${rms}`);
    const json = serializeProjectState({ ...createDefaultProjectState(), channels: [channel], mixerTracks: mixer, playlistClips: [clip, automation] });
    const restored = normalizeProjectState(JSON.parse(json).state).channels[0];
    const reopened = await render(restored);
    const after = reopened.getChannelData(0);
    if (after.length !== samples.length || after.some((value, index) => value !== samples[index])) throw new Error('Packaged state reopen did not reproduce native PCM');
    let rejected = false;
    try { await render({ ...channel, vst3: { ...instrument, path: `${instrument.path}.missing.vst3` } }); }
    catch { rejected = true; }
    if (!rejected) throw new Error('Missing native instrument silently succeeded');
    await instance.play([channel], [], 'pat', undefined, mixer, 16);
    const context = instance.getContext();
    await Promise.race([context.resume(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Packaged live AudioContext did not resume')), 3000))]);
    const live = new Uint8Array(512);
    let livePeak = 0;
    const end = performance.now() + 600;
    while (performance.now() < end) {
      instance.getMasterWaveformData(live);
      for (const value of live) livePeak = Math.max(livePeak, Math.abs((value - 128) / 128));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const errors = getVst3Diagnostics().filter(item => item.channelId === channel.id && !item.message.startsWith('VST3 ready') && !item.message.startsWith('VST3 active'));
    if (livePeak < 0.001 || errors.length) throw new Error(`Packaged live graph failed: peak=${livePeak}, diagnostics=${JSON.stringify(errors)}`);
    if (reopening && !document.body.textContent?.includes(channel.name)) throw new Error('The actual Apex application UI did not restore the saved native channel');
    if (!reopening) {
      const project = createDefaultProjectState();
      await persistProjectState({ ...project, meta: { ...project.meta, bpm: 120 }, selectedChannelId: channel.id, channels: [channel], mixerTracks: mixer, playlistClips: [clip, automation] });
    }
    return { automationExportDifferenceRms, automationPcmChecksum, automationStateChecksum, parameterValue: .05, parameterExportDifferenceRms, plugin: plugin.name, classId: plugin.classId, onsetFrame, rms, livePeak, stateReopenEqual: true, missingRejected: rejected,
      applicationStage: reopening ? 'reopened-from-indexeddb-after-process-exit' : 'saved-to-production-indexeddb',
      uiRestored: reopening ? true : undefined,
      pcmChecksum: digest(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)),
      savedStateChecksum: digest(new TextEncoder().encode(JSON.stringify(channel.vst3))),
      proof: 'Packaged helper + real preload IPC + AudioClockTransport/live master graph + production song export (Chromium Web Audio); not physical-device listening' };
  } finally {
    instance.stop();
    await instance.releaseNativeInstruments();
    await instance.getContext().close();
  }
}
