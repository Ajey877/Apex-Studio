/**
 * ProjectBundleImport — safe restoration planning for Portable ZIP bundles.
 *
 * Phase 6B hardening (project persistence/export reliability, issue #56):
 * the bundle importer used to persist every declared audio entry straight
 * into IndexedDB while unpacking — before the user confirmed the project
 * replacement and without validating anything. A stale or crafted archive
 * whose asset ids happened to collide with the current project's audio
 * therefore PERMANENTLY OVERWROTE locally stored bytes (even when the user
 * cancelled the import), duplicate ids silently last-wins-ed, truncated or
 * empty payloads were accepted (and counted as "restored"), and a failure
 * mid-loop left a half-written store with no project loaded.
 *
 * This module replaces that with a validate-then-write contract:
 * `planBundleAudioImport` inspects every declared entry, reads every payload
 * from the archive and compares against the real storage layer BEFORE a
 * single write happens. The plan is all-or-nothing: any malformed, unsafe,
 * duplicated, missing, truncated, empty or conflicting entry rejects the
 * whole archive with a typed `BundleImportError`, and storage is guaranteed
 * untouched. Only a fully validated plan reaches the ZIP commit boundary.
 *
 * Scope notes:
 *  - Export packaging lives in `projectBundleAudioAssets.ts` and is unchanged.
 *  - Planning uses the existing `getPersistedAudioClip` reader. Commit writes
 *    new audio with `add()` and both project records in one transaction across
 *    the existing `clips` and `projects` stores.
 *  - An existing asset with BYTE-IDENTICAL content is treated as already
 *    restored (idempotent re-import of the same bundle is a no-op, not a
 *    conflict).
 */

import { ProjectBundleCommitCancelledError } from '../audio/audioPersistence';

/** Structured failure reasons so callers (and tests) can assert on kind, not message text. */
export type BundleImportFailure =
  | 'malformed-audio-manifest'
  | 'invalid-audio-entry'
  | 'duplicate-audio-id'
  | 'duplicate-audio-path'
  | 'unsafe-audio-path'
  | 'missing-audio-payload'
  | 'empty-audio-payload'
  | 'payload-size-mismatch'
  | 'conflicting-stored-audio'
  | 'stored-audio-unreadable';

export class BundleImportError extends Error {
  readonly failure: BundleImportFailure;
  readonly audioId?: string;
  constructor(failure: BundleImportFailure, message: string, audioId?: string) {
    super(message);
    this.name = 'BundleImportError';
    this.failure = failure;
    this.audioId = audioId;
  }
}

/** Minimal structural view of a JSZip archive (only what the planner needs). */
export interface BundleZipEntry {
  async(type: 'uint8array'): Promise<Uint8Array>;
}

export interface BundleZipLike {
  file(path: string): BundleZipEntry | null;
}

