import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Vst3Service } from '../native/vst3/service.mjs';

/**
 * Phase 10H — Track Freeze with a real VST3 instrument (mda JX10) hosted by the
 * production native helper. The only test-only part is the transport that
 * stands in for Electron IPC; every sample comes from the real plug-in.
 */
const build = path.resolve('build/native-vst3'), name = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', name), path.join(build, 'bin/Release', name)].find(existsSync);
if (!executable) throw new Error('Build the actual native helper/MDA fixture before the native browser gate');

let service: Vst3Service;
let opened: string[] = [];
let closed = 0;
let processed = 0;
test.beforeEach(() => { opened = []; closed = 0; processed = 0; service = new Vst3Service(executable, [path.join(build, 'VST3/Release')]); });
test.afterEach(async () => { await service.dispose(); });

async function setup(page: Page) {
  const plugin = (await service.discover()).plugins.find(p => p.name === 'mda JX10')!;
  const instrument = await service.inspect(plugin);
  await page.exposeFunction('nativeTestCall', async (method: string, args: any[]) => {
    switch (method) {
      case 'discover': return service.discover();
      case 'inspect': return service.inspect(args[0], args[1]);
      case 'describe': return service.describe(args[0]);
      case 'open': opened.push(String(args[2] ?? 'realtime')); return service.open(args[0], args[1], args[2]);
      case 'parameters': return service.parameters(args[0], args[1]);
      case 'process': processed += 1; return Array.from(await service.process(args[0], args[1], args[2], args[3], 'local', args[4]));
      case 'close': closed += 1; return service.close(args[0]);
      default: throw new Error('Unauthorized test operation');
    }
  });
  await page.exposeFunction('nativeTestCounters', () => ({ opened: [...opened], closed, processed }));
  await page.addInitScript(() => {
    const call = (method: string, ...args: any[]) => (window as any).nativeTestCall(method, args);
    (window as any).desktopApp = { vst3: {
      discover: () => call('discover'), inspect: (...args: any[]) => call('inspect', ...args),
      describe: (...args: any[]) => call('describe', ...args), open: (...args: any[]) => call('open', ...args),
      parameters: (...args: any[]) => call('parameters', ...args), close: (...args: any[]) => call('close', ...args),
      process: async (...args: any[]) => new Float32Array(await call('process', ...args)),
    } };
  });
  await page.goto('http://localhost:3000');
  await page.locator('#nav-channel-rack').waitFor();
  return instrument;
}

