import { CanonicalConversation } from '../../schema/canonical';

export interface SourceAdapter {
  extractConversation(): CanonicalConversation;
}
