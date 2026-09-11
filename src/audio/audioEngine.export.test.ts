import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { Channel, PlaylistClip, MixerTrack } from '../types/daw';

// --- Web Audio Mock Classes ---

class MockAudioParam {
  value: number;
  events: Array<{ type: string; value: number; time: number; timeConstant?: number }> = [];

  constructor(defaultValue = 1) {
    this.value = defaultValue;
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'setValueAtTime', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'linearRampToValueAtTime', value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    if (value <= 0) {
      throw new RangeError('The parameter can only be ramped to a value strictly greater than zero.');
    }
    this.value = value;
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time });
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): void {
    this.value = value;
    this.events.push({ type: 'setTargetAtTime', value, time, timeConstant });
  }
}

class MockAudioNode {
  readonly connections: unknown[] = [];
  connect(target: unknown): unknown {
    this.connections.push(target);
    return target;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam(1);
}

class MockStereoPannerNode extends MockAudioNode {
  pan = new MockAudioParam(0);
}

class MockAnalyserNode extends MockAudioNode {
  fftSize = 512;
  smoothingTimeConstant = 0.8;
  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(0);
  }
}

class MockBufferSourceNode extends MockAudioNode {
  buffer: any = null;
  playbackRate = new MockAudioParam(1);
  detune = new MockAudioParam(0);
  startCalls: Array<{ when: number; offset: number; duration: number }> = [];
  stopCalls: Array<{ when: number }> = [];

  start(when = 0, offset = 0, duration = 0): void {
    this.startCalls.push({ when, offset, duration });
  }

  stop(when = 0): void {
    this.stopCalls.push({ when });
  }
}

class MockOscillatorNode extends MockAudioNode {
  type: OscillatorType = 'sawtooth';
  frequency = new MockAudioParam(440);
  detune = new MockAudioParam(0);
  startCalls: number[] = [];
  stopCalls: number[] = [];

  start(when = 0): void {
    this.startCalls.push(when);
  }

  stop(when = 0): void {
    this.stopCalls.push(when);
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam(350);
  Q = new MockAudioParam(1);
  gain = new MockAudioParam(0);
}

class MockDelayNode extends MockAudioNode {
  delayTime = new MockAudioParam(0);
}

class MockConvolverNode extends MockAudioNode {
  buffer: any = null;
  normalize = true;
}

class MockWaveShaperNode extends MockAudioNode {
  curve: Float32Array | null = null;
  oversample = 'none';
}

class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(30);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.25);
  reduction = 0;
}

class MockOfflineAudioContext {
  readonly destination = new MockAudioNode();
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  currentTime = 0;

  createdBufferSources: MockBufferSourceNode[] = [];
  createdOscillators: MockOscillatorNode[] = [];
  createdGains: MockGainNode[] = [];
  createdFilters: MockBiquadFilterNode[] = [];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createGain(): MockGainNode {
    const node = new MockGainNode();
    this.createdGains.push(node);
    return node;
  }

  createStereoPanner(): MockStereoPannerNode {
    return new MockStereoPannerNode();
  }

  createAnalyser(): MockAnalyserNode {
    return new MockAnalyserNode();
  }

  createBufferSource(): MockBufferSourceNode {
    const node = new MockBufferSourceNode();
    this.createdBufferSources.push(node);
    return node;
  }

  createOscillator(): MockOscillatorNode {
    const node = new MockOscillatorNode();
    this.createdOscillators.push(node);
    return node;
  }

  createBiquadFilter(): MockBiquadFilterNode {
    const node = new MockBiquadFilterNode();
    this.createdFilters.push(node);
    return node;
  }

  createDelay(): MockDelayNode {
    return new MockDelayNode();
  }

  createConvolver(): MockConvolverNode {
    return new MockConvolverNode();
  }

  createWaveShaper(): MockWaveShaperNode {
    return new MockWaveShaperNode();
  }

  createDynamicsCompressor(): MockDynamicsCompressorNode {
    return new MockDynamicsCompressorNode();
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (ch: number) => data[ch] || new Float32Array(length),
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }

