export interface AudioEffect {
  readonly id: string;
  readonly name: string;
  readonly input: AudioNode;
  readonly output: AudioNode;

  /** Set a named parameter at an exact Web Audio time. */
  setParameter(name: string, value: number, time: number): void;

  /** Release all nodes owned by the effect. */
  dispose(): void;
}

export function assertFiniteEffectParameter(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Effect parameter ${name} must be finite.`);
  }
}
