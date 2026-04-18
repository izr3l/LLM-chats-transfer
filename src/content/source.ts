// Content script: Source extraction
// VULN-07: Idempotency guard for programmatic injection

import { SourceAdapter } from '../adapters/sources';
import { ClaudeAdapter } from '../adapters/sources/claude';
import { GenericFallbackAdapter } from '../adapters/sources/fallback';
import { ManusAdapter } from '../adapters/sources/manus';
import { AttachmentBlob, AttachmentRef, CanonicalConversation } from '../schema/canonical';

declare global {
  interface Window {
    __chatTransferSourceRegistered?: boolean;
  }
}

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function guessMimeFromName(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    json: 'application/json', xml: 'application/xml',
    html: 'text/html', htm: 'text/html', css: 'text/css',
    js: 'application/javascript', ts: 'text/x-typescript',
    py: 'text/x-python', rb: 'text/x-ruby', java: 'text/x-java',
    c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c',
    rs: 'text/x-rust', go: 'text/x-go', sh: 'text/x-shellscript',
    yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/toml',
    ini: 'text/plain', log: 'text/plain', env: 'text/plain',
    sql: 'text/x-sql', pdf: 'application/pdf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return ext ? map[ext] || null : null;
}

async function computeSha256(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(digest);
}

/**
 * Downloads actual attachment file data for all extractable attachments.
 * Returns the blobs and mutates conversation attachments to include blobAlias.
 *
 * Strategy:
 * 1. Run React fiber harvester (MAIN world) to discover hidden attachment URLs
 * 2. Match harvested URLs to URL-less attachment chips by filename similarity
 * 3. Download all attachments that have a URL (DOM-extracted or fiber-harvested)
 */
async function captureAttachmentBlobs(
  conversation: CanonicalConversation
): Promise<AttachmentBlob[]> {
  const blobs: AttachmentBlob[] = [];
  let aliasCounter = 1;

  // Step 1: Harvest hidden URLs from React fiber tree (ChatGPT, etc.)
  let harvestedUrls: Array<{ url: string; name?: string; mimeType?: string }> = [];
  try {
    const harvestResp = await new Promise<{
      status: string;
      urls?: Array<{ url: string; name?: string; mimeType?: string }>;
    }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'HARVEST_FIBER_URLS' }, (resp) => {
        resolve(resp ?? { status: 'error' });
      });
    });
    if (harvestResp.status === 'success' && Array.isArray(harvestResp.urls)) {
      harvestedUrls = harvestResp.urls;
      console.log(`[ChatTransfer] Fiber harvester found ${harvestedUrls.length} attachment URLs.`);
    }
  } catch (err) {
    console.warn('[ChatTransfer] Fiber harvest failed (non-fatal):', err);
  }

  // Step 2: Match harvested URLs to URL-less attachments by filename
  for (const msg of conversation.messages) {
    if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) continue;

    for (const att of msg.attachments) {
      if (att.kind === 'link') continue;

      // If this chip has no URL, try to match it with a harvested URL by name
      if (!att.url && att.name) {
        const attName = att.name.toLowerCase().trim();
        const match = harvestedUrls.find((h) => {
          if (!h.name) return false;
          const hName = h.name.toLowerCase().trim();
          // Exact match or one contains the other
          return hName === attName || hName.includes(attName) || attName.includes(hName);
        });
        if (match) {
          att.url = match.url;
          att.mimeType = att.mimeType || match.mimeType;
          // Remove from pool so it doesn't match again
          harvestedUrls = harvestedUrls.filter((h) => h.url !== match.url);
          console.log(`[ChatTransfer] Matched chip "${att.name}" → fiber URL`);
        }
      }

      // Still no URL? Try to create a blob from extracted DOM text content
      if (!att.url) {
        if (att.textContent && att.textContent.length > 0) {
          const alias = aliasCounter++;
          att.blobAlias = alias;
          const textBytes = new TextEncoder().encode(att.textContent);
          // Convert text content to base64
          let binary = '';
          textBytes.forEach((byte) => { binary += String.fromCharCode(byte); });
          const dataBase64 = btoa(binary);
          const mimeType = att.mimeType || guessMimeFromName(att.name || '') || 'text/plain';

          blobs.push({
            transferId: '',
            alias,
            name: att.name || 'attachment.txt',
            mimeType,
            dataBase64,
            size: textBytes.length
          });
          att.blobSize = textBytes.length;
          console.log(`[ChatTransfer] Created text blob for "${att.name}" from DOM content (${textBytes.length} bytes)`);
        }
        continue;
      }

      // Skip data URLs (already inline) and blob URLs (can't cross contexts)
      if (att.url.startsWith('data:') || att.url.startsWith('blob:')) continue;

      try {
        // Strategy A: Download in the page context (MAIN world) with user's session cookies.
        // This is essential for providers like ChatGPT where file URLs require authentication.
        let response = await new Promise<{
          status: string;
          dataBase64?: string;
          mimeType?: string;
          filename?: string;
          size?: number;
          error?: string;
        }>((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'DOWNLOAD_IN_PAGE', url: att.url },
            (resp) => resolve(resp ?? { status: 'error', error: 'No response' })
          );
        });

        // Strategy B: Fall back to background fetch (works for public/CDN URLs)
        if (response.status !== 'success' || !response.dataBase64) {
          console.log(`[ChatTransfer] Page-context download failed for "${att.name}" (${response.error}), trying background fetch…`);
          response = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: 'DOWNLOAD_ATTACHMENT_URL', url: att.url },
              (resp) => resolve(resp ?? { status: 'error', error: 'No response' })
            );
          });
        }

        if (response.status !== 'success' || !response.dataBase64) {
          console.warn(`[ChatTransfer] Failed to download attachment "${att.name}": ${response.error}`);
          continue;
        }

        const alias = aliasCounter++;
        att.blobAlias = alias;
        att.blobSize = response.size;
        att.mimeType = att.mimeType || response.mimeType;
        if (!att.name || att.name.startsWith('Image ')) {
          att.name = response.filename;
        }

        blobs.push({
          transferId: '', // Will be set by background when storing
          alias,
          name: att.name || response.filename || 'attachment',
          mimeType: response.mimeType || 'application/octet-stream',
          dataBase64: response.dataBase64,
          size: response.size || 0
        });
        console.log(`[ChatTransfer] Downloaded attachment "${att.name}" (${response.size} bytes)`);
      } catch (err) {
        console.warn(`[ChatTransfer] Attachment download error for "${att.name}":`, err);
      }
    }
  }

  // Step 3: Any remaining harvested URLs that weren't matched to chips
  // — add them as new attachments on the last message
  if (harvestedUrls.length > 0 && conversation.messages.length > 0) {
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    if (!lastMsg.attachments) lastMsg.attachments = [];

    const requestAttachmentDownload = (
      type: 'DOWNLOAD_IN_PAGE' | 'DOWNLOAD_ATTACHMENT_URL',
      url: string
    ) =>
      new Promise<{
        status: string;
        dataBase64?: string;
        mimeType?: string;
        filename?: string;
        size?: number;
        error?: string;
      }>((resolve) => {
        chrome.runtime.sendMessage(
          { type, url },
          (resp) => resolve(resp ?? { status: 'error', error: 'No response' })
        );
      });

    for (const harvested of harvestedUrls) {
      try {
        let response = await requestAttachmentDownload('DOWNLOAD_IN_PAGE', harvested.url);
        if (response.status !== 'success' || !response.dataBase64) {
          console.log(`[ChatTransfer] Page-context download failed for harvested URL (${response.error}), trying background fetch…`);
          response = await requestAttachmentDownload('DOWNLOAD_ATTACHMENT_URL', harvested.url);
        }

        if (response.status !== 'success' || !response.dataBase64) continue;

        const alias = aliasCounter++;
        const name = harvested.name || response.filename || 'attachment';

        lastMsg.attachments.push({
          id: `harvested-${alias}`,
          kind: 'file',
          name,
          url: harvested.url,
          mimeType: harvested.mimeType || response.mimeType,
          sourceHint: 'fiber-harvest',
          blobAlias: alias,
          blobSize: response.size,
        });

        blobs.push({
          transferId: '',
          alias,
          name,
          mimeType: response.mimeType || 'application/octet-stream',
          dataBase64: response.dataBase64,
          size: response.size || 0
        });
      } catch (err) {
        console.warn(`[ChatTransfer] Harvested URL download error:`, err);
      }
    }
  }

  return blobs;
}

