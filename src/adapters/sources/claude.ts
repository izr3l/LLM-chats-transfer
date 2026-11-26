import { CanonicalConversation, Message } from '../../schema/canonical';
import { SourceAdapter } from './index';
import { extractMessageAttachments, hasAttachmentContent } from './attachmentExtraction';

export class ClaudeAdapter implements SourceAdapter {
  private diagnostics: string;

  constructor() {
    this.diagnostics = '';
  }

  public getDiagnostics(): string {
    return this.diagnostics;
  }

  private isComposerNode(node: HTMLElement): boolean {
    return Boolean(
      node.closest(
        'form, textarea, [contenteditable="true"], [role="textbox"], [data-testid*="composer"], [data-testid*="input"]'
      )
    );
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
      const attachments = extractMessageAttachments(node, index, true);
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
