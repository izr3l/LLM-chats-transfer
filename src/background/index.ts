// Background script handles cross-tab messages and encrypted persistence.

import { AttachmentBlob, CanonicalConversation, isValidCanonicalConversation, MAX_PAYLOAD_SIZE } from '../schema/canonical';
import { putBlobs, getBlobsByTransfer, getBlob, deleteBlob, deleteBlobsByTransfer, MAX_BLOB_SIZE, validateAttachmentBlobs } from './attachmentStore';
import { ATTACHMENT_HOSTS, downloadAttachment } from './attachmentDownload';

type EncryptedPacket = { iv: string; ciphertext: string };

// ===== AI PROVIDER TABLE =====
// All providers expose an OpenAI-compatible chat completions API,
// so one fetch call covers all of them — no separate adapters needed.
type ProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  envKey: string | undefined;
};

const AI_PROVIDERS: Record<string, ProviderConfig> = {
  groq: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    envKey: process.env.GROQ_API_KEY,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4-nano',
    envKey: process.env.OPENAI_API_KEY,
  },
};

const DEFAULT_PROVIDER_ID = 'groq';

type StoredAiConfig = { providerId: string; encryptedKey?: EncryptedPacket };

type TransferHistoryEntry = {
  id: string;
  /** Stable file-store key; retained when a history item becomes active again. */
  attachmentTransferId?: string;
  createdAt: string;
  source: string;
  title: string;
  messageCount: number;
  attachmentCount: number;
  sha256?: string;
  encrypted: EncryptedPacket;
};

const rateLimiter = new Map<string, number>();
const RATE_LIMIT_MS = 500;
const ATTACHMENT_MESSAGES = new Set([
  'DOWNLOAD_ATTACHMENT_URL', 'DOWNLOAD_IN_PAGE', 'HARVEST_FIBER_URLS',
  'STORE_ATTACHMENTS', 'FETCH_ATTACHMENTS', 'FETCH_ATTACHMENT',
  'DISCARD_STAGED_ATTACHMENTS', 'RESTORE_CAPTURE_ATTACHMENT',
  'FETCH_TRANSCRIPT', 'PREVIEW_TRANSCRIPT', 'HAS_TRANSCRIPT',
]);

function isRateLimited(type: string): boolean {
  const lastCall = rateLimiter.get(type) ?? 0;
  const now = Date.now();
  if (now - lastCall < RATE_LIMIT_MS) return true;
  rateLimiter.set(type, now);
  return false;
}


const ALLOWED_ORIGINS = [
  'claude.ai',
  'chatgpt.com',
  'gemini.google.com',
  'manus.im',
  'manus.com',
  'manus.ai',
  'manus.computer',
  'chat.qwen.ai',
  'qwen.ai',
  'qwenlm.ai',
  'perplexity.ai',
  'x.com'
];

function isAllowedSender(sender: chrome.runtime.MessageSender): boolean {
  // Always allow messages from the extension itself (popup, background)
  if (sender.id === chrome.runtime.id && !sender.tab) {
    return true;
  }

  // For content scripts, validate the tab URL
  const senderUrl = sender.tab?.url ?? sender.url ?? '';
  if (!senderUrl) return false;

  try {
    const hostname = new URL(senderUrl).hostname;
    return ALLOWED_ORIGINS.some((origin) => hostname === origin || hostname.endsWith(`.${origin}`));
  } catch {
    return false;
  }
}

// --- Crypto helpers ---

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isEncryptedPacket(value: unknown): value is EncryptedPacket {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybePacket = value as { iv?: unknown; ciphertext?: unknown };
  return typeof maybePacket.iv === 'string' && typeof maybePacket.ciphertext === 'string';
}

async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  const result = await chrome.storage.local.get(['encryptionKeyV2']);
  if (typeof result.encryptionKeyV2 === 'string') {
    const keyBytes = base64ToBytes(result.encryptionKeyV2);
    return crypto.subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // Migrate from old session-based key if present
  try {
    const sessionResult = await chrome.storage.session.get(['pendingTransferKey']);
    if (typeof sessionResult.pendingTransferKey === 'string') {
      // Persist the session key to local storage so it survives restarts
      await chrome.storage.local.set({ encryptionKeyV2: sessionResult.pendingTransferKey });
      await chrome.storage.session.remove(['pendingTransferKey']);
      const keyBytes = base64ToBytes(sessionResult.pendingTransferKey);
      return crypto.subtle.importKey(
        'raw',
        toArrayBuffer(keyBytes),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
    }
  } catch {
    // session storage may not be available — proceed to generate new key
  }

  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const keyBase64 = bytesToBase64(rawKey);
  await chrome.storage.local.set({ encryptionKeyV2: keyBase64 });
  return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptPayload(payload: unknown): Promise<{ iv: string; ciphertext: string }> {
  const key = await getOrCreateEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted))
  };
}

