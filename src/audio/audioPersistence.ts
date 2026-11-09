const DB_NAME = 'apex-studio-audio';
const AUDIO_STORE_NAME = 'clips';
const PROJECT_STORE_NAME = 'projects';
const DB_VERSION = 2;
const CURRENT_PROJECT_ID = 'current-project';
const RECOVERY_PROJECT_ID = 'recovery-snapshot';
/** Project backups share the `projects` store; the prefix keeps them apart from the live project record. */
export const PROJECT_BACKUP_ID_PREFIX = 'backup:';

interface StoredAudioClip {
  id: string;
  blob: Blob;
  mimeType: string;
  createdAt: number;
}

interface StoredProjectState {
  id: string;
  stateJson: string;
  updatedAt: number;
}

export interface ProjectBundleAudioWrite {
  id: string;
  blob: Blob;
  mimeType: string;
}

export interface ProjectBundleTransactionOptions {
  /** Aborting before the transaction completes rolls back its audio and project writes. */
  signal?: AbortSignal;
  /** Rechecked immediately before opening the transaction. */
  isCurrent?: () => boolean;
  /** Called synchronously from the successful transaction-complete event. */
  onCommitted?: () => void;
}

/** The import was cancelled or superseded before its IndexedDB transaction committed. */
export class ProjectBundleCommitCancelledError extends Error {
  constructor() {
    super('Portable ZIP import was cancelled before commit.');
    this.name = 'ProjectBundleCommitCancelledError';
  }
}

/** An asset id became occupied after the import planner's read-only preflight. */
export class ProjectBundleAudioIdCollisionError extends Error {
  readonly audioId: string;

  constructor(audioId: string) {
    super(`Audio asset "${audioId}" was added while the Portable ZIP import was being committed.`);
    this.name = 'ProjectBundleAudioIdCollisionError';
    this.audioId = audioId;
  }
}

export interface StoredProjectBackup {
  /** Storage key; always starts with PROJECT_BACKUP_ID_PREFIX. */
  id: string;
  /** Project name at backup time (display only). */
  name: string;
  /** Why the backup was taken, e.g. 'replace'. */
  reason: string;
  createdAt: number;
  /** Serialized project document (same format as the live project record, no binary audio). */
  stateJson: string;
}

export const isProjectBackupId = (id: unknown): id is string =>
  typeof id === 'string' && id.startsWith(PROJECT_BACKUP_ID_PREFIX);

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('IndexedDB is not available in this environment'));
    return;
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(AUDIO_STORE_NAME)) db.createObjectStore(AUDIO_STORE_NAME, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(PROJECT_STORE_NAME)) db.createObjectStore(PROJECT_STORE_NAME, { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Unable to open audio storage'));
});

export async function persistAudioClip(id: string, blob: Blob): Promise<void> {
  if (!id || !blob.size) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, 'readwrite');
      tx.objectStore(AUDIO_STORE_NAME).put({ id, blob, mimeType: blob.type, createdAt: Date.now() } satisfies StoredAudioClip);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to persist audio clip'));
      tx.onabort = () => reject(tx.error || new Error('Unable to persist audio clip'));
    });
  } finally {
    db.close();
  }
}

export async function getPersistedAudioClip(id: string): Promise<Blob | null> {
  if (!id) return null;
  const db = await openDb();
  try {
    const result = await new Promise<StoredAudioClip | undefined>((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, 'readonly');
      const request = tx.objectStore(AUDIO_STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result as StoredAudioClip | undefined);
      request.onerror = () => reject(request.error || new Error('Unable to read audio clip'));
      tx.onabort = () => reject(tx.error || new Error('Unable to read audio clip'));
    });
    return result?.blob ?? null;
  } finally {
    db.close();
  }
}

export async function deletePersistedAudioClip(id: string): Promise<void> {
  if (!id || typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, 'readwrite');
      tx.objectStore(AUDIO_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to delete audio clip'));
      tx.onabort = () => reject(tx.error || new Error('Unable to delete audio clip'));
    });
  } finally {
    db.close();
  }
}

export async function listPersistedAudioClipIds(): Promise<string[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDb();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE_NAME, 'readonly');
      const store = tx.objectStore(AUDIO_STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const result = request.result || [];
        resolve(result.map(key => String(key)));
      };
      request.onerror = () => reject(request.error || new Error('Unable to list audio clips'));
      tx.onabort = () => reject(tx.error || new Error('Unable to list audio clips'));
    });
  } finally {
    db.close();
  }
}

export async function persistProjectStateRecord(stateJson: string): Promise<void> {
  if (!stateJson) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readwrite');
      tx.objectStore(PROJECT_STORE_NAME).put({
        id: CURRENT_PROJECT_ID,
        stateJson,
        updatedAt: Date.now()
      } satisfies StoredProjectState);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to persist project state'));
      tx.onabort = () => reject(tx.error || new Error('Unable to persist project state'));
    });
  } finally {
    db.close();
  }
}

