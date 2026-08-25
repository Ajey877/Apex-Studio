import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

export type FilterType = BiquadFilterType;

/** Production-safe wrapper around a Web Audio BiquadFilterNode. */
export class BiquadFilterEffect implements AudioEffect {
  readonly name = 'Biquad Filter';
  readonly input: BiquadFilterNode;
  readonly output: BiquadFilterNode;

  constructor(
    private readonly context: AudioContext,
    readonly id = 'filter',
    type: FilterType = 'lowpass',
    frequency = 1000,
    q = 1,
    gain = 0,
  ) {
    this.input = context.createBiquadFilter();
    this.output = this.input;
    this.input.type = type;
    this.setParameter('frequency', frequency, context.currentTime);
    this.setParameter('q', q, context.currentTime);
    this.setParameter('gain', gain, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) throw new Error('Effect parameter time must be finite.');

    switch (name) {
      case 'frequency':
        if (value < 10 || value > this.context.sampleRate / 2) {
          throw new RangeError('Filter frequency must be between 10 Hz and Nyquist.');
        }
        this.input.frequency.setValueAtTime(value, time);
        return;
      case 'q':
        if (value < 0.0001 || value > 1000) {
          throw new RangeError('Filter Q must be between 0.0001 and 1000.');
        }
        this.input.Q.setValueAtTime(value, time);
        return;
      case 'gain':
        if (value < -40 || value > 40) {
          throw new RangeError('Filter gain must be between -40 and 40 dB.');
        }
        this.input.gain.setValueAtTime(value, time);
        return;
      default:
        throw new Error(`Unknown Biquad Filter effect parameter: ${name}`);
    }
  }

  setType(type: FilterType): void {
    this.input.type = type;
  }

  dispose(): void {
    this.input.disconnect();
  }
}
