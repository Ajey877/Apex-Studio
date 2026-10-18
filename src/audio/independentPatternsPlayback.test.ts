/**
 * Independent patterns — playback, export and MIDI regression coverage.
 *
 * Pre-fix, the Song Mode scheduler ignored `PlaylistClip.patternId` and played
 * the channel's single shared content for every pattern clip, so "Pattern 1"
 * and "Pattern 2" clips on the same instrument were audibly identical (and so
 * were the WAV, stems and MIDI exports, which share the scheduler / mirror it).
 *
 * Every behavioural assertion drives the production path: `audioEngine.play()`
 * -> `AudioClockTransport` -> `triggerCurrentStep` -> `playNote` (live), the
 * same `triggerCurrentStep` inside `renderTimelineOffline` (export), and the
 * real bytes `buildStandardMidiFile` writes, decoded by the production MIDI
 * importer.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport, START_LEAD_SECONDS } from './transport';
import { audioEngine } from './audioEngine';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { MidiParser } from '../utils/midiParser';
import { createDefaultProjectState } from '../state/projectState';
import { addEmptyPatternToProjectState, selectPatternInProjectState } from '../state/patternContent';
import { updateChannelInProjectState } from '../state/projectMutations';
import type { Channel, MixerTrack, Note, PlaylistClip, ProjectState } from '../types/daw';

class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';
  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }
}

class FakeNode {
  gain = { value: 1, setValueAtTime: () => undefined, setTargetAtTime: () => undefined, cancelScheduledValues: () => undefined };
  connect(): void {}
  disconnect(): void {}
}

/** Minimal offline context: the renderer only builds the master graph and renders. */
class FakeOfflineAudioContext {
  readonly destination = new FakeNode();
  readonly sampleRate: number;
  constructor(_channels: number, _length: number, sampleRate: number) { this.sampleRate = sampleRate; }
  createGain(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode & { fftSize: number; smoothingTimeConstant: number } {
    return Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0 });
  }
  async startRendering(): Promise<AudioBuffer> { return { sampleRate: this.sampleRate } as AudioBuffer; }
}

type TimerCallback = () => void;
type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;
const STEP_SECONDS_AT_120_BPM = 0.125;
const realWindow = (globalThis as any).window;
const realOfflineAudioContext = (globalThis as any).OfflineAudioContext;

let timers: TimerCallback[] = [];
let savedInternals: EngineInternals = {};
const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'isPlaying', 'bpm', 'swing', 'metronome',
  'currentStep', 'currentBar', 'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'activePatterns', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers', 'playNote', 'updateMixerTrack',
];

beforeEach(() => {
  timers = [];
  (globalThis as any).window = {
    setTimeout: (callback: TimerCallback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => undefined,
    OfflineAudioContext: undefined,
  };
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
});

afterEach(() => {
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
  (globalThis as any).window = realWindow;
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
});

const note = (id: string, pitch: number, start: number): Note => ({ id, pitch, start, duration: 1, velocity: 0.9 });

/**
 * A one-channel project built through the real pattern transitions:
 * - "Verse" (pat-1, selected): pitch 60 @ step 0 and pitch 62 @ step 8;
 * - "Chorus" (pat-2, stored):  pitch 72 @ step 4.
 */
const buildProject = (): ProjectState => {
  const base = createDefaultProjectState();
  const lead: Channel = {
    ...base.channels[0],
    id: 'ch-lead',
    name: 'Lead',
    instrumentType: 'minisynth',
    steps: new Array(16).fill(false),
    notes: [note('verse-1', 60, 0), note('verse-2', 62, 8)],
  };
  let state: ProjectState = {
    ...base,
    channels: [lead],
    patterns: [{ id: 'pat-1', name: 'Verse', color: '#ff6e00', lengthSteps: 16 }],
    selectedPatternId: 'pat-1',
  };
  state = addEmptyPatternToProjectState(state, { id: 'pat-2', name: 'Chorus', color: '#00bcd4', lengthSteps: 16 });
  state = updateChannelInProjectState(state, 'ch-lead', { notes: [note('chorus-1', 72, 4)] });
  return selectPatternInProjectState(state, 'pat-1');
};

const clip = (id: string, startBar: number, patternId?: string): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar,
  lengthBars: 1,
  type: 'pattern',
  channelId: 'ch-lead',
  color: '#ff6e00',
  name: id,
  ...(patternId ? { patternId } : {}),
});

/** Verse | Chorus | Verse on one lane. */
const arrangement = (): PlaylistClip[] => [clip('c1', 0, 'pat-1'), clip('c2', 1, 'pat-2'), clip('c3', 2, 'pat-1')];

interface Trigger { bar: number; step: number; pitch: number }

