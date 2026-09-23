import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { createDefaultProjectState } from '../state/projectState';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';

type EngineInternals = {
  ctx: AudioContext | null;
  transport: unknown;
  activeVoices: Map<string, { stop: (time?: number) => void }>;
  isPlaying: boolean;
  activeChannels: Channel[];
  activeClips: PlaylistClip[];
  activeMixerTracks: MixerTrack[];
  playbackProjectChannels: Channel[];
  playbackProjectMixerTracks: MixerTrack[];
  activePlayMode: 'pat' | 'song';
  activePatternId?: string;
  currentStep: number;
  currentBar: number;
  playbackGeneration: number;
  updateMixerTrack: (track: MixerTrack) => void;
  removeMixerChannel: (trackId: number) => void;
  play: (
    channels: Channel[],
    clips: PlaylistClip[],
    mode: 'pat' | 'song',
    patternId?: string,
    mixerTracks?: MixerTrack[],
    patternLengthSteps?: number
  ) => void;
  synchronizePlaybackState: (update: {
    channels?: Channel[];
    clips?: PlaylistClip[];
    mixerTracks?: MixerTrack[];
  }) => void;
};

const engine = audioEngine as unknown as EngineInternals & {
  playNote: (channel: Channel, note: { id: string; pitch: number; start: number; duration: number; velocity: number }, time?: number) => void;
  triggerCurrentStep: (audioTime?: number) => void;
  applyAutomationValue: (
    target: { type: string; targetId: string | number },
    value: number,
    channels: Channel[],
    mixerTracks: MixerTrack[],
    atTime?: number
  ) => void;
};

const savedState: Partial<EngineInternals> = {};
let originalPlayNote: typeof engine.playNote;

const fakeTransport = {
  setBpm: () => undefined,
  setMode: () => undefined,
  setPatternLoopSteps: () => undefined,
  setSongEndSteps: () => undefined,
  setCallbacks: () => undefined,
  start: () => undefined,
  stop: () => undefined,
  pause: () => undefined,
  seek: () => undefined,
  getState: () => ({
    bpm: 120,
    beatsPerBar: 4,
    stepsPerBeat: 4,
    mode: 'pat' as const,
    playing: false,
    positionSeconds: 0,
    step: 0,
    bar: 1,
  }),
};

const makePatternClip = (channelId: string): PlaylistClip => ({
  id: 'pattern-sync-clip',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 1,
  type: 'pattern',
  channelId,
  color: '#ff6e00',
  name: 'Pattern Sync'
});

const makeProjectChannel = (): Channel => {
  const project = createDefaultProjectState();
  const channel = structuredClone(project.channels[0]);
  channel.steps = new Array(16).fill(false);
  channel.notes = [];
  return channel;
};

beforeEach(() => {
  const keys: (keyof EngineInternals)[] = [
    'ctx',
    'transport',
    'activeVoices',
    'isPlaying',
    'activeChannels',
    'activeClips',
    'activeMixerTracks',
    'playbackProjectChannels',
    'playbackProjectMixerTracks',
    'activePlayMode',
    'activePatternId',
    'currentStep',
    'currentBar',
    'playbackGeneration',
    'updateMixerTrack',
    'removeMixerChannel',
  ];
  for (const key of keys) {
    (savedState as unknown as Record<string, unknown>)[key] =
      (engine as unknown as Record<string, unknown>)[key];
  }
  originalPlayNote = engine.playNote;

  engine.ctx = { state: 'running', currentTime: 0 } as AudioContext;
  engine.transport = fakeTransport;
  engine.activeVoices = new Map();
  engine.isPlaying = false;
  engine.currentStep = 0;
  engine.currentBar = 1;
  engine.updateMixerTrack = () => undefined;
  engine.removeMixerChannel = () => undefined;
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  for (const [key, value] of Object.entries(savedState)) {
    (engine as unknown as Record<string, unknown>)[key] = value;
  }
});