export async function getPersistedProjectStateRecord(): Promise<string | null> {
  const db = await openDb();
  try {
    const result = await new Promise<StoredProjectState | undefined>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readonly');
      const request = tx.objectStore(PROJECT_STORE_NAME).get(CURRENT_PROJECT_ID);
      request.onsuccess = () => resolve(request.result as StoredProjectState | undefined);
      request.onerror = () => reject(request.error || new Error('Unable to read project state'));
      tx.onabort = () => reject(tx.error || new Error('Unable to read project state'));
    });
    return result?.stateJson ?? null;
  } finally {
    db.close();
  }
}

/**
 * Keeps a separate last-known-good project snapshot. It is updated only after
 * the live project write succeeds, so a failed/corrupt live write cannot erase
 * the previous recovery point.
 */
export async function persistProjectRecoverySnapshotRecord(stateJson: string): Promise<void> {
  if (!stateJson) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readwrite');
      tx.objectStore(PROJECT_STORE_NAME).put({
        id: RECOVERY_PROJECT_ID,
        stateJson,
        updatedAt: Date.now()
      } satisfies StoredProjectState);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to persist project recovery snapshot'));
      tx.onabort = () => reject(tx.error || new Error('Unable to persist project recovery snapshot'));
    });
  } finally {
    db.close();
  }
}

export async function getPersistedProjectRecoverySnapshotRecord(): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDb();
  try {
    const result = await new Promise<StoredProjectState | undefined>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readonly');
      const request = tx.objectStore(PROJECT_STORE_NAME).get(RECOVERY_PROJECT_ID);
      request.onsuccess = () => resolve(request.result as StoredProjectState | undefined);
      request.onerror = () => reject(request.error || new Error('Unable to read project recovery snapshot'));
      tx.onabort = () => reject(tx.error || new Error('Unable to read project recovery snapshot'));
    });
    return result?.stateJson ?? null;
  } finally {
    db.close();
  }
}

/**
 * Commits a Portable ZIP import's new audio assets, active project, and recovery
 * snapshot as one IndexedDB transaction. Audio uses `add`, never `put`, so a
 * commit-time id collision aborts the whole batch instead of replacing bytes.
 * All Blob work and planning must already be complete before this is called;
 * this function only queues synchronous IndexedDB requests and waits for tx completion.
 */
export async function persistProjectBundleRecords(
  stateJson: string,
  assets: readonly ProjectBundleAudioWrite[],
  options: ProjectBundleTransactionOptions = {}
): Promise<void> {
  if (!stateJson) throw new Error('Cannot commit an empty project bundle state');
  const seenIds = new Set<string>();
  for (const asset of assets) {
    if (!asset.id || asset.blob.size === 0) throw new Error('Cannot commit an empty Portable ZIP audio asset');
    if (seenIds.has(asset.id)) throw new Error(`Duplicate Portable ZIP audio id "${asset.id}"`);
    seenIds.add(asset.id);
  }

  const isCancelled = () => options.signal?.aborted === true || options.isCurrent?.() === false;
  if (isCancelled()) throw new ProjectBundleCommitCancelledError();

  const db = await openDb();
  try {
    // The request may have waited behind other IDB work while the user dismissed
    // or superseded this import. Recheck immediately before opening the tx.
    if (isCancelled()) throw new ProjectBundleCommitCancelledError();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([AUDIO_STORE_NAME, PROJECT_STORE_NAME], 'readwrite');
      let collisionId: string | null = null;
      let setupError: unknown = null;
      const onSignalAbort = () => {
        try { tx.abort(); } catch { /* a completed transaction cannot be rolled back */ }
      };
      const removeAbortListener = () => options.signal?.removeEventListener('abort', onSignalAbort);

      tx.oncomplete = () => {
        removeAbortListener();
        try { options.onCommitted?.(); } catch (error) {
          // The durable transaction is authoritative; a UI notification hook
          // must not turn a committed import into a reported storage failure.
          console.error('[Apex Studio] Portable ZIP commit notification failed.', error);
        }
        resolve();
      };
      tx.onabort = () => {
        removeAbortListener();
        if (isCancelled()) {
          reject(new ProjectBundleCommitCancelledError());
        } else if (collisionId) {
          reject(new ProjectBundleAudioIdCollisionError(collisionId));
        } else if (setupError instanceof Error) {
          reject(setupError);
        } else {
          reject(tx.error || new Error('Portable ZIP project transaction was aborted'));
        }
      };

      options.signal?.addEventListener('abort', onSignalAbort, { once: true });
      if (isCancelled()) {
        try { tx.abort(); } catch (error) { reject(error); }
        return;
      }

      try {
        const clips = tx.objectStore(AUDIO_STORE_NAME);
        const projects = tx.objectStore(PROJECT_STORE_NAME);
        for (const asset of assets) {
          const mimeType = asset.mimeType || asset.blob.type || 'application/octet-stream';
          const blob = asset.blob.type ? asset.blob : new Blob([asset.blob], { type: mimeType });
          const request = clips.add({ id: asset.id, blob, mimeType, createdAt: Date.now() } satisfies StoredAudioClip);
          request.onerror = () => {
            if (request.error?.name === 'ConstraintError') collisionId = asset.id;
            // Do not preventDefault: a failed `add` must abort the whole transaction.
          };
        }

        const updatedAt = Date.now();
        const projectRecord = { stateJson, updatedAt };
        projects.put({ id: CURRENT_PROJECT_ID, ...projectRecord } satisfies StoredProjectState);
        projects.put({ id: RECOVERY_PROJECT_ID, ...projectRecord } satisfies StoredProjectState);
      } catch (error) {
        setupError = error;
        try { tx.abort(); } catch { reject(error); }
      }
    });
  } finally {
    db.close();
  }
}

