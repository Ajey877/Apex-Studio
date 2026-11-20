import { audioDeviceManager, type AudioDeviceManager } from './audioDeviceManager';
import { normalizeAudioDeviceId } from '../state/audioPreferences';

export interface AudioInputLease { stream: MediaStream; release(): void }

const stopTracks = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* release every other track even on a driver/runtime fault */ }
  }
};

/** One physical capture, independently owned consumer tracks (clone does not buffer PCM). */
export class ManagedAudioInput {
  private session: { deviceId: string; refs: number; pending: Promise<MediaStream> } | null = null;

  constructor(
    private readonly devices: AudioDeviceManager = audioDeviceManager,
    private readonly capture = (constraints: MediaStreamConstraints) => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        return Promise.reject(new Error('Microphone capture is not supported in this environment.'));
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    },
  ) {}

  async acquire(deviceId = this.devices.getPreferredInputDeviceId()): Promise<AudioInputLease> {
    deviceId = normalizeAudioDeviceId(deviceId);
    if (this.session && this.session.deviceId !== deviceId) {
      throw new Error('Another capture session is using a different input. Stop recording/monitoring before changing devices.');
    }
    if (!this.session) {
      const snapshot = this.devices.getSnapshot();
      if (deviceId === snapshot.preferences.inputDeviceId && !snapshot.selectedInputAvailable) {
        throw new Error('Selected audio input is unavailable. Choose an available input in Audio Settings.');
      }
      const pending = Promise.resolve().then(() => this.capture(this.devices.buildRecordingConstraints(deviceId)));
      this.session = { deviceId, refs: 0, pending };
    }
    const session = this.session;
    session.refs++;
    let root: MediaStream;
    try {
      root = await session.pending;
      if (root.getAudioTracks().some(track => track.readyState === 'ended') || !root.getAudioTracks().length) {
        throw new Error('Audio input stream has ended. Stop all capture sessions before retrying.');
      }
      const stream = root.clone();
      let released = false;
      return { stream, release: () => {
        if (released) return;
        released = true;
        stopTracks(stream);
        if (--session.refs === 0) {
          stopTracks(root);
          if (this.session === session) this.session = null;
        }
      } };
    } catch (error) {
      if (--session.refs === 0) {
        if (this.session === session) this.session = null;
        // Acquisition or clone construction may fail after physical capture opened.
        void session.pending.then(stream => stopTracks(stream), () => {});
      }
      throw error;
    }
  }
}

export const managedAudioInput = new ManagedAudioInput();
