import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audioEngine, resolvePlayableContentLengthSteps } from './audioEngine';
import type { Channel, Note, PlaylistClip } from '../types/daw';

describe('AudioEngine look-ahead scheduler integration', () => {
  it('uses AudioClockTransport and no longer contains the recursive legacy scheduler', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    assert.match(source, /AudioClockTransport/);
    assert.match(source, /this\.transport\.start\(\)/);
    assert.match(source, /this\.transport\.stop\(\)/);
    assert.match(source, /playbackGeneration/);
    assert.doesNotMatch(source, /const scheduleInterval = \(\) =>/);
    assert.doesNotMatch(source, /setTimeout\(scheduleInterval/);
  });

  it('schedules step audio using the transport-provided audio time', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    assert.match(source, /triggerCurrentStep\(audioTime \+ swingOffsetSeconds\)/);
    assert.match(source, /const now = audioTime \?\? this\.ctx\.currentTime/);
  });
});

describe('resolvePlayableContentLengthSteps', () => {
  it('resolves 16 steps for standard 1-bar channel content', () => {
    const channel = {
      id: 'ch-1',
      steps: Array(16).fill(false),
      notes: [
        { id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
        { id: 'n2', pitch: 64, start: 10, duration: 4, velocity: 0.9 }
      ]
    } as Channel;
    assert.equal(resolvePlayableContentLengthSteps(channel), 16);
  });

  it('resolves 32 steps for 2-bar step sequencer or piano roll content', () => {
    const channelSteps32 = {
      id: 'ch-steps-32',
      steps: Array(32).fill(false),
      notes: []
    } as Channel;
    assert.equal(resolvePlayableContentLengthSteps(channelSteps32), 32);

    const channelNotes32 = {
      id: 'ch-notes-32',
      steps: Array(16).fill(false),
      notes: [
        { id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
        { id: 'n2', pitch: 64, start: 20, duration: 4, velocity: 0.9 }
      ]
    } as Channel;
    assert.equal(resolvePlayableContentLengthSteps(channelNotes32), 32);
  });

  it('resolves 64 steps for 4-bar piano roll progression', () => {
    const channelNotes64 = {
      id: 'ch-notes-64',
      steps: Array(16).fill(false),
      notes: [
        { id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
        { id: 'n2', pitch: 62, start: 16, duration: 4, velocity: 0.9 },
        { id: 'n3', pitch: 64, start: 32, duration: 4, velocity: 0.9 },
        { id: 'n4', pitch: 65, start: 48, duration: 4, velocity: 0.9 }
      ]
    } as Channel;
    assert.equal(resolvePlayableContentLengthSteps(channelNotes64), 64);
  });

  it('respects explicit pattern lengthSteps parameter', () => {
    const channel = { id: 'ch-1', steps: [], notes: [] } as Channel;
    assert.equal(resolvePlayableContentLengthSteps(channel, 32), 32);
    assert.equal(resolvePlayableContentLengthSteps(channel, 64), 64);
  });

  it('falls back safely to 16 steps when channel is empty or undefined', () => {
    assert.equal(resolvePlayableContentLengthSteps(undefined), 16);
    assert.equal(resolvePlayableContentLengthSteps({ id: 'empty', steps: [], notes: [] } as any), 16);
  });
});

describe('Song Mode playback multi-bar scheduling', () => {
  it('reaches multi-bar note positions (> step 15) during playback', () => {
    const engine = audioEngine as any;
    const channel: Channel = {
      id: 'ch-multibar',
      name: 'Synth',
      color: '#00e5ff',
      instrumentType: 'minisynth',
      mixerTrackId: 1,
      volume: 0.9,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      steps: Array(16).fill(false),
      notes: [
        { id: 'n-bar1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
        { id: 'n-bar2', pitch: 64, start: 16, duration: 4, velocity: 0.9 },
        { id: 'n-bar3', pitch: 67, start: 32, duration: 4, velocity: 0.9 },
        { id: 'n-bar4', pitch: 71, start: 48, duration: 4, velocity: 0.9 },
      ],
      synthParams: {} as any
    };

    const clip: PlaylistClip = {
      id: 'clip-multibar',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 4,
      type: 'pattern',
      channelId: 'ch-multibar',
      color: '#00e5ff',
      name: 'Synth Block'
    };

    const originalChannels = engine.activeChannels;
    const originalClips = engine.activeClips;
    const originalPlayMode = engine.activePlayMode;
    const originalPlayNote = engine.playNote;
    const originalBar = engine.currentBar;
    const originalStep = engine.currentStep;
    const originalCtx = engine.ctx;

    const playedNotes: { noteId: string; start: number; pitch: number; bar: number; step: number }[] = [];

    engine.ctx = { currentTime: 0 } as any;
    engine.activeChannels = [channel];
    engine.activeClips = [clip];
    engine.activePlayMode = 'song';
    engine.playNote = (_ch: Channel, note: Note, _time: number) => {
      playedNotes.push({
        noteId: note.id,
        start: note.start,
        pitch: note.pitch,
        bar: engine.currentBar,
        step: engine.currentStep
      });
    };

    try {
      // Bar 1, Step 0 (global step 0) -> note at start 0
      engine.currentBar = 1;
      engine.currentStep = 0;
      engine.triggerCurrentStep(0);

      // Bar 2, Step 0 (global step 16) -> note at start 16 (MUST be reached!)
      engine.currentBar = 2;
      engine.currentStep = 0;
      engine.triggerCurrentStep(0.5);

      // Bar 3, Step 0 (global step 32) -> note at start 32 (MUST be reached!)
      engine.currentBar = 3;
      engine.currentStep = 0;
      engine.triggerCurrentStep(1.0);

      // Bar 4, Step 0 (global step 48) -> note at start 48 (MUST be reached!)
      engine.currentBar = 4;
      engine.currentStep = 0;
      engine.triggerCurrentStep(1.5);

      assert.equal(playedNotes.length, 4);
      assert.equal(playedNotes[0].start, 0);
      assert.equal(playedNotes[0].pitch, 60);
      assert.equal(playedNotes[1].start, 16);
      assert.equal(playedNotes[1].pitch, 64);
      assert.equal(playedNotes[2].start, 32);
      assert.equal(playedNotes[2].pitch, 67);
      assert.equal(playedNotes[3].start, 48);
      assert.equal(playedNotes[3].pitch, 71);
    } finally {
      engine.ctx = originalCtx;
      engine.activeChannels = originalChannels;
      engine.activeClips = originalClips;
      engine.activePlayMode = originalPlayMode;
      engine.playNote = originalPlayNote;
      engine.currentBar = originalBar;
      engine.currentStep = originalStep;
    }
  });

  it('preserves existing 16-step looping behavior for 1-bar channels in a multi-bar clip', () => {
    const engine = audioEngine as any;
    const channel: Channel = {
      id: 'ch-drums-1bar',
      name: 'Kick',
      color: '#ff5722',
      instrumentType: 'drumpad',
      mixerTrackId: 1,
      volume: 0.9,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      steps: [true, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      notes: [],
      synthParams: {} as any
    };

    const clip: PlaylistClip = {
      id: 'clip-drums',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 4,
      type: 'pattern',
      channelId: 'ch-drums-1bar',
      color: '#ff5722',
      name: 'Kick Block'
    };

    const originalChannels = engine.activeChannels;
    const originalClips = engine.activeClips;
    const originalPlayMode = engine.activePlayMode;
    const originalPlayNote = engine.playNote;
    const originalBar = engine.currentBar;
    const originalStep = engine.currentStep;
    const originalCtx = engine.ctx;

    const playedNotes: number[] = [];

    engine.ctx = { currentTime: 0 } as any;
    engine.activeChannels = [channel];
    engine.activeClips = [clip];
    engine.activePlayMode = 'song';
    engine.playNote = () => {
      playedNotes.push((engine.currentBar - 1) * 16 + engine.currentStep);
    };

    try {
      // Step 0 of Bar 1, 2, 3, 4 should all play the 1-bar pattern
      for (let bar = 1; bar <= 4; bar++) {
        engine.currentBar = bar;
        engine.currentStep = 0;
        engine.triggerCurrentStep(bar * 0.5);
      }

      assert.deepEqual(playedNotes, [0, 16, 32, 48]);
    } finally {
      engine.ctx = originalCtx;
      engine.activeChannels = originalChannels;
      engine.activeClips = originalClips;
      engine.activePlayMode = originalPlayMode;
      engine.playNote = originalPlayNote;
      engine.currentBar = originalBar;
      engine.currentStep = originalStep;
    }
  });

  it('respects clip offsetSteps for sliced or trimmed pattern clips', () => {
    const engine = audioEngine as any;
    const channel: Channel = {
      id: 'ch-offset-test',
      name: 'Keys',
      color: '#ffd600',
      instrumentType: 'minisynth',
      mixerTrackId: 1,
      volume: 0.9,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      steps: Array(16).fill(false),
      notes: [
        { id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
        { id: 'n2', pitch: 72, start: 16, duration: 4, velocity: 0.9 }
      ],
      synthParams: {} as any
    };

    // Right half of a sliced clip: startBar = 1 (bar 2), offsetSteps = 16
    const clip: PlaylistClip = {
      id: 'clip-sliced-r',
      trackIndex: 0,
      startBar: 1,
      lengthBars: 1,
      offsetSteps: 16,
      type: 'pattern',
      channelId: 'ch-offset-test',
      color: '#ffd600',
      name: 'Keys Block'
    };

    const originalChannels = engine.activeChannels;
    const originalClips = engine.activeClips;
    const originalPlayMode = engine.activePlayMode;
    const originalPlayNote = engine.playNote;
    const originalBar = engine.currentBar;
    const originalStep = engine.currentStep;
    const originalCtx = engine.ctx;

    const playedPitches: number[] = [];

    engine.ctx = { currentTime: 0 } as any;
    engine.activeChannels = [channel];
    engine.activeClips = [clip];
    engine.activePlayMode = 'song';
    engine.playNote = (_ch: Channel, note: Note) => {
      playedPitches.push(note.pitch);
    };

    try {
      // At bar 2 step 0 (global step 16): clip starts, offset is 16 -> triggers note at start 16 (pitch 72)
      engine.currentBar = 2;
      engine.currentStep = 0;
      engine.triggerCurrentStep(0.5);

      assert.deepEqual(playedPitches, [72]);
    } finally {
      engine.ctx = originalCtx;
      engine.activeChannels = originalChannels;
      engine.activeClips = originalClips;
      engine.activePlayMode = originalPlayMode;
      engine.playNote = originalPlayNote;
      engine.currentBar = originalBar;
      engine.currentStep = originalStep;
    }
  });

  it('triggers audio clips at their start bar and respects mute', () => {
    const engine = audioEngine as any;
    const originalClips = engine.activeClips;
    const originalPlayMode = engine.activePlayMode;
    const originalPlayAudioClipWithFades = engine.playAudioClipWithFades;
    const originalBar = engine.currentBar;
    const originalStep = engine.currentStep;
    const originalCtx = engine.ctx;

    const triggeredClipIds: string[] = [];

    const audioClipActive: PlaylistClip = {
      id: 'audio-clip-1',
      trackIndex: 1,
      startBar: 2, // starts at bar 3 (index 2 * 16 = global step 32)
      lengthBars: 4,
      type: 'audio',
      color: '#00ff88',
      name: 'Vocal Stem'
    };

    const audioClipMuted: PlaylistClip = {
      id: 'audio-clip-muted',
      trackIndex: 2,
      startBar: 2,
      lengthBars: 4,
      type: 'audio',
      color: '#00ff88',
      name: 'Muted Vocal',
      mute: true
    };

    engine.ctx = { currentTime: 0 } as any;
    engine.activeClips = [audioClipActive, audioClipMuted];
    engine.activeChannels = [];
    engine.activePlayMode = 'song';
    engine.playAudioClipWithFades = (c: PlaylistClip) => triggeredClipIds.push(c.id);

    try {
      // Global step 0 (Bar 1, step 0) -> clip start is 32, should not trigger
      engine.currentBar = 1;
      engine.currentStep = 0;
      engine.triggerCurrentStep(0);
      assert.equal(triggeredClipIds.length, 0);

      // Global step 32 (Bar 3, step 0) -> triggers active clip, does NOT trigger muted clip
      engine.currentBar = 3;
      engine.currentStep = 0;
      engine.triggerCurrentStep(1.0);
      assert.deepEqual(triggeredClipIds, ['audio-clip-1']);
    } finally {
      engine.ctx = originalCtx;
      engine.activeClips = originalClips;
      engine.activePlayMode = originalPlayMode;
      engine.playAudioClipWithFades = originalPlayAudioClipWithFades;
      engine.currentBar = originalBar;
      engine.currentStep = originalStep;
    }
  });

  it('evaluates automation clips within their active bar range', () => {
    const engine = audioEngine as any;
    const originalClips = engine.activeClips;
    const originalPlayMode = engine.activePlayMode;
    const originalApplyAutomationValue = engine.applyAutomationValue;
    const originalBar = engine.currentBar;
    const originalStep = engine.currentStep;
    const originalCtx = engine.ctx;

    const appliedValues: number[] = [];

    const autoClip: PlaylistClip = {
      id: 'auto-clip-1',
      trackIndex: 0,
      startBar: 1, // Bar 2 to Bar 4
      lengthBars: 2,
      type: 'automation',
      color: '#00e5ff',
      name: 'Cutoff Auto',
      automationTarget: {
        type: 'channel_filter_cutoff',
        targetId: 'ch-1'
      },
      automationPoints: [
        { x: 0, y: 0.2, tension: 0 },
        { x: 1, y: 0.8, tension: 0 }
      ]
    };

    engine.ctx = { currentTime: 0 } as any;
    engine.activeClips = [autoClip];
    engine.activeChannels = [{ id: 'ch-1', mute: false, steps: [], notes: [] }];
    engine.activeMixerTracks = [];
    engine.activePlayMode = 'song';
    engine.applyAutomationValue = (_target: any, val: number) => appliedValues.push(val);

    try {
      // Bar 1 (before startBar 1) -> not evaluated
      engine.currentBar = 1;
      engine.currentStep = 0;
      engine.triggerCurrentStep(0);
      assert.equal(appliedValues.length, 0);

      // Bar 2 (at startBar 1) -> evaluated at start (y = 0.2)
      engine.currentBar = 2;
      engine.currentStep = 0;
      engine.triggerCurrentStep(0.5);
      assert.equal(appliedValues.length, 1);
      assert.equal(Math.round(appliedValues[0] * 100) / 100, 0.2);

      // Bar 3 (halfway through lengthBars 2) -> evaluated near midpoint (y ≈ 0.5)
      engine.currentBar = 3;
      engine.currentStep = 0;
      engine.triggerCurrentStep(1.0);
      assert.equal(appliedValues.length, 2);
      assert.equal(Math.round(appliedValues[1] * 100) / 100, 0.5);
    } finally {
      engine.ctx = originalCtx;
      engine.activeClips = originalClips;
      engine.activePlayMode = originalPlayMode;
      engine.applyAutomationValue = originalApplyAutomationValue;
      engine.currentBar = originalBar;
      engine.currentStep = originalStep;
    }
  });

});
