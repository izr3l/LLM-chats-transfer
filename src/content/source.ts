// Content script: Source extraction

import { SourceAdapter } from '../adapters/sources';
import { ClaudeAdapter } from '../adapters/sources/claude';
import { GenericFallbackAdapter } from '../adapters/sources/fallback';
import { ManusAdapter } from '../adapters/sources/manus';
import { CanonicalConversation } from '../schema/canonical';
import { captureAttachmentBlobs, storeCapturedConversation } from './attachmentCapture';
import { mergeMessageSegments } from './messageSegments';

declare global {
  interface Window {
    __chatTransferSourceRegistered?: boolean;
  }
}

const SCROLL_SAMPLE_DELAY_MS = 250;
const MAX_SCROLL_STEPS = 90;

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeSha256(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(digest);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMessageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isComposerNode(node: Element): boolean {
  return Boolean(
    node.closest(
      'form, textarea, [contenteditable="true"], [role="textbox"], #prompt-textarea, [data-testid*="composer"], [data-testid*="input"]'
    )
  );
}

function getScrollTop(scroller: Element): number {
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  return (scroller as HTMLElement).scrollTop;
}

function setScrollTop(scroller: Element, top: number): void {
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    window.scrollTo({ top, behavior: 'auto' });
    document.documentElement.scrollTop = top;
    document.body.scrollTop = top;
    return;
  }

  (scroller as HTMLElement).scrollTop = top;
}

function getScrollHeight(scroller: Element): number {
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    return Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  }

  return (scroller as HTMLElement).scrollHeight;
}

function getClientHeight(scroller: Element): number {
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    return window.innerHeight || document.documentElement.clientHeight;
  }

  return (scroller as HTMLElement).clientHeight;
}

function findConversationScroller(): Element | null {
  const candidates = new Set<Element>();
  const docScroller = document.scrollingElement || document.documentElement;
  candidates.add(docScroller);

  document.querySelectorAll('main, [role="main"], [data-testid*="conversation"], [data-testid*="chat"]').forEach((node) => {
    if (node instanceof Element) {
      candidates.add(node);
      node.querySelectorAll('*').forEach((child) => candidates.add(child));
    }
  });

  document.querySelectorAll('article[data-testid^="conversation-turn-"], [data-message-author-role]').forEach((node) => {
    if (!(node instanceof Element)) return;
    candidates.add(node);

    let parent = node.parentElement;
    while (parent && parent !== document.body) {
      candidates.add(parent);
      parent = parent.parentElement;
    }
  });

  document.querySelectorAll('body *').forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    const style = window.getComputedStyle(node);
    if (!/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`)) return;
    candidates.add(node);
  });

  let best: Element | null = null;
  let bestScore = 0;

  candidates.forEach((node) => {
    if (!(node instanceof HTMLElement) && node !== docScroller) return;
    if (isComposerNode(node)) return;

    const scrollHeight = getScrollHeight(node);
    const clientHeight = getClientHeight(node);
    const overflow = scrollHeight - clientHeight;
    if (overflow < 200) return;

    const style = node instanceof HTMLElement ? window.getComputedStyle(node) : null;
    const isDocumentScroller = node === docScroller || node === document.documentElement || node === document.body;
    const hasScrollableStyle = Boolean(style && /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`));
    const canScroll = isDocumentScroller || hasScrollableStyle;
    if (!canScroll) return;

    const rect = node instanceof HTMLElement ? node.getBoundingClientRect() : document.documentElement.getBoundingClientRect();
    const chatTurnCount = node.querySelectorAll?.('article[data-testid^="conversation-turn-"], [data-message-author-role]').length ?? 0;
    const scrollableStyleBonus = hasScrollableStyle ? 2000 : 0;
    const mainBonus = node.matches?.('main, [role="main"], [data-testid*="conversation"], [data-testid*="chat"]') ? 1000 : 0;
    const viewportBonus = rect.height > window.innerHeight * 0.45 ? 500 : 0;
    const chatTurnBonus = chatTurnCount * 1500;
    const score = overflow + scrollableStyleBonus + mainBonus + viewportBonus + chatTurnBonus;

    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  });

  return best;
}