// Encrypt / decrypt raw strings (used for API keys)
async function encryptString(text: string): Promise<EncryptedPacket> {
  const key = await getOrCreateEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decryptString(packet: EncryptedPacket): Promise<string> {
  const key = await getOrCreateEncryptionKey();
  const ivBytes = base64ToBytes(packet.iv);
  const ciphertextBytes = base64ToBytes(packet.ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(ivBytes) },
    key,
    toArrayBuffer(ciphertextBytes)
  );
  return new TextDecoder().decode(decrypted);
}

// Resolve active provider config + decrypted API key
async function getActiveAiConfig(): Promise<{ provider: ProviderConfig; apiKey: string } | null> {
  const result = await chrome.storage.local.get(['aiConfig']);
  const stored = result.aiConfig as StoredAiConfig | undefined;

  const providerId = stored?.providerId ?? DEFAULT_PROVIDER_ID;
  const provider = AI_PROVIDERS[providerId] ?? AI_PROVIDERS[DEFAULT_PROVIDER_ID];

  // Prefer user's encrypted key
  if (stored?.encryptedKey && isEncryptedPacket(stored.encryptedKey)) {
    try {
      const apiKey = await decryptString(stored.encryptedKey);
      if (apiKey.trim()) return { provider, apiKey: apiKey.trim() };
    } catch { /* fall through */ }
  }

  // Fall back to env var for the selected provider
  const envKey = provider.envKey;
  if (envKey?.trim()) return { provider, apiKey: envKey.trim() };

  return null;
}

async function decryptPayload(encryptedPacket: EncryptedPacket | undefined): Promise<CanonicalConversation | null> {
  if (!encryptedPacket) {
    return null;
  }

  const key = await getOrCreateEncryptionKey();
  const ivBytes = base64ToBytes(encryptedPacket.iv);
  const ciphertextBytes = base64ToBytes(encryptedPacket.ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(ivBytes) },
    key,
    toArrayBuffer(ciphertextBytes)
  );

  const text = new TextDecoder().decode(decrypted);
  const parsed: unknown = JSON.parse(text);

  // Validate schema after decryption to catch corrupted or tampered data
  if (!isValidCanonicalConversation(parsed)) {
    console.error('Decrypted payload failed schema validation.');
    return null;
  }

  return parsed;
}

async function getHistory(): Promise<TransferHistoryEntry[]> {
  const result = await chrome.storage.local.get(['transferHistory']);
  if (!Array.isArray(result.transferHistory)) {
    return [];
  }

  return result.transferHistory.filter((entry: unknown) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const candidate = entry as {
      id?: unknown;
      createdAt?: unknown;
      source?: unknown;
      title?: unknown;
      messageCount?: unknown;
      attachmentCount?: unknown;
      encrypted?: unknown;
    };

    return (
      typeof candidate.id === 'string' &&
      typeof candidate.createdAt === 'string' &&
      typeof candidate.source === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.messageCount === 'number' &&
      (candidate.attachmentCount === undefined || typeof candidate.attachmentCount === 'number') &&
      isEncryptedPacket(candidate.encrypted)
    );
  }).map((entry: TransferHistoryEntry) => ({
    ...entry,
    attachmentCount: typeof entry.attachmentCount === 'number' ? entry.attachmentCount : 0
  })) as TransferHistoryEntry[];
}

function toHistoryEntry(payload: CanonicalConversation, encrypted: EncryptedPacket, transferId: string): TransferHistoryEntry {
  const count = payload.integrity?.messageCount ?? payload.messages.length;

  const attachmentCount = payload.messages.reduce((sum: number, msg) => {
    if (!Array.isArray(msg.attachments)) {
      return sum;
    }
    return sum + msg.attachments.length;
  }, 0);

  return {
    id: transferId,
    attachmentTransferId: transferId,
    createdAt: new Date().toISOString(),
    source: payload.metadata.source ?? 'unknown',
    title: payload.metadata.title ?? 'Untitled chat',
    messageCount: count,
    attachmentCount,
    sha256: payload.integrity?.sha256,
    encrypted
  };
}

async function isReferencedTransfer(transferId: string): Promise<boolean> {
  const { activeTransferId } = await chrome.storage.local.get(['activeTransferId']);
  if (activeTransferId === transferId) return true;
  return (await getHistory()).some((item) => (item.attachmentTransferId || item.id) === transferId);
}

function isValidTransferId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

// Keep reads and writes of the active transfer and history together when
// several tabs capture, restore files, or change the selected conversation.
let transferWrites: Promise<unknown> = Promise.resolve();

function withTransferWrite<T>(write: () => Promise<T>): Promise<T> {
  const next = transferWrites.then(write);
  transferWrites = next.catch(() => undefined);
  return next;
}

