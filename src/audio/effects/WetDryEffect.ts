import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/**
 * Wraps an AudioEffect with an explicit, automatable dry/wet mix.
 *
 * The wrapped effect remains responsible for its own parameters. This adapter
 * owns only the parallel dry/wet routing, so effects that do not implement
 * mixing internally can still be composed safely in a serial rack.
 */
export class WetDryEffect implements AudioEffect {
  readonly id: string;
  readonly name: string;
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    readonly effect: AudioEffect,
    mix = 1,
  ) {
    this.id = effect.id;
    this.name = effect.name;
    this.input = context.createGain();
    this.output = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();

    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(effect.input);
    effect.output.connect(this.wet);
    this.wet.connect(this.output);

    this.setParameter('mix', mix, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    this.assertAlive();
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) {
      throw new Error('Effect parameter time must be finite.');
    }

    if (name === 'mix') {
      if (value < 0 || value > 1) {
        throw new RangeError('Effect mix must be between 0 and 1.');
      }
      this.dry.gain.setValueAtTime(1 - value, time);
      this.wet.gain.setValueAtTime(value, time);
      return;
    }

    this.effect.setParameter(name, value, time);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.input.disconnect();
    this.dry.disconnect();
    this.wet.disconnect();
    this.output.disconnect();
    this.effect.input.disconnect();
    this.effect.output.disconnect();
    this.effect.dispose();
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error('Wet/dry effect has been disposed.');
    }
  }
}
