export interface ChannelInsertSlot<TProcessor> {
  readonly processor: TProcessor;
  readonly bypassed: boolean;
}

/**
 * Deterministic insert-slot state for a mixer channel.
 * Audio-node wiring remains owned by the channel implementation; this class
 * provides the stable ordering/bypass contract that wiring can consume.
 */
export class ChannelInsertRack<TProcessor> {
  private readonly slots: Array<ChannelInsertSlot<TProcessor> | null>;

  constructor(private readonly maxSlots = 8) {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      throw new RangeError('maxSlots must be a positive integer');
    }
    this.slots = Array.from({ length: maxSlots }, () => null);
  }

  get size(): number {
    return this.slots.filter((slot) => slot !== null).length;
  }

  get capacity(): number {
    return this.maxSlots;
  }

  get(index: number): ChannelInsertSlot<TProcessor> | null {
    this.assertIndex(index);
    return this.slots[index];
  }

  set(index: number, processor: TProcessor): void {
    this.assertIndex(index);
    if (this.slots[index] !== null) {
      throw new Error(`Insert slot ${index} is already occupied`);
    }
    this.slots[index] = { processor, bypassed: false };
  }

  replace(index: number, processor: TProcessor): TProcessor | null {
    this.assertIndex(index);
    const previous = this.slots[index]?.processor ?? null;
    this.slots[index] = { processor, bypassed: false };
    return previous;
  }

  remove(index: number): TProcessor | null {
    this.assertIndex(index);
    const previous = this.slots[index]?.processor ?? null;
    this.slots[index] = null;
    return previous;
  }

  setBypassed(index: number, bypassed: boolean): void {
    this.assertIndex(index);
    const slot = this.slots[index];
    if (slot === null) {
      throw new Error(`Insert slot ${index} is empty`);
    }
    this.slots[index] = { ...slot, bypassed };
  }

  clear(): TProcessor[] {
    const removed = this.slots
      .filter((slot): slot is ChannelInsertSlot<TProcessor> => slot !== null)
      .map((slot) => slot.processor);
    this.slots.fill(null);
    return removed;
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.maxSlots) {
      throw new RangeError(`Insert slot index ${index} is out of range`);
    }
  }
}