/** One fully validated archive asset available to the atomic ZIP commit plan. */
export interface PlannedBundleAudioAsset {
  id: string;
  path: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

export interface BundleAudioImportPlan {
  /** Assets whose ids are new locally: persist these (byte content validated). */
  assetsToPersist: PlannedBundleAudioAsset[];
  /** Ids already stored locally with byte-identical content: nothing to write. */
  alreadyStoredIds: string[];
  /** Every validated archive payload, used to pre-decode assets before commit. */
  validatedAssets: PlannedBundleAudioAsset[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Resolves the optional bundle manifest's audio list. A recognized Apex
 * manifest must have an array (including the intentional empty array used by
 * manifest-only exports); unknown/legacy formats carry no restorable contract.
 */
export const getRecognizedBundleAudioFiles = (manifest: unknown): unknown[] => {
  if (!isRecord(manifest) || manifest.format !== 'apex-studio-project-bundle') return [];
  if (!Array.isArray(manifest.audioFiles)) {
    throw new BundleImportError(
      'malformed-audio-manifest',
      'Import failed — bundle_manifest.json does not contain a valid audioFiles list.',
    );
  }
  return manifest.audioFiles;
};

/**
 * Archive paths must live under `audio/` and use only the character set the
 * exporter's `buildBundleAudioAssetPath` can produce. This rejects absolute
 * paths, `..` traversal segments, backslashes, control characters and any
 * entry outside the audio folder — the manifest is untrusted input, and
 * `zip.file(path)` would otherwise happily read ANY entry in the archive.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const isSafeBundleAudioPath = (path: string): boolean => {
  if (!path.startsWith('audio/')) return false;
  const segments = path.split('/');
  if (segments.length < 2 || segments[0] !== 'audio') return false;
  return segments.slice(1).every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/**
 * Validate a bundle manifest's `audioFiles` list against the archive and the
 * current audio store, and return the write plan. Throws `BundleImportError`
 * (with storage guaranteed untouched) if the archive cannot be restored
 * completely and safely — partial restoration is never planned.
 *
 * @param audioFiles   `bundle_manifest.json` → `audioFiles` (untrusted JSON).
 * @param zip          loaded archive (JSZip instance satisfies BundleZipLike).
 * @param readStoredAudio existing storage reader, e.g. `getPersistedAudioClip`.
 */
export const planBundleAudioImport = async (
  audioFiles: unknown,
  zip: BundleZipLike,
  readStoredAudio: (id: string) => Promise<Blob | null | undefined>,
): Promise<BundleAudioImportPlan> => {
  if (!Array.isArray(audioFiles)) {
    throw new BundleImportError(
      'malformed-audio-manifest',
      'Import failed — bundle_manifest.json does not contain a valid audioFiles list.',
    );
  }

  const assetsToPersist: PlannedBundleAudioAsset[] = [];
  const alreadyStoredIds: string[] = [];
  const validatedAssets: PlannedBundleAudioAsset[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const rawFile of audioFiles) {
    if (!isRecord(rawFile)) {
      throw new BundleImportError('invalid-audio-entry', 'Import failed — the bundle audio manifest contains a malformed entry.');
    }
    const { id, path, size, mimeType } = rawFile;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new BundleImportError('invalid-audio-entry', 'Import failed — a bundle audio entry is missing its asset id.');
    }
    if (typeof path !== 'string' || path.length === 0) {
      throw new BundleImportError('invalid-audio-entry', `Import failed — audio asset "${id}" is missing its archive path.`, id);
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      throw new BundleImportError('invalid-audio-entry', `Import failed — audio asset "${id}" declares an invalid payload size.`, id);
    }
    if (seenIds.has(id)) {
      throw new BundleImportError('duplicate-audio-id', `Import failed — the bundle lists audio asset "${id}" more than once.`, id);
    }
    if (seenPaths.has(path)) {
      throw new BundleImportError('duplicate-audio-path', `Import failed — the bundle lists archive path "${path}" more than once.`, id);
    }
    if (!isSafeBundleAudioPath(path)) {
      throw new BundleImportError('unsafe-audio-path', `Import failed — "${path}" is not a safe bundle audio path.`, id);
    }
    seenIds.add(id);
    seenPaths.add(path);

    const entry = zip.file(path);
    if (!entry) {
      throw new BundleImportError('missing-audio-payload', `Import failed — audio payload "${path}" is missing from the archive.`, id);
    }
    const bytes = await entry.async('uint8array');
    if (bytes.length === 0) {
      throw new BundleImportError('empty-audio-payload', `Import failed — audio payload "${path}" is empty.`, id);
    }
    if (bytes.length !== size) {
      throw new BundleImportError(
        'payload-size-mismatch',
        `Import failed — audio payload "${path}" declares ${size} bytes but the archive contains ${bytes.length}.`,
        id,
      );
    }

    const resolvedMimeType = typeof mimeType === 'string' && mimeType.trim().length > 0 ? mimeType : 'application/octet-stream';
    const validatedAsset: PlannedBundleAudioAsset = {
      id,
      path,
      mimeType: resolvedMimeType,
      size,
      blob: new Blob([bytes], { type: resolvedMimeType }),
    };
    validatedAssets.push(validatedAsset);

    let stored: Blob | null | undefined;
    try {
      stored = await readStoredAudio(id);
    } catch {
      throw new BundleImportError('stored-audio-unreadable', `Import failed — the locally stored audio for "${id}" could not be read.`, id);
    }
    if (stored) {
      const storedBytes = new Uint8Array(await stored.arrayBuffer());
      if (bytesEqual(storedBytes, bytes)) {
        // Re-importing the same bundle (or one sharing identical assets) is
        // idempotent: the bytes are already in the store, nothing to write.
        alreadyStoredIds.push(id);
        continue;
      }
      throw new BundleImportError(
        'conflicting-stored-audio',
        `Import failed — audio asset "${id}" already exists locally with different content. Existing audio was left untouched.`,
        id,
      );
    }

    assetsToPersist.push(validatedAsset);
  }

  return { assetsToPersist, alreadyStoredIds, validatedAssets };
};

export interface BundleImportCommitOptions {
  /** False means the user dismissed/rejected the replacement before acceptance. */
  accepted: boolean;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  /** Decode/prepare archive audio without publishing it to the live engine. */
  prepare?: (plan: BundleAudioImportPlan) => Promise<void>;
  /** Must atomically persist these assets together with active + recovery project records. */
  persist: (assets: PlannedBundleAudioAsset[]) => Promise<void>;
}

/**
 * Enforces the ZIP import's final pre-commit boundary. Backup stays in the
 * existing project-replacement path; cancellation/supersession is checked
 * before and after asynchronous preparation, and persistence runs only after
 * acceptance and preparation both succeeded.
 */
export const runBundleImportCommit = async (
  plan: BundleAudioImportPlan,
  options: BundleImportCommitOptions,
): Promise<boolean> => {
  if (!options.accepted) return false;
  const assertCurrent = () => {
    if (options.signal?.aborted || options.isCurrent?.() === false) {
      throw new ProjectBundleCommitCancelledError();
    }
  };

  assertCurrent();
  if (options.prepare) await options.prepare(plan);
  assertCurrent();
  await options.persist(plan.assetsToPersist);
  // No cancellation check here: once IndexedDB's transaction completed, the
  // project and audio are committed and must be reported as such.
  return true;
};