  async startRendering(): Promise<AudioBuffer> {
    const bufferLength = Math.max(1, this.length);
    const data = Array.from({ length: this.numberOfChannels }, () => new Float32Array(bufferLength));
    // Provide non-silent test samples to verify PCM rendering
    data[0][0] = 0.5;
    if (this.numberOfChannels > 1) {
      data[1][0] = 0.5;
    }
    return {
      numberOfChannels: this.numberOfChannels,
      length: bufferLength,
      sampleRate: this.sampleRate,
      duration: bufferLength / this.sampleRate,
      getChannelData: (ch: number) => data[ch] || new Float32Array(bufferLength),
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }
}

// Helper to create test AudioBuffer
function createTestBuffer(durationSeconds = 2, sampleRate = 44100): AudioBuffer {
  const length = Math.ceil(durationSeconds * sampleRate);
  const data = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    data[0][i] = sample;
    data[1][i] = sample;
  }
  return {
    numberOfChannels: 2,
    length,
    sampleRate,
    duration: durationSeconds,
    getChannelData: (ch: number) => data[ch] || new Float32Array(length),
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}

const defaultMixerTracks: MixerTrack[] = [
  {
    id: 0,
    name: 'Master',
    color: '#3b82f6',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  },
  {
    id: 1,
    name: 'Synth Track',
    color: '#10b981',
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [
      {
        id: 'fx-1',
        name: 'Parametric EQ',
        type: 'equalizer',
        enabled: true,
        mix: 1.0,
        params: { lowGain: 0, midGain: 2, highGain: 0 },
      },
    ],
  },
  {
    id: 2,
    name: 'Audio Lane 1',
    color: '#8b5cf6',
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  },
];

const synthChannel: Channel = {
  id: 'ch-synth-1',
  name: 'Lead Synth',
  color: '#10b981',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 0.85,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
  notes: [
    { id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 },
    { id: 'n2', pitch: 64, start: 4, duration: 2, velocity: 0.9 },
  ],
  synthParams: audioEngine.getDefaultSynthParams(),
};

describe('Phase 3A: Render Architecture & Audio Fidelity', () => {
  let prevOfflineCtx: any;

  beforeEach(() => {
    prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  });

  afterEach(() => {
    (globalThis as any).OfflineAudioContext = prevOfflineCtx;
  });

  // --- Requirement 1: Stem export includes audio clips ---
  it('stem export includes both channel clips and unassociated audio clips', async () => {
    const testBuf = createTestBuffer(4);
    audioEngine.setSampleBuffer('test-audio-buf-1', testBuf);

    const clips: PlaylistClip[] = [
      {
        id: 'clip-pat-1',
        name: 'Synth Pattern',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 2,
        type: 'pattern',
        channelId: synthChannel.id,
        color: '#10b981',
      },
      {
        id: 'clip-aud-1',
        name: 'Vocal Take',
        audioName: 'Vocal Take',
        trackIndex: 1, // maps to mixer track 2
        startBar: 0,
        lengthBars: 2,
        type: 'audio',
        audioBufferId: 'test-audio-buf-1',
        color: '#8b5cf6',
      },
    ];

    const result = await audioEngine.renderProjectStems(
      [synthChannel],
      clips,
      defaultMixerTracks,
      120,
      2,
      24
    );

    assert.ok(result.master instanceof Blob, 'Master mix blob must be generated');
    assert.ok(result.stems['ch-synth-1_Lead_Synth.wav'] instanceof Blob, 'Channel stem must be generated');
    assert.ok(result.stems['track_2_Vocal_Take.wav'] instanceof Blob, 'Audio clip stem must be generated');
    assert.equal(Object.keys(result.stems).length, 2, 'Exactly 2 stems must be produced');
  });

  // --- Requirement 2: Stem export uses actual instrument/DSP architecture ---
  it('stem export routes through real instrument synthesis and mixer insert FX', async () => {
    let capturedCtx: MockOfflineAudioContext | null = null;
    class InspectingOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedCtx = this;
      }
    }
    (globalThis as any).OfflineAudioContext = InspectingOfflineContext;

    const clips: PlaylistClip[] = [
      {
        id: 'clip-pat-1',
        name: 'Synth Pattern',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 1,
        type: 'pattern',
        channelId: synthChannel.id,
        color: '#10b981',
      },
    ];

    await audioEngine.renderProjectStems(
      [synthChannel],
      clips,
      defaultMixerTracks,
      120,
      1,
      24
    );

    assert.ok(capturedCtx !== null, 'Offline context must be created');
    // MiniSynth creates osc1 and osc2 per note (dual oscillators) + filter, unlike legacy single osc fallback
    const oscCount = capturedCtx.createdOscillators.length;
    assert.ok(oscCount >= 2, `Expected dual/multi-oscillator real synth voices, found ${oscCount}`);
    // Mixer track 1 has an EQ effect slot, which creates a biquad filter
    assert.ok(capturedCtx.createdFilters.length > 0, 'Mixer insert FX (EQ) must be created in render graph');
  });

