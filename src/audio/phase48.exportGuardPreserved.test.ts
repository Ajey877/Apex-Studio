/**
 * Phase 48 — the Phase 8B export guard must survive the publication invariant.
 *
 * Phase 48 stops the UI from publishing `type: 'audio'` clips that have no
 * `audioBufferId`, and flags any already-persisted one as `audioUnavailable`
 * so the Phase 8C banner explains it. Neither change may weaken the renderer:
 * a genuinely unresolvable audio asset must STILL fail `renderTimelineOffline`
 * and `renderProjectStems` instead of rendering a misleading silent WAV.
 *
 * Same mock approach as `audioEngine.export.test.ts` / `exportStemIntegrity.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';
import { normalizeProjectState } from '../state/projectState';

class MockAudioParam {
  value: number;
  constructor(defaultValue = 1) { this.value = defaultValue; }
  setValueAtTime(v: number) { this.value = v; }
  linearRampToValueAtTime(v: number) { this.value = v; }
  exponentialRampToValueAtTime(v: number) { this.value = v; }
  setTargetAtTime(v: number) { this.value = v; }
  cancelScheduledValues() {}
}

class MockAudioNode {
  connect(target: unknown) { return target; }
  disconnect() {}
  addEventListener() {}
  removeEventListener() {}
}

class MockGainNode extends MockAudioNode { gain = new MockAudioParam(1); }
class MockStereoPannerNode extends MockAudioNode { pan = new MockAudioParam(0); }
class MockAnalyserNode extends MockAudioNode {
  fftSize = 512;
  smoothingTimeConstant = 0.8;
  getFloatTimeDomainData(target: Float32Array) { target.fill(0); }
}
class MockBufferSourceNode extends MockAudioNode {
  buffer: unknown = null;
  playbackRate = new MockAudioParam(1);
  detune = new MockAudioParam(0);
  start() {}
  stop() {}
}
class MockOscillatorNode extends MockAudioNode {
  type = 'sawtooth';
  frequency = new MockAudioParam(440);
  detune = new MockAudioParam(0);
  start() {}
  stop() {}
}
class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam(350);
  Q = new MockAudioParam(1);
  gain = new MockAudioParam(0);
}
class MockDelayNode extends MockAudioNode { delayTime = new MockAudioParam(0); }
class MockConvolverNode extends MockAudioNode { buffer: unknown = null; normalize = true; }
class MockWaveShaperNode extends MockAudioNode { curve: Float32Array | null = null; oversample = 'none'; }
class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(30);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.25);
  reduction = 0;
}
class MockAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private data: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(ch: number) { return this.data[ch] ?? this.data[0]; }
  copyToChannel(src: Float32Array, ch: number) { this.getChannelData(ch).set(src); }
  copyFromChannel(dest: Float32Array, ch: number) { dest.set(this.getChannelData(ch)); }
}

let offlineContextConstructions = 0;

class MockOfflineAudioContext {
  sampleRate: number;
  length: number;
  destination = new MockGainNode();
  currentTime = 0;
  state = 'suspended';
  constructor(_channels: number, length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    offlineContextConstructions += 1;
  }
  createGain() { return new MockGainNode(); }
  createStereoPanner() { return new MockStereoPannerNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
  createBufferSource() { return new MockBufferSourceNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDelay() { return new MockDelayNode(); }
  createConvolver() { return new MockConvolverNode(); }
  createWaveShaper() { return new MockWaveShaperNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createChannelSplitter() { return new MockAudioNode(); }
  createChannelMerger() { return new MockAudioNode(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
  async startRendering() { return new MockAudioBuffer(2, this.length, this.sampleRate); }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

const mixerTracks = [
  { id: 0, name: 'Master', volume: 0.9, pan: 0, mute: false, solo: false, fxSlots: [], sends: [] },
  { id: 1, name: 'Track 1', volume: 0.9, pan: 0, mute: false, solo: false, fxSlots: [], sends: [] },
] as unknown as MixerTrack[];

const channel = {
  id: 'ch-1',
  name: 'Kick',
  volume: 0.9,
  pan: 0,
  mute: false,
  solo: false,
  color: '#ff6e00',
  instrumentType: 'drumpad',
  steps: [true, false, false, false],
  notes: [],
  mixerTrackId: 1,
  synthParams: {},
} as unknown as Channel;

const patternClip = {
  id: 'clip-pattern',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  channelId: 'ch-1',
  color: '#ff6e00',
  name: 'Kick Pattern',
} as unknown as PlaylistClip;

const audioClipWithId = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-audio',
  trackIndex: 1,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#00ff88',
  name: 'Audio Take',
  audioBufferId: 'some-buffer',
  ...overrides,
});

const previousOfflineContext = (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext;

const withMockOfflineContext = async (run: () => Promise<void>): Promise<void> => {
  (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = MockOfflineAudioContext;
  offlineContextConstructions = 0;
  try {
    await run();
  } finally {
    (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = previousOfflineContext;
  }
};

/** A legacy project holding the exact clip the old "Audio Stem" producer built. */
const legacyPlaceholderClip = (): PlaylistClip => ({
  id: 'audio-clip-1700000000000',
  trackIndex: 1,
  startBar: 4,
  lengthBars: 4,
  type: 'audio',
  color: '#00ff88',
  name: 'Audio Stem / Vocal',
  fadeInBars: 0.25,
  fadeOutBars: 0.5,
  audioWaveform: [0.1, 0.4, 0.8, 0.6, 0.9, 0.7],
});

