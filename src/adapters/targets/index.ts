import { CanonicalConversation } from '../../schema/canonical';

export interface TargetAdapter {
  generateSingleShotPrompt(conversation: CanonicalConversation): string;
  injectPrompt(promptHtml: string): boolean;
}