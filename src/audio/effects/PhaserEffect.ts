import { assertFiniteEffectParameter, type AudioEffect } from './AudioEffect';

/**
 * Production phaser built from cascaded all-pass filters with deterministic LFO modulation.
 */
export class PhaserEffect implements AudioEffect {
  readonly name = 'Phaser';
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly stages: BiquadFilterNode[];
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private readonly feedback: GainNode;
  private currentRateHz: number;
  private currentDepthHz: number;
  private currentCenterHz: number;
  private currentFeedback: number;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    readonly id = 'phaser',
    rateHz = 0.35,
    depthHz = 900,
    centerHz = 900,
    feedbackAmount = 0.35,
    mix = 0.5,
  ) {
    this.validate('rate', rateHz);
    this.validate('depth', depthHz);
    this.validate('center', centerHz);
    this.validate('feedback', feedbackAmount);
    this.validate('mix', mix);
    this.currentRateHz = rateHz;
    this.currentDepthHz = depthHz;
    this.currentCenterHz = centerHz;
    this.currentFeedback = feedbackAmount;

    this.input = context.createGain();
    this.output = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.feedback = context.createGain();
    this.lfo = context.createOscillator();
    this.lfoDepth = context.createGain();
    this.stages = Array.from({ length: 4 }, () => {
      const filter = context.createBiquadFilter();
      filter.type = 'allpass';
      return filter;
    });

    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.stages[0]);
    for (let i = 0; i < this.stages.length - 1; i += 1) this.stages[i].connect(this.stages[i + 1]);
    this.stages[this.stages.length - 1].connect(this.wet);
    this.wet.connect(this.output);
    this.wet.connect(this.feedback);
    this.feedback.connect(this.stages[0]);
    this.lfo.connect(this.lfoDepth);
    for (const stage of this.stages) this.lfoDepth.connect(stage.frequency);

    this.lfo.start();
    this.setParameter('rate', rateHz, context.currentTime);
    this.setParameter('depth', depthHz, context.currentTime);
    this.setParameter('center', centerHz, context.currentTime);
    this.setParameter('feedback', feedbackAmount, context.currentTime);
    this.setParameter('mix', mix, context.currentTime);
  }

  setParameter(name: string, value: number, time: number): void {
    this.assertAlive();
    assertFiniteEffectParameter(name, value);
    if (!Number.isFinite(time)) throw new Error('Effect parameter time must be finite.');
    this.validate(name, value);

    switch (name) {
      case 'rate': this.currentRateHz = value; this.lfo.frequency.setValueAtTime(value, time); return;
      case 'depth': this.currentDepthHz = value; this.lfoDepth.gain.setValueAtTime(value, time); return;
      case 'center': this.currentCenterHz = value; this.updateCenters(time); return;
      case 'feedback': this.currentFeedback = value; this.feedback.gain.setValueAtTime(value, time); return;
      case 'mix': this.dry.gain.setValueAtTime(1 - value, time); this.wet.gain.setValueAtTime(value, time); return;
      default: throw new Error(`Unknown Phaser effect parameter: ${name}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect(); this.dry.disconnect(); this.wet.disconnect(); this.feedback.disconnect();
    this.lfo.disconnect(); this.lfoDepth.disconnect();
    for (const stage of this.stages) stage.disconnect();
    this.output.disconnect();
    this.lfo.stop();
  }

  private updateCenters(time: number): void {
    const spacing = 1.35;
    this.stages.forEach((stage, index) => stage.frequency.setValueAtTime(this.currentCenterHz * Math.pow(spacing, index), time));
  }

  private validate(name: string, value: number): void {
    switch (name) {
      case 'rate': if (value < 0.02 || value > 12) throw new RangeError('Phaser rate must be between 0.02 and 12 Hz.'); break;
      case 'depth': if (value < 0 || value > 4000) throw new RangeError('Phaser depth must be between 0 and 4000 Hz.'); break;
      case 'center': if (value < 80 || value > 8000) throw new RangeError('Phaser center must be between 80 and 8000 Hz.'); break;
      case 'feedback': if (value < 0 || value > 0.95) throw new RangeError('Phaser feedback must be between 0 and 0.95.'); break;
      case 'mix': if (value < 0 || value > 1) throw new RangeError('Phaser mix must be between 0 and 1.'); break;
    }
  }

  private assertAlive(): void { if (this.disposed) throw new Error('Phaser effect has been disposed.'); }
}