async function extractConversationWithScroll(adapter: SourceAdapter): Promise<CanonicalConversation> {
  const initial = adapter.extractConversation();
  if (initial.messages.length === 0) {
    return initial;
  }

  const scroller = findConversationScroller();
  if (!scroller) {
    return initial;
  }

  const originalTop = getScrollTop(scroller);
  const segments: CanonicalConversation['messages'][] = [];

  const collect = () => {
    const snapshot = adapter.extractConversation();
    const messages = snapshot.messages.filter((message) => normalizeMessageText(message.content.map((block) => block.text).join('\n')).length > 0 || (message.attachments?.length ?? 0) > 0);
    if (messages.length > 0) {
      segments.push(messages);
    }
  };

  try {
    for (let i = 0; i < MAX_SCROLL_STEPS; i += 1) {
      const before = getScrollTop(scroller);
      if (before <= 1) break;
      const step = Math.max(getClientHeight(scroller) * 0.85, 450);
      setScrollTop(scroller, Math.max(0, before - step));
      await delay(SCROLL_SAMPLE_DELAY_MS);
      if (Math.abs(getScrollTop(scroller) - before) < 2) break;
    }

    let stableTopSamples = 0;
    let previousHeight = -1;
    for (let i = 0; i < 20; i += 1) {
      setScrollTop(scroller, 0);
      await delay(SCROLL_SAMPLE_DELAY_MS);

      const currentHeight = getScrollHeight(scroller);
      const currentTop = getScrollTop(scroller);
      if (Math.abs(currentHeight - previousHeight) < 2 && currentTop <= 2) {
        stableTopSamples += 1;
      } else {
        stableTopSamples = 0;
      }

      previousHeight = currentHeight;
      if (stableTopSamples >= 2) break;
    }

    let stagnantSteps = 0;
    for (let i = 0; i < MAX_SCROLL_STEPS; i += 1) {
      collect();

      const before = getScrollTop(scroller);
      const maxTop = Math.max(0, getScrollHeight(scroller) - getClientHeight(scroller));
      if (before >= maxTop - 2) break;

      const step = Math.max(getClientHeight(scroller) * 0.75, 450);
      setScrollTop(scroller, Math.min(maxTop, before + step));
      await delay(SCROLL_SAMPLE_DELAY_MS);

      const after = getScrollTop(scroller);
      stagnantSteps = Math.abs(after - before) < 2 ? stagnantSteps + 1 : 0;
      if (stagnantSteps >= 3) break;
    }

    collect();
  } finally {
    setScrollTop(scroller, originalTop);
  }

  const mergedMessages = mergeMessageSegments(segments);
  if (mergedMessages.length < initial.messages.length) {
    return initial;
  }

  const now = new Date().toISOString();
  const sampled = Math.max(1, segments.length);
  return {
    ...initial,
    metadata: {
      ...initial.metadata,
      updatedAt: now,
      extensions: {
        ...initial.metadata.extensions,
        scrollCapture: 'true',
        scrollSnapshots: String(sampled)
      }
    },
    messages: mergedMessages,
    integrity: {
      ...initial.integrity,
      messageCount: mergedMessages.length
    }
  };
}

function getAdapter(): SourceAdapter {
  const host = window.location.hostname;
  if (host.includes('claude.ai')) {
    return new ClaudeAdapter();
  } else if (host.includes('chatgpt.com')) {
    return new GenericFallbackAdapter('ChatGPT', [
      'article[data-testid^="conversation-turn-"]',
      '[data-message-author-role]'
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
          let fullConversation = await extractConversationWithScroll(adapter);
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
            const fallbackConversation = await extractConversationWithScroll(broadFallback);
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

          // Stage file data before publishing the transcript. A failed IndexedDB
          // write must not report aliases that have no files.
          const blobs = await captureAttachmentBlobs(fullConversation);
          const updatedPayload = JSON.stringify({
            metadata: fullConversation.metadata,
            messages: fullConversation.messages
          });
          fullConversation.integrity!.sha256 = await computeSha256(updatedPayload);
          const transferId = await storeCapturedConversation(fullConversation, blobs);
          sendResponse({
            status: 'success',
            data: fullConversation,
            transferId,
            capturedAttachments: blobs.length,
            unavailableAttachments: Number(fullConversation.metadata.extensions?.unavailableAttachments || 0)
          });
        } catch (e) {
          sendResponse({ status: 'error', error: String(e) });
        }
      })();

      return true;
    }
  });
}
