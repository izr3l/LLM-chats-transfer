import { CanonicalConversation } from '../../schema/canonical';
import { TargetAdapter } from './index';
import { formatAttachmentReferences } from '../../shared/attachmentReferences';

export class ChatGPTAdapter implements TargetAdapter {
  private formatAttachments(msg: CanonicalConversation['messages'][number]): string {
    return formatAttachmentReferences(msg);
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
    if (conversation.messages.some((message) => message.attachments?.some((attachment) => attachment.kind !== 'link'))) {
      promptText += `Use source attachments only when their corresponding files are available in this chat. Ask the user for any missing files needed to answer.\n\n`;
    }
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
