import { CanonicalConversation } from '../../schema/canonical';

export interface TargetAdapter {
  generateSingleShotPrompt(conversation: CanonicalConversation): string;
  injectPrompt(promptHtml: string): boolean;
  /** A transcript file for composers with a small text limit (e.g. Manus). */
  createTranscriptFile?(conversation: CanonicalConversation): File;
  /** Short composer text accompanying createTranscriptFile. */
  filePrompt?(conversation: CanonicalConversation): string;
}
