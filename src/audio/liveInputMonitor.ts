import { audioDeviceManager, type AudioDeviceManager } from './audioDeviceManager';
import { managedAudioInput, type AudioInputLease, type ManagedAudioInput } from './managedAudioInput';

export interface LiveInputMonitorState {
  status: 'off' | 'starting' | 'active' | 'failed';
  trackId: number | null;
  deviceId: string | null;
  channels: number | null;
  inputLatency: number | null;
  baseLatency: number | null;
  outputLatency: number | null;
  message: string | null;
}

/** Session-only microphone route. The destination is supplied by AudioEngine, never the output. */
export class LiveInputMonitor {
  private state: LiveInputMonitorState = this.offState();
  private listeners = new Set<() => void>();
  private generation = 0;
  private source: MediaStreamAudioSourceNode | null = null;
  private lease: AudioInputLease | null = null;
  private detach: Array<() => void> = [];

  constructor(
    private readonly devices: AudioDeviceManager = audioDeviceManager,
    private readonly input: Pick<ManagedAudioInput, 'acquire'> = managedAudioInput,
  ) {}

  private offState(): LiveInputMonitorState {
    return { status: 'off', trackId: null, deviceId: null, channels: null,
      inputLatency: null, baseLatency: null, outputLatency: null, message: null };
  }
  getSnapshot = (): LiveInputMonitorState => ({ ...this.state });
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private emit(): void {
    this.listeners.forEach(listener => {
      try { listener(); } catch (error) { console.error('[Apex Studio] Input monitor subscriber failed', error); }
    });
  }

  stop(message: string | null = null, failed = false): void {
    ++this.generation;
    this.detach.splice(0).forEach(detach => detach());
    try { this.source?.disconnect(); } catch { /* already detached */ }
    this.source = null;
    this.lease?.release();
    this.lease = null;
    this.state = { ...this.offState(), status: failed ? 'failed' : 'off', message };
    this.emit();
  }

  async start(context: AudioContext, destination: AudioNode, trackId: number, prepareGraph?: (isCurrent: () => boolean) => void | Promise<void>): Promise<void> {
    if (this.state.status === 'starting' || this.state.status === 'active') {
      throw new Error('Disable the existing input monitor before assigning another insert.');
    }
    const generation = ++this.generation;
    const deviceId = this.devices.getPreferredInputDeviceId();
    this.state = { ...this.offState(), status: 'starting', trackId, deviceId };
    this.emit();
    const current = () => generation === this.generation;
    try {
      this.detach.push(this.devices.subscribeHardwareChanges(() => {
        if (current()) this.stop('Audio hardware changed. Monitoring is OFF; verify the selected input and enable it again.');
      }));
      this.detach.push(this.devices.subscribe(snapshot => {
        if (!current()) return;
        if (snapshot.preferences.inputDeviceId !== deviceId || !snapshot.selectedInputAvailable || snapshot.microphonePermission === 'denied') {
          this.stop('Input changed, unavailable, or permission revoked. Monitoring is OFF; select an input and enable it again.', true);
        }
      }));
      const onState = () => {
        if (current() && context.state !== 'running') this.stop('Audio context stopped. Monitoring is OFF; enable it again after resuming audio.');
      };
      // Resume from the initiating user action, before capture or graph construction.
      if (context.state === 'suspended') await context.resume();
      if (!current()) return;
      if (context.state !== 'running') throw new Error('Audio must be running before monitoring.');
      context.addEventListener('statechange', onState);
      this.detach.push(() => context.removeEventListener('statechange', onState));
      if (prepareGraph) {
        await prepareGraph(current);
        if (!current()) return;
      }
      const lease = await this.input.acquire(deviceId);
      if (!current()) { lease.release(); return; }
      this.lease = lease;
      const track = lease.stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('Audio input has ended.');
      const settings = track.getSettings() as MediaTrackSettings & { latency?: number };
      const channels = settings.channelCount ?? null;
      if (channels !== null && channels !== 1 && channels !== 2) throw new Error('Monitoring supports mono or stereo input only.');
      this.detach.push(this.devices.monitorActiveCaptureStream(lease.stream, error => {
        if (current()) this.stop(error.message, true);
      }));
      const source = context.createMediaStreamSource(lease.stream);
      this.source = source; // ownership before connect: rollback also covers a throwing connect
      source.connect(destination);
      if (context.state !== 'running') throw new Error('Audio context stopped while starting monitoring.');
      this.state = { ...this.state, status: 'active', channels,
        inputLatency: typeof settings.latency === 'number' ? settings.latency : null,
        baseLatency: context.baseLatency ?? null, outputLatency: context.outputLatency ?? null };
      this.devices.notifyInputCaptureSucceeded(lease.stream);
      if (current()) this.emit();
    } catch (error) {
      if (!current()) return;
      // Translation updates the existing permission/device authority, never retries another input.
      const translated = this.devices.translateAndRecordCaptureFailure(error, deviceId);
      if (current()) this.stop(translated.message, true);
      throw translated;
    }
  }
}
