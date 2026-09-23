import type { CustomSampleData } from '../types/daw';
import { persistAudioClip } from './audioPersistence';

/**
 * Phase 8A — persistent imported samples.
 *
 * Samples imported through the Sample Manager were decoded straight into the
 * audio engine and never written to storage, so a channel using a custom
 * sample fell silent after every reload. The original file bytes are now
 * persisted under the sample id (the same id `getAudioIdsForProject` collects
 * from `channel.customSample.id`), which is exactly what hydration restores.
 */

export interface SampleImportEngine {
  loadAudioFile: (file: File | Blob, id: string) => Promise<{ buffer: AudioBuffer; peaks: number[]; duration: number }>;
}

export interface ImportSampleFileOptions {
  engine: SampleImportEngine;
  persistAudioClip?: (id: string, blob: Blob) => Promise<void>;
  /** Injected for deterministic ids in tests. */
  now?: number;
  id?: string;
  onPersistError?: (id: string, error: unknown) => void;
}

export type ImportSampleFileResult =
  | {
      sample: CustomSampleData;
      persisted: true;
    }
  | {
      sample: null;
      persisted: false;
      error: unknown;
    };

export const createImportedSampleId = (now: number = Date.now()): string => `sample-${now}`;

export const stripFileExtension = (fileName: string): string => fileName.replace(/\.[^/.]+$/, '');

export const importSampleFile = async (
  file: File | Blob,
  options: ImportSampleFileOptions
): Promise<ImportSampleFileResult> => {
  const sampleId = options.id ?? createImportedSampleId(options.now);
  const persist = options.persistAudioClip ?? persistAudioClip;
  const onPersistError = options.onPersistError ?? ((id: string, error: unknown) => {
    console.warn(`[Apex Studio] Imported sample ${id} could not be persisted; it will be unavailable after reload.`, error);
  });

  // Decode first: a file the engine cannot decode must never be persisted.
  const result = await options.engine.loadAudioFile(file, sampleId);

  try {
    // Persist the original bytes (compressed formats stay compact and decode identically on reload).
    await persist(sampleId, file);
  } catch (error) {
    onPersistError(sampleId, error);
    // The decoded buffer may remain available for auditioning this session, but
    // callers must not receive a sample that can be attached to the project.
    return { sample: null, persisted: false, error };
  }

  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : 'Imported Sample';
  const sample: CustomSampleData = {
    id: sampleId,
    name: stripFileExtension(fileName) || 'Imported Sample',
    duration: result.duration,
    sampleRate: result.buffer.sampleRate,
    channels: result.buffer.numberOfChannels,
    waveformPeaks: result.peaks,
    trimStart: 0,
    trimEnd: 1.0,
    rootPitch: 60,
    reverse: false
  };

  return { sample, persisted: true };
};
