import { AttachmentRef, CanonicalConversation, Message } from '../../schema/canonical';
import { SourceAdapter } from './index';

type CandidateMessage = {
  role: 'user' | 'assistant';
  text: string;
  node: HTMLElement;
};

export class ManusAdapter implements SourceAdapter {
  private diagnostics: string;

  constructor() {
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

  private normalizeText(text: string): string {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  private isUiNoiseLine(line: string): boolean {
    const compact = line.trim().toLowerCase();
    if (!compact) {
      return true;
    }

    const knownNoise = [
      'expand',
      'copy',
      'view',
      'publish',
      'upgrade',
      'task completed',
      'project initialized',
      'suggested follow-ups',
      'how was this result?',
      'deliver final results to user',
      'lite'
    ];

    if (knownNoise.includes(compact)) {
      return true;
    }

    return /^\d+\/\d+$/.test(compact);
  }

  private extractTextFromMarkdownNode(node: HTMLElement): string {
    const clone = node.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('button, svg, script, style, noscript, [aria-hidden="true"]')
      .forEach((el) => el.remove());

    const rawText = clone.innerText || clone.textContent || '';
    const cleanedLines = rawText
      .split(/\r?\n/)
      .filter((line) => !this.isUiNoiseLine(line));

    return this.normalizeText(cleanedLines.join('\n'));
  }

  private extractLikelyUserText(eventNode: HTMLElement): string {
    const textNodes = Array.from(
      eventNode.querySelectorAll('span.whitespace-pre-wrap, div.whitespace-pre-wrap, p.whitespace-pre-wrap, span, div, p')
    ) as HTMLElement[];

    const filteredNodes = textNodes.filter((node) => {

      if (node.closest('.manus-markdown')) {
        return false;
      }

      if (node.closest('button, [role="button"], a')) {
        return false;
      }

      const text = this.normalizeText(node.innerText || node.textContent || '');
      if (!text) {
        return false;
      }

      return !this.isUiNoiseLine(text);
    });

    if (filteredNodes.length === 0) {
      return '';
    }

    let best = '';
    filteredNodes.forEach((node) => {
      const text = this.normalizeText(node.innerText || node.textContent || '');
      if (text.length > best.length) {
        best = text;
      }
    });

    return best;
  }

  private isUserEvent(eventNode: HTMLElement): boolean {
    const cls = eventNode.className.toLowerCase();
    if (cls.includes('items-end')) {
      return true;
    }

    return Boolean(eventNode.querySelector('.items-end'));
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
      const label = this.normalizeText(anchor.textContent || '');
      const kind: AttachmentRef['kind'] = this.isLikelyFileLink(normalizedHref) ? 'file' : 'link';

      register({
        id: `m${messageIndex}-lnk-${index}`,
        kind,
        name: label || undefined,
        url: normalizedHref,
        sourceHint: 'anchor'
      });
    });

    return attachments;
  }

  private collectCandidates(): CandidateMessage[] {
    const candidates: CandidateMessage[] = [];

    // Strategy 1: strict events based on new Manus dom pattern
    const events = this.queryAllDeep('main [data-event-id]');
    if (events.length > 0) {
      const byId = new Map<string, HTMLElement>();
      events.forEach((eventNode) => {
        const eventId = eventNode.getAttribute('data-event-id') || '';
        if (eventId && !byId.has(eventId)) byId.set(eventId, eventNode);
      });

      const orderedEvents = Array.from(byId.values()).sort((a, b) => {
        if (a === b) return 0;
        const position = a.compareDocumentPosition(b);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      orderedEvents.forEach((eventNode) => {
        const markdownBlocks = Array.from(eventNode.querySelectorAll('div[dir="auto"].manus-markdown, .prose')) as HTMLElement[];
        if (markdownBlocks.length > 0) {
          const assistantText = this.normalizeText(
            markdownBlocks.map((block) => this.extractTextFromMarkdownNode(block)).filter(Boolean).join('\n\n')
          );
          if (assistantText) candidates.push({ role: 'assistant', text: assistantText, node: eventNode });
          return;
        }

        if (this.isUserEvent(eventNode)) {
          const userText = this.extractLikelyUserText(eventNode);
          if (userText) candidates.push({ role: 'user', text: userText, node: eventNode });
        }
      });
      
      if (candidates.length > 0) return candidates;
    }

    // Strategy 2: Fallback heuristic for Manus
    const messageNodes = this.queryAllDeep('.whitespace-pre-wrap, .manus-markdown, .prose');
    messageNodes.forEach((node) => {
      // Exclude nodes that are deeply nested in another message node to prevent duplicates
      if (node.parentElement && node.parentElement.closest('.manus-markdown')) return;

      const isAssistant = node.classList.contains('manus-markdown') || node.classList.contains('prose');
      const rawText = this.normalizeText(node.innerText || node.textContent || '');
      if (!rawText || this.isUiNoiseLine(rawText)) return;

      candidates.push({
        role: isAssistant ? 'assistant' : 'user',
        text: isAssistant ? this.extractTextFromMarkdownNode(node) : rawText,
        node
      });
    });

    return candidates;
  }

  public extractConversation(): CanonicalConversation {
    const now = new Date().toISOString();
    const candidates = this.collectCandidates();
    const messages: Message[] = [];
    let attachmentCount = 0;

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const previous = messages[messages.length - 1];

      if (previous && previous.role === candidate.role && previous.content[0]?.text === candidate.text) {
        continue;
      }

      const attachments = this.extractAttachments(candidate.node, i);
      attachmentCount += attachments.length;

      messages.push({
        id: `msg-${messages.length}`,
        role: candidate.role,
        timestamp: now,
        content: [{ type: 'text/markdown', text: candidate.text }],
        attachments
      });
    }

    if (messages.length === 0) {
      this.diagnostics = 'No Manus messages detected. Tried event-based parser on [data-event-id] and .manus-markdown.';
    } else {
      this.diagnostics = `Extracted ${messages.length} Manus messages and ${attachmentCount} attachment references.`;
    }

    return {
      version: '1.0',
      metadata: {
        source: 'Manus',
        title: document.title,
        createdAt: now,
        updatedAt: now,
        extensions: {
          diagnostics: this.diagnostics,
          attachmentCount: String(attachmentCount),
          parser: 'manus-event-parser-v1',
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