// In-page fixture: a VST3 lead and a built-in bass through a live mixer.
const FIXTURE = `
  const { audioEngine: engine } = await import('/src/audio/audioEngine.ts');
  const { createDefaultProjectState } = await import('/src/state/projectState.ts');
  const freezeState = await import('/src/state/trackFreeze.ts');
  engine.init();
  const ctx = engine.getContext();
  const rate = ctx.sampleRate;
  const internals = engine;
  const state = createDefaultProjectState();
  state.meta.bpm = internals.bpm; state.meta.swing = internals.swing; state.meta.timeSignature = [...internals.meter];
  const BPM = state.meta.bpm;
  engine.setGrossBeatState({ enabled: false });
  const note = (pitch, start, duration = 2) => ({ id: 'n' + pitch + '-' + start, pitch, start, duration, velocity: 0.7 });
  const base = { ...state.channels[0], steps: Array(16).fill(false), notes: [], mute: false, solo: false, pitch: 0,
    arp: undefined, customSample: undefined, drumPads: undefined, sampleZones: undefined, midiOutput: undefined };
  const lead = { ...base, id: 'lead', name: 'Lead', instrumentType: 'vst3', vst3: instrument, mixerTrackId: 1, volume: 0.7, pan: -0.2,
    notes: [note(64, 0), note(67, 4), note(71, 8), note(72, 12)] };
  const bass = { ...base, id: 'bass', name: 'Bass', instrumentType: 'minisynth', mixerTrackId: 2, volume: 0.5, pan: 0.2,
    synthParams: { ...engine.getDefaultSynthParams(), osc1Type: 'sine', osc2Mix: 0, lfoDepth: 0 }, notes: [note(40, 0, 4), note(43, 8, 4)] };
  state.channels = [lead, bass];
  state.patterns = [{ id: 'p', name: 'Main', lengthSteps: 16, color: '#fff' }];
  state.selectedPatternId = 'p';
  state.mixerTracks = [0, 1, 2].map(id => ({ id, name: 'Track ' + id, volume: 1, pan: 0, mute: false, solo: false, color: '#fff', peakL: 0, peakR: 0, fxSlots: [] }));
  state.mixerTracks[1].fxSlots = [{ id: 'lead-eq', type: 'equalizer', name: 'EQ', enabled: true, mix: 1, params: { midGain: 3 } }];
  state.mixerTracks[1].volume = 0.8;
  state.playlistTracks = state.playlistTracks.map(t => ({ ...t, mute: false, solo: false }));
  state.playlistClips = [
    { id: 'lead-a', type: 'pattern', patternId: 'p', channelId: 'lead', color: '#fff', name: 'lead', trackIndex: 0, startBar: 0, lengthBars: 2 },
    { id: 'bass-a', type: 'pattern', patternId: 'p', channelId: 'bass', color: '#fff', name: 'bass', trackIndex: 1, startBar: 0, lengthBars: 2 },
  ];
  const BARS = 2;
  const SECONDS = 6;
  const render = (s, stage = 'master') => engine.renderTimelineOffline(s.channels, s.playlistClips, s.mixerTracks, BPM, BARS, rate,
    true, 'song', undefined, undefined, s.playlistTracks, SECONDS, s.patterns, stage);
  const rms = (b) => { let sum = 0, n = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; n++; } } return Math.sqrt(sum / n); };
  const maxDiff = (a, b) => { let m = 0; const n = Math.min(a.length, b.length); for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) { const x = a.getChannelData(c), y = b.getChannelData(c); for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i] - y[i])); } return m; };
  const counters = () => window.nativeTestCounters();
  const withChannel = (s, id, patch) => ({ ...s, channels: s.channels.map(c => c.id === id ? { ...c, ...patch } : c) });
`;
const evaluateWithFixture = (body: string) =>
  new Function('instrument', `return (async () => { ${FIXTURE}\n${body} })();`) as (instrument: unknown) => Promise<any>;

