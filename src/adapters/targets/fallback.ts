import { CanonicalConversation } from '../../schema/canonical';
import { TargetAdapter } from './index';

type GenericTargetAdapterOptions = {
  preferDirectSet?: boolean;
  useChunkedTextInsertion?: boolean;
  chunkSize?: number;
};

export class GenericTargetAdapter implements TargetAdapter {
  private targetName: string;
  private inputSelectors: string[];
  private options: GenericTargetAdapterOptions;

  constructor(targetName: string, inputSelectors: string[], options?: GenericTargetAdapterOptions) {
    this.targetName = targetName;
    this.inputSelectors = inputSelectors;
    this.options = options || {};
  }

  private formatAttachments(msg: CanonicalConversation['messages'][number]): string {
    if (!msg.attachments || msg.attachments.length === 0) {
      return '';
    }

    const lines = msg.attachments.map((attachment) => {
      const label = attachment.name ? ` ${attachment.name}` : '';
      const url = attachment.url ? ` (${attachment.url})` : '';
      return `- [${attachment.kind}]${label}${url}`;
    });

    return `Attachments:\n${lines.join('\n')}\n`;
  }

  public generateSingleShotPrompt(conversation: CanonicalConversation): string {
    let promptText = `You are resuming an existing conversation migrated from ${conversation.metadata.source}.\n\n`;
    promptText += `Rules:\n1. Preserve transcript as historical context.\n2. Do NOT rewrite or alter prior messages.\n3. Continue from the final user message only.\n\n`;
    promptText += `--- TRANSCRIPT START ---\n\n`;
    conversation.messages.forEach(msg => {
      const text = msg.content.map(c => c.text).join('\n');
      promptText += `Role: ${msg.role.toUpperCase()}\n${text}\n\n`;
      const attachmentSection = this.formatAttachments(msg);
      if (attachmentSection) {
        promptText += `${attachmentSection}\n`;
      }
    });
    promptText += `--- TRANSCRIPT END ---\n\n`;
    promptText += `If attachments are listed above, treat them as references from the original chat and mention when manual re-upload is needed for strict fidelity.\n\n`;
    promptText += `Now continue with the best possible answer to the last user message.`;
    return promptText;
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

  private findInputElement(): HTMLElement | HTMLTextAreaElement | null {
    for (const selector of this.inputSelectors) {
      const candidates = this.queryAllDeep(selector);
      for (const candidate of candidates) {
        const isVisible = candidate.getClientRects().length > 0;
        if (!isVisible) {
          continue;
        }

        if (candidate instanceof HTMLTextAreaElement || candidate.isContentEditable) {
          return candidate;
        }

        const role = candidate.getAttribute('role');
        if (role === 'textbox') {
          return candidate;
        }
      }
    }

    return null;
  }

  private insertChunkedIntoTextarea(input: HTMLTextAreaElement, text: string): void {
    const chunkSize = this.options.chunkSize || 600;
    input.value = '';
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      input.value += chunk;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: chunk, inputType: 'insertText' }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private insertChunkedIntoEditable(input: HTMLElement, text: string): void {
    const chunkSize = this.options.chunkSize || 600;
    input.textContent = '';
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      input.textContent = `${input.textContent || ''}${chunk}`;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: chunk, inputType: 'insertText' }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  public injectPrompt(promptHtml: string): boolean {
    const input = this.findInputElement();
    if (!input) {
      console.error(`${this.targetName}Adapter: Cannot find target composer with selectors ${this.inputSelectors.join(', ')}.`);
      return false;
    }

    input.focus();

    if (input instanceof HTMLTextAreaElement) {
      if (this.options.useChunkedTextInsertion) {
        this.insertChunkedIntoTextarea(input, promptHtml);
      } else {
        input.value = promptHtml;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }

    if (input.isContentEditable || input.getAttribute('role') === 'textbox') {
      if (this.options.useChunkedTextInsertion || this.options.preferDirectSet) {
        this.insertChunkedIntoEditable(input, promptHtml);
      } else {
        // Safe direct text assignment — avoids deprecated execCommand which could
        // be exploited in certain DOM contexts.
        input.textContent = promptHtml;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: promptHtml, inputType: 'insertText' }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }

    input.textContent = promptHtml;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
}
