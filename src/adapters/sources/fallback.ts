import { CanonicalConversation, Message } from '../../schema/canonical';
import { SourceAdapter } from './index';
import { extractMessageAttachments, hasAttachmentContent } from './attachmentExtraction';

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

  private isComposerNode(node: HTMLElement): boolean {
    return Boolean(
      node.closest(
        'form, textarea, [contenteditable="true"], [role="textbox"], #prompt-textarea, [data-testid*="composer"], [data-testid*="input"]'
      )
    );
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
        if (!text.trim() && !hasAttachmentContent(node)) {
          return;
        }

        if (this.isComposerNode(node)) {
          return;
        }

        if (uniqueNodes.some((existing) => existing.contains(node) || node.contains(existing))) {
          return;
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
      const attachments = extractMessageAttachments(node, index);
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
