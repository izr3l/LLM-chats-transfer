/**
 * ManusTargetAdapter
 *
 * Manus's chat input is limited to ~3 000 characters, making direct text
 * injection unreliable for long transcripts.
 *
 * Strategy:
 *   1. Build the full transcript as a UTF-8 .txt file (no size limit).
 *   2. Programmatically attach it via DataTransfer on the hidden file input,
 *      or via a synthetic drag-and-drop event on the composer drop-zone.
 *   3. Place a short context message in the text box so Manus knows what
 *      the attachment is and what to do with it.
 *   4. If all upload paths fail, fall back to truncated direct text injection.
 */

import { CanonicalConversation } from '../../schema/canonical';
import { TargetAdapter } from './index';

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
    text += `  3. If attachments are listed, they could NOT be auto-uploaded. Tell the user to manually upload those files here if needed.\n\n`;
    text += `--- TRANSCRIPT START ---\n\n`;

    conversation.messages.forEach((msg) => {
      const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
      const content = msg.content.map((c) => c.text).join('\n').trim();
      text += `[${role}]\n${content}\n`;

      if (msg.attachments && msg.attachments.length > 0) {
        text += `Attachments (not auto-uploaded — user must re-upload manually):\n`;
        msg.attachments.forEach((att) => {
          const name = att.name || 'unnamed file';
          text += `  - [${att.kind}] ${name}\n`;
        });
      }

      text += '\n';
    });

    text += `--- TRANSCRIPT END ---\n`;
    return text;
  }

  /** Short message placed in the Manus text box alongside the attachment. */
  private boxMessage(conversation: CanonicalConversation): string {
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

  // ── Upload strategies ──────────────────────────────────────────────────────

  /**
   * Strategy 1 — Inject via hidden <input type="file">.
   * Most React/Vue file upload components keep a hidden input somewhere in the DOM.
   */
  private tryFileInput(file: File): boolean {
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]')
    );
    for (const input of inputs) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        return true;
      } catch {
        // Try next input
      }
    }
    return false;
  }

  /**
   * Strategy 2 — Synthetic drag-and-drop onto the composer drop-zone.
   * Manus (and many other SPAs) accept file drops on the main composer area.
   */
  private tryDragDrop(file: File): boolean {
    const DROP_SELECTORS = [
      '.ProseMirror',
      '[data-lexical-editor]',
      '[role="textbox"]',
      'textarea',
      'div[contenteditable]',
      '[data-testid*="composer"]',
      '[data-testid*="input"]',
      'form',
      'main',
    ];

    for (const sel of DROP_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        el.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
        el.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
      } catch {
        // Try next selector
      }
    }
    return false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Primary injection method: attach transcript as .txt file + set box message.
   * Called by both target.ts (INJECT handler) and toolbar.ts (actionPaste).
   */
  public async injectViaFile(conversation: CanonicalConversation): Promise<boolean> {
    const fileContent = this.generateSingleShotPrompt(conversation);
    const filename    = this.buildFilename(conversation);
    const file        = new File([fileContent], filename, { type: 'text/plain' });

    // Try file-input upload first (most reliable when present)
    if (this.tryFileInput(file)) {
      // Give the UI a moment to process the file, then set the text box
      await new Promise<void>((r) => setTimeout(r, 400));
      this.setTextInBox(this.boxMessage(conversation));
      return true;
    }

    // Try drag-and-drop onto the composer
    if (this.tryDragDrop(file)) {
      await new Promise<void>((r) => setTimeout(r, 400));
      this.setTextInBox(this.boxMessage(conversation));
      return true;
    }

    // Fallback: truncated direct text injection
    const truncated = fileContent.slice(0, MANUS_CHAR_LIMIT) +
      (fileContent.length > MANUS_CHAR_LIMIT
        ? `\n\n[... transcript truncated to ${MANUS_CHAR_LIMIT} characters — please use the extension popup to export the full version as a downloadable .txt file ...]`
        : '');
    return this.setTextInBox(truncated);
  }

  /**
   * Sync fallback required by the TargetAdapter interface.
   * Truncates to the Manus character limit so the page doesn't silently drop content.
   */
  public injectPrompt(promptText: string): boolean {
    const truncated = promptText.slice(0, MANUS_CHAR_LIMIT) +
      (promptText.length > MANUS_CHAR_LIMIT
        ? '\n\n[... transcript truncated — use the extension to download the full version ...]'
        : '');
    return this.setTextInBox(truncated);
  }
}
