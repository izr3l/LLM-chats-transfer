/**
 * IndexedDB-backed store for captured attachment blobs.
 *
 * Attachment file data is too large for chrome.storage.local (which has a
 * ~10 MB quota and stores everything as JSON strings). IndexedDB provides
 * more space for ordinary attachments (subject to available disk space).
 *
 * Each blob is keyed by (transferId, alias) so it can be linked back to an
 * AttachmentRef in the canonical transcript.
 */

import { AttachmentBlob } from '../schema/canonical';

const DB_NAME = 'ChatTransferAttachments';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

/** Single attachment blob size cap: 25 MB */
export const MAX_BLOB_SIZE = 25 * 1024 * 1024;

/** Total blobs per transfer cap: 200 MB */
export const MAX_TRANSFER_TOTAL = 200 * 1024 * 1024;

/** Check metadata against the actual encoded byte count before writing any file. */
export function validateAttachmentBlobs(blobs: AttachmentBlob[]): void {
  let totalSize = 0;
  const keys = new Set<string>();
  for (const blob of blobs) {
    if (!blob || typeof blob !== 'object' || typeof blob.transferId !== 'string' || !blob.transferId ||
        !Number.isSafeInteger(blob.alias) || blob.alias < 1 ||
        typeof blob.name !== 'string' || !blob.name.trim() || blob.name.length > 1024 ||
        typeof blob.mimeType !== 'string' || !blob.mimeType.trim() ||
        !Number.isSafeInteger(blob.size) || blob.size < 0 ||
        typeof blob.dataBase64 !== 'string') {
      throw new Error('Invalid attachment metadata.');
    }
    if (blob.size > MAX_BLOB_SIZE) throw new Error(`Attachment "${blob.name}" exceeds 25 MB limit.`);
    const encoded = blob.dataBase64;
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) ||
        encoded.slice(0, encoded.length - padding).includes('=') ||
        encoded.length / 4 * 3 - padding !== blob.size) {
      throw new Error(`Attachment "${blob.name}" has invalid file data or size.`);
    }
    const key = `${blob.transferId}\u0000${blob.alias}`;
    if (keys.has(key)) throw new Error('Duplicate attachment alias.');
    keys.add(key);
    totalSize += blob.size;
  }
  if (totalSize > MAX_TRANSFER_TOTAL) throw new Error('Total attachment size exceeds 200 MB limit.');
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: ['transferId', 'alias'] });
        store.createIndex('byTransfer', 'transferId', { unique: false });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Store a single attachment blob. */
export async function putBlob(blob: AttachmentBlob): Promise<void> {
  return putBlobs([blob]);
}

/** Store multiple blobs (all-or-nothing within a single transaction). */
export async function putBlobs(blobs: AttachmentBlob[]): Promise<void> {
  if (blobs.length === 0) return;
  validateAttachmentBlobs(blobs);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let failure: Error | null = null;
    const transferIds = [...new Set(blobs.map((blob) => blob.transferId))];
    let pending = transferIds.length;
    for (const transferId of transferIds) {
      const req = store.index('byTransfer').getAll(transferId);
      req.onsuccess = () => {
        const sizes = new Map<number, number>((req.result as AttachmentBlob[]).map((blob) => [blob.alias, blob.size]));
        for (const blob of blobs.filter((candidate) => candidate.transferId === transferId)) sizes.set(blob.alias, blob.size);
        if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > MAX_TRANSFER_TOTAL) {
          failure = new Error('Total attachment size exceeds 200 MB limit.');
          tx.abort();
          return;
        }
        pending -= 1;
        if (pending === 0) for (const blob of blobs) store.put(blob);
      };
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(failure || tx.error || new Error('Attachment storage aborted.')); };
  });
}

/** Retrieve a single blob by (transferId, alias). */
export async function getBlob(transferId: string, alias: number): Promise<AttachmentBlob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get([transferId, alias]);
    req.onsuccess = () => { db.close(); resolve((req.result as AttachmentBlob) ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Retrieve all blobs for a given transfer. */
export async function getBlobsByTransfer(transferId: string): Promise<AttachmentBlob[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const idx = tx.objectStore(STORE_NAME).index('byTransfer');
    const req = idx.getAll(transferId);
    req.onsuccess = () => { db.close(); resolve((req.result as AttachmentBlob[]) ?? []); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Delete all blobs for a given transfer. */
export async function deleteBlobsByTransfer(transferId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('byTransfer');
    const cursor = idx.openCursor(transferId);
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { c.delete(); c.continue(); }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Delete individual blob. */
export async function deleteBlob(transferId: string, alias: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete([transferId, alias]);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
