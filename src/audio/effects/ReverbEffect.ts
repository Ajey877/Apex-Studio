import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

const DELAYS_SECONDS = [0.0297, 0.0371, 0.0437, 0.0531] as const;
const MAX_DECAY = 0.97;

/**
 * Deterministic Schroeder-style reverb built from bounded Web Audio delay
 * lines. All user-facing parameters are scheduled through AudioParam so the
 * effect remains automation-friendly and never creates a feedback gain >= 1.
 */
export class ReverbEffect implements AudioEffect {
  readonly id: string;
  readonly name = 'Reverb';
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly delayLines: DelayNode[];
  private readonly feedbackGains: GainNode[];
  private readonly mixGains: GainNode[];
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    id = 'reverb',
    initialWet = 0.25,
    initialDry = 0.75,
    initialDecay = 0.65,
  ) {
    this.id = id;
    this.input = context.createGain();
    this.output = context.createGain();
    this.dryGain = context.createGain();
    this.wetGain = context.createGain();

    this.delayLines = DELAYS_SECONDS.map((delay) => {
      const node = context.createDelay(2);
      node.delayTime.setValueAtTime(delay, context.currentTime);
      return node;
    });
    this.feedbackGains = this.delayLines.map(() => context.createGain());
    this.mixGains = this.delayLines.map(() => context.createGain());

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.delayLines.forEach((delay, index) => {
      const feedback = this.feedbackGains[index];
      const mix = this.mixGains[index];
      this.wetGain.connect(delay);
      delay.connect(mix);
      mix.connect(this.output);
      delay.connect(feedback);
      feedback.connect(delay);
    });

    this.setParameter('wet', initialWet, context.currentTime);
    this.setParameter('dry', initialDry, context.currentTime);
    this.setParameter('decay', initialDecay, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) {
      throw new Error('Effect parameter time must be finite.');
    }
    if (this.disposed) throw new Error('Cannot automate a disposed Reverb effect.');

    switch (name) {
      case 'wet':
        this.assertUnit(name, value);
        this.wetGain.gain.setValueAtTime(value, time);
        return;
      case 'dry':
        this.assertUnit(name, value);
        this.dryGain.gain.setValueAtTime(value, time);
        return;
      case 'decay':
        if (value < 0 || value > MAX_DECAY) {
          throw new RangeError(`Reverb effect decay must be between 0 and ${MAX_DECAY}.`);
        }
        for (const feedback of this.feedbackGains) {
          feedback.gain.setValueAtTime(value, time);
        }
        return;
      default:
        throw new Error(`Unknown Reverb effect parameter: ${name}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.input.disconnect();
    this.output.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    for (const delay of this.delayLines) delay.disconnect();
    for (const feedback of this.feedbackGains) feedback.disconnect();
    for (const mix of this.mixGains) mix.disconnect();
  }

  private assertUnit(name: string, value: number): void {
    if (value < 0 || value > 1) {
      throw new RangeError(`Reverb effect ${name} must be between 0 and 1.`);
    }
  }
}
