import { AttachmentRef, CanonicalConversation, Message } from '../../schema/canonical';
import { SourceAdapter } from './index';

export class GenericFallbackAdapter implements SourceAdapter {
  private sourceName: string;
  private messageSelectors: string[];
  private diagnostics: string;

  constructor(sourceName: string, messageSelectors: string[]) {
    this.sourceName = sourceName;
    this.messageSelectors = messageSelectors;
    this.diagnostics = '';
  }

  public getDiagnostics(): string {
    return this.diagnostics;
  }

  private collectRoots(): ParentNode[] {
    const roots: ParentNode[] = [document];
    const queue: ParentNode[] = [document];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const elements = current.querySelectorAll('*');
      elements.forEach((element) => {
        const host = element as HTMLElement;
        if (host.shadowRoot) {
          roots.push(host.shadowRoot);
          queue.push(host.shadowRoot);
        }
      });
    }

    return roots;
  }

  private queryAllDeep(selector: string): HTMLElement[] {
    const roots = this.collectRoots();
    const nodes: HTMLElement[] = [];

    roots.forEach((root) => {
      root.querySelectorAll(selector).forEach((node) => {
        if (node instanceof HTMLElement) {
          nodes.push(node);
        }
      });
    });

    return nodes;
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

      const chipUrl = this.extractUrlFromChip(chip as HTMLElement);
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

    // Also look for download buttons / links
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

  private extractUrlFromChip(chip: HTMLElement): string | null {
    if (chip.tagName === 'A') {
      const href = chip.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        return this.normalizeUrl(href);
      }
    }

    const dataUrl = chip.getAttribute('data-url') || chip.getAttribute('data-href') ||
      chip.getAttribute('data-download-url') || chip.getAttribute('data-src') || '';
    if (dataUrl) return this.normalizeUrl(dataUrl);

    const innerAnchor = chip.querySelector('a[href]');
    if (innerAnchor) {
      const href = innerAnchor.getAttribute('href') || '';
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        return this.normalizeUrl(href);
      }
    }

    const dlBtn = chip.querySelector('[download], [data-download-url]');
    if (dlBtn) {
      const href = dlBtn.getAttribute('href') || dlBtn.getAttribute('data-download-url') || '';
      if (href) return this.normalizeUrl(href);
    }

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

  private extractFileContentNearChip(chip: HTMLElement): string | null {
    const MAX_CONTENT = 200_000;
    const contentSelectors = [
      '[class*="content"]', '[class*="preview"]', '[class*="expanded"]',
      '[class*="file-content"]', '[class*="attachment-content"]',
      'pre', 'code', '[class*="code-block"]', '[class*="highlight"]',
      '[class*="text"]', '[class*="body"]',
    ];

    // Look within the chip's parent container (up to 3 levels)
    let container = chip.parentElement;
    for (let level = 0; level < 3 && container; level++) {
      for (const sel of contentSelectors) {
        const contentEl = container.querySelector(sel);
        if (contentEl && contentEl !== chip && !chip.contains(contentEl)) {
          const text = (contentEl as HTMLElement).innerText?.trim() || '';
          if (text.length > 50) {
            return text.slice(0, MAX_CONTENT);
          }
        }
      }
      container = container.parentElement;
    }

    // Check next sibling elements
    let sibling = chip.nextElementSibling;
    for (let i = 0; i < 5 && sibling; i++) {
      const sibEl = sibling as HTMLElement;
      if (sibEl.tagName === 'PRE' || sibEl.tagName === 'CODE' ||
          sibEl.querySelector?.('pre, code, [class*="code-block"]')) {
        const text = sibEl.innerText?.trim() || '';
        if (text.length > 50) return text.slice(0, MAX_CONTENT);
      }
      if (sibEl.className && /content|preview|expanded|file-/i.test(sibEl.className)) {
        const text = sibEl.innerText?.trim() || '';
        if (text.length > 50) return text.slice(0, MAX_CONTENT);
      }
      sibling = sibling.nextElementSibling;
    }

    // Check if wrapper has more text than just the chip name
    let wrapper = chip.parentElement;
    for (let i = 0; i < 5 && wrapper; i++) {
      if (wrapper.getAttribute('data-message-author') || wrapper.getAttribute('data-role') ||
          /\bmessage\b/i.test(wrapper.className || '')) break;
      const wrapperText = wrapper.innerText?.trim() || '';
      const chipText = chip.textContent?.trim() || '';
      if (wrapperText.length > chipText.length + 100) {
        const remaining = wrapperText.replace(chipText, '').trim();
        if (remaining.length > 50) return remaining.slice(0, MAX_CONTENT);
      }
      wrapper = wrapper.parentElement;
    }

    return null;
  }

  private inferRole(node: HTMLElement, index: number): 'user' | 'assistant' {
    const fingerprint = [
      node.className,
      node.getAttribute('data-role') || '',
      node.getAttribute('data-message-author') || '',
      node.getAttribute('data-message-author-role') || '',
      node.getAttribute('aria-label') || ''
    ].join(' ').toLowerCase();

    // Check strict explicit attributes first
    if (node.closest('[data-is-user="true"], [data-message-author="user"], [data-role="user"], [data-message-author-role="user"]')) {
      return 'user';
    }

    if (node.closest('[data-message-author="assistant"], [data-role="assistant"], [data-role="model"], [data-message-author-role="assistant"]')) {
      return 'assistant';
    }

    // Heuristic checking words boundaries
    const isBot = /\b(assistant|model|claude|chatgpt|gemini|perplexity|grok|manus|qwen|bot|ai)\b/i.test(fingerprint);
    const isUser = /\b(user|you|human)\b/i.test(fingerprint);

    if (isBot) return 'assistant';
    if (isUser) return 'user';

    return index % 2 === 0 ? 'user' : 'assistant';
  }

  public extractConversation(): CanonicalConversation {
    const messages: Message[] = [];
    const uniqueNodes: HTMLElement[] = [];

    this.messageSelectors.forEach((selector) => {
      const messageNodes = this.queryAllDeep(selector);

      messageNodes.forEach((node) => {

        const text = (node.innerText || node.textContent || '');
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
      this.diagnostics = `No messages found. Tried selectors: ${this.messageSelectors.join(', ')}`;
      console.warn(`${this.sourceName}Adapter: ${this.diagnostics}`);
    } else {
      this.diagnostics = `Extracted ${messages.length} messages and ${attachmentCount} attachments with selectors: ${this.messageSelectors.join(', ')}`;
    }

    const now = new Date().toISOString();
    return {
      version: '1.0',
      metadata: {
        source: this.sourceName,
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
