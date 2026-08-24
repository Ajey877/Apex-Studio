export interface InsertSlot {
  readonly id: string;
  readonly node: AudioNode;
  bypassed: boolean;
}

/**
 * Owns a deterministic serial insert chain for one channel.
 * The rack never disconnects its external output; only connections it owns
 * between the rack input, insert nodes, and rack output are rebuilt.
 */
export class ChannelInsertRack {
  readonly input: GainNode;
  readonly output: GainNode;

  private slots: InsertSlot[] = [];

  constructor(private readonly context: AudioContext) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.rebuild();
  }

  getSlots(): readonly InsertSlot[] {
    return this.slots.map((slot) => ({ ...slot }));
  }

  add(id: string, node: AudioNode, bypassed = false): void {
    this.assertId(id);
    if (this.slots.some((slot) => slot.id === id)) {
      throw new Error(`Insert slot already exists: ${id}`);
    }
    this.slots.push({ id, node, bypassed });
    this.rebuild();
  }

  remove(id: string): void {
    const index = this.indexOf(id);
    const [slot] = this.slots.splice(index, 1);
    slot.node.disconnect();
    this.rebuild();
  }

  setBypassed(id: string, bypassed: boolean): void {
    this.slots[this.indexOf(id)].bypassed = bypassed;
    this.rebuild();
  }

  move(id: string, targetIndex: number): void {
    const fromIndex = this.indexOf(id);
    if (!Number.isInteger(targetIndex)) {
      throw new Error('Insert target index must be an integer.');
    }
    const boundedIndex = Math.max(0, Math.min(this.slots.length - 1, targetIndex));
    if (fromIndex === boundedIndex) return;
    const [slot] = this.slots.splice(fromIndex, 1);
    this.slots.splice(boundedIndex, 0, slot);
    this.rebuild();
  }

  dispose(): void {
    this.input.disconnect();
    for (const slot of this.slots) slot.node.disconnect();
    this.slots = [];
  }

  private rebuild(): void {
    this.input.disconnect();
    for (const slot of this.slots) slot.node.disconnect();

    let previous: AudioNode = this.input;
    for (const slot of this.slots) {
      if (slot.bypassed) continue;
      previous.connect(slot.node);
      previous = slot.node;
    }
    previous.connect(this.output);
  }

  private indexOf(id: string): number {
    const index = this.slots.findIndex((slot) => slot.id === id);
    if (index < 0) throw new Error(`Unknown insert slot: ${id}`);
    return index;
  }

  private assertId(id: string): void {
    if (!id.trim()) throw new Error('Insert slot id must not be empty.');
  }
}
