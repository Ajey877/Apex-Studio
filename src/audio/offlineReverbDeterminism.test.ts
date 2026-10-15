import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { MixerTrack } from '../types/daw';

/**
 * Audio Integrity Fix 4 — offline reverb determinism on the NATIVE FX path.
 *
 * PR #230 unified the FX-chain factory on `createEffect`
 * (liveFxChainHardening.ts) and removed the `installLiveFxChainHardening`
 * bootstrap from `src/main.tsx`. The native `rebuildTrackFxChain` /
 * `createFxNode` call sites passed `undefined` for the reverb impulse, so
 * `createReverb` fell back to a `Math.random()` impulse even for offline
 * renders — breaking the engine's byte-identical-export contract
 * (see exportParity.test.ts) and making the browser send→return reverb
 * test intermittent.
 *
 * This file deliberately does NOT call `installLiveFxChainHardening`:
 * production no longer installs it, so regression coverage must exercise
 * the native path exactly as `main.tsx` leaves it. (The pre-existing
 * convolver test in exportParity.test.ts installs the patch, which is why
 * it could not catch this regression.)
 *
 * The mock surface below mirrors exportParity.test.ts so a failure points
 * at the shared seam.
 */

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
  addEventListener(): void {}
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
  createdConvolvers: MockConvolverNode[] = [];
  createdDelays: MockDelayNode[] = [];

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
    const node = new MockDelayNode();
    this.createdDelays.push(node);
    return node;
  }

  createConvolver(): MockConvolverNode {
    const node = new MockConvolverNode();
    this.createdConvolvers.push(node);
    return node;
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

function firstDiffIndex(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

const mixerTracksWithReverb: MixerTrack[] = [
  {
    id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false, solo: false,
    stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [],
  },
  {
    id: 1, name: 'Audio Lane 1', color: '#8b5cf6', volume: 0.8, pan: 0, mute: false, solo: false,
    stereoWidth: 1, peakL: 0, peakR: 0,
    fxSlots: [{
      id: 'fix4-reverb', type: 'reverb' as const, name: 'Fix 4 Reverb',
      enabled: true, mix: 0.5, params: {},
    }],
  },
];

describe('Audio Integrity Fix 4: native offline reverb determinism (no hardening patch)', () => {
  let prevOfflineCtx: any;

  beforeEach(() => {
    prevOfflineCtx = (globalThis as any).OfflineAudioContext;
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  });

  afterEach(() => {
    (globalThis as any).OfflineAudioContext = prevOfflineCtx;
  });

  async function captureNativeConvolverImpulse(): Promise<{ left: Float32Array; right: Float32Array }> {
    const previousOfflineAudioContext = (globalThis as any).OfflineAudioContext;
    let capturedContext: MockOfflineAudioContext | undefined;
    class CapturingOfflineAudioContext extends MockOfflineAudioContext {
      constructor(channels: number, length: number, sampleRate: number) {
        super(channels, length, sampleRate);
        capturedContext = this;
      }
    }

    (globalThis as any).OfflineAudioContext = CapturingOfflineAudioContext;
    try {
      await audioEngine.renderTimelineOffline(
        [],
        [],
        mixerTracksWithReverb,
        120,
        1,
        undefined,
        true,
        'song',
        undefined,
        undefined,
        []
      );
    } finally {
      (globalThis as any).OfflineAudioContext = previousOfflineAudioContext;
    }

    assert.ok(capturedContext, 'offline render must construct a capturing OfflineAudioContext');
    assert.equal(capturedContext!.createdConvolvers.length, 1, 'the enabled reverb slot must build exactly one ConvolverNode');
    const convolver = capturedContext!.createdConvolvers[0];
    assert.ok(convolver.buffer, 'the native reverb factory must assign ConvolverNode.buffer');
    const impulse = convolver.buffer as AudioBuffer;
    return {
      left: new Float32Array(impulse.getChannelData(0)),
      right: new Float32Array(impulse.getChannelData(1)),
    };
  }

  it('assigns identical non-zero impulses to the actual reverb convolvers across repeated offline renders', async () => {
    const first = await captureNativeConvolverImpulse();
    const second = await captureNativeConvolverImpulse();

    const firstMismatchLeft = firstDiffIndex(first.left, second.left);
    const firstMismatchRight = firstDiffIndex(first.right, second.right);

    assert.equal(
      firstMismatchLeft,
      -1,
      firstMismatchLeft === -1
        ? ''
        : `Native-path ConvolverNode left impulses diverged at sample ${firstMismatchLeft}: ${first.left[firstMismatchLeft]} vs ${second.left[firstMismatchLeft]}`
    );
    assert.equal(
      firstMismatchRight,
      -1,
      firstMismatchRight === -1
        ? ''
        : `Native-path ConvolverNode right impulses diverged at sample ${firstMismatchRight}: ${first.right[firstMismatchRight]} vs ${second.right[firstMismatchRight]}`
    );

    const impulseEnergy = (channel: Float32Array) => channel.reduce((energy, sample) => energy + sample * sample, 0);
    assert.ok(
      impulseEnergy(first.left) + impulseEnergy(first.right) > 0,
      'the impulse assigned to the actual ConvolverNode must contain non-zero energy'
    );
  });

  it('does not expose the seeded offline impulse to the live path', async () => {
    await captureNativeConvolverImpulse();

    assert.equal(audioEngine.isOfflineRendering, false, 'offline render must restore live mode on exit');
    assert.equal(
      audioEngine.getOfflineReverbImpulseResponse(),
      undefined,
      'live (non-offline) callers must keep receiving no offline impulse, preserving per-chain live reverb behaviour'
    );
  });
});
