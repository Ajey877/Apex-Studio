import { persistAudioClip } from './audioPersistence';
import { audioBufferToWav } from './wavEncoder';

/**
 * Phase 8A — persistent dropped/bounced audio.
 *
 * Audio dropped onto the playlist and stems bounced from a channel are handed
 * to the engine as decoded AudioBuffers via `setSampleBuffer`. Until now they
 * lived only in memory: the clip survived a reload (it is part of the project
 * document) but its audio did not, so it came back as "unavailable".
 *
 * This installer wraps `setSampleBuffer` so every registered buffer is also
 * encoded to WAV and stored under the same asset id. Project hydration already
 * restores any persisted asset referenced by an audio clip, so nothing else in
 * the load path needs to know where the buffer came from.
 */

export interface SampleBufferEngineLike {
  setSampleBuffer(id: string, buffer: AudioBuffer): void;
}

export interface SampleBufferPersistenceOptions {
  persistAudioClip?: (id: string, blob: Blob) => Promise<void>;
  /** Encoder used to turn the in-memory buffer into a storable blob. */
  encode?: (buffer: AudioBuffer) => Blob;
  /** Return false to keep a buffer session-only (defaults to persisting everything). */
  shouldPersist?: (id: string, buffer: AudioBuffer) => boolean;
  onError?: (id: string, error: unknown) => void;
}

export interface SampleBufferPersistenceController {
  /** Resolves once every persistence write started so far has settled. Rejects if any write failed. */
  flush(): Promise<void>;
  /** Resolves only after this asset has been persisted; rejects when its write fails. */
  waitFor(id: string): Promise<void>;
  getPendingIds(): string[];
  isInstalled(): boolean;
}

/**
 * 32-bit float WAV is a lossless container for the Float32 data held in an
 * AudioBuffer, so a bounced or dropped clip sounds identical after a reload.
 */
export const encodeSampleBufferForStorage = (buffer: AudioBuffer): Blob => audioBufferToWav(buffer, 32);

const controllers = new WeakMap<object, SampleBufferPersistenceController>();

const defer = <T>(work: () => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    // Yield first so the UI update triggered by the drop/bounce is never blocked by encoding.
    setTimeout(() => {
      try {
        resolve(work());
      } catch (error) {
        reject(error);
      }
    }, 0);
  });

export function installSampleBufferPersistence(
  engine: SampleBufferEngineLike,
  options?: SampleBufferPersistenceOptions
): SampleBufferPersistenceController {
  const existing = controllers.get(engine as object);
  if (existing) return existing;

  const persist = options?.persistAudioClip ?? persistAudioClip;
  const encode = options?.encode ?? encodeSampleBufferForStorage;
  const shouldPersist = options?.shouldPersist ?? (() => true);
  const onError = options?.onError ?? ((id: string, error: unknown) => {
    console.warn(`[Apex Studio] Audio asset ${id} could not be persisted; it will be unavailable after reload.`, error);
  });

  const pending = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  const originalSetSampleBuffer = engine.setSampleBuffer.bind(engine);

  engine.setSampleBuffer = function setSampleBufferAndPersist(id: string, buffer: AudioBuffer): void {
    // In-memory registration always happens first and never depends on storage.
    originalSetSampleBuffer(id, buffer);
    if (!id || !buffer || !shouldPersist(id, buffer)) return;

    failures.delete(id);
    const write = defer(() => encode(buffer))
      .then(blob => persist(id, blob))
      .catch(error => {
        failures.set(id, error);
        onError(id, error);
        throw error;
      })
      .finally(() => {
        if (pending.get(id) === write) pending.delete(id);
      });
    // A caller that needs ordering uses waitFor(id), while this handler prevents
    // an unobserved storage failure from becoming an unhandled rejection.
    void write.catch(() => undefined);
    pending.set(id, write);
  };

  const controller: SampleBufferPersistenceController = {
    async flush() {
      // Writes can enqueue while we wait, so drain until the map is empty.
      while (pending.size > 0) {
        await Promise.all([...pending.values()]);
      }
    },
    waitFor(id) {
      const write = pending.get(id);
      if (write) return write;
      const failure = failures.get(id);
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    getPendingIds() {
      return [...pending.keys()];
    },
    isInstalled() {
      return true;
    }
  };

  controllers.set(engine as object, controller);
  return controller;
}

/** Returns the installed controller without changing the engine's architecture. */
export const getSampleBufferPersistenceController = (
  engine: SampleBufferEngineLike
): SampleBufferPersistenceController | undefined => controllers.get(engine as object);

/**
 * Playlist audio callers use this gate before committing a clip to project state.
 * A missing installer is treated as a failure rather than silently committing an
 * asset that cannot be guaranteed to be persistent.
 */
export const waitForSampleBufferPersistence = async (
  engine: SampleBufferEngineLike,
  id: string
): Promise<void> => {
  const controller = getSampleBufferPersistenceController(engine);
  if (!controller) throw new Error('Audio persistence is not installed');
  await controller.waitFor(id);
};

export const commitAfterSampleBufferPersistence = async (
  engine: SampleBufferEngineLike,
  id: string,
  commit: () => void
): Promise<void> => {
  await waitForSampleBufferPersistence(engine, id);
  commit();
};
