import { AttachmentBlob, AttachmentRef, CanonicalConversation } from '../schema/canonical';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;
const HAS_FILE_EXTENSION = /\.[a-z0-9]{1,12}$/i;

interface HarvestedAttachment {
  url: string;
  name?: string;
  mimeType?: string;
}

interface AttachmentResponse {
  status: string;
  transferId?: string;
  urls?: HarvestedAttachment[];
  dataBase64?: string;
  mimeType?: string;
  filename?: string;
  size?: number;
  error?: string;
}

interface AttachmentMessage {
  type: string;
  url?: string;
  transferId?: string;
  stagedTransferId?: string;
  payload?: CanonicalConversation;
  blobs?: AttachmentBlob[];
}

export type AttachmentRequest = (message: AttachmentMessage) => Promise<AttachmentResponse>;

function requestFromBackground(message: AttachmentMessage): Promise<AttachmentResponse> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: 'error', error: 'Attachment request timed out.' }), 45_000);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timeout);
      const error = chrome.runtime.lastError;
      resolve(error ? { status: 'error', error: error.message } : response ?? { status: 'error', error: 'No response.' });
    });
  });
}

function normalizedName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

function normalizeMime(value?: string): string {
  const mime = value?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const aliases: Record<string, string> = {
    'application/x-pdf': 'application/pdf', 'application/vnd.ms-word': 'application/msword',
    'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg',
    'binary/octet-stream': 'application/octet-stream', 'application/x-octet-stream': 'application/octet-stream'
  };
  return aliases[mime] || mime;
}

function mimeMatchesAttachment(response: AttachmentResponse, attachment: AttachmentRef): boolean {
  const actual = normalizeMime(response.mimeType);
  const declared = attachment.mimeType ? normalizeMime(attachment.mimeType) : undefined;
  const extension = attachment.name?.split('.').pop()?.toLowerCase();
  const expected: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  const wanted = declared && declared !== 'application/octet-stream' ? declared : (extension ? expected[extension] : undefined);
  // File endpoints sometimes return JSON describing a download rather than the
  // original bytes. A successful HTTP response is not proof of a captured file.
  if (wanted && wanted !== 'application/octet-stream' && actual !== 'application/octet-stream' && actual !== wanted) return false;
  if (attachment.kind === 'image' && actual !== 'application/octet-stream' && !actual.startsWith('image/')) return false;
  if (wanted === 'application/pdf') {
    const prefix = atob(response.dataBase64!.slice(0, 1368));
    if (!prefix.includes('%PDF-')) return false;
  }
  return true;
}

function isValidDownload(response: AttachmentResponse, attachment: AttachmentRef): boolean {
  if (response.status !== 'success' || typeof response.dataBase64 !== 'string') return false;
  const data = response.dataBase64;
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const byteLength = data.length * 3 / 4 - padding;
  return Number.isSafeInteger(response.size) && response.size === byteLength && byteLength <= MAX_ATTACHMENT_BYTES && mimeMatchesAttachment(response, attachment);
}

