const DB_NAME = 'apex-studio-audio';
const STORE_NAME = 'clips';
const DB_VERSION = 1;

interface StoredAudioClip {
  id: string;
  blob: Blob;
  mimeType: string;
  createdAt: number;
}

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('IndexedDB is not available in this environment'));
    return;
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Unable to open audio storage'));
});

export async function persistAudioClip(id: string, blob: Blob): Promise<void> {
  if (!id || !blob.size) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ id, blob, mimeType: blob.type, createdAt: Date.now() } satisfies StoredAudioClip);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Unable to persist audio clip'));
  });
  db.close();
}

export async function getPersistedAudioClip(id: string): Promise<Blob | null> {
  if (!id) return null;
  const db = await openDb();
  const result = await new Promise<StoredAudioClip | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as StoredAudioClip | undefined);
    request.onerror = () => reject(request.error || new Error('Unable to read audio clip'));
  });
  db.close();
  return result?.blob ?? null;
}

export async function deletePersistedAudioClip(id: string): Promise<void> {
  if (!id || typeof indexedDB === 'undefined') return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Unable to delete audio clip'));
  });
  db.close();
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
