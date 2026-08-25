import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/**
 * Production safety limiter with a final hard ceiling stage.
 * Ceiling is expressed in dBFS; drive and mix remain automatable.
 * The final clipper is deliberately after the dry/wet sum so the dry path
 * can never bypass the configured output ceiling.
 */
export class LimiterEffect implements AudioEffect {
  readonly name = 'Limiter';
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly drive: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly finalCeiling: WaveShaperNode;
  private disposed = false;
  private ceilingLinear = 1;

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
    this.finalCeiling = context.createWaveShaper();
    this.limiter.threshold.value = ceilingDb; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = releaseSeconds;
    this.input.connect(this.dry); this.dry.connect(this.finalCeiling); this.input.connect(this.drive); this.drive.connect(this.limiter); this.limiter.connect(this.wet); this.wet.connect(this.finalCeiling); this.finalCeiling.connect(this.output);
    this.setParameter('ceiling', ceilingDb, context.currentTime); this.setParameter('release', releaseSeconds, context.currentTime); this.setParameter('drive', driveDb, context.currentTime); this.setParameter('mix', mix, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    this.assertAlive(); assertFiniteEffectParameter(name, value); if (!Number.isFinite(time)) throw new Error('Effect parameter time must be finite.'); this.validate(name, value);
    switch (name) {
      case 'ceiling': this.limiter.threshold.setValueAtTime(value, time); this.ceilingLinear = Math.pow(10, value / 20); this.updateCeilingCurve(); return;
      case 'release': this.limiter.release.setValueAtTime(value, time); return;
      case 'drive': this.drive.gain.setValueAtTime(Math.pow(10, value / 20), time); return;
      case 'mix': this.dry.gain.setValueAtTime(1 - value, time); this.wet.gain.setValueAtTime(value, time); return;
      default: throw new Error(`Unknown Limiter effect parameter: ${name}`);
    }
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.input.disconnect(); this.drive.disconnect(); this.limiter.disconnect(); this.dry.disconnect(); this.wet.disconnect(); this.finalCeiling.disconnect(); this.output.disconnect(); }

  private updateCeilingCurve(): void {
    const n = 2049; const curve = new Float32Array(n); const max = 4; const c = this.ceilingLinear;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 * max - max; curve[i] = Math.max(-c, Math.min(c, x)); }
    this.finalCeiling.curve = curve;
    this.finalCeiling.oversample = '4x';
  }

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
