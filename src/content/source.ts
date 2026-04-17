// Content script: Source extraction
// VULN-07: Idempotency guard for programmatic injection

import { SourceAdapter } from '../adapters/sources';
import { ClaudeAdapter } from '../adapters/sources/claude';
import { GenericFallbackAdapter } from '../adapters/sources/fallback';
import { ManusAdapter } from '../adapters/sources/manus';

declare global {
  interface Window {
    __chatTransferSourceRegistered?: boolean;
  }
}

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeSha256(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(digest);
}

function getAdapter(): SourceAdapter {
  const host = window.location.hostname;
  if (host.includes('claude.ai')) {
    return new ClaudeAdapter();
  } else if (host.includes('chatgpt.com')) {
    return new GenericFallbackAdapter('ChatGPT', [
      'article[data-testid^="conversation-turn-"]',
      '[data-message-author-role]',
      '#prompt-textarea'
    ]);
  } else if (host.includes('gemini.google.com')) {
    return new GenericFallbackAdapter('Gemini', [
      '[data-test-id="response-content"]',
      'message-content',
      'user-query',
      '.model-response-text'
    ]);
  } else if (
    host.includes('manus.im') ||
    host.includes('manus.com') ||
    host.includes('manus.ai') ||
    host.includes('manus.computer')
  ) {
    return new ManusAdapter();
  } else if (host.includes('qwen.ai') || host.includes('qwenlm.ai') || host.includes('chat.qwen.ai')) {
    return new GenericFallbackAdapter('Qwen', [
      '[data-role="assistant"]',
      '[data-role="user"]',
      '[data-testid*="message"]',
      '[class*="message"]',
      '[class*="chat-item"]',
      'main article',
      'main .prose'
    ]);
  } else if (host.includes('perplexity.ai')) {
    return new GenericFallbackAdapter('Perplexity', [
      '[data-testid*="answer"]',
      '[data-testid*="query"]',
      'main .prose',
      'article'
    ]);
  } else if (host.includes('x.com')) {
    return new GenericFallbackAdapter('Grok', [
      '[data-testid="messageEntry"]',
      '[data-testid="tweetText"]',
      'article'
    ]);
  }
  
  throw new Error(`Unsupported source: ${host}`);
}

// Guard: prevent double-registration when script is injected multiple times
if (!window.__chatTransferSourceRegistered) {
  window.__chatTransferSourceRegistered = true;

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === 'EXTRACT') {
      (async () => {
        try {
          const host = window.location.hostname;
          let adapter = getAdapter();
          let fullConversation = adapter.extractConversation();
          let count = fullConversation.messages.length;

          if (count === 0) {
            // Automatic broad fallback when provider DOM changed.
            const broadFallback = new GenericFallbackAdapter(host, [
              '[data-testid*="message"]',
              '[data-testid*="chat"]',
              '[data-message-author]',
              '[data-role]',
              '[class*="message"]',
              '[class*="chat"]',
              'main article',
              'main .prose',
              'main p'
            ]);
            const fallbackConversation = broadFallback.extractConversation();
            if (fallbackConversation.messages.length > 0) {
              adapter = broadFallback;
              fullConversation = fallbackConversation;
              count = fallbackConversation.messages.length;
            }
          }

          if (!fullConversation.integrity) {
            fullConversation.integrity = {
              messageCount: count
            };
          }

          const canonicalPayload = JSON.stringify({
            metadata: fullConversation.metadata,
            messages: fullConversation.messages
          });
          fullConversation.integrity.sha256 = await computeSha256(canonicalPayload);

          if (count === 0) {
            const diagnostics = 'getDiagnostics' in adapter
              ? (adapter as ClaudeAdapter).getDiagnostics()
              : 'No diagnostics available.';
            sendResponse({ status: 'error', error: `No messages extracted. Selector mismatch. ${diagnostics}` });
            return;
          }

          chrome.runtime.sendMessage({ type: 'STORE_TRANSCRIPT', payload: fullConversation }, () => {
            sendResponse({ status: 'success', data: fullConversation });
          });
        } catch (e) {
          sendResponse({ status: 'error', error: String(e) });
        }
      })();

      return true;
    }
  });
}