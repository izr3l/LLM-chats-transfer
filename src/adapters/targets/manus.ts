/**
 * ManusTargetAdapter
 *
 * Manus's chat input is limited to ~3 000 characters, making direct text
 * injection unreliable for long transcripts.
 *
 * Strategy:
 *   1. Build the full transcript as a UTF-8 .txt file (no size limit).
 *   2. Let the target orchestrator stage it with the original captured files.
 *   3. Place a short context message in the text box so Manus knows what
 *      the attachment is and what to do with it.
 *   4. Report unsupported uploads so the user can attach the full transcript manually.
 */

import { CanonicalConversation } from '../../schema/canonical';
import { TargetAdapter } from './index';
import { formatAttachmentReferences } from '../../shared/attachmentReferences';

const INPUT_SELECTORS = [
  'textarea',
  'div[contenteditable="true"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
  '.ProseMirror',
  '[data-testid*="composer"]',
  '[data-testid*="input"]',
];

const MANUS_CHAR_LIMIT = 2800; // Stay safely under the 3 000-char cap

export class ManusTargetAdapter implements TargetAdapter {

  // ── Prompt / text helpers ──────────────────────────────────────────────────

  /** Full transcript suitable for a .txt file attachment. */
  public generateSingleShotPrompt(conversation: CanonicalConversation): string {
    const { source, title, createdAt } = conversation.metadata;
    const count = conversation.integrity?.messageCount ?? conversation.messages.length;

    let text = `CHAT TRANSCRIPT\n`;
    text += `================\n`;
    text += `Source:    ${source}\n`;
    text += `Title:     ${title ?? 'Untitled'}\n`;
    text += `Messages:  ${count}\n`;
    text += `Captured:  ${new Date(createdAt).toLocaleString()}\n`;
    text += `================\n\n`;
    text += `INSTRUCTIONS\n`;
    text += `------------\n`;
    text += `You are resuming an existing conversation migrated from ${source}.\n`;
    text += `Rules:\n`;
    text += `  1. Treat everything below as historical context — do NOT alter or rewrite it.\n`;
    text += `  2. Continue naturally from the final user message.\n`;
    text += `  3. Use source attachments only when their corresponding files are available in this chat. Ask the user for any missing files needed to answer.\n\n`;
    text += `--- TRANSCRIPT START ---\n\n`;

    conversation.messages.forEach((msg) => {
      const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
      const content = msg.content.map((c) => c.text).join('\n').trim();
      text += `[${role}]\n${content}\n`;

      text += formatAttachmentReferences(msg);

      text += '\n';
    });

    text += `--- TRANSCRIPT END ---\n`;
    return text;
  }

  /** Short message placed in the Manus text box alongside the attachment. */
  public filePrompt(conversation: CanonicalConversation): string {
    const source = conversation.metadata.source;
    const count  = conversation.integrity?.messageCount ?? conversation.messages.length;
    const title  = conversation.metadata.title ?? 'Untitled';
    return (
      `I'm continuing a conversation from ${source} ` +
      `(titled "${title}", ${count} message${count !== 1 ? 's' : ''}). ` +
      `The full transcript is attached as a text file. ` +
      `Please read it and continue naturally from the last message.`
    );
  }

  /** Safe filename from source + title. */
  private buildFilename(conversation: CanonicalConversation): string {
    const src   = (conversation.metadata.source ?? 'chat').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const title = (conversation.metadata.title  ?? '').slice(0, 40).replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const ts    = Date.now();
    return title ? `${src}_${title}_${ts}.txt` : `${src}_transcript_${ts}.txt`;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

  private findInputElement(): HTMLElement | HTMLTextAreaElement | null {
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.getClientRects().length > 0) return el;
    }
    return null;
  }

  private setTextInBox(text: string): boolean {
    const input = this.findInputElement();
    if (!input) return false;

    input.focus();

    if (input instanceof HTMLTextAreaElement) {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (input.isContentEditable || input.getAttribute('role') === 'textbox') {
      // Clear and re-set via execCommand-free approach
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    return false;
  }

  /** Included in the same batch as source attachments by the target orchestrator. */
  public createTranscriptFile(conversation: CanonicalConversation): File {
    const content = this.generateSingleShotPrompt(conversation)
      .replace(/\n*\[attachment:\d+\s+"[^"]*"\]/g, '');
    return new File([content], this.buildFilename(conversation), { type: 'text/plain' });
  }

  /** Short companion text; long transcripts are delivered as a file. */
  public injectPrompt(promptText: string): boolean {
    const truncated = promptText.slice(0, MANUS_CHAR_LIMIT) +
      (promptText.length > MANUS_CHAR_LIMIT
        ? '\n\n[... transcript truncated — use the extension to attach the full version as a file ...]'
        : '');
    return this.setTextInBox(truncated);
  }
}