  // --- Requirement 3: Mixer volume automation affects offline output ---
  it('mixer volume automation modulates mixer track output gain during offline render', async () => {
    let capturedContexts: MockOfflineAudioContext[] = [];
    class TrackingOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedContexts.push(this);
      }
    }
    (globalThis as any).OfflineAudioContext = TrackingOfflineContext;

    const automationClip: PlaylistClip = {
      id: 'clip-auto-1',
      name: 'Mixer Vol Fade',
      trackIndex: 2,
      startBar: 0,
      lengthBars: 2,
      type: 'automation',
      color: '#f59e0b',
      automationTarget: {
        type: 'mixer_vol',
        targetId: 1, // Target mixer track 1
      },
      automationPoints: [
        { x: 0, y: 1.0 },
        { x: 1, y: 0.1 },
      ],
    };

    const clips: PlaylistClip[] = [
      {
        id: 'clip-pat-1',
        name: 'Synth',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 2,
        type: 'pattern',
        channelId: synthChannel.id,
        color: '#10b981',
      },
      automationClip,
    ];

    await audioEngine.renderTimelineOffline(
      [synthChannel],
      clips,
      defaultMixerTracks,
      120,
      2
    );

    assert.ok(capturedContexts.length > 0);
    const ctx = capturedContexts[0];

    // Find the mixer track 1 output gain node (which receives automation updates across the timeline)
    const track1GainNode = ctx.createdGains.find(g =>
      g.gain.events.filter(e => e.type === 'setTargetAtTime').length > 1
    );
    assert.ok(
      track1GainNode,
      'Mixer track 1 output GainNode must receive multiple setTargetAtTime automation events'
    );

    // Verify the modulation values ramp downwards as defined by the automation curve
    const events = track1GainNode.gain.events.filter(e => e.type === 'setTargetAtTime');
    assert.ok(events.length >= 16, `Expected multiple automation steps, got ${events.length}`);
    // events[0] is initial track volume, events[1] is start of automation curve (y=1.0 -> 1.25), last event is near y=0.1 -> 0.16
    const firstAutomationVal = events[1].value;
    const lastAutomationVal = events[events.length - 1].value;
    assert.ok(
      lastAutomationVal < firstAutomationVal,
      `Expected gain to decrease from ${firstAutomationVal} to ${lastAutomationVal}`
    );