const startTake = (state: ProjectState, clips: PlaylistClip[], mode: 'pat' | 'song', withPatterns = true) => {
  timers = [];
  const fakeCtx = new FakeAudioContext();
  engine.ctx = fakeCtx;
  engine.transport = new AudioClockTransport(fakeCtx as unknown as AudioContext, { lookAheadSeconds: 0.1, scheduleIntervalMs: 25 });
  engine.activeVoices = new Map();
  engine.isPlaying = false;
  engine.bpm = 120;
  engine.metronome = false;
  engine.setSwing(0);
  const triggered: Trigger[] = [];
  engine.playNote = (_channel: Channel, played: Note) => {
    triggered.push({ bar: engine.currentBar, step: played.start, pitch: played.pitch });
  };
  engine.play(
    structuredClone(state.channels),
    structuredClone(clips),
    mode,
    state.selectedPatternId,
    [],
    16,
    undefined,
    withPatterns ? state.patterns : undefined,
  );
  return { fakeCtx, triggered };
};

const pumpSteps = (fakeCtx: FakeAudioContext, steps: number): void => {
  const startTick = Math.round((fakeCtx.currentTime - START_LEAD_SECONDS) / STEP_SECONDS_AT_120_BPM);
  for (let tick = startTick; tick <= startTick + steps; tick += 1) {
    fakeCtx.currentTime = START_LEAD_SECONDS + tick * STEP_SECONDS_AT_120_BPM;
    const pending = timers;
    timers = [];
    for (const callback of pending) callback();
  }
};

const summarize = (triggered: Trigger[]): string[] => triggered.map(t => `bar${t.bar}:${t.pitch}@${t.step}`);

const VERSE_CHORUS_VERSE = ['bar1:60@0', 'bar1:62@8', 'bar2:72@4', 'bar3:60@0', 'bar3:62@8'];

describe('Song Mode plays the pattern each clip names', () => {
  it('Verse | Chorus | Verse on ONE channel plays three different bars', () => {
    const state = buildProject();
    const { fakeCtx, triggered } = startTake(state, arrangement(), 'song');
    pumpSteps(fakeCtx, 47);
    assert.deepEqual(summarize(triggered), VERSE_CHORUS_VERSE);
  });

  it('is independent of which pattern is selected when playback starts', () => {
    const state = selectPatternInProjectState(buildProject(), 'pat-2');
    const { fakeCtx, triggered } = startTake(state, arrangement(), 'song');
    pumpSteps(fakeCtx, 47);
    assert.deepEqual(summarize(triggered), VERSE_CHORUS_VERSE);
  });

  it('a pattern clip whose pattern holds nothing for the channel is silent', () => {
    let state = buildProject();
    state = addEmptyPatternToProjectState(state, { id: 'pat-empty', name: 'Empty', color: '#fff', lengthSteps: 16 });
    state = selectPatternInProjectState(state, 'pat-1');
    const { fakeCtx, triggered } = startTake(state, [clip('c1', 0, 'pat-empty'), clip('c2', 1, 'pat-1')], 'song');
    pumpSteps(fakeCtx, 31);
    assert.deepEqual(summarize(triggered), ['bar2:60@0', 'bar2:62@8']);
  });

  it('selecting another pattern mid-song changes nothing the arrangement plays', () => {
    const state = buildProject();
    const { fakeCtx, triggered } = startTake(state, arrangement(), 'song');
    pumpSteps(fakeCtx, 10);
    // The App publishes a selection swap as ONE update carrying both the new
    // live channel content and the patterns that now store the old content.
    const swapped = selectPatternInProjectState(state, 'pat-2');
    engine.synchronizePlaybackState({ channels: swapped.channels, patterns: swapped.patterns });
    pumpSteps(fakeCtx, 37);
    assert.deepEqual(summarize(triggered), VERSE_CHORUS_VERSE);
  });

  it('an edit to a stored pattern reaches the running take', () => {
    const state = buildProject();
    const { fakeCtx, triggered } = startTake(state, arrangement(), 'song');
    pumpSteps(fakeCtx, 4);
    // Edit the Chorus (select it, change it, select the Verse again).
    let edited = selectPatternInProjectState(state, 'pat-2');
    edited = updateChannelInProjectState(edited, 'ch-lead', { notes: [note('chorus-new', 74, 12)] });
    edited = selectPatternInProjectState(edited, 'pat-1');
    engine.synchronizePlaybackState({ channels: edited.channels, patterns: edited.patterns });
    pumpSteps(fakeCtx, 43);
    assert.deepEqual(summarize(triggered), ['bar1:60@0', 'bar1:62@8', 'bar2:74@12', 'bar3:60@0', 'bar3:62@8']);
  });

  it('callers without a pattern model keep the historical contract (live content for every clip)', () => {
    const state = buildProject();
    const { fakeCtx, triggered } = startTake(state, arrangement(), 'song', false);
    pumpSteps(fakeCtx, 47);
    assert.deepEqual(summarize(triggered), ['bar1:60@0', 'bar1:62@8', 'bar2:60@0', 'bar2:62@8', 'bar3:60@0', 'bar3:62@8']);
  });

  it('legacy clips that name no pattern play the live content', () => {
    const state = buildProject();
    const { fakeCtx, triggered } = startTake(state, [clip('legacy', 0), clip('chorus', 1, 'pat-2')], 'song');
    pumpSteps(fakeCtx, 31);
    assert.deepEqual(summarize(triggered), ['bar1:60@0', 'bar1:62@8', 'bar2:72@4']);
  });
});

