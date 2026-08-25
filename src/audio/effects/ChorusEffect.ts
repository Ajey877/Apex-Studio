import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/**
 * Production chorus effect using a modulated delay line.
 * The modulation depth and base delay are bounded to keep the delay stable.
 */
export class ChorusEffect implements AudioEffect {
  readonly name = 'Chorus';
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly delay: DelayNode;
  private readonly lfo: OscillatorNode;
  private readonly depth: GainNode;
  private readonly lfoOffset: ConstantSourceNode;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    readonly id = 'chorus',
    rateHz = 1.2,
    depthSeconds = 0.003,
    delaySeconds = 0.02,
    mix = 0.25,
  ) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.delay = context.createDelay(0.1);
    this.lfo = context.createOscillator();
    this.depth = context.createGain();
    this.lfoOffset = context.createConstantSource();

    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.output);

    this.lfo.connect(this.depth);
    this.depth.connect(this.delay.delayTime);
    this.lfoOffset.connect(this.delay.delayTime);

    this.lfo.start();
    this.lfoOffset.start();

    this.setParameter('rate', rateHz, context.currentTime);
    this.setParameter('depth', depthSeconds, context.currentTime);
    this.setParameter('delay', delaySeconds, context.currentTime);
    this.setParameter('mix', mix, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    this.assertAlive();
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) throw new Error('Effect parameter time must be finite.');

    switch (name) {
      case 'rate':
        if (value < 0.05 || value > 20) {
          throw new RangeError('Chorus rate must be between 0.05 and 20 Hz.');
        }
        this.lfo.frequency.setValueAtTime(value, time);
        return;
      case 'depth':
        if (value < 0 || value > 0.02) {
          throw new RangeError('Chorus depth must be between 0 and 0.02 seconds.');
        }
        this.depth.gain.setValueAtTime(value, time);
        return;
      case 'delay':
        if (value < 0.005 || value > 0.08) {
          throw new RangeError('Chorus delay must be between 0.005 and 0.08 seconds.');
        }
        this.lfoOffset.offset.setValueAtTime(value, time);
        return;
      case 'mix':
        if (value < 0 || value > 1) {
          throw new RangeError('Chorus mix must be between 0 and 1.');
        }
        this.dry.gain.setValueAtTime(1 - value, time);
        this.wet.gain.setValueAtTime(value, time);
        return;
      default:
        throw new Error(`Unknown Chorus effect parameter: ${name}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.dry.disconnect();
    this.wet.disconnect();
    this.delay.disconnect();
    this.depth.disconnect();
    this.lfo.disconnect();
    this.lfoOffset.disconnect();
    this.output.disconnect();
    this.lfo.stop();
    this.lfoOffset.stop();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('Chorus effect has been disposed.');
  }
}