    // Verify unrelated tracks (Master, Track 2) were NOT modulated by Track 1 automation
    const otherTracksWithAutomation = ctx.createdGains.filter(g =>
      g !== track1GainNode && g.gain.events.filter(e => e.type === 'setTargetAtTime').length > 1
    );
    assert.equal(
      otherTracksWithAutomation.length,
      0,
      'Unrelated mixer tracks must maintain their static volume and not be modulated'
    );
  });

  it('offline render without mixer automation maintains static mixer track gain', async () => {
    let capturedContexts: MockOfflineAudioContext[] = [];
    class TrackingOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedContexts.push(this);
      }
    }
    (globalThis as any).OfflineAudioContext = TrackingOfflineContext;

    const clips: PlaylistClip[] = [
      {
        id: 'clip-pat-1',
        name: 'Synth',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 2,
        type: 'pattern',
        channelId: synthChannel.id,
        color: '#10b981',
      },
    ];

    await audioEngine.renderTimelineOffline(
      [synthChannel],
      clips,
      defaultMixerTracks,
      120,
      2
    );

    const ctx = capturedContexts[0];
    // Without automation clips, NO GainNode should have more than 1 setTargetAtTime event (initial setup)
    const autoModulatedGains = ctx.createdGains.filter(g =>
      g.gain.events.filter(e => e.type === 'setTargetAtTime').length > 1
    );
    assert.equal(
      autoModulatedGains.length,
      0,
      'No GainNode should receive runtime automation updates without automation clips'
    );
  });

  it('live automation does not mutate the original mixerTracks object when cloned', () => {
    const prevCtx = (audioEngine as any).ctx;
    (audioEngine as any).ctx = new MockOfflineAudioContext(2, 44100, 44100);
    try {
      const originalTracks: MixerTrack[] = [
        {
          id: 1,
          name: 'Synth Track',
          color: '#10b981',
          volume: 0.9,
          pan: 0,
          mute: false,
          solo: false,
          stereoWidth: 1,
          peakL: 0,
          peakR: 0,
          fxSlots: [],
        },
      ];
      const clonedTracks = structuredClone(originalTracks);
      audioEngine.applyAutomationValue({ type: 'mixer_vol', targetId: 1 }, 0.2, [], clonedTracks, 0);
      audioEngine.applyAutomationValue({ type: 'mixer_pan', targetId: 1 }, 0.75, [], clonedTracks, 0);

      assert.equal(clonedTracks[0].volume, 0.25);
      assert.equal(clonedTracks[0].pan, 0.5);
      assert.equal(originalTracks[0].volume, 0.9, 'Original mixerTracks volume must not be mutated by automation');
      assert.equal(originalTracks[0].pan, 0, 'Original mixerTracks pan must not be mutated by automation');
    } finally {
      (audioEngine as any).ctx = prevCtx;
    }
  });

  // --- Requirement 4: Audio clip offsetSteps changes source playback position ---
  it('audio clip offsetSteps changes AudioBufferSourceNode start offset', async () => {
    let capturedContexts: MockOfflineAudioContext[] = [];
    class TrackingOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedContexts.push(this);
      }
    }
    (globalThis as any).OfflineAudioContext = TrackingOfflineContext;

    const testBuf = createTestBuffer(6);
    audioEngine.setSampleBuffer('offset-buf-1', testBuf);

    // At 120 BPM: 1 beat = 0.5s, 1 step (1/16th) = 0.125s
    // 8 steps = 1.0 second offset
    const clipWithOffset: PlaylistClip = {
      id: 'clip-offset-1',
      name: 'Offset Audio',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 2,
      type: 'audio',
      audioBufferId: 'offset-buf-1',
      offsetSteps: 8,
      color: '#8b5cf6',
    };

    await audioEngine.renderTimelineOffline(
      [],
      [clipWithOffset],
      defaultMixerTracks,
      120,
      2
    );

    const ctx = capturedContexts[0];
    const sourceNode = ctx.createdBufferSources[0];
    assert.ok(sourceNode, 'Buffer source node must be created');
    assert.equal(sourceNode.startCalls.length, 1, 'start() must be called once');
    assert.equal(sourceNode.startCalls[0].offset, 1.0, 'Source offset must be 1.0 second for 8 steps at 120 BPM');
  });

  // --- Requirement 5: Short clip safety ---
  it('short clips and clips shorter than fade durations schedule monotonic safe ramps', async () => {
    let capturedContexts: MockOfflineAudioContext[] = [];
    class TrackingOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedContexts.push(this);
      }
    }
    (globalThis as any).OfflineAudioContext = TrackingOfflineContext;

    const testBuf = createTestBuffer(2);
    audioEngine.setSampleBuffer('short-buf-1', testBuf);

    // At 120 BPM, 1 bar = 2.0s.
    // lengthBars = 0.01 bar = 20ms duration.
    // fadeInBars = 1 bar (2000ms), fadeOutBars = 1 bar (2000ms).
    // Sum of requested fades (4000ms) vastly exceeds 20ms!
    const shortClip: PlaylistClip = {
      id: 'clip-short-1',
      name: 'Super Short Clip',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 0.01,
      type: 'audio',
      audioBufferId: 'short-buf-1',
      fadeInBars: 1,
      fadeOutBars: 1,
      color: '#8b5cf6',
    };

    await audioEngine.renderTimelineOffline(
      [],
      [shortClip],
      defaultMixerTracks,
      120,
      1
    );

    const ctx = capturedContexts[0];
    // Find the gain node created for the clip fade envelope
    const clipGain = ctx.createdGains[ctx.createdGains.length - 1];
    assert.ok(clipGain, 'Clip gain node must exist');

    // Verify all scheduled event timestamps are non-decreasing (monotonic)
    let lastTime = -1;
    for (const ev of clipGain.gain.events) {
      assert.ok(
        ev.time >= lastTime,
        `Event timestamp ${ev.time} must be >= previous timestamp ${lastTime}`
      );
      lastTime = ev.time;
      if (ev.type === 'exponentialRampToValueAtTime') {
        assert.ok(ev.value > 0, 'Exponential ramp value must be strictly positive');
      }
    }
  });

  // --- Requirement 6: Zero and negative duration clips do not crash ---
  it('zero and negative duration clips do not crash the renderer or schedule nodes', async () => {
    let capturedContexts: MockOfflineAudioContext[] = [];
    class TrackingOfflineContext extends MockOfflineAudioContext {
      constructor(c: number, l: number, s: number) {
        super(c, l, s);
        capturedContexts.push(this);
      }
    }
    (globalThis as any).OfflineAudioContext = TrackingOfflineContext;

    const testBuf = createTestBuffer(2);
    audioEngine.setSampleBuffer('zero-buf', testBuf);

    const invalidClips: PlaylistClip[] = [
      {
        id: 'clip-zero',
        name: 'Zero Clip',
        trackIndex: 1,
        startBar: 0,
        lengthBars: 0,
        type: 'audio',
        audioBufferId: 'zero-buf',
        color: '#8b5cf6',
      },
      {
        id: 'clip-neg',
        name: 'Neg Clip',
        trackIndex: 1,
        startBar: 0,
        lengthBars: -1,
        type: 'audio',
        audioBufferId: 'zero-buf',
        color: '#8b5cf6',
      },
      {
        id: 'clip-nan',
        name: 'NaN Clip',
        trackIndex: 1,
        startBar: 0,
        lengthBars: NaN,
        type: 'audio',
        audioBufferId: 'zero-buf',
        color: '#8b5cf6',
      },
    ];

    const buffer = await audioEngine.renderTimelineOffline(
      [],
      invalidClips,
      defaultMixerTracks,
      120,
      1
    );

    assert.ok(buffer, 'Renderer must complete successfully');
    const ctx = capturedContexts[0];
    assert.equal(
      ctx.createdBufferSources.length,
      0,
      'No buffer sources should be created for zero/negative length clips'
    );
  });

  // --- Requirement 7: Missing audio buffer throws clear error ---
  it('missing audio buffer throws an explicit descriptive error', async () => {
    const clipWithMissingBuffer: PlaylistClip = {
      id: 'clip-missing',
      name: 'Missing Take',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 1,
      type: 'audio',
      audioBufferId: 'non-existent-buffer-id',
      color: '#8b5cf6',
    };

    await assert.rejects(
      async () => {
        await audioEngine.renderTimelineOffline(
          [],
          [clipWithMissingBuffer],
          defaultMixerTracks,
          120,
          1
        );
      },
      (err: Error) => {
        assert.match(err.message, /Missing audio buffer for clip "Missing Take"/);
        assert.match(err.message, /non-existent-buffer-id/);
        return true;
      }
    );
  });

  // --- Requirement 8: Existing timeline rendering remains functional ---
  it('full timeline master mix offline render succeeds and produces valid AudioBuffer', async () => {
    const testBuf = createTestBuffer(4);
    audioEngine.setSampleBuffer('timeline-buf', testBuf);

    const clips: PlaylistClip[] = [
      {
        id: 'clip-p',
        name: 'Pattern',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 2,
        type: 'pattern',
        channelId: synthChannel.id,
        color: '#10b981',
      },
      {
        id: 'clip-a',
        name: 'Audio',
        trackIndex: 1,
        startBar: 0,
        lengthBars: 2,
        type: 'audio',
        audioBufferId: 'timeline-buf',
        color: '#8b5cf6',
      },
    ];

    const buffer = await audioEngine.renderTimelineOffline(
      [synthChannel],
      clips,
      defaultMixerTracks,
      120,
      2
    );

    assert.equal(buffer.sampleRate, 44100);
    assert.equal(buffer.numberOfChannels, 2);
    assert.ok(buffer.length > 0);
  });


  it('imported audio clip immediately renders to offline master mix without application restart', async () => {
    const importedBufferId = 'imported-asset-test';
    const testBuf = createTestBuffer(4);
    audioEngine.setSampleBuffer(importedBufferId, testBuf);

    const importedClip: PlaylistClip = {
      id: 'clip-imported-1',
      name: 'Imported Audio',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 2,
      type: 'audio',
      audioBufferId: importedBufferId,
      audioUnavailable: false,
      color: '#8b5cf6',
    };

    const buffer = await audioEngine.renderTimelineOffline(
      [],
      [importedClip],
      defaultMixerTracks,
      120,
      2
    );

    assert.ok(buffer);
    assert.equal(buffer.sampleRate, 44100);
    assert.equal(buffer.numberOfChannels, 2);
    assert.ok(buffer.length > 0);
  });

  // ==================================================
  // ATTACK TEST SUITE
  // ==================================================
  describe('Attack Tests', () => {
    it('Attack: 1ms audio clip renders without exception', async () => {
      const testBuf = createTestBuffer(1);
      audioEngine.setSampleBuffer('1ms-buf', testBuf);
      // At 120 BPM (1 bar = 2s), 1ms is 0.0005 bars
      const clip: PlaylistClip = {
        id: 'clip-1ms',
        name: '1ms Clip',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 0.0005,
        type: 'audio',
        audioBufferId: '1ms-buf',
        color: '#8b5cf6',
      };

      const buf = await audioEngine.renderTimelineOffline([], [clip], defaultMixerTracks, 120, 1);
      assert.ok(buf);
    });

    it('Attack: 10ms audio clip renders without exception', async () => {
      const testBuf = createTestBuffer(1);
      audioEngine.setSampleBuffer('10ms-buf', testBuf);
      // At 120 BPM, 10ms is 0.005 bars
      const clip: PlaylistClip = {
        id: 'clip-10ms',
        name: '10ms Clip',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 0.005,
        type: 'audio',
        audioBufferId: '10ms-buf',
        color: '#8b5cf6',
      };

      const buf = await audioEngine.renderTimelineOffline([], [clip], defaultMixerTracks, 120, 1);
      assert.ok(buf);
    });

    it('Attack: 50ms audio clip renders without exception', async () => {
      const testBuf = createTestBuffer(1);
      audioEngine.setSampleBuffer('50ms-buf', testBuf);
      // At 120 BPM, 50ms is 0.025 bars
      const clip: PlaylistClip = {
        id: 'clip-50ms',
        name: '50ms Clip',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 0.025,
        type: 'audio',
        audioBufferId: '50ms-buf',
        color: '#8b5cf6',
      };

      const buf = await audioEngine.renderTimelineOffline([], [clip], defaultMixerTracks, 120, 1);
      assert.ok(buf);
    });

    it('Attack: long audio clip (32 bars) renders safely', async () => {
      const testBuf = createTestBuffer(64);
      audioEngine.setSampleBuffer('long-buf', testBuf);
      const clip: PlaylistClip = {
        id: 'clip-long',
        name: 'Long Clip',
        trackIndex: 0,
        startBar: 0,
        lengthBars: 32,
        type: 'audio',
        audioBufferId: 'long-buf',
        color: '#8b5cf6',
      };

      const buf = await audioEngine.renderTimelineOffline([], [clip], defaultMixerTracks, 120, 32);
      assert.ok(buf);
    });

    it('Attack: multiple audio clips in one stem/track render without interference', async () => {
      const testBuf = createTestBuffer(4);
      audioEngine.setSampleBuffer('multi-buf', testBuf);
      const clips: PlaylistClip[] = [
        {
          id: 'clip-m1',
          name: 'Take 1',
          trackIndex: 1,
          startBar: 0,
          lengthBars: 2,
          type: 'audio',
          audioBufferId: 'multi-buf',
          color: '#8b5cf6',
        },
        {
          id: 'clip-m2',
          name: 'Take 2',
          trackIndex: 1,
          startBar: 2,
          lengthBars: 2,
          type: 'audio',
          audioBufferId: 'multi-buf',
          color: '#8b5cf6',
        },
      ];

      const { stems } = await audioEngine.renderProjectStems([], clips, defaultMixerTracks, 120, 4);
      assert.ok(stems['track_2_Take_1.wav'] instanceof Blob);
    });

    it('Attack: audio and instrument clips on same track channel render safely', async () => {
      const testBuf = createTestBuffer(2);
      audioEngine.setSampleBuffer('combo-buf', testBuf);
      const clips: PlaylistClip[] = [
        {
          id: 'clip-combo-pat',
          name: 'Pattern Clip',
          trackIndex: 0,
          startBar: 0,
          lengthBars: 2,
          type: 'pattern',
          channelId: synthChannel.id,
          color: '#10b981',
        },
        {
          id: 'clip-combo-aud',
          name: 'Audio Clip',
          trackIndex: 0,
          startBar: 2,
          lengthBars: 2,
          type: 'audio',
          channelId: synthChannel.id,
          audioBufferId: 'combo-buf',
          color: '#8b5cf6',
        },
      ];

      const { stems, master } = await audioEngine.renderProjectStems(
        [synthChannel],
        clips,
        defaultMixerTracks,
        120,
        4
      );

      assert.ok(master instanceof Blob);
      assert.ok(stems['ch-synth-1_Lead_Synth.wav'] instanceof Blob);
    });

    it('Attack: heavy FX chain on mixer track renders without errors', async () => {
      const heavyMixerTracks: MixerTrack[] = [
        defaultMixerTracks[0],
        {
          id: 1,
          name: 'Heavy FX Track',
          color: '#e11d48',
          volume: 0.9,
          pan: 0,
          mute: false,
          solo: false,
          stereoWidth: 1,
          peakL: 0,
          peakR: 0,
          fxSlots: [
            { id: 'fx-eq', name: 'EQ', type: 'equalizer', enabled: true, mix: 1, params: {} },
            { id: 'fx-comp', name: 'Compressor', type: 'compressor', enabled: true, mix: 1, params: {} },
            { id: 'fx-dist', name: 'Distortion', type: 'distortion', enabled: true, mix: 1, params: {} },
            { id: 'fx-delay', name: 'Delay', type: 'delay', enabled: true, mix: 1, params: {} },
            { id: 'fx-verb', name: 'Reverb', type: 'reverb', enabled: true, mix: 1, params: {} },
          ],
        },
      ];

      const clips: PlaylistClip[] = [
        {
          id: 'clip-heavy',
          name: 'Heavy Clip',
          trackIndex: 0,
          startBar: 0,
          lengthBars: 2,
          type: 'pattern',
          channelId: synthChannel.id,
          color: '#10b981',
        },
      ];

      const { stems } = await audioEngine.renderProjectStems(
        [synthChannel],
        clips,
        heavyMixerTracks,
        120,
        2
      );

      assert.ok(stems['ch-synth-1_Lead_Synth.wav'] instanceof Blob);
    });

    it('Attack: rapid repeated stem exports do not corrupt state or crash', async () => {
      const clips: PlaylistClip[] = [
        {
          id: 'clip-rep',
          name: 'Rep Clip',
          trackIndex: 0,
          startBar: 0,
          lengthBars: 1,
          type: 'pattern',
          channelId: synthChannel.id,
          color: '#10b981',
        },
      ];

      for (let i = 0; i < 5; i++) {
        const result = await audioEngine.renderProjectStems(
          [synthChannel],
          clips,
          defaultMixerTracks,
          120,
          1
        );
        assert.ok(result.master instanceof Blob);
      }
    });

    it('Attack: empty project with 0 channels and 0 clips exports safely', async () => {
      const result = await audioEngine.renderProjectStems([], [], defaultMixerTracks, 120, 2);
      assert.ok(result.master instanceof Blob);
      assert.equal(Object.keys(result.stems).length, 0);
    });

    it('Attack: project with many clips (50 clips) renders without resource exhaustion', async () => {
      const testBuf = createTestBuffer(1);
      audioEngine.setSampleBuffer('many-buf', testBuf);

      const manyClips: PlaylistClip[] = [];
      for (let i = 0; i < 25; i++) {
        manyClips.push({
          id: `clip-pat-${i}`,
          name: `Pat ${i}`,
          trackIndex: 0,
          startBar: i % 8,
          lengthBars: 1,
          type: 'pattern',
          channelId: synthChannel.id,
          color: '#10b981',
        });
        manyClips.push({
          id: `clip-aud-${i}`,
          name: `Aud ${i}`,
          trackIndex: 1,
          startBar: i % 8,
          lengthBars: 1,
          type: 'audio',
          audioBufferId: 'many-buf',
          color: '#8b5cf6',
        });
      }

      const result = await audioEngine.renderProjectStems(
        [synthChannel],
        manyClips,
        defaultMixerTracks,
        120,
        8
      );

      assert.ok(result.master instanceof Blob);
      assert.ok(result.stems['ch-synth-1_Lead_Synth.wav'] instanceof Blob);
      assert.ok(result.stems['track_2_Aud_0.wav'] instanceof Blob);
    });
  });
});
