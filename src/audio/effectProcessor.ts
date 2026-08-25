export type EffectType =
  | 'gain'
  | 'lowpass'
  | 'highpass'
  | 'eq'
  | 'compressor'
  | 'delay'
  | 'distortion';

export interface EffectParameters {
  gainDb?: number;
  frequencyHz?: number;
  q?: number;
  thresholdDb?: number;
  ratio?: number;
  attackSeconds?: number;
  releaseSeconds?: number;
  delaySeconds?: number;
  feedback?: number;
  mix?: number;
  drive?: number;
}

export interface EffectProcessor {
  readonly type: EffectType;
  readonly node: AudioNode;
  setParameters(parameters: EffectParameters): void;
  dispose(): void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

function setParam(param: AudioParam | undefined, value: number): void {
  if (param) param.value = value;
}

export function createEffectProcessor(
  context: AudioContext,
  type: EffectType,
  parameters: EffectParameters = {},
): EffectProcessor {
  let node: AudioNode;

  switch (type) {
    case 'gain': {
      const gain = context.createGain();
      node = gain;
      break;
    }
    case 'lowpass':
    case 'highpass': {
      const filter = context.createBiquadFilter();
      filter.type = type;
      node = filter;
      break;
    }
    case 'eq': {
      const eq = context.createBiquadFilter();
      eq.type = 'peaking';
      node = eq;
      break;
    }
    case 'compressor':
      node = context.createDynamicsCompressor();
      break;
    case 'delay': {
      const delay = context.createDelay(10);
      node = delay;
      break;
    }
    case 'distortion': {
      const shaper = context.createWaveShaper();
      node = shaper;
      break;
    }
  }

  const processor: EffectProcessor = {
    type,
    node,
    setParameters(next) {
      if (type === 'gain') {
        setParam((node as GainNode).gain, clamp(finite(next.gainDb ?? 0, 0), -60, 12) === -60
          ? 0
          : Math.pow(10, clamp(finite(next.gainDb ?? 0, 0), -60, 12) / 20));
      } else if (type === 'lowpass' || type === 'highpass' || type === 'eq') {
        const filter = node as BiquadFilterNode;
        setParam(filter.frequency, clamp(finite(next.frequencyHz ?? 1000, 1000), 20, 20000));
        setParam(filter.Q, clamp(finite(next.q ?? 0.707, 0.707), 0.0001, 30));
        if (type === 'eq') {
          setParam(filter.gain, clamp(finite(next.gainDb ?? 0, 0), -24, 24));
        }
      } else if (type === 'compressor') {
        const compressor = node as DynamicsCompressorNode;
        setParam(compressor.threshold, clamp(finite(next.thresholdDb ?? -24, -24), -100, 0));
        setParam(compressor.ratio, clamp(finite(next.ratio ?? 4, 4), 1, 20));
        setParam(compressor.attack, clamp(finite(next.attackSeconds ?? 0.003, 0.003), 0, 1));
        setParam(compressor.release, clamp(finite(next.releaseSeconds ?? 0.25, 0.25), 0, 1));
      } else if (type === 'delay') {
        const delay = node as DelayNode;
        setParam(delay.delayTime, clamp(finite(next.delaySeconds ?? 0.25, 0.25), 0, 10));
      } else if (type === 'distortion') {
        const shaper = node as WaveShaperNode;
        const drive = clamp(finite(next.drive ?? 0, 0), 0, 1);
        const amount = drive * 1000;
        const curve = new Float32Array(1024);
        for (let i = 0; i < curve.length; i += 1) {
          const x = (i * 2) / (curve.length - 1) - 1;
          curve[i] = amount === 0 ? x : ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
        }
        shaper.curve = curve;
        shaper.oversample = '4x';
      }
    },
    dispose() {
      node.disconnect();
    },
  };

  processor.setParameters(parameters);
  return processor;
}