test('a frozen VST3 channel nulls against the plug-in in a mastered export and needs no plug-in instance', async ({ page }) => {
  test.setTimeout(240_000);
  const instrument = await setup(page);
  const r = await page.evaluate(evaluateWithFixture(`
    const reference = await render(state);
    const afterReference = await counters();
    const repeat = await render(state);
    const afterRepeat = await counters();
    const withoutLead = await render(withChannel(state, 'lead', { mute: true }));

    const result = await engine.renderChannelFreeze(lead, state.playlistClips, state.patterns, state.playlistTracks, BPM);
    const afterFreeze = await counters();
    engine.setSampleBuffer('freeze-vst3-lead', result.buffer);
    const frozen = freezeState.applyChannelFreeze(state, 'lead', { ...result.freeze, audioBufferId: 'freeze-vst3-lead' });
    const status = freezeState.resolveChannelFreezeStatus(frozen.channels[0], freezeState.channelFreezeSourceFromProject(frozen));

    const before = await counters();
    const frozenRender = await render(frozen);
    const afterFrozen = await counters();
    const frozenIds = engine.getLastOfflineRenderFrozenChannelIds();

    // A baked VST3 edit (the plug-in's saved state) makes the freeze stale and
    // the plug-in renders again.
    const editedInstrument = { ...instrument, stateBase64: instrument.stateBase64, parameterValues: { ...(instrument.parameterValues ?? {}), 0: 0.123 } };
    const edited = withChannel(frozen, 'lead', { vst3: editedInstrument });
    const editedStatus = freezeState.resolveChannelFreezeStatus(edited.channels[0], freezeState.channelFreezeSourceFromProject(edited));

    // Unfreeze: the plug-in is the source again.
    const unfrozen = freezeState.removeChannelFreeze(frozen, 'lead');
    const unfrozenRender = await render(unfrozen);
    const afterUnfrozen = await counters();
    return {
      rate, status, editedStatus, frozenIds, peak: result.peak, tailDecayed: result.freeze.tailDecayed, leadInFrames: result.freeze.leadInFrames,
      referenceRms: rms(reference), leadContribution: maxDiff(reference, withoutLead),
      repeatNull: maxDiff(reference, repeat), nullPeak: maxDiff(reference, frozenRender), unfreezeNull: maxDiff(reference, unfrozenRender),
      opensForReference: afterReference.opened, opensForRepeat: afterRepeat.opened.length - afterReference.opened.length,
      opensForFreeze: afterFreeze.opened.slice(-1),
      opensDuringFrozenRender: afterFrozen.opened.length - before.opened.length,
      processDuringFrozenRender: afterFrozen.processed - before.processed,
      opensDuringUnfrozenRender: afterUnfrozen.opened.length - afterFrozen.opened.length,
      openedTotal: afterUnfrozen.opened.length, closedTotal: afterUnfrozen.closed,
    };
  `), instrument);
  console.log(`[vst3TrackFreeze] offline evidence ${JSON.stringify(r)}`);
  expect(r.status).toBe('frozen');
  expect(r.peak).toBeGreaterThan(0.01);
  expect(r.leadInFrames).toBe(Math.ceil(r.rate * 0.1));
  // The reference really rendered the plug-in, and the lead matters in the mix.
  expect(r.opensForReference).toEqual(['offline']);
  expect(r.opensForRepeat).toBe(1);
  expect(r.leadContribution).toBeGreaterThan(0.02);
  // The frozen export: no plug-in instance, no plug-in processing, same audio.
  expect(r.frozenIds).toEqual(['lead']);
  expect(r.opensDuringFrozenRender).toBe(0);
  expect(r.processDuringFrozenRender).toBe(0);
  expect(r.nullPeak).toBeLessThan(Math.max(2e-4, r.repeatNull * 4));
  // Stale after a plug-in edit, and Unfreeze restores the plug-in render.
  expect(r.editedStatus).toBe('stale');
  expect(r.opensDuringUnfrozenRender).toBe(1);
  expect(r.unfreezeNull).toBeLessThan(Math.max(2e-4, r.repeatNull * 4));
  // Every offline instance that was opened was closed again.
  expect(r.closedTotal).toBe(r.openedTotal);
});

