// Content script: Target injection
// VULN-05: Integrity verification before injection
// VULN-07: Idempotency guard for programmatic injection

import { TargetAdapter } from '../adapters/targets';
import { ChatGPTAdapter } from '../adapters/targets/chatgpt';
import { GenericTargetAdapter } from '../adapters/targets/fallback';
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
    // No hash stored — can't verify, allow but warn
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
    return new GenericTargetAdapter('Manus', [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      '[data-lexical-editor="true"]',
      '.ProseMirror',
      '[data-testid*="composer"]',
      '[data-testid*="input"]'
    ], {
      // Avoid large-paste behavior that turns long content into a text-file attachment.
      preferDirectSet: true,
      useChunkedTextInsertion: true,
      chunkSize: 350
    });
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
            
            const prompt = adapter.generateSingleShotPrompt(transcript);
            const success = adapter.injectPrompt(prompt);
            
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
  });
}