describe('active playback state synchronization', () => {
  it('starts from the current project data and keeps the active take isolated', () => {
    const project = createDefaultProjectState();
    const clips: PlaylistClip[] = [makePatternClip(project.channels[0].id)];
    const projectChannels = structuredClone(project.channels);
    const projectMixerTracks = structuredClone(project.mixerTracks);

    engine.play(projectChannels, clips, 'song', project.selectedPatternId, projectMixerTracks);

    assert.deepEqual(engine.activeChannels, projectChannels);
    assert.deepEqual(engine.activeClips, clips);
    assert.deepEqual(engine.activeMixerTracks, projectMixerTracks);
    assert.notEqual(engine.activeChannels, projectChannels);
    assert.notEqual(engine.activeClips, clips);
    assert.notEqual(engine.activeMixerTracks, projectMixerTracks);

    projectChannels[0].steps[0] = !projectChannels[0].steps[0];
    clips[0].startBar = 8;
    projectMixerTracks[0].volume = 0.25;

    assert.notEqual(engine.activeChannels[0].steps[0], projectChannels[0].steps[0]);
    assert.equal(engine.activeClips[0].startBar, 0);
    assert.equal(engine.activeMixerTracks[0].volume, 1);
  });

  it('applies channel and playlist edits to the running take without Stop then Play', () => {
    const channel = makeProjectChannel();
    const initialClip = makePatternClip(channel.id);
    const initialChannels = [channel];
    const initialClips = [initialClip];
    const initialProjectMixerTracks = [structuredClone(createDefaultProjectState().mixerTracks[0])];
    const playedPitches: number[] = [];
    engine.playNote = (_channel, note) => playedPitches.push(note.pitch);

    engine.play(initialChannels, initialClips, 'pat', undefined, initialProjectMixerTracks);

    const editedChannel = structuredClone(channel);
    editedChannel.steps[0] = true;
    engine.synchronizePlaybackState({ channels: [editedChannel] });

    engine.activePlayMode = 'pat';
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    assert.deepEqual(playedPitches, [36]);

    const songChannel = structuredClone(channel);
    songChannel.notes = [{ id: 'song-note', pitch: 72, start: 0, duration: 1, velocity: 0.9 }];
    const songClipAtBarFour = { ...initialClip, startBar: 4, id: 'song-sync-clip' };
    engine.synchronizePlaybackState({ channels: [songChannel], clips: [songClipAtBarFour] });

    engine.activePlayMode = 'song';
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0.5);
    assert.deepEqual(playedPitches, [36]);

    const movedClip = { ...songClipAtBarFour, startBar: 0 };
    engine.synchronizePlaybackState({ clips: [movedClip] });
    engine.triggerCurrentStep(0.75);
    assert.deepEqual(playedPitches, [36, 72]);

    // The caller's project objects remain untouched by playback scheduling.
    assert.equal(channel.steps[0], false);
    assert.equal(initialClip.startBar, 0);
    assert.equal(songClipAtBarFour.startBar, 4);
  });

  it('synchronizes mixer edits while preserving transient automation isolation', () => {
    const project = createDefaultProjectState();
    const channel = structuredClone(project.channels[0]);
    const track = structuredClone(project.mixerTracks[0]);
    engine.play([channel], [], 'pat', undefined, [track]);

    const projectChannelBeforeAutomation = structuredClone(channel);
    const projectTrackBeforeAutomation = structuredClone(track);
    engine.applyAutomationValue(
      { type: 'channel_filter_cutoff', targetId: channel.id },
      0.8,
      engine.activeChannels,
      engine.activeMixerTracks,
      0
    );
    engine.applyAutomationValue(
      { type: 'mixer_vol', targetId: track.id },
      0.2,
      engine.activeChannels,
      engine.activeMixerTracks,
      0
    );

    const editedChannel = { ...channel, notes: [{ id: 'new-note', pitch: 64, start: 0, duration: 1, velocity: 1 }] };
    const editedTrack = { ...track, pan: 0.5 };
    engine.synchronizePlaybackState({ channels: [editedChannel], mixerTracks: [editedTrack] });

    assert.deepEqual(engine.activeChannels[0].notes, editedChannel.notes);
    assert.equal(engine.activeChannels[0].synthParams.filterCutoff, 40 + (0.8 ** 2) * 18000);
    assert.equal(engine.activeMixerTracks[0].pan, 0.5);
    assert.equal(engine.activeMixerTracks[0].volume, 0.25);

    assert.deepEqual(channel, projectChannelBeforeAutomation);
    assert.deepEqual(track, projectTrackBeforeAutomation);
  });

  it('does not leave a deleted automation clip latched in the active take', () => {
    const project = createDefaultProjectState();
    const channel = structuredClone(project.channels[0]);
    const track = structuredClone(project.mixerTracks[0]);
    const automationClip: PlaylistClip = {
      id: 'automation-sync-clip',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 2,
      type: 'automation',
      color: '#00e5ff',
      name: 'Cutoff Automation',
      automationTarget: { type: 'channel_filter_cutoff', targetId: channel.id },
      automationPoints: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }]
    };

    engine.play([channel], [automationClip], 'song', undefined, [track]);
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    assert.equal(engine.activeChannels[0].synthParams.filterCutoff, 40 + (0.1 ** 2) * 18000);

    engine.synchronizePlaybackState({ clips: [] });

    assert.equal(engine.activeChannels[0].synthParams.filterCutoff, channel.synthParams.filterCutoff);
    assert.equal(channel.synthParams.filterCutoff, project.channels[0].synthParams.filterCutoff);
  });
});
