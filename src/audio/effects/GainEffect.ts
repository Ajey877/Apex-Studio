import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

export class GainEffect implements AudioEffect {
  readonly id: string;
  readonly name = 'Gain';
  readonly input: GainNode;
  readonly output: GainNode;

  constructor(
    private readonly context: AudioContext,
    id = 'gain',
    initialGain = 1,
  ) {
    this.id = id;
    this.input = context.createGain();
    this.output = context.createGain();
    this.input.connect(this.output);
    this.setParameter('gain', initialGain, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) {
      throw new Error('Effect parameter time must be finite.');
    }

    if (name !== 'gain') {
      throw new Error(`Unknown Gain effect parameter: ${name}`);
    }

    if (value < 0 || value > 4) {
      throw new RangeError('Gain effect gain must be between 0 and 4.');
    }

    this.output.gain.setValueAtTime(value, time);
  }

  dispose(): void {
    this.input.disconnect();
    this.output.disconnect();
  }
}
