// Background script handles cross-tab messages and encrypted persistence.
// Security fixes: VULN-02, VULN-03, VULN-04, VULN-09, VULN-10, VULN-11

import { CanonicalConversation, isValidCanonicalConversation, MAX_PAYLOAD_SIZE } from '../schema/canonical';

type EncryptedPacket = { iv: string; ciphertext: string };

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

// --- VULN-11: Rate limiter to prevent message flooding ---
const rateLimiter = new Map<string, number>();
const RATE_LIMIT_MS = 500;

function isRateLimited(type: string): boolean {
  const lastCall = rateLimiter.get(type) ?? 0;
  const now = Date.now();
  if (now - lastCall < RATE_LIMIT_MS) return true;
  rateLimiter.set(type, now);
  return false;
}

// --- VULN-03: Sender origin validation ---
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

// --- VULN-02: Persistent encryption key (survives browser restart) ---
// The key is stored in chrome.storage.local. This is a defense-in-depth measure:
// Chrome isolates extension storage per-extension, so the key is not readable by
// other extensions. For stronger protection, implement passphrase-based key
// derivation (PBKDF2) with a user-supplied passphrase.

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

// --- VULN-04: Schema validation after decryption ---
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
  // --- VULN-11: Rate limiting ---
  const messageType = typeof request?.type === 'string' ? request.type : '';
  if (messageType && isRateLimited(messageType)) {
    sendResponse({ status: 'error', error: 'Rate limited. Please wait.' });
    return true;
  }

  // --- VULN-03: Sender validation ---
  if (!isAllowedSender(sender)) {
    sendResponse({ status: 'error', error: 'Unauthorized sender.' });
    return true;
  }

  if (request.type === 'STORE_TRANSCRIPT') {
    (async () => {
      try {
        // --- VULN-03: Schema validation on incoming payload ---
        if (!isValidCanonicalConversation(request.payload)) {
          sendResponse({ status: 'error', error: 'Invalid payload: schema validation failed.' });
          return;
        }

        // --- VULN-03: Payload size limit ---
        const payloadSize = JSON.stringify(request.payload).length;
        if (payloadSize > MAX_PAYLOAD_SIZE) {
          sendResponse({ status: 'error', error: `Payload too large (${(payloadSize / 1024 / 1024).toFixed(1)} MB). Max is 5 MB.` });
          return;
        }

        const encryptedTranscript = await encryptPayload(request.payload);

        // --- VULN-09: Transfer session ID for atomic capture→inject link ---
        const transferId = typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const historyEntry = toHistoryEntry(request.payload as CanonicalConversation, encryptedTranscript);
        const existingHistory = await getHistory();
        const nextHistory = [historyEntry, ...existingHistory].slice(0, 30);

        await chrome.storage.local.set({
          pendingTransferEncrypted: encryptedTranscript,
          activeTransferId: transferId,
          transferHistory: nextHistory
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

        // --- VULN-10: Migrate old plaintext data forward instead of serving it raw ---
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
      const result = await chrome.storage.local.get(['pendingTransferEncrypted']);
      const hasTranscript = Boolean(result.pendingTransferEncrypted);
      sendResponse({ hasTranscript });
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
        activeTransferId: transferId
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

  // --- VULN-12: Preview support — returns decrypted transcript for user review ---
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

  // --- Summarize: Calls Groq AI to summarize the captured transcript ---
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

        // Truncate if excessively long to stay within model context
        const MAX_CHARS = 60000;
        if (conversationText.length > MAX_CHARS) {
          conversationText = conversationText.slice(0, MAX_CHARS) + '\n\n[... truncated for length ...]';
        }

        const GROQ_API_KEY = process.env.GROQ_API_KEY;

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
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
            max_tokens: 3000
          })
        });

        if (!groqResponse.ok) {
          const errorBody = await groqResponse.text();
          sendResponse({ status: 'error', error: `Groq API error (${groqResponse.status}): ${errorBody}` });
          return;
        }

        const groqData = await groqResponse.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const summary = groqData.choices?.[0]?.message?.content ?? '';
        if (!summary) {
          sendResponse({ status: 'error', error: 'Groq returned an empty summary.' });
          return;
        }

        sendResponse({
          status: 'success',
          summary,
          source: transcript.metadata.source,
          title: transcript.metadata.title ?? 'Untitled',
          messageCount: transcript.messages.length
        });
      } catch (error) {
        sendResponse({ status: 'error', error: String(error) });
      }
    })();

    return true;
  }
});