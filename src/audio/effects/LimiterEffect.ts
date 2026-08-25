import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/**
 * Production safety limiter using a DynamicsCompressorNode configured for near-hard limiting.
 * Ceiling is expressed in dBFS; drive remains automatable through the input gain.
 */
export class LimiterEffect implements AudioEffect {
  readonly name = 'Limiter';
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly drive: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    readonly id = 'limiter',
    ceilingDb = -0.3,
    releaseSeconds = 0.08,
    driveDb = 0,
    mix = 1,
  ) {
    this.validate('ceiling', ceilingDb); this.validate('release', releaseSeconds); this.validate('drive', driveDb); this.validate('mix', mix);
    this.input = context.createGain(); this.output = context.createGain(); this.drive = context.createGain();
    this.limiter = context.createDynamicsCompressor(); this.dry = context.createGain(); this.wet = context.createGain();
    this.limiter.threshold.value = ceilingDb; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = releaseSeconds;
    this.input.connect(this.dry); this.dry.connect(this.output); this.input.connect(this.drive); this.drive.connect(this.limiter); this.limiter.connect(this.wet); this.wet.connect(this.output);
    this.setParameter('ceiling', ceilingDb, context.currentTime); this.setParameter('release', releaseSeconds, context.currentTime); this.setParameter('drive', driveDb, context.currentTime); this.setParameter('mix', mix, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    this.assertAlive(); assertFiniteEffectParameter(name, value); if (!Number.isFinite(time)) throw new Error('Effect parameter time must be finite.'); this.validate(name, value);
    switch (name) {
      case 'ceiling': this.limiter.threshold.setValueAtTime(value, time); return;
      case 'release': this.limiter.release.setValueAtTime(value, time); return;
      case 'drive': this.drive.gain.setValueAtTime(Math.pow(10, value / 20), time); return;
      case 'mix': this.dry.gain.setValueAtTime(1 - value, time); this.wet.gain.setValueAtTime(value, time); return;
      default: throw new Error(`Unknown Limiter effect parameter: ${name}`);
    }
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.input.disconnect(); this.drive.disconnect(); this.limiter.disconnect(); this.dry.disconnect(); this.wet.disconnect(); this.output.disconnect(); }

  private validate(name: string, value: number): void {
    switch (name) {
      case 'ceiling': if (value < -12 || value > 0) throw new RangeError('Limiter ceiling must be between -12 and 0 dB.'); break;
      case 'release': if (value < 0.01 || value > 1) throw new RangeError('Limiter release must be between 0.01 and 1 seconds.'); break;
      case 'drive': if (value < -12 || value > 24) throw new RangeError('Limiter drive must be between -12 and 24 dB.'); break;
      case 'mix': if (value < 0 || value > 1) throw new RangeError('Limiter mix must be between 0 and 1.'); break;
    }
  }
  private assertAlive(): void { if (this.disposed) throw new Error('Limiter effect has been disposed.'); }
}