/**
 * Injects [attachment:N] placeholders into message text for any attachment that
 * has a blobAlias assigned. This lets the target side know where to reattach files.
 */
function injectAttachmentPlaceholders(conversation: CanonicalConversation): void {
  for (const msg of conversation.messages) {
    if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) continue;

    const aliased = msg.attachments.filter((a: AttachmentRef) => typeof a.blobAlias === 'number');
    if (aliased.length === 0) continue;

    // Append placeholders to the last text content block
    const textBlock = msg.content.find((c) => c.type === 'text/markdown' || c.type === 'text/plain');
    if (!textBlock) continue;

    const placeholders = aliased.map(
      (a: AttachmentRef) => `[attachment:${a.blobAlias} "${a.name || 'file'}"]`
    ).join('\n');

    textBlock.text = textBlock.text + '\n\n' + placeholders;
  }
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

          // --- Capture actual attachment file data ---
          let capturedBlobCount = 0;
          try {
            const blobs = await captureAttachmentBlobs(fullConversation);
            if (blobs.length > 0) {
              // Inject [attachment:N] placeholders into message text
              injectAttachmentPlaceholders(fullConversation);

              // Re-compute integrity after modifying messages
              const updatedPayload = JSON.stringify({
                metadata: fullConversation.metadata,
                messages: fullConversation.messages
              });
              fullConversation.integrity!.sha256 = await computeSha256(updatedPayload);

              // Store transcript first to get the transferId, then store blobs
              const storeResp = await new Promise<{ status: string; transferId?: string }>((resolve) => {
                chrome.runtime.sendMessage(
                  { type: 'STORE_TRANSCRIPT', payload: fullConversation },
                  (resp) => resolve(resp ?? { status: 'error' })
                );
              });

              if (storeResp.status === 'success' && storeResp.transferId) {
                // Store blobs in IndexedDB linked to the transfer
                await new Promise<void>((resolve) => {
                  chrome.runtime.sendMessage(
                    { type: 'STORE_ATTACHMENTS', transferId: storeResp.transferId, blobs },
                    () => resolve()
                  );
                });
                capturedBlobCount = blobs.length;
                sendResponse({
                  status: 'success',
                  data: fullConversation,
                  capturedAttachments: capturedBlobCount
                });
                return;
              }

              console.warn(
                '[ChatTransfer] Transcript storage failed during attachment capture; falling back to transcript-only storage.',
                storeResp
              );
            }
          } catch (blobErr) {
            console.warn('[ChatTransfer] Attachment capture failed (non-fatal):', blobErr);
            // Continue with normal transcript storage without blobs
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