async function restoreCaptureAttachment(request: {
  transferId?: unknown;
  messageId?: unknown;
  attachmentId?: unknown;
  file?: unknown;
}): Promise<{ status: 'success'; transferId: string; name: string }> {
  const { transferId, messageId, attachmentId, file } = request;
  if (!isValidTransferId(transferId) || typeof messageId !== 'string' || typeof attachmentId !== 'string' ||
      !file || typeof file !== 'object') {
    throw new Error('Select a missing attachment and choose its original file.');
  }

  const { activeTransferId, pendingTransferEncrypted } =
    await chrome.storage.local.get(['activeTransferId', 'pendingTransferEncrypted']);
  if (activeTransferId !== transferId || !isEncryptedPacket(pendingTransferEncrypted)) {
    throw new Error('The selected capture changed. Select the capture again before adding its file.');
  }
  const payload = await decryptPayload(pendingTransferEncrypted);
  const ref = payload?.messages.find((message) => message.id === messageId)
    ?.attachments?.find((attachment) => attachment.id === attachmentId);
  if (!payload || !ref || ref.kind === 'link') {
    throw new Error('This attachment is no longer in the selected capture.');
  }
  if (ref.blobAlias !== undefined) {
    throw new Error('This capture already has a file for that attachment.');
  }

  const attachments = payload.messages.flatMap((message) => message.attachments ?? [])
    .filter((attachment) => attachment.kind !== 'link');
  const highestAlias = attachments.reduce((highest, attachment) => Math.max(highest, attachment.blobAlias ?? 0), 0);
  let alias = highestAlias + 1;
  // Skip any unreferenced blob left by a failed or older capture.
  while (Number.isSafeInteger(alias) && await getBlob(transferId, alias)) alias += 1;
  const { name, mimeType, dataBase64, size } = file as AttachmentBlob;
  const blob = { transferId, alias, name, mimeType, dataBase64, size };
  validateAttachmentBlobs([blob]);

  ref.name = name;
  ref.mimeType = mimeType;
  ref.blobAlias = blob.alias;
  ref.blobSize = size;
  delete ref.captureError;
  const unavailable = attachments.filter((attachment) => attachment.blobAlias === undefined).length;
  const captured = new Set(attachments.flatMap((attachment) =>
    attachment.blobAlias === undefined ? [] : [attachment.blobAlias])).size;
  payload.metadata.updatedAt = new Date().toISOString();
  payload.metadata.extensions = {
    ...payload.metadata.extensions,
    attachmentCount: String(attachments.length),
    capturedAttachments: String(captured),
    unavailableAttachments: String(unavailable),
    attachmentMode: unavailable > 0 ? 'partial' : 'original-files',
  };

  const serialized = JSON.stringify({ metadata: payload.metadata, messages: payload.messages });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  payload.integrity = { messageCount: payload.messages.length, sha256 };
  if (JSON.stringify(payload).length > MAX_PAYLOAD_SIZE) throw new Error('The capture exceeds the 5 MB transcript limit.');

  const encrypted = await encryptPayload(payload);
  const history = await getHistory();
  const nextHistory = history.map((entry) => (entry.attachmentTransferId || entry.id) === transferId
    ? { ...entry, encrypted, sha256 }
    : entry);
  await putBlobs([blob]);
  try {
    await chrome.storage.local.set({ pendingTransferEncrypted: encrypted, transferHistory: nextHistory });
  } catch (error) {
    await deleteBlob(transferId, blob.alias).catch(console.warn);
    throw error;
  }
  return { status: 'success', transferId, name };
}

