import { AttachmentRef, CanonicalConversation, Message } from '../../schema/canonical';
import { SourceAdapter } from './index';

export class ClaudeAdapter implements SourceAdapter {
  private diagnostics: string;

  constructor() {
    this.diagnostics = '';
  }

  public getDiagnostics(): string {
    return this.diagnostics;
  }

  private normalizeUrl(rawUrl: string): string {
    try {
      return new URL(rawUrl, window.location.href).toString();
    } catch {
      return rawUrl;
    }
  }

  private isLikelyFileLink(url: string): boolean {
    return /(\.pdf|\.docx?|\.xlsx?|\.pptx?|\.txt|\.csv|\.json|\.zip|\.rar|\.7z|\.mp4|\.mp3|\.wav|\.mov|\.webm)(\?|#|$)/i.test(url);
  }

  private extractAttachments(node: HTMLElement, messageIndex: number): AttachmentRef[] {
    const attachments: AttachmentRef[] = [];
    const seen = new Set<string>();

    const register = (attachment: AttachmentRef) => {
      const key = `${attachment.kind}|${attachment.url || ''}|${attachment.name || ''}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      attachments.push(attachment);
    };

    const imageNodes = Array.from(node.querySelectorAll('img[src]'));
    imageNodes.forEach((img, index) => {
      const src = img.getAttribute('src') || '';
      if (!src) {
        return;
      }

      register({
        id: `m${messageIndex}-img-${index}`,
        kind: 'image',
        name: img.getAttribute('alt') || `Image ${index + 1}`,
        url: this.normalizeUrl(src),
        sourceHint: 'img'
      });
    });

    const linkNodes = Array.from(node.querySelectorAll('a[href]'));
    linkNodes.forEach((anchor, index) => {
      const href = anchor.getAttribute('href') || '';
      if (!href) {
        return;
      }

      const normalizedHref = this.normalizeUrl(href);
      const label = (anchor.textContent || '').trim();
      const kind: AttachmentRef['kind'] = this.isLikelyFileLink(normalizedHref) ? 'file' : 'link';

      register({
        id: `m${messageIndex}-lnk-${index}`,
        kind,
        name: label || undefined,
        url: normalizedHref,
        sourceHint: 'anchor'
      });
    });

    const chipNodes = Array.from(
      node.querySelectorAll(
        '[data-testid*="attachment"], [data-testid*="file"], [class*="attachment"], [class*="file-chip"], [class*="upload"]'
      )
    );

    chipNodes.forEach((chip, index) => {
      const text = (chip.textContent || '').trim();
      if (!text) {
        return;
      }

      // Try to find a download URL from the chip or its ancestors/descendants
      const chipUrl = this.extractUrlFromChip(chip as HTMLElement);

      // Try to extract rendered file content from the DOM near this chip
      const fileContent = this.extractFileContentNearChip(chip as HTMLElement);

      register({
        id: `m${messageIndex}-chip-${index}`,
        kind: 'file',
        name: text,
        url: chipUrl || undefined,
        textContent: fileContent || undefined,
        sourceHint: 'attachment-chip'
      });
    });

    // Also look for download buttons / links that may not be inside message text
    const downloadBtns = Array.from(node.querySelectorAll(
      'a[download], button[data-download-url], [data-testid*="download"], a[href*="/file/"], a[href*="/download"]'
    ));
    downloadBtns.forEach((btn, index) => {
      const href = btn.getAttribute('href') || btn.getAttribute('data-download-url') || '';
      if (!href) return;
      const label = (btn.textContent || '').trim() || `Download ${index + 1}`;
      register({
        id: `m${messageIndex}-dl-${index}`,
        kind: 'file',
        name: label,
        url: this.normalizeUrl(href),
        sourceHint: 'download-btn'
      });
    });

    return attachments;
  }

  /**
   * Tries to extract a downloadable URL from an attachment chip element
   * by checking the chip itself, its ancestors, descendants, and data attributes.
   */
  private extractUrlFromChip(chip: HTMLElement): string | null {
    // 1. Check if chip itself is an anchor
    if (chip.tagName === 'A') {
      const href = chip.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        return this.normalizeUrl(href);
      }
    }

    // 2. Check for data attributes that may hold URLs
    const dataUrl = chip.getAttribute('data-url') || chip.getAttribute('data-href') ||
      chip.getAttribute('data-download-url') || chip.getAttribute('data-src') || '';
    if (dataUrl) return this.normalizeUrl(dataUrl);

    // 3. Check if chip contains an anchor child
    const innerAnchor = chip.querySelector('a[href]');
    if (innerAnchor) {
      const href = innerAnchor.getAttribute('href') || '';
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        return this.normalizeUrl(href);
      }
    }

    // 4. Check if chip contains a download button
    const dlBtn = chip.querySelector('[download], [data-download-url]');
    if (dlBtn) {
      const href = dlBtn.getAttribute('href') || dlBtn.getAttribute('data-download-url') || '';
      if (href) return this.normalizeUrl(href);
    }

    // 5. Walk up to nearest ancestor anchor (max 5 levels)
    let parent = chip.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      if (parent.tagName === 'A') {
        const href = parent.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          return this.normalizeUrl(href);
        }
      }
      parent = parent.parentElement;
    }

    return null;
  }

  /**
   * Extracts rendered file content from the DOM near an attachment chip.
   * Providers often render uploaded text files in expandable sections, code blocks,
   * or pre-formatted content areas adjacent to or within the chip container.
   */
  private extractFileContentNearChip(chip: HTMLElement): string | null {
    const MAX_CONTENT = 200_000; // 200K char cap

    // Strategy 1: Check for content rendered inside the chip's container
    // Claude often renders file content in a sibling or child element
    const contentSelectors = [
      // Expandable/collapsible content sections
      '[class*="content"]', '[class*="preview"]', '[class*="expanded"]',
      '[class*="file-content"]', '[class*="attachment-content"]',
      // Code blocks that follow file chips
      'pre', 'code', '[class*="code-block"]', '[class*="highlight"]',
      // Generic text containers
      '[class*="text"]', '[class*="body"]',
    ];

    // Look within the chip's parent container (up to 3 levels)
    let container = chip.parentElement;
    for (let level = 0; level < 3 && container; level++) {
      for (const sel of contentSelectors) {
        const contentEl = container.querySelector(sel);
        if (contentEl && contentEl !== chip && !chip.contains(contentEl)) {
          const text = (contentEl as HTMLElement).innerText?.trim() || '';
          if (text.length > 50) { // Meaningful content (not just a label)
            return text.slice(0, MAX_CONTENT);
          }
        }
      }
      container = container.parentElement;
    }

    // Strategy 2: Check the next sibling elements after the chip
    let sibling = chip.nextElementSibling;
    for (let i = 0; i < 5 && sibling; i++) {
      const sibEl = sibling as HTMLElement;
      // Code block or pre following the chip
      if (sibEl.tagName === 'PRE' || sibEl.tagName === 'CODE' ||
          sibEl.querySelector?.('pre, code, [class*="code-block"]')) {
        const text = sibEl.innerText?.trim() || '';
        if (text.length > 50) {
          return text.slice(0, MAX_CONTENT);
        }
      }
      // Expandable content section
      if (sibEl.className && /content|preview|expanded|file-/i.test(sibEl.className)) {
        const text = sibEl.innerText?.trim() || '';
        if (text.length > 50) {
          return text.slice(0, MAX_CONTENT);
        }
      }
      sibling = sibling.nextElementSibling;
    }

    // Strategy 3: Check if chip's outermost container has a large text block
    // (some providers put file content in the same wrapper as the chip)
    let wrapper = chip.parentElement;
    for (let i = 0; i < 5 && wrapper; i++) {
      // Stop at message-level containers
      if (wrapper.getAttribute('data-message-author') || wrapper.getAttribute('data-role') ||
          /\bmessage\b/i.test(wrapper.className || '')) {
        break;
      }
      const wrapperText = wrapper.innerText?.trim() || '';
      const chipText = chip.textContent?.trim() || '';
      // If the wrapper has significantly more text than just the chip name, it might contain file content
      if (wrapperText.length > chipText.length + 100) {
        // Extract the non-chip portion
        const remaining = wrapperText.replace(chipText, '').trim();
        if (remaining.length > 50) {
          return remaining.slice(0, MAX_CONTENT);
        }
      }
      wrapper = wrapper.parentElement;
    }

    return null;
  }

  private inferRole(node: HTMLElement, index: number): 'user' | 'assistant' {
    const fingerprint = [
      node.className,
      node.getAttribute('data-message-author') || '',
      node.getAttribute('data-role') || '',
      node.getAttribute('aria-label') || ''
    ].join(' ').toLowerCase();

    // Check explicit attributes first
    if (node.closest('[data-is-user="true"], [data-message-author="user"], [data-role="user"]')) {
      return 'user';
    }

    if (node.closest('[data-message-author="assistant"], [data-role="assistant"], [data-role="model"]')) {
      return 'assistant';
    }

    const isBot = /\b(assistant|claude|model|bot|ai)\b/i.test(fingerprint);
    const isUser = /\b(user|you|human)\b/i.test(fingerprint);

    if (isBot) return 'assistant';
    if (isUser) return 'user';

    return index % 2 === 0 ? 'user' : 'assistant';
  }

  /**
   * Extracts messages from the Claude chat UI.
   * This is a heuristic parser relying on current Claude DOM structure.
   */
  public extractConversation(): CanonicalConversation {
    const messages: Message[] = [];
    const selectors = [
      '[data-message-author]',
      '[data-is-user]',
      '[data-testid*="message"]',
      'main [class*="font-user-message"]',
      'main [class*="font-claude-message"]',
      'main [class*="font-claude-response"]',
      '[class*="font-user-message"]',
      '[class*="font-claude-message"]',
      '[class*="font-claude-response"]',
      'main .prose'
    ];
    const uniqueNodes: HTMLElement[] = [];

    selectors.forEach((selector) => {
      const messageNodes = document.querySelectorAll(selector);
      messageNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return;
        }

        const text = node.innerText || '';
        if (!text.trim()) {
          return;
        }

        if (uniqueNodes.some((existing) => existing.contains(node))) {
          return;
        }

        for (let i = uniqueNodes.length - 1; i >= 0; i -= 1) {
          if (node.contains(uniqueNodes[i])) {
            uniqueNodes.splice(i, 1);
          }
        }

        uniqueNodes.push(node);
      });
    });

    uniqueNodes.sort((a, b) => {
      if (a === b) {
        return 0;
      }

      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }

      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }

      return 0;
    });

    let attachmentCount = 0;

    uniqueNodes.forEach((node, index) => {
      const text = node.innerText || '';
      const attachments = this.extractAttachments(node, index);
      attachmentCount += attachments.length;
      messages.push({
        id: `msg-${index}`,
        role: this.inferRole(node, index),
        timestamp: new Date().toISOString(),
        content: [{ type: 'text/markdown', text: text.trim() }],
        attachments
      });
    });

    if (messages.length === 0) {
      this.diagnostics = `No messages found. Tried selectors: ${selectors.join(', ')}`;
      console.warn(`ClaudeAdapter: ${this.diagnostics}`);
    } else {
      this.diagnostics = `Extracted ${messages.length} messages and ${attachmentCount} attachments.`;
    }

    const now = new Date().toISOString();
    return {
      version: '1.0',
      metadata: {
        source: 'Claude',
        title: document.title,
        createdAt: now,
        updatedAt: now,
        extensions: {
          diagnostics: this.diagnostics,
          attachmentCount: String(attachmentCount),
          attachmentMode: 'reference-only'
        }
      },
      messages,
      integrity: {
        messageCount: messages.length
      }
    };
  }
}