test('live Song playback of a frozen VST3 channel holds no plug-in instance; going stale or Pattern mode loads it again', async ({ page }) => {
  test.setTimeout(240_000);
  const instrument = await setup(page);
  const r = await page.evaluate(evaluateWithFixture(`
    const { getVst3Diagnostics } = await import('/src/audio/nativeVst3Runtime.ts');
    // A longer timeline than the offline test, so the take outlasts the hand-overs.
    state.playlistClips = state.playlistClips.map(clip => ({ ...clip, lengthBars: 6 }));
    const result = await engine.renderChannelFreeze(lead, state.playlistClips, state.patterns, state.playlistTracks, BPM);
    engine.setSampleBuffer('freeze-vst3-live', result.buffer);
    const frozen = freezeState.applyChannelFreeze(state, 'lead', { ...result.freeze, audioBufferId: 'freeze-vst3-live' });
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const live = async () => (await counters()).opened.filter(mode => mode !== 'offline').length;
    const sessions = () => internals.nativeInstruments.sessions.size;
    const messages = new Set();
    const watch = async (ms) => { const end = performance.now() + ms; while (performance.now() < end) { for (const d of getVst3Diagnostics()) messages.add(d.message); await wait(25); } };
    const play = (s, mode) => engine.play(s.channels, s.playlistClips, mode, 'p', s.mixerTracks, 16, s.playlistTracks, s.patterns);
    const sync = (s) => engine.synchronizePlaybackState({ channels: s.channels, clips: s.playlistClips, patterns: s.patterns, playlistTracks: s.playlistTracks });
    const out = {};
    try {
      // 1. The unfrozen project needs a live plug-in instance.
      await play(state, 'song'); await ctx.resume(); await wait(900);
      out.unfrozen = { live: await live(), sources: engine.getFreezeSourceChannelIds() };
      engine.stop(); await engine.releaseNativeInstruments(); await wait(200);
      const baseline = await live();

      // 2. Frozen: the take plays without one.
      await play(frozen, 'song'); await wait(1200);
      out.frozen = { liveOpened: (await live()) - baseline, sessions: sessions(), playing: internals.isPlaying,
        active: engine.getActiveFrozenChannelIds(), sources: engine.getFreezeSourceChannelIds() };

      // 3. The freeze goes stale mid-take: the plug-in is loaded again, and the
      //    channel's sequenced notes wait for it instead of failing a cold session.
      messages.clear();
      sync(withChannel(frozen, 'lead', { volume: 0.4 }));
      const holdingNotes = [...internals.nativeResumingChannelIds];
      await watch(1500);
      out.stale = { liveOpened: (await live()) - baseline, holdingNotes, stillHolding: [...internals.nativeResumingChannelIds],
        active: engine.getActiveFrozenChannelIds(), sources: engine.getFreezeSourceChannelIds(), messages: [...messages] };

      // 4. Valid again mid-take: frozen audio returns and the instance is released.
      sync(frozen);
      await wait(300);
      const opensAfterRestore = await live();
      await wait(600);
      out.restored = { sessions: sessions(), newOpens: (await live()) - opensAfterRestore, playing: internals.isPlaying,
        active: engine.getActiveFrozenChannelIds(), sources: engine.getFreezeSourceChannelIds() };
      engine.stop(); await engine.releaseNativeInstruments(); await wait(200);

      // 5. Pattern mode always plays the plug-in.
      const beforePattern = await live();
      await play(frozen, 'pat'); await wait(900);
      out.pattern = { liveOpened: (await live()) - beforePattern, active: engine.getActiveFrozenChannelIds(), sources: engine.getFreezeSourceChannelIds() };
    } finally {
      engine.stop();
      await engine.releaseNativeInstruments();
    }
    await wait(400);
    const end = await counters();
    out.balance = { opened: end.opened.length, closed: end.closed };
    return out;
  `), instrument);
  console.log(`[vst3TrackFreeze] live evidence ${JSON.stringify(r)}`);
  expect(r.unfrozen.live).toBeGreaterThanOrEqual(1);
  expect(r.unfrozen.sources).toEqual([]);
  // Frozen: not one plug-in instance was requested for the whole take.
  expect(r.frozen.playing).toBe(true);
  expect(r.frozen.liveOpened).toBe(0);
  expect(r.frozen.sessions).toBe(0);
  expect(r.frozen.active).toEqual(['lead']);
  expect(r.frozen.sources).toEqual(['lead']);
  // Stale: the plug-in is requested again; notes were held until it had loaded,
  // so no session was started cold in the middle of the take.
  expect(r.stale.liveOpened).toBeGreaterThanOrEqual(1);
  expect(r.stale.holdingNotes).toEqual(['lead']);
  expect(r.stale.stillHolding).toEqual([]);
  expect(r.stale.active).toEqual([]);
  expect(r.stale.sources).toEqual([]);
  expect(r.stale.messages).toContain('VST3 ready');
  expect(r.stale.messages.filter((m: string) => m.includes('not prepared before the transport deadline'))).toEqual([]);
  // Restored: frozen audio again, no instance held and none requested.
  expect(r.restored.playing).toBe(true);
  expect(r.restored.sessions).toBe(0);
  expect(r.restored.newOpens).toBe(0);
  expect(r.restored.active).toEqual(['lead']);
  expect(r.restored.sources).toEqual(['lead']);
  expect(r.pattern.liveOpened).toBeGreaterThanOrEqual(1);
  expect(r.pattern.active).toEqual([]);
  expect(r.pattern.sources).toEqual([]);
  // Nothing leaked: every instance that was opened was closed.
  expect(r.balance.closed).toBe(r.balance.opened);
});