// --- Main message handler ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const messageType = typeof request?.type === 'string' ? request.type : '';
  if (messageType && !ATTACHMENT_MESSAGES.has(messageType) && isRateLimited(messageType)) {
    sendResponse({ status: 'error', error: 'Rate limited. Please wait.' });
    return true;
  }

  if (!isAllowedSender(sender)) {
    sendResponse({ status: 'error', error: 'Unauthorized sender.' });
    return true;
  }

  if (request.type === 'CAPTURE_ACTIVE_TAB') {
    (async () => {
      try {
        const sourceTab = sender.tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (sourceTab?.id === undefined || !isAllowedSender({ id: sender.id, tab: sourceTab } as chrome.runtime.MessageSender)) {
          throw new Error('Open a supported AI conversation before capturing.');
        }
        await chrome.scripting.executeScript({ target: { tabId: sourceTab.id }, files: ['content-source.js'] });
        const result = await chrome.tabs.sendMessage(sourceTab.id, { type: 'EXTRACT' });
        sendResponse(result ?? { status: 'error', error: 'Capture returned no response. Refresh the source page and try again.' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({ status: 'error', error: `${message} Refresh the source page and try Capture again.` });
      }
    })();
    return true;
  }

  if (request.type === 'STORE_TRANSCRIPT') {
    void withTransferWrite(async () => {
      try {
        if (!isValidCanonicalConversation(request.payload)) {
          sendResponse({ status: 'error', error: 'Invalid payload: schema validation failed.' });
          return;
        }

        const payloadSize = JSON.stringify(request.payload).length;
        if (payloadSize > MAX_PAYLOAD_SIZE) {
          sendResponse({ status: 'error', error: `Payload too large (${(payloadSize / 1024 / 1024).toFixed(1)} MB). Max is 5 MB.` });
          return;
        }

        const hasStagedFiles = request.stagedTransferId !== undefined;
        if (hasStagedFiles && !isValidTransferId(request.stagedTransferId)) throw new Error('Invalid staged transfer ID.');
        const transferId = hasStagedFiles ? request.stagedTransferId as string
          : typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        if (hasStagedFiles && await isReferencedTransfer(transferId)) throw new Error('Transfer is already published.');

        if (request.blobs !== undefined && !Array.isArray(request.blobs)) throw new Error('Invalid attachments.');
        if (hasStagedFiles && request.blobs?.length) throw new Error('Cannot combine staged and inline attachments.');
        const blobs = hasStagedFiles ? await getBlobsByTransfer(transferId)
          : (request.blobs ?? []).map((blob: AttachmentBlob) => ({ ...blob, transferId })) as AttachmentBlob[];
        validateAttachmentBlobs(blobs);
        // Every captured alias must resolve before the transcript becomes visible.
        const aliases = new Set(blobs.map((blob) => blob.alias));
        for (const message of (request.payload as CanonicalConversation).messages) {
          for (const attachment of message.attachments ?? []) {
            if (attachment.blobAlias !== undefined && !aliases.has(attachment.blobAlias)) {
              throw new Error(`Missing file data for attachment "${attachment.name || attachment.id}".`);
            }
          }
        }

        const encryptedTranscript = await encryptPayload(request.payload);

        const historyEntry = toHistoryEntry(request.payload as CanonicalConversation, encryptedTranscript, transferId);
        const existingHistory = await getHistory();
        const previousHistory = [...existingHistory];
        const { activeTransferId: previousActiveId } = await chrome.storage.local.get(['activeTransferId']);

        // If a chat with the same source + title already exists, replace it
        const duplicateIndex = existingHistory.findIndex(
          (entry) => entry.source === historyEntry.source && entry.title === historyEntry.title
        );
        let nextHistory: TransferHistoryEntry[];
        if (duplicateIndex >= 0) {
          // Remove the old duplicate, then prepend the new one
          existingHistory.splice(duplicateIndex, 1);
          nextHistory = [historyEntry, ...existingHistory].slice(0, 30);
        } else {
          nextHistory = [historyEntry, ...existingHistory].slice(0, 30);
        }

        const payloadMeta = request.payload as CanonicalConversation;
        if (!hasStagedFiles) await putBlobs(blobs);
        try {
          await chrome.storage.local.set({
            pendingTransferEncrypted: encryptedTranscript,
            activeTransferId: transferId,
            transferHistory: nextHistory,
            pendingTransferMeta: {
              source: payloadMeta.metadata.source ?? 'unknown',
              title: payloadMeta.metadata.title ?? 'Untitled'
            }
          });
        } catch (error) {
          await deleteBlobsByTransfer(transferId).catch(() => undefined);
          throw error;
        }

        // A replacement or history trim also releases its now-unreferenced files.
        const keptIds = new Set(nextHistory.map((item) => item.attachmentTransferId || item.id));
        for (const old of previousHistory) {
          const oldTransferId = old.attachmentTransferId || old.id;
          if (!keptIds.has(oldTransferId)) await deleteBlobsByTransfer(oldTransferId).catch(console.warn);
        }
        if (typeof previousActiveId === 'string' && !keptIds.has(previousActiveId)) {
          await deleteBlobsByTransfer(previousActiveId).catch(console.warn);
        }

        sendResponse({ status: 'success', transferId });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    });

    return true;
  }

  if (request.type === 'RESTORE_CAPTURE_ATTACHMENT') {
    void withTransferWrite(() => restoreCaptureAttachment(request)).then(sendResponse, (error: unknown) => {
      sendResponse({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (request.type === 'FETCH_TRANSCRIPT') {
    (async () => {
      try {
        const load = () => chrome.storage.local.get(['pendingTransferEncrypted', 'pendingTransfer', 'activeTransferId']);
        let result = await load();

        if (result.pendingTransfer && !result.pendingTransferEncrypted) {
          try {
            result = await withTransferWrite(async () => {
              const current = await load();
              if (current.pendingTransfer && !current.pendingTransferEncrypted) {
                try {
                  current.pendingTransferEncrypted = await encryptPayload(current.pendingTransfer);
                  await chrome.storage.local.set({ pendingTransferEncrypted: current.pendingTransferEncrypted });
                } finally {
                  await chrome.storage.local.remove(['pendingTransfer']);
                }
              }
              return current;
            });
          } catch {
            sendResponse({ payload: null, error: 'Failed to migrate legacy plaintext data.' });
            return;
          }
        }

        const payload = isEncryptedPacket(result.pendingTransferEncrypted)
          ? await decryptPayload(result.pendingTransferEncrypted)
          : null;
        sendResponse({ payload: payload ?? null, transferId: result.activeTransferId ?? null });
      } catch (error) {
        sendResponse({ payload: null, error: String(error) });
      }
    })();

    return true;
  }

  if (request.type === 'HAS_TRANSCRIPT') {
    (async () => {
      const result = await chrome.storage.local.get(['pendingTransferEncrypted', 'pendingTransferMeta']);
      const hasTranscript = Boolean(result.pendingTransferEncrypted);
      const meta = hasTranscript && result.pendingTransferMeta ? result.pendingTransferMeta as { source: string; title: string } : null;
      sendResponse({ hasTranscript, meta });
    })();

    return true;
  }

  if (request.type === 'LIST_HISTORY') {
    (async () => {
      const history = await getHistory();
      sendResponse({
        items: history.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          source: item.source,
          title: item.title,
          messageCount: item.messageCount,
          attachmentCount: item.attachmentCount,
          sha256: item.sha256
        }))
      });
    })();

    return true;
  }

  if (request.type === 'LOAD_HISTORY_ITEM') {
    void withTransferWrite(async () => {
      const itemId = typeof request.id === 'string' ? request.id : '';
      const history = await getHistory();
      const item = history.find((entry) => entry.id === itemId);
      if (!item) {
        sendResponse({ status: 'error', error: 'History item not found.' });
        return;
      }

      const transferId = item.attachmentTransferId || item.id;

      await chrome.storage.local.set({
        pendingTransferEncrypted: item.encrypted,
        activeTransferId: transferId,
        pendingTransferMeta: {
          source: item.source,
          title: item.title
        }
      });
      sendResponse({ status: 'success', transferId });
    }).catch((error: unknown) => sendResponse({ status: 'error', error: String(error) }));

    return true;
  }

  if (request.type === 'CLEAR_HISTORY') {
    void withTransferWrite(async () => {
      try {
        const history = await getHistory();
        const { activeTransferId } = await chrome.storage.local.get(['activeTransferId']);
        await chrome.storage.local.set({ transferHistory: [] });
        for (const item of history) {
          const transferId = item.attachmentTransferId || item.id;
          if (transferId !== activeTransferId) await deleteBlobsByTransfer(transferId);
        }
        sendResponse({ status: 'success' });
      } catch (error) { sendResponse({ status: 'error', error: String(error) }); }
    });

    return true;
  }

  if (request.type === 'DELETE_HISTORY_ITEM') {
    void withTransferWrite(async () => {
      try {
        const itemId = typeof request.id === 'string' ? request.id : '';
        const history = await getHistory();
        const item = history.find((entry) => entry.id === itemId);
        const updatedHistory = history.filter((entry) => entry.id !== itemId);
        const { activeTransferId } = await chrome.storage.local.get(['activeTransferId']);
        await chrome.storage.local.set({ transferHistory: updatedHistory });
        const transferId = item?.attachmentTransferId || item?.id;
        if (transferId && transferId !== activeTransferId) await deleteBlobsByTransfer(transferId);
        sendResponse({ status: 'success' });
      } catch (error) { sendResponse({ status: 'error', error: String(error) }); }
    });

    return true;
  }

  if (request.type === 'PREVIEW_TRANSCRIPT') {
    (async () => {
      try {
        const result = await chrome.storage.local.get(['pendingTransferEncrypted', 'activeTransferId']);
        const payload = isEncryptedPacket(result.pendingTransferEncrypted)
          ? await decryptPayload(result.pendingTransferEncrypted)
          : null;
        sendResponse({ payload: payload ?? null, transferId: result.activeTransferId ?? null });
      } catch (error) {
        sendResponse({ payload: null, error: String(error) });
      }
    })();

    return true;
  }

  // --- Summarize: Uses active AI provider (Groq or OpenAI — identical OpenAI-compatible API) ---
  if (request.type === 'SUMMARIZE_TRANSCRIPT') {
    (async () => {
      try {
        const result = await chrome.storage.local.get(['pendingTransferEncrypted']);
        const transcript = isEncryptedPacket(result.pendingTransferEncrypted)
          ? await decryptPayload(result.pendingTransferEncrypted)
          : null;

        if (!transcript || transcript.messages.length === 0) {
          sendResponse({ status: 'error', error: 'No transcript available to summarize. Capture a chat first.' });
          return;
        }

        // Build conversation text for the summarizer
        let conversationText = `Source: ${transcript.metadata.source}\n`;
        conversationText += `Title: ${transcript.metadata.title ?? 'Untitled'}\n`;
        conversationText += `Messages: ${transcript.messages.length}\n\n`;

        transcript.messages.forEach((msg, i) => {
          const text = msg.content.map(c => c.text).join('\n');
          conversationText += `[${msg.role.toUpperCase()} - Message ${i + 1}]\n${text}\n\n`;
        });

        const MAX_CHARS = 60000;
        if (conversationText.length > MAX_CHARS) {
          conversationText = conversationText.slice(0, MAX_CHARS) + '\n\n[... truncated for length ...]';
        }

        // Resolve provider + API key (user encrypted key → env var fallback)
        const aiConfig = await getActiveAiConfig();
        if (!aiConfig) {
          sendResponse({ status: 'error', error: 'No AI provider configured. Add an API key in Settings (gear icon).' });
          return;
        }
        const { provider, apiKey } = aiConfig;

        const aiResponse = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: provider.model,
            messages: [
              {
                role: 'system',
                content: `You are a precise conversation summarizer. Produce a well-structured markdown summary of the provided LLM chat conversation. Your summary should include:

1. **Overview** — A 2-3 sentence high-level summary of the entire conversation.
2. **Key Topics Discussed** — Bullet list of the main subjects covered.
3. **Decisions & Outcomes** — Any conclusions reached, code produced, or actions agreed upon.
4. **Notable Details** — Important technical details, links, code snippets, or data points worth preserving.
5. **Open Items** — Any unresolved questions or next steps mentioned.

Keep the summary concise but comprehensive. Use markdown formatting (headers, bullets, code blocks) for clarity.`
              },
              {
                role: 'user',
                content: `Please summarize this conversation:\n\n${conversationText}`
              }
            ],
            temperature: 0.3,
            ...(provider.id === 'openai'
              ? { max_completion_tokens: 3000 }
              : { max_tokens: 3000 })
          })
        });

        if (!aiResponse.ok) {
          const errorBody = await aiResponse.text();
          sendResponse({ status: 'error', error: `${provider.name} API error (${aiResponse.status}): ${errorBody}` });
          return;
        }

        const aiData = await aiResponse.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const summary = aiData.choices?.[0]?.message?.content ?? '';
        if (!summary) {
          sendResponse({ status: 'error', error: `${provider.name} returned an empty summary.` });
          return;
        }

        sendResponse({
          status: 'success',
          summary,
          source: transcript.metadata.source,
          title: transcript.metadata.title ?? 'Untitled',
          messageCount: transcript.messages.length,
          providerName: provider.name
        });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    })();

    return true;
  }

  // --- Save AI config (provider + encrypted API key) ---
  if (request.type === 'SAVE_AI_CONFIG') {
    (async () => {
      try {
        const providerId = typeof request.providerId === 'string' && AI_PROVIDERS[request.providerId]
          ? request.providerId
          : DEFAULT_PROVIDER_ID;
        const plainApiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';

        const stored: StoredAiConfig = { providerId };
        if (plainApiKey) {
          stored.encryptedKey = await encryptString(plainApiKey);
        }
        await chrome.storage.local.set({ aiConfig: stored });
        sendResponse({ status: 'success' });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    })();
    return true;
  }

  // --- Get AI config metadata (never exposes the raw key) ---
  if (request.type === 'GET_AI_CONFIG_META') {
    (async () => {
      const result = await chrome.storage.local.get(['aiConfig']);
      const stored = result.aiConfig as StoredAiConfig | undefined;
      const providerId = stored?.providerId ?? DEFAULT_PROVIDER_ID;
      const hasKey = Boolean(stored?.encryptedKey && isEncryptedPacket(stored.encryptedKey));
      sendResponse({ status: 'success', providerId, hasKey });
    })();
    return true;
  }

  // --- Remove AI config key (keeps provider selection, reverts to env var fallback) ---
  if (request.type === 'REMOVE_AI_CONFIG') {
    (async () => {
      const result = await chrome.storage.local.get(['aiConfig']);
      const stored = result.aiConfig as StoredAiConfig | undefined;
      await chrome.storage.local.set({ aiConfig: { providerId: stored?.providerId ?? DEFAULT_PROVIDER_ID } });
      sendResponse({ status: 'success' });
    })();
    return true;
  }

  // --- Store captured attachment blobs into IndexedDB ---
  if (request.type === 'STORE_ATTACHMENTS') {
    void withTransferWrite(async () => {
      try {
        const transferId = typeof request.transferId === 'string' ? request.transferId : '';
        if (!Array.isArray(request.blobs)) throw new Error('Invalid attachments.');
        const blobs = request.blobs as AttachmentBlob[];

        if (!isValidTransferId(transferId)) {
          sendResponse({ status: 'error', error: 'Invalid transferId.' });
          return;
        }
        if (await isReferencedTransfer(transferId)) throw new Error('Cannot change files of a published transfer.');
        if (blobs.length === 0) {
          sendResponse({ status: 'success', stored: 0 });
          return;
        }

        // Tag each blob with the transfer ID
        const tagged = blobs.map((b) => ({ ...b, transferId }));
        await putBlobs(tagged);
        sendResponse({ status: 'success', stored: tagged.length });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    });
    return true;
  }

  // Discard a failed capture without permitting the deletion of active/history files.
  if (request.type === 'DISCARD_STAGED_ATTACHMENTS') {
    void withTransferWrite(async () => {
      try {
        const transferId = request.transferId;
        if (!isValidTransferId(transferId)) throw new Error('Invalid transferId.');
        if (await isReferencedTransfer(transferId)) throw new Error('Cannot discard a published transfer.');
        await deleteBlobsByTransfer(transferId);
        sendResponse({ status: 'success' });
      } catch (error) { sendResponse({ status: 'error', error: String(error) }); }
    });
    return true;
  }

  // --- Fetch all attachment blobs for the active transfer ---
  if (request.type === 'FETCH_ATTACHMENTS') {
    (async () => {
      try {
        const result = await chrome.storage.local.get(['activeTransferId']);
        const transferId = typeof request.transferId === 'string'
          ? request.transferId
          : (typeof result.activeTransferId === 'string' ? result.activeTransferId : '');

        if (!transferId) {
          sendResponse({ status: 'success', blobs: [] });
          return;
        }

        const blobs = await getBlobsByTransfer(transferId);
        if (blobs.reduce((size, blob) => size + blob.dataBase64.length, 0) > 48 * 1024 * 1024) {
          throw new Error('This transfer contains too much file data for one message. Fetch attachments individually.');
        }
        sendResponse({ status: 'success', blobs });
      } catch (error) {
        sendResponse({ status: 'error', blobs: [], error: String(error) });
      }
    })();
    return true;
  }

  // --- Fetch a single attachment blob by alias ---
  if (request.type === 'FETCH_ATTACHMENT') {
    (async () => {
      try {
        const result = await chrome.storage.local.get(['activeTransferId']);
        const transferId = typeof request.transferId === 'string'
          ? request.transferId
          : (typeof result.activeTransferId === 'string' ? result.activeTransferId : '');
        const alias = typeof request.alias === 'number' ? request.alias : -1;

        if (!transferId || alias < 0) {
          sendResponse({ blob: null });
          return;
        }

        const blob = await getBlob(transferId, alias);
        sendResponse({ blob: blob ?? null });
      } catch (error) {
        sendResponse({ blob: null, error: String(error) });
      }
    })();
    return true;
  }

  // --- Download a file from URL (used by content scripts for cross-origin attachment fetching) ---
  if (request.type === 'DOWNLOAD_ATTACHMENT_URL') {
    (async () => {
      try {
        const url = typeof request.url === 'string' ? request.url : '';
        if (!url) {
          sendResponse({ status: 'error', error: 'Missing URL.' });
          return;
        }

        sendResponse(await downloadAttachment(url, { maxSize: MAX_BLOB_SIZE, allowedHosts: ATTACHMENT_HOSTS }));
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    })();
    return true;
  }

  // --- Harvest attachment URLs from React fiber tree (MAIN world injection) ---
  if (request.type === 'HARVEST_FIBER_URLS') {
    (async () => {
      try {
        const tabId = sender.tab?.id ?? (typeof request.tabId === 'number' ? request.tabId : undefined);
        if (tabId === undefined) {
          sendResponse({ status: 'error', error: 'No tab ID available.' });
          return;
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          args: [ATTACHMENT_HOSTS],
          func: (allowedHosts: string[]) => {
            // Inline harvester that runs in MAIN world (has access to React internals)
            const ALLOWED_HOSTS = allowedHosts;

            function isAllowed(url: string): boolean {
              try {
                const h = new URL(url).hostname;
                return ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
              } catch { return false; }
            }

            function isAttUrl(url: string): boolean {
              if (!url || typeof url !== 'string' || !url.startsWith('https://')) return false;
              if (!isAllowed(url)) return false;
              if (/\/(avatar|icon|favicon|thumbnail|thumb|logo)/i.test(url)) return false;
              return true;
            }

            const found = new Map<string, { url: string; name?: string; mimeType?: string }>();
            const MAX_DEPTH = 12;
            let examinedObjects = 0;
            const SKIP_KEYS = new Set([
              '_owner', '_debugOwner', '_store', 'store', 'state', 'stateNode',
              'memoizedState', 'memoizedProps', 'pendingProps', 'return', 'alternate',
              'child', 'sibling', 'parent', 'parentNode', 'parentElement', 'root',
              'context', '_context', 'dependencies', 'updateQueue',
            ]);

            function scan(obj: unknown, depth: number, vis: Set<unknown>): void {
              if (depth > MAX_DEPTH || vis.size > 1000 || examinedObjects++ > 20000) return;
              if (!obj || typeof obj !== 'object' || (typeof Node !== 'undefined' && obj instanceof Node)) return;
              if (vis.has(obj)) return;
              vis.add(obj);
              const r = obj as Record<string, unknown>;
              // Check all URL-like keys specific to file attachments
              const URL_KEYS = ['url', 'download_url', 'downloadUrl', 'file_url', 'fileUrl',
                'signedUrl', 'signed_url', 'asset_pointer', 'src', 'href'];
              for (const uk of URL_KEYS) {
                const v = r[uk];
                if (typeof v === 'string' && v.startsWith('https://') && isAttUrl(v) && !found.has(v)) {
                  const nm = typeof r['name'] === 'string' ? r['name']
                    : typeof r['fileName'] === 'string' ? r['fileName']
                      : typeof r['file_name'] === 'string' ? r['file_name']
                        : typeof r['title'] === 'string' ? r['title'] : undefined;
                  const mt = typeof r['mimeType'] === 'string' ? r['mimeType']
                    : typeof r['content_type'] === 'string' ? r['content_type']
                      : typeof r['mime_type'] === 'string' ? r['mime_type'] : undefined;
                  found.set(v, { url: v, name: nm, mimeType: mt });
                }
              }
              // Also check ChatGPT's asset_pointer pattern: file-service://file-xxxx
              if (typeof r['asset_pointer'] === 'string' && (r['asset_pointer'] as string).startsWith('file-service://')) {
                // The actual download URL may be in a sibling key
                const dlUrl = r['download_url'] || r['downloadUrl'] || r['url'];
                if (typeof dlUrl === 'string' && isAttUrl(dlUrl)) {
                  if (!found.has(dlUrl)) {
                    found.set(dlUrl, {
                      url: dlUrl,
                      name: typeof r['file_name'] === 'string' ? r['file_name'] : typeof r['name'] === 'string' ? r['name'] : undefined,
                      mimeType: typeof r['mime_type'] === 'string' ? r['mime_type'] : typeof r['mimeType'] === 'string' ? r['mimeType'] : undefined
                    });
                  }
                }
              }
              for (const k of Object.keys(r)) {
                if (SKIP_KEYS.has(k) || k.startsWith("__react")) continue;
                const v = r[k];
                if (typeof v === 'string' && v.startsWith('https://') && isAttUrl(v) && !found.has(v)) {
                  const nm = typeof r['name'] === 'string' ? r['name']
                    : typeof r['fileName'] === 'string' ? r['fileName']
                      : typeof r['file_name'] === 'string' ? r['file_name']
                        : typeof r['title'] === 'string' ? r['title'] : undefined;
                  const mt = typeof r['mimeType'] === 'string' ? r['mimeType']
                    : typeof r['content_type'] === 'string' ? r['content_type']
                      : typeof r['mime_type'] === 'string' ? r['mime_type'] : undefined;
                  found.set(v, { url: v, name: nm, mimeType: mt });
                } else if (typeof v === 'object' && v !== null) {
                  scan(v, depth + 1, vis);
                }
              }
            }

            // Inspect props attached to DOM nodes inside rendered message wrappers.
            // Never follow fibers upward, sideways, into app stores, or into root state.
            const selectors = [
              'article[data-testid^="conversation-turn-"]', '[data-message-author-role]',
              '[data-message-author]', '[data-is-user]', '[data-testid*="message"]',
              '.font-user-message', '[class*="font-claude-"]', 'main article',
            ];
            const elements = new Set<Element>();
            for (const selector of selectors) {
              for (const root of document.querySelectorAll(selector)) {
                if (root.closest('form, [contenteditable="true"], [data-testid*="composer"], [hidden], [aria-hidden="true"]')) continue;
                if (!root.getClientRects().length) continue;
                elements.add(root);
                for (const child of root.querySelectorAll('*')) {
                  if (elements.size >= 5000) break;
                  elements.add(child);
                }
                if (elements.size >= 5000) break;
              }
              if (elements.size >= 5000) break;
            }
            for (const element of elements) {
              for (const key of Object.keys(element)) {
                const value = (element as unknown as Record<string, unknown>)[key];
                if (key.startsWith('__reactProps$')) scan(value, 0, new Set());
                if ((key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) && value && typeof value === 'object') {
                  scan((value as Record<string, unknown>).memoizedProps, 0, new Set());
                }
              }
            }

            return Array.from(found.values());
          }
        });

        const harvested = results?.[0]?.result as Array<{ url: string; name?: string; mimeType?: string }> | null;
        sendResponse({ status: 'success', urls: harvested ?? [] });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error), urls: [] });
      }
    })();
    return true;
  }

  // --- Download an attachment in the PAGE context (MAIN world) with the user's cookies ---
  if (request.type === 'DOWNLOAD_IN_PAGE') {
    (async () => {
      try {
        const url = typeof request.url === 'string' ? request.url : '';
        if (!url) { sendResponse({ status: 'error', error: 'Missing URL.' }); return; }

        // Content scripts may request downloads only in their own source tab.
        const tabId = sender.tab?.id ?? (typeof request.tabId === 'number' ? request.tabId : undefined);
        if (tabId === undefined) { sendResponse({ status: 'error', error: 'No tab ID.' }); return; }
        const sourceTab = sender.tab?.id === tabId ? sender.tab : await chrome.tabs.get(tabId);
        const pageUrl = sourceTab?.url || sender.url || '';
        const pageOrigin = new URL(pageUrl).origin;
        if (!isAllowedSender({ id: sender.id, tab: { id: tabId, url: pageUrl } } as chrome.runtime.MessageSender)) {
          throw new Error('Unsupported source tab.');
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          args: [url, { maxSize: MAX_BLOB_SIZE, allowedHosts: ATTACHMENT_HOSTS, pageOrigin }],
          func: downloadAttachment,
        });
        const result = results?.[0]?.result;

        sendResponse(result ?? { status: 'error', error: 'Script returned nothing.' });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    })();
    return true;
  }
});
