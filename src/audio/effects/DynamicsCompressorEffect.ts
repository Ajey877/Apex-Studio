import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/** Production-safe wrapper around a Web Audio DynamicsCompressorNode. */
export class DynamicsCompressorEffect implements AudioEffect {
  readonly name = 'Dynamics Compressor';
  readonly input: DynamicsCompressorNode;
  readonly output: DynamicsCompressorNode;

  constructor(
    private readonly context: AudioContext,
    readonly id = 'compressor',
    threshold = -24,
    knee = 30,
    ratio = 12,
    attack = 0.003,
    release = 0.25,
  ) {
    this.input = context.createDynamicsCompressor();
    this.output = this.input;
    this.setParameter('threshold', threshold, context.currentTime);
    this.setParameter('knee', knee, context.currentTime);
    this.setParameter('ratio', ratio, context.currentTime);
    this.setParameter('attack', attack, context.currentTime);
    this.setParameter('release', release, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) {
      throw new Error('Effect parameter time must be finite.');
    }

    switch (name) {
      case 'threshold':
        if (value < -100 || value > 0) {
          throw new RangeError('Compressor threshold must be between -100 and 0 dB.');
        }
        this.input.threshold.setValueAtTime(value, time);
        return;
      case 'knee':
        if (value < 0 || value > 40) {
          throw new RangeError('Compressor knee must be between 0 and 40 dB.');
        }
        this.input.knee.setValueAtTime(value, time);
        return;
      case 'ratio':
        if (value < 1 || value > 20) {
          throw new RangeError('Compressor ratio must be between 1 and 20.');
        }
        this.input.ratio.setValueAtTime(value, time);
        return;
      case 'attack':
        if (value < 0 || value > 1) {
          throw new RangeError('Compressor attack must be between 0 and 1 seconds.');
        }
        this.input.attack.setValueAtTime(value, time);
        return;
      case 'release':
        if (value < 0 || value > 1) {
          throw new RangeError('Compressor release must be between 0 and 1 seconds.');
        }
        this.input.release.setValueAtTime(value, time);
        return;
      default:
        throw new Error(`Unknown Dynamics Compressor effect parameter: ${name}`);
    }
  }

  get reduction(): number {
    return this.input.reduction;
  }

  dispose(): void {
    this.input.disconnect();
  }
}
