// Executed ONLY by the existing packaged-runtime smoke launch flag. This calls
// the production engine/registry/export path, not an alternate WAV renderer.
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { getVst3Bridge } from './nativeVst3Types';
import { getVst3Diagnostics } from './nativeVst3Runtime';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';
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
  const channel: Channel = {
    ...createDefaultProjectState().channels[0], id: 'packaged-native', name: 'Real packaged MDA JX10',
    instrumentType: 'vst3', vst3: instrument, volume: 1, pan: 0, pitch: 0, mute: false, solo: false, mixerTrackId: 1,
    steps: Array(16).fill(false), notes: [{ id: 'native-smoke-note', pitch: 60, start: 1, duration: 1, velocity: 0.8 }],
  };
  const mixer = [0, 1].map(id => ({ id, name: 'Smoke insert', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 })) as MixerTrack[];
  const clip: PlaylistClip = { id: 'native-smoke-clip', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern', channelId: channel.id, name: 'Native smoke', color: '#fff' };
  const render = (value: Channel) => instance.renderTimelineOffline([value], [clip], mixer, 120, 1, 48000, true, 'song', undefined, undefined, undefined, 0.5);
  try {
    const output = await render(channel);
    const samples = output.getChannelData(0);
    const onsetFrame = samples.findIndex(value => Math.abs(value) > 1e-7);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = Math.sqrt(sum / samples.length);
    if (onsetFrame < 6000 || onsetFrame > 6064 || rms < 0.001) throw new Error(`Packaged production export failed: onset=${onsetFrame}, rms=${rms}`);
    const json = serializeProjectState({ ...createDefaultProjectState(), channels: [channel], mixerTracks: mixer, playlistClips: [clip] });
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
    return { plugin: plugin.name, classId: plugin.classId, onsetFrame, rms, livePeak, stateReopenEqual: true, missingRejected: rejected,
      proof: 'Packaged helper + real preload IPC + AudioClockTransport/live master graph + production song export (Chromium Web Audio); not physical-device listening' };
  } finally {
    instance.stop();
    await instance.releaseNativeInstruments();
    await instance.getContext().close();
  }
}
