import { MixerChannelStrip } from './channelStrip';
import { TrackRegistry } from './trackRegistry';
import type { MixerChannelState } from './mixerChannel';

/**
 * Owns the runtime audio counterpart of every project track.
 * The registry remains the source of truth for state; channel strips own Web Audio nodes.
 */
export class TrackAudioRouter {
  private readonly strips = new Map<number, MixerChannelStrip>();
  private disposed = false;

  constructor(private readonly context: AudioContext, private readonly registry: TrackRegistry) {}

  sync(): void {
    this.assertAlive();
    const tracks = this.registry.list();
    const activeIds = new Set<number>();

    for (const track of tracks) {
      activeIds.add(track.id);
      let strip = this.strips.get(track.id);
      if (!strip) {
        strip = new MixerChannelStrip(this.context, track.id, track.name);
        this.strips.set(track.id, strip);
      }
      this.applyState(strip, track);
    }

    for (const [id, strip] of this.strips) {
      if (!activeIds.has(id)) {
        strip.dispose();
        this.strips.delete(id);
      }
    }

    this.updateSoloState();
  }

  getStrip(id: number): MixerChannelStrip | undefined {
    this.assertAlive();
    return this.strips.get(id);
  }

  getInput(id: number): AudioNode {
    const strip = this.requireStrip(id);
    return strip.input;
  }

  getOutput(id: number): AudioNode {
    const strip = this.requireStrip(id);
    return strip.output;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const strip of this.strips.values()) strip.dispose();
    this.strips.clear();
  }

  private applyState(strip: MixerChannelStrip, track: MixerChannelState): void {
    strip.setVolumeDb(track.volumeDb);
    strip.setPan(track.pan);
    strip.setMuted(track.muted);
    strip.setSoloed(track.soloed);
  }

  private updateSoloState(): void {
    const hasSolo = this.registry.list().some(track => track.soloed);
    for (const strip of this.strips.values()) strip.setSoloState(hasSolo);
  }

  private requireStrip(id: number): MixerChannelStrip {
    const strip = this.strips.get(id);
    if (!strip) throw new Error(`Audio strip for track ID ${id} does not exist.`);
    return strip;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('Track audio router has been disposed.');
  }
}
