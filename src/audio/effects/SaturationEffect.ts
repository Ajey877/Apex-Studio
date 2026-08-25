import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/**
 * Production soft-clipping saturation effect.
 *
 * Drive is automated through a pre-gain AudioParam while the waveshaper
 * provides deterministic tanh-style soft clipping. Dry/wet mix remains a
 * separately automatable parameter.
 */
export class SaturationEffect implements AudioEffect {
  readonly name = 'Saturation';
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly preGain: GainNode;
  private readonly shaper: WaveShaperNode;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    readonly id = 'saturation',
    drive = 0.2,
    mix = 0.5,
  ) {
    this.validateDrive(drive);
    this.validateMix(mix);

    this.input = context.createGain();
    this.output = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.preGain = context.createGain();
    this.shaper = context.createWaveShaper();

    this.shaper.curve = SaturationEffect.createCurve();
    this.shaper.oversample = '2x';

    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.preGain);
    this.preGain.connect(this.shaper);
    this.shaper.connect(this.wet);
    this.wet.connect(this.output);

    this.setParameter('drive', drive, context.currentTime);
    this.setParameter('mix', mix, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    this.assertAlive();
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) throw new Error('Effect parameter time must be finite.');

    switch (name) {
      case 'drive':
        this.validateDrive(value);
        this.preGain.gain.setValueAtTime(SaturationEffect.driveGain(value), time);
        return;
      case 'mix':
        this.validateMix(value);
        this.dry.gain.setValueAtTime(1 - value, time);
        this.wet.gain.setValueAtTime(value, time);
        return;
      default:
        throw new Error(`Unknown Saturation effect parameter: ${name}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.dry.disconnect();
    this.preGain.disconnect();
    this.shaper.disconnect();
    this.wet.disconnect();
    this.output.disconnect();
  }

  private validateDrive(value: number): void {
    if (value < 0 || value > 1) {
      throw new RangeError('Saturation drive must be between 0 and 1.');
    }
  }

  private validateMix(value: number): void {
    if (value < 0 || value > 1) {
      throw new RangeError('Saturation mix must be between 0 and 1.');
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('Saturation effect has been disposed.');
  }

  private static driveGain(drive: number): number {
    return 1 + drive * 19;
  }

  private static createCurve(size = 1025): Float32Array {
    const curve = new Float32Array(size);
    const amount = 3;
    for (let index = 0; index < size; index += 1) {
      const x = (index * 2) / (size - 1) - 1;
      curve[index] = Math.tanh(amount * x) / Math.tanh(amount);
    }
    return curve;
  }
}
