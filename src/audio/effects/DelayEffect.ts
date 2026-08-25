import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/**
 * Production delay effect with explicit dry/wet mixing and bounded feedback.
 * The feedback path is internal to the effect and is always kept below unity.
 */
export class DelayEffect implements AudioEffect {
  readonly name = 'Delay';
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    readonly id = 'delay',
    delayTime = 0.25,
    feedback = 0.35,
    mix = 0.25,
  ) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.delay = context.createDelay(10);
    this.feedback = context.createGain();

    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.output);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);

    this.setParameter('delayTime', delayTime, context.currentTime);
    this.setParameter('feedback', feedback, context.currentTime);
    this.setParameter('mix', mix, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    this.assertAlive();
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) throw new Error('Effect parameter time must be finite.');

    switch (name) {
      case 'delayTime':
        if (value < 0 || value > 10) {
          throw new RangeError('Delay time must be between 0 and 10 seconds.');
        }
        this.delay.delayTime.setValueAtTime(value, time);
        return;
      case 'feedback':
        if (value < 0 || value >= 0.99) {
          throw new RangeError('Delay feedback must be between 0 and less than 0.99.');
        }
        this.feedback.gain.setValueAtTime(value, time);
        return;
      case 'mix':
        if (value < 0 || value > 1) {
          throw new RangeError('Delay mix must be between 0 and 1.');
        }
        this.dry.gain.setValueAtTime(1 - value, time);
        this.wet.gain.setValueAtTime(value, time);
        return;
      default:
        throw new Error(`Unknown Delay effect parameter: ${name}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.dry.disconnect();
    this.wet.disconnect();
    this.delay.disconnect();
    this.feedback.disconnect();
    this.output.disconnect();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('Delay effect has been disposed.');
  }
}