describe('Pattern Mode plays only the selected pattern', () => {
  it('loops the Verse when the Verse is selected', () => {
    const { fakeCtx, triggered } = startTake(buildProject(), [], 'pat');
    pumpSteps(fakeCtx, 31);
    assert.deepEqual(triggered.map(t => `${t.pitch}@${t.step}`), ['60@0', '62@8', '60@0', '62@8']);
  });

  it('loops the Chorus when the Chorus is selected', () => {
    const { fakeCtx, triggered } = startTake(selectPatternInProjectState(buildProject(), 'pat-2'), [], 'pat');
    pumpSteps(fakeCtx, 31);
    assert.deepEqual(triggered.map(t => `${t.pitch}@${t.step}`), ['72@4', '72@4']);
  });
});

describe('Offline export (WAV / stems) resolves clips exactly like the live take', () => {
  const masterTrack = (): MixerTrack => ({
    id: 0, name: 'Master', color: '#fff', volume: 1, pan: 0, mute: false, solo: false,
    stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [],
  } as MixerTrack);

  const renderSong = async (state: ProjectState, withPatterns: boolean): Promise<string[]> => {
    (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
    engine.ctx = null;
    engine.updateMixerTrack = () => undefined;
    const triggered: Trigger[] = [];
    engine.playNote = (_channel: Channel, played: Note) => {
      triggered.push({ bar: engine.currentBar, step: played.start, pitch: played.pitch });
    };
    await engine.renderTimelineOffline(
      state.channels,
      arrangement(),
      [masterTrack()],
      120,
      3,
      44100,
      false,
      'song',
      undefined,
      undefined,
      undefined,
      undefined,
      withPatterns ? state.patterns : undefined,
    );
    return summarize(triggered);
  };

  it('a song render plays Verse | Chorus | Verse', async () => {
    assert.deepEqual(await renderSong(buildProject(), true), VERSE_CHORUS_VERSE);
  });

  it('the render never leaks its patterns into the live take', async () => {
    engine.activePatterns = [{ id: 'live-sentinel', name: 'Live', color: '#000', lengthSteps: 16 }];
    await renderSong(buildProject(), true);
    assert.deepEqual(engine.activePatterns.map((p: { id: string }) => p.id), ['live-sentinel']);
  });

  it('stems forward the patterns to every per-channel render', async () => {
    (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
    engine.ctx = null;
    engine.updateMixerTrack = () => undefined;
    const triggered: Trigger[] = [];
    engine.playNote = (_channel: Channel, played: Note) => {
      triggered.push({ bar: engine.currentBar, step: played.start, pitch: played.pitch });
    };
    const originalEncode = engine.audioBufferToWav;
    engine.audioBufferToWav = () => new Blob([]);
    try {
      const state = buildProject();
      await engine.renderProjectStems(state.channels, arrangement(), [masterTrack()], 120, 3, 24, 'song', undefined, undefined, false, state.patterns);
    } finally {
      engine.audioBufferToWav = originalEncode;
    }
    // Master mix + the lead stem: both play Verse | Chorus | Verse.
    assert.deepEqual(summarize(triggered), [...VERSE_CHORUS_VERSE, ...VERSE_CHORUS_VERSE]);
  });
});

describe('Standard MIDI export writes each clip from its own pattern', () => {
  const decodeLead = async (blob: Blob) => {
    const tracks = await MidiParser.parseMidiFile(await blob.arrayBuffer());
    const lead = tracks.find(track => track.name === 'Lead');
    assert.ok(lead, 'the Lead track is written');
    return lead.notes.map(n => `${n.pitch}@${n.startStep}`);
  };

  it('a Song export writes Verse | Chorus | Verse', async () => {
    const state = buildProject();
    const blob = buildStandardMidiFile(state.channels, arrangement(), { bpm: 120, timeSignature: [4, 4] }, {
      scope: 'song',
      patterns: state.patterns,
    });
    assert.deepEqual(await decodeLead(blob), ['60@0', '62@8', '72@20', '60@32', '62@40']);
  });

  it('without patterns it keeps the historical output', async () => {
    const state = buildProject();
    const blob = buildStandardMidiFile(state.channels, arrangement(), { bpm: 120, timeSignature: [4, 4] }, { scope: 'song' });
    assert.deepEqual(await decodeLead(blob), ['60@0', '62@8', '60@16', '62@24', '60@32', '62@40']);
  });

  it('a Pattern Loop export writes the selected pattern', async () => {
    const state = selectPatternInProjectState(buildProject(), 'pat-2');
    const blob = buildStandardMidiFile(state.channels, arrangement(), { bpm: 120, timeSignature: [4, 4] }, {
      scope: 'pattern',
      patternLengthSteps: 16,
      patterns: state.patterns,
    });
    assert.deepEqual(await decodeLead(blob), ['72@4', '72@20', '72@36', '72@52']);
  });
});