/** Atomically replaces the active record with a known-good fallback. */
export async function replacePersistedProjectStateRecord(stateJson: string): Promise<void> {
  if (!stateJson) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PROJECT_STORE_NAME);
      store.delete(CURRENT_PROJECT_ID);
      store.put({ id: CURRENT_PROJECT_ID, stateJson, updatedAt: Date.now() } satisfies StoredProjectState);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to replace project state with recovery snapshot'));
      tx.onabort = () => reject(tx.error || new Error('Unable to replace project state with recovery snapshot'));
    });
  } finally {
    db.close();
  }
}

export async function persistProjectBackupRecord(record: StoredProjectBackup): Promise<void> {
  if (!isProjectBackupId(record.id) || !record.stateJson) {
    throw new Error('Invalid project backup record');
  }
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readwrite');
      tx.objectStore(PROJECT_STORE_NAME).put({
        id: record.id,
        name: record.name,
        reason: record.reason,
        createdAt: record.createdAt,
        stateJson: record.stateJson
      } satisfies StoredProjectBackup);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to persist project backup'));
      tx.onabort = () => reject(tx.error || new Error('Unable to persist project backup'));
    });
  } finally {
    db.close();
  }
}

/**
 * Lists every stored project backup (unsorted). Returns an empty list when
 * IndexedDB is unavailable, mirroring listPersistedAudioClipIds so callers can
 * treat "no storage" and "no backups" the same way.
 */
export async function listProjectBackupRecords(): Promise<StoredProjectBackup[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDb();
  try {
    return await new Promise<StoredProjectBackup[]>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readonly');
      const store = tx.objectStore(PROJECT_STORE_NAME);
      const fail = (error: unknown) => reject(error || new Error('Unable to list project backups'));
      const keysRequest = store.getAllKeys();
      keysRequest.onerror = () => fail(keysRequest.error);
      keysRequest.onsuccess = () => {
        const backupKeys = (keysRequest.result || []).map(key => String(key)).filter(isProjectBackupId);
        if (backupKeys.length === 0) {
          resolve([]);
          return;
        }
        const records: StoredProjectBackup[] = [];
        let remaining = backupKeys.length;
        // Issue the reads synchronously inside the success callback so the transaction stays active.
        for (const key of backupKeys) {
          const request = store.get(key);
          request.onerror = () => fail(request.error);
          request.onsuccess = () => {
            const record = request.result as StoredProjectBackup | undefined;
            if (record && typeof record.stateJson === 'string') records.push(record);
            remaining -= 1;
            if (remaining === 0) resolve(records);
          };
        }
      };
      tx.onabort = () => fail(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteProjectBackupRecord(id: string): Promise<void> {
  if (!isProjectBackupId(id) || typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readwrite');
      tx.objectStore(PROJECT_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to delete project backup'));
      tx.onabort = () => reject(tx.error || new Error('Unable to delete project backup'));
    });
  } finally {
    db.close();
  }
}

export async function deletePersistedProjectState(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PROJECT_STORE_NAME);
      store.delete(CURRENT_PROJECT_ID);
      store.delete(RECOVERY_PROJECT_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to delete project state'));
      tx.onabort = () => reject(tx.error || new Error('Unable to delete project state'));
    });
  } finally {
    db.close();
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBlob(base64: string, mimeType = 'audio/webm'): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'audio/webm' });
}

export async function hydrateAudioClip(audioEngine: { loadAudioFile: (file: File | Blob, id: string) => Promise<unknown> }, id: string): Promise<boolean> {
  try {
    const blob = await getPersistedAudioClip(id);
    if (!blob) return false;
    await audioEngine.loadAudioFile(blob, id);
    return true;
  } catch (error) {
    console.warn(`[Apex Studio] Could not hydrate audio clip ${id}`, error);
    return false;
  }
}
