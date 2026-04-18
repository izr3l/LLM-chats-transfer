import { CanonicalConversation } from '../../schema/canonical';

export interface TargetAdapter {
  generateSingleShotPrompt(conversation: CanonicalConversation): string;
  injectPrompt(promptHtml: string): boolean;
  /**
   * Optional async file-upload injection.
   * Adapters that support this (e.g. ManusTargetAdapter) implement it when
   * direct text injection is impractical (e.g. character-limit constraints).
   * Callers should prefer this over injectPrompt when present.
   */
  injectViaFile?(conversation: CanonicalConversation): Promise<boolean>;
}