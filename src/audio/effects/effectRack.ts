import type { AudioEffect } from './AudioEffect';

export interface EffectSlot {
  readonly id: string;
  readonly effect: AudioEffect;
  readonly bypassed: boolean;
}

/**
 * Owns a deterministic serial chain of AudioEffect instances.
 * The rack owns only connections between its input, effect nodes, and output.
 * Removing or disposing a slot also disposes the effect it owns.
 */
export class EffectRack {
  readonly input: GainNode;
  readonly output: GainNode;

  private slots: Array<{ id: string; effect: AudioEffect; bypassed: boolean }> = [];

  constructor(private readonly context: AudioContext) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.rebuild();
  }

  getSlots(): readonly EffectSlot[] {
    return this.slots.map((slot) => ({ ...slot }));
  }

  add(effect: AudioEffect, bypassed = false): void {
    this.assertId(effect.id);
    if (this.slots.some((slot) => slot.id === effect.id)) {
      throw new Error(`Effect slot already exists: ${effect.id}`);
    }
    this.slots.push({ id: effect.id, effect, bypassed });
    this.rebuild();
  }

  remove(id: string): void {
    const index = this.indexOf(id);
    const [slot] = this.slots.splice(index, 1);
    slot.effect.input.disconnect();
    slot.effect.output.disconnect();
    slot.effect.dispose();
    this.rebuild();
  }

  setBypassed(id: string, bypassed: boolean): void {
    this.slots[this.indexOf(id)].bypassed = bypassed;
    this.rebuild();
  }

  move(id: string, targetIndex: number): void {
    const fromIndex = this.indexOf(id);
    if (!Number.isInteger(targetIndex)) {
      throw new Error('Effect target index must be an integer.');
    }
    const boundedIndex = Math.max(0, Math.min(this.slots.length - 1, targetIndex));
    if (fromIndex === boundedIndex) return;
    const [slot] = this.slots.splice(fromIndex, 1);
    this.slots.splice(boundedIndex, 0, slot);
    this.rebuild();
  }

  dispose(): void {
    this.input.disconnect();
    for (const slot of this.slots) {
      slot.effect.input.disconnect();
      slot.effect.output.disconnect();
      slot.effect.dispose();
    }
    this.output.disconnect();
    this.slots = [];
  }

  private rebuild(): void {
    this.input.disconnect();
    for (const slot of this.slots) {
      slot.effect.input.disconnect();
      slot.effect.output.disconnect();
    }

    let previous: AudioNode = this.input;
    for (const slot of this.slots) {
      if (slot.bypassed) continue;
      previous.connect(slot.effect.input);
      previous = slot.effect.output;
    }
    previous.connect(this.output);
  }

  private indexOf(id: string): number {
    const index = this.slots.findIndex((slot) => slot.id === id);
    if (index < 0) throw new Error(`Unknown effect slot: ${id}`);
    return index;
  }

  private assertId(id: string): void {
    if (!id.trim()) throw new Error('Effect slot id must not be empty.');
  }
}