const normalizedLegacyProject = () => normalizeProjectState({
  meta: {
    id: 'proj-legacy',
    name: 'Legacy',
    author: 'Audit',
    bpm: 128,
    timeSignature: [4, 4],
    swing: 0,
    masterVolume: 1,
    masterPitch: 0,
    created: 1,
    updated: 1,
    version: '1',
  },
  patterns: [{ id: 'pat-1', name: 'Pattern 1', color: '#ff6e00', lengthSteps: 16 }],
  channels: [channel],
  playlistClips: [patternClip, legacyPlaceholderClip()],
  recordings: [],
});

test('Phase 48: renderTimelineOffline still rejects a clip with no audioBufferId', async () => {
  await withMockOfflineContext(async () => {
    await assert.rejects(
      async () => {
        await audioEngine.renderTimelineOffline([channel], [patternClip, legacyPlaceholderClip()], mixerTracks, 128, 8);
      },
      (error: Error) => {
        assert.match(error.message, /Audio clip "Audio Stem \/ Vocal" is missing an audioBufferId/);
        return true;
      }
    );
    assert.equal(offlineContextConstructions, 0, 'a rejected export must not build an offline context');
  });
});

test('Phase 48: renderProjectStems still rejects a clip with no audioBufferId', async () => {
  await withMockOfflineContext(async () => {
    await assert.rejects(
      async () => {
        await audioEngine.renderProjectStems([channel], [patternClip, legacyPlaceholderClip()], mixerTracks, 128, 8, 24);
      },
      (error: Error) => {
        assert.match(error.message, /Audio clip "Audio Stem \/ Vocal" is missing an audioBufferId/);
        return true;
      }
    );
  });
});

test('Phase 48: the legacy-recovery audioUnavailable flag does not bypass the export guard', async () => {
  const legacyClip = normalizedLegacyProject().playlistClips.find(clip => clip.id === 'audio-clip-1700000000000');
  assert.equal(legacyClip?.audioUnavailable, true, 'precondition: legacy recovery flagged the clip');

  await withMockOfflineContext(async () => {
    // The flag adds an explanation; it never makes the clip exportable. The
    // missing-id branch of the Phase 8B guard is the one that fires first.
    await assert.rejects(
      async () => {
        await audioEngine.renderTimelineOffline([channel], [patternClip, legacyClip!], mixerTracks, 128, 8);
      },
      (error: Error) => {
        assert.match(error.message, /Audio clip "Audio Stem \/ Vocal" is missing an audioBufferId/);
        return true;
      }
    );
    assert.equal(offlineContextConstructions, 0);
  });
});

test('Phase 48: a hydration-flagged clip that does have an id still fails export too', async () => {
  // The genuine Phase 8C case: a real asset id whose blob could not be
  // restored. Publishable under the Phase 48 invariant, unexportable by design.
  const unavailable = audioClipWithId({ audioBufferId: 'lost-asset', audioUnavailable: true });

  await withMockOfflineContext(async () => {
    await assert.rejects(
      async () => {
        await audioEngine.renderTimelineOffline([channel], [patternClip, unavailable], mixerTracks, 128, 8);
      },
      (error: Error) => {
        assert.match(error.message, /references an unavailable audio asset/);
        return true;
      }
    );
    assert.equal(offlineContextConstructions, 0);
  });
});

test('Phase 48: a clip with a real registered buffer still exports successfully', async () => {
  const bufferId = 'phase48-real-buffer';
  const buffer = new MockAudioBuffer(2, 44100, 44100) as unknown as AudioBuffer;
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i / 10) * 0.5;
  audioEngine.setSampleBuffer(bufferId, buffer);

  const validClip = { ...legacyPlaceholderClip(), id: 'clip-real', audioBufferId: bufferId };

  await withMockOfflineContext(async () => {
    const rendered = await audioEngine.renderTimelineOffline([channel], [patternClip, validClip], mixerTracks, 128, 4);
    assert.ok(rendered, 'a valid audio clip must still render');
    assert.ok(offlineContextConstructions > 0, 'a valid export builds an offline context');
  });
});
