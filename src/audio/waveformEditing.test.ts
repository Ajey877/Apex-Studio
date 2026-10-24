import test from 'node:test';
import assert from 'node:assert/strict';
import * as WebAudio from 'web-audio-engine';
import { editWaveform, validatePcm, validateSelection, appendDraft } from './waveformEditing';
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { openWaveformSession, commitWaveformSession, publishWaveformClip, isWaveformSessionCurrent, WaveformAudition } from './waveformEditorCommit';
import { installSampleBufferPersistence } from './sampleBufferPersistence';
import { createDefaultProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { getHistoryAudioIds, serializeProjectState } from '../state/projectPersistence';
import { advancePlaylistAudioProjectGeneration, notePlaylistAudioPlaylistRevision } from '../state/playlistAudioPublication';
import type { PlaylistClip } from '../types/daw';

const Real = WebAudio as any;
(globalThis as any).window = globalThis;
(globalThis as any).AudioContext = class extends Real.RenderingAudioContext { constructor() { super({ sampleRate: 48000 }); } };
(globalThis as any).OfflineAudioContext = Real.OfflineAudioContext;
(globalThis as any).document = { createElement: () => ({}) };
const context = new Real.OfflineAudioContext(2, 48000, 48000);
const create = (channels: number, frames: number, rate: number) => context.createBuffer(channels, frames, rate) as AudioBuffer;
const samples = (buffer: AudioBuffer) => Array.from({ length: buffer.numberOfChannels }, (_, c) => Array.from(buffer.getChannelData(c)));
function fixture(channels = 2, frames = 12, rate = 48000) {
  const buffer = create(channels, frames, rate);
  for (let c = 0; c < channels; c++) for (let i = 0; i < frames; i++) buffer.getChannelData(c)[i] = (i + 1) / frames * (c ? -0.25 : 0.5);
  return buffer;
}
for (const channels of [1, 2]) {
  for (const type of ['crop', 'delete', 'silence', 'reverse', 'fade-in', 'fade-out', 'gain', 'normalize'] as const) {
    test(`${channels}-channel actual PCM ${type}: sample-exact selection and untouched source/outside`, () => {
      const source = fixture(channels), original = samples(source), range = { start: 3, end: 9 };
      const result = editWaveform(source, range, type === 'gain' ? { type, db: -6 } : type === 'normalize' ? { type, db: -1 } : { type }, create);
      assert.equal(result.sampleRate, source.sampleRate); assert.equal(result.numberOfChannels, channels);
      assert.equal(result.length, type === 'crop' ? 6 : type === 'delete' ? 6 : 12);
      for (let c = 0; c < channels; c++) {
        const data = samples(result)[c];
        if (type === 'crop') assert.deepEqual(data, original[c].slice(3, 9));
        else if (type === 'delete') assert.deepEqual(data, [...original[c].slice(0, 3), ...original[c].slice(9)]);
        else {
          assert.deepEqual(data.slice(0, 3), original[c].slice(0, 3)); assert.deepEqual(data.slice(9), original[c].slice(9));
          if (type === 'silence') assert.deepEqual(data.slice(3, 9), Array(6).fill(0));
          if (type === 'reverse') assert.deepEqual(data.slice(3, 9), original[c].slice(3, 9).reverse());
          if (type === 'fade-in') { assert.equal(Math.abs(data[3]), 0); assert.equal(data[8], original[c][8]); }
          if (type === 'fade-out') { assert.equal(Math.abs(data[8]), 0); assert.equal(data[3], original[c][3]); }
          if (type === 'gain') assert.ok(Math.abs(data[5] - original[c][5] * Math.pow(10, -6 / 20)) < 1e-7);
          if (type === 'normalize') assert.ok(Math.abs(data[8] - original[c][8] * Math.pow(10, -1 / 20) / original[0][8]) < 1e-7);
        }
      }
      assert.deepEqual(samples(source), original);
    });
  }
}
test('normalization uses linked-channel peak, reaches exact target, and never clips', () => {
  const source = fixture();
  for (const db of [-60, -6, -1, 0]) {
    const normalized = editWaveform(source, { start: 0, end: 12 }, { type: 'normalize', db }, create);
    assert.ok(Math.abs(Math.max(...samples(normalized)[0]) - Math.pow(10, db / 20)) < 1e-7);
    assert.ok(samples(normalized).flat().every(v => Math.abs(v) <= 1));
    assert.equal(normalized.getChannelData(1)[5], -normalized.getChannelData(0)[5] / 2);
  }
});
test('invalid/empty/fractional/nonfinite/outside ranges, clipping gain, silence normalize and full delete are refused', () => {
  const source = fixture();
  for (const range of [{ start: 0, end: 0 }, { start: 5, end: 4 }, { start: -1, end: 4 }, { start: 0, end: 13 }, { start: 0.5, end: 5 }, { start: NaN, end: 5 }, { start: 0, end: Infinity }]) assert.throws(() => validateSelection(source, range));
  assert.throws(() => editWaveform(source, { start: 0, end: 12 }, { type: 'delete' }, create), /empty audio/);
  assert.throws(() => editWaveform(source, { start: 0, end: 12 }, { type: 'gain', db: 12 }, create), /clip/);
  assert.throws(() => editWaveform(source, { start: 0, end: 12 }, { type: 'normalize', db: 1 }, create), /dBFS/);
  assert.throws(() => editWaveform(create(1, 4, 48000), { start: 0, end: 4 }, { type: 'normalize', db: 0 }, create), /Silent/);
  source.getChannelData(0)[0] = NaN; assert.throws(() => validatePcm(source), /non-finite/);
  assert.throws(() => validatePcm({ length: 0 } as AudioBuffer));
  assert.throws(() => validatePcm({ length: 1000000000, numberOfChannels: 2, sampleRate: 48000 } as AudioBuffer), /64 MiB/);
});
test('one-frame edits, edge crop/delete and repeated reverse preserve exact samples', () => {
  const source = fixture(1);
  assert.deepEqual(samples(editWaveform(source, { start: 0, end: 1 }, { type: 'crop' }, create))[0], [source.getChannelData(0)[0]]);
  assert.equal(editWaveform(source, { start: 0, end: 1 }, { type: 'fade-in' }, create).getChannelData(0)[0], 0);
  assert.equal(editWaveform(source, { start: 11, end: 12 }, { type: 'fade-out' }, create).getChannelData(0)[11], 0);
  for (let start = 0; start < 12; start++) for (let end = start + 1; end <= 12; end++) {
    const range = { start, end }, reversed = editWaveform(source, range, { type: 'reverse' }, create);
    assert.deepEqual(samples(editWaveform(reversed, range, { type: 'reverse' }, create)), samples(source));
  }
  assert.equal(appendDraft(Array(8).fill(source), 7, source).length, 8);
  assert.equal(appendDraft([source, source, source], 0, source).length, 2);
});

function engine() { return new (audioEngine.constructor as { new(): typeof audioEngine })(); }
const clip: PlaylistClip = { id: 'chosen', name: 'Real audio file', type: 'audio', audioBufferId: 'original', startBar: 0.5, lengthBars: 0.2, trackIndex: 0, color: '#abc' };
function project() { const state = createDefaultProjectState(); return { ...state, meta: { ...state.meta, bpm: 120 }, playlistClips: [{ ...clip, id: 'unrelated' }, clip] }; }

test('commit waits for actual production persistence seam, targets chosen clip, and exact project undo/redo retains both assets', async () => {
  const instance = engine(), blobs = new Map<string, Blob>();
  installSampleBufferPersistence(instance, { persistAudioClip: async (id, blob) => { blobs.set(id, blob); } });
  const source = fixture(2, 19200); instance.setSampleBuffer('original', source);
  let state = project(), history = createHistory(state);
  const session = await openWaveformSession(clip, 120, [4, 4], instance);
  const edited = editWaveform(session.buffer, { start: 1200, end: 18000 }, { type: 'crop' }, create);
  let published = false;
  const updated = await commitWaveformSession(session, edited, instance, {
    isCurrent: () => isWaveformSessionCurrent(session, state),
    publish(next) { assert.ok(blobs.has(next.audioBufferId!)); state = publishWaveformClip(state, session, next); history = history.commit(state, 'Edit waveform audio'); published = true; },
  });
  assert.ok(published); assert.notEqual(updated.audioBufferId, 'original'); assert.equal(updated.offsetSteps, 0);
  assert.equal(updated.startBar, clip.startBar); assert.equal(updated.lengthBars, 16800 / 48000 / 2);
  assert.equal(state.playlistClips[0].audioBufferId, 'original');
  instance.setProjectSampleBufferOwnership(getHistoryAudioIds(history));
  assert.deepEqual(samples(instance.getSampleBuffer('original')!), samples(source));
  const undo = history.undo(); assert.equal(undo.present.playlistClips[1].audioBufferId, 'original');
  const redo = undo.redo(); assert.equal(redo.present.playlistClips[1].audioBufferId, updated.audioBufferId);
  assert.deepEqual(samples(instance.getSampleBuffer(updated.audioBufferId!)!), samples(edited));
  assert.match(serializeProjectState(redo.present), new RegExp(updated.audioBufferId!));
  assert.equal(history.past.at(-1)?.label, 'Edit waveform audio');
});
test('storage failure, cancellation and project replacement never publish or retain an unpublished preview asset', async () => {
  for (const mode of ['failure', 'cancel', 'replacement']) {
    const instance = engine(), abort = new AbortController();
    let registered = '';
    installSampleBufferPersistence(instance, { persistAudioClip: async id => {
      if (id === 'original') return;
      registered = id;
      if (mode === 'failure') throw new Error('Quota exceeded');
      if (mode === 'cancel') abort.abort();
      if (mode === 'replacement') advancePlaylistAudioProjectGeneration();
    }, onError() {} });
    instance.setSampleBuffer('original', fixture(1, 19200));
    const session = await openWaveformSession(clip, 120, [4, 4], instance);
    await assert.rejects(commitWaveformSession(session, session.buffer, instance, { signal: abort.signal, isCurrent: () => true, publish() { assert.fail('must not publish'); } }), /Quota|cancelled|changed|Stale/);
    assert.equal(instance.getSampleBuffer(registered), undefined); assert.ok(instance.getSampleBuffer('original'));
  }
});
test('source resolution uses selected region with trim/rate/meter and rejects missing/unsupported sources', async () => {
  const instance = engine(); instance.setSampleBuffer('original', fixture(1, 48000));
  const trimmed = { ...clip, offsetSteps: 1, timeStretchRate: 2, lengthBars: 0.1 };
  const session = await openWaveformSession(trimmed, 120, [3, 4], instance);
  assert.equal(session.buffer.length, 14400); // .1 bar * 1.5 seconds * 2 * 48k
  assert.equal(session.buffer.getChannelData(0)[0], instance.getSampleBuffer('original')!.getChannelData(0)[12000]);
  await assert.rejects(openWaveformSession({ ...clip, type: 'pattern' }, 120, [4, 4], instance), /real audio clip/);
  await assert.rejects(openWaveformSession({ ...clip, takeGroupId: 'comp' }, 120, [4, 4], instance), /comp/);
  await assert.rejects(openWaveformSession({ ...clip, pitchShiftSemitones: 2 }, 120, [4, 4], instance), /Repitch/);
  await assert.rejects(openWaveformSession({ ...clip, audioBufferId: 'absent' }, 120, [4, 4], instance), /missing/);
  const current = project(); notePlaylistAudioPlaylistRevision(current.playlistClips, []);
  assert.equal(isWaveformSessionCurrent(session, current), false);
});
test('audition emits the selected real PCM at the actual live destination and cancellation stops queued playback', async () => {
  const instance = engine(), context = instance.getContext() as any;
  const source = fixture(2, 4800), audition = new WaveformAudition();
  await audition.play(context, source, 1200, 3600);
  context.processTo(0.06);
  const data = context.exportAsAudioData().channelData;
  for (let channel = 0; channel < 2; channel++) for (let i = 0; i < 2400; i++) assert.ok(Math.abs(data[channel][i] - source.getChannelData(channel)[i + 1200] * 0.8) < 1e-7);
  audition.stop();
  const start = Math.round(context.currentTime * 48000); context.processTo(context.currentTime + 0.1);
  assert.ok(context.exportAsAudioData().channelData[0].slice(start).every((value: number) => value === 0));
});
test('production offline song export consumes edited PCM, not stale source or preview buffers', async () => {
  const instance = engine(); instance.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  installSampleBufferPersistence(instance, { persistAudioClip: async () => {} });
  const source = fixture(2, 19200); instance.setSampleBuffer('original', source);
  const session = await openWaveformSession(clip, 120, [4, 4], instance);
  const edited = editWaveform(session.buffer, { start: 0, end: 19200 }, { type: 'reverse' }, create);
  let updated = clip;
  await commitWaveformSession(session, edited, instance, { isCurrent: () => true, publish(value) { updated = value; } });
  const mixer = [0, 1].map(id => ({ id, name: 'Dry', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 }));
  const render = (value: PlaylistClip) => instance.renderTimelineOffline([], [value], mixer, 120, 1, 48000, true, 'song');
  const actual = await render(updated), original = await render(clip);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference = Math.max(difference, Math.abs(actual.getChannelData(0)[i] - original.getChannelData(0)[i]));
  assert.ok(difference > 0.1, `export waveform difference ${difference}`);
  instance.setSampleBuffer('reference-only', edited);
  const reference = await render({ ...updated, audioBufferId: 'reference-only' });
  assert.deepEqual(actual.getChannelData(0), reference.getChannelData(0));
});