/** Capture original file bytes only; previews and unresolved references remain explicit. */
export async function captureAttachmentBlobs(
  conversation: CanonicalConversation,
  request: AttachmentRequest = requestFromBackground
): Promise<AttachmentBlob[]> {
  const attachments = conversation.messages.flatMap((message) => message.attachments ?? []).filter((att) => att.kind !== 'link');
  if (attachments.length === 0) return [];

  let harvested: HarvestedAttachment[] = [];
  if (attachments.some((attachment) => !attachment.url && attachment.name && attachment.sourceHint !== 'image-preview')) {
    try {
      const response = await request({ type: 'HARVEST_FIBER_URLS' });
      if (response.status === 'success' && Array.isArray(response.urls)) {
        const byUrl = new Map<string, HarvestedAttachment>();
        for (const item of response.urls) {
          if (item && typeof item.url === 'string' && typeof item.name === 'string') byUrl.set(item.url, item);
        }
        harvested = [...byUrl.values()];
      }
    } catch { /* DOM URLs still work when a provider does not use React. */ }
  }

  // Never guess by array order: harvesting can include assets from another chat,
  // or more than one original with the same filename.
  const claimed = new Set<string>();
  for (const attachment of attachments) {
    delete attachment.blobAlias;
    delete attachment.blobSize;
    delete attachment.captureError;
    if (attachment.url || !attachment.name || attachment.sourceHint === 'image-preview') continue;
    const name = normalizedName(attachment.name);
    const matches = harvested.filter((item) => item.name && normalizedName(item.name) === name);
    if (matches.length === 1 && !claimed.has(matches[0].url)) {
      attachment.url = matches[0].url;
      attachment.mimeType = attachment.mimeType || matches[0].mimeType;
      claimed.add(matches[0].url);
    }
  }

  const blobs: AttachmentBlob[] = [];
  const downloaded = new Map<string, AttachmentBlob>();
  const failed = new Map<string, string>();
  let totalBytes = 0;

  for (const attachment of attachments) {
    if (!attachment.url) {
      attachment.captureError = 'The source did not expose a downloadable original. Add the original file manually.';
      continue;
    }

    const existing = downloaded.get(attachment.url);
    if (existing) {
      assignBlob(attachment, existing);
      continue;
    }
    if (failed.has(attachment.url)) {
      attachment.captureError = failed.get(attachment.url);
      continue;
    }

    try {
      let response = await request({ type: 'DOWNLOAD_IN_PAGE', url: attachment.url });
      // data: and blob: belong to the source page; background fetch cannot read
      // its object URLs and must not turn those into arbitrary network requests.
      if (!isValidDownload(response, attachment) && /^https:\/\//i.test(attachment.url)) {
        response = await request({ type: 'DOWNLOAD_ATTACHMENT_URL', url: attachment.url });
      }
      if (!isValidDownload(response, attachment)) {
        throw new Error(response.error || 'The original file could not be downloaded, had an unexpected format, or exceeded the 25 MB limit.');
      }
      const size = response.size!;
      if (totalBytes + size > MAX_TRANSFER_BYTES) throw new Error('The transfer exceeds the 200 MB attachment limit.');

      const actualMime = normalizeMime(response.mimeType);
      const mimeType = actualMime !== 'application/octet-stream' ? actualMime : normalizeMime(attachment.mimeType);
      const responseName = response.filename && response.filename !== 'attachment' ? response.filename : undefined;
      const knownName = attachment.name && HAS_FILE_EXTENSION.test(attachment.name)
        ? attachment.name : undefined;
      const imageExtensions: Record<string, string> = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic', 'image/bmp': 'bmp'
      };
      let name = knownName || (responseName && HAS_FILE_EXTENSION.test(responseName) ? responseName : undefined) ||
        (attachment.kind === 'file' ? attachment.name : undefined) || responseName || (attachment.kind === 'image' ? 'image' : 'attachment');
      if (mimeType === 'application/pdf' && !HAS_FILE_EXTENSION.test(name)) name += '.pdf';
      if (attachment.kind === 'image' && !HAS_FILE_EXTENSION.test(name) && imageExtensions[mimeType]) {
        name += `.${imageExtensions[mimeType]}`;
      }
      name = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, '') || 'attachment';
      const blob: AttachmentBlob = {
        transferId: '',
        alias: blobs.length + 1,
        name,
        mimeType,
        dataBase64: response.dataBase64!,
        size
      };
      blobs.push(blob);
      downloaded.set(attachment.url, blob);
      totalBytes += size;
      assignBlob(attachment, blob);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The original file could not be downloaded.';
      attachment.captureError = reason;
      failed.set(attachment.url, reason);
    }
  }

  const unavailable = attachments.filter((attachment) => attachment.blobAlias === undefined).length;
  conversation.metadata.extensions = {
    ...conversation.metadata.extensions,
    attachmentCount: String(attachments.length),
    capturedAttachments: String(blobs.length),
    unavailableAttachments: String(unavailable),
    attachmentMode: unavailable > 0 ? 'partial' : 'original-files'
  };
  return blobs;
}

function assignBlob(attachment: AttachmentRef, blob: AttachmentBlob): void {
  attachment.blobAlias = blob.alias;
  attachment.blobSize = blob.size;
  attachment.name = blob.name;
  attachment.mimeType = blob.mimeType;
  delete attachment.captureError;
}


/** Stage one binary per message, then publish the transcript only when all files exist. */
export async function storeCapturedConversation(
  conversation: CanonicalConversation,
  blobs: AttachmentBlob[],
  request: AttachmentRequest = requestFromBackground
): Promise<string | undefined> {
  const stagedTransferId = blobs.length > 0 ? crypto.randomUUID() : undefined;
  try {
    for (const blob of blobs) {
      const staged = await request({ type: 'STORE_ATTACHMENTS', transferId: stagedTransferId, blobs: [blob] });
      if (staged.status !== 'success') throw new Error(staged.error || 'Could not save a captured attachment.');
    }
    const stored = await request({ type: 'STORE_TRANSCRIPT', payload: conversation, ...(stagedTransferId ? { stagedTransferId } : {}) });
    if (stored.status !== 'success') throw new Error(stored.error || 'Could not save the captured conversation and its files.');
    return stored.transferId;
  } catch (error) {
    if (stagedTransferId) {
      try { await request({ type: 'DISCARD_STAGED_ATTACHMENTS', transferId: stagedTransferId }); }
      catch { /* Keep the original storage error if cleanup also fails. */ }
    }
    throw error;
  }
}
