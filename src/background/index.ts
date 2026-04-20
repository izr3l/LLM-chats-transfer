// Background script handles cross-tab messages and encrypted persistence.

import { AttachmentBlob, CanonicalConversation, isValidCanonicalConversation, MAX_PAYLOAD_SIZE } from '../schema/canonical';
import { putBlobs, getBlobsByTransfer, getBlob, deleteBlobsByTransfer } from './attachmentStore';

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

function toHistoryEntry(payload: CanonicalConversation, encrypted: EncryptedPacket): TransferHistoryEntry {
  const count = payload.integrity?.messageCount ?? payload.messages.length;

  const attachmentCount = payload.messages.reduce((sum: number, msg) => {
    if (!Array.isArray(msg.attachments)) {
      return sum;
    }
    return sum + msg.attachments.length;
  }, 0);

  return {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    source: payload.metadata.source ?? 'unknown',
    title: payload.metadata.title ?? 'Untitled chat',
    messageCount: count,
    attachmentCount,
    sha256: payload.integrity?.sha256,
    encrypted
  };
}

// --- Main message handler ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const messageType = typeof request?.type === 'string' ? request.type : '';
  if (messageType && isRateLimited(messageType)) {
    sendResponse({ status: 'error', error: 'Rate limited. Please wait.' });
    return true;
  }

  if (!isAllowedSender(sender)) {
    sendResponse({ status: 'error', error: 'Unauthorized sender.' });
    return true;
  }

  if (request.type === 'STORE_TRANSCRIPT') {
    (async () => {
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

        const encryptedTranscript = await encryptPayload(request.payload);

        const transferId = typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const historyEntry = toHistoryEntry(request.payload as CanonicalConversation, encryptedTranscript);
        const existingHistory = await getHistory();

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
        await chrome.storage.local.set({
          pendingTransferEncrypted: encryptedTranscript,
          activeTransferId: transferId,
          transferHistory: nextHistory,
          pendingTransferMeta: {
            source: payloadMeta.metadata.source ?? 'unknown',
            title: payloadMeta.metadata.title ?? 'Untitled'
          }
        });

        sendResponse({ status: 'success', transferId });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    })();

    return true;
  }

  if (request.type === 'FETCH_TRANSCRIPT') {
    (async () => {
      try {
        const result = await chrome.storage.local.get(['pendingTransferEncrypted', 'pendingTransfer']);

        if (result.pendingTransfer && !result.pendingTransferEncrypted) {
          try {
            const encrypted = await encryptPayload(result.pendingTransfer);
            await chrome.storage.local.set({ pendingTransferEncrypted: encrypted });
            await chrome.storage.local.remove(['pendingTransfer']);
            const payload = await decryptPayload(encrypted);
            sendResponse({ payload: payload ?? null });
          } catch {
            // If migration fails, remove the unsafe plaintext and report error
            await chrome.storage.local.remove(['pendingTransfer']);
            sendResponse({ payload: null, error: 'Failed to migrate legacy plaintext data.' });
          }
          return;
        }

        const payload = isEncryptedPacket(result.pendingTransferEncrypted)
          ? await decryptPayload(result.pendingTransferEncrypted)
          : null;
        sendResponse({ payload: payload ?? null });
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
    (async () => {
      const itemId = typeof request.id === 'string' ? request.id : '';
      const history = await getHistory();
      const item = history.find((entry) => entry.id === itemId);
      if (!item) {
        sendResponse({ status: 'error', error: 'History item not found.' });
        return;
      }

      const transferId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      await chrome.storage.local.set({
        pendingTransferEncrypted: item.encrypted,
        activeTransferId: transferId,
        pendingTransferMeta: {
          source: item.source,
          title: item.title
        }
      });
      sendResponse({ status: 'success', transferId });
    })();

    return true;
  }

  if (request.type === 'CLEAR_HISTORY') {
    (async () => {
      await chrome.storage.local.set({ transferHistory: [] });
      sendResponse({ status: 'success' });
    })();

    return true;
  }

  if (request.type === 'DELETE_HISTORY_ITEM') {
    (async () => {
      const itemId = typeof request.id === 'string' ? request.id : '';
      const history = await getHistory();
      const updatedHistory = history.filter((entry) => entry.id !== itemId);
      await chrome.storage.local.set({ transferHistory: updatedHistory });
      sendResponse({ status: 'success' });
    })();

    return true;
  }

  if (request.type === 'PREVIEW_TRANSCRIPT') {
    (async () => {
      try {
        const result = await chrome.storage.local.get(['pendingTransferEncrypted']);
        const payload = isEncryptedPacket(result.pendingTransferEncrypted)
          ? await decryptPayload(result.pendingTransferEncrypted)
          : null;
        sendResponse({ payload: payload ?? null });
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
    (async () => {
      try {
        const transferId = typeof request.transferId === 'string' ? request.transferId : '';
        const blobs = Array.isArray(request.blobs) ? request.blobs as AttachmentBlob[] : [];

        if (!transferId) {
          sendResponse({ status: 'error', error: 'Missing transferId.' });
          return;
        }
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
    })();
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
          sendResponse({ blobs: [] });
          return;
        }

        const blobs = await getBlobsByTransfer(transferId);
        sendResponse({ blobs });
      } catch (error) {
        sendResponse({ blobs: [], error: String(error) });
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

        // Validate URL against allowed attachment hosts
        let hostname: string;
        try {
          hostname = new URL(url).hostname;
        } catch {
          sendResponse({ status: 'error', error: 'Invalid URL.' });
          return;
        }

        const ATTACHMENT_HOSTS = [
          'oaiusercontent.com',
          'files.oaiusercontent.com',
          'chatgpt.com',
          'chat.openai.com',
          'claude.ai',
          'gemini.google.com',
          'googleapis.com',
          'googleusercontent.com',
          'manus.im',
          'manus.com',
          'manus.ai',
          'perplexity.ai',
          'qwen.ai',
        ];

        const isAllowed = ATTACHMENT_HOSTS.some(
          (h) => hostname === h || hostname.endsWith(`.${h}`)
        );

        if (!isAllowed) {
          sendResponse({ status: 'error', error: `Host "${hostname}" is not in the attachment allowlist.` });
          return;
        }

        const resp = await fetch(url, { credentials: 'omit' });
        if (!resp.ok) {
          sendResponse({ status: 'error', error: `HTTP ${resp.status}: ${resp.statusText}` });
          return;
        }

        const contentType = resp.headers.get('Content-Type') ?? 'application/octet-stream';
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Convert to base64
        let binary = '';
        bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
        const dataBase64 = btoa(binary);

        // Try to extract filename from Content-Disposition
        let filename = '';
        const disposition = resp.headers.get('Content-Disposition') ?? '';
        if (disposition) {
          // Try RFC 5987 extended notation first
          const extMatch = /filename\*\s*=\s*(?:UTF-8|utf-8)'[^']*'([^\s;]+)/i.exec(disposition);
          if (extMatch) {
            filename = decodeURIComponent(extMatch[1]);
          } else {
            // Standard filename="..." or filename=...
            const stdMatch = /filename\s*=\s*"?([^";\n]+)"?/i.exec(disposition);
            if (stdMatch) filename = stdMatch[1].trim();
          }
        }

        // Fall back to URL path
        if (!filename) {
          try {
            const urlPath = new URL(url).pathname;
            const seg = urlPath.split('/').pop();
            if (seg && seg.includes('.')) filename = decodeURIComponent(seg);
          } catch { /* ignore */ }
        }

        if (!filename) filename = 'attachment';

        sendResponse({
          status: 'success',
          dataBase64,
          mimeType: contentType.split(';')[0].trim(),
          filename,
          size: bytes.length
        });
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
        const tabId = typeof request.tabId === 'number' ? request.tabId : sender.tab?.id;
        if (!tabId) {
          sendResponse({ status: 'error', error: 'No tab ID available.' });
          return;
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            // Inline harvester that runs in MAIN world (has access to React internals)
            const ALLOWED_HOSTS = [
              'oaiusercontent.com', 'files.oaiusercontent.com',
              'chatgpt.com', 'chat.openai.com',
              'claude.ai', 'gemini.google.com',
              'googleapis.com', 'googleusercontent.com',
            ];

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
            const MAX_FIBERS = 15000;
            const MAX_DEPTH = 20;
            let fc = 0;

            function scan(obj: unknown, depth: number, vis: Set<unknown>): void {
              if (depth > MAX_DEPTH || vis.size > 5000) return;
              if (!obj || typeof obj !== 'object') return;
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
                if (typeof dlUrl === 'string' && dlUrl.startsWith('https://')) {
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

            function walk(fiber: Record<string, unknown> | null, vis: Set<unknown>): void {
              if (!fiber || typeof fiber !== 'object' || vis.has(fiber) || fc++ > MAX_FIBERS) return;
              vis.add(fiber);
              for (const pk of ['memoizedProps', 'pendingProps']) {
                const p = fiber[pk];
                if (p && typeof p === 'object') scan(p, 0, new Set());
              }
              // Also scan stateNode (component instance state)
              const st = fiber['memoizedState'];
              if (st && typeof st === 'object') scan(st, 0, new Set());
              const sn = fiber['stateNode'];
              if (sn && typeof sn === 'object' && !(sn instanceof HTMLElement)) scan(sn, 0, new Set());
              walk(fiber['child'] as Record<string, unknown> | null, vis);
              walk(fiber['sibling'] as Record<string, unknown> | null, vis);
            }

            const sels = [
              'article[data-testid^="conversation-turn-"]',
              '[data-message-author-role]', '[data-testid*="message"]',
              'main article',
            ];
            const els = new Set<Element>();
            for (const s of sels) document.querySelectorAll(s).forEach((e) => els.add(e));
            const root = document.getElementById('__next') || document.getElementById('root');
            if (root) els.add(root);

            for (const el of els) {
              for (const k of Object.keys(el)) {
                if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
                  walk((el as unknown as Record<string, unknown>)[k] as Record<string, unknown>, new Set());
                }
                if (k.startsWith('__reactProps$')) {
                  const p = (el as unknown as Record<string, unknown>)[k];
                  if (p && typeof p === 'object') scan(p, 0, new Set());
                }
              }
            }

            // Also scan __NEXT_DATA__
            try {
              const nd = document.getElementById('__NEXT_DATA__');
              if (nd?.textContent) scan(JSON.parse(nd.textContent), 0, new Set());
            } catch { /* ignore */ }

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

        const tabId = typeof request.tabId === 'number' ? request.tabId : sender.tab?.id;
        if (!tabId) { sendResponse({ status: 'error', error: 'No tab ID.' }); return; }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          args: [url],
          func: async (fileUrl: string) => {
            try {
              const resp = await fetch(fileUrl, { credentials: 'include' });
              if (!resp.ok) return { status: 'error', error: `HTTP ${resp.status}` };

              const contentType = resp.headers.get('Content-Type') ?? 'application/octet-stream';
              const buffer = await resp.arrayBuffer();
              const bytes = new Uint8Array(buffer);

              // Convert to base64 (accumulate binary string then btoa)
              let bin = '';
              for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
              const dataBase64 = btoa(bin);

              let filename = '';
              const disposition = resp.headers.get('Content-Disposition') ?? '';
              if (disposition) {
                const m = /filename\*\s*=\s*(?:UTF-8|utf-8)'[^']*'([^\s;]+)/i.exec(disposition)
                  || /filename\s*=\s*"?([^";\n]+)"?/i.exec(disposition);
                if (m) filename = decodeURIComponent(m[1].trim());
              }
              if (!filename) {
                try {
                  const seg = new URL(fileUrl).pathname.split('/').pop();
                  if (seg && seg.includes('.')) filename = decodeURIComponent(seg);
                } catch { /* */ }
              }

              return {
                status: 'success',
                dataBase64,
                mimeType: contentType.split(';')[0].trim(),
                filename: filename || 'attachment',
                size: bytes.length
              };
            } catch (e) {
              return { status: 'error', error: String(e) };
            }
          }
        });

        const result = results?.[0]?.result as {
          status: string; dataBase64?: string; mimeType?: string; filename?: string; size?: number; error?: string;
        } | null;

        sendResponse(result ?? { status: 'error', error: 'Script returned nothing.' });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    })();
    return true;
  }
});