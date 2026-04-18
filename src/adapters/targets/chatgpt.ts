import { CanonicalConversation } from '../../schema/canonical';
import { TargetAdapter } from './index';

export class ChatGPTAdapter implements TargetAdapter {
  private formatAttachments(msg: CanonicalConversation['messages'][number]): string {
    if (!msg.attachments || msg.attachments.length === 0) {
      return '';
    }

    const lines = msg.attachments.map((attachment) => {
      const label = attachment.name || 'unnamed file';
      return `- [${attachment.kind}] ${label}`;
    });

    return `Attachments (not auto-uploaded — user must re-upload manually):\n${lines.join('\n')}\n`;
  }

  /**
   * Generates a context-preserving prompt for single-shot continuation
   * given a canonical conversation transcript.
   */
  public generateSingleShotPrompt(conversation: CanonicalConversation): string {
    let promptText = `You are resuming an existing conversation migrated from ${conversation.metadata.source}.\n\n`;
    promptText += `Rules:\n`;
    promptText += `1. Preserve the transcript as historical context.\n`;
    promptText += `2. Do not rewrite, summarize, or alter prior messages.\n`;
    promptText += `3. Continue from the final user message only.\n\n`;
    promptText += `--- TRANSCRIPT START ---\n\n`;

    conversation.messages.forEach(msg => {
      const text = msg.content.map(c => c.text).join('\n');
      promptText += `Role: ${msg.role.toUpperCase()}\n`;
      promptText += `${text}\n\n`;
      const attachmentSection = this.formatAttachments(msg);
      if (attachmentSection) {
        promptText += `${attachmentSection}\n`;
      }
    });

    promptText += `--- TRANSCRIPT END ---\n\n`;
    promptText += `IMPORTANT: Some messages in this transcript had file attachments. These files could NOT be automatically uploaded to this chat. The attachment names are listed under each message. If the user needs the LLM to reference those files, they must manually upload them here.\n\n`;
    promptText += `Now continue with the best possible answer specifically addressing the last user message.`;

    return promptText;
  }

  /**
   * Injects the single-shot prompt into the ChatGPT composer textarea 
   * and optionally simulates a click to send or focuses it so the user can send.
   */
  public injectPrompt(promptHtml: string) {
    // Current ChatGPT uses a prosemirror editor or standard textarea typically with id #prompt-textarea
    const textarea = document.querySelector('#prompt-textarea');
    if (!textarea) {
      console.error('ChatGPTAdapter: Cannot find target composer.');
      return false;
    }
    
    // Inject the text
    // Depending on the exact element (textarea or div contenteditable), this varies
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.value = promptHtml;
      // Dispatch an input event so React state updates
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      (textarea as HTMLElement).innerText = promptHtml;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Usually better to let the user hit Enter, ensuring human consent and avoiding UI breakage on auto-submit
    (textarea as HTMLElement).focus();
    return true;
  }
}