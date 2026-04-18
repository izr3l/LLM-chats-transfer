/**
 * IndexedDB-backed store for captured attachment blobs.
 *
 * Attachment file data is too large for chrome.storage.local (which has a
 * ~10 MB quota and stores everything as JSON strings).  IndexedDB has no
 * practical size limit on extension service workers.
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store a single attachment blob. */
export async function putBlob(blob: AttachmentBlob): Promise<void> {
  if (blob.size > MAX_BLOB_SIZE) {
    throw new Error(`Attachment "${blob.name}" exceeds 25 MB limit (${(blob.size / 1024 / 1024).toFixed(1)} MB).`);
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Store multiple blobs (all-or-nothing within a single transaction). */
export async function putBlobs(blobs: AttachmentBlob[]): Promise<void> {
  if (blobs.length === 0) return;
  const totalSize = blobs.reduce((sum, b) => sum + b.size, 0);
  if (totalSize > MAX_TRANSFER_TOTAL) {
    throw new Error(`Total attachment size ${(totalSize / 1024 / 1024).toFixed(1)} MB exceeds 200 MB limit.`);
  }
  // Validate individual sizes before opening the transaction to avoid leaving
  // an open/aborted transaction on failure.
  const oversizedBlob = blobs.find((blob) => blob.size > MAX_BLOB_SIZE);
  if (oversizedBlob) {
    throw new Error(`Attachment "${oversizedBlob.name}" exceeds 25 MB limit.`);
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const blob of blobs) {
      store.put(blob);
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
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
