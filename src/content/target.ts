// Content script: Target injection
// VULN-05: Integrity verification before injection
// VULN-07: Idempotency guard for programmatic injection

import { TargetAdapter } from '../adapters/targets';
import { ChatGPTAdapter } from '../adapters/targets/chatgpt';
import { GenericTargetAdapter } from '../adapters/targets/fallback';
import { ManusTargetAdapter } from '../adapters/targets/manus';
import { CanonicalConversation } from '../schema/canonical';

declare global {
  interface Window {
    __chatTransferTargetRegistered?: boolean;
  }
}

// --- VULN-05: SHA-256 integrity verification ---

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeSha256(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(digest);
}

async function verifyIntegrity(transcript: CanonicalConversation): Promise<boolean> {
  if (!transcript.integrity?.sha256) {
    console.warn('ChatTransfer: No integrity hash present. Skipping verification.');
    return true;
  }

  const canonicalPayload = JSON.stringify({
    metadata: transcript.metadata,
    messages: transcript.messages
  });
  const computed = await computeSha256(canonicalPayload);
  return computed === transcript.integrity.sha256;
}



/**
 * Try to attach a File to the page via file input or drag-drop.
 */
function tryAttachFileToPage(file: File): boolean {
  // Strategy 1: file input
  const fileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  for (const inp of fileInputs) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch { /* try next */ }
  }

  // Strategy 2: drag-drop
  const dropSelectors = [
    '.ProseMirror', '[data-lexical-editor]', '[role="textbox"]',
    'textarea', 'div[contenteditable]', '[data-testid*="composer"]',
    '[data-testid*="input"]', 'form', 'main',
  ];
  for (const sel of dropSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    } catch { /* try next */ }
  }

  return false;
}

/**
 * Strip [attachment:N "name"] placeholders from transcript text, returning clean text.
 */
function stripAttachmentPlaceholders(text: string): string {
  return text.replace(/\n*\[attachment:\d+\s+"[^"]*"\]/g, '').trimEnd();
}



function getAdapter(): TargetAdapter {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com')) {
    return new ChatGPTAdapter();
  } else if (host.includes('claude.ai')) {
    return new GenericTargetAdapter('Claude', [
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      'textarea'
    ]);
  } else if (host.includes('gemini.google.com')) {
    return new GenericTargetAdapter('Gemini', [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ]);
  } else if (
    host.includes('manus.im') ||
    host.includes('manus.com') ||
    host.includes('manus.ai') ||
    host.includes('manus.computer')
  ) {
    return new ManusTargetAdapter();
  } else if (host.includes('qwen.ai') || host.includes('qwenlm.ai') || host.includes('chat.qwen.ai')) {
    return new GenericTargetAdapter('Qwen', [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      '[data-testid*="input"]',
      '[data-testid*="composer"]'
    ]);
  } else if (host.includes('perplexity.ai')) {
    return new GenericTargetAdapter('Perplexity', [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ]);
  } else if (host.includes('x.com')) {
    return new GenericTargetAdapter('Grok', [
      'textarea[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ]);
  }
  
  throw new Error(`Unsupported target: ${host}`);
}

// Guard: prevent double-registration when script is injected multiple times
if (!window.__chatTransferTargetRegistered) {
  window.__chatTransferTargetRegistered = true;

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === 'INJECT') {
      (async () => {
        try {
          const adapter = getAdapter();
          
          // Request pending transcript from Service Worker storage
          chrome.runtime.sendMessage({ type: 'FETCH_TRANSCRIPT' }, async (response) => {
            const transcript = response?.payload as CanonicalConversation | null;
            
            if (!transcript) {
              sendResponse({ status: 'error', error: 'No pending transcript found.' });
              return;
            }

            // --- VULN-05: Verify integrity hash before injection ---
            const integrityValid = await verifyIntegrity(transcript);
            if (!integrityValid) {
              sendResponse({
                status: 'error',
                error: 'Integrity check failed. The transcript may have been tampered with. Transfer aborted.'
              });
              return;
            }

            // Inject the prompt (file-upload adapters like Manus use injectViaFile)
            let success: boolean;

            if (typeof adapter.injectViaFile === 'function') {
              success = await adapter.injectViaFile(transcript);
            } else {
              const prompt = stripAttachmentPlaceholders(
                adapter.generateSingleShotPrompt(transcript)
              );
              success = adapter.injectPrompt(prompt);
            }

            if (success) {
              chrome.storage.local.remove(['pendingTransfer', 'pendingTransferEncrypted', 'activeTransferId']);
              sendResponse({ status: 'success' });
            } else {
              sendResponse({ status: 'error', error: 'Injection failed. Target DOM issue.' });
            }
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          sendResponse({ status: 'error', error: message });
        }
      })();

      return true; // Indicates async response.
    }

    // ── Paste raw: inject plain message text with structured framing ────────────
    if (request.type === 'INJECT_RAW') {
      (async () => {
        try {
          const adapter = getAdapter();
          chrome.runtime.sendMessage({ type: 'FETCH_TRANSCRIPT' }, async (response) => {
            try {
              if (chrome.runtime.lastError) {
                sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
                return;
              }

              const transcript = response?.payload as CanonicalConversation | null;
              if (!transcript) {
                sendResponse({ status: 'error', error: 'No pending transcript found.' });
                return;
              }
              const { source, title, createdAt } = transcript.metadata;
              const count = transcript.integrity?.messageCount ?? transcript.messages.length;

              let raw = `Chat Transcript — ${title ?? 'Untitled'}\n`;
              raw += `Source: ${source}  |  Messages: ${count}  |  Captured: ${new Date(createdAt).toLocaleString()}\n\n`;
              raw += `--- TRANSCRIPT START ---\n\n`;

              transcript.messages.forEach((m) => {
                const role = m.role === 'user' ? 'User' : 'Assistant';
                const text = m.content.map((c: { text?: string }) => c.text ?? '').join('\n').trim();
                raw += `${role}:\n${text}\n`;
                if (m.attachments && m.attachments.length > 0) {
                  raw += `Attachments (not auto-uploaded — user must re-upload manually):\n`;
                  m.attachments.forEach((att) => {
                    raw += `  - [${att.kind}] ${att.name || 'unnamed file'}\n`;
                  });
                }
                raw += '\n';
              });

              raw += `--- TRANSCRIPT END ---\n`;
              raw = stripAttachmentPlaceholders(raw);

              const success = adapter.injectPrompt(raw);
              if (success) {
                sendResponse({ status: 'success' });
              } else {
                sendResponse({ status: 'error', error: 'Could not find a text input on this page.' });
              }
            } catch (e: unknown) {
              sendResponse({ status: 'error', error: e instanceof Error ? e.message : String(e) });
            }
          });
        } catch (e: unknown) {
          sendResponse({ status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }

    // ── Inject file: attach a pre-built file via DataTransfer / drag-drop ──────
    if (request.type === 'INJECT_FILE') {
      (async () => {
        try {
          const { base64, filename, mimeType } = request as { base64: string; filename: string; mimeType: string };

          // Decode base64 → File
          const binary = atob(base64);
          const bytes  = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const file = new File([bytes.buffer as ArrayBuffer], filename, { type: mimeType });

          if (tryAttachFileToPage(file)) {
            sendResponse({ status: 'success' });
          } else {
            sendResponse({ status: 'error', error: 'No file drop zone found on this page.' });
          }
        } catch (e: unknown) {
          sendResponse({ status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }
  });
}