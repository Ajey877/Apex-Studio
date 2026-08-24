import { MasterBus } from './masterBus';
import { MixerChannelStrip } from './channelStrip';

/** Owns the final mixer signal topology: channel strips -> master -> destination. */
export class MixerMasterGraph {
  readonly master: MasterBus;
  private readonly channels = new Map<number, MixerChannelStrip>();

  constructor(private readonly context: AudioContext) {
    this.master = new MasterBus(context);
  }

  addChannel(channel: MixerChannelStrip): void {
    if (this.channels.has(channel.state.id)) {
      throw new Error(`Mixer channel ${channel.state.id} is already registered.`);
    }
    channel.output.connect(this.master.input);
    this.channels.set(channel.state.id, channel);
    this.refreshSoloState();
  }

  removeChannel(channelId: number): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.output.disconnect();
    channel.dispose();
    this.channels.delete(channelId);
    this.refreshSoloState();
  }

  connectDestination(destination: AudioNode): void {
    this.master.connectDestination(destination);
  }

  refreshSoloState(): void {
    const hasSolo = Array.from(this.channels.values()).some(channel => channel.state.soloed);
    for (const channel of this.channels.values()) channel.setSoloState(hasSolo);
  }

  getChannel(channelId: number): MixerChannelStrip | undefined {
    return this.channels.get(channelId);
  }

  getChannels(): MixerChannelStrip[] {
    return Array.from(this.channels.values());
  }

  dispose(): void {
    for (const channel of this.channels.values()) channel.dispose();
    this.channels.clear();
    this.master.dispose();
  }
}
