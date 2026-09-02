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
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id, blob, mimeType: blob.type, createdAt: Date.now() } satisfies StoredAudioClip);
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
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(id);
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
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Unable to delete audio clip'));
      tx.onabort = () => reject(tx.error || new Error('Unable to delete audio clip'));
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
